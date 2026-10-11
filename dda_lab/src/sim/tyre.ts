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
// W1 OWNS the rest of this file (vehicle limits live in vehicle.ts). This
// skeleton exists so derive.ts can compile; W1 may extend, not rename.

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
  const Bn = Math.tan(Math.PI / (2 * C));
  return Math.sin(C * Math.atan(Bn * x));
}
