import { describe, it, expect } from 'vitest';
import { strictHeaders, suggestedHeaders, buildHeaderSet, type HeaderFeature } from '../src/headers.js';

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

describe('buildHeaderSet', () => {
  const base = 'https://m.example.it';
  const ep = 'https://m.example.it/r/k';
  const one = (f: HeaderFeature, approved: { directive: string; pattern: string }[] = []) =>
    buildHeaderSet(base, 'k', [f], approved).slice(1).map((h) => `${h.name}: ${h.value}`);

  it('always starts with Reporting-Endpoints (csp and default)', () => {
    const [first] = buildHeaderSet(base, 'k', [], []);
    expect(first.name).toBe('Reporting-Endpoints');
    expect(first.value).toBe(`csp="${ep}", default="${ep}"`);
    expect(first.note).toMatch(/\S/);
  });
  it('csp is only the strict Report-Only policy, equal to strictHeaders', () => {
    const h = buildHeaderSet(base, 'k', ['csp'], []);
    expect(h).toHaveLength(2);
    expect(`${h[0].name}: ${h[0].value}\n${h[1].name}: ${h[1].value}`.replace('csp="https://m.example.it/r/k", default="https://m.example.it/r/k"', 'csp="https://m.example.it/r/k"'))
      .toBe(strictHeaders(base, 'k'));
  });
  it('csp uses the suggested policy when approvals exist', () => {
    const approved = [{ directive: 'img-src', pattern: 'https://cdn.example' }];
    expect(one('csp', approved)[0]).toBe(suggestedHeaders(base, 'k', approved).split('\n')[1]);
  });
  it('csp-hash adds report-sha256 to script-src', () => {
    const v = buildHeaderSet(base, 'k', ['csp', 'csp-hash'], []).find((h) => h.name === 'Content-Security-Policy-Report-Only')!.value;
    expect(v).toContain("script-src 'self' 'report-sha256';");
  });
  it('csp-hash alone adds nothing without csp', () => {
    expect(buildHeaderSet(base, 'k', ['csp-hash'], [])).toHaveLength(1);
  });
  it('nel', () => {
    expect(one('nel')).toEqual([
      `Report-To: {"group":"nel","max_age":2592000,"endpoints":[{"url":"${ep}"}]}`,
      'NEL: {"report_to":"nel","max_age":2592000,"failure_fraction":1.0,"success_fraction":0.01}',
    ]);
  });
  it('permissions', () => {
    expect(one('permissions')).toEqual(['Permissions-Policy-Report-Only: camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), display-capture=()']);
  });
  it('coop', () => { expect(one('coop')).toEqual(['Cross-Origin-Opener-Policy-Report-Only: same-origin; report-to="default"']); });
  it('coep', () => { expect(one('coep')).toEqual(['Cross-Origin-Embedder-Policy-Report-Only: require-corp; report-to="default"']); });
  it('document', () => { expect(one('document')).toEqual(['Document-Policy-Report-Only: sync-xhr=?0']); });
  it('integrity', () => { expect(one('integrity')).toEqual(['Integrity-Policy-Report-Only: blocked-destinations=(script), endpoints=(default)']); });
  it('connection is marked experimental', () => {
    const h = buildHeaderSet(base, 'k', ['connection'], []).slice(1);
    expect(h.map((x) => `${x.name}: ${x.value}`)).toEqual(['Connection-Allowlist-Report-Only: (response-origin); report-to=default']);
    expect(h[0].note).toMatch(/[Ss]perimentale/);
  });
  it('every entry has an Italian note', () => {
    const all: HeaderFeature[] = ['csp', 'csp-hash', 'nel', 'permissions', 'coop', 'coep', 'document', 'integrity', 'connection'];
    for (const h of buildHeaderSet(base, 'k', all, [])) expect(h.note.length).toBeGreaterThan(10);
  });
});
