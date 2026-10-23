// Bluetooth LE MIDI output over Web Bluetooth, shaped like a Web MIDI MIDIOutput so MidiOut can use it as-is.
// Spec: "Specification for MIDI over Bluetooth Low Energy" (MMA/Apple). Each packet is a header byte with the
// high 6 bits of a 13-bit ms timestamp, then for every message a timestamp-low byte followed by the MIDI bytes.

export const BLE_MIDI_SERVICE = '03b80e5a-ede8-4b33-a751-6ce34ec4c700';
export const BLE_MIDI_CHAR = '7772e5db-3868-4112-a1a9-f2669d106bf3';

const MAX_PER_PACKET = 4; // 1 header + 4 x (ts + 3 bytes) = 17, fits the default 20-byte payload

export function blePacket(messages, now = performance.now()) {
  const ts = Math.floor(now) & 0x1fff;
  const header = 0x80 | (ts >> 7);
  const tsLow = 0x80 | (ts & 0x7f);
  const out = [header];
  for (const m of messages) out.push(tsLow, ...m);
  return new Uint8Array(out);
}

export function bleSupported() {
  return typeof navigator !== 'undefined' && !!navigator.bluetooth;
}

class BleMidiOutput extends EventTarget {
  constructor(device, characteristic) {
    super();
    this.device = device;
    this.characteristic = characteristic;
    this.id = `ble:${device.id}`;
    this.name = device.name || 'Bluetooth MIDI';
    this.manufacturer = 'Bluetooth';
    this.state = 'connected';
    this.queue = [];
    this.busy = false;
    device.addEventListener('gattserverdisconnected', () => {
      this.state = 'disconnected';
      this.queue = [];
      this.dispatchEvent(new Event('statechange'));
    });
  }

  // Writes must not overlap on GATT, so messages queue up and go out a few per packet.
  send(bytes) {
    if (this.state !== 'connected') throw new Error(`${this.name} is disconnected.`);
    this.queue.push([...bytes]);
    this.pump();
  }

  async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length && this.state === 'connected') {
        const packet = blePacket(this.queue.splice(0, MAX_PER_PACKET));
        const c = this.characteristic;
        await (c.writeValueWithoutResponse ? c.writeValueWithoutResponse(packet) : c.writeValue(packet));
      }
    } catch (err) {
      this.queue = [];
      this.dispatchEvent(new CustomEvent('error', { detail: err }));
    } finally {
      this.busy = false;
    }
  }

  disconnect() {
    try { this.device.gatt.disconnect(); } catch { /* already gone */ }
  }
}

async function open(device) {
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(BLE_MIDI_SERVICE);
  const characteristic = await service.getCharacteristic(BLE_MIDI_CHAR);
  // Some adapters only accept writes once notifications are on.
  try { await characteristic.startNotifications(); } catch { /* optional */ }
  return new BleMidiOutput(device, characteristic);
}

/** Show the browser's device picker (needs a user tap) and connect to the chosen BLE MIDI device. */
export async function requestBleMidi() {
  const device = await navigator.bluetooth.requestDevice({ filters: [{ services: [BLE_MIDI_SERVICE] }] });
  return open(device);
}

/** Reconnect to a device picked before, without the picker. Only works where the browser supports getDevices(). */
export async function reconnectBleMidi(deviceId) {
  if (!navigator.bluetooth?.getDevices) return null;
  const device = (await navigator.bluetooth.getDevices()).find((d) => d.id === deviceId);
  if (!device) return null;
  return open(device);
}
