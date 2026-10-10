/**
 * Startup database seeding — port of the `on_startup` body in `main.py`.
 *
 * Seeds default trading configs, prunes every non-`default` user (and their
 * dependent rows), and guarantees the default user owns at least one account.
 */
import { eq, ne, inArray } from 'drizzle-orm'
import { db } from './client.js'
import {
  accounts,
  orders,
  positions,
  trades,
  tradingConfigs,
  users,
} from './schema.js'
import { DEFAULT_TRADING_CONFIGS } from '../config/settings.js'
import { getLogger } from '../utils/logger.js'

const logger = getLogger('db.seed')

export function seedDatabase(): void {
  // Seed trading configs if empty
  const existingConfigs = db.select().from(tradingConfigs).all()
  if (existingConfigs.length === 0) {
    for (const cfg of Object.values(DEFAULT_TRADING_CONFIGS)) {
      db.insert(tradingConfigs)
        .values({
          version: 'v1',
          market: cfg.market,
          minCommission: cfg.minCommission,
          commissionRate: cfg.commissionRate,
          exchangeRate: cfg.exchangeRate,
          minOrderQuantity: cfg.minOrderQuantity,
          lotSize: cfg.lotSize,
        })
        .run()
    }
    logger.info('Seeded default trading configs')
  }

  // Ensure only the default user and its account exist:
  // delete all non-default users along with everything hanging off them.
  const nonDefaultUsers = db
    .select()
    .from(users)
    .where(ne(users.username, 'default'))
    .all()

  for (const user of nonDefaultUsers) {
    const accountIds = db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.userId, user.id))
      .all()
      .map((a) => a.id)

    if (accountIds.length > 0) {
      db.delete(trades).where(inArray(trades.accountId, accountIds)).run()
      db.delete(orders).where(inArray(orders.accountId, accountIds)).run()
      db.delete(positions).where(inArray(positions.accountId, accountIds)).run()
      db.delete(accounts).where(eq(accounts.userId, user.id)).run()
    }

    db.delete(users).where(eq(users.id, user.id)).run()
  }

  // Ensure default user exists
  let defaultUser = db
    .select()
    .from(users)
    .where(eq(users.username, 'default'))
    .get()

  if (!defaultUser) {
    db.insert(users)
      .values({
        username: 'default',
        email: null,
        passwordHash: null,
        isActive: 'true',
      })
      .run()
    defaultUser = db
      .select()
      .from(users)
      .where(eq(users.username, 'default'))
      .get()!
    logger.info('Created default user')
  }

  // Ensure default user has at least one account
  const defaultAccounts = db
    .select()
    .from(accounts)
    .where(eq(accounts.userId, defaultUser.id))
    .all()

  if (defaultAccounts.length === 0) {
    db.insert(accounts)
      .values({
        userId: defaultUser.id,
        version: 'v1',
        name: 'GPT',
        accountType: 'AI',
        model: 'gpt-5-mini',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'default-key-please-update-in-settings',
        initialCapital: 10000, // $10,000 starting capital for crypto trading
        currentCash: 10000,
        frozenCash: 0,
        marginUsed: 0,
        maintenanceMarginRatio: 0.5,
        isActive: 'true',
      })
      .run()
    logger.info('Created default account')
  }
}
