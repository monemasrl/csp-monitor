import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { sanitizePath } from '../../src/web/accessLog.js';
import { createSite, endLearning, type Site } from '../../src/store/sites.js';
import { createApp } from '../../src/web/app.js';
import { NOW as T, testDeps, validEnv } from '../helpers.js';

let lines: string[];
let deps: ReturnType<typeof testDeps>;
let site: Site;
const make = (env: Record<string, string> = { LOG_REQUESTS: '1' }, write: (l: string) => void = (l) => { lines.push(l); }) => {
  deps = testDeps({ config: loadConfig(validEnv(env)) });
  site = createSite(deps.db, { name: 'S', domains: ['www.example.it'] }, T - 30 * 86_400_000);
  endLearning(deps.db, site.id, T - 1000);
  return createApp(deps, write);
};
beforeEach(() => { lines = []; });

describe('access log', () => {
  it('logs POST /r/:key without query, IP, UA or cookie', async () => {
    const app = make();
    const res = await app.request(`/r/${site.key}?email=a@b.it`, {
      method: 'POST', body: '{}',
      headers: { 'content-type': 'application/csp-report', 'x-forwarded-for': '203.0.113.7', 'user-agent': 'UAMARKER/1.0', cookie: 'sid=COOKIEVAL' },
    });
    expect(res.status).toBe(204);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(new RegExp(`^\\[http\\] POST /r/${site.key} 204 \\d+ms$`));
    for (const bad of ['203.0.113.7', 'UAMARKER', 'COOKIEVAL', '?', 'email']) expect(lines[0]).not.toContain(bad);
  });
  it('logs a redirect and a static GET', async () => {
    const app = make();
    const r = await app.request('/sites/3?x=1');
    expect(r.status).toBe(303);
    expect(lines[0]).toMatch(/^\[http\] GET \/sites\/3 303 \d+ms$/);
    const s = await app.request('/static/style.css');
    expect(lines[1]).toMatch(/^\[http\] GET \/static\/style\.css 200 \d+ms$/);
    expect(s.status).toBe(200);
  });
  it('logs a successful dashboard-style response status', async () => {
    const app = make();
    await app.request('/login');
    expect(lines[0]).toMatch(/^\[http\] GET \/login 200 \d+ms$/);
  });
  it('does not log /health 200', async () => {
    const app = make();
    expect((await app.request('/health')).status).toBe(200);
    expect(lines).toEqual([]);
  });
  it('logs /health when not 200', async () => {
    const app = make();
    deps.db.close();
    expect((await app.request('/health')).status).toBe(503);
    expect(lines[0]).toMatch(/^\[http\] GET \/health 503 /);
  });
  it('sanitizes control characters, whitespace and length', async () => {
    expect(sanitizePath('/a b\nc\r\td\u0000e')).toBe('/a_b_c__d_e');
    expect(sanitizePath('/' + 'x'.repeat(500))).toHaveLength(200);
    const app = make();
    await app.request('/a%20b%0Ac');
    await app.request('/zz zz');
    for (const l of lines) { expect(l.split('\n')).toHaveLength(1); expect(l).toMatch(/^\[http\] GET \S+ \d+ \d+ms$/); }
  });
  it('LOG_REQUESTS=0 logs nothing; default is on; other values are false like other flags', async () => {
    const app = make({ LOG_REQUESTS: '0' });
    await app.request('/login');
    expect(lines).toEqual([]);
    expect(loadConfig(validEnv({ LOG_REQUESTS: undefined })).logRequests).toBe(true);
    expect(loadConfig(validEnv({ LOG_REQUESTS: 'true' })).logRequests).toBe(true);
    expect(loadConfig(validEnv({ LOG_REQUESTS: 'nope' })).logRequests).toBe(false);
  });
  it('a throwing writer does not change responses', async () => {
    const app = make({ LOG_REQUESTS: '1' }, () => { throw new Error('boom'); });
    const res = await app.request(`/r/${site.key}`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/csp-report' } });
    expect(res.status).toBe(204);
    expect((await app.request('/login')).status).toBe(200);
  });
});
