package com.shelfreader

import android.app.Activity
import android.app.AlertDialog
import android.app.TimePickerDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.drawable.BitmapDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.Voice
import android.text.Layout
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.AlignmentSpan
import android.text.style.BackgroundColorSpan
import android.text.style.ForegroundColorSpan
import android.text.style.ImageSpan
import android.text.style.RelativeSizeSpan
import android.util.LruCache
import android.util.TypedValue
import android.view.ActionMode
import android.view.GestureDetector
import android.view.Menu
import android.view.MotionEvent
import android.view.MenuItem
import android.view.View
import android.view.ViewGroup
import android.widget.AbsListView
import android.widget.BaseAdapter
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.ScrollView
import android.widget.TextView
import java.util.Locale

// Part of ReaderActivity (moved out of ReaderActivity.kt to keep files a readable size).

// ---------- audio clips with bookmarks ----------
internal fun ReaderActivity.saveClip(p: Int) {
    val s = service()
    val segText = if (s != null && curPara == p && s.currentSegText() != null) s.currentSegText()!! else paras[p].split(Regex("(?<=[.!?…])\\s+")).let { parts ->
        var t = ""; for (x in parts) { if (t.length > 60) break; t = (t + " " + x).trim() }; t
    }
    val quote = segText.take(400)
    val text = Speaker(this).spoken(quote) ?: quote
    toast("Making the clip…")
    val dir = java.io.File(filesDir, "clips/${book.id}").apply { mkdirs() }
    val name = "clip-${System.currentTimeMillis()}.wav"
    val out = java.io.File(dir, name)
    val nv = Settings.voiceFor(this, book.id)
    if (NeuralVoices.isNeural(nv)) {
        Thread {
            val r = try { NeuralVoices.generate(this, nv!!, text, Settings.rateFor(this, book.id)) } catch (t: Throwable) { null }
            runOnUiThread {
                if (r == null) { toast("Couldn't make the clip."); return@runOnUiThread }
                NeuralVoices.writeWav(out, r.first, r.second)
                val list = Library.notes(this, book.id)
                list += Note(p, "", System.currentTimeMillis(), "clip", 0, 0, "yellow", quote, name)
                Library.saveNotes(this, book.id, list); reloadNotes()
                toast("Saved the clip with a bookmark. Find it in Bookmarks & notes.")
            }
        }.start()
        return
    }
    val engine = TextToSpeech(this, null)
    engine.setOnUtteranceProgressListener(object : android.speech.tts.UtteranceProgressListener() {
        override fun onStart(id: String?) {}
        override fun onDone(id: String?) {
            runOnUiThread {
                engine.shutdown()
                val list = Library.notes(this@saveClip, book.id)
                list += Note(p, "", System.currentTimeMillis(), "clip", 0, 0, "yellow", quote, name)
                Library.saveNotes(this@saveClip, book.id, list)
                reloadNotes()
                toast("Saved the clip with a bookmark. Find it in Bookmarks & notes.")
            }
        }
        @Deprecated("Deprecated in Java")
        override fun onError(id: String?) { runOnUiThread { engine.shutdown(); toast("Couldn't make the clip.") } }
    })
    // wait for the engine, then speak to a file with this book's voice and speed
    ui.postDelayed(object : Runnable {
        var tries = 0
        override fun run() {
            if (engine.voices == null && tries++ < 20) { ui.postDelayed(this, 150); return }
            VoiceNames.apply(engine, Settings.voiceFor(this@saveClip, book.id))
            engine.setSpeechRate(Settings.rateFor(this@saveClip, book.id))
            engine.synthesizeToFile(text, Bundle(), out, "clip")
        }
    }, 300)
}

internal fun ReaderActivity.playClip(n: Note) {
    val f = java.io.File(filesDir, "clips/${book.id}/${n.file}")
    if (!f.exists()) { toast("This clip was made on another device."); return }
    if (service()?.playing == true) togglePlay()
    try {
        android.media.MediaPlayer().apply { setDataSource(f.path); setOnCompletionListener { it.release() }; prepare(); start() }
    } catch (t: Throwable) { toast("Couldn't play the clip.") }
}

internal fun ReaderActivity.shareClip(n: Note) {
    val uri = android.net.Uri.parse("content://${packageName}.clips/${book.id}/${n.file}")
    val send = Intent(Intent.ACTION_SEND).setType("audio/wav")
        .putExtra(Intent.EXTRA_STREAM, uri)
        .putExtra(Intent.EXTRA_TEXT, "“${n.quote}” — ${book.title}")
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    startActivity(Intent.createChooser(send, "Share clip"))
}
