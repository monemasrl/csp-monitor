import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/auth/password.js';

describe('password', () => {
  it('accepts the right password and rejects a wrong one', () => {
    const h = hashPassword('correct horse');
    expect(h).toMatch(/^scrypt\$16384\$[^$]+\$[^$]+$/);
    expect(Buffer.from(h.split('$')[2]!, 'base64')).toHaveLength(16);
    expect(Buffer.from(h.split('$')[3]!, 'base64')).toHaveLength(64);
    expect(verifyPassword('correct horse', h)).toBe(true);
    expect(verifyPassword('wrong', h)).toBe(false);
  });
  it('uses a fresh salt each time', () => {
    expect(hashPassword('a')).not.toBe(hashPassword('a'));
  });
  it('returns false on malformed stored values', () => {
    for (const s of ['', 'x', 'scrypt$salt$hash', 'scrypt$abc$AA==$AA==', 'bcrypt$16384$AA==$AA==', 'scrypt$16384$$']) {
      expect(verifyPassword('a', s)).toBe(false);
    }
  });
});
