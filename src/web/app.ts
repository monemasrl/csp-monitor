import { readFileSync } from 'node:fs';
import { Hono, type Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie } from 'hono/cookie';
import { LoginLimiter } from '../auth/limiter.js';
import { verifyPassword } from '../auth/password.js';
import { SESSION_COOKIE, SESSION_TTL_MS, signSession, verifySession } from '../auth/session.js';
import { accessLog } from './accessLog.js';
import { registerDashboard } from './dashboard.js';
import { COPY_SCRIPT_HASH } from './views/Layout.js';
import { Login } from './views/Login.js';
import type { AlertChannel } from '../alerts/channels.js';
import type { Config } from '../config.js';
import type { Db } from '../db/db.js';
import { errId, ingest } from '../ingest/handler.js';
import type { KnownCache, RateLimiter } from '../ingest/limits.js';
import { recordNoise } from '../store/origins.js';
import { getSiteByKey } from '../store/sites.js';

export type Deps = {
  db: Db;
  config: Config;
  now: () => number;
  channels: AlertChannel[];
  limiter: RateLimiter;
  known: KnownCache;
  onAlert: (siteId: number, originId: number, now: number) => void;
};

const MAX_BODY = 65_536;
const MAX_PASSWORD_LENGTH = 1024;
const DASHBOARD_CSP = [
  "default-src 'none'", `script-src ${COPY_SCRIPT_HASH}`, "style-src 'self' 'unsafe-inline'", "img-src 'self'",
  "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'",
].join('; ');
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/** Reads the body as text, stopping as soon as it exceeds MAX_BODY bytes; null when too large. */
async function readLimited(req: Request): Promise<string | null> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createApp(deps: Deps, logWrite?: (line: string) => void): Hono {
  const app = new Hono();
  if (deps.config.logRequests) app.use('*', accessLog(logWrite));

  app.get('/health', (c) => {
    try {
      deps.db.prepare('SELECT 1').get();
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false }, 503);
    }
  });

  const limiter = new LoginLimiter();
  const baseOrigin = new URL(deps.config.baseUrl).origin;

  const clientIp = (c: Context): string => {
    if (deps.config.trustProxy) {
      const first = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
      if (first) return first;
    }
    try {
      return getConnInfo(c).remote.address ?? 'unknown';
    } catch {
      return 'unknown';
    }
  };

  const dashboardBodyLimit = bodyLimit({ maxSize: 16 * 1024 });

  // Dashboard-only middleware: /health and /r/* bypass everything.
  app.use('*', async (c, next) => {
    const path = c.req.path;
    if (path === '/health' || path === '/r' || path.startsWith('/r/')) return next();
    if (c.req.method === 'POST' && c.req.header('origin') !== baseOrigin) return c.text('Forbidden', 403);
    const open = path === '/login' || path === '/logout' || path === '/static' || path.startsWith('/static/');
    if (!open) {
      const token = getCookie(c, SESSION_COOKIE);
      if (!token || !verifySession(deps.config.sessionSecret, token, deps.now())) return c.redirect('/login', 303);
    }
    return c.req.method === 'POST' ? dashboardBodyLimit(c, next) : next();
  });

  // Defense in depth for every dashboard response (escaping is the primary protection).
  app.use('*', async (c, next) => {
    await next();
    const path = c.req.path;
    if (path === '/health' || path === '/r' || path.startsWith('/r/')) return;
    c.header('Content-Security-Policy', DASHBOARD_CSP);
    c.header('X-Frame-Options', 'DENY');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'same-origin');
  });

  app.get('/login', (c) => c.html(Login({})));
  app.post('/login', async (c) => {
    const ip = clientIp(c);
    const now = deps.now();
    if (limiter.blocked(ip, now)) {
      return c.html(Login({ error: 'Troppi tentativi, riprova tra qualche minuto' }), 429);
    }
    const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const pw = typeof body.password === 'string' ? body.password : '';
    // Re-check after the await: check -> verify -> fail must run with no await in between,
    // otherwise parallel requests all pass the first check.
    if (limiter.blocked(ip, now)) {
      return c.html(Login({ error: 'Troppi tentativi, riprova tra qualche minuto' }), 429);
    }
    if (pw.length > MAX_PASSWORD_LENGTH || !verifyPassword(pw, deps.config.adminPasswordHash)) {
      limiter.fail(ip, now);
      return c.html(Login({ error: 'Password non corretta' }), 401);
    }
    limiter.reset(ip);
    setCookie(c, SESSION_COOKIE, signSession(deps.config.sessionSecret, now + SESSION_TTL_MS), {
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
      maxAge: SESSION_TTL_MS / 1000,
      secure: deps.config.secureCookies,
    });
    return c.redirect('/', 303);
  });
  app.post('/logout', (c) => {
    setCookie(c, SESSION_COOKIE, '', {
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
      maxAge: 0,
      secure: deps.config.secureCookies,
    });
    return c.redirect('/login', 303);
  });

  const STYLE_CSS = readFileSync(new URL('../../src/web/static/style.css', import.meta.url), 'utf8');
  app.get('/static/style.css', (c) =>
    c.body(STYLE_CSS, 200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }));

  registerDashboard(app, deps);

  const empty204 = () => new Response(null, { status: 204, headers: CORS });

  app.options('/r/:key', () => empty204());
  app.post('/r/:key', async (c) => {
    try {
      const key = c.req.param('key');
      const text = await readLimited(c.req.raw);
      if (text === null) {
        const site = getSiteByKey(deps.db, key);
        if (site) recordNoise(deps.db, site.id, 'invalid', deps.now());
      } else {
        ingest(deps, key, c.req.header('content-type'), text, deps.now(), c.req.header('user-agent'));
      }
    } catch (e) {
      console.error('collect: unexpected failure', errId(e));
    }
    return empty204();
  });

  return app;
}
