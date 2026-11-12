import { beforeEach, describe, expect, it } from 'vitest';
import { ingest } from '../../../src/ingest/handler.js';
import { HANDLERS } from '../../../src/ingest/handlers/index.js';
import { isoWeek } from '../../../src/ingest/handlers/rates.js';
import type { RawReport } from '../../../src/ingest/parse.js';
import { listDiscarded } from '../../../src/store/discarded.js';
import { createSite, endLearning, getSite, type Site } from '../../../src/store/sites.js';
import type { Deps } from '../../../src/web/app.js';
import { NOW as T, testDeps } from '../../helpers.js';

const DAY = 86_400_000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36';
const nel = (body: Record<string, unknown>, url = 'https://www.gida-spa.it/api/x'): RawReport => ({
  type: 'network-error', url, age: 5, userAgent: UA,
  body: { sampling_fraction: 1, server_ip: '203.0.113.9', protocol: 'h2', method: 'GET', status_code: 0, elapsed_time: 30, phase: 'connection', type: 'tcp.timed_out', ...body },
} as RawReport);
const ok = (sf = 0.01, url?: string) => nel({ type: 'ok', phase: 'application', status_code: 200, sampling_fraction: sf }, url);
const crash = (reason: string | undefined, url = 'https://www.gida-spa.it/checkout'): RawReport => ({
  type: 'crash', url, userAgent: UA, body: reason === undefined ? {} : { reason },
} as RawReport);

let deps: Deps;
let site: Site;
beforeEach(() => {
  deps = testDeps();
  site = createSite(deps.db, { name: 'S', domains: ['www.gida-spa.it'] }, T - 30 * DAY);
  endLearning(deps.db, site.id, T - 1000);
  site = getSite(deps.db, site.id)!;
});

function run(raw: RawReport, now = T, s: Site = site) {
  const h = HANDLERS.get(raw.type)!;
  const e = h.toEvent(raw, s);
  expect(e).not.toBeNull();
  const ctx = { db: deps.db, site: s, now };
  const r = h.record(ctx, e, raw);
  return { r, alert: r ? h.decide(ctx, e, r) : null };
}
const n = (sql: string) => (deps.db.prepare(sql).get() as { n: number }).n;
const reminders = () => deps.db.prepare('SELECT * FROM reminders').all() as { kind: string; ref: string; sent_at: number | null }[];

describe('network-error handler', () => {
  it('rejects reports without url or type', () => {
    const h = HANDLERS.get('network-error')!;
    expect(h.toEvent(nel({}, ''), site)).toBeNull();
    expect(h.toEvent(nel({ type: undefined }), site)).toBeNull();
  });
  it('ok reports only bump total, weighted by 1/sampling_fraction', () => {
    run(ok(0.01));
    run(ok(0.5));
    run(ok(0)); // invalid fraction counts as 1
    run(ok(2));
    expect(n("SELECT SUM(count) n FROM window_counts WHERE k = 'total'")).toBe(100 + 2 + 1 + 1);
    expect(n("SELECT COUNT(*) n FROM window_counts WHERE k = 'errors'")).toBe(0);
    for (const t of ['origins', 'samples', 'daily_counts']) expect(n(`SELECT COUNT(*) n FROM ${t}`)).toBe(0);
  });
  it('errors bump total and errors and are recorded (keyA = type, keyB = host)', () => {
    const a = run(nel({}));
    expect(HANDLERS.get('network-error')!.keys(HANDLERS.get('network-error')!.toEvent(nel({}), site))).toEqual(['tcp.timed_out', 'www.gida-spa.it']);
    expect(a.r!.isNewRow).toBe(true);
    expect(n("SELECT count n FROM window_counts WHERE k = 'errors'")).toBe(1);
    expect(n("SELECT count n FROM window_counts WHERE k = 'total'")).toBe(1);
    expect(n('SELECT COUNT(*) n FROM samples')).toBe(1);
  });
  it('accepts camelCase', () => {
    run(nel({ sampling_fraction: undefined, samplingFraction: 0.1 }));
    expect(n("SELECT count n FROM window_counts WHERE k = 'total'")).toBe(10);
  });
  it('never stores the server IP', () => {
    run(nel({ server_ip: '203.0.113.9', serverIP: '203.0.113.9', client: { ip: '198.51.100.1' }, extra: '2001:db8::1' }));
    const dump = JSON.stringify(deps.db.prepare('SELECT * FROM samples').all());
    expect(dump).not.toMatch(/203\.0\.113|198\.51\.100|2001:db8|server_ip|serverIP/);
    expect(dump).toContain('tcp.timed_out');
  });
  it('300 estimated requests and 1 error: no alert', () => {
    run(ok(0.01), T - 60_000); // 100 each
    run(ok(0.01), T - 50_000);
    run(ok(0.01), T - 40_000);
    expect(run(nel({})).alert).toBeNull();
  });
  it('300 estimated requests and 3 errors: nel-rate with short string payload, then throttled for 6 hours', () => {
    for (let i = 0; i < 3; i++) run(ok(0.01), T - 60_000);
    run(nel({ type: 'dns.unreachable' }), T - 30_000);
    run(nel({ type: 'dns.unreachable' }), T - 20_000);
    const a = run(nel({ type: 'dns.unreachable' }));
    expect(a.alert).toEqual({ kind: 'nel-rate', payload: { errors: '3', total: '303', rate: '0.99%' } });
    expect(reminders()).toEqual([expect.objectContaining({ kind: 'nel-rate', sent_at: T })]);
    expect(run(nel({ type: 'dns.unreachable' }), T + 60_000).alert).toBeNull();
    // next 6-hour slot: the window is empty by then, so feed it again
    const later = T + 7 * 3_600_000;
    for (let i = 0; i < 3; i++) run(ok(0.01), later - 60_000);
    const alerts = [30_000, 20_000, 0].map(d => run(nel({ type: 'dns.unreachable' }), later - d).alert?.kind);
    expect(alerts.filter(Boolean)).toEqual(['nel-rate']); // exactly one in the new slot
  });
  it('3 requests and 2 errors: below the 200 minimum', () => {
    run(ok(1));
    run(nel({}));
    expect(run(nel({})).alert).toBeNull();
  });
  it('buckets older than 15 minutes do not count', () => {
    for (let i = 0; i < 3; i++) run(ok(0.01), T - 3_600_000);
    for (let i = 0; i < 5; i++) run(nel({}), T);
    expect(run(nel({})).alert).toBeNull();
  });
  it('first tls.cert error alerts immediately, only once, never while learning', () => {
    const a = run(nel({ type: 'tls.cert.date_invalid' }));
    expect(a.alert).toEqual({ kind: 'tls-error', originId: a.r!.originId, immediate: true, payload: { type: 'tls.cert.date_invalid', host: 'www.gida-spa.it' } });
    expect(run(nel({ type: 'tls.cert.date_invalid' })).alert).toBeNull();
    const learn = { ...site, learningUntil: T + DAY };
    expect(run(nel({ type: 'tls.cert.name_invalid' }), T, learn).alert).toBeNull();
  });
  it('non-tls new rows below the threshold do not alert', () => {
    expect(run(nel({ type: 'dns.unreachable' })).alert).toBeNull();
  });
});

describe('network-error pipeline', () => {
  const post = (r: RawReport) => ingest(deps, site.key, 'application/reports+json', JSON.stringify([{ type: r.type, url: r.url, age: 1, user_agent: UA, body: r.body }]), T);
  const noise = (reason: string) => n(`SELECT COALESCE(SUM(count), 0) n FROM noise_counts WHERE reason = '${reason}'`);

  it('ok report: counted, not invalid, no rows, site touched', () => {
    post(ok());
    expect(noise('invalid')).toBe(0);
    expect(n("SELECT count n FROM window_counts WHERE k = 'total'")).toBe(100);
    for (const t of ['origins', 'samples', 'daily_counts', 'discarded']) expect(n(`SELECT COUNT(*) n FROM ${t}`)).toBe(0);
    expect(getSite(deps.db, site.id)!.lastReportAt).toBe(T);
  });
  it('foreign host is foreign-document noise and counts nothing; the discarded copy has no IP', () => {
    post(ok(0.01, 'https://other.example/x'));
    post(nel({}, 'https://other.example/x'));
    expect(noise('foreign-document')).toBe(2);
    expect(n('SELECT COUNT(*) n FROM window_counts')).toBe(0);
    const d = listDiscarded(deps.db, site.id);
    expect(d).toHaveLength(2);
    expect(JSON.stringify(d)).not.toContain('203.0.113.9');
  });
  it('bots are noise', () => {
    ingest(deps, site.key, 'application/reports+json', JSON.stringify([{ type: 'network-error', url: 'https://www.gida-spa.it/', user_agent: 'Googlebot/2.1', body: { type: 'tcp.reset', sampling_fraction: 1 } }]), T);
    expect(noise('bot')).toBe(1);
    expect(n('SELECT COUNT(*) n FROM window_counts')).toBe(0);
  });
});

describe('crash handler', () => {
  const seed = (reason: string, day: number, count: number) => {
    deps.db.prepare("INSERT INTO daily_counts (site_id, report_type, directive, origin, day, count) VALUES (?, 'crash', ?, '/checkout', ?, ?)")
      .run(site.id, reason, new Date(T - day * DAY).toISOString().slice(0, 10), count);
  };

  it('keys: reason (or unknown) and page path', () => {
    const h = HANDLERS.get('crash')!;
    expect(h.keys(h.toEvent(crash('oom'), site))).toEqual(['oom', '/checkout']);
    expect(h.keys(h.toEvent(crash(undefined, 'https://www.gida-spa.it/a?x=1'), site))).toEqual(['unknown', '/a']);
    expect(h.toEvent(crash('oom', ''), site)).toBeNull();
  });
  it('2 -> 6 week over week: crash-spike, once per page per week', () => {
    seed('oom', 10, 2); // previous 7 days
    seed('oom', 3, 5);  // last 7 days (this report makes 6)
    const a = run(crash('oom'));
    expect(a.alert).toEqual({ kind: 'crash-spike', originId: a.r!.originId, payload: { page: '/checkout', reason: 'oom', last7days: '6', previous7days: '2' } });
    expect(reminders()).toEqual([expect.objectContaining({ kind: 'crash-spike', ref: `/checkout|${isoWeek(T)}`, sent_at: T })]);
    expect(run(crash('oom')).alert).toBeNull();
    // next ISO week: alerts again
    const next = T + 7 * DAY;
    seed('oom', -7, 30); // dwarfs the previous week
    expect(run(crash('oom'), next).alert?.kind).toBe('crash-spike');
  });
  it('4 -> 6: below 2x the previous week, no alert', () => {
    seed('oom', 10, 4);
    seed('oom', 3, 5);
    expect(run(crash('oom')).alert).toBeNull();
  });
  it('below the minimum of 5: no alert even with no history', () => {
    for (let i = 0; i < 4; i++) expect(run(crash('oom')).alert).toBeNull();
    expect(run(crash('oom')).alert?.kind).toBe('crash-spike');
  });
  it('no alert while learning; other pages are independent', () => {
    seed('oom', 3, 9);
    expect(run(crash('oom'), T, { ...site, learningUntil: T + DAY }).alert).toBeNull();
    expect(reminders()).toHaveLength(0);
    expect(run(crash('oom', 'https://www.gida-spa.it/other')).alert).toBeNull();
  });
});

describe('isoWeek', () => {
  it('follows ISO 8601 at year boundaries', () => {
    expect(isoWeek(Date.UTC(2026, 0, 1))).toBe('2026-W01');
    expect(isoWeek(Date.UTC(2027, 0, 1))).toBe('2026-W53');
    expect(isoWeek(Date.UTC(2024, 11, 30))).toBe('2025-W01');
  });
});
