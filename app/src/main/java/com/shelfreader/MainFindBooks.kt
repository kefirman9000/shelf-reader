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

internal fun MainActivity.doSearch() {
    val q = searchBox.text.toString().trim()
    if (q.isEmpty()) return
    (getSystemService(android.content.Context.INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(searchBox.windowToken, 0)
    val gen = ++searchGen
    results.clear()
    updateResults()
    suggestBox.visibility = View.GONE
    searchProgress.isIndeterminate = true
    searchProgress.visibility = View.VISIBLE
    searchStatus.text = "Searching 6 free libraries…"
    val errors = ArrayList<String>()
    val seen = HashSet<String>()
    var pending = sources.size

    fun finishOne(source: String, list: List<SearchResult>?, err: Throwable?) {
        runOnUiThread {
            if (gen != searchGen) return@runOnUiThread
            pending--
            if (list != null) {
                for (r in list) {
                    val key = r.iaId ?: r.url ?: r.title
                    if (seen.add(key)) results.add(r)
                }
            }
            if (err != null) errors.add(source)
            updateResults()
            if (pending <= 0 && !busy) searchProgress.visibility = View.GONE
            val tail = if (errors.isNotEmpty()) " (couldn't reach " + errors.joinToString(", ") + ")" else ""
            searchStatus.text = when {
                pending > 0 -> "Searching… ${results.size} found so far$tail"
                results.isEmpty() && errors.size == sources.size -> "Couldn't reach any library. Check your internet connection and try again."
                results.isEmpty() -> "No free books found for “$q”$tail.\n\nTry fewer words, just the author's last name, or check the spelling. " +
                    "Newer books are usually not free."
                else -> "${results.size} book${if (results.size == 1) "" else "s"} found$tail. Tap one to see details and download."
            }
            if (pending <= 0 && results.isEmpty()) suggestBox.visibility = View.VISIBLE
        }
    }

    for ((name, fn) in sources) {
        pool.execute {
            try { finishOne(name, fn(q), null) } catch (t: Throwable) { finishOne(name, null, t) }
        }
    }
}

/** Best matches first: the words you typed in the author or title. */
internal fun MainActivity.score(r: SearchResult, q: String): Int {
    val words = q.lowercase().split(Regex("\\s+")).filter { it.length > 1 }
    val a = r.author.lowercase(); val t = r.title.lowercase()
    var s = 0
    if (a.contains(q.lowercase())) s += 50
    if (t.contains(q.lowercase())) s += 40
    for (w in words) { if (a.contains(w)) s += 10; if (t.contains(w)) s += 8 }
    if (r.url != null || r.source.contains("Standard")) s += 3
    return s
}

internal fun MainActivity.updateResults() {
    val q = searchBox.text.toString().trim()
    val sorted = results.withIndex().sortedWith(compareByDescending<IndexedValue<SearchResult>> { score(it.value, q) }.thenBy { it.index }).map { it.value }
    results.clear(); results.addAll(sorted)
    resultsList.adapter = ResultAdapter()
}

/** Book details (cover, description, info) before downloading. */
internal fun MainActivity.confirmDownload(r: SearchResult) {
    if (busy) { toast("Already downloading — one moment."); return }
    val img = ImageView(this).apply {
        scaleType = ImageView.ScaleType.CENTER_CROP
        setBackgroundColor(0x33888888)
    }
    val col = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(14), 0, 0, 0)
        addView(TextView(this@confirmDownload).apply {
            text = r.title; textSize = 18f; setTypeface(typeface, android.graphics.Typeface.BOLD)
        })
        addView(TextView(this@confirmDownload).apply {
            text = r.author.ifBlank { "Unknown author" }; textSize = 15f; setPadding(0, dp(4), 0, 0)
        })
        addView(TextView(this@confirmDownload).apply {
            text = "From ${r.source}" + (r.info?.let { "\n$it" } ?: ""); textSize = 13f; alpha = 0.7f; setPadding(0, dp(6), 0, 0)
        })
    }
    val top = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        addView(img, LinearLayout.LayoutParams(dp(96), dp(144)))
        addView(col, LinearLayout.LayoutParams(0, WRAP, 1f))
    }
    val body = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(20), dp(16), dp(20), dp(8))
        addView(top)
        addView(TextView(this@confirmDownload).apply {
            text = r.description ?: "No description available."
            textSize = 15f
            setLineSpacing(0f, 1.2f)
            setPadding(0, dp(14), 0, 0)
        })
    }
    if (r.cover != null) {
        pool.execute {
            val bmp = Covers.fromUrl(r.cover)
            if (bmp != null) runOnUiThread { img.setImageBitmap(bmp) }
        }
    } else {
        img.visibility = View.GONE
    }
    AlertDialog.Builder(this)
        .setView(ScrollView(this).apply { addView(body) })
        .setPositiveButton("Download") { _, _ -> download(r) }
        .setNeutralButton("Download for later") { _, _ -> download(r, later = true) }
        .setNegativeButton("Cancel", null)
        .show()
}

internal fun MainActivity.checkFile(f: File, fmt: String) {
    val head = ByteArray(5)
    val n = f.inputStream().use { it.read(head) }
    val ok = when (fmt) {
        "epub" -> n >= 2 && head[0] == 'P'.code.toByte() && head[1] == 'K'.code.toByte()
        "pdf" -> n >= 4 && String(head, 0, 4, Charsets.US_ASCII) == "%PDF"
        else -> true
    }
    if (!ok) throw Exception("the site sent a web page instead of the book file")
}

internal fun MainActivity.download(r: SearchResult, later: Boolean = false) {
    busy = true
    searchStatus.text = "Getting “${r.title}”…"
    searchProgress.isIndeterminate = true
    searchProgress.visibility = View.VISIBLE
    pool.execute {
        var dest: File? = null
        try {
            val (url, fmt) = if (r.url != null && r.format != null) r.url to r.format
            else Sources.resolveArchive(r.iaId ?: throw Exception("missing item id"))
            val id = "b" + System.currentTimeMillis()
            val file = File(Library.dir(this), "$id.$fmt")
            dest = file
            Net.download(url, file) { done, total ->
                runOnUiThread {
                    if (total > 0) { searchProgress.isIndeterminate = false; searchProgress.progress = (done * 100 / total).toInt() }
                    searchStatus.text = "Downloading “${r.title}”… " +
                        if (total > 0) "${done * 100 / total}%" else "${done / 1024} KB"
                }
            }
            checkFile(file, fmt)
            runOnUiThread { searchStatus.text = "Preparing text and chapters…" }
            var title = r.title
            var author = r.author
            if (fmt == "epub" && author.isBlank()) {
                val (t, a) = Extract.epubInfo(file)
                if (!a.isNullOrBlank()) author = a
                if (title.isBlank() && !t.isNullOrBlank()) title = t
            }
            val book = Book(id, title, author, file.name, fmt, System.currentTimeMillis())
            Library.doc(this, book) // extract now so problems show up here
            r.cover?.let {
                runOnUiThread { searchStatus.text = "Getting the cover…" }
                Covers.fetch(this, id, it)
            }
            Library.add(this, book)
            if (later) Collections.add(this, id, Collections.WANT)
            runOnUiThread {
                busy = false
                searchProgress.visibility = View.GONE
                if (later) {
                    searchStatus.text = "Added “${r.title}” to your library, in Want to read."
                    toast("Saved for later")
                } else {
                    searchStatus.text = "Added “${r.title}” to your library."
                    openBook(book)
                }
            }
        } catch (t: Throwable) {
            dest?.delete()
            runOnUiThread {
                busy = false
                searchProgress.visibility = View.GONE
                searchStatus.text = "Couldn't get that book: ${t.message ?: t.javaClass.simpleName}. " +
                    "Try another copy from the list — the same book is often on several sites."
            }
        }
    }
}
