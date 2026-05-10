# WebUSB CAN

A browser-based CAN bus interface using the WebUSB API. No drivers, no installs, just open Chrome and connect your adapter.

## Supported Devices

Works with any USB-to-CAN adapter running **gs_usb compatible firmware** (candleLight, etc.):

| Device | VID:PID |
|--------|---------|
| candleLight / CANable / CANable 2.0 | `1D50:606F` |

**Not supported:** Devices using slcan firmware (serial), PCAN-USB, Kvaser, Vector, or other proprietary protocols.

## Requirements

- **Chrome 61+** or **Edge 79+** (WebUSB is not supported in Firefox or Safari)
- **HTTPS** or **localhost** (WebUSB requires a secure context)
- CAN adapter with **gs_usb / candleLight firmware**

## Usage

Serve the project over HTTP (ES modules require it — `file://` will not work):

```sh
python3 -m http.server 8000
```

Then open `http://localhost:8000` in Chrome or Edge. Connect your CAN adapter, select the bitrate and mode, and click **Connect**.

## Console API

Open Developer Tools and drive the app from `window.api`.

### Connection

```js
await api.connect();          // open the WebUSB device picker
await api.disconnect();       // release the device
api.isConnected();            // boolean
```

### Send frames

`id` is a number (e.g. `0x244`). `data` is a `number[]` or `Uint8Array`. `dlc` defaults to `data.length` (capped at 8). `isExtended` defaults to `id > 0x7FF`.

```js
// One frame
api.send({ id: 0x244, data: [0, 0, 0, 0x19, 0, 0, 0, 0] });

// Repeat — returns a handle with stop() and count()
const r = api.sendRepeat({
  id: 0x244,
  data: [0, 0, 0, 0x27, 0x10, 0, 0, 0],
  intervalMs: 50,
});
setTimeout(() => { console.log('sent', r.count()); r.stop(); }, 1000);
```

`api.send` throws if the app is not connected — wrap in `try`/`catch` if you call it speculatively.

### Listen for frames

Bus RX only — frames you send via `api.send` are **not** echoed to listeners (mirrors the underlying `onCanFrame` semantics). Both return an unsubscribe function.

```js
// Per-ID
const off = api.onFrame(0x188, data => console.log('signal byte', data[0]));
off();

// Wildcard — every received frame
const offAll = api.onAnyFrame(({ id, data }) => {
  console.log(id.toString(16), data);
});
setTimeout(offAll, 5000);
```

### Simulator

```js
api.simulator.start();         // start the in-browser virtual bus
api.simulator.accel(true);     // hold accelerator
api.simulator.brake(true);     // hold brake (mutually exclusive with accel)
api.simulator.signalLeft();    // toggle left turn signal
api.simulator.signalRight();   // toggle right turn signal
api.simulator.door('FL');      // toggle door: 'FL' | 'FR' | 'RL' | 'RR'
api.simulator.setBogus(true);  // enable random noise traffic
await api.simulator.stop();
```

### Signals

Persistent, toggleable periodic senders shown in the sidebar.

```js
api.signals.list();
// → [{id, name, canId, data, intervalMs, active}, …]

api.signals.add({
  name: 'Doors open',
  canId: 0x19B,
  data: [0, 0, 0x0F],
  intervalMs: 100,
});

api.signals.toggle('Doors open');   // resolves by id or name → new active state
api.signals.remove('Doors open');   // → true if removed
```

### State snapshot

```js
api.state();
// → { isConnected, simActive, rxCount, txCount, errCount, signalCount, repeatActive }
```

## How It Works

The app implements the **gs_usb protocol** over WebUSB:

1. **Device connection** — `navigator.usb.requestDevice()` with VID/PID filters
2. **Configuration** — USB vendor control transfers set host byte order, CAN bitrate (computed from the device's actual clock via `BT_CONST`), and operating mode
3. **Data transfer** — CAN frames are sent/received as 20-byte `gs_host_frame` structs over USB bulk endpoints
4. **Serialized TX** — all outbound frames go through a single queue to prevent USB contention
5. **Throttled rendering** — the UI updates at a fixed rate (5Hz) regardless of bus speed, keeping the browser responsive

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
