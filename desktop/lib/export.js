'use strict';
// Audio export on Windows: Windows voices (System.Speech) → WAV → MP3 (lamejs), one file per chapter.
// Browsers don't allow recording the Edge/Google online voices, so exports use the voices installed in Windows.

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');
const { makeSpeaker } = require('./speech');

let lame = null;
function lamejs() {
  if (!lame) {
    // The package's main entry is broken under Node; its prebuilt browser bundle works fine.
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(require.resolve('lamejs/lame.all.js'), 'utf8'), ctx);
    lame = ctx.lamejs;
  }
  return lame;
}

const supported = () => process.platform === 'win32';

function powershell(script, onChild) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], { windowsHide: true });
    if (onChild) onChild(child);
    let out = ''; let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error((err || `PowerShell exited with ${code}`).trim().split('\n')[0]))));
    child.stdin.end(script);
  });
}
const psq = (s) => "'" + String(s).replace(/'/g, "''") + "'";

async function windowsVoices() {
  if (!supported()) return [];
  const out = await powershell(
    'Add-Type -AssemblyName System.Speech; ' +
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
    '$s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name + "|" + $_.VoiceInfo.Culture.Name + "|" + $_.VoiceInfo.Gender }; ' +
    '$s.Dispose()'
  );
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const [name, lang, gender] = l.split('|');
    return { name, lang, gender };
  });
}

// 1× → 0, 2× → about +6, 3× → +10 (System.Speech uses -10…10)
const sapiRate = (r) => Math.max(-10, Math.min(10, Math.round(Math.log(r || 1) / Math.log(3) * 10)));

async function synthWav(text, wavPath, voice, rate, onChild) {
  const txt = wavPath + '.txt';
  fs.writeFileSync(txt, text, 'utf8');
  try {
    await powershell(
      'Add-Type -AssemblyName System.Speech; ' +
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
      (voice ? `$s.SelectVoice(${psq(voice)}); ` : '') +
      `$s.Rate = ${sapiRate(rate)}; ` +
      `$s.SetOutputToWaveFile(${psq(wavPath)}); ` +
      `$s.Speak([IO.File]::ReadAllText(${psq(txt)}, [Text.Encoding]::UTF8)); ` +
      '$s.Dispose()',
      onChild
    );
  } finally {
    try { fs.unlinkSync(txt); } catch (_) {}
  }
}

function readWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('unexpected audio from Windows');
  let pos = 12; let rate = 0; let ch = 1; let bits = 16;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') { ch = buf.readUInt16LE(body + 2); rate = buf.readUInt32LE(body + 4); bits = buf.readUInt16LE(body + 14); }
    else if (id === 'data') {
      if (bits !== 16) throw new Error(`unsupported audio format (${bits}-bit)`);
      const end = Math.min(buf.length, body + size);
      const samples = new Int16Array(buf.buffer.slice(buf.byteOffset + body, buf.byteOffset + end - ((end - body) % 2)));
      return { rate, ch, samples };
    }
    pos = body + size + (size & 1);
  }
  throw new Error('no audio data from Windows');
}

function wavToMp3(wavBuf) {
  const { rate, ch, samples } = readWav(wavBuf);
  const L = lamejs();
  const enc = new L.Mp3Encoder(ch === 2 ? 2 : 1, rate, ch === 2 ? 96 : 64);
  const out = [];
  const block = 1152;
  if (ch === 2) {
    const n = samples.length / 2;
    const left = new Int16Array(n); const right = new Int16Array(n);
    for (let i = 0; i < n; i++) { left[i] = samples[2 * i]; right[i] = samples[2 * i + 1]; }
    for (let i = 0; i < n; i += block) { const b = enc.encodeBuffer(left.subarray(i, i + block), right.subarray(i, i + block)); if (b.length) out.push(Buffer.from(b)); }
  } else {
    for (let i = 0; i < samples.length; i += block) { const b = enc.encodeBuffer(samples.subarray(i, i + block)); if (b.length) out.push(Buffer.from(b)); }
  }
  const f = enc.flush(); if (f.length) out.push(Buffer.from(f));
  return Buffer.concat(out);
}

const safeName = (s) => String(s).replace(/[\\/:*?"<>|\n\t]/g, '_').trim().slice(0, 80) || 'Untitled';

/** Runs an export. `job` is updated in place so the UI can poll it. */
async function runExport(job, { book, doc, settings, from, to, voice, rate, folder }) {
  const speak = makeSpeaker(settings);
  const chapters = doc.chapters.length ? doc.chapters : [{ title: book.title, para: 0 }];
  const a = Math.max(0, Math.min(from, chapters.length - 1));
  const z = Math.max(a, Math.min(to, chapters.length - 1));
  const dir = path.join(folder, safeName(book.title));
  fs.mkdirSync(dir, { recursive: true });
  job.folder = dir; job.total = z - a + 1; job.done = 0;
  const tmp = path.join(os.tmpdir(), `shelf-export-${Date.now()}.wav`);
  for (let ci = a; ci <= z; ci++) {
    if (job.cancelled) throw new Error('cancelled');
    const start = chapters[ci].para;
    const end = ci + 1 < chapters.length ? chapters[ci + 1].para : doc.paras.length;
    const text = doc.paras.slice(start, end).map(speak).filter(Boolean).join('\n\n');
    job.current = chapters[ci].title;
    if (text) {
      await synthWav(text, tmp, voice, rate, (child) => { job.child = child; });
      job.child = null;
      if (job.cancelled) throw new Error('cancelled');
      const mp3 = wavToMp3(fs.readFileSync(tmp));
      const name = `${String(ci + 1).padStart(2, '0')} - ${safeName(chapters[ci].title)}.mp3`;
      fs.writeFileSync(path.join(dir, name), mp3);
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
    job.done++;
  }
}

module.exports = { supported, windowsVoices, runExport, wavToMp3 };
