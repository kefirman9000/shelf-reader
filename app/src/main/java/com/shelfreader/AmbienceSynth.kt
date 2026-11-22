package com.shelfreader

import kotlin.math.PI
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Background sounds, made on the fly (nothing to download): rain, thunder, waves, stream, wind, fire,
 * crickets, fan and white / pink / brown noise. Same sounds and levels as the PC app
 * (desktop/ui/ambience-synth.js) — keep the two in step. No Android code here, so it can be unit tested.
 */
object AmbienceSynth {
    data class Sound(val id: String, val icon: String, val name: String)

    val SOUNDS = listOf(
        Sound("rain", "🌧", "Rain"),
        Sound("thunder", "⛈", "Distant thunder"),
        Sound("waves", "🌊", "Ocean waves"),
        Sound("stream", "🏞", "Forest stream"),
        Sound("wind", "🍃", "Wind"),
        Sound("fire", "🔥", "Crackling fire"),
        Sound("crickets", "🦗", "Night crickets"),
        Sound("fan", "🌀", "Fan"),
        Sound("white", "⚪", "White noise"),
        Sound("pink", "🌸", "Pink noise"),
        Sound("brown", "🟤", "Brown noise"),
    )

    val PRESETS = listOf(
        "Rainy night" to mapOf("rain" to 0.6f, "thunder" to 0.35f),
        "Seaside" to mapOf("waves" to 0.7f, "wind" to 0.2f),
        "By the fire" to mapOf("fire" to 0.6f, "rain" to 0.3f),
        "Summer night" to mapOf("crickets" to 0.5f, "stream" to 0.3f),
        "Focus" to mapOf("brown" to 0.5f),
    )

    /** Per-sound level so each is about as loud as the others at the same slider position. */
    val GAIN = mapOf("rain" to 0.36, "thunder" to 3.2, "waves" to 0.64, "stream" to 0.62, "wind" to 1.25, "fire" to 2.9,
        "crickets" to 1.25, "fan" to 1.4, "white" to 0.12, "pink" to 0.24, "brown" to 0.87)

    fun interface Gen { fun next(): Double }

    private class Rng(seed: Long) {
        private var s = (seed and 0xffffffffL).let { if (it == 0L) 1L else it }
        fun next(): Double {
            s = s xor ((s shl 13) and 0xffffffffL); s = s xor (s ushr 17); s = s xor ((s shl 5) and 0xffffffffL)
            return s / 4294967296.0
        }
    }

    private fun coef(fc: Double, sr: Int) = 1 - exp(-2 * PI * fc / sr)

    fun make(id: String, sr: Int, seed: Long): Gen {
        val r = Rng(seed)
        fun w() = r.next() * 2 - 1
        var p0 = 0.0; var p1 = 0.0; var p2 = 0.0
        fun pink(): Double { val x = w(); p0 = 0.99765 * p0 + x * 0.099046; p1 = 0.963 * p1 + x * 0.2965164; p2 = 0.57 * p2 + x * 1.0526913; return (p0 + p1 + p2 + x * 0.1848) * 0.25 }
        var br = 0.0
        fun brown(): Double { br = (br + 0.02 * w()) / 1.02; return br * 3.5 }
        fun sec(a: Double, b: Double) = floor((a + r.next() * (b - a)) * sr).toInt()

        return when (id) {
            "white" -> Gen { w() }
            "pink" -> Gen { pink() }
            "brown" -> Gen { brown() }
            "fan" -> {
                var l1 = 0.0; var l2 = 0.0; val a = coef(700.0, sr); val t = 2 * PI * 58 / sr; var ph = 0.0
                Gen { val x = brown() * 0.7 + pink() * 0.5; l1 += a * (x - l1); l2 += a * (l1 - l2); ph += t; l2 + sin(ph) * 0.012 }
            }
            "rain" -> {
                var hp = 0.0; var lp = 0.0; var wob = 0.0; var wobT = 0.5; var wobN = 0
                val aHp = coef(600.0, sr); val aLp = coef(6500.0, sr); val aW = coef(0.4, sr)
                val env = DoubleArray(12); val dec = DoubleArray(12); var dh = 0.0; val aDh = coef(2500.0, sr)
                Gen {
                    val x = w(); hp += aHp * (x - hp); val hiss = x - hp; lp += aLp * (hiss - lp)
                    if (--wobN <= 0) { wobT = 0.75 + r.next() * 0.35; wobN = sec(0.5, 2.0) }
                    wob += aW * (wobT - wob)
                    if (r.next() < 70.0 / sr) for (i in 0 until 12) if (env[i] < 0.001) { val a = r.next(); env[i] = 0.25 + a * a * 1.2; dec[i] = exp(-1 / (sr * (0.003 + r.next() * 0.01))); break }
                    var d = 0.0; val y = w(); dh += aDh * (y - dh); val dn = y - dh
                    for (i in 0 until 12) if (env[i] > 0.001) { d += env[i] * dn; env[i] *= dec[i] }
                    lp * 0.55 * wob + d * 0.35
                }
            }
            "thunder" -> {
                var next = sec(2.0, 6.0); var t = 0; var att = 1; var peak = 0.0; var tau = 1.0; var lp1 = 0.0; var lp2 = 0.0
                var a = coef(200.0, sr); var fl = 0.0; var flT = 1.0; var flN = 0; var bed = 0.0
                val aFl = coef(6.0, sr); val aBed = coef(70.0, sr)
                Gen {
                    if (--next <= 0) { att = sec(0.15, 0.8); t = 0; val k = r.next(); peak = 0.35 + k * 0.65; tau = (2 + r.next() * 4) * sr; a = coef(120 + k * 350, sr); next = sec(10.0, 28.0) }
                    t++
                    val lvl = if (t < att) peak * t / att else peak * exp(-(t - att) / tau)
                    if (--flN <= 0) { flT = 0.4 + r.next() * 0.6; flN = sec(0.05, 0.3) }
                    fl += aFl * (flT - fl)
                    val x = brown(); lp1 += a * (x - lp1); lp2 += a * (lp1 - lp2)
                    bed += aBed * (x - bed)
                    lp2 * lvl * fl * 2.2 + bed * 0.12
                }
            }
            "waves" -> {
                var t = 0; var per = sec(7.0, 12.0); var lp = 0.0; var lp2 = 0.0; var fl = 0.15
                Gen {
                    if (++t >= per) { t = 0; per = sec(7.0, 12.0); fl = 0.1 + r.next() * 0.1 }
                    val ph = t.toDouble() / per
                    val e = if (ph < 0.4) (ph / 0.4).pow(2) else exp(-(ph - 0.4) * 5)
                    val env = fl + (1 - fl) * e
                    val x = brown() * 0.8 + pink() * (0.3 + 1.4 * e)
                    val a = coef(250 + 3800 * e.pow(1.5), sr)
                    lp += a * (x - lp); lp2 += a * (lp - lp2)
                    lp2 * env
                }
            }
            "stream" -> {
                var hp = 0.0; var lp = 0.0; var lp2 = 0.0; var cut = 2500.0; var cutT = 2500.0; var n = 0
                val aHp = coef(350.0, sr); val aC = coef(9.0, sr)
                val f = doubleArrayOf(0.7 + r.next(), 1.3 + r.next(), 2.1 + r.next() * 2, 3.5 + r.next() * 3).map { 2 * PI * it / sr }
                val ph = doubleArrayOf(r.next() * 6, r.next() * 6, r.next() * 6, r.next() * 6)
                Gen {
                    val x = pink(); hp += aHp * (x - hp); val b = x - hp
                    if (--n <= 0) { cutT = 1200 + r.next() * 4000; n = sec(0.03, 0.15) }
                    cut += aC * (cutT - cut)
                    val a = coef(cut, sr); lp += a * (b - lp); lp2 += a * (lp - lp2)
                    var m = 0.0; for (i in 0 until 4) { ph[i] += f[i]; m += sin(ph[i]) }
                    lp2 * (0.7 + 0.075 * m)
                }
            }
            "wind" -> {
                var low = 0.0; var band = 0.0; var fc = 400.0; var fcT = 400.0; var g = 0.5; var gT = 0.5; var nf = 0; var ng = 0
                val aF = coef(0.25, sr); val aG = coef(0.4, sr)
                Gen {
                    if (--nf <= 0) { fcT = 180 + r.next() * 900; nf = sec(2.0, 5.0) }
                    if (--ng <= 0) { gT = 0.25 + r.next() * 0.75; ng = sec(1.5, 4.0) }
                    fc += aF * (fcT - fc); g += aG * (gT - g)
                    val x = brown() * 0.7 + pink() * 0.4
                    val f = 2 * sin(PI * fc / sr)
                    low += f * band; val high = x - low - 0.45 * band; band += f * high
                    band * g
                }
            }
            "fire" -> {
                var bed = 0.0; var bed2 = 0.0; var rate = 8.0; var rateT = 8.0; var nr = 0; var hp = 0.0; var pl = 0.0
                val aB = coef(180.0, sr); val aR = coef(0.8, sr); val aHp = coef(1800.0, sr); val aPl = coef(1200.0, sr)
                val env = DoubleArray(16); val dec = DoubleArray(16); val pop = BooleanArray(16)
                fun add(big: Boolean) {
                    for (i in 0 until 16) if (env[i] < 0.001) {
                        val a = r.next()
                        env[i] = if (big) 0.6 + a * 0.8 else 0.15 + a * a * a * 1.3
                        dec[i] = exp(-1 / (sr * (if (big) 0.006 + r.next() * 0.01 else 0.0005 + r.next() * 0.0025)))
                        pop[i] = big; break
                    }
                }
                Gen {
                    if (--nr <= 0) { rateT = 3 + r.next() * 25; nr = sec(0.4, 2.0) }
                    rate += aR * (rateT - rate)
                    if (r.next() < rate / sr) add(false)
                    if (r.next() < 0.5 / sr) add(true)
                    val x = brown(); bed += aB * (x - bed); bed2 += aB * (bed - bed2)
                    val y = w(); hp += aHp * (y - hp); val hn = y - hp; pl += aPl * (y - pl)
                    var c = 0.0; for (i in 0 until 16) if (env[i] > 0.001) { c += env[i] * (if (pop[i]) pl * 2.5 else hn); env[i] *= dec[i] }
                    bed2 * 0.5 + c * 0.6
                }
            }
            "crickets" -> {
                class Cr(val f: Double, var ph: Double, var next: Int, var pulse: Int, var t: Int, val pl: Int, val gap: Int, val n: Int, val v: Double, val every: Double)
                val cr = List(3) {
                    Cr(2 * PI * (4200 + r.next() * 1000) / sr, 0.0, sec(0.1, 1.2), -1, 0, floor(sr * 0.016).toInt(), floor(sr * 0.014).toInt(),
                        3 + floor(r.next() * 2).toInt(), 0.35 + r.next() * 0.65, 0.55 + r.next() * 0.5)
                }
                var bed = 0.0; val aB = coef(900.0, sr)
                Gen {
                    var s = 0.0
                    for (c in cr) {
                        if (c.pulse < 0) { if (--c.next <= 0) { c.pulse = 0; c.t = 0 } }
                        else {
                            val cyc = c.pl + c.gap
                            if (c.t < c.pl) { val e = sin(PI * c.t / c.pl); c.ph += c.f; s += sin(c.ph) * e * e * c.v }
                            if (++c.t >= cyc) { c.t = 0; if (++c.pulse >= c.n) { c.pulse = -1; c.next = floor(sr * c.every * (0.85 + r.next() * 0.3)).toInt(); if (r.next() < 0.04) c.next += sec(2.0, 5.0) } }
                        }
                    }
                    val x = pink(); bed += aB * (x - bed)
                    s * 0.18 + bed * 0.25
                }
            }
            else -> Gen { 0.0 }
        }
    }

    /** Mixes the chosen sounds; [set] can be called from any thread while another renders. */
    class Mixer(private val sr: Int) {
        private val gen = HashMap<String, Gen>()
        private val g = HashMap<String, Double>()
        @Volatile private var target: Map<String, Double> = emptyMap()
        @Volatile private var masterT = 0.0
        private var master = 0.0
        private var seed = 1234L

        /** mix: sound id → 0–1; master: 0–1. Changes fade in smoothly. */
        fun set(mix: Map<String, Float>, master: Float) {
            target = SOUNDS.associate { s -> val v = (mix[s.id] ?: 0f).toDouble().coerceIn(0.0, 1.0); s.id to v * v * (GAIN[s.id] ?: 1.0) }
            masterT = master.toDouble().coerceIn(0.0, 1.0)
        }

        /** True once faded all the way out. */
        fun silent() = master < 1e-4 && masterT == 0.0

        fun render(out: FloatArray, n: Int = out.size): Int {
            val kG = 1 - exp(-1 / (sr * 0.08)); val kM = 1 - exp(-1 / (sr * 0.6))
            val tg = target
            val act = ArrayList<String>()
            for (s in SOUNDS) {
                val t = tg[s.id] ?: 0.0
                if (t == 0.0 && (g[s.id] ?: 0.0) < 1e-4) { g[s.id] = 0.0; gen.remove(s.id); continue }
                if (s.id !in gen) gen[s.id] = make(s.id, sr, (seed++ * 2654435761L))
                act += s.id
            }
            val gens = Array(act.size) { gen[act[it]]!! }
            val gs = DoubleArray(act.size) { g[act[it]] ?: 0.0 }
            val ts = DoubleArray(act.size) { tg[act[it]] ?: 0.0 }
            val mt = masterT
            for (i in 0 until n) {
                master += kM * (mt - master)
                var x = 0.0
                for (k in gens.indices) { gs[k] += kG * (ts[k] - gs[k]); x += gens[k].next() * gs[k] }
                x *= master
                // gentle limiter
                out[i] = (if (x > 0.6) 0.6 + (x - 0.6) / sqrt(1 + ((x - 0.6) / 0.4).pow(2))
                    else if (x < -0.6) -0.6 + (x + 0.6) / sqrt(1 + ((x + 0.6) / 0.4).pow(2)) else x).toFloat()
            }
            for (k in act.indices) g[act[k]] = gs[k]
            return act.size
        }
    }
}
