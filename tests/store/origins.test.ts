import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/db.js';
import { createSite, type Site } from '../../src/store/sites.js';
import {
  addApprovalPattern, approveOrigin, isCovered, markSuspect, recordCspEvent, recordNoise, removeApproval,
} from '../../src/store/origins.js';
import { decideCspAlert } from '../../src/alerts/decide.js';
import type { CspEvent } from '../../src/ingest/csp.js';
import { NOW } from '../helpers.js';

const DAY = 24 * 3600 * 1000;
const T0 = NOW;
const T1 = NOW + 1000;

function ev(o: Partial<CspEvent> = {}): CspEvent {
  return {
    directive: 'script-src', origin: 'https://x.com', category: 'external', page: '/p', documentUrl: 'https://a.it/p',
    documentHost: 'a.it', blockedRaw: 'https://x.com/a.js', sourceFile: 'https://a.it/p', sample: '', line: 3,
    disposition: 'report', ua: 'Chrome 120', isBot: false, ...o,
  };
}

function setup() {
  const db = openDb(':memory:');
  const site = createSite(db, { name: 'A', domains: ['a.it'] }, T0);
  const other = createSite(db, { name: 'B', domains: ['b.it'] }, T0);
  return { db, site, other };
}
const after = (s: Site): Site => ({ ...s, learningUntil: T0 });
const decide = (site: Site, event: CspEvent, result: ReturnType<typeof recordCspEvent>, now: number, noise = null) =>
  decideCspAlert({ site, event, noise, result, now });

describe('recordCspEvent', () => {
  it('creates a new row, then updates count and last_seen', () => {
    const { db, site } = setup();
    const r1 = recordCspEvent(db, site, ev(), T0);
    expect(r1).toMatchObject({ isNewRow: true, status: 'new', previousLastSeen: null });
    const r2 = recordCspEvent(db, site, ev(), T1);
    expect(r2).toMatchObject({ originId: r1.originId, isNewRow: false, status: 'new', previousLastSeen: T0 });
    const row = db.prepare('SELECT * FROM origins WHERE id = ?').get(r1.originId) as Record<string, unknown>;
    expect(row).toMatchObject({ count: 2, first_seen: T0, last_seen: T1, first_page: '/p', category: 'external' });
  });

  it('increments daily_counts per UTC day', () => {
    const { db, site } = setup();
    recordCspEvent(db, site, ev(), T0);
    recordCspEvent(db, site, ev(), T1);
    recordCspEvent(db, site, ev(), T0 + DAY);
    const rows = db.prepare('SELECT day, count FROM daily_counts ORDER BY day').all();
    expect(rows).toEqual([{ day: '2026-11-12', count: 2 }, { day: '2026-11-13', count: 1 }]);
  });

  it('stores a sample per event without the IP', () => {
    const { db, site } = setup();
    const r = recordCspEvent(db, site, ev({ sample: 'x', line: 7 }), T0);
    const s = db.prepare('SELECT * FROM samples').get() as Record<string, unknown>;
    expect(s).toMatchObject({
      site_id: site.id, origin_id: r.originId, report_type: 'csp-violation', received_at: T0, page: '/p',
      source_file: 'https://a.it/p', script_sample: 'x', line: 7, ua: 'Chrome 120', disposition: 'report',
    });
    expect(Object.keys(s)).not.toContain('ip');
  });

  it('sanitizes the raw body: URLs lose query/fragment, non-URL strings are kept (R3)', () => {
    const { db, site } = setup();
    recordCspEvent(db, site, ev(), T0, {
      'csp-report': { 'blocked-uri': 'https://x.com/a.js?token=1#frag', 'document-uri': 'https://u:p@a.it/p?q=1', sample: 'inline', blockedURL: 'eval', n: 3 },
    });
    const body = (db.prepare('SELECT body FROM samples').get() as { body: string }).body;
    expect(body).not.toContain('?');
    expect(body).not.toContain('#');
    expect(body).not.toContain('u:p@');
    expect(JSON.parse(body)['csp-report']).toMatchObject({ 'blocked-uri': 'https://x.com/a.js', sample: 'inline', blockedURL: 'eval', n: 3 });
  });

  it('cuts query/fragment/userinfo from unparseable scheme-prefixed strings', () => {
    const { db, site } = setup();
    recordCspEvent(db, site, ev(), T0, {
      a: 'https://a b/?token=1#f', b: 'https://[::1/?q=secret', c: 'https://u:pw@exa mple.com/x?y=1', d: ['wss://h ost/p#frag'],
    });
    const body = (db.prepare('SELECT body FROM samples').get() as { body: string }).body;
    for (const bad of ['?', '#', 'token', 'secret', 'pw', 'u:pw']) expect(body).not.toContain(bad);
    expect(JSON.parse(body)).toEqual({ a: 'https://a b/', b: 'https://[::1/', c: 'https://exa mple.com/x', d: ['wss://h ost/p'] });
  });

  it('falls back to the event as body, and truncates it to 8192 chars', () => {
    const { db, site } = setup();
    recordCspEvent(db, site, ev(), T0);
    recordCspEvent(db, site, ev(), T1, { big: 'a'.repeat(20000) });
    const rows = db.prepare('SELECT body FROM samples ORDER BY id').all() as { body: string }[];
    expect(JSON.parse(rows[0]!.body)).toMatchObject({ directive: 'script-src', origin: 'https://x.com/' }); // URL-like strings pass through stripUrl
    expect(rows[1]!.body.length).toBe(8192);
  });

  it('starts approved when covered by a site or global approval', () => {
    const { db, site, other } = setup();
    addApprovalPattern(db, site.id, 'https://x.com', ['script-src'], T0);
    expect(recordCspEvent(db, site, ev(), T0).status).toBe('approved');
    expect(recordCspEvent(db, other, ev(), T0).status).toBe('new');
    addApprovalPattern(db, null, 'https://x.com', ['script-src'], T0);
    expect(recordCspEvent(db, other, ev(), T1).status).toBe('approved'); // existing row was approved by the pattern
    expect(recordCspEvent(db, other, ev({ origin: 'https://x.com', directive: 'img-src' }), T1).status).toBe('new');
    expect(isCovered(db, other.id, 'https://x.com', 'script-src')).toBe(true);
    expect(isCovered(db, other.id, 'https://x.com', 'img-src')).toBe(false);
  });

  it('starts suspect when the origin is suspect on another directive of the same site', () => {
    const { db, site, other } = setup();
    recordCspEvent(db, site, ev({ directive: 'img-src' }), T0);
    markSuspect(db, site.id, 'https://x.com');
    expect(recordCspEvent(db, site, ev({ directive: 'script-src' }), T1)).toMatchObject({ isNewRow: true, status: 'suspect' });
    expect(recordCspEvent(db, other, ev({ directive: 'script-src' }), T1).status).toBe('new');
  });

  it('approval coverage wins over suspect', () => {
    const { db, site } = setup();
    recordCspEvent(db, site, ev({ directive: 'img-src' }), T0);
    markSuspect(db, site.id, 'https://x.com');
    addApprovalPattern(db, site.id, 'https://x.com', ['script-src'], T0);
    expect(recordCspEvent(db, site, ev({ directive: 'script-src' }), T1).status).toBe('approved');
  });
});

describe('recordNoise', () => {
  it('increments noise_counts per reason and day', () => {
    const { db, site } = setup();
    recordNoise(db, site.id, 'bot', T0);
    recordNoise(db, site.id, 'bot', T1);
    recordNoise(db, site.id, 'rate-limit', T0);
    recordNoise(db, site.id, 'invalid', T0 + DAY);
    expect(db.prepare('SELECT reason, day, count FROM noise_counts ORDER BY reason, day').all()).toEqual([
      { reason: 'bot', day: '2026-11-12', count: 2 },
      { reason: 'invalid', day: '2026-11-13', count: 1 },
      { reason: 'rate-limit', day: '2026-11-12', count: 1 },
    ]);
  });
});

describe('approvals', () => {
  it('approval covers only directives seen so far', () => {
    const { db, site } = setup();
    recordCspEvent(db, site, ev({ directive: 'img-src' }), T0);
    approveOrigin(db, site.id, 'https://x.com', 'site', T0);
    const r = recordCspEvent(db, site, ev({ directive: 'script-src' }), T1);
    expect(r).toMatchObject({ isNewRow: true, status: 'new' });
    expect(decide(after(site), ev({ directive: 'script-src' }), r, T1)).toBe(true);
    expect(recordCspEvent(db, site, ev({ directive: 'img-src' }), T1).status).toBe('approved');
  });

  it('site approval does not touch other sites; duplicates are ignored', () => {
    const { db, site, other } = setup();
    recordCspEvent(db, site, ev(), T0);
    recordCspEvent(db, other, ev(), T0);
    approveOrigin(db, site.id, 'https://x.com', 'site', T0);
    approveOrigin(db, site.id, 'https://x.com', 'site', T1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM approvals').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT status FROM origins WHERE site_id = ?').get(other.id)).toEqual({ status: 'new' });
  });

  it('global approval silences every site (on the directives seen on the approving site)', () => {
    const { db, site, other } = setup();
    recordCspEvent(db, site, ev(), T0);
    recordCspEvent(db, other, ev(), T0); // existing row on B
    approveOrigin(db, site.id, 'https://x.com', 'global', T0);
    approveOrigin(db, site.id, 'https://x.com', 'global', T1);
    expect(db.prepare('SELECT site_id FROM approvals').all()).toEqual([{ site_id: null }]);
    expect(db.prepare('SELECT status FROM origins WHERE site_id = ?').get(other.id)).toEqual({ status: 'approved' });
    const third = createSite(db, { name: 'C', domains: ['c.it'] }, T0);
    const r = recordCspEvent(db, third, ev(), T1);
    expect(r.status).toBe('approved');
    expect(decide(after(third), ev(), r, T1)).toBe(false);
  });

  it('wildcard approval created by hand covers subdomains, existing and future', () => {
    const { db, site } = setup();
    const e = ev({ origin: 'https://script.hotjar.com' });
    recordCspEvent(db, site, e, T0);
    addApprovalPattern(db, site.id, 'https://*.hotjar.com', ['script-src'], T1);
    expect(db.prepare('SELECT status FROM origins').get()).toEqual({ status: 'approved' });
    const r = recordCspEvent(db, site, ev({ origin: 'https://static.hotjar.com' }), T1);
    expect(r.status).toBe('approved');
    expect(decide(after(site), e, r, T1)).toBe(false);
  });

  it('pattern with null site approves existing rows on all sites; other directives untouched', () => {
    const { db, site, other } = setup();
    recordCspEvent(db, site, ev(), T0);
    recordCspEvent(db, other, ev(), T0);
    recordCspEvent(db, other, ev({ directive: 'img-src' }), T0);
    addApprovalPattern(db, null, 'https://x.com', ['script-src'], T1);
    const rows = db.prepare('SELECT site_id, directive, status FROM origins ORDER BY id').all();
    expect(rows).toEqual([
      { site_id: site.id, directive: 'script-src', status: 'approved' },
      { site_id: other.id, directive: 'script-src', status: 'approved' },
      { site_id: other.id, directive: 'img-src', status: 'new' },
    ]);
  });

  it('markSuspect flips every row of the origin on that site, approved included', () => {
    const { db, site } = setup();
    recordCspEvent(db, site, ev({ directive: 'img-src' }), T0);
    recordCspEvent(db, site, ev({ directive: 'script-src' }), T0);
    approveOrigin(db, site.id, 'https://x.com', 'site', T0);
    recordCspEvent(db, site, ev({ directive: 'font-src' }), T1);
    markSuspect(db, site.id, 'https://x.com');
    const rows = db.prepare('SELECT directive, status FROM origins ORDER BY id').all();
    expect(rows).toEqual([
      { directive: 'img-src', status: 'suspect' },
      { directive: 'script-src', status: 'suspect' },
      { directive: 'font-src', status: 'suspect' },
    ]);
  });

  it('removeApproval deletes the approval only, statuses stay', () => {
    const { db, site } = setup();
    recordCspEvent(db, site, ev(), T0);
    approveOrigin(db, site.id, 'https://x.com', 'site', T0);
    const id = (db.prepare('SELECT id FROM approvals').get() as { id: number }).id;
    removeApproval(db, id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM approvals').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT status FROM origins').get()).toEqual({ status: 'approved' });
    expect(isCovered(db, site.id, 'https://x.com', 'script-src')).toBe(false);
  });
});

describe('decideCspAlert', () => {
  it('no alerts during learning', () => {
    const { db, site } = setup();
    const r = recordCspEvent(db, site, ev(), T0);
    expect(decide(site, ev(), r, T0)).toBe(false);
    expect(decide(after(site), ev(), r, T0)).toBe(true);
  });

  it('existing new rows do not re-alert', () => {
    const { db, site } = setup();
    recordCspEvent(db, site, ev(), T0);
    const r = recordCspEvent(db, site, ev(), T1);
    expect(decide(after(site), ev(), r, T1)).toBe(false);
  });

  it('noise, inline, eval and self never alert; data/blob/external can', () => {
    const { db, site } = setup();
    const r = recordCspEvent(db, site, ev(), T0);
    const s = after(site);
    expect(decideCspAlert({ site: s, event: ev(), noise: 'bot', result: r, now: T1 })).toBe(false);
    for (const category of ['inline', 'eval', 'self'] as const) {
      expect(decide(s, ev({ category }), r, T1)).toBe(false);
    }
    for (const category of ['data', 'blob', 'external'] as const) {
      expect(decide(s, ev({ category }), r, T1)).toBe(true);
    }
  });

  it('suspect re-alerts after 30 days of absence and on a new directive', () => {
    const { db, site } = setup();
    const s = after(site);
    recordCspEvent(db, site, ev(), T0);
    markSuspect(db, site.id, 'https://x.com');
    const soon = recordCspEvent(db, site, ev(), T0 + 29 * DAY);
    expect(soon.status).toBe('suspect');
    expect(decide(s, ev(), soon, T0 + 29 * DAY)).toBe(false);
    const late = recordCspEvent(db, site, ev(), T0 + 29 * DAY + 31 * DAY);
    expect(decide(s, ev(), late, T0 + 60 * DAY)).toBe(true);
    const newDir = recordCspEvent(db, site, ev({ directive: 'img-src' }), T0 + 61 * DAY);
    expect(newDir).toMatchObject({ isNewRow: true, status: 'suspect' });
    expect(decide(s, ev({ directive: 'img-src' }), newDir, T0 + 61 * DAY)).toBe(true);
  });

  it('suspect alert on a new row is still suppressed during learning', () => {
    const { db, site } = setup();
    recordCspEvent(db, site, ev({ directive: 'img-src' }), T0);
    markSuspect(db, site.id, 'https://x.com');
    const r = recordCspEvent(db, site, ev(), T1);
    expect(decide(site, ev(), r, T1)).toBe(false);
  });

  it('approved rows never alert', () => {
    const { db, site } = setup();
    addApprovalPattern(db, site.id, 'https://x.com', ['script-src'], T0);
    const r = recordCspEvent(db, site, ev(), T1);
    expect(decide(after(site), ev(), r, T1)).toBe(false);
  });
});
