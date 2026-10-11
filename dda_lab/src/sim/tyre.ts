// Tyre grip below the peak (spec v2 §2.2, research R2 §3.4-3.5).
//
// The friction ellipse stays. What changes is its size: each semi-axis is
// μ_peak × gripFraction(s), where s is the slip the RIDER allows as a fraction
// of the slip at peak force. The shape is a normalised Magic Formula,
//
//     g(s) = sin( C · atan( tan(π/(2C)) · s ) )
//
// with E = 0 so that the peak sits exactly at s = 1. C is the Magic Formula
// shape factor; below the peak the curve is flat, which is the physical reason
// riding under the limit costs little lap time and buys a lot of margin:
//
//     C = 1.6 (longitudinal, SEL-2004 Cx 1.6064):  g(0.5)=0.856  g(0.6)=0.92  g(0.8)=0.985
//     C = 1.3 (lateral, flatter: camber thrust):   g(0.5)=0.94   g(0.3)=0.75
//
// Values derived from Sharp, Evangelou & Limebeer (2004) Table I/II fits for a
// 120/70 front and 180/55 rear (sport-road tyres, μ capped at 1.3). Nothing is
// published for race slicks; the shape is assumed to carry over.
//
// Vehicle limits (wheelie, stoppie, lean conversion) live in vehicle.ts.
//
// Coefficient provenance: MF_C long = 1.6 is the SEL-2004 Cx fit (literature,
// road tyre); lat = 1.3 is an E = 0 approximation of the SEL lateral table
// (R2 §3.5, "öneri", doğrulanmadı for race slicks).
import type { RiderParams, TyreTrackParams } from './types';

/** Magic Formula shape factors, by axis. */
export const MF_C = { long: 1.6, lat: 1.3 } as const;

export type TyreAxis = keyof typeof MF_C;

/**
 * Usable fraction of peak grip at allowed slip `s` (0..1, fraction of the
 * slip at peak). Monotone, g(0) = 0, g(1) = 1.
 */
export function gripFraction(s: number, axis: TyreAxis): number {
  const C = MF_C[axis];
  const x = Number.isFinite(s) ? Math.min(1, Math.max(0, s)) : 0;
  // exactly 1 at the peak, so s = 1 reproduces the v1 ceiling bit for bit
  if (x >= 1) return 1;
  const Bn = Math.tan(Math.PI / (2 * C));
  return Math.sin(C * Math.atan(Bn * x));
}

/**
 * The rider's usable friction coefficient on each axis (spec v2 §2.2,
 * R2 §3.5): the tyre's peak scaled by the grip fraction at the slip the rider
 * allows on that axis.
 *
 *     brake = μx · gripScale · g(sBrake, long)     front, braking
 *     drive = μx · gripScale · g(sDrive, long)     rear, drive
 *     lat   = μy · gripScale · g(sLat,   lat)      lateral (μy = `mu`)
 *
 * `muX` undefined means μx = μy. One μx is used for both wheels: there is no
 * separate front/rear calibration (R2 §3.5: "μx = μy alınsın" until measured).
 * At s = 1 on every axis this is exactly v1's `mu · gripScale`.
 */
export function effectiveMu(
  tyre: TyreTrackParams,
  rider: Pick<RiderParams, 'sBrake' | 'sDrive' | 'sLat'>,
): { brake: number; drive: number; lat: number } {
  const muX = (tyre.muX ?? tyre.mu) * tyre.gripScale;
  const muY = tyre.mu * tyre.gripScale;
  return {
    brake: muX * gripFraction(rider.sBrake, 'long'),
    drive: muX * gripFraction(rider.sDrive, 'long'),
    lat: muY * gripFraction(rider.sLat, 'lat'),
  };
}
