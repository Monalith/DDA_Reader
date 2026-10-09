import { describe, expect, it } from 'vitest';
import { corridorGeoJson } from '../../src/ui/SimLayers';
import type { Corridor } from '../../src/sim/types';
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
