package com.shelfreader

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews

/** Home-screen widget: current book, status, and back / play-pause / next buttons. */
class ShelfWidget : AppWidgetProvider() {

    override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
        val svc = TtsService.instance
        if (svc != null && svc.bookId != null) return  // the service keeps it fresh
        val title = Settings.lastBook(context)?.let { Library.get(context, it)?.title } ?: "Shelf Reader"
        push(context, title, if (title == "Shelf Reader") "Open a book to start" else "Tap ▶ to resume", false)
    }

    companion object {
        fun push(ctx: Context, title: String, status: String, playing: Boolean) {
            try {
                val mgr = AppWidgetManager.getInstance(ctx)
                val cn = ComponentName(ctx, ShelfWidget::class.java)
                if (mgr.getAppWidgetIds(cn).isEmpty()) return
                val v = RemoteViews(ctx.packageName, R.layout.widget)
                v.setTextViewText(R.id.w_title, title)
                v.setTextViewText(R.id.w_status, status)
                v.setImageViewResource(
                    R.id.w_play,
                    if (playing) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play
                )
                val flags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
                fun svc(action: String, code: Int) = PendingIntent.getForegroundService(
                    ctx, 100 + code, Intent(ctx, TtsService::class.java).setAction(action), flags
                )
                v.setOnClickPendingIntent(R.id.w_prev, svc(TtsService.ACTION_PREV, 1))
                v.setOnClickPendingIntent(R.id.w_play, svc(TtsService.ACTION_TOGGLE, 2))
                v.setOnClickPendingIntent(R.id.w_next, svc(TtsService.ACTION_NEXT, 3))
                val last = Settings.lastBook(ctx)
                val open = if (last != null) Intent(ctx, ReaderActivity::class.java).putExtra("book", last)
                else Intent(ctx, MainActivity::class.java)
                v.setOnClickPendingIntent(R.id.w_open, PendingIntent.getActivity(ctx, 110, open, flags))
                mgr.updateAppWidget(cn, v)
            } catch (t: Throwable) { /* widget updates are best-effort */ }
        }
    }
}
