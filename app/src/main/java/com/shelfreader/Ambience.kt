package com.shelfreader

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack

/**
 * Plays the background sounds you've chosen (rain, waves, fire…) under the voice while a book is read.
 * They fade in when reading starts and fade out when it pauses, stops or the sleep timer ends.
 * While the Background sounds screen is open they also play, so you can hear the mix as you set it.
 */
object Ambience {
    private const val SR = 32000
    private fun p(ctx: Context) = ctx.getSharedPreferences("ambience", Context.MODE_PRIVATE)

    // ---------- settings ----------

    fun on(ctx: Context) = p(ctx).getBoolean("on", false)
    fun setOn(ctx: Context, v: Boolean) { p(ctx).edit().putBoolean("on", v).apply(); refresh(ctx) }
    /** Overall volume of the sounds, 0–1 (the voice isn't changed). */
    fun volume(ctx: Context) = p(ctx).getFloat("volume", 0.6f)
    fun setVolume(ctx: Context, v: Float) { p(ctx).edit().putFloat("volume", v.coerceIn(0f, 1f)).apply(); refresh(ctx) }

    /** Sound id → its volume 0–1, in the order they were added. */
    fun mix(ctx: Context): LinkedHashMap<String, Float> {
        val out = LinkedHashMap<String, Float>()
        val known = AmbienceSynth.SOUNDS.map { it.id }.toSet()
        for (part in (p(ctx).getString("mix", "") ?: "").split(',')) {
            val (id, v) = part.split('=').let { (it.getOrNull(0) ?: "") to (it.getOrNull(1)?.toFloatOrNull() ?: -1f) }
            if (id in known && v >= 0f) out[id] = v.coerceIn(0f, 1f)
        }
        return out
    }
    fun setMix(ctx: Context, m: Map<String, Float>) {
        p(ctx).edit().putString("mix", m.entries.joinToString(",") { "${it.key}=${"%.2f".format(java.util.Locale.US, it.value)}" }).apply()
        refresh(ctx)
    }

    /** Short description for menus: "Rain, Ocean waves" or "Off". */
    fun summary(ctx: Context): String {
        val m = mix(ctx).filterValues { it > 0f }
        if (!on(ctx) || m.isEmpty()) return "Off"
        return m.keys.mapNotNull { id -> AmbienceSynth.SOUNDS.firstOrNull { it.id == id }?.name }.joinToString(", ")
    }

    // ---------- playing ----------

    @Volatile private var reading = false
    @Volatile private var previewing = false
    private val mixer = AmbienceSynth.Mixer(SR)
    private var thread: Thread? = null
    private val lock = Any()

    /** The reader started or stopped speaking. */
    fun reading(ctx: Context, playing: Boolean) { reading = playing; refresh(ctx) }
    /** The Background sounds screen opened or closed. */
    fun previewing(ctx: Context, open: Boolean) { previewing = open; refresh(ctx) }

    fun refresh(ctx: Context) {
        val app = ctx.applicationContext
        val m = mix(app)
        val want = on(app) && m.values.any { it > 0f } && (reading || previewing)
        mixer.set(if (want) m else emptyMap(), if (want) volume(app) else 0f)
        if (want) ensureThread()
    }

    private fun ensureThread() = synchronized(lock) {
        if (thread?.isAlive == true) return@synchronized
        thread = Thread({ loop() }, "ambience").apply { start() }
    }

    private fun loop() {
        try { android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_AUDIO) } catch (_: Throwable) {}
        var track: AudioTrack? = null
        try {
            val min = AudioTrack.getMinBufferSize(SR, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_FLOAT)
            track = AudioTrack.Builder()
                .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
                .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_FLOAT).setSampleRate(SR).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                .setTransferMode(AudioTrack.MODE_STREAM)
                .setBufferSizeInBytes(maxOf(min, SR / 5 * 4))
                .build()
            track.play()
            val buf = FloatArray(SR / 20)
            while (true) {
                mixer.render(buf)
                if (track.write(buf, 0, buf.size, AudioTrack.WRITE_BLOCKING) < 0) break
                // stop once faded all the way out (a new start makes a new thread)
                if (mixer.silent()) synchronized(lock) { if (mixer.silent()) { thread = null; return } }
            }
        } catch (t: Throwable) {
            CrashReport.note(null, "Background sounds stopped: ${t.message}")
        } finally {
            try { track?.stop() } catch (_: Throwable) {}
            try { track?.release() } catch (_: Throwable) {}
            synchronized(lock) { if (thread === Thread.currentThread()) thread = null }
        }
    }
}
