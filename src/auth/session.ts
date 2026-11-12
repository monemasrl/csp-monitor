import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'cspm_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function mac(secret: string, expiresAt: string): string {
  return createHmac('sha256', secret).update(expiresAt).digest('base64url');
}

export function signSession(secret: string, expiresAt: number): string {
  const e = String(expiresAt);
  return `${e}.${mac(secret, e)}`;
}

export function verifySession(secret: string, token: string, now: number): boolean {
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const e = token.slice(0, dot);
  if (!/^\d+$/.test(e)) return false;
  const given = Buffer.from(token.slice(dot + 1));
  const want = Buffer.from(mac(secret, e));
  if (given.length !== want.length || !timingSafeEqual(given, want)) return false;
  return Number(e) > now;
}
