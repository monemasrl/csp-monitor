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
  };
}

export function EndLearning(props: { site: Site; now: number }) {
  if (props.now >= props.site.learningUntil) return null;
  return (
    <form method="post" action={`/sites/${props.site.id}/end-learning`} class="inline">
      <button type="submit">Chiudi apprendimento</button>
    </form>
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
          <small class="muted">Oltre il tetto i report vengono scartati e contati; le origini mai viste vengono comunque registrate.</small>
          <div class="row"><button type="submit" class="pri">Salva</button></div>
        </form>
      </section>
      <section class="card">
        <h2 style="margin-bottom:6px">Periodo di apprendimento</h2>
        <p style="margin:0 0 10px;font-size:13px" class="muted">
          {learning
            ? `In apprendimento fino al ${fmtDateTime(site.learningUntil)}: niente alert, alla fine arriva un riepilogo.`
            : `Concluso il ${fmtDateTime(site.learningUntil)}.`}
        </p>
        <EndLearning site={site} now={now} />
      </section>
    </Layout>
  );
}
