// Ready-made reports: sector table, histograms, gear usage, G-G, lean x throttle,
// time-loss summary and CSV export.
import { plausibleFlyingLaps } from './laps';
import { trackDistanceForLap } from './track';
import type { Lap, Session, TrackModel } from './types';

export interface SectorTable {
  /** Lap numbers, in lap order. */
  laps: number[];
  /** `sectors[row][sector]` — sector times in seconds for `laps[row]`. */
  sectors: number[][];
  /** Fastest time per sector across the included laps. */
  bestPerSector: number[];
  /** Sum of `bestPerSector`. */
  theoreticalBest: number;
  /** Population standard deviation of the lap times (consistency). */
  sigma: number;
}

/** Sector matrix over the flying laps that have sector times. */
export function sectorTable(s: Session, only?: Lap[]): SectorTable {
  const pool = only?.length ? only : s.laps;
  const laps = plausibleFlyingLaps(pool).filter((l) => l.sectorsS.length > 0);
  if (!laps.length) {
    return { laps: [], sectors: [], bestPerSector: [], theoreticalBest: 0, sigma: 0 };
  }
  const nSec = Math.max(...laps.map((l) => l.sectorsS.length));
  const sectors = laps.map((l) => {
    const row = new Array<number>(nSec).fill(NaN);
    for (let i = 0; i < l.sectorsS.length; i++) row[i] = l.sectorsS[i];
    return row;
  });
  const bestPerSector: number[] = [];
  for (let k = 0; k < nSec; k++) {
    let best = NaN;
    for (const row of sectors) {
      const v = row[k];
      if (Number.isFinite(v) && (!Number.isFinite(best) || v < best)) best = v;
    }
    bestPerSector.push(best);
  }
  const theoreticalBest = bestPerSector.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  const times = laps.map((l) => l.timeS).filter((v) => Number.isFinite(v));
  const mean = times.reduce((a, b) => a + b, 0) / (times.length || 1);
  const sigma = times.length
    ? Math.sqrt(times.reduce((a, b) => a + (b - mean) ** 2, 0) / times.length)
    : 0;
  return { laps: laps.map((l) => l.n), sectors, bestPerSector, theoreticalBest, sigma };
}

/**
 * Bin index for `v` given edge array `bins`, clamped into the end bins so that
 * every finite sample is counted. Returns -1 for non-finite values or when
 * there are fewer than two edges.
 */
function binIndex(v: number, bins: number[]): number {
  const nb = bins.length - 1;
  if (nb < 1 || !Number.isFinite(v)) return -1;
  if (v <= bins[0]) return 0;
  if (v >= bins[nb]) return nb - 1;
  let lo = 0;
  let hi = nb;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (bins[mid] <= v) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Counts per bin for the edge array `bins` (length n → n-1 counts). Values
 * outside the range are clamped into the end bins, so the counts always sum to
 * the number of finite samples.
 */
export function histogram(v: Float32Array, bins: number[]): number[] {
  const nb = bins.length - 1;
  if (nb < 1) return [];
  const counts = new Array<number>(nb).fill(0);
  for (let i = 0; i < v.length; i++) {
    const b = binIndex(v[i], bins);
    if (b >= 0) counts[b]++;
  }
  return counts;
}

/** Percentage of finite samples spent in each gear. */
export function gearUsagePct(gear: Float32Array): Record<number, number> {
  const counts = new Map<number, number>();
  let total = 0;
  for (let i = 0; i < gear.length; i++) {
    const g = gear[i];
    if (!Number.isFinite(g)) continue;
    const k = Math.round(g);
    counts.set(k, (counts.get(k) ?? 0) + 1);
    total++;
  }
  const out: Record<number, number> = {};
  if (!total) return out;
  for (const [k, c] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
    out[k] = (c / total) * 100;
  }
  return out;
}

function lapRange(s: Session, lap: Lap): [number, number] {
  return [Math.max(0, lap.startIdx), Math.min(s.t.length - 1, lap.endIdx)];
}

/** `[lat_g, long_g]` pairs for the lap (non-finite samples dropped). */
export function ggPoints(s: Session, lap: Lap): [number, number][] {
  const latG = s.channels.get('lat_g')?.data;
  const longG = s.channels.get('long_g')?.data;
  if (!latG || !longG) return [];
  const [a, b] = lapRange(s, lap);
  const out: [number, number][] = [];
  for (let i = a; i <= b; i++) {
    if (Number.isFinite(latG[i]) && Number.isFinite(longG[i])) out.push([latG[i], longG[i]]);
  }
  return out;
}

/**
 * Count matrix of |lean| (rows) against throttle (columns) for the lap.
 * `m[leanBin][tpsBin]`; out-of-range values are clamped into the end bins.
 */
export function leanVsThrottle(
  s: Session,
  lap: Lap,
  leanBins: number[],
  tpsBins: number[],
): number[][] {
  const rows = leanBins.length - 1;
  const cols = tpsBins.length - 1;
  if (rows < 1 || cols < 1) return [];
  const m = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  const lean = s.channels.get('lean')?.data;
  const tps = s.channels.get('tps')?.data;
  if (!lean || !tps) return m;
  const [a, b] = lapRange(s, lap);
  for (let i = a; i <= b; i++) {
    const r = binIndex(Math.abs(lean[i]), leanBins);
    const c = binIndex(tps[i], tpsBins);
    if (r >= 0 && c >= 0) m[r][c]++;
  }
  return m;
}

/**
 * Time gained/lost per turn: the change of `delta_t` (already referenced to
 * the reference lap) across each turn's distance range, sorted worst first.
 */
export function timeLossSummary(
  s: Session,
  lap: Lap,
  _refLap: Lap,
  track: TrackModel,
): { turn: number; lossS: number }[] {
  const dt = s.channels.get('delta_t')?.data;
  if (!dt || !track.turns.length) return [];
  const a = Math.max(0, lap.startIdx);
  const sDist = trackDistanceForLap(s, lap, track);
  const len = sDist.length;
  if (!len) return [];

  const valueAt = (sM: number): number => {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < len; i++) {
      const d = Math.abs(sDist[i] - sM);
      if (Number.isFinite(d) && d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best >= 0 ? dt[a + best] : NaN;
  };

  const rows = track.turns.map((t) => ({
    turn: t.n,
    lossS: valueAt(t.sRange[1]) - valueAt(t.sRange[0]),
  }));
  return rows.sort((x, y) => {
    const ax = Number.isFinite(x.lossS) ? x.lossS : -Infinity;
    const ay = Number.isFinite(y.lossS) ? y.lossS : -Infinity;
    return ay - ax;
  });
}

/** RFC-4180-ish CSV: NaN → empty cell, quotes doubled, `\n` line endings. */
export function toCsv(rows: (string | number)[][]): string {
  const cell = (v: string | number): string => {
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
    const needsQuote = /[",\n\r]/.test(v) || v !== v.trim();
    return needsQuote ? `"${v.replace(/"/g, '""')}"` : v;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\n');
}
