/**
 * Momentum factor — port of `factors/momentum.py` (pandas -> nodejs-polars).
 */
import pl from 'nodejs-polars'
import type { Factor, FactorHistory } from '../types/factor.js'

/**
 * Calculate (later-period low - earlier-period low) / longest candle.
 *
 * Mirrors pandas: sort by Date ascending, split into halves at
 * `len // 2`, take each half's minimum Low, and divide by the largest
 * absolute candle body over the whole window.
 */
export function calculateMomentumSimple(df: pl.DataFrame): number {
  if (df.height < 2) return 0.0

  // Sort by date (oldest first)
  const sorted = df.sort('Date')

  const halfIdx = Math.floor(sorted.height / 2)

  const lows = sorted.getColumn('Low').toArray() as (number | null)[]
  const closes = sorted.getColumn('Close').toArray() as (number | null)[]
  const opens = sorted.getColumn('Open').toArray() as (number | null)[]

  // Minimum price in first half / second half of the period.
  const firstHalfLow = minIgnoringNull(lows.slice(0, halfIdx))
  const secondHalfLow = minIgnoringNull(lows.slice(halfIdx))

  // Maximum daily body length (absolute |close - open|) in entire period.
  let maxDailyChange: number | null = null
  for (let i = 0; i < sorted.height; i++) {
    const c = closes[i]
    const o = opens[i]
    if (c == null || o == null) continue
    const body = Math.abs(c - o)
    if (maxDailyChange === null || body > maxDailyChange) maxDailyChange = body
  }

  // Check for invalid data (pandas: any of the three being NaN -> 0.0)
  if (firstHalfLow === null || secondHalfLow === null || maxDailyChange === null) {
    return 0.0
  }
  if (maxDailyChange === 0) return 0.0

  return (secondHalfLow - firstHalfLow) / maxDailyChange
}

/** pandas `Series.min()` skips NaN and returns NaN for an all-NaN/empty slice. */
function minIgnoringNull(values: (number | null)[]): number | null {
  let best: number | null = null
  for (const v of values) {
    if (v == null || Number.isNaN(v)) continue
    if (best === null || v < best) best = v
  }
  return best
}

/**
 * Calculate momentum factor using formula:
 * (later-period low - earlier-period low) / longest candle.
 *
 * @param history Historical price data
 * @param topSpot Optional spot data (unused)
 */
export function computeMomentum(
  history: FactorHistory,
  _topSpot?: pl.DataFrame | null,
): pl.DataFrame {
  const symbols: string[] = []
  const momentums: number[] = []
  const scores: number[] = []

  for (const [code, df] of Object.entries(history)) {
    if (!df || df.height < 2) continue

    const momentum = calculateMomentumSimple(df)
    const score = (Math.tanh(momentum) + 1) / 2

    symbols.push(code)
    momentums.push(momentum)
    scores.push(score)
  }

  if (symbols.length === 0) {
    return pl.DataFrame({})
  }

  // Sort by momentum factor from high to low
  return pl
    .DataFrame({
      Symbol: symbols,
      Momentum: momentums,
      'Momentum Score': scores,
    })
    .sort('Momentum', true)
}

export const MOMENTUM_FACTOR: Factor = {
  id: 'momentum',
  name: 'Momentum',
  description:
    'Momentum: (later-period low - earlier-period low) / longest candle, sorted descending',
  columns: [
    { key: 'Momentum', label: 'Momentum', type: 'number', sortable: true },
    {
      key: 'Momentum Score',
      label: 'Momentum Score',
      type: 'score',
      sortable: true,
    },
  ],
  compute: (history, topSpot) => computeMomentum(history, topSpot),
}

export const MODULE_FACTORS: Factor[] = [MOMENTUM_FACTOR]
