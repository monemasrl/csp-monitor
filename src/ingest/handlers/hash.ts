import { pathOf, stripUrl } from '../../match.js';
import type { Db } from '../../db/db.js';
import { getDetail, recordGeneric, sanitizedBody, updateDetail, type RecordResult } from '../../store/origins.js';
import { getSetting, setSetting } from '../../store/settings.js';
import { classifyNoise } from '../noise.js';
import type { RawReport } from '../parse.js';
import { reduceUa } from '../ua.js';
import { noQuery, pick, str } from './simple.js';
import type { HandlerContext, ReportHandler } from './types.js';

const RELEASE_MS = 3_600_000;
const MAX_PAGES = 20;
const HASH_MAX = 100;

export type HashEvent = {
  keyA: 'script';
  keyB: string;
  hash: string;
  page: string;
  documentHost: string;
  subresource: string;
  isBot: boolean;
  ua: string;
  disposition: 'enforce' | 'report';
};

/** What `record` found out about the hash, handed to `decide`. */
type HashResult = RecordResult & { hashChange?: { previousHash: string; currentHash: string } };

const releaseKey = (siteId: number): string => `release_until:${siteId}`;

/** Starts a one-hour release window during which hash changes are absorbed without alerts. */
export function startRelease(db: Db, siteId: number, now: number): void {
  setSetting(db, releaseKey(siteId), String(now + RELEASE_MS));
}

/** End of the current (or last) release window, 0 when none was ever started. */
export const releaseUntil = (db: Db, siteId: number): number => Number(getSetting(db, releaseKey(siteId)) ?? 0) || 0;
const inRelease = (db: Db, siteId: number, now: number): boolean => now < releaseUntil(db, siteId);
const learning = (ctx: HandlerContext): boolean => ctx.now < ctx.site.learningUntil;

function toEvent(raw: RawReport): HashEvent | null {
  try {
    const body = raw.body ?? {};
    const documentURL = pick(body, 'documentURL', 'documentURI') || str(raw.url);
    const hash = pick(body, 'hash');
    if (!hash || !documentURL) return null;
    const host = new URL(documentURL).hostname.toLowerCase().replace(/\.$/, '');
    if (!host) return null;
    let sub = pick(body, 'subresourceURL');
    if (!sub) {
      // `url` stands in for the subresource only when it is not just the document itself.
      const u = pick(body, 'url');
      if (u && u !== documentURL) sub = u;
    }
    const page = pathOf(documentURL).slice(0, 2048);
    const clean = sub ? stripUrl(sub) || noQuery(sub) : '';
    const ua = reduceUa(raw.userAgent);
    return {
      keyA: 'script',
      keyB: (clean || `inline:${page}`).slice(0, 2048),
      hash: hash.slice(0, 200),
      page,
      documentHost: host,
      subresource: clean,
      isBot: ua.isBot,
      ua: ua.label,
      disposition: pick(body, 'disposition') === 'enforce' ? 'enforce' : 'report',
    };
  } catch {
    return null;
  }
}

function pagesWith(existing: unknown, page: string): string[] {
  const list = Array.isArray(existing) ? existing.filter((p): p is string => typeof p === 'string') : [];
  return [...list.filter(p => p !== page), page].slice(-MAX_PAGES);
}

export const hashHandler: ReportHandler<HashEvent> = {
  type: 'csp-hash',
  toEvent: raw => toEvent(raw),
  keys: e => [e.keyA, e.keyB],
  noise: (e, site, extra) =>
    classifyNoise(
      { blockedRaw: e.subresource, sourceFile: '', documentHost: e.documentHost, isBot: e.isBot, origin: '' },
      site.domains, extra,
    ),
  record(ctx, e, raw): HashResult {
    // Detail is written below, once the previous hash is known.
    const r: HashResult = recordGeneric(ctx.db, ctx.site, 'csp-hash', e.keyA, e.keyB, e.subresource ? 'external' : 'inline', e.page, {
      sourceFile: e.subresource, sample: e.hash, line: null, ua: e.ua, disposition: e.disposition, body: sanitizedBody(raw.body),
    }, ctx.now);
    const prev = r.isNewRow ? null : getDetail(ctx.db, r.originId);
    const prevHash = typeof prev?.currentHash === 'string' ? prev.currentHash : null;
    const detail: Record<string, unknown> = { ...(prev ?? {}), currentHash: e.hash, pages: pagesWith(prev?.pages, e.page) };
    if (prevHash === null || prevHash === e.hash) {
      updateDetail(ctx.db, r.originId, detail);
      return r;
    }
    // Already changed once and still unreviewed ('new'): keep tracking but do not alert again.
    const alreadyFlagged = r.status === 'new' && prev?.flagged === true;
    detail.previousHash = prevHash;
    detail.changedAt = ctx.now;
    if (prev?.volatile === true || inRelease(ctx.db, ctx.site.id, ctx.now)) {
      updateDetail(ctx.db, r.originId, detail);
      return r;
    }
    detail.flagged = true; // an alert went out (or is already pending review) for this row
    updateDetail(ctx.db, r.originId, detail, 'new');
    if (alreadyFlagged) return r;
    return { ...r, status: 'new', hashChange: { previousHash: prevHash, currentHash: e.hash } };
  },
  decide(ctx, _e, r: HashResult) {
    if (learning(ctx)) return null;
    if (r.isNewRow) return { kind: 'new-script', originId: r.originId };
    if (r.hashChange) {
      return {
        kind: 'hash-changed', originId: r.originId,
        payload: {
          previousHash: r.hashChange.previousHash.slice(0, HASH_MAX),
          currentHash: r.hashChange.currentHash.slice(0, HASH_MAX),
        },
      };
    }
    return null;
  },
};
