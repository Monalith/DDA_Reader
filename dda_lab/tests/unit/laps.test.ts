import { describe, expect, it } from 'vitest';
import { detectLaps, deltaT, lapsFromMarkers } from '../../src/core/laps';
import { fromLocalM } from '../../src/core/geo';
import { makeTimeBase } from '../../src/core/resample';
import { DEFAULT_PROC } from '../../src/core/types';
import type { Gate, LngLat, Lap, Session } from '../../src/core/types';

const ORIGIN: LngLat = [-122.4542, 38.1612];
const HZ = 10;

function session(t: Float64Array, chans: Record<string, Float32Array>): Session {
  const channels = new Map();
  for (const [name, data] of Object.entries(chans)) {
    channels.set(name, {
      name, unit: '', kind: 'raw' as const, data,
      proc: { ...DEFAULT_PROC, filter: { ...DEFAULT_PROC.filter } },
    });
  }
  return {
    id: 's1', name: 'test', source: 'dda', color: '#f60',
    t, channels, laps: [], meta: { track: 'T', rider: 'R', note: '' },
  };
}

/** Counter-clockwise circle at constant speed; start angle -0.5 rad. */
function circle(radiusM: number, speedMs: number, revs: number) {
  const omega = speedMs / radiusM;
  const totalAngle = revs * 2 * Math.PI;
  const durationS = totalAngle / omega;
  const t = makeTimeBase(durationS, HZ);
  const lng = new Float32Array(t.length);
  const lat = new Float32Array(t.length);
  const speed = new Float32Array(t.length).fill(speedMs * 3.6);
  for (let i = 0; i < t.length; i++) {
    const th = -0.5 + omega * t[i];
    const p = fromLocalM(ORIGIN, [radiusM * Math.cos(th), radiusM * Math.sin(th)]);
    lng[i] = p[0];
    lat[i] = p[1];
  }
  const sfGate: Gate = {
    id: 'sf', name: 'S/F', type: 'sf',
    at: fromLocalM(ORIGIN, [radiusM, 0]), bearingDeg: 0, halfWidthM: 40,
  };
  const splitGate: Gate = {
    id: 'sp1', name: 'Split 1', type: 'split',
    at: fromLocalM(ORIGIN, [-radiusM, 0]), bearingDeg: 180, halfWidthM: 40,
  };
  return {
    s: session(t, { gps_lon: lng, gps_lat: lat, speed }),
    sfGate, splitGate, lapTimeS: (2 * Math.PI * radiusM) / speedMs, durationS,
  };
}

describe('lapsFromMarkers', () => {
  it('builds out / flying / in laps from lap_mark crossings', () => {
    const t = makeTimeBase(100, HZ);
    const mark = new Float32Array(t.length).fill(NaN);
    mark[100] = 1; // 10 s
    mark[400] = 1; // 40 s
    mark[700] = 1; // 70 s
    const s = session(t, { lap_mark: mark });
    const laps = lapsFromMarkers(s);
    expect(laps.map((l) => l.kind)).toEqual(['out', 'flying', 'flying', 'in']);
    expect(laps.map((l) => l.n)).toEqual([0, 1, 2, 3]);
    expect(laps[1].timeS).toBeCloseTo(30, 6);
    expect(laps[2].timeS).toBeCloseTo(30, 6);
    expect(laps[1].startIdx).toBe(100);
    expect(laps[1].endIdx).toBe(400);
    expect(laps[3].endIdx).toBe(t.length - 1);
  });

  it('marks the fastest flying lap as best', () => {
    const t = makeTimeBase(100, HZ);
    const mark = new Float32Array(t.length).fill(NaN);
    mark[100] = 1;
    mark[400] = 1;
    mark[600] = 1; // 20 s lap, the fastest
    mark[900] = 1;
    const s = session(t, { lap_mark: mark });
    const laps = lapsFromMarkers(s);
    const best = laps.filter((l) => l.isBest);
    expect(best.length).toBe(1);
    expect(best[0].timeS).toBeCloseTo(20, 6);
    expect(best[0].kind).toBe('flying');
  });

  it('returns no laps when there is no marker channel or no crossing', () => {
    const t = makeTimeBase(10, HZ);
    expect(lapsFromMarkers(session(t, {})).length).toBe(0);
    expect(lapsFromMarkers(session(t, { lap_mark: new Float32Array(t.length).fill(NaN) })).length)
      .toBe(0);
  });

  it('gives a single out lap for one crossing at the end', () => {
    const t = makeTimeBase(10, HZ);
    const mark = new Float32Array(t.length).fill(NaN);
    mark[t.length - 1] = 1;
    const laps = lapsFromMarkers(session(t, { lap_mark: mark }));
    expect(laps.length).toBe(1);
    expect(laps[0].kind).toBe('out');
  });
});

describe('detectLaps', () => {
  const { s, sfGate, splitGate, lapTimeS } = circle(200, 30, 2.6);

  it('finds the laps of a synthetic circuit with the right lap time', () => {
    const laps = detectLaps(s, sfGate, []);
    expect(laps.map((l) => l.kind)).toEqual(['out', 'flying', 'flying', 'in']);
    for (const l of laps.filter((x) => x.kind === 'flying')) {
      expect(Math.abs(l.timeS - lapTimeS)).toBeLessThan(0.3);
    }
  });

  it('computes sector times that add up to the lap time', () => {
    const laps = detectLaps(s, sfGate, [splitGate]);
    const flying = laps.filter((l) => l.kind === 'flying');
    expect(flying.length).toBe(2);
    for (const l of flying) {
      expect(l.sectorsS.length).toBe(2);
      const sum = l.sectorsS.reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(l.timeS, 2);
      expect(l.sectorsS[0]).toBeCloseTo(lapTimeS / 2, 0);
    }
  });

  it('flags the best flying lap and returns nothing without GPS', () => {
    const laps = detectLaps(s, sfGate, []);
    expect(laps.filter((l) => l.isBest).length).toBe(1);
    const empty = session(makeTimeBase(10, HZ), {});
    expect(detectLaps(empty, sfGate, []).length).toBe(0);
  });
});

describe('deltaT', () => {
  function lapSession(speedMs: number) {
    const t = makeTimeBase(100, HZ);
    const dist = new Float32Array(t.length);
    for (let i = 0; i < t.length; i++) dist[i] = t[i] * speedMs;
    const s = session(t, { lap_dist: dist });
    const lap: Lap = {
      n: 1, startIdx: 0, endIdx: t.length - 1, timeS: 100,
      sectorsS: [], isBest: false, kind: 'flying',
    };
    s.laps = [lap];
    return { s, lap };
  }

  it('is ~0 for identical laps', () => {
    const { s, lap } = lapSession(30);
    const d = deltaT(s, lap, s, lap);
    for (let i = 0; i < d.length; i++) {
      if (Number.isNaN(d[i])) continue;
      expect(Math.abs(d[i])).toBeLessThan(0.02);
    }
    expect(Number.isNaN(d[0])).toBe(false);
  });

  it('is positive when the lap is slower than the reference', () => {
    const slow = lapSession(29);
    const fast = lapSession(30);
    const d = deltaT(slow.s, slow.lap, fast.s, fast.lap);
    // at 1500 m (idx ~517 of the slow lap) the slow lap has lost ~1.7 s
    const idx = 500;
    expect(d[idx]).toBeGreaterThan(0.5);
    expect(d[idx]).toBeLessThan(3);
    expect(d[10]).toBeGreaterThanOrEqual(0);
  });

  it('ignores the lap-boundary sample where lap_dist already restarted', () => {
    // computeDerived gives the shared boundary index to the *next* lap, so the
    // last sample of a lap can read 0 m: it must not look like a lost lap.
    const t = makeTimeBase(100, HZ);
    const dist = new Float32Array(t.length).fill(NaN);
    for (let i = 200; i < 500; i++) dist[i] = (i - 200) * 3; // 0 m at the lap start
    dist[500] = 0; // next lap starts here and owns the shared sample
    const s = session(t, { lap_dist: dist });
    const lap: Lap = {
      n: 1, startIdx: 200, endIdx: 500, timeS: 30,
      sectorsS: [], isBest: false, kind: 'flying',
    };
    s.laps = [lap];
    const d = deltaT(s, lap, s, lap);
    for (let i = lap.startIdx; i <= lap.endIdx; i++) {
      if (Number.isNaN(d[i])) continue;
      expect(Math.abs(d[i]), `idx ${i}`).toBeLessThan(0.5);
    }
  });

  it('is NaN outside the lap and without lap_dist', () => {
    const t = makeTimeBase(100, HZ);
    const dist = new Float32Array(t.length);
    for (let i = 0; i < t.length; i++) dist[i] = t[i] * 30;
    const s = session(t, { lap_dist: dist });
    const lap: Lap = {
      n: 1, startIdx: 200, endIdx: 500, timeS: 30,
      sectorsS: [], isBest: false, kind: 'flying',
    };
    s.laps = [lap];
    const d = deltaT(s, lap, s, lap);
    expect(Number.isNaN(d[100])).toBe(true);
    expect(Number.isNaN(d[600])).toBe(true);
    expect(Number.isNaN(d[300])).toBe(false);

    const noDist = session(t, {});
    noDist.laps = [lap];
    const d2 = deltaT(noDist, lap, noDist, lap);
    expect([...d2].every(Number.isNaN)).toBe(true);
  });
});
