import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { HANDLERS } from '../../../src/ingest/handlers/index.js';
import { parseBody, type RawReport } from '../../../src/ingest/parse.js';
import { ingest } from '../../../src/ingest/handler.js';
import { addApprovalPattern } from '../../../src/store/origins.js';
import { createSite, endLearning, getSite, type Site } from '../../../src/store/sites.js';
import type { Deps } from '../../../src/web/app.js';
import { NOW as T, testDeps } from '../../helpers.js';

const fixture = (type: string): RawReport =>
  parseBody('application/reports+json', readFileSync(`tests/fixtures/reports-${type}.json`, 'utf8'))[0]!;
const withBody = (r: RawReport, patch: Record<string, unknown>): RawReport => ({ ...r, body: { ...r.body, ...patch } });

let deps: Deps;
let site: Site;
beforeEach(() => {
  deps = testDeps();
  site = createSite(deps.db, { name: 'S', domains: ['www.gida-spa.it'] }, T - 30 * 86_400_000);
  endLearning(deps.db, site.id, T - 1000);
  site = getSite(deps.db, site.id)!;
});

/** Runs toEvent -> noise -> record -> decide like the pipeline does. */
function run(raw: RawReport, s: Site = site, now = T) {
  const h = HANDLERS.get(raw.type)!;
  const e = h.toEvent(raw, s)!;
  expect(e).not.toBeNull();
  const ctx = { db: deps.db, site: s, now };
  const r = h.record(ctx, e, raw);
  return { keys: h.keys(e), noise: h.noise(e, s, []), r, alert: h.decide(ctx, e, r) };
}

describe('integrity-violation', () => {
  it('keys: destination and the resource URL without query; alerts on the new row', () => {
    const x = run(fixture('integrity-violation'));
    expect(x.keys).toEqual(['script', 'https://cdn.example.net/lib.js']);
    expect(x.alert).toEqual({ kind: 'integrity', originId: x.r.originId });
    expect(run(fixture('integrity-violation')).alert).toBeNull();
  });
  it('alerts even when an approval covers the origin', () => {
    addApprovalPattern(deps.db, site.id, 'https://cdn.example.net/lib.js', ['integrity-violation:script'], T);
    const x = run(fixture('integrity-violation'));
    expect(x.r.status).toBe('approved');
    expect(x.alert?.kind).toBe('integrity');
  });
  it('does not alert during learning', () => {
    const s = { ...site, learningUntil: T + 1000 };
    expect(run(fixture('integrity-violation'), s).alert).toBeNull();
  });
  it('defaults destination to script and accepts `url` and snake_case fields', () => {
    const raw = { type: 'integrity-violation', body: { document_url: 'https://www.gida-spa.it/a', url: 'https://cdn.example.net/x.css?q=1' } };
    expect(run(raw).keys).toEqual(['script', 'https://cdn.example.net/x.css']);
  });
  it('is invalid without a resource URL', () => {
    const h = HANDLERS.get('integrity-violation')!;
    expect(h.toEvent(withBody(fixture('integrity-violation'), { blockedURL: undefined }), site)).toBeNull();
  });
});

describe('connection-allowlist', () => {
  it('keys: type and destination origin; alerts, not immediate off sensitive paths', () => {
    const x = run(fixture('connection-allowlist'));
    expect(x.keys).toEqual(['fetch', 'https://tracker.example.net']);
    expect(x.alert).toEqual({ kind: 'new-connection', originId: x.r.originId });
  });
  it('is immediate on a sensitive path prefix', () => {
    const s = { ...site, sensitivePaths: ['/checkout'] };
    const x = run(fixture('connection-allowlist'), s);
    expect(x.alert).toEqual({ kind: 'new-connection', originId: x.r.originId, immediate: true });
  });
  it('second occurrence and approved rows do not alert', () => {
    run(fixture('connection-allowlist'));
    expect(run(fixture('connection-allowlist')).alert).toBeNull();
    addApprovalPattern(deps.db, site.id, 'https://other.example.net', ['connection-allowlist:beacon'], T);
    const x = run(withBody(fixture('connection-allowlist'), { type: 'beacon', blockedURL: 'https://other.example.net/p' }));
    expect(x.r.status).toBe('approved');
    expect(x.alert).toBeNull();
  });
  it('uses `destination` when `type` is missing, and defaults to connection', () => {
    expect(run(withBody(fixture('connection-allowlist'), { type: undefined, destination: 'websocket', blockedURL: 'wss://rt.example.net/s' })).keys)
      .toEqual(['websocket', 'wss://rt.example.net']);
    expect(run(withBody(fixture('connection-allowlist'), { type: undefined })).keys[0]).toBe('connection');
  });
});

describe('permissions-policy-violation', () => {
  it('keys: feature and sourceFile origin; sensitive feature alerts', () => {
    const x = run(fixture('permissions-policy-violation'));
    expect(x.keys).toEqual(['camera', 'https://widgets.example.net']);
    expect(x.alert).toEqual({ kind: 'permission', originId: x.r.originId });
  });
  it('a non-sensitive feature (fullscreen) does not alert', () => {
    expect(run(withBody(fixture('permissions-policy-violation'), { featureId: 'fullscreen' })).alert).toBeNull();
  });
  it('without sourceFile the origin is inline', () => {
    expect(run(withBody(fixture('permissions-policy-violation'), { sourceFile: undefined })).keys).toEqual(['camera', 'inline']);
  });
  it('accepts snake_case', () => {
    const raw = { type: 'permissions-policy-violation', url: 'https://www.gida-spa.it/', body: { feature_id: 'geolocation', source_file: 'https://w.example.net/a.js' } };
    expect(run(raw).keys).toEqual(['geolocation', 'https://w.example.net']);
  });
  it('covers every sensitive feature', () => {
    for (const f of ['camera', 'microphone', 'geolocation', 'payment', 'display-capture', 'usb', 'serial', 'hid', 'bluetooth']) {
      expect(run(withBody(fixture('permissions-policy-violation'), { featureId: f })).alert?.kind).toBe('permission');
    }
  });
});

describe('document-policy-violation', () => {
  it('keys: feature and document path; never alerts', () => {
    const x = run(fixture('document-policy-violation'));
    expect(x.keys).toEqual(['document-write', '/prodotti']);
    expect(x.alert).toBeNull();
  });
});

describe('intervention', () => {
  it('keys: id and sourceFile without query; never alerts', () => {
    const x = run(fixture('intervention'));
    expect(x.keys).toEqual(['NoPassiveScrollBlocking', 'https://www.gida-spa.it/js/slider.js']);
    expect(x.alert).toBeNull();
  });
  it('without sourceFile the second key is an em dash', () => {
    expect(run(withBody(fixture('intervention'), { sourceFile: undefined })).keys[1]).toBe('—');
  });
});

describe('coop', () => {
  it('keys: type and other-window origin; enforce alerts', () => {
    const x = run(fixture('coop'));
    expect(x.keys).toEqual(['navigation-from-response', 'https://accounts.example.net']);
    expect(x.alert).toEqual({ kind: 'coop-blocked', originId: x.r.originId });
  });
  it('report-only (reporting) does not alert', () => {
    expect(run(withBody(fixture('coop'), { disposition: 'reporting' })).alert).toBeNull();
  });
  it('without any other-window URL the second key is an em dash and the report is kept', () => {
    const raw = withBody(fixture('coop'), { previousResponseURL: undefined, nextResponseURL: undefined });
    expect(run(raw).keys).toEqual(['navigation-from-response', '—']);
  });
  it('without body.type the report is invalid', () => {
    expect(HANDLERS.get('coop')!.toEvent(withBody(fixture('coop'), { type: undefined }), site)).toBeNull();
  });
  it('takes the first present of the other-document URLs', () => {
    const raw = withBody(fixture('coop'), { previousResponseURL: undefined, openerURL: 'https://op.example.net/x' });
    expect(run(raw).keys[1]).toBe('https://op.example.net');
  });
});

describe('coep', () => {
  it('keys: destination and blocked URL without query; enforce alerts', () => {
    const x = run(fixture('coep'));
    expect(x.keys).toEqual(['image', 'https://img.example.net/p.png']);
    expect(x.alert).toEqual({ kind: 'coep-blocked', originId: x.r.originId });
  });
  it('report-only does not alert; second occurrence does not alert', () => {
    expect(run(withBody(fixture('coep'), { disposition: 'reporting', blockedURL: 'https://i2.example.net/a.png' })).alert).toBeNull();
    run(fixture('coep'));
    expect(run(fixture('coep')).alert).toBeNull();
  });
});

describe('common behaviour', () => {
  const TYPES = ['integrity-violation', 'connection-allowlist', 'permissions-policy-violation', 'document-policy-violation', 'intervention', 'coop', 'coep'];
  it.each(['connection-allowlist', 'permissions-policy-violation', 'coop', 'coep'])(
    'no alert during the learning window: %s', t => {
      const s = { ...site, learningUntil: T + 1000 };
      expect(run(fixture(t), s).alert).toBeNull();
    });
  it('never throws on empty or odd bodies', () => {
    for (const t of TYPES) {
      const h = HANDLERS.get(t)!;
      for (const body of [{}, { a: { b: 1 } }, { featureId: 5, blockedURL: {}, documentURL: [] }]) {
        expect(() => h.toEvent({ type: t, body }, site)).not.toThrow();
      }
    }
  });
  it('stores the sanitized body in the sample', () => {
    run(fixture('coep'));
    const row = deps.db.prepare('SELECT body FROM samples').get() as { body: string };
    expect(row.body).toContain('https://img.example.net/p.png');
    expect(row.body).not.toContain('s=1');
  });
  it('foreign-document and bot are noise for every type', () => {
    for (const t of TYPES) {
      const h = HANDLERS.get(t)!;
      const raw = fixture(t);
      const foreign = h.toEvent({ ...raw, url: 'https://evil.example/', body: { ...raw.body, documentURL: 'https://evil.example/' } }, site)!;
      expect(h.noise(foreign, site, [])).toBe('foreign-document');
      const bot = h.toEvent({ ...raw, userAgent: 'Googlebot/2.1 (+http://www.google.com/bot.html)' }, site)!;
      expect(h.noise(bot, site, [])).toBe('bot');
    }
  });
  it('extension URLs are noise where a resource URL exists', () => {
    const h = HANDLERS.get('coep')!;
    const e = h.toEvent(withBody(fixture('coep'), { blockedURL: 'chrome-extension://abc/x.png' }), site)!;
    expect(h.noise(e, site, [])).toBe('extension');
  });
});

describe('dispatch of non-CSP types', () => {
  it('ingest stores a coep report with report_type, keyA and keyB', () => {
    const text = readFileSync('tests/fixtures/reports-coep.json', 'utf8');
    ingest(deps, site.key, 'application/reports+json', text, T);
    expect(deps.db.prepare('SELECT report_type, directive, origin FROM origins').all())
      .toEqual([{ report_type: 'coep', directive: 'image', origin: 'https://img.example.net/p.png' }]);
  });
  it('a foreign-document report of a new type is counted as noise', () => {
    const text = JSON.stringify([{ type: 'intervention', url: 'https://evil.example/', body: { id: 'X', documentURL: 'https://evil.example/' } }]);
    ingest(deps, site.key, 'application/reports+json', text, T);
    expect(deps.db.prepare("SELECT reason, count FROM noise_counts").all()).toEqual([{ reason: 'foreign-document', count: 1 }]);
    expect(deps.db.prepare('SELECT COUNT(*) n FROM origins').get()).toEqual({ n: 0 });
  });
});
