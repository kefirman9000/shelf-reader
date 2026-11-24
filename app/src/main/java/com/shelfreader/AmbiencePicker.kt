package com.shelfreader

import android.app.Activity
import android.app.AlertDialog
import android.app.Dialog
import android.content.Intent
import android.graphics.Typeface
import android.os.Bundle
import android.view.Gravity
import android.widget.EditText
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.SeekBar
import android.widget.TextView

/**
 * The Background sounds screen: play the sounds on their own or under a book, add sounds (rain, waves,
 * birds, a train…), give each its own volume, set the overall volume, use or save mixes, and choose what
 * happens when the book stops. While you change the mix you hear it; it stops when you leave this screen.
 */
class AmbiencePicker(private val a: Activity, private val onClose: () -> Unit = {}) {
    private val app = a.applicationContext
    private val dlg = Dialog(a, R.style.AppTheme)
    private val body = LinearLayout(a).apply { orientation = LinearLayout.VERTICAL; setPadding(0, 0, 0, a.dp(32)) }
    private var playBtn: TextView? = null
    private var playSub: TextView? = null
    private val listener: () -> Unit = { showPlayState() }

    // the preview only plays while this screen is in front: leaving the app stops it
    private val life = object : android.app.Application.ActivityLifecycleCallbacks {
        override fun onActivityPaused(x: Activity) { if (x === a) Ambience.previewing(app, false) }
        override fun onActivityResumed(x: Activity) { if (x === a) showPlayState() }
        override fun onActivityCreated(x: Activity, b: Bundle?) {}
        override fun onActivityStarted(x: Activity) {}
        override fun onActivityStopped(x: Activity) {}
        override fun onActivitySaveInstanceState(x: Activity, b: Bundle) {}
        override fun onActivityDestroyed(x: Activity) { if (x === a && dlg.isShowing) dlg.dismiss() }
    }

    fun show() {
        val root = LinearLayout(a).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(UiColors.BG) }
        root.addView(a.topBar("Background sounds", { dlg.dismiss() }).first)
        root.addView(ScrollView(a).apply { addView(body) }, LinearLayout.LayoutParams(MATCH, 0, 1f))
        dlg.setContentView(root)
        dlg.window?.apply { statusBarColor = UiColors.SURFACE; navigationBarColor = UiColors.SURFACE }
        dlg.setOnDismissListener {
            Ambience.previewing(app, false)
            Ambience.listeners -= listener
            a.application.unregisterActivityLifecycleCallbacks(life)
            onClose()
        }
        Ambience.listeners += listener
        a.application.registerActivityLifecycleCallbacks(life)
        render()
        dlg.show()
    }

    /** You changed something: let it be heard (unless a book or the sounds are already playing it). */
    private fun hear() { if (!Ambience.audible(app)) Ambience.previewing(app, true) }

    private fun reading() = TtsService.instance?.playing == true

    private fun togglePlay() {
        if (Ambience.audible(app)) {
            if (reading()) { Ambience.mute(app); a.toast("Sounds paused. The book keeps reading.") }
            else Ambience.hush(app)   // the player hears about it and closes its notification if no book is open
        } else {
            if (Ambience.mix(app).values.none { it > 0f }) { a.toast("Add a sound or pick a mix first"); return }
            if (reading()) { if (!Ambience.on(app)) Ambience.setOn(app, true); Ambience.unmute(app) }
            else try { a.startForegroundService(Intent(a, TtsService::class.java).setAction(TtsService.ACTION_SOUNDS)) } catch (_: Throwable) { Ambience.setSolo(app, true) }
        }
        showPlayState()
    }

    private fun showPlayState() {
        val on = Ambience.audible(app)
        playBtn?.text = if (on) "⏸  Pause sounds" else "▶  Play sounds"
        playSub?.text = when {
            on && reading() -> "Playing under the book"
            on && Ambience.isSolo -> "Playing on their own" + (TtsService.instance?.sleepText()?.let { " · $it" } ?: "")
            on -> "Playing"
            reading() -> "Paused. The book keeps reading"
            else -> "Play them on their own, no book needed"
        }
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

    private fun chipRow(items: List<Pair<String, () -> Unit>>, longPress: Map<Int, () -> Unit> = emptyMap()): HorizontalScrollView {
        val chips = LinearLayout(a).apply { orientation = LinearLayout.HORIZONTAL; setPadding(a.dp(16), 0, a.dp(16), 0) }
        for ((k, it) in items.withIndex()) {
            val c = a.chip(it.first) { it.second() }
            longPress[k]?.let { lp -> c.setOnLongClickListener { lp(); true } }
            chips.addView(c, LinearLayout.LayoutParams(WRAP, WRAP).apply { rightMargin = a.dp(8) })
        }
        return HorizontalScrollView(a).apply { isHorizontalScrollBarEnabled = false; addView(chips) }
    }

    private fun sleepMenu() {
        val opts = listOf(0 to "Off", 15 to "15 minutes", 30 to "30 minutes", 45 to "45 minutes", 60 to "1 hour", 90 to "1½ hours", 120 to "2 hours")
        a.sheet("Stop everything after…", opts.map { (m, label) ->
            SheetRow(if (m == 0) "✕" else "⏲", label) {
                try { a.startService(Intent(a, TtsService::class.java).setAction(TtsService.ACTION_SLEEP).putExtra(TtsService.EXTRA_MINUTES, m)) } catch (_: Throwable) {}
                a.toast(if (m == 0) "Sleep timer off" else "Sounds and reading stop in $label")
                body.postDelayed({ render() }, 300)
            }
        })
    }

    private fun afterMenu() {
        val cur = Ambience.keepAfter(app)
        a.sheet("When the book stops by itself (sleep timer, end of the book)", listOf(0, 15, 30, 60, -1).map { m ->
            SheetRow(if (m == cur) "✅" else if (m == 0) "⏹" else "🌙", Ambience.keepAfterText(m),
                if (m == 0) "Sounds fade out with the voice" else "Pressing pause always stops them") { Ambience.setKeepAfter(app, m); render() }
        })
    }

    private fun saveMix() {
        val box = EditText(a).apply { hint = "Name, e.g. Reading in bed"; setSingleLine() }
        val pad = android.widget.FrameLayout(a).apply { setPadding(a.dp(20), a.dp(8), a.dp(20), 0); addView(box) }
        AlertDialog.Builder(a).setTitle("Save this mix").setView(pad)
            .setPositiveButton("Save") { _, _ -> Ambience.saveMix(app, box.text.toString(), Ambience.mix(app)); a.toast("Mix saved"); render() }
            .setNegativeButton("Cancel", null).show()
    }

    private fun render() {
        body.removeAllViews()
        val mix = Ambience.mix(app)
        val on = Ambience.on(app)

        // play / pause, right at the top
        val card = LinearLayout(a).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            background = a.roundBg(UiColors.SURFACE, 16, UiColors.LINE)
            setPadding(a.dp(14), a.dp(12), a.dp(14), a.dp(12))
            layoutParams = LinearLayout.LayoutParams(MATCH, WRAP).apply { setMargins(a.dp(16), a.dp(12), a.dp(16), a.dp(6)) }
        }
        playBtn = a.pill("▶  Play sounds", true) { togglePlay() }
        card.addView(playBtn)
        playSub = TextView(a).apply { textSize = 13f; setTextColor(UiColors.MUTED); setPadding(a.dp(12), 0, 0, 0) }
        card.addView(playSub, LinearLayout.LayoutParams(0, WRAP, 1f))
        body.addView(card)
        showPlayState()

        body.addView(a.settingRow("🎧", "Play while reading", if (on) "Sounds fade in when the book starts. Pause stops them too" else "Off: only when you press Play sounds", on) { sw ->
            Ambience.setOn(app, sw?.isChecked == true); render()
        })
        body.addView(a.settingRow("🌙", "When the book stops by itself", Ambience.keepAfterText(Ambience.keepAfter(app))) { afterMenu() })
        body.addView(a.settingRow("⏲", "Sleep timer", TtsService.instance?.sleepText()?.replaceFirstChar { it.uppercase() } ?: "Off: stop sounds and reading after a while") { sleepMenu() })

        // overall volume
        val vol = LinearLayout(a).apply { orientation = LinearLayout.VERTICAL; setPadding(a.dp(20), a.dp(4), a.dp(20), a.dp(8)) }
        vol.addView(TextView(a).apply { text = "Overall volume (the voice stays the same)"; textSize = 14f; setTextColor(UiColors.FG) })
        vol.addView(slider(Ambience.volume(app)) { Ambience.setVolume(app, it); hear() })
        body.addView(vol)

        // ready-made and saved mixes
        body.addView(a.sectionTitle("Quick mixes"))
        body.addView(chipRow(AmbienceSynth.PRESETS.map { (name, m) -> name to { Ambience.setMix(app, m); Ambience.setOn(app, true); hear(); render() } }))
        val saved = Ambience.saved(app)
        body.addView(a.sectionTitle("Your mixes"))
        val items = saved.map { (name, m) -> "★ $name" to { Ambience.setMix(app, m); Ambience.setOn(app, true); hear(); render() } }.toMutableList()
        if (mix.isNotEmpty()) items += "💾 Save this mix" to { saveMix() }
        if (mix.isNotEmpty()) items += "✕ Clear" to { Ambience.setMix(app, emptyMap()); render() }
        if (items.isEmpty()) body.addView(note("Make a mix below, then save it here to use again."))
        else body.addView(chipRow(items, saved.indices.associateWith { k -> {
            AlertDialog.Builder(a).setTitle("Delete “${saved[k].first}”?")
                .setPositiveButton("Delete") { _, _ -> Ambience.deleteMix(app, saved[k].first); render() }
                .setNegativeButton("Cancel", null).show(); Unit
        } }))
        if (saved.isNotEmpty()) body.addView(note("Touch and hold a saved mix to delete it."))

        // your mix: one slider per sound
        body.addView(a.sectionTitle("Now playing"))
        if (mix.isEmpty()) body.addView(note("No sounds yet. Add some below, or pick a mix."))
        for ((id, v) in mix) {
            val s = AmbienceSynth.SOUNDS.firstOrNull { it.id == id } ?: continue
            val c = LinearLayout(a).apply {
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
            c.addView(head)
            c.addView(slider(v) { nv ->
                pct.text = "${(nv * 100).toInt()}%"
                Ambience.setMix(app, Ambience.mix(app).apply { put(id, nv) }); hear()
            })
            if (id == "heart") {
                // the heartbeat's speed, next to its volume
                val lo = AmbienceSynth.HEART_MIN; val hi = AmbienceSynth.HEART_MAX
                val label = TextView(a).apply { textSize = 13f; setTextColor(UiColors.MUTED); text = "Speed: ${Ambience.heartBpm(app)} beats a minute" }
                c.addView(label)
                c.addView(SeekBar(a).apply {
                    max = hi - lo; progress = Ambience.heartBpm(app) - lo
                    setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                        override fun onProgressChanged(sb: SeekBar?, x: Int, fromUser: Boolean) {
                            if (!fromUser) return
                            label.text = "Speed: ${x + lo} beats a minute"
                            Ambience.setHeartBpm(app, x + lo); hear()
                        }
                        override fun onStartTrackingTouch(sb: SeekBar?) {}
                        override fun onStopTrackingTouch(sb: SeekBar?) {}
                    })
                })
            }
            body.addView(c)
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
                val add = { Ambience.setMix(app, Ambience.mix(app).apply { put(s.id, 0.5f) }); if (!Ambience.on(app)) Ambience.setOn(app, true); hear(); render() }
                row.addView(a.pill("+ Add", true) { add() })
                row.setOnClickListener { add() }
                body.addView(row)
            }
        }
        body.addView(note("All sounds are made on your phone, so they work offline and use no data. Pressing pause anywhere (here, the player, the notification, headphones) stops them."))
    }
}
