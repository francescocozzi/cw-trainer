<?php
declare(strict_types=1);
// Gestione utenti da riga di comando.
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}
require __DIR__ . '/lib.php';

$usage = <<<TXT
Uso:
  php manage.php list                 elenca gli utenti
  php manage.php add <utente>         crea un utente con password generata
  php manage.php passwd <utente>      genera una nuova password per l’utente
  php manage.php del <utente>         elimina l’utente con tutti i suoi dati

TXT;

function gen_password(): string
{
    $chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    $p = '';
    for ($i = 0; $i < 12; $i++) {
        $p .= $chars[random_int(0, strlen($chars) - 1)];
    }
    return $p;
}

$cmd = $argv[1] ?? '';
$name = $argv[2] ?? '';

try {
    $db = cw_db();
    switch ($cmd) {
        case 'list':
            $rows = $db->query('SELECT u.username, u.created_at, (SELECT COUNT(*) FROM results r WHERE r.user_id = u.id) AS n FROM users u ORDER BY u.username')->fetchAll();
            if (!$rows) {
                echo "Nessun utente.\n";
            }
            foreach ($rows as $r) {
                printf("%-32s creato %s, %d sessioni\n", $r['username'], date('d/m/Y', (int)$r['created_at']), $r['n']);
            }
            break;

        case 'add':
            $pass = gen_password();
            $u = cw_create_user($db, $name, $pass);
            echo "Utente creato: {$u['username']}\nPassword: $pass\n";
            break;

        case 'passwd':
            $u = cw_find_user($db, $name);
            if (!$u) {
                throw new CwError("Utente non trovato: $name");
            }
            $pass = gen_password();
            cw_set_password($db, (int)$u['id'], $pass);
            echo "Nuova password per {$u['username']}: $pass\n";
            break;

        case 'del':
            $u = cw_find_user($db, $name);
            if (!$u) {
                throw new CwError("Utente non trovato: $name");
            }
            echo "Eliminare {$u['username']} e tutti i suoi dati? Scrivi il nome utente per confermare: ";
            if (trim((string)fgets(STDIN)) !== $u['username']) {
                echo "Annullato.\n";
                break;
            }
            cw_delete_user($db, (int)$u['id']);
            echo "Eliminato.\n";
            break;

        default:
            echo $usage;
    }
} catch (CwError $e) {
    fwrite(STDERR, $e->getMessage() . "\n");
    exit(1);
}
