// Background sounds: rain, waves, birds, a train… under the voice, each with its own volume.
// They play when any of these is true, and pressing pause anywhere (player, Space, media keys) stops them all:
//   reading    – a book is being read (and "Play while reading" is on)
//   lingering  – the book stopped by itself a little while ago (keepAfter minutes, -1 = until paused)
//   previewing – you just changed the mix in the Background sounds panel (stops when it closes)
//   solo       – you pressed "Play sounds" to hear them without a book
// Settings live in S.settings.ambience = { on, volume, mix, keepAfter, saved: [{ name, mix }] } (same as the phone app).
const Ambience = (() => {
  const A = window.AmbienceSynth;
  let ctx = null, node = null, script = null, reading = false, previewing = false, solo = false, muted = false, lingerUntil = 0, lingerTimer = 0, starting = null, idleTimer = 0;

  const cfg = () => Object.assign({ on: false, volume: 0.6, mix: {}, keepAfter: 0, saved: [], heartBpm: 60 }, (typeof S !== 'undefined' && S.settings && S.settings.ambience) || {});
  const lingering = () => lingerUntil > Date.now();
  function audible() {
    const c = cfg();
    if (muted || !active(c).length) return false;
    return (c.on && (reading || lingering())) || previewing || solo;
  }
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
    const params = { heartBpm: +cfg().heartBpm || 60 };
    if (node) node.port.postMessage({ mix, master, params });
    else if (script) script.mixer.set(mix, master, params);
  }

  async function refresh() {
    const c = cfg();
    const want = audible();
    clearTimeout(idleTimer);
    showState();
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
  function closed() { panelOpen = false; if (previewing) { previewing = false; refresh(); } }
  let panelOpen = false;
  document.addEventListener('visibilitychange', () => { if (document.hidden && previewing) { previewing = false; refresh(); } });
  /** You changed the mix: let it be heard (unless the book or the sounds are already playing it). */
  function hear() { if (!audible()) { previewing = true; refresh(); } }

  const keepText = (m) => m === 0 ? 'Stop with the book' : m < 0 ? 'Keep playing until I press pause' : `Keep playing ${m} more minutes`;
  function stateText() {
    const on = audible();
    if (on && reading) return 'Playing under the book';
    if (on && solo) return 'Playing on their own';
    if (on && lingering()) return lingerUntil === Infinity ? 'Still playing after the book (until you pause)' : `Still playing after the book · ${Math.max(1, Math.ceil((lingerUntil - Date.now()) / 60000))} min left`;
    if (on) return 'Playing';
    if (reading) return 'Paused. The book keeps reading';
    return 'Play them on their own, no book needed';
  }
  function showState() {
    const on = audible();
    const b = document.getElementById('ambPlay');
    if (b) { b.textContent = on ? '⏸ Pause sounds' : '▶ Play sounds'; const t = document.getElementById('ambState'); if (t) t.textContent = stateText(); }
    const btn = document.getElementById('ambBtn'); if (btn) btn.classList.toggle('on', on);
    if (typeof updatePlayer === 'function' && !reading) try { updatePlayer(); } catch (_) {}
  }
  function togglePlay() {
    if (audible()) {
      if (reading) { muted = true; previewing = false; solo = false; lingerUntil = 0; refresh(); toast('Sounds paused. The book keeps reading.'); }
      else hush();
    } else {
      if (!active(cfg()).length) { toast('Add a sound or pick a mix first'); return; }
      muted = false;
      if (reading) { if (!cfg().on) save({ on: true }); else refresh(); }
      else { solo = true; refresh(); }
    }
  }
  /** Pause was pressed: every sound stops. */
  function hush() { reading = false; previewing = false; solo = false; lingerUntil = 0; clearTimeout(lingerTimer); refresh(); }
  /** The book stopped by itself (sleep timer, end of the book): keep the sounds going if that's chosen. */
  function bookStopped() {
    reading = false; clearTimeout(lingerTimer);
    const c = cfg(); const m = +c.keepAfter || 0;
    lingerUntil = !c.on || m === 0 ? 0 : m < 0 ? Infinity : Date.now() + m * 60000;
    if (m > 0) lingerTimer = setTimeout(refresh, m * 60000 + 500);
    refresh();
  }

  function render() {
    const c = cfg();
    const mix = c.mix || {};
    const inMix = Object.keys(mix).filter((id) => A.SOUNDS.some((s) => s.id === id));
    const rest = A.SOUNDS.filter((s) => !inMix.includes(s.id));
    const saved = Array.isArray(c.saved) ? c.saved : [];
    const sleepNow = (typeof S !== 'undefined' && S.sleepAt) ? Math.max(1, Math.ceil((S.sleepAt - Date.now()) / 60000)) : 0;
    openDrawer('Background sounds', `
      <div class="amb-playcard"><button id="ambPlay" class="primary"></button><span id="ambState" class="muted small"></span></div>
      <label class="check"><input type="checkbox" id="ambOn" ${c.on ? 'checked' : ''}> Play while reading</label>
      <p class="muted small" style="margin:2px 0 8px">Sounds fade in when the book starts. Pausing (the player, Space, media keys) stops them too.</p>
      <div class="amb-row"><span>When the book stops by itself</span><select id="ambAfter">${[0, 15, 30, 60, -1].map((m) => `<option value="${m}" ${m === (+c.keepAfter || 0) ? 'selected' : ''}>${keepText(m)}</option>`).join('')}</select></div>
      <div class="amb-row"><span>Sleep timer</span><select id="ambSleep">${[[0, 'Off'], [15, '15 min'], [30, '30 min'], [45, '45 min'], [60, '1 hour'], [90, '1½ hours'], [120, '2 hours']].map(([m, l]) => `<option value="${m}">${l}</option>`).join('')}${sleepNow ? `<option value="cur" selected>${sleepNow} min left</option>` : ''}</select></div>
      <div class="amb-vol"><span>Overall volume</span><input type="range" id="ambVol" min="0" max="100" value="${Math.round(c.volume * 100)}"></div>
      <h4 class="amb-h">Quick mixes</h4>
      <div class="amb-chips">${A.PRESETS.map((p, k) => `<button class="chipb" data-preset="${k}">${esc(p.name)}</button>`).join('')}</div>
      <h4 class="amb-h">Your mixes</h4>
      <div class="amb-chips">${saved.map((m, k) => `<span class="amb-saved"><button class="chipb" data-saved="${k}">★ ${esc(m.name)}</button><button class="icon small" data-delsaved="${k}" title="Delete ${esc(m.name)}">✕</button></span>`).join('')}${inMix.length ? '<button class="chipb" data-save>💾 Save this mix</button><button class="chipb" data-clear>✕ Clear</button>' : ''}</div>
      ${saved.length || inMix.length ? '' : '<p class="muted small">Make a mix below, then save it here to use again.</p>'}
      <h4 class="amb-h">Now playing</h4>
      ${inMix.length ? '' : '<p class="muted">No sounds yet. Add some below, or pick a mix.</p>'}
      ${inMix.map((id) => { const s = A.SOUNDS.find((x) => x.id === id); const v = Math.round((mix[id] || 0) * 100); return `
        <div class="amb-card" data-id="${id}">
          <div class="amb-head"><b>${s.icon} ${esc(s.name)}</b><span class="muted small" data-pct>${v}%</span><button class="icon" data-remove title="Remove ${esc(s.name)}">✕</button></div>
          <input type="range" min="0" max="100" value="${v}" data-vol>
          ${id === 'heart' ? `<div class="amb-speed"><span class="muted small">Speed</span><input type="range" min="${A.HEART.min}" max="${A.HEART.max}" value="${+c.heartBpm || 60}" data-bpm><span class="muted small" data-bpmval>${+c.heartBpm || 60} beats a minute</span></div>` : ''}
        </div>`; }).join('')}
      ${rest.length ? '<h4 class="amb-h">Add a sound</h4>' : ''}
      ${rest.map((s) => `<button class="amb-add" data-add="${s.id}"><span>${s.icon}</span> ${esc(s.name)}<span class="amb-plus">+ Add</span></button>`).join('')}
      <p class="muted small" style="margin-top:14px">All sounds are made on your PC, so they work offline. Same sounds and mixes as the phone app.</p>`);
    panelOpen = true; showState();
    const body = $('#drawerBody');
    body.querySelector('#ambPlay').onclick = () => togglePlay();
    body.querySelector('#ambAfter').onchange = (e) => save({ keepAfter: +e.target.value });
    body.querySelector('#ambSleep').onchange = (e) => { if (e.target.value !== 'cur' && typeof setSleep === 'function') { setSleep(+e.target.value); toast(+e.target.value ? 'Sounds and reading stop in ' + e.target.selectedOptions[0].textContent : 'Sleep timer off'); } };
    body.querySelectorAll('[data-saved]').forEach((b) => { b.onclick = () => { save({ on: true, mix: Object.assign({}, saved[+b.dataset.saved].mix) }); hear(); render(); }; });
    body.querySelectorAll('[data-delsaved]').forEach((b) => { b.onclick = () => { const k = +b.dataset.delsaved; if (confirm(`Delete “${saved[k].name}”?`)) { save({ saved: saved.filter((_, i) => i !== k) }); render(); } }; });
    const sv = body.querySelector('[data-save]'); if (sv) sv.onclick = () => {
      const name = (prompt('Name this mix (e.g. Reading in bed)', '') || '').trim().slice(0, 40);
      if (!name) return;
      save({ saved: saved.filter((m) => m.name !== name).concat([{ name, mix: Object.assign({}, cfg().mix) }]) }); toast('Mix saved'); render();
    };
    body.querySelector('#ambOn').onchange = (e) => { save({ on: e.target.checked }); };
    body.querySelector('#ambVol').oninput = (e) => { save({ volume: +e.target.value / 100 }); hear(); };
    body.querySelectorAll('[data-preset]').forEach((b) => { b.onclick = () => { save({ on: true, mix: Object.assign({}, A.PRESETS[+b.dataset.preset].mix) }); hear(); render(); }; });
    const clr = body.querySelector('[data-clear]'); if (clr) clr.onclick = () => { save({ mix: {} }); render(); };
    body.querySelectorAll('.amb-card').forEach((card) => {
      const id = card.dataset.id;
      card.querySelector('[data-vol]').oninput = (e) => {
        card.querySelector('[data-pct]').textContent = e.target.value + '%';
        save({ mix: Object.assign({}, cfg().mix, { [id]: +e.target.value / 100 }) }); hear();
      };
      const bpm = card.querySelector('[data-bpm]');
      if (bpm) bpm.oninput = (e) => { card.querySelector('[data-bpmval]').textContent = e.target.value + ' beats a minute'; save({ heartBpm: +e.target.value }); hear(); };
      card.querySelector('[data-remove]').onclick = () => { const m = Object.assign({}, cfg().mix); delete m[id]; save({ mix: m }); render(); };
    });
    body.querySelectorAll('[data-add]').forEach((b) => { b.onclick = () => { save({ on: true, mix: Object.assign({}, cfg().mix, { [b.dataset.add]: 0.5 }) }); hear(); render(); }; });
  }

  return {
    reading(on) { reading = !!on; if (on) { muted = false; solo = false; lingerUntil = 0; clearTimeout(lingerTimer); } refresh(); },
    /** Sounds are playing without a book being read (on their own, or after the book stopped). */
    withoutBook() { return !reading && audible(); },
    audible, hush, bookStopped, togglePlay,
    open, closed, summary, refresh,
  };
})();
