"use strict";
// Earmark on the phone. Generated from web/app.js by build_phone_app.py: change that file, then run it again.
import { install, mediaUrl } from "./core/server.js";
await install();
const $ = (sel, root = document) => root.querySelector(sel);
const view = $("#view");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clock = t => { t = Math.max(0, Math.floor(t || 0)); const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = String(t % 60).padStart(2, "0"); return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// CLOUD: running in a GitHub codespace, opened through its github.dev address.
// REMOTE: opened on a phone through the PC's phone address, rather than on the PC itself.
const CLOUD = false, REMOTE = false;
const PC = "this phone";
const ON_PC = CLOUD ? "in your codespace" : `on ${PC}`;
const SPEECH = `the speech model ${ON_PC}`;
const TOUCH = matchMedia("(pointer: coarse)").matches;
const WINDOWS = /Windows/.test(navigator.userAgent);
const UNREACHABLE = CLOUD ? "Can't reach Earmark. Your codespace may have stopped: start it again at github.com/codespaces, then reload this page."
  : REMOTE ? "Can't reach Earmark on your PC. Check it's still running there and this phone is on the same Wi-Fi."
  : "Can't reach Earmark. If its window was closed, run start.bat again.";
const dateText = ts => new Date(ts * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const ago = ts => { const s = Date.now() / 1000 - ts; return s < 120 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : dateText(ts); };

async function api(path, opts = {}) {
  let res;
  try { res = await fetch(path, opts); } catch { throw new Error(UNREACHABLE); }
  const data = await res.json().catch(() => ({}));
  // This phone was disconnected on the PC: reloading shows the page to connect it again.
  if (res.status === 401 && (REMOTE || CLOUD)) location.reload();
  // A stopped codespace answers with GitHub's own page instead of Earmark's.
  if (!res.ok && CLOUD && !data.error) throw new Error(UNREACHABLE);
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
const post = (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

async function refreshBadges() {
  try {
    const s = await api("/api/summary");
    const set = (id, n) => { const b = $(id); b.textContent = n; b.hidden = !n; };
    set("#badge-due", s.due); set("#badge-clips", s.clips);
  } catch { /* server stopped; the page's own error will say so */ }
}

// ---------------------------------------------------------------- audio helpers

let ctx;
function audioCtx() {
  ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

/** Reads text aloud in the device's own voice. Resolves when it has finished, or after a fair
    time if the browser never says so. */
function say(text, signal) {
  if (!("speechSynthesis" in window) || !text) return Promise.resolve();
  return new Promise(resolve => {
    const u = new SpeechSynthesisUtterance(text);
    let timer;
    const done = () => { clearTimeout(timer); resolve(); };
    u.onend = u.onerror = done;
    timer = setTimeout(done, 4000 + text.split(/\s+/).length * 500);
    signal?.addEventListener("abort", () => { speechSynthesis.cancel(); done(); }, { once: true });
    if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
    speechSynthesis.speak(u);
  });
}

function tone(freq = 880, ms = 160, gain = 0.25) {
  const c = audioCtx(), o = c.createOscillator(), g = c.createGain();
  o.frequency.value = freq; g.gain.value = gain;
  g.gain.setValueAtTime(gain, c.currentTime + ms / 1000 - 0.03);
  g.gain.linearRampToValueAtTime(0.0001, c.currentTime + ms / 1000);
  o.connect(g).connect(c.destination);
  o.start(); o.stop(c.currentTime + ms / 1000);
  return sleep(ms);
}

// A part of a lecture, played straight from the recording on the phone: decoding whole lectures
// would use too much memory, so a second player jumps to the start and stops at the end.
async function fetchClip(sid, start, end) {
  return { url: await mediaUrl(sid), start: Math.max(0, start), end };
}

const clipPlayer = new Audio();
clipPlayer.preload = "auto";
function playBuffer(clip, signal) {
  return new Promise(async resolve => {
    const p = clipPlayer;
    let timer = null, done = false;
    const finish = () => { if (done) return; done = true; clearInterval(timer); p.pause(); resolve(); };
    signal?.addEventListener("abort", finish, { once: true });
    try {
      if (p.src !== clip.url) { p.src = clip.url; await new Promise(r => { p.onloadedmetadata = r; p.onerror = r; }); }
      await new Promise(r => { p.onseeked = r; p.currentTime = clip.start; });
      if (done) return;
      await p.play();
    } catch { finish(); return; }
    // Stops a moment early: the phone's speaker runs slightly behind the player.
    timer = setInterval(() => { if (p.currentTime >= clip.end - 0.04 || p.ended) finish(); }, 15);
  });
}

// The microphone chosen in Settings is remembered in this browser only.
const MIC_KEY = "earmark.mic";
const savedMic = () => { try { return localStorage.getItem(MIC_KEY) || ""; } catch { return ""; } };
const saveMic = id => { try { id ? localStorage.setItem(MIC_KEY, id) : localStorage.removeItem(MIC_KEY); } catch {} };
const SPEECH_RMS = 0.015;  // the level recordAnswer counts as speech

async function openMic(deviceId = savedMic()) {
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  if (deviceId) {
    try { return await navigator.mediaDevices.getUserMedia({ audio: { ...audio, deviceId: { exact: deviceId } } }); }
    catch (e) {
      if (e.name !== "OverconstrainedError" && e.name !== "NotFoundError") throw e;
      toast(`Your chosen microphone isn't connected, so I'm using the ${WINDOWS ? "Windows default" : "default one"}.`);
    }
  }
  return navigator.mediaDevices.getUserMedia({ audio });
}

/** Live level meter for an open stream. level() returns the current loudness. */
function micMeter(stream) {
  const c = audioCtx(), analyser = c.createAnalyser(); analyser.fftSize = 1024;
  const node = c.createMediaStreamSource(stream); node.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  return {
    level() { analyser.getFloatTimeDomainData(buf); return Math.sqrt(buf.reduce((a, v) => a + v * v, 0) / buf.length); },
    stop() { node.disconnect(); },
  };
}

function meterHtml() {
  return `<div class="meter" aria-hidden="true"><i></i></div>`;
}
function setMeter(root, rms) {
  const el = $(".meter i", root);
  // Log scale: room noise sits low, normal speech fills most of the bar.
  if (el) el.style.width = `${Math.max(0, Math.min(100, (Math.log10(Math.max(rms, 1e-5)) + 4) / 3.3 * 100))}%`;
  $(".meter", root)?.classList.toggle("hot", rms > SPEECH_RMS);
}
const SILENT_HINT = `I can't hear you. If you're talking, your microphone may be muted or the wrong one. <a href="#/settings">Choose a microphone in Settings</a>.`;

/** Records from an open mic stream. Reports when speech started and keeps going while
    the learner is still mid-sentence, up to `graceMs` past the deadline. */
function recordAnswer(stream, { ms, graceMs = 4000, onTick, onSilent, silentMs = 4000, doneSilenceMs = 0, signal, stopRef }) {
  return new Promise((resolve, reject) => {
    const c = audioCtx();
    const analyser = c.createAnalyser(); analyser.fftSize = 1024;
    const micNode = c.createMediaStreamSource(stream); micNode.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    const chunks = [];
    const rec = new MediaRecorder(stream);
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    const started = performance.now();
    let onset = null, lastVoice = 0, loud = 0, floor = 0, floorN = 0, done = false, ticked = false, warned = false;
    rec.onstop = () => { micNode.disconnect(); resolve({ blob: new Blob(chunks, { type: rec.mimeType }), onsetMs: onset === null ? null : Math.round(onset) }); };
    rec.onerror = e => reject(e.error || new Error("Recording failed."));
    rec.start();
    const finish = () => { if (!done) { done = true; clearInterval(timer); if (rec.state !== "inactive") rec.stop(); } };
    if (stopRef) stopRef.stop = finish;
    signal?.addEventListener("abort", finish);
    const timer = setInterval(() => {
      const t = performance.now() - started;
      analyser.getFloatTimeDomainData(buf);
      const rms = Math.sqrt(buf.reduce((a, v) => a + v * v, 0) / buf.length);
      if (t < 150) { floor += rms; floorN++; }
      else {
        const threshold = Math.max(SPEECH_RMS, (floorN ? floor / floorN : 0) * 3);
        const inTick = ticked && t > ms - 1000 && t < ms - 800;  // our own warning tick isn't speech
        if (rms > threshold && !inTick) {
          loud++;
          lastVoice = t;
          if (loud >= 2 && onset === null) onset = t - 40;
        } else loud = 0;
      }
      if (!ticked && t >= ms - 1000) { ticked = true; tone(660, 60, 0.05); }
      onTick?.(Math.min(1, t / ms), Math.max(0, ms - t), rms);
      if (!warned && onset === null && t >= silentMs) { warned = true; onSilent?.(); }
      // A long answer ends once the learner has spoken and then stayed quiet this long.
      if (doneSilenceMs && onset !== null && t - lastVoice > doneSilenceMs) finish();
      if (t >= ms && (t - lastVoice > 700 || lastVoice === 0 || t >= ms + graceMs)) finish();
    }, 20);
  });
}

// Keeps a phone's screen on while it's waiting for a spoken answer. Phones drop the lock whenever
// the page is hidden, so it's asked for again when the page comes back.
const awake = { want: false, lock: null };
async function keepAwake(on) {
  awake.want = on;
  try {
    if (on && !awake.lock && !document.hidden && "wakeLock" in navigator) {
      const lock = await navigator.wakeLock.request("screen");
      lock.onrelease = () => { if (awake.lock === lock) awake.lock = null; };
      if (awake.want) awake.lock = lock; else lock.release();
    } else if (!on && awake.lock) {
      const lock = awake.lock; awake.lock = null; await lock.release();
    }
  } catch { /* not allowed right now: the screen may turn off */ }
}
document.addEventListener("visibilitychange", () => { if (awake.want && !document.hidden) keepAwake(true); });

function ringHtml() {
  return `<div class="ring" aria-hidden="true"><svg width="132" height="132"><circle class="track" cx="66" cy="66" r="58"/><circle class="fill" cx="66" cy="66" r="58" stroke-dasharray="364.4" stroke-dashoffset="0"/></svg><b>&nbsp;</b></div>`;
}
function setRing(root, frac, leftMs) {
  $(".fill", root).setAttribute("stroke-dashoffset", String(364.4 * frac));
  $(".ring b", root).textContent = Math.ceil(leftMs / 1000);
}

function hilite(sentence, term) {
  const safe = esc(sentence);
  // Letters may be split by punctuation in the sentence ("C-reactive"), and words by spaces or punctuation.
  const pattern = term.split(/\s+/).map(w => w.replace(/[^a-z0-9]/gi, "").split("").join("[^a-z0-9\\s]?"))
    .filter(Boolean).join("[^a-z0-9]+");
  return pattern ? safe.replace(new RegExp(pattern, "i"), m => `<mark>${m}</mark>`) : safe;
}

// ---------------------------------------------------------------- router

let cleanup = null;
async function route() {
  if (cleanup) { const c = cleanup; cleanup = null; c(); }
  const [, page, arg] = location.hash.replace(/^#/, "").split("/");
  document.querySelectorAll("[data-nav]").forEach(a => {
    const on = a.dataset.nav === (page || "library") || (page === "source" && a.dataset.nav === "library");
    a.classList.toggle("on", on);
    if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  try {
    if (page === "source") await showSource(arg);
    else if (page === "review") await showReview();
    else if (page === "weak") await showWeak();
    else if (page === "progress") await showProgress();
    else if (page === "settings") await showSettings();
    else await showLibrary();
  } catch (e) {
    view.innerHTML = `<div class="panel"><p class="error">${esc(e.message)}</p></div>`;
  }
  refreshBadges();
}
window.addEventListener("hashchange", route);

// ---------------------------------------------------------------- library

const DOC_TYPES = [".pdf", ".docx", ".txt", ".md", ".html", ".htm"];
const NOTE_UPLOAD = "Works best with clear speech in English. Keep Earmark open while a lecture is being prepared.";

async function showLibrary() {
  view.innerHTML = `
    <h1>Library</h1>
    <p class="muted">Add a lecture recording, or a PDF, Word file or notes for Gemini to read aloud. Gemini splits it into chapters and picks the terms to learn. Everything is kept on this phone.</p>
    <div class="drop" id="drop">
      <p class="drop-hint">Drop audio, a PDF or notes here, or</p>
      <div class="row" style="justify-content:center">
        <button class="primary" id="pick">Choose audio files</button>
        <button id="pick-doc">Add a PDF or notes</button>
      </div>
      <input type="file" id="doc-file" accept="${DOC_TYPES.join(",")}" hidden>
      <input type="file" id="file" accept="audio/*,.mp3,.m4a,.wav,.ogg,.opus,.flac,.aac,.webm" multiple hidden>
      <p class="muted small" id="upload-note" style="margin:.6rem 0 0">${NOTE_UPLOAD}</p>
    </div>
    <div class="panel" id="doc-panel" hidden></div>
    <div id="list"></div>`;
  const drop = $("#drop"), file = $("#file"), docFile = $("#doc-file");
  $("#pick").onclick = () => file.click();
  file.onchange = () => uploadAll(file.files);
  $("#pick-doc").onclick = () => docFile.click();
  docFile.onchange = () => { if (docFile.files[0]) askVoice(docFile.files[0]); docFile.value = ""; };
  drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove("over"); uploadAll(e.dataTransfer.files); };
  let stopped = false, timer;
  cleanup = () => { stopped = true; clearTimeout(timer); };
  const draw = async () => {
    const list = await api("/api/sources");
    if (stopped) return;
    const box = $("#list");
    box.innerHTML = list.length ? list.map(sourceCard).join("") : `<div class="panel muted">No lectures yet. Add your first one above.</div>`;
    box.querySelectorAll("[data-del]").forEach(b => b.onclick = async () => {
      if (!confirm(`Delete "${b.dataset.name}" and all progress on its concepts? This can't be undone.`)) return;
      await api(`/api/sources/${b.dataset.del}`, { method: "DELETE" });
      draw(); refreshBadges();
    });
    box.querySelectorAll("[data-retry]").forEach(b => b.onclick = async () => { await post(`/api/sources/${b.dataset.retry}/retry`); draw(); });
    if (list.some(s => s.status === "queued" || s.status === "processing")) timer = setTimeout(draw, 1500);
  };
  await draw();
  // A PDF or notes: choose the voice that reads it aloud, then it's learned like a lecture.
  function askVoice(f) {
    const panel = $("#doc-panel"), saved = (() => { try { return localStorage.getItem("earmark.voice") || "gemini"; } catch { return "gemini"; } })();
    const option = (value, name, text) => `<label class="check" style="display:flex;align-items:flex-start;gap:.5rem;margin-bottom:.25rem">
      <input type="radio" name="voice" value="${value}" ${saved.startsWith(value) ? "checked" : ""} style="margin-top:.35rem">
      <span><b>${name}</b> <span class="muted small">${text}</span></span></label>`;
    panel.hidden = false;
    panel.innerHTML = `<h2 style="overflow-wrap:anywhere">Turn “${esc(f.name)}” into a lecture</h2>
      <p class="muted small">The text is read aloud, then Earmark splits it into chapters and terms like any lecture. Page numbers, links and the reference list are left out. A scanned PDF can't be read: it holds pictures of pages, not text.</p>
      ${option("gemini", "Gemini voice", "Natural. Uses your Gemini key: about $0.55 to $0.80 per hour of audio until the end of 2026, then double, or free on Gemini's free tier. The text is sent to Google.")}
      <label class="check small"><input type="checkbox" id="doc-two" ${saved.endsWith("2") ? "checked" : ""}> Two voices take turns, section by section</label>
      <p class="small error" id="doc-msg" role="status" style="margin:.4rem 0"></p>
      <div class="row"><button class="primary" id="doc-go">Make the lecture</button><button id="doc-cancel">Cancel</button></div>`;
    panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
    $("#doc-cancel").onclick = () => { panel.hidden = true; };
    $("#doc-go").onclick = async () => {
      const voice = view.querySelector("input[name=voice]:checked").value + ($("#doc-two").checked ? "2" : "");
      try { localStorage.setItem("earmark.voice", voice); } catch {}
      $("#doc-go").disabled = true;
      $("#doc-msg").className = "small"; $("#doc-msg").textContent = `Uploading ${f.name}…`;
      try {
        await api(`/api/documents?name=${encodeURIComponent(f.name)}&voice=${voice}`, { method: "POST", body: f });
      } catch (e) {
        $("#doc-msg").className = "small error"; $("#doc-msg").textContent = e.message; $("#doc-go").disabled = false;
        return;
      }
      panel.hidden = true;
      if (!stopped) { clearTimeout(timer); draw(); }
    };
  }

  async function uploadAll(files) {
    const docs = [...files].filter(f => DOC_TYPES.some(t => f.name.toLowerCase().endsWith(t)));
    if (docs.length) askVoice(docs[0]);
    files = [...files].filter(f => !docs.includes(f));
    if (!files.length) return;
    for (const f of files) {
      $("#upload-note").textContent = `Uploading ${f.name}…`;
      try {
        await api(`/api/sources?name=${encodeURIComponent(f.name)}`, { method: "POST", body: f });
      } catch (e) { toast(e.message); }
    }
    if (!stopped) { $("#upload-note").textContent = NOTE_UPLOAD; clearTimeout(timer); draw(); }
  }
}

function sourceCard(s) {
  const del = `<button class="danger" data-del="${esc(s.id)}" data-name="${esc(s.name)}">Delete</button>`;
  if (s.status === "ready") {
    return `<div class="panel row spread"><div class="grow"><a class="source-name" href="#/source/${esc(s.id)}">${esc(s.name)}</a>
      <div class="muted small">${clock(s.duration)} · ${s.chapters} chapter${s.chapters === 1 ? "" : "s"} · ${s.concepts} concepts · ${s.listened}/${s.chapters} listened</div></div>${del}</div>`;
  }
  if (s.status === "failed") {
    return `<div class="panel row spread"><div class="grow"><b>${esc(s.name)}</b><div class="error small">${esc(s.error)}</div></div>
      <button data-retry="${esc(s.id)}">Retry</button>${del}</div>`;
  }
  return `<div class="panel"><div class="row spread"><b class="grow" style="overflow-wrap:anywhere">${esc(s.name)}</b><span class="muted small">${esc(s.stage || "Waiting")} · ${Math.round((s.progress || 0) * 100)}%</span></div>
    <div class="bar" style="margin-top:.5rem"><i style="width:${(s.progress || 0) * 100}%"></i></div></div>`;
}

// ---------------------------------------------------------------- source: preview + player

async function showSource(id) {
  let src = await api(`/api/sources/${id}`);
  if (src.status !== "ready") { location.hash = "#/"; return; }
  const saved = (() => { try { return JSON.parse(localStorage.getItem("earmark.prefs")) || {}; } catch { return {}; } })();
  const prefs = { trim: saved.trim ?? true, checkpoints: saved.checkpoints ?? true,
                  transcript: saved.transcript ?? false, follow: saved.follow ?? true, speak: saved.speak ?? true,
                  announce: saved.announce ?? true };
  const savePrefs = () => { try { localStorage.setItem("earmark.prefs", JSON.stringify(prefs)); } catch {} };

  view.innerHTML = `
    <h1>${esc(src.name)}</h1>
    ${src.note ? `<p class="muted small" style="margin-bottom:.25rem">${esc(src.note)}</p>` : ""}
    <p class="muted small">Level 1: learn the terms below so you know what's coming. Then press Play.</p>
    <div id="preview"></div>
    <div class="panel player">
      <div class="now" id="now"></div>
      <div class="small muted" id="coming"></div>
      <div class="seek"><input type="range" id="seek" min="0" max="${src.duration}" step="0.1" value="0" aria-label="Position in lecture">
        <div class="ticks" id="ticks"></div><div class="heat" id="heat"></div></div>
      <div class="row spread small muted"><span class="time" id="time">0:00</span><span class="time">${clock(src.duration)}</span></div>
      <div class="row controls">
        <button class="primary play" id="play">Play</button>
        <button id="back" aria-label="Back 5 seconds">−5s</button>
        <button id="slow" title="Goes back 5 seconds at normal speed. Press again for your speed.">Slow down</button>
        <button id="clip" title="Saves the 30 seconds around this moment">Clip this</button>
        <label class="small">Speed <select id="speed"></select></label>
        <label class="check small"><input type="checkbox" id="trim"> Skip silence</label>
        <label class="check small"><input type="checkbox" id="cp"> Stop to summarise each chapter</label>
        <label class="check small"><input type="checkbox" id="announce"> Announce new chapters</label>
      </div>
      <audio id="audio" preload="metadata"></audio>
    </div>
    <div id="checkpoint"></div>
    <div class="panel" id="whatif"></div>
    <details class="panel" id="transcript">
      <summary><b>Transcript</b> <span class="muted small">Read along while you listen, or ${TOUCH ? "tap" : "click"} a sentence to jump to it</span></summary>
      <div id="tx-body"><p class="muted small" style="margin:.5rem 0 0">Loading…</p></div>
    </details>
    <div class="panel"><h2>Chapters</h2><div id="tree"></div>
      <p class="muted small" style="margin:.75rem 0 0">Chapter names are built from the terms found in each section. ${TOUCH ? "Tap" : "Click"} Rename to change one.
        <button class="link small" id="repick">Re-pick terms</button></p></div>
    <details class="panel" id="map">
      <summary><b>Concept map</b> <span class="muted small">Which terms build on which</span></summary>
      <div id="map-body"><p class="muted small" style="margin:.5rem 0 0">Loading…</p></div>
    </details>
    <div class="mini" id="mini" hidden>
      <button class="primary play" id="mini-play">Play</button>
      <button class="mini-title" id="mini-title" aria-label="Show the player"><b id="mini-now"></b><span class="time" id="mini-time"></span></button>
      <button id="mini-clip" title="Saves the 30 seconds around this moment">Clip</button>
    </div>`;

  const audio = $("#audio"), seek = $("#seek");
  audio.src = await mediaUrl(id);
  audio.preservesPitch = true;
  const speeds = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5];
  $("#speed").innerHTML = speeds.map(s => `<option value="${s}">${s}x</option>`).join("");
  $("#speed").value = String(src.speed);
  audio.playbackRate = src.speed;
  $("#speed").onchange = e => { slowFrom = null; drawSlow(); audio.playbackRate = +e.target.value; post(`/api/sources/${id}/state`, { speed: +e.target.value }); };
  $("#trim").checked = prefs.trim; $("#trim").onchange = e => { prefs.trim = e.target.checked; savePrefs(); };
  $("#cp").checked = prefs.checkpoints; $("#cp").onchange = e => { prefs.checkpoints = e.target.checked; savePrefs(); };
  $("#announce").checked = prefs.announce; $("#announce").onchange = e => { prefs.announce = e.target.checked; savePrefs(); };
  $("#ticks").innerHTML = src.chapters.slice(1).map(c => `<i style="left:${c.start / src.duration * 100}%"></i>`).join("");
  audio.addEventListener("loadedmetadata", () => { if (src.position) audio.currentTime = src.position; }, { once: true });

  const chapterAt = t => src.chapters.find(c => t >= c.start && t < c.end) || src.chapters[src.chapters.length - 1];
  const drawTree = () => {
    const cur = chapterAt(audio.currentTime);
    $("#tree").innerHTML = src.chapters.map(c => `
      <div class="chapter ${c.id === cur.id ? "current" : ""}">
        <div class="row spread">
          <button class="ctitle grow" data-jump="${c.start}">${esc(c.title)}</button>
          <span class="muted small time">${clock(c.start)}${c.listened ? " · done" : ""}</span>
          <button class="link small" data-rename="${c.id}">Rename</button>
        </div>
        <div class="chips">${src.concepts.filter(k => k.chapter_id === c.id).map(k => `<span class="chip ${k.expert && k.level === 4 ? "expert" : `l${k.level}`}"${k.definition ? ` title="${esc(k.definition)}"` : ""}>${esc(k.term)}</span>`).join("")}</div>
      </div>`).join("");
    $("#tree").querySelectorAll("[data-jump]").forEach(b => b.onclick = () => { audio.currentTime = +b.dataset.jump; b.blur(); });
    $("#tree").querySelectorAll("[data-rename]").forEach(b => b.onclick = async () => {
      const ch = src.chapters.find(c => c.id === +b.dataset.rename);
      const title = prompt("Chapter name", ch.title);
      if (title && title.trim()) { await post(`/api/chapters/${ch.id}/title`, { title }); ch.title = title.trim(); drawTree(); showNow(); }
    });
  };
  const showNow = () => {
    const c = chapterAt(audio.currentTime);
    $("#now").textContent = c.title;
    $("#mini-now").textContent = c.title;
    // The chapter's top terms, so each chapter starts with the few to listen for.
    const top = src.concepts.filter(k => k.chapter_id === c.id).slice(0, 3).map(k => k.term);
    $("#coming").textContent = top.length ? `Listen for: ${top.join(", ")}` : "";
  };
  const reload = async () => { const pos = audio.currentTime; src = await api(`/api/sources/${id}`); audio.currentTime = pos; drawTree(); showNow(); drawWhatIf(); refreshMap(); refreshBadges(); };

  const drawPreview = () => {
    const terms = src.concepts.filter(k => k.preview);
    if (!terms.length) {
      // Lectures imported before term previews existed have none until their terms are re-picked.
      $("#preview").innerHTML = src.concepts.length ? `<div class="panel small">This lecture's terms were picked by an earlier version of Earmark.
        <button class="link small" id="repick-hint">Re-pick terms</button> to get a short list to learn before you start.</div>` : "";
      $("#repick-hint")?.addEventListener("click", repick);
      return;
    }
    $("#preview").innerHTML = `<details class="panel" ${src.position ? "" : "open"}>
      <summary><b>Before you start: ${terms.length} terms to know</b></summary>
      <p class="muted small" style="margin:.5rem 0 0">Say each term and what it means out loud before you press Play. Each chapter's other terms are listed under it below.</p>
      ${terms.map(k => `<div class="point">
        <div class="row spread"><span class="term grow">${esc(k.term)}</span>${k.context_at != null ? `<button data-say="${k.context_at}">Hear it</button>` : ""}
          <button data-known="${k.id}" title="Takes it out of this list. Review checks you really know it.">I know this</button></div>
        ${k.definition ? `<p style="margin:.2rem 0">${esc(k.definition)}</p>
          <p class="small muted" style="margin:0 0 .2rem">${k.definition_ref ? `From your references: ${esc(k.definition_ref)}.` : k.defined ? "Definition based on the lecture." : "The AI's definition, not from the lecture, so check it."}</p>` : ""}
        ${k.context ? `<p class="small" style="margin:.2rem 0">Said in the lecture: ${hilite(k.context, k.term)}</p>` : ""}
        ${k.definition || k.defined ? "" : `<p class="small muted" style="margin:0">I couldn't find where the lecture defines this, so look it up before you listen.</p>`}
      </div>`).join("")}</details>`;
    $("#preview").querySelectorAll("[data-known]").forEach(b => b.onclick = async () => {
      try { await post(`/api/concepts/${b.dataset.known}/known`); } catch (e) { toast(e.message); return; }
      const k = src.concepts.find(x => x.id === +b.dataset.known);
      if (k) { k.preview = 0; k.level = Math.max(k.level, 4); }
      toast(`“${k ? k.term : "That term"}” is out of the list. Review will check you know it.`);
      drawPreview(); drawTree(); refreshBadges();
    });
    $("#preview").querySelectorAll("[data-say]").forEach(b => b.onclick = async () => {
      const t = +b.dataset.say;
      playBuffer(await fetchClip(id, Math.max(0, t - 0.3), t + 15), cpAbort.signal);
    });
  };

  async function repick() {
    if (!confirm("Re-pick this lecture's chapters and terms?\n\n" +
                 `The AI you chose in Settings reads the saved transcript again. If ${SPEECH} could barely hear the lecture, Gemini transcribes it first.\n\n` +
                 "This resets this lecture's progress: term levels, reviews and Weak spots clips. Other lectures aren't affected.")) return;
    const b = $("#repick");
    b.disabled = true; b.textContent = "Re-picking…";
    try { await post(`/api/sources/${id}/reanalyse`); }
    catch (e) { toast(e.message); b.disabled = false; b.textContent = "Re-pick terms"; return; }
    toast("Re-picking chapters and terms. The lecture opens again from the Library when it's ready.");
    location.hash = "#/";
  }
  $("#repick").onclick = repick;

  const playBtn = $("#play"), miniPlay = $("#mini-play");
  audio.onplay = () => { playBtn.textContent = miniPlay.textContent = "Pause"; if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing"; };
  audio.onpause = () => { playBtn.textContent = miniPlay.textContent = "Play"; if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused"; saveState(); };
  const toggle = () => { if (checkpointOpen) return; audio.paused ? audio.play() : audio.pause(); };
  playBtn.onclick = miniPlay.onclick = toggle;
  // Where you slowed down, went back or clipped is saved, and shown in red on the progress bar.
  const mark = kind => {
    const at = audio.currentTime;
    src.marks.push([at, kind]);
    drawHeat();
    post(`/api/sources/${id}/marks`, { at, kind }).catch(() => {});
  };
  const drawHeat = () => {
    $("#heat").innerHTML = src.marks.map(([at]) => {
      const a = Math.max(0, at - 10) / src.duration * 100, w = Math.min(at, 10) / src.duration * 100;
      return `<i style="left:${a}%;width:${Math.max(w, 0.4)}%"></i>`;
    }).join("");
    $("#heat").title = src.marks.length ? "Red: where you slowed down, went back or clipped" : "";
  };
  const back = () => { mark("back"); audio.currentTime = Math.max(0, audio.currentTime - 5); };
  $("#back").onclick = back;
  // Slow down: back 5 seconds at normal speed. Pressing again returns to your speed.
  let slowFrom = null;
  const drawSlow = () => { $("#slow").textContent = slowFrom ? `Back to ${slowFrom}x` : "Slow down"; };
  const slow = () => {
    if (slowFrom) { audio.playbackRate = slowFrom; slowFrom = null; drawSlow(); return; }
    mark("slow");
    slowFrom = audio.playbackRate > 1 ? audio.playbackRate : null;
    audio.playbackRate = Math.min(1, audio.playbackRate);
    audio.currentTime = Math.max(0, audio.currentTime - 5);
    drawSlow();
  };
  $("#slow").onclick = slow;
  const clip = async () => {
    mark("clip");
    await post("/api/clips", { source_id: id, at: audio.currentTime });
    toast("Clipped 30 seconds to Weak spots");
    refreshBadges();
  };
  $("#clip").onclick = $("#mini-clip").onclick = clip;

  // On a phone the player scrolls away, so a small one stays at the bottom of the screen.
  const mini = $("#mini"), player = view.querySelector(".player");
  const miniSeen = new IntersectionObserver(([e]) => {
    mini.hidden = e.isIntersecting;
    document.body.classList.toggle("mini-on", !mini.hidden);
  });
  miniSeen.observe(player);
  $("#mini-title").onclick = () => player.scrollIntoView({ block: "start", behavior: "smooth" });

  // Earbud buttons: play/pause toggles, next clips, previous slows down. On a phone, the lock screen
  // and notification show the lecture with these buttons and a bar to move through it.
  const position = () => {
    const d = Number.isFinite(audio.duration) ? audio.duration : src.duration;
    try { navigator.mediaSession.setPositionState({ duration: d, playbackRate: audio.playbackRate, position: Math.min(audio.currentTime, d) }); } catch {}
  };
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: src.name, artist: "Earmark" });
    navigator.mediaSession.setActionHandler("play", toggle);
    navigator.mediaSession.setActionHandler("pause", toggle);
    navigator.mediaSession.setActionHandler("nexttrack", clip);
    navigator.mediaSession.setActionHandler("previoustrack", slow);
    try { navigator.mediaSession.setActionHandler("seekto", e => { audio.currentTime = e.seekTime; }); } catch {}
    for (const ev of ["play", "pause", "seeked", "ratechange", "loadedmetadata"]) audio.addEventListener(ev, position);
  }

  const onKey = e => {
    if (e.target.matches("input[type=text],textarea,select") || checkpointOpen) return;
    if (e.code === "Space" && e.target.tagName !== "BUTTON") { e.preventDefault(); toggle(); }
    if (e.key === "c") clip();
    if (e.key === "ArrowLeft") back();
    if (e.key === "s") slow();
  };
  document.addEventListener("keydown", onKey);

  let lastSave = 0;
  const saveState = () => { post(`/api/sources/${id}/state`, { position: audio.currentTime }).catch(() => {}); };

  // ------ transcript: loaded the first time it's opened, grouped by chapter into short paragraphs.
  // While playing, the sentence being said is highlighted and, with Follow along on, kept in view.
  let tx = null, txStarts = [], txCur = -1, txTouched = 0, onSelect = null;
  const txPanel = $("#transcript");
  const txParagraphs = () => {
    const chIndex = t => { let k = 0; src.chapters.forEach((c, j) => { if (t >= c.start) k = j; }); return k; };
    const groups = [];
    tx.lines.forEach(([start, end, text], i) => {
      const k = chIndex(start);
      let g = groups[groups.length - 1];
      if (!g || g.k !== k) groups.push(g = { k, title: src.chapters[k]?.title || "", start: src.chapters[k]?.start ?? start, paras: [] });
      let p = g.paras[g.paras.length - 1];
      const prev = i > 0 ? tx.lines[i - 1] : null;
      if (!p || p.lines.length >= 5 || (prev && start - prev[1] > 2)) g.paras.push(p = { start, lines: [] });
      p.lines.push({ i, start, text });
    });
    return groups;
  };
  const txText = groups => [src.name, tx.doc ? "The file's own text, as read aloud." : `Transcribed by ${tx.by === "this PC" ? SPEECH : tx.by}.`, ""].concat(groups.flatMap(g => [
    `${g.title} (${clock(g.start)})`, ...g.paras.map(p => `[${clock(p.start)}] ${p.lines.map(l => l.text).join(" ")}`), ""])).join("\n");
  const txByText = () => tx.doc ? "The file's own text, as read aloud. Times are worked out from the text, so a jump can land a second or two off."
    : tx.by === "this PC"
    ? `Transcribed by ${SPEECH}. It can mishear unusual or medical terms.`
    : `Transcribed by ${tx.by}. Times are approximate, so a jump can land a second or two off.`;
  let txLoading = false;
  const loadTranscript = async () => {
    if (tx || txLoading) return;
    const body = $("#tx-body");
    let got;
    txLoading = true;
    try { got = await api(`/api/sources/${id}/transcript`); }
    catch (e) { body.innerHTML = `<p class="error small" style="margin:.5rem 0 0">${esc(e.message)}</p>`; return; }
    finally { txLoading = false; }
    // A lecture the transcriber could barely hear: say so, since re-picking has Gemini transcribe it.
    const who = got.by === "this PC" ? SPEECH : esc(got.by);
    const sparse = got.sparse ? `<p class="small error" style="margin:.5rem 0 .25rem">Most of this lecture is missing here: ${who} could barely hear it.
      <button class="link small" id="tx-repick">Re-pick terms</button> to have Gemini transcribe it${got.by === "this PC" ? "" : " again"}, then pick chapters and terms from that.</p>` : "";
    if (!got.lines.length) {
      body.innerHTML = sparse || `<p class="muted small" style="margin:.5rem 0 0">The transcript is empty: no speech was found.</p>`;
      $("#tx-repick")?.addEventListener("click", repick);
      return;
    }
    tx = got;
    txStarts = tx.lines.map(l => l[0]);
    const groups = txParagraphs();
    body.innerHTML = `${sparse}
      <p class="muted small" style="margin:.5rem 0 .25rem">${esc(txByText())} Automatic transcripts can have mistakes.</p>
      <div class="row small">
        <label class="check"><input type="checkbox" id="tx-follow" ${prefs.follow ? "checked" : ""}> Follow along</label>
        <button id="tx-download">Download as text</button>
        <button id="tx-add" hidden></button>
      </div>
      <p class="muted small" style="margin:.25rem 0 0">Missing a term? Select it in the transcript to add it.</p>
      <div class="tx-box" id="tx-box">${groups.map(g => `
        <h3 class="tx-ch">${esc(g.title)} <span class="muted small time">${clock(g.start)}</span></h3>
        ${g.paras.map(p => `<p class="tx-p"><button class="link small time" data-at="${p.start}" aria-label="Play from ${clock(p.start)}">${clock(p.start)}</button>
          ${p.lines.map(l => `<span class="tx-s" data-i="${l.i}" data-at="${l.start}">${esc(l.text)}</span>`).join(" ")}</p>`).join("")}`).join("")}
      </div>`;
    $("#tx-repick")?.addEventListener("click", repick);
    const box = $("#tx-box");
    box.addEventListener("click", e => {
      const at = e.target.closest("[data-at]");
      if (at) { audio.currentTime = +at.dataset.at; txCur = -1; }
    });
    // Scrolling the transcript yourself pauses Follow along for a few seconds.
    for (const ev of ["wheel", "touchmove", "pointerdown", "keydown"]) box.addEventListener(ev, () => { txTouched = performance.now(); }, { passive: true });
    $("#tx-follow").onchange = e => { prefs.follow = e.target.checked; savePrefs(); txTouched = 0; txCur = -1; };
    // Selecting a few words in the transcript offers to add them as a term.
    const addBtn = $("#tx-add");
    let picked = null;
    onSelect = () => {
      const sel = getSelection();
      const text = sel.rangeCount && !sel.isCollapsed && box.contains(sel.getRangeAt(0).commonAncestorContainer)
        ? sel.toString().replace(/\s+/g, " ").replace(/^[^\w]+|[^\w]+$/g, "") : "";
      const n = text ? text.split(" ").length : 0;
      picked = n >= 1 && n <= 6 ? { term: text, at: +((sel.anchorNode.parentElement?.closest("[data-at]") || {}).dataset?.at || audio.currentTime) } : null;
      addBtn.hidden = !picked;
      if (picked) addBtn.textContent = `Add “${picked.term}” as a term`;
    };
    document.addEventListener("selectionchange", onSelect);
    addBtn.onclick = async () => {
      if (!picked) return;
      try {
        const r = await post(`/api/sources/${id}/concepts`, picked);
        toast(`Added “${r.term}” to ${r.chapter}.${r.cards ? "" : " It has no review prompts: the lecture never says it clearly enough to cut it out."}`);
        getSelection().removeAllRanges();
        await reload();
      } catch (e) { toast(e.message); }
    };
    $("#tx-download").onclick = () => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([txText(groups)], { type: "text/plain;charset=utf-8" }));
      a.download = `${src.name.replace(/[\\/:*?"<>|]+/g, " ").trim() || "Lecture"} transcript.txt`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    txCur = -1;
    markLine(audio.currentTime, true);
  };
  const markLine = (t, jump = false) => {
    if (!tx || !txPanel.open) return;
    let lo = 0, hi = txStarts.length - 1, k = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (txStarts[m] <= t + 0.05) { k = m; lo = m + 1; } else hi = m - 1; }
    if (k === txCur) return;
    const box = $("#tx-box");
    box.querySelector(".tx-s.on")?.classList.remove("on");
    txCur = k;
    const el = box.querySelector(`[data-i="${k}"]`);
    if (!el) return;
    el.classList.add("on");
    const follow = $("#tx-follow").checked && performance.now() - txTouched > 6000 && (jump || !audio.paused);
    if (follow) box.scrollTo({ top: Math.max(0, el.offsetTop - box.clientHeight / 3), behavior: jump ? "auto" : "smooth" });
  };
  txPanel.addEventListener("toggle", () => {
    prefs.transcript = txPanel.open; savePrefs();
    if (txPanel.open) { if (tx) { txCur = -1; markLine(audio.currentTime, true); } else loadTranscript(); }
  });
  txPanel.open = prefs.transcript;  // opening it fires "toggle", which loads it

  // Silence skipping and chapter checkpoints run on one loop while playing.
  const silences = src.silences;
  const silenceAt = t => {
    let lo = 0, hi = silences.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (t < silences[m][0]) hi = m - 1; else if (t >= silences[m][1]) lo = m + 1; else return silences[m];
    }
    return null;
  };
  let prevT = 0, prevAt = performance.now(), curId = null, raf, seeking = false, checkpointOpen = false;
  // Runs every frame while the page is shown, and on a timer while it's hidden (a phone's screen
  // is off), so silence skipping and chapter checkpoints keep working with the phone in a pocket.
  const tick = () => {
    const t = audio.currentTime, at = performance.now();
    if (!document.hidden) {
      if (!seeking) seek.value = t;
      $("#time").textContent = clock(t);
      if (!mini.hidden) $("#mini-time").textContent = `${clock(t)} / ${clock(src.duration)}`;
      markLine(t);
    }
    // How far the lecture can play by itself since the last tick. Further than that is a jump.
    const step = Math.max(2, (at - prevAt) / 1000 * audio.playbackRate + 1);
    prevAt = at;
    const c = chapterAt(t);
    if (c.id !== curId) {
      const was = src.chapters.find(x => x.id === curId);
      curId = c.id; showNow(); drawTree();
      // Only a natural crossing counts as finishing a chapter, not jumping around.
      if (was && !audio.paused && t >= was.end && t - was.end < step && t - prevT < step && !hitCheckpoint(was)
          && prefs.announce) announce(c);
    }
    if (audio.paused) { prevT = t; return; }
    if ($("#trim").checked) {
      const s = silenceAt(t);
      if (s && s[1] - t > 0.05) audio.currentTime = s[1];
    }
    if (performance.now() - lastSave > 5000) { lastSave = performance.now(); saveState(); }
    prevT = t;
  };
  const loop = () => { raf = requestAnimationFrame(loop); tick(); };
  const hiddenTick = setInterval(() => { if (document.hidden) tick(); }, 250);
  audio.onended = () => hitCheckpoint(src.chapters[src.chapters.length - 1]);
  seek.oninput = () => { seeking = true; $("#time").textContent = clock(+seek.value); };
  seek.onchange = () => {
    if (audio.currentTime - +seek.value > 3) mark("back");
    audio.currentTime = +seek.value; seeking = false;
  };

  // A chime and the new chapter's name, so you know where you are with the screen off.
  async function announce(ch) {
    if (checkpointOpen) return;
    checkpointOpen = true;
    audio.pause();
    await tone(660, 110, 0.18); await tone(990, 160, 0.18);
    await say(`Next: ${ch.title}`, cpAbort.signal);
    checkpointOpen = false;
    if (!cpAbort.signal.aborted) audio.play();
  }

  // Returns true when it stops for the checkpoint.
  function hitCheckpoint(ch) {
    if (ch.listened || checkpointOpen) return false;
    if (!$("#cp").checked) { post(`/api/chapters/${ch.id}/skip`).then(reload); return false; }
    audio.pause();
    checkpointOpen = true;
    keepAwake(true);
    runCheckpoint(ch, $("#checkpoint"), async () => {
      checkpointOpen = false;
      keepAwake(false);
      await reload();
      $("#checkpoint").innerHTML = "";
      if (ch.id !== src.chapters[src.chapters.length - 1].id) audio.play();
    }, reload);
    return true;
  }

  const cpAbort = new AbortController();
  cleanup = () => { cancelAnimationFrame(raf); clearInterval(hiddenTick); audio.pause(); saveState(); audio.removeAttribute("src"); audio.load(); document.removeEventListener("keydown", onKey); cpAbort.abort();
    miniSeen.disconnect(); document.body.classList.remove("mini-on", "wi-on"); keepAwake(false);
    if (onSelect) document.removeEventListener("selectionchange", onSelect);
    if ("mediaSession" in navigator) for (const a of ["play", "pause", "nexttrack", "previoustrack", "seekto"]) try { navigator.mediaSession.setActionHandler(a, null); } catch {} };
  drawTree(); showNow(); drawPreview(); drawHeat(); loop();

  // ------ concept map: each chapter's terms in a column, with arrows from a term to the ones built on it.
  const mapPanel = $("#map");
  let mapData = null, mapPicked = null;
  const loadMap = async () => {
    const body = $("#map-body");
    try {
      mapData = await api(`/api/sources/${id}/map`);
      if (!mapData.by) {
        body.innerHTML = `<p class="muted small" style="margin:.5rem 0 0">Making the map…</p>`;
        mapData = await post(`/api/sources/${id}/map`);
        if (mapData.notice) toast(mapData.notice);
      }
    } catch (e) { body.innerHTML = `<p class="error small" style="margin:.5rem 0 0">${esc(e.message)}</p>`; mapData = null; return; }
    drawMap();
  };
  const drawMap = () => {
    const body = $("#map-body"), d = mapData;
    const cols = d.chapters.map(ch => ({ ch, terms: d.terms.filter(t => t.chapter_id === ch.id) })).filter(c => c.terms.length);
    if (!cols.length) { body.innerHTML = `<p class="muted small" style="margin:.5rem 0 0">This lecture has no terms yet.</p>`; return; }
    const W = t => Math.min(170, 18 + t.length * 6.4), ROW = 34, TOP = 34, GAP = 64;
    const pos = {};
    let x = 8, height = 0;
    const heads = cols.map(c => {
      const w = Math.max(...c.terms.map(t => W(t.term)), 90);
      c.terms.forEach((t, i) => { pos[t.id] = { x, y: TOP + i * ROW, w }; });
      height = Math.max(height, TOP + c.terms.length * ROW);
      const head = { x, w, title: c.ch.title.length > 26 ? c.ch.title.slice(0, 25) + "…" : c.ch.title };
      x += w + GAP;
      return head;
    });
    const width = x - GAP + 8;
    const links = d.links.filter(([a, b]) => pos[a] && pos[b]);
    const edge = ([a, b], i) => {
      const p = pos[b], q = pos[a];  // from the term it builds on (p) to the term (q)
      const y1 = p.y + 12, y2 = q.y + 12;
      let path;
      if (p.x === q.x) {  // same chapter: a loop on the left
        const bend = 20 + Math.abs(y2 - y1) / 6;
        path = `M${p.x} ${y1} C${p.x - bend} ${y1}, ${q.x - bend} ${y2}, ${q.x} ${y2}`;
      } else {
        const [x1, x2] = p.x < q.x ? [p.x + p.w, q.x] : [p.x, q.x + q.w];
        const dx = (x2 - x1) / 2;
        path = `M${x1} ${y1} C${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
      }
      return `<path class="me" data-i="${i}" d="${path}" marker-end="url(#mh)"/>`;
    };
    const level = t => t.expert && t.level === 4 ? "expert" : `l${t.level}`;
    body.innerHTML = `<p class="muted small" style="margin:.5rem 0 .25rem">An arrow points from a term to the terms built on it. ${TOUCH ? "Tap" : "Click"} a term to see its links. Made by ${esc(d.by === "this PC" ? `${PC}, from the terms' definitions` : d.by)}.
        <button class="link small" id="map-redo">Make again</button></p>
      <div class="map-wrap"><svg class="cmap" width="${width}" height="${height + 8}" viewBox="0 0 ${width} ${height + 8}" role="img" aria-label="Concept map">
        <defs><marker id="mh" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8z"/></marker></defs>
        ${heads.map(h => `<text class="mh-t" x="${h.x}" y="18">${esc(h.title)}</text>`).join("")}
        ${links.map(edge).join("")}
        ${d.terms.filter(t => pos[t.id]).map(t => `<g class="mn ${level(t)}" data-id="${t.id}" tabindex="0" role="button" aria-label="${esc(t.term)}">
          <title>${esc(t.term)}${t.definition ? `: ${esc(t.definition)}` : ""}</title>
          <rect x="${pos[t.id].x}" y="${pos[t.id].y}" width="${pos[t.id].w}" height="24" rx="12"/>
          <text x="${pos[t.id].x + 9}" y="${pos[t.id].y + 16}">${esc(t.term.length > 26 ? t.term.slice(0, 25) + "…" : t.term)}</text></g>`).join("")}
      </svg></div>
      <p class="small" id="map-detail" role="status" style="margin:.5rem 0 0">${links.length ? "" : "No links were found between this lecture's terms."}</p>`;
    const name = cid => d.terms.find(t => t.id === cid)?.term || "";
    const pick = cid => {
      mapPicked = mapPicked === cid ? null : cid;
      const on = new Set();
      body.querySelectorAll(".me").forEach(e => {
        const [a, b] = links[+e.dataset.i];
        const hit = mapPicked !== null && (a === mapPicked || b === mapPicked);
        e.classList.toggle("on", hit);
        if (hit) { on.add(a); on.add(b); }
      });
      body.querySelectorAll(".mn").forEach(n => {
        n.classList.toggle("on", +n.dataset.id === mapPicked);
        n.classList.toggle("dim", mapPicked !== null && !on.has(+n.dataset.id) && +n.dataset.id !== mapPicked);
      });
      if (mapPicked === null) { $("#map-detail").textContent = ""; return; }
      const needs = links.filter(([a]) => a === mapPicked).map(([, b, how]) => `${name(b)}${how && how !== "uses" ? ` (${how})` : ""}`);
      const used = links.filter(([, b]) => b === mapPicked).map(([a]) => name(a));
      $("#map-detail").innerHTML = `<b>${esc(name(mapPicked))}</b>${needs.length ? ` builds on ${esc(needs.join(", "))}.` : " doesn't build on other terms here."}${
        used.length ? ` Needed for ${esc(used.join(", "))}.` : ""}`;
    };
    body.querySelectorAll(".mn").forEach(n => {
      n.onclick = () => pick(+n.dataset.id);
      n.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(+n.dataset.id); } };
    });
    $("#map-redo").onclick = async () => {
      $("#map-body").innerHTML = `<p class="muted small" style="margin:.5rem 0 0">Making the map…</p>`;
      try { mapData = await post(`/api/sources/${id}/map`); if (mapData.notice) toast(mapData.notice); mapPicked = null; drawMap(); }
      catch (e) { toast(e.message); drawMap(); }
    };
  };
  mapPanel.addEventListener("toggle", () => { if (mapPanel.open && !mapData) loadMap(); });
  // Levels and terms change as you learn: an open map is redrawn, a closed one reloads when opened.
  function refreshMap() { if (mapData) { if (mapPanel.open) loadMap(); else mapData = null; } }

  // ------ Level 5 Expert: what-if questions about the chapters already explained. The lecture plays
  // the part a question builds on, then asks what would change if one thing were different.
  const wiBox = $("#whatif");
  const KIND_LABEL = { what_if: "What if", statement: "Spot the error", compare: "Lecture and your references" };
  const expertItem = q => {
    const clip = [{ sid: id, start: q.lead_start, end: q.clip_end }];
    const label = `${KIND_LABEL[q.kind] || "What if"} · ${q.chapter}`;
    // A statement is heard before the lecture: hearing the passage first would give the error away.
    if (q.kind === "statement") return { kind: q.kind, label, intro: "Is this right? If not, what's wrong?", question: q.question,
                                         spoken: `Is this right? ${q.question}`, before: [], after: clip, placeholder: "Right or wrong, and why?" };
    return { kind: q.kind, label, question: q.question, before: clip, placeholder: "What would change, and why?",
             note: q.beyond ? "This one goes a little beyond the lecture." : "" };
  };
  let wiRunning = false;
  drawWhatIf();

  async function drawWhatIf() {
    if (wiRunning) return;
    let st;
    try { st = await api(`/api/sources/${id}/whatifs`); }
    catch (e) { wiBox.innerHTML = `<p class="error small" style="margin:0">${esc(e.message)}</p>`; return; }
    if (wiRunning || !view.contains(wiBox)) return;
    const n = st.questions.length, sound = st.questions.filter(q => q.status === "sound").length;
    const chapters = c => `${c} chapter${c === 1 ? "" : "s"}`;
    const body = !st.ai ? `<p class="small" style="margin:0">Claude or Gemini writes and checks these questions. <a href="#/settings">Choose one in Settings</a>.</p>`
      : !st.finished ? `<p class="small" style="margin:0">Finish a chapter first: the questions are about chapters you've explained.</p>`
      : `<p class="small">${n ? `${sound} of ${n} answered soundly, from ${chapters(st.finished)} you've finished.` : `You've finished ${chapters(st.finished)}.`}${
          st.pending ? ` Questions for ${n ? `${chapters(st.pending)} more` : "them"} are written when you start, which can take a minute.` : ""}</p>
        <div class="row">
          <button class="primary" id="wi-voice">Start speaking</button>
          <button id="wi-type">Type answers instead</button>
          <label class="check small"><input type="checkbox" id="wi-speak" ${prefs.speak ? "checked" : ""}> Read questions aloud</label>
        </div>`;
    wiBox.innerHTML = `<h2>Expert questions <span class="muted small">Level 5 Expert</span></h2>
      <p class="muted small">What would change if one thing were different, statements that may hide a planted error, and, with your references on, where they add to the lecture. Answer out loud.</p>${body}`;
    $("#wi-voice", wiBox)?.addEventListener("click", () => runWhatIfs("voice"));
    $("#wi-type", wiBox)?.addEventListener("click", () => runWhatIfs("type"));
    $("#wi-speak", wiBox)?.addEventListener("change", e => { prefs.speak = e.target.checked; savePrefs(); });
  }

  async function runWhatIfs(mode) {
    wiRunning = checkpointOpen = true;  // the lecture stays paused until the questions end
    document.body.classList.add("wi-on");
    audio.pause();
    keepAwake(true);
    const abort = new AbortController(), stopAll = () => abort.abort();
    cpAbort.signal.addEventListener("abort", stopAll);
    let stream = null, failed = null;
    const results = [];
    try {
      if (mode === "voice") {
        try { stream = await openMic(); }
        catch { throw new Error("Your microphone isn't available. Allow it in the browser, or type your answers."); }
      }
      wiBox.innerHTML = `<p class="muted" style="margin:0">Getting the questions…</p>`;
      let st = await api(`/api/sources/${id}/whatifs`);
      if (st.pending) {
        wiBox.innerHTML = `<p class="muted" style="margin:0">Writing questions for ${st.pending} chapter${st.pending === 1 ? "" : "s"}. This can take a minute…</p>`;
        st = await post(`/api/sources/${id}/whatifs`);
        if (st.notice?.includes("busy")) toast(st.notice);
      }
      let queue = st.questions.filter(q => q.status !== "sound");
      if (!queue.length) queue = st.questions;  // all answered soundly: go through them again
      if (!queue.length) throw new Error("There are no questions for the chapters you've finished yet.");
      wiBox.scrollIntoView({ block: "start", behavior: "smooth" });
      for (let i = 0; i < queue.length && !abort.signal.aborted; i++) {
        const q = queue[i];
        const r = await askOne({ box: wiBox, item: expertItem(q), i, n: queue.length, mode, stream, signal: abort.signal,
                                 onStop: stopAll, speak: prefs.speak, answerUrl: `/api/whatifs/${q.id}/answer`,
                                 overruleUrl: `/api/whatifs/${q.id}/overrule` });
        if (r) results.push(r);
      }
    } catch (e) {
      if (!abort.signal.aborted) failed = e.message;
    } finally {
      stream?.getTracks().forEach(t => t.stop());
      if ("speechSynthesis" in window) speechSynthesis.cancel();
      keepAwake(false);
      cpAbort.signal.removeEventListener("abort", stopAll);
      checkpointOpen = false;
      document.body.classList.remove("wi-on");
    }
    if (cpAbort.signal.aborted) return;  // left the page
    if (!results.length && !failed) { wiRunning = false; drawWhatIf(); return; }  // stopped before answering any
    if (results.some(r => r.verdict === "sound")) await reload();  // terms may now be Expert
    wiBox.innerHTML = `${failed ? `<p class="error">${esc(failed)}</p>` : ""}
      ${results.length ? questionsSummary(results, "Questions you haven't answered soundly come first next time.") : ""}
      <div class="row" style="margin-top:.5rem"><button class="primary" id="wi-close">Done</button></div>`;
    $("#wi-close", wiBox).onclick = () => { wiRunning = false; drawWhatIf(); };
  }

  // ------ checkpoint
  async function runCheckpoint(ch, box, done, onGraded) {
    box.innerHTML = `<div class="panel stage">
      <h2>Chapter finished: ${esc(ch.title)}</h2>
      <p>Explain it out loud in your own words, as if teaching someone.</p>
      <div id="cp-body"></div>
      <div class="row" style="justify-content:center;margin-top:.75rem">
        <button class="primary" id="cp-speak">Start speaking (60s)</button>
        <button id="cp-type">Type instead</button>
        <button id="cp-skip">Skip</button>
      </div></div>`;
    box.scrollIntoView({ block: "center" });
    tone(880, 160);
    const body = $("#cp-body", box);
    $("#cp-skip", box).onclick = async () => { await post(`/api/chapters/${ch.id}/skip`); done(); };
    $("#cp-type", box).onclick = () => {
      body.innerHTML = `<textarea id="cp-text" aria-label="Your summary" placeholder="Explain the chapter in your own words…"></textarea>
        <button class="primary" id="cp-send" style="margin-top:.5rem">Check my explanation</button>`;
      $("#cp-text", box).focus();
      $("#cp-send", box).onclick = () => grade(post(`/api/chapters/${ch.id}/summary`, { text: $("#cp-text", box).value }));
    };
    $("#cp-speak", box).onclick = async () => {
      let stream;
      try { stream = await openMic(); }
      catch { body.innerHTML = `<p class="error">Your microphone isn't available. Allow it in the browser, or type instead.</p>`; return; }
      body.innerHTML = ringHtml() + meterHtml() + `<p class="error small" id="cp-silent" role="status" hidden>${SILENT_HINT}</p><button id="cp-stop">I'm done</button>`;
      $("#cp-speak", box).hidden = $("#cp-type", box).hidden = $("#cp-skip", box).hidden = true;
      await tone(880, 160);
      const stopRef = {};
      $("#cp-stop", box).onclick = () => stopRef.stop?.();
      let heardAny = false;
      const { blob } = await recordAnswer(stream, { ms: 60000, graceMs: 0, signal: cpAbort.signal, stopRef,
        onTick: (f, left, rms) => {
          setRing(body, f, left); setMeter(body, rms);
          if (rms > SPEECH_RMS && !heardAny) { heardAny = true; const w = $("#cp-silent", box); if (w) w.hidden = true; }
        },
        onSilent: () => { const w = $("#cp-silent", box); if (w) w.hidden = false; } });
      stream.getTracks().forEach(t => t.stop());
      if (cpAbort.signal.aborted) return;
      if (!heardAny) {
        // Nothing loud enough ever reached the mic: don't send silence to be transcribed.
        body.innerHTML = `<p class="error">${SILENT_HINT}</p>`;
        $("#cp-speak", box).hidden = $("#cp-type", box).hidden = $("#cp-skip", box).hidden = false;
        return;
      }
      grade(api(`/api/chapters/${ch.id}/summary`, { method: "POST", body: blob }));
    };

    async function grade(request) {
      body.innerHTML = `<p class="muted">Checking what you said…</p>`;
      $("#cp-speak", box).hidden = $("#cp-type", box).hidden = true;
      $("#cp-skip", box).hidden = false;
      let r;
      try { r = await request; } catch (e) { body.innerHTML = `<p class="error">${esc(e.message)}</p>`; $("#cp-type", box).hidden = false; return; }
      if (r.empty) { body.innerHTML = `<p>I didn't catch any speech. Try again, or type it.</p>`; $("#cp-speak", box).hidden = $("#cp-type", box).hidden = false; return; }
      const hit = r.concepts.filter(c => c.covered).length;
      const stage = box.querySelector(".stage");
      stage.classList.remove("stage");
      const VERDICT = { solid: ["You explained this well", "right"], partial: ["You're partly there", ""], off_track: ["This needs another listen", "wrong"] };
      const STATUS = { correct: ["Correct", "right"], partial: ["Partly right", ""], missing: ["Missed", "wrong"], wrong: ["Incorrect", "wrong"] };
      const BEYOND = { supported: ["Backed by your references", "right"], contradicted: ["Your references disagree", "wrong"],
                       unverified: ["Not checked: not in the lecture or your references", "muted"] };
      const heard = `<details class="small" style="margin-bottom:.5rem"><summary>What I heard${r.heard_by ? ` (heard by ${esc(r.heard_by)})` : ""}</summary><p>${esc(r.heard)}</p></details>
        ${r.hear_notice ? `<p class="small muted">${esc(r.hear_notice)}</p>` : ""}`;
      // Below the standard, the chapter is relearned (split in two when it's long enough) and checked again.
      const std = r.standard || {}, pct = x => `${Math.round(x * 100)}%`;
      const mins = p => Math.max(1, Math.round((p.end - p.start) / 60));
      const scoreText = std.score != null && std.score < std.pass ? `: ${pct(std.score)}, and the standard is ${pct(std.pass)}` : "";
      let next;
      if (r.split) {
        next = `<div class="panel" style="margin-top:.75rem">
          <p><b>Below the standard${scoreText}.</b> I've split this chapter in two so you can relearn it in shorter pieces:
          part 1 is about ${mins(r.split.first)} min and part 2 about ${mins(r.split.second)} min.
          Listen to part 1 again and explain it, then do the same for part 2.</p>
          <div class="row"><button class="primary" id="cp-replay" data-at="${r.split.first.start}">Replay part 1</button><button id="cp-next">Not now</button></div></div>`;
      } else if (std.below) {
        next = `<div class="panel" style="margin-top:.75rem">
          <p><b>Below the standard${scoreText}.</b> This chapter is too short to split, so listen to it again and explain it again.</p>
          <div class="row"><button class="primary" id="cp-replay" data-at="${ch.start}">Replay this chapter</button><button id="cp-next">Not now</button></div></div>`;
      } else {
        const met = std.score != null && std.score >= std.pass ? `${pct(std.score)}: you met the standard of ${pct(std.pass)}.` : "You met the standard.";
        next = `${std.score != null ? `<p class="small right" style="margin-top:.75rem">${met}</p>` : ""}
          <div class="row" style="margin-top:.75rem"><button class="primary" id="cp-next">Continue</button></div>`;
      }
      // What you missed, in the lecture's own words, to say out loud once: saying it helps it stick.
      const sayAloud = points => {
        const missed = points.filter(p => p.status !== "correct" && p.lecture_quote);
        return missed.length ? `<div class="point readaloud"><h2 style="margin:0 0 .25rem">Say these out loud</h2>
          <p class="muted small" style="margin:0 0 .4rem">The lecture's own words for what you missed. Read each one aloud once. Keep your explanations in your own words.</p>
          ${missed.map(p => `<p style="margin:.3rem 0">“${esc(p.lecture_quote)}”${p.at !== null ? ` <button class="link small" data-hear="${p.at}">Hear it</button>` : ""}</p>`).join("")}</div>` : "";
      };
      const termRows = (yes, no) => r.concepts.map(c => `<div class="result-row" data-row="${c.id}">
          <span class="term">${esc(c.term)}</span>
          ${c.covered ? `<span class="right small">${yes}</span>` : `<span class="row"><button data-hear="${c.first_at}">Hear it</button><button data-said="${c.id}">${no}</button></span>`}
        </div>`).join("");
      if (r.points) {
        stage.innerHTML = `<h2 class="${VERDICT[r.verdict][1]}">${VERDICT[r.verdict][0]}</h2>
          <p>${esc(r.summary)}</p>
          ${r.notice ? `<p class="muted small">${esc(r.notice)}</p>` : ""}
          ${heard}
          <div>${r.points.map(p => `<div class="point">
            <div class="row spread"><span class="term grow">${esc(p.idea)}</span><span class="small ${STATUS[p.status][1]}">${STATUS[p.status][0]}</span></div>
            <p class="small" style="margin:.2rem 0">${esc(p.feedback)}</p>
            ${p.lecture_quote ? `<p class="small muted" style="margin:.2rem 0">Lecture: “${esc(p.lecture_quote)}”</p>` : (p.status === "wrong" ? `<p class="small muted" style="margin:.2rem 0">I couldn't find this in the lecture, so check it yourself.</p>` : "")}
            ${p.reference ? `<p class="small muted" style="margin:.2rem 0">${esc(p.reference)}: “${esc(p.reference_quote)}”</p>` : ""}
            <div class="row">
              ${p.at !== null ? `<button data-hear="${p.at}">Hear it</button>` : ""}
              ${p.clip_id ? `<button data-unclip="${p.clip_id}">I did explain this</button>` : ""}
            </div></div>`).join("")}</div>
          ${(r.beyond || []).length ? `<h2 style="margin-top:1rem">Beyond the lecture</h2>
          <div>${r.beyond.map(b => `<div class="point">
            <div class="row spread"><span class="term grow">${esc(b.claim)}</span><span class="small ${BEYOND[b.verdict][1]}">${BEYOND[b.verdict][0]}</span></div>
            ${b.feedback ? `<p class="small" style="margin:.2rem 0">${esc(b.feedback)}</p>` : ""}
            ${b.reference ? `<p class="small muted" style="margin:.2rem 0">${esc(b.reference)}: “${esc(b.reference_quote)}”</p>` : ""}
          </div>`).join("")}</div>` : ""}
          ${sayAloud(r.points)}
          <h2 style="margin-top:1rem">Terms</h2>
          <div>${termRows("Understood", "I understood this")}</div>
          <p class="muted small" style="margin-top:.75rem">AI feedback can be wrong. ${r.used_refs ? "It compares you with this lecture's automatic transcript and passages from your references" : "It only compares you with this lecture's automatic transcript"}, so check anything important.</p>
          ${next}`;
      } else {
        const why = r.notice ? `<p class="error small">${esc(r.notice)} Only the term check ran this time.</p>`
          : r.ai_enabled ? "" : `<p class="small">To check your explanation itself, <a href="#/settings">add an API key in Settings</a>.</p>`;
        stage.innerHTML = `<h2>You covered ${hit} of ${r.concepts.length} key terms</h2>
          ${why}
          <p class="muted small">This checks whether you said the terms, not whether your explanation was correct. Terms you missed go to Weak spots.</p>
          ${heard}
          <div>${termRows("Covered", "I did say this")}</div>
          ${next}`;
      }
      stage.querySelectorAll("[data-unclip]").forEach(b => b.onclick = async () => {
        await api(`/api/clips/${b.dataset.unclip}`, { method: "DELETE" });
        b.replaceWith(Object.assign(document.createElement("span"), { className: "muted small", textContent: "Removed from Weak spots" }));
        refreshBadges();
      });
      stage.querySelectorAll("[data-hear]").forEach(b => b.onclick = async () => {
        const t = +b.dataset.hear;
        playBuffer(await fetchClip(id, Math.max(0, t - 15), t + 15), cpAbort.signal);
      });
      stage.querySelectorAll("[data-said]").forEach(b => b.onclick = async () => {
        await post(`/api/concepts/${b.dataset.said}/covered`);
        b.closest(".row").innerHTML = `<span class="right small">${r.points ? "Understood" : "Covered"}</span>`;
        refreshBadges();
      });
      $("#cp-next", box).onclick = done;
      const replay = $("#cp-replay", box);
      if (replay) replay.onclick = () => replayFrom(+replay.dataset.at);
      onGraded();
    }
  }

  // Back to the start of a part to relearn it. Crossing its end naturally opens its checkpoint again.
  async function replayFrom(t) {
    checkpointOpen = false;
    keepAwake(false);
    await reload();
    $("#checkpoint").innerHTML = "";
    audio.currentTime = t;
    audio.play();
  }
}

// ---------------------------------------------------------------- expert questions, asked one at a time

const VERDICTS = { sound: ["Sound reasoning", "right"], partial: ["Partly there", ""], unsound: ["Not quite", "wrong"] };
const verdictWords = (kind, v) => kind === "statement"
  ? { sound: ["Well checked", "right"], partial: ["Partly there", ""], unsound: ["Not quite", "wrong"] }[v] : VERDICTS[v];

/** One question: hear the parts of the lecture it builds on, hear or read the question, answer out loud
    or typed, see the check. Used for what-if questions, spotting errors, comparing with references and
    telling terms apart. item: {kind, label, intro, question, spoken, note, placeholder, before, after},
    where before and after are clips {sid, start, end, label} played before asking and offered after.
    Returns {question, kind, verdict}, or null when skipped or stopped. */
async function askOne({ box, item, i, n, mode, stream, signal, onStop, speak, answerUrl, overruleUrl }) {
  const head = `<div class="row spread small muted" style="margin-bottom:.25rem"><span class="grow">Question ${i + 1} of ${n}${item.label ? ` · ${esc(item.label)}` : ""}</span>
    <button class="link small" data-stop>Stop</button></div>`;
  const show = html => { box.innerHTML = head + html; box.querySelector("[data-stop]").onclick = onStop; };
  // Shows html with buttons; resolves with the key of the one pressed, or null when stopped.
  const choose = (html, buttons, center = true) => new Promise(res => {
    show(`<div class="${center ? "stage" : ""}">${html}<div class="row" style="margin-top:.75rem${center ? ";justify-content:center" : ""}">
      ${buttons.map(([k, label, primary]) => `<button data-choose="${k}"${primary ? ' class="primary"' : ""}>${label}</button>`).join("")}</div></div>`);
    box.querySelectorAll("[data-choose]").forEach(b => b.onclick = () => res(b.dataset.choose));
    signal.addEventListener("abort", () => res(null), { once: true });
  });
  const load = list => Promise.all((list || []).map(c => fetchClip(c.sid, c.start, c.end).then(buf => ({ ...c, buf }))));
  const before = await load(item.before), after = item.after ? await load(item.after) : before;
  const listen = async clips => {
    for (const [k, c] of clips.entries()) {
      if (signal.aborted) return;
      if (k) await tone(520, 90, 0.12);
      show(`<div class="stage"><p class="say">Listen…</p><p class="muted">${esc(c.label || "The part of the lecture this question builds on.")}</p></div>`);
      await playBuffer(c.buf, signal);
    }
  };
  if (before.length) {
    await listen(before);
    if (signal.aborted) return null;
    await tone(880, 160);
  }
  const question = `${item.intro ? `<p class="muted" style="margin:0">${esc(item.intro)}</p>` : ""}<p class="say">${esc(item.question)}</p>${
    item.note ? `<p class="muted small">${esc(item.note)}</p>` : ""}`;
  const hearLabel = after.length > 1 ? "Hear them again" : before.length ? "Hear the part again" : "Hear the lecture";
  const hear = after.length ? [["listen", hearLabel]] : [];
  let how = mode;
  for (;;) {
    if (signal.aborted) return null;
    let request;
    if (how === "voice") {
      show(`<div class="stage">${question}${speak ? `<p class="muted small">Reading the question…</p>` : ""}</div>`);
      if (speak) await say(item.spoken || item.question, signal);
      if (signal.aborted) return null;
      show(`<div class="stage">${question}${ringHtml()}${meterHtml()}
        <p class="error small" data-silent role="status" hidden>${SILENT_HINT}</p>
        <div class="row" style="justify-content:center"><button data-done>I'm done</button></div></div>`);
      await tone(660, 120);
      const stopRef = {};
      box.querySelector("[data-done]").onclick = () => stopRef.stop?.();
      let heardAny = false;
      const { blob } = await recordAnswer(stream, { ms: 90000, graceMs: 0, silentMs: 15000, doneSilenceMs: 5000, signal, stopRef,
        onTick: (f, left, rms) => { setRing(box, f, left); setMeter(box, rms); if (rms > SPEECH_RMS) heardAny = true; },
        onSilent: () => { const w = box.querySelector("[data-silent]"); if (w) w.hidden = false; } });
      if (signal.aborted) return null;
      if (!heardAny) {
        // Nothing loud enough reached the mic: don't send silence to be checked.
        const c = await choose(`${question}<p class="error small">${SILENT_HINT}</p>`,
          [["again", "Try again", true], ["type", "Type instead"], ...hear, ["skip", "Skip"]]);
        if (c === "type") how = "type";
        if (c === "listen") await listen(after);
        if (c === "skip" || c === null) return null;
        continue;
      }
      request = api(answerUrl, { method: "POST", body: blob });
    } else {
      show(`<div class="stage">${question}
        <textarea aria-label="Your answer" placeholder="${esc(item.placeholder || "Your answer…")}"></textarea>
        <div class="row" style="justify-content:center;margin-top:.5rem"><button class="primary" data-send>Check my answer</button>
          <button data-skip>Skip</button></div></div>`);
      if (speak) say(item.spoken || item.question, signal);
      if (!TOUCH) box.querySelector("textarea").focus();
      const text = await new Promise(res => {
        box.querySelector("[data-send]").onclick = () => res(box.querySelector("textarea").value);
        box.querySelector("[data-skip]").onclick = () => res(null);
        signal.addEventListener("abort", () => res(null), { once: true });
      });
      if (text === null) return null;
      if (!text.trim()) continue;
      request = post(answerUrl, { text });
    }
    show(`<div class="stage"><p class="muted">Checking your answer…</p></div>`);
    let r;
    try { r = await request; }
    catch (e) {
      const c = await choose(`<p class="error">${esc(e.message)}</p>`, [["again", "Try again", true], ["skip", "Skip"]]);
      if (c === "again") continue;
      return null;
    }
    if (signal.aborted) return null;
    if (r.empty) {
      const c = await choose(`${question}<p>I didn't catch any speech.</p>`, [["again", "Try again", true], ["type", "Type instead"], ["skip", "Skip"]]);
      if (c === "type") how = "type";
      if (c === "skip" || c === null) return null;
      continue;
    }
    if (speak) say(`${verdictWords(item.kind, r.verdict)[0]}. ${r.feedback}`, signal);
    for (;;) {
      const [title, cls] = verdictWords(item.kind, r.verdict);
      const c = await choose(`<h2 class="${cls}">${r.overruled ? "Marked as right" : title}</h2>
        <p>${esc(r.feedback)}</p>
        ${r.missing.length && r.verdict !== "sound" ? `<p class="small"><b>Also say:</b> ${r.missing.map(esc).join("; ")}</p>` : ""}
        <div class="point">
          <p class="small" style="margin:.2rem 0"><b>${item.kind === "statement" ? "The answer" : "A strong answer"}:</b> ${esc(r.answer)}</p>
          ${r.beyond ? `<p class="small muted" style="margin:.2rem 0">This goes beyond what the lecture says, so check the strong answer yourself.</p>` : ""}
          ${r.quote ? `<p class="small muted" style="margin:.2rem 0">Lecture: “${esc(r.quote)}”</p>` : ""}
          ${r.reference ? `<p class="small muted" style="margin:.2rem 0">${esc(r.reference)}: “${esc(r.reference_quote)}”</p>` : ""}
        </div>
        <details class="small" style="margin:.5rem 0"><summary>${r.heard_by ? `What I heard${r.heard_by !== "this PC" ? ` (heard by ${esc(r.heard_by)})` : ""}` : "Your answer"}</summary><p>${esc(r.heard)}</p></details>
        ${r.hear_notice ? `<p class="small muted">${esc(r.hear_notice)}</p>` : ""}
        ${r.notice ? `<p class="small muted">${esc(r.notice)}</p>` : ""}
        <p class="muted small" style="margin:0">Checked by ${esc(r.by)}. AI feedback can be wrong, so check anything important.</p>`,
        [["next", i === n - 1 ? "Finish" : "Next", true], ["again", "Try again"], ...hear,
         ...(r.verdict === "sound" ? [] : [["right", "I was right"]])], false);
      if (c === "listen") { await listen(after); continue; }
      if (c === "right") {
        try { await post(overruleUrl); r.verdict = "sound"; r.overruled = true; } catch (e) { toast(e.message); }
        continue;
      }
      if (c === "next" || c === null) return { question: item.question, kind: item.kind, verdict: r.verdict };
      break;  // try again
    }
  }
}

/** The end of a set of expert questions: how many were right, one line each. */
function questionsSummary(results, note) {
  const sound = results.filter(r => r.verdict === "sound").length;
  return `<h2>${sound} of ${results.length} answered soundly</h2>
    ${results.map(r => `<div class="result-row"><span class="grow small">${esc(r.question)}</span>
      <span class="small ${verdictWords(r.kind, r.verdict)[1]}">${verdictWords(r.kind, r.verdict)[0]}</span></div>`).join("")}
    <p class="muted small" style="margin-top:.5rem">${sound ? "The terms behind a sound answer count as Expert while they're in spaced review. " : ""}${note}</p>`;
}

// ---------------------------------------------------------------- review (audio cloze)

async function showReview() {
  const [queue, recall] = await Promise.all([api("/api/review"), api("/api/recall")]);
  const abort = new AbortController();
  cleanup = () => abort.abort();
  const recallPanel = recall.length ? `<div class="panel" id="recall"><h2>Recall from memory</h2>
    <p class="muted small">No audio this time. Explain a chapter you finished a while ago, as if teaching someone. What you've forgotten goes to Weak spots, and chapters you remember well come back less often.</p>
    ${recall.map(c => `<div class="result-row"><span class="grow"><span class="term">${esc(c.title)}</span> <span class="muted small">${esc(c.source)}</span></span>
      <button data-recall="${c.id}">Explain from memory</button></div>`).join("")}</div>` : "";
  const wireRecall = () => view.querySelectorAll("[data-recall]").forEach(b => b.onclick = () =>
    recallChapter(recall.find(c => c.id === +b.dataset.recall), b.closest(".result-row"), abort.signal));
  const pairsPanel = `<div class="panel" id="pairs"></div>`;
  if (!queue.length && recall.length) {
    view.innerHTML = `<h1>Review</h1><p class="muted">No audio prompts are due right now.</p>${recallPanel}${pairsPanel}`;
    wireRecall();
    drawPairs(abort);
    return;
  }
  if (!queue.length) {
    const clips = (await api("/api/summary")).clips;
    view.innerHTML = `<h1>Review</h1><div class="panel"><p><b>Nothing is due right now.</b></p>
      <p class="muted">${clips ? `You have ${clips} clip${clips === 1 ? "" : "s"} in Weak spots. Their terms come up for review after you replay them.` : "Finish a chapter of a lecture and its terms will appear here."}</p>
      ${clips ? `<a href="#/weak">Go to Weak spots</a>` : `<a href="#/">Go to your library</a>`}</div>${pairsPanel}`;
    drawPairs(abort);
    return;
  }
  view.innerHTML = `<h1>Review</h1>
    <div class="panel stage">
      <p class="say">${queue.length} prompt${queue.length === 1 ? "" : "s"}, about ${Math.max(1, Math.round(queue.length * 0.4))} min</p>
      <p class="muted">The lecture plays, then cuts out just before a key term. After the beep, say the missing term out loud.</p>
      <div class="row" style="justify-content:center">
        <button class="primary" id="start-voice">Start speaking</button>
        <button id="start-type">Type answers instead</button>
      </div>
      <p class="muted small" id="start-note" style="margin:.75rem 0 0">Wired headphones work best. Bluetooth may drop in quality while the mic is on.</p>
    </div>${recallPanel}${pairsPanel}`;
  wireRecall();
  drawPairs(abort);
  $("#start-voice").onclick = () => runSession(queue, "voice");
  $("#start-type").onclick = () => runSession(queue, "type");
}

// Level 5 Expert: easily confused terms, often from different lectures, heard back to back.
async function drawPairs(abort) {
  const box = $("#pairs");
  if (!box) return;
  let st;
  try { st = await api("/api/pairs"); } catch (e) { box.innerHTML = `<p class="error small" style="margin:0">${esc(e.message)}</p>`; return; }
  if (!view.contains(box)) return;
  const told = st.pairs.filter(p => p.status === "sound").length;
  box.innerHTML = `<h2>Tell them apart <span class="muted small">Level 5 Expert</span></h2>
    <p class="muted small">Easily confused terms from your lectures, back to back: hear where each is said, then say the key difference.</p>
    ${!st.ai ? `<p class="small" style="margin:0">Claude or Gemini finds the pairs and checks your answers. <a href="#/settings">Choose one in Settings</a>.</p>`
      : `<p class="small">${st.pairs.length ? `${told} of ${st.pairs.length} pairs told apart.` : "No pairs yet."}${
          st.stale || !st.pairs.length ? " New pairs are looked for among the terms you've listened to when you start, which can take a minute." : ""}</p>
      <div class="row"><button class="primary" data-pairs="voice">Start speaking</button><button data-pairs="type">Type answers instead</button></div>`}`;
  box.querySelectorAll("[data-pairs]").forEach(b => b.onclick = () => runPairs(b.dataset.pairs, abort));
}

async function runPairs(mode, abort) {
  const box = $("#pairs"), speak = (() => { try { return JSON.parse(localStorage.getItem("earmark.prefs"))?.speak ?? true; } catch { return true; } })();
  const stop = new AbortController(), stopAll = () => stop.abort();
  abort.signal.addEventListener("abort", stopAll);
  let stream = null, failed = null;
  const results = [];
  keepAwake(true);
  try {
    if (mode === "voice") {
      try { stream = await openMic(); }
      catch { throw new Error("Your microphone isn't available. Allow it in the browser, or type your answers."); }
    }
    box.innerHTML = `<p class="muted" style="margin:0">Getting the pairs…</p>`;
    let st = await api("/api/pairs");
    if (st.stale || !st.pairs.length) {
      box.innerHTML = `<p class="muted" style="margin:0">Looking for easily confused terms among the ones you've listened to. This can take a minute…</p>`;
      try { st = await post("/api/pairs"); if (st.notice) toast(st.notice); }
      catch (e) { if (!st.pairs.length) throw e; toast(e.message); }
    }
    let queue = st.pairs.filter(p => p.status !== "sound");
    if (!queue.length) queue = st.pairs;
    queue = queue.slice(0, 5);
    if (!queue.length) throw new Error("No easily confused pairs were found among the terms you've listened to yet.");
    box.scrollIntoView({ block: "start", behavior: "smooth" });
    for (let i = 0; i < queue.length && !stop.signal.aborted; i++) {
      const { a, b, id } = queue[i];
      const clip = t => ({ sid: t.sid, start: t.clip[0], end: t.clip[1], label: `${t.term}, from ${t.source}` });
      const r = await askOne({ box, i, n: queue.length, mode, stream, signal: stop.signal, onStop: stopAll, speak,
        item: { kind: "pair", label: "Tell them apart", question: `What's the key difference between ${a.term} and ${b.term}?`,
                before: [clip(a), clip(b)], placeholder: "The key difference…" },
        answerUrl: `/api/pairs/${id}/answer`, overruleUrl: `/api/pairs/${id}/overrule` });
      if (r) results.push(r);
    }
  } catch (e) {
    if (!stop.signal.aborted) failed = e.message;
  } finally {
    stream?.getTracks().forEach(t => t.stop());
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    keepAwake(false);
    abort.signal.removeEventListener("abort", stopAll);
  }
  if (abort.signal.aborted) return;
  if (!results.length && !failed) { drawPairs(abort); return; }
  box.innerHTML = `${failed ? `<p class="error">${esc(failed)}</p>` : ""}${results.length ? questionsSummary(results, "Pairs you haven't told apart come first next time.") : ""}
    <div class="row" style="margin-top:.5rem"><button class="primary" data-close>Done</button></div>`;
  box.querySelector("[data-close]").onclick = () => { drawPairs(abort); refreshBadges(); };
}

// Explaining a finished chapter from memory, checked like its checkpoint.
async function recallChapter(c, row, signal) {
  const box = document.createElement("div");
  box.className = "point";
  row.after(box);
  row.hidden = true;
  const close = () => { box.remove(); row.hidden = false; };
  const pick = (html, buttons) => new Promise(res => {
    box.innerHTML = `${html}<div class="row" style="margin-top:.5rem">${buttons.map(([k, label, primary]) =>
      `<button data-g="${k}"${primary ? ' class="primary"' : ""}>${label}</button>`).join("")}</div>`;
    box.querySelectorAll("[data-g]").forEach(b => b.onclick = () => res(b.dataset.g));
    signal.addEventListener("abort", () => res(null), { once: true });
  });
  const ask = `<p class="say" style="margin:.25rem 0">Explain “${esc(c.title)}” from memory, as if teaching someone.</p>
    <p class="muted small" style="margin:0">From ${esc(c.source)}. Main ideas, mechanisms, and how they connect.</p>`;
  for (;;) {
    const how = await pick(ask, [["speak", "Start speaking", true], ["type", "Type instead"], ["cancel", "Cancel"]]);
    if (how !== "speak" && how !== "type") { close(); return; }
    let request;
    if (how === "speak") {
      let stream;
      try { stream = await openMic(); }
      catch { toast("Your microphone isn't available. Allow it in the browser, or type instead."); continue; }
      keepAwake(true);
      box.innerHTML = `${ask}<div class="stage" style="padding:.5rem">${ringHtml()}${meterHtml()}<button id="rc-stop">I'm done</button></div>`;
      const stopRef = {};
      box.querySelector("#rc-stop").onclick = () => stopRef.stop?.();
      await tone(880, 160);
      let heardAny = false;
      const { blob } = await recordAnswer(stream, { ms: 90000, graceMs: 0, silentMs: 15000, doneSilenceMs: 5000, signal, stopRef,
        onTick: (f, left, rms) => { setRing(box, f, left); setMeter(box, rms); if (rms > SPEECH_RMS) heardAny = true; } });
      stream.getTracks().forEach(t => t.stop());
      keepAwake(false);
      if (signal.aborted) return;
      if (!heardAny) { toast("I didn't hear anything. Check your microphone, or type instead."); continue; }
      request = api(`/api/chapters/${c.id}/recall`, { method: "POST", body: blob });
    } else {
      box.innerHTML = `${ask}<textarea aria-label="Your explanation" placeholder="Explain the chapter from memory…"></textarea>
        <div class="row" style="margin-top:.5rem"><button class="primary" data-g="send">Check my explanation</button><button data-g="cancel">Cancel</button></div>`;
      const text = await new Promise(res => {
        box.querySelector("[data-g=send]").onclick = () => res(box.querySelector("textarea").value);
        box.querySelector("[data-g=cancel]").onclick = () => res(null);
        signal.addEventListener("abort", () => res(null), { once: true });
      });
      if (text === null) { close(); return; }
      if (!text.trim()) continue;
      request = post(`/api/chapters/${c.id}/recall`, { text });
    }
    box.innerHTML = `${ask}<p class="muted">Checking what you remembered…</p>`;
    let r;
    try { r = await request; } catch (e) { toast(e.message); continue; }
    if (r.empty) { toast("I didn't catch any speech. Try again, or type."); continue; }
    const VERDICT = { solid: ["You remembered this well", "right"], partial: ["You remembered part of it", ""], off_track: ["Most of this has faded", "wrong"] };
    const STATUS = { correct: ["Remembered", "right"], partial: ["Partly", ""], missing: ["Forgotten", "wrong"], wrong: ["Incorrect", "wrong"] };
    const hit = r.concepts.filter(k => k.covered).length;
    const [title, cls] = r.points ? VERDICT[r.verdict] : [`You recalled ${hit} of ${r.concepts.length} key terms`, ""];
    const points = r.points ? r.points.map(p => `<div class="point">
        <div class="row spread"><span class="term grow">${esc(p.idea)}</span><span class="small ${STATUS[p.status][1]}">${STATUS[p.status][0]}</span></div>
        <p class="small" style="margin:.2rem 0">${esc(p.feedback)}</p>
        ${p.at !== null ? `<button class="link small" data-hear="${p.at}">Hear it</button>` : ""}</div>`).join("")
      : r.concepts.map(k => `<div class="result-row"><span class="term">${esc(k.term)}</span><span class="small ${k.covered ? "right" : "wrong"}">${k.covered ? "Recalled" : "Forgotten"}</span></div>`).join("");
    box.innerHTML = `<h2 class="${cls}" style="margin:.25rem 0">${title}</h2>
      ${r.summary ? `<p>${esc(r.summary)}</p>` : ""}
      ${r.notice ? `<p class="small muted">${esc(r.notice)}</p>` : r.ai_enabled ? "" : `<p class="small">To check your explanation itself, not only the terms, <a href="#/settings">choose Claude or Gemini in Settings</a>.</p>`}
      ${points}
      <p class="small" style="margin:.6rem 0 0">${r.standard.below ? "What you've forgotten is in Weak spots. " : ""}Next recall of this chapter in ${r.next_days} days.</p>
      <div class="row" style="margin-top:.5rem"><button class="primary" id="rc-done">Done</button></div>`;
    box.querySelectorAll("[data-hear]").forEach(b => b.onclick = async () => {
      const t = +b.dataset.hear;
      playBuffer(await fetchClip(r.source_id, Math.max(0, t - 15), t + 15), signal);
    });
    box.querySelector("#rc-done").onclick = () => { box.remove(); row.remove(); refreshBadges(); };
    return;
  }
}

async function runSession(queue, mode) {
  audioCtx();
  const abort = new AbortController();
  let stream = null;
  if (mode === "voice") {
    try { stream = await openMic(); }
    catch {
      $("#start-note").textContent = "Your microphone isn't available. Allow it in the browser, or type your answers.";
      $("#start-note").classList.add("error");
      return;
    }
  }
  silentInARow = 0;
  keepAwake(true);
  // The mic stays open all session so Bluetooth switches once, not at every prompt.
  cleanup = () => { abort.abort(); stream?.getTracks().forEach(t => t.stop()); keepAwake(false); };
  const results = [];
  try {
    for (let i = 0; i < queue.length && !abort.signal.aborted; i++) {
      const r = await runPrompt(queue[i], i, queue.length, mode, stream, abort.signal);
      if (r) results.push(r);
    }
  } catch (e) {
    if (!abort.signal.aborted) toast(e.message);
  }
  stream?.getTracks().forEach(t => t.stop());
  keepAwake(false);
  if (abort.signal.aborted) return;
  refreshBadges();
  showSessionEnd(results);
}

let silentInARow = 0;  // voice prompts in a row where the mic picked up nothing

async function runPrompt(item, i, total, mode, stream, signal) {
  const head = `<p class="muted small">Prompt ${i + 1} of ${total}</p>`;
  view.innerHTML = `<div class="panel stage" id="st">${head}<p class="say">Listen…</p><p class="muted">The lecture will cut out before a key term.</p></div>`;
  const st = $("#st");
  const [lead, reveal] = await Promise.all([
    fetchClip(item.source_id, item.lead_start, item.cut),
    fetchClip(item.source_id, item.cut, item.resume_end),
  ]);
  await playBuffer(lead, signal);
  if (signal.aborted) return null;
  await tone(880, 160);
  if (signal.aborted) return null;

  let result;
  if (mode === "voice") {
    st.innerHTML = `${head}<p class="say">Say the missing term</p>${ringHtml()}${meterHtml()}`;
    const { blob, onsetMs } = await recordAnswer(stream, { ms: item.seconds * 1000, signal,
      onTick: (f, left, rms) => { setRing(st, f, left); setMeter(st, rms); } });
    silentInARow = onsetMs === null ? silentInARow + 1 : 0;
    if (signal.aborted) return null;
    st.innerHTML = `${head}<p class="muted">Checking… If your answer isn't word for word, the AI decides, which can take a few seconds.</p>`;
    const qs = `concept=${item.concept_id}&card=${item.card_id}${onsetMs === null ? "" : `&onset_ms=${onsetMs}`}`;
    result = await api(`/api/review/answer?${qs}`, { method: "POST", body: blob });
  } else {
    st.innerHTML = `${head}<p class="say">Type the missing term</p>
      <form id="ans" class="row" style="justify-content:center;max-width:420px;margin:0 auto">
        <input type="text" id="typed" class="grow" autocomplete="off" aria-label="Your answer"><button class="primary">Check</button></form>`;
    $("#typed").focus();
    const text = await new Promise(res => {
      $("#ans").onsubmit = e => { e.preventDefault(); res($("#typed").value); };
      signal.addEventListener("abort", () => res(null));
    });
    if (text === null) return null;
    result = await post(`/api/review/answer?concept=${item.concept_id}&card=${item.card_id}`, { text });
  }

  const drawResult = r => {
    const nextUp = r.correct ? `Next review in ${r.days < 1 ? "under a day" : `${Math.round(r.days)} day${Math.round(r.days) === 1 ? "" : "s"}`}.` : "This clip is now in Weak spots.";
    st.innerHTML = `${head}
      <p class="say ${r.correct ? "right" : "wrong"}">${r.correct ? "Correct" : "Not quite"}</p>
      <p class="answer">${esc(item.term)}</p>
      <p class="quote">${hilite(item.sentence, item.term)}</p>
      <p class="muted small">${r.heard ? `${r.heard_by && r.heard_by !== "this PC" ? esc(r.heard_by) + " heard" : "I heard"}: “${esc(r.heard)}”` : "I didn't hear an answer."} ${nextUp}</p>
      ${r.hear_notice ? `<p class="small muted">${esc(r.hear_notice)}</p>` : ""}
      ${r.judge?.reason ? `<p class="small">${esc(r.judge.by)}: ${esc(r.judge.reason)}</p>` : ""}
      ${r.judge?.error ? `<p class="small muted">${esc(r.judge.error)} Only the word-for-word check ran.</p>` : ""}
      ${mode === "voice" && silentInARow >= 2 ? `<p class="error small">${SILENT_HINT} Press “I was right” for any answer I missed.</p>` : ""}
      <div class="row" style="justify-content:center">
        <button id="next" class="primary">Next</button>
        <button id="over">${r.correct ? "Actually, I was wrong" : "I was right"}</button>
      </div>`;
  };
  drawResult(result);
  const final = { item, result };
  const wireOver = () => {
    $("#over").onclick = async () => {
      const r = await post(`/api/review/${final.result.review_id}/overrule`, { correct: !final.result.correct });
      final.result = r; autoNext = false; drawResult(r); wireOver(); wireNext(); refreshBadges();
    };
  };
  let autoNext = true, nextRes;
  const nextPressed = new Promise(res => { nextRes = res; signal.addEventListener("abort", res); });
  const wireNext = () => { $("#next").onclick = nextRes; };
  wireOver(); wireNext();
  await playBuffer(reveal, signal);
  // Correct answers move on by themselves to stay hands-free. Wrong ones wait a moment longer.
  await Promise.race([nextPressed, sleep(result.correct ? 1500 : 4000).then(() => autoNext ? null : nextPressed)]);
  return final;
}

function showSessionEnd(results) {
  const right = results.filter(r => r.result.correct).length;
  view.innerHTML = `<h1>Session finished</h1>
    <div class="panel"><h2>${right} of ${results.length} correct</h2>
      <div id="rows"></div>
      <div class="row" style="margin-top:.75rem"><button class="primary" id="again">Review more</button><a href="#/weak" class="btn" style="display:inline-flex;align-items:center;text-decoration:none">Weak spots</a></div>
    </div>`;
  const draw = () => {
    $("#rows").innerHTML = results.map((r, i) => `<div class="result-row">
      <span><span class="term">${esc(r.item.term)}</span> <span class="small ${r.result.correct ? "right" : "wrong"}">${r.result.correct ? "Correct" : "Missed"}</span>
      <span class="muted small">${r.result.heard ? `· heard “${esc(r.result.heard)}”` : ""}</span></span>
      <button class="link small" data-i="${i}">${r.result.correct ? "Mark wrong" : "Mark right"}</button></div>`).join("");
    $("#rows").querySelectorAll("[data-i]").forEach(b => b.onclick = async () => {
      const r = results[+b.dataset.i];
      r.result = await post(`/api/review/${r.result.review_id}/overrule`, { correct: !r.result.correct });
      refreshBadges();
      const hit = results.filter(x => x.result.correct).length;
      view.querySelector("h2").textContent = `${hit} of ${results.length} correct`;
      draw();
    });
  };
  draw();
  $("#again").onclick = route;
}

// ---------------------------------------------------------------- weakness playlist

async function showWeak() {
  const clips = await api("/api/playlist");
  view.innerHTML = `<h1>Weak spots</h1>
    <p class="muted">The moments you clipped or missed. Replay one, then press <b>Check yourself</b> and explain it out loud. Once you've got it, it's done and its term comes back for review.</p>
    ${clips.length ? `<div class="row" style="margin-bottom:1rem"><button class="primary" id="all">Play all (${clips.length})</button><button id="stop" hidden>Stop</button></div>` : ""}
    <div id="clips">${clips.length ? clips.map(c => `
      <div class="panel" data-clip="${c.id}">
        <div class="row spread"><div class="grow">
          <div class="term">${esc(c.term || "Your clip")}</div>
          <div class="muted small">${esc(c.reason)} · ${esc(c.source)} · ${clock(c.start)}</div></div>
          <button data-play="${c.id}">Play</button>
          <button class="primary" data-check="${c.id}">Check yourself</button>
          <button data-done="${c.id}">Done</button>
          <button class="danger" data-rm="${c.id}" aria-label="Remove clip">Remove</button>
        </div>
        <p class="small" style="margin:.5rem 0 0">${c.term ? hilite(c.transcript, c.term) : esc(c.transcript)}</p>
      </div>`).join("") : `<div class="panel muted">Nothing here. Terms you miss will show up automatically.</div>`}</div>`;
  let abort = new AbortController();
  cleanup = () => abort.abort();
  const byId = id => clips.find(c => c.id === +id);
  const play = async c => playBuffer(await fetchClip(c.source_id, c.start, c.end), abort.signal);
  const markDone = async id => {
    await post(`/api/clips/${id}/done`);
    view.querySelector(`[data-clip="${id}"]`)?.remove();
    refreshBadges();
  };
  view.querySelectorAll("[data-play]").forEach(b => b.onclick = () => play(byId(b.dataset.play)).catch(e => toast(e.message)));
  view.querySelectorAll("[data-done]").forEach(b => b.onclick = () => markDone(b.dataset.done));
  view.querySelectorAll("[data-check]").forEach(b => b.onclick = () => checkGap(byId(b.dataset.check), b.closest("[data-clip]")));

  // A spoken question about a replayed weak spot. Understanding it marks it done.
  async function checkGap(c, panel) {
    let box = panel.querySelector(".gap");
    if (!box) { box = document.createElement("div"); box.className = "gap point"; panel.append(box); }
    const signal = abort.signal;
    const question = c.term ? `In your own words, what does the lecture say about ${c.term}?`
      : "What is this part of the lecture about? Explain it in your own words.";
    const pick = (html, buttons) => new Promise(res => {
      box.innerHTML = `${html}<div class="row" style="margin-top:.5rem">${buttons.map(([k, label, primary]) =>
        `<button data-g="${k}"${primary ? ' class="primary"' : ""}>${label}</button>`).join("")}</div>`;
      box.querySelectorAll("[data-g]").forEach(b => b.onclick = () => res(b.dataset.g));
      signal.addEventListener("abort", () => res(null), { once: true });
    });
    const ask = `<p class="say" style="margin:.25rem 0">${esc(question)}</p>`;
    for (;;) {
      const how = await pick(ask, [["speak", "Start speaking", true], ["type", "Type instead"], ["play", "Play it again"], ["cancel", "Cancel"]]);
      if (how === "play") { await play(c).catch(e => toast(e.message)); continue; }
      if (how !== "speak" && how !== "type") { box.remove(); return; }
      let request;
      if (how === "speak") {
        let stream;
        try { stream = await openMic(); }
        catch { toast("Your microphone isn't available. Allow it in the browser, or type instead."); continue; }
        box.innerHTML = `${ask}<div class="stage" style="padding:.5rem">${ringHtml()}${meterHtml()}<button id="gap-stop">I'm done</button></div>`;
        const stopRef = {};
        box.querySelector("#gap-stop").onclick = () => stopRef.stop?.();
        let heardAny = false;
        const { blob } = await recordAnswer(stream, { ms: 45000, graceMs: 0, silentMs: 8000, doneSilenceMs: 3500, signal, stopRef,
          onTick: (f, left, rms) => { setRing(box, f, left); setMeter(box, rms); if (rms > SPEECH_RMS) heardAny = true; } });
        stream.getTracks().forEach(t => t.stop());
        if (signal.aborted) return;
        if (!heardAny) { toast("I didn't hear anything. Check your microphone, or type instead."); continue; }
        request = api(`/api/clips/${c.id}/check`, { method: "POST", body: blob });
      } else {
        box.innerHTML = `${ask}<textarea aria-label="Your explanation" placeholder="Explain it in your own words…"></textarea>
          <div class="row" style="margin-top:.5rem"><button class="primary" data-g="send">Check</button><button data-g="cancel">Cancel</button></div>`;
        const text = await new Promise(res => {
          box.querySelector("[data-g=send]").onclick = () => res(box.querySelector("textarea").value);
          box.querySelector("[data-g=cancel]").onclick = () => res(null);
          signal.addEventListener("abort", () => res(null), { once: true });
        });
        if (text === null) { box.remove(); return; }
        if (!text.trim()) continue;
        request = post(`/api/clips/${c.id}/check`, { text });
      }
      box.innerHTML = `${ask}<p class="muted">Checking…</p>`;
      let r;
      try { r = await request; } catch (e) { toast(e.message); continue; }
      if (r.empty) { toast("I didn't catch any speech. Try again, or type."); continue; }
      const heard = `<details class="small"><summary>${r.heard_by ? "What I heard" : "Your answer"}</summary><p>${esc(r.heard)}</p></details>
        ${r.notice ? `<p class="small muted">${esc(r.notice)}</p>` : ""}${r.by ? `<p class="muted small" style="margin:0">Checked by ${esc(r.by)}.</p>` : ""}`;
      if (r.understood) {
        const next = await pick(`<p class="right" style="margin:.25rem 0"><b>You've got it.</b> ${esc(r.feedback)}</p>${heard}`, [["done", "Done", true], ["again", "Try again"]]);
        if (next === "done") { await markDone(c.id); return; }
        if (next === null) return;
        continue;
      }
      const next = await pick(r.understood === null
        ? `<p style="margin:.25rem 0">To have this checked, <a href="#/settings">choose Claude or Gemini in Settings</a>. If you explained it, press Done.</p>${heard}`
        : `<p class="wrong" style="margin:.25rem 0"><b>Not yet.</b> ${esc(r.feedback)}</p>${heard}`,
        r.understood === null ? [["done", "Done", true], ["again", "Try again"]] : [["play", "Play it again", true], ["again", "Try again"], ["done", "I did explain it"]]);
      if (next === "done") { await markDone(c.id); return; }
      if (next === "play") await play(c).catch(e => toast(e.message));
      if (next === null) return;
    }
  }
  view.querySelectorAll("[data-rm]").forEach(b => b.onclick = async () => {
    await api(`/api/clips/${b.dataset.rm}`, { method: "DELETE" });
    view.querySelector(`[data-clip="${b.dataset.rm}"]`)?.remove();
    refreshBadges();
  });
  if ($("#all")) {
    $("#all").onclick = async () => {
      $("#stop").hidden = false; $("#all").disabled = true;
      $("#stop").onclick = () => { abort.abort(); abort = new AbortController(); };
      const run = abort;
      for (const c of [...clips]) {
        if (run.signal.aborted || !view.querySelector(`[data-clip="${c.id}"]`)) continue;
        const panel = view.querySelector(`[data-clip="${c.id}"]`);
        panel.scrollIntoView({ block: "center", behavior: "smooth" });
        await play(c);
        if (run.signal.aborted) break;
        await markDone(c.id);
        await sleep(600);
      }
      if ($("#stop")) { $("#stop").hidden = true; $("#all").disabled = false; }
    };
  }
}

// ---------------------------------------------------------------- settings

async function showSettings() {
  const s = await api("/api/settings");
  let use = "";
  try {
    const e = await navigator.storage.estimate();
    if (e.usage) use = ` Earmark uses ${(e.usage / 1048576).toFixed(0)} MB here${e.quota ? `, of ${(e.quota / 1073741824).toFixed(0)} GB the browser allows` : ""}.`;
  } catch {}
  view.innerHTML = `<h1>Settings</h1>
    <div class="panel">
      <h2>Gemini</h2>
      <p class="muted small">On the phone, Gemini does the hearing and checking: it transcribes your lectures, reads PDFs and notes aloud, picks chapters and terms, hears your spoken answers, checks your explanations and searches your references. Create a key at aistudio.google.com. <b>On Gemini's free tier, Google may use what you send to improve its products and people may read it,</b> so don't include anything private. Paid use doesn't improve its products.</p>
      <label class="small" for="gemini-key">API key</label>
      <div class="row">
        <input type="password" class="grow" id="gemini-key" autocomplete="off" placeholder="${s.gemini_key ? `Saved, ending ${esc(s.gemini_tail)}` : "Paste your key"}">
        <button id="key-save">Save key</button>
        <button id="key-test">Test</button>
        <button class="danger" id="key-clear" ${s.gemini_key ? "" : "hidden"}>Remove</button>
      </div>
      <p class="small" id="key-msg" role="status" style="margin:.4rem 0"></p>
      <label class="small">Model <select id="gemini-model">${Object.entries(s.gemini_models).map(([id, name]) =>
        `<option value="${esc(id)}" ${id === s.gemini_model ? "selected" : ""}>${esc(name)}</option>`).join("")}</select></label>
    </div>
    <div class="panel" id="mic-panel">
      <h2>Microphone</h2>
      <p class="muted small">Choose the microphone to answer with, then press Test and talk. The bar should turn green when you speak.</p>
      <div class="row">
        <select id="mic-select" class="grow" aria-label="Microphone"><option value="">Default microphone</option></select>
        <button id="mic-test">Test</button>
      </div>
      ${meterHtml()}
      <p class="small" id="mic-msg" role="status" style="margin:.4rem 0 0"></p>
    </div>
    <div class="panel">
      <h2>On this phone</h2>
      <p class="small">Your lectures, transcripts and progress are kept on this phone only, in Chrome. Nothing is on a server, and your PC isn't needed.${use}</p>
      <p class="small muted">Clearing this site's data in Chrome, or uninstalling the app, deletes them, so keep your original recordings. To open Earmark like an app, tap Chrome's <b>⋮</b> menu and choose <b>Install app</b>. Listening and review work without internet; transcribing and checking need it.</p>
    </div>
    <div class="panel" id="refs-panel">
      <h2>Your references</h2>
      <p class="muted small">Add sources you trust, such as textbook chapters or your own notes, as PDF, Word, text or Markdown files of up to 100 MB. Gemini indexes them on your Gemini account, so the phone doesn't keep a copy. Then, when you finish a chapter, your explanation is checked against the lecture and these, terms the lecture doesn't define get definitions from them, with the source shown, and expert questions can compare them with the lecture. One chapter at a time works better than a whole book. <b>The files are sent to Google;</b> on Gemini's free tier, Google may use them.</p>
      <label class="check small"><input type="checkbox" id="use-refs" ${s.use_refs ? "checked" : ""}> Use my references when checking explanations and defining terms</label>
      <div class="row" style="margin:.5rem 0"><button class="primary" id="ref-add">Add files</button>
        <input type="file" id="ref-file" accept=".pdf,.docx,.txt,.md,.html,.htm" multiple hidden></div>
      <p class="small" id="refs-msg" role="status" style="margin:.2rem 0"></p>
      <div id="refs-list"></div>
    </div>
    <div class="panel small muted">
      <p><b>What gets sent,</b> only to Gemini, with your key: your lectures' audio in 3-minute pieces to be transcribed, then their transcripts to pick chapters and terms; your spoken answers to be heard; and your explanations and answers, with the part of the lecture they're about, to be checked.</p>
      <p><b>PDFs and notes</b> you turn into lectures: their text, to be read aloud.</p>
      <p><b>References:</b> the files you add above, once, and searches of them when you finish a chapter, terms are picked or expert questions are written and checked.</p>
      <p style="margin:0"><b>Your key</b> is kept on this phone and only sent to Gemini.</p>
    </div>`;
  const msg = $("#key-msg");
  const update = async body => Object.assign(s, await post("/api/settings", body));
  $("#key-save").onclick = async () => {
    const key = $("#gemini-key").value.trim();
    if (!key) { msg.textContent = "Paste a key first."; return; }
    await update({ gemini_key: key });
    $("#gemini-key").value = "";
    $("#gemini-key").placeholder = `Saved, ending ${s.gemini_tail}`;
    $("#key-clear").hidden = false;
    msg.className = "small"; msg.textContent = "Saved. Press Test to check it.";
    refsMsg();
  };
  $("#key-clear").onclick = async () => {
    if (!confirm("Remove your Gemini key from this phone?")) return;
    await update({ gemini_key: "" });
    $("#gemini-key").placeholder = "Paste your key";
    $("#key-clear").hidden = true;
    msg.textContent = "Removed.";
    refsMsg();
  };
  $("#key-test").onclick = async () => {
    msg.className = "small"; msg.textContent = "Testing…";
    const r = await post("/api/settings/test");
    msg.className = `small ${r.ok ? (r.warn ? "" : "right") : "error"}`;
    msg.textContent = r.message;
  };
  $("#gemini-model").onchange = e => update({ gemini_model: e.target.value });
  // References: list, add, remove. The list refreshes while files are being indexed.
  let refsTimer;
  const refsMsg = () => {
    const m = $("#refs-msg");
    m.className = "small error";
    m.textContent = s.gemini_key ? "" : "Add your Gemini key above first: Gemini indexes and searches your references.";
  };
  const STATE = { queued: "Waiting", uploading: "Indexing on Gemini…", ready: "Ready", failed: "Failed" };
  const drawRefs = async () => {
    clearTimeout(refsTimer);
    const list = await api("/api/references");
    const box = $("#refs-list");
    if (!box) return;
    box.innerHTML = list.length ? list.map(r => `<div class="result-row">
        <span class="grow"><span class="term">${esc(r.name)}</span> <span class="muted small">${(r.size / 1048576).toFixed(1)} MB</span>
          ${r.status === "failed" ? `<br><span class="error small">${esc(r.error || "")}</span>` : ""}</span>
        <span class="small ${r.status === "ready" ? "right" : r.status === "failed" ? "wrong" : "muted"}">${STATE[r.status] || r.status}</span>
        ${r.status === "failed" ? `<button data-ref-retry="${r.id}">Retry</button>` : ""}
        <button class="danger" data-ref-del="${r.id}" ${r.status === "queued" || r.status === "uploading" ? "disabled" : ""}>Remove</button>
      </div>`).join("") : `<p class="muted small" style="margin:0">No references yet.</p>`;
    box.querySelectorAll("[data-ref-del]").forEach(b => b.onclick = async () => {
      if (!confirm("Remove this file from your references? It is deleted from your Gemini account too.")) return;
      try { await api(`/api/references/${b.dataset.refDel}`, { method: "DELETE" }); } catch (e) { toast(e.message); }
      drawRefs();
    });
    box.querySelectorAll("[data-ref-retry]").forEach(b => b.onclick = async () => { await post(`/api/references/${b.dataset.refRetry}/retry`); drawRefs(); });
    if (list.some(r => r.status === "queued" || r.status === "uploading")) refsTimer = setTimeout(drawRefs, 3000);
  };
  $("#ref-add").onclick = () => $("#ref-file").click();
  $("#ref-file").onchange = async e => {
    for (const f of e.target.files) {
      $("#refs-msg").className = "small"; $("#refs-msg").textContent = `Adding ${f.name}…`;
      try { await api(`/api/references?name=${encodeURIComponent(f.name)}`, { method: "POST", body: f }); }
      catch (err) { toast(`${f.name}: ${err.message}`); }
    }
    e.target.value = "";
    refsMsg();
    drawRefs();
  };
  $("#use-refs").onchange = e => update({ use_refs: e.target.checked });
  cleanup = () => clearTimeout(refsTimer);
  refsMsg();
  drawRefs();
  setupMicPanel();
}

// Phone: on the PC, turning it on, the code to pair a phone with, and the paired phones.
// On a phone, which phone this is and a way to disconnect it.
async function setupPhonePanel() {
  const body = $("#phone-body");
  if (CLOUD) {
    // In a codespace every device connects with a code; a connected one can show the code for the next.
    const draw = st => {
      const mins = Math.max(1, Math.ceil((st.code_left || 0) / 60));
      body.innerHTML = `<p class="small">This ${esc((st.device?.name || "device").toLowerCase())} is connected to Earmark in your GitHub codespace${st.device ? ` (since ${esc(dateText(st.device.added))})` : ""}. The codespace has to be running for Earmark to work: start it at github.com/codespaces.</p>
        <h3 class="sub">Connect a phone or another computer</h3>
        ${st.code ? `<div class="pair">
          <div class="qr" role="img" aria-label="Square code to scan with your phone's camera">${st.qr}</div>
          <ol class="small steps">
            <li>On the phone, scan this square with the camera. Or open <b>${esc(st.url)}</b> and type the code <b class="code">${esc(st.code.slice(0, 3))} ${esc(st.code.slice(3))}</b>.</li>
            <li>To keep Earmark as an app, tap Chrome's <b>⋮</b> menu and choose <b>Install app</b>.</li>
          </ol></div>
          <p class="muted small">The code works for ${mins} more minute${mins === 1 ? "" : "s"} and connects one device.</p>`
          : `<p class="small error">Too many wrong codes were tried, so connecting is paused. A new code appears in about a minute.</p>`}
        ${st.devices.length ? `<h3 class="sub">Connected devices</h3>${st.devices.map(d => `<div class="result-row">
          <span><span class="term">${esc(d.name)}</span> <span class="muted small">connected ${esc(dateText(d.added))} · last used ${esc(ago(d.seen))}${d.id === st.device?.id ? " · this one" : ""}</span></span>
          ${d.id === st.device?.id ? "" : `<button class="danger" data-forget="${esc(d.id)}">Disconnect</button>`}</div>`).join("")}` : ""}
        <p class="muted small">Each device connects once. The codespace's port can then be public: Earmark's own code keeps everyone else out.</p>
        <button class="danger" id="phone-forget">Disconnect this device</button>`;
      $("#phone-forget").onclick = async () => {
        if (!confirm("Disconnect this device from Earmark? To use it here again, you'll need a new code.")) return;
        try { await post("/api/phone/forget-me"); } catch (e) { toast(e.message); return; }
        location.reload();
      };
      body.querySelectorAll("[data-forget]").forEach(b => b.onclick = async () => {
        if (!confirm("Disconnect that device? It can connect again with a new code.")) return;
        try { draw(await api(`/api/phone/devices/${b.dataset.forget}`, { method: "DELETE" })); } catch (e) { toast(e.message); }
      });
    };
    try { draw(await api("/api/phone")); } catch (e) { body.innerHTML = `<p class="small error">${esc(e.message)}</p>`; }
    return;
  }
  if (REMOTE) {
    let me = {};
    try { me = await api("/api/phone"); } catch {}
    if (!view.contains(body)) return;
    body.innerHTML = `<p class="small">This phone is connected to Earmark on your PC${me.device ? ` (since ${esc(dateText(me.device.added))})` : ""}.
        Lectures, progress and settings stay on your PC, so Earmark has to be running there, and this phone has to be on the same Wi-Fi.</p>
      <p class="small muted">To open Earmark quickly, tap Chrome's <b>⋮</b> menu and choose <b>Add to Home screen</b>.</p>
      <button class="danger" id="phone-forget">Disconnect this phone</button>`;
    $("#phone-forget").onclick = async () => {
      if (!confirm("Disconnect this phone from Earmark? To use it here again, scan the code in Settings on your PC.")) return;
      try { await post("/api/phone/forget-me"); } catch (e) { toast(e.message); return; }
      location.reload();
    };
    return;
  }
  let timer, stopped = false, known = null, shown = "";
  const prev = cleanup;
  cleanup = () => { stopped = true; clearTimeout(timer); prev?.(); };
  const draw = st => {
    if (known && st.devices.length > known.length) toast(`${st.devices[st.devices.length - 1].name} connected.`);
    known = st.devices;
    const host = st.url ? new URL(st.url).hostname : "";
    const mins = Math.max(1, Math.ceil((st.code_left || 0) / 60));
    const net = st.network?.public ? `<p class="small error">Windows treats the Wi-Fi network “${esc(st.network.name)}” as <b>public</b>, so it blocks your phone.
        If it's a network you trust, such as your home Wi-Fi or your phone's hotspot, make it private: in Windows <b>Settings</b>, open
        <b>Network &amp; internet</b>, then <b>Wi-Fi</b>, then “${esc(st.network.name)}”, and choose <b>Private network</b>.</p>` : "";
    const pairing = !st.running ? "" : st.code ? `
      <div class="pair">
        <div class="qr" role="img" aria-label="Square code to scan with your phone's camera">${st.qr}</div>
        <ol class="small steps">
          <li>On your phone, on the same Wi-Fi as this PC, scan this square with the camera. Or open Chrome, go to <b>${esc(st.url)}</b> and type the code <b class="code">${esc(st.code.slice(0, 3))} ${esc(st.code.slice(3))}</b>.</li>
          <li>Chrome says the connection isn't private. That's expected here: this PC made its own certificate rather than buying one. Tap <b>Advanced</b>, then <b>Proceed to ${esc(host)}</b>.</li>
          <li>Earmark opens on your phone. To find it quickly, tap Chrome's <b>⋮</b> menu and choose <b>Add to Home screen</b>.</li>
        </ol>
      </div>
      <p class="muted small">The code works for ${mins} more minute${mins === 1 ? "" : "s"} and connects one phone.${st.others?.length ? ` If your phone can't open the address, try ${st.others.map(esc).join(" or ")}.` : ""}</p>`
      : `<p class="small error">Too many wrong codes were tried, so pairing is paused. A new code appears in about a minute.</p>`;
    const devices = st.devices.length ? `<h3 class="sub">Connected phones</h3>${st.devices.map(d => `<div class="result-row">
        <span><span class="term">${esc(d.name)}</span> <span class="muted small">connected ${esc(dateText(d.added))} · last used ${esc(ago(d.seen))}</span></span>
        <button class="danger" data-forget="${esc(d.id)}">Disconnect</button></div>`).join("")}` : "";
    const html = `<p class="muted small">Listen, review and answer out loud on your phone. Lectures, progress and settings stay on this PC, so Earmark has to be running here, and your phone has to be on the same Wi-Fi.</p>
      <label class="check"><input type="checkbox" id="phone-on" ${st.enabled ? "checked" : ""}> Let my phone use Earmark</label>
      ${st.error ? `<p class="small error">${esc(st.error)}</p>` : ""}
      ${st.running ? `${net}${pairing}<p class="muted small">The first time, Windows may ask whether Python can use networks. Allow it, or your phone can't connect.</p>` : ""}
      ${devices}`;
    if (html === shown) return;  // redrawn only when something changed, so focus isn't lost
    const focused = document.activeElement?.id || document.activeElement?.dataset?.forget;
    shown = html;
    body.innerHTML = html;
    (focused && (body.querySelector(`#${CSS.escape(focused)}`) || body.querySelector(`[data-forget="${CSS.escape(focused)}"]`)))?.focus();
    $("#phone-on").onchange = async e => {
      e.target.disabled = true;
      try { draw(await post("/api/phone", { enabled: e.target.checked })); } catch (err) { toast(err.message); }
      poll();
    };
    body.querySelectorAll("[data-forget]").forEach(b => b.onclick = async () => {
      if (!confirm(`Disconnect this ${b.closest(".result-row").querySelector(".term").textContent}? It can connect again by scanning a new code.`)) return;
      try { draw(await api(`/api/phone/devices/${b.dataset.forget}`, { method: "DELETE" })); } catch (err) { toast(err.message); }
    });
  };
  const poll = async () => {
    clearTimeout(timer);
    let st;
    try { st = await api("/api/phone"); } catch (e) { if (!stopped) body.innerHTML = `<p class="small error">${esc(e.message)}</p>`; return; }
    if (stopped) return;
    draw(st);
    if (st.enabled) timer = setTimeout(poll, 3000);
  };
  poll();
}

async function setupMicPanel() {
  const select = $("#mic-select"), msg = $("#mic-msg"), testBtn = $("#mic-test"), panel = $("#mic-panel");
  let testing = null;  // { stream, meter, timer }
  const stopTest = () => {
    if (!testing) return;
    clearInterval(testing.timer); testing.meter.stop(); testing.stream.getTracks().forEach(t => t.stop());
    testing = null; testBtn.textContent = "Test"; setMeter(panel, 0);
  };
  const prev = cleanup;
  cleanup = () => { stopTest(); prev?.(); };

  const fill = async () => {
    let mics = [];
    try { mics = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "audioinput"); } catch {}
    // "default" and "communications" are aliases the browser adds; the plain first option covers them.
    const real = mics.filter(d => d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications");
    const def = mics.find(d => d.deviceId === "default");
    const chosen = savedMic();
    select.innerHTML = `<option value="">${WINDOWS ? "Windows default" : "Default microphone"}${def?.label ? ` (${esc(def.label.replace(/^Default - /, ""))})` : ""}</option>` +
      real.map((d, i) => `<option value="${esc(d.deviceId)}" ${d.deviceId === chosen ? "selected" : ""}>${esc(d.label || `Microphone ${i + 1}`)}</option>`).join("");
    if (chosen && !real.some(d => d.deviceId === chosen) && real.length && real[0].label) {
      msg.className = "small error"; msg.textContent = `The microphone you chose isn't connected, so the ${WINDOWS ? "Windows default" : "default one"} will be used.`;
    }
    return real;
  };
  navigator.mediaDevices.addEventListener?.("devicechange", fill);
  const prev2 = cleanup;
  cleanup = () => { navigator.mediaDevices.removeEventListener?.("devicechange", fill); prev2(); };
  fill().then(real => {
    if (real.length && !real[0].label && !testing) {
      msg.className = "small muted";
      msg.textContent = "Press Test to allow the microphone and see their names.";
    }
  });

  select.onchange = () => { saveMic(select.value); stopTest(); msg.className = "small"; msg.textContent = "Saved. Press Test and talk to check it."; };

  testBtn.onclick = async () => {
    if (testing) return stopTest();
    let stream;
    try { stream = await openMic(select.value); }
    catch (e) {
      msg.className = "small error";
      msg.textContent = e.name === "NotAllowedError" ? (TOUCH ? "The browser is blocking the microphone. Tap the icon to the left of the address, then Permissions, and allow it."
          : "The browser is blocking the microphone. Click the lock icon in the address bar and allow it.")
        : "Couldn't open this microphone. Check it's connected, or choose another.";
      return;
    }
    await fill();  // names appear once permission is granted
    const meter = micMeter(stream);
    let heard = false;
    const started = performance.now();
    testBtn.textContent = "Stop";
    msg.className = "small"; msg.textContent = "Listening… say something.";
    testing = { stream, meter, timer: setInterval(() => {
      const rms = meter.level(), t = performance.now() - started;
      setMeter(panel, rms);
      if (rms > SPEECH_RMS && !heard) { heard = true; msg.className = "small right"; msg.textContent = "I can hear you. This microphone works."; }
      if (!heard && t > 6000) {
        msg.className = "small error";
        msg.innerHTML = WINDOWS ? `I'm not hearing anything from this microphone. Try another one above. If it's the right one, check it isn't muted in Windows: press Win+R, type <b>mmsys.cpl</b>, open Recording, then the microphone's Properties and Levels.`
          : `I'm not hearing anything from this microphone. Try another one above, and check no other app, such as a call, is using the microphone.`;
      }
      if (t > 20000) stopTest();
    }, 50) };
  };
}

// ---------------------------------------------------------------- progress

const LEVELS = [
  { n: 1, name: "Initial", desc: "Not listened yet" },
  { n: 2, name: "General", desc: "Listened to" },
  { n: 3, name: "Gaps", desc: "Missed, needs replay" },
  { n: 4, name: "Recall", desc: "In spaced review" },
];

async function showProgress() {
  const all = await api("/api/tracker");
  const count = fn => all.filter(fn).length;
  const levelCell = c => c.expert ? `<span class="chip expert">5. Expert</span>` : c.secure ? `<span class="chip secure">Secure</span>`
    : `<span class="chip l${c.level}">${c.level}. ${LEVELS[c.level - 1].name}</span>`;
  const when = c => {
    if (!c.due || !c.reps) return `<span class="muted">Not reviewed</span>`;
    const days = (c.due - Date.now() / 1000) / 86400;
    return days <= 0 ? "Due now" : days < 1 ? "Today" : `In ${Math.round(days)} day${Math.round(days) === 1 ? "" : "s"}`;
  };
  const bySource = {};
  all.forEach(c => { (bySource[c.source] = bySource[c.source] || []).push(c); });
  view.innerHTML = `<h1>Progress</h1>
    <p class="muted">Each term has its own level. Missing a review sends it back to Gaps with its clip. A term reaches Expert when you answer a what-if question about it soundly, on its lecture's page.</p>
    <div class="levels" style="margin-bottom:1rem">
      ${LEVELS.map(l => `<div class="level"><b>${count(c => c.level === l.n && !c.secure && !c.expert)}</b>${l.n}. ${l.name}<div class="muted small">${l.desc}</div></div>`).join("")}
      <div class="level"><b>${count(c => c.secure && !c.expert)}</b>Secure<div class="muted small">Stable for 3+ weeks</div></div>
      <div class="level"><b>${count(c => c.expert)}</b>5. Expert<div class="muted small">Reasoned through a what-if</div></div>
    </div>
    ${Object.keys(bySource).length ? Object.entries(bySource).map(([name, list]) => `
      <div class="panel"><h2 style="overflow-wrap:anywhere">${esc(name)}</h2>
        <table class="table"><thead><tr><th>Term</th><th>Level</th><th>Next review</th><th><span class="muted">Fix</span></th></tr></thead><tbody>
        ${list.map(c => `<tr data-row="${c.id}"><td class="term">${esc(c.term)}</td><td>${levelCell(c)}</td><td class="small">${c.open_clip ? "After replay" : c.has_card ? when(c) : `<span class="muted">No audio prompt</span>`}</td>
          <td><button class="link small" data-retire="${c.id}" title="Remove a misheard or useless term">Remove</button></td></tr>`).join("")}
        </tbody></table></div>`).join("") : `<div class="panel muted">Add a lecture to start tracking terms.</div>`}`;
  view.querySelectorAll("[data-retire]").forEach(b => b.onclick = async () => {
    await post(`/api/concepts/${b.dataset.retire}/retire`);
    b.closest("tr").remove();
    refreshBadges();
  });
}

route();
