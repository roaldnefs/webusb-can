// ═══════════════════════════════════════════════════════
//  Send CAN frames — single, quick, repeat
// ═══════════════════════════════════════════════════════

import { state } from './state.js';
import { buildGsHostFrame, queueTx } from './frames.js';
import { addSystemLog } from './ui.js';

export async function handleSend() {
  if (!state.isConnected || !state.device) {
    addSystemLog('Not connected. Connect a device first.');
    return;
  }

  const idHex = document.getElementById('sendId').value.trim();
  const dlc = parseInt(document.getElementById('sendDlc').value) || 8;
  const dataStr = document.getElementById('sendData').value.trim();

  const canId = parseInt(idHex, 16);
  if (isNaN(canId)) {
    addSystemLog('Invalid CAN ID.');
    return;
  }

  const dataBytes = dataStr
    ? dataStr.split(/[\s,]+/).map(b => parseInt(b, 16)).filter(b => !isNaN(b))
    : [];

  // Pad to DLC
  while (dataBytes.length < dlc) dataBytes.push(0);

  const isExtended = canId > 0x7FF;
  const frameBuf = buildGsHostFrame(canId, dataBytes, dlc, isExtended);

  queueTx(frameBuf, {
    id: canId,
    dlc: dlc,
    data: dataBytes.slice(0, dlc),
    isExtended,
  });
}

export function quickSend(id, dataStr) {
  document.getElementById('sendId').value = id;
  document.getElementById('sendData').value = dataStr;
  document.getElementById('sendDlc').value = dataStr.split(/\s+/).length;
  handleSend();
}

export function toggleRepeat() {
  if (state.repeatTimer !== null) {
    stopRepeat();
  } else {
    startRepeat();
  }
}

export function startRepeat() {
  if (!state.isConnected || !state.device) {
    addSystemLog('Not connected. Connect a device first.');
    return;
  }

  const intervalMs = parseInt(document.getElementById('intervalMs').value);
  if (isNaN(intervalMs) || intervalMs < 1) {
    addSystemLog('Invalid interval. Enter a value in milliseconds (min 1).');
    return;
  }

  // Snapshot the frame parameters at start
  const idHex = document.getElementById('sendId').value.trim();
  const dlc = parseInt(document.getElementById('sendDlc').value) || 8;
  const dataStr = document.getElementById('sendData').value.trim();

  const canId = parseInt(idHex, 16);
  if (isNaN(canId)) {
    addSystemLog('Invalid CAN ID.');
    return;
  }

  const dataBytes = dataStr
    ? dataStr.split(/[\s,]+/).map(b => parseInt(b, 16)).filter(b => !isNaN(b))
    : [];
  while (dataBytes.length < dlc) dataBytes.push(0);

  const isExtended = canId > 0x7FF;
  state.repeatCount = 0;

  // Update UI
  const btn = document.getElementById('repeatBtn');
  btn.classList.add('active');
  btn.textContent = 'Stop';

  // Disable editing while repeating
  document.getElementById('sendId').disabled = true;
  document.getElementById('sendDlc').disabled = true;
  document.getElementById('sendData').disabled = true;
  document.getElementById('intervalMs').disabled = true;

  const idStr = isExtended
    ? canId.toString(16).toUpperCase().padStart(8, '0')
    : canId.toString(16).toUpperCase().padStart(3, '0');
  addSystemLog(`Repeat TX started: ID=0x${idStr}, every ${intervalMs}ms`);

  const sendOne = () => {
    if (!state.isConnected || !state.device || !state.device.opened) {
      stopRepeat();
      return;
    }

    state.repeatCount++;
    const frameBuf = buildGsHostFrame(canId, dataBytes, dlc, isExtended);
    queueTx(frameBuf, {
      id: canId,
      dlc: dlc,
      data: dataBytes.slice(0, dlc),
      isExtended,
    });
  };

  // Send first frame immediately, then set interval
  sendOne();
  state.repeatTimer = setInterval(sendOne, intervalMs);
}

export function stopRepeat() {
  if (state.repeatTimer !== null) {
    clearInterval(state.repeatTimer);
    state.repeatTimer = null;
  }

  const btn = document.getElementById('repeatBtn');
  btn.classList.remove('active');
  btn.textContent = 'Repeat';

  // Re-enable editing
  document.getElementById('sendId').disabled = false;
  document.getElementById('sendDlc').disabled = false;
  document.getElementById('sendData').disabled = false;
  document.getElementById('intervalMs').disabled = false;

  if (state.repeatCount > 0) {
    addSystemLog(`Repeat TX stopped after ${state.repeatCount} frames.`);
  }
  state.repeatCount = 0;
}
