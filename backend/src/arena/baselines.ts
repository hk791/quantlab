/**
 * Non-LLM control groups. If a model cannot beat these after costs, its
 * "intelligence" is not adding value.
 *
 *  - buy_hold_btc: put 100% of capital into a 1x BTC long on the first
 *    cycle and never touch it.
 *  - ema_cross_btc: 1x BTC on 1h candles. Long when EMA20 > EMA50, short
 *    when EMA20 < EMA50, flip on cross. Uses 95% of equity as margin.
 */
import { ema, last } from './indicators.js'

export type BaselineSignal = { want: 'LONG' | 'SHORT' | 'FLAT'; reason: string }

export function emaCrossSignal(closes: number[], fast = 20, slow = 50): BaselineSignal {
  const f = last(ema(closes, fast))
  const s = last(ema(closes, slow))
  if (!Number.isFinite(f) || !Number.isFinite(s)) return { want: 'FLAT', reason: '数据不足' }
  return f > s
    ? { want: 'LONG', reason: `EMA${fast} ${f.toFixed(1)} > EMA${slow} ${s.toFixed(1)}` }
    : { want: 'SHORT', reason: `EMA${fast} ${f.toFixed(1)} < EMA${slow} ${s.toFixed(1)}` }
}
