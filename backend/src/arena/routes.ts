/** Arena HTTP API + a self-contained dashboard page at /arena. */
import fs from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import { fetchEmaSignal } from './ema-market.js'
import { EMA_FILTER_VERSION, EMA_RULES_VERSION, EMA_FILTER_SYSTEM, emaFilterUser, parseEmaVerdict } from './ema-filter.js'
import { BACKEND_ROOT, apiKeyEnvStatus, loadArenaConfig, resolveApiKey, saveModelsToFile } from './config.js'
import { setModelEnabled, upsertModel } from './models.js'
import { chat } from './llm.js'
import { fetchMarketSnapshot } from './market.js'
import { buildSystemPrompt, buildUserPrompt, parseDecision } from './prompt.js'
import { getArenaEngine, type ArenaAccount } from './engine.js'
import { accountEquity } from './ledger.js'
import { fetchPrices, fetchTickerSummary } from './market.js'
import {
  firstSnapshotTs,
  getAccountState,
  getDecisionRaw,
  listClosedTrades,
  listClosedTradesPage,
  listDecisionsPage,
  listEquitySnapshots,
  listEquitySnapshotsBucketed,
  listOutcomes,
  listPositionMeta,
  tokenUsage,
  tradingCostTotals,
} from './store.js'
import { summarizeOutcomes } from './outcomes.js'
import { roundTripCostPct } from './prompt.js'
import { computeMetrics, liveReadiness, tradeStats, observationSignal, matchedBenchmarkReturn } from './metrics.js'
import { unrealizedPnl } from './risk.js'
import { portfolioDiagnostics, tradingCostDiagnostics, modelCostDiagnostics } from './diagnostics.js'

export const arenaRoutes = new Hono()

arenaRoutes.onError((err, c) => c.json({ detail: err.message }, 400))

/** Clamp a `?limit=` query to a sane range (public endpoints must not allow huge scans). */
function limitParam(v: string | undefined, def: number, max: number): number {
  const n = Math.floor(Number(v ?? def))
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def
}

let priceCache: { ts: number; prices: Record<string, number> } = { ts: 0, prices: {} }
async function prices(symbols: string[]): Promise<Record<string, number>> {
  if (Date.now() - priceCache.ts > 10_000) {
    try {
      priceCache = { ts: Date.now(), prices: await fetchPrices(symbols) }
    } catch {
      /* keep stale prices */
    }
  }
  return priceCache.prices
}

function requireEngine() {
  const e = getArenaEngine()
  if (!e) throw new Error('arena mode is not enabled (create backend/arena.config.json)')
  return e
}

/**
 * Tiny TTL cache for the expensive public reads. The leaderboard scans every
 * account's trades and snapshots, and every open dashboard polls it, so many
 * viewers would otherwise multiply that work. Cleared on any model change.
 */
const cache = new Map<string, { ts: number; value: unknown }>()
export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T> | T, now = Date.now()): Promise<T> {
  const hit = cache.get(key)
  if (hit && now - hit.ts < ttlMs) return hit.value as T
  const value = await fn()
  cache.set(key, { ts: now, value })
  return value
}
export const clearCache = () => cache.clear()

/** Pick a bucket so a curve has at most `maxPoints` points (never finer than the snapshot interval). */
export function curveBucketMs(sinceTs: number, now: number, snapshotMs: number, maxPoints: number): number {
  const span = Math.max(0, now - sinceTs)
  const b = Math.ceil(span / Math.max(1, maxPoints))
  return b <= snapshotMs ? 0 : b
}

/** Clamp a non-negative integer query param. */
function intParam(v: string | undefined, def: number, min: number, max: number): number {
  const n = Math.floor(Number(v ?? def))
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : def
}

/** Leaderboard includes inactive arena accounts with history (cached 15 s). */
arenaRoutes.get('/leaderboard', async (c) => c.json(await cached('leaderboard', 15_000, buildLeaderboard)))

/** Ticker strip: last price and 24h change of the configured symbols (display only, never in prompts). */
arenaRoutes.get('/market', async (c) => {
  const engine = requireEngine()
  return c.json(await cached('market', 10_000, async () => ({ ts: Date.now(), symbols: await fetchTickerSummary(engine.cfg.symbols) })))
})

/** Include the final administrative close, which may happen between snapshots. */
export function reportingCurve(a: ArenaAccount, curve: { ts: number; equity: number }[], sinceTs = 0) {
  if (a.account.isActive === 'true' || listPositionMeta(a.account.id).length) return curve
  const last = listClosedTrades(a.account.id, 1)[0]
  if (!last || last.closed_at < sinceTs || last.closed_at <= (curve.at(-1)?.ts ?? 0)) return curve
  return [...curve, { ts: last.closed_at, equity: accountEquity(a.account.id, {}).equity }]
}

export async function buildLeaderboard(priceOverride?: Record<string, number>) {
  const engine = requireEngine()
  const symbols = engine.cfg.symbols
  const px = priceOverride ?? await prices([...new Set([...symbols, 'BTC'])])
  const now = Date.now()
  const activeModels = engine.activeAccounts().flatMap(a => a.modelCfg ? [a.modelCfg] : [])
  const base = engine.reportingAccounts().map((a) => {
    const id = a.account.id
    const { equity, cash } = accountEquity(id, px)
    const trades = listClosedTrades(id, 10_000)
    const curve = reportingCurve(a, listEquitySnapshots(id))
    const m = computeMetrics(a.account.initialCapital, equity, curve, trades)
    const ts = tradeStats(trades)
    const st = getAccountState(id)
    const usage = tokenUsage(id)
    const positions = listPositionMeta(id)
    const openPnl = positions.reduce(
      (s, p) => s + unrealizedPnl(p.side, p.quantity, p.entry_price, px[p.symbol] ?? p.entry_price) - p.funding_paid,
      0,
    )
    const started = firstSnapshotTs(id)
    const enabled = a.account.isActive === 'true'
    const lastDecision = listDecisionsPage([id], null, 1)[0]
    const endedAt = enabled ? null : Math.max(curve.at(-1)?.ts ?? 0, lastDecision?.ts ?? 0, ...trades.map(t => t.closed_at)) || null
    return {
      account_id: id,
      enabled,
      endedAt,
      name: a.account.name,
      kind: a.kind,
      model: a.strategy,
      strategyVersion: a.kind === 'llm' ? (a.modelCfg?.strategy ?? a.strategyVersion ?? 'v1') : a.strategy === EMA_RULES_VERSION ? EMA_RULES_VERSION : null,
      equity,
      cash,
      totalPnl: equity - a.account.initialCapital,
      unrealizedPnl: openPnl,
      halted: !!st?.halted,
      halted_reason: st?.halted_reason ?? null,
      open_positions: positions.length,
      llm_calls: usage.calls,
      llm_errors: usage.errors,
      errorRatePct: usage.calls ? (usage.errors / usage.calls) * 100 : null,
      tokens: usage.prompt + usage.completion,
      startedAt: started,
      runDays: started ? ((endedAt ?? now) - started) / 86_400_000 : 0,
      portfolio: portfolioDiagnostics(positions, px, equity, { feeRate: engine.cfg.takerFeeRate, slippageBps: engine.cfg.risk.slippageBps }, priceCache.ts, now),
      costs: tradingCostDiagnostics(tradingCostTotals(id), engine.cfg.risk.slippageBps),
      modelCosts: enabled && a.modelCfg ? modelCostDiagnostics(a.modelCfg, activeModels, engine.cfg.reporting.modelBilling, usage) : null,
      ...m,
      ...ts,
    }
  })
  const btc = base.find((r) => r.model === 'buy_hold_btc')
  const btcCurve = btc ? listEquitySnapshots(btc.account_id) : []
  const ref = btc?.returnPct ?? null
  const rows = base.map((r) => {
    const benchmarkEquity = r.endedAt == null ? btc?.equity : [...btcCurve].reverse().find(p => p.ts <= r.endedAt!)?.equity
    const benchmarkReturn = benchmarkEquity != null && btc ? (benchmarkEquity / engine.cfg.initialCapital - 1) * 100 : r.enabled ? ref : null
    const excessPct = benchmarkReturn == null ? null : r.returnPct - benchmarkReturn
    const readiness =
      r.kind === 'llm' && r.enabled
        ? liveReadiness({
            runDays: r.runDays,
            trades: r.trades,
            excessPct,
            profitFactor: r.profitFactor,
            maxDrawdownPct: r.maxDrawdownPct,
            expectancy: r.expectancy,
            tStat: r.tStat,
            errorRatePct: r.errorRatePct,
          })
        : null
    const matched = benchmarkEquity != null ? matchedBenchmarkReturn(btcCurve, r.startedAt, benchmarkEquity) : null
    const observation = r.kind === 'llm' ? {
      ...observationSignal({ ...r, matchedExcessPct: matched ? r.returnPct - matched.returnPct : null }),
      benchmarkStartTs: matched?.startTs ?? null,
    } : null
    return { ...r, excessPct, readiness, observation }
  })
  rows.sort((x, y) => y.equity - x.equity)
  return { ts: Date.now(), initial_capital: engine.cfg.initialCapital, rows }
}

/**
 * Trade outcome evaluation per account: what price did around each trade
 * (MFE/MAE, after-exit moves). Only trades closed 4h+ ago are evaluated.
 */
arenaRoutes.get('/outcomes', async (c) => c.json(await cached('outcomes', 60_000, buildOutcomes)))

function buildOutcomes() {
  const engine = requireEngine()
  const rt = roundTripCostPct(engine.cfg.takerFeeRate, engine.cfg.risk.slippageBps) * 100
  const all = listOutcomes()
  const accs = engine.reportingAccounts().filter((a) => a.kind === 'llm')
  const pending = (id: number) => listClosedTrades(id, 10_000).length - all.filter((o) => o.account_id === id).length
  const rows = accs.map((a) => ({
    account_id: a.account.id,
    name: a.account.name,
    enabled: a.account.isActive === 'true',
    strategyVersion: a.modelCfg?.strategy ?? a.strategyVersion ?? 'v1',
    pending: Math.max(0, pending(a.account.id)),
    ...summarizeOutcomes(all.filter((o) => o.account_id === a.account.id), rt),
  }))
  const ids = new Set(accs.map((a) => a.account.id))
  const byVersion = (['v1', 'v2', 'v3', 'v3.1', EMA_FILTER_VERSION] as const).map((v) => {
    const vid = new Set(accs.filter((a) => (a.modelCfg?.strategy ?? a.strategyVersion ?? 'v1') === v).map((a) => a.account.id))
    return { version: v, accounts: vid.size, ...summarizeOutcomes(all.filter((o) => vid.has(o.account_id)), rt) }
  })
  return {
    roundTripPct: rt,
    total: summarizeOutcomes(all.filter((o) => ids.has(o.account_id)), rt),
    byVersion,
    rows,
  }
}

/**
 * Equity curves for all accounts. ?hours=72 (0 = all) &points=400: long ranges
 * are thinned to about `points` per account (last snapshot of each bucket).
 */
arenaRoutes.get('/curves', async (c) => {
  const engine = requireEngine()
  const hours = Math.max(0, Number(c.req.query('hours') ?? 0) || 0)
  const maxPoints = intParam(c.req.query('points'), 400, 50, 2000)
  return c.json(
    await cached(`curves:${hours}:${maxPoints}`, 30_000, () => {
      const now = Date.now()
      const accs = engine.reportingAccounts()
      const since = hours > 0 ? now - hours * 3_600_000 : Math.min(now, ...accs.map((a) => firstSnapshotTs(a.account.id) ?? now))
      const bucket = curveBucketMs(since, now, engine.cfg.snapshotIntervalMinutes * 60_000, maxPoints)
      return accs.map((a) => ({
        account_id: a.account.id,
        name: a.account.name,
        kind: a.kind,
        enabled: a.account.isActive === 'true',
        points: reportingCurve(a, listEquitySnapshotsBucketed(a.account.id, hours > 0 ? since : 0, bucket), hours > 0 ? since : 0),
      }))
    }),
  )
})

arenaRoutes.get('/positions', async (c) => {
  const engine = requireEngine()
  const px = await prices(engine.cfg.symbols)
  const now = Date.now()
  return c.json(
    engine.activeAccounts().flatMap((a) =>
      listPositionMeta(a.account.id).map((m) => {
        const p = px[m.symbol] ?? m.entry_price
        return {
          account: a.account.name,
          symbol: m.symbol,
          side: m.side,
          leverage: m.leverage,
          margin: m.margin,
          entry_price: m.entry_price,
          price: p,
          stop_loss: m.stop_loss,
          take_profit: m.take_profit,
          unrealized_pnl: unrealizedPnl(m.side, m.quantity, m.entry_price, p) - m.funding_paid,
          held_minutes: (now - m.opened_at) / 60_000,
          entry_reason: m.entry_reason,
          invalidation: m.invalidation ?? null,
        }
      }),
    ),
  )
})

/**
 * Closed trades. Paged: ?page=1&size=20[&account_id=] returns {total, page, size, rows}.
 * Legacy: ?limit=100 returns a plain array of the newest trades (kept for scripts).
 */
arenaRoutes.get('/trades', (c) => {
  const engine = requireEngine()
  const names = new Map(engine.reportingAccounts().map((a) => [a.account.id, a.account.name]))
  if (c.req.query('page') != null) {
    const size = intParam(c.req.query('size'), 20, 1, 100)
    const idParam = c.req.query('account_id')
    const ids = idParam ? [Number(idParam)].filter((id) => names.has(id)) : [...names.keys()]
    const first = listClosedTradesPage(ids, 0, 0).total
    const pages = Math.max(1, Math.ceil(first / size))
    const page = intParam(c.req.query('page'), 1, 1, pages)
    const { total, rows } = listClosedTradesPage(ids, (page - 1) * size, size)
    return c.json({ total, page, size, rows: rows.map((t) => ({ ...t, account: names.get(t.account_id) })) })
  }
  const all = [...names.keys()].flatMap((id) => listClosedTrades(id, 200).map((t) => ({ ...t, account: names.get(id) })))
  all.sort((x, y) => y.closed_at - x.closed_at)
  return c.json(all.slice(0, limitParam(c.req.query('limit'), 100, 500)))
})

/**
 * Decision log, newest first. ?account_id=1&limit=20&before_id=123 (cursor:
 * pass the smallest id you already have to get the next older batch).
 * raw_response is never included; use /decisions/:id/raw.
 */
arenaRoutes.get('/decisions', (c) => {
  const engine = requireEngine()
  const names = new Map(engine.reportingAccounts().map((a) => [a.account.id, a.account.name]))
  const idParam = c.req.query('account_id')
  const ids = idParam ? [Number(idParam)].filter((id) => names.has(id)) : [...names.keys()]
  const before = c.req.query('before_id')
  const rows = listDecisionsPage(ids, before ? Number(before) || null : null, limitParam(c.req.query('limit'), 50, 200))
  return c.json(
    rows.map((r) => ({
      ...r,
      account: names.get(r.account_id),
      actions: r.actions_json ? JSON.parse(r.actions_json) : [],
      results: r.results_json ? JSON.parse(r.results_json) : null,
      actions_json: undefined,
      results_json: undefined,
    })),
  )
})

arenaRoutes.get('/decisions/:id/raw', (c) => {
  const engine = requireEngine()
  const row = getDecisionRaw(Number(c.req.param('id')))
  // Only accounts shown on the dashboard; disabled/legacy accounts stay hidden.
  const visible = row && engine.activeAccounts().some((a) => a.account.id === row.account_id)
  return visible ? c.text(row.raw_response ?? '') : c.json({ detail: 'not found' }, 404)
})

/** Manually trigger a decision cycle (useful for testing). */
arenaRoutes.post('/run-cycle', async (c) => {
  const engine = requireEngine()
  await engine.runCycle()
  await engine.snapshotEquity()
  clearCache()
  return c.json({ ok: true })
})

arenaRoutes.get('/config', (c) => {
  const engine = requireEngine()
  // Never expose keys: config only holds env var names anyway.
  return c.json(engine.cfg)
})

// ------------------------------------------------------------ model management

/** Serialise config edits so two quick clicks can't interleave file writes. */
let editLock: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = editLock.then(fn, fn)
  editLock = run.catch(() => undefined)
  return run
}

async function commitModels(models: Parameters<typeof saveModelsToFile>[0]) {
  const engine = requireEngine()
  saveModelsToFile(models)
  const notes = await engine.applyModels(loadArenaConfig()!.models)
  clearCache()
  return { ok: true, notes }
}

arenaRoutes.get('/models', (c) => {
  const engine = requireEngine()
  const ids = new Map(engine.activeAccounts().map((a) => [a.account.name, a.account.id]))
  return c.json({
    models: engine.cfg.models.map((m) => ({
      ...m,
      account_id: ids.get(m.name) ?? null,
      keySet: m.model === 'mock' || !!resolveApiKey(`env:${m.apiKeyEnv}`),
    })),
    keyEnvs: apiKeyEnvStatus(),
  })
})

/** Add (no originalName) or edit (originalName = current name) a model. */
arenaRoutes.post('/models', async (c) => {
  const body = (await c.req.json()) as { originalName?: string; model: Record<string, unknown> }
  return c.json(await withLock(() => commitModels(upsertModel(requireEngine().cfg.models, body))))
})

arenaRoutes.post('/models/toggle', async (c) => {
  const { name, enabled } = (await c.req.json()) as { name: string; enabled: boolean }
  return c.json(await withLock(() => commitModels(setModelEnabled(requireEngine().cfg.models, name, !!enabled))))
})

/** One real decision request with an empty account; nothing is traded or stored. */
arenaRoutes.post('/models/test', async (c) => {
  const engine = requireEngine()
  const body = (await c.req.json()) as { model: Record<string, unknown> }
  const [m] = upsertModel([], { model: { ...body.model, name: String(body.model?.name || '测试') } })
  const cfg = engine.cfg
  if (m!.strategy === EMA_FILTER_VERSION) {
    try {
      const signal = await fetchEmaSignal()
      if (!signal) throw new Error('没有新鲜完整的已收盘 BTC 1h 行情')
      const funding = (await fetchMarketSnapshot(['BTC'])).symbols.BTC?.fundingRate ?? null
      const res = await chat({ baseUrl: m!.baseUrl, apiKey: resolveApiKey(`env:${m!.apiKeyEnv}`), model: m!.model,
        system: EMA_FILTER_SYSTEM, user: emaFilterUser(signal, funding, roundTripCostPct(cfg.takerFeeRate, cfg.risk.slippageBps) * 100),
        temperature: m!.temperature, maxTokens: m!.maxTokens, timeoutMs: m!.timeoutSeconds * 1000, extraBody: m!.extraBody })
      const verdict = parseEmaVerdict(res.text)
      return c.json({ ok: true, parsed: true, latencyMs: res.latencyMs, promptTokens: res.promptTokens,
        completionTokens: res.completionTokens, analysis: `${verdict.allow ? '放行' : '拒绝'}：${verdict.reason}`, actions: [] })
    } catch (e) { return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }) }
  }
  const snapshot = await fetchMarketSnapshot(cfg.symbols)
  const user = buildUserPrompt(snapshot, {
    equity: cfg.initialCapital, cash: cfg.initialCapital, initialCapital: cfg.initialCapital, peakEquity: cfg.initialCapital,
    minutesSinceStart: 0, invocationCount: 1, positions: [], recentTrades: [],
    ...(m!.strategy === 'v3.1' ? { confirmedSignals: true } : {}),
    ...(m!.strategy === 'v2' || m!.strategy === 'v3' || m!.strategy === 'v3.1'
      ? { memory: { lastNotes: null, last24h: { closedTrades: 0, feesAndFunding: 0, netPnl: 0, stopLossCount: 0 }, cooldowns: {},
          ...((m!.strategy === 'v3' || m!.strategy === 'v3.1')
            ? { locks: {}, minStopPct: engine.v3Rules(-1, Date.now(), snapshot).minStopPct }
            : { minStopPct: engine.v2Rules(-1, Date.now(), snapshot).minStopPct }) } }
      : {}),
  })
  try {
    const res = await chat({
      baseUrl: m!.baseUrl, apiKey: resolveApiKey(`env:${m!.apiKeyEnv}`), model: m!.model,
      system: buildSystemPrompt(
        cfg.symbols, cfg.risk, cfg.reasonLanguage,
        engine.promptInfo(m!.strategy),
      ), user,
      temperature: m!.temperature, maxTokens: m!.maxTokens, timeoutMs: m!.timeoutSeconds * 1000, extraBody: m!.extraBody,
    })
    const base = { ok: true, latencyMs: res.latencyMs, promptTokens: res.promptTokens, completionTokens: res.completionTokens }
    try {
      const d = parseDecision(res.text)
      return c.json({ ...base, parsed: true, analysis: d.analysis, actions: d.actions })
    } catch (e) {
      return c.json({ ...base, parsed: false, error: String(e), preview: res.text.slice(0, 800) })
    }
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) })
  }
})

export function arenaDashboardHtml(): string {
  // Lives outside src/ so it works for both `tsx` (dev) and compiled `dist/`.
  return fs.readFileSync(path.join(BACKEND_ROOT, 'arena-dashboard.html'), 'utf8')
}
