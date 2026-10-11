// Shared measurement of a longitudinal-g trace, used by both the real
// reference laps and the simulator so the two are compared the same way.
//
// Everything here is descriptive: it reads a (s, t, long_g) trace and reports
// the distribution, the braking events and the shape of each event's leading
// edge. No model assumptions, so the same function can be pointed at a hand-read
// onboard lap and at `solve()`'s output.
import { readFileSync } from 'node:fs';

export interface Trace {
  /** Distance along the lap, metres, monotone. */
  sM: Float64Array;
  /** Elapsed time, seconds, monotone. */
  tS: Float64Array;
  /** Longitudinal acceleration, g; negative is braking. */
  g: Float64Array;
}

export interface BrakeEvent {
  startM: number;
  endM: number;
  /** Most negative g in the event. */
  peakG: number;
  peakM: number;
  /** Duration of the event, seconds. */
  durationS: number;
  /**
   * 10 %-to-90 %-of-peak rise time on the LEADING edge, seconds, walking back
   * from the peak. Chosen over "onset to peak" because both traces are
   * differentiated speed: the 0 crossing is where the noise lives, the 10-90
   * band is where the signal is.
   */
  riseS: number;
  /** 0.8 * |peak| / riseS, i.e. the mean rate of build over the 10-90 band, g/s. */
  riseRateGps: number;
  /**
   * The WHOLE leading edge: from the last sample before the peak at which the
   * trace was still within 0.08 g of zero, to the peak. Seconds.
   */
  onsetS: number;
  /** |peak| / onsetS, g/s — the brake build rate as a rider would quote it. */
  onsetRateGps: number;
  /** Peak to the end of the event, seconds. */
  bleedS: number;
}

export interface GMetrics {
  /** Fraction of samples with g < 0. */
  brakingFrac: number;
  /** Percentiles of the braking side (negative values, so p5 is deep). */
  brakeP5: number;
  brakeP25: number;
  brakeP50: number;
  brakeMin: number;
  /** Percentiles of the driving side. */
  driveP50: number;
  driveP95: number;
  driveMax: number;
  events: BrakeEvent[];
  /** Events whose peak is at or past `majorG` — the real braking zones. */
  major: BrakeEvent[];
  /** Mean / sd / full range of the major events' peaks, g. */
  majorPeakMean: number;
  majorPeakSd: number;
  majorPeakMin: number;
  majorPeakMax: number;
  /** majorPeakMin - majorPeakMax, i.e. how much the peak varies zone to zone. */
  majorPeakSpread: number;
  /** Median over the major events. */
  medianRiseS: number;
  medianRiseRateGps: number;
  /** The single deepest braking event of the lap. */
  deepest: BrakeEvent | undefined;
}

export interface GMetricsOptions {
  /** Centred box filter width in TIME, seconds. */
  smoothS?: number;
  /** A sample counts as braking for event detection below this, g. */
  eventThreshG?: number;
  /** Shorter runs than this are not an application, seconds. */
  minEventS?: number;
  /** Runs separated by less than this are the same application, seconds. */
  mergeGapS?: number;
  /** An event is a real braking zone at or past this peak, g. */
  majorG?: number;
}

/**
 * The trace counts as "not braking yet" within this of zero, g. Both
 * references are a differentiated read speed and neither sits at exactly 0 on
 * the approach, so a strict zero crossing would walk the onset back into the
 * previous corner.
 */
const ONSET_G = 0.08;

const DEFAULTS = {
  smoothS: 0.12,
  eventThreshG: -0.15,
  minEventS: 0.1,
  mergeGapS: 0.25,
  majorG: -0.5,
};

/** Centred box filter in time over samples that are regular in DISTANCE. */
function smoothInTime(tS: Float64Array, g: Float64Array, winS: number): Float64Array {
  const n = g.length;
  const out = new Float64Array(n);
  if (winS <= 0) {
    out.set(g);
    return out;
  }
  const half = winS / 2;
  for (let i = 0; i < n; i++) {
    let sum = g[i];
    let count = 1;
    for (let j = i - 1; j >= 0 && tS[i] - tS[j] <= half; j--) {
      sum += g[j];
      count++;
    }
    for (let j = i + 1; j < n && tS[j] - tS[i] <= half; j++) {
      sum += g[j];
      count++;
    }
    out[i] = sum / count;
  }
  return out;
}

export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return Number.NaN;
  const k = ((sorted.length - 1) * p) / 100;
  const f = Math.floor(k);
  const c = Math.min(f + 1, sorted.length - 1);
  return sorted[f] + (sorted[c] - sorted[f]) * (k - f);
}

function median(xs: number[]): number {
  if (!xs.length) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  return percentile(s, 50);
}

export function gMetrics(trace: Trace, opts: GMetricsOptions = {}): GMetrics {
  const o = { ...DEFAULTS, ...opts };
  const { sM, tS } = trace;
  const g = smoothInTime(tS, trace.g, o.smoothS);
  const n = g.length;

  const brake: number[] = [];
  const drive: number[] = [];
  for (let i = 0; i < n; i++) {
    if (g[i] < 0) brake.push(g[i]);
    else if (g[i] > 0) drive.push(g[i]);
  }
  brake.sort((a, b) => a - b);
  drive.sort((a, b) => a - b);

  // raw runs below the threshold, then merged across short gaps
  const runs: Array<[number, number]> = [];
  for (let i = 0; i < n; ) {
    if (g[i] >= o.eventThreshG) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && g[j] < o.eventThreshG) j++;
    const last = runs[runs.length - 1];
    if (last && tS[i] - tS[last[1]] < o.mergeGapS) last[1] = j - 1;
    else runs.push([i, j - 1]);
    i = j;
  }

  const events: BrakeEvent[] = [];
  for (const [s, e] of runs) {
    if (tS[e] - tS[s] < o.minEventS) continue;
    let peakIdx = s;
    for (let i = s; i <= e; i++) if (g[i] < g[peakIdx]) peakIdx = i;
    const peakG = g[peakIdx];
    // 10-90 of peak, walking back from the peak
    let k90 = peakIdx;
    while (k90 > 0 && g[k90] <= 0.9 * peakG) k90--;
    let k10 = k90;
    while (k10 > 0 && g[k10] < 0.1 * peakG) k10--;
    const riseS = tS[k90] - tS[k10];
    let kz = peakIdx;
    while (kz > 0 && g[kz] < -ONSET_G) kz--;
    const onsetS = tS[peakIdx] - tS[kz];
    events.push({
      startM: sM[s],
      endM: sM[e],
      peakG,
      peakM: sM[peakIdx],
      durationS: tS[e] - tS[s],
      riseS,
      riseRateGps: riseS > 1e-3 ? (0.8 * Math.abs(peakG)) / riseS : Number.NaN,
      onsetS,
      onsetRateGps: onsetS > 1e-3 ? Math.abs(peakG) / onsetS : Number.NaN,
      bleedS: tS[e] - tS[peakIdx],
    });
  }

  const major = events.filter((ev) => ev.peakG <= o.majorG);
  const peaks = major.map((ev) => ev.peakG);
  const mean = peaks.length ? peaks.reduce((a, b) => a + b, 0) / peaks.length : Number.NaN;
  const sd = peaks.length
    ? Math.sqrt(peaks.reduce((a, b) => a + (b - mean) ** 2, 0) / peaks.length)
    : Number.NaN;
  const rates = major.map((ev) => ev.riseRateGps).filter((r) => Number.isFinite(r));

  return {
    brakingFrac: brake.length / n,
    brakeP5: percentile(brake, 5),
    brakeP25: percentile(brake, 25),
    brakeP50: percentile(brake, 50),
    brakeMin: brake.length ? brake[0] : Number.NaN,
    driveP50: percentile(drive, 50),
    driveP95: percentile(drive, 95),
    driveMax: drive.length ? drive[drive.length - 1] : Number.NaN,
    events,
    major,
    majorPeakMean: mean,
    majorPeakSd: sd,
    majorPeakMin: peaks.length ? Math.min(...peaks) : Number.NaN,
    majorPeakMax: peaks.length ? Math.max(...peaks) : Number.NaN,
    majorPeakSpread: peaks.length ? Math.min(...peaks) - Math.max(...peaks) : Number.NaN,
    medianRiseS: median(major.map((ev) => ev.riseS)),
    medianRiseRateGps: median(rates),
    deepest: events.reduce<BrakeEvent | undefined>(
      (best, ev) => (best === undefined || ev.peakG < best.peakG ? ev : best),
      undefined,
    ),
  };
}

export interface ReferenceRow {
  s_m: number;
  t_s: number;
  hiz_kmh: number;
  boylamsal_g: number;
  lat: number;
  lon: number;
  gaz_pct: number | null;
  vites: number | null;
}

export interface ReferenceLap {
  rows: ReferenceRow[];
  trace: Trace;
  lapTimeS: number;
}

/**
 * One of the two shipped Serres onboard laps, as a trace.
 *
 * `excludeM` drops a span of the lap from the trace used for event detection.
 * The R6 file's own metadata flags the speed step at the entry to K10 as a
 * possible dash-lag artefact ("K10 girişindeki ani hız düşüşü gösterge
 * gecikmesi olabilir"), and it shows up in the derived g as a -2.16 g spike
 * over 24 m — more deceleration than any tyre has. It is excluded from the
 * reference statistics for that reason and no other.
 */
export function loadReferenceLap(file: string, excludeM: Array<[number, number]> = []): ReferenceLap {
  const raw = JSON.parse(
    readFileSync(new URL(`../../public/examples/${file}`, import.meta.url), 'utf8'),
  ) as { telemetri_1m: ReferenceRow[] };
  const rows = raw.telemetri_1m.filter(
    (r) => !excludeM.some(([a, b]) => r.s_m >= a && r.s_m <= b),
  );
  const sM = new Float64Array(rows.length);
  const tS = new Float64Array(rows.length);
  const g = new Float64Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    sM[i] = rows[i].s_m;
    tS[i] = rows[i].t_s;
    g[i] = rows[i].boylamsal_g;
  }
  return { rows, trace: { sM, tS, g }, lapTimeS: tS[tS.length - 1] };
}

/** The K10 dash-lag artefact in the R6 file; see `loadReferenceLap`. */
export const R6_ARTEFACT_M: Array<[number, number]> = [[1645, 1685]];

/**
 * An OCR artefact in the BMW file, at 360-384 m.
 *
 * This is the -1.42 g that the whole lap's braking range used to be quoted
 * against, and it is not a braking peak. The raw frames behind it
 * (`ham_veri.ornekler`) read 149, 149, 145, 141, 141, 131, 131, 131, 133, 133,
 * 130 km/h in consecutive 0.04 s frames, all tagged `ocr`: the speed goes DOWN
 * to 131 and back UP to 133 in the middle of a braking zone, which it cannot
 * do, so at least one of those readings is wrong by 2-4 km/h. Differentiating
 * the smoothed series turns that misread into a 1.42 g excursion at 144 km/h,
 * 69 m before the K1 apex — i.e. the file claims the deepest braking of the
 * lap at half the lap's top speed with the bike already turning, where the
 * tyre's lateral share alone would make it impossible.
 *
 * With the span excluded the BMW's deepest zone peak is -1.19 g at 258 km/h,
 * which is where a braking peak belongs and which the R6 independently agrees
 * with (-1.06 g at 232 km/h). The file's own metadata flags this region too:
 * the automatic brake-start it derived for K1 (176 m) disagrees with the
 * trackside boards (193 m).
 */
export const BMW_ARTEFACT_M: Array<[number, number]> = [[360, 384]];

/** An `Envelope`'s longitudinal channel as a `Trace`. */
export function envelopeTrace(
  cumDistM: ArrayLike<number>,
  tS: ArrayLike<number>,
  longG: ArrayLike<number>,
): Trace {
  const n = longG.length;
  const s = new Float64Array(n);
  const t = new Float64Array(n);
  const g = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    s[i] = cumDistM[i];
    t[i] = tS[i];
    g[i] = longG[i];
  }
  return { sM: s, tS: t, g };
}
