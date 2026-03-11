// ═══════════════════════════════════════════════════════
//  WebUSB CAN — entry point
// ═══════════════════════════════════════════════════════

import { state, RENDER_INTERVAL } from './state.js';
import { handleConnect } from './connection.js';
import { handleSend, quickSend, toggleRepeat } from './send.js';
import { renderSignals, toggleSignal, addSignal, removeSignal, stopAllSignals, stopSignal } from './signals.js';
import { updateConnectionUI, addSystemLog, renderTick, togglePause, setFilter, rebuildLog, clearLog, exportLog } from './ui.js';
import { stopRepeat } from './send.js';

// ─── Expose functions on window for inline onclick handlers ───
window.handleConnect = handleConnect;
window.handleSend = handleSend;
window.quickSend = quickSend;
window.toggleRepeat = toggleRepeat;
window.toggleSignal = toggleSignal;
window.addSignal = addSignal;
window.removeSignal = removeSignal;
window.togglePause = togglePause;
window.setFilter = setFilter;
window.clearLog = clearLog;
window.exportLog = exportLog;

// Expose state on window for inline onchange handlers (e.g. debugMode checkbox)
window.state = state;

// ─── Event listeners ──────────────────────────────────

// Filter input
document.getElementById('filterInput').addEventListener('input', rebuildLog);

// Enter key to send
document.getElementById('sendData').addEventListener('keydown', e => {
  if (e.key === 'Enter') handleSend();
});

// Handle disconnection events
navigator.usb.addEventListener('disconnect', event => {
  if (state.device && event.device === state.device) {
    stopRepeat();
    stopAllSignals();
    state.isConnected = false;
    state.isStarted = false;
    state.device = null;
    updateConnectionUI();
    addSystemLog('Device was disconnected.');
  }
});

// ─── Init ─────────────────────────────────────────────

// Render initial signals
renderSignals();

// Start the render timer
setTimeout(renderTick, RENDER_INTERVAL);

// WebUSB support check
if (!navigator.usb) {
  addSystemLog('WebUSB is not supported in this browser. Please use Chrome or Edge.');
}
