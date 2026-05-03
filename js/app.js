// ═══════════════════════════════════════════════════════
//  WebUSB CAN — entry point
// ═══════════════════════════════════════════════════════

import { state, RENDER_INTERVAL } from './state.js';
import { handleConnect, startSimulator, stopSimulator } from './connection.js';
import { startCAN, stopCAN } from './gsusb.js';
import { startFuzzer, stopFuzzer, isFuzzerActive } from './fuzzer.js';
import { handleSend, toggleRepeat, stopRepeat } from './send.js';
import { renderSignals, toggleSignal, addSignal, removeSignal, stopAllSignals, editSignal } from './signals.js';
import { updateConnectionUI, addSystemLog, renderTick, togglePause, setFilter, rebuildLog, clearLog, exportLog, toggleView, setClusterVisible } from './ui.js';
import { udsRequest } from './uds.js';
import { resetIsoTp } from './isotp.js';
import { startTesterPresent, stopTesterPresent } from './tester-present.js';
import { onControlFrame as simOnControlFrame, pressAccelerator, pressBrake, toggleSignalLeft, toggleSignalRight, toggleDoor, stopSim, setBogusEnabled } from './icsim.js';
import { setSimHandler } from './frames.js';

// ─── Expose functions on window for inline onclick handlers ───
window.handleConnect = handleConnect;
window.handleSend = handleSend;
window.toggleRepeat = toggleRepeat;
window.toggleSignal = toggleSignal;
window.addSignal = addSignal;
window.removeSignal = removeSignal;
window.editSignal = editSignal;
window.togglePause = togglePause;
window.setFilter = setFilter;
window.clearLog = clearLog;
window.exportLog = exportLog;
window.handleUdsSend = handleUdsSend;
window.toggleTheme = toggleTheme;
window.toggleView = toggleView;
window.toggleTesterPresent = toggleTesterPresent;
window.startSimulator = startSimulator;
window.stopSimulator = stopSimulator;
window.simAccel = pressAccelerator;
window.simBrake = pressBrake;
window.simSignalLeft = toggleSignalLeft;
window.simSignalRight = toggleSignalRight;
window.simDoor = toggleDoor;
window.setSimBogus = setBogusEnabled;
window.toggleClusterMinimize = toggleClusterMinimize;
window.toggleFuzzer = toggleFuzzer;
window.resetBus = resetBus;

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
      stopFuzzer();
      stopSim();
      setClusterVisible(false);
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

// Wire the simulator into the TX queue: when no real device is connected and
// the sim is running, queueTx hands frames to the sim instead of USB.
setSimHandler(simOnControlFrame);

// Cluster overlay drag-to-move. Drag handle is the cluster header bar
// (excluding the icon buttons). Position is persisted to localStorage
// so the user's chosen spot survives a reload.
(function setupClusterDrag() {
  const el = document.getElementById('clusterArea');
  const handle = el && el.querySelector('.cluster-header');
  if (!el || !handle) return;

  const STORAGE_KEY = 'webusb-can-cluster-pos';
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const { x, y } = JSON.parse(stored);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        el.style.left = x + 'px';
        el.style.top = y + 'px';
        el.style.right = 'auto';
        el.style.bottom = 'auto';
      }
    }
  } catch (e) { /* ignore */ }

  let dragging = false;
  let startX = 0, startY = 0, origLeft = 0, origTop = 0;

  handle.addEventListener('mousedown', (e) => {
    if (e.target.closest('.cluster-iconbtn')) return; // let buttons handle their own clicks
    const rect = el.getBoundingClientRect();
    origLeft = rect.left;
    origTop = rect.top;
    el.style.left = origLeft + 'px';
    el.style.top = origTop + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    startX = e.clientX;
    startY = e.clientY;
    dragging = true;
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const newLeft = origLeft + (e.clientX - startX);
    const newTop = origTop + (e.clientY - startY);
    // Clamp so the header stays reachable on screen.
    const margin = 20;
    const maxLeft = window.innerWidth - margin;
    const maxTop = window.innerHeight - margin;
    el.style.left = Math.max(-(el.offsetWidth - margin), Math.min(maxLeft, newLeft)) + 'px';
    el.style.top = Math.max(0, Math.min(maxTop, newTop)) + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    const rect = el.getBoundingClientRect();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ x: rect.left, y: rect.top }));
    } catch (e) { /* ignore */ }
  });
})();

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

function toggleFuzzer() {
  if (isFuzzerActive()) {
    stopFuzzer();
    return;
  }
  const idMode = document.getElementById('fuzzIdMode').value;
  const dlcMode = document.getElementById('fuzzDlcMode').value;
  const dataMode = document.getElementById('fuzzDataMode').value;
  const isExtended = document.getElementById('fuzzExtended').checked;

  const idValue = parseInt(document.getElementById('fuzzIdValue').value.trim().replace(/^0[xX]/, ''), 16);
  if ((idMode === 'fixed' || idMode === 'increment') && (isNaN(idValue) || idValue < 0)) {
    addSystemLog('Fuzzer: invalid ID value.');
    return;
  }
  if ((idMode === 'fixed' || idMode === 'increment')) {
    const max = isExtended ? 0x1FFFFFFF : 0x7FF;
    if (idValue > max) {
      addSystemLog(`Fuzzer: ID exceeds ${isExtended ? '29-bit' : '11-bit'} range.`);
      return;
    }
  }

  const dlcValue = parseInt(document.getElementById('fuzzDlcValue').value, 10);
  if (dlcMode !== 'random' && (isNaN(dlcValue) || dlcValue < 0 || dlcValue > 8)) {
    addSystemLog('Fuzzer: DLC must be 0-8.');
    return;
  }

  const dataValue = parseHexBytes(document.getElementById('fuzzDataValue').value.trim());
  if ((dataMode === 'fixed' || dataMode === 'increment')) {
    if (!dataValue.length || dataValue.some(b => isNaN(b) || b < 0 || b > 0xFF)) {
      addSystemLog('Fuzzer: data bytes invalid for fixed/increment mode.');
      return;
    }
  }

  const gapMs = parseInt(document.getElementById('fuzzGap').value, 10);
  if (isNaN(gapMs) || gapMs < 0) {
    addSystemLog('Fuzzer: invalid gap.');
    return;
  }

  const target = parseInt(document.getElementById('fuzzMax').value, 10) || 0;

  startFuzzer({
    idMode, idValue: idValue || 0,
    dlcMode, dlcValue: dlcValue || 0,
    dataMode, dataValue,
    isExtended, gapMs, target,
  });
}

async function resetBus() {
  if (!state.isConnected) {
    addSystemLog('Reset CAN: not connected.');
    return;
  }
  // Stop in-flight producers so they don't push frames into a half-dead channel
  stopRepeat();
  stopAllSignals();
  stopTesterPresent();
  stopFuzzer();
  state.txQueue = [];
  try {
    await stopCAN();
    await startCAN();
    addSystemLog('CAN channel reset (bus-off cleared).');
  } catch (err) {
    addSystemLog(`Reset CAN failed: ${err.message || err}`);
  }
}

function toggleClusterMinimize() {
  const el = document.getElementById('clusterArea');
  if (!el) return;
  const minimized = el.classList.toggle('minimized');
  // Swap glyph: minus when expanded, plus when minimized.
  const btn = el.querySelector('.cluster-header-actions .cluster-iconbtn');
  if (btn) {
    btn.innerHTML = minimized ? '&#43;' : '&#8722;';
    btn.title = minimized ? 'Expand' : 'Minimize';
    btn.setAttribute('aria-label', minimized ? 'Expand' : 'Minimize');
  }
}

function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('webusb-can-theme', next);
}

