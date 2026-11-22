// ═══════════════════════════════════════════════════════
//  Simulated engine ECU — UDS (ISO 14229) + a little OBD-II over ISO-TP.
//
//  Physical request 0x7E0, response 0x7E8, functional request 0x7DF.
//  DOM-free: the simulator hands it every transmitted frame and gives it a
//  `send` callback that injects frames into the RX pipeline.
//
//  Services:
//    10 DiagnosticSessionControl   01 default, 03 extended
//    11 ECUReset                   01 hard reset
//    14 ClearDiagnosticInformation FF FF FF
//    19 ReadDTCInformation         01 count, 02 by status mask
//    22 ReadDataByIdentifier       see DIDS below
//    27 SecurityAccess             01 seed / 02 key (extended session only)
//    3E TesterPresent              00, 80 (suppress response)
//    OBD 01 (PIDs 00 05 0C 0D) and 09 (PID 02, VIN)
//
//  Non-default sessions drop back to default (and re-lock) after S3_MS
//  without a request — Tester Present keeps them alive.
// ═══════════════════════════════════════════════════════

export const ECU_REQ_ID = 0x7E0;
export const ECU_RESP_ID = 0x7E8;
export const ECU_FUNC_ID = 0x7DF;

const PAD = 0xAA;
const S3_MS = 5000;
const RESPONSE_DELAY_MS = 8;
const MAX_KEY_ATTEMPTS = 3;
const LOCKOUT_MS = 10000;
// Deliberately weak seed/key: key = seed XOR mask. Workshop material.
const KEY_MASK = 0x5EC0DE42;

const NRC = {
  SERVICE_NOT_SUPPORTED: 0x11,
  SUBFUNCTION_NOT_SUPPORTED: 0x12,
  BAD_LENGTH: 0x13,
  SEQUENCE_ERROR: 0x24,
  OUT_OF_RANGE: 0x31,
  SECURITY_DENIED: 0x33,
  INVALID_KEY: 0x35,
  EXCEEDED_ATTEMPTS: 0x36,
  DELAY_NOT_EXPIRED: 0x37,
  NOT_IN_SESSION: 0x7F,
};

const STORED_DTCS = [
  [0x03, 0x01, 0x00, 0x09],   // P0301 cylinder 1 misfire — confirmed
  [0xC1, 0x00, 0x00, 0x08],   // U0100 lost communication with ECM — confirmed
];
const DTC_STATUS_MASK = 0x09;

const ascii = (s) => Array.from(s, c => c.charCodeAt(0));
const u16 = (n) => [(n >> 8) & 0xFF, n & 0xFF];

export function createEcu({ send, live, vin, onReset = () => {}, now = () => performance.now(), defer = setTimeout }) {
  let session, unlocked, seed, attempts, lockoutUntil, lastRequest, dtcs;
  let rx;        // multi-frame request being reassembled
  let tx;        // multi-frame response waiting on flow control

  function reset() {
    session = 0x01;
    unlocked = false;
    seed = null;
    attempts = 0;
    lockoutUntil = 0;
    lastRequest = 0;
    dtcs = STORED_DTCS.map(d => d.slice());
    rx = null;
    tx = null;
  }
  reset();

  const DIDS = {
    0xF186: () => [session],
    0xF187: () => ascii('1K0907115AB'),
    0xF18C: () => ascii('SIM0000042'),
    0xF190: () => ascii(vin),
    0xF195: () => ascii('SW 1.4.2'),
    0xF40C: () => u16(Math.round(live().rpm * 4)),
    0xF40D: () => [Math.min(0xFF, Math.round(live().speedKmh))],
    0xF405: () => [Math.round(live().coolantC) + 40],
    // Only readable after SecurityAccess.
    0x1337: () => ascii('FLAG{s33d_k3y_xor}'),
  };
  const SECURED_DIDS = new Set([0x1337]);

  // ─── ISO-TP ─────────────────────────────────────────

  function sendFrame(bytes) {
    const data = bytes.slice();
    while (data.length < 8) data.push(PAD);
    send({ id: ECU_RESP_ID, data, dlc: 8, isExtended: false });
  }

  function respond(payload) {
    if (payload.length <= 7) {
      sendFrame([payload.length, ...payload]);
      return;
    }
    // Set before sending: the tester's flow control can arrive re-entrantly.
    tx = { payload, offset: 6, seq: 1 };
    sendFrame([0x10 | (payload.length >> 8), payload.length & 0xFF, ...payload.slice(0, 6)]);
  }

  function onFlowControl(data) {
    if (!tx) return;
    const flowStatus = data[0] & 0x0F;
    if (flowStatus === 1) return;                 // wait
    if (flowStatus !== 0) { tx = null; return; }  // overflow / invalid — abort
    const blockSize = data[1];
    const stmin = data[2] <= 0x7F ? data[2] : 1;
    const flow = tx;
    let sent = 0;
    const next = () => {
      if (tx !== flow) return;                    // superseded or ECU reset
      sendFrame([0x20 | flow.seq, ...flow.payload.slice(flow.offset, flow.offset + 7)]);
      flow.offset += 7;
      flow.seq = (flow.seq + 1) & 0x0F;
      sent++;
      if (flow.offset >= flow.payload.length) { tx = null; return; }
      if (blockSize && sent >= blockSize) return; // wait for the next FC
      defer(next, stmin);
    };
    next();
  }

  // Feed the ECU one frame transmitted onto the bus.
  function onFrame(id, data) {
    if (id !== ECU_REQ_ID && id !== ECU_FUNC_ID) return;
    if (!data.length) return;
    const functional = id === ECU_FUNC_ID;
    const pci = data[0] >> 4;

    if (pci === 0) {
      const len = data[0] & 0x0F;
      if (len === 0 || len > data.length - 1) return;
      dispatch(data.slice(1, 1 + len), functional);
    } else if (functional) {
      return;                                     // functional is single-frame only
    } else if (pci === 1 && data.length === 8) {
      rx = { expected: ((data[0] & 0x0F) << 8) | data[1], buffer: data.slice(2), seq: 1 };
      sendFrame([0x30, 0x00, 0x00]);
    } else if (pci === 2 && rx) {
      if ((data[0] & 0x0F) !== rx.seq) { rx = null; return; }
      rx.seq = (rx.seq + 1) & 0x0F;
      rx.buffer.push(...data.slice(1));
      if (rx.buffer.length >= rx.expected) {
        const request = rx.buffer.slice(0, rx.expected);
        rx = null;
        dispatch(request, false);
      }
    } else if (pci === 3) {
      onFlowControl(data);
    }
  }

  // ─── UDS ────────────────────────────────────────────

  function dispatch(request, functional) {
    const t = now();
    if (session !== 0x01 && t - lastRequest > S3_MS) {
      session = 0x01;
      unlocked = false;
      seed = null;
    }
    lastRequest = t;

    const response = handle(request, t);
    if (!response) return;
    // Functionally addressed requests don't get "not supported" noise back.
    if (functional && response[0] === 0x7F &&
        [NRC.SERVICE_NOT_SUPPORTED, NRC.SUBFUNCTION_NOT_SUPPORTED, NRC.OUT_OF_RANGE].includes(response[2])) {
      return;
    }
    tx = null;
    defer(() => respond(response), RESPONSE_DELAY_MS);
  }

  function handle(req, t) {
    const sid = req[0];
    const neg = (nrc) => [0x7F, sid, nrc];

    switch (sid) {
      case 0x10: {
        if (req.length !== 2) return neg(NRC.BAD_LENGTH);
        const type = req[1] & 0x7F;
        if (type !== 0x01 && type !== 0x03) return neg(NRC.SUBFUNCTION_NOT_SUPPORTED);
        session = type;
        unlocked = false;
        seed = null;
        // P2 = 50 ms, P2* = 5000 ms
        return req[1] & 0x80 ? null : [0x50, type, 0x00, 0x32, 0x01, 0xF4];
      }

      case 0x11: {
        if (req.length !== 2) return neg(NRC.BAD_LENGTH);
        if ((req[1] & 0x7F) !== 0x01) return neg(NRC.SUBFUNCTION_NOT_SUPPORTED);
        reset();
        onReset();
        return req[1] & 0x80 ? null : [0x51, 0x01];
      }

      case 0x14: {
        if (req.length !== 4) return neg(NRC.BAD_LENGTH);
        if (req[1] !== 0xFF || req[2] !== 0xFF || req[3] !== 0xFF) return neg(NRC.OUT_OF_RANGE);
        dtcs = [];
        return [0x54];
      }

      case 0x19: {
        if (req.length !== 3) return neg(NRC.BAD_LENGTH);
        const matching = dtcs.filter(d => d[3] & req[2]);
        if (req[1] === 0x01) return [0x59, 0x01, DTC_STATUS_MASK, 0x01, ...u16(matching.length)];
        if (req[1] === 0x02) return [0x59, 0x02, DTC_STATUS_MASK, ...matching.flat()];
        return neg(NRC.SUBFUNCTION_NOT_SUPPORTED);
      }

      case 0x22: {
        if (req.length < 3 || req.length % 2 !== 1) return neg(NRC.BAD_LENGTH);
        const out = [0x62];
        for (let i = 1; i < req.length; i += 2) {
          const did = (req[i] << 8) | req[i + 1];
          if (!DIDS[did]) return neg(NRC.OUT_OF_RANGE);
          if (SECURED_DIDS.has(did) && !unlocked) return neg(NRC.SECURITY_DENIED);
          out.push(req[i], req[i + 1], ...DIDS[did]());
        }
        return out;
      }

      case 0x27: {
        if (req.length < 2) return neg(NRC.BAD_LENGTH);
        if (session === 0x01) return neg(NRC.NOT_IN_SESSION);
        if (req[1] === 0x01) {
          if (req.length !== 2) return neg(NRC.BAD_LENGTH);
          if (t < lockoutUntil) return neg(NRC.DELAY_NOT_EXPIRED);
          if (unlocked) return [0x67, 0x01, 0, 0, 0, 0];
          seed = (Math.floor(Math.random() * 0xFFFFFFFF) + 1) >>> 0;
          return [0x67, 0x01, ...u16(seed >>> 16), ...u16(seed & 0xFFFF)];
        }
        if (req[1] === 0x02) {
          if (req.length !== 6) return neg(NRC.BAD_LENGTH);
          if (seed === null) return neg(NRC.SEQUENCE_ERROR);
          const key = ((req[2] << 24) | (req[3] << 16) | (req[4] << 8) | req[5]) >>> 0;
          const expected = (seed ^ KEY_MASK) >>> 0;
          seed = null;
          if (key === expected) {
            unlocked = true;
            attempts = 0;
            return [0x67, 0x02];
          }
          if (++attempts >= MAX_KEY_ATTEMPTS) {
            attempts = 0;
            lockoutUntil = t + LOCKOUT_MS;
            return neg(NRC.EXCEEDED_ATTEMPTS);
          }
          return neg(NRC.INVALID_KEY);
        }
        return neg(NRC.SUBFUNCTION_NOT_SUPPORTED);
      }

      case 0x3E: {
        if (req.length !== 2) return neg(NRC.BAD_LENGTH);
        if ((req[1] & 0x7F) !== 0x00) return neg(NRC.SUBFUNCTION_NOT_SUPPORTED);
        return req[1] & 0x80 ? null : [0x7E, 0x00];
      }

      // ─── OBD-II ───
      case 0x01: {
        if (req.length !== 2) return null;
        const v = live();
        switch (req[1]) {
          case 0x00: return [0x41, 0x00, 0x08, 0x18, 0x00, 0x00];   // PIDs 05, 0C, 0D
          case 0x05: return [0x41, 0x05, Math.round(v.coolantC) + 40];
          case 0x0C: return [0x41, 0x0C, ...u16(Math.round(v.rpm * 4))];
          case 0x0D: return [0x41, 0x0D, Math.min(0xFF, Math.round(v.speedKmh))];
          default: return null;                   // unsupported PID — stay silent
        }
      }

      case 0x09: {
        if (req.length !== 2) return null;
        if (req[1] === 0x00) return [0x49, 0x00, 0x40, 0x00, 0x00, 0x00];   // PID 02
        if (req[1] === 0x02) return [0x49, 0x02, 0x01, ...ascii(vin)];
        return null;
      }

      default:
        return neg(NRC.SERVICE_NOT_SUPPORTED);
    }
  }

  return { onFrame, reset };
}
