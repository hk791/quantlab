/**
 * Datetime helpers producing the exact string formats already stored in
 * data.db by the Python app.
 *
 * SQLAlchemy wrote naive-UTC strings and SQLite's CURRENT_TIMESTAMP is also
 * UTC, so everything in the database is UTC without a timezone suffix.
 */

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0')
}

/** 'YYYY-MM-DD HH:MM:SS.ffffff' — matches Python `datetime.now(timezone.utc)`. */
export function utcNow(date: Date = new Date()): string {
  return `${utcNowSeconds(date)}.${pad(date.getUTCMilliseconds(), 3)}000`
}

/** 'YYYY-MM-DD HH:MM:SS' — matches SQLite CURRENT_TIMESTAMP. */
export function utcNowSeconds(date: Date = new Date()): string {
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    ` ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  )
}

/** 'YYYY-MM-DD' — matches Python `date.today()` / SQLAlchemy Date columns. */
export function utcDateStr(date: Date = new Date()): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

/**
 * Parses the naive-UTC strings stored in the database back into a Date.
 * Returns null for null/unparseable input rather than an Invalid Date.
 */
export function parseDbDate(value: string | null | undefined): Date | null {
  if (!value) return null
  // Already ISO-with-zone? Trust it.
  const iso = /[zZ]|[+-]\d{2}:\d{2}$/.test(value)
    ? value
    : `${value.replace(' ', 'T')}Z`
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Milliseconds since epoch for a stored timestamp, or 0 when absent. */
export function dbDateMs(value: string | null | undefined): number {
  return parseDbDate(value)?.getTime() ?? 0
}

/** Shifts a date by whole days, preserving time of day. */
export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000)
}
