import type { Site } from '../store/sites.js';
import { TYPE_PAGES, typePageHref } from '../web/typePages.js';
import type { AlertMessage } from './channels.js';
import { ALERT_KINDS, type AlertKind } from './kinds.js';
import type { AlertBatch, AlertItem, AlertItemAny } from './queue.js';

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Header-safe: line terminators from data never reach the subject. */
function oneLine(s: string): string {
  return s.replace(/[\r\n\u2028\u2029]+/g, ' ').trim();
}

/** CSP rows open their origin page, rows of other report types their type page, payload-only items the site. */
function link(baseUrl: string, siteId: number, originId: number, reportType?: string): string {
  const root = baseUrl.replace(/\/+$/, '');
  const def = reportType && reportType !== 'csp-violation' ? TYPE_PAGES.find(d => d.type === reportType) : undefined;
  if (originId && def) return `${root}${typePageHref(siteId, def)}`;
  const base = `${root}/sites/${siteId}`;
  return originId ? `${base}/origins/${originId}` : base;
}

/** Source file when known, otherwise the script sample. */
function detail(i: AlertItem): string {
  return i.sourceFile || i.sample;
}

function textItem(i: AlertItem, site: Site, baseUrl: string): string {
  return [
    `- ${oneLine(i.origin)}`,
    `  Direttiva: ${oneLine(i.directive)}`,
    `  Pagina: ${oneLine(i.page)}`,
    ...(detail(i) ? [`  File/sample: ${oneLine(detail(i))}`] : []),
    `  ${link(baseUrl, site.id, i.originId, i.reportType)}`,
  ].join('\n');
}

function htmlItem(i: AlertItem, site: Site, baseUrl: string): string {
  const href = escapeHtml(link(baseUrl, site.id, i.originId, i.reportType));
  return `<li><strong>${escapeHtml(i.origin)}</strong><br>Direttiva: ${escapeHtml(i.directive)}<br>Pagina: ${escapeHtml(i.page)}`
    + (detail(i) ? `<br>File/sample: <code>${escapeHtml(detail(i))}</code>` : '')
    + `<br><a href="${href}">${href}</a></li>`;
}

/** Items not tied to an origins row: description from the kind, link to the site. */
function textAny(i: AlertItemAny, site: Site, baseUrl: string): string {
  if (i.originId && i.kind === 'new-origin') return textItem(i, site, baseUrl);
  return [`- ${oneLine(ALERT_KINDS[i.kind].describe(i))}`, ...(i.page ? [`  Pagina: ${oneLine(i.page)}`] : []),
    ...(detail(i) ? [`  File/sample: ${oneLine(detail(i))}`] : []), `  ${link(baseUrl, site.id, i.originId, i.reportType)}`].join('\n');
}

function htmlAny(i: AlertItemAny, site: Site, baseUrl: string): string {
  if (i.originId && i.kind === 'new-origin') return htmlItem(i, site, baseUrl);
  const href = escapeHtml(link(baseUrl, site.id, i.originId, i.reportType));
  return `<li><strong>${escapeHtml(ALERT_KINDS[i.kind].describe(i))}</strong>`
    + (i.page ? `<br>Pagina: ${escapeHtml(i.page)}` : '')
    + (detail(i) ? `<br>File/sample: <code>${escapeHtml(detail(i))}</code>` : '')
    + `<br><a href="${href}">${href}</a></li>`;
}

function render(site: Site, items: AlertItem[], baseUrl: string, subject: string, intro: string): AlertMessage {
  const textItems = items.map(i => textItem(i, site, baseUrl));
  const htmlItems = items.map(i => htmlItem(i, site, baseUrl));
  return {
    subject,
    text: `${intro}\n\n${textItems.join('\n\n')}\n`,
    html: `<p>${escapeHtml(intro)}</p><ul>${htmlItems.join('')}</ul>`,
  };
}

export function renderAlertBatch(b: AlertBatch, baseUrl: string): AlertMessage {
  const name = oneLine(b.site.name);
  const n = b.items.length;
  const groups = new Map<AlertKind, AlertItemAny[]>();
  for (const i of b.items) groups.set(i.kind, [...(groups.get(i.kind) ?? []), i]);
  const kinds = [...groups.keys()];
  let subject: string, intro: string;
  if (kinds.length === 1 && kinds[0] === 'new-origin') {
    subject = `[CSP Monitor] ${name}: ${n} origini nuove`;
    intro = `Sul sito ${name} sono comparse ${n} origini mai viste prima.`;
  } else if (kinds.length === 1) {
    subject = `[CSP Monitor] ${name}: ${ALERT_KINDS[kinds[0]!].label} (${n})`;
    intro = `Sul sito ${name}: ${ALERT_KINDS[kinds[0]!].label} (${n}).`;
  } else {
    subject = `[CSP Monitor] ${name}: ${n} segnalazioni`;
    intro = `Sul sito ${name} ci sono ${n} segnalazioni di ${kinds.length} tipi diversi.`;
  }
  const text: string[] = [];
  const html: string[] = [];
  for (const [kind, items] of groups) {
    const title = `${ALERT_KINDS[kind].label} (${items.length})`;
    text.push(`== ${title} ==\n${items.map(i => textAny(i, b.site, baseUrl)).join('\n\n')}`);
    html.push(`<h3>${escapeHtml(title)}</h3><ul>${items.map(i => htmlAny(i, b.site, baseUrl)).join('')}</ul>`);
  }
  return { subject, text: `${intro}\n\n${text.join('\n\n')}\n`, html: `<p>${escapeHtml(intro)}</p>${html.join('')}` };
}

export function renderLearningSummary(site: Site, items: AlertItem[], baseUrl: string): AlertMessage {
  const name = oneLine(site.name);
  const n = items.length;
  const intro = n === 0
    ? `Il periodo di apprendimento del sito ${name} è terminato: nessuna origine da rivedere.`
    : `Il periodo di apprendimento del sito ${name} è terminato: ci sono ${n} origini da rivedere.`;
  return render(site, items, baseUrl, `[CSP Monitor] ${name}: fine apprendimento, ${n} origini da rivedere`, intro);
}
