// End-to-end: the real TX queue, ISO-TP client and UDS client talking to the
// simulator, with just enough DOM stubbed for the cluster to render into.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const elements = new Map();
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.document = {
  addEventListener() {},
  getElementById(id) {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, {
        textContent: '',
        attrs: {},
        classes,
        classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
        setAttribute(k, v) { this.attrs[k] = v; },
        addEventListener() {},
      });
    }
    return elements.get(id);
  },
};

const { state } = await import('../js/state.js');
const { setSimHandler } = await import('../js/frames.js');
const { onAnyFrame } = await import('../js/reader.js');
const { udsRequest } = await import('../js/uds.js');
const sim = await import('../js/icsim.js');
const { api } = await import('../js/api.js');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const el = (id) => document.getElementById(id);
const needleAngle = (id) => parseFloat(el(id).attrs.transform.match(/rotate\(([-\d.]+)/)[1]);

// Capture bus traffic for `ms`, grouped by ID.
async function capture(ms) {
  const byId = new Map();
  const off = onAnyFrame(({ id, data }) => {
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push({ t: performance.now(), data: data.slice() });
  });
  await sleep(ms);
  off();
  return byId;
}

before(() => {
  setSimHandler(sim.onControlFrame);
  state.isConnected = true;
  sim.setBogusEnabled(false);
  sim.startSim();
});
after(() => {
  sim.stopSim();
  state.isConnected = false;   // stops any api.sendRepeat timers still running
});

test('ignition-on: bulb check lights every lamp and needles sweep', async () => {
  await sleep(600);   // mid-sweep
  for (const id of ['warnImmobilizer', 'warnAirbag', 'warnOilPressure', 'warnCheckEngine']) {
    assert.ok(el(id).classes.has('active'), id);
  }
  assert.ok(needleAngle('clusterSpeedNeedle') > 0, 'speed needle swept up');
  assert.ok(needleAngle('clusterRpmNeedle') > 0, 'rpm needle swept up');
  await sleep(1400);
  assert.ok(!el('warnOilPressure').classes.has('active'));
  assert.ok(!el('warnCheckEngine').classes.has('active'));
  assert.ok(el('warnImmobilizer').classes.has('active'), 'challenge lamps stay on');
  assert.ok(needleAngle('clusterSpeedNeedle') < -110, 'speed needle back at rest');
  assert.match(el('clusterLcd').textContent, /^48213\.\d km$/);
  assert.equal(el('clusterFuel').attrs['stroke-dasharray'], '75 100');
  assert.match(el('clusterTemp').attrs['stroke-dasharray'], /^\d+ 100$/);
});

test('each message has its own cycle time, counters and checksums', async () => {
  const traffic = await capture(2100);
  const count = (id) => (traffic.get(id) || []).length;
  // 2.1 s window; generous bounds for timer jitter.
  assert.ok(count(0x244) > 70 && count(0x244) < 115, `0x244 x${count(0x244)}`);
  assert.ok(count(0x0AA) > 70, `0x0AA x${count(0x0AA)}`);
  assert.ok(count(0x4A0) > 70, `0x4A0 x${count(0x4A0)}`);
  assert.ok(count(0x19B) > 14 && count(0x19B) < 24, `0x19B x${count(0x19B)}`);
  assert.ok(count(0x65D) >= 5 && count(0x65D) <= 8, `0x65D x${count(0x65D)}`);
  assert.ok(count(0x3B4) >= 3 && count(0x3B4) <= 5, `0x3B4 x${count(0x3B4)}`);
  assert.ok(count(0x5C8) >= 1 && count(0x5C8) <= 3, `0x5C8 x${count(0x5C8)}`);
  assert.equal(count(0x188), 0, 'turn-signal ID silent at rest');
  assert.equal(traffic.get(0x5C8)[0].data.length, 3, 'odometer DLC 3');

  const speed = traffic.get(0x244);
  for (let i = 0; i < speed.length; i++) {
    const d = speed[i].data;
    assert.equal(d[7], d.slice(0, 7).reduce((a, b) => a ^ b, 0), 'checksum');
    if (i) assert.equal(d[6], (speed[i - 1].data[6] + 1) & 0x0F, 'alive counter');
  }
  const vin = [0, 1, 2].map(i => traffic.get(0x65D).find(f => f.data[0] === i).data.slice(1));
  assert.equal(String.fromCharCode(...vin.flat()).replace(/\0/g, ''), 'WVWZZZ1KZAW123456');
});

test('accelerating changes gear and shows on the bus and the cluster', async () => {
  sim.pressAccelerator(true);
  const traffic = await capture(3000);
  sim.pressAccelerator(false);
  const gears = new Set(traffic.get(0x1D0).map(f => f.data[0]));
  assert.ok(gears.has(1) && gears.has(2), `gears seen: ${[...gears]}`);
  assert.equal(traffic.get(0x1D0).at(-1).data[1], 0xFF, 'throttle byte');
  const last = traffic.get(0x244).at(-1).data;
  const kmh = ((last[3] << 8) | last[4]) / 100;
  assert.ok(kmh > 50 && kmh < 110, `speed ${kmh}`);
  const rpms = traffic.get(0x0AA).map(f => f.data[4] * 32);
  assert.ok(Math.max(...rpms) > 5500, 'revs out before shifting');
  assert.ok(rpms.some((r, i) => i && r < rpms[i - 1] - 500 / 4), 'rpm falls on upshift');
  const wheels = traffic.get(0x4A0).at(-1).data;
  assert.notDeepEqual(wheels.slice(0, 2), wheels.slice(2, 4), 'wheels differ slightly');
  assert.ok(Number(el('clusterGear').textContent) >= 2);
  assert.ok(Number(el('clusterSpeed').textContent) > 50);
  sim.pressBrake(true);
  await sleep(3500);
  sim.pressBrake(false);
  assert.equal(Number(el('clusterSpeed').textContent), 0);
});

test('held turn signal blinks on the bus and on the cluster', async () => {
  sim.toggleSignalLeft();
  const lamp = [];
  const poll = setInterval(() => lamp.push(el('clusterSignalLeft').classes.has('active')), 20);
  const traffic = await capture(2000);
  clearInterval(poll);
  const bits = traffic.get(0x188).map(f => f.data[0] & 1);
  const edges = bits.filter((b, i) => i && b !== bits[i - 1]).length;
  assert.ok(edges >= 3 && edges <= 6, `bus edges ${edges}`);
  assert.ok(traffic.get(0x188).every(f => (f.data[0] & 2) === 0), 'right stays off');
  assert.ok(lamp.includes(true) && lamp.includes(false), 'lamp blinks');
  sim.toggleSignalLeft();
  await sleep(500);
  assert.equal((await capture(400)).get(0x188), undefined, 'silent again once cancelled');
});

test('cluster buttons act inside the car: frames show up as RX, never TX', async () => {
  const txBefore = state.txCount;
  const logBefore = state.logEntries.length;
  sim.toggleSignalRight();
  sim.toggleDoor('FL');
  const traffic = await capture(400);
  sim.toggleSignalRight();
  sim.toggleDoor('FL');
  await sleep(100);
  assert.equal(state.txCount, txBefore);
  assert.deepEqual(state.logEntries.slice(logBefore).filter(e => e.dir === 'tx'), []);
  assert.ok(traffic.get(0x188).some(f => f.data[0] === 0x02), 'signal broadcast as RX');
  assert.ok(traffic.get(0x19B).some(f => f.data[2] === 0x01), 'door broadcast as RX');
  await sleep(500);
});

test('workshop frames still drive the cluster', async () => {
  const speed = api.sendRepeat({ id: 0x244, data: [0, 0, 0, 0x27, 0x10, 0, 0, 0], intervalMs: 50 });
  const abs = api.sendRepeat({ id: 0x4A0, data: [0x27, 0x10, 0x27, 0x10, 0x27, 0x10, 0x27, 0x10], intervalMs: 50 });
  const doors = api.sendRepeat({ id: 0x19B, data: [0, 0, 0x0F], intervalMs: 50 });
  const immo = api.sendRepeat({ id: 0x3D0, data: [0, 0, 0, 0, 0, 0, 0, 0], intervalMs: 50 });
  const blink = api.sendRepeat({ id: 0x188, data: [0x02], intervalMs: 50 });
  await sleep(800);
  assert.equal(Number(el('clusterSpeed').textContent), 100);
  assert.ok(el('clusterDoorRR').classes.has('open'));
  assert.ok(!el('warnImmobilizer').classes.has('active'));
  assert.ok(el('clusterSignalRight').classes.has('active'));
  assert.ok(Number(el('clusterGear').textContent) >= 3, 'gearbox follows spoofed speed');
  for (const r of [speed, abs, doors, immo, blink]) r.stop();
  api.send({ id: 0x412, data: [0x42] });
  await sleep(50);
  assert.equal(el('clusterLcd').textContent, 'ECO MODE');
  await sleep(700);
  assert.ok(!el('clusterDoorRR').classes.has('open'));
  assert.ok(el('warnImmobilizer').classes.has('active'));
  assert.ok(!el('clusterSignalRight').classes.has('active'));
});

test('UDS over the real ISO-TP client: VIN, security access, reset', async () => {
  const vin = await udsRequest(0x7E0, 0x7E8, [0x22, 0xF1, 0x90]);
  assert.equal(vin.ok, true);
  assert.equal(String.fromCharCode(...vin.data.slice(2)), 'WVWZZZ1KZAW123456');

  const denied = await udsRequest(0x7E0, 0x7E8, [0x22, 0x13, 0x37]);
  assert.deepEqual([denied.ok, denied.name], [false, 'securityAccessDenied']);

  assert.equal((await udsRequest(0x7E0, 0x7E8, [0x10, 0x03])).ok, true);
  const seed = (await udsRequest(0x7E0, 0x7E8, [0x27, 0x01])).data.slice(1);
  const mask = [0x5E, 0xC0, 0xDE, 0x42];
  const unlock = await udsRequest(0x7E0, 0x7E8, [0x27, 0x02, ...seed.map((b, i) => b ^ mask[i])]);
  assert.equal(unlock.ok, true);
  const flag = await udsRequest(0x7E0, 0x7E8, [0x22, 0x13, 0x37]);
  assert.match(String.fromCharCode(...flag.data.slice(2)), /^FLAG\{/);

  const rpm = await udsRequest(0x7E0, 0x7E8, [0x22, 0xF4, 0x0C]);
  const value = ((rpm.data[2] << 8) | rpm.data[3]) / 4;
  const shown = Number(el('clusterRpm').textContent);
  assert.ok(Math.abs(value - shown) < 300, `ECU rpm ${value} vs cluster ${shown}`);

  assert.equal((await udsRequest(0x7E0, 0x7E8, [0x11, 0x01])).ok, true);
  await sleep(100);
  assert.ok(el('warnOilPressure').classes.has('active'), 'reset re-runs the bulb check');
});

test('bogus traffic has mixed DLCs and avoids simulator IDs', async () => {
  sim.setBogusEnabled(true);
  const traffic = await capture(1200);
  sim.setBogusEnabled(false);
  const known = new Set([0x244, 0x0AA, 0x4A0, 0x1D0, 0x19B, 0x188, 0x65D, 0x3B4, 0x5C8, 0x7E8]);
  const bogus = [...traffic.keys()].filter(id => !known.has(id));
  assert.equal(bogus.length, 24);
  for (const id of bogus) assert.ok(id >= 0x100 && id < 0x700);
});
