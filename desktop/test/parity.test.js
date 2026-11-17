'use strict';
// Runs the PC/maker spoken-text rules on the same examples as the phone (app/build/parity/kotlin.json, written by
// the phone's unit tests) and fails when they differ, so the two copies of the rules stay the same.
const fs = require('fs');
const path = require('path');
const ST = require('../ui/speechtext.js');
const file = process.argv[2] || path.join(__dirname, '..', '..', 'app', 'build', 'parity', 'kotlin.json');
const K = JSON.parse(fs.readFileSync(file, 'utf8'));
const pcs = (l) => l.map((p) => [p.t, p.gap]);
const diffs = [];
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function check(what, input, phone, pc) { if (!eq(phone, pc)) diffs.push({ what, input, phone, pc }); }
for (const c of K.cases) {
  const cl = ST.clean(c.in);
  const n = ST.normalize(cl);
  check('clean', c.in, c.clean, cl);
  check('hasWords', c.in, c.hasWords, ST.hasWords(cl));
  check('normalize', cl, c.normalize, n);
  // compare the next steps on the phone's normalized text, so one difference isn't reported many times
  check('pieces', c.normalize, c.pieces, pcs(ST.pieces(c.normalize)));
  check('endPause', c.normalize, c.endPause, ST.endPause(c.normalize));
  check('chapterOpening', c.in.slice(0, 80), c.chapterOpening, pcs(ST.chapterOpening(c.in.slice(0, 80))));
  check('isPageNumber', c.in, c.isPageNumber, ST.isPageNumber(c.in));
  check('chunks', c.clean, c.chunks, ST.chunks(c.clean, 60));
  check('titleCase', c.in.slice(0, 80), c.titleCase, ST.titleCase(c.in.slice(0, 80)));
}
const ll = ST.lineLength(K.cases.map((c) => c.in));
check('lineLength', '(all cases)', K.lineLength, ll);
for (const p of K.pairs) {
  check('continues', `${p.a} ⏎ ${p.b}`, p.continues, ST.continues(p.a, p.b, K.lineLength));
  check('joinText', `${p.a} ⏎ ${p.b}`, p.join, ST.joinText(p.a, p.b));
}
for (const x of K.numbers) {
  check('words', x.n, x.words, ST.words(x.n));
  check('ordinal', x.n, x.ordinal, ST.ordinal(x.n));
  check('year', x.n, x.year, ST.year(x.n));
}
for (const r of K.romans) check('roman', r.s, r.value, ST.roman(r.s));

if (diffs.length) {
  console.log(`Phone and PC read ${diffs.length} thing(s) differently:\n`);
  for (const d of diffs.slice(0, 60)) console.log(`• ${d.what}: ${JSON.stringify(d.input)}\n    phone: ${JSON.stringify(d.phone)}\n    PC:    ${JSON.stringify(d.pc)}`);
  process.exit(1);
}
console.log(`phone and PC agree: ${K.cases.length} examples, ${K.pairs.length} line pairs, ${K.numbers.length} numbers, ${K.romans.length} Roman numerals`);
