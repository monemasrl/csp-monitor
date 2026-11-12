# CSP Monitor — Piano 2: gli altri 11 tipi di report

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** il servizio del Piano 1 accetta, aggrega, mostra e (dove previsto) segnala tutti i 12 tipi di report della Reporting API, ciascuno con la propria chiave di aggregazione e la propria regola di alert.

**Architecture:** la pipeline di ingestione del Piano 1 diventa un dispatcher verso un registro di *handler* per tipo. Ogni handler trasforma un `RawReport` in un evento tipizzato, dichiara la chiave di aggregazione (riusando la tabella `origins` come inventario generico) e decide se generare un alert. Alcune regole basate su tassi usano una nuova tabella di contatori a finestre di 15 minuti. La dashboard ha una pagina generica per tipo, configurata da un descrittore.

**Tech Stack:** come il Piano 1.

**Spec:** `docs/superpowers/specs/2026-11-12-csp-monitor-design.md`, sezione "Tipi di report" (tabella) e sezioni 2, 4, 5. Mockup: pagine dei 12 tipi e riepilogo sito (https://claude.ai/artifact/6Fh6uA4XHSymiLm7rvLdhp). **Prerequisito:** Piano 1 completato e verde.

## Global Constraints

- Valgono tutti i vincoli globali del Piano 1 (risposta 204, niente IP, niente query string, dati dei report sempre escapati, `now` passato come parametro).
- I formati di `csp-hash`, `connection-allowlist`, `document-policy-violation` e `integrity-violation` sono recenti o sperimentali: ogni handler deve tollerare campi mancanti o con nomi diversi (accetta sia `blockedURL` sia `url`, sia `snake_case` sia `camelCase`), non lanciare mai e conservare il corpo grezzo nel campione. Un report da cui non si ricava la chiave viene contato come `invalid`.
- Valori fissati dalla spec: soglia NEL 0,5% su 15 minuti; crash "raddoppiati" rispetto alla stessa finestra di 7 giorni della settimana prima, con almeno 5 crash nella finestra corrente; promemoria deprecazione 30 giorni prima; finestra di rilascio per gli hash 1 ora.
- Le funzioni "sensibili" di Permissions Policy che fanno scattare l'alert sono esattamente: `camera`, `microphone`, `geolocation`, `payment`, `display-capture`, `usb`, `serial`, `hid`, `bluetooth`.

## Review Focus

1. **Report di un tipo noto ma con forma inattesa** (body vuoto, campi `snake_case`, `blockedURL` assente ma `url` presente): nessuna eccezione, conteggio `invalid` solo se la chiave non si ricava. Test in ogni task di handler.
2. **`csp-hash` di uno script che cambia a ogni richiesta** (tag manager): dopo averlo segnato "varia spesso" non deve più generare alert, neppure per hash nuovi. Test in Task 4.
3. **NEL con pochi campioni** (2 errori su 3 richieste a notte fonda): la soglia dello 0,5% non deve scattare sotto un minimo di 200 richieste campionate nella finestra. Test in Task 6.
4. **Pagina "sensibile" per `connection-allowlist`**: l'alert parte al giro successivo dello scheduler, senza i 10 minuti di attesa, ma resta comunque un solo messaggio per giro. Test in Task 2.
5. **Deprecazione con data di rimozione già passata o non valida**: nessun promemoria futuro, nessuna eccezione. Test in Task 5.

---

## Modifiche alla struttura

```
src/db/migrations.ts              migrazioni con PRAGMA user_version
src/ingest/handlers/types.ts      interfaccia ReportHandler e registro
src/ingest/handlers/csp.ts        handler csp-violation (spostato dal Piano 1)
src/ingest/handlers/simple.ts     integrity, connection, permissions, document, coop, coep, intervention
src/ingest/handlers/hash.ts       csp-hash
src/ingest/handlers/deprecation.ts
src/ingest/handlers/rates.ts      network-error, crash
src/store/windows.ts              contatori a finestre di 15 minuti
src/alerts/kinds.ts               tipi di alert e testo
src/web/typePages.ts              descrittori delle pagine per tipo
src/web/views/TypePage.tsx        pagina generica per tipo
```

---

### Task 1: Migrazioni e registro degli handler

**Files:**
- Create: `src/db/migrations.ts`, `src/ingest/handlers/types.ts`, `src/ingest/handlers/csp.ts`; Modify: `src/db/db.ts`, `src/ingest/handler.ts`, `src/store/origins.ts`
- Test: `tests/db/migrations.test.ts`, `tests/ingest/dispatch.test.ts`

**Interfaces:**
- Produces:
  - `migrate(db: Db): void` — legge `PRAGMA user_version`; applica in ordine le migrazioni mancanti, ciascuna in transazione. Migrazione 1 (questo piano):
    ```sql
    ALTER TABLE origins ADD COLUMN detail TEXT;            -- JSON specifico del tipo
    ALTER TABLE sites ADD COLUMN sensitive_paths TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE sites ADD COLUMN enabled_headers TEXT NOT NULL DEFAULT '["csp"]';
    ALTER TABLE pending_alerts ADD COLUMN payload TEXT;   -- JSON per alert che non riguardano una riga di origins
    ALTER TABLE pending_alerts ADD COLUMN immediate INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE IF NOT EXISTS window_counts (
      site_id INTEGER NOT NULL, report_type TEXT NOT NULL, k TEXT NOT NULL, bucket INTEGER NOT NULL, -- bucket = floor(ms / 900000)
      count INTEGER NOT NULL, PRIMARY KEY (site_id, report_type, k, bucket));
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL,
      due_at INTEGER NOT NULL, sent_at INTEGER, UNIQUE (site_id, kind, ref));
    ```
    `openDb` chiama `migrate` dopo lo schema base.
  - `type HandlerContext = { db: Db; site: Site; now: number }`
  - `interface ReportHandler<E> { type: string; toEvent(raw: RawReport, site: Site): E | null; noise(e: E, site: Site, extra: string[]): NoiseReason | null; record(ctx: HandlerContext, e: E, raw: RawReport): RecordResult; decide(ctx: HandlerContext, e: E, r: RecordResult): AlertRequest | null }`
  - `type AlertRequest = { kind: AlertKind; originId?: number; payload?: Record<string, unknown>; immediate?: boolean }`
  - `HANDLERS: Map<string, ReportHandler<any>>`
  - `recordGeneric(db, site, reportType: string, keyA: string, keyB: string, category: string, page: string, sample: SampleInput, now, detail?: object): RecordResult` — stessa logica di upsert/contatori/campioni di `recordCspEvent`, con `directive = keyA`, `origin = keyB`. `recordCspEvent` diventa un uso di `recordGeneric`.
- Pipeline (`ingest`): per ogni `RawReport`, `HANDLERS.get(type)`; tipo sconosciuto → `recordNoise('invalid')`. Il controllo rate limit + `KnownCache` resta come nel Piano 1, con chiave `(site, type, keyA, keyB)`. Il filtro `foreign-document` e `bot` vale per tutti i tipi (ogni handler restituisce `documentHost` e `isBot` nell'evento); `extension` e `known-noise` solo dove c'è un URL bloccato o un file di partenza.

- [ ] **Step 1: test** — la migrazione porta `user_version` a 1 ed è idempotente; un db creato dal Piano 1 con dati viene migrato senza perdite; tutti i test del Piano 1 restano verdi (`npm test`); un report `type: 'unknown-x'` incrementa `noise_counts` `invalid`.
- [ ] **Step 2–5:** FAIL → implementa (sposta il codice CSP nell'handler senza cambiarne il comportamento) → PASS → commit `refactor: report handler registry and migrations`.

---

### Task 2: Handler semplici "prima comparsa"

**Files:**
- Create: `src/ingest/handlers/simple.ts`, `tests/fixtures/reports-*.json` (uno per tipo)
- Test: `tests/ingest/handlers/simple.test.ts`

Ogni handler qui usa `recordGeneric` e "prima riga nuova non approvata = alert" salvo dove indicato. Le approvazioni del Piano 1 (`approvals`, con `directive = keyA`) valgono anche qui.

| Tipo | `keyA` | `keyB` | Alert |
|---|---|---|---|
| `integrity-violation` | `destination` (default `script`) | URL risorsa senza query (`blockedURL` o `url`) | sempre alla riga nuova, anche se approvata altrove (non è mai rumore); niente in apprendimento |
| `connection-allowlist` | tipo (`fetch`, `beacon`, `websocket`, `eventsource`, … da `type`/`destination`, default `connection`) | origine di destinazione | riga nuova non approvata; `immediate: true` se `pathOf(documentURL)` corrisponde a un prefisso in `site.sensitive_paths` |
| `permissions-policy-violation` | `featureId` | origine di `sourceFile` (`'inline'` se assente) | riga nuova non approvata **e** `featureId` nell'elenco sensibile dei vincoli globali |
| `document-policy-violation` | `featureId` | `pathOf(documentURL)` | mai |
| `intervention` | `id` | `stripUrl(sourceFile)` o `'—'` | mai |
| `coop` | `body.type` | origine dell'altra finestra (`otherDocumentURL`, `openerURL`, `openeeURL`, `previousResponseURL`, `nextResponseURL`: il primo presente) | riga nuova solo se `disposition === 'enforce'` |
| `coep` | `destination` | URL risorsa senza query (`blockedURL`) | riga nuova solo se `disposition === 'enforce'` |

`AlertKind` aggiunti: `'integrity'`, `'new-connection'`, `'permission'`, `'coop-blocked'`, `'coep-blocked'`.

- [ ] **Step 1: test** — per ogni tipo: fixture realistica → chiavi giuste; seconda occorrenza non genera alert; caso che non deve allertare (es. `coop` in `reporting`, `permissions` con `fullscreen`); body con campi `snake_case` produce lo stesso evento; `connection-allowlist` su `/checkout` con `sensitive_paths: ["/checkout"]` → `immediate: true`.
- [ ] **Step 2–5:** FAIL → implementa → PASS → commit `feat: handlers for integrity, connection, permissions, document policy, intervention, coop, coep`.

---

### Task 3: Alert generalizzati e invio immediato

**Files:**
- Create: `src/alerts/kinds.ts`; Modify: `src/alerts/queue.ts`, `src/alerts/render.ts`, `src/jobs/scheduler.ts`, `src/ingest/handler.ts`
- Test: `tests/alerts/kinds.test.ts`, `tests/alerts/queue.test.ts` (estendi)

**Interfaces:**
- Produces:
  - `type AlertKind = 'new-origin' | 'integrity' | 'new-connection' | 'permission' | 'coop-blocked' | 'coep-blocked' | 'hash-changed' | 'new-script' | 'nel-rate' | 'tls-error' | 'crash-spike' | 'deprecation' | 'deprecation-reminder'`
  - `ALERT_KINDS: Record<AlertKind, { label: string; describe(item: AlertItemAny): string }>` — testi italiani, es. `new-origin` → "Nuova origine", `hash-changed` → "Script modificato".
  - `enqueue(db, siteId, req: AlertRequest, now)` sostituisce `enqueueAlert` (che resta come alias per `new-origin`).
  - `dueBatches(db, now, groupMs)`: un sito è pronto se il pendente più vecchio ha ≥ `groupMs` **oppure** se ha almeno un pendente `immediate = 1`; il batch contiene tutti i pendenti del sito.
  - `renderAlertBatch` raggruppa le voci per `kind` con un titolo per gruppo; oggetto `[CSP Monitor] <sito>: N segnalazioni` quando i tipi sono più di uno.
- [ ] **Step 1: test** — immediato pronto subito e insieme agli altri pendenti dello stesso sito; oggetto e gruppi corretti con tipi misti; dati escapati nell'HTML (riusa il test del Piano 1 con un `kind` nuovo).
- [ ] **Step 2–5:** FAIL → implementa → PASS → commit `feat: alert kinds and immediate alerts`.

---

### Task 4: `csp-hash`, inventario degli script

**Files:**
- Create: `src/ingest/handlers/hash.ts`; Modify: `src/store/origins.ts`
- Test: `tests/ingest/handlers/hash.test.ts`

Il report contiene in `body`: `documentURL`, `subresourceURL` (assente per gli inline), `hash` (`sha256-…`), `destination`. Verifica i nomi dei campi su un report reale di Chrome prima di scrivere la fixture e annota nel test la versione di Chrome.

**Interfaces:**
- Produces:
  - chiave: `keyA = 'script'`, `keyB` = `stripUrl(subresourceURL)` oppure `'inline:' + pathOf(documentURL)`; `detail` JSON: `{ currentHash: string; previousHash?: string; changedAt?: number; volatile?: boolean; pages: string[] (max 20) }`.
  - `markVolatile(db, originId, value: boolean): void` — "varia spesso".
  - `startRelease(db, siteId, now): void` — salva in `settings` `release_until:<siteId>` = `now + 3_600_000`.
  - Regole di `decide`: riga nuova (e sito non in apprendimento) → `new-script`; hash diverso da `currentHash` → aggiorna `previousHash`/`currentHash`/`changedAt` e alert `hash-changed`, **salvo** `volatile` o rilascio in corso. Lo stato `approved` della riga vale per "script noto": un cambio di hash lo riporta a `new`.
- [ ] **Step 1: test** — nuovo script → `new-script`; stesso hash → niente; hash cambiato → `hash-changed` e stato `new`; con `volatile` → niente; durante il rilascio → niente, e l'hash nuovo diventa quello di riferimento; inline distinti per pagina.
- [ ] **Step 2–5:** FAIL → implementa → PASS → commit `feat: script hash inventory`.

---

### Task 5: Deprecazioni e promemoria

**Files:**
- Create: `src/ingest/handlers/deprecation.ts`; Modify: `src/jobs/scheduler.ts`
- Test: `tests/ingest/handlers/deprecation.test.ts`

**Interfaces:**
- Produces:
  - chiave: `keyA = 'api'`, `keyB = body.id`; `detail`: `{ message, anticipatedRemoval?: number, sourceFile, line }`.
  - `decide`: riga nuova con `anticipatedRemoval` valida e futura → alert `deprecation` e `INSERT OR IGNORE` in `reminders` con `kind='deprecation'`, `ref = id`, `due_at = anticipatedRemoval − 30 giorni` (se `due_at` è già passato, nessun promemoria).
  - `runReminders(deps, now)`: promemoria scaduti e non inviati → `enqueue` di `deprecation-reminder` con `immediate: true`, poi `sent_at`. Chiamato dallo scheduler ogni minuto.
- [ ] **Step 1: test** — data valida → alert + promemoria; senza data → niente alert; data non valida o passata → niente promemoria, nessuna eccezione; promemoria inviato una sola volta.
- [ ] **Step 2–5:** FAIL → implementa → PASS → commit `feat: deprecation alerts and reminders`.

---

### Task 6: Regole a soglia: errori di rete e crash

**Files:**
- Create: `src/ingest/handlers/rates.ts`, `src/store/windows.ts`
- Test: `tests/ingest/handlers/rates.test.ts`, `tests/store/windows.test.ts`

**Interfaces:**
- Produces:
  - `bumpWindow(db, siteId, type, k, now, by = 1)`, `sumWindow(db, siteId, type, k, fromMs, toMs): number`.
  - `network-error`: il report ha `url` (richiesta) e `body` con `type`, `phase`, `sampling_fraction`, `server_ip`, `status_code`. Chiave `keyA = body.type`, `keyB` = host di `url`. Ogni report (anche `type: 'ok'`) incrementa `window_counts` `k='total'` di `1 / sampling_fraction` arrotondato; gli errori anche `k='errors'`. I report `ok` non creano righe in `origins` e non si salvano come campioni. `decide`:
    - `type` che inizia con `tls.cert` e riga nuova → `tls-error` (anche senza soglia);
    - altrimenti, dopo ogni errore: nelle ultime 15 minuti `total ≥ 200` e `errors / total > 0.005` → `nel-rate`, al massimo uno ogni 6 ore per sito (usa `reminders` con `kind='nel-rate'` e `ref` = giorno+fascia, oppure `last_alert_at` sulla riga).
  - `crash`: chiave `keyA = body.reason || 'unknown'`, `keyB = pathOf(url)`. `decide`: crash della pagina negli ultimi 7 giorni ≥ 5 **e** ≥ 2 × quelli dei 7 giorni precedenti (da `daily_counts`) → `crash-spike`, al massimo uno a settimana per pagina.
  - L'header NEL suggerito (Task 8) usa `success_fraction: 0.01` così i report `ok` danno il denominatore.
- [ ] **Step 1: test** — 300 richieste stimate e 1 errore → niente; 300 e 3 errori → `nel-rate`; 3 richieste e 2 errori → niente (minimo 200); primo `tls.cert.date_invalid` → `tls-error`; crash 2 → 6 settimana su settimana → `crash-spike`; 4 → 6 → niente (sotto il minimo di 5 c'è già; 6 < 2×4).
- [ ] **Step 2–5:** FAIL → implementa → PASS → commit `feat: network error and crash rate alerts`.

---

### Task 7: Pulizia dei nuovi dati

**Files:**
- Modify: `src/jobs/maintenance.ts`
- Test: `tests/jobs/maintenance.test.ts` (estendi)

- `window_counts` più vecchi di 2 giorni cancellati; `reminders` inviati da più di 90 giorni cancellati.
- [ ] **Step 1–5:** test → FAIL → implementa → PASS → commit `chore: prune window counts and reminders`.

---

### Task 8: Header suggeriti per tipo

**Files:**
- Modify: `src/headers.ts`, `src/store/sites.ts`
- Test: `tests/headers.test.ts` (estendi)

**Interfaces:**
- Produces:
  - `type HeaderFeature = 'csp' | 'csp-hash' | 'nel' | 'permissions' | 'coop' | 'coep' | 'document' | 'integrity' | 'connection'`
  - `buildHeaderSet(baseUrl, key, enabled: HeaderFeature[], approved): { name: string; value: string; note: string }[]` — sempre `Reporting-Endpoints: csp="<ep>", default="<ep>"`; poi, per ogni funzione abilitata:
    - `csp`: la CSP Report-Only stretta o suggerita del Piano 1; con `csp-hash` aggiunge `'report-sha256'` a `script-src`;
    - `nel`: `Report-To: {"group":"nel","max_age":2592000,"endpoints":[{"url":"<ep>"}]}` e `NEL: {"report_to":"nel","max_age":2592000,"failure_fraction":1.0,"success_fraction":0.01}`;
    - `permissions`: `Permissions-Policy-Report-Only: camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), display-capture=()` con `report-to=default` nei parametri;
    - `coop`: `Cross-Origin-Opener-Policy-Report-Only: same-origin; report-to="default"`;
    - `coep`: `Cross-Origin-Embedder-Policy-Report-Only: require-corp; report-to="default"`;
    - `document`: `Document-Policy-Report-Only: oversized-images=2.0, unsized-media=?0; report-to=default`;
    - `integrity`: `Integrity-Policy-Report-Only: blocked-destinations=(script), endpoints=(default)`;
    - `connection`: valore preso dalla bozza della specifica in vigore al momento dello sviluppo, con nota "sperimentale".
    `note` è una frase in italiano su browser supportati e cautele (quelle del mockup).
  - `setEnabledHeaders(db, siteId, features: HeaderFeature[])`.
  Prima di fissare le stringhe, verifica la sintassi di ciascun header su MDN o sulla specifica; i test contengono le stringhe verificate.
- [ ] **Step 1–5:** test (una stringa attesa per funzione) → FAIL → implementa → PASS → commit `feat: per-site header set`.

---

### Task 9: Pagine per tipo e riepilogo sito

**Files:**
- Create: `src/web/typePages.ts`, `src/web/views/TypePage.tsx`; Modify: `src/web/views/SiteDetail.tsx`, `src/web/views/Layout.tsx`, `src/web/app.ts`, `src/web/queries.ts`
- Test: `tests/web/typePages.test.ts`

**Interfaces:**
- Produces:
  - `type TypePageDef = { type: string; slug: string; family: 'attack' | 'failure' | 'policy'; title: string; description: string; metrics(db, siteId, now): { label: string; value: string; sub: string; tone?: 'danger' | 'warning' }[]; columns: string[]; row(o: OriginRow): Cell[]; filters: { name: string; options: string[] }[]; alertRule: string; setupFeature: HeaderFeature | null }`
  - `TYPE_PAGES: TypePageDef[]` — 12 voci, con titoli, descrizioni, colonne e testi "Quando ti avvisa" presi dalle pagine del mockup. `csp-violation` usa la pagina del Piano 1 (stessa rotta) ma compare nel menu e nel riepilogo.
  - `GET /sites/:id/types/:slug` — pagina generica: intestazione, 3 numeri, grafico 30 giorni, ripartizione per browser, tabella aggregata con filtri, "Quando ti avvisa", "Come si attiva" (dall'header set del Task 8).
  - Azioni specifiche: `POST /sites/:id/origins/:originId/volatile` (csp-hash), `POST /sites/:id/release` (inizia rilascio, csp-hash), `POST /sites/:id/settings` accetta anche `sensitive_paths` (uno per riga) e le funzioni header abilitate (checkbox).
  - Menu laterale del sito: tre gruppi (Segnali di attacco, Guasti del browser, Igiene delle policy) come nel mockup.
  - Riepilogo sito: tre righe di quattro riquadri (nome, codice, conteggio 7 giorni, stato), stato "non attivo" se la funzione non è abilitata per il sito e non ci sono report negli ultimi 7 giorni.
- [ ] **Step 1: test** — ogni slug risponde 200 con il titolo atteso; i dati dei report sono escapati su ogni pagina (stesso test del Piano 1 iterato su tutti gli slug); il riepilogo mostra 12 riquadri; un tipo senza header abilitato e senza report mostra "non attivo".
- [ ] **Step 2–5:** FAIL → implementa → PASS → commit `feat: report type pages`.

---

### Task 10: Prova completa

**Files:**
- Test: `tests/e2e-types.test.ts`

- Un sito fuori apprendimento riceve in un solo `POST application/reports+json` un `integrity-violation`, un `deprecation` con data di rimozione fra 60 giorni, un `intervention` e un `csp-violation` nuovo. Dopo 10 minuti: un'email con tre gruppi (integrità, deprecazione, nuova origine) e nessuna voce per l'intervento; dopo 30 giorni simulati parte il promemoria; la pagina di ogni tipo mostra la sua riga.
- [ ] **Step 1–5:** test → FAIL → completa → `npm test` verde → commit `test: end-to-end for report types`.
