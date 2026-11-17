package com.shelfreader

import java.io.File

/**
 * Writes what the phone's spoken-text rules make of a shared list of examples (tools/parity-cases.txt and the
 * hard-cases book), as JSON. desktop/test/parity.test.js runs the PC/maker rules on the same examples and
 * compares, so a fix made on one side can't quietly miss the other.
 */
object ParityDump {
    private fun q(s: String) = buildString {
        append('"')
        for (c in s) when {
            c == '"' -> append("\\\""); c == '\\' -> append("\\\\"); c == '\n' -> append("\\n")
            c.code < 32 || Character.isSurrogate(c) -> append("\\u%04x".format(c.code))
            else -> append(c)
        }
        append('"')
    }
    private fun pcs(l: List<SpeechText.Piece>) = l.joinToString(",", "[", "]") { "[${q(it.text)},${it.gapMs}]" }

    fun cases(root: File): List<String> {
        val a = File(root, "tools/parity-cases.txt").readLines().filter { it.isNotBlank() && !it.startsWith("#") }
        val b = File(root, "tools/torture.txt").readText().split(Regex("\n+")).map { it.trim() }.filter { it.isNotEmpty() && it.length < 600 }
        return a + b
    }

    fun dump(root: File): String {
        val cs = cases(root)
        val sb = StringBuilder("{\n\"cases\": [\n")
        sb.append(cs.joinToString(",\n") { c ->
            val cl = SpeechText.clean(c)
            val n = SpeechText.normalize(cl)
            "{\"in\":${q(c)},\"clean\":${q(cl)},\"hasWords\":${SpeechText.hasWords(cl)},\"normalize\":${q(n)}," +
                "\"pieces\":${pcs(SpeechText.pieces(n))},\"endPause\":${SpeechText.endPause(n)}," +
                "\"chapterOpening\":${pcs(SpeechText.chapterOpening(c.take(80)))},\"isPageNumber\":${SpeechText.isPageNumber(c)}," +
                "\"chunks\":${SpeechText.chunks(cl, 60).joinToString(",", "[", "]") { q(it) }},\"titleCase\":${q(SpeechText.titleCase(c.take(80)))}}"
        })
        sb.append("\n],\n\"pairs\": [\n")
        val ll = SpeechText.lineLength(cs)
        sb.append((1 until cs.size).joinToString(",\n") { i ->
            "{\"a\":${q(cs[i - 1])},\"b\":${q(cs[i])},\"continues\":${SpeechText.continues(cs[i - 1], cs[i], ll)},\"join\":${q(SpeechText.joinText(cs[i - 1], cs[i]))}}"
        })
        sb.append("\n],\n\"lineLength\": $ll,\n\"numbers\": [\n")
        val ns = listOf(0, 1, 7, 13, 21, 99, 100, 101, 999, 1000, 1001, 1066, 1234, 1850, 1999, 2000, 2001, 2010, 10000, 123456, 1000000, 1234567)
        sb.append(ns.joinToString(",\n") { n -> "{\"n\":$n,\"words\":${q(SpeechText.words(n))},\"ordinal\":${q(SpeechText.ordinal(n))},\"year\":${q(SpeechText.year(n))}}" })
        sb.append("\n],\n\"romans\": [\n")
        val rs = listOf("I", "IV", "IX", "XII", "XIV", "XL", "XC", "MCMXCIX", "MMXXVI", "IIII", "VX", "LIV", "CD")
        sb.append(rs.joinToString(",\n") { r -> "{\"s\":${q(r)},\"value\":${SpeechText.roman(r)}}" })
        sb.append("\n]\n}\n")
        return sb.toString()
    }

    @JvmStatic fun main(args: Array<String>) {
        File(args[1]).also { it.parentFile?.mkdirs() }.writeText(dump(File(args[0])))
    }
}
