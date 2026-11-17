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

internal class Cell(
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
        internal val VIEW_NAMES = listOf("Shelf", "Grid", "List")
        internal val SORT_NAMES = listOf("Recent", "Title", "Author", "Progress")
        internal const val WOOD_BG = 0xFF2B1D14.toInt()
    }

    internal lateinit var libraryPane: View
    internal lateinit var libraryList: ListView
    internal lateinit var libraryGrid: GridView
    internal lateinit var libraryEmpty: TextView
    internal lateinit var continueBar: View
    internal lateinit var continueText: TextView
    internal lateinit var viewBtn: TextView
    internal lateinit var sortBtn: TextView
    internal lateinit var filterBtn: TextView
    internal var shelfAdapter: ShelfAdapter? = null
    internal var pendingCoverBook: String? = null
    internal lateinit var searchPane: View
    internal lateinit var searchBox: EditText
    internal lateinit var searchStatus: TextView
    internal lateinit var resultsList: ListView
    internal lateinit var tabs: List<LinearLayout>
    internal lateinit var topTitle: TextView
    internal lateinit var settingsPane: android.widget.ScrollView
    internal lateinit var emptyBox: LinearLayout
    internal lateinit var continueCover: ImageView
    internal lateinit var continueSub: TextView
    internal lateinit var continueProgress: ProgressBar
    internal lateinit var continuePlayBtn: TextView
    internal var tab = 0
    internal var topActions: List<View> = emptyList()
    internal lateinit var libraryQueryBox: EditText
    internal var libraryQuery = ""
    internal lateinit var searchProgress: ProgressBar
    internal lateinit var suggestBox: View
    internal lateinit var libraryTip: View

    internal var books: List<Book> = emptyList()
    internal val results = ArrayList<SearchResult>()
    internal var searchGen = 0
    internal var busy = false
    internal var showingSearch = false
    internal val pool = Executors.newFixedThreadPool(8)

    internal val sources: List<Pair<String, (String) -> List<SearchResult>>> = listOf(
        "Gutenberg" to { s -> Sources.gutenberg(s) },
        "Standard Ebooks" to { s -> Sources.standardEbooks(s) },
        "Internet Archive" to { s -> Sources.archive(s) },
        "Open Library" to { s -> Sources.openLibrary(s) },
        "Wikisource" to { s -> Sources.wikisource(s) },
        "Feedbooks" to { s -> Sources.feedbooks(s) }
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        CrashReport.install(this)
        intent?.getStringExtra("selftest_voice")?.let { SelfTest.run(applicationContext, it) }
        intent?.getStringExtra("selftest_read")?.let { SelfTest.read(applicationContext, it.ifBlank { null }?.takeIf { v -> v != "default" }) }
        if (intent?.getStringExtra("selftest_voice") == null && intent?.getStringExtra("selftest_read") == null) CrashReport.check(this)

        window.statusBarColor = UiColors.SURFACE
        window.navigationBarColor = UiColors.SURFACE
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(UiColors.BG) }

        // top bar
        val (bar0, titles) = topBar("Shelf Reader", null,
            "🔎" to ("Search inside your books" to { searchBooks() }),
            "＋" to ("Add a book from your phone" to { pickFile() }))
        topTitle = titles.first
        topActions = (bar0.childCount - 2 until bar0.childCount).map { bar0.getChildAt(it) }
        root.addView(bar0)

        // Library pane: continue card, chips, then shelf/grid/list
        val lib = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }

        continueCover = ImageView(this).apply { scaleType = ImageView.ScaleType.CENTER_CROP; background = roundBg(UiColors.SURFACE2, 6) ; clipToOutline = true }
        continueText = TextView(this).apply { textSize = 16f; maxLines = 2; setTextColor(UiColors.FG); setTypeface(typeface, android.graphics.Typeface.BOLD) }
        continueSub = TextView(this).apply { textSize = 13f; maxLines = 1; setTextColor(UiColors.MUTED) }
        continueProgress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply { max = 100; progressTintList = android.content.res.ColorStateList.valueOf(UiColors.ACCENT) }
        val texts = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; setPadding(dp(14), 0, dp(10), 0)
            addView(TextView(this@MainActivity).apply { text = "CONTINUE LISTENING"; textSize = 11f; letterSpacing = 0.08f; setTextColor(UiColors.ACCENT) })
            addView(continueText); addView(continueSub)
            addView(continueProgress, LinearLayout.LayoutParams(MATCH, dp(10)).apply { topMargin = dp(6) })
        }
        val continuePlay = iconBtn("▶", "Play", 60, filled = true) {
            Settings.lastBook(this)?.let { id ->
                val s = TtsService.instance
                if (s != null && s.bookId == id && s.playing) { s.pause(); refreshLibrary(); return@let }
                startForegroundService(Intent(this, TtsService::class.java).setAction(TtsService.ACTION_PLAY).putExtra(TtsService.EXTRA_BOOK, id))
                toast("Reading aloud. The controls are also in your notifications.")
                libraryGrid.postDelayed({ refreshLibrary() }, 800)
            }
        }
        continuePlayBtn = continuePlay
        continueBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            background = roundBg(UiColors.SURFACE, 16)
            setPadding(dp(12), dp(12), dp(12), dp(12))
            addView(continueCover, LinearLayout.LayoutParams(dp(54), dp(78)))
            addView(texts, LinearLayout.LayoutParams(0, WRAP, 1f))
            addView(continuePlay)
            setOnClickListener { Settings.lastBook(this@MainActivity)?.let { id -> Library.get(this@MainActivity, id)?.let { openBook(it) } } }
        }
        lib.addView(continueBar, LinearLayout.LayoutParams(MATCH, WRAP).apply { setMargins(dp(12), dp(12), dp(12), dp(4)) })

        val bar = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; setPadding(dp(12), dp(8), dp(12), dp(8)) }
        filterBtn = chip("All books ▾") {
            val cur = Settings.libraryFilter(this@MainActivity)
            val rows = ArrayList<SheetRow?>()
            rows += SheetRow(if (cur.isEmpty()) "✅" else "📚", "All books") { Settings.setLibraryFilter(this@MainActivity, ""); refreshLibrary() }
            for (n in Collections.names(this@MainActivity)) rows += SheetRow(if (cur == n) "✅" else "🗂", n) { Settings.setLibraryFilter(this@MainActivity, n); refreshLibrary() }
            rows += null
            rows += SheetRow("⚙", "Manage collections…") { manageCollections() }
            sheet("Show", rows)
        }
        viewBtn = chip("Grid ▾") {
            val icons = listOf("🪵", "▦", "☰"); val subs = listOf("Covers on wooden shelves", "Big covers", "Titles with details")
            sheet("Library view", VIEW_NAMES.mapIndexed { w, n -> SheetRow(if (Settings.libraryView(this@MainActivity) == w) "✅" else icons[w], n, subs[w]) { Settings.setLibraryView(this@MainActivity, w); refreshLibrary() } })
        }
        sortBtn = chip("Recent ▾") {
            val subs = listOf("Last opened first", "A to Z", "By author's name", "Furthest along first")
            sheet("Sort by", SORT_NAMES.mapIndexed { w, n -> SheetRow(if (Settings.librarySort(this@MainActivity) == w) "✅" else "↕", n, subs[w]) { Settings.setLibrarySort(this@MainActivity, w); refreshLibrary() } })
        }
        val gap = { LinearLayout.LayoutParams(WRAP, WRAP).apply { rightMargin = dp(8) } }
        bar.addView(filterBtn, gap()); bar.addView(viewBtn, gap()); bar.addView(sortBtn, gap())
        lib.addView(android.widget.HorizontalScrollView(this).apply { isHorizontalScrollBarEnabled = false; addView(bar) })

        // find a book in your own library (shown once the library is big enough to need it)
        libraryQueryBox = EditText(this).apply {
            setTextColor(UiColors.FG); setHintTextColor(UiColors.MUTED)
            background = roundBg(UiColors.SURFACE2, 22, UiColors.LINE)
            setPadding(dp(16), dp(9), dp(16), dp(9))
            textSize = 15f
            hint = "🔍  Find a book in your library"
            isSingleLine = true
            imeOptions = EditorInfo.IME_ACTION_DONE
            addTextChangedListener(object : android.text.TextWatcher {
                override fun afterTextChanged(e: android.text.Editable?) {
                    val q = e?.toString()?.trim() ?: ""
                    if (q != libraryQuery) { libraryQuery = q; refreshLibrary() }
                }
                override fun beforeTextChanged(a: CharSequence?, b: Int, c: Int, d: Int) {}
                override fun onTextChanged(a: CharSequence?, b: Int, c: Int, d: Int) {}
            })
        }
        lib.addView(libraryQueryBox, LinearLayout.LayoutParams(MATCH, WRAP).apply { setMargins(dp(12), 0, dp(12), dp(8)) })
        libraryTip = tipCard("library", "Tap a book to open it. Press and hold a book for more: read aloud, edit, collections, Up next or remove.")
        lib.addView(libraryTip, LinearLayout.LayoutParams(MATCH, WRAP).apply { setMargins(dp(12), 0, dp(12), dp(8)) })

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
            setTextColor(UiColors.MUTED)
            setPadding(dp(32), dp(32), dp(32), dp(12))
        }
        emptyBox = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            addView(TextView(this@MainActivity).apply { text = "📚"; textSize = 56f; gravity = Gravity.CENTER })
            addView(libraryEmpty)
            addView(pill("Find free books", true) { showTab(1) }, LinearLayout.LayoutParams(dp(240), WRAP).apply { bottomMargin = dp(10) })
            addView(pill("Add a book from your phone") { pickFile() }, LinearLayout.LayoutParams(dp(240), WRAP))
        }
        holder.addView(libraryGrid, FrameLayout.LayoutParams(MATCH, MATCH))
        holder.addView(libraryList, FrameLayout.LayoutParams(MATCH, MATCH))
        holder.addView(emptyBox, FrameLayout.LayoutParams(MATCH, MATCH))
        lib.addView(holder, LinearLayout.LayoutParams(MATCH, 0, 1f))
        libraryPane = lib

        // Search pane
        val search = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), dp(12), dp(12), 0)
        }
        searchBox = EditText(this).apply {
            setTextColor(UiColors.FG); setHintTextColor(UiColors.MUTED)
            background = roundBg(UiColors.SURFACE2, 22, UiColors.LINE)
            setPadding(dp(16), dp(10), dp(16), dp(10))
            textSize = 16f
            hint = "Search by title or author"
            isSingleLine = true
            imeOptions = EditorInfo.IME_ACTION_SEARCH
            setOnEditorActionListener { _, id, _ ->
                if (id == EditorInfo.IME_ACTION_SEARCH) { doSearch(); true } else false
            }
        }
        val go = pill("Search", true) { doSearch() }
        row.addView(searchBox, LinearLayout.LayoutParams(0, WRAP, 1f).apply { rightMargin = dp(8) })
        row.addView(go)
        searchStatus = TextView(this).apply {
            setPadding(dp(18), dp(10), dp(18), dp(8))
            setTextColor(UiColors.MUTED); textSize = 13f
            text = "Searches free, legal sources: Project Gutenberg, Standard Ebooks, the Internet Archive " +
                "(public-domain and open-access books), Open Library, Wikisource and Feedbooks."
        }
        resultsList = ListView(this)
        searchProgress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            isIndeterminate = true
            progressTintList = android.content.res.ColorStateList.valueOf(UiColors.ACCENT)
            indeterminateTintList = android.content.res.ColorStateList.valueOf(UiColors.ACCENT)
            visibility = View.GONE
        }
        // ideas to try when the search box is empty
        val ideas = listOf(
            listOf("Jane Austen", "Sherlock Holmes", "Mark Twain", "Edgar Allan Poe", "Charles Dickens"),
            listOf("Agatha Christie", "Jules Verne", "Fairy tales", "Ghost stories", "Shakespeare", "Philosophy")
        )
        suggestBox = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(4), dp(12), dp(4))
            addView(TextView(this@MainActivity).apply {
                text = "TRY"; textSize = 11f; letterSpacing = 0.08f; setTextColor(UiColors.ACCENT); setPadding(dp(6), 0, 0, dp(6))
            })
            for (line in ideas) {
                val r = LinearLayout(this@MainActivity).apply { orientation = LinearLayout.HORIZONTAL; setPadding(0, 0, 0, dp(8)) }
                for (idea in line) r.addView(chip(idea) { searchBox.setText(idea); searchBox.setSelection(idea.length); doSearch() },
                    LinearLayout.LayoutParams(WRAP, WRAP).apply { rightMargin = dp(8) })
                addView(android.widget.HorizontalScrollView(this@MainActivity).apply { isHorizontalScrollBarEnabled = false; addView(r) })
            }
        }
        search.addView(row)
        search.addView(searchProgress, LinearLayout.LayoutParams(MATCH, dp(4)).apply { setMargins(dp(14), dp(10), dp(14), 0) })
        search.addView(searchStatus)
        search.addView(suggestBox)
        search.addView(resultsList, LinearLayout.LayoutParams(MATCH, 0, 1f))
        searchPane = search

        settingsPane = android.widget.ScrollView(this)
        val content = FrameLayout(this)
        content.addView(libraryPane, FrameLayout.LayoutParams(MATCH, MATCH))
        content.addView(searchPane, FrameLayout.LayoutParams(MATCH, MATCH))
        content.addView(settingsPane, FrameLayout.LayoutParams(MATCH, MATCH))
        root.addView(content, LinearLayout.LayoutParams(MATCH, 0, 1f))

        // bottom tabs
        val nav = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; setBackgroundColor(UiColors.SURFACE); setPadding(0, dp(4), 0, dp(4)) }
        tabs = listOf("📚" to "Library", "🌐" to "Find books", "⚙" to "Settings").mapIndexed { k, (icon, label) ->
            LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER
                setPadding(0, dp(6), 0, dp(6))
                background = roundBg(0x00000000, 12)
                isClickable = true
                addView(TextView(this@MainActivity).apply { text = icon; textSize = 20f; gravity = Gravity.CENTER })
                addView(TextView(this@MainActivity).apply { text = label; textSize = 12f; gravity = Gravity.CENTER })
                setOnClickListener { showTab(k) }
            }.also { nav.addView(it, LinearLayout.LayoutParams(0, WRAP, 1f)) }
        }
        root.addView(nav)
        setContentView(root)

        val open = AdapterView.OnItemClickListener { _, _, pos, _ -> openBook(books[pos]) }
        val menu = AdapterView.OnItemLongClickListener { _, _, pos, _ -> Settings.setSeenTip(this, "library"); bookMenu(books[pos]); true }
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
        showTab(0)

        if (System.currentTimeMillis() - Settings.lastUpdateCheck(this) > 6 * 60 * 60 * 1000L) checkUpdates(false)
        if (!Settings.seenVoiceGuide(this)) showVoiceGuide(this)
    }

    override fun onResume() {
        super.onResume()
        if (tab == 0) refreshLibrary() else if (tab == 2) buildSettings()
        if (Settings.syncUri(this) != null && System.currentTimeMillis() - Settings.lastSync(this) > 60_000) runSync(false)
    }

    override fun onDestroy() {
        pool.shutdown()
        super.onDestroy()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (tab != 0) showTab(0)
        else if (libraryQuery.isNotEmpty()) libraryQueryBox.setText("")
        else super.onBackPressed()
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
            7 -> showStats(this)
            9 -> searchBooks()
            10 -> showQueue()
            8 -> syncMenu()
            else -> return super.onOptionsItemSelected(item)
        }
        return true
    }

    // ---------- phone ↔ PC sync ----------

    internal var syncing = false

    internal fun showTab(k: Int) {
        tab = k
        showingSearch = k == 1
        libraryPane.visibility = if (k == 0) View.VISIBLE else View.GONE
        searchPane.visibility = if (k == 1) View.VISIBLE else View.GONE
        settingsPane.visibility = if (k == 2) View.VISIBLE else View.GONE
        tabs.forEachIndexed { i, t ->
            val on = i == k
            t.alpha = if (on) 1f else 0.6f
            (t.getChildAt(1) as TextView).setTextColor(if (on) UiColors.ACCENT else UiColors.MUTED)
            t.background = roundBg(if (on) 0x2256B394 else 0x00000000, 14)
        }
        topTitle.text = listOf("Shelf Reader", "Find free books", "Settings")[k]
        topActions.forEach { it.visibility = if (k == 0) View.VISIBLE else View.GONE }
        when (k) { 0 -> refreshLibrary(); 1 -> searchBox.requestFocus(); 2 -> buildSettings() }
    }

    internal val emptyText = "No books yet.\n\nFind thousands of free books to read or listen to, " +
        "or add an EPUB, PDF or TXT file that's already on your phone."

    internal fun sortKey(s: String) = s.lowercase().replace(Regex("^(the|a|an)\\s+"), "")

    internal fun refreshLibrary() {
        val all = Library.load(this)
        var filter = Settings.libraryFilter(this)
        if (filter.isNotEmpty() && filter !in Collections.names(this)) { filter = ""; Settings.setLibraryFilter(this, "") }
        val inCollection = if (filter.isEmpty()) all else all.filter { filter in Collections.of(this, it.id) }
        val words = libraryQuery.lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }
        val shown = if (words.isEmpty()) inCollection else inCollection.filter { b ->
            val hay = (b.title + " " + b.author).lowercase()
            words.all { it in hay }
        }
        libraryQueryBox.visibility = if (all.size >= 6 || libraryQuery.isNotEmpty()) View.VISIBLE else View.GONE
        libraryTip.visibility = if (all.isNotEmpty() && !Settings.seenTip(this, "library")) View.VISIBLE else View.GONE
        filterBtn.text = if (filter.isEmpty()) "All books ▾" else "$filter ▾"
        books = when (Settings.librarySort(this)) {
            1 -> shown.sortedBy { sortKey(it.title) }
            2 -> shown.sortedWith(compareBy({ sortKey(it.author.substringAfterLast(' ').ifBlank { "~" }) }, { sortKey(it.title) }))
            3 -> shown.sortedByDescending { Library.percent(this, it) }
            else -> shown.sortedByDescending { maxOf(Library.opened(this, it.id), it.added) }
        }
        val mode = Settings.libraryView(this).coerceIn(0, 2)
        viewBtn.text = "${VIEW_NAMES[mode]} ▾"
        sortBtn.text = "${SORT_NAMES[Settings.librarySort(this).coerceIn(0, 3)]} ▾"
        emptyBox.visibility = if (books.isEmpty()) View.VISIBLE else View.GONE
        if (books.isEmpty() && words.isNotEmpty()) libraryEmpty.text = "No books in your library match “$libraryQuery”.\n\nYou can look for it in Find books instead."
        else if (books.isEmpty() && all.isNotEmpty()) libraryEmpty.text = "No books in “$filter” yet.\n\nPress and hold a book → Collections… to add it."
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
        // landscape: the books need the room, so the Continue card hides (the player and notification still work)
        val landscape = resources.configuration.orientation == android.content.res.Configuration.ORIENTATION_LANDSCAPE
        continueBar.visibility = if (last != null && !landscape) View.VISIBLE else View.GONE
        if (last != null) {
            val pct = Library.percent(this, last)
            continueText.text = last.title
            continueSub.text = "${last.author.ifBlank { "Unknown author" }} · $pct%"
            continueProgress.progress = pct
            val bmp = Covers.get(this, last) { runOnUiThread { refreshLibrary() } }
            if (bmp != null) continueCover.setImageBitmap(bmp) else continueCover.setImageDrawable(ColorDrawable(Covers.color(last)))
            val playing = TtsService.instance?.let { it.bookId == last.id && it.playing } == true
            continuePlayBtn.text = if (playing) "❚❚" else "▶"
        }
    }

    internal fun openBook(b: Book) {
        startActivity(Intent(this, ReaderActivity::class.java).putExtra("book", b.id))
    }

    // ---------- shelf / grid ----------

    internal inner class ShelfAdapter(private val shelf: Boolean) : BaseAdapter() {
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

    internal fun makeCell(shelf: Boolean): Cell {
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

    // ---------- search inside every book ----------
    internal data class Hit(val book: Book, val para: Int, val snippet: String, val where: String)

    // ---------- updates ----------

    // ---------- search ----------

    /** Search results with covers. */
    internal inner class ResultAdapter : BaseAdapter() {
        override fun getCount() = results.size
        override fun getItem(position: Int): Any = results[position]
        override fun getItemId(position: Int) = position.toLong()
        override fun getView(position: Int, convertView: View?, parent: ViewGroup?): View {
            val row = (convertView as? LinearLayout) ?: LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(14), dp(8), dp(14), dp(8))
                addView(ImageView(this@MainActivity).apply { scaleType = ImageView.ScaleType.CENTER_CROP }, LinearLayout.LayoutParams(dp(44), dp(64)))
                addView(LinearLayout(this@MainActivity).apply {
                    orientation = LinearLayout.VERTICAL; setPadding(dp(12), 0, 0, 0)
                    addView(TextView(this@MainActivity).apply { textSize = 16f; setTextColor(UiColors.FG); setTypeface(typeface, android.graphics.Typeface.BOLD); maxLines = 2 })
                    addView(TextView(this@MainActivity).apply { textSize = 13f; setTextColor(UiColors.MUTED); maxLines = 2 })
                }, LinearLayout.LayoutParams(0, WRAP, 1f))
            }
            val r = results[position]
            val img = row.getChildAt(0) as ImageView
            val texts = row.getChildAt(1) as LinearLayout
            (texts.getChildAt(0) as TextView).text = r.title
            (texts.getChildAt(1) as TextView).text = "${r.author.ifBlank { "Unknown author" }} · ${r.source}" + (r.info?.let { "\n$it" } ?: "")
            img.tag = r.cover
            img.setImageDrawable(ColorDrawable(UiColors.SURFACE2))
            val url = r.cover
            if (url != null) {
                val cached = thumbCache.get(url)
                if (cached != null) img.setImageBitmap(cached)
                else pool.execute {
                    val bmp = try { Net.open(url).inputStream.use { android.graphics.BitmapFactory.decodeStream(it) } } catch (t: Throwable) { null }
                    if (bmp != null) {
                        val small = android.graphics.Bitmap.createScaledBitmap(bmp, 88, (88f * bmp.height / maxOf(1, bmp.width)).toInt().coerceAtLeast(1), true)
                        thumbCache.put(url, small)
                        runOnUiThread { if (img.tag == url) img.setImageBitmap(small) }
                    }
                }
            }
            return row
        }
    }
    internal val thumbCache = android.util.LruCache<String, android.graphics.Bitmap>(80)

    // ---------- import ----------

    internal fun pickFile() {
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
        if (requestCode == 47 && resultCode == RESULT_OK) {
            val uri = data?.data ?: return
            try {
                contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            } catch (e: Throwable) {}
            Settings.setSyncUri(this, uri.toString())
            runSync(true)
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

    internal fun importUri(uri: Uri) {
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
        showTab(0)
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
