// ═══════════════════════════════════════════════════════
//  WebUSB CAN — entry point
// ═══════════════════════════════════════════════════════

import { state, RENDER_INTERVAL } from './state.js';
import { handleConnect } from './connection.js';
import { handleSend, toggleRepeat, stopRepeat } from './send.js';
import { renderSignals, toggleSignal, addSignal, removeSignal, stopAllSignals } from './signals.js';
import { updateConnectionUI, addSystemLog, renderTick, togglePause, setFilter, rebuildLog, clearLog, exportLog, toggleView } from './ui.js';
import { udsRequest } from './uds.js';
import { resetIsoTp } from './isotp.js';
import { startTesterPresent, stopTesterPresent } from './tester-present.js';

// ─── Expose functions on window for inline onclick handlers ───
window.handleConnect = handleConnect;
window.handleSend = handleSend;
window.toggleRepeat = toggleRepeat;
window.toggleSignal = toggleSignal;
window.addSignal = addSignal;
window.removeSignal = removeSignal;
window.togglePause = togglePause;
window.setFilter = setFilter;
window.clearLog = clearLog;
window.exportLog = exportLog;
window.handleUdsSend = handleUdsSend;
window.toggleTheme = toggleTheme;
window.toggleView = toggleView;
window.toggleTesterPresent = toggleTesterPresent;

// Expose state on window for inline onchange handlers (e.g. debugMode checkbox)
window.state = state;

// ─── Event listeners ──────────────────────────────────

// Filter input — debounce so a fast typist doesn't trigger a full rebuild per keystroke
let filterDebounce;
document.getElementById('filterInput').addEventListener('input', () => {
  clearTimeout(filterDebounce);
  filterDebounce = setTimeout(rebuildLog, 100);
});

// Rebuild log when UDS IDs change while UDS chip is active
for (const id of ['udsTxId', 'udsRxId']) {
  document.getElementById(id).addEventListener('input', () => {
    if (state.currentFilter === 'uds') rebuildLog();
  });
}

// Enter key to send
document.getElementById('sendData').addEventListener('keydown', e => {
  if (e.key === 'Enter') handleSend();
});

// WebUSB support check — show a blocking overlay and skip USB-dependent setup.
if (!navigator.usb) {
  document.getElementById('unsupportedOverlay').hidden = false;
} else {
  navigator.usb.addEventListener('disconnect', event => {
    if (state.device && event.device === state.device) {
      stopRepeat();
      stopAllSignals();
      stopTesterPresent();
      resetIsoTp();
      state.isConnected = false;
      state.isStarted = false;
      state.device = null;
      updateConnectionUI();
      addSystemLog('Device was disconnected.');
    }
  });
}

// ─── Init ─────────────────────────────────────────────

// Render initial signals
renderSignals();

// Start the render timer
setTimeout(renderTick, RENDER_INTERVAL);

// ─── UDS handlers ─────────────────────────────────────

function parseHexBytes(str) {
  return str.split(/[\s,]+/)
    .filter(t => t.length > 0)
    .map(t => parseInt(t.replace(/^0[xX]/, ''), 16));
}

function fmtHex(bytes) {
  return bytes.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

function fmtAscii(bytes) {
  return bytes.map(b => (b >= 0x20 && b < 0x7F) ? String.fromCharCode(b) : '.').join('');
}

async function handleUdsSend() {
  if (!state.isConnected) {
    addSystemLog('UDS: not connected.');
    return;
  }
  const txId = parseInt(document.getElementById('udsTxId').value.trim().replace(/^0[xX]/, ''), 16);
  const rxId = parseInt(document.getElementById('udsRxId').value.trim().replace(/^0[xX]/, ''), 16);
  if (isNaN(txId) || isNaN(rxId)) {
    addSystemLog('UDS: invalid TX/RX ID.');
    return;
  }
  const bytes = parseHexBytes(document.getElementById('udsRequest').value.trim());
  if (!bytes.length || bytes.some(b => isNaN(b) || b < 0 || b > 0xFF)) {
    addSystemLog('UDS: invalid request bytes.');
    return;
  }

  addSystemLog(`UDS request -> 0x${txId.toString(16).toUpperCase()}: ${fmtHex(bytes)}`);
  try {
    const result = await udsRequest(txId, rxId, bytes);
    if (result.ok) {
      addSystemLog(`UDS OK  SID=0x${(result.sid).toString(16).toUpperCase().padStart(2,'0')} data: ${fmtHex(result.data)}  "${fmtAscii(result.data)}"`);
    } else {
      const sidStr = result.sid.toString(16).toUpperCase().padStart(2, '0');
      const nrcStr = result.nrc < 0 ? '--' : result.nrc.toString(16).toUpperCase().padStart(2, '0');
      addSystemLog(`UDS NRC SID=0x${sidStr} 0x${nrcStr} ${result.name}`);
    }
  } catch (err) {
    addSystemLog(`UDS error: ${err.message}`);
  }
}

function toggleTesterPresent(checkbox) {
  if (checkbox.checked) {
    if (!startTesterPresent()) checkbox.checked = false;
  } else {
    stopTesterPresent();
  }
}

function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('webusb-can-theme', next);
}

