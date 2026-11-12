import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseBody } from '../../src/ingest/parse.js';

const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

describe('parseBody', () => {
  it('maps the legacy report-uri format to Reporting API field names', () => {
    const [r] = parseBody('application/csp-report', fixture('csp-report-legacy.json'));
    expect(r.type).toBe('csp-violation');
    expect(r.body).toMatchObject({
      documentURL: 'https://www.gida-spa.it/prodotti?x=1',
      blockedURL: 'https://cdn-stats.xyz/c.js',
      effectiveDirective: 'script-src-elem',
      sample: '',
    });
  });
  it('reads every report of a reports+json batch', () => {
    expect(parseBody('application/reports+json', fixture('reports-json-mixed.json')).map((r) => r.type))
      .toEqual(['csp-violation', 'deprecation', 'csp-violation']);
  });
  it('keeps url and userAgent and the inline sample of a Chrome batch', () => {
    const reports = parseBody('application/reports+json', fixture('reports-json-chrome.json'));
    expect(reports).toHaveLength(2);
    expect(reports[0].userAgent).toContain('Chrome/131');
    expect(reports[0].url).toBe('https://www.gida-spa.it/prodotti?x=1');
    expect(reports[1].body).toMatchObject({ blockedURL: 'inline', sample: 'window.dataLayer = window.dataLayer || [];' });
  });
  it.each([
    ['application/csp-report', '{not json'], ['application/reports+json', '[]'],
    ['application/reports+json', '{"type":"csp-violation"}'], ['application/csp-report', '{"foo":1}'],
    ['text/plain', 'hello'], [undefined, ''],
  ])('returns [] for invalid input %s %s', (ct, body) => { expect(parseBody(ct, body)).toEqual([]); });
  it('sniffs the format when content type is application/json', () => {
    expect(parseBody('application/json', fixture('csp-report-legacy.json'))).toHaveLength(1);
    expect(parseBody('text/plain', fixture('reports-json-chrome.json'))).toHaveLength(2);
  });
  it('drops malformed entries of a batch', () => {
    expect(parseBody('application/reports+json', '[1,null,{"type":"x"},{"type":"csp-violation","body":{}}]'))
      .toEqual([{ type: 'csp-violation', body: {} }]);
  });
  it('accepts content types with parameters', () => {
    expect(parseBody('application/csp-report; charset=utf-8', fixture('csp-report-legacy.json'))).toHaveLength(1);
  });
});
