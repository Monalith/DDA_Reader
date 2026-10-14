// Quasi-steady-state lap solver: O(n) passes over the line. In the v2 rider
// model (spec v2 §2) this envelope is the UPPER BOUND the event template
// (events.ts, W3) rides under.
//
//   (1)  lateral limit   |ã_y| ≤ min(μ_lat_eff, tan φ_i,max)·g̃
//   (1b) roll-rate cap   v·|dφ/ds| ≤ rollRateFrac·φ̇_max(v, φ)
//   (2)  backward pass   braking into every speed minimum
//   (3)  forward pass    acceleration out of it
//   v(s) = min of all;  t = integral ds / v
//
// (2) and (3) run as a short fixed-point loop rather than once each, because
// the braking rate limit is anchored at the moment the brake goes on and that
// is where the two curves meet. See `BRAKE_RATE_ITERS`.
//
// Combined grip is the friction ellipse with the RIDER's axes μ_eff (allowed
// slip scales each axis, tyre.ts): longitudinal capacity falls as lateral use
// rises, which is what makes trail braking and progressive throttle come out
// of the model rather than being scripted. Load transfer caps both ends:
// braking at the stoppie limit, drive at the wheelie limit, each at the bike's
// real roll (vehicle.ts, R1 §3.1-3.2).
//
// 3D ROAD (spec v2 §2.3, R1 §3.5). Every pass works in the road frame with an
// effective normal gravity and tyre-frame demands:
//
//   g̃   = g·cosσ·cosβ + v²·ν        (σ slope, β bank, ν normal curvature)
//   ã_y = v²κ − sgn(κ)·g·cosσ·sinβ  (favourable banking takes lateral demand)
//   ã_x = a_x + g·sinσ              (uphill costs drive, helps braking)
//
// and the friction ellipse / lean are judged against g̃ instead of g. All three
// channels are optional on `Line` and read as zero; with zero channels every
// expression reduces to the flat-road one with the SAME floating-point
// operations (×1, +0), so zero-filled and absent channels give bit-identical
// envelopes (asserted in simSolver.test.ts).
import { clampParams } from './presets';
import { effectiveMu } from './tyre';
import type { Envelope, EnvelopeCaps, Line, RiderParams, SimParams } from './types';
import {
  AIR_DENSITY,
  bikeLeanFn,
  idealLeanLimitRad,
  rollRateBoundRadPerS,
  stoppieLimitMs2,
  wheelieLimitMs2,
} from './vehicle';

export const G = 9.81;

/** Air density at sea level, kg/m^3 (single source: vehicle.ts). */
const RHO = AIR_DENSITY;
/**
 * Lowest effective normal gravity the passes will use, m/s^2. Over a sharp
 * crest v²ν can cancel g entirely (the bike goes light); a zero g̃ would be a
 * zero friction budget and a division by zero. Numeric guard, not a model.
 */
const G_TILDE_MIN = 0.1 * 9.81;
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
 * How many times the jerk-limited backward pass is re-run. See
 * `brakeRiseGps` in `types.ts` and the pass itself below.
 *
 * The rate limit is anchored at the moment the brake goes on, and nothing
 * knows where that is until the profile is solved, so the solve runs, the
 * brake onsets are re-read off what it produced, and it runs again.
 *
 * Measured on the real Serres geometry at the shipped defaults, the lap time
 * is 79.5082 s with one iteration (which is the unlimited solve: there is no
 * clock yet), 79.5345 with two, 79.5338 with three, and bit-identical to that
 * from four on. So three is already converged to 0.7 ms and four is the first
 * iteration that changes nothing at all. Anything less than two leaves the
 * rate limit entirely inert, which is the failure to guard against — see
 * `simLongG.test.ts`.
 */
const BRAKE_RATE_ITERS = 4;
/**
 * How much deceleration past drag and rolling losses counts as the brake being
 * on, m/s^2. Not a tuning constant: it only has to be above the arithmetic
 * noise in a `Float32Array` velocity difference (about 1e-3 m/s^2 here), and
 * below any deceleration a rider would reach for the lever for. 0.05 m/s^2 is
 * 0.005 g.
 */
const BRAKE_ON_MARGIN = 0.05;
/** Ceiling on the slide scrub (`caps.scrubCoef`), m/s²: 0.3 g. */
const SCRUB_MAX_MS2 = 0.3 * G;

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

/**
 * Deceleration from aerodynamic drag and rolling/driveline losses at speed
 * `vMs`, m/s^2.
 *
 * It does NOT pass through the tyre contact patches, so it ADDS to whatever
 * the brakes can do rather than competing with cornering grip for it. That is
 * why the backward pass puts it outside the friction ellipse, and why
 * `gripUse` adds it back before judging the tyre. Exported so a test can
 * assert the solver's braking against the figure rather than against a
 * number copied out of it.
 */
export function lossDecelMs2(machine: { cdA: number; massKg: number }, vMs: number): number {
  return (0.5 * RHO * machine.cdA * vMs * vMs) / machine.massKg + ROLLING;
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

/**
 * Everything the passes need about one (line, params) pair, precomputed once:
 * the rider's effective μ per axis, the lean-limited lateral ceiling, the 3D
 * road channels, and the per-sample tyre caps. `solve` and the exported
 * `brakeCapMs2` / `driveCapMs2` both read from this, so the event template
 * (W3) gets EXACTLY the caps the passes used.
 */
interface SolverCtx {
  p: SimParams;
  n: number;
  /** μ_eff per axis (spec v2 §2.2). */
  muEff: { brake: number; drive: number; lat: number };
  /** μ_peak per axis, for `gripUsePeak`. */
  muPeak: { long: number; lat: number };
  /** Lateral ceiling on a flat road, m/s^2: min(μ_lat_eff, tan φ_i,max)·g. */
  aLatMax: number;
  vTop: number;
  gs: Float64Array;
  gRatio(i: number, vv: number): number;
  aY(i: number, vv: number): number;
  dsAt(i: number): number;
  /** |ã_y| as a fraction of the rider's lateral μ_eff·g̃, 0..1 (the ellipse's lateral axis). */
  latUse(vv: number, i: number): number;
  /** Signed real bike roll at sample i and speed vv, radians (left turn = +). */
  bikeRoll(i: number, vv: number): number;
  brakeCap(i: number, vv: number): number;
  driveCap(i: number, vv: number): number;
  /** Per-station rider values where a corner overrides them (`riderAt`), else undefined. */
  rollFrac?: Float64Array;
  jerkGps?: Float64Array;
}

/**
 * The rider in force at a station (cornerRider.ts `riderAccessor`): per-corner
 * trail braking, roll rate and brake build. Absent = the lap-wide rider.
 */
export type RiderAt = (i: number) => RiderParams;

function prepare(line: Line, params: SimParams, caps?: EnvelopeCaps, riderAt?: RiderAt): SolverCtx {
  const p = clampParams(params);
  const n = line.points.length;
  const m = p.machine;

  const muEff = effectiveMu(p.tyre, p.rider);
  const muPeak = { long: (p.tyre.muX ?? p.tyre.mu) * p.tyre.gripScale, lat: p.tyre.mu * p.tyre.gripScale };
  // The lean limit is on the REAL bike roll (the tyre's `maxLeanDeg`, scaled by
  // the rider's `leanUsage`); the lateral acceleration it allows is set by the
  // IDEAL roll that produces it, after the crown and hang-off corrections
  // (spec v2 §2.1, R1 §3.2). The tyre and the lean both cap lateral g; the
  // lower wins.
  const maxBikeLean = (p.tyre.maxLeanDeg * p.rider.leanUsage * Math.PI) / 180;
  const tanIdealMax = Math.tan(idealLeanLimitRad(m, maxBikeLean));
  const aLatMax = Math.max(0.1, Math.min(muEff.lat, tanIdealMax) * G);
  // Braking is friction-limited at the rider's own μ_brake_eff. `brakingG`
  // used to be a separate cap; spec v2 derives it from the SAME quantity
  // (derive.ts: brakingG = μx·g(sBrake)), so applying both would count the
  // rider's restraint twice. It is honoured only when the user has PINNED it
  // in the advanced panel (`overrides` contains 'brakingG'), as a ceiling on
  // what the tyre would otherwise allow. Aero and rolling losses are added on
  // top in the backward pass (they are not carried by a contact patch).
  const pinnedBrakingG = p.rider.overrides.includes('brakingG');
  const aBrakeMax = Math.max(0.1, (pinnedBrakingG ? Math.min(p.rider.brakingG, muEff.brake) : muEff.brake) * G);
  const aDriveMax = Math.max(0.1, muEff.drive * G);
  const vTop = topSpeedMs(p);
  const power = m.powerKw * 1000;

  // ---- 3D road channels (absent = 0) ------------------------------------
  //
  // Precomputed per sample so the passes stay a handful of flops: cc = cosσ·cosβ,
  // sb = g·cosσ·sinβ (bank's lateral help), gs = g·sinσ (grade), nu = ν.
  // With the channels absent cc = 1, sb = gs = nu = 0 exactly.
  const cc = new Float64Array(n).fill(1);
  const sb = new Float64Array(n);
  const gs = new Float64Array(n);
  const nu = new Float64Array(n);
  if (line.slopeRad || line.bankRad || line.nu) {
    for (let i = 0; i < n; i++) {
      const sig = line.slopeRad?.[i] ?? 0;
      const bet = line.bankRad?.[i] ?? 0;
      cc[i] = Math.cos(sig) * Math.cos(bet);
      sb[i] = G * Math.cos(sig) * Math.sin(bet);
      gs[i] = G * Math.sin(sig);
      nu[i] = line.nu?.[i] ?? 0;
    }
  }
  /** g̃/g at sample i and speed vv: 1 exactly on a flat road. */
  const gRatio = (i: number, vv: number): number => Math.max(G_TILDE_MIN, G * cc[i] + vv * vv * nu[i]) / G;
  /**
   * Signed tyre-frame lateral demand ã_y, m/s^2. `bankRad` is positive when
   * the surface falls toward the turn centre, whichever way the turn goes, so
   * it always reduces the demand; on a straight (κ = 0) there is no turn
   * centre and banking is ignored.
   */
  const aY = (i: number, vv: number): number => {
    const k = line.curvature[i];
    return vv * vv * k - (k > 0 ? sb[i] : k < 0 ? -sb[i] : 0);
  };

  /** Arc length of the segment ending at i (wrapping at the start line). */
  const dsAt = (i: number): number => {
    const d = i === 0 ? line.lengthM - line.cumDistM[n - 1] : line.cumDistM[i] - line.cumDistM[i - 1];
    return Math.max(0.05, d);
  };

  // The friction ellipse's lateral semi-axis is the rider's μ_lat_eff·g̃
  // (spec v2 §2.2), NOT the lean-limited ceiling: running out of lean angle
  // is geometry, and leaves the tyre's longitudinal grip where it was.
  const aLatTyre = Math.max(0.1, muEff.lat * G);
  // EnvelopeCaps (fitRider.ts): a per-sample lateral ceiling is ALSO the
  // ellipse's lateral axis there — the fitted rider's own lateral g is what
  // "full lean" means for that corner.
  const latCapArr = caps?.latAxisMs2 ?? caps?.aLatMs2;
  const latUse = latCapArr
    ? (vv: number, i: number): number =>
        Math.min(1, Math.abs(aY(i, vv)) / (Math.max(0.1, latCapArr[i]) * gRatio(i, vv)))
    : (vv: number, i: number): number => Math.min(1, Math.abs(aY(i, vv)) / (aLatTyre * gRatio(i, vv)));
  const brakeArr = caps?.brakeMs2;
  const driveArr = caps?.driveMs2;
  const driveScaleArr = caps?.driveScale;

  const bikeLean = bikeLeanFn(m);
  const bikeRoll = (i: number, vv: number): number => bikeLean(Math.atan(aY(i, vv) / (G * gRatio(i, vv))));

  // Both pitch limits are LOWEST upright (h_φ ≤ h at any lean), so the bike's
  // roll — an atan and an asin — is only worked out where the upright limit
  // would bind. Same result, a fraction of the cost.
  const stoppieUpright = stoppieLimitMs2(m, 0, G);

  // per-corner rider values (cornerRider.ts), read once per station
  let tbDepth: Float64Array | undefined;
  let tbProfile: Float64Array | undefined;
  let rollFrac: Float64Array | undefined;
  let jerkGps: Float64Array | undefined;
  if (riderAt) {
    tbDepth = new Float64Array(n);
    tbProfile = new Float64Array(n);
    rollFrac = new Float64Array(n);
    jerkGps = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const r = riderAt(i);
      tbDepth[i] = r.trailBrakeDepth;
      tbProfile[i] = r.trailBrakeProfile;
      rollFrac[i] = r.rollRateFrac;
      jerkGps[i] = r.brakeRiseGps;
    }
  }

  /** Tyre braking deceleration available, m/s^2: ellipse·brakeShare, stoppie, pinned brakingG. No drag, no rate limit. */
  const brakeCap = (i: number, vv: number): number => {
    const gr = gRatio(i, vv);
    const share = tbDepth
      ? brakeShare(latUse(vv, i), tbDepth[i], tbProfile![i])
      : brakeShare(latUse(vv, i), p.rider.trailBrakeDepth, p.rider.trailBrakeProfile);
    const aGrip = (brakeArr ? Math.max(0.1, brakeArr[i]) : aBrakeMax) * gr * share;
    if (aGrip <= stoppieUpright * gr) return aGrip;
    return Math.min(aGrip, stoppieLimitMs2(m, bikeRoll(i, vv), G * gr));
  };

  /**
   * Drive acceleration available, m/s^2: power, ellipse·TC, wheelie. No drag.
   *
   * Traction control shaves drive torque when the SLIP DEMAND is high, not
   * always: a constant `0.6 + 0.4·tcThreshold` multiplier used to discard 20 %
   * of the grip bolt upright, which made the forward pass grip-limited where
   * it should be power-limited (0.28 s on Serres; 147 → 250 kW worth 1.04 s
   * with the constant and 2.11 s without it on the synthetic circuit). Slip is
   * provoked by asking for drive while the tyre spends its grip sideways, so
   * the cut scales with lateral use: none upright, `0.55 + 0.45·tcThreshold`
   * of what is left on the ellipse at full lean — the same allowance the `dtc`
   * channel in `rider.ts` reports.
   */
  const driveCap = (i: number, vv0: number): number => {
    const vv = Math.max(V_MIN, vv0);
    const gr = gRatio(i, vv);
    const used = latUse(vv, i);
    const ell = Math.sqrt(Math.max(0, 1 - used * used));
    const tcFloor = 0.55 + 0.45 * p.rider.tcThreshold;
    const tcFactor = 1 - (1 - tcFloor) * used;
    const aPower = power / (m.massKg * vv);
    const a = Math.min(aPower, (driveArr ? Math.max(0.1, driveArr[i]) : aDriveMax) * gr * ell * tcFactor);
    const aw = a <= wheelieLimitMs2(m, vv, 0, G * gr) ? a : Math.min(a, wheelieLimitMs2(m, vv, bikeRoll(i, vv), G * gr));
    if (!driveScaleArr) return aw;
    // the roll-on fraction (floored like the caps, so a scale of 0 is a closed throttle, not a numerical stall)
    return Math.max(0.1, aw * Math.min(1, Math.max(0, driveScaleArr[i])));
  };

  return { p, n, muEff, muPeak, aLatMax, vTop, gs, gRatio, aY, dsAt, latUse, bikeRoll, brakeCap, driveCap, rollFrac, jerkGps };
}

/**
 * Cache of prepared contexts, keyed by the caller's own (line, params)
 * objects, so the per-sample cap queries from the event template do not redo
 * the lean inversion and the 3D precompute on every call. The caller must not
 * mutate a line or params object after querying it.
 */
const ctxCache = new WeakMap<Line, WeakMap<SimParams, SolverCtx>>();
function ctxFor(line: Line, params: SimParams): SolverCtx {
  let byParams = ctxCache.get(line);
  if (!byParams) {
    byParams = new WeakMap();
    ctxCache.set(line, byParams);
  }
  let ctx = byParams.get(params);
  if (!ctx) {
    ctx = prepare(line, params);
    byParams.set(params, ctx);
  }
  return ctx;
}

/**
 * Tyre braking deceleration available at sample i and speed vMs, m/s^2
 * (positive): μ_brake_eff·g̃·brakeShare, capped by the stoppie limit at the
 * bike's roll there, and by a PINNED `brakingG`. WITHOUT drag and rolling
 * losses (add `lossDecelMs2`), WITHOUT grade, and without the brake-rise
 * rate limit (the event template applies its own). These are exactly the caps
 * the solver's backward pass uses.
 */
export function brakeCapMs2(line: Line, params: SimParams, i: number, vMs: number): number {
  return ctxFor(line, params).brakeCap(i, vMs);
}

/**
 * Drive acceleration available at sample i and speed vMs, m/s^2: the least of
 * engine power, μ_drive_eff·g̃·ellipse·TC, and the wheelie limit at the bike's
 * roll there. WITHOUT drag and rolling losses and WITHOUT grade. Exactly the
 * cap the solver's forward pass uses.
 */
export function driveCapMs2(line: Line, params: SimParams, i: number, vMs: number): number {
  return ctxFor(line, params).driveCap(i, vMs);
}

/**
 * `brakeCapMs2` / `driveCapMs2` for a solve with per-station caps and a
 * per-corner rider (cornerRider.ts): one prepared context, the exact caps
 * `solve(line, params, caps, riderAt)` uses.
 */
export function solverCaps(
  line: Line,
  params: SimParams,
  caps?: EnvelopeCaps,
  riderAt?: RiderAt,
): { brakeCapMs2(i: number, vMs: number): number; driveCapMs2(i: number, vMs: number): number } {
  const ctx = prepare(line, params, caps, riderAt);
  return { brakeCapMs2: (i, v) => ctx.brakeCap(i, v), driveCapMs2: (i, v) => ctx.driveCap(i, v) };
}

/**
 * Half-width of the dφ/ds stencil, metres: the same 20 m as `CURV_SCALE_M` in
 * line.ts, the scale the line's curvature is measured and smoothed over.
 * Differentiating that curvature over ±1 sample (2 m) read its residual
 * centerline noise as roll: ±8-13° of lean wiggle at 260-280 km/h on the
 * Serres main straight, which no rider follows. Nothing below the curvature's
 * own resolution is a real roll demand.
 */
const ROLL_STENCIL_M = 20;
/**
 * Bike roll under which the roll-rate constraint is not applied, when BOTH
 * stencil ends are below it: 3°. Straight-line lean noise, not a transition.
 * "öneri", doğrulanmadı.
 */
const ROLL_DEADBAND_RAD = (3 * Math.PI) / 180;

/** Per-sample ends and arc length of the roll-rate stencil. */
interface RollStencil {
  im: Int32Array;
  ip: Int32Array;
  span: Float64Array;
}

/**
 * For every sample, the first sample at least `ROLL_STENCIL_M` behind and
 * ahead of it (wrapping), and the arc length between them. A line shorter
 * than the stencil uses at most half the loop each way.
 */
function rollStencil(n: number, dsAt: (i: number) => number): RollStencil {
  const im = new Int32Array(n);
  const ip = new Int32Array(n);
  const span = new Float64Array(n);
  const maxK = Math.max(1, Math.floor(n / 2) - 1);
  for (let i = 0; i < n; i++) {
    let back = 0;
    let k = 0;
    while (k < maxK && back < ROLL_STENCIL_M) {
      back += dsAt((i - k + n) % n);
      k++;
    }
    im[i] = (i - k + n) % n;
    let fwd = 0;
    k = 0;
    while (k < maxK && fwd < ROLL_STENCIL_M) {
      k++;
      fwd += dsAt((i + k) % n);
    }
    ip[i] = (i + k) % n;
    span[i] = back + fwd;
  }
  return { im, ip, span };
}

/** Grid step of the roll-rate cap's scan for its first crossing, m/s. */
const ROLL_SCAN_STEP_MS = 2;
/** Bisection steps inside the crossing cell: 2 m/s / 2^20 ≈ 2e-6 m/s. */
const ROLL_BISECT_ITERS = 20;

/**
 * Highest speed at sample i at which the roll RATE the line demands stays
 * within the rider's share of the Biniewicz bound (spec v2 §2.5, R1 §3.3):
 *
 *     v · |dφ/ds| ≤ rollRateFrac · φ̇_max(v, φ)
 *
 * dφ/ds is the central difference of the real bike roll over the stencil
 * `im` … `ip`, which spans `ROLL_STENCIL_M` either side of i (see there), and
 * the constraint is skipped where both ends are under `ROLL_DEADBAND_RAD`.
 *
 * Solved per sample AT FIXED SPEED across the stencil (quasi-steady: the
 * v'·κ term of the lateral jerk is neglected), except that a neighbour is
 * never taken faster than its own lateral limit `vLat` — otherwise a corner
 * of varying curvature ridden AT the lean/grip limit (constant φ, so no roll
 * rate at all) would read as a roll demand. With that, the left side rises
 * with v and the right side falls, so the cap is a root found by bisection
 * and needs no outer iteration. The plan's "cap, re-solve, ×3" loop
 * oscillates on a curvature step instead: capping the speed lowers the lean
 * there, which lifts the cap on the next round. This is that loop's fixed
 * point under the same stencil.
 */
function rollRateCap(ctx: SolverCtx, i: number, vLat: Float32Array, st: RollStencil): number {
  const im = st.im[i];
  const ip = st.ip[i];
  const ds = st.span[i];
  const vUpper = vLat[i];
  const frac = ctx.rollFrac ? ctx.rollFrac[i] : ctx.p.rider.rollRateFrac;
  const excess = (vv: number): number => {
    const phiP = ctx.bikeRoll(ip, Math.min(vv, vLat[ip]));
    const phiM = ctx.bikeRoll(im, Math.min(vv, vLat[im]));
    // straight-line noise: no roll constraint near upright
    if (Math.abs(phiP) < ROLL_DEADBAND_RAD && Math.abs(phiM) < ROLL_DEADBAND_RAD) return -1;
    const dphi = Math.abs(phiP - phiM) / ds;
    return vv * dphi - frac * rollRateBoundRadPerS(vv, ctx.bikeRoll(i, vv));
  };
  if (excess(vUpper) <= 0) return vUpper;
  if (excess(V_MIN) > 0) return V_MIN;
  // The LOWEST root, found by a fixed-grid scan up from V_MIN and then
  // bisection inside the first cell that goes over. Two reasons:
  //  - the excess is not monotone once a neighbour saturates at its own
  //    lateral limit (entering a tightening corner the far neighbour's lean
  //    freezes while the near one's keeps rising, so dφ/ds shrinks again);
  //    a speed past the first crossing is infeasible whatever happens above
  //    it, so the first crossing is the cap;
  //  - a grid fixed in absolute speed (not scaled to vUpper, which carries
  //    the power-dependent top speed) makes the root independent of power:
  //    a bracket that moves with vUpper moved the root in its last bits,
  //    enough to make the lap non-monotone in power by 1e-7 s.
  let lo = V_MIN;
  let hi = V_MIN;
  for (;;) {
    hi = lo + ROLL_SCAN_STEP_MS;
    if (hi >= vUpper || excess(hi) > 0) break;
    lo = hi;
  }
  for (let k = 0; k < ROLL_BISECT_ITERS; k++) {
    const mid = 0.5 * (lo + hi);
    if (excess(mid) <= 0) lo = mid;
    else hi = mid;
  }
  return Math.min(lo, vUpper);
}

/**
 * The QSS envelope. `caps` (optional) replaces the rider's lap-wide ceilings
 * with per-sample ones — the reference-fit rider (`fitRider.ts`) uses it to
 * give every corner its own lateral, braking and drive g without forking the
 * passes. Without `caps` the solve is exactly the v2 one.
 */
export function solve(line: Line, params: SimParams, caps?: EnvelopeCaps, riderAt?: RiderAt): Envelope {
  const n = line.points.length;
  const v = new Float32Array(n);
  const longG = new Float32Array(n);
  const latG = new Float32Array(n);
  const leanDeg = new Float32Array(n);
  const gripUse = new Float32Array(n);
  const gripUsePeak = new Float32Array(n);
  const tS = new Float64Array(n);
  if (n < 2) return { v, longG, latG, leanDeg, gripUse, gripUsePeak, tS, lapTimeS: 0 };

  const ctx = prepare(line, params, caps, riderAt);
  const { p, aLatMax, vTop, gs, gRatio, aY, dsAt, brakeCap, driveCap, muEff, muPeak } = ctx;

  // ---- pass 1: lateral limit -------------------------------------------
  //
  // |ã_y| ≤ c·g̃ with c = aLatMax/g (R1 §3.5):
  //   v²·(|κ| − c·ν) ≤ aLatMax·cosσ·cosβ + g·cosσ·sinβ
  // A denominator ≤ 0 (a dip loading the tyre faster than the corner asks)
  // means no lateral limit: the top-speed cap applies.
  const latArr = caps?.aLatMs2;
  for (let i = 0; i < n; i++) {
    const aLatI = latArr ? Math.max(0.1, latArr[i]) : aLatMax;
    const cLat = aLatI / G;
    const k = Math.abs(line.curvature[i]);
    const r = k > 1e-6 ? 1 / k : Infinity;
    let vLat = Infinity;
    if (Number.isFinite(r)) {
      const sig = line.slopeRad?.[i] ?? 0;
      const bet = line.bankRad?.[i] ?? 0;
      const nu = line.nu?.[i] ?? 0;
      const den = 1 - cLat * nu * r;
      const num = (aLatI * Math.cos(sig) * Math.cos(bet) + G * Math.cos(sig) * Math.sin(bet)) * r;
      vLat = den <= 0 ? Infinity : Math.sqrt(Math.max(0, num / den));
    }
    v[i] = Math.max(V_MIN, Math.min(vTop, vLat, caps?.vMaxMs?.[i] ?? Infinity));
  }

  // ---- pass 1b: roll-rate limit (spec v2 §2.5) --------------------------
  //
  // Applied to the free (lateral-limited) profile before braking and drive,
  // so the passes below brake INTO a roll-rate-limited transition exactly as
  // they brake into a lateral-limited apex. A constant-radius arc has
  // dφ/ds = 0 and is untouched; a chicane flip or a curvature step is where it
  // binds.
  if (!caps?.skipRollRate) {
    const cap = new Float32Array(n);
    const st = rollStencil(n, dsAt);
    for (let i = 0; i < n; i++) cap[i] = rollRateCap(ctx, i, v, st);
    for (let i = 0; i < n; i++) v[i] = Math.max(V_MIN, Math.min(v[i], cap[i]));
  }

  /** `lossDecelMs2` for this machine. */
  const aLoss = (vv: number): number => lossDecelMs2(p.machine, vv);
  const accelMaxArr = caps?.accelMaxMs2;
  /** Slide scrub at station i and speed vv, m/s² (0 without `caps.scrubCoef`). */
  const scrubArr = caps?.scrubCoef;
  const aScrub = (i: number, vv: number): number =>
    scrubArr && scrubArr[i] > 0 ? Math.min(SCRUB_MAX_MS2, scrubArr[i] * vv * vv * Math.abs(line.curvature[i])) : 0;

  // ---- pass 3: forward (acceleration) ----------------------------------
  //
  // A function rather than a straight-line pass because the braking rate
  // limit below needs the finished profile to find its own starting point,
  // so passes 2 and 3 iterate together. The cap (power, μ_drive_eff ellipse
  // with traction control, wheelie at the bike's roll) is `driveCap`; drag
  // and grade come off it here.
  const forward = (): void => {
    for (let pass = 0; pass < 2; pass++) {
      for (let step = 0; step < n; step++) {
        const i = step;
        const j = (i - 1 + n) % n;
        const ds = dsAt(i);
        const vv = Math.max(V_MIN, v[j]);
        // grade: uphill (gs > 0) costs drive
        const aNet = driveCap(j, vv) - aLoss(vv) - gs[j] - aScrub(j, vv);
        const a = accelMaxArr ? Math.min(aNet, accelMaxArr[j]) : aNet;
        const vMax = Math.sqrt(Math.max(V_MIN * V_MIN, vv * vv + 2 * a * ds));
        if (v[i] > vMax) v[i] = Math.max(V_MIN, vMax);
      }
    }
  };

  // ---- pass 2: backward (braking), rate-limited -------------------------
  //
  // Two things here that a textbook quasi-steady-state pass leaves out, both
  // of which are the difference between a square -1.10 g plateau and a real
  // braking trace. See `docs/.../2026-10-11-longitudinal-g.md`.
  //
  //   AERO AND ROLLING LOSSES ASSIST BRAKING: added on top of the tyre's
  //   share, so the braking peak is deepest at the end of the fastest
  //   straight (0.41 g of drag on the 1000 at 272 km/h).
  //
  //   PEAK RETARDATION IS NOT AVAILABLE INSTANTLY: the TYRE's share is
  //   rate-limited to `brakeRiseGps` g/s from the moment the brake goes on.
  //   Losses are not rate-limited: drag does not wait for the fork.
  //
  // The tyre's share is `brakeCap`: μ_brake_eff·g̃·brakeShare, capped by the
  // STOPPIE limit at the bike's roll (spec v2 §2.1). The rate limit is
  // anchored at brake-on, which is a property of passes 2 and 3 together (the
  // backward pass alone puts it ~80 m too early and the clock is inert), so
  // both are inside the iteration: `tOn[i]` is how long the brake has been
  // applied at i on the PREVIOUS iteration's profile, infinite on the first.
  const vFree = Float32Array.from(v);
  const tOn = new Float64Array(n).fill(Number.POSITIVE_INFINITY);
  const onBrake = new Uint8Array(n);
  const jerk = p.rider.brakeRiseGps * G;
  const jerkArr = ctx.jerkGps;
  for (let iter = 0; iter < BRAKE_RATE_ITERS; iter++) {
    v.set(vFree);
    // two laps of the loop so braking carries across the start line
    for (let pass = 0; pass < 2; pass++) {
      for (let step = n - 1; step >= 0; step--) {
        const i = step;
        const j = (i + 1) % n;
        const ds = dsAt(j);
        const aTyre = Math.min(brakeCap(j, v[j]), (jerkArr ? jerkArr[i] * G : jerk) * tOn[i]);
        // grade: uphill (gs > 0) helps braking
        const vMax = Math.sqrt(v[j] * v[j] + 2 * (aTyre + aLoss(v[j]) + gs[j] + aScrub(j, v[j])) * ds);
        if (v[i] > vMax) v[i] = Math.max(V_MIN, vMax);
      }
    }
    forward();
    if (iter === BRAKE_RATE_ITERS - 1) break;
    // ---- re-read the brake-on clock off the finished profile ------------
    // The brake is on where the realised deceleration exceeds what drag,
    // rolling losses (and an uphill) supply on their own: a closed throttle
    // is not a brake application.
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ds = dsAt(j);
      const need = (v[i] * v[i] - v[j] * v[j]) / (2 * ds);
      onBrake[i] = need > aLoss(v[i]) + gs[j] + aScrub(j, v[i]) + BRAKE_ON_MARGIN ? 1 : 0;
    }
    // Twice round, so a zone that straddles the start line gets its clock from
    // before it rather than from zero.
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i++) {
        if (!onBrake[i]) {
          tOn[i] = 0;
          continue;
        }
        const prev = (i - 1 + n) % n;
        const vAvg = Math.max(V_MIN, (v[prev] + v[i]) / 2);
        tOn[i] = (onBrake[prev] ? tOn[prev] : 0) + dsAt(i) / vAvg;
      }
    }
  }

  // ---- integrate and fill the channels ---------------------------------
  //
  // Every channel below is a POINT quantity at index i; `longG[i]` is the mean
  // of the segment arriving at i and the segment leaving it, so that it can be
  // combined with the point `latG[i]` in `gripUse` without an index stagger
  // (that stagger once put the circuit fixture's gripUse at 1.016).
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
    latG[i] = (v[i] * v[i] * line.curvature[i]) / G;
    // REAL bike roll (crown and hang-off corrected, spec v2 §2.1), so the
    // channel is comparable with an IMU. App convention: left = NEGATIVE
    // (`Envelope.leanDeg`), so it is the negated roll of a left turn.
    leanDeg[i] = (-ctx.bikeRoll(i, v[i]) * 180) / Math.PI;
    // Combined tyre demand. The lateral term is the tyre-frame ã_y against
    // g̃; the longitudinal term is the TYRE's share — aero and rolling losses
    // decelerate the bike without passing through a contact patch, so they
    // are added back, and so is the grade. Braking is judged against the
    // front's μ, drive against the rear's.
    //
    //   gripUse     against the RIDER's ceiling μ_eff (spec v2 §2.8): 1.0 is
    //               the rider's own allowed slip, which the passes respect by
    //               construction; over 1 is a lap this rider would not ride.
    //   gripUsePeak against the TYRE's peak μ: how much margin is left.
    //
    // The lean limit is deliberately NOT folded in: running out of lean angle
    // is geometry with its own channel, not a tyre overload.
    const gr = gRatio(i, v[i]);
    const ay = Math.abs(aY(i, v[i])) / (G * gr);
    const ax = (longG[i] + aLoss(v[i]) / G + gs[i] / G) / gr;
    const muLongEff = ax < 0 ? muEff.brake : muEff.drive;
    gripUse[i] = Math.hypot(Math.min(1.5, ay / muEff.lat), Math.min(1.5, Math.abs(ax) / muLongEff));
    gripUsePeak[i] = Math.hypot(Math.min(1.5, ay / muPeak.lat), Math.min(1.5, Math.abs(ax) / muPeak.long));
  }

  return { v, longG, latG, leanDeg, gripUse, gripUsePeak, tS, lapTimeS: t };
}
