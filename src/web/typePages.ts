// One definition per report type: the generic TypePage view renders whatever a definition describes.
// Texts come from the approved mockup; "Quando ti avvisa" follows the rules implemented in src/ingest/handlers.
import type { Db } from '../db/db.js';
import { buildHeaderSet, type HeaderEntry, type HeaderFeature } from '../headers.js';
import { releaseUntil } from '../ingest/handlers/hash.js';
import { SENSITIVE_FEATURES } from '../ingest/handlers/simple.js';
import type { Site } from '../store/sites.js';
import { fmtAgo, fmtDate, fmtNum } from './format.js';
import {
  browserShare, MAX_ROWS, suggestedSources, typeRows, typeSeries, typeStats, type BrowserShare, type Series, type StatusKey, type TypeRow, type TypeStats,
} from './queries.js';
import { STATUS_LABEL } from './views/components.js';

export type Cell = { v: string; cls?: string } | { status: StatusKey };
export type TypeMetric = { label: string; value: string; sub: string; tone?: 'danger' | 'warning' };
export type TypeFilter = { name: string; all: string; of(r: TypeRow): string; label?(v: string): string };
export type Family = 'attack' | 'failure' | 'policy';
export type TypePageDef = {
  type: string; slug: string; family: Family; menu: string; title: string; description: string;
  metrics(db: Db, siteId: number, now: number): TypeMetric[];
  chartTitle: string; tableTitle: string; columns: string[]; row(o: TypeRow, now: number): Cell[]; filters: TypeFilter[];
  /** Rows get Approva / Sospetta: the type alerts only on rows that are not approved. */
  review: boolean;
  alertRule: string; setupNote: string; setupFeature: HeaderFeature | null;
};

export const FAMILIES: { key: Family; label: string }[] = [
  { key: 'attack', label: 'Segnali di attacco' },
  { key: 'failure', label: 'Guasti del browser' },
  { key: 'policy', label: 'Igiene delle policy' },
];

const DAY = 86_400_000;
const LEARNING = ' Durante l’apprendimento non arriva nessuna email.';
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const mono = (v: string): Cell => ({ v: v || '—', cls: 'mono' });
const muted = (v: string): Cell => ({ v: v || '—', cls: 'muted' });
const mode = (o: TypeRow): string => (o.last.disposition === 'enforce' ? 'bloccante' : 'report-only');
const fileLine = (file: string, line: unknown): string => (file && typeof line === 'number' ? `${file}:${line}` : file);
const tail = (o: TypeRow, now: number): Cell[] => [{ v: fmtNum(o.count) }, muted(fmtAgo(o.lastSeen, now))];
const card = (label: string, value: number | string, sub: string, tone?: TypeMetric['tone']): TypeMetric =>
  ({ label, value: typeof value === 'number' ? fmtNum(value) : value, sub, ...(tone ? { tone } : {}) });
const reports = (label: string, s: TypeStats): TypeMetric => card(label, s.reports30, `${fmtNum(s.reports7)} negli ultimi 7 giorni`);
const pages = (s: TypeStats): TypeMetric => card('Pagine coinvolte', s.pages30, 'ultimi 30 giorni');
const enforced = (label: string, s: TypeStats): TypeMetric =>
  card(label, s.enforce30, 'con la policy bloccante, 30 gg', s.enforce30 > 0 ? 'danger' : undefined);

const byA = (all: string): TypeFilter => ({ name: 'a', all, of: r => r.directive });
const byB = (all: string): TypeFilter => ({ name: 'b', all, of: r => r.origin });
const byMode: TypeFilter = { name: 'mode', all: 'Report-only e bloccante', of: mode };
const byStatus: TypeFilter = { name: 'status', all: 'Tutti gli stati', of: r => r.status, label: v => STATUS_LABEL(v as StatusKey) };

type Spec = Omit<TypePageDef, 'metrics'> & { cards(s: TypeStats, db: Db, siteId: number, now: number): TypeMetric[] };
const def = ({ cards, ...d }: Spec): TypePageDef => ({ ...d, metrics: (db, siteId, now) => cards(typeStats(db, siteId, d.type, now), db, siteId, now) });

export const TYPE_PAGES: TypePageDef[] = [
  // Its page is the Plan-1 CSP page (/sites/:id/csp): only menu, title and numbers are used from here.
  def({
    type: 'csp-violation', slug: 'csp-violation', family: 'attack', menu: 'Violazioni CSP', title: 'Violazioni CSP',
    description: 'Una risorsa è stata caricata, o ha provato a caricarsi, fuori dalla Content Security Policy del sito.',
    cards: s => [reports('Report 30 gg', s), card('Origini', s.keysB, 'distinte'), card('Da rivedere', s.newRows, 'righe nuove', s.newRows > 0 ? 'danger' : undefined)],
    chartTitle: '', tableTitle: '', columns: [], row: () => [], filters: [], review: true, alertRule: '', setupNote: '', setupFeature: 'csp',
  }),
  def({
    type: 'csp-hash', slug: 'csp-hash', family: 'attack', menu: 'Hash degli script', title: 'Hash degli script',
    description: 'Il browser riporta l’hash di ogni script che la pagina esegue. Diventa l’inventario degli script del sito, preso dal traffico reale: se un file cambia contenuto senza un tuo rilascio, lo vedi qui.',
    cards: (s, db, siteId, now) => {
      const changed = typeRows(db, siteId, 'csp-hash').filter(r => Number(r.detail.changedAt) >= now - 30 * DAY).length;
      return [
        card('Script distinti', s.rows, `${fmtNum(s.newRows)} da rivedere`),
        card('Hash cambiati', changed, 'stesso URL, contenuto diverso · 30 gg', changed > 0 ? 'danger' : undefined),
        card('Script nuovi', s.new7, 'comparsi negli ultimi 7 giorni', s.new7 > 0 ? 'warning' : undefined),
      ];
    },
    chartTitle: 'Report degli script per giorno', tableTitle: 'Inventario script',
    columns: ['Script', 'Hash attuale', 'Pagine', 'Cambiato', 'Varia spesso', 'Stato', 'Ultima vista'],
    row: (o, now) => {
      const list = Array.isArray(o.detail.pages) ? o.detail.pages.filter((p): p is string => typeof p === 'string') : [];
      const changedAt = Number(o.detail.changedAt);
      return [
        mono(o.origin.startsWith('inline:') ? `inline · ${o.origin.slice(7)}` : o.origin), { v: str(o.detail.currentHash) || '—', cls: 'mono muted' },
        list.length === 1 ? mono(list[0]!) : { v: list.length === 0 ? '—' : `${list.length} pagine` },
        muted(Number.isFinite(changedAt) && changedAt > 0 ? fmtAgo(changedAt, now) : ''),
        { v: o.detail.volatile === true ? 'sì' : 'no' }, { status: o.status }, muted(fmtAgo(o.lastSeen, now)),
      ];
    },
    filters: [byStatus], review: true,
    alertRule: 'Email quando compare uno script mai visto, e quando uno script già noto cambia hash: una volta sola, finché non lo rivedi (Approva o Sospetta). Nessuna email per gli script segnati come “varia spesso” (tag manager) né durante un rilascio di un’ora avviato da questa pagina.' + LEARNING,
    setupNote: 'Si aggiunge la parola chiave report-sha256 a script-src. Funziona solo sui browser basati su Chromium recenti: gli altri non mandano niente.',
    setupFeature: 'csp-hash',
  }),
  def({
    type: 'integrity-violation', slug: 'integrity-violation', family: 'attack', menu: 'Integrità (SRI)', title: 'Violazioni di integrità',
    description: 'Un file non corrisponde più all’hash Subresource Integrity dichiarato nella pagina. O l’ha cambiato il tuo build, o l’ha cambiato qualcun altro, per esempio su una CDN esterna.',
    cards: s => [reports('Report 30 gg', s), card('File coinvolti', s.keysB, 'risorse diverse', s.keysB > 0 ? 'danger' : undefined), pages(s)],
    chartTitle: 'Violazioni nel tempo', tableTitle: 'File che non corrispondono',
    columns: ['Risorsa', 'Destinazione', 'Pagina', 'Modalità', 'Report', 'Ultima vista'],
    row: (o, now) => [mono(o.origin), { v: o.directive }, mono(o.last.page), { v: mode(o) }, ...tail(o, now)],
    filters: [byA('Tutte le destinazioni'), byMode], review: false,
    alertRule: 'Email al primo report su ogni file, anche se approvato: una violazione di integrità non è mai rumore. Se l’hai cambiato tu, aggiorna l’attributo integrity nella pagina.' + LEARNING,
    setupNote: 'Serve l’attributo integrity sugli script esterni e un header che chieda i report. Il supporto è ancora limitato ai browser Chromium recenti.',
    setupFeature: 'integrity',
  }),
  def({
    type: 'connection-allowlist', slug: 'connection-allowlist', family: 'attack', menu: 'Connessioni non dichiarate', title: 'Connessioni non dichiarate',
    description: 'La pagina ha aperto una connessione verso un dominio che non hai dichiarato: fetch, beacon, WebSocket. È il modo in cui si nota un furto di dati, per esempio da un form di pagamento o di login.',
    cards: s => [
      card('Connessioni segnalate', s.reports30, `su ${fmtNum(s.keysB)} destinazioni`),
      card('Destinazioni da rivedere', s.newRows, 'non approvate', s.newRows > 0 ? 'danger' : undefined), pages(s),
    ],
    chartTitle: 'Connessioni non dichiarate per giorno', tableTitle: 'Destinazioni',
    columns: ['Destinazione', 'Tipo', 'Pagina', 'Stato', 'Report', 'Ultima vista'],
    row: (o, now) => [mono(o.origin), { v: o.directive }, mono(o.last.page), { status: o.status }, ...tail(o, now)],
    filters: [byA('Tutti i tipi'), byStatus], review: true,
    alertRule: 'Email alla prima comparsa di una destinazione non approvata. Se la pagina è tra i percorsi sensibili del sito (pagamento, login) l’email parte subito, senza aspettare il raggruppamento. Le destinazioni approvate non avvisano più.' + LEARNING,
    setupNote: 'Proposta in fase sperimentale: l’header e il formato possono cambiare e oggi pochi browser lo inviano. Nel frattempo connect-src della CSP copre buona parte dei casi.',
    setupFeature: 'connection',
  }),
  def({
    type: 'network-error', slug: 'network-error', family: 'failure', menu: 'Errori di rete', title: 'Errori di rete (NEL)',
    description: 'Errori DNS, certificati TLS non validi, connessioni interrotte: richieste che non arrivano mai al server, quindi assenti dai suoi log. Le registra il browser che le ha subite.',
    cards: s => [reports('Errori 30 gg', s), card('Tipi di errore', s.keysA, 'distinti'), card('Host coinvolti', s.keysB, 'distinti')],
    chartTitle: 'Errori di rete per giorno', tableTitle: 'Errori per tipo',
    columns: ['Tipo errore', 'Fase', 'Host', 'Codice HTTP', 'Report', 'Ultima vista'],
    row: (o, now) => [mono(o.directive), { v: o.last.sample || '—' }, mono(o.origin), muted(o.last.line === null ? '' : String(o.last.line)), ...tail(o, now)],
    filters: [byA('Tutti i tipi'), byB('Tutti gli host')], review: false,
    alertRule: 'Email se gli errori superano lo 0,5% delle richieste campionate in circa 15 minuti, con almeno 200 richieste nel periodo (al massimo una ogni 6 ore), oppure subito al primo errore di certificato TLS. I singoli errori sparsi restano in dashboard: sono reti mobili instabili.' + LEARNING,
    setupNote: 'NEL usa ancora il vecchio header Report-To con un gruppo, oltre a Reporting-Endpoints. Solo browser Chromium.',
    setupFeature: 'nel',
  }),
  def({
    type: 'crash', slug: 'crash', family: 'failure', menu: 'Crash', title: 'Crash',
    description: 'La scheda si è bloccata o ha finito la memoria. Una pagina morta non può eseguire script di monitoraggio: l’unico testimone è il browser, che manda il report alla visita successiva.',
    cards: s => [reports('Crash 30 gg', s), card('Motivi diversi', s.keysA, 'per esempio memoria esaurita'), card('Pagine coinvolte', s.keysB, 'distinte')],
    chartTitle: 'Crash per giorno', tableTitle: 'Crash per motivo e pagina',
    columns: ['Motivo', 'Pagina', 'Browser', 'Report', 'Ultima vista'],
    row: (o, now) => [mono(o.directive), mono(o.origin), muted(o.last.ua), ...tail(o, now)],
    filters: [byA('Tutti i motivi'), byB('Tutte le pagine')], review: false,
    alertRule: 'Nessuna email per i crash singoli. Avvisa se i crash di una pagina negli ultimi 7 giorni sono almeno 5 e almeno il doppio dei 7 giorni prima (al massimo una volta a settimana per pagina): di solito è un rilascio con un problema di memoria.' + LEARNING,
    setupNote: 'Basta l’endpoint default in Reporting-Endpoints. Solo browser Chromium.',
    setupFeature: null,
  }),
  def({
    type: 'deprecation', slug: 'deprecation', family: 'failure', menu: 'Deprecazioni', title: 'Deprecazioni',
    description: 'Le pagine usano un’API che il browser ha in programma di eliminare, con la data di rimozione quando è nota. Ti dà il tempo di aggiornare il sito prima che smetta di funzionare.',
    cards: (s, db, siteId, now) => {
      const dated = typeRows(db, siteId, 'deprecation').map(r => ({ api: r.origin, at: Number(r.detail.anticipatedRemoval) }))
        .filter(x => Number.isFinite(x.at) && x.at > 0);
      const next = dated.filter(x => x.at > now).sort((a, b) => a.at - b.at)[0];
      return [
        reports('Report 30 gg', s),
        card('API deprecate', s.rows, `${fmtNum(dated.length)} con data di rimozione`),
        next ? card('Prossima rimozione', fmtDate(next.at), next.api, next.at - now < 30 * DAY ? 'danger' : 'warning')
          : card('Prossima rimozione', '—', 'nessuna data annunciata'),
      ];
    },
    chartTitle: 'Report di deprecazione per giorno', tableTitle: 'API deprecate in uso',
    columns: ['API', 'Messaggio', 'File e riga', 'Rimozione', 'Report', 'Ultima vista'],
    row: (o, now) => {
      const at = Number(o.detail.anticipatedRemoval);
      return [mono(o.origin), { v: str(o.detail.message) || '—' }, mono(fileLine(str(o.detail.sourceFile), o.detail.line)),
        muted(Number.isFinite(at) && at > 0 ? fmtDate(at) : ''), ...tail(o, now)];
    },
    filters: [byB('Tutte le API'), { name: 'removal', all: 'Con e senza data', of: r => (Number(r.detail.anticipatedRemoval) > 0 ? 'con data di rimozione' : 'senza data') }],
    review: false,
    alertRule: 'Email una volta sola quando compare un’API con una data di rimozione futura, e un promemoria 30 giorni prima della data. Le API senza data restano in dashboard. Durante l’apprendimento la prima email non parte, ma il promemoria resta in programma.',
    setupNote: 'I report di deprecazione vanno all’endpoint default. Solo browser Chromium.',
    setupFeature: null,
  }),
  def({
    type: 'intervention', slug: 'intervention', family: 'failure', menu: 'Interventi', title: 'Interventi del browser',
    description: 'Il browser ha cambiato da solo il comportamento della pagina: un video in autoplay bloccato, uno script lento rallentato, un’immagine pesante non caricata su rete lenta. Il sito funziona diversamente da come pensi.',
    cards: s => [reports('Interventi 30 gg', s), card('Tipi diversi', s.keysA, 'distinti'), pages(s)],
    chartTitle: 'Interventi per giorno', tableTitle: 'Interventi per tipo',
    columns: ['Intervento', 'Messaggio', 'File e riga', 'Pagina', 'Report', 'Ultima vista'],
    row: (o, now) => [mono(o.directive), { v: o.last.sample || '—' }, mono(fileLine(o.origin === '—' ? '' : o.origin, o.last.line)), mono(o.last.page), ...tail(o, now)],
    filters: [byA('Tutti i tipi')], review: false,
    alertRule: 'Nessuna email: sono informazioni per migliorare il sito, non problemi di sicurezza.',
    setupNote: 'Vanno all’endpoint default come le deprecazioni. Solo browser Chromium.',
    setupFeature: null,
  }),
  def({
    type: 'permissions-policy-violation', slug: 'permissions-policy', family: 'policy', menu: 'Permissions Policy', title: 'Permissions Policy',
    description: 'Un codice ha chiesto fotocamera, microfono, posizione o un’altra funzione che la Permissions-Policy del sito vieta. Su un sito vetrina nessuno dovrebbe chiederle: se succede, chiediti chi lo sta facendo.',
    cards: (s, db, siteId) => {
      const sensitive = new Set(typeRows(db, siteId, 'permissions-policy-violation').map(r => r.directive).filter(f => SENSITIVE_FEATURES.includes(f))).size;
      return [
        reports('Violazioni 30 gg', s),
        card('Funzioni richieste', s.keysA, `${fmtNum(sensitive)} sensibili`, sensitive > 0 ? 'danger' : undefined),
        card('Origini responsabili', s.keysB, `${fmtNum(s.newRows)} righe da rivedere`, s.newRows > 0 ? 'warning' : undefined),
      ];
    },
    chartTitle: 'Violazioni per giorno', tableTitle: 'Funzioni richieste',
    columns: ['Funzione', 'Richiesta da', 'Pagina', 'Modalità', 'Stato', 'Report', 'Ultima vista'],
    row: (o, now) => [mono(o.directive), mono(o.origin), mono(o.last.page), { v: mode(o) }, { status: o.status }, ...tail(o, now)],
    filters: [byA('Tutte le funzioni'), byMode], review: true,
    alertRule: 'Email alla prima richiesta di fotocamera, microfono, posizione, pagamento, cattura dello schermo, USB, porta seriale, HID o Bluetooth da un’origine che non hai approvato. Le funzioni che il sito usa davvero (come la mappa dei negozi) si approvano una volta.' + LEARNING,
    setupNote: 'Si dichiarano le funzioni vietate; la variante Report-Only permette di provare senza bloccare. Solo browser Chromium.',
    setupFeature: 'permissions',
  }),
  def({
    type: 'document-policy-violation', slug: 'document-policy', family: 'policy', menu: 'Document Policy', title: 'Document Policy',
    description: 'Un comportamento della pagina ha violato le regole dichiarate nella Document-Policy, per esempio una chiamata XHR sincrona che blocca la pagina. Serve a tenere il sito leggero nel tempo.',
    cards: s => [reports('Violazioni 30 gg', s), card('Regole violate', s.keysA, 'distinte'), card('Pagine coinvolte', s.keysB, 'distinte')],
    chartTitle: 'Violazioni per giorno', tableTitle: 'Regole violate',
    columns: ['Regola', 'Messaggio', 'File', 'Pagina', 'Report', 'Ultima vista'],
    row: (o, now) => [mono(o.directive), { v: o.last.sample || '—' }, mono(o.last.sourceFile), mono(o.origin), ...tail(o, now)],
    filters: [byA('Tutte le regole'), byB('Tutte le pagine')], review: false,
    alertRule: 'Nessuna email: sono indicazioni di qualità.',
    setupNote: 'Funzione ancora sperimentale e solo nei browser Chromium. Ha senso attivarla su pochi siti, in report-only.',
    setupFeature: 'document',
  }),
  def({
    type: 'coop', slug: 'coop', family: 'policy', menu: 'COOP', title: 'COOP',
    description: 'Cross-Origin-Opener-Policy separa le finestre del sito da quelle di altri siti, così una pagina esterna aperta in popup non può manipolare la tua. I report dicono quali interazioni tra finestre verrebbero bloccate prima di attivarla.',
    cards: s => [reports('Report 30 gg', s), card('Finestre coinvolte', s.keysB, 'origini distinte', s.keysB > 0 ? 'warning' : undefined), enforced('Bloccate davvero', s)],
    chartTitle: 'Report per giorno', tableTitle: 'Interazioni tra finestre',
    columns: ['Tipo', 'Altra finestra', 'Pagina', 'Modalità', 'Stato', 'Report', 'Ultima vista'],
    row: (o, now) => [mono(o.directive), mono(o.origin), mono(o.last.page), { v: mode(o) }, { status: o.status }, ...tail(o, now)],
    filters: [byA('Tutti i tipi'), byMode], review: true,
    alertRule: 'Nessuna email in report-only. Quando attivi la policy bloccante, avvisa se compare un’interazione bloccata mai vista e non approvata: di solito è un flusso di login o pagamento che si è rotto.' + LEARNING,
    setupNote: 'Si parte dalla variante Report-Only e si attiva quella vera solo quando i report sono puliti.',
    setupFeature: 'coop',
  }),
  def({
    type: 'coep', slug: 'coep', family: 'policy', menu: 'COEP', title: 'COEP',
    description: 'Cross-Origin-Embedder-Policy richiede che ogni risorsa esterna dichiari di poter essere incorporata. Serve per alcune funzioni avanzate del browser; i report elencano le risorse che verrebbero bloccate.',
    cards: s => [reports('Report 30 gg', s), card('Risorse da sistemare', s.keysB, 'distinte', s.keysB > 0 ? 'warning' : undefined), enforced('Bloccate davvero', s)],
    chartTitle: 'Report per giorno', tableTitle: 'Risorse che verrebbero bloccate',
    columns: ['Risorsa', 'Destinazione', 'Pagina', 'Modalità', 'Stato', 'Report', 'Ultima vista'],
    row: (o, now) => [mono(o.origin), { v: o.directive }, mono(o.last.page), { v: mode(o) }, { status: o.status }, ...tail(o, now)],
    filters: [byA('Tutte le destinazioni'), byMode], review: true,
    alertRule: 'Nessuna email in report-only: è una lista di lavoro, non un allarme. Se attivi la policy bloccante, avvisa quando viene bloccata una risorsa nuova non approvata.' + LEARNING,
    setupNote: 'Si usa solo se ti serve la cross-origin isolation. Su un sito vetrina di solito non vale la pena attivarla.',
    setupFeature: 'coep',
  }),
];

export const typePageBySlug = (slug: string): TypePageDef | undefined => TYPE_PAGES.find(d => d.slug === slug);
export const typePageHref = (siteId: number, d: TypePageDef): string =>
  d.slug === 'csp-violation' ? `/sites/${siteId}/csp` : `/sites/${siteId}/types/${d.slug}`;
/** Report types whose rows can be approved or marked suspect from their page. */
export const REVIEWABLE_TYPES = new Set(TYPE_PAGES.filter(d => d.review).map(d => d.type));

export type TypeFilterState = { name: string; all: string; options: { value: string; label: string }[]; selected: string };
export type TypePageData = {
  site: Site; def: TypePageDef; metrics: TypeMetric[]; series: Series; browsers: BrowserShare; rows: TypeRow[]; truncated: boolean;
  filters: TypeFilterState[]; headers: HeaderEntry[]; releaseUntil: number;
};

/** Everything the generic page shows; `query` values only filter when they match an existing option. */
export function typePageData(db: Db, site: Site, d: TypePageDef, now: number, baseUrl: string, query: Record<string, string>): TypePageData {
  const all = typeRows(db, site.id, d.type);
  const filters = d.filters.map((f): TypeFilterState => {
    const values = [...new Set(all.map(f.of))].sort();
    const q = query[f.name] ?? '';
    return { name: f.name, all: f.all, options: values.map(v => ({ value: v, label: f.label ? f.label(v) : v })), selected: values.includes(q) ? q : '' };
  });
  const rows = all.filter(r => d.filters.every((f, i) => !filters[i]!.selected || f.of(r) === filters[i]!.selected));
  const features: HeaderFeature[] = d.setupFeature === 'csp-hash' ? ['csp', 'csp-hash'] : d.setupFeature ? [d.setupFeature] : [];
  return {
    site, def: d, metrics: d.metrics(db, site.id, now), series: typeSeries(db, site.id, d.type, now),
    browsers: browserShare(db, site.id, now, d.type), rows: rows.slice(0, MAX_ROWS), truncated: rows.length > MAX_ROWS, filters,
    // the site's approved CSP sources, so pasting the csp-hash setup never drops the tuned policy
    headers: buildHeaderSet(baseUrl, site.key, features, suggestedSources(db, site.id)),
    releaseUntil: d.type === 'csp-hash' ? releaseUntil(db, site.id) : 0,
  };
}
