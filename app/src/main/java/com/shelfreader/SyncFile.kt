package com.shelfreader

import android.content.Context
import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject

/**
 * Phone ↔ PC sync through one JSON file kept in Google Drive / OneDrive
 * (same format as the desktop app's lib/sync.js). Newer reading state wins, per book.
 */
object SyncFile {
    const val NAME = "ShelfReader-sync.json"

    private fun norm(s: String) = s.lowercase().replace(Regex("[^a-z0-9]+"), " ").trim()
    private fun key(title: String, author: String) = norm(title) + "|" + norm(author)

    private fun noteToJson(n: Note) = JSONObject().apply {
        put("type", if (n.type == "hl") "hl" else "note"); put("para", n.para); put("text", n.text); put("time", n.time)
        if (n.type == "hl") { put("start", n.start); put("end", n.end); put("color", n.color); put("quote", n.quote) }
    }
    private fun noteFromJson(o: JSONObject) = Note(
        o.optInt("para"), o.optString("text"), o.optLong("time"), o.optString("type", "note"),
        o.optInt("start"), o.optInt("end"), o.optString("color", "yellow"), o.optString("quote")
    )

    @Synchronized
    fun sync(ctx: Context): Pair<Int, Int> {
        val uri = Uri.parse(Settings.syncUri(ctx) ?: throw Exception("sync isn't set up"))
        val cr = ctx.contentResolver
        val remote = try {
            cr.openInputStream(uri)?.use { it.readBytes().toString(Charsets.UTF_8) }?.takeIf { it.isNotBlank() }?.let { JSONObject(it) }
        } catch (t: Throwable) { null } ?: JSONObject()
        val rBooks = remote.optJSONArray("books") ?: JSONArray()
        val byId = HashMap<String, JSONObject>(); val byKey = HashMap<String, JSONObject>()
        for (i in 0 until rBooks.length()) {
            val r = rBooks.getJSONObject(i)
            byId[r.optString("id")] = r
            byKey[key(r.optString("title"), r.optString("author"))] = r
        }

        var pulled = 0
        val used = HashSet<JSONObject>()
        val out = JSONArray()
        for (b in Library.load(ctx)) {
            val r = byId[b.id] ?: byKey[key(b.title, b.author)]
            if (r != null) used += r
            if (r != null && r.optLong("updated") > Library.updated(ctx, b.id)) {
                Library.applySynced(ctx, b.id, r.optInt("pos"), r.optInt("off"), r.optLong("updated"))
                val notes = r.optJSONArray("notes") ?: JSONArray()
                // audio clips stay on the device that made them
                val clips = Library.notes(ctx, b.id).filter { it.type == "clip" }
                Library.saveNotes(ctx, b.id, (0 until notes.length()).map { noteFromJson(notes.getJSONObject(it)) }.filter { it.type != "clip" } + clips, touch = false)
                val cols = r.optJSONArray("collections") ?: JSONArray()
                Collections.set(ctx, b.id, (0 until cols.length()).map { cols.getString(it) }.toSet(), touch = false)
                Library.applySynced(ctx, b.id, r.optInt("pos"), r.optInt("off"), r.optLong("updated"))
                pulled++
            }
            out.put(JSONObject().apply {
                put("id", b.id); put("title", b.title); put("author", b.author)
                put("pos", Library.position(ctx, b.id)); put("off", Library.offset(ctx, b.id))
                put("len", Library.length(ctx, b.id)); put("updated", Library.updated(ctx, b.id))
                put("notes", JSONArray().apply { Library.notes(ctx, b.id).filter { it.type != "clip" }.forEach { put(noteToJson(it)) } })
                put("collections", JSONArray(Collections.of(ctx, b.id).toList()))
            })
        }
        // keep books only the other device has
        for (i in 0 until rBooks.length()) { val r = rBooks.getJSONObject(i); if (r !in used) out.put(r) }

        // collection names
        val rNames = remote.optJSONArray("collectionNames") ?: JSONArray()
        for (i in 0 until rNames.length()) Collections.create(ctx, rNames.getString(i))
        val names = Collections.names(ctx).drop(2)

        // pronunciation fixes (union)
        val fixes = Settings.fixes(ctx).toMutableList()
        val rFixes = remote.optJSONArray("fixes") ?: JSONArray()
        for (i in 0 until rFixes.length()) {
            val o = rFixes.getJSONObject(i)
            val from = o.optString("from")
            if (from.isNotBlank() && fixes.none { it.from.equals(from, true) }) fixes += Fix(from, o.optString("to"))
        }
        Settings.setFixes(ctx, fixes)

        // stats: per-day maximums, finished books union, newest goal
        val local = Stats.load(ctx)
        val rStats = remote.optJSONObject("stats") ?: JSONObject()
        val days = local.optJSONObject("days") ?: JSONObject()
        val rDays = rStats.optJSONObject("days") ?: JSONObject()
        for (k in rDays.keys()) {
            val rv = rDays.getJSONObject(k); val lv = days.optJSONObject(k) ?: JSONObject()
            days.put(k, JSONObject().apply {
                put("read", maxOf(lv.optInt("read"), rv.optInt("read")))
                put("listen", maxOf(lv.optInt("listen"), rv.optInt("listen")))
            })
        }
        local.put("days", days)
        val fin = local.optJSONArray("finished") ?: JSONArray()
        val seen = HashSet<String>()
        for (i in 0 until fin.length()) fin.getJSONObject(i).let { seen += norm(it.optString("title")) + "|" + it.optString("date").take(10) }
        val rFin = rStats.optJSONArray("finished") ?: JSONArray()
        for (i in 0 until rFin.length()) {
            val f = rFin.getJSONObject(i)
            if (seen.add(norm(f.optString("title")) + "|" + f.optString("date").take(10))) fin.put(f)
        }
        local.put("finished", fin)
        if (rStats.optLong("goalUpdated") > local.optLong("goalUpdated")) { local.put("goal", rStats.optInt("goal", 30)); local.put("goalUpdated", rStats.optLong("goalUpdated")) }
        Stats.save(ctx, local)

        val doc = JSONObject().apply {
            put("app", "ShelfReader"); put("version", 1); put("updated", System.currentTimeMillis())
            put("books", out); put("collectionNames", JSONArray(names))
            put("fixes", JSONArray().apply { fixes.forEach { f -> put(JSONObject().apply { put("from", f.from); put("to", f.to) }) } })
            put("stats", local)
        }
        cr.openOutputStream(uri, "wt")?.use { it.write(doc.toString().toByteArray()) } ?: throw Exception("couldn't write the sync file")
        Settings.setLastSync(ctx, System.currentTimeMillis())
        return pulled to out.length()
    }
}
