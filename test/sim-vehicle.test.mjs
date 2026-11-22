import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resetVehicle, stepVehicle, TOP_SPEED_KMH, TOP_GEAR, RPM_MAX } from '../js/sim-vehicle.js';

const DT = 0.01;
function run(v, seconds, inputs, each = () => {}) {
  for (let t = 0; t < seconds; t += DT) {
    stepVehicle(v, DT, inputs);
    each(v);
  }
}
function fresh() {
  const v = {};
  resetVehicle(v);
  return v;
}

test('idles around 800 rpm at standstill', () => {
  const v = fresh();
  run(v, 2, {});
  assert.equal(v.speedKmh, 0);
  assert.equal(v.gear, 1);
  assert.ok(v.rpm > 700 && v.rpm < 900, `rpm ${v.rpm}`);
});

test('full throttle shifts up through every gear and RPM drops at each shift', () => {
  const v = fresh();
  const gears = [];
  let prevRpm = 0, prevGear = 1, drops = 0, maxRpm = 0;
  run(v, 40, { accel: true }, () => {
    if (v.gear !== prevGear) { gears.push(v.gear); prevGear = v.gear; }
    if (v.rpm < prevRpm - 1) drops++;
    prevRpm = v.rpm;
    maxRpm = Math.max(maxRpm, v.rpm);
  });
  assert.deepEqual(gears, [2, 3, 4, 5, 6]);
  assert.ok(drops > 0, 'RPM should fall after an upshift');
  assert.ok(maxRpm <= RPM_MAX);
  assert.equal(v.speedKmh, TOP_SPEED_KMH);
  assert.equal(v.gear, TOP_GEAR);
});

test('acceleration tails off in higher gears', () => {
  const v = fresh();
  run(v, 1, { accel: true });
  const firstSecond = v.speedKmh;
  run(v, 9, { accel: true });
  const before = v.speedKmh;
  run(v, 1, { accel: true });
  assert.ok(v.speedKmh - before < firstSecond, 'slower gain at speed than off the line');
});

test('coasts down and brakes harder than it coasts', () => {
  const coasting = fresh(), braking = fresh();
  coasting.speedKmh = braking.speedKmh = 100;
  run(coasting, 1, {});
  run(braking, 1, { brake: true });
  assert.ok(coasting.speedKmh < 100);
  assert.ok(braking.speedKmh < coasting.speedKmh);
  run(braking, 10, { brake: true });
  assert.equal(braking.speedKmh, 0);
  assert.equal(braking.gear, 1);
});

test('gear never hunts between two gears at steady speed', () => {
  for (const accel of [false, true]) {
    for (let kmh = 0; kmh <= 200; kmh += 1) {
      const v = fresh();
      v.speedKmh = kmh;
      run(v, 0.1, { accel, speedPinned: true });
      const settled = v.gear;
      run(v, 0.5, { accel, speedPinned: true }, () => assert.equal(v.gear, settled, `${kmh} km/h`));
    }
  }
});

test('pinned speed and rpm are left alone', () => {
  const v = fresh();
  v.speedKmh = 120;
  v.rpm = 4321;
  run(v, 1, { accel: true, speedPinned: true, rpmPinned: true });
  assert.equal(v.speedKmh, 120);
  assert.equal(v.rpm, 4321);
  assert.ok(v.gear > 1, 'gear still follows the pinned speed');
});

test('engine warms up and the odometer counts distance', () => {
  const v = fresh();
  const odo = v.odoKm;
  v.speedKmh = 100;
  run(v, 36, { speedPinned: true });
  assert.ok(Math.abs(v.odoKm - odo - 1) < 0.01, 'one km in 36 s at 100 km/h');
  assert.ok(v.coolantC > 60 && v.coolantC <= 90);
});
