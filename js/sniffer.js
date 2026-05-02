// ═══════════════════════════════════════════════════════
//  Sniffer view — per-ID rolled-up table with byte-flash
//  on change and per-ID cycle time, à la cansniffer.
// ═══════════════════════════════════════════════════════

const FLASH_MS = 1000;
const STALE_MS = 5000;
const DROP_MS = 30000;
const COPIED_MS = 600;

// Aggregate state per CAN ID.
const rows = new Map();

// Persistent DOM nodes per CAN ID. Kept across renders so hover/scroll
// state survives and the byte-flash can fade smoothly.
const rowEls = new Map();

export function ingestFrame(dir, frame) {
  const now = performance.now();
  let row = rows.get(frame.id);
  if (!row) {
    row = {
      id: frame.id,
      isExtended: frame.isExtended,
      data: frame.data.slice(),
      dlc: frame.dlc,
      count: 1,
      lastSeen: now,
      cycleMs: 0,
      changedAt: new Array(8).fill(0),
      lastDir: dir,
    };
    rows.set(frame.id, row);
    return;
  }

  for (let i = 0; i < frame.data.length; i++) {
    if (row.data[i] !== frame.data[i]) row.changedAt[i] = now;
  }
  row.data = frame.data.slice();
  row.dlc = frame.dlc;
  row.count++;
  row.cycleMs = now - row.lastSeen;
  row.lastSeen = now;
  row.lastDir = dir;
}

export function clearSniffer() {
  rows.clear();
  for (const el of rowEls.values()) el.tr.remove();
  rowEls.clear();
}

function formatId(row) {
  return row.isExtended
    ? row.id.toString(16).toUpperCase().padStart(8, '0')
    : row.id.toString(16).toUpperCase().padStart(3, '0');
}

function createRowElement(row) {
  const tr = document.createElement('div');
  tr.className = 'sniff-row';
  tr.title = 'Click to copy hex bytes';
  tr.addEventListener('click', () => copyRow(tr, row));

  const idCell = document.createElement('span');
  idCell.className = 'sniff-id';

  const cycleCell = document.createElement('span');
  cycleCell.className = 'sniff-cycle';

  const countCell = document.createElement('span');
  countCell.className = 'sniff-count';

  const dlcCell = document.createElement('span');
  dlcCell.className = 'sniff-dlc';

  const dataCell = document.createElement('span');
  dataCell.className = 'sniff-data';

  const byteCells = [];
  for (let i = 0; i < 8; i++) {
    const b = document.createElement('span');
    b.className = 'sniff-byte';
    dataCell.appendChild(b);
    byteCells.push(b);
  }

  const asciiCell = document.createElement('span');
  asciiCell.className = 'sniff-ascii';

  tr.append(idCell, cycleCell, countCell, dlcCell, dataCell, asciiCell);
  return { tr, idCell, cycleCell, countCell, dlcCell, byteCells, asciiCell };
}

function copyRow(tr, row) {
  const hex = row.data
    .map(b => b.toString(16).toUpperCase().padStart(2, '0'))
    .join(' ');
  navigator.clipboard?.writeText(hex);
  tr.classList.add('copied');
  setTimeout(() => tr.classList.remove('copied'), COPIED_MS);
}

function updateRowElement(el, row, idStr, now) {
  el.idCell.textContent = idStr;
  el.cycleCell.textContent = row.cycleMs > 0 ? row.cycleMs.toFixed(1) : '--';
  el.countCell.textContent = row.count;
  el.dlcCell.textContent = `[${row.dlc}]`;

  const stale = now - row.lastSeen > STALE_MS;
  el.tr.classList.toggle('stale', stale);

  let ascii = '';
  for (let i = 0; i < 8; i++) {
    const b = el.byteCells[i];
    if (i < row.data.length) {
      const v = row.data[i];
      b.textContent = v.toString(16).toUpperCase().padStart(2, '0');
      ascii += (v >= 0x20 && v < 0x7F) ? String.fromCharCode(v) : '.';
      const elapsed = now - row.changedAt[i];
      if (elapsed < FLASH_MS) {
        const intensity = 1 - elapsed / FLASH_MS;
        b.style.background = `rgba(245, 158, 11, ${(intensity * 0.55).toFixed(3)})`;
        b.style.color = intensity > 0.5 ? '#000' : '';
      } else {
        b.style.background = '';
        b.style.color = '';
      }
    } else {
      b.textContent = '';
      b.style.background = '';
      b.style.color = '';
    }
  }
  el.asciiCell.textContent = ascii;
}

// Render the visible set of rows. `passes(idStr, dir)` is supplied by ui.js
// so the sniffer reuses the same filter chips and ID filter as the log view.
export function renderSniffer(passes) {
  const scroll = document.getElementById('snifferScroll');
  const empty = document.getElementById('snifferEmpty');
  const now = performance.now();

  // Drop rows that haven't been seen in a long time. Stale-but-visible rows
  // are dimmed via the .stale class earlier; once they cross DROP_MS they
  // disappear. If the same ID returns later, ingestFrame re-creates it.
  for (const [id, row] of rows) {
    if (now - row.lastSeen > DROP_MS) rows.delete(id);
  }

  const sortedIds = [...rows.keys()].sort((a, b) => a - b);
  const visible = [];
  for (const id of sortedIds) {
    const row = rows.get(id);
    const idStr = formatId(row);
    if (!passes(idStr, row.lastDir)) continue;
    visible.push({ id, row, idStr });
  }

  const visibleSet = new Set(visible.map(v => v.id));
  for (const [id, el] of rowEls) {
    if (!visibleSet.has(id)) {
      el.tr.remove();
      rowEls.delete(id);
    }
  }

  // Place each row in sorted DOM order.
  let prev = null;
  for (const { id, row, idStr } of visible) {
    let el = rowEls.get(id);
    if (!el) {
      el = createRowElement(row);
      rowEls.set(id, el);
    }
    updateRowElement(el, row, idStr, now);

    const expectedNext = prev ? prev.tr.nextElementSibling : scroll.firstElementChild;
    if (el.tr !== expectedNext) {
      scroll.insertBefore(el.tr, expectedNext);
    }
    prev = el;
  }

  if (empty) empty.hidden = visible.length > 0;
}
