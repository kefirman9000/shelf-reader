'use strict';
/* File formats for the audiobook maker, with no dependencies:
   - readZip: list + inflate entries of a .zip/.epub/.docx (uses DecompressionStream)
   - makeZip: a "stored" (uncompressed) zip of finished audio files
   - id3: ID3v2.4 tags for MP3 (title, artist, album, track, cover, chapter markers)
   - muxM4B: an .m4b audiobook (AAC in MP4) with chapters (Nero + QuickTime chapter track), tags and cover
   - wav: 16-bit mono WAV
   Works in the browser and in Node (for tests). */

(function (root) {
  const enc = new TextEncoder();

  // ---------- small byte helpers ----------
  function concat(parts) {
    let n = 0; for (const p of parts) n += p.length;
    const out = new Uint8Array(n); let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  const u8 = (...b) => Uint8Array.from(b);
  const u16 = (v) => u8((v >>> 8) & 255, v & 255);
  const u24 = (v) => u8((v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  const u32 = (v) => u8((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  const u64 = (v) => concat([u32(Math.floor(v / 4294967296)), u32(v >>> 0)]);
  const str = (s) => enc.encode(s);
  const le16 = (v) => u8(v & 255, (v >>> 8) & 255);
  const le32 = (v) => u8(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);

  // ---------- CRC32 ----------
  let CRC;
  function crc32(data) {
    if (!CRC) { CRC = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; } }
    let c = 0xffffffff;
    for (let i = 0; i < data.length; i++) c = CRC[(c ^ data[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // ---------- zip reading ----------
  async function inflateRaw(data) {
    const ds = new DecompressionStream('deflate-raw');
    const out = new Response(new Blob([data]).stream().pipeThrough(ds));
    return new Uint8Array(await out.arrayBuffer());
  }
  /** Returns { names: [...], get(name) → Promise<Uint8Array|null>, text(name) → Promise<string|null> } */
  function readZip(buf) {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let eocd = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error("This doesn't look like a valid EPUB/DOCX (zip) file.");
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const entries = new Map();
    const dec = new TextDecoder();
    for (let k = 0; k < count; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const name = dec.decode(b.subarray(p + 46, p + 46 + nlen));
      entries.set(name, { method, csize, local });
      p += 46 + nlen + xlen + clen;
    }
    const lower = new Map([...entries.keys()].map((n) => [n.toLowerCase(), n]));
    async function get(name) {
      let e = entries.get(name);
      if (!e) { const n = lower.get(String(name).toLowerCase()); if (n) e = entries.get(n); }
      if (!e) { try { const d = decodeURIComponent(name); if (d !== name) return get(d); } catch (_) {} return null; }
      const start = e.local + 30 + dv.getUint16(e.local + 26, true) + dv.getUint16(e.local + 28, true);
      const data = b.subarray(start, start + e.csize);
      if (e.method === 0) return data;
      if (e.method === 8) return inflateRaw(data);
      throw new Error('Unsupported compression in this file.');
    }
    return { names: [...entries.keys()], get, text: async (n) => { const d = await get(n); return d ? new TextDecoder().decode(d) : null; } };
  }

  // ---------- zip writing (stored) ----------
  /** files: [{ name, data: Uint8Array }] → Blob */
  function makeZip(files) {
    const parts = [], central = [];
    let offset = 0;
    for (const f of files) {
      const name = str(f.name); const crc = crc32(f.data); const size = f.data.length;
      const head = concat([le32(0x04034b50), le16(20), le16(0x0800), le16(0), le16(0), le16(0x21), le32(crc), le32(size), le32(size), le16(name.length), le16(0), name]);
      parts.push(head, f.data);
      central.push(concat([le32(0x02014b50), le16(20), le16(20), le16(0x0800), le16(0), le16(0), le16(0x21), le32(crc), le32(size), le32(size),
        le16(name.length), le16(0), le16(0), le16(0), le16(0), le32(0), le32(offset), name]));
      offset += head.length + size;
    }
    const cd = concat(central);
    const end = concat([le32(0x06054b50), le16(0), le16(0), le16(files.length), le16(files.length), le32(cd.length), le32(offset), le16(0)]);
    return new Blob([...parts, cd, end], { type: 'application/zip' });
  }

  // ---------- WAV ----------
  function wav(pcm, rate) {
    const n = pcm.length; const out = new Uint8Array(44 + n * 2); const v = new DataView(out.buffer);
    out.set(str('RIFF'), 0); v.setUint32(4, 36 + n * 2, true); out.set(str('WAVEfmt '), 8); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true); out.set(str('data'), 36); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, pcm[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
    return out;
  }

  // ---------- ID3v2.4 ----------
  const syncsafe = (v) => u8((v >>> 21) & 127, (v >>> 14) & 127, (v >>> 7) & 127, v & 127);
  const frame = (id, body) => concat([str(id), syncsafe(body.length), u8(0, 0), body]);
  const textFrame = (id, s) => frame(id, concat([u8(3), str(String(s))]));
  /** meta: { title, artist, album, track, genre, cover: {mime, data}, chapters: [{title, startMs, endMs}] } */
  function id3(meta) {
    const fr = [];
    if (meta.title) fr.push(textFrame('TIT2', meta.title));
    if (meta.artist) fr.push(textFrame('TPE1', meta.artist));
    if (meta.album) fr.push(textFrame('TALB', meta.album));
    if (meta.track) fr.push(textFrame('TRCK', meta.track));
    fr.push(textFrame('TCON', meta.genre || 'Audiobook'));
    fr.push(textFrame('TSSE', 'Shelf Reader audiobook maker'));
    if (meta.cover && meta.cover.data) fr.push(frame('APIC', concat([u8(3), str(meta.cover.mime || 'image/jpeg'), u8(0, 3), str('Cover'), u8(0), meta.cover.data])));
    const ch = meta.chapters || [];
    if (ch.length > 1) {
      const ids = ch.map((_, i) => 'ch' + i);
      fr.push(frame('CTOC', concat([str('toc'), u8(0, 3, ids.length), ...ids.map((x) => concat([str(x), u8(0)])), textFrame('TIT2', meta.album || meta.title || 'Contents')])));
      ch.forEach((c, i) => fr.push(frame('CHAP', concat([str(ids[i]), u8(0), u32(Math.round(c.startMs)), u32(Math.round(c.endMs)), u32(0xffffffff), u32(0xffffffff), textFrame('TIT2', c.title)]))));
    }
    const body = concat(fr);
    return concat([str('ID3'), u8(4, 0, 0), syncsafe(body.length), body]);
  }

  // ---------- MP4 / M4B ----------
  const fourcc = (t) => Uint8Array.from(t, (c) => c.charCodeAt(0) & 255);
  const box = (type, ...kids) => { const body = concat(kids); return concat([u32(body.length + 8), fourcc(type), body]); };
  const full = (type, version, flags, ...kids) => box(type, u8(version), u24(flags), ...kids);
  const MATRIX = concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]);
  function descr(tag, body) { return concat([u8(tag, 0x80, 0x80, 0x80, body.length & 127), body]); }
  function ascFor(rate, channels) {
    const idx = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000].indexOf(rate);
    return u8((2 << 3) | (idx >> 1), ((idx & 1) << 7) | (channels << 3));
  }
  function ilstItem(name, value, type = 1) {
    return box(name, box('data', u32(type), u32(0), typeof value === 'string' ? str(value) : value));
  }
  /**
   * frames: [Uint8Array] raw AAC frames (1024 samples each); rate: sample rate; asc: AudioSpecificConfig (optional)
   * meta: { title, artist, album, cover: {mime, data}, chapters: [{title, startMs}], bitrate }
   * Returns a Blob (audio/mp4).
   */
  function muxM4B(frames, rate, meta, asc) {
    const n = frames.length;
    const samples = n * 1024;
    const durMs = Math.round(samples * 1000 / rate);
    const chapters = (meta.chapters || []).filter((c) => c.startMs < durMs);
    const chText = chapters.map((c) => { const t = str(c.title.slice(0, 200)); return concat([u16(t.length), t, box('encd', u32(0x100))]); });
    const audioBytes = frames.reduce((a, f) => a + f.length, 0);
    const config = asc || ascFor(rate, 1);
    const bitrate = Math.round(audioBytes * 8 / Math.max(0.001, samples / rate));

    function build(audioOff, textOff) {
      const esds = full('esds', 0, 0, descr(3, concat([u16(1), u8(0),
        descr(4, concat([u8(0x40, 0x15), u24(0), u32(bitrate), u32(bitrate), descr(5, config)])),
        descr(6, u8(2))])));
      const mp4a = box('mp4a', u8(0, 0, 0, 0, 0, 0), u16(1), u32(0), u32(0), u16(1), u16(16), u16(0), u16(0), u32(rate * 65536 >>> 0), esds);
      const sizes = concat(frames.map((f) => u32(f.length)));
      const stblA = box('stbl',
        full('stsd', 0, 0, u32(1), mp4a),
        full('stts', 0, 0, u32(1), u32(n), u32(1024)),
        full('stsc', 0, 0, u32(1), u32(1), u32(n), u32(1)),
        full('stsz', 0, 0, u32(0), u32(n), sizes),
        full('stco', 0, 0, u32(1), u32(audioOff)));
      const trakA = box('trak',
        full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(durMs), u32(0), u32(0), u16(0), u16(0), u16(0x0100), u16(0), MATRIX, u32(0), u32(0)),
        chapters.length ? box('tref', box('chap', u32(2))) : new Uint8Array(0),
        box('mdia',
          full('mdhd', 0, 0, u32(0), u32(0), u32(rate), u32(samples), u16(0x55c4), u16(0)),
          full('hdlr', 0, 0, u32(0), str('soun'), u32(0), u32(0), u32(0), str('SoundHandler'), u8(0)),
          box('minf', full('smhd', 0, 0, u16(0), u16(0)), box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))), stblA)));
      let trakT = new Uint8Array(0);
      if (chapters.length) {
        const durs = chapters.map((c, i) => Math.max(1, Math.round((i + 1 < chapters.length ? chapters[i + 1].startMs : durMs) - c.startMs)));
        const textEntry = box('text', u8(0, 0, 0, 0, 0, 0), u16(1), u32(1), u32(0), u32(0), u32(0), u32(0), u32(0), u8(0, 0, 0, 0, 0, 0, 0, 0), u8(0));
        const stblT = box('stbl',
          full('stsd', 0, 0, u32(1), textEntry),
          full('stts', 0, 0, u32(durs.length), ...durs.map((d) => concat([u32(1), u32(d)]))),
          full('stsc', 0, 0, u32(1), u32(1), u32(chText.length), u32(1)),
          full('stsz', 0, 0, u32(0), u32(chText.length), ...chText.map((t) => u32(t.length))),
          full('stco', 0, 0, u32(1), u32(textOff)));
        const gmhd = box('gmhd', full('gmin', 0, 0, u16(0x40), u16(0x8000), u16(0x8000), u16(0x8000), u16(0), u16(0)),
          box('text', u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)));
        trakT = box('trak',
          full('tkhd', 0, 0, u32(0), u32(0), u32(2), u32(0), u32(durMs), u32(0), u32(0), u16(0), u16(0), u16(0), u16(0), MATRIX, u32(0), u32(0)),
          box('mdia',
            full('mdhd', 0, 0, u32(0), u32(0), u32(1000), u32(durMs), u16(0x55c4), u16(0)),
            full('hdlr', 0, 0, u32(0), str('text'), u32(0), u32(0), u32(0), str('ChapterHandler'), u8(0)),
            box('minf', gmhd, box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))), stblT)));
      }
      const items = [];
      if (meta.title) items.push(ilstItem('©nam', meta.title));
      if (meta.artist) { items.push(ilstItem('©ART', meta.artist)); items.push(ilstItem('aART', meta.artist)); }
      if (meta.album || meta.title) items.push(ilstItem('©alb', meta.album || meta.title));
      items.push(ilstItem('©gen', 'Audiobook'));
      items.push(ilstItem('©too', 'Shelf Reader audiobook maker'));
      items.push(ilstItem('stik', u8(2), 21));
      if (meta.cover && meta.cover.data) items.push(ilstItem('covr', meta.cover.data, /png/.test(meta.cover.mime || '') ? 14 : 13));
      const metaBox = full('meta', 0, 0, full('hdlr', 0, 0, u32(0), str('mdir'), str('appl'), u32(0), u32(0), u8(0)), box('ilst', ...items));
      const chpl = chapters.length
        ? full('chpl', 1, 0, u32(0), u8(chapters.length), ...chapters.map((c) => { const t = str(c.title.slice(0, 120)); return concat([u64(Math.round(c.startMs * 10000)), u8(t.length), t]); }))
        : new Uint8Array(0);
      return box('moov',
        full('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(durMs), u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0), MATRIX, u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(chapters.length ? 3 : 2)),
        trakA, trakT, box('udta', chpl, metaBox));
    }
    const ftyp = box('ftyp', str('M4B '), u32(0x200), str('M4B '), str('M4A '), str('mp42'), str('isom'));
    const moovSize = build(0, 0).length;
    const audioOff = ftyp.length + moovSize + 8;
    const textOff = audioOff + audioBytes;
    const moov = build(audioOff, textOff);
    const textBytes = chText.reduce((a, t) => a + t.length, 0);
    const mdatHead = concat([u32(8 + audioBytes + textBytes), str('mdat')]);
    return new Blob([ftyp, moov, mdatHead, ...frames, ...chText], { type: 'audio/mp4' });
  }

  const api = { readZip, makeZip, wav, id3, muxM4B, crc32, concat };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Formats = api;
})(typeof self !== 'undefined' ? self : this);
