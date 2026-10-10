/** EF1 lifecycle. The control and AI accounts share signals, sizing and hard exits. */
import { rawDb } from '../db/client.js'
import { resolveApiKey, type ArenaConfig, type ArenaModelConfig } from './config.js'
import { accountEquity, closePosition, openPosition, toView } from './ledger.js'
import { getAccountState, insertDecision, listPositionMeta, type DecisionRecord } from './store.js'
import { evaluateActions } from './risk.js'
import { chat } from './llm.js'
import { fetchPrices } from './market.js'
import { roundTripCostPct } from './prompt.js'
import { emaSignalFresh, emaEntryAction, emaFilterUser, parseEmaVerdict,
  EMA_FILTER_SYSTEM, EMA_FILTER_VERSION, EMA_RULES_VERSION, type EmaSignal } from './ema-filter.js'

export interface EmaRunOptions {
  id: number
  cfg: ArenaConfig
  model?: ArenaModelConfig
  signal: EmaSignal
  fundingRate: number | null
  isEnabled: () => boolean
}
export interface EmaDependencies {
  chat: typeof chat
  prices: typeof fetchPrices
  now: () => number
}
const defaultDeps: EmaDependencies = { chat, prices: fetchPrices, now: Date.now }

export async function runEmaAccount(o: EmaRunOptions, deps: EmaDependencies = defaultDeps): Promise<void> {
  const { id, cfg, model, signal } = o
  if (!o.isEnabled() || !emaSignalFresh(signal, deps.now())) return
  const previous = () => rawDb.prepare('SELECT bar, side FROM arena_ema_state WHERE account_id=?').get(id) as { bar: number; side: string } | undefined
  const old = previous()
  // On a failed exit, retry the rule exit even if the candidate was already consumed.
  const reverse = listPositionMeta(id).some(p => p.symbol === 'BTC' && p.side !== signal.side)
  if (old && old.bar >= signal.closedAt && !reverse) return
  const prices = await deps.prices(['BTC'])
  const price = prices.BTC
  if (!price || price <= 0 || !Number.isFinite(price) || !o.isEnabled() || !emaSignalFresh(signal, deps.now())) return
  const costs = { feeRate: cfg.takerFeeRate, slippageBps: cfg.risk.slippageBps }
  // No await between the rule exit and the durable claim. Restart never repeats an AI request.
  for (const p of listPositionMeta(id)) {
    if (p.symbol === 'BTC' && p.side !== signal.side) closePosition(id, 'BTC', price, 'ema_cross', costs, deps.now())
  }
  const prior = previous()
  if (prior && prior.bar >= signal.closedAt) return
  rawDb.prepare(`INSERT INTO arena_ema_state(account_id,bar,side) VALUES(?,?,?)
    ON CONFLICT(account_id) DO UPDATE SET bar=excluded.bar,side=excluded.side`).run(id, signal.closedAt, signal.side)
  if (prior?.side === signal.side) return
  const version = model ? EMA_FILTER_VERSION : EMA_RULES_VERSION
  const ts = deps.now()
  rawDb.prepare(`INSERT INTO arena_ema_events(account_id,bar,side,signal_json,status,ts) VALUES(?,?,?,?,?,?)`)
    .run(id, signal.closedAt, signal.side, emaFilterUser(signal, o.fundingRate, roundTripCostPct(costs.feeRate, costs.slippageBps) * 100), 'pending', ts)
  const record: DecisionRecord = { account_id: id, ts, model: model?.model ?? EMA_RULES_VERSION,
    latency_ms: null, prompt_tokens: null, completion_tokens: null, analysis: null, raw_response: null,
    actions_json: null, results_json: null, error: null, strategy_version: version,
    snapshot_ts: signal.asOf, confirmation_json: JSON.stringify(signal) }
  let status = 'skipped'
  const notes: string[] = []
  const context = (px: Record<string, number>) => {
    const { equity, cash } = accountEquity(id, px)
    const state = getAccountState(id)
    return { equity, cash, peakEquity: Math.max(equity, state?.peak_equity ?? equity), halted: !!state?.halted,
      symbols: cfg.symbols.includes('BTC') ? ['BTC'] : [], prices: px, positions: listPositionMeta(id).map(toView),
      feeRate: costs.feeRate, config: { ...cfg.risk, maxLeverage: 1 } }
  }
  try {
    const action = emaEntryAction(signal, price)
    if (!action) { notes.push('均线相等，仅退出，不开仓'); return }
    const pre = evaluateActions([action], context(prices))
    if (!pre.orders.some(x => x.kind === 'open')) { notes.push(...pre.results.flatMap(x => x.notes)); return }
    let allow = true
    if (model) {
      const response = await deps.chat({ baseUrl: model.baseUrl, apiKey: resolveApiKey(`env:${model.apiKeyEnv}`),
        model: model.model, system: EMA_FILTER_SYSTEM,
        user: emaFilterUser(signal, o.fundingRate, roundTripCostPct(costs.feeRate, costs.slippageBps) * 100),
        temperature: model.temperature, maxTokens: model.maxTokens,
        timeoutMs: model.timeoutSeconds * 1000, extraBody: model.extraBody })
      record.latency_ms = response.latencyMs; record.prompt_tokens = response.promptTokens
      record.completion_tokens = response.completionTokens; record.raw_response = response.text.slice(0, 20_000)
      const verdict = parseEmaVerdict(response.text)
      record.analysis = verdict.reason
      allow = verdict.allow
    } else record.analysis = 'EF1 纯规则对照：接受均线信号'
    if (!allow) { status = 'rejected'; notes.push('AI 拒绝入场；等待下一次均线方向变化'); return }
    if (!o.isEnabled() || !emaSignalFresh(signal, deps.now())) { notes.push('账户已停用或信号过期，本次不执行'); return }
    const latest = model ? await deps.prices(['BTC']) : prices
    if (!o.isEnabled() || !emaSignalFresh(signal, deps.now())) { notes.push('获取价格后已停用或信号过期'); return }
    const next = emaEntryAction(signal, latest.BTC ?? NaN)
    if (!next) throw new Error('没有新鲜的 BTC 执行价格')
    record.actions_json = JSON.stringify([next])
    const outcome = evaluateActions([next], context(latest))
    for (const order of outcome.orders) {
      if (order.kind !== 'open') continue
      openPosition(id, order, latest.BTC!, costs, deps.now())
      status = 'opened'
      notes.push(`开${order.side === 'LONG' ? '多' : '空'} BTC ${order.leverage}x，保证金 ${order.margin.toFixed(2)}，止损 ${order.stopLoss}`)
    }
    record.results_json = JSON.stringify({ checks: outcome.results, executed: notes })
  } catch (e) {
    status = 'error'
    record.error = (e instanceof Error ? e.message : String(e)).slice(0, 2000)
    notes.push('本次不重试入场，等待下一次均线方向变化')
  } finally {
    record.results_json ??= JSON.stringify({ checks: [], executed: notes })
    rawDb.transaction(() => {
      insertDecision(record)
      rawDb.prepare('UPDATE arena_ema_events SET status=?, reason=? WHERE account_id=? AND bar=?')
        .run(status, record.error ?? record.analysis ?? notes.join('；'), id, signal.closedAt)
    })()
  }
}
