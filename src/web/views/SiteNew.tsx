import type { NavData } from '../queries.js';
import type { SiteForm } from '../validate.js';
import { Errors, Head } from './components.js';
import { Layout } from './Layout.js';

export function NameAndDomains(props: { form: SiteForm }) {
  return (
    <>
      <label class="field">Nome
        <input name="name" value={props.form.name} required maxlength={100} />
      </label>
      <label class="field">Domini del sito
        <textarea name="domains" rows={4} required>{props.form.domains}</textarea>
        <small>Uno per riga, solo l'host: example.it, www.example.it oppure *.example.it. I report di pagine fuori da questi domini contano come rumore.</small>
      </label>
    </>
  );
}

export function SiteNew(props: { nav: NavData; form?: SiteForm; errors?: string[] }) {
  const form = props.form ?? { name: '', domains: '' };
  return (
    <Layout title="Aggiungi sito" nav={props.nav} active={{ page: 'new-site' }}>
      <Head crumb={<a href="/">Panoramica</a>} title={<h1>Aggiungi sito</h1>}
        sub="Dopo il salvataggio trovi l'header da mettere sul sito. Per 7 giorni il sito resta in apprendimento: niente alert, poi un riepilogo." />
      <section class="card">
        <form method="post" action="/sites" class="form">
          <Errors errors={props.errors} />
          <NameAndDomains form={form} />
          <div class="row"><button type="submit" class="pri">Aggiungi sito</button></div>
        </form>
      </section>
    </Layout>
  );
}
