// ═══════════════════════════════════════════════════════
//  UI helpers — log rendering, filters, export, pause
// ═══════════════════════════════════════════════════════

import { state, RENDER_INTERVAL, MAX_DOM_ENTRIES, MAX_RENDER_BATCH, MAX_LOG_ENTRIES, LOG_TRIM_BATCH } from './state.js';
import { ingestFrame, renderSniffer, clearSniffer } from './sniffer.js';

// Read & normalize the ID filter input. Strips a leading 0x/0X.
// Marks the input invalid (and returns '') if non-hex chars remain.
function getIdFilter() {
  const el = document.getElementById('filterInput');
  const raw = el.value.trim().replace(/^0[xX]/, '').toUpperCase();
  if (raw && !/^[0-9A-F]+$/.test(raw)) {
    el.classList.add('invalid');
    return '';
  }
  el.classList.remove('invalid');
  return raw;
}

// Build the set of zero-padded ID strings to match for the "UDS" filter chip.
// Reads the UDS panel inputs live so changes apply on the next render tick.
function getUdsIdSet() {
  const ids = new Set();
  const tx = document.getElementById('udsTxId');
  const rx = document.getElementById('udsRxId');
  for (const el of [tx, rx]) {
    if (!el) continue;
    const v = parseInt(el.value.trim().replace(/^0[xX]/, ''), 16);
    if (isNaN(v)) continue;
    ids.add(v > 0x7FF
      ? v.toString(16).toUpperCase().padStart(8, '0')
      : v.toString(16).toUpperCase().padStart(3, '0'));
  }
  return ids;
}

function entryMatchesDirFilter(entry, udsIds) {
  switch (state.currentFilter) {
    case 'all': return true;
    case 'rx':
    case 'tx': return entry.dir === state.currentFilter;
    case 'uds': return udsIds.has(entry.id);
    default: return true;
  }
}

function copyLogRow(row, entry) {
  navigator.clipboard?.writeText(entry.data);
  row.classList.remove('copied');
  // Force a reflow so re-adding the class restarts the animation.
  void row.offsetWidth;
  row.classList.add('copied');
}

function buildLogRow(entry) {
  const row = document.createElement('div');
  row.className = entry.dir === 'tx' ? 'log-entry tx-row' : 'log-entry';
  row.title = 'Click to copy data hex';
  row.addEventListener('click', () => copyLogRow(row, entry));

  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = entry.time;

  const dir = document.createElement('span');
  dir.className = `log-dir ${entry.dir}`;
  dir.textContent = entry.dir.toUpperCase();

  const id = document.createElement('span');
  id.className = 'log-id';
  id.textContent = entry.id;

  const data = document.createElement('span');
  data.className = 'log-data';
  data.textContent = entry.data;

  const dlc = document.createElement('span');
  dlc.className = 'log-dlc';
  dlc.textContent = `[${entry.dlc}]`;

  row.append(time, dir, id, data, dlc);
  return row;
}

export function updateConnectionUI() {
  const chip = document.getElementById('statusChip');
  const text = document.getElementById('statusText');
  const btn = document.getElementById('connectBtn');

  if (state.isConnected) {
    chip.className = 'status-chip connected';
    text.textContent = 'Connected';
    btn.className = 'btn btn-danger';
    btn.innerHTML = '&#9632; Disconnect';
  } else {
    chip.className = 'status-chip disconnected';
    text.textContent = 'Disconnected';
    btn.className = 'btn btn-primary';
    btn.innerHTML = '&#9654; Connect Device';

    document.getElementById('infoVendor').textContent = '\u2014';
    document.getElementById('infoProduct').textContent = '\u2014';
    document.getElementById('infoVidPid').textContent = '\u2014';
    document.getElementById('infoChannels').textContent = '\u2014';
  }
}

export function addLogEntry(dir, frame) {
  const now = new Date();
  const time = now.toLocaleTimeString('en-US', { hour12: false }) +
    '.' + String(now.getMilliseconds()).padStart(3, '0');

  const idStr = frame.isExtended
    ? frame.id.toString(16).toUpperCase().padStart(8, '0')
    : frame.id.toString(16).toUpperCase().padStart(3, '0');

  const dataStr = frame.data.map(b =>
    b.toString(16).toUpperCase().padStart(2, '0')
  ).join(' ');

  const entry = { time, dir, id: idStr, data: dataStr, dlc: frame.dlc };
  state.logEntries.push(entry);

  // Trim in batches to amortize the O(n) shift cost
  if (state.logEntries.length > MAX_LOG_ENTRIES + LOG_TRIM_BATCH) {
    state.logEntries.splice(0, LOG_TRIM_BATCH);
  }

  // Buffer for next render tick
  state.pendingRender.push(entry);

  // Feed the sniffer aggregate
  ingestFrame(dir, frame);
}

export function addSystemLog(msg) {
  const scroll = document.getElementById('logScroll');
  const empty = document.getElementById('emptyState');
  if (empty) empty.remove();

  const div = document.createElement('div');
  div.className = 'log-system';
  div.textContent = `[SYS] ${msg}`;
  scroll.appendChild(div);

  if (document.getElementById('autoScroll').checked) {
    scroll.scrollTop = scroll.scrollHeight;
  }
}

export function renderTick() {
  // Always schedule next tick
  setTimeout(renderTick, RENDER_INTERVAL);

  // Update stat counters (cheap — no layout reflow)
  document.getElementById('rxCount').textContent = state.rxCount;
  document.getElementById('txCount').textContent = state.txCount;
  document.getElementById('errCount').textContent = state.errCount;

  if (state.isPaused) {
    // Buffer entries while paused
    if (state.pendingRender.length > 0) {
      state.pauseBuffer.push(...state.pendingRender);
      state.pendingRender = [];
      // Cap pause buffer too
      if (state.pauseBuffer.length > 10000) state.pauseBuffer = state.pauseBuffer.slice(-10000);
      document.getElementById('pauseBtn').textContent = `Resume (${state.pauseBuffer.length})`;
    }
    return;
  }

  // Sniffer view: update the rolled-up table and skip the log DOM path.
  // pendingRender is dropped here — state.logEntries is the source of truth
  // and is replayed via rebuildLog() when the user switches back.
  if (state.currentView === 'sniff') {
    state.pendingRender = [];
    const filterInput = getIdFilter();
    const udsIds = state.currentFilter === 'uds' ? getUdsIdSet() : null;
    renderSniffer((idStr, dir) => {
      if (state.currentFilter === 'rx' || state.currentFilter === 'tx') {
        if (dir !== state.currentFilter) return false;
      } else if (state.currentFilter === 'uds') {
        if (!udsIds.has(idStr)) return false;
      }
      if (filterInput && !idStr.includes(filterInput)) return false;
      return true;
    });
    return;
  }

  const entries = state.pendingRender;
  state.pendingRender = [];

  if (entries.length === 0) return;

  const scroll = document.getElementById('logScroll');
  const filterInput = getIdFilter();
  const udsIds = state.currentFilter === 'uds' ? getUdsIdSet() : null;
  const fragment = document.createDocumentFragment();
  let added = 0;

  // If there are more entries than we can render, skip older ones
  const startIdx = Math.max(0, entries.length - MAX_RENDER_BATCH);

  for (let i = startIdx; i < entries.length; i++) {
    const entry = entries[i];
    if (!entryMatchesDirFilter(entry, udsIds)) continue;
    if (filterInput && !entry.id.includes(filterInput)) continue;

    fragment.appendChild(buildLogRow(entry));
    added++;
  }

  if (added === 0) return;

  // Remove empty state
  const empty = document.getElementById('emptyState');
  if (empty) empty.remove();

  scroll.appendChild(fragment);

  // Trim DOM — remove from top
  while (scroll.children.length > MAX_DOM_ENTRIES) {
    scroll.removeChild(scroll.firstChild);
  }

  // Auto-scroll (single reflow at the end)
  if (document.getElementById('autoScroll').checked) {
    scroll.scrollTop = scroll.scrollHeight;
  }

  // Show dropped count if we skipped frames
  if (startIdx > 0) {
    const skipped = startIdx;
    console.log(`[Render] Skipped ${skipped} frames to keep UI responsive`);
  }
}

export function togglePause() {
  state.isPaused = !state.isPaused;
  const btn = document.getElementById('pauseBtn');

  btn.classList.toggle('paused', state.isPaused);
  btn.textContent = state.isPaused ? 'Resume (0)' : 'Pause';

  if (!state.isPaused) {
    // Flush buffered entries — only render the tail
    if (state.pauseBuffer.length > 0) {
      const tail = state.pauseBuffer.slice(-MAX_RENDER_BATCH);
      state.pendingRender.push(...tail);
      if (state.pauseBuffer.length > MAX_RENDER_BATCH) {
        addSystemLog(`Resumed \u2014 showing last ${MAX_RENDER_BATCH} of ${state.pauseBuffer.length} buffered frames.`);
      }
      state.pauseBuffer = [];
    }
  }
}

export function setFilter(filter, el) {
  state.currentFilter = filter;
  document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  rebuildLog();
}

export function rebuildLog() {
  const scroll = document.getElementById('logScroll');
  scroll.innerHTML = '';

  if (state.logEntries.length === 0) {
    scroll.innerHTML = `
      <div class="empty-state" id="emptyState">
        <div class="empty-icon">&#128268;</div>
        <h3>No CAN messages yet</h3>
        <p>Connect your gs_usb compatible CAN adapter to start capturing CAN bus traffic.</p>
      </div>`;
    return;
  }

  const filterInput = getIdFilter();
  const udsIds = state.currentFilter === 'uds' ? getUdsIdSet() : null;
  const fragment = document.createDocumentFragment();

  // Only render the last MAX_DOM_ENTRIES matching entries
  const matching = state.logEntries.filter(entry => {
    if (!entryMatchesDirFilter(entry, udsIds)) return false;
    if (filterInput && !entry.id.includes(filterInput)) return false;
    return true;
  });

  const start = Math.max(0, matching.length - MAX_DOM_ENTRIES);
  for (let i = start; i < matching.length; i++) {
    fragment.appendChild(buildLogRow(matching[i]));
  }

  scroll.appendChild(fragment);

  if (document.getElementById('autoScroll').checked) {
    scroll.scrollTop = scroll.scrollHeight;
  }
}

export function clearLog() {
  state.logEntries = [];
  state.rxCount = 0;
  state.txCount = 0;
  state.errCount = 0;
  document.getElementById('rxCount').textContent = '0';
  document.getElementById('txCount').textContent = '0';
  document.getElementById('errCount').textContent = '0';
  clearSniffer();
  rebuildLog();
}

export function setView(view) {
  state.currentView = view;
  const logScroll = document.getElementById('logScroll');
  const snifferScroll = document.getElementById('snifferScroll');
  const btn = document.getElementById('viewToggleBtn');
  const isSniff = view === 'sniff';
  logScroll.hidden = isSniff;
  snifferScroll.hidden = !isSniff;
  btn.textContent = isSniff ? 'Log View' : 'Sniff View';
  btn.classList.toggle('active', isSniff);
  if (!isSniff) rebuildLog();
}

export function toggleView() {
  setView(state.currentView === 'sniff' ? 'log' : 'sniff');
}

export function exportLog() {
  if (state.logEntries.length === 0) {
    addSystemLog('No log entries to export.');
    return;
  }

  const csvField = (v) => {
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  let csv = 'Timestamp,Direction,ID,DLC,Data\n';
  state.logEntries.forEach(e => {
    csv += [e.time, e.dir, e.id, e.dlc, e.data].map(csvField).join(',') + '\n';
  });

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `can_log_${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  addSystemLog('Log exported as CSV.');
}
