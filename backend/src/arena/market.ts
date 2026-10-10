/**
 * Market snapshot for the arena: prices, funding, open interest and
 * multi-timeframe indicators from Hyperliquid (public endpoints, no key).
 * Every model in a cycle receives the exact same snapshot.
 */
import ccxt from 'ccxt'
import type { hyperliquid as HyperliquidExchange } from 'ccxt'
import { atr, ema, last, macd, rsi } from './indicators.js'
import { getLogger } from '../utils/logger.js'

const logger = getLogger('arena.market')

let exchange: HyperliquidExchange | null = null
function ex(): HyperliquidExchange {
  // Only load perpetual markets: loading spot too makes the first call ~25s.
  if (!exchange) exchange = new ccxt.hyperliquid({ enableRateLimit: true, options: { fetchMarkets: { types: ['swap'] } } })
  return exchange
}

export const perp = (symbol: string) => `${symbol.toUpperCase()}/USDC:USDC`

export interface Candle {
  ts: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface TimeframeStats {
  timeframe: string
  closes: number[]
  ema20: number[]
  ema50: number[]
  rsi7: number[]
  rsi14: number[]
  macdHist: number[]
  atr3: number
  atr14: number
  volumeLast: number
  volumeAvg: number
}

export interface SymbolSnapshot {
  symbol: string
  price: number
  markPrice: number | null
  /** Hourly funding rate (Hyperliquid pays funding every hour). */
  fundingRate: number | null
  openInterest: number | null
  prevDayPrice: number | null
  dayNotionalVolume: number | null
  intraday: TimeframeStats
  higher: TimeframeStats
  /** V3.1 only: computed from the same fetched candles, excluding the forming bar. */
  confirmedHigher?: { stats: TimeframeStats; closedAt: number } | null
}

export interface MarketSnapshot {
  ts: number
  symbols: Record<string, SymbolSnapshot>
}

async function fetchCandles(symbol: string, timeframe: string, limit: number): Promise<Candle[]> {
  const rows = await ex().fetchOHLCV(perp(symbol), timeframe, undefined, limit)
  return rows
    .filter((r) => r[0] != null && r[4] != null)
    .map((r) => ({
      ts: Number(r[0]),
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5] ?? 0),
    }))
}

export function computeStats(timeframe: string, candles: Candle[]): TimeframeStats {
  const closes = candles.map((c) => c.close)
  const highs = candles.map((c) => c.high)
  const lows = candles.map((c) => c.low)
  const vols = candles.map((c) => c.volume)
  return {
    timeframe,
    closes,
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    rsi7: rsi(closes, 7),
    rsi14: rsi(closes, 14),
    macdHist: macd(closes).histogram,
    atr3: last(atr(highs, lows, closes, 3)),
    atr14: last(atr(highs, lows, closes, 14)),
    volumeLast: vols[vols.length - 1] ?? 0,
    volumeAvg: vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : 0,
  }
}

/** Only fully closed 4h bars; explicit timestamps prevent treating a live bar as a close. */
export function confirmedHigher(candles: Candle[], now: number): SymbolSnapshot['confirmedHigher'] {
  const duration = 4 * 3_600_000
  const closed = candles.filter((c) => c.ts + duration <= now).sort((a, b) => a.ts - b.ts)
  const final = closed[closed.length - 1]
  if (!final || closed.length < 50) return null
  return { stats: computeStats('4h', closed), closedAt: final.ts + duration }
}

/** Latest prices for many symbols in a single request. */
export async function fetchPrices(symbols: string[]): Promise<Record<string, number>> {
  const tickers = await ex().fetchTickers(symbols.map(perp))
  const out: Record<string, number> = {}
  for (const s of symbols) {
    const t = tickers[perp(s)]
    const p = Number(t?.last ?? t?.close ?? NaN)
    if (Number.isFinite(p) && p > 0) out[s] = p
  }
  return out
}

/** Last price and 24h change per symbol for the dashboard ticker (one request). */
export async function fetchTickerSummary(symbols: string[]): Promise<{ symbol: string; price: number; change24hPct: number | null }[]> {
  const tickers = await ex().fetchTickers(symbols.map(perp))
  const out: { symbol: string; price: number; change24hPct: number | null }[] = []
  for (const s of symbols) {
    const t = tickers[perp(s)]
    const price = Number(t?.last ?? t?.close ?? NaN)
    if (!Number.isFinite(price) || price <= 0) continue
    const prev = Number((t?.info as Record<string, string> | undefined)?.prevDayPx ?? NaN)
    out.push({ symbol: s, price, change24hPct: Number.isFinite(prev) && prev > 0 ? (price / prev - 1) * 100 : null })
  }
  return out
}

/** Hourly funding rates keyed by symbol. */
export async function fetchFunding(symbols: string[]): Promise<Record<string, number>> {
  const rates = await ex().fetchFundingRates(symbols.map(perp))
  const out: Record<string, number> = {}
  for (const s of symbols) {
    const r = Number(rates[perp(s)]?.fundingRate ?? NaN)
    if (Number.isFinite(r)) out[s] = r
  }
  return out
}

export async function fetchMarketSnapshot(
  symbols: string[],
  opts: { intraday?: string; higher?: string } = {},
): Promise<MarketSnapshot> {
  const intradayTf = opts.intraday ?? '15m'
  const higherTf = opts.higher ?? '4h'

  const [rates, prices] = await Promise.all([
    ex().fetchFundingRates(symbols.map(perp)),
    fetchPrices(symbols),
  ])

  const result: Record<string, SymbolSnapshot> = {}
  for (const symbol of symbols) {
    try {
      const [intra, high] = await Promise.all([
        fetchCandles(symbol, intradayTf, 100),
        fetchCandles(symbol, higherTf, 100),
      ])
      const fr = rates[perp(symbol)]
      const info = (fr?.info ?? {}) as Record<string, string>
      const price = prices[symbol] ?? intra[intra.length - 1]?.close
      if (!price) throw new Error('no price')
      result[symbol] = {
        symbol,
        price,
        markPrice: fr?.markPrice != null ? Number(fr.markPrice) : null,
        fundingRate: fr?.fundingRate != null ? Number(fr.fundingRate) : null,
        openInterest: info.openInterest != null ? Number(info.openInterest) : null,
        prevDayPrice: info.prevDayPx != null ? Number(info.prevDayPx) : null,
        dayNotionalVolume: info.dayNtlVlm != null ? Number(info.dayNtlVlm) : null,
        intraday: computeStats(intradayTf, intra),
        higher: computeStats(higherTf, high),
        confirmedHigher: higherTf === '4h' ? confirmedHigher(high, Date.now()) : null,
      }
    } catch (e) {
      logger.error(`Failed to build snapshot for ${symbol}: ${e}`)
    }
  }
  return { ts: Date.now(), symbols: result }
}

/** Hourly candles for the EMA-cross baseline. */
/** Candles from `since` onwards (used by the outcome evaluator). */
export async function fetchCandlesSince(symbol: string, timeframe: string, since: number, limit: number): Promise<Candle[]> {
  const rows = await ex().fetchOHLCV(perp(symbol), timeframe, since, limit)
  return rows
    .filter((r) => r[0] != null && r[4] != null)
    .map((r) => ({
      ts: Number(r[0]),
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5] ?? 0),
    }))
}

export async function fetchCloses(symbol: string, timeframe: string, limit: number): Promise<number[]> {
  return (await fetchCandles(symbol, timeframe, limit)).map((c) => c.close)
}
