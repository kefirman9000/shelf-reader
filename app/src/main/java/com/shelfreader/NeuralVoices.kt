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
        Model("kokoro-en-v0_19", "Kokoro (most natural, English)", "kokoro", 305, "en", "model.onnx", listOf(
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

    fun isNeural(voice: String?) = voice?.startsWith("neural:") == true
    fun key(m: Model, sid: Int) = "neural:${m.id}:$sid"
    fun parse(voice: String?): Pair<Model, Int>? {
        if (!isNeural(voice)) return null
        val parts = voice!!.split(":")
        val m = MODELS.firstOrNull { it.id == parts.getOrNull(1) } ?: return null
        return m to (parts.getOrNull(2)?.toIntOrNull() ?: 0)
    }
    fun label(voice: String?): String? = parse(voice)?.let { (m, sid) -> m.voices.firstOrNull { it.first == sid }?.second ?: m.title }

    fun dir(ctx: Context, m: Model) = File(ctx.getExternalFilesDir(null) ?: ctx.filesDir, "voices/${m.id}")
    fun installed(ctx: Context, m: Model) = File(dir(ctx, m), ".done").exists()

    /** Downloads and unpacks a voice model. progress(done, total) in bytes. Runs on a background thread. */
    fun download(ctx: Context, m: Model, progress: (Long, Long) -> Unit) {
        val root = dir(ctx, m).parentFile!!.apply { mkdirs() }
        val tmp = File(root, "${m.id}.tar.bz2")
        Net.download(BASE + m.id + ".tar.bz2", tmp, emptyMap(), progress)
        val target = dir(ctx, m)
        target.deleteRecursively()
        try {
            TarArchiveInputStream(BZip2CompressorInputStream(BufferedInputStream(tmp.inputStream(), 1 shl 16))).use { tar ->
                while (true) {
                    val e = tar.nextEntry ?: break
                    // archives hold one top folder named like the model; strip it and refuse odd paths
                    val rel = e.name.substringAfter('/', "")
                    if (rel.isEmpty() || rel.contains("..")) continue
                    val out = File(target, rel)
                    if (e.isDirectory) { out.mkdirs(); continue }
                    out.parentFile?.mkdirs()
                    out.outputStream().use { tar.copyTo(it) }
                }
            }
            File(target, ".done").writeText("ok")
        } finally { tmp.delete() }
    }

    fun remove(ctx: Context, m: Model) { dir(ctx, m).deleteRecursively() }

    // one loaded model at a time (they're large)
    private var loadedId: String? = null
    private var loaded: OfflineTts? = null

    @Synchronized
    fun engine(ctx: Context, m: Model): OfflineTts {
        if (loadedId == m.id && loaded != null) return loaded!!
        loaded?.release(); loaded = null; loadedId = null
        val d = dir(ctx, m)
        val threads = Runtime.getRuntime().availableProcessors().coerceIn(2, 4)
        val model = if (m.kind == "kokoro") OfflineTtsModelConfig(
            kokoro = OfflineTtsKokoroModelConfig(model = "$d/${m.file}", voices = "$d/voices.bin", tokens = "$d/tokens.txt", dataDir = "$d/espeak-ng-data"),
            numThreads = threads, provider = "cpu")
        else OfflineTtsModelConfig(
            vits = OfflineTtsVitsModelConfig(model = "$d/${m.file}", tokens = "$d/tokens.txt", dataDir = "$d/espeak-ng-data"),
            numThreads = threads, provider = "cpu")
        val t = OfflineTts(config = OfflineTtsConfig(model = model, maxNumSentences = 1))
        loaded = t; loadedId = m.id
        return t
    }

    @Synchronized
    fun release() { loaded?.release(); loaded = null; loadedId = null }

    /** One generation at a time: the playback queue, previews and clips share the loaded model. */
    @Synchronized
    fun gen(ctx: Context, m: Model, text: String, sid: Int, speed: Float): Pair<FloatArray, Int> {
        val a = engine(ctx, m).generate(text, sid, speed)
        return a.samples to a.sampleRate
    }

    /** Makes audio for a short text (for previews and clips). */
    fun generate(ctx: Context, voice: String, text: String, speed: Float): Pair<FloatArray, Int>? {
        val (m, sid) = parse(voice) ?: return null
        if (!installed(ctx, m)) return null
        return gen(ctx, m, text, sid, speed)
    }

    /** Plays a short sample (preview). */
    fun playOnce(samples: FloatArray, rate: Int) {
        val t = AudioTrack.Builder()
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_FLOAT).setSampleRate(rate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
            .setTransferMode(AudioTrack.MODE_STATIC)
            .setBufferSizeInBytes(maxOf(samples.size * 4, 4096))
            .build()
        t.write(samples, 0, samples.size, AudioTrack.WRITE_BLOCKING)
        t.play()
        Thread { Thread.sleep(samples.size * 1000L / rate + 300); try { t.release() } catch (_: Throwable) {} }.start()
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
    private class Clip(val id: String, val samples: FloatArray, val rate: Int, val epoch: Int)

    private val main = Handler(Looper.getMainLooper())
    private val epoch = AtomicInteger(0)
    private val todo = LinkedBlockingDeque<Item>()
    private val ready = LinkedBlockingDeque<Clip>(3)
    @Volatile var voice: String? = null
    @Volatile private var alive = true
    private var track: AudioTrack? = null
    private var trackRate = 0

    private val maker = Thread({
        while (alive) {
            val it = try { todo.take() } catch (_: InterruptedException) { continue }
            if (it.epoch != epoch.get()) continue
            try {
                val clip = if (it.text == null) {
                    Clip(it.id, FloatArray((trackRate.takeIf { r -> r > 0 } ?: 24000) * it.silenceMs.toInt() / 1000), trackRate.takeIf { r -> r > 0 } ?: 24000, it.epoch)
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
            if (c.epoch != epoch.get()) continue
            val t = trackFor(c.rate)
            main.post { if (c.epoch == epoch.get()) onStart(c.id) }
            val start = t.playbackHeadPosition.toLong() and 0xffffffffL
            var off = 0
            while (off < c.samples.size && c.epoch == epoch.get()) {
                val n = t.write(c.samples, off, minOf(4096, c.samples.size - off), AudioTrack.WRITE_BLOCKING)
                if (n <= 0) break
                off += n
            }
            // wait until it has actually been heard
            val endFrame = start + off
            while (alive && c.epoch == epoch.get() && (t.playbackHeadPosition.toLong() and 0xffffffffL) < endFrame - c.rate / 50) Thread.sleep(15)
            if (c.epoch == epoch.get()) main.post { if (c.epoch == epoch.get()) onDone(c.id) }
        }
    }, "neural-player")

    init { maker.start(); player.start() }

    @Synchronized
    private fun trackFor(rate: Int): AudioTrack {
        val cur = track
        if (cur != null && trackRate == rate) return cur
        cur?.release()
        val min = AudioTrack.getMinBufferSize(rate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_FLOAT)
        val t = AudioTrack.Builder()
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_FLOAT).setSampleRate(rate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
            .setTransferMode(AudioTrack.MODE_STREAM)
            .setBufferSizeInBytes(maxOf(min, rate * 4 / 4))
            .build()
        t.play()
        track = t; trackRate = rate
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
        synchronized(this) { track?.release(); track = null }
    }
}
