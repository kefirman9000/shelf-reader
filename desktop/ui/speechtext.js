'use strict';
/* Spoken text: turns book text into what a narrator would actually say, and decides where to pause.
   Shared by the PC reader and the audiobook maker (the Android app has the same rules in SpeechText.kt).
   - normalize(): Roman numerals in context, ordinals, years and decades, money, times, percentages, abbreviations
   - pieces(): splits a sentence at ; : — … ( ) so each part gets its own short pause, plus the pause after the sentence
   - chapterOpening(): "CHAPTER XII. THE STORM" → [“Chapter Twelve.” pause, “The Storm.” longer pause]
   - headerLines(): running headers / page furniture repeated through a book, to skip
   - improveChapters(): finds chapters (and parts) when a book has none or a useless list
   - vary(): a little natural variation for pause lengths */

(function (root) {
  const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  const ORD_IRR = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' };

  function words(n) {
    n = Math.floor(n);
    if (n < 0) return 'minus ' + words(-n);
    if (n < 20) return ONES[n];
    if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : '');
    if (n < 1000) return ONES[Math.floor(n / 100)] + ' hundred' + (n % 100 ? ' ' + words(n % 100) : '');
    for (const [v, name] of [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']]) {
      if (n >= v) return words(Math.floor(n / v)) + ' ' + name + (n % v ? ' ' + words(n % v) : '');
    }
    return String(n);
  }
  function ordinal(n) {
    const w = words(n);
    const m = /([a-z]+)$/.exec(w); const last = m[1];
    const o = ORD_IRR[last] || (last.endsWith('y') ? last.slice(0, -1) + 'ieth' : last + 'th');
    return w.slice(0, w.length - last.length) + o;
  }
  function year(y) {
    if (y >= 2000 && y < 2010) return words(y);
    if (y % 100 === 0) return words(y / 100) + ' hundred';
    const hi = Math.floor(y / 100), lo = y % 100;
    return words(hi) + ' ' + (lo < 10 ? 'oh ' + words(lo) : words(lo));
  }
  const plural = (w) => (w.endsWith('y') ? w.slice(0, -1) + 'ies' : w + 's');

  // ---------- Roman numerals ----------
  const ROMAN_OK = /^(?=[MDCLXVI])M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/;
  function roman(s) {
    s = s.toUpperCase().replace(/\.$/, '');
    if (!ROMAN_OK.test(s)) return 0;
    const v = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
    let n = 0;
    for (let i = 0; i < s.length; i++) { const a = v[s[i]], b = v[s[i + 1]] || 0; n += a < b ? -a : a; }
    return n;
  }
  const KEYWORDS = 'chapter|chap\\.?|book|part|volume|vol\\.?|act|scene|section|sect\\.?|canto|letter|appendix|psalm|article|stave|plate|figure|fig\\.?|lesson|lecture|hymn|sonnet|ode|epistle|essay|tome|fytte|movement';
  const KW_ROMAN = new RegExp(`\\b(${KEYWORDS})(\\s+)([MDCLXVI]+|[mdclxvi]+)\\b(?![''’]\\w)`, 'gi');
  const REGNAL = 'Henry|Edward|George|William|Charles|James|Elizabeth|Mary|Louis|Richard|John|Peter|Catherine|Alexander|Frederick|Napoleon|Philip|Pius|Leo|Gregory|Innocent|Clement|Benedict|Boniface|Urban|Paul|Ferdinand|Ludwig|Gustav|Gustavus|Christian|Wilhelm|Francis|Francois|François|Nicholas|Ivan|Ramesses|Ramses|Thutmose|Amenhotep|Ptolemy|Antiochus|Darius|Cyrus|Xerxes|Artaxerxes|Constantine|Justinian|Otto|Rudolf|Conrad|Victor|Emmanuel|Umberto|Carlos|Juan|Alfonso|Sancho|Pedro|Manuel|Afonso|Joseph|Leopold|Albert|Baldwin|Robert|David|Malcolm|Alexios|Basil|Michael|Andronikos|Selim|Mehmed|Murad|Suleiman|Henri|Jean|Dagobert|Lothair|Pepin|Harold|Canute|Olaf|Magnus|Haakon|Eric|Erik|Sigismund|Casimir|Stanislaus|Sobieski|Vasily|Fyodor|Anne|Victoria|Matilda|Isabella|Isabel|Margaret|Jane|Maximilian|Charlemagne';
  const REGNAL_I = new RegExp(`\\b(${REGNAL})\\s+(I)\\b(?![''’])`, 'g');
  const REGNAL_ANY = /\b([A-Z][a-zà-ÿ]+)\s+([IVX]{2,6}|V|X)\b(?![''’])/g;
  const NOT_REGNAL = new Set('The A An And But Or If So Then When While Chapter Part Book Act Scene Volume Section Canto Letter Appendix Psalm Article Stave Plate Figure Lesson Lecture Hymn Sonnet Ode Epistle Essay Movement World War Type Class Grade Level Phase Stage Mark Model Super Bowl Apollo Vatican Henry'.split(' '));

  function romanInText(t) {
    t = t.replace(/\bWorld War (I{1,2})\b/g, (m, r) => 'World War ' + (r === 'I' ? 'One' : 'Two'));
    t = t.replace(KW_ROMAN, (m, kw, sp, r) => {
      const n = roman(r); if (!n || (r.length === 1 && /^[a-z]$/.test(r) && !/^[ivx]$/.test(r))) return m;
      const w = words(n);
      return kw + sp + (/^[A-Z]/.test(kw) ? w.replace(/(^|-)(\w)/g, (x, a, b) => a + b.toUpperCase()) : w);
    });
    t = t.replace(REGNAL_I, (m, name) => name + ' the First');
    t = t.replace(REGNAL_ANY, (m, name, r) => {
      if (NOT_REGNAL.has(name) && !new RegExp(`^(${REGNAL})$`).test(name)) {
        if (/^(World War)$/.test(name)) return m;
        if (/^(War)$/.test(name)) return name + ' ' + words(roman(r));
        return m;
      }
      const n = roman(r); if (!n || n > 39) return m;
      return name + ' the ' + ordinal(n).replace(/^./, (c) => c.toUpperCase());
    });
    return t;
  }

  // ---------- numbers, money, time, abbreviations ----------
  const CUR = { '$': ['dollar', 'cent'], '£': ['pound', 'penny'], '€': ['euro', 'cent'], '¥': ['yen', ''] };
  const ABBR = [
    [/\bMr\.(?=\s)/g, 'Mister'], [/\bMrs\.(?=\s)/g, 'Missus'], [/\bMs\.(?=\s)/g, 'Miz'],
    [/\bDr\.(?=\s+[A-Z])/g, 'Doctor'], [/\bDr\.(?=[\s,;]|$)/g, 'Drive'],
    [/\bSt\.(?=\s+[A-Z])/g, 'Saint'], [/\bSt\.(?=[,;]|\s+[a-z]|$)/g, 'Street'],
    [/\bMt\.(?=\s+[A-Z])/g, 'Mount'], [/\bFt\.(?=\s+[A-Z])/g, 'Fort'], [/\bCapt\.(?=\s)/g, 'Captain'], [/\bGen\.(?=\s+[A-Z])/g, 'General'],
    [/\bCol\.(?=\s+[A-Z])/g, 'Colonel'], [/\bLt\.(?=\s+[A-Z])/g, 'Lieutenant'], [/\bSgt\.(?=\s+[A-Z])/g, 'Sergeant'], [/\bProf\.(?=\s+[A-Z])/g, 'Professor'],
    [/\bRev\.(?=\s+[A-Z])/g, 'Reverend'], [/\bGov\.(?=\s+[A-Z])/g, 'Governor'], [/\bSen\.(?=\s+[A-Z])/g, 'Senator'], [/\bRep\.(?=\s+[A-Z])/g, 'Representative'],
    [/,?\s+Jr\.(?=[\s,;]|$)/g, ' Junior'], [/,?\s+Sr\.(?=[\s,;]|$)/g, ' Senior'],
    [/\be\.g\.,?/gi, 'for example,'], [/\bi\.e\.,?/gi, 'that is,'], [/\betc\.(?=\s+[a-z])/g, 'et cetera,'], [/\betc\./g, 'et cetera.'],
    [/\bvs?\.(?=\s)/g, 'versus'], [/\bNo\.(?=\s*\d)/g, 'number'], [/\bnos\.(?=\s*\d)/gi, 'numbers'], [/\bapprox\.(?=\s)/gi, 'approximately'],
    [/\bpp\.(?=\s*\d)/g, 'pages'], [/\bp\.(?=\s*\d)/g, 'page'], [/\bch\.(?=\s*\d)/gi, 'chapter'], [/\bft\.(?=\s)/g, 'feet'], [/\bin\.(?=\s+(?:long|wide|tall|high|deep))/g, 'inches'],
    [/\bA\.M\.|\ba\.m\.(?=\s|$|[,;])/g, 'A M'], [/\bP\.M\.|\bp\.m\.(?=\s|$|[,;])/g, 'P M'],
    [/\s&\s/g, ' and '], [/\s\+\s/g, ' plus '], [/(\d)\s?°\s?F\b/g, '$1 degrees Fahrenheit'], [/(\d)\s?°\s?C\b/g, '$1 degrees Celsius'], [/(\d)\s?°/g, '$1 degrees']
  ];

  function numbers(t) {
    // money: $4.50, £3, €1.2 million
    t = t.replace(/([$£€¥])\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(\s+(?:million|billion|thousand))?\b/g, (m, c, whole, frac, big) => {
      const [unit, sub] = CUR[c]; const n = +whole.replace(/,/g, '');
      if (big) return `${words(n)}${frac ? ' point ' + frac.split('').map((d) => ONES[+d]).join(' ') : ''}${big} ${plural(unit)}`;
      let s = `${words(n)} ${n === 1 ? unit : plural(unit === 'penny' ? 'penny' : unit)}`;
      if (frac && +frac && sub) { const f = +(frac.length === 1 ? frac + '0' : frac); s += ` and ${words(f)} ${f === 1 ? sub : sub === 'penny' ? 'pence' : plural(sub)}`; }
      return s;
    });
    // times: 3:30 pm, 10:05, 7:00
    t = t.replace(/\b([01]?\d|2[0-3]):([0-5]\d)(?:\s?([ap])\.?\s?m\.?\b)?/gi, (m, h, mm, ap) => {
      const H = +h, Mi = +mm;
      const s = Mi === 0 ? (ap ? words(H) : words(H) + " o'clock") : `${words(H)} ${Mi < 10 ? 'oh ' + words(Mi) : words(Mi)}`;
      return ap ? `${s} ${ap.toUpperCase()} M` : s;
    });
    // decades and years
    t = t.replace(/\b(1[1-9]|20)(\d)0['’]?s\b/g, (m, a, b) => { const y = +(a + b + '0'); return y % 100 === 0 ? words(y / 100) + ' hundreds' : year(y).replace(/ty$/, 'ties').replace(/(\w+)$/, (w) => (w.endsWith('ties') ? w : plural(w))); });
    t = t.replace(/\b['’](\d)0s\b/g, (m, d) => plural(TENS[+d]).replace(/ys$/, 'ies'));
    t = t.replace(/\b(in|of|since|by|from|until|till|to|year|around|circa|c\.|before|after|during|summer|winter|spring|autumn|fall|January|February|March|April|May|June|July|August|September|October|November|December|\d{1,2},?)\s+(1[0-9]\d\d|20\d\d)\b(?![,.]\d)/g,
      (m, pre, y) => `${pre} ${year(+y)}`);
    t = t.replace(/\b(1[1-9]\d\d|20\d\d)\s?(A\.?D\.?|B\.?C\.?E?\.?|C\.?E\.?)\b/g, (m, y, era) => `${year(+y)} ${era.replace(/\./g, '').split('').join(' ')}`);
    // ordinals: 1st, 22nd, 103rd
    t = t.replace(/\b(\d{1,4})(st|nd|rd|th)\b/gi, (m, n) => ordinal(+n));
    // centuries: 19th already handled by ordinals; percentages
    t = t.replace(/(\d)\s?%/g, '$1 percent');
    return t;
  }

  /** Text as a narrator would say it. fixes = [[RegExp, replacement]] from the pronunciation list. */
  function normalize(text, fixes) {
    let t = String(text);
    if (fixes) for (const [re, to] of fixes) t = t.replace(re, to);
    t = romanInText(t);
    t = numbers(t);
    for (const [re, to] of ABBR) t = t.replace(re, to);
    t = t.replace(/\s{2,}/g, ' ');
    return t.trim();
  }

  // ---------- pauses ----------
  /** Pause after a sentence, by how it ends (milliseconds at normal speed). */
  function endPause(s) {
    const t = s.trim().replace(/["”’»)\]]+$/, '');
    if (/(…|\.\.\.)$/.test(t)) return 650;
    if (/[—–-]$/.test(t)) return 90;
    if (/\?$/.test(t)) return 430;
    if (/!$/.test(t)) return 400;
    if (/[:;]$/.test(t)) return 330;
    if (/\.$/.test(t)) return 320;
    return 260;
  }
  /** Splits a sentence at clause marks so voices that rush through them get a real pause. */
  function pieces(s, opts = {}) {
    const min = opts.min || 18;
    const out = [];
    const re = /([;:]\s+|\s[—–]\s|(?<=\w)[—–](?=\w)|…\s+|\.\.\.\s+|\s\(|\)\s)/g;
    let last = 0, m;
    const gapFor = (mark) => {
      if (/[;]/.test(mark)) return 260;
      if (/:/.test(mark)) return 240;
      if (/[—–]/.test(mark)) return 170;
      if (/…|\.\.\./.test(mark)) return 380;
      if (/[()]/.test(mark)) return 140;
      return 120;
    };
    while ((m = re.exec(s))) {
      const end = m.index + (/^\s?\(/.test(m[0]) ? 0 : m[0].trimEnd().length);
      const part = s.slice(last, end).trim();
      const rest = s.slice(m.index + m[0].length).trim();
      if (part.length >= min && rest.length >= min) {
        out.push({ t: part.replace(/^\)\s*/, ''), gap: gapFor(m[0]) });
        last = /^\s?\(/.test(m[0]) ? m.index + 1 : m.index + m[0].length;
        if (/^\s?\(/.test(m[0])) last = m.index + m[0].indexOf('(');
      }
    }
    const tail = s.slice(last).trim();
    if (tail) out.push({ t: tail, gap: endPause(tail) });
    else if (out.length) out[out.length - 1].gap = endPause(s);
    return out.length ? out : [{ t: s.trim(), gap: endPause(s) }];
  }
  /** A little variation (±8%) so pauses don't feel machine-even. */
  const vary = (ms, amount = 0.08) => Math.max(0, Math.round(ms * (1 + (Math.random() * 2 - 1) * amount)));

  // ---------- chapter headings ----------
  const SPELLED = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|last';
  const HEAD_RE = new RegExp(`^\\s*(${KEYWORDS}|prologue|epilogue|introduction|preface|foreword|afterword|interlude|conclusion|postscript|envoi|coda)\\b\\.?\\s*([MDCLXVI]+\\b|\\d{1,3}\\b|(?:the\\s+)?(?:${SPELLED})(?:[-\\s](?:${SPELLED}))*\\b)?\\.?\\s*[:.—–-]?\\s*(.*)$`, 'i');
  const NOT_ROMAN_WORD = new Set(['mix', 'mi', 'di', 'li', 'ci', 'mc', 'md', 'cd', 'dc', 'cv', 'dim', 'mid', 'vi']);
  const titleCase = (s) => (s === s.toUpperCase() && /[A-Z]{2}/.test(s)
    ? s.toLowerCase().replace(/(^|[\s"“(—–-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase())
      .replace(/\b(A|An|The|Of|And|In|On|At|To|For|By|With)\b(?!$)/g, (w, x, i) => (i === 0 ? w : w.toLowerCase()))
      .replace(/\b([IVXLCDM][ivxlcdm]*)\b/g, (w) => (roman(w) && (w.length > 1 || w === 'I') && !NOT_ROMAN_WORD.has(w.toLowerCase()) ? w.toUpperCase() : w))
    : s);
  /** "CHAPTER XII. THE STORM" → [{t:'Chapter Twelve.', gap:650}, {t:'The Storm.', gap:1000}] */
  function chapterOpening(title) {
    const raw = String(title || '').trim(); if (!raw) return [];
    const m = HEAD_RE.exec(raw);
    const fin = (s) => (/[.!?…]$/.test(s) ? s : s + '.');
    if (m) {
      const kw = m[1].replace(/\.$/, '');
      const kwName = { chap: 'Chapter', vol: 'Volume', sect: 'Section', fig: 'Figure' }[kw.toLowerCase()] || kw[0].toUpperCase() + kw.slice(1).toLowerCase();
      let num = m[2] || '';
      if (num) { const r = roman(num); num = /^\d+$/.test(num) ? words(+num) : r ? words(r) : num.toLowerCase(); }
      const cap = (x) => x.replace(/(^|[\s-])(?!the\b)(\w)/g, (q, a, b) => a + b.toUpperCase());
      const head = (kwName + (num ? ' ' + cap(num) : '')).trim();
      const rest = titleCase((m[3] || '').trim()).replace(/^[.:—–-]\s*/, '');
      return rest ? [{ t: fin(head), gap: 650 }, { t: fin(rest), gap: 1000 }] : [{ t: fin(head), gap: 1000 }];
    }
    const r = roman(raw.replace(/\.$/, ''));
    if (r && /^[MDCLXVI]+\.?$/.test(raw)) return [{ t: fin(words(r).replace(/^./, (c) => c.toUpperCase())), gap: 1000 }];
    if (/^\d{1,3}\.?$/.test(raw)) return [{ t: fin(words(+raw.replace('.', '')).replace(/^./, (c) => c.toUpperCase())), gap: 1000 }];
    return [{ t: fin(titleCase(raw)), gap: 1000 }];
  }
  /** Is this paragraph just the chapter heading again (so it isn't read twice)? */
  function isHeadingOf(para, title) {
    const n = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const a = n(para), b = n(title);
    return !!a && (a === b || (a.length < 90 && b.startsWith(a)) || (b.length < 90 && a.startsWith(b) && a.length - b.length < 4));
  }

  const SpeechText_isHeadingOf = (p, t) => isHeadingOf(p, t);
  // ---------- page furniture ----------
  /** Short lines repeated through a book (running headers like the title or author), to skip. */
  function headerLines(paras, title, author) {
    const n = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const counts = new Map();
    for (const p of paras) { if (p.length > 70) continue; const k = n(p); if (k) counts.set(k, (counts.get(k) || 0) + 1); }
    const out = new Set();
    const tk = n(title || ''), ak = n(author || '');
    for (const [k, c] of counts) {
      if (c < 3) continue;
      if (k === tk || k === ak || (tk && k.includes(tk)) || (ak && k.includes(ak)) || /^\d+ /.test(k) || / \d+$/.test(k)) out.add(k);
    }
    return { has: (p) => p.length <= 70 && out.has(n(p)) };
  }
  const isPageNumber = (p) => /^\s*(?:\[?(?:page|pg\.?|p\.)\s*)?[-–—]?\s*(\d{1,4}|[ivxlcdm]{1,7})\s*[-–—]?\]?\s*$/i.test(p);

  // ---------- chapters ----------
  const PART_RE = /^\s*(part|book|volume|vol\.?)\b/i;
  const GENERIC = /^(page|pg|section|chapter|part|text|split|file|item|untitled)?[\s_-]*\d+(\.x?html?)?$|^(part|split|chapter|text|ch|pg|page)\d+[_.-]?\w*$|^\d+$/i;
  /**
   * Returns a better chapter list [{para, title, level}] (level 0 = part/book, 1 = chapter under a part).
   * Keeps a good existing list; rebuilds it from headings in the text when there is none, too few, or a useless one.
   */
  function improveChapters(paras, chapters) {
    const ch = (chapters || []).filter((c) => c.para >= 0 && c.para < paras.length);
    const generic = ch.filter((c) => GENERIC.test(String(c.title).trim())).length;
    const tooMany = ch.length > 30 && ch.length > paras.length / 3;
    let list = ch.map((c) => ({ para: c.para, title: String(c.title).trim() }));
    if (!ch.length || generic > ch.length * 0.6 || tooMany || (ch.length <= 2 && paras.length > 400)) {
      const found = [];
      paras.forEach((p, i) => {
        const t = p.trim();
        if (t.length > 80 || !t) return;
        const next = paras[i + 1] || '';
        const isHead = (HEAD_RE.test(t) && (/\d|[MDCLXVI]\b/.test(t) || /^(prologue|epilogue|introduction|preface|foreword|afterword|interlude|conclusion)\b/i.test(t) || new RegExp(`\\b(${SPELLED})\\b`, 'i').test(t)))
          || (/^[MDCLXVI]{1,7}\.?$/.test(t) && roman(t) > 0 && next.length > 60)
          || (/^(?:the\s+)?(?:${SPELLED})\.?$/i.test(t) && t === t.toUpperCase() && next.length > 60);
        if (isHead) found.push({ para: i, title: titleCase(t.replace(/\s+/g, ' ')) });
      });
      if (found.length >= 2 || (!ch.length && found.length)) list = found;
    }
    // merge a bare heading with the subtitle line right after it ("CHAPTER IV" + "THE STORM")
    for (const f of list) {
      const nx = (paras[f.para + 1] || '').trim();
      if (nx && nx.length < 60 && /^[MDCLXVI\d]+\.?$|^(chapter|book|canto|letter|stave)\s+\S+\.?$/i.test(f.title.trim()) && SpeechText_isHeadingOf(paras[f.para] || '', f.title)
        && !/[.!?,;]$/.test(nx) && !HEAD_RE.test(nx) && !list.some((g) => g.para === f.para + 1)
        && !/^\p{Ll}/u.test(nx) && !continues(nx, paras[f.para + 2] || '')) f.title = titleCase(f.title.replace(/\.$/, '')) + ': ' + titleCase(nx);
    }
    // parts and nesting
    const hasParts = list.some((c) => PART_RE.test(c.title)) && list.some((c) => !PART_RE.test(c.title));
    const firstPart = list.findIndex((c) => PART_RE.test(c.title));
    return list.map((c, k) => ({ para: c.para, title: titleCase(c.title), level: hasParts && k > firstPart && !PART_RE.test(c.title) ? 1 : 0 }));
  }

  // ---------- lines broken in the middle of a sentence ----------
  const ENDS_SENTENCE = /[.!?…:;"”’»)\]]\s*$/;
  /** First letter or digit of `b`, after any opening quotes or brackets. */
  const firstChar = (b) => (String(b || '').trimStart().replace(/^[“"‘'(\[]+/, '')[0] || '');
  /**
   * For books where every printed line became its own paragraph (scans, PDFs, converted text): the usual
   * length of a full line. 0 for ordinary books, where only the stricter rules in continues() apply.
   */
  function lineLength(paras) {
    if (!paras || paras.length < 30) return 0;
    let pairs = 0, open = 0, lower = 0;
    for (let i = 1; i < paras.length; i++) {
      const a = String(paras[i - 1]).trimEnd();
      if (a.length < 20) continue;
      pairs++;
      if (!ENDS_SENTENCE.test(a)) { open++; if (/^\p{Ll}/u.test(firstChar(paras[i]))) lower++; }
    }
    // lots of lines stop mid-sentence, and many of them carry on in lower case: a line-broken book
    if (pairs < 20 || open < pairs * 0.25 || lower < pairs * 0.08) return 0;
    const lens = paras.map((p) => String(p).trim().length).filter((n) => n >= 20).sort((x, y) => x - y);
    return lens.length ? lens[Math.floor(lens.length / 2)] : 0;
  }
  /**
   * Does paragraph `next` carry on the sentence of `prev`? (Scanned books and PDFs often break every line.)
   * `lineLen` from lineLength(): in line-broken books a full-length line that stops mid-sentence always carries
   * on, even into a capital ("Mr. Darcy", "I"), a number or a quote.
   */
  function continues(prev, next, lineLen = 0) {
    const a = String(prev || '').trimEnd(), b = String(next || '').trimStart();
    if (!a || !b) return false;
    if (ENDS_SENTENCE.test(a)) return false;
    if (HEAD_RE.test(a) && a.length < 80 && /\d|[MDCLXVI]\b/.test(a)) return false;
    if (HEAD_RE.test(b) && b.length < 80 && /\d|[MDCLXVI]\b/.test(b)) return false;
    if (a.length < 60 && a === a.toUpperCase() && /\p{L}/u.test(a)) return false;
    const f = firstChar(b);
    if (!f) return false;
    if (/\p{Ll}/u.test(f)) return true;
    // after a comma or dash the sentence goes on, even into a name or a quote
    if (/[,—–-]$/.test(a) && /[\p{L}\p{N}]/u.test(f)) return true;
    return lineLen > 0 && a.length >= lineLen * 0.7 && /[\p{L}\p{N}]$/u.test(a) && /[\p{L}\p{N}]/u.test(f);
  }
  /** Joins two pieces of one sentence, mending words split with a hyphen at the line end. */
  function joinText(a, b) {
    const x = String(a).trimEnd(), y = String(b).trimStart();
    return /\p{Ll}-$/u.test(x) && /^\p{Ll}/u.test(y) ? x.slice(0, -1) + y : x + ' ' + y;
  }
  /** Merges broken lines into whole paragraphs (for text that has no saved places to keep, like the audiobook maker). */
  function mendParagraphs(paras) {
    const out = [];
    const len = lineLength(paras);
    for (const p of paras) {
      if (isPageNumber(p)) continue;   // page numbers are never read, and often sit in the middle of a sentence
      if (out.length && continues(out[out.length - 1], p, len)) out[out.length - 1] = joinText(out[out.length - 1], p); else out.push(p);
    }
    return out;
  }

  // invisible or broken characters that make voices stumble, freeze or go silent
  const INVISIBLE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFE00-\uFE0F\uFEFF\uFFF9-\uFFFC]/g;
  const ODD_SPACE = /[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\t\r\n]/g;
  const JUNK = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFD\uE000-\uF8FF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
  const RUNS = /([^\p{L}\p{N}\s])\1{3,}/gu;
  /** Text made safe for any voice: no invisible, control, broken or private-use characters; one kind of space. */
  function clean(s) {
    return String(s).replace(INVISIBLE, '').replace(JUNK, ' ').replace(ODD_SPACE, ' ').replace(RUNS, '$1').replace(/ {2,}/g, ' ').trim();
  }
  /** True when there's something a voice can actually say (a letter or a digit). */
  const hasWords = (s) => /[\p{L}\p{N}]/u.test(s);
  /** Splits long text at commas, semicolons or spaces into parts no longer than max; drops parts with nothing to say. */
  function chunks(text, max = 220) {
    const t = String(text).replace(/\s+/g, ' ').trim();
    if (!hasWords(t)) return [];
    if (t.length <= max) return [t];
    const out = []; let rest = t;
    while (rest.length > max) {
      const w = rest.slice(0, max);
      let cut = Math.max(w.lastIndexOf(', '), w.lastIndexOf('; '), w.lastIndexOf(': '), w.lastIndexOf(' — '));
      if (cut < max / 3) cut = w.lastIndexOf(' ');
      if (cut < max / 3) cut = max - 1;
      out.push(rest.slice(0, cut + 1).trim()); rest = rest.slice(cut + 1).trim();
    }
    if (rest) out.push(rest);
    return out.filter(hasWords);
  }

  const api = { clean, hasWords, chunks, continues, lineLength, joinText, mendParagraphs, normalize, pieces, endPause, vary, chapterOpening, isHeadingOf, headerLines, isPageNumber, improveChapters, words, ordinal, year, roman, titleCase };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpeechText = api;
})(typeof self !== 'undefined' ? self : this);
