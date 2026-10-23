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
  presence: [21, 102], opClass: [73, 115], tubeConfig: [75, 116], boost: [74, 117],
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
  assert.deepEqual(spec.navigation.voicing.cc, { A: 77, B: 114 });
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

test('current slot selects channel (CC19) then voicing (CC77/114)', () => {
  const st = createState(spec);
  st.active.channel = 'B';
  st.active.voicing.B = 3;
  const steps = currentSlotSteps(spec, st);
  assert.deepEqual(steps.slice(0, 2).map((s) => [s.cc, s.value]), [[19, 127], [114, 3]]);
  assert.ok(steps.every((s) => s.value >= 0 && s.value <= 127));
  assert.ok(!steps.some((s) => [117, 86, 87, 122].includes(s.cc)), 'no DT50-only or CC122 by default');
  const ccs = steps.slice(2).map((s) => s.cc).sort((a, b) => a - b);
  assert.deepEqual(ccs, [56, 57, 58, 59, 91, 92, 93, 94, 95, 102, 103, 105, 107, 110, 115, 116]);
});

test('full sync covers all 8 slots and returns to the active slot', () => {
  const st = createState(spec);
  st.active.channel = 'A';
  st.active.voicing.A = 1;
  const steps = fullSyncSteps(spec, st);
  const selects = steps.filter((s) => s.id === 'channel' || s.id === 'voicing').map((s) => `${s.cc}=${s.value}`);
  assert.deepEqual(selects, ['19=0', '77=0', '19=0', '77=1', '19=0', '77=2', '19=0', '77=3',
    '19=127', '114=0', '19=127', '114=1', '19=127', '114=2', '19=127', '114=3', '19=0', '77=1']);
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

test('older firmware mode only sends Pilot\'s Guide CCs', async () => {
  const { legacySpec } = await import('../js/state.js');
  const L = legacySpec(spec);
  const st = createState(L);
  st.active.channel = 'B';
  st.active.voicing.B = 2;
  const slot = currentSlotSteps(L, st);
  assert.deepEqual(slot.map((s) => [s.cc, s.value]).slice(0, 2), [[19, 127], [114, 2]]);
  assert.deepEqual(slot.slice(2).map((s) => s.cc).sort((a, b) => a - b), [105, 115, 116]);
  const all = fullSyncSteps(L, st).map((s) => s.cc);
  const allowed = new Set([19, 77, 114, 73, 75, 36, 115, 116, 105]);
  assert.ok(all.every((cc) => allowed.has(cc)), `unexpected CC in ${all}`);
  assert.ok(!all.includes(122));
  assert.deepEqual(all.slice(-2), [19, 114], 'ends on the active channel and voicing');
});

test('BLE MIDI packet framing', async () => {
  const { blePacket } = await import('../js/ble.js');
  // ts = 0x1234 & 0x1fff = 0x1234 -> header 0x80 | 0x24, low 0x80 | 0x34
  assert.deepEqual([...blePacket([[0xb0, 13, 74]], 0x1234)], [0xa4, 0xb4, 0xb0, 13, 74]);
  assert.deepEqual([...blePacket([[0xb0, 19, 0], [0xb0, 77, 2]], 5)],
    [0x80, 0x85, 0xb0, 19, 0, 0x85, 0xb0, 77, 2]);
});
