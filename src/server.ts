import { serve } from '@hono/node-server';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { openDb } from './db/db.js';
import { createApp } from './web/app.js';

const config = loadConfig(process.env);
mkdirSync(config.dataDir, { recursive: true });
const db = openDb(join(config.dataDir, 'csp-monitor.sqlite'));

const app = createApp({ db, config, now: () => Date.now(), channels: [] });

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`csp-monitor listening on :${info.port}`);
});
