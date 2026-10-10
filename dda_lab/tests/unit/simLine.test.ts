import { describe, expect, it } from 'vitest';
import { buildLine, curvatureVariance } from '../../src/sim/line';
import { DEFAULT_SIM_PARAMS } from '../../src/sim/presets';
import type { Corridor } from '../../src/sim/types';
import type { LngLat, TrackModel } from '../../src/core/types';

/** A circular track of `radiusM`, sampled every ~2 m, with a uniform corridor. */
function circleTrack(radiusM: number, halfWidthM: number): { track: TrackModel; corridor: Corridor } {
  const lat0 = 41.073;
  const lng0 = 23.518;
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const n = Math.max(64, Math.round((2 * Math.PI * radiusM) / 2));
  const centerline: LngLat[] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    centerline.push([lng0 + (radiusM * Math.cos(a)) / mPerDegLng, lat0 + (radiusM * Math.sin(a)) / mPerDegLat]);
  }
  const cum = new Float64Array(n);
  const step = (2 * Math.PI * radiusM) / n;
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + step;
  const track: TrackModel = {
    id: 'c', name: 'circle', center: [lng0, lat0], centerline, cumDistM: cum, lengthM: step * n,
    startFinish: { id: 'sf', name: 'SF', type: 'sf', at: centerline[0], bearingDeg: 0, halfWidthM: 15 },
    sectors: [], turns: [],
  };
  const corridor: Corridor = {
    stepM: step,
    leftM: new Float32Array(n).fill(halfWidthM),
    rightM: new Float32Array(n).fill(halfWidthM),
    known: new Array(n).fill(true),
  };
  return { track, corridor };
}

describe('buildLine', () => {
  it('produces one point per centerline vertex and stays inside the corridor', () => {
    const { track, corridor } = circleTrack(100, 6);
    const line = buildLine(track, corridor, DEFAULT_SIM_PARAMS);
    expect(line.points).toHaveLength(track.centerline.length);
    const margin = DEFAULT_SIM_PARAMS.tyre.kerbMarginM + 1e-6;
    for (let i = 0; i < line.offsetM.length; i++) {
      expect(line.offsetM[i]).toBeLessThanOrEqual(corridor.leftM[i] + margin);
      expect(line.offsetM[i]).toBeGreaterThanOrEqual(-(corridor.rightM[i] + margin));
    }
  });

  it('actually uses the corridor rather than the default fallback width', () => {
    // A corridor narrower than buildLine's own default fallback (5 m): if
    // buildLine ignored the corridor argument and fell back to the default,
    // this bound would be violated. Guards against the fallback test's
    // default (5 m) happening to be wider than every corridor under test,
    // which would let a "corridor ignored" bug slip through unnoticed.
    const { track, corridor } = circleTrack(100, 3);
    const line = buildLine(track, corridor, DEFAULT_SIM_PARAMS);
    const margin = DEFAULT_SIM_PARAMS.tyre.kerbMarginM + 1e-6;
    for (let i = 0; i < line.offsetM.length; i++) {
      expect(line.offsetM[i]).toBeLessThanOrEqual(corridor.leftM[i] + margin);
      expect(line.offsetM[i]).toBeGreaterThanOrEqual(-(corridor.rightM[i] + margin));
    }
  });

  it('spreads curvature more evenly at kappa=0 than at kappa=1', () => {
    const { track, corridor } = circleTrack(60, 8);
    const c = buildLine(track, corridor, {
      ...DEFAULT_SIM_PARAMS,
      rider: { ...DEFAULT_SIM_PARAMS.rider, kappa: 0, lineDeviationM: 0 },
    });
    const v = buildLine(track, corridor, {
      ...DEFAULT_SIM_PARAMS,
      rider: { ...DEFAULT_SIM_PARAMS.rider, kappa: 1, lineDeviationM: 0 },
    });
    expect(curvatureVariance(c)).toBeLessThan(curvatureVariance(v));
  });

  it('falls back to a uniform half width when there is no corridor', () => {
    const { track } = circleTrack(100, 6);
    const line = buildLine(track, undefined, DEFAULT_SIM_PARAMS, 5);
    expect(line.points).toHaveLength(track.centerline.length);
    for (let i = 0; i < line.offsetM.length; i++) {
      expect(Math.abs(line.offsetM[i])).toBeLessThanOrEqual(5 + DEFAULT_SIM_PARAMS.tyre.kerbMarginM + 1e-6);
    }
  });

  it('clamps the deviation so a huge lineDeviationM cannot push the line off track', () => {
    const { track, corridor } = circleTrack(100, 6);
    const line = buildLine(track, corridor, {
      ...DEFAULT_SIM_PARAMS,
      rider: { ...DEFAULT_SIM_PARAMS.rider, lineDeviationM: 50 },
    });
    const margin = DEFAULT_SIM_PARAMS.tyre.kerbMarginM + 1e-6;
    for (let i = 0; i < line.offsetM.length; i++) {
      expect(line.offsetM[i]).toBeLessThanOrEqual(corridor.leftM[i] + margin);
      expect(line.offsetM[i]).toBeGreaterThanOrEqual(-(corridor.rightM[i] + margin));
    }
  });

  it('gives a constant-radius circle a curvature close to 1/r', () => {
    const { track, corridor } = circleTrack(100, 0.01); // corridor pinned to the centerline
    const line = buildLine(track, corridor, {
      ...DEFAULT_SIM_PARAMS,
      rider: { ...DEFAULT_SIM_PARAMS.rider, lineDeviationM: 0 },
    });
    const mid = Math.floor(line.curvature.length / 2);
    expect(Math.abs(line.curvature[mid])).toBeCloseTo(1 / 100, 3);
  });
});
