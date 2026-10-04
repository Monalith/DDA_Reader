// Channel processing pipeline: raw -> resample -> scale/offset -> filter -> lag/invert.
import { butterworthLowpass, movingAverage, savitzkyGolay } from './filters';
import { resampleLinear, resampleStep } from './resample';
import type { Channel, Session } from './types';

/** Channels that are states, not continuous signals: hold, never interpolate. */
export const STEP_CHANNELS = new Set(['gear', 'lap_mark', 'int1', 'int2', 'phase']);

function sampleHz(t: Float64Array): number {
  if (t.length < 2) return 10;
  const dt = t[1] - t[0];
  return dt > 0 ? 1 / dt : 10;
}

/**
 * Processed 10 Hz data for `ch` on `s.t`: native `ch.raw` (or `ch.data` when a
 * channel has no native series) resampled, then `scale`/`offset`, the selected
 * filter, the GPS lag shift and the sign inversion.
 */
export function applyProc(ch: Channel, s: Session): Float32Array {
  const t = s.t;
  const p = ch.proc;
  const step = STEP_CHANNELS.has(ch.name);

  let v: Float32Array;
  if (ch.raw && ch.raw.t.length) {
    v = step
      ? resampleStep(ch.raw.t, ch.raw.v, t)
      : resampleLinear(ch.raw.t, ch.raw.v, t);
  } else {
    v = new Float32Array(t.length).fill(NaN);
    const n = Math.min(t.length, ch.data.length);
    for (let i = 0; i < n; i++) v[i] = ch.data[i];
  }

  const scale = p.scale ?? 1;
  const offset = p.offset ?? 0;
  if (scale !== 1 || offset !== 0) {
    for (let i = 0; i < v.length; i++) v[i] = v[i] * scale + offset;
  }

  const f = p.filter;
  if (f && f.type !== 'none' && !step) {
    const hz = sampleHz(t);
    if (f.type === 'ma') v = movingAverage(v, Math.max(1, Math.round(f.n ?? 5)));
    else if (f.type === 'sg') v = savitzkyGolay(v, Math.max(5, Math.round(f.n ?? 7)), 2);
    else if (f.type === 'butter') v = butterworthLowpass(v, f.cutoffHz ?? 1, hz);
  }

  const lagS = p.gpsLagS ?? 0;
  if (lagS) {
    const dt = 1 / sampleHz(t);
    const k = Math.round(lagS / dt);
    if (k !== 0) {
      const shifted = new Float32Array(v.length).fill(NaN);
      for (let i = 0; i < v.length; i++) {
        const j = i + k;
        if (j >= 0 && j < v.length) shifted[i] = v[j];
      }
      v = shifted;
    }
  }

  if (p.invert) for (let i = 0; i < v.length; i++) v[i] = -v[i];

  return v;
}

/**
 * Cross-correlation lag (seconds) between a wheel-speed and a GPS-speed trace.
 * Positive means the GPS trace lags behind the wheel trace by that much, i.e.
 * it is the `gpsLagS` value that aligns them.
 */
export function autoGpsLag(
  wheelKmh: Float32Array,
  gpsKmh: Float32Array,
  dtS: number,
  maxLagS = 1.5,
): number {
  const n = Math.min(wheelKmh.length, gpsKmh.length);
  if (n < 4 || !(dtS > 0)) return 0;
  const maxK = Math.max(1, Math.min(n - 2, Math.round(maxLagS / dtS)));

  const stats = (v: Float32Array, lo: number, hi: number) => {
    let sum = 0;
    let cnt = 0;
    for (let i = lo; i < hi; i++) {
      if (Number.isNaN(v[i])) continue;
      sum += v[i];
      cnt++;
    }
    return cnt ? sum / cnt : NaN;
  };

  let bestK = 0;
  let best = -Infinity;
  for (let k = -maxK; k <= maxK; k++) {
    const lo = Math.max(0, -k);
    const hi = Math.min(n, n - k);
    if (hi - lo < n / 4) continue;
    const mw = stats(wheelKmh, lo, hi);
    const mg = stats(gpsKmh, lo + k, hi + k);
    if (Number.isNaN(mw) || Number.isNaN(mg)) continue;
    let num = 0;
    let dw = 0;
    let dg = 0;
    for (let i = lo; i < hi; i++) {
      const a = wheelKmh[i];
      const b = gpsKmh[i + k];
      if (Number.isNaN(a) || Number.isNaN(b)) continue;
      const x = a - mw;
      const y = b - mg;
      num += x * y;
      dw += x * x;
      dg += y * y;
    }
    if (dw <= 0 || dg <= 0) continue;
    const r = num / Math.sqrt(dw * dg);
    if (r > best + 1e-12) {
      best = r;
      bestK = k;
    }
  }
  return bestK * dtS;
}
