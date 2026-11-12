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

function build(url: string, directives: [string, string[]][]): string {
  const csp = [...directives.map(([d, s]) => `${d} ${s.join(' ')}`), `report-uri ${url}`, 'report-to csp'].join('; ');
  return `Reporting-Endpoints: csp="${url}"\nContent-Security-Policy-Report-Only: ${csp}`;
}

export function strictHeaders(baseUrl: string, key: string): string {
  return build(endpoint(baseUrl, key), BASE_DIRECTIVES);
}

/**
 * Like strictHeaders, plus approved patterns per directive (sorted, deduplicated, never
 * repeating a source already present). Directives absent from the base policy are added
 * before report-uri as `<directive> 'self' <patterns>`. Choice for object-src: approved
 * patterns replace `'none'` (keeping `'none'` next to a source would be invalid CSP).
 */
export function suggestedHeaders(
  baseUrl: string, key: string, approved: { directive: string; pattern: string }[],
): string {
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
  return build(endpoint(baseUrl, key), result);
}
