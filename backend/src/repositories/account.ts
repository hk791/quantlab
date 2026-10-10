/** Port of `repositories/account_repo.py`. */
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { accounts, type Account } from '../db/schema.js'

export function createAccount(params: {
  userId: number
  name: string
  accountType?: string
  initialCapital?: number
  model?: string
  baseUrl?: string
  apiKey?: string | null
}): Account {
  const {
    userId,
    name,
    accountType = 'AI',
    initialCapital = 10000.0,
    model = 'gpt-4-turbo',
    baseUrl = 'https://api.openai.com/v1',
    apiKey = null,
  } = params

  const isAI = accountType === 'AI'
  const inserted = db
    .insert(accounts)
    .values({
      userId,
      version: 'v1',
      name,
      accountType,
      model: isAI ? model : null,
      baseUrl: isAI ? baseUrl : null,
      apiKey: isAI ? apiKey : null,
      initialCapital,
      currentCash: initialCapital,
      frozenCash: 0.0,
      isActive: 'true',
    })
    .returning()
    .get()

  return inserted
}

export function getAccount(accountId: number): Account | undefined {
  return db.select().from(accounts).where(eq(accounts.id, accountId)).get()
}

export function getAccountsByUser(userId: number, activeOnly = true): Account[] {
  const where = activeOnly
    ? and(eq(accounts.userId, userId), eq(accounts.isActive, 'true'))
    : eq(accounts.userId, userId)
  return db.select().from(accounts).where(where).all()
}

export function getOrCreateDefaultAccount(params: {
  userId: number
  accountName?: string
  initialCapital?: number
  model?: string
  baseUrl?: string
  apiKey?: string
}): Account {
  const {
    userId,
    accountName = 'Default AI Trader',
    initialCapital = 10000.0,
    model = 'gpt-4-turbo',
    baseUrl = 'https://api.openai.com/v1',
    apiKey = 'default-key-please-update-in-settings',
  } = params

  const existing = getAccountsByUser(userId, true)
  if (existing.length > 0) return existing[0]!

  return createAccount({
    userId,
    name: accountName,
    accountType: 'AI',
    initialCapital,
    model,
    baseUrl,
    apiKey,
  })
}

export function updateAccount(
  accountId: number,
  patch: {
    name?: string
    model?: string
    baseUrl?: string
    apiKey?: string
  },
): Account | undefined {
  if (!getAccount(accountId)) return undefined

  const values: Partial<typeof accounts.$inferInsert> = {}
  if (patch.name !== undefined) values.name = patch.name
  if (patch.model !== undefined) values.model = patch.model
  if (patch.baseUrl !== undefined) values.baseUrl = patch.baseUrl
  if (patch.apiKey !== undefined) values.apiKey = patch.apiKey

  if (Object.keys(values).length === 0) return getAccount(accountId)

  return db
    .update(accounts)
    .set(values)
    .where(eq(accounts.id, accountId))
    .returning()
    .get()
}

export function updateAccountCash(
  accountId: number,
  currentCash: number,
  frozenCash?: number,
): Account | undefined {
  if (!getAccount(accountId)) return undefined

  const values: Partial<typeof accounts.$inferInsert> = { currentCash }
  if (frozenCash !== undefined) values.frozenCash = frozenCash

  return db
    .update(accounts)
    .set(values)
    .where(eq(accounts.id, accountId))
    .returning()
    .get()
}

export function deactivateAccount(accountId: number): Account | undefined {
  if (!getAccount(accountId)) return undefined
  return db
    .update(accounts)
    .set({ isActive: 'false' })
    .where(eq(accounts.id, accountId))
    .returning()
    .get()
}

export function activateAccount(accountId: number): Account | undefined {
  if (!getAccount(accountId)) return undefined
  return db
    .update(accounts)
    .set({ isActive: 'true' })
    .where(eq(accounts.id, accountId))
    .returning()
    .get()
}
