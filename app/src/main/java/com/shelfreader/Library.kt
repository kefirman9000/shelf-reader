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

object Library {
    private fun indexFile(ctx: Context) = File(ctx.filesDir, "library.json")
    fun dir(ctx: Context) = File(ctx.filesDir, "books").apply { mkdirs() }
    private fun prefs(ctx: Context) = ctx.getSharedPreferences("positions", Context.MODE_PRIVATE)

    @Synchronized
    fun load(ctx: Context): MutableList<Book> {
        val f = indexFile(ctx)
        if (!f.exists()) return mutableListOf()
        return try {
            val arr = JSONArray(f.readText())
            (0 until arr.length()).map {
                val o = arr.getJSONObject(it)
                Book(o.getString("id"), o.optString("title"), o.optString("author"),
                    o.getString("file"), o.getString("format"), o.optLong("added"))
            }.toMutableList()
        } catch (t: Throwable) {
            mutableListOf()
        }
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
        File(dir(ctx), b.file).delete()
        cacheFile(ctx, b).delete()
        prefs(ctx).edit().remove("pos_${b.id}").remove("len_${b.id}").apply()
    }

    fun get(ctx: Context, id: String): Book? = load(ctx).firstOrNull { it.id == id }

    private fun cacheFile(ctx: Context, b: Book) = File(dir(ctx), "${b.id}.paras")

    /** Extracts (or loads cached) paragraphs. Slow the first time — call off the main thread. */
    fun paragraphs(ctx: Context, b: Book): List<String> {
        val cache = cacheFile(ctx, b)
        if (cache.exists()) {
            val lines = cache.readLines().filter { it.isNotEmpty() }
            if (lines.isNotEmpty()) return lines
        }
        val paras = Extract.paragraphs(File(dir(ctx), b.file), b.format)
            .map { it.replace('\n', ' ') }
        cache.writeText(paras.joinToString("\n"))
        prefs(ctx).edit().putInt("len_${b.id}", paras.size).apply()
        return paras
    }

    fun position(ctx: Context, id: String) = prefs(ctx).getInt("pos_$id", 0)

    fun setPosition(ctx: Context, id: String, pos: Int) {
        prefs(ctx).edit().putInt("pos_$id", pos).apply()
    }

    fun percent(ctx: Context, b: Book): Int {
        val len = prefs(ctx).getInt("len_${b.id}", 0)
        if (len <= 0) return 0
        return ((position(ctx, b.id) + 1) * 100 / len).coerceIn(0, 100)
    }
}

object Settings {
    private fun p(ctx: Context) = ctx.getSharedPreferences("settings", Context.MODE_PRIVATE)
    fun rate(ctx: Context) = p(ctx).getFloat("rate", 1f)
    fun setRate(ctx: Context, r: Float) = p(ctx).edit().putFloat("rate", r).apply()
    fun voice(ctx: Context): String? = p(ctx).getString("voice", null)
    fun setVoice(ctx: Context, v: String?) = p(ctx).edit().putString("voice", v).apply()
    fun textSize(ctx: Context) = p(ctx).getFloat("textSize", 18f)
    fun setTextSize(ctx: Context, s: Float) = p(ctx).edit().putFloat("textSize", s).apply()
}
