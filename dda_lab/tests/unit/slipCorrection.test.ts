// Wheel-slip lean correction (research R2 §3.6) and the GPS reference it is
// measured against, on synthetic traces with a known answer.
//
// The Ducati `wheel_slip_pct` is (wheel speed − GPS speed)/GPS speed. Even
// with no real slip it reads a constant speedometer offset plus a term that
// grows with lean (the contact patch moves onto a smaller rolling radius), and
// the GPS speed lags the wheel. `scripts/ducati-identify.ts` removes all three
// before it reads a single slip percentile.
import { describe, expect, it } from 'vitest';
import {
  correctedSlipPct,
  estimateGpsLag,
  fitSlipLean,
  isCoasting,
  windowedSlip,
  type SlipSample,
} from '../../scripts/lib/slipCorrection';

/** Deterministic noise in [-1, 1]. */
function noise(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 2 ** 32) * 2 - 1;
  };
}

const truth = (leanDeg: number): number => 0.5 + 10 * (1 - Math.cos((leanDeg * Math.PI) / 180));

function samples(): SlipSample[] {
  const rnd = noise(7);
  const out: SlipSample[] = [];
  // coasting: the lean-only baseline plus ±0.3 % noise
  for (let k = 0; k < 600; k++) {
    const lean = 55 * ((k % 100) / 99) * (k % 2 ? 1 : -1);
    out.push({ slipPct: truth(lean) + 0.3 * rnd(), leanDeg: lean, tpsPct: 3, accelLongG: 0.02 * rnd(), torqueFastPct: 0, torqueSlowPct: 0 });
  }
  // driving: real slip on top, must not enter the fit
  for (let k = 0; k < 300; k++) {
    const lean = 40 * (k / 299);
    out.push({ slipPct: truth(lean) + 8, leanDeg: lean, tpsPct: 60, accelLongG: 0.3, torqueFastPct: 0, torqueSlowPct: 0 });
  }
  // traction control cutting: also excluded
  for (let k = 0; k < 50; k++) {
    out.push({ slipPct: truth(30) + 15, leanDeg: 30, tpsPct: 5, accelLongG: 0.01, torqueFastPct: 40, torqueSlowPct: 0 });
  }
  return out;
}

describe('fitSlipLean', () => {
  it('recovers slip = 0.5 + 10·(1 − cos φ) to 2 % from the coasting samples only', () => {
    const fit = fitSlipLean(samples());
    expect(fit.n).toBe(600);
    expect(Math.abs(fit.c2 - 10) / 10).toBeLessThan(0.02);
    expect(fit.c0).toBeCloseTo(0.5, 1);
    expect(fit.rmsPct).toBeLessThan(0.3);
  });

  it('coasting means closed throttle, no net acceleration and no torque reduction', () => {
    const base: SlipSample = { slipPct: 0, leanDeg: 0, tpsPct: 3, accelLongG: 0, torqueFastPct: 0, torqueSlowPct: 0 };
    expect(isCoasting(base)).toBe(true);
    expect(isCoasting({ ...base, tpsPct: 9 })).toBe(false);
    expect(isCoasting({ ...base, accelLongG: -0.06 })).toBe(false);
    expect(isCoasting({ ...base, torqueSlowPct: 1 })).toBe(false);
    expect(isCoasting({ ...base, tpsPct: 20 }, { tpsMaxPct: 25, accelAbsMaxG: 0.05 })).toBe(true);
  });

  it('the corrected slip of a coasting sample is zero and of a driving one is its real slip', () => {
    const fit = fitSlipLean(samples());
    expect(correctedSlipPct(fit, truth(45), 45)).toBeCloseTo(0, 1);
    expect(correctedSlipPct(fit, truth(-45) + 8, -45)).toBeCloseTo(8, 1);
  });

  it('too few coasting samples is no fit, not a wild one', () => {
    const fit = fitSlipLean(samples().slice(600));
    expect(fit.n).toBe(0);
    expect(fit.c2).toBeNaN();
  });
});

describe('GPS reference speed', () => {
  // 10 Hz, 300 s. True ground speed v(t); the wheel reads 7 % high; the GPS
  // position is the true position 0.2 s late.
  const dt = 0.1;
  const n = 3000;
  const lag = 0.2;
  const vTrue = (t: number): number => 35 + 15 * Math.sin(0.31 * t) + 6 * Math.sin(1.3 * t);
  // ∫ v dt in closed form
  const xTrue = (t: number): number => 35 * t - (15 / 0.31) * Math.cos(0.31 * t) - (6 / 1.3) * Math.cos(1.3 * t);
  const tS = Float64Array.from({ length: n }, (_, i) => i * dt);
  const wheelKmh = Float32Array.from(tS, (t) => 1.07 * vTrue(t) * 3.6);
  const gpsCumM = Float64Array.from(tS, (t) => xTrue(t - lag) - xTrue(-lag));

  it('finds the GPS lag and the speedometer scale', () => {
    const est = estimateGpsLag(tS, wheelKmh, gpsCumM);
    expect(est.lagS).toBeGreaterThan(0.17);
    expect(est.lagS).toBeLessThan(0.23);
    expect(est.scale).toBeCloseTo(1.07, 2);
  });

  it('windowed slip with the lag removed is the speedometer offset everywhere', () => {
    const slip = windowedSlip(tS, wheelKmh, gpsCumM, 0.2, 3);
    const vals = Array.from(slip).filter((x) => Number.isFinite(x));
    expect(vals.length).toBeGreaterThan(n * 0.9);
    for (const x of vals) expect(x).toBeCloseTo(7, 0);
    // and without the lag removed it is visibly wrong in the accelerations
    const raw = windowedSlip(tS, wheelKmh, gpsCumM, 0, 3);
    const spread = Math.max(...Array.from(raw).filter(Number.isFinite)) - Math.min(...Array.from(raw).filter(Number.isFinite));
    expect(spread).toBeGreaterThan(1);
  });
});
