// The csp-hash fixtures are derived from the CSP Level 3 draft field names (documentURL, subresourceURL,
// hash, destination, disposition), NOT captured from a real browser (none could be captured here). 2026-11-12.
import { beforeEach, describe, expect, it } from 'vitest';
import { HANDLERS } from '../../../src/ingest/handlers/index.js';
import { startRelease } from '../../../src/ingest/handlers/hash.js';
import type { RawReport } from '../../../src/ingest/parse.js';
import { getDetail, markVolatile } from '../../../src/store/origins.js';
import { createSite, endLearning, getSite, type Site } from '../../../src/store/sites.js';
import type { Deps } from '../../../src/web/app.js';
import { NOW as T, testDeps } from '../../helpers.js';

const rep = (body: Record<string, unknown>): RawReport => ({
  type: 'csp-hash', url: 'https://www.gida-spa.it/home', age: 10, userAgent: 'Mozilla/5.0 Chrome/130.0',
  body: {
    documentURL: 'https://www.gida-spa.it/home', subresourceURL: 'https://www.gida-spa.it/app.js?v=1',
    hash: 'sha256-AAA', destination: 'script', disposition: 'report', ...body,
  },
} as RawReport);

let deps: Deps;
let site: Site;
beforeEach(() => {
  deps = testDeps();
  site = createSite(deps.db, { name: 'S', domains: ['www.gida-spa.it'] }, T - 30 * 86_400_000);
  endLearning(deps.db, site.id, T - 1000);
  site = getSite(deps.db, site.id)!;
});

function run(raw: RawReport, s: Site = site, now = T) {
  const h = HANDLERS.get('csp-hash')!;
  const e = h.toEvent(raw, s)!;
  expect(e).not.toBeNull();
  const ctx = { db: deps.db, site: s, now };
  const r = h.record(ctx, e, raw);
  return { keys: h.keys(e), r, alert: h.decide(ctx, e, r) };
}
const status = (id: number) => (deps.db.prepare('SELECT status FROM origins WHERE id = ?').get(id) as { status: string }).status;

describe('csp-hash', () => {
  it('keys: external script without query; inline per page', () => {
    expect(run(rep({})).keys).toEqual(['script', 'https://www.gida-spa.it/app.js']);
    expect(run(rep({ subresourceURL: undefined })).keys).toEqual(['script', 'inline:/home']);
    expect(run(rep({ subresourceURL: undefined, documentURL: 'https://www.gida-spa.it/b' })).keys).toEqual(['script', 'inline:/b']);
  });
  it('new script alerts new-script; same hash then nothing', () => {
    const a = run(rep({}));
    expect(a.alert).toEqual({ kind: 'new-script', originId: a.r.originId });
    expect(run(rep({})).alert).toBeNull();
  });
  it('changed hash alerts hash-changed, resets status to new, tracks previous', () => {
    const a = run(rep({}));
    deps.db.prepare("UPDATE origins SET status = 'approved' WHERE id = ?").run(a.r.originId);
    const b = run(rep({ hash: 'sha256-BBB' }), site, T + 5);
    expect(b.alert?.kind).toBe('hash-changed');
    expect(b.alert?.originId).toBe(a.r.originId);
    expect(b.alert?.payload).toEqual({ previousHash: 'sha256-AAA', currentHash: 'sha256-BBB' });
    expect(status(a.r.originId)).toBe('new');
    expect(getDetail(deps.db, a.r.originId)).toMatchObject({ currentHash: 'sha256-BBB', previousHash: 'sha256-AAA', changedAt: T + 5 });
  });
  it('alerts once while unreviewed; again after approval', () => {
    const a = run(rep({}));
    expect(run(rep({ hash: 'sha256-BBB' })).alert?.kind).toBe('hash-changed');
    expect(run(rep({ hash: 'sha256-CCC' })).alert).toBeNull();
    expect(status(a.r.originId)).toBe('new');
    expect(getDetail(deps.db, a.r.originId)).toMatchObject({ currentHash: 'sha256-CCC', previousHash: 'sha256-BBB' });
    deps.db.prepare("UPDATE origins SET status = 'approved' WHERE id = ?").run(a.r.originId);
    expect(run(rep({ hash: 'sha256-DDD' })).alert?.kind).toBe('hash-changed');
  });
  it('volatile: A to D never alerts, status unchanged', () => {
    const a = run(rep({}));
    deps.db.prepare("UPDATE origins SET status = 'approved' WHERE id = ?").run(a.r.originId);
    markVolatile(deps.db, a.r.originId, true);
    for (const h of ['sha256-BBB', 'sha256-CCC', 'sha256-DDD']) expect(run(rep({ hash: h })).alert).toBeNull();
    expect(status(a.r.originId)).toBe('approved');
    expect(getDetail(deps.db, a.r.originId)?.currentHash).toBe('sha256-DDD');
  });
  it('a url equal to the document URL is inline, not a subresource', () => {
    const h = HANDLERS.get('csp-hash')!;
    const e = h.toEvent(rep({ subresourceURL: undefined, url: 'https://www.gida-spa.it/home' }), site)!;
    expect(h.keys(e)).toEqual(['script', 'inline:/home']);
  });
  it('volatile: no alert, hash becomes current, status unchanged', () => {
    const a = run(rep({}));
    deps.db.prepare("UPDATE origins SET status = 'approved' WHERE id = ?").run(a.r.originId);
    markVolatile(deps.db, a.r.originId, true);
    expect(run(rep({ hash: 'sha256-BBB' })).alert).toBeNull();
    expect(getDetail(deps.db, a.r.originId)).toMatchObject({ currentHash: 'sha256-BBB', volatile: true });
    expect(status(a.r.originId)).toBe('approved');
  });
  it('during a release: no alert, new hash is the reference', () => {
    const a = run(rep({}));
    startRelease(deps.db, site.id, T);
    expect(run(rep({ hash: 'sha256-BBB' }), site, T + 1000).alert).toBeNull();
    expect(getDetail(deps.db, a.r.originId)?.currentHash).toBe('sha256-BBB');
    expect(run(rep({ hash: 'sha256-CCC' }), site, T + 3_600_001).alert?.kind).toBe('hash-changed');
  });
  it('learning: no alerts but the hash is tracked', () => {
    const s = { ...site, learningUntil: T + 10_000 };
    const a = run(rep({}), s);
    expect(a.alert).toBeNull();
    expect(run(rep({ hash: 'sha256-BBB' }), s).alert).toBeNull();
    expect(getDetail(deps.db, a.r.originId)).toMatchObject({ currentHash: 'sha256-BBB', previousHash: 'sha256-AAA' });
  });
  it('pages: unique, most recent kept, max 20', () => {
    let id = 0;
    for (let i = 0; i < 25; i++) id = run(rep({ documentURL: `https://www.gida-spa.it/p${i}` })).r.originId;
    run(rep({ documentURL: 'https://www.gida-spa.it/p10' }));
    const pages = getDetail(deps.db, id)!.pages as string[];
    expect(pages).toHaveLength(20);
    expect(pages.at(-1)).toBe('/p10');
    expect(new Set(pages).size).toBe(20);
  });
  it('accepts snake_case and url fallback; invalid without hash or document URL', () => {
    const h = HANDLERS.get('csp-hash')!;
    const snake: RawReport = { type: 'csp-hash', url: 'https://www.gida-spa.it/x', body: { document_url: 'https://www.gida-spa.it/x', subresource_url: 'https://cdn.x.net/a.js', hash: 'sha256-Z' } } as RawReport;
    expect(h.keys(h.toEvent(snake, site)!)).toEqual(['script', 'https://cdn.x.net/a.js']);
    const fb = rep({ subresourceURL: undefined, url: 'https://cdn.x.net/b.js' });
    expect(h.keys(h.toEvent(fb, site)!)).toEqual(['script', 'https://cdn.x.net/b.js']);
    expect(h.toEvent(rep({ hash: undefined }), site)).toBeNull();
    expect(h.toEvent({ type: 'csp-hash', body: { hash: 'sha256-Z' } } as RawReport, site)).toBeNull();
  });
});
