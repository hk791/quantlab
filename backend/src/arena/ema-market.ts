/** Fetch once per cycle for both EF1 accounts; cutoff is fixed before network I/O. */
import { fetchCandlesSince } from './market.js'
import { buildEmaSignal, EMA_HOUR_MS, type EmaSignal } from './ema-filter.js'

export async function fetchEmaSignal(): Promise<EmaSignal | null> {
  const start = Date.now()
  return buildEmaSignal(await fetchCandlesSince('BTC', '1h', start - 122 * EMA_HOUR_MS, 123), start)
}
