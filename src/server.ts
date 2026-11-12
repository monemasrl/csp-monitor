import { serve } from '@hono/node-server';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { openDb } from './db/db.js';
import { KnownCache, RateLimiter } from './ingest/limits.js';
import { createApp } from './web/app.js';

const config = loadConfig(process.env);
mkdirSync(config.dataDir, { recursive: true });
const db = openDb(join(config.dataDir, 'csp-monitor.sqlite'));

const known = new KnownCache();
known.load(db);

const app = createApp({
  db, config, now: () => Date.now(), channels: [],
  limiter: new RateLimiter(), known,
  onAlert: () => {}, // Task 9 wires this to enqueueAlert
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`csp-monitor listening on :${info.port}`);
});
