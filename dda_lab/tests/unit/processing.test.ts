import { describe, expect, it } from 'vitest';
import { applyProc, autoGpsLag } from '../../src/core/processing';
import { makeTimeBase } from '../../src/core/resample';
import { DEFAULT_PROC } from '../../src/core/types';
import type { Channel, ChannelProc, Session } from '../../src/core/types';

function session(t: Float64Array): Session {
  return {
    id: 's1', name: 'test', source: 'dda', color: '#f60',
    t, channels: new Map(), laps: [],
    meta: { track: 'T', rider: 'R', note: '' },
  };
}

function channel(name: string, over: Partial<Channel> = {}): Channel {
  return {
    name, unit: '', kind: 'raw', data: new Float32Array(0),
    proc: { ...DEFAULT_PROC, filter: { ...DEFAULT_PROC.filter } },
    ...over,
  };
}

function proc(over: Partial<ChannelProc> = {}): ChannelProc {
  return { scale: 1, offset: 0, filter: { type: 'none' }, ...over };
}

describe('applyProc', () => {
  const t = makeTimeBase(10); // 0..10 s at 10 Hz, 101 samples

  it('resamples native-rate raw data onto the session time base', () => {
    const s = session(t);
    const ch = channel('speed', {
      raw: {
        t: Float64Array.from([0, 5, 10]),
        v: Float32Array.from([0, 50, 100]),
      },
    });
    const out = applyProc(ch, s);
    expect(out.length).toBe(t.length);
    expect(out[0]).toBeCloseTo(0, 4);
    expect(out[50]).toBeCloseTo(50, 4);
    expect(out[100]).toBeCloseTo(100, 4);
  });

  it('falls back to ch.data when there is no raw series', () => {
    const s = session(t);
    const data = new Float32Array(t.length);
    for (let i = 0; i < data.length; i++) data[i] = i;
    const ch = channel('rpm', { data });
    const out = applyProc(ch, s);
    expect([...out.slice(0, 3)]).toEqual([0, 1, 2]);
    expect(out).not.toBe(data); // never mutates the input
  });

  it('applies scale and offset', () => {
    const s = session(t);
    const data = new Float32Array(t.length).fill(10);
    const ch = channel('x', { data, proc: proc({ scale: 2, offset: -5 }) });
    const out = applyProc(ch, s);
    expect(out[0]).toBeCloseTo(15, 5);
  });

  it('inverts the sign after scaling when invert is set', () => {
    const s = session(t);
    const data = new Float32Array(t.length).fill(4);
    const ch = channel('lean', { data, proc: proc({ scale: 2, invert: true }) });
    const out = applyProc(ch, s);
    expect(out[0]).toBeCloseTo(-8, 5);
  });

  it('applies the moving-average filter', () => {
    const s = session(t);
    const data = new Float32Array(t.length);
    for (let i = 0; i < data.length; i++) data[i] = i % 2 === 0 ? 0 : 10;
    const ch = channel('noisy', { data, proc: proc({ filter: { type: 'ma', n: 5 } }) });
    const out = applyProc(ch, s);
    expect(out[50]).toBeGreaterThan(3);
    expect(out[50]).toBeLessThan(7);
  });

  it('applies the butterworth filter', () => {
    const s = session(t);
    const data = new Float32Array(t.length);
    for (let i = 0; i < data.length; i++) data[i] = i % 2 === 0 ? -1 : 1;
    const ch = channel('noisy', {
      data, proc: proc({ filter: { type: 'butter', cutoffHz: 0.5 } }),
    });
    const out = applyProc(ch, s);
    expect(Math.abs(out[50])).toBeLessThan(0.3);
  });

  it('applies the Savitzky-Golay filter', () => {
    const s = session(t);
    const data = new Float32Array(t.length);
    for (let i = 0; i < data.length; i++) data[i] = i * i;
    const ch = channel('q', { data, proc: proc({ filter: { type: 'sg', n: 7 } }) });
    const out = applyProc(ch, s);
    expect(out[50]).toBeCloseTo(2500, 0);
  });

  it('shifts the series by gpsLagS (positive = channel lags behind reality)', () => {
    const s = session(t);
    const data = new Float32Array(t.length);
    for (let i = 0; i < data.length; i++) data[i] = i;
    const ch = channel('gps_speed', { data, proc: proc({ gpsLagS: 0.4 }) });
    const out = applyProc(ch, s);
    expect(out[10]).toBeCloseTo(14, 5); // value that arrived 0.4 s = 4 samples later
    expect(Number.isNaN(out[t.length - 1])).toBe(true);
  });

  it('holds state channels (gear, lap_mark) instead of interpolating', () => {
    const s = session(t);
    const ch = channel('gear', {
      raw: { t: Float64Array.from([0, 5, 10]), v: Float32Array.from([2, 3, 4]) },
    });
    const out = applyProc(ch, s);
    expect(out[10]).toBe(2); // t = 1 s, still gear 2
    expect(out[49]).toBe(2);
    expect(out[50]).toBe(3);
  });
});

describe('autoGpsLag', () => {
  const dt = 0.1;
  const n = 600;
  const wheel = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    wheel[i] = 100 + 40 * Math.sin((2 * Math.PI * i) / 150) + 10 * Math.sin((2 * Math.PI * i) / 37);
  }

  it('recovers a 0.4 s delay within 0.1 s', () => {
    const lagSamples = 4;
    const gps = new Float32Array(n).fill(NaN);
    for (let i = lagSamples; i < n; i++) gps[i] = wheel[i - lagSamples];
    expect(Math.abs(autoGpsLag(wheel, gps, dt) - 0.4)).toBeLessThanOrEqual(0.1);
  });

  it('recovers a negative (early) lag', () => {
    const lagSamples = 3;
    const gps = new Float32Array(n).fill(NaN);
    for (let i = 0; i < n - lagSamples; i++) gps[i] = wheel[i + lagSamples];
    expect(Math.abs(autoGpsLag(wheel, gps, dt) + 0.3)).toBeLessThanOrEqual(0.1);
  });

  it('returns 0 for identical signals', () => {
    expect(autoGpsLag(wheel, wheel, dt)).toBe(0);
  });

  it('never exceeds maxLagS', () => {
    const lag = autoGpsLag(wheel, new Float32Array(n).fill(1), dt, 0.5);
    expect(Math.abs(lag)).toBeLessThanOrEqual(0.5);
  });
});
