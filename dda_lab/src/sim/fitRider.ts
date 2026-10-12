// The reference-fit rider (solver mode `fit`).
//
// Owner's requirement (2026-10-11): "first model the BMW rider from the speed
// and line in every corner; once that model fits in time and speed, compute
// ALL other data from it" — and "the rider must be able to reach the same
// lateral g comfortably".
//
// The rider is a set of PER-CORNER caps on the QSS solver (no new solver;
// `solve(line, params, caps)` with per-station `EnvelopeCaps`):
//
//   lateral  inside corner k's zone, one cap per |κ| segment (see the
//            'segments' note at the lateral model; `aLatG` is the apex
//            segment's); between zones the larger neighbour, never below the
//            reference there (a straight is never lateral-limited);
//   braking  brakeG_k on every station whose NEXT apex is corner k, bounded
//            by the tyre's μx peak (the solver adds the stoppie limit, the
//            trail-brake share and the brake build);
//   drive    driveG_k from apex k to its zone end (the exit), runG_k from
//            there to the next apex (the straight and the next approach);
//            bounded by the engine and the wheelie limit in the solver.
//   ellipse  lateral axis = max(tyre μ_peak, the station's cap): at its own
//            fitted lateral g the rider has no longitudinal grip left.
//
// Initial values come straight from the reference on the sim line (κ at the
// matched apex, mean decel brake point → minimum, mean accel apex → zone
// end); then ≤ `maxIter` multiplicative corrections (each clamped to
// ×0.6 … ×1.6 per round):
//
//   lateral  cap *= (v_ref/v_sim)² on the apex when its segment is
//            lateral-bound or the sim is faster there; other zone segments on
//            their worst lateral-bound overspeed;
//   brakeG   *= d_sim/d_ref: braking distance to the minimum vs the
//            reference brake point (spec); an apex reached on a braking curve
//            off by > tol takes (v_ref/v_sim)² instead — or, when the sim
//            over-drove the approach and braked it off, the drive cap where
//            it peaked;
//   driveG   *= ΔKE_ref/ΔKE_sim, apex → zone end (spec's exit-speed ratio);
//   runG     *= (v_ref/v_sim)² when the next apex is reached on a drive curve
//            off by > tol, else ΔKE ratio zone end → the reference's speed
//            at the next brake point (see below).
//
// Between the apexes the QSS rider would sit on a cap all the way (full drive
// to the braking curve, full braking to the apex); the reference does not
// (ducati-lateral note §8). From the reference's own speed trace on the line:
//
//   roll-on  per corner, `rollOnS`: apex → where the reference first uses 90 %
//            of the preset's drive (or of its own run level); the drive the
//            bike has rises 1 − exp(−t·ln10/rollOnS) over that reference time;
//   coast    every station where the reference neither brakes nor drives
//            beyond ±0.1 g (the run-in before an apex, and stretches ≥ 20 m
//            mid-run; `coastFrac`/`coastInM`): no tyre braking, and a net
//            acceleration no higher than the reference's there;
//   entry    a reference speed minimum ≥ 8 m before the apex and ≥ 2 km/h
//            below it gets its own lateral segment, corrected on the minimum;
//   runG     targets the reference's speed at the next corner's brake point
//            (its run peak where that corner has none), and is cut where the
//            sim over-drives the run and brakes it off.
//
// Stop: every apex within 1 km/h and the lap within 0.3 s of the reference
// SPEED ridden over this line (`alignedRefLapS`); corrections are damped
// (square root) from round 10.
//
// Everything else (lat g, lean, longG, brake/tps, gear, rpm) is DERIVED from
// the fitted envelope exactly as for the other modes (riderChannels without an
// event profile: brake/tps from the sign of longG — the event template would
// re-shape the fitted speed, which is the one thing that must not move).
import type { Session, TrackModel } from '../core/types';
import { alignReference, smoothedCurvature, type AlignOptions, type Alignment } from './alignRef';
import { buildLine } from './line';
import { clampParams } from './presets';
import type { Reference } from './reference';
import { riderChannels } from './rider';
import { driveCapMs2, G, lossDecelMs2, solve } from './solver';
import { toSession } from './toSession';
import type { Corridor, Envelope, EnvelopeCaps, Line, SimParams } from './types';

export interface CornerModel {
  /** Index into the reference corners. */
  k: number;
  name: string;
  dir: 1 | -1;
  /** Sim line sample of the matched apex. */
  iApex: number;
  /** Sim apex speed after the fit, m/s. */
  vApexMs: number;
  /** Reference apex speed (aligned trace at the apex), m/s. */
  vApexRefMs: number;
  /** Fitted lateral cap at the apex, g. */
  aLatG: number;
  /** Largest fitted lateral cap anywhere in the zone, g (= aLatG in 'zone' mode). */
  aLatPeakG: number;
  /** Initial value: vApexRef²·|κ_apex|/g. */
  aLatInitG: number;
  /** Same with κ averaged over ±5 m of the apex. */
  aLatMeanG: number;
  /** Fitted tyre braking cap for the braking INTO this corner, g. */
  brakeG: number;
  /** Fitted drive cap from the apex to the zone end (the exit), g. */
  driveG: number;
  /** Fitted drive cap from the zone end to the next apex (straight + next approach), g. */
  runG: number;
  /**
   * Fraction of the run from this apex to the next where the reference
   * neither brakes nor drives beyond ±COAST_G (its own speed trace): the sim
   * coasts there (drive capped to the losses, no tyre braking). The roll-on
   * window after the apex is not counted (it is `rollOnS`).
   */
  coastFrac: number;
  /** Of that, the coast run-in directly before the NEXT apex, metres (the reference has finished braking). */
  coastInM: number;

  /**
   * Roll-on time, s: from this apex to where the reference's drive first
   * reaches 90 % of its peak on the run. The drive cap ramps from 0 at the
   * apex through 90 % at `rollOnS` (reference clock); 0 = no ramp.
   */
  rollOnS: number;
  /** Reference brake point warped onto the sim line, metres; null without one. */
  brakeStartM: number | null;
  /** Where the fitted sim starts braking for this corner, metres; null when it does not brake. */
  simBrakeStartM: number | null;
  /** Zone on the sim line, metres. */
  zone: [number, number];
  /** What sets the sim speed at the apex. */
  binding: 'lateral' | 'drive' | 'brake';
  zoneTimeRefS: number;
  zoneTimeSimS: number;
  /**
   * The reference SPEED ridden over this zone of the sim line (∫ds/v_ref):
   * what the zone time would be if the sim matched the reference speed
   * exactly. Its gap to `zoneTimeRefS` is the distance mismatch between the
   * reference (±15-20 m) and the line, not a rider error.
   */
  zoneTimeRefOnLineS: number;
}

export interface RiderFit {
  reference: string;
  corners: CornerModel[];
  lapTimeS: number;
  refLapTimeS: number;
  /** ∫ds/v_ref over the sim line: the reference speed's lap on THIS line. */
  alignedRefLapS: number;
  envelope: Envelope;
  caps: EnvelopeCaps;
  residuals: { apexKmh: number[]; zoneTimeS: number[]; lapS: number };
  iterations: number;
  converged: boolean;
  alignment: Alignment;
  /** The current preset's lateral ceiling: min(μ_lat, tan(maxLean·leanUsage)). */
  ceiling: { aLatG: number; leanDeg: number };
  notes: string[];
  /**
   * Which corner owns every station (for per-corner tuning of the fitted
   * caps, fitModel.ts): the zone it lies in (−1 between zones), the corner it
   * brakes into, the corner it drives out of, whether it is that corner's
   * exit (apex → zone end), whether the rider coasts there, and the
   * reference's clock since the drive-owner's apex on the roll-on stretch
   * (NaN elsewhere).
   */
  stations: {
    zoneOwner: Int16Array;
    brakeOwner: Int16Array;
    driveOwner: Int16Array;
    inExit: Uint8Array;
    coast: Uint8Array;
    tFromApexS: Float32Array;
    /** Reference longitudinal g on the line, d(v²/2)/ds over ±10 m. */
    aRefG: Float32Array;
  };
  /** The params the fit solved with (the preset's, trail-brake depth 1). */
  params: SimParams;
  /** The tyre's peak lateral axis, m/s² (the ellipse floor of `latAxisMs2`). */
  muLatPeakMs2: number;
}

/** The params the fitted rider solves with: the preset's, brakes carried to full lean. */
export function fitParams(params: SimParams): SimParams {
  const p0 = clampParams(params);
  return { ...p0, rider: { ...p0.rider, trailBrakeDepth: 1 } };
}

/** d(v²/2)/ds over ±halfM on a closed line, g. */
export function longGOnLine(line: Line, v: ArrayLike<number>, halfM = 10): Float32Array {
  const n = line.points.length;
  const L = line.lengthM;
  const s = line.cumDistM;
  const out = new Float32Array(n);
  const cd = (a: number, b: number): number => (((s[b] - s[a]) % L) + L) % L;
  // the stations are near-uniform (centreline vertices): a fixed index half-width
  const h = Math.max(1, Math.round(halfM / (L / n)));
  for (let i = 0; i < n; i++) {
    const a = (i - h + n) % n;
    const b = (i + h) % n;
    const ds = cd(a, b);
    out[i] = ds > 1 ? (v[b] * v[b] - v[a] * v[a]) / (2 * ds * G) : 0;
  }
  return out;
}

export interface FitOptions {
  /** Correction rounds after the initial solve; 0 = initial values only. Default 6. */
  maxIter?: number;
  /** Stop tolerances. */
  apexTolKmh?: number;
  lapTolS?: number;
  /** Lateral model, see fitRider: 'segments' (default) or the literal one-cap-per-zone 'zone'. */
  lateral?: 'segments' | 'zone';
  /** Passed to `alignReference` (a recorded lap's own path: `pathOnLine`). */
  align?: AlignOptions;
}

/**
 * Correction rounds. The spec asked ≤ 6; on the BMW 6 leave K9 −7.8 km/h
 * (the sim over-drives the K8 → K9 run and brakes it off, and that chain
 * takes ~10 rounds to unwind); 12 brought every apex within 1 km/h. With the
 * coast and roll-on caps (ducati-lateral note §8) the K8 → K9 chain starts
 * further out (K9 −17 km/h before the first round) and needs 16 on the BMW
 * κ 0.85 race line.
 */
const DEFAULT_MAX_ITER = 20;
/** Entry minimum (see the lateral model): searched this far before the apex, metres ... */
const ENTRY_WINDOW_M = 60;
/** ... at least this far before it, metres ... */
const ENTRY_MIN_M = 8;
/** ... and this much below the apex speed, km/h. */
const ENTRY_DROP_KMH = 2;
/** Braking cap where the reference has no brake point, g (a 1000 at R 0.5 brakes at ~1.1 g, calibration note §3). */
const DEFAULT_BRAKE_G = 1.0;
/** Mean-κ window half-width for `aLatMeanG`, metres. */
const KAPPA_MEAN_HALF_M = 5;
/** v within this fraction of the lateral-limit speed = lateral-bound. */
const LAT_BOUND_FRAC = 0.995;
/** Per-round clamp of every multiplicative correction. */
const STEP_MIN = 0.6;
const STEP_MAX = 1.6;
/** Sane bounds on the fitted caps, g. */
const LAT_BOUNDS: [number, number] = [0.05, 2.5];
const LONG_MIN_G = 0.1;
/**
 * Upper bound on a fitted drive cap, g. The spec bounds drive by the ENGINE
 * and the WHEELIE limit (the solver applies both), not by the tyre's μx: at
 * lean the cap is further cut by the ellipse and traction control, so a cap
 * above μx is how a rider who drives harder out of a corner than the preset's
 * ellipse allows shows up (K12 on the BMW). Sanity bound only.
 */
const DRIVE_MAX_G = 2.0;
/**
 * A reference station where |d(v²/2)/ds| stays within this, g, neither brakes
 * nor drives: a coast (closed throttle / maintenance throttle, no brake).
 */
const COAST_G = 0.1;
/** Half-width of the reference's longitudinal-g difference on the sim line, metres (10 Hz GPS speed is noisy below this). */
const REF_ACCEL_HALF_M = 10;
/** A mid-run coast shorter than this is a zero crossing of the drive, not a coast, metres. */
const COAST_MIN_M = 20;
/** Roll-on: the reference drive's fraction of its run peak that ends it. */
const ROLL_ON_FRAC = 0.9;
/**
 * The roll-on is a first-order rise, 1 − exp(−t·ln10/rollOnS): 90 % at
 * `rollOnS`. A linear ramp to 90 % lagged the reference, whose drive builds
 * most of its value in the first few tenths and then levels off (Ducati K16
 * exit: 0.35-0.45 g within 10-20 m of the apex, its run p90 0.6 g at 2 s).
 */
const ROLL_ON_RATE = Math.log(1 / (1 - ROLL_ON_FRAC));

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const step = (r: number, damp = 1): number => clamp(Number.isFinite(r) ? r ** damp : 1, STEP_MIN, STEP_MAX);
/**
 * From this round on every correction is taken as its square root: the
 * coupled K8 → K9 pair on the BMW (entry minimum, then a run braked off)
 * otherwise limit-cycles between −0.9 and −2.4 km/h at K8.
 */
const DAMP_FROM_ROUND = 10;

/** Lateral ceiling of the current preset: min(μ_lat, tan(maxLean·leanUsage)), g. */
export function lateralCeilingG(params: SimParams): number {
  const p = clampParams(params);
  const muLat = p.tyre.mu * p.tyre.gripScale;
  const tanLean = Math.tan((p.tyre.maxLeanDeg * p.rider.leanUsage * Math.PI) / 180);
  return Math.min(muLat, tanLean);
}

/** Fractional lateral margin to the ceiling: (ceiling − aLat)/ceiling. */
export function latMargin(aLatG: number, ceilingG: number): number {
  return (ceilingG - aLatG) / ceilingG;
}

function cyclicDist(a: number, b: number, L: number): number {
  return (((b - a) % L) + L) % L;
}

/**
 * Fit the per-corner rider to a reference on a given sim line.
 */
export function fitRider(line: Line, params: SimParams, ref: Reference, opts: FitOptions = {}): RiderFit {
  // The fitted rider carries the brakes to full lean (trail-brake depth 1):
  // the reference riders brake right after an apex while still leaned (K9 →
  // K10 on the BMW). The taper's courage (`trailBrakeProfile`) stays the preset's.
  const p = fitParams(params);
  const n = line.points.length;
  const L = line.lengthM;
  const s = line.cumDistM;
  const maxIter = opts.maxIter ?? DEFAULT_MAX_ITER;
  const apexTol = (opts.apexTolKmh ?? 1) / 3.6;
  const lapTol = opts.lapTolS ?? 0.3;
  const al = alignReference(ref, line, p, opts.align);
  const notes = [...al.notes];
  const vRef = al.vRefMs;
  const K = ref.corners.length;
  const muX = (p.tyre.muX ?? p.tyre.mu) * p.tyre.gripScale;
  const loss = (v: number): number => lossDecelMs2(p.machine, v) / G;
  const at = (sm: number): number => {
    // nearest sample to sim metres sm
    const ss = ((sm % L) + L) % L;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (s[mid] <= ss) lo = mid;
      else hi = mid;
    }
    return ss - s[lo] <= s[hi] - ss ? lo : hi;
  };

  // ---- geometry of every corner on the sim line --------------------------
  const iA = al.apexIdx;
  const zone: Array<[number, number]> = ref.corners.map((c) => [al.toSim(c.zoneM[0]), al.toSim(c.zoneM[1])]);
  const iEnd = zone.map(([, b]) => at(b));
  const brakeRefM = ref.corners.map((c) => (c.brakeM === null ? null : al.toSim(c.brakeM)));

  // partitions: next apex at/after i (braking into), last apex before i (drive out of)
  const brakeOwner = new Int16Array(n);
  const driveOwner = new Int16Array(n);
  {
    for (let i = 0; i < n; i++) {
      let bestB = -1;
      let dB = Infinity;
      let bestD = -1;
      let dD = Infinity;
      for (let k = 0; k < K; k++) {
        const fwd = cyclicDist(s[i], s[iA[k]], L);
        if (fwd < dB) {
          dB = fwd;
          bestB = k;
        }
        const back = cyclicDist(s[iA[k]], s[i], L);
        if (back > 0 && back < dD) {
          dD = back;
          bestD = k;
        }
      }
      brakeOwner[i] = bestB;
      driveOwner[i] = bestD < 0 ? bestB : bestD;
    }
  }
  // zone membership (lateral): inside a zone → that corner; else the two
  // neighbours. Where zones overlap (a corner pair like K1 / K1+, one zone
  // inside the other) the station goes to the corner whose apex is nearer, so
  // the inner corner keeps its own stretch (it once owned none: lat g 0.00
  // and a dead corner-grip slider).
  const zoneOwner = new Int16Array(n).fill(-1);
  const zoneD = new Float64Array(n).fill(Infinity);
  for (let k = 0; k < K; k++) {
    const [a, b] = zone[k];
    for (let i = 0; i < n; i++) {
      const inside = a <= b ? s[i] >= a && s[i] <= b : s[i] >= a || s[i] <= b;
      if (!inside) continue;
      const d = Math.min(cyclicDist(s[i], s[iA[k]], L), cyclicDist(s[iA[k]], s[i], L));
      if (d <= zoneD[i]) {
        zoneD[i] = d;
        zoneOwner[i] = k;
      }
    }
  }

  // Drive partition (spec: "drive cap per zone"): from apex k to its zone end
  // the rider's EXIT cap driveG_k; from there to the next apex (the straight
  // and the next corner's approach) the RUN cap runG_k. The run's target is
  // the next apex when it is reached on a drive curve, else the reference's
  // speed peak on the run.
  const inExit = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const k = driveOwner[i];
    const toEnd = cyclicDist(s[iA[k]], zone[k][1], L);
    inExit[i] = toEnd < L / 2 && cyclicDist(s[iA[k]], s[i], L) <= toEnd ? 1 : 0;
  }
  const runPeak = new Int32Array(K).fill(-1);
  for (let i = 0; i < n; i++) {
    if (inExit[i]) continue;
    const k = driveOwner[i];
    if (runPeak[k] < 0 || vRef[i] > vRef[runPeak[k]]) runPeak[k] = i;
  }

  // ---- lateral model -------------------------------------------------------
  //
  // 'segments' (default): every |κ| peak of the line is its own lateral
  // segment (split at |κ| minima and sign changes, 20 m smoothed κ). A
  // segment inside a corner's zone gets its own cap, started at the lateral g
  // the reference needs at its tightest station and corrected on that
  // station. A zone with two |κ| peaks therefore carries two caps: on this
  // line K1, K3, K4 and K13 have a second peak where the reference needs
  // 0.3-0.9 g more than at the apex (hand-placed geometry, ±15-20 m), and a
  // single zone-wide cap misses either the apex or that peak by 10-40 km/h.
  // The corner's `aLatG` is the cap of the segment holding its apex;
  // `aLatPeakG` the largest cap in its zone. Segments outside every zone
  // (straights) take the larger neighbouring corner cap, never less than the
  // reference needs there — a straight is never lateral-limited.
  //
  // 'zone': the literal one-cap-per-zone model (aLat_k = vApex²|κ_apex|/g,
  // corrected on the apex), kept for comparison.
  const lateralMode = opts.lateral ?? 'segments';
  const kAbs = (i: number): number => Math.abs(line.curvature[i]);
  const req = (i: number): number => (vRef[i] * vRef[i] * kAbs(i)) / G;
  const kS = smoothedCurvature(line);
  const seg = new Int32Array(n);
  const segCrit: number[] = [];
  /** Per corner: the reference's entry speed minimum that got its own segment, else −1. */
  const entryMin = new Int32Array(K).fill(-1);
  {
    // start the walk at the smallest |κ| so no segment straddles the seam
    let i0 = 0;
    for (let i = 1; i < n; i++) if (Math.abs(kS[i]) < Math.abs(kS[i0])) i0 = i;
    let id = 0;
    for (let d = 0; d < n; d++) {
      const i = (i0 + d) % n;
      const pv = (i - 1 + n) % n;
      const nx = (i + 1) % n;
      if (d > 0) {
        const signFlip = Math.sign(kS[i]) !== Math.sign(kS[pv]) && kS[i] !== 0;
        const localMin = Math.abs(kS[pv]) > Math.abs(kS[i]) && Math.abs(kS[i]) <= Math.abs(kS[nx]);
        if (signFlip || localMin) id++;
      }
      seg[i] = id;
    }
    // the ENTRY: where the reference's speed minimum lies ≥ ENTRY_MIN_M
    // before the apex inside the apex's own segment (it brakes below the apex
    // speed, then drives to the apex: Ducati K11 −21 m / −5 km/h, BMW K8
    // −23 m / −10 km/h), the stretch of that segment up to the minimum is its
    // own segment, corrected on the minimum. One cap cannot hold a minimum
    // there and the apex speed at the tighter κ; without it the QSS rider
    // brakes straight to the apex and is up to 15 km/h quicker through the
    // entry (−0.4 s at Ducati K11).
    for (let k = 0; k < K; k++) {
      const ia = iA[k];
      let iMin = ia;
      let j = ia;
      for (let d = 0; d < n && cyclicDist(s[j], s[ia], L) < ENTRY_WINDOW_M; d++) {
        if (vRef[j] < vRef[iMin]) iMin = j;
        j = (j - 1 + n) % n;
      }
      const back = cyclicDist(s[iMin], s[ia], L);
      if (back < ENTRY_MIN_M || back > ENTRY_WINDOW_M - 5) continue; // at the apex, or still slowing at the window's start
      if ((vRef[ia] - vRef[iMin]) * 3.6 < ENTRY_DROP_KMH || seg[iMin] !== seg[ia]) continue;
      const qa = seg[ia];
      id++;
      entryMin[k] = iMin;
      for (let jj = iMin, d = 0; d < n && seg[jj] === qa; jj = (jj - 1 + n) % n, d++) seg[jj] = id;
    }
    for (let q = 0; q <= id; q++) segCrit.push(-1);
    for (let i = 0; i < n; i++) {
      const q = seg[i];
      if (segCrit[q] < 0 || req(i) > req(segCrit[q])) segCrit[q] = i;
    }
  }
  const nSeg = segCrit.length;
  const segZone = Int32Array.from(segCrit, (c) => zoneOwner[c]);
  // the cap STARTS at the segment's largest requirement (never below the
  // reference anywhere in it) ...
  const segCap = Float64Array.from(segCrit, (c) => clamp(req(c), LAT_BOUNDS[0], LAT_BOUNDS[1]));
  // ... and a segment holding a corner's apex is corrected ON the apex (the
  // apex speed is the target)
  const segHasApex = new Uint8Array(nSeg);
  for (let k = 0; k < K; k++) {
    segCrit[seg[iA[k]]] = iA[k];
    segHasApex[seg[iA[k]]] = 1;
    // an entry segment is corrected on its minimum the same way
    if (entryMin[k] >= 0) {
      segCrit[seg[entryMin[k]]] = entryMin[k];
      segHasApex[seg[entryMin[k]]] = 1;
    }
  }

  // ---- initial values from the reference ---------------------------------
  const aLat = new Float64Array(K);
  const aLatInit = new Float64Array(K);
  const aLatMean = new Float64Array(K);
  const brakeG = new Float64Array(K);
  const driveG = new Float64Array(K);
  /** Drive cap on the run AFTER the zone (to the next zone), g; starts at the tyre's μx. */
  const runG = new Float64Array(K).fill(muX);
  for (let k = 0; k < K; k++) {
    const i = iA[k];
    const v = vRef[i];
    aLatInit[k] = (v * v * kAbs(i)) / G;
    let sum = 0;
    let cnt = 0;
    for (let j = 0; j < n; j++) {
      let d = Math.abs(s[j] - s[i]);
      d = Math.min(d, L - d);
      if (d <= KAPPA_MEAN_HALF_M) {
        sum += kAbs(j);
        cnt++;
      }
    }
    aLatMean[k] = (v * v * (cnt ? sum / cnt : kAbs(i))) / G;
    aLat[k] = clamp(aLatInit[k], LAT_BOUNDS[0], LAT_BOUNDS[1]);

    // braking: mean tyre decel from the brake point to the speed minimum before the apex (+30 m)
    const b = brakeRefM[k];
    const startM = b ?? s[i] - 150;
    const i0 = at(startM);
    let iMin = i;
    let iMax = i0;
    for (let d = 0, j = i0; d < n; d++, j = (j + 1) % n) {
      if (vRef[j] < vRef[iMin]) iMin = j;
      if (b === null && vRef[j] > vRef[iMax]) iMax = j;
      if (cyclicDist(s[i0], s[j], L) > cyclicDist(s[i0], s[i], L) + 30) break;
    }
    const iFrom = b === null ? iMax : i0;
    const dist = cyclicDist(s[iFrom], s[iMin], L);
    const vFrom = vRef[iFrom];
    const vTo = vRef[iMin];
    // only a reference BRAKE POINT defines a braking zone; a lift elsewhere is
    // not a ceiling (its mean decel is what the rider needed, not could do)
    if (b !== null && dist > 5 && vFrom - vTo > 5 / 3.6) {
      const mean = (vFrom * vFrom - vTo * vTo) / (2 * dist * G);
      brakeG[k] = clamp(mean - loss((vFrom + vTo) / 2), LONG_MIN_G, muX);
    } else {
      brakeG[k] = Math.min(DEFAULT_BRAKE_G, muX);
    }
    // drive: mean accel apex → zone end, plus the losses it overcame
    const dE = cyclicDist(s[i], s[iEnd[k]], L);
    const vE = vRef[iEnd[k]];
    if (dE > 5 && vE > v) {
      const mean = (vE * vE - v * v) / (2 * dE * G);
      driveG[k] = clamp(mean + loss((vE + v) / 2), LONG_MIN_G + 0.1, muX);
    } else {
      driveG[k] = Math.min(0.8, muX);
    }
  }

  // ---- per-station caps --------------------------------------------------
  const latArr = new Float32Array(n);
  const axisArr = new Float32Array(n);
  const brakeArr = new Float32Array(n);
  const driveArr = new Float32Array(n);
  const scaleArr = new Float32Array(n).fill(1);
  const accelArr = new Float32Array(n).fill(Infinity);
  const caps: EnvelopeCaps = {
    aLatMs2: latArr,
    latAxisMs2: axisArr,
    brakeMs2: brakeArr,
    driveMs2: driveArr,
    driveScale: scaleArr,
    accelMaxMs2: accelArr,
    skipRollRate: true,
  };
  // the ellipse's lateral axis: the tyre's peak, or the fitted cap where that is higher
  const muLatPeak = p.tyre.mu * p.tyre.gripScale;
  const fill = (): void => {
    for (let i = 0; i < n; i++) {
      const z = zoneOwner[i];
      const nb = Math.max(cornerCap(driveOwner[i]), cornerCap(brakeOwner[i]));
      if (lateralMode === 'zone') {
        // between zones: the larger neighbour (the straight is never lateral-limited)
        latArr[i] = (z >= 0 ? aLat[z] : nb) * G;
      } else {
        const q = seg[i];
        latArr[i] = (segZone[q] >= 0 ? segCap[q] : Math.max(nb, req(segCrit[q]))) * G;
      }
      axisArr[i] = Math.max(latArr[i], muLatPeak * G);
      brakeArr[i] = clamp(brakeG[brakeOwner[i]], LONG_MIN_G, muX) * G;
      // the rider's drive cap holds inside the corner's zone (approach and
      // exit); between zones the machine sets the drive: μx, power, wheelie
      driveArr[i] = clamp(inExit[i] ? driveG[driveOwner[i]] : runG[driveOwner[i]], LONG_MIN_G, DRIVE_MAX_G) * G;
      scaleArr[i] = rollOnRamp[i];
      // a coast: no tyre braking (drag alone slows the bike; the solver floors
      // the cap at 0.1 m/s²) and a net acceleration no higher than the
      // reference's own (≤ COAST_G) there: hold speed, or follow its drift
      accelArr[i] = Infinity;
      if (coast[i]) {
        brakeArr[i] = 0;
        accelArr[i] = Math.max(0, aRef[i]) * G;
      }
    }
  };
  /** The corner's lateral cap: its apex segment's (segments) or its zone's (zone). */
  function cornerCap(k: number): number {
    if (lateralMode === 'zone') return aLat[k];
    const q = seg[iA[k]];
    return segZone[q] >= 0 ? segCap[q] : aLat[k];
  }
  /** Largest lateral cap inside corner k's zone. */
  const zonePeak = (k: number): number => {
    let m = cornerCap(k);
    if (lateralMode === 'segments') for (let q = 0; q < nSeg; q++) if (segZone[q] === k) m = Math.max(m, segCap[q]);
    return m;
  };

  /**
   * Sim brake point for corner k: the speed maximum between the previous apex
   * and the sim's speed minimum around this apex (in a QSS profile that is
   * where the drive curve meets the braking curve), and that minimum.
   */
  const prevApex = (k: number): number => {
    let best = -1;
    let dBest = Infinity;
    for (let q = 0; q < K; q++) {
      const d = cyclicDist(s[iA[q]], s[iA[k]], L);
      if (d > 0 && d < dBest) {
        dBest = d;
        best = q;
      }
    }
    return best < 0 ? (iA[k] + 1) % n : iA[best];
  };
  const brakeWindow = (v: ArrayLike<number>, k: number): { iStart: number; iMin: number } => {
    const i = iA[k];
    const i0 = prevApex(k);
    // the speed minimum around this apex: 60 m before to 30 m after
    let iMin = i;
    for (let j = 0; j < n; j++) {
      const back = cyclicDist(s[j], s[i], L);
      const fwd = cyclicDist(s[i], s[j], L);
      if ((back <= 60 || fwd <= 30) && v[j] < v[iMin]) iMin = j;
    }
    let iMax = iMin;
    for (let j = i0, d = 0; d < n && j !== iMin; j = (j + 1) % n, d++) if (v[j] > v[iMax]) iMax = j;
    return { iStart: iMax, iMin };
  };
  const simBrakeStart = (env: Envelope, k: number): { iStart: number | null; iMin: number } => {
    const w = brakeWindow(env.v, k);
    return { iStart: w.iStart === w.iMin ? null : w.iStart, iMin: w.iMin };
  };

  // zone time: previous zone's end (the start line for the first) → this zone's end
  const zoneTimes = (tS: ArrayLike<number>, lap: number): number[] =>
    iEnd.map((e, k) => {
      let d = tS[e] - (k === 0 ? 0 : tS[iEnd[k - 1]]);
      if (d < 0) d += lap;
      return d;
    });

  // lap order of the corners, and per corner the reference's speed peak on
  // the run to the next one (where drive hands over to braking)
  const byApex = iA.map((_, k) => k).sort((a, b) => s[iA[a]] - s[iA[b]]);
  const nextK = new Int32Array(K);
  byApex.forEach((k, r) => (nextK[k] = byApex[(r + 1) % K]));
  const split = new Int32Array(K);
  for (let k = 0; k < K; k++) {
    let best = iA[k];
    for (let j = iA[k], d = 0; j !== iA[nextK[k]] && d < n; j = (j + 1) % n, d++) if (vRef[j] > vRef[best]) best = j;
    split[k] = best;
  }
  /** Space-mean of v² from sample a forward to sample b (inclusive), wrapping. */
  const meanSq = (v: ArrayLike<number>, a: number, b: number): number => {
    let sum = 0;
    let len = 0;
    for (let j = a, d = 0; d < n; j = (j + 1) % n, d++) {
      const ds = j === 0 ? L - s[n - 1] : s[j] - s[(j - 1 + n) % n];
      sum += v[j] * v[j] * ds;
      len += ds;
      if (j === b) break;
    }
    return len > 0 ? sum / len : Number.NaN;
  };

  // ---- coast and roll-on from the reference's speed trace -------------------
  //
  // The QSS rider is always on a cap: full drive until the braking curve,
  // full braking cap down to the apex. The reference is not (ducati-lateral
  // note §3/§7): it finishes braking 40-60 m before an apex and runs in with
  // neither brake nor throttle, holds speed on parts of a run, and rolls the
  // throttle on over seconds after the apex. Per station, from the aligned
  // reference speed: aRef = d(v²/2)/ds over ±REF_ACCEL_HALF_M.
  //   roll-on  apex k → the first station where aRef reaches ROLL_ON_FRAC of
  //            its peak on the run (before the run's speed peak): the drive
  //            the bike has (after power and wheelie) rises first-order from
  //            0 at the apex to 90 % at that reference time;
  //   coast    after the roll-on, every station with |aRef| ≤ COAST_G: the
  //            run-in directly before the next apex whatever its length,
  //            elsewhere in stretches ≥ COAST_MIN_M.
  const aRef = new Float32Array(n);
  {
    const fwdIdx = (i: number, m: number): number => {
      let j = i;
      for (let d = 0; d < n && cyclicDist(s[i], s[j], L) < m; d++) j = (j + 1) % n;
      return j;
    };
    const backIdx = (i: number, m: number): number => {
      let j = i;
      for (let d = 0; d < n && cyclicDist(s[j], s[i], L) < m; d++) j = (j - 1 + n) % n;
      return j;
    };
    for (let i = 0; i < n; i++) {
      const a = backIdx(i, REF_ACCEL_HALF_M);
      const b = fwdIdx(i, REF_ACCEL_HALF_M);
      const ds = cyclicDist(s[a], s[b], L);
      aRef[i] = ds > 1 ? (vRef[b] * vRef[b] - vRef[a] * vRef[a]) / (2 * ds * G) : 0;
    }
  }
  const tRef = al.tRefS;
  const refLap = ref.lapTimeS;
  const dtRef = (a: number, b: number): number => {
    const d = tRef[b] - tRef[a];
    return d < 0 ? d + refLap : d;
  };
  const rollOnS = new Float64Array(K);
  const rollOnRamp = new Float32Array(n).fill(1);
  const tFromApexS = new Float32Array(n).fill(Number.NaN);
  const coast = new Uint8Array(n);
  const coastFrac = new Float64Array(K);

  const coastInM = new Float64Array(K);
  for (let k = 0; k < K; k++) {
    const i0 = iA[k];
    const i1 = iA[nextK[k]];
    const runLen = cyclicDist(s[i0], s[i1], L) || L;
    // roll-on: how much of the preset's drive (power, μx ellipse, TC,
    // wheelie at the reference's speed; `driveCapMs2`) the reference uses,
    // u = (aRef + losses)/capacity, from the apex to the run's speed peak.
    // The roll-on ends where u first reaches ROLL_ON_FRAC of its run level
    // (the cap, u = 1, or the run's 90th percentile of u where the reference
    // never gets there; a percentile, as a 10 Hz GPS or a lap-seam step is a
    // one-station spike). Against the capacity, not the reference's own peak:
    // the BMW leaves K5 at 1.46 g, past the preset's wheelie limit, and its
    // own peak would time the roll-on to that impossible figure.
    const uRun: number[] = [];
    const uAt = new Map<number, number>();
    for (let j = i0, d = 0; d < n; j = (j + 1) % n, d++) {
      tFromApexS[j] = dtRef(i0, j);
      const capG = driveCapMs2(line, p, j, Math.max(1, vRef[j])) / G;
      const u = capG > 0.01 ? (aRef[j] + loss(vRef[j])) / capG : 0;
      uRun.push(u);
      uAt.set(j, u);
      if (j === split[k]) break;
    }
    const uSorted = uRun.slice().sort((a, b) => a - b);
    const uLevel = Math.min(1, uSorted.length ? uSorted[Math.floor(0.9 * (uSorted.length - 1))] : 0);
    let iRoll = i0;
    if (uLevel > 0.05 && Math.max(...uRun) > 0) {
      for (let j = i0, d = 0; d < n; j = (j + 1) % n, d++) {
        if ((uAt.get(j) ?? 0) >= ROLL_ON_FRAC * uLevel || j === split[k]) {
          iRoll = j;
          break;
        }
      }
      rollOnS[k] = dtRef(i0, iRoll);
      if (rollOnS[k] > 0) {
        for (let j = i0, d = 0; d < n && j !== iRoll; j = (j + 1) % n, d++) {
          rollOnRamp[j] = 1 - Math.exp((-dtRef(i0, j) * ROLL_ON_RATE) / rollOnS[k]);
        }
      }
    }
    // coast: the run-in before the next apex
    let iIn = i1;
    for (let j = (i1 - 1 + n) % n, d = 0; d < n && j !== iRoll; j = (j - 1 + n) % n, d++) {
      if (Math.abs(aRef[j]) > COAST_G) break;
      iIn = j;
    }
    for (let j = iIn; j !== i1; j = (j + 1) % n) coast[j] = 1;
    coastInM[k] = cyclicDist(s[iIn], s[i1], L);
    // ... and the mid-run coasts
    let runStart = -1;
    const close = (end: number): void => {
      if (runStart < 0) return;
      if (cyclicDist(s[runStart], s[end], L) >= COAST_MIN_M) for (let j = runStart; j !== end; j = (j + 1) % n) coast[j] = 1;
      runStart = -1;
    };
    for (let j = iRoll; j !== iIn; j = (j + 1) % n) {
      if (Math.abs(aRef[j]) <= COAST_G) {
        if (runStart < 0) runStart = j;
      } else close(j);
    }
    close(iIn);
    let cm = 0;
    for (let j = i0; j !== i1; j = (j + 1) % n) {
      const nx = (j + 1) % n;
      if (coast[j]) cm += cyclicDist(s[j], s[nx], L);
    }
    coastFrac[k] = cm / runLen;
  }

  const runTarget = Int32Array.from(runPeak);
  for (let k = 0; k < K; k++) {
    const b = brakeRefM[nextK[k]];
    if (b === null) continue;
    const ib = at(b);
    // on this run, past the exit
    if (!inExit[ib] && driveOwner[ib] === k) runTarget[k] = ib;
  }

  let alignedRefLapS = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ds = j === 0 ? L - s[n - 1] : s[j] - s[i];
    alignedRefLapS += ds / Math.max(2, (vRef[i] + vRef[j]) / 2);
  }

  let env: Envelope = solve(line, p, (fill(), caps));
  let iterations = 0;
  let converged = false;
  const vLatAt = (i: number): number => {
    const k = kAbs(i);
    return k > 1e-6 ? Math.sqrt(latArr[i] / k) : Infinity;
  };
  const binding = (e: Envelope, i: number): CornerModel['binding'] => {
    if (e.v[i] >= LAT_BOUND_FRAC * vLatAt(i)) return 'lateral';
    return e.longG[i] > 0 ? 'drive' : 'brake';
  };
  // the lap target is the reference SPEED ridden over this line: the line's
  // length is not the reference's (±15-20 m positions, a different line)
  const done = (e: Envelope): boolean =>
    iA.every((i) => Math.abs(e.v[i] - vRef[i]) <= apexTol) && Math.abs(e.lapTimeS - alignedRefLapS) <= lapTol;

  for (let it = 0; it < maxIter; it++) {
    if (done(env)) {
      converged = true;
      break;
    }
    iterations++;
    const damp = it >= DAMP_FROM_ROUND ? 0.5 : 1;
    const latStep = new Float64Array(K).fill(1);
    const brakeStep = new Float64Array(K).fill(1);
    const driveStep = new Float64Array(K).fill(1);
    const runStep = new Float64Array(K).fill(1);
    const runApex = new Uint8Array(K);

    for (let k = 0; k < K; k++) {
      // lateral ('zone' mode): corrected on the apex
      const i = iA[k];
      if (lateralMode === 'zone' && (binding(env, i) === 'lateral' || env.v[i] > vRef[i] + apexTol)) {
        latStep[k] *= (vRef[i] / env.v[i]) ** 2;
      }
      // exit (spec): the speed gain from the apex to the zone end, sim vs
      // reference (v² − v0² ∝ a), when both accelerate there. Speed, not
      // time: the warp places the reference within its ±15-20 m, a few % of
      // a 100 m exit, which a time comparison would read as a rider error.
      const sp = split[k];
      const e = iEnd[k];
      const gRef = vRef[e] ** 2 - vRef[i] ** 2;
      const gSim = env.v[e] ** 2 - env.v[i] ** 2;
      if (cyclicDist(s[i], s[e], L) < L / 2 && gRef > 4) {
        // a sim that does not gain speed on the exit at all (a roll-on ramp
        // starting from 0) has no ratio: the largest step up
        driveStep[k] *= gSim > 1 ? gRef / gSim : STEP_MAX;
      }
      // run: the next apex reached on a DRIVE curve, too fast or too slow
      const kn0 = nextK[k];
      const ia0 = iA[kn0];
      // (an apex with an entry minimum is always DRIVEN to, from the minimum;
      // at lean the drive left can be ~0 g, so longG alone does not say so)
      if (binding(env, ia0) !== 'lateral' && (env.longG[ia0] > 0 || entryMin[kn0] >= 0) && Math.abs(env.v[ia0] - vRef[ia0]) > apexTol) {
        if (!inExit[(ia0 - 1 + n) % n]) {
          runStep[k] *= (vRef[ia0] / env.v[ia0]) ** 2;
          runApex[k] = 1;
        } else {
          // still inside this corner's exit (a flick: K7 → K8, whose entry
          // minimum is driven out of on K7's exit cap): the apex outranks
          // the exit's speed gain
          driveStep[k] = (vRef[ia0] / env.v[ia0]) ** 2;
        }
      }
      // braking into the NEXT corner: its brake point when the reference has
      // one (braking distance to the minimum), else the time over the run
      const kn = nextK[k];
      const bRef = brakeRefM[kn];
      const { iStart, iMin } = simBrakeStart(env, kn);
      // the next apex reached on a BRAKING curve, too fast or too slow: the
      // braking into it is the lever (it outranks the brake point)
      const ia = iA[kn];
      if (entryMin[kn] < 0 && binding(env, ia) !== 'lateral' && env.longG[ia] <= 0 && Math.abs(env.v[ia] - vRef[ia]) > apexTol) {
        // too SLOW on a braking curve because the sim over-drove the approach
        // and had to brake it off (K8 → K9 on the BMW): the drive where the
        // sim peaked is the lever, not the brake
        // (only when it over-drove by more than the apex is short: a sim that
        // peaks 1 km/h high and arrives 4 km/h slow brakes too gently — K14
        // on the Ducati, whose brake cap otherwise sits on its floor)
        const pk = iStart ?? -1;
        if (env.v[ia] < vRef[ia] && pk >= 0 && env.v[pk] > vRef[pk] + apexTol && env.v[pk] - vRef[pk] > vRef[ia] - env.v[ia]) {
          const r = (vRef[pk] / env.v[pk]) ** 2;
          if (inExit[pk]) driveStep[driveOwner[pk]] *= r;
          else {
            runStep[driveOwner[pk]] *= r;
            runApex[driveOwner[pk]] = 1;
          }
        } else brakeStep[kn] *= (vRef[ia] / env.v[ia]) ** 2;
      } else if (bRef !== null && iStart !== null && cyclicDist(bRef, s[ia], L) < cyclicDist(s[iA[k]], s[ia], L)) {
        // (a reference brake point BEHIND the previous apex — it brakes
        // straight through a flick, K15's from before K14 on the Ducati — is
        // not a distance the sim's window can see: the speed over the run)
        const dSim = cyclicDist(s[iStart], s[iMin], L);
        const dRef = cyclicDist(bRef, s[iMin], L);
        if (dSim > 5 && dRef > 5 && dRef < L / 2) brakeStep[kn] *= dSim / dRef;
      } else if (vRef[sp] - vRef[iA[kn]] > 5 / 3.6) {
        // the reference slows into it (a lift or an unmarked brake)
        const rb = meanSq(vRef, sp, iA[kn]) / Math.max(1e-6, meanSq(env.v, sp, iA[kn]));
        if (Number.isFinite(rb)) brakeStep[kn] *= rb;
      }
    }
    // the run, when no apex asked for it: speed gain from the zone end to the
    // reference's speed at the NEXT corner's brake point (where the run hands
    // over to braking), or its peak on the run where that corner has no brake
    // point (K8 → K9 on the BMW is held, not driven)
    for (let k = 0; k < K; k++) {
      const t = runTarget[k];
      if (runApex[k] || t < 0) continue;
      // the sim's own brake start into the next corner, past the exit (its
      // speed peak, where its drive hands over to braking): over the
      // reference there, it over-drove the
      // run and braked it off (K15 → K16 on the Ducati: +26 km/h at 1.0 g
      // against the reference's 0.4 g, with both apexes matched) — that
      // outranks the target station
      {
        const pk = simBrakeStart(env, nextK[k]).iStart ?? -1;
        // (driven INTO: a speed maximum the sim coasts or brakes away from —
        // just past K7's apex on the BMW — is not the run's drive)
        const drove = pk >= 0 && env.longG[(pk - 1 + n) % n] > 0.05;
        if (drove && !inExit[pk] && driveOwner[pk] === k && pk !== t && env.v[pk] > vRef[pk] + apexTol && env.v[pk] - vRef[pk] > env.v[t] - vRef[t]) {
          runStep[k] *= (vRef[pk] / env.v[pk]) ** 2;
          continue;
        }
      }
      if (Math.abs(env.v[t] - vRef[t]) <= apexTol) continue;
      const e = iEnd[k];
      const gRef = vRef[t] ** 2 - vRef[e] ** 2;
      const gSim = env.v[t] ** 2 - env.v[e] ** 2;
      if (gRef > 4 && gSim > 1) runStep[k] *= gRef / gSim;
      else if (gRef > 4 && env.v[t] < vRef[t]) runStep[k] *= STEP_MAX;
      else if (env.v[t] > vRef[t]) runStep[k] *= (vRef[t] / env.v[t]) ** 2;
    }
    // lateral ('segments' mode). A segment holding an apex is corrected on
    // the apex. Any other zone segment is corrected on its worst lateral-bound
    // OVERSPEED (a QSS rides every metre at its cap, the reference did not:
    // without this the fitted lap is ~0.9 s too quick), else, when slow, on
    // its tightest station.
    if (lateralMode === 'segments') {
      const segBound = new Uint8Array(nSeg);
      const segOver = new Float64Array(nSeg).fill(1);
      for (let j = 0; j < n; j++) {
        if (env.v[j] < LAT_BOUND_FRAC * vLatAt(j)) continue;
        const q = seg[j];
        segBound[q] = 1;
        if (env.v[j] > vRef[j] + apexTol) segOver[q] = Math.min(segOver[q], (vRef[j] / env.v[j]) ** 2);
      }
      for (let q = 0; q < nSeg; q++) {
        if (segZone[q] < 0) continue;
        const c = segCrit[q];
        let r = 1;
        if (segHasApex[q]) {
          if (segBound[q] || env.v[c] > vRef[c] + apexTol) r = (vRef[c] / env.v[c]) ** 2;
        } else if (segOver[q] < 1) {
          r = segOver[q];
        } else if (segBound[q] && env.v[c] < vRef[c] - apexTol) {
          r = (vRef[c] / env.v[c]) ** 2;
        }
        segCap[q] = clamp(segCap[q] * step(r, damp), LAT_BOUNDS[0], LAT_BOUNDS[1]);
      }
    }
    for (let k = 0; k < K; k++) {
      aLat[k] = clamp(aLat[k] * step(latStep[k], damp), LAT_BOUNDS[0], LAT_BOUNDS[1]);
      brakeG[k] = clamp(brakeG[k] * step(brakeStep[k], damp), LONG_MIN_G, muX);
      driveG[k] = clamp(driveG[k] * step(driveStep[k], damp), LONG_MIN_G, DRIVE_MAX_G);
      runG[k] = clamp(runG[k] * step(runStep[k], damp), LONG_MIN_G, DRIVE_MAX_G);

    }
    fill();
    env = solve(line, p, caps);
  }
  if (!converged && done(env)) converged = true;

  // ---- report --------------------------------------------------------------
  const ztSim = zoneTimes(env.tS, env.lapTimeS);
  const tOnLine = new Float64Array(n);
  {
    let t = 0;
    for (let i = 0; i < n; i++) {
      tOnLine[i] = t;
      const j = (i + 1) % n;
      const ds = j === 0 ? L - s[n - 1] : s[j] - s[i];
      t += ds / Math.max(2, (vRef[i] + vRef[j]) / 2);
    }
  }
  const ztRefLine = zoneTimes(tOnLine, alignedRefLapS);
  const ceilingG = lateralCeilingG(p);
  const corners: CornerModel[] = ref.corners.map((c, k) => {
    const sb = brakeRefM[k] !== null || c.braked ? simBrakeStart(env, k).iStart : null;
    return {
      k,
      name: c.name,
      dir: c.dir,
      iApex: iA[k],
      vApexMs: env.v[iA[k]],
      vApexRefMs: vRef[iA[k]],
      aLatG: cornerCap(k),
      aLatPeakG: zonePeak(k),
      aLatInitG: aLatInit[k],
      aLatMeanG: aLatMean[k],
      brakeG: brakeG[k],
      driveG: driveG[k],
      runG: runG[k],
      coastFrac: coastFrac[k],
      coastInM: coastInM[k],

      rollOnS: rollOnS[k],
      brakeStartM: brakeRefM[k],
      simBrakeStartM: sb === null ? null : s[sb],
      zone: zone[k],
      binding: binding(env, iA[k]),
      zoneTimeRefS: c.zoneTimeS,
      zoneTimeSimS: ztSim[k],
      zoneTimeRefOnLineS: ztRefLine[k],
    };
  });
  const over = corners.filter((c) => c.aLatPeakG > ceilingG);
  if (over.length) {
    notes.push(
      `over the lateral ceiling (${ceilingG.toFixed(2)} g): ${over.map((c) => `${c.name} ${c.aLatG.toFixed(2)}${c.aLatPeakG > c.aLatG + 0.005 ? ` (zone peak ${c.aLatPeakG.toFixed(2)})` : ''} g`).join(', ')}`,
    );
  }
  return {
    reference: ref.name,
    corners,
    lapTimeS: env.lapTimeS,
    refLapTimeS: ref.lapTimeS,
    alignedRefLapS,
    envelope: env,
    caps,
    residuals: {
      apexKmh: corners.map((c) => (c.vApexMs - c.vApexRefMs) * 3.6),
      zoneTimeS: corners.map((c) => c.zoneTimeSimS - c.zoneTimeRefS),
      lapS: env.lapTimeS - ref.lapTimeS,
    },
    iterations,
    converged,
    alignment: al,
    ceiling: { aLatG: ceilingG, leanDeg: (Math.atan(ceilingG) * 180) / Math.PI },
    notes,
    stations: { zoneOwner, brakeOwner, driveOwner, inExit, coast, tFromApexS, aRefG: aRef },
    params: p,
    muLatPeakMs2: muLatPeak * G,
  };
}

export interface FitResult {
  session: Session;
  line: Line;
  fit: RiderFit;
}

/**
 * Build the line, fit the rider, and package the fitted lap as a Session
 * named `Fit: <reference name>` with two extra channels: `ref_speed_kmh` (the
 * aligned reference) and `fit_lat_margin` ((ceiling − aLat_k)/ceiling).
 */
export function fitToReference(
  track: TrackModel,
  corridor: Corridor | undefined,
  params: SimParams,
  ref: Reference,
  id: string,
  color: string,
  opts: FitOptions = {},
): FitResult {
  const p = clampParams(params);
  const line = buildLine(track, corridor, p);
  const fit = fitRider(line, p, ref, opts);
  const env = fit.envelope;
  const ch = riderChannels(line, env, p);
  const ceil = fit.ceiling.aLatG;
  const margin = Float32Array.from(fit.caps.aLatMs2 ?? [], (a) => latMargin(a / G, ceil));
  const refKmh = Float32Array.from(fit.alignment.vRefMs, (v) => v * 3.6);
  const session = toSession(line, env, ch, p, id, `Fit: ${ref.name}`, color, [
    { name: 'ref_speed_kmh', unit: 'km/h', data: refKmh },
    { name: 'fit_lat_margin', unit: '', data: margin },
  ]);
  session.meta.rider = `Fit: ${ref.name}`;
  session.meta.note = `reference fit · ${fit.corners.length} corners · ${fit.iterations} iterations`;
  return { session, line, fit };
}
