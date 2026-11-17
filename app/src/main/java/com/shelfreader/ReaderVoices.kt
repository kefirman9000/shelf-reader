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

internal fun ReaderActivity.pickVoice() {
    if (voicePickerOpen) return
    // A separate engine is used for listing and previewing phone voices, so previews don't disturb playback.
    val p = probe
    if (p != null && probeReady) { showVoices(p); return }
    status.text = "Loading voices…"
    if (p == null) {
        probe = TextToSpeech(this) { st ->
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                probeReady = st == TextToSpeech.SUCCESS
                showVoices(if (probeReady) probe else null)
                refresh()
            }
        }
    }
}

internal fun ReaderActivity.showVoices(engine: TextToSpeech?) {
    if (voicePickerOpen || isFinishing || isDestroyed) return
    val wasPlaying = isPlaying()
    if (wasPlaying) startService(Intent(this, TtsService::class.java).setAction(TtsService.ACTION_PAUSE))
    voicePickerOpen = true
    VoicePicker(this, book.id, { sampleSentence() }, engine, { e, v -> preview(e, v) }, { openTtsSettings() }) {
        voicePickerOpen = false
        // carry on reading if it was playing before (now with the chosen voice)
        if (wasPlaying && !isFinishing && !isPlaying()) startService(Intent(this, TtsService::class.java).setAction(TtsService.ACTION_TOGGLE))
        refresh()
    }.show()
}

/** A line from where you are in the book, to hear a downloaded voice read it. */
internal fun ReaderActivity.sampleSentence(): String {
    val start = currentPara().coerceIn(0, maxOf(0, paras.size - 1))
    for (i in start until minOf(paras.size, start + 30)) {
        val t = paras[i].replace(Regex("\\s+"), " ").trim()
        if (t.count { it.isLetter() } < 25) continue
        val end = Regex("[.!?…][”\"’)]?\\s").find(t, 40)?.range?.last ?: -1
        return (if (end in 40..240) t.substring(0, end + 1) else t.take(200).substringBeforeLast(' ') + "…").trim()
    }
    return "Hello! This is how I would sound reading ${book.title}."
}

internal fun ReaderActivity.preview(engine: TextToSpeech, v: Voice?) {
    try {
        engine.stop()
        val used = VoiceNames.apply(engine, v?.name)
        if (v != null && used == null) {
            toast("This voice isn't installed on your phone yet, so you'd hear the default voice. Tap “Get more voices…” to download it.")
            return
        }
        if (v != null && used != null && used.name != v.name) {
            toast(if (used.isNetworkConnectionRequired) "Using the online version of this voice." else "Using the offline version of this voice.")
        }
        engine.setSpeechRate(Settings.rateFor(this, book.id))
        engine.speak("Hello! This is how I'll sound reading your book.", TextToSpeech.QUEUE_FLUSH, null, "preview")
    } catch (e: Throwable) {
        toast("Couldn't play a preview of that voice.")
    }
}

internal fun ReaderActivity.openTtsSettings() {
    try {
        startActivity(Intent("com.android.settings.TTS_SETTINGS"))
    } catch (e: Throwable) {
        toast("Open Settings → Accessibility → Text-to-speech to install voices.")
    }
}

internal fun ReaderActivity.pickSpeed() {
    val rates = floatArrayOf(0.75f, 1f, 1.25f, 1.5f, 1.75f, 2f, 2.5f, 3f)
    AlertDialog.Builder(this)
        .setTitle("Reading speed for this book")
        .setItems(rates.map { fmtRate(it) }.toTypedArray()) { _, w ->
            Settings.setBookRate(this, book.id, rates[w])
            TtsService.instance?.applySettings(true)
            refreshButtons()
        }
        .show()
}

internal fun ReaderActivity.sleepMenu() {
    val labels = arrayOf("Off", "5 minutes", "15 minutes", "30 minutes", "45 minutes", "1 hour", "End of this chapter")
    val minutes = intArrayOf(0, 5, 15, 30, 45, 60, -1)
    AlertDialog.Builder(this).setTitle("Sleep timer").setItems(labels) { _, w ->
        val i = Intent(this, TtsService::class.java)
            .setAction(TtsService.ACTION_SLEEP)
            .putExtra(TtsService.EXTRA_MINUTES, minutes[w])
        if (TtsService.instance == null) {
            if (minutes[w] == 0) return@setItems
            i.putExtra(TtsService.EXTRA_BOOK, book.id)
            startForegroundService(i)
        } else {
            startService(i)
        }
        toast(if (minutes[w] == 0) "Sleep timer off" else "Sleep timer: ${labels[w].lowercase()}")
    }.show()
}
