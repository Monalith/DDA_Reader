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

/**
 * A pit lane: a straight `mainWidthM`-wide asphalt band, and — over
 * `leakCount` consecutive vertices — a SECOND, parallel strip of real asphalt
 * offset to the right (south) side, separated from the main band by
 * `gapM` metres of grass. This is the Serres failure mode: the gap is narrow
 * enough for `gapTolerance` to bridge, so the perpendicular search walks
 * across it and records the far edge of the parallel strip as "the track
 * edge" — real asphalt, in the right direction, at a plausible-looking
 * distance, on a dead straight piece of track.
 *
 * Nothing already in the extractor catches this: it is straight (no
 * curvature cap engages), the leak is far longer than the 15-wide median
 * window (no raw-vs-filtered spike), and the resulting width lands just
 * under the 18 m absolute ceiling.
 *
 * `leakCount` is deliberately a MAJORITY of the vertices, mirroring what the
 * real circuit's numbers show: by the time you measure it, the leak has
 * already contaminated the median, so a gate anchored on the median cannot
 * see it. Only a lower-quantile (or equivalently robust) anchor can.
 */
function pitLaneTrack(
  leakCount: number,
  mainWidthM = 13,
  gapM = 1.5,
  stripWidthM = 2.5,
): { track: TrackModel; mosaic: Mosaic; trace: LngLat[]; leakStart: number } {
  const { mpp, n, width, height, originPx, centerRow, track, trace } = straightGeometry();
  const rgb = new Uint8ClampedArray(width * height * 3);
  const halfM = mainWidthM / 2;
  const stripInnerM = halfM + gapM;
  const stripOuterM = stripInnerM + stripWidthM;
  const leakStart = Math.floor((n - leakCount) / 2);
  const x0 = lngLatToPixel(track.centerline[leakStart], SAT_ZOOM)[0] - originPx[0];
  const x1 = lngLatToPixel(track.centerline[leakStart + leakCount - 1], SAT_ZOOM)[0] - originPx[0];
  for (let y = 0; y < height; y++) {
    const dyM = (y - centerRow) * mpp; // negative = north (left), positive = south (right)
    const onMain = dyM >= -halfM && dyM <= halfM;
    const onStrip = dyM >= stripInnerM && dyM <= stripOuterM;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const leaking = x >= x0 - 1 && x <= x1 + 1;
      const asphalt = onMain || (leaking && onStrip);
      if (asphalt) { rgb[i] = GREY[0]; rgb[i + 1] = GREY[1]; rgb[i + 2] = GREY[2]; }
      else { rgb[i] = GREEN[0]; rgb[i + 1] = GREEN[1]; rgb[i + 2] = GREEN[2]; }
    }
  }
  return { track, mosaic: { width, height, originPx, rgb, missing: [false] }, trace, leakStart };
}

/**
 * A hairpin: a straight leg of length `legM` at y=+r, a semicircular turn of
 * radius `r` around (legM, 0), continuing into a second straight leg at
 * y=-r heading back the way it came. Pavement is a normal `wM`-half-width
 * tube around this centerline, PLUS a paved strip (representing a paved
 * apex/kerb at the inside of the corner) spanning |x - legM| <= bridgeHalfM,
 * full height — i.e. a real, continuously paved connection across the
 * throat of the hairpin between the two legs, not a thin grass gap the
 * existing gapTolerance mechanic already bridges elsewhere.
 *
 * At r=10, wM=2.5, bridgeHalfM=8 the true single-leg width is 5 m; without a
 * curvature cap on the search, the vertices just into the turn can reach
 * across the paved strip to the far side (~18-19 m), which exceeds
 * maxWidthM and gets rejected outright — but it is rejected for having
 * walked into the wrong leg's pavement, not for being a sane reading. With
 * the cap, the same vertices see a smaller (if still slightly elevated by
 * the edge of the strip), still-plausible, still-WRONG-direction width —
 * which is why this fixture alone cannot tell "capped" from "correct"; the
 * test asserts the specific reduction the cap produces, not a pristine
 * reading, and the mutation check below confirms it is actually gated by
 * the cap.
 */
function hairpinTrack(
  r: number,
  wM: number,
  legM: number,
  stepM: number,
  bridgeHalfM: number,
): { track: TrackModel; mosaic: Mosaic; trace: LngLat[]; arcStart: number } {
  const mPerDegLng = 111320 * Math.cos((LAT * Math.PI) / 180);
  const mPerDegLat = 111320;
  const toLngLat = (x: number, y: number): LngLat => [LNG + x / mPerDegLng, LAT + y / mPerDegLat];

  const pts: Array<[number, number]> = [];
  const nStraight = Math.max(2, Math.round(legM / stepM));
  for (let i = 0; i < nStraight; i++) pts.push([(i / nStraight) * legM, r]);
  const arcStart = pts.length;
  const nArc = Math.max(8, Math.round((Math.PI * r) / stepM));
  for (let i = 0; i <= nArc; i++) {
    const a = (Math.PI * i) / nArc;
    pts.push([legM + r * Math.sin(a), r * Math.cos(a)]);
  }
  for (let i = 1; i <= nStraight; i++) pts.push([legM - (i / nStraight) * legM, -r]);

  const centerline: LngLat[] = pts.map(([x, y]) => toLngLat(x, y));
  const cum = new Float64Array(centerline.length);
  for (let i = 1; i < centerline.length; i++) cum[i] = cum[i - 1] + stepM;
  const lengthM = cum[cum.length - 1];
  const track: TrackModel = {
    id: 't', name: 'hairpin', center: centerline[0], centerline, cumDistM: cum, lengthM,
    startFinish: { id: 'sf', name: 'SF', type: 'sf', at: centerline[0], bearingDeg: 0, halfWidthM: 15 },
    sectors: [], turns: [],
  };

  const pad = 15;
  const xMin = -pad;
  const xMax = legM + r + pad;
  const yMin = -(r + wM + pad);
  const yMax = r + wM + pad;
  const originPx = lngLatToPixel(toLngLat(xMin, yMax), SAT_ZOOM);
  const brPx = lngLatToPixel(toLngLat(xMax, yMin), SAT_ZOOM);
  const width = Math.ceil(brPx[0] - originPx[0]);
  const height = Math.ceil(brPx[1] - originPx[1]);
  const rgb = new Uint8ClampedArray(width * height * 3).fill(0);
  for (let i = 0; i < width * height; i++) {
    rgb[i * 3] = GREEN[0]; rgb[i * 3 + 1] = GREEN[1]; rgb[i * 3 + 2] = GREEN[2];
  }

  const distToPolyline = (x: number, y: number): number => {
    let best = Infinity;
    for (const [px, py] of pts) {
      const d = Math.hypot(x - px, y - py);
      if (d < best) best = d;
    }
    return best;
  };
  for (let yy = yMin; yy <= yMax; yy += 0.5) {
    for (let xx = xMin; xx <= xMax; xx += 0.5) {
      const onTrack = distToPolyline(xx, yy) <= wM || Math.abs(xx - legM) <= bridgeHalfM;
      if (!onTrack) continue;
      const [px0, py0] = lngLatToPixel(toLngLat(xx, yy), SAT_ZOOM);
      const px = Math.round(px0 - originPx[0]);
      const py = Math.round(py0 - originPx[1]);
      if (px < 0 || py < 0 || px >= width || py >= height) continue;
      const i = (py * width + px) * 3;
      rgb[i] = GREY[0]; rgb[i + 1] = GREY[1]; rgb[i + 2] = GREY[2];
    }
  }

  const mosaic: Mosaic = { width, height, originPx: [originPx[0], originPx[1]], rgb, missing: [false] };
  return { track, mosaic, trace: centerline, arcStart };
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

  it('caps the search by local curvature so a hairpin cannot reach the opposite leg', () => {
    // r=10, wM=2.5 (5 m wide), with a paved strip connecting the two legs
    // across the throat of the turn. The true single-leg width is 5 m;
    // without a curvature cap, the search at the vertices just into the
    // turn walks straight across the paved strip and finds the far side,
    // ~18-19 m out — past maxWidthM, so it comes back unknown for having
    // reached the wrong leg's pavement, not for being a sane reading.
    const { track, mosaic, trace, arcStart } = hairpinTrack(10, 2.5, 60, 2, 8);
    const c = extractCorridor(track, mosaic, trace);
    const i = arcStart + 3; // just into the turn, past the straight/arc stencil blend

    // the own (outer) side is unaffected by the cap either way
    expect(c.leftM[i]).toBeGreaterThan(2);
    expect(c.leftM[i]).toBeLessThan(5);
    // the capped search into the paved strip is bounded well short of the
    // ~18-19 m an uncapped search finds — this is the cap's own effect, and
    // it is what this test pins
    expect(c.rightM[i]).toBeGreaterThan(5);
    expect(c.rightM[i]).toBeLessThan(12);
    // ...but the reading is still in the WRONG direction (as this fixture's
    // own doc comment says), and 3.5 + 9.5 = 13 m on a circuit whose own
    // typical width is 5 m is a 2.6x outlier, so the width-distribution gate
    // now — correctly — refuses to call this vertex resolved. It used to
    // assert `true` here, back when the curvature cap was the last gate;
    // honest unknown is the better answer for a reading nobody claims is
    // right.
    expect(c.known[i]).toBe(false);

    // well away from the turn, on the ordinary straight, nothing changed
    expect(c.known[5]).toBe(true);
    expect(c.leftM[5] + c.rightM[5]).toBeCloseTo(5, 0);
  });


  it('rejects a parallel pit lane as an outlier against the circuit own width', () => {
    // 13 m main band; over 70 of 120 vertices a parallel 2.5 m asphalt strip
    // sits 1.5 m of grass away on the right. The search bridges the grass
    // (1.5 m < gapTolerance's 2 m) and reports the strip's far edge, giving
    // a ~17 m width on dead-straight track — under the 18 m ceiling, longer
    // than the median window, zero curvature. Only a self-calibrating gate
    // against this circuit's own typical width can see it.
    const leakCount = 70;
    const { track, mosaic, trace, leakStart } = pitLaneTrack(leakCount);
    const c = extractCorridor(track, mosaic, trace);

    const mid = leakStart + Math.floor(leakCount / 2);
    const leakWidth = c.leftM[mid] + c.rightM[mid];

    // The scenario must be a real one, not a strawman: assert the leak
    // actually happens (the search reached past the grass to the strip) and
    // that the existing absolute ceiling does NOT catch it.
    expect(leakWidth).toBeGreaterThan(15);
    expect(leakWidth).toBeLessThanOrEqual(18);
    // ...and that the leak is the MAJORITY, so the median is contaminated —
    // which is why the gate cannot be anchored on the median.
    const allWidths = Array.from(c.leftM, (l, i) => l + c.rightM[i]).sort((a, b) => a - b);
    expect(allWidths[allWidths.length >> 1]).toBeGreaterThan(15);

    // Every vertex in the interior of the leak run (clear of the median
    // filter's +-7 blend at each end) must come back unknown.
    for (let i = leakStart + 8; i <= leakStart + leakCount - 9; i++) {
      expect(c.known[i]).toBe(false);
    }

    // Ordinary 13 m vertices well clear of the leak stay known — the gate
    // must not be a blanket rejection.
    for (const i of [10, 110]) {
      expect(c.known[i]).toBe(true);
      expect(c.leftM[i] + c.rightM[i]).toBeGreaterThan(12);
      expect(c.leftM[i] + c.rightM[i]).toBeLessThan(14);
    }
  });
});
