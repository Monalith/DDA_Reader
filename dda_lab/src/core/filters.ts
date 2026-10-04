// Signal filters used by the channel processing pipeline and derived channels.
// Every filter is NaN-safe: NaN input stays NaN on output.

/** Centred moving average of width `n`; the window shrinks at the edges. */
export function movingAverage(v: Float32Array, n: number): Float32Array {
  const len = v.length;
  const out = new Float32Array(len);
  if (n <= 1) {
    out.set(v);
    return out;
  }
  const half = Math.floor(n / 2);
  for (let i = 0; i < len; i++) {
    if (Number.isNaN(v[i])) {
      out[i] = NaN;
      continue;
    }
    let sum = 0;
    let cnt = 0;
    const lo = Math.max(0, i - half);
    const hi = Math.min(len - 1, i - half + n - 1);
    for (let k = lo; k <= hi; k++) {
      const x = v[k];
      if (Number.isNaN(x)) continue;
      sum += x;
      cnt++;
    }
    out[i] = cnt ? sum / cnt : NaN;
  }
  return out;
}

/** Solve a 3x3 system by Gaussian elimination (used for the SG fit). */
function solve3(A: number[][], b: number[]): number[] {
  const m = [
    [...A[0], b[0]],
    [...A[1], b[1]],
    [...A[2], b[2]],
  ];
  for (let c = 0; c < 3; c++) {
    let piv = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[piv][c])) piv = r;
    const tmp = m[c];
    m[c] = m[piv];
    m[piv] = tmp;
    const d = m[c][c] || 1e-300;
    for (let k = c; k < 4; k++) m[c][k] /= d;
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = m[r][c];
      if (!f) continue;
      for (let k = c; k < 4; k++) m[r][k] -= f * m[c][k];
    }
  }
  return [m[0][3], m[1][3], m[2][3]];
}

/** Savitzky-Golay smoothing coefficients for a quadratic fit over 2h+1 points. */
function sgCoeffs(window: number): Float32Array {
  const h = (window - 1) / 2;
  // normal equations for A = [1, x, x^2], x = -h..h; smoothed centre = row 0 of (A'A)^-1 A'
  const s: number[] = new Array(5).fill(0);
  for (let x = -h; x <= h; x++) for (let p = 0; p < 5; p++) s[p] += Math.pow(x, p);
  const ata = [
    [s[0], s[1], s[2]],
    [s[1], s[2], s[3]],
    [s[2], s[3], s[4]],
  ];
  // row of the pseudo-inverse giving the constant term: e0' (A'A)^-1 A'
  const w = solve3(ata, [1, 0, 0]); // (A'A)^-1 e0
  const c = new Float32Array(window);
  for (let i = 0, x = -h; x <= h; x++, i++) c[i] = w[0] + w[1] * x + w[2] * x * x;
  return c;
}

/** Savitzky-Golay smoothing (quadratic), mirrored at the edges. */
export function savitzkyGolay(v: Float32Array, window: number, order: 2 = 2): Float32Array {
  void order;
  const len = v.length;
  const out = new Float32Array(len);
  let w = Math.floor(window);
  if (w % 2 === 0) w += 1;
  if (w < 5 || len < w) {
    out.set(v);
    return out;
  }
  const c = sgCoeffs(w);
  const h = (w - 1) / 2;
  for (let i = 0; i < len; i++) {
    if (Number.isNaN(v[i])) {
      out[i] = NaN;
      continue;
    }
    let acc = 0;
    let wsum = 0;
    for (let k = -h; k <= h; k++) {
      let idx = i + k;
      if (idx < 0) idx = -idx; // mirror
      if (idx > len - 1) idx = 2 * (len - 1) - idx;
      const x = v[idx];
      if (Number.isNaN(x)) continue;
      acc += c[k + h] * x;
      wsum += c[k + h];
    }
    out[i] = wsum !== 0 ? acc / wsum : NaN;
  }
  return out;
}

/** Fill NaN gaps by linear interpolation (edges held); returns [filled, nanMask]. */
function fillNaN(v: Float32Array): [Float32Array, boolean[]] {
  const n = v.length;
  const mask: boolean[] = new Array(n);
  const f = new Float32Array(n);
  let firstValid = -1;
  for (let i = 0; i < n; i++) {
    mask[i] = Number.isNaN(v[i]);
    if (firstValid < 0 && !mask[i]) firstValid = i;
  }
  if (firstValid < 0) return [f.fill(0), mask];
  let prev = firstValid;
  for (let i = 0; i < n; i++) {
    if (!mask[i]) {
      f[i] = v[i];
      prev = i;
      continue;
    }
    // next valid
    let next = -1;
    for (let k = i + 1; k < n; k++) {
      if (!mask[k]) {
        next = k;
        break;
      }
    }
    if (i < firstValid) f[i] = v[firstValid];
    else if (next < 0) f[i] = v[prev];
    else f[i] = v[prev] + ((v[next] - v[prev]) * (i - prev)) / (next - prev);
  }
  return [f, mask];
}

/** 2nd-order Butterworth low-pass, applied forward and backward (zero phase). */
export function butterworthLowpass(
  v: Float32Array,
  cutoffHz: number,
  sampleHz: number,
): Float32Array {
  const n = v.length;
  const out = new Float32Array(n);
  if (n === 0) return out;
  if (!(cutoffHz > 0) || !(sampleHz > 0) || cutoffHz >= sampleHz / 2) {
    out.set(v);
    return out;
  }
  const [x, mask] = fillNaN(v);
  const w0 = Math.tan((Math.PI * cutoffHz) / sampleHz);
  const norm = 1 / (1 + Math.SQRT2 * w0 + w0 * w0);
  const b0 = w0 * w0 * norm;
  const b1 = 2 * b0;
  const b2 = b0;
  const a1 = 2 * (w0 * w0 - 1) * norm;
  const a2 = (1 - Math.SQRT2 * w0 + w0 * w0) * norm;

  const pass = (src: Float32Array, reverse: boolean): Float32Array => {
    const dst = new Float32Array(n);
    const first = reverse ? src[n - 1] : src[0];
    let x1 = first;
    let x2 = first;
    let y1 = first;
    let y2 = first;
    for (let k = 0; k < n; k++) {
      const i = reverse ? n - 1 - k : k;
      const xi = src[i];
      const yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = xi;
      y2 = y1;
      y1 = yi;
      dst[i] = yi;
    }
    return dst;
  };

  const fwd = pass(x, false);
  const res = pass(fwd, true);
  for (let i = 0; i < n; i++) out[i] = mask[i] ? NaN : res[i];
  return out;
}

/** Central-difference derivative per second; one-sided at the ends. */
export function derivative(v: Float32Array, dtS: number): Float32Array {
  const n = v.length;
  const out = new Float32Array(n).fill(NaN);
  if (n === 0 || !(dtS > 0)) return out;
  if (n === 1) {
    out[0] = 0;
    return out;
  }
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(v[i])) out[i] = NaN;
    else if (i === 0) out[0] = (v[1] - v[0]) / dtS;
    else if (i === n - 1) out[i] = (v[i] - v[i - 1]) / dtS;
    else out[i] = (v[i + 1] - v[i - 1]) / (2 * dtS);
  }
  return out;
}
