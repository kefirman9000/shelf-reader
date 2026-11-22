// Background sounds: rain, waves, fire, white noise… under the voice, each with its own volume.
// They fade in when reading starts and out when it pauses or the sleep timer ends; while the
// Background sounds panel is open they play too, so you hear the mix as you set it.
// Settings live in S.settings.ambience = { on, volume, mix: { rain: 0.6, … } } (same as the phone app).
const Ambience = (() => {
  const A = window.AmbienceSynth;
  let ctx = null, node = null, script = null, reading = false, previewing = false, starting = null, idleTimer = 0;

  const cfg = () => Object.assign({ on: false, volume: 0.6, mix: {} }, (typeof S !== 'undefined' && S.settings && S.settings.ambience) || {});
  const active = (c) => Object.entries(c.mix || {}).filter(([, v]) => v > 0);

  async function ensure() {
    if (node || script) return;
    if (starting) return starting;
    starting = (async () => {
      ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
      try {
        await ctx.audioWorklet.addModule('ambience-synth.js');
        await ctx.audioWorklet.addModule('ambience-worklet.js');
        node = new AudioWorkletNode(ctx, 'ambience', { numberOfInputs: 0, outputChannelCount: [2] });
        node.connect(ctx.destination);
      } catch (e) {
        // older engines: run the mixer on the page instead
        const m = new A.Mixer(ctx.sampleRate);
        script = ctx.createScriptProcessor(4096, 0, 2);
        script.mixer = m;
        script.onaudioprocess = (ev) => { const l = ev.outputBuffer.getChannelData(0); m.render(l); ev.outputBuffer.getChannelData(1).set(l); };
        script.connect(ctx.destination);
      }
    })();
    try { await starting; } finally { starting = null; }
  }

  function send(mix, master) {
    if (node) node.port.postMessage({ mix, master });
    else if (script) script.mixer.set(mix, master);
  }

  async function refresh() {
    const c = cfg();
    const want = c.on && active(c).length > 0 && (reading || previewing);
    clearTimeout(idleTimer);
    if (want) {
      await ensure();
      if (ctx.state === 'suspended') try { await ctx.resume(); } catch (_) {}
      send(c.mix, c.volume);
    } else if (node || script) {
      send({}, 0);
      // let it fade, then let the sound card rest
      idleTimer = setTimeout(() => { if (ctx && !(reading || previewing)) ctx.suspend().catch(() => {}); }, 4000);
    }
  }

  async function save(patch) {
    const next = Object.assign(cfg(), patch);
    S.settings.ambience = next;
    refresh();
    clearTimeout(save.t);
    save.t = setTimeout(() => saveSettings({ ambience: S.settings.ambience }).catch(() => {}), 400);
  }

  function summary() {
    const c = cfg(); const a = active(c);
    if (!c.on || !a.length) return 'Off';
    return a.map(([id]) => (A.SOUNDS.find((s) => s.id === id) || {}).name).filter(Boolean).join(', ');
  }

  function open() { render(); }
  /** The side panel closed or now shows something else. */
  function closed() { if (previewing) { previewing = false; refresh(); } }

  function render() {
    const c = cfg();
    const mix = c.mix || {};
    const inMix = Object.keys(mix).filter((id) => A.SOUNDS.some((s) => s.id === id));
    const rest = A.SOUNDS.filter((s) => !inMix.includes(s.id));
    openDrawer('Background sounds', `
      <label class="check"><input type="checkbox" id="ambOn" ${c.on ? 'checked' : ''}> Play while reading</label>
      <p class="muted small" style="margin:2px 0 10px">Sounds fade in when the book starts and out when it stops, including with the sleep timer.</p>
      <div class="amb-vol"><span>Overall volume</span><input type="range" id="ambVol" min="0" max="100" value="${Math.round(c.volume * 100)}"></div>
      <h4 class="amb-h">Quick mixes</h4>
      <div class="amb-chips">${A.PRESETS.map((p, k) => `<button class="chipb" data-preset="${k}">${esc(p.name)}</button>`).join('')}${inMix.length ? '<button class="chipb" data-clear>✕ Clear</button>' : ''}</div>
      <h4 class="amb-h">Your mix</h4>
      ${inMix.length ? '' : '<p class="muted">No sounds yet. Add some below, or pick a quick mix.</p>'}
      ${inMix.map((id) => { const s = A.SOUNDS.find((x) => x.id === id); const v = Math.round((mix[id] || 0) * 100); return `
        <div class="amb-card" data-id="${id}">
          <div class="amb-head"><b>${s.icon} ${esc(s.name)}</b><span class="muted small" data-pct>${v}%</span><button class="icon" data-remove title="Remove ${esc(s.name)}">✕</button></div>
          <input type="range" min="0" max="100" value="${v}" data-vol>
        </div>`; }).join('')}
      ${rest.length ? '<h4 class="amb-h">Add a sound</h4>' : ''}
      ${rest.map((s) => `<button class="amb-add" data-add="${s.id}"><span>${s.icon}</span> ${esc(s.name)}<span class="amb-plus">+ Add</span></button>`).join('')}
      <p class="muted small" style="margin-top:14px">All sounds are made on your PC, so they work offline. Same mixes as the phone app.</p>`);
    previewing = true; refresh();
    const body = $('#drawerBody');
    body.querySelector('#ambOn').onchange = (e) => { save({ on: e.target.checked }); };
    body.querySelector('#ambVol').oninput = (e) => save({ volume: +e.target.value / 100 });
    body.querySelectorAll('[data-preset]').forEach((b) => { b.onclick = () => { save({ on: true, mix: Object.assign({}, A.PRESETS[+b.dataset.preset].mix) }); render(); }; });
    const clr = body.querySelector('[data-clear]'); if (clr) clr.onclick = () => { save({ mix: {} }); render(); };
    body.querySelectorAll('.amb-card').forEach((card) => {
      const id = card.dataset.id;
      card.querySelector('[data-vol]').oninput = (e) => {
        card.querySelector('[data-pct]').textContent = e.target.value + '%';
        save({ mix: Object.assign({}, cfg().mix, { [id]: +e.target.value / 100 }) });
      };
      card.querySelector('[data-remove]').onclick = () => { const m = Object.assign({}, cfg().mix); delete m[id]; save({ mix: m }); render(); };
    });
    body.querySelectorAll('[data-add]').forEach((b) => { b.onclick = () => { save({ on: true, mix: Object.assign({}, cfg().mix, { [b.dataset.add]: 0.5 }) }); render(); }; });
  }

  return {
    reading(on) { reading = !!on; refresh(); },
    open, closed, summary, refresh,
  };
})();
