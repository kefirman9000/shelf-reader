package com.shelfreader

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.Voice
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.view.ViewGroup
import android.widget.AbsListView
import android.widget.BaseAdapter
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView
import java.util.Locale

class ReaderActivity : Activity() {

    private lateinit var book: Book
    private var paras: List<String> = emptyList()
    private lateinit var list: ListView
    private lateinit var playBtn: Button
    private lateinit var speedBtn: Button
    private lateinit var status: TextView
    private var current = 0
    private var lastTouch = 0L
    private var textSize = 18f
    private var probe: TextToSpeech? = null
    private var loaded = false

    private val adapter = object : BaseAdapter() {
        override fun getCount() = paras.size
        override fun getItem(position: Int): Any = paras[position]
        override fun getItemId(position: Int) = position.toLong()
        override fun getView(position: Int, convertView: View?, parent: ViewGroup?): View {
            val tv = (convertView as? TextView) ?: TextView(this@ReaderActivity).apply {
                setPadding(dp(18), dp(8), dp(18), dp(8))
                setLineSpacing(0f, 1.3f)
            }
            tv.text = paras[position]
            tv.textSize = textSize
            tv.setBackgroundColor(if (position == current) 0x3366AAFF else 0)
            return tv
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val id = intent.getStringExtra("book")
        val b = id?.let { Library.get(this, it) }
        if (b == null) { finish(); return }
        book = b
        title = b.title
        textSize = Settings.textSize(this)

        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        status = TextView(this).apply {
            setPadding(dp(18), dp(4), dp(18), dp(4))
            textSize = 13f
            alpha = 0.7f
            text = "Preparing book…"
        }
        list = ListView(this).apply {
            divider = null
            isFastScrollEnabled = true
            adapter = this@ReaderActivity.adapter
        }
        list.setOnItemClickListener { _, _, pos, _ -> playFrom(pos) }
        list.setOnScrollListener(object : AbsListView.OnScrollListener {
            override fun onScrollStateChanged(view: AbsListView?, scrollState: Int) {
                if (scrollState != AbsListView.OnScrollListener.SCROLL_STATE_IDLE) lastTouch = System.currentTimeMillis()
            }
            override fun onScroll(view: AbsListView?, first: Int, visible: Int, total: Int) {}
        })

        val controls = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        val prev = Button(this).apply { text = "⏮"; setOnClickListener { step(-1) } }
        playBtn = Button(this).apply { text = "▶ Play"; setOnClickListener { togglePlay() } }
        val next = Button(this).apply { text = "⏭"; setOnClickListener { step(1) } }
        speedBtn = Button(this).apply { setOnClickListener { pickSpeed() } }
        val voiceBtn = Button(this).apply { text = "Voice"; setOnClickListener { pickVoice() } }
        controls.addView(prev, LinearLayout.LayoutParams(0, WRAP, 0.8f))
        controls.addView(playBtn, LinearLayout.LayoutParams(0, WRAP, 1.6f))
        controls.addView(next, LinearLayout.LayoutParams(0, WRAP, 0.8f))
        controls.addView(speedBtn, LinearLayout.LayoutParams(0, WRAP, 1f))
        controls.addView(voiceBtn, LinearLayout.LayoutParams(0, WRAP, 1.1f))

        root.addView(status)
        root.addView(list, LinearLayout.LayoutParams(MATCH, 0, 1f))
        root.addView(controls)
        setContentView(root)
        refreshButtons()

        Thread {
            try {
                val p = Library.paragraphs(this, book)
                runOnUiThread {
                    paras = p
                    loaded = true
                    current = currentIndex()
                    adapter.notifyDataSetChanged()
                    list.setSelectionFromTop(current, dp(60))
                    refresh()
                }
            } catch (t: Throwable) {
                runOnUiThread { status.text = "Couldn't read this book: ${t.message}" }
            }
        }.start()
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        val id = intent?.getStringExtra("book")
        if (id != null && id != book.id) {
            finish()
            startActivity(Intent(this, ReaderActivity::class.java).putExtra("book", id))
        }
    }

    override fun onResume() {
        super.onResume()
        TtsService.listener = { runOnUiThread { refresh() } }
        refresh()
    }

    override fun onPause() {
        TtsService.listener = null
        super.onPause()
    }

    override fun onDestroy() {
        probe?.shutdown()
        super.onDestroy()
    }

    // ---------- state ----------

    private fun service(): TtsService? = TtsService.instance?.takeIf { it.bookId == book.id }

    private fun currentIndex(): Int = service()?.index ?: Library.position(this, book.id)

    private fun isPlaying() = service()?.playing == true

    private fun refresh() {
        if (!loaded) return
        val idx = currentIndex().coerceIn(0, maxOf(0, paras.size - 1))
        if (idx != current) {
            current = idx
            adapter.notifyDataSetChanged()
            val offscreen = current < list.firstVisiblePosition || current >= list.lastVisiblePosition
            if (offscreen && System.currentTimeMillis() - lastTouch > 6000) list.setSelectionFromTop(current, dp(60))
        }
        val pct = if (paras.isNotEmpty()) (current + 1) * 100 / paras.size else 0
        status.text = "${book.author.ifBlank { "Unknown author" }} · $pct% · tap any paragraph to read from there"
        refreshButtons()
    }

    private fun refreshButtons() {
        playBtn.text = if (isPlaying()) "❚❚ Pause" else "▶ Play"
        speedBtn.text = fmtRate(Settings.rate(this))
    }

    private fun fmtRate(r: Float) = (if (r % 1f == 0f) r.toInt().toString() else r.toString()) + "×"

    // ---------- controls ----------

    private fun playFrom(i: Int) {
        if (!loaded) return
        current = i
        lastTouch = 0
        adapter.notifyDataSetChanged()
        startForegroundService(
            Intent(this, TtsService::class.java)
                .setAction(TtsService.ACTION_PLAY)
                .putExtra(TtsService.EXTRA_BOOK, book.id)
                .putExtra(TtsService.EXTRA_INDEX, i)
        )
    }

    private fun togglePlay() {
        if (!loaded) return
        if (service() != null) {
            startService(Intent(this, TtsService::class.java).setAction(TtsService.ACTION_TOGGLE))
        } else {
            playFrom(current)
        }
    }

    private fun step(d: Int) {
        if (!loaded || paras.isEmpty()) return
        lastTouch = 0
        if (service() != null) {
            startService(Intent(this, TtsService::class.java).setAction(if (d > 0) TtsService.ACTION_NEXT else TtsService.ACTION_PREV))
        } else {
            Library.setPosition(this, book.id, (current + d).coerceIn(0, paras.size - 1))
            refresh()
        }
    }

    private fun pickSpeed() {
        val rates = floatArrayOf(0.75f, 1f, 1.25f, 1.5f, 1.75f, 2f, 2.5f, 3f)
        AlertDialog.Builder(this)
            .setTitle("Reading speed")
            .setItems(rates.map { fmtRate(it) }.toTypedArray()) { _, w ->
                Settings.setRate(this, rates[w])
                TtsService.instance?.applySettings(true)
                refreshButtons()
            }
            .show()
    }

    private fun pickVoice() {
        val engine = TtsService.instance?.engine() ?: probe
        if (engine != null && (engine !== probe || probeReady)) { showVoices(engine); return }
        status.text = "Loading voices…"
        if (probe == null) {
            probe = TextToSpeech(this) { st ->
                runOnUiThread {
                    if (st == TextToSpeech.SUCCESS) {
                        probeReady = true
                        probe?.let { showVoices(it) }
                    } else {
                        toast("No text-to-speech engine found. Install “Speech Services by Google”.")
                    }
                    refresh()
                }
            }
        }
    }

    private var probeReady = false

    private fun showVoices(engine: TextToSpeech) {
        val all: List<Voice> = try { engine.voices?.toList() ?: emptyList() } catch (e: Throwable) { emptyList() }
        val lang = Locale.getDefault().language
        val voices = all.filter {
            it.locale.language == lang &&
                !(it.features?.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) ?: false)
        }.sortedWith(compareBy<Voice>({ it.isNetworkConnectionRequired }, { it.locale.toString() }, { it.name }))
        val chosen = Settings.voice(this)
        val labels = ArrayList<String>()
        labels += (if (chosen == null) "✓ " else "") + "System default voice"
        for (v in voices) labels += (if (v.name == chosen) "✓ " else "") + voiceLabel(v)
        labels += "Get more voices…"
        AlertDialog.Builder(this)
            .setTitle("Voice")
            .setItems(labels.toTypedArray()) { _, w ->
                when (w) {
                    0 -> Settings.setVoice(this, null)
                    labels.size - 1 -> { openTtsSettings(); return@setItems }
                    else -> Settings.setVoice(this, voices[w - 1].name)
                }
                TtsService.instance?.applySettings(true)
                if (service() == null && loaded) {
                    toast("Voice saved — press Play to hear it.")
                }
            }
            .show()
    }

    private fun voiceLabel(v: Voice): String {
        val region = v.locale.displayCountry.ifBlank { v.locale.displayLanguage }
        val code = v.name.substringAfter("-x-", v.name).substringBefore("-")
        val where = if (v.isNetworkConnectionRequired) "online" else "offline"
        val hq = if (v.quality >= Voice.QUALITY_VERY_HIGH) " ★" else ""
        return "$region · $code · $where$hq"
    }

    private fun openTtsSettings() {
        try {
            startActivity(Intent("com.android.settings.TTS_SETTINGS"))
        } catch (e: Throwable) {
            toast("Open Settings → Accessibility → Text-to-speech to install voices.")
        }
    }

    // ---------- menu ----------

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menu.add(0, 1, 0, "Larger text")
        menu.add(0, 2, 0, "Smaller text")
        menu.add(0, 3, 0, "Back to start")
        menu.add(0, 4, 0, "Text-to-speech settings")
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        when (item.itemId) {
            1, 2 -> {
                textSize = (textSize + if (item.itemId == 1) 2f else -2f).coerceIn(12f, 34f)
                Settings.setTextSize(this, textSize)
                adapter.notifyDataSetChanged()
            }
            3 -> if (isPlaying()) playFrom(0) else {
                Library.setPosition(this, book.id, 0)
                lastTouch = 0
                refresh()
                list.setSelection(0)
            }
            4 -> openTtsSettings()
            else -> return super.onOptionsItemSelected(item)
        }
        return true
    }
}
