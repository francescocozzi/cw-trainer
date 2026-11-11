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
// Classi: in quali è allievo l'utente e, se è tutor, quali gestisce
let CL = { tutor: false, joined: [], own: [] };
// Esercizio della classe scelto nel menu Modo: le sue impostazioni valgono solo per la sessione
function assignment() {
  const m = /^class:(\d+)$/.exec(S.mode || "");
  if (!m) return null;
  for (const c of CL.joined) { const a = c.assignments.find(x => x.id === +m[1]); if (a) return Object.assign({ cls: c }, a); }
  return null;
}
// Impostazioni effettive: quelle dell'allievo, con cosa ascoltare e a che velocità fissati dal tutor
const X = () => { const a = assignment(); return a ? Object.assign({}, S, a.settings) : S; };
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(t._h); t._h = setTimeout(() => { t.hidden = true; }, 3500);
}

/* ---------- Server ---------- */
let regAllowed = false, regMode = false, saveTimer = null;
async function api(action, body, params, opts = {}) {
  let r;
  try {
    r = await fetch(`api.php?action=${encodeURIComponent(action)}${params ? "&" + new URLSearchParams(params) : ""}`, {
      method: body ? "POST" : "GET",
      credentials: "same-origin",
      headers: Object.assign({ "X-Requested-With": "cw" }, body ? { "Content-Type": "application/json" } : {}),
      body: body ? JSON.stringify(body) : undefined,
      keepalive: !!opts.keepalive
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
  const a = assignment(); if (a) return ALL.filter(c => a.settings.chars.includes(c));
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
  const o = Object.assign({ wpm: X().wpm, eff: X().wpm, extra: 0, delay: 0, freq: pickFreq() }, opt);
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
  return me;
}
function stop() {
  if (current) { const o = current.osc; clearInterval(current.timer); current = null; o.onended = null; try { o.stop(); } catch (e) {} }
}
// Schermo acceso durante gli esercizi. Il sistema rilascia il blocco quando l'app va in
// secondo piano: al ritorno lo si richiede, se l'esercizio è ancora in corso.
let wantAwake = false;
async function keepAwake(on) {
  wantAwake = on;
  try {
    if (on && "wakeLock" in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    }
    if (!on && wakeLock) { const w = wakeLock; wakeLock = null; await w.release(); }
  } catch (e) {}
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && wantAwake) keepAwake(true); });

/* ---------- Esercizio ---------- */
const randChar = set => set[Math.floor(Math.random() * set.length)];
const sessionOpts = () => { const x = X(); return { wpm: x.wpm, eff: x.eff, extra: x.extra }; };
function genGroups() {
  const x = X(), set = activeChars(), groups = [], target = x.mins * 60;
  while (groups.length < 400) {
    const len = x.randLen ? 2 + Math.floor(Math.random() * 6) : x.glen;
    let g = ""; for (let i = 0; i < len; i++) g += randChar(set);
    groups.push(g);
    if (walk(groups.join(" "), sessionOpts()) >= target) break;
  }
  return groups;
}
function renderSet() {
  const opts = [["custom", "Caratteri custom"], ["letters", "Lettere"], ["numbers", "Cifre"], ["mixed", "Lettere e cifre"]].concat(S.sets.map(s => ["set:" + s.name, "Set: " + s.name]));
  const classOpts = CL.joined.flatMap(c => c.assignments.map(a => ["class:" + a.id, `${c.name}: ${a.title}`]));
  if (!opts.concat(classOpts).some(o => o[0] === S.mode)) S.mode = "custom";
  const optHTML = list => list.map(([v, l]) => `<option value="${esc(v)}"${v === S.mode ? " selected" : ""}>${esc(l)}</option>`).join("");
  $("mode").innerHTML = optHTML(opts) + (classOpts.length ? `<optgroup label="Esercizi della classe">${optHTML(classOpts)}</optgroup>` : "");
  const x = X(), a = assignment();
  $("dur").innerHTML = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(m => `<option value="${m}"${m === x.mins ? " selected" : ""}>${m} min</option>`).join("");
  $("dur").disabled = !!a;
  $("durTitle").textContent = `(${x.mins} min)`;
  const set = activeChars();
  $("charset").textContent = set.length ? alpha(set).join(" ") : "Nessun carattere custom selezionato: tocca «Cambia»";
  const tone = S.randTone ? "casuale" : S.freq + " Hz";
  $("params").innerHTML = a
    ? `Esercizio di <b>${esc(a.cls.tutor)}</b>: velocità carattere <b>${x.wpm} WPM</b>, effettiva <b>${x.eff} WPM</b>, gruppi di <b>${x.randLen ? "2–7" : x.glen}</b>. Tono <b>${tone}</b> e ritardo <b>${S.delay} s</b> sono tuoi. <button class="lnk" id="chg">Cambia</button>` +
      (a.goal || a.due ? `<span class="gs" style="display:block;margin-top:6px">${esc([goalText(a.goal), (goalState(a.goal, a.status, a.due) || {}).text].filter(Boolean).join(". "))}</span>` : "")
    : `Velocità carattere <b>${S.wpm} WPM</b>, effettiva <b>${S.eff} WPM</b>, tono <b>${tone}</b>, ritardo <b>${S.delay} s</b>. <button class="lnk" id="chg">Cambia</button>`;
  const btn = c => `<button data-c="${esc(c)}" aria-pressed="${S.chars.includes(c)}">${esc(c)}</button>`;
  $("picker").innerHTML = alpha(KOCH).map(btn).join("");
  $("pickerX").innerHTML = alpha(EXTRAS).map(btn).join("");
  $("saved").innerHTML = S.sets.map((s, i) => `<button data-i="${i}" aria-pressed="${s.chars === S.chars}">${esc(s.name)}<span data-del="${i}" aria-label="Elimina set">×</span></button>`).join("");
  $("speedTag").textContent = x.eff < x.wpm ? `${x.wpm}/${x.eff} WPM` : `${x.wpm} WPM`;
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
const sessionText = () => { const p = X().pre; return (p ? "VVV = " : "") + sent.join(" ") + (p ? " +" : ""); };
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
  $("answer").value = ""; $("results").hidden = true; $("checkBtn").disabled = true; renderBlocks();
  $("bar").style.width = "0"; $("tNow").textContent = "0:00"; $("tTot").textContent = fmt(X().mins * 60);
  setStatus(activeChars().length ? "Premi Play e trascrivi i gruppi" : "Nessun carattere custom selezionato: tocca «Cambia»", false);
}
$("ppBtn").onclick = () => {
  if ((sess === "playing" || sess === "paused") && !current) sess = "done"; // audio interrotto da un altro ascolto
  if (sess === "playing") { ensureCtx().suspend(); sess = "paused"; setPP(false); setStatus("In pausa", false); keepAwake(false); return; }
  if (sess === "paused") { ensureCtx().resume(); sess = "playing"; setPP(true); keepAwake(true); tick(); return; }
  if (!activeChars().length) { setStatus("Nessun carattere custom selezionato: tocca «Cambia»", false); return; }
  if (sess === "idle") { sent = genGroups(); $("answer").value = ""; $("results").hidden = true; renderBlocks(); }
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
/* ---------- Trascrizione a blocchi ---------- */
// Il campo di testo resta quello vero (tastiera, accessibilità), invisibile sopra la griglia.
// Si scrive solo in coda: niente spazi e cursore sempre alla fine.
const gridMode = () => S.noSpace && !X().randLen;
function renderBlocks() {
  const on = gridMode();
  $("typing").classList.toggle("grid", on);
  if (!on) return;
  const ta = $("answer"), v = [...ta.value];
  if (!sent.length && !v.length) { $("blocks").innerHTML = '<p class="muted">I blocchi compaiono quando parte la trasmissione.</p>'; return; }
  const n = X().glen, cur = Math.floor(v.length / n), count = Math.max(sent.length, cur + 1);
  $("blocks").style.setProperty("--n", n);
  let html = "";
  for (let i = 0; i < count; i++) {
    const chars = v.slice(i * n, i * n + n);
    html += `<div class="blk${i === cur ? " cur" : ""}">${chars.map(esc).join("")}${"<i></i>".repeat(n - chars.length)}</div>`;
  }
  $("blocks").innerHTML = html;
  const c = $("blocks").querySelector(".cur");
  if (c && document.activeElement === ta) c.scrollIntoView({ block: "nearest" });
}
function toEnd() { const ta = $("answer"); if (gridMode()) ta.setSelectionRange(ta.value.length, ta.value.length); }
$("answer").addEventListener("input", () => {
  if (!gridMode()) return;
  const ta = $("answer"), clean = ta.value.replace(/\s+/g, "").toUpperCase();
  if (clean !== ta.value) ta.value = clean;
  toEnd(); renderBlocks();
});
["focus", "click", "keyup", "select"].forEach(ev => $("answer").addEventListener(ev, toEnd));

// iOS sostituisce virgolette e trattini con quelli tipografici: li riportiamo a quelli semplici
const normalize = s => s.toUpperCase().replace(/[“”„«»]/g, "\"").replace(/[‘’‚]/g, "'").replace(/[–—]/g, "-");

$("checkBtn").onclick = () => {
  if (!sent.length) return;
  halt(); sess = "idle";
  setStatus("Esercizio controllato. Premi Play per uno nuovo.", false);
  const raw = normalize($("answer").value);
  const typed = gridMode() ? splitStream(raw, sent) : raw.trim().split(/\s+/).filter(Boolean);
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
  const x = X(), as = assignment();
  const entry = { d: Date.now(), s: activeChars().join(""), a: acc, w: x.wpm, e: x.eff, errors: errs, total, sent: sent.join(" "), typed: typed.join(" "), as: as ? as.id : undefined };
  history.unshift(entry); history = history.slice(0, 50); renderHist();
  api("result", entry).then(() => { if (entry.as) refreshClasses(); }).catch(e => toast("Risultato non salvato: " + e.message));
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
let target = null, cOk = 0, cBad = 0, busy = false, charFreq = 600, nextTimer = 0, toneEnd = 0, replayed = false;
function renderKeys() {
  $("keys").innerHTML = activeChars().map(c => `<button data-c="${esc(c)}">${esc(c)}</button>`).join("");
}
function playTarget(listen) {
  const me = play(target, listen && voiceOn() ? listenAnswer : null, { freq: charFreq });
  // Il tempo di risposta si misura dalla fine del tono
  toneEnd = performance.now() + Math.max(0, me.end - ctx.currentTime) * 1000;
}
function nextChar() {
  stopListen();
  const set = activeChars();
  if (!set.length) { stopInstant(); $("bigCh").textContent = "—"; return; }
  target = randChar(set); busy = false; replayed = false; charFreq = pickFreq();
  $("bigCh").textContent = "?"; $("bigCh").className = "big";
  playTarget(true);
}
// Lo stesso pulsante avvia e ferma: fermando si interrompono tono, ascolto e carattere successivo
function stopInstant() {
  clearTimeout(nextTimer); stopListen(); stop(); flushInstant(); keepAwake(false);
  target = null; busy = false;
  $("bigCh").textContent = "?"; $("bigCh").className = "big";
  $("keys").querySelectorAll(".ok,.bad").forEach(b => b.classList.remove("ok", "bad"));
  $("instReplay").disabled = true; $("instStart").textContent = "Inizia";
}
$("instStart").onclick = () => {
  if (target) { stopInstant(); return; }
  cOk = cBad = 0; updCounters(); $("instReplay").disabled = false; $("instStart").textContent = "Ferma"; keepAwake(true); nextChar();
};
$("instReplay").onclick = () => { if (target && !busy) { stopListen(); replayed = true; playTarget(true); } };
function updCounters() { $("cOk").textContent = `${cOk} giusti`; $("cBad").textContent = `${cBad} errori`; }
function answer(c, voice = false) {
  if (!target || busy) return;
  busy = true; stopListen();
  // Il tempo non è confrontabile se il carattere è stato riascoltato o la risposta è a voce
  const ms = voice || replayed ? null : Math.max(0, Math.round(performance.now() - toneEnd));
  const as = assignment();
  instQueue.push({ c: target, a: c, t: Date.now(), ms, v: voice, w: X().wpm, as: as ? as.id : undefined });
  if (instQueue.length >= 20) flushInstant();
  const ok = c === target, b = $("keys").querySelector(`button[data-c="${CSS.escape(c)}"]`);
  if (b) b.classList.add(ok ? "ok" : "bad");
  $("bigCh").textContent = target; $("bigCh").className = "big " + (ok ? "ok" : "bad");
  if (ok) cOk++; else { cBad++; playTarget(false); }
  updCounters();
  nextTimer = setTimeout(() => { if (b) b.classList.remove("ok", "bad"); nextChar(); }, ok ? 450 : 1300);
}
$("keys").addEventListener("click", e => { const b = e.target.closest("button"); if (b) answer(b.dataset.c); });

// Le risposte vanno al server a blocchi: ogni 20, quando si ferma, si cambia vista o si chiude l'app
let instQueue = [], instSending = false, instRetry = 0;
function flushInstant(leaving = false) {
  if (!instQueue.length || instSending) return;
  const items = instQueue.splice(0, 200);
  instSending = true;
  api("instant", { items }, undefined, { keepalive: leaving })
    .then(() => { if (!leaving && items.some(x => x.as)) refreshClasses(); })
    .catch(e => {
      if (e.status && e.status !== 429 && e.status < 500) return; // dati rifiutati: inutile riprovare
      instQueue.unshift(...items); instQueue = instQueue.slice(-1000);
      clearTimeout(instRetry); instRetry = setTimeout(flushInstant, 5000);
    })
    .finally(() => { instSending = false; });
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushInstant(true); });

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
    answer(c, true);
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
  // I blocchi hanno senso solo con gruppi di lunghezza fissa
  if (S.randLen) S.noSpace = false;
  for (const k in fields) { const [i, o, f] = fields[k]; $(i).value = S[k]; $(o).textContent = f(S[k]); }
  for (const k in toggles) $(toggles[k]).checked = !!S[k];
  $("sEff").max = S.wpm;
  $("sNoSpace").disabled = S.randLen;
  $("noSpaceHint").textContent = S.randLen
    ? "Non disponibile con la lunghezza del gruppo casuale."
    : "Scrivi i caratteri uno dopo l’altro, senza spazi: si dispongono da soli in blocchi della lunghezza del gruppo.";
  renderBlocks();
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
  if (v !== "instant") { stopListen(); flushInstant(); }
  if (v === "stats") loadStats();
  if (v === "class") { renderTutor(); loadProgress(); }
  window.scrollTo(0, 0);
}
document.querySelectorAll("nav button").forEach(b => b.onclick = () => showView(b.dataset.view));

/* ---------- Statistiche ---------- */
const VIEWS = ["koch", "instant", "stats", "class", "settings"];
let statsData = null, showAllChars = false, practiceChars = [], showAllIChars = false, iPracticeChars = [];
let stMode = lsGet("cw-stmode") === "instant" ? "instant" : "groups";
const secs = ms => (ms / 1000).toFixed(2).replace(".", ",") + " s";
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
  document.querySelectorAll("#stMode button").forEach(b => b.setAttribute("aria-pressed", b.dataset.m === stMode));
  $("stG").hidden = stMode !== "groups"; $("stI").hidden = stMode !== "instant";
  if (stMode === "instant") { renderInstantStats(d.instant, s.streak); return; }
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
function renderInstantStats(d, streak) {
  const s = d.summary;
  $("stTiles").innerHTML = [
    [s.answers.toLocaleString("it-IT"), s.answers === 1 ? "risposta" : "risposte"],
    [s.answers ? s.acc + "%" : "—", "precisione"],
    [s.ms != null ? secs(s.ms) : "—", "tempo medio"],
    [streak, streak === 1 ? "giorno di fila" : "giorni di fila"]
  ].map(([v, l]) => `<div class="tile"><b>${v}</b><span>${l}</span></div>`).join("");

  const accs = d.days.map(x => x.acc);
  lineChart($("chIAcc"), d.days.map(x => dayLabel(x.day)), [{ values: accs, color: "var(--accent)", name: "Precisione" }],
    { min: accs.length ? Math.max(0, Math.floor((Math.min(...accs) - 5) / 10) * 10) : 0, max: 100, ref: 90, unit: "%", label: "Precisione giornaliera nel riconoscimento rapido" });
  const timed = d.days.filter(x => x.ms != null);
  lineChart($("chIMs"), timed.map(x => dayLabel(x.day)), [{ values: timed.map(x => x.ms), color: "var(--accent)", name: "Tempo" }],
    { min: 0, unit: " ms", label: "Tempo medio di risposta giornaliero in millisecondi" });

  // Prima i meno precisi, a parità di precisione i più lenti
  const ch = d.chars.filter(c => c.n >= 5)
    .map(c => Object.assign({}, c, { acc: Math.round((1 - c.err / c.n) * 100) }))
    .sort((a, b) => a.acc - b.acc || (b.ms ?? 0) - (a.ms ?? 0));
  const list = showAllIChars ? ch : ch.slice(0, 10);
  $("stIChars").innerHTML = ch.length
    ? list.map(c => `<div class="crow"><span class="c">${esc(c.c)}</span><span class="b"><i style="width:${c.acc}%;background:var(${c.acc >= 90 ? "--ok" : "--err"})"></i></span><span class="v">${c.acc}%${c.ms != null ? " · " + secs(c.ms) : ""}</span></div>`).join("")
    : '<p class="muted">Ancora pochi dati: fai qualche esercizio rapido in più.</p>';
  $("stIMore").hidden = ch.length <= 10;
  $("stIMore").textContent = showAllIChars ? "Mostra meno" : `Mostra tutti (${ch.length})`;
  // Da ripassare: quelli sotto il 90%; se sono meno di due, si aggiungono i più lenti fino a cinque
  const weak = ch.filter(c => c.acc < 90);
  const slow = ch.filter(c => c.acc >= 90 && c.ms != null).sort((a, b) => b.ms - a.ms);
  iPracticeChars = (weak.length >= 2 ? weak : weak.concat(slow).slice(0, 5)).map(c => c.c);
  $("stIPractice").hidden = iPracticeChars.length < 2;
  $("stIPractice").textContent = `Esercitati su ${iPracticeChars.join(" ")}`;

  $("stIConf").innerHTML = d.confusions.length
    ? d.confusions.map(c => `<li><span><span class="mono">${esc(c.s)}</span> riconosciuto come <span class="mono">${esc(c.t)}</span></span><b>${c.n} ${c.n === 1 ? "volta" : "volte"}</b></li>`).join("")
    : '<li class="muted">Nessuna confusione nel periodo.</li>';
}
$("stMode").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  stMode = b.dataset.m; lsSet("cw-stmode", stMode); renderStats();
});
$("stMore").onclick = () => { showAllChars = !showAllChars; renderStats(); };
$("stIMore").onclick = () => { showAllIChars = !showAllIChars; renderStats(); };
function practiceOn(chars, view) {
  const name = "Da ripassare";
  S.sets = S.sets.filter(x => x.name !== name);
  S.sets.push({ name, chars: chars.join("") });
  S.mode = "set:" + name; saveS();
  renderSet(); newExercise(); showView(view);
  toast(`Modo «${name}»: ${chars.join(" ")}`);
}
$("stPractice").onclick = () => practiceOn(practiceChars, "koch");
$("stIPractice").onclick = () => practiceOn(iPracticeChars, "instant");

/* ---------- Classi ---------- */
const codeFmt = c => c.length === 8 ? c.slice(0, 4) + "-" + c.slice(4) : c;
function applyClasses(c) {
  CL = c || { tutor: false, joined: [], own: [] };
  $("navClass").hidden = !CL.tutor;
  renderSet(); renderMyClasses();
  if (!$("v-class").hidden) renderTutor();
}
// Dopo una sessione di un esercizio della classe: aggiorna a che punto è l'obiettivo
const refreshClasses = () => api("classes").then(r => applyClasses(r.classes)).catch(() => {});
// Allievo: entrare con il codice, vedere le classi, uscirne
function renderMyClasses() {
  $("myClasses").innerHTML = CL.joined.map(c =>
    `<li><span><b>${esc(c.name)}</b>, tutor ${esc(c.tutor)}` + c.assignments.map(a => {
      const gs = goalState(a.goal, a.status, a.due);
      return `<br>${esc(a.title)}${gs ? `<span class="gs ${gs.tone}" style="display:block">${esc(gs.text)}</span>` : ""}`;
    }).join("") + `</span><button class="lnk" data-leave="${c.id}">Esci</button></li>`).join("");
}
$("joinForm").addEventListener("submit", async e => {
  e.preventDefault();
  const code = $("joinCode").value.trim(); if (!code) return;
  try {
    const r = await api("class_join", { code });
    $("joinCode").value = ""; $("joinCode").blur();
    applyClasses(r.classes); toast(`Sei nella classe «${r.name}»: trovi gli esercizi nel menu Modo`);
  } catch (err) { toast(err.message); }
});
$("myClasses").addEventListener("click", async e => {
  const b = e.target.closest("[data-leave]"); if (!b) return;
  const c = CL.joined.find(x => x.id === +b.dataset.leave);
  if (!c || !confirm(`Uscire dalla classe «${c.name}»? Il tutor non vedrà più i tuoi risultati.`)) return;
  try { applyClasses((await api("class_leave", { id: c.id })).classes); } catch (err) { toast(err.message); }
});

// Tutor: classi, codice di invito, allievi, esercizi assegnati e progressi
let clSel = null, progData = null;
const clCur = () => CL.own.find(c => c.id === clSel) || CL.own[0] || null;
// Obiettivi e scadenze: date confrontate nel giorno locale del telefono
const dmy = d => d.slice(8, 10) + "/" + d.slice(5, 7);
const localDay = ms => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
function goalText(g) {
  if (!g) return "";
  const parts = [];
  if (g.groups) parts.push(`${g.groups.n} ${g.groups.n === 1 ? "sessione" : "sessioni"} sopra il ${g.groups.acc}%`);
  if (g.instant) parts.push(`Rapido: ultime ${g.instant.n} risposte al ${g.instant.acc}%${g.instant.ms ? ", sotto " + secs(g.instant.ms) : ""}`);
  return "Obiettivo: " + parts.join(" e ");
}
// Stato dell'obiettivo per un allievo: testo e tono (ok, bad o neutro)
function goalState(g, st, due) {
  const today = localDay(Date.now());
  if (!g || !st) return due ? { text: today > due ? `Scaduto il ${dmy(due)}` : `Entro il ${dmy(due)}`, tone: "" } : null;
  if (st.done) {
    const day = localDay(st.doneTs), late = due && day > due;
    return { text: `Obiettivo raggiunto il ${dmy(day)}${late ? ", dopo la scadenza" : ""}`, tone: late ? "" : "ok" };
  }
  const parts = [];
  if (st.groups) parts.push(`${st.groups.have} di ${st.groups.need} sessioni sopra il ${g.groups.acc}%`);
  if (st.instant) parts.push(st.instant.acc == null
    ? `${st.instant.answers} di ${st.instant.need} risposte`
    : `ultime ${st.instant.need} risposte al ${st.instant.acc}%${st.instant.ms != null ? " in " + secs(st.instant.ms) : ""}`);
  const late = due && today > due;
  return { text: parts.join(" · ") + (due ? (late ? ` · scaduto il ${dmy(due)}` : ` · entro il ${dmy(due)}`) : ""), tone: late ? "bad" : "" };
}
const assignSummary = st => `${alpha([...st.chars]).join(" ")} · ${st.eff < st.wpm ? st.wpm + "/" + st.eff : st.wpm} WPM · gruppi di ${st.randLen ? "2–7" : st.glen} · ${st.mins} min`;
function currentAssignSettings() {
  const x = X();
  return { chars: activeChars().join(""), wpm: x.wpm, eff: x.eff, extra: x.extra, glen: x.glen, randLen: x.randLen, mins: x.mins, pre: x.pre };
}
function renderTutor() {
  const c = clCur(); clSel = c ? c.id : null;
  $("clEmpty").hidden = !!c;
  ["clPick", "clBox", "clAssignPanel", "clProgPanel"].forEach(id => { $(id).hidden = !c; });
  if (!c) return;
  $("clPick").innerHTML = CL.own.map(x => `<option value="${x.id}"${x.id === c.id ? " selected" : ""}>${esc(x.name)}</option>`).join("");
  $("clCode").textContent = codeFmt(c.code);
  $("clMembers").innerHTML = c.members.length
    ? c.members.map(m => `<li><span>${esc(m.username)}</span><button class="lnk" data-kick="${m.id}">Togli</button></li>`).join("")
    : '<li class="muted">Nessun allievo ancora.</li>';
  $("clAssigns").innerHTML = c.assignments.length
    ? c.assignments.map(a => `<li><span><b>${esc(a.title)}</b><br><span class="muted">${esc(assignSummary(a.settings))}${a.goal ? "<br>" + esc(goalText(a.goal)) : ""}${a.due ? "<br>Scadenza " + dmy(a.due) : ""}</span></span><button class="lnk" data-archive="${a.id}">Archivia</button></li>`).join("")
    : '<li class="muted">Nessun esercizio assegnato.</li>';
  const st = currentAssignSettings();
  $("clFrom").textContent = st.chars
    ? `Il nuovo esercizio usa le tue impostazioni attuali: ${assignSummary(st)}. Per cambiarle, scegli caratteri e modo in Esercizio e velocità e gruppi in Impostazioni.`
    : "Scegli prima dei caratteri in Esercizio: il nuovo esercizio usa le tue impostazioni attuali.";
  const pick = $("clProgPick"), prev = +pick.value;
  pick.innerHTML = c.assignments.map(a => `<option value="${a.id}"${a.id === prev ? " selected" : ""}>${esc(a.title)}</option>`).join("");
  pick.hidden = !c.assignments.length;
  renderProgress();
}
async function tutorCall(action, body, ok) {
  try { const r = await api(action, body); applyClasses(r.classes); if (ok) ok(r); loadProgress(); }
  catch (err) { toast(err.message); }
}
$("clPick").addEventListener("change", e => { clSel = +e.target.value; renderTutor(); loadProgress(); });
$("clNew").onclick = () => {
  const name = (prompt("Nome della classe, es. Corso CW 2027") || "").trim(); if (!name) return;
  tutorCall("class_create", { name }, r => { clSel = r.id; renderTutor(); });
};
$("clNewCode").onclick = () => {
  const c = clCur(); if (!c || !confirm("Creare un nuovo codice? Quello attuale smette di funzionare; gli allievi già entrati restano.")) return;
  tutorCall("class_code", { id: c.id });
};
$("clDelete").onclick = () => {
  const c = clCur(); if (!c || !confirm(`Eliminare la classe «${c.name}»? Gli allievi ne escono e gli esercizi spariscono dal loro menu. I loro risultati restano a loro. Non si può annullare.`)) return;
  clSel = null; tutorCall("class_delete", { id: c.id });
};
$("clMembers").addEventListener("click", e => {
  const b = e.target.closest("[data-kick]"); const c = clCur(); if (!b || !c) return;
  const m = c.members.find(x => x.id === +b.dataset.kick);
  if (m && confirm(`Togliere ${m.username} dalla classe? Non vedrai più i suoi risultati; potrà rientrare con il codice.`)) tutorCall("class_kick", { id: c.id, user: m.id });
});
$("clAssigns").addEventListener("click", e => {
  const b = e.target.closest("[data-archive]"); const c = clCur(); if (!b || !c) return;
  const a = c.assignments.find(x => x.id === +b.dataset.archive);
  if (a && confirm(`Archiviare «${a.title}»? Sparisce dal menu degli allievi e dai progressi.`)) tutorCall("assign_archive", { id: a.id });
});
$("clAssignForm").addEventListener("submit", e => {
  e.preventDefault();
  const c = clCur(), title = $("clTitle").value.trim(); if (!c || !title) return;
  const goal = {
    groups: $("gG").checked ? { n: +$("gGn").value, acc: +$("gGacc").value } : null,
    instant: $("gI").checked ? { n: +$("gIn").value, acc: +$("gIacc").value, ms: $("gIms").value ? Math.round(+$("gIms").value * 1000) : null } : null
  };
  tutorCall("assign_create", { class: c.id, title, settings: currentAssignSettings(), goal, due: $("gDue").value || null }, () => {
    $("clTitle").value = ""; $("clTitle").blur(); toast(`Esercizio «${title}» assegnato`);
  });
});
async function loadProgress() {
  const c = clCur(); if (!c || $("v-class").hidden) return;
  try { progData = await api("class_progress", undefined, { id: c.id }); renderProgress(); }
  catch (err) { $("clProg").innerHTML = `<li class="muted">${esc(err.message)}</li>`; }
}
$("clProgPick").addEventListener("change", renderProgress);
// I campi dell'obiettivo si attivano solo con la casella spuntata
function syncGoalForm() {
  ["gGn", "gGacc"].forEach(id => { $(id).disabled = !$("gG").checked; });
  ["gIn", "gIacc", "gIms"].forEach(id => { $(id).disabled = !$("gI").checked; });
}
["gG", "gI"].forEach(id => $(id).addEventListener("change", syncGoalForm));
syncGoalForm();
function renderProgress() {
  const c = clCur(), d = progData;
  if (!c || !d) { $("clProg").innerHTML = ""; $("clWeak").innerHTML = ""; return; }
  const a = d.assignments.find(x => x.id === +$("clProgPick").value) || d.assignments[0];
  if (!a || !d.members.length) {
    $("clProg").innerHTML = `<li class="muted">${!a ? "Assegna un esercizio per vedere i progressi." : "Nessun allievo nella classe."}</li>`;
    $("clProgGoal").textContent = "";
    $("clWeak").innerHTML = ""; return;
  }
  const name = Object.fromEntries(d.members.map(m => [m.id, m.username]));
  const groupsLine = g => g ? `${g.n} ${g.n === 1 ? "sessione" : "sessioni"}, ultima ${g.last}%, migliore ${g.best}%` : "nessuna sessione";
  const instantLine = i => i ? `${i.n} ${i.n === 1 ? "risposta" : "risposte"}, ${i.acc}%${i.ms != null ? ", " + secs(i.ms) : ""}` : "nessuna risposta";
  const done = a.students.filter(s => s.status && s.status.done).length;
  $("clProgGoal").textContent = [goalText(a.goal), a.due ? "Scadenza " + dmy(a.due) : "",
    a.goal ? `${done} di ${a.students.length} ${a.students.length === 1 ? "allievo l’ha raggiunto" : "allievi l’hanno raggiunto"}` : ""].filter(Boolean).join(" · ");
  $("clProg").innerHTML = a.students.map(s => {
    const gs = goalState(a.goal, s.status, a.due);
    return `<li><b>${esc(name[s.id])}</b>` +
      (gs && a.goal ? `<div class="gs ${gs.tone}">${esc(gs.text)}</div>` : "") +
      `<div class="st"><span>Gruppi</span><span>${groupsLine(s.g)}</span></div>` +
      `<div class="st"><span>Rapido</span><span>${instantLine(s.i)}</span></div></li>`;
  }).join("");
  const weak = a.chars.filter(x => x.n >= 5).map(x => Object.assign({}, x, { acc: Math.round((1 - x.err / x.n) * 100) }))
    .sort((p, q) => p.acc - q.acc || q.n - p.n).slice(0, 8);
  $("clWeak").innerHTML = weak.length
    ? weak.map(x => `<div class="crow"><span class="c">${esc(x.c)}</span><span class="b"><i style="width:${x.acc}%;background:var(${x.acc >= 90 ? "--ok" : "--err"})"></i></span><span class="v">${x.acc}% su ${x.n}</span></div>`).join("")
    : '<p class="muted">Ancora pochi dati.</p>';
}

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
  applyClasses(st.classes);
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
