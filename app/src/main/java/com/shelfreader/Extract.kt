package com.shelfreader

import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.text.PDFTextStripper
import java.io.File
import java.net.URLDecoder
import java.util.zip.ZipFile

/** Turns EPUB / TXT / PDF files into paragraphs plus a chapter list. */
object Extract {

    private class P(val text: String, var chap: String?, var imgs: List<String> = emptyList())
    class Rich(val paras: List<Pair<String, List<String>>>, val trailing: List<String>)
    private class Item(val href: String, val type: String, val props: String)

    fun document(file: File, format: String): Doc {
        val raw: List<P> = when (format) {
            "epub" -> epub(file)
            "pdf" -> pdf(file).map { P(it, null) }
            else -> txt(file.readText()).map { P(it, null) }
        }
        val list = normalize(raw)
        if (list.count { it.chap != null } < 2) detectHeadings(list)
        val chapters = ArrayList<Chapter>()
        list.forEachIndexed { i, p -> p.chap?.let { chapters += Chapter(it, i) } }
        if (chapters.isNotEmpty() && chapters[0].para > 0) chapters.add(0, Chapter("Beginning", 0))
        val images = ArrayList<Picture>()
        list.forEachIndexed { i, p -> for (src in p.imgs) images += Picture(i, src) }
        return Doc(list.map { it.text }, chapters, images)
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

    private val dotAll = setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL)

    fun epubInfo(file: File): Pair<String?, String?> = try {
        ZipFile(file).use { z ->
            val e = Epub(z)
            val title = Regex("<dc:title[^>]*>(.*?)</dc:title>", dotAll).find(e.opf)?.groupValues?.get(1)?.let { clean(it) }
            val author = Regex("<dc:creator[^>]*>(.*?)</dc:creator>", dotAll).find(e.opf)?.groupValues?.get(1)?.let { clean(it) }
            title to author
        }
    } catch (t: Throwable) {
        null to null
    }

    /** Raw bytes of the EPUB's cover image, if it declares one. */
    fun epubCover(file: File): ByteArray? {
        try {
            ZipFile(file).use { z ->
                val e = Epub(z)
                val base = dirOf(e.opfPath)
                val items = Regex("<(?:\\w+:)?item\\b[^>]*>", RegexOption.IGNORE_CASE).findAll(e.opf).map { it.value }.toList()
                fun isImage(tag: String) = (attr(tag, "media-type") ?: "").startsWith("image")
                var tag: String? = items.firstOrNull { (attr(it, "properties") ?: "").split(' ').contains("cover-image") }
                if (tag == null) {
                    val coverId = Regex("<meta\\b[^>]*>", RegexOption.IGNORE_CASE).findAll(e.opf).map { it.value }
                        .firstOrNull { attr(it, "name") == "cover" }?.let { attr(it, "content") }
                    if (coverId != null) tag = items.firstOrNull { attr(it, "id") == coverId }
                }
                if (tag == null || !isImage(tag)) {
                    tag = items.firstOrNull {
                        isImage(it) && ((attr(it, "id") ?: "") + " " + (attr(it, "href") ?: "")).contains("cover", true)
                    } ?: tag
                }
                val href = tag?.let { attr(it, "href") } ?: return null
                val entry = z.getEntry(resolvePath(base, decode(href))) ?: return null
                return z.getInputStream(entry).use { it.readBytes() }
            }
        } catch (t: Throwable) {
            return null
        }
    }

    /** Raw bytes of a file (e.g. a picture) inside an EPUB. */
    fun epubEntry(file: File, name: String): ByteArray? = try {
        ZipFile(file).use { z -> z.getEntry(name)?.let { e -> z.getInputStream(e).use { it.readBytes() } } }
    } catch (t: Throwable) { null }

    private fun clean(s: String) = decodeEntities(s.replace(Regex("<[^>]*>"), " ")).replace(Regex("\\s+"), " ").trim()

    private fun decode(s: String): String = try { URLDecoder.decode(s.replace("+", "%2B"), "UTF-8") } catch (t: Throwable) { s }

    private fun dirOf(path: String): String = path.substringBeforeLast('/', "").let { if (it.isEmpty()) "" else "$it/" }

    private fun epub(file: File): List<P> {
        ZipFile(file).use { z ->
            val e = Epub(z)
            val base = dirOf(e.opfPath)

            val manifest = HashMap<String, Item>()
            Regex("<(?:\\w+:)?item\\b[^>]*>", RegexOption.IGNORE_CASE).findAll(e.opf).forEach { m ->
                val id = attr(m.value, "id")
                val href = attr(m.value, "href")
                if (id != null && href != null) {
                    manifest[id] = Item(href, attr(m.value, "media-type") ?: "", attr(m.value, "properties") ?: "")
                }
            }
            val spineTag = Regex("<(?:\\w+:)?spine\\b[^>]*>", RegexOption.IGNORE_CASE).find(e.opf)?.value ?: ""
            val spine = Regex("<(?:\\w+:)?itemref\\b[^>]*>", RegexOption.IGNORE_CASE).findAll(e.opf)
                .mapNotNull { attr(it.value, "idref") }.toList()

            // Table of contents: file path -> chapter title
            val toc = HashMap<String, String>()
            val navItems = manifest.values.filter { it.props.split(' ').contains("nav") }
            for (nav in navItems) {
                val navPath = resolvePath(base, decode(nav.href))
                val html = e.read(navPath) ?: continue
                val navDir = dirOf(navPath)
                Regex("<a\\b[^>]*href\\s*=\\s*[\"']([^\"']+)[\"'][^>]*>(.*?)</a>", dotAll).findAll(html).forEach { m ->
                    val p = resolvePath(navDir, decode(m.groupValues[1].substringBefore('#')))
                    val t = clean(m.groupValues[2])
                    if (t.isNotEmpty() && p.isNotEmpty()) toc.putIfAbsent(p, t)
                }
            }
            if (toc.isEmpty()) {
                val ncx = attr(spineTag, "toc")?.let { manifest[it] } ?: manifest.values.firstOrNull { it.type.contains("ncx") }
                if (ncx != null) {
                    val ncxPath = resolvePath(base, decode(ncx.href))
                    val x = e.read(ncxPath)
                    if (x != null) {
                        val d = dirOf(ncxPath)
                        Regex("<navLabel[^>]*>\\s*<text[^>]*>(.*?)</text>\\s*</navLabel>\\s*<content[^>]*src\\s*=\\s*[\"']([^\"']+)[\"']", dotAll)
                            .findAll(x).forEach { m ->
                                val p = resolvePath(d, decode(m.groupValues[2].substringBefore('#')))
                                val t = clean(m.groupValues[1])
                                if (t.isNotEmpty()) toc.putIfAbsent(p, t)
                            }
                    }
                }
            }

            val navPaths = navItems.map { resolvePath(base, decode(it.href)) }.toSet()
            val contentsRe = Regex("^(table of )?contents$", RegexOption.IGNORE_CASE)
            val out = ArrayList<P>()
            var carryImgs: List<String> = emptyList()
            for (idref in spine) {
                val item = manifest[idref] ?: continue
                val path = resolvePath(base, decode(item.href.substringBefore('#')))
                if (path in navPaths) continue
                val title = toc[path]
                if (title != null && contentsRe.matches(title)) continue
                val html = e.read(path) ?: continue
                val rich = htmlToParagraphsRich(html, dirOf(path))
                if (rich.paras.isEmpty()) { carryImgs = carryImgs + rich.trailing; continue }
                val chap = title ?: if (toc.isEmpty()) firstHeading(html) else null
                rich.paras.forEachIndexed { k, (text, imgs) ->
                    out += P(text, if (k == 0) chap else null, if (k == 0) carryImgs + imgs else imgs)
                }
                carryImgs = rich.trailing
            }
            if (out.isEmpty()) throw Exception("couldn't find any text in this EPUB")
            return out
        }
    }

    private fun firstHeading(html: String): String? =
        Regex("<h[1-3][^>]*>(.*?)</h[1-3]>", dotAll).find(html)?.let { clean(it.groupValues[1]) }
            ?.takeIf { it.isNotEmpty() && it.length < 120 }

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

    private val imgMark = Regex("\u0007([^\u0007]*)\u0007")

    /** Paragraphs plus the pictures (paths inside the EPUB) shown before each one. */
    fun htmlToParagraphsRich(html0: String, dir: String): Rich {
        var h = html0
        val body = Regex("<body[^>]*>", RegexOption.IGNORE_CASE).find(h)
        if (body != null) h = h.substring(body.range.last + 1)
        h = h.replace(Regex("(?is)<(script|style|head)\\b.*?</\\1>"), " ")
        h = Regex("<(?:img|image)\\b[^>]*>", RegexOption.IGNORE_CASE).replace(h) { m ->
            val src = attr(m.value, "src") ?: attr(m.value, "xlink:href") ?: attr(m.value, "href")
            if (src == null || src.startsWith("data:", true)) "" else "\u0007" + resolvePath(dir, decode(src.substringBefore('#'))) + "\u0007"
        }
        h = Regex("<a\\b([^>]*)>\\s*(?:<sup[^>]*>)?\\s*\\[?(\\d{1,3}|[*†‡])\\]?\\s*(?:</sup>)?\\s*</a>", RegexOption.IGNORE_CASE).replace(h) { m ->
            val attrs = m.groupValues[1]
            if (Regex("noteref|footnote|endnote|#fn|#note|#ftn|#en\\d", RegexOption.IGNORE_CASE).containsMatchIn(attrs) || m.value.contains("<sup", true))
                "[" + m.groupValues[2] + "]" else m.value
        }
        h = Regex("<sup[^>]*>\\s*(\\d{1,3}|[*†‡])\\s*</sup>", RegexOption.IGNORE_CASE).replace(h) { "[" + it.groupValues[1] + "]" }
        h = h.replace(Regex("(?i)</?(p|div|h[1-6]|li|blockquote|tr|section|article|br|hr|dt|dd|pre)\\b[^>]*>"), "\n\n")
        h = h.replace(Regex("<[^>]*>"), "")
        h = decodeEntities(h)
        val out = ArrayList<Pair<String, List<String>>>()
        var pending = ArrayList<String>()
        for (piece in h.split(Regex("\n\\s*\n"))) {
            val imgs = imgMark.findAll(piece).map { it.groupValues[1] }.filter { it.isNotEmpty() }.toList()
            val text = piece.replace(imgMark, "").replace(Regex("\\s+"), " ").trim()
            if (text.isEmpty()) { pending.addAll(imgs); continue }
            out += text to (pending + imgs)
            pending = ArrayList()
        }
        return Rich(out, pending)
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

    private val pageNum = Regex("^\\[?((page|pg\\.?|p\\.)\\s*)?\\d{1,4}\\]?$", RegexOption.IGNORE_CASE)

    private fun normalize(ps: List<P>): List<P> {
        var list = ps
        val s = list.indexOfFirst { it.text.contains("START OF THE PROJECT GUTENBERG", true) || it.text.contains("START OF THIS PROJECT GUTENBERG", true) }
        val e = list.indexOfLast { it.text.contains("END OF THE PROJECT GUTENBERG", true) || it.text.contains("END OF THIS PROJECT GUTENBERG", true) }
        if (s >= 0 && e > s) list = list.subList(s + 1, e)
        else if (s >= 0) list = list.subList(s + 1, list.size)
        val out = ArrayList<P>()
        var carry: String? = null
        var carryImgs: List<String> = emptyList()
        for (p in list) {
            val c = p.chap ?: carry
            val imgs = carryImgs + p.imgs
            carry = null
            carryImgs = emptyList()
            if (pageNum.matches(p.text)) { carry = c; carryImgs = imgs; continue }   // stray page numbers
            if (p.text.length <= 1200) out += P(p.text, c, imgs)
            else splitLong(p.text).forEachIndexed { k, piece -> out += P(piece, if (k == 0) c else null, if (k == 0) imgs else emptyList()) }
        }
        if (out.isEmpty()) throw Exception("no readable text found")
        return out
    }

    private val headingRe = Regex(
        "^(chapter|book|part|letter|canto|act|volume|stave|section)\\b[\\s.:]*" +
            "([0-9]+|[ivxlcdm]+\\b|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|" +
            "sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|the\\s+\\w+|first|second|third|fourth|fifth|" +
            "sixth|seventh|eighth|ninth|tenth|last).*",
        RegexOption.IGNORE_CASE
    )
    private val romanRe = Regex("^[IVXLC]{1,7}\\.$|^[IVXLC]{2,7}$")
    private val namedRe = Regex("^(prologue|epilogue|preface|introduction|foreword|afterword|conclusion)\\.?$", RegexOption.IGNORE_CASE)

    private fun detectHeadings(list: List<P>) {
        for (p in list) {
            if (p.chap == null && p.text.length <= 80 &&
                (headingRe.matches(p.text) || romanRe.matches(p.text) || namedRe.matches(p.text))
            ) p.chap = p.text
        }
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
