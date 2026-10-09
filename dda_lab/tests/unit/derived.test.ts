import { describe, expect, it } from 'vitest';
import { computeDerived } from '../../src/core/derived';
import { fromLocalM } from '../../src/core/geo';
import { makeTimeBase } from '../../src/core/resample';
import { DEFAULT_PROC } from '../../src/core/types';
import type { Lap, LngLat, Session } from '../../src/core/types';

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

/** Counter-clockwise constant-speed circle, with laps already set. */
function circleSession(radiusM = 200, speedMs = 30, revs = 2) {
  const omega = speedMs / radiusM;
  const durationS = (revs * 2 * Math.PI) / omega;
  const t = makeTimeBase(durationS, HZ);
  const lng = new Float32Array(t.length);
  const lat = new Float32Array(t.length);
  const speed = new Float32Array(t.length).fill(speedMs * 3.6);
  const tps = new Float32Array(t.length).fill(40);
  for (let i = 0; i < t.length; i++) {
    const th = omega * t[i];
    const p = fromLocalM(ORIGIN, [radiusM * Math.cos(th), radiusM * Math.sin(th)]);
    lng[i] = p[0];
    lat[i] = p[1];
  }
  const s = session(t, { speed, tps, gps_lon: lng, gps_lat: lat });
  const half = Math.floor(t.length / 2);
  const lap: Lap = {
    n: 1, startIdx: 0, endIdx: half, timeS: t[half], sectorsS: [],
    isBest: true, kind: 'flying',
  };
  s.laps = [lap];
  return { s, radiusM, speedMs, lap };
}

describe('computeDerived', () => {
  const { s, radiusM, speedMs } = circleSession();
  computeDerived(s);
  const mid = Math.floor(s.t.length / 4);

  it('adds every derived channel with kind "derived"', () => {
    for (const name of [
      'gps_speed', 'long_g', 'lat_g', 'total_g', 'curvature', 'radius', 'slip', 'phase',
      'lap_dist',
    ]) {
      const ch = s.channels.get(name);
      expect(ch, name).toBeDefined();
      expect(ch!.kind, name).toBe('derived');
      expect(ch!.data.length, name).toBe(s.t.length);
      expect(ch!.data, name).toBeInstanceOf(Float32Array);
    }
    expect(s.channels.get('gps_speed')!.unit).toBe('km/h');
    expect(s.channels.get('lat_g')!.unit).toBe('g');
    expect(s.channels.get('radius')!.unit).toBe('m');
  });

  it('gps_speed matches the simulated speed within 2 %', () => {
    const got = s.channels.get('gps_speed')!.data[mid];
    expect(Math.abs(got - speedMs * 3.6) / (speedMs * 3.6)).toBeLessThan(0.02);
  });

  it('long_g is ~0 at constant speed', () => {
    expect(Math.abs(s.channels.get('long_g')!.data[mid])).toBeLessThan(0.02);
  });

  it('lat_g equals v^2 / (R g) within 5 %', () => {
    const want = (speedMs * speedMs) / (radiusM * 9.81);
    const got = Math.abs(s.channels.get('lat_g')!.data[mid]);
    expect(Math.abs(got - want) / want).toBeLessThan(0.05);
    expect(s.channels.get('total_g')!.data[mid]).toBeCloseTo(got, 2);
  });

  it('radius recovers the circle radius within 5 % and curvature its sign', () => {
    const got = s.channels.get('radius')!.data[mid];
    expect(Math.abs(got - radiusM) / radiusM).toBeLessThan(0.05);
    expect(s.channels.get('curvature')!.data[mid]).toBeGreaterThan(0); // left turn
  });

  it('slip is ~0 when wheel and GPS speed agree', () => {
    expect(Math.abs(s.channels.get('slip')!.data[mid])).toBeLessThan(2);
  });

  it('phase is throttle (2) at tps 40 with no braking', () => {
    expect(s.channels.get('phase')!.data[mid]).toBe(2);
  });

  it('lap_dist starts at 0 and grows to the lap length', () => {
    const d = s.channels.get('lap_dist')!.data;
    expect(d[0]).toBeCloseTo(0, 3);
    const end = s.laps[0].endIdx;
    expect(d[end]).toBeGreaterThan(2 * Math.PI * radiusM * 0.9);
    expect(d[end]).toBeLessThan(2 * Math.PI * radiusM * 1.1);
    for (let i = 1; i <= end; i++) expect(d[i]).toBeGreaterThanOrEqual(d[i - 1] - 1e-3);
  });

  it('is idempotent and keeps raw channels untouched', () => {
    const before = s.channels.get('speed')!.data.slice();
    computeDerived(s);
    expect([...s.channels.get('speed')!.data]).toEqual([...before]);
    expect(s.channels.get('speed')!.kind).toBe('raw');
  });
});

describe('computeDerived edge cases', () => {
  it('marks brake phase when decelerating hard', () => {
    const t = makeTimeBase(20, HZ);
    const speed = new Float32Array(t.length);
    for (let i = 0; i < t.length; i++) speed[i] = Math.max(0, 200 - t[i] * 18); // -5 m/s^2
    const tps = new Float32Array(t.length).fill(0);
    const s = session(t, { speed, tps });
    computeDerived(s);
    const long = s.channels.get('long_g')!.data;
    const phase = s.channels.get('phase')!.data;
    const i = 50;
    expect(long[i]).toBeLessThan(-0.4);
    expect(phase[i]).toBe(1);
  });

  it('marks coast phase at steady speed with closed throttle', () => {
    const t = makeTimeBase(20, HZ);
    const s = session(t, {
      speed: new Float32Array(t.length).fill(100),
      tps: new Float32Array(t.length).fill(0),
    });
    computeDerived(s);
    expect(s.channels.get('phase')!.data[100]).toBe(0);
  });

  it('fills lap_dist with NaN when the session has no laps', () => {
    const { s } = circleSession();
    s.laps = [];
    computeDerived(s);
    expect([...s.channels.get('lap_dist')!.data].every(Number.isNaN)).toBe(true);
  });

  it('survives a session without GPS', () => {
    const t = makeTimeBase(10, HZ);
    const s = session(t, { speed: new Float32Array(t.length).fill(80) });
    expect(() => computeDerived(s)).not.toThrow();
    expect([...s.channels.get('gps_speed')!.data].every(Number.isNaN)).toBe(true);
    expect([...s.channels.get('lat_g')!.data].every(Number.isNaN)).toBe(true);
    expect(Number.isNaN(s.channels.get('long_g')!.data[50])).toBe(false);
  });

  it('does not invent tiny radii from GPS jitter at a standstill', () => {
    const t = makeTimeBase(60, HZ);
    const lng = new Float32Array(t.length);
    const lat = new Float32Array(t.length);
    let seed = 1;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647 - 0.5;
    };
    for (let i = 0; i < t.length; i++) {
      lng[i] = ORIGIN[0] + rnd() * 2e-5; // ~ +/- 1 m of jitter
      lat[i] = ORIGIN[1] + rnd() * 2e-5;
    }
    const s = session(t, {
      speed: new Float32Array(t.length).fill(0),
      tps: new Float32Array(t.length).fill(0),
      gps_lon: lng, gps_lat: lat,
    });
    computeDerived(s);
    const r = s.channels.get('radius')!.data;
    const g = s.channels.get('lat_g')!.data;
    for (let i = 0; i < r.length; i++) {
      if (!Number.isNaN(r[i])) expect(r[i], `radius idx ${i}`).toBeGreaterThan(2);
      if (!Number.isNaN(g[i])) expect(Math.abs(g[i]), `lat_g idx ${i}`).toBeLessThan(3);
    }
  });

  it('rejects a GPS teleport instead of reporting an absurd gps_speed', () => {
    const t = makeTimeBase(30, HZ);
    const lng = new Float32Array(t.length);
    const lat = new Float32Array(t.length);
    for (let i = 0; i < t.length; i++) {
      lng[i] = ORIGIN[0] + i * 3.4e-5; // ~ 3 m per sample, 108 km/h
      lat[i] = ORIGIN[1];
    }
    lng[100] += 0.01; // a single-sample ~900 m jump
    const s = session(t, { gps_lon: lng, gps_lat: lat });
    computeDerived(s);
    const gs = s.channels.get('gps_speed')!.data;
    for (let i = 0; i < gs.length; i++) {
      if (!Number.isNaN(gs[i])) expect(gs[i], `idx ${i}`).toBeLessThan(400);
    }
    expect(gs[50]).toBeGreaterThan(80);
  });

  it('leaves slip NaN below 30 km/h GPS speed', () => {
    const { s } = circleSession(200, 5, 1); // 18 km/h
    computeDerived(s);
    expect([...s.channels.get('slip')!.data].every(Number.isNaN)).toBe(true);
  });
});

describe('time channels', () => {
  it('time counts from the file start and lap_time from each lap start', async () => {
    const { computeDerived } = await import('../../src/core/derived');
    const { DEFAULT_PROC } = await import('../../src/core/types');
    const n = 30;
    const t = Float64Array.from({ length: n }, (_, i) => 5 + i / 10);
    const s = {
      id: 'x', name: 'x', source: 'csv', color: '#fff', t,
      channels: new Map([['speed', { name: 'speed', unit: 'km/h', kind: 'raw', data: new Float32Array(n).fill(50), proc: { ...DEFAULT_PROC } }]]),
      laps: [{ n: 1, startIdx: 10, endIdx: 19, timeS: 1, sectorsS: [], isBest: true, kind: 'flying' }],
      meta: { track: '', rider: '', note: '' },
    } as never;
    computeDerived(s);
    const time = (s as { channels: Map<string, { data: Float32Array; unit: string }> }).channels.get('time')!;
    const lapTime = (s as { channels: Map<string, { data: Float32Array }> }).channels.get('lap_time')!;
    expect(time.unit).toBe('s');
    expect(time.data[0]).toBe(0);
    expect(time.data[29]).toBeCloseTo(2.9, 5);
    expect(Number.isNaN(lapTime.data[5])).toBe(true);
    expect(lapTime.data[10]).toBe(0);
    expect(lapTime.data[19]).toBeCloseTo(0.9, 5);
  });
});
