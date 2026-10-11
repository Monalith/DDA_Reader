// lineMode 'lap-time' on the bundled pist Serres (pist-line note §8-9): the
// direct lap-time descent, multi-start (the fastest κ-line + the owner's GPS
// path when the gitignored Ducati run is present) with the soft lateral-g
// ceiling priced at the BMW v2 reference speed, must open K4 the way the owner
// rides it (exit wide) and lap faster than the κ 0.85 line; and the BMW v2
// reference fit on it — the "no exceptions" ceiling test that used to sit on
// the κ 0 min-curvature line (simFitRider.test.ts).
import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { fitRider, lateralCeilingG, type RiderFit } from '../../src/sim/fitRider';
import {
  clearLapTimeLines,
  lapTimeLineStatus,
  lapTimeReferenceSpeed,
  lapTimeStart,
  rememberLapTimeLine,
  runLapTimeLine,
  type LapTimeRunResult,
} from '../../src/sim/lapTimeLine';
import { buildLine, lineFromOffsets } from '../../src/sim/line';
import { clampParams, DEFAULT_SIM_PARAMS } from '../../src/sim/presets';
import { parseReference } from '../../src/sim/reference';
import { solve } from '../../src/sim/solver';
import type { Line, SimParams } from '../../src/sim/types';
import { analyseRun, DEFAULT_RUN } from '../../scripts/lib/ducatiLateral';
import { loadPistModel } from '../../scripts/lib/fitLines';
import { ownerOffsets } from '../../scripts/lib/ownerOffsets';

const P0 = clampParams(DEFAULT_SIM_PARAMS);
// the v2 block's setup (1000 preset, kerb 1.0, κ 0, the preset's 0.4 m wander), lap-time objective
const PL: SimParams = { ...P0, tyre: { ...P0.tyre, kerbM: 1 }, rider: { ...P0.rider, kappa: 0, lineMode: 'lap-time' } };
const LIMIT_G = 1.47; // the 1.40 g ceiling × 1.05

/** Radius at the fit's matched apex of `name`, m. */
const apexR = (line: Line, fit: RiderFit, name: string): number =>
  1 / Math.abs(line.curvature[fit.corners.find((c) => c.name === name)!.iApex]);

describe('lap-time line (multi-start + lateral-g penalty) on the pist Serres, BMW v2 fit', { timeout: 180_000 }, () => {
  const model = loadPistModel(new URL('../../public/tracks/serres.pist.json', import.meta.url).pathname);
  const corridor = model.corridor ?? undefined;
  const ref = parseReference(JSON.parse(readFileSync(new URL('../../public/examples/serres_BMW_1-19-81_v2.json', import.meta.url), 'utf8')));
  const hasOwner = existsSync(DEFAULT_RUN);
  let line!: Line;
  let fit!: RiderFit;
  let run!: LapTimeRunResult;
  let vRef!: Float32Array;

  beforeAll(() => {
    clearLapTimeLines();
    const warmStarts: Line[] = [];
    if (hasOwner) {
      const res = analyseRun(DEFAULT_RUN, model);
      const tr = res.traces.get(res.best)!;
      warmStarts.push(lineFromOffsets(model.track, ownerOffsets(model.track, tr.lon, tr.lat)));
    }
    // the penalty's v_ref, as the run computes it (aligned on start (a)), for the K12 demand test
    vRef = lapTimeReferenceSpeed(lineFromOffsets(model.track, lapTimeStart(model.track, corridor, PL)), PL, ref);
    // no wall-clock cut here (a loaded test runner is slower than the worker; the
    // budget itself is unit-tested in simFreeTrajectory): every start runs to convergence
    run = runLapTimeLine(model.track, corridor, PL, { warmStarts, reference: ref, budgetMs: Infinity });
    rememberLapTimeLine(model.track, PL, run.offsetsM, run.lapTimeS);
    line = buildLine(model.track, corridor, PL);
    fit = fitRider(line, PL, ref);
  }, 180_000);

  it('runs every start to convergence and is what buildLine rides', () => {
    expect(run.starts).toHaveLength(hasOwner ? 2 : 1);
    for (const s of run.starts) expect(s.converged, s.label).toBe(true);
    expect(run.ms).toBeLessThan(60_000); // 27 s measured alone (Node), the worker's budget is 28 s
    expect(lapTimeLineStatus(model.track, PL)).toBe('fresh');
    // keep-best: the fastest QSS lap of the starts
    for (const s of run.starts) expect(run.lapTimeS).toBeLessThanOrEqual(s.lapTimeS);
  });

  it('laps faster than the κ 0.85 line on the same QSS rider by > 1 s (76.66 against 80.50 s measured)', () => {
    const calm = (p: SimParams): SimParams => ({ ...p, rider: { ...p.rider, lineDeviationM: 0 } });
    const k85 = { ...PL, rider: { ...PL.rider, kappa: 0.85, lineMode: 'min-time' as const } };
    const tK85 = solve(buildLine(model.track, corridor, calm(k85)), calm(k85)).lapTimeS;
    expect(run.lapTimeS).toBeLessThan(tK85 - 1);
  });

  it('opens K4 to ≥ 130 m at the matched apex (κ 0 lines: 107 m; owner: 170 m; measured 150 m)', () => {
    expect(fit.corners).toHaveLength(16);
    expect(apexR(line, fit, 'K4')).toBeGreaterThanOrEqual(130);
  });

  it('brings K12 exit zone peak under 2 g (κ 0 min-curvature: 2.10 g)', () => {
    expect(fit.corners.find((c) => c.name === 'K12')!.aLatPeakG).toBeLessThan(2.0);
  });

  // Note §9: no exceptions left on this line (single start: K12 1.78 g). The
  // fit's K12 apex on it, though, is matched to the EXIT-side |κ| peak
  // (centreline 2115 m, R 90 m) where the single-start line had it on the
  // kerb-side one (2052 m) — see the K12 demand test below.
  it('every apex ≤ 1.47 g (no exceptions)', () => {
    for (const c of fit.corners) expect(c.aLatG, c.name).toBeLessThanOrEqual(LIMIT_G);
  });

  // RED by design (note §9): the penalty's own measure — the BMW v2 speed
  // aligned on the start line, fixed per station, × |κ| of this line — still
  // peaks at ~1.55 g between K12's kerb and exit (centreline 2030-2160 m); the
  // fit reads 0.99 g at K12 only because its apex match slid to the exit peak.
  it('K12 kerb → exit demand at the reference speed ≤ 1.47 g', () => {
    let m = 0;
    for (let i = 0; i < line.points.length; i++) {
      const s = model.track.cumDistM[i];
      if (s >= 2030 && s <= 2160) m = Math.max(m, (vRef[i] * vRef[i] * Math.abs(line.curvature[i])) / 9.81);
    }
    expect(lateralCeilingG(PL)).toBeCloseTo(1.4, 6);
    expect(m).toBeLessThanOrEqual(LIMIT_G);
  });
});
