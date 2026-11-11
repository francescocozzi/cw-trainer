"use strict";
const MORSE = {A:".-",B:"-...",C:"-.-.",D:"-..",E:".",F:"..-.",G:"--.",H:"....",I:"..",J:".---",K:"-.-",L:".-..",M:"--",N:"-.",O:"---",P:".--.",Q:"--.-",R:".-.",S:"...",T:"-",U:"..-",V:"...-",W:".--",X:"-..-",Y:"-.--",Z:"--..","0":"-----","1":".----","2":"..---","3":"...--","4":"....-","5":".....","6":"-....","7":"--...","8":"---..","9":"----.",".":".-.-.-",",":"--..--","?":"..--..","/":"-..-.","=":"-...-",
  "!":"-.-.--","\"":".-..-.","'":".----.","(":"-.--.",")":"-.--.-","+":".-.-.","-":"-....-",":":"---...",";":"-.-.-.","@":".--.-.","À":".--.-","Ä":".-.-","Æ":".-.-","Å":".--.-","Ç":"-.-..","É":"..-..","È":".-..-","Ñ":"--.--","Ö":"---.","Ø":"---.","Ü":"..--"};
const KOCH = "KMURESNAPTLWI.JZ=FOY,VG5/Q92H38B?47C1D60X".split("");
const EXTRAS = "!\"'()+-:;@ÀÄÆÅÇÉÈÑÖØÜ".split("");
const ALL = [...KOCH, ...EXTRAS];
// Ordine dei pulsanti nelle impostazioni: lettere in ordine alfabetico, poi cifre, poi segni
const rankChar = c => /\p{L}/u.test(c) ? 0 : /\d/.test(c) ? 1 : 2;
const alpha = list => [...list].sort((a, b) => rankChar(a) - rankChar(b) || a.localeCompare(b, "it"));
const GROUPS = {
  letters: "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""),
  numbers: "0123456789".split(""),
  koch: KOCH, extras: EXTRAS
};

const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));

const DEFAULTS = { chars: "KMURES", sets: [], wpm: 20, eff: 12, extra: 0, freq: 600, randTone: false, vol: 60, pre: true, delay: 3, glen: 5, randLen: false, mins: 5, mode: "custom", noSpace: false };
const S = JSON.parse(JSON.stringify(DEFAULTS));
let history = [];
const $ = id => document.getElementById(id);
const selectedChars = () => ALL.filter(c => S.chars.includes(c));
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(t._h); t._h = setTimeout(() => { t.hidden = true; }, 3500);
}

/* ---------- Server ---------- */
let regAllowed = false, regMode = false, saveTimer = null;
async function api(action, body, params) {
  let r;
  try {
    r = await fetch(`api.php?action=${encodeURIComponent(action)}${params ? "&" + new URLSearchParams(params) : ""}`, {
      method: body ? "POST" : "GET",
      credentials: "same-origin",
      headers: Object.assign({ "X-Requested-With": "cw" }, body ? { "Content-Type": "application/json" } : {}),
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (e) { throw new Error(navigator.onLine ? "Server non raggiungibile" : "Sei offline: serve la connessione per accedere e salvare i risultati"); }
  let data = {};
  try { data = await r.json(); } catch (e) {}
  if (typeof data.registration === "boolean") regAllowed = data.registration;
  if (r.status === 401 && !["me", "login", "register"].includes(action)) showLogin(true);
  if (!r.ok) { const err = new Error(data.error || `Errore ${r.status}`); err.status = r.status; throw err; }
  return data;
}
// Le impostazioni si salvano sul server poco dopo l’ultima modifica
const saveS = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api("settings", { settings: S }).catch(e => toast("Impostazioni non salvate: " + e.message)), 700);
};
function activeChars() {
  const m = S.mode || "custom";
  if (m === "letters") return GROUPS.letters;
  if (m === "numbers") return GROUPS.numbers;
  if (m === "mixed") return [...GROUPS.letters, ...GROUPS.numbers];
  if (m.startsWith("set:")) { const s = S.sets.find(x => x.name === m.slice(4)); if (s) return ALL.filter(c => s.chars.includes(c)); }
  return selectedChars();
}

/* ---------- Audio ---------- */
let ctx = null, current = null, wakeLock = null;
function ensureCtx() {
  if (!ctx) {
    try { if (navigator.audioSession) navigator.audioSession.type = voiceOn() ? "play-and-record" : "playback"; } catch (e) {}
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    // Molte cuffie USB-C spengono l'amplificatore dopo pochi istanti di silenzio digitale
    // e lo riaccendono in ritardo: il primo segno dopo una pausa va perso. Un 20 Hz a -60 dB
    // (sotto la soglia udibile a quella frequenza) tiene il convertitore sempre acceso.
    const ka = ctx.createOscillator(), kg = ctx.createGain();
    ka.frequency.value = 20; kg.gain.value = 0.001;
    ka.connect(kg).connect(ctx.destination);
    ka.start();
  }
  if (ctx.state === "suspended" || ctx.state === "interrupted") ctx.resume();
  return ctx;
}
const pickFreq = () => S.randTone ? 500 + Math.round(Math.random() * 40) * 10 : S.freq;
function timing(o) {
  const u = 1.2 / o.wpm;
  let cs = 3 * u, ws = 7 * u;
  if (o.eff < o.wpm) {
    const ta = (60 * o.wpm - 37.2 * o.eff) / (o.eff * o.wpm);
    cs = 3 * ta / 19; ws = 7 * ta / 19;
  }
  ws += (o.extra || 0) * ws;
  return { u, cs, ws };
}
function walk(text, o, onTone) {
  const { u, cs, ws } = timing(o);
  let t = 0;
  for (const ch of text) {
    if (ch === " ") { t += ws - cs; continue; }
    const code = MORSE[ch]; if (!code) continue;
    for (let i = 0; i < code.length; i++) {
      const d = code[i] === "." ? u : 3 * u;
      if (onTone) onTone(t, d);
      t += d; if (i < code.length - 1) t += u;
    }
    t += cs;
  }
  return t;
}
// o: { wpm, eff, extra, delay, freq }
function play(text, onEnd, opt = {}) {
  stop();
  const o = Object.assign({ wpm: S.wpm, eff: S.wpm, extra: 0, delay: 0, freq: pickFreq() }, opt);
  const c = ensureCtx();
  const osc = c.createOscillator(), g = c.createGain();
  osc.type = "sine"; osc.frequency.value = o.freq;
  g.gain.value = 0;
  osc.connect(g).connect(c.destination);
  // Al primo avvio il convertitore della cuffia ha appena ricevuto segnale: più margine
  const t0 = c.currentTime + (c.currentTime < 1 ? 0.6 : 0.15) + o.delay, r = 0.005, peak = (S.vol / 100) * 0.8;
  const tones = [];
  const total = walk(text, o, (t, d) => tones.push([t, d]));
  // Gli inviluppi si programmano a finestre di 1,5 s: con migliaia di eventi sullo stesso
  // AudioParam il thread audio perde blocchi e i toni escono troncati (soprattutto su iOS).
  let i = 0;
  const pump = () => {
    const horizon = c.currentTime + 1.5;
    for (; i < tones.length && t0 + tones[i][0] < horizon; i++) {
      const a = t0 + tones[i][0], d = tones[i][1];
      g.gain.setValueAtTime(0, a);
      g.gain.linearRampToValueAtTime(peak, a + r);
      g.gain.setValueAtTime(peak, a + d - r);
      g.gain.linearRampToValueAtTime(0, a + d);
    }
    if (i >= tones.length) clearInterval(me.timer);
  };
  osc.start(c.currentTime); osc.stop(t0 + total + 0.05);
  const me = { osc, start: c.currentTime, end: t0 + total, timer: setInterval(pump, 250) };
  pump();
  osc.onended = () => { clearInterval(me.timer); if (current === me) { current = null; onEnd && onEnd(); } };
  current = me;
}
function stop() {
  if (current) { const o = current.osc; clearInterval(current.timer); current = null; o.onended = null; try { o.stop(); } catch (e) {} }
}
async function keepAwake(on) {
  try {
    if (on && "wakeLock" in navigator && !wakeLock) wakeLock = await navigator.wakeLock.request("screen");
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) {}
}

/* ---------- Esercizio ---------- */
const randChar = set => set[Math.floor(Math.random() * set.length)];
const sessionOpts = () => ({ wpm: S.wpm, eff: S.eff, extra: S.extra });
function genGroups() {
  const set = activeChars(), groups = [], target = S.mins * 60;
  while (groups.length < 400) {
    const len = S.randLen ? 2 + Math.floor(Math.random() * 6) : S.glen;
    let g = ""; for (let i = 0; i < len; i++) g += randChar(set);
    groups.push(g);
    if (walk(groups.join(" "), sessionOpts()) >= target) break;
  }
  return groups;
}
function renderSet() {
  const opts = [["custom", "Caratteri custom"], ["letters", "Lettere"], ["numbers", "Cifre"], ["mixed", "Lettere e cifre"]].concat(S.sets.map(s => ["set:" + s.name, "Set: " + s.name]));
  if (!opts.some(o => o[0] === S.mode)) S.mode = "custom";
  $("mode").innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}"${v === S.mode ? " selected" : ""}>${esc(l)}</option>`).join("");
  $("dur").innerHTML = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(m => `<option value="${m}"${m === S.mins ? " selected" : ""}>${m} min</option>`).join("");
  $("durTitle").textContent = `(${S.mins} min)`;
  const set = activeChars();
  $("charset").textContent = set.length ? alpha(set).join(" ") : "Nessun carattere custom selezionato: tocca «Cambia»";
  const tone = S.randTone ? "casuale" : S.freq + " Hz";
  $("params").innerHTML = `Velocità carattere <b>${S.wpm} WPM</b>, effettiva <b>${S.eff} WPM</b>, tono <b>${tone}</b>, ritardo <b>${S.delay} s</b>. <button class="lnk" id="chg">Cambia</button>`;
  const btn = c => `<button data-c="${esc(c)}" aria-pressed="${S.chars.includes(c)}">${esc(c)}</button>`;
  $("picker").innerHTML = alpha(KOCH).map(btn).join("");
  $("pickerX").innerHTML = alpha(EXTRAS).map(btn).join("");
  $("saved").innerHTML = S.sets.map((s, i) => `<button data-i="${i}" aria-pressed="${s.chars === S.chars}">${esc(s.name)}<span data-del="${i}" aria-label="Elimina set">×</span></button>`).join("");
  $("speedTag").textContent = S.eff < S.wpm ? `${S.wpm}/${S.eff} WPM` : `${S.wpm} WPM`;
  renderKeys();
}
function setChars(str) {
  S.chars = ALL.filter(c => str.includes(c)).join(""); S.mode = "custom"; saveS();
  renderSet(); $("results").hidden = true;
}
function toggleChar(c) { setChars(S.chars.includes(c) ? [...S.chars].filter(x => x !== c).join("") : S.chars + c); }
["picker", "pickerX"].forEach(id => $(id).addEventListener("click", e => {
  const b = e.target.closest("button"); if (b) toggleChar(b.dataset.c);
}));
document.querySelectorAll("[data-q]").forEach(b => b.onclick = () => {
  const q = b.dataset.q;
  if (q === "none") return setChars("");
  const g = GROUPS[q], has = g.every(c => S.chars.includes(c));
  setChars(has ? [...S.chars].filter(c => !g.includes(c)).join("") : S.chars + g.join(""));
});
$("hearSet").onclick = () => { const s = selectedChars(); if (s.length) play(s.join(" ")); };
$("saveSet").onclick = () => {
  if (!S.chars) return;
  const name = (prompt("Nome del set", S.chars.slice(0, 12)) || "").trim(); if (!name) return;
  S.sets = S.sets.filter(s => s.name !== name); S.sets.push({ name, chars: S.chars });
  saveS(); renderSet();
};
$("saved").addEventListener("click", e => {
  const del = e.target.closest("[data-del]");
  if (del) {
    const i = +del.dataset.del;
    if (confirm(`Eliminare il set «${S.sets[i].name}»?`)) { S.sets.splice(i, 1); saveS(); renderSet(); }
    return;
  }
  const b = e.target.closest("button"); if (b) setChars(S.sets[+b.dataset.i].chars);
});
$("params").addEventListener("click", e => { if (e.target.id === "chg") showView("settings"); });
$("mode").addEventListener("change", e => { S.mode = e.target.value; saveS(); renderSet(); newExercise(); });
$("dur").addEventListener("change", e => { S.mins = +e.target.value; saveS(); renderSet(); newExercise(); });
$("newBtn").onclick = () => newExercise();

// sess: "idle" (da generare), "playing", "paused", "done" (già ascoltato, Play lo ripete)
let sent = [], sess = "idle", ticker = null;
const ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v16l13-8z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>';
const fmt = s => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
const sessionText = () => (S.pre ? "VVV = " : "") + sent.join(" ") + (S.pre ? " +" : "");
function setStatus(txt, live) { const el = $("status"); el.textContent = txt; el.classList.toggle("live", !!live); }
function setPP(playing) { $("ppBtn").innerHTML = playing ? ICON_PAUSE : ICON_PLAY; $("ppBtn").setAttribute("aria-label", playing ? "Pausa" : "Play"); }
function tick() {
  if (!current || !ctx) return;
  const el = ctx.currentTime - current.start, tot = current.end - current.start;
  $("bar").style.width = Math.min(100, el / tot * 100) + "%";
  $("tNow").textContent = fmt(el); $("tTot").textContent = fmt(tot);
  if (sess === "playing" && el >= S.delay + 0.15) setStatus(`In trasmissione: ${sent.length} gruppi`, true);
}
function halt() {
  stop(); clearInterval(ticker); keepAwake(false);
  if (ctx && ctx.state === "suspended") ctx.resume();
  setPP(false);
}
function newExercise() {
  halt(); sess = "idle"; sent = [];
  $("answer").value = ""; $("results").hidden = true; $("checkBtn").disabled = true;
  $("bar").style.width = "0"; $("tNow").textContent = "0:00"; $("tTot").textContent = fmt(S.mins * 60);
  setStatus(activeChars().length ? "Premi Play e trascrivi i gruppi" : "Nessun carattere custom selezionato: tocca «Cambia»", false);
}
$("ppBtn").onclick = () => {
  if ((sess === "playing" || sess === "paused") && !current) sess = "done"; // audio interrotto da un altro ascolto
  if (sess === "playing") { ensureCtx().suspend(); sess = "paused"; setPP(false); setStatus("In pausa", false); keepAwake(false); return; }
  if (sess === "paused") { ensureCtx().resume(); sess = "playing"; setPP(true); keepAwake(true); tick(); return; }
  if (!activeChars().length) { setStatus("Nessun carattere custom selezionato: tocca «Cambia»", false); return; }
  if (sess === "idle") { sent = genGroups(); $("answer").value = ""; $("results").hidden = true; }
  sess = "playing"; setPP(true); $("checkBtn").disabled = false;
  setStatus(S.delay ? `Inizio tra ${S.delay} s` : `In trasmissione: ${sent.length} gruppi`, !S.delay);
  play(sessionText(), () => {
    sess = "done"; clearInterval(ticker); setPP(false); keepAwake(false);
    $("bar").style.width = "100%"; $("tNow").textContent = $("tTot").textContent;
    setStatus("Fine trasmissione. Completa e premi «Controlla risultato».", false);
  }, Object.assign(sessionOpts(), { delay: S.delay }));
  keepAwake(true);
  clearInterval(ticker); ticker = setInterval(tick, 250); tick();
  $("answer").focus({ preventScroll: true });
};

function lev(a, b) {
  a = [...a]; b = [...b];
  const m = a.length, n = b.length, d = Array.from({ length: m + 1 }, (_, i) => [i]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}
// Gruppo saltato per intero nella trascrizione continua: tiene il posto, così i gruppi
// successivi restano allineati anche nello storico e nelle statistiche
const MISSING = "_";
const typedOf = g => g === MISSING ? "" : g || "";
// Trascrizione continua: allinea carattere per carattere tutto il testo scritto con quello
// trasmesso e lo ridivide nei gruppi trasmessi. Un carattere perso o in più resta un errore
// solo nel suo gruppo, invece di spostare tutti quelli dopo.
function splitStream(text, sentG) {
  const a = [], grp = [];
  sentG.forEach((g, k) => { for (const c of g) { a.push(c); grp.push(k); } });
  const b = [...text.replace(/\s+/g, "")];
  const m = a.length, n = b.length, W = n + 1, d = new Int32Array((m + 1) * W);
  for (let i = 0; i <= m; i++) d[i * W] = i;
  for (let j = 0; j <= n; j++) d[j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    d[i * W + j] = Math.min(d[(i - 1) * W + j] + 1, d[i * W + j - 1] + 1, d[(i - 1) * W + j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  // Dalla fine all'inizio: ogni carattere scritto va nel gruppo del carattere trasmesso a cui
  // corrisponde; uno in più va nel gruppo del carattere trasmesso che lo precede
  const out = sentG.map(() => "");
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i * W + j] === d[(i - 1) * W + j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)) { out[grp[--i]] = b[--j] + out[grp[i]]; }
    else if (i > 0 && d[i * W + j] === d[(i - 1) * W + j] + 1) i--;
    else { j--; out[i > 0 ? grp[i - 1] : 0] = b[j] + out[i > 0 ? grp[i - 1] : 0]; }
  }
  return out.map(g => g || MISSING);
}
// iOS sostituisce virgolette e trattini con quelli tipografici: li riportiamo a quelli semplici
const normalize = s => s.toUpperCase().replace(/[“”„«»]/g, "\"").replace(/[‘’‚]/g, "'").replace(/[–—]/g, "-");

$("checkBtn").onclick = () => {
  if (!sent.length) return;
  halt(); sess = "idle";
  setStatus("Esercizio controllato. Premi Play per uno nuovo.", false);
  const raw = normalize($("answer").value);
  const typed = S.noSpace ? splitStream(raw, sent) : raw.trim().split(/\s+/).filter(Boolean);
  let errs = 0, total = 0, html = "";
  const n = Math.max(sent.length, typed.length);
  for (let i = 0; i < n; i++) {
    const s = sent[i] || "", t = typedOf(typed[i]);
    const e = lev(s, t); errs += e; total += [...s].length;
    const sc = [...s];
    const tHtml = [...t].map((c, k) => c === sc[k] ? esc(c) : `<b>${esc(c)}</b>`).join("") || "—";
    html += `<div class="g${e ? " bad" : ""}"><span class="s">${esc(s) || "(in più)"}</span><span class="t">${tHtml}</span></div>`;
  }
  const acc = Math.max(0, Math.round((1 - errs / Math.max(1, total)) * 100));
  $("groups").innerHTML = html;
  const sc = $("score"); sc.textContent = acc + "%"; sc.className = "score " + (acc >= 90 ? "good" : "bad");
  $("scoreNote").textContent = `${errs} errori su ${total} caratteri`;
  $("results").hidden = false;
  const entry = { d: Date.now(), s: activeChars().join(""), a: acc, w: S.wpm, e: S.eff, errors: errs, total, sent: sent.join(" "), typed: typed.join(" ") };
  history.unshift(entry); history = history.slice(0, 50); renderHist();
  api("result", entry).catch(e => toast("Risultato non salvato: " + e.message));
  sent = []; $("checkBtn").disabled = true;
  $("results").scrollIntoView({ behavior: "smooth", block: "start" });
};

function renderHist() {
  $("histPanel").hidden = !history.length;
  $("hist").innerHTML = history.slice(0, 10).map(h => {
    const d = new Date(h.d).toLocaleString("it-IT", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    const set = h.s ? (h.s.length > 12 ? h.s.slice(0, 12) + "…" : h.s) : "lezione " + h.l;
    return `<li><span>${d}, ${esc(set)}, ${h.w}/${h.e} WPM</span><b style="color:var(${h.a >= 90 ? "--ok" : "--err"})">${h.a}%</b></li>`;
  }).join("");
}

/* ---------- Rapido ---------- */
let target = null, cOk = 0, cBad = 0, busy = false, charFreq = 600, nextTimer = 0;
function renderKeys() {
  $("keys").innerHTML = activeChars().map(c => `<button data-c="${esc(c)}">${esc(c)}</button>`).join("");
}
const playTarget = listen => play(target, listen && voiceOn() ? listenAnswer : null, { freq: charFreq });
function nextChar() {
  stopListen();
  const set = activeChars();
  if (!set.length) { stopInstant(); $("bigCh").textContent = "—"; return; }
  target = randChar(set); busy = false; charFreq = pickFreq();
  $("bigCh").textContent = "?"; $("bigCh").className = "big";
  playTarget(true);
}
// Lo stesso pulsante avvia e ferma: fermando si interrompono tono, ascolto e carattere successivo
function stopInstant() {
  clearTimeout(nextTimer); stopListen(); stop();
  target = null; busy = false;
  $("bigCh").textContent = "?"; $("bigCh").className = "big";
  $("keys").querySelectorAll(".ok,.bad").forEach(b => b.classList.remove("ok", "bad"));
  $("instReplay").disabled = true; $("instStart").textContent = "Inizia";
}
$("instStart").onclick = () => {
  if (target) { stopInstant(); return; }
  cOk = cBad = 0; updCounters(); $("instReplay").disabled = false; $("instStart").textContent = "Ferma"; nextChar();
};
$("instReplay").onclick = () => { if (target && !busy) { stopListen(); playTarget(true); } };
function updCounters() { $("cOk").textContent = `${cOk} giusti`; $("cBad").textContent = `${cBad} errori`; }
function answer(c) {
  if (!target || busy) return;
  busy = true; stopListen();
  const ok = c === target, b = $("keys").querySelector(`button[data-c="${CSS.escape(c)}"]`);
  if (b) b.classList.add(ok ? "ok" : "bad");
  $("bigCh").textContent = target; $("bigCh").className = "big " + (ok ? "ok" : "bad");
  if (ok) cOk++; else { cBad++; playTarget(false); }
  updCounters();
  nextTimer = setTimeout(() => { if (b) b.classList.remove("ok", "bad"); nextChar(); }, ok ? 450 : 1300);
}
$("keys").addEventListener("click", e => { const b = e.target.closest("button"); if (b) answer(b.dataset.c); });

/* ---------- Risposta a voce (solo Rapido) ---------- */
// Alfabeto NATO, alfabeto italiano e cifre in italiano e in inglese, con le varianti che i
// riconoscitori restituiscono più spesso. Le chiavi sono senza accenti, spazi e trattini.
const SPOKEN = {
  A: "alfa alpha ancona", B: "bravo bari bologna", C: "charlie charly como", D: "delta domodossola",
  E: "echo eco empoli", F: "foxtrot fox firenze", G: "golf genova", H: "hotel acca",
  I: "india imola", J: "juliett juliet giulietta jolly ilunga", K: "kilo chilo kappa", L: "lima livorno",
  M: "mike maik milano", N: "november napoli", O: "oscar otranto", P: "papa padova palermo",
  Q: "quebec quarto", R: "romeo roma", S: "sierra savona sassari", T: "tango torino",
  U: "uniform udine", V: "victor viktor venezia", W: "whiskey whisky washington vudoppia doppiavu",
  X: "xray icsrei exray ics xeres", Y: "yankee york ipsilon", Z: "zulu zara zeta",
  0: "zero", 1: "uno one", 2: "due two", 3: "tre three tree", 4: "quattro four", 5: "cinque five",
  6: "sei six", 7: "sette seven", 8: "otto eight", 9: "nove nine niner"
};
const SPOKEN_MAP = {};
for (const c in SPOKEN) for (const w of SPOKEN[c].split(" ")) SPOKEN_MAP[w] = String(c);
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const norm = t => t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
// Da una trascrizione al carattere: prima la frase intera ("fox trot", "x ray"), poi parola per parola
function spokenChar(text) {
  const words = norm(text).split(/[^a-z0-9]+/).filter(Boolean);
  for (const w of [words.join(""), ...words]) if (SPOKEN_MAP[w]) return SPOKEN_MAP[w];
  // Una lettera o cifra isolata vale solo se è tutta la risposta: "è la B" non deve dare E
  return words.length === 1 && /^[a-z0-9]$/.test(words[0]) ? words[0].toUpperCase() : null;
}
let rec = null, noSpeech = 0;
const voiceOn = () => !!SR && $("voiceSw").checked;
function setHeard(text, listening) { $("heard").textContent = text; $("heard").classList.toggle("on", !!listening); }
function stopListen() {
  if (rec) { const r = rec; rec = null; r.onresult = r.onerror = r.onend = null; try { r.abort(); } catch (e) {} }
  setHeard("", false);
}
function listenAnswer() {
  if (!voiceOn() || !target || busy || $("v-instant").hidden) return;
  stopListen();
  const r = rec = new SR();
  r.lang = "it-IT"; r.interimResults = false; r.continuous = false; r.maxAlternatives = 5;
  let done = false;
  r.onresult = e => {
    done = true;
    const alts = [...e.results[0]].map(a => a.transcript);
    const chars = alts.map(spokenChar).filter(Boolean);
    // Fra le ipotesi preferisce un carattere che compare nell'esercizio
    const set = activeChars(), c = chars.find(x => set.includes(x)) || chars[0];
    noSpeech = 0;
    if (!c) { rec = null; setHeard(`Sentito «${alts[0]}»: non lo riconosco, ripeti`, false); setTimeout(() => { if (!rec) listenAnswer(); }, 900); return; }
    rec = null; setHeard(`Sentito: ${alts[0]}`, false);
    answer(c);
  };
  r.onerror = e => {
    done = true; rec = null;
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      $("voiceSw").checked = false; saveVoice(); setHeard("", false);
      toast("Microfono o riconoscimento vocale non autorizzati nelle impostazioni del browser");
    } else if (e.error === "no-speech" && ++noSpeech < 3) listenAnswer();
    else setHeard("Non ti sento: tocca Ripeti", false);
  };
  r.onend = () => { if (!done && rec === r) { rec = null; listenAnswer(); } };
  try { r.start(); setHeard("In ascolto…", true); } catch (e) { rec = null; setHeard("", false); }
}
function saveVoice() {
  try { localStorage.setItem("cw-voice", $("voiceSw").checked ? "1" : ""); } catch (e) {}
  // Su iOS la sessione audio deve ammettere il microfono, altrimenti la registrazione non parte
  try { if (navigator.audioSession) navigator.audioSession.type = $("voiceSw").checked ? "play-and-record" : "playback"; } catch (e) {}
}
if (SR) {
  $("voiceBox").hidden = false;
  try { $("voiceSw").checked = localStorage.getItem("cw-voice") === "1"; } catch (e) {}
  $("voiceSw").addEventListener("change", async () => {
    saveVoice();
    if (!$("voiceSw").checked) { stopListen(); return; }
    // Chiede il permesso del microfono adesso, durante il tocco: dopo il browser potrebbe non mostrarlo
    try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach(t => t.stop()); }
    catch (e) { $("voiceSw").checked = false; saveVoice(); toast("Senza il permesso del microfono la risposta a voce non funziona"); return; }
    if (target && !busy) listenAnswer();
  });
}

/* ---------- Impostazioni ---------- */
const fields = {
  wpm: ["sWpm", "oWpm", v => v + " WPM"], eff: ["sEff", "oEff", v => v + " WPM"],
  extra: ["sExtra", "oExtra", v => String(v)], freq: ["sFreq", "oFreq", v => v + " Hz"],
  vol: ["sVol", "oVol", v => v + "%"], delay: ["sDelay", "oDelay", v => v + " s"],
  glen: ["sGlen", "oGlen", v => v + (v == 1 ? " carattere" : " caratteri")]
};
const toggles = { randTone: "sRandTone", pre: "sPre", randLen: "sRandLen", noSpace: "sNoSpace" };
function syncSettings() {
  if (S.eff > S.wpm) S.eff = S.wpm;
  for (const k in fields) { const [i, o, f] = fields[k]; $(i).value = S[k]; $(o).textContent = f(S[k]); }
  for (const k in toggles) $(toggles[k]).checked = !!S[k];
  $("sEff").max = S.wpm;
  $("answer").placeholder = S.noSpace ? "Scrivi qui di seguito, senza spazi" : "Scrivi qui, gruppi separati da spazio";
  $("sFreq").disabled = S.randTone; $("oFreq").textContent = S.randTone ? "casuale" : S.freq + " Hz";
  $("sGlen").disabled = S.randLen; $("oGlen").textContent = S.randLen ? "2–7" : fields.glen[2](S.glen);
}
for (const k in fields) $(fields[k][0]).addEventListener("input", e => { S[k] = +e.target.value; syncSettings(); saveS(); renderSet(); });
for (const k in toggles) $(toggles[k]).addEventListener("change", e => { S[k] = e.target.checked; syncSettings(); saveS(); renderSet(); });
$("sFreq").addEventListener("change", () => play("E E"));
$("sVol").addEventListener("change", () => play("E E"));
$("clearHist").onclick = async () => {
  if (!confirm("Cancellare tutti i risultati salvati?")) return;
  try { await api("clear_history", {}); history = []; renderHist(); toast("Storico cancellato"); }
  catch (e) { toast(e.message); }
};

/* ---------- Tema ---------- */
// "auto" segue il sistema; il pulsante luna alterna la notte con l'ultimo tema diurno scelto
const THEME_BG = { light: "#eef1f5", dark: "#0b1220", night: "#000000" };
const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
let theme = document.documentElement.dataset.theme || "auto", dayTheme = lsGet("cw-theme-day") || "auto";
function setTheme(t) {
  theme = t;
  if (t !== "night") { dayTheme = t; lsSet("cw-theme-day", t); }
  if (t === "auto") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  lsSet("cw-theme", t);
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => {
    m.content = THEME_BG[t] || THEME_BG[m.media.includes("dark") ? "dark" : "light"];
  });
  document.querySelectorAll("#themeSeg button").forEach(b => b.setAttribute("aria-pressed", b.dataset.t === t));
  $("nightBtn").setAttribute("aria-pressed", t === "night");
}
$("themeSeg").addEventListener("click", e => { const b = e.target.closest("button"); if (b) setTheme(b.dataset.t); });
$("nightBtn").onclick = () => setTheme(theme === "night" ? dayTheme : "night");
setTheme(theme);

/* ---------- Navigazione ---------- */
function showView(v) {
  document.querySelectorAll("nav button").forEach(x => x.toggleAttribute("aria-current", x.dataset.view === v));
  document.querySelectorAll("nav button[aria-current]").forEach(x => x.setAttribute("aria-current", "page"));
  VIEWS.forEach(id => { $("v-" + id).hidden = id !== v; });
  if (v !== "instant") stopListen();
  if (v === "stats") loadStats();
  window.scrollTo(0, 0);
}
document.querySelectorAll("nav button").forEach(b => b.onclick = () => showView(b.dataset.view));

/* ---------- Statistiche ---------- */
const VIEWS = ["koch", "instant", "stats", "settings"];
let statsData = null, showAllChars = false, practiceChars = [];
const dayLabel = d => d.slice(8, 10) + "/" + d.slice(5, 7);

function lineChart(el, labels, series, o) {
  if (!labels.length) { el.innerHTML = '<p class="muted">Nessuna sessione nel periodo.</p>'; return; }
  const W = 340, H = 170, L = 30, R = 8, T = 8, B = 22;
  const vals = series.flatMap(s => s.values);
  let min = o.min != null ? o.min : Math.min(...vals), max = o.max != null ? o.max : Math.max(...vals);
  if (max === min) { max += 1; min = Math.max(0, min - 1); }
  const x = i => labels.length === 1 ? (L + W - R) / 2 : L + i * (W - L - R) / (labels.length - 1);
  const y = v => T + (1 - (v - min) / (max - min)) * (H - T - B);
  let g = "";
  [min, (min + max) / 2, max].forEach(v => {
    g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/>`;
    g += `<text x="${L - 6}" y="${y(v) + 3}" text-anchor="end">${Math.round(v)}${o.unit || ""}</text>`;
  });
  if (o.ref != null && o.ref > min && o.ref < max)
    g += `<line x1="${L}" x2="${W - R}" y1="${y(o.ref)}" y2="${y(o.ref)}" stroke="var(--ok)" stroke-width="1.5" stroke-dasharray="4 4"/>`;
  series.forEach(s => {
    const pts = s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
    if (pts.length > 1) g += `<polyline points="${pts.join(" ")}" fill="none" stroke="${s.color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
    if (pts.length <= 40) s.values.forEach((v, i) => { g += `<circle cx="${x(i)}" cy="${y(v)}" r="3.5" fill="${s.color}"/>`; });
  });
  g += `<text x="${x(0)}" y="${H - 4}" text-anchor="${labels.length === 1 ? "middle" : "start"}">${labels[0]}</text>`;
  if (labels.length > 1) g += `<text x="${x(labels.length - 1)}" y="${H - 4}" text-anchor="end">${labels[labels.length - 1]}</text>`;
  const legend = series.length > 1 ? `<div class="legend">${series.map(s => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join("")}</div>` : "";
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.label || "")}">${g}</svg>${legend}`;
}

function compareHTML(sentG, typedG) {
  let html = "";
  for (let i = 0; i < Math.max(sentG.length, typedG.length); i++) {
    const s = sentG[i] || "", t = typedOf(typedG[i]), sc = [...s];
    const bad = lev(s, t) > 0;
    const tHtml = [...t].map((c, k) => c === sc[k] ? esc(c) : `<b>${esc(c)}</b>`).join("") || "—";
    html += `<div class="g${bad ? " bad" : ""}"><span class="s">${esc(s) || "(in più)"}</span><span class="t">${tHtml}</span></div>`;
  }
  return html;
}

async function loadStats() {
  $("stTiles").innerHTML = '<p class="muted">Caricamento…</p>';
  try {
    statsData = await api("stats", undefined, { days: $("stPeriod").value, tz: new Date().getTimezoneOffset() });
    renderStats();
  } catch (e) { $("stTiles").innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}
$("stPeriod").addEventListener("change", loadStats);

function renderStats() {
  const d = statsData; if (!d) return;
  const s = d.summary;
  $("stTiles").innerHTML = [
    [s.sessions, s.sessions === 1 ? "sessione" : "sessioni"],
    [s.sessions ? s.acc + "%" : "—", "precisione"],
    [s.chars.toLocaleString("it-IT"), "caratteri trascritti"],
    [s.streak, s.streak === 1 ? "giorno di fila" : "giorni di fila"]
  ].map(([v, l]) => `<div class="tile"><b>${v}</b><span>${l}</span></div>`).join("");

  const labels = d.days.map(x => dayLabel(x.day));
  const accs = d.days.map(x => x.acc);
  lineChart($("chAcc"), labels, [{ values: accs, color: "var(--accent)", name: "Precisione" }],
    { min: accs.length ? Math.max(0, Math.floor((Math.min(...accs) - 5) / 10) * 10) : 0, max: 100, ref: 90, unit: "%", label: "Precisione giornaliera" });
  lineChart($("chSpeed"), labels, [
    { values: d.days.map(x => x.wpm), color: "var(--accent)", name: "Carattere" },
    { values: d.days.map(x => x.eff), color: "var(--muted)", name: "Effettiva" }
  ], { min: 0, label: "Velocità giornaliera in WPM" });

  const ch = d.chars.filter(c => c.n >= 5)
    .map(c => Object.assign({}, c, { acc: Math.round((1 - c.err / c.n) * 100) }))
    .sort((a, b) => a.acc - b.acc || b.n - a.n);
  const list = showAllChars ? ch : ch.slice(0, 10);
  $("stChars").innerHTML = ch.length
    ? list.map(c => `<div class="crow"><span class="c">${esc(c.c)}</span><span class="b"><i style="width:${c.acc}%;background:var(${c.acc >= 90 ? "--ok" : "--err"})"></i></span><span class="v">${c.acc}% su ${c.n}</span></div>`).join("")
    : '<p class="muted">Ancora pochi dati: fai qualche sessione in più.</p>';
  $("stMore").hidden = ch.length <= 10;
  $("stMore").textContent = showAllChars ? "Mostra meno" : `Mostra tutti (${ch.length})`;
  const weak = ch.filter(c => c.acc < 90);
  practiceChars = (weak.length >= 2 ? weak : ch.slice(0, 5)).map(c => c.c);
  $("stPractice").hidden = practiceChars.length < 2;
  $("stPractice").textContent = `Esercitati su ${practiceChars.join(" ")}`;

  $("stConf").innerHTML = d.confusions.length
    ? d.confusions.map(c => `<li><span><span class="mono">${esc(c.s)}</span> scritto come <span class="mono">${esc(c.t)}</span></span><b>${c.n} ${c.n === 1 ? "volta" : "volte"}</b></li>`).join("")
    : '<li class="muted">Nessuna confusione nel periodo.</li>';

  $("stSessions").innerHTML = history.length ? history.map(h => {
    const date = new Date(h.d).toLocaleString("it-IT", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
    const set = h.s ? (h.s.length > 10 ? h.s.slice(0, 10) + "…" : h.s) : "";
    const body = h.sent
      ? `<div class="groups">${compareHTML(h.sent.split(" ").filter(Boolean), (h.typed || "").split(" ").filter(Boolean))}</div>`
      : '<p class="muted">Dettaglio non disponibile.</p>';
    return `<details class="sess"><summary><span>${date}, ${esc(set)}, ${h.w}/${h.e} WPM</span><b style="color:var(${h.a >= 90 ? "--ok" : "--err"})">${h.a}%</b></summary>${body}</details>`;
  }).join("") : '<p class="muted">Nessuna sessione ancora.</p>';
}
$("stMore").onclick = () => { showAllChars = !showAllChars; renderStats(); };
$("stPractice").onclick = () => {
  const name = "Da ripassare";
  S.sets = S.sets.filter(x => x.name !== name);
  S.sets.push({ name, chars: practiceChars.join("") });
  S.mode = "set:" + name; saveS();
  renderSet(); newExercise(); showView("koch");
  toast(`Modo «${name}»: ${practiceChars.join(" ")}`);
};

/* ---------- Account ---------- */
function showLogin(on) {
  $("v-login").hidden = !on; $("nav").hidden = on;
  if (on) {
    halt(); sess = "idle";
    VIEWS.forEach(id => { $("v-" + id).hidden = true; });
    setRegMode(false); $("lSwitch").hidden = !regAllowed;
  }
}
function setRegMode(on) {
  regMode = on;
  $("loginTitle").textContent = on ? "Crea un account" : "Accedi";
  $("lBtn").textContent = on ? "Registrati" : "Accedi";
  $("lPass").autocomplete = on ? "new-password" : "current-password";
  $("lPass").minLength = on ? 8 : 0;
  $("lSwitch").textContent = on ? "Hai già un account? Accedi" : "Non hai un account? Registrati";
  $("lMsg").textContent = "";
}
$("lSwitch").onclick = () => setRegMode(!regMode);
async function startSession(user) {
  $("whoami").textContent = user.username;
  const st = await api("state");
  for (const k of Object.keys(S)) delete S[k];
  Object.assign(S, JSON.parse(JSON.stringify(DEFAULTS)), st.settings || {});
  history = st.history || [];
  showLogin(false); showView("koch");
  syncSettings(); renderSet(); renderHist(); newExercise();
}
$("loginForm").addEventListener("submit", async e => {
  e.preventDefault(); $("lMsg").textContent = ""; $("lBtn").disabled = true;
  try {
    const r = await api(regMode ? "register" : "login", { username: $("lUser").value.trim(), password: $("lPass").value });
    $("lPass").value = "";
    await startSession(r.user);
  } catch (err) { $("lMsg").textContent = err.message; }
  finally { $("lBtn").disabled = false; }
});
$("logoutBtn").onclick = async () => {
  clearTimeout(saveTimer);
  try { await api("logout", {}); } catch (e) {}
  history = []; showLogin(true);
};
$("delAccount").onclick = async () => {
  const pass = $("pwOld").value;
  if (!pass) { $("pwOld").focus(); toast("Per confermare, scrivi la password attuale nel campo «Password attuale»."); return; }
  if (!confirm("Eliminare definitivamente l’account con impostazioni e risultati? L’operazione non si può annullare.")) return;
  try {
    await api("delete_account", { current: pass });
    $("pwOld").value = ""; history = []; showLogin(true); toast("Account eliminato");
  } catch (err) { toast(err.message); }
};
$("pwForm").addEventListener("submit", async e => {
  e.preventDefault();
  try {
    await api("password", { current: $("pwOld").value, password: $("pwNew").value });
    $("pwOld").value = ""; $("pwNew").value = ""; toast("Password aggiornata");
  } catch (err) { toast(err.message); }
});
(async function boot() {
  try { const me = await api("me"); await startSession(me.user); }
  catch (e) { showLogin(true); if (e.status !== 401) $("lMsg").textContent = e.message; }
})();
// Pagina, script e font restano sul telefono: l'app si apre subito anche con rete scarsa.
// Una versione nuova entra in uso al prossimo avvio, senza interrompere un esercizio in corso.
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.php").catch(() => {});
