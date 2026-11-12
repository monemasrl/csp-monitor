import { describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/auth/password.js';
import { loadConfig } from '../../src/config.js';
import { createApp } from '../../src/web/app.js';
import { NOW, testDeps, validEnv } from '../helpers.js';

const ORIGIN = 'https://m.example.it';
function setup(env: Record<string, string | undefined> = {}) {
  const config = loadConfig(validEnv({ ADMIN_PASSWORD_HASH: hashPassword('segreta'), ...env }));
  return createApp(testDeps({ config }));
}
const form = (pw: string) => ({
  method: 'POST',
  headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ password: pw }).toString(),
});
const cookieOf = (res: Response) => res.headers.get('set-cookie') ?? '';

describe('auth', () => {
  it('redirects anonymous dashboard requests to /login', async () => {
    const res = await setup().request('/');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/login');
  });
  it('leaves /health, /r/:key and /static open', async () => {
    const app = setup();
    expect((await app.request('/health')).status).toBe(200);
    expect((await app.request('/r/nope', { method: 'POST', body: '{}' })).status).toBe(204);
    expect((await app.request('/static/style.css')).status).not.toBe(303);
  });
  it('serves the login page in Italian', async () => {
    const res = await setup().request('/login');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Accedi');
  });
  it('logs in with the right password and sets a hardened cookie', async () => {
    const app = setup();
    const res = await app.request('/login', form('segreta'));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
    const c = cookieOf(res);
    expect(c).toContain('cspm_session=');
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Strict');
    expect(c).toContain('Path=/');
    expect(c).toContain('Max-Age=2592000');
    expect(c).toContain('Secure');
    const value = c.match(/cspm_session=([^;]+)/)![1]!;
    expect(value.startsWith(String(NOW + 30 * 86_400_000) + '.')).toBe(true);
    // the cookie lets us through (no route at "/" yet: anything but a login redirect)
    const next = await app.request('/', { headers: { cookie: `cspm_session=${value}` } });
    expect(next.headers.get('location')).not.toBe('/login');
  });
  it('omits Secure when secureCookies is off', async () => {
    const res = await setup({ SECURE_COOKIES: 'false' }).request('/login', form('segreta'));
    expect(cookieOf(res)).not.toContain('Secure');
  });
  it('rejects a wrong password with 401 and the Italian message', async () => {
    const res = await setup().request('/login', form('no'));
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('Password non corretta');
    expect(cookieOf(res)).not.toContain('cspm_session');
  });
  it('rejects a tampered cookie', async () => {
    const res = await setup().request('/', { headers: { cookie: 'cspm_session=99999999999999.AAAA' } });
    expect(res.status).toBe(303);
  });
  it('blocks the 6th attempt with 429 even with the right password', async () => {
    const app = setup();
    for (let i = 0; i < 5; i++) expect((await app.request('/login', form('no'))).status).toBe(401);
    const res = await app.request('/login', form('segreta'));
    expect(res.status).toBe(429);
    expect(await res.text()).toContain('Troppi tentativi');
  });
  it('keys the limiter on the first X-Forwarded-For value when trustProxy', async () => {
    const app = setup();
    const h = (ip: string) => ({ ...form('no'), headers: { ...form('no').headers, 'x-forwarded-for': `${ip}, 9.9.9.9` } });
    for (let i = 0; i < 5; i++) await app.request('/login', h('1.1.1.1'));
    expect((await app.request('/login', { ...form('segreta'), headers: { ...form('x').headers, 'x-forwarded-for': '1.1.1.1' } })).status).toBe(429);
    expect((await app.request('/login', { ...form('segreta'), headers: { ...form('x').headers, 'x-forwarded-for': '2.2.2.2' } })).status).toBe(303);
  });
  it('a successful login resets the failure count', async () => {
    const app = setup();
    for (let i = 0; i < 4; i++) await app.request('/login', form('no'));
    await app.request('/login', form('segreta'));
    for (let i = 0; i < 4; i++) expect((await app.request('/login', form('no'))).status).toBe(401);
  });
  it('rejects cross-origin and origin-less POSTs with 403, including /login and /sites', async () => {
    const app = setup();
    const evil = { ...form('segreta'), headers: { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' } };
    expect((await app.request('/login', evil)).status).toBe(403);
    expect((await app.request('/sites', { method: 'POST', headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await app.request('/login', { method: 'POST', body: 'password=segreta', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status).toBe(403);
  });
  it('logout clears the cookie and redirects to /login', async () => {
    const res = await setup().request('/logout', { method: 'POST', headers: { origin: ORIGIN } });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/login');
    expect(cookieOf(res)).toContain('Max-Age=0');
  });
  it('parallel attempts cannot bypass the limiter', async () => {
    const app = setup();
    const reqs = [...Array(19)].map(() => app.request('/login', form('no')));
    reqs.push(app.request('/login', form('segreta')));
    const statuses = (await Promise.all(reqs)).map((r) => r.status);
    expect(statuses).toContain(429);
    expect(statuses).not.toContain(303);
  });
  it('rejects oversized dashboard POST bodies with 413', async () => {
    const big = { ...form('x'), body: 'password=' + 'a'.repeat(20_000) };
    expect((await setup().request('/login', big)).status).toBe(413);
  });
  it('treats an over-long password as wrong and counts it as a failure', async () => {
    const app = setup();
    const long = form('a'.repeat(2000));
    for (let i = 0; i < 5; i++) expect((await app.request('/login', long)).status).toBe(401);
    expect((await app.request('/login', form('segreta'))).status).toBe(429);
  });
});
