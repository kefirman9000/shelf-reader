package com.shelfreader

import kotlin.random.Random

/**
 * Spoken text: what a narrator would actually say, and where to pause.
 * Same rules as the PC app's speechtext.js:
 *  - normalize(): Roman numerals in context, ordinals, years and decades, money, times, percentages, abbreviations
 *  - pieces(): splits a sentence at ; : — … ( ) so each part gets its own pause, plus the pause after it
 *  - chapterOpening(): "CHAPTER XII. THE STORM" → "Chapter Twelve." (pause) "The Storm." (longer pause)
 *  - headerLines(): running headers repeated through a book, to skip
 *  - improveChapters(): finds chapters and parts when a book has none or a useless list
 */
object SpeechText {
    data class Piece(val text: String, val gapMs: Int)

    private val ONES = listOf("zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
        "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen")
    private val TENS = listOf("", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety")
    private val ORD_IRR = mapOf("one" to "first", "two" to "second", "three" to "third", "five" to "fifth", "eight" to "eighth", "nine" to "ninth", "twelve" to "twelfth")

    fun words(n0: Long): String {
        val n = n0
        if (n < 0) return "minus " + words(-n)
        if (n < 20) return ONES[n.toInt()]
        if (n < 100) return TENS[(n / 10).toInt()] + if (n % 10 != 0L) "-" + ONES[(n % 10).toInt()] else ""
        if (n < 1000) return ONES[(n / 100).toInt()] + " hundred" + if (n % 100 != 0L) " " + words(n % 100) else ""
        for ((v, name) in listOf(1_000_000_000L to "billion", 1_000_000L to "million", 1000L to "thousand")) {
            if (n >= v) return words(n / v) + " " + name + if (n % v != 0L) " " + words(n % v) else ""
        }
        return n.toString()
    }
    fun words(n: Int) = words(n.toLong())

    fun ordinal(n: Int): String {
        val w = words(n)
        val last = Regex("([a-z]+)$").find(w)!!.groupValues[1]
        val o = ORD_IRR[last] ?: if (last.endsWith("y")) last.dropLast(1) + "ieth" else last + "th"
        return w.substring(0, w.length - last.length) + o
    }

    fun year(y: Int): String {
        if (y in 2000..2009) return words(y)
        if (y % 100 == 0) return words(y / 100) + " hundred"
        val lo = y % 100
        return words(y / 100) + " " + if (lo < 10) "oh " + words(lo) else words(lo)
    }
    private fun plural(w: String) = if (w.endsWith("y")) w.dropLast(1) + "ies" else w + "s"
    private fun capWords(s: String) = s.replace(Regex("(^|[\\s-])(?!the\\b)(\\w)")) { it.groupValues[1] + it.groupValues[2].uppercase() }

    // ---------- Roman numerals ----------
    private val ROMAN_OK = Regex("^(?=[MDCLXVI])M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$")
    fun roman(s0: String): Int {
        val s = s0.uppercase().removeSuffix(".")
        if (!ROMAN_OK.matches(s)) return 0
        val v = mapOf('I' to 1, 'V' to 5, 'X' to 10, 'L' to 50, 'C' to 100, 'D' to 500, 'M' to 1000)
        var n = 0
        for (i in s.indices) { val a = v[s[i]]!!; val b = if (i + 1 < s.length) v[s[i + 1]]!! else 0; n += if (a < b) -a else a }
        return n
    }
    private const val KEYWORDS = "chapter|chap\\.?|book|part|volume|vol\\.?|act|scene|section|sect\\.?|canto|letter|appendix|psalm|article|stave|plate|figure|fig\\.?|lesson|lecture|hymn|sonnet|ode|epistle|essay|tome|fytte|movement"
    private val KW_ROMAN = Regex("\\b($KEYWORDS)(\\s+)([MDCLXVI]+|[mdclxvi]+)\\b(?!['’]\\w)", RegexOption.IGNORE_CASE)
    private const val REGNAL = "Henry|Edward|George|William|Charles|James|Elizabeth|Mary|Louis|Richard|John|Peter|Catherine|Alexander|Frederick|Napoleon|Philip|Pius|Leo|Gregory|Innocent|Clement|Benedict|Boniface|Urban|Paul|Ferdinand|Ludwig|Gustav|Gustavus|Christian|Wilhelm|Francis|Nicholas|Ivan|Ramesses|Ramses|Ptolemy|Antiochus|Darius|Cyrus|Constantine|Justinian|Otto|Rudolf|Conrad|Victor|Emmanuel|Umberto|Carlos|Juan|Alfonso|Pedro|Manuel|Joseph|Leopold|Albert|Baldwin|Robert|David|Malcolm|Basil|Michael|Selim|Mehmed|Murad|Suleiman|Henri|Jean|Harold|Canute|Olaf|Magnus|Haakon|Eric|Erik|Sigismund|Casimir|Fyodor|Anne|Victoria|Matilda|Isabella|Margaret|Jane|Maximilian"
    private val REGNAL_I = Regex("\\b($REGNAL)\\s+(I)\\b(?!['’])")
    private val REGNAL_ANY = Regex("\\b([A-Z][a-zà-ÿ]+)\\s+([IVX]{2,6}|V|X)\\b(?!['’])")
    private val REGNAL_NAMES = Regex("^($REGNAL)$")
    private val NOT_REGNAL = ("The A An And But Or If So Then When While Chapter Part Book Act Scene Volume Section Canto Letter Appendix Psalm Article " +
        "Stave Plate Figure Lesson Lecture Hymn Sonnet Ode Epistle Essay Movement World War Type Class Grade Level Phase Stage Mark Model Super Bowl Apollo").split(" ").toSet()

    private fun romanInText(t0: String): String {
        var t = Regex("\\bWorld War (I{1,2})\\b").replace(t0) { "World War " + if (it.groupValues[1] == "I") "One" else "Two" }
        t = KW_ROMAN.replace(t) { m ->
            val kw = m.groupValues[1]; val r = m.groupValues[3]
            val n = roman(r)
            if (n == 0) m.value else {
                val w = words(n)
                kw + m.groupValues[2] + if (kw[0].isUpperCase()) w.replace(Regex("(^|-)(\\w)")) { it.groupValues[1] + it.groupValues[2].uppercase() } else w
            }
        }
        t = REGNAL_I.replace(t) { it.groupValues[1] + " the First" }
        t = REGNAL_ANY.replace(t) { m ->
            val name = m.groupValues[1]; val r = m.groupValues[2]
            if (name in NOT_REGNAL && !REGNAL_NAMES.matches(name)) {
                if (name == "War") name + " " + words(roman(r)) else m.value
            } else {
                val n = roman(r)
                if (n == 0 || n > 39) m.value else name + " the " + ordinal(n).replaceFirstChar { it.uppercase() }
            }
        }
        return t
    }

    // ---------- numbers, money, time, abbreviations ----------
    private val CUR = mapOf("$" to ("dollar" to "cent"), "£" to ("pound" to "penny"), "€" to ("euro" to "cent"), "¥" to ("yen" to ""))
    private val ABBR: List<Pair<Regex, String>> = listOf(
        "\\bMr\\.(?=\\s)" to "Mister", "\\bMrs\\.(?=\\s)" to "Missus", "\\bMs\\.(?=\\s)" to "Miz",
        "\\bDr\\.(?=\\s+[A-Z])" to "Doctor", "\\bDr\\.(?=[\\s,;]|$)" to "Drive",
        "\\bSt\\.(?=\\s+[A-Z])" to "Saint", "\\bSt\\.(?=[,;]|\\s+[a-z]|$)" to "Street",
        "\\bMt\\.(?=\\s+[A-Z])" to "Mount", "\\bFt\\.(?=\\s+[A-Z])" to "Fort", "\\bCapt\\.(?=\\s)" to "Captain", "\\bGen\\.(?=\\s+[A-Z])" to "General",
        "\\bCol\\.(?=\\s+[A-Z])" to "Colonel", "\\bLt\\.(?=\\s+[A-Z])" to "Lieutenant", "\\bSgt\\.(?=\\s+[A-Z])" to "Sergeant", "\\bProf\\.(?=\\s+[A-Z])" to "Professor",
        "\\bRev\\.(?=\\s+[A-Z])" to "Reverend", "\\bGov\\.(?=\\s+[A-Z])" to "Governor", "\\bSen\\.(?=\\s+[A-Z])" to "Senator",
        ",?\\s+Jr\\.(?=[\\s,;]|$)" to " Junior", ",?\\s+Sr\\.(?=[\\s,;]|$)" to " Senior",
        "(?i)\\be\\.g\\.,?" to "for example,", "(?i)\\bi\\.e\\.,?" to "that is,", "\\betc\\.(?=\\s+[a-z])" to "et cetera,", "\\betc\\." to "et cetera.",
        "\\bvs?\\.(?=\\s)" to "versus", "\\bNo\\.(?=\\s*\\d)" to "number", "(?i)\\bapprox\\.(?=\\s)" to "approximately",
        "\\bpp\\.(?=\\s*\\d)" to "pages", "\\bp\\.(?=\\s*\\d)" to "page", "(?i)\\bch\\.(?=\\s*\\d)" to "chapter",
        "\\s&\\s" to " and ", "(\\d)\\s?°\\s?F\\b" to "$1 degrees Fahrenheit", "(\\d)\\s?°\\s?C\\b" to "$1 degrees Celsius", "(\\d)\\s?°" to "$1 degrees"
    ).map { Regex(it.first) to it.second }

    private val MONEY = Regex("([$£€¥])\\s?(\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.(\\d{1,2}))?(\\s+(?:million|billion|thousand))?\\b")
    private val TIME = Regex("\\b([01]?\\d|2[0-3]):([0-5]\\d)(?:\\s?([apAP])\\.?\\s?[mM]\\.?\\b)?")
    private val DECADE = Regex("\\b(1[1-9]|20)(\\d)0['’]?s\\b")
    private val YEAR_CTX = Regex("\\b(in|of|since|by|from|until|till|to|year|around|circa|before|after|during|summer|winter|spring|autumn|fall|January|February|March|April|May|June|July|August|September|October|November|December|\\d{1,2},?)\\s+(1[0-9]\\d\\d|20\\d\\d)\\b(?![,.]\\d)")
    private val ORD = Regex("\\b(\\d{1,4})(st|nd|rd|th)\\b", RegexOption.IGNORE_CASE)

    private fun numbers(t0: String): String {
        var t = MONEY.replace(t0) { m ->
            val (unit, sub) = CUR[m.groupValues[1]]!!
            val n = m.groupValues[2].replace(",", "").toLong()
            val frac = m.groupValues[3]; val big = m.groupValues[4]
            if (big.isNotEmpty()) "${words(n)}${if (frac.isNotEmpty()) " point " + frac.map { ONES[it - '0'] }.joinToString(" ") else ""}$big ${plural(unit)}"
            else {
                var s = "${words(n)} ${if (n == 1L) unit else plural(unit)}"
                if (frac.isNotEmpty() && frac.toInt() != 0 && sub.isNotEmpty()) {
                    val f = (if (frac.length == 1) frac + "0" else frac).toInt()
                    s += " and ${words(f)} ${if (f == 1) sub else if (sub == "penny") "pence" else plural(sub)}"
                }
                s
            }
        }
        t = TIME.replace(t) { m ->
            val h = m.groupValues[1].toInt(); val mi = m.groupValues[2].toInt(); val ap = m.groupValues[3]
            val s = if (mi == 0) (if (ap.isNotEmpty()) words(h) else words(h) + " o'clock") else "${words(h)} ${if (mi < 10) "oh " + words(mi) else words(mi)}"
            if (ap.isNotEmpty()) "$s ${ap.uppercase()} M" else s
        }
        t = DECADE.replace(t) { m ->
            val y = (m.groupValues[1] + m.groupValues[2] + "0").toInt()
            if (y % 100 == 0) words(y / 100) + " hundreds" else year(y).replace(Regex("ty$"), "ties")
        }
        t = YEAR_CTX.replace(t) { "${it.groupValues[1]} ${year(it.groupValues[2].toInt())}" }
        t = ORD.replace(t) { ordinal(it.groupValues[1].toInt()) }
        t = Regex("(\\d)\\s?%").replace(t, "$1 percent")
        return t
    }

    /** Text as a narrator would say it. */
    fun normalize(text: String): String {
        var t = romanInText(text)
        t = numbers(t)
        for ((re, to) in ABBR) t = re.replace(t, to)
        return t.replace(Regex("\\s{2,}"), " ").trim()
    }

    // ---------- pauses ----------
    fun endPause(s: String): Int {
        val t = s.trim().trimEnd('"', '”', '’', '»', ')', ']')
        return when {
            t.endsWith("…") || t.endsWith("...") -> 650
            t.endsWith("—") || t.endsWith("–") || t.endsWith("-") -> 90
            t.endsWith("?") -> 430
            t.endsWith("!") -> 400
            t.endsWith(":") || t.endsWith(";") -> 330
            t.endsWith(".") -> 320
            else -> 260
        }
    }
    private val CLAUSE = Regex("([;:]\\s+|\\s[—–]\\s|(?<=\\w)[—–](?=\\w)|…\\s+|\\.\\.\\.\\s+)")
    /** Splits a sentence at clause marks so voices that rush through them get a real pause. */
    fun pieces(s: String, min: Int = 18): List<Piece> {
        val out = ArrayList<Piece>()
        var last = 0
        for (m in CLAUSE.findAll(s)) {
            val mark = m.value
            val end = m.range.first + mark.trimEnd().length
            val part = s.substring(last, end).trim()
            val rest = s.substring(m.range.last + 1).trim()
            if (part.length >= min && rest.length >= min) {
                val gap = when {
                    ';' in mark -> 260
                    ':' in mark -> 240
                    '—' in mark || '–' in mark -> 170
                    else -> 380
                }
                out += Piece(part, gap)
                last = m.range.last + 1
            }
        }
        val tail = s.substring(last).trim()
        if (tail.isNotEmpty()) out += Piece(tail, endPause(tail))
        return if (out.isEmpty()) listOf(Piece(s.trim(), endPause(s))) else out
    }
    /** A little variation (±8%) so pauses don't feel machine-even. */
    fun vary(ms: Int, amount: Double = 0.08): Int = maxOf(0, (ms * (1 + (Random.nextDouble() * 2 - 1) * amount)).toInt())

    // ---------- chapter headings ----------
    private const val SPELLED = "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|last"
    private val HEAD_RE = Regex("^\\s*($KEYWORDS|prologue|epilogue|introduction|preface|foreword|afterword|interlude|conclusion|postscript|envoi|coda)\\b\\.?\\s*([MDCLXVI]+\\b|\\d{1,3}\\b|(?:the\\s+)?(?:$SPELLED)(?:[-\\s](?:$SPELLED))*\\b)?\\.?\\s*[:.—–-]?\\s*(.*)$", RegexOption.IGNORE_CASE)
    private val NOT_ROMAN_WORD = setOf("mix", "mi", "di", "li", "ci", "mc", "md", "cd", "dc", "cv", "dim", "mid", "vi")
    fun titleCase(s: String): String {
        if (s != s.uppercase() || !Regex("[A-Z]{2}").containsMatchIn(s)) return s
        var t = s.lowercase().replace(Regex("(^|[\\s\"“(—–-])(\\p{L})")) { it.groupValues[1] + it.groupValues[2].uppercase() }
        t = Regex("(?<=.)\\b(A|An|The|Of|And|In|On|At|To|For|By|With)\\b(?!$)").replace(t) { it.value.lowercase() }
        t = Regex("\\b([IVXLCDM][ivxlcdm]*)\\b").replace(t) { m ->
            val w = m.value
            if (roman(w) > 0 && (w.length > 1 || w == "I") && w.lowercase() !in NOT_ROMAN_WORD) w.uppercase() else w
        }
        return t
    }
    private fun fin(s: String) = if (Regex("[.!?…]$").containsMatchIn(s)) s else "$s."

    /** "CHAPTER XII. THE STORM" → [Chapter Twelve. (650 ms), The Storm. (1000 ms)] */
    fun chapterOpening(title: String): List<Piece> {
        val raw = title.trim()
        if (raw.isEmpty()) return emptyList()
        val m = HEAD_RE.find(raw)
        if (m != null) {
            val kw = m.groupValues[1].removeSuffix(".")
            val kwName = mapOf("chap" to "Chapter", "vol" to "Volume", "sect" to "Section", "fig" to "Figure")[kw.lowercase()]
                ?: kw.lowercase().replaceFirstChar { it.uppercase() }
            var num = m.groupValues[2]
            if (num.isNotEmpty()) {
                val r = roman(num)
                num = if (num.all { it.isDigit() }) words(num.toInt()) else if (r > 0) words(r) else num.lowercase()
            }
            val head = (kwName + if (num.isNotEmpty()) " " + capWords(num) else "").trim()
            val rest = titleCase(m.groupValues[3].trim()).replace(Regex("^[.:—–-]\\s*"), "")
            return if (rest.isNotEmpty()) listOf(Piece(fin(head), 650), Piece(fin(rest), 1000)) else listOf(Piece(fin(head), 1000))
        }
        val bare = raw.removeSuffix(".")
        val r = roman(bare)
        if (r > 0 && Regex("^[MDCLXVI]+$").matches(bare)) return listOf(Piece(fin(words(r).replaceFirstChar { it.uppercase() }), 1000))
        if (Regex("^\\d{1,3}$").matches(bare)) return listOf(Piece(fin(words(bare.toInt()).replaceFirstChar { it.uppercase() }), 1000))
        return listOf(Piece(fin(titleCase(raw)), 1000))
    }

    private fun norm(s: String) = s.lowercase().replace(Regex("[^\\p{L}\\p{N}]+"), " ").trim()
    /** Is this paragraph just the chapter heading (so it isn't read twice)? */
    fun isHeadingOf(para: String, title: String): Boolean {
        val a = norm(para); val b = norm(title)
        return a.isNotEmpty() && (a == b || (a.length < 90 && b.startsWith(a)) || (b.length < 90 && a.startsWith(b) && a.length - b.length < 4))
    }

    // ---------- page furniture ----------
    /** Short lines repeated through a book (running headers like the title or author), to skip. */
    fun headerLines(paras: List<String>, title: String, author: String): Set<String> {
        val counts = HashMap<String, Int>()
        for (p in paras) { if (p.length > 70) continue; val k = norm(p); if (k.isNotEmpty()) counts[k] = (counts[k] ?: 0) + 1 }
        val tk = norm(title); val ak = norm(author)
        return counts.filter { (k, c) ->
            c >= 3 && (k == tk || k == ak || (tk.isNotEmpty() && k.contains(tk)) || (ak.isNotEmpty() && k.contains(ak)) || Regex("^\\d+ ").containsMatchIn(k) || Regex(" \\d+$").containsMatchIn(k))
        }.keys
    }
    fun isHeader(headers: Set<String>, p: String) = p.length <= 70 && norm(p) in headers
    private val PAGE_NUM = Regex("(?i)^\\s*(?:\\[?(?:page|pg\\.?|p\\.)\\s*)?[-–—]?\\s*(\\d{1,4}|[ivxlcdm]{1,7})\\s*[-–—]?\\]?\\s*$")
    fun isPageNumber(p: String) = PAGE_NUM.matches(p)

    // ---------- chapters ----------
    private val PART_RE = Regex("^\\s*(part|book|volume|vol\\.?)\\b", RegexOption.IGNORE_CASE)
    private val GENERIC = Regex("^(page|pg|section|chapter|part|text|split|file|item|untitled)?[\\s_-]*\\d+(\\.x?html?)?$|^(part|split|chapter|text|ch|pg|page)\\d+[_.-]?\\w*$|^\\d+$", RegexOption.IGNORE_CASE)
    private val HEAD_HAS_NUM = Regex("\\d|[MDCLXVI]\\b|\\b($SPELLED)\\b", RegexOption.IGNORE_CASE)
    private val HEAD_WORDS = Regex("^(prologue|epilogue|introduction|preface|foreword|afterword|interlude|conclusion)\\b", RegexOption.IGNORE_CASE)
    private val BARE = Regex("^[MDCLXVI\\d]+\\.?$|^(chapter|book|canto|letter|stave)\\s+\\S+\\.?$", RegexOption.IGNORE_CASE)

    /** A better chapter list (level 0 = part/book, 1 = chapter inside a part). */
    fun improveChapters(paras: List<String>, chapters: List<Chapter>): List<Chapter> {
        val ch = chapters.filter { it.para >= 0 && it.para < paras.size }
        val generic = ch.count { GENERIC.matches(it.title.trim()) }
        val tooMany = ch.size > 30 && ch.size > paras.size / 3
        var list = ch.map { Chapter(it.title.trim(), it.para) }.toMutableList()
        if (ch.isEmpty() || generic > ch.size * 0.6 || tooMany || (ch.size <= 2 && paras.size > 400)) {
            val found = ArrayList<Chapter>()
            for ((i, p) in paras.withIndex()) {
                val t = p.trim()
                if (t.isEmpty() || t.length > 80) continue
                val next = paras.getOrNull(i + 1) ?: ""
                val isHead = (HEAD_RE.matches(t) && (HEAD_HAS_NUM.containsMatchIn(t) || HEAD_WORDS.containsMatchIn(t))) ||
                    (Regex("^[MDCLXVI]{1,7}\\.?$").matches(t) && roman(t) > 0 && next.length > 60) ||
                    (Regex("^(?:the\\s+)?(?:$SPELLED)\\.?$", RegexOption.IGNORE_CASE).matches(t) && t == t.uppercase() && next.length > 60)
                if (isHead) found += Chapter(titleCase(t.replace(Regex("\\s+"), " ")), i)
            }
            if (found.size >= 2 || (ch.isEmpty() && found.isNotEmpty())) list = found
        }
        // merge a bare heading with the subtitle line right after it ("CHAPTER IV" + "THE STORM")
        val paraSet = list.map { it.para }.toSet()
        list = list.map { c ->
            val nx = paras.getOrNull(c.para + 1)?.trim() ?: ""
            if (nx.isNotEmpty() && nx.length < 60 && BARE.matches(c.title.trim()) && isHeadingOf(paras[c.para], c.title) &&
                !Regex("[.!?,;]$").containsMatchIn(nx) && !HEAD_RE.matches(nx) && (c.para + 1) !in paraSet
            ) Chapter(titleCase(c.title.removeSuffix(".")) + ": " + titleCase(nx), c.para) else c
        }.toMutableList()
        val hasParts = list.any { PART_RE.containsMatchIn(it.title) } && list.any { !PART_RE.containsMatchIn(it.title) }
        val firstPart = list.indexOfFirst { PART_RE.containsMatchIn(it.title) }
        return list.mapIndexed { k, c -> Chapter(titleCase(c.title), c.para, if (hasParts && k > firstPart && !PART_RE.containsMatchIn(c.title)) 1 else 0) }
    }

    /** Paragraph indexes of subtitle lines that were merged into a chapter title (read as part of the heading). */
    fun mergedSubtitles(paras: List<String>, chapters: List<Chapter>): Set<Int> {
        val out = HashSet<Int>()
        for (c in chapters) {
            val nx = paras.getOrNull(c.para + 1)?.trim() ?: continue
            if (nx.isNotEmpty() && nx.length < 70 && isHeadingOf(paras[c.para], c.title) &&
                c.title.lowercase().endsWith(nx.lowercase().trimEnd('.', ':'))
            ) out += c.para + 1
        }
        return out
    }

    /** A tiny steady change of pace per paragraph (±2%). */
    fun paceFor(para: Int): Float = 1f + (((para * 7919) % 41) - 20) / 1000f
}
