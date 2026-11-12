import type { NavData } from '../queries.js';
import { Errors, Head } from './components.js';
import { Layout } from './Layout.js';

export type TestResult = { ok: true } | { ok: false; message: string };

export function AlertSettings(props: {
  nav: NavData; email: string; saved?: boolean; errors?: string[]; test?: TestResult; channels: string[];
}) {
  return (
    <Layout title="Impostazioni alert" nav={props.nav} active={{ page: 'alerts' }}>
      <Head title={<h1>Impostazioni alert</h1>}
        sub="Gli alert dello stesso sito vengono raggruppati per 10 minuti e inviati in un messaggio solo." />
      {props.saved ? <div class="alert grn" role="status">Indirizzo salvato.</div> : null}
      {props.test?.ok ? <div class="alert grn" role="status">Messaggio di prova inviato. Controlla la casella.</div> : null}
      {props.test && !props.test.ok ? <div class="alert red" role="alert">{props.test.message}</div> : null}
      <section class="card">
        <form method="post" action="/settings/alerts" class="form">
          <Errors errors={props.errors} />
          <label class="field">Email per gli alert
            <input type="email" name="email" value={props.email} required maxlength={254} autocomplete="email" />
          </label>
          <div class="row"><button type="submit" class="pri">Salva</button></div>
        </form>
      </section>
      <section class="card">
        <h2 style="margin-bottom:6px">Prova</h2>
        <p style="margin:0 0 10px;font-size:13px" class="muted">
          Manda un messaggio di prova su tutti i canali configurati ({props.channels.length > 0 ? props.channels.join(', ') : 'nessuno'}).
        </p>
        <form method="post" action="/settings/alerts/test" class="inline"><button type="submit">Invia messaggio di prova</button></form>
      </section>
    </Layout>
  );
}
