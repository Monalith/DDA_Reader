// The rider lag layer: what the quasi-steady-state envelope cannot say.
//
// The solver gives the speed a perfect actuator would hold. Real telemetry has
// a throttle trace that lags the apex, a brake release that ramps, a traction
// control that cuts torque, and a gearbox. Those are what the chart stack is
// for, so they are modelled here as first-order lags on top of the envelope
// rather than being solved for.
import type { Envelope, Line, SimParams } from './types';
import { clampParams } from './presets';

export interface RiderChannels {
  /** Throttle position, %. */
  tps: Float32Array;
  /** Brake application, %. Separate from tps on purpose — see the rate limits. */
  brake: Float32Array;
  /** Selected gear, 1..n. */
  gear: Float32Array;
  rpm: Float32Array;
  /** Traction-control intervention, % of torque cut. */
  dtc: Float32Array;
}

/**
 * How much brake the rider may still be holding at full throttle, as a
 * multiplier on the brake channel. Above 1 the two are mutually exclusive with
 * margin; at 1 they simply cannot sum past 100 %. Trail braking is a small
 * overlap, not a large one.
 */
const OVERLAP = 1.15;

/** Rolling radius of a 190/55-17 rear, metres. */
const WHEEL_RADIUS_M = 0.31;
const RPM_LIMIT = 14000;
const RPM_MIN = 3500;

export function riderChannels(line: Line, env: Envelope, params: SimParams): RiderChannels {
  const p = clampParams(params);
  const n = line.points.length;
  const tps = new Float32Array(n);
  const brake = new Float32Array(n);
  const gear = new Float32Array(n);
  const rpm = new Float32Array(n);
  const dtc = new Float32Array(n);
  if (!n) return { tps, brake, gear, rpm, dtc };

  // ---- raw demand from the envelope ------------------------------------
  // longG > 0 means driving, < 0 braking. These are the two demands a rider is
  // answering; they are deliberately kept as separate channels, because the
  // interesting part of a lap is what happens BETWEEN them.
  const thrDemand = new Float32Array(n);
  const brkDemand = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const g = env.longG[i];
    thrDemand[i] = g > 0 ? Math.min(100, (g / 0.9) * 100) : 0;
    brkDemand[i] = g < 0 ? Math.min(100, (-g / p.rider.brakingG) * 100) : 0;
  }

  // ---- rate limits: the reason a lap has transitions at all -------------
  //
  // A rider cannot step from 100 % throttle to 100 % brake. Hands and levers
  // move at a finite speed, load transfers onto the front tyre over a real
  // interval, and asking for full brake before that load has arrived is how you
  // tuck the front. So every channel is rate-limited in %/s, asymmetrically,
  // because applying and releasing are not the same action:
  //
  //   - the brake comes ON fast but not instantly (initial bite, then squeeze)
  //   - the brake comes OFF at a rate the `trailBrakeProfile` slider sets:
  //     abrupt at 0, a long progressive bleed at 1. That release is the whole
  //     craft of trail braking — it is what keeps load on the front while the
  //     bike is turning.
  //   - the throttle comes ON slowly (and is additionally delayed by
  //     `throttleDelayS`), because cracking it open at lean is the other way to
  //     crash
  //   - the throttle comes OFF fast; shutting it is a reflex
  //
  // These are estimates of how fast a rider actually moves, not measurements.
  // A later task cross-checks against a real lap and will retune them.
  const BRAKE_ON_PCT_S = 700; // ~0.14 s to full pressure
  const BRAKE_OFF_PCT_S = 1400 - 1250 * p.rider.trailBrakeProfile; // 1400 -> 150
  const THROTTLE_ON_PCT_S = 350; // ~0.3 s to full
  const THROTTLE_OFF_PCT_S = 1200;

  const rateLimit = (prev: number, target: number, dt: number, upPctS: number, downPctS: number): number => {
    const maxStep = (target > prev ? upPctS : downPctS) * dt;
    const delta = target - prev;
    return Math.abs(delta) <= maxStep ? target : prev + Math.sign(delta) * maxStep;
  };

  // ---- throttle lag, then both channels through their rate limits -------
  // The lag is in seconds, so it is applied against the envelope's own time
  // vector: the same delay costs more samples where the bike is slow.
  const tau = Math.max(1e-3, p.rider.throttleDelayS);
  let lagged = thrDemand[0];
  let thr = thrDemand[0];
  let brk = brkDemand[0];
  for (let i = 0; i < n; i++) {
    const dt = i === 0 ? 0.01 : Math.max(1e-3, env.tS[i] - env.tS[i - 1]);
    const alpha = 1 - Math.exp(-dt / tau);
    lagged = thrDemand[i] < lagged ? thrDemand[i] : lagged + alpha * (thrDemand[i] - lagged);

    brk = rateLimit(brk, brkDemand[i], dt, BRAKE_ON_PCT_S, BRAKE_OFF_PCT_S);
    thr = rateLimit(thr, lagged, dt, THROTTLE_ON_PCT_S, THROTTLE_OFF_PCT_S);

    // Mutual exclusion. A rider can hold a trickle of throttle against the
    // brakes, but not drive and stop at once: the throttle available is what is
    // left after the brake has taken its share, with a little overlap allowed.
    const allowance = Math.max(0, 100 - OVERLAP * brk);
    thr = Math.min(thr, allowance);

    tps[i] = Math.min(100, Math.max(0, thr));
    brake[i] = Math.min(100, Math.max(0, brk));
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
    const rev = (env.v[i] * 60 * ratios[g - 1] * p.machine.finalDrive) / (2 * Math.PI * WHEEL_RADIUS_M);
    rpm[i] = Math.min(RPM_LIMIT, Math.max(RPM_MIN, rev));
  }

  // ---- traction control -------------------------------------------------
  // TC cuts when the drive demand plus the lateral demand would exceed what the
  // threshold allows. A low threshold means an intrusive system.
  const allowed = 0.55 + 0.45 * p.rider.tcThreshold;
  const aLatMax = Math.max(
    0.1,
    Math.min(p.tyre.mu * p.tyre.gripScale, Math.tan((p.tyre.maxLeanDeg * p.rider.leanUsage * Math.PI) / 180)),
  );
  for (let i = 0; i < n; i++) {
    if (env.longG[i] <= 0) continue; // braking or coasting: nothing to cut
    const latUse = Math.min(1, Math.abs(env.latG[i]) / aLatMax);
    const longUse = Math.min(1, env.longG[i] / (p.tyre.mu * p.tyre.gripScale));
    const total = Math.hypot(latUse, longUse);
    if (total > allowed) dtc[i] = Math.min(100, ((total - allowed) / Math.max(0.05, 1 - allowed)) * 100);
  }

  return { tps, brake, gear, rpm, dtc };
}
