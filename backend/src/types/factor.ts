/** Port of the `Factor` dataclass in `models.py`. */
import type pl from 'nodejs-polars'

export interface FactorColumn {
  key: string
  label: string
  type: 'number' | 'score' | string
  sortable?: boolean
}

/** Historical OHLCV frames keyed by symbol. */
export type FactorHistory = Record<string, pl.DataFrame>

export type FactorCompute = (
  history: FactorHistory,
  topSpot?: pl.DataFrame | null,
) => pl.DataFrame

export interface Factor {
  id: string
  name: string
  description: string
  columns: FactorColumn[]
  compute: FactorCompute
}
