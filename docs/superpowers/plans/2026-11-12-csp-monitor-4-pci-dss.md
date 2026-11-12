# CSP Monitor — Piano 4: modulo PCI DSS 6.4.3 e 11.6.1

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** per i siti con pagine di pagamento, il servizio tiene l'inventario giustificato degli script, la cronologia di ogni modifica a script e header, le revisioni periodiche, e produce le esportazioni CSV e PDF da consegnare all'auditor.

**Architecture:** sopra i Piani 1–3. Il perimetro "pagine di pagamento" è un elenco di schemi di percorso per sito. Gli handler `csp-hash` e `csp-violation` (script-src) scrivono eventi in una tabella `timeline` quando il report arriva da una pagina di pagamento; un modulo di giustificazioni con regole decide lo stato di ogni script; il runner delle verifiche (Piano 3) confronta gli header delle pagine di pagamento con l'ultima versione autorizzata. Le esportazioni leggono solo dal database.

**Tech Stack:** come i piani precedenti, più `pdfkit` per il PDF (nessun browser headless).

**Spec:** `docs/superpowers/specs/2026-11-12-csp-monitor-design.md`, sezione 9 (Modulo PCI DSS) e sezione 10 (conservazione). **Prerequisiti:** Piani 1, 2 e 3 completati.

## Global Constraints

- Valgono i vincoli globali dei piani precedenti.
- Testi dell'interfaccia, delle email e delle esportazioni in italiano. Il PDF non usa mai la parola "conforme" riferita al sito: descrive cosa è stato osservato e registrato.
- Ogni evento della cronologia è immutabile (solo `INSERT`); le correzioni sono eventi nuovi.
- Autore degli eventi: `'Andrea'` per le azioni dalla dashboard (nome configurabile in `settings` con chiave `operator_name`), `'regola: <nome>'` per le auto-validazioni, `'sistema'` per i rilevamenti.
- Valori fissati dalla spec: script "sparito" dopo 7 giorni senza report mentre la stessa pagina continua a mandare report `csp-hash` (almeno 20 report di quella pagina nei 7 giorni); promemoria di revisione dopo 7 giorni; conservazione minima 13 mesi (395 giorni) per `timeline`, `script_justifications`, `reviews`, `header_snapshots` dei siti con perimetro di pagamento.
- Mascheramento negli header confrontati: `'nonce-…'` → `'nonce-*'`; nei `Set-Cookie` si confrontano solo nome e attributi, mai il valore.

## Review Focus

1. **Pagina di pagamento con molto traffico e uno script legittimo che ruota hash a ogni rilascio** (es. bundle dell'app): con una regola "hash qualsiasi" non deve mai finire `in attesa` né generare alert, ma ogni rotazione deve comparire nella cronologia. Test in Task 3.
2. **Pagina di pagamento con poco traffico** (5 visite a settimana): lo script non deve risultare "sparito" solo perché non arrivano report; serve il minimo di 20 report della pagina. Test in Task 2.
3. **Header con nonce diverso a ogni risposta**: nessun evento "header modificato". Header che cambia solo nell'ordine delle direttive o negli spazi: nessun evento. Test in Task 4.
4. **Esportazione di un periodo senza eventi o di un sito senza perimetro di pagamento**: file validi con intestazioni e una riga "nessun evento nel periodo", nessuna eccezione. Test in Task 6 e Task 7.
5. **Testo libero dell'utente (giustificazioni, note) con caratteri speciali** (`"`, `,`, a capo, `<script>`, `=cmd|`): escapato in HTML, quotato correttamente nel CSV e neutralizzato contro la formula injection (prefisso `'` per celle che iniziano con `=`, `+`, `-`, `@`). Test in Task 6.

---

## Struttura

```
src/pci/scope.ts          perimetro delle pagine di pagamento
src/pci/timeline.ts       scrittura e lettura della cronologia
src/pci/justify.ts        stati, giustificazioni, regole di auto-validazione
src/pci/headers.ts        normalizzazione e confronto degli header
src/pci/reviews.ts        revisioni e promemoria
src/pci/export/csv.ts     esportazioni CSV
src/pci/export/pdf.ts     PDF di sintesi
src/web/views/Pci*.tsx    pagine della dashboard
```

---

### Task 1: Migrazione e perimetro

**Files:**
- Create: `src/pci/scope.ts`; Modify: `src/db/migrations.ts`, `src/store/sites.ts`
- Test: `tests/pci/scope.test.ts`, `tests/db/migrations.test.ts` (estendi)

Migrazione 3:
```sql
ALTER TABLE sites ADD COLUMN payment_paths TEXT NOT NULL DEFAULT '[]';
CREATE TABLE IF NOT EXISTS script_justifications (
  id INTEGER PRIMARY KEY, origin_id INTEGER NOT NULL REFERENCES origins(id) ON DELETE CASCADE,
  status TEXT NOT NULL,                -- pending | justified | rejected
  text TEXT, author TEXT NOT NULL, rule_id INTEGER, at INTEGER NOT NULL);   -- storico: l'ultima riga è lo stato corrente
CREATE TABLE IF NOT EXISTS justification_rules (
  id INTEGER PRIMARY KEY, site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE, -- NULL = globale
  name TEXT NOT NULL, pattern TEXT NOT NULL, hash_policy TEXT NOT NULL, -- any | pinned
  pinned_hash TEXT, text TEXT NOT NULL, created_at INTEGER NOT NULL, disabled_at INTEGER);
CREATE TABLE IF NOT EXISTS timeline (
  id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL,
  subject TEXT NOT NULL, page TEXT, before TEXT, after TEXT, actor TEXT NOT NULL, note TEXT);
CREATE INDEX IF NOT EXISTS timeline_site_at ON timeline (site_id, at);
CREATE TABLE IF NOT EXISTS header_snapshots (
  id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL, page_url TEXT NOT NULL, at INTEGER NOT NULL,
  normalized TEXT NOT NULL, authorized_at INTEGER, authorized_by TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS reviews (id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL, at INTEGER NOT NULL, author TEXT NOT NULL, note TEXT);
```

**Interfaces:**
- Produces:
  - `isPaymentPath(site: Site, path: string): boolean` — schemi con `*` finale come prefisso (`/checkout/*` vale per `/checkout` e `/checkout/step-2`), altrimenti uguaglianza esatta; confronto senza `/` finale.
  - `setPaymentPaths(db, siteId, paths: string[], now)` — salva e aggiunge a `site_pages` (Piano 3) l'URL completo di ogni percorso senza jolly sul primo dominio del sito; scrive un evento `scope-changed` in cronologia con prima/dopo.
  - `hasPaymentScope(site): boolean`
  - `isSensitivePath` del Piano 2 restituisce `true` anche per le pagine di pagamento.
- [ ] **Step 1–5:** test (prefissi, esatti, `/` finale, `scope-changed`) → FAIL → implementa → PASS → commit `feat: payment page scope`.

---

### Task 2: Cronologia e rilevamenti dagli handler

**Files:**
- Create: `src/pci/timeline.ts`; Modify: `src/ingest/handlers/hash.ts`, `src/ingest/handlers/csp.ts`, `src/jobs/scheduler.ts`
- Test: `tests/pci/timeline.test.ts`

**Interfaces:**
- Produces:
  - `type TimelineKind = 'script-added' | 'script-hash-changed' | 'script-removed' | 'origin-added' | 'header-changed' | 'header-authorized' | 'justification' | 'rule-applied' | 'review' | 'scope-changed'`
  - `addEvent(db, e: { siteId; at; kind: TimelineKind; subject: string; page?: string; before?: string; after?: string; actor: string; note?: string }): number`
  - `listEvents(db, siteId, opts: { from: number; to: number; kinds?: TimelineKind[]; page?: string; limit?: number }): TimelineEvent[]`
  - Nell'handler `csp-hash`, quando la pagina del report è di pagamento: script nuovo → `script-added` (`after` = hash); hash cambiato → `script-hash-changed` (`before`/`after`). Nell'handler `csp-violation`, riga nuova in `script-src`/`connect-src`/`form-action` su pagina di pagamento → `origin-added`. Gli alert di questi casi hanno `immediate: true`.
  - `detectRemovedScripts(db, now)`: per ogni sito con perimetro, per ogni script visto su pagine di pagamento non più visto da 7 giorni, se le stesse pagine hanno avuto ≥ 20 report `csp-hash` negli ultimi 7 giorni e non esiste già un `script-removed` successivo all'ultima vista → evento `script-removed` (nessun alert, solo cronologia). Lo scheduler la chiama una volta al giorno.
- [ ] **Step 1: test** — eventi scritti solo per pagine di pagamento; prima/dopo corretti; `script-removed` con 25 report della pagina sì, con 5 no, e mai due volte per la stessa sparizione.
- [ ] **Step 2–5:** FAIL → implementa → PASS → commit `feat: payment page change timeline`.

---

### Task 3: Giustificazioni e regole di auto-validazione

**Files:**
- Create: `src/pci/justify.ts`; Modify: `src/ingest/handlers/hash.ts`, `src/alerts/kinds.ts`
- Test: `tests/pci/justify.test.ts`

**Interfaces:**
- Produces:
  - `currentStatus(db, originId): { status: 'pending' | 'justified' | 'rejected'; text: string | null; author: string; at: number; ruleId: number | null }` — `pending` se non c'è storico.
  - `justify(db, originId, text: string, author: string, now)`, `reject(db, originId, note: string, author, now)` — aggiungono una riga di storico e un evento `justification`.
  - `createRule(db, input: { siteId: number | null; name; pattern; hashPolicy: 'any' | 'pinned'; pinnedHash?: string; text }, now)`, `disableRule(db, ruleId, now)`.
  - `applyRules(db, site, originId, scriptUrl: string, hash: string, now): boolean` — prima regola attiva (prima quelle del sito, poi le globali, in ordine di creazione) con `matchesPattern(pattern, origin)` sull'origine dello script **oppure** uguaglianza dell'URL completo se il pattern contiene un percorso; con `pinned` serve anche `hash === pinnedHash`. Se corrisponde: riga `justified` con `author = 'regola: <nome>'`, `rule_id`, testo della regola, evento `rule-applied`; restituisce `true`.
  - Nell'handler `csp-hash` per le pagine di pagamento: script nuovo o hash cambiato → `applyRules`; se `false` → stato `pending` (riga di storico con `author='sistema'`) e alert `pci-pending` immediato, che sostituisce `new-script`/`hash-changed` per quelle pagine.
  - Nuovo `AlertKind`: `'pci-pending'` ("Script da giustificare sulla pagina di pagamento").
- [ ] **Step 1: test** — regola `any` su `https://js.stripe.com` giustifica uno script nuovo e ogni rotazione successiva senza alert, con evento `rule-applied` a ogni rotazione; regola `pinned` non copre un hash diverso → `pending` + alert; regola disattivata non si applica; giustificazione manuale dopo `pending` → `justified`, autore `Andrea`.
- [ ] **Step 2–5:** FAIL → implementa → PASS → commit `feat: script justifications and auto-validation rules`.

---

### Task 4: Modifiche agli header delle pagine di pagamento

**Files:**
- Create: `src/pci/headers.ts`; Modify: `src/checks/runner.ts`, `src/alerts/kinds.ts`
- Test: `tests/pci/headers.test.ts`

**Interfaces:**
- Produces:
  - `normalizeSecurityHeaders(headers: [string, string][]): string` — JSON stabile con chiavi ordinate: CSP e CSP-Report-Only (direttive ordinate per nome, sorgenti ordinate, nonce mascherati, spazi normalizzati), `Strict-Transport-Security`, `Permissions-Policy` (+ Report-Only), COOP, COEP, `Referrer-Policy`, `X-Content-Type-Options`, `X-Frame-Options`, e per ogni `Set-Cookie` solo `{ name, secure, httpOnly, sameSite }` ordinati per nome.
  - `diffNormalized(a: string, b: string): { header: string; before: string; after: string }[]`
  - Nel runner (Piano 3), per le pagine di pagamento: se non esiste uno snapshot autorizzato, il primo diventa autorizzato in automatico (`authorized_by = 'sistema'`, nota "prima verifica"); altrimenti, se il normalizzato differisce dall'ultimo autorizzato **e** dall'ultimo snapshot già registrato non autorizzato → nuovo snapshot non autorizzato, un evento `header-changed` per ogni differenza, alert `pci-headers` immediato.
  - `authorizeSnapshot(db, snapshotId, author, note, now)` — evento `header-authorized`; diventa il riferimento.
  - Nuovo `AlertKind`: `'pci-headers'` ("Header modificati sulla pagina di pagamento").
- [ ] **Step 1: test** — nonce diverso → nessuna differenza; direttive riordinate → nessuna; `*` aggiunto a `script-src` → una differenza con prima/dopo; stessa modifica in due verifiche consecutive → un solo alert; dopo l'autorizzazione la modifica non viene più segnalata.
- [ ] **Step 2–5:** FAIL → implementa → PASS → commit `feat: payment page header change detection`.

---

### Task 5: Revisioni periodiche e promemoria

**Files:**
- Create: `src/pci/reviews.ts`; Modify: `src/jobs/scheduler.ts`, `src/alerts/kinds.ts`
- Test: `tests/pci/reviews.test.ts`

**Interfaces:**
- Produces:
  - `addReview(db, siteId, author, note, now)` — riga in `reviews` + evento `review`.
  - `lastReview(db, siteId): Review | null`
  - `runReviewReminders(deps, now)` — una volta al giorno: per i siti con perimetro di pagamento senza revisione negli ultimi 7 giorni (o mai, se il perimetro esiste da almeno 7 giorni) → alert `pci-review-due`, al massimo uno ogni 7 giorni per sito (usa `reminders` del Piano 2 con `kind='pci-review'`).
  - Nuovo `AlertKind`: `'pci-review-due'` ("Revisione settimanale della pagina di pagamento da fare").
- [ ] **Step 1–5:** test (promemoria all'ottavo giorno, non al sesto, uno solo per settimana, nessuno per siti senza perimetro) → FAIL → implementa → PASS → commit `feat: weekly review reminders`.

---

### Task 6: Esportazioni CSV

**Files:**
- Create: `src/pci/export/csv.ts`; Modify: `src/web/app.ts`
- Test: `tests/pci/csv.test.ts`

**Interfaces:**
- Produces:
  - `csvCell(v: unknown): string` — RFC 4180 (virgolette raddoppiate, campo tra virgolette se contiene `,` `"` o a capo) e prefisso `'` se il testo inizia con `=`, `+`, `-`, `@`, tab o CR.
  - `exportInventory(db, siteId, now): string` — colonne: `script`, `hash_corrente`, `prima_vista`, `ultima_vista`, `pagine`, `stato`, `giustificazione`, `autore`, `data_giustificazione`, `regola`.
  - `exportTimeline(db, siteId, from, to): string` — `data`, `tipo`, `oggetto`, `pagina`, `prima`, `dopo`, `autore`, `nota`.
  - `exportHeaders(db, siteId, from, to): string` — `pagina`, `data`, `autorizzato_il`, `autorizzato_da`, `nota`, `header_normalizzati`.
  - `exportAlerts(db, siteId, from, to): string` — `creato`, `inviato`, `tipo`, `oggetto`, `stato_attuale` (es. "giustificato il … da …").
  - Date in ISO 8601 UTC; file UTF-8 con BOM (si apre bene in Excel).
  - Rotta: `GET /sites/:id/pci/export.csv?what=inventory|timeline|headers|alerts&from=YYYY-MM-DD&to=YYYY-MM-DD` con `Content-Disposition: attachment; filename="<sito>-<what>-<from>-<to>.csv"`.
- [ ] **Step 1: test** — escape e formula injection; periodo vuoto → intestazione + riga "nessun evento nel periodo"; sito senza perimetro → 404 con messaggio; date ISO.
- [ ] **Step 2–5:** FAIL → implementa → PASS → commit `feat: csv evidence exports`.

---

### Task 7: PDF di sintesi

**Files:**
- Create: `src/pci/export/pdf.ts`; Modify: `package.json` (dipendenza `pdfkit`), `src/web/app.ts`
- Test: `tests/pci/pdf.test.ts`

**Interfaces:**
- Produces:
  - `type PciReportData = { site: Site; from: number; to: number; generatedAt: number; paymentPaths: string[]; checkCount: number; reportCount: number; inventory: InventoryRow[]; events: TimelineEvent[]; reviews: Review[]; headerSnapshots: Snapshot[]; alerts: AlertRow[] }`
  - `collectPciReport(db, siteId, from, to, now): PciReportData`
  - `renderPciPdf(data: PciReportData): Promise<Buffer>` — sezioni in quest'ordine: intestazione (sito, periodo, data di generazione); perimetro (percorsi); metodo ("report inviati dai browser dei visitatori tramite la Reporting API; nessuno script aggiunto alle pagine; verifica degli header ogni giorno; numero di verifiche e di report nel periodo"); inventario (tabella con stato e giustificazione); cronologia; revisioni; storico degli header autorizzati; alert e come sono stati chiusi; nota finale "Documento generato da CSP Monitor. Descrive ciò che è stato osservato e registrato; la valutazione di conformità spetta al QSA." Font incorporato con supporto per lettere accentate (DejaVu Sans o Inter, file nel repo con licenza).
  - Rotta: `GET /sites/:id/pci/report.pdf?from=…&to=…`.
- [ ] **Step 1: test** — il PDF inizia con `%PDF-`; il testo estratto (con `pdf-parse` come dipendenza di sviluppo) contiene il nome del sito, "Perimetro", "Inventario", una giustificazione con lettere accentate scritta correttamente e la nota finale; non contiene la parola "conforme"; periodo vuoto → PDF valido con "nessun evento nel periodo".
- [ ] **Step 2–5:** FAIL → implementa → PASS → commit `feat: pdf evidence report`.

---

### Task 8: Pagine della dashboard

**Files:**
- Create: `src/web/views/PciOverview.tsx`, `src/web/views/PciInventory.tsx`, `src/web/views/PciTimeline.tsx`, `src/web/views/PciHeaders.tsx`, `src/web/views/PciRules.tsx`; Modify: `src/web/app.ts`, `src/web/views/Layout.tsx`, `src/web/views/SiteSettings.tsx`, `src/web/views/Overview.tsx`
- Test: `tests/web/pci.test.ts`

Rotte (menu del sito, gruppo "PCI DSS", visibile solo se il sito ha un perimetro):
- `GET /sites/:id/pci` — riepilogo: perimetro, script per stato (in attesa evidenziati), ultima revisione e pulsante "Revisione completata" (`POST /sites/:id/pci/review`, con nota), modifiche degli header in attesa di autorizzazione, ultimi 10 eventi, pulsanti di esportazione con scelta del periodo (default ultimi 12 mesi).
- `GET /sites/:id/pci/scripts` — inventario; per ogni script: `POST …/scripts/:originId/justify` (testo obbligatorio), `POST …/reject` (nota), storico delle giustificazioni.
- `GET /sites/:id/pci/timeline` — cronologia con filtri per tipo e pagina.
- `GET /sites/:id/pci/headers` — snapshot per pagina, differenze rispetto all'autorizzato, `POST …/headers/:snapshotId/authorize` (nota obbligatoria).
- `GET /pci/rules`, `POST /pci/rules`, `POST /pci/rules/:id/disable` — regole di auto-validazione (globali e per sito), con avviso se il pattern è un jolly rischioso (`isRiskyWildcard`).
- Impostazioni del sito: campo "Pagine di pagamento" (uno schema per riga).
- Panoramica: etichetta "PCI" sui siti con perimetro, in rosso se ci sono script in attesa o header da autorizzare, in giallo se la revisione è scaduta.
- [ ] **Step 1: test** — le pagine rispondono 200 e sono nascoste per siti senza perimetro; testo libero escapato (giustificazione con `<script>`); giustificare richiede testo non vuoto; autorizzare richiede la nota.
- [ ] **Step 2–5:** FAIL → implementa → PASS → commit `feat: pci dss pages`.

---

### Task 9: Conservazione e prova completa

**Files:**
- Modify: `src/jobs/maintenance.ts`
- Test: `tests/jobs/maintenance.test.ts` (estendi), `tests/e2e-pci.test.ts`

- Pulizia: per i siti con perimetro, `timeline`, `script_justifications`, `reviews`, `header_snapshots` più vecchi di 395 giorni; i `samples` e i `checks` collegati a eventi PCI restano finché resta l'evento. Le regole generali (90 giorni) non toccano queste tabelle.
- Prova completa: sito con perimetro `/checkout/*` e regola globale `any` su `https://js.stripe.com`. Arrivano: hash di Stripe (giustificato dalla regola, nessun alert), hash di `https://cdn-stats.xyz/c.js` (in attesa, alert immediato), poi una verifica con `*` aggiunto a `script-src` (alert `pci-headers`). Andrea giustifica lo script e autorizza gli header con una nota, poi registra una revisione. Il CSV della cronologia contiene, in ordine: `script-added` (Stripe), `rule-applied` (Stripe), `script-added` (cdn-stats), `header-changed`, `justification`, `header-authorized`, `review`; il PDF contiene lo script con la sua giustificazione.
- [ ] **Step 1–5:** test → FAIL → completa → `npm test` verde → commit `feat: pci retention and end-to-end test`.
