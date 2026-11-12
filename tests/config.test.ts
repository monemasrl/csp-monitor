import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { validEnv } from './helpers.js';

describe('loadConfig', () => {
  it('throws naming the missing variable', () => {
    expect(() => loadConfig({ BASE_URL: 'https://m.example.it' })).toThrow(/ADMIN_PASSWORD_HASH/);
  });
  it('rejects a short SESSION_SECRET', () => {
    expect(() => loadConfig(validEnv({ SESSION_SECRET: 'short' }))).toThrow(/SESSION_SECRET/);
  });
  it('applies defaults', () => {
    const c = loadConfig(validEnv());
    expect(c.port).toBe(3000);
    expect(c.dataDir).toBe('/data');
    expect(c.trustProxy).toBe(true);
    expect(c.secureCookies).toBe(true);
    expect(c.smtp.port).toBe(587);
    expect(c.smtp.secure).toBe(false);
  });
  it('reads overrides', () => {
    const c = loadConfig(validEnv({ PORT: '8080', TRUST_PROXY: '0', SMTP_SECURE: '1' }));
    expect(c.port).toBe(8080);
    expect(c.trustProxy).toBe(false);
    expect(c.smtp.secure).toBe(true);
  });
});
