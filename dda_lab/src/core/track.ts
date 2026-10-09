// Track model: centerline from GPS laps, signed curvature, turn detection,
// sector gates, point→track projection and per-lap turn metrics.
//
// NOTE: the small geo helpers below are private on purpose — `src/core/geo.ts`
// is written in parallel (Task 2) and this module must stay independent of it.
import { turnTimesForLap } from './turnTimes';
import type { Gate, Lap, LngLat, Session, TrackModel, Turn, TurnMetrics } from './types';

const R_EARTH = 6371008.8; // IUGG mean radius, metres
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** Great-circle distance in metres. */
function haversine(a: LngLat, b: LngLat): number {
  const dLat = (b[1] - a[1]) * D2R;
  const dLng = (b[0] - a[0]) * D2R;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * D2R) * Math.cos(b[1] * D2R) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Equirectangular projection around a reference point: local metres with
 * x east, y north. Accurate to well under 0.1 % over a few km, which is all a
 * circuit needs.
 */
function projector(origin: LngLat) {
  const kx = R_EARTH * D2R * Math.cos(origin[1] * D2R);
  const ky = R_EARTH * D2R;
  return {
    to(p: LngLat): [number, number] {
      return [(p[0] - origin[0]) * kx, (p[1] - origin[1]) * ky];
    },
    from(xy: [number, number]): LngLat {
      return [origin[0] + xy[0] / kx, origin[1] + xy[1] / ky];
    },
  };
}

/** Centred moving average of width `n` (shrinking window at the edges). */
function movingAverage(v: Float32Array, n: number): Float32Array {
  const out = new Float32Array(v.length);
  const h = Math.max(0, Math.floor(n / 2));
  for (let i = 0; i < v.length; i++) {
    let sum = 0;
    let cnt = 0;
    for (let j = i - h; j <= i + h; j++) {
      if (j < 0 || j >= v.length || !Number.isFinite(v[j])) continue;
      sum += v[j];
      cnt++;
    }
    out[i] = cnt ? sum / cnt : NaN;
  }
  return out;
}

/** Cumulative chord length of a local-metre polyline. */
function cumLocal(pts: [number, number][]): Float64Array {
  const cum = new Float64Array(pts.length);
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0];
    const dy = pts[i][1] - pts[i - 1][1];
    cum[i] = cum[i - 1] + Math.hypot(dx, dy);
  }
  return cum;
}

/** Position at arc length `s` along a polyline with cumulative lengths `cum`. */
function interpAt(pts: [number, number][], cum: Float64Array, s: number): [number, number] {
  const last = pts.length - 1;
  if (s <= 0) return pts[0];
  if (s >= cum[last]) return pts[last];
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  const seg = cum[hi] - cum[lo];
  const f = seg > 0 ? (s - cum[lo]) / seg : 0;
  return [
    pts[lo][0] + f * (pts[hi][0] - pts[lo][0]),
    pts[lo][1] + f * (pts[hi][1] - pts[lo][1]),
  ];
}

/**
 * Average several GPS laps into one centerline.
 *
 * Each lap is resampled at `stepM` along *its own* arc length, laps are
 * aligned by arc-length fraction (0..1) and the positions averaged in local
 * metres. NaN samples are skipped.
 */
export function buildCenterline(
  laps: { lng: Float32Array; lat: Float32Array }[],
  stepM = 2,
): { centerline: LngLat[]; cumDistM: Float64Array; lengthM: number } {
  const empty = { centerline: [] as LngLat[], cumDistM: new Float64Array(0), lengthM: 0 };
  const polys: LngLat[][] = [];
  for (const lap of laps) {
    const n = Math.min(lap.lng.length, lap.lat.length);
    const pts: LngLat[] = [];
    for (let i = 0; i < n; i++) {
      const lo = lap.lng[i];
      const la = lap.lat[i];
      if (!Number.isFinite(lo) || !Number.isFinite(la)) continue;
      if (lo === 0 && la === 0) continue; // null island = no fix
      pts.push([lo, la]);
    }
    if (pts.length >= 2) polys.push(pts);
  }
  if (!polys.length) return empty;

  const prj = projector(polys[0][0]);
  const locals: { pts: [number, number][]; cum: Float64Array; len: number }[] = [];
  for (const poly of polys) {
    const pts = poly.map((p) => prj.to(p));
    const cum = cumLocal(pts);
    const len = cum[cum.length - 1];
    if (len > 0) locals.push({ pts, cum, len });
  }
  if (!locals.length) return empty;

  const targetLen = locals.reduce((a, l) => a + l.len, 0) / locals.length;
  const count = Math.max(2, Math.round(targetLen / Math.max(0.1, stepM)) + 1);

  const centerline: LngLat[] = [];
  for (let k = 0; k < count; k++) {
    const f = k / (count - 1);
    let sx = 0;
    let sy = 0;
    for (const l of locals) {
      const p = interpAt(l.pts, l.cum, f * l.len);
      sx += p[0];
      sy += p[1];
    }
    centerline.push(prj.from([sx / locals.length, sy / locals.length]));
  }

  const cumDistM = cumLocal(centerline.map((p) => prj.to(p)));
  return { centerline, cumDistM, lengthM: cumDistM[cumDistM.length - 1] };
}

/** Half-stencil length in metres used by {@link curvature}. */
const CURV_STENCIL_M = 10;

/**
 * Signed curvature in 1/m along the centerline; `+` = left (counter-clockwise).
 *
 * Circumscribed circle through three centerline points about `CURV_STENCIL_M`
 * apart (exact for points on a circle, and far less GPS-noise sensitive than
 * immediate neighbours), then a 5-point moving average.
 */
export function curvature(centerline: LngLat[]): Float32Array {
  const n = centerline.length;
  const out = new Float32Array(n);
  if (n < 3) return out;
  const prj = projector(centerline[0]);
  const pts = centerline.map((p) => prj.to(p));
  const cum = cumLocal(pts);
  const ds = cum[n - 1] / (n - 1);
  let k = Math.max(1, Math.round(CURV_STENCIL_M / Math.max(1e-6, ds)));
  k = Math.min(k, Math.floor((n - 1) / 2));
  if (k < 1) return out;

  for (let i = 0; i < n; i++) {
    const c = Math.min(Math.max(i, k), n - 1 - k);
    const p0 = pts[c - k];
    const p1 = pts[c];
    const p2 = pts[c + k];
    const ax = p1[0] - p0[0];
    const ay = p1[1] - p0[1];
    const bx = p2[0] - p1[0];
    const by = p2[1] - p1[1];
    const cross = ax * by - ay * bx;
    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    const lc = Math.hypot(p2[0] - p0[0], p2[1] - p0[1]);
    const denom = la * lb * lc;
    out[i] = denom > 1e-9 ? (2 * cross) / denom : 0;
  }
  return movingAverage(out, 5);
}

/** Half-width of the window the apex radius is averaged over, metres. */
const RADIUS_WINDOW_M = 10;

/**
 * Curvature peaks → turns. A region is a run of samples with
 * `|curvature| > 1/maxRadiusM`; regions closer than `minSepM` are merged. Each
 * region yields one turn, numbered from the start of the centerline.
 */
export function detectTurns(
  centerline: LngLat[],
  curv: Float32Array,
  cumDistM: Float64Array,
  opts: { maxRadiusM?: number; minSepM?: number } = { maxRadiusM: 150, minSepM: 30 },
): Turn[] {
  const maxRadiusM = opts.maxRadiusM ?? 150;
  const minSepM = opts.minSepM ?? 30;
  const thr = 1 / maxRadiusM;
  const n = Math.min(centerline.length, curv.length, cumDistM.length);

  const regions: [number, number][] = [];
  let start = -1;
  for (let i = 0; i < n; i++) {
    const hot = Number.isFinite(curv[i]) && Math.abs(curv[i]) > thr;
    if (hot && start < 0) start = i;
    else if (!hot && start >= 0) {
      regions.push([start, i - 1]);
      start = -1;
    }
  }
  if (start >= 0) regions.push([start, n - 1]);

  const merged: [number, number][] = [];
  for (const r of regions) {
    const prev = merged[merged.length - 1];
    if (prev && cumDistM[r[0]] - cumDistM[prev[1]] < minSepM) prev[1] = r[1];
    else merged.push([r[0], r[1]]);
  }

  return merged.map(([a, b], idx) => {
    // Apex = tightest part of the region. GPS noise (and Float32 degrees)
    // makes a raw argmax jump around, and on a constant-radius corner every
    // sample is equally tight, so |curvature| is smoothed over ~1/8 of the
    // region and the middle of the near-maximum band is taken.
    const span = b - a + 1;
    const w = Math.min(21, Math.max(5, Math.round(span / 8)));
    const absCurv = new Float32Array(span);
    for (let i = 0; i < span; i++) absCurv[i] = Math.abs(curv[a + i]);
    const smooth = movingAverage(absCurv, w);
    let kMax = 0;
    for (let i = 0; i < span; i++) kMax = Math.max(kMax, smooth[i]);
    const band: number[] = [];
    for (let i = 0; i < span; i++) {
      if (smooth[i] >= 0.95 * kMax) band.push(a + i);
    }
    const peak = band.length ? band[band.length >> 1] : a;
    // radius from the mean curvature around the apex: a single sample is far
    // too GPS-noise sensitive (the maximum is biased by construction)
    let sum = 0;
    let cnt = 0;
    for (let i = a; i <= b; i++) {
      if (Math.abs(cumDistM[i] - cumDistM[peak]) <= RADIUS_WINDOW_M) {
        sum += Math.abs(curv[i]);
        cnt++;
      }
    }
    const kApex = cnt ? sum / cnt : kMax;
    const nTurn = idx + 1;
    return {
      n: nTurn,
      name: `T${nTurn}`,
      dir: curv[peak] > 0 ? 'L' : 'R',
      apexGeo: centerline[peak],
      radiusM: kApex > 1e-9 ? 1 / kApex : Infinity,
      sRange: [cumDistM[a], cumDistM[b]],
    } satisfies Turn;
  });
}

/** Heading in degrees (0 = north, clockwise) of the centerline at index `i`. */
function centerlineBearing(centerline: LngLat[], i: number): number {
  const a = centerline[Math.max(0, i - 1)];
  const b = centerline[Math.min(centerline.length - 1, i + 1)];
  const y = Math.sin((b[0] - a[0]) * D2R) * Math.cos(b[1] * D2R);
  const x =
    Math.cos(a[1] * D2R) * Math.sin(b[1] * D2R) -
    Math.sin(a[1] * D2R) * Math.cos(b[1] * D2R) * Math.cos((b[0] - a[0]) * D2R);
  return (Math.atan2(y, x) * R2D + 360) % 360;
}

/** Index of the centerline point nearest to arc length `sM`. */
function indexAtS(cumDistM: Float64Array, sM: number): number {
  let lo = 0;
  let hi = cumDistM.length - 1;
  if (hi < 0) return 0;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cumDistM[mid] <= sM) lo = mid;
    else hi = mid;
  }
  return Math.abs(cumDistM[lo] - sM) <= Math.abs(cumDistM[hi] - sM) ? lo : hi;
}

/**
 * `n - 1` split gates at equal distance fractions after the start/finish gate.
 * `bearingDeg` is the track heading at the gate; the gate line itself is
 * perpendicular to it.
 */
export function defaultSectorGates(
  centerline: LngLat[],
  cumDistM: Float64Array,
  sf: Gate,
  n = 3,
): Gate[] {
  if (centerline.length < 2 || n < 2) return [];
  const lengthM = cumDistM[cumDistM.length - 1];
  if (!(lengthM > 0)) return [];
  const sf0 = nearestOnPolyline(centerline, cumDistM, sf.at).sM;
  const gates: Gate[] = [];
  for (let k = 1; k < n; k++) {
    const s = (sf0 + (k * lengthM) / n) % lengthM;
    const i = indexAtS(cumDistM, s);
    gates.push({
      id: `split${k}`,
      name: `S${k}`,
      type: 'split',
      at: centerline[i],
      bearingDeg: centerlineBearing(centerline, i),
      halfWidthM: sf.halfWidthM > 0 ? sf.halfWidthM : 15,
    });
  }
  return gates;
}

/** Nearest point on a polyline: arc length and perpendicular offset, metres. */
function nearestOnPolyline(
  centerline: LngLat[],
  cumDistM: Float64Array,
  p: LngLat,
): { sM: number; offM: number } {
  if (!centerline.length) return { sM: NaN, offM: NaN };
  if (centerline.length === 1) return { sM: 0, offM: haversine(centerline[0], p) };
  const prj = projector(centerline[0]);
  const q = prj.to(p);
  let bestD2 = Infinity;
  let bestS = 0;
  let a = prj.to(centerline[0]);
  for (let i = 1; i < centerline.length; i++) {
    const b = prj.to(centerline[i]);
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = a[0] + t * dx;
    const py = a[1] + t * dy;
    const d2 = (q[0] - px) ** 2 + (q[1] - py) ** 2;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestS = cumDistM[i - 1] + t * (cumDistM[i] - cumDistM[i - 1]);
    }
    a = b;
  }
  return { sM: bestS, offM: Math.sqrt(bestD2) };
}

/** Nearest centerline point: distance along the track and lateral offset. */
export function projectToTrack(track: TrackModel, p: LngLat): { sM: number; offM: number } {
  return nearestOnPolyline(track.centerline, track.cumDistM, p);
}

/**
 * Distance along the track for every sample of `lap`, indexed from
 * `lap.startIdx`. Uses the `lap_dist` channel when present (cheap and exact
 * for laps that start at the start/finish line), otherwise projects the GPS
 * position onto the centerline.
 *
 * Exported for `reports.ts`; not part of the public track API.
 */
export function trackDistanceForLap(s: Session, lap: Lap, track: TrackModel): Float64Array {
  const a = Math.max(0, lap.startIdx);
  const b = Math.min(s.t.length - 1, lap.endIdx);
  const len = Math.max(0, b - a + 1);
  const out = new Float64Array(len);
  const lapDist = s.channels.get('lap_dist')?.data;
  if (lapDist) {
    let finite = 0;
    for (let i = 0; i < len; i++) {
      out[i] = lapDist[a + i];
      if (Number.isFinite(out[i])) finite++;
    }
    if (finite > len / 2) return out;
  }
  const lng = s.channels.get('gps_lon')?.data;
  const lat = s.channels.get('gps_lat')?.data;
  if (!lng || !lat) return out.fill(NaN);
  for (let i = 0; i < len; i++) {
    const lo = lng[a + i];
    const la = lat[a + i];
    out[i] =
      Number.isFinite(lo) && Number.isFinite(la)
        ? projectToTrack(track, [lo, la]).sM
        : NaN;
  }
  return out;
}

/** Index in `sDist` whose distance is closest to `sM` (NaN-safe). */
function idxNearestDist(sDist: Float64Array, sM: number): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < sDist.length; i++) {
    const d = Math.abs(sDist[i] - sM);
    if (Number.isFinite(d) && d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Entry / apex / exit speed, max lean, brake distance and throttle-on distance
 * for every turn of `track` on `lap`.
 *
 * - entry  = speed at `sRange[0]`, exit = speed at `sRange[1]`
 * - apex   = minimum speed inside the range
 * - brakeDistM = apex distance − distance of the braking onset before the apex
 *   (onset = start of the run of `long_g < -0.3 g` nearest the apex); NaN when
 *   the rider never brakes into the turn
 * - throttleOnDistM = distance from the apex to the first sample after it with
 *   `tps > 20 %`; NaN when the throttle stays shut
 */
export function turnMetrics(s: Session, lap: Lap, track: TrackModel): TurnMetrics[] {
  if (!track.turns.length) return [];
  const times = turnTimesForLap(s, lap, track);
  const a = Math.max(0, lap.startIdx);
  const sDist = trackDistanceForLap(s, lap, track);
  const len = sDist.length;
  if (!len) return [];
  const speed = s.channels.get('speed')?.data;
  const lean = s.channels.get('lean')?.data;
  const longG = s.channels.get('long_g')?.data;
  const tps = s.channels.get('tps')?.data;
  const at = (ch: Float32Array | undefined, i: number) => (ch ? ch[a + i] : NaN);

  const out: TurnMetrics[] = [];
  for (const turn of track.turns) {
    const [s0, s1] = turn.sRange;
    const inRange: number[] = [];
    for (let i = 0; i < len; i++) {
      if (sDist[i] >= s0 && sDist[i] <= s1) inRange.push(i);
    }
    const iEntry = inRange.length ? inRange[0] : idxNearestDist(sDist, s0);
    const iExit = inRange.length ? inRange[inRange.length - 1] : idxNearestDist(sDist, s1);
    const scan = inRange.length ? inRange : iEntry >= 0 ? [iEntry] : [];

    let iApex = -1;
    let vApex = Infinity;
    let maxLean = NaN;
    for (const i of scan) {
      const v = at(speed, i);
      if (Number.isFinite(v) && v < vApex) {
        vApex = v;
        iApex = i;
      }
      const l = Math.abs(at(lean, i));
      if (Number.isFinite(l) && (!Number.isFinite(maxLean) || l > maxLean)) maxLean = l;
    }
    if (iApex < 0) iApex = iEntry;

    // brake onset: walk back from the apex to the braking run nearest it
    let brakeDistM = NaN;
    if (longG && iApex >= 0) {
      let j = iApex;
      while (j >= 0 && !(longG[a + j] < -0.3)) j--;
      if (j >= 0) {
        let o = j;
        while (o - 1 >= 0 && longG[a + o - 1] < -0.3) o--;
        brakeDistM = sDist[iApex] - sDist[o];
      }
    }

    // throttle-on: first sample after the apex over 20 %
    let throttleOnDistM = NaN;
    if (tps && iApex >= 0) {
      for (let i = iApex + 1; i < len; i++) {
        if (tps[a + i] > 20) {
          throttleOnDistM = sDist[i] - sDist[iApex];
          break;
        }
      }
    }

    out.push({
      lap: lap.n,
      turn: turn.n,
      entryKmh: iEntry >= 0 ? at(speed, iEntry) : NaN,
      apexKmh: Number.isFinite(vApex) ? vApex : NaN,
      exitKmh: iExit >= 0 ? at(speed, iExit) : NaN,
      maxLeanDeg: maxLean,
      brakeDistM,
      throttleOnDistM,
      timeS: times[out.length],
    });
  }
  return out;
}

/** Nearest known track within 3 km of the session's GPS centre. */
export function recognizeTrack(tracks: TrackModel[], center: LngLat): TrackModel | undefined {
  let best: TrackModel | undefined;
  let bestD = Infinity;
  for (const t of tracks) {
    const d = haversine(t.center, center);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best && bestD <= 3000 ? best : undefined;
}
