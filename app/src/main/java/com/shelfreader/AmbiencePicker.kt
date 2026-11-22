package com.shelfreader

import android.app.Activity
import android.app.Dialog
import android.graphics.Typeface
import android.view.Gravity
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.SeekBar
import android.widget.TextView

/**
 * The Background sounds screen: add sounds (rain, waves, fire, noise…), give each its own volume,
 * set the overall volume, or start from a ready-made mix. You hear the mix while this screen is open;
 * after that it plays under the voice whenever a book is being read.
 */
class AmbiencePicker(private val a: Activity, private val onClose: () -> Unit = {}) {
    private val app = a.applicationContext
    private val dlg = Dialog(a, android.R.style.Theme_Material_NoActionBar)
    private val body = LinearLayout(a).apply { orientation = LinearLayout.VERTICAL; setPadding(0, 0, 0, a.dp(32)) }

    fun show() {
        val root = LinearLayout(a).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(UiColors.BG) }
        root.addView(a.topBar("Background sounds", { dlg.dismiss() }).first)
        root.addView(ScrollView(a).apply { addView(body) }, LinearLayout.LayoutParams(MATCH, 0, 1f))
        dlg.setContentView(root)
        dlg.window?.apply { statusBarColor = UiColors.SURFACE; navigationBarColor = UiColors.SURFACE }
        dlg.setOnDismissListener { Ambience.previewing(app, false); onClose() }
        Ambience.previewing(app, true)
        render()
        dlg.show()
    }

    private fun note(t: String) = TextView(a).apply {
        text = t; textSize = 14f; setTextColor(UiColors.MUTED); setLineSpacing(0f, 1.15f); setPadding(a.dp(20), a.dp(10), a.dp(20), a.dp(4))
    }

    private fun slider(value: Float, onChange: (Float) -> Unit) = SeekBar(a).apply {
        max = 100; progress = (value * 100).toInt()
        setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(sb: SeekBar?, v: Int, fromUser: Boolean) { if (fromUser) onChange(v / 100f) }
            override fun onStartTrackingTouch(sb: SeekBar?) {}
            override fun onStopTrackingTouch(sb: SeekBar?) {}
        })
    }

    private fun render() {
        body.removeAllViews()
        val mix = Ambience.mix(app)
        val on = Ambience.on(app)

        body.addView(a.settingRow("🎧", "Play while reading", if (on) "Sounds fade in when the book starts and out when it stops" else "Off", on) { sw ->
            Ambience.setOn(app, sw?.isChecked == true); render()
        })

        // overall volume
        val vol = LinearLayout(a).apply { orientation = LinearLayout.VERTICAL; setPadding(a.dp(20), a.dp(4), a.dp(20), a.dp(8)) }
        vol.addView(TextView(a).apply { text = "Overall volume (the voice stays the same)"; textSize = 14f; setTextColor(UiColors.FG) })
        vol.addView(slider(Ambience.volume(app)) { Ambience.setVolume(app, it) })
        body.addView(vol)

        // ready-made mixes
        body.addView(a.sectionTitle("Quick mixes"))
        val chips = LinearLayout(a).apply { orientation = LinearLayout.HORIZONTAL; setPadding(a.dp(16), 0, a.dp(16), 0) }
        for ((name, m) in AmbienceSynth.PRESETS) {
            chips.addView(a.chip(name) { Ambience.setMix(app, m); Ambience.setOn(app, true); render() },
                LinearLayout.LayoutParams(WRAP, WRAP).apply { rightMargin = a.dp(8) })
        }
        if (mix.isNotEmpty()) chips.addView(a.chip("✕ Clear") { Ambience.setMix(app, emptyMap()); render() })
        body.addView(HorizontalScrollView(a).apply { isHorizontalScrollBarEnabled = false; addView(chips) })

        // your mix: one slider per sound
        body.addView(a.sectionTitle("Your mix"))
        if (mix.isEmpty()) body.addView(note("No sounds yet. Add some below, or pick a quick mix."))
        for ((id, v) in mix) {
            val s = AmbienceSynth.SOUNDS.firstOrNull { it.id == id } ?: continue
            val card = LinearLayout(a).apply {
                orientation = LinearLayout.VERTICAL
                background = a.roundBg(UiColors.SURFACE, 14, UiColors.LINE)
                setPadding(a.dp(14), a.dp(8), a.dp(8), a.dp(6))
                layoutParams = LinearLayout.LayoutParams(MATCH, WRAP).apply { setMargins(a.dp(16), a.dp(4), a.dp(16), a.dp(4)) }
            }
            val head = LinearLayout(a).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
            head.addView(TextView(a).apply { text = "${s.icon}  ${s.name}"; textSize = 16f; setTextColor(UiColors.FG); setTypeface(typeface, Typeface.BOLD) },
                LinearLayout.LayoutParams(0, WRAP, 1f))
            val pct = TextView(a).apply { text = "${(v * 100).toInt()}%"; textSize = 13f; setTextColor(UiColors.MUTED); setPadding(0, 0, a.dp(6), 0) }
            head.addView(pct)
            head.addView(a.iconBtn("✕", "Remove ${s.name}", 40) {
                Ambience.setMix(app, Ambience.mix(app).apply { remove(id) }); render()
            })
            card.addView(head)
            card.addView(slider(v) { nv ->
                pct.text = "${(nv * 100).toInt()}%"
                Ambience.setMix(app, Ambience.mix(app).apply { put(id, nv) })
            })
            body.addView(card)
        }

        // sounds you can add
        val rest = AmbienceSynth.SOUNDS.filter { it.id !in mix }
        if (rest.isNotEmpty()) {
            body.addView(a.sectionTitle("Add a sound"))
            for (s in rest) {
                val row = LinearLayout(a).apply {
                    orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
                    setPadding(a.dp(20), a.dp(6), a.dp(16), a.dp(6)); minimumHeight = a.dp(54)
                    isClickable = true
                }
                row.addView(TextView(a).apply { text = s.icon; textSize = 20f }, LinearLayout.LayoutParams(a.dp(36), WRAP))
                row.addView(TextView(a).apply { text = s.name; textSize = 16f; setTextColor(UiColors.FG) }, LinearLayout.LayoutParams(0, WRAP, 1f))
                val add = { Ambience.setMix(app, Ambience.mix(app).apply { put(s.id, 0.5f) }); if (!Ambience.on(app)) Ambience.setOn(app, true); render() }
                row.addView(a.pill("+ Add", true) { add() })
                row.setOnClickListener { add() }
                body.addView(row)
            }
        }
        body.addView(note("All sounds are made on your phone, so they work offline and use no data. They stop with the sleep timer too."))
    }
}
