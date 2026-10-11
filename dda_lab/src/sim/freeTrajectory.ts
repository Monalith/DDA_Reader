// Free-trajectory mode (spec v2 §2.10, row "Serbest yörünge"): the racing line
// and the speed profile optimised TOGETHER for an ideal rider, as a ceiling to
// compare the rider mode against.
//
// Decision variables are the lateral offsets off the centerline, inside exactly
// the box `offsetBounds` gives the κ-line. The inner loop is the existing QSS
// solver (`solve`) on `lineFromOffsets(...)`, so the objective is the same lap
// time every other mode reports and the result is directly comparable. The
// outer loop is derivative-free coordinate descent over smooth bumps — the
// "gradient-free" option the spec names; the free-trajectory QSS literature
// (Veneri & Massaro 2020, R4 §2) solves the same problem as an OCP, which is
// W5's job, not this one.
//
// Pure: no Worker, no storage, no clock. `freeTrajectory.worker.ts` wraps it.
import type { TrackModel } from '../core/types';
import { buildLine, lineFromOffsets, offsetBounds } from './line';
import { clampParams } from './presets';
import { G, solve } from './solver';
import type { Corridor, Envelope, Line, SimParams } from './types';

/**
 * How a run starts and what it is judged by. Every field is optional; absent
 * = the original behaviour (the κ-line of `params`, the ideal rider).
 */
export interface FreeTrajStart {
  /**
   * Warm start: offsets to begin from (one per centerline vertex), clamped into
   * the box. The κ-line is still evaluated and the faster of the two is kept,
   * so the result never loses to it.
   */
  init?: Float32Array;
  /**
   * Whose lap the search minimises: 'ideal' (default; `idealParams`, the
   * "Serbest yörünge" ceiling) or 'own' (the caller's params, wander off —
   * what `lineMode: 'lap-time'` uses, so the line is judged by the same QSS
   * rider every other line mode is).
   */
  rider?: 'ideal' | 'own';
  /**
   * Start from `init` alone: skip the κ-line comparison (a multi-start run
   * wants each start to be its own basin, not the κ-line again when it is
   * faster). Ignored without a valid `init`.
   */
  forceInit?: boolean;
  /**
   * Soft lateral-g ceiling (pist-line note §9): the objective becomes
   * lap + `latGPenaltyS(...)`. Absent = the plain lap time.
   */
  latG?: LatGPenalty;
  /** Control-knot spacing, m (default 20); the bump half-width is twice it. */
  knotSpacingM?: number;
}

/**
 * `λ · Σ_i max(0, a_demand,i − a_ceiling)² · ds_i`, with a_demand = v(s)²·|κ(s)|
 * in g. `vRefMs` (one per centerline station) is a REFERENCE rider's speed
 * mapped by station (the BMW v2 lap aligned on the start line), so the term
 * prices a line on which that rider would need more lateral g than the
 * ceiling. Without it the line's own QSS speed is used — and then the term is
 * zero by construction (the QSS lateral pass caps v²|κ| at the rider's limit,
 * which is ≤ the ceiling), so it only matters with a reference.
 */
export interface LatGPenalty {
  vRefMs?: Float32Array;
  /** Lateral ceiling, g (`lateralCeilingG`: min(μ_lat, tan(maxLean·leanUsage))). */
  ceilingG: number;
  /** λ, seconds per g² per metre of line. */
  lambda: number;
}

/**
 * Default λ: 0.1 g of excess held over 20 m costs 0.1 s (0.1² · 20 · λ = 0.1).
 * Öneri, not tuned against a measurement.
 */
export const LAT_G_PENALTY_DEFAULT = 0.5;

/** The penalty term in seconds-equivalent (see `LatGPenalty`). */
export function latGPenaltyS(line: Line, env: Envelope | null, pen: LatGPenalty): number {
  const n = line.points.length;
  const v = pen.vRefMs && pen.vRefMs.length === n ? pen.vRefMs : env?.v;
  if (!v || !(pen.lambda > 0)) return 0;
  const s = line.cumDistM;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const a = (v[i] * v[i] * Math.abs(line.curvature[i])) / G;
    const ex = a - pen.ceilingG;
    if (ex <= 0) continue;
    const ds = i < n - 1 ? s[i + 1] - s[i] : line.lengthM - s[n - 1];
    sum += ex * ex * ds;
  }
  return pen.lambda * sum;
}

export interface FreeTrajOpts extends FreeTrajStart {
  iterations: number;
  onProgress?: (frac: number, lapTimeS: number) => void;
  shouldCancel?: () => boolean;
}

export interface FreeTrajResult {
  offsetsM: Float32Array;
  lapTimeS: number;
  iterationsDone: number;
}

/**
 * Control-knot spacing along the centerline, metres. One knot per ~20 m is
 * what lets a corner's entry, apex and exit move independently (a 25 m hairpin
 * is ~80 m of arc). Öneri: plan W2 Task 2.1, not tuned against a measurement.
 */
const KNOT_SPACING_M = 20;
/**
 * Half-width of the raised-cosine bump a knot moves, metres. Twice the knot
 * spacing so neighbouring bumps overlap and a sum of them is smooth: a narrower
 * bump puts curvature the 20 m curvature stencil in `line.ts` reads as a kink.
 * Öneri (plan W2 Task 2.1).
 */
const BUMP_HALF_M = 40;
/** Initial per-knot step, metres. Öneri. */
const STEP_INIT_M = 1.0;
/** A knot whose step has shrunk below this is converged, metres. Öneri. */
const STEP_MIN_M = 0.05;
/** Upper limit for a growing step, metres. Öneri. */
const STEP_MAX_M = 3.0;
/** Step growth after a success and shrink after a failure (both directions). */
const GROW = 1.5;
const SHRINK = 0.5;
/** An improvement smaller than this is noise, seconds. */
const IMPROVE_EPS_S = 1e-7;

/**
 * The ideal rider the optimal modes stand for: every allowed-slip fraction and
 * the roll-rate fraction at 1, i.e. the tyre's peak on every axis. Everything
 * else (machine, tyre, the rest of the rider) is the caller's.
 */
export function idealParams(params: SimParams): SimParams {
  return clampParams({
    ...params,
    rider: { ...params.rider, sBrake: 1, sDrive: 1, sLat: 1, rollRateFrac: 1 },
  });
}

/** Incremental handle on one optimisation, so a worker can yield between iterations. */
export interface FreeTrajOptimiser {
  /** Best offsets so far (a live view: copy before transferring). */
  readonly offsetsM: Float32Array;
  /** QSS lap of the best line, s (the penalty, when any, is not in it). */
  readonly lapTimeS: number;
  /** What the search minimises: `lapTimeS` + the lateral-g penalty, s. */
  readonly objective: number;
  /** Lap time of the line the search started from. */
  readonly startLapTimeS: number;
  /** True once every knot's step has shrunk below the minimum. */
  readonly converged: boolean;
  /**
   * One sweep over all knots. Returns false if `shouldCancel` fired part-way
   * (the best line so far is kept, it is always valid).
   */
  iterate(shouldCancel?: () => boolean): boolean;
}

interface Bump {
  idx: Int32Array;
  w: Float32Array;
}

export function createOptimiser(
  track: TrackModel,
  corridor: Corridor | undefined,
  params: SimParams,
  start: FreeTrajStart = {},
): FreeTrajOptimiser {
  const ideal =
    (start.rider ?? 'ideal') === 'ideal'
      ? idealParams(params)
      : clampParams({ ...params, rider: { ...params.rider, lineDeviationM: 0 } });
  const n = track.centerline.length;
  const { loM, hiM } = offsetBounds(track, corridor, ideal);
  const pen = start.latG;
  let lastLap = 0;
  /** The objective of offsets `d`; leaves their pure QSS lap in `lastLap`. */
  const lapOf = (d: Float32Array): number => {
    const line = lineFromOffsets(track, d);
    const env = solve(line, ideal);
    lastLap = env.lapTimeS;
    return pen ? env.lapTimeS + latGPenaltyS(line, env, pen) : env.lapTimeS;
  };

  // Start from the user's own κ-line (that is the line the result must never
  // lose to) and from the same line without rider wander; keep the faster.
  // a 'lap-time' rider's κ-line would be this optimiser's own stored result:
  // start from the min-time line instead
  const lineP: SimParams =
    params.rider.lineMode === 'lap-time' ? { ...params, rider: { ...params.rider, lineMode: 'min-time' } } : params;
  const forced = !!start.forceInit && !!start.init && start.init.length === n;
  let best = forced
    ? Float32Array.from(start.init!, (v, i) => Math.min(hiM[i], Math.max(loM[i], v)))
    : Float32Array.from(buildLine(track, corridor, lineP).offsetM);
  let bestT = lapOf(best);
  let bestLap = lastLap;
  if (!forced && params.rider.lineDeviationM > 0) {
    const calm = Float32Array.from(
      buildLine(track, corridor, { ...lineP, rider: { ...lineP.rider, lineDeviationM: 0 } }).offsetM,
    );
    const calmT = lapOf(calm);
    if (calmT < bestT) {
      best = calm;
      bestT = calmT;
      bestLap = lastLap;
    }
  }
  if (!forced && start.init && start.init.length === n) {
    const warm = Float32Array.from(start.init, (v, i) => Math.min(hiM[i], Math.max(loM[i], v)));
    const warmT = lapOf(warm);
    if (warmT < bestT) {
      best = warm;
      bestT = warmT;
      bestLap = lastLap;
    }
  }
  const startT = bestLap;

  // Knots and their raised-cosine bumps, by distance along the centerline,
  // wrapping across the start line (the lap is closed).
  const L = track.lengthM;
  const s = track.cumDistM;
  const spacing = start.knotSpacingM && start.knotSpacingM > 0 ? start.knotSpacingM : KNOT_SPACING_M;
  const bumpHalf = (BUMP_HALF_M / KNOT_SPACING_M) * spacing;
  const nKnots = Math.max(1, Math.round(L / spacing));
  const bumps: Bump[] = [];
  {
    let j = 0;
    for (let k = 0; k < nKnots; k++) {
      const sk = (k * L) / nKnots;
      while (j < n - 1 && s[j] < sk) j++;
      const centre = s[j];
      const idx: number[] = [];
      const w: number[] = [];
      for (let i = 0; i < n; i++) {
        let ds = Math.abs(s[i] - centre);
        if (ds > L / 2) ds = L - ds;
        if (ds < bumpHalf) {
          idx.push(i);
          w.push(0.5 * (1 + Math.cos((Math.PI * ds) / bumpHalf)));
        }
      }
      bumps.push({ idx: Int32Array.from(idx), w: Float32Array.from(w) });
    }
  }
  const step = new Float32Array(nKnots).fill(STEP_INIT_M);
  const trial = new Float32Array(n);

  /** Try `best + delta·bump` (clamped into the box); accept if faster. */
  const tryMove = (b: Bump, delta: number): boolean => {
    trial.set(best);
    let moved = false;
    for (let q = 0; q < b.idx.length; q++) {
      const i = b.idx[q];
      const v = Math.min(hiM[i], Math.max(loM[i], best[i] + delta * b.w[q]));
      if (v !== trial[i]) moved = true;
      trial[i] = v;
    }
    if (!moved) return false; // pinned against the box: nothing to evaluate
    const t = lapOf(trial);
    if (t < bestT - IMPROVE_EPS_S) {
      best.set(trial);
      bestT = t;
      bestLap = lastLap;
      return true;
    }
    return false;
  };

  let converged = false;
  let sweep = 0;
  return {
    get offsetsM() {
      return best;
    },
    get lapTimeS() {
      return bestLap;
    },
    get objective() {
      return bestT;
    },
    startLapTimeS: startT,
    get converged() {
      return converged;
    },
    iterate(shouldCancel?: () => boolean): boolean {
      // alternate sweep direction so no knot is always first to claim a gain
      const fwd = sweep++ % 2 === 0;
      let active = false;
      for (let q = 0; q < nKnots; q++) {
        if (shouldCancel?.()) return false;
        const k = fwd ? q : nKnots - 1 - q;
        if (step[k] < STEP_MIN_M) continue;
        active = true;
        if (tryMove(bumps[k], step[k]) || tryMove(bumps[k], -step[k])) {
          step[k] = Math.min(STEP_MAX_M, step[k] * GROW);
        } else {
          step[k] *= SHRINK;
        }
      }
      if (!active) converged = true;
      return true;
    },
  };
}

/**
 * Minimum-lap-time lateral offsets for an ideal rider, starting from the
 * κ-line of `params`. Never returns a lap slower than that start; every offset
 * lies inside `offsetBounds(track, corridor, params)`. `lapTimeS` is exactly
 * `solve(lineFromOffsets(track, offsetsM), idealParams(params)).lapTimeS`.
 *
 * `onProgress(frac, lapTimeS)` is called once before the first iteration
 * (frac 0) and after each completed one. `shouldCancel` is polled before every
 * knot; a cancelled run returns the best line found so far.
 */
export function optimiseOffsets(
  track: TrackModel,
  corridor: Corridor | undefined,
  params: SimParams,
  opts: FreeTrajOpts,
): FreeTrajResult {
  const total = Math.max(0, Math.floor(opts.iterations));
  const opt = createOptimiser(track, corridor, params, opts);
  opts.onProgress?.(0, opt.lapTimeS);
  let done = 0;
  while (done < total && !opt.converged) {
    if (!opt.iterate(opts.shouldCancel)) break;
    done++;
    opts.onProgress?.(opt.converged ? 1 : done / total, opt.lapTimeS);
  }
  return { offsetsM: Float32Array.from(opt.offsetsM), lapTimeS: opt.lapTimeS, iterationsDone: done };
}
