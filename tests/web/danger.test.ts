import { describe, expect, it } from 'vitest';
import { recordCspEvent, recordNoise } from '../../src/store/origins.js';
import { createSite, endLearning, getSite } from '../../src/store/sites.js';
import { NOW } from '../helpers.js';
import { DAY, dash, ev } from './dash.js';

function seeded() {
  const d = dash();
  const a = createSite(d.db, { name: 'Sito A', domains: ['www.example.it'] }, NOW - 30 * DAY);
  const b = createSite(d.db, { name: 'Sito B', domains: ['b.example.it'] }, NOW - 30 * DAY);
  for (const s of [a, b]) {
    endLearning(d.db, s.id, NOW - 20 * DAY);
    const site = getSite(d.db, s.id)!;
    const { originId } = recordCspEvent(d.db, site, ev({ directive: 'script-src' }), NOW - 1000);
    recordNoise(d.db, site.id, 'bot', NOW - 1000);
    d.db.prepare('INSERT INTO pending_alerts (site_id, origin_id, kind, created_at) VALUES (?, ?, ?, ?)')
      .run(site.id, originId, 'new-origin', NOW - 1000);
    d.db.prepare('INSERT INTO approvals (site_id, pattern, directive, created_at) VALUES (?, ?, ?, ?)')
      .run(site.id, 'https://ok.example', 'img-src', NOW - 1000);
    d.db.prepare("INSERT INTO discarded (site_id, received_at, reason, body) VALUES (?, ?, 'bot', '{}')").run(site.id, NOW - 1000);
    d.db.prepare("INSERT INTO window_counts (site_id, report_type, k, bucket, count) VALUES (?, 'network-error', 'k', 1, 1)").run(site.id);
    d.db.prepare("INSERT INTO reminders (site_id, kind, ref, due_at) VALUES (?, 'deprecation-reminder', 'r', ?)").run(site.id, NOW);
    d.deps.known.add(site.id, 'csp-violation', 'script-src', 'https://evil.example');
  }
  return { ...d, a: getSite(d.db, a.id)!, b: getSite(d.db, b.id)! };
}

const TABLES = ['origins', 'samples', 'daily_counts', 'noise_counts', 'pending_alerts', 'discarded', 'window_counts', 'reminders', 'approvals'] as const;
function counts(db: ReturnType<typeof dash>['db'], siteId: number) {
  const out: Record<string, number> = {};
  for (const t of TABLES) {
    out[t] = (db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE site_id = ?`).get(siteId) as { n: number }).n;
  }
  return out;
}

describe('danger zone', () => {
  it('settings page shows the danger zone', async () => {
    const { a, get } = seeded();
    const html = await (await get(`/sites/${a.id}/settings`)).text();
    expect(html).toContain('Zona pericolosa');
    expect(html).toContain('Cancella tutti i dati');
    expect(html).toContain('Rimuovi il sito');
  });

  it('clear-data removes the site data but keeps the site, its key and approvals', async () => {
    const { db, deps, a, b, post } = seeded();
    const res = await post(`/sites/${a.id}/clear-data`, { confirm: 'Sito A' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/sites/${a.id}`);
    expect(counts(db, a.id)).toEqual({ origins: 0, samples: 0, daily_counts: 0, noise_counts: 0, pending_alerts: 0, discarded: 0, window_counts: 0, reminders: 0, approvals: 1 });
    const after = getSite(db, a.id)!;
    expect(after.key).toBe(a.key);
    expect(after.lastReportAt).toBeNull();
    expect(deps.known.has(a.id, 'csp-violation', 'script-src', 'https://evil.example')).toBe(false);
    // the other site is untouched
    expect(counts(db, b.id)).toEqual({ origins: 1, samples: 1, daily_counts: 1, noise_counts: 1, pending_alerts: 1, discarded: 1, window_counts: 1, reminders: 1, approvals: 1 });
    expect(deps.known.has(b.id, 'csp-violation', 'script-src', 'https://evil.example')).toBe(true);
  });

  it('delete removes the site and every row that belongs to it', async () => {
    const { db, deps, a, b, post } = seeded();
    const res = await post(`/sites/${a.id}/delete`, { confirm: 'Sito A' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
    expect(getSite(db, a.id)).toBeNull();
    expect(counts(db, a.id)).toEqual({ origins: 0, samples: 0, daily_counts: 0, noise_counts: 0, pending_alerts: 0, discarded: 0, window_counts: 0, reminders: 0, approvals: 0 });
    expect(deps.known.has(a.id, 'csp-violation', 'script-src', 'https://evil.example')).toBe(false);
    expect(getSite(db, b.id)).not.toBeNull();
    expect(counts(db, b.id).origins).toBe(1);
  });

  it('refuses both actions without the exact site name', async () => {
    const { db, a, post } = seeded();
    for (const action of ['clear-data', 'delete']) {
      for (const confirm of ['', 'sito a', 'Sito B', ' Sito A ']) {
        expect((await post(`/sites/${a.id}/${action}`, { confirm })).status).toBe(400);
      }
    }
    expect(getSite(db, a.id)).not.toBeNull();
    expect(counts(db, a.id).origins).toBe(1);
  });

  it('returns 404 for an unknown site', async () => {
    const { post } = seeded();
    expect((await post('/sites/999/delete', { confirm: 'x' })).status).toBe(404);
  });
});
