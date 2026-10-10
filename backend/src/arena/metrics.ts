/** Performance metrics computed from equity snapshots and closed trades. Pure. */

export interface Metrics {
  returnPct: number
  maxDrawdownPct: number
  /** Annualised Sharpe from snapshot returns (rf = 0). null if too few points. */
  sharpe: number | null
  trades: number
  winRatePct: number | null
  profitFactor: number | null
  avgTradePnl: number | null
  totalFees: number
  totalFunding: number
}

const YEAR_MS = 365 * 24 * 3_600_000

export function maxDrawdown(equity: number[]): number {
  let peak = -Infinity
  let mdd = 0
  for (const e of equity) {
    peak = Math.max(peak, e)
    if (peak > 0) mdd = Math.max(mdd, (peak - e) / peak)
  }
  return mdd
}

/** Annualising a few hours of 15-minute returns gives absurd numbers (30+), so require a minimum span. */
export const SHARPE_MIN_SPAN_MS = 7 * 24 * 3_600_000

export function sharpe(points: { ts: number; equity: number }[]): number | null {
  if (points.length < 10) return null
  if (points[points.length - 1]!.ts - points[0]!.ts < SHARPE_MIN_SPAN_MS) return null
  const rets: number[] = []
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!.equity
    if (prev > 0) rets.push(points[i]!.equity / prev - 1)
  }
  if (rets.length < 2) return null
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1)
  const sd = Math.sqrt(variance)
  if (sd === 0) return null
  const spanMs = points[points.length - 1]!.ts - points[0]!.ts
  const periodsPerYear = spanMs > 0 ? (YEAR_MS / spanMs) * rets.length : 0
  return (mean / sd) * Math.sqrt(periodsPerYear)
}

export function computeMetrics(
  initialCapital: number,
  currentEquity: number,
  curve: { ts: number; equity: number }[],
  trades: { pnl: number; fees: number; funding: number }[],
): Metrics {
  const equitySeries = [initialCapital, ...curve.map((p) => p.equity), currentEquity]
  const wins = trades.filter((t) => t.pnl > 0)
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0)
  const grossLoss = -trades.filter((t) => t.pnl < 0).reduce((s, t) => s + t.pnl, 0)
  return {
    returnPct: ((currentEquity - initialCapital) / initialCapital) * 100,
    maxDrawdownPct: maxDrawdown(equitySeries) * 100,
    sharpe: sharpe(curve),
    trades: trades.length,
    winRatePct: trades.length ? (wins.length / trades.length) * 100 : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : trades.length ? null : null,
    avgTradePnl: trades.length ? trades.reduce((s, t) => s + t.pnl, 0) / trades.length : null,
    totalFees: trades.reduce((s, t) => s + t.fees, 0),
    totalFunding: trades.reduce((s, t) => s + t.funding, 0),
  }
}

// ---------------------------------------------------------------- trade statistics

export interface TradeStats {
  /** Sum of net trade PnL (already after fees and funding). */
  realizedPnl: number
  /** Realized PnL before fees and funding, to show how much costs eat. */
  grossPnl: number
  avgWin: number | null
  avgLoss: number | null
  /** Mean net PnL per trade. */
  expectancy: number | null
  /** t-statistic of mean trade PnL (mean / (sd / sqrt(n))). null below 5 trades. */
  tStat: number | null
  maxConsecLosses: number
  stopLossRatePct: number | null
}

/** Trades may be in any order; consecutive-loss streak uses closed_at when present. */
export function tradeStats(
  trades: { pnl: number; fees: number; funding: number; close_reason?: string; closed_at?: number }[],
): TradeStats {
  const n = trades.length
  const pnls = trades.map((t) => t.pnl)
  const realizedPnl = pnls.reduce((a, b) => a + b, 0)
  const grossPnl = trades.reduce((s, t) => s + t.pnl + t.fees + t.funding, 0)
  const wins = pnls.filter((p) => p > 0)
  const losses = pnls.filter((p) => p < 0)
  const mean = n ? realizedPnl / n : null
  let tStat: number | null = null
  if (n >= 5 && mean != null) {
    const sd = Math.sqrt(pnls.reduce((s, p) => s + (p - mean) ** 2, 0) / (n - 1))
    tStat = sd > 0 ? mean / (sd / Math.sqrt(n)) : null
  }
  let streak = 0
  let maxConsecLosses = 0
  for (const t of [...trades].sort((a, b) => (a.closed_at ?? 0) - (b.closed_at ?? 0))) {
    streak = t.pnl < 0 ? streak + 1 : 0
    maxConsecLosses = Math.max(maxConsecLosses, streak)
  }
  return {
    realizedPnl,
    grossPnl,
    avgWin: wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : null,
    avgLoss: losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : null,
    expectancy: mean,
    tStat,
    maxConsecLosses,
    stopLossRatePct: n ? (trades.filter((t) => t.close_reason === 'stop_loss').length / n) * 100 : null,
  }
}

// ---------------------------------------------------------------- live-trading readiness

export interface ReadinessInput {
  runDays: number
  trades: number
  /** Return minus the BTC buy-and-hold return, in percentage points. */
  excessPct: number | null
  profitFactor: number | null
  maxDrawdownPct: number
  expectancy: number | null
  tStat: number | null
  /** Share of decision calls that errored (timeout, parse failure, HTTP error). */
  errorRatePct: number | null
}

export interface ReadinessGate {
  key: keyof ReadinessInput
  label: string
  target: string
  value: number | null
  pass: boolean
}

/**
 * Minimum evidence before even a small live allocation. Deliberately strict:
 * a model must clear every gate; partial passes are not a "maybe".
 */
export const READINESS_RULES: { key: keyof ReadinessInput; label: string; target: string; ok: (v: number) => boolean }[] = [
  { key: 'runDays', label: '运行天数', target: '≥ 21 天', ok: (v) => v >= 21 },
  { key: 'trades', label: '平仓笔数', target: '≥ 50 笔', ok: (v) => v >= 50 },
  { key: 'excessPct', label: '跑赢 BTC 持有', target: '> 0 个百分点', ok: (v) => v > 0 },
  { key: 'profitFactor', label: '盈亏比', target: '≥ 1.3', ok: (v) => v >= 1.3 },
  { key: 'expectancy', label: '每笔期望', target: '> $0（已扣成本）', ok: (v) => v > 0 },
  { key: 'tStat', label: '统计显著性 t 值', target: '≥ 2', ok: (v) => v >= 2 },
  { key: 'maxDrawdownPct', label: '最大回撤', target: '≤ 15%', ok: (v) => v <= 15 },
  { key: 'errorRatePct', label: '决策出错率', target: '≤ 5%', ok: (v) => v <= 5 },
]

export function liveReadiness(input: ReadinessInput): { gates: ReadinessGate[]; passed: number; ready: boolean } {
  const gates = READINESS_RULES.map((r) => {
    const value = input[r.key]
    return { key: r.key, label: r.label, target: r.target, value, pass: value != null && Number.isFinite(value) && r.ok(value) }
  })
  const passed = gates.filter((g) => g.pass).length
  return { gates, passed, ready: passed === gates.length }
}

/** Observation signals only: these do not change an account's trading/risk state. */
export function observationSignal(input: {
  runDays: number; trades: number; expectancy: number | null; profitFactor: number | null;
  maxDrawdownPct: number; matchedExcessPct: number | null;
}) {
  const stageReady = input.runDays >= 7 && input.trades >= 50
  const reasons: string[] = []
  if (input.maxDrawdownPct >= 15) reasons.push('最大回撤达到 15% 风险停用线')
  if (stageReady && input.expectancy != null && input.expectancy < 0 &&
    input.profitFactor != null && input.profitFactor < 0.7 &&
    input.matchedExcessPct != null && input.matchedExcessPct < 0) {
    reasons.push('已满 7 天 / 50 笔，每笔净期望为负、利润因子低于 0.7，且落后同窗口 BTC 持有')
  }
  const stop = reasons.length > 0
  return {
    status: stop ? 'stop' : input.maxDrawdownPct >= 10 ? 'warning' : stageReady ? 'observe' : 'collecting',
    label: stop ? '达到停用线' : input.maxDrawdownPct >= 10 ? '回撤预警' : stageReady ? '继续观察' : '样本积累中',
    stop, stageReady, reasons,
    matchedExcessPct: input.matchedExcessPct,
    daysLeft: Math.max(0, 7 - input.runDays), tradesLeft: Math.max(0, 50 - input.trades),
    manual: true,
  }
}

/** Match BTC to the account's own first snapshot, never its earlier inception. */
export function matchedBenchmarkReturn(
  curve: { ts: number; equity: number }[], startedAt: number | null, currentEquity: number,
): { returnPct: number; startTs: number } | null {
  if (startedAt == null || !Number.isFinite(currentEquity) || currentEquity <= 0) return null
  const start = [...curve].reverse().find((p) => p.ts <= startedAt)
  if (!start || startedAt - start.ts > 10 * 60_000 || start.equity <= 0) return null
  return { returnPct: (currentEquity / start.equity - 1) * 100, startTs: start.ts }
}
