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

    internal lateinit var book: Book
    internal var paras: List<String> = emptyList()
    internal var chapters: List<Chapter> = emptyList()
    internal var pics: Map<Int, List<String>> = emptyMap()
    /** cont[i]: paragraph i is the rest of a sentence broken off at the end of paragraph i-1 */
    internal var cont = BooleanArray(0)

    /** Works out which paragraphs carry on a sentence from the one before. */
    internal fun findBrokenLines(ps: List<String>): BooleanArray {
        if (!Settings.fixBrokenLines(this)) return BooleanArray(ps.size)
        val len = SpeechText.lineLength(ps)
        return BooleanArray(ps.size) { i -> i > 0 && SpeechText.continues(ps[i - 1], ps[i], len) }
    }

    /** The first paragraph of the run that [p] belongs to (the row that shows it in the scrolling view). */
    internal fun rowOf(p: Int): Int { var k = p; while (k > 0 && cont.getOrElse(k) { false }) k--; return k }
    internal var notes: List<Note> = emptyList()
    internal var marks: Map<Int, String> = emptyMap()

    internal lateinit var root: LinearLayout
    internal lateinit var list: ListView
    internal lateinit var bookView: BookPageView
    internal lateinit var controls: LinearLayout
    internal lateinit var topBarView: LinearLayout
    internal lateinit var playBtn: TextView
    internal lateinit var speedBtn: TextView
    internal lateinit var layoutChip: TextView
    internal lateinit var compactBtn: TextView
    internal lateinit var chipScroll: View
    internal lateinit var seek: android.widget.SeekBar
    internal lateinit var seekLabel: TextView
    internal var seeking = false
    internal var pinching = false
    internal var pinchCancelSent = false
    internal var pinchSize = 18f
    internal lateinit var status: TextView
    internal lateinit var recap: TextView
    internal lateinit var jumpBar: TextView
    /** Places you jumped away from (newest first), so you can go back. */
    internal val history = ArrayList<Pair<Int, Long>>()

    internal var curPara = 0
    internal var curStart = -1
    internal var curEnd = -1
    internal var lastTouch = 0L
    internal var lastInteraction = System.currentTimeMillis()
    internal var loaded = false
    internal var resumed = false

    internal var textSize = 18f
    internal var theme = READER_THEMES[0]
    internal var themeIndex = 0
    internal var font = FONTS[0]
    internal var margin = 22

    internal var bookMode = true
    internal var sections: List<BookPageView.Section> = emptyList()
    internal var curSection = -1
    internal val picBmCache = object : LruCache<String, Bitmap>(24 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap) = value.byteCount
    }

    internal var probe: TextToSpeech? = null
    internal var probeReady = false
    internal var pendingExport: Pair<Int, Int>? = null
    internal val ui = Handler(Looper.getMainLooper())

    internal val adapter = object : BaseAdapter() {
        override fun getCount() = paras.size
        override fun getItem(position: Int): Any = paras[position]
        override fun getItemId(position: Int) = position.toLong()
        override fun getViewTypeCount() = 2
        override fun getItemViewType(position: Int) = if (cont.getOrElse(position) { false }) 1 else 0
        override fun getView(position: Int, convertView: View?, parent: ViewGroup?): View {
            // a line that carries on the sentence before it is shown inside that paragraph's row
            if (cont.getOrElse(position) { false }) return convertView ?: View(this@ReaderActivity).apply { layoutParams = AbsListView.LayoutParams(MATCH, 0) }
            val tv = (convertView as? TextView) ?: TextView(this@ReaderActivity).apply { setLineSpacing(0f, 1.3f) }
            val m = dp(margin)
            tv.setPadding(m, dp(7), m, dp(7))
            tv.textSize = textSize
            tv.typeface = font
            tv.setTextColor(theme.fg)
            var end = position
            while (cont.getOrElse(end + 1) { false }) end++
            tv.setBackgroundColor(if (curPara in position..end) theme.para else Color.TRANSPARENT)
            if (end == position) tv.text = rowText(position)
            else {
                val sb = SpannableStringBuilder(rowText(position))
                for (j in position + 1..end) {
                    // "won-" + "derful" → "wonderful"; otherwise a space
                    if (!Regex("\\p{Ll}-$").containsMatchIn(paras[j - 1].trimEnd()) || paras[j].trimStart().firstOrNull()?.isLowerCase() != true) sb.append(" ")
                    else if (sb.isNotEmpty() && sb[sb.length - 1] == '-') sb.delete(sb.length - 1, sb.length)
                    sb.append(rowText(j))
                }
                tv.text = sb
            }
            return tv
        }
    }

    /** One paragraph for the scrolling view: pictures, bookmark marker, highlights, footnote markers, reading highlight. */
    internal fun rowText(i: Int): CharSequence {
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
    internal fun picturesFor(i: Int): List<Bitmap> {
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
        CrashReport.install(this)
        val id = intent.getStringExtra("book")
        val b = id?.let { Library.get(this, it) }
        if (b == null) { finish(); return }
        book = b
        CrashReport.check(this)
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
        bookView = BookPageView(this).apply { host = this@ReaderActivity; continues = { i -> cont.getOrElse(i) { false } } }

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
        compactBtn = iconBtn("⌄", "Smaller player (more room for the text)", 40) { setCompact(!Settings.compactPlayer(this)) }
        row.addView(compactBtn)
        controls.addView(row, LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = dp(2) })
        val chips = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; setPadding(0, dp(8), 0, 0) }
        speedBtn = chip("1×") { pickSpeed() }
        layoutChip = chip("📖 Pages") { setLayoutMode(!bookMode) }
        val cg = { LinearLayout.LayoutParams(WRAP, WRAP).apply { rightMargin = dp(8) } }
        chips.addView(speedBtn, cg())
        chips.addView(chip("🗣 Voice") { pickVoice() }, cg())
        chips.addView(chip("🌙 Sleep") { sleepMenu() }, cg())
        chips.addView(chip("🌧 Sounds") { AmbiencePicker(this).show() }, cg())
        chips.addView(layoutChip, cg())
        chips.addView(chip("🔖 Notes") { showNotes() }, cg())
        chips.addView(chip("🔎 Find") { searchInBook() }, cg())
        chips.setPadding(0, dp(8), dp(24), 0)
        chipScroll = android.widget.HorizontalScrollView(this).apply { isHorizontalScrollBarEnabled = false; isFillViewport = false; addView(chips) }
        controls.addView(chipScroll)

        val content = FrameLayout(this)
        content.addView(list, FrameLayout.LayoutParams(MATCH, MATCH))
        content.addView(bookView, FrameLayout.LayoutParams(MATCH, MATCH))
        root.addView(topBarView)
        root.addView(recap)
        root.addView(jumpBar)
        root.addView(tipCard("reader", "How it works: tap a paragraph to read aloud from there · double-tap to play or pause · swipe sideways to skip a paragraph · press and hold for bookmarks, notes and copy. In book pages, tap the edges to turn and the middle to hide the controls."),
            LinearLayout.LayoutParams(MATCH, WRAP).apply { setMargins(dp(10), dp(8), dp(10), dp(4)) })
        root.addView(content, LinearLayout.LayoutParams(MATCH, 0, 1f))
        root.addView(controls)
        setContentView(root)
        showLayout()
        applyAppearance()
        refreshButtons()
        setCompact(Settings.compactPlayer(this))

        Thread {
            try {
                val d = Library.doc(this, book)
                val pm = HashMap<Int, MutableList<String>>()
                for (p in d.pictures) pm.getOrPut(p.para) { ArrayList() } += p.src
                runOnUiThread {
                    paras = d.paras
                    chapters = d.chapters
                    cont = findBrokenLines(d.paras)
                    pics = pm
                    sections = buildSections()
                    loaded = true
                    reloadNotes()
                    curPara = currentPara()
                    adapter.notifyDataSetChanged()
                    list.setSelectionFromTop(rowOf(curPara), dp(60))
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
    internal val tick = object : Runnable {
        override fun run() {
            if (resumed && loaded && !isPlaying() && System.currentTimeMillis() - lastInteraction < 120_000) {
                try { Stats.add(this@ReaderActivity, 30, 0) } catch (t: Throwable) {}
            }
            if (Settings.effectiveTheme(this@ReaderActivity) != themeIndex) { loadAppearance(); applyAppearance() }
            ui.postDelayed(this, 30_000)
        }
    }

    // ---------- state ----------

    internal fun jumpBarReady() = ::jumpBar.isInitialized
    internal fun bookViewReady() = ::bookView.isInitialized

    internal fun service(): TtsService? = TtsService.instance?.takeIf { it.bookId == book.id }

    internal fun currentPara(): Int = service()?.index ?: Library.position(this, book.id)

    internal fun isPlaying() = service()?.playing == true

    internal fun chapterIndex(para: Int): Int {
        var r = -1
        for ((k, c) in chapters.withIndex()) { if (c.para <= para) r = k else break }
        return r
    }

    internal fun refresh(force: Boolean = false) {
        if (followNextBook()) return
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
                    val row = rowOf(curPara)
                    val offscreen = row < list.firstVisiblePosition || row >= list.lastVisiblePosition
                    if (offscreen && System.currentTimeMillis() - lastTouch > 6000) list.setSelectionFromTop(row, dp(60))
                }
            }
        }
        updateStatus()
        refreshButtons()
    }

    /** When this book ended and the next one started by itself, show that one. */
    private fun followNextBook(): Boolean {
        val s = TtsService.instance ?: return false
        val now = s.bookId ?: return false
        if (!::book.isInitialized || now == book.id || s.continuedFrom != book.id || isFinishing) return false
        finish()
        startActivity(Intent(this, ReaderActivity::class.java).putExtra("book", now))
        return true
    }

    internal fun updateStatus() {
        val s = service()
        s?.pendingNext?.let { n ->
            status.text = "Finished 🎉 · next: ${Library.get(this, n)?.title ?: "the next book"} in a moment · ■ to stop it"
            return
        }
        val shown = if (bookMode && !isPlaying()) bookView.topPara() else curPara
        val pct = if (paras.isNotEmpty()) (shown + 1) * 100 / paras.size else 0
        val ch = chapterIndex(shown).let { if (it >= 0) prettyChapter(chapters[it].title) else book.author.ifBlank { "Unknown author" } }
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

    /** Compact player: one row of buttons, so the text gets more of the screen. */
    internal fun setCompact(on: Boolean) {
        Settings.setCompactPlayer(this, on)
        seekLabel.visibility = if (on) View.GONE else View.VISIBLE
        chipScroll.visibility = if (on) View.GONE else View.VISIBLE
        compactBtn.text = if (on) "⌃" else "⌄"
        compactBtn.contentDescription = if (on) "Bigger player (speed, voice, sleep and more)" else "Smaller player (more room for the text)"
        (playBtn.layoutParams as? LinearLayout.LayoutParams)?.let { val sz = dp(if (on) 52 else 68); it.width = sz; it.height = sz; playBtn.layoutParams = it }
    }

    internal fun stepChapter(d: Int) {
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

    internal fun refreshButtons() {
        playBtn.text = if (service()?.pendingNext != null) "■" else if (isPlaying()) "❚❚" else "▶"
        if (::layoutChip.isInitialized) layoutChip.text = if (bookMode) "📖 Pages" else "📜 Scroll"
        speedBtn.text = fmtRate(Settings.rateFor(this, book.id))
    }

    internal fun fmtRate(r: Float) = (if (r % 1f == 0f) r.toInt().toString() else r.toString()) + "×"

    // ---------- book view (pages) ----------

    /** Cover + contents first, then each chapter (long chapters cut into slices of up to 250 paragraphs). */
    internal fun buildSections(): List<BookPageView.Section> {
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

    internal fun sectionOf(para: Int): Int {
        for (k in 1 until sections.size) if (para >= sections[k].start && para < sections[k].end) return k
        return if (sections.size > 1) sections.size - 1 else 0
    }

    internal fun showSection(k: Int, anchorPara: Int, atEnd: Boolean = false) {
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
    internal fun showPara(para: Int, local: Int) {
        if (sections.isEmpty()) return
        val k = sectionOf(para)
        if (k != curSection) { showSection(k, para); if (local == 0) return }
        val pg = bookView.pageOfPara(para, local)
        if (pg != bookView.page) bookView.goToPage(pg)
    }

    internal fun bookMarks(): List<BookPageView.Mark> =
        notes.filter { it.type == "hl" }.map { BookPageView.Mark(it.para, it.start, it.end, hlColor(it.color)) }

    internal fun showLayout() {
        list.visibility = if (bookMode) View.GONE else View.VISIBLE
        bookView.visibility = if (bookMode) View.VISIBLE else View.GONE
    }

    internal fun setLayoutMode(book: Boolean) {
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

    // ---------- footnotes ----------

    internal var fnDefs: Map<String, List<Int>>? = null

    // ---------- appearance ----------

    internal fun choose(titleText: String, options: List<String>, save: (Int) -> Unit) {
        AlertDialog.Builder(this).setTitle(titleText).setItems(options.toTypedArray()) { _, w ->
            save(w)
            loadAppearance()
            applyAppearance()
            appearanceMenu()
        }.show()
    }

    // ---------- playback controls ----------

    internal fun playFrom(i: Int) {
        if (!loaded) return
        lastTouch = 0
        startForegroundService(
            Intent(this, TtsService::class.java)
                .setAction(TtsService.ACTION_PLAY)
                .putExtra(TtsService.EXTRA_BOOK, book.id)
                .putExtra(TtsService.EXTRA_INDEX, i)
        )
    }

    internal fun togglePlay() {
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

    internal fun step(d: Int) {
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
    internal fun goTo(para: Int, record: Boolean = true) {
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
        if (bookMode) showPara(para, 0) else list.setSelectionFromTop(rowOf(para), dp(40))
        refresh()
    }

    // ---------- getting around: 15/30 seconds, repeat, places you jumped from, go to ----------

    internal fun seekBy(sec: Int) {
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

    internal fun repeatSentence() {
        val s = service()
        if (s != null) s.repeatSentence() else seekBy(-5)
        toast("Again")
    }

    internal val hideJump = Runnable { jumpBar.visibility = View.GONE }

    // ---------- chapters ----------

    // ---------- sleep timer ----------

    // ---------- bookmarks & notes ----------

    // ---------- voices ----------

    // ---------- voices: one screen for natural (Kokoro / Piper) and phone voices ----------
    internal var voicePickerOpen = false

    // ---------- audio export ----------

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

    // ---------- search in book ----------

    // ---------- collections ----------

    internal fun collectionsDialog() {
        editCollections(this, book.id) {}
    }

    // ---------- menu ----------

    /** Everything else, grouped, with clear names. */
    internal fun moreSheet() {
        sheet(book.title, listOf(
            SheetRow("🧭", "Go to…", "Slider or percentage, with chapter names") { action(17) },
            SheetRow("↶", "Places you jumped from", "Undo an accidental jump") { action(18) },
            SheetRow("🔎", "Search in this book") { action(11) },
            SheetRow("🔖", "Bookmarks, notes & highlights") { action(2) },
            null,
            SheetRow("🗣", "Voice", "Choose the voice for this book") { action(4) },
            SheetRow("🔁", "Keep listening", "When this book ends, start another one", Settings.autoNextBook(this)) {
                Settings.setAutoNextBook(this, !Settings.autoNextBook(this))
                toast(if (Settings.autoNextBook(this)) "When a book ends, the next one starts by itself" else "Stops at the end of a book (unless something is in Up next)")
            },
            SheetRow("🌙", "Sleep timer", "Stop after a time or at the end of the chapter") { action(3) },
            SheetRow("🌧", "Background sounds", Ambience.summary(this).let { if (it == "Off") "Rain, waves, fire, white noise… under the voice" else it }) { AmbiencePicker(this).show() },
            SheetRow("⏸", "Natural pauses & chapter announcements", null, Settings.naturalPauses(this)) { action(19) },
            SheetRow("🔢", "Say numbers properly", "Chapter XII → Twelve, 1850s, \$4.50", Settings.speakNumbers(this)) { action(20) },
            SheetRow("✂", "Skip page numbers & clutter", null, Settings.skipClutter(this)) { action(7) },
            SheetRow("🧵", "Fix broken lines", "Join sentences a book split across lines, before reading", Settings.fixBrokenLines(this)) {
                Settings.setFixBrokenLines(this, !Settings.fixBrokenLines(this))
                cont = findBrokenLines(paras)
                TtsService.instance?.applySettings(true)
                curSection = -1; if (bookMode) showPara(curPara, 0) else adapter.notifyDataSetChanged()
                toast(if (Settings.fixBrokenLines(this)) "Broken lines are joined into whole sentences" else "Lines are read as they are in the book")
            },
            SheetRow("🔤", "Pronunciations", "Fix words the voice says wrong") { action(6) },
            null,
            SheetRow("🎵", "Save as audio files…", "MP3-style audio of the book or a chapter") { action(8) },
            SheetRow("📤", "Export highlights & notes…") { action(15) },
            SheetRow("🗂", "Collections…") { action(13) },
            SheetRow("🚗", "Car mode", "Huge buttons for driving") { action(12) },
            SheetRow("📊", "Reading stats") { action(16) },
            SheetRow("⏮", "Back to the start") { action(9) },
            SheetRow("⚙", "Android speech settings") { action(10) },
            SheetRow("🐞", "Report a problem", "Stuck, skipping, wrong words? Sends what the app was doing") { CrashReport.reportProblem(this) },
            SheetRow("💡", "How to use the reader", "Taps, swipes and shortcuts") {
                AlertDialog.Builder(this).setTitle("How to use the reader").setMessage(
                    "• Tap a paragraph to read aloud from there.\n" +
                    "• Double-tap to play or pause.\n" +
                    "• Swipe sideways to skip a paragraph.\n" +
                    "• Press and hold a paragraph to bookmark, add a note, highlight or copy.\n" +
                    "• Pinch to make the text bigger or smaller.\n" +
                    "• Hold ↺15 to hear the last sentence again.\n" +
                    "• In book pages, tap the edges to turn and the middle to hide the controls.\n\n" +
                    "It keeps reading with the screen off. The controls are also in your notifications and on the lock screen."
                ).setPositiveButton("OK", null).show()
            }
        ))
    }

    // pinch anywhere on the page to make the text bigger or smaller
    internal val scaler by lazy {
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

    internal fun action(id: Int): Boolean {
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

internal const val ACCENT = 0xFF4A90E2.toInt()
internal val HL_NAMES = listOf("yellow", "green", "pink")
/** A footnote marker in the text, like [3]. */
val FN_REF = Regex("\\[(\\d{1,3}|[*†‡])\\]")
/** The start of a footnote's own paragraph, like "3." or "[3]" or "Footnote 3:". */
val FN_DEF = Regex("^\\s*\\[?(?:Footnote\\s+)?(\\d{1,3}|[*†‡])(?:\\]|:|\\.|\\))\\s*", RegexOption.IGNORE_CASE)
fun hlColor(name: String): Int = when (name) {
    "green" -> 0x5560D060
    "pink" -> 0x55FF6FA8
    else -> 0x66FFD54A
}
