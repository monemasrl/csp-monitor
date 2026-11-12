const WEB_SCHEMES = ['http', 'https', 'ws', 'wss'];

const NETWORK_SCHEMES = [...WEB_SCHEMES, 'ftp'];

const RISKY_BASES = [
  'cloudfront.net', 'googleusercontent.com', 'workers.dev', 'pages.dev', 'vercel.app', 'netlify.app',
  'herokuapp.com', 'github.io', 'azurewebsites.net', 'blob.core.windows.net', 's3.amazonaws.com',
  'appspot.com', 'firebaseapp.com', 'web.app',
];

function cleanHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, '');
}

/** scheme://host[:port], lowercase, punycode host, default port omitted; null if not an absolute URL with a host. */
export function normalizeOrigin(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = cleanHost(u.hostname);
  const scheme = u.protocol.slice(0, -1);
  // Only network schemes; data:, blob:, about: and extension schemes are the caller's business.
  if (!host || !NETWORK_SCHEMES.includes(scheme)) return null;
  // URL.host drops default ports for special schemes (http, https, ws, wss, ftp, file).
  return `${scheme}://${host}${u.port ? ':' + u.port : ''}`;
}

export function stripUrl(url: string): string {
  try {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return '';
  }
}

export function pathOf(url: string): string {
  try {
    return new URL(url).pathname || '/';
  } catch {
    return '/';
  }
}

/** Same rules for hosts: exact, or `*.base` matching strictly deeper subdomains on label boundaries. */
function hostMatches(patternHost: string, host: string): boolean {
  const p = cleanHost(patternHost);
  const h = cleanHost(host);
  if (p.startsWith('*.')) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
  return p === h;
}

export function matchesPattern(pattern: string, origin: string): boolean {
  const o = normalizeOrigin(origin);
  if (!o) return false;
  const oUrl = new URL(o);
  const oScheme = oUrl.protocol.slice(0, -1);
  const m = /^([a-z][a-z0-9+.-]*):\/\/(.+)$/i.exec(pattern.trim());
  if (!m) {
    // No scheme: applies to http/https/ws/wss, any port-less host form.
    if (!WEB_SCHEMES.includes(oScheme)) return false;
    return hostMatches(pattern.trim(), oUrl.hostname) && !oUrl.port;
  }
  if (m[1]!.toLowerCase() !== oScheme) return false;
  const rest = m[2]!;
  if (rest.startsWith('*.')) {
    const sub = new URL(`${oScheme}://x.${rest.slice(2)}`);
    const base = cleanHost(sub.hostname).slice(2);
    if (sub.port && sub.port !== oUrl.port) return false;
    return hostMatches('*.' + base, oUrl.hostname);
  }
  const p = normalizeOrigin(`${m[1]!.toLowerCase()}://${rest}`);
  return p !== null && p === o;
}

export function hostMatchesDomains(host: string, domains: string[]): boolean {
  return domains.some(d => hostMatches(d, host));
}

export function isRiskyWildcard(pattern: string): boolean {
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?\*\.([^/:]+)/i.exec(pattern.trim());
  if (!m) return false;
  const base = cleanHost(m[1]!);
  return RISKY_BASES.some(r => base === r || base.endsWith('.' + r));
}
