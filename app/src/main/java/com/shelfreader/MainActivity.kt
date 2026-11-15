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
import android.view.Gravity
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView
import java.io.File
import java.util.concurrent.Executors

class MainActivity : Activity() {

    private lateinit var libraryPane: View
    private lateinit var libraryList: ListView
    private lateinit var libraryEmpty: TextView
    private lateinit var searchPane: View
    private lateinit var searchBox: EditText
    private lateinit var searchStatus: TextView
    private lateinit var resultsList: ListView
    private lateinit var tabLibrary: Button
    private lateinit var tabSearch: Button

    private var books: List<Book> = emptyList()
    private val results = ArrayList<SearchResult>()
    private var searchGen = 0
    private var busy = false
    private var showingSearch = false
    private val pool = Executors.newFixedThreadPool(4)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }

        val tabs = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        tabLibrary = Button(this).apply { text = "Library"; setOnClickListener { showTab(false) } }
        tabSearch = Button(this).apply { text = "Find books"; setOnClickListener { showTab(true) } }
        val importBtn = Button(this).apply { text = "Import"; setOnClickListener { pickFile() } }
        for (b in listOf(tabLibrary, tabSearch, importBtn)) {
            tabs.addView(b, LinearLayout.LayoutParams(0, WRAP, 1f))
        }
        root.addView(tabs)

        // Library pane
        val lib = FrameLayout(this)
        libraryList = ListView(this)
        libraryEmpty = TextView(this).apply {
            text = "No books yet.\n\nTap “Find books” to search Project Gutenberg, the Internet Archive and Open Library, " +
                "or “Import” to open an EPUB, PDF or TXT file from your phone."
            gravity = Gravity.CENTER
            textSize = 16f
            setPadding(dp(32), dp(32), dp(32), dp(32))
        }
        lib.addView(libraryList, FrameLayout.LayoutParams(MATCH, MATCH))
        lib.addView(libraryEmpty, FrameLayout.LayoutParams(MATCH, MATCH))
        libraryPane = lib

        // Search pane
        val search = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(dp(8), dp(4), dp(8), 0)
        }
        searchBox = EditText(this).apply {
            hint = "Title or author"
            isSingleLine = true
            imeOptions = EditorInfo.IME_ACTION_SEARCH
            setOnEditorActionListener { _, id, _ ->
                if (id == EditorInfo.IME_ACTION_SEARCH) { doSearch(); true } else false
            }
        }
        val go = Button(this).apply { text = "Search"; setOnClickListener { doSearch() } }
        row.addView(searchBox, LinearLayout.LayoutParams(0, WRAP, 1f))
        row.addView(go)
        searchStatus = TextView(this).apply {
            setPadding(dp(16), dp(4), dp(16), dp(8))
            alpha = 0.8f
            text = "Searches free, legal sources: Project Gutenberg, the Internet Archive " +
                "(public-domain and open-access books) and Open Library."
        }
        resultsList = ListView(this)
        search.addView(row)
        search.addView(searchStatus)
        search.addView(resultsList, LinearLayout.LayoutParams(MATCH, 0, 1f))
        searchPane = search

        val content = FrameLayout(this)
        content.addView(libraryPane, FrameLayout.LayoutParams(MATCH, MATCH))
        content.addView(searchPane, FrameLayout.LayoutParams(MATCH, MATCH))
        root.addView(content, LinearLayout.LayoutParams(MATCH, 0, 1f))
        setContentView(root)

        libraryList.setOnItemClickListener { _, _, pos, _ -> openBook(books[pos]) }
        libraryList.setOnItemLongClickListener { _, _, pos, _ -> confirmDelete(books[pos]); true }
        resultsList.setOnItemClickListener { _, _, pos, _ -> confirmDownload(results[pos]) }

        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
        showTab(false)
    }

    override fun onResume() {
        super.onResume()
        if (!showingSearch) refreshLibrary()
    }

    override fun onDestroy() {
        pool.shutdown()
        super.onDestroy()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (showingSearch) showTab(false) else super.onBackPressed()
    }

    private fun showTab(search: Boolean) {
        showingSearch = search
        searchPane.visibility = if (search) View.VISIBLE else View.GONE
        libraryPane.visibility = if (search) View.GONE else View.VISIBLE
        tabSearch.alpha = if (search) 1f else 0.55f
        tabLibrary.alpha = if (search) 0.55f else 1f
        if (search) searchBox.requestFocus() else refreshLibrary()
    }

    private fun refreshLibrary() {
        books = Library.load(this).sortedByDescending { it.added }
        libraryEmpty.visibility = if (books.isEmpty()) View.VISIBLE else View.GONE
        libraryList.adapter = TwoLineAdapter(this, books.map {
            it.title to "${it.author.ifBlank { "Unknown author" }} · ${it.format.uppercase()} · ${Library.percent(this, it)}% read"
        })
    }

    private fun openBook(b: Book) {
        startActivity(Intent(this, ReaderActivity::class.java).putExtra("book", b.id))
    }

    private fun confirmDelete(b: Book) {
        AlertDialog.Builder(this)
            .setTitle("Remove book?")
            .setMessage("“${b.title}” will be deleted from this phone.")
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

    // ---------- search ----------

    private fun doSearch() {
        val q = searchBox.text.toString().trim()
        if (q.isEmpty()) return
        (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(searchBox.windowToken, 0)
        val gen = ++searchGen
        results.clear()
        updateResults()
        searchStatus.text = "Searching…"
        val errors = ArrayList<String>()
        val seen = HashSet<String>()
        var pending = 3

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
                if (err != null) errors.add("$source unavailable")
                updateResults()
                val head = if (pending > 0) "Searching… " else ""
                val tail = if (errors.isNotEmpty()) " (" + errors.joinToString(", ") + ")" else ""
                searchStatus.text = "$head${results.size} results$tail. Tap one to download."
            }
        }

        val sources: List<Pair<String, (String) -> List<SearchResult>>> = listOf(
            "Gutenberg" to { s -> Sources.gutenberg(s) },
            "Internet Archive" to { s -> Sources.archive(s) },
            "Open Library" to { s -> Sources.openLibrary(s) }
        )
        for ((name, fn) in sources) {
            pool.execute {
                try { finishOne(name, fn(q), null) } catch (t: Throwable) { finishOne(name, null, t) }
            }
        }
    }

    private fun updateResults() {
        resultsList.adapter = TwoLineAdapter(this, results.map {
            it.title to "${it.author.ifBlank { "Unknown author" }} · ${it.source}"
        })
    }

    private fun confirmDownload(r: SearchResult) {
        if (busy) { toast("Already downloading — one moment."); return }
        AlertDialog.Builder(this)
            .setTitle(r.title)
            .setMessage("${r.author.ifBlank { "Unknown author" }}\nFrom ${r.source}")
            .setPositiveButton("Download") { _, _ -> download(r) }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun download(r: SearchResult) {
        busy = true
        searchStatus.text = "Getting “${r.title}”…"
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
                        searchStatus.text = "Downloading… " +
                            if (total > 0) "${done * 100 / total}%" else "${done / 1024} KB"
                    }
                }
                runOnUiThread { searchStatus.text = "Preparing text…" }
                val book = Book(id, r.title, r.author, file.name, fmt, System.currentTimeMillis())
                Library.paragraphs(this, book) // extract now so problems show up here
                Library.add(this, book)
                runOnUiThread {
                    busy = false
                    searchStatus.text = "Added “${r.title}” to your library."
                    openBook(book)
                }
            } catch (t: Throwable) {
                dest?.delete()
                runOnUiThread {
                    busy = false
                    searchStatus.text = "Couldn't get that book: ${t.message ?: t.javaClass.simpleName}"
                }
            }
        }
    }

    // ---------- import ----------

    private fun pickFile() {
        val i = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/epub+zip", "application/pdf", "text/plain"))
        }
        try {
            @Suppress("DEPRECATION")
            startActivityForResult(i, 42)
        } catch (e: Throwable) {
            toast("No file picker available")
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == 42 && resultCode == RESULT_OK) data?.data?.let { importUri(it) }
    }

    private fun importUri(uri: Uri) {
        var name = "book"
        try {
            contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) name = c.getString(0) ?: name
            }
        } catch (e: Throwable) {}
        val mime = contentResolver.getType(uri) ?: ""
        val fmt = when {
            name.endsWith(".epub", true) || mime == "application/epub+zip" -> "epub"
            name.endsWith(".pdf", true) || mime == "application/pdf" -> "pdf"
            name.endsWith(".txt", true) || mime.startsWith("text/") -> "txt"
            else -> null
        }
        if (fmt == null) { toast("Only EPUB, PDF and TXT files are supported."); return }
        showTab(false)
        toast("Importing “$name”…")
        pool.execute {
            val id = "b" + System.currentTimeMillis()
            val file = File(Library.dir(this), "$id.$fmt")
            try {
                contentResolver.openInputStream(uri)?.use { input ->
                    file.outputStream().use { input.copyTo(it) }
                } ?: throw Exception("couldn't open the file")
                var title = name.substringBeforeLast('.')
                var author = ""
                if (fmt == "epub") {
                    val (t, a) = Extract.epubInfo(file)
                    if (!t.isNullOrBlank()) title = t
                    if (!a.isNullOrBlank()) author = a
                }
                val book = Book(id, title, author, file.name, fmt, System.currentTimeMillis())
                Library.paragraphs(this, book)
                Library.add(this, book)
                runOnUiThread { refreshLibrary(); openBook(book) }
            } catch (t: Throwable) {
                file.delete()
                runOnUiThread { toast("Couldn't import: ${t.message ?: t.javaClass.simpleName}") }
            }
        }
    }
}
