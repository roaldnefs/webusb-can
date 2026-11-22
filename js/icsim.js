// ═══════════════════════════════════════════════════════
//  In-browser CAN simulator (loopback)
//
//  Protocol — IDs and byte layout match the reference Linux instrument-
//  cluster simulator so existing workshop materials apply unchanged:
//    Speed:   ID 0x244, bytes [3..4]  encoded = (kmh * 100) big-endian
//    Signals: ID 0x188, byte 0        bit 0 = left, bit 1 = right
//    Doors:   ID 0x19B, byte 2        bits 0..3 = door 1..4 unlocked
//
//  The sim acts as both a producer (each message on its own cycle time,
//  like separate ECUs on a real bus) and a consumer (decodes incoming
//  frames so users can replay/fuzz). All emitted frames flow through the
//  existing RX pipeline (addLogEntry + ingestFrame + dispatchRx), so the
//  log, sniffer, and ISO-TP / UDS layers see them exactly as if they came
//  from a real CAN device. A simulated engine ECU (sim-ecu.js) answers
//  UDS / OBD-II requests on 0x7E0 / 0x7DF.
// ═══════════════════════════════════════════════════════

import { state } from './state.js';
import { addLogEntry } from './ui.js';
import { dispatchRx } from './reader.js';
import { resetVehicle, stepVehicle, TOP_SPEED_KMH, RPM_MAX } from './sim-vehicle.js';
import { createEcu } from './sim-ecu.js';

const TICK_MS = 10;
// If no external (queueTx) write for a given axis arrives within this window,
// the cluster reverts to its default for that axis. Lets the user disable a
// periodic signal in the sidebar and watch the cluster go back to neutral.
const STALE_MS = 300;

// Bogus / noise traffic — the workshop puzzle is harder when the bus has
// dozens of unrelated IDs cycling at varying cadences (mirrors ICSim).
const NOISE_POOL_SIZE = 24;
const NOISE_INTERVALS = [50, 100, 100, 200, 200, 500, 1000];
const NOISE_DLCS = [8, 8, 8, 8, 6, 4, 3, 2];
const NOISE_KINDS = ['static', 'static', 'counter', 'sensor', 'flags'];
const noisePool = [];

const ICSIM = {
  SPEED_ID: 0x244,
  SPEED_BYTE: 3,
  SIGNAL_ID: 0x188,
  SIGNAL_BYTE: 0,
  SIGNAL_LEFT: 0x01,
  SIGNAL_RIGHT: 0x02,
  DOOR_ID: 0x19B,
  DOOR_BYTE: 2,
  DOOR_BITS: [0x01, 0x02, 0x04, 0x08], // door 1..4
  RPM_ID: 0x0AA,
  RPM_BYTE: 4,
  RPM_SCALE: 32,           // RPM = byte4 * RPM_SCALE  (range 0..8160)

  // Car Hacking Village challenges
  IMMO_ID: 0x3D0,          // immobilizer silence (cyclic all-zero)
  AIRBAG_ID: 0x050,        // airbag silence (alternate)
  VIN_ID: 0x65D,           // VIN broadcast (3-frame ASCII split)
  ABS_ID: 0x4A0,           // ABS wheel speeds (4× big-endian uint16, kmh × 100)

  // Broadcast-only extras (the cluster reads these straight from the model).
  POWERTRAIN_ID: 0x1D0,    // byte 0 gear, byte 1 throttle 0..255, byte 2 brake
  ENGINE_ID: 0x3B4,        // byte 0 coolant °C + 40, byte 1 fuel 0..255
  ODO_ID: 0x5C8,           // 3 bytes big-endian, km × 10

  // Fuzz easter eggs — discoverable via fuzzing one ID at a time.
  FUZZ_OIL: { id: 0x350, byte: 7, value: 0xFF },
  FUZZ_LCD: { id: 0x412, byte: 0, value: 0x42 },
  FUZZ_CE:  { id: 0x4F0, byte: 0, value: 0xA5 },
};

const DOOR_KEYS = ['FL', 'FR', 'RL', 'RR']; // mapped 1..1 to bits 0..3

const SILENCE_MS = 200;        // max gap where IMMO/AIRBAG silence holds
const SPEED_TOL_KMH = 10;      // 0x244 vs ABS-avg tolerance (Challenge 07)
const VIN_INTERVAL_MS = 1000;  // total cycle for the 3 VIN chunks
const BLINK_HALF_MS = 350;     // turn-signal on / off phase (~85 flashes/min)
const WHEEL_SCALE = [1, 1.002, 0.999, 1.003];   // FL FR RL RR tyre wear
const SWEEP_MS = 1200;         // ignition-on needle sweep
const BULB_CHECK_MS = 1500;    // ignition-on warning lamp test
const NEEDLE_LAG_S = 0.08;     // gauge needle inertia
const EGG_FLASH_MS = 1500;
const LCD_FLASH_MS = 2000;
const VIN_STR = 'WVWZZZ1KZAW123456';   // 17 chars, valid VAG-style format

// Live sim state. Mutated by user controls (clicks) AND by incoming frames.
//
//  - `held.*` is the cluster's own button state. A held door stays open;
//    a held turn signal blinks (the bit toggles on the bus, like a real
//    flasher relay).
//  - `signalLeft` / `signalRight` / `doors` are the cluster's *display*
//    state. Reflects either the held flag or the most recent external
//    frame; decays when neither source is active for STALE_MS.
//  - `lastExt.*` is the last time an external frame (onControlFrame) wrote
//    that axis. Used by the decay check.
const sim = {
  acceleratorPressed: false,
  brakePressed: false,
  signalLeft: false,
  signalRight: false,
  doors: { FL: false, FR: false, RL: false, RR: false },
  held: {
    signalLeft: false,
    signalRight: false,
    doors: { FL: false, FR: false, RL: false, RR: false },
  },
  lastExt: { signal: 0, door: 0, speed: 0, rpm: 0, immobilizer: 0, airbag: 0, wheelSpeed: 0 },
  warn: { immobilizer: true, airbag: true, oilPressure: false, checkEngine: false },
  lcdText: '',
  lcdUntil: 0,
  eggUntil: { oil: 0, ce: 0 },
  wheelSpeedKmh: 0,
  vinChunkIdx: 0,
  blinkStart: 0,
  lastTick: 0,
  startedAt: 0,
};
resetVehicle(sim);   // speedKmh, rpm, gear, coolantC, fuelPct, odoKm

// Gauge needle positions — lag behind the real values (see renderCluster).
const needle = { speedKmh: 0, rpm: 0, lastRender: 0 };

const ecu = createEcu({
  send: emitRx,
  live: () => sim,
  vin: VIN_STR,
  // ECU hard reset re-runs the ignition-on self test.
  onReset: () => { sim.startedAt = performance.now(); },
});

// ────────────────────────────────────────────────
//  Encode / decode helpers
// ────────────────────────────────────────────────

// Alive counter (byte 6, low nibble) + XOR checksum (byte 7), as carried by
// most real powertrain frames. The cluster doesn't validate them, so
// hand-crafted and replayed frames keep working.
const aliveCounters = new Map();
function protect(id, data) {
  const counter = aliveCounters.get(id) || 0;
  aliveCounters.set(id, (counter + 1) & 0x0F);
  data[6] = counter;
  data[7] = data.slice(0, 7).reduce((a, b) => a ^ b, 0);
  return data;
}

// Sensor readings wobble a little while the car is moving.
function sensorSpeed(scale = 1) {
  if (sim.speedKmh <= 0) return 0;
  const kmh = sim.speedKmh * scale + (Math.random() - 0.5) * 0.08;
  return Math.max(0, Math.min(0xFFFF, Math.round(kmh * 100)));
}

function encodeSpeedFrame() {
  const enc = sensorSpeed();
  const data = [0, 0, 0, (enc >> 8) & 0xFF, enc & 0xFF, 0, 0, 0];
  return { id: ICSIM.SPEED_ID, data: protect(ICSIM.SPEED_ID, data), dlc: 8, isExtended: false };
}

function encodeSignalFrame() {
  const data = [0, 0, 0, 0, 0, 0, 0, 0];
  let b = 0;
  if (sim.signalLeft)  b |= ICSIM.SIGNAL_LEFT;
  if (sim.signalRight) b |= ICSIM.SIGNAL_RIGHT;
  data[ICSIM.SIGNAL_BYTE] = b;
  return { id: ICSIM.SIGNAL_ID, data, dlc: 8, isExtended: false };
}

function encodeDoorFrame() {
  const data = [0, 0, 0, 0, 0, 0, 0, 0];
  let b = 0;
  for (let i = 0; i < 4; i++) {
    if (sim.doors[DOOR_KEYS[i]]) b |= ICSIM.DOOR_BITS[i];
  }
  data[ICSIM.DOOR_BYTE] = b;
  return { id: ICSIM.DOOR_ID, data, dlc: 8, isExtended: false };
}

function encodeRpmFrame() {
  const data = [0, 0, 0, 0, 0, 0, 0, 0];
  data[ICSIM.RPM_BYTE] = Math.max(0, Math.min(0xFF, Math.round(sim.rpm / ICSIM.RPM_SCALE)));
  return { id: ICSIM.RPM_ID, data: protect(ICSIM.RPM_ID, data), dlc: 8, isExtended: false };
}

function encodePowertrainFrame() {
  const data = [sim.gear, sim.acceleratorPressed ? 0xFF : 0, sim.brakePressed ? 1 : 0, 0, 0, 0, 0, 0];
  return { id: ICSIM.POWERTRAIN_ID, data: protect(ICSIM.POWERTRAIN_ID, data), dlc: 8, isExtended: false };
}

function encodeEngineFrame() {
  const data = [Math.round(sim.coolantC) + 40, Math.round(sim.fuelPct * 2.55)];
  return { id: ICSIM.ENGINE_ID, data, dlc: 2, isExtended: false };
}

function encodeOdometerFrame() {
  const enc = Math.round(sim.odoKm * 10);
  const data = [(enc >> 16) & 0xFF, (enc >> 8) & 0xFF, enc & 0xFF];
  return { id: ICSIM.ODO_ID, data, dlc: 3, isExtended: false };
}

// VIN broadcast — 17 chars across 3 frames. Byte 0 is a sequence index;
// bytes 1..7 carry up to 7 ASCII chars each.
function encodeVinFrame(idx) {
  const data = [idx & 0xFF, 0, 0, 0, 0, 0, 0, 0];
  const start = idx * 7;
  for (let i = 0; i < 7; i++) {
    const ch = VIN_STR.charCodeAt(start + i);
    data[1 + i] = isNaN(ch) ? 0 : ch & 0xFF;
  }
  return { id: ICSIM.VIN_ID, data, dlc: 8, isExtended: false };
}

function encodeNextVinFrame() {
  const frame = encodeVinFrame(sim.vinChunkIdx);
  sim.vinChunkIdx = (sim.vinChunkIdx + 1) % 3;
  return frame;
}

// ABS wheel speeds — 4× big-endian uint16, each kmh × 100. The simulator's
// own broadcast tracks sim.speedKmh (each wheel reads slightly differently),
// so the cluster's internal speedometer (which gates display on
// speed-vs-wheel consistency) is self-consistent.
function encodeAbsFrame() {
  const data = [];
  for (const scale of WHEEL_SCALE) {
    const enc = sensorSpeed(scale);
    data.push((enc >> 8) & 0xFF, enc & 0xFF);
  }
  return { id: ICSIM.ABS_ID, data, dlc: 8, isExtended: false };
}

function decodeAndApply(id, data) {
  const now = performance.now();
  if (id === ICSIM.SPEED_ID && data.length > ICSIM.SPEED_BYTE + 1) {
    const enc = (data[ICSIM.SPEED_BYTE] << 8) | data[ICSIM.SPEED_BYTE + 1];
    sim.speedKmh = enc / 100;
    sim.lastExt.speed = now;
    return true;
  }
  if (id === ICSIM.SIGNAL_ID && data.length > ICSIM.SIGNAL_BYTE) {
    const b = data[ICSIM.SIGNAL_BYTE];
    sim.signalLeft = (b & ICSIM.SIGNAL_LEFT) !== 0;
    sim.signalRight = (b & ICSIM.SIGNAL_RIGHT) !== 0;
    sim.lastExt.signal = now;
    return true;
  }
  if (id === ICSIM.DOOR_ID && data.length > ICSIM.DOOR_BYTE) {
    const b = data[ICSIM.DOOR_BYTE];
    for (let i = 0; i < 4; i++) {
      sim.doors[DOOR_KEYS[i]] = (b & ICSIM.DOOR_BITS[i]) !== 0;
    }
    sim.lastExt.door = now;
    return true;
  }
  if (id === ICSIM.RPM_ID && data.length > ICSIM.RPM_BYTE) {
    sim.rpm = data[ICSIM.RPM_BYTE] * ICSIM.RPM_SCALE;
    sim.lastExt.rpm = now;
    return true;
  }
  // Challenge 02 — silence frames must be all-zero, matching the workshop
  // instruction literally and avoiding accidental silencing by random fuzz.
  if (id === ICSIM.IMMO_ID && data.every(b => b === 0)) {
    sim.lastExt.immobilizer = now;
    return true;
  }
  if (id === ICSIM.AIRBAG_ID && data.every(b => b === 0)) {
    sim.lastExt.airbag = now;
    return true;
  }
  // Challenge 07 — ABS wheel speeds. Average all 4 wheels.
  if (id === ICSIM.ABS_ID && data.length >= 8) {
    const w0 = ((data[0] << 8) | data[1]) / 100;
    const w1 = ((data[2] << 8) | data[3]) / 100;
    const w2 = ((data[4] << 8) | data[5]) / 100;
    const w3 = ((data[6] << 8) | data[7]) / 100;
    sim.wheelSpeedKmh = (w0 + w1 + w2 + w3) / 4;
    sim.lastExt.wheelSpeed = now;
    return true;
  }
  // Challenge 06 — fuzz easter eggs. Each fires only on a specific (id, byte, value).
  if (id === ICSIM.FUZZ_OIL.id && data[ICSIM.FUZZ_OIL.byte] === ICSIM.FUZZ_OIL.value) {
    sim.warn.oilPressure = true;
    sim.eggUntil.oil = now + EGG_FLASH_MS;
    return true;
  }
  if (id === ICSIM.FUZZ_LCD.id && data[ICSIM.FUZZ_LCD.byte] === ICSIM.FUZZ_LCD.value) {
    sim.lcdText = 'ECO MODE';
    sim.lcdUntil = now + LCD_FLASH_MS;
    return true;
  }
  if (id === ICSIM.FUZZ_CE.id && data[ICSIM.FUZZ_CE.byte] === ICSIM.FUZZ_CE.value) {
    sim.warn.checkEngine = true;
    sim.eggUntil.ce = now + EGG_FLASH_MS;
    return true;
  }
  return false;
}

// Periodic messages the simulated ECUs broadcast, each on its own cycle
// time. `when` gates emission; `due` is set by startSim.
const MESSAGES = [
  { interval: 20,   encode: encodeSpeedFrame },
  { interval: 20,   encode: encodeRpmFrame },
  { interval: 20,   encode: encodeAbsFrame },
  { interval: 50,   encode: encodePowertrainFrame },
  // Only broadcast turn-signal frames while a signal is in use. Mirrors
  // many real cars where 0x188 is silent at rest, so the workshop attendee
  // has to provoke a signal to discover the ID.
  { interval: 100,  encode: encodeSignalFrame,
    when: () => sim.held.signalLeft || sim.held.signalRight || sim.signalLeft || sim.signalRight },
  { interval: 100,  encode: encodeDoorFrame },
  { interval: VIN_INTERVAL_MS / 3, encode: encodeNextVinFrame },
  { interval: 500,  encode: encodeEngineFrame },
  { interval: 1000, encode: encodeOdometerFrame },
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// One bogus message. Real buses are mostly static payloads, alive counters,
// slowly drifting sensor values and the odd status bit — not random bytes.
function makeNoiseMessage(id) {
  const dlc = pick(NOISE_DLCS);
  const data = Array.from({ length: dlc }, () => Math.floor(Math.random() * 256));
  const idx = Math.floor(Math.random() * (dlc - 1));
  const mutate = {
    static: () => {},
    counter: () => { data[dlc - 1] = (data[dlc - 1] + 1) & 0xFF; },
    sensor: () => {
      const v = ((data[idx] << 8) | data[idx + 1]) + Math.floor(Math.random() * 7) - 3;
      data[idx] = (v >> 8) & 0xFF;
      data[idx + 1] = v & 0xFF;
    },
    flags: () => { if (Math.random() < 0.03) data[idx] ^= 1 << Math.floor(Math.random() * 8); },
  }[pick(NOISE_KINDS)];
  return {
    interval: pick(NOISE_INTERVALS),
    when: () => state.simBogusEnabled,
    encode: () => {
      mutate();
      return { id, data: data.slice(), dlc, isExtended: false };
    },
  };
}

// Build a fresh pool of noise IDs and starting payloads. Called on every
// startSim so a fresh session has different IDs (attendees can't memorize).
function generateNoisePool() {
  noisePool.length = 0;
  const reserved = new Set([
    ICSIM.SPEED_ID, ICSIM.SIGNAL_ID, ICSIM.DOOR_ID, ICSIM.RPM_ID,
    ICSIM.IMMO_ID, ICSIM.AIRBAG_ID, ICSIM.VIN_ID, ICSIM.ABS_ID,
    ICSIM.POWERTRAIN_ID, ICSIM.ENGINE_ID, ICSIM.ODO_ID,
    ICSIM.FUZZ_OIL.id, ICSIM.FUZZ_LCD.id, ICSIM.FUZZ_CE.id,
  ]);
  while (noisePool.length < NOISE_POOL_SIZE) {
    const id = 0x100 + Math.floor(Math.random() * 0x600);
    if (reserved.has(id)) continue;
    reserved.add(id);
    noisePool.push(makeNoiseMessage(id));
  }
}

// Emit a periodic message if its cycle time has elapsed.
function emitIfDue(msg, now) {
  if (now < msg.due) return;
  msg.due += msg.interval;
  // Fell behind (e.g. throttled background tab) — resync instead of bursting.
  if (msg.due <= now) msg.due = now + msg.interval;
  if (msg.when && !msg.when()) return;
  emitRx(msg.encode());
}

// Inject a frame into the existing RX pipeline (log, sniffer, onCanFrame
// listeners) so it looks identical to a frame received from a real device.
function emitRx(frame) {
  state.rxCount++;
  addLogEntry('rx', {
    id: frame.id,
    dlc: frame.dlc,
    data: frame.data,
    channel: 0,
    flags: 0,
    isExtended: frame.isExtended,
    isRTR: false,
  });
  dispatchRx(frame.id, frame.data);
}

// ────────────────────────────────────────────────
//  Public API
// ────────────────────────────────────────────────

// Called by queueTx when sim mode is active and no real device is connected.
// Decodes the frame against ICSim's protocol so a hand-crafted Send frame or
// a fuzzed/replayed frame moves the cluster.
export function onControlFrame(frame) {
  ecu.onFrame(frame.id, frame.data);
  decodeAndApply(frame.id, frame.data);
  renderCluster();
}

function tick() {
  const now = performance.now();
  const dt = Math.min(0.1, (now - sim.lastTick) / 1000);
  sim.lastTick = now;

  // Vehicle physics. While external speed / RPM frames keep arriving (e.g. a
  // sidebar 0x244 signal) the bus pins that value; once they go stale the
  // model takes over again and the car coasts down.
  stepVehicle(sim, dt, {
    accel: sim.acceleratorPressed,
    brake: sim.brakePressed,
    speedPinned: now - sim.lastExt.speed <= STALE_MS,
    rpmPinned: now - sim.lastExt.rpm <= STALE_MS,
  });

  // Turn signals: when no external frame is driving the lamps, a held
  // signal blinks; otherwise the lamps go dark.
  if (now - sim.lastExt.signal > STALE_MS) {
    const blinkOn = Math.floor((now - sim.blinkStart) / BLINK_HALF_MS) % 2 === 0;
    sim.signalLeft = sim.held.signalLeft && blinkOn;
    sim.signalRight = sim.held.signalRight && blinkOn;
  }

  // Doors decay when their last external write went stale and the user
  // hasn't pinned them via a cluster button; held doors stay open.
  if (now - sim.lastExt.door > STALE_MS) {
    for (const k of DOOR_KEYS) {
      if (!sim.held.doors[k]) sim.doors[k] = false;
    }
  }
  for (const k of DOOR_KEYS) {
    if (sim.held.doors[k]) sim.doors[k] = true;
  }

  // Warning lamps for Challenge 02 — lit unless silenced recently enough.
  sim.warn.immobilizer = (now - sim.lastExt.immobilizer) > SILENCE_MS;
  sim.warn.airbag      = (now - sim.lastExt.airbag)      > SILENCE_MS;

  // Easter-egg flash timeouts (Challenge 06).
  if (now > sim.eggUntil.oil) sim.warn.oilPressure = false;
  if (now > sim.eggUntil.ce)  sim.warn.checkEngine = false;
  if (now > sim.lcdUntil)     sim.lcdText = '';

  // emitRx already pushes through addLogEntry, which feeds the sniffer.
  for (const msg of noisePool) emitIfDue(msg, now);
  for (const msg of MESSAGES) emitIfDue(msg, now);

  renderCluster();
}

export function startSim() {
  if (state.simTimer !== null) return;
  state.simActive = true;
  generateNoisePool();
  const now = performance.now();
  sim.lastTick = now;
  sim.startedAt = now;
  // Random phase per message so they don't all land on the same tick.
  for (const msg of [...noisePool, ...MESSAGES]) msg.due = now + Math.random() * msg.interval;
  state.simTimer = setInterval(tick, TICK_MS);
  renderCluster();
}

export function stopSim() {
  if (state.simTimer !== null) {
    clearInterval(state.simTimer);
    state.simTimer = null;
  }
  state.simActive = false;
  // Reset transient state so a re-start is clean.
  sim.acceleratorPressed = false;
  sim.brakePressed = false;
  sim.signalLeft = false;
  sim.signalRight = false;
  for (const k of DOOR_KEYS) sim.doors[k] = false;
  sim.held.signalLeft = false;
  sim.held.signalRight = false;
  for (const k of DOOR_KEYS) sim.held.doors[k] = false;
  sim.lastExt.signal = 0;
  sim.lastExt.door = 0;
  sim.lastExt.speed = 0;
  sim.lastExt.rpm = 0;
  sim.lastExt.immobilizer = 0;
  sim.lastExt.airbag = 0;
  sim.lastExt.wheelSpeed = 0;
  sim.warn.immobilizer = true;
  sim.warn.airbag = true;
  sim.warn.oilPressure = false;
  sim.warn.checkEngine = false;
  sim.lcdText = '';
  sim.lcdUntil = 0;
  sim.eggUntil.oil = 0;
  sim.eggUntil.ce = 0;
  sim.wheelSpeedKmh = 0;
  sim.vinChunkIdx = 0;
  sim.blinkStart = 0;
  resetVehicle(sim);
  aliveCounters.clear();
  ecu.reset();
}

// ────────────────────────────────────────────────
//  Cluster rendering
// ────────────────────────────────────────────────

export function renderCluster() {
  const speedNum = document.getElementById('clusterSpeed');
  if (!speedNum) return; // panel not in DOM yet (early call)

  // Challenge 07 — speedometer trusts the ABS wheel-speed cross-check. When
  // an external 0x244 has arrived recently, the cluster requires a matching
  // ABS broadcast within tolerance to display speed. Without external speed
  // input the existing physics path is unchanged.
  const now = performance.now();
  const speedFresh = (now - sim.lastExt.speed) <= STALE_MS;
  const wheelFresh = (now - sim.lastExt.wheelSpeed) <= STALE_MS;
  let displaySpeed;
  if (speedFresh && wheelFresh) {
    displaySpeed = (Math.abs(sim.speedKmh - sim.wheelSpeedKmh) <= SPEED_TOL_KMH)
      ? sim.speedKmh : 0;
  } else if (speedFresh && !wheelFresh) {
    displaySpeed = 0;
  } else {
    displaySpeed = sim.speedKmh;
  }

  speedNum.textContent = Math.round(displaySpeed);

  // Needles: sweep to full scale and back at ignition-on, then follow the
  // real values with a little inertia.
  const sinceStart = now - sim.startedAt;
  if (sinceStart < SWEEP_MS) {
    const frac = 1 - Math.abs(1 - 2 * sinceStart / SWEEP_MS);
    needle.speedKmh = frac * TOP_SPEED_KMH;
    needle.rpm = frac * RPM_MAX;
  } else {
    const k = Math.min(1, (now - needle.lastRender) / 1000 / NEEDLE_LAG_S);
    needle.speedKmh += (Math.min(TOP_SPEED_KMH, displaySpeed) - needle.speedKmh) * k;
    needle.rpm += (Math.min(RPM_MAX, sim.rpm) - needle.rpm) * k;
  }
  needle.lastRender = now;

  const speedNeedle = document.getElementById('clusterSpeedNeedle');
  if (speedNeedle) {
    // Map 0..200 km/h to -120deg..120deg
    const angle = -120 + (needle.speedKmh / TOP_SPEED_KMH) * 240;
    speedNeedle.setAttribute('transform', `rotate(${angle.toFixed(1)} 100 100)`);
  }

  const rpmNum = document.getElementById('clusterRpm');
  if (rpmNum) rpmNum.textContent = Math.round(sim.rpm);

  const rpmNeedle = document.getElementById('clusterRpmNeedle');
  if (rpmNeedle) {
    // Map 0..8000 RPM to -120deg..120deg
    const angle = -120 + (needle.rpm / RPM_MAX) * 240;
    rpmNeedle.setAttribute('transform', `rotate(${angle.toFixed(1)} 100 100)`);
  }

  const left = document.getElementById('clusterSignalLeft');
  const right = document.getElementById('clusterSignalRight');
  if (left)  left.classList.toggle('active', sim.signalLeft);
  if (right) right.classList.toggle('active', sim.signalRight);

  for (const k of DOOR_KEYS) {
    const el = document.getElementById('clusterDoor' + k);
    if (el) el.classList.toggle('open', sim.doors[k]);
  }

  const warnImmo = document.getElementById('warnImmobilizer');
  const warnAir  = document.getElementById('warnAirbag');
  const warnOil  = document.getElementById('warnOilPressure');
  const warnCe   = document.getElementById('warnCheckEngine');
  const bulbCheck = sinceStart < BULB_CHECK_MS;   // all lamps lit at ignition-on
  if (warnImmo) warnImmo.classList.toggle('active', bulbCheck || sim.warn.immobilizer);
  if (warnAir)  warnAir.classList.toggle('active', bulbCheck || sim.warn.airbag);
  if (warnOil)  warnOil.classList.toggle('active', bulbCheck || sim.warn.oilPressure);
  if (warnCe)   warnCe.classList.toggle('active', bulbCheck || sim.warn.checkEngine);

  const gear = document.getElementById('clusterGear');
  if (gear) gear.textContent = sim.gear;

  // Control buttons show what is currently held.
  const pressed = {
    simBtnAccel: sim.acceleratorPressed,
    simBtnBrake: sim.brakePressed,
    simBtnSignalLeft: sim.held.signalLeft,
    simBtnSignalRight: sim.held.signalRight,
  };
  for (const k of DOOR_KEYS) pressed['simBtnDoor' + k] = sim.held.doors[k];
  for (const [id, on] of Object.entries(pressed)) {
    const btn = document.getElementById(id);
    if (btn) btn.setAttribute('aria-pressed', String(on));
  }

  // Bottom-of-dial arc gauges: fuel 0..100 %, coolant 50..130 °C (90 = mid).
  const fuel = document.getElementById('clusterFuel');
  if (fuel) fuel.setAttribute('stroke-dasharray', `${sim.fuelPct.toFixed(0)} 100`);
  const temp = document.getElementById('clusterTemp');
  if (temp) {
    const pct = Math.max(0, Math.min(100, (sim.coolantC - 50) / 80 * 100));
    temp.setAttribute('stroke-dasharray', `${pct.toFixed(0)} 100`);
  }

  const lcd = document.getElementById('clusterLcd');
  if (lcd) lcd.textContent = sim.lcdText || `${sim.odoKm.toFixed(1)} km`;
}

// ────────────────────────────────────────────────
//  On-screen control handlers
//
//  These are the driver's controls inside the simulated car, not the
//  tool transmitting. They only change the car's state; the car's own
//  ECUs then broadcast it, so the frames show up in the log as RX. TX is
//  reserved for what the user sends (Send, Signals, Fuzzer, UDS, api).
// ────────────────────────────────────────────────

export function pressAccelerator(on) {
  sim.acceleratorPressed = !!on;
  if (on) sim.brakePressed = false;
}

export function pressBrake(on) {
  sim.brakePressed = !!on;
  if (on) sim.acceleratorPressed = false;
}

export function toggleSignalLeft() {
  sim.held.signalLeft = !sim.held.signalLeft;
  if (sim.held.signalLeft) sim.held.signalRight = false;
  sim.signalLeft = sim.held.signalLeft;
  if (sim.held.signalLeft) sim.signalRight = false;
  sim.blinkStart = performance.now();
  // Broadcast the change right away (also puts a final all-off frame on
  // the bus when the signal is cancelled).
  emitRx(encodeSignalFrame());
}

export function toggleSignalRight() {
  sim.held.signalRight = !sim.held.signalRight;
  if (sim.held.signalRight) sim.held.signalLeft = false;
  sim.signalRight = sim.held.signalRight;
  if (sim.held.signalRight) sim.signalLeft = false;
  sim.blinkStart = performance.now();
  // Broadcast the change right away (also puts a final all-off frame on
  // the bus when the signal is cancelled).
  emitRx(encodeSignalFrame());
}

export function toggleDoor(key) {
  if (!(key in sim.doors)) return;
  sim.held.doors[key] = !sim.held.doors[key];
  sim.doors[key] = sim.held.doors[key];
}

export function setBogusEnabled(on) {
  state.simBogusEnabled = !!on;
}
