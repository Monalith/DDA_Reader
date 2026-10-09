import { describe, expect, it } from 'vitest';
import { calibrateAsphalt, CorridorError, extractCorridor } from '../../src/sim/corridor';
import { TILE_SIZE, lngLatToPixel, metresPerPixel, SAT_ZOOM, type Mosaic } from '../../src/sim/tiles';
import type { LngLat, TrackModel } from '../../src/core/types';

const GREY: [number, number, number] = [128, 130, 132]; // saturation ~0.03
const GREEN: [number, number, number] = [60, 120, 50]; // saturation ~0.58

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
      // Small per-row variation inside the band so the calibration samples
      // are not 23 copies of one identical pixel — real asphalt isn't flat
      // either, and a test that cannot tell a varying sample from a constant
      // one cannot tell a correct percentile call from a broken one.
      const jitter = onBand ? (y % 3) - 1 : 0; // -1, 0, +1
      if (onBand) {
        rgb[i] = GREY[0] + jitter; rgb[i + 1] = GREY[1] + jitter; rgb[i + 2] = GREY[2] + jitter;
      } else {
        rgb[i] = GREEN[0]; rgb[i + 1] = GREEN[1]; rgb[i + 2] = GREEN[2];
      }
    }
  }
  return { width, height, originPx: [0, 0], rgb, missing: [false] };
}

function sv(rgb: [number, number, number]): [number, number] {
  const [r, g, b] = rgb;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  return [mx > 0 ? (mx - mn) / mx : 0, (r + g + b) / 3];
}

describe('calibrateAsphalt', () => {
  it('derives thresholds that accept the band and reject the field', () => {
    const m = bandMosaic(12);
    // Sample across several rows (not 23 copies of the same pixel) so the
    // band's natural variation actually informs the percentiles.
    const samples: Array<[number, number]> = [];
    for (let y = 118; y <= 138; y++) {
      for (let x = 10; x < 240; x += 20) samples.push([x, y]);
    }
    const cal = calibrateAsphalt(m, samples);
    expect(cal.satMax).toBeLessThan(0.2);
    expect(cal.valLo).toBeLessThan(129);
    expect(cal.valHi).toBeGreaterThan(129);

    // The test's own name promises the field is rejected, not just that the
    // band is accepted — assert it against the thresholds just returned.
    const [fieldSat, fieldVal] = sv(GREEN);
    const rejected = fieldSat > cal.satMax || fieldVal < cal.valLo || fieldVal > cal.valHi;
    expect(rejected).toBe(true);
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

/** Shared geometry for an eastward straight track rendered into a mosaic. */
function straightGeometry() {
  const mpp = metresPerPixel(LAT, SAT_ZOOM);
  const n = 120; // centerline vertices, 2 m apart
  const stepM = 2;
  const centerline: LngLat[] = [];
  const mPerDegLng = 111320 * Math.cos((LAT * Math.PI) / 180);
  for (let i = 0; i < n; i++) centerline.push([LNG + (i * stepM) / mPerDegLng, LAT]);

  const origin = lngLatToPixel(centerline[0], SAT_ZOOM);
  const end = lngLatToPixel(centerline[n - 1], SAT_ZOOM);
  const pad = 200;
  const width = Math.ceil(Math.abs(end[0] - origin[0])) + pad * 2;
  const height = pad * 2;
  const originPx: [number, number] = [origin[0] - pad, origin[1] - pad];
  const centerRow = origin[1] - originPx[1];

  const cumDistM = new Float64Array(n);
  for (let i = 1; i < n; i++) cumDistM[i] = cumDistM[i - 1] + stepM;
  const track: TrackModel = {
    id: 't', name: 'straight', center: centerline[0], centerline, cumDistM,
    lengthM: cumDistM[n - 1],
    startFinish: { id: 'sf', name: 'SF', type: 'sf', at: centerline[0], bearingDeg: 90, halfWidthM: 15 },
    sectors: [], turns: [],
  };
  return { mpp, n, width, height, originPx, centerRow, track, trace: centerline };
}

/**
 * A straight east-west track of known width, rendered into a synthetic mosaic,
 * with a matching TrackModel whose centerline runs down the middle of it.
 */
function straightTrack(widthM: number): { track: TrackModel; mosaic: Mosaic; trace: LngLat[] } {
  const { mpp, width, height, originPx, centerRow, track, trace } = straightGeometry();
  const rgb = new Uint8ClampedArray(width * height * 3);
  const halfPx = widthM / 2 / mpp;
  for (let y = 0; y < height; y++) {
    const onBand = Math.abs(y - centerRow) <= halfPx;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      if (onBand) { rgb[i] = GREY[0]; rgb[i + 1] = GREY[1]; rgb[i + 2] = GREY[2]; }
      else { rgb[i] = GREEN[0]; rgb[i + 1] = GREEN[1]; rgb[i + 2] = GREEN[2]; }
    }
  }
  return { track, mosaic: { width, height, originPx, rgb, missing: [false] }, trace };
}

/**
 * A straight east-west track with different widths either side of the
 * centerline. For eastward travel, "left" (first search direction in the
 * implementation) is the north side — smaller pixel row — and "right" is
 * south — larger pixel row.
 */
function asymmetricTrack(
  leftM: number,
  rightM: number,
): { track: TrackModel; mosaic: Mosaic; trace: LngLat[] } {
  const { mpp, width, height, originPx, centerRow, track, trace } = straightGeometry();
  const rgb = new Uint8ClampedArray(width * height * 3);
  const leftPx = leftM / mpp;
  const rightPx = rightM / mpp;
  for (let y = 0; y < height; y++) {
    const dy = y - centerRow; // negative = north (left), positive = south (right)
    const onBand = dy >= -leftPx && dy <= rightPx;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      if (onBand) { rgb[i] = GREY[0]; rgb[i + 1] = GREY[1]; rgb[i + 2] = GREY[2]; }
      else { rgb[i] = GREEN[0]; rgb[i + 1] = GREEN[1]; rgb[i + 2] = GREEN[2]; }
    }
  }
  return { track, mosaic: { width, height, originPx, rgb, missing: [false] }, trace };
}

/**
 * A symmetric 12 m-wide track with a non-grey stripe cutting across the
 * right (south) half of the band, `stripeWidthPx` pixels wide, starting 3 m
 * from the centerline. A thin stripe should be bridged by `gapTolerance`; a
 * wide one should truncate the edge at the stripe.
 */
function stripedTrack(stripeWidthPx: number): { track: TrackModel; mosaic: Mosaic; trace: LngLat[] } {
  const { mpp, width, height, originPx, centerRow, track, trace } = straightGeometry();
  const rgb = new Uint8ClampedArray(width * height * 3);
  const halfPx = 6 / mpp; // 6 m either side, 12 m total
  const stripeStartPx = 3 / mpp; // 3 m from centerline, well inside the band
  for (let y = 0; y < height; y++) {
    const dy = y - centerRow;
    const onBand = dy >= -halfPx && dy <= halfPx;
    const onStripe = dy >= stripeStartPx && dy < stripeStartPx + stripeWidthPx;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      if (onBand && !onStripe) { rgb[i] = GREY[0]; rgb[i + 1] = GREY[1]; rgb[i + 2] = GREY[2]; }
      else { rgb[i] = GREEN[0]; rgb[i + 1] = GREEN[1]; rgb[i + 2] = GREEN[2]; }
    }
  }
  return { track, mosaic: { width, height, originPx, rgb, missing: [false] }, trace };
}

/**
 * A straight 12 m track where `leakCount` consecutive vertices, centred in
 * the middle of the run, have their right edge extended out to `leakM`
 * metres instead of the normal 6 m — a short, narrow leak rather than a wide
 * systematic one.
 */
function leakyRightTrack(
  leakCount: number,
  leakM: number,
): { track: TrackModel; mosaic: Mosaic; trace: LngLat[]; leakStart: number } {
  const { mpp, n, width, height, originPx, centerRow, track, trace } = straightGeometry();
  const rgb = new Uint8ClampedArray(width * height * 3);
  const halfPx = 6 / mpp; // normal 12 m band (6 m either side)
  const leakPx = leakM / mpp;
  const leakStart = Math.floor(n / 2) - Math.floor(leakCount / 2);
  const x0 = lngLatToPixel(track.centerline[leakStart], SAT_ZOOM)[0] - originPx[0];
  const x1 = lngLatToPixel(track.centerline[leakStart + leakCount - 1], SAT_ZOOM)[0] - originPx[0];
  for (let y = 0; y < height; y++) {
    const dy = y - centerRow; // negative = north (left), positive = south (right)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const leaking = x >= x0 - 1 && x <= x1 + 1;
      const rightHalfPx = leaking ? leakPx : halfPx;
      const onBand = dy >= -halfPx && dy <= rightHalfPx;
      if (onBand) { rgb[i] = GREY[0]; rgb[i + 1] = GREY[1]; rgb[i + 2] = GREY[2]; }
      else { rgb[i] = GREEN[0]; rgb[i + 1] = GREEN[1]; rgb[i + 2] = GREEN[2]; }
    }
  }
  return { track, mosaic: { width, height, originPx, rgb, missing: [false] }, trace, leakStart };
}

/** Median of a window of indices centred at `mid`, wrapping is not needed here. */
function windowMedian(arr: Float32Array, mid: number, half: number): number {
  const vals: number[] = [];
  for (let i = mid - half; i <= mid + half; i++) vals.push(arr[i]);
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length / 2)];
}

describe('extractCorridor', () => {
  it('recovers a known track width to within half a metre, with known[] true across the span', () => {
    const { track, mosaic, trace } = straightTrack(12);
    const c = extractCorridor(track, mosaic, trace);
    expect(c.leftM.length).toBe(track.centerline.length);
    const mid = Math.floor(c.leftM.length / 2);
    const widths: number[] = [];
    for (let i = mid - 20; i <= mid + 20; i++) {
      widths.push(c.leftM[i] + c.rightM[i]);
      expect(c.known[i]).toBe(true);
    }
    const median = widths.sort((a, b) => a - b)[Math.floor(widths.length / 2)];
    expect(median).toBeGreaterThan(11.5);
    expect(median).toBeLessThan(12.5);
  });

  it('keeps left and right distinct for an asymmetric track (no mirror)', () => {
    const { track, mosaic, trace } = asymmetricTrack(4, 9);
    const c = extractCorridor(track, mosaic, trace);
    const mid = Math.floor(c.leftM.length / 2);
    const left = windowMedian(c.leftM, mid, 20);
    const right = windowMedian(c.rightM, mid, 20);
    expect(left).toBeGreaterThan(4 - 0.75);
    expect(left).toBeLessThan(4 + 0.75);
    expect(right).toBeGreaterThan(9 - 0.75);
    expect(right).toBeLessThan(9 + 0.75);
  });

  it('swaps left and right when the centerline direction is reversed', () => {
    // Pins "left means left of travel, not left on the map": the same
    // mosaic, walked the other way, must report the widths swapped.
    const { track, mosaic, trace } = asymmetricTrack(4, 9);
    const reversed: TrackModel = { ...track, centerline: [...track.centerline].reverse() };
    const c = extractCorridor(reversed, mosaic, trace);
    const mid = Math.floor(c.leftM.length / 2);
    const left = windowMedian(c.leftM, mid, 20);
    const right = windowMedian(c.rightM, mid, 20);
    expect(left).toBeGreaterThan(9 - 0.75);
    expect(left).toBeLessThan(9 + 0.75);
    expect(right).toBeGreaterThan(4 - 0.75);
    expect(right).toBeLessThan(4 + 0.75);
  });

  it('bridges a thin gap inside the band but truncates at a wide one', () => {
    const { track, mosaic, trace } = stripedTrack(2); // ~0.9 m, within gapTolerance (~2 m)
    const c = extractCorridor(track, mosaic, trace);
    const mid = Math.floor(c.rightM.length / 2);
    const rightBridged = windowMedian(c.rightM, mid, 20);
    // bridged: the edge reaches past the stripe to the far edge of the band (~6 m)
    expect(rightBridged).toBeGreaterThan(5);

    const wide = stripedTrack(10); // ~4.5 m, beyond gapTolerance (~2 m)
    const c2 = extractCorridor(wide.track, wide.mosaic, wide.trace);
    const rightTruncated = windowMedian(c2.rightM, mid, 20);
    // truncated: the edge stops at the stripe, ~3 m from the centerline
    expect(rightTruncated).toBeLessThan(4);
    expect(rightTruncated).toBeGreaterThan(2);
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

  it('rejects a spurious wide reading the median filter would smooth into range', () => {
    // A short run of vertices sees the right edge leak out to ~20 m (e.g. the
    // search escaping across an infield at a hairpin), surrounded on both
    // sides by an ordinary 12 m band. The leak is narrow enough (5 of 120
    // vertices) that the 15-wide median filter smooths it back into a
    // plausible width — that smoothing is real and wanted for leftM/rightM.
    // known[] must NOT be fooled by it: a vertex is only known if the RAW
    // reading also passes the same checks, and raw right ~20 m pushes the
    // raw total past maxWidthM (18).
    const leakCount = 5;
    const { track, mosaic, trace, leakStart } = leakyRightTrack(leakCount, 20);
    const c = extractCorridor(track, mosaic, trace);

    const midLeak = leakStart + Math.floor(leakCount / 2);
    // the bug this guards against: the filtered width at the leak looks fine
    expect(c.leftM[midLeak] + c.rightM[midLeak]).toBeLessThan(18);
    // but known[] must see through the smoothing to the raw leak
    for (let i = leakStart; i < leakStart + leakCount; i++) {
      expect(c.known[i]).toBe(false);
    }
    // well away from the leak (outside the filter's +-7 window), the track
    // stays known — the raw gate must not be so strict it blankets everything
    expect(c.known[10]).toBe(true);
    expect(c.known[100]).toBe(true);
  });
});
