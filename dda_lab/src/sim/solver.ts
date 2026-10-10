// Quasi-steady-state lap solver: three O(n) passes over the line.
//
//   (1) lateral limit   v_lat = sqrt(a_lat_max * r)
//   (2) backward pass   braking into every speed minimum
//   (3) forward pass    acceleration out of it
//   v(s) = min of the three;  t = integral ds / v
//
// Combined grip is the friction ellipse: longitudinal capacity falls as lateral
// use rises, which is what makes trail braking and progressive throttle come out
// of the model rather than being scripted.
import { clampParams } from './presets';
import type { Envelope, Line, SimParams } from './types';

export const G = 9.81;

/** Air density at sea level, kg/m^3. */
const RHO = 1.225;
/** Rolling and driveline losses as an equivalent deceleration, m/s^2. */
const ROLLING = 0.15;
/** Nothing below this is a real speed; keeps every division finite. */
const V_MIN = 2;

/** Drag-limited top speed: where engine power equals drag plus rolling losses. */
export function topSpeedMs(params: SimParams): number {
  const p = clampParams(params);
  const power = p.machine.powerKw * 1000;
  // solve  power = 0.5*rho*cdA*v^3 + m*ROLLING*v  by bisection
  let lo = V_MIN;
  let hi = 200;
  for (let i = 0; i < 60; i++) {
    const v = (lo + hi) / 2;
    const need = 0.5 * RHO * p.machine.cdA * v ** 3 + p.machine.massKg * ROLLING * v;
    if (need > power) hi = v;
    else lo = v;
  }
  return lo;
}

export function solve(line: Line, params: SimParams): Envelope {
  const p = clampParams(params);
  const n = line.points.length;
  const v = new Float32Array(n);
  const longG = new Float32Array(n);
  const latG = new Float32Array(n);
  const leanDeg = new Float32Array(n);
  const gripUse = new Float32Array(n);
  const tS = new Float64Array(n);
  if (n < 2) return { v, longG, latG, leanDeg, gripUse, tS, lapTimeS: 0 };

  const mu = p.tyre.mu * p.tyre.gripScale;
  const leanLimitDeg = p.tyre.maxLeanDeg * p.rider.leanUsage;
  // the lean angle and the tyre both cap lateral acceleration; the lower wins
  const aLatMax = Math.max(0.1, Math.min(mu, Math.tan((leanLimitDeg * Math.PI) / 180)) * G);
  const aBrakeMax = Math.max(0.1, p.rider.brakingG * G);
  const vTop = topSpeedMs(p);
  // wheelie limit: beyond this the front lifts and no more torque gets through
  const aWheelie = (G * p.machine.wheelbaseM) / (2 * p.machine.cgHeightM);
  const power = p.machine.powerKw * 1000;

  /** Arc length of the segment ending at i (wrapping at the start line). */
  const dsAt = (i: number): number => {
    const d = i === 0 ? line.lengthM - line.cumDistM[n - 1] : line.cumDistM[i] - line.cumDistM[i - 1];
    return Math.max(0.05, d);
  };

  // ---- pass 1: lateral limit -------------------------------------------
  for (let i = 0; i < n; i++) {
    const k = Math.abs(line.curvature[i]);
    const r = k > 1e-6 ? 1 / k : Infinity;
    const vLat = Number.isFinite(r) ? Math.sqrt(aLatMax * r) : Infinity;
    v[i] = Math.max(V_MIN, Math.min(vTop, vLat));
  }

  /** How much of the tyre's lateral capacity is in use at speed `vv`, 0..1. */
  const latUse = (vv: number, k: number): number => Math.min(1, (vv * vv * Math.abs(k)) / aLatMax);

  /** Fraction of grip still available longitudinally at speed `vv` and curvature `k`. */
  const ellipse = (vv: number, k: number): number => {
    const used = latUse(vv, k);
    return Math.sqrt(Math.max(0, 1 - used * used));
  };

  /**
   * Longitudinal share available for BRAKING, which is not the same as the raw
   * ellipse: a rider chooses how much of it to spend at lean.
   *
   * `trailBrakeDepth` = 1 spends the whole remaining share, carrying brake
   * pressure to the apex. `trailBrakeDepth` = 0 fades braking out as soon as
   * the bike is leaned at all, which is straight-line braking — the bike is
   * upright, stopped, then turned. Both reach zero at full lean, as they must.
   */
  const brakeEllipse = (vv: number, k: number): number => {
    const used = latUse(vv, k);
    const full = Math.sqrt(Math.max(0, 1 - used * used));
    const depth = p.rider.trailBrakeDepth;
    return full * (depth + (1 - depth) * (1 - used));
  };

  // ---- pass 2: backward (braking) --------------------------------------
  // two laps of the loop so braking carries across the start line
  for (let pass = 0; pass < 2; pass++) {
    for (let step = n - 1; step >= 0; step--) {
      const i = step;
      const j = (i + 1) % n;
      const ds = dsAt(j);
      const a = aBrakeMax * brakeEllipse(v[j], line.curvature[j]);
      const vMax = Math.sqrt(v[j] * v[j] + 2 * a * ds);
      if (v[i] > vMax) v[i] = Math.max(V_MIN, vMax);
    }
  }

  // ---- pass 3: forward (acceleration) ----------------------------------
  for (let pass = 0; pass < 2; pass++) {
    for (let step = 0; step < n; step++) {
      const i = step;
      const j = (i - 1 + n) % n;
      const ds = dsAt(i);
      const vv = Math.max(V_MIN, v[j]);
      const aPower = power / (p.machine.massKg * vv);
      const aGrip = mu * G * ellipse(vv, line.curvature[j]);
      const aDrag = (0.5 * RHO * p.machine.cdA * vv * vv) / p.machine.massKg + ROLLING;
      // traction control shaves drive torque as the grip demand approaches the limit
      const tcFactor = 0.6 + 0.4 * p.rider.tcThreshold;
      const a = Math.min(aPower, aGrip * tcFactor, aWheelie) - aDrag;
      const vMax = Math.sqrt(Math.max(V_MIN * V_MIN, vv * vv + 2 * a * ds));
      if (v[i] > vMax) v[i] = Math.max(V_MIN, vMax);
    }
  }

  // ---- integrate and fill the g channels -------------------------------
  let t = 0;
  for (let i = 0; i < n; i++) {
    tS[i] = t;
    const ds = dsAt((i + 1) % n);
    const vNext = v[(i + 1) % n];
    const vAvg = Math.max(V_MIN, (v[i] + vNext) / 2);
    t += ds / vAvg;
    longG[i] = (vNext * vNext - v[i] * v[i]) / (2 * ds * G);
    const aLat = (v[i] * v[i] * line.curvature[i]) / G;
    latG[i] = aLat;
    leanDeg[i] = (Math.atan(aLat) * 180) / Math.PI;
    // Combined tyre demand as a fraction of the friction circle. Above 1 the
    // tyre is being asked for more than it has — that is a fall, not a lap.
    // The solver's own passes keep this at or under 1 by construction, so a
    // value over 1 means a parameter combination the rider cannot actually
    // ride, and the UI warns rather than quietly reporting a fast lap.
    const lu = Math.min(1.5, Math.abs(aLat) / (aLatMax / G));
    const lo = Math.min(1.5, Math.abs(longG[i]) / mu);
    gripUse[i] = Math.hypot(lu, lo);
  }

  return { v, longG, latG, leanDeg, gripUse, tS, lapTimeS: t };
}
