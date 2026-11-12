import { describe, it, expect } from 'vitest';
import { normalizeOrigin, stripUrl, pathOf, matchesPattern, hostMatchesDomains, isRiskyWildcard } from '../src/match.js';

describe('normalizeOrigin', () => {
  it.each([
    'HTTPS://CDN.Example.com:443/x?y=1#z', 'https://cdn.example.com./', 'https://user:pw@cdn.example.com/a',
  ])('normalizes %s', u => expect(normalizeOrigin(u)).toBe('https://cdn.example.com'));
  it('keeps non-default ports and converts IDN', () => {
    expect(normalizeOrigin('https://cdn.example.com:8443/a')).toBe('https://cdn.example.com:8443');
    expect(normalizeOrigin('https://bücher.example/')).toBe('https://xn--bcher-kva.example');
  });
  it('omits default ports for ws/wss', () => {
    expect(normalizeOrigin('wss://a.example.com:443/s')).toBe('wss://a.example.com');
    expect(normalizeOrigin('ws://a.example.com:80/s')).toBe('ws://a.example.com');
  });
  it.each(['inline', 'eval', '', 'data', '/relative/path', 'about', 'data:text/plain,x', 'blob:https://a.com/uuid', 'about:blank', 'chrome-extension://abc/x.js'])(
    'returns null for %s', v => expect(normalizeOrigin(v)).toBeNull());
});

describe('stripUrl / pathOf', () => {
  it('strips query and fragment', () => {
    expect(stripUrl('https://a.it/p?email=x@y.it#f')).toBe('https://a.it/p');
    expect(stripUrl('not a url')).toBe('');
    expect(stripUrl('https://user:pw@a.it/p?x#y')).toBe('https://a.it/p');
  });
  it('returns the path', () => {
    expect(pathOf('https://a.it/p/q?x=1')).toBe('/p/q');
    expect(pathOf('https://a.it')).toBe('/');
  });
});

describe('matchesPattern', () => {
  it('wildcard matches subdomains only', () => {
    expect(matchesPattern('https://*.hotjar.com', 'https://script.hotjar.com')).toBe(true);
    expect(matchesPattern('https://*.hotjar.com', 'https://a.b.hotjar.com')).toBe(true);
    expect(matchesPattern('https://*.hotjar.com', 'https://hotjar.com')).toBe(false);
    expect(matchesPattern('https://*.hotjar.com', 'https://evilhotjar.com')).toBe(false);
    expect(matchesPattern('*.hotjar.com', 'wss://ws.hotjar.com')).toBe(true);
    expect(matchesPattern('*.hotjar.com', 'data://x.hotjar.com')).toBe(false);
    expect(matchesPattern('https://cdn.example.com', 'http://cdn.example.com')).toBe(false);
  });
  it('exact patterns, normalized', () => {
    expect(matchesPattern('HTTPS://CDN.example.com', 'https://cdn.example.com')).toBe(true);
    expect(matchesPattern('https://cdn.example.com.', 'https://cdn.example.com')).toBe(true);
    expect(matchesPattern('https://cdn.example.com', 'https://cdn.example.com:8443')).toBe(false);
    expect(matchesPattern('cdn.example.com', 'http://cdn.example.com')).toBe(true);
    expect(matchesPattern('cdn.example.com', 'wss://cdn.example.com')).toBe(true);
  });
});

describe('matchesPattern robustness and ports', () => {
  it.each(['https://*.exa mple.com', 'https://*.example.com:abc', 'https://*.', 'https://', '*.', '', '://x', 'https://*.example.com:99999'])(
    'does not throw for malformed pattern %j', p => {
      expect(() => matchesPattern(p, 'https://a.example.com')).not.toThrow();
      expect(matchesPattern(p, 'https://a.example.com')).toBe(false);
      expect(() => hostMatchesDomains('a.example.com', [p])).not.toThrow();
      expect(() => isRiskyWildcard(p)).not.toThrow();
    });
  it('does not throw for malformed origin', () => {
    expect(matchesPattern('https://*.example.com', 'garbage')).toBe(false);
  });
  it('scheme wildcard without port matches default port only', () => {
    expect(matchesPattern('https://*.example.com', 'https://a.example.com')).toBe(true);
    expect(matchesPattern('https://*.example.com', 'https://a.example.com:8443')).toBe(false);
    expect(matchesPattern('*.example.com', 'https://a.example.com:8443')).toBe(false);
    expect(matchesPattern('https://cdn.example.com', 'https://cdn.example.com:8443')).toBe(false);
  });
  it('pattern with a port requires that port', () => {
    expect(matchesPattern('https://*.example.com:8443', 'https://a.example.com:8443')).toBe(true);
    expect(matchesPattern('https://*.example.com:8443', 'https://a.example.com')).toBe(false);
    expect(matchesPattern('https://*.example.com:8443', 'https://a.example.com:9000')).toBe(false);
    expect(matchesPattern('https://*.example.com:443', 'https://a.example.com')).toBe(true);
    expect(matchesPattern('https://cdn.example.com:8443', 'https://cdn.example.com:8443')).toBe(true);
  });
});

describe('hostMatchesDomains', () => {
  it('exact and wildcard', () => {
    expect(hostMatchesDomains('gida-spa.it', ['gida-spa.it'])).toBe(true);
    expect(hostMatchesDomains('www.gida-spa.it', ['gida-spa.it'])).toBe(false);
    expect(hostMatchesDomains('www.gida-spa.it', ['*.gida-spa.it'])).toBe(true);
    expect(hostMatchesDomains('gida-spa.it', ['*.gida-spa.it'])).toBe(false);
    expect(hostMatchesDomains('evilgida-spa.it', ['*.gida-spa.it'])).toBe(false);
    expect(hostMatchesDomains('GIDA-SPA.it.', ['gida-spa.it'])).toBe(true);
    expect(hostMatchesDomains('x.it', [])).toBe(false);
  });
});

describe('isRiskyWildcard', () => {
  it('flags wildcards on shared hosting', () => {
    expect(isRiskyWildcard('*.cloudfront.net')).toBe(true);
    expect(isRiskyWildcard('https://*.s3.amazonaws.com')).toBe(true);
    expect(isRiskyWildcard('https://*.eu.workers.dev')).toBe(true);
    expect(isRiskyWildcard('https://*.hotjar.com')).toBe(false);
    expect(isRiskyWildcard('https://d1.cloudfront.net')).toBe(false);
    expect(isRiskyWildcard('https://*.notcloudfront.net')).toBe(false);
  });
});
