package com.shelfreader

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import java.io.File

/** Minimal WAV reader for the 16-bit PCM files text-to-speech engines write. */
object Wav {
    class Pcm(val rate: Int, val channels: Int, val data: ByteArray)

    private fun le16(b: ByteArray, i: Int) = (b[i].toInt() and 0xFF) or ((b[i + 1].toInt() and 0xFF) shl 8)
    private fun le32(b: ByteArray, i: Int) = le16(b, i) or (le16(b, i + 2) shl 16)

    fun read(f: File): Pcm {
        val b = f.readBytes()
        if (b.size < 44 || String(b, 0, 4, Charsets.US_ASCII) != "RIFF") throw Exception("unexpected audio format from the voice")
        var pos = 12
        var rate = 0
        var ch = 1
        var bits = 16
        while (pos + 8 <= b.size) {
            val id = String(b, pos, 4, Charsets.US_ASCII)
            val size = le32(b, pos + 4)
            val body = pos + 8
            if (id == "fmt " && body + 16 <= b.size) {
                ch = le16(b, body + 2)
                rate = le32(b, body + 4)
                bits = le16(b, body + 14)
            } else if (id == "data") {
                if (bits != 16) throw Exception("unsupported audio format ($bits-bit)")
                if (rate <= 0) throw Exception("audio has no sample rate")
                val end = if (size <= 0 || body + size > b.size) b.size else body + size
                return Pcm(rate, maxOf(1, ch), b.copyOfRange(body, end))
            }
            if (size < 0) break
            pos = body + size + (size and 1)
        }
        throw Exception("no audio data from the voice")
    }
}

/** Encodes 16-bit PCM to AAC in an .m4a file. */
class AacWriter(path: String, val sampleRate: Int, val channels: Int) {
    private val codec: MediaCodec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
    private val muxer = MediaMuxer(path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
    private val info = MediaCodec.BufferInfo()
    private var track = -1
    private var started = false
    private var samples = 0L
    private val frame = 2 * channels

    init {
        val f = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, sampleRate, channels)
        f.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
        f.setInteger(MediaFormat.KEY_BIT_RATE, 64_000 * channels)
        f.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 64 * 1024)
        codec.configure(f, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        codec.start()
    }

    fun write(pcm: ByteArray) {
        val len = pcm.size - pcm.size % frame
        var off = 0
        while (off < len) {
            val idx = codec.dequeueInputBuffer(10_000)
            if (idx >= 0) {
                val buf = codec.getInputBuffer(idx)!!
                buf.clear()
                var n = minOf(buf.remaining(), len - off)
                n -= n % frame
                buf.put(pcm, off, n)
                codec.queueInputBuffer(idx, 0, n, samples * 1_000_000L / sampleRate, 0)
                samples += (n / frame).toLong()
                off += n
            }
            drain(false)
        }
    }

    fun silence(ms: Int) = write(ByteArray(sampleRate * frame * ms / 1000))

    fun finish() {
        var queued = false
        var tries = 0
        while (!queued && tries++ < 500) {
            val idx = codec.dequeueInputBuffer(10_000)
            if (idx >= 0) {
                codec.queueInputBuffer(idx, 0, 0, samples * 1_000_000L / sampleRate, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                queued = true
            } else {
                drain(false)
            }
        }
        drain(true)
        codec.stop()
        codec.release()
        if (started) muxer.stop()
        muxer.release()
    }

    private fun drain(untilEos: Boolean) {
        var idle = 0
        while (true) {
            val idx = codec.dequeueOutputBuffer(info, if (untilEos) 10_000 else 0)
            when {
                idx == MediaCodec.INFO_TRY_AGAIN_LATER -> {
                    if (!untilEos || ++idle > 300) return
                }
                idx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                    track = muxer.addTrack(codec.outputFormat)
                    muxer.start()
                    started = true
                }
                idx >= 0 -> {
                    val out = codec.getOutputBuffer(idx)!!
                    if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) info.size = 0
                    if (info.size > 0 && started) {
                        out.position(info.offset)
                        out.limit(info.offset + info.size)
                        muxer.writeSampleData(track, out, info)
                    }
                    codec.releaseOutputBuffer(idx, false)
                    if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) return
                }
            }
        }
    }
}
