import { mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db/db.js';
import { utcDay } from '../time.js';

const DAY_MS = 86_400_000;
const KEEP_SAMPLES = 20;
const KEEP_BACKUPS = 14;
const BACKUP_RE = /^csp-monitor-\d{4}-\d{2}-\d{2}\.sqlite$/;

export function pruneData(db: Db, now: number): void {
  const cutoffDay = utcDay(now - 90 * DAY_MS);
  const run = db.transaction(() => {
    db.prepare('DELETE FROM daily_counts WHERE day < ?').run(cutoffDay);
    db.prepare('DELETE FROM noise_counts WHERE day < ?').run(cutoffDay);
    db.prepare('DELETE FROM pending_alerts WHERE sent_at IS NOT NULL AND sent_at < ?').run(now - 30 * DAY_MS);
    // Orphans (origin gone) are dropped; NULL-origin samples are ranked per site.
    db.prepare(`DELETE FROM samples WHERE origin_id IS NOT NULL
                  AND origin_id NOT IN (SELECT id FROM origins)`).run();
    db.prepare(`DELETE FROM samples WHERE id IN (
      SELECT id FROM (
        SELECT id, received_at,
               ROW_NUMBER() OVER (
                 PARTITION BY CASE WHEN origin_id IS NULL THEN -site_id ELSE origin_id END
                 ORDER BY received_at DESC, id DESC) AS rn
        FROM samples)
      WHERE rn > ? AND received_at < ?)`).run(KEEP_SAMPLES, now - 7 * DAY_MS);
  });
  run();
}

export function backupDb(db: Db, dir: string, now: number): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `csp-monitor-${utcDay(now)}.sqlite`);
  if (existsSync(file)) rmSync(file);
  db.prepare('VACUUM INTO ?').run(file);
  const backups = readdirSync(dir).filter(f => BACKUP_RE.test(f)).sort();
  for (const old of backups.slice(0, Math.max(0, backups.length - KEEP_BACKUPS))) rmSync(join(dir, old), { force: true });
  return file;
}
