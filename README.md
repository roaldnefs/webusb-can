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

## How It Works

The app implements the **gs_usb protocol** over WebUSB:

1. **Device connection** — `navigator.usb.requestDevice()` with VID/PID filters
2. **Configuration** — USB vendor control transfers set host byte order, CAN bitrate (computed from the device's actual clock via `BT_CONST`), and operating mode
3. **Data transfer** — CAN frames are sent/received as 20-byte `gs_host_frame` structs over USB bulk endpoints
4. **Serialized TX** — all outbound frames go through a single queue to prevent USB contention
5. **Throttled rendering** — the UI updates at a fixed rate (5Hz) regardless of bus speed, keeping the browser responsive