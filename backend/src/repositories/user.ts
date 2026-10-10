/**
 * Port of `repositories/user_repo.py`.
 *
 * NOTE: the Python original read/wrote `user.password`, which is not a column
 * on the User model (the column is `password_hash`). That made
 * `user_has_password` / `verify_user_password` raise AttributeError and the
 * trading-password branch of POST /api/orders/create fail. This port uses the
 * real `password_hash` column, which is clearly the intent.
 */
import { createHash, randomBytes } from 'node:crypto'
import { and, eq, gt, lte } from 'drizzle-orm'
import { db } from '../db/client.js'
import { userAuthSessions, users, type User } from '../db/schema.js'
import { utcNow } from '../utils/datetime.js'

/** 180 days, matching the Python session lifetime. */
const SESSION_TTL_DAYS = 180

function hashPassword(password: string): string {
  return createHash('sha256').update(password, 'utf8').digest('hex')
}

export function createUser(
  username: string,
  email: string | null = null,
  password: string | null = null,
): User {
  return db
    .insert(users)
    .values({
      username,
      email,
      passwordHash: password ? hashPassword(password) : null,
      isActive: 'true',
    })
    .returning()
    .get()
}

/**
 * Get or create user for default mode.
 * For default/simulation mode, creates the user without authentication.
 */
export function getOrCreateUser(
  username = 'default',
  email: string | null = null,
  password: string | null = null,
): User {
  const existing = db.select().from(users).where(eq(users.username, username)).get()
  if (existing) return existing
  return createUser(username, email, password)
}

export function getUser(userId: number): User | undefined {
  return db.select().from(users).where(eq(users.id, userId)).get()
}

export function getUserByUsername(username: string): User | undefined {
  return db.select().from(users).where(eq(users.username, username)).get()
}

export function setUserPassword(
  userId: number,
  password: string,
): User | undefined {
  if (!getUser(userId)) return undefined
  return db
    .update(users)
    .set({ passwordHash: hashPassword(password) })
    .where(eq(users.id, userId))
    .returning()
    .get()
}

export function verifyUserPassword(userId: number, password: string): boolean {
  const user = getUser(userId)
  if (!user?.passwordHash) return false
  return user.passwordHash === hashPassword(password)
}

export function userHasPassword(userId: number): boolean {
  const user = getUser(userId)
  return !!user && !!user.passwordHash && user.passwordHash.trim() !== ''
}

/** Creates a new auth session (180-day expiry) after pruning expired ones. */
export function createAuthSession(userId: number) {
  cleanupExpiredSessions(userId)

  const sessionToken = randomBytes(32).toString('base64url')
  const expiresAt = utcNow(
    new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000),
  )

  return db
    .insert(userAuthSessions)
    .values({ userId, sessionToken, expiresAt })
    .returning()
    .get()
}

/** Returns the user_id when the token is valid and unexpired, else null. */
export function verifyAuthSession(sessionToken: string): number | null {
  const session = db
    .select()
    .from(userAuthSessions)
    .where(
      and(
        eq(userAuthSessions.sessionToken, sessionToken),
        gt(userAuthSessions.expiresAt, utcNow()),
      ),
    )
    .get()
  return session ? session.userId : null
}

export function cleanupExpiredSessions(userId?: number): number {
  const expired = lte(userAuthSessions.expiresAt, utcNow())
  const where = userId
    ? and(expired, eq(userAuthSessions.userId, userId))
    : expired

  const doomed = db.select().from(userAuthSessions).where(where).all()
  if (doomed.length > 0) db.delete(userAuthSessions).where(where).run()
  return doomed.length
}

export function revokeAuthSession(sessionToken: string): boolean {
  const where = eq(userAuthSessions.sessionToken, sessionToken)
  const session = db.select().from(userAuthSessions).where(where).get()
  if (!session) return false
  db.delete(userAuthSessions).where(where).run()
  return true
}
