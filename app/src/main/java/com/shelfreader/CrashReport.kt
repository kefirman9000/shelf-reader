package com.shelfreader

import android.app.Activity
import android.app.ActivityManager
import android.app.AlertDialog
import android.app.ApplicationExitInfo
import android.content.Context
import android.content.Intent
import android.os.Build
import java.io.File

/**
 * When the app closes unexpectedly, the next launch says so and offers to share a report.
 * Covers Kotlin crashes (saved as they happen), and on Android 11+ also native crashes, "not responding"
 * and being closed for memory, which Android reports afterwards. Natural voices mark when they're
 * busy in native code, so a crash there is recognised and they switch to a gentler mode.
 */
object CrashReport {
    private var installed = false
    private var checked = false

    private fun prefs(ctx: Context) = ctx.getSharedPreferences("crash", Context.MODE_PRIVATE)
    private fun crashFile(ctx: Context) = File(ctx.filesDir, "last-crash.txt")
    private fun busyFile(ctx: Context) = File(ctx.filesDir, "neural-busy")

    /** Natural voices use 1 thread and shorter pieces after they've crashed once. */
    fun safeVoices(ctx: Context): Boolean {
        val p = prefs(ctx)
        // Up to 1.0.35, any crash while a voice was working turned this on, including crashes that had
        // nothing to do with the voice engine. Clear it once; a real voice crash turns it back on.
        if (!p.getBoolean("safeVoicesReset1", false)) p.edit().putBoolean("safeVoicesReset1", true).putBoolean("safeVoices", false).apply()
        return p.getBoolean("safeVoices", false)
    }

    fun install(ctx: Context) {
        if (installed) return
        installed = true
        val app = ctx.applicationContext
        val prev = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { t, e ->
            try {
                val busy = try { busyFile(app).readText() } catch (_: Throwable) { "" }
                crashFile(app).writeText("Recent events:\n" + eventLog(app).takeLast(3000) + "\n\nThread: ${t.name}\n" + (if (busy.isNotBlank()) "Natural voice busy: $busy\n" else "") + e.stackTraceToString().take(12_000))
                // This crash has its own stack trace, so it isn't the voice engine dying in native code.
                // Clear the marker so the next launch doesn't blame the voice and slow it down.
                busyFile(app).delete()
            } catch (_: Throwable) {}
            prev?.uncaughtException(t, e)
        }
    }

    /** Marks that a natural voice is in native code (what = "load kokoro-…"), or done (null). */
    fun busy(ctx: Context, what: String?) {
        try {
            val f = busyFile(ctx)
            if (what == null) f.delete() else f.writeText("${android.os.Process.myPid()}|$what|${System.currentTimeMillis()}")
        } catch (_: Throwable) {}
    }

    /** Call when the app opens: shows what happened last time, once. */
    fun check(a: Activity) {
        if (checked) return
        checked = true
        val ctx = a.applicationContext
        val parts = ArrayList<String>()
        var voiceCrash: String? = null
        var marker: String? = null   // a natural voice was busy when the app last went away

        // a natural voice was busy in a process that's gone: it went down with it
        try {
            val f = busyFile(ctx)
            if (f.exists()) {
                val (pid, what) = f.readText().split("|").let { (it.getOrNull(0)?.toIntOrNull() ?: 0) to (it.getOrNull(1) ?: "") }
                if (pid != android.os.Process.myPid()) marker = what
                f.delete()
            }
        } catch (_: Throwable) {}

        try { crashFile(ctx).takeIf { it.exists() }?.let { parts += it.readText(); it.delete() } } catch (_: Throwable) {}

        if (Build.VERSION.SDK_INT >= 30) try {
            val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            val seen = prefs(ctx).getLong("exitSeen", 0)
            val recent = System.currentTimeMillis() - 3L * 24 * 3600 * 1000
            val bad = setOf(ApplicationExitInfo.REASON_CRASH, ApplicationExitInfo.REASON_CRASH_NATIVE, ApplicationExitInfo.REASON_ANR,
                ApplicationExitInfo.REASON_LOW_MEMORY, ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE, ApplicationExitInfo.REASON_INITIALIZATION_FAILURE)
            val exits = am.getHistoricalProcessExitReasons(ctx.packageName, 0, 5)
            exits.maxOfOrNull { it.timestamp }?.let { prefs(ctx).edit().putLong("exitSeen", maxOf(seen, it)).apply() }
            val e = exits.firstOrNull { it.timestamp > maxOf(seen, recent) && (it.reason in bad || (marker != null && it.reason == ApplicationExitInfo.REASON_SIGNALED)) }
            // only count the marker when Android confirms the app really died (not just swiped away)
            if (e != null && marker != null) { voiceCrash = marker; parts.add(0, "Natural voice was busy: $marker") }
            marker = null
            if (e != null) {
                parts += "Android says: ${reasonName(e.reason)} (${e.description ?: "no details"}), memory used ${e.pss / 1024} MB, " +
                    java.text.DateFormat.getDateTimeInstance().format(java.util.Date(e.timestamp))
                if (e.reason == ApplicationExitInfo.REASON_CRASH_NATIVE || e.reason == ApplicationExitInfo.REASON_ANR) {
                    try { e.traceInputStream?.use { s -> parts += readable(s.readBytes(), if (e.reason == ApplicationExitInfo.REASON_ANR) 6000 else 8000) } } catch (_: Throwable) {}
                }
                if (voiceCrash == null && (e.reason == ApplicationExitInfo.REASON_CRASH_NATIVE || e.reason == ApplicationExitInfo.REASON_LOW_MEMORY)) {
                    val trace = parts.joinToString("\n")
                    if (trace.contains("onnx", true) || trace.contains("sherpa", true) || trace.contains("neural", true)) voiceCrash = "natural voice"
                }
            }
        } catch (_: Throwable) {}

        if (marker != null) { voiceCrash = marker; parts.add(0, "Natural voice was busy: $marker") }   // older Android: no exit reasons to check
        if (parts.isEmpty()) return
        if (voiceCrash != null) prefs(ctx).edit().putBoolean("safeVoices", true).apply()
        val report = "Shelf Reader ${try { a.packageManager.getPackageInfo(a.packageName, 0).versionName } catch (_: Throwable) { "" }} · " +
            "Android ${Build.VERSION.RELEASE} · ${Build.MANUFACTURER} ${Build.MODEL} · ${Build.SUPPORTED_ABIS.joinToString()}\n\n" + parts.joinToString("\n\n")
        val msg = if (voiceCrash != null)
            "It happened while a natural voice was working. Natural voices now run in a gentler mode (slower to start, lighter on the phone). If it happens again, try a Piper voice.\n\nYou can send the report so it can be fixed."
        else "You can send a report so it can be fixed."
        a.window.decorView.post {
            if (a.isFinishing || a.isDestroyed) return@post
            AlertDialog.Builder(a).setTitle("Shelf Reader closed unexpectedly last time").setMessage(msg)
                .setPositiveButton("Send report") { _, _ ->
                    try {
                        a.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain")
                            .putExtra(Intent.EXTRA_SUBJECT, "Shelf Reader crash report").putExtra(Intent.EXTRA_TEXT, report), "Send report"))
                    } catch (_: Throwable) {}
                }
                .setNeutralButton("Copy") { _, _ ->
                    val cm = a.getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                    cm.setPrimaryClip(android.content.ClipData.newPlainText("Shelf Reader crash report", report)); a.toast("Report copied")
                }
                .setNegativeButton("Not now", null).show()
        }
    }

    // ---------- event log and "Report a problem" ----------
    private val events = ArrayDeque<String>()
    private val tf = java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US)

    /** Remembers something worth knowing if a problem is reported (stalls, voice errors, skips). Last 60 kept. */
    fun note(ctx: Context?, msg: String) {
        val line = tf.format(java.util.Date()) + " " + msg.take(300)
        synchronized(events) { events.addLast(line); while (events.size > 60) events.removeFirst() }
        android.util.Log.i("ShelfReader", msg)
        if (ctx != null) try { File(ctx.filesDir, "events.txt").writeText(synchronized(events) { events.joinToString("\n") }) } catch (_: Throwable) {}
    }

    private fun eventLog(ctx: Context): String {
        val mem = synchronized(events) { events.joinToString("\n") }
        if (mem.isNotBlank()) return mem
        return try { File(ctx.filesDir, "events.txt").readText() } catch (_: Throwable) { "" }
    }

    /** Everything needed to reproduce a problem: app, phone, book, where it was, the sentence, voice, settings, recent events. */
    fun problemReport(ctx: Context, what: String): String {
        val s = TtsService.instance
        val sb = StringBuilder()
        sb.append("Shelf Reader ").append(try { ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName } catch (_: Throwable) { "" })
            .append(" · Android ${Build.VERSION.RELEASE} · ${Build.MANUFACTURER} ${Build.MODEL}\n\n")
        sb.append("What happened: ").append(what.ifBlank { "(not described)" }).append("\n\n")
        if (s != null) sb.append(s.diagnostics()).append("\n")
        sb.append("Settings: natural pauses ${Settings.naturalPauses(ctx)}, say numbers ${Settings.speakNumbers(ctx)}, " +
            "fix broken lines ${Settings.fixBrokenLines(ctx)}, skip clutter ${Settings.skipClutter(ctx)}, gentle voices ${safeVoices(ctx)}, background sounds ${Ambience.summary(ctx)}\n\n")
        sb.append("Recent events:\n").append(eventLog(ctx).ifBlank { "(none)" })
        return sb.toString()
    }

    /** Asks what went wrong, then shares the report. */
    fun reportProblem(a: Activity) {
        val box = android.widget.EditText(a).apply { hint = "What went wrong? (e.g. it stopped reading here)"; minLines = 2 }
        val pad = android.widget.FrameLayout(a).apply { setPadding(48, 16, 48, 0); addView(box) }
        AlertDialog.Builder(a).setTitle("Report a problem")
            .setMessage("Makes a report with the book's name, the sentence it's on, the voice and settings, and what the app did recently. Nothing is sent until you choose where.")
            .setView(pad)
            .setPositiveButton("Share report") { _, _ ->
                val r = problemReport(a, box.text.toString())
                try { a.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain")
                    .putExtra(Intent.EXTRA_SUBJECT, "Shelf Reader problem report").putExtra(Intent.EXTRA_TEXT, r), "Send report")) } catch (_: Throwable) {}
            }
            .setNeutralButton("Copy") { _, _ ->
                val cm = a.getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                cm.setPrimaryClip(android.content.ClipData.newPlainText("Shelf Reader report", problemReport(a, box.text.toString()))); a.toast("Report copied")
            }
            .setNegativeButton("Cancel", null).show()
    }

    private fun reasonName(r: Int) = when (r) {
        ApplicationExitInfo.REASON_CRASH -> "crash"
        ApplicationExitInfo.REASON_CRASH_NATIVE -> "native crash"
        ApplicationExitInfo.REASON_ANR -> "not responding"
        ApplicationExitInfo.REASON_LOW_MEMORY -> "closed for memory"
        ApplicationExitInfo.REASON_SIGNALED -> "stopped by the system"
        ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "used too much"
        ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> "failed to start"
        else -> "reason $r"
    }

    /** Readable text from a trace (ANR traces are text; native ones are a binary record with readable names inside). */
    private fun readable(b: ByteArray, max: Int): String {
        val sb = StringBuilder(); val cur = StringBuilder()
        for (x in b) {
            val c = x.toInt() and 0xff
            if (c in 32..126 || c == 10) cur.append(c.toChar())
            else { if (cur.length >= 5) sb.append(cur).append('\n'); cur.setLength(0) }
            if (sb.length > max) break
        }
        if (cur.length >= 5) sb.append(cur)
        return sb.toString().take(max)
    }
}
