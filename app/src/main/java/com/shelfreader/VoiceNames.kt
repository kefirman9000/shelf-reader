package com.shelfreader

import android.speech.tts.Voice
import java.util.Locale

/**
 * Turns voice IDs like "en-us-x-iob-network" into names like "English (US) · Female 2".
 * Android doesn't report a voice's gender, so known Google voice codes are listed here;
 * anything not in the list is simply numbered.
 */
object VoiceNames {
    private const val F = "Female"
    private const val M = "Male"

    // Google "Speech Services" voice codes (best known mapping)
    private val GOOGLE = mapOf(
        // US
        "sfg" to F, "iob" to F, "iog" to F, "iol" to M, "iom" to M, "tpc" to F, "tpd" to M, "tpf" to F,
        // UK
        "gba" to F, "gbb" to M, "gbc" to F, "gbd" to M, "gbg" to F, "rjs" to M,
        // Australia
        "afh" to F, "aua" to F, "aub" to M, "auc" to F, "aud" to M,
        // India
        "ahp" to F, "cxx" to F, "ene" to F, "end" to M
    )

    private val COUNTRY = mapOf(
        "US" to "US", "GB" to "UK", "AU" to "Australia", "IN" to "India", "CA" to "Canada", "IE" to "Ireland",
        "NZ" to "New Zealand", "ZA" to "South Africa", "NG" to "Nigeria", "SG" to "Singapore"
    )

    fun region(l: Locale): String {
        val lang = l.getDisplayLanguage(Locale.ENGLISH).ifBlank { l.language }
        val c = l.country
        return if (c.isNullOrBlank()) lang else "$lang (${COUNTRY[c] ?: l.getDisplayCountry(Locale.ENGLISH).ifBlank { c }})"
    }

    /** The short code inside a Google voice name, e.g. "iob" in "en-us-x-iob-network". */
    private fun code(v: Voice): String = v.name.substringAfter("-x-", "").substringBefore("-")

    /**
     * Returns voices with friendly names. When a voice exists both offline and online,
     * only one entry is kept (the offline one, which works without internet).
     */
    fun friendly(voices: List<Voice>): List<Pair<Voice, String>> {
        val byKey = LinkedHashMap<String, Voice>()
        for (v in voices.sortedWith(compareBy({ region(it.locale) }, { it.isNetworkConnectionRequired }, { it.name }))) {
            val c = code(v)
            val key = region(v.locale) + "|" + c.ifEmpty { v.name }
            if (!byKey.containsKey(key)) byKey[key] = v
        }
        val counters = HashMap<String, Int>()
        val out = ArrayList<Pair<Voice, String>>()
        for (v in byKey.values) {
            val reg = region(v.locale)
            val gender = GOOGLE[code(v)]
            val kind = gender ?: "Voice"
            val n = (counters["$reg|$kind"] ?: 0) + 1
            counters["$reg|$kind"] = n
            val extras = ArrayList<String>()
            if (v.isNetworkConnectionRequired) extras += "needs internet"
            if (v.quality >= Voice.QUALITY_VERY_HIGH) extras += "★"
            out += v to "$reg · $kind $n" + if (extras.isNotEmpty()) "  (" + extras.joinToString(", ") + ")" else ""
        }
        return out.sortedWith(compareBy({ it.second.substringBefore(" · ") }, { it.second }))
    }
}
