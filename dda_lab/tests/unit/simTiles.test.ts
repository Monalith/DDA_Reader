import { describe, expect, it } from 'vitest';
import { lngLatToPixel, metresPerPixel, pixelToLngLat, SAT_ZOOM, tileRangeFor } from '../../src/sim/tiles';
import type { LngLat } from '../../src/core/types';

const SERRES: LngLat = [23.51802, 41.0730586];

describe('tiles', () => {
  it('round-trips lng/lat through pixel space', () => {
    const px = lngLatToPixel(SERRES, SAT_ZOOM);
    const back = pixelToLngLat(px, SAT_ZOOM);
    expect(back[0]).toBeCloseTo(SERRES[0], 9);
    expect(back[1]).toBeCloseTo(SERRES[1], 9);
  });

  it('gives 0.45 m/px at z18 at the Serres latitude', () => {
    // 156543.03392 * cos(41.073) / 2^18
    expect(metresPerPixel(SERRES[1], SAT_ZOOM)).toBeCloseTo(0.45, 2);
  });

  it('covers every point, with padding, in the tile range', () => {
    const pts: LngLat[] = [SERRES, [23.525, 41.078], [23.512, 41.069]];
    const r = tileRangeFor(pts, SAT_ZOOM, 60);
    for (const p of pts) {
      const [x, y] = lngLatToPixel(p, SAT_ZOOM);
      expect(Math.floor(x / 256)).toBeGreaterThanOrEqual(r.tx0);
      expect(Math.floor(x / 256)).toBeLessThanOrEqual(r.tx1);
      expect(Math.floor(y / 256)).toBeGreaterThanOrEqual(r.ty0);
      expect(Math.floor(y / 256)).toBeLessThanOrEqual(r.ty1);
    }
  });
});

import { buildMosaic, TILE_SIZE, type TileLoader } from '../../src/sim/tiles';

function solidTile(r: number, g: number, b: number): Uint8ClampedArray {
  const a = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 3);
  for (let i = 0; i < TILE_SIZE * TILE_SIZE; i++) {
    a[i * 3] = r;
    a[i * 3 + 1] = g;
    a[i * 3 + 2] = b;
  }
  return a;
}

describe('buildMosaic', () => {
  const range = { tx0: 10, tx1: 11, ty0: 20, ty1: 20, z: 18 };

  it('stitches tiles side by side at the right offsets', async () => {
    const load: TileLoader = async (_z, x) => solidTile(x === 10 ? 10 : 200, 0, 0);
    const m = await buildMosaic(range, load);
    expect(m.width).toBe(TILE_SIZE * 2);
    expect(m.height).toBe(TILE_SIZE);
    expect(m.originPx).toEqual([10 * TILE_SIZE, 20 * TILE_SIZE]);
    expect(m.rgb[0]).toBe(10); // left tile
    expect(m.rgb[TILE_SIZE * 3]).toBe(200); // first pixel of the right tile
    expect(m.missing.some(Boolean)).toBe(false);
  });

  it('flags tiles that failed to load instead of leaving silent black', async () => {
    const load: TileLoader = async (_z, x) => (x === 11 ? null : solidTile(10, 0, 0));
    const m = await buildMosaic(range, load);
    expect(m.missing[0]).toBe(false);
    expect(m.missing[1]).toBe(true);
  });
});
