// The rider lag layer: what the quasi-steady-state envelope cannot say.
//
// The solver gives the speed a perfect actuator would hold. Real telemetry has
// a throttle trace that lags the apex, a brake release that ramps, a traction
// control that cuts torque, and a gearbox. Those are what the chart stack is
// for, so they are modelled here as first-order lags on top of the envelope
// rather than being solved for.
import { clampParams } from './presets';
import type { Envelope, Line, SimParams } from './types';

export interface RiderChannels {
  /** Throttle position, %. */
  tps: Float32Array;
  /** Selected gear, 1..n. */
  gear: Float32Array;
  rpm: Float32Array;
  /** Traction-control intervention, % of torque cut. */
  dtc: Float32Array;
}

/** Rolling radius of a 190/55-17 rear, metres. */
const WHEEL_RADIUS_M = 0.31;
const RPM_LIMIT = 14000;
const RPM_MIN = 3500;

export function riderChannels(line: Line, env: Envelope, params: SimParams): RiderChannels {
  const p = clampParams(params);
  const n = line.points.length;
  const tps = new Float32Array(n);
  const gear = new Float32Array(n);
  const rpm = new Float32Array(n);
  const dtc = new Float32Array(n);
  if (!n) return { tps, gear, rpm, dtc };

  // ---- raw demand from the envelope ------------------------------------
  // longG > 0 means driving, < 0 braking. Map drive demand to throttle and
  // braking to a closed throttle; coasting sits in between.
  const demand = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const g = env.longG[i];
    demand[i] = g > 0 ? Math.min(100, (g / 0.9) * 100) : Math.max(0, 12 + g * 30);
  }

  // ---- first-order lag on the throttle ---------------------------------
  // The delay is in seconds, so it is applied against the envelope's own time
  // vector: the same delay costs more samples where the bike is slow.
  const tau = Math.max(1e-3, p.rider.throttleDelayS);
  let y = demand[0];
  for (let i = 0; i < n; i++) {
    const dt = i === 0 ? 0.01 : Math.max(1e-3, env.tS[i] - env.tS[i - 1]);
    const alpha = 1 - Math.exp(-dt / tau);
    // opening the throttle lags; shutting it is immediate (riders close fast)
    y = demand[i] < y ? demand[i] : y + alpha * (demand[i] - y);
    tps[i] = Math.min(100, Math.max(0, y));
  }

  // ---- gear and rpm -----------------------------------------------------
  const ratios = p.machine.gearRatios;
  const top = ratios.length;
  // speed at the rev limit in each gear
  const vAtLimit = ratios.map(
    (r) => (RPM_LIMIT * 2 * Math.PI * WHEEL_RADIUS_M) / (60 * r * p.machine.finalDrive),
  );
  for (let i = 0; i < n; i++) {
    let g = 1;
    while (g < top && env.v[i] > vAtLimit[g - 1]) g++;
    gear[i] = g;
    const rev =
      (env.v[i] * 60 * ratios[g - 1] * p.machine.finalDrive) / (2 * Math.PI * WHEEL_RADIUS_M);
    rpm[i] = Math.min(RPM_LIMIT, Math.max(RPM_MIN, rev));
  }

  // ---- traction control -------------------------------------------------
  // TC cuts when the drive demand plus the lateral demand would exceed what the
  // threshold allows. A low threshold means an intrusive system.
  const allowed = 0.55 + 0.45 * p.rider.tcThreshold;
  const aLatMax = Math.max(
    0.1,
    Math.min(
      p.tyre.mu * p.tyre.gripScale,
      Math.tan((p.tyre.maxLeanDeg * p.rider.leanUsage * Math.PI) / 180),
    ),
  );
  for (let i = 0; i < n; i++) {
    if (env.longG[i] <= 0) continue; // braking or coasting: nothing to cut
    const latUse = Math.min(1, Math.abs(env.latG[i]) / aLatMax);
    const longUse = Math.min(1, env.longG[i] / (p.tyre.mu * p.tyre.gripScale));
    const total = Math.hypot(latUse, longUse);
    if (total > allowed) {
      dtc[i] = Math.min(100, ((total - allowed) / Math.max(0.05, 1 - allowed)) * 100);
    }
  }

  return { tps, gear, rpm, dtc };
}
