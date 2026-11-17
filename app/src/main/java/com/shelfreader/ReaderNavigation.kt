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

internal fun ReaderActivity.recordJump(to: Int) {
    if (!loaded) return
    val from = curPara
    if (kotlin.math.abs(to - from) < 4) return
    history.removeAll { kotlin.math.abs(it.first - from) <= 2 }
    history.add(0, from to System.currentTimeMillis())
    while (history.size > 12) history.removeAt(history.size - 1)
    jumpBar.text = "Jumped to a new place.   ↶ Tap to go back"
    jumpBar.visibility = View.VISIBLE
    ui.removeCallbacks(hideJump)
    ui.postDelayed(hideJump, 6000)
}

internal fun ReaderActivity.goBackTo(k: Int) {
    val h = history.getOrNull(k) ?: return
    history.removeAt(k)
    val here = curPara
    if (kotlin.math.abs(here - h.first) > 2) history.add(0, here to System.currentTimeMillis())
    goTo(h.first, record = false)
}

internal fun ReaderActivity.placeLabel(p: Int): String {
    val pct = (p + 1) * 100 / maxOf(1, paras.size)
    val ch = chapterIndex(p).let { if (it >= 0) chapters[it].title else "Beginning" }
    return "$ch · $pct%"
}

internal fun ReaderActivity.showHistory() {
    if (history.isEmpty()) { toast("No jumps yet. When you jump somewhere, the place you left is kept here."); return }
    val now = System.currentTimeMillis()
    val labels = history.map { (p, t) ->
        val m = ((now - t) / 60000).toInt()
        "↶ ${placeLabel(p)}  (" + (if (m < 1) "just now" else if (m < 60) "$m min ago" else "${m / 60} h ago") + ")"
    }.toTypedArray()
    AlertDialog.Builder(this).setTitle("Places you jumped from").setItems(labels) { _, w -> goBackTo(w) }.show()
}

/** A slider across the whole book that shows the chapter as you drag. */
internal fun ReaderActivity.goToDialog() {
    if (!loaded) return
    val box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(12), dp(20), 0) }
    val label = TextView(this).apply { textSize = 15f }
    val bar = android.widget.SeekBar(this).apply { max = 1000; progress = curPara * 1000 / maxOf(1, paras.size - 1) }
    val pctBox = EditText(this).apply { hint = "or type a percent"; inputType = android.text.InputType.TYPE_CLASS_NUMBER }
    fun paraAt(v: Int) = (v.toLong() * (paras.size - 1) / 1000).toInt()
    fun show(v: Int) { label.text = placeLabel(paraAt(v)) }
    show(bar.progress)
    bar.setOnSeekBarChangeListener(object : android.widget.SeekBar.OnSeekBarChangeListener {
        override fun onProgressChanged(sb: android.widget.SeekBar?, v: Int, fromUser: Boolean) { show(v) }
        override fun onStartTrackingTouch(sb: android.widget.SeekBar?) {}
        override fun onStopTrackingTouch(sb: android.widget.SeekBar?) {}
    })
    pctBox.addTextChangedListener(object : android.text.TextWatcher {
        override fun afterTextChanged(e: android.text.Editable?) { e?.toString()?.toIntOrNull()?.let { bar.progress = (it.coerceIn(0, 100) * 10) } }
        override fun beforeTextChanged(a: CharSequence?, b: Int, c: Int, d: Int) {}
        override fun onTextChanged(a: CharSequence?, b: Int, c: Int, d: Int) {}
    })
    box.addView(label); box.addView(bar, LinearLayout.LayoutParams(MATCH, WRAP)); box.addView(pctBox)
    AlertDialog.Builder(this).setTitle("Go to").setView(box)
        .setPositiveButton("Go") { _, _ -> goTo(paraAt(bar.progress)) }
        .setNegativeButton("Cancel", null).show()
}

internal fun ReaderActivity.showChapters() {
    if (!loaded) return
    if (chapters.isEmpty()) { toast("No chapters were found in this book."); return }
    val cur = chapterIndex(curPara)
    sheet("Contents · ${chapters.size} chapters", chapters.mapIndexed { k, c ->
        val pct = (c.para + 1) * 100 / maxOf(1, paras.size)
        SheetRow(if (k == cur) "▶" else if (c.level == 1) "  ·" else "📖", (if (c.level == 1) "   " else "") + prettyChapter(c.title), if (k == cur) "You're here · $pct%" else "$pct%") { goTo(chapters[k].para) }
    }, scrollTo = cur)
}

internal fun ReaderActivity.searchInBook() {
    if (!loaded) return
    val box = EditText(this).apply { hint = "Word or phrase"; isSingleLine = true }
    val wrap = LinearLayout(this).apply {
        setPadding(dp(20), dp(8), dp(20), 0)
        addView(box, LinearLayout.LayoutParams(MATCH, WRAP))
    }
    AlertDialog.Builder(this)
        .setTitle("Search in this book")
        .setView(wrap)
        .setPositiveButton("Search") { _, _ -> showSearchResults(box.text.toString().trim()) }
        .setNegativeButton("Cancel", null)
        .show()
}

internal fun ReaderActivity.showSearchResults(q: String) {
    if (q.length < 2) return
    val hits = ArrayList<Int>()
    for ((i, p) in paras.withIndex()) {
        if (p.contains(q, ignoreCase = true)) { hits += i; if (hits.size >= 300) break }
    }
    if (hits.isEmpty()) { toast("“$q” wasn't found in this book."); return }
    val labels = hits.map { i ->
        val p = paras[i]
        val at = p.indexOf(q, ignoreCase = true)
        val from = maxOf(0, at - 40)
        val snippet = (if (from > 0) "…" else "") + p.substring(from, minOf(p.length, at + q.length + 60)) + "…"
        val ch = chapterIndex(i).let { if (it >= 0) chapters[it].title else "Paragraph ${i + 1}" }
        "$ch\n$snippet"
    }.toTypedArray()
    AlertDialog.Builder(this)
        .setTitle("${hits.size}${if (hits.size >= 300) "+" else ""} matches for “$q”")
        .setItems(labels) { _, w -> goTo(hits[w]) }
        .show()
}

internal fun ReaderActivity.showRecap(prevOpened: Long) {
    if (prevOpened == 0L || System.currentTimeMillis() - prevOpened < 3_600_000L) return
    val p = curPara
    if (p <= 0 || p >= paras.size) return
    val src = if (paras[p - 1].length > 40) paras[p - 1] else paras[p]
    val sentence = src.split(Regex("(?<=[.!?…])\\s+")).lastOrNull { it.length > 20 } ?: src
    val diff = System.currentTimeMillis() - prevOpened
    val when_ = when {
        diff < 2 * 86_400_000L && java.util.Calendar.getInstance().apply { timeInMillis = prevOpened }.get(java.util.Calendar.DAY_OF_YEAR) ==
            java.util.Calendar.getInstance().get(java.util.Calendar.DAY_OF_YEAR) -> "earlier today"
        diff < 2 * 86_400_000L -> "yesterday"
        else -> java.text.DateFormat.getDateInstance().format(java.util.Date(prevOpened))
    }
    val ch = chapterIndex(p).let { if (it >= 0) chapters[it].title else book.title }
    recap.text = "Last time ($when_) · $ch\n“${if (sentence.length > 180) sentence.take(180) + "…" else sentence}”\nTap to dismiss · ▶ Play to continue"
    recap.visibility = View.VISIBLE
    ui.postDelayed({ recap.visibility = View.GONE }, 20_000)
}

internal fun ReaderActivity.showFootnote(n: String, from: Int) {
    val defs = fnDefs ?: HashMap<String, MutableList<Int>>().also { m ->
        for ((i, p) in paras.withIndex()) {
            val mt = FN_DEF.find(p)
            if (mt != null && p.length > mt.value.length + 3) m.getOrPut(mt.groupValues[1]) { ArrayList() } += i
        }
        fnDefs = m
    }
    val cands = (defs[n] ?: emptyList()).filter { it != from }
    val i = cands.firstOrNull { it > from } ?: cands.lastOrNull()
    val dlg = AlertDialog.Builder(this).setTitle("Note $n")
    if (i == null) {
        dlg.setMessage("This book's note text couldn't be found.").setPositiveButton("OK", null).show()
        return
    }
    dlg.setMessage(paras[i].replace(FN_DEF, "").trimEnd(']', ' '))
        .setPositiveButton("Close", null)
        .setNeutralButton("Go to note") { _, _ -> goTo(i) }
        .show()
}
