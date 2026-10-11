// Owner-lap parameter identification (research R3 §6.3 a-g, spec v2 §4a).
//
//   cd dda_lab && npx vite-node scripts/ducati-identify.ts [Run036.json] [--out <dir>]
//
// Reads the owner's Ducati DDA export (Serres, 10 Hz, 10 laps, best 1:35.8),
// measures the rider metrics R3 §6.3 lists, turns each into an A or R
// candidate by running `DERIVE_TABLE` backwards, and writes
//   docs/superpowers/notes/2026-10-11-ducati-identification.json
//   docs/superpowers/notes/2026-10-11-ducati-identification.md
//
// Pipeline (each step is a section of the Markdown):
//   0. lap selection (out/in laps, slow laps, GPS gaps, distance anomalies)
//   1. GPS reference: lag behind the wheel speed + speedometer scale
//   2. slip lean correction (R2 §3.6): windowed slip vs lean on coasting samples
//   3. ground speed = wheel / (1 + baseline(φ)); a_x by Savitzky-Golay;
//      tyre g = a_x + aero/rolling loss (Panigale V4 preset)
//   4. corner sections on the ground speed (spec §2.4 thresholds), per lap
//   5. per corner: brake peak/p50/build (a), turn-in roll rate (b),
//      t_pick / roll-on (c), lean at pick-up; per lap: slip p50/p95 in drive
//      and DTC slip (d), lean p99 (e), wheelie exclusion (f)
//   6. (g) A/R candidates per lap → median, IQR, weight 1/IQR → weighted
//      median per axis; disagreements reported, not averaged away
//   7. the same inversions on the BMW/R6 references, as anchors
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { derivative, savitzkyGolay } from '../src/core/filters';
import { G, lossDecelMs2 } from '../src/sim/solver';
import { DEFAULT_SIM_PARAMS, presetById } from '../src/sim/presets';
import { deriveRider } from '../src/sim/derive';
import type { DerivedRiderKey, TyreTrackParams } from '../src/sim/types';
import {
  biteRateGps,
  brakeBuild,
  cornerMetrics,
  findSpeedCorners,
  median,
  percentile,
  rollOn,
  rollRateTurnIn,
  throttlePickUp,
} from './lib/cornerMetrics';
import { classifyLaps, gpsCumDistM, readDda, repeatedFixFrac } from './lib/ddaLap';
import { axisOf, invertDerive, weightedMedian } from './lib/inverseDerive';
import { readReferenceRows, referenceTrace } from './lib/referenceLap';
import {
  correctedSlipPct,
  estimateGpsLag,
  fitSlipLean,
  gpsSpeedMs,
  isCoasting,
  slipBaselinePct,
  STRICT_COAST,
  windowedSlip,
  type CoastSelect,
  type SlipLeanFit,
  type SlipSample,
} from './lib/slipCorrection';

const INBOX = '/Users/macbookmini/projects/DDA_Reader/_inbox';
const DEFAULT_RUN = `${INBOX}/Run036-219926-00.00.json`;
const PRESET = presetById('panigale-v4');

/** Biniewicz lateral-jerk roll-rate bound (R1/R3; thesis values, "doğrulanmadı" vs paper 32.56). */
const BINIEWICZ = { beta0: 23.5, beta1: -0.31 };
/** Same formula as W1's `rollRateBoundRadPerS` (vehicle.ts); local copy until the merge dedupes it. */
const rollBoundRadS = (vMs: number, phiRad: number): number =>
  Math.max(0.05, ((BINIEWICZ.beta0 + BINIEWICZ.beta1 * vMs) / G) * Math.cos(phiRad) ** 2);

/** Window half-widths, samples at 10 Hz. */
const H_LAG = 5; // 1.1 s window for the lag search
/**
 * 1.1 s window for slip. GPS position noise, not only the repeated fixes,
 * sets the floor: upright, the windowed slip's sd is ~6 % over 0.7 s and
 * ~2.6 % over 1.1 s (measured on this file). Exit drive phases last several
 * seconds, so the longer window costs little.
 */
const H_SLIP = 5;
/** Braking window starts this many samples after the throttle closes (drive-slip collapse). */
const CLOSE_SKIP = 3;
/** Robust braking peak: this percentile of the samples below −0.2 g. */
const ROBUST_PCT = 10;
/** Rear slip at peak force, % (R2 §3.6 c: SEL-2004; road/track tyre, "doğrulanmadı" for slicks). */
const KAPPA_PEAK_PCT = 12.5;
/** Relaxed coasting selection, used when the strict one cannot see lean. */
const RELAXED_COAST: CoastSelect = { tpsMaxPct: 30, accelAbsMaxG: 0.08 };
/** Zone matching across laps, metres of lap distance. */
const ZONE_MATCH_M = 60;
/** Candidate weight floor on the IQR (so one perfectly repeatable metric does not win alone). */
const IQR_FLOOR = 0.02;
/** Candidates on one axis further apart than this are reported as a disagreement. */
const DISAGREE = 0.3;

const r3 = (x: number): number | null => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
const fx = (x: number | null | undefined, d = 2): string => (x !== null && x !== undefined && Number.isFinite(x) ? x.toFixed(d) : '—');

interface CornerRec {
  lap: number;
  zone: number;
  sLapM: number;
  minKmh: number;
  entryKmh: number;
  hasBrake: boolean;
  /** Tyre g, SG-7, robust (ROBUST_PCT of the braking samples) from closure + 0.3 s. */
  peakG: number | null;
  /** The single deepest tyre-g sample in the same window, for comparison. */
  peakRawG: number | null;
  p50G: number | null;
  buildS: number | null; // SG-5, upper bound
  rateGps: number | null;
  /** Steepest 0.3 s of tyre-g descent (the definition behind BRAKE_RISE_MAX_GPS). */
  biteGps: number | null;
  peakTotalG: number | null; // total a_x, SG-7, robust, for the cross-checks
  /** GPS speed drop / corrected wheel speed drop over the zone. */
  gpsDropRatio: number | null;
  exportPeakG: number | null;
  rollP90DegS: number | null;
  rollMeanDegS: number | null;
  aOmega: number | null;
  vTurnInKmh: number | null;
  tPickS: number | null;
  t20S: number | null;
  leanAtPickDeg: number | null;
  rollOnS: number | null;
  rollOnTcLimited: boolean;
  rollOnWheelie: boolean;
}

interface LapRow {
  lap: number;
  timeS: number;
  kept: boolean;
  reasons: string[];
  corners: number;
  topPeakG: number | null;
  topBuildS: number | null;
  topRateGps: number | null;
  topBiteGps: number | null;
  typPeakG: number | null;
  rollP90DegS: number | null;
  aOmega: number | null;
  tPickS: number | null;
  rollOnS: number | null;
  leanP99Deg: number | null;
  slipP50: number | null;
  /** Noise-removed (lower bound). */
  slipP95: number | null;
  /** As measured (noise-inflated upper bound). */
  slipP95Raw: number | null;
}

interface Candidate {
  id: string;
  axis: 'A' | 'R';
  key: DerivedRiderKey;
  metric: string;
  /** The measured value fed to the inversion, per kept lap. */
  measuredPerLap: Array<number | null>;
  measuredMedian: number | null;
  /** Raw (unclipped) slider value per lap. */
  valuePerLap: Array<number | null>;
  median: number | null;
  iqr: number | null;
  weight: number | null;
  inEstimate: boolean;
  note?: string;
}

function main(): void {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outDir = outIdx >= 0 ? args[outIdx + 1] : fileURLToPath(new URL('../../docs/superpowers/notes/', import.meta.url));
  const path = args.find((a, k) => a.endsWith('.json') && args[k - 1] !== '--out') ?? DEFAULT_RUN;

  const run = readDda(path);
  const rec = run.records;
  const n = rec.length;
  const verdicts = classifyLaps(run);
  const kept = new Set(verdicts.filter((v) => v.kept).map((v) => v.lap));
  const lapOf = Int32Array.from(rec, (r) => r.lap);
  const inKept = (i: number): boolean => kept.has(lapOf[i]);

  const tS = Float64Array.from(rec, (r) => r.time_s);
  const wheel = Float32Array.from(rec, (r) => r.speed_kmh);
  const lean = Float32Array.from(rec, (r) => r.lean_angle_deg);
  const tps = Float32Array.from(rec, (r) => r.tps_pct);
  const torque = Float32Array.from(rec, (r) => r.torque_fast_pct + r.torque_slow_pct);
  const gCum = gpsCumDistM(rec);
  const dt = (tS[n - 1] - tS[0]) / (n - 1);

  // ---- 1. GPS reference
  const upright = (i: number): boolean => {
    if (!inKept(i)) return false;
    for (let k = i - H_LAG; k <= i + H_LAG; k++) if (Math.abs(lean[k]) >= 10) return false;
    return true;
  };
  const lag = estimateGpsLag(tS, wheel, gCum, { halfWindow: H_LAG, use: upright });
  const repFrac = repeatedFixFrac(rec);

  // ---- 2. slip lean correction on windowed samples
  const slipW = windowedSlip(tS, wheel, gCum, lag.lagS, H_SLIP);
  const leanEff = new Float32Array(n).fill(Number.NaN);
  const tpsMax = new Float32Array(n).fill(Number.NaN);
  const tqMax = new Float32Array(n).fill(Number.NaN);
  const aWin = new Float32Array(n).fill(Number.NaN);
  const samples: SlipSample[] = [];
  const sampleIdx: number[] = [];
  for (let i = H_SLIP; i < n - H_SLIP; i++) {
    let x = 0;
    let tp = 0;
    let tq = 0;
    for (let k = i - H_SLIP; k <= i + H_SLIP; k++) {
      x += 1 - Math.cos((lean[k] * Math.PI) / 180);
      tp = Math.max(tp, tps[k]);
      tq = Math.max(tq, torque[k]);
    }
    x /= 2 * H_SLIP + 1;
    leanEff[i] = (Math.acos(1 - x) * 180) / Math.PI;
    tpsMax[i] = tp;
    tqMax[i] = tq;
    aWin[i] = (wheel[i + H_SLIP] - wheel[i - H_SLIP]) / 3.6 / (tS[i + H_SLIP] - tS[i - H_SLIP]) / G / lag.scale;
    if (!inKept(i) || !Number.isFinite(slipW[i])) continue;
    samples.push({ slipPct: slipW[i], leanDeg: leanEff[i], tpsPct: tp, accelLongG: aWin[i], torqueFastPct: tq, torqueSlowPct: 0 });
    sampleIdx.push(i);
  }
  const strict = fitSlipLean(samples, STRICT_COAST);
  const relaxed = fitSlipLean(samples, RELAXED_COAST);
  const strictUsable = strict.n >= 100 && strict.xMax >= 0.15;
  const fit: SlipLeanFit = strictUsable ? strict : relaxed;
  const kappa = new Float32Array(n).fill(Number.NaN);
  for (let i = 0; i < n; i++) if (Number.isFinite(slipW[i])) kappa[i] = correctedSlipPct(fit, slipW[i], leanEff[i]);
  // Measurement noise of κ_corr: robust sd (1.4826·MAD) of the residual on
  // the samples the fit used, where the true slip is ≈ 0.
  const coastSel = strictUsable ? STRICT_COAST : RELAXED_COAST;
  const resid = samples.filter((s) => isCoasting(s, coastSel)).map((s) => correctedSlipPct(fit, s.slipPct, s.leanDeg));
  const residMed = median(resid);
  const slipNoiseSd = 1.4826 * median(resid.map((r) => Math.abs(r - residMed)));

  // ---- 3. ground speed and tyre g
  const vg = Float32Array.from(wheel, (w, i) => w / (1 + slipBaselinePct(fit, lean[i]) / 100));
  const vgMs = Float32Array.from(vg, (v) => v / 3.6);
  const accel = (win: number): Float32Array => Float32Array.from(derivative(savitzkyGolay(vgMs, win), dt), (a) => a / G);
  const a5 = accel(5);
  const a7 = accel(7);
  const loss = Float32Array.from(vgMs, (v) => lossDecelMs2(PRESET.machine, v) / G);
  const gT5 = Float32Array.from(a5, (a, i) => a + loss[i]);
  const gT7 = Float32Array.from(a7, (a, i) => a + loss[i]);
  // GPS speed for the cross-check, over the lag window (1.1 s): its
  // derivative is noise-dominated at 10 Hz, so the check compares SPEED DROPS
  // over each braking zone instead of peaks.
  const vGps = gpsSpeedMs(tS, gCum, lag.lagS, H_LAG);

  // ---- 4. corner sections on the whole run, kept laps only
  const lapStartCum = new Map<number, number>();
  for (const l of run.laps) lapStartCum.set(l.lap_number, gCum[Math.min(n - 1, l.start_index)]);
  const sections = findSpeedCorners(vg, gCum, { tS, gTyre: gT7 }).filter((c) => inKept(c.iA));

  // ---- 5. per corner
  const recs: CornerRec[] = sections.map((c, k) => {
    const lap = lapOf[c.iA];
    let peakG: number | null = null;
    let p50G: number | null = null;
    let buildS: number | null = null;
    let rateGps: number | null = null;
    let biteGps: number | null = null;
    let peakRawG: number | null = null;
    let peakTotalG: number | null = null;
    let gpsDropRatio: number | null = null;
    let exportPeakG: number | null = null;
    if (c.hasBrake) {
      // Start 0.3 s after the throttle closes: the first 0.2 s after a snap
      // shut is the rear wheel's drive slip collapsing (256 → 245 km/h at the
      // end of the main straight with no brake on yet), not braking.
      let iClose = c.iEntry;
      while (iClose < c.iA && !(tps[iClose] < 5)) iClose++;
      const i0 = Math.min(c.iA, iClose + CLOSE_SKIP);
      let mn = 0;
      let mt = 0;
      let me = 0;
      const zone: number[] = [];
      const zoneTotal: number[] = [];
      for (let i = i0; i <= c.iA; i++) {
        mn = Math.min(mn, gT7[i]);
        me = Math.min(me, rec[i].accel_long_g);
        if (gT7[i] < -0.2) {
          zone.push(gT7[i]);
          zoneTotal.push(a7[i]);
        }
      }
      zone.sort((a, b) => a - b);
      zoneTotal.sort((a, b) => a - b);
      mt = zoneTotal.length ? percentile(zoneTotal, ROBUST_PCT) : mt;
      peakRawG = mn;
      peakG = zone.length ? percentile(zone, ROBUST_PCT) : mn;
      p50G = median(zone);
      peakTotalG = mt;
      exportPeakG = me;
      const dW = vgMs[i0] - vgMs[c.iA];
      const dG = vGps[i0] - vGps[c.iA];
      if (dW > 3 && Number.isFinite(dG)) gpsDropRatio = dG / dW;
      const b = brakeBuild(tS, gT5, i0, c.iA, { robustPct: ROBUST_PCT });
      if (b) {
        buildS = b.buildS;
        rateGps = b.rateGps;
      }
      biteGps = nn(biteRateGps(tS, gT5, i0, c.iA));
    }
    const roll = rollRateTurnIn(tS, lean, c.iA);
    let aOmega: number | null = null;
    let vT: number | null = null;
    if (roll) {
      vT = vgMs[roll.iT];
      const phiMid = ((Math.abs(roll.leanADeg) / 2) * Math.PI) / 180;
      aOmega = ((roll.p90DegS * Math.PI) / 180) / rollBoundRadS(vT, phiMid);
    }
    const pick = throttlePickUp(tS, tps, c.iA);
    let ro: ReturnType<typeof rollOn> = null;
    let tc = false;
    let wh = false;
    let t20: number | null = null;
    if (pick) {
      const next = sections[k + 1];
      const end = next ? next.iEntry : Math.min(n - 1, c.iA + 100);
      ro = rollOn(tS, tps, pick.iP, end);
      if (ro) {
        t20 = tS[ro.i20] - tS[c.iA];
        for (let i = ro.i20; i <= ro.i90; i++) {
          if (torque[i] > 0) tc = true;
          if (rec[i].wheelie) wh = true;
        }
        for (let i = pick.iP; i < ro.i20; i++) if (rec[i].wheelie) wh = true;
      }
    }
    return {
      lap,
      zone: -1,
      sLapM: gCum[c.iA] - (lapStartCum.get(lap) ?? 0),
      minKmh: vg[c.iA],
      entryKmh: vg[c.iEntry],
      hasBrake: c.hasBrake,
      peakG,
      p50G,
      buildS,
      rateGps,
      biteGps,
      peakRawG,
      peakTotalG,
      gpsDropRatio,
      exportPeakG,
      rollP90DegS: roll ? roll.p90DegS : null,
      rollMeanDegS: roll ? roll.meanDegS : null,
      aOmega,
      vTurnInKmh: vT !== null ? vT * 3.6 : null,
      tPickS: pick ? pick.tPickS : null,
      t20S: t20,
      leanAtPickDeg: pick ? Math.abs(lean[pick.iP]) : null,
      rollOnS: ro ? ro.rollOnS : null,
      rollOnTcLimited: tc,
      rollOnWheelie: wh,
    };
  });

  // zones: the best lap's corners are the reference list
  const bestLap = run.laps.find((l) => l.is_best)?.lap_number ?? [...kept][0];
  const refZones = recs.filter((r) => r.lap === bestLap).map((r) => r.sLapM);
  for (const r of recs) {
    let best = -1;
    let bestD = ZONE_MATCH_M;
    refZones.forEach((s, z) => {
      const d = Math.abs(r.sLapM - s);
      if (d <= bestD) {
        bestD = d;
        best = z;
      }
    });
    r.zone = best;
  }
  const zoneStats = refZones.map((sRef, z) => {
    const rs = recs.filter((r) => r.zone === z);
    const braked = rs.filter((r) => r.hasBrake && r.peakG !== null);
    return {
      zone: z,
      sLapM: r3(sRef),
      laps: rs.length,
      brakedLaps: braked.length,
      minKmh: r3(median(rs.map((r) => r.minKmh))),
      entryKmh: r3(median(rs.map((r) => r.entryKmh))),
      peakG: r3(median(braked.map((r) => r.peakG!))),
      peakGIqr: r3(iqr(braked.map((r) => r.peakG!))),
      p50G: r3(median(braked.map((r) => r.p50G ?? Number.NaN))),
      buildS: r3(median(braked.map((r) => r.buildS ?? Number.NaN))),
      rateGps: r3(median(braked.map((r) => r.rateGps ?? Number.NaN))),
      biteGps: r3(median(braked.map((r) => r.biteGps ?? Number.NaN))),
      rollP90DegS: r3(median(rs.map((r) => r.rollP90DegS ?? Number.NaN))),
      tPickS: r3(median(rs.map((r) => r.tPickS ?? Number.NaN))),
      rollOnS: r3(median(rs.filter((r) => !r.rollOnWheelie).map((r) => r.rollOnS ?? Number.NaN))),
    };
  });
  const brakedZones = zoneStats.filter((z) => z.brakedLaps >= Math.max(2, Math.floor(kept.size / 2)));
  const topZone = brakedZones.reduce<(typeof zoneStats)[number] | undefined>(
    (b, z) => (b === undefined || (z.entryKmh ?? 0) > (b.entryKmh ?? 0) ? z : b),
    undefined,
  );
  const unmatched = recs.filter((r) => r.zone < 0).length;

  // ---- per lap
  const dtcIdx: number[] = [];
  for (let i = 0; i < n; i++) if (inKept(i) && torque[i] > 0 && Number.isFinite(kappa[i])) dtcIdx.push(i);
  const slipDtc = median(dtcIdx.map((i) => kappa[i]));
  const isDrive = (i: number): boolean => tps[i] > 30 && aWin[i] > 0 && tqMax[i] === 0 && Number.isFinite(kappa[i]);
  const lapRows: LapRow[] = verdicts.map((v) => {
    const info = run.laps.find((l) => l.lap_number === v.lap)!;
    const rs = recs.filter((r) => r.lap === v.lap);
    const top = topZone ? rs.find((r) => r.zone === topZone.zone && r.hasBrake) : undefined;
    const others = rs.filter((r) => r.hasBrake && r.peakG !== null && (!topZone || r.zone !== topZone.zone));
    const leanAbs: number[] = [];
    const drive: number[] = [];
    for (let i = info.start_index; i < Math.min(n, info.end_index); i++) {
      leanAbs.push(Math.abs(lean[i]));
      if (isDrive(i)) drive.push(kappa[i]);
    }
    leanAbs.sort((a, b) => a - b);
    drive.sort((a, b) => a - b);
    return {
      lap: v.lap,
      timeS: v.timeS,
      kept: v.kept,
      reasons: v.reasons,
      corners: rs.length,
      topPeakG: top?.peakG ?? null,
      topBuildS: top?.buildS ?? null,
      topRateGps: top?.rateGps ?? null,
      topBiteGps: top?.biteGps ?? null,
      typPeakG: others.length ? median(others.map((r) => r.peakG!)) : null,
      rollP90DegS: nn(median(rs.map((r) => r.rollP90DegS ?? Number.NaN))),
      aOmega: nn(median(rs.map((r) => r.aOmega ?? Number.NaN))),
      tPickS: nn(median(rs.map((r) => r.tPickS ?? Number.NaN))),
      rollOnS: nn(median(rs.filter((r) => !r.rollOnWheelie && !r.rollOnTcLimited).map((r) => r.rollOnS ?? Number.NaN))),
      leanP99Deg: nn(percentile(leanAbs, 99)),
      slipP50: nn(percentile(drive, 50)),
      slipP95: nn(denoiseP95(percentile(drive, 50), percentile(drive, 95), slipNoiseSd)),
      slipP95Raw: nn(percentile(drive, 95)),
    };
  });
  const keptRows = lapRows.filter((l) => l.kept);

  // ---- 6. candidates
  const tyre: TyreTrackParams = PRESET.tyre;
  const maxLean = tyre.maxLeanDeg;
  const cand = (
    id: string,
    key: DerivedRiderKey,
    metric: string,
    measure: (l: LapRow) => number | null,
    inEstimate = true,
    note?: string,
  ): Candidate => {
    const measured = keptRows.map((l) => {
      const m = measure(l);
      return m !== null && Number.isFinite(m) ? m : null;
    });
    const vals = measured.map((m) => (m === null ? null : invertDerive(key, m, tyre)));
    const finite = vals.filter((x): x is number => x !== null && Number.isFinite(x));
    const q = iqr(finite);
    const ax = axisOf(key);
    return {
      id,
      axis: ax === 'A' ? 'A' : 'R',
      key,
      metric,
      measuredPerLap: measured.map((m) => (m === null ? null : r3(m))),
      measuredMedian: r3(median(measured.filter((m): m is number => m !== null))),
      valuePerLap: vals.map((x) => (x === null ? null : r3(x))),
      median: r3(median(finite)),
      iqr: r3(q),
      weight: finite.length ? r3(1 / Math.max(IQR_FLOOR, Number.isFinite(q) ? q : 1)) : null,
      inEstimate: inEstimate && finite.length > 0,
      note,
    };
  };
  const candidates: Candidate[] = [
    cand('R_b', 'brakingG', `|tyre brake peak| at the top zone (entry ${fx(topZone?.entryKmh, 0)} km/h), g`, (l) => (l.topPeakG !== null ? -l.topPeakG : null)),
    cand(
      'R_b_typ',
      'brakingG',
      '|tyre brake peak|, median of the other braked zones, g',
      (l) => (l.typPeakG !== null ? -l.typPeakG : null),
      false,
      'not in the estimate: spec §5 rejected zone-by-zone braking, the sim brakes every zone at the rider ceiling g_b, so the top zone is the comparable figure',
    ),
    cand('R_phi', 'leanUsage', `lean p99 / maxLeanDeg (${maxLean}°)`, (l) => (l.leanP99Deg !== null ? l.leanP99Deg / maxLean : null)),
    cand(
      'R_d',
      'sDrive',
      `drive slip p95 (noise removed) / DTC slip median (${fx(slipDtc)} %)`,
      (l) => (l.slipP95 !== null && slipDtc > 0.5 ? l.slipP95 / slipDtc : null),
      slipDtc > 0.5,
      'R3 §6.3 d; unusable when the slip at DTC intervention is not resolved (the DTC cuts here last one 0.1 s sample, the slip window is 1.1 s)',
    ),
    cand(
      'R_d_peak',
      'sDrive',
      `raw drive slip p95 / κ_peak ${KAPPA_PEAK_PCT} % (R2 §3.6 c, SEL-2004)`,
      (l) => (l.slipP95Raw !== null ? l.slipP95Raw / KAPPA_PEAK_PCT : null),
      false,
      'not in the estimate: the raw p95 is inflated by GPS noise (an upper bound), and the noise-removed p95 is not distinguishable from the p50',
    ),
    cand('A_J', 'brakeRiseGps', 'brake BITE rate (steepest 0.3 s) at the top zone, g/s', (l) => l.topBiteGps),
    cand(
      'A_J_1090',
      'brakeRiseGps',
      'brake build rate 10-90 % of peak at the top zone, g/s',
      (l) => l.topRateGps,
      false,
      'not in the estimate: BRAKE_RISE_MAX_GPS (2.8) was read as a bite rate, so A_J uses the bite; this is the linear-ramp-equivalent rate',
    ),
    cand('A_omega', 'rollRateFrac', 'turn-in roll rate p90 / Biniewicz bound, median of corners', (l) => l.aOmega),
    cand('A_tp', 'throttleDelayS', 't_pick (throttle > 10 % held) − t_apex, median of corners, s', (l) => l.tPickS),
    cand('A_ro', 'rollOnS', 'roll-on 20 → 90 %, median of corners without DTC/wheelie, s', (l) => l.rollOnS),
  ];
  // the table's own end points, for the "where does the owner sit" table
  const ends = [0, 1].map((x) => deriveRider({ ...DEFAULT_SIM_PARAMS.rider, aggressiveness: x, risk: x, overrides: [] }, tyre));
  const deriveRange = candidates.map((c) => ({
    candidate: c.id,
    key: c.key,
    atZero: r3((ends[0] as unknown as Record<string, number>)[c.key]),
    atOne: r3((ends[1] as unknown as Record<string, number>)[c.key]),
    measured: c.measuredMedian,
    slider: c.median,
  }));
  const clip = (x: number): number => Math.min(1, Math.max(0, x));
  const estimate = (axis: 'A' | 'R'): number => {
    const cs = candidates.filter((c) => c.axis === axis && c.inEstimate && c.median !== null);
    return weightedMedian(cs.map((c) => clip(c.median!)), cs.map((c) => c.weight ?? 0));
  };
  const A = estimate('A');
  const R = estimate('R');
  const disagreements: Array<{ axis: string; a: string; b: string; aValue: number; bValue: number; diff: number }> = [];
  for (const axis of ['A', 'R'] as const) {
    const cs = candidates.filter((c) => c.axis === axis && c.median !== null);
    for (let i = 0; i < cs.length; i++)
      for (let j = i + 1; j < cs.length; j++) {
        const d = Math.abs(clip(cs[i].median!) - clip(cs[j].median!));
        if (d > DISAGREE) disagreements.push({ axis, a: cs[i].id, b: cs[j].id, aValue: cs[i].median!, bValue: cs[j].median!, diff: r3(d)! });
      }
  }

  // ---- 7. reference anchors (BMW/R6), same inversions
  const anchors = (['BMW', 'R6'] as const).map((kind) => {
    const file = `${INBOX}/${kind === 'BMW' ? 'serres_BMW_1-19-81.json' : 'serres_R6_1-19-849.json'}`;
    const preset = presetById(kind === 'R6' ? '600' : '1000');
    const tr = referenceTrace(readReferenceRows(file), kind);
    const lossG = (v: number): number => lossDecelMs2(preset.machine, v) / G;
    const m = cornerMetrics(tr.speedKmh, tr.sM, tr.longG, { tS: tr.tS, lossG });
    const gTyre = Float32Array.from(tr.longG, (g, i) => g + lossG(tr.speedKmh[i] / 3.6));
    // the deepest braked zone, its 10-90 % rate and its bite
    let deepest: { peak: number; rate: number; bite: number } | null = null;
    for (const c of m.corners) {
      if (!c.hasBrake) continue;
      const b = brakeBuild(tr.tS, gTyre, c.iEntry, c.iA);
      if (b && (!deepest || b.peakG < deepest.peak)) deepest = { peak: b.peakG, rate: b.rateGps, bite: biteRateGps(tr.tS, gTyre, c.iEntry, c.iA) };
    }
    const out: Record<string, number | null> = {
      deepestTyrePeakG: deepest ? r3(deepest.peak) : null,
      deepestZoneRateGps: deepest ? r3(deepest.rate) : null,
      deepestZoneBiteGps: deepest ? r3(deepest.bite) : null,
      R_b: deepest ? r3(invertDerive('brakingG', -deepest.peak, preset.tyre)) : null,
      A_J: deepest ? r3(invertDerive('brakeRiseGps', deepest.bite, preset.tyre)) : null,
    };
    if (tr.tps) {
      const picks: number[] = [];
      const rolls: number[] = [];
      m.corners.forEach((c, j) => {
        const p = throttlePickUp(tr.tS, tr.tps!, c.iA);
        if (!p) return;
        picks.push(p.tPickS);
        const next = m.corners[j + 1];
        const ro = rollOn(tr.tS, tr.tps!, p.iP, next ? next.iA : tr.tS.length - 1);
        if (ro) rolls.push(ro.rollOnS);
      });
      out.tPickS = r3(median(picks));
      out.rollOnS = r3(median(rolls));
      out.A_tp = r3(invertDerive('throttleDelayS', median(picks), preset.tyre));
      out.A_ro = r3(invertDerive('rollOnS', median(rolls), preset.tyre));
    }
    return { kind, preset: preset.id, ...out };
  });

  // ---- summary numbers
  const brakedRecs = recs.filter((r) => r.hasBrake && r.peakG !== null);
  const driveAll: number[] = [];
  for (let i = 0; i < n; i++) if (inKept(i) && isDrive(i)) driveAll.push(kappa[i]);
  driveAll.sort((a, b) => a - b);
  const bands = [
    [0, 20],
    [20, 40],
    [40, 90],
  ].map(([lo, hi]) => {
    const xs: number[] = [];
    for (let i = 0; i < n; i++) if (inKept(i) && isDrive(i) && Math.abs(lean[i]) >= lo && Math.abs(lean[i]) < hi) xs.push(kappa[i]);
    xs.sort((a, b) => a - b);
    return { leanDeg: `${lo}-${hi}`, n: xs.length, p50: r3(percentile(xs, 50)), p95: r3(percentile(xs, 95)) };
  });
  const leanAllKept: number[] = [];
  for (let i = 0; i < n; i++) if (inKept(i)) leanAllKept.push(Math.abs(lean[i]));
  leanAllKept.sort((a, b) => a - b);
  const allRolls = recs.filter((r) => r.rollOnS !== null);

  const summary = {
    brakePeakTopG: topZone?.peakG ?? null,
    brakePeakTypicalG: r3(median(brakedZones.filter((z) => z !== topZone).map((z) => z.peakG ?? Number.NaN))),
    brakeP50InZoneG: r3(median(brakedRecs.map((r) => r.p50G ?? Number.NaN))),
    buildTopS: topZone?.buildS ?? null,
    buildMedianS: r3(median(brakedRecs.map((r) => r.buildS ?? Number.NaN))),
    buildRateTopGps: topZone?.rateGps ?? null,
    buildRateMedianGps: r3(median(brakedRecs.map((r) => r.rateGps ?? Number.NaN))),
    biteTopGps: topZone?.biteGps ?? null,
    biteMedianGps: r3(median(brakedRecs.map((r) => r.biteGps ?? Number.NaN))),
    rollRateP90DegS: r3(median(recs.map((r) => r.rollP90DegS ?? Number.NaN))),
    rollRateP90OfCornersDegS: r3(percentile(recs.map((r) => r.rollP90DegS ?? Number.NaN).filter(Number.isFinite).sort((a, b) => a - b), 90)),
    rollRateMeanDegS: r3(median(recs.map((r) => r.rollMeanDegS ?? Number.NaN))),
    aOmega: r3(median(recs.map((r) => r.aOmega ?? Number.NaN))),
    tPickS: r3(median(recs.map((r) => r.tPickS ?? Number.NaN))),
    t20S: r3(median(recs.map((r) => r.t20S ?? Number.NaN))),
    leanAtPickDeg: r3(median(recs.map((r) => r.leanAtPickDeg ?? Number.NaN))),
    rollOnS: r3(median(allRolls.filter((r) => !r.rollOnWheelie && !r.rollOnTcLimited).map((r) => r.rollOnS!))),
    rollOnTcLimitedS: r3(median(allRolls.filter((r) => r.rollOnTcLimited).map((r) => r.rollOnS!))),
    rollOnCounts: {
      measured: allRolls.length,
      tcLimited: allRolls.filter((r) => r.rollOnTcLimited).length,
      wheelieExcluded: allRolls.filter((r) => r.rollOnWheelie).length,
      never90: recs.filter((r) => r.tPickS !== null && r.rollOnS === null).length,
    },
    slipDriveP50Pct: r3(percentile(driveAll, 50)),
    slipDriveP95Pct: r3(percentile(driveAll, 95)),
    slipDriveP95DenoisedPct: r3(denoiseP95(percentile(driveAll, 50), percentile(driveAll, 95), slipNoiseSd)),
    slipNoiseSdPct: r3(slipNoiseSd),
    slipDriveN: driveAll.length,
    slipDtcMedianPct: r3(slipDtc),
    slipDtcN: dtcIdx.length,
    slipByLeanBand: bands,
    leanP99Deg: r3(percentile(leanAllKept, 99)),
    leanUsage: r3(percentile(leanAllKept, 99) / maxLean),
    crossCheck: {
      gpsOverWheelSpeedDrop: r3(median(brakedRecs.map((r) => r.gpsDropRatio ?? Number.NaN))),
      exportAccelMinOverCorrectedPeak: r3(
        median(brakedRecs.map((r) => (r.exportPeakG !== null && r.peakTotalG ? r.exportPeakG / r.peakTotalG : Number.NaN))),
      ),
      rawMinOverRobustPeak: r3(median(brakedRecs.map((r) => (r.peakRawG !== null && r.peakG ? r.peakRawG / r.peakG : Number.NaN)))),
    },
  };

  const result = {
    generatedBy: 'dda_lab/scripts/ducati-identify.ts',
    source: path.split('/').pop(),
    preset: PRESET.id,
    tyre,
    bestLapS: run.bestLapS,
    lapSelection: verdicts,
    gps: { lagS: lag.lagS, speedoScale: r3(lag.scale), residualKmh: r3(lag.rmsKmh), nUpright: lag.n, repeatedFixFrac: r3(repFrac) },
    slipCorrection: {
      windowS: r3((2 * H_SLIP + 1) * dt),
      strict: { select: STRICT_COAST, ...roundFit(strict) },
      relaxed: { select: RELAXED_COAST, ...roundFit(relaxed) },
      used: strictUsable ? 'strict' : 'relaxed',
      leanTermAt45DegPct: r3(fit.c2 * (1 - Math.cos(Math.PI / 4))),
    },
    summary,
    zones: zoneStats,
    topZone: topZone?.zone ?? null,
    unmatchedCorners: unmatched,
    candidates,
    estimate: { A: r3(A), R: r3(R) },
    deriveRange,
    disagreements,
    laps: lapRows.map((l) => ({ ...l, topPeakG: r3n(l.topPeakG), topBuildS: r3n(l.topBuildS), topRateGps: r3n(l.topRateGps), topBiteGps: r3n(l.topBiteGps), typPeakG: r3n(l.typPeakG), rollP90DegS: r3n(l.rollP90DegS), aOmega: r3n(l.aOmega), tPickS: r3n(l.tPickS), rollOnS: r3n(l.rollOnS), leanP99Deg: r3n(l.leanP99Deg), slipP50: r3n(l.slipP50), slipP95: r3n(l.slipP95), slipP95Raw: r3n(l.slipP95Raw) })),
    references: anchors,
    corners: recs.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'number' ? r3(v) : v]))),
  };

  mkdirSync(outDir, { recursive: true });
  const jsonPath = `${outDir.replace(/\/$/, '')}/2026-10-11-ducati-identification.json`;
  const mdPath = `${outDir.replace(/\/$/, '')}/2026-10-11-ducati-identification.md`;
  writeFileSync(jsonPath, JSON.stringify(result, null, 2) + '\n');
  writeFileSync(mdPath, markdown(result));
  console.log(markdown(result));
  console.log(`\nwrote ${jsonPath}\nwrote ${mdPath}`);
}

function nn(x: number): number | null {
  return Number.isFinite(x) ? x : null;
}
function r3n(x: number | null): number | null {
  return x === null ? null : r3(x);
}
/**
 * p95 with the measurement noise taken out, assuming Gaussian noise of sd σ
 * added to the true slip: the spread p95 − p50 of a sum widens as
 * √(true² + (1.645σ)²). σ is the coasting fit's residual, which also holds
 * real slip variation, so this over-corrects: a LOWER bound on the true p95.
 */
function denoiseP95(p50: number, p95: number, sigma: number): number {
  const spread = p95 - p50;
  return p50 + Math.sqrt(Math.max(0, spread * spread - (1.645 * sigma) ** 2));
}
function iqr(xs: number[]): number {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length >= 2 ? percentile(s, 75) - percentile(s, 25) : Number.NaN;
}
function roundFit(f: SlipLeanFit) {
  return { c0: r3(f.c0), c2: r3(f.c2), n: f.n, rmsPct: r3(f.rmsPct), xMin: r3(f.xMin), xMax: r3(f.xMax) };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function markdown(res: any): string {
  const s = res.summary;
  const L: string[] = [];
  L.push('# Ducati owner laps: rider parameter identification');
  L.push('');
  L.push(`Generated by \`${res.generatedBy}\` from \`${res.source}\` (best lap ${fx(res.bestLapS, 1)} s). Raw numbers: \`2026-10-11-ducati-identification.json\` next to this file. Preset for losses and inversions: \`${res.preset}\` (μ ${res.tyre.mu}, maxLean ${res.tyre.maxLeanDeg}°). Method: research R3 §6.3 (a)-(g), R2 §3.6.`);
  L.push('');
  L.push('## Result');
  L.push('');
  L.push(`**A (aggressiveness) ≈ ${fx(res.estimate.A)}, R (risk) ≈ ${fx(res.estimate.R)}**: weighted medians of the candidates below, each clipped to 0..1, weight = 1/max(IQR across laps, ${IQR_FLOOR}).`);
  L.push('');
  L.push('| candidate | axis | measured (median of laps) | → slider (median) | IQR | weight | in estimate |');
  L.push('|---|---|---|---|---|---|---|');
  for (const c of res.candidates) L.push(`| ${c.id}: ${c.metric} | ${c.axis} | ${fx(c.measuredMedian, 3)} | ${fx(c.median)} | ${fx(c.iqr)} | ${fx(c.weight, 1)} | ${c.inEstimate ? 'yes' : 'no' + (c.note ? ` (${c.note})` : '')} |`);
  L.push('');
  if (res.disagreements.length) {
    L.push(`Disagreements (> ${DISAGREE} apart on one axis after clipping):`);
    L.push('');
    for (const d of res.disagreements) L.push(`- ${d.axis}: ${d.a} ${fx(d.aValue)} vs ${d.b} ${fx(d.bValue)} (Δ ${fx(d.diff)})`);
  } else L.push('No disagreements above the threshold.');
  L.push('');
  L.push('### Where the owner sits on the current `DERIVE_TABLE` ranges');
  L.push('');
  L.push('A slider outside 0..1 means the measured value is outside what the table can produce at all. That is a statement about the table\'s end points (proposals, "öneri"), not about the rider, and it is the input the merge needs to recalibrate them.');
  L.push('');
  L.push('| candidate | derived key | table at 0 | table at 1 | owner measured | → slider |');
  L.push('|---|---|---|---|---|---|');
  for (const d of res.deriveRange) L.push(`| ${d.candidate} | ${d.key} | ${fx(d.atZero, 3)} | ${fx(d.atOne, 3)} | ${fx(d.measured, 3)} | ${fx(d.slider)} |`);
  L.push('');
  L.push('(`brakingG` is in g of tyre. `leanUsage` is the fraction of `maxLeanDeg`. `rollRateFrac` is the fraction of the Biniewicz bound. `throttleDelayS` is the pick-up minus the apex time and is negative when the throttle comes back before the speed apex.)');
  L.push('');
  L.push('## Measured numbers (kept laps)');
  L.push('');
  L.push('| metric | value |');
  L.push('|---|---|');
  L.push(`| brake tyre g, top zone (median of laps) | ${fx(s.brakePeakTopG)} |`);
  L.push(`| brake tyre g, typical (median of the other zones' medians) | ${fx(s.brakePeakTypicalG)} |`);
  L.push(`| brake tyre g, in-zone p50 (median of zones) | ${fx(s.brakeP50InZoneG)} |`);
  L.push(`| build −0.1 g → 90 % peak, top zone / all zones, s (SG-5, upper bound) | ${fx(s.buildTopS)} / ${fx(s.buildMedianS)} |`);
  L.push(`| build rate 10-90 %, top zone / all zones, g/s | ${fx(s.buildRateTopGps)} / ${fx(s.buildRateMedianGps)} |`);
  L.push(`| brake bite (steepest 0.3 s), top zone / all zones, g/s | ${fx(s.biteTopGps)} / ${fx(s.biteMedianGps)} |`);
  L.push(`| turn-in roll rate p90, median of corners / p90 of corners, deg/s | ${fx(s.rollRateP90DegS, 1)} / ${fx(s.rollRateP90OfCornersDegS, 1)} |`);
  L.push(`| turn-in mean roll rate (φ_A − φ_T)/(t_A − t_T), deg/s | ${fx(s.rollRateMeanDegS, 1)} |`);
  L.push(`| roll rate / Biniewicz bound (a_ω) | ${fx(s.aOmega)} |`);
  L.push(`| t_pick (tps > 10 % held 0.3 s) − t_apex, s | ${fx(s.tPickS)} |`);
  L.push(`| t(tps ≥ 20 %) − t_apex (end of maintenance throttle), s | ${fx(s.t20S)} |`);
  L.push(`| lean at pick-up, deg | ${fx(s.leanAtPickDeg, 1)} |`);
  L.push(`| roll-on 20 → 90 %, no DTC / DTC-limited, s | ${fx(s.rollOnS)} / ${fx(s.rollOnTcLimitedS)} |`);
  L.push(`| roll-on counts (measured / DTC-limited / wheelie-excluded / never reached 90 %) | ${s.rollOnCounts.measured} / ${s.rollOnCounts.tcLimited} / ${s.rollOnCounts.wheelieExcluded} / ${s.rollOnCounts.never90} |`);
  L.push(`| corrected drive slip p50 / p95 / p95 noise-removed, % (tps > 30 %, a > 0, no DTC; n ${s.slipDriveN}; noise sd ${fx(s.slipNoiseSdPct)}) | ${fx(s.slipDriveP50Pct)} / ${fx(s.slipDriveP95Pct)} / ${fx(s.slipDriveP95DenoisedPct)} |`);
  L.push(`| corrected slip while DTC cuts, median, % (n ${s.slipDtcN}) | ${fx(s.slipDtcMedianPct)} |`);
  L.push(`| lean p99, deg (usage of ${res.tyre.maxLeanDeg}°) | ${fx(s.leanP99Deg, 1)} (${fx(s.leanUsage)}) |`);
  L.push('');
  L.push('Drive slip by lean band (corrected, %):');
  L.push('');
  L.push('| lean, deg | n | p50 | p95 |');
  L.push('|---|---|---|---|');
  for (const b of s.slipByLeanBand) L.push(`| ${b.leanDeg} | ${b.n} | ${fx(b.p50)} | ${fx(b.p95)} |`);
  L.push('');
  L.push('## Lap selection and lap-by-lap consistency');
  L.push('');
  L.push('| lap | time, s | kept | top peak g | top build s | top rate g/s | top bite g/s | typ peak g | roll p90 °/s | a_ω | t_pick s | roll-on s | lean p99 ° | slip p50 / p95 raw / p95 denoised % |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const l of res.laps)
    L.push(`| ${l.lap} | ${fx(l.timeS, 1)} | ${l.kept ? 'yes' : 'no: ' + l.reasons.join('; ')} | ${fx(l.topPeakG)} | ${fx(l.topBuildS)} | ${fx(l.topRateGps, 1)} | ${fx(l.topBiteGps, 1)} | ${fx(l.typPeakG)} | ${fx(l.rollP90DegS, 0)} | ${fx(l.aOmega)} | ${fx(l.tPickS)} | ${fx(l.rollOnS)} | ${fx(l.leanP99Deg, 1)} | ${fx(l.slipP50, 1)} / ${fx(l.slipP95Raw, 1)} / ${fx(l.slipP95, 1)} |`);
  L.push('');
  L.push('## Per-corner zones (best lap as the reference, matched within ' + ZONE_MATCH_M + ' m)');
  L.push('');
  L.push(`Top zone (highest entry speed among braked zones): ${res.topZone}. Corners not matched to a zone: ${res.unmatchedCorners}.`);
  L.push('');
  L.push('| zone | s, m | laps (braked) | entry km/h | min km/h | peak g (IQR) | in-zone p50 g | build s | rate g/s | bite g/s | roll p90 °/s | t_pick s | roll-on s |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const z of res.zones)
    L.push(`| ${z.zone} | ${fx(z.sLapM, 0)} | ${z.laps} (${z.brakedLaps}) | ${fx(z.entryKmh, 0)} | ${fx(z.minKmh, 0)} | ${fx(z.peakG)} (${fx(z.peakGIqr)}) | ${fx(z.p50G)} | ${fx(z.buildS)} | ${fx(z.rateGps, 1)} | ${fx(z.biteGps, 1)} | ${fx(z.rollP90DegS, 0)} | ${fx(z.tPickS)} | ${fx(z.rollOnS)} |`);
  L.push('');
  L.push('## Signal conditioning');
  L.push('');
  L.push(`- **GPS.** ${fx(res.gps.repeatedFixFrac * 100, 0)} % of consecutive raw fixes are repeats, so the GPS updates more slowly than the 10 Hz log and the export's per-sample \`gps_speed_kmh\` (and with it \`wheel_slip_pct\`) jumps by tens of km/h from sample to sample. Ground speed is therefore GPS distance over a window. The GPS lags the wheel speed by **${fx(res.gps.lagS)} s** (grid search on upright samples, residual ${fx(res.gps.residualKmh)} km/h, n ${res.gps.nUpright}). The dash reads **${fx((res.gps.speedoScale - 1) * 100, 1)} % high** upright.`);
  const sc = res.slipCorrection;
  L.push(`- **Slip lean correction (R2 §3.6).** Windowed slip (${fx(sc.windowS, 1)} s) = c0 + c2·(1 − cos φ) on coasting samples. Strict selection (tps < ${sc.strict.select.tpsMaxPct} %, |a| < ${sc.strict.select.accelAbsMaxG} g, no DTC): n ${sc.strict.n}, c0 ${fx(sc.strict.c0)} %, c2 ${fx(sc.strict.c2)} %, 1 − cos φ range ${fx(sc.strict.xMin, 3)}–${fx(sc.strict.xMax, 3)}. Relaxed (tps < ${sc.relaxed.select.tpsMaxPct} %, |a| < ${sc.relaxed.select.accelAbsMaxG} g): n ${sc.relaxed.n}, c0 ${fx(sc.relaxed.c0)} %, c2 ${fx(sc.relaxed.c2)} %, range ${fx(sc.relaxed.xMin, 3)}–${fx(sc.relaxed.xMax, 3)}, rms ${fx(sc.relaxed.rmsPct)} %. **Used: ${sc.used}.** ${sc.used === 'relaxed' ? 'The strict selection hardly ever sees lean: this rider holds maintenance throttle through the corners, so there is almost no closed-throttle sample at lean and c2 cannot be fitted from it. The relaxed selection keeps \"no net acceleration\" but allows maintenance throttle, where true slip is a fraction of a percent.' : ''} The lean term at 45° is ${fx(sc.leanTermAt45DegPct, 1)} %.`);
  L.push(`- **Ground speed and g.** v = wheel / (1 + baseline(φ)). a_x = derivative of Savitzky-Golay (7 samples for peaks, 5 for the build, which is an upper bound per R3 §6.3). Tyre g = a_x + aero/rolling loss. Braking is measured from 0.3 s after the throttle closes. When the throttle snaps shut on the straight, the wheel speed drops by ~4 % within 0.2 s with no brake on (e.g. 256 → 245 km/h): that is drive slip collapsing, and it is the sign that the dash speed comes from the REAR wheel. A braking peak is the ${ROBUST_PCT}th percentile of the samples below −0.2 g, not the single deepest sample (median deepest/robust = ${fx(s.crossCheck.rawMinOverRobustPeak)}). Cross-checks on braked zones: the GPS speed drop over the zone / the corrected wheel speed drop = ${fx(s.crossCheck.gpsOverWheelSpeedDrop)}; the export's \`accel_long_g\` minimum (raw wheel derivative, dash over-read and wheel hop included) / the robust corrected total peak = ${fx(s.crossCheck.exportAccelMinOverCorrectedPeak)}.`);
  L.push('- **What is not a sensor.** `accel_lat_g` is tan(lean), not an accelerometer, so R3 §6.3 (b)\'s lean-vs-lateral-g check cannot be done with this file. `wheelie` is a heuristic flag from dda_core (tps > 75, a > 0.45 g, gear ≤ 3, |lean| < 12°). It is used only to drop roll-ons. Ducati does not document which wheel `speed_kmh` comes from. The ~4 % drop at throttle closure points to the rear, which is the wheel R_d needs. Treat that as an inference, not a specification. The DTC "fast" torque reductions are single 0.1 s samples at maintenance throttle (tps 10-20 %) and 35-50° lean, about five per lap. None of them coincides with a gear change, so they are not quickshifter cuts.');
  L.push('');
  L.push('## References on the same axes (R3 §6.3 g.3)');
  L.push('');
  L.push('| file | preset | deepest tyre peak g | its 10-90 rate g/s | its bite g/s | R_b | A_J (bite) | t_pick s | roll-on s | A_tp | A_ro |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const a of res.references)
    L.push(`| ${a.kind} | ${a.preset} | ${fx(a.deepestTyrePeakG)} | ${fx(a.deepestZoneRateGps, 1)} | ${fx(a.deepestZoneBiteGps, 1)} | ${fx(a.R_b)} | ${fx(a.A_J)} | ${fx(a.tPickS)} | ${fx(a.rollOnS)} | ${fx(a.A_tp)} | ${fx(a.A_ro)} |`);
  L.push('');
  L.push('All inversions read `DERIVE_TABLE` in `src/sim/derive.ts` (proposals, "öneri"). When the merge recalibrates that table, re-run this script. The slider values above are the current table read backwards, not a fit of the lap time. Spec §4a step 4 (the fitted A/R with the Panigale preset ≈ 1:35.8 ± 1 s) is the merge\'s job, once the v2 rider reads A and R.');
  L.push('');
  return L.join('\n');
}

main();
