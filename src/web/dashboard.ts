// Dashboard routes (all behind login: the auth middleware in app.ts runs first).
import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AlertMessage } from '../alerts/channels.js';
import { strictHeaders, suggestedHeaders } from '../headers.js';
import { addApprovalPattern, approveOrigin, markSuspect, removeApproval } from '../store/origins.js';
import { getSetting, setSetting } from '../store/settings.js';
import { createSite, endLearning, getSite, startLearning, updateSite, type Site } from '../store/sites.js';
import { MAX_LEARNING_DAYS } from './views/SiteSettings.js';
import type { Deps } from './app.js';
import {
  addNoisePattern, cspViolations, deleteNoisePattern, lists, navData, originDetail, originOfSite, overview, siteSummary,
} from './queries.js';
import { FETCH_DIRECTIVES, isApprovableSource, parseEmail, parsePattern, parseSiteForm, safeBack, type SiteForm } from './validate.js';
import { AlertSettings, type TestResult } from './views/AlertSettings.js';
import { CspViolations } from './views/CspViolations.js';
import { GlobalLists, type ApprovalForm } from './views/GlobalLists.js';
import { MessagePage } from './views/Layout.js';
import { OriginDetail } from './views/OriginDetail.js';
import { Overview } from './views/Overview.js';
import { SiteDetail } from './views/SiteDetail.js';
import { SiteNew } from './views/SiteNew.js';
import { SiteSettings } from './views/SiteSettings.js';

type Body = Record<string, string | File | (string | File)[]>;
type View = string | Promise<string>;

const SITE = '/sites/:id{[0-9]+}';
const ORIGIN = `${SITE}/origins/:oid{[0-9]+}`;

const TEST_MESSAGE: AlertMessage = {
  subject: 'CSP Monitor: messaggio di prova',
  text: 'Questo è un messaggio di prova di CSP Monitor. Se lo ricevi, gli alert arrivano a questo indirizzo.\n',
  html: '<p>Questo è un messaggio di prova di CSP Monitor. Se lo ricevi, gli alert arrivano a questo indirizzo.</p>',
};

async function render(c: Context, view: unknown, status: ContentfulStatusCode = 200): Promise<Response> {
  const html = String(await (view as View));
  return c.html(`<!doctype html>${html}`, status);
}

async function readForm(c: Context): Promise<Body> {
  return (await c.req.parseBody({ all: true }).catch(() => ({}))) as Body;
}
const one = (b: Body, k: string): string => {
  const v = b[k];
  const x = Array.isArray(v) ? v[0] : v;
  return typeof x === 'string' ? x : '';
};
const many = (b: Body, k: string): string[] => [b[k] ?? []].flat().filter((x): x is string => typeof x === 'string');

export function registerDashboard(app: Hono, deps: Deps): void {
  const { db } = deps;
  const nav = () => navData(db);
  const endpoint = (site: Site) => `${new URL(deps.config.baseUrl).origin}/r/${site.key}`;
  const notFound = (c: Context) =>
    render(c, MessagePage({ nav: nav(), title: 'Pagina non trovata', text: 'Questa pagina non esiste o è stata eliminata.' }), 404);
  const siteOf = (c: Context): Site | null => getSite(db, Number(c.req.param('id')));
  const refuse = (c: Context, text: string, back: string) =>
    render(c, MessagePage({ nav: nav(), title: 'Azione non disponibile', text, back }), 400);

  app.get('/', (c) => render(c, Overview({ nav: nav(), data: overview(db, deps.now()), now: deps.now() })));

  // --- sites ---
  app.get('/sites/new', (c) => render(c, SiteNew({ nav: nav() })));
  app.post('/sites', async (c) => {
    const b = await readForm(c);
    const form: SiteForm = { name: one(b, 'name'), domains: one(b, 'domains') };
    const r = parseSiteForm(form, false);
    if (!r.ok) return render(c, SiteNew({ nav: nav(), form, errors: r.errors }), 400);
    const site = createSite(db, { name: r.value.name, domains: r.value.domains }, deps.now());
    return c.redirect(`/sites/${site.id}`, 303);
  });

  app.get(SITE, (c) => {
    const site = siteOf(c);
    if (!site) return notFound(c);
    const now = deps.now();
    const data = siteSummary(db, site, now);
    return render(c, SiteDetail({
      nav: nav(), data, now,
      strict: strictHeaders(deps.config.baseUrl, site.key),
      suggested: suggestedHeaders(deps.config.baseUrl, site.key, data.approvedSources),
    }));
  });

  app.get(`${SITE}/csp`, (c) => {
    const site = siteOf(c);
    if (!site) return notFound(c);
    const q = c.req.query();
    const data = cspViolations(db, site, deps.now(), { directive: q.directive, status: q.status, noise: q.noise });
    return render(c, CspViolations({ nav: nav(), data, now: deps.now() }));
  });

  app.get(ORIGIN, (c) => {
    const site = siteOf(c);
    const data = site && originDetail(db, site, Number(c.req.param('oid')), deps.now());
    if (!data) return notFound(c);
    return render(c, OriginDetail({ nav: nav(), data }));
  });

  app.get(`${SITE}/settings`, (c) => {
    const site = siteOf(c);
    if (!site) return notFound(c);
    return render(c, SiteSettings({ nav: nav(), site, endpoint: endpoint(site), now: deps.now() }));
  });
  app.post(`${SITE}/settings`, async (c) => {
    const site = siteOf(c);
    if (!site) return notFound(c);
    const b = await readForm(c);
    const form: SiteForm = {
      name: one(b, 'name'), domains: one(b, 'domains'), rate_per_min: one(b, 'rate_per_min'), rate_per_day: one(b, 'rate_per_day'),
    };
    const r = parseSiteForm(form, true);
    if (!r.ok) {
      return render(c, SiteSettings({ nav: nav(), site, endpoint: endpoint(site), now: deps.now(), form, errors: r.errors }), 400);
    }
    updateSite(db, site.id, r.value);
    return c.redirect(`/sites/${site.id}`, 303);
  });

  app.post(`${SITE}/end-learning`, (c) => {
    const site = siteOf(c);
    if (!site) return notFound(c);
    const now = deps.now();
    if (now < site.learningUntil) endLearning(db, site.id, now);
    return c.redirect(`/sites/${site.id}`, 303);
  });

  app.post(`${SITE}/start-learning`, async (c) => {
    const site = siteOf(c);
    if (!site) return notFound(c);
    const raw = one(await readForm(c), 'days');
    const days = /^\d{1,2}$/.test(raw) ? Number(raw) : 0;
    if (days < 1 || days > MAX_LEARNING_DAYS) {
      return refuse(c, `Indica un numero di giorni tra 1 e ${MAX_LEARNING_DAYS}.`, `/sites/${site.id}/settings`);
    }
    startLearning(db, site.id, deps.now(), days);
    return c.redirect(`/sites/${site.id}/settings`, 303);
  });

  // --- origin actions ---
  app.post(`${ORIGIN}/approve`, async (c) => {
    const site = siteOf(c);
    const target = site && originOfSite(db, site.id, Number(c.req.param('oid')));
    if (!site || !target) return notFound(c);
    const b = await readForm(c);
    const back = safeBack(one(b, 'back'), `/sites/${site.id}`);
    const scope = one(b, 'scope');
    if (scope !== 'site' && scope !== 'global') return refuse(c, 'Ambito di approvazione non valido.', back);
    const inlineOrEval = target.category === 'inline' || target.category === 'eval';
    if (inlineOrEval || !isApprovableSource(target.origin)) {
      return refuse(c, "Questa origine non si può approvare: inline ed eval restano solo in dashboard, e solo un'origine valida può finire nell'header.", back);
    }
    approveOrigin(db, site.id, target.origin, scope, deps.now());
    return c.redirect(back, 303);
  });

  app.post(`${ORIGIN}/suspect`, async (c) => {
    const site = siteOf(c);
    const target = site && originOfSite(db, site.id, Number(c.req.param('oid')));
    if (!site || !target) return notFound(c);
    const b = await readForm(c);
    const back = safeBack(one(b, 'back'), `/sites/${site.id}`);
    if (target.category === 'inline' || target.category === 'eval') return refuse(c, 'Inline ed eval restano solo in dashboard.', back);
    markSuspect(db, site.id, target.origin);
    return c.redirect(back, 303);
  });

  // --- approvals and noise ---
  app.get('/lists', (c) => render(c, GlobalLists({ nav: nav(), data: lists(db) })));

  app.post('/lists/approvals', async (c) => {
    const b = await readForm(c);
    const form: ApprovalForm = { pattern: one(b, 'pattern'), directives: many(b, 'directive'), scope: one(b, 'scope') || 'global' };
    const errors: string[] = [];
    const pattern = parsePattern(form.pattern);
    if (!pattern) errors.push("Pattern non valido: usa un'origine esatta (https://host o https://host:porta) o un jolly sul sottodominio (*.host o https://*.host), senza percorso.");
    const directives = [...new Set(form.directives)];
    if (directives.length === 0) errors.push('Scegli almeno una direttiva.');
    else if (directives.some(d => !FETCH_DIRECTIVES.includes(d))) errors.push('Direttiva non valida.');
    let siteId: number | null = null;
    if (form.scope !== 'global') {
      const site = /^[0-9]+$/.test(form.scope) ? getSite(db, Number(form.scope)) : null;
      if (!site) errors.push('Sito non valido.');
      else siteId = site.id;
    }
    if (errors.length > 0 || !pattern) {
      return render(c, GlobalLists({ nav: nav(), data: lists(db), approvalForm: form, approvalErrors: errors }), 400);
    }
    addApprovalPattern(db, siteId, pattern, directives, deps.now());
    return c.redirect('/lists', 303);
  });

  app.post('/lists/approvals/:aid{[0-9]+}/delete', (c) => {
    removeApproval(db, Number(c.req.param('aid')));
    return c.redirect('/lists', 303);
  });

  app.post('/lists/noise', async (c) => {
    const b = await readForm(c);
    const raw = one(b, 'pattern');
    const pattern = parsePattern(raw);
    if (!pattern) {
      return render(c, GlobalLists({
        nav: nav(), data: lists(db), noisePattern: raw,
        noiseErrors: ["Pattern non valido: usa un'origine esatta o un jolly sul sottodominio (*.host), senza percorso."],
      }), 400);
    }
    addNoisePattern(db, pattern, deps.now());
    return c.redirect('/lists', 303);
  });

  app.post('/lists/noise/:nid{[0-9]+}/delete', (c) => {
    deleteNoisePattern(db, Number(c.req.param('nid')));
    return c.redirect('/lists', 303);
  });

  // --- alert settings ---
  const alertEmail = () => getSetting(db, 'alert_email') ?? deps.config.alertEmail;
  const channelNames = () => deps.channels.map(ch => ch.name);

  app.get('/settings/alerts', (c) =>
    render(c, AlertSettings({ nav: nav(), email: alertEmail(), saved: c.req.query('saved') === '1', channels: channelNames() })));

  app.post('/settings/alerts', async (c) => {
    const b = await readForm(c);
    const raw = one(b, 'email');
    const email = parseEmail(raw);
    if (!email) {
      return render(c, AlertSettings({ nav: nav(), email: raw, errors: ['Indirizzo email non valido.'], channels: channelNames() }), 400);
    }
    setSetting(db, 'alert_email', email);
    return c.redirect('/settings/alerts?saved=1', 303);
  });

  app.post('/settings/alerts/test', async (c) => {
    let test: TestResult = { ok: true };
    let status: ContentfulStatusCode = 200;
    if (deps.channels.length === 0) {
      test = { ok: false, message: 'Nessun canale di invio configurato.' };
    } else {
      try {
        for (const ch of deps.channels) await ch.send(TEST_MESSAGE);
      } catch (e) {
        // Error name only: messages can carry SMTP credentials or server replies.
        console.error('alerts: test message failed', e instanceof Error ? e.name : 'unknown');
        test = { ok: false, message: 'Invio non riuscito. Controlla la configurazione SMTP e i log del servizio.' };
        status = 502;
      }
    }
    return render(c, AlertSettings({ nav: nav(), email: alertEmail(), test, channels: channelNames() }), status);
  });

  // Plain text: this also answers unauthenticated paths under /static, which must not see the site list.
  app.notFound((c) => c.text('Pagina non trovata', 404));
}
