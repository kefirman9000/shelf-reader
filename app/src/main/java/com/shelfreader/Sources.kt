package com.shelfreader

import org.json.JSONArray
import org.json.JSONObject

data class SearchResult(
    val source: String,
    val title: String,
    val author: String,
    val url: String? = null,      // direct download (Gutenberg)
    val format: String? = null,   // epub / txt / pdf when url is set
    val iaId: String? = null      // Internet Archive identifier, resolved at download time
)

/**
 * Free, legal sources only:
 *  - Project Gutenberg (public domain) via the Gutendex API
 *  - Internet Archive (public-domain / open-access texts; lend-only items are excluded)
 *  - Open Library (books with public full text, hosted on the Internet Archive)
 */
object Sources {

    fun gutenberg(q: String): List<SearchResult> {
        val j = JSONObject(Net.get("https://gutendex.com/books/?search=" + Net.enc(q)))
        val arr = j.optJSONArray("results") ?: return emptyList()
        val out = ArrayList<SearchResult>()
        for (i in 0 until arr.length()) {
            val b = arr.getJSONObject(i)
            val formats = b.optJSONObject("formats") ?: continue
            var url: String? = null
            var fmt: String? = null
            if (formats.has("application/epub+zip")) {
                url = formats.getString("application/epub+zip"); fmt = "epub"
            } else {
                val keys = formats.keys()
                while (keys.hasNext()) {
                    val k = keys.next()
                    if (k.startsWith("text/plain")) { url = formats.getString(k); fmt = "txt"; break }
                }
            }
            if (url == null || fmt == null) continue
            val authors = b.optJSONArray("authors")
            val names = ArrayList<String>()
            if (authors != null) for (a in 0 until authors.length()) {
                names += prettyName(authors.getJSONObject(a).optString("name"))
            }
            out += SearchResult("Gutenberg", b.optString("title"), names.joinToString(", "), url, fmt)
        }
        return out
    }

    fun archive(q: String): List<SearchResult> {
        val clean = q.replace(Regex("[\\\\\"():\\[\\]{}^~*?!+\\-/]"), " ").trim()
        if (clean.isEmpty()) return emptyList()
        val query = "($clean) AND mediatype:(texts) AND NOT access-restricted-item:(true)"
        val url = "https://archive.org/advancedsearch.php?q=" + Net.enc(query) +
            "&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=creator&rows=40&output=json&sort%5B%5D=downloads+desc"
        val j = JSONObject(Net.get(url))
        val docs = j.optJSONObject("response")?.optJSONArray("docs") ?: return emptyList()
        val out = ArrayList<SearchResult>()
        for (i in 0 until docs.length()) {
            val d = docs.getJSONObject(i)
            val id = d.optString("identifier")
            if (id.isEmpty()) continue
            out += SearchResult("Internet Archive", strOrArr(d, "title").ifBlank { id }, strOrArr(d, "creator"), iaId = id)
        }
        return out
    }

    fun openLibrary(q: String): List<SearchResult> {
        val url = "https://openlibrary.org/search.json?q=" + Net.enc(q) +
            "&has_fulltext=true&ebook_access=public&fields=key,title,author_name,ia,ebook_access&limit=40"
        val j = JSONObject(Net.get(url))
        val docs = j.optJSONArray("docs") ?: return emptyList()
        val out = ArrayList<SearchResult>()
        for (i in 0 until docs.length()) {
            val d = docs.getJSONObject(i)
            val access = d.optString("ebook_access")
            if (access.isNotEmpty() && access != "public") continue
            val ia = d.optJSONArray("ia") ?: continue
            if (ia.length() == 0) continue
            out += SearchResult("Open Library", d.optString("title"), strOrArr(d, "author_name"), iaId = ia.getString(0))
        }
        return out
    }

    /** Standard Ebooks: carefully proofread public-domain EPUBs. */
    fun standardEbooks(q: String): List<SearchResult> {
        val html = Net.get("https://standardebooks.org/ebooks?query=" + Net.enc(q))
        val out = ArrayList<SearchResult>()
        val seen = HashSet<String>()
        val item = Regex("about=\"(/ebooks/[^\"#?]+)\"(.*?)(?=about=\"/ebooks/|</ol>|$)", RegexOption.DOT_MATCHES_ALL)
        for (m in item.findAll(html)) {
            val path = m.groupValues[1].trimEnd('/')
            val slug = path.removePrefix("/ebooks/").split("/")
            if (slug.size < 2 || !seen.add(path)) continue
            val names = Regex("property=\"schema:name\"[^>]*>([^<]+)<").findAll(m.groupValues[2])
                .map { Extract.decodeEntities(it.groupValues[1]).trim() }.filter { it.isNotEmpty() }.toList()
            val title = names.getOrNull(0) ?: slug[1].replace('-', ' ').replaceFirstChar { it.uppercase() }
            val author = names.getOrNull(1) ?: slug[0].split('-').joinToString(" ") { w -> w.replaceFirstChar { it.uppercase() } }
            val file = slug.joinToString("_") + ".epub"
            out += SearchResult("Standard Ebooks", title, author, "https://standardebooks.org$path/downloads/$file?source=download", "epub")
        }
        return out
    }

    /** Wikisource: public-domain texts, exported as EPUB by the Wikisource export tool. */
    fun wikisource(q: String): List<SearchResult> {
        val j = JSONObject(Net.get(
            "https://en.wikisource.org/w/api.php?action=query&list=search&srnamespace=0&srlimit=30&format=json&srsearch=" + Net.enc(q)
        ))
        val arr = j.optJSONObject("query")?.optJSONArray("search") ?: return emptyList()
        val out = ArrayList<SearchResult>()
        for (i in 0 until arr.length()) {
            val title = arr.getJSONObject(i).optString("title")
            if (title.isEmpty() || title.contains('/')) continue   // skip individual chapter pages
            val url = "https://ws-export.wmcloud.org/?format=epub-3&lang=en&page=" + Net.enc(title)
            out += SearchResult("Wikisource", title, "", url, "epub")
        }
        return out
    }

    /** Feedbooks: only free / public-domain entries with an open EPUB download are kept. */
    fun feedbooks(q: String): List<SearchResult> {
        val xml = Net.get("https://catalog.feedbooks.com/search.atom?query=" + Net.enc(q))
        val out = ArrayList<SearchResult>()
        val dotAll = setOf(RegexOption.DOT_MATCHES_ALL, RegexOption.IGNORE_CASE)
        for (m in Regex("<entry\\b.*?</entry>", dotAll).findAll(xml)) {
            val e = m.value
            val title = Regex("<title[^>]*>(.*?)</title>", dotAll).find(e)?.groupValues?.get(1)?.let { Extract.decodeEntities(it).trim() } ?: continue
            val author = Regex("<author>\\s*<name>(.*?)</name>", dotAll).find(e)?.groupValues?.get(1)?.let { Extract.decodeEntities(it).trim() } ?: ""
            var url: String? = null
            for (l in Regex("<link\\b[^>]*>", RegexOption.IGNORE_CASE).findAll(e)) {
                val tag = l.value
                val rel = Regex("rel=\"([^\"]+)\"").find(tag)?.groupValues?.get(1) ?: continue
                val type = Regex("type=\"([^\"]+)\"").find(tag)?.groupValues?.get(1) ?: ""
                val href = Regex("href=\"([^\"]+)\"").find(tag)?.groupValues?.get(1) ?: continue
                val open = rel == "http://opds-spec.org/acquisition" || rel == "http://opds-spec.org/acquisition/open-access"
                if (open && type.contains("epub")) { url = Extract.decodeEntities(href); break }
            }
            if (url != null) out += SearchResult("Feedbooks", title, author, url, "epub")
        }
        return out
    }

    /** Finds the best readable file in an Internet Archive item. Returns (url, format). */
    fun resolveArchive(id: String): Pair<String, String> {
        val j = JSONObject(Net.get("https://archive.org/metadata/" + Net.encPath(id)))
        val md = j.optJSONObject("metadata")
        if (md != null && md.optString("access-restricted-item") == "true") {
            throw Exception("this one is lend-only on archive.org, so it can't be downloaded")
        }
        val files = j.optJSONArray("files") ?: throw Exception("no files in this item")
        val names = (0 until files.length()).map { files.getJSONObject(it).optString("name") }
            .filter { !it.contains("_encrypted") && !it.endsWith("_lcp.epub") }
        val pick = names.firstOrNull { it.endsWith(".epub", true) }?.let { it to "epub" }
            ?: names.firstOrNull { it.endsWith("_djvu.txt", true) }?.let { it to "txt" }
            ?: names.firstOrNull { it.endsWith(".txt", true) }?.let { it to "txt" }
            ?: names.firstOrNull { it.endsWith(".pdf", true) }?.let { it to "pdf" }
            ?: throw Exception("no EPUB, text or PDF file in this item")
        val path = pick.first.split("/").joinToString("/") { Net.encPath(it) }
        return "https://archive.org/download/${Net.encPath(id)}/$path" to pick.second
    }

    private fun strOrArr(o: JSONObject, k: String): String = when (val v = o.opt(k)) {
        is JSONArray -> (0 until v.length()).joinToString(", ") { v.optString(it) }
        null -> ""
        else -> v.toString()
    }

    /** "Austen, Jane" -> "Jane Austen" */
    private fun prettyName(n: String): String {
        val parts = n.split(", ")
        return if (parts.size == 2) "${parts[1]} ${parts[0]}" else n
    }
}
