package com.shelfreader

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.text.TextUtils
import android.util.LruCache
import java.io.File
import java.util.concurrent.Executors

/** Finds, caches and (if needed) draws book covers. */
object Covers {
    private const val W = 300
    private const val H = 450

    private val cache = object : LruCache<String, Bitmap>(32 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap) = value.byteCount
    }
    private val pool = Executors.newFixedThreadPool(2)
    private val loading = HashSet<String>()
    private val main = Handler(Looper.getMainLooper())

    private val palette = intArrayOf(
        0xFF2E5E4E.toInt(), 0xFF5B3A5E.toInt(), 0xFF7A3B2E.toInt(), 0xFF2F4B6E.toInt(),
        0xFF6B5B2E.toInt(), 0xFF3D3D3D.toInt(), 0xFF2E6B6B.toInt(), 0xFF6E2F45.toInt()
    )

    fun color(b: Book): Int = palette[Math.floorMod((b.title + b.author).hashCode(), palette.size)]

    fun file(ctx: Context, id: String) = File(Library.dir(ctx), "$id.cover.jpg")

    /** Returns the cover if it's ready; otherwise starts loading it and calls [ready] on the main thread. */
    fun get(ctx: Context, b: Book, ready: () -> Unit): Bitmap? {
        cache.get(b.id)?.let { return it }
        synchronized(loading) { if (!loading.add(b.id)) return null }
        val app = ctx.applicationContext
        pool.execute {
            val bmp = try { obtain(app, b) } catch (t: Throwable) { generated(b) }
            cache.put(b.id, bmp)
            synchronized(loading) { loading.remove(b.id) }
            main.post { ready() }
        }
        return null
    }

    fun invalidate(id: String) {
        cache.remove(id)
    }

    /** Deletes the saved cover so it's rebuilt from the book (or redrawn). */
    fun reset(ctx: Context, b: Book) {
        file(ctx, b.id).delete()
        invalidate(b.id)
    }

    private fun obtain(ctx: Context, b: Book): Bitmap {
        val f = file(ctx, b.id)
        if (f.exists()) decodeFile(f)?.let { return it }
        val src = File(Library.dir(ctx), b.file)
        val bmp = when (b.format) {
            "epub" -> Extract.epubCover(src)?.let { decodeBytes(it) }
            "pdf" -> pdfPage(src)
            else -> null
        } ?: generated(b)
        save(bmp, f)
        return bmp
    }

    /** Downloads a cover image from the web for a newly added book (best effort). */
    fun fetch(ctx: Context, id: String, url: String) {
        try {
            val tmp = File(ctx.cacheDir, "cover-$id.tmp")
            Net.download(url, tmp) { _, _ -> }
            val bmp = decodeFile(tmp)
            tmp.delete()
            if (bmp != null && bmp.width >= 60 && bmp.height >= 60) save(bmp, file(ctx, id))
        } catch (t: Throwable) { /* fall back to the book's own cover */ }
    }

    /** Uses a picture the user picked as the cover. */
    fun setFromUri(ctx: Context, b: Book, uri: Uri): Boolean {
        val bytes = ctx.contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: return false
        val bmp = decodeBytes(bytes) ?: return false
        save(bmp, file(ctx, b.id))
        invalidate(b.id)
        return true
    }

    private fun save(bmp: Bitmap, f: File) {
        try { f.outputStream().use { bmp.compress(Bitmap.CompressFormat.JPEG, 85, it) } } catch (t: Throwable) {}
    }

    private fun sample(w: Int, h: Int): Int {
        var s = 1
        while (w / (s * 2) >= W && h / (s * 2) >= H) s *= 2
        return s
    }

    private fun decodeFile(f: File): Bitmap? {
        val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(f.path, o)
        if (o.outWidth <= 0) return null
        return BitmapFactory.decodeFile(f.path, BitmapFactory.Options().apply { inSampleSize = sample(o.outWidth, o.outHeight) })
    }

    private fun decodeBytes(b: ByteArray): Bitmap? {
        val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(b, 0, b.size, o)
        if (o.outWidth <= 0) return null
        return BitmapFactory.decodeByteArray(b, 0, b.size, BitmapFactory.Options().apply { inSampleSize = sample(o.outWidth, o.outHeight) })
    }

    private fun pdfPage(f: File): Bitmap? {
        try {
            ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY).use { fd ->
                val r = PdfRenderer(fd)
                try {
                    if (r.pageCount == 0) return null
                    val page = r.openPage(0)
                    try {
                        val h = (W * page.height / maxOf(1, page.width)).coerceIn(200, 600)
                        val bmp = Bitmap.createBitmap(W, h, Bitmap.Config.ARGB_8888)
                        bmp.eraseColor(Color.WHITE)
                        page.render(bmp, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                        return bmp
                    } finally {
                        page.close()
                    }
                } finally {
                    r.close()
                }
            }
        } catch (t: Throwable) {
            return null
        }
    }

    /** Draws a simple cloth-bound style cover with the title and author. */
    fun generated(b: Book): Bitmap {
        val bmp = Bitmap.createBitmap(W, H, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        c.drawColor(color(b))
        val p = Paint(Paint.ANTI_ALIAS_FLAG)
        p.color = 0x28000000
        c.drawRect(0f, 0f, 16f, H.toFloat(), p)
        p.color = 0x66FFFFFF
        c.drawRect(32f, 56f, W - 32f, 59f, p)
        c.drawRect(32f, H - 66f, W - 32f, H - 63f, p)

        val tp = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE
            textSize = 34f
            typeface = Typeface.create(Typeface.SERIF, Typeface.BOLD)
        }
        val title = b.title.ifBlank { "Untitled" }.take(100)
        val tl = StaticLayout.Builder.obtain(title, 0, title.length, tp, W - 64)
            .setAlignment(Layout.Alignment.ALIGN_CENTER)
            .setMaxLines(6)
            .setEllipsize(TextUtils.TruncateAt.END)
            .build()
        c.save()
        c.translate(32f, 84f)
        tl.draw(c)
        c.restore()

        val author = b.author.take(60)
        if (author.isNotBlank()) {
            val ap = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
                color = 0xDDFFFFFF.toInt()
                textSize = 22f
                typeface = Typeface.SERIF
            }
            val al = StaticLayout.Builder.obtain(author, 0, author.length, ap, W - 64)
                .setAlignment(Layout.Alignment.ALIGN_CENTER)
                .setMaxLines(2)
                .setEllipsize(TextUtils.TruncateAt.END)
                .build()
            c.save()
            c.translate(32f, H - 80f - al.height)
            al.draw(c)
            c.restore()
        }
        return bmp
    }
}
