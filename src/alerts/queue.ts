import type { Db } from '../db/db.js';
import { getSite, listSites, type Site } from '../store/sites.js';
import type { Deps } from '../web/app.js';
import type { AlertRequest } from '../ingest/handlers/types.js';
import type { AlertKind } from './kinds.js';
import { renderAlertBatch, renderLearningSummary } from './render.js';

export type AlertItem = {
  origin: string; directive: string; page: string; sourceFile: string; sample: string; firstSeen: number; originId: number;
};
/**
 * One entry of a batch: origin-row data (originId set) or a bare payload (alerts not tied to an origins row;
 * origin/directive/page are then empty strings).
 */
export type AlertItemAny = AlertItem & { kind: AlertKind; payload?: Record<string, unknown> };
export type AlertBatch = { site: Site; items: AlertItemAny[]; pendingIds: number[] };

/** Kinds that are still alerted when the origin was approved inside the grouping window. */
const ALERT_EVEN_IF_APPROVED: ReadonlySet<AlertKind> = new Set<AlertKind>(['integrity']);

export function enqueue(db: Db, siteId: number, req: AlertRequest, now: number): void {
  db.prepare('INSERT INTO pending_alerts (site_id, origin_id, kind, created_at, payload, immediate) VALUES (?, ?, ?, ?, ?, ?)')
    .run(siteId, req.originId ?? null, req.kind, now, req.payload ? JSON.stringify(req.payload) : null, req.immediate ? 1 : 0);
}

/** Plan-1 entry point: a new-origin alert. */
export function enqueueAlert(db: Db, siteId: number, originId: number, now: number): void {
  enqueue(db, siteId, { kind: 'new-origin', originId }, now);
}

function parsePayload(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

type ItemRow = {
  id: number; origin: string; directive: string; first_page: string | null; first_seen: number;
  source_file: string | null; script_sample: string | null;
};

const ITEM_SQL = `SELECT o.id, o.origin, o.directive, o.first_page, o.first_seen,
  (SELECT s.source_file FROM samples s WHERE s.origin_id = o.id ORDER BY s.received_at, s.id LIMIT 1) AS source_file,
  (SELECT s.script_sample FROM samples s WHERE s.origin_id = o.id ORDER BY s.received_at, s.id LIMIT 1) AS script_sample
  FROM origins o`;

function toItem(r: ItemRow): AlertItem {
  return {
    originId: r.id, origin: r.origin, directive: r.directive, page: r.first_page ?? '',
    sourceFile: r.source_file ?? '', sample: r.script_sample ?? '', firstSeen: r.first_seen,
  };
}

export function dueBatches(db: Db, now: number, groupMs = 600_000): AlertBatch[] {
  const sites = db
    .prepare('SELECT site_id FROM pending_alerts WHERE sent_at IS NULL GROUP BY site_id HAVING ? - MIN(created_at) >= ? OR MAX(immediate) = 1 ORDER BY MIN(created_at)')
    .all(now, groupMs) as { site_id: number }[];
  const batches: AlertBatch[] = [];
  for (const { site_id } of sites) {
    const site = getSite(db, site_id);
    const pending = db
      .prepare('SELECT id, origin_id, kind, payload FROM pending_alerts WHERE site_id = ? AND sent_at IS NULL ORDER BY created_at, id')
      .all(site_id) as { id: number; origin_id: number | null; kind: AlertKind; payload: string | null }[];
    if (!site || pending.length === 0) continue;
    const seen = new Set<string>();
    const items: AlertItemAny[] = [];
    for (const p of pending) {
      const payload = parsePayload(p.payload);
      if (p.origin_id === null) {
        items.push({ kind: p.kind, origin: '', directive: '', page: '', sourceFile: '', sample: '', firstSeen: 0, originId: 0, ...(payload ? { payload } : {}) });
        continue;
      }
      const key = `${p.kind}:${p.origin_id}`;
      if (seen.has(key)) continue; // a re-alert of the same (kind, origin) is listed once
      seen.add(key);
      const row = db.prepare(`${ITEM_SQL} WHERE o.id = ?`).get(p.origin_id) as ItemRow | undefined;
      if (!row) continue;
      // Approved inside the grouping window: nothing to alert about any more (except integrity).
      const st = db.prepare('SELECT status FROM origins WHERE id = ?').get(p.origin_id) as { status: string } | undefined;
      if (st?.status === 'approved' && !ALERT_EVEN_IF_APPROVED.has(p.kind)) continue;
      items.push({ ...toItem(row), kind: p.kind, ...(payload ? { payload } : {}) });
    }
    batches.push({ site, items, pendingIds: pending.map(p => p.id) });
  }
  return batches;
}

export function markSent(db: Db, ids: number[], now: number): void {
  const upd = db.prepare('UPDATE pending_alerts SET sent_at = ? WHERE id = ? AND sent_at IS NULL');
  db.transaction(() => { for (const id of ids) upd.run(now, id); })();
}

/** Sends one batch per site on every channel; the batch is marked sent only if all channels succeed. */
export async function runDueAlerts(deps: Deps, now: number): Promise<void> {
  for (const batch of dueBatches(deps.db, now)) {
    try {
      if (batch.items.length > 0) {
        const msg = renderAlertBatch(batch, deps.config.baseUrl);
        for (const ch of deps.channels) await ch.send(msg);
      }
      markSent(deps.db, batch.pendingIds, now);
    } catch (e) {
      console.error(`alerts: sending batch for site ${batch.site.id} failed, will retry`, e instanceof Error ? e.message : 'error');
    }
  }
}

/** Sends the end-of-learning summary once per site (retried until a send succeeds). */
export async function runLearningSummaries(deps: Deps, now: number): Promise<void> {
  for (const site of listSites(deps.db)) {
    if (site.learningSummarySent || now < site.learningUntil) continue;
    try {
      const rows = deps.db
        .prepare(`${ITEM_SQL} WHERE o.site_id = ? AND o.report_type = 'csp-violation' AND o.status = 'new' AND o.first_seen < ? AND o.category NOT IN ('inline', 'eval', 'self') ORDER BY o.first_seen, o.id`)
        .all(site.id, site.learningUntil) as ItemRow[];
      const msg = renderLearningSummary(site, rows.map(toItem), deps.config.baseUrl);
      for (const ch of deps.channels) await ch.send(msg);
      deps.db.prepare('UPDATE sites SET learning_summary_sent = 1 WHERE id = ?').run(site.id);
    } catch (e) {
      console.error(`alerts: learning summary for site ${site.id} failed, will retry`, e instanceof Error ? e.message : 'error');
    }
  }
}
