// ═══════════════════════════════════════════════════════
//  Simulator vehicle model — speed, gearbox, RPM, temp, fuel, odometer.
//  DOM-free; stepped by the simulator tick.
// ═══════════════════════════════════════════════════════

export const TOP_SPEED_KMH = 200;
export const RPM_IDLE = 800;
export const RPM_MAX = 8000;
export const TOP_GEAR = 6;

// km/h per 1000 RPM in each gear (index 0 unused).
const GEAR_KMH_PER_KRPM = [0, 8, 13, 18, 23, 28, 34];
// Full-throttle acceleration per gear, km/h per second.
const GEAR_ACCEL = [0, 28, 20, 14, 10, 7, 5];

const BRAKE_DECEL = 35;        // km/h per second
const COAST_DECEL_BASE = 3;    // rolling resistance + engine braking
const COAST_DECEL_DRAG = 0.03; // extra per km/h (air drag)

// Shift points. Under throttle the box holds gears to high RPM and kicks
// down early; off throttle it short-shifts. Each pair is far enough apart
// that a shift never lands on the opposite threshold.
const UPSHIFT_RPM   = { throttle: 6200, cruise: 3000 };
const DOWNSHIFT_RPM = { throttle: 2500, cruise: 1500 };

const RPM_LAG_S = 0.12;        // engine speed follows the driveline with a lag
const COOLANT_AMBIENT_C = 20;
const COOLANT_WARM_C = 90;
const COOLANT_WARMUP_S = 25;

export function resetVehicle(v) {
  v.speedKmh = 0;
  v.rpm = 0;
  v.gear = 1;
  v.coolantC = COOLANT_AMBIENT_C;
  v.fuelPct = 75;
  v.odoKm = 48213.4;
}

const drivelineRpm = (v) => v.speedKmh / GEAR_KMH_PER_KRPM[v.gear] * 1000;

// Advance the vehicle by dt seconds.
//   accel / brake — pedal state
//   speedPinned   — the bus is dictating speed; skip pedal physics
//   rpmPinned     — the bus is dictating RPM; leave v.rpm alone
export function stepVehicle(v, dt, { accel = false, brake = false, speedPinned = false, rpmPinned = false } = {}) {
  if (!speedPinned) {
    if (accel) {
      v.speedKmh = Math.min(TOP_SPEED_KMH, v.speedKmh + GEAR_ACCEL[v.gear] * dt);
    } else if (brake) {
      v.speedKmh = Math.max(0, v.speedKmh - BRAKE_DECEL * dt);
    } else if (v.speedKmh > 0) {
      const decel = COAST_DECEL_BASE + COAST_DECEL_DRAG * v.speedKmh;
      v.speedKmh = Math.max(0, v.speedKmh - decel * dt);
    }
  }

  const mode = accel ? 'throttle' : 'cruise';
  while (v.gear < TOP_GEAR && drivelineRpm(v) > UPSHIFT_RPM[mode]) v.gear++;
  while (v.gear > 1 && drivelineRpm(v) < DOWNSHIFT_RPM[mode]) v.gear--;

  if (!rpmPinned) {
    // Idle hunts a little; below idle speed the clutch slips.
    const idle = RPM_IDLE + (Math.random() - 0.5) * 50;
    const target = Math.min(RPM_MAX, Math.max(idle, drivelineRpm(v)));
    v.rpm += (target - v.rpm) * Math.min(1, dt / RPM_LAG_S);
  }

  v.coolantC += (COOLANT_WARM_C - v.coolantC) * Math.min(1, dt / COOLANT_WARMUP_S);
  v.fuelPct = Math.max(0, v.fuelPct - (accel ? 0.012 : 0.002) * dt);
  v.odoKm += v.speedKmh * dt / 3600;
}
