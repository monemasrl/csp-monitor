import { describe, it, expect } from 'vitest';
import { decideCspAlert } from '../../src/alerts/decide.js';
import type { Site } from '../../src/store/sites.js';
import type { CspEvent } from '../../src/ingest/csp.js';
import { NOW } from '../helpers.js';

const DAY = 24 * 3600 * 1000;
const site: Site = {
  id: 1, name: 'A', key: 'k', domains: ['a.it'], createdAt: NOW - 10 * DAY, learningUntil: NOW - DAY,
  learningSummarySent: false, ratePerMin: 120, ratePerDay: 20000, lastReportAt: null, sensitivePaths: [],
};
const event: CspEvent = {
  directive: 'script-src', origin: 'https://x.com', category: 'external', page: '/', documentUrl: 'https://a.it/',
  documentHost: 'a.it', blockedRaw: 'https://x.com/a.js', sourceFile: '', sample: '', line: null,
  disposition: 'report', ua: 'Chrome 120', isBot: false,
};
const res = (o: Partial<{ isNewRow: boolean; status: 'new' | 'approved' | 'suspect'; previousLastSeen: number | null }>) =>
  ({ originId: 1, isNewRow: true, status: 'new' as const, previousLastSeen: null, ...o });

describe('decideCspAlert (pure rules)', () => {
  it('new and suspect new rows alert after learning, approved do not', () => {
    expect(decideCspAlert({ site, event, noise: null, result: res({}), now: NOW })).toBe(true);
    expect(decideCspAlert({ site, event, noise: null, result: res({ status: 'suspect' }), now: NOW })).toBe(true);
    expect(decideCspAlert({ site, event, noise: null, result: res({ status: 'approved' }), now: NOW })).toBe(false);
  });

  it('learning ends exactly at learningUntil', () => {
    expect(decideCspAlert({ site, event, noise: null, result: res({}), now: site.learningUntil - 1 })).toBe(false);
    expect(decideCspAlert({ site, event, noise: null, result: res({}), now: site.learningUntil })).toBe(true);
  });

  it('existing suspect row alerts only after more than 30 days', () => {
    const r = (ago: number) => res({ isNewRow: false, status: 'suspect', previousLastSeen: NOW - ago });
    expect(decideCspAlert({ site, event, noise: null, result: r(30 * DAY), now: NOW })).toBe(false);
    expect(decideCspAlert({ site, event, noise: null, result: r(30 * DAY + 1), now: NOW })).toBe(true);
    expect(decideCspAlert({ site, event, noise: null, result: res({ isNewRow: false, status: 'new', previousLastSeen: NOW - 90 * DAY }), now: NOW })).toBe(false);
  });
});
