# CSP Monitor — Piano 1: base e violazioni CSP

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** un servizio Docker che riceve i report CSP di più siti, filtra il rumore, tiene l'inventario delle origini per sito, manda alert email raggruppati sulle origini nuove e mostra tutto in una dashboard protetta da login.

**Architecture:** un solo processo Node.js (Hono) che serve l'endpoint `/r/:key`, la dashboard renderizzata lato server (hono/jsx) e uno scheduler interno; dati in un file SQLite (better-sqlite3) su volume Docker; Caddy davanti per HTTPS. Rate limit e cache delle origini note sono in memoria (processo singolo).

**Tech Stack:** Node.js 24, TypeScript 5 (ESM, `"strict": true`), Hono 4 + `@hono/node-server` + `hono/jsx`, better-sqlite3 11, nodemailer 6, Vitest 2, tsx (sviluppo), Docker + Caddy 2.

**Spec:** `docs/superpowers/specs/2026-11-12-csp-monitor-design.md` (sezioni 1–6, 9; "Tipi di report" solo per `csp-violation`). Mockup: https://claude.ai/artifact/6Fh6uA4XHSymiLm7rvLdhp (pagine Panoramica, Sito, Origine, Violazioni CSP). I piani 2 e 3 costruiscono sopra questo.

## Global Constraints

- Interfaccia in italiano; codice, nomi e commenti in inglese.
- Nessuna dipendenza da un fornitore cloud: deve girare con `docker compose up` su qualsiasi server.
- Non si salva mai l'IP del visitatore. Query string e fragment tolti da ogni URL prima di salvarlo. User agent ridotto a famiglia + versione maggiore.
- L'endpoint `/r/:key` risponde sempre `204` senza corpo, anche per input non valido o chiave sconosciuta; CORS `Access-Control-Allow-Origin: *`, metodi `POST, OPTIONS`, header `Content-Type`.
- Body oltre 64 KB (65 536 byte) scartato senza leggerlo oltre.
- Tutto il testo che arriva dai report (URL, `script-sample`, `source-file`, user agent) è input ostile: nella dashboard e nelle email va sempre escapato (hono/jsx lo fa; mai `dangerouslySetInnerHTML` con dati dei report).
- Tempi: tutte le funzioni che dipendono dall'ora ricevono `now: number` (ms epoch) come parametro; niente `Date.now()` fuori da `server.ts` e dallo scheduler.
- Valori di default (configurabili per sito dove indicato): rate limit 120 report/minuto e 20 000/giorno per sito; raggruppamento alert 10 minuti; apprendimento 7 giorni; sito silenzioso dopo 3 giorni senza report; sospetta ri-allerta dopo 30 giorni di assenza; 20 campioni per origine + tutti quelli degli ultimi 7 giorni; contatori giornalieri 90 giorni; backup giornalieri tenuti 14.
- Il modello degli alert deve supportare più canali (email ora; webhook e Telegram dopo): l'invio passa da un'interfaccia `AlertChannel`.

## Review Focus

1. **Dati dei report mostrati in pagina o in email** (`script-sample` con `<script>`, URL con `"` e `<`): devono uscire escapati. Test in Task 11 e Task 9.
2. **Body malformati** (JSON rotto, array vuoto, oggetto senza `csp-report`, content type `application/json` o `text/plain` come mandano alcuni browser, 70 KB): `204`, niente salvato, nessuna eccezione non gestita. Test in Task 2 e Task 8.
3. **Varianti della stessa origine** (`HTTPS://CDN.Example.com:443/x?y`, `https://cdn.example.com./`, host IDN `https://bücher.example`, `https://user:pw@cdn.example.com`): stessa origine normalizzata. Test in Task 3.
4. **SMTP che fallisce durante l'invio di un gruppo di alert**: gli alert restano in coda, vengono ritentati al giro successivo e non vengono mai mandati due volte dopo un successo. Test in Task 9.
5. **Sito oltre il rate limit che riceve un'origine nuova in mezzo al flusso**: l'origine nuova viene comunque registrata e messa in coda di alert. Test in Task 8.

---

## Struttura dei file

```
package.json, tsconfig.json, vitest.config.ts, .env.example, Dockerfile, compose.yaml, Caddyfile, README.md
scripts/hash-password.ts
src/server.ts                 avvio: config, db, scheduler, http
src/config.ts                 lettura variabili d'ambiente
src/db/schema.sql             schema completo
src/db/db.ts                  apertura e migrazione
src/match.ts                  origini, pattern con jolly, domini del sito
src/ingest/ua.ts              riduzione user agent, bot
src/ingest/parse.ts           body → RawReport[]
src/ingest/csp.ts             RawReport csp → CspEvent
src/ingest/noise.ts           classificazione rumore
src/ingest/limits.ts          RateLimiter, KnownCache
src/ingest/handler.ts         pipeline di ingestione
src/store/sites.ts            siti
src/store/origins.ts          origini, approvazioni, contatori, campioni
src/store/settings.ts         impostazioni chiave/valore
src/alerts/decide.ts          decisione alert per un evento CSP
src/alerts/queue.ts           coda e raggruppamento
src/alerts/render.ts          testo delle email
src/alerts/channels.ts        AlertChannel, EmailChannel
src/auth/password.ts          scrypt
src/auth/session.ts           cookie firmato, limitatore login
src/headers.ts                header da copiare (stretto e suggerito)
src/jobs/scheduler.ts         lavori periodici
src/jobs/maintenance.ts       pulizia dati e backup
src/web/app.ts                rotte Hono
src/web/views/*.tsx           pagine
tests/**/*.test.ts, tests/fixtures/*.json
```

---

### Task 1: Scheletro del progetto, configurazione, database, `/health`

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`, `src/config.ts`, `src/db/schema.sql`, `src/db/db.ts`, `src/web/app.ts`, `src/server.ts`
- Test: `tests/config.test.ts`, `tests/db.test.ts`, `tests/health.test.ts`

**Interfaces:**
- Produces:
  - `type Config = { port: number; baseUrl: string; dataDir: string; adminPasswordHash: string; sessionSecret: string; trustProxy: boolean; secureCookies: boolean; smtp: { host: string; port: number; user?: string; pass?: string; from: string; secure: boolean }; alertEmail: string }`
  - `loadConfig(env: Record<string, string | undefined>): Config` — lancia `Error` con il nome della variabile mancante.
  - `type Db = import('better-sqlite3').Database`; `openDb(file: string): Db` (`:memory:` ammesso) — attiva `journal_mode=WAL`, `foreign_keys=ON`, esegue `schema.sql` (idempotente, `CREATE TABLE IF NOT EXISTS`).
  - `type Deps = { db: Db; config: Config; now: () => number; channels: AlertChannel[]; limiter: RateLimiter; known: KnownCache }` (i tipi `AlertChannel`, `RateLimiter`, `KnownCache` arrivano nei Task 8–9: dichiararli qui come interfacce vuote da riempire è accettabile, oppure aggiungere i campi a `Deps` quando servono).
  - `createApp(deps: Deps): Hono`

Variabili d'ambiente: `PORT` (3000), `BASE_URL` (obbligatoria, es. `https://monitor.example.it`), `DATA_DIR` (`/data`), `ADMIN_PASSWORD_HASH` (obbligatoria), `SESSION_SECRET` (obbligatoria, ≥ 32 caratteri), `TRUST_PROXY` (`1`/`0`, default `1`), `SECURE_COOKIES` (default `1`), `SMTP_HOST`, `SMTP_PORT` (587), `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_SECURE` (`0`), `ALERT_EMAIL`.

Schema (`src/db/schema.sql`), tutte le date in ms epoch, `day` come `'YYYY-MM-DD'` UTC:

```sql
CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, key TEXT NOT NULL UNIQUE,
  domains TEXT NOT NULL,              -- JSON array di pattern: "gida-spa.it", "*.gida-spa.it"
  created_at INTEGER NOT NULL, learning_until INTEGER NOT NULL,
  learning_summary_sent INTEGER NOT NULL DEFAULT 0,
  rate_per_min INTEGER NOT NULL DEFAULT 120, rate_per_day INTEGER NOT NULL DEFAULT 20000,
  last_report_at INTEGER
);
CREATE TABLE IF NOT EXISTS origins (
  id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  report_type TEXT NOT NULL DEFAULT 'csp-violation',
  directive TEXT NOT NULL, origin TEXT NOT NULL,
  category TEXT NOT NULL,             -- external | inline | eval | data | blob | self
  status TEXT NOT NULL DEFAULT 'new', -- new | approved | suspect
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 0,
  first_page TEXT, last_alert_at INTEGER,
  UNIQUE (site_id, report_type, directive, origin)
);
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY, site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE, -- NULL = globale
  pattern TEXT NOT NULL, directive TEXT NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE (site_id, pattern, directive)
);
CREATE TABLE IF NOT EXISTS noise_patterns (id INTEGER PRIMARY KEY, pattern TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS daily_counts (
  site_id INTEGER NOT NULL, report_type TEXT NOT NULL, directive TEXT NOT NULL, origin TEXT NOT NULL,
  day TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (site_id, report_type, directive, origin, day)
);
CREATE TABLE IF NOT EXISTS noise_counts (
  site_id INTEGER NOT NULL, reason TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL,
  PRIMARY KEY (site_id, reason, day)  -- reason: extension | foreign-document | known-noise | bot | rate-limit | invalid
);
CREATE TABLE IF NOT EXISTS samples (
  id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL, origin_id INTEGER REFERENCES origins(id) ON DELETE CASCADE,
  report_type TEXT NOT NULL, received_at INTEGER NOT NULL, page TEXT, source_file TEXT,
  script_sample TEXT, line INTEGER, ua TEXT, disposition TEXT, body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS samples_origin ON samples (origin_id, received_at);
CREATE TABLE IF NOT EXISTS pending_alerts (
  id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL, origin_id INTEGER, kind TEXT NOT NULL,
  created_at INTEGER NOT NULL, sent_at INTEGER
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

- [ ] **Step 1: Scrivi i test che falliscono**

```ts
// tests/config.test.ts
it('throws naming the missing variable', () => {
  expect(() => loadConfig({ BASE_URL: 'https://m.example.it' })).toThrow(/ADMIN_PASSWORD_HASH/);
});
it('rejects a short SESSION_SECRET', () => {
  expect(() => loadConfig(validEnv({ SESSION_SECRET: 'short' }))).toThrow(/SESSION_SECRET/);
});
it('applies defaults', () => {
  const c = loadConfig(validEnv());
  expect(c.port).toBe(3000); expect(c.dataDir).toBe('/data'); expect(c.trustProxy).toBe(true);
});
// tests/db.test.ts
it('creates all tables and is idempotent', () => {
  const db = openDb(':memory:');
  db.exec(readFileSync('src/db/schema.sql', 'utf8'));
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name);
  expect(names).toEqual(expect.arrayContaining(['sites','origins','approvals','noise_patterns','daily_counts','noise_counts','samples','pending_alerts','settings']));
});
// tests/health.test.ts
it('GET /health returns 200 ok when the db answers', async () => {
  const res = await createApp(testDeps()).request('/health');
  expect(res.status).toBe(200); expect(await res.json()).toEqual({ ok: true });
});
```

`validEnv(overrides)` e `testDeps()` sono helper in `tests/helpers.ts` (db in memoria, `now` fisso `Date.UTC(2026, 10, 12, 9, 0)`).

- [ ] **Step 2:** `npx vitest run` → FAIL (moduli mancanti).
- [ ] **Step 3:** implementa `loadConfig`, `openDb`, `createApp` con la sola rotta `GET /health` (esegue `SELECT 1`; se fallisce risponde 503 `{ ok: false }`), `server.ts` che avvia `@hono/node-server` su `config.port` con `db` in `${dataDir}/csp-monitor.sqlite`. Script npm: `dev` (tsx watch), `build` (tsc), `start` (node dist/server.js), `test` (vitest run), `hash-password`.
- [ ] **Step 4:** `npx vitest run` → PASS.
- [ ] **Step 5:** commit `feat: project skeleton, config, schema, health route`.

---

### Task 2: Parsing dei body dei report

**Files:**
- Create: `src/ingest/parse.ts`, `tests/fixtures/csp-report-legacy.json`, `tests/fixtures/reports-json-chrome.json`, `tests/fixtures/reports-json-mixed.json`
- Test: `tests/ingest/parse.test.ts`

**Interfaces:**
- Produces:
  - `type RawReport = { type: string; url?: string; userAgent?: string; body: Record<string, unknown> }`
  - `parseBody(contentType: string | undefined, text: string): RawReport[]` — mai lancia; input non valido → `[]`.

Regole: `application/csp-report` → oggetto con chiave `csp-report` → un `RawReport` con `type: 'csp-violation'` e `body` = il contenuto di `csp-report` con le chiavi in kebab-case convertite in camelCase (`document-uri`→`documentURL`, `blocked-uri`→`blockedURL`, `effective-directive`→`effectiveDirective`, `violated-directive`→`violatedDirective`, `source-file`→`sourceFile`, `script-sample`→`sample`, `line-number`→`lineNumber`, `column-number`→`columnNumber`, `disposition`, `status-code`→`statusCode`), così il resto del codice vede un solo formato. `application/reports+json` → array di oggetti `{ type, url, user_agent, body }`. `application/json` o `text/plain` (o content type assente) → si prova a riconoscere uno dei due formati dalla forma del JSON. Tipi diversi da `csp-violation` vengono restituiti comunque (li scarta o li gestisce il chiamante; il Piano 2 li userà).

- [ ] **Step 1: test**

```ts
it('maps the legacy report-uri format to Reporting API field names', () => {
  const [r] = parseBody('application/csp-report', fixture('csp-report-legacy.json'));
  expect(r.type).toBe('csp-violation');
  expect(r.body).toMatchObject({ documentURL: 'https://www.gida-spa.it/prodotti?x=1', blockedURL: 'https://cdn-stats.xyz/c.js', effectiveDirective: 'script-src-elem', sample: '' });
});
it('reads every report of a reports+json batch', () => {
  expect(parseBody('application/reports+json', fixture('reports-json-mixed.json')).map(r => r.type))
    .toEqual(['csp-violation', 'deprecation', 'csp-violation']);
});
it.each([
  ['application/csp-report', '{not json'], ['application/reports+json', '[]'],
  ['application/reports+json', '{"type":"csp-violation"}'], ['application/csp-report', '{"foo":1}'],
  ['text/plain', 'hello'], [undefined, ''],
])('returns [] for invalid input %s %s', (ct, body) => { expect(parseBody(ct, body)).toEqual([]); });
it('sniffs the format when content type is application/json', () => {
  expect(parseBody('application/json', fixture('csp-report-legacy.json'))).toHaveLength(1);
});
```

- [ ] **Step 2:** run → FAIL. **Step 3:** implementa. **Step 4:** run → PASS. **Step 5:** commit `feat: parse csp-report and reports+json bodies`.

Le fixture vanno scritte a mano a partire da report reali (Chrome 13x e Firefox 13x); includi in `reports-json-chrome.json` un report con `blockedURL: "inline"` e `sample` valorizzato.

---

### Task 3: Origini, pattern con jolly, domini del sito, user agent

**Files:**
- Create: `src/match.ts`, `src/ingest/ua.ts`
- Test: `tests/match.test.ts`, `tests/ingest/ua.test.ts`

**Interfaces:**
- Produces:
  - `normalizeOrigin(url: string): string | null` — `scheme://host[:port]` minuscolo, host in punycode, senza punto finale, porta omessa se default (80/443/ws 80/wss 443), credenziali ignorate; `null` se non è un URL assoluto con host.
  - `stripUrl(url: string): string` — URL senza query e fragment (input non valido → stringa vuota).
  - `pathOf(url: string): string` — solo il path, `'/'` se vuoto.
  - `matchesPattern(pattern: string, origin: string): boolean` — pattern esatto (`https://cdn.example.com`) o con jolly sul sottodominio (`https://*.example.com`, che corrisponde a `https://a.example.com` e `https://a.b.example.com` ma **non** a `https://example.com`); un pattern senza schema (`*.example.com`, `cdn.example.com`) vale per `http`, `https`, `ws`, `wss`.
  - `hostMatchesDomains(host: string, domains: string[]): boolean` — stesse regole per i domini propri del sito (`gida-spa.it`, `*.gida-spa.it`).
  - `isRiskyWildcard(pattern: string): boolean` — `true` se è un jolly su uno di: `cloudfront.net`, `googleusercontent.com`, `workers.dev`, `pages.dev`, `vercel.app`, `netlify.app`, `herokuapp.com`, `github.io`, `azurewebsites.net`, `blob.core.windows.net`, `s3.amazonaws.com`, `appspot.com`, `firebaseapp.com`, `web.app`.
  - `reduceUa(ua: string | undefined): { label: string; isBot: boolean }` — `label` tipo `'Chrome 131'`, `'Safari 18'`, `'Firefox 133'`, `'Edge 131'`, `'Chrome Android 131'`, `'Altro'`; `isBot` per user agent che contengono `bot`, `crawler`, `spider`, `HeadlessChrome`, `Lighthouse`, `Googlebot`, `bingbot`, `facebookexternalhit`, `curl`, `python-requests`.

- [ ] **Step 1: test**

```ts
it.each([
  'HTTPS://CDN.Example.com:443/x?y=1#z', 'https://cdn.example.com./', 'https://user:pw@cdn.example.com/a',
])('normalizes %s', u => expect(normalizeOrigin(u)).toBe('https://cdn.example.com'));
it('keeps non-default ports and converts IDN', () => {
  expect(normalizeOrigin('https://cdn.example.com:8443/a')).toBe('https://cdn.example.com:8443');
  expect(normalizeOrigin('https://bücher.example/')).toBe('https://xn--bcher-kva.example');
});
it.each(['inline', 'eval', '', 'data', '/relative/path', 'about'])('returns null for %s', v => expect(normalizeOrigin(v)).toBeNull());
it('wildcard matches subdomains only', () => {
  expect(matchesPattern('https://*.hotjar.com', 'https://script.hotjar.com')).toBe(true);
  expect(matchesPattern('https://*.hotjar.com', 'https://hotjar.com')).toBe(false);
  expect(matchesPattern('https://*.hotjar.com', 'https://evilhotjar.com')).toBe(false);
  expect(matchesPattern('*.hotjar.com', 'wss://ws.hotjar.com')).toBe(true);
  expect(matchesPattern('https://cdn.example.com', 'http://cdn.example.com')).toBe(false);
});
it('flags wildcards on shared hosting', () => {
  expect(isRiskyWildcard('*.cloudfront.net')).toBe(true);
  expect(isRiskyWildcard('https://*.hotjar.com')).toBe(false);
  expect(isRiskyWildcard('https://d1.cloudfront.net')).toBe(false);
});
it('reduces user agents', () => {
  expect(reduceUa(CHROME_131_MAC)).toEqual({ label: 'Chrome 131', isBot: false });
  expect(reduceUa(GOOGLEBOT)).toMatchObject({ isBot: true });
});
it('strips query and fragment', () => {
  expect(stripUrl('https://a.it/p?email=x@y.it#f')).toBe('https://a.it/p');
});
```

- [ ] **Step 2–5:** FAIL → implementa (usa `new URL()`; per l'IDN `URL` produce già punycode) → PASS → commit `feat: origin normalization, wildcard patterns, ua reduction`.

---

### Task 4: Normalizzazione degli eventi CSP

**Files:**
- Create: `src/ingest/csp.ts`
- Test: `tests/ingest/csp.test.ts`

**Interfaces:**
- Consumes: `RawReport` (Task 2), `normalizeOrigin`, `stripUrl`, `pathOf`, `hostMatchesDomains`, `reduceUa` (Task 3).
- Produces:
  - `type Category = 'external' | 'inline' | 'eval' | 'data' | 'blob' | 'self'`
  - `type CspEvent = { directive: string; origin: string; category: Category; page: string; documentUrl: string; documentHost: string; blockedRaw: string; sourceFile: string; sample: string; line: number | null; disposition: 'enforce' | 'report'; ua: string; isBot: boolean }`
  - `toCspEvent(raw: RawReport, siteDomains: string[]): CspEvent | null` — `null` se manca `documentURL` o la direttiva.

Regole:
- `directive`: `effectiveDirective`, altrimenti il primo token di `violatedDirective`; poi si toglie il suffisso `-elem` / `-attr` (`script-src-elem` → `script-src`).
- `blockedURL` → `category` e `origin`:
  - `inline` o vuoto → `inline`, origin `'inline'`; `eval` / `wasm-eval` → `eval`, origin `'eval'`;
  - `data` o che inizia con `data:` → `data`, origin `'data:'`; `blob` / `blob:` → `blob`, origin `'blob:'`;
  - URL assoluto: `origin = normalizeOrigin(...)`; se l'host è nei domini del sito → `self`, altrimenti `external`;
  - schemi di estensione (`chrome-extension`, `moz-extension`, `safari-extension`, `safari-web-extension`, `ms-browser-extension`, `webkit-masked-url`): `category: 'external'`, `origin` = `'<schema>:'`, `blockedRaw` conservato (il filtro rumore li riconosce dal `blockedRaw`).
  - qualunque altro valore → `external` con `origin` = il valore troncato a 200 caratteri.
- `page = pathOf(documentURL)`; `documentUrl = stripUrl(documentURL)`; `documentHost` = host minuscolo.
- `sourceFile = stripUrl(sourceFile)` se presente; `sample` troncato a 200 caratteri; `disposition` da `body.disposition` (default `'report'`).
- `ua` / `isBot` da `reduceUa(raw.userAgent)`.

- [ ] **Step 1: test** (uno per riga dell'elenco sopra), più:

```ts
it('treats subdomains of the site as self', () => {
  const e = toCspEvent(report({ blockedURL: 'https://media.gida-spa.it/a.jpg', effectiveDirective: 'img-src' }), ['gida-spa.it', '*.gida-spa.it'])!;
  expect(e).toMatchObject({ category: 'self', origin: 'https://media.gida-spa.it', directive: 'img-src' });
});
it('never keeps query strings', () => {
  const e = toCspEvent(report({ documentURL: 'https://www.gida-spa.it/p?token=abc', sourceFile: 'https://www.gida-spa.it/a.js?v=1' }), ['*.gida-spa.it'])!;
  expect(e.documentUrl).toBe('https://www.gida-spa.it/p'); expect(e.sourceFile).toBe('https://www.gida-spa.it/a.js');
});
```

- [ ] **Step 2–5:** FAIL → implementa → PASS → commit `feat: normalize csp violation reports`.

---

### Task 5: Filtro del rumore

**Files:**
- Create: `src/ingest/noise.ts`
- Test: `tests/ingest/noise.test.ts`

**Interfaces:**
- Consumes: `CspEvent`, `hostMatchesDomains`, `matchesPattern`.
- Produces:
  - `type NoiseReason = 'extension' | 'foreign-document' | 'known-noise' | 'bot'`
  - `BUILTIN_NOISE: string[]` — lista iniziale di pattern (domini iniettati da antivirus, toolbar, traduttori; parti da una decina di voci verificabili, es. `*.kaspersky-labs.com`, `gc.kis.v2.scr.kaspersky-labs.com`, `*.translate.goog`, `translate.googleapis.com`, `*.grammarly.io`, `*.lastpass.com`; nel codice un commento con la fonte di ciascuna).
  - `classifyNoise(e: CspEvent, siteDomains: string[], extraPatterns: string[]): NoiseReason | null` — ordine: `extension` (schema di estensione in `blockedRaw` o `sourceFile`) → `foreign-document` (`documentHost` non nei domini del sito) → `bot` → `known-noise` (`BUILTIN_NOISE` + `extraPatterns`).

- [ ] **Step 1: test** (un caso per ogni motivo, più): un report da `https://www-gida--spa-it.translate.goog/` è `foreign-document`; un `sourceFile` `moz-extension://…` con `blockedURL` esterno normale è `extension`; un report pulito restituisce `null`.
- [ ] **Step 2–5:** FAIL → implementa → PASS → commit `feat: noise classification`.

---

### Task 6: Siti, impostazioni, header da copiare

**Files:**
- Create: `src/store/sites.ts`, `src/store/settings.ts`, `src/headers.ts`
- Test: `tests/store/sites.test.ts`, `tests/headers.test.ts`

**Interfaces:**
- Produces:
  - `type Site = { id: number; name: string; key: string; domains: string[]; createdAt: number; learningUntil: number; learningSummarySent: boolean; ratePerMin: number; ratePerDay: number; lastReportAt: number | null }`
  - `createSite(db, input: { name: string; domains: string[] }, now: number): Site` — chiave casuale di 16 caratteri `[A-Za-z0-9]` da `crypto.randomBytes`; `learningUntil = now + 7 giorni`.
  - `getSiteByKey(db, key): Site | null`, `getSite(db, id): Site | null`, `listSites(db): Site[]`
  - `updateSite(db, id, patch: Partial<Pick<Site, 'name' | 'domains' | 'ratePerMin' | 'ratePerDay'>>): void`
  - `endLearning(db, id, now): void` — `learningUntil = now`.
  - `touchSite(db, id, now): void` — aggiorna `last_report_at`.
  - `getSetting(db, key): string | null`, `setSetting(db, key, value): void` (chiave usata ora: `alert_email`; default da `config.alertEmail`).
  - `strictHeaders(baseUrl: string, key: string): string` — esattamente le due righe della spec sezione 1.
  - `suggestedHeaders(baseUrl: string, key: string, approved: { directive: string; pattern: string }[]): string` — come `strictHeaders`, ma a ogni direttiva si aggiungono i pattern approvati (per sito e globali) per quella direttiva, ordinati e senza doppioni; le direttive non presenti nella policy di partenza (es. `media-src`) si aggiungono con `'self'` + pattern.

- [ ] **Step 1: test** — chiave di 16 caratteri e unica su 1000 siti; `learningUntil`; `strictHeaders` uguale byte per byte all'esempio della spec con `<servizio>` e `<chiave>` sostituiti; `suggestedHeaders` con `{script-src: https://www.googletagmanager.com}` produce `script-src 'self' https://www.googletagmanager.com;`.
- [ ] **Step 2–5:** FAIL → implementa → PASS → commit `feat: sites, settings, header generation`.

---

### Task 7: Origini, approvazioni, contatori, decisione di alert

**Files:**
- Create: `src/store/origins.ts`, `src/alerts/decide.ts`
- Test: `tests/store/origins.test.ts`, `tests/alerts/decide.test.ts`

**Interfaces:**
- Consumes: `Site`, `CspEvent`, `NoiseReason`, `matchesPattern`.
- Produces:
  - `isCovered(db, siteId: number, origin: string, directive: string): boolean` — esiste un'approvazione con `site_id = siteId` o `NULL`, stessa `directive`, e `matchesPattern(pattern, origin)`.
  - `type RecordResult = { originId: number; isNewRow: boolean; status: 'new' | 'approved' | 'suspect'; previousLastSeen: number | null }`
  - `recordCspEvent(db, site: Site, e: CspEvent, now: number): RecordResult` — in una transazione: upsert in `origins` (chiave `site, 'csp-violation', directive, origin`; alla creazione `status` = `'approved'` se `isCovered`, `'suspect'` se la stessa origine è `suspect` su un'altra direttiva dello stesso sito, altrimenti `'new'`; `first_page` = `e.page`), incrementa `count`, aggiorna `last_seen`, incrementa `daily_counts`, inserisce un campione in `samples` (con `body` = JSON del report originale troncato a 8 KB).
  - `recordNoise(db, siteId, reason: NoiseReason | 'rate-limit' | 'invalid', now): void` — incrementa `noise_counts`.
  - `approveOrigin(db, siteId: number, origin: string, scope: 'site' | 'global', now: number): void` — crea un'approvazione per ogni direttiva con cui l'origine è stata vista **finora** su quel sito; mette `status='approved'` su quelle righe (per `global`, anche su tutte le righe uguali degli altri siti).
  - `addApprovalPattern(db, siteId: number | null, pattern: string, directives: string[], now): void` — per i jolly creati a mano; aggiorna a `approved` le righe esistenti coperte.
  - `markSuspect(db, siteId, origin): void`, `removeApproval(db, approvalId): void`
  - `decideCspAlert(input: { site: Site; event: CspEvent; noise: NoiseReason | null; result: RecordResult; now: number }): boolean`

Regole di `decideCspAlert` (spec sezione 5):
- `false` se `noise` non è `null`, o `category` è `inline`, `eval` o `self`.
- Riga nuova: `true` se `status === 'new'` o `'suspect'` e il sito **non** è in apprendimento (`now >= site.learningUntil`); `false` altrimenti.
- Riga esistente: `true` solo se `status === 'suspect'` e `previousLastSeen` è più vecchio di 30 giorni.

- [ ] **Step 1: test**

```ts
it('approval covers only directives seen so far', () => {
  recordCspEvent(db, site, ev({ origin: 'https://x.com', directive: 'img-src' }), T0);
  approveOrigin(db, site.id, 'https://x.com', 'site', T0);
  const r = recordCspEvent(db, site, ev({ origin: 'https://x.com', directive: 'script-src' }), T1);
  expect(r).toMatchObject({ isNewRow: true, status: 'new' });
  expect(decideCspAlert({ site: afterLearning, event: ev({ origin: 'https://x.com', directive: 'script-src' }), noise: null, result: r, now: T1 })).toBe(true);
});
it('global approval silences every site', () => { /* approva globale su A, primo report su B → status approved, nessun alert */ });
it('no alerts during learning', () => { /* sito appena creato, origine nuova → false */ });
it('suspect re-alerts after 30 days of absence and on a new directive', () => { /* … */ });
it('noise, inline, eval and self never alert', () => { /* … */ });
it('wildcard approval created by hand covers subdomains', () => { /* addApprovalPattern('https://*.hotjar.com') → nuova riga https://script.hotjar.com è approved */ });
```

- [ ] **Step 2–5:** FAIL → implementa → PASS → commit `feat: origin inventory, approvals and alert decision`.

---

### Task 8: Pipeline di ingestione ed endpoint `/r/:key`

**Files:**
- Create: `src/ingest/limits.ts`, `src/ingest/handler.ts`; Modify: `src/web/app.ts`
- Test: `tests/ingest/limits.test.ts`, `tests/ingest/handler.test.ts`, `tests/web/collect.test.ts`

**Interfaces:**
- Consumes: Task 2–7; `enqueueAlert` (Task 9: in questo task passa una funzione `onAlert(siteId, originId, now)` iniettata; il Task 9 la collega alla coda).
- Produces:
  - `class RateLimiter { constructor(); allow(siteId: number, perMin: number, perDay: number, now: number): boolean }` — finestre fisse per minuto e per giorno UTC, in memoria.
  - `class KnownCache { load(db: Db): void; has(siteId: number, directive: string, origin: string): boolean; add(siteId: number, directive: string, origin: string): void }` — caricata all'avvio da `origins`.
  - `ingest(deps: Deps, key: string, contentType: string | undefined, text: string, now: number): void` — mai lancia (errori loggati con `console.error` senza dati del report).
  - Rotte: `OPTIONS /r/:key` → 204 con header CORS; `POST /r/:key` → legge il body con limite 64 KB (se `Content-Length` > 65 536 o il body letto supera il limite: 204 e `recordNoise(..., 'invalid')`), chiama `ingest`, risponde 204.

Pipeline per ogni `RawReport` di tipo `csp-violation` (gli altri tipi si ignorano in questo piano):
1. sito da `key`; se assente → stop.
2. `toCspEvent`; se `null` → `recordNoise('invalid')`.
3. Se `!limiter.allow(...)`: se `known.has(site, directive, origin)` → `recordNoise('rate-limit')` e stop; altrimenti si continua (origine mai vista: va sempre registrata).
4. `classifyNoise` con i pattern di `noise_patterns`; se rumore → `recordNoise(reason)` e stop.
5. `recordCspEvent`; `known.add`; `touchSite`.
6. se `decideCspAlert` → `onAlert(site.id, originId, now)` e aggiorna `origins.last_alert_at`.

- [ ] **Step 1: test**

```ts
it('responds 204 to everything, including unknown keys and garbage', async () => {
  for (const [key, body] of [['nope', '{}'], [site.key, '{bad'], [site.key, 'x'.repeat(70_000)]]) {
    const res = await app.request(`/r/${key}`, { method: 'POST', headers: { 'content-type': 'application/csp-report' }, body });
    expect(res.status).toBe(204); expect(await res.text()).toBe('');
  }
});
it('answers CORS preflight', async () => {
  const res = await app.request(`/r/${site.key}`, { method: 'OPTIONS' });
  expect(res.status).toBe(204); expect(res.headers.get('access-control-allow-origin')).toBe('*');
});
it('a new origin inside a flood still reaches the alert queue', () => {
  const alerts: number[] = [];
  for (let i = 0; i < 500; i++) ingest(deps(alerts), site.key, CT, legacy({ blockedURL: 'https://known.example/a.js' }), T);
  ingest(deps(alerts), site.key, CT, legacy({ blockedURL: 'https://evil.example/x.js' }), T);
  expect(alerts).toHaveLength(1);
  expect(countNoise(db, site.id, 'rate-limit')).toBeGreaterThan(0);
});
it('never stores query strings or IPs', () => { /* dopo un ingest con query string, nessuna colonna di samples contiene "?" o l'IP di test */ });
```

(`site` creato con `learningUntil` già passato.)

- [ ] **Step 2–5:** FAIL → implementa → PASS → commit `feat: ingestion pipeline and collect endpoint`.

---

### Task 9: Coda degli alert, email, scheduler

**Files:**
- Create: `src/alerts/queue.ts`, `src/alerts/render.ts`, `src/alerts/channels.ts`, `src/jobs/scheduler.ts`; Modify: `src/server.ts`, `src/ingest/handler.ts` (collega `onAlert` a `enqueueAlert`)
- Test: `tests/alerts/queue.test.ts`, `tests/alerts/render.test.ts`, `tests/jobs/scheduler.test.ts`

**Interfaces:**
- Produces:
  - `enqueueAlert(db, siteId: number, originId: number, now: number): void` — `kind = 'new-origin'`.
  - `type AlertItem = { origin: string; directive: string; page: string; sourceFile: string; sample: string; firstSeen: number; originId: number }`
  - `type AlertBatch = { site: Site; items: AlertItem[]; pendingIds: number[] }`
  - `dueBatches(db, now: number, groupMs = 600_000): AlertBatch[]` — un batch per sito il cui alert pendente più vecchio ha almeno `groupMs`; include tutti i pendenti di quel sito.
  - `markSent(db, ids: number[], now): void`
  - `type AlertMessage = { subject: string; text: string; html: string }`
  - `renderAlertBatch(b: AlertBatch, baseUrl: string): AlertMessage` — oggetto `[CSP Monitor] <sito>: N origini nuove`; per ogni voce origine, direttiva, pagina, file di partenza o `sample`, link `${baseUrl}/sites/<id>/origins/<originId>`. HTML escapato.
  - `renderLearningSummary(site: Site, items: AlertItem[], baseUrl): AlertMessage` — oggetto `[CSP Monitor] <sito>: fine apprendimento, N origini da rivedere`.
  - `interface AlertChannel { name: string; send(msg: AlertMessage): Promise<void> }`; `class EmailChannel implements AlertChannel` (nodemailer, destinatario da `getSetting('alert_email') ?? config.alertEmail`).
  - `runDueAlerts(deps, now): Promise<void>` — per ogni batch: invia su tutti i canali; `markSent` solo se tutti gli invii riescono; in caso di errore lascia i pendenti e logga.
  - `runLearningSummaries(deps, now): Promise<void>` — siti con `now >= learningUntil` e `learningSummarySent = false`: email con le origini `status='new'` (anche se zero: "nessuna origine da rivedere"), poi `learning_summary_sent = 1` solo se l'invio riesce.
  - `startScheduler(deps): () => void` — ogni 60 s `runDueAlerts` + `runLearningSummaries`; una volta al giorno alle 03:00 UTC i lavori di manutenzione (Task 12). Restituisce la funzione di stop. Un giro non parte se il precedente è ancora in corso.

- [ ] **Step 1: test**

```ts
it('groups alerts of the same site and waits 10 minutes', () => {
  enqueueAlert(db, s1, o1, T); enqueueAlert(db, s1, o2, T + 60_000); enqueueAlert(db, s2, o3, T);
  expect(dueBatches(db, T + 599_999)).toHaveLength(0);
  const b = dueBatches(db, T + 600_000);
  expect(b.map(x => x.items.length).sort()).toEqual([1, 2]);
});
it('keeps alerts pending when sending fails and never sends twice', async () => {
  const flaky = channelFailingOnce();
  enqueueAlert(db, s1, o1, T);
  await runDueAlerts(deps([flaky]), T + 600_000);
  expect(flaky.sent).toHaveLength(0);
  await runDueAlerts(deps([flaky]), T + 660_000);
  await runDueAlerts(deps([flaky]), T + 720_000);
  expect(flaky.sent).toHaveLength(1);
});
it('escapes report data in emails', () => {
  const m = renderAlertBatch(batchWith({ sample: '<script>alert(1)</script>' }), BASE);
  expect(m.html).not.toContain('<script>alert'); expect(m.html).toContain('&lt;script&gt;');
});
it('sends the learning summary once', async () => { /* due giri → una sola email */ });
```

- [ ] **Step 2–5:** FAIL → implementa → PASS → commit `feat: grouped email alerts and scheduler`.

---

### Task 10: Login

**Files:**
- Create: `src/auth/password.ts`, `src/auth/session.ts`, `scripts/hash-password.ts`, `src/web/views/Login.tsx`; Modify: `src/web/app.ts`
- Test: `tests/auth/password.test.ts`, `tests/auth/session.test.ts`, `tests/web/auth.test.ts`

**Interfaces:**
- Produces:
  - `hashPassword(pw: string): string` → `scrypt$16384$<saltB64>$<hashB64>` (salt 16 byte, chiave 64 byte); `verifyPassword(pw, stored): boolean` con `timingSafeEqual`.
  - `signSession(secret: string, expiresAt: number): string` → `${expiresAt}.${hmacSha256Base64url}`; `verifySession(secret, token, now): boolean`.
  - `class LoginLimiter { fail(ip: string, now): void; blocked(ip: string, now): boolean; reset(ip: string): void }` — 5 errori in 15 minuti → bloccato per 15 minuti. Solo in memoria (l'IP non va mai su disco).
  - Middleware `requireAuth`: tutte le rotte tranne `/health`, `/r/*`, `/login` richiedono un cookie `cspm_session` valido; altrimenti redirect 303 a `/login`.
  - Middleware `sameOrigin`: ogni `POST` della dashboard richiede header `Origin` uguale all'origine di `BASE_URL` (altrimenti 403).
  - `GET /login`, `POST /login` (campo `password`; successo → cookie `HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` + `Secure` se `secureCookies`, redirect a `/`), `POST /logout`.
  - IP del client: primo valore di `X-Forwarded-For` se `trustProxy`, altrimenti indirizzo del socket.
  - `npm run hash-password` legge la password da stdin senza eco e stampa l'hash.

- [ ] **Step 1: test** — password giusta/sbagliata; token scaduto o manomesso rifiutato; dashboard senza cookie → 303 `/login`; `/r/:key` e `/health` accessibili senza cookie; 6° tentativo sbagliato → 429 anche con la password giusta; `POST /sites` con `Origin: https://evil.example` → 403.
- [ ] **Step 2–5:** FAIL → implementa → PASS → commit `feat: single-user login`.

---

### Task 11: Dashboard

**Files:**
- Create: `src/web/views/Layout.tsx`, `Overview.tsx`, `SiteNew.tsx`, `SiteDetail.tsx`, `SiteSettings.tsx`, `OriginDetail.tsx`, `CspViolations.tsx`, `GlobalLists.tsx`, `AlertSettings.tsx`, `src/web/queries.ts`, `src/web/static/style.css`; Modify: `src/web/app.ts`
- Test: `tests/web/pages.test.ts`, `tests/web/actions.test.ts`

**Interfaces:**
- Consumes: tutti gli store; `strictHeaders`, `suggestedHeaders`, `isRiskyWildcard`.
- Produces (rotte, tutte dietro login):
  - `GET /` — panoramica: numeri in alto (siti, origini da rivedere = righe `status='new'` di categoria alertable, siti silenziosi, report ultime 24h); tabella "Da rivedere" (ultime 20 origini nuove di tutti i siti); un riquadro per sito con stato (`da rivedere` / `oltre il tetto` se `noise_counts` di oggi ha `rate-limit` / `silenzioso` se `last_report_at` più vecchio di 3 giorni o mai visto dopo 1 giorno dalla creazione / `apprendimento · N gg` / `tutto ok`), mini-grafico 30 giorni (barre da `daily_counts`), report 30 giorni, ultimo report.
  - `GET /sites/new`, `POST /sites` (nome, domini uno per riga) → redirect alla pagina del sito.
  - `GET /sites/:id` — riepilogo: numeri, tabella "Da rivedere" con pulsanti `Approva` / `Approva per tutti` / `Sospetta`, origini approvate (con etichetta "globale" quando coperte da un'approvazione globale), sezione inline/eval con conteggi e ultimi `sample`, rumore filtrato 7 giorni per motivo, header stretto e suggerito con pulsanti copia (un `<button>` con `navigator.clipboard`, unico JavaScript della dashboard), link "Chiudi apprendimento" se in apprendimento.
  - `GET /sites/:id/csp` — pagina Violazioni CSP: tabella aggregata (direttiva, origine, pagina più colpita, stato, report, ultima vista) con filtri via query string `directive`, `status`, `noise=0|1`; grafico 30 giorni; ripartizione per browser (dai `samples` degli ultimi 30 giorni).
  - `GET /sites/:id/origins/:originId` — dettaglio: avviso se la stessa origine è comparsa su altri siti nelle ultime 24 ore, siti coinvolti, direttive, file di partenza, ultimi 20 campioni, ultimo report grezzo (JSON formattato in `<pre>`).
  - `GET /sites/:id/settings`, `POST /sites/:id/settings` (nome, domini, tetti), `POST /sites/:id/end-learning`.
  - `POST /sites/:id/origins/:originId/approve` (`scope=site|global`), `POST /sites/:id/origins/:originId/suspect`.
  - `GET /lists`, `POST /lists/approvals` (pattern, direttive, sito o globale; avviso se `isRiskyWildcard`), `POST /lists/approvals/:id/delete`, `POST /lists/noise`, `POST /lists/noise/:id/delete`.
  - `GET /settings/alerts`, `POST /settings/alerts` (email), `POST /settings/alerts/test` (manda un'email di prova).
  - Layout e stile: quelli del mockup (menu laterale che va sopra il contenuto a larghezza telefono, tabelle larghe in un riquadro scorrevole, Inter come font). Nessun framework CSS; un solo `style.css` servito da `/static/style.css`.

- [ ] **Step 1: test**

```ts
it('escapes report data on every page', async () => {
  seedOrigin({ sample: '<img src=x onerror=alert(1)>', page: '/"><script>x</script>' });
  for (const path of ['/', `/sites/${id}`, `/sites/${id}/csp`, `/sites/${id}/origins/${oid}`]) {
    const html = await (await authed(path)).text();
    expect(html).not.toContain('<img src=x'); expect(html).not.toContain('<script>x');
  }
});
it('approve marks the row approved and creates approvals for seen directives', async () => { /* POST approve → origins.status, approvals */ });
it('approve for all creates a global approval', async () => { /* … */ });
it('overview flags silent and over-limit sites', async () => { /* … */ });
it('creating a site shows the strict header with its key', async () => { /* … */ });
it('risky wildcard shows a warning', async () => { /* POST /lists/approvals con *.cloudfront.net → pagina contiene l’avviso */ });
```

- [ ] **Step 2–5:** FAIL → implementa una pagina alla volta (i test sopra devono passare tutti alla fine) → PASS → commit `feat: dashboard`.

---

### Task 12: Pulizia dei dati e backup

**Files:**
- Create: `src/jobs/maintenance.ts`; Modify: `src/jobs/scheduler.ts`
- Test: `tests/jobs/maintenance.test.ts`

**Interfaces:**
- Produces:
  - `pruneData(db, now): void` — cancella `daily_counts` e `noise_counts` più vecchi di 90 giorni; da `samples` tiene per ogni origine gli ultimi 20 più tutti quelli degli ultimi 7 giorni; cancella `pending_alerts` inviati da più di 30 giorni.
  - `backupDb(db, dir: string, now): string` — `VACUUM INTO '<dir>/csp-monitor-YYYY-MM-DD.sqlite'` (cartella creata se manca; se il file del giorno esiste, lo sostituisce), tiene i 14 più recenti, restituisce il percorso.
- [ ] **Step 1: test** — 30 campioni di 20 giorni fa + 5 di ieri su un'origine → ne restano 25 (20 più recenti ∪ ultimi 7 giorni); 16 backup → ne restano 14; il backup si apre con `openDb` e contiene i siti.
- [ ] **Step 2–5:** FAIL → implementa → PASS → commit `feat: data retention and daily backup`.

---

### Task 13: Docker, Caddy, README, prova completa

**Files:**
- Create: `Dockerfile`, `compose.yaml`, `Caddyfile`, `.dockerignore`, `README.md`
- Test: `tests/e2e.test.ts`

Specifiche:
- `Dockerfile` multi-stage su `node:24-bookworm-slim`: build con `npm ci` + `npm run build`; runtime con solo `dist/`, `src/db/schema.sql` e `node_modules` di produzione; utente non root; `VOLUME /data`; `HEALTHCHECK` su `http://localhost:3000/health`.
- `compose.yaml`: servizi `app` (env da `.env`, volume `data:/data`, nessuna porta pubblicata) e `caddy` (`caddy:2`, porte 80 e 443, volume per i certificati, `Caddyfile` montato).
- `Caddyfile`: `{$CSP_DOMAIN} { reverse_proxy app:3000 }` più `request_body { max_size 64KB }` sul percorso `/r/*`.
- `README.md` in italiano: requisiti, `.env` (con `npm run hash-password`), `docker compose up -d`, come aggiungere un sito e l'header, dove sono i backup e come portarli fuori dal server, come aggiornare.
- Test e2e (in processo, senza Docker): crea un sito con apprendimento chiuso, `POST /r/:key` con una fixture reale di Chrome, avanza il tempo di 10 minuti, esegue `runDueAlerts` con un canale finto → un messaggio con l'origine; la pagina del sito mostra l'origine in "Da rivedere"; dopo `Approva`, un nuovo report della stessa origine non genera alert.

- [ ] **Step 1:** scrivi `tests/e2e.test.ts` → **Step 2:** FAIL → **Step 3:** completa i pezzi mancanti → **Step 4:** `npm test` tutto verde; `docker build .` termina senza errori; `docker compose config` valido.
- [ ] **Step 5:** commit `feat: docker deployment and end-to-end test`.
