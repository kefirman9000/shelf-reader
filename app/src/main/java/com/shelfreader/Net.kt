package com.shelfreader

import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

object Net {
    private const val UA = "ShelfReader/1.0 (Android ebook reader)"

    /** Opens a connection, following redirects across http/https, and fails on non-2xx. */
    fun open(url: String, headers: Map<String, String> = emptyMap()): HttpURLConnection {
        var current = url
        var redirects = 0
        while (true) {
            val c = URL(current).openConnection() as HttpURLConnection
            c.instanceFollowRedirects = false
            c.connectTimeout = 20000
            c.readTimeout = 60000
            c.setRequestProperty("User-Agent", UA)
            // headers (like a GitHub token) only go to the first host, never to where it redirects
            if (redirects == 0) for ((k, v) in headers) c.setRequestProperty(k, v)
            val code = c.responseCode
            if (code in 300..399) {
                val loc = c.getHeaderField("Location") ?: throw Exception("Bad redirect")
                current = URL(URL(current), loc).toString()
                c.disconnect()
                if (++redirects > 10) throw Exception("Too many redirects")
                continue
            }
            if (code !in 200..299) {
                c.disconnect()
                throw Exception("HTTP $code from ${URL(current).host}")
            }
            return c
        }
    }

    fun get(url: String, headers: Map<String, String> = emptyMap()): String {
        val c = open(url, headers)
        try {
            return c.inputStream.use { it.readBytes().toString(Charsets.UTF_8) }
        } finally {
            c.disconnect()
        }
    }

    fun download(url: String, dest: File, headers: Map<String, String> = emptyMap(), progress: (Long, Long) -> Unit) {
        val c = open(url, headers)
        val total = c.contentLengthLong
        val tmp = File(dest.path + ".part")
        try {
            c.inputStream.use { input ->
                tmp.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    var done = 0L
                    var last = 0L
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        done += n
                        val now = System.currentTimeMillis()
                        if (now - last > 250) {
                            last = now
                            progress(done, total)
                        }
                    }
                }
            }
            if (!tmp.renameTo(dest)) throw Exception("Couldn't save the file")
        } finally {
            c.disconnect()
            tmp.delete()
        }
    }

    fun enc(s: String): String = URLEncoder.encode(s, "UTF-8")

    /** Encodes a path segment (spaces as %20, not +). */
    fun encPath(s: String): String = enc(s).replace("+", "%20")
}
