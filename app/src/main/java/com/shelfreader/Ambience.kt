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

    /** Heartbeat speed, beats a minute. */
    fun heartBpm(ctx: Context) = p(ctx).getInt("heartBpm", AmbienceSynth.HEART_DEF)
    fun setHeartBpm(ctx: Context, v: Int) { p(ctx).edit().putInt("heartBpm", v.coerceIn(AmbienceSynth.HEART_MIN, AmbienceSynth.HEART_MAX)).apply(); refresh(ctx) }

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

    /** Mixes you saved, by name, in the order you saved them. */
    fun saved(ctx: Context): List<Pair<String, Map<String, Float>>> =
        (p(ctx).getString("saved", "") ?: "").split('\n').filter { '\t' in it }.map { line ->
            val (name, mix) = line.split('\t', limit = 2)
            name to mix.split(',').mapNotNull { e -> e.split('=').takeIf { it.size == 2 }?.let { (k, v) -> v.toFloatOrNull()?.let { k to it.coerceIn(0f, 1f) } } }.toMap()
        }
    fun saveMix(ctx: Context, name: String, m: Map<String, Float>) {
        val n = name.replace(Regex("[\\t\\n]"), " ").trim().take(40).ifBlank { "My mix" }
        val list = saved(ctx).filter { it.first != n } + (n to m)
        p(ctx).edit().putString("saved", list.joinToString("\n") { (k, v) -> k + "\t" + v.entries.joinToString(",") { "${it.key}=${"%.2f".format(java.util.Locale.US, it.value)}" } }).apply()
    }
    fun deleteMix(ctx: Context, name: String) {
        val list = saved(ctx).filter { it.first != name }
        p(ctx).edit().putString("saved", list.joinToString("\n") { (k, v) -> k + "\t" + v.entries.joinToString(",") { "${it.key}=${"%.2f".format(java.util.Locale.US, it.value)}" } }).apply()
    }

    /**
     * When the book stops by itself (sleep timer or the end of the book), keep the sounds going for this
     * many minutes: 0 = stop with the book, -1 = until you press pause.
     */
    fun keepAfter(ctx: Context) = p(ctx).getInt("keepAfter", 0)
    fun setKeepAfter(ctx: Context, v: Int) { p(ctx).edit().putInt("keepAfter", v).apply() }
    fun keepAfterText(m: Int) = when { m == 0 -> "Stop with the book"; m < 0 -> "Keep playing until I press pause"; else -> "Keep playing $m more minutes" }

    // ---------- playing ----------
    // Sounds play when any of these is true, and pressing pause anywhere (player, notification,
    // headphones, lock screen) stops all of them:
    //   reading    – a book is being read (and "Play while reading" is on)
    //   lingering  – the book stopped by itself a little while ago (see keepAfter)
    //   previewing – the Background sounds screen is on screen
    //   solo       – you pressed "Play sounds" to hear them without a book

    @Volatile private var reading = false
    @Volatile private var previewing = false
    @Volatile private var solo = false
    @Volatile private var muted = false            // "Pause sounds" while a book keeps reading
    @Volatile private var lingerUntil = 0L         // elapsedRealtime; Long.MAX_VALUE = until paused
    private val mixer = AmbienceSynth.Mixer(SR)
    private var thread: Thread? = null
    private val lock = Any()
    private val main = android.os.Handler(android.os.Looper.getMainLooper())
    /** Told whenever the sounds start or stop (the player's notification, the sounds screen). */
    val listeners = java.util.concurrent.CopyOnWriteArrayList<() -> Unit>()

    private fun lingering() = lingerUntil > android.os.SystemClock.elapsedRealtime()
    val isSolo get() = solo

    /** True when sounds are playing (or about to) right now. */
    fun audible(ctx: Context): Boolean {
        val app = ctx.applicationContext
        if (muted || mix(app).values.none { it > 0f }) return false
        return (on(app) && (reading || lingering())) || previewing || solo
    }
    /** Sounds are playing without a book being read (on their own, or after the book stopped). */
    fun withoutBook(ctx: Context) = !reading && audible(ctx)

    /** The reader started or stopped speaking (stopping by itself: see [bookStopped]). */
    fun reading(ctx: Context, playing: Boolean) {
        reading = playing
        if (playing) { muted = false; lingerUntil = 0L; solo = false }
        refresh(ctx)
    }

    /** Pause was pressed: every sound stops (and stays off until something is played again). */
    fun hush(ctx: Context) {
        reading = false; previewing = false; solo = false; lingerUntil = 0L
        main.removeCallbacks(lingerEnd)
        refresh(ctx)
    }

    /** The book stopped by itself (sleep timer, end of the book): keep the sounds going if that's chosen. */
    fun bookStopped(ctx: Context) {
        reading = false
        val m = keepAfter(ctx)
        main.removeCallbacks(lingerEnd)
        lingerUntil = when {
            m == 0 || !on(ctx) -> 0L
            m < 0 -> Long.MAX_VALUE
            else -> android.os.SystemClock.elapsedRealtime() + m * 60_000L
        }
        if (m > 0) { lingerCtx = ctx.applicationContext; main.postDelayed(lingerEnd, m * 60_000L + 500) }
        refresh(ctx)
    }
    private var lingerCtx: Context? = null
    private val lingerEnd = Runnable { lingerCtx?.let { refresh(it) } }

    /** Play the sounds on their own (no book), or stop them. */
    fun setSolo(ctx: Context, v: Boolean) {
        solo = v
        if (v) muted = false
        refresh(ctx)
    }
    /** "Pause sounds" on the sounds screen while a book keeps reading. */
    fun mute(ctx: Context) { muted = true; previewing = false; solo = false; lingerUntil = 0L; refresh(ctx) }
    fun unmute(ctx: Context) { muted = false; refresh(ctx) }

    /** The Background sounds screen came on screen or went away. */
    fun previewing(ctx: Context, open: Boolean) { previewing = open; if (open) muted = false; refresh(ctx) }

    fun refresh(ctx: Context) {
        val app = ctx.applicationContext
        val want = audible(app)
        mixer.params.heartBpm = heartBpm(app).toDouble()
        mixer.set(if (want) mix(app) else emptyMap(), if (want) volume(app) else 0f)
        if (want) ensureThread()
        if (listeners.isNotEmpty()) main.post { for (cb in listeners) try { cb() } catch (_: Throwable) {} }
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
