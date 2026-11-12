import { describe, expect, it } from 'vitest';
import type { RawReport } from '../../src/ingest/parse.js';
import { toCspEvent } from '../../src/ingest/csp.js';

const SITE = ['gida-spa.it', '*.gida-spa.it'];
const report = (body: Record<string, unknown> = {}, extra: Partial<RawReport> = {}): RawReport => ({
  type: 'csp-violation',
  body: { documentURL: 'https://www.gida-spa.it/shop/p?x=1', effectiveDirective: 'script-src', blockedURL: 'https://cdn.evil.com/a.js', ...body },
  ...extra,
});
const ev = (body: Record<string, unknown> = {}, extra: Partial<RawReport> = {}) => toCspEvent(report(body, extra), SITE)!;

describe('toCspEvent', () => {
  it('returns null without documentURL or directive', () => {
    expect(toCspEvent(report({ documentURL: undefined }), SITE)).toBeNull();
    expect(toCspEvent(report({ documentURL: 'nonsense' }), SITE)).toBeNull();
    expect(toCspEvent(report({ effectiveDirective: undefined }), SITE)).toBeNull();
    expect(toCspEvent(report({ documentURL: 42, effectiveDirective: {} }), SITE)).toBeNull();
  });

  it('takes the directive from effectiveDirective, else first token of violatedDirective', () => {
    expect(ev().directive).toBe('script-src');
    expect(ev({ effectiveDirective: undefined, violatedDirective: "img-src 'self' https:" }).directive).toBe('img-src');
  });

  it('strips -elem / -attr suffixes', () => {
    expect(ev({ effectiveDirective: 'script-src-elem' }).directive).toBe('script-src');
    expect(ev({ effectiveDirective: 'style-src-attr' }).directive).toBe('style-src');
  });

  it('classifies inline and empty blockedURL', () => {
    expect(ev({ blockedURL: 'inline' })).toMatchObject({ category: 'inline', origin: 'inline' });
    expect(ev({ blockedURL: '' })).toMatchObject({ category: 'inline', origin: 'inline' });
    expect(ev({ blockedURL: undefined })).toMatchObject({ category: 'inline', origin: 'inline' });
  });

  it('classifies eval and wasm-eval', () => {
    expect(ev({ blockedURL: 'eval' })).toMatchObject({ category: 'eval', origin: 'eval' });
    expect(ev({ blockedURL: 'wasm-eval' })).toMatchObject({ category: 'eval', origin: 'eval' });
  });

  it('classifies data and blob', () => {
    expect(ev({ blockedURL: 'data' })).toMatchObject({ category: 'data', origin: 'data:' });
    expect(ev({ blockedURL: 'data:image/png;base64,AAAA' })).toMatchObject({ category: 'data', origin: 'data:' });
    expect(ev({ blockedURL: 'blob' })).toMatchObject({ category: 'blob', origin: 'blob:' });
    expect(ev({ blockedURL: 'blob:https://www.gida-spa.it/uuid' })).toMatchObject({ category: 'blob', origin: 'blob:' });
  });

  it('classifies absolute URLs as external or self', () => {
    expect(ev({ blockedURL: 'https://CDN.Evil.com:443/a.js?k=1' })).toMatchObject({
      category: 'external', origin: 'https://cdn.evil.com', blockedRaw: 'https://cdn.evil.com/a.js',
    });
    expect(ev({ blockedURL: 'https://gida-spa.it/a.js' })).toMatchObject({ category: 'self', origin: 'https://gida-spa.it' });
  });

  it('keeps extension schemes visible as external', () => {
    for (const s of ['chrome-extension', 'moz-extension', 'safari-extension', 'safari-web-extension', 'ms-browser-extension', 'webkit-masked-url']) {
      const e = ev({ blockedURL: `${s}://abcdef/content.js?q=1` });
      expect(e.category).toBe('external');
      expect(e.origin).toBe(`${s}:`);
      expect(e.blockedRaw.startsWith(`${s}:`)).toBe(true);
      expect(e.blockedRaw).not.toContain('?');
    }
  });

  it('treats any other value as external, truncated to 200 chars', () => {
    const e = ev({ blockedURL: 'x'.repeat(300) });
    expect(e.category).toBe('external');
    expect(e.origin).toHaveLength(200);
    expect(e.blockedRaw).toHaveLength(200);
    expect(ev({ blockedURL: 'about:blank' })).toMatchObject({ category: 'external', origin: 'about:blank' });
  });

  it('derives page, documentUrl and documentHost', () => {
    expect(ev({ documentURL: 'https://WWW.Gida-SPA.it./shop/p?x=1#h' })).toMatchObject({
      page: '/shop/p', documentUrl: 'https://www.gida-spa.it./shop/p', documentHost: 'www.gida-spa.it',
    });
  });

  it('strips sourceFile, truncates sample, and defaults disposition to report', () => {
    const e = ev({ sourceFile: 'https://u:p@a.it/x.js?v=1', sample: 's'.repeat(300) });
    expect(e.sourceFile).toBe('https://a.it/x.js');
    expect(e.sample).toHaveLength(200);
    expect(e.disposition).toBe('report');
    expect(ev({ disposition: 'enforce' }).disposition).toBe('enforce');
    expect(ev({ disposition: 'ENFORCE!' }).disposition).toBe('report');
    expect(ev().sourceFile).toBe('');
    expect(ev().sample).toBe('');
  });

  it('coerces lineNumber to number or null', () => {
    expect(ev({ lineNumber: 12 }).line).toBe(12);
    expect(ev({ lineNumber: '12' }).line).toBeNull();
    expect(ev().line).toBeNull();
  });

  it('reduces the user agent', () => {
    const e = ev({}, { userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1)' });
    expect(e.isBot).toBe(true);
    expect(e.ua).toBe('Altro');
  });

  it('treats subdomains of the site as self', () => {
    const e = toCspEvent(report({ blockedURL: 'https://media.gida-spa.it/a.jpg', effectiveDirective: 'img-src' }), ['gida-spa.it', '*.gida-spa.it'])!;
    expect(e).toMatchObject({ category: 'self', origin: 'https://media.gida-spa.it', directive: 'img-src' });
  });

  it('never keeps query strings', () => {
    const e = toCspEvent(report({ documentURL: 'https://www.gida-spa.it/p?token=abc', sourceFile: 'https://www.gida-spa.it/a.js?v=1' }), ['*.gida-spa.it'])!;
    expect(e.documentUrl).toBe('https://www.gida-spa.it/p'); expect(e.sourceFile).toBe('https://www.gida-spa.it/a.js');
  });
});
