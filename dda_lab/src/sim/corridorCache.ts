// Corridor persistence. A corridor is indexed by centerline vertex, so it is
// only valid for the exact centerline it was built against. setStartLine()
// calls normalizeTrackOrigin(), which ROTATES the centerline — the vertex count
// and length survive but every index shifts, so the first point is fingerprinted
// too and a rotated track invalidates the stored copy.
import type { LngLat, TrackModel } from '../core/types';
import type { Corridor } from './types';

export interface StoredCorridor {
  version: 1;
  trackId: string;
  nPoints: number;
  lengthM: number;
  firstPoint: LngLat;
  stepM: number;
  leftM: number[];
  rightM: number[];
  known: boolean[];
}

/**
 * The server-side name for this track's corridor. Geographic, not the runtime
 * `track.id`, which is regenerated on every load: two people opening the same
 * circuit must land on the same stored corridor. Three decimals of latitude and
 * longitude is about 100 m, far finer than the 3 km recognition radius in
 * `recognizeTrack()` and far coarser than any lap-to-lap variation.
 *
 * The result is constrained to the character set the server's key allowlist
 * accepts, so a track name can never become a path component.
 */
export function corridorKey(track: TrackModel): string {
  const slug = track.name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  const lng = track.center[0].toFixed(3).replace(/[^0-9]/g, (ch) => (ch === '-' ? 'w' : ''));
  const lat = track.center[1].toFixed(3).replace(/[^0-9]/g, (ch) => (ch === '-' ? 's' : ''));
  const key = `${slug || 'track'}-${lng}-${lat}`.slice(0, 64);
  // guarantee the leading character and the whole shape, whatever the name was
  return /^[a-z0-9]/.test(key) ? key : `t${key}`.slice(0, 64);
}

export function serializeCorridor(track: TrackModel, c: Corridor): StoredCorridor {
  return {
    version: 1,
    trackId: track.id,
    nPoints: track.centerline.length,
    lengthM: track.lengthM,
    firstPoint: track.centerline[0],
    stepM: c.stepM,
    leftM: Array.from(c.leftM, (v) => Math.round(v * 100) / 100),
    rightM: Array.from(c.rightM, (v) => Math.round(v * 100) / 100),
    known: c.known,
  };
}

/** How far the first centerline point may move before the cache is stale, metres. */
const ORIGIN_TOLERANCE_DEG = 1e-6; // ~0.1 m

export function deserializeCorridor(track: TrackModel, raw: unknown): Corridor | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Partial<StoredCorridor>;
  if (c.version !== 1) return null;
  if (c.trackId !== track.id) return null;
  if (c.nPoints !== track.centerline.length) return null;
  if (!Array.isArray(c.leftM) || !Array.isArray(c.rightM) || !Array.isArray(c.known)) return null;
  if (c.leftM.length !== track.centerline.length) return null;
  if (c.rightM.length !== track.centerline.length) return null;
  if (c.known.length !== track.centerline.length) return null;
  if (typeof c.lengthM !== 'number' || Math.abs(c.lengthM - track.lengthM) > 1) return null;
  const fp = c.firstPoint;
  if (!Array.isArray(fp) || fp.length !== 2) return null;
  if (
    Math.abs(fp[0] - track.centerline[0][0]) > ORIGIN_TOLERANCE_DEG ||
    Math.abs(fp[1] - track.centerline[0][1]) > ORIGIN_TOLERANCE_DEG
  ) {
    return null;
  }
  return {
    stepM: typeof c.stepM === 'number' ? c.stepM : track.lengthM / Math.max(1, track.centerline.length - 1),
    leftM: Float32Array.from(c.leftM),
    rightM: Float32Array.from(c.rightM),
    known: c.known,
  };
}
