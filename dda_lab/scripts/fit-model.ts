// Per-corner fit model (src/sim/fitModel.ts) on the Serres pist track: a
// recorded lap (Ducati DDA JSON, its own GPS line) and/or the BMW video lap.
//
//   cd dda_lab && npx vite-node scripts/fit-model.ts [--ducati Run036.json] [--lap N] [--track x.pist.json] [--auto-track] [--bmw] [--budget ms]
import { readFileSync } from 'node:fs';
import { computeDerived } from '../src/core/derived';
import { detectLaps } from '../src/core/laps';
import { sessionFromDdaReaderJson } from '../src/core/sessionLoader';
import type { Lap, Session } from '../src/core/types';
import { lateralCeilingG } from '../src/sim/fitRider';
import { applyFit, buildFitModel, fitRows, type FitModel } from '../src/sim/fitModel';
import { referenceFromLap } from '../src/sim/lapReference';
import { clampParams, DEFAULT_SIM_PARAMS } from '../src/sim/presets';
import { parseReference } from '../src/sim/reference';
import { loadPistModel } from './lib/fitLines';
import { buildTrackFromSession } from '../src/state/trackActions';
import type { TrackModel } from '../src/core/types';

const INBOX = '/Users/macbookmini/projects/DDA_Reader/_inbox';
const arg = (k: string): string | undefined => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const budget = Number(arg('--budget') ?? 25000);
const model = loadPistModel(arg('--track') ?? new URL('../public/tracks/serres-v6.pist.json', import.meta.url).pathname);
let track: TrackModel = model.track;
let corridor = model.corridor ?? undefined;
const P = clampParams(DEFAULT_SIM_PARAMS);

function report(m: FitModel): void {
  const r = applyFit(track, m, m.fitted);
  const rows = fitRows(m, r.line, r.env, lateralCeilingG(m.params));
  console.log(`\n## ${m.reference} · ${m.corners.length} corners (path ${m.pathTrusted ? 'measured' : 'not measured'})`);
  console.log(`lap ${r.env.lapTimeS.toFixed(2)} s · ref ${m.refLapTimeS.toFixed(2)} s · ref speed on line ${m.alignedRefLapS.toFixed(2)} s`);
  console.log(`fit iterations ${m.stats.fitIterations}, refine rounds ${m.stats.refineRounds} (${m.stats.refineSolves} solves), error ${m.stats.errorBefore.toFixed(1)} → ${m.stats.errorAfter.toFixed(1)}, ${(m.stats.ms / 1000).toFixed(1)} s`);
  console.log('| corner | apex ref | apex sim | v rms km/h | a rms g | lat g | κ | lat× | brk× | exit× | run× | roll-on s | coast |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  rows.forEach((row, k) => {
    const s = m.fitted[k];
    console.log(
      `| ${row.name} | ${row.apexRefKmh.toFixed(1)} | ${row.apexSimKmh.toFixed(1)} | ${row.vRmsKmh.toFixed(1)} | ${row.aRmsG.toFixed(3)} | ${row.aLatPeakG.toFixed(2)} | ${s.kappa.toFixed(2)} | ${s.latScale.toFixed(2)} | ${s.brakeScale.toFixed(2)} | ${s.exitScale.toFixed(2)} | ${s.runScale.toFixed(2)} | ${s.rollOnS.toFixed(2)} | ${s.coast ? 'on' : 'off'} |`,
    );
  });
}

const ducati = arg('--ducati') ?? (process.argv.includes('--bmw') ? undefined : `${INBOX}/Run036-219926-00.00.json`);
if (ducati) {
  const j = JSON.parse(readFileSync(ducati, 'utf8'));
  const s: Session = sessionFromDdaReaderJson(j, 'Run036', '#f00');
  computeDerived(s, track);
  if (!s.laps.length) s.laps = detectLaps(s, track.startFinish, track.sectors);
  if (process.argv.includes('--auto-track')) {
    // the track model the app builds from the session itself (no pist package, no corridor)
    track = buildTrackFromSession(s)!;
    corridor = undefined;
    console.log(`auto track: ${track.turns.length} turns, ${track.lengthM.toFixed(0)} m`);
  }
  const want = arg('--lap');
  const lap: Lap | undefined = want ? s.laps.find((l) => l.n === Number(want)) : (s.laps.find((l) => l.isBest) ?? s.laps[0]);
  if (!lap) throw new Error('no lap');
  console.log(`Ducati lap ${lap.n} ${lap.timeS.toFixed(2)} s`);
  const lr = referenceFromLap(s, lap, track);
  report(buildFitModel(track, corridor, P, lr, { budgetMs: budget, }));
}
if (process.argv.includes('--bmw')) {
  const ref = parseReference(JSON.parse(readFileSync(new URL('../public/examples/serres_BMW_1-19-81_v2.json', import.meta.url).pathname, 'utf8')));
  report(buildFitModel(track, corridor, P, { ref, pathTrusted: false, label: ref.name }, { budgetMs: budget }));
}
