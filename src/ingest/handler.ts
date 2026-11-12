import { decideCspAlert } from '../alerts/decide.js';
import { recordCspEvent, recordNoise } from '../store/origins.js';
import { getSiteByKey, touchSite } from '../store/sites.js';
import type { Deps } from '../web/app.js';
import { toCspEvent } from './csp.js';
import { classifyNoise } from './noise.js';
import { parseBody } from './parse.js';

/** Error name/code only: never the message, which could embed report data. */
export function errId(e: unknown): string {
  const x = e as { name?: unknown; code?: unknown } | null;
  return `${String(x?.name ?? 'unknown')}${x?.code !== undefined ? ` ${String(x.code)}` : ''}`;
}

/**
 * Full pipeline for one POST body. Never throws (errors are logged without report data).
 * A request that yields no reports at all counts as one 'invalid'; non-CSP report types are ignored silently.
 */
export function ingest(deps: Deps, key: string, contentType: string | undefined, text: string, now: number): void {
  try {
    const site = getSiteByKey(deps.db, key);
    if (!site) return;
    const reports = parseBody(contentType, text);
    if (reports.length === 0) {
      recordNoise(deps.db, site.id, 'invalid', now);
      return;
    }
    const extra = (deps.db.prepare('SELECT pattern FROM noise_patterns').all() as { pattern: string }[]).map(r => r.pattern);
    for (const raw of reports) {
      try {
        if (raw.type !== 'csp-violation') continue;
        const event = toCspEvent(raw, site.domains);
        if (!event) { recordNoise(deps.db, site.id, 'invalid', now); continue; }
        if (!deps.limiter.allow(site.id, site.ratePerMin, site.ratePerDay, now)) {
          if (deps.known.has(site.id, event.directive, event.origin) || !deps.limiter.allowUnseen(site.id, now)) {
            recordNoise(deps.db, site.id, 'rate-limit', now);
            continue;
          }
          // Never-seen pair: still recorded over the limit, capped per site per UTC day (allowUnseen).
        }
        const noise = classifyNoise(event, site.domains, extra);
        if (noise) { recordNoise(deps.db, site.id, noise, now); continue; }
        const result = recordCspEvent(deps.db, site, event, now, raw.body);
        deps.known.add(site.id, event.directive, event.origin);
        touchSite(deps.db, site.id, now);
        if (decideCspAlert({ site, event, noise: null, result, now })) {
          deps.onAlert(site.id, result.originId, now);
          deps.db.prepare('UPDATE origins SET last_alert_at = ? WHERE id = ?').run(now, result.originId);
        }
      } catch (e) {
        console.error('ingest: failed to process one report', errId(e));
      }
    }
  } catch (e) {
    console.error('ingest: unexpected failure', errId(e));
  }
}
