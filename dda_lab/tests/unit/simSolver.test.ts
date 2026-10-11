import { describe, expect, it } from 'vitest';
import { G, brakeShare, lossDecelMs2, solve, topSpeedMs } from '../../src/sim/solver';
import { clampParams, DEFAULT_SIM_PARAMS, presetById } from '../../src/sim/presets';
import type { Line, SimParams } from '../../src/sim/types';
import type { LngLat } from '../../src/core/types';
import { buildLine } from '../../src/sim/line';
import { circuitTrack } from './circuitFixture';

/**
 * The TYRE's longitudinal demand at every sample, g, which is what every
 * friction assertion in this file is about.
 *
 * `Envelope.longG` is the NET longitudinal acceleration, and since the
 * backward pass learned that aero and rolling losses assist braking it
 * contains a term the contact patch never carries: a -1.25 g braking peak at
 * 250 km/h is 0.85 g of front tyre and 0.40 g of air. These tests were written
 * when the two were the same number.
 */
function tyreLongG(env: { longG: Float32Array; v: Float32Array }, machine: { cdA: number; massKg: number }): number[] {
  const out: number[] = [];
  for (let i = 0; i < env.longG.length; i++) out.push(env.longG[i] + lossDecelMs2(machine, env.v[i]) / G);
  return out;
}

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
 * Entry straight -> LINEAR CURVATURE RAMP -> constant arc -> exit straight.
 *
 * `cornerLine` cannot be used to test trail braking and never could: its
 * curvature steps from 0 straight to 1/r, so every sample is either dead
 * upright (lateral use 0, where the friction ellipse leaves braking the whole
 * longitudinal share and the trail-brake parameters are irrelevant BY
 * DEFINITION) or already pinned at the lateral limit (lateral use 1, where the
 * ellipse leaves nothing). There is no sample in between, so no trail-brake
 * model of any shape can change the lap time on it. The old
 * "carrying the brakes deeper gives a faster lap" test ran on `cornerLine` and
 * passed on a difference of 4e-8 s — a float32 rounding artefact at
 * `latUse = 1`, not an effect. It could not fail for the right reason.
 *
 * A real corner entry has a ramp, and that ramp is exactly where trail braking
 * lives: lean is building while the brakes are still on. 80 m of ramp at 1 m
 * sampling gives the backward pass ~80 samples spread across the whole
 * lateral-use range from 0 to 1.
 */
export function rampedCornerLine(radiusM = 40, entryM = 500, rampM = 80, arcM = 60, exitM = 150): Line {
  const n = entryM + rampM + arcM + exitM;
  const curvature = new Float32Array(n);
  const cumDistM = new Float64Array(n);
  const points: LngLat[] = [];
  const lat0 = 41.073;
  const lng0 = 23.518;
  const mPerDegLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  for (let i = 0; i < n; i++) {
    cumDistM[i] = i;
    points.push([lng0 + i / mPerDegLng, lat0]);
    if (i < entryM) curvature[i] = 0;
    else if (i < entryM + rampM) curvature[i] = ((i - entryM + 1) / rampM) / radiusM;
    else if (i < entryM + rampM + arcM) curvature[i] = 1 / radiusM;
    else curvature[i] = 0;
  }
  return { points, curvature, cumDistM, lengthM: n, offsetM: new Float32Array(n) };
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

  it('never exceeds the lean limit, on a configuration where the lean limit binds', () => {
    // T2: at DEFAULT_SIM_PARAMS this test could not fail. mu*gripScale = 1.33
    // against tan(58 * 0.95 deg) = 1.63, so the TYRE binds and the lean angle
    // settles at atan(1.33) = 53.03 deg against an asserted ceiling of 55.6 —
    // deleting `Math.tan(leanLimitDeg)` from `aLatMax` entirely left it green.
    // A grippy tyre with a deliberately low lean ceiling makes the lean limit
    // the binding constraint by a factor of nearly four.
    const p = clampParams({
      ...P,
      tyre: { ...P.tyre, mu: 1.8, gripScale: 1.2, maxLeanDeg: 30 },
      rider: { ...P.rider, leanUsage: 1 },
    });
    const leanLimitDeg = p.tyre.maxLeanDeg * p.rider.leanUsage;
    // the lean limit really is what binds here, not mu
    expect(Math.tan((leanLimitDeg * Math.PI) / 180)).toBeLessThan(p.tyre.mu * p.tyre.gripScale);
    const env = solve(circleLine(40), p);
    const maxLean = Math.max(...Array.from(env.leanDeg, Math.abs));
    expect(maxLean).toBeLessThanOrEqual(leanLimitDeg + 0.5);
    // and it is actually reached, so dropping the lean term from aLatMax —
    // which would put the lean angle at atan(2.16) = 65.2 deg — turns this red
    expect(maxLean).toBeGreaterThan(leanLimitDeg - 0.5);
  });

  it('gets faster with more braking g and slower with less grip', () => {
    // T1: this used `circleLine(60)`, where a constant-radius line asks for the
    // same speed all the way round and the braking pass never binds at all —
    // brakingG 1.1 -> 1.4 moved the lap time by EXACTLY 0, which the old
    // `toBeLessThanOrEqual(base + 1e-6)` accepted. `simStore.test.ts` and
    // `simLine.test.ts` both already document that a circle makes brakingG
    // inert. `cornerLine()` has an entry straight to brake down, so the
    // braking pass is load-bearing and the comparison can be strict.
    const line = cornerLine();
    const base = solve(line, P).lapTimeS;
    const harder = solve(line, clampParams({ ...P, rider: { ...P.rider, brakingG: P.rider.brakingG + 0.2 } })).lapTimeS;
    const slippery = solve(line, clampParams({ ...P, tyre: { ...P.tyre, mu: P.tyre.mu - 0.3 } })).lapTimeS;
    // braking is friction-limited (I3), so brakingG only buys time while it is
    // under mu*gripScale, so the step has to stay inside it to be a real one
    expect(P.rider.brakingG + 0.2).toBeLessThan(P.tyre.mu * P.tyre.gripScale);
    expect(harder).toBeLessThan(base);
    expect(slippery).toBeGreaterThan(base);
  });

  it('cannot out-brake its own friction', () => {
    // I3: braking used `brakingG * G` with no reference to mu at all, so a
    // mu*gripScale of 0.24 still decelerated at 1.541 g — 6.4x the available
    // friction — and that spare deceleration is most of what let grip_use
    // reach 1.65-1.80. Deceleration must now be bounded by the tyre.
    const line = cornerLine();
    const p = clampParams({
      ...P,
      tyre: { ...P.tyre, mu: 0.6, gripScale: 0.4 },
      rider: { ...P.rider, brakingG: 1.6, trailBrakeDepth: 1 },
    });
    const mu = p.tyre.mu * p.tyre.gripScale;
    expect(mu).toBeCloseTo(0.24, 6);
    const env = solve(line, p);
    const hardest = Math.min(...tyreLongG(env, p.machine));
    expect(hardest).toBeGreaterThan(-(mu + 0.01));
    // and it really does brake, so a dead longG channel cannot pass
    expect(hardest).toBeLessThan(-0.1);
    // the NET deceleration is allowed past mu, and is, because drag and
    // rolling losses are not carried by the tyre
    expect(Math.min(...Array.from(env.longG))).toBeLessThan(-(mu + 0.05));
    // the willing-but-unavailable case is the whole point: asking for 1.6 g on
    // this tyre must give the same profile as asking for exactly mu
    const atMu = solve(line, clampParams({ ...p, rider: { ...p.rider, brakingG: mu } }));
    expect(env.lapTimeS).toBeCloseTo(atMu.lapTimeS, 6);
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
      rider: {
        aggressiveness: 0, risk: 0, overrides: [], sBrake: 0, sDrive: 0, sLat: 0, rollOnS: 0, rollRateFrac: 0,
        lineDeviationM: 0, brakingG: 0, brakeRiseGps: 0, throttleDelayS: 0, tcThreshold: 0, leanUsage: 0, kappa: 0, trailBrakeDepth: 0, trailBrakeProfile: 0,
      },
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
    // Trail braking needs a corner ENTRY, not just a corner: see
    // `rampedCornerLine` for why `cornerLine` cannot show this at all.
    const line = rampedCornerLine();
    const upright = solve(line, clampParams({ ...P, rider: { ...P.rider, trailBrakeDepth: 0 } }));
    const deep = solve(line, clampParams({ ...P, rider: { ...P.rider, trailBrakeDepth: 1 } }));
    // not just "less": 0.47 s on an 18 s fixture, measured. A 1e-9 difference
    // is a rounding artefact, which is exactly what the old version of this
    // test was asserting.
    expect(upright.lapTimeS - deep.lapTimeS).toBeGreaterThan(0.25);
  });

  describe('brakeShare: the two trail-brake axes', () => {
    const grid = [0, 0.25, 0.5, 0.75, 1];

    it('gives the full longitudinal share at zero lean, whatever either slider says', () => {
      // The one property that makes the pair meaningful: straight-line braking
      // is not a rider choice. Both parameters must be inert at zero lateral
      // use, and the share must be the ellipse's own 1.0.
      for (const d of grid) for (const q of grid) expect(brakeShare(0, d, q)).toBe(1);
    });

    it('reaches zero at the tyre limit and never exceeds the friction ellipse', () => {
      for (const d of grid) {
        for (const q of grid) {
          expect(brakeShare(1, d, q)).toBe(0);
          for (let u = 0; u <= 1.0001; u += 0.01) {
            const share = brakeShare(u, d, q);
            expect(share).toBeLessThanOrEqual(Math.sqrt(Math.max(0, 1 - u * u)) + 1e-12);
            expect(share).toBeGreaterThanOrEqual(0);
          }
        }
      }
    });

    it('stops braking at the depth limit and nowhere short of it', () => {
      // depth IS the extent: the lateral use at which the share hits zero.
      // 0 -> TB_MIN_REACH (0.2); 1 -> the whole lateral range.
      for (const q of grid) {
        expect(brakeShare(0.19, 0, q)).toBeGreaterThan(0);
        expect(brakeShare(0.21, 0, q)).toBe(0);
        expect(brakeShare(0.59, 0.5, q)).toBeGreaterThan(0);
        expect(brakeShare(0.61, 0.5, q)).toBe(0);
        expect(brakeShare(0.99, 1, q)).toBeGreaterThan(0);
      }
    });

    it('is monotone in lean, in depth and in profile, with no step anywhere', () => {
      for (const d of grid) {
        for (const q of grid) {
          let prev = Infinity;
          for (let u = 0; u <= 1.0001; u += 0.0005) {
            const share = brakeShare(u, d, q);
            expect(share).toBeLessThanOrEqual(prev + 1e-12);
            // Continuity, and quantitatively: over a 0.0005 step in lateral
            // use the share may not fall by more than 0.03. The bound is what
            // rules out the fractional-exponent shape this started as, which
            // dropped 0.49 over 0.002 at the depth limit. The worst real case
            // is depth 0 (the narrowest taper, uLim = 0.2) at profile 1 (the
            // steepest landing, slope 8 in x): 8 * 0.0005/0.2 = 0.02.
            if (Number.isFinite(prev)) expect(prev - share).toBeLessThan(0.03);
            prev = share;
          }
        }
      }
      // monotone in each parameter at a lean where both are live
      for (const u of [0.1, 0.3, 0.5, 0.8]) {
        for (const q of grid) {
          for (let i = 1; i < grid.length; i++) {
            expect(brakeShare(u, grid[i], q)).toBeGreaterThanOrEqual(brakeShare(u, grid[i - 1], q));
          }
        }
        for (const d of grid) {
          for (let i = 1; i < grid.length; i++) {
            expect(brakeShare(u, d, grid[i])).toBeGreaterThanOrEqual(brakeShare(u, d, grid[i - 1]));
          }
        }
      }
    });

    it('moves the lap time along BOTH axes independently — no flat row, no flat column', () => {
      // This is the defect being fixed. `trailBrakeProfile` used to be a
      // brake-release RATE in rider.ts, downstream of the envelope, so it
      // could not move the lap time by a single microsecond and the user
      // reported it as doing nothing. A 3x3 grid, and every row AND every
      // column has to carry a real spread.
      const line = rampedCornerLine();
      const axis = [0, 0.5, 1];
      const lap = (d: number, q: number): number =>
        solve(line, clampParams({ ...P, rider: { ...P.rider, trailBrakeDepth: d, trailBrakeProfile: q } })).lapTimeS;
      const cell = axis.map((d) => axis.map((q) => lap(d, q)));
      // measured spreads: rows (profile, depth fixed) 0.29-0.94 s, columns
      // (depth, profile fixed) 0.47-1.12 s, on an 18 s fixture
      for (let i = 0; i < 3; i++) {
        expect(cell[i][0] - cell[i][2]).toBeGreaterThan(0.15); // braver = faster
        expect(cell[i][0] - cell[i][1]).toBeGreaterThan(0.03);
        expect(cell[i][1] - cell[i][2]).toBeGreaterThan(0.03);
        expect(cell[0][i] - cell[2][i]).toBeGreaterThan(0.25); // deeper = faster
        expect(cell[0][i] - cell[1][i]).toBeGreaterThan(0.1);
        expect(cell[1][i] - cell[2][i]).toBeGreaterThan(0.1);
      }
    });

    it('brakes at the full rate on the entry straight for every setting of either slider', () => {
      // The envelope's own statement of the zero-lean property: on the
      // dead-straight part of the entry the peak deceleration is the rider's
      // own `brakingG`, identically, for all nine combinations.
      const line = rampedCornerLine();
      const peaks: number[] = [];
      for (const d of [0, 0.5, 1]) {
        for (const q of [0, 0.5, 1]) {
          const env = solve(line, clampParams({ ...P, rider: { ...P.rider, trailBrakeDepth: d, trailBrakeProfile: q } }));
          const tyre = tyreLongG(env, P.machine);
          let peak = 0;
          for (let i = 0; i < 500; i++) peak = Math.min(peak, tyre[i]);
          peaks.push(peak);
        }
      }
      // the rider's own brakingG, and the same to 5e-5 g across all nine
      // combinations — the residual is the braking point landing on a
      // different sample, not a different deceleration
      //
      // The 2e-3 g tolerance (0.2 % of brakingG) is a half-sample offset, not
      // slack: the backward pass reads the loss term at `v[j]`, the segment's
      // far end, while `tyreLongG` adds it back at `v[i]`, and `longG[i]` is
      // itself the mean of two segments. It was an exact equality while there
      // was no loss term to be half a sample out of step with.
      expect(Math.abs(peaks[0] + Math.min(P.rider.brakingG, P.tyre.mu * P.tyre.gripScale))).toBeLessThan(2e-3);
      // 5e-5 rather than the old 1e-5 for the same reason as the tolerance
      // above: the nine combinations put the braking point on slightly
      // different samples, and the loss term they are each read at differs
      // with the speed at that sample. Measured spread: 1.1e-5 g.
      for (const peak of peaks) expect(Math.abs(peak - peaks[0])).toBeLessThan(5e-5);
    });

    it('carries the brakes to a higher lean the deeper and braver the rider is', () => {
      // The envelope-level reading of "extent": how far round the corner
      // entry there is still measurable deceleration.
      const line = rampedCornerLine();
      const mu = P.tyre.mu * P.tyre.gripScale;
      const aLatMaxG = Math.min(mu, Math.tan((P.tyre.maxLeanDeg * P.rider.leanUsage * Math.PI) / 180));
      const deepestLatUse = (d: number, q: number): number => {
        const env = solve(line, clampParams({ ...P, rider: { ...P.rider, trailBrakeDepth: d, trailBrakeProfile: q } }));
        // the TYRE braking, not the net g: at full lean the bike still sheds
        // speed to drag with the brakes fully released, so reading the net
        // channel reports every setting as carrying the brakes to the limit
        const tyre = tyreLongG(env, P.machine);
        let worst = 0;
        for (let i = 0; i < tyre.length; i++) {
          if (tyre[i] < -0.05) worst = Math.max(worst, Math.abs(env.latG[i]) / aLatMaxG);
        }
        return worst;
      };
      const shallow = deepestLatUse(0, 1);
      const deep = deepestLatUse(1, 1);
      expect(deep - shallow).toBeGreaterThan(0.3);
      // and the depth limit really is a limit: at depth 0 braking is over
      // well before the bike is properly leaned
      expect(shallow).toBeLessThan(0.45);
      const timid = deepestLatUse(1, 0);
      expect(deep - timid).toBeGreaterThan(0.05);
    });
  });

  describe('traction control responds to slip demand, not to nothing', () => {
    it('does not touch the drive while the bike is upright, at any threshold', () => {
      // The defect: `tcFactor = 0.6 + 0.4 * tcThreshold` was a CONSTANT
      // multiplier on the longitudinal grip term, so at the shipped 0.5 it
      // discarded 20 % of the available grip bolt upright, where there is no
      // lateral load to make the rear slip. Nothing a traction control does is
      // visible on a straight line.
      // `cornerLine` is the right fixture: its only drive phase is the exit
      // straight, at zero curvature, because the arc is pinned at the lateral
      // limit and the entry straight is already at top speed. (A bare
      // `straightLine` would NOT do — pass 1 puts the whole line at top speed,
      // so the forward pass never binds there and any assertion about it is
      // vacuous.)
      const line = cornerLine();
      const open = solve(line, clampParams({ ...P, rider: { ...P.rider, tcThreshold: 1 } })).lapTimeS;
      const strict = solve(line, clampParams({ ...P, rider: { ...P.rider, tcThreshold: 0 } })).lapTimeS;
      // Measured: 0.004 s apart, the residual being the single arc sample that
      // still carries lateral load while driving. With the old constant
      // multiplier they are 0.86 s apart — a 200x margin either side of this
      // threshold, so it cannot pass by accident in either direction.
      expect(Math.abs(strict - open)).toBeLessThan(0.02);
    });

    it('still cuts the drive when the bike is leaned, by a margin worth having', () => {
      const { track, corridor } = circuitTrack(6, 2, 0.25);
      const line = buildLine(track, corridor, P);
      const open = solve(line, clampParams({ ...P, rider: { ...P.rider, tcThreshold: 1 } })).lapTimeS;
      const strict = solve(line, clampParams({ ...P, rider: { ...P.rider, tcThreshold: 0 } })).lapTimeS;
      // measured 0.93 s on a 61 s lap
      expect(strict - open).toBeGreaterThan(0.3);
    });
  });

  it('never lets the tyre demand exceed the friction circle on its own output', () => {
    for (const r of [40, 80, 200]) {
      const env = solve(circleLine(r), P);
      const worst = Math.max(...Array.from(env.gripUse));
      expect(Number.isFinite(worst)).toBe(true);
      // I1: the old ceiling here was 1.1 and the comment called the 1.001-1.044
      // it was absorbing "numerical slack". It was not: longG[i] was the mean
      // acceleration over the segment i -> i+1 while latG[i] was a point value
      // at i, and gripUse combined the two. With longG[i] averaged onto the
      // point, what is left is genuine discretisation and the ceiling can be
      // tight. 1.01 is still 1.4x the worst residual measured anywhere in a
      // 225-point parameter sweep (1.0072, see sim/risk.ts).
      expect(worst).toBeLessThan(1.01);
    }
  });

  it('reports grip use as point quantities, so a real lap stays inside the circle', () => {
    // I1, the index stagger. `longG[i]` used to be the mean acceleration over
    // the SEGMENT i -> i+1, while `latG[i]` was a point value at i, and
    // `gripUse` combined the two — so a corner entry, where both demands move
    // fast, compared the lateral demand AT i against the longitudinal demand
    // just AFTER i. On the 3044 m synthetic circuit at the shipped defaults
    // that put the peak at 1.0164 with 5.5 % of samples over 0.98, which is
    // what tripped the panel's risk banner on its own default configuration.
    // With `longG[i]` averaged onto the point it is 1.0047.
    //
    // The circle fixtures above cannot see this: their curvature never changes,
    // so there is nothing for the two indices to disagree about.
    const { track, corridor } = circuitTrack(6, 2, 0.25);
    const env = solve(buildLine(track, corridor, P), P);
    let peak = 0;
    for (let i = 0; i < env.gripUse.length; i++) peak = Math.max(peak, env.gripUse[i]);
    expect(peak).toBeLessThan(1.01);
    // and the lap really does use the tyre, so a dead gripUse cannot pass
    expect(peak).toBeGreaterThan(0.9);
  });

  it('writes lean in the app convention, consistent with lat_g', () => {
    // C1 (latent): `Envelope.leanDeg` used to be documented and written as
    // "positive = leaning left", which is the OPPOSITE of the convention every
    // recorded lap in the app uses — `fillMissingChannels` estimates lean as
    // -atan(v^2 k / g), i.e. left = NEGATIVE. The refresh overwrite masked it;
    // with the overwrite gone the sim's lean trace would have been upside down
    // against every real lap in the chart stack.
    const env = solve(circleLine(40), P); // curvature +, i.e. a LEFT turn
    let sawTurn = false;
    for (let i = 0; i < env.leanDeg.length; i++) {
      if (Math.abs(env.latG[i]) < 0.2) continue;
      sawTurn = true;
      // left turn: lat_g positive, lean negative
      expect(env.latG[i]).toBeGreaterThan(0);
      expect(env.leanDeg[i]).toBeLessThan(0);
      // and the two are the same quantity: tan(lean) = -lat_g
      expect(Math.tan((env.leanDeg[i] * Math.PI) / 180)).toBeCloseTo(-env.latG[i], 6);
    }
    expect(sawTurn).toBe(true);
    // a right-hand corner is the mirror image
    const right = circleLine(40);
    for (let i = 0; i < right.curvature.length; i++) right.curvature[i] = -right.curvature[i];
    const envR = solve(right, P);
    const worstLean = Math.max(...Array.from(envR.leanDeg));
    expect(worstLean).toBeGreaterThan(40);
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
