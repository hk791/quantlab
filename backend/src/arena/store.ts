/**
 * Arena-specific persistence. Kept in separate `arena_*` tables (raw SQL via
 * better-sqlite3) so the upstream schema stays untouched.
 */
import { rawDb } from '../db/client.js'
import { utcNow } from '../utils/datetime.js'

export function ensureArenaSchema(): void {
  rawDb.exec(`
CREATE TABLE IF NOT EXISTS arena_ema_state (
  account_id INTEGER PRIMARY KEY,
  bar INTEGER NOT NULL,
  side TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS arena_ema_events (
  account_id INTEGER NOT NULL,
  bar INTEGER NOT NULL,
  side TEXT NOT NULL,
  signal_json TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  ts INTEGER NOT NULL,
  PRIMARY KEY (account_id, bar)
);
CREATE TABLE IF NOT EXISTS arena_account_state (
  account_id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,              -- 'llm' | 'baseline'
  strategy TEXT,                   -- baseline id, or model id
  peak_equity REAL NOT NULL,
  halted INTEGER NOT NULL DEFAULT 0,
  halted_reason TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS arena_position_meta (
  account_id INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  entry_price REAL NOT NULL,
  quantity REAL NOT NULL,
  leverage INTEGER NOT NULL,
  margin REAL NOT NULL,
  stop_loss REAL,
  take_profit REAL,
  opened_at TEXT NOT NULL,
  entry_reason TEXT,
  entry_fee REAL NOT NULL DEFAULT 0,
  funding_paid REAL NOT NULL DEFAULT 0,
  last_funding_ts INTEGER NOT NULL,
  PRIMARY KEY (account_id, symbol)
);
CREATE TABLE IF NOT EXISTS arena_closed_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  leverage INTEGER NOT NULL,
  quantity REAL NOT NULL,
  entry_price REAL NOT NULL,
  exit_price REAL NOT NULL,
  pnl REAL NOT NULL,               -- net: price PnL - open/close fees - funding
  fees REAL NOT NULL,
  funding REAL NOT NULL,
  close_reason TEXT NOT NULL,      -- model | stop_loss | take_profit | timeout | liquidation | drawdown_halt | baseline
  opened_at INTEGER NOT NULL,      -- epoch ms
  closed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_arena_closed_trades_account ON arena_closed_trades (account_id);
CREATE TABLE IF NOT EXISTS arena_equity_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,             -- epoch ms
  equity REAL NOT NULL,
  cash REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_arena_equity_account_ts ON arena_equity_snapshots (account_id, ts);
CREATE TABLE IF NOT EXISTS arena_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  model TEXT,
  latency_ms INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  analysis TEXT,
  raw_response TEXT,
  actions_json TEXT,               -- parsed actions as requested by the model
  results_json TEXT,               -- what the risk layer / executor did with each
  error TEXT
);
CREATE INDEX IF NOT EXISTS ix_arena_decisions_account_ts ON arena_decisions (account_id, ts);
CREATE TABLE IF NOT EXISTS arena_trade_outcomes (
  trade_id INTEGER PRIMARY KEY,    -- arena_closed_trades.id
  account_id INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  entry_price REAL NOT NULL,
  exit_price REAL NOT NULL,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER NOT NULL,
  close_reason TEXT NOT NULL,
  pnl REAL NOT NULL,
  ret_15m_pct REAL,                -- favourable-signed move from entry after 15m / 1h / 4h
  ret_1h_pct REAL,
  ret_4h_pct REAL,
  mfe_pct REAL,                    -- best favourable excursion while held
  mae_pct REAL,                    -- worst adverse excursion while held (<= 0)
  post_exit_4h_pct REAL,           -- favourable-signed move from exit over the 4h after closing
  reclaimed_entry_4h INTEGER,      -- 1 if price came back through entry (in our favour) within 4h of exit
  computed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_arena_outcomes_account ON arena_trade_outcomes (account_id);
`)
  // Additive migrations (old databases keep working; v1 rows just have NULLs).
  addColumn('arena_decisions', 'strategy_version', 'TEXT')
  addColumn('arena_decisions', 'notes', 'TEXT')
  addColumn('arena_position_meta', 'invalidation', 'TEXT')
  addColumn('arena_closed_trades', 'entry_reason', 'TEXT')
  addColumn('arena_closed_trades', 'invalidation', 'TEXT')
  addColumn('arena_position_meta', 'exit_rule_json', 'TEXT')
  addColumn('arena_closed_trades', 'exit_rule_json', 'TEXT')
  addColumn('arena_decisions', 'snapshot_ts', 'INTEGER')
  addColumn('arena_decisions', 'confirmation_json', 'TEXT')
}

function addColumn(table: string, column: string, type: string): void {
  const cols = rawDb.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (!cols.some((c) => c.name === column)) rawDb.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
}

// ---------------------------------------------------------------- account state

export interface ArenaAccountState {
  account_id: number
  kind: 'llm' | 'baseline'
  strategy: string | null
  peak_equity: number
  halted: number
  halted_reason: string | null
}

export function getAccountState(accountId: number): ArenaAccountState | undefined {
  return rawDb
    .prepare('SELECT * FROM arena_account_state WHERE account_id = ?')
    .get(accountId) as ArenaAccountState | undefined
}

export function upsertAccountState(
  accountId: number,
  kind: 'llm' | 'baseline',
  strategy: string,
  initialEquity: number,
): void {
  rawDb
    .prepare(
      `INSERT INTO arena_account_state (account_id, kind, strategy, peak_equity, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET kind = excluded.kind, strategy = excluded.strategy`,
    )
    .run(accountId, kind, strategy, initialEquity, utcNow())
}

export function updatePeakEquity(accountId: number, equity: number): number {
  const state = getAccountState(accountId)
  const peak = Math.max(state?.peak_equity ?? equity, equity)
  rawDb
    .prepare('UPDATE arena_account_state SET peak_equity = ?, updated_at = ? WHERE account_id = ?')
    .run(peak, utcNow(), accountId)
  return peak
}

export function haltAccount(accountId: number, reason: string): void {
  rawDb
    .prepare('UPDATE arena_account_state SET halted = 1, halted_reason = ?, updated_at = ? WHERE account_id = ?')
    .run(reason, utcNow(), accountId)
}

export function listArenaStates(): ArenaAccountState[] {
  return rawDb.prepare('SELECT * FROM arena_account_state').all() as ArenaAccountState[]
}

// ---------------------------------------------------------------- position meta

export interface PositionMeta {
  account_id: number
  symbol: string
  side: 'LONG' | 'SHORT'
  entry_price: number
  quantity: number
  leverage: number
  margin: number
  stop_loss: number | null
  take_profit: number | null
  /** epoch ms */
  opened_at: number
  entry_reason: string | null
  entry_fee: number
  funding_paid: number
  last_funding_ts: number
  /** v2: what would prove the trade wrong. */
  invalidation?: string | null
  exit_rule_json?: string | null
}

export function savePositionMeta(m: PositionMeta): void {
  rawDb
    .prepare(
      `INSERT OR REPLACE INTO arena_position_meta
       (account_id, symbol, side, entry_price, quantity, leverage, margin, stop_loss, take_profit, opened_at, entry_reason, entry_fee, funding_paid, last_funding_ts, invalidation, exit_rule_json)
       VALUES (@account_id, @symbol, @side, @entry_price, @quantity, @leverage, @margin, @stop_loss, @take_profit, @opened_at, @entry_reason, @entry_fee, @funding_paid, @last_funding_ts, @invalidation, @exit_rule_json)`,
    )
    .run({ ...m, invalidation: m.invalidation ?? null, exit_rule_json: m.exit_rule_json ?? null })
}

export function listAllPositionMeta(): PositionMeta[] {
  return rawDb.prepare('SELECT * FROM arena_position_meta').all() as PositionMeta[]
}

export function updateStops(accountId: number, symbol: string, stopLoss: number | null, takeProfit: number | null): void {
  rawDb
    .prepare('UPDATE arena_position_meta SET stop_loss = ?, take_profit = ? WHERE account_id = ? AND symbol = ?')
    .run(stopLoss, takeProfit, accountId, symbol)
}

export function addFunding(accountId: number, symbol: string, amount: number, ts: number): void {
  rawDb
    .prepare('UPDATE arena_position_meta SET funding_paid = funding_paid + ?, last_funding_ts = ? WHERE account_id = ? AND symbol = ?')
    .run(amount, ts, accountId, symbol)
}

export function getPositionMeta(accountId: number, symbol: string): PositionMeta | undefined {
  return rawDb
    .prepare('SELECT * FROM arena_position_meta WHERE account_id = ? AND symbol = ?')
    .get(accountId, symbol) as PositionMeta | undefined
}

export function listPositionMeta(accountId: number): PositionMeta[] {
  return rawDb
    .prepare('SELECT * FROM arena_position_meta WHERE account_id = ?')
    .all(accountId) as PositionMeta[]
}

export function deletePositionMeta(accountId: number, symbol: string): void {
  rawDb.prepare('DELETE FROM arena_position_meta WHERE account_id = ? AND symbol = ?').run(accountId, symbol)
}

// ---------------------------------------------------------------- closed trades

export interface ClosedTrade {
  id?: number
  account_id: number
  symbol: string
  side: string
  leverage: number
  quantity: number
  entry_price: number
  exit_price: number
  pnl: number
  fees: number
  funding: number
  close_reason: string
  opened_at: number
  closed_at: number
  entry_reason?: string | null
  invalidation?: string | null
  exit_rule_json?: string | null
}

export function insertClosedTrade(t: ClosedTrade): void {
  rawDb
    .prepare(
      `INSERT INTO arena_closed_trades
       (account_id, symbol, side, leverage, quantity, entry_price, exit_price, pnl, fees, funding, close_reason, opened_at, closed_at, entry_reason, invalidation, exit_rule_json)
       VALUES (@account_id, @symbol, @side, @leverage, @quantity, @entry_price, @exit_price, @pnl, @fees, @funding, @close_reason, @opened_at, @closed_at, @entry_reason, @invalidation, @exit_rule_json)`,
    )
    .run({ ...t, entry_reason: t.entry_reason ?? null, invalidation: t.invalidation ?? null, exit_rule_json: t.exit_rule_json ?? null })
}

/** Closed trades of an account since a timestamp (for v2 cooldown / cost awareness). */
export function listClosedTradesSince(accountId: number, sinceTs: number): ClosedTrade[] {
  return rawDb
    .prepare('SELECT * FROM arena_closed_trades WHERE account_id = ? AND closed_at >= ? ORDER BY closed_at')
    .all(accountId, sinceTs) as ClosedTrade[]
}

export function listClosedTrades(accountId: number, limit = 1000): ClosedTrade[] {
  return rawDb
    .prepare('SELECT * FROM arena_closed_trades WHERE account_id = ? ORDER BY id DESC LIMIT ?')
    .all(accountId, limit) as ClosedTrade[]
}

/**
 * One page of closed trades across the given accounts, newest first (dashboard paging).
 * Uses the account index; `total` lets the client draw page numbers.
 */
export function listClosedTradesPage(
  accountIds: number[],
  offset: number,
  limit: number,
): { total: number; rows: ClosedTrade[] } {
  if (!accountIds.length) return { total: 0, rows: [] }
  const ph = accountIds.map(() => '?').join(',')
  const total = (rawDb.prepare(`SELECT COUNT(*) AS n FROM arena_closed_trades WHERE account_id IN (${ph})`).get(...accountIds) as { n: number }).n
  const rows = rawDb
    .prepare(`SELECT * FROM arena_closed_trades WHERE account_id IN (${ph}) ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...accountIds, limit, offset) as ClosedTrade[]
  return { total, rows }
}

// ---------------------------------------------------------------- equity

export function insertEquitySnapshot(accountId: number, equity: number, cash: number, ts = Date.now()): void {
  rawDb
    .prepare('INSERT INTO arena_equity_snapshots (account_id, ts, equity, cash) VALUES (?, ?, ?, ?)')
    .run(accountId, ts, equity, cash)
}

export function listEquitySnapshots(accountId: number, sinceTs = 0): { ts: number; equity: number }[] {
  return rawDb
    .prepare('SELECT ts, equity FROM arena_equity_snapshots WHERE account_id = ? AND ts >= ? ORDER BY ts')
    .all(accountId, sinceTs) as { ts: number; equity: number }[]
}

/**
 * Equity curve thinned to one point per `bucketMs` (the last snapshot in each
 * bucket, via SQLite's bare-column-with-MAX rule). bucketMs <= 0 returns every point.
 */
export function listEquitySnapshotsBucketed(accountId: number, sinceTs: number, bucketMs: number): { ts: number; equity: number }[] {
  if (bucketMs <= 0) return listEquitySnapshots(accountId, sinceTs)
  return rawDb
    .prepare(
      `SELECT MAX(ts) AS ts, equity FROM arena_equity_snapshots WHERE account_id = ? AND ts >= ?
       GROUP BY CAST(ts / ? AS INTEGER) ORDER BY ts`,
    )
    .all(accountId, sinceTs, bucketMs) as { ts: number; equity: number }[]
}

export function lastSnapshotTs(): number {
  const row = rawDb.prepare('SELECT MAX(ts) AS ts FROM arena_equity_snapshots').get() as { ts: number | null }
  return row.ts ?? 0
}

// ---------------------------------------------------------------- decisions

export interface DecisionRecord {
  account_id: number
  ts: number
  model: string | null
  latency_ms: number | null
  prompt_tokens: number | null
  completion_tokens: number | null
  analysis: string | null
  raw_response: string | null
  actions_json: string | null
  results_json: string | null
  error: string | null
  snapshot_ts?: number | null
  confirmation_json?: string | null
  strategy_version?: string | null
  /** v2: the model's own working notes, shown back to it next round. */
  notes?: string | null
}

export function insertDecision(d: DecisionRecord): void {
  rawDb
    .prepare(
      `INSERT INTO arena_decisions
       (account_id, ts, model, latency_ms, prompt_tokens, completion_tokens, analysis, raw_response, actions_json, results_json, error, strategy_version, notes, snapshot_ts, confirmation_json)
       VALUES (@account_id, @ts, @model, @latency_ms, @prompt_tokens, @completion_tokens, @analysis, @raw_response, @actions_json, @results_json, @error, @strategy_version, @notes, @snapshot_ts, @confirmation_json)`,
    )
    .run({ ...d, strategy_version: d.strategy_version ?? null, notes: d.notes ?? null, snapshot_ts: d.snapshot_ts ?? null, confirmation_json: d.confirmation_json ?? null })
}

/** Latest successful decision of an account that left notes (v2 working memory). */
export function lastNotes(accountId: number): { ts: number; notes: string } | undefined {
  return rawDb
    .prepare(
      `SELECT ts, notes FROM arena_decisions WHERE account_id = ? AND error IS NULL AND notes IS NOT NULL AND notes != ''
       ORDER BY id DESC LIMIT 1`,
    )
    .get(accountId) as { ts: number; notes: string } | undefined
}

// ---------------------------------------------------------------- trade outcomes

export interface TradeOutcome {
  trade_id: number
  account_id: number
  symbol: string
  side: string
  entry_price: number
  exit_price: number
  opened_at: number
  closed_at: number
  close_reason: string
  pnl: number
  ret_15m_pct: number | null
  ret_1h_pct: number | null
  ret_4h_pct: number | null
  mfe_pct: number | null
  mae_pct: number | null
  post_exit_4h_pct: number | null
  reclaimed_entry_4h: number | null
  computed_at: number
}

export function upsertOutcome(o: TradeOutcome): void {
  rawDb
    .prepare(
      `INSERT OR REPLACE INTO arena_trade_outcomes
       (trade_id, account_id, symbol, side, entry_price, exit_price, opened_at, closed_at, close_reason, pnl,
        ret_15m_pct, ret_1h_pct, ret_4h_pct, mfe_pct, mae_pct, post_exit_4h_pct, reclaimed_entry_4h, computed_at)
       VALUES (@trade_id, @account_id, @symbol, @side, @entry_price, @exit_price, @opened_at, @closed_at, @close_reason, @pnl,
        @ret_15m_pct, @ret_1h_pct, @ret_4h_pct, @mfe_pct, @mae_pct, @post_exit_4h_pct, @reclaimed_entry_4h, @computed_at)`,
    )
    .run(o)
}

/** Closed trades that have no outcome row yet and closed at least `minAgeMs` ago (so the post-exit window is complete). */
export function tradesPendingOutcome(minAgeMs: number, now = Date.now(), limit = 50): (ClosedTrade & { id: number })[] {
  return rawDb
    .prepare(
      `SELECT t.* FROM arena_closed_trades t LEFT JOIN arena_trade_outcomes o ON o.trade_id = t.id
       WHERE o.trade_id IS NULL AND t.closed_at <= ? AND t.close_reason != 'baseline' ORDER BY t.id LIMIT ?`,
    )
    .all(now - minAgeMs, limit) as (ClosedTrade & { id: number })[]
}

export function listOutcomes(accountId?: number): TradeOutcome[] {
  if (accountId == null) return rawDb.prepare('SELECT * FROM arena_trade_outcomes ORDER BY trade_id').all() as TradeOutcome[]
  return rawDb
    .prepare('SELECT * FROM arena_trade_outcomes WHERE account_id = ? ORDER BY trade_id')
    .all(accountId) as TradeOutcome[]
}

export function listDecisions(accountId: number | null, limit = 50): (DecisionRecord & { id: number })[] {
  if (accountId == null) {
    return rawDb
      .prepare('SELECT * FROM arena_decisions ORDER BY id DESC LIMIT ?')
      .all(limit) as (DecisionRecord & { id: number })[]
  }
  return rawDb
    .prepare('SELECT * FROM arena_decisions WHERE account_id = ? ORDER BY id DESC LIMIT ?')
    .all(accountId, limit) as (DecisionRecord & { id: number })[]
}

/**
 * Decision log page for the dashboard: newest first, cursor-based (`beforeId`),
 * and without `raw_response` (the bulky part; fetched one by one via /raw).
 */
export function listDecisionsPage(
  accountIds: number[],
  beforeId: number | null,
  limit: number,
): (Omit<DecisionRecord, 'raw_response'> & { id: number })[] {
  if (!accountIds.length) return []
  const ph = accountIds.map(() => '?').join(',')
  return rawDb
    .prepare(
      `SELECT id, account_id, ts, model, latency_ms, prompt_tokens, completion_tokens, analysis, actions_json, results_json,
              error, strategy_version, notes, snapshot_ts, confirmation_json
       FROM arena_decisions WHERE account_id IN (${ph}) ${beforeId != null ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT ?`,
    )
    .all(...accountIds, ...(beforeId != null ? [beforeId] : []), limit) as (Omit<DecisionRecord, 'raw_response'> & { id: number })[]
}

/** Raw model output of one decision (indexed lookup, not a table scan). */
export function getDecisionRaw(id: number): { account_id: number; raw_response: string | null } | undefined {
  return rawDb.prepare('SELECT account_id, raw_response FROM arena_decisions WHERE id = ?').get(id) as
    | { account_id: number; raw_response: string | null }
    | undefined
}

/** Token usage totals per account (for cost tracking). */
export function tokenUsage(accountId: number): { calls: number; errors: number; prompt: number; completion: number; measuredCalls: number } {
  const row = rawDb
    .prepare(
      `SELECT COUNT(*) AS calls, COALESCE(SUM(error IS NOT NULL),0) AS errors,
              COALESCE(SUM(prompt_tokens),0) AS prompt, COALESCE(SUM(completion_tokens),0) AS completion,
              COALESCE(SUM(prompt_tokens IS NOT NULL AND completion_tokens IS NOT NULL),0) AS measuredCalls
       FROM arena_decisions WHERE account_id = ?`,
    )
    .get(accountId) as { calls: number; errors: number; prompt: number; completion: number; measuredCalls: number }
  return row
}

/** All-history display totals, including fees/funding on positions still open. */
export function tradingCostTotals(accountId: number) {
  const closed = rawDb.prepare(`SELECT COUNT(*) AS closedTrades,
    COALESCE(SUM(fees),0) AS closedFees, COALESCE(SUM(funding),0) AS closedFunding,
    COALESCE(SUM(quantity * (CASE WHEN side = 'LONG' THEN entry_price ELSE CASE WHEN close_reason != 'liquidation' THEN exit_price ELSE 0 END END)),0) AS buyFillNotional,
    COALESCE(SUM(quantity * (CASE WHEN side = 'SHORT' THEN entry_price ELSE CASE WHEN close_reason != 'liquidation' THEN exit_price ELSE 0 END END)),0) AS sellFillNotional
    FROM arena_closed_trades WHERE account_id = ?`).get(accountId) as {
      closedTrades: number; closedFees: number; closedFunding: number; buyFillNotional: number; sellFillNotional: number;
    }
  const open = rawDb.prepare(`SELECT COALESCE(SUM(entry_fee),0) AS openFees,
    COALESCE(SUM(funding_paid),0) AS openFunding,
    COALESCE(SUM(CASE WHEN side = 'LONG' THEN quantity * entry_price ELSE 0 END),0) AS buyFillNotional,
    COALESCE(SUM(CASE WHEN side = 'SHORT' THEN quantity * entry_price ELSE 0 END),0) AS sellFillNotional
    FROM arena_position_meta WHERE account_id = ?`).get(accountId) as {
      openFees: number; openFunding: number; buyFillNotional: number; sellFillNotional: number;
    }
  return { ...closed, openFees: open.openFees, openFunding: open.openFunding,
    buyFillNotional: closed.buyFillNotional + open.buyFillNotional,
    sellFillNotional: closed.sellFillNotional + open.sellFillNotional }
}

/** Earliest equity snapshot of an account (its start time in this database). */
export function firstSnapshotTs(accountId: number): number | null {
  const row = rawDb.prepare('SELECT MIN(ts) AS ts FROM arena_equity_snapshots WHERE account_id = ?').get(accountId) as {
    ts: number | null
  }
  return row.ts
}
