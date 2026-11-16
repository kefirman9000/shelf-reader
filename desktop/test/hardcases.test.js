'use strict';
// Runs the "hard cases" book (tools/torture.txt) through the PC/maker spoken-text rules.
// Every piece must be sayable (has words, no hidden or broken characters, not too long), and nothing may throw or hang.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const ST = require('../ui/speechtext.js');

const book = fs.readFileSync(path.join(__dirname, '..', '..', 'tools', 'torture.txt'), 'utf8') + '\nA lone \uD83D half and \uDC00 another.\n';
const paras = book.split(/\n+/).map((s) => s.trim()).filter(Boolean);
const BAD = /[\u0000-\u001F\u007F-\u009F­​-‏⁠﻿�-]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
let checked = 0;
function piece(where, t) {
  assert(ST.hasWords(t), `${where}: nothing to say in "${t}"`);
  assert(!BAD.test(t), `${where}: hidden or broken character in ${JSON.stringify(t)}`);
  assert(t.length <= 900, `${where}: too long (${t.length})`);
  checked++;
}
const t0 = Date.now();
for (const [i, p] of paras.entries()) {
  const c = ST.clean(p);
  if (!ST.hasWords(c)) continue;
  for (const n of [true, false]) {
    const s = n ? ST.normalize(c) : c;
    for (const pc of ST.pieces(s)) for (const x of ST.chunks(ST.clean(pc.t), 200)) piece(`para ${i}`, x);
    for (const x of ST.chunks(ST.clean(s), 900)) piece(`para ${i} (natural voice)`, x);
    ST.endPause(s); ST.isPageNumber(s); ST.chapterOpening(s.slice(0, 80));
  }
}
const mended = ST.mendParagraphs(paras);
assert(mended.length > 5);
// chunks are bounded and lose no words
const words = Array.from({ length: 3000 }, (_, i) => 'w' + i).join(' ');
const parts = ST.chunks(words, 220);
assert(parts.every((p) => p.length <= 220) && parts.join(' ').split(' ').length === 3000);
assert(ST.chunks('x'.repeat(5000), 220).every((p) => p.length <= 220));
assert(!ST.hasWords(ST.clean('* * * ——— …')));
assert(ST.clean('a​b­c﻿d😀').startsWith('abcd') && ST.clean('😀').includes('😀'));
assert(Date.now() - t0 < 20000, 'too slow (something nearly hung)');
console.log(`hard cases OK: ${paras.length} paragraphs, ${checked} pieces checked in ${Date.now() - t0} ms`);
