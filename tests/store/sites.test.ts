import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/db.js';
import { createSite, getSite, getSiteByKey, listSites, updateSite, endLearning, touchSite, setEnabledHeaders } from '../../src/store/sites.js';
import { getSetting, setSetting } from '../../src/store/settings.js';
import { NOW } from '../helpers.js';

describe('sites', () => {
  it('creates sites with unique 16-char alphanumeric keys', () => {
    const db = openDb(':memory:');
    const keys = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const s = createSite(db, { name: `s${i}`, domains: ['a.it'] }, NOW);
      expect(s.key).toMatch(/^[A-Za-z0-9]{16}$/);
      keys.add(s.key);
    }
    expect(keys.size).toBe(1000);
  });

  it('sets learning period, defaults and round-trips fields', () => {
    const db = openDb(':memory:');
    const s = createSite(db, { name: 'Gida', domains: ['gida-spa.it', '*.gida-spa.it'] }, NOW);
    expect(s.learningUntil).toBe(NOW + 7 * 24 * 3600 * 1000);
    expect(s).toMatchObject({ createdAt: NOW, learningSummarySent: false, ratePerMin: 120, ratePerDay: 20000, lastReportAt: null });
    expect(getSite(db, s.id)).toEqual(s);
    expect(getSiteByKey(db, s.key)).toEqual(s);
    expect(getSiteByKey(db, 'nope')).toBeNull();
    expect(getSite(db, 999)).toBeNull();
    expect(listSites(db)).toEqual([s]);
  });

  it('updates only patched fields, ends learning, touches', () => {
    const db = openDb(':memory:');
    const s = createSite(db, { name: 'A', domains: ['a.it'] }, NOW);
    updateSite(db, s.id, { name: 'B', ratePerMin: 5 });
    let u = getSite(db, s.id)!;
    expect(u).toMatchObject({ name: 'B', ratePerMin: 5, ratePerDay: 20000, domains: ['a.it'] });
    updateSite(db, s.id, { domains: ['x.it', 'y.it'], ratePerDay: 9 });
    u = getSite(db, s.id)!;
    expect(u).toMatchObject({ name: 'B', ratePerMin: 5, ratePerDay: 9, domains: ['x.it', 'y.it'] });
    updateSite(db, s.id, {});
    endLearning(db, s.id, NOW + 1);
    touchSite(db, s.id, NOW + 2);
    u = getSite(db, s.id)!;
    expect(u.learningUntil).toBe(NOW + 1);
    expect(u.lastReportAt).toBe(NOW + 2);
  });
});

describe('settings', () => {
  it('upserts', () => {
    const db = openDb(':memory:');
    expect(getSetting(db, 'alert_email')).toBeNull();
    setSetting(db, 'alert_email', 'a@x.it');
    setSetting(db, 'alert_email', 'b@x.it');
    expect(getSetting(db, 'alert_email')).toBe('b@x.it');
  });
});

describe('enabledHeaders', () => {
  it('defaults to csp', () => {
    const db = openDb(':memory:');
    expect(createSite(db, { name: 'a', domains: ['a.it'] }, NOW).enabledHeaders).toEqual(['csp']);
  });
  it('setEnabledHeaders dedupes, drops invalid values and always keeps csp', () => {
    const db = openDb(':memory:');
    const s = createSite(db, { name: 'a', domains: ['a.it'] }, NOW);
    setEnabledHeaders(db, s.id, ['nel', 'nel', 'coop', 'bogus' as never]);
    expect(getSite(db, s.id)!.enabledHeaders).toEqual(['csp', 'nel', 'coop']);
    setEnabledHeaders(db, s.id, []);
    expect(getSite(db, s.id)!.enabledHeaders).toEqual(['csp']);
  });
  it('parses tolerantly', () => {
    const db = openDb(':memory:');
    const s = createSite(db, { name: 'a', domains: ['a.it'] }, NOW);
    db.prepare('UPDATE sites SET enabled_headers = ? WHERE id = ?').run('["coop","zzz",3]', s.id);
    expect(getSite(db, s.id)!.enabledHeaders).toEqual(['coop']);
    db.prepare('UPDATE sites SET enabled_headers = ? WHERE id = ?').run('not json', s.id);
    expect(getSite(db, s.id)!.enabledHeaders).toEqual(['csp']);
  });
});
