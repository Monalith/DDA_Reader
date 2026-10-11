import { describe, expect, it } from 'vitest';
import { effectiveMu, gripFraction } from '../../src/sim/tyre';
import { DEFAULT_SIM_PARAMS } from '../../src/sim/presets';

describe('gripFraction', () => {
  it('matches the SEL-2004 derived table (R2 §3.4)', () => {
    expect(gripFraction(0.5, 'long')).toBeCloseTo(0.856, 2);
    expect(gripFraction(0.6, 'long')).toBeCloseTo(0.92, 2);
    expect(gripFraction(0.8, 'long')).toBeCloseTo(0.985, 2);
    expect(gripFraction(1, 'long')).toBeCloseTo(1, 9);
    expect(gripFraction(0, 'long')).toBe(0);
  });
  it('is monotone on both axes', () => {
    for (const axis of ['long', 'lat'] as const) {
      let prev = -1;
      for (let s = 0; s <= 1.0001; s += 0.01) {
        const g = gripFraction(s, axis);
        expect(g).toBeGreaterThanOrEqual(prev);
        prev = g;
      }
    }
  });
  it('the lateral curve is flatter than the longitudinal one below the peak', () => {
    for (const s of [0.2, 0.4, 0.6, 0.8]) expect(gripFraction(s, 'lat')).toBeGreaterThan(gripFraction(s, 'long'));
  });
  it('is never NaN and saturates outside 0..1', () => {
    expect(gripFraction(Number.NaN, 'lat')).toBe(0);
    expect(gripFraction(2, 'long')).toBeCloseTo(1, 9);
    expect(gripFraction(-1, 'long')).toBe(0);
  });
});

describe('effectiveMu', () => {
  const tyre = { ...DEFAULT_SIM_PARAMS.tyre, mu: 1.3, muX: 1.2, gripScale: 1 };
  it('scales each axis by its own allowed slip', () => {
    const r = { ...DEFAULT_SIM_PARAMS.rider, sBrake: 1, sDrive: 0.5, sLat: 1 };
    const mu = effectiveMu(tyre, r);
    expect(mu.brake).toBeCloseTo(1.2, 9);
    expect(mu.drive).toBeCloseTo(1.2 * 0.856, 2);
    expect(mu.lat).toBeCloseTo(1.3, 9);
  });
  it('muX undefined means muX = mu', () => {
    expect(effectiveMu({ ...tyre, muX: undefined }, { ...DEFAULT_SIM_PARAMS.rider, sBrake: 1 }).brake).toBeCloseTo(1.3, 9);
  });
  it('gripScale multiplies every axis', () => {
    const r = { ...DEFAULT_SIM_PARAMS.rider, sBrake: 0.6, sDrive: 0.6, sLat: 0.6 };
    const a = effectiveMu(tyre, r);
    const b = effectiveMu({ ...tyre, gripScale: 0.5 }, r);
    expect(b.brake).toBeCloseTo(a.brake / 2, 12);
    expect(b.drive).toBeCloseTo(a.drive / 2, 12);
    expect(b.lat).toBeCloseTo(a.lat / 2, 12);
  });
  it('s = 1 on every axis is exactly the v1 friction ceiling mu·gripScale', () => {
    // Bit-exact, not "close": the v1 calibration (and the pinned envelope in
    // simSolver.test.ts) depends on gripFraction(1) not being 0.9999999999999999.
    const r = { ...DEFAULT_SIM_PARAMS.rider, sBrake: 1, sDrive: 1, sLat: 1 };
    const t = { ...DEFAULT_SIM_PARAMS.tyre, muX: undefined };
    const mu = effectiveMu(t, r);
    expect(mu.lat).toBe(t.mu * t.gripScale);
    expect(mu.brake).toBe(t.mu * t.gripScale);
    expect(mu.drive).toBe(t.mu * t.gripScale);
  });
  it('is monotone in each allowed slip (Review Focus 3)', () => {
    let prev = { brake: -1, drive: -1, lat: -1 };
    for (let s = 0.1; s <= 1.0001; s += 0.05) {
      const mu = effectiveMu(tyre, { ...DEFAULT_SIM_PARAMS.rider, sBrake: s, sDrive: s, sLat: s });
      expect(mu.brake).toBeGreaterThanOrEqual(prev.brake);
      expect(mu.drive).toBeGreaterThanOrEqual(prev.drive);
      expect(mu.lat).toBeGreaterThanOrEqual(prev.lat);
      expect(mu.lat).toBeGreaterThan(0);
      prev = mu;
    }
  });
});
