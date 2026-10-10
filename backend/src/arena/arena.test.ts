/**
 * Unit tests for the arena's pure logic (risk, indicators, parsing, metrics)
 * plus an in-memory ledger test. Run: pnpm --filter backend test:arena
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.DATABASE_PATH = ':memory:'

const { ema, rsi, atr, macd, last } = await import('./indicators.js')
const { evaluateActions, checkTrigger, sanitizeStopLoss, liquidationPrice } = await import('./risk.js')
const { parseDecision, extractJsonObject } = await import('./prompt.js')
const { computeMetrics, maxDrawdown, tradeStats, liveReadiness, sharpe } = await import('./metrics.js')
const { parseArenaConfig } = await import('./config.js')
const { emaCrossSignal } = await import('./baselines.js')
const { buildChatBody } = await import('./llm.js')
const { upsertModel, setModelEnabled } = await import('./models.js')
const { saveModelsToFile } = await import('./config.js')
const { cooldownUntil } = await import('./risk.js')
const { buildSystemPrompt, buildUserPrompt, roundTripCostPct } = await import('./prompt.js')
const { computeOutcome, summarizeOutcomes } = await import('./outcomes.js')

const cfg = parseArenaConfig({}).risk

const baseCtx = () => ({
  equity: 10_000,
  cash: 10_000,
  peakEquity: 10_000,
  halted: false,
  symbols: ['BTC', 'ETH'],
  prices: { BTC: 100_000, ETH: 4_000 },
  positions: [] as any[],
  feeRate: 0.00045,
  config: cfg,
})

test('ema seeds with SMA and tracks constant series', () => {
  const v = ema([1, 2, 3, 4, 5, 6], 3)
  assert.ok(Number.isNaN(v[1]!))
  assert.equal(v[2], 2)
  assert.equal(v[3], 3)
  assert.equal(last(ema(Array(50).fill(7), 20)), 7)
})

test('rsi is 100 for strictly rising, 0 for strictly falling', () => {
  const up = Array.from({ length: 30 }, (_, i) => i)
  assert.equal(last(rsi(up, 14)), 100)
  const down = up.map((v) => -v)
  assert.equal(last(rsi(down, 14)), 0)
})

test('atr of constant-range candles equals the range', () => {
  const n = 30
  const close = Array(n).fill(100)
  assert.equal(last(atr(close.map(() => 101), close.map(() => 99), close, 14)), 2)
})

test('macd histogram is ~0 on a flat series', () => {
  assert.ok(Math.abs(last(macd(Array(60).fill(5)).histogram)) < 1e-12)
})

test('risk clamps leverage and margin, adds default stop', () => {
  const out = evaluateActions([{ symbol: 'BTC', action: 'open_long', margin_pct: 0.9, leverage: 40 }], baseCtx())
  assert.equal(out.orders.length, 1)
  const o = out.orders[0]!
  assert.equal(o.kind, 'open')
  if (o.kind !== 'open') return
  assert.equal(o.leverage, cfg.maxLeverage)
  assert.equal(o.margin, 10_000 * cfg.maxMarginPctPerTrade)
  assert.ok(o.stopLoss < 100_000 && o.stopLoss > 90_000)
  assert.equal(out.results[0]!.status, 'adjusted')
})

test('risk rejects wrong-side stops by replacing them', () => {
  const s = sanitizeStopLoss('SHORT', 100, 2, 95, cfg)
  assert.ok(s.stop > 100)
})

test('stop distance is capped below liquidation distance', () => {
  // 5x leverage -> liquidation ~20% away; stop must be <= 16%, and cfg max 10%
  const s = sanitizeStopLoss('LONG', 100, 5, 50, cfg)
  assert.ok(Math.abs(s.stop - 90) < 1e-9)
})

test('risk enforces one position per symbol and max positions', () => {
  const ctx = baseCtx()
  ctx.positions = [{ symbol: 'BTC', side: 'LONG', quantity: 0.01, entryPrice: 100_000, leverage: 2, margin: 500, stopLoss: 97_000, takeProfit: null }]
  const out = evaluateActions(
    [
      { symbol: 'BTC', action: 'open_short', margin_pct: 0.1, leverage: 2, stop_loss: 103_000 },
      { symbol: 'DOGE', action: 'open_long', margin_pct: 0.1 },
      { symbol: 'ETH', action: 'open_short', margin_pct: 0.1, leverage: 2, stop_loss: 4_100 },
    ],
    ctx,
  )
  assert.equal(out.results[0]!.status, 'rejected')
  assert.equal(out.results[1]!.status, 'rejected')
  assert.equal(out.results[2]!.status, 'approved')
  assert.equal(out.orders.length, 1)
})

test('drawdown blocks new positions but allows closes', () => {
  const ctx = baseCtx()
  ctx.equity = 7_000
  ctx.positions = [{ symbol: 'ETH', side: 'SHORT', quantity: 1, entryPrice: 4_000, leverage: 2, margin: 2_000, stopLoss: 4_200, takeProfit: null }]
  const out = evaluateActions(
    [
      { symbol: 'BTC', action: 'open_long', margin_pct: 0.1, leverage: 2, stop_loss: 98_000 },
      { symbol: 'ETH', action: 'close' },
    ],
    ctx,
  )
  assert.equal(out.results[0]!.status, 'rejected')
  assert.deepEqual(out.orders.map((o) => o.kind), ['close'])
})

test('total margin cap shrinks later opens in the same cycle', () => {
  const ctx = baseCtx()
  ctx.config = { ...cfg, maxTotalMarginPct: 0.3, maxMarginPctPerTrade: 0.25 }
  const out = evaluateActions(
    [
      { symbol: 'BTC', action: 'open_long', margin_pct: 0.25, leverage: 2, stop_loss: 98_000 },
      { symbol: 'ETH', action: 'open_long', margin_pct: 0.25, leverage: 2, stop_loss: 3_900 },
    ],
    ctx,
  )
  const margins = out.orders.map((o) => (o.kind === 'open' ? o.margin : 0))
  assert.equal(margins[0], 2_500)
  assert.ok(Math.abs(margins[1]! - 500) < 1e-6)
})

test('triggers: stop, take profit, liquidation, timeout', () => {
  const p = { symbol: 'BTC', side: 'LONG' as const, quantity: 0.1, entryPrice: 100_000, leverage: 5, margin: 2_000, stopLoss: 97_000, takeProfit: 105_000, openedAt: 0 }
  const c = { ...cfg, maxHoldingHours: 48 }
  assert.equal(checkTrigger(p, 99_000, 1000, c), null)
  assert.equal(checkTrigger(p, 96_900, 1000, c), 'stop_loss')
  assert.equal(checkTrigger(p, 105_100, 1000, c), 'take_profit')
  assert.equal(checkTrigger({ ...p, stopLoss: null }, 79_000, 1000, c), 'liquidation')
  assert.equal(checkTrigger(p, 99_000, 49 * 3_600_000, c), 'timeout')
  const liq = liquidationPrice(p)
  assert.ok(liq > 80_000 && liq < 81_000)
})

test('parseDecision handles fences, think tags, comments, aliases', () => {
  const text = `<think>{"nope":1}</think>Sure!\n\`\`\`json\n{
    "analysis": "看多",
    "actions": [
      {"symbol": "btc-usd", "action": "LONG", "margin_pct": "0.1", "leverage": 3, "stop_loss": 95000}, // comment
      {"symbol": "ETH", "action": "dance"},
    ]
  }\n\`\`\``
  const d = parseDecision(text)
  assert.equal(d.analysis, '看多')
  assert.equal(d.actions.length, 1)
  assert.deepEqual(
    { s: d.actions[0]!.symbol, a: d.actions[0]!.action, m: d.actions[0]!.margin_pct },
    { s: 'BTC', a: 'open_long', m: 0.1 },
  )
  assert.equal(extractJsonObject('{"a":"}"}x'), '{"a":"}"}')
  assert.throws(() => parseDecision('no json here'))
})

test('chat body merges extraBody but keeps model/messages', () => {
  const req = { baseUrl: 'x', apiKey: 'k', model: 'deepseek-flash', system: 'S', user: 'U', temperature: 0.3, maxTokens: 100 }
  const plain = buildChatBody(req)
  assert.equal(plain.max_tokens, 100)
  assert.equal(plain.thinking, undefined)
  const body = buildChatBody({
    ...req,
    extraBody: { thinking: { type: 'enabled' }, reasoning_effort: 'high', max_tokens: 500, model: 'evil', messages: [] },
  })
  assert.deepEqual(body.thinking, { type: 'enabled' })
  assert.equal(body.reasoning_effort, 'high')
  assert.equal(body.max_tokens, 500) // provider knobs may override defaults
  assert.equal(body.model, 'deepseek-flash') // ...but never the model or prompt
  assert.equal((body.messages as any[]).length, 2)
  const parsed = parseArenaConfig({ models: [{ name: 'A', model: 'm', extraBody: { reasoning_effort: 'high' } }] })
  assert.deepEqual(parsed.models[0]!.extraBody, { reasoning_effort: 'high' })
})

test('chat: undici timeouts never fire before timeoutSeconds; errors keep their cause', async () => {
  const { dispatcherTimeouts, describeError, chat } = await import('./llm.js')
  // Hy4 runs with timeoutSeconds=600; undici's 300s default used to kill it first.
  const t = dispatcherTimeouts(600_000)
  assert.ok(t.headersTimeout > 600_000 && t.bodyTimeout > 600_000)
  const wrapped = new TypeError('fetch failed', { cause: Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' }) })
  assert.equal(describeError(wrapped), 'fetch failed (UND_ERR_HEADERS_TIMEOUT Headers Timeout Error)')
  assert.equal(describeError(new Error('plain')), 'plain')

  // End-to-end against a local server whose headers arrive after 1.5s.
  const http = await import('node:http')
  const reply = JSON.stringify({ choices: [{ message: { content: '{"actions":[]}' } }], usage: { prompt_tokens: 1, completion_tokens: 2 } })
  const server = http.createServer((_q, r) => setTimeout(() => r.end(reply), 1500))
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const port = (server.address() as any).port
  const req = { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', model: 'm', system: 'S', user: 'U', temperature: 0, maxTokens: 10 }
  try {
    const res = await chat({ ...req, timeoutMs: 10_000 })
    assert.equal(res.text, '{"actions":[]}')
    assert.equal(res.completionTokens, 2)
  } finally {
    server.close()
  }
})

test('model edits: add, edit, toggle, validation, no rename', () => {
  const base = parseArenaConfig({ models: [{ name: 'A', model: 'm1', baseUrl: 'https://x/v1', apiKeyEnv: 'X_API_KEY' }] }).models
  const added = upsertModel(base, { model: { name: ' B ', model: 'm2', baseUrl: 'https://y/v1/', apiKeyEnv: 'Y_API_KEY' } })
  assert.equal(added.length, 2)
  assert.equal(added[1]!.name, 'B')
  assert.equal(added[1]!.baseUrl, 'https://y/v1')
  assert.equal(added[1]!.maxTokens, 4000) // defaults filled
  assert.throws(() => upsertModel(added, { model: { name: 'B', model: 'z' } }), /已存在/)
  const edited = upsertModel(added, { originalName: 'A', model: { ...added[0], maxTokens: 9000 } })
  assert.equal(edited[0]!.maxTokens, 9000)
  assert.throws(() => upsertModel(added, { originalName: 'A', model: { ...added[0], name: 'A2' } }), /不能改名/)
  assert.throws(() => upsertModel(added, { model: { name: 'C', model: 'z', apiKeyEnv: 'bad-name' } }), /环境变量/)
  assert.throws(() => upsertModel(added, { model: { name: 'C', model: 'z', baseUrl: 'ftp://x' } }), /baseUrl/)
  assert.throws(() => upsertModel(added, { model: { name: '<img>', model: 'z' } }), /名称/)
  assert.throws(() => upsertModel(added, { model: { name: 'C', model: 'z', maxTokens: -1 } }), /参数不合法/)
  const off = setModelEnabled(added, 'A', false)
  assert.equal(off[0]!.enabled, false)
  assert.equal(added[0]!.enabled, true) // input not mutated
  assert.throws(() => setModelEnabled(added, 'nope', true), /找不到/)
})

test('saveModelsToFile keeps other settings and compacts defaults', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'arena-')), 'cfg.json')
  fs.writeFileSync(file, JSON.stringify({ symbols: ['BTC', 'HYPE'], risk: { maxOpenPositions: 5 }, models: [] }))
  const prev = process.env.ARENA_CONFIG
  process.env.ARENA_CONFIG = file
  try {
    const models = upsertModel([], { model: { name: 'A', model: 'm', baseUrl: 'https://x/v1', apiKeyEnv: 'X_API_KEY', extraBody: { k: 1 } } })
    saveModelsToFile(setModelEnabled(models, 'A', false))
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.deepEqual(raw.symbols, ['BTC', 'HYPE'])
    assert.equal(raw.risk.maxOpenPositions, 5)
    assert.deepEqual(raw.models, [{ name: 'A', model: 'm', baseUrl: 'https://x/v1', apiKeyEnv: 'X_API_KEY', extraBody: { k: 1 }, enabled: false }])
    assert.equal(parseArenaConfig(raw).models[0]!.maxTokens, 4000)
  } finally {
    if (prev === undefined) delete process.env.ARENA_CONFIG
    else process.env.ARENA_CONFIG = prev
  }
})

test('metrics: return, drawdown, win rate', () => {
  assert.equal(maxDrawdown([100, 120, 90, 130]), 0.25)
  const m = computeMetrics(10_000, 11_000, [], [
    { pnl: 300, fees: 5, funding: 1 },
    { pnl: -100, fees: 5, funding: 0 },
  ])
  assert.equal(m.returnPct, 10)
  assert.equal(m.winRatePct, 50)
  assert.equal(m.profitFactor, 3)
  assert.equal(m.totalFees, 10)
})

test('trade stats: gross vs net, expectancy, t-stat, loss streak', () => {
  const s = tradeStats([
    { pnl: 10, fees: 1, funding: 0, close_reason: 'model', closed_at: 1 },
    { pnl: -5, fees: 1, funding: 0.5, close_reason: 'stop_loss', closed_at: 2 },
    { pnl: -5, fees: 1, funding: 0, close_reason: 'stop_loss', closed_at: 3 },
    { pnl: 20, fees: 2, funding: 0, close_reason: 'take_profit', closed_at: 4 },
    { pnl: -10, fees: 1, funding: 0, close_reason: 'stop_loss', closed_at: 5 },
  ])
  assert.equal(s.realizedPnl, 10)
  assert.equal(s.grossPnl, 16.5)
  assert.equal(s.expectancy, 2)
  assert.equal(s.avgWin, 15)
  assert.equal(s.avgLoss, -20 / 3)
  assert.equal(s.maxConsecLosses, 2)
  assert.equal(s.stopLossRatePct, 60)
  assert.ok(s.tStat != null && Math.abs(s.tStat - 2 / (Math.sqrt(157.5) / Math.sqrt(5))) < 1e-9)
  assert.equal(tradeStats([{ pnl: 1, fees: 0, funding: 0 }]).tStat, null)
  assert.equal(tradeStats([]).expectancy, null)
})

test('sharpe is withheld for spans under 7 days', () => {
  const pts = Array.from({ length: 50 }, (_, i) => ({ ts: i * 900_000, equity: 10_000 + i + (i % 3) }))
  assert.equal(sharpe(pts), null)
  const long = Array.from({ length: 50 }, (_, i) => ({ ts: i * 4 * 3_600_000, equity: 10_000 + i + (i % 3) }))
  assert.ok(sharpe(long) != null)
})

test('live readiness requires every gate; null values fail', () => {
  const good = { runDays: 30, trades: 80, excessPct: 3, profitFactor: 1.5, maxDrawdownPct: 8, expectancy: 4, tStat: 2.4, errorRatePct: 1 }
  assert.equal(liveReadiness(good).ready, true)
  const r = liveReadiness({ ...good, tStat: null })
  assert.equal(r.ready, false)
  assert.equal(r.passed, r.gates.length - 1)
  assert.equal(liveReadiness({ ...good, maxDrawdownPct: 20 }).ready, false)
})

test('ema cross baseline signal', () => {
  const up = Array.from({ length: 80 }, (_, i) => 100 + i)
  assert.equal(emaCrossSignal(up).want, 'LONG')
  assert.equal(emaCrossSignal(up.map((v) => 300 - v)).want, 'SHORT')
  assert.equal(emaCrossSignal([1, 2, 3]).want, 'FLAT')
})

test('ledger: open/close long and short with fees, slippage, isolated loss cap', async () => {
  const { ensureSchema, db } = await import('../db/client.js')
  const { seedDatabase } = await import('../db/seed.js')
  const { ensureArenaSchema, listClosedTrades } = await import('./store.js')
  const { accounts } = await import('../db/schema.js')
  const L = await import('./ledger.js')
  ensureSchema()
  seedDatabase()
  ensureArenaSchema()
  const acc = db.select().from(accounts).get()!
  L.resetAccount(acc.id, 10_000)
  const costs = { feeRate: 0.001, slippageBps: 0 }

  // Long 2x, $1000 margin, +10% -> +$200 minus fees
  L.openPosition(acc.id, { kind: 'open', symbol: 'BTC', side: 'LONG', leverage: 2, margin: 1000, notional: 2000, quantity: 0.02, stopLoss: 95_000, takeProfit: null, reason: '' }, 100_000, costs)
  assert.equal(L.getCash(acc.id), 10_000 - 1000 - 2)
  assert.equal(L.accountEquity(acc.id, { BTC: 110_000 }).equity, 10_000 - 2 + 200)
  const r1 = L.closePosition(acc.id, 'BTC', 110_000, 'model', costs)!
  assert.ok(Math.abs(r1.pnl - (200 - 2 - 2.2)) < 1e-9)

  // Short 2x profits when price falls
  L.openPosition(acc.id, { kind: 'open', symbol: 'ETH', side: 'SHORT', leverage: 2, margin: 1000, notional: 2000, quantity: 0.5, stopLoss: 4_200, takeProfit: null, reason: '' }, 4_000, costs)
  assert.ok(L.accountEquity(acc.id, { ETH: 3_600 }).equity > L.getCash(acc.id) + 1000)
  const r2 = L.closePosition(acc.id, 'ETH', 3_600, 'model', costs)!
  assert.ok(r2.pnl > 190)

  // Isolated margin: a 5x long that loses 50% only loses the margin
  const before = L.accountEquity(acc.id, {}).equity
  L.openPosition(acc.id, { kind: 'open', symbol: 'SOL', side: 'LONG', leverage: 5, margin: 100, notional: 500, quantity: 2.5, stopLoss: 190, takeProfit: null, reason: '' }, 200, costs)
  L.closePosition(acc.id, 'SOL', 100, 'liquidation', costs)
  const after = L.accountEquity(acc.id, {}).equity
  assert.ok(Math.abs(before - after - 100.5) < 1e-9, `lost ${before - after}`)
  assert.equal(listClosedTrades(acc.id).length, 3)

  // Slippage: buying fills above the market price
  assert.ok(L.fillPrice(100, true, 10) > 100 && L.fillPrice(100, false, 10) < 100)

  // Funding: positive rate, long pays
  L.openPosition(acc.id, { kind: 'open', symbol: 'BTC', side: 'LONG', leverage: 1, margin: 1000, notional: 1000, quantity: 0.01, stopLoss: 95_000, takeProfit: null, reason: '' }, 100_000, costs, 0)
  const c0 = L.getCash(acc.id)
  L.accrueFunding(acc.id, { BTC: 100_000 }, { BTC: 0.0001 }, 3_600_000)
  assert.ok(Math.abs(c0 - L.getCash(acc.id) - 0.1) < 1e-9)
})

// ---------------------------------------------------------------- strategy v2

test('v1 is the default strategy and its prompts carry no v2 content', () => {
  const full = parseArenaConfig({ models: [{ name: 'A', model: 'x' }] })
  assert.equal(full.models[0]!.strategy, 'v1')
  assert.equal(full.strategyV2.cooldownMinutes, 60)
  const sys = buildSystemPrompt(['BTC'], cfg, 'zh')
  assert.ok(!sys.includes('"notes"') && !sys.includes('re-opened') && !sys.includes('invalidation'))
  assert.ok(sys.endsWith('Write "analysis" and every "reason" in Simplified Chinese.'))
  const view = {
    equity: 10_000, cash: 10_000, initialCapital: 10_000, peakEquity: 10_000, minutesSinceStart: 0, invocationCount: 1,
    positions: [], recentTrades: [],
  }
  const snap = { ts: 0, symbols: {} }
  assert.ok(!buildUserPrompt(snap, view).includes('memory'))
  const v2 = buildUserPrompt(snap, {
    ...view,
    memory: { lastNotes: { minutesAgo: 15, text: '等 BTC 回踩 85000' }, last24h: { closedTrades: 3, feesAndFunding: 12.5, netPnl: -20, stopLossCount: 2 },
      cooldowns: { ETH: 30 }, minStopPct: { BTC: 0.0084 } },
  })
  assert.ok(v2.includes('等 BTC 回踩 85000') && v2.includes('"cooldown_minutes_left":{"ETH":30}') && v2.includes('"BTC":0.84'))
  const sys2 = buildSystemPrompt(['BTC'], cfg, 'zh', { cooldownMinutes: 60, minStopAtrMult: 1, notesMaxChars: 600, feeRate: 0.00045, slippageBps: 5 })
  assert.ok(sys2.includes('"notes"') && sys2.includes('0.19%'))
  assert.ok(Math.abs(roundTripCostPct(0.00045, 5) - 0.0019) < 1e-12)
})

test('parseDecision reads v2 notes and invalidation, v1 output still parses', () => {
  const d = parseDecision('{"analysis":"a","notes":"计划：等突破","actions":[{"symbol":"BTC","action":"open_long","margin_pct":0.1,"leverage":3,"stop_loss":1,"invalidation":"4h 收盘跌破 EMA50"}]}')
  assert.equal(d.notes, '计划：等突破')
  assert.equal(d.actions[0]!.invalidation, '4h 收盘跌破 EMA50')
  const v1 = parseDecision('{"analysis":"a","actions":[{"symbol":"BTC","action":"hold"}]}')
  assert.equal(v1.notes, undefined)
  assert.equal('invalidation' in v1.actions[0]!, false)
})

test('v2 risk: cooldown blocks re-open, ATR widens the stop; without v2 nothing changes', () => {
  const open = [{ symbol: 'BTC', action: 'open_long' as const, margin_pct: 0.1, leverage: 3, stop_loss: 99_500 }]
  const plain = evaluateActions(open, baseCtx())
  assert.equal(plain.orders.length, 1)
  assert.equal((plain.orders[0] as any).stopLoss, 99_500) // 0.5% stop kept as-is in v1

  const now = 1_000_000_000
  const cool = cooldownUntil([{ symbol: 'BTC', closed_at: now - 10 * 60_000 }], 60)
  const blocked = evaluateActions(open, { ...baseCtx(), v2: { now, cooldownUntil: cool, minStopPct: {} } })
  assert.equal(blocked.orders.length, 0)
  assert.match(blocked.results[0]!.notes[0]!, /冷却中，还需 50 分钟/)

  const wide = evaluateActions(open, { ...baseCtx(), v2: { now, cooldownUntil: {}, minStopPct: { BTC: 0.012 } } })
  assert.equal((wide.orders[0] as any).stopLoss, 98_800)
  assert.ok(wide.results[0]!.notes.some((n) => n.includes('按 4h ATR')))
  // The ATR minimum never exceeds the liquidation-safe cap (0.8 / leverage) or maxStopLossPct.
  const capped = evaluateActions([{ ...open[0]!, leverage: 5 }], { ...baseCtx(), v2: { now, cooldownUntil: {}, minStopPct: { BTC: 0.5 } } })
  assert.equal((capped.orders[0] as any).stopLoss, 90_000)
  // invalidation travels with the approved order
  const inv = evaluateActions([{ ...open[0]!, invalidation: '跌破 98000' }], baseCtx())
  assert.equal((inv.orders[0] as any).invalidation, '跌破 98000')
  // cooldown expires
  assert.deepEqual(cooldownUntil([{ symbol: 'BTC', closed_at: 0 }], 0), {})
})

test('trade outcomes: MFE/MAE, horizon returns, stop reclaim, signed for shorts', () => {
  const bar = 5 * 60_000
  const t0 = 1_000 * bar
  // 5m bars from t0-1 for 10h. Price path: 100 -> dips to 98 in the first hour -> 104 at 4h+.
  const candles = Array.from({ length: 121 }, (_, i) => {
    const ts = t0 + (i - 1) * bar
    const p = i <= 12 ? 100 - (i / 12) * 2 : 98 + Math.min(6, ((i - 12) / 36) * 6)
    return { ts, open: p, high: p + 0.1, low: p - 0.1, close: p, volume: 1 }
  })
  const long = computeOutcome({ side: 'LONG', entry_price: 100, exit_price: 98, opened_at: t0, closed_at: t0 + 12 * bar }, candles)
  assert.ok(long.mae_pct! < -1.9 && long.mae_pct! > -2.2)
  assert.ok(long.ret_1h_pct! < 0)
  assert.ok(long.ret_4h_pct! > 3)
  assert.equal(long.reclaimed_entry_4h, 1) // stopped out, then price came back above entry
  assert.ok(long.post_exit_4h_pct! > 5)
  const short = computeOutcome({ side: 'SHORT', entry_price: 100, exit_price: 98, opened_at: t0, closed_at: t0 + 12 * bar }, candles)
  assert.ok(short.mfe_pct! > 1.9 && short.mae_pct! <= 0)
  assert.ok(short.ret_4h_pct! < -3)
  // Missing future data -> nulls, not guesses
  const early = computeOutcome({ side: 'LONG', entry_price: 100, exit_price: 99, opened_at: t0, closed_at: t0 + 100 * bar }, candles.slice(0, 40))
  assert.equal(early.reclaimed_entry_4h, null)
  assert.equal(early.ret_4h_pct, null)

  const rows = [
    { account_id: 1, close_reason: 'stop_loss', pnl: -10, opened_at: 0, closed_at: 3_600_000, ...long },
    { account_id: 1, close_reason: 'model', pnl: -1, opened_at: 0, closed_at: 7_200_000, ...short },
  ]
  const s = summarizeOutcomes(rows, 0.19)
  assert.equal(s.trades, 2)
  assert.equal(s.stopReclaimPct, 100)
  assert.equal(s.modelCloses, 1)
  assert.equal(s.avgHoldHours, 1.5)
  assert.equal(s.gaveBackPct, 50) // the short had MFE > cost but lost
})

test('v2 memory round trip in the engine: notes stored, cooldown applied, invalidation kept', async () => {
  const { ensureSchema } = await import('../db/client.js')
  const { seedDatabase } = await import('../db/seed.js')
  const store = await import('./store.js')
  const L = await import('./ledger.js')
  const { ArenaEngine } = await import('./engine.js')
  ensureSchema()
  seedDatabase()
  store.ensureArenaSchema()
  store.ensureArenaSchema() // migrations are idempotent
  const engine = new ArenaEngine(
    parseArenaConfig({ models: [{ name: 'V2 Mock', model: 'mock', strategy: 'v2' }, { name: 'V1 Mock', model: 'mock' }], baselines: [] }),
  )
  const accs = engine.syncAccounts()
  const v2 = accs.find((a) => a.account.name === 'V2 Mock')!
  const id = v2.account.id
  const costs = { feeRate: 0.00045, slippageBps: 5 }
  L.openPosition(id, { kind: 'open', symbol: 'ETH', side: 'LONG', leverage: 2, margin: 500, notional: 1000, quantity: 0.25, stopLoss: 3_800, takeProfit: null, reason: '突破', invalidation: '跌回 3900 下方' }, 4_000, costs)
  assert.equal(store.getPositionMeta(id, 'ETH')!.invalidation, '跌回 3900 下方')
  L.closePosition(id, 'ETH', 4_010, 'stop_loss', costs)
  const closed = store.listClosedTrades(id, 1)[0]!
  assert.equal(closed.invalidation, '跌回 3900 下方')
  assert.equal(closed.entry_reason, '突破')

  store.insertDecision({ account_id: id, ts: Date.now() - 15 * 60_000, model: 'mock', latency_ms: 1, prompt_tokens: 0, completion_tokens: 0,
    analysis: 'x', raw_response: null, actions_json: '[]', results_json: null, error: null, strategy_version: 'v2', notes: '下一步：等 ETH 冷却结束' })
  const view = engine.buildAccountView(v2, { ETH: 4_000 })
  assert.equal(view.memory!.lastNotes!.text, '下一步：等 ETH 冷却结束')
  assert.equal(view.memory!.last24h.closedTrades, 1)
  assert.equal(view.memory!.last24h.stopLossCount, 1)
  assert.ok(view.memory!.cooldowns.ETH! > 55)
  const v1 = accs.find((a) => a.account.name === 'V1 Mock')!
  assert.equal(engine.buildAccountView(v1, {}).memory, undefined)
})

// ---------------------------------------------------------------- strategy v3

test('v3 sizing: system sets size from stop distance, ignores margin_pct/leverage', async () => {
  const { sizeByRisk, stopGuardLocks } = await import('./risk.js')
  const rt = 0.0019
  const v3 = { now: 1e12, minStopPct: { BTC: 0.02 }, locks: {}, riskPerTradePct: 0.01, roundTripPct: rt }
  // Model asks for a 0.5% stop with 25% margin at 5x; system widens the stop to 2% and sizes for ~1% risk.
  const open = [{ symbol: 'BTC', action: 'open_long' as const, margin_pct: 0.25, leverage: 5, stop_loss: 99_500 }]
  const r = evaluateActions(open, { ...baseCtx(), v3 })
  const o = r.orders[0] as any
  assert.equal(o.stopLoss, 98_000)
  const expectNotional = 100 / (0.02 + rt)
  assert.ok(Math.abs(o.notional - expectNotional) < 0.01)
  assert.equal(o.leverage, 2) // 4566 notional / 2500 max margin -> 2x
  assert.ok(Math.abs(o.notional * (0.02 + rt) - 100) < 0.01) // stop-out loses ~1% of 10k
  assert.ok(r.results[0]!.notes.some((n) => n.includes('系统按风险定仓')))
  // Wider stop -> smaller position, same risk.
  const wide = evaluateActions([{ ...open[0]!, stop_loss: 95_000 }], { ...baseCtx(), v3 })
  assert.ok((wide.orders[0] as any).notional < o.notional)
  assert.equal((wide.orders[0] as any).stopLoss, 95_000)
  // Very tight ATR (tiny stop) -> size capped by maxLeverage x maxMarginPctPerTrade.
  const tiny = sizeByRisk('LONG', 100_000, 99_900, { ...baseCtx(), v3: { ...v3, minStopPct: {} } }, 'BTC', 8_000, 10_000)
  assert.equal(tiny.order!.leverage, cfg.maxLeverage)
  assert.ok(Math.abs(tiny.order!.notional - 10_000 * cfg.maxMarginPctPerTrade * cfg.maxLeverage) < 1e-6)
  // Shorts mirror.
  const short = evaluateActions([{ symbol: 'ETH', action: 'open_short', stop_loss: 4_200 }], { ...baseCtx(), v3 })
  assert.equal((short.orders[0] as any).side, 'SHORT')
  assert.equal((short.orders[0] as any).stopLoss, 4_200)
  // The v2 cooldown does not apply to v3 (only stop-guard locks do).
  void stopGuardLocks
})

test('v3 stop guard: 2 losing stops on same symbol+side lock that side only; TPs never lock', async () => {
  const { stopGuardLocks } = await import('./risk.js')
  const H = 3_600_000
  const now = 100 * H
  const rule = { count: 2, lookbackHours: 24, lockHours: 4 }
  const sl = (symbol: string, side: string, h: number, pnl = -10, close_reason = 'stop_loss') => ({ symbol, side, close_reason, pnl, closed_at: now - h * H })
  const locks = stopGuardLocks([sl('BTC', 'LONG', 5), sl('BTC', 'LONG', 1), sl('ETH', 'LONG', 1), sl('BTC', 'SHORT', 2)], rule, now)
  assert.deepEqual(Object.keys(locks), ['BTC:LONG'])
  assert.equal(locks['BTC:LONG'], now + 3 * H) // 4h after the latest stop
  assert.deepEqual(stopGuardLocks([sl('BTC', 'LONG', 6), sl('BTC', 'LONG', 5)], rule, now), {}) // lock already expired
  assert.deepEqual(stopGuardLocks([sl('BTC', 'LONG', 30), sl('BTC', 'LONG', 1)], rule, now), {}) // outside lookback
  assert.deepEqual(stopGuardLocks([sl('BTC', 'LONG', 2, 5, 'take_profit'), sl('BTC', 'LONG', 1, -5, 'model')], rule, now), {})
  assert.deepEqual(stopGuardLocks([sl('BTC', 'LONG', 2, 1), sl('BTC', 'LONG', 1, 1)], rule, now), {}) // profitable trailing stops
  // Risk layer: locked side rejected, other side allowed.
  const v3 = { now, minStopPct: {}, locks, riskPerTradePct: 0.01, roundTripPct: 0.0019 }
  const r = evaluateActions(
    [{ symbol: 'BTC', action: 'open_long', stop_loss: 97_000 }, { symbol: 'ETH', action: 'open_long', stop_loss: 3_900 }],
    { ...baseCtx(), v3 },
  )
  assert.match(r.results[0]!.notes[0]!, /暂停该方向，还需 180 分钟/)
  assert.equal(r.orders.length, 1)
  const s = evaluateActions([{ symbol: 'BTC', action: 'open_short', stop_loss: 103_000 }], { ...baseCtx(), v3 })
  assert.equal(s.orders.length, 1)
})

test('v3 cadence and prompts: hourly slots, v3 section replaces v2, v1/v2 untouched', async () => {
  const { v3Due } = await import('./engine.js')
  const H = 3_600_000
  assert.equal(v3Due(null, 5 * H, 60), true)
  assert.equal(v3Due(5 * H + 1, 5 * H + 45 * 60_000, 60), false) // same hour
  assert.equal(v3Due(5 * H + 45 * 60_000, 6 * H + 10, 60), true) // next hour
  const full = parseArenaConfig({ models: [{ name: 'A', model: 'x', strategy: 'v3' }] })
  assert.equal(full.models[0]!.strategy, 'v3')
  assert.deepEqual(full.strategyV3.stopGuard, { count: 2, lookbackHours: 24, lockHours: 4 })
  const base = { cooldownMinutes: 60, minStopAtrMult: 1, notesMaxChars: 600, feeRate: 0.00045, slippageBps: 5 }
  const sys3 = buildSystemPrompt(['BTC'], cfg, 'zh', { ...base, v3: full.strategyV3 })
  assert.ok(sys3.includes('POSITION SIZE IS SET BY THE SYSTEM') && sys3.includes('1.0% of equity') && sys3.includes('2x the 4h ATR14'))
  assert.ok(!sys3.includes('cannot be re-opened'))
  const sys2 = buildSystemPrompt(['BTC'], cfg, 'zh', base)
  assert.ok(sys2.includes('cannot be re-opened for 60 minutes') && !sys2.includes('POSITION SIZE'))
  const view = {
    equity: 10_000, cash: 10_000, initialCapital: 10_000, peakEquity: 10_000, minutesSinceStart: 0, invocationCount: 1,
    positions: [], recentTrades: [],
    memory: { lastNotes: null, last24h: { closedTrades: 0, feesAndFunding: 0, netPnl: 0, stopLossCount: 0 }, cooldowns: {}, locks: { 'BTC:LONG': 90 }, minStopPct: {} },
  }
  const u3 = buildUserPrompt({ ts: 0, symbols: {} }, view)
  assert.ok(u3.includes('"locked_sides_minutes_left":{"BTC:LONG":90}') && !u3.includes('cooldown_minutes_left'))
})

test('v3 engine: memory carries locks, no cooldown after a take-profit', async () => {
  const store = await import('./store.js')
  const L = await import('./ledger.js')
  const { ArenaEngine } = await import('./engine.js')
  const engine = new ArenaEngine(parseArenaConfig({ models: [{ name: 'V3 Mock', model: 'mock', strategy: 'v3' }], baselines: [] }))
  const a = engine.syncAccounts().find((x) => x.account.name === 'V3 Mock')!
  const id = a.account.id
  const costs = { feeRate: 0.00045, slippageBps: 5 }
  const op = (sym: string, px: number) =>
    L.openPosition(id, { kind: 'open', symbol: sym, side: 'LONG', leverage: 2, margin: 500, notional: 1000, quantity: 1000 / px, stopLoss: px * 0.97, takeProfit: null, reason: 'x' }, px, costs)
  op('ETH', 4_000); L.closePosition(id, 'ETH', 4_200, 'take_profit', costs)
  op('BTC', 100_000); L.closePosition(id, 'BTC', 97_000, 'stop_loss', costs)
  op('BTC', 100_000); L.closePosition(id, 'BTC', 97_000, 'stop_loss', costs)
  const mem = engine.buildAccountView(a, { BTC: 97_000, ETH: 4_200 }).memory!
  assert.deepEqual(Object.keys(mem.locks!), ['BTC:LONG'])
  assert.ok(mem.locks!['BTC:LONG']! > 230)
  assert.deepEqual(mem.cooldowns, {})
  const rules = engine.v3Rules(id, Date.now())
  assert.ok(rules.locks['BTC:LONG'] && !rules.locks['ETH:LONG'])
  assert.ok(Math.abs(rules.roundTripPct - 0.0019) < 1e-12)
  assert.equal(engine.promptInfo('v1'), undefined)
  assert.ok(engine.promptInfo('v3')!.v3 && !engine.promptInfo('v2')!.v3)
  void store
})

test('auth: access policy, credentials, sessions, limiter, origin', async () => {
  const A = await import('./auth.js')
  // public read-only views
  for (const p of ['/', '/dashboard', '/api/health', '/api/arena/leaderboard', '/api/arena/decisions', '/api/arena/decisions/12/raw', '/api/arena/positions', '/api/arena/trades', '/api/arena/curves', '/api/arena/outcomes']) {
    assert.equal(A.accessFor('GET', p), 'public', p)
  }
  // admin: model management, config, run-cycle, legacy APIs (default deny)
  for (const [m, p] of [['GET', '/api/arena/models'], ['POST', '/api/arena/models'], ['POST', '/api/arena/models/toggle'], ['POST', '/api/arena/models/test'],
    ['POST', '/api/arena/run-cycle'], ['GET', '/api/arena/config'], ['GET', '/api/account/list'], ['POST', '/api/orders/create'], ['GET', '/api/arena/new-endpoint'],
    ['POST', '/api/arena/leaderboard'], ['POST', '/dashboard']] as const) {
    assert.equal(A.accessFor(m, p), 'admin', `${m} ${p}`)
  }
  assert.equal(A.accessFor('GET', '/ws'), 'blocked')
  assert.equal(A.accessFor('POST', '/api/auth/login'), 'public')

  assert.ok(A.checkCredentials('admin', 'pw', 'admin', 'pw'))
  assert.ok(!A.checkCredentials('admin', 'pw2', 'admin', 'pw'))
  assert.ok(!A.checkCredentials('root', 'pw', 'admin', 'pw'))
  assert.ok(!A.checkCredentials('admin', '', 'admin', '')) // empty password never logs in
  assert.deepEqual(A.parseBasicAuth('Basic ' + Buffer.from('admin:a:b').toString('base64')), { user: 'admin', pass: 'a:b' })
  assert.equal(A.parseBasicAuth('Bearer x'), null)

  const s = new A.SessionStore(1000, 2)
  const t1 = s.create(0)
  assert.ok(s.valid(t1, 500) && !s.valid('nope', 500) && !s.valid(t1, 1000))
  const a = s.create(10), b = s.create(20), c = s.create(30) // cap 2: oldest dropped
  assert.ok(!s.valid(a, 40) && s.valid(b, 40) && s.valid(c, 40))
  s.revoke(c)
  assert.ok(!s.valid(c, 40))

  const l = new A.LoginLimiter(3, 1000)
  l.fail('ip', 0); l.fail('ip', 1); assert.equal(l.retryAfterMs('ip', 2), 0)
  l.fail('ip', 2); assert.ok(l.retryAfterMs('ip', 3) > 0)
  assert.equal(l.retryAfterMs('ip', 1001), 0) // window passed
  l.succeed('ip'); assert.equal(l.retryAfterMs('ip', 3), 0)

  assert.ok(A.sameOrigin(undefined, 'x:5611'))
  assert.ok(A.sameOrigin('http://x:5611', 'x:5611'))
  assert.ok(!A.sameOrigin('https://evil.com', 'x:5611'))
  assert.ok(A.isLoopback('::ffff:127.0.0.1') && !A.isLoopback('10.0.0.1'))
})

test('auth: client IP / https behind the reverse proxy', async () => {
  const { clientInfo, isPrivateAddr } = await import('./auth.js')
  // Caddy on the host -> docker gateway peer; trust its headers
  assert.deepEqual(clientInfo('172.18.0.1', { forwardedFor: '1.2.3.4', forwardedProto: 'https' }), { ip: '1.2.3.4', local: false, https: true })
  assert.deepEqual(clientInfo('::ffff:127.0.0.1', { forwardedFor: '9.9.9.9, 1.2.3.4', forwardedProto: 'https' }).ip, '1.2.3.4')
  // public peer hitting the port directly: headers ignored
  assert.deepEqual(clientInfo('8.8.8.8', { forwardedFor: '127.0.0.1', forwardedProto: 'https' }), { ip: '8.8.8.8', local: false, https: false })
  // localhost without proxy headers is local; with them it is not
  assert.equal(clientInfo('127.0.0.1', {}).local, true)
  assert.equal(clientInfo('127.0.0.1', { forwardedFor: '1.2.3.4' }).local, false)
  assert.equal(clientInfo('172.18.0.1', {}).local, false)
  assert.ok(isPrivateAddr('10.1.2.3') && isPrivateAddr('192.168.1.1') && isPrivateAddr('172.31.0.1'))
  assert.ok(!isPrivateAddr('172.32.0.1') && !isPrivateAddr('43.163.118.24'))
})

test('dashboard paging: trades page, decision cursor without raw, thinned curves, cache', async () => {
  const store = await import('./store.js')
  const { curveBucketMs, cached } = await import('./routes.js')
  store.ensureArenaSchema()
  const A = 90_001, B = 90_002
  const t0 = 1_700_000_000_000
  for (let i = 0; i < 25; i++) {
    store.insertClosedTrade({ account_id: i % 2 ? A : B, symbol: 'BTC', side: 'LONG', leverage: 2, quantity: 1, entry_price: 100, exit_price: 101,
      pnl: i, fees: 0, funding: 0, close_reason: 'model', opened_at: t0, closed_at: t0 + i })
  }
  const p1 = store.listClosedTradesPage([A, B], 0, 10)
  assert.equal(p1.total, 25)
  assert.deepEqual(p1.rows.map((r) => r.pnl), [24, 23, 22, 21, 20, 19, 18, 17, 16, 15])
  assert.deepEqual(store.listClosedTradesPage([A, B], 20, 10).rows.map((r) => r.pnl), [4, 3, 2, 1, 0])
  assert.equal(store.listClosedTradesPage([A], 0, 100).total, 12)
  assert.deepEqual(store.listClosedTradesPage([], 0, 10), { total: 0, rows: [] })

  for (let i = 0; i < 7; i++) {
    store.insertDecision({ account_id: i % 2 ? A : B, ts: t0 + i, model: 'm', latency_ms: 1, prompt_tokens: 1, completion_tokens: 1,
      analysis: 'a' + i, raw_response: 'X'.repeat(1000), actions_json: '[]', results_json: null, error: null })
  }
  const d1 = store.listDecisionsPage([A, B], null, 3)
  assert.deepEqual(d1.map((d) => d.analysis), ['a6', 'a5', 'a4'])
  assert.ok(d1.every((d) => !('raw_response' in d)))
  const d2 = store.listDecisionsPage([A, B], d1.at(-1)!.id, 3)
  assert.deepEqual(d2.map((d) => d.analysis), ['a3', 'a2', 'a1'])
  assert.deepEqual(store.listDecisionsPage([A], null, 10).map((d) => d.analysis), ['a5', 'a3', 'a1'])

  // 5-minute snapshots over 10 hours, thinned into 1-hour buckets: last point of each bucket.
  const H = 3_600_000, start = 1_699_999_200_000 // aligned to the hour
  for (let i = 0; i < 120; i++) store.insertEquitySnapshot(A, 10_000 + i, 0, start + i * 300_000)
  const thin = store.listEquitySnapshotsBucketed(A, 0, H)
  assert.equal(thin.length, 10)
  assert.deepEqual(thin[0], { ts: start + 11 * 300_000, equity: 10_011 })
  assert.equal(thin.at(-1)!.equity, 10_119)
  assert.equal(store.listEquitySnapshotsBucketed(A, 0, 0).length, 120)

  assert.equal(curveBucketMs(0, 24 * H, 300_000, 400), 0) // 288 points fit, keep all
  assert.equal(curveBucketMs(0, 30 * 24 * H, 300_000, 400), Math.ceil((30 * 24 * H) / 400))

  let calls = 0
  const f = () => ++calls
  assert.equal(await cached('t', 1000, f, 0), 1)
  assert.equal(await cached('t', 1000, f, 500), 1)
  assert.equal(await cached('t', 1000, f, 1500), 2)

  const { accessFor } = await import('./auth.js')
  assert.equal(accessFor('GET', '/api/arena/market'), 'public')
})

// ---------------------------------------------------------------- observation / v3.1

test('observation: drawdown overrides sample gates; performance requires all gates and matched BTC', async () => {
  const { observationSignal, matchedBenchmarkReturn } = await import('./metrics.js')
  const input = { runDays: 7, trades: 50, expectancy: -3, profitFactor: 0.69, maxDrawdownPct: 8, matchedExcessPct: -2 }
  assert.equal(observationSignal(input).stop, true)
  for (const override of [{ runDays: 6.99 }, { trades: 49 }, { expectancy: 0 }, { profitFactor: 0.7 }, { matchedExcessPct: 0 }, { matchedExcessPct: null }]) {
    assert.equal(observationSignal({ ...input, ...override }).stop, false)
  }
  assert.equal(observationSignal({ ...input, runDays: 1, trades: 0, maxDrawdownPct: 15 }).stop, true)
  assert.equal(observationSignal({ ...input, runDays: 1, maxDrawdownPct: 10 }).status, 'warning')
  assert.deepEqual(matchedBenchmarkReturn([{ ts: 0, equity: 100 }, { ts: 1000, equity: 110 }], 1000, 121), { returnPct: 10.000000000000009, startTs: 1000 })
  assert.equal(matchedBenchmarkReturn([{ ts: 0, equity: 100 }], 601_000, 121), null)
  assert.equal(matchedBenchmarkReturn([{ ts: 2000, equity: 100 }], 1000, 121), null)
})

test('real MiMo malformed action arrays are rejected as a whole, never partially recovered', async () => {
  const { readFileSync } = await import('node:fs')
  for (const id of [1281, 1298, 1305]) {
    const raw = readFileSync(new URL(`./__fixtures__/mimo-error-${id}.txt`, import.meta.url), 'utf8')
    assert.throws(() => parseDecision(raw), SyntaxError)
  }
  assert.throws(() => parseDecision('{"actions":[{"symbol":"BTC","action":"close"}'), /no JSON/)
})

test('completed 4h bars exclude the live bar, include exact close boundary and require enough history', async () => {
  const { confirmedHigher } = await import('./market.js')
  const H4 = 4 * 3_600_000
  const bars = Array.from({ length: 60 }, (_, i) => ({ ts: i * H4, open: 100, high: 102, low: 98, close: i === 59 ? 999 : 100, volume: 10 }))
  const before = confirmedHigher(bars, 60 * H4 - 1)!
  assert.equal(before.closedAt, 59 * H4)
  assert.equal(before.stats.closes.at(-1), 100)
  assert.equal(confirmedHigher(bars, 60 * H4)!.stats.closes.at(-1), 999)
  assert.equal(confirmedHigher(bars.slice(0, 49), 60 * H4), null)
})

test('v3.1 model close requires fixed rule, a new completed bar and fresh snapshot; old strategies bypass only this gate', async () => {
  const { confirmedClose, parseExitRule } = await import('./confirmation.js')
  const now = 16 * 3_600_000
  const confirmation = { now, snapshotTs: now, bars: { BTC: { closedAt: now, close: 98_000 } } }
  const rule = { kind: 'close_below' as const, price: 99_000 }
  const pos = { symbol: 'BTC', side: 'LONG' as const, quantity: 0.05, entryPrice: 100_000, leverage: 2, margin: 2500,
    stopLoss: 96_000, takeProfit: 110_000, openedAt: now - 3_600_000, exitRule: rule }
  const close = [{ symbol: 'BTC', action: 'close' as const, exit_rule: { kind: 'close_below' as const, price: 200_000 } }]
  const ctx = { ...baseCtx(), positions: [pos], confirmation }
  assert.equal(evaluateActions(close, ctx).orders.length, 1)
  assert.equal(evaluateActions(close, { ...ctx, confirmation: { ...confirmation, bars: { BTC: { closedAt: now, close: 99_000 } } } }).orders.length, 0)
  assert.equal(evaluateActions(close, { ...ctx, positions: [{ ...pos, openedAt: now }] }).orders.length, 0)
  assert.equal(evaluateActions(close, { ...ctx, positions: [{ ...pos, exitRule: null }] }).orders.length, 0)
  assert.equal(evaluateActions(close, { ...ctx, confirmation: { ...confirmation, now: now + 900_001 } }).orders.length, 0)
  assert.equal(evaluateActions(close, { ...ctx, confirmation: { ...confirmation, bars: { BTC: null } } }).orders.length, 0)
  assert.equal(evaluateActions(close, { ...baseCtx(), positions: [pos] }).orders.length, 1)
  assert.equal(confirmedClose({ kind: 'close_above', price: 97_000 }, now - 1, confirmation, 'BTC').allowed, true)
  assert.equal(parseExitRule({ kind: 'close_below', price: '99000' }), null)
  assert.equal(parseExitRule({ kind: 'whatever', price: 99_000 }), null)
  assert.equal(checkTrigger(pos, 95_000, now, cfg), 'stop_loss')
})

test('v3.1 entry rejects missing/wrong/already-triggered rules, retains v3 risk sizing', async () => {
  const now = 16 * 3_600_000
  const confirmation = { now, snapshotTs: now, bars: { BTC: { closedAt: now, close: 100_000 } } }
  const v3 = { now, minStopPct: { BTC: 0.02 }, locks: {}, riskPerTradePct: 0.01, roundTripPct: 0.0019 }
  const action = { symbol: 'BTC', action: 'open_long' as const, stop_loss: 98_000, exit_rule: { kind: 'close_below' as const, price: 99_000 } }
  const ctx = { ...baseCtx(), v3, confirmation }
  const o = evaluateActions([action], ctx).orders[0]!
  assert.equal(o.kind, 'open')
  if (o.kind !== 'open') return
  assert.deepEqual(o.exitRule, action.exit_rule)
  assert.ok(Math.abs(o.notional * 0.0219 - 100) < 0.001)
  assert.equal(evaluateActions([{ ...action, exit_rule: undefined }], ctx).orders.length, 0)
  assert.equal(evaluateActions([{ ...action, exit_rule: { kind: 'close_above', price: 110_000 } }], ctx).orders.length, 0)
  assert.equal(evaluateActions([{ ...action, exit_rule: { kind: 'close_below', price: 101_000 } }], ctx).orders.length, 0)
  assert.equal(evaluateActions([action], { ...ctx, confirmation: { ...confirmation, snapshotTs: now - 900_001 } }).orders.length, 0)
})

test('v3.1 persists entry rules and confirmation audit through additive migrations and closing', async () => {
  const store = await import('./store.js')
  const { ArenaEngine } = await import('./engine.js')
  const { openPosition, closePosition, toView } = await import('./ledger.js')
  store.ensureArenaSchema(); store.ensureArenaSchema()
  const engine = new ArenaEngine(parseArenaConfig({ models: [{ name: 'V31 Mock', model: 'mock', strategy: 'v3.1' }], baselines: [] }))
  const a = engine.syncAccounts()[0]!
  const exitRule = { kind: 'close_below' as const, price: 95_000 }
  const p = openPosition(a.account.id, { kind: 'open', symbol: 'BTC', side: 'LONG', leverage: 2, margin: 1000,
    notional: 2000, quantity: 0.02, stopLoss: 94_000, takeProfit: 110_000, reason: 'test', exitRule }, 100_000, engine.costs, 1000)
  assert.deepEqual(toView(p).exitRule, exitRule)
  assert.equal(toView(p).openedAt, 1000)
  const view = engine.buildAccountView(a, { BTC: 100_000 })
  assert.equal(view.confirmedSignals, true)
  assert.deepEqual(view.positions[0]!.exitRule, exitRule)
  closePosition(a.account.id, 'BTC', 101_000, 'model', engine.costs, 2000)
  assert.deepEqual(JSON.parse(store.listClosedTrades(a.account.id)[0]!.exit_rule_json!), exitRule)
  store.insertDecision({ account_id: a.account.id, ts: 2000, model: 'mock', latency_ms: 1, prompt_tokens: 1,
    completion_tokens: 1, analysis: null, raw_response: null, actions_json: null, results_json: null, error: null,
    strategy_version: 'v3.1', snapshot_ts: 1500, confirmation_json: '{"BTC":null}' })
  const decision = store.listDecisionsPage([a.account.id], null, 1)[0]!
  assert.equal(decision.snapshot_ts, 1500)
  assert.equal(decision.confirmation_json, '{"BTC":null}')
  assert.equal(engine.promptInfo('v3.1')!.confirmedSignals, true)
  assert.equal(engine.promptInfo('v3')!.confirmedSignals, undefined)
  assert.throws(() => upsertModel(engine.cfg.models, { originalName: a.account.name, model: { ...engine.cfg.models[0], strategy: 'v3' } }), /不能在原账户/)
})

test('v3.1 confirmed prompt fields are opt-in; v1/v2/v3 payloads remain identical', async () => {
  const { computeStats, confirmedHigher } = await import('./market.js')
  const { confirmationBars, ArenaEngine } = await import('./engine.js')
  const H4 = 4 * 3_600_000
  const candles = Array.from({ length: 60 }, (_, i) => ({ ts: i * H4, open: 100, high: 101, low: 99, close: 100, volume: 10 }))
  const stats = computeStats('4h', candles)
  const symbol = { symbol: 'BTC', price: 100, markPrice: null, fundingRate: null, openInterest: null, prevDayPrice: null,
    dayNotionalVolume: null, intraday: stats, higher: stats }
  const snap = { ts: 60 * H4, symbols: { BTC: { ...symbol, confirmedHigher: confirmedHigher(candles, 60 * H4) } } }
  const view = { equity: 10000, cash: 10000, initialCapital: 10000, peakEquity: 10000, minutesSinceStart: 0, invocationCount: 1, positions: [], recentTrades: [] }
  assert.equal(buildUserPrompt(snap, view), buildUserPrompt({ ...snap, symbols: { BTC: symbol } }, view))
  assert.ok(buildUserPrompt(snap, { ...view, confirmedSignals: true }).includes('higher_4h_confirmed'))
  const engine = new ArenaEngine(parseArenaConfig({}))
  const sys3 = buildSystemPrompt(['BTC'], cfg, 'zh', engine.promptInfo('v3'))
  const sys31 = buildSystemPrompt(['BTC'], cfg, 'zh', engine.promptInfo('v3.1'))
  assert.ok(!sys3.includes('V3.1') && sys31.startsWith(sys3) && sys31.includes('exit_rule'))
  assert.deepEqual(confirmationBars(snap), { BTC: { closedAt: 60 * H4, close: 100 } })
})

test('portfolio diagnostics aggregate both directions and estimate stop exits against ledger equity', async () => {
  const { portfolioDiagnostics } = await import('./diagnostics.js')
  const positions = [
    { symbol: 'BTC', side: 'LONG' as const, quantity: 2, entry_price: 100, margin: 100, stop_loss: 95 },
    { symbol: 'ETH', side: 'SHORT' as const, quantity: 3, entry_price: 100, margin: 150, stop_loss: 105 },
  ]
  const p = portfolioDiagnostics(positions, { BTC: 110, ETH: 90 }, 1000, { feeRate: 0.001, slippageBps: 10 }, 1000, 1000)
  assert.equal(p.longNotional, 220); assert.equal(p.shortNotional, 270)
  assert.equal(p.netExposurePct, -5); assert.equal(p.grossExposurePct, 49); assert.equal(p.marginPct, 25)
  const expected = 2 * (110 - 95 * 0.999) + 2 * 95 * 0.999 * 0.001
    + 3 * (105 * 1.001 - 90) + 3 * 105 * 1.001 * 0.001
  assert.ok(Math.abs(p.stopScenarioLoss! - expected) < 1e-10)
  // A profitable stop still loses part of the current unrealized profit.
  const profitable = portfolioDiagnostics([{ ...positions[0]!, stop_loss: 105 }], { BTC: 110 }, 1000, { feeRate: 0, slippageBps: 0 }, 1000, 1000)
  assert.equal(profitable.stopScenarioLoss, 10)
  // Isolated margin floors the equity loss; already crossed stops use current price.
  const crossed = portfolioDiagnostics([{ ...positions[0]!, stop_loss: 95 }], { BTC: 80 }, 1000, { feeRate: 0, slippageBps: 0 }, 1000, 1000)
  assert.equal(crossed.stopScenarioLoss, 0)
  const capped = portfolioDiagnostics([{ ...positions[0]!, stop_loss: 1 }], { BTC: 100 }, 1000, { feeRate: 0, slippageBps: 0 }, 1000, 1000)
  assert.equal(capped.stopScenarioLoss, 100)
})

test('portfolio diagnostics refuse stale or missing prices and missing stops', async () => {
  const { portfolioDiagnostics } = await import('./diagnostics.js')
  const positions = [{ symbol: 'BTC', side: 'LONG' as const, quantity: 1, entry_price: 100, margin: 50, stop_loss: 90 }]
  const calc = (px: Record<string, number>, ts: number) => portfolioDiagnostics(positions, px, 1000, { feeRate: 0, slippageBps: 0 }, ts, 100_000)
  assert.equal(calc({ BTC: 100 }, 69_999).stopScenarioLoss, null)
  assert.equal(calc({}, 100_000).grossExposurePct, null)
  assert.deepEqual(calc({ BTC: NaN }, 100_000).missingPrices, ['BTC'])
  const noStop = portfolioDiagnostics([{ ...positions[0]!, stop_loss: null }], { BTC: 100 }, 1000, { feeRate: 0, slippageBps: 0 }, 100_000, 100_000)
  assert.equal(noStop.stopScenarioLoss, null); assert.equal(noStop.grossExposurePct, 10)
  assert.deepEqual(noStop.missingStops, ['BTC'])
  assert.equal(portfolioDiagnostics([], {}, 1000, { feeRate: 0, slippageBps: 0 }, 0, 100_000).stopScenarioLoss, 0)
})

test('cost diagnostics include open fees, retain funding income and reverse buy/sell fill slippage', async () => {
  const { tradingCostDiagnostics } = await import('./diagnostics.js')
  const t = { closedFees: 2, openFees: 3, closedFunding: -10, openFunding: 1, buyFillNotional: 100 * 1.001, sellFillNotional: 200 * 0.999, closedTrades: 1 }
  const c = tradingCostDiagnostics(t, 10)
  assert.equal(c.fees, 5); assert.equal(c.funding, -9); assert.equal(c.explicitCosts, -4)
  assert.ok(Math.abs(c.slippageEstimate! - 0.3) < 1e-12)
  assert.equal(tradingCostDiagnostics(t, 10_000).slippageEstimate, null)
})

test('model fees distinguish published subscription scenarios, configured actual fees and missing usage', async () => {
  const { modelCostDiagnostics } = await import('./diagnostics.js')
  const m = { apiKeyEnv: 'TENCENT_API_KEY', model: 'kimi-k3', baseUrl: 'https://api.lkeap.cloud.tencent.com/plan/v3' }
  const active = [m, m], u = { calls: 3, measuredCalls: 2, prompt: 1000, completion: 2000 }
  const ref = modelCostDiagnostics(m, active, [], u)
  assert.equal(ref.monthlyFee, null); assert.equal(ref.dailyAllocation, null)
  assert.deepEqual(ref.referencePlans.map(p => p.monthlyFee), [39, 99, 299, 599])
  assert.equal(ref.referencePlans[0]!.dailyAllocation, 0.65)
  assert.equal(modelCostDiagnostics(m, active, [{ apiKeyEnv: m.apiKeyEnv, mode: 'subscription', currency: 'CNY', monthlyFee: 99 }], u).dailyAllocation, 1.65)
  assert.equal(modelCostDiagnostics(m, active, [{ apiKeyEnv: m.apiKeyEnv, mode: 'subscription', currency: 'CNY', monthlyFee: 0 }], u).dailyAllocation, 0)
  const payg = modelCostDiagnostics(m, active, [{ apiKeyEnv: m.apiKeyEnv, model: m.model, mode: 'usage', currency: 'USD', inputPerMillion: 2, outputPerMillion: 10 }], u)
  assert.equal(payg.usageEstimate, 0.022); assert.equal(payg.measuredCalls, 2); assert.equal(payg.calls, 3)
  assert.equal(modelCostDiagnostics({ ...m, baseUrl: 'https://example.com/plan/v3' }, active, [], u).mode, 'unknown')
  assert.deepEqual(parseArenaConfig({}).reporting.modelBilling, [])
  assert.throws(() => parseArenaConfig({ reporting: { modelBilling: [{ apiKeyEnv: 'A', mode: 'subscription', currency: 'CNY', monthlyFee: -1 }] } }))
})

test('all-history cost SQL includes open positions once and excludes liquidation exit slippage', async () => {
  const store = await import('./store.js')
  const { ArenaEngine } = await import('./engine.js')
  const { openPosition } = await import('./ledger.js')
  store.ensureArenaSchema()
  const engine = new ArenaEngine(parseArenaConfig({ models: [{ name: 'Diagnostics Mock', model: 'mock' }], baselines: [] }))
  const a = engine.syncAccounts()[0]!
  const p = openPosition(a.account.id, { kind: 'open', symbol: 'BTC', side: 'LONG', leverage: 2, margin: 100,
    notional: 200, quantity: 2, stopLoss: 90, takeProfit: 120, reason: 'test' }, 100, engine.costs, 1000)
  store.insertClosedTrade({ account_id: a.account.id, symbol: 'ETH', side: 'SHORT', leverage: 2, quantity: 2, entry_price: 100,
    exit_price: 110, pnl: -22, fees: 2, funding: -1, close_reason: 'model', opened_at: 1, closed_at: 2 })
  store.insertClosedTrade({ account_id: a.account.id, symbol: 'SOL', side: 'LONG', leverage: 2, quantity: 1, entry_price: 50,
    exit_price: 10, pnl: -40, fees: 1, funding: 0, close_reason: 'liquidation', opened_at: 1, closed_at: 2 })
  const totals = store.tradingCostTotals(a.account.id)
  assert.equal(totals.closedTrades, 2); assert.equal(totals.closedFees, 3)
  assert.equal(totals.openFees, p.entry_fee); assert.equal(totals.closedFunding, -1)
  assert.equal(totals.buyFillNotional, 200 + 220 + 50); assert.equal(totals.sellFillNotional, 200)
  const d = { account_id: a.account.id, ts: 2000, model: 'mock', latency_ms: 1, analysis: null, raw_response: null,
    actions_json: null, results_json: null, error: null }
  store.insertDecision({ ...d, prompt_tokens: 100, completion_tokens: 50 })
  store.insertDecision({ ...d, prompt_tokens: null, completion_tokens: null, error: 'missing' })
  assert.deepEqual(store.tokenUsage(a.account.id), { calls: 2, errors: 1, prompt: 100, completion: 50, measuredCalls: 1 })
})

// EF1: independent rule/AI pair; never changes the historical EMA baseline.
test('EF1 closed hourly bars exclude the forming bar and reject gaps, stale or invalid data', async () => {
  const { buildEmaSignal, emaSignalFresh, EMA_HOUR_MS: H } = await import('./ema-filter.js')
  const bars = Array.from({ length: 121 }, (_, i) => ({ ts: i * H, open: 100 + i, high: 102 + i, low: 98 + i, close: 100 + i, volume: 10 }))
  const now = 120 * H + 3000
  const s = buildEmaSignal(bars, now)!
  assert.equal(s.side, 'LONG'); assert.equal(s.closedAt, 120 * H); assert.equal(s.close, 219)
  assert.deepEqual(buildEmaSignal([...bars.slice(0, -1), { ...bars[120]!, close: 999999 }], now), s)
  assert.equal(buildEmaSignal(bars.slice(1, 60), now), null)
  assert.equal(buildEmaSignal(bars.filter((_, i) => i !== 99), now), null)
  assert.equal(buildEmaSignal(bars.slice(0, 100), now), null)
  assert.equal(buildEmaSignal(bars.map((b, i) => i === 100 ? { ...b, close: NaN } : b), now), null)
  assert.equal(emaSignalFresh(s, now + 600001), false)
  assert.equal(emaSignalFresh({ ...s, asOf: s.closedAt + H - 100 }, s.closedAt + H), false)
})

test('EF1 binary parser rejects invented order parameters and non-boolean acceptance', async () => {
  const { parseEmaVerdict, emaEntryAction } = await import('./ema-filter.js')
  assert.deepEqual(parseEmaVerdict('<think>draft {"allow":false}</think>```json\n{"allow":true,"reason":"趋势"}\n```'), { allow: true, reason: '趋势' })
  for (const text of ['{}', '{"allow":"false","reason":"x"}', '{"allow":true,"reason":"x","leverage":50}', '{"allow":true,"reason":""}']) assert.throws(() => parseEmaVerdict(text))
  const s = { side: 'SHORT', atr14: 1000, closedAt: 1 } as any
  assert.deepEqual(emaEntryAction(s, 100000), { symbol: 'BTC', action: 'open_short', margin_pct: 0.25, leverage: 1, stop_loss: 102000, reason: 'EF1 已收盘 1h EMA20/50 SHORT，信号 1' })
})

test('EF1 durable lifecycle: reject once, no same-trend reentry, close before AI failure, paired risk parity', async () => {
  const { ArenaEngine } = await import('./engine.js')
  const store = await import('./store.js')
  const { rawDb } = await import('../db/client.js')
  const { runEmaAccount } = await import('./ema-runner.js')
  const { buildEmaSignal, EMA_HOUR_MS: H } = await import('./ema-filter.js')
  const { accountEquity, closePosition } = await import('./ledger.js')
  const cfg = parseArenaConfig({ symbols: ['BTC'], baselines: ['ema_rules_v1'], models: [{ name: 'EF1 integration', model: 'mock', strategy: 'ema-filter-v1' }] })
  store.ensureArenaSchema(); store.ensureArenaSchema()
  const engine = new ArenaEngine(cfg), accounts = engine.syncAccounts()
  const ai = accounts.find(a => a.kind === 'llm')!, ctrl = accounts.find(a => a.kind === 'baseline')!
  const bars = Array.from({ length: 120 }, (_, i) => ({ ts: i * H, open: 100 + i, high: 102 + i, low: 98 + i, close: 100 + i, volume: 10 }))
  let now = 120 * H + 3000, calls = 0, answer = false, fail = false
  let signal = buildEmaSignal(bars, now)!
  const deps = { now: () => now, prices: async () => ({ BTC: 220 }), chat: async () => {
    calls++; if (fail) { assert.equal(store.listPositionMeta(ai.account.id).length, 0); throw new Error('provider down') }
    return { text: JSON.stringify({ allow: answer, reason: '测试' }), latencyMs: 1, promptTokens: 2, completionTokens: 3 }
  } }
  const options = (a: typeof ai) => ({ id: a.account.id, cfg, model: a.modelCfg, signal, fundingRate: null, isEnabled: () => true })
  await runEmaAccount(options(ai), deps); await runEmaAccount(options(ctrl), deps)
  assert.equal(calls, 1); assert.equal(store.listPositionMeta(ai.account.id).length, 0)
  assert.equal(store.listPositionMeta(ctrl.account.id).length, 1)
  await runEmaAccount(options(ai), deps); assert.equal(calls, 1)
  now += H; signal = { ...signal, asOf: now, closedAt: signal.closedAt + H }
  await runEmaAccount(options(ai), deps); assert.equal(calls, 1)
  // A fresh trend opens both accounts; compare the actual risk/equity fraction.
  now += H; signal = { ...signal, asOf: now, closedAt: signal.closedAt + H, side: 'SHORT' }; answer = true
  await runEmaAccount(options(ai), deps); await runEmaAccount(options(ctrl), deps)
  const pa = store.listPositionMeta(ai.account.id)[0]!, pc = store.listPositionMeta(ctrl.account.id)[0]!
  assert.equal(pa.side, 'SHORT'); assert.equal(pc.side, 'SHORT'); assert.equal(pa.leverage, 1); assert.equal(pc.leverage, 1)
  assert.equal(pa.stop_loss, pc.stop_loss); assert.equal(pa.take_profit, null)
  assert.equal(pa.margin, 2500); assert.ok(Math.abs(pc.margin / accountEquity(ctrl.account.id, { BTC: 220 }).equity - 0.25) < 0.001)
  // Exit cannot be vetoed by provider failure.
  now += H; signal = { ...signal, asOf: now, closedAt: signal.closedAt + H, side: 'LONG' }; fail = true
  await runEmaAccount(options(ai), deps)
  assert.equal(store.listPositionMeta(ai.account.id).length, 0)
  assert.equal(store.listClosedTrades(ai.account.id, 1)[0]!.close_reason, 'ema_cross')
  const oldCalls = calls; fail = false
  await runEmaAccount(options(ai), deps); assert.equal(calls, oldCalls)
  assert.equal((rawDb.prepare('SELECT status FROM arena_ema_events WHERE account_id=? ORDER BY bar DESC LIMIT 1').get(ai.account.id) as any).status, 'error')
  // The rule account also waits for the next trend after a hard exit.
  closePosition(ctrl.account.id, 'BTC', 220, 'stop_loss', engine.costs, now)
  const controlSignal = { ...signal, side: 'SHORT' as const }
  await runEmaAccount({ ...options(ctrl), signal: controlSignal }, deps)
  assert.equal(store.listPositionMeta(ctrl.account.id).length, 0)
})

test('EF1 rechecks disable, halt, staleness and prices after waiting; errors never authorize entry', async () => {
  const { ArenaEngine } = await import('./engine.js')
  const store = await import('./store.js')
  const { runEmaAccount } = await import('./ema-runner.js')
  const H = 3600000
  for (const mode of ['disabled', 'halted', 'stale', 'bad-price', 'malformed', 'margin-cap']) {
    const cfg = parseArenaConfig({ symbols: ['BTC'], baselines: [], risk: { maxMarginPctPerTrade: 0.1 }, models: [{ name: `EF1 guard ${mode}`, model: 'mock', strategy: 'ema-filter-v1' }] })
    const engine = new ArenaEngine(cfg), a = engine.syncAccounts()[0]!
    let now = 120 * H + 3000, enabled = true, reads = 0
    const signal = { asOf: now, closedAt: 120 * H, side: 'LONG' as const, close: 100, ema20: 99, ema50: 98, atr14: 1, rsi14: 60, ema20SlopePct: 1, volumeRatio: 1, recentCloses: [100] }
    await runEmaAccount({ id: a.account.id, cfg, model: a.modelCfg, signal, fundingRate: null, isEnabled: () => enabled }, {
      now: () => now,
      prices: async (): Promise<Record<string, number>> => (++reads > 1 && mode === 'bad-price' ? {} : { BTC: 100 }),
      chat: async () => {
        if (mode === 'disabled') enabled = false
        if (mode === 'halted') store.haltAccount(a.account.id, 'test')
        if (mode === 'stale') now += H
        return { text: mode === 'malformed' ? '{"allow":"yes","reason":"x"}' : '{"allow":true,"reason":"x"}', latencyMs: 0, promptTokens: 0, completionTokens: 0 }
      },
    })
    const positions = store.listPositionMeta(a.account.id)
    if (mode === 'margin-cap') { assert.equal(positions.length, 1); assert.equal(positions[0]!.margin, 1000); assert.equal(positions[0]!.leverage, 1) }
    else assert.equal(positions.length, 0, mode)
  }
})

test('EF1 concurrent runs claim one candidate and a new engine keeps the consumed signal', async () => {
  const { ArenaEngine } = await import('./engine.js')
  const { runEmaAccount } = await import('./ema-runner.js')
  const store = await import('./store.js')
  const cfg = parseArenaConfig({ baselines: [], models: [{ name: 'EF1 duplicate', model: 'mock', strategy: 'ema-filter-v1' }] })
  const a = new ArenaEngine(cfg).syncAccounts()[0]!
  const now = 432003000
  const signal = { asOf: now, closedAt: 432000000, side: 'LONG' as const, close: 100, ema20: 99, ema50: 98, atr14: 1, rsi14: 60, ema20SlopePct: 1, volumeRatio: 1, recentCloses: [100] }
  let calls = 0
  const deps = { now: () => now, prices: async () => ({ BTC: 100 }), chat: async () => {
    calls++; await new Promise(r => setTimeout(r, 10)); return { text: '{"allow":true,"reason":"测试"}', latencyMs: 10, promptTokens: 1, completionTokens: 1 }
  } }
  const o = { id: a.account.id, cfg, model: a.modelCfg, signal, fundingRate: null, isEnabled: () => true }
  await Promise.all([runEmaAccount(o, deps), runEmaAccount(o, deps)])
  assert.equal(calls, 1); assert.equal(store.listPositionMeta(a.account.id).length, 1)
  new ArenaEngine(cfg).syncAccounts()
  await runEmaAccount(o, deps); assert.equal(calls, 1)
})

test('history leaderboard keeps disabled/removed accounts, freezes observation time and never activates them', async () => {
  const { ArenaEngine, setArenaEngine } = await import('./engine.js')
  const { buildLeaderboard } = await import('./routes.js')
  const S = await import('./store.js')
  const { rawDb } = await import('../db/client.js')
  const c = parseArenaConfig({ baselines: ['buy_hold_btc'], models: [
    { name: 'History disabled', model: 'mock', strategy: 'v3.1' },
    { name: 'History removed', model: 'mock', strategy: 'v3' },
    { name: 'History empty', model: 'mock' },
    { name: 'History active', model: 'mock' },
  ] })
  const e = new ArenaEngine(c), all = e.syncAccounts()
  const id = (name: string) => all.find(a => a.account.name === name)!.account.id
  const stopped = id('History disabled'), removed = id('History removed'), empty = id('History empty')
  const btc = all.find(a => a.kind === 'baseline')!.account.id
  const t = Date.now() - 2 * 86400000
  S.insertEquitySnapshot(stopped, 10000, 10000, t)
  S.insertEquitySnapshot(stopped, 10000, 10000, t + 3600000)
  S.insertEquitySnapshot(btc, 10000, 10000, t)
  S.insertEquitySnapshot(btc, 10100, 10100, t + 3600000)
  S.insertDecision({ account_id: removed, ts: t, model: 'mock', strategy_version: 'v3', latency_ms: 1,
    prompt_tokens: 1, completion_tokens: 1, analysis: '', raw_response: '{}', actions_json: '[]', results_json: null, error: null })
  e.cfg = { ...c, models: c.models.filter(m => m.name !== 'History removed').map(m => ({ ...m, enabled: m.name === 'History active' })) }
  e.syncAccounts()
  setArenaEngine(e)
  try {
    const report = await buildLeaderboard({ BTC: 100 })
    const row = report.rows.find(r => r.account_id === stopped)!
    assert.equal(row.enabled, false)
    assert.equal(row.endedAt, t + 3600000)
    assert.ok(Math.abs(row.runDays - 1 / 24) < 1e-9)
    assert.ok(Math.abs(row.excessPct! + 1) < 1e-9)
    assert.equal(row.readiness, null)
    assert.equal(row.modelCosts, null)
    assert.equal(report.rows.find(r => r.account_id === removed)?.strategyVersion, 'v3')
    assert.equal(report.rows.some(r => r.account_id === empty), false)
    assert.equal(report.rows.find(r => r.account_id === id('History active'))?.enabled, true)
    assert.equal(e.activeAccounts().some(a => a.account.id === stopped || a.account.id === removed), false)
    assert.equal((rawDb.prepare('SELECT is_active FROM accounts WHERE id = ?').get(stopped) as any).is_active, 'false')
    const L = await import('./ledger.js')
    const { reportingCurve } = await import('./routes.js')
    L.openPosition(stopped, { kind: 'open', symbol: 'BTC', side: 'LONG', leverage: 1, margin: 100,
      notional: 100, quantity: 1, stopLoss: 90, takeProfit: null, reason: '' }, 100, { feeRate: .001, slippageBps: 0 })
    L.closePosition(stopped, 'BTC', 110, 'disabled', { feeRate: .001, slippageBps: 0 })
    const history = e.reportingAccounts().find(a => a.account.id === stopped)!
    const curve = reportingCurve(history, [{ ts: t, equity: 10000 }])
    assert.equal(curve.length, 2)
    assert.equal(curve[1]!.equity, L.accountEquity(stopped, {}).equity)
    assert.deepEqual(reportingCurve(history, [], Date.now() + 10000), [])

  } finally { setArenaEngine(null) }
})
