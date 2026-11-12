import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/db.js';
import { KnownCache, RateLimiter } from '../../src/ingest/limits.js';

const T = Date.UTC(2026, 10, 12, 9, 0, 30);

describe('RateLimiter', () => {
  it('enforces the per-minute window and resets on the next minute', () => {
    const l = new RateLimiter();
    for (let i = 0; i < 3; i++) expect(l.allow(1, 3, 100, T)).toBe(true);
    expect(l.allow(1, 3, 100, T)).toBe(false);
    expect(l.allow(2, 3, 100, T)).toBe(true);
    expect(l.allow(1, 3, 100, T + 60_000)).toBe(true);
  });
  it('enforces the per-UTC-day window', () => {
    const l = new RateLimiter();
    expect(l.allow(1, 100, 2, T)).toBe(true);
    expect(l.allow(1, 100, 2, T + 60_000)).toBe(true);
    expect(l.allow(1, 100, 2, T + 120_000)).toBe(false);
    expect(l.allow(1, 100, 2, Date.UTC(2026, 10, 13, 0, 0, 1))).toBe(true);
  });
});

describe('KnownCache', () => {
  it('add/has and load from origins', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO sites (name, key, domains, created_at, learning_until) VALUES ('s','k','[]',0,0)").run();
    db.prepare("INSERT INTO origins (site_id, directive, origin, category, status, first_seen, last_seen, count) VALUES (1,'script-src','https://a.example','external','new',0,0,1)").run();
    const c = new KnownCache();
    c.load(db);
    expect(c.has(1, 'script-src', 'https://a.example')).toBe(true);
    expect(c.has(1, 'img-src', 'https://a.example')).toBe(false);
    c.add(1, 'img-src', 'https://a.example');
    expect(c.has(1, 'img-src', 'https://a.example')).toBe(true);
  });
});
