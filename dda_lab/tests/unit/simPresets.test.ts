import { describe, expect, it } from 'vitest';
import { clampParams, DEFAULT_SIM_PARAMS, MACHINE_PRESETS, presetById } from '../../src/sim/presets';

describe('presets', () => {
  it('ships the three classes the research covers plus the owner bike and custom', () => {
    const ids = MACHINE_PRESETS.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['250', '600', '1000', 'panigale-v4', 'custom']));
  });

  it('orders power-to-weight and kappa the way the research says', () => {
    const p250 = presetById('250');
    const p600 = presetById('600');
    const p1000 = presetById('1000');
    const pw = (p: typeof p250) => p.machine.powerKw / p.machine.massKg;
    expect(pw(p250)).toBeLessThan(pw(p600));
    expect(pw(p600)).toBeLessThan(pw(p1000));
    // low power -> C line (kappa 0), high power -> V line (kappa 1)
    expect(p250.kappa).toBeLessThan(p600.kappa);
    expect(p600.kappa).toBeLessThan(p1000.kappa);
  });

  it('raises the lean limit with the class, matching the tyre data', () => {
    expect(presetById('250').tyre.maxLeanDeg).toBeLessThan(presetById('1000').tyre.maxLeanDeg);
  });

  it('falls back to custom for an unknown id instead of throwing', () => {
    expect(presetById('nope').id).toBe('custom');
  });
});

describe('clampParams', () => {
  it('holds every divisor above its physical floor', () => {
    const c = clampParams({
      ...DEFAULT_SIM_PARAMS,
      machine: { ...DEFAULT_SIM_PARAMS.machine, powerKw: 0, massKg: 0 },
      tyre: { ...DEFAULT_SIM_PARAMS.tyre, mu: 0, gripScale: 0, maxLeanDeg: 0 },
      rider: { ...DEFAULT_SIM_PARAMS.rider, brakingG: 0 },
    });
    expect(c.machine.powerKw).toBeGreaterThan(0);
    expect(c.machine.massKg).toBeGreaterThan(0);
    expect(c.tyre.mu).toBeGreaterThan(0);
    expect(c.tyre.gripScale).toBeGreaterThan(0);
    expect(c.tyre.maxLeanDeg).toBeGreaterThan(0);
    expect(c.rider.brakingG).toBeGreaterThan(0);
  });

  it('keeps kappa, lean usage and TC threshold inside 0..1', () => {
    const c = clampParams({
      ...DEFAULT_SIM_PARAMS,
      rider: { ...DEFAULT_SIM_PARAMS.rider, kappa: 5, leanUsage: -2, tcThreshold: 9 },
    });
    expect(c.rider.kappa).toBe(1);
    expect(c.rider.leanUsage).toBe(0);
    expect(c.rider.tcThreshold).toBe(1);
  });
});
