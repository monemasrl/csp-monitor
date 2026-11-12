import type { Site } from '../store/sites.js';
import type { AlertMessage } from './channels.js';
import type { AlertBatch, AlertItem } from './queue.js';

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Header-safe: line terminators from data never reach the subject. */
function oneLine(s: string): string {
  return s.replace(/[\r\n\u2028\u2029]+/g, ' ').trim();
}

function link(baseUrl: string, siteId: number, originId: number): string {
  return `${baseUrl.replace(/\/+$/, '')}/sites/${siteId}/origins/${originId}`;
}

/** Source file when known, otherwise the script sample. */
function detail(i: AlertItem): string {
  return i.sourceFile || i.sample;
}

function render(site: Site, items: AlertItem[], baseUrl: string, subject: string, intro: string): AlertMessage {
  const textItems = items.map(i => [
    `- ${oneLine(i.origin)}`,
    `  Direttiva: ${oneLine(i.directive)}`,
    `  Pagina: ${oneLine(i.page)}`,
    ...(detail(i) ? [`  File/sample: ${oneLine(detail(i))}`] : []),
    `  ${link(baseUrl, site.id, i.originId)}`,
  ].join('\n'));
  const htmlItems = items.map(i => {
    const href = escapeHtml(link(baseUrl, site.id, i.originId));
    return `<li><strong>${escapeHtml(i.origin)}</strong><br>Direttiva: ${escapeHtml(i.directive)}<br>Pagina: ${escapeHtml(i.page)}`
      + (detail(i) ? `<br>File/sample: <code>${escapeHtml(detail(i))}</code>` : '')
      + `<br><a href="${href}">${href}</a></li>`;
  });
  return {
    subject,
    text: `${intro}\n\n${textItems.join('\n\n')}\n`,
    html: `<p>${escapeHtml(intro)}</p><ul>${htmlItems.join('')}</ul>`,
  };
}

export function renderAlertBatch(b: AlertBatch, baseUrl: string): AlertMessage {
  const name = oneLine(b.site.name);
  const n = b.items.length;
  return render(b.site, b.items, baseUrl, `[CSP Monitor] ${name}: ${n} origini nuove`,
    `Sul sito ${name} sono comparse ${n} origini mai viste prima.`);
}

export function renderLearningSummary(site: Site, items: AlertItem[], baseUrl: string): AlertMessage {
  const name = oneLine(site.name);
  const n = items.length;
  const intro = n === 0
    ? `Il periodo di apprendimento del sito ${name} è terminato: nessuna origine da rivedere.`
    : `Il periodo di apprendimento del sito ${name} è terminato: ci sono ${n} origini da rivedere.`;
  return render(site, items, baseUrl, `[CSP Monitor] ${name}: fine apprendimento, ${n} origini da rivedere`, intro);
}
