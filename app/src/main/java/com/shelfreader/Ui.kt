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
