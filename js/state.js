// ═══════════════════════════════════════════════════════
//  Shared state & constants
// ═══════════════════════════════════════════════════════

// gs_usb vendor requests
export const GS_USB_BREQ = {
  HOST_FORMAT:    0,
  BITTIMING:      1,
  MODE:           2,
  BERR:           3,
  BT_CONST:       4,
  DEVICE_CONFIG:  5,
  TIMESTAMP:      6,
  IDENTIFY:       7,
};

export const GS_CAN_MODE = {
  RESET: 0,
  START: 1,
};

export const GS_CAN_FEATURE = {
  LISTEN_ONLY: (1 << 0),
  LOOP_BACK:   (1 << 1),
};

// Known gs_usb compatible device IDs
export const GS_USB_FILTERS = [
  // candleLight / CANable / CANable 2.0
  { vendorId: 0x1D50, productId: 0x606F },
];

// Render constants
export const RENDER_INTERVAL = 200;  // ms — render at most 5x per second
export const MAX_DOM_ENTRIES = 500;   // keep DOM small
export const MAX_RENDER_BATCH = 100;  // max rows to add per render tick
export const MAX_LOG_ENTRIES = 10000; // in-memory log cap (for export/filter)
export const LOG_TRIM_BATCH = 500;    // trim this many at once to amortize shift cost

// App state — all mutable globals in one place
export const state = {
  device: null,
  isConnected: false,
  isStarted: false,
  rxCount: 0,
  txCount: 0,
  errCount: 0,
  logEntries: [],
  currentFilter: 'all',
  currentView: 'log',
  readLoopRunning: false,
  endpointIn: 1,
  endpointOut: 1,
  claimedInterface: 0,
  debugMode: false,

  // TX queue
  txQueue: [],
  txBusy: false,

  // Render state
  pendingRender: [],
  isPaused: false,
  pauseBuffer: [],

  // Repeat send
  repeatTimer: null,
  repeatCount: 0,

  // Simulator (in-browser ICSim loopback)
  simActive: false,
  simTimer: null,
  simBogusEnabled: true,

  // Signals — minimal defaults. Turn signals are intentionally NOT seeded
  // here so attendees still have to discover the 0x188 turn-signal ID as
  // part of the workshop challenge.
  signals: [
    { id: 'sig_1', name: 'Speed 100',   canId: 0x244, data: [0, 0, 0, 0x27, 0x10, 0, 0, 0],  intervalMs: 50, active: false, timer: null },
    { id: 'sig_2', name: 'Doors open',  canId: 0x19B, data: [0, 0, 0x0F, 0, 0, 0, 0, 0],     intervalMs: 50, active: false, timer: null },
  ],
  sigCounter: 3,
};
