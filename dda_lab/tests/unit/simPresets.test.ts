import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clampParams, DEFAULT_SIM_PARAMS, MACHINE_PRESETS, presetById } from '../../src/sim/presets';
import { riderChannels } from '../../src/sim/rider';
import { solve } from '../../src/sim/solver';
import { cornerLine } from './simSolver.test';

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
    const lean250 = presetById('250').tyre.maxLeanDeg;
    const lean600 = presetById('600').tyre.maxLeanDeg;
    const lean1000 = presetById('1000').tyre.maxLeanDeg;
    const leanPanigale = presetById('panigale-v4').tyre.maxLeanDeg;
    expect(lean250).toBeLessThan(lean600);
    expect(lean600).toBeLessThan(lean1000);
    expect(lean1000).toBeLessThanOrEqual(leanPanigale);
  });

  it('puts the CG between 40 % and 60 % of the wheelbase from the rear contact', () => {
    for (const p of MACHINE_PRESETS) {
      const f = p.machine.cgRearM / p.machine.wheelbaseM;
      expect(f, p.id).toBeGreaterThanOrEqual(0.4);
      expect(f, p.id).toBeLessThanOrEqual(0.6);
    }
  });

  it('keeps the rider lighter than bike + rider and the v2 geometry in its physical range', () => {
    for (const p of MACHINE_PRESETS) {
      expect(p.machine.riderMassKg, p.id).toBeLessThan(p.machine.massKg);
      expect(p.machine.riderMassKg, p.id).toBeGreaterThan(0);
      // R1 §3.2: t ~ 0.06-0.09 m, d_r 0-0.3 m
      expect(p.machine.tyreCrownM, p.id).toBeGreaterThanOrEqual(0.05);
      expect(p.machine.tyreCrownM, p.id).toBeLessThanOrEqual(0.1);
      expect(p.machine.hangOffM, p.id).toBeGreaterThanOrEqual(0);
      expect(p.machine.hangOffM, p.id).toBeLessThanOrEqual(0.3);
    }
  });

  it('cites a source for every v2 machine number in every preset', () => {
    // Global constraint: a coefficient that is a proposal carries its source
    // and the tag öneri / doğrulanmadı. One field per line, each with a
    // `// source:` comment, so a grep can hold the file to it.
    const text = readFileSync(resolve(__dirname, '../../src/sim/presets.ts'), 'utf8');
    for (const key of ['cgRearM', 'tyreCrownM', 'hangOffM', 'riderMassKg']) {
      const lines = text.split('\n').filter((l) => new RegExp(`\\b${key}:\\s*[0-9.]`).test(l));
      expect(lines.length, key).toBe(MACHINE_PRESETS.length);
      for (const l of lines) expect(l, l).toMatch(/\/\/ source:.*\S/);
    }
  });

  it('falls back to custom for an unknown id instead of throwing', () => {
    expect(presetById('nope').id).toBe('custom');
  });
});

describe('clampParams', () => {
  it('holds every divisor above its physical floor', () => {
    const c = clampParams({
      ...DEFAULT_SIM_PARAMS,
      machine: { ...DEFAULT_SIM_PARAMS.machine, powerKw: 0, massKg: 0, wheelbaseM: 0, cgHeightM: 0 },
      tyre: { ...DEFAULT_SIM_PARAMS.tyre, mu: 0, gripScale: 0, maxLeanDeg: 0 },
      rider: { ...DEFAULT_SIM_PARAMS.rider, brakingG: 0 },
    });
    expect(c.machine.powerKw).toBeGreaterThan(0);
    expect(c.machine.massKg).toBeGreaterThan(0);
    expect(c.machine.wheelbaseM).toBeGreaterThan(0);
    expect(c.machine.cgHeightM).toBeGreaterThan(0);
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

  it('clamps the gear ratios themselves, not just the length of the list', () => {
    // Deferred #3: the length was guarded but the elements were not, and each
    // ratio is a DIVISOR in the rpm/gear model (`vAtLimit`), so a zero put
    // Infinity into `gear` and a NaN put NaN into `rpm` — for the whole lap,
    // from one bad slider value.
    const c = clampParams({
      ...DEFAULT_SIM_PARAMS,
      machine: { ...DEFAULT_SIM_PARAMS.machine, gearRatios: [0, -3, Number.NaN, 2.5, 99] },
    });
    expect(c.machine.gearRatios).toHaveLength(5);
    for (const r of c.machine.gearRatios) {
      expect(Number.isFinite(r)).toBe(true);
      expect(r).toBeGreaterThan(0);
      expect(r).toBeLessThanOrEqual(6);
    }
    // the one legal value is untouched
    expect(c.machine.gearRatios[3]).toBeCloseTo(2.5, 12);
  });

  it('keeps the rpm and gear channels finite when the gear ratios are nonsense', () => {
    // The NaN has to be in FIRST gear to be observable: `riderChannels` picks a
    // gear by comparing the speed against each ratio's rev-limited speed, and a
    // zero or negative ratio further up the box only makes that comparison
    // false, leaving the bike in a gear whose own ratio is sound. A NaN in
    // first is used at every sample, so without the clamp the whole `rpm`
    // channel comes out NaN.
    const p = clampParams({
      ...DEFAULT_SIM_PARAMS,
      machine: { ...DEFAULT_SIM_PARAMS.machine, gearRatios: [Number.NaN, 2.5, 0, -3] },
    });
    const line = cornerLine();
    const ch = riderChannels(line, solve(line, p), p);
    expect(ch.rpm.every(Number.isFinite)).toBe(true);
    expect(ch.rpm.every((r) => r > 0)).toBe(true);
    expect(ch.gear.every((g) => Number.isFinite(g) && g >= 1 && g <= 4)).toBe(true);
  });

  it('keeps trail-brake depth and profile inside 0..1', () => {
    const c = clampParams({
      ...DEFAULT_SIM_PARAMS,
      rider: { ...DEFAULT_SIM_PARAMS.rider, trailBrakeDepth: 5, trailBrakeProfile: -2 },
    });
    expect(c.rider.trailBrakeDepth).toBe(1);
    expect(c.rider.trailBrakeProfile).toBe(0);
  });
});
