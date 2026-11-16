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
    private lateinit var viewBtn: TextView
    private lateinit var sortBtn: TextView
    private lateinit var filterBtn: TextView
    private var shelfAdapter: ShelfAdapter? = null
    private var pendingCoverBook: String? = null
    private lateinit var searchPane: View
    private lateinit var searchBox: EditText
    private lateinit var searchStatus: TextView
    private lateinit var resultsList: ListView
    private lateinit var tabs: List<LinearLayout>
    private lateinit var topTitle: TextView
    private lateinit var settingsPane: android.widget.ScrollView
    private lateinit var emptyBox: LinearLayout
    private lateinit var continueCover: ImageView
    private lateinit var continueSub: TextView
    private lateinit var continueProgress: ProgressBar
    private lateinit var continuePlayBtn: TextView
    private var tab = 0
    private var topActions: List<View> = emptyList()
    private lateinit var libraryQueryBox: EditText
    private var libraryQuery = ""
    private lateinit var searchProgress: ProgressBar
    private lateinit var suggestBox: View
    private lateinit var libraryTip: View

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

    private fun syncMenu() {
        val on = Settings.syncUri(this) != null
        val last = Settings.lastSync(this)
        val msg = if (on) "Your place, bookmarks, highlights, notes, collections and reading stats are kept in step with the PC app through a ShelfReader-sync.json file." +
            (if (last > 0) "\n\nLast synced: " + java.text.DateFormat.getDateTimeInstance().format(Date(last)) else "")
        else "Keep your place, bookmarks, highlights, notes, collections and stats the same on this phone and your PC.\n\n" +
            "1. In the PC app, open Settings → Sync and pick a folder in Google Drive or OneDrive.\n" +
            "2. Here, tap “Choose the sync file” and pick ShelfReader-sync.json in that same folder (in the Drive or OneDrive section of the file picker).\n\n" +
            "No PC yet? Tap “Create a new sync file” to make one in Drive, then point the PC app at that folder.\n\nBooks themselves aren't copied — add them on both devices."
        val b = AlertDialog.Builder(this).setTitle("Sync with PC").setMessage(msg)
        if (on) {
            b.setPositiveButton("Sync now") { _, _ -> runSync(true) }
            b.setNeutralButton("Turn off") { _, _ -> Settings.setSyncUri(this, null); toast("Sync turned off") }
            b.setNegativeButton("Change file…") { _, _ -> pickSyncFile(false) }
        } else {
            b.setPositiveButton("Choose the sync file") { _, _ -> pickSyncFile(false) }
            b.setNeutralButton("Create a new sync file") { _, _ -> pickSyncFile(true) }
            b.setNegativeButton("Cancel", null)
        }
        b.show()
    }

    private fun pickSyncFile(create: Boolean) {
        try {
            val i = if (create) Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                .setType("application/json").putExtra(Intent.EXTRA_TITLE, "ShelfReader-sync.json")
            else Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
            @Suppress("DEPRECATION")
            startActivityForResult(i, 47)
        } catch (e: Throwable) { toast("No file picker available") }
    }

    private var syncing = false

    private fun runSync(announce: Boolean) {
        if (syncing || Settings.syncUri(this) == null) return
        syncing = true
        pool.execute {
            val msg = try {
                val (pulled, pushed) = SyncFile.sync(this)
                "Synced: $pulled book${if (pulled == 1) "" else "s"} updated from the other device, $pushed in the sync file."
            } catch (t: Throwable) { "Sync failed: ${t.message}" }
            runOnUiThread {
                syncing = false
                if (announce || msg.startsWith("Sync failed")) toast(msg)
                if (!showingSearch) refreshLibrary()
            }
        }
    }

    private fun showTab(k: Int) {
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

    // ---------- settings: every option in one clear place ----------
    private fun buildSettings() {
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(0, 0, 0, dp(24)) }
        fun add(v: View) = col.addView(v)
        val svc = { TtsService.instance?.applySettings(true) }
        add(sectionTitle("Voice & audio"))
        add(settingRow("🗣", "Voice and speed", "Default voice for new books, and how fast it reads. Each book can also have its own (in the player).") { defaultVoiceDialog() })
        add(settingRow("✨", "Get better voices", "Install natural Google voices, step by step") { showVoiceGuide(this) })
        add(settingRow("🔤", "Pronunciations", "Fix names or words the voice says wrong") { editPronunciations { svc() } })
        add(settingRow("⏸", "Natural pauses", "Pause by punctuation, longer between paragraphs, chapter headings announced", Settings.naturalPauses(this)) { Settings.setNaturalPauses(this, it?.isChecked == true); svc() })
        add(settingRow("🔢", "Say numbers properly", "“Chapter XII” → “Chapter Twelve”, Henry VIII, 1850s, $4.50, Dr., St.", Settings.speakNumbers(this)) { Settings.setSpeakNumbers(this, it?.isChecked == true); svc() })
        add(settingRow("🧵", "Fix broken lines", "Join sentences a book split across lines (common in scanned books and PDFs) before reading them aloud", Settings.fixBrokenLines(this)) { Settings.setFixBrokenLines(this, it?.isChecked == true); svc() })
        add(settingRow("✂", "Skip page numbers & clutter", "Page numbers, running headers, footnote markers, links", Settings.skipClutter(this)) { Settings.setSkipClutter(this, it?.isChecked == true); svc() })
        add(settingRow("🎧", "Resume with headphones", "Continue a paused book when headphones connect", Settings.resumeOnHeadphones(this)) { Settings.setResumeOnHeadphones(this, it?.isChecked == true) })
        add(settingRow("⚙", "Android text-to-speech settings", "Speech engine, language packs and default rate") { openTtsSettingsScreen() })
        add(sectionTitle("Your books"))
        add(settingRow("🔁", "Keep listening", "When a book ends, start another: Up next first, then Want to read, then books you've started", Settings.autoNextBook(this)) { Settings.setAutoNextBook(this, it?.isChecked == true) })
        add(settingRow("⏭", "Up next", "Books that play one after another (${Settings.queue(this).size})") { showQueue() })
        add(settingRow("🔎", "Search inside your books", "Find a word or phrase in every book and listen from there") { searchBooks() })
        add(settingRow("📊", "Reading stats", "Daily goal, streak and finished books") { showStats(this) })
        add(settingRow("🗂", "Collections", "Delete collections you made") { manageCollections() })
        add(sectionTitle("Sync & backup"))
        add(settingRow("🔄", "Sync with PC", if (Settings.syncUri(this) != null) "On · keeps your place, notes and stats in step with the PC app" else "Off · keep your place and notes the same on your PC") { syncMenu() })
        add(settingRow("💾", "Back up library", "Save books, places and notes to one file") { backupLibrary() })
        add(settingRow("📥", "Restore from backup", "Bring back a backup file") { restoreLibrary() })
        add(sectionTitle("App"))
        add(settingRow("🐞", "Report a problem", "Stuck, skipping, crashes: makes a report of what the app was doing") { CrashReport.reportProblem(this) })
        add(settingRow("⬆", "Check for updates", "You have build ${Updater.currentBuild(this)}") { checkUpdates(true) })
        add(settingRow("🔑", "GitHub token for updates", if (Settings.updateToken(this) != null) "Saved · updates work while the repository is private" else "Needed while the repository is private") { tokenDialog() })
        settingsPane.removeAllViews()
        settingsPane.addView(col)
    }

    private fun defaultVoiceDialog() {
        val rates = listOf(0.75f, 0.9f, 1f, 1.1f, 1.25f, 1.5f, 1.75f, 2f)
        AlertDialog.Builder(this).setTitle("Default speed for new books")
            .setItems(rates.map { (if (it == 1f) "Normal" else "${it}×") + if (it == Settings.rate(this)) "  ✓" else "" }.toTypedArray()) { _, w ->
                Settings.setRate(this, rates[w]); TtsService.instance?.applySettings(true); toast("Default speed set. Open a book to choose its voice.")
            }.setNeutralButton("Choose voices in a book") { _, _ -> toast("Open a book, then tap 🗣 Voice in the player.") }
            .show()
    }

    private fun openTtsSettingsScreen() {
        try { startActivity(Intent("com.android.settings.TTS_SETTINGS")) } catch (e: Throwable) { toast("Couldn't open the speech settings") }
    }

    private fun backupLibrary() {
        val name = "ShelfReader-backup-" + SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date()) + ".zip"
        try {
            @Suppress("DEPRECATION")
            startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/zip").putExtra(Intent.EXTRA_TITLE, name), 45)
        } catch (e: Throwable) { toast("No file picker available") }
    }

    private fun restoreLibrary() {
        try {
            @Suppress("DEPRECATION")
            startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
                .putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/zip", "application/x-zip-compressed", "application/octet-stream")), 46)
        } catch (e: Throwable) { toast("No file picker available") }
    }

    private val emptyText = "No books yet.\n\nFind thousands of free books to read or listen to, " +
        "or add an EPUB, PDF or TXT file that's already on your phone."

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
    private fun showQueue() {
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

    // ---------- search inside every book ----------
    private data class Hit(val book: Book, val para: Int, val snippet: String, val where: String)

    private fun searchBooks() {
        val box = EditText(this).apply { hint = "Word or phrase in any book"; setSingleLine() }
        val wrap = LinearLayout(this).apply { setPadding(dp(20), dp(8), dp(20), 0); addView(box, LinearLayout.LayoutParams(-1, -2)) }
        AlertDialog.Builder(this).setTitle("Search inside your books").setView(wrap)
            .setPositiveButton("Search") { _, _ ->
                val q = box.text.toString().trim()
                if (q.length < 2) return@setPositiveButton
                toast("Searching…")
                pool.execute {
                    val hits = ArrayList<Hit>()
                    for (b in Library.load(this)) {
                        val d = try { Library.doc(this, b) } catch (t: Throwable) { continue }
                        var n = 0
                        for ((i, p) in d.paras.withIndex()) {
                            val k = p.indexOf(q, ignoreCase = true)
                            if (k < 0) continue
                            val a = maxOf(0, k - 60); val e = minOf(p.length, k + q.length + 80)
                            val ch = d.chapters.lastOrNull { it.para <= i }?.title ?: ""
                            hits += Hit(b, i, (if (a > 0) "…" else "") + p.substring(a, e) + (if (e < p.length) "…" else ""), ch)
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
    private fun aboutBook(b: Book) {
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
                val r = Updater.latest(this)
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
                    AlertDialog.Builder(this).setTitle("Couldn't check for updates").setMessage(t.message ?: "Unknown error")
                        .setPositiveButton("Add a token…") { _, _ -> tokenDialog() }
                        .setNegativeButton("Close", null).show()
                }
            }
        }
    }

    /** Paste a read-only GitHub token so the app can see new builds while the repository is private. */
    private fun tokenDialog() {
        val box = EditText(this).apply {
            hint = if (Settings.updateToken(this@MainActivity) != null) "A token is saved. Paste a new one to replace it" else "github_pat_…"
            setSingleLine(); inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        val info = TextView(this).apply {
            textSize = 14f
            text = "While the GitHub repository is private, GitHub only shares new builds with your account.\n\n" +
                "1. On GitHub: Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.\n" +
                "2. Repository access: Only select repositories → shelf-reader.\n" +
                "3. Permissions: Contents → Read-only. Generate, copy, paste below.\n\nIt stays on this phone. (If the repository is public, no token is needed.)"
        }
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(8), dp(20), 0); addView(info); addView(box) }
        val dlg = AlertDialog.Builder(this).setTitle("Updates from a private repository").setView(android.widget.ScrollView(this).apply { addView(col) })
            .setPositiveButton("Save & check") { _, _ ->
                val t = box.text.toString().trim()
                if (t.isNotEmpty() && !Regex("^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$").matches(t)) { toast("That doesn't look like a GitHub token (it starts with github_pat_ or ghp_)."); return@setPositiveButton }
                if (t.isNotEmpty()) Settings.setUpdateToken(this, t)
                checkUpdates(true)
            }
            .setNegativeButton("Cancel", null)
        if (Settings.updateToken(this) != null) dlg.setNeutralButton("Remove token") { _, _ -> Settings.setUpdateToken(this, null); toast("Token removed") }
        dlg.show()
    }

    private fun installUpdate(r: Updater.Release) {
        toast("Downloading update…")
        pool.execute {
            try {
                val f = File(cacheDir, "update.apk")
                f.delete()
                // with a token, download through GitHub's API (works for private repositories)
                if (Settings.updateToken(this) != null && r.apiUrl.isNotEmpty()) Net.download(r.apiUrl, f, Updater.headers(this, asset = true)) { _, _ -> }
                else Net.download(r.url, f) { _, _ -> }
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
    private fun score(r: SearchResult, q: String): Int {
        val words = q.lowercase().split(Regex("\\s+")).filter { it.length > 1 }
        val a = r.author.lowercase(); val t = r.title.lowercase()
        var s = 0
        if (a.contains(q.lowercase())) s += 50
        if (t.contains(q.lowercase())) s += 40
        for (w in words) { if (a.contains(w)) s += 10; if (t.contains(w)) s += 8 }
        if (r.url != null || r.source.contains("Standard")) s += 3
        return s
    }

    private fun updateResults() {
        val q = searchBox.text.toString().trim()
        val sorted = results.withIndex().sortedWith(compareByDescending<IndexedValue<SearchResult>> { score(it.value, q) }.thenBy { it.index }).map { it.value }
        results.clear(); results.addAll(sorted)
        resultsList.adapter = ResultAdapter()
    }

    /** Search results with covers. */
    private inner class ResultAdapter : BaseAdapter() {
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
    private val thumbCache = android.util.LruCache<String, android.graphics.Bitmap>(80)

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
