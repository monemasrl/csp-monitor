import type { Db } from './db.js';

/** Ordered, append-only list: migration N+1 runs after N. Each runs in its own transaction. */
const MIGRATIONS: string[] = [
  // 1: multi-type report support
  `ALTER TABLE origins ADD COLUMN detail TEXT;
   ALTER TABLE sites ADD COLUMN sensitive_paths TEXT NOT NULL DEFAULT '[]';
   ALTER TABLE sites ADD COLUMN enabled_headers TEXT NOT NULL DEFAULT '["csp"]';
   ALTER TABLE pending_alerts ADD COLUMN payload TEXT;
   ALTER TABLE pending_alerts ADD COLUMN immediate INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE IF NOT EXISTS window_counts (
     site_id INTEGER NOT NULL, report_type TEXT NOT NULL, k TEXT NOT NULL, bucket INTEGER NOT NULL,
     count INTEGER NOT NULL, PRIMARY KEY (site_id, report_type, k, bucket));
   CREATE TABLE IF NOT EXISTS reminders (
     id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL,
     due_at INTEGER NOT NULL, sent_at INTEGER, UNIQUE (site_id, kind, ref));`,
];

/** Applies the migrations newer than PRAGMA user_version; safe to call on every start. */
export function migrate(db: Db): void {
  const current = Number(db.pragma('user_version', { simple: true }));
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
