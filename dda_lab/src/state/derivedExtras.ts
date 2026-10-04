import { deltaT } from '../core/laps';
import { segmentCrossing } from '../core/geo';
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

  for (const lap of s.laps) {
    let hint = 0;
    let first = true;
    let s0 = 0;
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
        s0 = sM;
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
    void s0;
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
