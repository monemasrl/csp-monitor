# CSP Monitor

Servizio personale che riceve i report CSP (Content-Security-Policy-Report-Only) dai browser, scarta il rumore, tiene per ogni sito l'elenco delle origini esterne e manda un'email quando compare un'origine mai vista. Dashboard protetta da password, interfaccia in italiano.

Il servizio non salva mai l'indirizzo IP dei visitatori; dagli URL toglie query string e fragment e riduce lo user agent a famiglia e versione maggiore.

## Requisiti

- Un server con Docker e Docker Compose v2.
- Un nome di dominio che punta al server (porte 80 e 443 raggiungibili: Caddy ottiene da solo il certificato HTTPS).
- Un server SMTP per le email di avviso.
- Node 24 sul proprio computer, solo per generare l'hash della password (in alternativa vedi sotto).

## Configurazione

```
cp .env.example .env
```

Variabili di `.env`:

| Variabile | Significato |
| --- | --- |
| `PORT` | porta interna dell'app (default 3000) |
| `BASE_URL` | URL pubblico, es. `https://monitor.example.it` |
| `CSP_DOMAIN` | dominio servito da Caddy, es. `monitor.example.it` |
| `DATA_DIR` | cartella dati nel container (default `/data`) |
| `ADMIN_PASSWORD_HASH` | hash della password di accesso, tra apici singoli |
| `SESSION_SECRET` | stringa casuale di almeno 32 caratteri |
| `TRUST_PROXY` | `1` dietro Caddy (legge `X-Forwarded-For` solo per il limite sui login) |
| `SECURE_COOKIES` | `1` con HTTPS |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE` | server SMTP (`SMTP_SECURE=1` per TLS diretto, di solito porta 465) |
| `SMTP_FROM` | mittente delle email |
| `ALERT_EMAIL` | destinatario degli avvisi |

Hash della password: con Node 24 e `npm ci` eseguiti in locale

```
npm run hash-password
```

Chiede la password e stampa l'hash da incollare in `ADMIN_PASSWORD_HASH='...'`. Gli apici singoli sono necessari: l'hash contiene dei `$` che Docker Compose altrimenti interpreta. Senza Node in locale, dopo `docker compose build`:

```
docker compose run --rm --no-deps app -e "import('./dist/auth/password.js').then(m => console.log(m.hashPassword(process.argv[1])))" 'la-tua-password'
```

L'immagine è Distroless (nessuna shell, niente `docker exec … sh`): l'entrypoint è `node`, quindi i comandi vanno passati come argomenti di node, come sopra.

Un valore per `SESSION_SECRET`: `openssl rand -hex 32`.

## Avvio

```
docker compose up -d
```

Apri `https://<CSP_DOMAIN>` e accedi con la password scelta. L'app non pubblica porte: è raggiungibile solo tramite Caddy, che limita a 64 KB il corpo delle richieste su `/r/*`: oltre quel limite Caddy risponde `413` (i browser ignorano la risposta, quindi non cambia nulla per i visitatori).

## Aggiungere un sito

1. In dashboard: "Aggiungi sito", nome e domini.
2. Nella pagina del sito copia gli header `Reporting-Endpoints` e `Content-Security-Policy-Report-Only` proposti (contengono l'endpoint `/r/<chiave>` del sito) e aggiungili alle risposte del sito.
3. Per 7 giorni il sito è in apprendimento: le origini viste non generano avvisi. Poi ogni origine nuova arriva per email (raggruppata ogni 10 minuti) e compare in "Da rivedere", dove puoi approvarla o segnarla come sospetta.

## Backup

Ogni giorno il servizio salva una copia del database in `backups/` dentro il volume `data` (dentro il container: `/data/backups/`), tenendo le ultime 14. Per portarle fuori dal server:

```
docker compose cp app:/data/backups ./backups
```

e poi, dal proprio computer, `scp -r server:percorso/backups .`. Per ripristinare (l'immagine non ha una shell, quindi si usa un contenitore temporaneo per i permessi; il nome del volume è `<cartella-del-progetto>_data`, vedi `docker volume ls`):

```
docker compose stop app
docker compose cp ./csp-monitor-AAAA-MM-GG.sqlite app:/data/csp-monitor.sqlite
docker run --rm -v <cartella-del-progetto>_data:/data alpine sh -c 'rm -f /data/csp-monitor.sqlite-wal /data/csp-monitor.sqlite-shm; chown 65532:65532 /data/csp-monitor.sqlite'
docker compose start app
```

Il comando `docker compose cp` funziona anche con il container fermo.

## Sessioni

Il logout non revoca le altre sessioni già aperte: per invalidarle tutte basta cambiare `SESSION_SECRET` e riavviare l'app (tutti dovranno rifare il login).

## Aggiornamento

```
git pull && docker compose up -d --build
```

I dati restano nel volume `data`.
