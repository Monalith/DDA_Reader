import { describe, expect, it } from 'vitest';
import { simulate } from '../../src/sim';
import { clampParams, DEFAULT_SIM_PARAMS } from '../../src/sim/presets';
import type { Corridor } from '../../src/sim/types';
import type { LngLat, TrackModel } from '../../src/core/types';

function circleTrack(radiusM: number): { track: TrackModel; corridor: Corridor } {
  const lat0 = 41.073;
  const lng0 = 23.518;
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const n = Math.round((2 * Math.PI * radiusM) / 2);
  const centerline: LngLat[] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    centerline.push([lng0 + (radiusM * Math.cos(a)) / mPerDegLng, lat0 + (radiusM * Math.sin(a)) / mPerDegLat]);
  }
  const step = (2 * Math.PI * radiusM) / n;
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + step;
  return {
    track: {
      id: 'c', name: 'circle', center: [lng0, lat0], centerline, cumDistM: cum, lengthM: step * n,
      startFinish: { id: 'sf', name: 'SF', type: 'sf', at: centerline[0], bearingDeg: 0, halfWidthM: 15 },
      sectors: [], turns: [],
    },
    corridor: {
      stepM: step,
      leftM: new Float32Array(n).fill(6),
      rightM: new Float32Array(n).fill(6),
      known: new Array(n).fill(true),
    },
  };
}

/**
 * A closed "stadium" oval: two straights long enough to reach a real speed,
 * joined by two tight semicircles. Unlike `circleTrack`, this has an actual
 * braking zone — on a constant-radius circle the whole line already sits at
 * the one speed the lateral limit allows, so the backward (braking) pass
 * never has anything to do and `brakingG` cannot change the lap time no
 * matter what it is set to. The oval is the minimum geometry that gives the
 * braking parameter something to mean.
 */
function ovalTrack(straightM: number, radiusM: number): { track: TrackModel; corridor: Corridor } {
  const lat0 = 41.073;
  const lng0 = 23.518;
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const toLL = (x: number, y: number): LngLat => [lng0 + x / mPerDegLng, lat0 + y / mPerDegLat];
  const pts: LngLat[] = [];
  const nStraight = Math.max(2, Math.round(straightM));
  const nArc = Math.max(2, Math.round(Math.PI * radiusM));
  for (let i = 0; i < nStraight; i++) pts.push(toLL(-straightM / 2 + (straightM * i) / nStraight, 0));
  for (let i = 0; i < nArc; i++) {
    const a = -Math.PI / 2 + (Math.PI * i) / nArc;
    pts.push(toLL(straightM / 2 + radiusM * Math.cos(a), radiusM + radiusM * Math.sin(a)));
  }
  for (let i = 0; i < nStraight; i++) pts.push(toLL(straightM / 2 - (straightM * i) / nStraight, 2 * radiusM));
  for (let i = 0; i < nArc; i++) {
    const a = Math.PI / 2 + (Math.PI * i) / nArc;
    pts.push(toLL(-straightM / 2 + radiusM * Math.cos(a), radiusM + radiusM * Math.sin(a)));
  }
  const n = pts.length;
  const cum = new Float64Array(n);
  let total = 0;
  for (let i = 1; i < n; i++) {
    const dx = (pts[i][0] - pts[i - 1][0]) * mPerDegLng;
    const dy = (pts[i][1] - pts[i - 1][1]) * mPerDegLat;
    total += Math.hypot(dx, dy);
    cum[i] = total;
  }
  const closing = Math.hypot(
    (pts[0][0] - pts[n - 1][0]) * mPerDegLng,
    (pts[0][1] - pts[n - 1][1]) * mPerDegLat,
  );
  const lengthM = total + closing;
  return {
    track: {
      id: 'oval', name: 'oval', center: [lng0, lat0], centerline: pts, cumDistM: cum, lengthM,
      startFinish: { id: 'sf', name: 'SF', type: 'sf', at: pts[0], bearingDeg: 0, halfWidthM: 15 },
      sectors: [], turns: [],
    },
    corridor: {
      stepM: lengthM / n,
      leftM: new Float32Array(n).fill(6),
      rightM: new Float32Array(n).fill(6),
      known: new Array(n).fill(true),
    },
  };
}

const P = clampParams(DEFAULT_SIM_PARAMS);

describe('simulate', () => {
  it('returns a Session with the channels the charts and map need', () => {
    const { track, corridor } = circleTrack(300);
    const { session } = simulate(track, corridor, P, 'sim1', 'Virtual', '#c77dff');
    for (const name of ['speed', 'gps_lon', 'gps_lat', 'long_g', 'lean', 'tps', 'gear', 'rpm', 'dtc']) {
      expect(session.channels.has(name), `missing channel ${name}`).toBe(true);
    }
    expect(session.source).toBe('sim');
    expect(session.isSim).toBe(true);
  });

  it('puts every channel on the same 10 Hz time base', () => {
    const { track, corridor } = circleTrack(300);
    const { session } = simulate(track, corridor, P, 'sim1', 'Virtual', '#c77dff');
    expect(session.t[1] - session.t[0]).toBeCloseTo(0.1, 6);
    for (const ch of session.channels.values()) expect(ch.data).toHaveLength(session.t.length);
  });

  it('carries exactly one flying lap whose time matches the solver', () => {
    const { track, corridor } = circleTrack(300);
    const { session, lapTimeS } = simulate(track, corridor, P, 'sim1', 'Virtual', '#c77dff');
    expect(session.laps).toHaveLength(1);
    expect(session.laps[0].kind).toBe('flying');
    expect(session.laps[0].isBest).toBe(true);
    expect(session.laps[0].timeS).toBeCloseTo(lapTimeS, 1);
    expect(session.lapsFromFile).toBe(true);
  });

  it('emits no NaN in any channel', () => {
    const { track, corridor } = circleTrack(300);
    const { session } = simulate(track, corridor, P, 'sim1', 'Virtual', '#c77dff');
    for (const [name, ch] of session.channels) {
      for (let i = 0; i < ch.data.length; i++) {
        expect(Number.isFinite(ch.data[i]), `${name}[${i}] is not finite`).toBe(true);
      }
    }
  });

  it('speeds up when the rider brakes harder', () => {
    // A pure circle (circleTrack) sits at one lateral-limited speed all the
    // way round, so the backward (braking) pass never binds and brakingG has
    // nothing to do there; the oval's straights give it a real braking zone
    // to shorten, so the two settings must come out strictly different.
    const { track, corridor } = ovalTrack(500, 25);
    const slow = simulate(track, corridor, clampParams({ ...P, rider: { ...P.rider, brakingG: 0.6 } }), 'a', 'A', '#fff');
    const fast = simulate(track, corridor, clampParams({ ...P, rider: { ...P.rider, brakingG: 1.4 } }), 'b', 'B', '#fff');
    expect(fast.lapTimeS).toBeLessThan(slow.lapTimeS);
  });

  it('runs without a corridor, using the fallback half width', () => {
    const { track } = circleTrack(300);
    const { session, lapTimeS } = simulate(track, undefined, P, 'sim1', 'Virtual', '#c77dff');
    expect(lapTimeS).toBeGreaterThan(0);
    expect(session.channels.get('speed')!.data.length).toBe(session.t.length);
  });
});
