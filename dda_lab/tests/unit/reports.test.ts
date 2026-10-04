import { describe, expect, it } from 'vitest';
import {
  gearUsagePct,
  ggPoints,
  histogram,
  leanVsThrottle,
  sectorTable,
  timeLossSummary,
  toCsv,
} from '../../src/core/reports';
import {
  DEFAULT_PROC,
  type Channel,
  type Gate,
  type Lap,
  type LngLat,
  type Session,
  type TrackModel,
} from '../../src/core/types';

function chan(name: string, unit: string, data: Float32Array): Channel {
  return { name, unit, kind: 'raw', data, proc: { ...DEFAULT_PROC } };
}

function lap(n: number, startIdx: number, endIdx: number, timeS: number, sectorsS: number[], kind: Lap['kind'] = 'flying'): Lap {
  return { n, startIdx, endIdx, timeS, sectorsS, isBest: false, kind };
}

function session(laps: Lap[], channels: [string, Channel][] = [], n = 0): Session {
  const len = n || Math.max(1, ...laps.map((l) => l.endIdx + 1));
  const t = new Float64Array(len);
  for (let i = 0; i < len; i++) t[i] = i * 0.1;
  return {
    id: 's1',
    name: 'run',
    source: 'dda',
    color: '#ff6a00',
    t,
    channels: new Map(channels),
    laps,
    meta: { track: '', rider: '', note: '' },
  };
}

// ---------------------------------------------------------------------------

describe('sectorTable', () => {
  it('builds the lap x sector matrix with per-sector bests and theoretical best', () => {
    const s = session([
      lap(1, 0, 10, 30, [10, 10, 10], 'out'),
      lap(2, 11, 20, 29.5, [10.0, 9.5, 10.0]),
      lap(3, 21, 30, 29.0, [9.8, 9.7, 9.5]),
      lap(4, 31, 40, 30.5, [10.5, 10.0, 10.0]),
      lap(5, 41, 50, 60, [20, 20, 20], 'in'),
    ]);
    const tbl = sectorTable(s);
    expect(tbl.laps).toEqual([2, 3, 4]);
    expect(tbl.sectors.length).toBe(3);
    expect(tbl.sectors[1]).toEqual([9.8, 9.7, 9.5]);
    expect(tbl.bestPerSector[0]).toBeCloseTo(9.8, 6);
    expect(tbl.bestPerSector[1]).toBeCloseTo(9.5, 6);
    expect(tbl.bestPerSector[2]).toBeCloseTo(9.5, 6);
    const expectedBest = tbl.bestPerSector.reduce((a, b) => a + b, 0);
    expect(tbl.theoreticalBest).toBeCloseTo(expectedBest, 6);
    // population sigma of [29.5, 29.0, 30.5]
    const mean = (29.5 + 29.0 + 30.5) / 3;
    const varPop =
      ((29.5 - mean) ** 2 + (29.0 - mean) ** 2 + (30.5 - mean) ** 2) / 3;
    expect(tbl.sigma).toBeCloseTo(Math.sqrt(varPop), 6);
  });

  it('is empty when no lap has sector times', () => {
    const tbl = sectorTable(session([lap(1, 0, 10, 30, [])]));
    expect(tbl.laps).toEqual([]);
    expect(tbl.sectors).toEqual([]);
    expect(tbl.bestPerSector).toEqual([]);
    expect(tbl.theoreticalBest).toBe(0);
    expect(tbl.sigma).toBe(0);
  });
});

describe('histogram', () => {
  it('counts into edge bins and clamps outliers so the counts sum to the finite samples', () => {
    const v = Float32Array.from([1, 2, NaN, 5, -10, 100, 3]);
    const counts = histogram(v, [0, 3, 6]);
    expect(counts.length).toBe(2);
    expect(counts[0]).toBe(3); // 1, 2, -10 (clamped low)
    expect(counts[1]).toBe(3); // 5, 100 (clamped high), 3 (on the edge)
    expect(counts.reduce((a, b) => a + b, 0)).toBe(6);
  });

  it('handles degenerate bin arrays', () => {
    expect(histogram(Float32Array.from([1, 2]), [0])).toEqual([]);
    expect(histogram(Float32Array.from([1, 2]), [])).toEqual([]);
  });
});

describe('gearUsagePct', () => {
  it('reports the percentage of finite samples per gear', () => {
    const pct = gearUsagePct(Float32Array.from([1, 1, 2, NaN, 3, 3, 3, 3]));
    expect(pct[1]).toBeCloseTo((2 / 7) * 100, 6);
    expect(pct[2]).toBeCloseTo((1 / 7) * 100, 6);
    expect(pct[3]).toBeCloseTo((4 / 7) * 100, 6);
    const total = Object.values(pct).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(100, 6);
  });

  it('is empty with no finite samples', () => {
    expect(gearUsagePct(Float32Array.from([NaN, NaN]))).toEqual({});
  });
});

describe('ggPoints', () => {
  it('returns finite [lat_g, long_g] pairs inside the lap', () => {
    const latG = Float32Array.from([0.1, 0.2, NaN, 0.4, 0.9]);
    const longG = Float32Array.from([-0.5, 0.3, 0.2, NaN, 0.1]);
    const s = session([lap(1, 0, 3, 1, [])], [
      ['lat_g', chan('lat_g', 'g', latG)],
      ['long_g', chan('long_g', 'g', longG)],
    ]);
    const pts = ggPoints(s, s.laps[0]);
    expect(pts.length).toBe(2);
    expect(pts[0][0]).toBeCloseTo(0.1, 5);
    expect(pts[0][1]).toBeCloseTo(-0.5, 5);
    expect(pts[1][0]).toBeCloseTo(0.2, 5);
    expect(pts[1][1]).toBeCloseTo(0.3, 5);
  });

  it('returns nothing without the channels', () => {
    const s = session([lap(1, 0, 3, 1, [])]);
    expect(ggPoints(s, s.laps[0])).toEqual([]);
  });
});

describe('leanVsThrottle', () => {
  it('bins |lean| against throttle into a matrix', () => {
    const lean = Float32Array.from([10, -30, 35, 5, NaN]);
    const tps = Float32Array.from([10, 80, 90, 20, 50]);
    const s = session([lap(1, 0, 4, 1, [])], [
      ['lean', chan('lean', 'deg', lean)],
      ['tps', chan('tps', '%', tps)],
    ]);
    const m = leanVsThrottle(s, s.laps[0], [0, 20, 40], [0, 50, 100]);
    expect(m.length).toBe(2);
    expect(m[0].length).toBe(2);
    expect(m[0][0]).toBe(2); // lean 10/tps 10 and lean 5/tps 20
    expect(m[1][1]).toBe(2); // lean 30/tps 80 and lean 35/tps 90
    const total = m.flat().reduce((a, b) => a + b, 0);
    expect(total).toBe(4);
  });
});

describe('timeLossSummary', () => {
  const trackWithTurns = (): TrackModel => {
    const sf: Gate = {
      id: 'sf', name: 'S/F', type: 'sf', at: [23.5, 41.07], bearingDeg: 0, halfWidthM: 15,
    };
    const centerline: LngLat[] = [
      [23.5, 41.07],
      [23.51, 41.07],
    ];
    return {
      id: 't', name: 'T', center: [23.5, 41.07], centerline,
      cumDistM: Float64Array.from([0, 700]), lengthM: 700,
      startFinish: sf, sectors: [],
      turns: [
        { n: 1, name: 'T1', dir: 'L', apexGeo: [23.5, 41.07], radiusM: 50, sRange: [100, 200] },
        { n: 2, name: 'T2', dir: 'R', apexGeo: [23.5, 41.07], radiusM: 50, sRange: [300, 400] },
        { n: 3, name: 'T3', dir: 'L', apexGeo: [23.5, 41.07], radiusM: 50, sRange: [500, 600] },
      ],
    };
  };

  it('reports delta_t gained per turn sorted by loss descending', () => {
    const n = 701;
    const dist = new Float32Array(n);
    const deltaT = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      dist[i] = i; // 1 m per sample
      // +0.30 s lost across T1, -0.10 s gained across T2, +0.05 s across T3
      let d = 0;
      if (i > 100) d += 0.003 * Math.min(i - 100, 100);
      if (i > 300) d -= 0.001 * Math.min(i - 300, 100);
      if (i > 500) d += 0.0005 * Math.min(i - 500, 100);
      deltaT[i] = d;
    }
    const s = session([lap(2, 0, n - 1, 70, [])], [
      ['lap_dist', chan('lap_dist', 'm', dist)],
      ['delta_t', chan('delta_t', 's', deltaT)],
    ]);
    const ref = lap(3, 0, n - 1, 69, []);
    const out = timeLossSummary(s, s.laps[0], ref, trackWithTurns());
    expect(out.map((r) => r.turn)).toEqual([1, 3, 2]);
    expect(out[0].lossS).toBeCloseTo(0.3, 2);
    expect(out[1].lossS).toBeCloseTo(0.05, 2);
    expect(out[2].lossS).toBeCloseTo(-0.1, 2);
  });

  it('returns an empty list without delta_t', () => {
    const s = session([lap(1, 0, 10, 10, [])]);
    expect(timeLossSummary(s, s.laps[0], s.laps[0], trackWithTurns())).toEqual([]);
  });
});

describe('toCsv', () => {
  it('quotes fields containing commas, quotes or newlines', () => {
    const csv = toCsv([
      ['turn', 'note', 'loss'],
      ['T1', 'brake, hard', 0.3],
      ['T2', 'say "hi"', -0.1],
      ['T3', 'line\nbreak', NaN],
    ]);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('turn,note,loss');
    expect(lines[1]).toBe('T1,"brake, hard",0.3');
    expect(lines[2]).toBe('T2,"say ""hi""",-0.1');
    expect(csv).toContain('"line\nbreak"');
    expect(lines[3]).toBe('T3,"line');
    expect(lines[4]).toBe('break",');
  });

  it('renders NaN as an empty cell and handles empty input', () => {
    expect(toCsv([[NaN, 1]])).toBe(',1');
    expect(toCsv([])).toBe('');
  });
});
