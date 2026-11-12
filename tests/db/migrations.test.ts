import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/db.js';
import { migrate } from '../../src/db/migrations.js';

const cols = (db: Database.Database, t: string): string[] =>
  (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(c => c.name).sort();

describe('migrate', () => {
  it('brings a fresh db to user_version 1 and is idempotent', () => {
    const db = openDb(':memory:');
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    migrate(db);
    migrate(db);
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    expect(cols(db, 'origins')).toContain('detail');
    expect(cols(db, 'sites')).toEqual(expect.arrayContaining(['sensitive_paths', 'enabled_headers']));
    expect(cols(db, 'pending_alerts')).toEqual(expect.arrayContaining(['payload', 'immediate']));
    expect(cols(db, 'window_counts')).toEqual(['bucket', 'count', 'k', 'report_type', 'site_id']);
    expect(cols(db, 'reminders')).toEqual(['due_at', 'id', 'kind', 'ref', 'sent_at', 'site_id']);
  });

  it('migrates a Plan-1 database with data without losing anything', () => {
    const db = new Database(':memory:');
    db.exec(readFileSync(new URL('../../src/db/schema.sql', import.meta.url), 'utf8'));
    expect(db.pragma('user_version', { simple: true })).toBe(0);
    db.prepare("INSERT INTO sites (name, key, domains, created_at, learning_until) VALUES ('s','k','[]',0,0)").run();
    db.prepare("INSERT INTO origins (site_id, directive, origin, category, status, first_seen, last_seen, count) VALUES (1,'script-src','https://a.example','external','new',0,0,3)").run();
    db.prepare("INSERT INTO pending_alerts (site_id, origin_id, kind, created_at) VALUES (1, 1, 'new-origin', 5)").run();
    migrate(db);
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    expect(db.prepare('SELECT count, detail FROM origins').get()).toEqual({ count: 3, detail: null });
    expect(db.prepare('SELECT sensitive_paths, enabled_headers FROM sites').get()).toEqual({ sensitive_paths: '[]', enabled_headers: '["csp"]' });
    expect(db.prepare('SELECT kind, payload, immediate FROM pending_alerts').get()).toEqual({ kind: 'new-origin', payload: null, immediate: 0 });
  });
});
