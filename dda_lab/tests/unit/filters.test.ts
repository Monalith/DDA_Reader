import { describe, expect, it } from 'vitest';
import {
  butterworthLowpass,
  derivative,
  movingAverage,
  savitzkyGolay,
} from '../../src/core/filters';

function rms(a: Float32Array, b: Float32Array): number {
  let s = 0;
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    if (Number.isNaN(a[i]) || Number.isNaN(b[i])) continue;
    s += (a[i] - b[i]) ** 2;
    n++;
  }
  return Math.sqrt(s / n);
}

function mulberry(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('movingAverage', () => {
  it('leaves a constant signal unchanged', () => {
    const v = new Float32Array(20).fill(5);
    const out = movingAverage(v, 5);
    expect([...out].every((x) => Math.abs(x - 5) < 1e-5)).toBe(true);
  });

  it('is a no-op for n <= 1', () => {
    const v = Float32Array.from([1, 9, 2]);
    expect([...movingAverage(v, 1)]).toEqual([1, 9, 2]);
  });

  it('averages a centred window and shrinks at the edges', () => {
    const v = Float32Array.from([1, 2, 3, 4, 5]);
    const out = movingAverage(v, 3);
    expect(out[0]).toBeCloseTo(1.5, 5); // [1,2]
    expect(out[2]).toBeCloseTo(3, 5);
    expect(out[4]).toBeCloseTo(4.5, 5);
  });

  it('skips NaN samples but keeps NaN where input is NaN', () => {
    const v = Float32Array.from([1, NaN, 3]);
    const out = movingAverage(v, 3);
    expect(Number.isNaN(out[1])).toBe(true);
    expect(out[0]).toBeCloseTo(1, 5);
    expect(out[2]).toBeCloseTo(3, 5);
  });

  it('reduces noise RMS on a smooth signal', () => {
    const rnd = mulberry(7);
    const n = 500;
    const clean = new Float32Array(n);
    const noisy = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      clean[i] = Math.sin((2 * Math.PI * i) / 200);
      noisy[i] = clean[i] + (rnd() - 0.5) * 0.6;
    }
    const out = movingAverage(noisy, 11);
    expect(rms(out, clean)).toBeLessThan(rms(noisy, clean) * 0.5);
  });
});

describe('savitzkyGolay', () => {
  it('reproduces a quadratic exactly', () => {
    const n = 40;
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) v[i] = 3 * i * i - 2 * i + 1;
    const out = savitzkyGolay(v, 7, 2);
    for (let i = 3; i < n - 3; i++) expect(out[i] / v[i]).toBeCloseTo(1, 3);
  });

  it('smooths noise better than it distorts a peak', () => {
    const rnd = mulberry(3);
    const n = 400;
    const clean = new Float32Array(n);
    const noisy = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      clean[i] = Math.sin((2 * Math.PI * i) / 150);
      noisy[i] = clean[i] + (rnd() - 0.5) * 0.5;
    }
    const out = savitzkyGolay(noisy, 15, 2);
    expect(rms(out, clean)).toBeLessThan(rms(noisy, clean) * 0.6);
  });

  it('is a no-op for a window below 5', () => {
    const v = Float32Array.from([1, 7, 2, 9]);
    expect([...savitzkyGolay(v, 3, 2)]).toEqual([1, 7, 2, 9]);
  });
});

describe('butterworthLowpass', () => {
  it('reduces the RMS error of a noisy sine by more than 50 %', () => {
    const rnd = mulberry(11);
    const n = 1000;
    const hz = 10;
    const clean = new Float32Array(n);
    const noisy = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      clean[i] = Math.sin((2 * Math.PI * 0.2 * i) / hz); // 0.2 Hz
      noisy[i] = clean[i] + (rnd() - 0.5) * 0.8;
    }
    const out = butterworthLowpass(noisy, 1, hz);
    expect(rms(out, clean)).toBeLessThan(rms(noisy, clean) * 0.5);
  });

  it('is zero-phase: a pure low-frequency sine keeps its phase', () => {
    const n = 600;
    const hz = 10;
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) v[i] = Math.sin((2 * Math.PI * 0.1 * i) / hz);
    const out = butterworthLowpass(v, 1, hz);
    for (let i = 100; i < n - 100; i++) expect(Math.abs(out[i] - v[i])).toBeLessThan(0.05);
  });

  it('passes DC unchanged and handles NaN gaps', () => {
    const v = new Float32Array(100).fill(4);
    v[50] = NaN;
    const out = butterworthLowpass(v, 1, 10);
    expect(out[10]).toBeCloseTo(4, 3);
    expect(Number.isNaN(out[50])).toBe(true);
  });

  it('returns a copy when the cutoff is at or above Nyquist', () => {
    const v = Float32Array.from([1, 5, 2]);
    expect([...butterworthLowpass(v, 20, 10)]).toEqual([1, 5, 2]);
  });
});

describe('derivative', () => {
  it('returns the slope of a ramp', () => {
    const n = 20;
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) v[i] = 2 * (i * 0.1); // 2 units per second
    const d = derivative(v, 0.1);
    for (let i = 0; i < n; i++) expect(d[i]).toBeCloseTo(2, 3);
  });

  it('is zero for a constant', () => {
    const d = derivative(new Float32Array(10).fill(3), 0.1);
    expect([...d].every((x) => Math.abs(x) < 1e-5)).toBe(true);
  });

  it('propagates NaN', () => {
    const v = Float32Array.from([0, 1, NaN, 3, 4]);
    const d = derivative(v, 1);
    expect(Number.isNaN(d[2])).toBe(true);
  });

  it('is empty-safe', () => {
    expect(derivative(new Float32Array(0), 0.1).length).toBe(0);
    expect(derivative(Float32Array.from([5]), 0.1).length).toBe(1);
  });
});
