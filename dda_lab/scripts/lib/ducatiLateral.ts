// Library for scripts/ducati-lateral.ts (docs/superpowers/notes/2026-10-11-ducati-lateral-g.md).
import { readFileSync } from 'node:fs';
import { toLocalM } from '../../src/core/geo';
import type { LngLat } from '../../src/core/types';
import { fitRider, type RiderFit } from '../../src/sim/fitRider';
import { clampParams, DEFAULT_SIM_PARAMS, presetById } from '../../src/sim/presets';
import {
  ddaLapTrace,
  pathCurvature,
  fitGroundSpeed,
  referenceFromDda,
  type DdaJson,
  type DdaLapTrace,
  type GroundSpeedModel,
  trackCornersFromPist,
} from '../../src/sim/referenceFromDda';
import type { Reference } from '../../src/sim/reference';
import { deriveRider } from '../../src/sim/derive';
import type { Line, SimParams } from '../../src/sim/types';
import type { TrackModel } from '../../src/core/types';
import { chooseCurvatureScaleM, CURV_SCALE_M, lineFromOffsets, polylineCurvature } from '../../src/sim/line';
import { classifyLaps } from './ddaLap';
import { fitLine, type PistModel } from './fitLines';

export const INBOX = '/Users/macbookmini/projects/DDA_Reader/_inbox';
export const DEFAULT_RUN = `${INBOX}/Run036-219926-00.00.json`;
export const DEFAULT_TRACK = `${INBOX}/serres.pist.json`;
const G = 9.81;
const R2D = 180 / Math.PI;

export const f = (x: number | null | undefined, d = 2): string => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(d));
export const sg = (x: number, d = 2): string => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${x.toFixed(d)}` : '—');
export const median = (xs: number[]): number => {
  const a = xs.filter(Number.isFinite).sort((p, q) => p - q);
  if (!a.length) return Number.NaN;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const pct = (xs: number[], p: number): number => {
  const a = xs.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return Number.NaN;
  const r = (p / 100) * (a.length - 1);
  const i = Math.floor(r);
  return a[i] + (a[Math.min(a.length - 1, i + 1)] - a[i]) * (r - i);
};
function corr(x: number[], y: number[]): number {
  const n = x.length;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  return sxy / Math.sqrt(sxx * syy);
}
export const rmse = (d: number[]): number => Math.sqrt(d.reduce((a, b) => a + b * b, 0) / Math.max(1, d.length));

/** Signed lateral offset (+ left) of p from the pist centreline and the half-widths there, metres. */
export function corridorOffset(model: PistModel, p: LngLat): { offM: number; wL: number; wR: number; station: number } {
  const { pkg } = model;
  const cl = pkg.centerline;
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < cl.length; i++) {
    const q = toLocalM(p, cl[i]);
    const d = q[0] * q[0] + q[1] * q[1];
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  const a = cl[(best - 1 + cl.length) % cl.length];
  const b = cl[(best + 1) % cl.length];
  const c = cl[best];
  const T = toLocalM(c, b);
  const T0 = toLocalM(c, a);
  const tx = T[0] - T0[0];
  const ty = T[1] - T0[1];
  const tl = Math.hypot(tx, ty) || 1;
  const P = toLocalM(c, p);
  const offM = (tx * P[1] - ty * P[0]) / tl; // cross(t, p): + left of travel
  const dist = (e: LngLat | null): number => {
    if (!e) return Number.NaN;
    const q = toLocalM(c, e);
    return Math.hypot(q[0], q[1]);
  };
  return { offM, wL: dist(pkg.leftEdge[best]), wR: dist(pkg.rightEdge[best]), station: best };
}

export interface MeasuredCorner {
  name: string;
  dir: 1 | -1;
  apexM: number;
  /** Minimum ground speed within ±30 m of the lap's own apex, km/h. */
  vMinKmh: number;
  /** v²|κ|/g at the lap's own κ apex. */
  gGpsApex: number;
  /** Largest v²·dir·κ/g in the zone. */
  gGpsMax: number;
  /** Peak |lean| in the zone, degrees, and tan of it. */
  leanMaxDeg: number;
  gLean: number;
  /** tan(|lean|) at the lap's own κ apex. */
  gLeanApex: number;
  /** Calibrated lean g at the zone's peak: tan(max|φ − zero| − excess) (see LeanCal). */
  gLeanCal: number;
  /** Offset toward the INSIDE of the corner at the apex / inner half-width (1 = on the inside edge). */
  insideFrac: number;
  offInsideM: number;
  wInsideM: number;
  /** Offset toward the OUTSIDE at the zone entry and exit / outer half-width (1 = on the outside edge). */
  entryOutFrac: number;
  exitOutFrac: number;
}

/**
 * Lean → lateral g calibration: tan(|φ − zeroDeg| − excessDeg). `zeroDeg` is the
 * IMU's signed zero, `excessDeg` the bike roll beyond the effective lean (the
 * tyre's width rolls the bike further than the resultant; hang-off takes some back).
 */
export interface LeanCal {
  zeroDeg: number;
  excessDeg: number;
}
export const leanG = (leanDeg: number, cal: LeanCal): number => Math.tan(Math.max(0, Math.abs(leanDeg - cal.zeroDeg) - cal.excessDeg) / R2D);

export function measureCorners(trace: DdaLapTrace, ref: Reference, model: PistModel, cal: LeanCal = { zeroDeg: 0, excessDeg: 0 }): MeasuredCorner[] {
  const N = trace.lon.length;
  const at = (s: number): number => ((Math.round(s) % N) + N) % N;
  return ref.corners.map((c) => {
    const dir = c.dir;
    const ia = at(c.apexM);
    let iMin = ia;
    for (let d = -30; d <= 30; d++) if (trace.vMs[at(ia + d)] < trace.vMs[iMin]) iMin = at(ia + d);
    let gMax = 0;
    let leanMax = 0;
    let leanMaxC = 0;
    const [z0, z1] = c.zoneM;
    const len = (((z1 - z0) % N) + N) % N;
    for (let d = 0; d <= len; d++) {
      const i = at(z0 + d);
      gMax = Math.max(gMax, (trace.vMs[i] ** 2 * dir * trace.kappa[i]) / G);
      leanMax = Math.max(leanMax, Math.abs(trace.leanDeg[i]));
      leanMaxC = Math.max(leanMaxC, leanG(trace.leanDeg[i], cal));
    }
    const off = (i: number): { inside: number; w: number; wOut: number } => {
      const o = corridorOffset(model, [trace.lon[i], trace.lat[i]]);
      const inside = dir * o.offM;
      return { inside, w: dir > 0 ? o.wL : o.wR, wOut: dir > 0 ? o.wR : o.wL };
    };
    const oa = off(ia);
    const oe = off(at(z0));
    const ox = off(at(z1));
    return {
      name: c.name,
      dir,
      apexM: c.apexM,
      vMinKmh: trace.vMs[iMin] * 3.6,
      gGpsApex: (trace.vMs[ia] ** 2 * Math.abs(trace.kappa[ia])) / G,
      gGpsMax: gMax,
      leanMaxDeg: leanMax,
      gLean: Math.tan(leanMax / R2D),
      gLeanApex: Math.tan(Math.abs(trace.leanDeg[ia]) / R2D),
      gLeanCal: leanMaxC,
      insideFrac: oa.inside / oa.w,
      offInsideM: oa.inside,
      wInsideM: oa.w,
      entryOutFrac: -oe.inside / oe.wOut,
      exitOutFrac: -ox.inside / ox.wOut,
    };
  });
}

export function panigaleParams(kerbM = 1.0): SimParams {
  const pr = presetById('panigale-v4');
  const tyre = { ...pr.tyre, mu: 1.35, maxLeanDeg: 59, kerbM };
  return clampParams({
    machine: { presetId: pr.id, ...pr.machine },
    tyre,
    rider: deriveRider({ ...DEFAULT_SIM_PARAMS.rider, kappa: pr.kappa }, tyre),
  });
}

export interface ChannelStats {
  n: number;
  accelLatVsTanLeanMaxAbs: number;
  corrAccelLatTanLean: number;
  corrGpsTanLean: number;
  corrGpsTanLeanCornering: number;
  peakGpsG: number;
  p99GpsG: number;
  peakTanLeanG: number;
  p99TanLeanG: number;
  peakAccelLatG: number;
  /** +1: lean and κ have the same sign; −1: opposite (left lean negative). */
  leanSignVsKappa: number;
  /** v_dash²κ / v_ground²κ in corners (what the uncorrected dash speed would claim). */
  dashOverGround: number;
  /** IMU lean on near-straight fast samples, signed mean, degrees. */
  imuZeroDeg: number;
  /** Signed zero b fitted so tan|φ − b| ≈ |v²κ/g| (cornering), degrees. */
  fitZeroDeg: number;
  /** Two-parameter fit tan(|φ − b2| − c2) ≈ |v²κ/g|: signed zero b2 and symmetric excess roll c2, degrees; rms after, g. */
  fit2ZeroDeg: number;
  fit2ExcessDeg: number;
  fit2Rms: number;
  /** Median of tan|φ| − |v²κ/g| in left / right corners, raw and with the straight-line zero removed. */
  leftRaw: number;
  rightRaw: number;
  leftZ: number;
  rightZ: number;
  /** LS slope |v²κ/g| on tan|φ − zero| (cornering), and the rms of the difference, raw / zero removed. */
  slopeZ: number;
  rmsRaw: number;
  rmsZ: number;
  /** κ window sensitivity: window m → [p99 |v²κ/g|, slope on tan|φ − zero|]. */
  windows: Array<{ windowM: number; p99G: number; slope: number; corr: number }>;
}

/** Channel identity over one lap: per record, at the bike's position. */
export function channelStats(trace: DdaLapTrace, gs: GroundSpeedModel): ChannelStats {
  const N = trace.lon.length;
  const r = trace.rec;
  const kAt = (kap: ArrayLike<number>, s: number): number => {
    const i = Math.floor(s);
    const fr = s - i;
    return kap[((i % N) + N) % N] * (1 - fr) + kap[(((i + 1) % N) + N) % N] * fr;
  };
  const gpsFor = (kap: ArrayLike<number>): number[] => Array.from(r.tS, (_, k) => (r.vMs[k] ** 2 * kAt(kap, r.sM[k])) / G);
  const gps = gpsFor(trace.kappa);
  const lean = Array.from(r.leanDeg);
  const tl = lean.map((x) => Math.tan(x / R2D));
  const al = Array.from(r.accelLatG);
  let maxD = 0;
  for (let k = 0; k < tl.length; k++) maxD = Math.max(maxD, Math.abs(al[k] - tl[k]));
  const sgn = Math.sign(corr(gps, tl));
  const tlS = tl.map((x) => sgn * x);
  const corn = gps.map((_, k) => Math.abs(tl[k]) > 0.3);
  const ci = <T,>(a: T[]): T[] => a.filter((_, k) => corn[k]);
  const straight = lean.filter((_, k) => Math.abs(kAt(trace.kappa, r.sM[k])) < 1 / 1500 && r.vMs[k] > 40);
  const imuZero = straight.reduce((a, b) => a + b, 0) / Math.max(1, straight.length);
  const tanZ = (k: number, z: number): number => Math.tan(Math.abs(lean[k] - z) / R2D);
  let fitZ = 0;
  let bestE = Infinity;
  for (let z = -6; z <= 6.0001; z += 0.05) {
    let e = 0;
    for (let k = 0; k < gps.length; k++) if (corn[k]) e += (tanZ(k, z) - Math.abs(gps[k])) ** 2;
    if (e < bestE) {
      bestE = e;
      fitZ = Math.round(z * 100) / 100;
    }
  }
  let b2 = 0;
  let c2 = 0;
  let e2 = Infinity;
  for (let b = -4; b <= 4.0001; b += 0.1) {
    for (let c = -4; c <= 6.0001; c += 0.1) {
      let e = 0;
      let m = 0;
      for (let k = 0; k < gps.length; k++) {
        if (!corn[k]) continue;
        e += (Math.tan((Math.abs(lean[k] - b) - c) / R2D) - Math.abs(gps[k])) ** 2;
        m++;
      }
      if (e / m < e2) {
        e2 = e / m;
        b2 = Math.round(b * 10) / 10;
        c2 = Math.round(c * 10) / 10;
      }
    }
  }
  // left corners: κ > 0
  const side = (left: boolean, z: number): number =>
    median(gps.map((g, k) => (corn[k] && g > 0 === left ? tanZ(k, z) - Math.abs(g) : Number.NaN)));
  const slopeOn = (g: number[], z: number): number => {
    let num = 0;
    let den = 0;
    for (let k = 0; k < g.length; k++) {
      if (!corn[k]) continue;
      const t = tanZ(k, z);
      num += Math.abs(g[k]) * t;
      den += t * t;
    }
    return num / den;
  };
  const diff = (z: number): number[] => gps.map((g, k) => (corn[k] ? Math.abs(g) - tanZ(k, z) : Number.NaN)).filter(Number.isFinite);
  const windows = [10, 14, 20, 30].map((w) => {
    const g = gpsFor(pathCurvature(trace.lon, trace.lat, w));
    return { windowM: w, p99G: pct(g.map(Math.abs), 99), slope: slopeOn(g, imuZero), corr: corr(ci(g), ci(tlS)) };
  });
  const dashOver = ci(lean).map((x) => {
    const ph = x / R2D;
    const ratio = (gs.a + gs.b * (1 - Math.cos(ph))) / trace.speedScale;
    return ratio * ratio;
  });
  const absG = gps.map(Math.abs);
  const absT = tl.map(Math.abs);
  return {
    n: gps.length,
    accelLatVsTanLeanMaxAbs: maxD,
    corrAccelLatTanLean: corr(al, tl),
    corrGpsTanLean: corr(gps, tlS),
    corrGpsTanLeanCornering: corr(ci(gps), ci(tlS)),
    peakGpsG: Math.max(...absG),
    p99GpsG: pct(absG, 99),
    peakTanLeanG: Math.max(...absT),
    p99TanLeanG: pct(absT, 99),
    peakAccelLatG: Math.max(...al.map(Math.abs)),
    leanSignVsKappa: sgn,
    dashOverGround: median(dashOver),
    imuZeroDeg: imuZero,
    fitZeroDeg: fitZ,
    fit2ZeroDeg: b2,
    fit2ExcessDeg: c2,
    fit2Rms: Math.sqrt(e2),
    leftRaw: side(true, 0),
    rightRaw: side(false, 0),
    leftZ: side(true, imuZero),
    rightZ: side(false, imuZero),
    slopeZ: slopeOn(gps, imuZero),
    rmsRaw: rmse(diff(0)),
    rmsZ: rmse(diff(imuZero)),
    windows,
  };
}

export interface FitCompare {
  label: string;
  fit: RiderFit;
  line: Line;
  /** Per corner: fitted lateral cap at the apex, g. */
  aLatG: number[];
  /** Fitted envelope latG vs measured tan(|lean|) along the lap (cornering, |tan φ| > 0.3). */
  /** Envelope |latG| minus the measured lateral g along the lap: vs raw tan|φ|, vs calibrated lean g, vs v²κ/g (GPS). */
  vsTan: Agree;
  vsCal: Agree;
  vsGps: Agree;
  leanRmseDeg: number;
  /** Per corner: the envelope's |latG| peak within ±20 m of the matched apex. */
  envPeakG: number[];
  lineLengthM: number;
}

/**
 * The owner's own GPS path as a sim `Line` (the sim's own curvature pipeline,
 * offset 0). `scaleM`: the curvature scale; default the one the sim chooses for
 * this centreline (`chooseCurvatureScaleM`: 10 m on this clean GPS line).
 */
export function ownLine(trace: DdaLapTrace, scaleM?: number): Line {
  const N = trace.lon.length;
  const centerline: LngLat[] = Array.from({ length: N }, (_, i) => [trace.lon[i], trace.lat[i]] as LngLat);
  const cumDistM = Array.from({ length: N }, (_, i) => i * (trace.lengthM / N));
  const track: TrackModel = {
    id: 'ducati-gps',
    name: 'Ducati GPS line',
    center: centerline[0],
    centerline,
    cumDistM,
    lengthM: trace.lengthM,
    startFinish: { id: 'sf', name: 'SF', type: 'sf', at: centerline[0], bearingDeg: 0, halfWidthM: 15 },
    sectors: [],
    turns: [],
    curvatureScaleM: scaleM ?? chooseCurvatureScaleM(centerline),
  } as unknown as TrackModel;
  return lineFromOffsets(track, new Float32Array(N));
}

/**
 * Fit the rider to the reference on `line` and compare the envelope with the
 * measured lean along the lap (stations where tan|φ − zero| > 0.3).
 */
export interface Agree {
  n: number;
  rmse: number;
  p95: number;
  bias: number;
}
const agree = (d: number[]): Agree => ({ n: d.length, rmse: rmse(d), p95: pct(d.map(Math.abs), 95), bias: d.reduce((a, b) => a + b, 0) / Math.max(1, d.length) });

export function fitAndCompare(label: string, line: Line, ref: Reference, trace: DdaLapTrace, cal: LeanCal, kerbM = 1.0): FitCompare {
  const P = panigaleParams(kerbM);
  const fit = fitRider(line, P, ref);
  const env = fit.envelope;
  const N = trace.lon.length;
  const s = line.cumDistM;
  const dT: number[] = [];
  const dC: number[] = [];
  const dLean: number[] = [];
  const dG: number[] = [];
  for (let i = 0; i < line.points.length; i++) {
    const sT = fit.alignment.toTemplate(s[i]);
    const j = ((Math.round(sT) % N) + N) % N;
    const gCal = leanG(trace.leanDeg[j], cal);
    if (gCal < 0.3) continue;
    const a = Math.abs(env.latG[i]);
    dT.push(a - Math.tan(Math.abs(trace.leanDeg[j]) / R2D));
    dC.push(a - gCal);
    dG.push(a - (trace.vMs[j] ** 2 * Math.abs(trace.kappa[j])) / G);
    dLean.push(Math.abs(env.leanDeg[i]) - Math.abs(trace.leanDeg[j] - cal.zeroDeg));
  }
  const envPeakG = fit.corners.map((c) => {
    let m = 0;
    for (let i = 0; i < s.length; i++) {
      let d = Math.abs(s[i] - s[c.iApex]);
      d = Math.min(d, line.lengthM - d);
      if (d <= 20) m = Math.max(m, Math.abs(env.latG[i]));
    }
    return m;
  });
  return {
    label,
    fit,
    line,
    aLatG: fit.corners.map((c) => c.aLatG),
    vsTan: agree(dT),
    vsCal: agree(dC),
    vsGps: agree(dG),
    leanRmseDeg: rmse(dLean),
    envPeakG,
    lineLengthM: line.lengthM,
  };
}

export function fitOnPist(ref: Reference, trace: DdaLapTrace, model: PistModel, kappa: number, kerbM: number, cal: LeanCal): FitCompare {
  const P = panigaleParams(kerbM);
  return fitAndCompare(`race κ ${kappa.toFixed(2)} kerb ${kerbM.toFixed(1)}`, fitLine('race', P, [], model, kappa), ref, trace, cal, kerbM);
}

export interface DucatiLateral {
  gs: GroundSpeedModel;
  kept: number[];
  best: number;
  traces: Map<number, DdaLapTrace>;
  refs: Map<number, Reference>;
  measured: Map<number, MeasuredCorner[]>;
  channels: ChannelStats;
  cal: LeanCal;
}

/** Read a run, build every kept lap's trace + reference, the channel check (best lap) and the per-corner measurements. */
export function analyseRun(runPath: string, model: PistModel): DucatiLateral {
  const run = JSON.parse(readFileSync(runPath, 'utf8')) as DdaJson & { stats: { best_lap_time_s: number } };
  const verdicts = classifyLaps({ records: run.records as never, laps: run.laps as never, bestLapS: run.stats.best_lap_time_s });
  const kept = verdicts.filter((v) => v.kept).map((v) => v.lap);
  const gs = fitGroundSpeed(run, new Set(kept));
  const best = run.laps.find((l) => l.is_best)?.lap_number ?? kept[0];
  const gate = model.track.centerline[0];
  const corners = trackCornersFromPist(model.pkg);
  const traces = new Map<number, DdaLapTrace>();
  const refs = new Map<number, Reference>();
  for (const lap of kept) {
    const tr = ddaLapTrace(run, lap, gate, gs);
    traces.set(lap, tr);
    refs.set(lap, referenceFromDda(tr, corners, `Ducati lap ${lap}`));
  }
  const channels = channelStats(traces.get(best)!, gs);
  const measured = new Map<number, MeasuredCorner[]>();
  const cal: LeanCal = { zeroDeg: channels.fit2ZeroDeg, excessDeg: channels.fit2ExcessDeg };
  for (const lap of kept) measured.set(lap, measureCorners(traces.get(lap)!, refs.get(lap)!, model, cal));
  return { gs, kept, best, traces, refs, measured, channels, cal };
}

export interface ScaleRow {
  scaleM: number;
  /** Per corner: largest dir·v²κ/g in the zone on the GPS line, this scale. */
  zoneMaxG: number[];
  /** Zone max − calibrated lean g: mean / rms / max abs. */
  vsCal: { bias: number; rmse: number; maxAbs: number };
  /** Zone max − measured v²κ (κ over a 20 m heading window): mean / rms. */
  vsGps: { bias: number; rmse: number };
  /** |κ| p95 / p99 on fast straights (v > 180 km/h, |lean| < 5°), 1/m, and n. */
  straightP95: number;
  straightP99: number;
  straightN: number;
  /** Lap p99 |v²κ/g|. */
  p99G: number;
}

/**
 * The sim's curvature pipeline (line.ts `polylineCurvature`: ±L stencil, ±L
 * mean) on the lap's own GPS line at each scale L, against the measured
 * lateral g per corner zone.
 */
export function curvatureScaleSweep(trace: DdaLapTrace, ref: Reference, measured: MeasuredCorner[], scales: number[]): ScaleRow[] {
  const N = trace.lon.length;
  const pts: LngLat[] = Array.from({ length: N }, (_, i) => [trace.lon[i], trace.lat[i]] as LngLat);
  const at = (s: number): number => ((Math.round(s) % N) + N) % N;
  return scales.map((L) => {
    const kap = polylineCurvature(pts, L);
    const zoneMaxG = ref.corners.map((c) => {
      const [z0, z1] = c.zoneM;
      const len = (((z1 - z0) % N) + N) % N;
      let g = 0;
      for (let d = 0; d <= len; d++) {
        const i = at(z0 + d);
        g = Math.max(g, (trace.vMs[i] ** 2 * c.dir * kap[i]) / G);
      }
      return g;
    });
    const dc = zoneMaxG.map((g, k) => g - measured[k].gLeanCal);
    const dg = zoneMaxG.map((g, k) => g - measured[k].gGpsMax);
    const st: number[] = [];
    const all: number[] = [];
    for (let i = 0; i < N; i++) {
      all.push((trace.vMs[i] ** 2 * Math.abs(kap[i])) / G);
      if (trace.vMs[i] * 3.6 > 180 && Math.abs(trace.leanDeg[i]) < 5) st.push(Math.abs(kap[i]));
    }
    const mean = (a: number[]): number => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
    return {
      scaleM: L,
      zoneMaxG,
      vsCal: { bias: mean(dc), rmse: rmse(dc), maxAbs: Math.max(...dc.map(Math.abs)) },
      vsGps: { bias: mean(dg), rmse: rmse(dg) },
      straightP95: pct(st, 95),
      straightP99: pct(st, 99),
      straightN: st.length,
      p99G: pct(all, 99),
    };
  });
}

export { CURV_SCALE_M };
