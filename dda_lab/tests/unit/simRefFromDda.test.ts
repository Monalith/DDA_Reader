// The Ducati DDA → Reference adapter (src/sim/referenceFromDda.ts,
// docs/superpowers/notes/2026-10-11-ducati-lateral-g.md).
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fromLocalM } from '../../src/core/geo';
import type { LngLat } from '../../src/core/types';
import {
  ddaLapTrace,
  fitGroundSpeed,
  referenceFromDda,
  trackCornersFromPist,
  type DdaJson,
  type DdaJsonRecord,
} from '../../src/sim/referenceFromDda';
import { loadPistModel } from '../../scripts/lib/fitLines';
import { ownLine, panigaleParams } from '../../scripts/lib/ducatiLateral';
import { fitRider } from '../../src/sim/fitRider';
import { chooseCurvatureScaleM, CURV_SCALE_SURVEYED_M } from '../../src/sim/line';

const BUNDLED = new URL('../../public/tracks/serres.pist.json', import.meta.url).pathname;
/** The owner's Ducati run (gitignored inbox; the real-data tests run when it is present). */
const RUN = new URL('../../../_inbox/Run036-219926-00.00.json', import.meta.url).pathname;

describe('referenceFromDda: synthetic circle', () => {
  // 10 Hz, R 50 m, 20 m/s, left turn (CCW), lean = −atan(v²/(gR)) in the app's convention (left negative)
  const R = 50;
  const v = 20;
  const o: LngLat = [23.5, 41.07];
  const dt = 0.1;
  const lapT = (2 * Math.PI * R) / v;
  const nLap = Math.round(lapT / dt);
  const lean = (-Math.atan((v * v) / (9.81 * R)) * 180) / Math.PI;
  const records: DdaJsonRecord[] = [];
  for (let k = 0; k <= 3 * nLap; k++) {
    const th = (v / R) * k * dt;
    const [lon, lat] = fromLocalM(o, [R * Math.cos(th), R * Math.sin(th)]);
    records.push({ time_s: k * dt, speed_kmh: v * 3.6, lean_angle_deg: lean, gps_lat: lat, gps_lon: lon, lap: Math.floor(k / nLap) });
  }
  const run: DdaJson = {
    records,
    laps: [0, 1, 2].map((l) => ({ lap_number: l, duration_s: nLap * dt, start_index: l * nLap, end_index: (l + 1) * nLap, distance_m: 2 * Math.PI * R, is_best: l === 1 })),
  };
  const gate = fromLocalM(o, [0, -R]);
  const tr = ddaLapTrace(run, 1, gate, { lagS: 0, a: 1, b: 0, n: 0, rms: 0 });

  it('length, curvature and lateral g of a circle', () => {
    expect(tr.lengthM).toBeGreaterThan(2 * Math.PI * R * 0.995);
    expect(tr.lengthM).toBeLessThan(2 * Math.PI * R * 1.005);
    const mid = tr.kappa[Math.floor(tr.kappa.length / 2)];
    expect(mid).toBeCloseTo(1 / R, 3);
    // v²κ/g = tan|lean|
    const g = (tr.vMs[100] ** 2 * tr.kappa[100]) / 9.81;
    expect(g).toBeCloseTo(Math.tan((Math.abs(lean) * Math.PI) / 180), 2);
  });

  it('the gate is metre 0 and clock 0', () => {
    const d = Math.hypot((tr.lon[0] - gate[0]) * 111320 * Math.cos((gate[1] * Math.PI) / 180), (tr.lat[0] - gate[1]) * 111320);
    expect(d).toBeLessThan(1.5);
    expect(tr.tS[0]).toBeLessThan(0.1);
    expect(tr.tS[tr.tS.length - 1]).toBeGreaterThan(lapT - 0.2);
  });
});

describe.skipIf(!existsSync(RUN))('referenceFromDda: the owner\'s Ducati best lap on the pist Serres model', () => {
  const model = loadPistModel(BUNDLED);
  const run = JSON.parse(readFileSync(RUN, 'utf8')) as DdaJson;
  const kept = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const gs = fitGroundSpeed(run, kept);
  const tr = ddaLapTrace(run, 6, model.track.centerline[0], gs);
  const corners = trackCornersFromPist(model.pkg);
  const ref = referenceFromDda(tr, corners, 'Ducati lap 6');

  it('yields the 16 pist corners, in lap order, with their directions', () => {
    expect(ref.corners.length).toBe(16);
    expect(ref.corners.map((c) => c.name)).toEqual(model.pkg.corners.map((c) => c.name));
    expect(ref.corners.map((c) => (c.dir > 0 ? 'L' : 'R'))).toEqual(model.pkg.corners.map((c) => c.dir));
    for (const c of ref.corners) expect(c.zoneM[0] <= c.apexM && c.apexM <= c.zoneM[1]).toBe(true);
  });

  it('the lap length is the pist length within 3 % (the owner\'s line is 2.4 % shorter than the centreline)', () => {
    // The brief asked for 2 %; the owner's GPS lap is 3093-3105 m against the 3170 m centreline: a ridden
    // line cuts the inside of every corner (the pist minimum-distance race line is 3032 m). So the check is
    // 3 %, and the length must sit between the κ 0.85 race line and the centreline.
    const rel = Math.abs(ref.lengthM - model.pkg.lengthM) / model.pkg.lengthM;
    expect(rel).toBeLessThan(0.03);
    expect(ref.lengthM).toBeGreaterThan(3030);
    expect(ref.lengthM).toBeLessThan(model.pkg.lengthM);
    // the speed integrates to the GPS length (rescale ≈ 1), and the lap time is the export's
    expect(Math.abs(tr.speedScale - 1)).toBeLessThan(0.01);
    expect(Math.abs(ref.lengthIntM - tr.lengthM) / tr.lengthM).toBeLessThan(0.005);
    expect(ref.lapTimeS).toBeCloseTo(95.8, 1);
  });

  // ducati-lateral note §7-8: the GPS line takes the 10 m curvature scale, and
  // the fitted rider (coast, roll-on, entry minimum) rides the reference speed
  // on this line within 0.3 s, every apex within 1 km/h
  it('the fit on the owner\'s own GPS line: 10 m curvature, lap within 0.3 s of the reference speed on it, apexes within 1 km/h', () => {
    const N = tr.lon.length;
    const cl = Array.from({ length: N }, (_, i) => [tr.lon[i], tr.lat[i]] as LngLat);
    expect(chooseCurvatureScaleM(cl)).toBe(CURV_SCALE_SURVEYED_M);
    const line = ownLine(tr);
    const fit = fitRider(line, panigaleParams(), ref);
    expect(Math.abs(fit.lapTimeS - fit.alignedRefLapS)).toBeLessThan(0.3);
    for (const d of fit.residuals.apexKmh) expect(Math.abs(d)).toBeLessThan(1);
    // the K7 flick: 0.49 g at the 20 m scale against 0.79 g measured (v²κ) / 0.86 g (calibrated lean)
    const k7 = fit.corners.find((c) => c.name === 'K7')!;
    expect(k7.aLatG).toBeGreaterThan(0.7);
    // the reference coasts into K12 and rolls on out of K5 over seconds
    expect(fit.corners.find((c) => c.name === 'K11')!.coastInM).toBeGreaterThan(30);
    expect(fit.corners.find((c) => c.name === 'K5')!.rollOnS).toBeGreaterThan(2);
  });

  it('v²κ/g on the GPS line tracks tan(lean) (accel_lat_g is tan(lean), not an accelerometer)', () => {
    const r = tr.rec;
    let maxD = 0;
    const g: number[] = [];
    const t: number[] = [];
    for (let k = 0; k < r.tS.length; k++) {
      maxD = Math.max(maxD, Math.abs(r.accelLatG[k] - Math.tan((r.leanDeg[k] * Math.PI) / 180)));
      const i = Math.round(r.sM[k]) % tr.kappa.length;
      g.push((r.vMs[k] ** 2 * tr.kappa[i]) / 9.81);
      t.push(-Math.tan((r.leanDeg[k] * Math.PI) / 180));
    }
    expect(maxD).toBeLessThan(0.01);
    const n = g.length;
    const mg = g.reduce((a, b) => a + b, 0) / n;
    const mt = t.reduce((a, b) => a + b, 0) / n;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let k = 0; k < n; k++) {
      sxy += (g[k] - mg) * (t[k] - mt);
      sxx += (g[k] - mg) ** 2;
      syy += (t[k] - mt) ** 2;
    }
    expect(sxy / Math.sqrt(sxx * syy)).toBeGreaterThan(0.98);
  });
});
