import { Hono } from 'hono';
import type { Config } from '../config.js';
import type { Db } from '../db/db.js';

// Placeholder: Task 9 fills this in with the send() contract.
// RateLimiter and KnownCache are omitted from Deps until Task 8 adds them.
export interface AlertChannel {}

export type Deps = {
  db: Db;
  config: Config;
  now: () => number;
  channels: AlertChannel[];
};

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

  return app;
}
