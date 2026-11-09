// Everything Earmark keeps, on this phone, in the browser's own database (IndexedDB). Tables are
// small, so they're loaded into memory when the app opens and every change is written straight back.
// Recordings and transcripts are big, so they're read only when needed.

const DB_NAME = "earmark", VERSION = 2;  // 2 added references
export const TABLES = ["sources", "chapters", "concepts", "cards", "reviews", "clips", "whatifs", "pairs", "links", "marks", "refs"];
let idb = null;
const mem = {}, top = {};
let writes = Promise.resolve();

const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const tx = (store, mode = "readonly") => idb.transaction(store, mode).objectStore(store);

export async function open() {
  idb = await new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, VERSION);
    r.onupgradeneeded = () => {
      for (const s of [...TABLES, "kv", "files"]) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s);
    };
    // An older version open in another tab or window holds the storage until it's closed.
    r.onblocked = () => {
      const view = document.getElementById("view");
      if (view) view.innerHTML = `<p>Earmark has been updated, but an older copy is still open in another tab or window. Close it, and Earmark opens here.</p>`;
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  // A newer version opening elsewhere needs the storage: this page closes it and reloads as the new version.
  idb.onversionchange = () => { idb.close(); location.reload(); };
  for (const t of TABLES) {
    const [keys, values] = await Promise.all([req(tx(t).getAllKeys()), req(tx(t).getAll())]);
    mem[t] = new Map(keys.map((k, i) => [k, values[i]]));
    top[t] = Math.max(0, ...keys.filter(k => typeof k === "number"));
  }
  // Ask the browser not to clear Earmark's data when the phone runs low on space.
  try { await navigator.storage?.persist?.(); } catch {}
}

// ---------------------------------------------------------------- tables

export const rows = t => [...mem[t].values()];
export const one = (t, id) => mem[t].get(id) ?? null;
export const where = (t, fn) => rows(t).filter(fn);

/** Saves a row. One without an id gets the next number. Returns the row. */
export function put(t, row) {
  if (row.id == null) row.id = ++top[t];
  mem[t].set(row.id, row);
  const copy = structuredClone(row);
  writes = writes.then(() => req(tx(t, "readwrite").put(copy, copy.id))).catch(e => console.error("save failed", t, e));
  return row;
}

export const update = (t, id, fields) => { const row = one(t, id); return row ? put(t, Object.assign(row, fields)) : null; };

export function remove(t, id) {
  mem[t].delete(id);
  writes = writes.then(() => req(tx(t, "readwrite").delete(id))).catch(e => console.error("delete failed", t, e));
}

export const removeWhere = (t, fn) => { for (const r of where(t, fn)) remove(t, r.id); };

/** Waits until every change so far is on disk. */
export const flushed = () => writes;

// ---------------------------------------------------------------- settings, transcripts and recordings

export const kvGet = key => req(tx("kv").get(key));
export const kvSet = (key, value) => req(tx("kv", "readwrite").put(value, key));
export const kvDel = key => req(tx("kv", "readwrite").delete(key));
export const fileGet = sid => req(tx("files").get(sid));
export const filePut = (sid, blob) => req(tx("files", "readwrite").put(blob, sid));
export const fileDel = sid => req(tx("files", "readwrite").delete(sid));
/** Deletes every file whose name starts with prefix, such as the sections of a document read aloud. */
export const fileDelPrefix = prefix => req(tx("files", "readwrite").delete(IDBKeyRange.bound(prefix, prefix + "\uffff")));

const wordCache = new Map();
export async function wordsGet(sid) {
  if (!wordCache.has(sid)) wordCache.set(sid, (await kvGet(`words:${sid}`)) || []);
  return wordCache.get(sid);
}
export async function wordsSet(sid, words) { wordCache.set(sid, words); await kvSet(`words:${sid}`, words); }
export async function wordsDel(sid) { wordCache.delete(sid); await kvDel(`words:${sid}`); }

/** How much space Earmark uses on this phone, and how much the browser allows it. */
export async function usage() {
  try { const e = await navigator.storage.estimate(); return { used: e.usage || 0, quota: e.quota || 0 }; }
  catch { return { used: 0, quota: 0 }; }
}
