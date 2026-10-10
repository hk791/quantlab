/**
 * Trade outcome evaluation ("what happened around each trade"), computed
 * after the fact from 5-minute candles. Pure functions only; the engine
 * fetches candles and persists the results in `arena_trade_outcomes`.
 *
 * All percentages are signed so that positive = in the trade's favour
 * (price up for longs, down for shorts). This lets us answer questions
 * like "are stops too tight?" (stopped out, then price came back) and
 * "are models closing too early?" (closed, then price kept going their way).
 */
import type { Candle } from './market.js'

export const OUTCOME_BAR_MS = 5 * 60_000
export const POST_EXIT_MS = 4 * 3_600_000

export interface OutcomeInput {
  side: string
  entry_price: number
  exit_price: number
  opened_at: number
  closed_at: number
}

export interface OutcomeFields {
  ret_15m_pct: number | null
  ret_1h_pct: number | null
  ret_4h_pct: number | null
  mfe_pct: number | null
  mae_pct: number | null
  post_exit_4h_pct: number | null
  /** 1 if, within 4h after the exit, price traded back through the entry price in the trade's favour. */
  reclaimed_entry_4h: number | null
}

/** Price at time t: open of the first bar starting at/after t, null if the data does not reach t. */
export function priceAt(candles: Candle[], t: number): number | null {
  for (const c of candles) if (c.ts >= t) return c.open
  return null
}

export function computeOutcome(t: OutcomeInput, candles: Candle[]): OutcomeFields {
  const dir = t.side === 'SHORT' ? -1 : 1
  const fav = (px: number | null, ref: number) => (px == null || !(ref > 0) ? null : ((px - ref) / ref) * 100 * dir)
  const sorted = [...candles].sort((a, b) => a.ts - b.ts)

  // Excursions while the position was open (bars overlapping [opened_at, closed_at]).
  const held = sorted.filter((c) => c.ts + OUTCOME_BAR_MS > t.opened_at && c.ts < t.closed_at)
  let mfe: number | null = null
  let mae: number | null = null
  if (held.length) {
    const hi = Math.max(...held.map((c) => c.high))
    const lo = Math.min(...held.map((c) => c.low))
    const best = dir === 1 ? hi : lo
    const worst = dir === 1 ? lo : hi
    mfe = Math.max(0, fav(best, t.entry_price)!)
    mae = Math.min(0, fav(worst, t.entry_price)!)
  }

  // After the exit: did price come back through the entry in our favour?
  const after = sorted.filter((c) => c.ts >= t.closed_at && c.ts < t.closed_at + POST_EXIT_MS)
  const lastBar = sorted[sorted.length - 1]
  const afterComplete = !!lastBar && lastBar.ts + OUTCOME_BAR_MS >= t.closed_at + POST_EXIT_MS
  let reclaimed: number | null = null
  if (after.length && afterComplete) {
    const best = dir === 1 ? Math.max(...after.map((c) => c.high)) : Math.min(...after.map((c) => c.low))
    reclaimed = fav(best, t.entry_price)! > 0 ? 1 : 0
  }

  const at = (ms: number) => fav(priceAt(sorted, t.opened_at + ms), t.entry_price)
  return {
    ret_15m_pct: at(15 * 60_000),
    ret_1h_pct: at(3_600_000),
    ret_4h_pct: at(4 * 3_600_000),
    mfe_pct: mfe,
    mae_pct: mae,
    post_exit_4h_pct: fav(priceAt(sorted, t.closed_at + POST_EXIT_MS), t.exit_price),
    reclaimed_entry_4h: reclaimed,
  }
}

// ---------------------------------------------------------------- summaries

export interface OutcomeRow extends OutcomeFields {
  account_id: number
  close_reason: string
  pnl: number
  opened_at: number
  closed_at: number
}

export interface OutcomeSummary {
  trades: number
  avgHoldHours: number | null
  avgMfePct: number | null
  avgMaePct: number | null
  /** Stop-loss exits among evaluated trades. */
  stopLosses: number
  /** Share of stop-loss exits where price came back through the entry within 4h (stop likely too tight). */
  stopReclaimPct: number | null
  /** Model-initiated closes. */
  modelCloses: number
  /** Average favourable move in the 4h after a model close (> 0 suggests closing too early). */
  modelCloseAfter4hPct: number | null
  /** Share of all trades whose MFE exceeded the round-trip cost but still ended with a net loss. */
  gaveBackPct: number | null
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const nums = (xs: (number | null)[]) => xs.filter((v): v is number => v != null && Number.isFinite(v))

export function summarizeOutcomes(rows: OutcomeRow[], roundTripPct: number): OutcomeSummary {
  const stops = rows.filter((r) => r.close_reason === 'stop_loss')
  const stopEval = nums(stops.map((r) => r.reclaimed_entry_4h))
  const modelCloses = rows.filter((r) => r.close_reason === 'model')
  const withMfe = rows.filter((r) => r.mfe_pct != null)
  return {
    trades: rows.length,
    avgHoldHours: mean(rows.map((r) => (r.closed_at - r.opened_at) / 3_600_000)),
    avgMfePct: mean(nums(rows.map((r) => r.mfe_pct))),
    avgMaePct: mean(nums(rows.map((r) => r.mae_pct))),
    stopLosses: stops.length,
    stopReclaimPct: stopEval.length ? (stopEval.filter((v) => v === 1).length / stopEval.length) * 100 : null,
    modelCloses: modelCloses.length,
    modelCloseAfter4hPct: mean(nums(modelCloses.map((r) => r.post_exit_4h_pct))),
    gaveBackPct: withMfe.length
      ? (withMfe.filter((r) => r.mfe_pct! > roundTripPct && r.pnl < 0).length / withMfe.length) * 100
      : null,
  }
}
