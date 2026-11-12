import { fmtAgo, fmtDateTime, fmtNum } from '../format.js';
import type { NavData, OverviewData, SiteCard, SiteState } from '../queries.js';
import { Bars, Empty, Head, Metric, Pill, Section, StatusPill } from './components.js';
import { Layout } from './Layout.js';

function stateLabel(s: SiteState): [string, string] {
  switch (s.kind) {
    case 'review': return [`${s.count} da rivedere`, 'red'];
    case 'over-cap': return [`oltre il tetto · ${fmtNum(s.dropped)} scartati oggi`, 'amb'];
    case 'silent': return ['silenzioso', 'amb'];
    case 'learning': return [`apprendimento · ${s.days} gg`, 'blu'];
    default: return ['tutto ok', 'grn'];
  }
}

function Card(props: { card: SiteCard; now: number }) {
  const { site, state, bars, reports30, droppedToday } = props.card;
  const [label, tone] = stateLabel(state);
  return (
    <a href={`/sites/${site.id}`} class="card site-card">
      <div class="site-top">
        <div class="site-id">
          <div class="initial">{site.name.slice(0, 1).toUpperCase()}</div>
          <div><div class="site-name">{site.name}</div><div class="small muted">{site.domains.join(', ')}</div></div>
        </div>
        <Pill tone={tone}>{label}</Pill>
      </div>
      <Bars values={bars} height={44} />
      <div class="site-foot">
        <span>{fmtNum(reports30)} report in 30 gg · ultimo {fmtAgo(site.lastReportAt, props.now)}</span>
        {droppedToday > 0 && state.kind !== 'over-cap' ? <span class="pill amb">oltre il tetto · {fmtNum(droppedToday)} scartati oggi</span> : null}
      </div>
    </a>
  );
}

export function Overview(props: { nav: NavData; data: OverviewData; now: number }) {
  const { data, now } = props;
  return (
    <Layout title="Panoramica" nav={props.nav} active={{ page: 'overview' }}>
      <Head title={<h1>Panoramica</h1>} sub="Tutti i siti, ultimi 30 giorni"
        actions={<a class="btn" href="/sites/new">Aggiungi sito</a>} />
      <div class="grid4">
        <Metric label="Siti monitorati" value={fmtNum(data.siteCount)} />
        <Metric label="Da rivedere" value={fmtNum(data.reviewCount)} tone={data.reviewCount > 0 ? 'red' : undefined} note="origini nuove" />
        <Metric label="Siti silenziosi" value={fmtNum(data.silentCount)} tone={data.silentCount > 0 ? 'amb' : undefined} note="nessun report da 3 giorni" />
        <Metric label="Report ultime 24h" value={fmtNum(data.reports24h)} note="esclusi rumore e scartati" />
      </div>

      <Section title="Da rivedere" note="Gli stessi elementi arrivano per email">
        {data.review.length === 0 ? <Empty>Niente da rivedere.</Empty> : (
          <div class="scroll">
            <table>
              <thead><tr><th>Quando</th><th>Sito</th><th>Stato</th><th>Cosa</th><th>Pagina</th><th></th></tr></thead>
              <tbody>
                {data.review.map(r => (
                  <tr>
                    <td class="muted">{fmtDateTime(r.firstSeen)}</td>
                    <td>{r.siteName}</td>
                    <td><StatusPill status={r.status} /></td>
                    <td class="mono">{r.origin} · {r.directive}</td>
                    <td class="mono muted">{r.firstPage}</td>
                    <td class="right"><a href={`/sites/${r.siteId}/origins/${r.id}`}>Apri</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <div class="between"><h2>Siti</h2><span class="small muted">Ordinati per urgenza</span></div>
      {data.cards.length === 0 ? (
        <div class="card"><p style="margin:0">Nessun sito. <a href="/sites/new">Aggiungi il primo sito</a>.</p></div>
      ) : (
        <div class="cards">{data.cards.map(c => <Card card={c} now={now} />)}</div>
      )}
    </Layout>
  );
}
