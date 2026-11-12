import { recordDiscarded, type DiscardReason } from '../store/discarded.js';
import { recordNoise } from '../store/origins.js';
import { getSiteByKey, touchSite } from '../store/sites.js';
import type { Deps } from '../web/app.js';
import { HANDLERS } from './handlers/index.js';
import { dropIps } from './scrub.js';
import { parseBody, type RawReport } from './parse.js';
import { reduceUa } from './ua.js';

/** What is kept of a discarded report: no user agent (the reduced label is stored apart). */
const stored = (r: RawReport): string => JSON.stringify({ type: r.type, url: r.url, body: dropIps(r.body) });

/** Error name/code only: never the message, which could embed report data. */
export function errId(e: unknown): string {
  const x = e as { name?: unknown; code?: unknown } | null;
  return `${String(x?.name ?? 'unknown')}${x?.code !== undefined ? ` ${String(x.code)}` : ''}`;
}

/**
 * Full pipeline for one POST body. Never throws (errors are logged without report data).
 * A request that yields no reports at all counts as one 'invalid'; types without a handler are only kept in `discarded`.
 * Discarded reports (except over the rate limit) are kept in `discarded` for diagnosis.
 */
export function ingest(deps: Deps, key: string, contentType: string | undefined, text: string, now: number, requestUa?: string): void {
  try {
    const site = getSiteByKey(deps.db, key);
    if (!site) return;
    const ua = requestUa ? reduceUa(requestUa).label : undefined;
    const discard = (reason: DiscardReason, body: string, detail?: string) => {
      try {
        recordDiscarded(deps.db, site.id, now, reason, { body, detail, contentType, ua });
      } catch (e) {
        console.error('ingest: failed to keep a discarded report', errId(e));
      }
    };
    const reports = parseBody(contentType, text);
    if (reports.length === 0) {
      recordNoise(deps.db, site.id, 'invalid', now);
      discard('invalid', text);
      return;
    }
    const extra = (deps.db.prepare('SELECT pattern FROM noise_patterns').all() as { pattern: string }[]).map(r => r.pattern);
    for (const raw of reports) {
      try {
        const handler = HANDLERS.get(raw.type);
        if (!handler) { discard('unsupported-type', stored(raw), raw.type.slice(0, 60)); continue; }
        const event = handler.toEvent({ ...raw, userAgent: raw.userAgent ?? requestUa }, site);
        if (!event) { recordNoise(deps.db, site.id, 'invalid', now); discard('invalid', stored(raw)); continue; }
        const allowed = deps.limiter.allow(site.id, site.ratePerMin, site.ratePerDay, now);
        const noise = handler.noise(event, site, extra);
        const [keyA, keyB] = handler.keys(event);
        // Over the limit: only never-seen, non-noise pairs may spend the daily unseen budget.
        if (!allowed && (noise || deps.known.has(site.id, raw.type, keyA, keyB) || !deps.limiter.allowUnseen(site.id, now))) {
          recordNoise(deps.db, site.id, 'rate-limit', now);
          continue;
        }
        if (noise) { recordNoise(deps.db, site.id, noise, now); discard(noise, stored(raw)); continue; }
        const ctx = { db: deps.db, site, now };
        const result = handler.record(ctx, event, raw);
        deps.known.add(site.id, raw.type, keyA, keyB);
        touchSite(deps.db, site.id, now);
        if (!result) continue; // counted only (e.g. NEL 'ok'): nothing to decide
        const alert = handler.decide(ctx, event, result);
        if (alert) {
          deps.onAlert(site.id, alert, now);
          if (alert.originId !== undefined) {
            deps.db.prepare('UPDATE origins SET last_alert_at = ? WHERE id = ?').run(now, alert.originId);
          }
        }
      } catch (e) {
        console.error('ingest: failed to process one report', errId(e));
      }
    }
  } catch (e) {
    console.error('ingest: unexpected failure', errId(e));
  }
}
