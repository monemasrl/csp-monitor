import { enqueue } from '../../alerts/queue.js';
import type { Db } from '../../db/db.js';
import { pathOf, stripUrl } from '../../match.js';
import { recordGeneric, sanitizedBody } from '../../store/origins.js';
import { getSite } from '../../store/sites.js';
import type { Deps } from '../../web/app.js';
import { classifyNoise } from '../noise.js';
import type { RawReport } from '../parse.js';
import { reduceUa } from '../ua.js';
import { noQuery, pick, str } from './simple.js';
import type { HandlerContext, ReportHandler } from './types.js';

const REMINDER_LEAD_MS = 30 * 86_400_000;
const API_MAX = 100;
const MAX = 200;
const URL_MAX = 2048;

export type DeprecationEvent = {
  keyA: 'api';
  keyB: string;
  message: string;
  /** Announced removal date (ms since epoch); null when absent or unparseable. */
  anticipatedRemoval: number | null;
  sourceFile: string;
  line: number | null;
  page: string;
  documentHost: string;
  isBot: boolean;
  ua: string;
};

/** ISO date string, ms number (any spelling of the field) or null; anything invalid counts as absent. */
function removalOf(body: Record<string, unknown>): number | null {
  const v = body.anticipatedRemoval ?? body.anticipated_removal;
  const ms = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Date.parse(v) : NaN;
  // Beyond the Date range (8.64e15 ms) the value cannot be formatted: treat it as absent.
  return Number.isFinite(ms) && ms > 0 && Number.isFinite(new Date(ms).getTime()) ? ms : null;
}

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

function toEvent(raw: RawReport): DeprecationEvent | null {
  try {
    const body = raw.body ?? {};
    const id = pick(body, 'id');
    const documentURL = pick(body, 'documentURL', 'documentURI') || str(raw.url);
    if (!id || !documentURL) return null;
    const host = new URL(documentURL).hostname.toLowerCase().replace(/\.$/, '');
    if (!host) return null;
    const source = pick(body, 'sourceFile');
    const lineRaw = body.lineNumber ?? body.line_number;
    const ua = reduceUa(raw.userAgent);
    return {
      keyA: 'api',
      keyB: id.slice(0, URL_MAX),
      message: pick(body, 'message').slice(0, MAX),
      anticipatedRemoval: removalOf(body),
      sourceFile: source ? stripUrl(source).slice(0, URL_MAX) || noQuery(source).slice(0, URL_MAX) : '',
      line: typeof lineRaw === 'number' && Number.isFinite(lineRaw) ? lineRaw : null,
      page: pathOf(documentURL).slice(0, URL_MAX),
      documentHost: host,
      isBot: ua.isBot,
      ua: ua.label,
    };
  } catch {
    return null;
  }
}

export const deprecationHandler: ReportHandler<DeprecationEvent> = {
  type: 'deprecation',
  toEvent: raw => toEvent(raw),
  keys: e => [e.keyA, e.keyB],
  noise: (e, site, extra) =>
    classifyNoise(
      { blockedRaw: '', sourceFile: e.sourceFile, documentHost: e.documentHost, isBot: e.isBot, origin: '' },
      site.domains, extra,
    ),
  record: (ctx: HandlerContext, e, raw) =>
    recordGeneric(ctx.db, ctx.site, 'deprecation', e.keyA, e.keyB, 'self', e.page, {
      sourceFile: e.sourceFile, sample: e.message, line: e.line, ua: e.ua, disposition: 'report', body: sanitizedBody(raw.body),
    }, ctx.now, {
      message: e.message, ...(e.anticipatedRemoval !== null ? { anticipatedRemoval: e.anticipatedRemoval } : {}),
      sourceFile: e.sourceFile, line: e.line,
    }),
  decide(ctx, e, r) {
    if (!r.isNewRow || e.anticipatedRemoval === null || e.anticipatedRemoval <= ctx.now) return null;
    // The removal date is a fact: keep the reminder even while learning, when no alert goes out.
    const dueAt = e.anticipatedRemoval - REMINDER_LEAD_MS;
    if (dueAt > ctx.now) {
      ctx.db.prepare('INSERT OR IGNORE INTO reminders (site_id, kind, ref, due_at) VALUES (?, ?, ?, ?)')
        .run(ctx.site.id, 'deprecation', e.keyB, dueAt);
    }
    if (ctx.now < ctx.site.learningUntil) return null;
    return { kind: 'deprecation', originId: r.originId, payload: { api: e.keyB.slice(0, API_MAX), removal: day(e.anticipatedRemoval) } };
  },
};

type DueRow = { id: number; site_id: number; ref: string; due_at: number };

/** Row of the deprecation report behind a reminder, with its removal date (ms), if it can still be found. */
function findOrigin(db: Db, siteId: number, api: string): { id: number; removal: number | null } | null {
  const row = db
    .prepare("SELECT id, detail FROM origins WHERE site_id = ? AND report_type = 'deprecation' AND directive = 'api' AND origin = ?")
    .get(siteId, api) as { id: number; detail: string | null } | undefined;
  if (!row) return null;
  let removal: number | null = null;
  try {
    const v = (JSON.parse(row.detail ?? 'null') as { anticipatedRemoval?: unknown } | null)?.anticipatedRemoval;
    if (typeof v === 'number') removal = v;
  } catch { /* detail unreadable: the reminder goes out without the origin's date */ }
  return { id: row.id, removal };
}

/** Scheduler job, kept next to its handler per the plan's file list. Enqueues the due, unsent reminders; each one is marked sent in the same transaction as its enqueue. */
export async function runReminders(deps: Deps, now: number): Promise<void> {
  const { db } = deps;
  const due = db
    .prepare("SELECT id, site_id, ref, due_at FROM reminders WHERE kind = 'deprecation' AND sent_at IS NULL AND due_at <= ? ORDER BY due_at, id")
    .all(now) as DueRow[];
  for (const r of due) {
    db.transaction(() => {
      const site = getSite(db, r.site_id);
      if (site) {
        const origin = findOrigin(db, r.site_id, r.ref);
        const removal = origin?.removal ?? r.due_at + REMINDER_LEAD_MS;
        enqueue(db, r.site_id, {
          kind: 'deprecation-reminder', immediate: true,
          ...(origin ? { originId: origin.id } : {}),
          payload: { api: r.ref.slice(0, API_MAX), removal: day(removal) },
        }, now);
      }
      // A site deleted meanwhile has nothing to remind about: mark it sent so it is never retried.
      db.prepare('UPDATE reminders SET sent_at = ? WHERE id = ?').run(now, r.id);
    })();
  }
}
