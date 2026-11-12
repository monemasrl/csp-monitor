import { describe, expect, it } from 'vitest';
import { escapeHtml } from '../../src/alerts/render.js';
import { strictHeaders } from '../../src/headers.js';
import { addApprovalPattern, approveOrigin, recordCspEvent, recordGeneric, recordNoise } from '../../src/store/origins.js';
import { createSite, endLearning, getSite, touchSite } from '../../src/store/sites.js';
import { cspViolations } from '../../src/web/queries.js';
import { NOW } from '../helpers.js';
import { DAY, dash, ev } from './dash.js';

function seeded() {
  const d = dash();
  const created = createSite(d.db, { name: 'Sito A', domains: ['www.example.it'] }, NOW - 30 * DAY);
  endLearning(d.db, created.id, NOW - 20 * DAY);
  touchSite(d.db, created.id, NOW - 60_000);
  const site = getSite(d.db, created.id)!;
  return { ...d, site };
}

describe('dashboard pages', () => {
  it('escapes report data on every page', async () => {
    const { db, site, get } = seeded();
    const hostile = { sample: '<img src=x onerror=alert(1)>', page: '/"><script>x</script>' };
    const raw = { documentURL: 'https://www.example.it/"><script>x</script>', sample: '<img src=x onerror=alert(1)>' };
    const { originId: oid } = recordCspEvent(db, site, ev(hostile), NOW - 1000, raw);
    // a non-URL "origin" taken verbatim from the report, and an inline violation with the sample
    recordCspEvent(db, site, ev({ ...hostile, origin: '"><script>x</script>', blockedRaw: '"><script>x</script>' }), NOW - 1000);
    recordCspEvent(db, site, ev({ ...hostile, origin: 'inline', category: 'inline', directive: 'script-src' }), NOW - 1000);
    const pages = ['/', `/sites/${site.id}`, `/sites/${site.id}/csp`, `/sites/${site.id}/csp?noise=1`, `/sites/${site.id}/origins/${oid}`];
    for (const path of pages) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      const html = await res.text();
      expect(html, path).not.toContain('<img src=x');
      expect(html, path).not.toContain('<script>x');
      expect(html, path).toContain('&lt;script&gt;x');
    }
    const origin = await (await get(`/sites/${site.id}/origins/${oid}`)).text();
    expect(origin).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('overview flags silent and over-limit sites', async () => {
    const { db, get } = dash();
    const silent = createSite(db, { name: 'Muto', domains: ['muto.it'] }, NOW - 10 * DAY);
    touchSite(db, silent.id, NOW - 4 * DAY);
    const never = createSite(db, { name: 'Mai visto', domains: ['mai.it'] }, NOW - 2 * DAY);
    const busy = createSite(db, { name: 'Pieno', domains: ['pieno.it'] }, NOW - 10 * DAY);
    touchSite(db, busy.id, NOW - 1000);
    for (let i = 0; i < 37; i++) recordNoise(db, busy.id, 'rate-limit', NOW);
    const fresh = createSite(db, { name: 'Nuovo', domains: ['nuovo.it'] }, NOW - 3600_000);
    const html = await (await get('/')).text();
    // cards come after the sidebar, which lists the same names: take the last occurrence
    const card = (name: string) => html.slice(html.lastIndexOf(`>${name}<`), html.lastIndexOf(`>${name}<`) + 600);
    expect(card('Muto')).toContain('silenzioso');
    expect(card('Mai visto')).toContain('silenzioso');
    expect(card('Pieno')).toContain('oltre il tetto');
    expect(card('Pieno')).toContain('37 scartati');
    expect(card('Nuovo')).toContain('apprendimento · 7 gg');
    expect(card('Nuovo')).not.toContain('silenzioso');
    expect(html).toMatch(/Siti silenziosi<\/p><p class="big[^"]*">2</);
    void never; void fresh;
  });

  it('overview counts origins to review and reports of the last 24 hours', async () => {
    const { db, site, get } = seeded();
    recordCspEvent(db, site, ev({ origin: 'https://a.example' }), NOW - 1000);
    recordCspEvent(db, site, ev({ origin: 'https://a.example' }), NOW - 2 * DAY);
    recordCspEvent(db, site, ev({ origin: 'https://b.example', directive: 'img-src' }), NOW - 1000);
    recordCspEvent(db, site, ev({ origin: 'inline', category: 'inline' }), NOW - 1000);
    const html = await (await get('/')).text();
    expect(html).toMatch(/Da rivedere<\/p><p class="big[^"]*">2</);
    expect(html).toMatch(/Report ultime 24h<\/p><p class="big[^"]*">3</);
    expect(html).toContain('https://a.example');
    expect(html).toContain(`/sites/${site.id}/origins/`);
  });

  it('a non-CSP row in origins never shows in the CSP views or cascades', async () => {
    const { db, site, get } = seeded();
    recordCspEvent(db, site, ev({ origin: 'https://a.example' }), NOW - 1000);
    recordGeneric(db, site, 'network-error', 'dns.name_not_resolved', 'https://other.example', 'external', '/p',
      { sourceFile: '', sample: '', line: null, ua: 'Chrome 131', disposition: '', body: '{}' }, NOW - 1000, { x: 1 });
    expect(db.prepare('SELECT detail FROM origins WHERE report_type = ?').get('network-error')).toEqual({ detail: '{"x":1}' });
    const csp = await (await get(`/sites/${site.id}/csp`)).text();
    expect(csp).toContain('https://a.example');
    expect(csp).not.toContain('https://other.example');
    expect(csp).not.toContain('dns.name_not_resolved');
    const overview = await (await get('/')).text();
    expect(overview).not.toContain('https://other.example');
    expect(overview).toMatch(/Da rivedere<\/p><p class="big[^"]*">1</);
    approveOrigin(db, site.id, 'https://other.example', 'site', NOW);
    expect(db.prepare('SELECT COUNT(*) n FROM approvals').get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT status FROM origins WHERE report_type = 'network-error'").get()).toEqual({ status: 'new' });
  });

  it('creating a site shows the strict header with its key', async () => {
    const { db, deps, get, post } = dash();
    const res = await post('/sites', { name: 'Gida', domains: 'gida-spa.it\n*.gida-spa.it\n' });
    expect(res.status).toBe(303);
    const site = db.prepare('SELECT id, key, domains FROM sites').get() as { id: number; key: string; domains: string };
    expect(res.headers.get('location')).toBe(`/sites/${site.id}`);
    expect(JSON.parse(site.domains)).toEqual(['gida-spa.it', '*.gida-spa.it']);
    const html = await (await get(`/sites/${site.id}`)).text();
    expect(html).toContain(escapeHtml(strictHeaders(deps.config.baseUrl, site.key)));
    expect(html).toContain('data-copy="strict-header"');
    expect(html).toContain('Chiudi apprendimento');
  });

  it('site page labels origins covered by a global approval as globale', async () => {
    const { db, site, get } = seeded();
    addApprovalPattern(db, null, 'https://fonts.example', ['font-src'], NOW - DAY);
    recordCspEvent(db, site, ev({ origin: 'https://fonts.example', directive: 'font-src' }), NOW - 1000);
    const html = await (await get(`/sites/${site.id}`)).text();
    expect(html).toContain('pill blu">globale');
    // suggested header includes the approval seen on this site
    expect(html).toContain('font-src &#39;self&#39; data: https://fonts.example');
  });

  it('csp page filters by directive, status and shows noise by reason', async () => {
    const { db, site, get } = seeded();
    recordCspEvent(db, site, ev({ origin: 'https://a.example', directive: 'script-src' }), NOW - 1000);
    recordCspEvent(db, site, ev({ origin: 'https://b.example', directive: 'img-src' }), NOW - 1000);
    recordNoise(db, site.id, 'extension', NOW);
    const all = await (await get(`/sites/${site.id}/csp`)).text();
    expect(all).toContain('https://a.example');
    expect(all).toContain('https://b.example');
    expect(all).toContain('Chrome');
    const img = await (await get(`/sites/${site.id}/csp?directive=img-src`)).text();
    expect(img).not.toContain('https://a.example');
    expect(img).toContain('https://b.example');
    const approved = await (await get(`/sites/${site.id}/csp?status=approved`)).text();
    expect(approved).not.toContain('https://a.example');
    expect(approved).not.toContain('Estensioni del browser');
    const noise = await (await get(`/sites/${site.id}/csp?noise=1`)).text();
    expect(noise).toContain('Estensioni del browser');
    expect(noise).toContain('pill gry">rumore');
  });

  it('origin page warns when the origin shows up on other sites in the last 24 hours', async () => {
    const { db, site, get } = seeded();
    const other = createSite(db, { name: 'Sito B', domains: ['b.it'] }, NOW - 30 * DAY);
    const { originId } = recordCspEvent(db, site, ev(), NOW - 1000, { documentURL: 'https://www.example.it/p', n: 1 });
    recordCspEvent(db, getSite(db, other.id)!, ev(), NOW - 3600_000);
    const html = await (await get(`/sites/${site.id}/origins/${originId}`)).text();
    expect(html).toContain('Compare su 2 siti nelle ultime 24 ore');
    expect(html).toContain('Sito B');
    expect(html).toContain('&quot;n&quot;: 1'); // pretty-printed raw report
    // not shown when the other sighting is older than 24 hours
    db.prepare('UPDATE origins SET last_seen = ? WHERE site_id = ?').run(NOW - 2 * DAY, other.id);
    expect(await (await get(`/sites/${site.id}/origins/${originId}`)).text()).not.toContain('Compare su');
  });

  it('answers 404 for unknown sites and origins of other sites', async () => {
    const { db, site, get } = seeded();
    const other = createSite(db, { name: 'B', domains: ['b.it'] }, NOW);
    const { originId } = recordCspEvent(db, getSite(db, other.id)!, ev(), NOW);
    expect((await get('/sites/999')).status).toBe(404);
    expect((await get(`/sites/${site.id}/origins/${originId}`)).status).toBe(404);
  });

  it('renders the remaining pages', async () => {
    const { site, get } = seeded();
    for (const path of ['/sites/new', `/sites/${site.id}/settings`, '/lists', '/settings/alerts']) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(await res.text()).toMatch(/^<!doctype html>/i);
    }
  });

  it('sends defensive headers and a CSP that allows only the copy script', async () => {
    const { get } = seeded();
    const res = await get('/');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/]+=*'/);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    const html = await res.text();
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
    const { createHash } = await import('node:crypto');
    expect(csp).toContain(`'sha256-${createHash('sha256').update(script).digest('base64')}'`);
    expect(script).toContain('navigator.clipboard.writeText');
  });

  it('serves the stylesheet as text/css without login', async () => {
    const { app } = dash();
    const res = await app.request('/static/style.css');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/css');
    expect(await res.text()).toContain('font-family');
  });
});

describe('CSP page counts only csp-violation', () => {
  it('a report of another type does not change the 30-day count, chart or browser share', () => {
    const { db, site } = seeded();
    recordCspEvent(db, site, ev({ ua: 'Chrome 131' }), NOW - 1000);
    const before = cspViolations(db, site, NOW, {});
    recordGeneric(db, site, 'coop', 'navigation-to-document', 'https://x.example', 'external', '/p',
      { sourceFile: '', sample: '', line: null, ua: 'Firefox 140', disposition: 'report', body: '{}' }, NOW - 500);
    const after = cspViolations(db, site, NOW, {});
    expect(after.totals.reports30).toBe(1);
    expect(after.series).toEqual(before.series);
    expect(after.browsers).toEqual([{ name: 'Chrome', pct: 100 }]);
  });
});
