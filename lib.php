<?php
declare(strict_types=1);

function cw_config(): array
{
    static $c = null;
    if ($c === null) {
        $c = require __DIR__ . '/config.php';
    }
    return $c;
}

function cw_db(): PDO
{
    static $pdo = null;
    if ($pdo !== null) {
        return $pdo;
    }
    $c = cw_config();
    $dsn = $c['db_dsn'];
    if (strpos($dsn, 'sqlite:') === 0) {
        $dir = dirname(substr($dsn, 7));
        if (!is_dir($dir)) {
            mkdir($dir, 0700, true);
        }
    }
    $pdo = new PDO($dsn, $c['db_user'] ?? null, $c['db_pass'] ?? null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ]);
    $driver = $pdo->getAttribute(PDO::ATTR_DRIVER_NAME);
    if ($driver === 'sqlite') {
        $pdo->exec('PRAGMA foreign_keys = ON');
        $pdo->exec('PRAGMA journal_mode = WAL');
        $pdo->exec('PRAGMA busy_timeout = 5000');
    }
    cw_migrate($pdo, $driver);
    return $pdo;
}

function cw_migrate(PDO $db, string $driver): void
{
    if ($driver === 'mysql') {
        $t = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
        $db->exec("CREATE TABLE IF NOT EXISTS users (
            id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(32) NOT NULL UNIQUE,
            pass_hash VARCHAR(255) NOT NULL,
            created_at INT NOT NULL) $t");
        $db->exec("CREATE TABLE IF NOT EXISTS settings (
            user_id INT UNSIGNED PRIMARY KEY,
            data MEDIUMTEXT NOT NULL,
            updated_at INT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE) $t");
        $db->exec("CREATE TABLE IF NOT EXISTS results (
            id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            user_id INT UNSIGNED NOT NULL,
            ts BIGINT NOT NULL,
            chars VARCHAR(255) NOT NULL,
            wpm SMALLINT NOT NULL, eff SMALLINT NOT NULL, acc TINYINT NOT NULL,
            errors INT NOT NULL, total INT NOT NULL,
            sent MEDIUMTEXT NOT NULL, typed MEDIUMTEXT NOT NULL,
            KEY user_ts (user_id, ts),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE) $t");
        $db->exec("CREATE TABLE IF NOT EXISTS instant (
            id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            user_id INT UNSIGNED NOT NULL,
            ts BIGINT NOT NULL,
            ch VARCHAR(4) NOT NULL, ans VARCHAR(4) NOT NULL,
            ms INT NULL, voice TINYINT NOT NULL, wpm SMALLINT NOT NULL,
            KEY user_ts (user_id, ts),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE) $t");
        $db->exec("CREATE TABLE IF NOT EXISTS login_attempts (
            id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            ip VARCHAR(45) NOT NULL, username VARCHAR(64) NOT NULL, ts INT NOT NULL,
            KEY ts (ts)) $t");
        return;
    }
    $db->exec('CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        pass_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL)');
    $db->exec('CREATE TABLE IF NOT EXISTS settings (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL)');
    $db->exec('CREATE TABLE IF NOT EXISTS results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        ts INTEGER NOT NULL,
        chars TEXT NOT NULL,
        wpm INTEGER NOT NULL, eff INTEGER NOT NULL, acc INTEGER NOT NULL,
        errors INTEGER NOT NULL, total INTEGER NOT NULL,
        sent TEXT NOT NULL, typed TEXT NOT NULL)');
    $db->exec('CREATE INDEX IF NOT EXISTS results_user_ts ON results (user_id, ts)');
    // Risposte del riconoscimento rapido: una riga per risposta. ms è il tempo dalla fine
    // del tono, NULL se non confrontabile (risposta a voce o carattere riascoltato)
    $db->exec('CREATE TABLE IF NOT EXISTS instant (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        ts INTEGER NOT NULL,
        ch TEXT NOT NULL, ans TEXT NOT NULL,
        ms INTEGER, voice INTEGER NOT NULL, wpm INTEGER NOT NULL)');
    $db->exec('CREATE INDEX IF NOT EXISTS instant_user_ts ON instant (user_id, ts)');
    $db->exec('CREATE TABLE IF NOT EXISTS login_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ip TEXT NOT NULL, username TEXT NOT NULL, ts INTEGER NOT NULL)');
    $db->exec('CREATE INDEX IF NOT EXISTS login_attempts_ts ON login_attempts (ts)');
}

/** Errore con un messaggio mostrabile all’utente. */
class CwError extends RuntimeException
{
    public int $status;
    public function __construct(string $msg, int $status = 400)
    {
        parent::__construct($msg);
        $this->status = $status;
    }
}

function cw_validate_username(string $u): string
{
    $u = trim($u);
    if (!preg_match('/^[A-Za-z0-9._-]{3,32}$/', $u)) {
        throw new CwError('Il nome utente deve avere da 3 a 32 caratteri tra lettere, cifre, punto, trattino e trattino basso.');
    }
    return $u;
}

function cw_validate_password(string $p): string
{
    if (strlen($p) < 8) {
        throw new CwError('La password deve avere almeno 8 caratteri.');
    }
    if (strlen($p) > 200) {
        throw new CwError('La password è troppo lunga.');
    }
    return $p;
}

function cw_find_user(PDO $db, string $username): ?array
{
    $st = $db->prepare('SELECT id, username, pass_hash FROM users WHERE username = ?');
    $st->execute([$username]);
    $u = $st->fetch();
    return $u ?: null;
}

function cw_create_user(PDO $db, string $username, string $password): array
{
    $username = cw_validate_username($username);
    cw_validate_password($password);
    if (cw_find_user($db, $username)) {
        throw new CwError('Nome utente già in uso.', 409);
    }
    $st = $db->prepare('INSERT INTO users (username, pass_hash, created_at) VALUES (?, ?, ?)');
    $st->execute([$username, password_hash($password, PASSWORD_DEFAULT), time()]);
    return ['id' => (int)$db->lastInsertId(), 'username' => $username];
}

function cw_set_password(PDO $db, int $userId, string $password): void
{
    cw_validate_password($password);
    $st = $db->prepare('UPDATE users SET pass_hash = ? WHERE id = ?');
    $st->execute([password_hash($password, PASSWORD_DEFAULT), $userId]);
}

// ---- Validazione dei dati inviati dall’app ----

const CW_CHARS = "KMURESNAPTLWI.JZ=FOY,VG5/Q92H38B?47C1D60X!\"'()+-:;@ÀÄÆÅÇÉÈÑÖØÜ";

function cw_split(string $s): array
{
    return $s === '' ? [] : preg_split('//u', $s, -1, PREG_SPLIT_NO_EMPTY);
}

/** Tiene solo i caratteri ammessi, senza duplicati, nell’ordine standard. */
function cw_clean_chars($v): string
{
    if (!is_string($v)) {
        return '';
    }
    $in = array_flip(cw_split(mb_substr($v, 0, 200)));
    $out = '';
    foreach (cw_split(CW_CHARS) as $c) {
        if (isset($in[$c])) {
            $out .= $c;
        }
    }
    return $out;
}

function cw_clean_int($v, int $min, int $max, int $def): int
{
    return is_numeric($v) ? max($min, min($max, (int)$v)) : $def;
}

/** Accetta solo le impostazioni conosciute, con tipi e limiti corretti. */
function cw_clean_settings($in): array
{
    $in = is_array($in) ? $in : [];
    $sets = [];
    foreach (array_slice(is_array($in['sets'] ?? null) ? $in['sets'] : [], 0, 50) as $set) {
        if (!is_array($set) || !is_string($set['name'] ?? null)) {
            continue;
        }
        $name = trim(preg_replace('/[\x00-\x1F\x7F]/u', '', mb_substr($set['name'], 0, 40)) ?? '');
        $chars = cw_clean_chars($set['chars'] ?? '');
        if ($name !== '' && $chars !== '') {
            $sets[$name] = ['name' => $name, 'chars' => $chars];
        }
    }
    $mode = is_string($in['mode'] ?? null) ? $in['mode'] : 'custom';
    $okMode = in_array($mode, ['custom', 'letters', 'numbers', 'mixed'], true)
        || (strpos($mode, 'set:') === 0 && isset($sets[substr($mode, 4)]));
    $wpm = cw_clean_int($in['wpm'] ?? null, 5, 60, 20);
    return [
        'chars' => cw_clean_chars($in['chars'] ?? 'KMURES'),
        'sets' => array_values($sets),
        'mode' => $okMode ? $mode : 'custom',
        'wpm' => $wpm,
        'eff' => min($wpm, cw_clean_int($in['eff'] ?? null, 2, 60, 12)),
        'extra' => cw_clean_int($in['extra'] ?? null, 0, 10, 0),
        'freq' => cw_clean_int($in['freq'] ?? null, 300, 1200, 600),
        'randTone' => !empty($in['randTone']),
        'vol' => cw_clean_int($in['vol'] ?? null, 5, 100, 60),
        'pre' => !array_key_exists('pre', $in) || !empty($in['pre']),
        'delay' => cw_clean_int($in['delay'] ?? null, 0, 10, 3),
        'glen' => cw_clean_int($in['glen'] ?? null, 1, 10, 5),
        'randLen' => !empty($in['randLen']),
        'mins' => cw_clean_int($in['mins'] ?? null, 1, 10, 5),
        'noSpace' => !empty($in['noSpace']),
    ];
}

function cw_delete_user(PDO $db, int $userId): void
{
    $db->beginTransaction();
    $db->prepare('DELETE FROM results WHERE user_id = ?')->execute([$userId]);
    $db->prepare('DELETE FROM instant WHERE user_id = ?')->execute([$userId]);
    $db->prepare('DELETE FROM settings WHERE user_id = ?')->execute([$userId]);
    $db->prepare('DELETE FROM users WHERE id = ?')->execute([$userId]);
    $db->commit();
}
