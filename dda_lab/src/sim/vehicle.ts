// Vehicle geometry for the QSS solver (spec v2 §2.1, §2.5; research R1 §3.1-3.3).
//
// Pure functions of `MachineParams`; nothing here knows about a line. Units are
// SI and radians throughout. The solver (`solver.ts`) is the only consumer that
// turns these into per-sample limits.
//
// Symbols (R1 §3): p = wheelbase, b = rear contact → CG (horizontal),
// h = combined CG height upright, t = tyre crown radius, φ = bike roll,
// φ_i = ideal roll atan(a_y/g), m = total mass, m_r = rider mass,
// d_r = hang-off (lateral CG shift of the rider).
import type { MachineParams } from './types';

/** Standard gravity, m/s^2 (same value as `solver.ts` G). */
const G = 9.81;

/**
 * Air density at sea level, kg/m^3. The single source of the value: `solver.ts`
 * imports it, so the drag term in the wheelie limit and in `lossDecelMs2` can
 * never disagree.
 */
export const AIR_DENSITY = 1.225;

/** No longitudinal limit is allowed below this, m/s^2: keeps the passes moving. */
const LIMIT_FLOOR_MS2 = 0.1;

/** No roll-rate bound is allowed below this, rad/s (contract: floor 0.05). */
const ROLL_RATE_FLOOR = 0.05;

/**
 * Biniewicz lateral-jerk bound j_y(V) = β0 + β1·V, used as a roll-rate limit
 * φ̇ ≤ j_y/g·cos²φ (spec v2 §2.5).
 *
 * Source: Biniewicz PhD thesis values (β0 = 23.5 m/s^3, β1 = −0.31 1/s^2);
 * the journal paper (Biniewicz & Pyrz) quotes β0 = 32.56. "doğrulanmadı" —
 * which of the two is right is not settled (W3 confirms); the thesis value is
 * the more conservative and gives ~100°/s at 20 m/s upright.
 */
export const BINIEWICZ_JY = { beta0: 23.5, beta1: -0.31 } as const;

/**
 * Height of the combined CG above the ground at bike roll `phiRad`, metres:
 * `t + (h − t)·cos φ` (R1 §3.1, crown-corrected). At t = 0 this is h·cos φ.
 */
export function cgHeightAtLean(m: MachineParams, phiRad: number): number {
  const t = Math.max(0, m.tyreCrownM);
  const h = Math.max(t, m.cgHeightM);
  return t + (h - t) * Math.cos(phiRad);
}

/**
 * Drive acceleration at which the front wheel unloads, m/s^2 (R1 §3.1):
 *
 *     a_wheelie = g̃·b/h_φ − F_D·h_D/(m·h_φ),   h_D = h (cgHeightM)
 *
 * Drag acts above the ground and pitches the bike nose-up, so the limit FALLS
 * with speed. Floored at 0.1 m/s^2. `gEff` is the effective normal gravity g̃
 * of the 3D g-budget (R1 §3.5); it defaults to g on a flat road.
 */
export function wheelieLimitMs2(m: MachineParams, vMs: number, phiRad: number, gEff: number = G): number {
  const hPhi = cgHeightAtLean(m, phiRad);
  const fD = 0.5 * AIR_DENSITY * m.cdA * vMs * vMs;
  const a = (gEff * m.cgRearM) / hPhi - (fD * m.cgHeightM) / (m.massKg * hPhi);
  return Math.max(LIMIT_FLOOR_MS2, a);
}

/**
 * Tyre-borne braking deceleration at which the rear wheel unloads, m/s^2
 * (R1 §3.1): `g̃·(p − b)/h_φ`. With h_D ≈ h the drag moment cancels against
 * its own share of deceleration, so drag is added ON TOP of this by the caller
 * (the backward pass adds `lossDecelMs2`). Floored at 0.1 m/s^2.
 */
export function stoppieLimitMs2(m: MachineParams, phiRad: number, gEff: number = G): number {
  const hPhi = cgHeightAtLean(m, phiRad);
  return Math.max(LIMIT_FLOOR_MS2, (gEff * (m.wheelbaseM - m.cgRearM)) / hPhi);
}

/**
 * Real bike roll for an ideal (point-contact, centred-mass) roll `φ_i`
 * (R1 §3.2, Cossalter crown correction generalised for hang-off):
 *
 *     e = m_r·d_r/m,  R = hypot(h − t, e)
 *     δ = asin(min(1, t·sin φ_i / R)) − atan2(e, h − t)
 *     φ = φ_i + δ
 *
 * The crown term adds lean (the contact patch walks round the carcass), the
 * hang-off term takes it back (the rider's mass does part of the leaning).
 *
 * Two departures from the bare formula, both to keep `φ(s)` continuous for the
 * roll-rate constraint, which differentiates it:
 *  - it is applied to |φ_i| and the sign restored, so a left and a right
 *    corner are mirror images;
 *  - the result is held at ≥ 0 in magnitude. With hang-off the bare formula
 *    gives φ = −atan2(e, h − t) ≈ −4.8° at φ_i = 0, i.e. the bike leaning OUT
 *    of a corner it is not taking; mirrored, that is a ~10° step at every
 *    curvature sign change. Clamping at zero reads as "the rider only hangs
 *    off as far as the lean asks for", which is what a rider does on a kink.
 */
export function bikeLeanRad(m: MachineParams, idealLeanRad: number): number {
  const phiI = Math.abs(idealLeanRad);
  if (!(phiI > 0)) return 0;
  const t = Math.max(0, m.tyreCrownM);
  const hmt = Math.max(1e-3, m.cgHeightM - t);
  const e = m.massKg > 0 ? (m.riderMassKg * Math.max(0, m.hangOffM)) / m.massKg : 0;
  const R = Math.hypot(hmt, e);
  const delta = Math.asin(Math.min(1, (t * Math.sin(phiI)) / R)) - Math.atan2(e, hmt);
  const phi = Math.max(0, phiI + delta);
  return idealLeanRad < 0 ? -phi : phi;
}

/**
 * Largest ideal roll whose real bike roll does not exceed `maxBikeLeanRad`:
 * the inverse of `bikeLeanRad` (monotone non-decreasing in φ_i), by 40
 * bisection steps on [0, π/2). If even φ_i → π/2 stays under the limit (a
 * large hang-off with a light machine), the upper bound is returned; if the
 * limit is ≤ 0, 0. Never NaN.
 */
export function idealLeanLimitRad(m: MachineParams, maxBikeLeanRad: number): number {
  if (!(maxBikeLeanRad > 0)) return 0;
  let lo = 0;
  let hi = Math.PI / 2 - 1e-6;
  if (bikeLeanRad(m, hi) <= maxBikeLeanRad) return hi;
  for (let k = 0; k < 40; k++) {
    const mid = 0.5 * (lo + hi);
    if (bikeLeanRad(m, mid) <= maxBikeLeanRad) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Roll-rate bound, rad/s (spec v2 §2.5, R1 §3.3): the Biniewicz lateral-jerk
 * limit j_y(V) = β0 + β1·V mapped to roll through tan φ = a_y/g, which gives
 * dφ/dt = (ȧ_y/g)·cos²φ. Floored at 0.05 rad/s so a division by it in the
 * solver is always finite. The rider's share of it (`rollRateFrac`) is applied
 * by the caller.
 */
export function rollRateBoundRadPerS(vMs: number, phiRad: number): number {
  const jy = BINIEWICZ_JY.beta0 + BINIEWICZ_JY.beta1 * vMs;
  const c = Math.cos(phiRad);
  return Math.max(ROLL_RATE_FLOOR, (jy / G) * c * c);
}
