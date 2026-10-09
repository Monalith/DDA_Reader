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

/** A circular track of `radiusM` sampled every ~`stepM` metres. */
function circleTrack(radiusM: number, stepM: number, id = 'c'): TrackModel {
  const lat0 = 41.073;
  const lng0 = 23.518;
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const n = Math.max(16, Math.round((2 * Math.PI * radiusM) / stepM));
  const centerline: LngLat[] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    centerline.push([lng0 + (radiusM * Math.cos(a)) / mPerDegLng, lat0 + (radiusM * Math.sin(a)) / mPerDegLat]);
  }
  const step = (2 * Math.PI * radiusM) / n;
  const cumDistM = new Float64Array(n);
  for (let i = 1; i < n; i++) cumDistM[i] = cumDistM[i - 1] + step;
  return {
    id, name: 'circle', center: [lng0, lat0], centerline, cumDistM, lengthM: step * n,
    startFinish: { id: 'sf', name: 'SF', type: 'sf', at: centerline[0], bearingDeg: 0, halfWidthM: 15 },
    sectors: [], turns: [],
  };
}

function uniformCorridor(n: number, leftM: number, rightM: number, known = true): Corridor {
  return {
    stepM: 2,
    leftM: new Float32Array(n).fill(leftM),
    rightM: new Float32Array(n).fill(rightM),
    known: new Array(n).fill(known),
  };
}

describe('corridor storage is shareable across differently-built centerlines', () => {
  it('round-trips widths onto the SAME centerline', () => {
    const t = circleTrack(200, 2);
    const c = uniformCorridor(t.centerline.length, 6, 4);
    const back = deserializeCorridor(t, serializeCorridor(t, c));
    expect(back).not.toBeNull();
    const mid = back!.leftM.length >> 1;
    expect(back!.leftM[mid]).toBeCloseTo(6, 0);
    expect(back!.rightM[mid]).toBeCloseTo(4, 0);
    expect(back!.known[mid]).toBe(true);
  });

  it('recovers the same widths on a DIFFERENT centerline of the same circuit', () => {
    // This is the whole point of the task: the producer and the consumer built
    // their centerlines from their own laps, so vertex count, length and first
    // point all differ. Only the geography is shared.
    const producer = circleTrack(200, 2, 'runtime-a');
    const stored = serializeCorridor(producer, uniformCorridor(producer.centerline.length, 6, 4));

    const consumer = circleTrack(200, 3.1, 'runtime-b'); // different spacing => different n
    // and rotate it so index 0 is somewhere else entirely
    const k = Math.floor(consumer.centerline.length / 3);
    consumer.centerline = [...consumer.centerline.slice(k), ...consumer.centerline.slice(0, k)];

    expect(consumer.centerline.length).not.toBe(producer.centerline.length);

    const back = deserializeCorridor(consumer, stored);
    expect(back).not.toBeNull();
    expect(back!.leftM.length).toBe(consumer.centerline.length);
    let okCount = 0;
    for (let i = 0; i < back!.leftM.length; i++) {
      if (!back!.known[i]) continue;
      okCount++;
      expect(back!.leftM[i]).toBeGreaterThan(5);
      expect(back!.leftM[i]).toBeLessThan(7);
      expect(back!.rightM[i]).toBeGreaterThan(3);
      expect(back!.rightM[i]).toBeLessThan(5);
    }
    expect(okCount).toBeGreaterThan(back!.leftM.length * 0.9);
  });

  it('keeps unknown sections unknown through the round trip', () => {
    const t = circleTrack(200, 2);
    const c = uniformCorridor(t.centerline.length, 6, 4);
    const gap0 = 10;
    for (let i = gap0; i < gap0 + 20; i++) c.known[i] = false;
    const back = deserializeCorridor(t, serializeCorridor(t, c))!;
    // the middle of the gap must still be unknown; its edges may be bridged by
    // the nearest-point search, so check well inside
    expect(back.known[gap0 + 10]).toBe(false);
    expect(back.known[(gap0 + 200) % back.known.length]).toBe(true);
  });

  it('rejects a corridor stored for a different circuit', () => {
    const serres = circleTrack(200, 2);
    const stored = serializeCorridor(serres, uniformCorridor(serres.centerline.length, 6, 4));
    const elsewhere = circleTrack(200, 2);
    elsewhere.center = [29.0, 41.0];
    elsewhere.centerline = elsewhere.centerline.map(([lo, la]) => [lo + 5.5, la] as LngLat);
    expect(deserializeCorridor(elsewhere, stored)).toBeNull();
  });

  it('rejects a corridor whose track length is wildly different', () => {
    const short = circleTrack(200, 2);
    const long = circleTrack(600, 2);
    long.center = short.center;
    expect(deserializeCorridor(long, serializeCorridor(short, uniformCorridor(short.centerline.length, 6, 4)))).toBeNull();
  });

  it('rejects malformed input instead of throwing', () => {
    const t = circleTrack(200, 2);
    expect(deserializeCorridor(t, null)).toBeNull();
    expect(deserializeCorridor(t, { version: 1 })).toBeNull();
    expect(deserializeCorridor(t, { version: 2, key: 'k', center: ['a', 'b'], lengthM: 10, leftEdge: [], rightEdge: [] })).toBeNull();
    const ok = serializeCorridor(t, uniformCorridor(t.centerline.length, 6, 4));
    expect(deserializeCorridor(t, { ...ok, leftEdge: [[Number.NaN, 1]] })).toBeNull();
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
