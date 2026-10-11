// Per-corner metrics on a MEASURED (or simulated) lap trace.
//
// Spec v2 §2.4 says the corner segmentation that `src/sim/corners.ts` runs on
// the QSS speed profile applies to real data with the same thresholds (R3
// §3.3 note ii). This is that segmentation re-implemented on a measured speed
// trace — deliberately NOT an import of `findCorners`, which works on a `Line`
// and its curvature; a measured lap has neither a trustworthy κ (notes
// 2026-10-10 §0) nor the QSS envelope. Both sides of the validation table go
// through these functions so the real lap and the simulated lap are measured
// the same way.
//
// Everything is sampling-agnostic: the BMW/R6 references come on a 1 m grid,
// the Ducati DDA export at 10 Hz. Crossing times are linearly interpolated so
// a 0.3 s build is still resolvable at 10 Hz.
import { derivative, savitzkyGolay } from '../../src/core/filters';

const G = 9.81;

/**
 * Thresholds, spec v2 §2.4 / R3 §3.3. All "öneri" there; W4 measures them
 * against the reference laps (the validation-baseline note) rather than
 * tuning them here.
 */
export const CORNER_DEFAULTS = {
  /** Minimum corner prominence, km/h (R3 §3.3 dV_min, öneri). */
  promMinKmh: 8,
  /** ...or this fraction of the apex speed, whichever is larger (öneri). */
  promFrac: 0.05,
  /** Tyre μ for the "no room for full throttle" merge, a_drive = 0.5·μ·g (plan W3 Task 3.1). */
  muDrive: 1.33,
  /** A braking event on real data: tyre g below this ... (R3 §3.2 table, B row) */
  brakeG: -0.2,
  /** ... for at least this long, seconds. */
  brakeMinS: 0.3,
} as const;

export interface CornerFindOpts {
  promMinKmh?: number;
  promFrac?: number;
  muDrive?: number;
  brakeG?: number;
  brakeMinS?: number;
  /** Elapsed time per sample. Integrated from distance and speed when absent. */
  tS?: ArrayLike<number>;
  /**
   * Longitudinal g carried by the TYRE (total minus aero/rolling losses) per
   * sample. When given, a corner has a brake event only if this stays below
   * `brakeG` for `brakeMinS`; without it, any prominent dip counts as braked.
   */
  gTyre?: ArrayLike<number>;
}

export interface SpeedCorner {
  /** Speed apex: the minimum of the section. */
  iA: number;
  /** Highest speed between the previous section's apex and this one. */
  iEntry: number;
  /** Highest speed between this apex and the next section's apex. */
  iExit: number;
  sM: number;
  minKmh: number;
  entryKmh: number;
  prominenceKmh: number;
  hasBrake: boolean;
  /** Apex indices of every prominent minimum merged into this section. */
  members: number[];
}

/** Elapsed time from distance and speed (trapezoid in 1/v), seconds. */
export function timeFromSpeed(speedKmh: ArrayLike<number>, distM: ArrayLike<number>): Float64Array {
  const n = speedKmh.length;
  const t = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const v0 = Math.max(0.5, speedKmh[i - 1] / 3.6);
    const v1 = Math.max(0.5, speedKmh[i] / 3.6);
    t[i] = t[i - 1] + ((distM[i] - distM[i - 1]) * (1 / v0 + 1 / v1)) / 2;
  }
  return t;
}

/** Local minima of `v`; a plateau counts once, at its first sample. */
function localMinima(v: ArrayLike<number>): number[] {
  const out: number[] = [];
  const n = v.length;
  for (let i = 1; i < n - 1; i++) {
    if (!(v[i] < v[i - 1])) continue;
    let j = i;
    while (j < n - 1 && v[j + 1] === v[i]) j++;
    if (j < n - 1 && v[j + 1] > v[i]) out.push(i);
    i = j;
  }
  return out;
}

/**
 * Topographic prominence of a minimum: walk each way until the trace goes
 * LOWER than the minimum (or the trace ends), take the highest point on each
 * walk, and the prominence is the lower of the two highs minus the minimum.
 */
function prominence(v: ArrayLike<number>, i: number): number {
  const n = v.length;
  let left = v[i];
  for (let j = i - 1; j >= 0 && v[j] >= v[i]; j--) if (v[j] > left) left = v[j];
  let right = v[i];
  for (let j = i + 1; j < n && v[j] >= v[i]; j++) if (v[j] > right) right = v[j];
  return Math.min(left, right) - v[i];
}

function argMax(v: ArrayLike<number>, a: number, b: number): number {
  let k = a;
  for (let i = a; i <= b; i++) if (v[i] > v[k]) k = i;
  return k;
}

/** True when `g` stays below `thresh` for at least `minS` somewhere in [a, b]. */
function hasRunBelow(g: ArrayLike<number>, tS: ArrayLike<number>, a: number, b: number, thresh: number, minS: number): boolean {
  let start = -1;
  for (let i = a; i <= b; i++) {
    if (g[i] < thresh) {
      if (start < 0) start = i;
      if (tS[i] - tS[start] >= minS - 1e-9) return true;
    } else start = -1;
  }
  return false;
}

/**
 * Corner sections on a speed trace (spec v2 §2.4 steps 1, 2 and 4, on real
 * data). Non-circular: the lap is assumed to start and end on a straight,
 * which holds for every file here (the start line is on the main straight).
 */
export function findSpeedCorners(
  speedKmh: ArrayLike<number>,
  distM: ArrayLike<number>,
  opts: CornerFindOpts = {},
): SpeedCorner[] {
  const o = { ...CORNER_DEFAULTS, ...opts };
  const v = speedKmh;
  const tS = opts.tS ?? timeFromSpeed(speedKmh, distM);
  const thr = (kmh: number): number => Math.max(o.promMinKmh, o.promFrac * kmh);

  // 1. prominent minima
  const kept = localMinima(v).filter((i) => prominence(v, i) >= thr(v[i]));

  // 2. merge neighbours: too little recovery between them, or no room to get
  //    back on full throttle (gap < v²/(2·a_drive), spec §2.4 literal).
  const aDrive = 0.5 * o.muDrive * G;
  const groups: number[][] = [];
  for (const i of kept) {
    const g = groups[groups.length - 1];
    if (g) {
      const last = g[g.length - 1];
      let peak = v[last];
      for (let k = last; k <= i; k++) if (v[k] > peak) peak = v[k];
      const hi = Math.max(v[last], v[i]);
      const recovery = peak - hi;
      const vMs = hi / 3.6;
      const gap = distM[i] - distM[last];
      if (recovery < thr(hi) || gap < (vMs * vMs) / (2 * aDrive)) {
        g.push(i);
        continue;
      }
    }
    groups.push([i]);
  }

  // 3-4. apex, entry/exit, brake flag
  const apexes = groups.map((g) => g.reduce((best, i) => (v[i] < v[best] ? i : best), g[0]));
  const n = v.length;
  return groups.map((members, k) => {
    const iA = apexes[k];
    const prevA = k > 0 ? apexes[k - 1] : 0;
    const nextA = k < apexes.length - 1 ? apexes[k + 1] : n - 1;
    const iEntry = argMax(v, prevA, iA);
    const iExit = argMax(v, iA, nextA);
    const hasBrake = opts.gTyre
      ? hasRunBelow(opts.gTyre, tS, iEntry, iA, o.brakeG, o.brakeMinS)
      : v[iEntry] - v[iA] >= thr(v[iA]);
    return {
      iA,
      iEntry,
      iExit,
      sM: distM[iA],
      minKmh: v[iA],
      entryKmh: v[iEntry],
      prominenceKmh: Math.min(v[iEntry], v[iExit]) - v[iA],
      hasBrake,
      members,
    };
  });
}

/** Time at which `y` crosses `level` between samples a and a+1 (linear). */
function crossT(tS: ArrayLike<number>, y: ArrayLike<number>, a: number, level: number): number {
  const y0 = y[a];
  const y1 = y[a + 1];
  const f = y1 !== y0 ? (level - y0) / (y1 - y0) : 0;
  return tS[a] + Math.min(1, Math.max(0, f)) * (tS[a + 1] - tS[a]);
}

export interface BrakeBuild {
  iPeak: number;
  /** Deepest tyre g in the window (negative). */
  peakG: number;
  /** Time the trace crosses -0.1 g on the way down, seconds. */
  onsetT: number;
  /** Time from -0.1 g to 90 % of the peak (R3 §6.2 step 3, §6.3 a), seconds. */
  buildS: number;
  /** 0.8·|peak| over the 10 %→90 % rise, g/s (same as `gTraceMetrics.riseRateGps`). */
  rateGps: number;
}

/**
 * The leading edge of the deepest braking in [i0, i1] of a tyre-g trace.
 *
 * `robustPct` replaces the single deepest sample by that percentile of the
 * braking samples (g < −0.2): on a 10 Hz differentiated wheel speed one
 * sample can sit 0.5 g past the plateau (a wheel hop, a quantisation step),
 * and both the peak and the 90 %-of-peak point would follow it.
 */
export function brakeBuild(
  tS: ArrayLike<number>,
  g: ArrayLike<number>,
  i0: number,
  i1: number,
  opts: { robustPct?: number } = {},
): BrakeBuild | null {
  let iPeak = i0;
  for (let i = i0; i <= i1; i++) if (g[i] < g[iPeak]) iPeak = i;
  let peakG = g[iPeak];
  if (opts.robustPct !== undefined) {
    const deep: number[] = [];
    for (let i = i0; i <= i1; i++) if (g[i] < -0.2) deep.push(g[i]);
    deep.sort((a, b) => a - b);
    if (deep.length) {
      peakG = percentile(deep, opts.robustPct);
      iPeak = i0;
      while (iPeak < i1 && !(g[iPeak] <= peakG)) iPeak++;
    }
  }
  if (!(peakG < -0.15)) return null;
  // last sample at or above -0.1 before the peak
  let k = iPeak;
  while (k > i0 && g[k] < -0.1) k--;
  if (g[k] < -0.1) return null; // the window starts mid-brake
  const onsetT = crossT(tS, g, k, -0.1);
  let k10 = iPeak;
  while (k10 > k && g[k10] < 0.1 * peakG) k10--;
  const t10 = crossT(tS, g, k10, 0.1 * peakG);
  let j = k;
  while (j < iPeak && !(g[j + 1] <= 0.9 * peakG)) j++;
  const t90 = crossT(tS, g, j, 0.9 * peakG);
  const buildS = t90 - onsetT;
  const rise = t90 - t10;
  return {
    iPeak,
    peakG,
    onsetT,
    buildS,
    rateGps: rise > 1e-3 ? (0.8 * Math.abs(peakG)) / rise : Number.NaN,
  };
}

/**
 * Brake BITE rate: the steepest descent of tyre g over any `spanS` window in
 * [i0, i1], g/s. This is how the 2.7/2.8 g/s anchor behind
 * `BRAKE_RISE_MAX_GPS` was read off the BMW/R6 top zones (longitudinal-g note
 * §3: the first ~0.4 s from brake-on). A rider who bites hard and then keeps
 * squeezing has a high bite rate and a low 10-90 % rate, and the simulator's
 * linear ramp can only match one of the two.
 */
export function biteRateGps(tS: ArrayLike<number>, g: ArrayLike<number>, i0: number, i1: number, spanS = 0.3): number {
  let best = Number.NaN;
  let j = i0;
  for (let i = i0; i <= i1; i++) {
    if (j < i) j = i;
    while (j < i1 && tS[j] - tS[i] < spanS - 1e-9) j++;
    const dtS = tS[j] - tS[i];
    if (dtS < spanS - 1e-9) break;
    const rate = (g[i] - g[j]) / dtS;
    if (!(rate <= best)) best = rate;
  }
  return best;
}

/** Index of the first sample at or after time t (clamped). */
function idxAt(tS: ArrayLike<number>, t: number): number {
  let lo = 0;
  let hi = tS.length - 1;
  if (t <= tS[0]) return 0;
  if (t >= tS[hi]) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (tS[mid] < t) lo = mid;
    else hi = mid;
  }
  return hi;
}

export interface PickUpOpts {
  /** Throttle counts as open above this, % (R3 §3.2 P row). */
  onPct?: number;
  /** ... and must not close again for this long, seconds. */
  holdS?: number;
  /** Search window around the speed apex, seconds (R3 §6.3 c: A−1 … A+3). */
  beforeS?: number;
  afterS?: number;
}

/**
 * Throttle pick-up relative to the speed apex (R3 §6.3 c): the first time in
 * [A − 1 s, A + 3 s] the throttle is above 10 % and stays there (never more
 * than 5 points below its pick-up value, never under 10 %) for 0.3 s.
 * Returns t_pick = t_P − t_A, which is negative for an early pick-up.
 */
export function throttlePickUp(
  tS: ArrayLike<number>,
  tps: ArrayLike<number>,
  iA: number,
  opts: PickUpOpts = {},
): { iP: number; tPickS: number } | null {
  const onPct = opts.onPct ?? 10;
  const holdS = opts.holdS ?? 0.3;
  const a = idxAt(tS, tS[iA] - (opts.beforeS ?? 1));
  const b = idxAt(tS, tS[iA] + (opts.afterS ?? 3));
  const last = tS.length - 1;
  for (let i = Math.max(1, a); i <= b; i++) {
    // an upward crossing: a throttle held open through the corner has no pick-up
    if (!(tps[i] > onPct) || tps[i - 1] > onPct) continue;
    if (tS[last] - tS[i] < holdS) return null;
    let ok = true;
    for (let j = i + 1; j < tS.length && tS[j] - tS[i] <= holdS + 1e-9; j++) {
      if (tps[j] < Math.max(onPct, tps[i] - 5)) {
        ok = false;
        break;
      }
    }
    if (ok) return { iP: i, tPickS: tS[i] - tS[iA] };
  }
  return null;
}

/**
 * Roll-on: time from the throttle passing 20 % to passing 90 % after the
 * pick-up (R3 §6.3 c), with interpolated crossings. Null if 90 % is not
 * reached before `iEnd` (a short straight: the rider never needed it).
 */
export function rollOn(
  tS: ArrayLike<number>,
  tps: ArrayLike<number>,
  iP: number,
  iEnd: number,
): { rollOnS: number; i20: number; i90: number } | null {
  let i20 = -1;
  for (let i = Math.max(1, iP); i <= iEnd; i++) {
    if (i20 < 0 && tps[i] >= 20) i20 = i;
    if (i20 >= 0 && tps[i] >= 90) {
      const t20 = tps[i20 - 1] < 20 ? crossT(tS, tps, i20 - 1, 20) : tS[i20];
      const t90 = crossT(tS, tps, i - 1, 90);
      return { rollOnS: t90 - t20, i20, i90: i };
    }
  }
  return null;
}

export interface TurnInRoll {
  iT: number;
  /** p90 of the roll rate INTO the corner over [T − 0.3 s, A], deg/s. */
  p90DegS: number;
  /** (|φ_A| − |φ_T|)/(t_A − t_T), deg/s. */
  meanDegS: number;
  leanTDeg: number;
  leanADeg: number;
}

/**
 * Turn-in roll rate (R3 §6.3 b). The derivative is taken of the SIGNED lean
 * (Savitzky-Golay, `sgWindow` samples, then a central difference) and only
 * then folded by the corner's direction — the derivative of |lean| reads a
 * flick through upright as two slow half-rolls. T is where |lean| last rose
 * through `leanTDeg` (8°) before the apex.
 */
export function rollRateTurnIn(
  tS: ArrayLike<number>,
  leanDeg: Float32Array,
  iA: number,
  opts: { sgWindow?: number; leanTDeg?: number; preS?: number } = {},
): TurnInRoll | null {
  const thresh = opts.leanTDeg ?? 8;
  if (!(Math.abs(leanDeg[iA]) > thresh)) return null;
  const sign = Math.sign(leanDeg[iA]);
  let iT = iA;
  while (iT > 0 && sign * leanDeg[iT - 1] > thresh) iT--;
  if (iT === 0) return null;
  const lo = Math.max(2, iT - 6);
  const hi = Math.min(leanDeg.length - 3, iA + 2);
  const seg = savitzkyGolay(leanDeg.slice(lo - 2, hi + 3), opts.sgWindow ?? 5);
  // uniform sampling assumed (the DDA export is a fixed 10 Hz grid)
  const dt = (tS[hi] - tS[lo]) / Math.max(1, hi - lo);
  const w = derivative(seg, dt);
  const t0 = tS[iT] - (opts.preS ?? 0.3);
  const rates: number[] = [];
  for (let i = lo; i <= Math.min(iA, hi); i++) if (tS[i] >= t0 - 1e-9) rates.push(sign * w[i - lo + 2]);
  if (!rates.length) return null;
  rates.sort((x, y) => x - y);
  const span = tS[iA] - tS[iT];
  return {
    iT,
    p90DegS: percentile(rates, 90),
    meanDegS: span > 0 ? (Math.abs(leanDeg[iA]) - Math.abs(leanDeg[iT])) / span : Number.NaN,
    leanTDeg: leanDeg[iT],
    leanADeg: leanDeg[iA],
  };
}

/** Linear-interpolated percentile of an ASCENDING array, p in 0..100. */
export function percentile(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length;
  if (!n) return Number.NaN;
  const k = ((n - 1) * p) / 100;
  const f = Math.floor(k);
  const c = Math.min(f + 1, n - 1);
  return sorted[f] + (sorted[c] - sorted[f]) * (k - f);
}

export function median(xs: ArrayLike<number>): number {
  const s = Array.from(xs).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return percentile(s, 50);
}

export interface CornerMetrics {
  corners: SpeedCorner[];
  /** Corner sections with a braking event (one per section by construction). */
  brakeEvents: number;
  minSpeeds: Array<{ sM: number; kmh: number }>;
  /** Build time (-0.1 g → 90 % of peak) of each braked section, seconds. */
  buildTimesS: number[];
  buildRatesGps: number[];
  /** Peak tyre g of each braked section. */
  brakePeaksG: number[];
  /** 25th percentile of the NEGATIVE total long_g samples (spec §4b), g. */
  longGp25: number;
  lapTimeS: number;
}

export interface CornerMetricsOpts extends Omit<CornerFindOpts, 'gTyre'> {
  /** Aero + rolling deceleration at speed v (m/s), in g; added back to get the tyre's share. */
  lossG?: (vMs: number) => number;
}

/**
 * The per-corner summary used by the validation table (plan W4 Task 4.1).
 * `longG` is TOTAL longitudinal g (what the files and the sim report);
 * the tyre share for event detection and build is `longG + lossG(v)`.
 */
export function cornerMetrics(
  speedKmh: ArrayLike<number>,
  distM: ArrayLike<number>,
  longG?: ArrayLike<number>,
  opts: CornerMetricsOpts = {},
): CornerMetrics {
  const n = speedKmh.length;
  const tS = opts.tS ?? timeFromSpeed(speedKmh, distM);
  let gTyre: Float32Array | undefined;
  if (longG) {
    gTyre = new Float32Array(n);
    for (let i = 0; i < n; i++) gTyre[i] = longG[i] + (opts.lossG ? opts.lossG(speedKmh[i] / 3.6) : 0);
  }
  const corners = findSpeedCorners(speedKmh, distM, { ...opts, tS, gTyre });
  const buildTimesS: number[] = [];
  const buildRatesGps: number[] = [];
  const brakePeaksG: number[] = [];
  if (gTyre) {
    for (const c of corners) {
      if (!c.hasBrake) continue;
      const b = brakeBuild(tS, gTyre, c.iEntry, c.iA);
      if (!b) continue;
      buildTimesS.push(b.buildS);
      buildRatesGps.push(b.rateGps);
      brakePeaksG.push(b.peakG);
    }
  }
  const neg: number[] = [];
  if (longG) for (let i = 0; i < n; i++) if (longG[i] < 0) neg.push(longG[i]);
  neg.sort((a, b) => a - b);
  return {
    corners,
    brakeEvents: corners.filter((c) => c.hasBrake).length,
    minSpeeds: corners.map((c) => ({ sM: c.sM, kmh: c.minKmh })),
    buildTimesS,
    buildRatesGps,
    brakePeaksG,
    longGp25: percentile(neg, 25),
    lapTimeS: tS[n - 1] - tS[0],
  };
}
