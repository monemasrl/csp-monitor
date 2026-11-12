import { describe, expect, it } from 'vitest';
import { EmailChannel } from '../../src/alerts/channels.js';
import { escapeHtml, renderAlertBatch, renderLearningSummary } from '../../src/alerts/render.js';
import type { AlertBatch, AlertItem, AlertItemAny } from '../../src/alerts/queue.js';
import { loadConfig } from '../../src/config.js';
import { openDb } from '../../src/db/db.js';
import { setSetting } from '../../src/store/settings.js';
import type { Site } from '../../src/store/sites.js';
import { validEnv } from '../helpers.js';

const BASE = 'https://m.example.it';
const site = { id: 3, name: 'Gida\r\nBcc: x', domains: [] } as unknown as Site;
const item = (o: Partial<AlertItem> = {}): AlertItem => ({
  origin: 'https://cdn.example', directive: 'script-src', page: 'https://a.it/', sourceFile: '', sample: '', firstSeen: 0, originId: 7, ...o,
});
const batch = (o: Partial<AlertItem>): AlertBatch => ({ site, items: [{ ...item(o), kind: 'new-origin' }], pendingIds: [1] });

describe('render', () => {
  it('escapes report data in emails', () => {
    const m = renderAlertBatch(batch({ sample: '<script>alert(1)</script>', page: 'https://a.it/"><img src=x>', origin: 'https://e"x<.com' }), BASE);
    expect(m.html).not.toContain('<script>alert');
    expect(m.html).not.toContain('<img');
    expect(m.html).toContain('&lt;script&gt;');
    expect(m.html).toContain('&quot;');
    expect(m.html).not.toContain('e"x<');
  });
  it('escapes the site name and strips CR/LF from the subject', () => {
    const m = renderAlertBatch({ ...batch({}), site: { ...site, name: '<b>S</b>\r\nBcc: x' } }, BASE);
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.subject).toBe('[CSP Monitor] <b>S</b> Bcc: x: 1 origini nuove');
    expect(m.html).not.toContain('<b>S</b>');
  });
  it('links to the origin and prefers sourceFile over sample', () => {
    const m = renderAlertBatch(batch({ sourceFile: 'https://x/app.js', sample: 'zzz' }), BASE);
    expect(m.text).toContain(`${BASE}/sites/3/origins/7`);
    expect(m.text).toContain('https://x/app.js');
    const m2 = renderAlertBatch(batch({ sample: 'zzz' }), BASE);
    expect(m2.text).toContain('zzz');
  });
  it('learning summary, with and without items', () => {
    expect(renderLearningSummary(site, [item(), item({ originId: 8 })], BASE).subject).toMatch(/fine apprendimento, 2 origini da rivedere$/);
    const e = renderLearningSummary(site, [], BASE);
    expect(e.text).toContain('nessuna origine da rivedere');
    expect(e.subject).not.toMatch(/[\r\n]/);
  });
  it('escapeHtml', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
});

describe('EmailChannel', () => {
  const config = loadConfig(validEnv());
  it('sends to the settings recipient, falling back to config', async () => {
    const db = openDb(':memory:');
    const ch = new EmailChannel(config.smtp, () => 'admin@example.it', { jsonTransport: true });
    const res = await ch.sendRaw({ subject: 'S', text: 't', html: '<p>h</p>' });
    const parsed = JSON.parse(res.message as string);
    expect(parsed.to[0].address).toBe('admin@example.it');
    expect(parsed.from.address).toBe('csp@example.it');
    expect(parsed.subject).toBe('S');
    expect(parsed.html).toBe('<p>h</p>');
    setSetting(db, 'alert_email', 'other@example.it');
    const ch2 = EmailChannel.fromConfig(db, config, { jsonTransport: true });
    expect(JSON.parse((await ch2.sendRaw({ subject: 'S', text: 't', html: 'h' })).message as string).to[0].address).toBe('other@example.it');
  });

  it('groups mixed kinds with one title each and a generic subject', () => {
    const items: AlertItemAny[] = [
      { ...item(), kind: 'new-origin' }, { ...item({ originId: 8, origin: 'https://b.example' }), kind: 'hash-changed' },
      { ...item({ originId: 9 }), kind: 'hash-changed' },
    ];
    const m = renderAlertBatch({ site: { ...site, name: 'S' }, items, pendingIds: [1, 2, 3] }, BASE);
    expect(m.subject).toBe('[CSP Monitor] S: 3 segnalazioni');
    expect(m.text).toContain('== Nuova origine (1) ==');
    expect(m.text).toContain('== Script modificato (2) ==');
    expect(m.html).toContain('<h3>Script modificato (2)</h3>');
  });
  it('non-CSP origin items link to their type page, CSP ones to the origin page', () => {
    const items: AlertItemAny[] = [
      { ...item(), kind: 'new-origin', reportType: 'csp-violation' },
      { ...item({ originId: 8 }), kind: 'hash-changed', reportType: 'csp-hash' },
      { ...item({ originId: 9 }), kind: 'permission', reportType: 'permissions-policy-violation' },
    ];
    const m = renderAlertBatch({ site: { ...site, name: 'S' }, items, pendingIds: [1, 2, 3] }, BASE);
    expect(m.text).toContain(`${BASE}/sites/3/origins/7`);
    expect(m.text).toContain(`${BASE}/sites/3/types/csp-hash`);
    expect(m.text).toContain(`${BASE}/sites/3/types/permissions-policy`);
    expect(m.text).not.toContain('/origins/8');
    expect(m.html).toContain(`href="${BASE}/sites/3/types/permissions-policy"`);
  });
  it('origin items with a payload show the payload too, escaped', () => {
    const items: AlertItemAny[] = [
      { ...item({ origin: 'UnloadHandler', directive: 'api' }), kind: 'deprecation-reminder', payload: { api: 'UnloadHandler', removal: '2027-03-01' } },
      { ...item({ originId: 8, origin: 'https://a.it/app.js', directive: 'script' }), kind: 'hash-changed',
        payload: { previousHash: 'sha256-<old>', currentHash: 'sha256-new\r\nBcc: y' } },
    ];
    const m = renderAlertBatch({ site: { ...site, name: 'S' }, items, pendingIds: [1, 2] }, BASE);
    expect(m.text).toContain('UnloadHandler (api) — api: UnloadHandler, removal: 2027-03-01');
    expect(m.text).toContain('previousHash: sha256-<old>, currentHash: sha256-new Bcc: y');
    expect(m.text).not.toMatch(/\nBcc: y/);
    expect(m.html).toContain('removal: 2027-03-01');
    expect(m.html).toContain('previousHash: sha256-&lt;old&gt;');
    expect(m.html).not.toContain('<old>');
  });
  it('escapes data of a non-origin kind and links payload items to the site', () => {
    const items: AlertItemAny[] = [{ ...item({ originId: 0, origin: '', directive: '' }), kind: 'nel-rate', payload: { host: '<img src=x>\r\nBcc: y' } }];
    const m = renderAlertBatch({ site: { ...site, name: 'S' }, items, pendingIds: [1] }, BASE);
    expect(m.html).not.toContain('<img');
    expect(m.html).toContain('&lt;img src=x&gt;');
    expect(m.text).not.toMatch(/\nBcc: y/);
    expect(m.text).toContain(`${BASE}/sites/3`);
    expect(m.subject).toBe('[CSP Monitor] S: Errori di rete oltre soglia (1)');
  });
});
