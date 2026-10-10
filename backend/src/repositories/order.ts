/** Port of `repositories/order_repo.py`. */
import { desc, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { orders, type Order } from '../db/schema.js'

export function createOrder(values: typeof orders.$inferInsert): Order {
  return db.insert(orders).values(values).returning().get()
}

export function listOrders(accountId: number): Order[] {
  return db
    .select()
    .from(orders)
    .where(eq(orders.accountId, accountId))
    .orderBy(desc(orders.createdAt))
    .all()
}

export function getOrderByNo(orderNo: string): Order | undefined {
  return db.select().from(orders).where(eq(orders.orderNo, orderNo)).get()
}

export function getOrder(orderId: number): Order | undefined {
  return db.select().from(orders).where(eq(orders.id, orderId)).get()
}
