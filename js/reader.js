// ═══════════════════════════════════════════════════════
//  Async read loop
// ═══════════════════════════════════════════════════════

import { state } from './state.js';
import { addLogEntry, addSystemLog } from './ui.js';

export function startReading() {
  if (state.readLoopRunning) return; // prevent duplicate loops
  if (!state.device || !state.device.opened) return;

  state.readLoopRunning = true;
  addSystemLog(`Starting read loop on EP${state.endpointIn}...`);

  const read = async () => {
    let consecutiveErrors = 0;

    while (state.isConnected && state.device && state.device.opened) {
      try {
        const result = await state.device.transferIn(state.endpointIn, 64);

        if (result.status === 'ok' && result.data && result.data.byteLength >= 20) {
          consecutiveErrors = 0;

          const dv = result.data;
          const echo_id = dv.getUint32(0, true);
          const can_id_raw = dv.getUint32(4, true);
          const can_dlc = dv.getUint8(8);
          const channel = dv.getUint8(9);
          const flags = dv.getUint8(10);

          const isExt = (can_id_raw & 0x80000000) !== 0;
          const isRTR = (can_id_raw & 0x40000000) !== 0;
          const isErr = (can_id_raw & 0x20000000) !== 0;
          const rawId = isExt ? (can_id_raw & 0x1FFFFFFF) : (can_id_raw & 0x7FF);

          const dataBytes = [];
          for (let i = 0; i < Math.min(can_dlc, 8); i++) {
            dataBytes.push(dv.getUint8(12 + i));
          }

          if (state.debugMode) {
            const hexDump = [];
            for (let i = 0; i < dv.byteLength; i++) hexDump.push(dv.getUint8(i).toString(16).padStart(2, '0'));
            console.log(`[USB RX] ${dv.byteLength}B: ${hexDump.join(' ')} | echo_id=0x${echo_id.toString(16)} can_id=0x${can_id_raw.toString(16)} dlc=${can_dlc}`);
          }

          if (isErr) {
            state.errCount++;
            continue;
          }

          // echo_id == 0xFFFFFFFF means real bus frame; anything else is a TX echo
          if (echo_id !== 0xFFFFFFFF) {
            if (state.debugMode) console.log(`  -> TX echo (echo_id=${echo_id}), skipping`);
            continue;
          }

          state.rxCount++;

          addLogEntry('rx', {
            id: rawId,
            dlc: can_dlc,
            data: dataBytes,
            channel,
            flags,
            isExtended: isExt,
            isRTR,
          });

        } else if (result.status === 'ok' && result.data) {
          if (state.debugMode) {
            const hexDump = [];
            for (let i = 0; i < result.data.byteLength; i++) hexDump.push(result.data.getUint8(i).toString(16).padStart(2, '0'));
            console.log(`[USB RX] Short frame (${result.data.byteLength}B): ${hexDump.join(' ')}`);
          }
          consecutiveErrors = 0;
        } else if (result.status === 'stall') {
          addSystemLog('Endpoint stalled \u2014 clearing halt.');
          await state.device.clearHalt('in', state.endpointIn);
          consecutiveErrors = 0;
        } else if (result.status === 'babble') {
          addSystemLog('Babble error on endpoint.');
        }

      } catch (err) {
        if (!state.isConnected) break;

        consecutiveErrors++;
        console.error(`Read error (${consecutiveErrors}):`, err);
        state.errCount++;

        // Short pause, then keep trying
        await new Promise(r => setTimeout(r, 50));
      }
    }

    state.readLoopRunning = false;

    // Auto-restart if still connected (loop exited unexpectedly)
    if (state.isConnected && state.device && state.device.opened) {
      addSystemLog('Read loop exited \u2014 restarting...');
      await new Promise(r => setTimeout(r, 200));
      if (state.isConnected && state.device && state.device.opened) {
        state.readLoopRunning = true;
        read(); // restart
      }
    }
  };

  read();
}
