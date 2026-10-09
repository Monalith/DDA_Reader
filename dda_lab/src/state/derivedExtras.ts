import { deltaT } from '../core/laps';
import { segmentCrossing } from '../core/geo';
import { projectToTrack } from '../core/track';
import { DEFAULT_PROC, type Channel, type Lap, type LngLat, type Session, type TrackModel } from '../core/types';

/**
 * Track-relative lap distance. Replaces the raw per-lap GPS integration in
 * `lap_dist` with the position along the track centerline, so laps align on
 * the same x even when the rider's line length differs. Uses a windowed
 * nearest-vertex search (consecutive samples are close) with a global fallback.
 */
export function applyTrackLapDist(s: Session, track: TrackModel): void {
  const lon = s.channels.get('gps_lon')?.data;
  const lat = s.channels.get('gps_lat')?.data;
  if (!lon || !lat || !s.laps.length || track.centerline.length < 3) return;

  const origin: LngLat = track.center;
  const kx = 111_320 * Math.cos((origin[1] * Math.PI) / 180);
  const ky = 110_540;
  const n = track.centerline.length;
  const cx = new Float64Array(n);
  const cy = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    cx[i] = (track.centerline[i][0] - origin[0]) * kx;
    cy[i] = (track.centerline[i][1] - origin[1]) * ky;
  }
  const L = track.lengthM;
  const out = new Float32Array(s.t.length).fill(NaN);

  const nearest = (px: number, py: number, hint: number, window: number): number => {
    let best = -1;
    let bestD = Infinity;
    const lo = hint - window;
    const hi = hint + window;
    for (let k = lo; k <= hi; k++) {
      const i = ((k % n) + n) % n;
      const dx = cx[i] - px;
      const dy = cy[i] - py;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return bestD > 30 * 30 && window < n ? nearest(px, py, 0, n) : best;
  };

  // the start/finish gate in centerline metres (0 once the track is normalised)
  const sSf = projectToTrack(track, track.startFinish.at).sM;
  for (const lap of s.laps) {
    let hint = 0;
    let first = true;
    let prevS = 0;
    let unwrapped = 0;
    for (let i = lap.startIdx; i <= lap.endIdx && i < s.t.length; i++) {
      if (!Number.isFinite(lon[i]) || !Number.isFinite(lat[i])) continue;
      const px = (lon[i] - origin[0]) * kx;
      const py = (lat[i] - origin[1]) * ky;
      const vi = nearest(px, py, hint, first ? n : 60);
      if (vi < 0) continue;
      hint = vi;
      const sM = track.cumDistM[vi];
      if (first) {
        // every lap starts from the same origin: the start/finish gate, not its own first
        // GPS fix (which can be seconds late). Signed offset in (−L/2, L/2].
        let d0 = sM - sSf;
        if (d0 > L / 2) d0 -= L;
        else if (d0 <= -L / 2) d0 += L;
        unwrapped = lap.kind === 'out' ? 0 : d0;
        prevS = sM;
        first = false;
      }
      let ds = sM - prevS;
      if (ds < -L / 2) ds += L;
      else if (ds > L / 2) ds -= L;
      unwrapped += ds;
      prevS = sM;
      out[i] = Math.max(0, unwrapped);
    }
  }
  // keep original where track projection failed
  const old = s.channels.get('lap_dist');
  if (old) {
    for (let i = 0; i < out.length; i++) if (!Number.isFinite(out[i]) && Number.isFinite(old.data[i])) out[i] = old.data[i];
    old.data = out;
  } else {
    s.channels.set('lap_dist', { name: 'lap_dist', unit: 'm', kind: 'derived', data: out, proc: { ...DEFAULT_PROC } });
  }
}

/**
 * total_dist channel: distance covered over the laps that still exist, in lap order and
 * continuous from one lap to the next (NaN outside laps). Deleting a lap removes its
 * metres from everything after it, so the "total distance" follows the workspace.
 */
export function applyTotalDist(s: Session): void {
  const lapDist = s.channels.get('lap_dist')?.data;
  const out = new Float32Array(s.t.length).fill(NaN);
  if (lapDist && s.laps.length) {
    const laps = [...s.laps].sort((a, b) => a.startIdx - b.startIdx);
    let offset = 0;
    for (const lap of laps) {
      let last = 0;
      for (let i = lap.startIdx; i <= lap.endIdx && i < out.length; i++) {
        const d = lapDist[i];
        if (!Number.isFinite(d)) continue;
        if (d >= last) last = d; // the sample shared with the next lap restarts at 0
        out[i] = offset + last;
      }
      offset += last;
    }
  }
  const ch: Channel = { name: 'total_dist', unit: 'm', kind: 'derived', data: out, proc: { ...DEFAULT_PROC } };
  s.channels.set('total_dist', ch);
}

/** Channels compared against the reference lap as `d_<name>` (value − reference at the same lap distance). */
export const REF_DELTA_CHANNELS = ['speed', 'gps_speed', 'rpm', 'tps', 'lean', 'long_g', 'lat_g', 'gear'] as const;

/**
 * d_<channel> channels: how far each lap is from the reference lap at the same lap
 * distance (positive = more than the reference). NaN without a reference, outside laps
 * or where either lap lacks the channel. Feeds the "stock chart" templates.
 */
export function applyRefDeltas(s: Session, ref: Session | undefined, refLap: Lap | undefined): void {
  const n = s.t.length;
  for (const name of REF_DELTA_CHANNELS) {
    const mine = s.channels.get(name);
    const theirs = ref?.channels.get(name);
    const out = new Float32Array(n).fill(NaN);
    if (mine && theirs && ref && refLap) {
      const aligned = alignedChannel(s, ref, refLap, name, 'lap_dist');
      for (const lap of s.laps) {
        const isRef = ref.id === s.id && lap.n === refLap.n;
        for (let i = lap.startIdx; i <= lap.endIdx && i < n; i++) {
          const v = mine.data[i];
          if (!Number.isFinite(v)) continue;
          if (isRef) out[i] = 0;
          else if (Number.isFinite(aligned[i])) out[i] = v - aligned[i];
        }
      }
    }
    const unit = mine?.unit ?? '';
    const existing = s.channels.get(`d_${name}`);
    if (existing) {
      existing.data = out;
      existing.unit = unit;
    } else {
      s.channels.set(`d_${name}`, { name: `d_${name}`, unit, kind: 'derived', data: out, proc: { ...DEFAULT_PROC } });
    }
  }
  // delta_d: metres ahead (+) or behind (−) the reference lap at the same lap time
  const dd = new Float32Array(n).fill(NaN);
  const myDist = s.channels.get('lap_dist')?.data;
  if (ref && refLap && myDist) {
    const refDistAtTime = alignedChannel(s, ref, refLap, 'lap_dist', 'lap_time');
    for (const lap of s.laps) {
      const isRef = ref.id === s.id && lap.n === refLap.n;
      for (let i = lap.startIdx; i <= lap.endIdx && i < n; i++) {
        if (!Number.isFinite(myDist[i])) continue;
        if (isRef) dd[i] = 0;
        else if (Number.isFinite(refDistAtTime[i])) dd[i] = myDist[i] - refDistAtTime[i];
      }
    }
  }
  const ex = s.channels.get('delta_d');
  if (ex) ex.data = dd;
  else s.channels.set('delta_d', { name: 'delta_d', unit: 'm', kind: 'derived', data: dd, proc: { ...DEFAULT_PROC }, color: '#4dd0e1' });
}

/**
 * Channel `name` of `target`'s lap `targetLap`, re-sampled onto every lap of `s` by the
 * common coordinate `by` (`lap_dist`: same place on track, `lap_time`: same time into the
 * lap). NaN outside laps or beyond the target lap. This is how one run is read against
 * another: d_* channels, delta_d and the math functions ref()/run().
 */
export function alignedChannel(s: Session, target: Session, targetLap: Lap, name: string, by: 'lap_dist' | 'lap_time' = 'lap_dist'): Float32Array {
  const n = s.t.length;
  const out = new Float32Array(n).fill(NaN);
  const myX = s.channels.get(by)?.data;
  const tX = target.channels.get(by)?.data;
  const tY = target.channels.get(name)?.data;
  if (!myX || !tX || !tY) return out;
  const xs: number[] = [];
  const ys: number[] = [];
  let last = -Infinity;
  for (let i = targetLap.startIdx; i <= targetLap.endIdx && i < tX.length; i++) {
    const x = tX[i];
    const y = tY[i];
    if (!Number.isFinite(x) || !Number.isFinite(y) || x <= last) continue;
    xs.push(x);
    ys.push(y);
    last = x;
  }
  if (xs.length < 2) return out;
  const at = (x: number): number => {
    if (x < xs[0] || x > xs[xs.length - 1]) return NaN;
    let lo = 0;
    let hi = xs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 0) return ys[0];
    const t = (x - xs[lo - 1]) / (xs[lo] - xs[lo - 1]);
    return ys[lo - 1] + (ys[lo] - ys[lo - 1]) * t;
  };
  for (const lap of s.laps) {
    for (let i = lap.startIdx; i <= lap.endIdx && i < n; i++) {
      const x = myX[i];
      if (Number.isFinite(x)) out[i] = at(x);
    }
  }
  return out;
}

/** delta_t channel: time variance of every lap against the reference lap (NaN outside laps). */
export function applyDeltaT(s: Session, ref: Session | undefined, refLap: Lap | undefined): void {
  const data = new Float32Array(s.t.length).fill(NaN);
  if (ref && refLap) {
    for (const lap of s.laps) {
      const d = deltaT(s, lap, ref, refLap);
      for (let i = lap.startIdx; i <= lap.endIdx && i < d.length; i++) if (Number.isFinite(d[i])) data[i] = d[i];
    }
  }
  const ch: Channel = { name: 'delta_t', unit: 's', kind: 'derived', data, proc: { ...DEFAULT_PROC }, color: '#ffd166' };
  s.channels.set('delta_t', ch);
}

/**
 * Sector times from the track's split gates for laps that came from the DDA
 * lap beacon (which has no sector info). Fills `lap.sectorsS` in place.
 */
export function applySectorTimes(s: Session, track: TrackModel): void {
  if (!track.sectors.length) return;
  const lon = s.channels.get('gps_lon')?.data;
  const lat = s.channels.get('gps_lat')?.data;
  if (!lon || !lat) return;
  for (const lap of s.laps) {
    if (lap.kind !== 'flying') continue;
    const marks: number[] = [];
    let gateIdx = 0;
    for (let i = lap.startIdx + 1; i <= lap.endIdx && gateIdx < track.sectors.length; i++) {
      if (![lon[i - 1], lat[i - 1], lon[i], lat[i]].every(Number.isFinite)) continue;
      const f = segmentCrossing([lon[i - 1], lat[i - 1]], [lon[i], lat[i]], track.sectors[gateIdx]);
      if (f !== null) {
        marks.push(s.t[i - 1] + f * (s.t[i] - s.t[i - 1]));
        gateIdx++;
      }
    }
    if (marks.length !== track.sectors.length) {
      lap.sectorsS = [];
      continue;
    }
    const bounds = [s.t[lap.startIdx], ...marks, s.t[lap.startIdx] + lap.timeS];
    lap.sectorsS = bounds.slice(1).map((b, k) => b - bounds[k]);
  }
}
