import { beforeEach, describe, expect, it } from 'vitest';
import { ingest } from '../../src/ingest/handler.js';
import { KEEP_DISCARDED, listDiscarded, recordDiscarded, stripQueries } from '../../src/store/discarded.js';
import { clearSiteData, createSite, deleteSite, endLearning, type Site } from '../../src/store/sites.js';
import type { Deps } from '../../src/web/app.js';
import { NOW as T, testDeps } from '../helpers.js';

const CHROME = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const legacy = (doc: string, blocked: string) =>
  JSON.stringify({ 'csp-report': { 'document-uri': doc, 'blocked-uri': blocked, 'effective-directive': 'script-src' } });

let deps: Deps;
let site: Site;
beforeEach(() => {
  deps = testDeps();
  site = createSite(deps.db, { name: 'S', domains: ['www.example.it'] }, T - 30 * 86_400_000);
  endLearning(deps.db, site.id, T - 1000);
});

describe('stripQueries', () => {
  it('drops query strings and fragments from every URL, keeping the rest', () => {
    expect(stripQueries('{"a":"https://x.it/p?email=a@b.it#f","b":"wss://y.it/s?t=1","c":"inline"}'))
      .toBe('{"a":"https://x.it/p","b":"wss://y.it/s","c":"inline"}');
  });
});

describe('discarded reports', () => {
  it('keeps invalid bodies with content type and browser, without query strings', () => {
    ingest(deps, site.key, 'application/csp-report', '{"foo":"https://x.it/?token=secret"}', T, CHROME);
    const [d] = listDiscarded(deps.db, site.id);
    expect(d).toMatchObject({ reason: 'invalid', contentType: 'application/csp-report', ua: 'Chrome 142', receivedAt: T });
    expect(d!.body).toBe('{"foo":"https://x.it/"}');
  });

  it('records the noise reason of filtered CSP reports', () => {
    ingest(deps, site.key, 'application/csp-report', legacy('https://other.example/', 'https://evil.example/x.js'), T, CHROME);
    ingest(deps, site.key, 'application/csp-report', legacy('https://www.example.it/', 'chrome-extension://abc/x.js'), T, CHROME);
    expect(listDiscarded(deps.db, site.id).map(d => d.reason).sort()).toEqual(['extension', 'foreign-document']);
  });

  it('records report types that are not handled yet, with their type', () => {
    const coep = JSON.stringify([{ type: 'coep', url: 'https://www.example.it/', body: { type: 'corp', blockedURL: 'https://x.it/a.png' } }]);
    ingest(deps, site.key, 'application/reports+json', coep, T, CHROME);
    const [d] = listDiscarded(deps.db, site.id);
    expect(d).toMatchObject({ reason: 'unsupported-type', detail: 'coep' });
    // not counted as noise
    expect(deps.db.prepare('SELECT COUNT(*) n FROM noise_counts').get()).toEqual({ n: 0 });
  });

  it('does not record accepted reports', () => {
    ingest(deps, site.key, 'application/csp-report', legacy('https://www.example.it/', 'https://evil.example/x.js'), T, CHROME);
    expect(listDiscarded(deps.db, site.id)).toEqual([]);
  });

  it(`keeps only the latest ${KEEP_DISCARDED} per site, newest first`, () => {
    for (let i = 0; i < KEEP_DISCARDED + 5; i++) {
      recordDiscarded(deps.db, site.id, T + i, 'invalid', { body: String(i) });
    }
    const rows = listDiscarded(deps.db, site.id);
    expect(rows).toHaveLength(KEEP_DISCARDED);
    expect(rows[0]!.body).toBe(String(KEEP_DISCARDED + 4));
  });

  it('truncates long bodies', () => {
    recordDiscarded(deps.db, site.id, T, 'invalid', { body: 'x'.repeat(10_000) });
    expect(listDiscarded(deps.db, site.id)[0]!.body.length).toBeLessThanOrEqual(4096 + 1);
  });

  it('is removed by clear-data and delete', () => {
    recordDiscarded(deps.db, site.id, T, 'invalid', { body: 'a' });
    clearSiteData(deps.db, site.id);
    expect(listDiscarded(deps.db, site.id)).toEqual([]);
    recordDiscarded(deps.db, site.id, T, 'invalid', { body: 'a' });
    deleteSite(deps.db, site.id);
    expect(deps.db.prepare('SELECT COUNT(*) n FROM discarded').get()).toEqual({ n: 0 });
  });
});

describe('site page', () => {
  it('lists the latest discarded reports with reason and pretty-printed body', async () => {
    const { dash } = await import('../web/dash.js');
    const d = dash();
    const s = createSite(d.db, { name: 'P', domains: ['www.example.it'] }, T - 30 * 86_400_000);
    expect(await (await d.get(`/sites/${s.id}`)).text()).toContain('Nessun report scartato di recente.');
    recordDiscarded(d.db, s.id, T, 'unsupported-type', { body: '{"type":"coep","x":"<b>"}', detail: 'coep', contentType: 'application/reports+json', ua: 'Safari 27' });
    const html = await (await d.get(`/sites/${s.id}`)).text();
    expect(html).toContain('Ultimi report scartati');
    expect(html).toContain('Tipo non gestito');
    expect(html).toContain('Safari 27');
    expect(html).toContain('&quot;type&quot;: &quot;coep&quot;');
    expect(html).not.toContain('"<b>"');
  });
});

describe('privacy', () => {
  it('does not keep the full user agent of parsed reports', () => {
    const r = JSON.stringify([{ type: 'deprecation', url: 'https://www.example.it/', user_agent: CHROME, body: { id: 'x' } }]);
    ingest(deps, site.key, 'application/reports+json', r, T, CHROME);
    const [d] = listDiscarded(deps.db, site.id);
    expect(d!.body).not.toContain('Mozilla');
    expect(d!.ua).toBe('Chrome 142');
  });
});
