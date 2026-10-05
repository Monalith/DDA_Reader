// Lap detection: from GPS gate crossings or from the DDA lap-marker channel.
import { segmentCrossing } from './geo';
import type { Gate, Lap, LngLat, Session } from './types';

/** Crossing: sample index after the crossing plus the interpolated crossing time. */
interface Crossing {
  idx: number;
  tS: number;
}

/** A real lap can never be shorter than this; closer crossings are GPS/beacon jitter at the line. */
export const MIN_LAP_S = 20;

/** Drop crossings that follow the previous kept one by less than MIN_LAP_S. */
export function dedupeCrossings<T extends { tS: number }>(crossings: T[]): T[] {
  const out: T[] = [];
  for (const c of crossings) {
    if (!out.length || c.tS - out[out.length - 1].tS >= MIN_LAP_S) out.push(c);
  }
  return out;
}

/**
 * Flying laps whose time is within 0.6..1.6 × the median flying-lap time.
 * Filters cut laps / beacon glitches and pit or merged-run gaps.
 */
export function plausibleFlyingLaps(laps: Lap[]): Lap[] {
  const flying = laps.filter((l) => l.kind === 'flying');
  if (flying.length < 3) return flying;
  const times = flying.map((l) => l.timeS).sort((a, b) => a - b);
  const median = times[times.length >> 1];
  return flying.filter((l) => l.timeS >= median * 0.6 && l.timeS <= median * 1.6);
}

/**
 * Drop laps centred inside a user-deleted range and re-pick the best lap if it was
 * removed, so deletions survive lap re-detection (start line moved, track rebuilt).
 */
export function withoutDeletedLaps(laps: Lap[], ranges: Array<[number, number]> | undefined): Lap[] {
  if (!ranges?.length) return laps;
  const kept = laps.filter((l) => {
    const mid = (l.startIdx + l.endIdx) / 2;
    return !ranges.some(([a, b]) => mid >= a && mid <= b);
  });
  if (!kept.some((l) => l.isBest)) {
    const best = plausibleFlyingLaps(kept).sort((x, y) => x.timeS - y.timeS)[0];
    if (best) best.isBest = true;
  }
  return kept;
}

function buildLaps(s: Session, rawCrossings: Crossing[], sectors: number[][]): Lap[] {
  const n = s.t.length;
  const crossings = dedupeCrossings(rawCrossings);
  if (!crossings.length || n === 0) return [];
  const laps: Lap[] = [];
  let num = 0;

  // out lap: start of the session to the first crossing
  if (crossings[0].idx > 0) {
    laps.push({
      n: num++,
      startIdx: 0,
      endIdx: crossings[0].idx,
      timeS: crossings[0].tS - s.t[0],
      sectorsS: [],
      isBest: false,
      kind: 'out',
    });
  }

  for (let i = 0; i + 1 < crossings.length; i++) {
    laps.push({
      n: num++,
      startIdx: crossings[i].idx,
      endIdx: crossings[i + 1].idx,
      timeS: crossings[i + 1].tS - crossings[i].tS,
      sectorsS: sectors[i] ?? [],
      isBest: false,
      kind: 'flying',
    });
  }

  // in lap: last crossing to the end of the session
  const last = crossings[crossings.length - 1];
  if (last.idx < n - 1) {
    laps.push({
      n: num++,
      startIdx: last.idx,
      endIdx: n - 1,
      timeS: s.t[n - 1] - last.tS,
      sectorsS: [],
      isBest: false,
      kind: 'in',
    });
  }

  // Best = quickest plausible flying lap. Laps far below the median are cut
  // laps / beacon glitches, laps far above it are pit or merged-run gaps.
  const flying = laps.filter((l) => l.kind === 'flying').map((l) => l.timeS).sort((a, b) => a - b);
  const median = flying.length ? flying[flying.length >> 1] : 0;
  let bestIdx = -1;
  for (let i = 0; i < laps.length; i++) {
    if (laps[i].kind !== 'flying') continue;
    const plausible = flying.length < 3 || (laps[i].timeS >= median * 0.6 && laps[i].timeS <= median * 1.6);
    if (!plausible) continue;
    if (bestIdx < 0 || laps[i].timeS < laps[bestIdx].timeS) bestIdx = i;
  }
  if (bestIdx >= 0) laps[bestIdx].isBest = true;
  return laps;
}

/**
 * Lap boundaries from GPS gate crossings. `sf` is the start/finish gate,
 * `splits` the sector gates in track order. The first partial lap is 'out',
 * the last partial lap 'in', and the quickest flying lap gets `isBest`.
 */
export function detectLaps(s: Session, sf: Gate, splits: Gate[]): Lap[] {
  const lon = s.channels.get('gps_lon')?.data;
  const lat = s.channels.get('gps_lat')?.data;
  if (!lon || !lat || !s.t.length) return [];
  const n = Math.min(s.t.length, lon.length, lat.length);

  const crossings: Crossing[] = [];
  // split crossing times, grouped per flying lap as they are found
  const splitTimes: number[][] = [];
  let pendingSplits: number[] = [];

  for (let i = 1; i < n; i++) {
    const p0: LngLat = [lon[i - 1], lat[i - 1]];
    const p1: LngLat = [lon[i], lat[i]];
    const f = segmentCrossing(p0, p1, sf);
    if (f !== null) {
      // ignore a repeat crossing within MIN_LAP_S (GPS noise at the gate)
      const tS = s.t[i - 1] + f * (s.t[i] - s.t[i - 1]);
      if (!crossings.length || tS - crossings[crossings.length - 1].tS >= MIN_LAP_S) {
        if (crossings.length) splitTimes.push(pendingSplits);
        pendingSplits = [];
        crossings.push({ idx: i, tS });
        continue;
      }
    }
    for (const g of splits) {
      const fg = segmentCrossing(p0, p1, g);
      if (fg !== null) {
        pendingSplits.push(s.t[i - 1] + fg * (s.t[i] - s.t[i - 1]));
        break;
      }
    }
  }

  // sector times per flying lap: [split1 - lapStart, ..., lapEnd - lastSplit]
  const sectors: number[][] = [];
  for (let i = 0; i + 1 < crossings.length; i++) {
    const times = splitTimes[i] ?? [];
    const marks = [crossings[i].tS, ...times, crossings[i + 1].tS];
    const out: number[] = [];
    for (let k = 0; k + 1 < marks.length; k++) out.push(marks[k + 1] - marks[k]);
    sectors.push(out);
  }

  return buildLaps(s, crossings, sectors);
}

/**
 * Fallback lap detection from the derived `lap_mark` channel: value 1 marks the
 * sample nearest a DDA lap-beacon crossing, NaN elsewhere (see sessionFromParsed).
 */
export function lapsFromMarkers(s: Session): Lap[] {
  const mark = s.channels.get('lap_mark');
  if (!mark || !s.t.length) return [];
  const n = Math.min(s.t.length, mark.data.length);
  const crossings: Crossing[] = [];
  for (let i = 0; i < n; i++) {
    if (mark.data[i] === 1) crossings.push({ idx: i, tS: s.t[i] });
  }
  return buildLaps(s, crossings, []);
}

/** Interpolate y at x in a monotonically increasing (x,y) table. */
function interp(xs: number[], ys: number[], x: number): number {
  const n = xs.length;
  if (n === 0) return NaN;
  if (x < xs[0] || x > xs[n - 1]) return NaN;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  const dx = xs[hi] - xs[lo];
  if (dx <= 0) return ys[lo];
  return ys[lo] + ((ys[hi] - ys[lo]) * (x - xs[lo])) / dx;
}

/**
 * Time variance of `lap` against `refLap` as a function of lap distance:
 * elapsed time at a distance minus the reference's elapsed time at the same
 * distance. Positive = slower than the reference. NaN outside the lap.
 */
export function deltaT(s: Session, lap: Lap, ref: Session, refLap: Lap): Float32Array {
  const out = new Float32Array(s.t.length).fill(NaN);
  const d = s.channels.get('lap_dist')?.data;
  const dRef = ref.channels.get('lap_dist')?.data;
  if (!d || !dRef) return out;

  // reference table: distance -> elapsed time (monotonic distance only)
  const xs: number[] = [];
  const ys: number[] = [];
  const t0Ref = ref.t[refLap.startIdx];
  for (let i = refLap.startIdx; i <= refLap.endIdx && i < dRef.length; i++) {
    const x = dRef[i];
    if (Number.isNaN(x)) continue;
    if (xs.length && x <= xs[xs.length - 1]) continue;
    xs.push(x);
    ys.push(ref.t[i] - t0Ref);
  }
  if (xs.length < 2) return out;

  const t0 = s.t[lap.startIdx];
  let lastD = -Infinity;
  for (let i = lap.startIdx; i <= lap.endIdx && i < d.length; i++) {
    const x = d[i];
    if (Number.isNaN(x)) continue;
    // lap_dist restarts on the sample shared with the next lap: that sample
    // belongs to the next lap, so stop rather than compare against its 0 m.
    if (x < lastD) continue;
    lastD = x;
    const refElapsed = interp(xs, ys, x);
    if (Number.isNaN(refElapsed)) continue;
    out[i] = s.t[i] - t0 - refElapsed;
  }
  return out;
}
