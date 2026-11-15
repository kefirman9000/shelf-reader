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

/** An ImageView that is always 2:3, like a book cover. */
private class CoverImage(ctx: Context) : ImageView(ctx) {
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        super.onMeasure(widthMeasureSpec, heightMeasureSpec)
        setMeasuredDimension(measuredWidth, (measuredWidth * 1.5f).toInt())
    }
}

private class Cell(
    val shelf: Boolean,
    val root: View,
    val img: ImageView,
    val bar: ProgressBar,
    val badge: TextView,
    val title: TextView?,
    val sub: TextView?
)

class MainActivity : Activity() {

    companion object {
        private val VIEW_NAMES = listOf("Shelf", "Grid", "List")
        private val SORT_NAMES = listOf("Recent", "Title", "Author", "Progress")
        private const val WOOD_BG = 0xFF2B1D14.toInt()
    }

    private lateinit var libraryPane: View
    private lateinit var libraryList: ListView
    private lateinit var libraryGrid: GridView
    private lateinit var libraryEmpty: TextView
    private lateinit var continueBar: View
    private lateinit var continueText: TextView
    private lateinit var viewBtn: Button
    private lateinit var sortBtn: Button
    private lateinit var filterBtn: Button
    private var shelfAdapter: ShelfAdapter? = null
    private var pendingCoverBook: String? = null
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
    private val pool = Executors.newFixedThreadPool(8)

    private val sources: List<Pair<String, (String) -> List<SearchResult>>> = listOf(
        "Gutenberg" to { s -> Sources.gutenberg(s) },
        "Standard Ebooks" to { s -> Sources.standardEbooks(s) },
        "Internet Archive" to { s -> Sources.archive(s) },
        "Open Library" to { s -> Sources.openLibrary(s) },
        "Wikisource" to { s -> Sources.wikisource(s) },
        "Feedbooks" to { s -> Sources.feedbooks(s) }
    )

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

        // Library pane: continue bar, view/sort bar, then shelf/grid/list
        val lib = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }

        continueText = TextView(this).apply {
            textSize = 15f
            maxLines = 2
            setPadding(dp(16), dp(10), dp(8), dp(10))
        }
        val continuePlay = Button(this).apply { text = "▶ Play" }
        continueBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(0x2266AAFF)
            addView(continueText, LinearLayout.LayoutParams(0, WRAP, 1f))
            addView(continuePlay)
        }
        continueText.setOnClickListener { Settings.lastBook(this)?.let { id -> Library.get(this, id)?.let { openBook(it) } } }
        continuePlay.setOnClickListener {
            Settings.lastBook(this)?.let { id ->
                startForegroundService(
                    Intent(this, TtsService::class.java).setAction(TtsService.ACTION_PLAY).putExtra(TtsService.EXTRA_BOOK, id)
                )
                toast("Reading aloud. Controls are in your notifications.")
            }
        }
        lib.addView(continueBar)

        val bar = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        viewBtn = Button(this).apply {
            setOnClickListener {
                AlertDialog.Builder(this@MainActivity).setTitle("Library view")
                    .setItems(VIEW_NAMES.toTypedArray()) { _, w -> Settings.setLibraryView(this@MainActivity, w); refreshLibrary() }
                    .show()
            }
        }
        sortBtn = Button(this).apply {
            setOnClickListener {
                AlertDialog.Builder(this@MainActivity).setTitle("Sort by")
                    .setItems(SORT_NAMES.toTypedArray()) { _, w -> Settings.setLibrarySort(this@MainActivity, w); refreshLibrary() }
                    .show()
            }
        }
        filterBtn = Button(this).apply {
            setOnClickListener {
                val names = listOf("All books") + Collections.names(this@MainActivity) + "Manage collections…"
                AlertDialog.Builder(this@MainActivity).setTitle("Show")
                    .setItems(names.toTypedArray()) { _, w ->
                        when (w) {
                            0 -> Settings.setLibraryFilter(this@MainActivity, "")
                            names.size - 1 -> { manageCollections(); return@setItems }
                            else -> Settings.setLibraryFilter(this@MainActivity, names[w])
                        }
                        refreshLibrary()
                    }.show()
            }
        }
        bar.addView(filterBtn, LinearLayout.LayoutParams(0, WRAP, 1.2f))
        bar.addView(viewBtn, LinearLayout.LayoutParams(0, WRAP, 1f))
        bar.addView(sortBtn, LinearLayout.LayoutParams(0, WRAP, 1f))
        lib.addView(bar)

        val holder = FrameLayout(this)
        libraryGrid = GridView(this).apply {
            numColumns = GridView.AUTO_FIT
            columnWidth = dp(112)
            stretchMode = GridView.STRETCH_COLUMN_WIDTH
            clipToPadding = false
        }
        libraryList = ListView(this)
        libraryEmpty = TextView(this).apply {
            text = emptyText
            gravity = Gravity.CENTER
            textSize = 16f
            setPadding(dp(32), dp(32), dp(32), dp(32))
        }
        holder.addView(libraryGrid, FrameLayout.LayoutParams(MATCH, MATCH))
        holder.addView(libraryList, FrameLayout.LayoutParams(MATCH, MATCH))
        holder.addView(libraryEmpty, FrameLayout.LayoutParams(MATCH, MATCH))
        lib.addView(holder, LinearLayout.LayoutParams(MATCH, 0, 1f))
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
            text = "Searches free, legal sources: Project Gutenberg, Standard Ebooks, the Internet Archive " +
                "(public-domain and open-access books), Open Library, Wikisource and Feedbooks."
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

        val open = AdapterView.OnItemClickListener { _, _, pos, _ -> openBook(books[pos]) }
        val menu = AdapterView.OnItemLongClickListener { _, _, pos, _ -> bookMenu(books[pos]); true }
        libraryList.onItemClickListener = open
        libraryList.onItemLongClickListener = menu
        libraryGrid.onItemClickListener = open
        libraryGrid.onItemLongClickListener = menu
        resultsList.setOnItemClickListener { _, _, pos, _ -> confirmDownload(results[pos]) }

        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
        showTab(false)

        if (System.currentTimeMillis() - Settings.lastUpdateCheck(this) > 6 * 60 * 60 * 1000L) checkUpdates(false)
        if (!Settings.seenVoiceGuide(this)) showVoiceGuide(this)
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

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menu.add(0, 1, 0, "Pronunciation fixes")
        menu.add(0, 3, 0, "Voice setup guide")
        menu.add(0, 4, 0, "Resume when headphones connect").setCheckable(true).isChecked = Settings.resumeOnHeadphones(this)
        menu.add(0, 5, 0, "Back up library…")
        menu.add(0, 6, 0, "Restore from backup…")
        menu.add(0, 2, 0, "Check for updates")
        return true
    }

    override fun onPrepareOptionsMenu(menu: Menu): Boolean {
        menu.findItem(4)?.isChecked = Settings.resumeOnHeadphones(this)
        return super.onPrepareOptionsMenu(menu)
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        when (item.itemId) {
            1 -> editPronunciations { TtsService.instance?.applySettings(true) }
            2 -> checkUpdates(true)
            3 -> showVoiceGuide(this)
            4 -> {
                val v = !Settings.resumeOnHeadphones(this)
                Settings.setResumeOnHeadphones(this, v)
                toast(if (v) "Will resume a paused book when headphones connect" else "Headphone auto-resume off")
            }
            5 -> {
                val name = "ShelfReader-backup-" + SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date()) + ".zip"
                try {
                    @Suppress("DEPRECATION")
                    startActivityForResult(
                        Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                            .setType("application/zip").putExtra(Intent.EXTRA_TITLE, name), 45
                    )
                } catch (e: Throwable) { toast("No file picker available") }
            }
            6 -> {
                try {
                    @Suppress("DEPRECATION")
                    startActivityForResult(
                        Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
                            .putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/zip", "application/x-zip-compressed", "application/octet-stream")), 46
                    )
                } catch (e: Throwable) { toast("No file picker available") }
            }
            else -> return super.onOptionsItemSelected(item)
        }
        return true
    }

    private fun showTab(search: Boolean) {
        showingSearch = search
        searchPane.visibility = if (search) View.VISIBLE else View.GONE
        libraryPane.visibility = if (search) View.GONE else View.VISIBLE
        tabSearch.alpha = if (search) 1f else 0.55f
        tabLibrary.alpha = if (search) 0.55f else 1f
        if (search) searchBox.requestFocus() else refreshLibrary()
    }

    private val emptyText = "No books yet.\n\nTap “Find books” to search Project Gutenberg, Standard Ebooks, the Internet Archive, " +
        "Open Library, Wikisource and Feedbooks, or “Import” to open an EPUB, PDF or TXT file from your phone."

    private fun manageCollections() {
        val custom = Collections.names(this).drop(2)
        if (custom.isEmpty()) {
            toast("You haven't made any collections yet. Long-press a book → Collections… → New collection.")
            return
        }
        AlertDialog.Builder(this).setTitle("Delete a collection").setItems(custom.toTypedArray()) { _, w ->
            AlertDialog.Builder(this)
                .setMessage("Delete the collection “${custom[w]}”? The books stay in your library.")
                .setPositiveButton("Delete") { _, _ -> Collections.delete(this, custom[w]); refreshLibrary() }
                .setNegativeButton("Cancel", null)
                .show()
        }.show()
    }

    private fun sortKey(s: String) = s.lowercase().replace(Regex("^(the|a|an)\\s+"), "")

    private fun refreshLibrary() {
        val all = Library.load(this)
        var filter = Settings.libraryFilter(this)
        if (filter.isNotEmpty() && filter !in Collections.names(this)) { filter = ""; Settings.setLibraryFilter(this, "") }
        val shown = if (filter.isEmpty()) all else all.filter { filter in Collections.of(this, it.id) }
        filterBtn.text = if (filter.isEmpty()) "All books ▾" else "$filter ▾"
        books = when (Settings.librarySort(this)) {
            1 -> shown.sortedBy { sortKey(it.title) }
            2 -> shown.sortedWith(compareBy({ sortKey(it.author.substringAfterLast(' ').ifBlank { "~" }) }, { sortKey(it.title) }))
            3 -> shown.sortedByDescending { Library.percent(this, it) }
            else -> shown.sortedByDescending { maxOf(Library.opened(this, it.id), it.added) }
        }
        val mode = Settings.libraryView(this).coerceIn(0, 2)
        viewBtn.text = "View: ${VIEW_NAMES[mode]}"
        sortBtn.text = "Sort: ${SORT_NAMES[Settings.librarySort(this).coerceIn(0, 3)]}"
        libraryEmpty.visibility = if (books.isEmpty()) View.VISIBLE else View.GONE
        if (books.isEmpty() && all.isNotEmpty()) libraryEmpty.text = "No books in “$filter” yet.\n\nLong-press a book → Collections… to add it."
        else libraryEmpty.text = emptyText

        if (mode == 2) {
            libraryGrid.visibility = View.GONE
            libraryList.visibility = View.VISIBLE
            libraryList.adapter = TwoLineAdapter(this, books.map {
                it.title to "${it.author.ifBlank { "Unknown author" }} · ${it.format.uppercase()} · ${Library.percent(this, it)}% read"
            })
        } else {
            val shelf = mode == 0
            libraryList.visibility = View.GONE
            libraryGrid.visibility = View.VISIBLE
            libraryGrid.setBackgroundColor(if (shelf) WOOD_BG else Color.TRANSPARENT)
            libraryGrid.horizontalSpacing = if (shelf) 0 else dp(10)
            libraryGrid.verticalSpacing = if (shelf) 0 else dp(14)
            libraryGrid.setPadding(if (shelf) 0 else dp(10), dp(if (shelf) 0 else 10), if (shelf) 0 else dp(10), dp(16))
            val a = ShelfAdapter(shelf)
            shelfAdapter = a
            libraryGrid.adapter = a
        }

        // "Continue" bar for the last book you were reading
        val last = Settings.lastBook(this)?.let { id -> all.firstOrNull { it.id == id } }
        continueBar.visibility = if (last != null) View.VISIBLE else View.GONE
        if (last != null) continueText.text = "Continue “${last.title}” · ${Library.percent(this, last)}%"
    }

    private fun openBook(b: Book) {
        startActivity(Intent(this, ReaderActivity::class.java).putExtra("book", b.id))
    }

    // ---------- shelf / grid ----------

    private inner class ShelfAdapter(private val shelf: Boolean) : BaseAdapter() {
        override fun getCount() = books.size
        override fun getItem(position: Int): Any = books[position]
        override fun getItemId(position: Int) = position.toLong()

        override fun getView(position: Int, convertView: View?, parent: ViewGroup?): View {
            val cell = (convertView?.tag as? Cell)?.takeIf { it.shelf == shelf } ?: makeCell(shelf)
            val b = books[position]
            val bmp = Covers.get(this@MainActivity, b) { libraryGrid.invalidateViews() }
            if (bmp != null) cell.img.setImageBitmap(bmp) else cell.img.setImageDrawable(ColorDrawable(Covers.color(b)))
            val pct = Library.percent(this@MainActivity, b)
            cell.bar.progress = pct
            cell.bar.visibility = if (pct > 0) View.VISIBLE else View.INVISIBLE
            cell.badge.visibility = if (TtsService.instance?.let { it.bookId == b.id && it.playing } == true) View.VISIBLE else View.GONE
            cell.title?.text = b.title
            cell.sub?.text = if (pct > 0) "$pct% · ${b.author.ifBlank { "Unknown" }}" else b.author.ifBlank { "Unknown author" }
            return cell.root
        }
    }

    private fun makeCell(shelf: Boolean): Cell {
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val frame = FrameLayout(this).apply {
            if (shelf) setPadding(dp(9), dp(18), dp(9), 0) else setPadding(0, 0, 0, 0)
            clipToPadding = false
        }
        val coverBg = GradientDrawable().apply { setColor(Color.DKGRAY); cornerRadius = dp(3).toFloat() }
        val img = CoverImage(this).apply {
            scaleType = ImageView.ScaleType.CENTER_CROP
            background = coverBg
            outlineProvider = ViewOutlineProvider.BACKGROUND
            clipToOutline = true
            elevation = dp(5).toFloat()
        }
        frame.addView(img, FrameLayout.LayoutParams(MATCH, WRAP))
        val bar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            elevation = dp(6).toFloat()
        }
        frame.addView(bar, FrameLayout.LayoutParams(MATCH, dp(5), Gravity.BOTTOM))
        val badge = TextView(this).apply {
            text = "▶"
            textSize = 12f
            setTextColor(Color.WHITE)
            setPadding(dp(6), dp(2), dp(6), dp(2))
            background = GradientDrawable().apply { setColor(0xCC2E5E4E.toInt()); cornerRadius = dp(8).toFloat() }
            elevation = dp(7).toFloat()
        }
        frame.addView(badge, FrameLayout.LayoutParams(WRAP, WRAP, Gravity.TOP or Gravity.END).apply { setMargins(0, dp(4), dp(4), 0) })
        root.addView(frame)

        var title: TextView? = null
        var sub: TextView? = null
        if (shelf) {
            val plank = View(this).apply {
                background = GradientDrawable(
                    GradientDrawable.Orientation.TOP_BOTTOM,
                    intArrayOf(0xFFA87449.toInt(), 0xFF7A4E2D.toInt(), 0xFF4A2E19.toInt())
                )
            }
            root.addView(plank, LinearLayout.LayoutParams(MATCH, dp(14)))
            val shadow = View(this).apply {
                background = GradientDrawable(
                    GradientDrawable.Orientation.TOP_BOTTOM,
                    intArrayOf(0x88000000.toInt(), 0x00000000)
                )
            }
            root.addView(shadow, LinearLayout.LayoutParams(MATCH, dp(8)))
        } else {
            title = TextView(this).apply {
                textSize = 13f
                maxLines = 2
                setTypeface(typeface, android.graphics.Typeface.BOLD)
                setPadding(0, dp(6), 0, 0)
            }
            sub = TextView(this).apply {
                textSize = 11f
                maxLines = 1
                alpha = 0.7f
            }
            root.addView(title)
            root.addView(sub)
        }
        val cell = Cell(shelf, root, img, bar, badge, title, sub)
        root.tag = cell
        return cell
    }

    // ---------- per-book actions ----------

    private fun bookMenu(b: Book) {
        val items = arrayOf("Open", "Read aloud now", "Edit title & author", "Change cover…", "Reset cover", "Remove from library", "Collections…", "Car mode")
        AlertDialog.Builder(this).setTitle(b.title).setItems(items) { _, w ->
            when (w) {
                0 -> openBook(b)
                1 -> {
                    startForegroundService(
                        Intent(this, TtsService::class.java).setAction(TtsService.ACTION_PLAY).putExtra(TtsService.EXTRA_BOOK, b.id)
                    )
                    toast("Reading “${b.title}” aloud")
                }
                2 -> editBook(b)
                3 -> {
                    pendingCoverBook = b.id
                    try {
                        @Suppress("DEPRECATION")
                        startActivityForResult(
                            Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("image/*"), 44
                        )
                    } catch (e: Throwable) { toast("No picture picker available") }
                }
                4 -> { Covers.reset(this, b); refreshLibrary() }
                5 -> confirmDelete(b)
                6 -> editCollections(this, b.id) { refreshLibrary() }
                7 -> startActivity(Intent(this, CarModeActivity::class.java).putExtra("book", b.id))
            }
        }.show()
    }

    private fun editBook(b: Book) {
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

    private fun confirmDelete(b: Book) {
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

    // ---------- updates ----------

    private fun checkUpdates(manual: Boolean) {
        if (manual) toast("Checking GitHub for updates…")
        pool.execute {
            try {
                val r = Updater.latest()
                val cur = Updater.currentBuild(this)
                Settings.setLastUpdateCheck(this, System.currentTimeMillis())
                runOnUiThread {
                    if (r != null && r.build > cur) {
                        AlertDialog.Builder(this)
                            .setTitle("Update available")
                            .setMessage("Build ${r.build} is ready (you have build $cur).")
                            .setPositiveButton("Install") { _, _ -> installUpdate(r) }
                            .setNegativeButton("Later", null)
                            .show()
                    } else if (manual) {
                        toast("You're up to date (build $cur).")
                    }
                }
            } catch (t: Throwable) {
                if (manual) runOnUiThread {
                    toast("Couldn't check for updates (${t.message}). The GitHub repo needs to be public for this to work.")
                }
            }
        }
    }

    private fun installUpdate(r: Updater.Release) {
        toast("Downloading update…")
        pool.execute {
            try {
                val f = File(cacheDir, "update.apk")
                f.delete()
                Net.download(r.url, f) { _, _ -> }
                runOnUiThread { toast("Installing — confirm on the next screen.") }
                Updater.install(this, f)
            } catch (t: Throwable) {
                runOnUiThread { toast("Update failed: ${t.message}") }
            }
        }
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
                val head = if (pending > 0) "Searching… " else ""
                val tail = if (errors.isNotEmpty()) " (couldn't reach " + errors.joinToString(", ") + ")" else ""
                searchStatus.text = "$head${results.size} results$tail. Tap one to download."
            }
        }

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

    /** Book details (cover, description, info) before downloading. */
    private fun confirmDownload(r: SearchResult) {
        if (busy) { toast("Already downloading — one moment."); return }
        val img = ImageView(this).apply {
            scaleType = ImageView.ScaleType.CENTER_CROP
            setBackgroundColor(0x33888888)
        }
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), 0, 0, 0)
            addView(TextView(this@MainActivity).apply {
                text = r.title; textSize = 18f; setTypeface(typeface, android.graphics.Typeface.BOLD)
            })
            addView(TextView(this@MainActivity).apply {
                text = r.author.ifBlank { "Unknown author" }; textSize = 15f; setPadding(0, dp(4), 0, 0)
            })
            addView(TextView(this@MainActivity).apply {
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
            addView(TextView(this@MainActivity).apply {
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

    private fun checkFile(f: File, fmt: String) {
        val head = ByteArray(5)
        val n = f.inputStream().use { it.read(head) }
        val ok = when (fmt) {
            "epub" -> n >= 2 && head[0] == 'P'.code.toByte() && head[1] == 'K'.code.toByte()
            "pdf" -> n >= 4 && String(head, 0, 4, Charsets.US_ASCII) == "%PDF"
            else -> true
        }
        if (!ok) throw Exception("the site sent a web page instead of the book file")
    }

    private fun download(r: SearchResult, later: Boolean = false) {
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
                    if (later) {
                        searchStatus.text = "Added “${r.title}” to Want to read."
                    } else {
                        searchStatus.text = "Added “${r.title}” to your library."
                        openBook(book)
                    }
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
        if (requestCode == 45 && resultCode == RESULT_OK) {
            val uri = data?.data ?: return
            toast("Backing up…")
            pool.execute {
                val msg = try {
                    contentResolver.openOutputStream(uri)?.use { Backup.write(this, it) } ?: throw Exception("couldn't open the file")
                    "Backup saved."
                } catch (t: Throwable) { "Backup failed: ${t.message}" }
                runOnUiThread { toast(msg) }
            }
        }
        if (requestCode == 46 && resultCode == RESULT_OK) {
            val uri = data?.data ?: return
            toast("Restoring…")
            pool.execute {
                val msg = try {
                    val n = contentResolver.openInputStream(uri)?.use { Backup.restore(this, it) } ?: throw Exception("couldn't open the file")
                    "Restored. $n book${if (n == 1) "" else "s"} added; places, notes and settings brought back."
                } catch (t: Throwable) { "Restore failed: ${t.message}" }
                runOnUiThread { toast(msg); refreshLibrary() }
            }
        }
        if (requestCode == 44 && resultCode == RESULT_OK) {
            val uri = data?.data ?: return
            val b = pendingCoverBook?.let { Library.get(this, it) } ?: return
            pool.execute {
                val ok = try { Covers.setFromUri(this, b, uri) } catch (t: Throwable) { false }
                runOnUiThread { if (ok) refreshLibrary() else toast("Couldn't use that picture.") }
            }
        }
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
                Library.doc(this, book)
                Library.add(this, book)
                runOnUiThread { refreshLibrary(); openBook(book) }
            } catch (t: Throwable) {
                file.delete()
                runOnUiThread { toast("Couldn't import: ${t.message ?: t.javaClass.simpleName}") }
            }
        }
    }
}
