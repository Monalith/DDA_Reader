// `lineMode: 'lap-time'` (pist-line note §8): the racing line found by a
// DIRECT lap-time descent — the free-trajectory optimiser (`freeTrajectory.ts`)
// judged by the rider's own QSS lap (not the ideal rider's), warm-started from
// the fastest κ-line. A run takes ~10-20 s on Serres, so it never runs inside
// `buildLine`: the browser runs it in the free-trajectory worker
// (ui/panels/simRunners.ts → "Optimise line") and stores the result here;
// `buildLine` then reads it synchronously. Until a result exists (or after the
// track changes) `buildLine` falls back to the min-time line.
//
// Cache: an exact entry per (track, machine, tyre, rider) — the optCache
// mechanics, memory + an injected key-value storage — plus the latest result
// per track, which `buildLine` uses (re-clamped into the box) when only the
// rider sliders moved: a slightly stale lap-time line is a better line than the
// min-time fallback, and `lapTimeLineStatus` tells the panel it is stale.
import type { TrackModel } from '../core/types';
import { corridorKey } from './corridorCache';
import { buildLine, offsetBounds } from './line';
import { fnv1a, readOpt, stableStringify, writeOpt, type KVStorage } from './optCache';
import { clampParams } from './presets';
import { solve } from './solver';
import type { Corridor, SimParams } from './types';

/** Sweeps per run: Serres converges in 19-31 (note §8). */
export const LAP_TIME_ITERATIONS = 60;

/** κ values whose min-time lines are tried as the warm start; the fastest wins. */
const START_KAPPAS = [0, 0.5, 0.85, 1];

/**
 * Cache key: track + station count + everything the rider's QSS lap depends on.
 * The line's own knobs (lineMode, lineDeviationM, the overrides list) are left
 * out; κ stays in (it picks the warm start's candidates).
 */
export function lapTimeKey(track: TrackModel, params: SimParams): string {
  const p = clampParams(params);
  const { presetId: _id, ...machine } = p.machine;
  void _id;
  const { lineMode: _m, lineDeviationM: _d, overrides: _o, ...rider } = p.rider;
  void _m;
  void _d;
  void _o;
  return `${corridorKey(track)}.lt.${track.centerline.length}.${fnv1a(stableStringify({ machine, tyre: p.tyre, rider }))}`;
}

const latest = new Map<string, { key: string; offsetsM: Float32Array; lapTimeS: number }>();
const trackKey = (track: TrackModel): string => `${corridorKey(track)}.${track.centerline.length}`;

/** Store a finished run (memory, and `storage` when given). */
export function rememberLapTimeLine(track: TrackModel, params: SimParams, offsetsM: Float32Array, lapTimeS: number, storage?: KVStorage): void {
  const key = lapTimeKey(track, params);
  writeOpt(key, offsetsM, lapTimeS, storage);
  latest.set(trackKey(track), { key, offsetsM: Float32Array.from(offsetsM), lapTimeS });
}

/** An exact cached result (memory, then `storage`), or null. Promotes a hit to "latest". */
export function cachedLapTimeLine(track: TrackModel, params: SimParams, storage?: KVStorage): Float32Array | null {
  const key = lapTimeKey(track, params);
  const hit = readOpt(key, track.centerline.length, storage);
  if (hit) latest.set(trackKey(track), { key, offsetsM: Float32Array.from(hit), lapTimeS: NaN });
  return hit;
}

export type LapTimeStatus = 'fresh' | 'stale' | 'none';

/** Whether `buildLine` would use an exact result, a stale one for this track, or the min-time fallback. */
export function lapTimeLineStatus(track: TrackModel, params: SimParams): LapTimeStatus {
  const l = latest.get(trackKey(track));
  if (!l) return 'none';
  return l.key === lapTimeKey(track, params) ? 'fresh' : 'stale';
}

/**
 * The offsets `buildLine` uses for 'lap-time', clamped into this box, or null
 * when there is no result for this track (→ min-time fallback).
 */
export function lapTimeOffsets(track: TrackModel, corridor: Corridor | undefined, params: SimParams, fallbackHalfWidthM = 5): Float32Array | null {
  const exact = readOpt(lapTimeKey(track, params), track.centerline.length);
  const src = exact ?? latest.get(trackKey(track))?.offsetsM ?? null;
  if (!src) return null;
  const { loM, hiM } = offsetBounds(track, corridor, params, fallbackHalfWidthM);
  return Float32Array.from(src, (v, i) => Math.min(hiM[i], Math.max(loM[i], v)));
}

/**
 * Warm start: the min-time line at the rider's κ and at `START_KAPPAS`, the one
 * with the fastest QSS lap for this rider (no wander). On Serres the κ 0.85
 * start reaches 76.07 s, the κ 0 one 77.33 s (note §8): the descent is local.
 */
export function lapTimeStart(track: TrackModel, corridor: Corridor | undefined, params: SimParams): Float32Array {
  const base = clampParams({ ...params, rider: { ...params.rider, lineMode: 'min-time', lineDeviationM: 0 } });
  let best: Float32Array | null = null;
  let bestT = Infinity;
  for (const kappa of new Set([base.rider.kappa, ...START_KAPPAS])) {
    const p = { ...base, rider: { ...base.rider, kappa } };
    const line = buildLine(track, corridor, p);
    const t = solve(line, p).lapTimeS;
    if (t < bestT) {
      bestT = t;
      best = Float32Array.from(line.offsetM);
    }
  }
  return best!;
}

/** Test hook: forget every in-memory result. */
export function clearLapTimeLines(): void {
  latest.clear();
}
