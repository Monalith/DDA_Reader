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

/**
 * Lateral-grip-use fraction by which braking has fully ceased at
 * `trailBrakeDepth` = 0. See `brakeShare`.
 */
const TB_MIN_REACH = 0.2;
/**
 * The two ends of the courage family in `brakeShare`. At `trailBrakeProfile`
 * = 0 the share is `(1 - x)**TB_TIMID_EXP`, which falls away as soon as the
 * bike leans; at 1 it is `1 - x**TB_BRAVE_POW`, which stays within 0.4 % of
 * the whole remaining share out to half the depth limit and only then lets go.
 * Both ends have a BOUNDED slope — at most `max(TB_TIMID_EXP, TB_BRAVE_POW)`
 * per unit of `x` — which is the reason the brave end is written this way
 * round rather than as a fractional exponent of the reach. `reach**0.15` is
 * the obvious way to say "nearly all of it", and it is wrong here: its
 * derivative is infinite at the depth limit, so it drops 0.49 of the share
 * inside 0.002 of lateral use. That is a step in all but name, and a step in
 * the available deceleration is exactly what the backward pass trips on.
 */
const TB_TIMID_EXP = 3;
const TB_BRAVE_POW = 8;

/**
 * Longitudinal share available for BRAKING, which is not the same as the raw
 * ellipse: a rider chooses how much of it to spend at lean, and that choice
 * has TWO independent axes. Both live here, in the solver, because only the
 * velocity envelope can make them mean anything — a parameter that shapes the
 * brake TRACE and nothing else cannot change the lap time, and the previous
 * `trailBrakeProfile` (a release-rate constant in `rider.ts`) was exactly
 * that: inert by construction. See `docs/.../virtual-vs-real.md` §2/H5.
 *
 *   EXTENT — `trailBrakeDepth`: how far into the corner braking continues at
 *   ALL, expressed as the lateral-grip-use fraction `uLim` at which brake
 *   pressure has fallen to zero. At 1 the rider can carry the brakes to
 *   maximum lean; at 0 the brakes are off by `TB_MIN_REACH` of the tyre's
 *   lateral capacity — about 15 deg of lean, i.e. straight-line braking:
 *   brake upright, turn, then drive. `TB_MIN_REACH` is not zero because a
 *   zero would put a step at `used = 0` into the backward pass; 0.2 is small
 *   enough to read as "upright" and large enough that the taper is a ramp.
 *
 *   MAGNITUDE — `trailBrakeProfile`: how much of the still-available
 *   longitudinal grip the rider dares to use on the way to that limit. It
 *   picks a taper out of a one-parameter family in `x = used / uLim`, every
 *   member of which is 1 at `x = 0` and 0 at `x = 1`:
 *
 *     profile 0.0   (1 - x)**3     timid: 0.13 of the share left at x = 0.5
 *     profile 0.5   1 - x          even
 *     profile 1.0   1 - x**8       brave: 0.996 of it still there at x = 0.5
 *
 *   The two halves meet at `1 - x` at profile 0.5, so the family is
 *   continuous and monotone across the whole slider.
 *
 * Properties the two must have, all satisfied by construction:
 *  - at `used = 0`, `reach = 1` and `reach**e = 1` for every exponent, so
 *    straight-line braking always gets the full `sqrt(1 - u^2)` = 1 and
 *    BOTH parameters are irrelevant, as they must be;
 *  - `reach**e <= 1` always, so braking never exceeds the friction ellipse;
 *  - both reach zero at the tyre's limit: `reach` hits 0 at `uLim <= 1` and
 *    `full` hits 0 at `used = 1`;
 *  - monotone and continuous in `used`, in `depth` and in `profile` — no
 *    discontinuity for the backward pass to trip on (`reach**e` is
 *    continuous at `reach = 0` for every `e > 0`).
 */
export function brakeShare(latUse: number, depth: number, profile: number): number {
  const used = Math.min(1, Math.max(0, latUse));
  const full = Math.sqrt(Math.max(0, 1 - used * used));
  const uLim = TB_MIN_REACH + (1 - TB_MIN_REACH) * Math.min(1, Math.max(0, depth));
  // how far through the braking zone's lateral range this sample is, 0..1
  const x = Math.min(1, used / uLim);
  const q = Math.min(1, Math.max(0, profile));
  const taper =
    q <= 0.5
      ? Math.pow(1 - x, TB_TIMID_EXP + (1 - TB_TIMID_EXP) * (q / 0.5))
      : 1 - Math.pow(x, 1 + (TB_BRAVE_POW - 1) * ((q - 0.5) / 0.5));
  return full * taper;
}

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
  // Braking is friction-limited too. `brakingG` is how hard the rider is
  // WILLING to brake; it cannot exceed what the tyre has. Without the min, a
  // mu*gripScale of 0.24 still braked at 1.54 g — 6.4x the available friction —
  // and that spare deceleration is most of what let gripUse reach 1.65-1.80.
  // The remaining friction ellipse is applied per sample in the pass below.
  const aBrakeMax = Math.max(0.1, Math.min(p.rider.brakingG, mu) * G);
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

  /** Longitudinal share available for BRAKING at this speed and curvature. */
  const brakeEllipse = (vv: number, k: number): number =>
    brakeShare(latUse(vv, k), p.rider.trailBrakeDepth, p.rider.trailBrakeProfile);

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
      // Traction control shaves drive torque when the SLIP DEMAND is high — not
      // always.
      //
      // This used to be `tcFactor = 0.6 + 0.4 * tcThreshold`, a constant
      // multiplier on the grip term with no reference to what the tyre is doing.
      // At the shipped `tcThreshold` = 0.5 that threw away 20 % of the
      // longitudinal grip EVERYWHERE, including bolt upright on a straight
      // where there is no lateral load to make the rear slip and no traction
      // control on earth intervenes: the drive out of every corner up to about
      // 150 km/h was capped at 10.4 m/s^2 instead of the 12.6 m/s^2 the front
      // wheel allows.
      //
      // Measured. On the real Serres geometry it is worth 0.28 s (79.60 ->
      // 79.32), because that lap is short of straight. The important cost is
      // the other one: it made the forward pass GRIP-limited where it should
      // have been POWER-limited, so adding power bought nothing. On the
      // synthetic circuit (`circuitFixture.ts`), which has the straights for
      // power to work on, going 147 -> 250 kW was worth 1.04 s with the
      // constant and is worth 2.11 s without it, and 400 kW was wholly
      // saturated (60.55 -> 60.54) where it now still gains.
      //
      // Slip is provoked by asking for drive while the tyre is already spending
      // its grip sideways, so the intervention scales with the lateral use: no
      // cut at all upright, and at full lean the drive is held to
      // `0.55 + 0.45 * tcThreshold` of what is left on the ellipse — the same
      // allowance the `dtc` channel in `rider.ts` reports, so the two agree.
      const slip = latUse(vv, line.curvature[j]);
      const tcFloor = 0.55 + 0.45 * p.rider.tcThreshold;
      const tcFactor = 1 - (1 - tcFloor) * slip;
      const a = Math.min(aPower, aGrip * tcFactor, aWheelie) - aDrag;
      const vMax = Math.sqrt(Math.max(V_MIN * V_MIN, vv * vv + 2 * a * ds));
      if (v[i] > vMax) v[i] = Math.max(V_MIN, vMax);
    }
  }

  // ---- integrate and fill the g channels -------------------------------
  //
  // Every channel below is a POINT quantity at index i. The mean acceleration
  // over the segment i -> i+1 is a SEGMENT quantity, so it is accumulated
  // separately and then averaged onto the points: `longG[i]` is the mean of the
  // segment arriving at i and the segment leaving it.
  //
  // That matters because `gripUse` combines `longG[i]` with `latG[i]`. While
  // `longG[i]` held the segment value, a corner entry compared the lateral
  // demand AT i with the longitudinal demand just AFTER i, and the mismatch —
  // not "numerical slack" — is what put gripUse at 1.001-1.044 on the solver's
  // own output, enough to trip the UI's over-the-limit banner on the shipped
  // defaults even though each pass respects the friction circle exactly.
  const segG = new Float32Array(n);
  let t = 0;
  for (let i = 0; i < n; i++) {
    tS[i] = t;
    const ds = dsAt((i + 1) % n);
    const vNext = v[(i + 1) % n];
    const vAvg = Math.max(V_MIN, (v[i] + vNext) / 2);
    t += ds / vAvg;
    segG[i] = (vNext * vNext - v[i] * v[i]) / (2 * ds * G);
  }
  for (let i = 0; i < n; i++) {
    longG[i] = (segG[(i - 1 + n) % n] + segG[i]) / 2;
    const aLat = (v[i] * v[i] * line.curvature[i]) / G;
    latG[i] = aLat;
    // app convention: left = negative, so lean is the NEGATED arctangent of the
    // lateral acceleration (see `Envelope.leanDeg`)
    leanDeg[i] = (-Math.atan(aLat) * 180) / Math.PI;
    // Combined tyre demand as a fraction of the FRICTION CIRCLE: both axes are
    // divided by the same mu, so 1.0 means the tyre is at its limit and above
    // 1 means it is being asked for more than it has — a fall, not a lap. The
    // solver's own passes keep this at or under 1 by construction, so a value
    // over 1 means a parameter combination the rider cannot ride, and the UI
    // warns rather than quietly reporting a fast lap.
    //
    // The LEAN limit is deliberately NOT folded in here. Dividing the lateral
    // term by aLatMax/G = min(mu, tan(leanLimit)) would make this an ellipse
    // rather than a circle, and on a lean-limited machine (the 250: tan(49.4
    // deg) = 1.17 against mu = 1.25) a perfectly rideable corner would read
    // 1.0 laterally with grip still in hand. Running out of lean angle is a
    // separate constraint with its own channel (`leanDeg`); it is not a tyre
    // overload and must not be reported as one.
    const lu = Math.min(1.5, Math.abs(aLat) / mu);
    const lo = Math.min(1.5, Math.abs(longG[i]) / mu);
    gripUse[i] = Math.hypot(lu, lo);
  }

  return { v, longG, latG, leanDeg, gripUse, tS, lapTimeS: t };
}
