/**
 * Market data API routes.
 * Provides RESTful API interfaces for crypto market data.
 * Port of `api/market_data_routes.py`.
 */
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import {
  getKlineData,
  getLastPrice,
  getMarketStatus,
} from '../services/marketData.js'
import { getLogger } from '../utils/logger.js'

const logger = getLogger('api.marketData')

export const marketDataRoutes = new Hono()

const VALID_PERIODS = ['1m', '5m', '15m', '30m', '1h', '1d']

/** Get latest crypto price. */
marketDataRoutes.get('/price/:symbol', async (c) => {
  const symbol = c.req.param('symbol')
  const market = c.req.query('market') ?? 'US'
  try {
    const price = await getLastPrice(symbol, market)
    return c.json({ symbol, market, price, timestamp: Date.now() })
  } catch (e) {
    logger.error(`Failed to get crypto price: ${e}`)
    throw new HTTPException(500, {
      message: `Failed to get crypto price: ${e}`,
    })
  }
})

/** Get latest prices for multiple cryptos in batch. */
marketDataRoutes.get('/prices', async (c) => {
  try {
    const symbols = c.req.query('symbols') ?? ''
    const market = c.req.query('market') ?? 'hyperliquid'

    const symbolList = symbols
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

    if (symbolList.length === 0) {
      throw new HTTPException(400, {
        message: 'crypto symbol list cannot be empty',
      })
    }
    if (symbolList.length > 20) {
      throw new HTTPException(400, {
        message: 'Maximum 20 crypto symbols supported',
      })
    }

    const currentTimestamp = Date.now()
    const results: Record<string, unknown>[] = []

    for (const symbol of symbolList) {
      try {
        const price = await getLastPrice(symbol, market)
        results.push({ symbol, market, price, timestamp: currentTimestamp })
      } catch (e) {
        // Continue processing other cryptos without interrupting the request
        logger.warning(`Failed to get ${symbol} price: ${e}`)
      }
    }

    return c.json(results)
  } catch (e) {
    if (e instanceof HTTPException) throw e
    logger.error(`Failed to batch get crypto prices: ${e}`)
    throw new HTTPException(500, {
      message: `Failed to batch get crypto prices: ${e}`,
    })
  }
})

/** Get crypto K-line data. */
marketDataRoutes.get('/kline/:symbol', async (c) => {
  const symbol = c.req.param('symbol')
  const market = c.req.query('market') ?? 'US'
  const period = c.req.query('period') ?? '1m'
  const count = Number(c.req.query('count') ?? 100)

  try {
    if (!VALID_PERIODS.includes(period)) {
      throw new HTTPException(400, {
        message: `Unsupported time period, supported periods: ${VALID_PERIODS.join(', ')}`,
      })
    }
    if (!Number.isFinite(count) || count <= 0 || count > 500) {
      throw new HTTPException(400, {
        message: 'Data count must be between 1-500',
      })
    }

    const klineData = await getKlineData(symbol, market, period, count)

    const data = klineData.map((item) => ({
      timestamp: item.timestamp,
      datetime: item.datetime_str,
      open: item.open,
      high: item.high,
      low: item.low,
      close: item.close,
      volume: item.volume,
      amount: item.amount,
      chg: item.change,
      percent: item.percent,
    }))

    return c.json({ symbol, market, period, count: data.length, data })
  } catch (e) {
    if (e instanceof HTTPException) throw e
    logger.error(`Failed to get K-line data: ${e}`)
    throw new HTTPException(500, {
      message: `Failed to get K-line data: ${e}`,
    })
  }
})

/** Get crypto market status. */
marketDataRoutes.get('/status/:symbol', async (c) => {
  const symbol = c.req.param('symbol')
  const market = c.req.query('market') ?? 'US'
  try {
    const statusData = await getMarketStatus(symbol, market)
    return c.json({
      symbol: statusData.symbol ?? symbol,
      market,
      market_status: statusData.market_status ?? 'UNKNOWN',
      timestamp: Date.now(),
      current_time: new Date().toISOString(),
    })
  } catch (e) {
    logger.error(`Failed to get market status: ${e}`)
    throw new HTTPException(500, {
      message: `Failed to get market status: ${e}`,
    })
  }
})

/** Market data service health check. */
marketDataRoutes.get('/health', async (c) => {
  try {
    // Test getting a price to check if the service is running normally
    const testPrice = await getLastPrice('BTC', 'CRYPTO')
    return c.json({
      status: 'healthy',
      timestamp: Date.now(),
      test_price: { symbol: 'BTC.CRYPTO', price: testPrice },
      message: 'Market data service is running normally',
    })
  } catch (e) {
    logger.error(`Market data service health check failed: ${e}`)
    return c.json({
      status: 'unhealthy',
      timestamp: Date.now(),
      error: String(e),
      message: 'Market data service abnormal',
    })
  }
})
