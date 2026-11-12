// Generic page of one report type: everything type-specific comes from its TypePageDef (src/web/typePages.ts).
import { fmtDateTime } from '../format.js';
import type { NavData } from '../queries.js';
import { FAMILIES, type Cell, type TypePageData } from '../typePages.js';
import { Chart, CopyBlock, Empty, Head, Metric, OriginActions, StatusPill } from './components.js';
import { Layout } from './Layout.js';

const TONE = { danger: 'red', warning: 'amb' } as const;

function CellView(props: { cell: Cell }) {
  const { cell } = props;
  if ('status' in cell) return <td><StatusPill status={cell.status} /></td>;
  return <td class={cell.cls}>{cell.v}</td>;
}

function Filters(props: { data: TypePageData; action: string }) {
  if (props.data.filters.length === 0) return null;
  return (
    <form method="get" action={props.action} class="row">
      {props.data.filters.map(f => (
        <label><span class="sr">{f.all}</span>
          <select name={f.name}>
            <option value="">{f.all}</option>
            {f.options.map(o => <option value={o.value} selected={f.selected === o.value}>{o.label}</option>)}
          </select>
        </label>
      ))}
      <button type="submit">Filtra</button>
    </form>
  );
}

/** "Varia spesso" / "Non varia" for a csp-hash row. */
function VolatileButton(props: { siteId: number; originId: number; volatile: boolean; back: string }) {
  return (
    <form method="post" action={`/sites/${props.siteId}/origins/${props.originId}/volatile`} class="inline">
      <input type="hidden" name="value" value={props.volatile ? '0' : '1'} /><input type="hidden" name="back" value={props.back} />
      <button type="submit">{props.volatile ? 'Non varia' : 'Varia spesso'}</button>
    </form>
  );
}

export function TypePage(props: { nav: NavData; data: TypePageData; now: number }) {
  const { data, now } = props;
  const { site, def } = data;
  const path = `/sites/${site.id}/types/${def.slug}`;
  const isHash = def.type === 'csp-hash';
  const releasing = isHash && now < data.releaseUntil;
  const actions = def.review || isHash;
  return (
    <Layout title={`${def.title} ${site.name}`} nav={props.nav} active={{ page: 'type', siteId: site.id, slug: def.slug }}>
      <Head crumb={<><a href={`/sites/${site.id}`}>{site.name}</a> / {FAMILIES.find(f => f.key === def.family)!.label}</>}
        title={<><h1>{def.title}</h1><span class="pill gry mono">{def.type}</span></>}
        sub={def.description}
        actions={isHash ? (
          releasing ? <span class="pill amb">Rilascio in corso fino al {fmtDateTime(data.releaseUntil)}</span> : (
            <form method="post" action={`/sites/${site.id}/release`} class="inline">
              <input type="hidden" name="back" value={path} />
              <button type="submit">Inizia rilascio (1 ora)</button>
            </form>
          )
        ) : undefined} />

      <div class="grid3">
        {data.metrics.map(m => <Metric label={m.label} value={m.value} note={m.sub} tone={m.tone ? TONE[m.tone] : undefined} />)}
      </div>

      <div class="grid21">
        <Chart title={def.chartTitle} series={data.series} />
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
        <div class="card-head"><h2>{def.tableTitle}</h2><Filters data={data} action={path} /></div>
        {data.rows.length === 0 ? <Empty>Nessun report con questi filtri.</Empty> : (
          <div class="scroll">
            <table>
              <thead><tr>{def.columns.map(c => <th>{c}</th>)}{actions ? <th><span class="sr">Azioni</span></th> : null}</tr></thead>
              <tbody>
                {data.rows.map(r => (
                  <tr>
                    {def.row(r, now).map(c => <CellView cell={c} />)}
                    {actions ? (
                      <td class="right">
                        <div class="actions">
                          {def.review ? <OriginActions siteId={site.id} originId={r.id} back={path} /> : null}
                          {isHash ? <VolatileButton siteId={site.id} originId={r.id} volatile={r.detail.volatile === true} back={path} /> : null}
                        </div>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data.truncated ? <Empty>Mostrate le prime 500 righe: usa i filtri per restringere.</Empty> : null}
      </section>

      <div class="grid2">
        <section class="card">
          <h2 style="margin-bottom:6px">Quando ti avvisa</h2>
          <p style="margin:0;font-size:13px;line-height:1.6">{def.alertRule}</p>
        </section>
        <section class="card">
          <h2 style="margin-bottom:6px">Come si attiva</h2>
          <p style="margin:0 0 10px;font-size:13px;line-height:1.6">{def.setupNote}</p>
          <CopyBlock id={`setup-${def.slug}`} text={data.headers.map(h => `${h.name}: ${h.value}`).join('\n')} button="Copia header" />
          <ul class="small muted" style="margin:10px 0 0;padding-left:18px">
            {data.headers.map(h => <li><span class="mono">{h.name}</span>: {h.note}</li>)}
          </ul>
        </section>
      </div>
    </Layout>
  );
}
