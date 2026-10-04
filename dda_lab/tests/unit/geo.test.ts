import { describe, expect, it } from 'vitest';
import {
  bearingDeg,
  cumulativeDistanceM,
  fromLocalM,
  haversineM,
  segmentCrossing,
  toLocalM,
} from '../../src/core/geo';
import type { Gate, LngLat } from '../../src/core/types';

const PARIS: LngLat = [2.3522, 48.8566];
const LONDON: LngLat = [-0.1276, 51.5074];

describe('haversineM', () => {
  it('Paris -> London is about 343.5 km', () => {
    const d = haversineM(PARIS, LONDON) / 1000;
    expect(d).toBeGreaterThan(342.5);
    expect(d).toBeLessThan(344.5);
  });

  it('is zero for identical points and symmetric', () => {
    expect(haversineM(PARIS, PARIS)).toBe(0);
    expect(haversineM(PARIS, LONDON)).toBeCloseTo(haversineM(LONDON, PARIS), 6);
  });

  it('one degree of latitude is about 111.2 km', () => {
    expect(haversineM([0, 0], [0, 1]) / 1000).toBeCloseTo(111.19, 1);
  });
});

describe('bearingDeg', () => {
  it('is 0 for due north, 90 for due east', () => {
    expect(bearingDeg([0, 0], [0, 1])).toBeCloseTo(0, 6);
    expect(bearingDeg([0, 0], [1, 0])).toBeCloseTo(90, 3);
    expect(bearingDeg([0, 0], [0, -1])).toBeCloseTo(180, 6);
    expect(bearingDeg([0, 0], [-1, 0])).toBeCloseTo(270, 3);
  });

  it('is always in [0,360)', () => {
    const b = bearingDeg([1, 1], [0.9, 0.95]);
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThan(360);
  });
});

describe('toLocalM / fromLocalM', () => {
  const origin: LngLat = [-122.4542, 38.1612];

  it('round-trips a point within a millimetre', () => {
    const p: LngLat = [-122.4502, 38.1655];
    const xy = toLocalM(origin, p);
    const back = fromLocalM(origin, xy);
    expect(back[0]).toBeCloseTo(p[0], 9);
    expect(back[1]).toBeCloseTo(p[1], 9);
  });

  it('agrees with haversine on short distances within 0.5 %', () => {
    const p: LngLat = [-122.4482, 38.1652];
    const [x, y] = toLocalM(origin, p);
    const local = Math.hypot(x, y);
    const hav = haversineM(origin, p);
    expect(Math.abs(local - hav) / hav).toBeLessThan(0.005);
  });

  it('puts the origin at 0,0 and east/north positive', () => {
    expect(toLocalM(origin, origin)).toEqual([0, 0]);
    expect(toLocalM(origin, [origin[0] + 0.001, origin[1]])[0]).toBeGreaterThan(0);
    expect(toLocalM(origin, [origin[0], origin[1] + 0.001])[1]).toBeGreaterThan(0);
  });
});

describe('cumulativeDistanceM', () => {
  it('sums leg lengths', () => {
    const lng = Float32Array.from([0, 0, 0]);
    const lat = Float32Array.from([0, 0.001, 0.002]);
    const c = cumulativeDistanceM(lng, lat);
    expect(c[0]).toBe(0);
    expect(c[1]).toBeCloseTo(111.19, 0);
    expect(c[2]).toBeCloseTo(222.38, 0);
  });

  it('holds the last value across NaN gaps', () => {
    const lng = Float32Array.from([0, NaN, 0]);
    const lat = Float32Array.from([0, NaN, 0.001]);
    const c = cumulativeDistanceM(lng, lat);
    expect(c[0]).toBe(0);
    expect(c[1]).toBe(0);
    expect(c[2]).toBeCloseTo(111.19, 0);
  });

  it('is NaN until the first valid fix', () => {
    const c = cumulativeDistanceM(Float32Array.from([NaN, 0]), Float32Array.from([NaN, 0]));
    expect(Number.isNaN(c[0])).toBe(true);
    expect(c[1]).toBe(0);
  });
});

describe('segmentCrossing', () => {
  // gate at the equator, track heading north, 20 m half width
  const gate: Gate = {
    id: 'sf', name: 'S/F', type: 'sf', at: [0, 0], bearingDeg: 0, halfWidthM: 20,
  };

  it('returns the crossing fraction when passing through the gate', () => {
    const f = segmentCrossing([0, -0.00005], [0, 0.00005], gate);
    expect(f).not.toBeNull();
    expect(f!).toBeCloseTo(0.5, 2);
  });

  it('returns null when the segment stays on one side', () => {
    expect(segmentCrossing([0, -0.0002], [0, -0.0001], gate)).toBeNull();
    expect(segmentCrossing([0, 0.0001], [0, 0.0002], gate)).toBeNull();
  });

  it('ignores crossings outside the half width', () => {
    // 100 m east of the gate centre (> 20 m half width)
    expect(segmentCrossing([0.0009, -0.00005], [0.0009, 0.00005], gate)).toBeNull();
  });

  it('ignores crossings in the wrong direction', () => {
    expect(segmentCrossing([0, 0.00005], [0, -0.00005], gate)).toBeNull();
  });

  it('is null for NaN input', () => {
    expect(segmentCrossing([NaN, NaN], [0, 0.00005], gate)).toBeNull();
  });
});
