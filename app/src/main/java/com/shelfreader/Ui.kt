package com.shelfreader

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.graphics.Typeface
import android.view.View
import android.view.ViewGroup
import android.widget.BaseAdapter
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import java.util.Locale

const val MATCH = -1
const val WRAP = -2

fun Context.dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

fun Context.toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_LONG).show()

/** Reader colour schemes: background, text, current paragraph, current sentence. */
data class ReaderTheme(val name: String, val bg: Int, val fg: Int, val para: Int, val sent: Int)

val READER_THEMES = listOf(
    ReaderTheme("Dark", 0xFF161616.toInt(), 0xFFE2E2E2.toInt(), 0x1A6699FF, 0x553399FF),
    ReaderTheme("Light", 0xFFFBFBFA.toInt(), 0xFF1E1E1E.toInt(), 0x142266CC, 0x403388FF),
    ReaderTheme("Sepia", 0xFFF4ECD8.toInt(), 0xFF3B2F22.toInt(), 0x18A0702A, 0x55D9A441),
    ReaderTheme("Black", 0xFF000000.toInt(), 0xFFC8C8C8.toInt(), 0x1A6699FF, 0x553399FF)
)
val FONT_NAMES = listOf("Serif", "Sans-serif", "Monospace")
val FONTS = listOf(Typeface.SERIF, Typeface.SANS_SERIF, Typeface.MONOSPACE)
val MARGIN_NAMES = listOf("Narrow", "Medium", "Wide")
val MARGINS_DP = listOf(10, 22, 40)

/** Simple two-line list rows: bold title + smaller subtitle. */
class TwoLineAdapter(private val ctx: Context, private val items: List<Pair<String, String>>) : BaseAdapter() {
    override fun getCount() = items.size
    override fun getItem(position: Int): Any = items[position]
    override fun getItemId(position: Int) = position.toLong()

    override fun getView(position: Int, convertView: View?, parent: ViewGroup?): View {
        val row = (convertView as? LinearLayout) ?: LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(ctx.dp(16), ctx.dp(10), ctx.dp(16), ctx.dp(10))
            addView(TextView(ctx).apply { textSize = 17f; setTypeface(typeface, Typeface.BOLD) })
            addView(TextView(ctx).apply { textSize = 13f; alpha = 0.7f })
        }
        (row.getChildAt(0) as TextView).text = items[position].first
        (row.getChildAt(1) as TextView).text = items[position].second
        return row
    }
}

/** Dialog for managing pronunciation fixes. */
fun Activity.editPronunciations(onChanged: () -> Unit) {
    val rules = Settings.fixes(this).toMutableList()
    val labels = rules.map { "${it.from}  →  ${it.to.ifBlank { "(skip)" }}" } + "＋ Add a fix…"
    AlertDialog.Builder(this)
        .setTitle("Pronunciation fixes")
        .setItems(labels.toTypedArray()) { _, w ->
            if (w == rules.size) {
                addPronunciation(onChanged)
            } else {
                AlertDialog.Builder(this)
                    .setTitle(labels[w])
                    .setPositiveButton("Delete") { _, _ ->
                        rules.removeAt(w)
                        Settings.setFixes(this, rules)
                        onChanged()
                        editPronunciations(onChanged)
                    }
                    .setNegativeButton("Cancel") { _, _ -> editPronunciations(onChanged) }
                    .show()
            }
        }
        .setNegativeButton("Done", null)
        .show()
}

private fun Activity.addPronunciation(onChanged: () -> Unit) {
    val box = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(20), dp(8), dp(20), 0)
    }
    val from = EditText(this).apply { hint = "Word as written, e.g. Penelope" }
    val to = EditText(this).apply { hint = "Say it as, e.g. pen-ELL-oh-pee" }
    box.addView(from)
    box.addView(to)
    AlertDialog.Builder(this)
        .setTitle("Add a pronunciation fix")
        .setMessage("Matches whole words, ignoring capitals. Leave the second box empty to skip the word.")
        .setView(box)
        .setPositiveButton("Save") { _, _ ->
            val f = from.text.toString().trim()
            if (f.isNotEmpty()) {
                Settings.setFixes(this, Settings.fixes(this) + Fix(f, to.text.toString().trim()))
                onChanged()
            }
            editPronunciations(onChanged)
        }
        .setNegativeButton("Cancel", null)
        .show()
}

/** Tick the collections a book belongs to; "New collection…" adds one. */
fun editCollections(act: Activity, bookId: String, onDone: () -> Unit) {
    val names = Collections.names(act)
    val current = Collections.of(act, bookId)
    val checked = BooleanArray(names.size) { names[it] in current }
    AlertDialog.Builder(act)
        .setTitle("Collections")
        .setMultiChoiceItems(names.toTypedArray(), checked) { _, w, isChecked -> checked[w] = isChecked }
        .setPositiveButton("Save") { _, _ ->
            Collections.set(act, bookId, names.filterIndexed { i, _ -> checked[i] }.toSet())
            onDone()
        }
        .setNeutralButton("New collection…") { _, _ ->
            val box = EditText(act).apply { hint = "Collection name"; isSingleLine = true }
            val wrap = LinearLayout(act).apply {
                setPadding(act.dp(20), act.dp(8), act.dp(20), 0)
                addView(box, LinearLayout.LayoutParams(MATCH, WRAP))
            }
            AlertDialog.Builder(act)
                .setTitle("New collection")
                .setView(wrap)
                .setPositiveButton("Create") { _, _ ->
                    val n = box.text.toString().trim()
                    if (n.isNotEmpty()) {
                        Collections.create(act, n)
                        Collections.add(act, bookId, n)
                    }
                    editCollections(act, bookId, onDone)
                }
                .setNegativeButton("Cancel", null)
                .show()
        }
        .setNegativeButton("Cancel", null)
        .show()
}

/** One-time guide to getting the best-sounding voice. */
fun showVoiceGuide(act: Activity) {
    Settings.setSeenVoiceGuide(act)
    AlertDialog.Builder(act)
        .setTitle("Get the best voice")
        .setMessage(
            "Shelf Reader uses your phone's text-to-speech voices. For the most natural sound:\n\n" +
                "1. Install or update “Speech Services by Google”.\n" +
                "2. Open voice settings and make it the preferred engine.\n" +
                "3. Tap the ⚙ next to it → Install voice data → your language, and download a voice.\n" +
                "4. In a book, open the menu → Voice and pick it.\n\n" +
                "You can see this again from the main menu."
        )
        .setPositiveButton("Open voice settings") { _, _ ->
            try { act.startActivity(android.content.Intent("com.android.settings.TTS_SETTINGS")) }
            catch (e: Throwable) { act.toast("Open Settings → Accessibility → Text-to-speech") }
        }
        .setNeutralButton("Get Google voices") { _, _ ->
            try {
                act.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW,
                    android.net.Uri.parse("market://details?id=com.google.android.tts")))
            } catch (e: Throwable) {
                act.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW,
                    android.net.Uri.parse("https://play.google.com/store/apps/details?id=com.google.android.tts")))
            }
        }
        .setNegativeButton("Later", null)
        .show()
}

/** Reading stats: today's minutes against a daily goal, streak, the last 14 days, and finished books. */
fun showStats(act: android.app.Activity) {
    val o = Stats.load(act)
    val goal = Stats.goal(act)
    val fmt = java.text.SimpleDateFormat("yyyy-MM-dd", Locale.US)
    val cal = java.util.Calendar.getInstance()
    val today = Stats.minutes(o, fmt.format(cal.time))
    // streak: days in a row (ending today, or yesterday if nothing yet today) with at least a minute
    var streak = 0
    val c = java.util.Calendar.getInstance()
    if (today == 0) c.add(java.util.Calendar.DAY_OF_YEAR, -1)
    while (Stats.minutes(o, fmt.format(c.time)) > 0) { streak++; c.add(java.util.Calendar.DAY_OF_YEAR, -1) }
    val sb = StringBuilder()
    sb.append("Today: $today of $goal minutes").append(if (today >= goal) "  ✓ goal reached!" else "").append("\n")
    sb.append("Streak: $streak day${if (streak == 1) "" else "s"}\n\nLast 14 days\n")
    val d = java.util.Calendar.getInstance(); d.add(java.util.Calendar.DAY_OF_YEAR, -13)
    val dayName = java.text.SimpleDateFormat("EEE d", Locale.getDefault())
    val days = (0 until 14).map { val k = fmt.format(d.time); val n = dayName.format(d.time); d.add(java.util.Calendar.DAY_OF_YEAR, 1); n to Stats.minutes(o, k) }
    val top = maxOf(goal, days.maxOf { it.second }, 1)
    for ((n, m) in days) {
        val bar = "█".repeat((m * 14 + top - 1) / top)
        sb.append(n.padEnd(7)).append(" ").append(bar).append(if (m > 0) " $m" else " ·").append("\n")
    }
    val fin = o.optJSONArray("finished")
    if (fin != null && fin.length() > 0) {
        sb.append("\nFinished (${fin.length()})\n")
        for (i in fin.length() - 1 downTo maxOf(0, fin.length() - 15)) {
            val f = fin.getJSONObject(i)
            sb.append("• ").append(f.optString("title")).append(" — ").append(f.optString("date").take(10)).append("\n")
        }
    }
    val tv = android.widget.TextView(act).apply {
        text = sb.toString()
        typeface = Typeface.MONOSPACE
        textSize = 14f
        setPadding(act.dp(20), act.dp(12), act.dp(20), act.dp(12))
    }
    android.app.AlertDialog.Builder(act).setTitle("Reading stats")
        .setView(android.widget.ScrollView(act).apply { addView(tv) })
        .setPositiveButton("Close", null)
        .setNeutralButton("Daily goal…") { _, _ ->
            val opts = listOf(10, 15, 20, 30, 45, 60, 90, 120)
            android.app.AlertDialog.Builder(act).setTitle("Daily reading + listening goal")
                .setItems(opts.map { "$it minutes" }.toTypedArray()) { _, w -> Stats.setGoal(act, opts[w]); showStats(act) }
                .show()
        }
        .show()
}

// =====================================================================
// A small, consistent look for the whole app (no extra libraries)
// =====================================================================
object UiColors {
    const val BG = 0xFF121212.toInt()
    const val SURFACE = 0xFF1C1C1E.toInt()
    const val SURFACE2 = 0xFF2A2A2D.toInt()
    const val LINE = 0xFF34343A.toInt()
    const val FG = 0xFFEDEDED.toInt()
    const val MUTED = 0xFF9A9AA0.toInt()
    const val ACCENT = 0xFF56B394.toInt()
    const val ACCENT_DARK = 0xFF2E6E5A.toInt()
    const val ON_ACCENT = 0xFFFFFFFF.toInt()
}

/** A rounded background with a touch ripple. */
fun Context.roundBg(color: Int, radiusDp: Int, stroke: Int? = null): android.graphics.drawable.Drawable {
    val shape = android.graphics.drawable.GradientDrawable().apply {
        setColor(color); cornerRadius = dp(radiusDp).toFloat()
        if (stroke != null) setStroke(dp(1), stroke)
    }
    val mask = android.graphics.drawable.GradientDrawable().apply { setColor(-1); cornerRadius = dp(radiusDp).toFloat() }
    return android.graphics.drawable.RippleDrawable(android.content.res.ColorStateList.valueOf(0x33FFFFFF), shape, mask)
}

/** A rounded button: filled green for the main action, outlined for the rest. */
fun Context.pill(label: String, primary: Boolean = false, onClick: () -> Unit): TextView = TextView(this).apply {
    text = label
    textSize = 15f
    gravity = android.view.Gravity.CENTER
    setTextColor(if (primary) UiColors.ON_ACCENT else UiColors.FG)
    setTypeface(typeface, Typeface.BOLD)
    background = roundBg(if (primary) UiColors.ACCENT_DARK else UiColors.SURFACE2, 22, if (primary) null else UiColors.LINE)
    setPadding(dp(18), dp(11), dp(18), dp(11))
    minHeight = dp(44)
    isClickable = true; isFocusable = true
    setOnClickListener { onClick() }
}

/** A small rounded chip (for speed, filters and similar). */
fun Context.chip(label: String, onClick: () -> Unit): TextView = TextView(this).apply {
    text = label
    textSize = 14f
    gravity = android.view.Gravity.CENTER
    setTextColor(UiColors.FG)
    background = roundBg(UiColors.SURFACE2, 18, UiColors.LINE)
    setPadding(dp(14), dp(8), dp(14), dp(8))
    minHeight = dp(38)
    isClickable = true; isFocusable = true
    setOnClickListener { onClick() }
}

/** A round icon button with a symbol and an accessible description. */
fun Context.iconBtn(symbol: String, desc: String, sizeDp: Int = 44, filled: Boolean = false, onClick: () -> Unit): TextView = TextView(this).apply {
    text = symbol
    contentDescription = desc
    textSize = if (sizeDp >= 64) 26f else 19f
    gravity = android.view.Gravity.CENTER
    setTextColor(if (filled) UiColors.ON_ACCENT else UiColors.FG)
    background = roundBg(if (filled) UiColors.ACCENT_DARK else 0x00000000, sizeDp / 2)
    layoutParams = LinearLayout.LayoutParams(dp(sizeDp), dp(sizeDp))
    isClickable = true; isFocusable = true
    setOnClickListener { onClick() }
    setOnLongClickListener { toast(desc); true }
}

/** The app's own top bar: optional back arrow, title (+ subtitle) and icon actions. */
fun Context.topBar(title: String, onBack: (() -> Unit)?, vararg actions: Pair<String, Pair<String, () -> Unit>>): Pair<LinearLayout, Pair<TextView, TextView>> {
    val bar = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = android.view.Gravity.CENTER_VERTICAL
        setBackgroundColor(UiColors.SURFACE)
        setPadding(dp(4), dp(6), dp(4), dp(6))
        elevation = dp(2).toFloat()
    }
    if (onBack != null) bar.addView(iconBtn("←", "Back") { onBack() })
    val titles = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(if (onBack == null) 14 else 6), 0, dp(6), 0) }
    val t = TextView(this).apply { text = title; textSize = 19f; setTextColor(UiColors.FG); setTypeface(typeface, Typeface.BOLD); maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END }
    val sub = TextView(this).apply { textSize = 13f; setTextColor(UiColors.MUTED); maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END; visibility = View.GONE }
    titles.addView(t); titles.addView(sub)
    bar.addView(titles, LinearLayout.LayoutParams(0, WRAP, 1f))
    for ((sym, a) in actions) bar.addView(iconBtn(sym, a.first) { a.second() })
    return bar to (t to sub)
}

/** One row in an action sheet. */
data class SheetRow(val icon: String, val label: String, val sub: String? = null, val checked: Boolean? = null, val stay: Boolean = false, val action: () -> Unit)

/** A bottom sheet with large, clear rows (used instead of long pop-up menus). */
fun Activity.sheet(title: String?, rows: List<SheetRow?>, scrollTo: Int = -1) {
    val dlg = android.app.Dialog(this)
    val col = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(0, dp(10), 0, dp(16))
        background = android.graphics.drawable.GradientDrawable().apply {
            setColor(UiColors.SURFACE)
            cornerRadii = floatArrayOf(dp(18).toFloat(), dp(18).toFloat(), dp(18).toFloat(), dp(18).toFloat(), 0f, 0f, 0f, 0f)
        }
    }
    col.addView(View(this).apply { background = roundBg(UiColors.LINE, 3) }, LinearLayout.LayoutParams(dp(40), dp(5)).apply { gravity = android.view.Gravity.CENTER_HORIZONTAL; bottomMargin = dp(8) })
    if (title != null) col.addView(TextView(this).apply {
        text = title; textSize = 15f; setTextColor(UiColors.MUTED); setPadding(dp(20), dp(4), dp(20), dp(8)); maxLines = 5
    })
    for (r in rows) {
        if (r == null) { col.addView(View(this).apply { setBackgroundColor(UiColors.LINE) }, LinearLayout.LayoutParams(MATCH, dp(1)).apply { setMargins(dp(16), dp(6), dp(16), dp(6)) }); continue }
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER_VERTICAL
            setPadding(dp(20), dp(12), dp(20), dp(12))
            background = roundBg(0x00000000, 0)
            minimumHeight = dp(52)
            isClickable = true
            setOnClickListener { if (!r.stay) dlg.dismiss(); r.action() }
        }
        row.addView(TextView(this).apply { text = r.icon; textSize = 20f; gravity = android.view.Gravity.CENTER }, LinearLayout.LayoutParams(dp(34), WRAP))
        val texts = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(12), 0, 0, 0) }
        texts.addView(TextView(this).apply { text = r.label; textSize = 16f; setTextColor(UiColors.FG) })
        if (r.sub != null) texts.addView(TextView(this).apply { text = r.sub; textSize = 13f; setTextColor(UiColors.MUTED) })
        row.addView(texts, LinearLayout.LayoutParams(0, WRAP, 1f))
        if (r.checked != null) row.addView(android.widget.Switch(this).apply { isChecked = r.checked; isClickable = false; isFocusable = false })
        col.addView(row)
    }
    val scroll = android.widget.ScrollView(this).apply { addView(col) }
    if (scrollTo >= 0) scroll.post { col.getChildAt((scrollTo + (if (title != null) 2 else 1)).coerceAtMost(col.childCount - 1))?.let { scroll.scrollTo(0, maxOf(0, it.top - dp(80))) } }
    dlg.requestWindowFeature(android.view.Window.FEATURE_NO_TITLE)
    dlg.setContentView(scroll)
    dlg.window?.apply {
        setBackgroundDrawable(android.graphics.drawable.ColorDrawable(0))
        setGravity(android.view.Gravity.BOTTOM)
        setLayout(MATCH, WRAP)
        attributes = attributes.apply { windowAnimations = android.R.style.Animation_InputMethod }

        val maxH = (resources.displayMetrics.heightPixels * 0.85).toInt()
        scroll.viewTreeObserver.addOnGlobalLayoutListener { if (scroll.height > maxH) setLayout(MATCH, maxH) }
    }
    dlg.show()
}

/** A friendly one-time tip card with a "Got it" button. Hidden for good once dismissed. */
fun Context.tipCard(key: String, text: String): View {
    val card = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = android.view.Gravity.CENTER_VERTICAL
        background = roundBg(0xFF1F3A31.toInt(), 14, UiColors.ACCENT_DARK)
        setPadding(dp(14), dp(10), dp(8), dp(10))
        visibility = if (Settings.seenTip(this@tipCard, key)) View.GONE else View.VISIBLE
    }
    card.addView(TextView(this).apply { this.text = "💡"; textSize = 18f }, LinearLayout.LayoutParams(WRAP, WRAP).apply { rightMargin = dp(10) })
    card.addView(TextView(this).apply {
        this.text = text; textSize = 14f; setTextColor(UiColors.FG); setLineSpacing(0f, 1.15f)
    }, LinearLayout.LayoutParams(0, WRAP, 1f))
    card.addView(TextView(this).apply {
        this.text = "Got it"; textSize = 14f; setTextColor(UiColors.ACCENT); setTypeface(typeface, Typeface.BOLD)
        setPadding(dp(12), dp(10), dp(12), dp(10))
        background = roundBg(0x00000000, 12)
        isClickable = true; isFocusable = true
        setOnClickListener { Settings.setSeenTip(this@tipCard, key); card.visibility = View.GONE }
    })
    return card
}

/** A titled group in the settings screen. */
fun Context.sectionTitle(label: String): TextView = TextView(this).apply {
    text = label.uppercase(Locale.getDefault()); textSize = 12f; letterSpacing = 0.08f
    setTextColor(UiColors.ACCENT); setTypeface(typeface, Typeface.BOLD)
    setPadding(dp(20), dp(22), dp(20), dp(6))
}

/** A settings row: icon, label, explanation, optional switch. */
fun Context.settingRow(icon: String, label: String, sub: String?, switch: Boolean? = null, onClick: (android.widget.Switch?) -> Unit): LinearLayout {
    val row = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = android.view.Gravity.CENTER_VERTICAL
        setPadding(dp(20), dp(12), dp(16), dp(12))
        background = roundBg(0x00000000, 0)
        minimumHeight = dp(56)
        isClickable = true
    }
    row.addView(TextView(this).apply { text = icon; textSize = 20f; gravity = android.view.Gravity.CENTER }, LinearLayout.LayoutParams(dp(32), WRAP))
    val texts = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(14), 0, dp(8), 0) }
    texts.addView(TextView(this).apply { text = label; textSize = 16f; setTextColor(UiColors.FG) })
    if (sub != null) texts.addView(TextView(this).apply { text = sub; textSize = 13f; setTextColor(UiColors.MUTED) })
    row.addView(texts, LinearLayout.LayoutParams(0, WRAP, 1f))
    var sw: android.widget.Switch? = null
    if (switch != null) { sw = android.widget.Switch(this).apply { isChecked = switch; isClickable = false; isFocusable = false }; row.addView(sw) }
    row.setOnClickListener { sw?.let { it.isChecked = !it.isChecked }; onClick(sw) }
    return row
}


/** "CHAPTER I. Down the Rabbit-Hole" → "Chapter I · Down the Rabbit-Hole" (for lists and headers). */
fun prettyChapter(t: String): String {
    val m = Regex("^(CHAPTER|PART|BOOK|VOLUME|ACT|CANTO|LETTER|STAVE)\\s+([A-Z0-9]+)\\.?\\s*[:.—–-]?\\s*(.*)$").find(t.trim()) ?: return t
    val kw = m.groupValues[1].lowercase().replaceFirstChar { it.uppercase() }
    val rest = m.groupValues[3].trim()
    return "$kw ${m.groupValues[2]}" + if (rest.isNotEmpty()) " · " + SpeechText.titleCase(rest) else ""
}
