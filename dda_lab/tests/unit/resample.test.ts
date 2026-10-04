import { describe, expect, it } from 'vitest';
import { makeTimeBase, resampleLinear, resampleStep } from '../../src/core/resample';

describe('makeTimeBase', () => {
  it('builds a 10 Hz base covering the duration', () => {
    const t = makeTimeBase(10);
    expect(t.length).toBe(101);
    expect(t[0]).toBe(0);
    expect(t[1]).toBeCloseTo(0.1, 12);
    expect(t[100]).toBeCloseTo(10, 12);
    expect(t).toBeInstanceOf(Float64Array);
  });

  it('honours a custom rate', () => {
    const t = makeTimeBase(2, 50);
    expect(t.length).toBe(101);
    expect(t[50]).toBeCloseTo(1, 12);
  });

  it('is empty-safe', () => {
    expect(makeTimeBase(0).length).toBe(1);
    expect(makeTimeBase(-1).length).toBe(0);
  });
});

describe('resampleLinear', () => {
  const t = Float64Array.from([0, 1, 2, 3]);
  const v = [0, 10, 20, 30]; // ramp: v = 10 t

  it('interpolates a ramp exactly', () => {
    const out = resampleLinear(t, v, Float64Array.from([0, 0.5, 1.25, 3]));
    expect(out).toBeInstanceOf(Float32Array);
    expect(out[0]).toBeCloseTo(0, 5);
    expect(out[1]).toBeCloseTo(5, 5);
    expect(out[2]).toBeCloseTo(12.5, 5);
    expect(out[3]).toBeCloseTo(30, 5);
  });

  it('is NaN outside the source range', () => {
    const out = resampleLinear(t, v, Float64Array.from([-0.5, 1, 3.5]));
    expect(Number.isNaN(out[0])).toBe(true);
    expect(out[1]).toBeCloseTo(10, 5);
    expect(Number.isNaN(out[2])).toBe(true);
  });

  it('handles a dense output base monotonically', () => {
    const tOut = makeTimeBase(3);
    const out = resampleLinear(t, v, tOut);
    for (let i = 1; i < out.length; i++) expect(out[i]).toBeGreaterThan(out[i - 1] - 1e-6);
    expect(out[out.length - 1]).toBeCloseTo(30, 4);
  });

  it('returns all NaN for an empty source', () => {
    const out = resampleLinear(new Float64Array(0), [], makeTimeBase(1));
    expect(out.length).toBe(11);
    expect([...out].every(Number.isNaN)).toBe(true);
  });
});

describe('resampleStep', () => {
  const t = Float64Array.from([0, 1, 2]);
  const v = [1, 2, 3];

  it('holds the previous sample', () => {
    const out = resampleStep(t, v, Float64Array.from([0, 0.9, 1, 1.9, 2]));
    expect([...out]).toEqual([1, 1, 2, 2, 3]);
  });

  it('is NaN before the first and after the last sample', () => {
    const out = resampleStep(t, v, Float64Array.from([-1, 0, 2.5]));
    expect(Number.isNaN(out[0])).toBe(true);
    expect(out[1]).toBe(1);
    expect(Number.isNaN(out[2])).toBe(true);
  });
});
