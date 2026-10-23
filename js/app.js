import { MidiOut, toHex } from './midi.js';
import {
  ccFor, isGlobal, currentSlotSteps, fullSyncSteps, getValue, legacySpec, optionsFor, selectSteps, setValue,
} from './state.js';
import { h, knob, picker, segmented, stomp, toggle } from './controls.js';
import { PresetBank } from './presets.js';
import { setupHelp } from './help.js';
import { applyProfile, buildProfile, parseProfile } from './profile.js';

const $ = (id) => document.getElementById(id);
const prefs = (() => {
  try { return JSON.parse(localStorage.getItem('dt25.prefs.v1')) || {}; } catch { return {}; }
})();
const savePrefs = () => { try { localStorage.setItem('dt25.prefs.v1', JSON.stringify(prefs)); } catch { /* ignore */ } };

const fullSpec = await fetch('data/dt25-params.json').then((r) => r.json());
// Amps on firmware older than 2.0 only accept a handful of CCs, so the whole UI runs from a reduced spec.
const legacy = !!prefs.legacy && !!fullSpec.legacy;
const spec = legacy ? legacySpec(fullSpec) : fullSpec;
document.body.classList.toggle('legacy', legacy);
const midi = new MidiOut();
midi.channel = prefs.midiChannel || spec.midiChannel;
const bank = new PresetBank(spec);
let state = bank.working;

// Global & Output settings (Low Volume Mode, XLR mic) belong to the rig, not to a preset:
// they live in prefs and are copied over whatever state a preset brings, so switching
// presets can never cause a volume jump.
if (!prefs.globals) {
  prefs.globals = { ...state.globals };
  savePrefs();
}
function withGlobals(st) {
  for (const g of spec.globals) if (Number.isFinite(prefs.globals[g.id])) st.globals[g.id] = prefs.globals[g.id];
  return st;
}
withGlobals(state);
const widgets = new Map(); // param id -> [widget]
let syncing = false;

// ---------- helpers ----------

function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), ms);
}

function models() {
  return prefs.showDt50 ? ['DT50'] : [];
}

function register(p, w) {
  if (!widgets.has(p.id)) widgets.set(p.id, []);
  widgets.get(p.id).push(w);
  return w;
}

let saveTimer = 0;
function markDirty() {
  bank.working = state;
  bank.dirty = true;
  renderPresetName();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => bank.saveWorking(), 300);
}

// ---------- parameter changes ----------

function onParam(p, value) {
  setValue(spec, state, p, value);
  const ch = state.active.channel;
  const withDefaults = p.id === 'amp' && $('ampDefaults').checked;
  const cc = ccFor(p, ch, { withDefaults });
  if (p.ui === 'knob') midi.ccLive(cc, value);
  else midi.cc(cc, value);
  if (withDefaults) toast('Amp loaded its own default cab, class and tube settings. The amp cannot report them back, so check the panel.', 4200);
  // Keep twin widgets (e.g. Reverb knob shown on faceplate and reverb panel) in step.
  for (const w of widgets.get(p.id) || []) w.set(value);
  if (p.id === 'cab') renderCab();
  if (p.id === 'reverbOn') renderReverbState();
  if (p.id === 'amp') renderVoicingNames();
  if (isGlobal(spec, p)) {
    prefs.globals[p.id] = value;
    savePrefs();
    return;
  }
  markDirty();
}

function selectSlot(ch, v, { send = true } = {}) {
  state.active.channel = ch;
  state.active.voicing[ch] = v;
  if (send) for (const step of selectSteps(spec, ch, v)) midi.cc(step.cc, step.value);
  renderAll();
  markDirty();
}

// ---------- build UI from the spec ----------

function build() {
  const byGroup = (g) => spec.channelParams.filter((p) => p.group === g && !p.unsupported);
  const make = (p) => {
    const cb = (v) => onParam(p, v);
    switch (p.ui) {
      case 'knob': return register(p, knob(p, cb));
      case 'toggle': return register(p, toggle(p, cb));
      case 'segmented': return register(p, segmented(p, optionsFor(spec, p), cb));
      case 'stomp': return register(p, stomp(p, cb));
      case 'picker': return register(p, picker(p, optionsFor(spec, p), cb));
      default: throw new Error(`Unknown ui ${p.ui}`);
    }
  };

  for (const p of byGroup('preamp')) {
    const w = make(p);
    (p.id === 'amp' ? $('ampPicker') : $('preampKnobs')).append(w.el);
    if (p.id === 'amp') w.el.classList.add('picker-hero');
  }
  for (const p of byGroup('power')) $(p.model ? 'dt50Controls' : 'powerControls').append(make(p).el);
  for (const p of byGroup('cab')) $('cabControls').append(make(p).el);
  for (const p of byGroup('reverb')) {
    const w = make(p);
    if (p.ui === 'stomp') $('reverbStomp').append(w.el);
    else if (p.ui === 'picker') $('reverbType').append(w.el);
    else $('reverbKnobs').append(w.el);
  }
  // Reverb Mix is the panel REVERB knob; mirror it in the reverb section too.
  const mix = spec.channelParams.find((p) => p.id === 'reverbMix');
  if (!mix.unsupported) $('reverbKnobs').append(register(mix, knob({ ...mix, label: 'Mix' }, (v) => onParam(mix, v))).el);

  for (const g of spec.globals.filter((x) => !x.unsupported)) $('globalControls').append(make(g).el);

  const vl = spec.navigation.voicing.labels;
  vl.forEach((label, i) => {
    $('voicing').append(h('button', {
      type: 'button', class: 'voice', role: 'radio', 'data-v': i,
      onclick: () => selectSlot(state.active.channel, i),
    }, h('span', { class: 'voice-num', text: label }), h('span', { class: 'voice-name' })));
  });
  document.querySelectorAll('.chan').forEach((b) => b.addEventListener('click', () => {
    const ch = b.dataset.ch;
    selectSlot(ch, state.active.voicing[ch]);
  }));

  $('chanToggle').addEventListener('click', () => {
    const t = spec.navigation.channelToggle;
    midi.cc(t.cc, t.value);
    state.active.channel = state.active.channel === 'A' ? 'B' : 'A';
    renderAll();
    markDirty();
  });

  $('sendSlot').addEventListener('click', () => runSteps(currentSlotSteps(spec, state, { models: models() }), 'Slot sent'));
  $('syncAll').addEventListener('click', () => runSteps(fullSyncSteps(spec, state, { models: models() }), legacy ? 'Both channels synced' : 'All 8 slots synced'));
}

async function runSteps(steps, done) {
  if (syncing) return;
  syncing = true;
  document.body.classList.add('syncing');
  if (!midi.connected) toast('No MIDI output selected, messages only go to the monitor.');
  await midi.sequence(steps, Number(prefs.gap || 8));
  syncing = false;
  document.body.classList.remove('syncing');
  toast(`${done} (${steps.length} messages)`);
}

// ---------- rendering ----------

function renderAll() {
  const ch = state.active.channel;
  const v = state.active.voicing[ch];
  document.body.dataset.channel = ch;
  for (const p of [...spec.globals, ...spec.channelParams]) {
    for (const w of widgets.get(p.id) || []) w.set(getValue(spec, state, p));
  }
  document.querySelectorAll('.chan').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.ch === ch)));
  document.querySelectorAll('.voice').forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.v) === v)));
  $('ampChan').textContent = `CH ${ch} · VOICING ${spec.navigation.voicing.labels[v]}`;
  renderVoicingNames();
  $('dt50Controls').hidden = !prefs.showDt50;
  renderCab();
  renderReverbState();
}

/** Each voicing button shows the amp model stored in that slot. */
function renderVoicingNames() {
  const ch = state.active.channel;
  const amps = spec.lists.amps;
  document.querySelectorAll('.voice').forEach((b) => {
    const name = amps[state.channels[ch].voicings[Number(b.dataset.v)].amp] || '';
    b.querySelector('.voice-name').textContent = name;
    b.title = `Voicing ${b.querySelector('.voice-num').textContent}: ${name}`;
  });
}

function renderCab() {
  const p = spec.channelParams.find((x) => x.id === 'cab');
  const name = spec.lists.cabs[getValue(spec, state, p)] || 'None';
  const m = name.match(/^(\d)x(\d+|\(6x9\))/);
  const box = $('cabVisual');
  box.replaceChildren();
  box.className = 'cab-visual';
  if (!m) { box.classList.add('empty'); box.append(h('span', { text: 'No cab' })); return; }
  const count = Number(m[1]);
  const size = m[2] === '(6x9)' ? 'oval' : `s${m[2]}`;
  box.classList.add(`n${count}`, size);
  for (let i = 0; i < count; i++) box.append(h('span', { class: 'spk' }));
}

function renderReverbState() {
  const p = spec.channelParams.find((x) => x.id === 'reverbOn');
  const on = getValue(spec, state, p) >= 64;
  $('sec-reverb').classList.toggle('bypassed', !on);
  $('chainReverb').classList.toggle('bypassed', !on);
}

function renderPresetName() {
  $('presetTitle').textContent = `${bank.current.name}${bank.dirty ? ' *' : ''}`;
}

// ---------- MIDI connection ----------

function labelForCC(cc, value) {
  const nav = spec.navigation;
  for (const ch of ['A', 'B']) {
    if (nav.voicing.cc[ch] === cc) {
      const v = nav.voicing.labels[value];
      return `Voicing ${ch} · ${v ?? '?'}`;
    }
  }
  if (cc === nav.channelSelect.cc) return `Channel ${value >= 64 ? 'B' : 'A'}`;
  if (cc === nav.channelToggle.cc) return 'Toggle channel';
  for (const g of spec.globals) if (g.cc === cc) return g.label;
  for (const p of spec.channelParams) {
    for (const ch of ['A', 'B']) {
      if (p.cc[ch] === cc) return `${p.label} ${ch}`;
      if (p.ccWithDefaults?.[ch] === cc) return `${p.label} + defaults ${ch}`;
    }
  }
  return '';
}

const MAX_LOG = 80;
midi.addEventListener('sent', (e) => {
  const { bytes, cc, value, live } = e.detail;
  const li = h('li', { class: live ? '' : 'offline' },
    h('span', { class: 'hex', text: toHex(bytes) }),
    h('span', { class: 'cc', text: `CC ${cc} = ${value}` }),
    h('span', { class: 'what', text: labelForCC(cc, value) }));
  const log = $('log');
  log.prepend(li);
  $('monitorLast').textContent = `${toHex(bytes)}  ·  ${labelForCC(cc, value) || `CC ${cc} = ${value}`}`;
  while (log.children.length > MAX_LOG) log.lastChild.remove();
  const dot = $('connDot');
  dot.classList.remove('blink');
  void dot.offsetWidth;
  dot.classList.add('blink');
});
midi.addEventListener('error', (e) => toast(`MIDI error: ${e.detail.message}`));
midi.addEventListener('ports', renderPorts);

function renderPorts() {
  const sel = $('outputSelect');
  const outs = midi.outputs();
  sel.replaceChildren(h('option', { value: '', text: outs.length ? 'Choose an output…' : 'No MIDI outputs found' }));
  for (const o of outs) sel.append(h('option', { value: o.id, text: o.name + (o.manufacturer ? ` (${o.manufacturer})` : '') }));
  sel.value = midi.output?.id || '';
  const ok = midi.connected;
  $('connDot').classList.toggle('on', ok);
  $('connText').textContent = ok ? midi.output.name : (midi.access ? 'Choose output' : 'Connect MIDI');
  $('midiEnable').hidden = !!midi.access;
}

async function enableMidi() {
  try {
    await midi.init();
    if (prefs.outputId && midi.outputs().some((o) => o.id === prefs.outputId)) await midi.select(prefs.outputId);
    else if (midi.outputs().length === 1) await midi.select(midi.outputs()[0].id);
    renderPorts();
    return true;
  } catch (err) {
    toast(err.name === 'SecurityError' || err.name === 'NotAllowedError'
      ? 'MIDI permission was blocked. Allow MIDI for this site in the browser settings.'
      : err.message, 5000);
    return false;
  }
}

function setupConnection() {
  const chSel = $('channelSelect');
  for (let i = 1; i <= 16; i++) chSel.append(h('option', { value: i, text: i === 1 ? '1 (DT25 default)' : String(i) }));
  chSel.value = String(midi.channel);
  chSel.addEventListener('change', () => { midi.channel = Number(chSel.value); prefs.midiChannel = midi.channel; savePrefs(); });

  $('gapSelect').value = String(prefs.gap || 8);
  $('gapSelect').addEventListener('change', (e) => { prefs.gap = Number(e.target.value); savePrefs(); });

  $('firmwareSelect').value = legacy ? 'legacy' : 'v2';
  $('firmwareSelect').addEventListener('change', (e) => {
    prefs.legacy = e.target.value === 'legacy';
    savePrefs();
    bank.saveWorking();
    location.reload();
  });
  $('legacyOff').addEventListener('click', () => { $('firmwareSelect').value = 'v2'; $('firmwareSelect').dispatchEvent(new Event('change')); });

  $('showDt50').checked = !!prefs.showDt50;
  $('showDt50').addEventListener('change', (e) => { prefs.showDt50 = e.target.checked; savePrefs(); renderAll(); });

  $('connBtn').addEventListener('click', () => $('connDialog').showModal());
  $('midiEnable').addEventListener('click', enableMidi);
  $('outputSelect').addEventListener('change', async (e) => {
    await midi.select(e.target.value);
    prefs.outputId = e.target.value;
    savePrefs();
    if (midi.connected) toast(`Connected to ${midi.output.name}`);
  });
  document.querySelectorAll('[data-diag]').forEach((btn) => btn.addEventListener('click', () => {
    const [cc, val] = btn.dataset.diag.split(':').map(Number);
    midi.cc(cc, val);
  }));
  $('diagSend').addEventListener('click', () => {
    const cc = Math.min(127, Math.max(0, Number($('diagCC').value) | 0));
    const val = Math.min(127, Math.max(0, Number($('diagVal').value) | 0));
    midi.cc(cc, val);
  });
  // If the amp reacts on some other channel, this tells you which one (channel B then back to A per channel).
  $('diagSweep').addEventListener('click', async () => {
    const original = midi.channel;
    for (let ch = 1; ch <= 16; ch++) {
      midi.channel = ch;
      toast(`MIDI channel ${ch}: switching to B…`, 900);
      midi.cc(19, 127);
      await new Promise((r) => setTimeout(r, 450));
      midi.cc(19, 0);
      await new Promise((r) => setTimeout(r, 450));
    }
    midi.channel = original;
    toast('Sweep finished. If the amp changed channel, note which MIDI channel was showing.', 5000);
  });
  $('testSend').addEventListener('click', () => {
    const steps = selectSteps(spec, 'A', 0);
    for (const step of steps) midi.cc(step.cc, step.value);
    state.active.channel = 'A';
    state.active.voicing.A = 0;
    renderAll();
    toast(`Sent ${steps.map((x) => `CC ${x.cc} = ${x.value}`).join(', ')}. The amp should switch to Channel A, Voicing I.`);
  });

  if (!midi.supported) {
    const b = $('banner');
    b.hidden = false;
    b.textContent = 'This browser has no Web MIDI. Use Chrome, Edge or Opera on a computer or Android (iPhone and iPad browsers do not support it). You can still explore the panel, messages show in the monitor.';
    $('midiEnable').disabled = true;
    $('connHelp').textContent = 'Web MIDI is not available in this browser.';
    return;
  }
  // Reconnect without a click when permission was already granted.
  navigator.permissions?.query({ name: 'midi' }).then((st) => {
    if (st.state === 'granted') enableMidi();
  }).catch(() => {});
}

// ---------- presets ----------

function loadPreset(i) {
  state = withGlobals(bank.select(i));
  renderAll();
  renderPresetName();
  if (midi.connected) runSteps(fullSyncSteps(spec, state, { models: models() }), `Loaded “${bank.current.name}”`);
  else toast(`Loaded “${bank.current.name}” (connect MIDI and press Sync all to send it)`);
}

function renderPresetList() {
  const ul = $('presetList');
  ul.replaceChildren();
  bank.items.forEach((p, i) => {
    ul.append(h('li', {}, h('button', {
      type: 'button',
      class: `preset-item${i === bank.index ? ' current' : ''}`,
      text: p.name,
      onclick: () => { loadPreset(i); renderPresetList(); },
    })));
  });
}

function setupPresets() {
  renderPresetName();
  $('presetPrev').addEventListener('click', () => loadPreset(bank.index - 1));
  $('presetNext').addEventListener('click', () => loadPreset(bank.index + 1));
  $('presetName').addEventListener('click', () => { renderPresetList(); $('presetDialog').showModal(); });
  $('presetSave').addEventListener('click', () => {
    if (bank.current.id.startsWith('factory-')) {
      const name = prompt('Save as a new preset named:', `${bank.current.name} copy`);
      if (name) bank.saveAs(name.trim().slice(0, 60));
    } else {
      bank.overwrite();
    }
    renderPresetName();
    toast('Preset saved');
  });
  $('presetNew').addEventListener('click', () => {
    const name = prompt('Preset name:', 'My tone');
    if (!name) return;
    bank.saveAs(name.trim().slice(0, 60));
    renderPresetName();
    renderPresetList();
  });
  $('presetRename').addEventListener('click', () => {
    const name = prompt('Rename preset:', bank.current.name);
    if (!name) return;
    bank.rename(name.trim().slice(0, 60));
    renderPresetName();
    renderPresetList();
  });
  $('presetDelete').addEventListener('click', () => {
    if (!confirm(`Delete “${bank.current.name}”?`)) return;
    if (!bank.remove()) return toast('Keep at least one preset.');
    loadPreset(bank.index);
    renderPresetList();
  });
  $('presetExport').addEventListener('click', () => {
    const blob = new Blob([bank.exportJSON()], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: 'dt25-presets.json' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('presetImport').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const n = bank.importJSON(await file.text());
      toast(`Imported ${n} preset${n === 1 ? '' : 's'}`);
      renderPresetList();
    } catch (err) {
      toast(`Import failed: ${err.message}`);
    }
    e.target.value = '';
  });
}

// ---------- profile ----------

function download(name, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function setupProfile() {
  if (prefs.profileName) $('profileName').value = prefs.profileName;
  $('profileBtn').addEventListener('click', () => $('profileDialog').showModal());
  $('profileSave').addEventListener('click', () => {
    const name = $('profileName').value.trim() || 'My DT25 profile';
    prefs.profileName = name;
    savePrefs();
    const profile = buildProfile(bank, prefs, name);
    const file = `${name.replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '') || 'dt25-profile'}.dt25profile.json`;
    download(file, JSON.stringify(profile, null, 2));
    toast(`Profile saved (${profile.presets.length} presets)`);
  });
  $('profileLoad').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const profile = parseProfile(spec, await file.text());
      if (!confirm(`Load “${profile.name}”? It replaces the ${bank.items.length} presets and settings in this browser with ${profile.presets.length} presets from the file.`)) return;
      // Stop the autosave from writing the old session back over the loaded profile.
      clearTimeout(saveTimer);
      bank.saveWorking = () => {};
      applyProfile(profile, prefs);
      sessionStorage.setItem('dt25.toast', `Profile “${profile.name}” loaded. Press Sync all to send it to the amp.`);
      location.reload();
    } catch (err) {
      toast(`Could not load profile: ${err.message}`, 5000);
    }
  });
  const pending = sessionStorage.getItem('dt25.toast');
  if (pending) { sessionStorage.removeItem('dt25.toast'); setTimeout(() => toast(pending, 4500), 300); }
}

// ---------- boot ----------

$('clearLog').addEventListener('click', () => { $('log').replaceChildren(); $('monitorLast').textContent = 'No messages yet'; });
$('monitor').open = !!prefs.monitorOpen;
$('monitor').addEventListener('toggle', () => { prefs.monitorOpen = $('monitor').open; savePrefs(); });
document.querySelectorAll('.chain-node').forEach((a) => a.addEventListener('click', (e) => {
  e.preventDefault();
  document.querySelector(a.getAttribute('href')).scrollIntoView({ behavior: 'smooth', block: 'start' });
}));

window.addEventListener('pagehide', () => bank.saveWorking());

build();
setupConnection();
setupPresets();
setupProfile();
setupHelp(spec.help || {}, { enabled: !!prefs.info, onToggle: (on) => { prefs.info = on; savePrefs(); } });
renderAll();
renderPorts();

// Exposed for debugging in the console.
window.dt25 = { spec, midi, get state() { return state; }, bank };
