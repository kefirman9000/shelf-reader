package com.shelfreader

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.provider.DocumentsContract
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Renders chapters to .m4a audio files in a folder the user picked. */
class ExportService : Service() {

    companion object {
        const val ACTION_CANCEL = "com.shelfreader.EXPORT_CANCEL"
        private const val CH = "export"
        private const val NID = 2
        private const val NID_DONE = 3
        @Volatile var running = false
    }

    private class Cancelled : Exception("cancelled")

    @Volatile private var cancelled = false
    private var tts: TextToSpeech? = null
    private val latches = ConcurrentHashMap<String, CountDownLatch>()
    private val failed = ConcurrentHashMap<String, Boolean>()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_CANCEL) {
            cancelled = true
            return START_NOT_STICKY
        }
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CH, "Audio export", NotificationManager.IMPORTANCE_LOW))
        val n = progress("Preparing…", 0, 0)
        if (Build.VERSION.SDK_INT >= 29) startForeground(NID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        else startForeground(NID, n)
        if (running) {
            toast("An export is already running.")
            return START_NOT_STICKY
        }
        val bookId = intent?.getStringExtra("book")
        val tree = intent?.getStringExtra("tree")
        val from = intent?.getIntExtra("from", 0) ?: 0
        val to = intent?.getIntExtra("to", 0) ?: 0
        if (bookId == null || tree == null) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        running = true
        cancelled = false
        Thread {
            val msg = try {
                export(bookId, from, to, Uri.parse(tree))
            } catch (c: Cancelled) {
                "Export cancelled."
            } catch (t: Throwable) {
                "Export failed: ${t.message ?: t.javaClass.simpleName}"
            }
            done(msg)
        }.start()
        return START_NOT_STICKY
    }

    private fun progress(text: String, cur: Int, max: Int): Notification {
        val cancel = PendingIntent.getService(
            this, 9, Intent(this, ExportService::class.java).setAction(ACTION_CANCEL),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return Notification.Builder(this, CH)
            .setSmallIcon(R.drawable.ic_notif)
            .setContentTitle("Exporting audio")
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setProgress(max, cur, max == 0)
            .addAction(Notification.Action.Builder(Icon.createWithResource(this, android.R.drawable.ic_menu_close_clear_cancel), "Cancel", cancel).build())
            .build()
    }

    private fun showProgress(text: String, cur: Int, max: Int) {
        getSystemService(NotificationManager::class.java).notify(NID, progress(text, cur, max))
    }

    private fun done(msg: String) {
        try { tts?.shutdown() } catch (t: Throwable) {}
        tts = null
        running = false
        val n = Notification.Builder(this, CH)
            .setSmallIcon(R.drawable.ic_notif)
            .setContentTitle("Audio export")
            .setContentText(msg)
            .setStyle(Notification.BigTextStyle().bigText(msg))
            .setAutoCancel(true)
            .build()
        getSystemService(NotificationManager::class.java).notify(NID_DONE, n)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun initTts() {
        val latch = CountDownLatch(1)
        var ok = false
        tts = TextToSpeech(this) { st ->
            ok = st == TextToSpeech.SUCCESS
            latch.countDown()
        }
        latch.await(30, TimeUnit.SECONDS)
        val t = tts
        if (!ok || t == null) throw Exception("text-to-speech isn't available")
        t.setSpeechRate(Settings.rate(this))
        Settings.voice(this)?.let { name ->
            try { t.voices?.firstOrNull { it.name == name }?.let { t.voice = it } } catch (e: Throwable) {}
        }
        t.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {}
            override fun onDone(utteranceId: String?) {
                utteranceId?.let { latches.remove(it)?.countDown() }
            }
            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String?) {
                utteranceId?.let { failed[it] = true; latches.remove(it)?.countDown() }
            }
            override fun onError(utteranceId: String?, errorCode: Int) {
                utteranceId?.let { failed[it] = true; latches.remove(it)?.countDown() }
            }
        })
    }

    private fun synth(text: String, file: File) {
        val id = UUID.randomUUID().toString()
        val latch = CountDownLatch(1)
        latches[id] = latch
        val r = tts!!.synthesizeToFile(text, Bundle(), file, id)
        if (r != TextToSpeech.SUCCESS) throw Exception("the voice refused the text")
        while (!latch.await(2, TimeUnit.SECONDS)) {
            if (cancelled) throw Cancelled()
        }
        if (failed.remove(id) == true) throw Exception("the voice engine reported an error (online voices need internet)")
    }

    private fun safeName(s: String) = s.replace(Regex("[\\\\/:*?\"<>|\\n\\t]"), "_").trim().take(80).ifEmpty { "Untitled" }

    private fun export(bookId: String, from: Int, to: Int, tree: Uri): String {
        val b = Library.get(this, bookId) ?: return "That book is no longer in your library."
        val doc = Library.doc(this, b)
        val segs = Speech.segments(doc.paras)
        val speaker = Speaker(this)
        val chapters = doc.chapters.ifEmpty { listOf(Chapter(b.title, 0)) }
        val a = from.coerceIn(0, chapters.size - 1)
        val z = to.coerceIn(a, chapters.size - 1)
        initTts()

        val rootDoc = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
        val folder = DocumentsContract.createDocument(
            contentResolver, rootDoc, DocumentsContract.Document.MIME_TYPE_DIR, safeName(b.title)
        ) ?: rootDoc

        var made = 0
        val total = z - a + 1
        for (ci in a..z) {
            if (cancelled) throw Cancelled()
            val startPara = chapters[ci].para
            val endPara = if (ci + 1 < chapters.size) chapters[ci + 1].para else doc.paras.size
            val chunks = ArrayList<String>()
            val sb = StringBuilder()
            for (s in segs) {
                if (s.para < startPara) continue
                if (s.para >= endPara) break
                val t = speaker.spoken(doc.paras[s.para].substring(s.start, s.end)) ?: continue
                if (sb.isNotEmpty() && sb.length + t.length > 3000) { chunks += sb.toString(); sb.setLength(0) }
                if (sb.isNotEmpty()) sb.append(' ')
                sb.append(t)
            }
            if (sb.isNotEmpty()) chunks += sb.toString()
            if (chunks.isEmpty()) continue

            val out = File(cacheDir, "export.m4a")
            out.delete()
            val wav = File(cacheDir, "export-chunk.wav")
            var writer: AacWriter? = null
            try {
                for ((k, chunk) in chunks.withIndex()) {
                    showProgress("File ${ci - a + 1} of $total: ${chapters[ci].title}", k, chunks.size)
                    wav.delete()
                    synth(chunk, wav)
                    val pcm = Wav.read(wav)
                    val w = writer ?: AacWriter(out.path, pcm.rate, pcm.channels).also { writer = it }
                    if (pcm.rate != w.sampleRate || pcm.channels != w.channels) throw Exception("the voice changed audio format mid-export")
                    w.write(pcm.data)
                    w.silence(300)
                }
            } finally {
                writer?.finish()
                wav.delete()
            }
            val name = "%02d - %s.m4a".format(ci + 1, safeName(chapters[ci].title))
            val target = DocumentsContract.createDocument(contentResolver, folder, "audio/mp4", name)
                ?: throw Exception("couldn't create a file in that folder")
            contentResolver.openOutputStream(target)?.use { o -> out.inputStream().use { it.copyTo(o) } }
                ?: throw Exception("couldn't write to that folder")
            out.delete()
            made++
        }
        return if (made == 1) "Saved 1 audio file to the “${safeName(b.title)}” folder."
        else "Saved $made audio files to the “${safeName(b.title)}” folder."
    }
}
