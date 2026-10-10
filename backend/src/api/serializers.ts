/**
 * Row -> JSON serializers.
 *
 * The Python app returned SQLAlchemy models through Pydantic, which emitted
 * snake_case keys. Drizzle rows are camelCase, so these helpers restore the
 * wire format the frontend already expects.
 */
import type { Account, Order, Position, Trade } from '../db/schema.js'

export function serializeOrder(order: Order) {
  return {
    id: order.id,
    order_no: order.orderNo,
    account_id: order.accountId,
    version: order.version,
    symbol: order.symbol,
    name: order.name,
    market: order.market,
    side: order.side,
    order_type: order.orderType,
    price: order.price,
    quantity: order.quantity,
    leverage: order.leverage,
    filled_quantity: order.filledQuantity,
    status: order.status,
    order_time: order.orderTime,
    created_at: order.createdAt,
    updated_at: order.updatedAt,
  }
}

export function serializePosition(position: Position) {
  return {
    id: position.id,
    account_id: position.accountId,
    symbol: position.symbol,
    name: position.name,
    market: position.market,
    quantity: position.quantity,
    available_quantity: position.availableQuantity,
    avg_cost: position.avgCost,
    leverage: position.leverage,
    side: position.side,
    accumulated_interest: position.accumulatedInterest,
    last_interest_time: position.lastInterestTime,
    update_time: position.updateTime,
  }
}

export function serializeTrade(trade: Trade) {
  return {
    id: trade.id,
    order_id: trade.orderId,
    account_id: trade.accountId,
    symbol: trade.symbol,
    name: trade.name,
    market: trade.market,
    side: trade.side,
    price: trade.price,
    quantity: trade.quantity,
    commission: trade.commission,
    taker_fee: trade.takerFee,
    interest_charged: trade.interestCharged,
    trade_time: trade.tradeTime,
  }
}

/** Masks all but the last 4 characters of an API key. */
export function maskApiKey(apiKey: string | null | undefined): string {
  if (!apiKey) return ''
  return apiKey.length > 4 ? `${'*'.repeat(apiKey.length - 4)}${apiKey.slice(-4)}` : '****'
}

export function serializeAccount(account: Account, options?: { maskKey?: boolean }) {
  return {
    id: account.id,
    user_id: account.userId,
    name: account.name,
    account_type: account.accountType,
    model: account.model,
    base_url: account.baseUrl,
    api_key: options?.maskKey ? maskApiKey(account.apiKey) : account.apiKey,
    initial_capital: account.initialCapital,
    current_cash: account.currentCash,
    frozen_cash: account.frozenCash,
    margin_used: account.marginUsed,
    maintenance_margin_ratio: account.maintenanceMarginRatio,
    is_active: account.isActive === 'true',
    created_at: account.createdAt,
    updated_at: account.updatedAt,
  }
}
