package com.shelfreader

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream

/** Saves the whole library (books, places, notes, collections, settings) to one .zip, and restores it. */
object Backup {
    private val PREFS = listOf("positions", "settings", "collections")

    fun write(ctx: Context, out: OutputStream) {
        ZipOutputStream(out).use { z ->
            fun addFile(name: String, f: File) {
                z.putNextEntry(ZipEntry(name))
                f.inputStream().use { it.copyTo(z) }
                z.closeEntry()
            }
            val lib = File(ctx.filesDir, "library.json")
            if (lib.exists()) addFile("library.json", lib)
            Library.dir(ctx).listFiles()?.forEach { f ->
                if (f.isFile && !f.name.endsWith(".part") && !f.name.endsWith(".tmp")) addFile("books/" + f.name, f)
            }
            for (name in PREFS) {
                z.putNextEntry(ZipEntry("prefs/$name.json"))
                z.write(prefsToJson(ctx.getSharedPreferences(name, Context.MODE_PRIVATE)).toByteArray())
                z.closeEntry()
            }
        }
    }

    /** Returns the number of books added. Existing books are kept. */
    fun restore(ctx: Context, input: InputStream): Int {
        var libJson: String? = null
        val prefs = HashMap<String, String>()
        var sawAnything = false
        ZipInputStream(input).use { z ->
            var e = z.nextEntry
            while (e != null) {
                val n = e.name
                when {
                    n == "library.json" -> { libJson = z.readBytes().toString(Charsets.UTF_8); sawAnything = true }
                    n.startsWith("books/") -> {
                        val name = n.removePrefix("books/")
                        if (name.isNotEmpty() && !name.contains('/') && !name.contains("..")) {
                            File(Library.dir(ctx), name).outputStream().use { z.copyTo(it) }
                        }
                    }
                    n.startsWith("prefs/") && n.endsWith(".json") -> {
                        prefs[n.removePrefix("prefs/").removeSuffix(".json")] = z.readBytes().toString(Charsets.UTF_8)
                    }
                }
                z.closeEntry()
                e = z.nextEntry
            }
        }
        if (!sawAnything) throw Exception("that file isn't a Shelf Reader backup")
        for ((name, json) in prefs) if (name in PREFS) jsonToPrefs(json, ctx.getSharedPreferences(name, Context.MODE_PRIVATE))
        return Library.merge(ctx, Library.fromJson(libJson ?: "[]"))
    }

    private fun prefsToJson(p: SharedPreferences): String {
        val o = JSONObject()
        for ((k, v) in p.all) {
            val entry = JSONObject()
            when (v) {
                is Int -> { entry.put("t", "i"); entry.put("v", v) }
                is Long -> { entry.put("t", "l"); entry.put("v", v) }
                is Float -> { entry.put("t", "f"); entry.put("v", v.toDouble()) }
                is Boolean -> { entry.put("t", "b"); entry.put("v", v) }
                is String -> { entry.put("t", "s"); entry.put("v", v) }
                is Set<*> -> { entry.put("t", "S"); entry.put("v", JSONArray(v.map { it.toString() })) }
                else -> continue
            }
            o.put(k, entry)
        }
        return o.toString()
    }

    private fun jsonToPrefs(json: String, p: SharedPreferences) {
        val o = JSONObject(json)
        val e = p.edit()
        for (k in o.keys()) {
            val entry = o.optJSONObject(k) ?: continue
            when (entry.optString("t")) {
                "i" -> e.putInt(k, entry.optInt("v"))
                "l" -> e.putLong(k, entry.optLong("v"))
                "f" -> e.putFloat(k, entry.optDouble("v").toFloat())
                "b" -> e.putBoolean(k, entry.optBoolean("v"))
                "s" -> e.putString(k, entry.optString("v"))
                "S" -> {
                    val a = entry.optJSONArray("v") ?: JSONArray()
                    e.putStringSet(k, (0 until a.length()).map { a.optString(it) }.toSet())
                }
            }
        }
        e.apply()
    }
}

/** Free dictionary lookups (dictionaryapi.dev). */
object Dictionary {
    fun define(word: String): String {
        val w = word.trim().lowercase().replace(Regex("[^\\p{L}'-]"), "")
        if (w.isEmpty()) throw Exception("select a single word")
        val text = try {
            Net.get("https://api.dictionaryapi.dev/api/v2/entries/en/" + Net.encPath(w))
        } catch (t: Throwable) {
            if (t.message?.contains("404") == true) return "No definition found for “$w”."
            throw t
        }
        val arr = JSONArray(text)
        val sb = StringBuilder()
        var count = 0
        for (i in 0 until arr.length()) {
            val entry = arr.getJSONObject(i)
            if (i == 0) entry.optString("phonetic").takeIf { it.isNotBlank() }?.let { sb.append(it).append("\n\n") }
            val meanings = entry.optJSONArray("meanings") ?: continue
            for (m in 0 until meanings.length()) {
                val mo = meanings.getJSONObject(m)
                val pos = mo.optString("partOfSpeech")
                val defs = mo.optJSONArray("definitions") ?: continue
                for (d in 0 until minOf(2, defs.length())) {
                    if (count >= 6) break
                    val def = defs.getJSONObject(d)
                    sb.append("• ")
                    if (pos.isNotBlank()) sb.append("($pos) ")
                    sb.append(def.optString("definition"))
                    def.optString("example").takeIf { it.isNotBlank() }?.let { sb.append("\n   e.g. “").append(it).append("”") }
                    sb.append("\n\n")
                    count++
                }
            }
        }
        return sb.toString().trim().ifEmpty { "No definition found for “$w”." }
    }
}
