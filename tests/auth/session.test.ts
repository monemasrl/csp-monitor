import { describe, expect, it } from 'vitest';
import { signSession, verifySession } from '../../src/auth/session.js';
import { LoginLimiter } from '../../src/auth/limiter.js';

const S = 's'.repeat(32);
describe('session', () => {
  it('accepts a valid token', () => {
    expect(verifySession(S, signSession(S, 2000), 1000)).toBe(true);
  });
  it('rejects expired, tampered, wrong-secret and malformed tokens', () => {
    const t = signSession(S, 2000);
    expect(verifySession(S, t, 2000)).toBe(false);
    expect(verifySession(S, t.replace('2000', '9999'), 1000)).toBe(false);
    expect(verifySession('o'.repeat(32), t, 1000)).toBe(false);
    expect(verifySession(S, t + 'x', 1000)).toBe(false);
    for (const bad of ['', 'abc', '.', '2000.', 'x.y']) expect(verifySession(S, bad, 1000)).toBe(false);
  });
});

describe('LoginLimiter', () => {
  const MIN = 60_000;
  it('blocks after 5 failures for 15 minutes', () => {
    const l = new LoginLimiter();
    for (let i = 0; i < 4; i++) l.fail('1.1.1.1', i * MIN);
    expect(l.blocked('1.1.1.1', 4 * MIN)).toBe(false);
    l.fail('1.1.1.1', 4 * MIN);
    expect(l.blocked('1.1.1.1', 4 * MIN)).toBe(true);
    expect(l.blocked('2.2.2.2', 4 * MIN)).toBe(false);
    expect(l.blocked('1.1.1.1', 19 * MIN - 1)).toBe(true);
    expect(l.blocked('1.1.1.1', 19 * MIN)).toBe(false);
  });
  it('forgets failures older than 15 minutes', () => {
    const l = new LoginLimiter();
    for (let i = 0; i < 4; i++) l.fail('a', 0);
    l.fail('a', 16 * MIN);
    expect(l.blocked('a', 16 * MIN)).toBe(false);
  });
  it('reset clears state', () => {
    const l = new LoginLimiter();
    for (let i = 0; i < 5; i++) l.fail('a', 0);
    l.reset('a');
    expect(l.blocked('a', 1)).toBe(false);
  });
});
