// Per-corner fit model and tuning on top of the reference-fit rider
// (fitRider.ts). Owner's request (2026-10-12): fit to ANY loaded lap; fit
// every corner on its line, longitudinal g and speed (time is no object,
// ~30 s is fine); then set every corner by hand — its line style V ↔ C and
// the other corner-specific settings — picked on the map, sliders on the left.
//
//   line     the reference lap's own path when it is measured GPS
//            (`pathTrusted`), else the rider's current line. Per corner a
//            line style κ_k blends the corner between the C line (minimum
//            curvature, κ 0: a round arc, high minimum speed) and the V line
//            (minimum distance, κ 1: straight in, tight apex, straight out),
//            as a DELTA on the base line: offsets = base + w_k·(κ_k − κb_k)·(V − C),
//            with κb_k the base line's own least-squares κ in the corner, so
//            the fitted value reproduces the base line exactly. An apex shift
//            slides the corner's offset pattern along the track (late/early).
//   caps     fitRider's per-station caps, scaled per corner: lateral in its
//            zone, braking into it, drive on its exit and on the run after,
//            the roll-on time after its apex, and the coast before it.
//   slide    "slide out" (owner, 2026-10-13): enter the corner fast and let
//            the bike slide out wide, the tyre's slip scrubbing the speed off
//            before the apex. Per corner slideOut s ∈ [0, 1] (0 = off) over the
//            entry (SLIDE_LEAD_M before the zone start → the apex), shaped by
//            sin(π·t), t = 0 at the entry start, 1 at the apex:
//              line   offset toward the outside, s·A·sin²(π·t) (A ≤ SLIDE_OFFSET_M,
//                     less on a short entry: SLIDE_CURV_MAX),
//                     back on the normal apex point at the apex;
//              scrub  extra deceleration s·SLIDE_SCRUB_K·sin(π·t)·|a_lat|
//                     (slip-angle drag: F_y·sin α, α ≈ 9° at K 0.15; solver
//                     `caps.scrubCoef`, ≤ 0.3 g), which lets the rider brake
//                     later and carry more speed in;
//              grip   the lateral cap × (1 + s·SLIDE_LAT_EXCESS·sin(π·t)):
//                     the tyre past its grip peak while sliding, entry only.
//            The fit uses it only where it pays: a penalty SLIDE_REG·s², and
//            only on corners the reference brakes into (SLIDE_FIT_MIN_DROP_MS),
//            and only on a measured (GPS) path.
//   refine   a pattern search on those per-corner settings (and κ_k where the
//            path is not measured) that minimises, per corner, the space-mean
//            of ((v − v_ref)/1 m/s)² + ((a − a_ref)/0.1 g)² over the corner's
//            stretch (its approach, apex and exit): the fit on speed AND
//            longitudinal g, not only on the apex speeds.
//
// Everything here is plain data (typed arrays, numbers): a FitModel crosses a
// Worker boundary by structured clone, and `applyFit` re-solves a tuned lap in
// a few milliseconds on the main thread.
import type { Session, TrackModel } from '../core/types';
import { nearestSample } from './alignRef';
import { fitParams, fitRider, latMargin, longGOnLine } from './fitRider';
import type { LapReference } from './lapReference';
import { buildLine, lineFromOffsets, offsetBounds } from './line';
import { ownerOffsets } from './ownerOffsets';
import { clampParams } from './presets';
import { riderChannels } from './rider';
import { G, solve } from './solver';
import { toSession } from './toSession';
import type { Corridor, Envelope, EnvelopeCaps, Line, SimParams } from './types';

/** One corner's settings. The fit fills them; the sliders move them. */
export interface CornerSetting {
  /** Line style: 0 = C (minimum curvature) … 1 = V (minimum distance). */
  kappa: number;
  /** Apex moved along the track, metres (+ later, − earlier). */
  apexShiftM: number;
  /** Lateral g in the corner's zone, × the fitted rider's (corner speed). */
  latScale: number;
  /** Braking g into the corner, ×. */
  brakeScale: number;
  /** Drive g on the exit (apex → zone end), ×. */
  exitScale: number;
  /** Drive g on the run after the exit (to the next corner), ×. */
  runScale: number;
  /** Throttle roll-on after the apex: 90 % of the drive after this many seconds (0 = none). */
  rollOnS: number;
  /** Coast (no brake, no throttle) before the apex where the reference coasted. */
  coast: boolean;
  /**
   * The corner's minimum speed, km/h relative to the reference's minimum on
   * the corner's stretch (0 = the reference's; a ceiling at that point, so a
   * line that is slower there anyway ignores it; ≥ +40 = off).
   */
  minSpeedDeltaKmh: number;
  /** Slide out on the entry: 0 = off … 1 = in fast, wide before the apex, the slide scrubs the speed. */
  slideOut: number;
}

export const SETTING_BOUNDS: Record<Exclude<keyof CornerSetting, 'coast'>, [number, number]> = {
  kappa: [0, 1],
  apexShiftM: [-30, 30],
  latScale: [0.6, 1.4],
  brakeScale: [0.3, 2],
  exitScale: [0.3, 2.5],
  runScale: [0.3, 2.5],
  rollOnS: [0, 4],
  minSpeedDeltaKmh: [-30, 40],
  slideOut: [0, 1],
};
/** A minimum-speed delta at or above this is off (no ceiling). */
export const MIN_SPEED_OFF_KMH = 40;

export interface FitCornerInfo {
  name: string;
  dir: 1 | -1;
  /** Apex station (= centreline vertex) on the base line. */
  iApex: number;
  /** Zone on the base line, vertex indices (a > b when it wraps the start). */
  zone: [number, number];
  /** The base line's own least-squares line style in the zone. */
  kappaBase: number;
  /** Fitted braking cap into the corner, g (restored where a coast is switched off). */
  brakeG: number;
  /** Reference apex speed, m/s. */
  vApexRefMs: number;
  /** The reference's speed minimum on the corner's stretch: station and speed, m/s. */
  iMin: number;
  vMinRefMs: number;
}

export interface FitModel {
  reference: string;
  refLapTimeS: number;
  /** The reference's path is measured GPS: the base line IS its line. */
  pathTrusted: boolean;
  /** Per centreline vertex, metres (+ left). */
  baseOffsetsM: Float32Array;
  cOffsetsM: Float32Array;
  vOffsetsM: Float32Array;
  loM: Float32Array;
  hiM: Float32Array;
  /** fitRider's caps on the base line, m/s². */
  latMs2: Float32Array;
  brakeMs2: Float32Array;
  driveMs2: Float32Array;
  accelMaxMs2: Float32Array;
  stations: {
    zoneOwner: Int16Array;
    brakeOwner: Int16Array;
    driveOwner: Int16Array;
    inExit: Uint8Array;
    coast: Uint8Array;
    tFromApexS: Float32Array;
  };
  /** Reference speed (m/s) and longitudinal g on the base line's stations. */
  vRefMs: Float32Array;
  aRefG: Float32Array;
  corners: FitCornerInfo[];
  nextK: Int32Array;
  /** The fitted settings (the sliders' reset values). */
  fitted: CornerSetting[];
  params: SimParams;
  muLatPeakMs2: number;
  muXMs2: number;
  /** ∫ds/v_ref over the base line. */
  alignedRefLapS: number;
  /** Mean vertex spacing of the base line, metres. */
  vertexStepM: number;
  notes: string[];
  stats: { fitIterations: number; refineRounds: number; refineSolves: number; errorBefore: number; errorAfter: number; ms: number };
}

/** Speed error scale, m/s. */
const V_SIGMA = 1;
/** Longitudinal-g error scale, g. */
const A_SIGMA = 0.1;
/** Line-style taper outside a corner's zone, metres. */
const TAPER_M = 25;
/** The roll-on's first-order rise: 90 % at rollOnS (as fitRider). */
const ROLL_ON_RATE = Math.log(10);
const DRIVE_MAX_MS2 = 2.0 * G;
const LONG_MIN_MS2 = 0.1 * G;
/** Slide out (see the header): the entry starts this far before the zone start, metres. */
const SLIDE_LEAD_M = 20;
/** Peak outward line offset at slideOut 1, metres. */
const SLIDE_OFFSET_M = 1.5;
/**
 * Ceiling on the curvature the outward drift itself adds (its sin² bump over
 * an entry of length L peaks at 2π²·A/L²), 1/m: 1/250 m, so a short entry
 * drifts less than SLIDE_OFFSET_M rather than kinking the line.
 */
const SLIDE_CURV_MAX = 1 / 250;
/** Scrub deceleration per lateral g at slideOut 1 (≈ sin of a 9° slip angle). */
const SLIDE_SCRUB_K = 0.15;
/** Lateral-cap excess at slideOut 1 (sliding past the grip peak), entry only. */
const SLIDE_LAT_EXCESS = 0.06;
/** Fit penalty per slideOut², in the per-corner error's units. */
const SLIDE_REG = 0.3;
/**
 * The fit tries a slide out only where the reference slows by at least this
 * much over the corner's entry (m/s, ≈ 11 km/h): a braked-into corner, not
 * a fast sweeper where a scrub would only stand in for other errors.
 */
const SLIDE_FIT_MIN_DROP_MS = 3;

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

function cyc(a: number, b: number, n: number): number {
  return (((b - a) % n) + n) % n;
}

/** Weight of corner k's window at vertex i: 1 in the zone, cosine taper over TAPER_M outside. */
function windowWeights(n: number, stepM: number, zone: [number, number]): Float32Array {
  const w = new Float32Array(n);
  const [a, b] = zone;
  const len = cyc(a, b, n);
  const taper = Math.max(1, Math.round(TAPER_M / stepM));
  for (let d = 0; d <= len; d++) w[(a + d) % n] = 1;
  for (let d = 1; d <= taper; d++) {
    const f = 0.5 * (1 + Math.cos((Math.PI * d) / (taper + 1)));
    const ib = (a - d + n) % n;
    const ia = (b + d) % n;
    w[ib] = Math.max(w[ib], f);
    w[ia] = Math.max(w[ia], f);
  }
  return w;
}

/** The fitted settings as neutral values: scales 1, the base line's κ, the fitted roll-on. */
function neutral(kappaBase: number, rollOnS: number): CornerSetting {
  return { kappa: kappaBase, apexShiftM: 0, latScale: 1, brakeScale: 1, exitScale: 1, runScale: 1, rollOnS, coast: true, minSpeedDeltaKmh: 0, slideOut: 0 };
}

/**
 * Corner k's entry for the slide out: stations from SLIDE_LEAD_M before its
 * zone start to its apex, each with sin(π·t) (t 0 → 1 along the entry).
 */
export function slideEntry(model: FitModel, k: number): Array<{ i: number; w: number }> {
  const n = model.baseOffsetsM.length;
  const c = model.corners[k];
  const lead = Math.round(SLIDE_LEAD_M / model.vertexStepM);
  const a = (c.zone[0] - lead + n) % n;
  const len = cyc(a, c.iApex, n);
  if (len < 2 || len > n / 2) return [];
  const out: Array<{ i: number; w: number }> = [];
  for (let d = 0; d <= len; d++) out.push({ i: (a + d) % n, w: Math.sin((Math.PI * d) / len) });
  return out;
}

/** Offsets of the tuned line (per centreline vertex). */
export function tunedOffsets(model: FitModel, settings: CornerSetting[]): Float32Array {
  const n = model.baseOffsetsM.length;
  const d = Float32Array.from(model.baseOffsetsM);
  const any = settings.some((s, k) => Math.abs(s.kappa - model.corners[k].kappaBase) > 1e-6 || s.apexShiftM !== 0 || s.slideOut > 0);
  if (!any) return d;
  const vertexStep = model.vertexStepM;
  for (let k = 0; k < model.corners.length; k++) {
    const c = model.corners[k];
    const dk = settings[k].kappa - c.kappaBase;
    if (Math.abs(dk) < 1e-6) continue;
    const w = windowWeights(n, vertexStep, c.zone);
    for (let i = 0; i < n; i++) if (w[i] > 0) d[i] += w[i] * dk * (model.vOffsetsM[i] - model.cOffsetsM[i]);
  }
  for (let k = 0; k < model.corners.length; k++) {
    const sh = Math.round(settings[k].apexShiftM / vertexStep);
    if (sh === 0) continue;
    const w = windowWeights(n, vertexStep, model.corners[k].zone);
    const src = Float32Array.from(d);
    for (let i = 0; i < n; i++) if (w[i] > 0) d[i] = src[i] + w[i] * (src[(i - sh + n) % n] - src[i]);
  }
  // slide out: wide (toward the corner's outside, −dir) before the apex
  for (let k = 0; k < model.corners.length; k++) {
    const s = settings[k].slideOut;
    if (!(s > 0)) continue;
    const entry = slideEntry(model, k);
    const L = entry.length * vertexStep;
    const amp = -model.corners[k].dir * s * Math.min(SLIDE_OFFSET_M, (SLIDE_CURV_MAX * L * L) / (2 * Math.PI * Math.PI));
    for (const { i, w } of entry) d[i] += amp * w * w;
  }
  // inside the box (or the measured path, where it rode past the box)
  for (let i = 0; i < n; i++) {
    const b = model.baseOffsetsM[i];
    d[i] = clamp(d[i], Math.min(model.loM[i], b), Math.max(model.hiM[i], b));
  }
  return d;
}

/** The caps of a tuned lap, per station. */
export function tunedCaps(model: FitModel, settings: CornerSetting[]): EnvelopeCaps {
  const n = model.latMs2.length;
  const st = model.stations;
  const lat = new Float32Array(n);
  const axis = new Float32Array(n);
  const brake = new Float32Array(n);
  const drive = new Float32Array(n);
  const scale = new Float32Array(n);
  const accel = new Float32Array(n);
  const vMax = new Float32Array(n).fill(Infinity);
  model.corners.forEach((c, k) => {
    const d = settings[k].minSpeedDeltaKmh;
    if (d < MIN_SPEED_OFF_KMH) vMax[c.iMin] = Math.max(1, c.vMinRefMs + d / 3.6);
  });
  for (let i = 0; i < n; i++) {
    const z = st.zoneOwner[i];
    lat[i] = model.latMs2[i] * (z >= 0 ? settings[z].latScale : 1);
    axis[i] = Math.max(lat[i], model.muLatPeakMs2);
    const kb = st.brakeOwner[i];
    const kd = st.driveOwner[i];
    const coasting = st.coast[i] === 1 && settings[kb].coast;
    if (st.coast[i] === 1 && !coasting) {
      // the coast switched off: the fitted braking cap and no accel ceiling
      brake[i] = clamp(model.corners[kb].brakeG * G * settings[kb].brakeScale, LONG_MIN_MS2, model.muXMs2);
      accel[i] = Infinity;
    } else {
      brake[i] = coasting ? model.brakeMs2[i] : clamp(model.brakeMs2[i] * settings[kb].brakeScale, LONG_MIN_MS2, model.muXMs2);
      accel[i] = model.accelMaxMs2[i];
    }
    const ds = st.inExit[i] ? settings[kd].exitScale : settings[kd].runScale;
    drive[i] = clamp(model.driveMs2[i] * ds, LONG_MIN_MS2, DRIVE_MAX_MS2);
    const t = st.tFromApexS[i];
    const R = settings[kd].rollOnS;
    scale[i] = Number.isFinite(t) && R > 0 && t < R ? 1 - Math.exp((-t * ROLL_ON_RATE) / R) : 1;
  }
  // slide out: scrub and a little lateral excess over the entry
  let scrub: Float32Array | undefined;
  model.corners.forEach((_, k) => {
    const s = settings[k].slideOut;
    if (!(s > 0)) return;
    scrub ??= new Float32Array(n);
    for (const { i, w } of slideEntry(model, k)) {
      scrub[i] = Math.max(scrub[i], s * SLIDE_SCRUB_K * w);
      lat[i] *= 1 + s * SLIDE_LAT_EXCESS * w;
      axis[i] = Math.max(lat[i], model.muLatPeakMs2);
    }
  });
  return { aLatMs2: lat, latAxisMs2: axis, brakeMs2: brake, driveMs2: drive, driveScale: scale, accelMaxMs2: accel, vMaxMs: vMax, skipRollRate: true, ...(scrub ? { scrubCoef: scrub } : {}) };
}

export interface AppliedFit {
  line: Line;
  env: Envelope;
  caps: EnvelopeCaps;
}

/** Ride the model with these settings. */
export function applyFit(track: TrackModel, model: FitModel, settings: CornerSetting[]): AppliedFit {
  const line = lineFromOffsets(track, tunedOffsets(model, settings));
  const caps = tunedCaps(model, settings);
  return { line, env: solve(line, model.params, caps), caps };
}

/** Station → the corner whose stretch it belongs to (its exit, else the corner it brakes into). */
function regionOwner(model: FitModel, i: number): number {
  const st = model.stations;
  return st.inExit[i] ? st.driveOwner[i] : st.brakeOwner[i];
}

/** Per-corner error: space-mean of ((v−vr)/σv)² + ((a−ar)/σa)² over each corner's stretch. */
export function cornerErrors(model: FitModel, line: Line, env: Envelope): Float64Array {
  const K = model.corners.length;
  const n = line.points.length;
  const a = longGOnLine(line, env.v);
  const sum = new Float64Array(K);
  const len = new Float64Array(K);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ds = j === 0 ? line.lengthM - line.cumDistM[n - 1] : line.cumDistM[j] - line.cumDistM[i];
    const k = regionOwner(model, i);
    if (k < 0) continue;
    const ev = (env.v[i] - model.vRefMs[i]) / V_SIGMA;
    const ea = (a[i] - model.aRefG[i]) / A_SIGMA;
    sum[k] += (ev * ev + ea * ea) * ds;
    len[k] += ds;
  }
  for (let k = 0; k < K; k++) sum[k] = len[k] > 0 ? sum[k] / len[k] : 0;
  return sum;
}

export interface FitProgress {
  frac: number;
  stage: string;
  error?: number;
}

export interface BuildFitOptions {
  /** Wall-clock budget of the refinement, ms. Default 25 000. */
  budgetMs?: number;
  /** Skip the refinement (fitRider only). */
  noRefine?: boolean;
  onProgress?: (p: FitProgress) => void;
  now?: () => number;
}

/**
 * ∫ds/v_ref over a line whose stations are the base line's (the reference
 * speed is per station). On a tuned line (κ_k ≠ κb_k) the stations are the
 * same vertices but the distances between them are the tuned line's, so this
 * is the reference speed ridden on THAT line: the apples-to-apples lap for a
 * fit that matches v(station), not the lap time.
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

/** Per-corner line style the base line has, by least squares onto C + κ(V − C) in the zone. */
function lsKappa(base: Float32Array, C: Float32Array, V: Float32Array, zone: [number, number]): number {
  const n = base.length;
  let num = 0;
  let den = 0;
  for (let d = 0, i = zone[0]; d <= cyc(zone[0], zone[1], n); d++, i = (i + 1) % n) {
    const e = V[i] - C[i];
    num += (base[i] - C[i]) * e;
    den += e * e;
  }
  return den > 1e-6 ? clamp(num / den, 0, 1) : 0.5;
}

/**
 * Fit the per-corner model to a reference lap: the base line, fitRider's caps
 * on it, then the refinement on speed and longitudinal g.
 */
export function buildFitModel(track: TrackModel, corridor: Corridor | undefined, params: SimParams, lapRef: LapReference, opts: BuildFitOptions = {}): FitModel {
  const now = opts.now ?? (() => Date.now());
  const t0 = now();
  const progress = opts.onProgress ?? (() => {});
  const p = clampParams(params);
  const flat = (kappa: number): SimParams => ({ ...p, rider: { ...p.rider, kappa, lineMode: 'min-curvature', lineDeviationM: 0 } });
  progress({ frac: 0.02, stage: 'C / V lines' });
  const C = buildLine(track, corridor, flat(0)).offsetM!;
  const V = buildLine(track, corridor, flat(1)).offsetM!;
  const { loM, hiM } = offsetBounds(track, corridor, p);
  const ref = lapRef.ref;
  const base =
    lapRef.pathTrusted && ref.lon && ref.lat
      ? ownerOffsets(track, ref.lon, ref.lat)
      : Float32Array.from(buildLine(track, corridor, { ...p, rider: { ...p.rider, lineDeviationM: 0 } }).offsetM!);
  const line = lineFromOffsets(track, base);
  const n = line.points.length;
  progress({ frac: 0.05, stage: 'fitting corners' });
  const fit = fitRider(line, p, ref, { align: { pathOnLine: lapRef.pathTrusted } });
  const caps = fit.caps;
  const vertexStepM = line.lengthM / n;

  const corners: FitCornerInfo[] = fit.corners.map((c) => {
    const zone: [number, number] = [nearestSample(line, c.zone[0]), nearestSample(line, c.zone[1])];
    return {
      name: c.name,
      dir: c.dir,
      iApex: c.iApex,
      zone,
      kappaBase: lsKappa(base, C, V, zone),
      brakeG: c.brakeG,
      vApexRefMs: c.vApexRefMs,
      iMin: -1,
      vMinRefMs: 0,
    };
  });
  const K = corners.length;
  const byApex = corners.map((_, k) => k).sort((a, b) => corners[a].iApex - corners[b].iApex);
  const nextK = new Int32Array(K);
  byApex.forEach((k, r) => (nextK[k] = byApex[(r + 1) % K]));

  const vRef = fit.alignment.vRefMs;
  const alignedRefLapS = refTimeOnLine(line, vRef);

  const model: FitModel = {
    reference: ref.name,
    refLapTimeS: ref.lapTimeS,
    pathTrusted: lapRef.pathTrusted,
    baseOffsetsM: Float32Array.from(base),
    cOffsetsM: Float32Array.from(C),
    vOffsetsM: Float32Array.from(V),
    loM,
    hiM,
    latMs2: Float32Array.from(caps.aLatMs2!),
    brakeMs2: Float32Array.from(caps.brakeMs2!),
    driveMs2: Float32Array.from(caps.driveMs2!),
    accelMaxMs2: Float32Array.from(caps.accelMaxMs2!),
    stations: {
      zoneOwner: fit.stations.zoneOwner,
      brakeOwner: fit.stations.brakeOwner,
      driveOwner: fit.stations.driveOwner,
      inExit: fit.stations.inExit,
      coast: fit.stations.coast,
      tFromApexS: fit.stations.tFromApexS,
    },
    vRefMs: Float32Array.from(vRef),
    aRefG: Float32Array.from(fit.stations.aRefG),
    corners,
    nextK,
    fitted: [],
    params: fit.params,
    muLatPeakMs2: fit.muLatPeakMs2,
    muXMs2: ((fit.params.tyre.muX ?? fit.params.tyre.mu) * fit.params.tyre.gripScale) * G,
    alignedRefLapS,
    notes: [...fit.notes],
    stats: { fitIterations: fit.iterations, refineRounds: 0, refineSolves: 0, errorBefore: NaN, errorAfter: NaN, ms: 0 },
    vertexStepM,
  };
  // each corner's reference speed minimum on its stretch
  for (let i = 0; i < n; i++) {
    const k = regionOwner(model, i);
    if (k < 0) continue;
    const c = corners[k];
    if (c.iMin < 0 || vRef[i] < vRef[c.iMin]) c.iMin = i;
  }
  for (const c of corners) {
    if (c.iMin < 0) c.iMin = c.iApex;
    c.vMinRefMs = vRef[c.iMin];
  }
  model.fitted = corners.map((c, k) => neutral(c.kappaBase, fit.corners[k].rollOnS));
  if (!opts.noRefine) refine(track, model, opts.budgetMs ?? 25_000, now, progress);
  else {
    const r = applyFit(track, model, model.fitted);
    const e = cornerErrors(model, r.line, r.env).reduce((a, b) => a + b, 0);
    model.stats.errorBefore = e;
    model.stats.errorAfter = e;
  }
  model.stats.ms = now() - t0;
  progress({ frac: 1, stage: 'done', error: model.stats.errorAfter });
  return model;
}

type NumKey = Exclude<keyof CornerSetting, 'coast'>;

/**
 * Pattern search on the per-corner settings. Every round tries each setting
 * up and down in ALL corners at once (one solve), keeps the corners whose own
 * error (their stretch and the next corner's, which a run cap or a roll-on
 * reaches into) fell, and commits the merged move when the total fell too;
 * a step that helps nowhere halves. Corners are nearly independent, so one
 * solve per move serves every corner.
 */
function refine(track: TrackModel, model: FitModel, budgetMs: number, now: () => number, progress: (p: FitProgress) => void): void {
  const t0 = now();
  const K = model.corners.length;
  const keys: Array<{ key: NumKey; step: number; mult: boolean; min: number }> = [
    { key: 'latScale', step: 0.04, mult: true, min: 0.002 },
    { key: 'brakeScale', step: 0.1, mult: true, min: 0.005 },
    { key: 'exitScale', step: 0.1, mult: true, min: 0.005 },
    { key: 'runScale', step: 0.1, mult: true, min: 0.005 },
    { key: 'rollOnS', step: 0.3, mult: false, min: 0.02 },
    { key: 'minSpeedDeltaKmh', step: 3, mult: false, min: 0.2 },
    { key: 'slideOut', step: 0.25, mult: false, min: 0.02 },
  ];
  // the line is a fit parameter only where the path was not measured
  if (!model.pathTrusted) keys.push({ key: 'kappa', step: 0.2, mult: false, min: 0.02 });
  let cur = model.fitted.map((s) => ({ ...s }));
  let solves = 0;
  // where the slide out may be fitted at all (see SLIDE_FIT_MIN_DROP_MS)
  const slideOk = model.corners.map((c, k) => {
    const e = slideEntry(model, k);
    // only on a measured path: on a rider's / hand-placed line the fit cannot
    // tell a slide from the line style and trades one for the other (the BMW
    // lap: κ dragged to a 1.2 s slower line)
    return model.pathTrusted && e.length > 0 && model.vRefMs[e[0].i] - model.vRefMs[c.iApex] >= SLIDE_FIT_MIN_DROP_MS;
  });
  const frozen = (key: NumKey, k: number): boolean => key === 'slideOut' && !slideOk[k];
  // the objective: the per-corner error plus the slide-out penalty
  const evalAt = (set: CornerSetting[]): Float64Array => {
    solves++;
    const r = applyFit(track, model, set);
    const err = cornerErrors(model, r.line, r.env);
    for (let k = 0; k < K; k++) err[k] += SLIDE_REG * set[k].slideOut * set[k].slideOut;
    return err;
  };
  const total = (e: Float64Array): number => e.reduce((a, b) => a + b, 0);
  let e = evalAt(cur);
  model.stats.errorBefore = total(e);
  const local = (err: Float64Array, k: number): number => err[k] + err[model.nextK[k]];
  let rounds = 0;
  for (; now() - t0 < budgetMs; rounds++) {
    let movedAny = false;
    let live = false;
    for (const kd of keys) {
      // the slide out waits for phase 2 (corner by corner): moved in every
      // corner at once it drags the line style (κ, path not measured) into
      // another, slower minimum
      if (kd.step < kd.min || kd.key === 'slideOut') continue;
      live = true;
      let improved = false;
      for (const sign of [1, -1]) {
        if (now() - t0 >= budgetMs) break;
        const [lo, hi] = SETTING_BOUNDS[kd.key];
        const trial = cur.map((s, k) => {
          if (frozen(kd.key, k)) return s;
          const v = s[kd.key];
          const nv = kd.mult ? v * (1 + sign * kd.step) : v + sign * kd.step;
          return { ...s, [kd.key]: clamp(nv, lo, hi) };
        });
        const eT = evalAt(trial);
        const take = new Uint8Array(K);
        let any = false;
        for (let k = 0; k < K; k++) {
          if (trial[k][kd.key] !== cur[k][kd.key] && local(eT, k) < local(e, k) - 1e-9) {
            take[k] = 1;
            any = true;
          }
        }
        if (!any) continue;
        const merged = cur.map((s, k) => (take[k] ? trial[k] : s));
        const eM = evalAt(merged);
        if (total(eM) < total(e) - 1e-9) {
          cur = merged;
          e = eM;
          improved = true;
          movedAny = true;
          break;
        }
      }
      if (!improved) kd.step *= 0.5;
    }
    progress({ frac: 0.1 + 0.88 * Math.min(1, (now() - t0) / budgetMs), stage: `refining (round ${rounds + 1})`, error: total(e) });
    if (!live) break;
    if (!movedAny && keys.every((k) => k.key === 'slideOut' || k.step < k.min)) break;
  }
  // Phase 2: corner by corner (one solve per try, judged on the corner's own
  // stretch AND the lap total, so the coupling between neighbours is
  // respected), each corner with its own steps; when every step has shrunk
  // below its floor and time is left, the steps open up again once.
  const steps = cur.map(() => keys.map((kd) => (kd.key === 'slideOut' ? kd.step : Math.max(kd.step * 4, kd.min * 8))));
  let restarts = 0;
  const coastTried = new Uint8Array(K);
  while (now() - t0 < budgetMs) {
    let live = false;
    for (let r = 0; r < K && now() - t0 < budgetMs; r++) {
      const k = r;
      keys.forEach((kd, q) => {
        if (steps[k][q] < kd.min || now() - t0 >= budgetMs || frozen(kd.key, k)) return;
        live = true;
        const [lo, hi] = SETTING_BOUNDS[kd.key];
        for (const sign of [1, -1]) {
          const v = cur[k][kd.key];
          const nv = clamp(kd.mult ? v * (1 + sign * steps[k][q]) : v + sign * steps[k][q], lo, hi);
          if (nv === v) continue;
          const trial = cur.map((x, j) => (j === k ? { ...x, [kd.key]: nv } : x));
          const eT = evalAt(trial);
          if (local(eT, k) < local(e, k) - 1e-9 && total(eT) < total(e) - 1e-9) {
            cur = trial;
            e = eT;
            steps[k][q] *= 1.5;
            return;
          }
        }
        steps[k][q] *= 0.5;
      });
      // the coast before the apex: on or off
      if (now() - t0 < budgetMs && coastTried[k] < 2) {
        coastTried[k]++;
        const trial = cur.map((x, j) => (j === k ? { ...x, coast: !x.coast } : x));
        const eT = evalAt(trial);
        if (local(eT, k) < local(e, k) - 1e-9 && total(eT) < total(e) - 1e-9) {
          cur = trial;
          e = eT;
          live = true;
        }
      }
    }
    rounds++;
    progress({ frac: 0.1 + 0.88 * Math.min(1, (now() - t0) / budgetMs), stage: `refining corners (round ${rounds})`, error: total(e) });
    if (!live) {
      if (restarts >= 2) break;
      restarts++;
      coastTried.fill(0);
      for (const row of steps) keys.forEach((kd, q) => (row[q] = kd.min * 16));
    }
  }
  model.fitted = cur;
  model.stats.refineRounds = rounds;
  model.stats.refineSolves = solves;
  // the reported error is the fit error alone (no penalty), as cornerErrors gives it
  const rEnd = applyFit(track, model, cur);
  model.stats.errorAfter = total(cornerErrors(model, rEnd.line, rEnd.env));
}

export interface FitCornerRow {
  name: string;
  dir: 1 | -1;
  apexRefKmh: number;
  apexSimKmh: number;
  /** RMS speed error over the corner's stretch, km/h. */
  vRmsKmh: number;
  /** RMS longitudinal-g error over the corner's stretch, g. */
  aRmsG: number;
  /** |lateral g| at the apex. */
  aLatG: number;
  /** Peak |lateral g| in the zone. */
  aLatPeakG: number;
  leanDeg: number;
  marginPct: number;
}

/** Per-corner report of a ridden (tuned) lap against the reference. */
export function fitRows(model: FitModel, line: Line, env: Envelope, ceilingG: number): FitCornerRow[] {
  const n = line.points.length;
  const K = model.corners.length;
  const a = longGOnLine(line, env.v);
  const sv = new Float64Array(K);
  const sa = new Float64Array(K);
  const len = new Float64Array(K);
  const peak = new Float64Array(K);
  for (let i = 0; i < n; i++) {
    const k = regionOwner(model, i);
    if (k < 0) continue;
    const j = (i + 1) % n;
    const ds = j === 0 ? line.lengthM - line.cumDistM[n - 1] : line.cumDistM[j] - line.cumDistM[i];
    sv[k] += (env.v[i] - model.vRefMs[i]) ** 2 * ds;
    sa[k] += (a[i] - model.aRefG[i]) ** 2 * ds;
    len[k] += ds;
    const z = model.stations.zoneOwner[i];
    if (z >= 0) peak[z] = Math.max(peak[z], Math.abs(env.latG[i]));
  }
  return model.corners.map((c, k) => ({
    name: c.name,
    dir: c.dir,
    apexRefKmh: model.vRefMs[c.iApex] * 3.6,
    apexSimKmh: env.v[c.iApex] * 3.6,
    vRmsKmh: len[k] > 0 ? Math.sqrt(sv[k] / len[k]) * 3.6 : 0,
    aRmsG: len[k] > 0 ? Math.sqrt(sa[k] / len[k]) : 0,
    aLatG: Math.abs(env.latG[c.iApex]),
    aLatPeakG: peak[k],
    leanDeg: (Math.atan(peak[k]) * 180) / Math.PI,
    marginPct: 100 * latMargin(peak[k], ceilingG),
  }));
}

/** The tuned lap as a Session (`Fit: <reference>`), with the reference speed and long g alongside. */
export function fitSession(model: FitModel, applied: AppliedFit, id: string, color: string): Session {
  const { line, env } = applied;
  const ch = riderChannels(line, env, model.params);
  const session = toSession(line, env, ch, model.params, id, `Fit: ${model.reference}`, color, [
    { name: 'ref_speed_kmh', unit: 'km/h', data: Float32Array.from(model.vRefMs, (v) => v * 3.6) },
    { name: 'ref_long_g', unit: 'g', data: model.aRefG },
  ]);
  session.meta.rider = `Fit: ${model.reference}`;
  session.meta.note = `reference fit · ${model.corners.length} corners`;
  return session;
}

/** Re-export so callers need one import for the fitted rider's params. */
export { fitParams };
