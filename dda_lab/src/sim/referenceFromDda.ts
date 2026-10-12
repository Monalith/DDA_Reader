// A `Reference` (reference.ts) from a lap of the Ducati DDA JSON export, so
// the reference-fit rider (fitRider.ts) can be fitted to the owner's OWN lap,
// and the lap's measured lateral g read side by side with the fit's.
//
// What the export carries (dda_lab/scripts/lib/ddaLap.ts header,
// docs/superpowers/notes/2026-10-11-ducati-identification.md):
//   - `speed_kmh` is the dash (rear-wheel) speed: it reads ~7 % high upright,
//     and more at lean, because the contact patch rolls on a smaller radius on
//     the tyre's shoulder (≈ +10 % at 45°);
//   - `lean_angle_deg` is the IMU (PSI) roll, measured, time-true;
//   - `accel_lat_g` is NOT an accelerometer: dda_core writes tan(lean) there
//     (checked: |accel_lat_g − tan(lean)| ≤ 0.007 on all 10188 records);
//   - `gps_lat/lon` are smoothed fixes; the GPS lags the CAN channels by
//     ~0.16 s and one fix in five is a repeat, so per-sample GPS speed is
//     noise and GPS speed is taken as distance over a 1.1 s window.
//
// Ground speed used here: v = wheel / (a + b·(1 − cos φ)), with a and b
// fitted on the whole run against the windowed, lag-corrected GPS speed on
// samples with |a_long| < 0.1 g (no drive or brake slip), then rescaled per
// lap so that it integrates to the lap's GPS length. The bike's position at
// time t is the GPS position at t + lag.
//
// Geometry: the lap's GPS path on a 1 m grid, ROTATED so that metre 0 is the
// track model's start/finish gate (the fit's alignment pins the reference's
// metre 0 to the line's start). Curvature: heading from 10 m chords,
// differenced over `kappaWindowM` (20 m): κ(s) = [θ(s+10) − θ(s−10)]/20,
// positive = left.
//
// Corners: the track model's corners (by position), each re-located on the
// lap's own path: the lap's |κ| peak of the corner's direction within
// ±`apexSearchM` of the track model's apex projected onto the path.
//
// Pure: no DOM, no node APIs.
import { haversineM, toLocalM } from '../core/geo';
import type { LngLat } from '../core/types';
import type { RefCorner, Reference } from './reference';

const G = 9.81;
const D2R = Math.PI / 180;

export interface DdaJsonRecord {
  time_s: number;
  speed_kmh: number;
  lean_angle_deg: number;
  tps_pct?: number;
  gps_lat: number | null;
  gps_lon: number | null;
  lap: number;
  accel_lat_g?: number;
}

export interface DdaJsonLap {
  lap_number: number;
  duration_s: number;
  start_index: number;
  end_index: number;
  distance_m: number;
  is_best: boolean;
}

export interface DdaJson {
  records: DdaJsonRecord[];
  laps: DdaJsonLap[];
  stats?: { best_lap_time_s?: number; best_lap_number?: number };
}

/** A track-model corner as the adapter needs it (PistCorner is a superset). */
export interface TrackCorner {
  name: string;
  dir: 'L' | 'R';
  /** Apex position. */
  apex: LngLat;
  /** Zone ends, as positions on the track (the centreline at entryS / exitS). */
  entry: LngLat;
  exit: LngLat;
}

export interface GroundSpeedModel {
  /** GPS lag behind the CAN channels, s. */
  lagS: number;
  /** wheel/ground = a + b·(1 − cos φ). */
  a: number;
  b: number;
  /** Samples used, and the residual rms of the ratio. */
  n: number;
  rms: number;
}

/** One lap on a 1 m grid from the start/finish gate. */
export interface DdaLapTrace {
  lap: number;
  lapTimeS: number;
  /** GPS path length of the lap, metres. */
  lengthM: number;
  /** Per metre (index = s), the gate at 0. */
  lon: Float64Array;
  lat: Float64Array;
  tS: Float64Array;
  vMs: Float32Array;
  leanDeg: Float32Array;
  /** Signed curvature, 1/m, + left, averaged over `kappaWindowM`. */
  kappa: Float32Array;
  /** Rescale that made ∫v dt equal the GPS length (≈ 1 when the speed model is right). */
  speedScale: number;
  /** Raw per-record samples of the lap: time from the gate, bike position s, measured lean, ground speed. */
  rec: { tS: Float64Array; sM: Float64Array; leanDeg: Float32Array; vMs: Float32Array; accelLatG: Float32Array };
}

export interface DdaRefOptions {
  /** Curvature averaging window, metres. Default 20. */
  kappaWindowM?: number;
  /** Search half-window for the lap's own apex, metres. Default 40. */
  apexSearchM?: number;
  /** Speed drop that marks a braked corner, km/h. Default 10. */
  brakeDropKmh?: number;
}

const finite = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x);

/** Linear interpolation of y at fractional index x (clamped to the ends). */
function atFrac(y: ArrayLike<number>, x: number): number {
  if (x <= 0) return y[0];
  if (x >= y.length - 1) return y[y.length - 1];
  const i = Math.floor(x);
  const f = x - i;
  return y[i] + (y[i + 1] - y[i]) * f;
}

/** Cumulative GPS distance over the records (a missing fix adds nothing), metres. */
export function ddaGpsCumM(records: DdaJsonRecord[]): Float64Array {
  const out = new Float64Array(records.length);
  let prev: LngLat | null = null;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    out[i] = i > 0 ? out[i - 1] : 0;
    if (!finite(r.gps_lat) || !finite(r.gps_lon)) continue;
    const p: LngLat = [r.gps_lon, r.gps_lat];
    if (prev) out[i] += haversineM(prev, p);
    prev = p;
  }
  return out;
}

/**
 * Fit the ground-speed model on the run: GPS lag by grid search on upright
 * samples (as slipCorrection.estimateGpsLag), then wheel/GPS = a + b·(1−cos φ)
 * by least squares on samples without longitudinal acceleration.
 */
export function fitGroundSpeed(run: DdaJson, laps?: Set<number>): GroundSpeedModel {
  const rec = run.records;
  const n = rec.length;
  const H = 5;
  const tS = rec.map((r) => r.time_s);
  const dt = (tS[n - 1] - tS[0]) / Math.max(1, n - 1);
  const gCum = ddaGpsCumM(rec);
  const wCum = new Float64Array(n);
  for (let i = 1; i < n; i++) wCum[i] = wCum[i - 1] + ((rec[i - 1].speed_kmh + rec[i].speed_kmh) / 2 / 3.6) * (tS[i] - tS[i - 1]);
  const useLap = (i: number): boolean => (laps ? laps.has(rec[i].lap) : true);
  const upright = (i: number): boolean => {
    if (!useLap(i)) return false;
    for (let k = i - H; k <= i + H; k++) if (Math.abs(rec[k].lean_angle_deg) >= 10) return false;
    return true;
  };
  let lagS = 0.16;
  let bestRms = Infinity;
  for (let lag = -0.2; lag <= 0.6 + 1e-9; lag += 0.01) {
    const sh = lag / dt;
    let num = 0;
    let den = 0;
    const pr: Array<[number, number]> = [];
    for (let i = H + 1; i < n - H - 1; i++) {
      if (!upright(i)) continue;
      const span = tS[i + H] - tS[i - H];
      const vW = (wCum[i + H] - wCum[i - H]) / span;
      const vG = (atFrac(gCum, i + H + sh) - atFrac(gCum, i - H + sh)) / span;
      if (!(vG > 40 / 3.6)) continue;
      pr.push([vW, vG]);
      num += vW * vG;
      den += vG * vG;
    }
    if (pr.length < 10) continue;
    const k = num / den;
    let ss = 0;
    for (const [w, g] of pr) ss += (w - k * g) ** 2;
    const rms = Math.sqrt(ss / pr.length);
    if (rms < bestRms) {
      bestRms = rms;
      lagS = Math.round(lag * 100) / 100;
    }
  }
  const sh = lagS / dt;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  const pts: Array<[number, number]> = [];
  for (let i = H + 1; i < n - H - 1; i++) {
    if (!useLap(i)) continue;
    const span = tS[i + H] - tS[i - H];
    const vW = (wCum[i + H] - wCum[i - H]) / span;
    const vG = (atFrac(gCum, i + H + sh) - atFrac(gCum, i - H + sh)) / span;
    if (!(vG > 15)) continue;
    const aL = (rec[i + 3].speed_kmh - rec[i - 3].speed_kmh) / 3.6 / (tS[i + 3] - tS[i - 3]) / G;
    if (Math.abs(aL) > 0.1) continue;
    // mean (1 − cos φ) over the window, the lean the windowed ratio saw
    let x = 0;
    for (let k = i - H; k <= i + H; k++) x += 1 - Math.cos(rec[k].lean_angle_deg * D2R);
    x /= 2 * H + 1;
    const y = vW / vG;
    pts.push([x, y]);
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
  }
  const m = pts.length;
  const b = (m * sxy - sx * sy) / Math.max(1e-12, m * sxx - sx * sx);
  const a = (sy - b * sx) / Math.max(1, m);
  let ss = 0;
  for (const [x, y] of pts) ss += (y - a - b * x) ** 2;
  return { lagS, a, b, n: m, rms: Math.sqrt(ss / Math.max(1, m)) };
}

/** Ground speed of one record from the model, m/s. */
export function groundSpeedMs(model: GroundSpeedModel, wheelKmh: number, leanDeg: number): number {
  return wheelKmh / 3.6 / (model.a + model.b * (1 - Math.cos(leanDeg * D2R)));
}

/** Nearest point of a 1 m path to p: index (fractional) and distance, metres. */
export function nearestOnPath(lon: ArrayLike<number>, lat: ArrayLike<number>, p: LngLat): { s: number; distM: number } {
  const o: LngLat = [p[0], p[1]];
  let best = 0;
  let bestD = Infinity;
  const n = lon.length;
  for (let i = 0; i < n; i++) {
    const q = toLocalM(o, [lon[i], lat[i]]);
    const d = q[0] * q[0] + q[1] * q[1];
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  // refine on the two neighbouring segments
  let s = best;
  let dist = Math.sqrt(bestD);
  for (const j of [best - 1, best]) {
    const a = (j + n) % n;
    const b = (j + 1 + n) % n;
    const A = toLocalM(o, [lon[a], lat[a]]);
    const B = toLocalM(o, [lon[b], lat[b]]);
    const dx = B[0] - A[0];
    const dy = B[1] - A[1];
    const L2 = dx * dx + dy * dy;
    if (L2 < 1e-9) continue;
    const t = Math.min(1, Math.max(0, -(A[0] * dx + A[1] * dy) / L2));
    const d = Math.hypot(A[0] + t * dx, A[1] + t * dy);
    if (d < dist) {
      dist = d;
      s = j + t;
    }
  }
  return { s: ((s % n) + n) % n, distM: dist };
}

/**
 * One lap of the run on a 1 m grid from `gate` (the track model's
 * start/finish point). The lap is the records `start_index … end_index` of
 * the export's lap; it is rotated cyclically so that the gate is metre 0 and
 * its clock 0 (the samples, their order and the lap time are unchanged).
 */
export function ddaLapTrace(run: DdaJson, lapNumber: number, gate: LngLat, model: GroundSpeedModel, opts: DdaRefOptions = {}): DdaLapTrace {
  const info = run.laps.find((l) => l.lap_number === lapNumber);
  if (!info) throw new Error(`lap ${lapNumber} not in the run`);
  const rec = run.records;
  const n = rec.length;
  const gCum = ddaGpsCumM(rec);
  const dt = (rec[n - 1].time_s - rec[0].time_s) / Math.max(1, n - 1);
  const sh = model.lagS / dt;
  const i0 = info.start_index;
  const i1 = info.end_index;
  const lapTimeS = rec[i1].time_s - rec[i0].time_s;
  // bike position at record i: GPS distance at fractional index i + lag
  const m = i1 - i0 + 1;
  const sB = new Float64Array(m);
  const tR = new Float64Array(m);
  const lean = new Float32Array(m);
  const vW = new Float32Array(m);
  const aLat = new Float32Array(m);
  for (let k = 0; k < m; k++) {
    const i = i0 + k;
    sB[k] = atFrac(gCum, i + sh) - atFrac(gCum, i0 + sh);
    tR[k] = rec[i].time_s - rec[i0].time_s;
    lean[k] = rec[i].lean_angle_deg;
    vW[k] = groundSpeedMs(model, rec[i].speed_kmh, rec[i].lean_angle_deg);
    aLat[k] = finite(rec[i].accel_lat_g) ? (rec[i].accel_lat_g as number) : Number.NaN;
  }
  const L = sB[m - 1];
  // positions along the lap path at fractional record index (lagged), resampled per metre
  const fixLon = new Float64Array(n);
  const fixLat = new Float64Array(n);
  {
    let last: LngLat | null = null;
    for (let i = 0; i < n; i++) {
      const r = rec[i];
      if (finite(r.gps_lon) && finite(r.gps_lat)) last = [r.gps_lon, r.gps_lat];
      if (last) {
        fixLon[i] = last[0];
        fixLat[i] = last[1];
      }
    }
  }
  const N0 = Math.floor(L);
  const lon0 = new Float64Array(N0);
  const lat0 = new Float64Array(N0);
  {
    // invert s(index) on the GPS cumulative distance (monotone)
    let j = i0;
    const base = atFrac(gCum, i0 + sh);
    for (let s = 0; s < N0; s++) {
      const target = base + s;
      while (j < n - 2 && gCum[j + 1] < target) j++;
      const f = gCum[j + 1] > gCum[j] ? Math.min(1, Math.max(0, (target - gCum[j]) / (gCum[j + 1] - gCum[j]))) : 0;
      lon0[s] = fixLon[j] + f * (fixLon[j + 1] - fixLon[j]);
      lat0[s] = fixLat[j] + f * (fixLat[j + 1] - fixLat[j]);
    }
  }
  // rotate so the gate is metre 0
  const g = nearestOnPath(lon0, lat0, gate);
  const sGate = g.s;
  // time at the gate: invert sB
  const tAt = (s: number): number => {
    let lo = 0;
    let hi = m - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (sB[mid] <= s) lo = mid;
      else hi = mid;
    }
    const f = sB[hi] > sB[lo] ? (s - sB[lo]) / (sB[hi] - sB[lo]) : 0;
    return tR[lo] + f * (tR[hi] - tR[lo]);
  };
  const tGate = tAt(sGate);
  const N = N0;
  const lon = new Float64Array(N);
  const lat = new Float64Array(N);
  for (let s = 0; s < N; s++) {
    const x = (s + sGate) % N0;
    const k = Math.floor(x);
    const f = x - k;
    const k1 = (k + 1) % N0;
    lon[s] = lon0[k] + f * (lon0[k1] - lon0[k]);
    lat[s] = lat0[k] + f * (lat0[k1] - lat0[k]);
  }
  // per-record rotated axis
  const order = Array.from({ length: m - 1 }, (_, k) => k); // last record = first (closing)
  const recS = new Float64Array(m - 1);
  const recT = new Float64Array(m - 1);
  for (const k of order) {
    recS[k] = (((sB[k] - sGate) % L) + L) % L;
    recT[k] = (((tR[k] - tGate) % lapTimeS) + lapTimeS) % lapTimeS;
  }
  const idx = order.sort((a, b) => recT[a] - recT[b]);
  const rs = Float64Array.from(idx, (k) => recS[k] * (N / L));
  const rt = Float64Array.from(idx, (k) => recT[k]);
  const rl = Float32Array.from(idx, (k) => lean[k]);
  const rv = Float32Array.from(idx, (k) => vW[k]);
  const ra = Float32Array.from(idx, (k) => aLat[k]);
  // speed rescale: ∫v dt over the lap = GPS length
  let distV = 0;
  for (let k = 1; k < rt.length; k++) distV += ((rv[k] + rv[k - 1]) / 2) * (rt[k] - rt[k - 1]);
  distV += ((rv[0] + rv[rv.length - 1]) / 2) * (lapTimeS - rt[rt.length - 1] + rt[0]);
  const speedScale = L / distV;
  for (let k = 0; k < rv.length; k++) rv[k] *= speedScale;
  // per metre: time, speed, lean by interpolation on the record s axis (monotone in time)
  const tS = new Float64Array(N);
  const vMs = new Float32Array(N);
  const leanDeg = new Float32Array(N);
  {
    let k = 0;
    const M = rs.length;
    for (let s = 0; s < N; s++) {
      while (k < M - 1 && rs[k + 1] <= s) k++;
      if (s < rs[0]) {
        tS[s] = rt[0];
        vMs[s] = rv[0];
        leanDeg[s] = rl[0];
        continue;
      }
      const a = k;
      const b = Math.min(M - 1, k + 1);
      const f = rs[b] > rs[a] ? Math.min(1, (s - rs[a]) / (rs[b] - rs[a])) : 0;
      tS[s] = rt[a] + f * (rt[b] - rt[a]);
      vMs[s] = rv[a] + f * (rv[b] - rv[a]);
      leanDeg[s] = rl[a] + f * (rl[b] - rl[a]);
    }
  }
  const kappa = pathCurvature(lon, lat, opts.kappaWindowM ?? 20);
  return {
    lap: lapNumber,
    lapTimeS,
    lengthM: L,
    lon,
    lat,
    tS,
    vMs,
    leanDeg,
    kappa,
    speedScale,
    rec: { tS: rt, sM: rs, leanDeg: rl, vMs: rv, accelLatG: ra },
  };
}

/**
 * Signed curvature of a closed 1 m path, + left: heading from 10 m chords,
 * differenced over `windowM`.
 */
export function pathCurvature(lon: ArrayLike<number>, lat: ArrayLike<number>, windowM = 20): Float32Array {
  const N = lon.length;
  const o: LngLat = [lon[0], lat[0]];
  const xy = Array.from({ length: N }, (_, i) => toLocalM(o, [lon[i], lat[i]]));
  const C = 5;
  const th = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const a = xy[(i - C + N) % N];
    const b = xy[(i + C) % N];
    th[i] = Math.atan2(b[1] - a[1], b[0] - a[0]);
  }
  const h = Math.max(1, Math.round(windowM / 2));
  const k = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let d = th[(i + h) % N] - th[(i - h + N) % N];
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    k[i] = d / (2 * h);
  }
  return k;
}

const cyc = (a: number, b: number, L: number): number => (((b - a) % L) + L) % L;

/** A `.pist.json` package's corners as positions: the apex, and the centreline at entryS / exitS. */
export function trackCornersFromPist(pkg: {
  centerline: LngLat[];
  cumDistM: number[];
  corners: Array<{ name: string; dir: 'L' | 'R'; apex: LngLat; entryS: number; exitS: number }>;
}): TrackCorner[] {
  const atS = (s: number): LngLat => {
    let best = 0;
    for (let i = 0; i < pkg.cumDistM.length; i++) if (Math.abs(pkg.cumDistM[i] - s) < Math.abs(pkg.cumDistM[best] - s)) best = i;
    return pkg.centerline[best];
  };
  return pkg.corners.map((c) => ({ name: c.name, dir: c.dir, apex: c.apex, entry: atS(c.entryS), exit: atS(c.exitS) }));
}

/**
 * The lap as a `Reference`: the template axis is the lap's own GPS metres
 * from the gate (so `sIntM` ≈ the axis), the corners are the track model's,
 * re-located on the lap's path.
 */
export function referenceFromDda(trace: DdaLapTrace, corners: TrackCorner[], name: string, opts: DdaRefOptions = {}): Reference {
  const N = trace.lon.length;
  const search = opts.apexSearchM ?? 40;
  const dropKmh = opts.brakeDropKmh ?? 10;
  const speedKmh = Float32Array.from(trace.vMs, (v) => v * 3.6);
  const tS = Float64Array.from(trace.tS);
  // long g from the speed per metre (a = v dv/ds), 7 m central difference
  const longG = new Float32Array(N);
  for (let s = 0; s < N; s++) {
    const a = trace.vMs[(s - 3 + N) % N];
    const b = trace.vMs[(s + 3) % N];
    longG[s] = (b * b - a * a) / (2 * 6 * G);
  }
  const sIntM = new Float64Array(N);
  for (let s = 1; s < N; s++) sIntM[s] = sIntM[s - 1] + ((trace.vMs[s] + trace.vMs[s - 1]) / 2) * Math.max(0, tS[s] - tS[s - 1]);
  const dtClose = Math.max(0, trace.lapTimeS - (tS[N - 1] - tS[0]));
  const lengthIntM = sIntM[N - 1] + ((trace.vMs[N - 1] + trace.vMs[0]) / 2) * dtClose;
  const at = (s: number): number => ((Math.round(s) % N) + N) % N;
  const proj = (p: LngLat): number => nearestOnPath(trace.lon, trace.lat, p).s;

  const refCorners: RefCorner[] = [];
  const raw = corners.map((c) => {
    const dir: 1 | -1 = c.dir === 'L' ? 1 : -1;
    const s0 = proj(c.apex);
    let best = at(s0);
    for (let d = -search; d <= search; d++) {
      const i = at(s0 + d);
      if (dir * trace.kappa[i] > dir * trace.kappa[best]) best = i;
    }
    let e = proj(c.entry);
    let x = proj(c.exit);
    // zone must hold the apex, in lap order
    if (cyc(e, best, N) > N / 2) e = (best - 30 + N) % N;
    if (cyc(best, x, N) > N / 2) x = (best + 30) % N;
    return { c, dir, apex: best, entry: e, exit: x, s0 };
  });
  // two corners on one |κ| peak (a pist apex 40 m off the lap's: K11/K12 at
  // Serres): the one whose own apex lies further from it re-searches its
  // zone, away from the other's apex
  const SEP_M = 15;
  for (let a = 0; a < raw.length; a++) {
    for (let b = 0; b < raw.length; b++) {
      if (a === b) continue;
      const A = raw[a];
      const B = raw[b];
      const dist = Math.min(cyc(A.apex, B.apex, N), cyc(B.apex, A.apex, N));
      if (dist >= SEP_M) continue;
      const offA = Math.min(cyc(A.s0, A.apex, N), cyc(A.apex, A.s0, N));
      const offB = Math.min(cyc(B.s0, B.apex, N), cyc(B.apex, B.s0, N));
      const mv = offA >= offB ? A : B;
      const keep = mv === A ? B : A;
      const len = cyc(mv.entry, mv.exit, N);
      let best = -1;
      for (let d = 0; d <= len; d++) {
        const i = at(mv.entry + d);
        if (Math.min(cyc(i, keep.apex, N), cyc(keep.apex, i, N)) < SEP_M) continue;
        if (best < 0 || mv.dir * trace.kappa[i] > mv.dir * trace.kappa[best]) best = i;
      }
      if (best >= 0) mv.apex = best;
    }
  }
  for (const r of raw) {
    // brake point: the LAST speed peak before the corner's minimum (walk back
    // while the speed rises; stop once it falls 3 km/h below the peak, i.e.
    // on the previous corner's side), if the drop to the minimum is real
    let iMin = r.apex;
    for (let d = -30; d <= 30; d++) if (speedKmh[at(r.apex + d)] < speedKmh[iMin]) iMin = at(r.apex + d);
    let iMax = iMin;
    for (let d = 1; d <= 400; d++) {
      const i = at(iMin - d);
      if (speedKmh[i] > speedKmh[iMax]) iMax = i;
      else if (speedKmh[i] < speedKmh[iMax] - 3) break;
    }
    const braked = speedKmh[iMax] - speedKmh[iMin] >= dropKmh;
    refCorners.push({
      name: r.c.name,
      dir: r.dir,
      zoneM: [r.entry, r.exit],
      zoneTimeS: Number.NaN,
      kmh: { entry: speedKmh[at(r.entry)], apex: speedKmh[iMin], exit: speedKmh[at(r.exit)] },
      apexM: r.apex,
      brakeM: braked ? iMax : null,
      braked,
    });
  }
  refCorners.sort((a, b) => a.apexM - b.apexM);
  // zone times: previous zone end (the gate for the first) → this zone end
  refCorners.forEach((c, k) => {
    const tEnd = tS[at(c.zoneM[1])];
    const tPrev = k === 0 ? 0 : tS[at(refCorners[k - 1].zoneM[1])];
    let d = tEnd - tPrev;
    if (d < 0) d += trace.lapTimeS;
    c.zoneTimeS = d;
  });
  return {
    name,
    lapTimeS: trace.lapTimeS,
    lengthM: N,
    corners: refCorners,
    speedKmh,
    longG,
    tS,
    sIntM,
    lengthIntM,
    lon: Float64Array.from(trace.lon),
    lat: Float64Array.from(trace.lat),
  };
}
