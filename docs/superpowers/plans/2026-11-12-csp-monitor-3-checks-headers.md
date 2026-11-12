# CSP Monitor — Piano 3: verifica della configurazione e header di sicurezza

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ogni giorno il servizio scarica gli header delle pagine scelte di ogni sito, verifica che i report arrivino davvero al servizio, dà un punteggio agli header di sicurezza e alla CSP, conserva lo storico e avvisa quando qualcosa si rompe o peggiora.

**Architecture:** un modulo `checks` scarica gli header (fetch con redirect manuali, nessun JavaScript), tre analizzatori puri trasformano gli header in risultati (configurazione dei report, header di sicurezza, CSP), un runner salva l'esito e lo confronta con il precedente per decidere gli alert. Tutto è funzione pura tranne il fetch e il salvataggio, così si testa con header finti.

**Tech Stack:** come i Piani 1 e 2; `fetch` nativo di Node 24 (undici).

**Spec:** `docs/superpowers/specs/2026-11-12-csp-monitor-design.md`, sezioni 7 e 8. Mockup: pagine "Verifica configurazione" e "Header di sicurezza" (https://claude.ai/artifact/6Fh6uA4XHSymiLm7rvLdhp). **Prerequisiti:** Piani 1 e 2 completati.

## Global Constraints

- Valgono i vincoli globali dei Piani 1 e 2.
- Fetch: solo `http:`/`https:`, metodo `GET`, timeout 10 s, al massimo 5 redirect, user agent `CSP-Monitor/1.0 (+<BASE_URL>)`, corpo della risposta non letto oltre i primi 64 KB (serve solo per confrontare i nonce), nessun cookie inviato.
- Gli header grezzi di ogni verifica si salvano per 90 giorni; i punteggi giornalieri per sempre.
- Gravità: `critical`, `high`, `medium`, `low`. "Grave" = `critical` o `high`.
- Punteggio deterministico e documentato nel codice (vedi Task 5): sicurezza = 100 − somma dei pesi dei problemi di sicurezza (critical 30, high 15, medium 8, low 3), minimo 0; qualità = 100 − somma dei pesi dei problemi di qualità (stessi pesi), minimo 0; complessivo = `round(0.75 × sicurezza + 0.25 × qualità)`. Se manca la CSP bloccante, il punteggio di sicurezza della CSP è 0.
- Alert: solo per verifiche automatiche, solo per problemi gravi nuovi rispetto alla verifica precedente della stessa pagina, per calo del punteggio di sicurezza (header o CSP), o dopo 3 verifiche fallite di fila. Le verifiche manuali aggiornano la dashboard ma non mandano email.
- La lista degli host con bypass noti viene dal CSP Evaluator di Google (Apache-2.0): copiala in `src/checks/data/bypasses.ts` con l'intestazione di licenza e la versione/commit di origine.

## Review Focus

1. **Header ripetuti o su più righe** (due `Content-Security-Policy`, `Set-Cookie` multipli, `Reporting-Endpoints` con spazi e virgole dentro le virgolette): si analizzano tutti, senza perderne nessuno. Test in Task 2.
2. **Sito che risponde 403/503 al nostro user agent o va in timeout**: verifica "non riuscita", nessun falso alert di "header spariti". Test in Task 6.
3. **Redirect da `http://` a `https://` e da apex a `www`**: si analizzano gli header della risposta finale, ma una pagina finale in `http://` è un problema grave. Test in Task 2 e Task 3.
4. **Nonce che cambia a ogni richiesta (corretto) vs nonce fisso (problema)**: servono due fetch della stessa pagina; con un solo fetch riuscito il controllo si salta, non fallisce. Test in Task 5.
5. **Primo giorno di verifiche di un sito**: nessun alert di "peggioramento" senza una verifica precedente con cui confrontarsi. Test in Task 6.

---

## Struttura

```
src/checks/fetch.ts           scarico header con redirect manuali
src/checks/headers.ts         parser degli header strutturati
src/checks/reporting.ts       analisi della configurazione dei report
src/checks/securityHeaders.ts analisi degli header di sicurezza e dei cookie
src/checks/csp.ts             analisi della CSP
src/checks/data/bypasses.ts   host con bypass noti (da CSP Evaluator)
src/checks/score.ts           punteggi
src/checks/runner.ts          esecuzione, storico, confronto, alert
src/web/views/Checks.tsx      pagina Verifica configurazione
src/web/views/SecurityHeaders.tsx  pagina Header di sicurezza
```

---

### Task 1: Migrazione e pagine da verificare

**Files:**
- Modify: `src/db/migrations.ts`, `src/store/sites.ts`
- Test: `tests/db/migrations.test.ts` (estendi), `tests/store/sites.test.ts` (estendi)

Migrazione 2:
```sql
CREATE TABLE IF NOT EXISTS site_pages (id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE, url TEXT NOT NULL, UNIQUE (site_id, url));
CREATE TABLE IF NOT EXISTS checks (
  id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL, page_url TEXT NOT NULL, at INTEGER NOT NULL,
  manual INTEGER NOT NULL DEFAULT 0, ok INTEGER NOT NULL, error TEXT,
  final_url TEXT, status INTEGER, headers TEXT, result TEXT  -- headers: JSON [[name,value],…]; result: JSON CheckResult
);
CREATE INDEX IF NOT EXISTS checks_site_page ON checks (site_id, page_url, at);
CREATE TABLE IF NOT EXISTS scores (site_id INTEGER NOT NULL, day TEXT NOT NULL, headers_score INTEGER, csp_score INTEGER, PRIMARY KEY (site_id, day));
ALTER TABLE sites ADD COLUMN session_cookies TEXT NOT NULL DEFAULT '["session","sessionid","PHPSESSID","connect.sid","wordpress_logged_in_*","SSESS*"]';
```
Alla creazione di un sito si aggiunge la pagina `https://<primo dominio senza jolly>/`.

**Interfaces:** `listPages(db, siteId)`, `addPage(db, siteId, url)`, `removePage(db, pageId)`, `setSessionCookies(db, siteId, names: string[])` (`*` finale = prefisso).
- [ ] **Step 1–5:** test → FAIL → implementa → PASS → commit `feat: pages to check per site`.

---

### Task 2: Fetch e parser degli header

**Files:**
- Create: `src/checks/fetch.ts`, `src/checks/headers.ts`
- Test: `tests/checks/fetch.test.ts` (con un server HTTP locale `node:http` sulla porta 0), `tests/checks/headers.test.ts`

**Interfaces:**
- Produces:
  - `type FetchResult = { ok: true; finalUrl: string; status: number; headers: [string, string][]; redirects: string[]; bodyStart: string } | { ok: false; error: 'timeout' | 'network' | 'too-many-redirects' | 'blocked-status'; status?: number; detail: string }` — `blocked-status` per 401/403/429/5xx.
  - `fetchHeaders(url: string, opts: { userAgent: string; timeoutMs?: number; maxRedirects?: number }): Promise<FetchResult>` — `redirect: 'manual'`, segue `Location` a mano; `headers` conserva ogni occorrenza (usa `Headers.getSetCookie()` per `Set-Cookie`).
  - `getAll(headers, name): string[]` (case-insensitive).
  - `parseReportingEndpoints(values: string[]): { name: string; url: string }[]` — dizionario structured field (RFC 8941): `name="url"`, separati da virgole, virgole dentro le virgolette ammesse.
  - `parseReportTo(values: string[]): { group: string; urls: string[]; maxAge: number }[]` — uno o più oggetti JSON separati da virgola; JSON non valido → ignorato (e segnalato dall'analisi).
  - `parseCsp(value: string): { name: string; values: string[] }[]` — direttive separate da `;`, nomi minuscoli, ripetizioni conservate (servono per "direttiva duplicata"); più header o valori separati da virgola = più policy.
  - `parseNel(values)`, `parseStructuredParams(value): Record<string, string>` (per `report-to=…` in COOP, COEP, Permissions-Policy, Document-Policy, Integrity-Policy), `parseSetCookie(value): { name: string; secure: boolean; httpOnly: boolean; sameSite?: string }`.
- [ ] **Step 1: test** — redirect `http`→`https`→`www` seguiti, `redirects` registrati; 6 redirect → `too-many-redirects`; server lento → `timeout` in ~10 s (usa `timeoutMs: 200` nel test); 403 → `blocked-status`; due `Set-Cookie` e due CSP conservati; `Reporting-Endpoints: a="https://x/1", b="https://y/2,3"` → due voci con la virgola dentro l'URL.
- [ ] **Step 2–5:** FAIL → implementa → PASS → commit `feat: header fetch and parsers`.

---

### Task 3: Analisi della configurazione dei report

**Files:**
- Create: `src/checks/reporting.ts`
- Test: `tests/checks/reporting.test.ts`

**Interfaces:**
- Produces:
  - `type Finding = { code: string; severity: 'critical' | 'high' | 'medium' | 'low'; area: 'security' | 'quality'; title: string; text: string; fix: string }` (testi in italiano)
  - `type EndpointInfo = { name: string; url: string; header: 'Reporting-Endpoints' | 'Report-To'; ours: boolean; usedBy: string[] }`
  - `type FeatureInfo = { feature: string; present: 'present' | 'absent' | 'implicit'; mode: 'enforce' | 'report-only' | null; endpoint: string | null; result: 'ours' | 'elsewhere' | 'lost' | 'inactive' }`
  - `analyzeReporting(h: FetchResult & { ok: true }, baseUrl: string): { endpoints: EndpointInfo[]; features: FeatureInfo[]; findings: Finding[] }` — `ours` = URL che inizia con `${baseUrl}/r/`.
  - Funzioni considerate: CSP bloccante, CSP Report-Only (via `report-to` e/o `report-uri`), Permissions-Policy (e Report-Only), COOP, COEP (e Report-Only), Document-Policy, Integrity-Policy, NEL, e "crash, deprecazioni, interventi" (implicita, usa `default`).
  - Codici dei problemi (gravità): `report-to-undeclared` (high: report persi), `endpoint-http` (high), `page-not-https` (critical), `no-reporting` (high: nessun header di report), `reports-elsewhere` (high: una funzione manda a un URL non nostro), `nel-without-report-to` (high), `report-to-invalid-json` (medium), `endpoint-unused` (low, quality), `report-uri-only` (low, quality: c'è `report-uri` ma non `report-to`).
- [ ] **Step 1: test** — un caso per codice, più il caso del mockup (COOP verso `coop` non dichiarato → `lost` + `report-to-undeclared`); una configurazione completa e corretta → nessun problema e tutte le funzioni presenti `ours`.
- [ ] **Step 2–5:** FAIL → implementa → PASS → commit `feat: reporting configuration analysis`.

---

### Task 4: Analisi degli header di sicurezza e dei cookie

**Files:**
- Create: `src/checks/securityHeaders.ts`
- Test: `tests/checks/securityHeaders.test.ts`

**Interfaces:**
- Produces:
  - `type HeaderRow = { name: string; value: string; category: 'mandatory' | 'recommended' | 'legacy' | 'deprecated' | 'reporting'; result: string; tone: 'ok' | 'warning' | 'danger' | 'neutral' }`
  - `analyzeSecurityHeaders(h, sessionCookies: string[]): { rows: HeaderRow[]; cookies: { name: string; secure: boolean; httpOnly: boolean; sameSite: string | null; isSession: boolean }[]; findings: Finding[] }`
  - Regole (gravità): CSP bloccante assente `high`; HSTS assente su HTTPS `high`, `max-age` < 31 536 000 `medium`, senza `includeSubDomains` `low` (quality); `X-Content-Type-Options` diverso da `nosniff` `medium`; `Content-Type` HTML senza `charset` `low`; cookie di sessione senza `Secure` `high`, senza `HttpOnly` `high`, senza `SameSite` `medium`; cookie non di sessione senza `Secure` `low`; `Referrer-Policy` assente o `unsafe-url`/`no-referrer-when-downgrade` `low`; `Permissions-Policy` assente `medium`; COOP assente `low`; `X-Frame-Options` senza `frame-ancestors` nella CSP: nessun problema ma riga `legacy`; `X-Frame-Options` insieme a `frame-ancestors`: `low` quality; `X-XSS-Protection`, `Expect-CT`, `Public-Key-Pins`, `Feature-Policy` presenti `low` quality "da togliere".
- [ ] **Step 1–5:** test (un caso per regola, più l'esempio del mockup che deve produrre esattamente i 4 problemi mostrati) → FAIL → implementa → PASS → commit `feat: security headers analysis`.

---

### Task 5: Analisi della CSP e punteggi

**Files:**
- Create: `src/checks/csp.ts`, `src/checks/data/bypasses.ts`, `src/checks/score.ts`
- Test: `tests/checks/csp.test.ts`, `tests/checks/score.test.ts`

**Interfaces:**
- Produces:
  - `type CspToken = { value: string; severity: 'critical' | 'high' | 'medium' | 'low' | null; deprecated: boolean }`
  - `analyzeCsp(policy: { name: string; values: string[] }[], opts: { mode: 'enforce' | 'report-only'; secondFetchNonce?: string | null; firstFetchNonce?: string | null }): { directives: { name: string; tokens: CspToken[] }[]; findings: Finding[] }`
  - Controlli (gravità): in `script-src` (o `default-src` se manca) `'unsafe-inline'` senza nonce/hash `critical`, `'unsafe-eval'` `high`, `'unsafe-hashes'` `medium`, `*` `critical`, `https:`/`http:` `high`, `data:` `high`; host in `BYPASS_HOSTS` `medium` (con nome dell'host nel testo); `object-src` non `'none'` e non coperto da `default-src 'none'` `medium`; `base-uri` assente `medium`; `frame-ancestors` assente `medium`; nonce uguale in due fetch `high`; nonce/hash senza apici o in direttive che li ignorano `medium`; `'strict-dynamic'` senza nonce/hash `medium`; direttive deprecate (`block-all-mixed-content`, `plugin-types`, `referrer`, `prefetch-src`, `report-uri` se c'è `report-to`) `low` quality; direttive duplicate `low` quality; direttive sconosciute `low` quality. Ogni problema ha `fix` testuale.
  - `scoreFindings(findings: Finding[]): { security: number; quality: number; overall: number }` — formula dei vincoli globali.
  - `cspScore(enforce: ..., reportOnly: ...)`: punteggio della policy bloccante se presente; altrimenti sicurezza 0 e si mostra a parte il punteggio della Report-Only.
  - `headersScore(all findings of Task 3 security + Task 4 + CSP enforced)`.
- [ ] **Step 1: test** — la policy dell'esempio del mockup produce i 5 problemi e il punteggio atteso (calcolalo con la formula e scrivilo nel test); `'nonce-abc' 'strict-dynamic'` senza `'unsafe-inline'` → nessun `critical`; nonce uguale tra due fetch → problema; un solo fetch → nessun problema sul nonce.
- [ ] **Step 2–5:** FAIL → implementa → PASS → commit `feat: csp analysis and scoring`.

---

### Task 6: Runner, storico, confronto e alert

**Files:**
- Create: `src/checks/runner.ts`; Modify: `src/jobs/scheduler.ts`, `src/alerts/kinds.ts`, `src/jobs/maintenance.ts`
- Test: `tests/checks/runner.test.ts`

**Interfaces:**
- Produces:
  - `type CheckResult = { reporting: ReturnType<typeof analyzeReporting>; security: ReturnType<typeof analyzeSecurityHeaders>; csp: { enforce: ... | null; reportOnly: ... | null }; scores: { headers: {security, quality, overall}; csp: {security, quality, overall} } }`
  - `runCheck(deps, siteId: number, pageUrl: string, opts: { manual: boolean; fetcher?: typeof fetchHeaders }, now): Promise<void>` — fa due fetch della pagina (il secondo solo per i nonce, a 1 s di distanza), analizza, salva in `checks`, aggiorna `scores` del giorno (minimo tra le pagine del sito).
  - `diffChecks(prev: CheckResult | null, curr: CheckResult): AlertRequest[]` — `config-broken` per ogni problema `critical`/`high` di `reporting` o `security` il cui `code` non c'era in `prev`; `score-drop` se `scores.headers.security` o `scores.csp.security` è più basso di `prev`; `[]` se `prev` è `null`.
  - Verifiche fallite: dopo 3 `ok = 0` consecutive sulla stessa pagina (solo automatiche) → `check-failed`, una volta finché la pagina non torna a rispondere.
  - Nuovi `AlertKind`: `'config-broken'`, `'score-drop'`, `'check-failed'` con testi italiani.
  - Scheduler: ogni giorno alle 06:00 UTC verifica tutte le pagine di tutti i siti, una alla volta con 2 s di pausa. Pulizia: `checks` più vecchi di 90 giorni.
- [ ] **Step 1: test** — prima verifica: nessun alert; seconda con COOP che perde l'endpoint → un `config-broken`; HSTS tolto → `score-drop`; verifica manuale con lo stesso peggioramento → nessun alert; 3 timeout → un `check-failed`, il 4° no, dopo un successo e altri 3 timeout di nuovo sì; due pagine con punteggi 70 e 50 → `scores` del giorno 50.
- [ ] **Step 2–5:** FAIL → implementa → PASS → commit `feat: daily checks with history and alerts`.

---

### Task 7: Pagine della dashboard

**Files:**
- Create: `src/web/views/Checks.tsx`, `src/web/views/SecurityHeaders.tsx`; Modify: `src/web/app.ts`, `src/web/views/Overview.tsx`, `src/web/views/SiteDetail.tsx`, `src/web/views/SiteSettings.tsx`, `src/web/typePages.ts`
- Test: `tests/web/checks.test.ts`

Rotte:
- `GET /sites/:id/checks` — come il mockup "Verifica configurazione": selettore della pagina, pulsante "Verifica ora" (`POST /sites/:id/checks/run`, al massimo una volta al minuto per sito, poi redirect), avviso se la configurazione è cambiata dalla verifica precedente, quattro numeri, problemi con correzione, tabella endpoint, tabella funzioni, riquadro collegato agli header di sicurezza, "Quando ti avvisa".
- `GET /sites/:id/security-headers?view=all|csp` — come il mockup "Header di sicurezza": punteggio, sicurezza, qualità, andamento 30 giorni (da `scores`), prossime azioni, header ricevuti, cookie; vista CSP con la policy colorata per gravità e i problemi.
- Impostazioni sito: elenco pagine da verificare (aggiungi/togli) e nomi dei cookie di sessione.
- Panoramica: punteggio header per sito con freccia se sceso rispetto a ieri.
- Pagine per tipo (Piano 2): lo stato "header attivo/non attivo" viene dall'ultima verifica (`features`), non più solo dalle impostazioni.
- Menu del sito: "Verifica configurazione" e "Header di sicurezza" sotto "Riepilogo".
- [ ] **Step 1: test** — le pagine rispondono 200 con dati di una verifica finta; valori degli header escapati (un header con `<script>` nel valore); "Verifica ora" due volte nello stesso minuto → la seconda non lancia un'altra verifica.
- [ ] **Step 2–5:** FAIL → implementa → PASS → commit `feat: checks and security headers pages`.

---

### Task 8: Prova completa

**Files:**
- Test: `tests/e2e-checks.test.ts`

- Un server `node:http` locale fa da sito: giorno 1 manda header completi verso il servizio; giorno 2 toglie `HttpOnly` dal cookie di sessione su `/login` e cambia il nome dell'endpoint COOP. Con lo scheduler simulato: giorno 1 nessun alert; giorno 2 un'email con "configurazione rotta" (COOP) e "punteggio sceso" (cookie); le due pagine della dashboard mostrano il calo.
- [ ] **Step 1–5:** test → FAIL → completa → `npm test` verde → commit `test: end-to-end for checks`.
