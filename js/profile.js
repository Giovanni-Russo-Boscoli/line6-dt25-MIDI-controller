// Profile = everything this app keeps in the browser: presets, the live edit buffer and settings.
// Exported as one JSON file so it can be backed up or moved to another device.
import { normalizeState } from './state.js';

export const PROFILE_FORMAT = 'dt25-control-profile';
const KEYS = { presets: 'dt25.presets.v1', current: 'dt25.current.v1', prefs: 'dt25.prefs.v1' };
// The MIDI port id is specific to one computer, so it is not carried over.
const LOCAL_ONLY_PREFS = ['outputId'];

function read(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}

export function buildProfile(bank, prefs, name = 'My DT25 profile') {
  bank.saveWorking();
  const settings = { ...prefs };
  for (const k of LOCAL_ONLY_PREFS) delete settings[k];
  return {
    format: PROFILE_FORMAT,
    version: 1,
    name,
    exportedAt: new Date().toISOString(),
    presets: bank.items,
    current: read(KEYS.current),
    settings,
  };
}

/** Validate a profile file and turn it into what goes back into storage. Throws on bad input. */
export function parseProfile(spec, text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('That file is not valid JSON.'); }
  if (!data || data.format !== PROFILE_FORMAT) {
    throw new Error('Not a DT25 Control profile. Use Presets → Import for preset files.');
  }
  if (!Array.isArray(data.presets) || !data.presets.length) throw new Error('The profile has no presets.');
  const presets = data.presets
    .filter((p) => p && typeof p.name === 'string' && p.state)
    .map((p, i) => ({
      id: typeof p.id === 'string' ? p.id.slice(0, 40) : `imported-${i}`,
      name: p.name.slice(0, 60),
      state: normalizeState(spec, p.state),
    }));
  if (!presets.length) throw new Error('The profile has no usable presets.');

  const cur = data.current && typeof data.current === 'object' ? data.current : {};
  const current = {
    presetId: presets.some((p) => p.id === cur.presetId) ? cur.presetId : presets[0].id,
    state: normalizeState(spec, cur.state ?? presets[0].state),
    dirty: !!cur.dirty,
  };

  const s = data.settings && typeof data.settings === 'object' ? data.settings : {};
  const settings = {};
  if (Number.isInteger(s.midiChannel) && s.midiChannel >= 1 && s.midiChannel <= 16) settings.midiChannel = s.midiChannel;
  if ([4, 8, 20].includes(s.gap)) settings.gap = s.gap;
  if (typeof s.showDt50 === 'boolean') settings.showDt50 = s.showDt50;
  if (typeof s.info === 'boolean') settings.info = s.info;
  if (typeof s.profileName === 'string') settings.profileName = s.profileName.slice(0, 60);

  return { name: typeof data.name === 'string' ? data.name : 'profile', presets, current, settings };
}

/** Replace the stored profile. The caller reloads the page so every module starts clean. */
export function applyProfile(profile, prefs) {
  const keep = {};
  for (const k of LOCAL_ONLY_PREFS) if (k in prefs) keep[k] = prefs[k];
  localStorage.setItem(KEYS.presets, JSON.stringify(profile.presets));
  localStorage.setItem(KEYS.current, JSON.stringify(profile.current));
  localStorage.setItem(KEYS.prefs, JSON.stringify({ ...profile.settings, ...keep }));
}
