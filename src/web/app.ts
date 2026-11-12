import { Hono } from 'hono';
import type { Config } from '../config.js';
import type { Db } from '../db/db.js';
import { errId, ingest } from '../ingest/handler.js';
import type { KnownCache, RateLimiter } from '../ingest/limits.js';
import { recordNoise } from '../store/origins.js';
import { getSiteByKey } from '../store/sites.js';

// Placeholder: Task 9 fills this in with the send() contract.
export interface AlertChannel {}

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

export function createApp(deps: Deps): Hono {
  const app = new Hono();

  app.get('/health', (c) => {
    try {
      deps.db.prepare('SELECT 1').get();
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false }, 503);
    }
  });

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
        ingest(deps, key, c.req.header('content-type'), text, deps.now());
      }
    } catch (e) {
      console.error('collect: unexpected failure', errId(e));
    }
    return empty204();
  });

  return app;
}
