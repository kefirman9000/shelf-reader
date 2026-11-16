package com.shelfreader

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaDescription
import android.media.MediaMetadata
import android.media.browse.MediaBrowser
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.view.KeyEvent
import android.service.media.MediaBrowserService
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener

/**
 * Reads the current book aloud, sentence by sentence, as a foreground media service so it
 * keeps going with the screen off. Controls: notification, lock screen, headphones, the
 * home-screen widget, and Android Auto (via MediaBrowserService).
 */
class TtsService : MediaBrowserService(), TextToSpeech.OnInitListener {

    companion object {
        const val ACTION_PLAY = "com.shelfreader.PLAY"
        const val ACTION_TOGGLE = "com.shelfreader.TOGGLE"
        const val ACTION_PAUSE = "com.shelfreader.PAUSE"
        const val ACTION_NEXT = "com.shelfreader.NEXT"
        const val ACTION_PREV = "com.shelfreader.PREV"
        const val ACTION_STOP = "com.shelfreader.STOP"
        const val ACTION_SEEK = "com.shelfreader.SEEK"
        const val ACTION_SLEEP = "com.shelfreader.SLEEP"
        const val ACTION_NOOP = "com.shelfreader.NOOP"
        const val EXTRA_BOOK = "book"
        const val EXTRA_INDEX = "index"
        const val EXTRA_OFFSET = "offset"
        const val EXTRA_MINUTES = "minutes"
        private const val CHANNEL = "reading"
        private const val NOTIF_ID = 1

        @Volatile var instance: TtsService? = null
        @Volatile var listener: (() -> Unit)? = null
    }

    var bookId: String? = null; private set
    private var title = ""
    private var author = ""
    var paras: List<String> = emptyList(); private set
    var chapters: List<Chapter> = emptyList(); private set
    private var segs: List<Seg> = emptyList()
    private var headers: Set<String> = emptySet()
    private var mergedSubs: Set<Int> = emptySet()
    private var metaChapter = -2
    private var segIndex = 0
    var playing = false; private set

    /** Paragraph currently being read. */
    val index: Int get() = segs.getOrNull(segIndex)?.para ?: 0
    fun currentSeg(): Seg? = segs.getOrNull(segIndex)

    private var tts: TextToSpeech? = null
    private var ready = false
    private var speaker: Speaker? = null
    private var gen = 0
    private var queuedUpTo = -1
    private var segStartedAt = 0L
    private var lastSpoken = -1
    private var foreground = false
    private var lastNotifKey = ""
    private var warnedVoice: String? = null

    private var sleepDeadline = 0L
    private var sleepAtChapterEnd = false

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

    /** Resumes reading when headphones connect (while the book is paused, not stopped). */
    private var deviceEventsReady = false
    private val deviceCallback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>?) {
            if (!deviceEventsReady || playing || bookId == null) return
            if (!Settings.resumeOnHeadphones(this@TtsService)) return
            val headphones = addedDevices?.any {
                it.isSink && it.type in setOf(
                    AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
                    AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, AudioDeviceInfo.TYPE_USB_HEADSET,
                    AudioDeviceInfo.TYPE_BLE_HEADSET
                )
            } ?: false
            if (headphones) main.postDelayed({ if (!playing && bookId != null) play() }, 1500)
        }
    }

    private val sleepTick = object : Runnable {
        override fun run() {
            if (sleepDeadline == 0L) return
            if (SystemClock.elapsedRealtime() >= sleepDeadline) {
                sleepDeadline = 0L
                if (playing) pause() else update()
            } else {
                update()
                main.postDelayed(this, 15_000)
            }
        }
    }

    /** Counts listening time for the reading stats (every 30 s while playing). */
    private val statsTick = object : Runnable {
        override fun run() {
            if (playing) try { Stats.add(this@TtsService, 0, 30) } catch (t: Throwable) {}
            main.postDelayed(this, 30_000)
        }
    }

    private var headsetTaps = 0
    private val headsetRun = Runnable {
        val n = headsetTaps; headsetTaps = 0
        when {
            n >= 3 -> seekSeconds(-15)
            n == 2 -> skipChapter(1)
            else -> if (playing) pause() else play()
        }
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
        main.postDelayed(statsTick, 30_000)
        audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        getSystemService(NotificationManager::class.java)
            .createNotificationChannel(NotificationChannel(CHANNEL, "Reading aloud", NotificationManager.IMPORTANCE_LOW))
        session = MediaSession(this, "ShelfReader").apply {
            setCallback(object : MediaSession.Callback() {
                override fun onPlay() = play()
                override fun onPause() = pause()
                // next / previous track = chapters; fast-forward / rewind = 30 / 15 seconds
                override fun onSkipToNext() = skipChapter(1)
                override fun onSkipToPrevious() = skipChapter(-1)
                override fun onFastForward() = seekSeconds(30)
                override fun onRewind() = seekSeconds(-15)
                override fun onStop() = stopAll()
                override fun onCustomAction(action: String, extras: Bundle?) {
                    when (action) { "back15" -> seekSeconds(-15); "fwd30" -> seekSeconds(30); "repeat" -> repeatSentence() }
                }
                // headset button: 1 press = play/pause, 2 = next chapter, 3 = back 15 seconds
                override fun onMediaButtonEvent(mediaButtonIntent: Intent): Boolean {
                    @Suppress("DEPRECATION")
                    val ev = mediaButtonIntent.getParcelableExtra<KeyEvent>(Intent.EXTRA_KEY_EVENT) ?: return super.onMediaButtonEvent(mediaButtonIntent)
                    if (ev.keyCode != KeyEvent.KEYCODE_HEADSETHOOK && ev.keyCode != KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE) return super.onMediaButtonEvent(mediaButtonIntent)
                    if (ev.action != KeyEvent.ACTION_DOWN || ev.repeatCount > 0) return true
                    headsetTaps++
                    main.removeCallbacks(headsetRun)
                    main.postDelayed(headsetRun, 450)
                    return true
                }
                override fun onPlayFromMediaId(mediaId: String?, extras: Bundle?) {
                    if (mediaId == null) return
                    if (mediaId != bookId && !load(mediaId)) return
                    play()
                }
            })
            isActive = true
        }
        sessionToken = session.sessionToken
        val filter = IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY)
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(noisyReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        else registerReceiver(noisyReceiver, filter)
        tts = TextToSpeech(this, this)
        audioManager.registerAudioDeviceCallback(deviceCallback, main)
        main.postDelayed({ deviceEventsReady = true }, 3000)   // ignore devices already connected
    }

    // ---------- Android Auto / media browser ----------

    override fun onGetRoot(clientPackageName: String, clientUid: Int, rootHints: Bundle?): MediaBrowserService.BrowserRoot =
        MediaBrowserService.BrowserRoot("root", null)

    override fun onLoadChildren(parentId: String, result: MediaBrowserService.Result<MutableList<MediaBrowser.MediaItem>>) {
        val items = Library.load(this).sortedByDescending { it.added }.map { b ->
            MediaBrowser.MediaItem(
                MediaDescription.Builder()
                    .setMediaId(b.id)
                    .setTitle(b.title)
                    .setSubtitle("${b.author.ifBlank { "Unknown author" }} · ${Library.percent(this, b)}%")
                    .build(),
                MediaBrowser.MediaItem.FLAG_PLAYABLE
            )
        }.toMutableList()
        result.sendResult(items)
    }

    // ---------- lifecycle ----------

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
            if (playing) speakFrom(segIndex)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val i = intent ?: Intent()
        val action = i.action
        when (action) {
            ACTION_PLAY, ACTION_SEEK -> {
                val id = i.getStringExtra(EXTRA_BOOK)
                if (id != null && id != bookId) load(id)
                if (bookId == null) loadLast()
                if (i.hasExtra(EXTRA_INDEX) && segs.isNotEmpty()) {
                    segIndex = segFor(i.getIntExtra(EXTRA_INDEX, 0), i.getIntExtra(EXTRA_OFFSET, 0))
                    savePos()
                }
            }
            ACTION_SLEEP -> {
                val id = i.getStringExtra(EXTRA_BOOK)
                if (id != null && bookId == null) load(id)
            }
            ACTION_TOGGLE, ACTION_NEXT, ACTION_PREV -> if (bookId == null) loadLast()
        }
        startForegroundCompat()
        when (action) {
            ACTION_PLAY -> play()
            ACTION_SEEK -> if (playing && ready) speakFrom(segIndex) else update()
            ACTION_TOGGLE -> if (playing) pause() else play()
            ACTION_PAUSE -> pause()
            ACTION_NEXT -> skip(1)
            ACTION_PREV -> skip(-1)
            ACTION_SLEEP -> setSleep(i.getIntExtra(EXTRA_MINUTES, 0))
            ACTION_STOP -> stopAll()
        }
        if (bookId == null && action != ACTION_STOP) stopAll()
        return START_NOT_STICKY
    }

    private fun loadLast(): Boolean = Settings.lastBook(this)?.let { load(it) } ?: false

    private fun load(id: String): Boolean {
        val b = Library.get(this, id) ?: return false
        val d = try { Library.doc(this, b) } catch (t: Throwable) { return false }
        gen++
        tts?.stop()
        paras = d.paras
        chapters = d.chapters
        segs = Speech.segments(paras)
        headers = SpeechText.headerLines(paras, b.title, b.author)
        mergedSubs = SpeechText.mergedSubtitles(paras, chapters)
        metaChapter = -2
        bookId = id
        title = b.title
        author = b.author
        Settings.setLastBook(this, id)
        segIndex = segFor(Library.position(this, id), Library.offset(this, id))
        lastNotifKey = ""
        applySettings(false)
        updateMetadata()
        return true
    }

    /** Lock screen, car and headset show the chapter, with the book underneath, and the cover. */
    private fun updateMetadata() {
        val ci = chapterIndexOf(index)
        if (ci == metaChapter) return
        metaChapter = ci
        val ch = if (ci >= 0) chapters[ci].title else null
        val b = bookId?.let { Library.get(this, it) }
        val m = MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, ch ?: title)
            .putString(MediaMetadata.METADATA_KEY_ARTIST, if (ch != null) title else author)
            .putString(MediaMetadata.METADATA_KEY_ALBUM, author.ifBlank { title })
            .putString(MediaMetadata.METADATA_KEY_DISPLAY_TITLE, ch ?: title)
            .putString(MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE, if (ch != null) "$title · ${author}".trimEnd(' ', '·') else author)
        val art = try { b?.let { Covers.get(this, it) { metaChapter = -2; main.post { updateMetadata() } } } } catch (t: Throwable) { null }
        if (art != null) m.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, art)
        session.setMetadata(m.build())
    }

    /** Again: the sentence being read (or the one before, if it only just started). */
    fun repeatSentence() {
        if (segs.isEmpty()) return
        val justStarted = playing && SystemClock.elapsedRealtime() - segStartedAt < 1500
        segIndex = (if (playing && !justStarted) segIndex else segIndex - 1).coerceIn(0, segs.size - 1)
        savePos()
        if (playing && ready) speakFrom(segIndex)
        update()
    }

    /** Jumps to a paragraph (used by search, the Go to dialog and Up next). */
    fun jumpTo(para: Int) {
        if (segs.isEmpty()) return
        segIndex = segFor(para.coerceIn(0, paras.size - 1))
        savePos()
        if (playing && ready) speakFrom(segIndex)
        update()
    }

    /** First sentence of [para] that contains or follows character [off]. */
    private fun segFor(para: Int, off: Int = 0): Int {
        if (segs.isEmpty()) return 0
        var lo = 0
        var hi = segs.size - 1
        while (lo < hi) {
            val mid = (lo + hi) / 2
            if (segs[mid].para < para) lo = mid + 1 else hi = mid
        }
        var k = lo
        while (k + 1 < segs.size && segs[k].para == para && segs[k + 1].para == para && segs[k].end <= off) k++
        return k
    }

    private fun savePos() {
        val id = bookId ?: return
        val s = segs.getOrNull(segIndex) ?: return
        Library.setPosition(this, id, s.para, s.start)
    }

    fun chapterIndexOf(para: Int): Int {
        var r = -1
        for ((k, c) in chapters.withIndex()) { if (c.para <= para) r = k else break }
        return r
    }

    // ---------- playback ----------

    fun play() {
        if (segs.isEmpty() && !loadLast()) return
        if (segs.isEmpty()) return
        ensureForeground()
        playing = true
        if (!requestFocus()) { playing = false; update(); return }
        acquireWake()
        if (ready) speakFrom(segIndex)
        update()
    }

    fun pause() {
        playing = false
        gen++
        tts?.stop()
        releaseWake()
        update()
    }

    /** Moves by whole paragraphs. "Back" first returns to the start of the current paragraph. */
    fun skip(delta: Int) {
        if (segs.isEmpty()) return
        val cur = segs[segIndex]
        val target = if (delta < 0 && segIndex > 0 && segs[segIndex - 1].para == cur.para) cur.para
        else (cur.para + delta).coerceIn(0, paras.size - 1)
        segIndex = segFor(target)
        savePos()
        if (playing && ready) speakFrom(segIndex)
        update()
    }

    /** Jumps roughly [seconds] of listening forward or back (estimated from text length and speed). */
    fun seekSeconds(seconds: Int) {
        if (segs.isEmpty()) return
        val chars = (kotlin.math.abs(seconds) * 15 * Settings.rateFor(this, bookId)).toInt()
        var k = segIndex
        var acc = 0
        if (seconds < 0) {
            while (k > 0 && acc < chars) { k--; acc += segs[k].end - segs[k].start }
        } else {
            while (k < segs.size - 1 && acc < chars) { acc += segs[k].end - segs[k].start; k++ }
        }
        segIndex = k
        savePos()
        if (playing && ready) speakFrom(segIndex)
        update()
    }

    /** Next / previous chapter. "Previous" first restarts the current chapter if you're well into it. */
    fun skipChapter(delta: Int) {
        if (segs.isEmpty()) return
        if (chapters.isEmpty()) { skip(delta * 10); return }
        val ci = chapterIndexOf(index)
        val target = if (delta < 0) {
            val start = if (ci >= 0) segFor(chapters[ci].para) else 0
            if (ci >= 0 && segIndex - start > 3) ci else ci - 1
        } else ci + 1
        if (target >= chapters.size) return
        segIndex = if (target < 0) 0 else segFor(chapters[target].para)
        savePos()
        if (playing && ready) speakFrom(segIndex)
        update()
    }

    fun currentSegText(): String? = segs.getOrNull(segIndex)?.let { paras[it.para].substring(it.start, it.end) }

    fun chapterTitle(): String? = chapterIndexOf(index).let { if (it >= 0) chapters[it].title else null }
    fun bookTitle(): String = title

    fun stopAll() {
        if (playing) pause()
        setSleep(0)
        abandonFocus()
        stopForeground(STOP_FOREGROUND_REMOVE)
        foreground = false
        stopSelf()
    }

    /** Re-reads voice, speed, pronunciation and clutter settings; restarts the sentence if asked. */
    fun applySettings(restart: Boolean) {
        speaker = Speaker(this)
        val t = tts ?: return
        if (!ready) return
        t.setSpeechRate(Settings.rateFor(this, bookId))
        val wanted = Settings.voiceFor(this, bookId)
        val used = VoiceNames.apply(t, wanted)
        if (wanted != null && used == null && warnedVoice != wanted) {
            warnedVoice = wanted
            toast("That voice isn't available on this phone right now (it may need downloading, or internet), so the default voice is being used.")
        }
        if (restart && playing) speakFrom(segIndex)
    }

    fun engine(): TextToSpeech? = if (ready) tts else null

    private fun segText(k: Int): String {
        val s = segs[k]
        return paras[s.para].substring(s.start, s.end)
    }

    private fun speakFrom(si: Int) {
        val t = tts ?: return
        gen++
        t.stop()
        segIndex = si.coerceIn(0, maxOf(0, segs.size - 1))
        queuedUpTo = segIndex - 1
        lastSpoken = -1
        fill(true)
    }

    /** Keeps a few sentences queued ahead so there are no gaps between them. */
    private fun fill(first: Boolean) {
        val t = tts ?: return
        val sp = speaker ?: Speaker(this).also { speaker = it }
        var mode = if (first) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD
        var spoke = false
        val natural = Settings.naturalPauses(this)
        val rate = Settings.rateFor(this, bookId)
        while (queuedUpTo < segs.size - 1 && (queuedUpTo < segIndex + 4 || (first && !spoke))) {
            val k = ++queuedUpTo
            val (items, lastK) = itemsFor(k, sp, natural) ?: continue
            queuedUpTo = lastK
            if (natural) t.setSpeechRate(rate * SpeechText.paceFor(segs[k].para))
            for ((j, it) in items.withIndex()) {
                val last = j == items.size - 1
                t.speak(it.text, mode, null, if (last) "$gen:$lastK:e" else "$gen:$k:$j")
                mode = TextToSpeech.QUEUE_ADD
                val gap = if (natural) gapAfter(lastK, it.gapMs, last) else 0
                if (gap > 30) t.playSilentUtterance(gap.toLong(), TextToSpeech.QUEUE_ADD, "$gen:$lastK:p$j")
            }
            spoke = true
            lastSpoken = lastK
        }
        if (natural) t.setSpeechRate(rate)
        if (first && !spoke) finished()
    }

    /** What to say for sentence [k]: chapter headings announced like an audiobook, clause pieces with pauses. */
    private fun clutter(pi: Int): Boolean {
        val p = paras[pi]
        return Settings.skipClutter(this) && (pi in mergedSubs || SpeechText.isHeader(headers, p) || SpeechText.isPageNumber(p))
    }

    /** What to say for sentence [k] (and the index of the last sentence used): chapter headings announced like an
     *  audiobook, lines broken mid-sentence joined back together, clause pieces with pauses. */
    private fun itemsFor(k: Int, sp: Speaker, natural: Boolean): Pair<List<SpeechText.Piece>, Int>? {
        val s = segs[k]
        val p = paras[s.para]
        if (clutter(s.para)) return null
        val ci = chapterIndexOf(s.para)
        if (natural && ci >= 0 && chapters[ci].para == s.para && SpeechText.isHeadingOf(p, chapters[ci].title)) {
            return if (s.start == 0) SpeechText.chapterOpening(chapters[ci].title) to k else null
        }
        var text = sp.spoken(segText(k)) ?: return null
        // the sentence runs on into the next line(s): read it as one
        var last = k
        val fixLines = Settings.fixBrokenLines(this)
        while (fixLines) {
            val cur = segs[last]
            if (cur.end < paras[cur.para].trimEnd().length) break
            var j = last + 1
            while (j < segs.size && segs[j].para != cur.para && clutter(segs[j].para)) j++
            if (j >= segs.size || segs[j].start != 0 || segs[j].para == cur.para) break
            if (!SpeechText.continues(paras[cur.para], paras[segs[j].para])) break
            val more = sp.spoken(segText(j)) ?: break
            text = SpeechText.joinText(text, more)
            last = j
            if (text.length > 1500) break
        }
        return (if (natural) SpeechText.pieces(text) else listOf(SpeechText.Piece(text, 0))) to last
    }

    /** Pause after a piece: by punctuation, plus more at paragraph and chapter ends; shorter at higher speeds. */
    private fun gapAfter(k: Int, base: Int, endOfSentence: Boolean): Int {
        var g = base
        if (endOfSentence) {
            val nx = segs.getOrNull(k + 1)
            if (nx != null && nx.para != segs[k].para) g += 260
            if (nx != null && chapterIndexOf(nx.para) != chapterIndexOf(segs[k].para)) g += 900
        }
        val rate = Settings.rateFor(this, bookId).coerceAtLeast(0.5f)
        return SpeechText.vary(((g / rate) - 150).toInt())
    }

    private fun finished() {
        val id = bookId
        var done = false
        if (id != null && segs.isNotEmpty() && segIndex >= segs.size - 3) {
            Collections.add(this, id, Collections.FINISHED)
            Collections.set(this, id, Collections.of(this, id) - Collections.WANT)
            Library.get(this, id)?.let { Stats.finished(this, it) }
            done = true
        }
        playing = false
        releaseWake()
        update()
        // Up next: start the next book in the queue
        val q = Settings.queue(this).filter { it != id && Library.get(this, it) != null }
        if (done && q.isNotEmpty()) {
            val next = q.first()
            Settings.setQueue(this, q.drop(1))
            val name = Library.get(this, next)?.title ?: ""
            toast("Finished. Up next: $name")
            main.postDelayed({ if (!playing && load(next)) play() }, 4000)
        }
    }

    private fun parse(id: String?): Pair<Int, Int>? {
        val parts = id?.split(":") ?: return null
        if (parts.size < 2) return null
        val g = parts[0].toIntOrNull() ?: return null
        val k = parts[1].toIntOrNull() ?: return null
        return g to k
    }

    private val progressListener = object : UtteranceProgressListener() {
        override fun onStart(utteranceId: String?) {
            main.post {
                val (g, k) = parse(utteranceId) ?: return@post
                if (g != gen) return@post
                if (segIndex != k || utteranceId?.endsWith(":0") == true) segStartedAt = SystemClock.elapsedRealtime()
                segIndex = k
                savePos()
                fill(false)
                update()
                updateMetadata()
            }
        }

        override fun onDone(utteranceId: String?) {
            main.post {
                val (g, k) = parse(utteranceId) ?: return@post
                if (g != gen) return@post
                if (utteranceId?.endsWith(":e") != true) return@post   // only act when a whole sentence is done
                val next = k + 1
                if (sleepAtChapterEnd && next < segs.size &&
                    chapterIndexOf(segs[next].para) != chapterIndexOf(segs[k].para)
                ) {
                    sleepAtChapterEnd = false
                    segIndex = next
                    savePos()
                    pause()
                    return@post
                }
                if (k == lastSpoken && queuedUpTo >= segs.size - 1) {
                    segIndex = k
                    finished()
                }
            }
        }

        @Deprecated("Deprecated in Java")
        override fun onError(utteranceId: String?) = handleError(utteranceId)

        override fun onError(utteranceId: String?, errorCode: Int) = handleError(utteranceId)

        private fun handleError(utteranceId: String?) {
            main.post {
                val (g, k) = parse(utteranceId) ?: return@post
                if (g != gen || !playing) return@post
                if (k + 1 < segs.size) speakFrom(k + 1) else finished()
            }
        }
    }

    // ---------- sleep timer ----------

    /** minutes > 0: stop after that long; -1: at end of chapter; 0: off. */
    fun setSleep(minutes: Int) {
        main.removeCallbacks(sleepTick)
        sleepDeadline = 0L
        sleepAtChapterEnd = false
        if (minutes > 0) {
            sleepDeadline = SystemClock.elapsedRealtime() + minutes * 60_000L
            main.postDelayed(sleepTick, 15_000)
        } else if (minutes < 0) {
            sleepAtChapterEnd = true
        }
        update()
    }

    fun sleepText(): String? = when {
        sleepAtChapterEnd -> "sleep at chapter end"
        sleepDeadline > 0L -> {
            val left = ((sleepDeadline - SystemClock.elapsedRealtime()) / 60_000L + 1).coerceAtLeast(1)
            "sleep in $left min"
        }
        else -> null
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

    // ---------- notification / widget ----------

    private fun ensureForeground() {
        if (foreground) return
        try {
            startForegroundService(Intent(this, TtsService::class.java).setAction(ACTION_NOOP))
        } catch (t: Throwable) { /* not allowed right now; playback still works while bound */ }
    }

    private fun statusLine(): String {
        val pct = if (paras.isNotEmpty()) (index + 1) * 100 / paras.size else 0
        val ch = chapterIndexOf(index).let { if (it >= 0) chapters[it].title else null }
        val parts = ArrayList<String>()
        parts += if (playing) "Reading" else "Paused"
        if (ch != null) parts += ch
        parts += "$pct%"
        sleepText()?.let { parts += it }
        return parts.joinToString(" · ")
    }

    private fun update() {
        val actions = PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE or
            PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SKIP_TO_PREVIOUS or PlaybackState.ACTION_STOP or
            PlaybackState.ACTION_PLAY_FROM_MEDIA_ID or PlaybackState.ACTION_FAST_FORWARD or PlaybackState.ACTION_REWIND
        session.setPlaybackState(
            PlaybackState.Builder()
                .setActions(actions)
                // buttons for Android Auto and some lock screens
                .addCustomAction(PlaybackState.CustomAction.Builder("back15", "Back 15 seconds", android.R.drawable.ic_media_rew).build())
                .addCustomAction(PlaybackState.CustomAction.Builder("fwd30", "Forward 30 seconds", android.R.drawable.ic_media_ff).build())
                .setState(if (playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED, index.toLong(), 1f)
                .build()
        )
        val line = statusLine()
        val key = "$bookId|$line"
        if (key != lastNotifKey && bookId != null) {
            lastNotifKey = key
            if (foreground) getSystemService(NotificationManager::class.java).notify(NOTIF_ID, buildNotification(line))
            ShelfWidget.push(this, title, line, playing)
        }
        listener?.invoke()
    }

    private fun startForegroundCompat() {
        val n = buildNotification(statusLine())
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        else startForeground(NOTIF_ID, n)
        foreground = true
    }

    private fun buildNotification(line: String): Notification {
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

        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_notif)
            .setContentTitle(title.ifBlank { "Shelf Reader" })
            .setContentText(line)
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
        main.removeCallbacks(sleepTick)
        main.removeCallbacks(statsTick)
        try { audioManager.unregisterAudioDeviceCallback(deviceCallback) } catch (e: Throwable) {}
        try { unregisterReceiver(noisyReceiver) } catch (e: Throwable) {}
        tts?.stop()
        tts?.shutdown()
        tts = null
        session.release()
        releaseWake()
        abandonFocus()
        val wasBook = bookId != null
        playing = false
        if (wasBook) ShelfWidget.push(this, title, "Paused", false)
        listener?.invoke()
        super.onDestroy()
    }
}
