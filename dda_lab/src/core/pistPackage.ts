// `.pist.json` track models (the `pist` tool's package, version 2) inside DDA Lab.
//
// A package carries a refined 1 m-station centreline, the left/right asphalt
// edges with per-station confidence, detected corners and a start/finish gate.
// Here it becomes (a) the active `TrackModel` — so every loaded lap is
// projected onto a surveyed centreline instead of one averaged from GPS —
// and (b) the `Corridor` the virtual rider's line is generated inside, so the
// rider model uses the same track model the map shows.
import { haversineM } from './geo';
import { defaultSectorGates } from './track';
import type { Gate, LngLat, TrackModel, Turn } from './types';
import type { Corridor } from '../sim/types';
import { deserializeCorridor } from '../sim/corridorCache';

export interface PistCorner {
  n: number;
  name: string;
  dir: 'L' | 'R';
  compound: boolean;
  entryS: number;
  apexS: number;
  exitS: number;
  radiusM: number;
  apex: LngLat;
  apices: LngLat[];
}

export interface PistPackage {
  version: 2;
  name: string;
  center: LngLat;
  lengthM: number;
  direction: 'cw' | 'ccw';
  startFinish: { at: LngLat; bearingDeg: number; halfWidthM: number } | null;
  centerline: LngLat[];
  cumDistM: number[];
  leftEdge: (LngLat | null)[];
  rightEdge: (LngLat | null)[];
  confidence: number[];
  corners: PistCorner[];
}

const isLngLat = (p: unknown): p is LngLat =>
  Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);

/** Parse and shape-check a `.pist.json` text. Throws with a readable message. */
export function parsePistPackage(text: string): PistPackage {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch (e) {
    throw new Error(`not valid JSON (${(e as Error).message})`);
  }
  if (!j || typeof j !== 'object') throw new Error('not a pist package');
  const p = j as Partial<PistPackage>;
  if (p.version !== 2) throw new Error(`pist package version ${String(p.version)} is not supported (need 2)`);
  if (!isLngLat(p.center)) throw new Error('pist package has no center');
  if (!Array.isArray(p.centerline) || p.centerline.length < 16 || !p.centerline.every(isLngLat)) {
    throw new Error('pist package has no usable centerline');
  }
  const n = p.centerline.length;
  if (!Array.isArray(p.cumDistM) || p.cumDistM.length !== n) throw new Error('pist package cumDistM does not match the centerline');
  for (const key of ['leftEdge', 'rightEdge'] as const) {
    const e = p[key];
    if (!Array.isArray(e) || e.length !== n || !e.every((q) => q === null || isLngLat(q))) {
      throw new Error(`pist package ${key} does not match the centerline`);
    }
  }
  if (typeof p.lengthM !== 'number' || !(p.lengthM > 0)) throw new Error('pist package has no length');
  return {
    version: 2,
    name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : 'Track model',
    center: p.center,
    lengthM: p.lengthM,
    direction: p.direction === 'cw' ? 'cw' : 'ccw',
    startFinish:
      p.startFinish && isLngLat(p.startFinish.at) && Number.isFinite(p.startFinish.bearingDeg)
        ? { at: p.startFinish.at, bearingDeg: p.startFinish.bearingDeg, halfWidthM: p.startFinish.halfWidthM || 15 }
        : null,
    centerline: p.centerline,
    cumDistM: p.cumDistM.map(Number),
    leftEdge: p.leftEdge as (LngLat | null)[],
    rightEdge: p.rightEdge as (LngLat | null)[],
    confidence: Array.isArray(p.confidence) && p.confidence.length === n ? p.confidence.map(Number) : new Array<number>(n).fill(0),
    corners: Array.isArray(p.corners)
      ? (p.corners as PistCorner[]).filter((c) => c && isLngLat(c.apex) && Number.isFinite(c.entryS) && Number.isFinite(c.exitS))
      : [],
  };
}

/** Station spacing the lab works at; pist packages are 1 m, the lab's own tracks 2 m. */
export const LAB_STEP_M = 2;

function bearingDeg(a: LngLat, b: LngLat): number {
  const toRad = Math.PI / 180;
  const dLng = (b[0] - a[0]) * toRad;
  const y = Math.sin(dLng) * Math.cos(b[1] * toRad);
  const x = Math.cos(a[1] * toRad) * Math.sin(b[1] * toRad) - Math.sin(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * The lab `TrackModel` for a package: the centreline subsampled to
 * `LAB_STEP_M`, the package gate (or the first station when it has none),
 * three default sector gates and the package corners as turns. `id` is stable
 * per package name so re-applying the same model replaces, not duplicates.
 */
export function trackFromPist(p: PistPackage): TrackModel {
  const stride = Math.max(1, Math.round(LAB_STEP_M / Math.max(0.25, p.lengthM / p.centerline.length)));
  const centerline: LngLat[] = [];
  const cum: number[] = [];
  for (let i = 0; i < p.centerline.length; i += stride) {
    centerline.push(p.centerline[i]);
    cum.push(p.cumDistM[i]);
  }
  const n = centerline.length;
  const cumDistM = new Float64Array(n);
  for (let i = 1; i < n; i++) cumDistM[i] = cumDistM[i - 1] + haversineM(centerline[i - 1], centerline[i]);
  const lengthM = cumDistM[n - 1] + haversineM(centerline[n - 1], centerline[0]);

  const sf: Gate = p.startFinish
    ? { id: 'sf', name: 'Start / Finish', type: 'sf', at: p.startFinish.at, bearingDeg: p.startFinish.bearingDeg, halfWidthM: p.startFinish.halfWidthM }
    : { id: 'sf', name: 'Start / Finish', type: 'sf', at: centerline[0], bearingDeg: bearingDeg(centerline[0], centerline[1]), halfWidthM: 15 };

  const scale = lengthM / p.lengthM; // the subsampled chord length vs the package's stated length
  const turns: Turn[] = p.corners
    .slice()
    .sort((a, b) => a.apexS - b.apexS)
    .map((c, i) => ({
      n: i + 1,
      name: c.name || `T${i + 1}`,
      dir: c.dir,
      apexGeo: c.apex,
      radiusM: c.radiusM,
      sRange: [c.entryS * scale, c.exitS * scale] as [number, number],
    }));

  const id = `pist-${p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'track'}`;
  return {
    id,
    name: p.name,
    center: p.center,
    centerline,
    cumDistM,
    lengthM,
    startFinish: sf,
    sectors: defaultSectorGates(centerline, cumDistM, sf),
    turns,
  };
}

/**
 * The package's asphalt edges as the rider's `Corridor` on `track` — the same
 * geographic projection the server-stored corridor uses (`deserializeCorridor`
 * v2), so a track built from the package and a GPS-built track of the same
 * circuit both get it.
 */
export function corridorFromPist(p: PistPackage, track: TrackModel): Corridor | null {
  return deserializeCorridor(track, {
    version: 2,
    center: p.center,
    lengthM: p.lengthM,
    leftEdge: p.leftEdge,
    rightEdge: p.rightEdge,
  });
}

/** Bundled track models under `public/tracks/`. */
export interface TrackModelEntry {
  id: string;
  label: string;
  file: string;
}

export const TRACK_MODELS: TrackModelEntry[] = [
  { id: 'serres-v6', label: 'Serres Racing Circuit (pist-6, 16 corners)', file: 'serres-v6.pist.json' },
  { id: 'serres', label: 'Serres Racing Circuit (pist, Esri z18, 16 corners)', file: 'serres.pist.json' },
];

export async function fetchTrackModel(entry: TrackModelEntry, fetchImpl: typeof fetch = fetch): Promise<PistPackage> {
  const res = await fetchImpl(`${import.meta.env.BASE_URL}tracks/${entry.file}`);
  if (!res.ok) throw new Error(`track model ${entry.file}: HTTP ${res.status}`);
  return parsePistPackage(await res.text());
}
