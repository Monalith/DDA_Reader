// Regression tests for the reference from any loaded lap (src/sim/lapReference.ts)
// on a track model built from the session itself (`buildTrackFromSession`, the
// app's "auto track"), the corners the track model misses (`missedCorners`),
// the `pathOnLine` alignment (src/sim/alignRef.ts) and the end-to-end fit
// (src/sim/fitModel.ts) on the auto track and the pist Serres model.
// The Ducati Run036 file is gitignored (_inbox): those tests skip when absent.
import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { computeDerived } from '../../src/core/derived';
import { haversineM } from '../../src/core/geo';
import { detectLaps } from '../../src/core/laps';
import { sessionFromDdaReaderJson } from '../../src/core/sessionLoader';
import type { Lap, LngLat, Session, TrackModel } from '../../src/core/types';
import { alignReference, projectOnLine } from '../../src/sim/alignRef';
import { applyFit, buildFitModel } from '../../src/sim/fitModel';
import { missedCorners, referenceFromLap, trackCornersFromTurns, type LapReference } from '../../src/sim/lapReference';
import { lineFromOffsets } from '../../src/sim/line';
import { ownerOffsets } from '../../src/sim/ownerOffsets';
import { clampParams, DEFAULT_SIM_PARAMS } from '../../src/sim/presets';
import { nearestOnPath, pathCurvature, type DdaLapTrace, type TrackCorner } from '../../src/sim/referenceFromDda';
import { buildTrackFromSession } from '../../src/state/trackActions';
import { loadPistModel } from '../../scripts/lib/fitLines';

const PIST = new URL('../../public/tracks/serres.pist.json', import.meta.url).pathname;
const DUCATI = '/Users/macbookmini/projects/DDA_Reader/_inbox/Run036-219926-00.00.json';
const HAS_DUCATI = existsSync(DUCATI);
const BEST_LAP_S = 95.8;

const P = clampParams(DEFAULT_SIM_PARAMS);
const pist = loadPistModel(PIST);

/** GPS path length of the lap's samples (haversine, fixes only). */
function gpsLengthM(s: Session, lap: Lap): number {
  const lon = s.channels.get('gps_lon')!.data;
  const lat = s.channels.get('gps_lat')!.data;
  let L = 0;
  let prev: LngLat | null = null;
  for (let i = lap.startIdx; i <= lap.endIdx; i++) {
    if (!Number.isFinite(lon[i]) || !Number.isFinite(lat[i])) continue;
    const p: LngLat = [lon[i], lat[i]];
    if (prev) L += haversineM(prev, p);
    prev = p;
  }
  return L;
}

describe.skipIf(!HAS_DUCATI)('referenceFromLap on the auto track (built from the session itself)', () => {
  let session: Session;
  let lap: Lap;
  let auto: TrackModel;
  let lr: LapReference;

  beforeAll(() => {
    session = sessionFromDdaReaderJson(JSON.parse(readFileSync(DUCATI, 'utf8')), 'Run036', '#f00');
    computeDerived(session, pist.track);
    if (!session.laps.length) session.laps = detectLaps(session, pist.track.startFinish, pist.track.sectors);
    lap = session.laps.find((l) => l.isBest) ?? session.laps[0];
    auto = buildTrackFromSession(session)!;
    lr = referenceFromLap(session, lap, auto);
  }, 120_000);

  it('the best lap is 95.80 s; the auto track has fewer turns than the lap needs', () => {
    expect(lap.timeS).toBeCloseTo(BEST_LAP_S, 1);
    expect(auto.turns.length).toBeLessThan(16);
  });

  it('the rotated clock starts at 0 and never falls; ∫v dt length matches the GPS path within 2 %', () => {
    const ref = lr.ref;
    // the gate falls in the lap's last metre: the clock used to start at ~56 s
    expect(ref.tS[0]).toBeLessThan(0.5);
    for (let s = 1; s < ref.tS.length; s++) expect(ref.tS[s]).toBeGreaterThanOrEqual(ref.tS[s - 1]);
    expect(ref.tS[ref.tS.length - 1]).toBeLessThanOrEqual(ref.lapTimeS + 1e-6);
    const L = gpsLengthM(session, lap);
    // (was 3585 m against a 3095 m GPS path)
    expect(Math.abs(ref.lengthIntM - L) / L).toBeLessThan(0.02);
    expect(ref.lapTimeS).toBeCloseTo(lap.timeS, 6);
  });

  it('missedCorners fills the corners the auto track lacks: ≥ 16, "T…+" names, apexes ≥ 15 m apart', () => {
    const ref = lr.ref;
    expect(ref.corners.length).toBeGreaterThanOrEqual(16);
    const added = ref.corners.filter((c) => /\+$/.test(c.name));
    expect(added.length).toBe(ref.corners.length - auto.turns.length);
    for (const c of added) expect(c.name).toMatch(/^T\d+\++$/);
    const N = ref.lon!.length;
    const ap = ref.corners.map((c) => c.apexM).sort((a, b) => a - b);
    for (let k = 0; k < ap.length; k++) {
      const next = k + 1 < ap.length ? ap[k + 1] : ap[0] + N;
      expect(next - ap[k]).toBeGreaterThanOrEqual(15);
    }
  });

  it('alignReference pathOnLine on the owner line: apexes in lap order, reference speed carried over', () => {
    const ref = lr.ref;
    const line = lineFromOffsets(auto, ownerOffsets(auto, ref.lon!, ref.lat!));
    const al = alignReference(ref, line, P, { pathOnLine: true });
    expect(al.notes.some((n) => n.includes("aligned on the reference's own path"))).toBe(true);
    // apexes in the reference's lap order map to strictly increasing samples (one wrap allowed)
    const order = ref.corners.map((c, k) => ({ a: c.apexM, i: al.apexIdx[k] })).sort((x, y) => x.a - y.a);
    let wraps = 0;
    for (let k = 1; k < order.length; k++) {
      if (order[k].i === order[k - 1].i) throw new Error(`two apexes on sample ${order[k].i}`);
      if (order[k].i < order[k - 1].i) wraps++;
    }
    expect(wraps).toBeLessThanOrEqual(1);
    // the reference speed resampled on the line matches the reference at the projected point
    let sum = 0;
    let cnt = 0;
    for (let sT = 10; sT < ref.lon!.length - 10; sT += 25) {
      const pr = projectOnLine(line, ref.lon![sT], ref.lat![sT]);
      if (pr.distM > 10) continue;
      sum += Math.abs(al.vRefMs[pr.i] * 3.6 - ref.speedKmh[sT]);
      cnt++;
    }
    expect(cnt).toBeGreaterThan(100);
    expect(sum / cnt).toBeLessThan(3);
  });

  it('end to end on the auto track: fitted lap within 1.0 s of 95.80, the refine lowers the error', () => {
    const m = buildFitModel(auto, undefined, P, lr, { budgetMs: 4000 });
    const r = applyFit(auto, m, m.fitted);
    expect(Math.abs(r.env.lapTimeS - BEST_LAP_S)).toBeLessThan(1.0);
    expect(m.stats.errorAfter).toBeLessThan(m.stats.errorBefore);
  }, 120_000);

  it('end to end on the pist Serres model: fitted lap within 1.0 s of 95.80, the refine lowers the error', () => {
    const lrP = referenceFromLap(session, lap, pist.track);
    const m = buildFitModel(pist.track, pist.corridor ?? undefined, P, lrP, { budgetMs: 4000 });
    const r = applyFit(pist.track, m, m.fitted);
    expect(Math.abs(r.env.lapTimeS - BEST_LAP_S)).toBeLessThan(1.0);
    expect(m.stats.errorAfter).toBeLessThan(m.stats.errorBefore);
  }, 120_000);
});

describe('missedCorners on a synthetic trace', () => {
  // a closed square with rounded corners, driven anticlockwise: four 90° left
  // bends (Gaussian κ, σ 15 m, peak ≈ 1/24 m) joined by 200 m straights, 20 m/s
  const SIGMA = 15;
  const STRAIGHT = 200;
  const SEG = STRAIGHT + 6 * SIGMA;
  const N = 4 * SEG;
  const A = Math.PI / 2 / (SIGMA * Math.sqrt(2 * Math.PI));
  const centre = (j: number): number => j * SEG + SEG / 2;
  const kappaAt = (s: number): number => {
    let k = 0;
    for (let j = 0; j < 4; j++) k += A * Math.exp(-((s - centre(j)) ** 2) / (2 * SIGMA * SIGMA));
    return k;
  };
  const lon0 = 23.5;
  const lat0 = 41.0;
  const mLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const mLat = 110540;
  const lon = new Float64Array(N);
  const lat = new Float64Array(N);
  let x = 0;
  let y = 0;
  let th = 0;
  for (let s = 0; s < N; s++) {
    lon[s] = lon0 + x / mLon;
    lat[s] = lat0 + y / mLat;
    th += kappaAt(s + 0.5);
    x += Math.cos(th);
    y += Math.sin(th);
  }
  const trace: DdaLapTrace = {
    lap: 1,
    lapTimeS: N / 20,
    lengthM: N,
    lon,
    lat,
    tS: Float64Array.from({ length: N }, (_, s) => s / 20),
    vMs: new Float32Array(N).fill(20),
    leanDeg: new Float32Array(N),
    kappa: pathCurvature(lon, lat, 20),
    speedScale: 1,
    rec: { tS: new Float64Array(0), sM: new Float64Array(0), leanDeg: new Float32Array(0), vMs: new Float32Array(0), accelLatG: new Float32Array(0) },
  };
  const pos = (s: number): LngLat => [lon[((Math.round(s) % N) + N) % N], lat[((Math.round(s) % N) + N) % N]];
  const corner = (j: number, name: string): TrackCorner => ({ name, dir: 'L', apex: pos(centre(j)), entry: pos(centre(j) - 40), exit: pos(centre(j) + 40) });

  it('finds the two bends the known list lacks, left-handed, named after the corner before', () => {
    const known = [corner(0, 'T1'), corner(2, 'T3')];
    const out = missedCorners(trace, known);
    expect(out.length).toBe(2);
    const found = out.map((c) => ({ c, s: nearestOnPath(lon, lat, c.apex).s })).sort((a, b) => a.s - b.s);
    expect(Math.abs(found[0].s - centre(1))).toBeLessThan(10);
    expect(Math.abs(found[1].s - centre(3))).toBeLessThan(10);
    expect(found.map((f) => f.c.name)).toEqual(['T1+', 'T3+']);
    for (const f of found) {
      expect(f.c.dir).toBe('L');
      // the zone surrounds the apex
      const e = nearestOnPath(lon, lat, f.c.entry).s;
      const xS = nearestOnPath(lon, lat, f.c.exit).s;
      expect(e).toBeLessThan(f.s);
      expect(xS).toBeGreaterThan(f.s);
    }
  });

  it('a known corner whose apex sits > 60 m off the peak but whose zone holds it is not re-added (Serres K11)', () => {
    const c = centre(1);
    const off: TrackCorner = { name: 'T2', dir: 'L', apex: pos(c + 70), entry: pos(c - 40), exit: pos(c + 80) };
    const out = missedCorners(trace, [corner(0, 'T1'), off, corner(2, 'T3'), corner(3, 'T4')]);
    expect(out).toEqual([]);
  });

  it('finds nothing when every bend is known, nor when the lap is too slow to need 0.5 g', () => {
    expect(missedCorners(trace, [0, 1, 2, 3].map((j) => corner(j, `T${j + 1}`)))).toEqual([]);
    const slow = { ...trace, vMs: new Float32Array(N).fill(5) };
    expect(missedCorners(slow, [corner(0, 'T1')])).toEqual([]);
  });

  it('trackCornersFromTurns names each turn', () => {
    const cs = trackCornersFromTurns(pist.track);
    expect(cs.length).toBe(pist.track.turns.length);
    for (const c of cs) expect(c.name.length).toBeGreaterThan(0);
  });
});
