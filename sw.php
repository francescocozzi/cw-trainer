<?php
declare(strict_types=1);

// Service worker dell'app. È generato da PHP solo per calcolare la versione:
// l'impronta dei file statici cambia a ogni aggiornamento caricato sul server,
// e il browser scarica da solo la nuova versione senza toccare questo file.
ini_set('display_errors', '0');
ini_set('log_errors', '1');

header('Content-Type: application/javascript; charset=utf-8');
header('Cache-Control: no-cache');
header('X-Content-Type-Options: nosniff');

$files = ['index.html', 'app.js', 'theme.js', 'manifest.webmanifest',
    'icon-180.png', 'icon-192.png', 'icon-512.png', 'ari-logo-144.png', 'ari-logo-notte-144.png'];
foreach (glob(__DIR__ . '/fonts/*.woff2') ?: [] as $f) {
    $files[] = 'fonts/' . basename($f);
}
$files = array_values(array_filter($files, fn($f) => is_file(__DIR__ . '/' . $f)));
$hash = '';
foreach ($files as $f) {
    $hash .= sha1_file(__DIR__ . '/' . $f);
}
$version = substr(sha1($hash), 0, 12);
?>
"use strict";
// Versione <?= $version ?> (generata da sw.php)
const CACHE = "cw-<?= $version ?>";
const FILES = <?= json_encode(array_merge(['./'], $files), JSON_UNESCAPED_SLASHES) ?>;

// Una versione nuova si installa per intero o per niente: pagina e script restano sempre allineati
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(FILES.map(f => new Request(f, { cache: "reload" }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith("cw-") && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// File statici dalla cache, subito. api.php e tutto il resto passano sempre dalla rete.
self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url), scope = new URL(self.registration.scope);
  if (req.method !== "GET" || url.origin !== scope.origin) return;
  if (req.mode === "navigate") {
    if (url.pathname !== scope.pathname && url.pathname !== scope.pathname + "index.html") return;
    e.respondWith(caches.match("./", { cacheName: CACHE }).then(r => r || fetch(req)));
    return;
  }
  const path = url.pathname.slice(scope.pathname.length);
  if (!FILES.includes(path)) return;
  e.respondWith(caches.match(path, { cacheName: CACHE }).then(r => r || fetch(req)));
});
