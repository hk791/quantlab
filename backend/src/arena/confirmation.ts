/** V3.1 close confirmation. Pure; hard risk exits do not use this gate. */
export interface ExitRule {
  kind: 'close_below' | 'close_above'
  price: number
}

export interface ConfirmedBar {
  closedAt: number
  close: number
}

export interface ConfirmationContext {
  now: number
  snapshotTs: number
  bars: Record<string, ConfirmedBar | null>
}

export function parseExitRule(value: unknown): ExitRule | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (v.kind !== 'close_below' && v.kind !== 'close_above') return null
  if (typeof v.price !== 'number' || !Number.isFinite(v.price) || v.price <= 0) return null
  return { kind: v.kind, price: v.price }
}

export function readExitRule(json: string | null | undefined): ExitRule | null {
  try { return parseExitRule(JSON.parse(json ?? 'null')) } catch { return null }
}

export function confirmationAvailable(c: ConfirmationContext, symbol: string): boolean {
  const b = c.bars[symbol]
  return !!b && Number.isFinite(b.close) && b.close > 0 && Number.isFinite(b.closedAt) &&
    c.now >= c.snapshotTs && c.now - c.snapshotTs <= 15 * 60_000 &&
    b.closedAt <= c.snapshotTs && c.snapshotTs - b.closedAt <= 4 * 3_600_000 + 5 * 60_000
}

export function ruleTriggered(rule: ExitRule, bar: ConfirmedBar): boolean {
  return rule.kind === 'close_below' ? bar.close < rule.price : bar.close > rule.price
}

export function confirmedClose(
  rule: ExitRule | null, openedAt: number | undefined, c: ConfirmationContext, symbol: string,
): { allowed: boolean; note: string } {
  if (!rule || !Number.isFinite(openedAt)) return { allowed: false, note: 'V3.1 缺少入场时固定的收盘失效条件，拒绝模型主动平仓' }
  if (!confirmationAvailable(c, symbol)) return { allowed: false, note: 'V3.1 已收盘行情缺失或过期，拒绝模型主动平仓；硬止损继续监控' }
  const bar = c.bars[symbol]!
  if (bar.closedAt <= openedAt!) return { allowed: false, note: 'V3.1 入场后尚无新的 4h 收盘，拒绝模型主动平仓' }
  const allowed = ruleTriggered(rule, bar)
  return { allowed, note: `V3.1 ${new Date(bar.closedAt).toISOString()} 已收盘价 ${bar.close}，${rule.kind === 'close_below' ? '跌破' : '突破'} ${rule.price} 条件${allowed ? '已触发' : '未触发'}` }
}
