// ═══════════════════════════════════════════════════════
//  UI helpers — log rendering, filters, export, pause
// ═══════════════════════════════════════════════════════

import { state, RENDER_INTERVAL, MAX_DOM_ENTRIES, MAX_RENDER_BATCH } from './state.js';

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

  // Keep max 10000 entries in memory (for export/filter)
  if (state.logEntries.length > 10000) state.logEntries.shift();

  // Buffer for next render tick
  state.pendingRender.push(entry);
}

export function addSystemLog(msg) {
  const scroll = document.getElementById('logScroll');
  const empty = document.getElementById('emptyState');
  if (empty) empty.remove();

  const div = document.createElement('div');
  div.style.cssText = `
    padding: 8px 24px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    color: var(--accent-amber);
    opacity: 0.8;
    border-bottom: 1px solid rgba(30, 45, 74, 0.3);
  `;
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

  const entries = state.pendingRender;
  state.pendingRender = [];

  if (entries.length === 0) return;

  const scroll = document.getElementById('logScroll');
  const filterInput = document.getElementById('filterInput').value.trim().toUpperCase();
  const fragment = document.createDocumentFragment();
  let added = 0;

  // If there are more entries than we can render, skip older ones
  const startIdx = Math.max(0, entries.length - MAX_RENDER_BATCH);

  for (let i = startIdx; i < entries.length; i++) {
    const entry = entries[i];
    if (state.currentFilter !== 'all' && entry.dir !== state.currentFilter) continue;
    if (filterInput && !entry.id.includes(filterInput)) continue;

    const div = document.createElement('div');
    div.className = entry.dir === 'tx' ? 'log-entry tx-row' : 'log-entry';
    div.innerHTML = `<span class="log-time">${entry.time}</span><span class="log-dir ${entry.dir}">${entry.dir.toUpperCase()}</span><span class="log-id">${entry.id}</span><span class="log-data">${entry.data}</span><span class="log-dlc">[${entry.dlc}]</span>`;
    fragment.appendChild(div);
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

  if (state.isPaused) {
    btn.textContent = 'Resume (0)';
    btn.style.borderColor = 'rgba(245, 158, 11, 0.4)';
    btn.style.color = 'var(--accent-amber)';
    btn.style.background = 'rgba(245, 158, 11, 0.1)';
  } else {
    btn.textContent = 'Pause';
    btn.style.borderColor = '';
    btn.style.color = '';
    btn.style.background = '';

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

  const filterInput = document.getElementById('filterInput').value.trim().toUpperCase();
  const fragment = document.createDocumentFragment();

  // Only render the last MAX_DOM_ENTRIES matching entries
  const matching = state.logEntries.filter(entry => {
    if (state.currentFilter !== 'all' && entry.dir !== state.currentFilter) return false;
    if (filterInput && !entry.id.includes(filterInput)) return false;
    return true;
  });

  const start = Math.max(0, matching.length - MAX_DOM_ENTRIES);
  for (let i = start; i < matching.length; i++) {
    const entry = matching[i];
    const div = document.createElement('div');
    div.className = entry.dir === 'tx' ? 'log-entry tx-row' : 'log-entry';
    div.innerHTML = `<span class="log-time">${entry.time}</span><span class="log-dir ${entry.dir}">${entry.dir.toUpperCase()}</span><span class="log-id">${entry.id}</span><span class="log-data">${entry.data}</span><span class="log-dlc">[${entry.dlc}]</span>`;
    fragment.appendChild(div);
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
  rebuildLog();
}

export function exportLog() {
  if (state.logEntries.length === 0) {
    addSystemLog('No log entries to export.');
    return;
  }

  let csv = 'Timestamp,Direction,ID,DLC,Data\n';
  state.logEntries.forEach(e => {
    csv += `${e.time},${e.dir},${e.id},${e.dlc},"${e.data}"\n`;
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
