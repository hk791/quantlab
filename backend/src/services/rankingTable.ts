/**
 * Ranking table post-processing — the pandas tail of `api/ranking_routes.py`,
 * reimplemented on plain records so it stays testable independently of the route.
 */
import type pl from 'nodejs-polars'

export type Record_ = Record<string, unknown>

/** Treats polars nulls and JS NaN the same way `pd.isna` did. */
function isNa(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === 'number' && !Number.isFinite(value))
  )
}

/**
 * Converts a polars frame to plain JSON-safe records, normalising
 * null/NaN/Infinity to null (the `pd.isna(value) -> None` cleanup step).
 */
export function frameToRecords(df: pl.DataFrame | null | undefined): Record_[] {
  if (!df || df.height === 0) return []

  const columns = df.columns
  const series = columns.map((c) => df.getColumn(c).toArray() as unknown[])

  const out: Record_[] = []
  for (let i = 0; i < df.height; i++) {
    const row: Record_ = {}
    for (let c = 0; c < columns.length; c++) {
      const v = series[c]![i]
      row[columns[c]!] = isNa(v) ? null : v
    }
    out.push(row)
  }
  return out
}

/**
 * Adds `Composite Score` (row-wise mean of every column whose name contains
 * "score", skipping nulls) and sorts descending with nulls last.
 *
 * pandas did this with `df[score_cols].mean(axis=1, skipna=True)`; polars has
 * no axis argument, so the horizontal mean is computed directly.
 */
export function buildCompositeScore(records: Record_[]): Record_[] {
  if (records.length === 0) return records

  const scoreColumns = Object.keys(records[0]!).filter((c) =>
    c.toLowerCase().includes('score'),
  )
  if (scoreColumns.length === 0) return records

  const withScore = records.map((row) => {
    let sum = 0
    let count = 0
    for (const col of scoreColumns) {
      const v = row[col]
      if (typeof v === 'number' && Number.isFinite(v)) {
        sum += v
        count += 1
      }
    }
    // All-null row -> NaN in pandas -> null here.
    return { ...row, 'Composite Score': count > 0 ? sum / count : null }
  })

  // Descending, na_position='last'; stable so equal scores keep input order.
  return withScore
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const av = a.row['Composite Score']
      const bv = b.row['Composite Score']
      const aNa = av === null
      const bNa = bv === null
      if (aNa && bNa) return a.index - b.index
      if (aNa) return 1
      if (bNa) return -1
      if (av === bv) return a.index - b.index
      return (bv as number) - (av as number)
    })
    .map((e) => e.row)
}
