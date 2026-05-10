// ═══════════════════════════════════════════════════════
//  Signal system — toggleable periodic CAN messages
// ═══════════════════════════════════════════════════════

import { state } from './state.js';
import { buildGsHostFrame, queueTx } from './frames.js';
import { addSystemLog } from './ui.js';

const STORAGE_KEY = 'webusb-can-signals';

function saveSignals() {
  try {
    const data = {
      signals: state.signals.map(s => ({
        id: s.id,
        name: s.name,
        canId: s.canId,
        data: s.data,
        intervalMs: s.intervalMs,
      })),
      sigCounter: state.sigCounter,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    console.warn('Failed to persist signals:', e);
  }
}

function loadSignals() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.signals)) return;
    state.signals = data.signals.map(s => ({
      id: s.id,
      name: s.name,
      canId: s.canId,
      data: s.data,
      intervalMs: s.intervalMs,
      active: false,
      timer: null,
    }));
    if (typeof data.sigCounter === 'number') state.sigCounter = data.sigCounter;
  } catch (e) {
    console.warn('Failed to load signals:', e);
  }
}

loadSignals();

// Toggle the Add Signal button text between "+ Add Signal" and "Update Signal"
// based on whether the current name input matches an existing signal.
function refreshSignalAddBtn() {
  const nameEl = document.getElementById('newSigName');
  const btn = document.getElementById('addSigBtn');
  if (!nameEl || !btn) return;
  const name = nameEl.value.trim();
  const exists = name.length > 0 && state.signals.some(s => s.name === name);
  btn.textContent = exists ? 'Update Signal' : '+ Add Signal';
}

document.addEventListener('DOMContentLoaded', () => {
  const nameEl = document.getElementById('newSigName');
  if (nameEl) nameEl.addEventListener('input', refreshSignalAddBtn);
});
// In case DOMContentLoaded already fired by the time the module runs.
const _nameEl = document.getElementById('newSigName');
if (_nameEl) _nameEl.addEventListener('input', refreshSignalAddBtn);

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
      <button class="signal-edit" onclick="editSignal('${sig.id}')" title="Edit (loads into form below)">&#9998;</button>
      <button class="signal-remove" onclick="removeSignal('${sig.id}')" title="Remove">&#10005;</button>
    `;
    list.appendChild(row);
  }
}

// Populate the Add Signal form with this signal's current values. The user
// can then tweak and click + Add Signal — addSignal() upserts by name, so
// the existing entry is overwritten in place rather than duplicated.
export function editSignal(sigId) {
  const sig = state.signals.find(s => s.id === sigId);
  if (!sig) return;
  const idHex = sig.canId.toString(16).toUpperCase();
  const dataHex = sig.data.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
  document.getElementById('newSigName').value = sig.name;
  document.getElementById('newSigId').value = idHex;
  document.getElementById('newSigData').value = dataHex;
  document.getElementById('newSigMs').value = String(sig.intervalMs);
  document.getElementById('newSigName').focus();
  refreshSignalAddBtn();
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
  if (!state.isConnected) {
    addSystemLog('Not connected. Connect a device or start the simulator first.');
    return;
  }

  const canId = sig.canId;
  const data = sig.data.slice();
  const dlc = data.length;
  const isExtended = canId > 0x7FF;

  const sendFrame = () => {
    if (!state.isConnected) {
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

// Pure version of addSignal — no DOM reads. Same upsert-by-name semantics.
// Used by addSignal (form path) and window.api.signals.add (console path).
export function addSignalDirect({ name, canId, data, intervalMs } = {}) {
  if (typeof canId !== 'number' || !Number.isFinite(canId) || canId < 0) {
    throw new Error('addSignal: canId must be a non-negative number');
  }
  const resolvedName = (typeof name === 'string' && name.trim()) || `Signal ${state.sigCounter}`;
  const bytes = Array.isArray(data) || ArrayBuffer.isView(data) ? Array.from(data) : [];
  while (bytes.length < 8) bytes.push(0);
  const finalData = bytes.slice(0, 8);
  const finalInterval = Math.max(1, parseInt(intervalMs, 10) || 50);

  const existing = state.signals.find(s => s.name === resolvedName);
  let stored;
  let resultMsg;
  if (existing) {
    const wasActive = existing.active;
    if (wasActive) stopSignal(existing);
    existing.canId = canId;
    existing.data = finalData;
    existing.intervalMs = finalInterval;
    if (wasActive) startSignal(existing);
    stored = existing;
    resultMsg = `Signal "${resolvedName}" updated.`;
  } else {
    stored = {
      id: 'sig_' + state.sigCounter++,
      name: resolvedName,
      canId,
      data: finalData,
      intervalMs: finalInterval,
      active: false,
      timer: null,
    };
    state.signals.push(stored);
    resultMsg = `Signal "${resolvedName}" added.`;
  }
  saveSignals();
  renderSignals();
  addSystemLog(resultMsg);
  return stored;
}

export function findSignal(idOrName) {
  if (idOrName == null) return null;
  return state.signals.find(s => s.id === idOrName)
      || state.signals.find(s => s.name === idOrName)
      || null;
}

export function addSignal() {
  const name = document.getElementById('newSigName').value.trim() || `Signal ${state.sigCounter}`;
  const idHex = document.getElementById('newSigId').value.trim().replace(/^0[xX]/, '');
  const dataStr = document.getElementById('newSigData').value.trim();
  const ms = parseInt(document.getElementById('newSigMs').value) || 50;

  const canId = parseInt(idHex, 16);
  if (isNaN(canId)) {
    addSystemLog('Invalid CAN ID for signal.');
    return;
  }

  const dataBytes = dataStr
    ? (dataStr.replace(/[\s,]+/g, '').match(/.{1,2}/g) || []).map(b => parseInt(b, 16)).filter(b => !isNaN(b))
    : [];

  addSignalDirect({ name, canId, data: dataBytes, intervalMs: ms });

  document.getElementById('newSigName').value = '';
  document.getElementById('newSigId').value = '';
  document.getElementById('newSigData').value = '';
  document.getElementById('newSigMs').value = '50';
  refreshSignalAddBtn();
}

export function removeSignal(sigId) {
  const idx = state.signals.findIndex(s => s.id === sigId);
  if (idx === -1) return;

  // Stop if active
  stopSignal(state.signals[idx]);
  const name = state.signals[idx].name;
  state.signals.splice(idx, 1);
  saveSignals();
  renderSignals();
  addSystemLog(`Signal "${name}" removed.`);
}
