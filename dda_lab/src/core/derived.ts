// Derived channels computed at load (and after any processing change).
import { butterworthLowpass, derivative, movingAverage } from './filters';
import { cumulativeDistanceM, haversineM, toLocalM } from './geo';
import { DEFAULT_PROC } from './types';
import type { Channel, LngLat, Session, TrackModel } from './types';

const G = 9.81;
const MAX_RADIUS_M = 2000;
/** Arc length (m) of the first, coarse curvature window, then its bounds. */
const COARSE_ARC_M = 40;
const MIN_ARC_M = 20;
const MAX_ARC_M = 80;
/** A curvature window must span this much ground, and no smaller radius is real. */
const MIN_SPAN_M = 8;
const MIN_RADIUS_M = 4;
/** A position step implying more than this (m/s) is a GPS glitch, not a fix. */
const MAX_PLAUSIBLE_MS = 90;

/** Solve a 3x3 system by Gaussian elimination. */
function solve3(a: number[][], b: number[]): number[] | null {
  const m = [
    [...a[0], b[0]],
    [...a[1], b[1]],
    [...a[2], b[2]],
  ];
  for (let c = 0; c < 3; c++) {
    let piv = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[piv][c])) piv = r;
    if (Math.abs(m[piv][c]) < 1e-12) return null;
    const tmp = m[c];
    m[c] = m[piv];
    m[piv] = tmp;
    const d = m[c][c];
    for (let k = c; k < 4; k++) m[c][k] /= d;
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = m[r][c];
      if (!f) continue;
      for (let k = c; k < 4; k++) m[r][k] -= f * m[c][k];
    }
  }
  return [m[0][3], m[1][3], m[2][3]];
}

/**
 * Signed curvature of the path samples lo..hi, from an algebraic (Kasa) circle
 * fit: x^2 + y^2 = 2 a x + 2 b y + c. Positive = turning left. Null when the
 * window is degenerate (too few points, or a straight line).
 */
function circleCurvature(
  xs: Float64Array,
  ys: Float64Array,
  lo: number,
  hi: number,
): number | null {
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  let sz = 0;
  let sxz = 0;
  let syz = 0;
  let firstIdx = -1;
  let lastIdx = -1;
  for (let i = lo; i <= hi; i++) {
    const x = xs[i];
    const y = ys[i];
    if (Number.isNaN(x) || Number.isNaN(y)) continue;
    const z = x * x + y * y;
    n++;
    sx += x;
    sy += y;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
    sz += z;
    sxz += x * z;
    syz += y * z;
    if (firstIdx < 0) firstIdx = i;
    lastIdx = i;
  }
  if (n < 5 || firstIdx < 0) return null;
  // the window must actually span some ground, otherwise the "circle" is noise
  const span = Math.hypot(xs[lastIdx] - xs[firstIdx], ys[lastIdx] - ys[firstIdx]);
  if (span < MIN_SPAN_M) return null;
  const sol = solve3(
    [
      [2 * sxx, 2 * sxy, sx],
      [2 * sxy, 2 * syy, sy],
      [2 * sx, 2 * sy, n],
    ],
    [sxz, syz, sz],
  );
  if (!sol) return null;
  const [cx, cy, c] = sol;
  const r2 = c + cx * cx + cy * cy;
  if (!(r2 > 0)) return null;
  const r = Math.sqrt(r2);
  if (!(r >= MIN_RADIUS_M) || !Number.isFinite(r)) return null;
  // direction of the turn: cross product of the two half chords
  const midIdx = (firstIdx + lastIdx) >> 1;
  const ax = xs[midIdx] - xs[firstIdx];
  const ay = ys[midIdx] - ys[firstIdx];
  const bx = xs[lastIdx] - xs[midIdx];
  const by = ys[lastIdx] - ys[midIdx];
  const cross = ax * by - ay * bx;
  const sign = cross >= 0 ? 1 : -1;
  return sign / r;
}

function setChannel(s: Session, name: string, unit: string, data: Float32Array): void {
  const existing = s.channels.get(name);
  if (existing) {
    existing.data = data;
    existing.unit = unit;
    existing.kind = 'derived';
    return;
  }
  const ch: Channel = {
    name,
    unit,
    kind: 'derived',
    data,
    proc: { ...DEFAULT_PROC, filter: { ...DEFAULT_PROC.filter } },
  };
  s.channels.set(name, ch);
}

function nanArray(n: number): Float32Array {
  return new Float32Array(n).fill(NaN);
}

function dtOf(t: Float64Array): number {
  return t.length > 1 ? t[1] - t[0] : 0.1;
}

/**
 * Compute every derived channel in place: gps_speed, long_g, lat_g, total_g,
 * curvature, radius, slip, phase and lap_dist (the last needs `s.laps`).
 * Missing inputs yield NaN channels rather than errors.
 */
export function computeDerived(s: Session, track?: TrackModel): void {
  void track; // reserved: track-relative distance is handled by track.ts
  const n = s.t.length;
  const dt = dtOf(s.t);
  const lonRaw = s.channels.get('gps_lon')?.data;
  const latRaw = s.channels.get('gps_lat')?.data;
  const speedKmh = s.channels.get('speed')?.data;
  const tps = s.channels.get('tps')?.data;

  const hasGps = !!lonRaw && !!latRaw;
  // Sanitised fixes: the DDA logger writes 0/0 before the GPS has a fix.
  let lon: Float32Array | undefined;
  let lat: Float32Array | undefined;
  if (hasGps) {
    lon = nanArray(n);
    lat = nanArray(n);
    for (let i = 0; i < n; i++) {
      const x = lonRaw![i];
      const y = latRaw![i];
      if (Number.isNaN(x) || Number.isNaN(y)) continue;
      if (x === 0 && y === 0) continue; // no fix
      if (Math.abs(x) > 180 || Math.abs(y) > 90) continue;
      lon[i] = x;
      lat[i] = y;
    }
    // drop teleports: a step no vehicle could have made since the last fix
    let prev = -1;
    for (let i = 0; i < n; i++) {
      if (Number.isNaN(lon[i])) continue;
      if (prev >= 0) {
        const step = haversineM([lon[prev], lat[prev]], [lon[i], lat[i]]);
        const elapsed = s.t[i] - s.t[prev];
        if (step > MAX_PLAUSIBLE_MS * elapsed + 10) {
          lon[i] = NaN;
          lat[i] = NaN;
          continue;
        }
      }
      prev = i;
    }
  }

  // --- gps_speed: haversine between consecutive fixes / dt, 5-point smoothed
  const gpsSpeed = nanArray(n);
  if (hasGps) {
    const inst = nanArray(n);
    for (let i = 1; i < n; i++) {
      if (
        Number.isNaN(lon![i]) || Number.isNaN(lat![i]) ||
        Number.isNaN(lon![i - 1]) || Number.isNaN(lat![i - 1])
      ) {
        continue;
      }
      const a: LngLat = [lon![i - 1], lat![i - 1]];
      const b: LngLat = [lon![i], lat![i]];
      inst[i] = (haversineM(a, b) / dt) * 3.6; // km/h
    }
    if (n > 1) inst[0] = inst[1];
    const sm = movingAverage(inst, 5);
    for (let i = 0; i < n; i++) gpsSpeed[i] = sm[i];
  }
  setChannel(s, 'gps_speed', 'km/h', gpsSpeed);
  // --- gps_smooth: GPS speed low-passed at 0.4 Hz (zero-phase Butterworth)
  setChannel(s, 'gps_smooth', 'km/h', hasGps ? butterworthLowpass(gpsSpeed, 0.4, 1 / dt) : nanArray(n));

  // --- speed in m/s used by the dynamics (wheel speed preferred)
  const vMs = nanArray(n);
  for (let i = 0; i < n; i++) {
    const kmh = speedKmh && !Number.isNaN(speedKmh[i]) ? speedKmh[i] : gpsSpeed[i];
    vMs[i] = Number.isNaN(kmh) ? NaN : kmh / 3.6;
  }

  // --- long_g: d(speed)/dt in g, low-passed at 1 Hz
  const accel = derivative(vMs, dt);
  const longG = butterworthLowpass(accel, 1, dt > 0 ? 1 / dt : 10);
  for (let i = 0; i < n; i++) longG[i] = longG[i] / G;
  setChannel(s, 'long_g', 'g', longG);

  // --- curvature (+ = left) from a windowed least-squares circle fit on the GPS
  // path. A fit is used instead of the raw heading-change rate because channel
  // data is Float32, which quantises lng/lat to about a metre.
  const curv = nanArray(n);
  if (hasGps) {
    let origin: LngLat | null = null;
    for (let i = 0; i < n; i++) {
      if (!Number.isNaN(lon![i]) && !Number.isNaN(lat![i])) {
        origin = [lon![i], lat![i]];
        break;
      }
    }
    if (origin) {
      const xs = new Float64Array(n).fill(NaN);
      const ys = new Float64Array(n).fill(NaN);
      for (let i = 0; i < n; i++) {
        if (Number.isNaN(lon![i]) || Number.isNaN(lat![i])) continue;
        const [x, y] = toLocalM(origin, [lon![i], lat![i]]);
        xs[i] = x;
        ys[i] = y;
      }
      // Window size is adapted to the speed and to a first, wide-window radius
      // estimate: long baselines beat Float32 noise, short ones keep tight
      // turns from being smoothed away.
      const halfFor = (i: number, targetArcM: number): number => {
        const v = Number.isNaN(vMs[i]) ? 20 : Math.max(2, vMs[i]);
        const perSample = v * dt;
        return Math.max(3, Math.min(60, Math.round(targetArcM / (2 * perSample))));
      };
      for (let i = 0; i < n; i++) {
        const h0 = halfFor(i, COARSE_ARC_M);
        const k0 = circleCurvature(xs, ys, Math.max(0, i - h0), Math.min(n - 1, i + h0));
        if (k0 === null) continue;
        const r0 = Math.min(MAX_RADIUS_M, 1 / Math.abs(k0));
        const arc = Math.max(MIN_ARC_M, Math.min(MAX_ARC_M, r0));
        const h = halfFor(i, arc);
        const k = circleCurvature(xs, ys, Math.max(0, i - h), Math.min(n - 1, i + h));
        curv[i] = k === null ? k0 : k;
      }
      const sm = movingAverage(Float32Array.from(curv), 5);
      for (let i = 0; i < n; i++) curv[i] = sm[i];
    }
  }
  setChannel(s, 'curvature', '1/m', curv);

  const radius = nanArray(n);
  const latG = nanArray(n);
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(curv[i])) continue;
    const k = Math.abs(curv[i]);
    radius[i] = k > 1 / MAX_RADIUS_M ? 1 / k : MAX_RADIUS_M;
    if (!Number.isNaN(vMs[i])) latG[i] = (vMs[i] * vMs[i] * curv[i]) / G;
  }
  setChannel(s, 'radius', 'm', radius);
  setChannel(s, 'lat_g', 'g', latG);

  const totalG = nanArray(n);
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(longG[i]) || Number.isNaN(latG[i])) continue;
    totalG[i] = Math.hypot(longG[i], latG[i]);
  }
  setChannel(s, 'total_g', 'g', totalG);

  // --- slip: wheel vs GPS speed, only where the GPS speed is meaningful
  const slip = nanArray(n);
  if (speedKmh) {
    for (let i = 0; i < n; i++) {
      const g = gpsSpeed[i];
      if (Number.isNaN(g) || g <= 30 || Number.isNaN(speedKmh[i])) continue;
      slip[i] = ((speedKmh[i] - g) / g) * 100;
    }
  }
  setChannel(s, 'slip', '%', slip);

  // --- phase: 0 coast, 1 brake, 2 throttle
  const phase = nanArray(n);
  for (let i = 0; i < n; i++) {
    const lg = longG[i];
    const th = tps ? tps[i] : NaN;
    if (Number.isNaN(lg) && Number.isNaN(th)) continue;
    if (!Number.isNaN(lg) && lg < -0.15) phase[i] = 1;
    else if (!Number.isNaN(th) && th > 5) phase[i] = 2;
    else phase[i] = 0;
  }
  setChannel(s, 'phase', '', phase);

  // --- lap_dist: distance since the lap start (NaN when there are no laps)
  const lapDist = nanArray(n);
  if (s.laps.length) {
    const base = hasGps
      ? cumulativeDistanceM(lon!, lat!)
      : (() => {
          const c = nanArray(n);
          let acc = 0;
          for (let i = 0; i < n; i++) {
            if (Number.isNaN(vMs[i])) continue;
            if (i > 0) acc += vMs[i] * dt;
            c[i] = acc;
          }
          return c;
        })();
    for (const lap of s.laps) {
      const d0 = base[lap.startIdx];
      if (Number.isNaN(d0)) continue;
      for (let i = lap.startIdx; i <= lap.endIdx && i < n; i++) {
        if (!Number.isNaN(base[i])) lapDist[i] = base[i] - d0;
      }
    }
  }
  setChannel(s, 'lap_dist', 'm', lapDist);
}
