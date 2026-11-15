'use strict';
/* Finds dialogue in a book and guesses who is speaking.
   analyzeDialogue(book) adds chapter.segs[i] = [{ t, who }] for every paragraph:
     who = null  → narration
     who = '*'   → quoted speech, speaker unknown
     who = 'Name'→ quoted speech by that character
   and returns { characters: [{ name, lines, gender: 'f'|'m'|'', sample }], quotes, attributed }.
   Works in the browser and in Node (for tests). */

(function (root) {
  const SAY = 'said|says|asked|asks|replied|replies|answered|answers|whispered|whispers|shouted|shouts|cried|called|yelled|muttered|murmured|added|continued|began|explained|exclaimed|insisted|snapped|laughed|sighed|told|tells|repeated|demanded|admitted|agreed|warned|interrupted|protested|pleaded|declared|announced|growled|breathed|stammered|groaned|grumbled|hissed|mumbled|offered|suggested|wondered|whimpered|teased|joked|observed|noted|remarked|retorted|responded|returned|went on|called out|cut in|shot back';
  const TITLE = '(?:Mr|Mrs|Ms|Miss|Dr|Sir|Lady|Lord|Aunt|Uncle|Captain|Capt|Professor|Prof|Father|Mother|Sister|Brother|Madame|Monsieur|Doctor|Grandma|Grandpa|Granny|Old|Young|King|Queen|Prince|Princess|Inspector|Sergeant|Colonel|General|Major|Mister|Mistress)\\.?';
  const NAME = `((?:${TITLE}\\s+)?[A-Z][a-zà-ÿ'’-]+(?:\\s+[A-Z][a-zà-ÿ'’-]+)?)`;
  const PRON = '(he|she|I|they|we)';
  const AFTER_NAME = new RegExp(`^[\\s,—–-]*(?:${SAY})\\s+${NAME}`, 'u');
  const AFTER_NAME2 = new RegExp(`^[\\s,—–-]*${NAME}\\s+(?:\\w+ly\\s+)?(?:${SAY})\\b`, 'u');
  const AFTER_PRON = new RegExp(`^[\\s,—–-]*(?:${PRON}\\s+(?:\\w+ly\\s+)?(?:${SAY})|(?:${SAY})\\s+${PRON})\\b`, 'i');
  const BEFORE_NAME = new RegExp(`${NAME}\\s+(?:\\w+ly\\s+)?(?:${SAY})(?:\\s+[a-z]+){0,3}\\s*[,:—–-]?\\s*$`, 'u');
  const BEFORE_PRON = new RegExp(`\\b${PRON}\\s+(?:\\w+ly\\s+)?(?:${SAY})(?:\\s+[a-z]+){0,3}\\s*[,:—–-]?\\s*$`, 'i');
  // "action beats": no speech verb, but the sentence next to the quote is about the speaker ("Mara laughed." / "He smiled.")
  const BEAT_NAME = new RegExp(`^[\\s,—–-]*${NAME}\\s+(?:\\w+ly\\s+)?[a-z]+`, 'u');
  const BEAT_PRON = /^[\s,—–-]*(he|she)\s+(?:\w+ly\s+)?[a-z]+/i;
  const SENT_END = /(?<!\b(?:Mr|Mrs|Ms|Dr|St|Capt|Prof))[.!?]["”’]?\s+/;
  const SUBJECT = new RegExp(`(?:^|(?<!\\b(?:Mr|Mrs|Ms|Dr|St|Capt|Prof))[.!?]\\s+)${NAME}\\s+(?:\\w+ly\\s+)?[a-z]`, 'gu');
  const STOP = new Set(('He She They It I We You The A An But And Then When What Yes No Oh Well So This That There Here His Her My Our Your Their Who Why How Where ' +
    'Not Now Just Still Even Only Perhaps Maybe Of In On At For With As If Or Nor Yet Again Then Once Later Soon Finally Suddenly ' +
    'Everyone Someone Nobody Somebody Anyone Everybody All Both Each Some Many Most Few Mother Father God Sir Madam Miss Mister Lord Lady ' +
    'By After Before Inside Outside Over Under Through Behind Across Without Within Along Around From To Into Upon Since Until While Although Because Though Every ' +
    'Somewhere Nothing Something Everything Today Tonight Tomorrow Yesterday Down Up Out Off Back Last Next First Never Always Sometimes Instead Meanwhile Besides ' +
    'Like Such Its These Those One Two Three Let Do Did Was Is Are Were Had Has Have Could Would Should Will Can May Might Must Please Thank Good Hello Come Go Look Listen Wait Stop Above Below Beyond Near Far Outside Somehow').split(' '));
  const MALE_T = /^(Mr|Sir|Lord|Uncle|Father|Brother|Monsieur|Grandpa|King|Prince|Mister)\b/;
  const FEMALE_T = /^(Mrs|Ms|Miss|Lady|Aunt|Mother|Sister|Madame|Grandma|Granny|Queen|Princess|Mistress)\b/;

  const PAIRS = { '“': '”', '"': '"', '‘': '’', '«': '»', '„': '“', '»': '«', '‹': '›' };

  /** Which quote marks this book uses for speech. */
  function quoteStyle(paras) {
    const c = { '“': 0, '"': 0, '‘': 0, '«': 0, '„': 0 };
    for (const p of paras) {
      for (const m of p.matchAll(/(^|[\s(—–-])([“"‘«„])/g)) c[m[2]]++;
    }
    const opens = Object.keys(c).filter((k) => c[k] > 2).sort((a, b) => c[b] - c[a]);
    // single quotes only count when they're the main style (otherwise they're apostrophes or quotes-within-quotes)
    return opens.filter((k) => k !== '‘' || opens[0] === '‘');
  }

  /** Splits a paragraph into narration and quoted parts. `open` = a quote carried over from the last paragraph. */
  function splitQuotes(p, opens, carry) {
    const parts = [];
    let buf = ''; let inQ = carry ? carry.close : null; let openCh = carry ? carry.open : null;
    const push = (q) => { if (buf.trim()) parts.push({ t: buf, q }); buf = ''; };
    // a new paragraph that starts with the opening mark continues the quote
    let i = 0;
    if (carry && p.startsWith(carry.open)) i = 1;
    for (; i < p.length; i++) {
      const ch = p[i];
      if (!inQ) {
        const prev = p[i - 1] || ' ';
        if (opens.includes(ch) && (/[\s(—–\-:,]/.test(prev) || i === 0)) {
          push(false); inQ = PAIRS[ch]; openCh = ch; continue;
        }
        buf += ch;
      } else {
        const next = p[i + 1] || ' ';
        if (ch === inQ && (inQ !== '’' || !/\p{L}/u.test(next))) { push(true); inQ = null; continue; }
        buf += ch;
      }
    }
    push(!!inQ);
    return { parts, carry: inQ ? { open: openCh, close: inQ } : null };
  }

  function cleanName(n) {
    n = n.replace(/[’']s$/, '').trim();
    const words = n.split(/\s+/);
    if (STOP.has(words[0]) && !new RegExp('^' + TITLE + '$').test(words[0])) {
      if (words.length === 1) return null;
      words.shift(); n = words.join(' ');
      if (STOP.has(words[0])) return null;
    }
    if (/^(Said|Asked|Replied)$/.test(n)) return null;
    return n;
  }

  function attribution(before, after) {
    let m;
    const a = after.slice(0, 90);
    if ((m = AFTER_NAME.exec(a)) && cleanName(m[1])) return { name: cleanName(m[1]) };
    if ((m = AFTER_NAME2.exec(a)) && cleanName(m[1])) return { name: cleanName(m[1]) };
    if ((m = AFTER_PRON.exec(a))) return { pron: (m[1] || m[2]).toLowerCase() };
    const b = before.slice(-90);
    if ((m = BEFORE_NAME.exec(b)) && cleanName(m[1])) return { name: cleanName(m[1]) };
    if ((m = BEFORE_PRON.exec(b))) return { pron: m[1].toLowerCase() };
    // action beats, after then before the quote
    const lastSentence = b.trim().split(SENT_END).pop();
    for (const t of [a, lastSentence]) {
      if ((m = BEAT_NAME.exec(t)) && cleanName(m[1])) return { name: cleanName(m[1]), beat: true };
      if ((m = BEAT_PRON.exec(t))) return { pron: m[1].toLowerCase(), beat: true };
    }
    return null;
  }

  function analyzeDialogue(book) {
    const allParas = book.chapters.flatMap((c) => c.paras);
    const opens = quoteStyle(allParas);
    const lower = new Set(allParas.join('\n').match(/\b[a-z][a-z'’]+\b/g) || []);
    // a name found only from an action ("Rose fell") must not also be an ordinary word in the book
    const plausible = (n) => !!n && (n.includes(' ') || !lower.has(n.toLowerCase()));
    // pass 1: split, and collect named attributions
    const info = [];   // per chapter, per paragraph: { parts, attr }
    const counts = new Map();
    let quotes = 0;
    for (const c of book.chapters) {
      let carry = null;
      const ci = [];
      for (const p of c.paras) {
        const r = opens.length ? splitQuotes(p, opens, carry) : { parts: [{ t: p, q: false }], carry: null };
        carry = r.carry;
        // a quote left open at the end of a paragraph is only carried on if the next paragraph re-opens it
        let attr = null;
        r.parts.forEach((x, k) => {
          if (!x.q) return;
          quotes++;
          if (attr) return;
          const before = k > 0 && !r.parts[k - 1].q ? r.parts[k - 1].t : '';
          const after = k + 1 < r.parts.length && !r.parts[k + 1].q ? r.parts[k + 1].t : '';
          attr = attribution(before, after);
        });
        if (attr && attr.name && attr.beat && !plausible(attr.name)) attr = null;
        if (attr && attr.name) counts.set(attr.name, (counts.get(attr.name) || 0) + 1);
        ci.push({ parts: r.parts, attr });
      }
      info.push(ci);
    }
    // merge "John Smith" into "John" (or "Smith") when both appear
    const canon = new Map();
    for (const n of counts.keys()) {
      const w = n.split(' ');
      let to = n;
      if (w.length === 2 && !new RegExp('^' + TITLE + '$').test(w[0])) {
        if (counts.has(w[0])) to = w[0]; else if (counts.has(w[1])) to = w[1];
      }
      canon.set(n, to);
    }
    const merged = new Map();
    for (const [n, k] of counts) { const c = canon.get(n); merged.set(c, (merged.get(c) || 0) + k); }

    // gender guesses from titles and nearby pronouns
    const text = allParas.join('\n');

    const gender = new Map();
    const guess = (n) => {
      if (gender.has(n)) return gender.get(n);
      if (MALE_T.test(n)) { gender.set(n, 'm'); return 'm'; }
      if (FEMALE_T.test(n)) { gender.set(n, 'f'); return 'f'; }
      const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`\\b${esc}\\b[^“”"«»\\n]{0,70}?\\b(he|him|his|himself|she|her|hers|herself)\\b`, 'gi');
      let m = 0, f = 0;
      for (const x of text.matchAll(re)) { if (/^(he|him|his|himself)$/i.test(x[1])) m++; else f++; }
      const g = m > f * 1.5 && m >= 1 ? 'm' : f > m * 1.5 && f >= 1 ? 'f' : '';
      gender.set(n, g); return g;
    };
    for (const n of merged.keys()) guess(n);

    // pass 2: decide who speaks each paragraph's quotes
    let attributed = 0;
    const lines = new Map(); const samples = new Map();
    book.chapters.forEach((c, ci) => {
      const convo = [];      // recent speakers in this conversation
      let quiet = 0;         // narration-only paragraphs in a row
      let recentNames = [];  // characters mentioned recently (for "she said")
      c.segs = info[ci].map(({ parts, attr }) => {
        const hasQ = parts.some((x) => x.q);
        const narr = parts.filter((x) => !x.q).map((x) => x.t).join(' ');
        const seen = [];
        for (const n of merged.keys()) if (narr.includes(n)) seen.push(n);
        for (const m of narr.matchAll(SUBJECT)) { const n = cleanName(m[1]); if (plausible(n)) seen.push(canon.get(n) || n); }
        for (const n of seen) { guess(n); recentNames = [n, ...recentNames.filter((x) => x !== n)].slice(0, 6); }
        if (!hasQ) {
          if (++quiet >= 2) convo.length = 0;
          return parts.map((x) => ({ t: x.t, who: null }));
        }
        quiet = 0;
        let who = null;
        if (attr && attr.name && (!attr.beat || merged.has(canon.get(attr.name) || attr.name) || plausible(attr.name))) who = canon.get(attr.name) || attr.name;
        else if (attr && attr.pron && /^(he|she)$/.test(attr.pron)) {
          const g = attr.pron === 'he' ? 'm' : 'f';
          who = recentNames.find((n) => guess(n) === g && n !== convo[convo.length - 1]) || recentNames.find((n) => guess(n) === g) || null;
        }
        if (!who && (!attr || attr.beat) && narr.trim().length < 3 || (!who && attr && attr.beat && attr.pron)) {
          // unattributed back-and-forth: the speaker before last, or the other person recently mentioned
          const last = convo[convo.length - 1];
          if (convo.length >= 2) who = convo[convo.length - 2];
          else if (last) who = recentNames.find((n) => n !== last) || null;
          if (who && attr && attr.pron && gender.get(who) && gender.get(who) !== (attr.pron === 'he' ? 'm' : 'f')) {
            who = recentNames.find((n) => gender.get(n) === (attr.pron === 'he' ? 'm' : 'f')) || null;
          }
        }
        if (who) { attributed++; if (convo[convo.length - 1] !== who) convo.push(who); recentNames = [who, ...recentNames.filter((x) => x !== who)].slice(0, 6); }
        const key = who || '*';
        return parts.map((x) => {
          if (!x.q) return { t: x.t, who: null };
          lines.set(key, (lines.get(key) || 0) + 1);
          const s = x.t.trim();
          if (s.length >= 25 && s.length <= 220 && !samples.has(key)) samples.set(key, s);
          return { t: x.t, who: key };
        });
      });
    });
    const characters = [...lines.entries()].filter(([n]) => n !== '*')
      .map(([name, l]) => ({ name, lines: l, gender: guess(name) || '', sample: samples.get(name) || '' }))
      .sort((a, b) => b.lines - a.lines);
    return { characters, quotes, attributed, unknown: lines.get('*') || 0, unknownSample: samples.get('*') || '', style: opens };
  }

  const api = { analyzeDialogue, splitQuotes, quoteStyle };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Dialogue = api;
})(typeof self !== 'undefined' ? self : this);
