/** EF1: fixed EMA candidate generation and a strictly binary AI entry gate. */
import { z } from 'zod'
import { computeStats, type Candle } from './market.js'
import { extractJsonObject } from './prompt.js'
import type { ModelAction } from './risk.js'

export const EMA_FILTER_VERSION = 'ema-filter-v1'
export const EMA_RULES_VERSION = 'ema_rules_v1'
export const EMA_HOUR_MS = 3_600_000
export interface EmaSignal {
  asOf: number
  closedAt: number
  side: 'LONG' | 'SHORT' | 'FLAT'
  close: number
  ema20: number
  ema50: number
  atr14: number
  rsi14: number
  ema20SlopePct: number
  volumeRatio: number | null
  recentCloses: number[]
}

/** The request start is the cutoff: a bar closing while fetching is not yet confirmed. */
export function buildEmaSignal(candles: Candle[], asOf: number): EmaSignal | null {
  const rows = candles.filter(c => c.ts + EMA_HOUR_MS <= asOf - 2000).sort((a, b) => a.ts - b.ts).slice(-120)
  if (rows.length < 60) return null
  if (rows.some((c, i) => ![c.ts, c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite)
    || c.close <= 0 || c.low <= 0 || c.high < c.low || c.volume < 0
    || (i > 0 && c.ts - rows[i - 1]!.ts !== EMA_HOUR_MS))) return null
  const last = rows[rows.length - 1]!
  const closedAt = last.ts + EMA_HOUR_MS
  if (asOf - closedAt >= EMA_HOUR_MS) return null
  const stats = computeStats('1h', rows)
  const fast = stats.ema20.at(-1)!, slow = stats.ema50.at(-1)!
  const prevVolume = rows.slice(-21, -1).reduce((sum, c) => sum + c.volume, 0) / 20
  if (![fast, slow, stats.atr14, stats.rsi14.at(-1)!].every(Number.isFinite) || stats.atr14 <= 0) return null
  return { asOf, closedAt, side: fast > slow ? 'LONG' : fast < slow ? 'SHORT' : 'FLAT',
    close: last.close, ema20: fast, ema50: slow, atr14: stats.atr14, rsi14: stats.rsi14.at(-1)!,
    ema20SlopePct: (fast / stats.ema20.at(-5)! - 1) * 100,
    volumeRatio: prevVolume > 0 ? last.volume / prevVolume : null, recentCloses: stats.closes.slice(-24) }
}

export function emaSignalFresh(signal: EmaSignal, now: number): boolean {
  return now >= signal.asOf && now - signal.asOf <= 10 * 60_000 && now - signal.closedAt < EMA_HOUR_MS
}

/** All numerical order fields are system-owned, never read from an AI response. */
export function emaEntryAction(signal: EmaSignal, price: number): ModelAction | null {
  if (signal.side === 'FLAT' || !Number.isFinite(price) || price <= 0) return null
  return { symbol: 'BTC', action: signal.side === 'LONG' ? 'open_long' : 'open_short',
    margin_pct: 0.25, leverage: 1,
    stop_loss: price + (signal.side === 'LONG' ? -1 : 1) * 2 * signal.atr14,
    reason: `EF1 已收盘 1h EMA20/50 ${signal.side}，信号 ${signal.closedAt}` }
}

const VerdictSchema = z.object({ allow: z.boolean(), reason: z.string().trim().min(1).max(1000) }).strict()
export function parseEmaVerdict(text: string): z.infer<typeof VerdictSchema> {
  const json = extractJsonObject(text.replace(/<think>[\s\S]*?<\/think>/gi, ''))
  if (!json) throw new Error('EF1 回复缺少 JSON 对象')
  return VerdictSchema.parse(JSON.parse(json))
}

export const EMA_FILTER_SYSTEM = `你是 EF1 双均线策略的入场过滤器。输入只包含决策时已知的 BTC 行情与固定规则。
方向由已收盘的 1h EMA20/50 决定。你的唯一任务是判断是否接受当前方向的新开仓；识别均线反复缠绕、趋势缺乏支持或异常波动等风险，但不要仅因 RSI 超买/超卖就否决趋势。没有足够依据时跳过。
你不能改变方向、仓位、杠杆、止损、止盈或退出规则。反向信号退出由系统执行，拒绝只影响新开仓。
拒绝后本轮趋势内不再询问，直到下一次方向变化。不要引用未提供的新闻或未来信息。
只输出一个 JSON 对象，严格包含两个字段：{"allow":true或false,"reason":"简短中文依据"}。不要输出交易 actions、置信概率或其他字段。`

export function emaFilterUser(signal: EmaSignal, fundingRate: number | null, roundTripPct: number): string {
  return JSON.stringify({ strategy: EMA_FILTER_VERSION, symbol: 'BTC', signal, fundingRate,
    rules: { marginPct: 0.25, leverage: 1, stop: '2 × 已收盘1h ATR14，再受统一止损上下限约束',
      takeProfit: null, exit: '均线反向或相等时平仓；硬止损、最长持仓和账户熔断仍生效',
      roundTripCostPct: roundTripPct, reentry: '拒绝、止损或超时后等待下次方向变化' } })
}
