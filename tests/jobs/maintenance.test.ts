import { mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/db.js';
import { backupDb, pruneData } from '../../src/jobs/maintenance.js';
import { NOW } from '../helpers.js';

const DAY = 86_400_000;
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'csp-maint-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function seed() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO sites (id,name,key,domains,created_at,learning_until) VALUES (1,'S','k','[]',0,0)").run();
  db.prepare("INSERT INTO origins (id,site_id,directive,origin,category,first_seen,last_seen) VALUES (1,1,'script-src','x.com','external',0,0)").run();
  return db;
}
const addSample = (db: ReturnType<typeof openDb>, origin: number | null, at: number) =>
  db.prepare("INSERT INTO samples (site_id,origin_id,report_type,received_at,body) VALUES (1,?,'csp-violation',?,'{}')").run(origin, at);

describe('pruneData', () => {
  it('keeps the 20 most recent samples plus those of the last 7 days', () => {
    const db = seed();
    for (let i = 0; i < 30; i++) addSample(db, 1, NOW - 20 * DAY - i * 1000);
    for (let i = 0; i < 5; i++) addSample(db, 1, NOW - DAY - i * 1000);
    pruneData(db, NOW);
    // union of top-20 and last-7-days: the 5 recent ones are inside the top 20
    expect(db.prepare('SELECT COUNT(*) c FROM samples').get()).toEqual({ c: 20 });
    expect(db.prepare('SELECT COUNT(*) c FROM samples WHERE received_at >= ?').get(NOW - 7 * DAY)).toEqual({ c: 5 });
  });

  it('keeps all samples of the last 7 days even beyond 20', () => {
    const db = seed();
    for (let i = 0; i < 30; i++) addSample(db, 1, NOW - DAY - i * 1000);
    pruneData(db, NOW);
    expect(db.prepare('SELECT COUNT(*) c FROM samples').get()).toEqual({ c: 30 });
  });

  it('deletes orphan samples (NULL origin) beyond the same rule per site', () => {
    const db = seed();
    for (let i = 0; i < 25; i++) addSample(db, null, NOW - 20 * DAY - i * 1000);
    pruneData(db, NOW);
    expect(db.prepare('SELECT COUNT(*) c FROM samples').get()).toEqual({ c: 20 });
  });

  it('deletes samples whose origin no longer exists', () => {
    const db = seed();
    db.pragma('foreign_keys = OFF');
    addSample(db, 99, NOW);
    pruneData(db, NOW);
    expect(db.prepare('SELECT COUNT(*) c FROM samples').get()).toEqual({ c: 0 });
  });

  it('prunes counts older than 90 days and old sent alerts', () => {
    const db = seed();
    const old = new Date(NOW - 91 * DAY).toISOString().slice(0, 10);
    const edge = new Date(NOW - 90 * DAY).toISOString().slice(0, 10);
    for (const day of [old, edge]) {
      db.prepare("INSERT INTO daily_counts VALUES (1,'csp-violation','script-src','x.com',?,1)").run(day);
      db.prepare("INSERT INTO noise_counts VALUES (1,'bot',?,1)").run(day);
    }
    const ins = db.prepare("INSERT INTO pending_alerts (site_id,kind,created_at,sent_at) VALUES (1,'new',0,?)");
    ins.run(NOW - 31 * DAY); ins.run(NOW - 29 * DAY); ins.run(null);
    pruneData(db, NOW);
    expect(db.prepare('SELECT day FROM daily_counts').all()).toEqual([{ day: edge }]);
    expect(db.prepare('SELECT day FROM noise_counts').all()).toEqual([{ day: edge }]);
    expect(db.prepare('SELECT COUNT(*) c FROM pending_alerts').get()).toEqual({ c: 2 });
  });
});

describe('backupDb', () => {
  it('creates a dir, a openable backup with the sites, and replaces the same-day file', () => {
    const db = seed();
    const target = join(dir, 'sub', 'backups');
    const p = backupDb(db, target, NOW);
    expect(p).toBe(join(target, 'csp-monitor-2026-11-12.sqlite'));
    const p2 = backupDb(db, target, NOW);
    expect(p2).toBe(p);
    const b = openDb(p);
    expect(b.prepare('SELECT name FROM sites').all()).toEqual([{ name: 'S' }]);
    b.close();
  });

  it("handles a quote in the path", () => {
    const p = backupDb(seed(), join(dir, "it's"), NOW);
    expect(existsSync(p)).toBe(true);
  });

  it('keeps only the 14 most recent backups and ignores other files', () => {
    const db = seed();
    for (let i = 1; i <= 16; i++) writeFileSync(join(dir, `csp-monitor-2026-10-${String(i).padStart(2, '0')}.sqlite`), 'x');
    writeFileSync(join(dir, 'notes.txt'), 'keep');
    backupDb(db, dir, NOW);
    const files = readdirSync(dir).filter(f => f.endsWith('.sqlite')).sort();
    expect(files).toHaveLength(14);
    expect(files.at(-1)).toBe('csp-monitor-2026-11-12.sqlite');
    expect(files[0]).toBe('csp-monitor-2026-10-04.sqlite');
    expect(readdirSync(dir)).toContain('notes.txt');
  });
});
