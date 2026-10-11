// Lap-time line, multi-start + soft lateral-g ceiling (pist-line note §9), on
// the pist Serres with the BMW v2 reference: per configuration the BMW v2 fit's
// lateral g at K2 / K4 / K6 / K12 (apex and the K12 zone peak = its exit), the
// QSS lap, the K4 radius and the run time.
//
//   cd dda_lab && npx vite-node scripts/lap-time-multistart.ts [--only diag|configs|spacing] [--lambda 0.5] [--save out.json]
//
// --only diag    every start descended to convergence, with and without the penalty, lap per 4 sweeps
//                (does the ranking after the probe sweeps hold?)
// --only configs single start (§8, shipped before), multi-start, multi-start + penalty — the shipped runner
// --only spacing the chosen configuration at 10 m control spacing
// --only pen     multi-start a,b + penalty at --lambda (λ sensitivity)
import { readFileSync, writeFileSync } from 'node:fs';
import { createOptimiser, LAT_G_PENALTY_DEFAULT, latGPenaltyS } from '../src/sim/freeTrajectory';
import { fitRider, lateralCeilingG, type RiderFit } from '../src/sim/fitRider';
import {
  clearLapTimeLines,
  lapTimeReferenceSpeed,
  lapTimeStart,
  rememberLapTimeLine,
  runLapTimeLine,
  type LapTimeRunOpts,
} from '../src/sim/lapTimeLine';
import { buildLine, lineFromOffsets } from '../src/sim/line';
import { clampParams, DEFAULT_SIM_PARAMS } from '../src/sim/presets';
import { parseReference } from '../src/sim/reference';
import { solve } from '../src/sim/solver';
import type { Line, SimParams } from '../src/sim/types';
import { analyseRun, DEFAULT_RUN } from './lib/ducatiLateral';
import { loadPistModel } from './lib/fitLines';
import { ownerOffsets } from './lib/ownerOffsets';

const argv = process.argv.slice(2);
const opt = (name: string, d: string): string => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : d;
};
const ONLY = opt('--only', '');
const LAMBDA = Number(opt('--lambda', String(LAT_G_PENALTY_DEFAULT)));
const f = (x: number, d = 2): string => (Number.isFinite(x) ? x.toFixed(d) : '—');

const model = loadPistModel(new URL('../public/tracks/serres.pist.json', import.meta.url).pathname);
const { track } = model;
const corridor = model.corridor ?? undefined;
const bmwRef = parseReference(JSON.parse(readFileSync(new URL('../public/examples/serres_BMW_1-19-81_v2.json', import.meta.url), 'utf8')));

// the v2 block's setup (1000 preset, kerb 1.0, κ 0, the preset's wander), lap-time objective
const P0 = clampParams(DEFAULT_SIM_PARAMS);
const PL: SimParams = { ...P0, tyre: { ...P0.tyre, kerbM: 1 }, rider: { ...P0.rider, kappa: 0, lineMode: 'lap-time' } };
const own = clampParams({ ...PL, rider: { ...PL.rider, lineDeviationM: 0 } });
const ceilingG = lateralCeilingG(PL);

// starts and the reference speed per station
const tPrep = performance.now();
const kInit = lapTimeStart(track, corridor, PL);
const kLine = lineFromOffsets(track, kInit);
const vRef = lapTimeReferenceSpeed(kLine, PL, bmwRef);
const res = analyseRun(DEFAULT_RUN, model);
const trace = res.traces.get(res.best)!;
const ownerLine = lineFromOffsets(track, ownerOffsets(track, trace.lon, trace.lat));
const mtInit = Float32Array.from(buildLine(track, corridor, clampParams({ ...PL, rider: { ...PL.rider, lineMode: 'min-time', lineDeviationM: 0 } })).offsetM);
console.error(`prep ${(performance.now() - tPrep).toFixed(0)} ms; ceiling ${ceilingG.toFixed(2)} g; λ ${LAMBDA}`);

function apexR(line: Line, fit: RiderFit, name: string): number {
  const c = fit.corners.find((x) => x.name === name);
  return c ? 1 / Math.abs(line.curvature[c.iApex]) : NaN;
}

interface Row {
  label: string;
  lapS: number;
  penS: number;
  fit: RiderFit;
  line: Line;
  ms: number;
  note: string;
}
const rows: Row[] = [];
/** Store `offsets` as the lap-time line, build it the way buildLine rides it (wander on), fit BMW v2. */
function add(label: string, offsets: Float32Array, ms: number, note = ''): Row {
  clearLapTimeLines();
  rememberLapTimeLine(track, PL, offsets, NaN);
  const line = buildLine(track, corridor, PL);
  const fit = fitRider(line, PL, bmwRef);
  const bare = lineFromOffsets(track, offsets);
  const env = solve(bare, own);
  const r: Row = { label, lapS: env.lapTimeS, penS: latGPenaltyS(bare, env, { vRefMs: vRef, ceilingG, lambda: LAMBDA }), fit, line, ms, note };
  rows.push(r);
  const g = (n: string): string => f(fit.corners.find((c) => c.name === n)?.aLatG ?? NaN);
  console.error(
    `${label}: lap ${r.lapS.toFixed(3)} s pen ${r.penS.toFixed(3)} K12 ${g('K12')}/${f(fit.corners.find((c) => c.name === 'K12')!.aLatPeakG)} K2 ${g('K2')} K4 ${g('K4')} K6 ${g('K6')} K4R ${f(apexR(line, fit, 'K4'), 0)} ${(ms / 1000).toFixed(1)} s ${note}`,
  );
  return r;
}

/** K12 kerb apex → exit on the pist centreline (κ-line: kerb peak 2058 m, exit peak 2121-2131 m). */
const K12_WIN = [2030, 2160];
/** max v_ref(s)²·|κ(s)| over the K12 window: the penalty's own measure, immune to the fit's apex re-matching. */
function k12Demand(line: Line): number {
  let m = 0;
  for (let i = 0; i < line.points.length; i++) {
    const sc = track.cumDistM[i];
    if (sc >= K12_WIN[0] && sc <= K12_WIN[1]) m = Math.max(m, (vRef[i] * vRef[i] * Math.abs(line.curvature[i])) / 9.81);
  }
  return m;
}

const saved: Record<string, number[]> = {};

if (!ONLY || ONLY === 'diag') {
  // every start to convergence, lap/objective every 4 sweeps
  for (const lam of [0, LAMBDA]) {
    for (const [label, init] of [
      ['κ-line', kInit],
      ['owner', Float32Array.from(ownerLine.offsetM)],
      ['min-time', mtInit],
    ] as const) {
      const t = performance.now();
      const o = createOptimiser(track, corridor, PL, {
        init,
        rider: 'own',
        forceInit: true,
        latG: lam > 0 ? { vRefMs: vRef, ceilingG, lambda: lam } : undefined,
      });
      const trail: string[] = [];
      let it = 0;
      while (it < 60 && !o.converged) {
        o.iterate();
        it++;
        if (it % 4 === 0) trail.push(`${it}:${o.objective.toFixed(2)}`);
      }
      const ms = performance.now() - t;
      add(`diag λ${lam} ← ${label}`, Float32Array.from(o.offsetsM), ms, `start ${o.startLapTimeS.toFixed(2)}; ${it} sweeps conv ${o.converged}; obj ${trail.join(' ')}`);
    }
  }
}

function config(label: string, o: LapTimeRunOpts): void {
  const t = performance.now();
  let last = '';
  const r = runLapTimeLine(track, corridor, PL, o, (p) => {
    const s = `${p.start}/${p.starts}`;
    if (s !== last) console.error(`  ${label}: start ${s} (${p.labels[p.start - 1]}) at ${((performance.now() - t) / 1000).toFixed(1)} s`);
    last = s;
  });
  const ms = performance.now() - t;
  const per = r.starts.map((s) => `${s.label} ${f(s.startLapTimeS)}→${f(s.lapTimeS, 3)} (obj ${f(s.objective, 3)}, ${s.sweeps} sw${s.converged ? ' conv' : ''}, ${(s.ms / 1000).toFixed(1)} s)`).join('; ');
  add(label, r.offsetsM, ms, `kept ${r.starts[r.best].label}${r.outOfBudget ? ' OUT OF BUDGET' : ''}; ${per}`);
  saved[label] = Array.from(r.offsetsM);
}

const owner = [ownerLine];
if (!ONLY || ONLY === 'configs') {
  config('single start (§8)', { latGPenalty: 0, probeSweeps: Infinity, budgetMs: Infinity });
  config('multi-start a,b', { warmStarts: owner, latGPenalty: 0 });
  config('multi-start a,b,c (probe 8)', { warmStarts: owner, minTimeStart: true, latGPenalty: 0 });
  config('multi-start a,b + penalty', { warmStarts: owner, refSpeedMs: vRef, latGPenalty: LAMBDA });
  config('multi-start a,b,c (probe 8) + penalty', { warmStarts: owner, minTimeStart: true, refSpeedMs: vRef, latGPenalty: LAMBDA });
}
if (ONLY === 'pen') config(`multi-start a,b + penalty λ ${LAMBDA}`, { warmStarts: owner, refSpeedMs: vRef, latGPenalty: LAMBDA, budgetMs: Infinity });
if (!ONLY || ONLY === 'spacing') {
  config('multi-start a,b + penalty, 10 m knots', { warmStarts: owner, refSpeedMs: vRef, latGPenalty: LAMBDA, knotSpacingM: 10, budgetMs: Infinity });
}

const save = opt('--save', '');
if (save) writeFileSync(save, JSON.stringify(saved));

const C = ['K2', 'K4', 'K6', 'K12'];
console.log(`\n# Lap-time line multi-start / lateral-g penalty, Serres pist, 1000 preset, κ 0, kerb 1.0; BMW v2 fit; ceiling ${ceilingG.toFixed(2)} g, λ ${LAMBDA} s/(g²·m)\n`);
console.log(`| | ${rows.map((r) => r.label).join(' | ')} |`);
console.log(`|---|${rows.map(() => '---').join('|')}|`);
for (const k of C) console.log(`| ${k} g (apex) | ${rows.map((r) => f(r.fit.corners.find((c) => c.name === k)?.aLatG ?? NaN)).join(' | ')} |`);
console.log(`| K12 zone peak g (exit) | ${rows.map((r) => f(r.fit.corners.find((c) => c.name === 'K12')?.aLatPeakG ?? NaN)).join(' | ')} |`);
console.log(`| K12 fit apex at centreline s, m | ${rows.map((r) => f(track.cumDistM[r.fit.corners.find((c) => c.name === 'K12')!.iApex], 0)).join(' | ')} |`);
console.log(`| K12 demand at the fixed v_ref, max over s ${K12_WIN.join('–')} m, g | ${rows.map((r) => f(k12Demand(r.line))).join(' | ')} |`);
console.log(`| K4 radius at apex, m | ${rows.map((r) => f(apexR(r.line, r.fit, 'K4'), 0)).join(' | ')} |`);
console.log(`| QSS lap (no wander), s | ${rows.map((r) => f(r.lapS, 3)).join(' | ')} |`);
console.log(`| penalty term, s | ${rows.map((r) => f(r.penS, 3)).join(' | ')} |`);
console.log(`| apexes over 1.47 g | ${rows.map((r) => r.fit.corners.filter((c) => c.aLatG > 1.47).map((c) => `${c.name} ${c.aLatG.toFixed(2)}`).join(', ') || 'none').join(' | ')} |`);
console.log(`| BMW fit lap / ref-on-line, s | ${rows.map((r) => `${f(r.fit.lapTimeS)} / ${f(r.fit.alignedRefLapS)}`).join(' | ')} |`);
console.log(`| run time (Node), s | ${rows.map((r) => f(r.ms / 1000, 1)).join(' | ')} |`);
for (const r of rows) if (r.note) console.log(`- ${r.label}: ${r.note}`);
