# DT25 Control

A browser-based MIDI controller for the Line 6 DT25 (firmware 2.0+). It sends MIDI CC messages through any
USB-to-MIDI interface to the amp's 5-pin MIDI IN, covering every parameter in the
*DT Amplifier MIDI Implementation Guide*.

## Open it

Hosted on GitHub Pages, so on a phone you just open the Pages URL in Chrome (Android). No server needed.

## Run it locally

Web MIDI needs `https://` or `localhost`, so serve the folder instead of opening `index.html` directly:

```sh
cd dt25-midi-controller
python3 -m http.server 8080      # or: npx http-server -p 8080
```

Open http://localhost:8080 in **Chrome, Edge or Opera** (desktop or Android). Safari on iPhone/iPad has no Web MIDI.
Firefox works after you allow its MIDI site permission.

## Hook-up

USB interface **MIDI OUT** plug → DT25 **MIDI IN**. Click **Connect MIDI**, enable Web MIDI, pick the interface.
The DT25 listens on MIDI channel 1. **Send test** selects Channel A, Voicing I (CC 122 = 0) so you can confirm the link.

## How it maps to the amp

| Area | Controls | Stored on the amp per |
| --- | --- | --- |
| Channel / Voicing | A/B sends CC 19, I–IV sends CC 77 (A) / 114 (B). Voicing = NFL topology (Tight, Loose, Zero, Resonant). CC 122 is documented but did not respond on a real DT25 | — |
| Preamp | HD Amp (CC 11/91, or 12/89 with "Load amp defaults"), Drive, Bass, Mid, Treble, Presence, Reverb, Volume | Amp: voicing. Knobs: channel |
| Power amp | Class A/AB, Triode/Pentode | voicing |
| Cab | 17 cabs + None | voicing |
| Reverb | On/Off, 12 types, Decay, Pre Delay, Tone, Mix | Type/Decay/Pre/Tone: voicing. On + Mix: channel |
| Global | Low Volume Mode, XLR mic emulation, channel toggle (CC 66) | amp |
| DT50 only | 12AX7 boost, PI B+ voltage, feedback cap (hidden unless enabled in the connection sheet) | voicing |

The amp has no MIDI output and no Program Change, so the app keeps its own copy of all 8 channel/voicing
slots. **Send slot** re-sends the current slot; **Sync all** pushes globals plus all 8 slots (about 100 messages,
~1.5 s). Presets are full snapshots stored in this browser; loading one syncs the amp. Export/Import moves them
between devices as JSON.

**Info** (top bar) turns the less obvious labels into purple underlined links; hover or tap one for an explanation. Texts live in the `help` section of `data/dt25-params.json`.

**Profile** (top bar) saves everything kept in the browser (all presets, the current unsaved tweaks and the settings)
to a `.dt25profile.json` file, and loads such a file back, replacing what's in that browser. Use it for backups or to
move your setup between phone and computer. The selected MIDI interface is not included because it differs per device.

**Older firmware:** amps on firmware before 2.0 only accept the Pilot's Guide CCs. Set *Connect MIDI → Amp firmware → Older than 2.0*
and the app switches to channel (CC 19), voicing (CC 77 / 114), Class A/AB, Triode/Pentode and reverb on/off only.

Knobs: drag up/down (Shift for fine), mouse wheel, arrow keys, double-click to reset.

All parameter definitions live in `data/dt25-params.json`; the UI is generated from it.

## Tests

```sh
node --test tests/state.test.mjs   # CC map and message building
node tests/e2e.mjs                 # drives the UI in Chromium with a fake MIDI port (needs playwright, server on :8080)
```
