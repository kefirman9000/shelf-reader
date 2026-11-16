package com.shelfreader

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.BitmapDrawable
import android.text.Layout
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.StaticLayout
import android.text.TextPaint
import android.text.TextUtils
import android.text.style.AlignmentSpan
import android.text.style.BackgroundColorSpan
import android.text.style.ForegroundColorSpan
import android.text.style.ImageSpan
import android.text.style.LeadingMarginSpan
import android.text.style.RelativeSizeSpan
import android.text.style.StyleSpan
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.View
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

/**
 * Book view: one chapter (or a slice of a long chapter) laid out as pages.
 * Tap the right/left edge or swipe to turn; long-press a paragraph for its menu;
 * tap a [1]-style marker for the footnote. Section 0 can be the cover + contents pages.
 */
class BookPageView(ctx: Context) : View(ctx) {

    interface Host {
        fun pageChanged(userTurn: Boolean)
        fun needSection(delta: Int)
        fun paragraphLongPress(para: Int)
        fun footnoteTap(n: String, para: Int)
        fun tocTap(para: Int)
        fun centerTap()
        fun footer(page: Int): Pair<String, String>
        fun header(): String
    }

    class Section(val start: Int, val end: Int, val title: String, val front: Boolean, val firstOfChapter: Boolean)
    class Mark(val para: Int, val start: Int, val end: Int, val color: Int)

    var host: Host? = null
    var turnStyle = "slide"
    var bg = 0; var fg = 0; var muted = 0; var accent = 0; var paraColor = 0; var sentColor = 0
    var marginDp = 22
    val paint = TextPaint(Paint.ANTI_ALIAS_FLAG)
    private val small = TextPaint(Paint.ANTI_ALIAS_FLAG)
    private val dp = resources.displayMetrics.density

    private var sec: Section? = null
    private var allParas: List<String> = emptyList()
    private var chapterStarts: Set<Int> = emptySet()
    private var pictures: (Int) -> List<Bitmap> = { emptyList() }
    private var marks: List<Mark> = emptyList()
    private var paraStart = IntArray(0)
    private var text = SpannableStringBuilder()
    private var layout: StaticLayout? = null
    private val pageLines = ArrayList<Int>()

    // cover & contents
    private var cover: Bitmap? = null
    private var bookTitle = ""
    private var bookAuthor = ""
    private var toc: List<Chapter> = emptyList()
    private var tocPerPage = 1
    private val tocRows = ArrayList<Pair<RectF, Int>>()

    var page = 0
        private set
    val pageCount: Int
        get() = if (sec?.front == true) 1 + max(1, ceil(toc.size / tocPerPage.toDouble()).toInt()) else max(1, pageLines.size)
    val section: Section? get() = sec

    private var readPara: Any? = null
    private var readSent: Any? = null

    private var anim: ValueAnimator? = null
    private var animFrom = 0
    private var animTo = 0
    private var animDir = 1
    private var animT = 0f
    private var pendingAnchor = -1

    private val padX get() = (marginDp * dp).toInt()
    private val headerH get() = (36 * dp).toInt()
    private val footerH get() = (36 * dp).toInt()
    private val contentW get() = max(50, width - 2 * padX)
    private val contentH get() = max(50, height - headerH - footerH)
    private val fnRegex = Regex("\\[(\\d{1,3}|[*†‡])\\]")

    init {
        small.textSize = 12 * dp
        cameraDistance = 9000 * dp
    }

    /** Is paragraph i the rest of a sentence broken off in paragraph i-1? */
    var continues: (Int) -> Boolean = { false }

    fun setContent(
        section: Section, paras: List<String>, chapters: List<Chapter>, pics: (Int) -> List<Bitmap>,
        highlights: List<Mark>, coverBmp: Bitmap?, title: String, author: String
    ) {
        sec = section; allParas = paras; chapterStarts = chapters.map { it.para }.toSet(); pictures = pics
        marks = highlights; cover = coverBmp; bookTitle = title; bookAuthor = author
        toc = chapters.ifEmpty { listOf(Chapter(title, 0)) }
        readPara = null; readSent = null
        page = 0
        rebuild()
    }

    /** Re-lays out the current section (after a size, font or highlight change), keeping the reader's place. */
    fun relayout(newMarks: List<Mark>? = null) {
        if (newMarks != null) marks = newMarks
        val anchor = topOffset()
        rebuild()
        if (sec?.front != true && anchor >= 0) page = pageOfOffset(anchor)
        invalidate()
    }

    private fun rebuild() {
        val s = sec ?: return
        if (width == 0 || height == 0) { invalidate(); return }
        small.color = muted
        paint.color = fg
        if (s.front) {
            val rowH = paint.textSize * 2.3f
            tocPerPage = max(1, ((contentH - paint.textSize * 4) / rowH).toInt())
            layout = null; pageLines.clear()
            invalidate(); return
        }
        val sb = SpannableStringBuilder()
        val starts = IntArray(s.end - s.start)
        val indent = (paint.textSize * 1.5f).toInt()
        for (i in s.start until s.end) {
            for (bmp in pictures(i)) {
                val st = sb.length
                sb.append("￼\n")
                val maxH = contentH * 0.6f
                var w = min(contentW.toFloat(), bmp.width * dp)
                var h = w * bmp.height / max(1, bmp.width)
                if (h > maxH) { w *= maxH / h; h = maxH }
                val d = BitmapDrawable(resources, bmp).apply { setBounds(0, 0, w.toInt(), h.toInt()) }
                sb.setSpan(ImageSpan(d, ImageSpan.ALIGN_BOTTOM), st, st + 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                sb.setSpan(AlignmentSpan.Standard(Layout.Alignment.ALIGN_CENTER), st, st + 2, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
            val st = sb.length
            starts[i - s.start] = st
            val p = allParas[i]
            sb.append(p)
            val en = sb.length
            if (i in chapterStarts) {
                sb.setSpan(StyleSpan(Typeface.BOLD), st, en, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                sb.setSpan(RelativeSizeSpan(1.35f), st, en, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                sb.setSpan(AlignmentSpan.Standard(Layout.Alignment.ALIGN_CENTER), st, en, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            } else if (i != s.start && (i - 1) !in chapterStarts && !continues(i)) {
                sb.setSpan(LeadingMarginSpan.Standard(indent, 0), st, en, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
            for (m in marks) if (m.para == i) {
                val a = (st + m.start).coerceIn(st, en); val b = (st + m.end).coerceIn(st, en)
                if (b > a) sb.setSpan(BackgroundColorSpan(m.color), a, b, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
            for (f in fnRegex.findAll(p)) {
                sb.setSpan(ForegroundColorSpan(accent), st + f.range.first, st + f.range.last + 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                sb.setSpan(RelativeSizeSpan(0.8f), st + f.range.first, st + f.range.last + 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
            // a line that carries on in the next paragraph flows on the same line
            if (i + 1 < s.end && i !in chapterStarts && continues(i + 1)) sb.append(" ") else sb.append("\n")
            if (i in chapterStarts) sb.append("\n")
        }
        text = sb; paraStart = starts
        val b = StaticLayout.Builder.obtain(sb, 0, sb.length, paint, contentW)
            .setAlignment(Layout.Alignment.ALIGN_NORMAL)
            .setLineSpacing(0f, 1.45f)
            .setIncludePad(false)
            .setHyphenationFrequency(Layout.HYPHENATION_FREQUENCY_NORMAL)
            .setJustificationMode(Layout.JUSTIFICATION_MODE_INTER_WORD)
        val l = b.build()
        layout = l
        // split into pages; every chapter heading starts a new page
        val headingLines = HashSet<Int>()
        for (i in s.start until s.end) if (i in chapterStarts && i != s.start) headingLines += l.getLineForOffset(paraStart[i - s.start])
        pageLines.clear()
        var line = 0
        val n = l.lineCount
        while (line < n) {
            pageLines += line
            val top = l.getLineTop(line)
            var e = line
            while (e + 1 < n && l.getLineBottom(e + 1) - top <= contentH && (e + 1) !in headingLines) e++
            line = e + 1
        }
        if (pageLines.isEmpty()) pageLines += 0
        if (page >= pageLines.size) page = pageLines.size - 1
        invalidate()
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        if (sec != null) {
            val anchor = if (pendingAnchor >= 0) pendingAnchor else topOffset()
            rebuild()
            if (sec?.front != true && anchor >= 0) page = pageOfOffset(anchor)
            pendingAnchor = -1
            host?.pageChanged(false)
        }
    }

    // ---------- positions ----------
    private fun topOffset(): Int {
        val l = layout ?: return -1
        if (pageLines.isEmpty()) return -1
        return l.getLineStart(pageLines[page.coerceIn(0, pageLines.size - 1)])
    }
    private fun pageOfOffset(off: Int): Int {
        val l = layout ?: return 0
        val line = l.getLineForOffset(off.coerceIn(0, max(0, text.length - 1)))
        var p = 0
        for (k in pageLines.indices) { if (pageLines[k] <= line) p = k else break }
        return p
    }
    fun pageOfPara(para: Int, local: Int = 0): Int {
        val s = sec ?: return 0
        if (s.front || para < s.start || para >= s.end) return 0
        if (layout == null) { pendingAnchor = paraStart.getOrElse(para - s.start) { 0 } + local; return 0 }
        return pageOfOffset(paraStart[para - s.start] + local)
    }
    /** Paragraph at the top of the current page. */
    fun topPara(): Int {
        val s = sec ?: return 0
        if (s.front) return 0
        val off = topOffset(); if (off < 0) return s.start
        return paraAt(off).first
    }
    private fun paraAt(off: Int): Pair<Int, Int> {
        val s = sec ?: return 0 to 0
        var lo = 0; var hi = paraStart.size - 1
        while (lo < hi) { val mid = (lo + hi + 1) / 2; if (paraStart[mid] <= off) lo = mid else hi = mid - 1 }
        return (s.start + lo) to (off - paraStart.getOrElse(lo) { 0 })
    }
    private fun offsetAt(x: Float, y: Float): Int {
        val l = layout ?: return -1
        if (pageLines.isEmpty()) return -1
        val l0 = pageLines[page]
        val last = if (page + 1 < pageLines.size) pageLines[page + 1] - 1 else l.lineCount - 1
        val yy = (y - headerH + l.getLineTop(l0)).toInt()
        val line = l.getLineForVertical(yy)
        if (line < l0 || line > last) return -1
        return l.getOffsetForHorizontal(line, x - padX)
    }

    // ---------- reading highlight ----------
    fun setReading(para: Int, start: Int, end: Int) {
        clearReading()
        val s = sec ?: return
        if (s.front || para < s.start || para >= s.end || layout == null) return
        val st = paraStart[para - s.start]
        val len = allParas[para].length
        val a = BackgroundColorSpan(paraColor); val b = BackgroundColorSpan(sentColor)
        text.setSpan(a, st, st + len, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        if (end > start) text.setSpan(b, st + start.coerceIn(0, len), st + end.coerceIn(0, len), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        readPara = a; readSent = b
        invalidate()
    }
    fun clearReading() {
        readPara?.let { text.removeSpan(it) }; readSent?.let { text.removeSpan(it) }
        readPara = null; readSent = null
        invalidate()
    }

    // ---------- turning ----------
    fun next() {
        if (anim != null) return
        if (page < pageCount - 1) turnTo(page + 1, 1) else host?.needSection(1)
    }
    fun prev() {
        if (anim != null) return
        if (page > 0) turnTo(page - 1, -1) else host?.needSection(-1)
    }
    fun goToPage(p: Int, userTurn: Boolean = false) {
        page = p.coerceIn(0, max(0, pageCount - 1))
        invalidate()
        host?.pageChanged(userTurn)
    }
    fun lastPage() = goToPage(pageCount - 1)

    private fun turnTo(p: Int, dir: Int) {
        if (turnStyle == "flip") {
            animate().rotationY(-dir * 90f).setDuration(150).withEndAction {
                page = p; host?.pageChanged(true)
                rotationY = dir * 90f
                invalidate()
                animate().rotationY(0f).setDuration(180).start()
            }.start()
            return
        }
        animFrom = page; animTo = p; animDir = dir
        anim = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 260
            addUpdateListener { animT = it.animatedValue as Float; invalidate() }
            addListener(object : android.animation.AnimatorListenerAdapter() {
                override fun onAnimationEnd(animation: android.animation.Animator) {
                    anim = null; page = animTo; animT = 0f; invalidate(); host?.pageChanged(true)
                }
            })
            start()
        }
    }

    // ---------- drawing ----------
    override fun onDraw(canvas: Canvas) {
        canvas.drawColor(bg)
        if (sec == null) return
        if (anim != null) {
            val shift = -animDir * animT * width
            drawPage(canvas, animFrom, shift)
            drawPage(canvas, animTo, shift + animDir * width)
        } else {
            drawPage(canvas, page, 0f)
        }
    }

    private fun drawPage(c: Canvas, p: Int, dx: Float) {
        c.save()
        c.translate(dx, 0f)
        c.clipRect(0f, 0f, width.toFloat(), height.toFloat())
        c.drawColor(bg)
        val s = sec ?: return
        val head = TextUtils.ellipsize(host?.header() ?: "", small, contentW.toFloat(), TextUtils.TruncateAt.END).toString().uppercase()
        c.drawText(head, padX.toFloat(), headerH * 0.62f, small)
        if (s.front) drawFront(c, p) else {
            val l = layout
            if (l != null && pageLines.isNotEmpty()) {
                val pp = p.coerceIn(0, pageLines.size - 1)
                val l0 = pageLines[pp]
                val l1 = if (pp + 1 < pageLines.size) pageLines[pp + 1] - 1 else l.lineCount - 1
                val top = l.getLineTop(l0); val bottom = l.getLineBottom(l1)
                c.save()
                c.translate(padX.toFloat(), (headerH - top).toFloat())
                c.clipRect(0, top, contentW, bottom)
                l.draw(c)
                c.restore()
            }
        }
        val (fl, fr) = host?.footer(p) ?: ("" to "")
        val y = height - footerH * 0.38f
        c.drawText(fl, padX.toFloat(), y, small)
        c.drawText(fr, (width - padX - small.measureText(fr)), y, small)
        c.restore()
    }

    private fun drawFront(c: Canvas, p: Int) {
        val cx = width / 2f
        if (p == 0) {
            var y = headerH + contentH * 0.06f
            cover?.let { bmp ->
                val w = contentW * 0.55f
                var h = w * bmp.height / max(1, bmp.width)
                val maxH = contentH * 0.55f
                val ww = if (h > maxH) w * maxH / h else w
                if (h > maxH) h = maxH
                c.drawBitmap(bmp, null, RectF(cx - ww / 2, y, cx + ww / 2, y + h), null)
                y += h + 28 * dp
            }
            val tp = TextPaint(paint).apply { textSize = paint.textSize * 1.45f; typeface = Typeface.create(paint.typeface, Typeface.BOLD) }
            val tl = StaticLayout.Builder.obtain(bookTitle, 0, bookTitle.length, tp, contentW).setAlignment(Layout.Alignment.ALIGN_CENTER).build()
            c.save(); c.translate(padX.toFloat(), y); tl.draw(c); c.restore()
            y += tl.height + 12 * dp
            val ap = TextPaint(paint).apply { color = muted; typeface = Typeface.create(paint.typeface, Typeface.ITALIC) }
            val al = StaticLayout.Builder.obtain(bookAuthor, 0, bookAuthor.length, ap, contentW).setAlignment(Layout.Alignment.ALIGN_CENTER).build()
            c.save(); c.translate(padX.toFloat(), y); al.draw(c); c.restore()
            return
        }
        tocRows.clear()
        val hp = TextPaint(paint).apply { textSize = paint.textSize * 1.3f; typeface = Typeface.create(paint.typeface, Typeface.BOLD) }
        var y = headerH + hp.textSize * 1.6f
        if (p == 1) c.drawText("Contents", cx - hp.measureText("Contents") / 2, y, hp)
        y += hp.textSize
        val rowH = paint.textSize * 2.3f
        val from = (p - 1) * tocPerPage
        val linePaint = Paint().apply { color = muted; alpha = 60 }
        for (k in from until min(toc.size, from + tocPerPage)) {
            val title = TextUtils.ellipsize(toc[k].title, paint, contentW.toFloat(), TextUtils.TruncateAt.END).toString()
            c.drawText(title, padX.toFloat(), y + rowH * 0.62f, paint)
            c.drawLine(padX.toFloat(), y + rowH - 2, (width - padX).toFloat(), y + rowH - 2, linePaint)
            tocRows += RectF(0f, y, width.toFloat(), y + rowH) to toc[k].para
            y += rowH
        }
    }

    // ---------- touch ----------
    private val gestures = GestureDetector(ctx, object : GestureDetector.SimpleOnGestureListener() {
        override fun onDown(e: MotionEvent) = true
        override fun onSingleTapUp(e: MotionEvent): Boolean {
            if (anim != null) return true
            val s = sec ?: return true
            if (s.front && page >= 1) {
                for ((r, para) in tocRows) if (r.contains(e.x, e.y)) { host?.tocTap(para); return true }
            }
            if (!s.front) {
                val off = offsetAt(e.x, e.y)
                if (off >= 0) {
                    val (para, local) = paraAt(off)
                    val m = fnRegex.findAll(allParas[para]).firstOrNull { local >= it.range.first - 1 && local <= it.range.last + 1 }
                    if (m != null) { host?.footnoteTap(m.groupValues[1], para); return true }
                }
            }
            when {
                e.x > width * 0.66f -> next()
                e.x < width * 0.34f -> prev()
                else -> host?.centerTap()
            }
            return true
        }
        override fun onFling(e1: MotionEvent?, e2: MotionEvent, velocityX: Float, velocityY: Float): Boolean {
            val a = e1 ?: return false
            val dx = e2.x - a.x
            if (abs(dx) > 60 * dp && abs(dx) > abs(e2.y - a.y) * 1.5f) { if (dx < 0) next() else prev(); return true }
            return false
        }
        override fun onLongPress(e: MotionEvent) {
            val s = sec ?: return
            if (s.front) return
            val off = offsetAt(e.x, e.y)
            if (off >= 0) host?.paragraphLongPress(paraAt(off).first)
        }
    })

    override fun onTouchEvent(event: MotionEvent): Boolean = gestures.onTouchEvent(event) || super.onTouchEvent(event)
}
