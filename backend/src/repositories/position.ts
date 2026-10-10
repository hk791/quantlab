/** Port of `repositories/position_repo.py`. */
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { positions, type Position } from '../db/schema.js'

export function listPositions(accountId: number): Position[] {
  return db
    .select()
    .from(positions)
    .where(eq(positions.accountId, accountId))
    .all()
}

export function getPosition(
  accountId: number,
  symbol: string,
  market: string,
): Position | undefined {
  return db
    .select()
    .from(positions)
    .where(
      and(
        eq(positions.accountId, accountId),
        eq(positions.symbol, symbol),
        eq(positions.market, market),
      ),
    )
    .get()
}

export function insertPosition(
  values: typeof positions.$inferInsert,
): Position {
  return db.insert(positions).values(values).returning().get()
}

export function updatePosition(
  positionId: number,
  values: Partial<typeof positions.$inferInsert>,
): Position | undefined {
  return db
    .update(positions)
    .set(values)
    .where(eq(positions.id, positionId))
    .returning()
    .get()
}

export function deletePosition(positionId: number): void {
  db.delete(positions).where(eq(positions.id, positionId)).run()
}
