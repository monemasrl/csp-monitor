import { fmtDate } from '../format.js';
import type { ListsData, NavData } from '../queries.js';
import { FETCH_DIRECTIVES } from '../validate.js';
import { Empty, Errors, Head, Pill, Section } from './components.js';
import { Layout } from './Layout.js';

export type ApprovalForm = { pattern: string; directives: string[]; scope: string };

function DeleteButton(props: { action: string }) {
  return (
    <form method="post" action={props.action} class="inline"><button type="submit" class="dng">Elimina</button></form>
  );
}

function ApprovalFormCard(props: { data: ListsData; form: ApprovalForm; errors?: string[] }) {
  const { form } = props;
  return (
    <form method="post" action="/lists/approvals" class="form card-body">
      <Errors errors={props.errors} />
      <label class="field">Pattern
        <input name="pattern" value={form.pattern} placeholder="https://cdn.example.com oppure *.example.com" required />
        <small>Origine esatta (https://host o https://host:porta) oppure jolly sul sottodominio (*.host o https://*.host). Niente percorsi.</small>
      </label>
      <fieldset>
        <legend>Direttive</legend>
        <div class="checks">
          {FETCH_DIRECTIVES.map(d => (
            <label><input type="checkbox" name="directive" value={d} checked={form.directives.includes(d)} /><span class="mono">{d}</span></label>
          ))}
        </div>
      </fieldset>
      <label class="field">Vale per
        <select name="scope">
          <option value="global" selected={form.scope === 'global'}>Tutti i siti</option>
          {props.data.sites.map(s => <option value={String(s.id)} selected={form.scope === String(s.id)}>{s.name}</option>)}
        </select>
      </label>
      <div class="row"><button type="submit" class="pri">Aggiungi approvazione</button></div>
    </form>
  );
}

export function GlobalLists(props: {
  nav: NavData; data: ListsData; approvalForm?: ApprovalForm; approvalErrors?: string[];
  noisePattern?: string; noiseErrors?: string[];
}) {
  const { data } = props;
  const risky = data.approvals.filter(a => a.risky);
  return (
    <Layout title="Approvazioni e rumore" nav={props.nav} active={{ page: 'lists' }}>
      <Head title={<h1>Approvazioni e rumore</h1>}
        sub="Le approvazioni valgono per le direttive indicate; il rumore noto non genera mai alert." />

      {risky.length > 0 ? (
        <div class="alert amb" role="alert">
          <strong>Jolly rischioso:</strong> {risky.map(a => a.pattern).filter((p, i, all) => all.indexOf(p) === i).join(', ')}.
          {' '}Su questi host di hosting generico chiunque può pubblicare contenuti: un attaccante può caricare uno script da un sottodominio suo e passare come approvato.
        </div>
      ) : null}

      <Section title="Approvazioni" note="Approvare dalla pagina di un'origine aggiunge l'origine esatta">
        {data.approvals.length === 0 ? <Empty>Nessuna approvazione.</Empty> : (
          <div class="scroll">
            <table>
              <thead><tr><th>Pattern</th><th>Direttiva</th><th>Vale per</th><th>Aggiunta</th><th class="right"></th></tr></thead>
              <tbody>
                {data.approvals.map(a => (
                  <tr>
                    <td class="mono">{a.pattern} {a.risky ? <Pill tone="amb">jolly rischioso</Pill> : null}</td>
                    <td class="mono">{a.directive}</td>
                    <td>{a.siteId === null ? <Pill tone="blu">tutti i siti</Pill> : <a href={`/sites/${a.siteId}`}>{a.siteName}</a>}</td>
                    <td class="muted">{fmtDate(a.createdAt)}</td>
                    <td class="right"><DeleteButton action={`/lists/approvals/${a.id}/delete`} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <ApprovalFormCard data={data} form={props.approvalForm ?? { pattern: '', directives: [], scope: 'global' }} errors={props.approvalErrors} />
      </Section>

      <Section title="Rumore noto" note="Origini iniettate da estensioni, antivirus e traduttori">
        <div class="scroll">
          <table>
            <thead><tr><th>Pattern</th><th>Origine</th><th>Aggiunto</th><th class="right"></th></tr></thead>
            <tbody>
              {data.noise.map(n => (
                <tr>
                  <td class="mono">{n.pattern}</td><td>dalla dashboard</td><td class="muted">{fmtDate(n.createdAt)}</td>
                  <td class="right"><DeleteButton action={`/lists/noise/${n.id}/delete`} /></td>
                </tr>
              ))}
              {data.builtinNoise.map(p => (
                <tr><td class="mono">{p}</td><td class="muted">predefinito</td><td></td><td></td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <form method="post" action="/lists/noise" class="form card-body">
          <Errors errors={props.noiseErrors} />
          <label class="field">Pattern
            <input name="pattern" value={props.noisePattern ?? ''} placeholder="*.toolbar.example" required />
            <small>Stesse regole delle approvazioni. Vale da ora in poi, per tutti i siti.</small>
          </label>
          <div class="row"><button type="submit">Aggiungi al rumore</button></div>
        </form>
      </Section>
    </Layout>
  );
}
