// The racing line, parameterised by kappa.
//
// kappa = 0 is the corner-speed ("C") line: minimise squared curvature, which
// spreads the direction change over the longest possible arc.
// kappa = 1 is the point-and-shoot ("V") line: concentrate curvature in a short
// zone and straighten the exit, which is what a powerful bike wants.
//
// Both are the same optimisation with a different penalty: the C objective
// penalises curvature itself, the V objective penalises curvature CHANGE very
// little and curvature a lot only where it is already low, which pushes the
// solution towards "straight, then a sharp bit, then straight".
import { fromLocalM, toLocalM } from '../core/geo';
import type { LngLat, TrackModel } from '../core/types';
import { stencilK, stencilLeftNormal } from './corridor';
import type { Corridor, Line, SimParams } from './types';

/** Gauss-Seidel sweeps. 60 converges on a 2 m grid and stays well under 1 ms. */
const SWEEPS = 60;
/** Relaxation factor; over-relaxation above 1 converges faster but oscillates. */
const OMEGA = 0.6;
/**
 * Anti-diffusion strength of the V (shortness) objective: how strongly it
 * amplifies the gap between d[i] and its neighbours' average each sweep.
 * Tuned empirically (see task-6-report.md): low enough that the box clamp
 * keeps it bounded over 60 sweeps, high enough to produce a measurably more
 * concentrated curvature profile than the C objective even on a perfectly
 * uniform corridor (a full-radius circle), where there is no corridor-width
 * contrast for the line to exploit — the only source of concentration left
 * is this amplification of the (otherwise negligible, ~1e-6 relative)
 * curvature noise intrinsic to any discretised closed loop.
 */
const SHARPEN_GAIN = 0.5;

/** Deterministic smooth pseudo-noise in [-1,1]: the same params give the same line. */
function wander(i: number, n: number, seed: number): number {
  let s = 0;
  for (let h = 1; h <= 3; h++) {
    s += Math.sin((2 * Math.PI * h * i) / n + seed * h * 1.7) / h;
  }
  return s / 1.833; // normalise 1 + 1/2 + 1/3
}

/**
 * Lateral offsets that minimise the kappa-weighted curvature objective, subject
 * to the corridor as a hard box constraint.
 */
function solveOffsets(
  n: number,
  stepM: number,
  baseCurv: Float32Array,
  loM: Float32Array,
  hiM: Float32Array,
  kappa: number,
): Float32Array {
  const d = new Float32Array(n);
  // Curvature of the offset line, to first order:  k_eff = k0 - d'' .
  // Minimising sum(k_eff^2) is a smoothing of d towards k0 * stepM^2 — this
  // is the C objective: it always pulls d[i] towards its neighbours' average,
  // so it cannot help but spread any bend over the widest arc it can reach.
  //
  // The V objective cannot be "the same target, weighted differently": a
  // fixed per-vertex target (e.g. pulling every vertex straight to its own
  // box edge) moves the WHOLE loop by the same amount and leaves the
  // curvature exactly as spread out as before — squaring a corner off is
  // not a translation, it is a *concentration*, and concentration needs a
  // term that amplifies whatever deviation from the local average already
  // exists (an anti-diffusion / sharpening step) rather than one more
  // position to average towards. SHARPEN_GAIN controls how strongly this
  // amplifies; the box clamp below is what keeps it from diverging.
  const wCurv = 1 - 0.95 * kappa;
  const wShort = 0.95 * kappa;
  const h2 = stepM * stepM;
  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    for (let i = 0; i < n; i++) {
      const p = d[(i - 1 + n) % n];
      const q = d[(i + 1) % n];
      // curvature term wants  d[i] = (p + q)/2 + k0*h^2/2
      const curvTarget = (p + q) / 2 + (baseCurv[i] * h2) / 2;
      // shortness term grows the existing gap between d[i] and its
      // neighbours' average, concentrating whatever bend the curvature
      // term has already seeded instead of adding a new, separate pull.
      const sharpTarget = d[i] + SHARPEN_GAIN * (d[i] - (p + q) / 2);
      const target = (wCurv * curvTarget + wShort * sharpTarget) / (wCurv + wShort);
      const next = d[i] + OMEGA * (target - d[i]);
      d[i] = Math.min(hiM[i], Math.max(loM[i], next));
    }
  }
  return d;
}

/** Signed curvature of a closed polyline in local metres, 1/m, + = left. */
function polylineCurvature(points: LngLat[], stencilM: number): Float32Array {
  const n = points.length;
  const out = new Float32Array(n);
  if (n < 3) return out;
  // estimate spacing from the first few segments
  let span = 0;
  for (let i = 1; i < Math.min(n, 11); i++) {
    const m = toLocalM(points[i - 1], points[i]);
    span += Math.hypot(m[0], m[1]);
  }
  const ds = span / Math.min(n - 1, 10);
  const k = Math.max(1, Math.round(stencilM / Math.max(0.1, ds)));
  for (let i = 0; i < n; i++) {
    const p0 = toLocalM(points[i], points[(i - k + n) % n]);
    const p2 = toLocalM(points[i], points[(i + k) % n]);
    const ax = -p0[0];
    const ay = -p0[1];
    const bx = p2[0];
    const by = p2[1];
    const cross = ax * by - ay * bx;
    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    // Third side of the p0-p1-p2 triangle is |p2 - p0|, taken from the
    // untransformed stencil vectors p0/p2 (not bx - ax, which works out to
    // p2 - (-p0) = p2 + p0, the wrong side length) — same formula as the
    // corridor extractor's stencilCurvature.
    const lc = Math.hypot(p2[0] - p0[0], p2[1] - p0[1]);
    const denom = la * lb * lc;
    out[i] = denom > 1e-9 ? (2 * cross) / denom : 0;
  }
  return out;
}

export function buildLine(
  track: TrackModel,
  corridor: Corridor | undefined,
  params: SimParams,
  fallbackHalfWidthM = 5,
): Line {
  const cl = track.centerline;
  const n = cl.length;
  const stepM = track.lengthM / Math.max(1, n);
  const margin = params.tyre.kerbMarginM;

  // box constraints: hi = how far left, lo = how far right (negative)
  const hiM = new Float32Array(n);
  const loM = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const useCorridor = corridor && corridor.known[i] && Number.isFinite(corridor.leftM[i]);
    const l = useCorridor ? corridor.leftM[i] : fallbackHalfWidthM;
    const r = useCorridor ? corridor.rightM[i] : fallbackHalfWidthM;
    // leave half a bike's width inside the edge, then allow the kerb margin
    hiM[i] = Math.max(0, l - 0.4) + margin;
    loM[i] = -(Math.max(0, r - 0.4) + margin);
  }

  const baseCurv = polylineCurvature(cl, 10);
  const d = solveOffsets(n, stepM, baseCurv, loM, hiM, params.rider.kappa);

  // rider wander: a deterministic smooth deviation, clamped back into the box
  const dev = params.rider.lineDeviationM;
  if (dev > 0) {
    for (let i = 0; i < n; i++) {
      const w = d[i] + dev * 1.4 * wander(i, n, 1);
      d[i] = Math.min(hiM[i], Math.max(loM[i], w));
    }
  }

  // Shared ~10 m tangent stencil with the corridor extractor and renderer
  // (src/sim/corridor.ts) — a third, divergent normal calculation here caused
  // a real bug at hairpins in an earlier task.
  const k = stencilK(track);
  const points: LngLat[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const [nx, ny] = stencilLeftNormal(cl, i, k);
    points[i] = fromLocalM(cl[i], [nx * d[i], ny * d[i]]);
  }

  const cumDistM = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const m = toLocalM(points[i - 1], points[i]);
    cumDistM[i] = cumDistM[i - 1] + Math.hypot(m[0], m[1]);
  }
  const closing = toLocalM(points[n - 1], points[0]);
  const lengthM = cumDistM[n - 1] + Math.hypot(closing[0], closing[1]);

  return { points, curvature: polylineCurvature(points, 10), cumDistM, lengthM, offsetM: d };
}

/** Variance of |curvature| — low means the turn is spread out, high means squared off. */
export function curvatureVariance(line: Line): number {
  const k = line.curvature;
  if (!k.length) return 0;
  let mean = 0;
  for (let i = 0; i < k.length; i++) mean += Math.abs(k[i]);
  mean /= k.length;
  let v = 0;
  for (let i = 0; i < k.length; i++) v += (Math.abs(k[i]) - mean) ** 2;
  return v / k.length;
}
