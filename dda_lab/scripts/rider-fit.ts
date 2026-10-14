// "Fit to lap" (src/sim/riderFit.ts) on the Serres pist track: a recorded lap
// (Ducati DDA JSON, its own GPS line) and/or the BMW video lap.
//
//   cd dda_lab && npx vite-node scripts/rider-fit.ts [--track x.pist.json] [--ducati Run036.json] [--lap N] [--bmw] [--budget ms]
//
// Prints the fitted lap against the reference, A / R, the pinned keys, and a
// per-corner table (the fitted overrides and the comparison rows). The Run036
// acceptance (spec 2026-10-14) is checked at the end.
import { existsSync, readFileSync } from 'node:fs';
import { computeDerived } from '../src/core/derived';
import { detectLaps } from '../src/core/laps';
import { sessionFromDdaReaderJson } from '../src/core/sessionLoader';
import type { Lap, Session, TrackModel } from '../src/core/types';
import type { CornerRiderKey } from '../src/sim/cornerRider';
import { referenceFromLap, type LapReference } from '../src/sim/lapReference';
import { clampParams, DEFAULT_SIM_PARAMS } from '../src/sim/presets';
import { parseReference } from '../src/sim/reference';
import { fitRiderToLap, type RiderFitResult } from '../src/sim/riderFit';
import { loadPistModel } from './lib/fitLines';

const INBOX = '/Users/macbookmini/projects/DDA_Reader/_inbox';
const arg = (k: string): string | undefined => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const budget = Number(arg('--budget') ?? 25000);
const model = loadPistModel(arg('--track') ?? new URL('../public/tracks/serres-v6.pist.json', import.meta.url).pathname);
const track: TrackModel = model.track;
const corridor = model.corridor ?? undefined;
const P = clampParams(DEFAULT_SIM_PARAMS);
const CORNER_FIT_KEYS_SHORT: Array<{ key: CornerRiderKey; label: string }> = [
  { key: 'kappa', label: 'κ' },
  { key: 'sBrake', label: 'sBrk' },
  { key: 'trailBrakeDepth', label: 'tbD' },
  { key: 'sLat', label: 'sLat' },
  { key: 'leanUsage', label: 'lean' },
  { key: 'throttleDelayS', label: 'delay' },
  { key: 'rollOnS', label: 'rollOn' },
  { key: 'sDrive', label: 'sDrv' },
  { key: 'slideOut', label: 'slide' },
];

function fit(lr: LapReference): RiderFitResult {
  let last = -1;
  return fitRiderToLap(track, corridor, P, lr, {
    budgetMs: budget,
    onProgress: (p) => {
      const pct = Math.floor(p.frac * 10);
      if (pct !== last) {
        last = pct;
        process.stderr.write(`  ${(p.frac * 100).toFixed(0)} % ${p.stage}${p.error !== undefined ? ` · error ${p.error.toFixed(2)}` : ''}\n`);
      }
    },
  });
}

function report(r: RiderFitResult): void {
  const rd = r.rider;
  console.log(`\n## ${r.ref.label} · ${r.zones.length} corners (path ${r.ref.pathTrusted ? 'measured GPS' : 'not measured'})`);
  console.log(`lap ${r.lapTimeS.toFixed(2)} s · ref ${r.ref.refLapTimeS.toFixed(2)} s (Δ ${(r.lapTimeS - r.ref.refLapTimeS).toFixed(2)}) · ref speed on line ${r.refOnLineS.toFixed(2)} s`);
  console.log(`A ${rd.aggressiveness.toFixed(2)} · R ${rd.risk.toFixed(2)} · pinned ${rd.overrides.length ? rd.overrides.map((k) => `${k} ${(rd[k] as number).toFixed(3)}`).join(', ') : '—'}`);
  console.log(`lap-wide: sBrake ${rd.sBrake.toFixed(3)} sLat ${rd.sLat.toFixed(3)} sDrive ${rd.sDrive.toFixed(3)} leanUsage ${rd.leanUsage.toFixed(3)} tbDepth ${rd.trailBrakeDepth.toFixed(2)} delay ${rd.throttleDelayS.toFixed(2)} s rollOn ${rd.rollOnS.toFixed(2)} s κ ${rd.kappa.toFixed(2)}`);
  console.log(`evaluations ${r.stats.evaluations}, error ${r.stats.errorBefore.toFixed(1)} → ${r.stats.errorAfter.toFixed(1)}, ${(r.stats.ms / 1000).toFixed(1)} s`);
  console.log(`| corner | apex ref | apex sim | v rms km/h | a rms g | line rms m | lat g | grade | ${CORNER_FIT_KEYS_SHORT.map((x) => x.label).join(' | ')} |`);
  console.log(`|---|---|---|---|---|---|---|---|${CORNER_FIT_KEYS_SHORT.map(() => '---').join('|')}|`);
  for (const row of r.rows) {
    const c = rd.corners?.[row.n] ?? {};
    const cells = CORNER_FIT_KEYS_SHORT.map((x) => (c[x.key] === undefined ? '·' : c[x.key]!.toFixed(2)));
    console.log(
      `| ${row.name} | ${row.apexRefKmh.toFixed(1)} | ${row.apexSimKmh.toFixed(1)} | ${row.vRmsKmh.toFixed(1)} | ${row.aRmsG.toFixed(3)} | ${row.lineRmsM === null ? '—' : row.lineRmsM.toFixed(2)} | ${row.latPeakG.toFixed(2)} | ${row.grade} | ${cells.join(' | ')} |`,
    );
  }
  const meanV = r.rows.reduce((a, b) => a + b.vRmsKmh, 0) / Math.max(1, r.rows.length);
  console.log(`mean corner v rms ${meanV.toFixed(2)} km/h · corners with overrides ${Object.keys(rd.corners ?? {}).length}`);
}

const want = arg('--lap');
const ducati = arg('--ducati') ?? (process.argv.includes('--bmw') ? undefined : `${INBOX}/Run036-219926-00.00.json`);
if (ducati && existsSync(ducati)) {
  const j = JSON.parse(readFileSync(ducati, 'utf8'));
  const s: Session = sessionFromDdaReaderJson(j, 'Run036', '#f00');
  computeDerived(s, track);
  if (!s.laps.length) s.laps = detectLaps(s, track.startFinish, track.sectors);
  const lap: Lap | undefined = want ? s.laps.find((l) => l.n === Number(want)) : (s.laps.find((l) => l.isBest) ?? s.laps[0]);
  if (!lap) throw new Error('no lap');
  console.log(`Ducati lap ${lap.n} ${lap.timeS.toFixed(2)} s`);
  const r = fit(referenceFromLap(s, lap, track));
  report(r);
  const meanV = r.rows.reduce((a, b) => a + b.vRmsKmh, 0) / Math.max(1, r.rows.length);
  const ok = [
    [`|lap − ${lap.timeS.toFixed(2)}| ≤ 1.0 s`, Math.abs(r.lapTimeS - lap.timeS) <= 1.0],
    ['mean corner v rms < 4 km/h', meanV < 4],
    ['fit ≤ 30 s', r.stats.ms <= 30_000],
  ] as const;
  console.log(`\nacceptance: ${ok.map(([t, v]) => `${v ? 'PASS' : 'FAIL'} ${t}`).join(' · ')}`);
} else if (ducati) {
  console.log(`(no ${ducati}: Ducati fit skipped)`);
}
if (process.argv.includes('--bmw')) {
  const ref = parseReference(JSON.parse(readFileSync(new URL('../public/examples/serres_BMW_1-19-81_v2.json', import.meta.url).pathname, 'utf8')));
  report(fit({ ref, pathTrusted: false, label: ref.name }));
}
