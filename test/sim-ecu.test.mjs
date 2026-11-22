import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEcu, ECU_REQ_ID, ECU_RESP_ID, ECU_FUNC_ID } from '../js/sim-ecu.js';

const VIN = 'WVWZZZ1KZAW123456';
const KEY_MASK = 0x5EC0DE42;
const ascii = (bytes) => String.fromCharCode(...bytes);

// Minimal tester: drives the ECU frame-by-frame with a manual clock and
// reassembles ISO-TP responses.
function harness() {
  const h = { clock: 1000, frames: [], resets: 0, fc: [0x30, 0x00, 0x00] };
  const timers = [];
  const ecu = createEcu({
    send: (f) => h.frames.push(f),
    live: () => ({ rpm: 3000, speedKmh: 88, coolantC: 90 }),
    vin: VIN,
    onReset: () => h.resets++,
    now: () => h.clock,
    defer: (fn) => timers.push(fn),
  });
  const flush = () => { while (timers.length) timers.shift()(); };
  const pad = (b) => [...b, ...Array(8 - b.length).fill(0xCC)];

  // Send a single-frame request; return the reassembled response (or null).
  h.request = (req, id = ECU_REQ_ID) => {
    h.frames = [];
    ecu.onFrame(id, pad([req.length, ...req]));
    flush();
    if (!h.frames.length) return null;
    const first = h.frames[0];
    assert.equal(first.id, ECU_RESP_ID);
    assert.equal(first.data.length, 8);
    if (first.data[0] >> 4 === 0) return first.data.slice(1, 1 + (first.data[0] & 0x0F));
    assert.equal(first.data[0] >> 4, 1, 'first frame');
    const len = ((first.data[0] & 0x0F) << 8) | first.data[1];
    assert.equal(h.frames.length, 1, 'ECU must wait for flow control');
    ecu.onFrame(ECU_REQ_ID, pad(h.fc));
    flush();
    const out = first.data.slice(2);
    h.frames.slice(1).forEach((f, i) => {
      assert.equal(f.data[0], 0x20 | ((i + 1) & 0x0F), 'consecutive frame sequence');
      out.push(...f.data.slice(1));
    });
    return out.slice(0, len);
  };
  h.ecu = ecu;
  h.flush = flush;
  h.pad = pad;
  h.unlock = () => {
    assert.deepEqual(h.request([0x10, 0x03]).slice(0, 2), [0x50, 0x03]);
    const seed = h.request([0x27, 0x01]);
    const s = ((seed[2] << 24) | (seed[3] << 16) | (seed[4] << 8) | seed[5]) >>> 0;
    const k = (s ^ KEY_MASK) >>> 0;
    return h.request([0x27, 0x02, k >>> 24, (k >> 16) & 0xFF, (k >> 8) & 0xFF, k & 0xFF]);
  };
  return h;
}

test('tester present, with and without suppressed response', () => {
  const h = harness();
  assert.deepEqual(h.request([0x3E, 0x00]), [0x7E, 0x00]);
  assert.equal(h.request([0x3E, 0x80]), null);
});

test('reads the VIN as a multi-frame response after flow control', () => {
  const h = harness();
  const resp = h.request([0x22, 0xF1, 0x90]);
  assert.deepEqual(resp.slice(0, 3), [0x62, 0xF1, 0x90]);
  assert.equal(ascii(resp.slice(3)), VIN);
  assert.equal(h.frames.length, 3);
});

test('honours flow-control block size', () => {
  const h = harness();
  h.frames = [];
  h.ecu.onFrame(ECU_REQ_ID, h.pad([0x03, 0x22, 0xF1, 0x90]));
  h.flush();
  h.ecu.onFrame(ECU_REQ_ID, h.pad([0x30, 0x01, 0x00]));
  h.flush();
  assert.equal(h.frames.length, 2, 'one CF per FC with BS=1');
  h.ecu.onFrame(ECU_REQ_ID, h.pad([0x30, 0x01, 0x00]));
  h.flush();
  assert.equal(h.frames.length, 3);
});

test('live data DIDs and multiple DIDs in one request', () => {
  const h = harness();
  assert.deepEqual(h.request([0x22, 0xF4, 0x0C, 0xF4, 0x0D]),
    [0x62, 0xF4, 0x0C, 0x2E, 0xE0, 0xF4, 0x0D, 88]);
});

test('accepts a multi-frame request', () => {
  const h = harness();
  h.frames = [];
  // 22 + four DIDs = 9 bytes
  h.ecu.onFrame(ECU_REQ_ID, [0x10, 0x09, 0x22, 0xF1, 0x86, 0xF4, 0x0D, 0xF4]);
  assert.deepEqual(h.frames[0].data.slice(0, 3), [0x30, 0x00, 0x00]);
  h.frames = [];
  h.ecu.onFrame(ECU_REQ_ID, [0x21, 0x05, 0xF4, 0x0C, 0xCC, 0xCC, 0xCC, 0xCC]);
  h.flush();
  h.ecu.onFrame(ECU_REQ_ID, h.pad([0x30, 0x00, 0x00]));
  h.flush();
  const first = h.frames[0].data;
  assert.equal(first[0] >> 4, 1);
  assert.deepEqual(first.slice(2, 6), [0x62, 0xF1, 0x86, 0x01]);
});

test('negative responses', () => {
  const h = harness();
  assert.deepEqual(h.request([0x99]), [0x7F, 0x99, 0x11]);
  assert.deepEqual(h.request([0x22, 0xAB, 0xCD]), [0x7F, 0x22, 0x31]);
  assert.deepEqual(h.request([0x22, 0xF1]), [0x7F, 0x22, 0x13]);
  assert.deepEqual(h.request([0x10, 0x55]), [0x7F, 0x10, 0x12]);
  assert.deepEqual(h.request([0x27, 0x01]), [0x7F, 0x27, 0x7F], 'security needs extended session');
  assert.deepEqual(h.request([0x22, 0x13, 0x37]), [0x7F, 0x22, 0x33]);
});

test('security access unlocks the protected DID', () => {
  const h = harness();
  assert.deepEqual(h.unlock(), [0x67, 0x02]);
  const resp = h.request([0x22, 0x13, 0x37]);
  assert.deepEqual(resp.slice(0, 3), [0x62, 0x13, 0x37]);
  assert.match(ascii(resp.slice(3)), /^FLAG\{/);
  assert.deepEqual(h.request([0x27, 0x01]), [0x67, 0x01, 0, 0, 0, 0], 'zero seed when unlocked');
});

test('wrong keys lock the ECU out for a while', () => {
  const h = harness();
  h.request([0x10, 0x03]);
  assert.deepEqual(h.request([0x27, 0x02, 0, 0, 0, 0]), [0x7F, 0x27, 0x24], 'key without seed');
  const bad = () => {
    const seed = h.request([0x27, 0x01]);
    return h.request([0x27, 0x02, seed[2], seed[3], seed[4], seed[5]]);
  };
  assert.deepEqual(bad(), [0x7F, 0x27, 0x35]);
  assert.deepEqual(bad(), [0x7F, 0x27, 0x35]);
  assert.deepEqual(bad(), [0x7F, 0x27, 0x36]);
  assert.deepEqual(h.request([0x27, 0x01]), [0x7F, 0x27, 0x37]);
  h.clock += 4000; h.request([0x3E, 0x00]);
  h.clock += 4000; h.request([0x3E, 0x00]);
  h.clock += 3000;
  assert.equal(h.request([0x27, 0x01])[0], 0x67, 'seed available again after the delay');
});

test('session times out without tester present', () => {
  const h = harness();
  h.unlock();
  h.clock += 4000;
  h.request([0x3E, 0x00]);
  h.clock += 4000;
  assert.deepEqual(h.request([0x22, 0xF1, 0x86]), [0x62, 0xF1, 0x86, 0x03], 'kept alive');
  h.clock += 6000;
  assert.deepEqual(h.request([0x22, 0xF1, 0x86]), [0x62, 0xF1, 0x86, 0x01], 'back to default');
  assert.deepEqual(h.request([0x22, 0x13, 0x37]), [0x7F, 0x22, 0x33], 're-locked');
});

test('ECU reset drops session and notifies the simulator', () => {
  const h = harness();
  h.unlock();
  assert.deepEqual(h.request([0x11, 0x01]), [0x51, 0x01]);
  assert.equal(h.resets, 1);
  assert.deepEqual(h.request([0x22, 0xF1, 0x86]), [0x62, 0xF1, 0x86, 0x01]);
});

test('reads and clears DTCs', () => {
  const h = harness();
  assert.deepEqual(h.request([0x19, 0x01, 0xFF]), [0x59, 0x01, 0x09, 0x01, 0x00, 0x02]);
  assert.deepEqual(h.request([0x19, 0x02, 0xFF]),
    [0x59, 0x02, 0x09, 0x03, 0x01, 0x00, 0x09, 0xC1, 0x00, 0x00, 0x08]);
  assert.deepEqual(h.request([0x19, 0x02, 0x01]), [0x59, 0x02, 0x09, 0x03, 0x01, 0x00, 0x09]);
  assert.deepEqual(h.request([0x14, 0xFF, 0xFF, 0xFF]), [0x54]);
  assert.deepEqual(h.request([0x19, 0x02, 0xFF]), [0x59, 0x02, 0x09]);
});

test('functional addressing: OBD-II PIDs answer, unsupported stays silent', () => {
  const h = harness();
  assert.deepEqual(h.request([0x01, 0x0C], ECU_FUNC_ID), [0x41, 0x0C, 0x2E, 0xE0]);
  assert.deepEqual(h.request([0x01, 0x0D], ECU_FUNC_ID), [0x41, 0x0D, 88]);
  assert.deepEqual(h.request([0x01, 0x05], ECU_FUNC_ID), [0x41, 0x05, 130]);
  assert.equal(ascii(h.request([0x09, 0x02], ECU_FUNC_ID).slice(3)), VIN);
  assert.equal(h.request([0x99], ECU_FUNC_ID), null);
  assert.equal(h.request([0x01, 0x42], ECU_FUNC_ID), null);
});

test('ignores frames for other IDs', () => {
  const h = harness();
  assert.equal(h.request([0x3E, 0x00], 0x244), null);
});
