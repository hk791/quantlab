/**
 * Order scheduling service.
 * Background task for periodically processing pending orders.
 * Port of `services/order_scheduler.py` (threading.Thread -> async timer loop).
 */
import { processAllPendingOrders } from './orderMatching.js'
import { getLogger } from '../utils/logger.js'

const logger = getLogger('services.orderScheduler')

export class OrderScheduler {
  running = false
  private timer: NodeJS.Timeout | null = null
  /** Guards against a slow pass overlapping the next tick. */
  private inFlight = false

  constructor(public readonly intervalSeconds: number = 5) {}

  start(): void {
    if (this.running) {
      logger.warning('Order scheduler is already running')
      return
    }

    this.running = true
    this.timer = setInterval(() => {
      void this.processOrders()
    }, this.intervalSeconds * 1000)
    this.timer.unref?.()

    logger.info(
      `Order scheduler started, check interval: ${this.intervalSeconds} seconds`,
    )
  }

  stop(): void {
    if (!this.running) return

    this.running = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    logger.info('Order scheduler stopped')
  }

  private async processOrders(): Promise<void> {
    if (this.inFlight) {
      logger.debug('Previous order-processing pass still running, skipping tick')
      return
    }
    this.inFlight = true
    try {
      const [executedCount, totalChecked] = await processAllPendingOrders()
      if (totalChecked > 0) {
        logger.debug(
          `Order processing: checked ${totalChecked}, executed ${executedCount}`,
        )
      }
    } catch (e) {
      logger.error(`Error processing orders: ${e}`)
    } finally {
      this.inFlight = false
    }
  }

  /** Manually execute order processing once. */
  async processOrdersOnce(): Promise<void> {
    if (!this.running) {
      logger.warning('Order scheduler not running, cannot process orders')
      return
    }
    try {
      await this.processOrders()
      logger.info('Manual order processing completed')
    } catch (e) {
      logger.error(`Manual order processing failed: ${e}`)
    }
  }
}

/** Global scheduler instance */
export const orderScheduler = new OrderScheduler(5)

export const startOrderScheduler = () => orderScheduler.start()
export const stopOrderScheduler = () => orderScheduler.stop()

export const getSchedulerStatus = () => ({
  running: orderScheduler.running,
  interval_seconds: orderScheduler.intervalSeconds,
  thread_alive: orderScheduler.running,
})
