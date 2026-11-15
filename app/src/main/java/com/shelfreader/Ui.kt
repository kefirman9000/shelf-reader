package com.shelfreader

import android.content.Context
import android.graphics.Typeface
import android.view.View
import android.view.ViewGroup
import android.widget.BaseAdapter
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast

const val MATCH = -1
const val WRAP = -2

fun Context.dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

fun Context.toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_LONG).show()

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
