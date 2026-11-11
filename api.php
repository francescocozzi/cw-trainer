<?php
declare(strict_types=1);

// Gli errori PHP non devono mai finire nella risposta (rivelerebbero percorsi e dettagli)
ini_set('display_errors', '0');
ini_set('log_errors', '1');

require __DIR__ . '/lib.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header("Content-Security-Policy: default-src 'none'; frame-ancestors 'none'");
header('Referrer-Policy: no-referrer');

function out(int $code, array $data): void
{
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

$cfg = cw_config();
$action = (string)($_GET['action'] ?? '');
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

// ---- Richiesta ----
$in = [];
if ($method === 'POST') {
    // Header personalizzato: un altro sito non può inviarlo (serve un permesso CORS che non diamo)
    if (($_SERVER['HTTP_X_REQUESTED_WITH'] ?? '') !== 'cw') {
        out(403, ['error' => 'Richiesta non valida.']);
    }
    if (stripos((string)($_SERVER['CONTENT_TYPE'] ?? ''), 'application/json') !== 0) {
        out(415, ['error' => 'Formato non supportato.']);
    }
    $raw = file_get_contents('php://input', false, null, 0, 1000001) ?: '{}';
    if (strlen($raw) > 1000000) {
        out(413, ['error' => 'Dati troppo grandi.']);
    }
    $in = json_decode($raw, true, 16);
    if (!is_array($in)) {
        out(400, ['error' => 'Dati non validi.']);
    }
}

// ---- Sessione ----
$https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
    || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
$lifetime = 86400 * (int)($cfg['session_days'] ?? 90);
$path = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'])), '/') . '/';
$cookieOpts = ['path' => $path, 'secure' => $https, 'httponly' => true, 'samesite' => 'Lax'];

// Senza cookie di sessione non serve aprirne una (evita file di sessione creati da bot)
$hasCookie = isset($_COOKIE['cwsess']);
if (!$hasCookie && !in_array($action, ['login', 'register'], true)) {
    if ($action === 'me' || $action === 'state' || $action === 'stats' || $method === 'POST') {
        out(401, ['error' => 'Accesso richiesto.', 'registration' => (bool)$cfg['allow_registration']]);
    }
}
if (!empty($cfg['session_dir'])) {
    if (!is_dir($cfg['session_dir'])) {
        mkdir($cfg['session_dir'], 0700, true);
    }
    session_save_path($cfg['session_dir']);
}
ini_set('session.gc_maxlifetime', (string)$lifetime);
ini_set('session.use_strict_mode', '1');
ini_set('session.use_only_cookies', '1');
session_name('cwsess');
session_set_cookie_params(['lifetime' => $lifetime] + $cookieOpts);
session_start();

function client_ip(array $cfg): string
{
    $h = $cfg['trusted_ip_header'] ?? null;
    $ip = ($h && !empty($_SERVER[$h])) ? trim(explode(',', (string)$_SERVER[$h])[0]) : (string)($_SERVER['REMOTE_ADDR'] ?? '');
    return substr($ip, 0, 45);
}

/** Impronta della password: se la password cambia, le altre sessioni decadono. */
function pass_tag(string $hash): string
{
    return substr(hash('sha256', $hash), 0, 16);
}

function current_user(PDO $db): ?array
{
    $id = $_SESSION['uid'] ?? null;
    if (!$id) {
        return null;
    }
    $st = $db->prepare('SELECT id, username, pass_hash FROM users WHERE id = ?');
    $st->execute([$id]);
    $u = $st->fetch();
    if (!$u || !hash_equals(pass_tag($u['pass_hash']), (string)($_SESSION['ptag'] ?? ''))) {
        $_SESSION = [];
        return null;
    }
    return ['id' => (int)$u['id'], 'username' => $u['username']];
}

function require_user(PDO $db, array $cfg): array
{
    $u = current_user($db);
    if (!$u) {
        out(401, ['error' => 'Accesso richiesto.', 'registration' => (bool)$cfg['allow_registration']]);
    }
    return $u;
}

function require_post(string $method): void
{
    if ($method !== 'POST') {
        out(405, ['error' => 'Metodo non consentito.']);
    }
}

/** Blocca dopo troppi tentativi falliti in 15 minuti: 20 per IP, 10 per nome utente. */
function throttle(PDO $db, array $cfg, string $username): void
{
    $since = time() - 900;
    $db->prepare('DELETE FROM login_attempts WHERE ts < ?')->execute([time() - 86400]);
    $st = $db->prepare('SELECT
        SUM(CASE WHEN ip = ? THEN 1 ELSE 0 END) AS by_ip,
        SUM(CASE WHEN username = ? THEN 1 ELSE 0 END) AS by_user
        FROM login_attempts WHERE ts > ?');
    $st->execute([client_ip($cfg), strtolower(substr($username, 0, 64)), $since]);
    $r = $st->fetch();
    if ((int)$r['by_ip'] >= 20 || (int)$r['by_user'] >= 10) {
        out(429, ['error' => 'Troppi tentativi. Riprova tra qualche minuto.']);
    }
}

function record_attempt(PDO $db, array $cfg, string $username): void
{
    $db->prepare('INSERT INTO login_attempts (ip, username, ts) VALUES (?, ?, ?)')
       ->execute([client_ip($cfg), strtolower(substr($username, 0, 64)), time()]);
}

function sign_in(array $user, string $passHash): void
{
    session_regenerate_id(true);
    $_SESSION['uid'] = (int)$user['id'];
    $_SESSION['ptag'] = pass_tag($passHash);
}

/** Verifica la password attuale dell’utente collegato (con limite di tentativi). */
function check_current_password(PDO $db, array $cfg, array $u, $pass): array
{
    throttle($db, $cfg, $u['username']);
    $full = cw_find_user($db, $u['username']);
    if (!is_string($pass) || !$full || !password_verify($pass, $full['pass_hash'])) {
        record_attempt($db, $cfg, $u['username']);
        throw new CwError('La password attuale non è corretta.');
    }
    return $full;
}

function int_in(array $in, string $k, int $min, int $max): int
{
    $v = $in[$k] ?? null;
    if (!is_numeric($v)) {
        throw new CwError("Valore mancante: $k");
    }
    return max($min, min($max, (int)$v));
}

/** Gruppi trasmessi: solo caratteri ammessi, al massimo 10 per gruppo e 2000 gruppi. */
function clean_sent($v): string
{
    if (!is_string($v)) {
        throw new CwError('Testo trasmesso non valido.');
    }
    $groups = preg_split('/\s+/u', trim($v), -1, PREG_SPLIT_NO_EMPTY);
    if (count($groups) > 2000) {
        throw new CwError('Esercizio troppo lungo.');
    }
    $allowed = array_flip(cw_split(CW_CHARS));
    foreach ($groups as $g) {
        $chars = cw_split($g);
        if (count($chars) > 10) {
            throw new CwError('Gruppo non valido.');
        }
        foreach ($chars as $c) {
            if (!isset($allowed[$c])) {
                throw new CwError('Carattere non valido.');
            }
        }
    }
    return implode(' ', $groups);
}

/** Testo trascritto: senza caratteri di controllo, gruppi lunghi al massimo 20 caratteri. */
function clean_typed($v, int $maxGroups): string
{
    if (!is_string($v)) {
        return '';
    }
    $v = preg_replace('/[\x00-\x1F\x7F]/u', ' ', mb_substr($v, 0, 50000)) ?? '';
    $groups = array_slice(preg_split('/\s+/u', trim($v), -1, PREG_SPLIT_NO_EMPTY), 0, $maxGroups + 50);
    return implode(' ', array_map(function ($g) { return mb_substr($g, 0, 20); }, $groups));
}

/** Allinea carattere per carattere testo trasmesso e trascritto (distanza di Levenshtein). */
function align_chars(array $a, array $b): array
{
    $m = count($a);
    $n = count($b);
    $d = [];
    for ($i = 0; $i <= $m; $i++) {
        $d[$i] = [$i];
    }
    for ($j = 1; $j <= $n; $j++) {
        $d[0][$j] = $j;
    }
    for ($i = 1; $i <= $m; $i++) {
        for ($j = 1; $j <= $n; $j++) {
            $d[$i][$j] = min($d[$i - 1][$j] + 1, $d[$i][$j - 1] + 1, $d[$i - 1][$j - 1] + ($a[$i - 1] === $b[$j - 1] ? 0 : 1));
        }
    }
    $pairs = [];
    $i = $m;
    $j = $n;
    while ($i > 0 || $j > 0) {
        if ($i > 0 && $j > 0 && $d[$i][$j] === $d[$i - 1][$j - 1] + ($a[$i - 1] === $b[$j - 1] ? 0 : 1)) {
            $pairs[] = [$a[--$i], $b[--$j]];
        } elseif ($i > 0 && $d[$i][$j] === $d[$i - 1][$j] + 1) {
            $pairs[] = [$a[--$i], null];
        } else {
            $pairs[] = [null, $b[--$j]];
        }
    }
    return $pairs;
}

function groups_of(string $s): array
{
    $s = trim($s);
    return $s === '' ? [] : preg_split('/\s+/u', $s);
}

try {
    $db = cw_db();

    switch ($action) {
        case 'me':
            $u = require_user($db, $cfg);
            out(200, ['user' => $u]);

        case 'login':
            require_post($method);
            $name = is_string($in['username'] ?? null) ? trim($in['username']) : '';
            $pass = is_string($in['password'] ?? null) ? $in['password'] : '';
            throttle($db, $cfg, $name);
            $u = ($name !== '' && strlen($name) <= 64) ? cw_find_user($db, $name) : null;
            // Verifica anche se l’utente non esiste, per non rivelarlo dai tempi di risposta
            $ok = password_verify($pass, $u['pass_hash'] ?? password_hash('dummy', PASSWORD_DEFAULT));
            if (!$u || !$ok) {
                record_attempt($db, $cfg, $name);
                out(401, ['error' => 'Nome utente o password errati.', 'registration' => (bool)$cfg['allow_registration']]);
            }
            if (password_needs_rehash($u['pass_hash'], PASSWORD_DEFAULT)) {
                cw_set_password($db, (int)$u['id'], $pass);
                $u = cw_find_user($db, $name);
            }
            $db->prepare('DELETE FROM login_attempts WHERE username = ?')->execute([strtolower($name)]);
            sign_in($u, $u['pass_hash']);
            out(200, ['user' => ['id' => (int)$u['id'], 'username' => $u['username']]]);

        case 'register':
            require_post($method);
            if (empty($cfg['allow_registration'])) {
                out(403, ['error' => 'La registrazione non è attiva.']);
            }
            $name = is_string($in['username'] ?? null) ? $in['username'] : '';
            throttle($db, $cfg, '#register');
            record_attempt($db, $cfg, '#register'); // massimo 10 registrazioni ogni 15 minuti
            $u = cw_create_user($db, $name, is_string($in['password'] ?? null) ? $in['password'] : '');
            sign_in($u, cw_find_user($db, $u['username'])['pass_hash']);
            out(200, ['user' => $u]);

        case 'logout':
            require_post($method);
            $_SESSION = [];
            session_destroy();
            setcookie('cwsess', '', ['expires' => time() - 3600] + $cookieOpts);
            out(200, ['ok' => true]);

        case 'state':
            $u = require_user($db, $cfg);
            $st = $db->prepare('SELECT data FROM settings WHERE user_id = ?');
            $st->execute([$u['id']]);
            $settings = cw_clean_settings(json_decode((string)($st->fetchColumn() ?: '{}'), true));
            $st = $db->prepare('SELECT id, ts, chars, wpm, eff, acc, errors, total, sent, typed FROM results WHERE user_id = ? ORDER BY ts DESC, id DESC LIMIT 50');
            $st->execute([$u['id']]);
            $history = [];
            foreach ($st as $r) {
                $history[] = [
                    'id' => (int)$r['id'], 'd' => (int)$r['ts'], 's' => $r['chars'],
                    'w' => (int)$r['wpm'], 'e' => (int)$r['eff'], 'a' => (int)$r['acc'],
                    'errors' => (int)$r['errors'], 'total' => (int)$r['total'],
                    'sent' => $r['sent'], 'typed' => $r['typed'],
                ];
            }
            out(200, ['user' => $u, 'settings' => $settings, 'history' => $history]);

        case 'settings':
            require_post($method);
            $u = require_user($db, $cfg);
            if (!isset($in['settings']) || !is_array($in['settings'])) {
                throw new CwError('Impostazioni non valide.');
            }
            $json = json_encode(cw_clean_settings($in['settings']), JSON_UNESCAPED_UNICODE);
            $db->beginTransaction();
            $db->prepare('DELETE FROM settings WHERE user_id = ?')->execute([$u['id']]);
            $db->prepare('INSERT INTO settings (user_id, data, updated_at) VALUES (?, ?, ?)')->execute([$u['id'], $json, time()]);
            $db->commit();
            out(200, ['ok' => true]);

        case 'result':
            require_post($method);
            $u = require_user($db, $cfg);
            // Un esercizio dura almeno un minuto: più di un risultato ogni 15 secondi non è plausibile
            if (time() - (int)($_SESSION['last_result'] ?? 0) < 15) {
                out(429, ['error' => 'Troppi risultati in poco tempo.']);
            }
            $sent = clean_sent($in['sent'] ?? null);
            $nGroups = count(groups_of($sent));
            $chars = cw_clean_chars($in['s'] ?? '');
            $row = [
                $u['id'],
                int_in($in, 'd', 0, 4102444800000),
                $chars === '' ? '?' : $chars,
                int_in($in, 'w', 1, 100),
                int_in($in, 'e', 1, 100),
                int_in($in, 'a', 0, 100),
                int_in($in, 'errors', 0, 100000),
                int_in($in, 'total', 0, 100000),
                $sent,
                clean_typed($in['typed'] ?? '', $nGroups),
            ];
            $db->prepare('INSERT INTO results (user_id, ts, chars, wpm, eff, acc, errors, total, sent, typed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')->execute($row);
            $id = (int)$db->lastInsertId();
            $_SESSION['last_result'] = time();
            // Tiene al massimo N sessioni per utente
            $max = (int)($cfg['max_results_per_user'] ?? 20000);
            $st = $db->prepare('SELECT id FROM results WHERE user_id = ? ORDER BY ts DESC, id DESC LIMIT 1 OFFSET ' . max(1, $max));
            $st->execute([$u['id']]);
            $cut = $st->fetchColumn();
            if ($cut) {
                $db->prepare('DELETE FROM results WHERE user_id = ? AND id <= ?')->execute([$u['id'], $cut]);
            }
            out(200, ['id' => $id]);

        case 'instant':
            // Risposte del riconoscimento rapido, inviate a blocchi dall'app
            require_post($method);
            $u = require_user($db, $cfg);
            if (time() - (int)($_SESSION['last_instant'] ?? 0) < 2) {
                out(429, ['error' => 'Troppi invii in poco tempo.']);
            }
            $items = $in['items'] ?? null;
            if (!is_array($items) || !$items || count($items) > 200) {
                throw new CwError('Risposte non valide.');
            }
            $allowed = array_flip(cw_split(CW_CHARS));
            $rows = [];
            foreach ($items as $it) {
                $c = is_array($it) && is_string($it['c'] ?? null) ? $it['c'] : '';
                $a = is_array($it) && is_string($it['a'] ?? null) ? $it['a'] : '';
                if (!isset($allowed[$c]) || !isset($allowed[$a])) {
                    throw new CwError('Carattere non valido.');
                }
                $ms = isset($it['ms']) && is_numeric($it['ms']) ? max(0, min(60000, (int)$it['ms'])) : null;
                $rows[] = [$u['id'], int_in($it, 't', 0, 4102444800000), $c, $a, $ms, empty($it['v']) ? 0 : 1, int_in($it, 'w', 1, 100)];
            }
            $db->beginTransaction();
            $st = $db->prepare('INSERT INTO instant (user_id, ts, ch, ans, ms, voice, wpm) VALUES (?, ?, ?, ?, ?, ?, ?)');
            foreach ($rows as $r) {
                $st->execute($r);
            }
            // Tiene al massimo 100.000 risposte per utente
            $st = $db->prepare('SELECT id FROM instant WHERE user_id = ? ORDER BY ts DESC, id DESC LIMIT 1 OFFSET 100000');
            $st->execute([$u['id']]);
            $cut = $st->fetchColumn();
            if ($cut) {
                $db->prepare('DELETE FROM instant WHERE user_id = ? AND id <= ?')->execute([$u['id'], $cut]);
            }
            $db->commit();
            $_SESSION['last_instant'] = time();
            out(200, ['ok' => true, 'n' => count($rows)]);

        case 'clear_history':
            require_post($method);
            $u = require_user($db, $cfg);
            $db->prepare('DELETE FROM results WHERE user_id = ?')->execute([$u['id']]);
            $db->prepare('DELETE FROM instant WHERE user_id = ?')->execute([$u['id']]);
            out(200, ['ok' => true]);

        case 'password':
            require_post($method);
            $u = require_user($db, $cfg);
            check_current_password($db, $cfg, $u, $in['current'] ?? null);
            cw_set_password($db, $u['id'], is_string($in['password'] ?? null) ? $in['password'] : '');
            // Le altre sessioni aperte decadono; questa resta valida
            sign_in($u, cw_find_user($db, $u['username'])['pass_hash']);
            out(200, ['ok' => true]);

        case 'delete_account':
            require_post($method);
            $u = require_user($db, $cfg);
            check_current_password($db, $cfg, $u, $in['current'] ?? null);
            cw_delete_user($db, $u['id']);
            $_SESSION = [];
            session_destroy();
            setcookie('cwsess', '', ['expires' => time() - 3600] + $cookieOpts);
            out(200, ['ok' => true]);

        case 'stats':
            $u = require_user($db, $cfg);
            $days = max(0, min(3650, (int)($_GET['days'] ?? 30)));
            // getTimezoneOffset del browser: minuti da sommare all’ora locale per ottenere UTC
            $off = -max(-900, min(900, (int)($_GET['tz'] ?? 0))) * 60;
            $dayOf = function (int $ms) use ($off): int {
                return intdiv(intdiv($ms, 1000) + $off, 86400);
            };
            $since = $days > 0 ? (time() - $days * 86400) * 1000 : 0;

            $st = $db->prepare('SELECT ts, wpm, eff, errors, total, sent, typed FROM results WHERE user_id = ? AND ts >= ? ORDER BY ts');
            $st->execute([$u['id'], $since]);
            $byDay = [];
            $chars = [];
            $conf = [];
            $sum = ['sessions' => 0, 'chars' => 0, 'errors' => 0];
            foreach ($st as $r) {
                $day = $dayOf((int)$r['ts']);
                $b = $byDay[$day] ?? ['n' => 0, 'total' => 0, 'errors' => 0, 'wpm' => 0, 'eff' => 0];
                $err = min((int)$r['errors'], (int)$r['total']);
                $b['n']++;
                $b['total'] += (int)$r['total'];
                $b['errors'] += $err;
                $b['wpm'] = max($b['wpm'], (int)$r['wpm']);
                $b['eff'] = max($b['eff'], (int)$r['eff']);
                $byDay[$day] = $b;
                $sum['sessions']++;
                $sum['chars'] += (int)$r['total'];
                $sum['errors'] += $err;

                $sg = groups_of((string)$r['sent']);
                $tg = groups_of((string)$r['typed']);
                foreach ($sg as $k => $g) {
                    $a = array_slice(cw_split($g), 0, 10);
                    // "_" = gruppo saltato per intero nella trascrizione continua
                    $typedG = $tg[$k] ?? '';
                    $t = array_slice(cw_split($typedG === '_' ? '' : $typedG), 0, 20);
                    foreach (align_chars($a, $t) as [$sc, $tc]) {
                        if ($sc === null) {
                            continue;
                        }
                        $chars[$sc] = $chars[$sc] ?? ['n' => 0, 'err' => 0];
                        $chars[$sc]['n']++;
                        if ($tc !== $sc) {
                            $chars[$sc]['err']++;
                            if ($tc !== null) {
                                $key = $sc . "\x1f" . $tc;
                                $conf[$key] = ($conf[$key] ?? 0) + 1;
                            }
                        }
                    }
                }
            }

            // Riconoscimento rapido: precisione e tempi di risposta. I tempi contano solo le
            // risposte giuste date toccando; oltre 10 s era una distrazione, non un'esitazione
            $st = $db->prepare('SELECT ts, ch, ans, ms FROM instant WHERE user_id = ? AND ts >= ? ORDER BY ts');
            $st->execute([$u['id'], $since]);
            $iDays = [];
            $iChars = [];
            $iConf = [];
            $iSum = ['n' => 0, 'ok' => 0, 'ms' => 0, 'msN' => 0];
            foreach ($st as $r) {
                $day = $dayOf((int)$r['ts']);
                $ok = $r['ch'] === $r['ans'];
                $ms = $ok && $r['ms'] !== null && (int)$r['ms'] <= 10000 ? (int)$r['ms'] : null;
                foreach ([&$iDays[$day], &$iChars[$r['ch']], &$iSum] as &$b) {
                    $b = $b ?? ['n' => 0, 'ok' => 0, 'ms' => 0, 'msN' => 0];
                    $b['n']++;
                    $b['ok'] += $ok ? 1 : 0;
                    if ($ms !== null) {
                        $b['ms'] += $ms;
                        $b['msN']++;
                    }
                }
                unset($b);
                if (!$ok) {
                    $key = $r['ch'] . "\x1f" . $r['ans'];
                    $iConf[$key] = ($iConf[$key] ?? 0) + 1;
                }
            }
            $avg = function (array $b): ?int {
                return $b['msN'] ? (int)round($b['ms'] / $b['msN']) : null;
            };
            $acc = function (array $b): int {
                return $b['n'] ? (int)round($b['ok'] / $b['n'] * 100) : 0;
            };
            ksort($iDays);
            $instant = [
                'summary' => ['answers' => $iSum['n'], 'acc' => $acc($iSum), 'ms' => $avg($iSum), 'activeDays' => count($iDays)],
                'days' => [],
                'chars' => [],
                'confusions' => [],
            ];
            foreach ($iDays as $day => $b) {
                $instant['days'][] = ['day' => gmdate('Y-m-d', $day * 86400), 'n' => $b['n'], 'acc' => $acc($b), 'ms' => $avg($b)];
            }
            foreach ($iChars as $c => $b) {
                $instant['chars'][] = ['c' => (string)$c, 'n' => $b['n'], 'err' => $b['n'] - $b['ok'], 'ms' => $avg($b)];
            }
            arsort($iConf);
            foreach (array_slice($iConf, 0, 10, true) as $key => $n) {
                [$sc, $tc] = explode("\x1f", (string)$key);
                $instant['confusions'][] = ['s' => $sc, 't' => $tc, 'n' => $n];
            }

            // Giorni di fila con almeno una sessione (gruppi o rapido), contando fino a oggi (o ieri)
            $active = [];
            foreach (['results', 'instant'] as $table) {
                $st = $db->prepare("SELECT ts FROM $table WHERE user_id = ?");
                $st->execute([$u['id']]);
                foreach ($st as $r) {
                    $active[$dayOf((int)$r['ts'])] = true;
                }
            }
            $today = $dayOf(time() * 1000);
            $streak = 0;
            $d = isset($active[$today]) ? $today : $today - 1;
            while (isset($active[$d])) {
                $streak++;
                $d--;
            }

            $daysOut = [];
            foreach ($byDay as $day => $b) {
                $daysOut[] = [
                    'day' => gmdate('Y-m-d', $day * 86400),
                    'n' => $b['n'],
                    'acc' => $b['total'] ? (int)round((1 - $b['errors'] / $b['total']) * 100) : 0,
                    'wpm' => $b['wpm'],
                    'eff' => $b['eff'],
                ];
            }
            $charsOut = [];
            foreach ($chars as $c => $v) {
                $charsOut[] = ['c' => (string)$c, 'n' => $v['n'], 'err' => $v['err']];
            }
            arsort($conf);
            $confOut = [];
            foreach (array_slice($conf, 0, 10, true) as $key => $n) {
                [$sc, $tc] = explode("\x1f", (string)$key);
                $confOut[] = ['s' => $sc, 't' => $tc, 'n' => $n];
            }
            out(200, [
                'summary' => [
                    'sessions' => $sum['sessions'],
                    'chars' => $sum['chars'],
                    'acc' => $sum['chars'] ? (int)round((1 - $sum['errors'] / $sum['chars']) * 100) : 0,
                    'activeDays' => count($byDay),
                    'streak' => $streak,
                ],
                'days' => $daysOut,
                'chars' => $charsOut,
                'confusions' => $confOut,
                'instant' => $instant,
            ]);

        default:
            out(404, ['error' => 'Azione sconosciuta.']);
    }
} catch (CwError $e) {
    if (isset($db) && $db->inTransaction()) {
        $db->rollBack();
    }
    out($e->status, ['error' => $e->getMessage()]);
} catch (Throwable $e) {
    if (isset($db) && $db->inTransaction()) {
        $db->rollBack();
    }
    error_log('[cw-trainer] ' . $e->getMessage());
    out(500, ['error' => 'Errore del server.']);
}
