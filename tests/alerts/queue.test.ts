import { describe, expect, it, vi } from 'vitest';
import type { AlertChannel } from '../../src/alerts/channels.js';
import { approveOrigin } from '../../src/store/origins.js';
import { dueBatches, enqueue, enqueueAlert, markSent, runDueAlerts, runLearningSummaries } from '../../src/alerts/queue.js';
import { recordCspEvent } from '../../src/store/origins.js';
import { createSite, endLearning, getSite } from '../../src/store/sites.js';
import type { CspEvent } from '../../src/ingest/csp.js';
import { NOW as T, testDeps } from '../helpers.js';

const BASE = 'https://m.example.it';
function ev(origin: string, over: Partial<CspEvent> = {}): CspEvent {
  return { directive: 'script-src', origin, category: 'external', page: 'https://a.example.it/p', sourceFile: null, sample: null, line: null, ua: null, disposition: 'report', ...over } as CspEvent;
}
function fake(failTimes = 0) {
  const ch = { name: 'fake', sent: [] as { subject: string; text: string; html: string }[], calls: 0,
    async send(m: { subject: string; text: string; html: string }) {
      ch.calls++;
      if (ch.calls <= failTimes) throw new Error('smtp down');
      ch.sent.push(m);
    } };
  return ch as AlertChannel & typeof ch;
}
function setup() {
  const deps = testDeps();
  const db = deps.db;
  const s1 = createSite(db, { name: 'S1', domains: ['a.example.it'] }, T - 20 * 86400_000);
  const s2 = createSite(db, { name: 'S2', domains: ['b.example.it'] }, T - 20 * 86400_000);
  const o = (s: typeof s1, origin: string, now = T) => recordCspEvent(db, s, ev(origin, { sourceFile: 'https://x/app.js', sample: 'smp' }), now).originId;
  return { deps, db, s1, s2, o };
}
const withChannels = (d: ReturnType<typeof testDeps>, channels: AlertChannel[]) => ({ ...d, channels });

describe('alert queue', () => {
  it('groups alerts of the same site and waits 10 minutes', () => {
    const { db, s1, s2, o } = setup();
    const o1 = o(s1, 'https://c1.example'), o2 = o(s1, 'https://c2.example'), o3 = o(s2, 'https://c3.example');
    enqueueAlert(db, s1.id, o1, T); enqueueAlert(db, s1.id, o2, T + 60_000); enqueueAlert(db, s2.id, o3, T);
    expect(dueBatches(db, T + 599_999)).toHaveLength(0);
    const b = dueBatches(db, T + 600_000);
    expect(b.map(x => x.items.length).sort()).toEqual([1, 2]);
    const big = b.find(x => x.items.length === 2)!;
    expect(big.site.id).toBe(s1.id);
    expect(big.pendingIds).toHaveLength(2);
    expect(big.items[0]).toMatchObject({ origin: 'https://c1.example', directive: 'script-src', page: 'https://a.example.it/p', sourceFile: 'https://x/app.js', sample: 'smp' });
  });

  it('does not return sent alerts', () => {
    const { db, s1, o } = setup();
    enqueueAlert(db, s1.id, o(s1, 'https://c1.example'), T);
    const [b] = dueBatches(db, T + 600_000);
    markSent(db, b!.pendingIds, T + 600_000);
    expect(dueBatches(db, T + 700_000)).toHaveLength(0);
  });

  it('keeps alerts pending when sending fails and never sends twice', async () => {
    const { deps, db, s1, o } = setup();
    const flaky = fake(1);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    enqueueAlert(db, s1.id, o(s1, 'https://c1.example'), T);
    await runDueAlerts(withChannels(deps, [flaky]), T + 600_000);
    expect(flaky.sent).toHaveLength(0);
    await runDueAlerts(withChannels(deps, [flaky]), T + 660_000);
    await runDueAlerts(withChannels(deps, [flaky]), T + 720_000);
    expect(flaky.sent).toHaveLength(1);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('does not mark sent if any channel fails, and one batch failing does not block another', async () => {
    const { deps, db, s1, s2, o } = setup();
    enqueueAlert(db, s1.id, o(s1, 'https://c1.example'), T);
    enqueueAlert(db, s2.id, o(s2, 'https://c2.example'), T);
    const good = fake();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = { name: 'bad', async send(m: { subject: string }) { if (m.subject.includes('S1')) throw new Error('x'); } };
    await runDueAlerts(withChannels(deps, [good, bad]), T + 600_000);
    expect(dueBatches(db, T + 600_000).map(b => b.site.id)).toEqual([s1.id]);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('skips origins approved inside the grouping window and sends nothing for an empty batch (M3)', async () => {
    const { deps, db, s1, o } = setup();
    const a = o(s1, 'https://c1.example'), b = o(s1, 'https://c2.example');
    enqueueAlert(db, s1.id, a, T); enqueueAlert(db, s1.id, b, T);
    approveOrigin(db, s1.id, 'https://c1.example', 'site', T + 1000);
    const [batch] = dueBatches(db, T + 600_000);
    expect(batch!.items.map(i => i.origin)).toEqual(['https://c2.example']);
    approveOrigin(db, s1.id, 'https://c2.example', 'site', T + 2000);
    const ch = fake();
    await runDueAlerts(withChannels(deps, [ch]), T + 600_000);
    expect(ch.sent).toHaveLength(0);
    expect(dueBatches(db, T + 700_000)).toHaveLength(0);
  });
});

describe('learning summary', () => {
  it('sends once, with only alertable new origins, even when empty', async () => {
    const { deps, db, s1, s2, o } = setup();
    o(s1, 'https://c1.example', T - 15 * 86400_000); // first seen while learning
    recordCspEvent(db, s1, ev('inline', { category: 'inline' }), T - 15 * 86400_000);
    const ch = fake();
    const d = withChannels(deps, [ch]);
    await runLearningSummaries(d, T);
    await runLearningSummaries(d, T + 60_000);
    expect(ch.sent).toHaveLength(2); // s1 and s2, once each
    const m1 = ch.sent.find(m => m.subject.includes('S1'))!;
    expect(m1.subject).toBe('[CSP Monitor] S1: fine apprendimento, 1 origini da rivedere');
    expect(m1.text).not.toContain('inline');
    expect(ch.sent.find(m => m.subject.includes('S2'))!.text).toContain('nessuna origine da rivedere');
    expect(getSite(db, s1.id)!.learningSummarySent).toBe(true);
    expect(s2.id).toBeGreaterThan(0);
  });

  it('does not list an origin first seen after learning ended (I2)', async () => {
    const { deps, db, s1, o } = setup();
    endLearning(db, s1.id, T);
    const late = o(s1, 'https://late.example', T + 2000);
    enqueueAlert(db, s1.id, late, T + 2000);
    const ch = fake();
    const d = withChannels(deps, [ch]);
    await runLearningSummaries(d, T + 3000);
    await runDueAlerts(d, T + 2000 + 600_000);
    const withOrigin = ch.sent.filter(m => m.text.includes('late.example'));
    expect(withOrigin).toHaveLength(1);
    expect(withOrigin[0]!.subject).not.toContain('apprendimento');
  });

  it('retries when sending fails and skips sites still learning', async () => {
    const deps = testDeps(); const db = deps.db;
    const s = createSite(db, { name: 'S', domains: ['a.example.it'] }, T - 20 * 86400_000);
    createSite(db, { name: 'Young', domains: ['y.example.it'] }, T);
    const ch = fake(1);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runLearningSummaries(withChannels(deps, [ch]), T);
    expect(getSite(db, s.id)!.learningSummarySent).toBe(false);
    await runLearningSummaries(withChannels(deps, [ch]), T + 60_000);
    expect(ch.sent).toHaveLength(1);
    expect(getSite(db, s.id)!.learningSummarySent).toBe(true);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('an immediate alert is due at once, together with the other pendings of the site', () => {
    const { db, s1, s2, o } = setup();
    const o1 = o(s1, 'https://c1.example'), o2 = o(s1, 'https://c2.example'), o3 = o(s2, 'https://c3.example');
    enqueueAlert(db, s1.id, o1, T);
    enqueue(db, s1.id, { kind: 'integrity', originId: o2, immediate: true }, T + 1000);
    enqueueAlert(db, s2.id, o3, T + 1000);
    const b = dueBatches(db, T + 2000);
    expect(b).toHaveLength(1);
    expect(b[0]!.site.id).toBe(s1.id);
    expect(b[0]!.items.map(i => i.kind)).toEqual(['new-origin', 'integrity']);
    expect(b[0]!.pendingIds).toHaveLength(2);
  });

  it('keeps payloads, dedups per (kind, origin) and keeps integrity when approved', () => {
    const { db, s1, o } = setup();
    const o1 = o(s1, 'https://c1.example');
    enqueueAlert(db, s1.id, o1, T);
    enqueue(db, s1.id, { kind: 'hash-changed', originId: o1 }, T);
    enqueue(db, s1.id, { kind: 'hash-changed', originId: o1 }, T);
    enqueue(db, s1.id, { kind: 'integrity', originId: o1 }, T);
    enqueue(db, s1.id, { kind: 'nel-rate', payload: { host: 'h' } }, T);
    approveOrigin(db, s1.id, 'https://c1.example', 'site', T);
    const [b] = dueBatches(db, T + 600_000);
    expect(b!.items.map(i => i.kind)).toEqual(['integrity', 'nel-rate']);
    expect(b!.items[1]!.payload).toEqual({ host: 'h' });
    expect(b!.pendingIds).toHaveLength(5);
  });

  it('delivers a mixed batch in one message', async () => {
    const { deps, db, s1, o } = setup();
    const ch = fake();
    enqueueAlert(db, s1.id, o(s1, 'https://c1.example'), T);
    enqueue(db, s1.id, { kind: 'nel-rate', payload: { host: 'h' }, immediate: true }, T);
    await runDueAlerts(withChannels(deps, [ch]), T + 1);
    expect(ch.sent).toHaveLength(1);
    expect(ch.sent[0]!.subject).toBe('[CSP Monitor] S1: 2 segnalazioni');
    expect(dueBatches(db, T + 2)).toHaveLength(0);
  });
});
export { BASE };
