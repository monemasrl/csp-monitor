import { SESSION_COOKIE, SESSION_TTL_MS, signSession } from '../../src/auth/session.js';
import type { CspEvent } from '../../src/ingest/csp.js';
import { createApp, type Deps } from '../../src/web/app.js';
import { NOW, testDeps } from '../helpers.js';

export const ORIGIN = 'https://m.example.it';
export const DAY = 86_400_000;

export function ev(o: Partial<CspEvent> = {}): CspEvent {
  return {
    directive: 'script-src', origin: 'https://evil.example', category: 'external', page: '/p',
    documentUrl: 'https://www.example.it/p', documentHost: 'www.example.it', blockedRaw: 'https://evil.example/x.js',
    sourceFile: 'https://www.example.it/app.js', sample: '', line: 3, disposition: 'report', ua: 'Chrome 131',
    isBot: false, ...o,
  };
}

/** App with a logged-in client: get(path) and post(path, fields) send the session cookie (and Origin for POSTs). */
export function dash(overrides: Partial<Deps> = {}) {
  const deps = testDeps(overrides);
  const app = createApp(deps);
  const cookie = `${SESSION_COOKIE}=${signSession(deps.config.sessionSecret, NOW + SESSION_TTL_MS)}`;
  const get = (path: string) => app.request(path, { headers: { cookie } });
  const post = (path: string, fields: Record<string, string | string[]> = {}) => {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) body.append(k, x);
    return app.request(path, {
      method: 'POST',
      headers: { cookie, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  };
  return { deps, db: deps.db, app, get, post };
}
