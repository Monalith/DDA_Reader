// Put a reference lap (reference.ts) on the simulated line's distance axis.
//
//   1. find each reference corner's apex on the sim line: `findCorners` on a
//      QSS solve when it returns the same number of sections with the same
//      directions; otherwise (Serres: 10 sections for 16 corners, chicanes
//      merge) the local maxima of the 20 m smoothed |κ| matched to the
//      reference corners IN ORDER and BY DIRECTION with a monotone dynamic
//      programme (nearest expected position wins). Opt-in (`mergePeaks`,
//      off by default, see `alignDefaults`): same-direction peaks
//      ≤ MERGE_GAP_M apart whose |κ| dips by < MERGE_DIP_FRAC of the smaller
//      peak between them are one corner (`peakGroups`): one reference corner
//      at most, its apex at the member nearest the expected position;
//   2. a piecewise-linear warp sInt → sSim through the start line, every apex
//      pair and the lap end, where sInt is the reference's speed-integrated
//      distance (reference.ts header: the template axis is not a distance);
//   3. the reference speed resampled onto every sim station.
//
// Residual stats: how far each apex pair sits from the uniform scale
// sSim = sInt·L_sim/L_int, i.e. how much local warping the alignment needed
// (the reference's stated position accuracy is ±15-20 m).
import { findCorners } from './corners';
import { smoothClosed } from './line';
import { atTemplate, type Reference } from './reference';
import { solve } from './solver';
import type { Line, SimParams } from './types';

export interface Alignment {
  /** Per reference corner: the sim line sample of its apex. */
  apexIdx: number[];
  /** How the apexes were found. */
  method: 'corners' | 'curvature';
  /** Warp knots: reference integrated distance → sim distance, metres. */
  knotsInt: number[];
  knotsSim: number[];
  /** L_sim / L_int. */
  scale: number;
  /** Template metre → sim metres. */
  toSim(sTemplateM: number): number;
  /** Sim metres → template metre. */
  toTemplate(sSimM: number): number;
  /** Reference speed on every sim station, m/s. */
  vRefMs: Float32Array;
  /** Reference clock on every sim station (the reference's own t), s. */
  tRefS: Float64Array;
  /** Per corner: apex pair minus the uniform scale, metres (signed). */
  residualM: number[];
  residual: { meanAbsM: number; maxAbsM: number; rmsM: number };
  notes: string[];
}

/** Smoothing of |κ| for the apex candidates, metres (corners.ts CURV_SMOOTH_M). */
const CURV_SMOOTH_M = 20;
/** Weakest curvature that counts as a corner apex candidate, 1/m (r = 600 m). */
const KAPPA_MIN = 1 / 600;
/** Search window around the expected apex position, metres (2× the stated ±20 m, plus scale error). */
const MATCH_WINDOW_M = 60;
/** A reference position further than this from the sim line is not used as a prior, metres. */
const GEO_PRIOR_MAX_M = 40;
/** DP cost of leaving a corner without a candidate (it then takes the |κ| peak near its expected position). */
const UNMATCHED_COST_M = 80;

function interp(xs: number[], ys: number[], x: number): number {
  const n = xs.length;
  if (x <= xs[0]) return ys[0] + (x - xs[0]) * ((ys[1] - ys[0]) / Math.max(1e-9, xs[1] - xs[0]));
  if (x >= xs[n - 1]) return ys[n - 1] + (x - xs[n - 1]) * ((ys[n - 1] - ys[n - 2]) / Math.max(1e-9, xs[n - 1] - xs[n - 2]));
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  const f = (x - xs[lo]) / Math.max(1e-9, xs[hi] - xs[lo]);
  return ys[lo] + f * (ys[hi] - ys[lo]);
}

/** Template metre at which the reference's integrated distance reaches sInt (monotone search). */
function templateAtInt(ref: Reference, sInt: number): number {
  const a = ref.sIntM;
  const n = a.length;
  if (sInt <= 0) return 0;
  if (sInt >= a[n - 1]) {
    // closing segment: linear to the lap end
    const span = Math.max(1e-9, ref.lengthIntM - a[n - 1]);
    return n - 1 + Math.min(1, (sInt - a[n - 1]) / span) * (ref.lengthM - (n - 1));
  }
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (a[mid] <= sInt) lo = mid;
    else hi = mid;
  }
  return lo + (sInt - a[lo]) / Math.max(1e-9, a[hi] - a[lo]);
}

/** Integrated distance at a template metre (the closing segment included). */
function intAtTemplate(ref: Reference, s: number): number {
  const n = ref.sIntM.length;
  if (s > n - 1) {
    const f = Math.min(1, (s - (n - 1)) / Math.max(1e-9, ref.lengthM - (n - 1)));
    return ref.sIntM[n - 1] + f * (ref.lengthIntM - ref.sIntM[n - 1]);
  }
  return atTemplate(ref.sIntM, s);
}

/** Signed curvature smoothed over CURV_SMOOTH_M. */
export function smoothedCurvature(line: Line): Float32Array {
  const n = line.points.length;
  const step = line.lengthM / Math.max(1, n);
  return smoothClosed(line.curvature.slice(0, n), CURV_SMOOTH_M / 2 / Math.max(0.05, step));
}

interface Candidate {
  i: number;
  s: number;
  dir: 1 | -1;
  k: number;
}

/**
 * Same-direction |κ| peaks closer than this, metres, whose |κ| between them
 * dips by less than MERGE_DIP_FRAC of the smaller peak, are ONE corner for the
 * matching (a centreline trace that wobbles inside one bend: Serres' second
 * right-hander after K11, one inside kerb on the video, two pist peaks —
 * docs/superpowers/notes/2026-10-11-bmw-k8-k12-reread.md §6.5).
 */
export const MERGE_GAP_M = 60;
export const MERGE_DIP_FRAC = 0.3;

/** One matchable corner: one or more merged same-direction |κ| peaks, in lap order. */
export interface PeakGroup {
  dir: 1 | -1;
  members: Array<{ i: number; s: number; k: number }>;
  /** Per adjacent member pair: (smaller peak − trough) / smaller peak. */
  dips: number[];
}

/**
 * Group the line's |κ| peaks (local maxima of the smoothed |κ| ≥ 1/600 m⁻¹)
 * by the MERGE_GAP_M / MERGE_DIP_FRAC rule; consecutive qualifying pairs
 * chain. Exported for tests and reports.
 */
export function peakGroups(line: Line, kS: Float32Array = smoothedCurvature(line)): PeakGroup[] {
  return groupCandidates(kS, curvatureCandidates(line, kS));
}

function troughBetween(kS: Float32Array, i0: number, i1: number, dir: 1 | -1): number {
  const n = kS.length;
  let m = Infinity;
  for (let i = i0; i !== i1; i = (i + 1) % n) m = Math.min(m, kS[i] * dir);
  return Math.min(m, kS[i1] * dir);
}

function groupCandidates(kS: Float32Array, cands: Candidate[], merge = true): PeakGroup[] {
  const out: PeakGroup[] = [];
  for (const c of cands) {
    const g = out[out.length - 1];
    const last = g?.members[g.members.length - 1];
    if (merge && g && g.dir === c.dir && last && c.s - last.s <= MERGE_GAP_M) {
      const small = Math.min(last.k, c.k);
      const dip = (small - troughBetween(kS, last.i, c.i, c.dir)) / small;
      if (dip < MERGE_DIP_FRAC) {
        g.members.push({ i: c.i, s: c.s, k: c.k });
        g.dips.push(dip);
        continue;
      }
    }
    out.push({ dir: c.dir, members: [{ i: c.i, s: c.s, k: c.k }], dips: [] });
  }
  return out;
}

function curvatureCandidates(line: Line, kS: Float32Array): Candidate[] {
  const n = kS.length;
  const out: Candidate[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.abs(kS[i]);
    if (a < KAPPA_MIN) continue;
    const p = Math.abs(kS[(i - 1 + n) % n]);
    const q = Math.abs(kS[(i + 1) % n]);
    if (a >= p && a > q && Math.sign(kS[i]) === Math.sign(kS[(i - 1 + n) % n])) {
      out.push({ i, s: line.cumDistM[i], dir: kS[i] > 0 ? 1 : -1, k: a });
    }
  }
  return out;
}

/** Peak signed-curvature sample of direction `dir` within ±w metres of s. */
function peakNear(line: Line, kS: Float32Array, s: number, dir: 1 | -1, w: number): number {
  const n = kS.length;
  let best = -1;
  let bestK = -Infinity;
  for (let i = 0; i < n; i++) {
    let d = Math.abs(line.cumDistM[i] - s);
    d = Math.min(d, line.lengthM - d);
    if (d > w) continue;
    const k = kS[i] * dir;
    if (k > bestK) {
      bestK = k;
      best = i;
    }
  }
  return best < 0 ? nearestSample(line, s) : best;
}

/** Nearest line sample to a lon/lat, and its distance, metres (local equirectangular). */
export function projectOnLine(line: Line, lon: number, lat: number): { i: number; distM: number } {
  const M = 111320;
  const c = Math.cos((lat * Math.PI) / 180);
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < line.points.length; i++) {
    const p = line.points[i];
    const d = Math.hypot((p[0] - lon) * M * c, (p[1] - lat) * M);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return { i: best, distM: bestD };
}

export function nearestSample(line: Line, s: number): number {
  const n = line.points.length;
  const ss = ((s % line.lengthM) + line.lengthM) % line.lengthM;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (line.cumDistM[mid] <= ss) lo = mid;
    else hi = mid;
  }
  return ss - line.cumDistM[lo] <= line.cumDistM[hi] - ss ? lo : hi;
}

/**
 * Monotone order-and-direction matching of reference apexes to peak groups.
 * State = the last USED group (−1: none yet); each corner either takes a
 * later group of its direction with a member within the window (cost =
 * distance from its expected position to the NEAREST member, which becomes
 * its apex) or stays unmatched (UNMATCHED_COST_M). A merged group serves one
 * reference corner at most.
 */
function dpMatch(expected: number[], dirs: Array<1 | -1>, groups: PeakGroup[]): Array<{ g: number; i: number } | null> {
  const K = expected.length;
  const C = groups.length;
  /** Nearest member of group c to s: [distance, sample]. */
  const nearest = (c: number, s: number): [number, number] => {
    let best: [number, number] = [Infinity, -1];
    for (const m of groups[c].members) {
      const d = Math.abs(m.s - s);
      if (d < best[0]) best = [d, m.i];
    }
    return best;
  };
  const INF = Number.POSITIVE_INFINITY;
  // dp over states s = last used candidate + 1 (0 = none)
  let dp = new Float64Array(C + 1).fill(INF);
  dp[0] = 0;
  const backState: Int32Array[] = [];
  const backPick: Int32Array[] = [];
  for (let k = 0; k < K; k++) {
    const next = new Float64Array(C + 1).fill(INF);
    const bs = new Int32Array(C + 1).fill(-1);
    const bp = new Int32Array(C + 1).fill(-1);
    for (let st = 0; st <= C; st++) {
      const base = dp[st];
      if (base === INF) continue;
      // unmatched
      if (base + UNMATCHED_COST_M < next[st]) {
        next[st] = base + UNMATCHED_COST_M;
        bs[st] = st;
        bp[st] = -1;
      }
      for (let c = st; c < C; c++) {
        if (groups[c].dir !== dirs[k]) continue;
        const [d] = nearest(c, expected[k]);
        if (d > MATCH_WINDOW_M) continue;
        const tot = base + d;
        if (tot < next[c + 1]) {
          next[c + 1] = tot;
          bs[c + 1] = st;
          bp[c + 1] = c;
        }
      }
    }
    dp = next;
    backState.push(bs);
    backPick.push(bp);
  }
  let st = 0;
  for (let i = 1; i <= C; i++) if (dp[i] < dp[st]) st = i;
  const out: Array<{ g: number; i: number } | null> = new Array(K).fill(null);
  for (let k = K - 1; k >= 0; k--) {
    const pick = backPick[k][st];
    out[k] = pick >= 0 ? { g: pick, i: nearest(pick, expected[k])[1] } : null;
    st = backState[k][st];
    if (st < 0) break;
  }
  return out;
}

export interface AlignOptions {
  /** Apply the MERGE_GAP_M / MERGE_DIP_FRAC peak merge in the |κ| matching (default `alignDefaults.mergePeaks`). */
  mergePeaks?: boolean;
  /**
   * The reference's lat/lon IS the line (a recorded lap's GPS, ridden as the
   * sim line): warp on its own path, a knot every PATH_KNOT_M projected onto
   * the line, and every apex where its position projects. No corner matching
   * (on a track model detected from GPS it pairs 10 turns with the wrong
   * |κ| peaks and maps T4…T10 onto one reference point).
   */
  pathOnLine?: boolean;
}

/** Knot spacing of the `pathOnLine` warp, metres of the reference path. */
const PATH_KNOT_M = 20;
/** A `pathOnLine` knot further than this from the line, or from the uniform scale, is skipped. */
const PATH_KNOT_MAX_OFF_M = 40;
const PATH_KNOT_MAX_SLIP_M = 150;

/**
 * Process-wide defaults for callers that cannot pass options (fitRider).
 *
 * `mergePeaks` is OFF: measured on the Serres pist lines with the BMW v2
 * reference (docs/superpowers/notes/2026-10-11-bmw-v2-fit.md §2), the rule
 * never merges the pair it was written for (the pist's 2071 / 2116 peaks:
 * 66-69 m apart, and a 41 % dip on the centreline), but it does merge K11's
 * own two peaks wherever they fall ≤ 60 m apart (centreline 56 m, race κ 0
 * kerb 0 at exactly 60 m), which takes the kerb-side peak away from K12 and
 * sends K12 back to the exit peak (2127 / 2147) the v2 correction removed.
 */
export const alignDefaults: Required<Pick<AlignOptions, 'mergePeaks'>> = { mergePeaks: false };

/**
 * Align a reference to a sim line. `params` only feeds the QSS solve that
 * `findCorners` segments.
 */
export function alignReference(ref: Reference, line: Line, params: SimParams, opts: AlignOptions = {}): Alignment {
  const mergePeaks = opts.mergePeaks ?? alignDefaults.mergePeaks;
  const notes: string[] = [];
  const L = line.lengthM;
  const scale = L / Math.max(1, ref.lengthIntM);
  const kS = smoothedCurvature(line);
  const K = ref.corners.length;
  const refInt = ref.corners.map((c) => intAtTemplate(ref, c.apexM));
  // Expected apex position on the sim line: the reference's own map position
  // projected onto the line when it has one close by (it places the CORNER
  // within ±15-20 m, which the speed-integrated distance does not: that one
  // drifts by up to ~50 m between the file's alignment anchors), else the
  // uniformly scaled integrated distance.
  let geoUsed = 0;
  const expected = ref.corners.map((c, k) => {
    if (ref.lon && ref.lat) {
      const kk = Math.min(ref.lon.length - 1, Math.max(0, Math.round(c.apexM)));
      const pr = projectOnLine(line, ref.lon[kk], ref.lat[kk]);
      if (pr.distM <= GEO_PRIOR_MAX_M) {
        geoUsed++;
        return line.cumDistM[pr.i];
      }
    }
    return refInt[k] * scale;
  });
  if (geoUsed) notes.push(`apex prior: the reference's map position for ${geoUsed}/${K} corners`);

  if (opts.pathOnLine && ref.lon && ref.lat) return alignOnPath(ref, line, refInt, expected, scale, notes);

  let apexIdx: number[] | null = null;
  let method: Alignment['method'] = 'curvature';
  // 1. findCorners, when it sees the same corners
  const qss = solve(line, params);
  const secs = findCorners(line, qss.v, params);
  if (secs.length === K) {
    const sorted = secs.map((c) => c.iAgeo).sort((a, b) => a - b);
    const ok = sorted.every((i, k) => {
      const d = Math.abs(line.cumDistM[i] - expected[k]);
      return Math.sign(kS[i]) === ref.corners[k].dir && d <= MATCH_WINDOW_M;
    });
    if (ok) {
      apexIdx = sorted;
      method = 'corners';
    }
  }
  if (!apexIdx) {
    notes.push(
      `findCorners found ${secs.length} sections for ${K} reference corners: apexes matched to |κ| peaks by order and direction`,
    );
    const groups = groupCandidates(kS, curvatureCandidates(line, kS), mergePeaks);
    const m = dpMatch(expected, ref.corners.map((c) => c.dir), groups);
    m.forEach((c, k) => {
      const g = c === null ? null : groups[c.g];
      if (g && g.members.length > 1) {
        notes.push(
          `${ref.corners[k].name}: |κ| peaks ${g.members.map((x) => x.s.toFixed(0)).join(' / ')} m merged as one corner ` +
            `(dip ${g.dips.map((x) => `${Math.round(100 * x)} %`).join(', ')} < ${100 * MERGE_DIP_FRAC} %, ≤ ${MERGE_GAP_M} m); apex at the nearer, ${line.cumDistM[c!.i].toFixed(0)} m`,
        );
      }
    });
    apexIdx = m.map((c, k) => {
      if (c !== null) return c.i;
      notes.push(`${ref.corners[k].name}: no ${ref.corners[k].dir > 0 ? 'left' : 'right'} |κ| peak within ${MATCH_WINDOW_M} m; took the peak near the expected position`);
      return peakNear(line, kS, expected[k], ref.corners[k].dir, 30);
    });
  }

  // 2. warp knots, strictly increasing in both axes
  const knotsInt: number[] = [0];
  const knotsSim: number[] = [0];
  for (let k = 0; k < K; k++) {
    const a = refInt[k];
    const b = line.cumDistM[apexIdx[k]];
    if (a > knotsInt[knotsInt.length - 1] + 1 && b > knotsSim[knotsSim.length - 1] + 1 && a < ref.lengthIntM - 1 && b < L - 1) {
      knotsInt.push(a);
      knotsSim.push(b);
    } else {
      notes.push(`${ref.corners[k].name}: apex pair out of order, left out of the warp`);
    }
  }
  knotsInt.push(ref.lengthIntM);
  knotsSim.push(L);
  return resampled(ref, line, { apexIdx, method, knotsInt, knotsSim, scale, expected, notes });
}

/** `pathOnLine`: the warp from the reference's own path projected onto the line. */
function alignOnPath(ref: Reference, line: Line, refInt: number[], expected: number[], scale: number, notes: string[]): Alignment {
  const L = line.lengthM;
  const knotsInt: number[] = [0];
  const knotsSim: number[] = [0];
  const lastM = ref.lon!.length - 1;
  let skipped = 0;
  for (let sT = PATH_KNOT_M; sT < lastM - PATH_KNOT_M / 2; sT += PATH_KNOT_M) {
    const a = intAtTemplate(ref, sT);
    const pr = projectOnLine(line, ref.lon![sT], ref.lat![sT]);
    const b = line.cumDistM[pr.i];
    if (
      pr.distM > PATH_KNOT_MAX_OFF_M ||
      Math.abs(b - a * scale) > PATH_KNOT_MAX_SLIP_M ||
      a <= knotsInt[knotsInt.length - 1] + 1 ||
      b <= knotsSim[knotsSim.length - 1] + 1 ||
      a >= ref.lengthIntM - 1 ||
      b >= L - 1
    ) {
      skipped++;
      continue;
    }
    knotsInt.push(a);
    knotsSim.push(b);
  }
  knotsInt.push(ref.lengthIntM);
  knotsSim.push(L);
  notes.push(`aligned on the reference's own path: ${knotsInt.length - 2} knots every ${PATH_KNOT_M} m${skipped ? `, ${skipped} skipped` : ''}`);
  // every apex where the warp puts it (its own path position)
  const toSimInt = (x: number): number => interp(knotsInt, knotsSim, x);
  const apexIdx = refInt.map((x) => nearestSample(line, toSimInt(x)));
  return resampled(ref, line, { apexIdx, method: 'curvature', knotsInt, knotsSim, scale, expected, notes });
}

/** The reference resampled onto the line through the warp, and its residuals. */
function resampled(
  ref: Reference,
  line: Line,
  w: { apexIdx: number[]; method: Alignment['method']; knotsInt: number[]; knotsSim: number[]; scale: number; expected: number[]; notes: string[] },
): Alignment {
  const { apexIdx, method, knotsInt, knotsSim, scale, expected, notes } = w;
  const n = line.points.length;
  const toSim = (sT: number): number => interp(knotsInt, knotsSim, intAtTemplate(ref, sT));
  const toTemplate = (sS: number): number => templateAtInt(ref, interp(knotsSim, knotsInt, sS));

  const vRefMs = new Float32Array(n);
  const tRefS = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const sT = toTemplate(line.cumDistM[i]);
    vRefMs[i] = atTemplate(ref.speedKmh, sT) / 3.6;
    tRefS[i] = atTemplate(ref.tS, sT);
  }

  const residualM = apexIdx.map((i, k) => line.cumDistM[i] - expected[k]);
  const abs = residualM.map(Math.abs);
  const residual = {
    meanAbsM: abs.reduce((a, b) => a + b, 0) / Math.max(1, abs.length),
    maxAbsM: Math.max(0, ...abs),
    rmsM: Math.sqrt(residualM.reduce((a, b) => a + b * b, 0) / Math.max(1, residualM.length)),
  };
  return { apexIdx, method, knotsInt, knotsSim, scale, toSim, toTemplate, vRefMs, tRefS, residualM, residual, notes };
}
