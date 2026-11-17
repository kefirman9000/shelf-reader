package com.shelfreader

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.AdapterView
import android.widget.BaseAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.GridView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors

// Part of MainActivity (moved out of MainActivity.kt to keep files a readable size).

internal fun MainActivity.bookMenu(b: Book) {
    val queued = b.id in Settings.queue(this)
    val pct = Library.percent(this, b)
    sheet(b.title + (if (b.author.isNotBlank()) " · ${b.author}" else "") + " · $pct% read", listOf(
        SheetRow("📖", "Open") { openBook(b) },
        SheetRow("▶", "Read aloud now", "Keeps playing with the screen off") {
            startForegroundService(
                Intent(this, TtsService::class.java).setAction(TtsService.ACTION_PLAY).putExtra(TtsService.EXTRA_BOOK, b.id)
            )
            toast("Reading “${b.title}” aloud")
            libraryGrid.postDelayed({ refreshLibrary() }, 800)
        },
        SheetRow("⏭", if (queued) "Remove from Up next" else "Add to Up next", if (queued) null else "Plays when the books before it finish") {
            val q = Settings.queue(this).toMutableList()
            if (queued) q.remove(b.id) else q += b.id
            Settings.setQueue(this, q)
            toast(if (queued) "Removed from Up next" else "Added to Up next")
        },
        SheetRow("🚗", "Car mode", "Huge buttons for driving") { startActivity(Intent(this, CarModeActivity::class.java).putExtra("book", b.id)) },
        null,
        SheetRow("🗂", "Collections…", "Sort it into shelves like Want to read") { editCollections(this, b.id) { refreshLibrary() } },
        SheetRow("✏", "Edit title & author") { editBook(b) },
        SheetRow("🖼", "Change cover…", "Pick a picture from your phone") {
            pendingCoverBook = b.id
            try {
                @Suppress("DEPRECATION")
                startActivityForResult(
                    Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("image/*"), 44
                )
            } catch (e: Throwable) { toast("No picture picker available") }
        },
        SheetRow("↺", "Reset cover") { Covers.reset(this, b); refreshLibrary() },
        SheetRow("ℹ", "About this book…", "Description, subjects and similar free books") { aboutBook(b) },
        null,
        SheetRow("🗑", "Remove from library") { confirmDelete(b) }
    ))
}

// ---------- Up next ----------
internal fun MainActivity.showQueue() {
    val q = Settings.queue(this).mapNotNull { Library.get(this, it) }
    if (q.isEmpty()) { toast("Nothing in Up next. Long-press a book and choose “Add to Up next”."); return }
    val labels = q.mapIndexed { k, b -> "${k + 1}. ${b.title}" }.toTypedArray()
    AlertDialog.Builder(this).setTitle("Up next").setItems(labels) { _, w ->
        val b = q[w]
        AlertDialog.Builder(this).setTitle(b.title)
            .setItems(arrayOf("Open", "Move to the top", "Remove from Up next")) { _, a ->
                val ids = q.map { it.id }.toMutableList()
                when (a) {
                    0 -> openBook(b)
                    1 -> { ids.remove(b.id); ids.add(0, b.id); Settings.setQueue(this, ids); showQueue() }
                    2 -> { ids.remove(b.id); Settings.setQueue(this, ids); showQueue() }
                }
            }.show()
    }.setNegativeButton("Close", null).show()
}

internal fun MainActivity.searchBooks() {
    val box = EditText(this).apply { hint = "Word or phrase in any book"; setSingleLine() }
    val wrap = LinearLayout(this).apply { setPadding(dp(20), dp(8), dp(20), 0); addView(box, LinearLayout.LayoutParams(-1, -2)) }
    AlertDialog.Builder(this).setTitle("Search inside your books").setView(wrap)
        .setPositiveButton("Search") { _, _ ->
            val q = box.text.toString().trim()
            if (q.length < 2) return@setPositiveButton
            toast("Searching…")
            pool.execute {
                val hits = ArrayList<MainActivity.Hit>()
                for (b in Library.load(this)) {
                    val d = try { Library.doc(this, b) } catch (t: Throwable) { continue }
                    var n = 0
                    for ((i, p) in d.paras.withIndex()) {
                        val k = p.indexOf(q, ignoreCase = true)
                        if (k < 0) continue
                        val a = maxOf(0, k - 60); val e = minOf(p.length, k + q.length + 80)
                        val ch = d.chapters.lastOrNull { it.para <= i }?.title ?: ""
                        hits += MainActivity.Hit(b, i, (if (a > 0) "…" else "") + p.substring(a, e) + (if (e < p.length) "…" else ""), ch)
                        if (++n >= 6 || hits.size >= 150) break
                    }
                    if (hits.size >= 150) break
                }
                runOnUiThread {
                    if (hits.isEmpty()) { toast("Not found in any book."); return@runOnUiThread }
                    val labels = hits.map { "${it.book.title}${if (it.where.isNotEmpty()) " · " + it.where else ""}\n${it.snippet}" }.toTypedArray()
                    AlertDialog.Builder(this).setTitle("${hits.size}${if (hits.size >= 150) "+" else ""} places · tap to listen from there")
                        .setItems(labels) { _, w ->
                            val h = hits[w]
                            startActivity(Intent(this, ReaderActivity::class.java).putExtra("book", h.book.id).putExtra("para", h.para).putExtra("play", true))
                        }.setNegativeButton("Close", null).show()
                }
            }
        }
        .setNegativeButton("Cancel", null).show()
}

// ---------- about a book ----------
internal fun MainActivity.aboutBook(b: Book) {
    toast("Looking it up…")
    pool.execute {
        var info = ""; var subjects = listOf<String>(); var desc = ""; var key = ""
        try {
            val author = b.author.split(",", " and ").first().trim()
            val url = "https://openlibrary.org/search.json?title=" + java.net.URLEncoder.encode(b.title, "UTF-8") +
                (if (author.isNotEmpty()) "&author=" + java.net.URLEncoder.encode(author, "UTF-8") else "") +
                "&fields=key,first_publish_year,subject,number_of_pages_median,edition_count&limit=1"
            val d = org.json.JSONObject(Net.get(url)).optJSONArray("docs")?.optJSONObject(0)
            if (d != null) {
                key = d.optString("key")
                info = listOfNotNull(
                    d.optInt("first_publish_year").takeIf { it > 0 }?.let { "First published $it" },
                    d.optInt("number_of_pages_median").takeIf { it > 0 }?.let { "about $it pages" },
                    d.optInt("edition_count").takeIf { it > 0 }?.let { "$it editions" }
                ).joinToString(" · ")
                val sj = d.optJSONArray("subject")
                subjects = (0 until (sj?.length() ?: 0)).map { sj!!.getString(it) }
                    .filter { it.length < 40 && !Regex("(?i)accessible|protected|in library|lending|overdrive|large type|nyt:").containsMatchIn(it) }.take(10)
                if (key.isNotEmpty()) {
                    val w = org.json.JSONObject(Net.get("https://openlibrary.org$key.json"))
                    desc = w.optJSONObject("description")?.optString("value") ?: w.optString("description", "")
                    desc = desc.replace(Regex("\\[([^\\]]+)\\]\\([^)]*\\)"), "$1").replace(Regex("-{3,}[\\s\\S]*$"), "").trim()
                }
            }
        } catch (t: Throwable) { }
        val author = b.author.split(",", " and ").first().trim()
        val more = try { if (author.isNotEmpty()) Sources.gutenberg(author).filter { !it.title.equals(b.title, true) }.take(8) else emptyList() } catch (t: Throwable) { emptyList() }
        val related = try { subjects.firstOrNull()?.let { s -> Sources.gutenberg(s).filter { !it.title.equals(b.title, true) }.take(6) } ?: emptyList() } catch (t: Throwable) { emptyList() }
        runOnUiThread {
            val msg = StringBuilder()
            if (info.isNotEmpty()) msg.append(info).append("\n\n")
            msg.append(if (desc.isNotEmpty()) (if (desc.length > 1100) desc.take(1100) + "…" else desc) else "No description found.")
            if (subjects.isNotEmpty()) msg.append("\n\nSubjects: ").append(subjects.joinToString(", "))
            val picks = more + related
            val dlg = AlertDialog.Builder(this).setTitle(b.title).setMessage(msg.toString()).setNegativeButton("Close", null)
            if (picks.isNotEmpty()) dlg.setPositiveButton("More free books…") { _, _ ->
                val labels = picks.map { (if (it in more) "More by $author: " else "Related: ") + it.title }.toTypedArray()
                AlertDialog.Builder(this).setTitle("Free books from Project Gutenberg").setItems(labels) { _, w -> confirmDownload(picks[w]) }.show()
            }
            dlg.show()
        }
    }
}

internal fun MainActivity.editBook(b: Book) {
    val box = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(20), dp(8), dp(20), 0)
    }
    val t = EditText(this).apply { hint = "Title"; setText(b.title) }
    val a = EditText(this).apply { hint = "Author"; setText(b.author) }
    box.addView(t)
    box.addView(a)
    AlertDialog.Builder(this)
        .setTitle("Edit book")
        .setView(box)
        .setPositiveButton("Save") { _, _ ->
            val nb = b.copy(title = t.text.toString().trim().ifEmpty { b.title }, author = a.text.toString().trim())
            Library.update(this, nb)
            Covers.invalidate(b.id)
            refreshLibrary()
        }
        .setNegativeButton("Cancel", null)
        .show()
}

internal fun MainActivity.confirmDelete(b: Book) {
    AlertDialog.Builder(this)
        .setTitle("Remove book?")
        .setMessage("“${b.title}” will be deleted from this phone, along with its bookmarks and notes.")
        .setPositiveButton("Remove") { _, _ ->
            if (TtsService.instance?.bookId == b.id) {
                startService(Intent(this, TtsService::class.java).setAction(TtsService.ACTION_STOP))
            }
            Library.remove(this, b)
            refreshLibrary()
        }
        .setNegativeButton("Cancel", null)
        .show()
}
