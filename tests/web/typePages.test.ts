import { describe, expect, it } from 'vitest';
import { escapeHtml } from '../../src/alerts/render.js';
import { suggestedHeaders } from '../../src/headers.js';
import { addApprovalPattern, recordGeneric, type SampleInput } from '../../src/store/origins.js';
import { getSetting } from '../../src/store/settings.js';
import { createSite, endLearning, getSite, type Site } from '../../src/store/sites.js';
import type { Db } from '../../src/db/db.js';
import { TYPE_PAGES } from '../../src/web/typePages.js';
import { NOW } from '../helpers.js';
import { DAY, dash } from './dash.js';

function seeded() {
  const d = dash();
  const created = createSite(d.db, { name: 'Sito A', domains: ['www.example.it'] }, NOW - 30 * DAY);
  endLearning(d.db, created.id, NOW - 20 * DAY);
  return { ...d, site: getSite(d.db, created.id)! };
}

const sample = (o: Partial<SampleInput> = {}): SampleInput =>
  ({ sourceFile: '', sample: '', line: null, ua: 'Chrome 157', disposition: 'report', body: '{}', ...o });

function rec(db: Db, site: Site, type: string, keyA: string, keyB: string, o: { page?: string; at?: number; detail?: object; s?: Partial<SampleInput> } = {}) {
  return recordGeneric(db, site, type, keyA, keyB, 'external', o.page ?? '/p', sample(o.s), o.at ?? NOW - 1000, o.detail);
}

const SLUGS = ['csp-hash', 'integrity-violation', 'connection-allowlist', 'network-error', 'crash', 'deprecation',
  'intervention', 'permissions-policy', 'document-policy', 'coop', 'coep'];

describe('type page setup headers', () => {
  it("csp-hash 'Come si attiva' keeps the site's approved CSP sources", async () => {
    const { db, site, get } = seeded();
    addApprovalPattern(db, site.id, 'https://cdn.example', ['script-src'], NOW - DAY);
    const html = await (await get(`/sites/${site.id}/types/csp-hash`)).text();
    expect(html).toContain(escapeHtml("script-src 'self' https://cdn.example 'report-sha256';"));
  });
});

describe('type pages', () => {
  it('defines the 12 types, in the three menu groups', () => {
    expect(TYPE_PAGES.map(d => d.slug)).toEqual(['csp-violation', 'csp-hash', 'integrity-violation', 'connection-allowlist',
      'network-error', 'crash', 'deprecation', 'intervention', 'permissions-policy', 'document-policy', 'coop', 'coep']);
    expect(TYPE_PAGES.map(d => d.family)).toEqual([...Array(4).fill('attack'), ...Array(4).fill('failure'), ...Array(4).fill('policy')]);
  });

  it('every slug answers 200 with its title and report type', async () => {
    const { site, get } = seeded();
    for (const slug of SLUGS) {
      const def = TYPE_PAGES.find(d => d.slug === slug)!;
      const res = await get(`/sites/${site.id}/types/${slug}`);
      expect(res.status, slug).toBe(200);
      const html = await res.text();
      expect(html, slug).toContain(`<h1>${escapeHtml(def.title)}</h1>`);
      expect(html, slug).toContain(`>${def.type}</span>`);
      expect(html, slug).toContain('Quando ti avvisa');
      expect(html, slug).toContain('Come si attiva');
      expect(html, slug).toContain('Reporting-Endpoints: ');
    }
  });

  it('csp-violation goes to the CSP page; unknown slugs and sites are 404', async () => {
    const { site, get } = seeded();
    const res = await get(`/sites/${site.id}/types/csp-violation`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/sites/${site.id}/csp`);
    expect((await get(`/sites/${site.id}/types/nope`)).status).toBe(404);
    expect((await get(`/sites/${site.id}/types/CRASH`)).status).toBe(404);
    expect((await get(`/sites/999/types/crash`)).status).toBe(404);
  });

  it('escapes report data on every type page', async () => {
    const { db, site, get } = seeded();
    const bad = '"><script>x</script>';
    const img = '<img src=x onerror=alert(1)>';
    const detail = { currentHash: img, previousHash: bad, pages: [bad, img], changedAt: NOW - 5000, message: img, sourceFile: bad, line: 3, anticipatedRemoval: NOW + 40 * DAY };
    for (const def of TYPE_PAGES) {
      rec(db, site, def.type, bad, img, { page: bad, detail, s: { sourceFile: bad, sample: img, ua: bad, disposition: 'enforce' } });
      rec(db, site, def.type, img, bad, { page: img, detail, s: { sourceFile: img, sample: bad } });
    }
    for (const slug of SLUGS) {
      for (const q of ['', `?a=${encodeURIComponent(bad)}`]) {
        const path = `/sites/${site.id}/types/${slug}${q}`;
        const res = await get(path);
        expect(res.status, path).toBe(200);
        const html = await res.text();
        expect(html, path).not.toContain('<img src=x');
        expect(html, path).not.toContain('<script>x');
        expect(html, path).toContain('&lt;script&gt;x');
      }
    }
  });

  it('sidebar shows the three groups with all entries and marks the active one', async () => {
    const { site, get } = seeded();
    const html = await (await get(`/sites/${site.id}/types/crash`)).text();
    for (const g of ['Segnali di attacco', 'Guasti del browser', 'Igiene delle policy']) expect(html).toContain(`<h4>${g}</h4>`);
    for (const label of ['Violazioni CSP', 'Hash degli script', 'Integrità (SRI)', 'Connessioni non dichiarate', 'Errori di rete',
      'Crash', 'Deprecazioni', 'Interventi', 'Permissions Policy', 'Document Policy', 'COOP', 'COEP']) {
      expect(html).toContain(`>${label}</a>`);
    }
    expect(html).toContain(`href="/sites/${site.id}/csp"`);
    expect(html).toContain(`href="/sites/${site.id}/types/crash" class="on"`);
    expect(html).not.toContain(`href="/sites/${site.id}/types/coop" class="on"`);
    expect(html.indexOf('>Riepilogo</a>')).toBeLessThan(html.indexOf('<h4>Segnali di attacco</h4>'));
    expect(html.indexOf('<h4>Igiene delle policy</h4>')).toBeLessThan(html.indexOf(`href="/sites/${site.id}/settings"`));
    const csp = await (await get(`/sites/${site.id}/csp`)).text();
    expect(csp).toContain(`href="/sites/${site.id}/csp" class="on"`);
  });

  it('shows rows and metrics from real data, filtered by query params', async () => {
    const { db, site, get } = seeded();
    rec(db, site, 'network-error', 'dns.name_not_resolved', 'www.example.it', { s: { sample: 'dns' } });
    rec(db, site, 'network-error', 'dns.name_not_resolved', 'www.example.it');
    rec(db, site, 'network-error', 'tcp.timed_out', 'media.example.it', { at: NOW - 10 * DAY });
    let html = await (await get(`/sites/${site.id}/types/network-error`)).text();
    expect(html).toContain('dns.name_not_resolved');
    expect(html).toContain('media.example.it');
    expect(html).toMatch(/Errori 30 gg<\/p><p class="big[^"]*">3</);
    expect(html).toMatch(/Host coinvolti<\/p><p class="big[^"]*">2</);
    html = await (await get(`/sites/${site.id}/types/network-error?b=media.example.it`)).text();
    expect(html).toContain('tcp.timed_out');
    expect(html).not.toContain('>dns.name_not_resolved</td>');

    rec(db, site, 'deprecation', 'api', 'UnloadHandler', { detail: { message: 'Unload is gone', anticipatedRemoval: Date.UTC(2027, 2, 1), sourceFile: 'https://www.example.it/app.js', line: 7 } });
    html = await (await get(`/sites/${site.id}/types/deprecation`)).text();
    expect(html).toContain('UnloadHandler');
    expect(html).toContain('Unload is gone');
    expect(html).toContain('https://www.example.it/app.js:7');
    expect(html).toContain('1 marzo 2027');

    rec(db, site, 'csp-hash', 'script', 'https://www.example.it/app.js', { detail: { currentHash: 'sha256-abc', pages: ['/a', '/b'], changedAt: NOW - 120_000, volatile: true } });
    html = await (await get(`/sites/${site.id}/types/csp-hash`)).text();
    expect(html).toContain('sha256-abc');
    expect(html).toContain('2 pagine');
    expect(html).toContain('2 min fa');
    expect(html).toContain('Non varia');
    expect(html).toContain('Inizia rilascio (1 ora)');
  });

  it('shows the per-type header in "Come si attiva"', async () => {
    const { site, get } = seeded();
    const hash = await (await get(`/sites/${site.id}/types/csp-hash`)).text();
    expect(hash).toContain(escapeHtml("'report-sha256'"));
    const nel = await (await get(`/sites/${site.id}/types/network-error`)).text();
    expect(nel).toContain('NEL: {');
    const crash = await (await get(`/sites/${site.id}/types/crash`)).text();
    expect(crash).not.toContain('Content-Security-Policy');
  });
});

describe('type page actions', () => {
  it('approve on a non-CSP row adds an approval for its keys and approves matching rows', async () => {
    const { db, site, post, get, deps } = seeded();
    const other = getSite(db, createSite(db, { name: 'B', domains: ['b.it'] }, NOW - 30 * DAY).id)!;
    const { originId } = rec(db, site, 'permissions-policy-violation', 'camera', 'https://maps.example');
    rec(db, site, 'permissions-policy-violation', 'geolocation', 'https://maps.example');
    rec(db, other, 'permissions-policy-violation', 'camera', 'https://maps.example');
    const back = `/sites/${site.id}/types/permissions-policy`;
    const res = await post(`/sites/${site.id}/origins/${originId}/approve`, { scope: 'site', back });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(back);
    expect(db.prepare('SELECT site_id, pattern, directive FROM approvals').all()).toEqual([
      { site_id: site.id, pattern: 'https://maps.example', directive: 'permissions-policy-violation:camera' },
    ]);
    expect(db.prepare('SELECT site_id, directive, status FROM origins ORDER BY id').all()).toEqual([
      { site_id: site.id, directive: 'camera', status: 'approved' },
      { site_id: site.id, directive: 'geolocation', status: 'new' },
      { site_id: other.id, directive: 'camera', status: 'new' },
    ]);
    expect(await (await get('/lists')).text()).toContain('<td class="mono">permissions-policy-violation:camera</td>');
    // global scope reaches the other site too
    expect((await post(`/sites/${site.id}/origins/${originId}/approve`, { scope: 'global' })).status).toBe(303);
    expect(db.prepare("SELECT COUNT(*) n FROM origins WHERE status = 'approved'").get()).toEqual({ n: 2 });
    expect(db.prepare('SELECT COUNT(*) n FROM approvals WHERE site_id IS NULL').get()).toEqual({ n: 1 });
    // approvals of non-CSP keys never reach the suggested CSP header
    const page = await (await get(`/sites/${site.id}`)).text();
    expect(page).toContain(escapeHtml(suggestedHeaders(deps.config.baseUrl, site.key, [])));
  });

  it('suspect on a non-CSP row marks only that row', async () => {
    const { db, site, post } = seeded();
    const { originId } = rec(db, site, 'connection-allowlist', 'fetch', 'https://exfil.example');
    rec(db, site, 'connection-allowlist', 'beacon', 'https://exfil.example');
    rec(db, site, 'csp-violation', 'connect-src', 'https://exfil.example');
    const res = await post(`/sites/${site.id}/origins/${originId}/suspect`, { back: `/sites/${site.id}/types/connection-allowlist` });
    expect(res.status).toBe(303);
    expect(db.prepare('SELECT directive, status FROM origins ORDER BY id').all()).toEqual([
      { directive: 'fetch', status: 'suspect' }, { directive: 'beacon', status: 'new' }, { directive: 'connect-src', status: 'new' },
    ]);
  });

  it('refuses approve/suspect on types that never alert on approvals', async () => {
    const { db, site, post } = seeded();
    const { originId } = rec(db, site, 'network-error', 'dns.name_not_resolved', 'www.example.it');
    expect((await post(`/sites/${site.id}/origins/${originId}/approve`, { scope: 'site' })).status).toBe(400);
    expect((await post(`/sites/${site.id}/origins/${originId}/suspect`)).status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) n FROM approvals').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT status FROM origins').get()).toEqual({ status: 'new' });
  });

  it('type page shows approve and suspect only on reviewable types', async () => {
    const { db, site, get } = seeded();
    const { originId: p } = rec(db, site, 'permissions-policy-violation', 'camera', 'https://maps.example');
    const { originId: n } = rec(db, site, 'network-error', 'dns.name_not_resolved', 'www.example.it');
    expect(await (await get(`/sites/${site.id}/types/permissions-policy`)).text()).toContain(`/origins/${p}/approve`);
    expect(await (await get(`/sites/${site.id}/types/network-error`)).text()).not.toContain(`/origins/${n}/approve`);
  });

  it('volatile flags a csp-hash row and redirects back', async () => {
    const { db, site, post } = seeded();
    const { originId } = rec(db, site, 'csp-hash', 'script', 'https://www.example.it/app.js', { detail: { currentHash: 'h1', pages: ['/'] } });
    const back = `/sites/${site.id}/types/csp-hash`;
    let res = await post(`/sites/${site.id}/origins/${originId}/volatile`, { value: '1', back });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(back);
    const detail = () => JSON.parse((db.prepare('SELECT detail FROM origins WHERE id = ?').get(originId) as { detail: string }).detail);
    expect(detail()).toEqual({ currentHash: 'h1', pages: ['/'], volatile: true });
    res = await post(`/sites/${site.id}/origins/${originId}/volatile`, { value: '0', back: '//evil.example' });
    expect(res.headers.get('location')).toBe(back);
    expect(detail().volatile).toBe(false);
  });

  it('volatile is 404 for another site or a non-csp-hash row', async () => {
    const { db, site, post } = seeded();
    const other = getSite(db, createSite(db, { name: 'B', domains: ['b.it'] }, NOW - 30 * DAY).id)!;
    const { originId: foreign } = rec(db, other, 'csp-hash', 'script', 'https://b.it/app.js', { detail: { currentHash: 'h' } });
    const { originId: crash } = rec(db, site, 'crash', 'oom', '/p', { detail: { currentHash: 'h' } });
    expect((await post(`/sites/${site.id}/origins/${foreign}/volatile`, { value: '1' })).status).toBe(404);
    expect((await post(`/sites/${site.id}/origins/${crash}/volatile`, { value: '1' })).status).toBe(404);
    expect(db.prepare("SELECT COUNT(*) n FROM origins WHERE detail LIKE '%volatile%'").get()).toEqual({ n: 0 });
  });

  it('release starts a one-hour window and the page shows it', async () => {
    const { db, site, post, get } = seeded();
    const back = `/sites/${site.id}/types/csp-hash`;
    const res = await post(`/sites/${site.id}/release`, { back });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(back);
    expect(getSetting(db, `release_until:${site.id}`)).toBe(String(NOW + 3_600_000));
    expect(await (await get(back)).text()).toContain('Rilascio in corso');
    expect((await post('/sites/999/release')).status).toBe(404);
  });
});
