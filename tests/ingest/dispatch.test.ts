import { beforeEach, describe, expect, it } from 'vitest';
import { HANDLERS } from '../../src/ingest/handlers/index.js';
import { ingest } from '../../src/ingest/handler.js';
import { createSite, endLearning, type Site } from '../../src/store/sites.js';
import type { Deps } from '../../src/web/app.js';
import { NOW as T, testDeps } from '../helpers.js';

const countNoise = (db: Deps['db'], siteId: number, reason: string): number =>
  (db.prepare('SELECT COALESCE(SUM(count),0) AS n FROM noise_counts WHERE site_id = ? AND reason = ?').get(siteId, reason) as { n: number }).n;

let deps: Deps;
let site: Site;
beforeEach(() => {
  deps = testDeps();
  site = createSite(deps.db, { name: 'S', domains: ['www.example.it'] }, T - 30 * 86_400_000);
  endLearning(deps.db, site.id, T - 1000);
});

describe('handler registry', () => {
  it('has the csp-violation handler', () => {
    expect(HANDLERS.get('csp-violation')?.type).toBe('csp-violation');
  });

  it('a report of unknown type is kept in discarded as unsupported-type, not counted as noise', () => {
    const body = JSON.stringify([{ type: 'unknown-x', url: 'https://www.example.it/', body: { a: 1 } }]);
    ingest(deps, site.key, 'application/reports+json', body, T);
    expect(deps.db.prepare('SELECT reason, detail FROM discarded').all()).toEqual([{ reason: 'unsupported-type', detail: 'unknown-x' }]);
    expect(deps.db.prepare('SELECT COUNT(*) n FROM noise_counts').get()).toEqual({ n: 0 });
    expect(deps.db.prepare('SELECT COUNT(*) n FROM origins').get()).toEqual({ n: 0 });
  });

  it('an unparseable body still counts as invalid', () => {
    ingest(deps, site.key, 'application/reports+json', '{bad', T);
    expect(countNoise(deps.db, site.id, 'invalid')).toBe(1);
  });

  it('dispatches a csp-violation to its handler and passes an AlertRequest to onAlert', () => {
    const got: unknown[] = [];
    deps = testDeps({ db: deps.db, onAlert: (_s, req) => { got.push(req); } });
    const body = JSON.stringify([{ type: 'csp-violation', url: 'https://www.example.it/', body: {
      documentURL: 'https://www.example.it/', blockedURL: 'https://evil.example/x.js', effectiveDirective: 'script-src' } }]);
    ingest(deps, site.key, 'application/reports+json', body, T);
    expect(got).toEqual([{ kind: 'new-origin', originId: 1 }]);
  });
});
