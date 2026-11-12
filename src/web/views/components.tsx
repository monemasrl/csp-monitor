// Small shared view pieces. Everything rendered here goes through hono/jsx escaping.
import type { Child } from 'hono/jsx';
import { fmtDay, fmtNum } from '../format.js';
import type { ReasonCount, Series, StatusKey } from '../queries.js';

const STATUS: Record<StatusKey, [string, string]> = {
  new: ['nuova', 'red'],
  approved: ['approvata', 'grn'],
  global: ['globale', 'blu'],
  suspect: ['sospetta', 'amb'],
  dashboard: ['solo dashboard', 'gry'],
};
export const STATUS_LABEL = (s: StatusKey): string => STATUS[s][0];

export const NOISE_LABEL: Record<string, string> = {
  extension: 'Estensioni del browser',
  'foreign-document': 'Pagine fuori dai domini del sito',
  'known-noise': 'Rumore noto',
  bot: 'Bot',
  'rate-limit': 'Oltre il tetto',
  invalid: 'Report non validi',
};

export function Pill(props: { tone: string; children?: Child }) {
  return <span class={`pill ${props.tone}`}>{props.children}</span>;
}

export function StatusPill(props: { status: StatusKey }) {
  const [label, tone] = STATUS[props.status];
  return <Pill tone={tone}>{label}</Pill>;
}

export function Metric(props: { label: string; value: string; tone?: string; note?: string }) {
  return (
    <div class="card">
      <p class="lbl">{props.label}</p>
      <p class={`big ${props.tone ?? ''}`}>{props.value}</p>
      {props.note ? <p class="note">{props.note}</p> : null}
    </div>
  );
}

export function Head(props: { crumb?: Child; title: Child; sub?: Child; actions?: Child }) {
  return (
    <div class="head">
      <div>
        {props.crumb ? <p class="crumb">{props.crumb}</p> : null}
        <div class="titlerow">{props.title}</div>
        {props.sub ? <p class="sub">{props.sub}</p> : null}
      </div>
      {props.actions ? <div class="row">{props.actions}</div> : null}
    </div>
  );
}

export function Section(props: { title: string; note?: Child; children?: Child }) {
  return (
    <section class="card flush">
      <div class="card-head"><h2>{props.title}</h2>{props.note ? <span class="small muted">{props.note}</span> : null}</div>
      {props.children}
    </section>
  );
}

export function Empty(props: { children?: Child }) {
  return <p class="empty">{props.children}</p>;
}

/** Bar heights scaled to the largest value; numbers only end up in the style attribute. */
export function Bars(props: { values: number[]; height: number; tall?: boolean; label?: string }) {
  const max = Math.max(1, ...props.values);
  return (
    <div class={props.tall ? 'bars tall' : 'bars'} role={props.label ? 'img' : undefined}
      aria-label={props.label} aria-hidden={props.label ? undefined : 'true'}>
      {props.values.map(v => <div style={`height:${Math.round((v / max) * props.height)}px`}></div>)}
    </div>
  );
}

export function Chart(props: { title: string; series: Series }) {
  const { days, values } = props.series;
  return (
    <section class="card">
      <h2 style="margin-bottom:12px">{props.title}</h2>
      <Bars values={values} height={136} tall label={`${props.title}, ultimi 30 giorni`} />
      <div class="axis"><span>{fmtDay(days[0]!)}</span><span>{fmtDay(days[Math.floor(days.length / 2)]!)}</span><span>oggi</span></div>
    </section>
  );
}

export function NoiseTable(props: { rows: ReasonCount[]; pill?: boolean }) {
  if (props.rows.length === 0) return <Empty>Nessun report scartato come rumore.</Empty>;
  return (
    <div class="scroll">
      <table>
        <thead><tr><th>Motivo</th>{props.pill ? <th>Stato</th> : null}<th class="right">Report</th></tr></thead>
        <tbody>
          {props.rows.map(r => (
            <tr>
              <td>{NOISE_LABEL[r.reason] ?? r.reason}</td>
              {props.pill ? <td><Pill tone="gry">rumore</Pill></td> : null}
              <td class="right">{fmtNum(r.count)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Approve (site / all sites) and suspect buttons for one origin row; `back` is the page to return to. */
export function OriginActions(props: { siteId: number; originId: number; back: string; big?: boolean }) {
  const base = `/sites/${props.siteId}/origins/${props.originId}`;
  return (
    <div class="actions">
      <form method="post" action={`${base}/approve`} class="inline">
        <input type="hidden" name="scope" value="site" /><input type="hidden" name="back" value={props.back} />
        <button type="submit" class={props.big ? 'pri' : undefined}>{props.big ? 'Approva per questo sito' : 'Approva'}</button>
      </form>
      <form method="post" action={`${base}/approve`} class="inline">
        <input type="hidden" name="scope" value="global" /><input type="hidden" name="back" value={props.back} />
        <button type="submit">Approva per tutti</button>
      </form>
      <form method="post" action={`${base}/suspect`} class="inline">
        <input type="hidden" name="back" value={props.back} />
        <button type="submit" class={props.big ? 'dng' : undefined}>{props.big ? 'Segna sospetta' : 'Sospetta'}</button>
      </form>
    </div>
  );
}

export function Errors(props: { errors?: string[] }) {
  if (!props.errors || props.errors.length === 0) return null;
  return (
    <div class="alert red" role="alert">
      {props.errors.map(e => <div>{e}</div>)}
    </div>
  );
}

export function CopyBlock(props: { id: string; text: string; button: string }) {
  return (
    <>
      <pre class="mono block" id={props.id}>{props.text}</pre>
      <div class="row" style="margin-top:10px"><button type="button" data-copy={props.id}>{props.button}</button></div>
    </>
  );
}
