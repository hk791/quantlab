/**
 * Prompt construction + response parsing for arena models.
 *
 * Design choices:
 *  - Every model receives an identical system prompt and user payload.
 *  - Series are ordered OLDEST -> NEWEST and this is stated explicitly
 *    (a common source of model confusion).
 *  - The model may return several actions per cycle (one per symbol) and
 *    must always supply a stop loss when opening.
 */
import { parseExitRule, type ExitRule } from './confirmation.js'
import type { MarketSnapshot, TimeframeStats } from './market.js'
import type { ActionType, ModelAction } from './risk.js'
import type { RiskConfig, StrategyV2Config, StrategyV3Config } from './config.js'

export interface AccountView {
  equity: number
  cash: number
  initialCapital: number
  peakEquity: number
  minutesSinceStart: number
  invocationCount: number
  positions: {
    symbol: string
    side: string
    quantity: number
    entryPrice: number
    currentPrice: number
    leverage: number
    margin: number
    unrealizedPnl: number
    stopLoss: number | null
    takeProfit: number | null
    heldMinutes: number
    /** v2 only */
    entryReason?: string | null
    invalidation?: string | null
    exitRule?: ExitRule | null
  }[]
  recentTrades: { symbol: string; side: string; pnl: number; reason: string; heldMinutes?: number }[]
  /** Present only for strategy-v2 accounts; v1 prompts are unchanged. */
  memory?: V2Memory
  confirmedSignals?: boolean
}

/** Context engineering for v2: everything is computed in code, the model only reads it. */
export interface V2Memory {
  /** The model's own notes from its last successful decision. */
  lastNotes: { minutesAgo: number; text: string } | null
  last24h: { closedTrades: number; feesAndFunding: number; netPnl: number; stopLossCount: number }
  /** symbol -> minutes left until it can be opened again. */
  cooldowns: Record<string, number>
  /** symbol -> minimum allowed stop distance in % of price (from 4h ATR). */
  minStopPct: Record<string, number>
  /** v3 only: "SYMBOL:SIDE" -> minutes left on a stop-guard lock. Replaces cooldowns in the prompt. */
  locks?: Record<string, number>
}

/** Costs v2 models are told about, so the trade-off is explicit. */
export interface V2PromptInfo extends StrategyV2Config {
  feeRate: number
  slippageBps: number
  /** Present for v3 accounts: the v3 section replaces the v2 one. */
  v3?: StrategyV3Config
  confirmedSignals?: boolean
}

/** Round-trip cost (fees + slippage, open and close) as a fraction of notional. */
export function roundTripCostPct(feeRate: number, slippageBps: number): number {
  return 2 * feeRate + 2 * (slippageBps / 10_000)
}

const fmt = (v: number, dp = 2) => (Number.isFinite(v) ? Number(v.toFixed(dp)) : null)

function priceDp(price: number): number {
  if (price >= 1000) return 1
  if (price >= 10) return 2
  if (price >= 1) return 4
  return 6
}

function tail(arr: number[], n: number, dp: number) {
  return arr.slice(-n).map((v) => fmt(v, dp))
}

function tfBlock(s: TimeframeStats, dp: number, n: number) {
  return {
    close: tail(s.closes, n, dp),
    ema20: tail(s.ema20, n, dp),
    ema50_last: fmt(s.ema50[s.ema50.length - 1]!, dp),
    rsi7: tail(s.rsi7, n, 1),
    rsi14: tail(s.rsi14, n, 1),
    macd_hist: tail(s.macdHist, n, dp + 1),
    atr3: fmt(s.atr3, dp),
    atr14: fmt(s.atr14, dp),
    volume_last_vs_avg: fmt(s.volumeLast / (s.volumeAvg || 1), 2),
  }
}

export function buildSystemPrompt(symbols: string[], risk: RiskConfig, lang: 'zh' | 'en', v2?: V2PromptInfo): string {
  const langLine =
    lang === 'zh' ? 'Write "analysis" and every "reason" in Simplified Chinese.' : 'Write "analysis" and "reason" in English.'
  return `You are an autonomous trader managing a paper-trading account of USDC-margined perpetual futures on Hyperliquid.
Your only objective is to maximise risk-adjusted return (net of fees and funding) over the competition.
You are competing against other AI models that receive exactly the same data.

Tradable symbols: ${symbols.join(', ')}.

Mechanics:
- Isolated margin. Each position's max loss is its margin. You may hold at most one position per symbol.
- Taker fee is charged on open and close; slippage applies; hourly funding is charged on open positions
  (positive funding: longs pay shorts). Over-trading destroys returns.
- Hard limits enforced by the system (requests beyond them are clamped or rejected):
  leverage <= ${risk.maxLeverage}x, margin per new position <= ${(risk.maxMarginPctPerTrade * 100).toFixed(0)}% of equity,
  total margin <= ${(risk.maxTotalMarginPct * 100).toFixed(0)}% of equity, at most ${risk.maxOpenPositions} open positions,
  stop-loss distance between ${(risk.minStopLossPct * 100).toFixed(1)}% and ${(risk.maxStopLossPct * 100).toFixed(0)}% of price,
  positions auto-close after ${risk.maxHoldingHours}h, new positions are blocked after a ${(risk.noNewPositionDrawdownPct * 100).toFixed(0)}% drawdown
  from peak equity, and everything is liquidated and trading halted at ${(risk.forceCloseDrawdownPct * 100).toFixed(0)}%.
- Stop loss / take profit are checked by the system every few seconds; you do not need to watch them.

Data notes:
- ALL series are ordered OLDEST -> NEWEST. The last element is the most recent.
- "intraday" uses 15-minute candles, "higher" uses 4-hour candles.
- funding_rate_hourly is a fraction (0.0000125 = 0.00125% per hour).

Respond with ONE JSON object and nothing else:
{
  "analysis": "short market read",
  "actions": [
    {
      "symbol": "BTC",
      "action": "open_long | open_short | close | adjust | hold",
      "margin_pct": 0.1,          // open only: fraction of equity used as margin
      "leverage": 3,              // open only: integer
      "stop_loss": 0,             // open (required) / adjust: absolute price
      "take_profit": 0,           // optional, absolute price
      "confidence": 0.6,          // 0-1
      "reason": "why"
    }
  ]
}
Use "adjust" to move stop_loss / take_profit on an existing position. Symbols you do not mention are left unchanged.
Returning an empty actions list (do nothing) is a perfectly valid decision.
${langLine}${v2 ? (v2.v3 ? v3Section(risk, v2, v2.v3, lang) : v2Section(risk, v2, lang)) : ''}${v2?.confirmedSignals ? confirmationSection : ''}`
}

function v2Section(risk: RiskConfig, v2: V2PromptInfo, lang: 'zh' | 'en'): string {
  const rt = roundTripCostPct(v2.feeRate, v2.slippageBps) * 100
  const notesLang = lang === 'zh' ? 'in Simplified Chinese' : 'in English'
  return `

Memory and costs (read carefully):
- You are called every few minutes but you have NO memory between calls except what is shown under YOUR ACCOUNT -> memory.
  Use the top-level "notes" field to write your current plan for the next call: market view, what you are waiting for,
  and when you would act. Max ${v2.notesMaxChars} characters, ${notesLang}. It is shown back to you next time, verbatim.
- Every open position shows its entry_reason and invalidation. Only close a position when its invalidation has happened
  or the thesis clearly changed; normal noise is not a reason. Flip-flopping is the most expensive mistake.
- A full round trip (open + close) costs about ${rt.toFixed(2)}% of notional in fees and slippage, i.e. about
  ${(rt * 3).toFixed(1)}% of margin at 3x and ${(rt * risk.maxLeverage).toFixed(1)}% at ${risk.maxLeverage}x, before funding. A trade must aim to move much more than that.
- After a position on a symbol is closed (for any reason) it cannot be re-opened for ${v2.cooldownMinutes} minutes.
- Stop distance must be at least min_stop_pct for that symbol (based on the 4h ATR); tighter stops are widened by the system.
  Stops inside normal volatility get hit by noise. Size the position so that the wider stop is still an acceptable loss.
- When opening, add "invalidation" to the action: the concrete market condition that would prove the trade wrong.
Add "notes": "..." as a top-level field next to "analysis".`
}

function v3Section(risk: RiskConfig, c: { feeRate: number; slippageBps: number }, v3: StrategyV3Config, lang: 'zh' | 'en'): string {
  const rt = roundTripCostPct(c.feeRate, c.slippageBps) * 100
  const notesLang = lang === 'zh' ? 'in Simplified Chinese' : 'in English'
  const g = v3.stopGuard
  return `

How this account works (read carefully, it overrides the generic notes above):
- You are called about once every ${v3.decisionIntervalMinutes} minutes. Trade the 4h structure; the 15m data is only for timing.
  Stops and take-profits are still checked by the system every few seconds between calls.
- POSITION SIZE IS SET BY THE SYSTEM. margin_pct and leverage are ignored. You choose direction, stop_loss, take_profit
  and invalidation. The system sizes every new position so that being stopped out loses about
  ${(v3.riskPerTradePct * 100).toFixed(1)}% of equity including costs. A wider stop simply means a smaller position.
- Stop distance must be at least min_stop_pct for that symbol (${v3.stopAtrMult}x the 4h ATR14); tighter stops are widened.
  Put the stop where the trade idea is clearly wrong, not inside normal volatility.
- A full round trip costs about ${rt.toFixed(2)}% of notional in fees and slippage, before funding. Only take trades whose
  realistic target is several times the stop distance's worth of cost; an empty actions list is often the best decision.
- You have NO memory between calls except YOUR ACCOUNT -> memory. Use the top-level "notes" field (max ${v3.notesMaxChars} characters,
  ${notesLang}) for your plan: market view, levels you are waiting for, what would make you act. It is shown back next time.
- Every open position shows its entry_reason and invalidation. Only close a position when its invalidation has happened
  or the thesis clearly changed. Normal noise is not a reason; flip-flopping is the most expensive mistake.
- There is no cooldown after taking profit or closing. But after ${g.count} losing stop-outs on the same symbol and side within
  ${g.lookbackHours}h, that side of that symbol is locked for ${g.lockHours}h (see locked_sides_minutes_left).
- When opening, add "invalidation": the concrete market condition that would prove the trade wrong.
Add "notes": "..." as a top-level field next to "analysis".`
}

const confirmationSection = `

V3.1 confirmed exit experiment (overrides discretionary closing above):
- higher_4h_confirmed contains ONLY completed 4h candles, with closed_at_utc. higher_4h is explicitly LIVE and may change.
- For structural decisions use completed candles. Live price and 15m data are for entry timing, not proof of a 4h close.
- Every open MUST include exit_rule: {"kind":"close_below","price":85000} for a LONG,
  or {"kind":"close_above","price":90000} for a SHORT. Choose a fixed positive price where the thesis fails.
- The latest confirmed close must not already trigger the rule. The rule is stored at entry and cannot be edited.
- A model close is permitted ONLY after a NEW 4h candle closes after entry and its close triggers the stored exit_rule.
  An intrabar move or a changed narrative does not qualify. Include the actual close time and price in your reason.
- Missing/stale confirmed data blocks opens and model closes. Hard stops, take-profits, time limits and drawdown exits remain active.
- System sizing, initial ATR floor and hourly cadence are the same as V3. Do not use adjust to imitate an immediate close.
`

export function buildUserPrompt(market: MarketSnapshot, account: AccountView): string {
  const marketData: Record<string, unknown> = {}
  for (const [sym, s] of Object.entries(market.symbols)) {
    const dp = priceDp(s.price)
    marketData[sym] = {
      price: fmt(s.price, dp),
      change_24h_pct: s.prevDayPrice ? fmt(((s.price - s.prevDayPrice) / s.prevDayPrice) * 100, 2) : null,
      funding_rate_hourly: s.fundingRate,
      open_interest: s.openInterest != null ? fmt(s.openInterest, 2) : null,
      intraday_15m: tfBlock(s.intraday, dp, 10),
      higher_4h: tfBlock(s.higher, dp, 10),
      ...(account.confirmedSignals ? {
        higher_4h_status: 'forming_bar_may_be_included',
        higher_4h_confirmed: s.confirmedHigher ? {
          ...tfBlock(s.confirmedHigher.stats, dp, 10),
          closed_at_utc: new Date(s.confirmedHigher.closedAt).toISOString(),
          close_exact: s.confirmedHigher.stats.closes.at(-1),
        } : null,
      } : {}),
    }
  }
  const acct = {
    minutes_since_start: Math.round(account.minutesSinceStart),
    invocation: account.invocationCount,
    equity: fmt(account.equity),
    cash: fmt(account.cash),
    return_pct: fmt(((account.equity - account.initialCapital) / account.initialCapital) * 100, 2),
    drawdown_from_peak_pct: fmt(
      account.peakEquity > 0 ? ((account.peakEquity - account.equity) / account.peakEquity) * 100 : 0,
      2,
    ),
    positions: account.positions.map((p) => ({
      symbol: p.symbol,
      side: p.side,
      quantity: fmt(p.quantity, 6),
      entry_price: p.entryPrice,
      current_price: p.currentPrice,
      leverage: p.leverage,
      margin: fmt(p.margin),
      unrealized_pnl: fmt(p.unrealizedPnl),
      stop_loss: p.stopLoss,
      take_profit: p.takeProfit,
      held_minutes: Math.round(p.heldMinutes),
      ...(account.confirmedSignals ? { exit_rule: p.exitRule ?? null } : {}),
      ...(account.memory ? { entry_reason: p.entryReason ?? null, invalidation: p.invalidation ?? null } : {}),
    })),
    last_closed_trades: account.recentTrades.map((t) => ({ ...t, pnl: fmt(t.pnl) })),
  }
  if (account.memory) {
    const mem = account.memory
    Object.assign(acct, {
      memory: {
        your_notes_from_last_call: mem.lastNotes
          ? { minutes_ago: Math.round(mem.lastNotes.minutesAgo), notes: mem.lastNotes.text }
          : null,
        last_24h: {
          closed_trades: mem.last24h.closedTrades,
          stopped_out: mem.last24h.stopLossCount,
          fees_and_funding_paid: fmt(mem.last24h.feesAndFunding),
          net_pnl_after_costs: fmt(mem.last24h.netPnl),
        },
        ...(mem.locks ? { locked_sides_minutes_left: mem.locks } : { cooldown_minutes_left: mem.cooldowns }),
        min_stop_pct: Object.fromEntries(Object.entries(mem.minStopPct).map(([k, v]) => [k, fmt(v * 100, 2)])),
      },
    })
  }
  return `Current time (UTC): ${new Date(market.ts).toISOString()}

MARKET DATA
${JSON.stringify(marketData)}

YOUR ACCOUNT
${JSON.stringify(acct)}

Decide your actions now. Reply with the JSON object only.`
}

// ---------------------------------------------------------------- parsing

const ACTION_ALIASES: Record<string, ActionType> = {
  open_long: 'open_long',
  long: 'open_long',
  buy: 'open_long',
  open_short: 'open_short',
  short: 'open_short',
  sell: 'open_short',
  close: 'close',
  exit: 'close',
  adjust: 'adjust',
  update: 'adjust',
  hold: 'hold',
  wait: 'hold',
}

/** Extracts the first balanced top-level JSON object from free text. */
export function extractJsonObject(text: string): string | null {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '')
  const start = cleaned.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i]!
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return cleaned.slice(start, i + 1)
    }
  }
  return null
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : (v as number)
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}

export interface ParsedDecision {
  analysis: string
  actions: ModelAction[]
  /** v2 working memory (top-level "notes"); untrimmed — the engine caps the length. */
  notes?: string
}

export function parseDecision(text: string): ParsedDecision {
  const jsonText = extractJsonObject(text)
  if (!jsonText) throw new Error('no JSON object found in model response')
  let obj: any
  try {
    obj = JSON.parse(jsonText)
  } catch {
    // Strip // comments and trailing commas, which some models emit.
    const relaxed = jsonText.replace(/\/\/[^\n"]*$/gm, '').replace(/,\s*([}\]])/g, '$1')
    obj = JSON.parse(relaxed)
  }
  const rawActions: any[] = Array.isArray(obj.actions) ? obj.actions : obj.action ? [obj] : []
  const actions: ModelAction[] = []
  for (const a of rawActions) {
    if (!a || typeof a !== 'object') continue
    const act = ACTION_ALIASES[String(a.action ?? a.operation ?? '').toLowerCase().trim()]
    if (!act) continue
    actions.push({
      symbol: String(a.symbol ?? a.coin ?? '').toUpperCase().replace(/[-/].*$/, ''),
      action: act,
      margin_pct: num(a.margin_pct ?? a.target_portion_of_balance),
      leverage: num(a.leverage),
      stop_loss: num(a.stop_loss),
      take_profit: num(a.take_profit),
      confidence: num(a.confidence),
      reason: a.reason != null ? String(a.reason) : undefined,
      ...(parseExitRule(a.exit_rule) ? { exit_rule: parseExitRule(a.exit_rule)! } : {}),
      ...(a.invalidation != null && String(a.invalidation).trim() ? { invalidation: String(a.invalidation).slice(0, 300) } : {}),
    })
  }
  const notes = obj.notes != null ? (typeof obj.notes === 'string' ? obj.notes : JSON.stringify(obj.notes)) : undefined
  return { analysis: String(obj.analysis ?? obj.reason ?? '').slice(0, 2000), actions, ...(notes ? { notes } : {}) }
}
