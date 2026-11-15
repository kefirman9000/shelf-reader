package com.shelfreader

import android.content.Context

/** One spoken piece of text: usually a sentence, located by paragraph and character range. */
data class Seg(val para: Int, val start: Int, val end: Int)

/** A user pronunciation fix: when the book says [from], the voice says [to]. */
data class Fix(val from: String, val to: String)

object Speech {
    private val abbrev = setOf(
        "mr", "mrs", "ms", "dr", "st", "jr", "sr", "vs", "etc", "e.g", "i.e", "no", "vol", "ch",
        "prof", "rev", "gen", "col", "capt", "lt", "mt", "ft", "pp", "fig", "cf", "hon", "messrs", "mme", "mlle"
    )
    private const val CLOSERS = ".!?\"”’')]"

    /** Splits every paragraph into sentence-sized pieces for reading and highlighting. */
    fun segments(paras: List<String>): List<Seg> {
        val out = ArrayList<Seg>(paras.size * 3)
        for ((pi, p) in paras.withIndex()) {
            val n = p.length
            var start = 0
            var i = 0
            while (i < n) {
                val c = p[i]
                if (c == '.' || c == '!' || c == '?' || c == '…') {
                    var j = i + 1
                    while (j < n && p[j] in CLOSERS) j++
                    if (j < n && p[j] == ' ') {
                        val word = p.substring(wordStart(p, i), i).lowercase()
                        val isAbbrev = c == '.' && (word in abbrev || (word.length == 1 && word[0].isLetter()))
                        if (!isAbbrev) {
                            addSeg(out, pi, p, start, j)
                            start = j + 1
                        }
                    }
                    i = j
                } else {
                    i++
                }
            }
            if (start < n) addSeg(out, pi, p, start, n)
        }
        return out
    }

    private fun wordStart(p: String, i: Int): Int {
        var k = i
        while (k > 0 && (p[k - 1].isLetter() || p[k - 1] == '.')) k--
        return k
    }

    private fun addSeg(out: MutableList<Seg>, pi: Int, p: String, s0: Int, e: Int) {
        var a = s0
        while (a < e && p[a] == ' ') a++
        if (a >= e) return
        while (e - a > 400) {
            val comma = p.lastIndexOf(", ", a + 300)
            var cut = if (comma > a + 80) comma + 1 else -1
            if (cut < 0) {
                val sp = p.lastIndexOf(' ', a + 300)
                cut = if (sp > a + 80) sp else a + 300
            }
            out += Seg(pi, a, cut)
            a = cut
            while (a < e && p[a] == ' ') a++
        }
        if (a < e) out += Seg(pi, a, e)
    }
}

/** Turns book text into what the voice should actually say. */
class Speaker(ctx: Context) {
    private val skipClutter = Settings.skipClutter(ctx)
    private val rules: List<Pair<Regex, String>> = Settings.fixes(ctx).filter { it.from.isNotBlank() }.map {
        Regex("(?<![\\p{L}\\p{N}])" + Regex.escape(it.from) + "(?![\\p{L}\\p{N}])", RegexOption.IGNORE_CASE) to it.to
    }

    companion object {
        private val footnoteRef = Regex("\\[(\\d{1,3}|[a-zA-Z*†‡])\\]|\\{\\d{1,3}\\}|(?<=[.,;:”\"])\\d{1,3}(?=\\s|$)")
        private val url = Regex("https?://\\S+|www\\.\\S+")
        private val illustration = Regex("\\[(Illustration|Image|Picture|Sidenote)[^\\]]*\\]", RegexOption.IGNORE_CASE)
        private val pageMark = Regex("(?i)^\\[?(page|pg\\.?|p\\.)\\s*\\d+\\]?$")
        private val boilerplate = Regex(
            "(?i)digitized by (the )?(internet archive|google|microsoft)|" +
                "produced in epub format by the internet archive|" +
                "^this (e-?book|book) is for the use of anyone anywhere"
        )
        private val punctOnly = Regex("[\\s\\p{P}\\p{S}]")
    }

    /** Returns the text to speak, or null if this piece should be skipped. */
    fun spoken(text: String): String? {
        var t = text
        if (skipClutter) {
            if (boilerplate.containsMatchIn(t)) return null
            if (t.trimStart().startsWith("[Footnote", ignoreCase = true)) return null
            t = footnoteRef.replace(t, "")
            t = illustration.replace(t, "")
            t = url.replace(t, "")
            val trimmed = t.trim()
            if (pageMark.matches(trimmed)) return null
            val core = punctOnly.replace(trimmed, "")
            if (core.isEmpty() || core.all { it.isDigit() }) return null
        }
        for ((re, to) in rules) t = re.replace(t, Regex.escapeReplacement(to))
        return t.trim().ifEmpty { null }
    }
}
