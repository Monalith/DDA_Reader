import { describe, expect, it } from 'vitest';
import {
  dependencies,
  evaluate,
  orderByDependencies,
  parseExpr,
  type EvalEnv,
} from '../../src/core/mathExpr';

function env(channels: Record<string, number[]>, dtS = 0.1, lapStarts?: number[]): EvalEnv {
  const map = new Map<string, Float32Array>();
  for (const [k, v] of Object.entries(channels)) map.set(k, Float32Array.from(v));
  return {
    get(name: string) {
      const v = map.get(name);
      if (!v) throw new Error(`unknown channel: ${name}`);
      return v;
    },
    dtS,
    lapStarts,
  };
}

describe('parseExpr', () => {
  it('parses numbers, identifiers and nested calls', () => {
    const ast = parseExpr('abs(rpm / speed) + 1');
    expect(ast).toBeTruthy();
    expect(dependencies(ast)).toEqual(['rpm', 'speed']);
  });

  it('respects operator precedence (* before +)', () => {
    const e = env({ a: [2, 2], b: [3, 3], c: [4, 4] });
    const v = evaluate(parseExpr('a + b * c'), e);
    expect(Array.from(v)).toEqual([14, 14]);
  });

  it('makes ^ right associative', () => {
    const e = env({ a: [2, 2] });
    const v = evaluate(parseExpr('2 ^ 3 ^ 2 * a / a'), e);
    expect(v[0]).toBeCloseTo(512, 6);
  });

  it('throws a SyntaxError mentioning the position', () => {
    let err: unknown;
    try {
      parseExpr('rpm / * speed');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SyntaxError);
    expect((err as Error).message).toMatch(/at position 6/);
  });

  it('throws on an unterminated expression', () => {
    expect(() => parseExpr('rpm +')).toThrow(/at position/);
  });

  it('throws on an unknown character', () => {
    expect(() => parseExpr('rpm # 2')).toThrow(SyntaxError);
  });
});

describe('dependencies', () => {
  it('excludes function names and de-duplicates', () => {
    const deps = dependencies(parseExpr('smooth(speed, 5) + deriv(speed) - rpm'));
    expect(deps).toEqual(['speed', 'rpm']);
  });
});

describe('evaluate', () => {
  it('evaluates rpm / speed elementwise', () => {
    const e = env({ rpm: [1000, 2000, 3000], speed: [10, 20, 30] });
    const v = evaluate(parseExpr('rpm / speed'), e);
    expect(v).toBeInstanceOf(Float32Array);
    expect(Array.from(v)).toEqual([100, 100, 100]);
  });

  it('broadcasts scalars', () => {
    const e = env({ speed: [10, 20] });
    expect(Array.from(evaluate(parseExpr('speed * 2 + 1'), e))).toEqual([21, 41]);
  });

  it('throws when no channel gives the length', () => {
    expect(() => evaluate(parseExpr('1 + 2'), env({ speed: [1] }))).toThrow();
  });

  it('computes deriv of a ramp as the slope', () => {
    // ramp: v = 5 * t, dt = 0.1 s -> slope 5 per second
    const n = 20;
    const ramp = Array.from({ length: n }, (_, i) => 5 * i * 0.1);
    const v = evaluate(parseExpr('deriv(ramp)'), env({ ramp }));
    for (let i = 0; i < n; i++) expect(v[i]).toBeCloseTo(5, 4);
  });

  it('integrates a constant', () => {
    const v = evaluate(parseExpr('integ(one)'), env({ one: [1, 1, 1, 1] }));
    expect(Array.from(v).map((x) => Number(x.toFixed(6)))).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it('smooths with a moving average', () => {
    const v = evaluate(parseExpr('smooth(a, 3)'), env({ a: [0, 3, 0, 3, 0] }));
    expect(v[2]).toBeCloseTo(2, 6);
  });

  it('shifts by seconds with NaN fill', () => {
    const v = evaluate(parseExpr('shift(a, 0.2)'), env({ a: [1, 2, 3, 4, 5] }));
    expect(Number.isNaN(v[0])).toBe(true);
    expect(Number.isNaN(v[1])).toBe(true);
    expect(Array.from(v.slice(2))).toEqual([1, 2, 3]);
  });

  it('computes lap_min / lap_max per lap', () => {
    const e = env({ a: [5, 1, 9, 2, 8, 3] }, 0.1, [0, 3]);
    expect(Array.from(evaluate(parseExpr('lap_min(a)'), e))).toEqual([1, 1, 1, 2, 2, 2]);
    expect(Array.from(evaluate(parseExpr('lap_max(a)'), e))).toEqual([9, 9, 9, 8, 8, 8]);
  });

  it('falls back to the whole array when there are no laps', () => {
    const e = env({ a: [5, 1, 9] });
    expect(Array.from(evaluate(parseExpr('lap_max(a)'), e))).toEqual([9, 9, 9]);
  });

  it('selects with where() and 1/0 comparisons', () => {
    const e = env({ tps: [0, 30, 80], speed: [10, 20, 30] });
    expect(Array.from(evaluate(parseExpr('where(tps > 20, speed, 0)'), e))).toEqual([0, 20, 30]);
    expect(Array.from(evaluate(parseExpr('tps > 20'), e))).toEqual([0, 1, 1]);
    expect(Array.from(evaluate(parseExpr('tps > 20 && speed < 30'), e))).toEqual([0, 1, 0]);
    expect(Array.from(evaluate(parseExpr('!(tps == 0)'), e))).toEqual([0, 1, 1]);
    expect(Array.from(evaluate(parseExpr('tps != 0 || speed == 10'), e))).toEqual([1, 1, 1]);
  });

  it('supports abs, min, max, sqrt, pow and unary minus', () => {
    const e = env({ a: [-4, 9] });
    expect(Array.from(evaluate(parseExpr('abs(a)'), e))).toEqual([4, 9]);
    expect(Array.from(evaluate(parseExpr('sqrt(abs(a))'), e))).toEqual([2, 3]);
    expect(Array.from(evaluate(parseExpr('min(a, 0)'), e))).toEqual([-4, 0]);
    expect(Array.from(evaluate(parseExpr('max(a, 0)'), e))).toEqual([0, 9]);
    expect(Array.from(evaluate(parseExpr('pow(abs(a), 2)'), e))).toEqual([16, 81]);
    expect(Array.from(evaluate(parseExpr('-a'), e))).toEqual([4, -9]);
  });

  it('rejects unknown functions and wrong arity', () => {
    const e = env({ a: [1] });
    expect(() => evaluate(parseExpr('nope(a)'), e)).toThrow();
    expect(() => evaluate(parseExpr('smooth(a)'), e)).toThrow();
  });
});

describe('orderByDependencies', () => {
  it('sorts math channels so references come first', () => {
    const out = orderByDependencies([
      { name: 'c', expr: 'b + 1' },
      { name: 'b', expr: 'a * 2' },
      { name: 'a', expr: 'speed' },
    ]);
    expect(out.map((d) => d.name)).toEqual(['a', 'b', 'c']);
  });

  it('detects cycles', () => {
    expect(() =>
      orderByDependencies([
        { name: 'a', expr: 'b + 1' },
        { name: 'b', expr: 'a + 1' },
      ]),
    ).toThrow(/cycle: a -> b -> a/);
  });

  it('detects self cycles', () => {
    expect(() => orderByDependencies([{ name: 'a', expr: 'a + 1' }])).toThrow(/cycle: a -> a/);
  });
});

describe('extended function library', () => {
  const n = 100;
  const ramp = Float32Array.from({ length: n }, (_, i) => i); // 0..99
  const speed = Float32Array.from({ length: n }, (_, i) => 36 + i * 3.6); // km/h: +1 m/s per sample = 10 m/s²
  const env: EvalEnv = {
    get: (name) => (name === 'ramp' ? ramp : name === 'speed' ? speed : (() => { throw new Error('unknown ' + name); })()),
    dtS: 0.1,
    lapStarts: [0, 50],
  };
  const run = (src: string) => evaluate(parseExpr(src), env);

  it('constants are not dependencies and evaluate', () => {
    expect(dependencies(parseExpr('ramp * pi + g'))).toEqual(['ramp']);
    expect(run('ramp * 0 + pi')[0]).toBeCloseTo(Math.PI, 5);
  });
  it('trig / unit helpers', () => {
    expect(run('rad2deg(atan2(ramp * 0 + 1, ramp * 0 + 1))')[0]).toBeCloseTo(45, 4);
    expect(run('kmh2ms(speed)')[0]).toBeCloseTo(10, 4);
    expect(run('clamp(ramp, 10, 20)')[0]).toBe(10);
    expect(run('clamp(ramp, 10, 20)')[99]).toBe(20);
    expect(run('mod(ramp, 7)')[9]).toBe(2);
  });
  it('accel_g from a km/h speed ramp', () => {
    const a = run('accel_g(speed)');
    expect(a[50]).toBeCloseTo(10 / 9.80665, 3);
  });
  it('rolling statistics and median', () => {
    expect(run('rolling_max(ramp, 5)')[10]).toBe(12);
    expect(run('rolling_min(ramp, 5)')[10]).toBe(8);
    expect(run('median(ramp, 5)')[10]).toBe(10);
    expect(run('rolling_std(ramp, 5)')[10]).toBeCloseTo(Math.sqrt(2), 5);
  });
  it('lowpass keeps a constant, highpass removes it', () => {
    const c = run('lowpass(ramp * 0 + 5, 1)');
    expect(c[50]).toBeCloseTo(5, 3);
    expect(run('highpass(ramp * 0 + 5, 1)')[50]).toBeCloseTo(0, 3);
    expect(run('sg(ramp, 7)')[50]).toBeCloseTo(50, 3);
  });
  it('whole-channel and per-lap statistics', () => {
    expect(run('mean(ramp)')[0]).toBeCloseTo(49.5, 5);
    expect(run('cmax(ramp)')[0]).toBe(99);
    expect(run('lap_mean(ramp)')[10]).toBeCloseTo(24.5, 5);
    expect(run('lap_mean(ramp)')[60]).toBeCloseTo(74.5, 5);
    expect(run('lap_first(ramp)')[60]).toBe(50);
    expect(run('lap_last(ramp)')[10]).toBe(49);
    expect(run('lap_time(ramp)')[55]).toBeCloseTo(0.5, 5);
    expect(run('lap_progress(ramp)')[99]).toBeCloseTo(1, 5);
  });
  it('events: rising, falling, hold', () => {
    const r = run('rising(ramp >= 20)');
    expect(r[20]).toBe(1);
    expect(r[21]).toBe(0);
    expect(run('falling(ramp < 20)')[20]).toBe(1);
    const h = run('hold(ramp == 20, 0.5)');
    expect(h[24]).toBe(1);
    expect(h[26]).toBe(0);
  });
  it('diff, cumsum, lag, nanfill', () => {
    expect(run('diff(ramp)')[5]).toBe(1);
    expect(run('cumsum(ramp * 0 + 1)')[9]).toBe(10);
    expect(run('lag(ramp, 3)')[10]).toBe(7);
    expect(run('nanfill(lag(ramp, 3), -1)')[0]).toBe(-1);
  });
});
