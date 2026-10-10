import { describe, expect, it } from 'vitest';
import { G, solve, topSpeedMs } from '../../src/sim/solver';
import { clampParams, DEFAULT_SIM_PARAMS } from '../../src/sim/presets';
import type { Line, SimParams } from '../../src/sim/types';
import type { LngLat } from '../../src/core/types';

/** A perfectly circular line of constant radius, as the solver sees it. */
function circleLine(radiusM: number, n = 400): Line {
  const points: LngLat[] = [];
  const lat0 = 41.073;
  const lng0 = 23.518;
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    points.push([lng0 + (radiusM * Math.cos(a)) / mPerDegLng, lat0 + (radiusM * Math.sin(a)) / mPerDegLat]);
  }
  const step = (2 * Math.PI * radiusM) / n;
  const cumDistM = new Float64Array(n);
  for (let i = 1; i < n; i++) cumDistM[i] = cumDistM[i - 1] + step;
  return {
    points,
    curvature: new Float32Array(n).fill(1 / radiusM),
    cumDistM,
    lengthM: step * n,
    offsetM: new Float32Array(n),
  };
}

/** A dead-straight line of `lengthM`. */
function straightLine(lengthM: number, n = 400): Line {
  const points: LngLat[] = [];
  const lat0 = 41.073;
  const lng0 = 23.518;
  const mPerDegLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const cumDistM = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const s = (lengthM * i) / (n - 1);
    cumDistM[i] = s;
    points.push([lng0 + s / mPerDegLng, lat0]);
  }
  return { points, curvature: new Float32Array(n), cumDistM, lengthM, offsetM: new Float32Array(n) };
}

/**
 * A straight-corner-straight fixture: a long entry straight (room to brake
 * from top speed), a constant-radius 90-degree corner, and a short exit
 * straight. This is the minimum geometry that gives trail braking something
 * to mean: on a constant-radius circle there is no braking zone to carry the
 * brakes into, because the whole line already asks for the same speed.
 *
 * Only `curvature`, `cumDistM` and `lengthM` are geometrically meaningful to
 * the solver; `points` is filler of the right length.
 */
export function cornerLine(radiusM = 40, entryM = 400, exitM = 150, nPerM = 1): Line {
  const arcLenM = (Math.PI / 2) * radiusM; // 90 degrees
  const nEntry = Math.max(2, Math.round(entryM * nPerM));
  const nArc = Math.max(2, Math.round(arcLenM * nPerM));
  const nExit = Math.max(2, Math.round(exitM * nPerM));
  const n = nEntry + nArc + nExit;
  const curvature = new Float32Array(n);
  const cumDistM = new Float64Array(n);
  const points: LngLat[] = [];
  const lat0 = 41.073;
  const lng0 = 23.518;
  const mPerDegLng = 111320 * Math.cos((lat0 * Math.PI) / 180);

  const dsEntry = entryM / nEntry;
  const dsArc = arcLenM / nArc;
  const dsExit = exitM / nExit;

  let s = 0;
  for (let i = 0; i < nEntry; i++) {
    cumDistM[i] = s;
    curvature[i] = 0;
    points.push([lng0 + s / mPerDegLng, lat0]);
    s += dsEntry;
  }
  for (let i = 0; i < nArc; i++) {
    const idx = nEntry + i;
    cumDistM[idx] = s;
    curvature[idx] = 1 / radiusM;
    points.push([lng0 + s / mPerDegLng, lat0]);
    s += dsArc;
  }
  for (let i = 0; i < nExit; i++) {
    const idx = nEntry + nArc + i;
    cumDistM[idx] = s;
    curvature[idx] = 0;
    points.push([lng0 + s / mPerDegLng, lat0]);
    s += dsExit;
  }

  return { points, curvature, cumDistM, lengthM: s, offsetM: new Float32Array(n) };
}

const P: SimParams = clampParams(DEFAULT_SIM_PARAMS);

describe('solve', () => {
  it('matches the analytic lap time of a constant-radius circle', () => {
    const r = 80;
    const line = circleLine(r);
    const env = solve(line, P);
    // grip-limited speed on a circle: v = sqrt(a_lat * r)
    const aLat = Math.min(P.tyre.mu * P.tyre.gripScale, Math.tan((P.tyre.maxLeanDeg * P.rider.leanUsage * Math.PI) / 180)) * G;
    const vExpected = Math.sqrt(aLat * r);
    const tExpected = line.lengthM / vExpected;
    expect(env.lapTimeS).toBeGreaterThan(tExpected * 0.95);
    expect(env.lapTimeS).toBeLessThan(tExpected * 1.05);
  });

  it('clamps a straight to the drag-limited top speed instead of infinity', () => {
    const env = solve(straightLine(3000), P);
    const vMax = Math.max(...Array.from(env.v));
    expect(Number.isFinite(vMax)).toBe(true);
    expect(vMax).toBeLessThanOrEqual(topSpeedMs(P) * 1.01);
    expect(env.v.every((v) => Number.isFinite(v) && v > 0)).toBe(true);
  });

  it('never exceeds the lean limit', () => {
    const env = solve(circleLine(40), P);
    const maxLean = Math.max(...Array.from(env.leanDeg, Math.abs));
    expect(maxLean).toBeLessThanOrEqual(P.tyre.maxLeanDeg * P.rider.leanUsage + 0.5);
  });

  it('gets faster with more braking g and slower with less grip', () => {
    const line = circleLine(60);
    const base = solve(line, P).lapTimeS;
    const harder = solve(line, clampParams({ ...P, rider: { ...P.rider, brakingG: P.rider.brakingG + 0.3 } })).lapTimeS;
    const slippery = solve(line, clampParams({ ...P, tyre: { ...P.tyre, mu: P.tyre.mu - 0.3 } })).lapTimeS;
    expect(harder).toBeLessThanOrEqual(base + 1e-6);
    expect(slippery).toBeGreaterThan(base);
  });

  it('gets faster with more power', () => {
    const line = straightLine(2000);
    const base = solve(line, P).lapTimeS;
    const strong = solve(line, clampParams({ ...P, machine: { ...P.machine, powerKw: P.machine.powerKw * 1.5 } })).lapTimeS;
    expect(strong).toBeLessThan(base);
  });

  it('returns a finite profile with every parameter at its minimum', () => {
    const broken = clampParams({
      machine: { ...P.machine, powerKw: 0, massKg: 0, cdA: 0, cgHeightM: 0, wheelbaseM: 0 },
      tyre: { mu: 0, maxLeanDeg: 0, kerbMarginM: 0, gripScale: 0 },
      rider: { lineDeviationM: 0, brakingG: 0, throttleDelayS: 0, tcThreshold: 0, leanUsage: 0, kappa: 0, trailBrakeDepth: 0, trailBrakeProfile: 0 },
    });
    const env = solve(circleLine(60), broken);
    expect(Number.isFinite(env.lapTimeS)).toBe(true);
    expect(env.lapTimeS).toBeGreaterThan(0);
    expect(env.v.every((v) => Number.isFinite(v) && v > 0)).toBe(true);
    expect(env.longG.every(Number.isFinite)).toBe(true);
    expect(env.latG.every(Number.isFinite)).toBe(true);
  });

  it('produces a monotonically increasing time vector', () => {
    const env = solve(circleLine(60), P);
    for (let i = 1; i < env.tS.length; i++) expect(env.tS[i]).toBeGreaterThan(env.tS[i - 1]);
  });

  it('carrying the brakes deeper gives a faster lap than braking upright', () => {
    // A corner needs a braking zone for trail braking to mean anything, so use
    // the straight-then-corner line rather than a constant-radius circle.
    const line = cornerLine();
    const upright = solve(line, clampParams({ ...P, rider: { ...P.rider, trailBrakeDepth: 0 } }));
    const deep = solve(line, clampParams({ ...P, rider: { ...P.rider, trailBrakeDepth: 1 } }));
    expect(deep.lapTimeS).toBeLessThan(upright.lapTimeS);
  });

  it('never lets the tyre demand exceed the friction circle on its own output', () => {
    for (const r of [40, 80, 200]) {
      const env = solve(circleLine(r), P);
      const worst = Math.max(...Array.from(env.gripUse));
      expect(Number.isFinite(worst)).toBe(true);
      // the three passes are what keep this at or under 1; a little numerical
      // slack is expected, a lot would mean a pass is not doing its job
      expect(worst).toBeLessThan(1.1);
    }
  });

  it('reports grip use that actually tracks the demand', () => {
    const tight = solve(circleLine(40), P);
    const open = solve(circleLine(400), P);
    const mean = (a: Float32Array): number => a.reduce((s, x) => s + x, 0) / a.length;
    expect(mean(tight.gripUse)).toBeGreaterThan(mean(open.gripUse));
  });
});
