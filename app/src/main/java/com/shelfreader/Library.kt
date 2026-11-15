package com.shelfreader

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

data class Book(
    val id: String,
    val title: String,
    val author: String,
    val file: String,
    val format: String,
    val added: Long
)

data class Chapter(val title: String, val para: Int)
data class Picture(val para: Int, val src: String)
data class Doc(val paras: List<String>, val chapters: List<Chapter>, val pictures: List<Picture> = emptyList())
data class Note(val para: Int, val text: String, val time: Long)

object Library {
    private fun indexFile(ctx: Context) = File(ctx.filesDir, "library.json")
    fun dir(ctx: Context) = File(ctx.filesDir, "books").apply { mkdirs() }
    private fun prefs(ctx: Context) = ctx.getSharedPreferences("positions", Context.MODE_PRIVATE)

    fun fromJson(text: String): MutableList<Book> = try {
        val arr = JSONArray(text)
        (0 until arr.length()).map {
            val o = arr.getJSONObject(it)
            Book(o.getString("id"), o.optString("title"), o.optString("author"),
                o.getString("file"), o.getString("format"), o.optLong("added"))
        }.toMutableList()
    } catch (t: Throwable) {
        mutableListOf()
    }

    @Synchronized
    fun load(ctx: Context): MutableList<Book> {
        val f = indexFile(ctx)
        if (!f.exists()) return mutableListOf()
        return fromJson(f.readText())
    }

    /** Adds books that aren't already in the library (used by restore). Returns how many were added. */
    @Synchronized
    fun merge(ctx: Context, incoming: List<Book>): Int {
        val list = load(ctx)
        val have = list.map { it.id }.toHashSet()
        var n = 0
        for (b in incoming) if (b.id !in have && File(dir(ctx), b.file).exists()) { list.add(b); n++ }
        save(ctx, list)
        return n
    }

    @Synchronized
    private fun save(ctx: Context, list: List<Book>) {
        val arr = JSONArray()
        for (b in list) arr.put(JSONObject().apply {
            put("id", b.id); put("title", b.title); put("author", b.author)
            put("file", b.file); put("format", b.format); put("added", b.added)
        })
        val tmp = File(indexFile(ctx).path + ".tmp")
        tmp.writeText(arr.toString())
        tmp.renameTo(indexFile(ctx))
    }

    @Synchronized
    fun add(ctx: Context, b: Book) {
        val list = load(ctx)
        list.add(b)
        save(ctx, list)
    }

    @Synchronized
    fun remove(ctx: Context, b: Book) {
        save(ctx, load(ctx).filter { it.id != b.id })
        val d = dir(ctx)
        for (name in listOf(b.file, "${b.id}.paras", "${b.id}.v2.paras", "${b.id}.v2.chap", "${b.id}.v2.imgs", "${b.id}.notes.json", "${b.id}.cover.jpg")) {
            File(d, name).delete()
        }
        Collections.forget(ctx, b.id)
        Settings.forgetBook(ctx, b.id)
        prefs(ctx).edit().remove("pos_${b.id}").remove("off_${b.id}").remove("len_${b.id}").remove("opened_${b.id}").apply()
    }

    fun get(ctx: Context, id: String): Book? = load(ctx).firstOrNull { it.id == id }

    @Synchronized
    fun update(ctx: Context, b: Book) {
        save(ctx, load(ctx).map { if (it.id == b.id) b else it })
    }

    fun markOpened(ctx: Context, id: String) = prefs(ctx).edit().putLong("opened_$id", System.currentTimeMillis()).apply()
    fun opened(ctx: Context, id: String) = prefs(ctx).getLong("opened_$id", 0L)

    /** Paragraphs + chapters, extracted once and cached. Slow the first time — call off the main thread. */
    fun doc(ctx: Context, b: Book): Doc {
        val pf = File(dir(ctx), "${b.id}.v2.paras")
        val cf = File(dir(ctx), "${b.id}.v2.chap")
        if (pf.exists() && cf.exists()) {
            val paras = pf.readLines().filter { it.isNotEmpty() }
            if (paras.isNotEmpty()) {
                val chaps = cf.readLines().mapNotNull { l ->
                    val t = l.indexOf('\t')
                    if (t <= 0) null else l.substring(0, t).toIntOrNull()?.let { Chapter(l.substring(t + 1), it) }
                }
                return Doc(paras, chaps, pictures(ctx, b, paras.size))
            }
        }
        val d = Extract.document(File(dir(ctx), b.file), b.format)
        pf.writeText(d.paras.joinToString("\n") { it.replace('\n', ' ') })
        cf.writeText(d.chapters.joinToString("\n") { "${it.para}\t${it.title.replace('\n', ' ').replace('\t', ' ')}" })
        File(dir(ctx), "${b.id}.v2.imgs").writeText(d.pictures.joinToString("\n") { "${it.para}\t${it.src}" })
        prefs(ctx).edit().putInt("len_${b.id}", d.paras.size).apply()
        return d
    }

    /** Pictures for a cached book; books added before pictures were supported get them found once. */
    private fun pictures(ctx: Context, b: Book, count: Int): List<Picture> {
        val f = File(dir(ctx), "${b.id}.v2.imgs")
        if (f.exists()) {
            return f.readLines().filter { it.isNotEmpty() }.mapNotNull { l ->
                val t = l.indexOf('\t'); if (t <= 0) null else l.substring(0, t).toIntOrNull()?.let { Picture(it, l.substring(t + 1)) }
            }
        }
        var found: List<Picture> = emptyList()
        if (b.format == "epub") {
            try {
                val fresh = Extract.document(File(dir(ctx), b.file), b.format)
                if (fresh.paras.size == count) found = fresh.pictures
            } catch (t: Throwable) {}
        }
        f.writeText(found.joinToString("\n") { "${it.para}\t${it.src}" })
        return found
    }

    /** Decodes a picture from inside a book, scaled to about [maxW] pixels wide. */
    fun picture(ctx: Context, b: Book, src: String, maxW: Int): android.graphics.Bitmap? {
        val bytes = Extract.epubEntry(File(dir(ctx), b.file), src) ?: return null
        val o = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
        android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, o)
        if (o.outWidth <= 0) return null
        var sample = 1
        while (o.outWidth / (sample * 2) >= maxW) sample *= 2
        return android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, android.graphics.BitmapFactory.Options().apply { inSampleSize = sample })
    }

    fun paragraphs(ctx: Context, b: Book): List<String> = doc(ctx, b).paras

    fun position(ctx: Context, id: String) = prefs(ctx).getInt("pos_$id", 0)
    fun offset(ctx: Context, id: String) = prefs(ctx).getInt("off_$id", 0)

    fun setPosition(ctx: Context, id: String, para: Int, offset: Int = 0) {
        prefs(ctx).edit().putInt("pos_$id", para).putInt("off_$id", offset).apply()
    }

    fun percent(ctx: Context, b: Book): Int {
        val len = prefs(ctx).getInt("len_${b.id}", 0)
        if (len <= 0) return 0
        return ((position(ctx, b.id) + 1) * 100 / len).coerceIn(0, 100)
    }

    // ---------- bookmarks & notes ----------

    private fun notesFile(ctx: Context, id: String) = File(dir(ctx), "$id.notes.json")

    @Synchronized
    fun notes(ctx: Context, id: String): MutableList<Note> {
        val f = notesFile(ctx, id)
        if (!f.exists()) return mutableListOf()
        return try {
            val arr = JSONArray(f.readText())
            (0 until arr.length()).map {
                val o = arr.getJSONObject(it)
                Note(o.getInt("p"), o.optString("t"), o.optLong("time"))
            }.sortedBy { it.para }.toMutableList()
        } catch (t: Throwable) {
            mutableListOf()
        }
    }

    @Synchronized
    fun saveNotes(ctx: Context, id: String, list: List<Note>) {
        val arr = JSONArray()
        for (n in list) arr.put(JSONObject().apply { put("p", n.para); put("t", n.text); put("time", n.time) })
        notesFile(ctx, id).writeText(arr.toString())
    }
}

object Settings {
    private fun p(ctx: Context) = ctx.getSharedPreferences("settings", Context.MODE_PRIVATE)

    fun rate(ctx: Context) = p(ctx).getFloat("rate", 1f)
    /** Speed for a book: its own if you've set one, otherwise your default. */
    fun rateFor(ctx: Context, id: String?): Float = if (id == null) rate(ctx) else p(ctx).getFloat("rate_$id", rate(ctx))
    fun setBookRate(ctx: Context, id: String, r: Float) = p(ctx).edit().putFloat("rate_$id", r).putFloat("rate", r).apply()
    fun voiceFor(ctx: Context, id: String?): String? =
        if (id != null && p(ctx).contains("voice_$id")) p(ctx).getString("voice_$id", null)?.ifEmpty { null } else voice(ctx)
    fun setBookVoice(ctx: Context, id: String, v: String?) =
        p(ctx).edit().putString("voice_$id", v ?: "").putString("voice", v).apply()
    fun forgetBook(ctx: Context, id: String) = p(ctx).edit().remove("rate_$id").remove("voice_$id").apply()

    fun seenVoiceGuide(ctx: Context) = p(ctx).getBoolean("seenVoiceGuide", false)
    fun setSeenVoiceGuide(ctx: Context) = p(ctx).edit().putBoolean("seenVoiceGuide", true).apply()
    fun resumeOnHeadphones(ctx: Context) = p(ctx).getBoolean("resumeOnHeadphones", true)
    fun setResumeOnHeadphones(ctx: Context, v: Boolean) = p(ctx).edit().putBoolean("resumeOnHeadphones", v).apply()
    fun libraryFilter(ctx: Context): String = p(ctx).getString("libraryFilter", "") ?: ""
    fun setLibraryFilter(ctx: Context, v: String) = p(ctx).edit().putString("libraryFilter", v).apply()
    fun setRate(ctx: Context, r: Float) = p(ctx).edit().putFloat("rate", r).apply()
    fun voice(ctx: Context): String? = p(ctx).getString("voice", null)
    fun setVoice(ctx: Context, v: String?) = p(ctx).edit().putString("voice", v).apply()

    fun textSize(ctx: Context) = p(ctx).getFloat("textSize", 18f)
    fun setTextSize(ctx: Context, s: Float) = p(ctx).edit().putFloat("textSize", s).apply()
    fun theme(ctx: Context) = p(ctx).getInt("theme", 0)
    fun setTheme(ctx: Context, v: Int) = p(ctx).edit().putInt("theme", v).apply()
    fun font(ctx: Context) = p(ctx).getInt("font", 0)
    fun setFont(ctx: Context, v: Int) = p(ctx).edit().putInt("font", v).apply()
    fun margin(ctx: Context) = p(ctx).getInt("margin", 1)
    fun setMargin(ctx: Context, v: Int) = p(ctx).edit().putInt("margin", v).apply()

    fun skipClutter(ctx: Context) = p(ctx).getBoolean("skipClutter", true)
    fun setSkipClutter(ctx: Context, v: Boolean) = p(ctx).edit().putBoolean("skipClutter", v).apply()

    fun libraryView(ctx: Context) = p(ctx).getInt("libraryView", 0)
    fun setLibraryView(ctx: Context, v: Int) = p(ctx).edit().putInt("libraryView", v).apply()
    fun librarySort(ctx: Context) = p(ctx).getInt("librarySort", 0)
    fun setLibrarySort(ctx: Context, v: Int) = p(ctx).edit().putInt("librarySort", v).apply()

    fun lastBook(ctx: Context): String? = p(ctx).getString("lastBook", null)
    fun setLastBook(ctx: Context, id: String) = p(ctx).edit().putString("lastBook", id).apply()

    fun lastUpdateCheck(ctx: Context) = p(ctx).getLong("lastUpdateCheck", 0L)
    fun setLastUpdateCheck(ctx: Context, t: Long) = p(ctx).edit().putLong("lastUpdateCheck", t).apply()

    fun fixes(ctx: Context): List<Fix> = try {
        val arr = JSONArray(p(ctx).getString("fixes", "[]"))
        (0 until arr.length()).map { arr.getJSONObject(it).let { o -> Fix(o.optString("f"), o.optString("t")) } }
    } catch (t: Throwable) {
        emptyList()
    }

    fun setFixes(ctx: Context, list: List<Fix>) {
        val arr = JSONArray()
        for (f in list) arr.put(JSONObject().apply { put("f", f.from); put("t", f.to) })
        p(ctx).edit().putString("fixes", arr.toString()).apply()
    }
}

/** Collections ("Want to read", "Finished", and your own). A book can be in several. */
object Collections {
    const val WANT = "Want to read"
    const val FINISHED = "Finished"
    private fun p(ctx: Context) = ctx.getSharedPreferences("collections", Context.MODE_PRIVATE)

    fun names(ctx: Context): List<String> {
        val custom = try {
            val arr = JSONArray(p(ctx).getString("_names", "[]"))
            (0 until arr.length()).map { arr.getString(it) }
        } catch (t: Throwable) { emptyList() }
        return listOf(WANT, FINISHED) + custom.filter { it != WANT && it != FINISHED }
    }

    fun create(ctx: Context, name: String) {
        val n = name.trim()
        if (n.isEmpty() || n in names(ctx)) return
        val custom = names(ctx).drop(2) + n
        p(ctx).edit().putString("_names", JSONArray(custom).toString()).apply()
    }

    fun delete(ctx: Context, name: String) {
        val custom = names(ctx).drop(2).filter { it != name }
        val e = p(ctx).edit().putString("_names", JSONArray(custom).toString())
        for ((k, _) in p(ctx).all) if (!k.startsWith("_")) {
            val s = of(ctx, k)
            if (name in s) e.putString(k, JSONArray(s - name).toString())
        }
        e.apply()
    }

    fun of(ctx: Context, bookId: String): Set<String> = try {
        val arr = JSONArray(p(ctx).getString(bookId, "[]"))
        (0 until arr.length()).map { arr.getString(it) }.toSet()
    } catch (t: Throwable) { emptySet() }

    fun set(ctx: Context, bookId: String, names: Set<String>) {
        p(ctx).edit().putString(bookId, JSONArray(names.toList()).toString()).apply()
    }

    fun add(ctx: Context, bookId: String, name: String) = set(ctx, bookId, of(ctx, bookId) + name)

    fun forget(ctx: Context, bookId: String) = p(ctx).edit().remove(bookId).apply()
}
