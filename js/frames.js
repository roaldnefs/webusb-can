// ═══════════════════════════════════════════════════════
//  CAN frame parsing & TX queue
// ═══════════════════════════════════════════════════════

import { state } from './state.js';
import { addLogEntry, addSystemLog } from './ui.js';

// Rate-limit TX-error system logs so a saturated queue doesn't flood
// the log with one error per failed frame.
let lastTxErrorLog = 0;
let suppressedTxErrors = 0;

function reportTxError(msg) {
  const now = performance.now();
  if (now - lastTxErrorLog > 1000) {
    const more = suppressedTxErrors > 0 ? ` (+${suppressedTxErrors} suppressed)` : '';
    addSystemLog(`${msg}${more}`);
    lastTxErrorLog = now;
    suppressedTxErrors = 0;
  } else {
    suppressedTxErrors++;
  }
}

// gs_host_frame structure (20 bytes):
//   echo_id:    uint32 (offset 0)
//   can_id:     uint32 (offset 4)
//   can_dlc:    uint8  (offset 8)
//   channel:    uint8  (offset 9)
//   flags:      uint8  (offset 10)
//   reserved:   uint8  (offset 11)
//   data[8]:    uint8  (offset 12-19)

export function parseGsHostFrame(buffer) {
  const view = new DataView(buffer);
  const echo_id = view.getUint32(0, true);
  const can_id = view.getUint32(4, true);
  const can_dlc = view.getUint8(8);
  const channel = view.getUint8(9);
  const flags = view.getUint8(10);

  const isExt = (can_id & 0x80000000) !== 0;
  const isRTR = (can_id & 0x40000000) !== 0;
  const isErr = (can_id & 0x20000000) !== 0;
  const rawId = isExt ? (can_id & 0x1FFFFFFF) : (can_id & 0x7FF);

  const dataBytes = [];
  for (let i = 0; i < Math.min(can_dlc, 8); i++) {
    dataBytes.push(view.getUint8(12 + i));
  }

  return {
    echo_id,
    id: rawId,
    dlc: can_dlc,
    data: dataBytes,
    channel,
    flags,
    isExtended: isExt,
    isRTR: isRTR,
    isError: isErr,
    isEcho: echo_id !== 0xFFFFFFFF,
  };
}

export function buildGsHostFrame(canId, data, dlc, extended = false) {
  const buf = new ArrayBuffer(20);
  const view = new DataView(buf);

  // echo_id: 0 (will be echoed back)
  view.setUint32(0, 1, true);

  // can_id with flags
  let id = canId & (extended ? 0x1FFFFFFF : 0x7FF);
  if (extended) id |= 0x80000000;
  view.setUint32(4, id, true);

  // DLC
  view.setUint8(8, Math.min(dlc, 8));

  // channel, flags, reserved
  view.setUint8(9, 0);
  view.setUint8(10, 0);
  view.setUint8(11, 0);

  // data
  for (let i = 0; i < 8; i++) {
    view.setUint8(12 + i, i < data.length ? data[i] : 0);
  }

  return buf;
}

// ─── TX Queue (serialize all USB writes) ─────────────
// WebUSB transferOut is NOT safe to call concurrently.
// All sends go through this queue to prevent collisions.

// Optional sim consumer. Registered at boot by the simulator module so that
// when state.simActive && !state.device, frames are routed to the sim's
// onControlFrame instead of the real USB endpoint. Keeps frames.js free of
// any circular import on icsim.js.
let simHandler = null;
export function setSimHandler(fn) { simHandler = fn; }

export async function queueTx(frameBuf, logFrame) {
  state.txQueue.push({ frameBuf, logFrame });
  if (!state.txBusy) drainTxQueue();
}

export async function drainTxQueue() {
  if (state.txBusy) return;
  state.txBusy = true;

  while (state.txQueue.length > 0 && state.isConnected) {
    const { frameBuf, logFrame } = state.txQueue.shift();

    // Sim loopback: no real device, sim is running. Hand the frame to the
    // sim and log it as TX without touching USB.
    if (state.simActive && !state.device) {
      if (simHandler && logFrame) {
        try {
          simHandler({
            id: logFrame.id,
            dlc: logFrame.dlc,
            data: logFrame.data,
            isExtended: logFrame.isExtended,
          });
        } catch (e) { console.error('Sim handler error:', e); }
      }
      state.txCount++;
      if (logFrame) addLogEntry('tx', logFrame);
      continue;
    }

    if (!state.device || !state.device.opened) break;

    try {
      const result = await state.device.transferOut(state.endpointOut, frameBuf);
      if (result.status === 'ok') {
        state.txCount++;
        if (logFrame) addLogEntry('tx', logFrame);
      } else if (result.status === 'stall') {
        // OUT endpoint stalled. Clear the halt and surface it (rate-limited)
        // so the user knows the device or bus needs intervention.
        try { await state.device.clearHalt('out', state.endpointOut); } catch (e) { /* */ }
        reportTxError('OUT endpoint stalled — clearing halt');
      } else {
        reportTxError(`TX status: ${result.status}`);
      }
    } catch (err) {
      console.error('TX queue error:', err);
      reportTxError(`TX error: ${err.message || err}`);
      // Don't break the queue — skip this frame and continue
    }
  }

  state.txBusy = false;
}
