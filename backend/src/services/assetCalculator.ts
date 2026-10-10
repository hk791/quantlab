/** Port of `services/asset_calculator.py`. */
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { positions } from '../db/schema.js'
import { getLastPrice } from './marketData.js'
import { getLogger } from '../utils/logger.js'

const logger = getLogger('services.assetCalculator')

/**
 * Calculate total equity in positions (for leveraged positions:
 * margin + unrealized P&L).
 *
 * For leveraged positions the equity is NOT the full market value
 * (quantity * price), but the margin used plus unrealized profit/loss:
 *
 *   Equity = Initial Margin + Unrealized P&L
 *          = (market_value / leverage) + quantity * (current_price - avg_cost)
 *
 * @returns Total equity in positions; positions whose price cannot be
 *          obtained are skipped.
 */
export async function calcPositionsMarketValue(
  accountId: number,
): Promise<number> {
  const rows = db
    .select()
    .from(positions)
    .where(eq(positions.accountId, accountId))
    .all()

  let total = 0

  for (const p of rows) {
    try {
      const price = await getLastPrice(p.symbol, p.market)
      const quantity = p.quantity
      const avgCost = p.avgCost
      const leverage = p.leverage && p.leverage > 0 ? p.leverage : 1

      // Market value of position
      const marketValue = quantity * price

      let positionEquity: number
      if (leverage > 1) {
        // For leveraged positions, only count margin + unrealized P&L
        const initialMargin = marketValue / leverage
        const unrealizedPnl = quantity * (price - avgCost)
        positionEquity = initialMargin + unrealizedPnl
      } else {
        // Non-leveraged position: equity = market value
        positionEquity = marketValue
      }

      total += positionEquity
    } catch (e) {
      logger.warning(
        `Cannot get price for ${p.symbol}.${p.market}, skipping position value calculation: ${e}`,
      )
    }
  }

  return total
}

/**
 * Total NOTIONAL value of all positions: sum(quantity * price * leverage).
 *
 * WARNING: this is exposure, not equity. For account assets/profit use
 * {@link calcPositionsMarketValue} instead.
 */
export async function calcPositionsValue(accountId: number): Promise<number> {
  const rows = db
    .select()
    .from(positions)
    .where(eq(positions.accountId, accountId))
    .all()

  let total = 0

  for (const p of rows) {
    try {
      const price = await getLastPrice(p.symbol, p.market)
      total += price * p.quantity * p.leverage
    } catch (e) {
      logger.warning(
        `Cannot get price for ${p.symbol}.${p.market}, skipping position value calculation: ${e}`,
      )
    }
  }

  return total
}
