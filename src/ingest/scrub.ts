/** Body keys that carry an IP address (compared lowercase, without `_`/`-`). */
const IP_KEYS = new Set(['serverip', 'clientip', 'remoteip', 'ip', 'ipaddress', 'remoteaddress']);
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/;
const IPV6 = /^\[?[0-9a-f]*:[0-9a-f:.]*\]?$/i;

const isIp = (v: unknown): boolean => typeof v === 'string' && (IPV4.test(v.trim()) || (v.includes(':') && IPV6.test(v.trim())));

/** Copy of a report body without IP addresses: fields named like an IP, and values that are a bare IP literal. */
export function dropIps(v: unknown): unknown {
  if (Array.isArray(v)) return v.filter(x => !isIp(x)).map(dropIps);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v)
        .filter(([k, x]) => !IP_KEYS.has(k.toLowerCase().replace(/[-_]/g, '')) && !isIp(x))
        .map(([k, x]) => [k, dropIps(x)]),
    );
  }
  return v;
}
