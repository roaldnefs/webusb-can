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
  readLoopRunning: false,
  endpointIn: 1,
  endpointOut: 1,
  claimedInterface: 0,
  debugMode: true,

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

  // Signals
  signals: [
    { id: 'sig_1', name: 'Turn Left', canId: 0x470, data: [0x01, 0,0,0,0,0,0,0], intervalMs: 50, active: false, timer: null },
    { id: 'sig_2', name: 'Turn Right', canId: 0x470, data: [0x02, 0,0,0,0,0,0,0], intervalMs: 50, active: false, timer: null },
    { id: 'sig_3', name: 'Hazards', canId: 0x470, data: [0x03, 0,0,0,0,0,0,0], intervalMs: 50, active: false, timer: null },
    { id: 'sig_4', name: 'RPM', canId: 0x280, data: [0x00, 0x00, 0x00, 0x22, 0x00], intervalMs: 50, active: false, timer: null },
  ],
  sigCounter: 5,
};
