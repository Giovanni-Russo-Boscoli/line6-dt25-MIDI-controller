// Pure state model for the DT25. No DOM, no MIDI, so it can be unit tested in Node.
//
// The amp stores "voicing" scoped params per channel AND per voicing (8 slots),
// and "channel" scoped params per channel. Globals are amp-wide.

export const CHANNELS = ['A', 'B'];
export const VOICINGS = [0, 1, 2, 3];

export function defaultFor(spec, p, voicing = 0) {
  const vd = spec.voicingDefaults?.[voicing];
  if (vd && p.id in vd) return vd[p.id];
  if ('default' in p) return p.default;
  if (p.ui === 'toggle' || p.ui === 'stomp') return p.on ?? 127;
  return 0;
}

export function createState(spec) {
  const state = {
    version: 1,
    active: { channel: 'A', voicing: { A: 0, B: 0 } },
    globals: {},
    channels: {},
  };
  for (const g of spec.globals) state.globals[g.id] = defaultFor(spec, g);
  for (const ch of CHANNELS) {
    const c = { values: {}, voicings: VOICINGS.map(() => ({})) };
    for (const p of spec.channelParams) {
      if (p.scope === 'channel') c.values[p.id] = defaultFor(spec, p);
      else VOICINGS.forEach((v) => (c.voicings[v][p.id] = defaultFor(spec, p, v)));
    }
    state.channels[ch] = c;
  }
  return state;
}

/** Fill in anything missing (older saved presets, new params) from defaults. */
export function normalizeState(spec, raw) {
  const base = createState(spec);
  if (!raw || typeof raw !== 'object') return base;
  const ch = raw.active?.channel === 'B' ? 'B' : 'A';
  base.active.channel = ch;
  for (const c of CHANNELS) {
    const v = raw.active?.voicing?.[c];
    if (Number.isInteger(v) && v >= 0 && v <= 3) base.active.voicing[c] = v;
  }
  for (const g of spec.globals) {
    if (Number.isFinite(raw.globals?.[g.id])) base.globals[g.id] = raw.globals[g.id];
  }
  for (const c of CHANNELS) {
    const src = raw.channels?.[c];
    if (!src) continue;
    for (const p of spec.channelParams) {
      if (p.scope === 'channel') {
        if (Number.isFinite(src.values?.[p.id])) base.channels[c].values[p.id] = src.values[p.id];
      } else {
        VOICINGS.forEach((v) => {
          const val = src.voicings?.[v]?.[p.id];
          if (Number.isFinite(val)) base.channels[c].voicings[v][p.id] = val;
        });
      }
    }
  }
  return base;
}

export function findParam(spec, id) {
  return spec.globals.find((p) => p.id === id) || spec.channelParams.find((p) => p.id === id);
}

export function isGlobal(spec, p) {
  return spec.globals.includes(p);
}

export function getValue(spec, state, p, ch = state.active.channel, v = state.active.voicing[ch]) {
  if (isGlobal(spec, p)) return state.globals[p.id];
  const c = state.channels[ch];
  return p.scope === 'channel' ? c.values[p.id] : c.voicings[v][p.id];
}

export function setValue(spec, state, p, value, ch = state.active.channel, v = state.active.voicing[ch]) {
  if (isGlobal(spec, p)) state.globals[p.id] = value;
  else if (p.scope === 'channel') state.channels[ch].values[p.id] = value;
  else state.channels[ch].voicings[v][p.id] = value;
}

export function ccFor(p, ch, { withDefaults = false } = {}) {
  if (typeof p.cc === 'number') return p.cc;
  if (withDefaults && p.ccWithDefaults) return p.ccWithDefaults[ch];
  return p.cc[ch];
}

export function voicingValue(spec, ch, v) {
  return spec.navigation.voicing.base[ch] + v;
}

function included(p, opts) {
  return !p.model || (opts.models || []).includes(p.model);
}

/** Messages that recreate one channel+voicing slot. Assumes the slot is already selected on the amp. */
export function slotMessages(spec, state, ch, v, opts = {}) {
  return spec.channelParams
    .filter((p) => p.scope === 'voicing' && included(p, opts))
    .map((p) => ({ cc: ccFor(p, ch), value: getValue(spec, state, p, ch, v), id: p.id }));
}

export function channelMessages(spec, state, ch, opts = {}) {
  return spec.channelParams
    .filter((p) => p.scope === 'channel' && included(p, opts))
    .map((p) => ({ cc: ccFor(p, ch), value: getValue(spec, state, p, ch), id: p.id }));
}

export function globalMessages(spec, state) {
  return spec.globals.map((p) => ({ cc: p.cc, value: state.globals[p.id], id: p.id }));
}

/** Select a slot, then give the amp time to switch relays before editing it. */
export function selectSlotStep(spec, ch, v, settle = 60) {
  return { cc: spec.navigation.voicing.cc, value: voicingValue(spec, ch, v), wait: settle, id: 'voicing' };
}

/** Current slot only: select it, then send its voicing and channel params. */
export function currentSlotSteps(spec, state, opts = {}) {
  const ch = state.active.channel;
  const v = state.active.voicing[ch];
  return [
    selectSlotStep(spec, ch, v, opts.settle),
    ...slotMessages(spec, state, ch, v, opts),
    ...channelMessages(spec, state, ch, opts),
  ];
}

/** Whole rig: globals, all 8 slots, both channels' knobs, then return to the active slot. */
export function fullSyncSteps(spec, state, opts = {}) {
  const steps = [...globalMessages(spec, state)];
  for (const ch of CHANNELS) {
    for (const v of VOICINGS) {
      steps.push(selectSlotStep(spec, ch, v, opts.settle));
      steps.push(...slotMessages(spec, state, ch, v, opts));
    }
    steps.push(...channelMessages(spec, state, ch, opts));
  }
  const ch = state.active.channel;
  steps.push(selectSlotStep(spec, ch, state.active.voicing[ch], 0));
  return steps;
}

export function optionsFor(spec, p) {
  return p.list ? spec.lists[p.list] : [];
}
