// ═══════════════════════════════════════════════════════
//  gs_usb protocol: config, bittiming, mode, start/stop
// ═══════════════════════════════════════════════════════

import { state, GS_USB_BREQ, GS_CAN_MODE, GS_CAN_FEATURE } from './state.js';
import { addSystemLog } from './ui.js';

export async function gsUsbGetDeviceConfig() {
  try {
    const result = await state.device.controlTransferIn({
      requestType: 'vendor',
      recipient: 'interface',
      request: GS_USB_BREQ.DEVICE_CONFIG,
      value: 0,
      index: state.claimedInterface,
    }, 12);

    if (result.status === 'ok' && result.data) {
      const view = result.data;
      const icount = view.getUint8(3);
      const sw_version = view.getUint32(4, true);
      addSystemLog(`Device config: channels=${icount + 1}, sw_version=${sw_version}`);
      return {
        icount: icount,
        sw_version: sw_version,
      };
    }
  } catch (e) {
    console.warn('Could not get device config:', e);
    addSystemLog(`Device config query failed (non-critical): ${e.message}`);
  }
  return null;
}

async function gsUsbSetHostFormat() {
  // Host format: little-endian (0x0000BEEF)
  const data = new ArrayBuffer(4);
  const view = new DataView(data);
  view.setUint32(0, 0x0000BEEF, true);

  await state.device.controlTransferOut({
    requestType: 'vendor',
    recipient: 'interface',
    request: GS_USB_BREQ.HOST_FORMAT,
    value: 0,
    index: state.claimedInterface,
  }, data);
}

export async function gsUsbSetBittiming(bitrate, brp, tseg1, tseg2, sjw) {
  const prop_seg = 0;

  const data = new ArrayBuffer(20);
  const view = new DataView(data);
  view.setUint32(0, prop_seg, true);
  view.setUint32(4, tseg1, true);
  view.setUint32(8, tseg2, true);
  view.setUint32(12, sjw, true);
  view.setUint32(16, brp, true);

  addSystemLog(`Writing bittiming: prop_seg=${prop_seg}, tseg1=${tseg1}, tseg2=${tseg2}, sjw=${sjw}, brp=${brp}`);

  await state.device.controlTransferOut({
    requestType: 'vendor',
    recipient: 'interface',
    request: GS_USB_BREQ.BITTIMING,
    value: 0,
    index: state.claimedInterface,
  }, data);
}

async function gsUsbSetMode(mode, flags) {
  const data = new ArrayBuffer(8);
  const view = new DataView(data);
  view.setUint32(0, mode, true);
  view.setUint32(4, flags, true);

  await state.device.controlTransferOut({
    requestType: 'vendor',
    recipient: 'interface',
    request: GS_USB_BREQ.MODE,
    value: 0,
    index: state.claimedInterface,
  }, data);
}

export async function configureCAN() {
  const bitrate = parseInt(document.getElementById('bitrateSelect').value);
  await gsUsbSetHostFormat();

  // Query BT_CONST to get actual CAN clock frequency
  let canClock = 48000000; // default assumption
  try {
    const btResult = await state.device.controlTransferIn({
      requestType: 'vendor',
      recipient: 'interface',
      request: GS_USB_BREQ.BT_CONST,
      value: 0,
      index: state.claimedInterface,
    }, 40);

    if (btResult.status === 'ok' && btResult.data && btResult.data.byteLength >= 40) {
      const btView = btResult.data;
      const features = btView.getUint32(0, true);
      canClock = btView.getUint32(4, true);
      const tseg1_min = btView.getUint32(8, true);
      const tseg1_max = btView.getUint32(12, true);
      const tseg2_min = btView.getUint32(16, true);
      const tseg2_max = btView.getUint32(20, true);
      const sjw_max = btView.getUint32(24, true);
      const brp_min = btView.getUint32(28, true);
      const brp_max = btView.getUint32(32, true);
      const brp_inc = btView.getUint32(36, true);

      addSystemLog(`CAN clock: ${(canClock/1e6).toFixed(1)} MHz, features=0x${features.toString(16)}`);
      addSystemLog(`BT limits: tseg1=[${tseg1_min}..${tseg1_max}], tseg2=[${tseg2_min}..${tseg2_max}], brp=[${brp_min}..${brp_max}]`);
    }
  } catch (e) {
    addSystemLog(`BT_CONST query failed, using default 48MHz clock: ${e.message}`);
  }

  // Compute bittiming from actual clock
  const numTq = 16;
  const tseg1 = 13;
  const tseg2 = 2;
  const sjw = 1;
  const brp = Math.round(canClock / (bitrate * numTq));

  addSystemLog(`Computed bittiming for ${bitrate}bps: brp=${brp}, tseg1=${tseg1}, tseg2=${tseg2} (${numTq} TQ, clock=${canClock}Hz)`);

  // Verify
  const actualBitrate = canClock / (brp * numTq);
  const errorPct = Math.abs(actualBitrate - bitrate) / bitrate * 100;
  if (errorPct > 1) {
    addSystemLog(`WARNING: Actual bitrate ${actualBitrate.toFixed(0)}bps differs by ${errorPct.toFixed(1)}% from target!`);
  }

  await gsUsbSetBittiming(bitrate, brp, tseg1, tseg2, sjw);
}

export async function startCAN() {
  let flags = 0;
  const mode = document.getElementById('modeSelect').value;
  if (mode === 'loopback') flags |= GS_CAN_FEATURE.LOOP_BACK;
  if (mode === 'listenonly') flags |= GS_CAN_FEATURE.LISTEN_ONLY;

  await gsUsbSetMode(GS_CAN_MODE.START, flags);
  state.isStarted = true;
}

export async function stopCAN() {
  await gsUsbSetMode(GS_CAN_MODE.RESET, 0);
  state.isStarted = false;
}
