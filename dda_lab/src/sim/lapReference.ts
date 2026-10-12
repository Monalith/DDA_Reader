// A `Reference` (reference.ts) from ANY loaded lap, so "Fit to reference" can
// fit the per-corner rider to a recorded lap, not only to a file with a corner
// summary (`viraj_ozeti`).
//
//   - a session that carries its own corner summary (`session.reference`,
//     the BMW / R6 video laps) keeps it; its lat/lon is hand-placed (±15-20 m)
//     so its path is NOT the line (`pathTrusted: false`);
//   - any other lap with GPS: its path on a 1 m grid, rotated so metre 0 is
//     the track model's first centreline vertex (where the sim line starts),
//     the `speed` channel rescaled so ∫v dt equals the GPS length (a wheel
//     speed reads high at lean), and the track model's turns re-located on the
//     lap's own path (`referenceFromDda`). Its path IS the line the fit rides
//     (`pathTrusted: true`, `ownerOffsets`).
//
// Pure: no DOM, no node APIs.
import { haversineM } from '../core/geo';
import type { Lap, LngLat, Session, TrackModel } from '../core/types';
import type { Reference } from './reference';
import { nearestOnPath, pathCurvature, referenceFromDda, type DdaLapTrace, type TrackCorner } from './referenceFromDda';

export interface LapReference {
  ref: Reference;
  /** The lap's path is the line it rode (measured GPS), not a hand-placed sketch. */
  pathTrusted: boolean;
  /** Label for the UI. */
  label: string;
}

/** A lap shorter than this share of the track is not a full lap. */
const MIN_LAP_FRAC = 0.8;

/** The track model's turns as positions (apex, and the centreline at the zone ends). */
export function trackCornersFromTurns(track: TrackModel): TrackCorner[] {
  const cl = track.centerline;
  const cum = track.cumDistM;
  const atS = (s: number): LngLat => {
    const L = track.lengthM;
    const ss = ((s % L) + L) % L;
    let lo = 0;
    let hi = cl.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= ss) lo = mid;
      else hi = mid;
    }
    return ss - cum[lo] <= cum[hi] - ss ? cl[lo] : cl[hi];
  };
  return track.turns.map((t) => ({ name: t.name || `T${t.n}`, dir: t.dir, apex: t.apexGeo, entry: atS(t.sRange[0]), exit: atS(t.sRange[1]) }));
}

/** Can this lap be a fit reference? (a reason when not) */
export function lapReferenceProblem(session: Session, lap: Lap, track: TrackModel | undefined): string | null {
  if (session.reference) return null;
  if (!track) return 'no track model';
  if (!track.turns.length) return 'the track model has no turns';
  if (!session.channels.has('gps_lon') || !session.channels.has('gps_lat')) return 'the lap has no GPS';
  if (!session.channels.has('speed')) return 'the lap has no speed';
  if (lap.endIdx - lap.startIdx < 50) return 'too few samples';
  return null;
}

/**
 * The reference of one loaded lap. Throws with a readable reason when the lap
 * cannot be one (see `lapReferenceProblem`).
 */
export function referenceFromLap(session: Session, lap: Lap, track: TrackModel): LapReference {
  const label = `${session.name} · lap ${lap.n}`;  if (session.reference) return { ref: session.reference, pathTrusted: false, label };
  const why = lapReferenceProblem(session, lap, track);
  if (why) throw new Error(`${label}: ${why}`);

  const t = session.t;
  const lonC = session.channels.get('gps_lon')!.data;
  const latC = session.channels.get('gps_lat')!.data;
  const spC = session.channels.get('speed')!.data;
  // samples of the lap with a fix (the last fix carried over a gap)
  const ts: number[] = [];
  const lon: number[] = [];
  const lat: number[] = [];
  const kmh: number[] = [];
  for (let i = lap.startIdx; i <= lap.endIdx && i < t.length; i++) {
    if (!Number.isFinite(lonC[i]) || !Number.isFinite(latC[i]) || !Number.isFinite(t[i])) continue;
    ts.push(t[i] - t[lap.startIdx]);
    lon.push(lonC[i]);
    lat.push(latC[i]);
    kmh.push(Number.isFinite(spC[i]) ? spC[i] : (kmh[kmh.length - 1] ?? 0));
  }
  const m = ts.length;
  if (m < 50) throw new Error(`${label}: too few GPS samples`);
  const lapTimeS = lap.timeS > 0 ? lap.timeS : ts[m - 1];
  // cumulative GPS distance (repeated fixes add nothing)
  const cum = new Float64Array(m);
  for (let k = 1; k < m; k++) cum[k] = cum[k - 1] + haversineM([lon[k - 1], lat[k - 1]], [lon[k], lat[k]]);
  const L = cum[m - 1];
  if (L < MIN_LAP_FRAC * track.lengthM) throw new Error(`${label}: GPS path ${L.toFixed(0)} m is not a full lap of ${track.lengthM.toFixed(0)} m`);
  const N0 = Math.floor(L);

  // per metre on the lap's own axis: position, clock
  const lon0 = new Float64Array(N0);
  const lat0 = new Float64Array(N0);
  const t0 = new Float64Array(N0);
  {
    let j = 0;
    for (let s = 0; s < N0; s++) {
      while (j < m - 2 && cum[j + 1] < s) j++;
      const f = cum[j + 1] > cum[j] ? Math.min(1, Math.max(0, (s - cum[j]) / (cum[j + 1] - cum[j]))) : 0;
      lon0[s] = lon[j] + f * (lon[j + 1] - lon[j]);
      lat0[s] = lat[j] + f * (lat[j + 1] - lat[j]);
      t0[s] = ts[j] + f * (ts[j + 1] - ts[j]);
    }
  }
  // speed rescale: ∫v dt over the lap = the GPS length
  let distV = 0;
  for (let k = 1; k < m; k++) distV += ((kmh[k] + kmh[k - 1]) / 2 / 3.6) * (ts[k] - ts[k - 1]);
  const speedScale = distV > 0 ? L / distV : 1;
  const v0 = new Float32Array(N0);
  {
    let j = 0;
    for (let s = 0; s < N0; s++) {
      while (j < m - 2 && cum[j + 1] < s) j++;
      const f = cum[j + 1] > cum[j] ? Math.min(1, Math.max(0, (s - cum[j]) / (cum[j + 1] - cum[j]))) : 0;
      v0[s] = ((kmh[j] + f * (kmh[j + 1] - kmh[j])) / 3.6) * speedScale;
    }
  }

  // rotate so metre 0 is the sim line's start (the first centreline vertex)
  // (a track model built from this session starts where the lap does: the
  // gate can fall in the lap's last metre, whose clock runs on to lapTimeS)
  const sGate = nearestOnPath(lon0, lat0, track.centerline[0]).s % N0;
  const k0 = Math.floor(sGate);
  const tGate = t0[k0] + (sGate - k0) * ((k0 + 1 < N0 ? t0[k0 + 1] : lapTimeS) - t0[k0]);
  const N = N0;
  const lonR = new Float64Array(N);
  const latR = new Float64Array(N);
  const tR = new Float64Array(N);
  const vR = new Float32Array(N);
  for (let s = 0; s < N; s++) {
    const x = (s + sGate) % N0;
    const k = Math.floor(x);
    const f = x - k;
    const k1 = (k + 1) % N0;
    lonR[s] = lon0[k] + f * (lon0[k1] - lon0[k]);
    latR[s] = lat0[k] + f * (lat0[k1] - lat0[k]);
    vR[s] = v0[k] + f * (v0[k1] - v0[k]);
    const tk = t0[k] + f * ((k1 === 0 ? lapTimeS : t0[k1]) - t0[k]);
    tR[s] = (((tk - tGate) % lapTimeS) + lapTimeS) % lapTimeS;
  }
  // the clock must rise along the rotated axis (the lap seam wraps once)
  for (let s = 1; s < N; s++) if (tR[s] < tR[s - 1]) tR[s] = tR[s - 1];

  const trace: DdaLapTrace = {
    lap: lap.n,
    lapTimeS,
    lengthM: L,
    lon: lonR,
    lat: latR,
    tS: tR,
    vMs: vR,
    leanDeg: new Float32Array(N),
    kappa: pathCurvature(lonR, latR, 20),
    speedScale,
    rec: { tS: new Float64Array(0), sM: new Float64Array(0), leanDeg: new Float32Array(0), vMs: new Float32Array(0), accelLatG: new Float32Array(0) },
  };
  const corners = trackCornersFromTurns(track);
  corners.push(...missedCorners(trace, corners));
  const ref = referenceFromDda(trace, corners, label);
  return { ref, pathTrusted: true, label };
}

/** A corner the lap needs at least this lateral g in (v²κ) is a corner. */
const CORNER_MIN_G = 0.5;
/** …and at least this curvature (radius ≤ 300 m). */
const CORNER_MIN_KAPPA = 1 / 300;
/** A |κ| peak within this of a known apex is that corner. */
const SAME_CORNER_M = 60;
/** A known corner zone longer than this on the lap's path is a bad projection: its own peak is not searched. */
const MAX_KNOWN_ZONE_M = 400;

/**
 * Corners the track model does not have, found on the lap's own path: every
 * |κ| peak (largest within ±25 m) where the lap needed ≥ CORNER_MIN_G and no
 * known apex lies within SAME_CORNER_M. A track model detected from a GPS
 * trace can miss corners (10 of Serres' 16), and between known corners the
 * fitted rider is not lateral-limited, so a missed corner was ridden 10-30
 * km/h too fast (−4 s a lap). Its zone: where |κ| stays above 35 % of the
 * peak, 20-120 m each side.
 */
export function missedCorners(trace: DdaLapTrace, known: TrackCorner[]): TrackCorner[] {
  const N = trace.lon.length;
  const k = trace.kappa;
  const at = (s: number): number => ((s % N) + N) % N;
  const dist = (a: number, b: number): number => Math.min(at(b - a), at(a - b));
  const apexes = known.map((c) => nearestOnPath(trace.lon, trace.lat, c.apex).s);
  const pos = (s: number): LngLat => [trace.lon[at(s)], trace.lat[at(s)]];
  const peaks: number[] = [];
  for (let s = 0; s < N; s++) {
    const a = Math.abs(k[s]);
    if (a < CORNER_MIN_KAPPA || (trace.vMs[s] * trace.vMs[s] * a) / 9.80665 < CORNER_MIN_G) continue;
    let top = true;
    for (let d = -25; d <= 25 && top; d++) if (d !== 0 && Math.abs(k[at(s + d)]) > a) top = false;
    if (top) peaks.push(s);
  }
  // each known corner's strongest same-direction |κ| in its own zone is that
  // corner too: a track-model apex can sit > SAME_CORNER_M off the lap's peak
  // (Serres K11: 2017 vs 1954 m), and referenceFromDda re-locates it there
  for (const c of known) {
    const dir = c.dir === 'L' ? 1 : -1;
    const e = Math.round(nearestOnPath(trace.lon, trace.lat, c.entry).s);
    const len = at(Math.round(nearestOnPath(trace.lon, trace.lat, c.exit).s) - e);
    if (len > MAX_KNOWN_ZONE_M) continue;
    let best = at(e);
    for (let d = 1; d <= len; d++) if (dir * k[at(e + d)] > dir * k[best]) best = at(e + d);
    if (dir * k[best] > 0) apexes.push(best);
  }
  const out: TrackCorner[] = [];
  const taken = [...apexes];
  for (const s of peaks) {
    if (taken.some((t) => dist(s, t) < SAME_CORNER_M)) continue;
    taken.push(s);
    const sign = Math.sign(k[s]);
    const floor = 0.35 * Math.abs(k[s]);
    let e = 20;
    while (e < 120 && sign * k[at(s - e)] > floor) e++;
    let x = 20;
    while (x < 120 && sign * k[at(s + x)] > floor) x++;
    out.push({ name: '', dir: sign > 0 ? 'L' : 'R', apex: pos(s), entry: pos(s - e), exit: pos(s + x) });
  }
  // name each after the known corner before it: "T3+" (a second one "T3++")
  const named = known.map((c, i) => ({ s: apexes[i], name: c.name }));
  for (const c of out) {
    const s = nearestOnPath(trace.lon, trace.lat, c.apex).s;
    let prev = named[0];
    for (const q of named) if (prev && at(s - q.s) < at(s - prev.s)) prev = q;
    c.name = `${prev?.name ?? 'C'}+`;
    named.push({ s, name: c.name });
  }
  return out;
}
