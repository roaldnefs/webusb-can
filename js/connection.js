// ═══════════════════════════════════════════════════════
//  Connect / disconnect device
// ═══════════════════════════════════════════════════════

import { state, GS_USB_FILTERS } from './state.js';
import { gsUsbGetDeviceConfig, configureCAN, startCAN, stopCAN } from './gsusb.js';
import { startReading } from './reader.js';
import { stopRepeat } from './send.js';
import { stopAllSignals } from './signals.js';
import { updateConnectionUI, addSystemLog } from './ui.js';

export async function handleConnect() {
  if (state.isConnected) {
    await disconnectDevice();
  } else {
    await connectDevice();
  }
}

export async function connectDevice() {
  try {
    state.device = await navigator.usb.requestDevice({ filters: GS_USB_FILTERS });
    addSystemLog(`Selected device: ${state.device.productName || 'Unknown'} (VID:0x${state.device.vendorId.toString(16)}, PID:0x${state.device.productId.toString(16)})`);

    await state.device.open();
    addSystemLog('Device opened.');

    // Select configuration if needed
    if (state.device.configuration === null) {
      await state.device.selectConfiguration(1);
    }

    // Log all interfaces and endpoints for debugging
    addSystemLog(`Configuration ${state.device.configuration.configurationValue}: ${state.device.configuration.interfaces.length} interface(s)`);

    // Find the vendor-specific (gs_usb) interface
    let foundInterface = null;
    for (const iface of state.device.configuration.interfaces) {
      const alt = iface.alternate;
      addSystemLog(`  Interface ${iface.interfaceNumber}: class=0x${alt.interfaceClass.toString(16)}, subclass=0x${alt.interfaceSubclass.toString(16)}, endpoints=${alt.endpoints.length}`);

      for (const ep of alt.endpoints) {
        addSystemLog(`    EP ${ep.endpointNumber} dir=${ep.direction} type=${ep.type} packetSize=${ep.packetSize}`);
      }

      // gs_usb uses vendor class (0xFF) — but also accept if it has bulk in+out endpoints
      const hasBulkIn = alt.endpoints.some(e => e.direction === 'in' && e.type === 'bulk');
      const hasBulkOut = alt.endpoints.some(e => e.direction === 'out' && e.type === 'bulk');

      if (hasBulkIn && hasBulkOut) {
        foundInterface = iface;
        break;
      }
    }

    if (!foundInterface) {
      throw new Error('No suitable interface found with bulk IN + OUT endpoints. Make sure the device is running gs_usb compatible firmware (e.g. candleLight).');
    }

    state.claimedInterface = foundInterface.interfaceNumber;
    await state.device.claimInterface(state.claimedInterface);
    addSystemLog(`Claimed interface ${state.claimedInterface}.`);

    // Find bulk endpoints
    const alternate = foundInterface.alternate;
    for (const ep of alternate.endpoints) {
      if (ep.direction === 'in' && ep.type === 'bulk') {
        state.endpointIn = ep.endpointNumber;
      }
      if (ep.direction === 'out' && ep.type === 'bulk') {
        state.endpointOut = ep.endpointNumber;
      }
    }
    addSystemLog(`Using endpoints: IN=${state.endpointIn}, OUT=${state.endpointOut}`);

    // Get device config (number of channels)
    const configData = await gsUsbGetDeviceConfig();
    const numChannels = configData ? configData.icount + 1 : 1;

    // Update UI
    document.getElementById('infoVendor').textContent = state.device.manufacturerName || '\u2014';
    document.getElementById('infoProduct').textContent = state.device.productName || 'gs_usb device';
    document.getElementById('infoVidPid').textContent =
      `0x${state.device.vendorId.toString(16).toUpperCase()}:0x${state.device.productId.toString(16).toUpperCase()}`;
    document.getElementById('infoChannels').textContent = numChannels;

    state.isConnected = true;
    updateConnectionUI();

    // Configure and start CAN
    await configureCAN();
    await startCAN();

    // Begin reading
    startReading();

    addSystemLog('CAN interface started \u2014 listening for frames.');
  } catch (err) {
    console.error('Connection failed:', err);
    addSystemLog(`Connection failed: ${err.message}`);
  }
}

export async function disconnectDevice() {
  try {
    state.isStarted = false;
    stopRepeat();
    stopAllSignals();
    state.txQueue = [];
    state.readLoopRunning = false;

    // Stop CAN
    if (state.device && state.device.opened) {
      try { await stopCAN(); } catch(e) {}
      await state.device.releaseInterface(state.claimedInterface);
      await state.device.close();
    }

    state.device = null;
    state.isConnected = false;
    updateConnectionUI();
    addSystemLog('Device disconnected.');
  } catch (err) {
    console.error('Disconnect error:', err);
    state.device = null;
    state.isConnected = false;
    updateConnectionUI();
  }
}
