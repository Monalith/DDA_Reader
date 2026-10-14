// "Fit to lap" (src/sim/riderFit.ts): the virtual rider's own parameters
// (A / R, pinned keys, per-corner overrides) calibrated to a recorded lap.
// Spec 2026-10-14-fit-to-lap-rider-calibration.md targets on Run036 lap 6
// (gitignored _inbox file: skipped when absent) and the BMW video lap.
import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { computeDerived } from '../../src/core/derived';
import { detectLaps } from '../../src/core/laps';
import { sessionFromDdaReaderJson } from '../../src/core/sessionLoader';
import type { Session } from '../../src/core/types';
import { simulate } from '../../src/sim';
import { cornerZones } from '../../src/sim/cornerRider';
import { referenceFromLap } from '../../src/sim/lapReference';
import { lineFromOffsets } from '../../src/sim/line';
import { clampParams, DEFAULT_SIM_PARAMS } from '../../src/sim/presets';
import { parseReference } from '../../src/sim/reference';
import { fitRiderToLap, refTimeOnLine, riderFitRows, type RiderFitResult } from '../../src/sim/riderFit';
import { loadPistModel } from '../../scripts/lib/fitLines';

const pist = loadPistModel(new URL('../../public/tracks/serres-v6.pist.json', import.meta.url).pathname);
const track = pist.track;
const corridor = pist.corridor ?? undefined;
const P = clampParams(DEFAULT_SIM_PARAMS);
const DUCATI = '/Users/macbookmini/projects/DDA_Reader/_inbox/Run036-219926-00.00.json';
const HAS_DUCATI = existsSync(DUCATI);
const BUDGET_MS = 25_000;
const meanV = (r: RiderFitResult): number => r.rows.reduce((a, b) => a + b.vRmsKmh, 0) / r.rows.length;

describe('refTimeOnLine', () => {
  it('a constant speed is the line length over that speed', () => {
    const line = lineFromOffsets(track, new Float32Array(track.centerline.length));
    const v = new Float32Array(line.points.length).fill(40);
    expect(refTimeOnLine(line, v)).toBeCloseTo(line.lengthM / 40, 6);
  });
});

describe.skipIf(!HAS_DUCATI)('fitRiderToLap: Run036 lap 6 (measured GPS path)', () => {
  let r: RiderFitResult;
  beforeAll(() => {
    const s: Session = sessionFromDdaReaderJson(JSON.parse(readFileSync(DUCATI, 'utf8')), 'Run036', '#f00');
    computeDerived(s, track);
    if (!s.laps.length) s.laps = detectLaps(s, track.startFinish, track.sectors);
    const lap = s.laps.find((l) => l.n === 6)!;
    expect(lap.timeS).toBeCloseTo(95.8, 1);
    r = fitRiderToLap(track, corridor, P, referenceFromLap(s, lap, track), { budgetMs: BUDGET_MS });
  }, 120_000);

  it('lap within 1.0 s of 95.80, in ≤ 30 s, the error falls', () => {
    expect(Math.abs(r.lapTimeS - 95.8)).toBeLessThanOrEqual(1.0);
    expect(r.stats.ms).toBeLessThanOrEqual(30_000);
    expect(r.stats.errorAfter).toBeLessThan(r.stats.errorBefore);
    expect(r.ref.pathTrusted).toBe(true);
  });

  it('mean corner speed RMSE < 4 km/h; line RMSE reported', () => {
    expect(r.rows.length).toBe(16);
    expect(meanV(r)).toBeLessThan(4);
    for (const row of r.rows) expect(row.lineRmsM).not.toBeNull();
  });

  it('per-corner overrides of the rider\'s own keys on ≥ 5 corners, inside their bounds', () => {
    const cs = r.rider.corners ?? {};
    expect(Object.keys(cs).length).toBeGreaterThanOrEqual(5);
    for (const c of Object.values(cs)) {
      for (const v of Object.values(c)) {
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it('the rider mode rides the fitted rider to the same lap (what the sliders show)', () => {
    const sim = simulate(track, corridor, { ...P, rider: r.rider }, 'sim', 'x', '#fff', 'rider');
    expect(sim.lapTimeS).toBeCloseTo(r.lapTimeS, 6);
    const rows = riderFitRows(r.ref, cornerZones(sim.line, track), sim.line, sim.envelope, P);
    expect(rows.length).toBe(16);
    const m = rows.reduce((a, b) => a + b.vRmsKmh, 0) / rows.length;
    expect(Math.abs(m - meanV(r))).toBeLessThan(0.5);
  });
});

describe('fitRiderToLap: BMW video lap (hand-placed path)', () => {
  let r: RiderFitResult;
  beforeAll(() => {
    const ref = parseReference(JSON.parse(readFileSync(new URL('../../public/examples/serres_BMW_1-19-81_v2.json', import.meta.url).pathname, 'utf8')));
    r = fitRiderToLap(track, corridor, P, { ref, pathTrusted: false, label: ref.name }, { budgetMs: BUDGET_MS });
  }, 120_000);

  it('the path is not trusted: no line RMSE, the line style stays the user\'s', () => {
    expect(r.ref.pathTrusted).toBe(false);
    expect(r.ref.pathOffsetM).toBeNull();
    for (const row of r.rows) expect(row.lineRmsM).toBeNull();
    expect(r.rider.kappa).toBe(P.rider.kappa);
  });

  it('lap within 1.0 s of 79.8', () => {
    expect(Math.abs(r.lapTimeS - 79.8)).toBeLessThanOrEqual(1.0);
    expect(r.stats.ms).toBeLessThanOrEqual(30_000);
  });
});
