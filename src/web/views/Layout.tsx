import { createHash } from 'node:crypto';
import type { Child } from 'hono/jsx';
import { STYLE_HREF } from '../assets.js';
import type { NavData } from '../queries.js';
import { FAMILIES, TYPE_PAGES, typePageHref } from '../typePages.js';

export type Active =
  | { page: 'overview' | 'lists' | 'alerts' | 'new-site' }
  | { page: 'site' | 'csp' | 'settings'; siteId: number }
  | { page: 'type'; siteId: number; slug: string };

/**
 * The dashboard's only JavaScript: copy buttons. A static string with no data in it,
 * so injecting it unescaped is safe (report data never goes through this path).
 */
const COPY_SCRIPT = `document.addEventListener('click', function (e) {
  var b = e.target.closest && e.target.closest('button[data-copy]');
  if (!b) return;
  var el = document.getElementById(b.getAttribute('data-copy'));
  if (!el) return;
  var t = b.textContent;
  function say(msg) { b.textContent = msg; setTimeout(function () { b.textContent = t; }, 2000); }
  function fallback() {
    var r = document.createRange(); r.selectNodeContents(el);
    var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    say('Selezionato: premi Ctrl+C');
  }
  if (!navigator.clipboard) return fallback();
  navigator.clipboard.writeText(el.textContent).then(function () { say('Copiato'); }, fallback);
});`;

/** For the dashboard's Content-Security-Policy (script-src). */
export const COPY_SCRIPT_HASH = `'sha256-${createHash('sha256').update(COPY_SCRIPT).digest('base64')}'`;

function Logo() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2457D6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"></path>
      <path d="M9 12l2 2 4-4"></path>
    </svg>
  );
}

function Nav(props: { nav: NavData; active: Active }) {
  const { active } = props;
  const on = (cond: boolean) => (cond ? 'on' : undefined);
  const current = 'siteId' in active ? props.nav.sites.find(s => s.id === active.siteId) : undefined;
  return (
    <nav class="nav" aria-label="Menu">
      <div class="brand"><Logo />CSP Monitor</div>
      <a href="/" class={on(active.page === 'overview')}>Panoramica</a>
      <a href="/lists" class={on(active.page === 'lists')}>Approvazioni e rumore</a>
      <a href="/settings/alerts" class={on(active.page === 'alerts')}>Impostazioni alert</a>
      {current ? (
        <>
          <h4 title={current.name}>{current.name}</h4>
          <a href={`/sites/${current.id}`} class={on(active.page === 'site')}>Riepilogo</a>
          {FAMILIES.map(f => (
            <>
              <h4>{f.label}</h4>
              {TYPE_PAGES.filter(d => d.family === f.key).map(d => (
                <a href={typePageHref(current.id, d)}
                  class={on(d.slug === 'csp-violation' ? active.page === 'csp' : active.page === 'type' && active.slug === d.slug)}>{d.menu}</a>
              ))}
            </>
          ))}
          <a href={`/sites/${current.id}/settings`} class={on(active.page === 'settings')}>Impostazioni</a>
        </>
      ) : null}
      <h4>Siti</h4>
      {props.nav.sites.map(s => (
        <a href={`/sites/${s.id}`}>{s.name}</a>
      ))}
      <a href="/sites/new" class={on(active.page === 'new-site')}>+ Aggiungi sito</a>
      <form method="post" action="/logout"><button type="submit">Esci</button></form>
    </nav>
  );
}

export function Layout(props: { title: string; nav: NavData; active: Active; children?: Child }) {
  return (
    <html lang="it">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="referrer" content="same-origin" />
        <title>{`${props.title} - CSP Monitor`}</title>
        <link rel="stylesheet" href={STYLE_HREF} />
      </head>
      <body>
        <div class="shell">
          <Nav nav={props.nav} active={props.active} />
          <main>{props.children}</main>
        </div>
        <script dangerouslySetInnerHTML={{ __html: COPY_SCRIPT }} />
      </body>
    </html>
  );
}

/** Plain page with a title and one message (404, refused action). */
export function MessagePage(props: { nav: NavData; title: string; text: string; back?: string }) {
  return (
    <Layout title={props.title} nav={props.nav} active={{ page: 'overview' }}>
      <h1>{props.title}</h1>
      <p>{props.text}</p>
      <p><a href={props.back ?? '/'}>Torna indietro</a></p>
    </Layout>
  );
}
