<?php
// Configurazione di CW Trainer.
// Questo file restituisce solo un array: aperto dal browser non mostra nulla.
return [
    // Database. Di default SQLite, nessuna configurazione richiesta.
    // Meglio ancora se il file sta fuori dalla cartella pubblica, ad esempio:
    // 'db_dsn' => 'sqlite:/home/utente/cw-data/cw.sqlite',
    'db_dsn'  => 'sqlite:' . __DIR__ . '/data/cw.sqlite',
    'db_user' => null,
    'db_pass' => null,

    // Per usare MySQL/MariaDB al posto di SQLite:
    // 'db_dsn'  => 'mysql:host=localhost;dbname=cwtrainer;charset=utf8mb4',
    // 'db_user' => 'cwtrainer',
    // 'db_pass' => 'la-password-del-db',

    // true = chiunque può creare un account dalla schermata di accesso.
    // false = gli account si creano solo da riga di comando con manage.php.
    'allow_registration' => false,

    // Cartella delle sessioni PHP (così la durata dell’accesso non dipende dal server).
    'session_dir' => __DIR__ . '/data/sessions',

    // Durata dell’accesso, in giorni.
    'session_days' => 90,

    // Se il sito passa da Cloudflare o da un altro proxy, indica l’header con l’IP reale
    // del visitatore (ad esempio 'HTTP_CF_CONNECTING_IP'), altrimenti il blocco dei
    // tentativi di accesso vedrebbe tutti i visitatori con lo stesso IP.
    // Lascia null se il server riceve già l’IP reale.
    'trusted_ip_header' => null,

    // Numero massimo di sessioni conservate per utente (le più vecchie vengono eliminate).
    'max_results_per_user' => 20000,
];
