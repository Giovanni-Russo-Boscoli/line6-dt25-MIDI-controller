import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ccBytes } from '../js/midi.js';
import {
  createState, ccFor, findParam, setValue, getValue, currentSlotSteps, fullSyncSteps, normalizeState,
} from '../js/state.js';

const spec = JSON.parse(readFileSync(new URL('../data/dt25-params.json', import.meta.url)));

// Expected CCs straight from the MIDI Implementation Guide Rev A tables.
const EXPECTED = {
  amp: [11, 91], drive: [13, 92], bass: [14, 93], mid: [15, 94], treble: [16, 95], volume: [17, 103],
  presence: [21, 102], topology: [77, 114], opClass: [73, 115], tubeConfig: [75, 116], boost: [74, 117],
  piVoltage: [78, 86], fbCap: [79, 87], reverbOn: [36, 105], reverbType: [37, 107], reverbDecay: [52, 56],
  reverbPreDelay: [53, 57], reverbTone: [54, 58], reverbMix: [55, 59], cab: [71, 110],
};

test('every channel param maps to the documented CC for A and B', () => {
  for (const [id, [a, b]] of Object.entries(EXPECTED)) {
    const p = findParam(spec, id);
    assert.ok(p, id);
    assert.equal(ccFor(p, 'A'), a, `${id} A`);
    assert.equal(ccFor(p, 'B'), b, `${id} B`);
  }
  assert.equal(spec.channelParams.length, Object.keys(EXPECTED).length);
  const amp = findParam(spec, 'amp');
  assert.equal(ccFor(amp, 'A', { withDefaults: true }), 12);
  assert.equal(ccFor(amp, 'B', { withDefaults: true }), 89);
});

test('globals and navigation CCs', () => {
  assert.equal(findParam(spec, 'lowVolume').cc, 85);
  assert.equal(findParam(spec, 'mic').cc, 82);
  assert.equal(spec.navigation.channelSelect.cc, 19);
  assert.equal(spec.navigation.channelToggle.cc, 66);
  assert.equal(spec.navigation.voicing.cc, 122);
});

test('list sizes match the documented value ranges', () => {
  assert.equal(spec.lists.amps.length, 31);   // 0-30
  assert.equal(spec.lists.cabs.length, 18);   // 0-17
  assert.equal(spec.lists.reverbs.length, 13);// 0-12
  assert.equal(spec.lists.mics.length, 9);    // 0-8
  assert.equal(spec.lists.topologies.length, 4);
});

test('ccBytes encodes status, clamps and uses MIDI channel 1 = 0xB0', () => {
  assert.deepEqual(ccBytes(1, 13, 64), [0xb0, 13, 64]);
  assert.deepEqual(ccBytes(16, 122, 7), [0xbf, 122, 7]);
  assert.deepEqual(ccBytes(1, 13, 200), [0xb0, 13, 127]);
  assert.deepEqual(ccBytes(1, 13, -4), [0xb0, 13, 0]);
});

test('voicing-scoped values are stored per channel and voicing', () => {
  const st = createState(spec);
  const amp = findParam(spec, 'amp');
  setValue(spec, st, amp, 20, 'B', 2);
  assert.equal(getValue(spec, st, amp, 'B', 2), 20);
  assert.notEqual(getValue(spec, st, amp, 'B', 1), 20);
  assert.notEqual(getValue(spec, st, amp, 'A', 2), 20);
  const drive = findParam(spec, 'drive');
  setValue(spec, st, drive, 99, 'A', 0);
  assert.equal(getValue(spec, st, drive, 'A', 3), 99, 'channel knobs ignore voicing');
});

test('current slot sends CC122 first with the right value', () => {
  const st = createState(spec);
  st.active.channel = 'B';
  st.active.voicing.B = 3;
  const steps = currentSlotSteps(spec, st);
  assert.deepEqual([steps[0].cc, steps[0].value], [122, 7]);
  assert.ok(steps.every((s) => s.value >= 0 && s.value <= 127));
  assert.ok(!steps.some((s) => [117, 86, 87].includes(s.cc)), 'DT50-only CCs excluded by default');
  const ccs = steps.slice(1).map((s) => s.cc).sort((a, b) => a - b);
  assert.deepEqual(ccs, [56, 57, 58, 59, 91, 92, 93, 94, 95, 102, 103, 105, 107, 110, 114, 115, 116]);
});

test('full sync covers all 8 slots and returns to the active slot', () => {
  const st = createState(spec);
  st.active.channel = 'A';
  st.active.voicing.A = 1;
  const steps = fullSyncSteps(spec, st);
  const selects = steps.filter((s) => s.cc === 122).map((s) => s.value);
  assert.deepEqual(selects, [0, 1, 2, 3, 4, 5, 6, 7, 1]);
  assert.deepEqual(steps.slice(0, 2).map((s) => s.cc), [85, 82]);
  const withDt50 = fullSyncSteps(spec, st, { models: ['DT50'] });
  assert.ok(withDt50.some((s) => s.cc === 74) && withDt50.some((s) => s.cc === 117));
});

test('normalizeState repairs partial presets', () => {
  const st = normalizeState(spec, { active: { channel: 'B' }, channels: { A: { values: { drive: 5 } } } });
  assert.equal(st.active.channel, 'B');
  assert.equal(st.channels.A.values.drive, 5);
  assert.equal(st.channels.B.values.drive, 64);
  assert.equal(st.channels.B.voicings[3].amp, 22);
});
