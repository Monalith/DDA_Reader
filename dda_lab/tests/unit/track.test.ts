import { describe, expect, it } from 'vitest';
import {
  buildCenterline,
  curvature,
  defaultSectorGates,
  detectTurns,
  projectToTrack,
  recognizeTrack,
  turnMetrics,
} from '../../src/core/track';
import {
  DEFAULT_PROC,
  type Channel,
  type Gate,
  type Lap,
  type LngLat,
  type Session,
  type TrackModel,
} from '../../src/core/types';

// ---------------------------------------------------------------------------
// Synthetic oval: two R = 50 m semicircles joined by two 200 m straights.
// Driven counter-clockwise (= left turns) starting at the middle-left of the
// bottom straight.
// ---------------------------------------------------------------------------
const R = 50;
const STRAIGHT = 200;
const ARC = Math.PI * R;
const PATH_LEN = 2 * STRAIGHT + 2 * ARC; // 714.159...
const APEX1 = STRAIGHT + ARC / 2; // 278.54
const APEX2 = 2 * STRAIGHT + ARC + ARC / 2; // 635.62

const ORIGIN: LngLat = [23.5, 41.07];
const R_EARTH = 6371008.8;
const D2R = Math.PI / 180;

/** Point on the ideal oval at arc length s, in local metres (x east, y north). */
function pathPoint(s: number): [number, number] {
  let u = ((s % PATH_LEN) + PATH_LEN) % PATH_LEN;
  if (u <= STRAIGHT) return [-STRAIGHT / 2 + u, -R];
  u -= STRAIGHT;
  if (u <= ARC) {
    const th = -Math.PI / 2 + u / R;
    return [STRAIGHT / 2 + R * Math.cos(th), R * Math.sin(th)];
  }
  u -= ARC;
  if (u <= STRAIGHT) return [STRAIGHT / 2 - u, R];
  u -= STRAIGHT;
  const th = Math.PI / 2 + u / R;
  return [-STRAIGHT / 2 + R * Math.cos(th), R * Math.sin(th)];
}

/** 1/R inside the two arcs, 0 on the straights. */
function pathCurv(s: number): number {
  const u = ((s % PATH_LEN) + PATH_LEN) % PATH_LEN;
  const inArc1 = u > STRAIGHT && u <= STRAIGHT + ARC;
  const inArc2 = u > 2 * STRAIGHT + ARC;
  return inArc1 || inArc2 ? 1 / R : 0;
}

function toLngLat(xy: [number, number]): LngLat {
  return [
    ORIGIN[0] + xy[0] / (R_EARTH * Math.cos(ORIGIN[1] * D2R) * D2R),
    ORIGIN[1] + xy[1] / (R_EARTH * D2R),
  ];
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One "lap" of GPS samples at ~stepM spacing with gaussian-ish noise. */
function ovalLap(seed: number, noiseM = 0, stepM = 2, reverse = false) {
  const rnd = mulberry32(seed);
  const ss: number[] = [];
  for (let s = 0; s < PATH_LEN; s += stepM) ss.push(s);
  ss.push(PATH_LEN);
  const lng = new Float32Array(ss.length);
  const lat = new Float32Array(ss.length);
  for (let i = 0; i < ss.length; i++) {
    const s = reverse ? PATH_LEN - ss[i] : ss[i];
    const [x, y] = pathPoint(s);
    // sum of 3 uniforms ~ roughly normal, zero mean
    const nx = noiseM * (rnd() + rnd() + rnd() - 1.5);
    const ny = noiseM * (rnd() + rnd() + rnd() - 1.5);
    const [lo, la] = toLngLat([x + nx, y + ny]);
    lng[i] = lo;
    lat[i] = la;
  }
  return { lng, lat };
}

function sfGate(at: LngLat): Gate {
  return { id: 'sf', name: 'S/F', type: 'sf', at, bearingDeg: 90, halfWidthM: 15 };
}

function buildOvalTrack(noiseM = 0, seeds = [1, 2, 3]): TrackModel {
  const laps = seeds.map((s) => ovalLap(s, noiseM));
  const { centerline, cumDistM, lengthM } = buildCenterline(laps, 2);
  const curv = curvature(centerline);
  const turns = detectTurns(centerline, curv, cumDistM);
  const sf = sfGate(centerline[0]);
  return {
    id: 'oval',
    name: 'Oval',
    center: centerline[0],
    centerline,
    cumDistM,
    lengthM,
    startFinish: sf,
    sectors: defaultSectorGates(centerline, cumDistM, sf, 3),
    turns,
  };
}

function chan(name: string, unit: string, data: Float32Array): Channel {
  return { name, unit, kind: 'raw', data, proc: { ...DEFAULT_PROC } };
}

/**
 * A 10 Hz lap around the oval: 40 m/s on the straights falling linearly to
 * 20 m/s at each geometric apex (ramp length 100 m), brake/throttle derived
 * from the longitudinal acceleration, lean from v^2 * curvature.
 */
function ovalSession(withLapDist: boolean): { s: Session; lap: Lap } {
  const dt = 0.1;
  const ss: number[] = [];
  const vs: number[] = [];
  let s = 0;
  while (s < PATH_LEN) {
    const v = 20 + 20 * Math.min(1, Math.abs(s - APEX1) / 100, Math.abs(s - APEX2) / 100);
    ss.push(s);
    vs.push(v);
    s += v * dt;
  }
  const n = ss.length;
  const t = new Float64Array(n);
  const speed = new Float32Array(n);
  const lng = new Float32Array(n);
  const lat = new Float32Array(n);
  const lean = new Float32Array(n);
  const longG = new Float32Array(n);
  const tps = new Float32Array(n);
  const dist = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    t[i] = i * dt;
    speed[i] = vs[i] * 3.6;
    const [lo, la] = toLngLat(pathPoint(ss[i]));
    lng[i] = lo;
    lat[i] = la;
    dist[i] = ss[i];
    // deliberately negative so the |lean| handling is exercised
    lean[i] = -Math.atan((vs[i] * vs[i] * pathCurv(ss[i])) / 9.81) * (180 / Math.PI);
  }
  for (let i = 0; i < n; i++) {
    const a = i === 0 || i === n - 1 ? 0 : (vs[i + 1] - vs[i - 1]) / (2 * dt);
    longG[i] = a / 9.81;
    tps[i] = a > 0.5 ? 80 : 0;
  }
  const channels = new Map<string, Channel>([
    ['speed', chan('speed', 'km/h', speed)],
    ['tps', chan('tps', '%', tps)],
    ['lean', chan('lean', 'deg', lean)],
    ['long_g', chan('long_g', 'g', longG)],
    ['gps_lon', chan('gps_lon', 'deg', lng)],
    ['gps_lat', chan('gps_lat', 'deg', lat)],
  ]);
  if (withLapDist) channels.set('lap_dist', chan('lap_dist', 'm', dist));
  const lap: Lap = {
    n: 1,
    startIdx: 0,
    endIdx: n - 1,
    timeS: (n - 1) * dt,
    sectorsS: [],
    isBest: true,
    kind: 'flying',
  };
  return {
    s: {
      id: 's1',
      name: 'run',
      source: 'dda',
      color: '#ff6a00',
      t,
      channels,
      laps: [lap],
      meta: { track: 'Oval', rider: '', note: '' },
    },
    lap,
  };
}

// ---------------------------------------------------------------------------

describe('buildCenterline', () => {
  it('recovers the analytic oval length within 1 % from three noisy laps', () => {
    const laps = [1, 2, 3].map((seed) => ovalLap(seed, 0.03));
    const { centerline, cumDistM, lengthM } = buildCenterline(laps, 2);
    expect(centerline.length).toBe(cumDistM.length);
    expect(centerline.length).toBeGreaterThan(300);
    expect(cumDistM[0]).toBe(0);
    for (let i = 1; i < cumDistM.length; i++) {
      expect(cumDistM[i]).toBeGreaterThan(cumDistM[i - 1]);
    }
    expect(lengthM).toBe(cumDistM[cumDistM.length - 1]);
    expect(Math.abs(lengthM - PATH_LEN) / PATH_LEN).toBeLessThan(0.01);
  });

  it('spaces the centerline at about stepM', () => {
    const { centerline, lengthM } = buildCenterline([ovalLap(7)], 4);
    const step = lengthM / (centerline.length - 1);
    expect(step).toBeGreaterThan(3.5);
    expect(step).toBeLessThan(4.5);
  });

  it('skips NaN samples', () => {
    const lap = ovalLap(9);
    lap.lng[5] = NaN;
    lap.lat[40] = NaN;
    const { lengthM } = buildCenterline([lap], 2);
    expect(Math.abs(lengthM - PATH_LEN) / PATH_LEN).toBeLessThan(0.01);
  });

  it('returns an empty model for empty input', () => {
    const out = buildCenterline([], 2);
    expect(out.centerline).toEqual([]);
    expect(out.lengthM).toBe(0);
  });
});

describe('curvature', () => {
  it('is 1/R inside the arcs, ~0 on the straights and positive for left turns', () => {
    const { centerline, cumDistM } = buildCenterline([ovalLap(1)], 2);
    const curv = curvature(centerline);
    expect(curv.length).toBe(centerline.length);
    const at = (sM: number) => {
      let best = 0;
      for (let i = 0; i < cumDistM.length; i++) {
        if (Math.abs(cumDistM[i] - sM) < Math.abs(cumDistM[best] - sM)) best = i;
      }
      return curv[best];
    };
    expect(at(APEX1)).toBeCloseTo(1 / R, 3);
    expect(at(APEX2)).toBeCloseTo(1 / R, 3);
    expect(Math.abs(at(STRAIGHT / 2))).toBeLessThan(1 / 500);
    expect(Math.abs(at(STRAIGHT + ARC + STRAIGHT / 2))).toBeLessThan(1 / 500);
  });

  it('is negative for a clockwise (right-hand) oval', () => {
    const { centerline, cumDistM } = buildCenterline([ovalLap(1, 0, 2, true)], 2);
    const curv = curvature(centerline);
    let i = 0;
    while (i < cumDistM.length - 1 && cumDistM[i] < PATH_LEN - APEX1) i++;
    expect(curv[i]).toBeCloseTo(-1 / R, 3);
  });
});

describe('detectTurns', () => {
  it('finds exactly two 50 m left turns on the noisy oval', () => {
    const track = buildOvalTrack(0.03);
    const turns = track.turns;
    expect(turns.length).toBe(2);
    expect(turns.map((t) => t.n)).toEqual([1, 2]);
    expect(turns.map((t) => t.name)).toEqual(['T1', 'T2']);
    expect(turns.map((t) => t.dir)).toEqual(['L', 'L']);
    for (const t of turns) {
      expect(t.radiusM).toBeGreaterThan(45);
      expect(t.radiusM).toBeLessThan(55);
    }
    expect(turns[0].sRange[0]).toBeGreaterThan(170);
    expect(turns[0].sRange[0]).toBeLessThan(220);
    expect(turns[0].sRange[1]).toBeGreaterThan(340);
    expect(turns[0].sRange[1]).toBeLessThan(390);
    expect(turns[1].sRange[0]).toBeGreaterThan(530);
    expect(turns[1].sRange[0]).toBeLessThan(580);
    expect(turns[1].sRange[1]).toBeGreaterThan(690);
    expect(turns[1].sRange[1]).toBeLessThan(PATH_LEN + 1);
  });

  it('puts each apex inside its own arc', () => {
    const track = buildOvalTrack(0);
    for (const t of track.turns) {
      const p = projectToTrack(track, t.apexGeo);
      const mid = (t.sRange[0] + t.sRange[1]) / 2;
      expect(Math.abs(p.sM - mid)).toBeLessThan(40);
    }
  });

  it('merges regions separated by less than minSepM', () => {
    const { centerline, cumDistM } = buildCenterline([ovalLap(1)], 2);
    const curv = curvature(centerline);
    // a huge minSepM glues the two arcs together
    const merged = detectTurns(centerline, curv, cumDistM, { maxRadiusM: 150, minSepM: 400 });
    expect(merged.length).toBe(1);
  });

  it('finds nothing on a straight line', () => {
    const lng = new Float32Array(100);
    const lat = new Float32Array(100);
    for (let i = 0; i < 100; i++) {
      const [lo, la] = toLngLat([i * 2, 0]);
      lng[i] = lo;
      lat[i] = la;
    }
    const { centerline, cumDistM } = buildCenterline([{ lng, lat }], 2);
    const curv = curvature(centerline);
    expect(detectTurns(centerline, curv, cumDistM).length).toBe(0);
  });
});

describe('defaultSectorGates', () => {
  it('returns n-1 gates at equal distance fractions', () => {
    const track = buildOvalTrack(0);
    const gates = track.sectors;
    expect(gates.length).toBe(2);
    expect(gates.map((g) => g.type)).toEqual(['split', 'split']);
    const s1 = projectToTrack(track, gates[0].at).sM;
    const s2 = projectToTrack(track, gates[1].at).sM;
    expect(Math.abs(s1 - track.lengthM / 3)).toBeLessThan(5);
    expect(Math.abs(s2 - (2 * track.lengthM) / 3)).toBeLessThan(5);
    for (const g of gates) {
      expect(g.halfWidthM).toBeGreaterThan(0);
      expect(Number.isFinite(g.bearingDeg)).toBe(true);
    }
  });

  it('honours a different sector count', () => {
    const track = buildOvalTrack(0);
    const gates = defaultSectorGates(track.centerline, track.cumDistM, track.startFinish, 5);
    expect(gates.length).toBe(4);
  });
});

describe('projectToTrack', () => {
  it('returns ~3 m offset for a point 3 m outside the straight', () => {
    const track = buildOvalTrack(0);
    // bottom straight runs along y = -R; 3 m further out is y = -R - 3
    const p = toLngLat([0, -R - 3]);
    const { sM, offM } = projectToTrack(track, p);
    expect(offM).toBeGreaterThan(2.5);
    expect(offM).toBeLessThan(3.5);
    expect(Math.abs(sM - STRAIGHT / 2)).toBeLessThan(3);
  });

  it('returns ~0 m offset on the centerline itself', () => {
    const track = buildOvalTrack(0);
    const i = 120;
    const { sM, offM } = projectToTrack(track, track.centerline[i]);
    expect(offM).toBeLessThan(0.2);
    expect(Math.abs(sM - track.cumDistM[i])).toBeLessThan(0.5);
  });
});

describe('recognizeTrack', () => {
  it('matches a track within 3 km of the GPS centre', () => {
    const track = buildOvalTrack(0);
    expect(recognizeTrack([track], toLngLat([500, 500]))?.id).toBe('oval');
    expect(recognizeTrack([track], toLngLat([20000, 0]))).toBeUndefined();
    expect(recognizeTrack([], ORIGIN)).toBeUndefined();
  });

  it('picks the nearest of several tracks', () => {
    const a = { ...buildOvalTrack(0), id: 'a', center: toLngLat([0, 0]) };
    const b = { ...a, id: 'b', center: toLngLat([1000, 0]) };
    expect(recognizeTrack([b, a], toLngLat([100, 0]))?.id).toBe('a');
  });
});

describe('turnMetrics', () => {
  it('derives entry/apex/exit, brake and throttle distances per turn', () => {
    const track = buildOvalTrack(0);
    const { s, lap } = ovalSession(false);
    const rows = turnMetrics(s, lap, track);
    expect(rows.length).toBe(2);
    for (const m of rows) {
      expect(m.lap).toBe(1);
      expect(m.apexKmh).toBeGreaterThan(70);
      expect(m.apexKmh).toBeLessThan(76);
      expect(m.entryKmh).toBeGreaterThan(110);
      expect(m.exitKmh).toBeGreaterThan(110);
      expect(m.entryKmh).toBeGreaterThan(m.apexKmh);
      expect(m.exitKmh).toBeGreaterThan(m.apexKmh);
      expect(m.maxLeanDeg).toBeGreaterThan(55);
      expect(m.maxLeanDeg).toBeLessThan(80);
      expect(m.brakeDistM).toBeGreaterThan(85);
      expect(m.brakeDistM).toBeLessThan(115);
      expect(m.throttleOnDistM).toBeGreaterThan(0);
      expect(m.throttleOnDistM).toBeLessThan(10);
    }
    expect(rows.map((m) => m.turn)).toEqual([1, 2]);
  });

  it('gives the same answer from lap_dist as from the GPS projection', () => {
    const track = buildOvalTrack(0);
    const noDist = ovalSession(false);
    const viaGps = turnMetrics(noDist.s, noDist.lap, track);
    const withDist = ovalSession(true);
    const viaDist = turnMetrics(withDist.s, withDist.lap, track);
    expect(viaDist.length).toBe(2);
    for (let i = 0; i < 2; i++) {
      expect(viaDist[i].apexKmh).toBeCloseTo(viaGps[i].apexKmh, 0);
      expect(Math.abs(viaDist[i].brakeDistM - viaGps[i].brakeDistM)).toBeLessThan(10);
      expect(Math.abs(viaDist[i].entryKmh - viaGps[i].entryKmh)).toBeLessThan(5);
    }
  });

  it('returns NaN distances when the bike never brakes or opens the throttle', () => {
    const track = buildOvalTrack(0);
    const { s, lap } = ovalSession(true);
    s.channels.get('long_g')!.data.fill(0);
    s.channels.get('tps')!.data.fill(0);
    const rows = turnMetrics(s, lap, track);
    expect(rows.every((m) => Number.isNaN(m.brakeDistM))).toBe(true);
    expect(rows.every((m) => Number.isNaN(m.throttleOnDistM))).toBe(true);
  });

  it('returns no rows when the track has no turns', () => {
    const track = { ...buildOvalTrack(0), turns: [] };
    const { s, lap } = ovalSession(true);
    expect(turnMetrics(s, lap, track)).toEqual([]);
  });
});
