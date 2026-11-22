// Runs the background-sound mixer (ambience-synth.js, loaded first) on the audio thread.
class AmbienceProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.mixer = new globalThis.AmbienceSynth.Mixer(sampleRate);
    this.port.onmessage = (e) => this.mixer.set(e.data.mix, e.data.master);
  }
  process(_in, outputs) {
    const out = outputs[0];
    if (!out || !out[0]) return true;
    this.mixer.render(out[0]);
    for (let c = 1; c < out.length; c++) out[c].set(out[0]);
    return true;
  }
}
registerProcessor('ambience', AmbienceProcessor);
