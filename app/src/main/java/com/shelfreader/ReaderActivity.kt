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

class ReaderActivity : Activity(), BookPageView.Host {

    private lateinit var book: Book
    private var paras: List<String> = emptyList()
    private var chapters: List<Chapter> = emptyList()
    private var pics: Map<Int, List<String>> = emptyMap()
    private var notes: List<Note> = emptyList()
    private var marks: Map<Int, String> = emptyMap()

    private lateinit var root: LinearLayout
    private lateinit var list: ListView
    private lateinit var bookView: BookPageView
    private lateinit var controls: LinearLayout
    private lateinit var topBarView: LinearLayout
    private lateinit var playBtn: TextView
    private lateinit var speedBtn: TextView
    private lateinit var layoutChip: TextView
    private lateinit var seek: android.widget.SeekBar
    private lateinit var seekLabel: TextView
    private var seeking = false
    private var pinching = false
    private var pinchCancelSent = false
    private var pinchSize = 18f
    private lateinit var status: TextView
    private lateinit var recap: TextView
    private lateinit var jumpBar: TextView
    /** Places you jumped away from (newest first), so you can go back. */
    private val history = ArrayList<Pair<Int, Long>>()

    private var curPara = 0
    private var curStart = -1
    private var curEnd = -1
    private var lastTouch = 0L
    private var lastInteraction = System.currentTimeMillis()
    private var loaded = false
    private var resumed = false

    private var textSize = 18f
    private var theme = READER_THEMES[0]
    private var themeIndex = 0
    private var font = FONTS[0]
    private var margin = 22

    private var bookMode = true
    private var sections: List<BookPageView.Section> = emptyList()
    private var curSection = -1
    private val picBmCache = object : LruCache<String, Bitmap>(24 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap) = value.byteCount
    }

    private var probe: TextToSpeech? = null
    private var probeReady = false
    private var pendingExport: Pair<Int, Int>? = null
    private val ui = Handler(Looper.getMainLooper())

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
            tv.setBackgroundColor(if (position == curPara) theme.para else Color.TRANSPARENT)
            tv.text = rowText(position)
            return tv
        }
    }

    /** One paragraph for the scrolling view: pictures, bookmark marker, highlights, footnote markers, reading highlight. */
    private fun rowText(i: Int): CharSequence {
        val sb = SpannableStringBuilder()
        val maxW = resources.displayMetrics.widthPixels - 2 * dp(margin)
        for (bmp in picturesFor(i)) {
            val st = sb.length
            sb.append("￼\n")
            var w = minOf(maxW.toFloat(), bmp.width * resources.displayMetrics.density)
            var h = w * bmp.height / maxOf(1, bmp.width)
            val maxH = resources.displayMetrics.heightPixels * 0.55f
            if (h > maxH) { w *= maxH / h; h = maxH }
            val d = BitmapDrawable(resources, bmp).apply { setBounds(0, 0, w.toInt(), h.toInt()) }
            sb.setSpan(ImageSpan(d, ImageSpan.ALIGN_BOTTOM), st, st + 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            sb.setSpan(AlignmentSpan.Standard(Layout.Alignment.ALIGN_CENTER), st, st + 2, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        sb.append(marks[i] ?: "")
        val base = sb.length
        val text = paras[i]
        sb.append(text)
        for (n in notes) if (n.type == "hl" && n.para == i) {
            val a = (base + n.start).coerceIn(base, sb.length); val b = (base + n.end).coerceIn(base, sb.length)
            if (b > a) sb.setSpan(BackgroundColorSpan(hlColor(n.color)), a, b, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        for (f in FN_REF.findAll(text)) {
            sb.setSpan(ForegroundColorSpan(ACCENT), base + f.range.first, base + f.range.last + 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            sb.setSpan(RelativeSizeSpan(0.8f), base + f.range.first, base + f.range.last + 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        if (i == curPara && curStart >= 0 && curEnd > curStart && curEnd <= text.length) {
            sb.setSpan(BackgroundColorSpan(theme.sent), base + curStart, base + curEnd, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        return sb
    }

    /** Decoded pictures shown before paragraph [i] (cached). */
    private fun picturesFor(i: Int): List<Bitmap> {
        val srcs = pics[i] ?: return emptyList()
        val maxW = resources.displayMetrics.widthPixels
        return srcs.mapNotNull { src ->
            picBmCache.get(src) ?: try {
                Library.picture(this, book, src, maxW)?.also { picBmCache.put(src, it) }
            } catch (t: Throwable) { null }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val id = intent.getStringExtra("book")
        val b = id?.let { Library.get(this, it) }
        if (b == null) { finish(); return }
        book = b
        title = b.title
        val prevOpened = Library.opened(this, b.id)
        Library.markOpened(this, b.id)
        bookMode = Settings.layout(this) == "book"
        loadAppearance()

        window.statusBarColor = UiColors.SURFACE
        window.navigationBarColor = UiColors.SURFACE
        root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val (tb, titles) = topBar(b.title, { finish() },
            "☰" to ("Contents" to { showChapters() }),
            "Aa" to ("Text size and look" to { lookSheet() }),
            "⋮" to ("More" to { moreSheet() }))
        topBarView = tb
        status = titles.second.apply { visibility = View.VISIBLE; text = "Preparing book…" }
        recap = TextView(this).apply {
            setPadding(dp(18), dp(10), dp(18), dp(10))
            textSize = 14f
            visibility = View.GONE
            setOnClickListener { visibility = View.GONE }
        }
        jumpBar = TextView(this).apply {
            setPadding(dp(18), dp(10), dp(18), dp(10))
            textSize = 14f
            visibility = View.GONE
            setOnClickListener { visibility = View.GONE; goBackTo(0) }
        }
        list = ListView(this).apply {
            divider = null
            isFastScrollEnabled = true
            adapter = this@ReaderActivity.adapter
        }
        // Tap a paragraph: read from there. Double-tap: play/pause. Swipe sideways: skip a paragraph.
        val gestures = GestureDetector(this, object : GestureDetector.SimpleOnGestureListener() {
            override fun onSingleTapConfirmed(e: MotionEvent): Boolean {
                val pos = list.pointToPosition(e.x.toInt(), e.y.toInt())
                if (pos >= 0) playFrom(pos)
                return true
            }
            override fun onDoubleTap(e: MotionEvent): Boolean { togglePlay(); return true }
            override fun onFling(e1: MotionEvent?, e2: MotionEvent, velocityX: Float, velocityY: Float): Boolean {
                val start = e1 ?: return false
                val dx = e2.x - start.x
                val dy = e2.y - start.y
                if (kotlin.math.abs(dx) > dp(90) && kotlin.math.abs(dx) > kotlin.math.abs(dy) * 2) {
                    step(if (dx < 0) 1 else -1)
                    return true
                }
                return false
            }
        })
        list.setOnTouchListener { _, ev -> gestures.onTouchEvent(ev); false }
        list.setOnItemLongClickListener { _, _, pos, _ -> paragraphMenu(pos); true }
        list.setOnScrollListener(object : AbsListView.OnScrollListener {
            override fun onScrollStateChanged(view: AbsListView?, scrollState: Int) {
                if (scrollState != AbsListView.OnScrollListener.SCROLL_STATE_IDLE) lastTouch = System.currentTimeMillis()
            }
            override fun onScroll(view: AbsListView?, first: Int, visible: Int, total: Int) {}
        })
        bookView = BookPageView(this).apply { host = this@ReaderActivity }

        // the player: book progress, big controls, quick settings
        controls = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(UiColors.SURFACE)
            setPadding(dp(12), dp(6), dp(12), dp(10))
            elevation = dp(6).toFloat()
        }
        seekLabel = TextView(this).apply { textSize = 12f; setTextColor(UiColors.MUTED); gravity = android.view.Gravity.CENTER; maxLines = 1 }
        seek = android.widget.SeekBar(this).apply {
            max = 1000
            progressTintList = android.content.res.ColorStateList.valueOf(UiColors.ACCENT)
            thumbTintList = android.content.res.ColorStateList.valueOf(UiColors.ACCENT)
            setOnSeekBarChangeListener(object : android.widget.SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(sb: android.widget.SeekBar?, v: Int, fromUser: Boolean) {
                    if (fromUser && loaded) seekLabel.text = "Go to: " + placeLabel((v.toLong() * (paras.size - 1) / 1000).toInt())
                }
                override fun onStartTrackingTouch(sb: android.widget.SeekBar?) { seeking = true }
                override fun onStopTrackingTouch(sb: android.widget.SeekBar?) {
                    seeking = false
                    if (loaded) goTo((progress.toLong() * (paras.size - 1) / 1000).toInt())
                }
            })
        }
        controls.addView(seekLabel)
        controls.addView(seek, LinearLayout.LayoutParams(MATCH, WRAP))
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = android.view.Gravity.CENTER }
        fun spacer() = View(this).also { row.addView(it, LinearLayout.LayoutParams(0, 1, 1f)) }
        playBtn = iconBtn("▶", "Play / pause", 68, filled = true) { togglePlay() }
        spacer()
        row.addView(iconBtn("⏮", "Previous chapter", 48) { stepChapter(-1) })
        spacer()
        // back 15 s / forward 30 s; long-press back to hear the last sentence again
        row.addView(iconBtn("↺", "Back 15 seconds (hold: say that again)", 52) { seekBy(-15) }.apply { text = "↺15"; textSize = 16f; setOnLongClickListener { repeatSentence(); true } })
        spacer(); row.addView(playBtn); spacer()
        row.addView(iconBtn("↻", "Forward 30 seconds", 52) { seekBy(30) }.apply { text = "30↻"; textSize = 16f })
        spacer()
        row.addView(iconBtn("⏭", "Next chapter", 48) { stepChapter(1) })
        spacer()
        controls.addView(row, LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = dp(2) })
        val chips = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; setPadding(0, dp(8), 0, 0) }
        speedBtn = chip("1×") { pickSpeed() }
        layoutChip = chip("📖 Pages") { setLayoutMode(!bookMode) }
        val cg = { LinearLayout.LayoutParams(WRAP, WRAP).apply { rightMargin = dp(8) } }
        chips.addView(speedBtn, cg())
        chips.addView(chip("🗣 Voice") { pickVoice() }, cg())
        chips.addView(chip("⏾ Sleep") { sleepMenu() }, cg())
        chips.addView(layoutChip, cg())
        chips.addView(chip("🔖 Notes") { showNotes() }, cg())
        chips.addView(chip("🔎 Find") { searchInBook() }, cg())
        controls.addView(android.widget.HorizontalScrollView(this).apply { isHorizontalScrollBarEnabled = false; addView(chips) })

        val content = FrameLayout(this)
        content.addView(list, FrameLayout.LayoutParams(MATCH, MATCH))
        content.addView(bookView, FrameLayout.LayoutParams(MATCH, MATCH))
        root.addView(topBarView)
        root.addView(recap)
        root.addView(jumpBar)
        root.addView(content, LinearLayout.LayoutParams(MATCH, 0, 1f))
        root.addView(controls)
        setContentView(root)
        showLayout()
        applyAppearance()
        refreshButtons()

        Thread {
            try {
                val d = Library.doc(this, book)
                val pm = HashMap<Int, MutableList<String>>()
                for (p in d.pictures) pm.getOrPut(p.para) { ArrayList() } += p.src
                runOnUiThread {
                    paras = d.paras
                    chapters = d.chapters
                    pics = pm
                    sections = buildSections()
                    loaded = true
                    reloadNotes()
                    curPara = currentPara()
                    adapter.notifyDataSetChanged()
                    list.setSelectionFromTop(curPara, dp(60))
                    if (bookMode) {
                        if (curPara == 0 && !isPlaying()) showSection(0, 0) else showPara(curPara, 0)
                    }
                    refresh(force = true)
                    showRecap(prevOpened)
                    val at = intent.getIntExtra("para", -1)
                    if (at >= 0) { if (intent.getBooleanExtra("play", false)) playFrom(at) else goTo(at) }
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
        resumed = true
        TtsService.listener = { runOnUiThread { refresh() } }
        if (Settings.effectiveTheme(this) != themeIndex) { loadAppearance(); applyAppearance() }
        refresh()
        ui.removeCallbacks(tick)
        ui.postDelayed(tick, 30_000)
    }

    override fun onPause() {
        TtsService.listener = null
        resumed = false
        ui.removeCallbacks(tick)
        if (Settings.syncUri(this) != null) {
            val app = applicationContext
            Thread { try { SyncFile.sync(app) } catch (t: Throwable) {} }.start()
        }
        super.onPause()
    }

    override fun onDestroy() {
        ui.removeCallbacksAndMessages(null)
        probe?.shutdown()
        super.onDestroy()
    }

    override fun dispatchTouchEvent(ev: MotionEvent?): Boolean {
        lastInteraction = System.currentTimeMillis()
        if (ev != null && ::list.isInitialized) {
            val onPage = ev.y < (controls.top.takeIf { controls.visibility == View.VISIBLE } ?: Int.MAX_VALUE)
            if (onPage) scaler.onTouchEvent(ev)
            if (pinching || ev.pointerCount > 1) {
                if (!pinchCancelSent) {
                    val c = MotionEvent.obtain(ev); c.action = MotionEvent.ACTION_CANCEL
                    super.dispatchTouchEvent(c); c.recycle(); pinchCancelSent = true
                }
                if (ev.actionMasked == MotionEvent.ACTION_UP || ev.actionMasked == MotionEvent.ACTION_CANCEL) { pinching = false; pinchCancelSent = false }
                return true
            }
        }
        return super.dispatchTouchEvent(ev)
    }

    /** Every 30 s: count reading time (when you're reading, not listening) and switch to the night theme on schedule. */
    private val tick = object : Runnable {
        override fun run() {
            if (resumed && loaded && !isPlaying() && System.currentTimeMillis() - lastInteraction < 120_000) {
                try { Stats.add(this@ReaderActivity, 30, 0) } catch (t: Throwable) {}
            }
            if (Settings.effectiveTheme(this@ReaderActivity) != themeIndex) { loadAppearance(); applyAppearance() }
            ui.postDelayed(this, 30_000)
        }
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

    private fun refresh(force: Boolean = false) {
        if (!loaded) return
        val s = service()
        val seg = s?.currentSeg()
        val p = (s?.index ?: Library.position(this, book.id)).coerceIn(0, maxOf(0, paras.size - 1))
        val st = seg?.start ?: -1
        val en = seg?.end ?: -1
        if (force || p != curPara || st != curStart || en != curEnd) {
            val paraChanged = p != curPara
            curPara = p; curStart = st; curEnd = en
            if (bookMode) {
                val follow = System.currentTimeMillis() - lastTouch > 6000
                if (follow && (paraChanged || (s != null && st >= 0))) showPara(p, maxOf(0, st))
                if (s != null) bookView.setReading(p, st, en) else bookView.clearReading()
            } else {
                adapter.notifyDataSetChanged()
                if (paraChanged) {
                    val offscreen = curPara < list.firstVisiblePosition || curPara >= list.lastVisiblePosition
                    if (offscreen && System.currentTimeMillis() - lastTouch > 6000) list.setSelectionFromTop(curPara, dp(60))
                }
            }
        }
        updateStatus()
        refreshButtons()
    }

    private fun updateStatus() {
        val s = service()
        val shown = if (bookMode && !isPlaying()) bookView.topPara() else curPara
        val pct = if (paras.isNotEmpty()) (shown + 1) * 100 / paras.size else 0
        val ch = chapterIndex(shown).let { if (it >= 0) chapters[it].title else book.author.ifBlank { "Unknown author" } }
        val sleep = s?.sleepText()?.let { " · $it" } ?: ""
        status.text = "$ch · $pct%$sleep"
        if (!seeking && paras.isNotEmpty()) {
            seek.progress = (shown.toLong() * 1000 / maxOf(1, paras.size - 1)).toInt()
            // about how long is left in this chapter at the current speed
            val ci = chapterIndex(shown)
            val end = if (ci + 1 in chapters.indices) chapters[ci + 1].para else paras.size
            var chars = 0L; for (i in shown until end) chars += paras[i].length
            val mins = (chars / (15.0 * 60 * Settings.rateFor(this, book.id))).toInt()
            seekLabel.text = "$pct% of the book · " + (if (mins < 1) "under a minute" else if (mins < 60) "$mins min" else "${mins / 60} h ${mins % 60} min") + " left in this chapter$sleep"
        }
    }

    private fun stepChapter(d: Int) {
        if (!loaded || chapters.isEmpty()) return
        val cur = chapterIndex(curPara)
        val target = if (d < 0) {
            // back: start of this chapter, or the one before if we're already near its start
            if (cur >= 0 && curPara - chapters[cur].para > 2) cur else cur - 1
        } else cur + 1
        if (target < 0) { goTo(0); return }
        if (target >= chapters.size) { toast("This is the last chapter."); return }
        goTo(chapters[target].para)
    }

    private fun refreshButtons() {
        playBtn.text = if (isPlaying()) "❚❚" else "▶"
        if (::layoutChip.isInitialized) layoutChip.text = if (bookMode) "📖 Pages" else "📜 Scroll"
        speedBtn.text = fmtRate(Settings.rateFor(this, book.id))
    }

    private fun fmtRate(r: Float) = (if (r % 1f == 0f) r.toInt().toString() else r.toString()) + "×"

    // ---------- book view (pages) ----------

    /** Cover + contents first, then each chapter (long chapters cut into slices of up to 250 paragraphs). */
    private fun buildSections(): List<BookPageView.Section> {
        val out = ArrayList<BookPageView.Section>()
        out += BookPageView.Section(0, 0, book.title, true, false)
        val starts = ArrayList<Pair<Int, String>>()
        if (chapters.isEmpty() || chapters[0].para > 0) starts += 0 to book.title
        for (c in chapters) if (c.para < paras.size && (starts.isEmpty() || c.para > starts.last().first)) starts += c.para to c.title
        for ((k, st) in starts.withIndex()) {
            val end = if (k + 1 < starts.size) starts[k + 1].first else paras.size
            var a = st.first
            var first = true
            while (a < end) {
                val b = minOf(end, a + 250)
                out += BookPageView.Section(a, b, st.second, false, first)
                first = false
                a = b
            }
        }
        return out
    }

    private fun sectionOf(para: Int): Int {
        for (k in 1 until sections.size) if (para >= sections[k].start && para < sections[k].end) return k
        return if (sections.size > 1) sections.size - 1 else 0
    }

    private fun showSection(k: Int, anchorPara: Int, atEnd: Boolean = false) {
        if (k < 0 || k >= sections.size) return
        val sec = sections[k]
        curSection = k
        val cover = if (sec.front) Covers.get(this, book) { if (curSection == 0) showSection(0, 0) } else null
        bookView.setContent(sec, paras, chapters, { picturesFor(it) }, bookMarks(), cover, book.title, book.author)
        when {
            atEnd -> bookView.post { bookView.lastPage() }
            !sec.front -> bookView.goToPage(bookView.pageOfPara(anchorPara.coerceIn(sec.start, sec.end - 1)))
            else -> bookView.goToPage(0)
        }
    }

    /** Shows the page holding [para] (character [local] inside it). */
    private fun showPara(para: Int, local: Int) {
        if (sections.isEmpty()) return
        val k = sectionOf(para)
        if (k != curSection) { showSection(k, para); if (local == 0) return }
        val pg = bookView.pageOfPara(para, local)
        if (pg != bookView.page) bookView.goToPage(pg)
    }

    private fun bookMarks(): List<BookPageView.Mark> =
        notes.filter { it.type == "hl" }.map { BookPageView.Mark(it.para, it.start, it.end, hlColor(it.color)) }

    private fun showLayout() {
        list.visibility = if (bookMode) View.GONE else View.VISIBLE
        bookView.visibility = if (bookMode) View.VISIBLE else View.GONE
    }

    private fun setLayoutMode(book: Boolean) {
        val at = if (bookMode) bookView.topPara() else list.firstVisiblePosition
        bookMode = book
        Settings.setLayout(this, if (book) "book" else "scroll")
        showLayout()
        if (!loaded) return
        if (book) { curSection = -1; showPara(if (isPlaying()) curPara else at, 0) }
        else { adapter.notifyDataSetChanged(); list.setSelectionFromTop(at, dp(40)) }
        refresh(force = true)
    }

    override fun pageChanged(userTurn: Boolean) {
        if (userTurn) {
            lastTouch = System.currentTimeMillis()
            if (service() == null && curSection > 0) {
                val top = bookView.topPara()
                curPara = top
                Library.setPosition(this, book.id, top)
            }
        }
        updateStatus()
    }

    override fun needSection(delta: Int) {
        val k = curSection + delta
        if (k < 0) return
        if (k >= sections.size) { toast("That's the end of the book."); return }
        lastTouch = System.currentTimeMillis()
        if (delta < 0) showSection(k, sections[k].start, atEnd = true) else showSection(k, sections[k].start)
        if (bookView.turnStyle == "flip") {
            bookView.rotationY = if (delta > 0) 90f else -90f
            bookView.animate().rotationY(0f).setDuration(200).start()
        }
        pageChanged(true)
    }

    override fun paragraphLongPress(para: Int) = paragraphMenu(para)

    override fun footnoteTap(n: String, para: Int) = showFootnote(n, para)

    override fun tocTap(para: Int) = goTo(para)

    override fun centerTap() {
        val show = controls.visibility != View.VISIBLE
        controls.visibility = if (show) View.VISIBLE else View.GONE
        topBarView.visibility = if (show) View.VISIBLE else View.GONE
    }

    override fun footer(page: Int): Pair<String, String> {
        val sec = sections.getOrNull(curSection) ?: return "" to ""
        if (sec.front) return "" to ""
        val pct = if (paras.isNotEmpty()) (bookView.topPara() + 1) * 100 / paras.size else 0
        return "${page + 1} / ${bookView.pageCount}" to "$pct%"
    }

    override fun header(): String {
        val sec = sections.getOrNull(curSection) ?: return book.title
        return if (sec.front) book.author.ifBlank { book.title } else sec.title.ifBlank { book.title }
    }

    // ---------- "last time…" recap ----------

    private fun showRecap(prevOpened: Long) {
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

    // ---------- footnotes ----------

    private var fnDefs: Map<String, List<Int>>? = null

    private fun showFootnote(n: String, from: Int) {
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

    // ---------- appearance ----------

    private fun loadAppearance() {
        textSize = Settings.textSize(this)
        themeIndex = Settings.effectiveTheme(this)
        theme = READER_THEMES.getOrElse(themeIndex) { READER_THEMES[0] }
        font = FONTS.getOrElse(Settings.font(this)) { FONTS[0] }
        margin = MARGINS_DP.getOrElse(Settings.margin(this)) { 22 }
    }

    private fun applyAppearance() {
        root.setBackgroundColor(theme.bg)
        list.setBackgroundColor(theme.bg)
        list.cacheColorHint = theme.bg
        recap.setTextColor(theme.fg)
        recap.setBackgroundColor(theme.para)
        if (::jumpBar.isInitialized) { jumpBar.setTextColor(theme.fg); jumpBar.setBackgroundColor(theme.para) }
        if (::bookView.isInitialized) {
            bookView.bg = theme.bg; bookView.fg = theme.fg
            bookView.muted = (theme.fg and 0x00FFFFFF) or 0x99000000.toInt()
            bookView.accent = ACCENT; bookView.paraColor = theme.para; bookView.sentColor = theme.sent
            bookView.marginDp = margin
            bookView.turnStyle = Settings.pageTurn(this)
            bookView.paint.typeface = font
            bookView.paint.textSize = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, textSize, resources.displayMetrics)
            if (loaded && bookMode && curSection >= 0) {
                bookView.relayout(bookMarks())
                if (service() != null) bookView.setReading(curPara, curStart, curEnd)
            }
        }
        adapter.notifyDataSetChanged()
    }

    private fun appearanceMenu() {
        val items = arrayOf(
            "Theme: ${theme.name}",
            "Font: ${FONT_NAMES[Settings.font(this).coerceIn(0, 2)]}",
            "Margins: ${MARGIN_NAMES[Settings.margin(this).coerceIn(0, 2)]}",
            "Larger text",
            "Smaller text",
            "Layout: ${if (bookMode) "Book pages" else "Scrolling"}",
            "Page turn: ${if (Settings.pageTurn(this) == "flip") "Page flip" else "Slide"}",
            "Night mode schedule: ${if (Settings.nightOn(this)) "${hm(Settings.nightFrom(this))}–${hm(Settings.nightTo(this))}" else "Off"}"
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
                5 -> { setLayoutMode(!bookMode); appearanceMenu() }
                6 -> {
                    Settings.setPageTurn(this, if (Settings.pageTurn(this) == "flip") "slide" else "flip")
                    bookView.turnStyle = Settings.pageTurn(this)
                    appearanceMenu()
                }
                7 -> nightDialog()
            }
        }.show()
    }

    private fun hm(m: Int) = String.format(Locale.getDefault(), "%d:%02d", m / 60, m % 60)

    /** Switch to a darker theme automatically between two times. */
    private fun nightDialog() {
        var on = Settings.nightOn(this)
        var from = Settings.nightFrom(this)
        var to = Settings.nightTo(this)
        var th = Settings.nightTheme(this)
        val box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(8), dp(20), 0) }
        val check = CheckBox(this).apply { text = "Switch theme automatically at night"; isChecked = on }
        val fromBtn = Button(this); val toBtn = Button(this); val thBtn = Button(this)
        fun label() {
            fromBtn.text = "From ${hm(from)}"; toBtn.text = "Until ${hm(to)}"
            thBtn.text = "Night theme: ${READER_THEMES.getOrElse(th) { READER_THEMES[0] }.name}"
        }
        label()
        fromBtn.setOnClickListener { TimePickerDialog(this, { _, h, m -> from = h * 60 + m; label() }, from / 60, from % 60, false).show() }
        toBtn.setOnClickListener { TimePickerDialog(this, { _, h, m -> to = h * 60 + m; label() }, to / 60, to % 60, false).show() }
        thBtn.setOnClickListener {
            AlertDialog.Builder(this).setItems(READER_THEMES.map { it.name }.toTypedArray()) { _, w -> th = w; label() }.show()
        }
        box.addView(check); box.addView(fromBtn); box.addView(toBtn); box.addView(thBtn)
        AlertDialog.Builder(this).setTitle("Night mode schedule").setView(box)
            .setPositiveButton("Save") { _, _ ->
                on = check.isChecked
                Settings.setNight(this, on, from, to, th)
                loadAppearance(); applyAppearance()
            }
            .setNegativeButton("Cancel", null)
            .show()
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
    private fun goTo(para: Int, record: Boolean = true) {
        if (record) recordJump(para)
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
        if (bookMode) showPara(para, 0) else list.setSelectionFromTop(para, dp(40))
        refresh()
    }

    // ---------- getting around: 15/30 seconds, repeat, places you jumped from, go to ----------

    private fun seekBy(sec: Int) {
        if (!loaded) return
        lastTouch = 0
        val s = service()
        if (s != null) { s.seekSeconds(sec); refresh(); return }
        // not playing: estimate by text length at the current speed
        val cps = 15 * Settings.rateFor(this, book.id)
        var need = kotlin.math.abs(sec) * cps
        var p = curPara
        if (sec < 0) { while (p > 0 && need > 0) { p--; need -= paras[p].length } }
        else { while (p < paras.size - 1 && need > 0) { need -= paras[p].length; p++ } }
        goTo(p, record = false)
    }

    private fun repeatSentence() {
        val s = service()
        if (s != null) s.repeatSentence() else seekBy(-5)
        toast("Again")
    }

    private fun recordJump(to: Int) {
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
    private val hideJump = Runnable { jumpBar.visibility = View.GONE }

    private fun goBackTo(k: Int) {
        val h = history.getOrNull(k) ?: return
        history.removeAt(k)
        val here = curPara
        if (kotlin.math.abs(here - h.first) > 2) history.add(0, here to System.currentTimeMillis())
        goTo(h.first, record = false)
    }

    private fun placeLabel(p: Int): String {
        val pct = (p + 1) * 100 / maxOf(1, paras.size)
        val ch = chapterIndex(p).let { if (it >= 0) chapters[it].title else "Beginning" }
        return "$ch · $pct%"
    }

    private fun showHistory() {
        if (history.isEmpty()) { toast("No jumps yet. When you jump somewhere, the place you left is kept here."); return }
        val now = System.currentTimeMillis()
        val labels = history.map { (p, t) ->
            val m = ((now - t) / 60000).toInt()
            "↶ ${placeLabel(p)}  (" + (if (m < 1) "just now" else if (m < 60) "$m min ago" else "${m / 60} h ago") + ")"
        }.toTypedArray()
        AlertDialog.Builder(this).setTitle("Places you jumped from").setItems(labels) { _, w -> goBackTo(w) }.show()
    }

    /** A slider across the whole book that shows the chapter as you drag. */
    private fun goToDialog() {
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

    // ---------- audio clips with bookmarks ----------
    private fun saveClip(p: Int) {
        val s = service()
        val segText = if (s != null && curPara == p && s.currentSegText() != null) s.currentSegText()!! else paras[p].split(Regex("(?<=[.!?…])\\s+")).let { parts ->
            var t = ""; for (x in parts) { if (t.length > 60) break; t = (t + " " + x).trim() }; t
        }
        val quote = segText.take(400)
        val text = Speaker(this).spoken(quote) ?: quote
        toast("Making the clip…")
        val engine = TextToSpeech(this, null)
        val dir = java.io.File(filesDir, "clips/${book.id}").apply { mkdirs() }
        val name = "clip-${System.currentTimeMillis()}.wav"
        val out = java.io.File(dir, name)
        engine.setOnUtteranceProgressListener(object : android.speech.tts.UtteranceProgressListener() {
            override fun onStart(id: String?) {}
            override fun onDone(id: String?) {
                runOnUiThread {
                    engine.shutdown()
                    val list = Library.notes(this@ReaderActivity, book.id)
                    list += Note(p, "", System.currentTimeMillis(), "clip", 0, 0, "yellow", quote, name)
                    Library.saveNotes(this@ReaderActivity, book.id, list)
                    reloadNotes()
                    toast("Saved the clip with a bookmark. Find it in Bookmarks & notes.")
                }
            }
            @Deprecated("Deprecated in Java")
            override fun onError(id: String?) { runOnUiThread { engine.shutdown(); toast("Couldn't make the clip.") } }
        })
        // wait for the engine, then speak to a file with this book's voice and speed
        ui.postDelayed(object : Runnable {
            var tries = 0
            override fun run() {
                if (engine.voices == null && tries++ < 20) { ui.postDelayed(this, 150); return }
                VoiceNames.apply(engine, Settings.voiceFor(this@ReaderActivity, book.id))
                engine.setSpeechRate(Settings.rateFor(this@ReaderActivity, book.id))
                engine.synthesizeToFile(text, Bundle(), out, "clip")
            }
        }, 300)
    }

    private fun playClip(n: Note) {
        val f = java.io.File(filesDir, "clips/${book.id}/${n.file}")
        if (!f.exists()) { toast("This clip was made on another device."); return }
        if (service()?.playing == true) togglePlay()
        try {
            android.media.MediaPlayer().apply { setDataSource(f.path); setOnCompletionListener { it.release() }; prepare(); start() }
        } catch (t: Throwable) { toast("Couldn't play the clip.") }
    }

    private fun shareClip(n: Note) {
        val uri = android.net.Uri.parse("content://${packageName}.clips/${book.id}/${n.file}")
        val send = Intent(Intent.ACTION_SEND).setType("audio/wav")
            .putExtra(Intent.EXTRA_STREAM, uri)
            .putExtra(Intent.EXTRA_TEXT, "“${n.quote}” — ${book.title}")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        startActivity(Intent.createChooser(send, "Share clip"))
    }

    private fun pickSpeed() {
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

    // ---------- chapters ----------

    private fun showChapters() {
        if (!loaded) return
        if (chapters.isEmpty()) { toast("No chapters were found in this book."); return }
        val cur = chapterIndex(curPara)
        val labels = chapters.mapIndexed { k, c -> (if (k == cur) "▶ " else "") + (if (c.level == 1) "      " else "") + c.title }.toTypedArray()
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
        for (n in notes) if (n.type != "hl" || n.text.isNotBlank()) m[n.para] = if (n.text.isBlank() && m[n.para] == null) "🔖 " else "📝 "
        marks = m
        adapter.notifyDataSetChanged()
        if (bookMode && curSection > 0) {
            bookView.relayout(bookMarks())
            if (service() != null) bookView.setReading(curPara, curStart, curEnd)
        }
    }

    private fun paragraphMenu(p: Int) {
        val here = notes.filter { it.para == p }
        val items = ArrayList<String>()
        items += "Read aloud from here"
        items += "Bookmark this paragraph"
        items += "Add a note…"
        items += "Copy text"
        items += "Highlight, define or note a passage…"
        items += "Bookmark with an audio clip"
        if (here.isNotEmpty()) items += "Remove bookmark / notes / highlights here"
        val refs = FN_REF.findAll(paras[p]).map { it.groupValues[1] }.distinct().toList()
        for (r in refs) items += "Show note [$r]"
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
                    4 -> selectIn(p)
                    5 -> saveClip(p)
                    else -> {
                        val label = items[w]
                        if (label.startsWith("Show note [")) showFootnote(label.substringAfter("[").substringBefore("]"), p)
                        else {
                            notes.filter { it.para == p && it.type == "clip" }.forEach { java.io.File(filesDir, "clips/${book.id}/${it.file}").delete() }
                            Library.saveNotes(this, book.id, notes.filter { it.para != p })
                            reloadNotes()
                        }
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

    // ---------- voices ----------

    private fun pickVoice() {
        // A separate engine is used for listing and previewing, so previews don't disturb playback.
        val p = probe
        if (p != null && probeReady) { showVoices(p); return }
        status.text = "Loading voices…"
        if (p == null) {
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

    private class VoiceChoice(val voice: Voice?, val label: String)

    private fun showVoices(engine: TextToSpeech) {
        val all: List<Voice> = try { engine.voices?.toList() ?: emptyList() } catch (e: Throwable) { emptyList() }
        val lang = Locale.getDefault().language
        val usable = all.filter {
            it.locale.language == lang &&
                !(it.features?.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) ?: false)
        }
        val choices = ArrayList<VoiceChoice>()
        choices += VoiceChoice(null, "Phone's default voice")
        choices += VoiceNames.friendly(usable).map { VoiceChoice(it.first, it.second) }
        val chosen = Settings.voiceFor(this, book.id)
        var picked = choices.indexOfFirst { it.voice?.name == chosen }.let { if (it < 0) 0 else it }
        val wasPlaying = isPlaying()
        if (wasPlaying) startService(Intent(this, TtsService::class.java).setAction(TtsService.ACTION_PAUSE))

        AlertDialog.Builder(this)
            .setTitle("Voice for this book. Tap to hear it.")
            .setSingleChoiceItems(choices.map { it.label }.toTypedArray(), picked) { _, w ->
                picked = w
                preview(engine, choices[w].voice)
            }
            .setPositiveButton("Use this voice") { _, _ ->
                engine.stop()
                Settings.setBookVoice(this, book.id, choices[picked].voice?.name)
                TtsService.instance?.applySettings(false)
                if (wasPlaying) startService(Intent(this, TtsService::class.java).setAction(TtsService.ACTION_TOGGLE))
                else toast("Voice saved. Press Play to listen.")
            }
            .setNeutralButton("Get more voices…") { _, _ -> engine.stop(); openTtsSettings() }
            .setNegativeButton("Cancel") { _, _ -> engine.stop() }
            .show()
    }

    private fun preview(engine: TextToSpeech, v: Voice?) {
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

    // ---------- word lookup ----------

    /** Shows the paragraph with selectable text: pick words, then Define, a highlighter colour, or Note. */
    private fun selectIn(p: Int) {
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
                        (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Shelf Reader", sel))
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

    private fun addHighlight(p: Int, a: Int, b: Int, color: String, note: String) {
        val l = Library.notes(this, book.id)
        l += Note(p, note, System.currentTimeMillis(), "hl", a, b, color, paras[p].substring(a, b))
        Library.saveNotes(this, book.id, l)
        reloadNotes()
    }

    private fun highlightNote(p: Int, a: Int, b: Int) {
        val box = EditText(this).apply { hint = "Your note"; minLines = 2 }
        val wrap = LinearLayout(this).apply { setPadding(dp(20), dp(8), dp(20), 0); addView(box, LinearLayout.LayoutParams(MATCH, WRAP)) }
        AlertDialog.Builder(this).setTitle("Note on “${paras[p].substring(a, b).take(60)}”").setView(wrap)
            .setPositiveButton("Save") { _, _ -> addHighlight(p, a, b, "yellow", box.text.toString().trim()) }
            .setNegativeButton("Cancel", null)
            .show()
    }

    /** Shares your highlights, notes and bookmarks as a Markdown text (save it to Drive, email it, etc.). */
    private fun exportNotes() {
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

    private fun define(word: String) {
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

    // ---------- search in book ----------

    private fun searchInBook() {
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

    private fun showSearchResults(q: String) {
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

    // ---------- collections ----------

    private fun collectionsDialog() {
        editCollections(this, book.id) {}
    }

    // ---------- menu ----------

    /** Everything else, grouped, with clear names. */
    private fun moreSheet() {
        sheet(book.title, listOf(
            SheetRow("🧭", "Go to…", "Slider or percentage, with chapter names") { action(17) },
            SheetRow("↶", "Places you jumped from", "Undo an accidental jump") { action(18) },
            SheetRow("🔎", "Search in this book") { action(11) },
            SheetRow("🔖", "Bookmarks, notes & highlights") { action(2) },
            null,
            SheetRow("🗣", "Voice", "Choose the voice for this book") { action(4) },
            SheetRow("⏾", "Sleep timer", "Stop after a time or at the end of the chapter") { action(3) },
            SheetRow("⏸", "Natural pauses & chapter announcements", null, Settings.naturalPauses(this)) { action(19) },
            SheetRow("🔢", "Say numbers properly", "Chapter XII → Twelve, 1850s, \$4.50", Settings.speakNumbers(this)) { action(20) },
            SheetRow("✂", "Skip page numbers & clutter", null, Settings.skipClutter(this)) { action(7) },
            SheetRow("🔤", "Pronunciations", "Fix words the voice says wrong") { action(6) },
            null,
            SheetRow("🎵", "Save as audio files…", "MP3-style audio of the book or a chapter") { action(8) },
            SheetRow("📤", "Export highlights & notes…") { action(15) },
            SheetRow("🗂", "Collections…") { action(13) },
            SheetRow("🚗", "Car mode", "Huge buttons for driving") { action(12) },
            SheetRow("📊", "Reading stats") { action(16) },
            SheetRow("⏮", "Back to the start") { action(9) },
            SheetRow("⚙", "Android speech settings") { action(10) }
        ))
    }

    /** Text size, theme and layout in one place (you can also pinch the text to resize it). */
    private fun lookSheet() {
        sheet("Text and look · tip: pinch the page to zoom", listOf(
            SheetRow("A+", "Bigger text", "Now ${textSize.toInt()}") { changeTextSize(2f); lookSheet() },
            SheetRow("A−", "Smaller text", "Now ${textSize.toInt()}") { changeTextSize(-2f); lookSheet() },
            SheetRow("🎨", "Theme: ${theme.name}", "Dark, light, sepia or black") {
                AlertDialog.Builder(this).setItems(READER_THEMES.map { it.name }.toTypedArray()) { _, w -> Settings.setTheme(this, w); loadAppearance(); applyAppearance() }.show()
            },
            SheetRow(if (bookMode) "📜" else "📖", if (bookMode) "Switch to scrolling" else "Switch to book pages", if (bookMode) "One long page" else "Swipe or tap the edges to turn pages") { setLayoutMode(!bookMode) },
            SheetRow("🔠", "Font, margins, page turn, night mode…") { appearanceMenu() }
        ))
    }

    private fun changeTextSize(d: Float) {
        Settings.setTextSize(this, (textSize + d).coerceIn(12f, 40f))
        loadAppearance(); applyAppearance()
    }

    // pinch anywhere on the page to make the text bigger or smaller
    private val scaler by lazy {
        android.view.ScaleGestureDetector(this, object : android.view.ScaleGestureDetector.SimpleOnScaleGestureListener() {
            override fun onScaleBegin(d: android.view.ScaleGestureDetector): Boolean { pinching = true; pinchSize = textSize; return true }
            override fun onScale(d: android.view.ScaleGestureDetector): Boolean {
                pinchSize = (pinchSize * d.scaleFactor).coerceIn(12f, 40f)
                status.text = "Text size ${pinchSize.toInt()}"
                if (!bookMode) { textSize = pinchSize; adapter.notifyDataSetChanged() }
                return true
            }
            override fun onScaleEnd(d: android.view.ScaleGestureDetector) {
                Settings.setTextSize(this@ReaderActivity, pinchSize)
                loadAppearance(); applyAppearance(); updateStatus()
            }
        })
    }

    private fun action(id: Int): Boolean {
        when (id) {
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
            11 -> searchInBook()
            12 -> startActivity(Intent(this, CarModeActivity::class.java).putExtra("book", book.id))
            13 -> collectionsDialog()
            14 -> setLayoutMode(!bookMode)
            15 -> exportNotes()
            16 -> showStats(this)
            17 -> goToDialog()
            18 -> showHistory()
            19 -> {
                Settings.setNaturalPauses(this, !Settings.naturalPauses(this))
                TtsService.instance?.applySettings(true)
                toast(if (Settings.naturalPauses(this)) "Natural pauses on" else "Natural pauses off")
            }
            20 -> {
                Settings.setSpeakNumbers(this, !Settings.speakNumbers(this))
                TtsService.instance?.applySettings(true)
                toast(if (Settings.speakNumbers(this)) "Numbers and Roman numerals are said as words" else "Numbers are read as written")
            }
            else -> return false
        }
        return true
    }
}

private const val ACCENT = 0xFF4A90E2.toInt()
private val HL_NAMES = listOf("yellow", "green", "pink")
/** A footnote marker in the text, like [3]. */
val FN_REF = Regex("\\[(\\d{1,3}|[*†‡])\\]")
/** The start of a footnote's own paragraph, like "3." or "[3]" or "Footnote 3:". */
val FN_DEF = Regex("^\\s*\\[?(?:Footnote\\s+)?(\\d{1,3}|[*†‡])(?:\\]|:|\\.|\\))\\s*", RegexOption.IGNORE_CASE)
fun hlColor(name: String): Int = when (name) {
    "green" -> 0x5560D060
    "pink" -> 0x55FF6FA8
    else -> 0x66FFD54A
}
