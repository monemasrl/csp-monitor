import type { Db } from '../db/db.js';

/** Width of one counter bucket: 15 minutes. */
export const BUCKET_MS = 900_000;

const bucketOf = (ms: number): number => Math.floor(ms / BUCKET_MS);

/** Adds `by` to the counter (site, type, k) of the bucket containing `now`. */
export function bumpWindow(db: Db, siteId: number, type: string, k: string, now: number, by = 1): void {
  db.prepare(
    'INSERT INTO window_counts (site_id, report_type, k, bucket, count) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET count = count + excluded.count',
  ).run(siteId, type, k, bucketOf(now), by);
}

/**
 * Sum of the buckets from the one containing `fromMs` to the one containing `toMs`, both included.
 * Granularity is the bucket: a 15-minute span covers the current and the previous bucket.
 */
export function sumWindow(db: Db, siteId: number, type: string, k: string, fromMs: number, toMs: number): number {
  const row = db
    .prepare('SELECT COALESCE(SUM(count), 0) AS n FROM window_counts WHERE site_id = ? AND report_type = ? AND k = ? AND bucket BETWEEN ? AND ?')
    .get(siteId, type, k, bucketOf(fromMs), bucketOf(toMs)) as { n: number };
  return row.n;
}
