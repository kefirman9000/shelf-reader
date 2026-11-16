package com.shelfreader

import android.content.Context
import android.util.Log

/** Runs a natural-voice check (used by the "Voice test" workflow on an emulator; not reachable from the app's UI). */
object SelfTest {
    private const val TAG = "ShelfSelfTest"
    fun run(ctx: Context, modelId: String) {
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
                val done = Object()
                val sp = NeuralSpeaker(ctx, { Log.i(TAG, "start $it") }, { Log.i(TAG, "done $it"); if (it == "b") synchronized(done) { (done as Object).notifyAll() } }, { id, msg -> Log.e(TAG, "error $id $msg") })
                sp.voice = NeuralVoices.key(m, m.voices[0].first)
                sp.speak("First sentence from the player.", true, "a", 1f)
                sp.silence(300, "p")
                sp.speak("And a second one.", false, "b", 1.1f)
                synchronized(done) { (done as Object).wait(60_000) }
                sp.shutdown()
                Log.i(TAG, "SELFTEST DONE OK")
            } catch (t: Throwable) {
                Log.e(TAG, "SELFTEST FAILED", t)
            }
        }.start()
    }
}
