import { describe, expect, it } from 'vitest';
import { fromLocalM } from '../../src/core/geo';
import { normalizeTrackOrigin, projectToTrack } from '../../src/core/track';
import { applyTrackLapDist } from '../../src/state/derivedExtras';
import { DEFAULT_PROC, type Channel, type Lap, type Session, type TrackModel } from '../../src/core/types';

const ORIGIN: [number, number] = [23.5, 41.07];
/** A 400 m square track, 1 m vertices, origin at the first corner. */
function squareTrack(): TrackModel {
  const pts: [number, number][] = [];
  for (let i = 0; i < 400; i++) {
    const s = i;
    const xy: [number, number] = s < 100 ? [s, 0] : s < 200 ? [100, s - 100] : s < 300 ? [300 - s, 100] : [0, 400 - s];
    pts.push(fromLocalM(ORIGIN, xy));
  }
  const cum = Float64Array.from({ length: 400 }, (_, i) => i);
  return {
    id: 'sq', name: 'sq', center: ORIGIN, centerline: pts, cumDistM: cum, lengthM: 400,
    startFinish: { id: 'sf', name: 'S/F', type: 'sf', at: fromLocalM(ORIGIN, [100, 50]), bearingDeg: 0, halfWidthM: 10 }, // at s = 150
    sectors: [],
    turns: [
      { n: 1, name: 'T1', dir: 'L', apexGeo: fromLocalM(ORIGIN, [100, 0]), radiusM: 10, sRange: [90, 110] },
      { n: 2, name: 'T2', dir: 'L', apexGeo: fromLocalM(ORIGIN, [100, 100]), radiusM: 10, sRange: [190, 210] },
    ],
  };
}

describe('track origin = start/finish', () => {
  it('rolls the centerline so the start line is at 0 and shifts the turns', () => {
    const t = normalizeTrackOrigin(squareTrack());
    expect(projectToTrack(t, t.startFinish.at).sM).toBeLessThan(1.5);
    expect(t.lengthM).toBeCloseTo(400, 0);
    // T2 was at 190–210 → 40–60 after the roll; T1 at 90–110 → 340–360
    const byName = Object.fromEntries(t.turns.map((x) => [x.name, x.sRange.map(Math.round)]));
    expect(byName.T2).toEqual([40, 60]);
    expect(byName.T1).toEqual([340, 360]);
    expect(t.turns[0].name).toBe('T2'); // re-sorted and renumbered along the lap
    expect(t.turns[0].n).toBe(1);
  });
  it('is idempotent', () => {
    const t = normalizeTrackOrigin(squareTrack());
    const u = normalizeTrackOrigin(t);
    expect(u.cumDistM).toEqual(t.cumDistM);
  });
  it('lap_dist starts from the start line for every lap, even when the first GPS fix is late', () => {
    const t = normalizeTrackOrigin(squareTrack());
    // two laps of 400 samples (1 m/sample) starting at s=150 (the S/F); lap 2's first 30 fixes are missing
    const n = 800;
    const time = Float64Array.from({ length: n }, (_, i) => i / 10);
    const lon = new Float32Array(n);
    const lat = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = squareTrack().centerline[(150 + i) % 400];
      lon[i] = p[0];
      lat[i] = p[1];
    }
    for (let i = 400; i < 430; i++) {
      lon[i] = NaN;
      lat[i] = NaN;
    }
    const ch = (name: string, data: Float32Array): Channel => ({ name, unit: 'deg', kind: 'raw', data, proc: { ...DEFAULT_PROC } });
    const laps: Lap[] = [
      { n: 1, startIdx: 0, endIdx: 399, timeS: 40, sectorsS: [], isBest: true, kind: 'flying' },
      { n: 2, startIdx: 400, endIdx: 799, timeS: 40, sectorsS: [], isBest: false, kind: 'flying' },
    ];
    const s: Session = { id: 's', name: 's', source: 'csv', color: '#fff', t: time, channels: new Map([['gps_lon', ch('gps_lon', lon)], ['gps_lat', ch('gps_lat', lat)]]), laps, meta: { track: '', rider: '', note: '' } };
    applyTrackLapDist(s, t);
    const d = s.channels.get('lap_dist')!.data;
    expect(d[100]).toBeCloseTo(100, 0);
    expect(d[500]).toBeCloseTo(100, 0); // same place on the track → same lap distance (was ~70 before)
    expect(d[430]).toBeCloseTo(30, 0);
  });
});
