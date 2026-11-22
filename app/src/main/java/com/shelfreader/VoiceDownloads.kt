package com.shelfreader

import android.content.Context
import android.os.Handler
import android.os.Looper
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArraySet

/**
 * Natural-voice downloads that belong to the app, not to a screen: they keep going if the screen turns,
 * the voice list is closed or you leave the book, and anything showing progress just listens in.
 * (Before, a finished download tried to update a pop-up that was already gone, which closed the app.)
 */
object VoiceDownloads {
    class State { @Volatile var done = 0L; @Volatile var total = 0L; @Volatile var unpacking = false }

    private val running = ConcurrentHashMap<String, State>()
    private val failed = ConcurrentHashMap<String, String>()
    private val listeners = CopyOnWriteArraySet<() -> Unit>()
    private val main = Handler(Looper.getMainLooper())

    fun state(id: String): State? = running[id]

    // ---------- waiting for Wi-Fi ----------
    private val waitingFor = ConcurrentHashMap<String, Pair<NeuralVoices.Model, (() -> Unit)?>>()
    private var wifiCallback: android.net.ConnectivityManager.NetworkCallback? = null

    fun waiting(id: String) = waitingFor.containsKey(id)
    fun cancelWaiting(id: String) { waitingFor.remove(id); changed() }

    /** True when the phone's internet is metered (mobile data or a metered hotspot). */
    fun onMobileData(ctx: Context): Boolean = try {
        (ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as android.net.ConnectivityManager).isActiveNetworkMetered
    } catch (_: Throwable) { false }

    /** Downloads [m] as soon as the phone is on Wi-Fi (or another unmetered network). */
    fun startOnWifi(ctx: Context, m: NeuralVoices.Model, then: (() -> Unit)? = null) {
        val app = ctx.applicationContext
        waitingFor[m.id] = m to then
        changed()
        synchronized(this) {
            if (wifiCallback != null) return
            val cm = app.getSystemService(Context.CONNECTIVITY_SERVICE) as android.net.ConnectivityManager
            val cb = object : android.net.ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: android.net.Network) {
                    main.post {
                        val all = waitingFor.values.toList(); waitingFor.clear()
                        for ((mm, t) in all) start(app, mm, t)
                        synchronized(this@VoiceDownloads) { try { cm.unregisterNetworkCallback(this) } catch (_: Throwable) {}; wifiCallback = null }
                        changed()
                    }
                }
            }
            val req = android.net.NetworkRequest.Builder()
                .addCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .addCapability(android.net.NetworkCapabilities.NET_CAPABILITY_NOT_METERED).build()
            try { cm.registerNetworkCallback(req, cb); wifiCallback = cb } catch (t: Throwable) { app.toast("Couldn't wait for Wi-Fi: ${t.message}") }
        }
    }
    /** The last failure for a voice, shown once. */
    fun takeError(id: String): String? = failed.remove(id)

    /** Calls [l] on the main thread whenever a download moves on. Returns a function that stops listening. */
    fun listen(l: () -> Unit): () -> Unit { listeners += l; return { listeners -= l } }
    private fun changed() = main.post { for (l in listeners) try { l() } catch (_: Throwable) {} }

    /** Starts downloading [m] (if it isn't already); [then] runs on the main thread once it's ready. */
    fun start(ctx: Context, m: NeuralVoices.Model, then: (() -> Unit)? = null) {
        val app = ctx.applicationContext
        if (NeuralVoices.installed(app, m)) { then?.let { main.post(it) }; return }
        val st = State()
        if (running.putIfAbsent(m.id, st) != null) return
        failed.remove(m.id)
        changed()
        Thread({
            val pm = app.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
            val wake = pm.newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "ShelfReader:voice").apply { setReferenceCounted(false) }
            try {
                wake.acquire(15 * 60 * 1000L)
                NeuralVoices.download(app, m, onUnpack = { st.unpacking = true; changed() }) { d, t -> st.done = d; st.total = t; changed() }
                running.remove(m.id)
                main.post {
                    changed()
                    app.toast("${m.title} is downloaded.")
                    try { then?.invoke() } catch (_: Throwable) {}
                }
            } catch (t: Throwable) {
                running.remove(m.id)
                failed[m.id] = t.message ?: "error"
                main.post { changed(); app.toast("Couldn't download ${m.title}: ${t.message ?: "error"}. Check your internet and try again.") }
            } finally {
                try { if (wake.isHeld) wake.release() } catch (_: Throwable) {}
            }
        }, "voice-download").start()
    }
}
