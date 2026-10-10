/**
 * Factor registry — port of `factors/__init__.py`.
 *
 * The Python version discovered factor modules at runtime with
 * `pkgutil.iter_modules`, collecting each module's `MODULE_FACTORS`. TypeScript
 * has no equivalent that survives bundling/compilation, so factors are
 * registered statically below. Adding a new factor means creating its module
 * and appending its `MODULE_FACTORS` here.
 */
import pl from 'nodejs-polars'
import type { Factor, FactorHistory } from '../types/factor.js'
import { MODULE_FACTORS as MOMENTUM_MODULE_FACTORS } from './momentum.js'
import { MODULE_FACTORS as SUPPORT_MODULE_FACTORS } from './support.js'
import { getLogger } from '../utils/logger.js'

const logger = getLogger('factors')

const REGISTERED_FACTORS: Factor[] = [
  ...MOMENTUM_MODULE_FACTORS,
  ...SUPPORT_MODULE_FACTORS,
]

export function listFactors(): Factor[] {
  return REGISTERED_FACTORS
}

/**
 * pandas `merge(on='Symbol', how='outer')` coalesces the join key into one
 * column. polars' `full` join keeps both sides unless `coalesce` is set.
 */
function outerJoinOnSymbol(left: pl.DataFrame, right: pl.DataFrame): pl.DataFrame {
  return left.join(right, { on: 'Symbol', how: 'full', coalesce: true })
}

function computeFrames(factors: Factor[], history: FactorHistory, topSpot?: pl.DataFrame | null): pl.DataFrame {
  const dfs: pl.DataFrame[] = []

  for (const factor of factors) {
    try {
      const df = factor.compute(history, topSpot ?? null)
      if (df && df.height > 0) {
        if (!df.columns.includes('Symbol')) continue
        dfs.push(df)
      }
    } catch (e) {
      logger.warning(`Factor ${factor.id} failed: ${e}`)
    }
  }

  if (dfs.length === 0) return pl.DataFrame({})

  let result = dfs[0]!
  for (const df of dfs.slice(1)) {
    result = outerJoinOnSymbol(result, df)
  }
  return result
}

/** Compute all registered factor frames and outer-join them by 'Symbol'. */
export function computeAllFactors(
  history: FactorHistory,
  topSpot?: pl.DataFrame | null,
): pl.DataFrame {
  return computeFrames(listFactors(), history, topSpot)
}

/** Compute only selected factor frames and outer-join them by 'Symbol'. */
export function computeSelectedFactors(
  history: FactorHistory,
  topSpot?: pl.DataFrame | null,
  selectedFactorIds?: string[] | null,
): pl.DataFrame {
  if (selectedFactorIds == null) {
    return computeAllFactors(history, topSpot)
  }
  const selected = listFactors().filter((f) => selectedFactorIds.includes(f.id))
  return computeFrames(selected, history, topSpot)
}
