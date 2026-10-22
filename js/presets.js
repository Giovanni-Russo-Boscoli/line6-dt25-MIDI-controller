// Browser-side preset bank. The DT25 has no Program Change, so presets are full state snapshots.
import { createState, normalizeState } from './state.js';

const KEY = 'dt25.presets.v1';
const CURRENT = 'dt25.current.v1';

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: keep in memory */ }
}

const uid = () => Math.random().toString(36).slice(2, 10);

/** A few starting points built from the app defaults. */
function factory(spec) {
  const make = (name, patch) => {
    const st = createState(spec);
    patch(st);
    return { id: `factory-${name.toLowerCase().replace(/\W+/g, '-')}`, name, state: st };
  };
  return [
    make('DT25 Voicings', () => {}),
    make('Clean & Crunch', (st) => {
      Object.assign(st.channels.A.values, { drive: 30, bass: 70, mid: 55, treble: 80, presence: 60, volume: 85, reverbMix: 45 });
      Object.assign(st.channels.B.values, { drive: 90, bass: 64, mid: 70, treble: 70, presence: 64, volume: 75, reverbMix: 20 });
      st.channels.B.voicings[0] = { ...st.channels.B.voicings[0], amp: 16, cab: 11, topology: 1 };
      st.channels.B.voicings[1] = { ...st.channels.B.voicings[1], amp: 20, cab: 13, topology: 3 };
    }),
    make('Modern High Gain', (st) => {
      for (const ch of ['A', 'B']) {
        Object.assign(st.channels[ch].values, { drive: 105, bass: 72, mid: 50, treble: 78, presence: 80, volume: 70, reverbMix: 18 });
        st.channels[ch].voicings[0] = { ...st.channels[ch].voicings[0], amp: 22, cab: 15, topology: 3, reverbType: 4 };
        st.channels[ch].voicings[1] = { ...st.channels[ch].voicings[1], amp: 23, cab: 16, topology: 0, reverbType: 3 };
        st.channels[ch].voicings[2] = { ...st.channels[ch].voicings[2], amp: 21, cab: 14, topology: 3, reverbType: 4 };
        st.channels[ch].voicings[3] = { ...st.channels[ch].voicings[3], amp: 30, cab: 16, topology: 3, reverbType: 6 };
      }
    }),
  ];
}

export class PresetBank {
  constructor(spec) {
    this.spec = spec;
    this.items = load(KEY, null);
    if (!Array.isArray(this.items) || !this.items.length) {
      this.items = factory(spec);
      this.persist();
    }
    this.items = this.items.map((p) => ({ ...p, state: normalizeState(spec, p.state) }));
    const cur = load(CURRENT, null);
    this.index = Math.max(0, this.items.findIndex((p) => p.id === cur?.presetId));
    this.working = normalizeState(spec, cur?.state ?? this.items[this.index].state);
    this.dirty = !!cur?.dirty;
  }

  get current() { return this.items[this.index]; }

  persist() { save(KEY, this.items); }

  /** Autosave the live edit buffer so a reload keeps your tweaks. */
  saveWorking() {
    save(CURRENT, { presetId: this.current?.id, state: this.working, dirty: this.dirty });
  }

  select(i) {
    this.index = (i + this.items.length) % this.items.length;
    this.working = structuredClone(this.current.state);
    this.dirty = false;
    this.saveWorking();
    return this.working;
  }

  overwrite() {
    this.current.state = structuredClone(this.working);
    this.dirty = false;
    this.persist();
    this.saveWorking();
  }

  saveAs(name) {
    this.items.push({ id: uid(), name, state: structuredClone(this.working) });
    this.index = this.items.length - 1;
    this.dirty = false;
    this.persist();
    this.saveWorking();
  }

  rename(name) {
    this.current.name = name;
    this.persist();
  }

  remove() {
    if (this.items.length <= 1) return false;
    this.items.splice(this.index, 1);
    this.index = Math.min(this.index, this.items.length - 1);
    this.persist();
    return true;
  }

  exportJSON() {
    return JSON.stringify({ format: 'dt25-control-presets', version: 1, presets: this.items }, null, 2);
  }

  importJSON(text) {
    const data = JSON.parse(text);
    const list = Array.isArray(data) ? data : data.presets;
    if (!Array.isArray(list)) throw new Error('No presets found in file.');
    let n = 0;
    for (const p of list) {
      if (!p || typeof p.name !== 'string' || !p.state) continue;
      this.items.push({ id: uid(), name: p.name.slice(0, 60), state: normalizeState(this.spec, p.state) });
      n++;
    }
    this.persist();
    return n;
  }
}
