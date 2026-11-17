package com.shelfreader

import android.app.Activity
import android.app.AlertDialog
import android.app.TimePickerDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.drawable.BitmapDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.Voice
import android.text.Layout
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.AlignmentSpan
import android.text.style.BackgroundColorSpan
import android.text.style.ForegroundColorSpan
import android.text.style.ImageSpan
import android.text.style.RelativeSizeSpan
import android.util.LruCache
import android.util.TypedValue
import android.view.ActionMode
import android.view.GestureDetector
import android.view.Menu
import android.view.MotionEvent
import android.view.MenuItem
import android.view.View
import android.view.ViewGroup
import android.widget.AbsListView
import android.widget.BaseAdapter
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.ScrollView
import android.widget.TextView
import java.util.Locale

// Part of ReaderActivity (moved out of ReaderActivity.kt to keep files a readable size).

internal fun ReaderActivity.loadAppearance() {
    textSize = Settings.textSize(this)
    themeIndex = Settings.effectiveTheme(this)
    theme = READER_THEMES.getOrElse(themeIndex) { READER_THEMES[0] }
    font = FONTS.getOrElse(Settings.font(this)) { FONTS[0] }
    margin = MARGINS_DP.getOrElse(Settings.margin(this)) { 22 }
}

internal fun ReaderActivity.applyAppearance() {
    root.setBackgroundColor(theme.bg)
    list.setBackgroundColor(theme.bg)
    list.cacheColorHint = theme.bg
    recap.setTextColor(theme.fg)
    recap.setBackgroundColor(theme.para)
    if (jumpBarReady()) { jumpBar.setTextColor(theme.fg); jumpBar.setBackgroundColor(theme.para) }
    if (bookViewReady()) {
        bookView.bg = theme.bg; bookView.fg = theme.fg
        bookView.muted = (theme.fg and 0x00FFFFFF) or 0x99000000.toInt()
        bookView.accent = ACCENT; bookView.paraColor = theme.para; bookView.sentColor = theme.sent
        bookView.marginDp = margin
        bookView.turnStyle = Settings.pageTurn(this)
        bookView.justify = Settings.justify(this)
        bookView.paint.typeface = font
        bookView.paint.textSize = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, textSize, resources.displayMetrics)
        if (loaded && bookMode && curSection >= 0) {
            bookView.relayout(bookMarks())
            if (service() != null) bookView.setReading(curPara, curStart, curEnd)
        }
    }
    adapter.notifyDataSetChanged()
}

internal fun ReaderActivity.appearanceMenu() {
    val items = arrayOf(
        "Theme: ${theme.name}",
        "Font: ${FONT_NAMES[Settings.font(this).coerceIn(0, 2)]}",
        "Margins: ${MARGIN_NAMES[Settings.margin(this).coerceIn(0, 2)]}",
        "Larger text",
        "Smaller text",
        "Layout: ${if (bookMode) "Book pages" else "Scrolling"}",
        "Page turn: ${if (Settings.pageTurn(this) == "flip") "Page flip" else "Slide"}",
        "Night mode schedule: ${if (Settings.nightOn(this)) "${hm(Settings.nightFrom(this))}–${hm(Settings.nightTo(this))}" else "Off"}"
    )
    AlertDialog.Builder(this).setTitle("Appearance").setItems(items) { _, w ->
        when (w) {
            0 -> choose("Theme", READER_THEMES.map { it.name }) { Settings.setTheme(this, it) }
            1 -> choose("Font", FONT_NAMES) { Settings.setFont(this, it) }
            2 -> choose("Margins", MARGIN_NAMES) { Settings.setMargin(this, it) }
            3, 4 -> {
                Settings.setTextSize(this, (textSize + if (w == 3) 2f else -2f).coerceIn(12f, 34f))
                loadAppearance(); applyAppearance(); appearanceMenu()
            }
            5 -> { setLayoutMode(!bookMode); appearanceMenu() }
            6 -> {
                Settings.setPageTurn(this, if (Settings.pageTurn(this) == "flip") "slide" else "flip")
                bookView.turnStyle = Settings.pageTurn(this)
                appearanceMenu()
            }
            7 -> nightDialog()
        }
    }.show()
}

internal fun ReaderActivity.hm(m: Int) = String.format(Locale.getDefault(), "%d:%02d", m / 60, m % 60)

/** Switch to a darker theme automatically between two times. */
internal fun ReaderActivity.nightDialog() {
    var on = Settings.nightOn(this)
    var from = Settings.nightFrom(this)
    var to = Settings.nightTo(this)
    var th = Settings.nightTheme(this)
    val box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(8), dp(20), 0) }
    val check = CheckBox(this).apply { text = "Switch theme automatically at night"; isChecked = on }
    val fromBtn = Button(this); val toBtn = Button(this); val thBtn = Button(this)
    fun label() {
        fromBtn.text = "From ${hm(from)}"; toBtn.text = "Until ${hm(to)}"
        thBtn.text = "Night theme: ${READER_THEMES.getOrElse(th) { READER_THEMES[0] }.name}"
    }
    label()
    fromBtn.setOnClickListener { TimePickerDialog(this, { _, h, m -> from = h * 60 + m; label() }, from / 60, from % 60, false).show() }
    toBtn.setOnClickListener { TimePickerDialog(this, { _, h, m -> to = h * 60 + m; label() }, to / 60, to % 60, false).show() }
    thBtn.setOnClickListener {
        AlertDialog.Builder(this).setItems(READER_THEMES.map { it.name }.toTypedArray()) { _, w -> th = w; label() }.show()
    }
    box.addView(check); box.addView(fromBtn); box.addView(toBtn); box.addView(thBtn)
    AlertDialog.Builder(this).setTitle("Night mode schedule").setView(box)
        .setPositiveButton("Save") { _, _ ->
            on = check.isChecked
            Settings.setNight(this, on, from, to, th)
            loadAppearance(); applyAppearance()
        }
        .setNegativeButton("Cancel", null)
        .show()
}

/** Text size, theme and layout in one place (you can also pinch the text to resize it). */
internal fun ReaderActivity.lookSheet() {
    sheet("Text and look · tip: pinch the page to zoom", listOf(
        SheetRow("A+", "Bigger text", "Now ${textSize.toInt()}") { changeTextSize(2f); lookSheet() },
        SheetRow("A−", "Smaller text", "Now ${textSize.toInt()}") { changeTextSize(-2f); lookSheet() },
        SheetRow("🎨", "Theme: ${theme.name}", "Dark, light, sepia or black") {
            AlertDialog.Builder(this).setItems(READER_THEMES.map { it.name }.toTypedArray()) { _, w -> Settings.setTheme(this, w); loadAppearance(); applyAppearance() }.show()
        },
        SheetRow(if (bookMode) "📜" else "📖", if (bookMode) "Switch to scrolling" else "Switch to book pages", if (bookMode) "One long page" else "Swipe or tap the edges to turn pages") { setLayoutMode(!bookMode) },
        SheetRow("☰", "Straight right edge (justified)", "Off: even word spacing, easier on narrow screens", Settings.justify(this)) { Settings.setJustify(this, !Settings.justify(this)); loadAppearance(); applyAppearance() },
        SheetRow("🔠", "Font, margins, page turn, night mode…") { appearanceMenu() }
    ))
}

internal fun ReaderActivity.changeTextSize(d: Float) {
    Settings.setTextSize(this, (textSize + d).coerceIn(12f, 40f))
    loadAppearance(); applyAppearance()
}
