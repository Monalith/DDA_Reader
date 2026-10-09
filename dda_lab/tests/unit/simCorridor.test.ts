import { describe, expect, it } from 'vitest';
import { calibrateAsphalt, CorridorError, extractCorridor } from '../../src/sim/corridor';
import { TILE_SIZE, lngLatToPixel, metresPerPixel, SAT_ZOOM, type Mosaic } from '../../src/sim/tiles';
import type { LngLat, TrackModel } from '../../src/core/types';

/** A mosaic with a grey horizontal band (asphalt) on a green field. */
function bandMosaic(bandHalfPx: number): Mosaic {
  const width = TILE_SIZE;
  const height = TILE_SIZE;
  const rgb = new Uint8ClampedArray(width * height * 3);
  const mid = height / 2;
  for (let y = 0; y < height; y++) {
    const onBand = Math.abs(y - mid) <= bandHalfPx;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      if (onBand) {
        rgb[i] = 128; rgb[i + 1] = 130; rgb[i + 2] = 132; // grey, saturation ~0.03
      } else {
        rgb[i] = 60; rgb[i + 1] = 120; rgb[i + 2] = 50; // green, saturation ~0.58
      }
    }
  }
  return { width, height, originPx: [0, 0], rgb, missing: [false] };
}

describe('calibrateAsphalt', () => {
  it('derives thresholds that accept the band and reject the field', () => {
    const m = bandMosaic(12);
    const samples: Array<[number, number]> = [];
    for (let x = 10; x < 240; x += 10) samples.push([x, 128]);
    const cal = calibrateAsphalt(m, samples);
    expect(cal.satMax).toBeLessThan(0.2);
    expect(cal.valLo).toBeLessThan(129);
    expect(cal.valHi).toBeGreaterThan(129);
  });

  it('throws a typed error when there are no samples to calibrate from', () => {
    const m = bandMosaic(12);
    // assert the CODE, not the prose: the production path keys off `code`
    expect(() => calibrateAsphalt(m, [])).toThrowError(CorridorError);
    try {
      calibrateAsphalt(m, []);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as CorridorError).code).toBe('no-traces');
    }
  });
});

const LAT = 41.073;
const LNG = 23.518;

/**
 * A straight east-west track of known width, rendered into a synthetic mosaic,
 * with a matching TrackModel whose centerline runs down the middle of it.
 */
function straightTrack(widthM: number): { track: TrackModel; mosaic: Mosaic; trace: LngLat[] } {
  const mpp = metresPerPixel(LAT, SAT_ZOOM);
  const n = 120; // centerline vertices, 2 m apart
  const stepM = 2;
  const centerline: LngLat[] = [];
  // 2 m east per step, using the same local projection the extractor uses
  const mPerDegLng = 111320 * Math.cos((LAT * Math.PI) / 180);
  for (let i = 0; i < n; i++) centerline.push([LNG + (i * stepM) / mPerDegLng, LAT]);

  const origin = lngLatToPixel(centerline[0], SAT_ZOOM);
  const end = lngLatToPixel(centerline[n - 1], SAT_ZOOM);
  const pad = 200;
  const width = Math.ceil(Math.abs(end[0] - origin[0])) + pad * 2;
  const height = pad * 2;
  const originPx: [number, number] = [origin[0] - pad, origin[1] - pad];
  const rgb = new Uint8ClampedArray(width * height * 3);
  const halfPx = widthM / 2 / mpp;
  for (let y = 0; y < height; y++) {
    const onBand = Math.abs(y - (origin[1] - originPx[1])) <= halfPx;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      if (onBand) { rgb[i] = 128; rgb[i + 1] = 130; rgb[i + 2] = 132; }
      else { rgb[i] = 60; rgb[i + 1] = 120; rgb[i + 2] = 50; }
    }
  }

  const cumDistM = new Float64Array(n);
  for (let i = 1; i < n; i++) cumDistM[i] = cumDistM[i - 1] + stepM;
  const track: TrackModel = {
    id: 't', name: 'straight', center: centerline[0], centerline, cumDistM,
    lengthM: cumDistM[n - 1],
    startFinish: { id: 'sf', name: 'SF', type: 'sf', at: centerline[0], bearingDeg: 90, halfWidthM: 15 },
    sectors: [], turns: [],
  };
  return { track, mosaic: { width, height, originPx, rgb, missing: [false] }, trace: centerline };
}

describe('extractCorridor', () => {
  it('recovers a known track width to within half a metre', () => {
    const { track, mosaic, trace } = straightTrack(12);
    const c = extractCorridor(track, mosaic, trace);
    expect(c.leftM.length).toBe(track.centerline.length);
    const mid = Math.floor(c.leftM.length / 2);
    const widths: number[] = [];
    for (let i = mid - 20; i <= mid + 20; i++) widths.push(c.leftM[i] + c.rightM[i]);
    const median = widths.sort((a, b) => a - b)[Math.floor(widths.length / 2)];
    expect(median).toBeGreaterThan(11.5);
    expect(median).toBeLessThan(12.5);
  });

  it('rejects sections wider than the ceiling instead of reporting them', () => {
    const { track, mosaic, trace } = straightTrack(40); // wider than maxWidthM
    const c = extractCorridor(track, mosaic, trace, { maxWidthM: 18 });
    const mid = Math.floor(c.known.length / 2);
    expect(c.known[mid]).toBe(false);
  });

  it('marks sections over a missing tile as unknown rather than zero width', () => {
    const { track, mosaic, trace } = straightTrack(12);
    const holed: Mosaic = { ...mosaic, missing: [true] };
    const c = extractCorridor(track, holed, trace);
    expect(c.known.every((k) => k === false)).toBe(true);
  });

  it('throws no-traces when no GPS points are supplied', () => {
    const { track, mosaic } = straightTrack(12);
    expect(() => extractCorridor(track, mosaic, [])).toThrowError(/no-traces|asphalt/i);
  });
});
