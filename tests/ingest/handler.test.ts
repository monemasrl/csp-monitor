import { beforeEach, describe, expect, it } from 'vitest';
import { ingest } from '../../src/ingest/handler.js';
import { addApprovalPattern } from '../../src/store/origins.js';
import { createSite, endLearning, type Site } from '../../src/store/sites.js';
import type { Deps } from '../../src/web/app.js';
import { NOW as T, testDeps } from '../helpers.js';

const CT = 'application/csp-report';
const legacy = (o: { blockedURL: string; doc?: string; directive?: string }) =>
  JSON.stringify({
    'csp-report': {
      'document-uri': o.doc ?? 'https://www.example.it/page?email=a@b.it',
      'blocked-uri': o.blockedURL,
      'effective-directive': o.directive ?? 'script-src',
    },
  });

export function countNoise(db: Deps['db'], siteId: number, reason: string): number {
  const r = db.prepare('SELECT COALESCE(SUM(count),0) AS n FROM noise_counts WHERE site_id = ? AND reason = ?').get(siteId, reason) as { n: number };
  return r.n;
}

let deps: Deps;
let site: Site;
let alerts: [number, number][];

beforeEach(() => {
  alerts = [];
  deps = testDeps({ onAlert: (s, req) => { alerts.push([s, req.originId!]); } });
  site = createSite(deps.db, { name: 'S', domains: ['www.example.it'] }, T - 30 * 86_400_000);
  endLearning(deps.db, site.id, T - 1000);
});

describe('ingest', () => {
  it('records a new origin, alerts once and sets last_alert_at', () => {
    ingest(deps, site.key, CT, legacy({ blockedURL: 'https://evil.example/x.js' }), T);
    expect(alerts).toHaveLength(1);
    const o = deps.db.prepare('SELECT last_alert_at FROM origins').get() as { last_alert_at: number };
    expect(o.last_alert_at).toBe(T);
    expect(deps.db.prepare('SELECT last_report_at FROM sites').get()).toEqual({ last_report_at: T });
  });
  it('unknown key and garbage store nothing and do not throw', () => {
    ingest(deps, 'nope', CT, '{}', T);
    ingest(deps, site.key, CT, '{bad', T);
    ingest(deps, site.key, 'application/json', '[]', T);
    ingest(deps, site.key, 'text/plain', '{"foo":1}', T);
    expect(deps.db.prepare('SELECT COUNT(*) n FROM samples').get()).toEqual({ n: 0 });
    expect(deps.db.prepare('SELECT COUNT(*) n FROM origins').get()).toEqual({ n: 0 });
    expect(countNoise(deps.db, site.id, 'invalid')).toBe(3);
  });
  it('accepts text/plain and application/json content types', () => {
    ingest(deps, site.key, 'text/plain', legacy({ blockedURL: 'https://a.example/x.js' }), T);
    ingest(deps, site.key, 'application/json', legacy({ blockedURL: 'https://b.example/x.js' }), T);
    expect(deps.db.prepare('SELECT COUNT(*) n FROM origins').get()).toEqual({ n: 2 });
  });
  it('counts a report without document URL as invalid', () => {
    ingest(deps, site.key, CT, JSON.stringify({ 'csp-report': { 'blocked-uri': 'https://a.example' } }), T);
    expect(countNoise(deps.db, site.id, 'invalid')).toBe(1);
  });
  it('ignores non-csp report types silently', () => {
    ingest(deps, site.key, 'application/reports+json', JSON.stringify([{ type: 'deprecation', body: { id: 'x' } }]), T);
    expect(countNoise(deps.db, site.id, 'invalid')).toBe(0);
    expect(deps.db.prepare('SELECT COUNT(*) n FROM samples').get()).toEqual({ n: 0 });
  });
  it('counts noise (extension) and records nothing', () => {
    ingest(deps, site.key, CT, legacy({ blockedURL: 'chrome-extension://abc/x.js' }), T);
    expect(countNoise(deps.db, site.id, 'extension')).toBe(1);
    expect(deps.db.prepare('SELECT COUNT(*) n FROM origins').get()).toEqual({ n: 0 });
  });
  it('uses custom noise_patterns', () => {
    deps.db.prepare("INSERT INTO noise_patterns (pattern, created_at) VALUES ('https://junk.example', 0)").run();
    ingest(deps, site.key, CT, legacy({ blockedURL: 'https://junk.example/a.js' }), T);
    expect(countNoise(deps.db, site.id, 'known-noise')).toBe(1);
    expect(alerts).toHaveLength(0);
  });
  it('a new origin inside a flood still reaches the alert queue', () => {
    addApprovalPattern(deps.db, site.id, 'https://known.example', ['script-src'], T);
    for (let i = 0; i < 500; i++) ingest(deps, site.key, CT, legacy({ blockedURL: 'https://known.example/a.js' }), T);
    ingest(deps, site.key, CT, legacy({ blockedURL: 'https://evil.example/x.js' }), T);
    expect(alerts).toHaveLength(1);
    expect(countNoise(deps.db, site.id, 'rate-limit')).toBeGreaterThan(0);
    expect(deps.db.prepare("SELECT COUNT(*) n FROM origins WHERE origin = 'https://evil.example'").get()).toEqual({ n: 1 });
  });
  it('caps never-seen origins past the rate limit at 500 per UTC day', () => {
    deps.db.prepare('UPDATE sites SET rate_per_min = 1 WHERE id = ?').run(site.id);
    site = { ...site, ratePerMin: 1 };
    const send = (i: number, now: number) =>
      ingest(deps, site.key, CT, legacy({ blockedURL: `https://h${i}.example/a.js` }), now);
    send(0, T); // consumes the single in-limit slot
    for (let i = 1; i <= 500; i++) send(i, T);
    expect(deps.db.prepare('SELECT COUNT(*) n FROM origins').get()).toEqual({ n: 501 });
    send(501, T);
    expect(deps.db.prepare('SELECT COUNT(*) n FROM origins').get()).toEqual({ n: 501 });
    expect(countNoise(deps.db, site.id, 'rate-limit')).toBe(1);
    const next = T + 86_400_000;
    send(502, next); // new minute: within limit anyway
    send(503, next); // over limit, new UTC day: unseen allowed again
    expect(deps.db.prepare('SELECT COUNT(*) n FROM origins').get()).toEqual({ n: 503 });
  });
  it('never stores query strings or IPs', () => {
    ingest(deps, site.key, CT, legacy({ blockedURL: 'https://evil.example/x.js?token=1' }), T);
    for (const table of ['samples', 'origins']) {
      const rows = deps.db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) for (const v of Object.values(r)) {
        if (typeof v === 'string') { expect(v).not.toContain('?'); expect(v).not.toContain('203.0.113.7'); }
      }
    }
  });
  it('forged noise reports over the limit do not drain the unseen budget (I1)', () => {
    deps.db.prepare('UPDATE sites SET rate_per_min = 1 WHERE id = ?').run(site.id);
    site = { ...site, ratePerMin: 1 };
    ingest(deps, site.key, CT, legacy({ blockedURL: 'https://seed.example/x.js' }), T); // consumes the in-limit slot
    for (let i = 0; i < 500; i++) {
      ingest(deps, site.key, CT, legacy({ doc: 'https://foreign.test/p', blockedURL: `https://h${i}.junk/x.js` }), T);
    }
    alerts.length = 0;
    ingest(deps, site.key, CT, legacy({ blockedURL: 'https://skimmer.evil/x.js' }), T);
    expect(deps.db.prepare("SELECT COUNT(*) n FROM origins WHERE origin = 'https://skimmer.evil'").get()).toEqual({ n: 1 });
    expect(alerts).toHaveLength(1);
  });
  it('legacy reports use the request user agent, reduced (I3)', () => {
    ingest(deps, site.key, CT, legacy({ blockedURL: 'https://ff.example/x.js' }), T,
      'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0');
    expect(deps.db.prepare('SELECT ua FROM samples').get()).toEqual({ ua: 'Firefox 121' });
    expect(JSON.stringify(deps.db.prepare('SELECT * FROM samples').all())).not.toContain('Gecko');
  });
  it('a bot request user agent is classified as bot noise (I3)', () => {
    ingest(deps, site.key, CT, legacy({ blockedURL: 'https://bot.example/x.js' }), T,
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)');
    expect(countNoise(deps.db, site.id, 'bot')).toBe(1);
    expect(deps.db.prepare('SELECT COUNT(*) n FROM origins').get()).toEqual({ n: 0 });
  });
  it('caps documentUrl, page and sourceFile at 2048 chars (M6)', () => {
    const long = 'a'.repeat(5000);
    ingest(deps, site.key, 'application/reports+json', JSON.stringify([{ type: 'csp-violation', body: {
      documentURL: `https://www.example.it/${long}`, effectiveDirective: 'script-src',
      blockedURL: 'https://long.example/x.js', sourceFile: `https://www.example.it/${long}.js`,
    } }]), T);
    const s = deps.db.prepare('SELECT page, source_file FROM samples').get() as { page: string; source_file: string };
    expect(s.page.length).toBeLessThanOrEqual(2048);
    expect(s.source_file.length).toBeLessThanOrEqual(2048);
  });
});
