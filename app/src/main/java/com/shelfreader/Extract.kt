package com.shelfreader

import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.text.PDFTextStripper
import java.io.File
import java.net.URLDecoder
import java.util.zip.ZipFile

/** Turns EPUB / TXT / PDF files into a list of readable paragraphs. */
object Extract {

    fun paragraphs(file: File, format: String): List<String> {
        val raw = when (format) {
            "epub" -> epub(file)
            "pdf" -> pdf(file)
            else -> txt(file.readText())
        }
        return normalize(raw)
    }

    // ---------- TXT ----------

    fun txt(text0: String): List<String> {
        var text = text0.replace("\r\n", "\n").replace('\r', '\n')
        val start = Regex("\\*\\*\\* ?START OF (THE|THIS) PROJECT GUTENBERG[^\n]*\n", RegexOption.IGNORE_CASE).find(text)
        if (start != null) text = text.substring(start.range.last + 1)
        val end = Regex("\\*\\*\\* ?END OF (THE|THIS) PROJECT GUTENBERG", RegexOption.IGNORE_CASE).find(text)
        if (end != null) text = text.substring(0, end.range.first)
        return text.split(Regex("\n\\s*\n"))
            .map { it.replace(Regex("\\s+"), " ").trim() }
            .filter { it.isNotEmpty() }
    }

    // ---------- EPUB ----------

    private class Epub(val zip: ZipFile) {
        fun read(name: String): String? {
            val e = zip.getEntry(name) ?: return null
            return zip.getInputStream(e).use { it.readBytes().toString(Charsets.UTF_8) }
        }
        val opfPath: String
        val opf: String
        init {
            val container = read("META-INF/container.xml") ?: throw Exception("not a valid EPUB")
            opfPath = Regex("full-path\\s*=\\s*\"([^\"]+)\"").find(container)?.groupValues?.get(1)
                ?: throw Exception("EPUB has no package file")
            opf = read(opfPath) ?: throw Exception("EPUB package file is missing")
        }
    }

    fun epubInfo(file: File): Pair<String?, String?> = try {
        ZipFile(file).use { z ->
            val e = Epub(z)
            val title = Regex("<dc:title[^>]*>(.*?)</dc:title>", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))
                .find(e.opf)?.groupValues?.get(1)?.let { clean(it) }
            val author = Regex("<dc:creator[^>]*>(.*?)</dc:creator>", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))
                .find(e.opf)?.groupValues?.get(1)?.let { clean(it) }
            title to author
        }
    } catch (t: Throwable) {
        null to null
    }

    private fun clean(s: String) = decodeEntities(s.replace(Regex("<[^>]*>"), "")).replace(Regex("\\s+"), " ").trim()

    fun epub(file: File): List<String> {
        ZipFile(file).use { z ->
            val e = Epub(z)
            val base = e.opfPath.substringBeforeLast('/', "").let { if (it.isEmpty()) "" else "$it/" }
            val manifest = HashMap<String, String>()
            Regex("<(?:\\w+:)?item\\b[^>]*>", RegexOption.IGNORE_CASE).findAll(e.opf).forEach { m ->
                val id = attr(m.value, "id")
                val href = attr(m.value, "href")
                if (id != null && href != null) manifest[id] = href
            }
            val spine = Regex("<(?:\\w+:)?itemref\\b[^>]*>", RegexOption.IGNORE_CASE).findAll(e.opf)
                .mapNotNull { attr(it.value, "idref") }.toList()
            val out = ArrayList<String>()
            for (idref in spine) {
                val href = manifest[idref] ?: continue
                val decoded = try { URLDecoder.decode(href.substringBefore('#'), "UTF-8") } catch (t: Throwable) { href }
                val html = e.read(resolvePath(base, decoded)) ?: continue
                out += htmlToParagraphs(html)
            }
            if (out.isEmpty()) throw Exception("couldn't find any text in this EPUB")
            return out
        }
    }

    private fun attr(tag: String, name: String): String? =
        Regex("(?:^|\\s)$name\\s*=\\s*[\"']([^\"']*)[\"']", RegexOption.IGNORE_CASE).find(tag)?.groupValues?.get(1)

    private fun resolvePath(base: String, href: String): String {
        val parts = ArrayList<String>()
        for (p in (base + href).split("/")) {
            when (p) {
                "", "." -> {}
                ".." -> if (parts.isNotEmpty()) parts.removeAt(parts.size - 1)
                else -> parts += p
            }
        }
        return parts.joinToString("/")
    }

    fun htmlToParagraphs(html0: String): List<String> {
        var h = html0
        val body = Regex("<body[^>]*>", RegexOption.IGNORE_CASE).find(h)
        if (body != null) h = h.substring(body.range.last + 1)
        h = h.replace(Regex("(?is)<(script|style|head)\\b.*?</\\1>"), " ")
        h = h.replace(Regex("(?i)</?(p|div|h[1-6]|li|blockquote|tr|section|article|br|hr|dt|dd|pre)\\b[^>]*>"), "\n\n")
        h = h.replace(Regex("<[^>]*>"), "")
        h = decodeEntities(h)
        return h.split(Regex("\n\\s*\n"))
            .map { it.replace(Regex("\\s+"), " ").trim() }
            .filter { it.isNotEmpty() }
    }

    private val named = mapOf(
        "amp" to "&", "lt" to "<", "gt" to ">", "quot" to "\"", "apos" to "'", "nbsp" to " ",
        "mdash" to "—", "ndash" to "–", "rsquo" to "’", "lsquo" to "‘", "ldquo" to "“", "rdquo" to "”",
        "hellip" to "…", "shy" to "", "copy" to "©", "eacute" to "é", "egrave" to "è", "aacute" to "á",
        "agrave" to "à", "ouml" to "ö", "uuml" to "ü", "auml" to "ä", "ccedil" to "ç", "szlig" to "ß"
    )

    fun decodeEntities(s: String): String =
        Regex("&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);").replace(s) { m ->
            val e = m.groupValues[1]
            try {
                when {
                    e.startsWith("#x") || e.startsWith("#X") -> String(Character.toChars(e.substring(2).toInt(16)))
                    e.startsWith("#") -> String(Character.toChars(e.substring(1).toInt()))
                    else -> named[e] ?: m.value
                }
            } catch (t: Throwable) {
                m.value
            }
        }

    // ---------- PDF ----------

    fun pdf(file: File): List<String> {
        PDDocument.load(file).use { doc ->
            val text = PDFTextStripper().getText(doc).replace("\r\n", "\n")
                .replace(Regex("-\\n(?=[a-z])"), "")
            val blocks = text.split(Regex("\n\\s*\n"))
            val chosen = if (blocks.size > 5) blocks else listOf(text)
            val out = chosen.map { it.replace(Regex("\\s+"), " ").trim() }.filter { it.isNotEmpty() }
            if (out.isEmpty()) throw Exception("this PDF has no text layer (it may be a scan)")
            return out
        }
    }

    // ---------- shared ----------

    fun normalize(ps: List<String>): List<String> {
        var list = ps
        val s = list.indexOfFirst { it.contains("START OF THE PROJECT GUTENBERG", true) || it.contains("START OF THIS PROJECT GUTENBERG", true) }
        val e = list.indexOfLast { it.contains("END OF THE PROJECT GUTENBERG", true) || it.contains("END OF THIS PROJECT GUTENBERG", true) }
        if (s >= 0 && e > s) list = list.subList(s + 1, e)
        else if (s >= 0) list = list.subList(s + 1, list.size)
        val out = ArrayList<String>()
        for (p in list) {
            if (p.length <= 1200) out += p else out += splitLong(p)
        }
        if (out.isEmpty()) throw Exception("no readable text found")
        return out
    }

    private fun splitLong(p: String): List<String> {
        val sentences = Regex("(?<=[.!?…][\"”’)]?)\\s+").split(p)
        val out = ArrayList<String>()
        val sb = StringBuilder()
        for (s in sentences) {
            if (s.length > 2500) {
                if (sb.isNotEmpty()) { out += sb.toString(); sb.setLength(0) }
                s.chunked(2000).forEach { out += it }
                continue
            }
            if (sb.isNotEmpty() && sb.length + s.length > 800) { out += sb.toString(); sb.setLength(0) }
            if (sb.isNotEmpty()) sb.append(' ')
            sb.append(s)
        }
        if (sb.isNotEmpty()) out += sb.toString()
        return out
    }
}
