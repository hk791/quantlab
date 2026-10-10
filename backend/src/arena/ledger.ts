/**
 * Paper-trading ledger for arena accounts (isolated margin perpetuals).
 *
 * The upstream executor is not used here: it values short positions with the
 * long formula and computes "total assets" from notional exposure, which
 * would make the comparison between models unfair. This ledger keeps its own
 * positions in `arena_position_meta` and only uses `accounts.current_cash`
 * from the upstream schema.
 *
 * Model of costs: taker fee on open and close, simulated slippage on every
 * fill, and (optionally) Hyperliquid hourly funding accrued on open positions.
 */
import { readExitRule } from './confirmation.js'
import { eq } from 'drizzle-orm'
import { db, rawDb } from '../db/client.js'
import { accounts } from '../db/schema.js'
import {
  addFunding,
  deletePositionMeta,
  getPositionMeta,
  insertClosedTrade,
  listPositionMeta,
  savePositionMeta,
  updateStops,
  type PositionMeta,
} from './store.js'
import { unrealizedPnl, type ApprovedOrder, type OpenPositionView } from './risk.js'

export interface LedgerCosts {
  feeRate: number
  slippageBps: number
}

export function getCash(accountId: number): number {
  return db.select({ c: accounts.currentCash }).from(accounts).where(eq(accounts.id, accountId)).get()?.c ?? 0
}

function setCash(accountId: number, cash: number): void {
  db.update(accounts).set({ currentCash: cash, marginUsed: totalMargin(accountId) }).where(eq(accounts.id, accountId)).run()
}

function totalMargin(accountId: number): number {
  return listPositionMeta(accountId).reduce((s, p) => s + p.margin, 0)
}

/** Fill price after slippage: buying pays more, selling receives less. */
export function fillPrice(price: number, isBuy: boolean, slippageBps: number): number {
  const s = slippageBps / 10_000
  return isBuy ? price * (1 + s) : price * (1 - s)
}

export function toView(m: PositionMeta): OpenPositionView {
  return {
    symbol: m.symbol,
    side: m.side,
    quantity: m.quantity,
    entryPrice: m.entry_price,
    leverage: m.leverage,
    margin: m.margin,
    stopLoss: m.stop_loss,
    takeProfit: m.take_profit,
    openedAt: Number(m.opened_at),
    exitRule: readExitRule(m.exit_rule_json),
  }
}

/** Position equity = margin + unrealised PnL, floored at 0 (isolated margin). */
export function positionEquity(m: PositionMeta, price: number): number {
  return Math.max(0, m.margin + unrealizedPnl(m.side, m.quantity, m.entry_price, price))
}

export function accountEquity(accountId: number, prices: Record<string, number>): { equity: number; cash: number } {
  const cash = getCash(accountId)
  let equity = cash
  for (const m of listPositionMeta(accountId)) {
    const p = prices[m.symbol]
    // Without a price fall back to entry (no unrealised PnL) rather than dropping the margin.
    equity += positionEquity(m, p ?? m.entry_price)
  }
  return { equity, cash }
}

export function openPosition(
  accountId: number,
  o: Extract<ApprovedOrder, { kind: 'open' }>,
  marketPrice: number,
  costs: LedgerCosts,
  now = Date.now(),
): PositionMeta {
  return rawDb.transaction(() => {
    if (getPositionMeta(accountId, o.symbol)) throw new Error(`already holding ${o.symbol}`)
    const px = fillPrice(marketPrice, o.side === 'LONG', costs.slippageBps)
    const quantity = o.notional / px
    const fee = o.notional * costs.feeRate
    const cash = getCash(accountId)
    if (cash < o.margin + fee) throw new Error(`insufficient cash: need ${(o.margin + fee).toFixed(2)}, have ${cash.toFixed(2)}`)
    const meta: PositionMeta = {
      account_id: accountId,
      symbol: o.symbol,
      side: o.side,
      entry_price: px,
      quantity,
      leverage: o.leverage,
      margin: o.margin,
      stop_loss: o.stopLoss,
      take_profit: o.takeProfit,
      opened_at: now,
      entry_reason: o.reason || null,
      entry_fee: fee,
      funding_paid: 0,
      last_funding_ts: now,
      invalidation: o.invalidation ?? null,
      exit_rule_json: o.exitRule ? JSON.stringify(o.exitRule) : null,
    }
    savePositionMeta(meta)
    setCash(accountId, cash - o.margin - fee)
    return meta
  })()
}

export interface CloseResult {
  symbol: string
  exitPrice: number
  pnl: number
}

export function closePosition(
  accountId: number,
  symbol: string,
  marketPrice: number,
  reason: string,
  costs: LedgerCosts,
  now = Date.now(),
): CloseResult | null {
  return rawDb.transaction(() => {
    const m = getPositionMeta(accountId, symbol)
    if (!m) return null
    const px = reason === 'liquidation' ? marketPrice : fillPrice(marketPrice, m.side === 'SHORT', costs.slippageBps)
    const exitFee = m.quantity * px * costs.feeRate
    const pricePnl = unrealizedPnl(m.side, m.quantity, m.entry_price, px)
    // Isolated margin: you cannot lose more than the posted margin.
    const returned = Math.max(0, m.margin + pricePnl - exitFee)
    const net = returned - m.margin - m.entry_fee - m.funding_paid
    deletePositionMeta(accountId, symbol)
    setCash(accountId, getCash(accountId) + returned)
    insertClosedTrade({
      account_id: accountId,
      symbol,
      side: m.side,
      leverage: m.leverage,
      quantity: m.quantity,
      entry_price: m.entry_price,
      exit_price: px,
      pnl: net,
      fees: m.entry_fee + Math.min(exitFee, Math.max(0, m.margin + pricePnl)),
      funding: m.funding_paid,
      close_reason: reason,
      opened_at: m.opened_at,
      closed_at: now,
      entry_reason: m.entry_reason,
      invalidation: m.invalidation ?? null,
      exit_rule_json: m.exit_rule_json ?? null,
    })
    return { symbol, exitPrice: px, pnl: net }
  })()
}

export function adjustStops(accountId: number, symbol: string, stopLoss: number | null, takeProfit: number | null): void {
  updateStops(accountId, symbol, stopLoss, takeProfit)
}

/**
 * Accrue hourly funding since the last accrual. Positive rate: longs pay,
 * shorts receive. Paid out of cash so it shows up in equity immediately.
 */
export function accrueFunding(
  accountId: number,
  prices: Record<string, number>,
  rates: Record<string, number>,
  now = Date.now(),
): void {
  rawDb.transaction(() => {
    let cash = getCash(accountId)
    for (const m of listPositionMeta(accountId)) {
      const rate = rates[m.symbol]
      const price = prices[m.symbol]
      if (rate == null || price == null) continue
      const hours = (now - m.last_funding_ts) / 3_600_000
      if (hours <= 0) continue
      const notional = m.quantity * price
      const paid = notional * rate * hours * (m.side === 'LONG' ? 1 : -1)
      cash -= paid
      addFunding(accountId, m.symbol, paid, now)
    }
    setCash(accountId, cash)
  })()
}

/** Reset an account to a clean slate (used when (re)creating arena accounts). */
export function resetAccount(accountId: number, capital: number): void {
  rawDb.transaction(() => {
    rawDb.prepare('DELETE FROM arena_position_meta WHERE account_id = ?').run(accountId)
    db.update(accounts)
      .set({ currentCash: capital, initialCapital: capital, marginUsed: 0, frozenCash: 0 })
      .where(eq(accounts.id, accountId))
      .run()
  })()
}
