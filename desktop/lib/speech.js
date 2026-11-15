'use strict';
// What the voice should actually say (mirrors Speech.kt / app.js). Used for audio export.

const RE_FOOT = /\[(\d{1,3}|[a-zA-Z*†‡])\]|\{\d{1,3}\}|(?<=[.,;:”"])\d{1,3}(?=\s|$)/g;
const RE_URL = /https?:\/\/\S+|www\.\S+/g;
const RE_ILL = /\[(Illustration|Image|Picture|Sidenote)[^\]]*\]/gi;
const RE_PAGE = /^\[?(page|pg\.?|p\.)\s*\d+\]?$/i;
const RE_BOILER = /digitized by (the )?(internet archive|google|microsoft)|produced in epub format by the internet archive|^this (e-?book|book) is for the use of anyone anywhere/i;

function makeSpeaker(settings) {
  const skip = settings.skipClutter !== false;
  const rules = (settings.fixes || []).filter((f) => f.from).map((f) => [
    new RegExp('(?<![\\p{L}\\p{N}])' + f.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\p{L}\\p{N}])', 'giu'), f.to || ''
  ]);
  return function spoken(text) {
    let t = text;
    if (skip) {
      if (RE_BOILER.test(t)) return null;
      if (/^\s*\[Footnote/i.test(t)) return null;
      t = t.replace(RE_FOOT, '').replace(RE_ILL, '').replace(RE_URL, '');
      const tr = t.trim();
      if (RE_PAGE.test(tr)) return null;
      const core = tr.replace(/[\s\p{P}\p{S}]/gu, '');
      if (!core || /^\d+$/.test(core)) return null;
    }
    for (const [re, to] of rules) t = t.replace(re, to);
    t = t.trim();
    return t || null;
  };
}

module.exports = { makeSpeaker };
