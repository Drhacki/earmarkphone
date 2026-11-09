// Turning a PDF, Word file or notes into a lecture, on the phone: the text is taken out of the file,
// cleaned up for listening, and split into sections that Gemini reads aloud. Ported from documents.py.

export const DOC_TYPES = [".pdf", ".docx", ".txt", ".md", ".html", ".htm"];
export const MAX_BYTES = 50 * 1024 * 1024;
export const MAX_CHARS = 120_000;   // about two hours read aloud
const SECTION_CHARS = 1500;         // read aloud in one go: about a minute and a half
// pdf.js, Mozilla's PDF reader, is loaded from a public library only when a PDF is added.
const PDFJS = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/";

// ---------------------------------------------------------------- reading the file

export async function extract(file, name) {
  const kind = (name.toLowerCase().match(/\.[a-z0-9]+$/) || [""])[0];
  if (kind === ".pdf") return pdfText(file);
  if (kind === ".docx") return docxText(file);
  const raw = await file.text();
  return kind === ".html" || kind === ".htm" ? htmlText(raw) : raw;
}

async function pdfText(file) {
  let pdfjs;
  try {
    pdfjs = await import(PDFJS + "pdf.min.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = PDFJS + "pdf.worker.min.mjs";
  } catch { throw new Error("The PDF reader couldn't be loaded. Check your internet connection and try again."); }
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    pages.push(content.items.map(it => it.str + (it.hasEOL ? "\n" : "")).join(""));
  }
  // A line on most pages is a running header or footer, not content.
  const counts = new Map();
  for (const p of pages) for (const ln of new Set(p.split("\n").map(s => s.trim()).filter(Boolean))) counts.set(ln, (counts.get(ln) || 0) + 1);
  const repeated = new Set([...counts].filter(([, n]) => pages.length >= 4 && n >= pages.length * 0.5).map(([ln]) => ln));
  return pages.map(p => p.split("\n").filter(ln => !repeated.has(ln.trim())).join("\n")).join("\n\n");
}

/** The text of a Word file: it's a zip, and the words are in word/document.xml. */
async function docxText(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error("This Word file couldn't be opened.");
  let at = view.getUint32(end + 16, true);
  const count = view.getUint16(end + 10, true);
  for (let n = 0; n < count; n++) {
    const method = view.getUint16(at + 10, true), size = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true), extraLen = view.getUint16(at + 30, true), commentLen = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const entry = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
    if (entry !== "word/document.xml") continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    let data = bytes.subarray(start, start + size);
    if (method === 8) data = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
    const xml = new TextDecoder().decode(data);
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    return [...doc.getElementsByTagName("w:p")].map(p => [...p.getElementsByTagName("w:t")].map(t => t.textContent).join(""))
      .filter(t => t.trim()).join("\n\n");
  }
  throw new Error("This Word file has no text in it.");
}

function htmlText(raw) {
  const doc = new DOMParser().parseFromString(raw, "text/html");
  doc.querySelectorAll("script, style, nav, footer, header").forEach(el => el.remove());
  doc.querySelectorAll("p, div, br, li, h1, h2, h3, h4, h5, h6, tr, section, article").forEach(el => el.append("\n\n"));
  return doc.body ? doc.body.textContent : "";
}

// ---------------------------------------------------------------- making it good to listen to

/** Text as it should be heard: no page numbers, links, citation marks, markdown symbols or
    reference list, and lines wrapped by the page joined back into sentences. */
export function clean(text) {
  text = text.replace(/\r\n?/g, "\n").replace(/­/g, "");
  text = text.replace(/(\w)-\n(\w)/g, "$1$2");                              // words hyphenated across lines
  text = text.replace(/\s*\(?(?:https?:\/\/|www\.)[^\s)]+\)?/g, "");        // links
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");                      // markdown links
  text = text.replace(/\s*\[\d+(?:[,–-]\s*\d+)*\]/g, "");                   // citation marks [3], [4-6]
  text = text.replace(/^\s{0,3}#{1,6}\s*/gm, "");                           // markdown headings
  text = text.replace(/^\s*(?:[-*•▪◦]|\d+[.)])\s+/gm, "");                  // bullets and numbered lists
  text = text.replace(/[*_`]{1,3}([^*_`\n]+)[*_`]{1,3}/g, "$1");             // emphasis
  const lines = text.split("\n").map(s => s.trim())
    .filter(ln => !/^(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?$/i.test(ln));
  const paragraphs = [], current = [];
  const flush = () => { if (current.length) { paragraphs.push(current.join(" ")); current.length = 0; } };
  const ends = s => /[.!?:;]$/.test(s);
  lines.forEach((ln, k) => {
    if (!ln) { flush(); return; }
    const next = lines[k + 1] || "";
    // A short line after a finished sentence, before one starting with a capital, is a heading:
    // it's read on its own, with a pause after it.
    if (ln.length < 70 && !/[.!?:;,]$/.test(ln) && /^[A-Z]/.test(ln) && (!next || /^[A-Z]/.test(next)) && (!current.length || ends(current[current.length - 1]))) {
      flush(); paragraphs.push(ln + "."); return;
    }
    if (current.length && ends(current[current.length - 1]) && /^[A-Z]/.test(ln) && current.join(" ").length > 400) flush();
    current.push(ln);
  });
  flush();
  let out = paragraphs.map(p => p.replace(/\s+/g, " ").trim());
  // A reference list near the end isn't worth hearing.
  const refs = out.findIndex((p, k) => k > out.length * 0.6 && /^(references|bibliography|works cited|further reading)\.?$/i.test(p));
  if (refs >= 0) out = out.slice(0, refs);
  return out.filter(p => /[A-Za-z]{2}/.test(p)).join("\n\n");
}

/** Text cut to the limit at a paragraph end. Returns [text, whether it was cut]. */
export function shorten(text, limit = MAX_CHARS) {
  if (text.length <= limit) return [text, false];
  const cut = text.lastIndexOf("\n\n", limit);
  return [text.slice(0, cut > limit * 0.5 ? cut : limit), true];
}

/** Paragraphs grouped into sections of about `size` characters, long ones split between sentences. */
export function sections(text, size = SECTION_CHARS) {
  const pieces = [];
  for (let p of text.split("\n\n")) {
    while (p.length > size) {
      let cut = Math.max(p.lastIndexOf(". ", size), p.lastIndexOf("? ", size), p.lastIndexOf("! ", size));
      cut = cut > size * 0.4 ? cut + 1 : (p.lastIndexOf(" ", size) > 0 ? p.lastIndexOf(" ", size) : size);
      pieces.push(p.slice(0, cut).trim());
      p = p.slice(cut).trim();
    }
    if (p) pieces.push(p);
  }
  const out = [];
  let current = "";
  for (const piece of pieces) {
    if (current && current.length + piece.length + 2 > size) { out.push(current); current = piece; }
    else current = current ? `${current}\n\n${piece}` : piece;
  }
  if (current) out.push(current);
  return out;
}
