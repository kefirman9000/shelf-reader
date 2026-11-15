package com.shelfreader

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.Gravity
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/** A simple, glanceable player with huge buttons. The screen stays on. */
class CarModeActivity : Activity() {

    private lateinit var bookId: String
    private lateinit var titleView: TextView
    private lateinit var chapterView: TextView
    private lateinit var statusView: TextView
    private lateinit var playBtn: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        bookId = intent.getStringExtra("book") ?: Settings.lastBook(this) ?: run { finish(); return }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        actionBar?.hide()

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.BLACK)
            setPadding(dp(20), dp(28), dp(20), dp(20))
        }
        titleView = TextView(this).apply {
            textSize = 26f
            setTextColor(Color.WHITE)
            setTypeface(typeface, Typeface.BOLD)
            maxLines = 2
        }
        chapterView = TextView(this).apply {
            textSize = 19f
            setTextColor(0xFFBBBBBB.toInt())
            maxLines = 2
            setPadding(0, dp(6), 0, 0)
        }
        statusView = TextView(this).apply {
            textSize = 16f
            setTextColor(0xFF8FB8A8.toInt())
            setPadding(0, dp(6), 0, 0)
        }
        root.addView(titleView)
        root.addView(chapterView)
        root.addView(statusView)

        fun big(label: String, size: Float, onClick: () -> Unit) = Button(this).apply {
            text = label
            textSize = size
            setTextColor(Color.WHITE)
            isAllCaps = false
            background = GradientDrawable().apply {
                setColor(0xFF1F2B27.toInt())
                cornerRadius = dp(18).toFloat()
            }
            setOnClickListener { onClick() }
        }

        playBtn = big("▶", 54f) { toggle() }
        val rowSeek = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        rowSeek.addView(big("⟲ 30s", 24f) { svc()?.seekSeconds(-30) ?: start() }, weighted())
        rowSeek.addView(big("30s ⟳", 24f) { svc()?.seekSeconds(30) ?: start() }, weighted())
        val rowChap = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        rowChap.addView(big("⏮ Chapter", 20f) { svc()?.skipChapter(-1) ?: start() }, weighted())
        rowChap.addView(big("Chapter ⏭", 20f) { svc()?.skipChapter(1) ?: start() }, weighted())
        val exit = big("Exit car mode", 16f) { finish() }

        root.addView(android.view.View(this), LinearLayout.LayoutParams(MATCH, 0, 1f))
        root.addView(playBtn, LinearLayout.LayoutParams(MATCH, dp(170)).apply { bottomMargin = dp(14) })
        root.addView(rowSeek, LinearLayout.LayoutParams(MATCH, dp(110)).apply { bottomMargin = dp(14) })
        root.addView(rowChap, LinearLayout.LayoutParams(MATCH, dp(90)).apply { bottomMargin = dp(14) })
        root.addView(exit, LinearLayout.LayoutParams(MATCH, dp(56)))
        setContentView(root)
    }

    private fun weighted() = LinearLayout.LayoutParams(0, MATCH, 1f).apply { setMargins(dp(6), 0, dp(6), 0) }

    private fun svc(): TtsService? = TtsService.instance?.takeIf { it.bookId == bookId }

    private fun start() {
        startForegroundService(
            Intent(this, TtsService::class.java).setAction(TtsService.ACTION_PLAY).putExtra(TtsService.EXTRA_BOOK, bookId)
        )
    }

    private fun toggle() {
        if (svc() != null) startService(Intent(this, TtsService::class.java).setAction(TtsService.ACTION_TOGGLE))
        else start()
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

    private fun refresh() {
        val s = svc()
        val b = Library.get(this, bookId)
        titleView.text = b?.title ?: "Shelf Reader"
        chapterView.text = s?.chapterTitle() ?: b?.author ?: ""
        val pct = b?.let { Library.percent(this, it) } ?: 0
        statusView.text = (if (s?.playing == true) "Reading" else "Paused") + " · $pct%" +
            (s?.sleepText()?.let { " · $it" } ?: "")
        playBtn.text = if (s?.playing == true) "❚❚" else "▶"
        playBtn.gravity = Gravity.CENTER
    }
}
