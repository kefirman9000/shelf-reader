'use strict';
// Background sounds (PC): when they play and when they stop. Pressing pause must always stop them.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sent = [];
const ctx = {
  console, setTimeout, clearTimeout, Date, Math, Object, Array, JSON, Promise, Infinity,
  S: { settings: { ambience: { on: true, volume: 0.6, mix: { rain: 0.5 }, keepAfter: 0, saved: [] } } },
  toast() {}, saveSettings: () => Promise.resolve(), esc: (x) => String(x), openDrawer() {}, $: () => null, updatePlayer() {},
  document: { addEventListener() {}, getElementById: () => null, hidden: false },
};
ctx.window = ctx;
ctx.AudioContext = class { constructor() { this.state = 'running'; this.sampleRate = 48000; this.destination = {}; this.audioWorklet = { addModule: () => Promise.resolve() }; } resume() { return Promise.resolve(); } suspend() { return Promise.resolve(); } };
ctx.AudioWorkletNode = class { constructor() { this.port = { postMessage: (m) => sent.push(m) }; } connect() {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../ui/ambience-synth.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../ui/ambience.js'), 'utf8') + '\nglobalThis.Ambience = Ambience;', ctx);
const A = ctx.Ambience;

A.reading(true);
assert(A.audible(), 'plays while reading');
A.hush();
assert(!A.audible(), 'pause stops the sounds');

A.reading(true); A.bookStopped();
assert(!A.audible(), 'stops with the book by default');

ctx.S.settings.ambience.keepAfter = 15;
A.reading(true); A.bookStopped();
assert(A.audible() && A.withoutBook(), 'keeps playing after the book when chosen');
A.hush();
assert(!A.audible(), 'pause stops sounds that kept playing after the book');

ctx.S.settings.ambience.keepAfter = -1;
A.reading(true); A.bookStopped();
assert(A.audible(), 'keeps playing until paused');
A.hush(); assert(!A.audible());

A.togglePlay();
assert(A.audible() && A.withoutBook(), 'Play sounds plays them without a book');
A.togglePlay();
assert(!A.audible(), 'Pause sounds stops them');
A.togglePlay(); A.hush();
assert(!A.audible(), 'the player\'s pause stops sounds playing on their own');

A.reading(true); A.togglePlay();
assert(!A.audible(), 'Pause sounds while reading silences them');
A.reading(true);
assert(A.audible(), 'playing the book again brings them back');
A.hush();

ctx.S.settings.ambience.mix = {};
A.togglePlay();
assert(!A.audible(), 'nothing plays without sounds in the mix');
console.log('background sounds play/pause ok');
