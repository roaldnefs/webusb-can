// ═══════════════════════════════════════════════════════
//  In-browser CAN simulator (loopback)
//
//  Protocol — IDs and byte layout match the reference Linux instrument-
//  cluster simulator so existing workshop materials apply unchanged:
//    Speed:   ID 0x244, bytes [3..4]  encoded = (kmh * 100) big-endian
//    Signals: ID 0x188, byte 0        bit 0 = left, bit 1 = right
//    Doors:   ID 0x19B, byte 2        bits 0..3 = door 1..4 unlocked
//
//  The sim acts as both a producer (periodic state emit at 50ms) and a
//  consumer (decodes incoming frames so users can replay/fuzz). All
//  emitted frames flow through the existing RX pipeline (addLogEntry +
//  ingestFrame + dispatchRx), so the log, sniffer, and ISO-TP / UDS layers
//  see them exactly as if they came from a real CAN device.
// ═══════════════════════════════════════════════════════

import { state } from './state.js';
import { addLogEntry } from './ui.js';
import { dispatchRx } from './reader.js';
import { buildGsHostFrame, queueTx } from './frames.js';

const TICK_MS = 50;
// If no external (queueTx) write for a given axis arrives within this window,
// the cluster reverts to its default for that axis. Lets the user disable a
// periodic signal in the sidebar and watch the cluster go back to neutral.
const STALE_MS = 300;

// Bogus / noise traffic — the workshop puzzle is harder when the bus has
// dozens of unrelated IDs cycling at varying cadences (mirrors ICSim).
const NOISE_POOL_SIZE = 24;
const NOISE_INTERVALS = [50, 100, 100, 200, 200, 500, 1000];
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
};

const RPM_IDLE = 800;
const RPM_PER_KMH = 30;    // top-gear curve: 800 idle, ~6800 at 200 km/h
const RPM_MAX = 8000;

const DOOR_KEYS = ['FL', 'FR', 'RL', 'RR']; // mapped 1..1 to bits 0..3

// Live sim state. Mutated by user controls (clicks) AND by incoming frames.
//
//  - `held.*` is the cluster's own button state. Toggling a cluster button
//    pins the corresponding axis on; the tick re-asserts it every cycle.
//  - `signalLeft` / `signalRight` / `doors` are the cluster's *display*
//    state. Reflects either the held flag or the most recent external
//    frame; decays when neither source is active for STALE_MS.
//  - `lastExt.*` is the last time an external frame (onControlFrame) wrote
//    that axis. Used by the decay check.
const sim = {
  speedKmh: 0,
  rpm: 0,
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
  lastExt: { signal: 0, door: 0, speed: 0, rpm: 0 },
};

// ────────────────────────────────────────────────
//  Encode / decode helpers
// ────────────────────────────────────────────────

function encodeSpeedFrame() {
  const enc = Math.max(0, Math.min(0xFFFF, Math.round(sim.speedKmh * 100)));
  const data = [0, 0, 0, (enc >> 8) & 0xFF, enc & 0xFF, 0, 0, 0];
  return { id: ICSIM.SPEED_ID, data, dlc: 8, isExtended: false };
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
  return { id: ICSIM.RPM_ID, data, dlc: 8, isExtended: false };
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
  return false;
}

// Build a fresh pool of noise IDs and starting payloads. Called on every
// startSim so a fresh session has different IDs (attendees can't memorize).
function generateNoisePool() {
  noisePool.length = 0;
  const reserved = new Set([ICSIM.SPEED_ID, ICSIM.SIGNAL_ID, ICSIM.DOOR_ID, ICSIM.RPM_ID]);
  while (noisePool.length < NOISE_POOL_SIZE) {
    const id = 0x100 + Math.floor(Math.random() * 0x600);
    if (reserved.has(id)) continue;
    reserved.add(id);
    noisePool.push({
      id,
      interval: NOISE_INTERVALS[Math.floor(Math.random() * NOISE_INTERVALS.length)],
      lastEmit: 0,
      data: Array.from({ length: 8 }, () => Math.floor(Math.random() * 256)),
      driftIdx: Math.floor(Math.random() * 8),
    });
  }
}

// Emit any noise frames whose interval has elapsed. A small fraction of the
// emissions also nudge one byte by ±1 to simulate sensor jitter / counters.
function emitNoise(now) {
  if (!state.simBogusEnabled) return;
  for (const n of noisePool) {
    if (now - n.lastEmit < n.interval) continue;
    if (Math.random() < 0.15) {
      n.data[n.driftIdx] = (n.data[n.driftIdx] + (Math.random() < 0.5 ? -1 : 1)) & 0xFF;
    }
    emitRx({ id: n.id, data: n.data.slice(), dlc: 8, isExtended: false });
    n.lastEmit = now;
  }
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
  decodeAndApply(frame.id, frame.data);
  renderCluster();
}

function tick() {
  const now = performance.now();

  // Speed physics. Accelerator climbs, brake decelerates. When neither is
  // pressed and no external speed frame has arrived recently, the speed
  // bleeds back to 0 ("lift off the throttle"). External speed signals
  // (e.g. a sidebar 0x244 signal) refresh lastExt.speed, which suppresses
  // the bleed so the bus can pin the needle.
  if (sim.acceleratorPressed) {
    sim.speedKmh = Math.min(200, sim.speedKmh + 1.5);
  } else if (sim.brakePressed) {
    sim.speedKmh = Math.max(0, sim.speedKmh - 3);
  } else if (now - sim.lastExt.speed > STALE_MS && sim.speedKmh > 0) {
    sim.speedKmh = Math.max(0, sim.speedKmh - 0.6);
  }

  // RPM is derived from speed unless the bus is actively pinning it. Idle
  // 800 at 0 km/h, ~6800 at 200 km/h — close enough to a real top-gear curve
  // for a workshop demo without modelling gears.
  if (now - sim.lastExt.rpm > STALE_MS) {
    sim.rpm = Math.min(RPM_MAX, RPM_IDLE + sim.speedKmh * RPM_PER_KMH);
  }

  // Decay externally-driven booleans when their last external write went
  // stale and the user hasn't pinned them via a cluster button.
  if (now - sim.lastExt.signal > STALE_MS) {
    if (!sim.held.signalLeft) sim.signalLeft = false;
    if (!sim.held.signalRight) sim.signalRight = false;
  }
  if (now - sim.lastExt.door > STALE_MS) {
    for (const k of DOOR_KEYS) {
      if (!sim.held.doors[k]) sim.doors[k] = false;
    }
  }

  // Re-assert held flags so a toggled cluster button stays on regardless
  // of whether external frames keep arriving.
  if (sim.held.signalLeft)  sim.signalLeft = true;
  if (sim.held.signalRight) sim.signalRight = true;
  for (const k of DOOR_KEYS) {
    if (sim.held.doors[k]) sim.doors[k] = true;
  }

  // Bogus / noise traffic first so the real frames come through after.
  emitNoise(now);

  // emitRx already pushes through addLogEntry, which feeds the sniffer.
  emitRx(encodeSpeedFrame());
  emitRx(encodeRpmFrame());
  // Only broadcast turn-signal frames while a signal is actually on.
  // Mirrors many real cars where 0x188 is silent at rest, so the
  // workshop attendee has to provoke a signal to discover the ID.
  if (sim.signalLeft || sim.signalRight) emitRx(encodeSignalFrame());
  emitRx(encodeDoorFrame());

  renderCluster();
}

export function startSim() {
  if (state.simTimer !== null) return;
  state.simActive = true;
  generateNoisePool();
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
  sim.rpm = 0;
}

// ────────────────────────────────────────────────
//  Cluster rendering
// ────────────────────────────────────────────────

export function renderCluster() {
  const speedNum = document.getElementById('clusterSpeed');
  if (!speedNum) return; // panel not in DOM yet (early call)

  speedNum.textContent = Math.round(sim.speedKmh);

  const needle = document.getElementById('clusterSpeedNeedle');
  if (needle) {
    // Map 0..200 km/h to -120deg..120deg
    const angle = -120 + (Math.min(200, sim.speedKmh) / 200) * 240;
    needle.setAttribute('transform', `rotate(${angle.toFixed(1)} 100 100)`);
  }

  const rpmNum = document.getElementById('clusterRpm');
  if (rpmNum) rpmNum.textContent = Math.round(sim.rpm);

  const rpmNeedle = document.getElementById('clusterRpmNeedle');
  if (rpmNeedle) {
    // Map 0..8000 RPM to -120deg..120deg
    const angle = -120 + (Math.min(RPM_MAX, sim.rpm) / RPM_MAX) * 240;
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
}

// ────────────────────────────────────────────────
//  On-screen control handlers
//
//  Each control composes the right ICSim CAN frame and pushes it through
//  queueTx, so the user sees the frame in the log alongside the cluster
//  reaction. queueTx in sim mode loops it back through onControlFrame.
// ────────────────────────────────────────────────

function sendFrame(frame) {
  const buf = buildGsHostFrame(frame.id, frame.data, frame.dlc, frame.isExtended);
  queueTx(buf, {
    id: frame.id,
    dlc: frame.dlc,
    data: frame.data.slice(0, frame.dlc),
    isExtended: frame.isExtended,
  });
}

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
  sendFrame(encodeSignalFrame());
}

export function toggleSignalRight() {
  sim.held.signalRight = !sim.held.signalRight;
  if (sim.held.signalRight) sim.held.signalLeft = false;
  sim.signalRight = sim.held.signalRight;
  if (sim.held.signalRight) sim.signalLeft = false;
  sendFrame(encodeSignalFrame());
}

export function toggleDoor(key) {
  if (!(key in sim.doors)) return;
  sim.held.doors[key] = !sim.held.doors[key];
  sim.doors[key] = sim.held.doors[key];
  sendFrame(encodeDoorFrame());
}

export function setBogusEnabled(on) {
  state.simBogusEnabled = !!on;
}
