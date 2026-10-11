// The Ducati DDA JSON export (dda_core.py `to_json`): records at a fixed
// 10 Hz with the CAN channels (speed, rpm, tps, gear, PSI lean, DTC torque
// reduction) and GPS, plus what dda_core DERIVED from them. Which channels
// are measured matters for every metric read off this file:
//
//   measured : speed_kmh (dash vehicle speed), rpm, tps_pct, gear,
//              lean_angle_deg (IMU), torque_fast/slow_pct, gps_lat/lon
//   derived  : gps_speed_kmh (centred 2-fix difference of smoothed GPS, then
//              a 3-point filter), accel_long_g (central difference of
//              speed_kmh, clamped −1.8..1.5), accel_lat_g (= tan(lean), NOT an
//              accelerometer), wheel_slip_pct ((speed − gps_speed)/gps_speed),
//              wheelie (heuristic: tps > 75, accel > 0.45, gear ≤ 3, |lean| < 12)
import { readFileSync } from 'node:fs';
import { haversineM } from '../../src/core/geo';

export interface DdaRecord {
  time_s: number;
  speed_kmh: number;
  gps_speed_kmh: number;
  rpm: number;
  tps_pct: number;
  gear: number;
  lean_angle_deg: number;
  torque_fast_pct: number;
  torque_slow_pct: number;
  distance_m: number;
  gps_lat: number | null;
  gps_lon: number | null;
  raw_lat?: number | null;
  raw_lon?: number | null;
  gps_alt_m: number;
  lap: number;
  accel_long_g: number;
  accel_lat_g: number;
  wheel_slip_pct: number;
  wheelie: boolean;
}

export interface DdaLapInfo {
  lap_number: number;
  name: string;
  duration_s: number;
  start_index: number;
  end_index: number;
  distance_m: number;
  is_best: boolean;
}

export interface DdaRun {
  records: DdaRecord[];
  laps: DdaLapInfo[];
  bestLapS: number;
}

export function readDda(path: string): DdaRun {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as {
    records: DdaRecord[];
    laps: DdaLapInfo[];
    stats: { best_lap_time_s: number };
  };
  return { records: raw.records, laps: raw.laps, bestLapS: raw.stats.best_lap_time_s };
}

export interface LapVerdict {
  lap: number;
  name: string;
  timeS: number;
  distanceM: number;
  kept: boolean;
  reasons: string[];
}

/**
 * Which laps are flying laps worth measuring (R3 §6.3 "Ön işleme"): drop the
 * out-lap and in-lap, laps slower than best + `slowFrac`, laps with missing
 * GPS fixes, and laps whose GPS distance is off the median by more than
 * `distFrac` (a cut or a GPS jump).
 */
export function classifyLaps(run: DdaRun, opts: { slowFrac?: number; distFrac?: number } = {}): LapVerdict[] {
  const slowFrac = opts.slowFrac ?? 0.03;
  const distFrac = opts.distFrac ?? 0.03;
  const nullByLap = new Map<number, number>();
  for (const r of run.records) if (r.gps_lat === null || r.gps_lon === null) nullByLap.set(r.lap, (nullByLap.get(r.lap) ?? 0) + 1);
  const n = run.laps.length;
  const timed = run.laps.filter((_, k) => k > 0 && k < n - 1);
  const dists = timed.map((l) => l.distance_m).sort((a, b) => a - b);
  const medDist = dists.length ? dists[Math.floor(dists.length / 2)] : Number.NaN;
  return run.laps.map((l, k) => {
    const reasons: string[] = [];
    if (k === 0 || /out/i.test(l.name)) reasons.push('out-lap');
    if (k === n - 1 || /in-lap|\(in/i.test(l.name)) reasons.push('in-lap');
    if (!reasons.length) {
      if (l.duration_s > run.bestLapS * (1 + slowFrac)) reasons.push(`slower than best + ${(slowFrac * 100).toFixed(0)} % (traffic or a mistake)`);
      const nul = nullByLap.get(l.lap_number) ?? 0;
      if (nul > 0) reasons.push(`${nul} missing GPS fixes`);
      if (Math.abs(l.distance_m - medDist) > distFrac * medDist) reasons.push(`GPS distance ${l.distance_m.toFixed(0)} m vs median ${medDist.toFixed(0)} m`);
    }
    return { lap: l.lap_number, name: l.name, timeS: l.duration_s, distanceM: l.distance_m, kept: reasons.length === 0, reasons };
  });
}

/** Cumulative GPS distance along the records (smoothed fixes), metres; a missing fix adds nothing. */
export function gpsCumDistM(records: DdaRecord[]): Float64Array {
  const out = new Float64Array(records.length);
  let prev: [number, number] | null = null;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    out[i] = i > 0 ? out[i - 1] : 0;
    if (r.gps_lat === null || r.gps_lon === null) continue;
    const p: [number, number] = [r.gps_lon, r.gps_lat];
    if (prev) out[i] += haversineM(prev, p);
    prev = p;
  }
  return out;
}

/** Fraction of consecutive records whose RAW fix did not change (GPS slower than the 10 Hz log). */
export function repeatedFixFrac(records: DdaRecord[]): number {
  let rep = 0;
  let tot = 0;
  for (let i = 1; i < records.length; i++) {
    const a = records[i - 1];
    const b = records[i];
    if (a.raw_lat == null || b.raw_lat == null) continue;
    tot++;
    if (a.raw_lat === b.raw_lat && a.raw_lon === b.raw_lon) rep++;
  }
  return tot ? rep / tot : Number.NaN;
}
