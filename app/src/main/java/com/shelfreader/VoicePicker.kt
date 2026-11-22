package com.shelfreader

import android.app.Activity
import android.app.AlertDialog
import android.app.Dialog
import android.graphics.Typeface
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.Voice
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import java.util.Locale

/**
 * One screen for every voice: natural voices (Kokoro, Piper) and the phone's own (Google).
 * Each row has ▶ to hear it — natural voices you haven't downloaded play a ready-made sample, downloaded
 * ones read a line from your book — and one button to download and/or use it. Downloads show their
 * progress right in the row and keep going if you close this screen.
 */
class VoicePicker(
    private val a: Activity,
    private val bookId: String,
    private val sampleText: () -> String,
    private val phone: TextToSpeech?,
    private val previewPhone: (TextToSpeech, Voice?) -> Unit,
    private val openPhoneSettings: () -> Unit,
    private val onClose: () -> Unit
) {
    private val app = a.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val dlg = Dialog(a, R.style.AppTheme)
    private val body = LinearLayout(a).apply { orientation = LinearLayout.VERTICAL; setPadding(0, 0, 0, a.dp(32)) }
    private val progress = HashMap<String, Pair<ProgressBar, TextView>>()
    private var unlisten: (() -> Unit)? = null
    private var lastSig = ""

    // the sample that's playing or being prepared
    private var media: MediaPlayer? = null
    private var playingKey: String? = null
    private var loadingKey: String? = null
    private var token = 0

    fun show() {
        val root = LinearLayout(a).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(UiColors.BG) }
        val (bar, _) = a.topBar("Voice for this book", { dlg.dismiss() })
        root.addView(bar)
        root.addView(ScrollView(a).apply { addView(body) }, LinearLayout.LayoutParams(MATCH, 0, 1f))
        dlg.setContentView(root)
        dlg.window?.apply { statusBarColor = UiColors.SURFACE; navigationBarColor = UiColors.SURFACE }
        dlg.setOnDismissListener { stopSample(); unlisten?.invoke(); unlisten = null; onClose() }
        unlisten = VoiceDownloads.listen { if (dlg.isShowing) onDownloadsChanged() }
        render()
        dlg.show()
    }

    private fun alive() = dlg.isShowing && !a.isFinishing && !a.isDestroyed

    // ---------- building the list ----------

    private fun sig() = NeuralVoices.MODELS.joinToString { m ->
        m.id + (if (VoiceDownloads.waiting(m.id)) ":w" else "") + (if (VoiceDownloads.state(m.id) != null) ":d" + (if (VoiceDownloads.state(m.id)!!.unpacking) "u" else "") else "") + (if (NeuralVoices.installed(app, m)) ":i" else "")
    }

    private fun onDownloadsChanged() {
        if (sig() != lastSig) { render(); return }
        for ((id, v) in progress) {
            val st = VoiceDownloads.state(id) ?: continue
            v.first.isIndeterminate = st.total <= 0
            if (st.total > 0) v.first.progress = (st.done * 100 / st.total).toInt()
            v.second.text = progressText(st)
        }
    }

    private fun progressText(st: VoiceDownloads.State) =
        if (st.unpacking) "Unpacking… almost ready" else if (st.total > 0) "Downloading… ${st.done / 1_000_000} of ${st.total / 1_000_000} MB" else "Starting download…"

    private fun render() {
        lastSig = sig()
        body.removeAllViews(); progress.clear()
        val cur = Settings.voiceFor(app, bookId)
        body.addView(note("Tap ▶ to hear a voice, then Use to read this book with it. Natural voices sound the most human and work offline once downloaded."))
        storageLine()

        val kokoro = NeuralVoices.MODELS.filter { it.kind == "kokoro" }
        val piper = NeuralVoices.MODELS.filter { it.kind == "piper" }

        for (m in kokoro) {
            body.addView(a.sectionTitle("Most natural · Kokoro"))
            body.addView(modelCard(m))
            for ((sid, label) in m.voices) neuralRow(m, sid, label, cur)
        }

        body.addView(a.sectionTitle("Clear and light · Piper"))
        body.addView(note("One voice per download (about 64 MB each). Smaller and faster than Kokoro, and in more languages."))
        // grouped by language: the phone's own language first, then English, then the rest A–Z
        val mine = Locale.getDefault().language
        val langs = piper.map { it.lang }.distinct().sortedWith(compareBy({ it != mine }, { it != "en" }, { Locale(it).displayLanguage }))
        for (lang in langs) {
            body.addView(TextView(a).apply {
                text = Locale(lang).getDisplayLanguage(Locale.getDefault()).replaceFirstChar { it.uppercase() }
                textSize = 13f; setTextColor(UiColors.MUTED); setTypeface(typeface, Typeface.BOLD); setPadding(a.dp(20), a.dp(10), a.dp(20), a.dp(2))
            })
            for (m in piper.filter { it.lang == lang }) neuralRow(m, m.voices[0].first, m.voices[0].second, cur)
        }

        body.addView(a.sectionTitle("Phone voices · Google"))
        phoneRows(cur)
        body.addView(a.settingRow("⬇", "Get more Google voices", "Opens Android's speech settings") { dlg.dismiss(); openPhoneSettings() })
    }

    private fun note(t: String) = TextView(a).apply {
        text = t; textSize = 14f; setTextColor(UiColors.MUTED); setLineSpacing(0f, 1.15f); setPadding(a.dp(20), a.dp(14), a.dp(20), a.dp(2))
    }

    /** The Kokoro download: what it is, its progress, or Remove. */
    private fun modelCard(m: NeuralVoices.Model): View {
        val card = LinearLayout(a).apply {
            orientation = LinearLayout.VERTICAL
            background = a.roundBg(UiColors.SURFACE, 14, UiColors.LINE)
            setPadding(a.dp(16), a.dp(12), a.dp(16), a.dp(12))
            layoutParams = LinearLayout.LayoutParams(MATCH, WRAP).apply { setMargins(a.dp(16), a.dp(4), a.dp(16), a.dp(6)) }
        }
        val st = VoiceDownloads.state(m.id)
        val have = NeuralVoices.installed(app, m)
        val line = LinearLayout(a).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        val txt = TextView(a).apply {
            textSize = 14f; setTextColor(UiColors.FG); setLineSpacing(0f, 1.15f)
            text = when {
                st != null -> "Getting ${m.voices.size} voices…"
                VoiceDownloads.waiting(m.id) -> "Waiting for Wi-Fi · starts by itself when you're on Wi-Fi"
                have -> "✓ Downloaded · ${m.voices.size} voices, work offline"
                else -> "${m.voices.size} English voices in one download of about ${m.sizeMb} MB. Wi-Fi is a good idea."
            }
        }
        line.addView(txt, LinearLayout.LayoutParams(0, WRAP, 1f))
        when {
            st != null -> {}
            have -> line.addView(a.pill("Remove") { confirmRemove(m) })
            VoiceDownloads.waiting(m.id) -> line.addView(a.pill("Download now", true) { VoiceDownloads.cancelWaiting(m.id); VoiceDownloads.start(app, m) })
            else -> line.addView(a.pill("Download", true) { get(m) })
        }
        card.addView(line)
        if (st != null) card.addView(progressBlock(m.id, st))
        VoiceDownloads.takeError(m.id)?.let { card.addView(TextView(a).apply { text = "Last try failed: $it"; textSize = 13f; setTextColor(0xFFE57373.toInt()) }) }
        return card
    }

    private fun progressBlock(id: String, st: VoiceDownloads.State): View {
        val col = LinearLayout(a).apply { orientation = LinearLayout.VERTICAL; setPadding(0, a.dp(6), 0, 0) }
        val bar = ProgressBar(a, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100; isIndeterminate = st.total <= 0
            if (st.total > 0) progress = (st.done * 100 / st.total).toInt()
        }
        val lbl = TextView(a).apply { text = progressText(st); textSize = 13f; setTextColor(UiColors.MUTED) }
        col.addView(bar, LinearLayout.LayoutParams(MATCH, WRAP)); col.addView(lbl)
        progress[id] = bar to lbl
        return col
    }

    private fun neuralRow(m: NeuralVoices.Model, sid: Int, label: String, cur: String?) {
        val key = NeuralVoices.key(m, sid)
        val have = NeuralVoices.installed(app, m)
        val st = VoiceDownloads.state(m.id)
        val name = label.substringBefore(" · ")
        val desc = label.substringAfter(" · ", "")
        val inUse = cur == key
        val sub = when {
            m.kind == "piper" && st != null -> null
            inUse -> "In use for this book"
            VoiceDownloads.waiting(m.id) -> "Waiting for Wi-Fi"
            have -> desc
            m.kind == "kokoro" -> "$desc · sample"
            else -> "$desc · ${m.sizeMb} MB · sample"
        }
        val action: Pair<String, (() -> Unit)?> = when {
            inUse -> "In use" to null
            have -> "Use" to { use(key) }
            st != null -> "…" to null
            VoiceDownloads.waiting(m.id) -> "Now" to { VoiceDownloads.cancelWaiting(m.id); VoiceDownloads.start(app, m) { useLater(key) } }
            m.kind == "kokoro" -> "Get & use" to { get(m) { useLater(key) } }
            else -> "Download" to { get(m) { useLater(key) } }
        }
        val row = row(name, sub, inUse, key, { sample(key, m, sid, have) }, action,
            extra = if (have && m.kind == "piper") a.iconBtn("🗑", "Remove ${m.title}") { confirmRemove(m) } else null)
        body.addView(row)
        if (m.kind == "piper" && st != null) (row.getChildAt(1) as LinearLayout).addView(progressBlock(m.id, st))
    }

    private fun phoneRows(cur: String?) {
        val e = phone
        if (e == null) { body.addView(note("No speech engine found. Install “Speech Services by Google” from the Play Store.")); return }
        val all: List<Voice> = try { e.voices?.toList() ?: emptyList() } catch (_: Throwable) { emptyList() }
        val lang = Locale.getDefault().language
        val usable = all.filter { it.locale.language == lang && !(it.features?.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) ?: false) }
        val isPhone = cur == null || !NeuralVoices.isNeural(cur)
        body.addView(row("Phone's default voice", if (cur == null) "In use for this book" else "Whatever is set in Android's speech settings",
            cur == null, "phone:", { samplePhone("phone:", null) }, if (cur == null) "In use" to null else "Use" to { usePhone(null, "the phone's default voice") }))
        for ((v, label) in VoiceNames.friendly(usable)) {
            val name = label.substringBefore("  (")
            val inUse = isPhone && cur == v.name
            val where = if (v.isNetworkConnectionRequired) "needs internet" else "on this phone"
            val hq = if (v.quality >= Voice.QUALITY_VERY_HIGH) " · ★ high quality" else ""
            body.addView(row(name, if (inUse) "In use for this book" else "$where$hq", inUse, "phone:${v.name}", { samplePhone("phone:${v.name}", v) },
                if (inUse) "In use" to null else "Use" to { usePhone(v.name, name) }))
        }
    }

    /** [▶] name/sub [action] [extra]; tapping the row plays the sample too. */
    private fun row(title: String, sub: String?, inUse: Boolean, key: String, onSample: () -> Unit,
                    action: Pair<String, (() -> Unit)?>, extra: View? = null): LinearLayout {
        val row = LinearLayout(a).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            setPadding(a.dp(10), a.dp(6), a.dp(12), a.dp(6)); minimumHeight = a.dp(60)
            background = a.roundBg(if (inUse) 0xFF1F3A31.toInt() else 0x00000000, 12)
            layoutParams = LinearLayout.LayoutParams(MATCH, WRAP).apply { setMargins(a.dp(6), a.dp(1), a.dp(6), a.dp(1)) }
            isClickable = true; setOnClickListener { onSample() }
        }
        val sym = when (key) { loadingKey -> "⏳"; playingKey -> "■"; else -> "▶" }
        row.addView(a.iconBtn(sym, if (sym == "■") "Stop" else "Hear $title", 46, filled = sym != "▶") { onSample() })
        val texts = LinearLayout(a).apply { orientation = LinearLayout.VERTICAL; setPadding(a.dp(10), 0, a.dp(8), 0) }
        texts.addView(TextView(a).apply {
            text = (if (inUse) "✅ " else "") + title; textSize = 16f; setTextColor(UiColors.FG)
            if (inUse) setTypeface(typeface, Typeface.BOLD)
        })
        val s = if (key == loadingKey) "Getting the voice ready…" else sub
        if (s != null) texts.addView(TextView(a).apply { text = s; textSize = 13f; setTextColor(UiColors.MUTED) })
        row.addView(texts, LinearLayout.LayoutParams(0, WRAP, 1f))
        val (label, act) = action
        row.addView(if (act == null) TextView(a).apply { text = label; textSize = 14f; setTextColor(UiColors.MUTED); setPadding(a.dp(10), 0, a.dp(6), 0) }
            else a.pill(label, primary = label != "Download") { act() })
        if (extra != null) row.addView(extra)
        return row
    }

    // ---------- hearing a voice ----------

    private fun stopSample() {
        token++
        try { media?.release() } catch (_: Throwable) {}
        media = null
        NeuralVoices.stopPreview()
        try { phone?.stop() } catch (_: Throwable) {}
        playingKey = null; loadingKey = null
    }

    private fun sample(key: String, m: NeuralVoices.Model, sid: Int, have: Boolean) {
        if (key == playingKey || key == loadingKey) { stopSample(); render(); return }
        stopSample()
        val my = ++token
        loadingKey = key; render()
        if (have) {
            // read a line from this book with the downloaded voice
            val text = sampleText()
            val rate = Settings.rateFor(app, bookId)
            Thread {
                val r = try { NeuralVoices.generate(app, key, text, rate) } catch (t: Throwable) { null }
                main.post {
                    if (my != token || !alive()) return@post
                    loadingKey = null
                    if (r == null || r.first.isEmpty()) { app.toast("Couldn't play this voice. Close other apps and try again."); render(); return@post }
                    NeuralVoices.playOnce(r.first, r.second)
                    playingKey = key; render()
                    main.postDelayed({ if (my == token && alive()) { playingKey = null; render() } }, r.first.size * 1000L / r.second + 300)
                }
            }.start()
        } else {
            // a ready-made sample, streamed
            try {
                val mp = MediaPlayer()
                media = mp
                mp.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                mp.setDataSource(NeuralVoices.sampleUrl(m, sid))
                mp.setOnPreparedListener { if (my == token && alive()) { mp.start(); loadingKey = null; playingKey = key; render() } }
                mp.setOnCompletionListener { if (my == token && alive()) { playingKey = null; render() } }
                mp.setOnErrorListener { _, _, _ ->
                    if (my == token && alive()) {
                        loadingKey = null; playingKey = null; render()
                        app.toast("Couldn't load the sample (it needs internet). Download the voice to hear it read your book.")
                    }
                    true
                }
                mp.prepareAsync()
            } catch (t: Throwable) {
                loadingKey = null; render(); app.toast("Couldn't play the sample.")
            }
        }
    }

    private fun samplePhone(key: String, v: Voice?) {
        val e = phone ?: return
        if (key == playingKey) { stopSample(); render(); return }
        stopSample()
        previewPhone(e, v)
        playingKey = key; render()
        val my = token
        main.postDelayed({ if (my == token && alive()) { playingKey = null; render() } }, 4000)
    }

    // ---------- choosing ----------

    private fun use(key: String) {
        Settings.setBookVoice(app, bookId, key)
        TtsService.instance?.applySettings(true)
        app.toast("Using ${NeuralVoices.label(key)?.substringBefore(" · ")} for this book.")
        if (alive()) render()
    }

    /** After a download finishes, even if this screen has been closed. */
    private fun useLater(key: String) {
        Settings.setBookVoice(app, bookId, key)
        TtsService.instance?.applySettings(true)
        app.toast("Now reading with ${NeuralVoices.label(key)?.substringBefore(" · ")}.")
        if (alive()) render()
    }

    private fun usePhone(name: String?, label: String) {
        Settings.setBookVoice(app, bookId, name)
        TtsService.instance?.applySettings(true)
        app.toast("Using $label for this book.")
        render()
    }

    /** Downloads [m], first asking whether to wait for Wi-Fi when the phone is on mobile data. */
    private fun get(m: NeuralVoices.Model, then: (() -> Unit)? = null) {
        if (!VoiceDownloads.onMobileData(app)) { VoiceDownloads.start(app, m, then); return }
        AlertDialog.Builder(a).setTitle("You're on mobile data")
            .setMessage("${m.title} is about ${m.sizeMb} MB. Download it now, or wait until you're on Wi-Fi? It starts by itself then, even with this screen closed.")
            .setPositiveButton("Wait for Wi-Fi") { _, _ -> VoiceDownloads.startOnWifi(app, m, then); if (alive()) render() }
            .setNeutralButton("Download now") { _, _ -> VoiceDownloads.start(app, m, then) }
            .setNegativeButton("Cancel", null).show()
    }

    /** "Downloaded voices: 164 MB · Remove all" */
    private fun storageLine() {
        val have = NeuralVoices.MODELS.filter { NeuralVoices.installed(app, it) }
        if (have.isEmpty()) return
        val mb = have.sumOf { m -> NeuralVoices.dir(app, m).walkTopDown().filter { it.isFile }.sumOf { it.length() } } / 1_000_000
        val line = LinearLayout(a).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(a.dp(20), a.dp(8), a.dp(16), a.dp(2)) }
        line.addView(TextView(a).apply {
            text = "Downloaded: ${have.size} voice pack${if (have.size == 1) "" else "s"}, $mb MB"; textSize = 14f; setTextColor(UiColors.FG)
        }, LinearLayout.LayoutParams(0, WRAP, 1f))
        line.addView(a.pill("Remove all") {
            AlertDialog.Builder(a).setTitle("Remove all downloaded voices?")
                .setMessage("Frees $mb MB. You can download them again any time. Books using them go back to the phone's voice.")
                .setPositiveButton("Remove all") { _, _ ->
                    stopSample()
                    Thread {
                        for (m in have) try { NeuralVoices.remove(app, m) } catch (_: Throwable) {}
                        main.post { if (alive()) render() }
                    }.start()
                }
                .setNegativeButton("Keep", null).show()
        })
        body.addView(line)
    }

    private fun confirmRemove(m: NeuralVoices.Model) {
        AlertDialog.Builder(a).setTitle("Remove ${m.title}?")
            .setMessage("Frees about ${m.sizeMb} MB. You can download it again any time. Books using it go back to the phone's voice.")
            .setPositiveButton("Remove") { _, _ ->
                stopSample()
                Thread {
                    try { NeuralVoices.remove(app, m) } catch (_: Throwable) {}
                    main.post { if (alive()) render() }
                }.start()
            }
            .setNegativeButton("Keep", null).show()
    }
}
