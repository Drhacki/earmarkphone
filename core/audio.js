// Audio on the phone: cutting a lecture into pieces Gemini can transcribe, turning a spoken answer
// into WAV, and playing part of a lecture. Lectures can be hours long, so a whole lecture is never
// decoded at once when it can be avoided: MP3 is cut at its frame boundaries and sent as it is, and
// M4A (what phone recorders make) is unpacked and decoded one piece at a time.

const RATE = 16000;  // what pieces are turned into: plenty for speech, and small

// ---------------------------------------------------------------- WAV

export function wavBytes(samples, rate = RATE) {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) pcm[i] = Math.max(-1, Math.min(1, samples[i])) * 32767;
  const out = new DataView(new ArrayBuffer(44 + pcm.byteLength));
  const text = (o, s) => [...s].forEach((c, k) => out.setUint8(o + k, c.charCodeAt(0)));
  text(0, "RIFF"); out.setUint32(4, 36 + pcm.byteLength, true); text(8, "WAVEfmt ");
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, rate, true); out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
  text(36, "data"); out.setUint32(40, pcm.byteLength, true);
  new Int16Array(out.buffer, 44).set(pcm);
  return new Uint8Array(out.buffer);
}

/** Mono, then resampled to 16 kHz by linear interpolation: enough for speech recognition. */
export function toMono16k(channels, rate) {
  const n = channels[0].length, mono = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) mono[i] += ch[i] / channels.length;
  if (rate === RATE) return mono;
  const outLen = Math.floor(n * RATE / rate), out = new Float32Array(outLen), step = rate / RATE;
  for (let i = 0; i < outLen; i++) {
    const x = i * step, k = Math.floor(x), f = x - k;
    out[i] = mono[k] * (1 - f) + (k + 1 < n ? mono[k + 1] : 0) * f;
  }
  return out;
}

/** A spoken answer (any format the browser records) as 16 kHz WAV bytes, which Gemini accepts. */
export async function answerWav(blob) {
  const ctx = new OfflineAudioContext(1, 1, RATE);
  const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  return wavBytes(toMono16k([...Array(buf.numberOfChannels).keys()].map(c => buf.getChannelData(c)), buf.sampleRate));
}

export function base64(bytes) {
  return new Promise(res => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1]);
    r.readAsDataURL(new Blob([bytes]));
  });
}

// ---------------------------------------------------------------- reading a file in blocks

class Reader {
  constructor(file) { this.file = file; this.pos = -1; this.buf = null; }
  async bytes(at, n) {
    if (!this.buf || at < this.pos || at + n > this.pos + this.buf.length) {
      const size = Math.max(n, 1 << 20);
      this.buf = new Uint8Array(await this.file.slice(at, at + size).arrayBuffer());
      this.pos = at;
    }
    return this.buf.subarray(at - this.pos, at - this.pos + n);
  }
}

// ---------------------------------------------------------------- MP3: cut at frame boundaries

const MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
const MP3_KBPS = {
  "3-1": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],       // MPEG-1 Layer III
  "3-2": [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],      // MPEG-1 Layer II
  "2-1": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],            // MPEG-2/2.5 Layer III and II
};

function mp3Frame(h) {
  if (h[0] !== 0xff || (h[1] & 0xe0) !== 0xe0) return null;
  const version = (h[1] >> 3) & 3, layer = (h[1] >> 1) & 3, bitIndex = h[2] >> 4, rateIndex = (h[2] >> 2) & 3, pad = (h[2] >> 1) & 1;
  if (version === 1 || layer === 0 || layer === 3 || bitIndex === 0 || bitIndex === 15 || rateIndex === 3) return null;  // not III or II
  const rate = MP3_RATES[version][rateIndex];
  const table = version === 3 ? MP3_KBPS[`3-${layer}`] : MP3_KBPS["2-1"];
  const kbps = table[bitIndex];
  const samples = layer === 1 && version !== 3 ? 576 : 1152;
  const length = Math.floor((samples / 8) * kbps * 1000 / rate) + pad;
  return length > 4 ? { length, seconds: samples / rate } : null;
}

async function* mp3Pieces(file, clip) {
  const r = new Reader(file);
  let at = 0;
  const id3 = await r.bytes(0, 10);
  if (String.fromCharCode(...id3.subarray(0, 3)) === "ID3") {
    at = 10 + ((id3[6] & 127) << 21 | (id3[7] & 127) << 14 | (id3[8] & 127) << 7 | (id3[9] & 127)) + (id3[5] & 16 ? 10 : 0);
  }
  // A real frame is followed by another one; finding two in a row within 64 KB means this is MP3.
  const sync = async from => {
    for (let o = from; o + 4 <= file.size && o < from + 65536; o++) {
      const f = mp3Frame(await r.bytes(o, 4));
      if (f && (o + f.length + 4 > file.size || mp3Frame(await r.bytes(o + f.length, 4)))) return o;
    }
    return -1;
  };
  at = await sync(at);
  if (at < 0) throw new Error("not mp3");
  let t = 0, pieceStart = 0, pieceByte = at;
  while (at + 4 <= file.size) {
    const frame = mp3Frame(await r.bytes(at, 4));
    if (!frame) {  // lost sync: look for the next frame, a little way on at most
      at = await sync(at + 1);
      if (at < 0) break;
      continue;
    }
    if (t - pieceStart >= clip) {
      yield { start: pieceStart, end: t, mime: "audio/mp3", data: file.slice(pieceByte, at) };
      pieceStart = t; pieceByte = at;
    }
    at += frame.length; t += frame.seconds;
  }
  if (t > pieceStart) yield { start: pieceStart, end: t, mime: "audio/mp3", data: file.slice(pieceByte, file.size) };
}

// ---------------------------------------------------------------- M4A: unpack, decode a piece at a time

const u32 = (b, o) => (b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]) >>> 0;
const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

function* boxes(b, from = 0, to = b.length) {
  for (let o = from; o + 8 <= to;) {
    let size = u32(b, o), head = 8;
    if (size === 1) { size = u32(b, o + 8) * 2 ** 32 + u32(b, o + 12); head = 16; } else if (size === 0) size = to - o;
    if (size < head) return;
    yield { type: fourcc(b, o + 4), start: o + head, end: Math.min(o + size, to) };
    o += size;
  }
}
const child = (b, box, type) => { for (const c of boxes(b, box.start, box.end)) if (c.type === type) return c; return null; };

async function readMoov(file) {
  for (let o = 0; o + 8 <= file.size;) {
    const h = new Uint8Array(await file.slice(o, o + 16).arrayBuffer());
    let size = u32(h, 0);
    if (size === 1) size = u32(h, 8) * 2 ** 32 + u32(h, 12); else if (size === 0) size = file.size - o;
    if (fourcc(h, 4) === "moov") return new Uint8Array(await file.slice(o, o + size).arrayBuffer());
    if (size < 8) break;
    o += size;
  }
  return null;
}

function descriptor(b, o) {  // MPEG-4 descriptor: tag, then a length of up to four 7-bit bytes
  let len = 0, k = o + 1;
  for (let n = 0; n < 4; n++) { const x = b[k++]; len = (len << 7) | (x & 127); if (!(x & 128)) break; }
  return { tag: b[o], start: k, end: k + len };
}

function audioSpecificConfig(b, esds) {
  let o = esds.start + 4;  // after version and flags
  const es = descriptor(b, o);
  if (es.tag !== 3) return null;
  o = es.start + 2;
  const flags = b[o++];
  if (flags & 0x80) o += 2;
  if (flags & 0x40) o += 1 + b[o];
  if (flags & 0x20) o += 2;
  const dc = descriptor(b, o);
  if (dc.tag !== 4) return null;
  const dsi = descriptor(b, dc.start + 13);
  return dsi.tag === 5 ? b.slice(dsi.start, dsi.end) : null;
}

function audioTrack(moov) {
  const root = { start: 8, end: moov.length };
  for (const trak of boxes(moov, root.start, root.end)) {
    if (trak.type !== "trak") continue;
    const mdia = child(moov, trak, "mdia"), hdlr = mdia && child(moov, mdia, "hdlr");
    if (!hdlr || fourcc(moov, hdlr.start + 8) !== "soun") continue;
    const mdhd = child(moov, mdia, "mdhd"), minf = child(moov, mdia, "minf"), stbl = minf && child(moov, minf, "stbl");
    if (!mdhd || !stbl) continue;
    const v = moov[mdhd.start], timescale = u32(moov, mdhd.start + (v === 1 ? 20 : 12));
    const stsd = child(moov, stbl, "stsd"), entry = { start: stsd.start + 8 + 8, end: stsd.end };
    if (fourcc(moov, stsd.start + 12) !== "mp4a") return null;
    const channels = (moov[entry.start + 16] << 8) | moov[entry.start + 17];
    const rate = u32(moov, entry.start + 24) >>> 16;
    // QuickTime sound entries of version 1 and 2 carry extra fields before their child boxes.
    const version = (moov[entry.start + 8] << 8) | moov[entry.start + 9];
    let esds = null;
    for (const c of boxes(moov, entry.start + 28 + (version === 1 ? 16 : version === 2 ? 36 : 0), entry.end)) {
      if (c.type === "esds") esds = c;
      if (c.type === "wave") esds = child(moov, c, "esds");
    }
    const asc = esds && audioSpecificConfig(moov, esds);
    if (!asc) return null;
    // Sample sizes, times and file offsets, from the sample tables.
    const stsz = child(moov, stbl, "stsz"), fixed = u32(moov, stsz.start + 4), count = u32(moov, stsz.start + 8);
    const sizes = new Uint32Array(count);
    for (let i = 0; i < count; i++) sizes[i] = fixed || u32(moov, stsz.start + 12 + 4 * i);
    const stts = child(moov, stbl, "stts"), times = new Float64Array(count + 1);
    let n = 0, clock = 0;
    for (let e = 0, m = u32(moov, stts.start + 4); e < m; e++) {
      const runs = u32(moov, stts.start + 8 + 8 * e), delta = u32(moov, stts.start + 12 + 8 * e);
      for (let k = 0; k < runs && n < count; k++) { times[n++] = clock / timescale; clock += delta; }
    }
    while (n <= count) times[n++] = clock / timescale;
    const co = child(moov, stbl, "stco") || child(moov, stbl, "co64"), wide = co.type === "co64";
    const chunks = u32(moov, co.start + 4), chunkAt = i => wide ? u32(moov, co.start + 8 + 8 * i) * 2 ** 32 + u32(moov, co.start + 12 + 8 * i) : u32(moov, co.start + 8 + 4 * i);
    const stsc = child(moov, stbl, "stsc"), runs = u32(moov, stsc.start + 4);
    const offsets = new Float64Array(count);
    let s = 0;
    for (let r = 0; r < runs; r++) {
      const first = u32(moov, stsc.start + 8 + 12 * r) - 1, per = u32(moov, stsc.start + 12 + 12 * r);
      const last = r + 1 < runs ? u32(moov, stsc.start + 8 + 12 * (r + 1)) - 1 : chunks;
      for (let c = first; c < last && s < count; c++) {
        let at = chunkAt(c);
        for (let k = 0; k < per && s < count; k++) { offsets[s] = at; at += sizes[s]; s++; }
      }
    }
    const aot = asc[0] >> 3;
    return { codec: `mp4a.40.${aot === 31 ? 2 : aot}`, rate, channels, asc, sizes, times, offsets, count };
  }
  return null;
}

async function decodeSamples(track, file, from, to) {
  const lo = track.offsets[from], hi = track.offsets[to - 1] + track.sizes[to - 1];
  const bytes = new Uint8Array(await file.slice(lo, hi).arrayBuffer());
  const planes = [];
  const decoder = new AudioDecoder({
    output: data => {
      const chans = [];
      for (let c = 0; c < data.numberOfChannels; c++) {
        const plane = new Float32Array(data.numberOfFrames);
        data.copyTo(plane, { planeIndex: c, format: "f32-planar" });
        chans.push(plane);
      }
      planes.push({ chans, rate: data.sampleRate });
      data.close();
    },
    error: () => {},
  });
  decoder.configure({ codec: track.codec, sampleRate: track.rate, numberOfChannels: track.channels, description: track.asc });
  for (let i = from; i < to; i++) {
    const o = track.offsets[i] - lo;
    decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: Math.round(track.times[i] * 1e6), data: bytes.subarray(o, o + track.sizes[i]) }));
  }
  await decoder.flush();
  decoder.close();
  if (!planes.length) throw new Error("Nothing could be decoded.");
  const rate = planes[0].rate, nch = planes[0].chans.length, total = planes.reduce((n, p) => n + p.chans[0].length, 0);
  const chans = [...Array(nch)].map(() => new Float32Array(total));
  let k = 0;
  for (const p of planes) { p.chans.forEach((ch, c) => chans[c].set(ch, k)); k += p.chans[0].length; }
  return toMono16k(chans, rate);
}

async function* m4aPieces(file, clip) {
  if (typeof AudioDecoder === "undefined") throw new Error("no decoder");
  const moov = await readMoov(file);
  const track = moov && audioTrack(moov);
  if (!track) throw new Error("not m4a");
  const ok = await AudioDecoder.isConfigSupported({ codec: track.codec, sampleRate: track.rate, numberOfChannels: track.channels, description: track.asc });
  if (!ok.supported) throw new Error("codec not supported");
  let from = 0;
  while (from < track.count) {
    let to = from;
    const start = track.times[from];
    while (to < track.count && track.times[to] - start < clip) to++;
    yield { start, end: track.times[to], mime: "audio/wav", data: new Blob([wavBytes(await decodeSamples(track, file, from, to))]) };
    from = to;
  }
}

// ---------------------------------------------------------------- anything else: decode it all

async function* decodedPieces(file, clip) {
  const ctx = new OfflineAudioContext(1, 1, RATE);
  const buf = await ctx.decodeAudioData(await file.arrayBuffer());
  const mono = toMono16k([...Array(buf.numberOfChannels).keys()].map(c => buf.getChannelData(c)), buf.sampleRate);
  const step = clip * RATE;
  for (let i = 0; i < mono.length; i += step) {
    yield { start: i / RATE, end: Math.min(mono.length, i + step) / RATE, mime: "audio/wav", data: new Blob([wavBytes(mono.subarray(i, i + step))]) };
  }
}

/** The lecture in pieces of about `clip` seconds: {start, end, mime, data}. */
export async function* pieces(file, clip = 180) {
  const name = (file.name || "").toLowerCase(), type = file.type || "";
  const tries = [];
  if (/\.mp3$/.test(name) || /mpeg|mp3/.test(type)) tries.push(mp3Pieces);
  if (/\.(m4a|mp4|aac|m4b)$/.test(name) || /mp4|m4a|aac/.test(type)) tries.push(m4aPieces);
  tries.push(mp3Pieces, m4aPieces, decodedPieces);
  for (const make of [...new Set(tries)]) {
    const gen = make(file, clip);
    let first;
    try { first = await gen.next(); } catch { continue; }  // not this format: try the next way
    if (first.done) continue;
    yield first.value;
    yield* gen;
    return;
  }
  throw new Error("This audio file couldn't be read. Try an MP3 or M4A file.");
}

/** How long a recording is, read by the browser. */
export function duration(blob) {
  return new Promise((res, rej) => {
    const a = new Audio(), url = URL.createObjectURL(blob);
    a.preload = "metadata";
    a.onloadedmetadata = () => {
      if (Number.isFinite(a.duration)) { URL.revokeObjectURL(url); res(a.duration); return; }
      a.currentTime = 1e9;  // some files only know their length once the end is reached
      a.ontimeupdate = () => { a.ontimeupdate = null; URL.revokeObjectURL(url); res(a.duration); };
    };
    a.onerror = () => { URL.revokeObjectURL(url); rej(new Error("This audio file couldn't be read.")); };
    a.src = url;
  });
}

// ---------------------------------------------------------------- text read aloud by Gemini

/** The 44-byte header of a 16 kHz mono 16-bit WAV file holding `size` bytes of samples. */
export function wavHeader(size, rate = RATE) {
  const out = new DataView(new ArrayBuffer(44));
  const text = (o, s) => [...s].forEach((c, k) => out.setUint8(o + k, c.charCodeAt(0)));
  text(0, "RIFF"); out.setUint32(4, 36 + size, true); text(8, "WAVEfmt ");
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, rate, true); out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
  text(36, "data"); out.setUint32(40, size, true);
  return new Uint8Array(out.buffer);
}

/** 16-bit PCM in a WAV file: {channels, rate}, or null for anything else. */
function readWav(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = o => String.fromCharCode(...bytes.subarray(o, o + 4));
  if (bytes.length < 44 || tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let at = 12, fmt = null;
  while (at + 8 <= bytes.length) {
    const id = tag(at), size = v.getUint32(at + 4, true), body = at + 8;
    if (id === "fmt ") fmt = { format: v.getUint16(body, true), channels: v.getUint16(body + 2, true),
                               rate: v.getUint32(body + 4, true), bits: v.getUint16(body + 14, true) };
    if (id === "data" && fmt) {
      if (fmt.format !== 1 || fmt.bits !== 16 || !fmt.channels) return null;
      const frames = Math.floor(Math.min(size, bytes.length - body) / 2 / fmt.channels);
      const channels = [...Array(fmt.channels)].map(() => new Float32Array(frames));
      for (let i = 0; i < frames; i++) for (let c = 0; c < fmt.channels; c++)
        channels[c][i] = v.getInt16(body + (i * fmt.channels + c) * 2, true) / 32768;
      return { channels, rate: fmt.rate };
    }
    at = body + size + (size & 1);
  }
  return null;
}

/** Speech from a Gemini voice (WAV, or raw 16-bit PCM sent as audio/L16) as 16 kHz mono 16-bit
    samples, with the silence at either end trimmed to a tenth of a second. */
export async function speechPcm(bytes, mime = "") {
  let samples;
  if (/l16|pcm/i.test(mime) && !/wav/i.test(mime)) {
    const rate = Number((mime.match(/rate=(\d+)/i) || [])[1]) || 24000;
    const n = Math.floor(bytes.byteLength / 2), v = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) raw[i] = v.getInt16(i * 2, true) / 32768;
    samples = toMono16k([raw], rate);
  } else {
    const wav = readWav(bytes);
    if (wav) samples = toMono16k(wav.channels, wav.rate);
    else {
      const buf = await new OfflineAudioContext(1, 1, RATE).decodeAudioData(bytes.slice().buffer);
      samples = toMono16k([...Array(buf.numberOfChannels).keys()].map(c => buf.getChannelData(c)), buf.sampleRate);
    }
  }
  const loud = 0.02, pad = Math.round(RATE * 0.1);
  let a = 0, b = samples.length - 1;
  while (a < b && Math.abs(samples[a]) < loud) a++;
  while (b > a && Math.abs(samples[b]) < loud) b--;
  samples = samples.subarray(Math.max(0, a - pad), Math.min(samples.length, b + pad + 1));
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) pcm[i] = Math.max(-1, Math.min(1, samples[i])) * 32767;
  return pcm;
}

export const PCM_RATE = RATE;
