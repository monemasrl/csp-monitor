import { pathOf } from '../../match.js';
import { recordGeneric, sanitizedBody, type RecordResult } from '../../store/origins.js';
import { bumpWindow, sumWindow } from '../../store/windows.js';
import { classifyNoise } from '../noise.js';
import type { RawReport } from '../parse.js';
import { dropIps } from '../scrub.js';
import { reduceUa } from '../ua.js';
import { pick, str } from './simple.js';
import type { HandlerContext, ReportHandler } from './types.js';
import { utcDay } from '../../time.js';

const MAX = 200;
const URL_MAX = 2048;
const DAY = 86_400_000;

/** NEL rate rule: at least MIN_TOTAL estimated requests in the window and an error ratio above MAX_RATE. */
const WINDOW_MS = 15 * 60_000;
const MIN_TOTAL = 200;
const MAX_RATE = 0.005;
const NEL_THROTTLE_MS = 6 * 3_600_000;

/** Crash rule: at least CRASH_MIN in the last 7 days and at least CRASH_FACTOR times the 7 days before. */
const CRASH_MIN = 5;
const CRASH_FACTOR = 2;

const learning = (ctx: HandlerContext): boolean => ctx.now < ctx.site.learningUntil;

/** Claims a (kind, ref) slot for the site; true only for the first claim. Stored as already sent so no job picks it up. */
function claim(ctx: HandlerContext, kind: string, ref: string): boolean {
  return ctx.db
    .prepare('INSERT OR IGNORE INTO reminders (site_id, kind, ref, due_at, sent_at) VALUES (?, ?, ?, ?, ?)')
    .run(ctx.site.id, kind, ref, ctx.now, ctx.now).changes === 1;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- network-error

export type NelEvent = {
  keyA: string;
  keyB: string;
  /** body.type === 'ok': a successful request, only counted. */
  ok: boolean;
  /** Requests each report stands for: round(1 / sampling_fraction). */
  weight: number;
  page: string;
  documentHost: string;
  isBot: boolean;
  ua: string;
  phase: string;
  status: number | null;
};

function weightOf(body: Record<string, unknown>): number {
  const f = body.sampling_fraction ?? body.samplingFraction;
  return typeof f === 'number' && Number.isFinite(f) && f > 0 && f <= 1 ? Math.max(1, Math.round(1 / f)) : 1;
}

function nelEvent(raw: RawReport): NelEvent | null {
  try {
    const body = raw.body ?? {};
    const type = pick(body, 'type');
    const url = str(raw.url);
    const host = hostOf(url);
    if (!type || !host) return null;
    const ua = reduceUa(raw.userAgent);
    const status = body.status_code ?? body.statusCode;
    return {
      keyA: type.slice(0, MAX), keyB: host.slice(0, URL_MAX), ok: type === 'ok', weight: weightOf(body),
      page: pathOf(url).slice(0, URL_MAX), documentHost: host, isBot: ua.isBot, ua: ua.label,
      phase: pick(body, 'phase').slice(0, MAX),
      status: typeof status === 'number' && Number.isFinite(status) ? status : null,
    };
  } catch {
    return null;
  }
}

/** Sliding window over buckets: from the bucket 15 minutes ago to the current one (so 15 to 30 minutes of data). */
function nelRate(ctx: HandlerContext): { errors: number; total: number } {
  const from = ctx.now - WINDOW_MS;
  return {
    errors: sumWindow(ctx.db, ctx.site.id, 'network-error', 'errors', from, ctx.now),
    total: sumWindow(ctx.db, ctx.site.id, 'network-error', 'total', from, ctx.now),
  };
}

export const networkErrorHandler: ReportHandler<NelEvent> = {
  type: 'network-error',
  toEvent: raw => nelEvent(raw),
  keys: e => [e.keyA, e.keyB],
  // NEL describes the site's own requests: a foreign host is 'foreign-document'; extension/known-noise do not apply.
  noise: (e, site, extra) =>
    classifyNoise({ blockedRaw: '', sourceFile: '', documentHost: e.documentHost, isBot: e.isBot, origin: '' }, site.domains, extra),
  record(ctx, e, raw) {
    bumpWindow(ctx.db, ctx.site.id, 'network-error', 'total', ctx.now, e.weight);
    if (e.ok) return null; // counted, nothing stored
    bumpWindow(ctx.db, ctx.site.id, 'network-error', 'errors', ctx.now, e.weight);
    return recordGeneric(ctx.db, ctx.site, 'network-error', e.keyA, e.keyB, 'self', e.page, {
      sourceFile: '', sample: e.phase, line: e.status, ua: e.ua, disposition: 'report',
      body: sanitizedBody(dropIps(raw.body)),
    }, ctx.now);
  },
  decide(ctx, e, r) {
    if (e.ok || learning(ctx)) return null;
    if (r.isNewRow && e.keyA.startsWith('tls.cert')) {
      return { kind: 'tls-error', originId: r.originId, immediate: true, payload: { type: e.keyA, host: e.keyB } };
    }
    const { errors, total } = nelRate(ctx);
    if (total < MIN_TOTAL || errors / total <= MAX_RATE) return null;
    // One alert per site per 6-hour slot.
    if (!claim(ctx, 'nel-rate', String(Math.floor(ctx.now / NEL_THROTTLE_MS)))) return null;
    return { kind: 'nel-rate', payload: { errors: String(errors), total: String(total), rate: `${((100 * errors) / total).toFixed(2)}%` } };
  },
};

// ---------------------------------------------------------------- crash

export type CrashEvent = {
  keyA: string;
  keyB: string;
  documentHost: string;
  isBot: boolean;
  ua: string;
};

function crashEvent(raw: RawReport): CrashEvent | null {
  try {
    const body = raw.body ?? {};
    const url = pick(body, 'documentURL') || str(raw.url);
    const host = hostOf(url);
    if (!host) return null;
    const ua = reduceUa(raw.userAgent);
    return { keyA: (pick(body, 'reason') || 'unknown').slice(0, MAX), keyB: pathOf(url).slice(0, URL_MAX), documentHost: host, isBot: ua.isBot, ua: ua.label };
  } catch {
    return null;
  }
}

/** Counts of the row for the 7 days ending today (UTC, inclusive) and for the 7 days before them. */
function crashCounts(ctx: HandlerContext, e: CrashEvent): { recent: number; previous: number } {
  const sum = (fromDay: string, toDay: string): number =>
    (ctx.db
      .prepare("SELECT COALESCE(SUM(count), 0) AS n FROM daily_counts WHERE site_id = ? AND report_type = 'crash' AND directive = ? AND origin = ? AND day BETWEEN ? AND ?")
      .get(ctx.site.id, e.keyA, e.keyB, fromDay, toDay) as { n: number }).n;
  return {
    recent: sum(utcDay(ctx.now - 6 * DAY), utcDay(ctx.now)),
    previous: sum(utcDay(ctx.now - 13 * DAY), utcDay(ctx.now - 7 * DAY)),
  };
}

/** ISO 8601 week id ('YYYY-Www') of a ms timestamp, UTC. */
export function isoWeek(ms: number): string {
  const d = new Date(Date.UTC(new Date(ms).getUTCFullYear(), new Date(ms).getUTCMonth(), new Date(ms).getUTCDate()));
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dow); // Thursday of this week decides the year
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d.getTime() - Date.UTC(year, 0, 1)) / DAY + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

export const crashHandler: ReportHandler<CrashEvent> = {
  type: 'crash',
  toEvent: raw => crashEvent(raw),
  keys: e => [e.keyA, e.keyB],
  noise: (e, site, extra) =>
    classifyNoise({ blockedRaw: '', sourceFile: '', documentHost: e.documentHost, isBot: e.isBot, origin: '' }, site.domains, extra),
  record: (ctx, e, raw) =>
    recordGeneric(ctx.db, ctx.site, 'crash', e.keyA, e.keyB, 'self', e.keyB, {
      sourceFile: '', sample: e.keyA, line: null, ua: e.ua, disposition: 'report', body: sanitizedBody(dropIps(raw.body)),
    }, ctx.now),
  decide(ctx, e, r: RecordResult) {
    if (learning(ctx)) return null;
    const { recent, previous } = crashCounts(ctx, e);
    if (recent < CRASH_MIN || recent < CRASH_FACTOR * previous) return null;
    // One alert per page per ISO week, whatever the reason.
    if (!claim(ctx, 'crash-spike', `${e.keyB}|${isoWeek(ctx.now)}`)) return null;
    return { kind: 'crash-spike', originId: r.originId, payload: { page: e.keyB, reason: e.keyA, last7days: String(recent), previous7days: String(previous) } };
  },
};
