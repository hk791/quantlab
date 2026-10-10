/** Crypto-specific API routes. Port of `api/crypto_routes.py`. */
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import {
  getAllSymbols,
  getLastPrice,
  getMarketStatus,
} from '../services/marketData.js'
import { getLogger } from '../utils/logger.js'

const logger = getLogger('api.crypto')

export const cryptoRoutes = new Hono()

/** Get all available crypto trading pairs. */
cryptoRoutes.get('/symbols', async (c) => {
  try {
    return c.json(await getAllSymbols())
  } catch (e) {
    logger.error(`Error getting crypto symbols: ${e}`)
    throw new HTTPException(500, { message: String(e) })
  }
})

/** Get current price for a crypto symbol. */
cryptoRoutes.get('/price/:symbol', async (c) => {
  const symbol = c.req.param('symbol')
  try {
    const price = await getLastPrice(symbol, 'CRYPTO')
    return c.json({ symbol, price, market: 'CRYPTO' })
  } catch (e) {
    logger.error(`Error getting price for ${symbol}: ${e}`)
    throw new HTTPException(500, { message: String(e) })
  }
})

/** Get market status for a crypto symbol. */
cryptoRoutes.get('/status/:symbol', async (c) => {
  const symbol = c.req.param('symbol')
  try {
    return c.json(await getMarketStatus(symbol, 'CRYPTO'))
  } catch (e) {
    logger.error(`Error getting market status for ${symbol}: ${e}`)
    throw new HTTPException(500, { message: String(e) })
  }
})

/** Get popular crypto trading pairs with current prices. */
cryptoRoutes.get('/popular', async (c) => {
  const popularSymbols = ['BTC', 'ETH', 'SOL', 'DOGE', 'BNB', 'XRP']

  const results: Record<string, unknown>[] = []
  for (const symbol of popularSymbols) {
    try {
      const price = await getLastPrice(symbol, 'CRYPTO')
      results.push({
        symbol,
        name: symbol.split('/')[0], // Extract base currency
        price,
        market: 'CRYPTO',
      })
    } catch (e) {
      logger.warning(`Could not get price for ${symbol}: ${e}`)
    }
  }

  return c.json(results)
})
