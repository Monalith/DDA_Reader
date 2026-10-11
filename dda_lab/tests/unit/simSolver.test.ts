import { describe, expect, it } from 'vitest';
import { G, brakeCapMs2, brakeShare, driveCapMs2, lossDecelMs2, solve, topSpeedMs } from '../../src/sim/solver';
import { clampParams, DEFAULT_SIM_PARAMS, presetById } from '../../src/sim/presets';
import { effectiveMu } from '../../src/sim/tyre';
import { bikeLeanRad, idealLeanLimitRad, stoppieLimitMs2, wheelieLimitMs2 } from '../../src/sim/vehicle';
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

// The solver tests probe the PHYSICS at the tyre's ceiling: every allowed-slip
// fraction and the roll-rate share at 1, lean usage at the limit. The shipped
// defaults (derive.ts, A 0.9 / R 0.5) sit below that on purpose; the rider
// tests (simEvents, simRider, simSerres) use those.
const P: SimParams = clampParams({
  ...DEFAULT_SIM_PARAMS,
  rider: { ...DEFAULT_SIM_PARAMS.rider, sBrake: 1, sDrive: 1, sLat: 1, rollRateFrac: 1, leanUsage: 1 },
});

/** The 5-corner synthetic circuit (`circuitFixture.ts`), no jitter, as a Line at P. */
function circuitLine(): Line {
  const { track, corridor } = circuitTrack();
  return buildLine(track, corridor, P);
}

/** Position-weighted sum: any change to any sample moves it. */
function checksum(a: ArrayLike<number>): string {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * ((i % 7) + 1);
  return s.toPrecision(17);
}

/**
 * The v2 envelope on `circuitLine()` at `P`. Recorded after W1 Task 1.4
 * (lap 61.654831) and re-recorded after the roll-rate fix (jerk floor
 * J_Y_MIN = 6 m/s³, ±20 m dφ/ds stencil, 3° lean dead-band): 60.745382.
 * The fix moved it because the roll-rate cap binds less at the corner
 * transitions (rollRateFrac 0.5 / 0.85 / 1: 63.33 / 60.75 / 60.40 s).
 */
// Re-pinned at the W1+W6 merge: W6's presets give the 1000 a 0.25 m hang-off
// (was 0.15) and class-specific crown radii, which moves the lean limit and
// therefore the lateral ceiling; 60.745382 -> 60.452037 on the fixture.
const PIN = {
  // 2026-10-11 merge: P is now the CEILING rider (every slip fraction, the
  // roll-rate share and lean usage at 1) on W6's presets; 59.492084 s.
  lapTimeS: '59.492084',
  v: '343347.87624740601',
  longG: '2.8394868113100529',
  latG: '1824.8698953449493',
  leanDeg: '-73207.890756562352',
  gripUse: '4304.7470043075155',
} as const;

describe('envelope pin (Review Focus 4)', () => {
  // HISTORY. This pin was recorded on the v1 solver (ecaf5e3) and committed
  // alone (617b344) BEFORE any v2 change; the 3D g-budget commit (bcf0440)
  // passed it unchanged, bit for bit:
  //
  //   v1  lapTimeS 60.836382   v 338840.38137817383   longG -3.3443849224427140
  //       latG 1812.5413375199423   leanDeg -81241.075258576311
  //       gripUse 4283.3734395606443
  //
  // The load-transfer / μ_eff / roll-rate commit (Task 1.4) changes the
  // physics on purpose — stoppie and wheelie limits, the crown/hang-off lean
  // limit, the roll-rate cap, the dropped `brakingG` cap and `leanDeg` as the
  // real bike roll — so no parameter setting reproduces v1 any more and the
  // pin now holds the v2 envelope. What Review Focus 4 protects (zero 3D
  // channels change NOTHING) is asserted bit for bit by 'zero-filled channels
  // are bit-identical to absent ones' below, against the live solver.
  it('reproduces the pinned envelope on the circuit fixture at the defaults', () => {
    const env = solve(circuitLine(), P);
    // one object so a legitimate re-pin shows every new value in a single diff
    expect({
      lapTimeS: env.lapTimeS.toFixed(6),
      v: checksum(env.v),
      longG: checksum(env.longG),
      latG: checksum(env.latG),
      leanDeg: checksum(env.leanDeg),
      gripUse: checksum(env.gripUse),
    }).toEqual(PIN);
    expect(Array.from(env.v).slice(0, 50)).toMatchInlineSnapshot(`
      [
        34.410343170166016,
        34.95169448852539,
        35.503787994384766,
        36.0628776550293,
        36.62623596191406,
        37.19100570678711,
        37.754852294921875,
        38.31521987915039,
        38.87134552001953,
        39.42258834838867,
        39.961830139160156,
        40.48799133300781,
        41.00209045410156,
        41.505062103271484,
        41.997859954833984,
        42.481266021728516,
        42.9559440612793,
        43.42247009277344,
        43.88134002685547,
        44.33295822143555,
        44.77762985229492,
        45.21554183959961,
        45.64677047729492,
        46.068145751953125,
        46.4798583984375,
        46.88237762451172,
        47.27613067626953,
        47.66151809692383,
        48.03890609741211,
        48.40864562988281,
        48.771053314208984,
        49.12643051147461,
        49.47505569458008,
        49.81719207763672,
        50.1530876159668,
        50.482975006103516,
        50.807071685791016,
        51.125579833984375,
        51.438697814941406,
        51.746604919433594,
        52.049476623535156,
        52.34747314453125,
        52.640750885009766,
        52.92945861816406,
        53.2137336730957,
        53.49371337890625,
        53.7695198059082,
        54.04127502441406,
        54.30909729003906,
        54.57309341430664,
      ]
    `);
  });
});

describe('3D road g-budget (spec v2 §2.3, R1 §3.5)', () => {
  const withChannels = (line: Line, slope: number, bank: number, nu: number): Line => ({
    ...line,
    slopeRad: new Float32Array(line.curvature.length).fill(slope),
    bankRad: new Float32Array(line.curvature.length).fill(bank),
    nu: new Float32Array(line.curvature.length).fill(nu),
  });

  it('zero-filled channels are bit-identical to absent ones', () => {
    for (const line of [circuitLine(), cornerLine(), circleLine(60)]) {
      const a = solve(line, P);
      const b = solve(withChannels(line, 0, 0, 0), P);
      expect(b.lapTimeS).toBe(a.lapTimeS);
      for (const k of ['v', 'longG', 'latG', 'leanDeg', 'gripUse'] as const) expect(Array.from(b[k])).toEqual(Array.from(a[k]));
    }
  });

  it('an uphill straight is slower than a flat one', () => {
    const line = straightLine(3000);
    const flat = solve(line, P).lapTimeS;
    expect(solve(withChannels(line, 0.05, 0, 0), P).lapTimeS).toBeGreaterThan(flat);
  });

  it('slope costs drive uphill and gives it back downhill, on a corner exit', () => {
    // A bare straight cannot show the downhill half: pass 1 already holds it at
    // the flat drag-limited top speed. The exit straight of a corner is pure
    // drive from a slow apex, so grade there acts on the forward pass only.
    // (A constant grade round a closed loop is not a road, and on it the
    // longer downhill braking zone cancels the drive gain.)
    const line = cornerLine();
    const n = line.curvature.length;
    const exitStart = n - 150;
    const graded = (sig: number): Line => {
      const slopeRad = new Float32Array(n);
      for (let i = exitStart; i < n; i++) slopeRad[i] = sig;
      return { ...line, slopeRad };
    };
    const flat = solve(line, P).lapTimeS;
    expect(solve(graded(0.05), P).lapTimeS).toBeGreaterThan(flat);
    expect(solve(graded(-0.05), P).lapTimeS).toBeLessThan(flat);
    // and on the braking zone the sign flips: uphill helps the brakes
    const braking = (sig: number): Line => {
      const slopeRad = new Float32Array(n);
      for (let i = 150; i < 400; i++) slopeRad[i] = sig;
      return { ...line, slopeRad };
    };
    expect(solve(braking(0.05), P).lapTimeS).toBeLessThan(solve(braking(-0.05), P).lapTimeS);
  });

  it('favourable banking raises the corner speed; a crest (ν < 0) lowers it', () => {
    const line = circleLine(60);
    const flat = solve(line, P).lapTimeS;
    // 5° of banking toward the centre: v² gains g·sinβ/|κ| on the numerator
    expect(solve(withChannels(line, 0, 0.087, 0), P).lapTimeS).toBeLessThan(flat);
    // the same banking the wrong way round (a right-hand circle)
    const right = { ...line, curvature: line.curvature.map((k) => -k) };
    expect(solve(withChannels(right, 0, 0.087, 0), P).lapTimeS).toBeLessThan(solve(right, P).lapTimeS);
    // a crest unloads the tyre
    expect(solve(withChannels(line, 0, 0, -0.005), P).lapTimeS).toBeGreaterThan(flat);
    // and a dip loads it
    expect(solve(withChannels(line, 0, 0, 0.005), P).lapTimeS).toBeLessThan(flat);
  });

  it('stays finite on a crest sharp enough to unload the tyre entirely', () => {
    const env = solve(withChannels(cornerLine(), 0.1, -0.2, -0.05), P);
    expect(Number.isFinite(env.lapTimeS)).toBe(true);
    expect(env.v.every((x) => Number.isFinite(x) && x > 0)).toBe(true);
    expect(env.gripUse.every(Number.isFinite)).toBe(true);
  });
});

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
    //
    // v2: `brakingG` is only a ceiling when PINNED (`overrides`); unpinned, the
    // braking ceiling is μ_brake_eff (derive.ts derives brakingG from the same
    // quantity). Both runs pin it so the comparison is still about brakingG.
    const line = cornerLine();
    const pinned = (g: number): SimParams =>
      clampParams({ ...P, rider: { ...P.rider, brakingG: g, overrides: ['brakingG'] } });
    const base = solve(line, pinned(P.rider.brakingG)).lapTimeS;
    const harder = solve(line, pinned(P.rider.brakingG + 0.2)).lapTimeS;
    const slippery = solve(line, clampParams({ ...pinned(P.rider.brakingG), tyre: { ...P.tyre, mu: P.tyre.mu - 0.3 } })).lapTimeS;
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
      // pinned, so the "willing but unavailable" ceiling is really in play (v2)
      rider: { ...P.rider, brakingG: 1.6, trailBrakeDepth: 1, overrides: ['brakingG'] },
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
      //
      // v2: the upright ceiling is no longer `brakingG` (unpinned) but
      // min(μ_brake_eff·g, stoppie limit upright). On the 1000 the STOPPIE
      // binds: g·(p−b)/h = 9.81·0.719/0.55 = 12.82 m/s² (1.307 g) against
      // μ·g = 1.33 g.
      const ceilingG = Math.min(effectiveMu(P.tyre, P.rider).brake * G, stoppieLimitMs2(P.machine, 0)) / G;
      expect(stoppieLimitMs2(P.machine, 0) / G).toBeLessThan(effectiveMu(P.tyre, P.rider).brake);
      expect(Math.abs(peaks[0] + ceilingG)).toBeLessThan(2e-3);
      // 5e-5 rather than the old 1e-5 for the same reason as the tolerance
      // above: the nine combinations put the braking point on slightly
      // different samples, and the loss term they are each read at differs
      // with the speed at that sample. Measured spread: 1.1e-5 g.
      // 1e-4 since the v2 caps: the stoppie limit is read at the bike's roll, which differs by a sample between runs
      for (const peak of peaks) expect(Math.abs(peak - peaks[0])).toBeLessThan(1e-4);
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
      //
      //
      // v2: the lap-level version of this test no longer isolates upright
      // drive. `cornerLine`'s curvature STEPS from 0 to 1/40 m, an infinite
      // roll rate, so the roll-rate cap holds the arc entry to 11.3 m/s and
      // the bike then accelerates back to the lateral limit INSIDE the arc,
      // leaned — where traction control legitimately acts (0.059 s apart,
      // measured). The property itself is a statement about the drive cap, and
      // `driveCapMs2` exposes exactly the cap the forward pass uses, so it is
      // asserted there: identical at κ = 0 for every speed, and cut when leaned.
      const line = cornerLine();
      const open = clampParams({ ...P, rider: { ...P.rider, tcThreshold: 1 } });
      const strict = clampParams({ ...P, rider: { ...P.rider, tcThreshold: 0 } });
      const upright = 520; // exit straight, κ = 0
      expect(line.curvature[upright]).toBe(0);
      for (const v of [8, 15, 25, 40, 60]) {
        expect(driveCapMs2(line, strict, upright, v)).toBe(driveCapMs2(line, open, upright, v));
      }
      const leaned = 420; // on the arc
      expect(driveCapMs2(line, strict, leaned, 18)).toBeLessThan(driveCapMs2(line, open, leaned, 18) * 0.95);
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
      // and the two are the same quantity. v2: the channel is the REAL bike
      // roll (spec v2 §2.1), i.e. the ideal roll atan(lat_g) through the crown
      // and hang-off correction, no longer tan(lean) = -lat_g exactly.
      const ideal = Math.atan(env.latG[i]);
      expect((env.leanDeg[i] * Math.PI) / 180).toBeCloseTo(-bikeLeanRad(P.machine, ideal), 5);
      // with no crown and no hang-off it IS the ideal roll
      expect(bikeLeanRad({ ...P.machine, tyreCrownM: 0, hangOffM: 0 }, ideal)).toBeCloseTo(ideal, 12);
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
    // v2: this compared circleLine(40) against circleLine(400). On the 1000 the
    // crown/hang-off lean limit now binds first (tan φ_i,max = 1.29 < μ 1.33),
    // so the tight circle sits at 0.97 of μ_eff laterally with drive to spare,
    // while the 400 m circle at ~70 m/s has to hold 0.29 μ of drag on the
    // ellipse too and settles AT the tyre's limit: 0.970 against 0.975. Both
    // are the tyre doing what it should. A sweeper at a speed well under its
    // lateral limit is the low-demand case that cannot be confused that way.
    const mean = (a: Float32Array): number => a.reduce((s, x) => s + x, 0) / a.length;
    const tight = solve(circleLine(40), P);
    const gentle = solve(circleLine(400), clampParams({ ...P, machine: { ...P.machine, powerKw: 30 } }));
    expect(mean(tight.gripUse)).toBeGreaterThan(mean(gentle.gripUse) + 0.2);
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
      // leanUsage 0.9: with W6's 0.2 m hang-off the 250's full 52° is no
      // longer lean-limited (tan of the ideal limit 1.36 > μ 1.32); a rider
      // using 90 % of it is, which is the case this test is about
      rider: { ...P.rider, kappa: presetById('250').kappa, leanUsage: 0.9 },
    });
    // the lean limit really is the binding constraint for this preset (v2:
    // on the IDEAL roll the crown/hang-off-corrected bike lean allows)
    const mu = effectiveMu(p.tyre, p.rider).lat;
    const tanLean = Math.tan(idealLeanLimitRad(p.machine, (p.tyre.maxLeanDeg * p.rider.leanUsage * Math.PI) / 180));
    expect(tanLean).toBeLessThan(mu);
    // A corner long enough to settle at the lean limit, on a closed loop so
    // the wrap segment is a real one. With the old ellipse normalisation this
    // fixture reported 1.0021 — the UI's "cannot be ridden" threshold — on a
    // lap a Ninja 400 rides on a Sunday.
    //
    // v2: the friction ellipse's lateral axis is now the tyre's μ_lat_eff,
    // not the lean-limited ceiling, so on the lean-limited arc the passes may
    // spend the spare grip on braking and drive — and do, to the tyre's own
    // limit at the corner's ends (1.0018 peak, discretisation). The banner
    // threshold is GRIP_WARN = 1.05; the bound here is the solver's own
    // 1.01. The constant-lean ARC still reads tanLean/μ.
    for (const line of [cornerLoop(1200, 0, 300, 60), cornerLoop(1200, 0, 120, 40), circleLine(40)]) {
      const env = solve(line, p);
      const worst = Math.max(...Array.from(env.gripUse));
      expect(worst).toBeLessThan(1.01);
      // at the lean limit the tyre is being asked for tanLean of a possible
      // mu, so the fraction of the friction CIRCLE in use is tanLean/mu
      const arc: number[] = [];
      for (let i = 0; i < line.curvature.length; i++) if (line.curvature[i] !== 0) arc.push(env.gripUse[i]);
      arc.sort((a, b) => a - b);
      expect(arc[arc.length >> 1]).toBeCloseTo(tanLean / mu, 2);
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
    //
    // v2: the limit is g·b/h_φ − F_D·h/(m·h_φ) (R1 §3.1) rather than
    // g·p/(2h). `cgRearM` 0.5 puts b at p/2 so the upright, zero-speed figure
    // is still the 0.5 g the test was written around; drag lowers it with
    // speed, and lean (h_φ < h) raises it, so the per-sample check below
    // reads the bound at each sample's own speed and roll.
    const p = clampParams({
      machine: { ...P.machine, powerKw: 400, massKg: 150, cgHeightM: 1.0, wheelbaseM: 1.0, cgRearM: 0.5, cdA: 0.1 },
      tyre: { mu: 1.8, maxLeanDeg: 70, kerbMarginM: 0.4, gripScale: 1.2 },
      rider: { ...P.rider, tcThreshold: 1 },
    });
    const aWheelieG = wheelieLimitMs2(p.machine, 0, 0) / G;
    expect(aWheelieG).toBeCloseTo(0.5, 6);
    // it really is the smallest of the three on a straight
    const aGripG = p.tyre.mu * p.tyre.gripScale * (0.6 + 0.4 * p.rider.tcThreshold);
    expect(aWheelieG).toBeLessThan(aGripG);
    // A closed loop, not `straightLine`: that fixture's cumDistM does not
    // wrap, so its final segment is a 0.05 m stub carrying the whole
    // top-speed-to-start-speed drop and longG there is meaningless. A 40 m
    // corner gives the bike something to accelerate away from.
    const env = solve(cornerLoop(3000, 0, 100, 40), p);
    // Upright samples only (v2): at lean h_φ < h and the limit RISES (0.93 g
    // at 60° on this machine), so the leaned exit legitimately pulls past 0.5 g.
    const loop = cornerLoop(3000, 0, 100, 40);
    // (and both neighbours upright: longG[i] averages the two segments either
    // side, and the one leaving a leaned exit carries the leaned limit)
    const nL = loop.curvature.length;
    const peak = Math.max(
      ...Array.from(env.longG).filter(
        (_, i) => loop.curvature[i] === 0 && loop.curvature[(i + 1) % nL] === 0 && loop.curvature[(i - 1 + nL) % nL] === 0,
      ),
    );
    // the front wheel limit caps acceleration; without it this configuration
    // would pull well over 2 g
    expect(peak).toBeLessThanOrEqual(aWheelieG + 1e-3);
    // and sample by sample, against the limit at that sample's speed and roll
    // (net of drag: longG is what is left after the losses)
    // `longG[i]` is the mean of the segments either side of i, so the bound is
    // the larger of the limits at i−1, i, i+1 (the arc exit, where roll falls
    // from 50° to 0 within one sample, is where that matters).
    const nE = env.v.length;
    const capAt = (j: number): number => {
      const phi = (Math.abs(env.leanDeg[j]) * Math.PI) / 180;
      return (wheelieLimitMs2(p.machine, env.v[j], phi) - lossDecelMs2(p.machine, env.v[j])) / G;
    };
    for (let i = 0; i < nE; i++) {
      const cap = Math.max(capAt((i - 1 + nE) % nE), capAt(i), capAt((i + 1) % nE));
      expect(env.longG[i]).toBeLessThanOrEqual(cap + 0.01);
    }
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

/**
 * A long straight into a 25 m hairpin with a 40 m curvature ramp, 1 m
 * sampling: hard braking from near top speed, upright, which is where the
 * stoppie limit binds. The ramp keeps the roll-rate cap out of the braking
 * zone itself.
 */
function straightIntoHairpin(): Line {
  const entry = 700;
  const ramp = 40;
  const arc = Math.round(Math.PI * 25) - ramp;
  const exit = 200;
  const n = entry + ramp + arc + exit;
  const curvature = new Float32Array(n);
  const cumDistM = new Float64Array(n);
  const points: LngLat[] = [];
  const mPerDegLng = 111320 * Math.cos((41.073 * Math.PI) / 180);
  for (let i = 0; i < n; i++) {
    cumDistM[i] = i;
    points.push([23.518 + i / mPerDegLng, 41.073]);
    if (i >= entry && i < entry + ramp) curvature[i] = (i - entry + 1) / ramp / 25;
    else if (i >= entry + ramp && i < entry + ramp + arc) curvature[i] = 1 / 25;
  }
  return { points, curvature, cumDistM, lengthM: n, offsetM: new Float32Array(n) };
}

/**
 * A chicane: straight, 50 m left arc, flipped straight into a 50 m right arc,
 * straight; 1 m sampling, closed loop. The flip is where roll RATE matters.
 */
function chicaneLine(): Line {
  const segs: Array<[number, number]> = [[300, 0], [40, 1 / 50], [40, -1 / 50], [300, 0]];
  const n = segs.reduce((a, s) => a + s[0], 0);
  const curvature = new Float32Array(n);
  const cumDistM = new Float64Array(n);
  const points: LngLat[] = [];
  const mPerDegLng = 111320 * Math.cos((41.073 * Math.PI) / 180);
  let i = 0;
  for (const [len, k] of segs) {
    for (let q = 0; q < len; q++, i++) {
      cumDistM[i] = i;
      curvature[i] = k;
      points.push([23.518 + i / mPerDegLng, 41.073]);
    }
  }
  return { points, curvature, cumDistM, lengthM: n, offsetM: new Float32Array(n) };
}

describe('v2 solver: load transfer, μ_eff ellipse, roll rate (spec v2 §2.1-2.5, §2.8)', () => {
  it('lap time is monotone in risk through the allowed-slip fractions', () => {
    const line = circuitLine();
    const t = (s: number): number =>
      solve(line, clampParams({ ...P, rider: { ...P.rider, sBrake: s, sDrive: s, sLat: s } })).lapTimeS;
    expect(t(0.1)).toBeGreaterThan(t(0.5));
    expect(t(0.5)).toBeGreaterThan(t(1));
    expect(Number.isFinite(t(0.1))).toBe(true);
  });

  it('is monotone along the whole risk axis and finite at the floor (Review Focus 3)', () => {
    const line = circuitLine();
    let prev = Infinity;
    for (const s of [0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 1]) {
      const env = solve(line, clampParams({ ...P, rider: { ...P.rider, sBrake: s, sDrive: s, sLat: s } }));
      expect(Number.isFinite(env.lapTimeS)).toBe(true);
      expect(env.v.every((x) => Number.isFinite(x) && x > 0)).toBe(true);
      expect(env.gripUse.every(Number.isFinite)).toBe(true);
      expect(env.gripUsePeak!.every(Number.isFinite)).toBe(true);
      expect(env.lapTimeS).toBeLessThanOrEqual(prev);
      prev = env.lapTimeS;
    }
  });

  it('braking never exceeds the stoppie limit plus drag', () => {
    const line = straightIntoHairpin();
    const env = solve(line, P);
    let hardest = 0;
    for (let i = 0; i < env.v.length; i++) {
      // the stoppie limit at the bike's OWN roll there: the CG sits lower at
      // lean (h_φ), so the limit on the first leaned samples is a little above
      // the upright one
      const phi = (Math.abs(env.leanDeg[i]) * Math.PI) / 180;
      const cap = stoppieLimitMs2(P.machine, phi) + lossDecelMs2(P.machine, env.v[i]);
      // 0.1 m/s^2 (0.01 g): longG[i] averages two segments whose drag is read
      // at their own speeds, while the cap reads drag at v[i]
      expect(-env.longG[i] * 9.81).toBeLessThanOrEqual(cap + 0.1);
      hardest = Math.max(hardest, -env.longG[i] * 9.81 - lossDecelMs2(P.machine, env.v[i]));
    }
    // and the stoppie really is what binds (1.307 g < μ 1.33 on the 1000)
    expect(hardest).toBeGreaterThan(stoppieLimitMs2(P.machine, 0) - 0.1);
  });

  it('a pinned brakingG still caps the tyre share below the stoppie', () => {
    const line = straightIntoHairpin();
    const p = clampParams({ ...P, rider: { ...P.rider, brakingG: 0.85, overrides: ['brakingG'] } });
    const env = solve(line, p);
    const tyre = tyreLongG(env, p.machine);
    expect(Math.min(...tyre)).toBeGreaterThan(-0.85 - 0.01);
    expect(Math.min(...tyre)).toBeLessThan(-0.85 + 0.01);
    // unpinned, the same number is ignored
    const free = solve(line, clampParams({ ...P, rider: { ...P.rider, brakingG: 0.85 } }));
    expect(free.lapTimeS).toBeLessThan(env.lapTimeS);
  });

  it('gripUse is normalised to the rider ceiling and gripUsePeak to the tyre', () => {
    const env = solve(circuitLine(), clampParams({ ...P, rider: { ...P.rider, sLat: 0.5, sBrake: 0.5, sDrive: 0.5 } }));
    const peakUse = Math.max(...env.gripUse);
    const peakTyre = Math.max(...env.gripUsePeak!);
    expect(peakUse).toBeLessThanOrEqual(1.05);
    expect(peakTyre).toBeLessThan(peakUse); // the tyre has more than the rider uses
    // at s = 1 on every axis the two are the same channel
    const full = solve(circuitLine(), P);
    for (let i = 0; i < full.gripUse.length; i++) expect(full.gripUsePeak![i]).toBeCloseTo(full.gripUse[i], 6);
  });

  it('a lower roll-rate fraction slows a chicane but not a constant-radius circle', () => {
    const slow = { ...P, rider: { ...P.rider, rollRateFrac: 0.2 } };
    expect(solve(chicaneLine(), clampParams(slow)).lapTimeS).toBeGreaterThan(solve(chicaneLine(), P).lapTimeS);
    expect(solve(circleLine(60), clampParams(slow)).lapTimeS).toBeCloseTo(solve(circleLine(60), P).lapTimeS, 3);
  });

  it('the roll rate the envelope asks for stays within the rider share of the bound', () => {
    const p = clampParams({ ...P, rider: { ...P.rider, rollRateFrac: 0.5 } });
    const line = chicaneLine();
    const env = solve(line, p);
    const n = env.v.length;
    let worst = 0;
    // Measured with the solver's own definition (fix(sim) roll-rate): dφ/ds
    // over a ±20 m stencil (1 m sampling here), skipped where both ends are
    // under the 3° dead-band, against the jerk-floored bound.
    const K = 20;
    for (let i = K; i < n - K; i++) {
      const a = env.leanDeg[i + K];
      const b = env.leanDeg[i - K];
      if (Math.abs(a) < 3 && Math.abs(b) < 3) continue;
      const dphi = (Math.abs(a - b) * Math.PI) / 180 / (2 * K);
      const rate = env.v[i] * dphi;
      const jy = Math.max(23.5 - 0.31 * env.v[i], 6);
      const bound = 0.5 * Math.max(0.05, (jy / 9.81) * Math.cos((env.leanDeg[i] * Math.PI) / 180) ** 2);
      worst = Math.max(worst, rate / bound);
    }
    // measured on the solved profile, where the speeds across the stencil
    // differ (the cap holds them equal), so a little over 1 is the QSS
    // stencil, not a leak.
    expect(worst).toBeLessThan(1.4);
    expect(worst).toBeGreaterThan(0.5); // and it does bind
  });

  it('with hang-off the lean-limited 1000 preset corners faster', () => {
    // The preset already hangs off 0.25 m (W6), at which point mu binds before
    // the lean limit and more hang-off buys nothing; compare against a rider
    // who sits bolt upright instead, where the crown correction alone caps the
    // ideal lean below the tyre's mu.
    const upright = solve(circleLine(60), clampParams({ ...P, machine: { ...P.machine, hangOffM: 0 } })).lapTimeS;
    const hang = solve(circleLine(60), clampParams({ ...P, machine: { ...P.machine, hangOffM: 0.3 } })).lapTimeS;
    expect(hang).toBeLessThan(upright);
  });

  it('a bigger tyre crown costs lean-limited corner speed', () => {
    const p250 = clampParams({ machine: { presetId: '250', ...presetById('250').machine }, tyre: { ...presetById('250').tyre }, rider: P.rider });
    const base = solve(circleLine(60), p250).lapTimeS;
    const fat = solve(circleLine(60), clampParams({ ...p250, machine: { ...p250.machine, tyreCrownM: 0.12 } })).lapTimeS;
    expect(fat).toBeGreaterThan(base);
  });

  it('the exported caps are exactly the ones the passes use', () => {
    const line = straightIntoHairpin();
    const env = solve(line, P);
    // on the plateau of the entry braking the tyre share is brakeCapMs2 at that sample
    let checked = 0;
    for (let i = 300; i < 690; i++) {
      const tyre = -env.longG[i] * G - lossDecelMs2(P.machine, env.v[i]);
      if (tyre < 0.95 * brakeCapMs2(line, P, i, env.v[i])) continue;
      expect(tyre).toBeLessThanOrEqual(brakeCapMs2(line, P, i, env.v[i]) + 0.1);
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
    // upright brake cap = min(μ_brake_eff·g, stoppie)
    expect(brakeCapMs2(line, P, 100, 50)).toBeCloseTo(Math.min(effectiveMu(P.tyre, P.rider).brake * G, stoppieLimitMs2(P.machine, 0)), 9);
    // upright drive cap at low speed: the wheelie limit binds before μ on the 1000
    expect(driveCapMs2(line, P, 100, 10)).toBeCloseTo(
      Math.min(effectiveMu(P.tyre, P.rider).drive * G, wheelieLimitMs2(P.machine, 10, 0), (P.machine.powerKw * 1000) / (P.machine.massKg * 10)),
      9,
    );
    // at the lateral limit on the hairpin's arc (17.7 m/s at r 25) the brake cap is gone
    expect(brakeCapMs2(line, P, 760, 17.7)).toBeLessThan(0.05 * brakeCapMs2(line, P, 100, 17.7));
  });

  it('is not slower than the pinned budget: < 50 ms on the 5-corner fixture', () => {
    const line = circuitLine();
    solve(line, P); // warm-up
    const t0 = performance.now();
    const runs = 5;
    for (let k = 0; k < runs; k++) solve(line, P);
    const ms = (performance.now() - t0) / runs;
    // measured ~4.6 ms on the M4 Pro (1521 samples); the plan's budget is 10
    expect(ms).toBeLessThan(50);
  });

  it('returns a finite envelope with hang-off beyond what the rider mass supports (Review Focus 6)', () => {
    const p = clampParams({ ...P, machine: { ...P.machine, hangOffM: 0.5, riderMassKg: 40 } });
    const env = solve(circuitLine(), p);
    expect(Number.isFinite(env.lapTimeS)).toBe(true);
    expect(env.leanDeg.every(Number.isFinite)).toBe(true);
  });
});
