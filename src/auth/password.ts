import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const N = 16384;
const KEYLEN = 64;

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(pw, salt, KEYLEN, { N });
  return `scrypt$${N}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** Never throws: any malformed stored value simply fails verification. */
export function verifyPassword(pw: string, stored: string): boolean {
  try {
    const [scheme, n, saltB64, hashB64, extra] = stored.split('$');
    if (scheme !== 'scrypt' || extra !== undefined || !n || !saltB64 || !hashB64) return false;
    const cost = Number(n);
    if (!Number.isInteger(cost) || cost < 2 || cost > 1 << 20) return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    if (salt.length === 0 || expected.length === 0) return false;
    const actual = scryptSync(pw, salt, expected.length, { N: cost });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
