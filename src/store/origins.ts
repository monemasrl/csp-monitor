import type { Db } from '../db/db.js';
import type { CspEvent } from '../ingest/csp.js';
import type { NoiseReason } from '../ingest/noise.js';
import { matchesPattern, stripUrl } from '../match.js';
import type { Site } from './sites.js';
import { utcDay } from '../time.js';

export type RecordResult = {
  originId: number;
  isNewRow: boolean;
  status: 'new' | 'approved' | 'suspect';
  previousLastSeen: number | null;
};

const BODY_MAX = 8192;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Approval with site_id = siteId or NULL (global), same directive, whose pattern matches the origin. */
export function isCovered(db: Db, siteId: number, origin: string, directive: string): boolean {
  const rows = db
    .prepare('SELECT pattern FROM approvals WHERE (site_id = ? OR site_id IS NULL) AND directive = ?')
    .all(siteId, directive) as { pattern: string }[];
  return rows.some(r => r.pattern === origin || matchesPattern(r.pattern, origin));
}

/** stripUrl, or for unparseable URLs a manual cut: no query, fragment or userinfo. */
function cleanUrl(v: string): string {
  const stripped = stripUrl(v);
  if (stripped) return stripped;
  const cut = v.split(/[?#]/, 1)[0]!;
  // Drop everything between '://' and the LAST '@' (a password may contain '/').
  return cut.replace(/^([a-z][a-z0-9+.-]*:\/\/)[\s\S]*@/i, '$1');
}

/** Strings that are absolute web URLs lose query/fragment/credentials; everything else is kept. */
function sanitize(v: unknown): unknown {
  if (typeof v === 'string') return URL_SCHEME.test(v.trim()) ? cleanUrl(v.trim()) : v;
  if (Array.isArray(v)) return v.map(sanitize);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sanitize(x)]));
  }
  return v;
}

function bodyOf(e: CspEvent, raw?: Record<string, unknown>): string {
  let text: string;
  try {
    text = JSON.stringify(sanitize(raw ?? e));
  } catch {
    text = JSON.stringify(e);
  }
  return text.slice(0, BODY_MAX);
}

export function recordCspEvent(
  db: Db, site: Site, e: CspEvent, now: number, raw?: Record<string, unknown>,
): RecordResult {
  const tx = db.transaction((): RecordResult => {
    const existing = db
      .prepare("SELECT id, status, last_seen FROM origins WHERE site_id = ? AND report_type = 'csp-violation' AND directive = ? AND origin = ?")
      .get(site.id, e.directive, e.origin) as { id: number; status: RecordResult['status']; last_seen: number } | undefined;

    let result: RecordResult;
    if (existing) {
      db.prepare('UPDATE origins SET count = count + 1, last_seen = ? WHERE id = ?').run(now, existing.id);
      result = { originId: existing.id, isNewRow: false, status: existing.status, previousLastSeen: existing.last_seen };
    } else {
      let status: RecordResult['status'] = 'new';
      if (isCovered(db, site.id, e.origin, e.directive)) {
        status = 'approved';
      } else if (db.prepare("SELECT 1 FROM origins WHERE site_id = ? AND origin = ? AND status = 'suspect' LIMIT 1").get(site.id, e.origin)) {
        status = 'suspect';
      }
      const info = db
        .prepare('INSERT INTO origins (site_id, directive, origin, category, status, first_seen, last_seen, count, first_page) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)')
        .run(site.id, e.directive, e.origin, e.category, status, now, now, e.page);
      result = { originId: Number(info.lastInsertRowid), isNewRow: true, status, previousLastSeen: null };
    }

    db.prepare(
      "INSERT INTO daily_counts (site_id, report_type, directive, origin, day, count) VALUES (?, 'csp-violation', ?, ?, ?, 1) ON CONFLICT DO UPDATE SET count = count + 1",
    ).run(site.id, e.directive, e.origin, utcDay(now));

    db.prepare(
      "INSERT INTO samples (site_id, origin_id, report_type, received_at, page, source_file, script_sample, line, ua, disposition, body) VALUES (?, ?, 'csp-violation', ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(site.id, result.originId, now, e.page, e.sourceFile, e.sample, e.line, e.ua, e.disposition, bodyOf(e, raw));

    return result;
  });
  return tx();
}

export function recordNoise(db: Db, siteId: number, reason: NoiseReason | 'rate-limit' | 'invalid', now: number): void {
  db.prepare(
    'INSERT INTO noise_counts (site_id, reason, day, count) VALUES (?, ?, ?, 1) ON CONFLICT DO UPDATE SET count = count + 1',
  ).run(siteId, reason, utcDay(now));
}

function insertApproval(db: Db, siteId: number | null, pattern: string, directive: string, now: number): void {
  // UNIQUE treats NULL site_ids as distinct, so global duplicates need an explicit check.
  const dup = siteId === null
    ? db.prepare('SELECT 1 FROM approvals WHERE site_id IS NULL AND pattern = ? AND directive = ?').get(pattern, directive)
    : undefined;
  if (dup) return;
  db.prepare('INSERT OR IGNORE INTO approvals (site_id, pattern, directive, created_at) VALUES (?, ?, ?, ?)')
    .run(siteId, pattern, directive, now);
}

/** Approves the origin on the directives it has been seen with so far on this site (all sites when global). */
export function approveOrigin(db: Db, siteId: number, origin: string, scope: 'site' | 'global', now: number): void {
  db.transaction(() => {
    const directives = (db
      .prepare('SELECT DISTINCT directive FROM origins WHERE site_id = ? AND origin = ?')
      .all(siteId, origin) as { directive: string }[]).map(r => r.directive);
    for (const d of directives) {
      insertApproval(db, scope === 'global' ? null : siteId, origin, d, now);
      if (scope === 'global') {
        db.prepare("UPDATE origins SET status = 'approved' WHERE origin = ? AND directive = ?").run(origin, d);
      } else {
        db.prepare("UPDATE origins SET status = 'approved' WHERE site_id = ? AND origin = ? AND directive = ?").run(siteId, origin, d);
      }
    }
  })();
}

/** Hand-made (wildcard) approval; existing 'new'/'suspect' rows it covers become approved. */
export function addApprovalPattern(
  db: Db, siteId: number | null, pattern: string, directives: string[], now: number,
): void {
  db.transaction(() => {
    for (const d of directives) insertApproval(db, siteId, pattern, d, now);
    const rows = (siteId === null
      ? db.prepare("SELECT id, origin, directive FROM origins WHERE status IN ('new', 'suspect')").all()
      : db.prepare("SELECT id, origin, directive FROM origins WHERE site_id = ? AND status IN ('new', 'suspect')").all(siteId)
    ) as { id: number; origin: string; directive: string }[];
    const upd = db.prepare("UPDATE origins SET status = 'approved' WHERE id = ?");
    for (const r of rows) {
      if (directives.includes(r.directive) && (pattern === r.origin || matchesPattern(pattern, r.origin))) upd.run(r.id);
    }
  })();
}

/** Marks every row of the origin on this site as suspect (an explicit user action: overrides approved too). */
export function markSuspect(db: Db, siteId: number, origin: string): void {
  db.prepare("UPDATE origins SET status = 'suspect' WHERE site_id = ? AND origin = ?").run(siteId, origin);
}

/**
 * Deletes the approval only. Statuses already set to 'approved' are NOT reverted
 * (history is kept); only future rows stop being auto-approved.
 */
export function removeApproval(db: Db, approvalId: number): void {
  db.prepare('DELETE FROM approvals WHERE id = ?').run(approvalId);
}
