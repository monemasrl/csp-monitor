# CSP Monitor — documento di progetto

Data: 2026-11-12 · Autore: Andrea Bettarini (con Claude)

## Intento e perché

Andrea gestisce qualche decina di siti web (WordPress, Drupal, siti su misura come Gida). Vuole accorgersi presto se su uno di questi compare qualcosa che non dovrebbe esserci: uno script iniettato, un plugin compromesso, un form o una risorsa che parla con un dominio sconosciuto.

Lo strumento è la Content Security Policy in modalità **Report-Only**: ogni sito manda al servizio un report ogni volta che il browser carica una risorsa fuori dalla policy. Il servizio raccoglie i report di tutti i siti in un'unica dashboard e avvisa Andrea quando compare qualcosa di **nuovo**.

L'obiettivo è la **sorveglianza di sicurezza**, non portare i siti a una CSP bloccante (quella è un'eventuale conseguenza, non lo scopo).

## Obiettivi

1. Un solo servizio che riceve i report CSP di tutti i siti, ciascuno identificato da un proprio endpoint.
2. Inventario per sito delle origini esterne caricate, per direttiva (script, stili, immagini, connessioni, frame, form…).
3. **Alert via email** ad Andrea la prima volta che su un sito compare un'origine esterna mai vista prima.
4. Dashboard per consultare siti, origini, conteggi e trend, e per approvare un'origine (per un sito o per tutti) così da non ricevere più alert su di essa.
5. Filtrare il rumore (estensioni del browser, antivirus, traduttori, bot) in modo che non generi alert.
6. **Verifica della configurazione:** controllare ogni giorno che gli header dei siti mandino davvero i report al servizio, e avvisare quando la configurazione si rompe. *(richiesto da Andrea)*
7. **Analisi degli header di sicurezza:** dare un punteggio a tutti gli header di sicurezza che il server manda (CSP in dettaglio, più HSTS, cookie, Permissions-Policy, ecc.), con i problemi e le correzioni, e avvisare quando il punteggio di sicurezza scende. *(richiesto da Andrea)*

## Non obiettivi (per ora)

- Account per i clienti, multiutente, billing: lo usa solo Andrea.
- Rendere bloccanti le policy o gestire il deploy degli header sui siti: l'header lo aggiunge Andrea a mano.
- Esportazioni e prove formali per PCI DSS (l'inventario degli hash degli script invece è incluso, vedi tipo `csp-hash`).
- Generatore automatico di policy.

## Anti-obiettivi (sarebbe un fallimento anche se funziona)

- **Troppi alert.** Se l'email arriva per rumore o ripetizioni, Andrea smette di leggerla e il prodotto è morto. Meglio un alert in meno che dieci inutili.
- Un sito con traffico alto o una policy sbagliata che fa esplodere i costi o riempie il database.
- Conservare dati personali dei visitatori (IP, query string con email o token).

## Vincoli e scelte già fatte

- **Repo:** `~/Projects/csp-monitor`, GitHub `monemasrl/csp-monitor`, privato. *(deciso da Andrea)*
- **Nessun legame con un fornitore specifico** (in particolare Cloudflare). *(deciso da Andrea)* Il servizio deve girare su qualsiasi server con Docker.
- **Piattaforma:** un'immagine Docker con app Node.js + TypeScript e database **SQLite** su volume persistente, avviata con `docker compose`. Davanti, **Caddy** come reverse proxy con HTTPS automatico (Let's Encrypt), nello stesso `compose.yaml`. *(scelte di Claude: TypeScript come gli altri progetti di Andrea; SQLite basta per il volume previsto ed è un solo file da salvare)*
- **Dashboard:** servita dalla stessa app, con **login integrato monoutente** (password con hash in variabile d'ambiente, cookie di sessione sicuro, blocco dopo tentativi falliti). *(scelta di Claude)* Il login è necessario perché la dashboard è esposta su Internet insieme all'endpoint.
- **Email:** via **SMTP** generico (qualsiasi provider), configurato con variabili d'ambiente. *(scelta di Claude)*
- **Lavori periodici** (pulizia dati, invio email raggruppate, fine periodo di apprendimento, siti silenziosi): scheduler interno all'app, nessun servizio esterno.
- **Backup:** copia giornaliera consistente del file SQLite (es. `VACUUM INTO`) in una cartella del volume; dove spostarla fuori dal server lo decide Andrea. *(scelta di Claude)*
- **Server di destinazione:** non ancora scelto; l'immagine non deve presupporne uno.
- **Webhook e Telegram:** canali aggiuntivi desiderati ("magari"), quindi seconda fase; il modello dati degli alert va pensato per più canali fin da subito.
- **Integrazione sui siti:** sempre via header HTTP (Andrea può aggiungerlo su tutti i siti), non tramite `<meta>`.
- **Traffico e budget:** traffico complessivo basso; budget contenuto (ordine di 5 $/mese, cioè un piccolo VPS o un server esistente). *(deciso da Andrea)* Quindi scrittura diretta su SQLite a ogni report (aggiornamento contatori + campione), senza code né batching; i tetti di rate limit servono come protezione da casi anomali, non per il normale funzionamento.
- Lingua dell'interfaccia: italiano.

## Come funziona

### 1. Siti e endpoint

Ogni sito ha un record con nome, dominio/i propri e una **chiave casuale** (es. 16 caratteri). L'endpoint di raccolta è `https://<dominio-servizio>/r/<chiave>`. La chiave non è un segreto forte (finisce negli header pubblici), serve solo a instradare; un report su una chiave sconosciuta viene scartato.

Per ogni sito la dashboard mostra l'header da copiare, con entrambi i meccanismi di report:

```
Reporting-Endpoints: csp="https://<servizio>/r/<chiave>"
Content-Security-Policy-Report-Only: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; form-action 'self'; object-src 'none'; base-uri 'self'; report-uri https://<servizio>/r/<chiave>; report-to csp
```

Una policy volutamente stretta: tutto ciò che è esterno viene segnalato, e così si costruisce l'inventario. *(policy di partenza: scelta di Claude; Andrea può personalizzarla per sito, il servizio non la impone)*

### 2. Ingestione

L'endpoint accetta:
- `application/csp-report` (vecchio formato `report-uri`, un report per richiesta);
- `application/reports+json` (Reporting API, array di report) per tutti i 12 tipi elencati in "Tipi di report"; i tipi sconosciuti vengono contati e scartati.

Regole:
- Risponde sempre subito `204`, senza dettagli. CORS aperto per `POST`.
- Body oltre 64 KB scartato.
- **Rate limit per sito** (es. tetto di report al minuto e al giorno, configurabile); oltre il tetto i report non vengono salvati né contati nel dettaglio, ma **ogni report passa comunque da un controllo leggero "origine già nota per questo sito e direttiva?"** (cache in memoria delle origini note; anche il rate limit è in memoria, l'app gira in un solo processo). Un'origine mai vista arriva sempre alla pipeline di alert, anche con il sito oltre il tetto: è esattamente l'evento che il servizio deve intercettare, e un attacco che inonda l'endpoint non deve poterlo nascondere. La dashboard mostra "sito X sta mandando troppi report" con il numero di scartati. *(scelta di Claude)*
- Non si salva l'IP del visitatore. Dagli URL (`document-uri`, `blocked-uri`) si tolgono query string e fragment prima di salvare. Lo user agent si riduce a famiglia browser + versione maggiore.

### 3. Normalizzazione

Da ogni report si ricava:
- **direttiva** effettiva (`effective-directive`, fallback su `violated-directive`, ridotta al nome: `script-src-elem` → `script-src`, `style-src-attr` → `style-src`, ecc.);
- **origine bloccata**: schema + host (+ porta se non standard) di `blocked-uri`, oppure una delle categorie speciali `inline`, `eval`, `data`, `blob`, `self` (se coincide con un dominio del sito);
- **pagina**: path di `document-uri` (senza query).

### 4. Filtro del rumore

Un report è **rumore** (contato ma mai causa di alert) se:
- `blocked-uri` o `source-file` usa schemi di estensione: `chrome-extension`, `moz-extension`, `safari-extension`, `safari-web-extension`, `ms-browser-extension`, `webkit-masked-url`, ecc.;
- `document-uri` non appartiene ai domini del sito (copie del sito, proxy, traduttori come `translate.goog`, cache di terzi);
- l'origine bloccata è in una **lista di rumore noto** mantenuta nel codice (es. domini iniettati da antivirus e toolbar), estendibile dalla dashboard;
- user agent di bot/crawler noti.

Le categorie `inline` ed `eval` non generano alert per origine (non hanno un dominio): finiscono in dashboard con conteggi e, quando il browser lo fornisce, lo `script-sample`. *(scelta di Claude: su WordPress/Drupal gli inline sono normali e sarebbero il rumore principale)*

### 5. Origini e alert

Il cuore del sistema è la tabella **origini per sito**: `(sito, direttiva, origine)` con prima vista, ultima vista, conteggio totale e stato:
- **nuova**: vista per la prima volta;
- **approvata**: Andrea l'ha segnata come ok per questo sito;
- **approvata globalmente**: vale per tutti i siti (Google Fonts, analytics, CDN comuni);
- **sospetta**: segnata da Andrea per tenerla d'occhio.

L'approvazione vale per l'origine sulle **direttive con cui è stata vista fino a quel momento**. *(scelta di Claude)* Motivo: un'origine approvata per `img-src` che compare in `script-src` è proprio il caso pericoloso e deve generare alert.

**Corrispondenza:** le approvazioni e il rumore noto sono per **origine esatta** di default. Andrea può creare esplicitamente un pattern con jolly sul sottodominio (`*.hotjar.com`), mai in automatico; la dashboard segnala come rischiosi i jolly su host di hosting generico (`*.cloudfront.net`, `*.googleusercontent.com`, `*.workers.dev`, ecc.), dove un attaccante può pubblicare un payload. I domini propri del sito sono un elenco esplicito, con possibilità di jolly (`*.gida-spa.it`). *(scelta di Claude)*

**Quando scatta un alert:** al primo report non-rumore di una combinazione `(sito, origine, direttiva)` non coperta da un'approvazione (per il sito o globale). Le ripetizioni successive aggiornano solo i contatori. Un'origine **sospetta** genera un nuovo alert quando compare su una direttiva nuova o dopo 30 giorni di assenza. *(scelta di Claude)*

**Periodo di apprendimento:** per i primi 7 giorni dopo l'aggiunta di un sito non partono alert: le origini si accumulano e, alla fine del periodo, arriva un'unica email di riepilogo con l'elenco da approvare. *(scelta di Claude: altrimenti il primo giorno di ogni sito sarebbe una raffica di email)* Andrea può chiudere il periodo prima dalla dashboard.

**Raggruppamento:** gli alert dello stesso sito vengono raccolti per qualche minuto (es. 10) e inviati in un'unica email, così un attacco che inietta cinque domini produce un messaggio solo. Contenuto: sito, origini nuove, direttiva, pagina in cui è comparsa, primo `source-file`/`script-sample` se presente, link alla dashboard.

**Canali:** email nella prima fase. Webhook (POST JSON) e Telegram (bot + chat id) in seconda fase, configurati a livello globale.

### 6. Dashboard

Pagine minime:
- **Panoramica:** tutti i siti con report nelle ultime 24h / 7gg, numero di origini nuove da rivedere, siti silenziosi (nessun report da X giorni: probabilmente l'header è sparito) e siti oltre il rate limit.
- **Sito:** origini raggruppate per stato e direttiva, con conteggi, prima/ultima vista, pagine principali; azioni approva / approva globalmente / sospetta; sezione inline/eval; header da copiare, sia quello stretto di partenza sia un **header suggerito** che include le origini approvate (aggiornarlo sul sito è facoltativo, ma riduce molto il volume dei report a regime); *(scelta di Claude)* impostazioni (domini, periodo di apprendimento, tetti).
- **Origine:** dettaglio con ultimi report campione (ne bastano pochi, es. 20) e su quali siti compare.
- **Approvazioni globali e rumore noto:** elenchi modificabili.
- **Impostazioni alert:** indirizzo email (e in seguito webhook/Telegram).

Una rotta `/health` per un controllo di disponibilità esterno (è un sistema di sorveglianza: se va giù, i report si perdono in silenzio).

Interfaccia semplice, renderizzata lato server dall'app; nessuna necessità di un framework frontend pesante.

### 7. Verifica della configurazione *(richiesta da Andrea; dettagli scelti da Claude)*

Ispirata al "Reporting API checker" di CentralCSP, ma solo per uso interno (nessuno strumento pubblico).

- **Quando:** automatica una volta al giorno per ogni sito, più un pulsante "Verifica ora" nella pagina del sito.
- **Cosa scarica:** solo gli header di risposta di un elenco di pagine per sito (di default la home; Andrea ne aggiunge altre, es. `/admin/`, `/checkout`), seguendo i redirect, con uno user agent riconoscibile del servizio. Nessun JavaScript eseguito.
- **Cosa ricava, per pagina:**
  - endpoint dichiarati in `Reporting-Endpoints` e `Report-To`: nome, URL, header di provenienza, se l'URL è del servizio, quali funzioni lo usano;
  - funzioni che producono report e dove li mandano: CSP (bloccante e Report-Only, via `report-to` e `report-uri`), Permissions-Policy, COOP, COEP, Document-Policy, Integrity-Policy, NEL, più crash/deprecazioni/interventi che usano l'endpoint `default`;
  - problemi con gravità: `report-to` verso un nome non dichiarato (report persi), endpoint in `http://`, pagina non in HTTPS, header di report assente, report diretti a un URL che non è del servizio, endpoint dichiarati e inutilizzati, `report-uri` senza `report-to`, NEL senza `Report-To`.
- **Storico:** si salva l'esito di ogni verifica (header grezzi compresi) per confrontarlo con il precedente.
- **Alert:** email quando una verifica automatica trova un problema **grave che nella verifica precedente non c'era**. I problemi di qualità restano solo in dashboard. Errori di rete o risposte bloccate da un firewall vengono mostrati come "verifica non riuscita" e avvisano solo dopo 3 fallimenti consecutivi.

### 8. Header di sicurezza *(richiesta da Andrea; dettagli scelti da Claude)*

Ispirata al "Security headers checker" e al "CSP scanner" di CentralCSP. Usa gli header già scaricati dalla verifica, quindi gira con la stessa frequenza e sulle stesse pagine.

**Punteggio degli header** (0–100, con sotto-punteggi sicurezza e qualità), con la CSP come componente più pesante:
- **Obbligatori:** Content-Security-Policy (bloccante), Strict-Transport-Security (max-age ≥ 1 anno), X-Content-Type-Options `nosniff`, Content-Type con charset, attributi `Secure`/`HttpOnly`/`SameSite` dei cookie.
- **Consigliati:** Referrer-Policy, Permissions-Policy, Cross-Origin-Opener/Embedder/Resource-Policy, Cache-Control sulle pagine autenticate, Reporting-Endpoints.
- **Superati:** X-Frame-Options (sostituito da `frame-ancestors`), Report-To (ok solo per NEL).
- **Deprecati, da togliere:** X-XSS-Protection, Expect-CT e simili.
- **Cookie:** controllati solo sulle pagine che li impostano, quindi tra le pagine verificate va inclusa quella di login se il sito ne ha una. `HttpOnly` è richiesto per i cookie di sessione, non per quelli letti dal JavaScript del sito (es. lingua): la distinzione si fa per nome, con un elenco modificabile per sito.

**Analisi della CSP in dettaglio:**

- Analizza separatamente la policy **bloccante** e quella **Report-Only**. Se la bloccante manca, il punteggio di sicurezza è 0 e la pagina lo spiega.
- **Punteggio 0–100** complessivo, più due sotto-punteggi: sicurezza e qualità.
- **Controlli di sicurezza:** `'unsafe-inline'`, `'unsafe-eval'`, `'unsafe-hashes'`; jolly e schemi troppo larghi (`*`, `https:`, `data:` negli script); host consentiti con bypass noti (JSONP, gadget: partire dalle liste del CSP Evaluator di Google, open source); nonce identico tra due risposte; nonce/hash scritti male o in direttive che li ignorano; `object-src`, `base-uri`, `frame-ancestors` mancanti e coperture reali di `default-src`.
- **Controlli di qualità:** direttive deprecate (`block-all-mixed-content`, `plugin-types`, …), duplicate, valori sconosciuti, separatori ignorati.
- Ogni problema ha gravità (critico, alto, medio, basso), spiegazione e correzione.
- **Storico dei punteggi** (header e CSP) per sito; il punteggio degli header compare anche nella panoramica.
- **Alert:** email quando il punteggio di sicurezza (degli header o della CSP) scende rispetto alla verifica precedente, indicando il problema nuovo che lo ha causato (header sparito, HSTS accorciato, cookie che perde un attributo, CSP indebolita). Un punteggio basso ma stabile non genera email.
- Il calcolo esatto dei pesi è lasciato a chi costruisce, purché sia deterministico e documentato.

### 9. Conservazione dei dati

- Contatori e tabella origini: per sempre (sono piccoli).
- Contatori aggregati per giorno `(sito, direttiva, origine, giorno)`: 90 giorni.
- Report grezzi campione: solo gli ultimi N per origine, più quelli degli ultimi 7 giorni, poi cancellati da un cron giornaliero.
- Esiti delle verifiche con header grezzi: 90 giorni; punteggi giornalieri: per sempre.

## Mockup

Mockup interattivo della dashboard (privato): https://claude.ai/artifact/6Fh6uA4XHSymiLm7rvLdhp — panoramica, riepilogo sito, dettaglio origine, verifica configurazione, header di sicurezza (con la vista CSP in dettaglio) e una pagina per ciascuno dei 12 tipi di report. È il riferimento per l'interfaccia; i dati mostrati sono inventati.

## Tipi di report *(tutti e 12 nella prima versione: deciso da Andrea)*

Le sezioni 2–5 descrivono `csp-violation` in dettaglio. Gli altri 11 tipi passano dallo stesso endpoint (`application/reports+json`; NEL arriva anche via `Report-To`), dallo stesso filtro del rumore dove applicabile (pagina fuori dominio, bot) e dallo stesso raggruppamento delle email. Per ciascuno cambiano la **chiave di aggregazione** (cosa conta come "la stessa cosa") e la **regola di alert**. Valori e regole sono scelte di Claude, riprese dai mockup:

| Tipo | Chiave di aggregazione | Alert |
|---|---|---|
| `csp-violation` | sito + direttiva + origine | prima combinazione non approvata (sezione 5) |
| `csp-hash` | sito + URL script (o "inline" + pagina) → hash | hash cambiato per uno script noto, o script mai visto. Si può segnare uno script come "varia spesso" (niente alert) e segnare un rilascio (cambi di hash attesi per 1 ora) |
| `integrity-violation` | sito + URL risorsa | sempre, al primo report per risorsa |
| `connection-allowlist` | sito + destinazione | prima destinazione non approvata; senza attesa di raggruppamento se la pagina è segnata come "sensibile" (login, pagamento) |
| `network-error` | sito + tipo errore + host | tasso di errori > 0,5% delle richieste campionate per 15 minuti, oppure primo errore di certificato TLS |
| `crash` | sito + motivo + pagina | crash di una pagina raddoppiati rispetto alla settimana prima |
| `deprecation` | sito + id API | una volta alla prima API con data di rimozione; promemoria 30 giorni prima della data |
| `intervention` | sito + id intervento | nessuno (solo dashboard) |
| `permissions-policy-violation` | sito + funzione + origine dello script | prima richiesta di camera, microfono, posizione o pagamento da uno script non approvato |
| `document-policy-violation` | sito + regola | nessuno (solo dashboard) |
| `coop` | sito + tipo + altra finestra | solo con policy bloccante: prima interazione bloccata mai vista |
| `coep` | sito + URL risorsa | solo con policy bloccante: prima risorsa bloccata mai vista |

Altre regole comuni:
- Il periodo di apprendimento (sezione 5) vale per tutti i tipi.
- Le soglie basate sul tasso (`network-error`, `crash`) usano i contatori giornalieri/orari già previsti; per `network-error` il "campione" sono anche i report di successo (`success_fraction` nell'header NEL suggerito).
- L'header suggerito per sito (sezione 6) diventa un insieme di header: `Reporting-Endpoints` con `csp` e `default`, `Report-To` + `NEL`, e le varianti Report-Only di Permissions-Policy, COOP, COEP, Document-Policy, Integrity-Policy e Connection-Allowlist. Andrea sceglie per sito quali attivare; la dashboard indica per ogni tipo se l'header è attivo (dato dalla verifica, sezione 7).
- Quasi tutti i tipi, tranne `csp-violation` e in parte `coop`/`coep`, arrivano oggi solo da browser Chromium; `connection-allowlist` e `document-policy` sono sperimentali e il loro formato può cambiare: il parser deve tollerare campi mancanti o sconosciuti e conservare il corpo grezzo nel campione.
- Il riepilogo sito mostra un riquadro per tipo (conteggio 7 giorni e stato), come nel mockup.

## Lasciato a chi costruisce

- Schema esatto del database, nomi delle tabelle, struttura del codice.
- Libreria/approccio per l'HTML della dashboard.
- Valori precisi di rate limit, raggruppamento, conservazione (quelli sopra sono indicativi).
- Contenuto iniziale della lista di rumore noto.
- Dominio del servizio (es. un sottodominio di un dominio Monema): chiedere ad Andrea al momento del deploy.
- Test: unit test sulla normalizzazione e sul filtro rumore con report reali di esempio, test di integrazione sull'endpoint.
