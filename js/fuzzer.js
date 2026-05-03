// ═══════════════════════════════════════════════════════
//  CAN frame fuzzer — cangen-style configurable generator
//
//  Each of ID / DLC / Data has an independent mode:
//    - random:    each frame uses a fresh random value
//    - increment: starts from the configured value, +1 per frame
//    - fixed:     same value every frame
//
//  ID range is bound to the 11/29-bit mode. Data is padded or
//  truncated to the active DLC. The producer is paced to the USB
//  drain via MAX_QUEUE_DEPTH so a too-fast fuzzer can't pile
//  frames into memory.
// ═══════════════════════════════════════════════════════

import { state } from './state.js';
import { buildGsHostFrame, queueTx } from './frames.js';
import { addSystemLog } from './ui.js';

const MAX_QUEUE_DEPTH = 200;

let timer = null;
let counter = 0;
let cfg = null;
let nextId = 0;
let nextDlc = 0;
let nextData = [];

function randByte() { return Math.floor(Math.random() * 256); }

function randId(isExtended) {
  const max = isExtended ? 0x1FFFFFFF : 0x7FF;
  return Math.floor(Math.random() * (max + 1));
}

function pickId() {
  const max = cfg.isExtended ? 0x1FFFFFFF : 0x7FF;
  if (cfg.idMode === 'fixed') return cfg.idValue & max;
  if (cfg.idMode === 'random') return randId(cfg.isExtended);
  // increment
  const v = nextId & max;
  nextId = (nextId + 1) & max;
  return v;
}

function pickDlc() {
  if (cfg.dlcMode === 'fixed') return cfg.dlcValue;
  if (cfg.dlcMode === 'random') return Math.floor(Math.random() * 9);
  const v = nextDlc;
  nextDlc = (nextDlc + 1) % 9;
  return v;
}

function padOrTruncate(arr, len) {
  const out = arr.slice(0, len);
  while (out.length < len) out.push(0);
  return out;
}

function pickData(dlc) {
  if (cfg.dataMode === 'random') {
    const out = new Array(dlc);
    for (let i = 0; i < dlc; i++) out[i] = randByte();
    return out;
  }
  if (cfg.dataMode === 'fixed') {
    return padOrTruncate(cfg.dataValue, dlc);
  }
  // increment: snapshot, then bump LSB-first across the whole buffer
  const v = padOrTruncate(nextData, dlc);
  for (let i = nextData.length - 1; i >= 0; i--) {
    if (nextData[i] < 0xFF) { nextData[i]++; break; }
    nextData[i] = 0;
  }
  return v;
}

function tick() {
  if (!state.isConnected) { stopFuzzer(); return; }

  // Backpressure: if the USB drain can't keep up, skip this tick rather
  // than piling frames into memory. Naturally paces the fuzzer.
  if (state.txQueue.length >= MAX_QUEUE_DEPTH) return;

  const id = pickId();
  const dlc = pickDlc();
  const data = pickData(dlc);
  const buf = buildGsHostFrame(id, data, dlc, cfg.isExtended);
  queueTx(buf, { id, dlc, data, isExtended: cfg.isExtended });

  counter++;
  const out = document.getElementById('fuzzSent');
  if (out) out.textContent = counter;

  if (cfg.target > 0 && counter >= cfg.target) stopFuzzer();
}

export function startFuzzer(config) {
  if (timer !== null) return false;
  if (!state.isConnected) {
    addSystemLog('Fuzzer: not connected.');
    return false;
  }

  cfg = config;
  counter = 0;
  nextId = config.idMode === 'increment' ? config.idValue : 0;
  nextDlc = config.dlcMode === 'increment' ? config.dlcValue : 0;
  nextData = config.dataMode === 'increment' ? [...config.dataValue] : [];

  // Browser timer minimum is ~4 ms; gap=0 effectively means "as fast as the
  // browser allows", which is fine for a workshop demo.
  timer = setInterval(tick, Math.max(0, config.gapMs));

  addSystemLog(
    `Fuzzer started (id=${config.idMode}, dlc=${config.dlcMode}, ` +
    `data=${config.dataMode}, gap=${config.gapMs}ms, ` +
    `target=${config.target || 'unlimited'})`
  );

  const btn = document.getElementById('fuzzBtn');
  if (btn) {
    btn.textContent = 'Stop Fuzz';
    btn.classList.add('paused');
  }
  return true;
}

export function stopFuzzer() {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;

  addSystemLog(`Fuzzer stopped after ${counter} frames.`);

  const btn = document.getElementById('fuzzBtn');
  if (btn) {
    btn.textContent = 'Start Fuzz';
    btn.classList.remove('paused');
  }
}

export function isFuzzerActive() { return timer !== null; }
