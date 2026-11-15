package com.shelfreader

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener

/**
 * Reads the current book aloud as a foreground media service, so it keeps going
 * with the screen off or another app open. Controls live in the notification,
 * on the lock screen, and on headphone buttons.
 */
class TtsService : Service(), TextToSpeech.OnInitListener {

    companion object {
        const val ACTION_PLAY = "com.shelfreader.PLAY"
        const val ACTION_TOGGLE = "com.shelfreader.TOGGLE"
        const val ACTION_PAUSE = "com.shelfreader.PAUSE"
        const val ACTION_NEXT = "com.shelfreader.NEXT"
        const val ACTION_PREV = "com.shelfreader.PREV"
        const val ACTION_STOP = "com.shelfreader.STOP"
        const val EXTRA_BOOK = "book"
        const val EXTRA_INDEX = "index"
        private const val CHANNEL = "reading"
        private const val NOTIF_ID = 1

        @Volatile var instance: TtsService? = null
        @Volatile var listener: (() -> Unit)? = null
    }

    var bookId: String? = null; private set
    private var title = ""
    private var author = ""
    var paras: List<String> = emptyList(); private set
    var index = 0; private set
    var playing = false; private set

    private var tts: TextToSpeech? = null
    private var ready = false
    private var gen = 0
    private var queuedUpTo = -1
    private val main = Handler(Looper.getMainLooper())
    private lateinit var session: MediaSession
    private var wakeLock: PowerManager.WakeLock? = null
    private lateinit var audioManager: AudioManager
    private var focusRequest: AudioFocusRequest? = null
    private var resumeOnFocusGain = false

    private val attrs = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()

    private val noisyReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == AudioManager.ACTION_AUDIO_BECOMING_NOISY && playing) pause()
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Reading aloud", NotificationManager.IMPORTANCE_LOW))
        session = MediaSession(this, "ShelfReader").apply {
            setCallback(object : MediaSession.Callback() {
                override fun onPlay() = play()
                override fun onPause() = pause()
                override fun onSkipToNext() = skip(1)
                override fun onSkipToPrevious() = skip(-1)
                override fun onStop() = stopAll()
            })
            isActive = true
        }
        val filter = IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY)
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(noisyReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        else registerReceiver(noisyReceiver, filter)
        tts = TextToSpeech(this, this)
    }

    override fun onInit(status: Int) {
        main.post {
            val t = tts ?: return@post
            if (status != TextToSpeech.SUCCESS) {
                toast("No text-to-speech engine available. Install “Speech Services by Google” from the Play Store.")
                playing = false
                update()
                return@post
            }
            ready = true
            t.setAudioAttributes(attrs)
            t.setOnUtteranceProgressListener(progressListener)
            applySettings(false)
            if (playing) speakFrom(index)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action
        if (intent != null && action == ACTION_PLAY) {
            val id = intent.getStringExtra(EXTRA_BOOK)
            if (id != null && id != bookId) load(id)
            if (intent.hasExtra(EXTRA_INDEX)) {
                index = intent.getIntExtra(EXTRA_INDEX, 0).coerceIn(0, maxOf(0, paras.size - 1))
            }
        }
        startForegroundCompat()
        when (action) {
            ACTION_PLAY -> play()
            ACTION_TOGGLE -> if (playing) pause() else play()
            ACTION_PAUSE -> pause()
            ACTION_NEXT -> skip(1)
            ACTION_PREV -> skip(-1)
            ACTION_STOP -> stopAll()
        }
        if (bookId == null && action != ACTION_STOP) stopAll()
        return START_NOT_STICKY
    }

    private fun load(id: String) {
        val b = Library.get(this, id) ?: return
        gen++
        tts?.stop()
        paras = try { Library.paragraphs(this, b) } catch (t: Throwable) { emptyList() }
        bookId = id
        title = b.title
        author = b.author
        index = Library.position(this, id).coerceIn(0, maxOf(0, paras.size - 1))
        session.setMetadata(
            MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, author)
                .build()
        )
    }

    // ---------- playback ----------

    fun play() {
        if (paras.isEmpty()) return
        playing = true
        if (!requestFocus()) { playing = false; update(); return }
        acquireWake()
        if (ready) speakFrom(index)
        update()
    }

    fun pause() {
        playing = false
        gen++
        tts?.stop()
        releaseWake()
        update()
    }

    fun skip(delta: Int) {
        if (paras.isEmpty()) return
        index = (index + delta).coerceIn(0, paras.size - 1)
        bookId?.let { Library.setPosition(this, it, index) }
        if (playing && ready) speakFrom(index)
        update()
    }

    fun stopAll() {
        if (playing) pause()
        abandonFocus()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    /** Re-reads speed and voice settings; restarts the current paragraph if asked. */
    fun applySettings(restart: Boolean) {
        val t = tts ?: return
        if (!ready) return
        t.setSpeechRate(Settings.rate(this))
        val wanted = Settings.voice(this)
        try {
            if (wanted != null) {
                t.voices?.firstOrNull { it.name == wanted }?.let { t.voice = it }
            } else {
                t.defaultVoice?.let { t.voice = it }
            }
        } catch (e: Throwable) { /* some engines throw on voice queries */ }
        if (restart && playing) speakFrom(index)
    }

    fun engine(): TextToSpeech? = if (ready) tts else null

    private fun speakFrom(i: Int) {
        val t = tts ?: return
        if (i >= paras.size) { finished(); return }
        gen++
        queuedUpTo = i - 1
        enqueue(i, TextToSpeech.QUEUE_FLUSH)
        enqueue(i + 1, TextToSpeech.QUEUE_ADD)
        enqueue(i + 2, TextToSpeech.QUEUE_ADD)
    }

    private fun enqueue(i: Int, mode: Int) {
        val t = tts ?: return
        if (i >= paras.size) return
        t.speak(paras[i], mode, null, "$gen:$i")
        if (i > queuedUpTo) queuedUpTo = i
    }

    private fun finished() {
        playing = false
        releaseWake()
        update()
    }

    private fun parse(id: String?): Pair<Int, Int>? {
        val parts = id?.split(":") ?: return null
        if (parts.size != 2) return null
        val g = parts[0].toIntOrNull() ?: return null
        val i = parts[1].toIntOrNull() ?: return null
        return g to i
    }

    private val progressListener = object : UtteranceProgressListener() {
        override fun onStart(utteranceId: String?) {
            main.post {
                val (g, i) = parse(utteranceId) ?: return@post
                if (g != gen) return@post
                index = i
                bookId?.let { Library.setPosition(this@TtsService, it, i) }
                while (queuedUpTo < i + 2 && queuedUpTo + 1 < paras.size) enqueue(queuedUpTo + 1, TextToSpeech.QUEUE_ADD)
                update()
            }
        }

        override fun onDone(utteranceId: String?) {
            main.post {
                val (g, i) = parse(utteranceId) ?: return@post
                if (g != gen) return@post
                if (i >= paras.size - 1) {
                    index = paras.size - 1
                    finished()
                }
            }
        }

        @Deprecated("Deprecated in Java")
        override fun onError(utteranceId: String?) = handleError(utteranceId)

        override fun onError(utteranceId: String?, errorCode: Int) = handleError(utteranceId)

        private fun handleError(utteranceId: String?) {
            main.post {
                val (g, i) = parse(utteranceId) ?: return@post
                if (g != gen || !playing) return@post
                if (i + 1 < paras.size) { index = i + 1; speakFrom(index) } else finished()
            }
        }
    }

    // ---------- audio focus / wake lock ----------

    private fun requestFocus(): Boolean {
        val req = focusRequest ?: AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(attrs)
            .setOnAudioFocusChangeListener({ change ->
                when (change) {
                    AudioManager.AUDIOFOCUS_LOSS -> { resumeOnFocusGain = false; if (playing) pause() }
                    AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,
                    AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> if (playing) { resumeOnFocusGain = true; pause() }
                    AudioManager.AUDIOFOCUS_GAIN -> if (resumeOnFocusGain) { resumeOnFocusGain = false; play() }
                }
            }, main)
            .build().also { focusRequest = it }
        return audioManager.requestAudioFocus(req) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    }

    private fun abandonFocus() {
        focusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
    }

    private fun acquireWake() {
        if (wakeLock?.isHeld == true) return
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ShelfReader:reading").apply {
            setReferenceCounted(false)
            acquire(6 * 60 * 60 * 1000L)
        }
    }

    private fun releaseWake() {
        if (wakeLock?.isHeld == true) wakeLock?.release()
    }

    // ---------- notification ----------

    private fun update() {
        val actions = PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE or
            PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SKIP_TO_PREVIOUS or PlaybackState.ACTION_STOP
        session.setPlaybackState(
            PlaybackState.Builder()
                .setActions(actions)
                .setState(if (playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED, index.toLong(), 1f)
                .build()
        )
        if (bookId != null) {
            getSystemService(NotificationManager::class.java).notify(NOTIF_ID, buildNotification())
        }
        listener?.invoke()
    }

    private fun startForegroundCompat() {
        val n = buildNotification()
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        else startForeground(NOTIF_ID, n)
    }

    private fun buildNotification(): Notification {
        val flags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, ReaderActivity::class.java).putExtra("book", bookId).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            flags
        )
        fun action(icon: Int, label: String, act: String, code: Int) = Notification.Action.Builder(
            Icon.createWithResource(this, icon), label,
            PendingIntent.getService(this, code, Intent(this, TtsService::class.java).setAction(act), flags)
        ).build()

        val pct = if (paras.isNotEmpty()) (index + 1) * 100 / paras.size else 0
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_notif)
            .setContentTitle(title.ifBlank { "Shelf Reader" })
            .setContentText((if (playing) "Reading" else "Paused") + " · $pct%")
            .setContentIntent(open)
            .setOngoing(playing)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .addAction(action(android.R.drawable.ic_media_previous, "Back", ACTION_PREV, 1))
            .addAction(
                if (playing) action(android.R.drawable.ic_media_pause, "Pause", ACTION_TOGGLE, 2)
                else action(android.R.drawable.ic_media_play, "Play", ACTION_TOGGLE, 2)
            )
            .addAction(action(android.R.drawable.ic_media_next, "Next", ACTION_NEXT, 3))
            .addAction(action(android.R.drawable.ic_menu_close_clear_cancel, "Stop", ACTION_STOP, 4))
            .setStyle(Notification.MediaStyle().setMediaSession(session.sessionToken).setShowActionsInCompactView(0, 1, 2))
            .build()
    }

    override fun onDestroy() {
        instance = null
        gen++
        try { unregisterReceiver(noisyReceiver) } catch (e: Throwable) {}
        tts?.stop()
        tts?.shutdown()
        tts = null
        session.release()
        releaseWake()
        abandonFocus()
        playing = false
        listener?.invoke()
        super.onDestroy()
    }
}
