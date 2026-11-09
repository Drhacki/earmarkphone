// Text and learning logic with no storage or network: answer matching, FSRS scheduling, levels,
// and the transcript helpers that cut chapters and review prompts. Ported from learn.py and
// analysis.py of the PC version, so both behave the same.

// ---------------------------------------------------------------- similarity (Python's difflib)

/** Python's difflib.SequenceMatcher(None, a, b).ratio(), for strings or arrays without junk. */
export function ratio(a, b) {
  if (!a.length && !b.length) return 1;
  let matched = 0;
  for (const [, , k] of matchingBlocks(a, b)) matched += k;
  return (2 * matched) / (a.length + b.length);
}

export function matchingBlocks(a, b) {
  const b2j = new Map();
  for (let j = 0; j < b.length; j++) {
    if (!b2j.has(b[j])) b2j.set(b[j], []);
    b2j.get(b[j]).push(j);
  }
  const longest = (alo, ahi, blo, bhi) => {
    let besti = alo, bestj = blo, bestsize = 0, j2len = new Map();
    for (let i = alo; i < ahi; i++) {
      const next = new Map();
      for (const j of b2j.get(a[i]) || []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) || 0) + 1;
        next.set(j, k);
        if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; }
      }
      j2len = next;
    }
    return [besti, bestj, bestsize];
  };
  const blocks = [], queue = [[0, a.length, 0, b.length]];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop();
    const [i, j, k] = longest(alo, ahi, blo, bhi);
    if (!k) continue;
    blocks.push([i, j, k]);
    if (alo < i && blo < j) queue.push([alo, i, blo, j]);
    if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
  }
  return blocks.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
}

// ---------------------------------------------------------------- matching answers

// Terms that look or sound alike but mean opposite things: "hypokalemia" is not a near miss
// for "hyperkalemia", it is the wrong answer.
const OPPOSITES = [
  ["hyper", "hypo"], ["tachy", "brady"], ["macro", "micro"], ["endo", "exo"],
  ["intra", "extra"], ["pre", "post"], ["ante", "retro"], ["afferent", "efferent"],
  ["medial", "lateral"], ["proximal", "distal"], ["anterior", "posterior"],
  ["superior", "inferior"], ["dorsal", "ventral"], ["systolic", "diastolic"],
  ["sympathetic", "parasympathetic"], ["agonist", "antagonist"], ["arterial", "venous"],
  ["ileum", "ilium"], ["mono", "poly"], ["hemo", "hemi"], ["uni", "bi"],
];

export const tokens = text => (String(text || "").toLowerCase().replace(/-/g, "").match(/[a-z0-9]+/g) || []);
export const clean = word => String(word).toLowerCase().replace(/[^a-z0-9]/g, "");

export function stem(word) {
  word = word.toLowerCase();
  if (word.length > 4 && word.endsWith("s") && !/(ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

export function soundKey(word) {
  let w = word.toLowerCase();
  for (const [a, b] of [["ph", "f"], ["ae", "e"], ["oe", "e"], ["ck", "k"], ["qu", "k"], ["x", "ks"], ["c", "k"], ["y", "i"], ["z", "s"]]) {
    w = w.split(a).join(b);
  }
  w = w ? w[0] + w.slice(1).replace(/[aeiouh]/g, "") : w;
  return w.replace(/(.)\1+/g, "$1");
}

export function isOpposite(a, b) {
  return OPPOSITES.some(([x, y]) => (a.startsWith(x) && b.startsWith(y)) || (a.startsWith(y) && b.startsWith(x)));
}

export function wordMatches(expected, spoken) {
  expected = stem(expected); spoken = stem(spoken);
  if (expected === spoken) return true;
  if (Math.min(expected.length, spoken.length) < 5) return false;  // shorter: one letter is a different word
  if (expected[0] !== spoken[0] || isOpposite(expected, spoken)) return false;
  if (soundKey(expected) === soundKey(spoken)) return true;
  return ratio(expected, spoken) >= 0.84;
}

/** True when the answer has a look-alike opposite of a word in the term ("hypokalemia" for "hyperkalemia"). */
export function saysOpposite(expected, spokenText) {
  for (const w of tokens(expected)) {
    for (const s of tokens(spokenText)) {
      for (const [x, y] of OPPOSITES) {
        for (const [a, b] of [[x, y], [y, x]]) {
          if (!(w.startsWith(a) && s.startsWith(b))) continue;
          const restW = w.slice(a.length), restS = s.slice(b.length);
          if ((restW === "" && restS === "") || (restW.length >= 3 && ratio(restW, restS) >= 0.8)) return true;
        }
      }
    }
  }
  return false;
}

/** True when every word of the expected term was said, in any order. */
export function phraseMatches(expected, spokenText) {
  const wanted = tokens(expected);
  if (!wanted.length) return false;
  // Speech recognition writes "C-reactive" as "C reactive", so also try single letters joined on.
  const joined = String(spokenText || "").toLowerCase().replace(/\b([a-z])[\s-]+(?=[a-z])/g, "$1");
  return [tokens(spokenText), tokens(joined)].some(said => wanted.every(w => said.some(s => wordMatches(w, s))));
}

// ---------------------------------------------------------------- FSRS-4.5 scheduling

const W = [0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031, 1.6474,
  0.1367, 1.0461, 2.1072, 0.0793, 0.3246, 1.587, 0.2272, 2.8755];
const DECAY = -0.5, FACTOR = 19 / 81;
export const AGAIN = 1, HARD = 2, GOOD = 3, EASY = 4;
export const DAY = 86400;
const AGAIN_DELAY = 600;  // a failed term comes back after its clip, not days later
const clampD = d => Math.min(10, Math.max(1, d));
const initD = g => clampD(W[4] - (g - 3) * W[5]);
const retrievability = (days, s) => (1 + FACTOR * days / s) ** DECAY;

/** Returns [stability, difficulty, due]. s and d are null for a first review. */
export function schedule(s, d, lastReview, grade, now) {
  let s2, d2;
  if (s == null) {
    s2 = W[grade - 1]; d2 = initD(grade);
  } else {
    const r = retrievability(Math.max(0, now - lastReview) / DAY, s);
    d2 = clampD(W[7] * initD(GOOD) + (1 - W[7]) * (d - W[6] * (grade - 3)));
    if (grade === AGAIN) {
      s2 = Math.min(W[11] * d2 ** -W[12] * ((s + 1) ** W[13] - 1) * Math.exp(W[14] * (1 - r)), s);
    } else {
      const bonus = (grade === HARD ? W[15] : 1) * (grade === EASY ? W[16] : 1);
      s2 = s * (1 + Math.exp(W[8]) * (11 - d2) * s ** -W[9] * (Math.exp(W[10] * (1 - r)) - 1) * bonus);
    }
  }
  if (grade === AGAIN) return [s2, d2, now + AGAIN_DELAY];
  return [s2, d2, now + Math.max(1, Math.round(s2)) * DAY];  // stability is the interval at 90% retention
}

export const FAST_ONSET_MS = 2000, SECURE_STABILITY_DAYS = 21;
export const L_INITIAL = 1, L_GENERAL = 2, L_GAPS = 3, L_RECALL = 4;
/** Voice can't report how hard an answer felt, so response time stands in. */
export const rate = (correct, onsetMs) => !correct ? AGAIN : onsetMs != null && onsetMs <= FAST_ONSET_MS ? EASY : GOOD;
export const levelAfterReview = (level, correct) => correct ? L_RECALL : L_GAPS;
/** Multi-word answers take longer to say, so the countdown scales. */
export const answerSeconds = answer => 4 + 1.5 * Math.max(0, answer.split(/\s+/).length - 1);

// ---------------------------------------------------------------- transcripts

const MIN_TERM_CONF = 0.75, CARDS_PER_CONCEPT = 3, CONCEPTS_PER_CHAPTER = 7, PREVIEW_TERMS = 6, MIN_AI_CHAPTER = 60;
const CUT_MARGIN = 0.06, APPROX_MARGIN = 0.6, APPROX_TAIL = 0.4;
const DEF_CUE = /\b(called|we call|known as|refers? to|referred to|defined as|definition of|termed|stands for|which means|that means|is when)\b/;

/** Index ranges [i, j) of words, one per sentence. Long unpunctuated runs are split at pauses. */
export function sentences(words, maxWords = 28, pause = 1.2) {
  const out = [];
  let begin = 0;
  words.forEach((w, i) => {
    const ended = /[.?!:]$/.test(w.w);
    const gap = i + 1 < words.length && words[i + 1].s - w.e > pause;
    if (ended || gap || i - begin + 1 >= maxWords || i === words.length - 1) { out.push([begin, i + 1]); begin = i + 1; }
  });
  return out;
}

export const textBetween = (words, start, end) => words.filter(w => w.e > start && w.s < end).map(w => w.w).join(" ");
export const linesForAi = words => sentences(words).map(([a, b]) => [words[a].s, words.slice(a, b).map(w => w.w).join(" ")]);
const sentenceText = (words, sents, si) => words.slice(sents[si][0], sents[si][1]).map(w => w.w).join(" ");
export const chapterOf = (t, chapters) => { const i = chapters.findIndex(c => c.start <= t && t < c.end); return i < 0 ? chapters.length - 1 : i; };

/** The saved transcript as timed sentences, [start, end, text], for reading along. */
export const transcriptLines = words => sentences(words).map(([a, b]) =>
  [Math.round(words[a].s * 100) / 100, Math.round(words[b - 1].e * 100) / 100, words.slice(a, b).map(w => w.w).join(" ")]);

/** Gaps between sentences long enough to skip, from the word times: [[start, end], ...]. */
export function silences(words, min = 0.8, pad = 0.15) {
  const out = [];
  for (let i = 1; i < words.length; i++) {
    const a = words[i - 1].e + pad, b = words[i].s - pad;
    if (b - a >= min) out.push([Math.round(a * 100) / 100, Math.round(b * 100) / 100]);
  }
  return out;
}

/** Every place a term is said, allowing speech recognition's spellings. */
export function findSpots(words, sents, term) {
  const wanted = tokens(term);
  if (!wanted.length) return [];
  const sentOf = new Map();
  sents.forEach(([a, b], si) => { for (let k = a; k < b; k++) sentOf.set(k, si); });
  const spoken = words.map(w => clean(w.w));
  const spots = [];
  for (let k = 0; k <= spoken.length - wanted.length;) {
    if (wanted.every((x, m) => wordMatches(x, spoken[k + m]))) {
      spots.push({ i: k, j: k + wanted.length, sent: sentOf.get(k) || 0 });
      k += wanted.length;
    } else k++;
  }
  return spots;
}

export function countUses(words, start, end, term) {
  const wanted = tokens(term);
  const spoken = words.filter(w => start <= w.s && w.s < end).map(w => clean(w.w));
  let n = 0;
  for (let k = 0; k + wanted.length <= spoken.length; k++) if (wanted.every((x, m) => wordMatches(x, spoken[k + m]))) n++;
  return n;
}

/** Review prompts for a term: the lecture plays up to just before the term is said, then goes silent.
    A prompt is rejected if its lead-in gives the answer away. approx: word times are estimates. */
export function makeCards(concept, words, sents, approx = true) {
  const [margin, tail] = approx ? [APPROX_MARGIN, APPROX_TAIL] : [CUT_MARGIN, 0];
  const answerStems = new Set(concept.key.split(" "));
  const cards = [];
  for (const spot of concept.spots) {
    const { i, j, sent: si } = spot;
    if (words[i].p < MIN_TERM_CONF || i === 0) continue;
    const targetS = words[i].s, targetE = words[j - 1].e;
    let leadI = sents[si][0];
    for (let k = si; k >= 0; k--) { leadI = sents[k][0]; if (targetS - words[leadI].s >= 6) break; }
    while (targetS - words[leadI].s > 18) leadI++;
    for (let k = i - 1; k >= leadI; k--) { if (answerStems.has(stem(clean(words[k].w)))) { leadI = k + 1; break; } }
    if (i - leadI < 6 || targetS - words[leadI].s < 2.5) continue;
    const prevE = words[i - 1].e;
    const cut = approx ? targetS - margin : Math.min(targetS - margin, (prevE + targetS) / 2);
    if (approx && cut - words[leadI].s < 2) continue;
    let endI = sents[si][1] - 1;
    if (si + 1 < sents.length && words[endI].e - targetE < 2) endI = sents[si + 1][1] - 1;
    const [a, b] = sents[si];
    cards.push({
      lead_start: Math.max(0, words[leadI].s - 0.05), cut: Math.max(0, cut), target_end: targetE + tail,
      resume_end: words[endI].e + 0.1, sentence: words.slice(a, b).map(w => w.w).join(" "),
      quality: (i - a >= 3 ? 1 : 0) + words[i].p,
    });
  }
  return cards.sort((x, y) => y.quality - x.quality).slice(0, CARDS_PER_CONCEPT);
}

/** Chapters and terms an AI picked, checked against the transcript: chapter starts snap to sentence
    starts, and a term is kept only if it is actually said, so it can't become an impossible prompt. */
export function fromAi(words, duration, data, approx = true) {
  const sents = sentences(words);
  const starts = sents.length ? sents.map(([a]) => words[a].s) : [0];
  const raw = [];
  for (const ch of data.chapters || []) {
    const t = Number(ch.start);
    if (!Number.isFinite(t)) continue;
    const snapped = t <= starts[0] ? 0 : starts.reduce((best, s) => Math.abs(s - t) < Math.abs(best - t) ? s : best, starts[0]);
    raw.push({ start: snapped, title: String(ch.title || "").trim().slice(0, 120) || "Untitled section", terms: ch.terms || [] });
  }
  raw.sort((x, y) => x.start - y.start);
  const merged = [];
  for (const ch of raw) {
    if (merged.length && ch.start - merged[merged.length - 1].start < MIN_AI_CHAPTER) {
      merged[merged.length - 1].terms = merged[merged.length - 1].terms.concat(ch.terms);  // too short: joins the one before
      continue;
    }
    merged.push(ch);
  }
  if (!merged.length) throw new Error("The AI didn't return any usable chapters.");
  merged[0].start = 0;
  const chapters = merged.map((c, k) => ({ start: c.start, end: k + 1 < merged.length ? merged[k + 1].start : duration, title: c.title }));
  const concepts = [], seen = new Set();
  let previews = 0;
  merged.forEach((ch, ci) => {
    let rank = 0;
    for (const t of ch.terms) {
      if (!t || typeof t !== "object") continue;
      const written = String(t.term || "").replace(/^\W+|\W+$/g, "").trim().slice(0, 80);
      const term = tokens(written).join(" ");
      const key = term.split(" ").map(stem).join(" ");
      if (!term || seen.has(key) || rank >= CONCEPTS_PER_CHAPTER) continue;
      const spots = findSpots(words, sents, term);
      if (!spots.length) continue;
      seen.add(key);
      // The AI places a term by topic. If it's never said in that chapter, it goes where it's said most.
      let home = ci;
      let inHome = spots.filter(o => chapterOf(words[o.i].s, chapters) === ci);
      if (!inHome.length) {
        const counts = new Map();
        for (const o of spots) { const c = chapterOf(words[o.i].s, chapters); counts.set(c, (counts.get(c) || 0) + 1); }
        home = [...counts.entries()].sort((x, y) => y[1] - x[1])[0][0];
        inHome = spots.filter(o => chapterOf(words[o.i].s, chapters) === home);
      }
      const context = inHome[0];
      const preview = !!t.preview && previews < PREVIEW_TERMS;
      previews += preview ? 1 : 0;
      concepts.push({
        chapter: home, key, term: written, score: Math.round((100 - ci - rank / 10) * 1000) / 1000, spots,
        first_at: words[spots[0].i].s, defined: !!t.from_lecture, preview,
        definition: String(t.definition || "").trim().slice(0, 300) || null,
        context: sentenceText(words, sents, context.sent), context_at: words[sents[context.sent][0]].s,
      });
      rank++;
    }
  });
  for (const c of concepts) { c.cards = makeCards(c, words, sents, approx); delete c.spots; }
  return { chapters, concepts };
}

/** A term the learner picked out of the transcript, said near `at`. Throws Error with the reason. */
export function conceptFromSelection(words, chapters, text, at, existing = []) {
  const written = String(text).replace(/^\W+|\W+$/g, "").trim().slice(0, 80);
  const term = tokens(written).join(" ");
  if (!term || term.split(" ").length > 6) throw new Error("Select a term of 1 to 6 words.");
  const key = term.split(" ").map(stem).join(" ");
  if (existing.some(e => tokens(e).map(stem).join(" ") === key)) throw new Error(`“${written}” is already one of this lecture's terms.`);
  const sents = sentences(words);
  const spots = findSpots(words, sents, term);
  if (!spots.length) throw new Error(`“${written}” isn't found in the transcript as written.`);
  const home = chapterOf(at, chapters);
  const inHome = spots.filter(o => chapterOf(words[o.i].s, chapters) === home);
  const pool = inHome.length ? inHome : spots;
  const near = pool.reduce((best, o) => Math.abs(words[o.i].s - at) < Math.abs(words[best.i].s - at) ? o : best, pool[0]);
  const defined = spots.some(o => DEF_CUE.test(sentenceText(words, sents, o.sent).toLowerCase()));
  const concept = { chapter: home, key, term: written, spots, first_at: words[pool[0].i].s, defined,
                    context: sentenceText(words, sents, near.sent), context_at: words[sents[near.sent][0]].s };
  concept.cards = makeCards(concept, words, sents, true);
  delete concept.spots;
  return concept;
}

/** Where to cut a chapter in two: a sentence start near the middle, preferring a long pause. */
export function splitPoint(words, start, end) {
  const inside = [];
  words.forEach((w, k) => { if (start <= w.s && w.s < end) inside.push(k); });
  if (inside.length < 2) return null;
  const middle = (start + end) / 2, length = end - start;
  const span = words.slice(inside[0], inside[inside.length - 1] + 1);
  const starts = new Set(sentences(span).map(([a]) => span[a].s));
  let best = null, bestScore = null;
  for (const k of inside.slice(1)) {
    const t = words[k].s;
    if (!(start + 0.35 * length <= t && t <= start + 0.65 * length)) continue;
    const score = Math.min(t - words[k - 1].e, 3) + (starts.has(t) ? 1 : 0) - Math.abs(t - middle) / length * 10;
    if (bestScore === null || score > bestScore) { best = t; bestScore = score; }
  }
  if (best === null) best = inside.slice(1).map(k => words[k].s).reduce((x, y) => Math.abs(y - middle) < Math.abs(x - middle) ? y : x);
  return Math.round(best * 1000) / 1000;
}

/** Times per word from an AI transcript's timed segments: each word gets its share of the letters. */
export function wordsFromSegments(segments, offset, clipLen) {
  const out = [];
  let last = 0;
  for (const seg of [...segments].sort((x, y) => x.start - y.start)) {
    const toks = String(seg.text || "").split(/\s+/).filter(Boolean);
    if (!toks.length) continue;
    const start = Math.min(Math.max(Number(seg.start) || 0, last), clipLen);
    const end = Math.min(Math.max(Number(seg.end) || 0, start + 0.25 * toks.length), clipLen);
    if (end <= start) continue;
    const total = toks.reduce((n, t) => n + t.length + 1, 0);
    let t = start;
    for (const tok of toks) {
      const len = (end - start) * (tok.length + 1) / total;
      out.push({ w: tok, s: Math.round((offset + t) * 1000) / 1000, e: Math.round((offset + t + len * 0.9) * 1000) / 1000, p: 0.9 });
      t += len;
    }
    last = end;
  }
  return out;
}

/** True when an AI transcript of a clip stops well before the clip ends, or has under a word a second. */
export function looksIncomplete(segments, words, clipLen) {
  if (clipLen < 10) return false;
  const covered = Math.max(0, ...segments.map(s => Number(s.end) || 0));
  return covered < 0.85 * clipLen || words.length < clipLen;
}

/** Words of text spoken over a known span, timed by their share of the letters (text read aloud). */
export function wordsForSpokenText(text, start, end) {
  const toks = text.split(/\s+/).filter(Boolean);
  const total = toks.reduce((n, t) => n + t.length + 1, 0) || 1;
  const out = [];
  let t = start;
  for (const tok of toks) {
    const len = (end - start) * (tok.length + 1) / total;
    out.push({ w: tok, s: Math.round(t * 1000) / 1000, e: Math.round((t + len * 0.92) * 1000) / 1000, p: 0.9 });
    t += len;
  }
  return out;
}

const qtokens = text => (String(text || "").toLowerCase().match(/[a-z0-9]+/g) || []);

/** When a quote is spoken in the lecture between start and end, or null. A quote is never shown as
    the lecture's unless it is really in it. */
export function locateQuote(words, start, end, quote) {
  const wanted = qtokens(quote);
  if (wanted.length < 3) return null;
  const spoken = words.filter(w => w.e > start && w.s < end);
  const have = spoken.map(w => qtokens(w.w).join(" "));
  const target = wanted.join(" "), size = wanted.length;
  let best = 0, bestAt = null;
  for (let i = 0; i < Math.max(1, have.length - size + 1); i++) {
    const window = have.slice(i, i + size).join(" ");
    if (Math.abs(window.length - target.length) > target.length * 0.3) continue;
    const score = ratio(window, target);
    if (score > best) { best = score; bestAt = spoken[i].s; }
  }
  return best >= 0.8 ? bestAt : null;
}

/** True when the quote is in the text, allowing small differences in punctuation and spacing. */
export function quoteIn(text, quote) {
  const wanted = qtokens(quote), have = qtokens(text);
  if (wanted.length < 3) return false;
  const target = wanted.join(" "), size = wanted.length;
  for (let i = 0; i < Math.max(1, have.length - size + 1); i++) {
    if (ratio(have.slice(i, i + size).join(" "), target) >= 0.85) return true;
  }
  return false;
}
