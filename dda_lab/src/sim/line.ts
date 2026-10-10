// The racing line, parameterised by kappa: the standard minimum-curvature /
// minimum-distance blend.
//
// kappa = 0 is the corner-speed ("C") line: MINIMUM CURVATURE, which spreads
// the direction change over the widest possible arc and so allows the highest
// cornering speed.
// kappa = 1 is the point-and-shoot ("V") line: MINIMUM DISTANCE, the shortest
// path through the corridor. It cuts to the inside of the bend, which
// concentrates the direction change into a short zone and straightens what is
// either side of it — what a powerful bike wants, because it can recover the
// lost apex speed on the exit.
//
// kappa = 0.5 is the midpoint of the blend, which is pure smoothing: the two
// objectives' targets are equal and opposite there and cancel exactly.
//
// Both ends are averaging (diffusive) operators, so the Gauss-Seidel sweep is
// unconditionally stable at every kappa — the corridor clamp bounds the line
// because the corridor is a real constraint, not because the iteration would
// otherwise blow up. An earlier revision used an "anti-diffusion sharpening"
// term for the V end, which diverged for kappa > ~0.70 and made the shipped
// default (0.85) produce a saw-tooth rather than a line; see task-6-report.md.
import { fromLocalM, toLocalM } from '../core/geo';
import type { LngLat, TrackModel } from '../core/types';
import { stencilK, stencilLeftNormal } from './corridor';
import type { Corridor, Line, SimParams } from './types';

/** Gauss-Seidel sweeps. 60 converges on a 2 m grid and stays well under 1 ms. */
const SWEEPS = 60;
/** Relaxation factor; over-relaxation above 1 converges faster but oscillates. */
const OMEGA = 0.6;

/** Deterministic smooth pseudo-noise in [-1,1]: the same params give the same line. */
function wander(i: number, n: number, seed: number): number {
  let s = 0;
  for (let h = 1; h <= 3; h++) {
    s += Math.sin((2 * Math.PI * h * i) / n + seed * h * 1.7) / h;
  }
  return s / 1.833; // normalise 1 + 1/2 + 1/3
}

/**
 * Lateral offsets that blend the minimum-curvature and minimum-distance
 * objectives by `kappa`, subject to the corridor as a hard box constraint.
 *
 * KNOWN LIMITATION: at `SWEEPS` = 60 this is deliberately a SHORT-RANGE
 * operator. Gauss-Seidel at OMEGA = 0.6 diffuses roughly sqrt(SWEEPS) ~ 8
 * vertices (~16 m at a 2 m spacing), so the offsets form a boundary layer
 * around each curvature feature rather than a lap-wide optimum: a corner gets
 * its wide or tight line, but the line returns to the centre along a long
 * straight instead of setting up for the next corner from a hundred metres
 * out. That is intentional for now. Minimising curvature around a CLOSED loop
 * has no bounded solution (you cannot straighten a circle), so the uniform
 * offset is an unconstrained zero mode of this operator: raising SWEEPS to
 * 1000 does not converge on a better line, it drives the whole lap onto one
 * wall of the corridor (measured: max|offset| saturates at the 6.1 m box on a
 * 977 m oval). Fixing that properly needs the mean offset pinned — a gauge
 * condition on the zero mode — not more iterations.
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
  // Curvature of the offset line, to first order:  k_eff = k0 - d'' (with d
  // measured positive to the left of travel). Minimising sum(k_eff^2) gives
  // the stationarity condition  d'' = k0, i.e. in discrete form
  //
  //   d[i] = (d[i-1] + d[i+1])/2 + k0[i]*h^2/2        (minimum curvature)
  //
  // which is a smoothing of d, so it always spreads a bend over the widest
  // arc the corridor will allow — the C line.
  //
  // Minimum distance is the SAME operator with the curvature target's sign
  // flipped: where minimum curvature pushes the line away from the inside of
  // the bend to straighten it out, the shortest path pulls it towards the
  // inside, which is what concentrates the direction change — the V line.
  //
  // One blend parameter covers both, and kappa = 0.5 (pure smoothing) sits
  // exactly halfway. The checkerboard (highest-frequency) gain of the sweep
  // is |1 - 2*OMEGA| = 0.2 at every kappa, so this cannot diverge.
  const h2 = stepM * stepM;
  // SIGN: d is positive to the LEFT of travel, so for a left-hand bend
  // (k0 > 0) a positive offset moves the line to the INSIDE. Minimum distance
  // is the inside line, so the forcing must be positive at kappa = 1 and
  // negative at kappa = 0 — measured on a counterclockwise 60 m circle with a
  // 6 m corridor, this sign gives r_min 60.53 m / 387.4 m of line at kappa = 0
  // against 57.07 m / 365.7 m at kappa = 1, and the opposite sign reverses
  // both orderings exactly.
  const curvSign = 2 * kappa - 1;
  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    for (let i = 0; i < n; i++) {
      const p = d[(i - 1 + n) % n];
      const q = d[(i + 1) % n];
      const target = (p + q) / 2 + (curvSign * (baseCurv[i] * h2)) / 2;
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
  // Spacing averaged over the WHOLE closed loop, not the first few segments:
  // centerline sampling density varies around a lap (GPS rate against speed),
  // so a stencil sized from the start straight is the wrong physical length
  // everywhere else. This is the same lap-wide average `stencilK` in
  // corridor.ts takes, expressed over the polyline's own vertices because
  // `points` here may be the offset line rather than the centerline.
  let span = 0;
  for (let i = 0; i < n; i++) {
    const m = toLocalM(points[i], points[(i + 1) % n]);
    span += Math.hypot(m[0], m[1]);
  }
  const ds = span / n;
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

/**
 * Usable half-widths at every vertex, with the corridor's unknown vertices
 * filled in from their nearest known neighbours.
 *
 * A flat `fallbackHalfWidthM` at every unknown vertex is wrong whenever the
 * fallback is wider than the circuit: on a 2-3 m corridor with 35 % of
 * vertices unknown (the real circuit's figure) it lets the line run metres
 * outside the asphalt that WAS measured either side of the gap. Interpolating
 * between the nearest known vertex before and after keeps the gap's width
 * continuous with its surroundings; the flat fallback is only reached when the
 * corridor has no usable vertex at all.
 *
 * A non-finite stored width counts as unknown even where `known[i]` says
 * otherwise, on EITHER side — `buildLine` is public and takes a plain
 * `Corridor`, so a NaN must degrade to "unknown", not propagate into the box.
 */
export function effectiveHalfWidths(
  n: number,
  corridor: Corridor | undefined,
  fallbackHalfWidthM: number,
): { leftM: Float32Array; rightM: Float32Array } {
  const leftM = new Float32Array(n);
  const rightM = new Float32Array(n);
  const usable = new Array<boolean>(n);
  let anyUsable = false;
  for (let i = 0; i < n; i++) {
    usable[i] =
      !!corridor &&
      corridor.known[i] === true &&
      Number.isFinite(corridor.leftM[i]) &&
      Number.isFinite(corridor.rightM[i]);
    if (usable[i]) anyUsable = true;
  }
  if (!corridor || !anyUsable) {
    leftM.fill(fallbackHalfWidthM);
    rightM.fill(fallbackHalfWidthM);
    return { leftM, rightM };
  }
  // nearest usable vertex at or before / at or after i, wrapping (two rounds
  // so a gap that straddles index 0 sees across it)
  const prev = new Int32Array(n);
  const next = new Int32Array(n);
  let last = -1;
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < n; i++) {
      if (usable[i]) last = i;
      if (round === 1) prev[i] = last;
    }
  }
  last = -1;
  for (let round = 0; round < 2; round++) {
    for (let i = n - 1; i >= 0; i--) {
      if (usable[i]) last = i;
      if (round === 1) next[i] = last;
    }
  }
  for (let i = 0; i < n; i++) {
    if (usable[i]) {
      leftM[i] = corridor.leftM[i];
      rightM[i] = corridor.rightM[i];
      continue;
    }
    const a = prev[i];
    const b = next[i];
    const dA = (i - a + n) % n;
    const dB = (b - i + n) % n;
    const w = dA + dB > 0 ? dA / (dA + dB) : 0;
    leftM[i] = corridor.leftM[a] * (1 - w) + corridor.leftM[b] * w;
    rightM[i] = corridor.rightM[a] * (1 - w) + corridor.rightM[b] * w;
  }
  return { leftM, rightM };
}

export function buildLine(
  track: TrackModel,
  corridor: Corridor | undefined,
  params: SimParams,
  fallbackHalfWidthM = 5,
): Line {
  const cl = track.centerline;
  const n = cl.length;
  // n - 1, matching `stencilK`'s and `extractCorridor`'s step for the same
  // quantity — three copies of this had drifted to two different divisors.
  const stepM = track.lengthM / Math.max(1, n - 1);
  const margin = params.tyre.kerbMarginM;

  const { leftM: effLeft, rightM: effRight } = effectiveHalfWidths(n, corridor, fallbackHalfWidthM);

  // box constraints: hi = how far left, lo = how far right (negative)
  const hiM = new Float32Array(n);
  const loM = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // leave half a bike's width inside the edge, then allow the kerb margin
    hiM[i] = Math.max(0, effLeft[i] - 0.4) + margin;
    loM[i] = -(Math.max(0, effRight[i] - 0.4) + margin);
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
