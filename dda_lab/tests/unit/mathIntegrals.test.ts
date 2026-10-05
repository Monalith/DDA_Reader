import { describe, expect, it } from 'vitest';
import { evaluate, parseExpr, type EvalEnv } from '../../src/core/mathExpr';
import { integralExpr } from '../../src/ui/panels/MathPanel';

function env(channels: Record<string, number[]>, lapStarts?: number[]): EvalEnv {
  const map = new Map(Object.entries(channels).map(([k, v]) => [k, Float32Array.from(v)]));
  return {
    get: (n) => {
      const v = map.get(n);
      if (!v) throw new Error(`unknown ${n}`);
      return v;
    },
    dtS: 0.1,
    lapStarts,
  };
}

describe('integrals with a chosen x channel', () => {
  it('integ_x integrates y over x with the trapezoid rule', () => {
    // y = 2 everywhere, x = 0,10,20,30 → ∫ = 20, 40, 60
    const out = evaluate(parseExpr('integ_x(y, x)'), env({ y: [2, 2, 2, 2], x: [0, 10, 20, 30] }));
    expect(Array.from(out)).toEqual([0, 20, 40, 60]);
  });
  it('integ_x skips a wrap of x (lap distance back to 0) and NaN samples', () => {
    const out = evaluate(parseExpr('integ_x(y, x)'), env({ y: [1, 1, NaN, 1, 1], x: [0, 10, 20, 0, 5] }));
    expect(Array.from(out)).toEqual([0, 10, 10, 10, 15]);
  });
  it('lap_integ_x restarts at every lap start', () => {
    const out = evaluate(parseExpr('lap_integ_x(y, x)'), env({ y: [1, 1, 1, 1, 1, 1], x: [0, 1, 2, 0, 1, 2] }, [0, 3]));
    expect(Array.from(out)).toEqual([0, 1, 2, 0, 1, 2]);
  });
  it('lap_integ integrates over time and restarts per lap', () => {
    const out = evaluate(parseExpr('lap_integ(y)'), env({ y: [10, 10, 10, 10] }, [0, 2]));
    expect(Array.from(out).map((v) => Number(v.toFixed(6)))).toEqual([1, 2, 1, 2]);
  });
  it('deriv_x gives dy/dx with the chosen x', () => {
    const out = evaluate(parseExpr('deriv_x(y, x)'), env({ y: [0, 10, 20, 30], x: [0, 5, 10, 15] }));
    expect(Array.from(out)).toEqual([2, 2, 2, 2]);
  });
  it('builder writes the matching expression', () => {
    expect(integralExpr('speed', '', false)).toBe('integ(speed)');
    expect(integralExpr('speed', '', true)).toBe('lap_integ(speed)');
    expect(integralExpr('long_g', 'lap_dist', false)).toBe('integ_x(long_g, lap_dist)');
    expect(integralExpr('long_g', 'lap_dist', true)).toBe('lap_integ_x(long_g, lap_dist)');
  });
});
