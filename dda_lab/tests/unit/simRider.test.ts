import { describe, expect, it } from 'vitest';
import { riderChannels } from '../../src/sim/rider';
import { solve } from '../../src/sim/solver';
import { clampParams, DEFAULT_SIM_PARAMS } from '../../src/sim/presets';
import type { Line } from '../../src/sim/types';
import type { LngLat } from '../../src/core/types';

/** Straight, then a 50 m radius corner, then straight again. */
function cornerLine(n = 600): Line {
  const lat0 = 41.073;
  const lng0 = 23.518;
  const mPerDegLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const curvature = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const f = i / n;
    curvature[i] = f > 0.4 && f < 0.6 ? 1 / 50 : 0;
  }
  const stepM = 2;
  const cumDistM = new Float64Array(n);
  const points: LngLat[] = [];
  for (let i = 0; i < n; i++) {
    cumDistM[i] = i * stepM;
    points.push([lng0 + (i * stepM) / mPerDegLng, lat0]);
  }
  return { points, curvature, cumDistM, lengthM: n * stepM, offsetM: new Float32Array(n) };
}

const P = clampParams(DEFAULT_SIM_PARAMS);

describe('riderChannels', () => {
  it('produces channels of the same length as the line', () => {
    const line = cornerLine();
    const ch = riderChannels(line, solve(line, P), P);
    expect(ch.tps).toHaveLength(line.points.length);
    expect(ch.gear).toHaveLength(line.points.length);
    expect(ch.rpm).toHaveLength(line.points.length);
    expect(ch.dtc).toHaveLength(line.points.length);
  });

  it('keeps throttle in 0..100 and gear in 1..top', () => {
    const line = cornerLine();
    const ch = riderChannels(line, solve(line, P), P);
    for (let i = 0; i < ch.tps.length; i++) {
      expect(ch.tps[i]).toBeGreaterThanOrEqual(0);
      expect(ch.tps[i]).toBeLessThanOrEqual(100);
      expect(ch.gear[i]).toBeGreaterThanOrEqual(1);
      expect(ch.gear[i]).toBeLessThanOrEqual(P.machine.gearRatios.length);
      expect(Number.isInteger(ch.gear[i])).toBe(true);
    }
  });

  it('shuts the throttle under braking and opens it on the way out', () => {
    const line = cornerLine();
    const env = solve(line, P);
    const ch = riderChannels(line, env, P);
    // the slowest point is the apex; find it
    let apex = 0;
    for (let i = 1; i < env.v.length; i++) if (env.v[i] < env.v[apex]) apex = i;
    const beforeApex = ch.tps[Math.max(0, apex - 30)];
    const afterApex = ch.tps[Math.min(ch.tps.length - 1, apex + 80)];
    expect(beforeApex).toBeLessThan(40);
    expect(afterApex).toBeGreaterThan(beforeApex);
  });

  it('delays the throttle more when throttleDelayS is larger', () => {
    const line = cornerLine();
    const env = solve(line, P);
    const quick = riderChannels(line, env, clampParams({ ...P, rider: { ...P.rider, throttleDelayS: 0 } }));
    const slow = riderChannels(line, env, clampParams({ ...P, rider: { ...P.rider, throttleDelayS: 1.5 } }));
    let apex = 0;
    for (let i = 1; i < env.v.length; i++) if (env.v[i] < env.v[apex]) apex = i;
    const at = Math.min(env.v.length - 1, apex + 20);
    expect(slow.tps[at]).toBeLessThan(quick.tps[at]);
  });

  it('reports TC intervention only where the drive demand is high', () => {
    const line = cornerLine();
    const ch = riderChannels(line, solve(line, P), P);
    expect(ch.dtc.every((d) => d >= 0 && d <= 100)).toBe(true);
    // no intervention while hard on the brakes at the start of the braking zone
    expect(Math.max(...Array.from(ch.dtc.slice(0, 50)))).toBe(0);
  });

  it('rises through the gears as speed rises', () => {
    const line = cornerLine();
    const env = solve(line, P);
    const ch = riderChannels(line, env, P);
    let fastest = 0;
    let slowest = 0;
    for (let i = 1; i < env.v.length; i++) {
      if (env.v[i] > env.v[fastest]) fastest = i;
      if (env.v[i] < env.v[slowest]) slowest = i;
    }
    expect(ch.gear[fastest]).toBeGreaterThanOrEqual(ch.gear[slowest]);
  });
});
