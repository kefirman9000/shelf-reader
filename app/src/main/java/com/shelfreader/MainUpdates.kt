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

internal fun MainActivity.checkUpdates(manual: Boolean) {
    if (manual) toast("Checking GitHub for updates…")
    pool.execute {
        try {
            val r = Updater.latest(this)
            val cur = Updater.currentBuild(this)
            Settings.setLastUpdateCheck(this, System.currentTimeMillis())
            runOnUiThread {
                if (r != null && r.build > cur) {
                    AlertDialog.Builder(this)
                        .setTitle("Update available")
                        .setMessage("Build ${r.build} is ready (you have build $cur).")
                        .setPositiveButton("Install") { _, _ -> installUpdate(r) }
                        .setNegativeButton("Later", null)
                        .show()
                } else if (manual) {
                    toast("You're up to date (build $cur).")
                }
            }
        } catch (t: Throwable) {
            if (manual) runOnUiThread {
                AlertDialog.Builder(this).setTitle("Couldn't check for updates").setMessage(t.message ?: "Unknown error")
                    .setPositiveButton("Add a token…") { _, _ -> tokenDialog() }
                    .setNegativeButton("Close", null).show()
            }
        }
    }
}

/** Paste a read-only GitHub token so the app can see new builds while the repository is private. */
internal fun MainActivity.tokenDialog() {
    val box = EditText(this).apply {
        hint = if (Settings.updateToken(this@tokenDialog) != null) "A token is saved. Paste a new one to replace it" else "github_pat_…"
        setSingleLine(); inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
    }
    val info = TextView(this).apply {
        textSize = 14f
        text = "While the GitHub repository is private, GitHub only shares new builds with your account.\n\n" +
            "1. On GitHub: Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.\n" +
            "2. Repository access: Only select repositories → shelf-reader.\n" +
            "3. Permissions: Contents → Read-only. Generate, copy, paste below.\n\nIt stays on this phone. (If the repository is public, no token is needed.)"
    }
    val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(8), dp(20), 0); addView(info); addView(box) }
    val dlg = AlertDialog.Builder(this).setTitle("Updates from a private repository").setView(android.widget.ScrollView(this).apply { addView(col) })
        .setPositiveButton("Save & check") { _, _ ->
            val t = box.text.toString().trim()
            if (t.isNotEmpty() && !Regex("^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$").matches(t)) { toast("That doesn't look like a GitHub token (it starts with github_pat_ or ghp_)."); return@setPositiveButton }
            if (t.isNotEmpty()) Settings.setUpdateToken(this, t)
            checkUpdates(true)
        }
        .setNegativeButton("Cancel", null)
    if (Settings.updateToken(this) != null) dlg.setNeutralButton("Remove token") { _, _ -> Settings.setUpdateToken(this, null); toast("Token removed") }
    dlg.show()
}

internal fun MainActivity.installUpdate(r: Updater.Release) {
    toast("Downloading update…")
    pool.execute {
        try {
            val f = File(cacheDir, "update.apk")
            f.delete()
            // with a token, download through GitHub's API (works for private repositories)
            if (Settings.updateToken(this) != null && r.apiUrl.isNotEmpty()) Net.download(r.apiUrl, f, Updater.headers(this, asset = true)) { _, _ -> }
            else Net.download(r.url, f) { _, _ -> }
            runOnUiThread { toast("Installing — confirm on the next screen.") }
            Updater.install(this, f)
        } catch (t: Throwable) {
            runOnUiThread { toast("Update failed: ${t.message}") }
        }
    }
}

/** The update is signed with Shelf Reader's new key, so Android can't install it over this copy. Walks through the one-time reinstall. */
internal fun MainActivity.reinstallDialog() {
    AlertDialog.Builder(this)
        .setTitle("One-time reinstall needed")
        .setMessage("Shelf Reader's updates are now signed with a new, safer key. Android only installs an update over the app " +
            "when the keys match, so this one time:\n\n" +
            "1. Back up your library (button below). Save the file somewhere you can find it, like Downloads.\n" +
            "2. Download the new ShelfReader.apk from the releases page.\n" +
            "3. Uninstall Shelf Reader, then open the downloaded APK to install it.\n" +
            "4. In the new app: Settings → Restore library, and pick the backup.\n\n" +
            "Downloaded books, natural voices and settings are restored from the backup or downloaded again. After this, updates install normally.")
        .setPositiveButton("Back up now") { _, _ -> backupLibrary() }
        .setNeutralButton("Releases page") { _, _ ->
            try { startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse("https://github.com/${Updater.REPO}/releases/latest"))) } catch (_: Throwable) {}
        }
        .setNegativeButton("Later", null).show()
}
