import { hostMatchesDomains, normalizeOrigin, pathOf, stripUrl } from '../../match.js';
import { recordGeneric, sanitizedBody } from '../../store/origins.js';
import type { Site } from '../../store/sites.js';
import { EXTENSION_SCHEMES } from '../csp.js';
import { classifyNoise } from '../noise.js';
import type { RawReport } from '../parse.js';
import { reduceUa } from '../ua.js';
import type { AlertRequest, HandlerContext, ReportHandler } from './types.js';

/** Permissions Policy features whose violation raises an alert; the rest is only recorded. */
export const SENSITIVE_FEATURES = [
  'camera', 'microphone', 'geolocation', 'payment', 'display-capture', 'usb', 'serial', 'hid', 'bluetooth',
];

/** What the "first appearance" handlers share: a (keyA, keyB) identity plus what noise filtering needs. */
export type SimpleEvent = {
  keyA: string;
  keyB: string;
  category: string;
  /** Path of the document the report came from. */
  page: string;
  documentHost: string;
  isBot: boolean;
  ua: string;
  /** Blocked/resource URL without query, for the extension check; '' when the type has none. */
  resourceUrl: string;
  sourceFile: string;
  /** Origin matched against known-noise patterns; '' when the type has none. */
  noiseOrigin: string;
  message: string;
  line: number | null;
  disposition: 'enforce' | 'report';
};

const MAX = 200;
const URL_MAX = 2048;

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const noQuery = (s: string): string => s.split(/[?#]/, 1)[0]!;

/** Looks a field up by any spelling: camelCase, snake_case, kebab-case, any case of URL/Url. First non-empty string wins. */
function pick(body: Record<string, unknown>, ...names: string[]): string {
  const norm = (k: string): string => k.toLowerCase().replace(/[-_]/g, '');
  const entries = Object.entries(body).map(([k, v]) => [norm(k), v] as const);
  for (const n of names) {
    for (const [k, v] of entries) {
      if (k === norm(n) && typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return '';
}

/** Origin of a URL; extension schemes become `scheme:`; anything else is kept without query. '' for an empty input. */
function originOf(url: string): string {
  if (!url) return '';
  const origin = normalizeOrigin(url);
  if (origin) return origin;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  if (scheme && EXTENSION_SCHEMES.includes(scheme)) return `${scheme}:`;
  return noQuery(url).slice(0, MAX);
}

function categoryOf(origin: string, site: Site): string {
  if (!origin || origin === 'inline') return 'inline';
  try {
    return hostMatchesDomains(new URL(origin).hostname, site.domains) ? 'self' : 'external';
  } catch {
    return 'external';
  }
}

/** Parts of the event that depend on the type; everything else is derived by `build`. */
type Parts = {
  keyA: string;
  keyB: string;
  category?: string;
  resourceUrl?: string;
  noiseOrigin?: string;
  sourceFile?: string;
};

/** Common parsing: document URL (body or report URL), UA, line, disposition. Null when the document is unknown. */
function build(raw: RawReport, derive: (body: Record<string, unknown>, documentURL: string) => Parts | null): SimpleEvent | null {
  try {
    const body = raw.body ?? {};
    const documentURL = pick(body, 'documentURL', 'documentURI') || str(raw.url);
    const parts = derive(body, documentURL);
    if (!parts || !parts.keyA || !parts.keyB) return null;
    let host: string;
    try {
      host = new URL(documentURL).hostname.toLowerCase().replace(/\.$/, '');
    } catch {
      return null;
    }
    if (!host) return null;
    const lineRaw = body.lineNumber ?? body.line_number;
    const ua = reduceUa(raw.userAgent);
    const sourceFile = parts.sourceFile ?? '';
    return {
      keyA: parts.keyA.slice(0, MAX),
      keyB: parts.keyB.slice(0, URL_MAX),
      category: parts.category ?? 'external',
      page: pathOf(documentURL).slice(0, URL_MAX),
      documentHost: host,
      isBot: ua.isBot,
      ua: ua.label,
      resourceUrl: parts.resourceUrl ?? '',
      sourceFile: sourceFile ? stripUrl(sourceFile).slice(0, URL_MAX) || noQuery(sourceFile).slice(0, URL_MAX) : '',
      noiseOrigin: parts.noiseOrigin ?? '',
      message: pick(body, 'message').slice(0, MAX),
      line: typeof lineRaw === 'number' && Number.isFinite(lineRaw) ? lineRaw : null,
      disposition: pick(body, 'disposition') === 'enforce' ? 'enforce' : 'report',
    };
  } catch {
    return null;
  }
}

function resource(url: string): { url: string; origin: string } {
  const clean = url ? stripUrl(url) || noQuery(url) : '';
  return { url: clean.slice(0, URL_MAX), origin: originOf(url) };
}

function record(ctx: HandlerContext, type: string, e: SimpleEvent, raw: RawReport) {
  return recordGeneric(ctx.db, ctx.site, type, e.keyA, e.keyB, e.category, e.page, {
    sourceFile: e.sourceFile, sample: e.message, line: e.line, ua: e.ua, disposition: e.disposition,
    body: sanitizedBody(raw.body),
  }, ctx.now);
}

const learning = (ctx: HandlerContext): boolean => ctx.now < ctx.site.learningUntil;

function noise(e: SimpleEvent, site: Site, extra: string[]) {
  return classifyNoise(
    { blockedRaw: e.resourceUrl, sourceFile: e.sourceFile, documentHost: e.documentHost, isBot: e.isBot, origin: e.noiseOrigin },
    site.domains, extra,
  );
}

/** Builds a handler from its event derivation and its alert rule. */
function simple(
  type: string,
  derive: (body: Record<string, unknown>, documentURL: string, site: Site) => Parts | null,
  alertFor: (ctx: HandlerContext, e: SimpleEvent, r: { originId: number; isNewRow: boolean; status: string }) => AlertRequest | null,
): ReportHandler<SimpleEvent> {
  return {
    type,
    toEvent: (raw, site) => build(raw, (b, d) => derive(b, d, site)),
    keys: e => [e.keyA, e.keyB],
    noise,
    record: (ctx, e, raw) => record(ctx, type, e, raw),
    decide: (ctx, e, r) => (r.isNewRow && !learning(ctx) ? alertFor(ctx, e, r) : null),
  };
}

const notApproved = (r: { status: string }): boolean => r.status !== 'approved';

/** Prefix match on path boundaries; a trailing `*` makes it a plain string prefix. */
export function isSensitivePath(path: string, prefixes: string[]): boolean {
  return prefixes.some(p => {
    const t = p.trim();
    if (!t) return false;
    if (t.endsWith('*')) return path.startsWith(t.slice(0, -1));
    const base = t.replace(/\/+$/, '');
    return path === base || path.startsWith(base + '/');
  });
}

export const integrityHandler = simple('integrity-violation', (body) => {
  const blocked = pick(body, 'blockedURL', 'url');
  if (!blocked) return null;
  const res = resource(blocked);
  return {
    keyA: pick(body, 'destination') || 'script', keyB: res.url || res.origin,
    resourceUrl: res.url, noiseOrigin: res.origin, category: 'external',
  };
}, (_c, _e, r) => ({ kind: 'integrity', originId: r.originId })); // never suppressed by approvals

export const connectionHandler = simple('connection-allowlist', (body, _doc, site) => {
  const blocked = pick(body, 'blockedURL', 'url');
  if (!blocked) return null;
  const res = resource(blocked);
  return {
    keyA: (pick(body, 'type', 'destination') || 'connection').toLowerCase(), keyB: res.origin,
    resourceUrl: res.url, noiseOrigin: res.origin, category: categoryOf(res.origin, site),
  };
}, (ctx, e, r) => {
  if (!notApproved(r)) return null;
  const req: AlertRequest = { kind: 'new-connection', originId: r.originId };
  if (isSensitivePath(e.page, ctx.site.sensitivePaths)) req.immediate = true;
  return req;
});

export const permissionsHandler = simple('permissions-policy-violation', (body, _doc, site) => {
  const source = pick(body, 'sourceFile');
  const origin = source ? originOf(source) : 'inline';
  return {
    keyA: pick(body, 'featureId').toLowerCase(), keyB: origin, sourceFile: source,
    noiseOrigin: source ? origin : '', category: categoryOf(origin, site),
  };
}, (_c, e, r) =>
  notApproved(r) && SENSITIVE_FEATURES.includes(e.keyA) ? { kind: 'permission', originId: r.originId } : null);

export const documentPolicyHandler = simple('document-policy-violation', (body, doc) => {
  return { keyA: pick(body, 'featureId').toLowerCase(), keyB: pathOf(doc), category: 'self', sourceFile: pick(body, 'sourceFile') };
}, () => null);

export const interventionHandler = simple('intervention', body => {
  const source = pick(body, 'sourceFile');
  return { keyA: pick(body, 'id'), keyB: source ? stripUrl(source) || noQuery(source) : '—', category: 'self', sourceFile: source };
}, () => null);

const OTHER_WINDOW = ['otherDocumentURL', 'openerURL', 'openeeURL', 'previousResponseURL', 'nextResponseURL'];

export const coopHandler = simple('coop', body => {
  const other = OTHER_WINDOW.map(n => pick(body, n)).find(v => v !== '');
  return { keyA: pick(body, 'type'), keyB: other ? originOf(other) : '—', category: 'external' };
}, (_c, e, r) => (notApproved(r) && e.disposition === 'enforce' ? { kind: 'coop-blocked', originId: r.originId } : null));

export const coepHandler = simple('coep', (body) => {
  const blocked = pick(body, 'blockedURL', 'url');
  if (!blocked) return null;
  const res = resource(blocked);
  return {
    keyA: pick(body, 'destination') || 'unknown', keyB: res.url || res.origin,
    resourceUrl: res.url, noiseOrigin: res.origin, category: 'external',
  };
}, (_c, e, r) => (notApproved(r) && e.disposition === 'enforce' ? { kind: 'coep-blocked', originId: r.originId } : null));
