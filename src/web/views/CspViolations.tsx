import { fmtAgo, fmtNum } from '../format.js';
import { STATUS_KEYS, type CspData, type NavData } from '../queries.js';
import { Chart, Empty, Head, Metric, NoiseTable, Section, STATUS_LABEL, StatusPill } from './components.js';
import { Layout } from './Layout.js';

function Filters(props: { data: CspData }) {
  const { data } = props;
  const f = data.filters;
  return (
    <form method="get" action={`/sites/${data.site.id}/csp`} class="row">
      <label><span class="sr">Direttiva</span>
        <select name="directive">
          <option value="">Tutte le direttive</option>
          {data.directives.map(d => <option value={d} selected={f.directive === d}>{d}</option>)}
        </select>
      </label>
      <label><span class="sr">Stato</span>
        <select name="status">
          <option value="">Tutti gli stati</option>
          {STATUS_KEYS.map(s => <option value={s} selected={f.status === s}>{STATUS_LABEL(s)}</option>)}
        </select>
      </label>
      <label><span class="sr">Rumore</span>
        <select name="noise">
          <option value="0" selected={!f.noise}>Senza rumore</option>
          <option value="1" selected={f.noise}>Con rumore</option>
        </select>
      </label>
      <button type="submit">Filtra</button>
    </form>
  );
}

export function CspViolations(props: { nav: NavData; data: CspData; now: number }) {
  const { data, now } = props;
  const { site, totals } = data;
  return (
    <Layout title={`Violazioni CSP ${site.name}`} nav={props.nav} active={{ page: 'csp', siteId: site.id }}>
      <Head crumb={<><a href={`/sites/${site.id}`}>{site.name}</a> / Segnali di attacco</>}
        title={<><h1>Violazioni CSP</h1><span class="pill gry mono">csp-violation</span></>}
        sub="Una risorsa è stata caricata, o ha provato a caricarsi, fuori dalla Content Security Policy del sito. È la base dell'inventario delle origini." />

      <div class="grid3">
        <Metric label="Report 30 gg" value={fmtNum(totals.reports30)} />
        <Metric label="Origini esterne" value={fmtNum(totals.external)} note={`${fmtNum(totals.approved)} approvate`} />
        <Metric label="Da rivedere" value={fmtNum(totals.review)} tone={totals.review > 0 ? 'red' : undefined} />
      </div>

      <div class="grid21">
        <Chart title="Violazioni nel tempo" series={data.series} />
        <section class="card">
          <h2 style="margin-bottom:12px">Per browser</h2>
          {data.browsers.length === 0 ? <p class="muted small" style="margin:0">Nessun report negli ultimi 30 giorni.</p> : (
            <div class="stack">
              {data.browsers.map(b => (
                <div>
                  <div class="between small"><span>{b.name}</span><span class="muted">{b.pct}%</span></div>
                  <div class="meter"><div style={`width:${b.pct}%`}></div></div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <section class="card flush">
        <div class="card-head"><h2>Violazioni aggregate</h2><Filters data={data} /></div>
        {data.rows.length === 0 ? <Empty>Nessuna violazione con questi filtri.</Empty> : (
          <div class="scroll">
            <table>
              <thead><tr><th>Direttiva</th><th>Origine bloccata</th><th>Pagina più colpita</th><th>Stato</th><th>Report</th><th>Ultima vista</th></tr></thead>
              <tbody>
                {data.rows.map(r => (
                  <tr>
                    <td class="mono">{r.directive}</td>
                    <td class="mono"><a href={`/sites/${site.id}/origins/${r.id}`}>{r.origin}</a></td>
                    <td class="mono muted">{r.topPage}</td>
                    <td><StatusPill status={r.status} /></td>
                    <td>{fmtNum(r.count)}</td>
                    <td class="muted">{fmtAgo(r.lastSeen, now)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data.truncated ? <Empty>Mostrate le prime 500 righe: usa i filtri per restringere.</Empty> : null}
      </section>

      {data.filters.noise ? (
        <Section title="Rumore filtrato per motivo" note="ultimi 30 giorni · il rumore non viene salvato per origine">
          <NoiseTable rows={data.noise30} pill />
        </Section>
      ) : null}

      <div class="grid2">
        <section class="card">
          <h2 style="margin-bottom:6px">Quando ti avvisa</h2>
          <p style="margin:0;font-size:13px;line-height:1.6">
            Email alla prima comparsa di una combinazione sito + origine + direttiva non approvata. Un'origine approvata per le immagini che compare negli script fa scattare un nuovo alert. Rumore, inline ed eval non avvisano mai.
          </p>
        </section>
        <section class="card">
          <h2 style="margin-bottom:6px">Come si attiva</h2>
          <p style="margin:0;font-size:13px;line-height:1.6">
            Header Report-Only con la policy stretta di partenza, inviato a entrambi i meccanismi di report: lo trovi nel <a href={`/sites/${site.id}`}>riepilogo del sito</a>.
          </p>
        </section>
      </div>
    </Layout>
  );
}
