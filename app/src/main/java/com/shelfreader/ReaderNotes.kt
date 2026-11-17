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

internal fun ReaderActivity.reloadNotes() {
    notes = Library.notes(this, book.id)
    val m = HashMap<Int, String>()
    for (n in notes) if (n.type != "hl" || n.text.isNotBlank()) m[n.para] = if (n.text.isBlank() && m[n.para] == null) "🔖 " else "📝 "
    marks = m
    adapter.notifyDataSetChanged()
    if (bookMode && curSection > 0) {
        bookView.relayout(bookMarks())
        if (service() != null) bookView.setReading(curPara, curStart, curEnd)
    }
}

internal fun ReaderActivity.paragraphMenu(p: Int) {
    val here = notes.filter { it.para == p }
    val refs = FN_REF.findAll(paras[p]).map { it.groupValues[1] }.distinct().toList()
    val rows = ArrayList<SheetRow?>()
    rows += SheetRow("▶", "Read aloud from here") { playFrom(p) }
    rows += SheetRow("🔖", "Bookmark this paragraph") { saveNote(p, ""); toast("Bookmarked") }
    rows += SheetRow("📝", "Add a note…") { addNote(p) }
    rows += SheetRow("🖍", "Highlight, define or note a passage…", "Select the exact words") { selectIn(p) }
    rows += SheetRow("🎙", "Bookmark with an audio clip", "Saves this sentence spoken aloud, to play or share") { saveClip(p) }
    rows += SheetRow("📋", "Copy text") {
        (getSystemService(android.content.Context.CLIPBOARD_SERVICE) as ClipboardManager)
            .setPrimaryClip(ClipData.newPlainText("Shelf Reader", paras[p]))
        toast("Copied")
    }
    for (r in refs) rows += SheetRow("†", "Show note [$r]") { showFootnote(r, p) }
    if (here.isNotEmpty()) {
        rows += null
        rows += SheetRow("🗑", "Remove bookmark / notes / highlights here") {
            notes.filter { it.para == p && it.type == "clip" }.forEach { java.io.File(filesDir, "clips/${book.id}/${it.file}").delete() }
            Library.saveNotes(this, book.id, notes.filter { it.para != p })
            reloadNotes()
        }
    }
    sheet(paras[p].take(80) + if (paras[p].length > 80) "…" else "", rows)
}

internal fun ReaderActivity.saveNote(p: Int, text: String) {
    val list = Library.notes(this, book.id)
    list += Note(p, text, System.currentTimeMillis())
    Library.saveNotes(this, book.id, list)
    reloadNotes()
}

internal fun ReaderActivity.addNote(p: Int) {
    val box = EditText(this).apply {
        hint = "Your note"
        minLines = 2
    }
    val wrap = LinearLayout(this).apply {
        setPadding(dp(20), dp(8), dp(20), 0)
        addView(box, LinearLayout.LayoutParams(MATCH, WRAP))
    }
    AlertDialog.Builder(this)
        .setTitle("Note")
        .setView(wrap)
        .setPositiveButton("Save") { _, _ ->
            val t = box.text.toString().trim()
            if (t.isNotEmpty()) saveNote(p, t)
        }
        .setNegativeButton("Cancel", null)
        .show()
}

internal fun ReaderActivity.showNotes() {
    if (notes.isEmpty()) {
        toast("No bookmarks, notes or highlights yet. Long-press a paragraph to add one.")
        return
    }
    val labels = notes.map { n ->
        val where = chapterIndex(n.para).let { if (it >= 0) chapters[it].title else "Paragraph ${n.para + 1}" }
        val body = when {
            n.type == "clip" -> "🔊 “" + n.quote.take(90) + "”"
            n.type == "hl" -> "🖍 “" + n.quote.take(90) + "”" + if (n.text.isNotBlank()) "\n📝 " + n.text else ""
            n.text.isBlank() -> "🔖 " + paras.getOrElse(n.para) { "" }.take(70)
            else -> "📝 " + n.text
        }
        "$where\n$body"
    }.toTypedArray()
    AlertDialog.Builder(this).setTitle("Bookmarks, notes & highlights")
        .setPositiveButton("Export…") { _, _ -> exportNotes() }
        .setItems(labels) { _, w ->
        val n = notes[w]
        if (n.type == "clip") {
            AlertDialog.Builder(this).setTitle("Audio clip").setMessage("“${n.quote}”")
                .setPositiveButton("▶ Play") { _, _ -> playClip(n) }
                .setNeutralButton("Share…") { _, _ -> shareClip(n) }
                .setNegativeButton("Delete") { _, _ ->
                    java.io.File(filesDir, "clips/${book.id}/${n.file}").delete()
                    Library.saveNotes(this, book.id, notes.filter { it !== n }); reloadNotes()
                }.show()
            return@setItems
        }
        AlertDialog.Builder(this)
            .setTitle(if (n.type == "hl") "Highlight" else if (n.text.isBlank()) "Bookmark" else "Note")
            .setMessage(if (n.type == "hl") "“${n.quote}”" + (if (n.text.isNotBlank()) "\n\n${n.text}" else "")
                else if (n.text.isBlank()) paras.getOrElse(n.para) { "" }.take(300) else n.text)
            .setPositiveButton("Go there") { _, _ -> goTo(n.para) }
            .setNeutralButton("Delete") { _, _ ->
                Library.saveNotes(this, book.id, notes.filter { it !== n })
                reloadNotes()
            }
            .setNegativeButton("Close", null)
            .show()
    }.show()
}

/** Shows the paragraph with selectable text: pick words, then Define, a highlighter colour, or Note. */
internal fun ReaderActivity.selectIn(p: Int) {
    val text = paras[p]
    val tv = TextView(this).apply {
        this.text = text
        textSize = 18f
        setTextIsSelectable(true)
        setPadding(dp(20), dp(12), dp(20), dp(12))
    }
    var dlg: AlertDialog? = null
    tv.customSelectionActionModeCallback = object : ActionMode.Callback {
        override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
            menu.clear()
            menu.add(0, 99, 0, "Define")
            menu.add(0, 100, 1, "Yellow")
            menu.add(0, 101, 2, "Green")
            menu.add(0, 102, 3, "Pink")
            menu.add(0, 103, 4, "Note")
            menu.add(0, 104, 5, "Copy")
            return true
        }
        override fun onPrepareActionMode(mode: ActionMode, menu: Menu) = false
        override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean {
            val a = maxOf(0, minOf(tv.selectionStart, tv.selectionEnd)); val b = maxOf(0, maxOf(tv.selectionStart, tv.selectionEnd))
            val sel = text.substring(a.coerceAtMost(text.length), b.coerceAtMost(text.length))
            mode.finish()
            if (sel.isBlank()) return true
            when (item.itemId) {
                99 -> define(sel)
                100, 101, 102 -> { addHighlight(p, a, b, HL_NAMES[item.itemId - 100], ""); dlg?.dismiss(); toast("Highlighted") }
                103 -> { dlg?.dismiss(); highlightNote(p, a, b) }
                104 -> {
                    (getSystemService(android.content.Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Shelf Reader", sel))
                    toast("Copied")
                }
            }
            return true
        }
        override fun onDestroyActionMode(mode: ActionMode) {}
    }
    val scroll = ScrollView(this).apply { addView(tv) }
    dlg = AlertDialog.Builder(this)
        .setTitle("Press and hold, drag to select, then pick")
        .setView(scroll)
        .setNegativeButton("Close", null)
        .show()
}

internal fun ReaderActivity.addHighlight(p: Int, a: Int, b: Int, color: String, note: String) {
    val l = Library.notes(this, book.id)
    l += Note(p, note, System.currentTimeMillis(), "hl", a, b, color, paras[p].substring(a, b))
    Library.saveNotes(this, book.id, l)
    reloadNotes()
}

internal fun ReaderActivity.highlightNote(p: Int, a: Int, b: Int) {
    val box = EditText(this).apply { hint = "Your note"; minLines = 2 }
    val wrap = LinearLayout(this).apply { setPadding(dp(20), dp(8), dp(20), 0); addView(box, LinearLayout.LayoutParams(MATCH, WRAP)) }
    AlertDialog.Builder(this).setTitle("Note on “${paras[p].substring(a, b).take(60)}”").setView(wrap)
        .setPositiveButton("Save") { _, _ -> addHighlight(p, a, b, "yellow", box.text.toString().trim()) }
        .setNegativeButton("Cancel", null)
        .show()
}

/** Shares your highlights, notes and bookmarks as a Markdown text (save it to Drive, email it, etc.). */
internal fun ReaderActivity.exportNotes() {
    val all = Library.notes(this, book.id).sortedBy { it.para * 100000 + it.start }
    if (all.isEmpty()) { toast("Nothing to export yet."); return }
    val sb = StringBuilder("# ${book.title}\n")
    if (book.author.isNotBlank()) sb.append("*${book.author}*\n")
    sb.append("\n")
    var lastCh = -2
    for (n in all) {
        val ch = chapterIndex(n.para)
        if (ch != lastCh) { sb.append("\n## ${if (ch >= 0) chapters[ch].title else "Beginning"}\n\n"); lastCh = ch }
        when {
            n.type == "hl" -> { sb.append("> ${n.quote}\n"); if (n.text.isNotBlank()) sb.append("\n${n.text}\n"); sb.append("\n") }
            n.text.isBlank() -> sb.append("- Bookmark: ${paras.getOrElse(n.para) { "" }.take(120)}…\n\n")
            else -> sb.append("- Note: ${n.text}\n  (at: ${paras.getOrElse(n.para) { "" }.take(80)}…)\n\n")
        }
    }
    val send = Intent(Intent.ACTION_SEND).setType("text/plain")
        .putExtra(Intent.EXTRA_SUBJECT, "${book.title} — highlights & notes")
        .putExtra(Intent.EXTRA_TEXT, sb.toString())
    startActivity(Intent.createChooser(send, "Export highlights & notes"))
}

internal fun ReaderActivity.define(word: String) {
    val w = word.trim().split(Regex("\\s+")).firstOrNull()?.trim { !it.isLetter() } ?: return
    if (w.isEmpty()) return
    toast("Looking up “$w”…")
    Thread {
        val result = try { Dictionary.define(w) } catch (t: Throwable) { "Couldn't look that up: ${t.message}" }
        runOnUiThread {
            AlertDialog.Builder(this).setTitle(w).setMessage(result).setPositiveButton("OK", null).show()
        }
    }.start()
}

internal fun ReaderActivity.exportMenu() {
    if (!loaded) return
    if (ExportService.running) { toast("An export is already running — see the notification."); return }
    val cur = chapterIndex(curPara).coerceAtLeast(0)
    val count = maxOf(1, chapters.size)
    val options = arrayOf(
        if (chapters.isEmpty()) "Whole book (one file)" else "This chapter",
        "Whole book (${count} file${if (count == 1) "" else "s"}, one per chapter)"
    )
    AlertDialog.Builder(this)
        .setTitle("Export as audio")
        .setItems(options) { _, w ->
            pendingExport = if (w == 0) cur to cur else 0 to count - 1
            toast("Pick a folder to save the audio files in.")
            try {
                @Suppress("DEPRECATION")
                startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), 43)
            } catch (e: Throwable) {
                toast("No folder picker available")
            }
        }
        .show()
}
