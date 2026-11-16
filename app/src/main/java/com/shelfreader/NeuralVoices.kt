package com.shelfreader

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Handler
import android.os.Looper
import com.k2fsa.sherpa.onnx.OfflineTts
import com.k2fsa.sherpa.onnx.OfflineTtsConfig
import com.k2fsa.sherpa.onnx.OfflineTtsKokoroModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsVitsModelConfig
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.compressors.bzip2.BZip2CompressorInputStream
import java.io.BufferedInputStream
import java.io.File
import java.util.concurrent.LinkedBlockingDeque
import java.util.concurrent.atomic.AtomicInteger

/**
 * Natural voices that run on the phone itself, with no internet once downloaded:
 * Kokoro (very natural English) and Piper (clear voices in many languages), through sherpa-onnx.
 * A voice is stored in Settings as "neural:<model id>:<speaker number>".
 */
object NeuralVoices {
    private const val BASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/"

    data class Model(val id: String, val title: String, val kind: String, val sizeMb: Int, val lang: String, val file: String, val voices: List<Pair<Int, String>>)

    val MODELS = listOf(
        // the compact (int8) build: same voices, a third of the size and memory — the full one got phones to close the app
        Model("kokoro-int8-en-v0_19", "Kokoro (most natural, English)", "kokoro", 100, "en", "model.int8.onnx", listOf(
            1 to "Bella · American woman", 3 to "Sarah · American woman", 2 to "Nicole · American woman, soft", 4 to "Sky · American woman",
            0 to "Kokoro default · American woman", 6 to "Michael · American man", 5 to "Adam · American man",
            7 to "Emma · British woman", 8 to "Isabella · British woman", 9 to "George · British man", 10 to "Lewis · British man")),
        Model("vits-piper-en_US-lessac-medium", "Piper Lessac", "piper", 64, "en", "en_US-lessac-medium.onnx", listOf(0 to "Lessac · American woman")),
        Model("vits-piper-en_US-amy-medium", "Piper Amy", "piper", 64, "en", "en_US-amy-medium.onnx", listOf(0 to "Amy · American woman")),
        Model("vits-piper-en_US-ryan-medium", "Piper Ryan", "piper", 64, "en", "en_US-ryan-medium.onnx", listOf(0 to "Ryan · American man")),
        Model("vits-piper-en_US-joe-medium", "Piper Joe", "piper", 64, "en", "en_US-joe-medium.onnx", listOf(0 to "Joe · American man")),
        Model("vits-piper-en_GB-alan-medium", "Piper Alan", "piper", 64, "en", "en_GB-alan-medium.onnx", listOf(0 to "Alan · British man")),
        Model("vits-piper-en_GB-jenny_dioco-medium", "Piper Jenny", "piper", 64, "en", "en_GB-jenny_dioco-medium.onnx", listOf(0 to "Jenny · British woman")),
        Model("vits-piper-de_DE-thorsten-medium", "Piper Thorsten", "piper", 64, "de", "de_DE-thorsten-medium.onnx", listOf(0 to "Thorsten · German man")),
        Model("vits-piper-es_ES-davefx-medium", "Piper Davefx", "piper", 64, "es", "es_ES-davefx-medium.onnx", listOf(0 to "Davefx · Spanish man")),
        Model("vits-piper-fr_FR-siwis-medium", "Piper Siwis", "piper", 64, "fr", "fr_FR-siwis-medium.onnx", listOf(0 to "Siwis · French woman")),
        Model("vits-piper-it_IT-paola-medium", "Piper Paola", "piper", 64, "it", "it_IT-paola-medium.onnx", listOf(0 to "Paola · Italian woman")),
        Model("vits-piper-pt_BR-faber-medium", "Piper Faber", "piper", 64, "pt", "pt_BR-faber-medium.onnx", listOf(0 to "Faber · Brazilian man"))
    )

    /** The earlier, full-size Kokoro download (320 MB). Voices chosen with it now use the compact one. */
    const val OLD_KOKORO = "kokoro-en-v0_19"
    fun oldKokoroDir(ctx: Context) = File(ctx.getExternalFilesDir(null) ?: ctx.filesDir, "voices/$OLD_KOKORO")

    fun isNeural(voice: String?) = voice?.startsWith("neural:") == true
    fun key(m: Model, sid: Int) = "neural:${m.id}:$sid"
    fun parse(voice: String?): Pair<Model, Int>? {
        if (!isNeural(voice)) return null
        val parts = voice!!.split(":")
        val id = parts.getOrNull(1).let { if (it == OLD_KOKORO) "kokoro-int8-en-v0_19" else it }
        val m = MODELS.firstOrNull { it.id == id } ?: return null
        return m to (parts.getOrNull(2)?.toIntOrNull() ?: 0)
    }
    fun label(voice: String?): String? = parse(voice)?.let { (m, sid) -> m.voices.firstOrNull { it.first == sid }?.second ?: m.title }

    fun dir(ctx: Context, m: Model) = File(ctx.getExternalFilesDir(null) ?: ctx.filesDir, "voices/${m.id}")
    fun installed(ctx: Context, m: Model) = File(dir(ctx, m), ".done").exists()

    /** Downloads and unpacks a voice model. progress(done, total) in bytes. Runs on a background thread. */
    fun download(ctx: Context, m: Model, onUnpack: () -> Unit = {}, progress: (Long, Long) -> Unit) {
        val root = dir(ctx, m).parentFile!!.apply { mkdirs() }
        val tmp = File(root, "${m.id}.tar.bz2")
        Net.download(BASE + m.id + ".tar.bz2", tmp, emptyMap(), progress)
        onUnpack()
        val target = dir(ctx, m)
        target.deleteRecursively()
        try {
            TarArchiveInputStream(BZip2CompressorInputStream(BufferedInputStream(tmp.inputStream(), 1 shl 16))).use { tar ->
                while (true) {
                    val e = tar.nextEntry ?: break
                    // archives hold one top folder named like the model; strip it and refuse odd paths
                    val rel = e.name.removePrefix("./").substringAfter('/', "")
                    if (rel.isEmpty() || rel.contains("..")) continue
                    val out = File(target, rel)
                    if (e.isDirectory) { out.mkdirs(); continue }
                    out.parentFile?.mkdirs()
                    out.outputStream().use { tar.copyTo(it) }
                }
            }
            File(target, ".done").writeText("ok")
            if (m.kind == "kokoro") oldKokoroDir(ctx).deleteRecursively()   // free the old 320 MB copy
        } finally { tmp.delete() }
    }

    @Synchronized
    fun remove(ctx: Context, m: Model) { if (loadedId == m.id) release(); dir(ctx, m).deleteRecursively() }

    /** A pre-made sample of a voice, to hear it before downloading (made by the "Voice samples" workflow). */
    fun sampleUrl(m: Model, sid: Int) = "https://raw.githubusercontent.com/kefirman9000/shelf-reader/voice-samples/${m.id}-$sid.mp3"

    // one loaded model at a time (they're large)
    private var loadedId: String? = null
    private var loaded: OfflineTts? = null

    @Synchronized
    fun engine(ctx: Context, m: Model): OfflineTts {
        if (loadedId == m.id && loaded != null) return loaded!!
        loaded?.release(); loaded = null; loadedId = null
        val d = dir(ctx, m)
        // don't start loading when the phone is nearly out of memory: Android would close the app
        val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as android.app.ActivityManager
        val mi = android.app.ActivityManager.MemoryInfo().also { am.getMemoryInfo(it) }
        val need = (m.sizeMb * 2L + 60) * 1_000_000L
        if (mi.availMem < need) throw Exception("Not enough free memory for this voice right now. Close some apps and try again, or pick a Piper voice (smaller).")
        val threads = if (CrashReport.safeVoices(ctx)) 1 else 2
        val model = if (m.kind == "kokoro") OfflineTtsModelConfig(
            kokoro = OfflineTtsKokoroModelConfig(model = "$d/${m.file}", voices = "$d/voices.bin", tokens = "$d/tokens.txt", dataDir = "$d/espeak-ng-data"),
            numThreads = threads, provider = "cpu")
        else OfflineTtsModelConfig(
            vits = OfflineTtsVitsModelConfig(model = "$d/${m.file}", tokens = "$d/tokens.txt", dataDir = "$d/espeak-ng-data"),
            numThreads = threads, provider = "cpu")
        CrashReport.busy(ctx, "load ${m.id}")
        val t = try { OfflineTts(config = OfflineTtsConfig(model = model, maxNumSentences = 1)) } finally { CrashReport.busy(ctx, null) }
        loaded = t; loadedId = m.id
        return t
    }

    @Synchronized
    fun release() { loaded?.release(); loaded = null; loadedId = null }

    /** One generation at a time: the playback queue, previews and clips share the loaded model. */
    @Synchronized
    fun gen(ctx: Context, m: Model, text: String, sid: Int, speed: Float): Pair<FloatArray, Int> {
        val tts = engine(ctx, m)
        val parts = chunks(text, if (CrashReport.safeVoices(ctx)) 120 else 220)
        if (parts.isEmpty()) return FloatArray(0) to tts.sampleRate()
        val sp = speed.coerceIn(0.5f, 2.5f)
        val s = if (m.voices.any { it.first == sid }) sid else m.voices[0].first
        CrashReport.busy(ctx, "speak ${m.id}")
        try {
            if (parts.size == 1) { val a = tts.generate(parts[0], s, sp); return a.samples to a.sampleRate }
            // long pieces are made in parts and joined with a short breath, so the model never gets more than it can take
            val out = ArrayList<FloatArray>(); var rate = tts.sampleRate()
            for (p in parts) { val a = tts.generate(p, s, sp); rate = a.sampleRate; out += a.samples; out += FloatArray(rate / 12) }
            val all = FloatArray(out.sumOf { it.size }); var o = 0
            for (a in out) { System.arraycopy(a, 0, all, o, a.size); o += a.size }
            return all to rate
        } finally { CrashReport.busy(ctx, null) }
    }

    fun chunks(text: String, max: Int = 220): List<String> = SpeechText.chunks(SpeechText.clean(text), max)

    /** Makes audio for a short text (for previews and clips). */
    fun generate(ctx: Context, voice: String, text: String, speed: Float): Pair<FloatArray, Int>? {
        val (m, sid) = parse(voice) ?: return null
        if (!installed(ctx, m)) return null
        return gen(ctx, m, text, sid, speed)
    }

    private var previewTrack: AudioTrack? = null
    private val previewLock = Any()   // separate from the model lock, so stopping a preview never waits for speech to be made

    /** Stops a preview that's playing. */
    fun stopPreview() = synchronized(previewLock) {
        previewTrack?.let { try { it.stop() } catch (_: Throwable) {}; try { it.release() } catch (_: Throwable) {} }
        previewTrack = null
    }

    /** Plays a short sample (preview), replacing any that's playing. */
    fun playOnce(samples: FloatArray, rate: Int) {
        if (samples.isEmpty()) return
        stopPreview()
        val t = AudioTrack.Builder()
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_FLOAT).setSampleRate(rate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
            .setTransferMode(AudioTrack.MODE_STATIC)
            .setBufferSizeInBytes(maxOf(samples.size * 4, 4096))
            .build()
        t.write(samples, 0, samples.size, AudioTrack.WRITE_BLOCKING)
        synchronized(previewLock) { previewTrack = t; t.play() }
        Thread {
            Thread.sleep(samples.size * 1000L / rate + 300)
            synchronized(previewLock) { if (previewTrack === t) { try { t.release() } catch (_: Throwable) {}; previewTrack = null } }
        }.start()
    }

    /** Writes 16-bit mono WAV (for audio clips). */
    fun writeWav(f: File, samples: FloatArray, rate: Int) {
        val n = samples.size
        val buf = java.nio.ByteBuffer.allocate(44 + n * 2).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        buf.put("RIFF".toByteArray()); buf.putInt(36 + n * 2); buf.put("WAVEfmt ".toByteArray()); buf.putInt(16)
        buf.putShort(1); buf.putShort(1); buf.putInt(rate); buf.putInt(rate * 2); buf.putShort(2); buf.putShort(16)
        buf.put("data".toByteArray()); buf.putInt(n * 2)
        for (x in samples) buf.putShort((x.coerceIn(-1f, 1f) * 32767).toInt().toShort())
        f.writeBytes(buf.array())
    }
}

/**
 * Speaks with a natural voice like Android's TextToSpeech queue does: items are made one or two ahead on a
 * worker thread and played in order, calling onStart/onDone with the same ids the service already uses.
 */
class NeuralSpeaker(
    private val ctx: Context,
    private val onStart: (String) -> Unit,
    private val onDone: (String) -> Unit,
    private val onError: (String, String) -> Unit
) {
    private class Item(val id: String, val text: String?, val silenceMs: Long, val speed: Float, val epoch: Int)
    /** Speech, or a pause ([silenceMs] > 0, made at whatever rate the speaker is already playing). */
    private class Clip(val id: String, val samples: FloatArray, val rate: Int, val epoch: Int, val silenceMs: Long = 0)

    private val main = Handler(Looper.getMainLooper())
    private val epoch = AtomicInteger(0)
    private val todo = LinkedBlockingDeque<Item>()
    private val ready = LinkedBlockingDeque<Clip>(3)
    @Volatile var voice: String? = null
    @Volatile private var alive = true
    private var track: AudioTrack? = null
    private var trackRate = 0
    /** How many times the speaker was opened (the voice test checks it stays at one per voice). */
    @Volatile var tracksOpened = 0; private set

    private val maker = Thread({
        while (alive) {
            val it = try { todo.take() } catch (_: InterruptedException) { continue }
            if (it.epoch != epoch.get()) continue
            try {
                val clip = if (it.text == null) {
                    // a pause: made by the player at the voice's own rate. (Made here at a fixed 24 kHz, every pause
                    // in a 22 kHz Piper voice closed and reopened the speaker, which broke Piper voices.)
                    Clip(it.id, FloatArray(0), 0, it.epoch, silenceMs = it.silenceMs.coerceAtLeast(1))
                } else {
                    val v = voice ?: throw Exception("No voice")
                    val (m, sid) = NeuralVoices.parse(v) ?: throw Exception("Unknown voice")
                    if (!NeuralVoices.installed(ctx, m)) throw Exception("This voice isn't downloaded yet")
                    val (samples, rate) = NeuralVoices.gen(ctx, m, it.text, sid, it.speed.coerceIn(0.5f, 2.5f))
                    Clip(it.id, samples, rate, it.epoch)
                }
                while (alive && it.epoch == epoch.get() && !ready.offer(clip, 200, java.util.concurrent.TimeUnit.MILLISECONDS)) { /* wait for room */ }
            } catch (t: Throwable) {
                if (it.epoch == epoch.get()) main.post { onError(it.id, t.message ?: "error") }
            }
        }
    }, "neural-maker")

    private val player = Thread({
        while (alive) {
            val c = try { ready.take() } catch (_: InterruptedException) { continue }
            if (c.epoch != epoch.get() || (c.samples.isEmpty() && c.silenceMs <= 0)) { if (c.epoch == epoch.get()) main.post { if (c.epoch == epoch.get()) { onStart(c.id); onDone(c.id) } }; continue }
            main.post { if (c.epoch == epoch.get()) onStart(c.id) }
            // Android can invalidate an audio track at any time (audio server restart, output change, …).
            // Then every call on it throws, so drop it, open a fresh one and try the sentence once more.
            var err: Throwable? = null
            for (attempt in 0..1) {
                err = try { playClip(c); null } catch (_: InterruptedException) { null } catch (t: Throwable) { dropTrack(); t }
                if (err == null || !alive || c.epoch != epoch.get()) break
            }
            val failure = err
            if (c.epoch == epoch.get()) main.post {
                if (c.epoch != epoch.get()) return@post
                if (failure != null) onError(c.id, "The speaker stopped working: ${failure.message ?: failure.javaClass.simpleName}") else onDone(c.id)
            }
        }
        // only this thread writes to the track, so only it releases it (releasing mid-write crashes)
        dropTrack()
    }, "neural-player")

    /** Plays one clip and returns once it has actually been heard (or was cut short by stop()). */
    private fun playClip(c: Clip) {
        val open = synchronized(this) { trackRate }
        // a pause before anything has played: just wait, rather than open the speaker at a rate the voice may not use
        if (c.silenceMs > 0 && open == 0) { Thread.sleep(c.silenceMs); return }
        val rate = if (c.silenceMs > 0) open else c.rate
        val samples = if (c.silenceMs > 0) FloatArray((rate * c.silenceMs / 1000).toInt()) else c.samples
        val t = trackFor(rate)
        val start = t.playbackHeadPosition.toLong() and 0xffffffffL
        var off = 0
        while (off < samples.size && c.epoch == epoch.get()) {
            val n = t.write(samples, off, minOf(4096, samples.size - off), AudioTrack.WRITE_BLOCKING)
            if (n < 0) throw IllegalStateException("audio write failed ($n)")
            if (n == 0) break
            off += n
        }
        // wait until it has been heard; give up if the sound stops moving (so a stuck track can't hang reading)
        val endFrame = start + off - rate / 50
        var last = -1L; var stuckSince = System.currentTimeMillis()
        while (alive && c.epoch == epoch.get()) {
            val pos = t.playbackHeadPosition.toLong() and 0xffffffffL
            if (pos >= endFrame) break
            val now = System.currentTimeMillis()
            if (pos != last) { last = pos; stuckSince = now } else if (now - stuckSince > 3000) throw IllegalStateException("audio stopped playing")
            Thread.sleep(15)
        }
    }

    @Synchronized
    private fun dropTrack() {
        try { track?.release() } catch (_: Throwable) {}
        track = null; trackRate = 0
    }

    init { maker.start(); player.start() }

    @Synchronized
    private fun trackFor(rate: Int): AudioTrack {
        val cur = track
        if (cur != null && trackRate == rate) return cur
        try { cur?.release() } catch (_: Throwable) {}
        track = null; trackRate = 0
        val min = AudioTrack.getMinBufferSize(rate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_FLOAT)
        val t = AudioTrack.Builder()
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_FLOAT).setSampleRate(rate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
            .setTransferMode(AudioTrack.MODE_STREAM)
            // about a quarter second, in whole 4-byte float samples: Android rejects any other size, and at
            // Piper's 22,050 Hz a plain quarter second (22,050 bytes) isn't one, so every Piper sentence failed
            .setBufferSizeInBytes((maxOf(min, rate) + 3) / 4 * 4)
            .build()
        if (t.state != AudioTrack.STATE_INITIALIZED) { try { t.release() } catch (_: Throwable) {}; throw IllegalStateException("couldn't open the speaker") }
        t.play()
        track = t; trackRate = rate; tracksOpened++
        return t
    }

    fun speak(text: String, flush: Boolean, id: String, speed: Float) {
        if (flush) stop()
        todo.add(Item(id, text, 0, speed, epoch.get()))
    }

    fun silence(ms: Long, id: String) { todo.add(Item(id, null, ms, 1f, epoch.get())) }

    /** Drops everything queued and stops the sound right away. */
    fun stop() {
        epoch.incrementAndGet()
        todo.clear(); ready.clear()
        synchronized(this) { track?.let { try { it.pause(); it.flush(); it.play() } catch (_: Throwable) {} } }
    }

    fun shutdown() {
        alive = false
        stop()
        maker.interrupt(); player.interrupt()
    }
}
