/**
 * Support factor — port of `factors/support.py` (pandas -> nodejs-polars).
 */
import pl from 'nodejs-polars'
import type { Factor, FactorHistory } from '../types/factor.js'

/** Configuration */
export const DEFAULT_WINDOW_SIZE = 30

interface Candle {
  open: number
  close: number
  high: number
  low: number
}

/**
 * Days since the candle with the largest real body within the specified window.
 *
 * Computes relative index within the window so that daysFromLongest is always
 * a positive integer between 1 and windowLen - 1.
 *
 * @param closes  Close prices of the whole sorted history.
 * @param opens   Open prices of the whole sorted history.
 * @param windowStart Absolute index of the window's first row.
 */
export function calculateDaysFromLongestCandle(
  closes: number[],
  opens: number[],
  windowStart: number,
): number {
  const windowLen = closes.length - windowStart
  if (windowLen < 2) return 0

  const firstClose = closes[windowStart]!

  let maxRelIdx = 1
  let maxBody = -Infinity
  for (let j = windowStart + 1; j < closes.length; j++) {
    const body = (Math.abs(closes[j]! - opens[j]!) * 100) / firstClose
    if (body >= maxBody) {
      maxBody = body
      maxRelIdx = j - windowStart
    }
  }

  return windowLen - maxRelIdx
}

/**
 * Calculate support factor using days from longest candle.
 *
 * @param history Historical price data
 * @param topSpot Optional spot data (unused)
 * @param windowSize Number of days to look back for analysis
 */
export function computeSupport(
  history: FactorHistory,
  _topSpot?: pl.DataFrame | null,
  windowSize: number = 60,
): pl.DataFrame {
  const symbols: string[] = []
  const supports: number[] = []
  const scores: number[] = []
  const daysCol: number[] = []

  for (const [code, df] of Object.entries(history)) {
    // Require at least windowSize + 1 days (extra day for previous close)
    if (!df || df.height === 0 || df.height < windowSize + 1) continue

    const sorted = df.sort('Date')

    const closes = sorted.getColumn('Close').toArray() as number[]
    const opens = sorted.getColumn('Open').toArray() as number[]
    const highs = sorted.getColumn('High').toArray() as number[]
    const lows = sorted.getColumn('Low').toArray() as number[]

    const n = sorted.height
    // We need windowSize + 1 days for proper previous close reference
    const actualWindow = Math.min(windowSize, n - 1)

    // Extended window = last (actualWindow + 1) rows
    const windowStart = n - (actualWindow + 1)
    const daysFromLongest = calculateDaysFromLongestCandle(
      closes,
      opens,
      windowStart,
    )

    // Support factor: days from longest candle
    // (more distant longest candle = better support)
    const supportFactorBase =
      actualWindow > 1 ? daysFromLongest / (actualWindow - 1) : 0

    // Window used for the price-ratio calculation: last actualWindow candles
    const candles: Candle[] = []
    for (let i = n - actualWindow; i < n; i++) {
      candles.push({
        open: opens[i]!,
        close: closes[i]!,
        high: highs[i]!,
        low: lows[i]!,
      })
    }

    // Price ratio: (Prev Open - Prev Close)/(Prev Low - Curr Low) scaled
    let priceRatio = 1.0
    if (candles.length >= 2) {
      const yesterday = candles[candles.length - 2]!
      const today = candles[candles.length - 1]!
      const denominator = yesterday.low - today.low
      priceRatio =
        denominator !== 0
          ? ((yesterday.open - yesterday.close) * 2) / denominator
          : 1.0
    }

    // Combine time factor with price movement; higher suggests stronger support
    const supportFactor = supportFactorBase * priceRatio
    const normalized = 1 / (1 + Math.exp(-supportFactor))

    symbols.push(code)
    supports.push(supportFactor)
    scores.push(normalized)
    daysCol.push(daysFromLongest)
  }

  if (symbols.length === 0) return pl.DataFrame({})

  return pl.DataFrame({
    Symbol: symbols,
    Support: supports,
    'Support Score': scores,
    [`Days From Longest Candle_${windowSize}`]: daysCol,
  })
}

/** Wrapper function that uses the default window size. */
export function computeSupportWithDefaultWindow(
  history: FactorHistory,
  topSpot?: pl.DataFrame | null,
): pl.DataFrame {
  const result = computeSupport(history, topSpot, DEFAULT_WINDOW_SIZE)

  // Rename the dynamic column to a fixed name for the factor definition
  const dynamicCol = `Days From Longest Candle_${DEFAULT_WINDOW_SIZE}`
  if (result.columns.includes(dynamicCol)) {
    return result.rename({ [dynamicCol]: 'Days From Longest Candle' })
  }

  return result
}

export const SUPPORT_FACTOR: Factor = {
  id: 'support',
  name: 'Support',
  description: `Support strength based on distance from largest candle within ${DEFAULT_WINDOW_SIZE} days; higher is better`,
  columns: [
    { key: 'Support', label: 'Support', type: 'number', sortable: true },
    {
      key: 'Support Score',
      label: 'Support Score',
      type: 'score',
      sortable: true,
    },
    {
      key: 'Days From Longest Candle',
      label: `${DEFAULT_WINDOW_SIZE} Days From Longest Candle`,
      type: 'number',
      sortable: true,
    },
  ],
  compute: (history, topSpot) => computeSupportWithDefaultWindow(history, topSpot),
}

export const MODULE_FACTORS: Factor[] = [SUPPORT_FACTOR]
