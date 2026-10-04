// Native-rate -> common time base resampling. NaN marks "no data".

/** Common time base: 0 .. durationS at `hz` samples per second (inclusive of 0). */
export function makeTimeBase(durationS: number, hz = 10): Float64Array {
  if (!Number.isFinite(durationS) || durationS < 0) return new Float64Array(0);
  const n = Math.floor(durationS * hz + 1e-9) + 1;
  const t = new Float64Array(n);
  for (let i = 0; i < n; i++) t[i] = i / hz;
  return t;
}

/** Linear interpolation onto `tOut`. NaN outside [t[0], t[n-1]] and across NaN values. */
export function resampleLinear(
  t: Float64Array,
  v: ArrayLike<number>,
  tOut: Float64Array,
): Float32Array {
  const out = new Float32Array(tOut.length).fill(NaN);
  const n = Math.min(t.length, v.length);
  if (n === 0) return out;
  if (n === 1) {
    for (let i = 0; i < tOut.length; i++) if (tOut[i] === t[0]) out[i] = v[0];
    return out;
  }
  let j = 0;
  for (let i = 0; i < tOut.length; i++) {
    const x = tOut[i];
    if (!(x >= t[0]) || x > t[n - 1]) continue;
    while (j < n - 2 && t[j + 1] < x) j++;
    while (j > 0 && t[j] > x) j--;
    const t0 = t[j];
    const t1 = t[j + 1];
    const v0 = v[j];
    const v1 = v[j + 1];
    if (x === t0) {
      out[i] = v0;
    } else if (x === t1) {
      out[i] = v1;
    } else if (t1 > t0) {
      out[i] = v0 + ((v1 - v0) * (x - t0)) / (t1 - t0);
    }
  }
  return out;
}

/** Sample-and-hold (previous value) resampling; for integer/state channels. */
export function resampleStep(
  t: Float64Array,
  v: ArrayLike<number>,
  tOut: Float64Array,
): Float32Array {
  const out = new Float32Array(tOut.length).fill(NaN);
  const n = Math.min(t.length, v.length);
  if (n === 0) return out;
  let j = 0;
  for (let i = 0; i < tOut.length; i++) {
    const x = tOut[i];
    if (!(x >= t[0]) || x > t[n - 1]) continue;
    while (j < n - 1 && t[j + 1] <= x) j++;
    while (j > 0 && t[j] > x) j--;
    out[i] = v[j];
  }
  return out;
}
