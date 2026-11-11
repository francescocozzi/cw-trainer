# CW Trainer

Trainer CW per mobile con account utente. Frontend in un solo file HTML, backend PHP con database SQLite (o MySQL/MariaDB).

## Requisiti

- PHP 7.4 o superiore (consigliato 8.x) con le estensioni `pdo_sqlite` (oppure `pdo_mysql`) e `mbstring`
- HTTPS (serve per le sessioni sicure e per l’uso come app da schermata Home)

## Installazione

1. Carica il contenuto della cartella sul server, per esempio in `/cw/` del tuo dominio.
2. Rendi la cartella `data/` scrivibile da PHP. Lì vengono creati il database e le sessioni.
3. Apri `config.php` e scegli se attivare la registrazione libera (`allow_registration`).
4. Crea il primo utente da SSH:

       php manage.php add nomeutente

   La password viene generata e mostrata a schermo.

5. Apri l’indirizzo dal telefono, accedi e aggiungi la pagina alla schermata Home.

## Gestione utenti (da SSH)

    php manage.php list               elenca gli utenti
    php manage.php add <utente>       crea un utente con password generata
    php manage.php passwd <utente>    genera una nuova password
    php manage.php del <utente>       elimina l’utente e tutti i suoi dati
    php manage.php tutor <utente>     rende tutor l’utente (o gli toglie il ruolo)

Ogni utente può cambiare la propria password dalle impostazioni dell’app.

## Classi

Un tutor crea una classe dalla vista «Classe» e riceve un codice di invito. Gli allievi lo inseriscono in Impostazioni › Classi. Il tutor assegna esercizi che fissano caratteri, velocità, gruppi e durata, prendendoli dalle proprie impostazioni del momento. Tono, volume, ritardo, risposta a voce e trascrizione a blocchi restano scelte dell’allievo. Gli esercizi compaiono nel menu Modo dell’allievo e valgono sia per i gruppi sia per il Rapido.

Il tutor vede soltanto i risultati degli esercizi assegnati, e solo degli allievi ancora in classe. L’allievo può uscire quando vuole. Il codice si può rigenerare: quello vecchio smette di funzionare. I tentativi con un codice sbagliato hanno lo stesso limite degli accessi.

## Sicurezza

- Password salvate con `password_hash` (bcrypt). Cambiando password, tutte le altre sessioni aperte decadono.
- Blocco temporaneo dopo troppi tentativi falliti in 15 minuti: 10 per nome utente, 20 per IP. Le registrazioni (se attive) sono limitate a 10 ogni 15 minuti.
- Le richieste che modificano dati richiedono un header personalizzato e JSON: un altro sito non può inviarle a nome dell’utente.
- Cookie di sessione `HttpOnly`, `SameSite=Lax` e `Secure` su HTTPS; ID di sessione rigenerato all’accesso.
- Il server valida tutto quello che riceve: impostazioni, caratteri, gruppi e testi trascritti hanno formati e limiti precisi. Al massimo un risultato ogni 15 secondi e 20.000 sessioni per utente.
- Nessun errore PHP viene mostrato nelle risposte; finisce solo nel log.
- `.htaccess` impone HTTPS, aggiunge gli header di sicurezza (CSP senza script inline, HSTS, blocco dell’inclusione in iframe) e blocca l’accesso a `config.php`, `lib.php`, `manage.php` e alla cartella `data/`.
- Nessuna risorsa esterna: font e script sono serviti dal tuo dominio.
- Ogni utente può eliminare il proprio account con tutti i dati dalle impostazioni.

### Da fare dopo l’installazione

1. Apri `https://tuodominio/percorso/data/cw.sqlite` e `https://tuodominio/percorso/config.php`: devi ricevere un errore 403.
2. Meglio ancora, sposta i dati fuori da `public_html` modificando `db_dsn` e `session_dir` in `config.php`, per esempio in `/home/utente/cw-data/`.
3. Se il sito passa da Cloudflare, imposta `'trusted_ip_header' => 'HTTP_CF_CONNECTING_IP'` in `config.php`.

## Dati salvati

- `users`: nome utente e hash della password
- `settings`: impostazioni dell’app per utente (JSON)
- `results`: ogni esercizio controllato, con data, caratteri, velocità, precisione, testo trasmesso e testo trascritto
- `login_attempts`: tentativi falliti, cancellati automaticamente dopo 24 ore

L’app mostra le ultime 50 sessioni; nel database restano tutte.

## Statistiche

La scheda Statistiche calcola dal database, per il periodo scelto (7, 30, 90 giorni o sempre):

- numero di sessioni, precisione complessiva, caratteri trascritti e giorni consecutivi di esercizio;
- andamento giornaliero di precisione e velocità;
- precisione di ogni carattere, dal più difficile al più facile;
- confusioni più frequenti (carattere trasmesso e carattere scritto al suo posto).

Il pulsante «Esercitati su…» crea il set «Da ripassare» con i caratteri più deboli e lo seleziona nell’esercizio.

## App sul telefono

L’app si installa dalla schermata Home (Safari: Condividi › Aggiungi alla schermata Home; Chrome: menu › Installa app).

`sw.php` è il service worker: tiene sul telefono pagina, script, font, icone e loghi, così l’app si apre subito anche con rete scarsa. Login, impostazioni e risultati passano sempre dal server; senza rete l’app si apre e avvisa che serve la connessione.

La versione della cache è l’impronta dei file statici, calcolata da `sw.php`: dopo aver caricato un aggiornamento non serve cambiare nulla, i telefoni lo scaricano da soli e lo usano dall’avvio successivo. Se aggiungi un nuovo file statico (immagine, font), aggiungilo all’elenco `$files` in `sw.php`.

## Risposta a voce (Rapido)

Nel riconoscimento rapido si può rispondere a voce con l’alfabeto NATO o con quello italiano, e con le cifre in italiano o in inglese. L’elenco delle parole accettate è `SPOKEN` in `app.js`. Il riconoscimento lo esegue il browser (Safari sui server Apple, Chrome su quelli Google); Firefox non lo supporta e l’interruttore non compare. Il microfono va permesso nel `.htaccess` con `microphone=(self)` nella `Permissions-Policy`.

## Licenza

Il codice è distribuito con licenza MIT (file `LICENSE`). Come indicato nel file `NOTICE`, sono esclusi il logo ARI (`ari-logo*.png`), che è un marchio dell’Associazione Radioamatori Italiani usato con il permesso della sezione di Bari e non va riutilizzato, e i font, che hanno la propria licenza SIL OFL 1.1 nella cartella `fonts`. Chi adatta l’app per un’altra sezione deve togliere i file del logo e i riferimenti in `index.html` e `sw.php`.

## Deploy automatico

`.github/workflows/deploy.yml` controlla la sintassi di PHP, JavaScript e manifest a ogni push. Se i controlli passano, copia l'app sul server con rsync su SSH: il ramo `main` va in produzione, ogni altro ramo nella copia di staging (`DEPLOY_PATH_STAGING`). Lo staging ha `config.php`, database e utenti propri, e un header che lo tiene fuori dai motori di ricerca. Gli utenti di prova si creano con `php manage.php add <nome>` nella cartella di staging sul server.

- Non tocca `config.php` né i dati in `data/`: restano quelli del server.
- Non cancella sul server i file tolti dal repository: vanno rimossi a mano.
- Imposta i permessi a 644 per i file e 755 per le cartelle.
- Finché i segreti `SSH_*` e `DEPLOY_PATH` non sono impostati, il deploy viene saltato. L'elenco dei segreti è in cima al file del workflow.
