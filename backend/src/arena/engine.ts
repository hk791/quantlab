/**
 * Arena engine: keeps arena accounts in sync with the config, runs the
 * decision cycle (all models in parallel on the same snapshot), the risk
 * monitor (stops / TP / liquidation / timeout / drawdown halt), funding
 * accrual, baselines and equity snapshots.
 */
import { fetchEmaSignal } from './ema-market.js'
import { runEmaAccount } from './ema-runner.js'
import { EMA_FILTER_VERSION, EMA_RULES_VERSION } from './ema-filter.js'
import { readExitRule } from './confirmation.js'
import { and, eq } from 'drizzle-orm'
import { db, rawDb } from '../db/client.js'
import { accounts, users, type Account } from '../db/schema.js'
import { getLogger } from '../utils/logger.js'
import { dbDateMs } from '../utils/datetime.js'
import { BASELINE_NAMES, resolveApiKey, type ArenaConfig, type ArenaModelConfig } from './config.js'
import {
  getAccountState,
  haltAccount,
  insertDecision,
  insertEquitySnapshot,
  lastNotes,
  listAllPositionMeta,
  listArenaStates,
  listClosedTrades,
  listClosedTradesSince,
  listPositionMeta,
  tradesPendingOutcome,
  updatePeakEquity,
  upsertAccountState,
  upsertOutcome,
} from './store.js'
import {
  accountEquity,
  accrueFunding,
  adjustStops,
  closePosition,
  getCash,
  openPosition,
  resetAccount,
  toView,
  type LedgerCosts,
} from './ledger.js'
import {
  checkTrigger,
  cooldownUntil,
  drawdown,
  evaluateActions,
  stopGuardLocks,
  unrealizedPnl,
  type ApprovedOrder,
  type V2RiskRules,
  type V3RiskRules,
} from './risk.js'
import {
  fetchCandlesSince,
  fetchCloses,
  fetchFunding,
  fetchMarketSnapshot,
  fetchPrices,
  type MarketSnapshot,
} from './market.js'
import {
  buildSystemPrompt,
  buildUserPrompt,
  parseDecision,
  roundTripCostPct,
  type AccountView,
  type V2Memory,
  type V2PromptInfo,
} from './prompt.js'
import { computeOutcome, OUTCOME_BAR_MS, POST_EXIT_MS } from './outcomes.js'
import { chat } from './llm.js'
import { emaCrossSignal } from './baselines.js'

const logger = getLogger('arena.engine')

/** v2 and v3 both carry memory (notes, entry thesis, 24h stats). */
const hasMemory = (strategy: string | undefined) => strategy === 'v2' || strategy === 'v3' || strategy === 'v3.1'

/**
 * v3 accounts decide once per clock-aligned slot (e.g. each UTC hour). All v3
 * accounts become due in the same 15-minute cycle, so they still share one snapshot.
 */
export function v3Due(lastDecisionTs: number | null, now: number, intervalMinutes: number): boolean {
  if (lastDecisionTs == null) return true
  const slot = intervalMinutes * 60_000
  return Math.floor(now / slot) > Math.floor(lastDecisionTs / slot)
}

export function confirmationBars(snapshot: MarketSnapshot) {
  return Object.fromEntries(Object.entries(snapshot.symbols).map(([symbol, v]) => {
    const c = v.confirmedHigher
    return [symbol, c ? { closedAt: c.closedAt, close: c.stats.closes[c.stats.closes.length - 1]! } : null]
  }))
}

export interface ArenaAccount {
  account: Account
  kind: 'llm' | 'baseline'
  strategy: string
  modelCfg?: ArenaModelConfig
  strategyVersion?: string | null
}

export class ArenaEngine {
  private timers: NodeJS.Timeout[] = []
  private busy = new Set<string>()
  private fundingCache: { ts: number; rates: Record<string, number> } = { ts: 0, rates: {} }
  private lastFundingAccrual = Date.now()
  readonly costs: LedgerCosts

  constructor(public cfg: ArenaConfig) {
    this.costs = { feeRate: cfg.takerFeeRate, slippageBps: cfg.risk.slippageBps }
  }

  // ------------------------------------------------------------ accounts

  private defaultUserId(): number {
    const u = db.select().from(users).where(eq(users.username, 'default')).get()
    if (!u) throw new Error('default user missing — run seedDatabase first')
    return u.id
  }

  private findOrCreate(name: string, model: string | null, baseUrl: string | null, apiKey: string | null): Account {
    const userId = this.defaultUserId()
    let acc = db.select().from(accounts).where(and(eq(accounts.userId, userId), eq(accounts.name, name))).get()
    if (!acc) {
      acc = db
        .insert(accounts)
        .values({
          userId,
          version: 'v1',
          name,
          accountType: 'AI',
          model,
          baseUrl,
          apiKey,
          initialCapital: this.cfg.initialCapital,
          currentCash: this.cfg.initialCapital,
          frozenCash: 0,
          marginUsed: 0,
          isActive: 'true',
        })
        .returning()
        .get()
      resetAccount(acc.id, this.cfg.initialCapital)
      logger.info(`Created arena account "${name}" (id=${acc.id})`)
    } else {
      db.update(accounts).set({ model, baseUrl, apiKey, isActive: 'true' }).where(eq(accounts.id, acc.id)).run()
    }
    return db.select().from(accounts).where(eq(accounts.id, acc.id)).get()!
  }

  /** Make DB accounts match the config. Accounts no longer configured are deactivated, not deleted. */
  syncAccounts(): ArenaAccount[] {
    const result: ArenaAccount[] = []
    const keep = new Set<number>()
    for (const m of this.cfg.models.filter((m) => m.enabled)) {
      const acc = this.findOrCreate(m.name, m.model, m.baseUrl, `env:${m.apiKeyEnv}`)
      upsertAccountState(acc.id, 'llm', m.model, this.cfg.initialCapital)
      keep.add(acc.id)
      result.push({ account: acc, kind: 'llm', strategy: m.model, modelCfg: m })
    }
    for (const b of this.cfg.baselines) {
      const acc = this.findOrCreate(BASELINE_NAMES[b] ?? b, null, null, null)
      upsertAccountState(acc.id, 'baseline', b, this.cfg.initialCapital)
      keep.add(acc.id)
      result.push({ account: acc, kind: 'baseline', strategy: b })
    }
    for (const s of listArenaStates()) {
      if (!keep.has(s.account_id)) {
        db.update(accounts).set({ isActive: 'false' }).where(eq(accounts.id, s.account_id)).run()
      }
    }
    // The upstream seed creates a placeholder "GPT" account; hide it in arena mode.
    db.update(accounts)
      .set({ isActive: 'false' })
      .where(and(eq(accounts.name, 'GPT'), eq(accounts.apiKey, 'default-key-please-update-in-settings')))
      .run()
    return result
  }

  /**
   * Hot-apply a new model list (from the dashboard). Newly enabled models get
   * an account (fresh $initialCapital if new); disabled ones have their open
   * positions closed at market first, so nothing is left unmonitored.
   */
  async applyModels(models: ArenaModelConfig[]): Promise<string[]> {
    const notes: string[] = []
    const nowEnabled = new Set(models.filter((m) => m.enabled).map((m) => m.name))
    const toClose = this.activeAccounts().filter((a) => a.kind === 'llm' && !nowEnabled.has(a.account.name))
    if (toClose.some((a) => listPositionMeta(a.account.id).length)) {
      const syms = [...new Set(toClose.flatMap((a) => listPositionMeta(a.account.id).map((m) => m.symbol)))]
      const prices = await fetchPrices(syms)
      for (const a of toClose) {
        for (const m of listPositionMeta(a.account.id)) {
          const px = prices[m.symbol]
          if (!px) throw new Error(`拿不到 ${m.symbol} 价格，暂时无法停用「${a.account.name}」，请稍后重试`)
          const r = closePosition(a.account.id, m.symbol, px, 'disabled', this.costs)
          if (r) notes.push(`「${a.account.name}」停用，平仓 ${m.symbol} 净盈亏 ${r.pnl.toFixed(2)}`)
        }
      }
    }
    this.cfg = { ...this.cfg, models }
    const accs = this.syncAccounts()
    for (const a of accs) {
      if (a.kind === 'llm' && a.modelCfg && a.modelCfg.model !== 'mock' && !resolveApiKey(`env:${a.modelCfg.apiKeyEnv}`)) {
        notes.push(`「${a.account.name}」的环境变量 ${a.modelCfg.apiKeyEnv} 没有设置，调用会失败`)
      }
    }
    logger.info(`Models updated: ${accs.filter((a) => a.kind === 'llm').map((a) => a.account.name).join(', ')}`)
    return notes
  }

  activeAccounts(): ArenaAccount[] {
    const states = new Map(listArenaStates().map((s) => [s.account_id, s]))
    const modelsByName = new Map(this.cfg.models.map((m) => [m.name, m]))
    const out: ArenaAccount[] = []
    for (const acc of db.select().from(accounts).where(eq(accounts.isActive, 'true')).all()) {
      const s = states.get(acc.id)
      if (!s) continue
      out.push({
        account: acc,
        kind: s.kind,
        strategy: s.strategy ?? '',
        modelCfg: s.kind === 'llm' ? modelsByName.get(acc.name) : undefined,
      })
    }
    return out
  }

  /** Read-only history inventory; never used by trading or monitoring. */
  reportingAccounts(): ArenaAccount[] {
    const active = this.activeAccounts()
    const ids = new Set(active.map(a => a.account.id))
    const models = new Map(this.cfg.models.map(m => [m.name, m]))
    const dataIds = new Set((rawDb.prepare(`
      SELECT account_id FROM arena_equity_snapshots
      UNION SELECT account_id FROM arena_decisions
      UNION SELECT account_id FROM arena_closed_trades
      UNION SELECT account_id FROM arena_position_meta
    `).all() as { account_id: number }[]).map(r => r.account_id))
    for (const state of listArenaStates()) {
      if (ids.has(state.account_id) || !dataIds.has(state.account_id)) continue
      const account = db.select().from(accounts).where(eq(accounts.id, state.account_id)).get()
      if (!account) continue
      const version = rawDb.prepare('SELECT strategy_version FROM arena_decisions WHERE account_id = ? AND strategy_version IS NOT NULL ORDER BY id DESC LIMIT 1').get(account.id) as { strategy_version: string } | undefined
      active.push({ account, kind: state.kind, strategy: state.strategy ?? '', strategyVersion: version?.strategy_version,
        modelCfg: state.kind === 'llm' ? models.get(account.name) : undefined })
    }
    return active
  }

  // ------------------------------------------------------------ lifecycle

  start(): void {
    const accs = this.syncAccounts()
    logger.info(
      `Arena started with ${accs.length} accounts: ${accs.map((a) => a.account.name).join(', ')} | ` +
        `decision every ${this.cfg.decisionIntervalMinutes}m, monitor every ${this.cfg.monitorIntervalSeconds}s`,
    )
    for (const a of accs) {
      if (a.kind === 'llm' && a.modelCfg && a.modelCfg.model !== 'mock' && !resolveApiKey(`env:${a.modelCfg.apiKeyEnv}`)) {
        logger.warning(`Account "${a.account.name}": env var ${a.modelCfg.apiKeyEnv} is not set — its calls will fail`)
      }
    }
    const every = (ms: number, id: string, fn: () => Promise<void>) => {
      const t = setInterval(() => void this.guard(id, fn), ms)
      this.timers.push(t)
    }
    every(this.cfg.decisionIntervalMinutes * 60_000, 'cycle', () => this.runCycle())
    every(this.cfg.monitorIntervalSeconds * 1000, 'monitor', () => this.runMonitor())
    every(this.cfg.snapshotIntervalMinutes * 60_000, 'snapshot', () => this.snapshotEquity())
    every(10 * 60_000, 'outcomes', () => this.evaluateOutcomes().then(() => undefined))
    // First run right away (monitor first so stale stops are handled).
    void this.guard('monitor', () => this.runMonitor())
      .then(() => this.guard('snapshot', () => this.snapshotEquity()))
      .then(() => this.guard('cycle', () => this.runCycle()))
      .then(() => this.guard('outcomes', () => this.evaluateOutcomes().then(() => undefined)))
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
  }

  /** Skip a job if its previous run is still in flight. */
  private async guard(id: string, fn: () => Promise<void>): Promise<void> {
    if (this.busy.has(id)) {
      logger.debug(`${id} still running, skipping tick`)
      return
    }
    this.busy.add(id)
    try {
      await fn()
    } catch (e) {
      logger.error(`Arena job ${id} failed: ${e instanceof Error ? e.stack : e}`)
    } finally {
      this.busy.delete(id)
    }
  }

  // ------------------------------------------------------------ decision cycle

  async runCycle(): Promise<void> {
    const accs = this.activeAccounts()
    if (!accs.length) return
    const isEma = (a: ArenaAccount) => a.modelCfg?.strategy === EMA_FILTER_VERSION || a.strategy === EMA_RULES_VERSION
    const [snapshot, emaSignal] = await Promise.all([
      fetchMarketSnapshot(this.cfg.symbols),
      accs.some(isEma) ? fetchEmaSignal().catch(e => { logger.warning(`EF1 行情不可用: ${e}`); return null }) : Promise.resolve(null),
    ])
    if (!Object.keys(snapshot.symbols).length) {
      logger.warning('Empty market snapshot, skipping cycle')
      return
    }
    logger.info(`Decision cycle: ${accs.length} accounts, symbols ${Object.keys(snapshot.symbols).join(',')}`)
    await Promise.allSettled(
      accs.map((a) => isEma(a)
        ? emaSignal ? runEmaAccount({ id: a.account.id, cfg: this.cfg, model: a.modelCfg, signal: emaSignal,
            fundingRate: snapshot.symbols.BTC?.fundingRate ?? null,
            isEnabled: () => this.activeAccounts().some(x => x.account.id === a.account.id),
          }).catch(e => logger.error(`EF1 执行失败: ${e}`)) : Promise.resolve()
        : a.kind === 'llm' ? this.runLlmAccount(a, snapshot) : this.runBaseline(a, snapshot)),
    )
  }

  buildAccountView(a: ArenaAccount, prices: Record<string, number>, snapshot?: MarketSnapshot): AccountView {
    const now = Date.now()
    const isV2 = hasMemory(a.modelCfg?.strategy)
    const { equity, cash } = accountEquity(a.account.id, prices)
    const state = getAccountState(a.account.id)
    const invocations = (
      rawDb.prepare('SELECT COUNT(*) AS n FROM arena_decisions WHERE account_id = ?').get(a.account.id) as { n: number }
    ).n
    return {
      equity,
      cash,
      initialCapital: a.account.initialCapital,
      peakEquity: Math.max(state?.peak_equity ?? equity, equity),
      minutesSinceStart: (now - dbDateMs(a.account.createdAt)) / 60_000,
      invocationCount: invocations + 1,
      positions: listPositionMeta(a.account.id).map((m) => {
        const px = prices[m.symbol] ?? m.entry_price
        return {
          symbol: m.symbol,
          side: m.side,
          quantity: m.quantity,
          entryPrice: m.entry_price,
          currentPrice: px,
          leverage: m.leverage,
          margin: m.margin,
          unrealizedPnl: unrealizedPnl(m.side, m.quantity, m.entry_price, px) - m.funding_paid,
          stopLoss: m.stop_loss,
          takeProfit: m.take_profit,
          heldMinutes: (now - m.opened_at) / 60_000,
          ...(a.modelCfg?.strategy === 'v3.1' ? { exitRule: readExitRule(m.exit_rule_json) } : {}),
          ...(isV2 ? { entryReason: m.entry_reason, invalidation: m.invalidation ?? null } : {}),
        }
      }),
      recentTrades: listClosedTrades(a.account.id, 5).map((t) => ({
        symbol: t.symbol,
        side: t.side,
        pnl: t.pnl,
        reason: t.close_reason,
        ...(isV2 ? { heldMinutes: Math.round((t.closed_at - t.opened_at) / 60_000) } : {}),
      })),
      ...(isV2 ? { memory: this.buildMemory(a, now, snapshot) } : {}),
      ...(a.modelCfg?.strategy === 'v3.1' ? { confirmedSignals: true } : {}),
    }
  }

  /** v2 risk rules for an account, derived from its recent closes and the current ATR. */
  v2Rules(accountId: number, now: number, snapshot?: MarketSnapshot): V2RiskRules {
    const s = this.cfg.strategyV2
    const recent = s.cooldownMinutes > 0 ? listClosedTradesSince(accountId, now - s.cooldownMinutes * 60_000) : []
    const minStopPct: Record<string, number> = {}
    if (snapshot && s.minStopAtrMult > 0) {
      for (const [sym, v] of Object.entries(snapshot.symbols)) {
        if (v.price > 0 && Number.isFinite(v.higher.atr14)) minStopPct[sym] = (v.higher.atr14 * s.minStopAtrMult) / v.price
      }
    }
    return { now, cooldownUntil: cooldownUntil(recent, s.cooldownMinutes), minStopPct }
  }

  /** v3 risk rules: ATR stop floor, stop-guard locks, risk-based sizing inputs. */
  v3Rules(accountId: number, now: number, snapshot?: MarketSnapshot): V3RiskRules {
    const s = this.cfg.strategyV3
    const minStopPct: Record<string, number> = {}
    if (snapshot && s.stopAtrMult > 0) {
      for (const [sym, v] of Object.entries(snapshot.symbols)) {
        if (v.price > 0 && Number.isFinite(v.higher.atr14)) minStopPct[sym] = (v.higher.atr14 * s.stopAtrMult) / v.price
      }
    }
    const recent = listClosedTradesSince(accountId, now - s.stopGuard.lookbackHours * 3_600_000)
    return {
      now,
      minStopPct,
      locks: stopGuardLocks(recent, s.stopGuard, now),
      riskPerTradePct: s.riskPerTradePct,
      roundTripPct: roundTripCostPct(this.costs.feeRate, this.costs.slippageBps),
    }
  }

  /** Prompt info for memory strategies (undefined for v1, whose prompt is unchanged). */
  promptInfo(strategy: string | undefined): V2PromptInfo | undefined {
    if (!hasMemory(strategy)) return undefined
    const base = { ...this.cfg.strategyV2, feeRate: this.costs.feeRate, slippageBps: this.costs.slippageBps }
    return strategy === 'v3' || strategy === 'v3.1' ? { ...base, notesMaxChars: this.cfg.strategyV3.notesMaxChars, v3: this.cfg.strategyV3, ...(strategy === 'v3.1' ? { confirmedSignals: true } : {}) } : base
  }

  private buildMemory(a: ArenaAccount, now: number, snapshot?: MarketSnapshot): V2Memory {
    const id = a.account.id
    const day = listClosedTradesSince(id, now - 86_400_000)
    const isV3 = a.modelCfg?.strategy === 'v3' || a.modelCfg?.strategy === 'v3.1'
    const notes = lastNotes(id)
    if (isV3) {
      const r = this.v3Rules(id, now, snapshot)
      return {
        lastNotes: notes ? { minutesAgo: (now - notes.ts) / 60_000, text: notes.notes } : null,
        last24h: {
          closedTrades: day.length,
          feesAndFunding: day.reduce((x, t) => x + t.fees + t.funding, 0),
          netPnl: day.reduce((x, t) => x + t.pnl, 0),
          stopLossCount: day.filter((t) => t.close_reason === 'stop_loss').length,
        },
        cooldowns: {},
        locks: Object.fromEntries(Object.entries(r.locks).map(([k, until]) => [k, Math.ceil((until - now) / 60_000)])),
        minStopPct: r.minStopPct,
      }
    }
    const rules = this.v2Rules(id, now, snapshot)
    return {
      lastNotes: notes ? { minutesAgo: (now - notes.ts) / 60_000, text: notes.notes } : null,
      last24h: {
        closedTrades: day.length,
        feesAndFunding: day.reduce((x, t) => x + t.fees + t.funding, 0),
        netPnl: day.reduce((x, t) => x + t.pnl, 0),
        stopLossCount: day.filter((t) => t.close_reason === 'stop_loss').length,
      },
      cooldowns: Object.fromEntries(
        Object.entries(rules.cooldownUntil)
          .filter(([, until]) => until > now)
          .map(([sym, until]) => [sym, Math.ceil((until - now) / 60_000)]),
      ),
      minStopPct: rules.minStopPct,
    }
  }

  private async runLlmAccount(a: ArenaAccount, snapshot: MarketSnapshot): Promise<void> {
    const id = a.account.id
    const state = getAccountState(id)
    if (state?.halted) return
    const m = a.modelCfg
    if (!m) return

    const isV2 = hasMemory(m.strategy)
    const isV3 = m.strategy === 'v3' || m.strategy === 'v3.1'
    if (isV3) {
      const last = rawDb
        .prepare('SELECT MAX(ts) AS ts FROM arena_decisions WHERE account_id = ? AND error IS NULL')
        .get(id) as { ts: number | null }
      if (!v3Due(last.ts, snapshot.ts, this.cfg.strategyV3.decisionIntervalMinutes)) return
    }
    const snapPrices = Object.fromEntries(Object.entries(snapshot.symbols).map(([k, v]) => [k, v.price]))
    const system = buildSystemPrompt(
      this.cfg.symbols,
      this.cfg.risk,
      this.cfg.reasonLanguage,
      this.promptInfo(m.strategy),
    )
    const user = buildUserPrompt(snapshot, this.buildAccountView(a, snapPrices, isV2 ? snapshot : undefined))
    const ts = Date.now()
    const record = {
      strategy_version: m.strategy,
      snapshot_ts: snapshot.ts,
      confirmation_json: m.strategy === 'v3.1' ? JSON.stringify(confirmationBars(snapshot)) : null,
      notes: null as string | null,
      account_id: id,
      ts,
      model: m.model,
      latency_ms: null as number | null,
      prompt_tokens: null as number | null,
      completion_tokens: null as number | null,
      analysis: null as string | null,
      raw_response: null as string | null,
      actions_json: null as string | null,
      results_json: null as string | null,
      error: null as string | null,
    }

    try {
      const res = await chat({
        baseUrl: m.baseUrl,
        apiKey: resolveApiKey(`env:${m.apiKeyEnv}`),
        model: m.model,
        system,
        user,
        temperature: m.temperature,
        maxTokens: m.maxTokens,
        timeoutMs: m.timeoutSeconds * 1000,
        extraBody: m.extraBody,
      })
      record.latency_ms = res.latencyMs
      record.prompt_tokens = res.promptTokens
      record.completion_tokens = res.completionTokens
      record.raw_response = res.text.slice(0, 20_000)

      const decision = parseDecision(res.text)
      record.analysis = decision.analysis
      record.actions_json = JSON.stringify(decision.actions)
      if (isV2 && decision.notes) {
        record.notes = decision.notes.slice(0, isV3 ? this.cfg.strategyV3.notesMaxChars : this.cfg.strategyV2.notesMaxChars)
      }

      // The model may have been disabled from the dashboard while we waited on it.
      if (!this.cfg.models.some((x) => x.name === a.account.name && x.enabled)) {
        record.results_json = JSON.stringify({ checks: [], executed: ['模型已在决策期间被停用，本次不执行'] })
        logger.info(`[${a.account.name}] disabled during the call, skipping execution`)
        return
      }

      // Re-read state + prices *after* the (slow) model call.
      const prices = { ...snapPrices, ...(await fetchPrices(this.cfg.symbols).catch(() => ({}))) }
      const { equity, cash } = accountEquity(id, prices)
      const outcome = evaluateActions(decision.actions, {
        equity,
        cash,
        peakEquity: Math.max(getAccountState(id)?.peak_equity ?? equity, equity),
        halted: !!getAccountState(id)?.halted,
        symbols: this.cfg.symbols,
        prices,
        positions: listPositionMeta(id).map(toView),
        feeRate: this.costs.feeRate,
        config: this.cfg.risk,
        ...(m.strategy === 'v3.1' ? { confirmation: { now: Date.now(), snapshotTs: snapshot.ts, bars: confirmationBars(snapshot) } } : {}),
        ...(isV3
          ? { v3: this.v3Rules(id, Date.now(), snapshot) }
          : isV2
            ? { v2: this.v2Rules(id, Date.now(), snapshot) }
            : {}),
      })
      const execNotes = this.execute(id, outcome.orders, prices)
      record.results_json = JSON.stringify({ checks: outcome.results, executed: execNotes })
      logger.info(
        `[${a.account.name}] ${decision.actions.length} actions -> ${outcome.orders.length} orders` +
          (execNotes.length ? ` | ${execNotes.join('; ')}` : ''),
      )
    } catch (e) {
      record.error = String(e instanceof Error ? e.message : e).slice(0, 2000)
      logger.error(`[${a.account.name}] decision failed: ${record.error}`)
    } finally {
      insertDecision(record)
    }
  }

  private execute(accountId: number, orders: ApprovedOrder[], prices: Record<string, number>): string[] {
    const notes: string[] = []
    // Closes first so their released cash is available to opens.
    const sorted = [...orders].sort((x, y) => (x.kind === 'close' ? -1 : 0) - (y.kind === 'close' ? -1 : 0))
    for (const o of sorted) {
      const px = prices[o.symbol]
      try {
        if (!px) throw new Error('no price')
        if (o.kind === 'open') {
          const p = openPosition(accountId, o, px, this.costs)
          notes.push(`开${o.side === 'LONG' ? '多' : '空'} ${o.symbol} ${o.leverage}x 保证金 ${o.margin.toFixed(2)} @${p.entry_price.toFixed(4)} SL ${o.stopLoss}`)
        } else if (o.kind === 'close') {
          const r = closePosition(accountId, o.symbol, px, 'model', this.costs)
          if (r) notes.push(`平仓 ${o.symbol} 净盈亏 ${r.pnl.toFixed(2)}`)
        } else {
          adjustStops(accountId, o.symbol, o.stopLoss, o.takeProfit)
          notes.push(`调整 ${o.symbol} SL ${o.stopLoss} TP ${o.takeProfit}`)
        }
      } catch (e) {
        notes.push(`${o.kind} ${o.symbol} 执行失败: ${e instanceof Error ? e.message : e}`)
      }
    }
    return notes
  }

  // ------------------------------------------------------------ baselines

  private async runBaseline(a: ArenaAccount, snapshot: MarketSnapshot): Promise<void> {
    const id = a.account.id
    const btc = snapshot.symbols.BTC?.price ?? (await fetchPrices(['BTC'])).BTC
    if (!btc) return
    const prices = { BTC: btc }
    const pos = listPositionMeta(id).find((p) => p.symbol === 'BTC')

    const openAll = (side: 'LONG' | 'SHORT', reason: string) => {
      const { equity } = accountEquity(id, prices)
      const cash = getCash(id)
      const margin = Math.min(cash, equity * 0.95) / (1 + this.costs.feeRate * 1.01)
      if (margin * 1 < this.cfg.risk.minOrderNotional) return
      openPosition(
        id,
        { kind: 'open', symbol: 'BTC', side, leverage: 1, margin, notional: margin, quantity: margin / btc, stopLoss: 0, takeProfit: null, reason },
        btc,
        this.costs,
      )
      // Baselines run without stops.
      adjustStops(id, 'BTC', null, null)
    }

    if (a.strategy === 'buy_hold_btc') {
      if (!pos && listClosedTrades(id, 1).length === 0) {
        openAll('LONG', '基准：买入并持有 BTC')
        logger.info(`[${a.account.name}] opened buy & hold`)
      }
      return
    }

    if (a.strategy === 'ema_cross_btc') {
      const closes = await fetchCloses('BTC', '1h', 120)
      const sig = emaCrossSignal(closes)
      if (sig.want === 'FLAT') return
      if (pos && pos.side === sig.want) return
      if (pos) closePosition(id, 'BTC', btc, 'baseline', this.costs)
      openAll(sig.want, `基准均线：${sig.reason}`)
      insertDecision({
        account_id: id,
        ts: Date.now(),
        model: 'ema_cross_btc',
        latency_ms: 0,
        prompt_tokens: null,
        completion_tokens: null,
        analysis: sig.reason,
        raw_response: null,
        actions_json: JSON.stringify([{ symbol: 'BTC', action: sig.want === 'LONG' ? 'open_long' : 'open_short' }]),
        results_json: null,
        error: null,
      })
      logger.info(`[${a.account.name}] switched to ${sig.want}: ${sig.reason}`)
    }
  }

  // ------------------------------------------------------------ monitor

  private async getFunding(): Promise<Record<string, number>> {
    if (Date.now() - this.fundingCache.ts > 5 * 60_000) {
      try {
        this.fundingCache = { ts: Date.now(), rates: await fetchFunding(this.cfg.symbols) }
      } catch (e) {
        logger.warning(`Funding fetch failed: ${e}`)
      }
    }
    return this.fundingCache.rates
  }

  async runMonitor(): Promise<void> {
    const accs = this.activeAccounts()
    if (!accs.length) return
    const symbols = [...new Set([...this.cfg.symbols, ...listAllPositionMeta().map((m) => m.symbol)])]
    const prices = await fetchPrices(symbols)
    if (!Object.keys(prices).length) return
    const now = Date.now()

    // Funding accrual (at most once a minute).
    if (this.cfg.chargeFunding && now - this.lastFundingAccrual >= 60_000) {
      const rates = await this.getFunding()
      for (const a of accs) accrueFunding(a.account.id, prices, rates, now)
      this.lastFundingAccrual = now
    }

    for (const a of accs) {
      const id = a.account.id
      // Per-position triggers
      for (const m of listPositionMeta(id)) {
        const px = prices[m.symbol]
        if (!px) continue
        const trig = checkTrigger(
          { ...toView(m), openedAt: m.opened_at },
          px,
          now,
          a.kind === 'baseline' && a.strategy !== EMA_RULES_VERSION ? { ...this.cfg.risk, maxHoldingHours: 0 } : this.cfg.risk,
        )
        if (!trig) continue
        // Stop: fill at the worse of stop level and current price (gaps fill at market).
        // Take profit: fill at the TP level. Liquidation / timeout: market.
        let fill = px
        if (trig === 'stop_loss') fill = m.side === 'LONG' ? Math.min(m.stop_loss!, px) : Math.max(m.stop_loss!, px)
        else if (trig === 'take_profit') fill = m.take_profit!
        const r = closePosition(id, m.symbol, fill, trig, this.costs, now)
        if (r) logger.warning(`[${a.account.name}] ${trig} ${m.symbol} @${r.exitPrice.toFixed(4)} pnl ${r.pnl.toFixed(2)}`)
      }

      // Account-level drawdown circuit breaker
      const { equity } = accountEquity(id, prices)
      const peak = updatePeakEquity(id, equity)
      const dd = drawdown(equity, peak)
      const state = getAccountState(id)
      if ((a.kind === 'llm' || a.strategy === EMA_RULES_VERSION) && !state?.halted && dd >= this.cfg.risk.forceCloseDrawdownPct) {
        for (const m of listPositionMeta(id)) {
          const px = prices[m.symbol]
          if (px) closePosition(id, m.symbol, px, 'drawdown_halt', this.costs, now)
        }
        haltAccount(id, `回撤 ${(dd * 100).toFixed(1)}% 触发熔断`)
        logger.error(`[${a.account.name}] HALTED: drawdown ${(dd * 100).toFixed(1)}%`)
      }
    }
  }

  // ------------------------------------------------------------ outcomes

  /**
   * Fill `arena_trade_outcomes` for trades closed at least 4h ago (so the
   * post-exit window is complete). Read-only with respect to trading.
   */
  async evaluateOutcomes(limit = 30): Promise<number> {
    const pending = tradesPendingOutcome(POST_EXIT_MS + OUTCOME_BAR_MS, Date.now(), limit)
    let done = 0
    for (const t of pending) {
      try {
        const start = t.opened_at - OUTCOME_BAR_MS
        const end = Math.max(t.closed_at + POST_EXIT_MS, t.opened_at + 4 * 3_600_000) + OUTCOME_BAR_MS
        const bars = Math.min(5000, Math.ceil((end - start) / OUTCOME_BAR_MS) + 2)
        const candles = (await fetchCandlesSince(t.symbol, '5m', start, bars)).filter((c) => c.ts <= end)
        if (!candles.length) continue
        upsertOutcome({
          trade_id: t.id,
          account_id: t.account_id,
          symbol: t.symbol,
          side: t.side,
          entry_price: t.entry_price,
          exit_price: t.exit_price,
          opened_at: t.opened_at,
          closed_at: t.closed_at,
          close_reason: t.close_reason,
          pnl: t.pnl,
          ...computeOutcome(t, candles),
          computed_at: Date.now(),
        })
        done++
      } catch (e) {
        logger.warning(`Outcome for trade ${t.id} failed: ${e instanceof Error ? e.message : e}`)
      }
    }
    if (done) logger.info(`Evaluated ${done} trade outcomes`)
    return done
  }

  async snapshotEquity(): Promise<void> {
    const accs = this.activeAccounts()
    if (!accs.length) return
    const prices = await fetchPrices([...new Set([...this.cfg.symbols, ...listAllPositionMeta().map((m) => m.symbol)])])
    const ts = Date.now()
    for (const a of accs) {
      const { equity, cash } = accountEquity(a.account.id, prices)
      insertEquitySnapshot(a.account.id, equity, cash, ts)
    }
  }
}

let engine: ArenaEngine | null = null
export const getArenaEngine = () => engine
export function setArenaEngine(e: ArenaEngine | null) {
  engine = e
}
