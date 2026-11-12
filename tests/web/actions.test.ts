import { describe, expect, it, vi } from 'vitest';
import type { AlertChannel, AlertMessage } from '../../src/alerts/channels.js';
import { recordCspEvent } from '../../src/store/origins.js';
import { getSetting } from '../../src/store/settings.js';
import { createSite, endLearning, getSite } from '../../src/store/sites.js';
import { NOW } from '../helpers.js';
import { DAY, dash, ev } from './dash.js';

function seeded(overrides: Parameters<typeof dash>[0] = {}) {
  const d = dash(overrides);
  const created = createSite(d.db, { name: 'Sito A', domains: ['www.example.it'] }, NOW - 30 * DAY);
  endLearning(d.db, created.id, NOW - 20 * DAY);
  return { ...d, site: getSite(d.db, created.id)! };
}
type OriginRow = { site_id: number; directive: string; status: string };
type ApprovalRow = { site_id: number | null; pattern: string; directive: string };

describe('dashboard actions', () => {
  it('approve marks the row approved and creates approvals for seen directives', async () => {
    const { db, site, post } = seeded();
    const { originId } = recordCspEvent(db, site, ev({ directive: 'script-src' }), NOW - 1000);
    recordCspEvent(db, site, ev({ directive: 'connect-src' }), NOW - 1000);
    const res = await post(`/sites/${site.id}/origins/${originId}/approve`, { scope: 'site' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/sites/${site.id}`);
    const rows = db.prepare('SELECT site_id, directive, status FROM origins ORDER BY directive').all() as OriginRow[];
    expect(rows.map(r => r.status)).toEqual(['approved', 'approved']);
    const approvals = db.prepare('SELECT site_id, pattern, directive FROM approvals ORDER BY directive').all() as ApprovalRow[];
    expect(approvals).toEqual([
      { site_id: site.id, pattern: 'https://evil.example', directive: 'connect-src' },
      { site_id: site.id, pattern: 'https://evil.example', directive: 'script-src' },
    ]);
  });

  it('approve for all creates a global approval', async () => {
    const { db, site, post } = seeded();
    const other = getSite(db, createSite(db, { name: 'B', domains: ['b.it'] }, NOW - 30 * DAY).id)!;
    const { originId } = recordCspEvent(db, site, ev(), NOW - 1000);
    recordCspEvent(db, other, ev(), NOW - 1000);
    expect((await post(`/sites/${site.id}/origins/${originId}/approve`, { scope: 'global' })).status).toBe(303);
    expect(db.prepare('SELECT site_id, pattern, directive FROM approvals').all()).toEqual([
      { site_id: null, pattern: 'https://evil.example', directive: 'script-src' },
    ]);
    const statuses = db.prepare('SELECT site_id, status FROM origins ORDER BY site_id').all();
    expect(statuses).toEqual([{ site_id: site.id, status: 'approved' }, { site_id: other.id, status: 'approved' }]);
    // and a third site gets it pre-approved
    const third = getSite(db, createSite(db, { name: 'C', domains: ['c.it'] }, NOW).id)!;
    expect(recordCspEvent(db, third, ev(), NOW).status).toBe('approved');
  });

  it('approve for all from a second site', async () => {
    const { db, site, post } = seeded();
    const other = getSite(db, createSite(db, { name: 'B', domains: ['b.it'] }, NOW - 30 * DAY).id)!;
    recordCspEvent(db, site, ev(), NOW - 1000);
    const { originId } = recordCspEvent(db, other, ev(), NOW - 1000);
    // the origin id must belong to the site in the path
    expect((await post(`/sites/${site.id}/origins/${originId}/approve`, { scope: 'global' })).status).toBe(404);
    expect((await post(`/sites/${other.id}/origins/${originId}/approve`, { scope: 'global' })).status).toBe(303);
    expect(db.prepare("SELECT COUNT(*) n FROM origins WHERE status = 'approved'").get()).toEqual({ n: 2 });
  });

  it('suspect marks every row of the origin on the site', async () => {
    const { db, site, post } = seeded();
    const { originId } = recordCspEvent(db, site, ev({ directive: 'script-src' }), NOW - 1000);
    recordCspEvent(db, site, ev({ directive: 'img-src' }), NOW - 1000);
    const res = await post(`/sites/${site.id}/origins/${originId}/suspect`, { back: `/sites/${site.id}/origins/${originId}` });
    expect(res.headers.get('location')).toBe(`/sites/${site.id}/origins/${originId}`);
    expect(db.prepare("SELECT COUNT(*) n FROM origins WHERE status = 'suspect'").get()).toEqual({ n: 2 });
  });

  it('rejects back values that leave the site', async () => {
    const { db, site, post } = seeded();
    const { originId } = recordCspEvent(db, site, ev(), NOW - 1000);
    for (const back of ['//evil.example/x', 'https://evil.example/', '/\\evil.example', 'javascript:alert(1)', 'sites/1', '/\t/evil.example']) {
      const res = await post(`/sites/${site.id}/origins/${originId}/suspect`, { back });
      expect(res.status, back).toBe(303);
      expect(res.headers.get('location'), back).toBe(`/sites/${site.id}`);
    }
  });

  it('refuses to approve origins that are not valid CSP sources', async () => {
    const { db, site, post } = seeded();
    const { originId: inline } = recordCspEvent(db, site, ev({ origin: 'inline', category: 'inline' }), NOW);
    const { originId: junk } = recordCspEvent(db, site, ev({ origin: "x; script-src 'unsafe-inline'" }), NOW);
    for (const id of [inline, junk]) {
      expect((await post(`/sites/${site.id}/origins/${id}/approve`, { scope: 'site' })).status).toBe(400);
    }
    expect(db.prepare('SELECT COUNT(*) n FROM approvals').get()).toEqual({ n: 0 });
  });

  it('end-learning closes the learning period', async () => {
    const { db, get, post } = dash();
    const site = createSite(db, { name: 'N', domains: ['n.it'] }, NOW - DAY);
    expect(await (await get('/')).text()).toContain('apprendimento · 6 gg');
    const res = await post(`/sites/${site.id}/end-learning`);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/sites/${site.id}`);
    expect(getSite(db, site.id)!.learningUntil).toBe(NOW);
    expect(await (await get(`/sites/${site.id}`)).text()).not.toContain('Chiudi apprendimento');
  });

  it('risky wildcard shows a warning', async () => {
    const { db, post, get } = seeded();
    const res = await post('/lists/approvals', { pattern: '*.cloudfront.net', directive: ['script-src'], scope: 'global' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/lists');
    expect(db.prepare('SELECT site_id, pattern, directive FROM approvals').all()).toEqual([
      { site_id: null, pattern: '*.cloudfront.net', directive: 'script-src' },
    ]);
    const html = await (await get('/lists')).text();
    expect(html).toContain('Jolly rischioso');
    expect(html).toContain('*.cloudfront.net');
  });

  it('adds site-scoped approval patterns that approve matching rows', async () => {
    const { db, site, post } = seeded();
    recordCspEvent(db, site, ev({ origin: 'https://a.hotjar.com' }), NOW);
    const res = await post('/lists/approvals', { pattern: 'HTTPS://*.Hotjar.com', directive: ['script-src', 'connect-src'], scope: String(site.id) });
    expect(res.status).toBe(303);
    expect(db.prepare('SELECT site_id, pattern, directive FROM approvals ORDER BY directive').all()).toEqual([
      { site_id: site.id, pattern: 'https://*.hotjar.com', directive: 'connect-src' },
      { site_id: site.id, pattern: 'https://*.hotjar.com', directive: 'script-src' },
    ]);
    expect(db.prepare('SELECT status FROM origins').get()).toEqual({ status: 'approved' });
  });

  it('rejects invalid approval patterns with 400', async () => {
    const { db, post } = seeded();
    const bad = [
      '', 'https://cdn.example.com/path', 'https://user@cdn.example.com', 'cdn .example.com', 'javascript:alert(1)',
      '*', '*.com', 'https://*.example.com/a', 'cdn.example.com', 'ftp://cdn.example.com', "https://x.com; script-src *",
      '*.example.com:443', 'https://exa*mple.com', 'https://cdn.example.com:99999',
    ];
    for (const pattern of bad) {
      const res = await post('/lists/approvals', { pattern, directive: ['script-src'], scope: 'global' });
      expect(res.status, pattern).toBe(400);
      expect(await res.text(), pattern).toContain('Pattern non valido');
    }
    const badDirective = await post('/lists/approvals', { pattern: 'https://ok.example', directive: ['form-action'], scope: 'global' });
    expect(badDirective.status).toBe(400);
    const noDirective = await post('/lists/approvals', { pattern: 'https://ok.example', scope: 'global' });
    expect(noDirective.status).toBe(400);
    const badScope = await post('/lists/approvals', { pattern: 'https://ok.example', directive: ['img-src'], scope: '999' });
    expect(badScope.status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) n FROM approvals').get()).toEqual({ n: 0 });
    for (const pattern of ['https://cdn.example.com', 'https://cdn.example.com:8443', 'wss://*.example.com', '*.example.com']) {
      expect((await post('/lists/approvals', { pattern, directive: ['img-src'], scope: 'global' })).status, pattern).toBe(303);
    }
  });

  it('deletes approvals and manages noise patterns', async () => {
    const { db, post, get } = seeded();
    await post('/lists/approvals', { pattern: 'https://cdn.example.com', directive: ['img-src'], scope: 'global' });
    const { id } = db.prepare('SELECT id FROM approvals').get() as { id: number };
    expect((await post(`/lists/approvals/${id}/delete`)).status).toBe(303);
    expect(db.prepare('SELECT COUNT(*) n FROM approvals').get()).toEqual({ n: 0 });

    expect((await post('/lists/noise', { pattern: 'https://user@x.com' })).status).toBe(400);
    expect((await post('/lists/noise', { pattern: '*.toolbar.example' })).status).toBe(303);
    expect(await (await get('/lists')).text()).toContain('*.toolbar.example');
    const noise = db.prepare('SELECT id, pattern FROM noise_patterns').get() as { id: number; pattern: string };
    expect(noise.pattern).toBe('*.toolbar.example');
    expect((await post(`/lists/noise/${noise.id}/delete`)).status).toBe(303);
    expect(db.prepare('SELECT COUNT(*) n FROM noise_patterns').get()).toEqual({ n: 0 });
  });

  it('validates the new site form', async () => {
    const { db, post } = dash();
    const cases: [Record<string, string>, string][] = [
      [{ name: '  ', domains: 'a.it' }, 'Il nome è obbligatorio'],
      [{ name: 'A', domains: '\n \n' }, 'Indica almeno un dominio'],
      [{ name: 'A', domains: 'https://a.it' }, 'Dominio non valido'],
      [{ name: 'A', domains: 'a.it/path' }, 'Dominio non valido'],
      [{ name: 'A', domains: 'a.it\n*.' }, 'Dominio non valido'],
    ];
    for (const [fields, msg] of cases) {
      const res = await post('/sites', fields);
      expect(res.status, JSON.stringify(fields)).toBe(400);
      expect(await res.text()).toContain(msg);
    }
    expect(db.prepare('SELECT COUNT(*) n FROM sites').get()).toEqual({ n: 0 });
  });

  it('validates and saves site settings', async () => {
    const { db, site, post } = seeded();
    const ok = { name: 'Nuovo nome', domains: 'www.example.it\n*.Example.it', rate_per_min: '60', rate_per_day: '5000' };
    for (const [k, v, msg] of [
      ['rate_per_min', '0', 'numero intero positivo'], ['rate_per_day', 'abc', 'numero intero positivo'],
      ['rate_per_min', '1.5', 'numero intero positivo'], ['name', '', 'Il nome è obbligatorio'], ['domains', 'http://x', 'Dominio non valido'],
    ] as const) {
      const res = await post(`/sites/${site.id}/settings`, { ...ok, [k]: v });
      expect(res.status, `${k}=${v}`).toBe(400);
      expect(await res.text()).toContain(msg);
    }
    expect(getSite(db, site.id)!.name).toBe('Sito A');
    const res = await post(`/sites/${site.id}/settings`, ok);
    expect(res.status).toBe(303);
    const saved = getSite(db, site.id)!;
    expect(saved).toMatchObject({ name: 'Nuovo nome', domains: ['www.example.it', '*.example.it'], ratePerMin: 60, ratePerDay: 5000 });
  });

  it('validates and saves the alert email', async () => {
    const { db, post, get } = dash();
    expect(await (await get('/settings/alerts')).text()).toContain('admin@example.it');
    const bad = await post('/settings/alerts', { email: 'not-an-email' });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('Indirizzo email non valido');
    const res = await post('/settings/alerts', { email: 'andrea@example.it' });
    expect(res.status).toBe(303);
    expect(getSetting(db, 'alert_email')).toBe('andrea@example.it');
    expect(await (await get('/settings/alerts')).text()).toContain('andrea@example.it');
  });

  it('sends a test message on every channel and reports failures generically', async () => {
    const sent: AlertMessage[] = [];
    const good: AlertChannel = { name: 'email', send: async (m) => { sent.push(m); } };
    const { post } = dash({ channels: [good] });
    const ok = await post('/settings/alerts/test');
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('Messaggio di prova inviato');
    expect(sent).toHaveLength(1);

    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad: AlertChannel = { name: 'email', send: async () => { throw new Error('535 auth failed for secret-user'); } };
    const failing = dash({ channels: [bad] });
    const res = await failing.post('/settings/alerts/test');
    expect(res.status).toBe(502);
    const html = await res.text();
    expect(html).toContain('Invio non riuscito');
    expect(html).not.toContain('secret-user');
    expect(JSON.stringify(err.mock.calls)).not.toContain('secret-user');
    err.mockRestore();
  });
});
