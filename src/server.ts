import { serve } from '@hono/node-server';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { EmailChannel } from './alerts/channels.js';
import { enqueue } from './alerts/queue.js';
import { backupDb, pruneData } from './jobs/maintenance.js';
import { startScheduler } from './jobs/scheduler.js';
import { loadConfig } from './config.js';
import { openDb } from './db/db.js';
import { KnownCache, RateLimiter } from './ingest/limits.js';
import { createApp, type Deps } from './web/app.js';

const config = loadConfig(process.env);
mkdirSync(config.dataDir, { recursive: true });
const db = openDb(join(config.dataDir, 'csp-monitor.sqlite'));

const known = new KnownCache();
known.load(db);

const deps: Deps = {
  db, config, now: () => Date.now(), channels: [EmailChannel.fromConfig(db, config)],
  limiter: new RateLimiter(), known,
  onAlert: (s, req, n) => enqueue(db, s, req, n),
};
const app = createApp(deps);
const runMaintenance = async (_d: unknown, now: number): Promise<void> => {
  try { pruneData(db, now); } catch (e) { console.error('maintenance: prune failed', e instanceof Error ? e.name : 'error'); }
  try { backupDb(db, join(config.dataDir, 'backups'), now); } catch (e) { console.error('maintenance: backup failed', e instanceof Error ? e.name : 'error'); }
};
const stopScheduler = startScheduler(deps, { runMaintenance });

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`csp-monitor listening on :${info.port}`);
});

function shutdown(): void {
  stopScheduler();
  server.close();
  db.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
