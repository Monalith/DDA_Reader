// "Fit to lap" (spec 2026-10-14-fit-to-lap-rider-calibration.md): calibrate
// the EXISTING virtual rider to a recorded lap — no new layer. What is fitted
// is exactly what the Rider panel's sliders hold:
//
//   stage 1  lap-wide AGGRESSIVENESS / RISK (coarse grid 0…1 step 0.2), the
//            pinned derived keys sBrake, sLat, sDrive, throttleDelayS,
//            rollOnS, trailBrakeDepth, rollRateFrac, leanUsage (pattern
//            search inside their slider bounds); on a measured GPS path the
//            lap-wide line style κ (grid 0.25…1, each candidate line with
//            sLat / leanUsage re-tuned; the owner's Run036 line is a κ ≈ 0.4
//            line, 60 m longer than the 1000 preset's κ 0.85 one); then A / R
//            refined (0.1 → 0.05) and the pinned keys once more. A
//            hand-placed path (the BMW / R6 video laps) keeps the user's κ;
//   stage 2  per-corner overrides of the rider's own keys (cornerRider.ts:
//            κ, sBrake, trailBrakeDepth, sLat, leanUsage, rollRateFrac,
//            throttleDelayS, rollOnS, sDrive, slideOut), corner by corner, two rounds,
//            lightly regularised toward the lap-wide value so a corner only
//            deviates where the data asks; more rounds while budget is left.
//
// Objective per station (space-mean over each corner's stretch: its zone,
// then the run to the next zone):
//     w_v·((v − v_ref)/1 m/s)² + w_a·((a_x − a_ref)/0.1 g)²
//   + w_line·((offset − GPS offset)/1 m)²   (measured GPS path only)
// and for the lap w_time·((T_sim − T_ref)/0.12 s)², spread evenly over the
// corners (how the path LENGTH enters; see TIME_SIGMA).
// The machine and tyre are NOT fitted.
//
// Evaluation unit: exactly the rider mode's ride (`rideOn`: the rider's line
// with κ / slide out, `solve` with the per-corner caps and `riderAt`,
// findCorners, eventProfile), ~15 ms on Serres. The QSS solve alone (~5 ms)
// was tried and does not do: the timing keys (throttleDelayS, rollOnS) only
// exist in the event template, and the QSS lap is ~0.7 s faster than the
// ridden one, so a QSS optimum (A / R grid) lands in another basin.
//
// Plain data in and out (typed arrays, numbers): a RiderFitResult crosses a
// Worker boundary by structured clone.
import type { TrackModel } from '../core/types';
import { alignReference } from './alignRef';
import {
  CORNER_RIDER_BOUNDS,
  cornerZones,
  lapValue,
  riderLineOn,
  slideEntry,
  brakeOwnerAt,
  driveOwnerAt,
  zoneOwnerAt,
  type CornerRider,
  type CornerRiderKey,
  type CornerRiders,
  type CornerZone,
} from './cornerRider';
import { deriveRider } from './derive';
import { longGOnLine } from './fitRider';
import { rideOn } from './index';
import type { LapReference } from './lapReference';
import { buildLine, lineFromOffsets } from './line';
import { ownerOffsets } from './ownerOffsets';
import { idealLeanLimitRad } from './vehicle';
import { clampParams } from './presets';
import { G, lossDecelMs2 } from './solver';
import { gripFraction } from './tyre';
import type { Corridor, DerivedRiderKey, Envelope, Line, RiderParams, SimParams } from './types';

export interface RiderFitReference {
  label: string;
  refLapTimeS: number;
  pathTrusted: boolean;
  /** per station of the fitted line's parameterisation (track centreline stations = riderLine stations) */
  vRefMs: Float32Array;
  aRefG: Float32Array;
  pathOffsetM: Float32Array | null;
  /**
   * The reference's own clock at each station, s (through the alignment
   * warp): stretch times come from it, so a path longer or shorter than the
   * sim's line shows up as time. Absent on a reference built elsewhere.
   */
  tRefS?: Float64Array;
}
export interface RiderFitRow {
  n: number;
  name: string;
  apexRefKmh: number;
  apexSimKmh: number;
  vRmsKmh: number;
  aRmsG: number;
  lineRmsM: number | null;
  latPeakG: number;
  grade: 'good' | 'fair' | 'poor';
}
export interface RiderFitStats {
  evaluations: number;
  errorBefore: number;
  errorAfter: number;
  ms: number;
}
export interface RiderFitResult {
  rider: RiderParams;
  ref: RiderFitReference;
  zones: CornerZone[];
  rows: RiderFitRow[];
  lapTimeS: number;
  refOnLineS: number;
  stats: RiderFitStats;
}
export interface RiderFitOptions {
  budgetMs: number;
  /** `time` (the lap-time term, see TIME_SIGMA) defaults to DEFAULT_FIT_WEIGHTS.time. */
  weights?: { v: number; a: number; line: number; time?: number };
  onProgress?: (p: { frac: number; stage: string; error?: number }) => void;
  now?: () => number;
}

export const DEFAULT_FIT_WEIGHTS = { v: 1, a: 0.3, line: 0.3, time: 0.3 };

/** Speed error scale, m/s. */
const V_SIGMA = 1;
/** Longitudinal-g error scale, g. */
const A_SIGMA = 0.1;
/** Line error scale, m. */
const LINE_SIGMA = 1;
/**
 * Lap-time error scale, s (`weights.time`, spread evenly over the corners):
 * the sim's lap against the reference's. It is how the path LENGTH enters
 * (and a small speed bias, which squared speed errors do not see): matching v
 * per station on a line 60 m shorter than the one ridden (Run036: the 1000
 * preset's κ 0.85 line, 3034 m, against 3097 m) is 1.8 s short on the lap
 * whatever the speeds. Per-stretch times against the reference's own clock
 * were tried and are too noisy: the alignment warp moves the stretch ends.
 */
const TIME_SIGMA = 0.12;
/** Regularisation per corner key: REG·((value − lap-wide)/range)². */
const REG = 0.05;
/** A fitted value is kept (pinned / corner override) when it moved more than this share of its range. */
const KEEP_FRAC = 0.01;
/** The fit tries a slide out only where the reference slows at least this much over the entry, m/s. */
const SLIDE_MIN_DROP_MS = 3;
/** Default wall-clock budget, ms. */
const DEFAULT_BUDGET_MS = 25_000;

/** The pinned derived keys stage 1 fits after A / R. */
const PINNED_KEYS: readonly (CornerRiderKey & DerivedRiderKey)[] = ['sBrake', 'sLat', 'sDrive', 'throttleDelayS', 'rollOnS', 'trailBrakeDepth', 'rollRateFrac', 'leanUsage'];
/** The per-corner keys stage 2 fits. */
const CORNER_FIT_KEYS: readonly CornerRiderKey[] = ['kappa', 'sBrake', 'trailBrakeDepth', 'sLat', 'leanUsage', 'rollRateFrac', 'throttleDelayS', 'rollOnS', 'sDrive', 'slideOut'];

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const range = (k: CornerRiderKey): number => CORNER_RIDER_BOUNDS[k][1] - CORNER_RIDER_BOUNDS[k][0];

/**
 * ∫ds/v_ref over a line whose stations are the reference's (the reference
 * speed is per station): the reference speed ridden over THAT line — the
 * apples-to-apples lap for a fit that matches v(station).
 */
export function refTimeOnLine(line: Line, vRefMs: ArrayLike<number>): number {
  const n = line.points.length;
  let t = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ds = j === 0 ? line.lengthM - line.cumDistM[n - 1] : line.cumDistM[j] - line.cumDistM[i];
    t += ds / Math.max(2, (vRefMs[i] + vRefMs[j]) / 2);
  }
  return t;
}

/**
 * The reference on the track's centreline stations: its speed aligned onto a
 * line (its own GPS path when measured — `pathOnLine` — else the rider's
 * current line), its longitudinal g from that speed (d(v²/2)/ds over ±10 m,
 * as the fit reads the sim's), and its path as offsets when measured.
 */
export function referenceForFit(track: TrackModel, corridor: Corridor | undefined, params: SimParams, lapRef: LapReference): RiderFitReference {
  const p = clampParams(params);
  const ref = lapRef.ref;
  const trusted = lapRef.pathTrusted && !!ref.lon && !!ref.lat;
  const pathOffsetM = trusted ? ownerOffsets(track, ref.lon!, ref.lat!) : null;
  const line = pathOffsetM ? lineFromOffsets(track, pathOffsetM) : buildLine(track, corridor, p);
  const al = alignReference(ref, line, p, { pathOnLine: trusted });
  const vRefMs = Float32Array.from(al.vRefMs);
  return {
    label: lapRef.label,
    refLapTimeS: ref.lapTimeS,
    pathTrusted: trusted,
    vRefMs,
    aRefG: longGOnLine(line, vRefMs),
    pathOffsetM,
    tRefS: Float64Array.from(al.tRefS),
  };
}

/** Station → the corner whose stretch it belongs to: the zone holding it, else the zone it last left. */
function errorOwners(zones: CornerZone[], n: number): Int16Array {
  const own = new Int16Array(n).fill(-1);
  if (!zones.length) return own;
  let last = -1;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      const z = zoneOwnerAt(zones, i);
      if (z >= 0) last = z;
      if (pass === 1 || own[i] < 0) own[i] = z >= 0 ? z : last;
    }
  }
  return own;
}

interface ErrTerms {
  /** Per corner, space-mean of the weighted squared errors. */
  err: Float64Array;
  sv: Float64Array;
  sa: Float64Array;
  sl: Float64Array;
  len: Float64Array;
}

function errorTerms(
  ref: RiderFitReference,
  owners: Int16Array,
  K: number,
  line: Line,
  env: Envelope,
  w: { v: number; a: number; line: number },
): ErrTerms {
  const n = line.points.length;
  const a = longGOnLine(line, env.v);
  const sv = new Float64Array(K);
  const sa = new Float64Array(K);
  const sl = new Float64Array(K);
  const len = new Float64Array(K);
  const po = ref.pathOffsetM;
  for (let i = 0; i < n; i++) {
    const k = owners[i];
    if (k < 0) continue;
    const j = (i + 1) % n;
    const ds = j === 0 ? line.lengthM - line.cumDistM[n - 1] : line.cumDistM[j] - line.cumDistM[i];
    const ev = env.v[i] - ref.vRefMs[i];
    const ea = a[i] - ref.aRefG[i];
    sv[k] += ev * ev * ds;
    sa[k] += ea * ea * ds;
    if (po) {
      const el = line.offsetM[i] - po[i];
      sl[k] += el * el * ds;
    }
    len[k] += ds;
  }
  const err = new Float64Array(K);
  for (let k = 0; k < K; k++) {
    if (!(len[k] > 0)) continue;
    err[k] =
      (w.v * sv[k]) / (V_SIGMA * V_SIGMA * len[k]) +
      (w.a * sa[k]) / (A_SIGMA * A_SIGMA * len[k]) +
      (po ? (w.line * sl[k]) / (LINE_SIGMA * LINE_SIGMA * len[k]) : 0);
  }
  return { err, sv, sa, sl, len };
}

/** Per-corner report of a ridden lap against the reference (stretch = zone + the run after it). */
export function riderFitRows(ref: RiderFitReference, zones: CornerZone[], line: Line, env: Envelope, params: SimParams): RiderFitRow[] {
  void params;
  const n = line.points.length;
  const K = zones.length;
  const owners = errorOwners(zones, n);
  const t = errorTerms(ref, owners, K, line, env, DEFAULT_FIT_WEIGHTS);
  const peak = new Float64Array(K);
  for (let i = 0; i < n; i++) {
    const z = zoneOwnerAt(zones, i);
    if (z >= 0) peak[z] = Math.max(peak[z], Math.abs(env.latG[i]));
  }
  return zones.map((z, k) => {
    const L = t.len[k];
    const vRms = L > 0 ? Math.sqrt(t.sv[k] / L) * 3.6 : 0;
    const aRms = L > 0 ? Math.sqrt(t.sa[k] / L) : 0;
    const grade: RiderFitRow['grade'] = vRms < 2 && aRms < 0.06 ? 'good' : vRms < 5 && aRms < 0.12 ? 'fair' : 'poor';
    return {
      n: z.n,
      name: z.name,
      apexRefKmh: ref.vRefMs[z.iApex] * 3.6,
      apexSimKmh: env.v[z.iApex] * 3.6,
      vRmsKmh: vRms,
      aRmsG: aRms,
      lineRmsM: ref.pathOffsetM && L > 0 ? Math.sqrt(t.sl[k] / L) : null,
      latPeakG: peak[k],
      grade,
    };
  });
}

/** Inverse of a monotone increasing f on [lo, hi] at y (bisection; clamped to the ends). */
function invert(f: (x: number) => number, y: number, lo: number, hi: number): number {
  if (y <= f(lo)) return lo;
  if (y >= f(hi)) return hi;
  let a = lo;
  let b = hi;
  for (let k = 0; k < 30; k++) {
    const m = 0.5 * (a + b);
    if (f(m) < y) a = m;
    else b = m;
  }
  return 0.5 * (a + b);
}

/**
 * Per-corner starting values read straight off the reference on the rider's
 * line (fitRider's initial values, in the rider's own keys): the lateral g
 * the reference needs in the zone (p95 of v_ref²·|κ|) → sLat (and leanUsage
 * where the lean limit is lower); its peak deceleration on the approach (less
 * drag and rolling) → sBrake; its peak drive on the exit → sDrive (only
 * downward: the engine, not the tyre, may be what limits it).
 */
function cornerInit(ref: RiderFitReference, line: Line, zones: CornerZone[], p: SimParams): CornerRider[] {
  const n = line.points.length;
  const muX = (p.tyre.muX ?? p.tyre.mu) * p.tyre.gripScale;
  const muY = p.tyre.mu * p.tyre.gripScale;
  const tanLean = (lean: number): number => Math.tan(idealLeanLimitRad(p.machine, (p.tyre.maxLeanDeg * lean * Math.PI) / 180));
  const lat: number[][] = zones.map(() => []);
  const brakeMin = zones.map(() => 0);
  const driveMax = zones.map(() => 0);
  for (let i = 0; i < n; i++) {
    const v = ref.vRefMs[i];
    const loss = lossDecelMs2(p.machine, v) / G;
    const z = zoneOwnerAt(zones, i);
    if (z >= 0) lat[z].push((v * v * Math.abs(line.curvature[i])) / G);
    const b = brakeOwnerAt(zones, i);
    if (b >= 0) brakeMin[b] = Math.min(brakeMin[b], ref.aRefG[i] + loss);
    const d = driveOwnerAt(zones, i);
    if (d >= 0) driveMax[d] = Math.max(driveMax[d], ref.aRefG[i] + loss);
  }
  return zones.map((_, k) => {
    const out: CornerRider = {};
    const l = lat[k].sort((a, b) => a - b);
    if (l.length) {
      const need = l[Math.min(l.length - 1, Math.floor(0.95 * l.length))];
      out.sLat = clamp(invert((s) => muY * gripFraction(s, 'lat'), need, 0.1, 1), 0.1, 1);
      if (tanLean(p.rider.leanUsage) < need) out.leanUsage = invert(tanLean, need, 0, 1);
    }
    if (brakeMin[k] < -0.2) out.sBrake = clamp(invert((s) => muX * gripFraction(s, 'long'), -brakeMin[k], 0.1, 1), 0.1, 1);
    if (driveMax[k] > 0.1) {
      const sd = clamp(invert((s) => muX * gripFraction(s, 'long'), driveMax[k], 0.1, 1), 0.1, 1);
      if (sd < p.rider.sDrive) out.sDrive = sd;
    }
    return out;
  });
}

/** Lap-wide rider from A / R and pinned values (everything else derived). */
function lapRider(base: RiderParams, tyre: SimParams['tyre'], A: number, R: number, pinned: Partial<Record<DerivedRiderKey, number>>): RiderParams {
  const overrides = Object.keys(pinned) as DerivedRiderKey[];
  const r: RiderParams = { ...base, aggressiveness: A, risk: R, overrides, ...pinned };
  return deriveRider(r, tyre);
}

/** Regularisation of one corner's overrides. */
function regOf(c: CornerRider | undefined, lap: RiderParams): number {
  if (!c) return 0;
  let s = 0;
  for (const [key, v] of Object.entries(c) as [CornerRiderKey, number][]) {
    if (v === undefined) continue;
    const d = (v - lapValue(lap, key)) / range(key);
    s += REG * d * d;
  }
  return s;
}

/**
 * Fit the rider to a recorded lap (see the header). Synchronous; ≤ `budgetMs`
 * of search (plus the line builds and the final ride).
 */
export function fitRiderToLap(track: TrackModel, corridor: Corridor | undefined, params: SimParams, lapRef: LapReference, opts: RiderFitOptions): RiderFitResult {
  const now = opts.now ?? (() => Date.now());
  const t0 = now();
  const budget = Number.isFinite(opts.budgetMs) && opts.budgetMs > 0 ? opts.budgetMs : DEFAULT_BUDGET_MS;
  const progress = opts.onProgress ?? (() => {});
  const W = { ...DEFAULT_FIT_WEIGHTS, ...opts.weights };
  const elapsed = (): number => now() - t0;
  const p0 = clampParams(params);

  progress({ frac: 0.01, stage: 'reference' });
  const ref = referenceForFit(track, corridor, p0, lapRef);

  // the fit starts from the user's line settings, no pins, no corner overrides
  const { corners: _c, slideOut: _s, ...riderBase } = p0.rider;
  void _c;
  void _s;
  const base0: RiderParams = { ...riderBase, overrides: [] };
  const withRider = (rider: RiderParams): SimParams => ({ machine: p0.machine, tyre: p0.tyre, rider });

  let evaluations = 0;
  // ---- the base (lap-wide) line, cached per lap-wide rider -----------------
  const lineCache = new Map<string, { line: Line; zones: CornerZone[] }>();
  const baseLine = (rider: RiderParams): { line: Line; zones: CornerZone[] } => {
    const { corners: _x, ...lw } = rider;
    void _x;
    const key = JSON.stringify(lw);
    let hit = lineCache.get(key);
    if (!hit) {
      const line = buildLine(track, corridor, withRider(rider));
      hit = { line, zones: cornerZones(line, track) };
      lineCache.set(key, hit);
    }
    return hit;
  };

  /** One evaluation: the rider mode's own ride on a fixed base line; per-corner error (+ regularisation, + the lap term). */
  const evaluate = (rider: RiderParams, base: { line: Line; zones: CornerZone[] }): { err: Float64Array; line: Line; env: Envelope } => {
    evaluations++;
    const p = withRider(rider);
    const zones = base.zones;
    const line = riderLineOn(track, corridor, base.line, p, zones);
    const env = rideOn(line, zones, p).env;
    const owners = ownersFor(zones, line.points.length);
    const t = errorTerms(ref, owners, zones.length, line, env, W);
    const lapTerm = W.time > 0 && zones.length ? (W.time * ((env.lapTimeS - ref.refLapTimeS) / TIME_SIGMA) ** 2) / zones.length : 0;
    zones.forEach((z, k) => (t.err[k] += regOf(rider.corners?.[z.n], rider) + lapTerm));
    return { err: t.err, line, env };
  };
  const ownersCache = new Map<CornerZone[], Int16Array>();
  const ownersFor = (zones: CornerZone[], n: number): Int16Array => {
    let o = ownersCache.get(zones);
    if (!o) {
      o = errorOwners(zones, n);
      ownersCache.set(zones, o);
    }
    return o;
  };
  const total = (e: Float64Array): number => e.reduce((a, b) => a + b, 0);

  // ---- error before: the user's rider as it is -----------------------------
  progress({ frac: 0.03, stage: 'line' });
  const userBase = baseLine(p0.rider);
  const errorBefore = total(evaluate(p0.rider, userBase).err);

  // budget shares: stage 1 ≤ 40 %, stage 2 the rest
  const stage1End = 0.4 * budget;
  let A = p0.rider.aggressiveness;
  let R = p0.rider.risk;
  let pinned: Partial<Record<DerivedRiderKey, number>> = {};
  const riderOf = (a: number, r: number, pin: Partial<Record<DerivedRiderKey, number>>): RiderParams => lapRider(base0, p0.tyre, a, r, pin);
  let rider = riderOf(A, R, pinned);
  let best = Infinity;

  /** Pattern search on pinned keys over a fixed line; returns the evaluations used. */
  const tunePinned = (keys: readonly (CornerRiderKey & DerivedRiderKey)[], line: { line: Line; zones: CornerZone[] }, until: number, maxRounds: number): void => {
    best = total(evaluate(rider, line).err);
    const steps = keys.map((k) => 0.1 * range(k));
    for (let round = 0; round < maxRounds && elapsed() < until; round++) {
      let any = false;
      keys.forEach((key, q) => {
        if (steps[q] < KEEP_FRAC * range(key) || elapsed() >= until) return;
        const [lo, hi] = CORNER_RIDER_BOUNDS[key];
        for (const sign of [1, -1]) {
          const v = clamp(rider[key] + sign * steps[q], lo, hi);
          if (v === rider[key]) continue;
          const pin = { ...pinned, [key]: v };
          const rr = riderOf(A, R, pin);
          const e = total(evaluate(rr, line).err);
          if (e < best - 1e-9) {
            best = e;
            pinned = pin;
            rider = rr;
            steps[q] *= 1.5;
            any = true;
            return;
          }
        }
        steps[q] *= 0.5;
      });
      if (!any && steps.every((st, q) => st < KEEP_FRAC * range(keys[q]))) break;
    }
  };

  // ---- stage 1a: A / R grid on the user's line ----------------------------
  for (let a = 0; a <= 1.0001; a += 0.2) {
    for (let r = 0; r <= 1.0001; r += 0.2) {
      const e = total(evaluate(riderOf(a, r, pinned), userBase).err);
      if (e < best) {
        best = e;
        A = a;
        R = r;
      }
    }
  }
  rider = riderOf(A, R, pinned);
  progress({ frac: 0.06, stage: `A ${A.toFixed(2)} · R ${R.toFixed(2)}`, error: best });

  // ---- stage 1b: the pinned keys on that line -----------------------------
  tunePinned(PINNED_KEYS, baseLine(rider), 0.15 * budget, 8);
  progress({ frac: 0.15, stage: 'lap-wide keys', error: best });

  // ---- stage 1c: the line style κ (measured path only) --------------------
  // every candidate line gets its own lateral keys re-tuned first: a rounder
  // line at the same sLat is simply faster, which is not what is compared
  if (ref.pathTrusted) {
    const start = { kappa: base0.kappa, pinned, rider, best: Infinity };
    let pick = start;
    const cands = [0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1];
    for (const k of cands) {
      if (elapsed() >= 0.3 * budget) break;
      base0.kappa = k;
      pinned = start.pinned;
      rider = riderOf(A, R, pinned);
      tunePinned(['sLat', 'leanUsage'], baseLine(rider), 0.3 * budget, 3);
      if (best < pick.best) pick = { kappa: k, pinned, rider, best };
    }
    base0.kappa = pick.kappa;
    pinned = pick.pinned;
    rider = riderOf(A, R, pinned);
    best = pick.best;
    progress({ frac: 0.3, stage: `line style κ ${pick.kappa.toFixed(3)}`, error: best });
  }

  // ---- stage 1d: refine A / R (0.1 → 0.05) on that line --------------------
  {
    const line1 = baseLine(rider);
    best = total(evaluate(rider, line1).err);
    for (const step of [0.1, 0.05]) {
      let moved = true;
      while (moved && elapsed() < 0.33 * budget) {
        moved = false;
        for (const [da, dr] of [[step, 0], [-step, 0], [0, step], [0, -step]]) {
          const a = clamp(A + da, 0, 1);
          const r = clamp(R + dr, 0, 1);
          if (a === A && r === R) continue;
          const e = total(evaluate(riderOf(a, r, pinned), line1).err);
          if (e < best - 1e-9) {
            best = e;
            A = a;
            R = r;
            moved = true;
            break;
          }
        }
      }
    }
    rider = riderOf(A, R, pinned);
  }

  // ---- stage 1e: the pinned keys once more ---------------------------------
  tunePinned(PINNED_KEYS, baseLine(rider), stage1End, 12);
  {
    // drop pins that did not really move off the derived value
    const derived = riderOf(A, R, {});
    for (const key of Object.keys(pinned) as (CornerRiderKey & DerivedRiderKey)[]) {
      if (Math.abs(pinned[key]! - derived[key]) <= KEEP_FRAC * range(key)) delete pinned[key];
    }
    rider = riderOf(A, R, pinned);
  }
  progress({ frac: 0.4, stage: `A ${A.toFixed(2)} · R ${R.toFixed(2)} · κ ${rider.kappa.toFixed(2)}`, error: best });

  // ---- stage 2: per corner, on the final lap-wide line ---------------------
  progress({ frac: 0.4, stage: 'corner line' });
  const base2 = baseLine(rider);
  const zones = base2.zones;
  const K = zones.length;
  const corners: CornerRiders = {};
  let cur: RiderParams = { ...rider, corners };
  let e = evaluate(cur, base2).err;
  const order = zones.map((_, k) => k).sort((a, b) => zones[a].iApex - zones[b].iApex);
  const prevK = new Int32Array(K);
  const nextK = new Int32Array(K);
  order.forEach((k, r) => {
    prevK[k] = order[(r - 1 + K) % K];
    nextK[k] = order[(r + 1) % K];
  });
  const local = (err: Float64Array, k: number): number => err[prevK[k]] + err[k] + err[nextK[k]];
  // a slide out only on a measured path and where the reference brakes into the corner
  const slideOk = zones.map((z) => {
    if (!ref.pathTrusted) return false;
    const entry = slideEntry(base2.line, z);
    return entry.length > 0 && ref.vRefMs[entry[0].i] - ref.vRefMs[z.iApex] >= SLIDE_MIN_DROP_MS;
  });
  // per-corner starting values from the reference, kept corner by corner where they help
  {
    const init = cornerInit(ref, base2.line, zones, withRider(cur));
    for (const k of order) {
      if (elapsed() >= budget) break;
      const c = init[k];
      if (!Object.keys(c).length) continue;
      const trialCorners: CornerRiders = { ...corners, [zones[k].n]: { ...corners[zones[k].n], ...c } };
      const r = evaluate({ ...cur, corners: trialCorners }, base2);
      if (total(r.err) < total(e) - 1e-9) {
        Object.assign(corners, trialCorners);
        cur = { ...cur, corners };
        e = r.err;
      }
    }
    progress({ frac: 0.38, stage: 'corner starting values', error: total(e) });
  }
  // ---- stage 2a: every corner at once ------------------------------------
  // One evaluation moves a key in ALL corners; each corner keeps the move
  // where its own stretch (and its neighbours') improved, and the merged move
  // is committed when the lap total fell too. Corners are nearly independent,
  // so one solve serves sixteen of them; a step that helps nowhere halves.
  {
    const gSteps = CORNER_FIT_KEYS.map((k) => 0.15 * range(k));
    const until = elapsed() + 0.45 * Math.max(0, budget - elapsed());
    for (let round = 0; round < 12 && elapsed() < until; round++) {
      let live = false;
      for (let q = 0; q < CORNER_FIT_KEYS.length && elapsed() < until; q++) {
        const key = CORNER_FIT_KEYS[q];
        if (gSteps[q] < KEEP_FRAC * range(key)) continue;
        live = true;
        const [lo, hi] = CORNER_RIDER_BOUNDS[key];
        let improved = false;
        for (const sign of [1, -1]) {
          const trialCorners: CornerRiders = { ...corners };
          zones.forEach((z, k) => {
            if (key === 'slideOut' && !slideOk[k]) return;
            const v0 = corners[z.n]?.[key] ?? lapValue(cur, key);
            const v = clamp(v0 + sign * gSteps[q], lo, hi);
            if (v !== v0) trialCorners[z.n] = { ...corners[z.n], [key]: v };
          });
          const rT = evaluate({ ...cur, corners: trialCorners }, base2);
          const merged: CornerRiders = { ...corners };
          let any = false;
          zones.forEach((z, k) => {
            if (trialCorners[z.n] !== corners[z.n] && local(rT.err, k) < local(e, k) - 1e-9) {
              merged[z.n] = trialCorners[z.n];
              any = true;
            }
          });
          if (!any) continue;
          const rM = evaluate({ ...cur, corners: merged }, base2);
          if (total(rM.err) < total(e) - 1e-9) {
            for (const z of zones) if (merged[z.n]) corners[z.n] = merged[z.n];
            cur = { ...cur, corners };
            e = rM.err;
            improved = true;
            break;
          }
        }
        gSteps[q] *= improved ? 1.2 : 0.5;
      }
      progress({ frac: 0.4 + 0.25 * Math.min(1, elapsed() / Math.max(1, until)), stage: `corners together (round ${round + 1})`, error: total(e) });
      if (!live) break;
    }
  }

  // ---- stage 2b: corner by corner -------------------------------------------
  const steps = zones.map(() => CORNER_FIT_KEYS.map((k) => 0.1 * range(k)));
  // two rounds always (budget permitting), more while time is left
  const ROUNDS = 6;
  const MIN_ROUNDS = 2;
  const stage2Start = elapsed();
  const stage2Budget = Math.max(0, budget - stage2Start);
  let tries = 0;
  const totalTries = MIN_ROUNDS * K * CORNER_FIT_KEYS.length;
  outer: for (let round = 0; round < ROUNDS; round++) {
    if (round >= MIN_ROUNDS && steps.every((row, k) => row.every((st, q) => st < KEEP_FRAC * range(CORNER_FIT_KEYS[q]) || (CORNER_FIT_KEYS[q] === 'slideOut' && !slideOk[k])))) break;
    for (const k of order) {
      const z = zones[k];
      for (let q = 0; q < CORNER_FIT_KEYS.length; q++) {
        tries++;
        if (elapsed() >= budget) break outer;
        const key = CORNER_FIT_KEYS[q];
        if (key === 'slideOut' && !slideOk[k]) continue;
        const [lo, hi] = CORNER_RIDER_BOUNDS[key];
        const curV = corners[z.n]?.[key] ?? lapValue(cur, key);
        let improved = false;
        for (const sign of [1, -1]) {
          const v = clamp(curV + sign * steps[k][q], lo, hi);
          if (v === curV) continue;
          const trialCorners: CornerRiders = { ...corners, [z.n]: { ...corners[z.n], [key]: v } };
          const trial: RiderParams = { ...cur, corners: trialCorners };
          const r = evaluate(trial, base2);
          if (local(r.err, k) < local(e, k) - 1e-9 && total(r.err) < total(e) - 1e-9) {
            Object.assign(corners, trialCorners);
            cur = { ...cur, corners };
            e = r.err;
            improved = true;
            break;
          }
        }
        steps[k][q] *= improved ? 1.5 : 0.5;
        if (tries % 8 === 0) {
          const frac = Math.max(tries / totalTries, stage2Budget > 0 ? (elapsed() - stage2Start) / stage2Budget : 1);
          progress({ frac: 0.65 + 0.33 * Math.min(1, frac), stage: `corners (round ${round + 1}) · ${z.name}`, error: total(e) });
        }
      }
    }
  }

  // ---- result: keep only corner values that really moved -------------------
  const kept: CornerRiders = {};
  for (const z of zones) {
    const c = corners[z.n];
    if (!c) continue;
    const out: CornerRider = {};
    for (const [key, v] of Object.entries(c) as [CornerRiderKey, number][]) {
      if (Math.abs(v - lapValue(rider, key)) > KEEP_FRAC * range(key)) out[key] = v;
    }
    if (Object.keys(out).length) kept[z.n] = out;
  }
  const fitted: RiderParams = { ...rider, corners: kept };
  const pFit = withRider(fitted);
  const line = riderLineOn(track, corridor, base2.line, pFit, zones);
  const ride = rideOn(line, zones, pFit);
  evaluations++;
  const owners = errorOwners(zones, line.points.length);
  const errorAfter = total(errorTerms(ref, owners, K, line, ride.env, W).err);
  const rows = riderFitRows(ref, zones, line, ride.env, pFit);
  const ms = elapsed();
  progress({ frac: 1, stage: 'done', error: errorAfter });
  return {
    rider: fitted,
    ref,
    zones,
    rows,
    lapTimeS: ride.env.lapTimeS,
    refOnLineS: refTimeOnLine(line, ref.vRefMs),
    stats: { evaluations, errorBefore, errorAfter, ms },
  };
}

export type { CornerZone };
