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
import { ingestFrame } from './sniffer.js';
import { dispatchRx } from './reader.js';
import { buildGsHostFrame, queueTx } from './frames.js';

const TICK_MS = 50;

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
};

const DOOR_KEYS = ['FL', 'FR', 'RL', 'RR']; // mapped 1..1 to bits 0..3

// Live sim state. Mutated by user controls (clicks) AND by incoming frames
// (so a fuzzed/replayed frame on the bus also moves the cluster).
const sim = {
  speedKmh: 0,
  acceleratorPressed: false,
  brakePressed: false,
  signalLeft: false,
  signalRight: false,
  doors: { FL: false, FR: false, RL: false, RR: false },
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

function decodeAndApply(id, data) {
  if (id === ICSIM.SPEED_ID && data.length > ICSIM.SPEED_BYTE + 1) {
    const enc = (data[ICSIM.SPEED_BYTE] << 8) | data[ICSIM.SPEED_BYTE + 1];
    sim.speedKmh = enc / 100;
    return true;
  }
  if (id === ICSIM.SIGNAL_ID && data.length > ICSIM.SIGNAL_BYTE) {
    const b = data[ICSIM.SIGNAL_BYTE];
    sim.signalLeft = (b & ICSIM.SIGNAL_LEFT) !== 0;
    sim.signalRight = (b & ICSIM.SIGNAL_RIGHT) !== 0;
    return true;
  }
  if (id === ICSIM.DOOR_ID && data.length > ICSIM.DOOR_BYTE) {
    const b = data[ICSIM.DOOR_BYTE];
    for (let i = 0; i < 4; i++) {
      sim.doors[DOOR_KEYS[i]] = (b & ICSIM.DOOR_BITS[i]) !== 0;
    }
    return true;
  }
  return false;
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
  // Simple physics: accelerator climbs to 200 km/h, brake or coasting
  // bleeds it off. Keeps things responsive at 50 ms cadence.
  if (sim.acceleratorPressed) {
    sim.speedKmh = Math.min(200, sim.speedKmh + 0.8);
  } else if (sim.brakePressed) {
    sim.speedKmh = Math.max(0, sim.speedKmh - 2.5);
  } else if (sim.speedKmh > 0) {
    sim.speedKmh = Math.max(0, sim.speedKmh - 0.15);
  }

  emitRx(encodeSpeedFrame());
  emitRx(encodeSignalFrame());
  emitRx(encodeDoorFrame());

  ingestFrame('rx', encodeSpeedFrame());
  ingestFrame('rx', encodeSignalFrame());
  ingestFrame('rx', encodeDoorFrame());

  renderCluster();
}

export function startSim() {
  if (state.simTimer !== null) return;
  state.simActive = true;
  state.simTimer = setInterval(tick, TICK_MS);
  renderCluster();
}

export function stopSim() {
  if (state.simTimer !== null) {
    clearInterval(state.simTimer);
    state.simTimer = null;
  }
  state.simActive = false;
  // Reset transient pressed states so a re-start doesn't accelerate forever.
  sim.acceleratorPressed = false;
  sim.brakePressed = false;
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
  sim.signalLeft = !sim.signalLeft;
  if (sim.signalLeft) sim.signalRight = false;
  sendFrame(encodeSignalFrame());
}

export function toggleSignalRight() {
  sim.signalRight = !sim.signalRight;
  if (sim.signalRight) sim.signalLeft = false;
  sendFrame(encodeSignalFrame());
}

export function toggleDoor(key) {
  if (!(key in sim.doors)) return;
  sim.doors[key] = !sim.doors[key];
  sendFrame(encodeDoorFrame());
}
