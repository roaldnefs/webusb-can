// ═══════════════════════════════════════════════════════
//  UDS Tester Present (0x3E 0x00) auto-repeat
//
//  Most ECUs drop the extended diagnostic session within a few
//  seconds of inactivity. This sends a Tester Present request
//  on a fixed interval to keep the session alive. TX/RX IDs are
//  read live from the UDS panel so changing them takes effect on
//  the next tick.
// ═══════════════════════════════════════════════════════

import { udsRequest } from './uds.js';
import { addSystemLog } from './ui.js';
import { state } from './state.js';

const INTERVAL_MS = 2000;

let timer = null;

function tick() {
  const txId = parseInt(document.getElementById('udsTxId').value.trim().replace(/^0[xX]/, ''), 16);
  const rxId = parseInt(document.getElementById('udsRxId').value.trim().replace(/^0[xX]/, ''), 16);
  if (isNaN(txId) || isNaN(rxId)) return;
  // Suppress log spam — failures usually mean the ECU isn't on this bus
  // or the user is using a functional ID. The TX frame is already logged.
  udsRequest(txId, rxId, [0x3E, 0x00], { timeoutMs: 1500 }).catch(() => {});
}

export function startTesterPresent() {
  if (timer !== null) return true;
  if (!state.isConnected) {
    addSystemLog('Tester Present: not connected.');
    return false;
  }
  tick();
  timer = setInterval(tick, INTERVAL_MS);
  addSystemLog(`Tester Present started (3E 00 every ${INTERVAL_MS} ms).`);
  return true;
}

export function stopTesterPresent() {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
  const cb = document.getElementById('udsTesterPresent');
  if (cb) cb.checked = false;
  addSystemLog('Tester Present stopped.');
}
