import type { CspEvent } from '../ingest/csp.js';
import type { NoiseReason } from '../ingest/noise.js';
import type { RecordResult } from '../store/origins.js';
import type { Site } from '../store/sites.js';

const SUSPECT_ABSENCE_MS = 30 * 24 * 3600 * 1000;

/** Pure alert decision (spec section 5). */
export function decideCspAlert(input: {
  site: Site; event: CspEvent; noise: NoiseReason | null; result: RecordResult; now: number;
}): boolean {
  const { site, event, noise, result, now } = input;
  if (noise !== null) return false;
  if (event.category === 'inline' || event.category === 'eval' || event.category === 'self') return false;
  if (result.isNewRow) {
    return (result.status === 'new' || result.status === 'suspect') && now >= site.learningUntil;
  }
  return result.status === 'suspect'
    && result.previousLastSeen !== null
    && now - result.previousLastSeen > SUSPECT_ABSENCE_MS;
}
