import { describe, expect, it } from 'vitest';
import { cornerEventsGeoJson, corridorGeoJson } from '../../src/ui/SimLayers';
import type { Corner, Corridor, Line } from '../../src/sim/types';
import { rangeValue } from '../../src/ui/panels/simRange';
import type { LngLat, TrackModel } from '../../src/core/types';

const CL: LngLat[] = [[23.5, 41.0], [23.5, 41.0005], [23.5, 41.001], [23.5, 41.0015]];

function mkTrack(): TrackModel {
  const cum = new Float64Array([0, 55, 110, 165]);
  return {
    id: 't', name: 'n', center: CL[0], centerline: CL, cumDistM: cum, lengthM: 165,
    startFinish: { id: 'sf', name: 'SF', type: 'sf', at: CL[0], bearingDeg: 0, halfWidthM: 15 },
    sectors: [], turns: [],
  };
}

describe('corridorGeoJson', () => {
  it('emits one left and one right line, offset to either side of the centerline', () => {
    const c: Corridor = {
      stepM: 55,
      leftM: Float32Array.from([6, 6, 6, 6]),
      rightM: Float32Array.from([6, 6, 6, 6]),
      known: [true, true, true, true],
    };
    const fc = corridorGeoJson(mkTrack(), c);
    expect(fc.features).toHaveLength(2);
    const left = fc.features.find((f) => f.properties.side === 'left')!;
    const right = fc.features.find((f) => f.properties.side === 'right')!;
    // the track runs north, so left is west (smaller lng) and right is east
    expect(left.geometry.coordinates[1][0]).toBeLessThan(23.5);
    expect(right.geometry.coordinates[1][0]).toBeGreaterThan(23.5);
  });

  it('breaks the line where the corridor is unknown rather than drawing through it', () => {
    const c: Corridor = {
      stepM: 55,
      leftM: Float32Array.from([6, 6, 6, 6]),
      rightM: Float32Array.from([6, 6, 6, 6]),
      known: [true, false, true, true],
    };
    const fc = corridorGeoJson(mkTrack(), c);
    const left = fc.features.filter((f) => f.properties.side === 'left');
    expect(left.length).toBeGreaterThan(1); // split into separate segments
  });
});

describe('rangeValue (sim panel sliders)', () => {
  it('snaps an off-grid value onto the slider step', () => {
    expect(rangeValue(1.2411639, 0.2, 1.8, 0.01)).toBe(1.24);
    expect(rangeValue(0.691, 0.4, 1.0, 0.005)).toBe(0.69);
    expect(rangeValue(0.5, 0, 1, 0.01)).toBe(0.5);
  });
  it('clamps to the range and maps NaN to the minimum', () => {
    expect(rangeValue(5, 0, 1, 0.01)).toBe(1);
    expect(rangeValue(-5, 0.1, 1, 0.01)).toBe(0.1);
    expect(rangeValue(Number.NaN, 0.5, 1, 0.01)).toBe(0.5);
  });
});

describe('cornerEventsGeoJson', () => {
  const pts: LngLat[] = Array.from({ length: 40 }, (_, i) => [23.5 + i * 1e-4, 41.0] as LngLat);
  const line: Line = {
    points: pts,
    curvature: new Float32Array(40),
    cumDistM: Float64Array.from(pts, (_, i) => i * 8),
    lengthM: 320,
    offsetM: new Float32Array(40),
  };
  const corner = (over: Partial<Corner> = {}): Corner => ({
    iB: 2, iT: 5, iA: 9, iAgeo: 10, iP: 12, iE: 16, dir: 1, hasBrake: true, flips: [], ...over,
  });

  it('emits B, T, A, P and E at the corner indices, numbered and with the direction', () => {
    const fc = cornerEventsGeoJson(line, [corner(), corner({ iB: 20, iT: 22, iA: 25, iAgeo: 25, iP: 27, iE: 30, dir: -1 })]);
    expect(fc.features).toHaveLength(10);
    const first = fc.features.filter((f) => f.properties.corner === 1);
    expect(first.map((f) => f.properties.kind)).toEqual(['B', 'T', 'A', 'P', 'E']);
    const at = (k: string) => first.find((f) => f.properties.kind === k)!.geometry.coordinates;
    expect(at('B')).toEqual(pts[2]);
    expect(at('A')).toEqual(pts[9]);
    expect(at('E')).toEqual(pts[16]);
    expect(fc.features.find((f) => f.properties.corner === 2)!.properties.dir).toBe(-1);
  });

  it('has no brake marker for a corner taken without braking', () => {
    const fc = cornerEventsGeoJson(line, [corner({ hasBrake: false, iB: 5 })]);
    expect(fc.features.map((f) => f.properties.kind)).toEqual(['T', 'A', 'P', 'E']);
  });

  it('skips indices outside the line and is empty without corners', () => {
    expect(cornerEventsGeoJson(line, []).features).toHaveLength(0);
    expect(cornerEventsGeoJson(line, undefined).features).toHaveLength(0);
    const fc = cornerEventsGeoJson(line, [corner({ iE: 99 })]);
    expect(fc.features.map((f) => f.properties.kind)).toEqual(['B', 'T', 'A', 'P']);
  });
});
