export type RawReport = {
  type: string;
  url?: string;
  userAgent?: string;
  body: Record<string, unknown>;
};

// Legacy `report-uri` keys that differ from the Reporting API names.
// Any other kebab-case key is converted to camelCase generically.
const LEGACY_KEYS: Record<string, string> = {
  'document-uri': 'documentURL',
  'blocked-uri': 'blockedURL',
  'script-sample': 'sample',
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function camelCase(key: string): string {
  return key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function fromLegacy(value: unknown): RawReport[] {
  if (!isObject(value) || !isObject(value['csp-report'])) return [];
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value['csp-report'])) {
    body[LEGACY_KEYS[k] ?? camelCase(k)] = v;
  }
  return [{ type: 'csp-violation', body }];
}

function fromReportingApi(value: unknown): RawReport[] {
  if (!Array.isArray(value)) return [];
  const out: RawReport[] = [];
  for (const entry of value) {
    if (!isObject(entry) || typeof entry.type !== 'string' || !isObject(entry.body)) continue;
    const r: RawReport = { type: entry.type, body: entry.body };
    if (typeof entry.url === 'string') r.url = entry.url;
    if (typeof entry.user_agent === 'string') r.userAgent = entry.user_agent;
    out.push(r);
  }
  return out;
}

/**
 * Never throws; invalid input yields []. The format is read from the body, not from the content type:
 * browsers do not agree (Safari 27 sends a single Reporting API object as application/csp-report).
 * - array → Reporting API batch;
 * - object with "csp-report" → legacy report-uri;
 * - object with "type" and "body" → single Reporting API report.
 */
export function parseBody(_contentType: string | undefined, text: string): RawReport[] {
  try {
    const value: unknown = JSON.parse(text);
    if (Array.isArray(value)) return fromReportingApi(value);
    if (isObject(value) && 'csp-report' in value) return fromLegacy(value);
    return fromReportingApi([value]);
  } catch {
    return [];
  }
}
