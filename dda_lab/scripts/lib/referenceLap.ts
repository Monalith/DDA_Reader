// The two Serres reference laps (BMW 1:19.81, R6 1:19.849) and the simulated
// lap, as the SAME kind of trace: one sample per metre of lap distance.
//
// Reading rules are the ones the earlier calibration notes settled on
// (docs/superpowers/notes/2026-10-10-virtual-vs-real.md §0 and
// 2026-10-11-longitudinal-g.md §1): `hiz_kmh` is the one measured channel,
// `boylamsal_g` is its derivative, lat/lon is a hand-placed line, `gaz_pct`
// is real on the R6 only, and two artefact spans are masked out of the g
// trace (`BMW_ARTEFACT_M`, `R6_ARTEFACT_M` in tests/unit/gTraceMetrics.ts).
import { readFileSync } from 'node:fs';
import { buildCenterline } from '../../src/core/track';
import type { Session, TrackModel } from '../../src/core/types';

export interface ReferenceRow {
  s_m: number;
  t_s: number;
  hiz_kmh: number;
  boylamsal_g: number;
  lat: number;
  lon: number;
  gaz_pct: number | null;
  vites: number | null;
}

/** A lap on a 1 m distance grid. Optional channels are absent, not zero. */
export interface DistTrace {
  sM: Float64Array;
  tS: Float64Array;
  speedKmh: Float32Array;
  longG: Float32Array;
  tps?: Float32Array;
  brake?: Float32Array;
  lapTimeS: number;
  lengthM: number;
}

/** Artefact spans, metres (copied from tests/unit/gTraceMetrics.ts, which documents each). */
export const ARTEFACTS_M: Record<'BMW' | 'R6', Array<[number, number]>> = {
  BMW: [[360, 384]],
  R6: [[1645, 1685]],
};

export function referenceKind(path: string): 'BMW' | 'R6' {
  return /R6/i.test(path) ? 'R6' : 'BMW';
}

export function readReferenceRows(path: string): ReferenceRow[] {
  return (JSON.parse(readFileSync(path, 'utf8')) as { telemetri_1m: ReferenceRow[] }).telemetri_1m;
}

/** Replace samples inside the spans by a straight line between their neighbours. */
export function bridgeSpans(sM: ArrayLike<number>, y: Float32Array, spans: Array<[number, number]>): void {
  for (const [a, b] of spans) {
    let i0 = -1;
    let i1 = -1;
    for (let i = 0; i < y.length; i++) {
      if (sM[i] >= a && sM[i] <= b) {
        if (i0 < 0) i0 = i;
        i1 = i;
      }
    }
    if (i0 <= 0 || i1 >= y.length - 1) continue;
    const ya = y[i0 - 1];
    const yb = y[i1 + 1];
    for (let i = i0; i <= i1; i++) y[i] = ya + ((yb - ya) * (i - i0 + 1)) / (i1 - i0 + 2);
  }
}

export function referenceTrace(rows: ReferenceRow[], kind: 'BMW' | 'R6'): DistTrace {
  const n = rows.length;
  const sM = Float64Array.from(rows, (r) => r.s_m);
  const longG = Float32Array.from(rows, (r) => r.boylamsal_g);
  bridgeSpans(sM, longG, ARTEFACTS_M[kind]);
  const hasTps = rows.some((r) => r.gaz_pct !== null);
  return {
    sM,
    tS: Float64Array.from(rows, (r) => r.t_s),
    speedKmh: Float32Array.from(rows, (r) => r.hiz_kmh),
    longG,
    tps: hasTps ? Float32Array.from(rows, (r) => r.gaz_pct ?? 0) : undefined,
    lapTimeS: rows[n - 1].t_s - rows[0].t_s,
    lengthM: rows[n - 1].s_m - rows[0].s_m,
  };
}

/** The Serres centerline from a reference file's own lat/lon, exactly as `simSerres.test.ts` builds it. */
export function serresTrack(rows: Array<{ lat: number; lon: number }>): TrackModel {
  const lng = new Float32Array(rows.length);
  const lat = new Float32Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    lng[i] = rows[i].lon;
    lat[i] = rows[i].lat;
  }
  const { centerline, cumDistM, lengthM } = buildCenterline([{ lng, lat }], 2);
  return {
    id: 'serres', name: 'Serres', center: centerline[0], centerline, cumDistM, lengthM,
    startFinish: { id: 'sf', name: 'SF', type: 'sf', at: centerline[0], bearingDeg: 0, halfWidthM: 15 },
    sectors: [], turns: [],
  };
}

/**
 * Resample a time-indexed series onto a 1 m grid of `dist` (monotone
 * non-decreasing). Linear in distance.
 */
function onDistanceGrid(dist: ArrayLike<number>, y: ArrayLike<number>, grid: Float64Array): Float32Array {
  const out = new Float32Array(grid.length);
  let j = 0;
  const n = dist.length;
  for (let k = 0; k < grid.length; k++) {
    const s = grid[k];
    while (j < n - 2 && dist[j + 1] < s) j++;
    const d0 = dist[j];
    const d1 = dist[j + 1];
    const f = d1 > d0 ? Math.min(1, Math.max(0, (s - d0) / (d1 - d0))) : 0;
    out[k] = y[j] + f * (y[j + 1] - y[j]);
  }
  return out;
}

/** The simulator's `Session` (10 Hz) as a 1 m distance trace. */
export function sessionTrace(session: Session, lapTimeS: number): DistTrace {
  const ch = (name: string): Float32Array | undefined => session.channels.get(name)?.data;
  const dist = ch('lap_dist');
  const speed = ch('speed');
  const longG = ch('long_g');
  if (!dist || !speed || !longG) throw new Error('sim session lacks lap_dist/speed/long_g');
  const lengthM = dist[dist.length - 1];
  const grid = Float64Array.from({ length: Math.floor(lengthM) + 1 }, (_, i) => i);
  const t = session.t;
  const tps = ch('tps');
  const brake = ch('brake');
  return {
    sM: grid,
    tS: Float64Array.from(onDistanceGrid(dist, t, grid)),
    speedKmh: onDistanceGrid(dist, speed, grid),
    longG: onDistanceGrid(dist, longG, grid),
    tps: tps ? onDistanceGrid(dist, tps, grid) : undefined,
    brake: brake ? onDistanceGrid(dist, brake, grid) : undefined,
    lapTimeS,
    lengthM,
  };
}

/** Separate applications of a 0..100 brake channel: upward crossings of `onPct`. */
export function brakeApplications(brake: ArrayLike<number>, onPct = 5): number {
  let n = brake.length && brake[0] >= onPct ? 1 : 0;
  for (let i = 1; i < brake.length; i++) if (brake[i - 1] < onPct && brake[i] >= onPct) n++;
  return n;
}
