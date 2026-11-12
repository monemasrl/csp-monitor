import { openDb } from '../src/db/db.js';
import type { Deps } from '../src/web/app.js';
import { loadConfig } from '../src/config.js';

export const NOW = Date.UTC(2026, 10, 12, 9, 0);

export function validEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    BASE_URL: 'https://m.example.it',
    ADMIN_PASSWORD_HASH: 'scrypt$salt$hash',
    SESSION_SECRET: 'x'.repeat(32),
    SMTP_HOST: 'smtp.example.it',
    SMTP_FROM: 'csp@example.it',
    ALERT_EMAIL: 'admin@example.it',
    ...overrides,
  };
}

export function testDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    db: openDb(':memory:'),
    config: loadConfig(validEnv()),
    now: () => NOW,
    channels: [],
    ...overrides,
  };
}
