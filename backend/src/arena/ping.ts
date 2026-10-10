/**
 * Connectivity check: sends one real decision prompt to every enabled model
 * and prints latency, token usage and whether the reply parses. Does NOT
 * trade or write to the database.
 *
 *   pnpm --filter backend arena:ping            # all enabled models
 *   pnpm --filter backend arena:ping DeepSeek   # only models whose name contains "DeepSeek"
 */
import { loadArenaConfig, resolveApiKey } from './config.js'
import { fetchMarketSnapshot } from './market.js'
import { buildSystemPrompt, buildUserPrompt, parseDecision } from './prompt.js'
import { chat } from './llm.js'
import { fetchEmaSignal } from './ema-market.js'
import { EMA_FILTER_VERSION, EMA_FILTER_SYSTEM, emaFilterUser, parseEmaVerdict } from './ema-filter.js'
import { roundTripCostPct } from './prompt.js'

const cfg = loadArenaConfig()
if (!cfg) {
  console.error('找不到 backend/arena.config.json（可从 arena.config.example.json 复制）')
  process.exit(1)
}
const filter = process.argv[2]?.toLowerCase()
const models = cfg.models.filter((m) => m.enabled && (!filter || m.name.toLowerCase().includes(filter)))
if (!models.length) {
  console.error('没有匹配的已启用模型')
  process.exit(1)
}

console.log(`拉取行情 ${cfg.symbols.join(', ')} ...`)
const snapshot = await fetchMarketSnapshot(cfg.symbols)
const system = buildSystemPrompt(cfg.symbols, cfg.risk, cfg.reasonLanguage)
const user = buildUserPrompt(snapshot, {
  equity: cfg.initialCapital,
  cash: cfg.initialCapital,
  initialCapital: cfg.initialCapital,
  peakEquity: cfg.initialCapital,
  minutesSinceStart: 0,
  invocationCount: 1,
  positions: [],
  recentTrades: [],
})

let failed = 0
for (const m of models) {
  const isFilter = m.strategy === EMA_FILTER_VERSION
  const filterSignal = isFilter ? await fetchEmaSignal() : null
  if (isFilter && !filterSignal) { console.error('EF1 没有新鲜完整的已收盘行情'); failed++; continue }
  const memory = !isFilter && m.strategy !== 'v1'
  const v3 = m.strategy === 'v3' || m.strategy === 'v3.1'
  const promptInfo = memory ? { ...cfg.strategyV2, feeRate: cfg.takerFeeRate, slippageBps: cfg.risk.slippageBps,
    ...(v3 ? { v3: cfg.strategyV3, notesMaxChars: cfg.strategyV3.notesMaxChars } : {}),
    ...(m.strategy === 'v3.1' ? { confirmedSignals: true } : {}),
  } : undefined
  const modelSystem = memory ? buildSystemPrompt(cfg.symbols, cfg.risk, cfg.reasonLanguage, promptInfo) : system
  const minStopPct = Object.fromEntries(Object.entries(snapshot.symbols).map(([sym, s]) =>
    [sym, s.price > 0 ? s.higher.atr14 * (v3 ? cfg.strategyV3.stopAtrMult : cfg.strategyV2.minStopAtrMult) / s.price : 0]))
  const modelUser = memory ? buildUserPrompt(snapshot, {
    equity: cfg.initialCapital, cash: cfg.initialCapital, initialCapital: cfg.initialCapital, peakEquity: cfg.initialCapital,
    minutesSinceStart: 0, invocationCount: 1, positions: [], recentTrades: [],
    memory: { lastNotes: null, last24h: { closedTrades: 0, feesAndFunding: 0, netPnl: 0, stopLossCount: 0 },
      cooldowns: {}, minStopPct, ...(v3 ? { locks: {} } : {}) },
    ...(m.strategy === 'v3.1' ? { confirmedSignals: true } : {}),
  }) : user
  const key = resolveApiKey(`env:${m.apiKeyEnv}`)
  process.stdout.write(`\n[${m.name}] ${m.model} @ ${m.baseUrl}\n`)
  if (m.model !== 'mock' && !key) {
    console.log(`  ✗ 环境变量 ${m.apiKeyEnv} 未设置（在 backend/.env 里填写）`)
    failed++
    continue
  }
  try {
    const res = await chat({
      baseUrl: m.baseUrl,
      apiKey: key,
      model: m.model,
      system: isFilter ? EMA_FILTER_SYSTEM : modelSystem,
      user: filterSignal ? emaFilterUser(filterSignal, snapshot.symbols.BTC?.fundingRate ?? null, roundTripCostPct(cfg.takerFeeRate, cfg.risk.slippageBps) * 100) : modelUser,
      temperature: m.temperature,
      maxTokens: m.maxTokens,
        timeoutMs: m.timeoutSeconds * 1000,
        extraBody: m.extraBody,
    })
    console.log(`  ✓ ${(res.latencyMs / 1000).toFixed(1)}s  tokens in/out: ${res.promptTokens ?? '?'} / ${res.completionTokens ?? '?'}`)
    try {
      if (isFilter) { const v = parseEmaVerdict(res.text); console.log(`  ✓ EF1 ${v.allow ? '放行' : '拒绝'}：${v.reason}`); continue }
      const d = parseDecision(res.text)
      console.log(`  ✓ 解析成功：${d.actions.length} 条操作`)
      console.log(`  分析：${d.analysis.slice(0, 300)}`)
      for (const a of d.actions) console.log(`   - ${a.action} ${a.symbol} ${JSON.stringify({ margin_pct: a.margin_pct, leverage: a.leverage, stop_loss: a.stop_loss, take_profit: a.take_profit })} ${a.reason ?? ''}`)
    } catch (e) {
      failed++
      console.log(`  ✗ 回复无法解析为决策 JSON：${e}`)
      console.log(`  原始回复前 500 字：${res.text.slice(0, 500)}`)
    }
  } catch (e) {
    failed++
    console.log(`  ✗ 调用失败：${e instanceof Error ? e.message : e}`)
  }
}
process.exit(failed ? 1 : 0)
