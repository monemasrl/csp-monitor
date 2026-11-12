// Form validation for the dashboard. Error messages are shown to the user (Italian).
import { HEADER_FEATURES, type HeaderFeature } from '../headers.js';
import { normalizeOrigin } from '../match.js';

/** CSP fetch directives an approval can be created for by hand. */
export const FETCH_DIRECTIVES = [
  'default-src', 'script-src', 'style-src', 'img-src', 'font-src', 'connect-src', 'media-src',
  'object-src', 'frame-src', 'child-src', 'worker-src', 'manifest-src',
];

const PATTERN_SCHEMES = ['http', 'https', 'ws', 'wss'];
const DEFAULT_PORT: Record<string, string> = { http: '80', ws: '80', https: '443', wss: '443' };
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOST_RE = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})*$`);
const MAX_NAME = 100;
const MAX_DOMAINS = 50;

export type Result<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** Bare host to its ASCII (punycode) form; null for anything with a scheme, path, port, credentials or wildcard. */
function asciiHost(h: string): string | null {
  if (h === '' || /[\s/\\@?#:%*[\]]/.test(h)) return null;
  let host: string;
  try {
    host = new URL(`http://${h}`).hostname;
  } catch {
    return null;
  }
  return HOST_RE.test(host) ? host : null;
}

/** Site domain: `host` or `*.host` (no scheme, no path, no port). */
export function parseDomain(input: string): string | null {
  const d = input.trim().toLowerCase();
  const wild = d.startsWith('*.');
  const host = asciiHost(wild ? d.slice(2) : d);
  if (!host || (wild && !host.includes('.'))) return null;
  return wild ? `*.${host}` : host;
}

/**
 * Approval / noise pattern: an exact origin `scheme://host[:port]` or a wildcard `[scheme://]*.host[:port with scheme]`.
 * Returns the normalized form (lowercase, punycode, default port dropped) or null.
 */
export function parsePattern(input: string): string | null {
  const p = input.trim().toLowerCase();
  if (p === '' || p.length > 300 || /[\s@]/.test(p)) return null;
  const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*\.)?([^:/]+)(?::(\d{1,5}))?$/.exec(p);
  if (!m) return null;
  const [, scheme, wild, rawHost, port] = m;
  if (scheme !== undefined && !PATTERN_SCHEMES.includes(scheme)) return null;
  if (!scheme && (!wild || port !== undefined)) return null; // bare hosts are not accepted; ports need a scheme
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return null;
  const host = asciiHost(rawHost!);
  if (!host || (wild && !host.includes('.'))) return null;
  const portPart = port !== undefined && port.replace(/^0+/, '') !== DEFAULT_PORT[scheme!] ? `:${Number(port)}` : '';
  const out = `${scheme ? `${scheme}://` : ''}${wild ?? ''}${host}${portPart}`;
  if (!wild && normalizeOrigin(out) !== out) return null;
  return out;
}

/** Origins that can be approved as-is (they become CSP sources in the suggested header). */
export function isApprovableSource(origin: string): boolean {
  if (origin === 'data:' || origin === 'blob:') return true;
  const m = /^([a-z]+):\/\//.exec(origin);
  return m !== null && PATTERN_SCHEMES.includes(m[1]!) && normalizeOrigin(origin) === origin;
}

/** Same-site relative path only (`/x`), never `//host`, `/\host` or anything with whitespace/control characters. */
export function safeBack(v: unknown, fallback: string): string {
  if (typeof v !== 'string' || v.length > 512) return fallback;
  if (!v.startsWith('/') || v.startsWith('//') || v.includes('\\')) return fallback;
  // Whitespace and control characters (browsers drop tabs/newlines, turning '/\t/x' into '//x').
  for (const ch of v) {
    const code = ch.codePointAt(0)!;
    if (code <= 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) return fallback;
  }
  return v;
}

function positiveInt(v: string): number | null {
  if (!/^\d{1,9}$/.test(v.trim())) return null;
  const n = Number(v.trim());
  return n > 0 ? n : null;
}

export function parseEmail(v: string): string | null {
  const e = v.trim();
  return e.length <= 254 && /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/.test(e) ? e : null;
}

const MAX_PATH = 200;
const MAX_PATHS = 50;

/** One path prefix per line: must start with '/', blank lines ignored, duplicates dropped. */
export function parsePaths(text: string): Result<string[]> {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length > MAX_PATHS) return { ok: false, errors: [`Al massimo ${MAX_PATHS} pagine sensibili.`] };
  const bad = lines.filter(l => !l.startsWith('/') || l.length > MAX_PATH || /[\s\p{C}]/u.test(l));
  if (bad.length > 0) {
    return { ok: false, errors: [`Pagina sensibile non valida: ${bad.map(b => b.slice(0, 40)).join(', ')} (deve iniziare con / e avere al massimo ${MAX_PATH} caratteri).`] };
  }
  return { ok: true, value: [...new Set(lines)] };
}

/** Checked header features from the form; unknown values are ignored ('csp' is always on). */
export function parseFeatures(values: string[]): HeaderFeature[] {
  const on = new Set(values);
  return HEADER_FEATURES.filter(f => f === 'csp' || on.has(f));
}

export type SiteInput = {
  name: string; domains: string[]; ratePerMin?: number; ratePerDay?: number; sensitivePaths?: string[];
};
export type SiteForm = {
  name: string; domains: string; rate_per_min?: string; rate_per_day?: string;
  sensitive_paths?: string; features?: string[];
};

export function parseSiteForm(f: SiteForm, withCaps: boolean): Result<SiteInput> {
  const errors: string[] = [];
  const name = f.name.trim();
  if (!name) errors.push('Il nome è obbligatorio.');
  else if (name.length > MAX_NAME) errors.push(`Il nome può avere al massimo ${MAX_NAME} caratteri.`);

  const lines = f.domains.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const domains: string[] = [];
  if (lines.length === 0) errors.push('Indica almeno un dominio.');
  else if (lines.length > MAX_DOMAINS) errors.push(`Al massimo ${MAX_DOMAINS} domini.`);
  else {
    const bad = lines.filter(l => parseDomain(l) === null);
    if (bad.length > 0) errors.push(`Dominio non valido: ${bad.join(', ')} (usa solo l'host, per esempio example.it o *.example.it).`);
    for (const l of lines) {
      const d = parseDomain(l);
      if (d && !domains.includes(d)) domains.push(d);
    }
  }

  const value: SiteInput = { name, domains };
  if (withCaps) {
    const perMin = positiveInt(f.rate_per_min ?? '');
    const perDay = positiveInt(f.rate_per_day ?? '');
    if (perMin === null) errors.push('Il tetto al minuto deve essere un numero intero positivo.');
    if (perDay === null) errors.push('Il tetto al giorno deve essere un numero intero positivo.');
    value.ratePerMin = perMin ?? undefined;
    value.ratePerDay = perDay ?? undefined;
    const paths = parsePaths(f.sensitive_paths ?? '');
    if (!paths.ok) errors.push(...paths.errors);
    else value.sensitivePaths = paths.value;
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}
