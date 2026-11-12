import { hostMatchesDomains, normalizeOrigin, pathOf, stripUrl } from '../match.js';
import type { RawReport } from './parse.js';
import { reduceUa } from './ua.js';

export type Category = 'external' | 'inline' | 'eval' | 'data' | 'blob' | 'self';

export type CspEvent = {
  directive: string;
  origin: string;
  category: Category;
  page: string;
  documentUrl: string;
  documentHost: string;
  blockedRaw: string;
  sourceFile: string;
  sample: string;
  line: number | null;
  disposition: 'enforce' | 'report';
  ua: string;
  isBot: boolean;
};

const MAX = 200;
export const EXTENSION_SCHEMES = [
  'chrome-extension',
  'moz-extension',
  'safari-extension',
  'safari-web-extension',
  'ms-browser-extension',
  'webkit-masked-url',
];

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const cut = (s: string): string => s.slice(0, MAX);
const noQuery = (s: string): string => s.split(/[?#]/, 1)[0]!;

function directiveOf(body: Record<string, unknown>): string {
  const raw = str(body.effectiveDirective).trim() || str(body.violatedDirective).trim().split(/\s+/)[0]!;
  return raw.toLowerCase().replace(/-(elem|attr)$/, '');
}

function classify(
  blocked: string,
  siteDomains: string[],
): { category: Category; origin: string; blockedRaw: string } {
  const b = blocked.trim();
  const lower = b.toLowerCase();
  if (lower === '' || lower === 'inline') return { category: 'inline', origin: 'inline', blockedRaw: cut(b) };
  if (lower === 'eval' || lower === 'wasm-eval') return { category: 'eval', origin: 'eval', blockedRaw: cut(b) };
  if (lower === 'data' || lower.startsWith('data:')) {
    return { category: 'data', origin: 'data:', blockedRaw: cut(noQuery(b)) };
  }
  if (lower === 'blob' || lower.startsWith('blob:')) {
    return { category: 'blob', origin: 'blob:', blockedRaw: cut(noQuery(b)) };
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(b)?.[1]?.toLowerCase();
  if (scheme && EXTENSION_SCHEMES.includes(scheme)) {
    return { category: 'external', origin: `${scheme}:`, blockedRaw: cut(stripUrl(b) || noQuery(b)) };
  }
  const origin = normalizeOrigin(b);
  if (origin) {
    const host = new URL(origin).hostname;
    return {
      category: hostMatchesDomains(host, siteDomains) ? 'self' : 'external',
      origin,
      blockedRaw: cut(stripUrl(b) || noQuery(b)),
    };
  }
  return { category: 'external', origin: cut(noQuery(b)), blockedRaw: cut(noQuery(b)) };
}

/** Never throws; null when the document URL or the directive is missing/invalid. */
export function toCspEvent(raw: RawReport, siteDomains: string[]): CspEvent | null {
  try {
    const body = raw.body ?? {};
    const directive = directiveOf(body);
    const documentURL = str(body.documentURL);
    if (!directive || !documentURL) return null;

    let host: string;
    try {
      host = new URL(documentURL).hostname.toLowerCase().replace(/\.$/, '');
    } catch {
      return null;
    }
    const documentUrl = stripUrl(documentURL);
    if (!host || !documentUrl) return null;

    const { category, origin, blockedRaw } = classify(str(body.blockedURL), siteDomains);
    const sourceFile = str(body.sourceFile);
    const line = typeof body.lineNumber === 'number' && Number.isFinite(body.lineNumber) ? body.lineNumber : null;
    const ua = reduceUa(raw.userAgent);

    return {
      directive,
      origin,
      category,
      page: pathOf(documentURL),
      documentUrl,
      documentHost: host,
      blockedRaw,
      sourceFile: sourceFile ? stripUrl(sourceFile) : '',
      sample: cut(str(body.sample)),
      line,
      disposition: body.disposition === 'enforce' ? 'enforce' : 'report',
      ua: ua.label,
      isBot: ua.isBot,
    };
  } catch {
    return null;
  }
}
