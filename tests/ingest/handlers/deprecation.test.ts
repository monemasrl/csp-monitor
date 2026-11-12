// Fixture fields follow the Chrome deprecation report body (id, message, anticipatedRemoval, sourceFile, lineNumber).
import { beforeEach, describe, expect, it } from 'vitest';
import { HANDLERS } from '../../../src/ingest/handlers/index.js';
import { runReminders } from '../../../src/ingest/handlers/deprecation.js';
import type { RawReport } from '../../../src/ingest/parse.js';
import { getDetail } from '../../../src/store/origins.js';
import { createSite, deleteSite, endLearning, getSite, type Site } from '../../../src/store/sites.js';
import type { Deps } from '../../../src/web/app.js';
import { NOW as T, testDeps } from '../../helpers.js';

const DAY = 86_400_000;
const REMOVAL = T + 60 * DAY;
const rep = (body: Record<string, unknown>): RawReport => ({
  type: 'deprecation', url: 'https://www.gida-spa.it/home', age: 10, userAgent: 'Mozilla/5.0 Chrome/130.0',
  body: {
    id: 'WebSQL', message: 'WebSQL is deprecated', anticipatedRemoval: new Date(REMOVAL).toISOString(),
    sourceFile: 'https://www.gida-spa.it/app.js?v=3', lineNumber: 12, columnNumber: 3, ...body,
  },
} as RawReport);

let deps: Deps;
let site: Site;
beforeEach(() => {
  deps = testDeps();
  site = createSite(deps.db, { name: 'S', domains: ['www.gida-spa.it'] }, T - 30 * DAY);
  endLearning(deps.db, site.id, T - 1000);
  site = getSite(deps.db, site.id)!;
});

function run(raw: RawReport, s: Site = site, now = T) {
  const h = HANDLERS.get('deprecation')!;
  const e = h.toEvent(raw, s);
  expect(e).not.toBeNull();
  const ctx = { db: deps.db, site: s, now };
  const r = h.record(ctx, e, raw);
  return { keys: h.keys(e), r, alert: h.decide(ctx, e, r) };
}
const reminders = () => deps.db.prepare('SELECT * FROM reminders').all() as { site_id: number; kind: string; ref: string; due_at: number; sent_at: number | null }[];
const pending = () => deps.db.prepare('SELECT * FROM pending_alerts').all() as { kind: string; origin_id: number | null; payload: string | null; immediate: number }[];

describe('deprecation handler', () => {
  it('rejects a report without id', () => {
    expect(HANDLERS.get('deprecation')!.toEvent(rep({ id: undefined }), site)).toBeNull();
  });
  it('keys and detail', () => {
    const a = run(rep({}));
    expect(a.keys).toEqual(['api', 'WebSQL']);
    expect(getDetail(deps.db, a.r.originId)).toMatchObject({
      message: 'WebSQL is deprecated', anticipatedRemoval: REMOVAL, sourceFile: 'https://www.gida-spa.it/app.js', line: 12,
    });
  });
  it('valid future date: alert once + reminder 30 days before', () => {
    const a = run(rep({}));
    expect(a.alert).toEqual({
      kind: 'deprecation', originId: a.r.originId, payload: { api: 'WebSQL', removal: new Date(REMOVAL).toISOString().slice(0, 10) },
    });
    expect(reminders()).toEqual([expect.objectContaining({ site_id: site.id, kind: 'deprecation', ref: 'WebSQL', due_at: REMOVAL - 30 * DAY, sent_at: null })]);
    expect(run(rep({})).alert).toBeNull();
    expect(reminders()).toHaveLength(1);
  });
  it('accepts ms numbers and snake_case', () => {
    expect(run(rep({ anticipatedRemoval: undefined, anticipated_removal: REMOVAL })).alert?.kind).toBe('deprecation');
  });
  it('no date: recorded, no alert, no reminder', () => {
    const a = run(rep({ anticipatedRemoval: null }));
    expect(a.alert).toBeNull();
    expect(reminders()).toHaveLength(0);
    expect(getDetail(deps.db, a.r.originId)?.anticipatedRemoval).toBeUndefined();
  });
  it('invalid or past date: no alert, no reminder, no throw', () => {
    expect(run(rep({ anticipatedRemoval: 'soon' }), site, T).alert).toBeNull();
    expect(run(rep({ id: 'B', anticipatedRemoval: new Date(T - DAY).toISOString() })).alert).toBeNull();
    expect(reminders()).toHaveLength(0);
  });
  it('out-of-range number: treated as absent, no throw', () => {
    expect(run(rep({ anticipatedRemoval: 1e20 })).alert).toBeNull();
    expect(reminders()).toHaveLength(0);
  });
  it('due_at already past (removal within 30 days): alert but no reminder', () => {
    const a = run(rep({ anticipatedRemoval: new Date(T + 10 * DAY).toISOString() }));
    expect(a.alert?.kind).toBe('deprecation');
    expect(reminders()).toHaveLength(0);
  });
  it('learning: no alert but the reminder is kept', () => {
    const learning = { ...site, learningUntil: T + DAY };
    expect(run(rep({}), learning).alert).toBeNull();
    expect(reminders()).toHaveLength(1);
  });
});

describe('runReminders', () => {
  it('sends a due reminder exactly once, linked to the origin', async () => {
    const a = run(rep({}));
    await runReminders(deps, REMOVAL - 31 * DAY);
    expect(pending()).toHaveLength(0);
    await runReminders(deps, REMOVAL - 29 * DAY);
    await runReminders(deps, REMOVAL - 28 * DAY);
    const p = pending();
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ kind: 'deprecation-reminder', origin_id: a.r.originId, immediate: 1 });
    expect(JSON.parse(p[0]!.payload!)).toEqual({ api: 'WebSQL', removal: new Date(REMOVAL).toISOString().slice(0, 10) });
    expect(reminders()[0]!.sent_at).toBe(REMOVAL - 29 * DAY);
  });
  it('tolerates a deleted site', async () => {
    run(rep({}));
    deps.db.prepare('INSERT INTO reminders (site_id, kind, ref, due_at) VALUES (9999, ?, ?, ?)').run('deprecation', 'X', 1);
    await expect(runReminders(deps, REMOVAL)).resolves.toBeUndefined();
    expect(pending().filter(p => p.kind === 'deprecation-reminder')).toHaveLength(1);
    expect(reminders().every(r => r.sent_at !== null)).toBe(true);
    deleteSite(deps.db, site.id);
  });
});
