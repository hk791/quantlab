/**
 * Crypto Paper Trading API — application entry point.
 * Port of `main.py` (FastAPI -> Hono).
 */
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { cors } from 'hono/cors'
import { basicAuth } from 'hono/basic-auth'
import { bodyLimit } from 'hono/body-limit'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { getConnInfo } from '@hono/node-server/conninfo'
import { serveStatic } from '@hono/node-server/serve-static'
import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'

import { ensureSchema } from './db/client.js'
import { seedDatabase } from './db/seed.js'
import { accountRoutes } from './api/account.js'
import { configRoutes } from './api/config.js'
import { cryptoRoutes } from './api/crypto.js'
import { marketDataRoutes } from './api/marketData.js'
import { orderRoutes } from './api/orders.js'
import { rankingRoutes } from './api/ranking.js'
import { arenaDashboardHtml, arenaRoutes } from './arena/routes.js'
import { loadArenaConfig } from './arena/config.js'
import {
  LoginLimiter,
  SessionStore,
  accessFor,
  checkCredentials,
  clientInfo,
  type ClientInfo,
  parseBasicAuth,
  sameOrigin,
} from './arena/auth.js'
import {
  createWsState,
  handleWsClose,
  handleWsMessage,
} from './api/ws.js'
import { initializeServices, shutdownServices } from './services/startup.js'
import { getLogger } from './utils/logger.js'

const logger = getLogger('main')

const here = path.dirname(fileURLToPath(import.meta.url))
const staticDir = path.resolve(here, '../static')
const indexPath = path.join(staticDir, 'index.html')

const app = new Hono()
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })

app.use(
  '*',
  cors({
    origin: '*', // Allow all origins, or specify specific domains
    // No credentials: the admin cookie must never be usable cross-site.
    credentials: false,
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowHeaders: ['*'],
  }),
)

// Health check endpoint
app.get('/api/health', (c) =>
  c.json({ status: 'healthy', message: 'Trading API is running' }),
)

// Access control.
// Arena mode: dashboard pages and read-only arena endpoints are public; every
// other API (model management, run-cycle, legacy APIs) needs an admin session;
// the legacy WebSocket is closed. See arena/auth.ts for the policy.
// Legacy mode (no arena config): unchanged — optional basic auth on writes.
const ADMIN_USER = process.env.ARENA_USER || 'admin'
const ADMIN_PASS = process.env.ARENA_PASSWORD ?? ''
const SESSION_COOKIE = 'qlab_session'
const sessions = new SessionStore()
const limiter = new LoginLimiter()

function client(c: Context): ClientInfo {
  let remote: string | undefined
  try {
    remote = getConnInfo(c).remote.address
  } catch {
    remote = undefined
  }
  return clientInfo(
    remote,
    {
      forwardedFor: c.req.header('x-forwarded-for'),
      forwardedProto: c.req.header('x-forwarded-proto'),
      realIp: c.req.header('x-real-ip'),
    },
    c.req.url.startsWith('https:'),
  )
}
const clientIp = (c: Context) => client(c).ip

/** Admin = valid session cookie, valid Basic header (scripts), or loopback when no password is set. */
function isAdmin(c: Context): boolean {
  if (!ADMIN_PASS) return client(c).local
  if (sessions.valid(getCookie(c, SESSION_COOKIE))) return true
  const basic = parseBasicAuth(c.req.header('authorization'))
  if (!basic) return false
  const ip = clientIp(c)
  if (limiter.retryAfterMs(ip) > 0) return false
  const ok = checkCredentials(basic.user, basic.pass, ADMIN_USER, ADMIN_PASS)
  if (ok) limiter.succeed(ip)
  else limiter.fail(ip)
  return ok
}

if (!process.env.ARENA_PASSWORD) {
  logger.warning('ARENA_PASSWORD is not set: admin actions are only allowed from localhost')
}

app.use('*', async (c, next) => {
  if (!arenaModeEnabled()) {
    // Legacy behaviour kept as-is (constraint: no arena config => original project).
    if (ADMIN_PASS && c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      return basicAuth({ username: ADMIN_USER, password: ADMIN_PASS })(c, next)
    }
    return next()
  }
  c.header('X-Content-Type-Options', 'nosniff')
  if (client(c).https) c.header('Strict-Transport-Security', 'max-age=31536000')
  const access = accessFor(c.req.method, c.req.path)
  if (access === 'blocked') return c.json({ detail: 'disabled in arena mode' }, 403)
  if (access === 'admin') {
    if (!isAdmin(c)) {
      return c.json({ detail: ADMIN_PASS ? '需要管理员登录' : '服务器未设置 ARENA_PASSWORD，管理操作只允许在本机进行' }, 401)
    }
    const m = c.req.method
    if (m !== 'GET' && m !== 'HEAD' && !sameOrigin(c.req.header('origin'), c.req.header('host'))) {
      return c.json({ detail: 'cross-site request rejected' }, 403)
    }
  }
  return next()
})

// Admin write endpoints only take small JSON bodies.
app.use('/api/arena/*', bodyLimit({ maxSize: 64 * 1024 }))

// Login endpoints (public by policy; they do their own checks).
app.use('/api/auth/*', bodyLimit({ maxSize: 4 * 1024 }))
app.get('/api/auth/me', (c) =>
  c.json({ admin: isAdmin(c), passwordSet: !!ADMIN_PASS }),
)
app.post('/api/auth/login', async (c) => {
  if (!sameOrigin(c.req.header('origin'), c.req.header('host'))) {
    return c.json({ detail: 'cross-site request rejected' }, 403)
  }
  if (!ADMIN_PASS) return c.json({ detail: '服务器未设置 ARENA_PASSWORD，无法登录' }, 400)
  const ip = clientIp(c)
  const wait = limiter.retryAfterMs(ip)
  if (wait > 0) {
    return c.json({ detail: `尝试次数过多，请 ${Math.ceil(wait / 60_000)} 分钟后再试` }, 429)
  }
  const body = (await c.req.json().catch(() => ({}))) as { username?: unknown; password?: unknown }
  const ok = checkCredentials(String(body.username ?? ''), String(body.password ?? ''), ADMIN_USER, ADMIN_PASS)
  if (!ok) {
    limiter.fail(ip)
    logger.warning(`Admin login failed from ${ip}`)
    await new Promise((r) => setTimeout(r, 500)) // slow down guessing
    return c.json({ detail: '用户名或密码错误' }, 401)
  }
  limiter.succeed(ip)
  const https = client(c).https
  setCookie(c, SESSION_COOKIE, sessions.create(), {
    httpOnly: true,
    sameSite: 'Strict',
    secure: https,
    path: '/',
    maxAge: Math.floor(sessions.ttlMs / 1000),
  })
  logger.info(`Admin login from ${ip}`)
  return c.json({ ok: true })
})
app.post('/api/auth/logout', (c) => {
  sessions.revoke(getCookie(c, SESSION_COOKIE))
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
  return c.json({ ok: true })
})

// API routes
app.route('/api/market', marketDataRoutes)
app.route('/api/orders', orderRoutes)
app.route('/api/account', accountRoutes)
app.route('/api/config', configRoutes)
app.route('/api/ranking', rankingRoutes)
app.route('/api/crypto', cryptoRoutes)
app.route('/api/arena', arenaRoutes)

// Dashboard (self-contained HTML, no frontend build required). /arena kept as an alias for old links.
app.get('/dashboard', (c) => dashboard(c))
app.get('/arena', (c) => c.redirect('/dashboard', 301))

// WebSocket endpoint
app.get(
  '/ws',
  upgradeWebSocket(() => {
    const state = createWsState()
    return {
      onMessage: (event, ws) => {
        const data =
          typeof event.data === 'string' ? event.data : String(event.data)
        void handleWsMessage(state, ws, data).catch((e) =>
          logger.error(`WebSocket message handling failed: ${e}`),
        )
      },
      onClose: (_event, ws) => handleWsClose(state, ws),
      onError: (_event, ws) => handleWsClose(state, ws),
    }
  }),
)

// Mount static files for the frontend
if (fs.existsSync(staticDir)) {
  app.use('/static/*', serveStatic({ root: path.relative(process.cwd(), staticDir) }))
  app.use('/assets/*', serveStatic({ root: path.relative(process.cwd(), staticDir) }))
}

/** Serve the frontend index.html, or a placeholder when not built yet. */
function serveIndex(c: Context) {
  if (fs.existsSync(indexPath)) {
    return c.html(fs.readFileSync(indexPath, 'utf8'))
  }
  return c.json({ message: 'Frontend not built yet' })
}

/** Dashboard page with browser hardening headers (CSP allows only jsDelivr for Chart.js / fonts). */
function dashboard(c: Context) {
  c.header(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; " +
      "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src https://cdn.jsdelivr.net; " +
      "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  )
  c.header('X-Frame-Options', 'DENY')
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Referrer-Policy', 'same-origin')
  return c.html(arenaDashboardHtml())
}

/** Arena mode replaces the legacy React frontend: the dashboard becomes the home page. */
function arenaModeEnabled(): boolean {
  try {
    return loadArenaConfig()?.enabled === true
  } catch {
    return false
  }
}

// Serve the dashboard (arena mode) or the frontend index.html for the root route
app.get('/', (c) => (arenaModeEnabled() ? dashboard(c) : serveIndex(c)))

// Catch-all for SPA routing (must be last)
app.get('*', (c) => {
  const fullPath = c.req.path.replace(/^\//, '')
  if (
    fullPath.startsWith('api') ||
    fullPath.startsWith('static') ||
    fullPath.startsWith('docs') ||
    fullPath.startsWith('openapi.json')
  ) {
    return c.json({ detail: 'Not found' }, 404)
  }
  // Legacy frontend routes are gone in arena mode; send them to the dashboard.
  if (arenaModeEnabled()) return c.redirect('/', 302)
  return serveIndex(c)
})

const port = Number(process.env.PORT ?? 5611)

// --- startup ---------------------------------------------------------------

ensureSchema()
seedDatabase()

const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
  logger.info(`Trading API listening on http://0.0.0.0:${info.port}`)
})

injectWebSocket(server)

// Initialize all services (scheduler, market data tasks, auto trading, etc.)
void initializeServices().catch((e) =>
  logger.error(`Service initialization failed: ${e}`),
)

// --- shutdown --------------------------------------------------------------

let shuttingDown = false
function shutdown(signal: string): void {
  if (shuttingDown) return
  shuttingDown = true
  logger.info(`Received ${signal}, shutting down...`)
  shutdownServices()
  server.close(() => process.exit(0))
  // Don't hang forever on lingering sockets
  setTimeout(() => process.exit(0), 5000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

export { app }
