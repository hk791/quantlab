/** Application startup initialization service. Port of `services/startup.py`. */
import {
  resetAutoTradingJob,
  setupMarketTasks,
  startMarginMonitor,
  startScheduler,
  stopScheduler,
  taskScheduler,
} from './scheduler.js'
import {
  AI_TRADE_JOB_ID,
  AUTO_TRADE_JOB_ID,
  placeAIDrivenCryptoOrder,
  placeRandomCryptoOrder,
} from './tradingCommands.js'
import { clearExpiredPrices } from './priceCache.js'
import { getLogger } from '../utils/logger.js'

const logger = getLogger('services.startup')

/** Initialize all services. */
export async function initializeServices(): Promise<void> {
  try {
    startScheduler()
    logger.info('Scheduler service started')

    setupMarketTasks()
    logger.info('Market scheduled tasks have been set up')

    // Arena mode: multi-model competition with hard risk layer.
    const { loadArenaConfig } = await import('../arena/config.js')
    const arenaCfg = loadArenaConfig()
    if (arenaCfg?.enabled) {
      const { ensureArenaSchema } = await import('../arena/store.js')
      const { ArenaEngine, setArenaEngine } = await import('../arena/engine.js')
      ensureArenaSchema()
      const engine = new ArenaEngine(arenaCfg)
      setArenaEngine(engine)
      engine.start()
      taskScheduler.addIntervalTask(() => clearExpiredPrices(), 120, 'price_cache_cleanup')
      logger.info('Arena engine started; legacy auto trader disabled')
      return
    }

    // Start automatic crypto trading via reset, which also verifies market
    // data readiness and uses the correct job ID.
    try {
      await resetAutoTradingJob()
      logger.info(
        `Automatic cryptocurrency trading task scheduled via reset (5-minute interval). ` +
          `Jobs: ${JSON.stringify(taskScheduler.getJobInfo())}`,
      )
    } catch (e) {
      logger.error(`Failed to schedule AI auto trading task: ${e}`)
      // Fall back to random trading so the demo stays functional
      try {
        scheduleAutoTrading({ intervalSeconds: 300, useAi: false })
        logger.warning(
          `Falling back to random trading schedule. Jobs: ${JSON.stringify(taskScheduler.getJobInfo())}`,
        )
      } catch (e2) {
        logger.error(`Failed to schedule fallback random trading task: ${e2}`)
      }
    }

    // Price cache cleanup task (every 2 minutes)
    taskScheduler.addIntervalTask(
      () => clearExpiredPrices(),
      120,
      'price_cache_cleanup',
    )
    logger.info('Price cache cleanup task started (2-minute interval)')

    // Margin monitoring for leveraged positions (every 5 seconds)
    startMarginMonitor(5)
    logger.info('Margin monitor started (5-second interval)')

    logger.info('All services initialized successfully')
  } catch (e) {
    logger.error(`Service initialization failed: ${e}`)
    throw e
  }
}

/** Shut down all services. */
export function shutdownServices(): void {
  try {
    void import('../arena/engine.js').then(({ getArenaEngine }) => getArenaEngine()?.stop())
    stopScheduler()
    logger.info('All services have been shut down')
  } catch (e) {
    logger.error(`Failed to shut down services: ${e}`)
  }
}

/**
 * Schedule automatic trading tasks.
 *
 * @param useAi true -> AI-driven trading, false -> random trading
 */
export function scheduleAutoTrading(options?: {
  intervalSeconds?: number
  maxRatio?: number
  useAi?: boolean
}): void {
  const {
    intervalSeconds = 300,
    maxRatio = 0.2,
    useAi = true,
  } = options ?? {}

  const taskFunc = useAi
    ? () => placeAIDrivenCryptoOrder()
    : () => placeRandomCryptoOrder(maxRatio)
  const jobId = useAi ? AI_TRADE_JOB_ID : AUTO_TRADE_JOB_ID

  logger.info(
    useAi
      ? 'Scheduling AI-driven crypto trading'
      : 'Scheduling random crypto trading',
  )

  taskScheduler.addIntervalTask(taskFunc, intervalSeconds, jobId)

  // Execute the first trade immediately without blocking startup
  void (async () => {
    try {
      await taskFunc()
      logger.info('Initial auto-trading execution completed')
    } catch (e) {
      logger.error(`Error during initial auto-trading execution: ${e}`)
    }
  })()
}
