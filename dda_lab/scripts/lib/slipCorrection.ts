// Rear-slip reading for the Ducati DDA export (research R2 §3.6).
//
// The export's `wheel_slip_pct` is `(speed_kmh − gps_speed_kmh)/gps_speed_kmh`
// sample by sample (dda_core.py §4b). Three things in it are not slip:
//
//   1. a constant speedometer offset (the dash reads high);
//   2. a lean term: at lean the contact patch rides on a smaller rolling
//      radius, so the wheel turns faster for the same ground speed,
//      ≈ c2·(1 − cos φ) (R2 §3.6 a, toroidal tyre);
//   3. the GPS speed lags the wheel, which reads as positive slip while
//      accelerating and negative while braking.
//
// And sample by sample it is mostly noise: about one GPS fix in five is a
// repeat of the previous one (`raw_lat/raw_lon` unchanged at 10 Hz), so the
// per-sample GPS speed alternates by ±20-40 km/h. So: ground speed comes from
// GPS DISTANCE over a window of samples, shifted by the estimated lag, and
// is compared with the wheel distance over the same window; (1) and (2) are
// then fitted on coasting samples, where the true slip is ≈ 0, and removed.

/** One (windowed) observation for the lean fit. */
export interface SlipSample {
  /** Measured (wheel − ground)/ground, %. */
  slipPct: number;
  /** Lean, degrees (sign irrelevant). For a window, the angle whose 1 − cos is the window mean. */
  leanDeg: number;
  tpsPct: number;
  accelLongG: number;
  torqueFastPct: number;
  torqueSlowPct: number;
}

export interface CoastSelect {
  /** Throttle closed: below this, % (R2 §3.6 b: "~5-10 %"; plan W4: 8). */
  tpsMaxPct: number;
  /** No net acceleration: |a| below this, g (R2: 0.05). */
  accelAbsMaxG: number;
}

export const STRICT_COAST: CoastSelect = { tpsMaxPct: 8, accelAbsMaxG: 0.05 };

export function isCoasting(s: SlipSample, sel: CoastSelect = STRICT_COAST): boolean {
  return (
    s.tpsPct < sel.tpsMaxPct &&
    Math.abs(s.accelLongG) < sel.accelAbsMaxG &&
    s.torqueFastPct === 0 &&
    s.torqueSlowPct === 0 &&
    Number.isFinite(s.slipPct)
  );
}

export interface SlipLeanFit {
  /** Offset, % (speedometer calibration + rolling resistance). */
  c0: number;
  /** Lean coefficient, % per unit (1 − cos φ). */
  c2: number;
  /** Coasting samples used; 0 means no fit. */
  n: number;
  rmsPct: number;
  /** Range of (1 − cos φ) the fit saw: a fit over upright samples only cannot say much about c2. */
  xMin: number;
  xMax: number;
}

const D2R = Math.PI / 180;
const leanX = (leanDeg: number): number => 1 - Math.cos(leanDeg * D2R);

/** Least squares slip = c0 + c2·(1 − cos φ) over the coasting samples. */
export function fitSlipLean(samples: SlipSample[], sel: CoastSelect = STRICT_COAST, minN = 20): SlipLeanFit {
  const use = samples.filter((s) => isCoasting(s, sel));
  const none: SlipLeanFit = { c0: Number.NaN, c2: Number.NaN, n: 0, rmsPct: Number.NaN, xMin: Number.NaN, xMax: Number.NaN };
  if (use.length < minN) return none;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  let xMin = Infinity;
  let xMax = -Infinity;
  for (const s of use) {
    const x = leanX(s.leanDeg);
    sx += x;
    sy += s.slipPct;
    sxx += x * x;
    sxy += x * s.slipPct;
    xMin = Math.min(xMin, x);
    xMax = Math.max(xMax, x);
  }
  const m = use.length;
  const det = m * sxx - sx * sx;
  if (!(Math.abs(det) > 1e-12)) return none;
  const c2 = (m * sxy - sx * sy) / det;
  const c0 = (sy - c2 * sx) / m;
  let ss = 0;
  for (const s of use) ss += (s.slipPct - c0 - c2 * leanX(s.leanDeg)) ** 2;
  return { c0, c2, n: m, rmsPct: Math.sqrt(ss / m), xMin, xMax };
}

/** The not-slip part of the reading at this lean, %. */
export function slipBaselinePct(fit: SlipLeanFit, leanDeg: number): number {
  return fit.c0 + fit.c2 * leanX(leanDeg);
}

/** κ_corr = measured − baseline(φ), % (R2 §3.6 b step 3). */
export function correctedSlipPct(fit: SlipLeanFit, slipPct: number, leanDeg: number): number {
  return slipPct - slipBaselinePct(fit, leanDeg);
}

/** Linear interpolation of `y` at fractional index `x`; NaN outside. */
function atFrac(y: ArrayLike<number>, x: number): number {
  const i = Math.floor(x);
  if (i < 0 || i >= y.length - 1) return x === y.length - 1 ? y[y.length - 1] : Number.NaN;
  const f = x - i;
  return y[i] + (y[i + 1] - y[i]) * f;
}

function meanStep(tS: ArrayLike<number>): number {
  return (tS[tS.length - 1] - tS[0]) / Math.max(1, tS.length - 1);
}

/** Wheel distance by trapezoid, metres, cumulative. */
function wheelCumM(tS: ArrayLike<number>, wheelKmh: ArrayLike<number>): Float64Array {
  const c = new Float64Array(tS.length);
  for (let i = 1; i < tS.length; i++) c[i] = c[i - 1] + ((wheelKmh[i - 1] + wheelKmh[i]) / 2 / 3.6) * (tS[i] - tS[i - 1]);
  return c;
}

/**
 * Windowed speeds at sample i over [i − H, i + H], m/s: wheel, and GPS read
 * `lagS` later (the GPS position at t + lag is where the bike was at t).
 */
function windowSpeeds(
  tS: ArrayLike<number>,
  wCum: Float64Array,
  gpsCumM: ArrayLike<number>,
  i: number,
  H: number,
  shift: number,
): [number, number] {
  const span = tS[i + H] - tS[i - H];
  const vW = (wCum[i + H] - wCum[i - H]) / span;
  const vG = (atFrac(gpsCumM, i + H + shift) - atFrac(gpsCumM, i - H + shift)) / span;
  return [vW, vG];
}

export interface LagEstimate {
  /** GPS delay behind the wheel speed, seconds. */
  lagS: number;
  /** Least-squares wheel/GPS speed ratio at that lag (speedometer scale). */
  scale: number;
  /** Residual of wheel − scale·GPS, km/h. */
  rmsKmh: number;
  n: number;
}

/**
 * Grid search for the GPS lag that makes the windowed GPS speed track the
 * wheel speed best (least residual after a free scale). `use(i)` restricts
 * the samples (the script passes "upright", where the lean term is absent).
 */
export function estimateGpsLag(
  tS: ArrayLike<number>,
  wheelKmh: ArrayLike<number>,
  gpsCumM: ArrayLike<number>,
  opts: { maxLagS?: number; stepS?: number; halfWindow?: number; minKmh?: number; use?: (i: number) => boolean } = {},
): LagEstimate {
  const H = opts.halfWindow ?? 5;
  const dt = meanStep(tS);
  const wCum = wheelCumM(tS, wheelKmh);
  const minMs = (opts.minKmh ?? 40) / 3.6;
  let best: LagEstimate = { lagS: Number.NaN, scale: Number.NaN, rmsKmh: Infinity, n: 0 };
  const maxLag = opts.maxLagS ?? 0.6;
  const step = opts.stepS ?? 0.01;
  for (let lag = -0.2; lag <= maxLag + 1e-9; lag += step) {
    const shift = lag / dt;
    const pairs: Array<[number, number]> = [];
    for (let i = H + 1; i < tS.length - H - 1; i++) {
      if (opts.use && !opts.use(i)) continue;
      const [vW, vG] = windowSpeeds(tS, wCum, gpsCumM, i, H, shift);
      if (Number.isFinite(vG) && vG > minMs) pairs.push([vW, vG]);
    }
    if (pairs.length < 10) continue;
    let num = 0;
    let den = 0;
    for (const [w, g] of pairs) {
      num += w * g;
      den += g * g;
    }
    const k = num / den;
    let ss = 0;
    for (const [w, g] of pairs) ss += (w - k * g) ** 2;
    const rms = Math.sqrt(ss / pairs.length) * 3.6;
    if (rms < best.rmsKmh) best = { lagS: Math.round(lag * 1000) / 1000, scale: k, rmsKmh: rms, n: pairs.length };
  }
  return best;
}

/** Lag-corrected ground speed from GPS distance over 2H + 1 samples, m/s (NaN near the ends). */
export function gpsSpeedMs(tS: ArrayLike<number>, gpsCumM: ArrayLike<number>, lagS: number, H: number): Float32Array {
  const n = tS.length;
  const out = new Float32Array(n).fill(Number.NaN);
  const shift = lagS / meanStep(tS);
  for (let i = H; i < n - H; i++) {
    out[i] = (atFrac(gpsCumM, i + H + shift) - atFrac(gpsCumM, i - H + shift)) / (tS[i + H] - tS[i - H]);
  }
  return out;
}

/**
 * Windowed slip, %: wheel distance against lag-corrected GPS distance over
 * 2H + 1 samples. NaN near the ends and below `minKmh` of ground speed.
 */
export function windowedSlip(
  tS: ArrayLike<number>,
  wheelKmh: ArrayLike<number>,
  gpsCumM: ArrayLike<number>,
  lagS: number,
  H: number,
  minKmh = 40,
): Float32Array {
  const n = tS.length;
  const out = new Float32Array(n).fill(Number.NaN);
  const wCum = wheelCumM(tS, wheelKmh);
  const shift = lagS / meanStep(tS);
  for (let i = H; i < n - H; i++) {
    const [vW, vG] = windowSpeeds(tS, wCum, gpsCumM, i, H, shift);
    if (Number.isFinite(vG) && vG * 3.6 >= minKmh) out[i] = ((vW - vG) / vG) * 100;
  }
  return out;
}
