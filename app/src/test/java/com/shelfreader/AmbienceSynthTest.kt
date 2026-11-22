package com.shelfreader

import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs
import kotlin.math.sqrt

/** Background sounds: every sound plays, never breaks, and is about as loud as the PC app's version. */
class AmbienceSynthTest {
    // loudness of each raw sound in the PC app (desktop/ui/ambience-synth.js, 40 s each)
    private val pc = mapOf("rain" to 0.209, "thunder" to 0.075, "waves" to 0.229, "stream" to 0.130, "wind" to 0.088, "fire" to 0.077,
        "crickets" to 0.090, "fan" to 0.207, "white" to 0.577, "pink" to 0.428, "brown" to 0.200)

    @Test fun eachSoundMatchesThePcApp() {
        val sr = 32000
        for (s in AmbienceSynth.SOUNDS) {
            val g = AmbienceSynth.make(s.id, sr, 99)
            var sum = 0.0
            val n = sr * 40
            for (i in 0 until n) { val x = g.next(); assertTrue("${s.id} made a broken sample", x.isFinite()); sum += x * x }
            val rms = sqrt(sum / n)
            val want = pc.getValue(s.id)
            val tol = if (s.id == "thunder") 0.6 else 0.4
            assertTrue("${s.id}: loudness $rms, PC app $want", abs(rms - want) <= want * tol)
        }
    }

    @Test fun mixerStaysInRangeAndFades() {
        val m = AmbienceSynth.Mixer(32000)
        m.set(AmbienceSynth.SOUNDS.associate { it.id to 1f }, 1f)
        val buf = FloatArray(32000)
        repeat(8) { m.render(buf); for (x in buf) assertTrue("sample out of range: $x", x.isFinite() && abs(x) <= 1f) }
        m.set(emptyMap(), 0f)
        repeat(6) { m.render(buf) }
        assertTrue("didn't fade out", m.silent())
        assertTrue("still making sound after fading out", m.render(buf) == 0)
    }
}
