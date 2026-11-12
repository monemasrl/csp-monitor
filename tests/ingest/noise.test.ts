import { describe, expect, it } from 'vitest';
import { toCspEvent } from '../../src/ingest/csp.js';
import { BUILTIN_NOISE, classifyNoise } from '../../src/ingest/noise.js';
import type { RawReport } from '../../src/ingest/parse.js';

const SITE = ['gida-spa.it', '*.gida-spa.it'];
const BOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const event = (body: Record<string, unknown> = {}, extra: Partial<RawReport> = {}) =>
  toCspEvent(
    {
      type: 'csp-violation',
      body: { documentURL: 'https://www.gida-spa.it/shop', effectiveDirective: 'script-src', blockedURL: 'https://cdn.evil.com/a.js', ...body },
      ...extra,
    },
    SITE,
  )!;
const classify = (e: ReturnType<typeof event>, extra: string[] = []) => classifyNoise(e, SITE, extra);

describe('classifyNoise', () => {
  it('returns null for a clean report', () => {
    expect(classify(event())).toBeNull();
  });

  it('extension: extension scheme in blockedURL', () => {
    expect(classify(event({ blockedURL: 'chrome-extension://abcdef/inject.js' }))).toBe('extension');
  });

  it('extension: moz-extension sourceFile with a normal external blockedURL', () => {
    expect(classify(event({ sourceFile: 'moz-extension://1234-5678/content.js' }))).toBe('extension');
  });

  it('foreign-document: translate.goog proxy page', () => {
    expect(classify(event({ documentURL: 'https://www-gida--spa-it.translate.goog/' }))).toBe('foreign-document');
  });

  it('bot: report from a crawler', () => {
    expect(classify(event({}, { userAgent: BOT_UA }))).toBe('bot');
  });

  it('known-noise: built-in pattern', () => {
    expect(classify(event({ blockedURL: 'https://gc.kis.v2.scr.kaspersky-labs.com/x.js' }))).toBe('known-noise');
    expect(classify(event({ blockedURL: 'https://translate.googleapis.com/t.js' }))).toBe('known-noise');
  });

  it('known-noise: extraPatterns', () => {
    const e = event({ blockedURL: 'https://noisy.example.org/a.js' });
    expect(classify(e)).toBeNull();
    expect(classify(e, ['*.example.org'])).toBe('known-noise');
  });

  it('does not treat inline/eval events as known-noise', () => {
    expect(classify(event({ blockedURL: 'inline' }), ['*'])).toBeNull();
  });

  it('ordering: extension from a foreign document is extension', () => {
    const e = event({ documentURL: 'https://www-gida--spa-it.translate.goog/', blockedURL: 'moz-extension://x/a.js' });
    expect(classify(e)).toBe('extension');
  });

  it('ordering: foreign document beats bot; bot beats known-noise', () => {
    const foreign = event({ documentURL: 'https://other.com/' }, { userAgent: BOT_UA });
    expect(classify(foreign)).toBe('foreign-document');
    const bot = event({ blockedURL: 'https://x.kaspersky-labs.com/a.js' }, { userAgent: BOT_UA });
    expect(classify(bot)).toBe('bot');
  });

  it('BUILTIN_NOISE is non-empty', () => {
    expect(BUILTIN_NOISE.length).toBeGreaterThan(0);
  });
});
