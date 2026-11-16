package com.shelfreader

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Runs the "hard cases" book (tools/torture.txt) through everything that turns book text into speech.
 * Reading must never get stuck: every sentence is either skipped or becomes pieces a voice can take
 * (has words, no hidden/broken characters, not too long), and nothing throws or hangs.
 */
class HardCasesTest {
    private val book: String by lazy {
        val f = listOf(File("../tools/torture.txt"), File("tools/torture.txt")).first { it.exists() }
        f.readText() + "\nA lone \uD83D half and \uDC00 another.\n"
    }
    private val paras by lazy { book.split(Regex("\n+")).map { it.trim() }.filter { it.isNotEmpty() } }
    private val bad = Regex("[\\u0000-\\u001F\\u007F-\\u009F\\u00AD\\u200B-\\u200F\\u2060\\uFEFF\\uFFFD\\uE000-\\uF8FF]")

    private fun loneSurrogate(s: String): Boolean {
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (Character.isHighSurrogate(c) && i + 1 < s.length && Character.isLowSurrogate(s[i + 1])) { i += 2; continue }
            if (Character.isSurrogate(c)) return true
            i++
        }
        return false
    }

    private fun checkPiece(where: String, t: String) {
        assertTrue("$where: nothing to say in \"$t\"", SpeechText.hasWords(t))
        assertFalse("$where: hidden or broken character in \"$t\"", bad.containsMatchIn(t))
        assertFalse("$where: half an emoji in \"$t\"", loneSurrogate(t))
        assertTrue("$where: too long (${t.length})", t.length <= 900)
    }

    @Test(timeout = 60_000)
    fun everySentenceIsSayableOrSkipped() {
        val segs = Speech.segments(paras)
        assertTrue(segs.size > 30)
        for (opts in listOf(true to true, false to false, true to false, false to true)) {
            val sp = Speaker(opts.first, opts.second, listOf(Fix("Hudson", "Hudsun")))
            var spoken = 0
            for ((k, s) in segs.withIndex()) {
                assertTrue("segment $k is longer than 400 characters", s.end - s.start <= 400)
                val raw = paras[s.para].substring(s.start, s.end)
                val said = sp.spoken(raw) ?: continue
                spoken++
                for (p in SpeechText.pieces(said)) for (c in SpeechText.chunks(SpeechText.clean(p.text), 900)) checkPiece("segment $k $opts", c)
                for (c in SpeechText.chunks(SpeechText.clean(said), 220)) checkPiece("segment $k (natural voice) $opts", c)
            }
            assertTrue("almost nothing was spoken", spoken > 20)
        }
    }

    @Test(timeout = 30_000)
    fun numberedListIsNotAllSkipped() {
        // the bug from 16 Nov: "(Fill in) 1. 2. 3. 4. 5." — reading must reach the text after it
        val ps = listOf("(Fill in) 1. 2. 3. 4. 5. 6. 7. 8.", "1.", "2.", "3.", "4.", "5.", "And then the story goes on.")
        val segs = Speech.segments(ps)
        val sp = Speaker(true, true, emptyList())
        val said = segs.mapNotNull { sp.spoken(ps[it.para].substring(it.start, it.end)) }
        assertTrue(said.any { it.contains("story goes on") })
    }

    @Test(timeout = 30_000)
    fun cleanRemovesWhatVoicesChokeOn() {
        val t = SpeechText.clean("a​b­c﻿d\u0007e�fg \uD83D h ----- i 😀")
        assertFalse(bad.containsMatchIn(t)); assertFalse(loneSurrogate(t))
        assertTrue(t.contains("😀"))
        assertTrue(t.startsWith("abcd"))
        assertFalse(SpeechText.hasWords(SpeechText.clean("* * * ——— …")))
    }

    @Test(timeout = 30_000)
    fun chunksAreBoundedAndComplete() {
        val words = (1..3000).joinToString(" ") { "w$it" }
        val parts = SpeechText.chunks(words, 220)
        assertTrue(parts.all { it.length <= 220 })
        assertTrue(parts.joinToString(" ").split(" ").size == 3000)
        val noSpaces = "x".repeat(5000)
        assertTrue(SpeechText.chunks(noSpaces, 220).all { it.length <= 220 })
    }

    @Test(timeout = 30_000)
    fun textHelpersNeverThrow() {
        for (p in paras) {
            SpeechText.normalize(p); SpeechText.pieces(p); SpeechText.isPageNumber(p)
            SpeechText.chapterOpening(p.take(80))
        }
        val ll = SpeechText.lineLength(paras)
        for (i in 1 until paras.size) if (SpeechText.continues(paras[i - 1], paras[i], ll)) SpeechText.joinText(paras[i - 1], paras[i])
    }
}
