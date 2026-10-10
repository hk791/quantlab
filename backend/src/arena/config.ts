/**
 * Arena configuration — loaded from `arena.config.json` (path overridable via
 * ARENA_CONFIG). Secrets are never stored in the file: each model references
 * an environment variable that holds its API key.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const here = path.dirname(fileURLToPath(import.meta.url))
export const BACKEND_ROOT = path.resolve(here, '../..')

// Load backend/.env if present (Node >= 20.12). Existing env vars win.
const envFile = path.join(BACKEND_ROOT, '.env')
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envFile)
}

export const ModelSchema = z.object({
  /** Display / account name, must be unique. */
  name: z.string().min(1),
  /** Model id, e.g. "deepseek/deepseek-v4-pro". Use "mock" for a fake model. */
  model: z.string().min(1),
  baseUrl: z.string().default('https://openrouter.ai/api/v1'),
  /** Name of the env var holding the API key. */
  apiKeyEnv: z.string().default('OPENROUTER_API_KEY'),
  temperature: z.number().min(0).max(2).default(0.3),
  maxTokens: z.number().int().positive().default(4000),
  /** Per-request timeout; reasoning models writing long answers need more. */
  timeoutSeconds: z.number().positive().default(300),
  /** Extra provider-specific request fields, e.g. {"thinking":{"type":"enabled"},"reasoning_effort":"high"}. */
  extraBody: z.record(z.unknown()).optional(),
  enabled: z.boolean().default(true),
  /**
   * Strategy version. "v1" = the original prompt/risk path (unchanged).
   * "v2" = adds trading memory (notes, entry thesis, cost awareness) and the
   * extra risk rules in `strategyV2`. Run v2 copies side by side with v1.
   * "v3" = v2's memory + hourly decisions, system-side risk-based sizing,
   * wider ATR stops and a per-side stop guard instead of the blanket cooldown
   * (`strategyV3`). "v3.1" keeps that sizing/cadence and gates model closes
   * on a fixed entry rule evaluated against a completed 4h bar.
   * "ema-filter-v1" = binary entry filtering of fixed closed-hourly EMA signals.
   */
  strategy: z.enum(['v1', 'v2', 'v3', 'v3.1', 'ema-filter-v1']).default('v1'),
})

/** Extra rules that only apply to accounts with strategy "v2". */
const StrategyV2Schema = z.object({
  /** After any close on a symbol, block re-opening it for this long. 0 disables. */
  cooldownMinutes: z.number().min(0).default(60),
  /** Minimum stop distance = this many 4h ATR14 (capped by maxStopLossPct / liquidation). 0 disables. */
  minStopAtrMult: z.number().min(0).default(1),
  /** Max characters of the model's own notes carried to the next round. */
  notesMaxChars: z.number().int().min(0).default(600),
})

/** Rules that only apply to accounts with strategy "v3". */
const StrategyV3Schema = z.object({
  /** v3 accounts decide at most once per this many minutes (aligned to the clock, so they share a snapshot). */
  decisionIntervalMinutes: z.number().positive().default(60),
  /** Minimum stop distance = this many 4h ATR14 (capped by maxStopLossPct). */
  stopAtrMult: z.number().min(0).default(2),
  /** Equity fraction lost when a stop is hit, incl. round-trip costs. Sets the position size. */
  riskPerTradePct: z.number().gt(0).max(0.05).default(0.01),
  /** Stop guard: `count` losing stops on the same symbol+side within `lookbackHours` lock that side for `lockHours`. */
  stopGuard: z
    .object({
      count: z.number().int().min(0).default(2),
      lookbackHours: z.number().positive().default(24),
      lockHours: z.number().min(0).default(4),
    })
    .default({}),
  notesMaxChars: z.number().int().min(0).default(600),
})

const RiskSchema = z.object({
  /** Hard leverage cap, regardless of what the model asks for. */
  maxLeverage: z.number().int().min(1).max(50).default(5),
  /** Max fraction of equity committed as margin to a single new position. */
  maxMarginPctPerTrade: z.number().gt(0).max(1).default(0.25),
  /** Max fraction of equity committed as margin across all positions. */
  maxTotalMarginPct: z.number().gt(0).max(1).default(0.8),
  maxOpenPositions: z.number().int().min(1).default(3),
  /** Used when the model gives no/invalid stop loss (fraction of price). */
  defaultStopLossPct: z.number().gt(0).default(0.03),
  /** Stops further away than this are tightened to it. */
  maxStopLossPct: z.number().gt(0).default(0.1),
  minStopLossPct: z.number().gt(0).default(0.003),
  /** Force-close positions held longer than this. 0 disables. */
  maxHoldingHours: z.number().min(0).default(48),
  /** Drawdown from peak equity that blocks new positions. */
  noNewPositionDrawdownPct: z.number().gt(0).max(1).default(0.25),
  /** Drawdown from peak equity that closes everything and halts the account. */
  forceCloseDrawdownPct: z.number().gt(0).max(1).default(0.4),
  /** Orders below this notional (USD) are skipped. */
  minOrderNotional: z.number().min(0).default(20),
  /** Simulated slippage applied to every fill, in basis points. */
  slippageBps: z.number().min(0).default(5),
})

const ModelBillingSchema = z.discriminatedUnion('mode', [
  z.object({ apiKeyEnv: z.string().min(1), mode: z.literal('subscription'), currency: z.enum(['CNY', 'USD']), monthlyFee: z.number().finite().min(0).optional() }),
  z.object({ apiKeyEnv: z.string().min(1), model: z.string().min(1).optional(), mode: z.literal('usage'), currency: z.enum(['CNY', 'USD']), inputPerMillion: z.number().finite().min(0), outputPerMillion: z.number().finite().min(0) }),
])

const ArenaConfigSchema = z.object({
  enabled: z.boolean().default(true),
  symbols: z.array(z.string()).min(1).default(['BTC', 'ETH', 'SOL']),
  /** How often each model is asked for a decision. */
  decisionIntervalMinutes: z.number().positive().default(15),
  /** How often stop-loss / take-profit / drawdown are checked. */
  monitorIntervalSeconds: z.number().int().positive().default(30),
  /** How often equity snapshots are written (for curves & metrics). */
  snapshotIntervalMinutes: z.number().positive().default(5),
  initialCapital: z.number().positive().default(10000),
  /** Taker fee charged on every fill (Hyperliquid base tier ≈ 0.045%). */
  takerFeeRate: z.number().min(0).default(0.00045),
  /** Charge Hyperliquid hourly funding on open positions. */
  chargeFunding: z.boolean().default(true),
  /** Language for the model's `reason` field. */
  reasonLanguage: z.enum(['zh', 'en']).default('zh'),
  includeNews: z.boolean().default(false),
  models: z.array(ModelSchema).default([]),
  /** Non-LLM control groups. */
  baselines: z
    .array(z.enum(['buy_hold_btc', 'ema_cross_btc', 'ema_rules_v1']))
    .default(['buy_hold_btc', 'ema_cross_btc']),
  risk: RiskSchema.default({}),
  strategyV2: StrategyV2Schema.default({}),
  strategyV3: StrategyV3Schema.default({}),
  /** Display-only billing assumptions; never used for decisions, risk, or ledger entries. */
  reporting: z.object({ modelBilling: z.array(ModelBillingSchema).default([]) }).default({}),
})

export type ArenaConfig = z.infer<typeof ArenaConfigSchema>
export type ArenaModelConfig = z.infer<typeof ModelSchema>
export type RiskConfig = z.infer<typeof RiskSchema>
export type StrategyV2Config = z.infer<typeof StrategyV2Schema>
export type StrategyV3Config = z.infer<typeof StrategyV3Schema>
export type ModelBillingConfig = z.infer<typeof ModelBillingSchema>

export const BASELINE_NAMES: Record<string, string> = {
  buy_hold_btc: 'Baseline: BTC 持有',
  ema_cross_btc: 'Baseline: BTC 均线',
  ema_rules_v1: 'Baseline: BTC 均线 EF1 对照',
}

export function parseArenaConfig(raw: unknown): ArenaConfig {
  return ArenaConfigSchema.parse(raw)
}

let cached: ArenaConfig | null = null

/** Returns null when no config file exists (the app then behaves as upstream). */
export function arenaConfigPath(): string {
  return process.env.ARENA_CONFIG ?? path.join(BACKEND_ROOT, 'arena.config.json')
}

export function loadArenaConfig(): ArenaConfig | null {
  if (cached) return cached
  const file = arenaConfigPath()
  if (!fs.existsSync(file)) return null
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  cached = parseArenaConfig(raw)
  return cached
}

/**
 * Replace only the `models` array in the config file (other hand-written
 * settings are kept as-is). Atomic write: temp file + rename.
 */
export function saveModelsToFile(models: ArenaModelConfig[]): void {
  const file = arenaConfigPath()
  const raw = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
  raw.models = models.map(compactModel)
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n')
  fs.renameSync(tmp, file)
  cached = parseArenaConfig(raw)
}

/** Drop fields equal to their defaults so the JSON stays readable. */
function compactModel(m: ArenaModelConfig): Record<string, unknown> {
  const defaults = ModelSchema.parse({ name: 'x', model: 'x' }) as Record<string, unknown>
  const out: Record<string, unknown> = { name: m.name, model: m.model }
  for (const [k, v] of Object.entries(m)) {
    if (k === 'name' || k === 'model' || v === undefined) continue
    if (k === 'enabled' && v === true) continue
    if (k !== 'enabled' && k !== 'baseUrl' && k !== 'apiKeyEnv' && JSON.stringify(defaults[k]) === JSON.stringify(v)) continue
    out[k] = v
  }
  return out
}

/** Names of *_API_KEY env vars and whether each is set (values are never returned). */
export function apiKeyEnvStatus(): { name: string; set: boolean }[] {
  return Object.keys(process.env)
    .filter((k) => /^[A-Z0-9_]+_API_KEY$/.test(k))
    .sort()
    .map((name) => ({ name, set: !!process.env[name] }))
}

/**
 * Accounts store `env:VAR_NAME` instead of the key itself; resolve it at
 * call time so secrets never land in the SQLite file.
 */
export function resolveApiKey(stored: string | null | undefined): string | null {
  if (!stored) return null
  if (stored.startsWith('env:')) return process.env[stored.slice(4)] || null
  return stored
}
