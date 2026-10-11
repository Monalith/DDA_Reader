// `lineMode: 'lap-time'` (pist-line note §8): the racing line found by a
// DIRECT lap-time descent — the free-trajectory optimiser (`freeTrajectory.ts`)
// judged by the rider's own QSS lap (not the ideal rider's), warm-started from
// the fastest κ-line. A run takes ~10-20 s on Serres, so it never runs inside
// `buildLine`: the browser runs it in the free-trajectory worker
// (ui/panels/simRunners.ts → "Optimise line") and stores the result here;
// `buildLine` then reads it synchronously. Until a result exists (or after the
// track changes) `buildLine` falls back to the min-time line.
//
// Cache: an exact entry per (track, machine, tyre, rider) — the optCache
// mechanics, memory + an injected key-value storage — plus the latest result
// per track, which `buildLine` uses (re-clamped into the box) when only the
// rider sliders moved: a slightly stale lap-time line is a better line than the
// min-time fallback, and `lapTimeLineStatus` tells the panel it is stale.
import type { TrackModel } from '../core/types';
import { alignReference } from './alignRef';
import { corridorKey } from './corridorCache';
import { createOptimiser, LAT_G_PENALTY_DEFAULT, type FreeTrajOptimiser } from './freeTrajectory';
import { buildLine, lineFromOffsets, offsetBounds } from './line';
import { fnv1a, readOpt, stableStringify, writeOpt, type KVStorage } from './optCache';
import { clampParams } from './presets';
import type { Reference } from './reference';
import { solve } from './solver';
import type { Corridor, Line, SimParams } from './types';

/** Sweeps per run: Serres converges in 19-31 (note §8). */
export const LAP_TIME_ITERATIONS = 60;

/** κ values whose min-time lines are tried as the warm start; the fastest wins. */
const START_KAPPAS = [0, 0.5, 0.85, 1];

/**
 * Cache key: track + station count + everything the rider's QSS lap depends on.
 * The line's own knobs (lineMode, lineDeviationM, the overrides list) are left
 * out; κ stays in (it picks the warm start's candidates).
 */
export function lapTimeKey(track: TrackModel, params: SimParams): string {
  const p = clampParams(params);
  const { presetId: _id, ...machine } = p.machine;
  void _id;
  const { lineMode: _m, lineDeviationM: _d, overrides: _o, ...rider } = p.rider;
  void _m;
  void _d;
  void _o;
  return `${corridorKey(track)}.lt.${track.centerline.length}.${fnv1a(stableStringify({ machine, tyre: p.tyre, rider }))}`;
}

/** `lapTimeKey` + the run's variant (multi-start / penalty settings), for the exact cache. */
const variantKey = (key: string, variant: string): string => (variant ? `${key}.${fnv1a(variant)}` : key);

const latest = new Map<string, { key: string; offsetsM: Float32Array; lapTimeS: number }>();
const trackKey = (track: TrackModel): string => `${corridorKey(track)}.${track.centerline.length}`;

/**
 * Store a finished run (memory, and `storage` when given). `variant` (the run's
 * starts / penalty settings, `lapTimeVariant`) keys the exact entry the runner
 * looks up; the plain key always holds the last run for these params, which is
 * what `buildLine` rides.
 */
export function rememberLapTimeLine(
  track: TrackModel,
  params: SimParams,
  offsetsM: Float32Array,
  lapTimeS: number,
  storage?: KVStorage,
  variant = '',
): void {
  const key = lapTimeKey(track, params);
  writeOpt(key, offsetsM, lapTimeS, storage);
  if (variant) writeOpt(variantKey(key, variant), offsetsM, lapTimeS, storage);
  latest.set(trackKey(track), { key, offsetsM: Float32Array.from(offsetsM), lapTimeS });
}

/** An exact cached result (memory, then `storage`), or null. Promotes a hit to "latest". */
export function cachedLapTimeLine(track: TrackModel, params: SimParams, storage?: KVStorage, variant = ''): Float32Array | null {
  const key = lapTimeKey(track, params);
  const hit = readOpt(variantKey(key, variant), track.centerline.length, storage);
  if (hit) {
    if (variant) writeOpt(key, hit, NaN, storage);
    latest.set(trackKey(track), { key, offsetsM: Float32Array.from(hit), lapTimeS: NaN });
  }
  return hit;
}

export type LapTimeStatus = 'fresh' | 'stale' | 'none';

/** Whether `buildLine` would use an exact result, a stale one for this track, or the min-time fallback. */
export function lapTimeLineStatus(track: TrackModel, params: SimParams): LapTimeStatus {
  const l = latest.get(trackKey(track));
  if (!l) return 'none';
  return l.key === lapTimeKey(track, params) ? 'fresh' : 'stale';
}

/**
 * The offsets `buildLine` uses for 'lap-time', clamped into this box, or null
 * when there is no result for this track (→ min-time fallback).
 */
export function lapTimeOffsets(track: TrackModel, corridor: Corridor | undefined, params: SimParams, fallbackHalfWidthM = 5): Float32Array | null {
  const exact = readOpt(lapTimeKey(track, params), track.centerline.length);
  const src = exact ?? latest.get(trackKey(track))?.offsetsM ?? null;
  if (!src) return null;
  const { loM, hiM } = offsetBounds(track, corridor, params, fallbackHalfWidthM);
  return Float32Array.from(src, (v, i) => Math.min(hiM[i], Math.max(loM[i], v)));
}

/**
 * Warm start: the min-time line at the rider's κ and at `START_KAPPAS`, the one
 * with the fastest QSS lap for this rider (no wander). On Serres the κ 0.85
 * start reaches 76.07 s, the κ 0 one 77.33 s (note §8): the descent is local.
 */
export function lapTimeStart(track: TrackModel, corridor: Corridor | undefined, params: SimParams): Float32Array {
  const base = clampParams({ ...params, rider: { ...params.rider, lineMode: 'min-time', lineDeviationM: 0 } });
  let best: Float32Array | null = null;
  let bestT = Infinity;
  for (const kappa of new Set([base.rider.kappa, ...START_KAPPAS])) {
    const p = { ...base, rider: { ...base.rider, kappa } };
    const line = buildLine(track, corridor, p);
    const t = solve(line, p).lapTimeS;
    if (t < bestT) {
      bestT = t;
      best = Float32Array.from(line.offsetM);
    }
  }
  return best!;
}

// ---------------------------------------------------------------------------
// Multi-start + soft lateral-g ceiling (pist-line note §9)

/** Per-start sweep cap. */
export const LAP_TIME_START_ITERATIONS = LAP_TIME_ITERATIONS;
/** Wall-clock budget of a whole multi-start run, ms (the worker's ≤ 30 s). */
export const LAP_TIME_BUDGET_MS = 28_000;

export interface LapTimeRunOpts {
  /**
   * Extra warm starts, each descended on its own (the owner's GPS path mapped
   * into the corridor, `pathOffsets`): `Line`s on this track's stations.
   */
  warmStarts?: Line[];
  /** Also start from the min-time line at the rider's κ (start (c)). Default false. */
  minTimeStart?: boolean;
  /**
   * A reference rider's speed per centerline station, m/s
   * (`lapTimeReferenceSpeed`). With it the lateral-g penalty is on by default.
   */
  refSpeedMs?: Float32Array;
  /**
   * A reference lap instead of `refSpeedMs`: aligned on start (a), the
   * fastest κ-line (`lapTimeReferenceSpeed`), inside the run.
   */
  reference?: Reference;
  /**
   * λ_g of the soft lateral-g ceiling, s per g² per metre
   * (`LAT_G_PENALTY_DEFAULT` = 0.1 g over 20 m costs 0.1 s). Default: on when
   * `refSpeedMs` or `reference` is given, off otherwise; 0 = off. Without a reference the
   * term would use the line's own QSS speed and is zero by construction.
   */
  latGPenalty?: number;
  /** Lateral ceiling for the penalty, g (default `lateralCeilingG(params)`). */
  ceilingG?: number;
  /** Sweep cap per start (default `LAP_TIME_START_ITERATIONS`). */
  iterations?: number;
  /** Knot spacing, m (default the optimiser's 20 m). */
  knotSpacingM?: number;
  /**
   * Sweeps every start gets before the best one (by QSS lap) is continued
   * alone. Infinity = every start runs to convergence. Default: Infinity for
   * one or two starts (~13 s each on Serres), `LAP_TIME_PROBE_SWEEPS` for more.
   */
  probeSweeps?: number;
  /** Wall-clock budget, ms (default `LAP_TIME_BUDGET_MS`); at it the best line so far is returned. */
  budgetMs?: number;
  now?: () => number;
}

/** Sweeps a start typically takes to converge (Serres 19-31), for the progress bar only. */
const TYPICAL_SWEEPS = 28;

/** Probe length with three or more starts (note §9: on Serres the ranking after 8 sweeps is the final one). */
export const LAP_TIME_PROBE_SWEEPS = 8;

export interface LapTimeProgress {
  /** 1-based index of the start being descended. */
  start: number;
  starts: number;
  /** Labels of the starts, in order. */
  labels: string[];
  /** 0..1 over the whole run. */
  frac: number;
  /** Best QSS lap over all starts so far, s. */
  lapTimeS: number;
}

export interface LapTimeStartResult {
  label: string;
  startLapTimeS: number;
  lapTimeS: number;
  objective: number;
  sweeps: number;
  converged: boolean;
  ms: number;
  offsetsM: Float32Array;
}

export interface LapTimeRunResult {
  offsetsM: Float32Array;
  /** QSS lap of the kept line (no penalty), s. */
  lapTimeS: number;
  /** Lap + penalty of the kept line, s. */
  objective: number;
  /** Index into `starts` of the kept line. */
  best: number;
  starts: LapTimeStartResult[];
  /** True when the budget cut the run short. */
  outOfBudget: boolean;
  ms: number;
}

/** The incremental run a worker drives one sweep per macrotask. */
export interface LapTimeRun {
  /** One sweep of the current start; false once the run is finished. */
  step(shouldCancel?: () => boolean): boolean;
  readonly progress: LapTimeProgress;
  /** The best line over every start so far (final once `step` returned false). */
  result(): LapTimeRunResult;
}

/** Lateral ceiling min(μ_lat, tan(maxLean·leanUsage)), g (= fitRider's `lateralCeilingG`). */
function ceilingOf(params: SimParams): number {
  const p = clampParams(params);
  return Math.min(p.tyre.mu * p.tyre.gripScale, Math.tan((p.tyre.maxLeanDeg * p.rider.leanUsage * Math.PI) / 180));
}

/**
 * A reference lap's speed per centerline station, m/s: the reference aligned
 * (`alignReference`, the fit's corner matching) on `line` — the fastest
 * κ-line, `lapTimeStart`. Station i is the same cross-section on every line
 * built from offsets, so the array prices any trial line at the speed that
 * rider carried there.
 */
export function lapTimeReferenceSpeed(line: Line, params: SimParams, ref: Reference): Float32Array {
  return Float32Array.from(alignReference(ref, line, clampParams(params)).vRefMs);
}

/** A short string of the settings that change a run's result, for the exact cache ('' = the single-start run). */
export function lapTimeVariant(opts: LapTimeRunOpts): string {
  const hasRef = !!opts.refSpeedMs || !!opts.reference;
  const pen = opts.latGPenalty ?? (hasRef ? LAT_G_PENALTY_DEFAULT : 0);
  const ref = opts.refSpeedMs
    ? fnv1a(Array.from(opts.refSpeedMs, (v) => v.toFixed(2)).join(','))
    : opts.reference
      ? fnv1a(`${opts.reference.name}|${opts.reference.lapTimeS}|${opts.reference.lengthM}`)
      : '';
  const warm = (opts.warmStarts ?? []).map((l) => fnv1a(Array.from(l.offsetM, (v) => v.toFixed(2)).join(','))).join('+');
  if (!warm && !opts.minTimeStart && !(pen > 0) && !opts.knotSpacingM) return '';
  return `ms:${warm}|mt:${opts.minTimeStart ? 1 : 0}|pen:${pen > 0 ? `${pen}@${ref}` : 0}|k:${opts.knotSpacingM ?? ''}`;
}

/**
 * The 'lap-time' line from several warm starts (note §9): (a) the fastest
 * κ-line (`lapTimeStart`), (b) every `warmStarts` line, (c) optionally the
 * min-time line; each descended with the rider's own QSS lap (+ the soft
 * lateral-g penalty when on). Every start gets `probeSweeps` sweeps, then the
 * best by QSS lap continues alone. The kept line is the fastest QSS lap over
 * all starts (not the lowest lap + penalty: note §9).
 */
export function createLapTimeRun(track: TrackModel, corridor: Corridor | undefined, params: SimParams, opts: LapTimeRunOpts = {}): LapTimeRun {
  const now = opts.now ?? (() => performance.now());
  const t0 = now();
  const budget = opts.budgetMs ?? LAP_TIME_BUDGET_MS;
  const iters = opts.iterations ?? LAP_TIME_START_ITERATIONS;
  const n = track.centerline.length;
  const lambda = opts.latGPenalty ?? (opts.refSpeedMs || opts.reference ? LAT_G_PENALTY_DEFAULT : 0);
  const inits: Array<{ label: string; init: Float32Array }> = [{ label: 'κ-line', init: lapTimeStart(track, corridor, params) }];
  const vRefMs =
    lambda > 0
      ? (opts.refSpeedMs ?? (opts.reference ? lapTimeReferenceSpeed(lineFromOffsets(track, inits[0].init), params, opts.reference) : undefined))
      : undefined;
  const latG = lambda > 0 ? { vRefMs, ceilingG: opts.ceilingG ?? ceilingOf(params), lambda } : undefined;

  for (const [q, l] of (opts.warmStarts ?? []).entries()) {
    if (l.offsetM.length === n) inits.push({ label: q === 0 ? 'owner path' : `warm start ${q + 1}`, init: Float32Array.from(l.offsetM) });
  }
  if (opts.minTimeStart) {
    const p = clampParams({ ...params, rider: { ...params.rider, lineMode: 'min-time', lineDeviationM: 0 } });
    inits.push({ label: 'min-time', init: Float32Array.from(buildLine(track, corridor, p).offsetM) });
  }
  const labels = inits.map((x) => x.label);
  const probe = opts.probeSweeps ?? (inits.length > 2 ? LAP_TIME_PROBE_SWEEPS : Infinity);
  const opt: Array<FreeTrajOptimiser | null> = inits.map(() => null);
  const sweeps = new Array<number>(inits.length).fill(0);
  const ms = new Array<number>(inits.length).fill(0);
  const make = (k: number): FreeTrajOptimiser =>
    (opt[k] ??= createOptimiser(track, corridor, params, {
      init: inits[k].init,
      rider: 'own',
      forceInit: true,
      latG,
      knotSpacingM: opts.knotSpacingM,
    }));
  const done = (k: number): boolean => !!opt[k] && (opt[k]!.converged || sweeps[k] >= iters);

  // phase 1: start k for `probe` sweeps, in order; phase 2: the best one alone
  let cur = 0;
  let phase2 = inits.length === 1 || !(probe < iters);
  let winner = -1;
  let finished = false;
  let outOfBudget = false;
  // keep-best by the QSS lap (the penalty, when on, has already shaped each
  // start's line; note §9 compares the objective rule)
  const bestIdx = (): number => {
    let b = 0;
    for (let k = 1; k < inits.length; k++) if (opt[k] && (!opt[b] || opt[k]!.lapTimeS < opt[b]!.lapTimeS)) b = k;
    return b;
  };
  // progress: phase 1 = probe sweeps of every start; phase 2 = the winner's rest
  const plannedSweeps = (): number => (phase2 && winner < 0 ? inits.length * iters : inits.length * Math.min(probe, iters) + Math.max(0, iters - Math.min(probe, iters)));
  const spent = (): number => sweeps.reduce((a, b) => a + b, 0);

  const progress = (): LapTimeProgress => {
    const k = winner >= 0 ? winner : cur;
    // every start to convergence: whole starts done + the current one's sweeps
    // against a typical run (Serres converges in 19-31, note §8)
    const fr = finished
      ? 1
      : !(probe < iters)
        ? Math.min(0.99, (k + Math.min(0.95, sweeps[Math.min(k, inits.length - 1)] / TYPICAL_SWEEPS)) / inits.length)
        : Math.min(0.99, spent() / Math.max(1, plannedSweeps()));
    const best = bestIdx();
    return { start: Math.min(inits.length, k + 1), starts: inits.length, labels, frac: fr, lapTimeS: opt[best]?.lapTimeS ?? NaN };
  };

  return {
    get progress() {
      return progress();
    },
    step(shouldCancel) {
      if (finished) return false;
      if (now() - t0 > budget) {
        outOfBudget = true;
        finished = true;
        return false;
      }
      let k: number;
      if (winner >= 0) k = winner;
      else {
        // next start that still has probe (or, with phase2 from the outset, full) sweeps left
        const cap = phase2 ? iters : Math.min(probe, iters);
        while (cur < inits.length && opt[cur] && (done(cur) || sweeps[cur] >= cap)) cur++;
        if (cur >= inits.length) {
          if (phase2) {
            finished = true;
            return false;
          }
          winner = bestIdx();
          if (done(winner)) {
            finished = true;
            return false;
          }
          k = winner;
        } else k = cur;
      }
      const ts = now();
      const o = make(k);
      if (!o.converged && sweeps[k] < iters) {
        if (!o.iterate(shouldCancel)) {
          finished = true;
          ms[k] += now() - ts;
          return false;
        }
        sweeps[k]++;
      }
      ms[k] += now() - ts;
      if (winner >= 0 && done(winner)) finished = true;
      return !finished;
    },
    result() {
      const starts: LapTimeStartResult[] = inits.map((x, k) => {
        const o = opt[k];
        return {
          label: x.label,
          startLapTimeS: o?.startLapTimeS ?? NaN,
          lapTimeS: o?.lapTimeS ?? NaN,
          objective: o?.objective ?? NaN,
          sweeps: sweeps[k],
          converged: o?.converged ?? false,
          ms: ms[k],
          offsetsM: o ? Float32Array.from(o.offsetsM) : Float32Array.from(x.init),
        };
      });
      const b = bestIdx();
      return {
        offsetsM: Float32Array.from(starts[b].offsetsM),
        lapTimeS: starts[b].lapTimeS,
        objective: starts[b].objective,
        best: b,
        starts,
        outOfBudget,
        ms: now() - t0,
      };
    },
  };
}

/** Run `createLapTimeRun` to the end synchronously (scripts, tests). */
export function runLapTimeLine(track: TrackModel, corridor: Corridor | undefined, params: SimParams, opts: LapTimeRunOpts = {}, onProgress?: (p: LapTimeProgress) => void): LapTimeRunResult {
  const run = createLapTimeRun(track, corridor, params, opts);
  while (run.step()) onProgress?.(run.progress);
  return run.result();
}

/** Test hook: forget every in-memory result. */
export function clearLapTimeLines(): void {
  latest.clear();
}
