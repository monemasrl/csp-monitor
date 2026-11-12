// Starting policy (spec section 1). Order matters: it is reproduced byte for byte.
const BASE_DIRECTIVES: [string, string[]][] = [
  ['default-src', ["'self'"]],
  ['script-src', ["'self'"]],
  ['style-src', ["'self'"]],
  ['img-src', ["'self'", 'data:']],
  ['font-src', ["'self'", 'data:']],
  ['connect-src', ["'self'"]],
  ['frame-src', ["'self'"]],
  ['form-action', ["'self'"]],
  ['object-src', ["'none'"]],
  ['base-uri', ["'self'"]],
];

function endpoint(baseUrl: string, key: string): string {
  return `${new URL(baseUrl).origin}/r/${key}`;
}

function policy(url: string, directives: [string, string[]][]): string {
  return [...directives.map(([d, s]) => `${d} ${s.join(' ')}`), `report-uri ${url}`, 'report-to csp'].join('; ');
}

/** `default` is the endpoint of every report-to-less header (crash, deprecation, intervention, COOP...). */
function endpoints(url: string): string {
  return `csp="${url}", default="${url}"`;
}

export type CspOptions = { reportSha256?: boolean };

/** csp-hash: 'report-sha256' (CSP3 spec, https://w3c.github.io/webappsec-csp/#grammardef-report-sha256) makes Chrome send csp-hash reports. */
function withHash(directives: [string, string[]][], opts: CspOptions): [string, string[]][] {
  return opts.reportSha256
    ? directives.map(([d, s]): [string, string[]] => (d === 'script-src' ? [d, [...s, "'report-sha256'"]] : [d, s]))
    : directives;
}

function build(url: string, directives: [string, string[]][]): string {
  return `Reporting-Endpoints: ${endpoints(url)}\nContent-Security-Policy-Report-Only: ${policy(url, directives)}`;
}

export function strictHeaders(baseUrl: string, key: string, opts: CspOptions = {}): string {
  return build(endpoint(baseUrl, key), withHash(BASE_DIRECTIVES, opts));
}

/**
 * Like strictHeaders, plus approved patterns per directive (sorted, deduplicated, never
 * repeating a source already present). Directives absent from the base policy are added
 * before report-uri as `<directive> 'self' <patterns>`. Choice for object-src: approved
 * patterns replace `'none'` (keeping `'none'` next to a source would be invalid CSP).
 */
export function suggestedHeaders(
  baseUrl: string, key: string, approved: { directive: string; pattern: string }[], opts: CspOptions = {},
): string {
  return build(endpoint(baseUrl, key), withHash(suggestedDirectives(approved), opts));
}

function suggestedDirectives(approved: { directive: string; pattern: string }[]): [string, string[]][] {
  const byDirective = new Map<string, Set<string>>();
  for (const { directive, pattern } of approved) {
    if (!byDirective.has(directive)) byDirective.set(directive, new Set());
    byDirective.get(directive)!.add(pattern);
  }
  const extra = (d: string, existing: string[]): string[] =>
    [...(byDirective.get(d) ?? [])].filter((p) => !existing.includes(p)).sort();

  const result: [string, string[]][] = BASE_DIRECTIVES.map(([d, sources]) => {
    const add = extra(d, sources);
    if (add.length === 0) return [d, sources];
    return [d, sources.includes("'none'") ? add : [...sources, ...add]];
  });
  const known = new Set(BASE_DIRECTIVES.map(([d]) => d));
  for (const d of [...byDirective.keys()].sort()) {
    if (known.has(d)) continue;
    result.push([d, ["'self'", ...extra(d, ["'self'"])]]);
  }
  return result;
}

export const HEADER_FEATURES = ['csp', 'csp-hash', 'nel', 'permissions', 'coop', 'coep', 'document', 'integrity', 'connection'] as const;
export type HeaderFeature = (typeof HEADER_FEATURES)[number];

export type HeaderEntry = { name: string; value: string; note: string };

/**
 * Headers the site owner should add, one entry per header line, for the enabled features.
 * Each string carries its source next to it; `default` is the implicit endpoint used by
 * report-to-less headers. The COOP, COEP, Integrity-Policy and Document-Policy Report-Only
 * strings were verified by real Chrome 157 / Safari 27 reports on a test site.
 */
export function buildHeaderSet(
  baseUrl: string, key: string, enabled: HeaderFeature[], approved: { directive: string; pattern: string }[],
): HeaderEntry[] {
  const ep = endpoint(baseUrl, key);
  const on = new Set(enabled);
  const out: HeaderEntry[] = [{
    name: 'Reporting-Endpoints', value: endpoints(ep),
    note: 'Definisce dove i browser inviano i report: va sempre inviato insieme agli altri header.',
  }];
  if (on.has('csp')) {
    const directives = withHash(suggestedDirectives(approved), { reportSha256: on.has('csp-hash') });
    out.push({
      name: 'Content-Security-Policy-Report-Only', value: policy(ep, directives),
      note: 'Policy CSP in sola segnalazione: nessun blocco, i browser moderni la supportano tutti.',
    });
  }
  if (on.has('nel')) {
    // Legacy Report-To still needed for NEL in Chrome: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/NEL
    out.push({
      name: 'Report-To', value: `{"group":"nel","max_age":2592000,"endpoints":[{"url":"${ep}"}]}`,
      note: 'Gruppo di destinazione per NEL: oggi solo Chrome ed Edge lo usano.',
    }, {
      name: 'NEL', value: '{"report_to":"nel","max_age":2592000,"failure_fraction":1.0,"success_fraction":0.01}',
      note: 'Errori di rete visti dai visitatori: oggi solo Chrome ed Edge; campiona l\'1% dei successi.',
    });
  }
  if (on.has('permissions')) {
    // https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Permissions-Policy
    // No report-to: MDN documents per-member `;report-to=name`, omitted => `default` endpoint (verified on Chrome).
    out.push({
      name: 'Permissions-Policy-Report-Only',
      value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), display-capture=()',
      note: 'Segnala l\'uso di funzioni sensibili: oggi solo Chrome ed Edge.',
    });
  }
  if (on.has('coop')) {
    // https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Opener-Policy (verified on Chrome 157)
    out.push({
      name: 'Cross-Origin-Opener-Policy-Report-Only', value: 'same-origin; report-to="default"',
      note: 'Mostra cosa si romperebbe isolando la finestra: Chrome, Edge e Firefox.',
    });
  }
  if (on.has('coep')) {
    // https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Embedder-Policy (verified on Chrome 157 / Safari 27)
    out.push({
      name: 'Cross-Origin-Embedder-Policy-Report-Only', value: 'require-corp; report-to="default"',
      note: 'Segnala le risorse esterne senza CORP: Chrome, Edge e Safari; attenzione al rumore dei servizi di terze parti.',
    });
  }
  if (on.has('document')) {
    // https://wicg.github.io/document-policy/ ; oversized-images/unsized-media are not shipped, sync-xhr=?0 is (verified on Chrome 157).
    out.push({
      name: 'Document-Policy-Report-Only', value: 'sync-xhr=?0',
      note: 'Segnala le chiamate XHR sincrone: oggi solo Chrome ed Edge.',
    });
  }
  if (on.has('integrity')) {
    // https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Integrity-Policy (verified on Chrome 157)
    out.push({
      name: 'Integrity-Policy-Report-Only', value: 'blocked-destinations=(script), endpoints=(default)',
      note: 'Segnala gli script senza attributo integrity: Chrome ed Edge; gli script di terze parti daranno molti risultati.',
    });
  }
  if (on.has('connection')) {
    // WICG Connection-Allowlist explainer, https://github.com/WICG/connection-allowlists ; draft, syntax may change.
    out.push({
      name: 'Connection-Allowlist-Report-Only', value: '(response-origin); report-to=default',
      note: 'Sperimentale: il formato può cambiare e pochi browser lo supportano.',
    });
  }
  return out;
}
