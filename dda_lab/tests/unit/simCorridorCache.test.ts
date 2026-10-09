import { describe, expect, it } from 'vitest';
import { corridorKey, deserializeCorridor, serializeCorridor } from '../../src/sim/corridorCache';
import type { Corridor } from '../../src/sim/types';
import type { LngLat, TrackModel } from '../../src/core/types';

function mkTrack(centerline: LngLat[], lengthM: number, id = 't1'): TrackModel {
  const cum = new Float64Array(centerline.length);
  for (let i = 1; i < centerline.length; i++) cum[i] = (i * lengthM) / (centerline.length - 1);
  return {
    id, name: 'x', center: centerline[0], centerline, cumDistM: cum, lengthM,
    startFinish: { id: 'sf', name: 'SF', type: 'sf', at: centerline[0], bearingDeg: 0, halfWidthM: 15 },
    sectors: [], turns: [],
  };
}

const CL: LngLat[] = [[23.5, 41.0], [23.501, 41.0], [23.502, 41.0], [23.503, 41.0]];
const corridor: Corridor = {
  stepM: 2,
  leftM: Float32Array.from([5, 5, 6, 6]),
  rightM: Float32Array.from([5, 5, 4, 4]),
  known: [true, true, true, false],
};

describe('corridor cache', () => {
  it('round-trips a corridor', () => {
    const t = mkTrack(CL, 6);
    const back = deserializeCorridor(t, serializeCorridor(t, corridor));
    expect(back).not.toBeNull();
    expect(Array.from(back!.leftM)).toEqual([5, 5, 6, 6]);
    expect(back!.known).toEqual([true, true, true, false]);
  });

  it('rejects a cache whose point count no longer matches', () => {
    const t = mkTrack(CL, 6);
    const raw = serializeCorridor(t, corridor);
    const shorter = mkTrack(CL.slice(0, 3), 4);
    expect(deserializeCorridor(shorter, raw)).toBeNull();
  });

  it('rejects a cache taken before the start line moved', () => {
    // setStartLine -> normalizeTrackOrigin rotates the centerline, so the same
    // vertices now begin at a different point and the offsets no longer line up.
    const t = mkTrack(CL, 6);
    const raw = serializeCorridor(t, corridor);
    const rotated = mkTrack([...CL.slice(2), ...CL.slice(0, 2)], 6);
    expect(deserializeCorridor(rotated, raw)).toBeNull();
  });

  it('rejects malformed input instead of throwing', () => {
    const t = mkTrack(CL, 6);
    expect(deserializeCorridor(t, null)).toBeNull();
    expect(deserializeCorridor(t, { version: 99 })).toBeNull();
  });

  it('rejects a non-numeric firstPoint instead of treating NaN as "close enough"', () => {
    const t = mkTrack(CL, 6);
    const raw = { ...serializeCorridor(t, corridor), firstPoint: ['a', 'b'] };
    expect(deserializeCorridor(t, raw)).toBeNull();
  });

  it('rejects non-numeric offset arrays instead of producing a NaN corridor', () => {
    const t = mkTrack(CL, 6);
    const raw = { ...serializeCorridor(t, corridor), leftM: ['x', 'y', 'z', 'w'] };
    expect(deserializeCorridor(t, raw)).toBeNull();
  });

  it('coerces a known array of non-booleans instead of lying about its type', () => {
    const t = mkTrack(CL, 6);
    const raw = { ...serializeCorridor(t, corridor), known: [1, 0, 1, 0] };
    const back = deserializeCorridor(t, raw);
    expect(back).not.toBeNull();
    expect(back!.known).toEqual([true, false, true, false]);
    expect(back!.known.every((v) => typeof v === 'boolean')).toBe(true);
  });
});

describe('corridorKey', () => {
  it('is geographic and stable, not the runtime track id', () => {
    const a = mkTrack(CL, 6, 'runtime-id-1');
    const b = mkTrack(CL, 6, 'runtime-id-2');
    expect(corridorKey(a)).toBe(corridorKey(b));
  });

  it('separates tracks that are far apart', () => {
    const serres = mkTrack(CL, 6);
    const elsewhere = mkTrack([[29.0, 41.0], [29.001, 41.0], [29.002, 41.0], [29.003, 41.0]], 6);
    expect(corridorKey(serres)).not.toBe(corridorKey(elsewhere));
  });

  it('only ever produces characters the server will accept', () => {
    const weird = mkTrack(CL, 6);
    weird.name = '../../etc/passwd  ŞİÇ';
    expect(corridorKey(weird)).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
  });
});
