// ═══════════════════════════════════════════════════════
//  Public console API — window.api
// ═══════════════════════════════════════════════════════
//
// Curated, DOM-free surface for driving the app from DevTools or user
// scripts.

import { state } from './state.js';
import { buildGsHostFrame, queueTx } from './frames.js';
import { onCanFrame, onAnyFrame } from './reader.js';
import {
  connectDevice,
  disconnectDevice,
  startSimulator,
  stopSimulator,
} from './connection.js';
import {
  pressAccelerator,
  pressBrake,
  toggleSignalLeft,
  toggleSignalRight,
  toggleDoor,
  setBogusEnabled,
} from './icsim.js';
import {
  addSignalDirect,
  findSignal,
  toggleSignal as toggleSignalById,
  removeSignal as removeSignalById,
} from './signals.js';

function normalizeFrame({ id, data = [], dlc, isExtended } = {}) {
  if (typeof id !== 'number' || !Number.isFinite(id) || id < 0 || !Number.isInteger(id)) {
    throw new Error('send: id must be a non-negative integer');
  }
  const ext = typeof isExtended === 'boolean' ? isExtended : (id > 0x7FF);
  const max = ext ? 0x1FFFFFFF : 0x7FF;
  if (id > max) {
    throw new Error(`send: id 0x${id.toString(16)} exceeds ${ext ? '29-bit' : '11-bit'} range`);
  }
  const bytes = Array.isArray(data) || ArrayBuffer.isView(data) ? Array.from(data) : [];
  const len = typeof dlc === 'number' ? Math.max(0, Math.min(8, dlc | 0)) : Math.min(8, bytes.length);
  while (bytes.length < len) bytes.push(0);
  return { id, data: bytes.slice(0, len), dlc: len, isExtended: ext };
}

function sendOne(frame) {
  if (!state.isConnected) {
    throw new Error('send: not connected — call api.connect() or api.simulator.start() first');
  }
  const buf = buildGsHostFrame(frame.id, frame.data, frame.dlc, frame.isExtended);
  queueTx(buf, { id: frame.id, dlc: frame.dlc, data: frame.data, isExtended: frame.isExtended });
}

export const api = {
  // ─── Connection ──────────────────────────────────────
  connect: () => connectDevice(),
  disconnect: () => disconnectDevice(),
  isConnected: () => state.isConnected,

  // ─── TX ──────────────────────────────────────────────
  send(opts) {
    sendOne(normalizeFrame(opts));
  },

  sendRepeat(opts) {
    const frame = normalizeFrame(opts);
    const intervalMs = Math.max(1, parseInt(opts && opts.intervalMs, 10) || 0);
    if (!intervalMs) throw new Error('sendRepeat: intervalMs must be a positive number');
    let count = 0;
    sendOne(frame);
    count++;
    const timer = setInterval(() => {
      if (!state.isConnected) {
        clearInterval(timer);
        return;
      }
      sendOne(frame);
      count++;
    }, intervalMs);
    return {
      stop() { clearInterval(timer); },
      count() { return count; },
    };
  },

  // ─── RX (bus traffic only — TX from api.send is NOT echoed) ──
  onFrame: (canId, cb) => onCanFrame(canId, cb),
  onAnyFrame: (cb) => onAnyFrame(cb),

  // ─── Simulator ───────────────────────────────────────
  simulator: {
    start: () => startSimulator(),
    stop: () => stopSimulator(),
    accel: (on) => pressAccelerator(!!on),
    brake: (on) => pressBrake(!!on),
    signalLeft: () => toggleSignalLeft(),
    signalRight: () => toggleSignalRight(),
    door: (key) => toggleDoor(key),
    setBogus: (on) => setBogusEnabled(!!on),
  },

  // ─── Signals ─────────────────────────────────────────
  signals: {
    list: () => state.signals.map(s => ({
      id: s.id,
      name: s.name,
      canId: s.canId,
      data: s.data.slice(),
      intervalMs: s.intervalMs,
      active: s.active,
    })),
    add: (opts) => {
      const stored = addSignalDirect(opts);
      return {
        id: stored.id,
        name: stored.name,
        canId: stored.canId,
        data: stored.data.slice(),
        intervalMs: stored.intervalMs,
        active: stored.active,
      };
    },
    toggle(idOrName) {
      const sig = findSignal(idOrName);
      if (!sig) return false;
      toggleSignalById(sig.id);
      return sig.active;
    },
    remove(idOrName) {
      const sig = findSignal(idOrName);
      if (!sig) return false;
      removeSignalById(sig.id);
      return true;
    },
  },

  // ─── State snapshot ──────────────────────────────────
  state: () => ({
    isConnected: state.isConnected,
    simActive: state.simActive,
    rxCount: state.rxCount,
    txCount: state.txCount,
    errCount: state.errCount,
    signalCount: state.signals.length,
    repeatActive: state.repeatTimer !== null,
  }),
};
