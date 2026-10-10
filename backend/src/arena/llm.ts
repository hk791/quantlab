/**
 * OpenAI-compatible chat client used by arena models (OpenRouter, DeepSeek,
 * Qwen/DashScope, OpenAI, local Ollama ... anything speaking /chat/completions).
 *
 * model === "mock" returns a deterministic fake response so the whole
 * pipeline can be exercised without API keys or cost.
 */
import { Agent, fetch } from 'undici'
import { getLogger } from '../utils/logger.js'

const logger = getLogger('arena.llm')

/**
 * undici (Node's fetch) has its own headersTimeout/bodyTimeout of 300s that fire
 * independently of our AbortSignal — slow reasoning models (Hy4 ~5-15 min) died
 * with a bare "fetch failed" before timeoutSeconds. One Agent per timeout value,
 * with both undici timeouts set just above it, so the AbortSignal is the deadline.
 */
const agents = new Map<number, Agent>()
export function dispatcherTimeouts(timeoutMs: number) {
  const t = Math.max(1, Math.ceil(timeoutMs)) + 30_000
  return { headersTimeout: t, bodyTimeout: t }
}
function agentFor(timeoutMs: number): Agent {
  let a = agents.get(timeoutMs)
  if (!a) {
    a = new Agent(dispatcherTimeouts(timeoutMs))
    agents.set(timeoutMs, a)
  }
  return a
}

/** "fetch failed" hides the real reason in `cause`; surface it in logs / arena_decisions.error. */
export function describeError(e: unknown): string {
  if (!(e instanceof Error)) return String(e)
  const c = (e as any).cause
  if (!c) return e.message
  const detail = [c.code, c.message].filter(Boolean).join(' ')
  return detail ? `${e.message} (${detail})` : e.message
}

export interface ChatRequest {
  baseUrl: string
  apiKey: string | null
  model: string
  system: string
  user: string
  temperature: number
  maxTokens: number
  timeoutMs?: number
  /** Provider-specific fields merged into the request body, e.g. DeepSeek's `thinking` / `reasoning_effort`. */
  extraBody?: Record<string, unknown>
}

export interface ChatResponse {
  text: string
  latencyMs: number
  promptTokens: number | null
  completionTokens: number | null
}

/** Request body; extraBody can add fields but never replace model/messages. */
export function buildChatBody(req: ChatRequest): Record<string, unknown> {
  return {
    temperature: req.temperature,
    max_tokens: req.maxTokens,
    ...(req.extraBody ?? {}),
    model: req.model,
    messages: [
      { role: 'system', content: req.system },
      { role: 'user', content: req.user },
    ],
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function chat(req: ChatRequest): Promise<ChatResponse> {
  const started = Date.now()
  if (req.model === 'mock' && req.system.startsWith('你是 EF1')) return { text: JSON.stringify({ allow: true, reason: 'mock：接受规则信号' }), latencyMs: 0, promptTokens: 0, completionTokens: 0 }
  if (req.model === 'mock') return mockResponse(req, started)
  if (!req.apiKey) throw new Error('missing API key')

  const url = `${req.baseUrl.replace(/\/+$/, '')}/chat/completions`
  const body = JSON.stringify(buildChatBody(req))

  const timeoutMs = req.timeoutMs ?? 120_000
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${req.apiKey}`,
          // Optional OpenRouter attribution headers
          'HTTP-Referer': 'https://github.com/etrobot/open-alpha-arena',
          'X-Title': 'open-alpha-arena',
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
        dispatcher: agentFor(timeoutMs),
      })
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
        await sleep(2 ** attempt * 2000 + Math.random() * 1000)
        continue
      }
      if (!res.ok) {
        // 4xx (bad key, bad model name, bad request) won't fix itself — fail fast, no retry.
        const err = new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
        ;(err as any).noRetry = true
        throw err
      }
      const json = (await res.json()) as any
      const msg = json?.choices?.[0]?.message ?? {}
      // Reasoning models (e.g. DeepSeek) may put the answer in `reasoning_content` / `reasoning` when truncated.
      const text: string = msg.content || msg.reasoning_content || msg.reasoning || ''
      if (!text) throw new Error(`empty response: ${JSON.stringify(json).slice(0, 300)}`)
      return {
        text,
        latencyMs: Date.now() - started,
        promptTokens: json?.usage?.prompt_tokens ?? null,
        completionTokens: json?.usage?.completion_tokens ?? null,
      }
    } catch (e) {
      lastErr = e
      if ((e as any)?.noRetry) break
      if (attempt < 2) {
        logger.warning(`LLM call to ${req.model} failed (attempt ${attempt + 1}/3): ${describeError(e)}`)
        await sleep(2 ** attempt * 2000)
      }
    }
  }
  throw new Error(describeError(lastErr))
}

/**
 * Mock model: goes long the first symbol when flat (stop 2% below), closes it
 * when in profit. Pulls price from the prompt JSON.
 */
function mockResponse(req: ChatRequest, started: number): ChatResponse {
  const market = /MARKET DATA\n(.*)\n/.exec(req.user)?.[1]
  const account = /YOUR ACCOUNT\n(.*)\n/.exec(req.user)?.[1]
  const m = market ? JSON.parse(market) : {}
  const a = account ? JSON.parse(account) : { positions: [] }
  const sym = Object.keys(m)[0] ?? 'BTC'
  const price = Number(m[sym]?.price ?? 0)
  const pos = (a.positions as any[]).find((p) => p.symbol === sym)
  let actions: unknown[]
  if (!pos) {
    actions = [
      {
        symbol: sym,
        action: 'open_long',
        margin_pct: 0.1,
        leverage: 2,
        stop_loss: price * 0.98,
        take_profit: price * 1.04,
        confidence: 0.5,
        reason: 'mock：空仓时开多',
      },
    ]
  } else if (pos.unrealized_pnl > 0) {
    actions = [{ symbol: sym, action: 'close', reason: 'mock：盈利平仓' }]
  } else {
    actions = []
  }
  const text = '```json\n' + JSON.stringify({ analysis: 'mock 模型，仅用于测试流程', notes: `mock 笔记：${sym} ${pos ? '持仓中' : '空仓'}`, actions }) + '\n```'
  return { text, latencyMs: Date.now() - started, promptTokens: 0, completionTokens: 0 }
}
