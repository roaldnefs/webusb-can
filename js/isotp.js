// ═══════════════════════════════════════════════════════
//  ISO-TP (ISO 15765-2) — transport for UDS over CAN
//  Single Frame, First/Consecutive Frames, Flow Control.
//  11-bit IDs, classic CAN (8-byte frames), normal addressing.
// ═══════════════════════════════════════════════════════

import { onCanFrame } from './reader.js';
import { buildGsHostFrame, queueTx } from './frames.js';
import { state } from './state.js';

const PAD = 0xCC;
const PCI_SF = 0x0;
const PCI_FF = 0x1;
const PCI_CF = 0x2;
const PCI_FC = 0x3;
const FS_CTS = 0;
const FS_WAIT = 1;
const FS_OVF = 2;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function sendFrame(canId, bytes) {
  const isExtended = canId > 0x7FF;
  const buf = buildGsHostFrame(canId, bytes, 8, isExtended);
  queueTx(buf, { id: canId, dlc: 8, data: bytes.slice(0, 8), isExtended });
}

function makeSF(payload) {
  const out = new Array(8).fill(PAD);
  out[0] = (PCI_SF << 4) | payload.length;
  for (let i = 0; i < payload.length; i++) out[1 + i] = payload[i];
  return out;
}

function makeFF(payload) {
  // 12-bit length form only (≤4095 bytes); 32-bit form not supported.
  if (payload.length > 4095) throw new Error('ISO-TP: payload >4095 bytes not supported');
  const out = new Array(8).fill(PAD);
  out[0] = (PCI_FF << 4) | ((payload.length >> 8) & 0x0F);
  out[1] = payload.length & 0xFF;
  for (let i = 0; i < 6; i++) out[2 + i] = payload[i];
  return out;
}

function makeCF(seq, chunk) {
  const out = new Array(8).fill(PAD);
  out[0] = (PCI_CF << 4) | (seq & 0x0F);
  for (let i = 0; i < chunk.length; i++) out[1 + i] = chunk[i];
  return out;
}

function makeFC(fs, bs, stmin) {
  const out = new Array(8).fill(PAD);
  out[0] = (PCI_FC << 4) | (fs & 0x0F);
  out[1] = bs;
  out[2] = stmin;
  return out;
}

function stminToMs(stmin) {
  if (stmin <= 0x7F) return stmin;
  if (stmin >= 0xF1 && stmin <= 0xF9) return (stmin - 0xF0) / 10;
  return 127;
}

// One pending FC waiter per rxId — most flows are strictly serialized.
const fcWaiters = new Map();

function waitForFc(rxId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      fcWaiters.delete(rxId);
      reject(new Error('ISO-TP: FC timeout'));
    }, timeoutMs);
    fcWaiters.set(rxId, (fc) => {
      clearTimeout(timer);
      resolve(fc);
    });
  });
}

// Reassembly state per rxId.
const rxState = new Map();

function getRxState(rxId, txId) {
  let s = rxState.get(rxId);
  if (!s) {
    s = { buffer: null, expected: 0, nextSeq: 1, listeners: new Set(), txId };
    rxState.set(rxId, s);
    onCanFrame(rxId, (data) => handleRxFrame(rxId, data));
  } else if (txId != null) {
    s.txId = txId;
  }
  return s;
}

function handleRxFrame(rxId, data) {
  const pci = (data[0] >> 4) & 0x0F;

  if (pci === PCI_FC) {
    const w = fcWaiters.get(rxId);
    if (w) {
      fcWaiters.delete(rxId);
      w({ fs: data[0] & 0x0F, bs: data[1], stmin: data[2] });
    }
    return;
  }

  const s = rxState.get(rxId);
  if (!s) return;

  if (pci === PCI_SF) {
    const len = data[0] & 0x0F;
    deliver(s, data.slice(1, 1 + len));
    return;
  }

  if (pci === PCI_FF) {
    const len = ((data[0] & 0x0F) << 8) | data[1];
    s.buffer = data.slice(2, 8);
    s.expected = len;
    s.nextSeq = 1;
    if (s.txId != null) sendFrame(s.txId, makeFC(FS_CTS, 0, 0));
    return;
  }

  if (pci === PCI_CF) {
    if (!s.buffer) return;
    const seq = data[0] & 0x0F;
    if (seq !== s.nextSeq) {
      s.buffer = null;
      return;
    }
    s.nextSeq = (s.nextSeq + 1) & 0x0F;
    const remaining = s.expected - s.buffer.length;
    const take = Math.min(7, remaining);
    for (let i = 0; i < take; i++) s.buffer.push(data[1 + i]);
    if (s.buffer.length >= s.expected) {
      const payload = s.buffer.slice(0, s.expected);
      s.buffer = null;
      deliver(s, payload);
    }
  }
}

function deliver(s, payload) {
  for (const cb of s.listeners) {
    try { cb(payload); } catch (e) { console.error('ISO-TP listener error:', e); }
  }
}

// Send a payload via ISO-TP. txId = our request ID, rxId = peer's reply ID
// (needed so we can wait for Flow Control on multi-frame TX).
export async function isoTpSend(txId, rxId, payload, { fcTimeoutMs = 1000 } = {}) {
  if (!state.isConnected) throw new Error('Not connected');
  if (payload.length === 0) throw new Error('ISO-TP: empty payload');

  if (payload.length <= 7) {
    sendFrame(txId, makeSF(payload));
    return;
  }

  // Make sure RX listener is attached so FC frames are routed to fcWaiters.
  getRxState(rxId, txId);

  sendFrame(txId, makeFF(payload));
  let offset = 6;
  let seq = 1;

  while (offset < payload.length) {
    const fc = await waitForFc(rxId, fcTimeoutMs);
    if (fc.fs === FS_OVF) throw new Error('ISO-TP: peer reported overflow');
    if (fc.fs === FS_WAIT) continue;

    const stMs = stminToMs(fc.stmin);
    let inBlock = 0;
    while (offset < payload.length && (fc.bs === 0 || inBlock < fc.bs)) {
      const chunk = payload.slice(offset, offset + 7);
      sendFrame(txId, makeCF(seq, chunk));
      offset += 7;
      seq = (seq + 1) & 0x0F;
      inBlock++;
      if (stMs > 0 && offset < payload.length) await sleep(stMs);
    }
  }
}

// Send a request and await one assembled response.
// `isFinal(payload)` is called for each delivered response; if it returns false
// (e.g. UDS 0x78 pending), the listener stays attached and the timeout resets.
export function isoTpRequest(txId, rxId, payload, {
  timeoutMs = 2000,
  fcTimeoutMs = 1000,
  isFinal = () => true,
} = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    let timer;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (done) return;
        done = true;
        unhook();
        reject(new Error(`ISO-TP: response timeout (${timeoutMs}ms)`));
      }, timeoutMs);
    };

    const s = getRxState(rxId, txId);
    const listener = (resp) => {
      if (done) return;
      if (!isFinal(resp)) {
        arm();
        return;
      }
      done = true;
      clearTimeout(timer);
      unhook();
      resolve(resp);
    };
    const unhook = () => s.listeners.delete(listener);
    s.listeners.add(listener);

    arm();

    isoTpSend(txId, rxId, payload, { fcTimeoutMs }).catch(err => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unhook();
      reject(err);
    });
  });
}
