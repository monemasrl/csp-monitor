import { describe, expect, it } from 'vitest';
import type { AlertChannel } from '../../src/alerts/channels.js';
import { dueBatches, enqueueAlert, markSent, runDueAlerts, runLearningSummaries } from '../../src/alerts/queue.js';
import { recordCspEvent } from '../../src/store/origins.js';
import { createSite, getSite } from '../../src/store/sites.js';
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
    enqueueAlert(db, s1.id, o(s1, 'https://c1.example'), T);
    await runDueAlerts(withChannels(deps, [flaky]), T + 600_000);
    expect(flaky.sent).toHaveLength(0);
    await runDueAlerts(withChannels(deps, [flaky]), T + 660_000);
    await runDueAlerts(withChannels(deps, [flaky]), T + 720_000);
    expect(flaky.sent).toHaveLength(1);
  });

  it('does not mark sent if any channel fails, and one batch failing does not block another', async () => {
    const { deps, db, s1, s2, o } = setup();
    enqueueAlert(db, s1.id, o(s1, 'https://c1.example'), T);
    enqueueAlert(db, s2.id, o(s2, 'https://c2.example'), T);
    const good = fake();
    const bad = { name: 'bad', async send(m: { subject: string }) { if (m.subject.includes('S1')) throw new Error('x'); } };
    await runDueAlerts(withChannels(deps, [good, bad]), T + 600_000);
    expect(dueBatches(db, T + 600_000).map(b => b.site.id)).toEqual([s1.id]);
  });
});

describe('learning summary', () => {
  it('sends once, with only alertable new origins, even when empty', async () => {
    const { deps, db, s1, s2, o } = setup();
    o(s1, 'https://c1.example');
    recordCspEvent(db, s1, ev('inline', { category: 'inline' }), T);
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

  it('retries when sending fails and skips sites still learning', async () => {
    const deps = testDeps(); const db = deps.db;
    const s = createSite(db, { name: 'S', domains: ['a.example.it'] }, T - 20 * 86400_000);
    createSite(db, { name: 'Young', domains: ['y.example.it'] }, T);
    const ch = fake(1);
    await runLearningSummaries(withChannels(deps, [ch]), T);
    expect(getSite(db, s.id)!.learningSummarySent).toBe(false);
    await runLearningSummaries(withChannels(deps, [ch]), T + 60_000);
    expect(ch.sent).toHaveLength(1);
    expect(getSite(db, s.id)!.learningSummarySent).toBe(true);
  });
});
export { BASE };
