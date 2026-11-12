import { fmtDateTime, fmtNum } from '../format.js';
import type { NavData, OriginDetailData } from '../queries.js';
import { Empty, Head, OriginActions, Pill, Section, StatusPill } from './components.js';
import { Layout } from './Layout.js';

/** R5: pretty-printed when the stored body parses as JSON, otherwise the stored text as-is (escaped either way). */
function formatRaw(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function CrossSiteWarning(props: { data: OriginDetailData }) {
  const { crossSite, site } = props.data;
  if (crossSite.length === 0) return null;
  const names = [site.name, ...crossSite.map(s => s.name)];
  return (
    <div class="alert red" role="alert">
      <strong>Compare su {names.length} siti nelle ultime 24 ore.</strong>{' '}
      La stessa origine è stata vista anche su {crossSite.map(s => s.name).join(', ')}. Può essere un plugin condiviso aggiornato, oppure lo stesso attacco su più siti.
    </div>
  );
}

export function OriginDetail(props: { nav: NavData; data: OriginDetailData }) {
  const { data } = props;
  const { site, row } = data;
  const back = `/sites/${site.id}/origins/${row.id}`;
  return (
    <Layout title={`Origine ${row.origin}`} nav={props.nav} active={{ page: 'csp', siteId: site.id }}>
      <Head crumb={<><a href="/">Panoramica</a> / <a href={`/sites/${site.id}`}>{site.name}</a> / Origine</>}
        title={<><h1 class="mono">{row.origin}</h1><StatusPill status={row.status} /></>}
        sub={`Vista per la prima volta il ${fmtDateTime(row.firstSeen)} · ${fmtNum(row.count)} report · direttiva ${row.directive}`}
        actions={data.approvable ? <OriginActions siteId={site.id} originId={row.id} back={back} big /> : undefined} />

      <CrossSiteWarning data={data} />

      <div class="grid3">
        <div class="card">
          <p class="lbl">Siti coinvolti</p>
          <div style="font-size:14px;line-height:1.7">
            {data.sites.map(s => <div><a href={`/sites/${s.id}`}>{s.name}</a> · da {fmtDateTime(s.firstSeen)}</div>)}
          </div>
        </div>
        <div class="card">
          <p class="lbl">Direttive su questo sito</p>
          <div style="font-size:13px;line-height:1.9">
            {data.siblings.map(s => (
              <div class="row">
                <a class="mono" href={`/sites/${site.id}/origins/${s.id}`}>{s.directive} ({fmtNum(s.count)})</a>
                <StatusPill status={s.status} />
              </div>
            ))}
          </div>
        </div>
        <div class="card">
          <p class="lbl">Partito da</p>
          <p class="mono" style="margin:0;word-break:break-all">{data.startedFrom || '—'}</p>
        </div>
      </div>

      <Section title="Ultimi report" note="Se ne tengono 20 per origine più quelli degli ultimi 7 giorni, senza IP né query string">
        {data.samples.length === 0 ? <Empty>Nessun campione.</Empty> : (
          <div class="scroll">
            <table>
              <thead><tr><th>Quando</th><th>Pagina</th><th>File di origine</th><th>Riga</th><th>Sample</th><th>Browser</th><th>Modalità</th></tr></thead>
              <tbody>
                {data.samples.map(s => (
                  <tr>
                    <td>{fmtDateTime(s.receivedAt)}</td>
                    <td class="mono">{s.page}</td>
                    <td class="mono">{s.sourceFile}</td>
                    <td>{s.line ?? ''}</td>
                    <td class="mono wrap">{s.sample}</td>
                    <td>{s.ua}</td>
                    <td><Pill tone="gry">{s.disposition === 'enforce' ? 'bloccante' : 'report-only'}</Pill></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <section class="card">
        <h2 style="margin-bottom:8px">Report grezzo</h2>
        {data.raw === null ? <p class="muted" style="margin:0">Nessun report salvato.</p>
          : <pre class="mono block">{formatRaw(data.raw)}</pre>}
      </section>
    </Layout>
  );
}
