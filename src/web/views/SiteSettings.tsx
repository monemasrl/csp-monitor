import { HEADER_FEATURES, type HeaderFeature } from '../../headers.js';
import type { Site } from '../../store/sites.js';
import { fmtDateTime } from '../format.js';
import type { NavData } from '../queries.js';
import type { SiteForm } from '../validate.js';
import { Errors, Head } from './components.js';
import { Layout } from './Layout.js';
import { NameAndDomains } from './SiteNew.js';

export function siteToForm(site: Site): SiteForm {
  return {
    name: site.name, domains: site.domains.join('\n'),
    rate_per_min: String(site.ratePerMin), rate_per_day: String(site.ratePerDay),
    sensitive_paths: site.sensitivePaths.join('\n'), features: site.enabledHeaders,
  };
}

const FEATURE_TEXT: Record<HeaderFeature, [string, string]> = {
  csp: ['Content Security Policy', 'Sempre attiva: è la base di tutto il monitoraggio.'],
  'csp-hash': ['Hash degli script', 'Inventario degli script eseguiti e avviso se uno cambia (solo Chromium).'],
  nel: ['Errori di rete (NEL)', 'Errori di connessione visti dai visitatori (Chrome ed Edge).'],
  permissions: ['Permissions-Policy', 'Uso di camera, microfono, posizione e altre funzioni sensibili.'],
  coop: ['Cross-Origin-Opener-Policy', 'Cosa si romperebbe isolando la finestra.'],
  coep: ['Cross-Origin-Embedder-Policy', 'Risorse esterne senza CORP: attenzione al rumore.'],
  document: ['Document-Policy', 'Chiamate XHR sincrone.'],
  integrity: ['Integrità (SRI)', 'Script esterni senza attributo integrity o con hash errato.'],
  connection: ['Connessioni non dichiarate', 'Sperimentale: connessioni verso domini non dichiarati.'],
};

export function EndLearning(props: { site: Site; now: number }) {
  if (props.now >= props.site.learningUntil) return null;
  return (
    <form method="post" action={`/sites/${props.site.id}/end-learning`} class="inline">
      <button type="submit">Chiudi apprendimento</button>
    </form>
  );
}

export const MAX_LEARNING_DAYS = 90;

/** Starts learning again (or restarts it from now when already learning). */
export function StartLearning(props: { site: Site; learning: boolean }) {
  return (
    <form method="post" action={`/sites/${props.site.id}/start-learning`} class="row" style="align-items:center;gap:8px">
      <label for="learning-days" style="font-size:13px">{props.learning ? 'Ricomincia da adesso per' : 'Per'}</label>
      <select id="learning-days" name="days">
        {[1, 3, 7, 14, 30].map(d => <option value={String(d)} selected={d === 7}>{d === 1 ? '1 giorno' : `${d} giorni`}</option>)}
      </select>
      <button type="submit">{props.learning ? 'Ricomincia apprendimento' : 'Riattiva apprendimento'}</button>
    </form>
  );
}

/** Irreversible actions; each one asks to type the site name. */
export function DangerZone(props: { site: Site }) {
  const { site } = props;
  const Action = (p: { action: string; title: string; text: string; button: string; id: string }) => (
    <form method="post" action={`/sites/${site.id}/${p.action}`} class="danger-row">
      <div>
        <h3>{p.title}</h3>
        <p class="muted">{p.text}</p>
      </div>
      <div class="danger-confirm">
        <label for={p.id}>Scrivi <b>{site.name}</b> per confermare</label>
        <input id={p.id} name="confirm" autocomplete="off" spellcheck={false} required />
        <button type="submit" class="dng">{p.button}</button>
      </div>
    </form>
  );
  return (
    <section class="card danger">
      <h2>Zona pericolosa</h2>
      <Action action="clear-data" id="confirm-clear" title="Cancella tutti i dati" button="Cancella i dati"
        text="Elimina origini, campioni, conteggi, rumore e alert in coda di questo sito. Restano il sito, la chiave dell'endpoint, le impostazioni e le approvazioni. Non si può annullare." />
      <Action action="delete" id="confirm-delete" title="Rimuovi il sito" button="Rimuovi il sito"
        text="Elimina il sito con tutti i suoi dati e le sue approvazioni. L'endpoint smette di accettare report. Non si può annullare." />
    </section>
  );
}

export function SiteSettings(props: {
  nav: NavData; site: Site; endpoint: string; now: number; form?: SiteForm; errors?: string[];
}) {
  const { site, now } = props;
  const form = props.form ?? siteToForm(site);
  const learning = now < site.learningUntil;
  return (
    <Layout title={`Impostazioni ${site.name}`} nav={props.nav} active={{ page: 'settings', siteId: site.id }}>
      <Head crumb={<><a href="/">Panoramica</a> / <a href={`/sites/${site.id}`}>{site.name}</a> / Impostazioni</>}
        title={<h1>Impostazioni</h1>} sub={<>Endpoint dei report: <span class="mono">{props.endpoint}</span></>} />
      <section class="card">
        <form method="post" action={`/sites/${site.id}/settings`} class="form">
          <Errors errors={props.errors} />
          <NameAndDomains form={form} />
          <div class="grid2">
            <label class="field">Tetto report al minuto
              <input name="rate_per_min" value={form.rate_per_min} inputmode="numeric" required />
            </label>
            <label class="field">Tetto report al giorno
              <input name="rate_per_day" value={form.rate_per_day} inputmode="numeric" required />
            </label>
          </div>
          <label class="field">Pagine sensibili
            <textarea name="sensitive_paths" rows={4} placeholder="/checkout">{form.sensitive_paths ?? ''}</textarea>
            <small>Uno per riga, inizia con /, per esempio /checkout o /login. Gli alert su queste pagine partono subito, senza raggruppamento.</small>
          </label>
          <fieldset>
            <legend>Header da attivare</legend>
            <div class="checks feature-list">
              {HEADER_FEATURES.map((f) => {
                const [name, text] = FEATURE_TEXT[f];
                const checked = f === 'csp' || (form.features ?? []).includes(f);
                return (
                  <label>
                    {f === 'csp'
                      ? <><input type="checkbox" checked disabled /><input type="hidden" name="features" value="csp" /></>
                      : <input type="checkbox" name="features" value={f} checked={checked} />}
                    <span><b>{name}</b> <span class="muted">{text}</span></span>
                  </label>
                );
              })}
            </div>
          </fieldset>
          <small class="muted">Oltre il tetto i report vengono scartati e contati; le origini mai viste vengono comunque registrate.</small>
          <div class="row"><button type="submit" class="pri">Salva</button></div>
        </form>
      </section>
      <section class="card">
        <h2 style="margin-bottom:6px">Periodo di apprendimento</h2>
        <p style="margin:0 0 10px;font-size:13px" class="muted">
          {learning
            ? `In apprendimento fino al ${fmtDateTime(site.learningUntil)}: niente alert, alla fine arriva un riepilogo.`
            : `Concluso il ${fmtDateTime(site.learningUntil)}. Puoi riattivarlo quando vuoi: le origini nuove non mandano alert finché dura, e alla fine arriva di nuovo il riepilogo.`}
        </p>
        <EndLearning site={site} now={now} />
        <StartLearning site={site} learning={learning} />
      </section>
      <DangerZone site={site} />
    </Layout>
  );
}
