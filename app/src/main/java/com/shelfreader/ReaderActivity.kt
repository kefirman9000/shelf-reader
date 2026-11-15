package com.shelfreader

import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.Voice
import android.text.SpannableString
import android.text.Spanned
import android.text.style.BackgroundColorSpan
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.view.ViewGroup
import android.widget.AbsListView
import android.widget.BaseAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView
import java.util.Locale

class ReaderActivity : Activity() {

    private lateinit var book: Book
    private var paras: List<String> = emptyList()
    private var chapters: List<Chapter> = emptyList()
    private var notes: List<Note> = emptyList()
    private var marks: Map<Int, String> = emptyMap()

    private lateinit var root: LinearLayout
    private lateinit var list: ListView
    private lateinit var playBtn: Button
    private lateinit var speedBtn: Button
    private lateinit var status: TextView

    private var curPara = 0
    private var curStart = -1
    private var curEnd = -1
    private var lastTouch = 0L
    private var loaded = false

    private var textSize = 18f
    private var theme = READER_THEMES[0]
    private var font = FONTS[0]
    private var margin = 22

    private var probe: TextToSpeech? = null
    private var probeReady = false
    private var pendingExport: Pair<Int, Int>? = null

    private val adapter = object : BaseAdapter() {
        override fun getCount() = paras.size
        override fun getItem(position: Int): Any = paras[position]
        override fun getItemId(position: Int) = position.toLong()
        override fun getView(position: Int, convertView: View?, parent: ViewGroup?): View {
            val tv = (convertView as? TextView) ?: TextView(this@ReaderActivity).apply { setLineSpacing(0f, 1.3f) }
            val m = dp(margin)
            tv.setPadding(m, dp(7), m, dp(7))
            tv.textSize = textSize
            tv.typeface = font
            tv.setTextColor(theme.fg)
            val prefix = marks[position] ?: ""
            val text = paras[position]
            if (position == curPara) {
                tv.setBackgroundColor(theme.para)
                if (curStart >= 0 && curEnd > curStart && curEnd <= text.length) {
                    val sp = SpannableString(prefix + text)
                    sp.setSpan(
                        BackgroundColorSpan(theme.sent),
                        prefix.length + curStart, prefix.length + curEnd,
                        Spanned.SPAN_EXCLUSIVE_EXCLUSIVE
                    )
                    tv.text = sp
                } else {
                    tv.text = prefix + text
                }
            } else {
                tv.setBackgroundColor(Color.TRANSPARENT)
                tv.text = prefix + text
            }
            return tv
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val id = intent.getStringExtra("book")
        val b = id?.let { Library.get(this, it) }
        if (b == null) { finish(); return }
        book = b
        title = b.title
        Library.markOpened(this, b.id)
        loadAppearance()

        root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        status = TextView(this).apply {
            setPadding(dp(18), dp(4), dp(18), dp(4))
            textSize = 13f
            alpha = 0.75f
            maxLines = 2
            text = "Preparing book…"
        }
        list = ListView(this).apply {
            divider = null
            isFastScrollEnabled = true
            adapter = this@ReaderActivity.adapter
        }
        list.setOnItemClickListener { _, _, pos, _ -> playFrom(pos) }
        list.setOnItemLongClickListener { _, _, pos, _ -> paragraphMenu(pos); true }
        list.setOnScrollListener(object : AbsListView.OnScrollListener {
            override fun onScrollStateChanged(view: AbsListView?, scrollState: Int) {
                if (scrollState != AbsListView.OnScrollListener.SCROLL_STATE_IDLE) lastTouch = System.currentTimeMillis()
            }
            override fun onScroll(view: AbsListView?, first: Int, visible: Int, total: Int) {}
        })

        val controls = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        val prev = Button(this).apply { text = "⏮"; setOnClickListener { step(-1) } }
        playBtn = Button(this).apply { text = "▶ Play"; setOnClickListener { togglePlay() } }
        val next = Button(this).apply { text = "⏭"; setOnClickListener { step(1) } }
        speedBtn = Button(this).apply { setOnClickListener { pickSpeed() } }
        val chapBtn = Button(this).apply { text = "☰"; setOnClickListener { showChapters() } }
        controls.addView(chapBtn, LinearLayout.LayoutParams(0, WRAP, 0.8f))
        controls.addView(prev, LinearLayout.LayoutParams(0, WRAP, 0.8f))
        controls.addView(playBtn, LinearLayout.LayoutParams(0, WRAP, 1.6f))
        controls.addView(next, LinearLayout.LayoutParams(0, WRAP, 0.8f))
        controls.addView(speedBtn, LinearLayout.LayoutParams(0, WRAP, 1f))

        root.addView(status)
        root.addView(list, LinearLayout.LayoutParams(MATCH, 0, 1f))
        root.addView(controls)
        setContentView(root)
        applyAppearance()
        refreshButtons()

        Thread {
            try {
                val d = Library.doc(this, book)
                runOnUiThread {
                    paras = d.paras
                    chapters = d.chapters
                    loaded = true
                    reloadNotes()
                    curPara = currentPara()
                    adapter.notifyDataSetChanged()
                    list.setSelectionFromTop(curPara, dp(60))
                    refresh()
                }
            } catch (t: Throwable) {
                runOnUiThread { status.text = "Couldn't read this book: ${t.message}" }
            }
        }.start()
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        val id = intent?.getStringExtra("book")
        if (id != null && id != book.id) {
            finish()
            startActivity(Intent(this, ReaderActivity::class.java).putExtra("book", id))
        }
    }

    override fun onResume() {
        super.onResume()
        TtsService.listener = { runOnUiThread { refresh() } }
        refresh()
    }

    override fun onPause() {
        TtsService.listener = null
        super.onPause()
    }

    override fun onDestroy() {
        probe?.shutdown()
        super.onDestroy()
    }

    // ---------- state ----------

    private fun service(): TtsService? = TtsService.instance?.takeIf { it.bookId == book.id }

    private fun currentPara(): Int = service()?.index ?: Library.position(this, book.id)

    private fun isPlaying() = service()?.playing == true

    private fun chapterIndex(para: Int): Int {
        var r = -1
        for ((k, c) in chapters.withIndex()) { if (c.para <= para) r = k else break }
        return r
    }

    private fun refresh() {
        if (!loaded) return
        val s = service()
        val seg = s?.currentSeg()
        val p = (s?.index ?: Library.position(this, book.id)).coerceIn(0, maxOf(0, paras.size - 1))
        val st = seg?.start ?: -1
        val en = seg?.end ?: -1
        if (p != curPara || st != curStart || en != curEnd) {
            val paraChanged = p != curPara
            curPara = p; curStart = st; curEnd = en
            adapter.notifyDataSetChanged()
            if (paraChanged) {
                val offscreen = curPara < list.firstVisiblePosition || curPara >= list.lastVisiblePosition
                if (offscreen && System.currentTimeMillis() - lastTouch > 6000) list.setSelectionFromTop(curPara, dp(60))
            }
        }
        val pct = if (paras.isNotEmpty()) (curPara + 1) * 100 / paras.size else 0
        val ch = chapterIndex(curPara).let { if (it >= 0) chapters[it].title else book.author.ifBlank { "Unknown author" } }
        val sleep = s?.sleepText()?.let { " · $it" } ?: ""
        status.text = "$ch · $pct%$sleep"
        refreshButtons()
    }

    private fun refreshButtons() {
        playBtn.text = if (isPlaying()) "❚❚ Pause" else "▶ Play"
        speedBtn.text = fmtRate(Settings.rate(this))
    }

    private fun fmtRate(r: Float) = (if (r % 1f == 0f) r.toInt().toString() else r.toString()) + "×"

    // ---------- appearance ----------

    private fun loadAppearance() {
        textSize = Settings.textSize(this)
        theme = READER_THEMES.getOrElse(Settings.theme(this)) { READER_THEMES[0] }
        font = FONTS.getOrElse(Settings.font(this)) { FONTS[0] }
        margin = MARGINS_DP.getOrElse(Settings.margin(this)) { 22 }
    }

    private fun applyAppearance() {
        root.setBackgroundColor(theme.bg)
        list.setBackgroundColor(theme.bg)
        list.cacheColorHint = theme.bg
        status.setTextColor(theme.fg)
        adapter.notifyDataSetChanged()
    }

    private fun appearanceMenu() {
        val items = arrayOf(
            "Theme: ${theme.name}",
            "Font: ${FONT_NAMES[Settings.font(this).coerceIn(0, 2)]}",
            "Margins: ${MARGIN_NAMES[Settings.margin(this).coerceIn(0, 2)]}",
            "Larger text",
            "Smaller text"
        )
        AlertDialog.Builder(this).setTitle("Appearance").setItems(items) { _, w ->
            when (w) {
                0 -> choose("Theme", READER_THEMES.map { it.name }) { Settings.setTheme(this, it) }
                1 -> choose("Font", FONT_NAMES) { Settings.setFont(this, it) }
                2 -> choose("Margins", MARGIN_NAMES) { Settings.setMargin(this, it) }
                3, 4 -> {
                    Settings.setTextSize(this, (textSize + if (w == 3) 2f else -2f).coerceIn(12f, 34f))
                    loadAppearance(); applyAppearance(); appearanceMenu()
                }
            }
        }.show()
    }

    private fun choose(titleText: String, options: List<String>, save: (Int) -> Unit) {
        AlertDialog.Builder(this).setTitle(titleText).setItems(options.toTypedArray()) { _, w ->
            save(w)
            loadAppearance()
            applyAppearance()
            appearanceMenu()
        }.show()
    }

    // ---------- playback controls ----------

    private fun playFrom(i: Int) {
        if (!loaded) return
        lastTouch = 0
        startForegroundService(
            Intent(this, TtsService::class.java)
                .setAction(TtsService.ACTION_PLAY)
                .putExtra(TtsService.EXTRA_BOOK, book.id)
                .putExtra(TtsService.EXTRA_INDEX, i)
        )
    }

    private fun togglePlay() {
        if (!loaded) return
        if (service() != null) {
            startService(Intent(this, TtsService::class.java).setAction(TtsService.ACTION_TOGGLE))
        } else {
            startForegroundService(
                Intent(this, TtsService::class.java)
                    .setAction(TtsService.ACTION_PLAY)
                    .putExtra(TtsService.EXTRA_BOOK, book.id)
            )
        }
    }

    private fun step(d: Int) {
        if (!loaded || paras.isEmpty()) return
        lastTouch = 0
        if (service() != null) {
            startService(Intent(this, TtsService::class.java).setAction(if (d > 0) TtsService.ACTION_NEXT else TtsService.ACTION_PREV))
        } else {
            Library.setPosition(this, book.id, (curPara + d).coerceIn(0, paras.size - 1))
            refresh()
        }
    }

    /** Moves the reading position without starting playback (unless already playing). */
    private fun goTo(para: Int) {
        lastTouch = 0
        if (service() != null) {
            startService(
                Intent(this, TtsService::class.java)
                    .setAction(TtsService.ACTION_SEEK)
                    .putExtra(TtsService.EXTRA_BOOK, book.id)
                    .putExtra(TtsService.EXTRA_INDEX, para)
            )
        } else {
            Library.setPosition(this, book.id, para)
        }
        list.setSelectionFromTop(para, dp(40))
        refresh()
    }

    private fun pickSpeed() {
        val rates = floatArrayOf(0.75f, 1f, 1.25f, 1.5f, 1.75f, 2f, 2.5f, 3f)
        AlertDialog.Builder(this)
            .setTitle("Reading speed")
            .setItems(rates.map { fmtRate(it) }.toTypedArray()) { _, w ->
                Settings.setRate(this, rates[w])
                TtsService.instance?.applySettings(true)
                refreshButtons()
            }
            .show()
    }

    // ---------- chapters ----------

    private fun showChapters() {
        if (!loaded) return
        if (chapters.isEmpty()) { toast("No chapters were found in this book."); return }
        val cur = chapterIndex(curPara)
        val labels = chapters.mapIndexed { k, c -> (if (k == cur) "▶ " else "") + c.title }.toTypedArray()
        val dlg = AlertDialog.Builder(this)
            .setTitle("Chapters")
            .setItems(labels) { _, w -> goTo(chapters[w].para) }
            .show()
        if (cur > 0) dlg.listView?.setSelection(cur)
    }

    // ---------- sleep timer ----------

    private fun sleepMenu() {
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

    // ---------- bookmarks & notes ----------

    private fun reloadNotes() {
        notes = Library.notes(this, book.id)
        val m = HashMap<Int, String>()
        for (n in notes) m[n.para] = if (n.text.isBlank() && m[n.para] == null) "🔖 " else "📝 "
        marks = m
        adapter.notifyDataSetChanged()
    }

    private fun paragraphMenu(p: Int) {
        val here = notes.filter { it.para == p }
        val items = ArrayList<String>()
        items += "Read aloud from here"
        items += "Bookmark this paragraph"
        items += "Add a note…"
        items += "Copy text"
        if (here.isNotEmpty()) items += "Remove bookmark / notes here"
        AlertDialog.Builder(this)
            .setTitle(paras[p].take(80) + if (paras[p].length > 80) "…" else "")
            .setItems(items.toTypedArray()) { _, w ->
                when (w) {
                    0 -> playFrom(p)
                    1 -> { saveNote(p, ""); toast("Bookmarked") }
                    2 -> addNote(p)
                    3 -> {
                        (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager)
                            .setPrimaryClip(ClipData.newPlainText("Shelf Reader", paras[p]))
                        toast("Copied")
                    }
                    4 -> {
                        Library.saveNotes(this, book.id, notes.filter { it.para != p })
                        reloadNotes()
                    }
                }
            }.show()
    }

    private fun saveNote(p: Int, text: String) {
        val list = Library.notes(this, book.id)
        list += Note(p, text, System.currentTimeMillis())
        Library.saveNotes(this, book.id, list)
        reloadNotes()
    }

    private fun addNote(p: Int) {
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

    private fun showNotes() {
        if (notes.isEmpty()) {
            toast("No bookmarks or notes yet. Long-press a paragraph to add one.")
            return
        }
        val labels = notes.map { n ->
            val where = chapterIndex(n.para).let { if (it >= 0) chapters[it].title else "Paragraph ${n.para + 1}" }
            val body = if (n.text.isBlank()) "🔖 " + paras.getOrElse(n.para) { "" }.take(70) else "📝 " + n.text
            "$where\n$body"
        }.toTypedArray()
        AlertDialog.Builder(this).setTitle("Bookmarks & notes").setItems(labels) { _, w ->
            val n = notes[w]
            AlertDialog.Builder(this)
                .setTitle(if (n.text.isBlank()) "Bookmark" else "Note")
                .setMessage(if (n.text.isBlank()) paras.getOrElse(n.para) { "" }.take(300) else n.text)
                .setPositiveButton("Go there") { _, _ -> goTo(n.para) }
                .setNeutralButton("Delete") { _, _ ->
                    Library.saveNotes(this, book.id, notes.filter { it !== n })
                    reloadNotes()
                }
                .setNegativeButton("Close", null)
                .show()
        }.show()
    }

    // ---------- voices ----------

    private fun pickVoice() {
        val engine = TtsService.instance?.engine() ?: (if (probeReady) probe else null)
        if (engine != null) { showVoices(engine); return }
        status.text = "Loading voices…"
        if (probe == null) {
            probe = TextToSpeech(this) { st ->
                runOnUiThread {
                    if (st == TextToSpeech.SUCCESS) {
                        probeReady = true
                        probe?.let { showVoices(it) }
                    } else {
                        toast("No text-to-speech engine found. Install “Speech Services by Google”.")
                    }
                    refresh()
                }
            }
        }
    }

    private fun showVoices(engine: TextToSpeech) {
        val all: List<Voice> = try { engine.voices?.toList() ?: emptyList() } catch (e: Throwable) { emptyList() }
        val lang = Locale.getDefault().language
        val voices = all.filter {
            it.locale.language == lang &&
                !(it.features?.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) ?: false)
        }.sortedWith(compareBy<Voice>({ it.isNetworkConnectionRequired }, { it.locale.toString() }, { it.name }))
        val chosen = Settings.voice(this)
        val labels = ArrayList<String>()
        labels += (if (chosen == null) "✓ " else "") + "System default voice"
        for (v in voices) labels += (if (v.name == chosen) "✓ " else "") + voiceLabel(v)
        labels += "Get more voices…"
        AlertDialog.Builder(this)
            .setTitle("Voice")
            .setItems(labels.toTypedArray()) { _, w ->
                when (w) {
                    0 -> Settings.setVoice(this, null)
                    labels.size - 1 -> { openTtsSettings(); return@setItems }
                    else -> Settings.setVoice(this, voices[w - 1].name)
                }
                TtsService.instance?.applySettings(true)
                if (service() == null && loaded) toast("Voice saved — press Play to hear it.")
            }
            .show()
    }

    private fun voiceLabel(v: Voice): String {
        val region = v.locale.displayCountry.ifBlank { v.locale.displayLanguage }
        val code = v.name.substringAfter("-x-", v.name).substringBefore("-")
        val where = if (v.isNetworkConnectionRequired) "online" else "offline"
        val hq = if (v.quality >= Voice.QUALITY_VERY_HIGH) " ★" else ""
        return "$region · $code · $where$hq"
    }

    private fun openTtsSettings() {
        try {
            startActivity(Intent("com.android.settings.TTS_SETTINGS"))
        } catch (e: Throwable) {
            toast("Open Settings → Accessibility → Text-to-speech to install voices.")
        }
    }

    // ---------- audio export ----------

    private fun exportMenu() {
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

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != 43 || resultCode != RESULT_OK) return
        val uri = data?.data ?: return
        val range = pendingExport ?: return
        try {
            contentResolver.takePersistableUriPermission(
                uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            )
        } catch (e: Throwable) {}
        startForegroundService(
            Intent(this, ExportService::class.java)
                .putExtra("book", book.id)
                .putExtra("from", range.first)
                .putExtra("to", range.second)
                .putExtra("tree", uri.toString())
        )
        toast("Exporting in the background. Progress is in your notifications.")
    }

    // ---------- menu ----------

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menu.add(0, 1, 0, "Chapters")
        menu.add(0, 2, 0, "Bookmarks & notes")
        menu.add(0, 3, 0, "Sleep timer")
        menu.add(0, 4, 0, "Voice")
        menu.add(0, 5, 0, "Appearance")
        menu.add(0, 6, 0, "Pronunciation fixes")
        menu.add(0, 7, 0, "Skip page numbers & footnotes").setCheckable(true).isChecked = Settings.skipClutter(this)
        menu.add(0, 8, 0, "Export as audio…")
        menu.add(0, 9, 0, "Back to start")
        menu.add(0, 10, 0, "Text-to-speech settings")
        return true
    }

    override fun onPrepareOptionsMenu(menu: Menu): Boolean {
        menu.findItem(7)?.isChecked = Settings.skipClutter(this)
        return super.onPrepareOptionsMenu(menu)
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        when (item.itemId) {
            1 -> showChapters()
            2 -> showNotes()
            3 -> sleepMenu()
            4 -> pickVoice()
            5 -> appearanceMenu()
            6 -> editPronunciations { TtsService.instance?.applySettings(true) }
            7 -> {
                val v = !Settings.skipClutter(this)
                Settings.setSkipClutter(this, v)
                TtsService.instance?.applySettings(true)
                toast(if (v) "Skipping page numbers, footnote markers and links" else "Reading everything")
            }
            8 -> exportMenu()
            9 -> goTo(0)
            10 -> openTtsSettings()
            else -> return super.onOptionsItemSelected(item)
        }
        return true
    }
}
