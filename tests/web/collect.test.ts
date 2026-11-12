import { beforeEach, describe, expect, it } from 'vitest';
import { createSite, endLearning, type Site } from '../../src/store/sites.js';
import { createApp } from '../../src/web/app.js';
import { NOW as T, testDeps } from '../helpers.js';

const CT = 'application/csp-report';
let deps: ReturnType<typeof testDeps>;
let app: ReturnType<typeof createApp>;
let site: Site;
const noise = (reason: string) =>
  (deps.db.prepare('SELECT COALESCE(SUM(count),0) n FROM noise_counts WHERE reason = ?').get(reason) as { n: number }).n;

beforeEach(() => {
  deps = testDeps();
  app = createApp(deps);
  site = createSite(deps.db, { name: 'S', domains: ['www.example.it'] }, T - 30 * 86_400_000);
  endLearning(deps.db, site.id, T - 1000);
});

describe('POST/OPTIONS /r/:key', () => {
  it('responds 204 with empty body and CORS to everything', async () => {
    for (const [key, body] of [['nope', '{}'], [site.key, '{bad'], [site.key, 'x'.repeat(70_000)]] as const) {
      const res = await app.request(`/r/${key}`, { method: 'POST', headers: { 'content-type': CT }, body });
      expect(res.status).toBe(204);
      expect(await res.text()).toBe('');
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    }
  });
  it('answers CORS preflight', async () => {
    const res = await app.request(`/r/${site.key}`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
    expect(res.headers.get('access-control-allow-headers')).toBe('Content-Type');
  });
  it('oversized body (content-length and streamed) is discarded and counted invalid', async () => {
    const big = JSON.stringify({ 'csp-report': { 'document-uri': 'https://www.example.it/', 'blocked-uri': 'https://evil.example/', 'effective-directive': 'script-src', pad: 'x'.repeat(70_000) } });
    await app.request(`/r/${site.key}`, { method: 'POST', headers: { 'content-type': CT, 'content-length': String(big.length) }, body: big });
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); } });
    await app.request(`/r/${site.key}`, { method: 'POST', headers: { 'content-type': CT }, body: stream, duplex: 'half' } as RequestInit);
    expect(noise('invalid')).toBe(2);
    expect(deps.db.prepare('SELECT COUNT(*) n FROM origins').get()).toEqual({ n: 0 });
  });
  it('stores a valid report and never keeps query strings or the client IP', async () => {
    const body = JSON.stringify({ 'csp-report': { 'document-uri': 'https://www.example.it/p?email=a@b.it', 'blocked-uri': 'https://evil.example/x.js?q=1', 'effective-directive': 'script-src' } });
    const res = await app.request(`/r/${site.key}`, { method: 'POST', headers: { 'content-type': CT, 'x-forwarded-for': '203.0.113.7' }, body });
    expect(res.status).toBe(204);
    for (const table of ['samples', 'origins']) {
      const rows = deps.db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
      expect(rows.length).toBe(1);
      for (const v of Object.values(rows[0]!)) if (typeof v === 'string') { expect(v).not.toContain('?'); expect(v).not.toContain('203.0.113.7'); }
    }
  });
});
