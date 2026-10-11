// The A/R derivation of spec v2 §2.6 run backwards (R3 §6.3 g).
//
// `src/sim/derive.ts` maps aggressiveness A and risk R to every rider number
// through `DERIVE_TABLE`. A measured number (a brake build rate, a pick-up
// delay, a lean usage) can therefore be turned back into the A or R that
// would have produced it. This reads the table itself, so a recalibration of
// `DERIVE_TABLE` is picked up here without a copy of its numbers.
import { DERIVE_TABLE } from '../../src/sim/derive';
import { gripFraction, type TyreAxis } from '../../src/sim/tyre';
import type { DerivedRiderKey, TyreTrackParams } from '../../src/sim/types';

/** s such that gripFraction(s, axis) = frac; clamps to [0, 1]. Bisection. */
export function inverseGripFraction(frac: number, axis: TyreAxis): number {
  if (!(frac > 0)) return 0;
  if (frac >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 60; k++) {
    const mid = (lo + hi) / 2;
    if (gripFraction(mid, axis) < frac) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * The slider value (A or R, NOT clamped to 0..1 — an out-of-range answer is
 * information) that `deriveRider` would turn into `value` for `key`.
 *
 * `brakingG` and `leanUsage` go through the tyre curve:
 *   brakingG  = μx·gripScale·g(sBrake, long)  →  sBrake  →  R
 *   leanUsage = min(1, a + b·R)               →  R (ambiguous at the cap)
 * The tyre curve saturates at s = 1, so a measured value at or above the
 * ceiling returns the R for s = 1 (the inverse cannot say how far above).
 */
export function invertDerive(key: DerivedRiderKey, value: number, tyre: TyreTrackParams): number {
  const lin = (k: DerivedRiderKey, y: number): number => {
    const t = DERIVE_TABLE[k];
    return t.b !== 0 ? (y - t.a) / t.b : Number.NaN;
  };
  if (key === 'brakingG') {
    const muX = (tyre.muX ?? tyre.mu) * tyre.gripScale;
    return lin('sBrake', inverseGripFraction(value / muX, 'long'));
  }
  // leanUsage has its own linear map, capped at 1 in deriveRider(); at the
  // cap the inverse can only say "R at or above the cap"
  if (key === 'leanUsage') return value >= 1 ? lin('leanUsage', 1) : lin('leanUsage', value);
  return lin(key, value);
}

/** Which slider a derived key belongs to. */
export function axisOf(key: DerivedRiderKey): 'A' | 'R' | 'const' {
  if (key === 'brakingG' || key === 'leanUsage') return 'R';
  return DERIVE_TABLE[key].from;
}

/** Weighted median (lower weighted median; NaN for no data). */
export function weightedMedian(xs: number[], ws: number[]): number {
  const pairs = xs
    .map((x, i) => [x, ws[i]] as const)
    .filter(([x, w]) => Number.isFinite(x) && Number.isFinite(w) && w > 0)
    .sort((a, b) => a[0] - b[0]);
  if (!pairs.length) return Number.NaN;
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let acc = 0;
  for (const [x, w] of pairs) {
    acc += w;
    if (acc >= total / 2 - 1e-12) return x;
  }
  return pairs[pairs.length - 1][0];
}
