// Corridor persistence.
import type { LngLat, TrackModel } from '../core/types';
import { fromLocalM, haversineM, toLocalM } from '../core/geo';
import { stencilK, stencilLeftNormal } from './corridor';
import type { Corridor } from './types';

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

/**
 * A corridor as it is stored on the server.
 *
 * Edges are GEOGRAPHIC, not per-vertex offsets. Every visitor builds their own
 * centerline from their own laps (`buildCenterline` in `state/trackActions.ts`),
 * so vertex count, length and start point all differ between two people on the
 * same circuit — a vertex-indexed corridor is unshareable by construction.
 * Geography is the one thing they do share.
 *
 * `null` marks a vertex the extractor could not resolve; it survives the round
 * trip so a leak into the pit lane stays flagged rather than being invented.
 */
export interface StoredCorridor {
  version: 2;
  key: string;
  center: LngLat;
  lengthM: number;
  leftEdge: Array<LngLat | null>;
  rightEdge: Array<LngLat | null>;
}

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;

export function serializeCorridor(track: TrackModel, c: Corridor): StoredCorridor {
  const cl = track.centerline;
  const k = stencilK(track);
  const leftEdge: Array<LngLat | null> = [];
  const rightEdge: Array<LngLat | null> = [];
  for (let i = 0; i < cl.length; i++) {
    if (!c.known[i] || !Number.isFinite(c.leftM[i]) || !Number.isFinite(c.rightM[i])) {
      leftEdge.push(null);
      rightEdge.push(null);
      continue;
    }
    const [nx, ny] = stencilLeftNormal(cl, i, k);
    const l = fromLocalM(cl[i], [nx * c.leftM[i], ny * c.leftM[i]]);
    const r = fromLocalM(cl[i], [-nx * c.rightM[i], -ny * c.rightM[i]]);
    leftEdge.push([round6(l[0]), round6(l[1])]);
    rightEdge.push([round6(r[0]), round6(r[1])]);
  }
  return {
    version: 2,
    key: corridorKey(track),
    center: [round6(track.center[0]), round6(track.center[1])],
    lengthM: Math.round(track.lengthM),
    leftEdge,
    rightEdge,
  };
}

/** The circuit must be the same one: centre within this, metres. */
const SAME_CIRCUIT_M = 2000;
/** ...and the lap length within this fraction. */
const LENGTH_TOLERANCE = 0.15;
/**
 * An edge further than this from a vertex is not that vertex's edge.
 *
 * Deliberately tighter than {@link SAME_CIRCUIT_M}: this bounds the gap
 * between adjacent known samples on the stored polyline (typically a few
 * metres at GPS sampling rates), not the whole-track fingerprint. Looser
 * values let the nearest-point search silently bridge a genuinely unknown
 * stretch (e.g. a pit-lane gap) with a point from well outside it.
 */
const MAX_EDGE_DIST_M = 12;

function isLngLat(v: unknown): v is LngLat {
  return Array.isArray(v) && v.length === 2 && Number.isFinite(v[0]) && Number.isFinite(v[1]);
}

/** Squared local-metre distance from `p` to the nearest vertex of `edge`, and that distance. */
function nearestEdgeDistM(edge: Array<LngLat | null>, p: LngLat): number {
  let best = Infinity;
  for (const q of edge) {
    if (!q) continue;
    const d = toLocalM(p, q);
    const d2 = d[0] * d[0] + d[1] * d[1];
    if (d2 < best) best = d2;
  }
  return best === Infinity ? NaN : Math.sqrt(best);
}

/**
 * Project this track's centerline onto a stored corridor's edge polylines.
 *
 * The edge runs roughly parallel to the centerline, so the distance to the
 * nearest stored edge point is the corridor half-width to within the edge's own
 * 2 m sampling — good enough for a racing line, and it needs no shared origin,
 * no shared vertex count and no shared start/finish.
 */
export function deserializeCorridor(track: TrackModel, raw: unknown): Corridor | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Partial<StoredCorridor>;
  if (s.version !== 2) return null;
  if (!isLngLat(s.center)) return null;
  if (typeof s.lengthM !== 'number' || !Number.isFinite(s.lengthM) || s.lengthM <= 0) return null;
  if (!Array.isArray(s.leftEdge) || !Array.isArray(s.rightEdge)) return null;
  if (s.leftEdge.length !== s.rightEdge.length || s.leftEdge.length < 8) return null;
  for (const e of [...s.leftEdge, ...s.rightEdge]) {
    if (e !== null && !isLngLat(e)) return null;
  }
  if (haversineM(s.center, track.center) > SAME_CIRCUIT_M) return null;
  if (Math.abs(s.lengthM - track.lengthM) > LENGTH_TOLERANCE * s.lengthM) return null;

  const n = track.centerline.length;
  const leftM = new Float32Array(n);
  const rightM = new Float32Array(n);
  const known = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    const l = nearestEdgeDistM(s.leftEdge, track.centerline[i]);
    const r = nearestEdgeDistM(s.rightEdge, track.centerline[i]);
    if (!Number.isFinite(l) || !Number.isFinite(r) || l > MAX_EDGE_DIST_M || r > MAX_EDGE_DIST_M) continue;
    leftM[i] = l;
    rightM[i] = r;
    known[i] = true;
  }
  const stepM = track.lengthM / Math.max(1, n);
  return { stepM, leftM, rightM, known };
}
