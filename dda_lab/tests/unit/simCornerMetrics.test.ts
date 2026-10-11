// Per-corner metrics on MEASURED traces (W4, spec v2 §2.4 and §4).
//
// The validation harness (`scripts/sim-validate.ts`) and the owner-lap
// identification (`scripts/ducati-identify.ts`) both read real laps through
// these helpers, so they are pinned here on synthetic traces whose answer is
// known by construction: a time-domain rider with three braking zones of a
// known build, apex speed and throttle pick-up, plus speed ripples that must
// NOT count as corners.
import { describe, expect, it } from 'vitest';
import {
  biteRateGps,
  brakeBuild,
  cornerMetrics,
  findSpeedCorners,
  rollOn,
  rollRateTurnIn,
  throttlePickUp,
} from '../../scripts/lib/cornerMetrics';
import { invertDerive, weightedMedian } from '../../scripts/lib/inverseDerive';
import { deriveRider } from '../../src/sim/derive';
import { DEFAULT_SIM_PARAMS } from '../../src/sim/presets';

const G = 9.81;

interface Synth {
  tS: Float64Array;
  sM: Float64Array;
  vKmh: Float32Array;
  gLong: Float32Array;
  tps: Float32Array;
  /** Index (time-domain) of each designed apex. */
  apexIdx: number[];
}

/**
 * A rider in the time domain, dt = 10 ms. Each corner: cruise at the top
 * speed, brake with a LINEAR build 0 → −peakG over `buildS`, plateau until the
 * apex speed, hold the apex speed (maintenance) for `holdS` with the throttle
 * at 5 %, then pick the throttle up and roll it 20 → 90 % over 0.7 s while
 * accelerating at +0.5 g back to the top speed. Ripples are small 0.1 g dips
 * on the straights (~3 km/h), which are not corners.
 */
function synthLap(): Synth {
  const dt = 0.01;
  const vTop = 200 / 3.6;
  const corners = [
    { vMin: 80 / 3.6, peakG: 1.0, buildS: 0.4, holdS: 0.8 },
    { vMin: 120 / 3.6, peakG: 0.8, buildS: 0.4, holdS: 0.8 },
    { vMin: 150 / 3.6, peakG: 0.6, buildS: 0.4, holdS: 0.8 },
  ];
  const t: number[] = [];
  const s: number[] = [];
  const v: number[] = [];
  const a: number[] = [];
  const tp: number[] = [];
  const apex: number[] = [];
  let tt = 0;
  let ss = 0;
  let vv = vTop;
  const push = (acc: number, thr: number): void => {
    t.push(tt);
    s.push(ss);
    v.push(vv);
    a.push(acc / G);
    tp.push(thr);
    ss += vv * dt + 0.5 * acc * dt * dt;
    vv += acc * dt;
    tt += dt;
  };
  const cruise = (sec: number, ripple: boolean): void => {
    for (let k = 0; k < sec / dt; k++) {
      // a 0.4 s, -0.1 g dip in the middle of the straight, then recover
      const mid = ripple && Math.abs(k * dt - sec / 2) < 0.2;
      push(mid ? -0.1 * G : vv < vTop - 1e-9 ? 0.1 * G : 0, 100);
      vv = Math.min(vv, vTop);
    }
  };
  cruise(3, true);
  for (const c of corners) {
    let k = 0;
    while (vv > c.vMin) {
      const g = Math.min(c.peakG, (c.peakG * k * dt) / c.buildS);
      push(-g * G, 0);
      k++;
    }
    vv = c.vMin;
    apex.push(t.length);
    for (let j = 0; j < c.holdS / dt; j++) push(0, 5);
    // pick-up at A + holdS, then roll-on 20 -> 90 % in 0.7 s
    k = 0;
    while (vv < vTop) {
      const el = k * dt;
      const thr = el < 0.1 ? 12 + 80 * el : Math.min(100, 20 + (70 * (el - 0.1)) / 0.7);
      push(0.5 * G, thr);
      k++;
    }
    vv = vTop;
    cruise(4, true);
  }
  return {
    tS: Float64Array.from(t),
    sM: Float64Array.from(s),
    vKmh: Float32Array.from(v, (x) => x * 3.6),
    gLong: Float32Array.from(a),
    tps: Float32Array.from(tp),
    apexIdx: apex,
  };
}

describe('findSpeedCorners on a measured speed trace', () => {
  const lap = synthLap();

  it('finds the three designed corners and ignores the ripples', () => {
    const cs = findSpeedCorners(lap.vKmh, lap.sM, { tS: lap.tS, gTyre: lap.gLong });
    expect(cs.length).toBe(3);
    const mins = cs.map((c) => c.minKmh);
    expect(mins[0]).toBeCloseTo(80, 0);
    expect(mins[1]).toBeCloseTo(120, 0);
    expect(mins[2]).toBeCloseTo(150, 0);
    for (const c of cs) {
      expect(c.hasBrake).toBe(true);
      expect(c.iEntry).toBeLessThan(c.iA);
      expect(c.iA).toBeLessThan(c.iExit);
    }
  });

  it('merges two dips with no room to accelerate between them into one section', () => {
    // 60 km/h apex, an 11 km/h rise (prominent on its own), 62 km/h apex
    // 20 m later: shorter than v²/(2·a_drive) ≈ 23 m, so one chicane
    const n = 600;
    const sM = Float64Array.from({ length: n }, (_, i) => i);
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const d1 = Math.abs(i - 250);
      const d2 = Math.abs(i - 270);
      v[i] = Math.min(150, 60 + d1 * 1.2, 62 + d2 * 1.2);
    }
    const cs = findSpeedCorners(v, sM);
    expect(cs.length).toBe(1);
    expect(cs[0].members.length).toBe(2);
    expect(cs[0].minKmh).toBeCloseTo(60, 3);
  });

  it('a dip without a braking run is a corner without a brake event', () => {
    // 12 km/h lift-off dip at 1 m/s^2: no -0.2 g run
    const n = 2000;
    const sM = Float64Array.from({ length: n }, (_, i) => i);
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) v[i] = 200 - 12 * Math.exp(-(((i - 1000) / 150) ** 2));
    const cs = findSpeedCorners(v, sM, { gTyre: new Float32Array(n).fill(-0.05) });
    expect(cs.length).toBe(1);
    expect(cs[0].hasBrake).toBe(false);
  });
});

describe('brakeBuild', () => {
  it('measures a linear 0.4 s build to 1.0 g as 0.32 s from -0.1 g to 90 %', () => {
    const dt = 0.1; // 10 Hz, the Ducati rate: crossings must be interpolated
    const n = 40;
    const tS = Float64Array.from({ length: n }, (_, i) => i * dt);
    const g = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const tt = tS[i] - 1.0;
      g[i] = tt <= 0 ? 0 : -Math.min(1, tt / 0.4);
    }
    const b = brakeBuild(tS, g, 0, n - 1);
    expect(b).not.toBeNull();
    expect(b!.peakG).toBeCloseTo(-1, 5);
    expect(b!.buildS).toBeCloseTo(0.32, 2);
    // 10-90 % rate: 0.8 g over 0.32 s
    expect(b!.rateGps).toBeCloseTo(2.5, 1);
  });

  it('the bite rate is the steepest 0.3 s of the build, not the 10-90 % average', () => {
    // 2.5 g/s bite to 0.5 g, then a slow 0.5 g/s squeeze to 0.9 g
    const dt = 0.1;
    const n = 50;
    const tS = Float64Array.from({ length: n }, (_, i) => i * dt);
    const g = Float32Array.from(tS, (t) => {
      const u = t - 1;
      if (u <= 0) return 0;
      if (u <= 0.2) return -2.5 * u;
      return -Math.min(0.9, 0.5 + 0.5 * (u - 0.2));
    });
    // steepest 3-sample span: 0 -> -0.55 g between t = 1.0 and 1.3 s
    expect(biteRateGps(tS, g, 0, n - 1)).toBeCloseTo(0.55 / 0.3, 2);
    const b = brakeBuild(tS, g, 0, n - 1)!;
    expect(b.rateGps).toBeLessThan(1.2);
  });

  it('a robust peak ignores a one-sample spike deeper than the plateau', () => {
    // 0.4 s build to a 0.8 g plateau held 2 s, with one -1.5 g sample in it
    const dt = 0.1;
    const n = 40;
    const tS = Float64Array.from({ length: n }, (_, i) => i * dt);
    const g = Float32Array.from(tS, (t) => (t <= 1 ? 0 : -0.8 * Math.min(1, (t - 1) / 0.4)));
    g[25] = -1.5;
    const raw = brakeBuild(tS, g, 0, n - 1)!;
    expect(raw.peakG).toBeCloseTo(-1.5, 5);
    const rob = brakeBuild(tS, g, 0, n - 1, { robustPct: 10 })!;
    expect(rob.peakG).toBeCloseTo(-0.8, 2);
    // -0.1 g -> 0.72 g on a 2 g/s ramp
    expect(rob.buildS).toBeCloseTo(0.31, 2);
  });
});

describe('throttle pick-up, roll-on and turn-in roll rate', () => {
  it('reads the designed pick-up delay and roll-on time', () => {
    const lap = synthLap();
    for (const iA of lap.apexIdx) {
      const p = throttlePickUp(lap.tS, lap.tps, iA);
      expect(p).not.toBeNull();
      expect(p!.tPickS).toBeCloseTo(0.8, 1);
      const r = rollOn(lap.tS, lap.tps, p!.iP, lap.tS.length - 1);
      expect(r).not.toBeNull();
      expect(r!.rollOnS).toBeCloseTo(0.7, 1);
    }
  });

  it('a throttle blip that closes again is not the pick-up', () => {
    const n = 100;
    const tS = Float64Array.from({ length: n }, (_, i) => i * 0.1);
    const tps = new Float32Array(n);
    for (let i = 0; i < n; i++) tps[i] = i === 22 || i === 23 ? 15 : i >= 40 ? 30 : 2;
    const p = throttlePickUp(tS, tps, 20);
    expect(p!.iP).toBe(40);
    expect(p!.tPickS).toBeCloseTo(2.0, 5);
  });

  it('a throttle held open through the corner has no pick-up', () => {
    const n = 100;
    const tS = Float64Array.from({ length: n }, (_, i) => i * 0.1);
    const tps = Float32Array.from(tS, (t) => 15 + 5 * Math.sin(t));
    expect(throttlePickUp(tS, tps, 50)).toBeNull();
  });

  it('measures roll rate on the signed lean, so a flick reads its true rate', () => {
    // 10 Hz: upright, then roll LEFT (negative) to -45 deg at 60 deg/s
    const n = 60;
    const tS = Float64Array.from({ length: n }, (_, i) => i * 0.1);
    const lean = new Float32Array(n);
    for (let i = 0; i < n; i++) lean[i] = -Math.min(45, Math.max(0, (tS[i] - 1) * 60));
    // apex at the end of the roll (t = 1.8 s); turn-in where |lean| passes 8 deg
    const r = rollRateTurnIn(tS, lean, 18);
    expect(r).not.toBeNull();
    expect(r!.p90DegS).toBeGreaterThan(54);
    expect(r!.p90DegS).toBeLessThan(63);
    expect(r!.meanDegS).toBeGreaterThan(50);
  });
});

describe('cornerMetrics summary', () => {
  it('counts brake events and builds and reports the lap time', () => {
    const lap = synthLap();
    const m = cornerMetrics(lap.vKmh, lap.sM, lap.gLong, { tS: lap.tS });
    expect(m.brakeEvents).toBe(3);
    expect(m.minSpeeds.map((x) => Math.round(x.kmh))).toEqual([80, 120, 150]);
    for (const b of m.buildTimesS) expect(b).toBeCloseTo(0.32, 1);
    expect(m.lapTimeS).toBeCloseTo(lap.tS[lap.tS.length - 1], 3);
    expect(m.longGp25).toBeLessThan(-0.4);
  });

  it('integrates the lap time from distance and speed when no clock is given', () => {
    const n = 1001;
    const sM = Float64Array.from({ length: n }, (_, i) => i);
    const v = new Float32Array(n).fill(36); // 10 m/s over 1000 m
    expect(cornerMetrics(v, sM).lapTimeS).toBeCloseTo(100, 6);
  });
});

describe('inverting the A/R derivation (spec v2 §2.6)', () => {
  it('a derived field fed back returns the slider that produced it', () => {
    const tyre = DEFAULT_SIM_PARAMS.tyre;
    for (const A of [0, 0.3, 0.7, 1]) {
      for (const R of [0, 0.4, 1]) {
        const r = deriveRider({ ...DEFAULT_SIM_PARAMS.rider, aggressiveness: A, risk: R, overrides: [] }, tyre);
        expect(invertDerive('throttleDelayS', r.throttleDelayS, tyre)).toBeCloseTo(A, 6);
        expect(invertDerive('rollOnS', r.rollOnS, tyre)).toBeCloseTo(A, 6);
        expect(invertDerive('brakeRiseGps', r.brakeRiseGps, tyre)).toBeCloseTo(A, 6);
        expect(invertDerive('rollRateFrac', r.rollRateFrac, tyre)).toBeCloseTo(A, 6);
        expect(invertDerive('sDrive', r.sDrive, tyre)).toBeCloseTo(R, 6);
        expect(invertDerive('brakingG', r.brakingG, tyre)).toBeCloseTo(R, 4);
        // leanUsage is capped at 1 (R >= 0.37 all read 1), so it only inverts below the cap
        if (r.leanUsage < 1) expect(invertDerive('leanUsage', r.leanUsage, tyre)).toBeCloseTo(R, 4);
      }
    }
  });

  it('the weighted median follows the heavier candidates', () => {
    expect(weightedMedian([0.1, 0.5, 0.9], [1, 1, 1])).toBeCloseTo(0.5, 9);
    expect(weightedMedian([0.1, 0.5, 0.9], [1, 1, 5])).toBeCloseTo(0.9, 9);
    expect(weightedMedian([], [])).toBeNaN();
  });
});
