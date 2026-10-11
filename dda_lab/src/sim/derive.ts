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
  // Calibrated on the BMW reference (2026-10-11 sweep, notes/2026-10-11-v2-
  // calibration.md): long_g p25 of -0.70 g needs sBrake ~0.5 on a 1.40 tyre,
  // i.e. R ~0.3; the owner's 0.80 g tyre peak sits at R ~0. (ölçüm + öneri)
  // Floor 0.15 (g ≈ 0.35: a 0.5 g tyre peak on a 1.42 tyre, the owner's
  // typical zone) rising to 0.75 (g ≈ 0.97) at full risk; the BMW's deepest
  // 0.98 g tyre peak sits at R ~0.4.
  sBrake: { from: 'R', a: 0.15, b: 0.6 },
  sDrive: { from: 'R', a: 0.5, b: 0.45 },
  // Lateral grip is mostly camber thrust (R2 §4.3) and its curve is flat:
  // riders of every level corner near the lateral ceiling, which is why the
  // BMW brakes at p25 -0.70 g yet carries v1's corner speeds. Risk therefore
  // moves sLat only in the top 15 %. (R2 + ölçüm, öneri)
  sLat: { from: 'R', a: 0.85, b: 0.15 },
  // brakingG is NOT a linear map: it is μx · g(sBrake); see deriveRider().
  brakingG: { from: 'R', a: 0, b: 0 },
  brakeRiseGps: { from: 'A', a: 0.6 * BRAKE_RISE_MAX_GPS, b: 0.4 * BRAKE_RISE_MAX_GPS },
  // Measured, not the Champ School window (that 2 s is brake-release to
  // drive, not apex to throttle): the R6 reference picks the throttle up at
  // the apex (-0.06 s), the owner's Ducati laps reach 20 % at +0.20 s. So
  // A = 0.4 (owner) -> 0.2 s, A = 0.8 (R6) -> 0.0 s; negative = before the
  // speed apex, which events.ts allows down to -0.3 s. (ölçüm + öneri)
  throttleDelayS: { from: 'A', a: 0.4, b: -0.5 },
  rollOnS: { from: 'A', a: 1.2, b: -0.8 },
  // Owner's turn-in roll rate is 0.48 of the Biniewicz bound (W4, p90 of the
  // median corner) at A ~0.3; pros at the bound. (ölçüm + öneri)
  rollRateFrac: { from: 'A', a: 0.4, b: 0.6 },
  // Trail braking is worth ~12 s across its square on Serres (simSerres);
  // the BMW reference brakes softly (p25 -0.70 g, R ~0.35) yet laps 1:19.8,
  // which is only possible if it still carries the brakes deep. So risk
  // moves the pair over the upper half of their range, not from zero.
  // (ölçüm + öneri; v1 calibration was 0.85 / 0.80)
  trailBrakeDepth: { from: 'R', a: 0.6, b: 0.4 },
  trailBrakeProfile: { from: 'R', a: 0.5, b: 0.5 },
  // Lean usage is its own map, not g(sLat): the owner's Ducati laps use 87 %
  // of the preset's lean limit (p99 51.2° of 59°) at the bottom of the risk
  // scale, while the BMW reference brakes softly (R ~0.35) yet carries v1's
  // corner speeds, i.e. leans to the limit. Steep and capped at 1 in
  // deriveRider(): R 0 -> 0.87, R >= 0.37 -> 1. (ölçüm + öneri)
  leanUsage: { from: 'R', a: 0.87, b: 0.35 },
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
  setIf('leanUsage', Math.min(1, lin('leanUsage')));

  return out;
}
