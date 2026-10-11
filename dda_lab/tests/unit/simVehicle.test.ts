import { describe, expect, it } from 'vitest';
import {
  BINIEWICZ_JY,
  J_Y_MIN,
  bikeLeanRad,
  cgHeightAtLean,
  idealLeanLimitRad,
  rollRateBoundRadPerS,
  stoppieLimitMs2,
  wheelieLimitMs2,
} from '../../src/sim/vehicle';
import { DEFAULT_SIM_PARAMS } from '../../src/sim/presets';

const M = { ...DEFAULT_SIM_PARAMS.machine, wheelbaseM: 1.44, cgRearM: 0.70, cgHeightM: 0.62, tyreCrownM: 0.08, hangOffM: 0, riderMassKg: 75, massKg: 270, cdA: 0.34 };
const G = 9.81;
const DEG = Math.PI / 180;

describe('vehicle limits', () => {
  it('stoppie limit upright is g·(p−b)/h', () => {
    expect(stoppieLimitMs2(M, 0)).toBeCloseTo((G * 0.74) / 0.62, 6); // 1.19 g, R1 §3.1
  });
  it('wheelie limit upright at rest is g·b/h, and falls with speed (drag lifts the front)', () => {
    expect(wheelieLimitMs2(M, 0, 0)).toBeCloseTo((G * 0.70) / 0.62, 6);
    expect(wheelieLimitMs2(M, 60, 0)).toBeLessThan(wheelieLimitMs2(M, 0, 0));
  });
  it('CG height drops at lean through the crown radius', () => {
    expect(cgHeightAtLean(M, 0)).toBeCloseTo(0.62, 9);
    expect(cgHeightAtLean(M, Math.PI / 4)).toBeCloseTo(0.08 + 0.54 * Math.SQRT1_2, 6);
  });
  it('the limits rise at lean (lower pitch arm) and never fall under 0.1 m/s^2', () => {
    expect(stoppieLimitMs2(M, Math.PI / 4)).toBeGreaterThan(stoppieLimitMs2(M, 0));
    expect(wheelieLimitMs2(M, 20, Math.PI / 4)).toBeGreaterThan(wheelieLimitMs2(M, 20, 0));
    // absurd speed: drag alone would lift the front, the floor keeps it positive
    expect(wheelieLimitMs2({ ...M, cdA: 1.5, massKg: 60 }, 200, 0)).toBeGreaterThanOrEqual(0.1);
  });
  it('crown adds lean; hang-off takes it back', () => {
    const phiI = 45 * DEG;
    const noHang = bikeLeanRad(M, phiI);
    expect(noHang - phiI).toBeGreaterThan(4 * DEG); // R1 table: +6.2° at t=0.08
    expect(noHang - phiI).toBeLessThan(8 * DEG);
    const hang = bikeLeanRad({ ...M, hangOffM: 0.25 }, phiI);
    expect(hang).toBeLessThan(noHang);
  });
  it('is zero upright with no hang-off, and odd in the ideal lean', () => {
    expect(bikeLeanRad(M, 0)).toBe(0);
    expect(bikeLeanRad(M, -0.5)).toBeCloseTo(-bikeLeanRad(M, 0.5), 12);
    expect(bikeLeanRad({ ...M, hangOffM: 0.2 }, -0.5)).toBeCloseTo(-bikeLeanRad({ ...M, hangOffM: 0.2 }, 0.5), 12);
  });
  it('idealLeanLimitRad inverts bikeLeanRad and never returns NaN', () => {
    const maxBike = 58 * DEG;
    const phiI = idealLeanLimitRad(M, maxBike);
    expect(bikeLeanRad(M, phiI)).toBeCloseTo(maxBike, 4);
    const extreme = idealLeanLimitRad({ ...M, hangOffM: 0.5, riderMassKg: 40 }, maxBike);
    expect(Number.isFinite(extreme)).toBe(true);
    expect(extreme).toBeGreaterThan(0);
    // Review Focus 6: the extreme hang-off case still inverts
    expect(bikeLeanRad({ ...M, hangOffM: 0.5, riderMassKg: 40 }, extreme)).toBeCloseTo(maxBike, 4);
    // degenerate inputs stay finite
    expect(Number.isFinite(idealLeanLimitRad(M, 0))).toBe(true);
    expect(Number.isFinite(idealLeanLimitRad({ ...M, tyreCrownM: 0 }, maxBike))).toBe(true);
    expect(idealLeanLimitRad({ ...M, tyreCrownM: 0 }, maxBike)).toBeCloseTo(maxBike, 6);
  });
  it('roll-rate bound: ~100°/s at 20 m/s upright, halves at 45°', () => {
    const w20 = rollRateBoundRadPerS(20, 0);
    expect((w20 * 180) / Math.PI).toBeGreaterThan(90);
    expect((w20 * 180) / Math.PI).toBeLessThan(110);
    expect(rollRateBoundRadPerS(20, Math.PI / 4)).toBeCloseTo(w20 / 2, 6);
    expect(rollRateBoundRadPerS(40, 0)).toBeLessThan(w20);
    expect(rollRateBoundRadPerS(20, 0)).toBeCloseTo((BINIEWICZ_JY.beta0 + BINIEWICZ_JY.beta1 * 20) / G, 9);
  });
  it('floors the JERK at J_Y_MIN past the fit, keeping cos²φ', () => {
    // thesis fit reaches 6 m/s^3 at (23.5 - 6)/0.31 = 56.5 m/s
    expect(rollRateBoundRadPerS(80, 0)).toBeCloseTo(J_Y_MIN / G, 12);
    expect(rollRateBoundRadPerS(200, 0)).toBeCloseTo(J_Y_MIN / G, 12);
    expect(rollRateBoundRadPerS(80, Math.PI / 4)).toBeCloseTo(J_Y_MIN / G / 2, 12);
    // and inside the fit it is the fit
    expect(rollRateBoundRadPerS(30, 0)).toBeCloseTo((23.5 - 0.31 * 30) / G, 12);
  });
  it('roll-rate bound has a positive floor at any speed', () => {
    expect(rollRateBoundRadPerS(200, 0)).toBeGreaterThanOrEqual(0.05);
    expect(rollRateBoundRadPerS(20, Math.PI / 2)).toBeGreaterThanOrEqual(0.05);
  });
});
