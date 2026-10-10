/**
 * Hard risk layer. Pure functions only (no I/O) — every model action passes
 * through here before touching the paper account, and nothing the model
 * says can override these limits.
 */
import { confirmedClose, confirmationAvailable, parseExitRule, ruleTriggered, type ExitRule, type ConfirmationContext } from './confirmation.js'
import type { RiskConfig } from './config.js'

export type ActionType = 'open_long' | 'open_short' | 'close' | 'hold' | 'adjust'

/** One action as requested by the model (already shape-normalised). */
export interface ModelAction {
  symbol: string
  action: ActionType
  /** Fraction of equity to post as margin. */
  margin_pct?: number
  leverage?: number
  stop_loss?: number
  take_profit?: number
  confidence?: number
  reason?: string
  /** v2: the condition that would prove this trade wrong (kept with the position). */
  invalidation?: string
  exit_rule?: ExitRule
}

export interface OpenPositionView {
  symbol: string
  side: 'LONG' | 'SHORT'
  quantity: number
  entryPrice: number
  leverage: number
  margin: number
  stopLoss: number | null
  takeProfit: number | null
  openedAt?: number
  exitRule?: ExitRule | null
}

export interface RiskContext {
  equity: number
  cash: number
  peakEquity: number
  halted: boolean
  symbols: string[]
  prices: Record<string, number>
  positions: OpenPositionView[]
  feeRate: number
  config: RiskConfig
  /** Extra rules for strategy-v2 accounts. Absent for v1, which then behaves exactly as before. */
  v2?: V2RiskRules
  /** Rules for strategy-v3 accounts (risk-based sizing, ATR stops, stop guard). Takes precedence over v2. */
  v3?: V3RiskRules
  confirmation?: ConfirmationContext
}

export interface V3RiskRules {
  now: number
  /** symbol -> minimum stop distance as a fraction of price (stopAtrMult x 4h ATR). */
  minStopPct: Record<string, number>
  /** "SYMBOL:SIDE" -> epoch ms until which opening that side is blocked (stop guard). */
  locks: Record<string, number>
  /** Fraction of equity lost if the stop is hit (incl. round-trip costs), e.g. 0.01. */
  riskPerTradePct: number
  /** Round-trip fees + slippage as a fraction of notional. */
  roundTripPct: number
}

export interface V2RiskRules {
  now: number
  /** symbol -> epoch ms until which new positions are blocked (recently closed). */
  cooldownUntil: Record<string, number>
  /** symbol -> minimum stop distance as a fraction of price (from ATR). */
  minStopPct: Record<string, number>
}

export type ApprovedOrder =
  | {
      kind: 'open'
      symbol: string
      side: 'LONG' | 'SHORT'
      leverage: number
      margin: number
      notional: number
      quantity: number
      stopLoss: number
      takeProfit: number | null
      reason: string
      invalidation?: string
      exitRule?: ExitRule
    }
  | { kind: 'close'; symbol: string; reason: string }
  | {
      kind: 'adjust'
      symbol: string
      stopLoss: number | null
      takeProfit: number | null
      reason: string
    }

export interface ActionResult {
  symbol: string
  action: string
  status: 'approved' | 'adjusted' | 'rejected' | 'noop'
  notes: string[]
}

export interface RiskOutcome {
  orders: ApprovedOrder[]
  results: ActionResult[]
}

const round = (v: number, dp = 8) => Number(v.toFixed(dp))

export function drawdown(equity: number, peak: number): number {
  return peak > 0 ? Math.max(0, (peak - equity) / peak) : 0
}

/**
 * Validates / clamps a stop loss for a position opened (or held) at `price`.
 * Returns the final stop and notes describing any change.
 */
export function sanitizeStopLoss(
  side: 'LONG' | 'SHORT',
  price: number,
  leverage: number,
  requested: number | undefined | null,
  cfg: RiskConfig,
  /** v2: a larger minimum distance (e.g. from ATR). Still capped by the max distance. */
  minDistOverride?: number,
): { stop: number; notes: string[] } {
  const notes: string[] = []
  // A stop must trigger well before liquidation (~1/leverage away).
  const maxDist = Math.min(cfg.maxStopLossPct, 0.8 / leverage)
  const minDist = Math.min(Math.max(cfg.minStopLossPct, minDistOverride ?? 0), maxDist)
  const dir = side === 'LONG' ? -1 : 1
  const fallback = () => {
    const d = Math.min(cfg.defaultStopLossPct, maxDist)
    return minDistOverride != null ? Math.max(d, minDist) : d
  }

  let dist: number
  if (requested == null || !Number.isFinite(requested) || requested <= 0) {
    dist = fallback()
    notes.push(`缺少止损，使用默认 ${(dist * 100).toFixed(2)}%`)
  } else {
    const wrongSide = side === 'LONG' ? requested >= price : requested <= price
    if (wrongSide) {
      dist = fallback()
      notes.push(`止损 ${requested} 方向错误，改用默认 ${(dist * 100).toFixed(2)}%`)
    } else {
      dist = Math.abs(price - requested) / price
      if (dist > maxDist) {
        notes.push(`止损距离 ${(dist * 100).toFixed(2)}% 过宽，收紧到 ${(maxDist * 100).toFixed(2)}%`)
        dist = maxDist
      } else if (dist < minDist) {
        notes.push(
          `止损距离 ${(dist * 100).toFixed(2)}% 过窄，放宽到 ${(minDist * 100).toFixed(2)}%` +
            (minDistOverride != null && minDistOverride > cfg.minStopLossPct ? '（按 4h ATR）' : ''),
        )
        dist = minDist
      }
    }
  }
  return { stop: round(price * (1 + dir * dist), 6), notes }
}

export function sanitizeTakeProfit(
  side: 'LONG' | 'SHORT',
  price: number,
  requested: number | undefined | null,
): { tp: number | null; notes: string[] } {
  if (requested == null || !Number.isFinite(requested) || requested <= 0) return { tp: null, notes: [] }
  const ok = side === 'LONG' ? requested > price : requested < price
  return ok ? { tp: round(requested, 6), notes: [] } : { tp: null, notes: [`止盈 ${requested} 方向错误，已忽略`] }
}

export function evaluateActions(actions: ModelAction[], ctx: RiskContext): RiskOutcome {
  const cfg = ctx.config
  const orders: ApprovedOrder[] = []
  const results: ActionResult[] = []
  const dd = drawdown(ctx.equity, ctx.peakEquity)

  // Mutable working state so several actions in one cycle respect totals.
  const held = new Map(ctx.positions.map((p) => [p.symbol, p]))
  let cash = ctx.cash
  let totalMargin = ctx.positions.reduce((s, p) => s + p.margin, 0)
  const touched = new Set<string>()

  for (const a of actions) {
    const symbol = String(a.symbol ?? '').toUpperCase()
    const res: ActionResult = { symbol, action: a.action, status: 'rejected', notes: [] }
    results.push(res)
    const reason = String(a.reason ?? '').slice(0, 500)

    if (a.action === 'hold') {
      res.status = 'noop'
      continue
    }
    if (!ctx.symbols.includes(symbol)) {
      res.notes.push(`不支持的币种 ${symbol}`)
      continue
    }
    if (touched.has(symbol)) {
      res.notes.push('同一周期内对该币种只执行第一条指令')
      continue
    }
    const price = ctx.prices[symbol]
    if (!price || price <= 0) {
      res.notes.push('没有可用价格')
      continue
    }
    const pos = held.get(symbol)

    if (a.action === 'close') {
      if (!pos) {
        res.notes.push('没有持仓可平')
        continue
      }
      if (ctx.confirmation) {
        const check = confirmedClose(pos.exitRule ?? null, pos.openedAt, ctx.confirmation, symbol)
        res.notes.push(check.note)
        if (!check.allowed) continue
      }
      orders.push({ kind: 'close', symbol, reason })
      held.delete(symbol)
      touched.add(symbol)
      totalMargin -= pos.margin
      res.status = 'approved'
      continue
    }

    if (a.action === 'adjust') {
      if (!pos) {
        res.notes.push('没有持仓可调整')
        continue
      }
      const sl =
        a.stop_loss != null
          ? // The ATR minimum only applies when opening: moving a stop closer to lock in profit is allowed.
            sanitizeStopLoss(pos.side, price, pos.leverage, a.stop_loss, cfg)
          : { stop: pos.stopLoss, notes: [] as string[] }
      // If the requested stop is already beyond the current price, the clamp
      // above moves it to a valid level relative to *current* price.
      const tp = a.take_profit != null ? sanitizeTakeProfit(pos.side, price, a.take_profit) : { tp: pos.takeProfit, notes: [] }
      res.notes.push(...sl.notes, ...tp.notes)
      orders.push({ kind: 'adjust', symbol, stopLoss: sl.stop, takeProfit: tp.tp, reason })
      touched.add(symbol)
      res.status = res.notes.length ? 'adjusted' : 'approved'
      continue
    }

    if (a.action !== 'open_long' && a.action !== 'open_short') {
      res.notes.push(`未知操作 ${a.action}`)
      continue
    }

    // ---- opening checks
    const side = a.action === 'open_long' ? 'LONG' : 'SHORT'
    if (ctx.halted) {
      res.notes.push('账户已熔断，只允许平仓')
      continue
    }
    if (dd >= cfg.noNewPositionDrawdownPct) {
      res.notes.push(`回撤 ${(dd * 100).toFixed(1)}% 超过 ${(cfg.noNewPositionDrawdownPct * 100).toFixed(0)}%，禁止开新仓`)
      continue
    }
    if (pos) {
      res.notes.push(pos.side === side ? '已有同向持仓（如需改止损请用 adjust）' : '已有反向持仓，请先 close')
      continue
    }
    const lockUntil = ctx.v3?.locks[`${symbol}:${side}`]
    if (ctx.v3 && lockUntil != null && lockUntil > ctx.v3.now) {
      res.notes.push(`${symbol} ${side === 'LONG' ? '多' : '空'}单近期连续止损，暂停该方向，还需 ${Math.ceil((lockUntil - ctx.v3.now) / 60_000)} 分钟`)
      continue
    }
    const coolUntil = ctx.v3 ? undefined : ctx.v2?.cooldownUntil[symbol]
    if (ctx.v2 && coolUntil != null && coolUntil > ctx.v2.now) {
      res.notes.push(`${symbol} 刚平仓，冷却中，还需 ${Math.ceil((coolUntil - ctx.v2.now) / 60_000)} 分钟`)
      continue
    }
    if (held.size >= cfg.maxOpenPositions) {
      res.notes.push(`持仓数已达上限 ${cfg.maxOpenPositions}`)
      continue
    }

    let exitRule: ExitRule | null = null
    if (ctx.confirmation) {
      exitRule = parseExitRule(a.exit_rule)
      if (!exitRule || !confirmationAvailable(ctx.confirmation, symbol)) {
        res.notes.push('V3.1 开仓需要有效的 exit_rule 和新鲜的已收盘 4h 行情')
        continue
      }
      if ((side === 'LONG') !== (exitRule.kind === 'close_below')) {
        res.notes.push('V3.1 多单失效条件必须是收盘跌破，空单必须是收盘突破')
        continue
      }
      if (ruleTriggered(exitRule, ctx.confirmation.bars[symbol]!)) {
        res.notes.push('V3.1 入场失效条件已经触发，拒绝开仓')
        continue
      }
    }
    if (ctx.v3) {
      const sized = sizeByRisk(side, price, a.stop_loss, ctx, symbol, ctx.equity * cfg.maxTotalMarginPct - totalMargin, cash)
      res.notes.push(...sized.notes)
      if (!sized.order) continue
      const tp = sanitizeTakeProfit(side, price, a.take_profit)
      res.notes.push(...tp.notes)
      const o = sized.order
      orders.push({
        kind: 'open',
        symbol,
        side,
        leverage: o.leverage,
        margin: round(o.margin, 6),
        notional: round(o.notional, 6),
        quantity: round(o.notional / price, 8),
        stopLoss: o.stop,
        takeProfit: tp.tp,
        reason,
        ...(a.invalidation ? { invalidation: String(a.invalidation).slice(0, 300) } : {}),
        ...(exitRule ? { exitRule } : {}),
      })
      touched.add(symbol)
      cash -= o.margin + o.notional * ctx.feeRate
      totalMargin += o.margin
      held.set(symbol, { symbol, side, quantity: o.notional / price, entryPrice: price, leverage: o.leverage, margin: o.margin, stopLoss: o.stop, takeProfit: tp.tp })
      // Sizing is always computed by the system, so this is informational, not an "adjustment".
      res.status = tp.notes.length || sized.adjusted ? 'adjusted' : 'approved'
      continue
    }

    let leverage = Math.round(Number(a.leverage ?? 1))
    if (!Number.isFinite(leverage) || leverage < 1) leverage = 1
    if (leverage > cfg.maxLeverage) {
      res.notes.push(`杠杆 ${leverage}x 超上限，降为 ${cfg.maxLeverage}x`)
      leverage = cfg.maxLeverage
    }

    let pct = Number(a.margin_pct ?? 0)
    if (!Number.isFinite(pct) || pct <= 0) {
      res.notes.push('margin_pct 无效')
      continue
    }
    if (pct > cfg.maxMarginPctPerTrade) {
      res.notes.push(`单笔保证金 ${(pct * 100).toFixed(0)}% 超上限，降为 ${(cfg.maxMarginPctPerTrade * 100).toFixed(0)}%`)
      pct = cfg.maxMarginPctPerTrade
    }
    let margin = ctx.equity * pct
    const totalRoom = ctx.equity * cfg.maxTotalMarginPct - totalMargin
    if (margin > totalRoom) {
      res.notes.push('总保证金占用达到上限，缩减仓位')
      margin = totalRoom
    }
    // Keep enough cash for the opening fee.
    const cashRoom = cash / (1 + leverage * ctx.feeRate)
    if (margin > cashRoom) {
      res.notes.push('可用现金不足，缩减仓位')
      margin = cashRoom
    }
    const notional = margin * leverage
    if (margin <= 0 || notional < cfg.minOrderNotional) {
      res.notes.push(`下单名义价值 ${notional.toFixed(2)} 低于最小值 ${cfg.minOrderNotional}`)
      continue
    }

    const sl = sanitizeStopLoss(side, price, leverage, a.stop_loss, cfg, ctx.v2?.minStopPct[symbol])
    const tp = sanitizeTakeProfit(side, price, a.take_profit)
    res.notes.push(...sl.notes, ...tp.notes)

    orders.push({
      kind: 'open',
      symbol,
      side,
      leverage,
      margin: round(margin, 6),
      notional: round(notional, 6),
      quantity: round(notional / price, 8),
      stopLoss: sl.stop,
      takeProfit: tp.tp,
      reason,
      ...(a.invalidation ? { invalidation: String(a.invalidation).slice(0, 300) } : {}),
    })
    touched.add(symbol)
    cash -= margin + notional * ctx.feeRate
    totalMargin += margin
    held.set(symbol, {
      symbol,
      side,
      quantity: notional / price,
      entryPrice: price,
      leverage,
      margin,
      stopLoss: sl.stop,
      takeProfit: tp.tp,
    })
    res.status = res.notes.length ? 'adjusted' : 'approved'
  }

  return { orders, results }
}

/**
 * v3 position sizing: the model picks direction and stop, the system picks the size.
 * notional = equity * riskPerTradePct / (stop distance + round-trip cost), so a stop-out
 * loses about riskPerTradePct of equity. Leverage is the smallest integer that keeps the
 * margin within maxMarginPctPerTrade; if even maxLeverage is not enough the size shrinks.
 * The model's margin_pct and leverage are ignored.
 */
export function sizeByRisk(
  side: 'LONG' | 'SHORT',
  price: number,
  requestedStop: number | undefined,
  ctx: RiskContext,
  symbol: string,
  totalMarginRoom: number,
  cash: number,
): { order: { leverage: number; margin: number; notional: number; stop: number } | null; notes: string[]; adjusted: boolean } {
  const cfg = ctx.config
  const v3 = ctx.v3!
  const notes: string[] = []
  // Stop distance is validated against the widest leverage we might use, so whatever
  // leverage is picked below the stop still sits well before liquidation.
  const sl = sanitizeStopLoss(side, price, cfg.maxLeverage, requestedStop, cfg, v3.minStopPct[symbol])
  notes.push(...sl.notes)
  let adjusted = sl.notes.length > 0
  const dist = Math.abs(price - sl.stop) / price
  let notional = (ctx.equity * v3.riskPerTradePct) / (dist + v3.roundTripPct)
  const maxMargin = ctx.equity * cfg.maxMarginPctPerTrade
  let leverage = Math.max(1, Math.ceil(notional / maxMargin - 1e-9))
  if (leverage > cfg.maxLeverage) {
    leverage = cfg.maxLeverage
    notional = maxMargin * leverage
    notes.push(`按风险算出的仓位超过单笔保证金上限，缩减到 ${notional.toFixed(0)}`)
    adjusted = true
  }
  let margin = notional / leverage
  if (margin > totalMarginRoom) {
    notes.push('总保证金占用达到上限，缩减仓位')
    margin = totalMarginRoom
    adjusted = true
  }
  const cashRoom = cash / (1 + leverage * ctx.feeRate)
  if (margin > cashRoom) {
    notes.push('可用现金不足，缩减仓位')
    margin = cashRoom
    adjusted = true
  }
  notional = margin * leverage
  if (margin <= 0 || notional < cfg.minOrderNotional) {
    notes.push(`下单名义价值 ${notional.toFixed(2)} 低于最小值 ${cfg.minOrderNotional}`)
    return { order: null, notes, adjusted }
  }
  const lossAtStop = notional * (dist + v3.roundTripPct)
  notes.push(
    `系统按风险定仓：止损距离 ${(dist * 100).toFixed(2)}%，名义 ${notional.toFixed(0)}，${leverage}x，` +
      `止损约亏 ${lossAtStop.toFixed(0)}（权益的 ${((lossAtStop / ctx.equity) * 100).toFixed(2)}%）`,
  )
  return { order: { leverage, margin, notional, stop: sl.stop }, notes, adjusted }
}

/**
 * v3 stop guard (cf. freqtrade StoplossGuard, per pair and per side): if a symbol/side
 * was stopped out `count` times within `lookbackHours`, block that side for `lockHours`
 * after the latest of those stops. Take-profits and model closes never lock.
 */
export function stopGuardLocks(
  closes: { symbol: string; side: string; close_reason: string; pnl: number; closed_at: number }[],
  rule: { count: number; lookbackHours: number; lockHours: number },
  now: number,
): Record<string, number> {
  const out: Record<string, number> = {}
  if (rule.count <= 0 || rule.lockHours <= 0) return out
  const since = now - rule.lookbackHours * 3_600_000
  const groups = new Map<string, number[]>()
  for (const t of closes) {
    if (t.closed_at < since || t.pnl >= 0) continue
    if (t.close_reason !== 'stop_loss' && t.close_reason !== 'liquidation') continue
    const k = `${t.symbol}:${t.side}`
    groups.set(k, [...(groups.get(k) ?? []), t.closed_at])
  }
  for (const [k, ts] of groups) {
    if (ts.length < rule.count) continue
    const until = Math.max(...ts) + rule.lockHours * 3_600_000
    if (until > now) out[k] = until
  }
  return out
}

/** v2 cooldown: symbol -> time until which re-opening is blocked, from recent closes. */
export function cooldownUntil(
  closes: { symbol: string; closed_at: number }[],
  minutes: number,
): Record<string, number> {
  const out: Record<string, number> = {}
  if (minutes <= 0) return out
  for (const t of closes) {
    const until = t.closed_at + minutes * 60_000
    if (until > (out[t.symbol] ?? 0)) out[t.symbol] = until
  }
  return out
}

// ---------------------------------------------------------------- monitoring

export type TriggerReason = 'stop_loss' | 'take_profit' | 'liquidation' | 'timeout'

export interface MonitoredPosition extends OpenPositionView {
  openedAt: number
}

/** Unrealised PnL from price movement only. */
export function unrealizedPnl(side: 'LONG' | 'SHORT', qty: number, entry: number, price: number): number {
  return side === 'LONG' ? qty * (price - entry) : qty * (entry - price)
}

/** Rough isolated-margin liquidation level: equity <= 1% of notional. */
export function liquidationPrice(p: OpenPositionView, maintenanceRate = 0.01): number {
  // margin + pnl = mm * notional  => solve for price
  const q = p.quantity
  if (p.side === 'LONG') return (p.entryPrice * q - p.margin) / (q * (1 - maintenanceRate))
  return (p.entryPrice * q + p.margin) / (q * (1 + maintenanceRate))
}

export function checkTrigger(
  p: MonitoredPosition,
  price: number,
  now: number,
  cfg: RiskConfig,
): TriggerReason | null {
  const liq = liquidationPrice(p)
  if (p.side === 'LONG' ? price <= liq : price >= liq) return 'liquidation'
  if (p.stopLoss != null && (p.side === 'LONG' ? price <= p.stopLoss : price >= p.stopLoss)) return 'stop_loss'
  if (p.takeProfit != null && (p.side === 'LONG' ? price >= p.takeProfit : price <= p.takeProfit)) return 'take_profit'
  if (cfg.maxHoldingHours > 0 && now - p.openedAt >= cfg.maxHoldingHours * 3_600_000) return 'timeout'
  return null
}
