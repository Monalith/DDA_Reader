// Rider parameter derivation (spec v2 §2.6).
//
// Two top-level sliders — AGGRESSIVENESS (timing) and RISK (force level) —
// produce every other rider number. The user can pin any derived field in the
// advanced panel; pinned keys are listed in `rider.overrides` and left alone.
//
// EVERY coefficient here is a PROPOSAL (research R3 §5, R2 §3.5: "öneri,
// doğrulanmadı"). They are the single place to recalibrate once the owner's
// Ducati laps have been through `scripts/ducati-identify.ts` (W4). Do not
// scatter copies of these numbers.
import type { DerivedRiderKey, RiderParams, TyreTrackParams } from './types';
import { gripFraction } from './tyre';

/** Measured brake build on both reference laps: 2.7 / 2.8 g/s (notes 2026-10-11). */
export const BRAKE_RISE_MAX_GPS = 2.8;

/**
 * Linear maps `a + b·x` on the 0..1 sliders. Column source:
 *   sBrake / sLat / trailBrake* / leanUsage — R3 §5 (öneri)
 *   sDrive                                  — R3 §5 "çıkışta kayma" (öneri)
 *   brakeRiseGps                            — R3 §5, measured max (ölçüm)
 *   throttleDelayS, rollOnS                 — Champ School ~2 s window / <1 s roll-on (antrenör) + öneri
 *   rollRateFrac                            — R3 §5 (öneri), bound itself is Biniewicz j_y
 *   tcThreshold                             — v1 default kept constant (no source ties it to A/R yet)
 */
export const DERIVE_TABLE: Record<DerivedRiderKey, { from: 'A' | 'R' | 'const'; a: number; b: number }> = {
  sBrake: { from: 'R', a: 0.3, b: 0.65 },
  sDrive: { from: 'R', a: 0.5, b: 0.45 },
  sLat: { from: 'R', a: 0.55, b: 0.42 },
  // brakingG is NOT a linear map: it is μx · g(sBrake); see deriveRider().
  brakingG: { from: 'R', a: 0, b: 0 },
  brakeRiseGps: { from: 'A', a: 0.6 * BRAKE_RISE_MAX_GPS, b: 0.4 * BRAKE_RISE_MAX_GPS },
  throttleDelayS: { from: 'A', a: 1.6, b: -1.4 },
  rollOnS: { from: 'A', a: 1.2, b: -0.8 },
  rollRateFrac: { from: 'A', a: 0.5, b: 0.5 },
  trailBrakeDepth: { from: 'R', a: 0.3, b: 0.6 },
  trailBrakeProfile: { from: 'R', a: 0, b: 1 },
  // leanUsage is NOT linear either: φ_use = φ_max · g(sLat, Cy); see deriveRider().
  leanUsage: { from: 'R', a: 0, b: 0 },
  tcThreshold: { from: 'const', a: 0.5, b: 0 },
};

export const DERIVED_KEYS = Object.keys(DERIVE_TABLE) as DerivedRiderKey[];

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/**
 * Recompute the derived rider fields from `aggressiveness` and `risk`,
 * keeping every key named in `rider.overrides`. Pure; returns a new object.
 *
 * `tyre` is needed because `brakingG` is the tyre's longitudinal peak scaled
 * by the allowed-slip grip fraction, not a free number.
 */
export function deriveRider(rider: RiderParams, tyre: TyreTrackParams): RiderParams {
  const A = clamp01(rider.aggressiveness);
  const R = clamp01(rider.risk);
  const pinned = new Set<DerivedRiderKey>(rider.overrides ?? []);
  const out: RiderParams = { ...rider, overrides: [...pinned] };

  const lin = (key: DerivedRiderKey): number => {
    const t = DERIVE_TABLE[key];
    const x = t.from === 'A' ? A : t.from === 'R' ? R : 0;
    return t.a + t.b * x;
  };
  const setIf = (key: DerivedRiderKey, value: number): void => {
    if (!pinned.has(key)) (out as unknown as Record<DerivedRiderKey, number>)[key] = value;
  };

  setIf('sBrake', lin('sBrake'));
  setIf('sDrive', lin('sDrive'));
  setIf('sLat', lin('sLat'));
  setIf('brakeRiseGps', lin('brakeRiseGps'));
  setIf('throttleDelayS', lin('throttleDelayS'));
  setIf('rollOnS', lin('rollOnS'));
  setIf('rollRateFrac', lin('rollRateFrac'));
  setIf('trailBrakeDepth', lin('trailBrakeDepth'));
  setIf('trailBrakeProfile', lin('trailBrakeProfile'));
  setIf('tcThreshold', lin('tcThreshold'));

  // force-level fields that go through the tyre curve
  const muX = (tyre.muX ?? tyre.mu) * tyre.gripScale;
  setIf('brakingG', muX * gripFraction(out.sBrake, 'long'));
  setIf('leanUsage', gripFraction(out.sLat, 'lat'));

  return out;
}
