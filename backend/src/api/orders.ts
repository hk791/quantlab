/**
 * Order Management API Routes.
 * Provides functionality for creating, querying, and canceling orders.
 * Port of `api/order_routes.py`.
 */
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { accounts, orders as ordersTable, users } from '../db/schema.js'
import {
  cancelOrder,
  checkAndExecuteOrder,
  createOrder,
  getPendingOrders,
  processAllPendingOrders,
} from '../services/orderMatching.js'
import {
  setUserPassword,
  userHasPassword,
  verifyAuthSession,
  verifyUserPassword,
} from '../repositories/user.js'
import { orderCreateRequestSchema } from '../schemas/index.js'
import { serializeOrder } from './serializers.js'
import { getLogger } from '../utils/logger.js'

const logger = getLogger('api.orders')

export const orderRoutes = new Hono()

/** Create a new order. */
orderRoutes.post('/create', async (c) => {
  let request: ReturnType<typeof orderCreateRequestSchema.parse>
  try {
    request = orderCreateRequestSchema.parse(await c.req.json())
  } catch (e) {
    throw new HTTPException(422, { message: `Invalid request body: ${e}` })
  }

  try {
    const user = db.select().from(users).where(eq(users.id, request.user_id)).get()
    if (!user) throw new HTTPException(404, { message: 'User not found' })

    // Authentication: supports either session_token or username+password
    if (request.session_token) {
      const sessionUserId = verifyAuthSession(request.session_token)
      if (sessionUserId !== request.user_id) {
        throw new HTTPException(401, {
          message: 'Invalid or expired session',
        })
      }
    } else if (request.username && request.password) {
      if (user.username !== request.username) {
        throw new HTTPException(401, { message: 'Username does not match' })
      }

      if (!userHasPassword(request.user_id)) {
        // First transaction, set password
        if (request.password.trim().length < 4) {
          throw new HTTPException(400, {
            message: 'Password must be at least 4 characters',
          })
        }
        if (!setUserPassword(request.user_id, request.password)) {
          throw new HTTPException(500, {
            message: 'Failed to set trading password',
          })
        }
        logger.info(
          `User ${request.user_id} first transaction, trading password set`,
        )
      } else if (!verifyUserPassword(request.user_id, request.password)) {
        throw new HTTPException(401, { message: 'Incorrect trading password' })
      }
    } else {
      throw new HTTPException(400, {
        message: 'Please provide either session token or username+password',
      })
    }

    // Resolve trading account for the user (the default user is seeded with one)
    const account = db
      .select()
      .from(accounts)
      .where(and(eq(accounts.userId, user.id), eq(accounts.isActive, 'true')))
      .get()

    if (!account) {
      throw new HTTPException(404, {
        message: 'Active trading account not found for user',
      })
    }

    const order = await createOrder({
      account,
      symbol: request.symbol,
      name: request.name,
      side: request.side,
      orderType: request.order_type,
      price: request.price,
      quantity: request.quantity,
    })

    logger.info(`User ${user.username} created order: ${order.orderNo}`)
    return c.json(serializeOrder(order))
  } catch (e) {
    if (e instanceof HTTPException) throw e
    logger.error(`Failed to create order: ${e}`)
    // Validation failures from the matching engine map to 400, as ValueError did
    throw new HTTPException(400, { message: String((e as Error).message ?? e) })
  }
})

/** Get pending orders; without `user_id`, returns them for all accounts. */
orderRoutes.get('/pending', (c) => {
  try {
    const raw = c.req.query('user_id')
    const accountId = raw != null ? Number(raw) : undefined
    const orders = getPendingOrders(
      accountId !== undefined && Number.isFinite(accountId)
        ? accountId
        : undefined,
    )
    return c.json(orders.map(serializeOrder))
  } catch (e) {
    logger.error(`Failed to get pending orders: ${e}`)
    throw new HTTPException(500, {
      message: `Failed to get pending orders: ${e}`,
    })
  }
})

/**
 * Get all orders for an account.
 *
 * NOTE: the Python original filtered `Order.user_id`, a column that does not
 * exist on the model (orders are keyed by account_id, and `/pending` already
 * treated this path parameter as an account id). Filtering by account_id here
 * makes the route work as intended.
 */
orderRoutes.get('/user/:userId', (c) => {
  try {
    const accountId = Number(c.req.param('userId'))
    const status = c.req.query('status')

    const where = status
      ? and(
          eq(ordersTable.accountId, accountId),
          eq(ordersTable.status, status),
        )
      : eq(ordersTable.accountId, accountId)

    const rows = db
      .select()
      .from(ordersTable)
      .where(where)
      .orderBy(desc(ordersTable.createdAt))
      .all()

    return c.json(rows.map(serializeOrder))
  } catch (e) {
    logger.error(`Failed to get user orders: ${e}`)
    throw new HTTPException(500, { message: `Failed to get user orders: ${e}` })
  }
})

/** Manually execute a specific order (checks execution conditions). */
orderRoutes.post('/execute/:orderId', async (c) => {
  const orderId = Number(c.req.param('orderId'))
  try {
    const order = db
      .select()
      .from(ordersTable)
      .where(eq(ordersTable.id, orderId))
      .get()

    if (!order) throw new HTTPException(404, { message: 'Order not found' })

    if (order.status !== 'PENDING') {
      return c.json({
        order_id: orderId,
        executed: false,
        message: `Order status is ${order.status}, cannot execute`,
      })
    }

    const executed = await checkAndExecuteOrder(order)
    return c.json({
      order_id: orderId,
      executed,
      message: executed
        ? 'Order executed successfully'
        : 'Order does not meet execution conditions',
    })
  } catch (e) {
    if (e instanceof HTTPException) throw e
    logger.error(`Failed to execute order: ${e}`)
    throw new HTTPException(500, { message: `Failed to execute order: ${e}` })
  }
})

/** Cancel an order. */
orderRoutes.post('/cancel/:orderId', (c) => {
  const orderId = Number(c.req.param('orderId'))
  const reason = c.req.query('reason') ?? 'User cancelled'

  try {
    const order = db
      .select()
      .from(ordersTable)
      .where(eq(ordersTable.id, orderId))
      .get()

    if (!order) throw new HTTPException(404, { message: 'Order not found' })

    if (order.status !== 'PENDING') {
      throw new HTTPException(400, {
        message: `Order status is ${order.status}, cannot be cancelled`,
      })
    }

    if (!cancelOrder(order, reason)) {
      throw new HTTPException(500, { message: 'Failed to cancel order' })
    }

    return c.json({ message: 'Order cancelled successfully', order_id: orderId })
  } catch (e) {
    if (e instanceof HTTPException) throw e
    logger.error(`Failed to cancel order: ${e}`)
    throw new HTTPException(500, { message: `Failed to cancel order: ${e}` })
  }
})

/** Process all pending orders. */
orderRoutes.post('/process-all', async (c) => {
  try {
    const [executedCount, totalChecked] = await processAllPendingOrders()
    return c.json({
      executed_count: executedCount,
      total_checked: totalChecked,
      message: `Processing complete: Checked ${totalChecked} orders, executed ${executedCount}`,
    })
  } catch (e) {
    logger.error(`Failed to process orders: ${e}`)
    throw new HTTPException(500, { message: `Failed to process orders: ${e}` })
  }
})

/** Get order details. */
orderRoutes.get('/order/:orderId', (c) => {
  const orderId = Number(c.req.param('orderId'))
  try {
    const order = db
      .select()
      .from(ordersTable)
      .where(eq(ordersTable.id, orderId))
      .get()

    if (!order) throw new HTTPException(404, { message: 'Order not found' })
    return c.json(serializeOrder(order))
  } catch (e) {
    if (e instanceof HTTPException) throw e
    logger.error(`Failed to get order details: ${e}`)
    throw new HTTPException(500, {
      message: `Failed to get order details: ${e}`,
    })
  }
})

/** Order service health check. */
orderRoutes.get('/health', (c) => {
  try {
    const all = db.select().from(ordersTable).all()
    const countBy = (status: string) =>
      all.filter((o) => o.status === status).length

    return c.json({
      status: 'healthy',
      timestamp: Date.now(),
      statistics: {
        total_orders: all.length,
        pending_orders: countBy('PENDING'),
        filled_orders: countBy('FILLED'),
        cancelled_orders: countBy('CANCELLED'),
      },
      message: 'Order service is running normally',
    })
  } catch (e) {
    logger.error(`Order service health check failed: ${e}`)
    return c.json({
      status: 'unhealthy',
      timestamp: Date.now(),
      error: String(e),
      message: 'Order service exception',
    })
  }
})
