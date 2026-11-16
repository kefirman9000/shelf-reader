package com.shelfreader

import android.content.Context
import android.util.Log

/** Runs a natural-voice check (used by the "Voice test" workflow on an emulator; not reachable from the app's UI). */
object SelfTest {
    private const val TAG = "ShelfSelfTest"
    private val started = java.util.concurrent.atomic.AtomicBoolean(false)
    fun run(ctx: Context, modelId: String) {
        if (!started.compareAndSet(false, true)) return   // the screen can be created twice; run the test once
        Thread {
            try {
                val m = NeuralVoices.MODELS.first { it.id == modelId }
                Log.i(TAG, "START ${m.id}")
                if (!NeuralVoices.installed(ctx, m)) {
                    var last = -1L
                    NeuralVoices.download(ctx, m) { d, t -> val mb = d / 10_000_000; if (mb != last) { last = mb; Log.i(TAG, "download ${d / 1_000_000} / ${t / 1_000_000} MB") } }
                }
                Log.i(TAG, "files: " + NeuralVoices.dir(ctx, m).list()?.joinToString())
                val t0 = System.currentTimeMillis()
                val r = NeuralVoices.generate(ctx, NeuralVoices.key(m, m.voices[0].first), "Hello there. This is a quick test of the voice.", 1f)
                Log.i(TAG, "generated ${r?.first?.size} samples at ${r?.second} Hz in ${System.currentTimeMillis() - t0} ms")
                if (r != null) NeuralVoices.playOnce(r.first, r.second)
                Thread.sleep(4000)
                for (s in listOf("", "—", "…", "12:30 pm, \$4.50 and Chapter XII.", "and so it went on " + "word ".repeat(400))) {
                    val g = NeuralVoices.generate(ctx, NeuralVoices.key(m, m.voices[0].first), s, 1f)
                    Log.i(TAG, "edge '${s.take(20)}' (${s.length} chars) -> ${g?.first?.size} samples")
                }
                val done = Object()
                var errors = 0
                val sp = NeuralSpeaker(ctx, { Log.i(TAG, "start $it") }, { Log.i(TAG, "done $it"); if (it == "b") synchronized(done) { (done as Object).notifyAll() } }, { id, msg -> errors++; Log.e(TAG, "error $id $msg") })
                sp.voice = NeuralVoices.key(m, m.voices[0].first)
                // like reading a book: a pause first, then sentences with pauses between them
                sp.silence(200, "p0")
                val lines = listOf("First sentence from the player.", "It was a bright, cold morning.", "Somewhere a gull called twice.",
                    "Then the harbor went quiet again.", "And a second one.")
                for ((k, line) in lines.withIndex()) {
                    sp.speak(line, false, if (k == lines.size - 1) "b" else "s$k", 1f + k * 0.05f)
                    if (k < lines.size - 1) sp.silence(250L + k * 100, "p${k + 1}")
                }
                synchronized(done) { (done as Object).wait(120_000) }
                Log.i(TAG, "speaker opened ${sp.tracksOpened} time(s)")
                sp.shutdown()
                if (errors > 0) Log.e(TAG, "SELFTEST FAILED: $errors error(s) while playing")
                else if (sp.tracksOpened > 1) Log.e(TAG, "SELFTEST FAILED: the speaker was reopened ${sp.tracksOpened} times")
                else Log.i(TAG, "SELFTEST DONE OK")
            } catch (t: Throwable) {
                Log.e(TAG, "SELFTEST FAILED", t)
            }
        }.start()
    }
}
