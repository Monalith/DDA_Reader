// Corner segmentation on a speed profile (spec v2 §2.4, research R3 §3.3).
//
// The owner's constraint #1 is ONE brake and ONE throttle transition per
// corner section. This module decides what a "section" is; `events.ts` then
// draws exactly one brake and one throttle event into each.
//
//   1. candidates = local minima of the speed profile (wrap-around, plateaus
//      collapsed to one candidate)
//   2. keep a candidate only if its PROMINENCE clears max(8 km/h, 5 % of its
//      speed): the per-sample speed wiggles a quasi-steady-state solve leaves
//      on a noisy curvature die here
//   3. merge neighbours with no room for a full-throttle phase between them
//      (chicane, corner complex) into ONE section; the lean flips inside it
//      are recorded, not turned into a second section
//   4. per section: A = slowest sample, A_geo = max |κ|, T/E where the 20 m
//      smoothed |κ| crosses k_frac of the section's peak, hasBrake from the
//      entry speed
//
// Pure: no allocation beyond a few O(n) arrays, no browser dependencies.
// Indices in the returned `Corner`s are line samples in [0, n); a section can
// straddle the start line, so their ORDER (B ≤ T < A ≤ P ≤ E) is cyclic.
import { smoothClosed } from './line';
import { G } from './solver';
import type { Corner, Line, SimParams } from './types';

/**
 * Turn-in / exit curvature fraction: T and E are where the smoothed |κ|
 * crosses this fraction of the section's peak |κ|.
 * Source: research R3 §3.2-3.3 (turn-in "κ tepe değerinin %25'i"); öneri,
 * W4 calibrates it against the BMW/R6/Ducati laps.
 */
export const K_FRAC = 0.25;

/**
 * Minimum prominence of a speed dip to count as a corner, m/s (8 km/h).
 * Source: research R3 §3.3 `dV_min = max(8 km/h, 0.05·v_local)`; öneri,
 * chosen so the 16 per-sample brake events v1 produced on Serres fall to the
 * 7-14 a real rider makes. W4 calibrates.
 */
export const PROM_MIN_MS = 8 / 3.6;

/** Relative prominence floor, fraction of the apex speed. Source: R3 §3.3 (öneri). */
export const PROM_FRAC = 0.05;

/**
 * Length scale the curvature is smoothed over before T/E/A_geo and the flips
 * are read off it, metres. Source: notes 2026-10-10 §2 / R3 §3.3 `L_k = 20 m`
 * (10 m is GPS noise, 20 m is the shortest real feature); öneri.
 */
const CURV_SMOOTH_M = 20;

/**
 * Drive acceleration used ONLY by the merge test's "room for a full-throttle
 * phase" distance `v²/(2·a_drive)`: half the tyre's friction, `μ·g·0.5`.
 * Source: plan W3 Task 3.1 (a `driveCapMs2`-free estimate, so this module
 * does not depend on the solver's caps); öneri.
 */
const MERGE_DRIVE_FRAC = 0.5;

/**
 * A speed minimum whose exit never recovers by the prominence threshold (it
 * runs straight into the next corner's braking zone) still counts as a corner
 * when the bike holds that speed, within the threshold, for at least this
 * long after it. Source: none measured — öneri; a sweeper held at the lateral
 * limit lasts several seconds, a QSS dip on a braking curve a fraction of one.
 */
const APEX_DWELL_S = 1.0;

/**
 * The short-straight merge only applies while the speed between the two
 * apexes stays within this fraction of the slower apex speed. Source: none
 * measured — öneri, set between the synthetic 60 m chicane (6.6 m/s over
 * 28 m/s = 0.23, one section by the plan's own test) and Serres' last S
 * (15.8 over 31.7 = 0.50, which a rider brakes into twice). W4 calibrates.
 */
const MERGE_MAX_RISE_FRAC = 0.3;

export interface CornerOpts {
  /** Turn-in/exit curvature fraction, default `K_FRAC` (0.25). */
  kFrac?: number;
  /** Absolute prominence floor, m/s, default `PROM_MIN_MS` (8 km/h = 2.22). */
  promMinMs?: number;
  /** Relative prominence floor, default `PROM_FRAC` (0.05). */
  promFrac?: number;
}

/**
 * Find the corner sections of one lap.
 *
 * @param line   the racing line (its signed curvature is read, 20 m smoothed)
 * @param v      the speed profile to segment, m/s, one per line sample —
 *               normally the QSS envelope `env.v`
 * @param params for the tyre μ (merge distance) and the throttle delay (the
 *               provisional `iP`; `events.ts` sets the real one)
 */
export function findCorners(line: Line, v: Float32Array, params: SimParams, opts: CornerOpts = {}): Corner[] {
  const n = Math.min(v.length, line.curvature.length);
  if (n < 5) return [];
  const kFrac = opts.kFrac ?? K_FRAC;
  const promMin = opts.promMinMs ?? PROM_MIN_MS;
  const promFrac = opts.promFrac ?? PROM_FRAC;
  const thrAt = (vv: number): number => Math.max(promMin, promFrac * vv);
  const nx = (i: number): number => (i + 1) % n;
  const pv = (i: number): number => (i - 1 + n) % n;

  // segment length ending at i, wrapping at the start line (as solver.ts)
  const ds = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const d = i === 0 ? line.lengthM - line.cumDistM[n - 1] : line.cumDistM[i] - line.cumDistM[i - 1];
    ds[i] = Math.max(0.05, d);
  }
  const stepM = line.lengthM / n;
  const kS = smoothClosed(line.curvature.slice(0, n), (CURV_SMOOTH_M / 2) / Math.max(0.05, stepM));
  const kAbs = new Float32Array(n);
  for (let i = 0; i < n; i++) kAbs[i] = Math.abs(kS[i]);

  // ---- 1. local minima, plateaus collapsed ------------------------------
  // Start the scan at the global maximum so no plateau straddles the seam.
  let iMax = 0;
  for (let i = 1; i < n; i++) if (v[i] > v[iMax]) iMax = i;
  const minima: number[] = [];
  {
    let k = 0;
    while (k < n) {
      const i0 = (iMax + k) % n;
      let len = 1;
      while (len < n && v[(i0 + len) % n] === v[i0]) len++;
      const before = v[pv(i0)];
      const after = v[(i0 + len) % n];
      if (len < n && before > v[i0] && after > v[i0]) minima.push(i0); // first sample of the plateau
      k += len;
    }
  }
  if (!minima.length) return [];

  // ---- 2. prominence ----------------------------------------------------
  // Topographic prominence (the scipy definition): walk each way until the
  // profile drops BELOW the candidate, tracking the highest speed passed; the
  // lower of the two highs, minus the candidate, is how far the bike had to
  // come down into it. A walk that goes a whole lap (the global minimum)
  // reports the lap maximum. This is what "bounded by the neighbouring minima"
  // means in the plan: bounded by the nearest LOWER one, so the slowest of a
  // jittered cluster gets the whole corner's prominence and the rest get
  // their tiny local one.
  //
  // DEVIATION from the spec's min(left, right) alone (documented in the
  // report): a corner whose exit runs straight into the braking zone of a
  // slower corner — the circuit fixture's 250 m sweeper, 120 m before a 60 m
  // right — never recovers speed on its RIGHT side (1.3 m/s there) and would
  // vanish, taking its brake event with it. So a candidate is also kept when
  // its ENTRY drop alone clears the threshold AND the bike dwells at that
  // speed (within the threshold) for `APEX_DWELL_S` afterwards: a held apex.
  // A momentary dip on a braking curve fails the dwell and still dies.
  const sideMax = (m: number, step: (i: number) => number): number => {
    const vm = v[m];
    let hi = vm;
    for (let k = 1, i = step(m); k < n; k++, i = step(i)) {
      if (v[i] < vm) break;
      if (v[i] > hi) hi = v[i];
    }
    return hi;
  };
  const dwellS = (m: number): number => {
    const vm = v[m];
    const tol = thrAt(vm);
    let t = 0;
    for (let k = 1, i = nx(m); k < n; k++, i = nx(i)) {
      if (Math.abs(v[i] - vm) >= tol) break;
      t += ds[i] / Math.max(1, 0.5 * (v[i] + v[pv(i)]));
    }
    return t;
  };
  const significant = (m: number): boolean => {
    const thr = thrAt(v[m]);
    const left = sideMax(m, pv) - v[m];
    if (left < thr) return false;
    const right = sideMax(m, nx) - v[m];
    return right >= thr || dwellS(m) >= APEX_DWELL_S;
  };
  const kept = minima.filter(significant).sort((a, b) => a - b);
  if (!kept.length) return [];
  const K = kept.length;

  /** Index of the highest speed strictly between a and b, walking forward (b === a: the whole lap). */
  const peakBetween = (a: number, b: number): number => {
    let best = nx(a);
    const len = b === a ? n - 1 : (b - a + n) % n - 1;
    for (let k = 0, i = nx(a); k < len; k++, i = nx(i)) if (v[i] > v[best]) best = i;
    return best;
  };
  // the speed peak after each kept minimum (between it and the next one)
  const peakAfter = kept.map((m, k) => peakBetween(m, kept[(k + 1) % K]));
  const peakBefore = (k: number): number => peakAfter[(k - 1 + K) % K];

  // own curvature peak of each minimum, over its own stretch
  const kPeakOwn = kept.map((_, k) => {
    let best = 0;
    for (let i = peakBefore(k); ; i = nx(i)) {
      if (kAbs[i] > best) best = kAbs[i];
      if (i === peakAfter[k]) break;
    }
    return best;
  });

  // ---- 3. merge ----------------------------------------------------------
  // Two consecutive minima are one section when the speed does not recover
  // between them (rise < threshold) OR when the straight between them — the
  // stretch where |κ| is below the turn-in fraction of the SMALLER of the two
  // corners' peaks — is shorter than the distance needed to build speed for a
  // full-throttle phase, v²/(2·a_drive), at the SLOWER of the two apexes.
  // Using the slower apex is what keeps a fast sweeper and the slow corner
  // after it apart (the sweeper's 57 m/s would ask for 250 m of straight) and
  // puts a 60 m chicane's two halves together.
  //
  // The short-straight rule also needs the speed to stay near the slower
  // apex in between (`MERGE_MAX_RISE_FRAC`): an S whose middle is a flip of
  // curvature but where the profile still climbs 15 m/s (Serres' last
  // complex, 32 → 48 → 32 m/s) is two corners to a rider, not one.
  //
  // Either way, only when the second apex is NOT a threshold slower than the
  // first: a section has ONE brake, and it ends at the section's first apex
  // (`events.ts`), so a second apex that needs a real brake of its own (the
  // sweeper → 60 m right case: 55.7 → 27 m/s) must start its own section.
  const mu = params.tyre.mu * params.tyre.gripScale;
  const aDrive = Math.max(0.5, mu * G * MERGE_DRIVE_FRAC);
  const mergeNext = new Array<boolean>(K).fill(false);
  if (K > 1) {
    for (let k = 0; k < K; k++) {
      const a = kept[k];
      const b = kept[(k + 1) % K];
      const vHi = Math.max(v[a], v[b]);
      const vLo = Math.min(v[a], v[b]);
      const rise = v[peakAfter[k]] - vHi;
      const kThr = kFrac * Math.min(kPeakOwn[k], kPeakOwn[(k + 1) % K]);
      let straight = 0;
      for (let i = nx(a); i !== b; i = nx(i)) if (kAbs[i] < kThr) straight += ds[i];
      const noSecondBrake = v[b] >= v[a] - thrAt(v[a]);
      const noRoom = straight < (vLo * vLo) / (2 * aDrive) && rise < MERGE_MAX_RISE_FRAC * vLo;
      mergeNext[k] = noSecondBrake && (rise < thrAt(vHi) || noRoom);
    }
  }
  // groups of consecutive kept minima (cyclic): start a group after every non-merge
  const groups: number[][] = [];
  if (mergeNext.every(Boolean)) {
    groups.push(kept.map((_, k) => k));
  } else {
    let start = 0;
    while (mergeNext[(start - 1 + K) % K]) start = (start + 1) % K; // first k whose predecessor does not merge into it
    let cur: number[] = [];
    for (let s = 0; s < K; s++) {
      const k = (start + s) % K;
      cur.push(k);
      if (!mergeNext[k]) {
        groups.push(cur);
        cur = [];
      }
    }
    if (cur.length) groups.push(cur);
  }

  // ---- 4. events per section --------------------------------------------
  const corners: Corner[] = [];
  for (const grp of groups) {
    const kFirst = grp[0];
    const kLast = grp[grp.length - 1];
    const firstMin = kept[kFirst];
    const lastMin = kept[kLast];
    const spanStart = peakBefore(kFirst);
    const spanEnd = peakAfter[kLast];
    const spanLen = spanStart === spanEnd ? n : (spanEnd - spanStart + n) % n;

    let iA = firstMin;
    for (const k of grp) if (v[kept[k]] < v[iA]) iA = kept[k];

    let iAgeo = spanStart;
    for (let s = 0, i = spanStart; s <= spanLen; s++, i = nx(i)) if (kAbs[i] > kAbs[iAgeo]) iAgeo = i;
    const kThr = kFrac * kAbs[iAgeo];

    // T: back from the first apex of the section to where |κ| falls under the fraction
    const backLimit = (firstMin - spanStart + n) % n;
    let iT = pv(firstMin);
    for (let s = 1; s < backLimit && kAbs[iT] >= kThr; s++) iT = pv(iT);
    // E: forward from the last apex, same threshold
    const fwdLimit = (spanEnd - lastMin + n) % n || n - 1;
    let iE = nx(lastMin);
    for (let s = 1; s < fwdLimit && kAbs[iE] >= kThr; s++) iE = nx(iE);

    // entry speed: the highest point on the way in
    const entryLen = (iA - spanStart + n) % n;
    let iEntry = spanStart;
    for (let s = 0, i = spanStart; s <= entryLen; s++, i = nx(i)) if (v[i] > v[iEntry]) iEntry = i;
    const hasBrake = v[iEntry] > v[iA] + promMin;

    // provisional B: where the profile starts falling into the apex (QSS
    // brake onset), never after T; events.ts replaces it with the template's
    let iB = iT;
    if (hasBrake) {
      let i = iA;
      const lim = (iA - spanStart + n) % n;
      for (let s = 0; s < lim && v[pv(i)] >= v[i]; s++) i = pv(i);
      if ((iA - i + n) % n > (iA - iT + n) % n) iB = i;
    }

    // provisional P: the throttle delay after A at the profile's own speed, ≤ E
    let iP = iA;
    {
      let t = 0;
      const lim = (iE - iA + n) % n;
      for (let s = 0; s < lim && t < params.rider.throttleDelayS; s++) {
        const j = nx(iP);
        t += ds[j] / Math.max(1, 0.5 * (v[iP] + v[j]));
        iP = j;
      }
    }

    // flips: sign changes between significant (|κ| ≥ threshold) stretches
    const flips: number[] = [];
    {
      let lastSig = 0;
      let lastZero = iT;
      const len = (iE - iT + n) % n;
      for (let s = 0, i = iT; s <= len; s++, i = nx(i)) {
        if (s > 0 && Math.sign(kS[i]) !== Math.sign(kS[pv(i)])) lastZero = i;
        if (kAbs[i] >= kThr) {
          const sg = Math.sign(kS[i]);
          if (lastSig !== 0 && sg !== lastSig) flips.push(lastZero);
          lastSig = sg;
        }
      }
    }

    corners.push({ iB, iT, iA, iAgeo, iP, iE, dir: kS[iAgeo] < 0 ? -1 : 1, hasBrake, flips });
  }
  corners.sort((a, b) => a.iA - b.iA);
  return corners;
}
