import { describe, expect, it } from 'vitest';
import { addApprovalPattern, recordGeneric, type SampleInput } from '../../src/store/origins.js';
import { createSite, endLearning, getSite, setEnabledHeaders } from '../../src/store/sites.js';
import { typeTiles } from '../../src/web/queries.js';
import { NOW } from '../helpers.js';
import { DAY, dash } from './dash.js';

function seeded() {
  const d = dash();
  const created = createSite(d.db, { name: 'Sito A', domains: ['www.example.it'] }, NOW - 30 * DAY);
  endLearning(d.db, created.id, NOW - 20 * DAY);
  return { ...d, site: getSite(d.db, created.id)! };
}

const sample: SampleInput = { sourceFile: '', sample: '', line: null, ua: 'Chrome 157', disposition: 'report', body: '{}' };
const rec = (d: ReturnType<typeof seeded>, type: string, at = NOW - 1000) =>
  recordGeneric(d.db, d.site, type, 'a', 'https://x.example', 'external', '/p', sample, at);

describe('site summary tiles', () => {
  it('shows 12 tiles in 3 labelled groups', async () => {
    const { site, get } = seeded();
    const html = await (await get(`/sites/${site.id}`)).text();
    expect(html).toContain('Tipi di report');
    for (const l of ['Segnali di attacco', 'Guasti del browser', 'Igiene delle policy']) expect(html).toContain(l);
    expect(html.match(/<a class="tile[ "]/g)).toHaveLength(12);
    expect(html).toContain(`href="/sites/${site.id}/types/coop"`);
    expect(html).toContain(`href="/sites/${site.id}/csp"`);
  });

  it('marks a type with no header and no reports as non attivo', () => {
    const d = seeded();
    const t = typeTiles(d.db, d.site, NOW);
    expect(t).toHaveLength(12);
    expect(t.find(x => x.def.slug === 'coop')).toMatchObject({ state: 'inactive', count: 0 });
    expect(t.find(x => x.def.slug === 'crash')).toMatchObject({ state: 'none' });
    expect(t.find(x => x.def.slug === 'csp-violation')).toMatchObject({ state: 'none' });
  });

  it('is not inactive when there are reports, and counts only the last 7 days', () => {
    const d = seeded();
    rec(d, 'coop');
    rec(d, 'coop', NOW - 10 * DAY);
    const coop = typeTiles(d.db, d.site, NOW).find(x => x.def.slug === 'coop')!;
    expect(coop.count).toBe(1);
    expect(coop.state).toBe('new');
  });

  it('shows attivo / nuove / nessun report', async () => {
    const d = seeded();
    setEnabledHeaders(d.db, d.site.id, ['coep']);
    expect(typeTiles(d.db, getSite(d.db, d.site.id)!, NOW).find(x => x.def.slug === 'coep')!.state).toBe('none');
    rec(d, 'coep');
    d.db.prepare("UPDATE origins SET status = 'approved' WHERE report_type = 'coep'").run();
    expect(typeTiles(d.db, getSite(d.db, d.site.id)!, NOW).find(x => x.def.slug === 'coep')!.state).toBe('active');
    rec(d, 'network-error');
    const html = await (await d.get(`/sites/${d.site.id}`)).text();
    expect(html).toContain('1 nuova');
    expect(html).toContain('non attivo');
    expect(html).toContain('attivo');
  });
});

describe('header settings', () => {
  it('saves sensitive paths and enabled features', async () => {
    const { db, site, post, get } = seeded();
    const ok = { name: 'Sito A', domains: 'www.example.it', rate_per_min: '60', rate_per_day: '5000' };
    const form = await (await get(`/sites/${site.id}/settings`)).text();
    expect(form).toContain('Header da attivare');
    expect(form).toContain('Pagine sensibili');
    const res = await post(`/sites/${site.id}/settings`, {
      ...ok, sensitive_paths: '/checkout\n\n /login \n/checkout\n', features: ['csp', 'nel', 'bogus', 'coop'],
    });
    expect(res.status).toBe(303);
    const saved = getSite(db, site.id)!;
    expect(saved.sensitivePaths).toEqual(['/checkout', '/login']);
    expect(saved.enabledHeaders).toEqual(['csp', 'nel', 'coop']);
    const again = await (await get(`/sites/${site.id}/settings`)).text();
    expect(again).toContain('/checkout\n/login');
  });

  it('rejects invalid paths with 400 and keeps the form values', async () => {
    const { db, site, post } = seeded();
    const ok = { name: 'Sito A', domains: 'www.example.it', rate_per_min: '60', rate_per_day: '5000' };
    for (const paths of ['checkout', '/a\nhttps://x', `/${'a'.repeat(200)}`, Array.from({ length: 51 }, (_, i) => `/p${i}`).join('\n')]) {
      const res = await post(`/sites/${site.id}/settings`, { ...ok, sensitive_paths: paths, features: ['nel'] });
      expect(res.status, paths.slice(0, 20)).toBe(400);
      expect(await res.text()).toContain('role="alert"');
    }
    expect(getSite(db, site.id)!.enabledHeaders).toEqual(['csp']);
  });
});

describe('site page header set', () => {
  it('lists the headers of the enabled features, with notes', async () => {
    const { db, site, get } = seeded();
    setEnabledHeaders(db, site.id, ['nel']);
    const html = await (await get(`/sites/${site.id}`)).text();
    expect(html).toContain('Header per le funzioni attive');
    expect(html).toContain('Reporting-Endpoints:');
    expect(html).toContain('NEL:');
    expect(html).not.toContain('Cross-Origin-Opener-Policy-Report-Only');
    expect(html).toContain('id="suggested-header"');
  });

  it('shows a hint to the settings when only csp is enabled', async () => {
    const { site, get } = seeded();
    const html = await (await get(`/sites/${site.id}`)).text();
    expect(html).not.toContain('Header per le funzioni attive');
    expect(html).toContain(`href="/sites/${site.id}/settings"`);
    expect(html).toContain('Attiva altri header');
  });
});

describe('site page CSP header with other features', () => {
  const block = (html: string, id: string): string => {
    const m = html.match(new RegExp(`<pre class="mono block" id="${id}">([\\s\\S]*?)</pre>`));
    return (m?.[1] ?? '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  };

  it('csp-hash + approved script origin: one Reporting-Endpoints (csp and default), approved origin and report-sha256', async () => {
    const { db, site, get } = seeded();
    setEnabledHeaders(db, site.id, ['csp-hash', 'nel']);
    addApprovalPattern(db, site.id, 'https://cdn.example', ['script-src'], NOW - DAY);
    const html = await (await get(`/sites/${site.id}`)).text();
    const suggested = block(html, 'suggested-header');
    const extra = block(html, 'extra-headers');
    const strict = block(html, 'strict-header');
    const ep = `https://m.example.it/r/${site.key}`;
    // the suggested header and the extra block are pasted together: a single Reporting-Endpoints line
    expect(`${suggested}\n${extra}`.split('\n').filter(l => l.startsWith('Reporting-Endpoints:'))).toEqual([
      `Reporting-Endpoints: csp="${ep}", default="${ep}"`,
    ]);
    expect(suggested).toContain("script-src 'self' https://cdn.example 'report-sha256';");
    expect(strict).toContain("script-src 'self' 'report-sha256';");
    expect(strict).toContain(`Reporting-Endpoints: csp="${ep}", default="${ep}"`);
    expect(extra).toContain('NEL:');
    expect(extra).not.toContain('Content-Security-Policy');
  });
});
