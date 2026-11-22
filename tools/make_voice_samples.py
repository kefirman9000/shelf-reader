#!/usr/bin/env python3
"""Makes a short sample of every natural phone voice (Kokoro, Piper) so the app can play it
before the voice is downloaded. The voice list is read from NeuralVoices.kt, so it stays in sync.
Usage: python3 tools/make_voice_samples.py OUT_DIR   (needs: pip install sherpa-onnx; ffmpeg)"""
import os, re, subprocess, sys, tarfile, urllib.request, wave
from array import array

import sherpa_onnx

BASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/"
SRC = os.path.join(os.path.dirname(__file__), "..", "app", "src", "main", "java", "com", "shelfreader", "NeuralVoices.kt")
TEXT = {
    "en": "Hi, I'm {name}. This is how I'll sound reading your books, chapter after chapter.",
    "de": "Hallo, ich bin {name}. So klinge ich, wenn ich dir deine Bücher vorlese.",
    "es": "Hola, soy {name}. Así sonaré cuando te lea tus libros, capítulo a capítulo.",
    "fr": "Bonjour, je suis {name}. Voici comment je lirai vos livres, chapitre après chapitre.",
    "it": "Ciao, sono {name}. Ecco come suonerò leggendo i tuoi libri, capitolo dopo capitolo.",
    "pt": "Olá, eu sou {name}. É assim que vou soar lendo os seus livros, capítulo por capítulo.",
    "nl": "Hallo, ik ben {name}. Zo klink ik als ik je boeken voorlees, hoofdstuk na hoofdstuk.",
    "pl": "Cześć, jestem {name}. Tak będę brzmieć, czytając ci książki, rozdział po rozdziale.",
    "ru": "Привет, я {name}. Вот так я буду читать вам книги, главу за главой.",
    "cs": "Ahoj, jsem {name}. Takhle budu znít, když vám budu číst knihy, kapitolu po kapitole.",
    "sv": "Hej, jag heter {name}. Så här låter jag när jag läser dina böcker, kapitel för kapitel.",
    "da": "Hej, jeg hedder {name}. Sådan lyder jeg, når jeg læser dine bøger op, kapitel efter kapitel.",
    "no": "Hei, jeg heter {name}. Slik høres jeg ut når jeg leser bøkene dine, kapittel etter kapittel.",
    "tr": "Merhaba, ben {name}. Kitaplarını okurken böyle duyulacağım, bölüm bölüm.",
    "zh": "你好，我是{name}。我会这样为你朗读书籍，一章接一章。",
}


def models():
    src = open(SRC, encoding="utf-8").read()
    pat = re.compile(r'Model\("([^"]+)",\s*"[^"]*",\s*"(kokoro|piper)",\s*\d+,\s*"(\w+)",\s*"([^"]+)",\s*listOf\((.*?)\)\)', re.S)
    for mid, kind, lang, file, voices in pat.findall(src):
        yield mid, kind, lang, file, [(int(s), n) for s, n in re.findall(r'(\d+)\s+to\s+"([^"]+)"', voices)]


def main(out):
    os.makedirs(out, exist_ok=True)
    work = "/tmp/voicemodels"
    os.makedirs(work, exist_ok=True)
    for mid, kind, lang, file, voices in models():
        d = os.path.join(work, mid)
        if not os.path.isdir(d):
            arc = d + ".tar.bz2"
            print("downloading", mid, flush=True)
            urllib.request.urlretrieve(BASE + mid + ".tar.bz2", arc)
            with tarfile.open(arc) as t:
                t.extractall(work)
            os.remove(arc)
        if kind == "kokoro":
            mc = sherpa_onnx.OfflineTtsModelConfig(kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
                model=f"{d}/{file}", voices=f"{d}/voices.bin", tokens=f"{d}/tokens.txt", data_dir=f"{d}/espeak-ng-data"), num_threads=2)
        else:
            mc = sherpa_onnx.OfflineTtsModelConfig(vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                model=f"{d}/{file}", lexicon="", tokens=f"{d}/tokens.txt", data_dir=f"{d}/espeak-ng-data"), num_threads=2)
        tts = sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(model=mc, max_num_sentences=1))
        for sid, label in voices:
            name = label.split(" · ")[0]
            if name.startswith("Kokoro default"):
                name = "Kokoro"
            audio = tts.generate(TEXT.get(lang, TEXT["en"]).format(name=name), sid=sid, speed=1.0)
            wav = os.path.join(work, f"{mid}-{sid}.wav")
            with wave.open(wav, "wb") as w:
                w.setnchannels(1); w.setsampwidth(2); w.setframerate(audio.sample_rate)
                w.writeframes(array("h", (int(max(-1.0, min(1.0, x)) * 32767) for x in audio.samples)).tobytes())
            mp3 = os.path.join(out, f"{mid}-{sid}.mp3")
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", wav, "-ac", "1", "-b:a", "64k", mp3], check=True)
            os.remove(wav)
            print("made", mp3, flush=True)
        del tts


def pc_kokoro(out):
    """Samples of the PC app's Kokoro voices (a newer Kokoro with more voices), named pc-kokoro-<voice>.mp3."""
    src = open(os.path.join(os.path.dirname(__file__), "..", "desktop", "ui", "engines.js"), encoding="utf-8").read()
    block = src[src.index("const KOKORO_VOICES"):src.index("];", src.index("const KOKORO_VOICES"))]
    voices = re.findall(r"\['(\w+)', '([^']+)', '(en-US|en-GB)'", block)
    try:
        from kokoro_onnx import Kokoro
        base = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
        for f in ("kokoro-v1.0.onnx", "voices-v1.0.bin"):
            if not os.path.exists("/tmp/" + f):
                print("downloading", f, flush=True)
                urllib.request.urlretrieve(base + f, "/tmp/" + f)
        k = Kokoro("/tmp/kokoro-v1.0.onnx", "/tmp/voices-v1.0.bin")
    except Exception as e:
        print("PC Kokoro samples skipped:", e, flush=True)
        return
    for vid, name, lang in voices:
        try:
            samples, rate = k.create(TEXT["en"].format(name=name), voice=vid, speed=1.0, lang=lang.lower())
            wav = f"/tmp/pc-{vid}.wav"
            with wave.open(wav, "wb") as w:
                w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
                w.writeframes(array("h", (int(max(-1.0, min(1.0, float(x))) * 32767) for x in samples)).tobytes())
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", wav, "-ac", "1", "-b:a", "64k", os.path.join(out, f"pc-kokoro-{vid}.mp3")], check=True)
            os.remove(wav)
            print("made pc-kokoro", vid, flush=True)
        except Exception as e:
            print("PC Kokoro sample failed for", vid, e, flush=True)


if __name__ == "__main__":
    o = sys.argv[1] if len(sys.argv) > 1 else "samples"
    main(o)
    pc_kokoro(o)
