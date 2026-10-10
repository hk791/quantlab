/**
 * Admin login for the public dashboard. Pure logic only (no Hono / no I/O) so
 * it can be unit-tested; index.ts wires it into the middleware.
 *
 * Policy in arena mode:
 *  - public:  read-only dashboard pages and the read-only arena endpoints
 *             (leaderboard, positions, decisions, ...). Anyone can watch.
 *  - admin:   everything else under /api (model management, run-cycle, config,
 *             the legacy project's APIs). Default deny: new endpoints are
 *             admin-only until explicitly whitelisted here.
 *  - blocked: the legacy WebSocket. Its `place_order` goes through the legacy
 *             order engine, which writes `accounts.current_cash` that the arena
 *             ledger also uses, so it must never touch arena accounts.
 */
import crypto from 'node:crypto'

export type Access = 'public' | 'admin' | 'blocked'

/** Read-only arena endpoints that are safe to show to the world. */
const PUBLIC_ARENA_GET = [
  /^\/api\/arena\/(leaderboard|outcomes|curves|positions|trades|decisions|market)\/?$/,
  /^\/api\/arena\/decisions\/\d+\/raw\/?$/,
]

export function accessFor(method: string, path: string): Access {
  const m = method.toUpperCase()
  const read = m === 'GET' || m === 'HEAD'
  if (path === '/ws' || path.startsWith('/ws/')) return 'blocked'
  if (path === '/api/health') return 'public'
  if (path.startsWith('/api/auth/')) return 'public' // login / logout / me handle themselves
  if (path === '/api' || path.startsWith('/api/')) {
    if (read && PUBLIC_ARENA_GET.some((re) => re.test(path))) return 'public'
    return 'admin'
  }
  // Non-API paths are pages (/, /dashboard) or redirects. Only reads are public.
  return read || m === 'OPTIONS' ? 'public' : 'admin'
}

/** Constant-time string compare (hash first so lengths never leak). */
export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest()
  const hb = crypto.createHash('sha256').update(b).digest()
  return crypto.timingSafeEqual(ha, hb)
}

export function checkCredentials(user: string, pass: string, expectedUser: string, expectedPass: string): boolean {
  // Evaluate both to keep timing independent of which one is wrong.
  const u = safeEqual(user, expectedUser)
  const p = safeEqual(pass, expectedPass)
  return u && p && expectedPass.length > 0
}

/** Parse an `Authorization: Basic ...` header (for curl / scripts). */
export function parseBasicAuth(header: string | undefined | null): { user: string; pass: string } | null {
  if (!header) return null
  const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header)
  if (!m) return null
  const decoded = Buffer.from(m[1]!, 'base64').toString('utf8')
  const i = decoded.indexOf(':')
  if (i < 0) return null
  return { user: decoded.slice(0, i), pass: decoded.slice(i + 1) }
}

/**
 * CSRF defence in depth (the session cookie is already SameSite=Strict): a
 * state-changing admin request that carries an Origin header must come from
 * the same host it is sent to.
 */
export function sameOrigin(origin: string | undefined | null, host: string | undefined | null): boolean {
  if (!origin) return true // non-browser clients (curl) don't send Origin
  if (!host) return false
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase()
  } catch {
    return false
  }
}

/** In-memory sessions. A restart (or password change + restart) logs everyone out. */
export class SessionStore {
  private sessions = new Map<string, number>()
  constructor(
    readonly ttlMs = 7 * 86_400_000,
    private readonly maxSessions = 50,
  ) {}

  create(now = Date.now()): string {
    this.prune(now)
    if (this.sessions.size >= this.maxSessions) {
      // Drop the oldest so a flood of logins can't grow memory forever.
      const oldest = [...this.sessions.entries()].sort((a, b) => a[1] - b[1])[0]
      if (oldest) this.sessions.delete(oldest[0])
    }
    const token = crypto.randomBytes(32).toString('base64url')
    this.sessions.set(token, now + this.ttlMs)
    return token
  }

  valid(token: string | undefined | null, now = Date.now()): boolean {
    if (!token) return false
    const exp = this.sessions.get(token)
    if (exp === undefined) return false
    if (exp <= now) {
      this.sessions.delete(token)
      return false
    }
    return true
  }

  revoke(token: string | undefined | null): void {
    if (token) this.sessions.delete(token)
  }

  get size(): number {
    return this.sessions.size
  }

  private prune(now: number): void {
    for (const [t, exp] of this.sessions) if (exp <= now) this.sessions.delete(t)
  }
}

/**
 * Brute-force guard: after `maxFailures` wrong passwords from one IP within
 * `windowMs`, that IP is locked out until the window passes.
 */
export class LoginLimiter {
  private failures = new Map<string, number[]>()
  constructor(
    readonly maxFailures = 8,
    readonly windowMs = 15 * 60_000,
  ) {}

  /** Milliseconds until this key may try again (0 = allowed). */
  retryAfterMs(key: string, now = Date.now()): number {
    const list = this.recent(key, now)
    if (list.length < this.maxFailures) return 0
    return Math.max(0, list[0]! + this.windowMs - now)
  }

  fail(key: string, now = Date.now()): void {
    const list = this.recent(key, now)
    list.push(now)
    this.failures.set(key, list)
    if (this.failures.size > 10_000) this.failures.clear() // crude memory cap
  }

  succeed(key: string): void {
    this.failures.delete(key)
  }

  private recent(key: string, now: number): number[] {
    return (this.failures.get(key) ?? []).filter((t) => now - t < this.windowMs)
  }
}

export function isLoopback(addr: string | undefined | null): boolean {
  if (!addr) return false
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

export interface ClientInfo {
  /** Best guess of the real client IP (used for rate limiting and logs). */
  ip: string
  /** True only for a direct, unproxied connection from this machine. */
  local: boolean
  /** Whether the browser reached us over HTTPS (directly or via the proxy). */
  https: boolean
}

/** Loopback or RFC1918 / unique-local address (where a local reverse proxy or Docker's gateway lives). */
export function isPrivateAddr(addr: string): boolean {
  const a = addr.replace(/^::ffff:/, '')
  if (isLoopback(addr) || a === '127.0.0.1') return true
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(a)
  if (m) {
    const [x, y] = [Number(m[1]), Number(m[2])]
    return x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168)
  }
  return /^f[cd][0-9a-f]{2}:/i.test(a)
}

/**
 * Work out who is calling. Forwarding headers are trusted only when the TCP
 * peer is a private address: the reverse proxy (Caddy) on this host, which in
 * Docker shows up as the bridge gateway (172.x.0.1), not 127.0.0.1. Public
 * peers hitting the port directly can't spoof their IP or "https" this way.
 * Caddy overwrites a client-supplied X-Forwarded-For with the real client IP,
 * so the rightmost entry is the one it added. A proxied request is never
 * "local" — otherwise everyone on the internet would look like localhost.
 */
export function clientInfo(
  remote: string | undefined | null,
  headers: { forwardedFor?: string | null; forwardedProto?: string | null; realIp?: string | null },
  urlIsHttps = false,
): ClientInfo {
  const peer = remote || 'unknown'
  const proxied = !!(headers.forwardedFor || headers.realIp || headers.forwardedProto)
  if (!proxied || !isPrivateAddr(peer)) {
    return { ip: peer, local: !proxied && isLoopback(peer), https: urlIsHttps }
  }
  const xff = (headers.forwardedFor ?? '').split(',').map((x) => x.trim()).filter(Boolean)
  const ip = xff[xff.length - 1] || headers.realIp?.trim() || 'proxied'
  return { ip, local: false, https: urlIsHttps || headers.forwardedProto?.split(',')[0]?.trim().toLowerCase() === 'https' }
}
