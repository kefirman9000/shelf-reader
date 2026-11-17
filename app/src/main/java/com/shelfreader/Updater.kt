package com.shelfreader

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import org.json.JSONObject
import java.io.File

/** Checks this app's GitHub Releases for a newer build and installs it. */
object Updater {
    const val REPO = "kefirman9000/shelf-reader"

    data class Release(val build: Int, val url: String, val notes: String, val apiUrl: String = "")

    /** Headers for GitHub: a read-only token lets the app see releases while the repository is private. */
    fun headers(ctx: Context, asset: Boolean = false): Map<String, String> {
        val h = HashMap<String, String>()
        h["Accept"] = if (asset) "application/octet-stream" else "application/vnd.github+json"
        Settings.updateToken(ctx)?.let { h["Authorization"] = "Bearer $it" }
        return h
    }

    /**
     * The newest release for this phone's channel. Stable: the newest build that passed every test (GitHub's
     * "latest" release). Beta: the newest build of all, published as soon as it's built, before the long tests finish.
     */
    fun latest(ctx: Context): Release? {
        val j = try {
            if (Settings.betaUpdates(ctx)) {
                val list = org.json.JSONArray(Net.get("https://api.github.com/repos/$REPO/releases?per_page=10", headers(ctx)))
                (0 until list.length()).map { list.getJSONObject(it) }.firstOrNull { !it.optBoolean("draft") && hasApk(it) }
                    ?: throw Exception("404 no releases")
            } else JSONObject(Net.get("https://api.github.com/repos/$REPO/releases/latest", headers(ctx)))
        }
        catch (e: Exception) {
            val m = e.message ?: ""
            throw Exception(when {
                "404" in m && Settings.updateToken(ctx) == null -> "GitHub doesn't share updates from a private repository. Add a read-only GitHub token in Settings → Check for updates."
                "404" in m -> "GitHub found no releases with this token. Check it can read the shelf-reader repository."
                "401" in m || "403" in m -> "GitHub rejected the token. Make a new read-only one."
                else -> "Couldn't reach GitHub ($m)."
            })
        }
        val build = j.optString("tag_name").removePrefix("build-").toIntOrNull() ?: return null
        val assets = j.optJSONArray("assets") ?: return null
        for (i in 0 until assets.length()) {
            val a = assets.getJSONObject(i)
            if (a.optString("name").endsWith(".apk")) {
                return Release(build, a.getString("browser_download_url"), j.optString("body"), a.optString("url"))
            }
        }
        return null
    }

    private fun hasApk(j: JSONObject): Boolean {
        val a = j.optJSONArray("assets") ?: return false
        return (0 until a.length()).any { a.getJSONObject(it).optString("name").endsWith(".apk") }
    }

    fun currentBuild(ctx: Context): Long =
        ctx.packageManager.getPackageInfo(ctx.packageName, 0).longVersionCode

    fun install(ctx: Context, apk: File) {
        val installer = ctx.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        val id = installer.createSession(params)
        installer.openSession(id).use { s ->
            s.openWrite("ShelfReader.apk", 0, apk.length()).use { out ->
                apk.inputStream().use { it.copyTo(out) }
                s.fsync(out)
            }
            val flags = if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            else PendingIntent.FLAG_UPDATE_CURRENT
            val pi = PendingIntent.getBroadcast(ctx, 7, Intent(ctx, UpdateReceiver::class.java), flags)
            s.commit(pi.intentSender)
        }
    }
}

class UpdateReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, -999)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION")
                val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT) ?: return
                confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                try { context.startActivity(confirm) } catch (t: Throwable) { context.toast("Couldn't open the installer.") }
            }
            PackageInstaller.STATUS_SUCCESS -> {}
            else -> {
                val msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "unknown error"
                context.toast("Update not installed: $msg")
            }
        }
    }
}
