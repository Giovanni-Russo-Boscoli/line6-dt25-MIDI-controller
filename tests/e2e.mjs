// End-to-end: drives the real UI in Chromium with a fake Web MIDI output and checks the bytes sent.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const URL = process.env.URL || 'http://localhost:8080/';
const SHOTS = process.env.SHOTS;

const mock = () => {
  window.__sent = [];
  const output = {
    id: 'fake-1', name: 'USB MIDI Interface', manufacturer: 'Test', state: 'connected', type: 'output',
    open: async () => output,
    send: (bytes) => window.__sent.push(Array.from(bytes)),
  };
  const access = new EventTarget();
  access.outputs = new Map([[output.id, output]]);
  access.inputs = new Map();
  navigator.requestMIDIAccess = async () => access;
};

const browser = await chromium.launch();
const errors = [];
async function run(viewport, name) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.addInitScript(mock);
  await page.goto(URL);
  return page;
}

const page = await run({ width: 1280, height: 900 });
const sent = async () => page.evaluate(() => window.__sent.splice(0));

// Connect
await page.click('#connBtn');
await page.click('#midiEnable');
await page.waitForFunction(() => document.querySelector('#connText').textContent.includes('USB MIDI'));
await page.selectOption('#outputSelect', 'fake-1');
await page.click('#testSend');
assert.deepEqual(await sent(), [[0xb0, 122, 0]], 'test send selects Ch A voicing I');
await page.click('.diag summary');
await page.click('[data-diag="19:127"]');
await page.fill('#diagCC', '122'); await page.fill('#diagVal', '4');
await page.click('#diagSend');
assert.deepEqual(await sent(), [[0xb0, 19, 127], [0xb0, 122, 4]], 'troubleshoot buttons');
await page.click('#connDialog button[value=close]');

// Knob: keyboard on Drive (A, CC13)
const drive = page.locator('.knob[data-param=drive]').first();
await drive.focus();
await page.keyboard.press('End');
await page.waitForFunction((cc) => window.__sent.some((m) => m[1] === cc), 13);
{ const m = await sent(); assert.deepEqual(m.at(-1), [0xb0, 13, 127], 'drive max on CC13'); }

// Knob drag sends coalesced values on CC 14 (bass)
const bass = page.locator('.knob[data-param=bass]').first();
const box = await bass.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - i * 6);
await page.mouse.up();
await page.waitForFunction((cc) => window.__sent.some((m) => m[1] === cc), 14);
const bassMsgs = await sent();
assert.ok(bassMsgs.length > 0 && bassMsgs.every((m) => m[0] === 0xb0 && m[1] === 14), 'bass drag on CC14');
assert.ok(bassMsgs.at(-1)[2] > 64, 'bass increased');

// Amp picker next arrow: amp model 1 -> 2 on CC11
await page.click('button[aria-label="Next HD Amp"]');
assert.deepEqual(await sent(), [[0xb0, 11, 2]]);
// Amp with defaults: CC12
await page.check('#ampDefaults');
await page.selectOption('select[data-param=amp]', '20');
assert.deepEqual(await sent(), [[0xb0, 12, 20]]);
await page.uncheck('#ampDefaults');

// Power amp toggles on channel A
await page.click('[data-param=opClass] .seg >> text=Class A');
await page.click('[data-param=tubeConfig] .seg >> text=Triode');
await page.click('[data-param=topology] .seg >> text=Resonant');
assert.deepEqual(await sent(), [[0xb0, 73, 0], [0xb0, 75, 0], [0xb0, 77, 3]]);

// Cab, reverb, globals
await page.selectOption('select[data-param=cab]', '16');
await page.click('.stomp[data-param=reverbOn]');
await page.selectOption('select[data-param=reverbType]', '12');
await page.selectOption('select[data-param=mic]', '6');
await page.click('[data-param=lowVolume] .seg >> text=Low Vol');
assert.deepEqual(await sent(), [[0xb0, 71, 16], [0xb0, 36, 0], [0xb0, 37, 12], [0xb0, 82, 6], [0xb0, 85, 127]]);

// Switch to channel B voicing III -> CC122 = 6, then edits use channel B CCs
await page.click('.chan[data-ch=B]');
await page.click('.voice[data-v="2"]');
assert.deepEqual(await sent(), [[0xb0, 122, 4], [0xb0, 122, 6]]);
const driveB = page.locator('.knob[data-param=drive]').first();
await driveB.focus();
await page.keyboard.press('Home');
await page.waitForFunction((cc) => window.__sent.some((m) => m[1] === cc), 92);
await page.click('[data-param=topology] .seg >> text=Loose');
await page.selectOption('select[data-param=cab]', '3');
const reverbMixB = page.locator('#reverbKnobs .knob[data-param=reverbMix]');
await reverbMixB.focus();
await page.keyboard.press('End');
await page.waitForFunction((cc) => window.__sent.some((m) => m[1] === cc), 59);
assert.deepEqual(await sent(), [[0xb0, 92, 0], [0xb0, 114, 1], [0xb0, 110, 3], [0xb0, 59, 127]]);
// Twin Reverb knob on the faceplate follows
assert.equal(await page.locator('#preampKnobs .knob[data-param=reverbMix]').getAttribute('aria-valuenow'), '127');

// Back on A voicing I, values remembered
await page.click('.chan[data-ch=A]');
assert.equal(await page.locator('.knob[data-param=drive]').first().getAttribute('aria-valuenow'), '127');
assert.equal(await page.locator('select[data-param=cab]').inputValue(), '16');
await sent();

// Sync all
await page.click('#syncAll');
await page.waitForFunction(() => !document.body.classList.contains('syncing'), null, { timeout: 10000 });
const sync = await sent();
assert.deepEqual(sync.filter((m) => m[1] === 122).map((m) => m[2]), [0, 1, 2, 3, 4, 5, 6, 7, 0]);
assert.ok(sync.every((m) => m[0] === 0xb0 && m[2] <= 127));
console.log(`sync sent ${sync.length} messages`);

// MIDI channel setting changes the status byte
await page.click('#connBtn');
await page.selectOption('#channelSelect', '3');
await page.click('#connDialog button[value=close]');
await page.click('.voice[data-v="1"]');
assert.deepEqual(await sent(), [[0xb2, 122, 1]]);
await page.click('#connBtn');
await page.selectOption('#channelSelect', '1');
await page.click('#connDialog button[value=close]');

// Persistence across reload
await page.reload();
assert.equal(await page.locator('.voice[data-v="1"]').getAttribute('aria-checked'), 'true');

// Info mode
assert.equal(await page.locator('#helpPop').isHidden(), true);
await page.click('[data-label=topology]');
assert.equal(await page.locator('#helpPop').isHidden(), true, 'labels inert while Info is off');
await page.click('#infoBtn');
assert.equal(await page.locator('.help-link').count() >= 15, true);
await page.click('[data-label=topology]');
assert.match(await page.locator('#helpText').textContent(), /negative feedback/);
const before = await page.isChecked('#ampDefaults');
await page.click('[data-label=ampDefaults]');
assert.equal(await page.isChecked('#ampDefaults'), before, 'help link does not toggle the checkbox');
assert.match(await page.locator('#helpTitle').textContent(), /Load amp defaults/);
await page.click('.help-chip >> nth=0');
assert.equal(await page.locator('#helpPop').isVisible(), true);
await page.keyboard.press('Escape');
assert.equal(await page.locator('#helpPop').isHidden(), true);
assert.equal(await page.locator('[data-label=drive]').count(), 1);
assert.equal(await page.locator('[data-label=drive].help-link').count(), 0, 'drive has no help');
await sent();
assert.deepEqual(await sent(), [], 'help clicks send no MIDI');

// Profile save / load round trip
page.on('dialog', (d) => d.accept());
await page.evaluate(() => { document.querySelectorAll('.voice')[3].click(); });
await page.click('#profileBtn');
await page.fill('#profileName', 'Gig rig');
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#profileSave')]);
assert.equal(dl.suggestedFilename(), 'Gig-rig.dt25profile.json');
const profilePath = await dl.path();
const { readFileSync, writeFileSync } = await import('node:fs');
const prof = JSON.parse(readFileSync(profilePath, 'utf8'));
assert.equal(prof.format, 'dt25-control-profile');
assert.ok(prof.presets.length >= 3 && prof.current.state && !('outputId' in prof.settings));
const savedAmp = prof.current.state.channels.A.voicings[3].amp;
await page.click('#profileDialog button[value=close]');
// Change things after saving, then load the file back.
await page.selectOption('select[data-param=amp]', String((savedAmp + 5) % 31));
await page.click('#connBtn');
await page.check('#showDt50');
await page.click('#connDialog button[value=close]');
await page.click('#profileBtn');
await Promise.all([page.waitForEvent('load'), page.setInputFiles('#profileLoad', profilePath)]);
assert.equal(await page.locator('select[data-param=amp]').inputValue(), String(savedAmp), 'amp restored');
assert.equal(await page.locator('.voice[data-v="3"]').getAttribute('aria-checked'), 'true', 'voicing restored');
assert.equal(await page.locator('#dt50Controls').isHidden(), true, 'settings restored');
assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('dt25.prefs.v1')).outputId), 'fake-1', 'MIDI port kept');
// A preset-only file is rejected as a profile.
const bad = profilePath + '.bad.json';
writeFileSync(bad, JSON.stringify({ format: 'dt25-control-presets', presets: [] }));
await page.click('#profileBtn');
await page.setInputFiles('#profileLoad', bad);
await page.waitForFunction(() => document.getElementById('toast').textContent.includes('Not a DT25 Control profile'));
await page.click('#profileDialog button[value=close]');

// Older firmware mode
await page.click('#connBtn');
await Promise.all([page.waitForEvent('load'), page.selectOption('#firmwareSelect', 'legacy')]);
await page.click('#connBtn');
await page.click('#midiEnable');
await page.click('#connDialog button[value=close]');
await page.waitForFunction(() => document.querySelector('#connText').textContent.includes('USB MIDI'));
await sent();
assert.equal(await page.locator('#legacyCard').isVisible(), true);
assert.equal(await page.locator('#sec-preamp').isVisible(), false);
assert.equal(await page.locator('select[data-param=amp]').count(), 0, 'amp model not offered');
await page.click('.chan[data-ch=B]');
await page.click('.voice[data-v="2"]');
await page.click('[data-param=opClass] .seg >> nth=0');
await page.click('[data-param=opClass] .seg >> nth=1');
await page.click('.stomp[data-param=reverbOn]');
const legacyMsgs = await sent();
assert.deepEqual(legacyMsgs.slice(0, 4), [[0xb0, 19, 127], [0xb0, 114, legacyMsgs[1][2]], [0xb0, 19, 127], [0xb0, 114, 2]]);
assert.deepEqual(legacyMsgs.slice(4), [[0xb0, 115, 0], [0xb0, 115, 127], [0xb0, 105, legacyMsgs.at(-1)[2]]]);
await page.click('#syncAll');
await page.waitForFunction(() => !document.body.classList.contains('syncing'), null, { timeout: 10000 });
const legacySync = await sent();
assert.ok(legacySync.every((m) => [19, 77, 114, 73, 75, 36, 115, 116, 105].includes(m[1])), 'legacy sync uses old CCs only');
if (SHOTS) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${SHOTS}/legacy.png` });
}
await page.click('#legacyOff');
await page.waitForFunction(() => !document.body.classList.contains('legacy'));
await page.waitForSelector('select[data-param=amp]');

if (SHOTS) {
  await page.click('#profileBtn');
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${SHOTS}/profile.png` });
  await page.click('#profileDialog button[value=close]');
  await page.click('[data-label=topology]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/info.png` });
  await page.keyboard.press('Escape');
  await page.click('#infoBtn');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${SHOTS}/desktop.png`, fullPage: true });
  await page.click('.chan[data-ch=B]');
  await page.screenshot({ path: `${SHOTS}/desktop-b.png` });
  const phone = await run({ width: 390, height: 844 });
  await phone.screenshot({ path: `${SHOTS}/phone.png`, fullPage: true });
  await phone.click('#infoBtn');
  await phone.click('[data-label=opClass]');
  await phone.waitForTimeout(300);
  await phone.screenshot({ path: `${SHOTS}/phone-info.png` });
}

await browser.close();
assert.deepEqual(errors, [], 'no page errors');
console.log('e2e OK');
