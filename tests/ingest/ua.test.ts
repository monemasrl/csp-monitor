import { describe, it, expect } from 'vitest';
import { reduceUa } from '../../src/ingest/ua.js';

const CHROME_131_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const SAFARI_18 = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15';
const FIREFOX_133 = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0';
const EDGE_131 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.70';
const CHROME_ANDROID_131 = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

describe('reduceUa', () => {
  it('reduces browsers to family + major', () => {
    expect(reduceUa(CHROME_131_MAC)).toEqual({ label: 'Chrome 131', isBot: false });
    expect(reduceUa(SAFARI_18)).toEqual({ label: 'Safari 18', isBot: false });
    expect(reduceUa(FIREFOX_133)).toEqual({ label: 'Firefox 133', isBot: false });
    expect(reduceUa(EDGE_131)).toEqual({ label: 'Edge 131', isBot: false });
    expect(reduceUa(CHROME_ANDROID_131)).toEqual({ label: 'Chrome Android 131', isBot: false });
  });
  it('detects bots case-insensitively', () => {
    expect(reduceUa(GOOGLEBOT)).toMatchObject({ isBot: true });
    expect(reduceUa('Mozilla/5.0 HeadlessChrome/131.0.0.0')).toMatchObject({ isBot: true });
    expect(reduceUa('curl/8.4.0')).toEqual({ label: 'Altro', isBot: true });
    expect(reduceUa('SomeCRAWLER/1.0').isBot).toBe(true);
  });
  it('falls back to Altro', () => {
    expect(reduceUa(undefined)).toEqual({ label: 'Altro', isBot: false });
    expect(reduceUa('')).toEqual({ label: 'Altro', isBot: false });
  });
});
