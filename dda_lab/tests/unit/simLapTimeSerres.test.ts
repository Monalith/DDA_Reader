// lineMode 'lap-time' on the bundled pist Serres (pist-line note §8): the
// direct lap-time descent (free-trajectory, own rider, fastest-κ warm start)
// must open K4 the way the owner rides it (exit wide) and lap faster than the
// κ 0.85 line; and the BMW v2 reference fit on it — the "no exceptions" ceiling
// test that used to sit on the κ 0 min-curvature line (simFitRider.test.ts).
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { createOptimiser } from '../../src/sim/freeTrajectory';
import { fitRider, type RiderFit } from '../../src/sim/fitRider';
import { clearLapTimeLines, LAP_TIME_ITERATIONS, lapTimeLineStatus, lapTimeStart, rememberLapTimeLine } from '../../src/sim/lapTimeLine';
import { buildLine } from '../../src/sim/line';
import { clampParams, DEFAULT_SIM_PARAMS } from '../../src/sim/presets';
import { parseReference } from '../../src/sim/reference';
import { solve } from '../../src/sim/solver';
import type { Line, SimParams } from '../../src/sim/types';
import { loadPistModel } from '../../scripts/lib/fitLines';

const P0 = clampParams(DEFAULT_SIM_PARAMS);
// the v2 block's setup (1000 preset, kerb 1.0, κ 0, the preset's 0.4 m wander), lap-time objective
const PL: SimParams = { ...P0, tyre: { ...P0.tyre, kerbM: 1 }, rider: { ...P0.rider, kappa: 0, lineMode: 'lap-time' } };
const LIMIT_G = 1.47; // the 1.40 g ceiling × 1.05

/** Radius at the fit's matched apex of `name`, m. */
const apexR = (line: Line, fit: RiderFit, name: string): number =>
  1 / Math.abs(line.curvature[fit.corners.find((c) => c.name === name)!.iApex]);

describe('lap-time line on the pist Serres, BMW v2 fit', { timeout: 120_000 }, () => {
  const model = loadPistModel(new URL('../../public/tracks/serres.pist.json', import.meta.url).pathname);
  const corridor = model.corridor ?? undefined;
  const ref = parseReference(JSON.parse(readFileSync(new URL('../../public/examples/serres_BMW_1-19-81_v2.json', import.meta.url), 'utf8')));
  let line!: Line;
  let fit!: RiderFit;
  let lapS = 0;
  let converged = false;
  let ms = 0;

  beforeAll(() => {
    clearLapTimeLines();
    const t0 = performance.now();
    const opt = createOptimiser(model.track, corridor, PL, { init: lapTimeStart(model.track, corridor, PL), rider: 'own' });
    for (let k = 0; k < LAP_TIME_ITERATIONS && !opt.converged; k++) opt.iterate();
    ms = performance.now() - t0;
    lapS = opt.lapTimeS;
    converged = opt.converged;
    rememberLapTimeLine(model.track, PL, opt.offsetsM, opt.lapTimeS);
    line = buildLine(model.track, corridor, PL);
    fit = fitRider(line, PL, ref);
  }, 120_000);

  it('converges inside the worker budget and is what buildLine rides', () => {
    expect(converged).toBe(true);
    expect(ms).toBeLessThan(60_000); // 13.8 s measured alone
    expect(lapTimeLineStatus(model.track, PL)).toBe('fresh');
  });

  it('laps faster than the κ 0.85 line on the same QSS rider (76.34 against 80.50 s measured)', () => {
    const calm = (p: SimParams): SimParams => ({ ...p, rider: { ...p.rider, lineDeviationM: 0 } });
    const k85 = { ...PL, rider: { ...PL.rider, kappa: 0.85, lineMode: 'min-time' as const } };
    const tK85 = solve(buildLine(model.track, corridor, calm(k85)), calm(k85)).lapTimeS;
    expect(lapS).toBeLessThan(tK85 - 1);
  });

  it('opens K4 to ≥ 130 m at the matched apex (κ 0 lines: 107 m; owner: 170 m)', () => {
    expect(fit.corners).toHaveLength(16);
    expect(apexR(line, fit, 'K4')).toBeGreaterThanOrEqual(130);
  });

  it('brings K12 exit zone peak under 2 g (κ 0 min-curvature: 2.10 g)', () => {
    expect(fit.corners.find((c) => c.name === 'K12')!.aLatPeakG).toBeLessThan(2.0);
  });

  // Documented exceptions on the lap-time line (note §8): K12 alone — the
  // descent tightens K12's kerb-side apex (1.78 g) while it opens the exit
  // (zone peak 2.10 → ~1.8 g). K2, K4, K6 (the κ 0 min-curvature exceptions)
  // are under 1.47 g here.
  const EXCEPT = new Set(['K12']);
  it('every apex ≤ 1.47 g except the documented K12', () => {
    for (const c of fit.corners) if (!EXCEPT.has(c.name)) expect(c.aLatG, c.name).toBeLessThanOrEqual(LIMIT_G);
  });

  // RED by design while the exception above remains (K12 ~1.78 g).
  it('every apex ≤ 1.47 g (no exceptions)', () => {
    for (const c of fit.corners) expect(c.aLatG, c.name).toBeLessThanOrEqual(LIMIT_G);
  });
});
