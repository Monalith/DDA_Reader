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
import { movingAverage } from '../core/filters';
import type { LngLat, TrackModel } from '../core/types';
import type { Corridor, Line, SimParams } from './types';


/** Gauss-Seidel sweeps. 60 converges on a 2 m grid and stays well under 1 ms. */
const SWEEPS = 60;
/** Relaxation factor; over-relaxation above 1 converges faster but oscillates. */
const OMEGA = 0.6;
/** Half-length of the curvature stencil, metres. */
const CURV_STENCIL_M = 20;

function leftNormal(cl: LngLat[], i: number, k = 1): [number, number] {
  const n = cl.length;
  const a = cl[(i - k + n) % n];
  const b = cl[(i + k) % n];
  const am = toLocalM(cl[i], a);
  const bm = toLocalM(cl[i], b);
  const tx = bm[0] - am[0];
  const ty = bm[1] - am[1];
  const len = Math.hypot(tx, ty);
  return len < 1e-9 ? [0, 0] : [-ty / len, tx / len];
}

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
  // Minimising sum(k_eff^2) is a smoothing of d towards k0 * stepM^2.
  // The V objective trades the curvature penalty for a shortness penalty, which
  // pulls the line towards the inside of the corner and concentrates the turn.
  const wCurv = 1 - 0.85 * kappa;
  const wShort = 0.85 * kappa;
  const h2 = stepM * stepM;
  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    for (let i = 0; i < n; i++) {
      const p = d[(i - 1 + n) % n];
      const q = d[(i + 1) % n];
      // curvature term wants  d[i] = (p + q)/2 + k0*h^2/2
      const curvTarget = (p + q) / 2 + (baseCurv[i] * h2) / 2;
      // shortness term wants the line pulled to the inside of the bend.
      // Offsets are measured along the LEFT normal, so for a left turn
      // (positive curvature) the inside is the positive side.
      // (The plan had these the other way round, which pulls the line to the
      // OUTSIDE and so lengthens the radius instead of squaring the corner off.)
      const shortTarget = baseCurv[i] >= 0 ? hiM[i] : loM[i];
      const target = (wCurv * curvTarget + wShort * shortTarget) / (wCurv + wShort);
      const next = d[i] + OMEGA * (target - d[i]);
      d[i] = Math.min(hiM[i], Math.max(loM[i], next));
    }
  }
  return d;
}

/**
 * Curvature a rider actually steers to. GPS-built centerlines wobble by about a
 * metre over tens of metres, which reads as R ≈ 150 m "bends" on dead straights
 * and caps the simulated top speed at ~170 km/h. A longer moving average plus a
 * small dead band removes that floor; real corners (R < 100 m) barely notice.
 */
const CURV_SMOOTH_SAMPLES = 15;
const CURV_DEAD_BAND = 0.0025; // 1/m — R 400 m and gentler is treated as straight
function riderCurvature(points: LngLat[]): Float32Array {
  const k = movingAverage(polylineCurvature(points, CURV_STENCIL_M), CURV_SMOOTH_SAMPLES);
  for (let i = 0; i < k.length; i++) {
    const a = Math.abs(k[i]);
    if (a <= CURV_DEAD_BAND) k[i] = 0; // a hard gate: real corners keep their exact curvature
  }
  return k;
}

/** Closed-loop moving average of positions (local metres around each point). */
function smoothPositions(cl: LngLat[], win: number): LngLat[] {
  const n = cl.length;
  const h = win >> 1;
  return cl.map((c, i) => {
    let x = 0;
    let y = 0;
    for (let j = -h; j <= h; j++) {
      const m = toLocalM(c, cl[(i + j + n) % n]);
      x += m[0];
      y += m[1];
    }
    return fromLocalM(c, [x / win, y / win]);
  });
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
    // Third side of the triangle prev-cur-next: prev -> next, i.e. a + b.
    // (The plan wrote `b - a` here, which collapses to ~0 on a straight line
    // and makes the circumscribed-circle formula blow up to 2/stencil.)
    const lc = Math.hypot(ax + bx, ay + by);
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
  const n = track.centerline.length;
  const stepM = track.lengthM / Math.max(1, n);
  // ~30 m position smoothing takes the GPS jitter out of the geometry itself
  const cl = smoothPositions(track.centerline, Math.max(1, Math.round(30 / Math.max(0.1, stepM)) | 1));
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

  // GPS centerlines at 2 m are noisy: a 20 m stencil plus a short moving average
  // gives the curvature a rider actually feels, not the jitter of the fix.
  const baseCurv = riderCurvature(cl);
  const d = solveOffsets(n, stepM, baseCurv, loM, hiM, params.rider.kappa);

  // rider wander: a deterministic smooth deviation, clamped back into the box
  const dev = params.rider.lineDeviationM;
  if (dev > 0) {
    for (let i = 0; i < n; i++) {
      const w = d[i] + dev * 1.4 * wander(i, n, 1);
      d[i] = Math.min(hiM[i], Math.max(loM[i], w));
    }
  }

  // GPS centerlines are noisy at 2 m spacing: take the normal over a +-10 m stencil
  // and smooth the offsets along the track, or the line zig-zags (a 35 % longer lap).
  const kN = Math.max(1, Math.round(CURV_STENCIL_M / Math.max(0.1, stepM)));
  const win = Math.max(1, Math.round(30 / Math.max(0.1, stepM)) | 1);
  const half = win >> 1;
  const dSmooth = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let j = -half; j <= half; j++) acc += d[(i + j + n) % n];
    dSmooth[i] = Math.min(hiM[i], Math.max(loM[i], acc / win));
  }
  d.set(dSmooth);

  const points: LngLat[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const [nx, ny] = leftNormal(cl, i, kN);
    points[i] = fromLocalM(cl[i], [nx * d[i], ny * d[i]]);
  }

  const cumDistM = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const m = toLocalM(points[i - 1], points[i]);
    cumDistM[i] = cumDistM[i - 1] + Math.hypot(m[0], m[1]);
  }
  const closing = toLocalM(points[n - 1], points[0]);
  const lengthM = cumDistM[n - 1] + Math.hypot(closing[0], closing[1]);

  return { points, curvature: riderCurvature(points), cumDistM, lengthM, offsetM: d };
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
