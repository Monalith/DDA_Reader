import { describe, expect, it } from 'vitest';
import { G, solve, topSpeedMs } from '../../src/sim/solver';
import { clampParams, DEFAULT_SIM_PARAMS, presetById } from '../../src/sim/presets';
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

/**
 * A closed loop of `n` vertices at a uniform 1 m spacing, flat except for a
 * `lenV`-vertex constant-radius corner starting at index `start` (wrapping).
 *
 * Uniform spacing makes the fixture exactly rotation-invariant: `dsAt` returns
 * the same value at every index including the start-line wrap, so rotating
 * `start` can only change the lap time if the solver's passes are themselves
 * position-dependent — which is the thing under test.
 */
function cornerLoop(n: number, start: number, lenV: number, radiusM: number): Line {
  const curvature = new Float32Array(n);
  for (let j = 0; j < lenV; j++) curvature[(start + j) % n] = 1 / radiusM;
  const cumDistM = new Float64Array(n);
  const points: LngLat[] = [];
  const lat0 = 41.073;
  const lng0 = 23.518;
  const mPerDegLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  for (let i = 0; i < n; i++) {
    cumDistM[i] = i;
    points.push([lng0 + i / mPerDegLng, lat0]);
  }
  return { points, curvature, cumDistM, lengthM: n, offsetM: new Float32Array(n) };
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

  it('does not report over-the-limit grip on a lean-limited bike it can ride', () => {
    // I3: gripUse used to divide the lateral term by aLatMax/G =
    // min(mu, tan(leanLimit)) and the longitudinal term by mu, which is an
    // ellipse, not the friction circle it claims to be. On the 250 the lean
    // limit binds first (tan(52 * 0.95 deg) = 1.17 against mu = 1.25), so a
    // corner the bike is comfortably inside the tyre's capability on read
    // 1.0 laterally and the UI warned the lap "cannot be ridden".
    const p = clampParams({
      machine: { presetId: '250', ...presetById('250').machine },
      tyre: { ...presetById('250').tyre },
      rider: { ...P.rider, kappa: presetById('250').kappa },
    });
    // the lean limit really is the binding constraint for this preset
    const mu = p.tyre.mu * p.tyre.gripScale;
    const tanLean = Math.tan((p.tyre.maxLeanDeg * p.rider.leanUsage * Math.PI) / 180);
    expect(tanLean).toBeLessThan(mu);
    // A corner long enough to settle at the lean limit, on a closed loop so
    // the wrap segment is a real one. With the old ellipse normalisation this
    // fixture reported 1.0021 — the UI's "cannot be ridden" threshold — on a
    // lap a Ninja 400 rides on a Sunday.
    for (const line of [cornerLoop(1200, 0, 300, 60), cornerLoop(1200, 0, 120, 40), circleLine(40)]) {
      const env = solve(line, p);
      const worst = Math.max(...Array.from(env.gripUse));
      expect(worst).toBeLessThan(1);
      // at the lean limit the tyre is being asked for tanLean of a possible
      // mu, so the fraction of the friction CIRCLE in use is tanLean/mu
      expect(worst).toBeCloseTo(tanLean / mu, 2);
    }
  });

  it('is not fooled by a braking zone that straddles the start line', () => {
    // I4: cutting the braking and acceleration passes from two laps of the
    // loop to one left every test green. The second pass is what lets a
    // braking zone carry backwards ACROSS index 0: in a single descending
    // pass, index n-1 is visited before index 0 has been slowed, so a corner
    // just after the start line gets a truncated braking zone and the lap
    // comes out spuriously fast.
    //
    // 60 m radius at this bike's grip needs ~28 m/s, and arriving from near
    // top speed takes ~250 m of braking, so a corner at index 10 of a 1000 m
    // loop needs to brake from about index 760 — well across the wrap.
    const straddling = solve(cornerLoop(1000, 10, 60, 60), P).lapTimeS;
    const clear = solve(cornerLoop(1000, 500, 60, 60), P).lapTimeS;
    expect(straddling).toBeCloseTo(clear, 2);
  });

  it('respects the wheelie limit where it is the binding constraint', () => {
    // I4: dropping aWheelie from the Math.min left every test green, because
    // at default parameters it never binds (1.28 g against aGrip*tcFactor of
    // 1.07 g). A tall, short-wheelbase, grippy, powerful configuration makes
    // it the limit by a wide margin.
    const p = clampParams({
      machine: { ...P.machine, powerKw: 400, massKg: 150, cgHeightM: 1.0, wheelbaseM: 1.0, cdA: 0.1 },
      tyre: { mu: 1.8, maxLeanDeg: 70, kerbMarginM: 0.4, gripScale: 1.2 },
      rider: { ...P.rider, tcThreshold: 1 },
    });
    const aWheelieG = (p.machine.wheelbaseM / (2 * p.machine.cgHeightM)); // in g
    expect(aWheelieG).toBeCloseTo(0.5, 6);
    // it really is the smallest of the three on a straight
    const aGripG = p.tyre.mu * p.tyre.gripScale * (0.6 + 0.4 * p.rider.tcThreshold);
    expect(aWheelieG).toBeLessThan(aGripG);
    // A closed loop, not `straightLine`: that fixture's cumDistM does not
    // wrap, so its final segment is a 0.05 m stub carrying the whole
    // top-speed-to-start-speed drop and longG there is meaningless. A 40 m
    // corner gives the bike something to accelerate away from.
    const env = solve(cornerLoop(3000, 0, 100, 40), p);
    const peak = Math.max(...Array.from(env.longG));
    // the front wheel limit caps acceleration; without it this configuration
    // would pull well over 2 g
    expect(peak).toBeLessThanOrEqual(aWheelieG + 1e-3);
    // and it is actually reached, so the test would notice if it stopped binding
    expect(peak).toBeGreaterThan(aWheelieG * 0.8);
  });

  it('reports non-zero grip use for hard braking in a straight line', () => {
    // I4: setting gripUse[i] = lu (dropping the longitudinal term) left every
    // test green, so only the lateral half was covered. On the entry straight
    // of the corner fixture the curvature is exactly zero and the bike is
    // braking hard, so all of the demand is longitudinal.
    const line = cornerLine();
    const env = solve(line, P);
    let worstStraight = 0;
    let brakingG = 0;
    for (let i = 0; i < line.curvature.length; i++) {
      if (line.curvature[i] !== 0) continue;
      if (env.longG[i] < brakingG) brakingG = env.longG[i];
      if (env.latG[i] === 0) worstStraight = Math.max(worstStraight, env.gripUse[i]);
    }
    expect(brakingG).toBeLessThan(-0.5); // there is real braking there
    expect(worstStraight).toBeGreaterThan(0.3);
  });
});
