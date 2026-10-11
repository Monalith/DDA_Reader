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
// kappa weights the two objectives in ONE quadratic (see `relax`), which is
// minimised by projected Gauss-Seidel on a coarse-to-fine grid hierarchy (see
// `solveOffsets`). The corridor clamp bounds the line because the corridor is a
// real constraint, not because the iteration would otherwise blow up: the
// functional is positive definite at every kappa.
//
// Two earlier revisions are worth knowing about, both in task-6-report.md: one
// used an "anti-diffusion sharpening" term for the V end which diverged above
// kappa ~ 0.70, and one linearised the offset line's curvature as `k0 + d''`,
// which makes a constant offset free and so has an unconstrained zero mode —
// that is what forced the solve to be stopped after 60 sweeps, and stopping it
// there is what limited the line's horizon to about 16 m.
import { fromLocalM, toLocalM } from '../core/geo';
import type { LngLat, TrackModel } from '../core/types';
import { stencilK, stencilLeftNormal } from './corridor';
import type { Corridor, Line, SimParams } from './types';

/** Gauss-Seidel smoothing sweeps per multigrid level. */
const SWEEPS = 60;
/** Relaxation factor; over-relaxation above 1 converges faster but oscillates. */
const OMEGA = 0.6;
/**
 * Coarsen until the grid is no bigger than this. 24 vertices is small enough
 * that a direct-ish relaxation (m^2 sweeps, ~600, over 24 points) is free, and
 * that level is where the lap-wide shape of the line is actually decided.
 */
const COARSEST_N = 24;

/** Deterministic smooth pseudo-noise in [-1,1]: the same params give the same line. */
function wander(i: number, n: number, seed: number): number {
  let s = 0;
  for (let h = 1; h <= 3; h++) {
    s += Math.sin((2 * Math.PI * h * i) / n + seed * h * 1.7) / h;
  }
  return s / 1.833; // normalise 1 + 1/2 + 1/3
}

/**
 * Projected Gauss-Seidel on the normal equations of
 *
 *   J(d) = (1 - kappa) * sum_i k_eff[i]^2  -  kappa * DIST_GAIN * sum_i k0[i]*d[i]
 *   k_eff[i] = k0[i] + d''[i] + k0[i]^2 * d[i]
 *
 * clamped into `[lo, hi]` after every update, so the corridor is a hard
 * constraint rather than a post-hoc trim.
 *
 * THE `k0^2 * d` TERM IS THE WHOLE POINT. The linearisation an earlier
 * revision used stopped at `k_eff = k0 + d''`, under which a CONSTANT offset
 * costs nothing — that is the unconstrained zero mode the previous report
 * identified, and it is why the iteration had to be stopped after 60 sweeps.
 * Pinning the mean offset (a gauge) removes the zero mode but leaves the
 * operator saying that running 6 m inside a 25 m hairpin is free, so a
 * converged solve then pins the line to the inside wall through every corner
 * (measured: hairpin radius 25 m -> 18.9 m, i.e. exactly `r - halfWidth`).
 * The `k0^2 * d` term is the missing physics: it says a given offset changes
 * the radius in proportion to how tight the bend already is, which is what
 * makes hugging the inside of a slow corner expensive and leaves the corridor
 * free to be spent on the fast one. With it in, the functional has no null
 * space and needs no gauge.
 *
 * The second difference term makes this a fourth-order (biharmonic-like)
 * problem, so pointwise Gauss-Seidel alone would need O(m^4) sweeps. The
 * coarse-to-fine schedule in `solveOffsets` is what makes it affordable.
 *
 * `distPull` is the minimum-distance gradient, already multiplied by kappa.
 */
function relax(
  d: Float32Array,
  m: number,
  spacingM: number,
  k0: Float32Array,
  distPull: Float32Array,
  wCurv: number,
  lo: Float32Array,
  hi: Float32Array,
  sweeps: number,
): void {
  const h2 = spacingM * spacingM;
  const invh2 = 1 / h2;
  const K = new Float32Array(m);
  const A = new Float32Array(m);
  for (let i = 0; i < m; i++) A[i] = k0[i] * k0[i] - 2 * invh2;
  const recompute = (): void => {
    for (let i = 0; i < m; i++) {
      K[i] = k0[i] + (d[(i - 1 + m) % m] - 2 * d[i] + d[(i + 1) % m]) * invh2 + k0[i] * k0[i] * d[i];
    }
  };
  recompute();
  for (let s = 0; s < sweeps; s++) {
    for (let i = 0; i < m; i++) {
      const im = (i - 1 + m) % m;
      const ip = (i + 1) % m;
      // half the gradient of J with respect to d[i]
      const grad = wCurv * ((K[im] + K[ip]) * invh2 + K[i] * A[i]) - distPull[i];
      // the diagonal of the normal matrix: d(grad)/d(d[i])
      const diag = wCurv * (2 * invh2 * invh2 + A[i] * A[i]) + 1e-9;
      const want = d[i] - OMEGA * (grad / diag);
      const next = Math.min(hi[i], Math.max(lo[i], want));
      const delta = next - d[i];
      if (delta !== 0) {
        d[i] = next;
        K[im] += delta * invh2;
        K[ip] += delta * invh2;
        K[i] += delta * A[i];
      }
    }
  }
}

/**
 * Decimation strides, coarsest first, ending at 1 (the full grid). Each level
 * halves the vertex count until the grid is at most `COARSEST_N` across.
 */
export function strideSchedule(n: number): number[] {
  const out = [1];
  let s = 1;
  while (Math.ceil(n / (s * 2)) >= COARSEST_N) {
    s *= 2;
    out.push(s);
  }
  return out.reverse();
}

/**
 * How hard the minimum-distance objective pulls at kappa = 1, relative to the
 * curvature objective. Minimum distance is `sum(-k0*d)` whose gradient is a
 * constant pull toward the inside of each bend; the gain converts it into the
 * same units as the curvature gradient (1/m^3). Tuned so that at kappa = 1 the
 * line reaches the inside edge through a corner — which is what minimum
 * distance means — without the intermediate kappas being bang-bang.
 */
const DIST_GAIN = 2e-4;

/**
 * Lateral offsets that blend the minimum-curvature and minimum-distance
 * objectives by `kappa`, subject to the corridor as a hard box constraint.
 *
 * `relax` explains the functional. What makes this a LAP-WIDE solve rather
 * than the ~16 m boundary layer an earlier revision produced is the
 * coarse-to-fine (cascadic multigrid) schedule: a fourth-order problem solved
 * by pointwise Gauss-Seidel propagates information about one vertex per sweep,
 * so a lap-wide answer on a 1500-vertex grid is unreachable at any sweep count
 * that keeps the UI live. Instead the problem is restricted onto a
 * ~24-vertex grid and solved there — where "lap-wide" is 24 points away — and
 * the solution is interpolated down level by level with `SWEEPS` smoothing
 * sweeps at each. The cost is about twice one full-grid sweep block, and it is
 * what lets the line set up for a corner from hundreds of metres out instead
 * of arriving at it on the centreline.
 */
function solveOffsets(
  n: number,
  stepM: number,
  baseCurv: Float32Array,
  loM: Float32Array,
  hiM: Float32Array,
  kappa: number,
): Float32Array {
  const wCurv = Math.max(1e-3, 1 - kappa);
  const pull = new Float32Array(n);
  // d is positive to the LEFT of travel, so for a left-hand bend (k0 > 0) a
  // positive offset is the INSIDE: the shortest path's gradient is +k0.
  for (let i = 0; i < n; i++) pull[i] = kappa * DIST_GAIN * baseCurv[i];

  let d = new Float32Array(0);
  let prevStride = 0;
  for (const stride of strideSchedule(n)) {
    const m = Math.ceil(n / stride);
    // spacing of THIS level, so the h^2 in the stencil scales with the grid
    const spacingM = (stepM * n) / m;
    const k0c = new Float32Array(m);
    const pullc = new Float32Array(m);
    const lo = new Float32Array(m);
    const hi = new Float32Array(m);
    for (let j = 0; j < m; j++) {
      const from = j * stride;
      const to = Math.min(n, from + stride);
      let kAcc = 0;
      let pAcc = 0;
      let l = loM[from];
      let h = hiM[from];
      for (let t = from; t < to; t++) {
        kAcc += baseCurv[t];
        pAcc += pull[t];
        // the tightest box in the group, so a coarse level can never commit to
        // an offset that a pinch point inside it does not allow
        l = Math.max(l, loM[t]);
        h = Math.min(h, hiM[t]);
      }
      const cnt = Math.max(1, to - from);
      k0c[j] = kAcc / cnt;
      pullc[j] = pAcc / cnt;
      lo[j] = Math.min(0, l);
      hi[j] = Math.max(0, h);
    }
    const dc = new Float32Array(m);
    if (prevStride > 0) {
      // prolongation: linear interpolation of the coarser solution, wrapping
      const pm = d.length;
      for (let j = 0; j < m; j++) {
        const t = (j * stride) / prevStride;
        const a = Math.floor(t) % pm;
        const w = t - Math.floor(t);
        dc[j] = d[a] * (1 - w) + d[(a + 1) % pm] * w;
      }
    }
    // The coarsest level has no better initial guess than zero, so it is the
    // one level that has to be solved rather than smoothed: m^2 sweeps is what
    // periodic Gauss-Seidel needs for the longest mode, and over ~24 points
    // that is a few hundred updates.
    relax(dc, m, spacingM, k0c, pullc, wCurv, lo, hi, prevStride === 0 ? m * m : SWEEPS);
    d = dc;
    prevStride = stride;
  }
  return d;
}

/**
 * Centred moving average of a closed array over `halfWin` samples either side,
 * in O(n) via a prefix sum.
 *
 * Applied to curvature this is conservative in the one way that matters: a
 * moving average preserves the SUM, so a corner keeps its total direction
 * change and the lap still closes. It costs the sharpness of a corner's entry
 * and exit over the window length, and nothing else.
 */
export function smoothClosed(a: Float32Array, halfWin: number): Float32Array {
  const n = a.length;
  const w = Math.min(Math.floor((n - 1) / 2), Math.max(0, Math.round(halfWin)));
  if (w < 1 || n < 3) return a;
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + a[i];
  const total = pre[n];
  const out = new Float32Array(n);
  const span = 2 * w + 1;
  for (let i = 0; i < n; i++) {
    const lo = i - w;
    const hi = i + w + 1; // exclusive
    let sum: number;
    if (lo < 0) sum = pre[hi] + (total - pre[n + lo]);
    else if (hi > n) sum = total - pre[lo] + pre[hi - n];
    else sum = pre[hi] - pre[lo];
    out[i] = sum / span;
  }
  return out;
}

/**
 * The length scale curvature is measured over, metres: both the half-width of
 * the three-point stencil and the half-window of the moving average applied
 * to its output.
 *
 * The three-point circumradius over a +/-L stencil turns a lateral position
 * error of e into a curvature error of roughly 2e/L^2, so a centerline that
 * wanders by e reports a spurious radius of L^2/(2e) everywhere — an apparent
 * 200 m radius IN THE MIDDLE OF A STRAIGHT at L = 10 m and e = 0.25 m. The
 * lateral limit `v <= sqrt(a_lat*r)` then caps the straight, and the backward
 * and forward passes cannot recover: that is both the "straight is 50 km/h
 * slow" symptom and the origin of the throttle/brake chattering, since a noisy
 * `v` is a `longG` that changes sign every few metres.
 *
 * 20 m is MEASURED against the real BMW Serres lap rather than estimated — see
 * docs/superpowers/notes/2026-10-10-virtual-vs-real.md. The two bounds:
 *
 *   - LOWER. The real lap's speed is measured; its geometry is not. Taking the
 *     measured speed against the curvature this function reports gives the
 *     lateral acceleration the geometry CLAIMS the rider produced. At L = 10 m
 *     that is 2.85 g at the 99th percentile and 5.7 g at the peak, over 464 m
 *     of the lap above 1.6 g — impossible on any tyre, so at 10 m this
 *     function is reporting noise, not corners. The figure falls to 2.00 g
 *     (p99) at 20 m and 1.74 g at 40 m.
 *   - UPPER. Past ~25 m the tight corners inflate: the reported radius through
 *     the two hairpins rises above what their measured apex speeds can produce
 *     even at the tyre's limit (29 m implied against 36 m reported at 25 m of
 *     smoothing), and the simulated lap starts beating the real one through
 *     every slow corner — a lap the bike cannot ride.
 *
 * Costs nothing on a clean centerline: on the synthetic circuit with 0.25 m of
 * scatter the 25 m hairpin reads 25.1 m at L = 20 against 24.1 m at L = 10
 * (true value 25), and the 250 m sweeper 246 m against 253 m.
 *
 * This is a property of the DATA, not of the bike, and the real circuit's
 * centerline here is a hand-placed map polyline with +-15-20 m of stated
 * positional accuracy whose error is LONG-WAVELENGTH: its local (2 m baseline)
 * scatter measures 0.07 m, a third of the synthetic fixture's, while its
 * residual against a 40 m mean is 2.6 m rms. Nothing local can size this
 * window, which is why it is a constant and not an estimate off the trace.
 */
const CURV_SCALE_M = 20;

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
  return smoothClosed(out, CURV_SCALE_M / Math.max(0.1, ds));
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

  const baseCurv = polylineCurvature(cl, CURV_SCALE_M);
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

  return {
    points,
    curvature: polylineCurvature(points, CURV_SCALE_M),
    cumDistM,
    lengthM,
    offsetM: d,
    // no elevation data yet (spec v2 §2.3): flat road, explicitly
    slopeRad: new Float32Array(n),
    bankRad: new Float32Array(n),
    nu: new Float32Array(n),
  };
}
