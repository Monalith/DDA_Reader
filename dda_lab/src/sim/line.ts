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
// kappa weights the two objectives in ONE quadratic (see `solveOffsets`),
// which is minimised EXACTLY as a box-constrained QP (src/sim/lineQp.ts): the
// corridor, widened by the kerb allowance `tyre.kerbM`, is a hard bound.
//
// Three earlier revisions are worth knowing about. The last minimised the same
// functional by projected Gauss-Seidel on a coarse-to-fine grid hierarchy and
// never converged it — the line stopped metres short of the edges (see
// `solveOffsets`). Two more are worth knowing about, both in task-6-report.md: one
// used an "anti-diffusion sharpening" term for the V end which diverged above
// kappa ~ 0.70, and one linearised the offset line's curvature as `k0 + d''`,
// which makes a constant offset free and so has an unconstrained zero mode —
// that is what forced the solve to be stopped after 60 sweeps, and stopping it
// there is what limited the line's horizon to about 16 m.
import { fromLocalM, toLocalM } from '../core/geo';
import type { LngLat, TrackModel } from '../core/types';
import { stencilK, stencilLeftNormal } from './corridor';
import { applyAt, normalPenta, solveBoxQp } from './lineQp';
import { DEFAULT_KERB_M } from './presets';
import type { Corridor, Line, SimParams } from './types';

/** Deterministic smooth pseudo-noise in [-1,1]: the same params give the same line. */
function wander(i: number, n: number, seed: number): number {
  let s = 0;
  for (let h = 1; h <= 3; h++) {
    s += Math.sin((2 * Math.PI * h * i) / n + seed * h * 1.7) / h;
  }
  return s / 1.833; // normalise 1 + 1/2 + 1/3
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
 * Gauss-Newton passes on the EXACT offset-curve curvature (see `offsetCurv`).
 * The first pass uses the small-slope linearisation `k0 + k0^2 d + d''`;
 * every later one re-linearises the exact curvature about the previous line.
 * Stops early once no station moves by more than `GN_TOL_M`.
 */
const GN_PASSES = 8;
const GN_TOL_M = 0.01;

/**
 * Exact curvature of the offset curve p = c + d n off a centreline of
 * curvature k0 (derivative k0p), parameterised by centreline arc length s,
 * with d, d' = d1, d'' = d2 — and the line's arc-length element |p'|:
 *
 *   k = [(1 - k0 d)(k0 (1 - k0 d) + d'') + d' (k0' d + 2 k0 d')] / D^(3/2),
 *   D = (1 - k0 d)^2 + d'^2,  |p'| = sqrt(D).
 *
 * The small-slope linearisation `k0 + k0^2 d + d''` drops the d'^2 terms,
 * which are NOT small where a line crosses the track into a corner: at the
 * 25-30 % slope of a full-width entry they overstate the crossing's curvature
 * by 20-30 % and the line then refuses to cross far enough to reach the apex.
 */
function offsetCurv(k0: number, k0p: number, d: number, d1: number, d2: number): number {
  const u = 1 - k0 * d;
  const D = u * u + d1 * d1;
  return (u * (k0 * u + d2) + d1 * (k0p * d + 2 * k0 * d1)) / (D * Math.sqrt(D));
}

/**
 * Lateral offsets that blend the minimum-curvature and minimum-distance
 * objectives by `kappa`, subject to the corridor as a hard box constraint:
 *
 *   minimise  (1 - kappa)/2 * sum_i k[i]^2 |p'[i]|  -  kappa * DIST_GAIN * sum_i k0[i] d[i]
 *   k[i] = exact curvature of the offset line (`offsetCurv`), |p'| its arc-length element
 *   lo[i] <= d[i] <= hi[i]
 *
 * — the "mincurv" formulation (Heilmeier et al. 2019, TUMFTM
 * global_racetrajectory_optimization): offsets along each station's normal,
 * curvature linearised in the offsets, a bounded QP per linearisation, and
 * re-linearisation about the new line (their "mincurv_iqp"). Each QP is solved
 * to optimality (projected Newton with a periodic banded direct solve,
 * src/sim/lineQp.ts); the passes are Gauss-Newton steps on the exact
 * objective, damped if one would raise it.
 *
 * The `k0^2 d` part of the curvature is what says a given offset changes the
 * radius in proportion to how tight the bend already is (without it a
 * constant offset is free and the solve pins the line to the inside of every
 * corner). The `d''` part makes the problem fourth order.
 *
 * WHY THIS REPLACED THE GAUSS-SEIDEL LINE (notes/2026-10-11-bmw-fit-pist-line.md
 * §6). The previous revision minimised the SMALL-SLOPE functional
 * `k = k0 + k0^2 d + d''` by projected Gauss-Seidel on a coarse-to-fine grid.
 * Two things kept it off the apexes, and the second is the big one:
 *   - the iteration was not converged (its objective 1.6 % above the exact
 *     optimum of the same functional on the pist Serres corridor);
 *   - the small-slope functional itself is wrong where the line crosses the
 *     track: dropping the d'^2 terms overstates a full-width entry's curvature
 *     by 20-30 %, so even its EXACT optimum refuses to cross. On a 12 m
 *     corridor with a 90° corner it stops 2.0 m inside the centreline at the
 *     apex (of 5.6 m available; the old solve 1.6 m); the exact-curvature
 *     solve touches the inside edge and the outside on both straights.
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
  const invh2 = 1 / (stepM * stepM);
  const lo = Float64Array.from(loM);
  const hi = Float64Array.from(hiM);
  for (let i = 0; i < n; i++) {
    // a box that excludes the centreline (a pinch narrower than the bike) is
    // widened to include it, as before: never infeasible
    lo[i] = Math.min(0, lo[i]);
    hi[i] = Math.max(0, hi[i]);
  }
  const h = stepM;
  const k0p = new Float64Array(n);
  for (let i = 0; i < n; i++) k0p[i] = (baseCurv[(i + 1) % n] - baseCurv[(i - 1 + n) % n]) / (2 * h);
  const a = new Float64Array(n);
  const b = new Float64Array(n);
  const e = new Float64Array(n);
  const beta = new Float64Array(n);
  const c = new Float64Array(n);
  const pull = new Float64Array(n);
  // d is positive to the LEFT of travel, so for a left-hand bend (k0 > 0) a
  // positive offset is the INSIDE: the shortest path's gradient is +k0.
  for (let i = 0; i < n; i++) pull[i] = kappa * DIST_GAIN * baseCurv[i];
  const derivs = (d: Float64Array, i: number): [number, number] => {
    const dm = d[(i - 1 + n) % n];
    const dp = d[(i + 1) % n];
    return [(dp - dm) / (2 * h), (dp - 2 * d[i] + dm) * invh2];
  };
  // the exact objective the passes descend: sum of k^2 over the LINE's arc
  // length (centreline step times |p'|), minus the distance pull
  const objective = (d: Float64Array): number => {
    let f = 0;
    for (let i = 0; i < n; i++) {
      const [d1, d2] = derivs(d, i);
      const u = 1 - baseCurv[i] * d[i];
      const k = offsetCurv(baseCurv[i], k0p[i], d[i], d1, d2);
      f += 0.5 * wCurv * k * k * Math.sqrt(u * u + d1 * d1) - pull[i] * d[i];
    }
    return f;
  };
  let d: Float64Array = new Float64Array(n);
  let fPrev = Infinity;
  for (let pass = 0; pass < GN_PASSES; pass++) {
    for (let i = 0; i < n; i++) {
      const k0 = baseCurv[i];
      if (pass === 0) {
        // small-slope linearisation about the centreline: k = k0 + A d
        a[i] = invh2;
        e[i] = invh2;
        b[i] = k0 * k0 - 2 * invh2;
        beta[i] = k0;
        continue;
      }
      // Gauss-Newton: k(d) ~ k(d_c) + J (d - d_c), J tridiagonal through
      // (d, d', d''); each row weighted by sqrt(|p'|) so the squares sum
      // over the line's own arc length
      const [d1, d2] = derivs(d, i);
      const x = d[i];
      const kc = offsetCurv(k0, k0p[i], x, d1, d2);
      const eps = 1e-4;
      const kd = (offsetCurv(k0, k0p[i], x + eps, d1, d2) - offsetCurv(k0, k0p[i], x - eps, d1, d2)) / (2 * eps);
      const k1 = (offsetCurv(k0, k0p[i], x, d1 + eps, d2) - offsetCurv(k0, k0p[i], x, d1 - eps, d2)) / (2 * eps);
      const k2 = (offsetCurv(k0, k0p[i], x, d1, d2 + eps) - offsetCurv(k0, k0p[i], x, d1, d2 - eps)) / (2 * eps);
      const u = 1 - k0 * x;
      const wr = Math.sqrt(Math.sqrt(u * u + d1 * d1));
      a[i] = wr * (-k1 / (2 * h) + k2 * invh2);
      b[i] = wr * (kd - 2 * k2 * invh2);
      e[i] = wr * (k1 / (2 * h) + k2 * invh2);
      const dm = d[(i - 1 + n) % n];
      const dp = d[(i + 1) % n];
      beta[i] = wr * kc - (a[i] * dm + b[i] * x + e[i] * dp);
    }
    const Q = normalPenta(a, b, e, wCurv, 0);
    let meanDiag = 0;
    for (let i = 0; i < n; i++) meanDiag += Q.d0[i];
    meanDiag /= n;
    for (let i = 0; i < n; i++) Q.d0[i] += 1e-9 * meanDiag;
    applyAt(a, b, e, beta, c);
    for (let i = 0; i < n; i++) c[i] = wCurv * c[i] - pull[i];
    const res = solveBoxQp(Q, c, lo, hi, d);
    // damped step on the exact objective: the box is convex, so any point
    // between the old and the new solution is feasible
    let step = 1;
    let next = res.x;
    let f = objective(next);
    if (pass > 0) {
      while (f > fPrev && step > 1 / 16) {
        step *= 0.5;
        next = d.map((v, i) => v + step * (res.x[i] - v));
        f = objective(next);
      }
    }
    let moved = 0;
    for (let i = 0; i < n; i++) moved = Math.max(moved, Math.abs(next[i] - d[i]));
    if (pass > 0 && f > fPrev) break;
    d = next;
    fPrev = f;
    if (pass > 0 && moved < GN_TOL_M) break;
  }
  return Float32Array.from(d);
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

  // box constraints: hi = how far left, lo = how far right (negative); half a
  // bike's width inside the edge, then the kerb margin
  const { loM, hiM } = offsetBounds(track, corridor, params, fallbackHalfWidthM);

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

  return lineFromOffsets(track, d);
}

/**
 * Lateral offset bounds the line may use at every centerline vertex, metres
 * (left positive, right negative): the corridor edge, less half a bike's
 * width (0.4 m), plus the rider's kerb margin `tyre.kerbMarginM`, plus — past
 * a measured corridor edge only — the kerb allowance `tyre.kerbM` (default
 * 1.0 m). Exported for the free-trajectory optimiser (spec v2 §2.10), which
 * treats the offsets as decision variables inside exactly this box.
 */
export function offsetBounds(
  track: TrackModel,
  corridor: Corridor | undefined,
  params: SimParams,
  fallbackHalfWidthM = 5,
): { loM: Float32Array; hiM: Float32Array } {
  const n = track.centerline.length;
  // the kerb allowance applies past a MEASURED edge only, never past the flat
  // fallback half-width (which is a guess, not an edge)
  const measured = !!corridor && corridor.known.some(Boolean);
  const margin = params.tyre.kerbMarginM + (measured ? (params.tyre.kerbM ?? DEFAULT_KERB_M) : 0);
  const { leftM: effLeft, rightM: effRight } = effectiveHalfWidths(n, corridor, fallbackHalfWidthM);
  const hiM = new Float32Array(n);
  const loM = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    hiM[i] = Math.max(0, effLeft[i] - 0.4) + margin;
    loM[i] = -(Math.max(0, effRight[i] - 0.4) + margin);
  }
  return { loM, hiM };
}

/**
 * Build a `Line` from per-vertex lateral offsets off the centerline. This is
 * the geometry half of `buildLine`, split out so other line generators (the
 * free-trajectory optimiser, the OCP client) produce a Line the same way.
 */
export function lineFromOffsets(track: TrackModel, offsetsM: Float32Array): Line {
  const cl = track.centerline;
  const n = cl.length;
  // Shared ~10 m tangent stencil with the corridor extractor and renderer
  // (src/sim/corridor.ts) — a third, divergent normal calculation here caused
  // a real bug at hairpins in an earlier task.
  const k = stencilK(track);
  const points: LngLat[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const [nx, ny] = stencilLeftNormal(cl, i, k);
    points[i] = fromLocalM(cl[i], [nx * offsetsM[i], ny * offsetsM[i]]);
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
    offsetM: offsetsM,
    // no elevation data yet (spec v2 §2.3): flat road, explicitly
    slopeRad: new Float32Array(n),
    bankRad: new Float32Array(n),
    nu: new Float32Array(n),
  };
}
