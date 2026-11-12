import { describe, it, expect } from 'vitest';
import { strictHeaders, suggestedHeaders } from '../src/headers.js';

const expected = (host: string, key: string) =>
  `Reporting-Endpoints: csp="https://${host}/r/${key}"\n` +
  `Content-Security-Policy-Report-Only: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; form-action 'self'; object-src 'none'; base-uri 'self'; report-uri https://${host}/r/${key}; report-to csp`;

describe('strictHeaders', () => {
  it('matches the spec example byte for byte', () => {
    expect(strictHeaders('https://m.example.it', 'AbC123')).toBe(expected('m.example.it', 'AbC123'));
  });
  it('tolerates trailing slash and path', () => {
    expect(strictHeaders('https://m.example.it/', 'k')).toBe(expected('m.example.it', 'k'));
  });
});

describe('suggestedHeaders', () => {
  const base = 'https://m.example.it';
  it('equals strict with no approvals', () => {
    expect(suggestedHeaders(base, 'k', [])).toBe(strictHeaders(base, 'k'));
  });
  it('appends approved patterns to an existing directive', () => {
    const out = suggestedHeaders(base, 'k', [{ directive: 'script-src', pattern: 'https://www.googletagmanager.com' }]);
    expect(out).toContain("script-src 'self' https://www.googletagmanager.com;");
    expect(out.split('\n')[0]).toBe(expected('m.example.it', 'k').split('\n')[0]);
  });
  it('sorts, dedups and skips sources already present', () => {
    const out = suggestedHeaders(base, 'k', [
      { directive: 'img-src', pattern: 'https://b.it' },
      { directive: 'img-src', pattern: 'https://a.it' },
      { directive: 'img-src', pattern: 'https://b.it' },
      { directive: 'img-src', pattern: 'data:' },
    ]);
    expect(out).toContain("img-src 'self' data: https://a.it https://b.it;");
  });
  it('adds unknown directives before report-uri', () => {
    const out = suggestedHeaders(base, 'k', [{ directive: 'media-src', pattern: 'https://v.it' }]);
    expect(out).toContain("base-uri 'self'; media-src 'self' https://v.it; report-uri https://m.example.it/r/k;");
  });
  it("replaces 'none' for object-src", () => {
    const out = suggestedHeaders(base, 'k', [{ directive: 'object-src', pattern: 'https://o.it' }]);
    expect(out).toContain('object-src https://o.it;');
    expect(out).not.toContain("object-src 'none'");
  });
});
