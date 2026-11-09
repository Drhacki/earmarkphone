// The in-phone "server": it answers the same /api/... requests the PC version's server.py answers,
// from the phone's own storage and Gemini, so the screens work unchanged. It's installed as a
// replacement for fetch: requests to /api/ never leave the phone.

import * as db from "./store.js";
import * as ai from "./ai.js";
import * as T from "./text.js";
import { pieces, duration as audioDuration, answerWav } from "./audio.js";

const SESSION_SIZE = 10, NEW_PER_DAY = 15, PASS_MARK = 0.6, MIN_SPLIT_SECONDS = 360;
const RECALL_DAYS = [3, 7, 21, 60], BUSY_WAITS = [30, 60, 120, 240];
const now = () => Math.floor(Date.now() / 1000);
const round = (x, n = 2) => Math.round(x * 10 ** n) / 10 ** n;
const lower = s => String(s || "").toLowerCase();
const sleep = ms => new Promise(r => setTimeout(r, ms));

class HttpError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }

// ---------------------------------------------------------------- settings

const DEFAULT_SETTINGS = { gemini_key: "", gemini_model: "gemini-3.8-flash" };
export async function settings() { return { ...DEFAULT_SETTINGS, ...((await db.kvGet("settings")) || {}) }; }
const hasAi = s => !!s.gemini_key;
function publicSettings(s) {
  return { provider: "gemini", gemini_key: !!s.gemini_key, gemini_tail: s.gemini_key.length >= 8 ? s.gemini_key.slice(-4) : "",
           gemini_model: s.gemini_model, gemini_models: ai.MODELS };
}

// ---------------------------------------------------------------- recordings

const mediaUrls = new Map();
/** A playable address for a lecture's recording, kept for the session. */
export async function mediaUrl(sid) {
  if (!mediaUrls.has(sid)) {
    const blob = await db.fileGet(sid);
    if (!blob) throw new Error("This lecture's recording isn't on this phone.");
    mediaUrls.set(sid, URL.createObjectURL(blob));
  }
  return mediaUrls.get(sid);
}

/** What the learner said, heard by Gemini. Returns {text, by, notice}. */
async function hearAnswer(blob, vocab) {
  const s = await settings();
  if (!hasAi(s)) throw new HttpError("Spoken answers are heard by Gemini. Add your Gemini key in Settings, or type instead.");
  let wav;
  try { wav = await answerWav(blob); } catch { throw new HttpError("Your recording couldn't be read. Try again, or type instead."); }
  try { const r = await ai.transcribeAnswer(s, wav, vocab); return { text: r.text, by: r.by, notice: null }; }
  catch (e) { throw new HttpError(e.message, 502); }
}

// ---------------------------------------------------------------- importing: background jobs, one at a time

const queue = [];
let running = false;

export function queueJob(kind, sid) {
  queue.push([kind, sid]);
  if (!running) runJobs();
}

async function runJobs() {
  running = true;
  // The phone may pause Earmark when the screen locks, so the screen stays on while a lecture is
  // prepared. If it's paused anyway, the work carries on from the last finished piece when reopened.
  let lock = null;
  try { lock = await navigator.wakeLock?.request("screen"); } catch {}
  while (queue.length) {
    const [kind, sid] = queue.shift();
    try {
      if (kind === "reanalyse") await analyse(sid, await db.wordsGet(sid), db.one("sources", sid).duration);
      else await importSource(sid);
    } catch (e) {
      console.error(e);
      const kept = kind === "reanalyse" && db.where("chapters", c => c.source_id === sid).length;
      if (kept) db.update("sources", sid, { status: "ready", stage: null, progress: 1, error: null,
        note: `Re-pick terms didn't finish, so the earlier chapters and terms are kept. ${e.message}` });
      else db.update("sources", sid, { status: "failed", stage: null, error: e.message });
    }
  }
  try { await lock?.release(); } catch {}
  running = false;
}

/** Lectures left half-imported when the app was closed carry on. */
export function resumeJobs() {
  for (const s of db.where("sources", s => s.status === "queued" || s.status === "processing")) {
    db.update("sources", s.id, { status: "queued", stage: "Waiting" });
    queueJob(s.words_saved ? "reanalyse" : "import", s.id);
  }
}

async function transcribe(s, sid, piece) {
  for (const wait of [...BUSY_WAITS, null]) {
    try { return await ai.transcribePiece(s, piece); }
    catch (e) {
      if (!(e instanceof ai.AiBusy) || wait === null) throw e;
      db.update("sources", sid, { stage: `Gemini is busy, so waiting ${wait} seconds to try again` });
      await sleep(wait * 1000);
      db.update("sources", sid, { stage: "Transcribing with Gemini" });
    }
  }
}

async function importSource(sid) {
  const src = db.one("sources", sid);
  const s = await settings();
  if (!hasAi(s)) throw new Error("Gemini transcribes lectures on the phone. Add your Gemini key in Settings, then press Retry.");
  db.update("sources", sid, { status: "processing", stage: "Reading the recording", progress: 0.02, error: null });
  const blob = await db.fileGet(sid);
  if (!blob) throw new Error("This lecture's recording isn't on this phone. Delete it and add it again.");
  const file = new File([blob], src.file_name || "lecture", { type: blob.type });
  const total = src.duration || await audioDuration(file);
  db.update("sources", sid, { duration: total });
  // Pieces already transcribed are kept, so Retry carries on where it stopped.
  const partial = (await db.kvGet(`partial:${sid}`)) || { done: {}, used: [] };
  const words = [];
  try {
    for await (const piece of pieces(file, 180)) {
      const key = String(Math.round(piece.start));
      if (!partial.done[key]) {
        db.update("sources", sid, { stage: "Transcribing with Gemini", progress: round(0.05 + 0.6 * piece.start / total, 3) });
        const len = piece.end - piece.start;
        let { segments, used } = await transcribe(s, sid, piece);
        let got = T.wordsFromSegments(segments, piece.start, len);
        if (T.looksIncomplete(segments, got, len)) {  // stopped early: ask once more, keep the fuller one
          const again = await transcribe(s, sid, piece);
          const more = T.wordsFromSegments(again.segments, piece.start, len);
          if (more.length > got.length) { got = more; used = again.used; }
        }
        partial.done[key] = got;
        if (!partial.used.includes(used)) partial.used.push(used);
        await db.kvSet(`partial:${sid}`, partial);
      }
      words.push(...partial.done[key]);
    }
  } catch (e) {
    const kept = Object.keys(partial.done).length;
    throw new Error(`${e.message}${kept ? ` The parts already transcribed are kept, so Retry carries on from there.` : ""}`);
  }
  if (!words.length) throw new Error("Gemini heard no speech in this recording.");
  await db.wordsSet(sid, words);
  db.update("sources", sid, { heard_by: partial.used.sort().join(" and "), words_saved: true });
  await db.kvDel(`partial:${sid}`);
  await analyse(sid, words, total);
}

async function analyse(sid, words, total) {
  const s = await settings();
  if (!hasAi(s)) throw new Error("Gemini picks chapters and terms on the phone. Add your Gemini key in Settings.");
  db.update("sources", sid, { status: "processing", stage: "Gemini is finding chapters and terms", progress: 0.7 });
  let r;
  for (const wait of [...BUSY_WAITS, null]) {
    try { r = await ai.analyseLecture(s, T.linesForAi(words), total); break; }
    catch (e) {
      if (!(e instanceof ai.AiBusy) || wait === null) throw e;
      db.update("sources", sid, { stage: `Gemini is busy, so waiting ${wait} seconds to try again` });
      await sleep(wait * 1000);
    }
  }
  const { chapters, concepts } = T.fromAi(words, total, r.data, true);
  clearLearning(sid);
  const ids = chapters.map((ch, i) => db.put("chapters", { source_id: sid, idx: i, title: ch.title, start: ch.start, end: ch.end,
    listened: 0, summary: null, whatifs_made: 0, recall_due: null, recall_step: 0 }).id);
  for (const c of concepts) {
    const row = db.put("concepts", { source_id: sid, chapter_id: ids[c.chapter], term: c.term, score: c.score, first_at: c.first_at,
      level: 1, covered: null, stability: null, difficulty: null, last_review: null, due: null, reps: 0, lapses: 0, retired: 0,
      next_card: 0, context: c.context, context_at: c.context_at, defined: c.defined ? 1 : 0, preview: c.preview ? 1 : 0,
      definition: c.definition, definition_ref: null, expert: 0, known: 0 });
    for (const card of c.cards) db.put("cards", { concept_id: row.id, lead_start: card.lead_start, cut: card.cut,
      target_end: card.target_end, resume_end: card.resume_end, sentence: card.sentence });
  }
  const vocab = [...concepts].sort((a, b) => b.score - a.score).slice(0, 40).map(c => c.term).join(" ");
  const heard = db.one("sources", sid).heard_by;
  db.update("sources", sid, { status: "ready", stage: null, progress: 1, duration: total, vocab, silences: T.silences(words),
    note: `Chapters and terms by ${r.used}.${r.notice ? " " + r.notice : ""}${heard ? ` Transcribed by ${heard}, so cut-out times in Review are approximate.` : ""}` });
}

function clearLearning(sid) {
  const concepts = new Set(db.where("concepts", c => c.source_id === sid).map(c => c.id));
  db.removeWhere("reviews", r => concepts.has(r.concept_id));
  db.removeWhere("cards", k => concepts.has(k.concept_id));
  db.removeWhere("pairs", p => concepts.has(p.a_id) || concepts.has(p.b_id));
  for (const t of ["concepts", "chapters", "clips", "whatifs", "links"]) db.removeWhere(t, r => r.source_id === sid);
  db.update("sources", sid, { map_by: null });
}

// ---------------------------------------------------------------- learning state

async function addClip(sid, start, end, reason, conceptId = null) {
  if (conceptId != null) {
    const open = db.where("clips", p => p.concept_id === conceptId && p.done_at == null)[0];
    if (open) return open.id;
  }
  const words = await db.wordsGet(sid);
  return db.put("clips", { source_id: sid, concept_id: conceptId, start, end, transcript: T.textBetween(words, start, end),
    reason, created: now(), done_at: null }).id;
}
const clipForConcept = (c, reason) => addClip(c.source_id, Math.max(0, c.first_at - 15), c.first_at + 15, reason, c.id);

async function addPointClips(sid, points) {
  for (const p of points) {
    p.clip_id = null;
    if (!["missing", "wrong"].includes(p.status) || p.at == null) continue;
    const nearby = db.where("clips", c => c.source_id === sid && c.done_at == null && c.start < p.at + 10 && c.end > p.at - 10)[0];
    p.clip_id = nearby ? nearby.id : await addClip(sid, Math.max(0, p.at - 15), p.at + 15, `Not explained: ${p.idea.slice(0, 80)}`);
  }
}

async function gradeSummary(chapter, spoken, check, missed = "Missed in your summary") {
  const concepts = db.where("concepts", c => c.chapter_id === chapter.id && !c.retired).sort((a, b) => b.score - a.score);
  const result = [];
  for (const c of concepts) {
    const said = T.phraseMatches(c.term, spoken);
    const hit = check ? (check.terms[lower(c.term)] ?? said) : said;
    let clipId = null;
    if (hit) { c.level = Math.max(c.level, T.L_RECALL); if (c.due == null) c.due = now(); }
    else { c.level = Math.max(c.level, T.L_GAPS); clipId = await clipForConcept(c, missed); }
    c.covered = hit ? 1 : 0;
    db.put("concepts", c);
    result.push({ id: c.id, term: c.term, covered: hit, clip_id: clipId, first_at: c.first_at });
  }
  db.update("chapters", chapter.id, { listened: 1, summary: spoken });
  for (const c of db.where("concepts", c => c.chapter_id === chapter.id && c.level < 2)) db.update("concepts", c.id, { level: 2 });
  if (check) await addPointClips(chapter.source_id, check.points);
  return result;
}

function summaryScore(concepts, check) {
  if (check) {
    const weight = { correct: 1, partial: 0.5 };
    return check.points.reduce((n, p) => n + (weight[p.status] || 0), 0) / check.points.length;
  }
  return concepts.length ? concepts.filter(c => c.covered).length / concepts.length : null;
}
function belowStandard(score, check) {
  if (check?.verdict === "solid") return false;
  if (check?.verdict === "off_track") return true;
  return score != null && score < PASS_MARK;
}

function partTitles(title) {
  const m = title.match(/^(.*) \(part ([\d.]+)\)$/);
  const base = (m ? m[1] : title).slice(0, 100), num = m ? m[2] + "." : "";
  return [`${base} (part ${num}1)`, `${base} (part ${num}2)`];
}

function splitChapter(chapter, words) {
  const mid = T.splitPoint(words, chapter.start, chapter.end);
  if (mid == null) return null;
  const [first, second] = partTitles(chapter.title), sid = chapter.source_id;
  for (const c of db.where("chapters", c => c.source_id === sid && c.idx > chapter.idx)) db.update("chapters", c.id, { idx: c.idx + 1 });
  const end = chapter.end;
  db.update("chapters", chapter.id, { end: mid, title: first, listened: 0, summary: null });
  const two = db.put("chapters", { source_id: sid, idx: chapter.idx + 1, title: second, start: mid, end, listened: 0, summary: null,
    whatifs_made: chapter.whatifs_made || 0, recall_due: null, recall_step: 0 });
  for (const w of db.where("whatifs", w => w.chapter_id === chapter.id && w.at >= mid)) db.update("whatifs", w.id, { chapter_id: two.id });
  for (const c of db.where("concepts", c => c.chapter_id === chapter.id)) {
    const a = T.countUses(words, chapter.start, mid, c.term), b = T.countUses(words, mid, end, c.term);
    if (b > a || (a === b && c.first_at >= mid)) db.update("concepts", c.id, { chapter_id: two.id });
  }
  return { first: { id: chapter.id, title: first, start: chapter.start, end: mid }, second: { id: two.id, title: second, start: mid, end } };
}

function scheduleRecall(chapterId, step) {
  const days = RECALL_DAYS[Math.min(step, RECALL_DAYS.length - 1)];
  db.update("chapters", chapterId, { recall_step: step, recall_due: now() + days * T.DAY });
  return days;
}

function recallQueue(at = now(), limit = 5) {
  const sources = new Map(db.rows("sources").map(s => [s.id, s]));
  return db.where("chapters", h => h.listened && sources.get(h.source_id)?.status === "ready" && (h.recall_due || 0) <= at)
    .sort((a, b) => (a.recall_due || 0) - (b.recall_due || 0) || sources.get(a.source_id).created - sources.get(b.source_id).created || a.idx - b.idx)
    .slice(0, limit).map(h => ({ id: h.id, title: h.title, source_id: h.source_id, source: sources.get(h.source_id).name, recall_step: h.recall_step || 0 }));
}

function reviewQueue(limit = SESSION_SIZE, sourceId = null, at = now()) {
  const dayStart = at - at % T.DAY;
  const reviews = db.rows("reviews");
  const before = new Set(reviews.filter(r => r.ts < dayStart).map(r => r.concept_id));
  const newDone = new Set(reviews.filter(r => r.ts >= dayStart && !before.has(r.concept_id)).map(r => r.concept_id)).size;
  const ready = new Set(db.where("sources", s => s.status === "ready").map(s => s.id));
  const withCards = new Set(db.rows("cards").map(k => k.concept_id));
  const openClip = new Set(db.where("clips", p => p.done_at == null && p.concept_id != null).map(p => p.concept_id));
  // A term with an unplayed clip waits: hear it again first, then get tested.
  const base = db.where("concepts", c => !c.retired && ready.has(c.source_id) && c.level >= 2 && withCards.has(c.id) && !openClip.has(c.id)
    && (!sourceId || c.source_id === sourceId));
  const due = base.filter(c => c.stability != null && c.due <= at).sort((a, b) => a.due - b.due).slice(0, limit);
  const room = Math.min(limit - due.length, Math.max(0, NEW_PER_DAY - newDone));
  const fresh = room > 0 ? base.filter(c => c.stability == null).sort((a, b) => b.level - a.level || a.first_at - b.first_at).slice(0, room) : [];
  return [...due, ...fresh].map(c => {
    const cards = db.where("cards", k => k.concept_id === c.id).sort((a, b) => a.id - b.id);
    const card = cards[(c.next_card || 0) % cards.length];
    return { concept_id: c.id, source_id: c.source_id, term: c.term, card_id: card.id, lead_start: card.lead_start, cut: card.cut,
             target_end: card.target_end, resume_end: card.resume_end, sentence: card.sentence, seconds: T.answerSeconds(c.term),
             is_new: c.stability == null };
  });
}

async function applyReview(concept, cardId, heard, correct, onsetMs, at = now()) {
  const before = { level: concept.level, stability: concept.stability, difficulty: concept.difficulty, last_review: concept.last_review,
                   due: concept.due, reps: concept.reps, lapses: concept.lapses };
  const grade = T.rate(correct, onsetMs);
  const [s, d, due] = T.schedule(concept.stability, concept.difficulty, concept.last_review, grade, at);
  const clipId = correct ? null : await clipForConcept(concept, "Missed in review");
  db.update("concepts", concept.id, { stability: s, difficulty: d, last_review: at, due, reps: (concept.reps || 0) + 1,
    lapses: (concept.lapses || 0) + (correct ? 0 : 1), level: T.levelAfterReview(concept.level, correct), next_card: (concept.next_card || 0) + 1 });
  const review = db.put("reviews", { concept_id: concept.id, card_id: cardId, ts: at, heard, correct: correct ? 1 : 0, grade,
    onset_ms: onsetMs, before: JSON.stringify(before), clip_id: clipId, overruled: 0 });
  return { review_id: review.id, correct, grade, heard, term: concept.term, due, clip_id: clipId, days: round((due - at) / T.DAY, 1) };
}

async function overruleReview(reviewId, correct) {
  const rev = db.one("reviews", reviewId);
  if (!rev) return null;
  if (rev.clip_id) { const clip = db.one("clips", rev.clip_id); if (clip && clip.done_at == null) db.remove("clips", clip.id); }
  db.update("concepts", rev.concept_id, JSON.parse(rev.before));
  db.update("reviews", rev.id, { overruled: 1 });
  return applyReview(db.one("concepts", rev.concept_id), rev.card_id, rev.heard, correct, rev.onset_ms, rev.ts);
}

function tracker() {
  const sources = new Map(db.where("sources", s => s.status === "ready").map(s => [s.id, s]));
  const withCards = new Set(db.rows("cards").map(k => k.concept_id));
  const openClip = new Set(db.where("clips", p => p.done_at == null).map(p => p.concept_id));
  return db.where("concepts", c => !c.retired && sources.has(c.source_id))
    .sort((a, b) => String(a.source_id).localeCompare(String(b.source_id)) || a.first_at - b.first_at)
    .map(c => ({ id: c.id, term: c.term, level: c.level, stability: c.stability, due: c.due, reps: c.reps, lapses: c.lapses,
      source_id: c.source_id, chapter_id: c.chapter_id, first_at: c.first_at, source: sources.get(c.source_id).name,
      has_card: withCards.has(c.id), open_clip: openClip.has(c.id),
      secure: !!(c.stability && c.stability >= T.SECURE_STABILITY_DAYS && c.level === 4), expert: !!c.expert && c.level === T.L_RECALL }));
}

// ---------------------------------------------------------------- expert questions, pairs, concept map

function whatifClip(words, chapter, at, quote) {
  const sents = T.sentences(words);
  const firstIdx = words.findIndex(w => w.s >= at - 0.05);
  const first = firstIdx < 0 ? words.length - 1 : firstIdx;
  let last = Math.min(words.length - 1, first + Math.max(1, (quote.toLowerCase().match(/[a-z0-9]+/g) || []).length) - 1);
  let lead = words.findIndex(w => w.s >= at - 12);
  if (lead < 0) lead = first;
  for (const [a, b] of sents) {
    if (a <= lead && lead < b && words[a].s >= at - 20) lead = a;
    if (a <= last && last < b) last = b - 1;
  }
  const start = Math.max(chapter.start, words[lead].s);
  const end = Math.min(chapter.end, words[last].e + 0.3, at + 45);
  return [round(start), round(Math.max(end, at + 3))];
}

function whatifConcepts(concepts, item) {
  const byTerm = new Map(concepts.map(c => [lower(c.term), c.id]));
  let ids = item.terms.map(t => byTerm.get(lower(t).trim())).filter(x => x != null);
  if (!ids.length) {
    const text = [item.question, item.answer, item.quote].join(" ");
    ids = concepts.filter(c => T.phraseMatches(c.term, text)).map(c => c.id);
  }
  return [...new Set(ids)].slice(0, 4);
}

function whatifList(sid) {
  const chapters = new Map(db.where("chapters", h => h.source_id === sid).map(h => [h.id, h]));
  const listened = [...chapters.values()].filter(h => h.listened);
  return {
    finished: listened.length, pending: listened.filter(h => !h.whatifs_made).length,
    questions: db.where("whatifs", w => w.source_id === sid && chapters.get(w.chapter_id)?.listened)
      .sort((a, b) => chapters.get(a.chapter_id).idx - chapters.get(b.chapter_id).idx || a.at - b.at)
      .map(w => ({ id: w.id, chapter_id: w.chapter_id, chapter: chapters.get(w.chapter_id).title, question: w.question,
                   lead_start: w.lead_start, clip_end: w.clip_end, at: w.at, beyond: w.beyond, status: w.status, tries: w.tries, kind: w.kind })),
  };
}

let whatifLock = Promise.resolve();
function makeWhatifs(sid) {
  const job = whatifLock.then(() => writeWhatifs(sid));
  whatifLock = job.catch(() => {});
  return job;
}

async function writeWhatifs(sid) {
  const s = await settings();
  const todo = db.where("chapters", h => h.source_id === sid && h.listened && !h.whatifs_made).sort((a, b) => a.idx - b.idx);
  if (!todo.length) return null;
  const concepts = db.where("concepts", c => c.source_id === sid && !c.retired).sort((a, b) => b.score - a.score);
  const words = await db.wordsGet(sid);
  const byNumber = new Map(todo.map(h => [h.idx + 1, h]));
  const { questions, used, notice } = await ai.writeWhatifs(s, todo.map(h => ({ number: h.idx + 1, title: h.title,
    text: T.textBetween(words, h.start, h.end), terms: concepts.filter(c => c.chapter_id === h.id).map(c => c.term) })));
  const kept = [];
  for (const item of questions) {
    const ch = byNumber.get(item.chapter);
    if (!ch || kept.filter(k => k[0] === ch && k[2].kind === item.kind).length >= ai.PER_CHAPTER[item.kind]) continue;
    const at = T.locateQuote(words, ch.start, ch.end, item.quote);
    if (at != null) kept.push([ch, at, item]);
  }
  if (!kept.length) throw new HttpError(`${used} couldn't write questions that the lecture backs up. Try again.`, 502);
  for (const [ch, at, item] of kept) {
    const [lead, end] = whatifClip(words, ch, at, item.quote);
    db.put("whatifs", { source_id: sid, chapter_id: ch.id, at, lead_start: lead, clip_end: end, question: item.question, answer: item.answer,
      points: item.points, quote: item.quote, beyond: item.beyond ? 1 : 0, concept_ids: whatifConcepts(concepts.filter(c => c.chapter_id === ch.id), item),
      status: null, tries: 0, heard: null, created: now(), done_at: null, kind: item.kind });
  }
  for (const h of todo) db.update("chapters", h.id, { whatifs_made: 1 });  // the AI may skip a chapter with nothing to reason about
  return `Questions by ${used}.${notice ? " " + notice : ""}`;
}

function markExpert(ids) { for (const id of ids) { const c = db.one("concepts", id); if (c && !c.expert) db.update("concepts", id, { expert: now() }); } }

function recordWhatif(w, verdict, heard = null) {
  const sound = verdict === "sound";
  db.update("whatifs", w.id, { status: verdict, tries: (w.tries || 0) + (heard == null ? 0 : 1), heard: heard ?? w.heard, done_at: sound ? now() : null });
  if (sound) markExpert(w.concept_ids || []);
}

function termClip(c) {
  const start = c.context_at != null ? c.context_at : Math.max(0, c.first_at - 5);
  return [round(Math.max(0, start - 0.3)), round(start + 15)];
}

async function pairList() {
  const concepts = new Map(db.rows("concepts").map(c => [c.id, c]));
  const sources = new Map(db.rows("sources").map(s => [s.id, s]));
  const side = c => ({ id: c.id, term: c.term, sid: c.source_id, source: sources.get(c.source_id)?.name || "", clip: termClip(c) });
  const pairs = db.rows("pairs").filter(p => concepts.get(p.a_id) && concepts.get(p.b_id) && !concepts.get(p.a_id).retired && !concepts.get(p.b_id).retired)
    .sort((a, b) => (a.status === "sound") - (b.status === "sound") || a.id - b.id)
    .map(p => ({ id: p.id, status: p.status, tries: p.tries, a: side(concepts.get(p.a_id)), b: side(concepts.get(p.b_id)) }));
  const ready = new Set(db.where("sources", s => s.status === "ready").map(s => s.id));
  const newest = Math.max(0, ...db.where("concepts", c => !c.retired && c.level >= 2 && ready.has(c.source_id)).map(c => c.id));
  const seen = (await db.kvGet("pairs_seen")) || 0;
  return { pairs, stale: newest > seen, ai: hasAi(await settings()) };
}

async function makePairs() {
  const s = await settings();
  const sources = new Map(db.rows("sources").map(x => [x.id, x]));
  const terms = db.where("concepts", c => !c.retired && c.level >= 2 && sources.get(c.source_id)?.status === "ready")
    .sort((a, b) => b.level - a.level || b.id - a.id).slice(0, 200)
    .map(c => ({ id: c.id, term: c.term, definition: c.definition, lecture: sources.get(c.source_id).name }));
  if (terms.length < 2) throw new HttpError("Finish a few chapters first: pairs come from terms you've listened to.", 502);
  const { pairs, used } = await ai.findConfusable(s, terms);
  const ids = new Map(terms.map(t => [lower(t.term), t.id]));
  const have = new Set(db.rows("pairs").map(p => [p.a_id, p.b_id].sort().join("-")));
  let added = 0;
  for (const p of pairs) {
    const a = ids.get(lower(p.a)), b = ids.get(lower(p.b));
    const key = [a, b].sort().join("-");
    if (a && b && a !== b && !have.has(key)) {
      have.add(key);
      db.put("pairs", { a_id: a, b_id: b, difference: p.difference, points: p.points, status: null, tries: 0, heard: null, created: now(), done_at: null });
      added++;
    }
  }
  await db.kvSet("pairs_seen", Math.max(...terms.map(t => t.id)));
  return `${added} new pair${added === 1 ? "" : "s"} found by ${used}.`;
}

function recordPair(p, verdict, heard = null) {
  const sound = verdict === "sound";
  db.update("pairs", p.id, { status: verdict, tries: (p.tries || 0) + (heard == null ? 0 : 1), heard: heard ?? p.heard, done_at: sound ? now() : null });
  if (sound) markExpert([p.a_id, p.b_id]);
}

function mapData(sid) {
  const chapters = db.where("chapters", h => h.source_id === sid).sort((a, b) => a.idx - b.idx);
  const idx = new Map(chapters.map(h => [h.id, h.idx]));
  const live = new Set(db.where("concepts", c => c.source_id === sid && !c.retired).map(c => c.id));
  return {
    by: db.one("sources", sid)?.map_by || null,
    chapters: chapters.map(h => ({ id: h.id, title: h.title })),
    terms: db.where("concepts", c => c.source_id === sid && !c.retired).sort((a, b) => idx.get(a.chapter_id) - idx.get(b.chapter_id) || a.first_at - b.first_at)
      .map(c => ({ id: c.id, term: c.term, chapter_id: c.chapter_id, level: c.level, expert: c.expert, definition: c.definition })),
    links: db.where("links", l => l.source_id === sid && live.has(l.concept_id) && live.has(l.needs_id)).map(l => [l.concept_id, l.needs_id, l.how]),
  };
}

async function makeMap(sid) {
  const s = await settings();
  const terms = db.where("concepts", c => c.source_id === sid && !c.retired);
  const chapters = db.where("chapters", h => h.source_id === sid).sort((a, b) => a.idx - b.idx);
  let links = null, by = "this phone", note = null;
  if (hasAi(s)) {
    try {
      const r = await ai.linkTerms(s, chapters.map(h => ({ title: h.title, terms: terms.filter(t => t.chapter_id === h.id) })));
      const ids = new Map(terms.map(t => [lower(t.term), t.id]));
      links = r.links.filter(([a, b]) => ids.has(lower(a)) && ids.has(lower(b)) && lower(a) !== lower(b)).map(([a, b, how]) => [ids.get(lower(a)), ids.get(lower(b)), how]);
      by = r.used;
    } catch (e) { note = `${e.message} So the map was made on this phone, from the terms' definitions.`; }
  }
  if (!links) {  // a term builds on the other terms its definition or its sentence uses
    links = [];
    for (const t of terms) {
      const text = `${t.definition || ""} ${t.context || ""}`;
      links.push(...terms.filter(u => u.id !== t.id && T.phraseMatches(u.term, text) && !T.phraseMatches(t.term, u.term)).slice(0, 3).map(u => [t.id, u.id, "uses"]));
    }
  }
  db.removeWhere("links", l => l.source_id === sid);
  const seen = new Set();
  for (const [a, b, how] of links) { const k = `${a}-${b}`; if (!seen.has(k)) { seen.add(k); db.put("links", { source_id: sid, concept_id: a, needs_id: b, how }); } }
  db.update("sources", sid, { map_by: by });
  return note;
}

// ---------------------------------------------------------------- explanations checked like the PC version

async function checkChapter(chapter, spoken) {
  const s = await settings();
  let check = null, notice = null;
  if (hasAi(s)) {
    const terms = db.where("concepts", c => c.chapter_id === chapter.id && !c.retired).map(c => c.term);
    try { check = await ai.checkExplanation(s, await db.wordsGet(chapter.source_id), chapter.start, chapter.end, spoken, terms); notice = check.notice; }
    catch (e) { notice = e.message; }
  }
  return { check, notice, aiEnabled: hasAi(s) };
}

async function heardFrom(body, vocab) {
  if (body instanceof Blob) return hearAnswer(body, vocab);
  return { text: String(body?.text || ""), by: null, notice: null };
}

// ---------------------------------------------------------------- routes

async function get(path, q) {
  let m;
  if (path === "/api/sources") {
    const chapters = db.rows("chapters"), concepts = db.rows("concepts");
    return db.rows("sources").sort((a, b) => b.created - a.created).map(s => ({ id: s.id, name: s.name, duration: s.duration, status: s.status,
      stage: s.stage, progress: s.progress, error: s.error, created: s.created, concepts: concepts.filter(c => c.source_id === s.id).length,
      chapters: chapters.filter(h => h.source_id === s.id).length, listened: chapters.filter(h => h.source_id === s.id && h.listened).length }));
  }
  if ((m = path.match(/^\/api\/sources\/([\w-]+)$/))) {
    const s = db.one("sources", m[1]);
    if (!s) throw new HttpError("Not found", 404);
    return { ...s, vocab: undefined, silences: s.silences || [], speed: s.speed ?? 1.25, position: s.position || 0,
      marks: db.where("marks", k => k.source_id === s.id).sort((a, b) => a.at - b.at).map(k => [k.at, k.kind]),
      chapters: db.where("chapters", h => h.source_id === s.id).sort((a, b) => a.idx - b.idx),
      concepts: db.where("concepts", c => c.source_id === s.id && !c.retired).sort((a, b) => b.score - a.score) };
  }
  if ((m = path.match(/^\/api\/sources\/([\w-]+)\/transcript$/))) {
    const s = db.one("sources", m[1]), words = await db.wordsGet(m[1]);
    if (!s || !words.length) throw new HttpError("No transcript is saved for this lecture.", 404);
    return { by: s.heard_by || "Gemini", approx: true, lines: T.transcriptLines(words), sparse: false };
  }
  if ((m = path.match(/^\/api\/sources\/([\w-]+)\/whatifs$/))) return { ...whatifList(m[1]), ai: hasAi(await settings()) };
  if ((m = path.match(/^\/api\/sources\/([\w-]+)\/map$/))) return mapData(m[1]);
  if (path === "/api/review") return reviewQueue(SESSION_SIZE, q.source || null);
  if (path === "/api/recall") return recallQueue();
  if (path === "/api/pairs") return pairList();
  if (path === "/api/playlist") {
    const sources = new Map(db.rows("sources").map(s => [s.id, s]));
    return db.where("clips", p => p.done_at == null).sort((a, b) => b.created - a.created || b.id - a.id)
      .map(p => ({ ...p, source: sources.get(p.source_id)?.name || "", term: p.concept_id != null ? db.one("concepts", p.concept_id)?.term || null : null }));
  }
  if (path === "/api/tracker") return tracker();
  if (path === "/api/settings") return publicSettings(await settings());
  if (path === "/api/references") return [];
  if (path === "/api/summary") {
    const all = tracker();
    return { due: reviewQueue().length + recallQueue().length, clips: db.where("clips", p => p.done_at == null).length,
             concepts: all.length, secure: all.filter(c => c.secure).length, model_ready: true };
  }
  throw new HttpError("Not found", 404);
}

async function post(path, q, body) {
  let m;
  if (path === "/api/sources") {
    if (!(body instanceof Blob) || !body.size) throw new HttpError("The file was empty.");
    const sid = crypto.randomUUID().replace(/-/g, "").slice(0, 12), name = q.name || "Untitled";
    await db.filePut(sid, body);
    db.put("sources", { id: sid, name: name.replace(/\.[a-z0-9]{1,5}$/i, "").replace(/^[0-9A-F]{8}-/, "") || name, file_name: name,
      duration: null, status: "queued", stage: "Waiting", progress: 0, error: null, created: now(), position: 0, speed: 1.25,
      silences: [], vocab: "", note: null, heard_by: null });
    queueJob("import", sid);
    return { id: sid };
  }
  if ((m = path.match(/^\/api\/sources\/([\w-]+)\/retry$/))) {
    const s = db.one("sources", m[1]);
    db.update("sources", m[1], { status: "queued", stage: "Waiting", progress: 0, error: null });
    queueJob(s?.words_saved ? "reanalyse" : "import", m[1]);
    return { ok: true };
  }
  if ((m = path.match(/^\/api\/sources\/([\w-]+)\/reanalyse$/))) {
    const s = db.one("sources", m[1]);
    if (!s || !s.words_saved) throw new HttpError("Not found", 404);
    if (["queued", "processing"].includes(s.status)) throw new HttpError("This lecture is already being worked on.");
    db.update("sources", m[1], { status: "queued", stage: "Waiting", progress: 0, error: null });
    queueJob("reanalyse", m[1]);
    return { ok: true };
  }
  if ((m = path.match(/^\/api\/sources\/([\w-]+)\/state$/))) {
    const fields = {};
    for (const k of ["position", "speed"]) if (k in (body || {})) fields[k] = Number(body[k]);
    if (Object.keys(fields).length) db.update("sources", m[1], fields);
    return { ok: true };
  }
  if ((m = path.match(/^\/api\/sources\/([\w-]+)\/marks$/))) {
    if (!["slow", "back", "clip"].includes(body?.kind)) throw new HttpError("Unknown mark.");
    db.put("marks", { source_id: m[1], at: Number(body.at) || 0, kind: body.kind, ts: now() });
    return { ok: true };
  }
  if ((m = path.match(/^\/api\/sources\/([\w-]+)\/concepts$/))) {
    const sid = m[1], words = await db.wordsGet(sid);
    const chapters = db.where("chapters", h => h.source_id === sid).sort((a, b) => a.idx - b.idx);
    if (!chapters.length) throw new HttpError("This lecture isn't ready yet.");
    let c;
    try { c = T.conceptFromSelection(words, chapters, body.term || "", Number(body.at) || 0, db.where("concepts", x => x.source_id === sid && !x.retired).map(x => x.term)); }
    catch (e) { throw new HttpError(e.message); }
    const ch = chapters[c.chapter];
    const scores = db.where("concepts", x => x.chapter_id === ch.id).map(x => x.score);
    const row = db.put("concepts", { source_id: sid, chapter_id: ch.id, term: c.term, score: (scores.length ? Math.min(...scores) : 1) - 1,
      first_at: c.first_at, level: ch.listened ? T.L_GENERAL : T.L_INITIAL, covered: null, stability: null, difficulty: null, last_review: null,
      due: null, reps: 0, lapses: 0, retired: 0, next_card: 0, context: c.context, context_at: c.context_at, defined: c.defined ? 1 : 0,
      preview: 0, definition: null, definition_ref: null, expert: 0, known: 0 });
    for (const card of c.cards) db.put("cards", { concept_id: row.id, lead_start: card.lead_start, cut: card.cut, target_end: card.target_end,
      resume_end: card.resume_end, sentence: card.sentence });
    return { id: row.id, term: c.term, chapter: ch.title, cards: c.cards.length };
  }
  if ((m = path.match(/^\/api\/sources\/([\w-]+)\/whatifs$/))) {
    if (!hasAi(await settings())) throw new HttpError("Expert questions are written and checked by Gemini. Add your Gemini key in Settings.");
    let note;
    try { note = await makeWhatifs(m[1]); } catch (e) { throw e instanceof HttpError ? e : new HttpError(e.message, 502); }
    return { ...whatifList(m[1]), ai: true, notice: note };
  }
  if ((m = path.match(/^\/api\/sources\/([\w-]+)\/map$/))) {
    const notice = await makeMap(m[1]);
    return { ...mapData(m[1]), notice };
  }
  if ((m = path.match(/^\/api\/chapters\/(\d+)\/(summary|recall)$/))) {
    const cid = Number(m[1]), chapter = db.one("chapters", cid);
    if (!chapter) throw new HttpError("Not found", 404);
    const vocab = db.one("sources", chapter.source_id)?.vocab || "";
    const heard = await heardFrom(body, vocab);
    const spoken = heard.text;
    if (!spoken.trim()) return { heard: "", concepts: [], empty: true };
    const { check, notice, aiEnabled } = await checkChapter(chapter, spoken);
    const recall = m[2] === "recall";
    const concepts = await gradeSummary(chapter, spoken, check, recall ? "Forgotten when recalling from memory" : undefined);
    const score = summaryScore(concepts, check), below = belowStandard(score, check);
    const out = { heard: spoken, concepts, notice, heard_by: heard.by, hear_notice: heard.notice, ai_enabled: aiEnabled,
                  standard: { score, pass: PASS_MARK, below } };
    if (recall) {
      out.source_id = chapter.source_id;
      out.next_days = scheduleRecall(cid, below ? 0 : (chapter.recall_step || 0) + 1);
    } else {
      let split = null;
      if (!below) scheduleRecall(cid, 0);
      else {  // not finished until it's explained to the standard: replaying checks it again
        db.update("chapters", cid, { listened: 0 });
        if (chapter.end - chapter.start >= MIN_SPLIT_SECONDS) split = splitChapter(db.one("chapters", cid), await db.wordsGet(chapter.source_id));
      }
      out.split = split;
    }
    if (check) Object.assign(out, { verdict: check.verdict, summary: check.summary, points: check.points, beyond: [], used_refs: false });
    return out;
  }
  if ((m = path.match(/^\/api\/chapters\/(\d+)\/skip$/))) {
    const cid = Number(m[1]);
    db.update("chapters", cid, { listened: 1 });
    for (const c of db.where("concepts", c => c.chapter_id === cid && c.level < 2)) db.update("concepts", c.id, { level: 2 });
    scheduleRecall(cid, 0);
    return { ok: true };
  }
  if ((m = path.match(/^\/api\/chapters\/(\d+)\/title$/))) {
    const title = String(body?.title || "").trim();
    if (!title) throw new HttpError("A chapter needs a title.");
    db.update("chapters", Number(m[1]), { title: title.slice(0, 120) });
    return { ok: true };
  }
  if ((m = path.match(/^\/api\/concepts\/(\d+)\/(covered|retire|known)$/))) {
    const id = Number(m[1]), c = db.one("concepts", id);
    if (!c) throw new HttpError("Not found", 404);
    if (m[2] !== "known") db.removeWhere("clips", p => p.concept_id === id && p.done_at == null);
    if (m[2] === "covered") db.update("concepts", id, { level: T.L_RECALL, covered: 1, due: c.due ?? now() });
    if (m[2] === "retire") db.update("concepts", id, { retired: 1 });
    if (m[2] === "known") db.update("concepts", id, { known: 1, preview: 0, level: Math.max(c.level, T.L_RECALL) });  // review checks it
    return { ok: true };
  }
  if (path === "/api/clips") {
    const s = db.one("sources", body.source_id);
    if (!s) throw new HttpError("Not found", 404);
    const t = Number(body.at);
    return { id: await addClip(s.id, Math.max(0, t - 15), Math.min(s.duration || t + 15, t + 15), "You clipped this") };
  }
  if ((m = path.match(/^\/api\/clips\/(\d+)\/done$/))) { db.update("clips", Number(m[1]), { done_at: now() }); return { ok: true }; }
  if ((m = path.match(/^\/api\/clips\/(\d+)\/check$/))) {
    const clip = db.one("clips", Number(m[1]));
    if (!clip) throw new HttpError("Not found", 404);
    const term = clip.concept_id != null ? db.one("concepts", clip.concept_id)?.term || null : null;
    const heard = await heardFrom(body, db.one("sources", clip.source_id)?.vocab || "");
    if (!heard.text.trim()) return { heard: "", empty: true };
    const out = { heard: heard.text, heard_by: heard.by, hear_notice: heard.notice, notice: null };
    const s = await settings();
    if (hasAi(s)) {
      try { Object.assign(out, await ai.judgeGap(s, clip.transcript, term, heard.text)); }
      catch (e) { out.notice = `${e.message} So only the term check ran.`; }
    }
    if (!("understood" in out)) {
      const said = !!term && T.phraseMatches(term, heard.text);
      Object.assign(out, { understood: term ? said : null, by: null, feedback: term ? (said ? `You said “${term}”.` : `You didn't say “${term}”.`) : "" });
    }
    return out;
  }
  if (path === "/api/review/answer") {
    const concept = db.one("concepts", Number(q.concept)), cardId = Number(q.card);
    if (!concept) throw new HttpError("Not found", 404);
    let heard = "", onset = null, heardBy = null, hearNotice = null;
    if (body instanceof Blob) {
      onset = q.onset_ms ? Number(q.onset_ms) : null;
      if (onset != null) {  // no voice detected: don't ask, since a transcriber can invent words from silence
        const got = await hearAnswer(body, db.one("sources", concept.source_id)?.vocab || "");
        heard = got.text; heardBy = got.by; hearNotice = got.notice;
      }
    } else heard = String(body?.text || "").trim();
    let correct = T.phraseMatches(concept.term, heard), judge = null;
    const s = await settings();
    if (!correct && heard && hasAi(s) && !T.saysOpposite(concept.term, heard)) {
      // Not word for word: the AI decides whether it still names the same thing ("MI").
      try { judge = await ai.judgeAnswer(s, concept.term, db.one("cards", cardId)?.sentence || "", heard); correct = judge.correct; }
      catch (e) { judge = { error: e.message }; }
    }
    return { ...(await applyReview(concept, cardId, heard, correct, onset)), judge, heard_by: heardBy, hear_notice: hearNotice };
  }
  if ((m = path.match(/^\/api\/review\/(\d+)\/overrule$/))) {
    const r = await overruleReview(Number(m[1]), !!body?.correct);
    if (!r) throw new HttpError("Not found", 404);
    return r;
  }
  if ((m = path.match(/^\/api\/whatifs\/(\d+)\/answer$/))) {
    const w = db.one("whatifs", Number(m[1]));
    if (!w) throw new HttpError("Not found", 404);
    const chapter = db.one("chapters", w.chapter_id), src = db.one("sources", w.source_id);
    const heard = await heardFrom(body, src?.vocab || "");
    if (!heard.text.trim()) return { heard: "", empty: true };
    const s = await settings();
    if (!hasAi(s)) throw new HttpError("Checking this needs Gemini. Add your Gemini key in Settings.");
    let r;
    try { r = await ai.judgeWhatif(s, T.textBetween(await db.wordsGet(w.source_id), chapter.start, chapter.end), w, heard.text, w.kind); }
    catch (e) { throw new HttpError(e.message, 502); }
    recordWhatif(w, r.verdict, heard.text);
    return { ...r, heard: heard.text, heard_by: heard.by, hear_notice: heard.notice, answer: w.answer, points: w.points, quote: w.quote,
             at: w.at, beyond: !!w.beyond, used_refs: false };
  }
  if ((m = path.match(/^\/api\/whatifs\/(\d+)\/overrule$/))) {
    const w = db.one("whatifs", Number(m[1]));
    if (!w) throw new HttpError("Not found", 404);
    recordWhatif(w, "sound");
    return { ok: true };
  }
  if (path === "/api/pairs") {
    if (!hasAi(await settings())) throw new HttpError("Finding easily confused terms needs Gemini. Add your Gemini key in Settings.");
    let note;
    try { note = await makePairs(); } catch (e) { throw e instanceof HttpError ? e : new HttpError(e.message, 502); }
    return { ...(await pairList()), notice: note };
  }
  if ((m = path.match(/^\/api\/pairs\/(\d+)\/answer$/))) {
    const p = db.one("pairs", Number(m[1])), a = p && db.one("concepts", p.a_id), b = p && db.one("concepts", p.b_id);
    if (!a || !b) throw new HttpError("Not found", 404);
    const heard = await heardFrom(body, `${db.one("sources", a.source_id)?.vocab || ""} ${db.one("sources", b.source_id)?.vocab || ""}`);
    if (!heard.text.trim()) return { heard: "", empty: true };
    const s = await settings();
    const passage = async c => `About ${c.term}: ` + T.textBetween(await db.wordsGet(c.source_id), ...termClip(c));
    const item = { question: `What is the key difference between ${a.term} and ${b.term}?`, answer: p.difference, points: p.points || [] };
    let r;
    try { r = await ai.judgeWhatif(s, `${await passage(a)}\n\n${await passage(b)}`, item, heard.text, "pair"); }
    catch (e) { throw new HttpError(e.message, 502); }
    recordPair(p, r.verdict, heard.text);
    return { ...r, heard: heard.text, heard_by: heard.by, hear_notice: heard.notice, answer: p.difference, points: item.points, quote: "", beyond: false };
  }
  if ((m = path.match(/^\/api\/pairs\/(\d+)\/overrule$/))) {
    const p = db.one("pairs", Number(m[1]));
    if (!p) throw new HttpError("Not found", 404);
    recordPair(p, "sound");
    return { ok: true };
  }
  if (path === "/api/settings") {
    const s = await settings();
    if (typeof body?.gemini_key === "string") s.gemini_key = body.gemini_key.trim();
    if (ai.MODELS[body?.gemini_model]) s.gemini_model = body.gemini_model;
    await db.kvSet("settings", s);
    return publicSettings(s);
  }
  if (path === "/api/settings/test") return ai.testKey(await settings());
  if (path === "/api/documents" || path === "/api/references") throw new HttpError("This isn't available in the phone version yet.");
  throw new HttpError("Not found", 404);
}

async function del(path) {
  let m;
  if ((m = path.match(/^\/api\/clips\/(\d+)$/))) { db.remove("clips", Number(m[1])); return { ok: true }; }
  if ((m = path.match(/^\/api\/sources\/([\w-]+)$/))) {
    const sid = m[1];
    if (!db.one("sources", sid)) throw new HttpError("Not found", 404);
    clearLearning(sid);
    db.removeWhere("marks", k => k.source_id === sid);
    db.remove("sources", sid);
    if (mediaUrls.has(sid)) { URL.revokeObjectURL(mediaUrls.get(sid)); mediaUrls.delete(sid); }
    await Promise.all([db.fileDel(sid), db.wordsDel(sid), db.kvDel(`partial:${sid}`)]);
    return { ok: true };
  }
  throw new HttpError("Not found", 404);
}

// ---------------------------------------------------------------- fetch: /api/ requests are answered here

export async function handle(method, url, body) {
  const u = new URL(url, location.href);
  const path = u.pathname.slice(u.pathname.indexOf("/api/"));
  const q = Object.fromEntries(u.searchParams);
  try {
    const out = method === "GET" ? await get(path, q) : method === "DELETE" ? await del(path) : await post(path, q, body);
    return [200, out];
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    return [e.status || 500, { error: e.message || "Something went wrong." }];
  }
}

export async function install() {
  await db.open();
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const u = new URL(url, location.href);
    if (u.origin !== location.origin || !u.pathname.includes("/api/")) return realFetch(input, init);
    const method = (init.method || "GET").toUpperCase();
    let body = init.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch {} }
    const [status, out] = await handle(method, url, body);
    return new Response(JSON.stringify(out), { status, headers: { "Content-Type": "application/json" } });
  };
  resumeJobs();
}
