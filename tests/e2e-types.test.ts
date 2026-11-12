import { describe, expect, it } from 'vitest';
import { ALERT_KINDS } from '../src/alerts/kinds.js';
import type { AlertChannel, AlertMessage } from '../src/alerts/channels.js';
import { runDueAlerts } from '../src/alerts/queue.js';
import { runReminders } from '../src/ingest/handlers/deprecation.js';
import { NOW } from './helpers.js';
import { dash } from './web/dash.js';

const MIN = 60_000;
const DAY = 86_400_000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const API = 'PrefixedStorageInfo';

describe('end to end: report types', () => {
  it('one POST with four reports -> grouped alert, reminder 30 days before removal, type pages', async () => {
    let t = NOW;
    const sent: AlertMessage[] = [];
    const channel: AlertChannel = { name: 'fake', send: async (m) => { sent.push(m); } };
    const { deps, db, app, get, post } = dash({ now: () => t, channels: [channel] });

    expect((await post('/sites', { name: 'Gida', domains: 'www.gida-spa.it' })).status).toBe(303);
    const site = db.prepare('SELECT id, key FROM sites').get() as { id: number; key: string };
    expect((await post(`/sites/${site.id}/end-learning`)).status).toBe(303);

    const removal = new Date(NOW + 60 * DAY).toISOString().slice(0, 10);
    const base = { age: 5, user_agent: UA };
    const reports = [
      { ...base, type: 'integrity-violation', url: 'https://www.gida-spa.it/prodotti', body: {
        documentURL: 'https://www.gida-spa.it/prodotti', blockedURL: 'https://cdn.example.net/lib.js?v=3', destination: 'script', reportOnly: false } },
      { ...base, type: 'deprecation', url: 'https://www.gida-spa.it/vecchia', body: {
        id: API, message: 'Obsolete API.', anticipatedRemoval: removal, sourceFile: 'https://www.gida-spa.it/js/old.js', lineNumber: 7, columnNumber: 2 } },
      { ...base, type: 'intervention', url: 'https://www.gida-spa.it/news', body: {
        id: 'NoPassiveScrollBlocking', message: 'Handling of wheel event was delayed.', sourceFile: 'https://www.gida-spa.it/js/slider.js', lineNumber: 120, columnNumber: 9 } },
      { ...base, type: 'csp-violation', url: 'https://www.gida-spa.it/prodotti', body: {
        blockedURL: 'https://cdn-stats.xyz/c.js', columnNumber: 13, disposition: 'report', documentURL: 'https://www.gida-spa.it/prodotti',
        effectiveDirective: 'script-src-elem', lineNumber: 42, originalPolicy: "default-src 'self'", referrer: '', sample: '',
        sourceFile: 'https://www.gida-spa.it/prodotti', statusCode: 200 } },
    ];
    const res = await app.request(`/r/${site.key}`, {
      method: 'POST', headers: { 'content-type': 'application/reports+json' }, body: JSON.stringify(reports),
    });
    expect(res.status).toBe(204);

    // nothing before the grouping window
    t += 5 * MIN;
    await runDueAlerts(deps, t);
    expect(sent).toHaveLength(0);

    // one grouped email after 10 minutes
    t += 5 * MIN;
    await runDueAlerts(deps, t);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe('[CSP Monitor] Gida: 3 segnalazioni');
    const mail = `${sent[0]!.text}\n${sent[0]!.html}`;
    for (const k of ['integrity', 'deprecation', 'new-origin'] as const) expect(mail).toContain(ALERT_KINDS[k].label);
    expect(mail).toContain('cdn-stats.xyz');
    expect(mail).not.toContain('NoPassiveScrollBlocking');
    expect(mail).not.toContain('slider.js');

    // every type page shows its row (before the clock moves: the login cookie lasts 30 days)
    const page = async (path: string) => (await get(path)).text();
    expect(await page(`/sites/${site.id}/types/integrity-violation`)).toContain('cdn.example.net');
    expect(await page(`/sites/${site.id}/types/deprecation`)).toContain(API);
    expect(await page(`/sites/${site.id}/types/intervention`)).toContain('NoPassiveScrollBlocking');
    expect(await page(`/sites/${site.id}/csp`)).toContain('cdn-stats.xyz');

    // 30 days later: removal - 30 days -> one reminder, then nothing
    t = NOW + 30 * DAY;
    await runReminders(deps, t);
    await runDueAlerts(deps, t);
    expect(sent).toHaveLength(2);
    expect(`${sent[1]!.subject}\n${sent[1]!.text}`).toContain(API);
    await runReminders(deps, t);
    await runDueAlerts(deps, t + 10 * MIN);
    expect(sent).toHaveLength(2);
  });
});
