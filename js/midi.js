// Web MIDI output wrapper. The DT25 only receives (no MIDI feedback), so this is send-only.

/** Encode a Control Change message. channel is 1-16. */
export function ccBytes(channel, cc, value) {
  const ch = Math.min(16, Math.max(1, channel | 0)) - 1;
  const v = Math.min(127, Math.max(0, Math.round(value)));
  return [0xb0 | ch, cc & 0x7f, v];
}

export function toHex(bytes) {
  return bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

export class MidiOut extends EventTarget {
  constructor() {
    super();
    this.access = null;
    this.output = null;
    this.ble = null; // Bluetooth MIDI output, listed next to the Web MIDI ports
    this.channel = 1;
    this.pending = new Map(); // cc -> value, coalesced per animation frame
    this.frame = 0;
    this.queueEnd = 0; // performance.now() timestamp the scheduled queue drains at
  }

  get supported() {
    return typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator;
  }

  get connected() {
    return !!this.output && this.output.state !== 'disconnected';
  }

  async init() {
    if (!this.supported) throw new Error('Web MIDI is not supported in this browser.');
    this.access = await navigator.requestMIDIAccess({ sysex: false });
    // Some cheap USB-MIDI cables fire bursts of connect/disconnect events on Android when plugged in.
    // Coalesce them so the page only refreshes its port list once things settle.
    let settle = 0;
    this.access.addEventListener('statechange', () => {
      clearTimeout(settle);
      settle = setTimeout(() => {
        if (this.output && this.output.state === 'disconnected') this.output = null;
        this.emit('ports');
      }, 250);
    });
    this.emit('ports');
    return this.outputs();
  }

  outputs() {
    const list = this.access ? [...this.access.outputs.values()] : [];
    if (this.ble && this.ble.state === 'connected') list.push(this.ble);
    return list;
  }

  /** Use a Bluetooth MIDI output (see ble.js) and select it. */
  attachBle(out) {
    if (this.ble && this.ble !== out) this.ble.disconnect();
    this.ble = out;
    out.addEventListener('statechange', () => {
      if (this.output === out) this.output = null;
      this.emit('ports');
      this.emit('bledisconnect', { name: out.name });
    });
    out.addEventListener('error', (e) => this.emit('error', { message: e.detail.message }));
    this.output = out;
    this.emit('ports');
    return out;
  }

  async select(id) {
    const out = this.outputs().find((o) => o.id === id) || null;
    if (out && out.open) {
      try { await out.open(); } catch { /* some browsers open lazily on send */ }
    }
    this.output = out;
    this.emit('ports');
    return out;
  }

  /** Send a CC immediately (or at a scheduled timestamp). */
  cc(cc, value, at) {
    const bytes = ccBytes(this.channel, cc, value);
    if (this.output) {
      try {
        at ? this.output.send(bytes, at) : this.output.send(bytes);
      } catch (err) {
        this.emit('error', { message: err.message });
      }
    }
    this.emit('sent', { bytes, cc, value: bytes[2], live: !!this.output });
    return bytes;
  }

  /** Coalesce rapid knob moves: only the latest value per CC goes out each frame. */
  ccLive(cc, value) {
    this.pending.set(cc, value);
    if (this.frame) return;
    const flush = () => {
      this.frame = 0;
      const items = [...this.pending];
      this.pending.clear();
      for (const [c, v] of items) this.cc(c, v);
    };
    this.frame = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(flush)
      : setTimeout(flush, 16);
  }

  /**
   * Send a list of steps spaced in time so the amp can keep up over 31.25 kbaud DIN.
   * steps: [{ cc, value, wait? }] where wait is extra ms to pause after that message.
   * Resolves when the last message has gone out.
   */
  sequence(steps, gap = 8) {
    let t = Math.max(performance.now(), this.queueEnd);
    return new Promise((resolve) => {
      for (const step of steps) {
        const when = t;
        setTimeout(() => this.cc(step.cc, step.value), Math.max(0, when - performance.now()));
        t += gap + (step.wait || 0);
      }
      this.queueEnd = t;
      setTimeout(resolve, Math.max(0, t - performance.now()));
    });
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
