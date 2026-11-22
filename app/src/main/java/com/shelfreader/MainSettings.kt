package com.shelfreader

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.AdapterView
import android.widget.BaseAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.GridView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors

// Part of MainActivity (moved out of MainActivity.kt to keep files a readable size).

// ---------- settings: every option in one clear place ----------
internal fun MainActivity.buildSettings() {
    val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(0, 0, 0, dp(24)) }
    fun add(v: View) = col.addView(v)
    val svc = { TtsService.instance?.applySettings(true) }
    add(sectionTitle("Voice & audio"))
    add(settingRow("🗣", "Voice and speed", "Default voice for new books, and how fast it reads. Each book can also have its own (in the player).") { defaultVoiceDialog() })
    add(settingRow("✨", "Get better voices", "Install natural Google voices, step by step") { showVoiceGuide(this) })
    add(settingRow("🌧", "Background sounds", "Rain, waves, fire, white noise… under the voice, each with its own volume · ${Ambience.summary(this)}") { AmbiencePicker(this).show() })
    add(settingRow("🔤", "Pronunciations", "Fix names or words the voice says wrong") { editPronunciations { svc() } })
    add(settingRow("⏸", "Natural pauses", "Pause by punctuation, longer between paragraphs, chapter headings announced", Settings.naturalPauses(this)) { Settings.setNaturalPauses(this, it?.isChecked == true); svc() })
    add(settingRow("🔢", "Say numbers properly", "“Chapter XII” → “Chapter Twelve”, Henry VIII, 1850s, $4.50, Dr., St.", Settings.speakNumbers(this)) { Settings.setSpeakNumbers(this, it?.isChecked == true); svc() })
    add(settingRow("🧵", "Fix broken lines", "Join sentences a book split across lines (common in scanned books and PDFs) before reading them aloud", Settings.fixBrokenLines(this)) { Settings.setFixBrokenLines(this, it?.isChecked == true); svc() })
    add(settingRow("✂", "Skip page numbers & clutter", "Page numbers, running headers, footnote markers, links", Settings.skipClutter(this)) { Settings.setSkipClutter(this, it?.isChecked == true); svc() })
    add(settingRow("🎧", "Resume with headphones", "Continue a paused book when headphones connect", Settings.resumeOnHeadphones(this)) { Settings.setResumeOnHeadphones(this, it?.isChecked == true) })
    add(settingRow("⚙", "Android text-to-speech settings", "Speech engine, language packs and default rate") { openTtsSettingsScreen() })
    add(sectionTitle("Your books"))
    add(settingRow("🔁", "Keep listening", "When a book ends, start another: Up next first, then Want to read, then books you've started", Settings.autoNextBook(this)) { Settings.setAutoNextBook(this, it?.isChecked == true) })
    add(settingRow("⏭", "Up next", "Books that play one after another (${Settings.queue(this).size})") { showQueue() })
    add(settingRow("🔎", "Search inside your books", "Find a word or phrase in every book and listen from there") { searchBooks() })
    add(settingRow("📊", "Reading stats", "Daily goal, streak and finished books") { showStats(this) })
    add(settingRow("🗂", "Collections", "Delete collections you made") { manageCollections() })
    add(sectionTitle("Sync & backup"))
    add(settingRow("🔄", "Sync with PC", if (Settings.syncUri(this) != null) "On · keeps your place, notes and stats in step with the PC app" else "Off · keep your place and notes the same on your PC") { syncMenu() })
    add(settingRow("💾", "Back up library", "Save books, places and notes to one file") { backupLibrary() })
    add(settingRow("📥", "Restore from backup", "Bring back a backup file") { restoreLibrary() })
    add(sectionTitle("App"))
    add(settingRow("🐞", "Report a problem", "Stuck, skipping, crashes: makes a report of what the app was doing") { CrashReport.reportProblem(this) })
    add(settingRow("⬆", "Check for updates", "You have build ${Updater.currentBuild(this)} · ${if (Settings.betaUpdates(this)) "Beta" else "Stable"} updates") { checkUpdates(true) })
    add(settingRow("🧪", "Update channel: ${if (Settings.betaUpdates(this)) "Beta" else "Stable"}",
        if (Settings.betaUpdates(this)) "Every new build straight away (may have new problems). Tap for Stable" else "Only builds that passed every test. Tap for Beta (newest builds first)") {
        Settings.setBetaUpdates(this, !Settings.betaUpdates(this)); buildSettings()
    })
    add(settingRow("🔑", "GitHub token for updates", if (Settings.updateToken(this) != null) "Saved · updates work while the repository is private" else "Needed while the repository is private") { tokenDialog() })
    settingsPane.removeAllViews()
    settingsPane.addView(col)
}

internal fun MainActivity.defaultVoiceDialog() {
    val rates = listOf(0.75f, 0.9f, 1f, 1.1f, 1.25f, 1.5f, 1.75f, 2f)
    AlertDialog.Builder(this).setTitle("Default speed for new books")
        .setItems(rates.map { (if (it == 1f) "Normal" else "${it}×") + if (it == Settings.rate(this)) "  ✓" else "" }.toTypedArray()) { _, w ->
            Settings.setRate(this, rates[w]); TtsService.instance?.applySettings(true); toast("Default speed set. Open a book to choose its voice.")
        }.setNeutralButton("Choose voices in a book") { _, _ -> toast("Open a book, then tap 🗣 Voice in the player.") }
        .show()
}

internal fun MainActivity.openTtsSettingsScreen() {
    try { startActivity(Intent("com.android.settings.TTS_SETTINGS")) } catch (e: Throwable) { toast("Couldn't open the speech settings") }
}

internal fun MainActivity.backupLibrary() {
    val name = "ShelfReader-backup-" + SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date()) + ".zip"
    try {
        @Suppress("DEPRECATION")
        startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/zip").putExtra(Intent.EXTRA_TITLE, name), 45)
    } catch (e: Throwable) { toast("No file picker available") }
}

internal fun MainActivity.restoreLibrary() {
    try {
        @Suppress("DEPRECATION")
        startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
            .putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/zip", "application/x-zip-compressed", "application/octet-stream")), 46)
    } catch (e: Throwable) { toast("No file picker available") }
}

internal fun MainActivity.manageCollections() {
    val custom = Collections.names(this).drop(2)
    if (custom.isEmpty()) {
        toast("You haven't made any collections yet. Long-press a book → Collections… → New collection.")
        return
    }
    AlertDialog.Builder(this).setTitle("Delete a collection").setItems(custom.toTypedArray()) { _, w ->
        AlertDialog.Builder(this)
            .setMessage("Delete the collection “${custom[w]}”? The books stay in your library.")
            .setPositiveButton("Delete") { _, _ -> Collections.delete(this, custom[w]); refreshLibrary() }
            .setNegativeButton("Cancel", null)
            .show()
    }.show()
}

internal fun MainActivity.syncMenu() {
    val on = Settings.syncUri(this) != null
    val last = Settings.lastSync(this)
    val msg = if (on) "Your place, bookmarks, highlights, notes, collections and reading stats are kept in step with the PC app through a ShelfReader-sync.json file." +
        (if (last > 0) "\n\nLast synced: " + java.text.DateFormat.getDateTimeInstance().format(Date(last)) else "")
    else "Keep your place, bookmarks, highlights, notes, collections and stats the same on this phone and your PC.\n\n" +
        "1. In the PC app, open Settings → Sync and pick a folder in Google Drive or OneDrive.\n" +
        "2. Here, tap “Choose the sync file” and pick ShelfReader-sync.json in that same folder (in the Drive or OneDrive section of the file picker).\n\n" +
        "No PC yet? Tap “Create a new sync file” to make one in Drive, then point the PC app at that folder.\n\nBooks themselves aren't copied — add them on both devices."
    val b = AlertDialog.Builder(this).setTitle("Sync with PC").setMessage(msg)
    if (on) {
        b.setPositiveButton("Sync now") { _, _ -> runSync(true) }
        b.setNeutralButton("Turn off") { _, _ -> Settings.setSyncUri(this, null); toast("Sync turned off") }
        b.setNegativeButton("Change file…") { _, _ -> pickSyncFile(false) }
    } else {
        b.setPositiveButton("Choose the sync file") { _, _ -> pickSyncFile(false) }
        b.setNeutralButton("Create a new sync file") { _, _ -> pickSyncFile(true) }
        b.setNegativeButton("Cancel", null)
    }
    b.show()
}

internal fun MainActivity.pickSyncFile(create: Boolean) {
    try {
        val i = if (create) Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
            .setType("application/json").putExtra(Intent.EXTRA_TITLE, "ShelfReader-sync.json")
        else Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
        @Suppress("DEPRECATION")
        startActivityForResult(i, 47)
    } catch (e: Throwable) { toast("No file picker available") }
}

internal fun MainActivity.runSync(announce: Boolean) {
    if (syncing || Settings.syncUri(this) == null) return
    syncing = true
    pool.execute {
        val msg = try {
            val (pulled, pushed) = SyncFile.sync(this)
            "Synced: $pulled book${if (pulled == 1) "" else "s"} updated from the other device, $pushed in the sync file."
        } catch (t: Throwable) { "Sync failed: ${t.message}" }
        runOnUiThread {
            syncing = false
            if (announce || msg.startsWith("Sync failed")) toast(msg)
            if (!showingSearch) refreshLibrary()
        }
    }
}
