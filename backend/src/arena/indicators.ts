/**
 * Pure technical-indicator helpers (no I/O) so they are easy to unit test.
 * All functions take oldest -> newest arrays and return arrays of the same
 * length, padded with NaN where the indicator is not yet defined.
 */

export function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN)
  if (values.length < period) return out
  const k = 2 / (period + 1)
  // Seed with the SMA of the first `period` values
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period
  out[period - 1] = prev
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k)
    out[i] = prev
  }
  return out
}

/** Wilder's RSI. */
export function rsi(values: number[], period = 14): number[] {
  const out = new Array<number>(values.length).fill(NaN)
  if (values.length <= period) return out
  let gain = 0
  let loss = 0
  for (let i = 1; i <= period; i++) {
    const d = values[i]! - values[i - 1]!
    if (d >= 0) gain += d
    else loss -= d
  }
  let avgGain = gain / period
  let avgLoss = loss / period
  const calc = () => (avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss))
  out[period] = calc()
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i]! - values[i - 1]!
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period
    out[i] = calc()
  }
  return out
}

export interface MacdResult {
  macd: number[]
  signal: number[]
  histogram: number[]
}

export function macd(values: number[], fast = 12, slow = 26, signalPeriod = 9): MacdResult {
  const fastE = ema(values, fast)
  const slowE = ema(values, slow)
  const line = values.map((_, i) => fastE[i]! - slowE[i]!)
  const firstValid = line.findIndex((v) => Number.isFinite(v))
  const signal = new Array<number>(values.length).fill(NaN)
  if (firstValid >= 0) {
    ema(line.slice(firstValid), signalPeriod).forEach((v, i) => {
      signal[firstValid + i] = v
    })
  }
  const histogram = line.map((v, i) => v - signal[i]!)
  return { macd: line, signal, histogram }
}

/** Wilder's Average True Range. */
export function atr(high: number[], low: number[], close: number[], period = 14): number[] {
  const n = close.length
  const out = new Array<number>(n).fill(NaN)
  if (n <= period) return out
  const tr: number[] = [high[0]! - low[0]!]
  for (let i = 1; i < n; i++) {
    tr.push(
      Math.max(
        high[i]! - low[i]!,
        Math.abs(high[i]! - close[i - 1]!),
        Math.abs(low[i]! - close[i - 1]!),
      ),
    )
  }
  let prev = tr.slice(1, period + 1).reduce((a, b) => a + b, 0) / period
  out[period] = prev
  for (let i = period + 1; i < n; i++) {
    prev = (prev * (period - 1) + tr[i]!) / period
    out[i] = prev
  }
  return out
}

export const last = (arr: number[]): number => arr[arr.length - 1] ?? NaN
