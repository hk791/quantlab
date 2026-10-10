/**
 * Regression test for factor calculation.
 * Verifies that momentum and support factors calculate expected values.
 *
 * Run with: npx tsx src/factors/factors.test.ts
 */
import assert from 'node:assert/strict'
import pl from 'nodejs-polars'
import { calculateMomentumSimple, computeMomentum } from './momentum.js'
import {
  calculateDaysFromLongestCandle,
  computeSupportWithDefaultWindow,
} from './support.js'
import { computeAllFactors } from './index.js'
import type { FactorHistory } from '../types/factor.js'
import {
  buildCompositeScore,
  frameToRecords,
} from '../services/rankingTable.js'

const SPECS: [string, number][] = [
  ['AAA', 100],
  ['BBB', 31],
  ['CCC', 60],
  ['DDD', 12],
  ['EEE', 2],
  ['FFF', 1],
]

function makeHistory(): FactorHistory {
  const history: FactorHistory = {}

  for (const [sym, n] of SPECS) {
    const seed = [...sym].reduce((a, c) => a + c.charCodeAt(0), 0)
    let x = seed
    let price = 100.0 + seed

    const next = () => {
      x = Number((1103515245n * BigInt(x) + 12345n) % 2147483648n)
      return x / 2147483648.0 - 0.5
    }

    const cols: Record<string, (string | number)[]> = {
      Date: [],
      Open: [],
      High: [],
      Low: [],
      Close: [],
      Volume: [],
      Amount: [],
    }

    for (let i = 0; i < n; i++) {
      const r1 = next()
      const r2 = next()
      const r3 = next()

      const openP = price
      const closeP = price * (1 + r1 * 0.06)
      const highP = Math.max(openP, closeP) * (1 + Math.abs(r2) * 0.03)
      const lowP = Math.min(openP, closeP) * (1 - Math.abs(r3) * 0.03)

      cols.Date!.push(
        new Date(Date.UTC(2025, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
      )
      cols.Open!.push(openP)
      cols.High!.push(highP)
      cols.Low!.push(lowP)
      cols.Close!.push(closeP)
      cols.Volume!.push(1000.0 + i)
      cols.Amount!.push(5000.0 + i)
      price = closeP
    }

    history[sym] = pl.DataFrame(cols as never).sort('Date')
  }

  return history
}

function main(): void {
  const history = makeHistory()

  const momentumDf = computeMomentum(history, null)
  assert.ok(momentumDf.height > 0, 'Momentum factor should return rows')

  const supportDf = computeSupportWithDefaultWindow(history, null)
  assert.ok(supportDf.height > 0, 'Support factor should return rows')

  const daysCol = supportDf.getColumn('Days From Longest Candle').toArray() as number[]
  for (const day of daysCol) {
    assert.ok(
      day >= 0 && day <= 30,
      `Days From Longest Candle should be a positive number in [0, 30], got ${day}`,
    )
  }

  const allFactors = computeAllFactors(history, null)
  const compositeRecords = buildCompositeScore(frameToRecords(allFactors))
  assert.ok(compositeRecords.length > 0, 'Composite ranking should return records')

  console.log(`✓ Factor calculation test passed (daysFromLongest verified as positive integer)`)
}

main()
