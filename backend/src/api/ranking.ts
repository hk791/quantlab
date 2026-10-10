/** Ranking API routes for factor-based crypto rankings. Port of `api/ranking_routes.py`. */
import { Hono } from 'hono'
import pl from 'nodejs-polars'
import { and, asc, gte, lte, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { cryptoKlines } from '../db/schema.js'
import {
  computeAllFactors,
  computeSelectedFactors,
  listFactors,
} from '../factors/index.js'
import {
  buildCompositeScore,
  frameToRecords,
} from '../services/rankingTable.js'
import type { FactorHistory } from '../types/factor.js'
import { addDays, utcDateStr } from '../utils/datetime.js'

export const rankingRoutes = new Hono()

/** Get list of available factors. */
rankingRoutes.get('/factors', (c) => {
  const factors = listFactors()

  const allColumns = factors.flatMap((f) => f.columns)
  allColumns.push({
    key: 'Composite Score',
    label: 'Composite Score',
    type: 'score',
    sortable: true,
  })

  return c.json({
    success: true,
    factors: factors.map((factor) => ({
      id: factor.id,
      name: factor.name,
      description: factor.description,
      columns: factor.columns,
    })),
    all_columns: allColumns,
  })
})

/** Get ranking table based on factors computed from recent K-line data. */
rankingRoutes.get('/table', (c) => {
  const days = Number(c.req.query('days') ?? 100)
  const factorsParam = c.req.query('factors')
  const limit = Number(c.req.query('limit') ?? 50)

  const endDate = new Date()
  const startDate = addDays(endDate, -days)

  // Query K-line data for the specified period
  const klineData = db
    .select()
    .from(cryptoKlines)
    .where(
      and(
        eq(cryptoKlines.period, '1d'),
        gte(cryptoKlines.datetimeStr, utcDateStr(startDate)),
        lte(cryptoKlines.datetimeStr, utcDateStr(endDate)),
      ),
    )
    .orderBy(asc(cryptoKlines.symbol), asc(cryptoKlines.timestamp))
    .all()

  if (klineData.length === 0) {
    return c.json({
      success: true,
      data: [],
      message: 'No K-line data found for the specified period',
    })
  }

  // Group data by symbol
  const history = new Map<string, Record<string, unknown[]>>()
  for (const kline of klineData) {
    let cols = history.get(kline.symbol)
    if (!cols) {
      cols = {
        Date: [],
        Open: [],
        High: [],
        Low: [],
        Close: [],
        Volume: [],
        Amount: [],
      }
      history.set(kline.symbol, cols)
    }
    cols.Date!.push(kline.datetimeStr)
    cols.Open!.push(kline.openPrice ?? 0)
    cols.High!.push(kline.highPrice ?? 0)
    cols.Low!.push(kline.lowPrice ?? 0)
    cols.Close!.push(kline.closePrice ?? 0)
    cols.Volume!.push(kline.volume ?? 0)
    cols.Amount!.push(kline.amount ?? 0)
  }

  // Convert to polars frames (minimum data requirement: 10 rows)
  const historyFrames: FactorHistory = {}
  for (const [symbol, cols] of history) {
    if ((cols.Date?.length ?? 0) >= 10) {
      historyFrames[symbol] = pl.DataFrame(cols as never).sort('Date')
    }
  }

  if (Object.keys(historyFrames).length === 0) {
    return c.json({
      success: true,
      data: [],
      message: 'Insufficient data for factor calculation',
    })
  }

  // Compute factors
  const factorIds = factorsParam
    ? factorsParam.split(',').map((f) => f.trim())
    : null
  const resultDf = factorIds
    ? computeSelectedFactors(historyFrames, null, factorIds)
    : computeAllFactors(historyFrames, null)

  if (!resultDf || resultDf.height === 0) {
    return c.json({
      success: true,
      data: [],
      message: 'No factor results computed',
    })
  }

  // Composite score + descending sort, then limit
  const records = buildCompositeScore(frameToRecords(resultDf))

  return c.json({
    success: true,
    data: records.slice(0, limit),
    total_symbols: Object.keys(historyFrames).length,
    data_period: `${utcDateStr(startDate)} to ${utcDateStr(endDate)}`,
    factors_computed: factorIds ?? 'all',
  })
})

/** Get list of symbols with sufficient K-line data. */
rankingRoutes.get('/symbols', (c) => {
  const days = Number(c.req.query('days') ?? 100)

  const endDate = new Date()
  const startDate = addDays(endDate, -days)

  const rows = db
    .selectDistinct({ symbol: cryptoKlines.symbol })
    .from(cryptoKlines)
    .where(
      and(
        eq(cryptoKlines.period, '1d'),
        gte(cryptoKlines.datetimeStr, utcDateStr(startDate)),
        lte(cryptoKlines.datetimeStr, utcDateStr(endDate)),
      ),
    )
    .all()

  const symbols = rows.map((r) => r.symbol)

  return c.json({
    success: true,
    symbols,
    count: symbols.length,
    data_period: `${utcDateStr(startDate)} to ${utcDateStr(endDate)}`,
  })
})

/** Get crypto info summary (called by StockViewer). */
rankingRoutes.get('/crypto-info/:symbol', async (c) => {
  const symbol = c.req.param('symbol')
  const { getLastPrice, getMarketStatus } = await import('../services/marketData.js')

  try {
    const [price, status] = await Promise.all([
      getLastPrice(symbol, 'CRYPTO').catch(() => null),
      getMarketStatus(symbol, 'CRYPTO').catch(() => null),
    ])

    const info: { item: string; value: string }[] = [
      { item: 'Symbol', value: symbol },
      { item: 'Market', value: status?.market_type ?? 'crypto' },
      { item: 'Status', value: status?.market_status ?? 'OPEN' },
      { item: 'Current Price', value: price !== null ? `$${price.toLocaleString()}` : '-' },
    ]

    if (status?.base_currency) {
      info.push({ item: 'Base Currency', value: status.base_currency })
    }
    if (status?.quote_currency) {
      info.push({ item: 'Quote Currency', value: status.quote_currency })
    }

    return c.json({
      success: true,
      data: info,
    })
  } catch (e) {
    return c.json({
      success: false,
      error: String((e as Error).message ?? e),
    })
  }
})
