import { fmtAgo, fmtDate, fmtDateTime, fmtNum, pct } from '../format.js';
import type { NavData, SiteSummary } from '../queries.js';
import { KEEP_DISCARDED } from '../../store/discarded.js';
import { Chart, CopyBlock, DiscardedTable, Empty, Head, Metric, NoiseTable, OriginActions, Section, StatusPill } from './components.js';
import { Layout } from './Layout.js';
import { EndLearning } from './SiteSettings.js';

export function SiteDetail(props: { nav: NavData; data: SiteSummary; strict: string; suggested: string; now: number }) {
  const { data, now } = props;
  const { site } = data;
  const back = `/sites/${site.id}`;
  const learning = now < site.learningUntil;
  const noiseTotal = data.noise7.reduce((a, r) => a + r.count, 0);
  return (
    <Layout title={site.name} nav={props.nav} active={{ page: 'site', siteId: site.id }}>
      <Head crumb={<><a href="/">Panoramica</a> / {site.name}</>} title={<h1>{site.name}</h1>}
        sub={`${site.domains.join(', ')} · aggiunto il ${fmtDate(site.createdAt)} · ${learning ? `in apprendimento fino al ${fmtDate(site.learningUntil)}` : 'apprendimento concluso'}`}
        actions={<>
          <EndLearning site={site} now={now} />
          <a class="btn" href={`/sites/${site.id}/csp`}>Violazioni CSP</a>
          <a class="btn" href={`/sites/${site.id}/settings`}>Impostazioni</a>
        </>} />

      <div class="grid4">
        <Metric label="Report 30 gg" value={fmtNum(data.reports30)} note={`ultimo ${fmtAgo(site.lastReportAt, now)}`} />
        <Metric label="Da rivedere" value={fmtNum(data.reviewCount)} tone={data.reviewCount > 0 ? 'red' : undefined} />
        <Metric label="Origini approvate" value={fmtNum(data.approvedCount)} />
        <Metric label="Rumore filtrato 7 gg" value={`${pct(noiseTotal, noiseTotal + data.reports7)}%`} note={`${fmtNum(noiseTotal)} report scartati`} />
      </div>

      <Section title="Da rivedere" note="Approvare vale per le direttive viste finora">
        {data.review.length === 0 ? <Empty>Niente da rivedere.</Empty> : (
          <div class="scroll">
            <table>
              <thead><tr><th>Stato</th><th>Origine</th><th>Direttiva</th><th>Pagina</th><th>Prima vista</th><th>Volte</th><th class="right">Azioni</th></tr></thead>
              <tbody>
                {data.review.map(r => (
                  <tr>
                    <td><StatusPill status={r.status} /></td>
                    <td class="mono"><a href={`/sites/${site.id}/origins/${r.id}`}>{r.origin}</a></td>
                    <td class="mono">{r.directive}</td>
                    <td class="mono muted">{r.firstPage}</td>
                    <td>{fmtDateTime(r.firstSeen)}</td>
                    <td>{fmtNum(r.count)}</td>
                    <td class="right"><OriginActions siteId={site.id} originId={r.id} back={back} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Origini approvate e sospette" note="globale = coperta da un'approvazione valida per tutti i siti">
        {data.known.length === 0 ? <Empty>Nessuna origine approvata finora.</Empty> : (
          <div class="scroll">
            <table>
              <thead><tr><th>Stato</th><th>Origine</th><th>Direttiva</th><th>Report</th><th>Ultima vista</th></tr></thead>
              <tbody>
                {data.known.map(r => (
                  <tr>
                    <td><StatusPill status={r.status} /></td>
                    <td class="mono"><a href={`/sites/${site.id}/origins/${r.id}`}>{r.origin}</a></td>
                    <td class="mono">{r.directive}</td>
                    <td>{fmtNum(r.count)}</td>
                    <td class="muted">{fmtAgo(r.lastSeen, now)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Inline ed eval" note="Solo dashboard: non generano alert">
        {data.inline.length === 0 ? <Empty>Nessun inline o eval segnalato.</Empty> : (
          <div class="scroll">
            <table>
              <thead><tr><th>Tipo</th><th>Direttiva</th><th>Report</th><th>Ultima vista</th><th>Ultimi sample</th></tr></thead>
              <tbody>
                {data.inline.map(r => (
                  <tr>
                    <td class="mono"><a href={`/sites/${site.id}/origins/${r.id}`}>{r.origin}</a></td>
                    <td class="mono">{r.directive}</td>
                    <td>{fmtNum(r.count)}</td>
                    <td class="muted">{fmtAgo(r.lastSeen, now)}</td>
                    <td class="mono wrap">{r.samples.length === 0 ? <span class="muted">nessuno</span> : r.samples.map(s => <div>{s}</div>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <div class="grid21">
        <Chart title="Report nel tempo" series={data.series} />
        <Section title="Rumore filtrato" note="ultimi 7 giorni"><NoiseTable rows={data.noise7} /></Section>
      </div>

      <Section title="Ultimi report scartati" note={`gli ultimi ${KEEP_DISCARDED}, senza query string; quelli oltre il tetto non vengono conservati`}>
        <DiscardedTable rows={data.discarded} />
      </Section>

      <section class="card">
        <h2 style="margin-bottom:4px">Header per questo sito</h2>
        <p style="margin:0 0 12px;font-size:13px" class="muted">
          Versione suggerita: include le origini approvate ({fmtNum(data.approvedSources.length)} regole), così a regime arrivano meno report.
        </p>
        <CopyBlock id="suggested-header" text={props.suggested} button="Copia suggerito" />
        <p style="margin:16px 0 8px;font-size:13px" class="muted">Versione stretta di partenza:</p>
        <CopyBlock id="strict-header" text={props.strict} button="Copia versione stretta" />
      </section>
    </Layout>
  );
}
