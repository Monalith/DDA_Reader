// Web-Mercator tile maths for the satellite corridor extractor.
//
// Esri World Imagery has no native imagery past z18 (see ESRI_MAX_TILE_Z in
// MapView.tsx), so the extractor pins z18: ~0.45 m/px at European latitudes,
// which puts ~22 px across a 10 m wide circuit.
import type { LngLat } from '../core/types';

export const TILE_SIZE = 256;
export const SAT_ZOOM = 18;

/** Equatorial circumference / 256, the z0 ground resolution in m/px. */
const EQUATOR_MPP = 156543.03392;

export function lngLatToPixel(p: LngLat, z: number): [number, number] {
  const n = TILE_SIZE * 2 ** z;
  const s = Math.sin((p[1] * Math.PI) / 180);
  const clamped = Math.min(0.9999, Math.max(-0.9999, s));
  return [
    ((p[0] + 180) / 360) * n,
    (0.5 - Math.log((1 + clamped) / (1 - clamped)) / (4 * Math.PI)) * n,
  ];
}

export function pixelToLngLat(px: [number, number], z: number): LngLat {
  const n = TILE_SIZE * 2 ** z;
  return [
    (px[0] / n) * 360 - 180,
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * px[1]) / n))) * 180) / Math.PI,
  ];
}

export function metresPerPixel(lat: number, z: number): number {
  return (EQUATOR_MPP * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
}

export interface TileRange {
  tx0: number;
  tx1: number;
  ty0: number;
  ty1: number;
  z: number;
}

export function tileRangeFor(points: LngLat[], z: number, padPx: number): TileRange {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const p of points) {
    const [x, y] = lngLatToPixel(p, z);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  if (!Number.isFinite(x0)) throw new Error('tileRangeFor: no finite points');
  return {
    z,
    tx0: Math.floor((x0 - padPx) / TILE_SIZE),
    tx1: Math.floor((x1 + padPx) / TILE_SIZE),
    ty0: Math.floor((y0 - padPx) / TILE_SIZE),
    ty1: Math.floor((y1 + padPx) / TILE_SIZE),
  };
}

export function tileUrl(z: number, x: number, y: number): string {
  return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
}

/** Loads one tile as tightly packed RGB, or null when it could not be fetched. */
export type TileLoader = (z: number, x: number, y: number) => Promise<Uint8ClampedArray | null>;

export interface Mosaic {
  width: number;
  height: number;
  /** Pixel coordinate (at `range.z`) of the mosaic's top-left corner. */
  originPx: [number, number];
  /** Tightly packed RGB, `width * height * 3`. */
  rgb: Uint8ClampedArray;
  /** One flag per tile in row-major (ty outer, tx inner) order; true = not fetched. */
  missing: boolean[];
}

/** Maximum tiles fetched at once, to stay polite to the imagery server. */
const CONCURRENCY = 12;

export async function buildMosaic(range: TileRange, load: TileLoader): Promise<Mosaic> {
  const cols = range.tx1 - range.tx0 + 1;
  const rows = range.ty1 - range.ty0 + 1;
  const width = cols * TILE_SIZE;
  const height = rows * TILE_SIZE;
  const rgb = new Uint8ClampedArray(width * height * 3);
  const missing = new Array<boolean>(cols * rows).fill(false);

  const jobs: Array<{ tx: number; ty: number; slot: number }> = [];
  for (let ty = range.ty0; ty <= range.ty1; ty++) {
    for (let tx = range.tx0; tx <= range.tx1; tx++) {
      jobs.push({ tx, ty, slot: (ty - range.ty0) * cols + (tx - range.tx0) });
    }
  }

  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const job = jobs[next++];
      if (!job) return;
      let tile: Uint8ClampedArray | null = null;
      try {
        tile = await load(range.z, job.tx, job.ty);
      } catch {
        tile = null;
      }
      if (!tile) {
        missing[job.slot] = true;
        continue;
      }
      const ox = (job.tx - range.tx0) * TILE_SIZE;
      const oy = (job.ty - range.ty0) * TILE_SIZE;
      for (let r = 0; r < TILE_SIZE; r++) {
        const src = r * TILE_SIZE * 3;
        const dst = ((oy + r) * width + ox) * 3;
        rgb.set(tile.subarray(src, src + TILE_SIZE * 3), dst);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));

  return {
    width,
    height,
    originPx: [range.tx0 * TILE_SIZE, range.ty0 * TILE_SIZE],
    rgb,
    missing,
  };
}
