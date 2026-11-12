import type { Db } from '../db/db.js';
import type { NoiseReason } from '../ingest/noise.js';

export type DiscardReason = NoiseReason | 'invalid' | 'unsupported-type';

export type Discarded = {
  id: number; receivedAt: number; reason: DiscardReason; detail: string | null;
  contentType: string | null; ua: string | null; body: string;
};

export const KEEP_DISCARDED = 50;
const BODY_MAX = 4096;

/** Removes query strings and fragments from every URL in the text (they may carry emails or tokens). */
export function stripQueries(text: string): string {
  return text.replace(/((?:https?|wss?):\/\/[^\s"'?#]*)[?#][^\s"']*/gi, '$1');
}

/** Stores one discarded report and keeps only the latest KEEP_DISCARDED of the site. */
export function recordDiscarded(
  db: Db, siteId: number, now: number, reason: DiscardReason,
  info: { body: string; detail?: string; contentType?: string; ua?: string },
): void {
  let body = stripQueries(info.body);
  if (body.length > BODY_MAX) body = `${body.slice(0, BODY_MAX)}…`;
  db.transaction(() => {
    db.prepare(`INSERT INTO discarded (site_id, received_at, reason, detail, content_type, ua, body)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(siteId, now, reason, info.detail ?? null, info.contentType?.slice(0, 100) ?? null, info.ua ?? null, body);
    db.prepare(`DELETE FROM discarded WHERE site_id = ? AND id NOT IN (
                  SELECT id FROM discarded WHERE site_id = ? ORDER BY received_at DESC, id DESC LIMIT ?)`)
      .run(siteId, siteId, KEEP_DISCARDED);
  })();
}

type Row = {
  id: number; received_at: number; reason: DiscardReason; detail: string | null;
  content_type: string | null; ua: string | null; body: string;
};

export function listDiscarded(db: Db, siteId: number): Discarded[] {
  return (db.prepare('SELECT * FROM discarded WHERE site_id = ? ORDER BY received_at DESC, id DESC').all(siteId) as Row[])
    .map(r => ({
      id: r.id, receivedAt: r.received_at, reason: r.reason, detail: r.detail,
      contentType: r.content_type, ua: r.ua, body: r.body,
    }));
}
