/** Port of `services/market_data.py`. */
import { getLogger } from '../utils/logger.js'
import {
  getAllSymbolsFromHyperliquid,
  getKlineDataFromHyperliquid,
  getLastPriceFromHyperliquid,
  getMarketStatusFromHyperliquid,
  type Kline,
  type MarketStatus,
} from './hyperliquid.js'
import { cachePrice, getCachedPrice } from './priceCache.js'

const logger = getLogger('services.marketData')

export async function getLastPrice(
  symbol: string,
  market = 'CRYPTO',
): Promise<number> {
  const key = `${symbol}.${market}`

  // Check cache first
  const cached = getCachedPrice(symbol, market)
  if (cached !== null) {
    logger.debug(`Using cached price for ${key}: ${cached}`)
    return cached
  }

  logger.info(`Getting real-time price for ${key} from API...`)

  try {
    const price = await getLastPriceFromHyperliquid(symbol)
    if (price && price > 0) {
      logger.info(`Got real-time price for ${key} from Hyperliquid: ${price}`)
      cachePrice(symbol, market, price)
      return price
    }
    throw new Error(`Hyperliquid returned invalid price: ${price}`)
  } catch (hlErr) {
    logger.error(`Failed to get price from Hyperliquid: ${hlErr}`)
    throw new Error(`Unable to get real-time price for ${key}: ${hlErr}`)
  }
}

export async function getKlineData(
  symbol: string,
  market = 'CRYPTO',
  period = '1d',
  count = 100,
): Promise<Kline[]> {
  const key = `${symbol}.${market}`

  try {
    const data = await getKlineDataFromHyperliquid(symbol, period, count)
    if (data.length > 0) {
      logger.info(
        `Got K-line data for ${key} from Hyperliquid, total ${data.length} items`,
      )
      return data
    }
    throw new Error('Hyperliquid returned empty K-line data')
  } catch (hlErr) {
    logger.error(`Failed to get K-line data from Hyperliquid: ${hlErr}`)
    throw new Error(`Unable to get K-line data for ${key}: ${hlErr}`)
  }
}

export async function getMarketStatus(
  symbol: string,
  market = 'CRYPTO',
): Promise<MarketStatus> {
  const key = `${symbol}.${market}`

  try {
    const status = await getMarketStatusFromHyperliquid(symbol)
    logger.info(
      `Retrieved market status for ${key} from Hyperliquid: ${status.market_status}`,
    )
    return status
  } catch (hlErr) {
    logger.error(`Failed to get market status: ${hlErr}`)
    throw new Error(`Unable to get market status for ${key}: ${hlErr}`)
  }
}

/** Get all available trading pairs. */
export async function getAllSymbols(): Promise<string[]> {
  try {
    const symbols = await getAllSymbolsFromHyperliquid()
    logger.info(`Got ${symbols.length} trading pairs from Hyperliquid`)
    return symbols
  } catch (hlErr) {
    logger.error(`Failed to get trading pairs list: ${hlErr}`)
    return ['BTC/USD', 'ETH/USD', 'SOL/USD'] // default trading pairs
  }
}

export type { Kline, MarketStatus }
