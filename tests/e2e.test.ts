import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AlertChannel, AlertMessage } from '../src/alerts/channels.js';
import { runDueAlerts } from '../src/alerts/queue.js';
import { NOW } from './helpers.js';
import { dash } from './web/dash.js';

const MIN = 60_000;
const chrome = readFileSync(new URL('./fixtures/reports-json-chrome.json', import.meta.url), 'utf8');

describe('end to end', () => {
  it('site -> report -> grouped alert -> review -> approve -> no further alert', async () => {
    let t = NOW;
    const sent: AlertMessage[] = [];
    const channel: AlertChannel = { name: 'fake', send: async (m) => { sent.push(m); } };
    const { deps, db, app, get, post } = dash({ now: () => t, channels: [channel] });

    // create a site and close the learning period
    expect((await post('/sites', { name: 'Gida', domains: 'www.gida-spa.it' })).status).toBe(303);
    const site = db.prepare('SELECT id, key FROM sites').get() as { id: number; key: string };
    expect((await post(`/sites/${site.id}/end-learning`)).status).toBe(303);

    const report = () => app.request(`/r/${site.key}`, {
      method: 'POST', headers: { 'content-type': 'application/reports+json' }, body: chrome,
    });
    expect((await report()).status).toBe(204);

    // nothing before the grouping window, one message after it
    t += 5 * MIN;
    await runDueAlerts(deps, t);
    expect(sent).toHaveLength(0);
    t += 5 * MIN;
    await runDueAlerts(deps, t);
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0])).toContain('https://cdn-stats.xyz');

    // the origin is listed under "Da rivedere"
    const page = await (await get(`/sites/${site.id}`)).text();
    expect(page).toContain('Da rivedere');
    expect(page).toContain('https://cdn-stats.xyz');

    // approve it
    const row = db.prepare("SELECT id FROM origins WHERE origin = 'https://cdn-stats.xyz'").get() as { id: number };
    expect((await post(`/sites/${site.id}/origins/${row.id}/approve`, { scope: 'site' })).status).toBe(303);

    // the same origin again: no new pending alert, no message
    expect((await report()).status).toBe(204);
    expect(db.prepare('SELECT COUNT(*) n FROM pending_alerts WHERE sent_at IS NULL').get()).toEqual({ n: 0 });
    t += 10 * MIN;
    await runDueAlerts(deps, t);
    expect(sent).toHaveLength(1);
  });
});
