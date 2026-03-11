// ═══════════════════════════════════════════════════════
//  Signal system — toggleable periodic CAN messages
// ═══════════════════════════════════════════════════════

import { state } from './state.js';
import { buildGsHostFrame, queueTx } from './frames.js';
import { addSystemLog } from './ui.js';

export function renderSignals() {
  const list = document.getElementById('signalList');
  list.innerHTML = '';

  if (state.signals.length === 0) {
    list.innerHTML = '<div style="font-size:11px; color:var(--text-muted); padding:4px 0;">No signals configured. Add one below.</div>';
    return;
  }

  for (const sig of state.signals) {
    const idHex = sig.canId > 0x7FF
      ? sig.canId.toString(16).toUpperCase().padStart(8, '0')
      : sig.canId.toString(16).toUpperCase().padStart(3, '0');
    const dataHex = sig.data.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

    const row = document.createElement('div');
    row.className = 'signal-row' + (sig.active ? ' active' : '');
    row.id = 'sigrow_' + sig.id;
    row.innerHTML = `
      <div class="signal-toggle ${sig.active ? 'on' : ''}" onclick="toggleSignal('${sig.id}')" title="Click to toggle"></div>
      <div class="signal-info">
        <div class="signal-name">${sig.name}</div>
        <div class="signal-detail">0x${idHex} | ${dataHex} | ${sig.intervalMs}ms</div>
      </div>
      <button class="signal-remove" onclick="removeSignal('${sig.id}')" title="Remove">&#10005;</button>
    `;
    list.appendChild(row);
  }
}

export function toggleSignal(sigId) {
  const sig = state.signals.find(s => s.id === sigId);
  if (!sig) return;

  if (sig.active) {
    stopSignal(sig);
  } else {
    startSignal(sig);
  }

  renderSignals();
}

export function startSignal(sig) {
  if (!state.isConnected || !state.device) {
    addSystemLog('Not connected. Connect a device first.');
    return;
  }

  const canId = sig.canId;
  const data = sig.data.slice();
  const dlc = data.length;
  const isExtended = canId > 0x7FF;

  const sendFrame = () => {
    if (!state.isConnected || !state.device || !state.device.opened) {
      stopSignal(sig);
      renderSignals();
      return;
    }

    const frameBuf = buildGsHostFrame(canId, data, dlc, isExtended);
    queueTx(frameBuf, { id: canId, dlc, data, isExtended });
  };

  sig.active = true;
  sendFrame(); // send first immediately
  sig.timer = setInterval(sendFrame, sig.intervalMs);

  const idHex = canId.toString(16).toUpperCase();
  addSystemLog(`Signal "${sig.name}" ON (0x${idHex} every ${sig.intervalMs}ms)`);
}

export function stopSignal(sig) {
  if (sig.timer !== null) {
    clearInterval(sig.timer);
    sig.timer = null;
  }

  const wasActive = sig.active;
  sig.active = false;

  if (wasActive) {
    addSystemLog(`Signal "${sig.name}" OFF`);
  }
}

export function stopAllSignals() {
  for (const sig of state.signals) {
    stopSignal(sig);
  }
  renderSignals();
}

export function addSignal() {
  const name = document.getElementById('newSigName').value.trim() || `Signal ${state.sigCounter}`;
  const idHex = document.getElementById('newSigId').value.trim();
  const dataStr = document.getElementById('newSigData').value.trim();
  const ms = parseInt(document.getElementById('newSigMs').value) || 50;

  const canId = parseInt(idHex, 16);
  if (isNaN(canId)) {
    addSystemLog('Invalid CAN ID for signal.');
    return;
  }

  const dataBytes = dataStr
    ? dataStr.split(/[\s,]+/).map(b => parseInt(b, 16)).filter(b => !isNaN(b))
    : [];
  while (dataBytes.length < 8) dataBytes.push(0);

  state.signals.push({
    id: 'sig_' + state.sigCounter++,
    name: name,
    canId: canId,
    data: dataBytes.slice(0, 8),
    intervalMs: Math.max(1, ms),
    active: false,
    timer: null,
  });

  // Clear form
  document.getElementById('newSigName').value = '';
  document.getElementById('newSigId').value = '';
  document.getElementById('newSigData').value = '';
  document.getElementById('newSigMs').value = '50';

  renderSignals();
  addSystemLog(`Signal "${name}" added.`);
}

export function removeSignal(sigId) {
  const idx = state.signals.findIndex(s => s.id === sigId);
  if (idx === -1) return;

  // Stop if active
  stopSignal(state.signals[idx]);
  const name = state.signals[idx].name;
  state.signals.splice(idx, 1);
  renderSignals();
  addSystemLog(`Signal "${name}" removed.`);
}
