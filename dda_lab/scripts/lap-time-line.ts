// Direct lap-time line on Serres (pist-line note §8): the free-trajectory
// optimiser warm-started from the min-time line and from the owner's GPS path
// mapped into the corridor, against κ 0 min-curvature / min-time, κ 0.85 and
// the owner's path. Per line: QSS laps, K4 radius, and the BMW v2 reference
// fit's lateral g at K2 … K12 (apex) and the K12 zone peak (its exit).
//
//   cd dda_lab && npx vite-node scripts/lap-time-line.ts [--iters 40] [--only quick] [--save out.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { createOptimiser } from '../src/sim/freeTrajectory';
import { LAP_TIME_ITERATIONS, lapTimeStart, rememberLapTimeLine } from '../src/sim/lapTimeLine';
import { fitRider, type RiderFit } from '../src/sim/fitRider';
import { buildLine, lineFromOffsets, minTimeTrace, offsetBounds } from '../src/sim/line';
import { clampParams, DEFAULT_SIM_PARAMS } from '../src/sim/presets';
import { parseReference } from '../src/sim/reference';
import { solve } from '../src/sim/solver';
import type { Line, LineMode, SimParams } from '../src/sim/types';
import { analyseRun, DEFAULT_RUN } from './lib/ducatiLateral';
import { loadPistModel } from './lib/fitLines';
import { ownerOffsets } from './lib/ownerOffsets';

const argv = process.argv.slice(2);
const opt = (name: string, d: string): string => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : d;
};
const ITERS = Number(opt('--iters', '40'));
const CORNERS = ['K2', 'K3', 'K4', 'K6', 'K8', 'K9', 'K12'];
const f = (x: number, d = 2): string => (Number.isFinite(x) ? x.toFixed(d) : '—');

const model = loadPistModel(new URL('../public/tracks/serres.pist.json', import.meta.url).pathname);
const { track } = model;
const corridor = model.corridor ?? undefined;
const bmwRef = parseReference(JSON.parse(readFileSync(new URL('../public/examples/serres_BMW_1-19-81_v2.json', import.meta.url), 'utf8')));

const P0 = clampParams(DEFAULT_SIM_PARAMS);
const PK = (kappa: number, lineMode: LineMode): SimParams =>
  clampParams({ ...P0, tyre: { ...P0.tyre, kerbM: 1 }, rider: { ...P0.rider, kappa, lineMode } });
const P = PK(0, 'min-time');
const ideal = clampParams({ ...P, rider: { ...P.rider, sBrake: 1, sDrive: 1, sLat: 1, rollRateFrac: 1, lineDeviationM: 0 } });
const own = clampParams({ ...P, rider: { ...P.rider, lineDeviationM: 0 } });

function apexRadius(line: Line, fit: RiderFit, name: string): [number, number] {
  const c = fit.corners.find((x) => x.name === name);
  if (!c) return [NaN, NaN];
  const s = line.cumDistM;
  let kMax = 0;
  for (let i = 0; i < s.length; i++) {
    let d = Math.abs(s[i] - s[c.iApex]);
    d = Math.min(d, line.lengthM - d);
    if (d <= 30) kMax = Math.max(kMax, Math.abs(line.curvature[i]));
  }
  return [1 / Math.abs(line.curvature[c.iApex]), 1 / kMax];
}

interface Row {
  label: string;
  line: Line;
  fit: RiderFit;
  qssOwn: number;
  qssIdeal: number;
  ms?: number;
  note?: string;
}
const rows: Row[] = [];
function add(label: string, line: Line, ms?: number, note?: string): Row {
  const r: Row = { label, line, fit: fitRider(line, P, bmwRef), qssOwn: solve(line, own).lapTimeS, qssIdeal: solve(line, ideal).lapTimeS, ms, note };
  rows.push(r);
  console.error(`${label}: own ${r.qssOwn.toFixed(3)} s ideal ${r.qssIdeal.toFixed(3)} s len ${line.lengthM.toFixed(0)} m${ms ? ` ${(ms / 1000).toFixed(1)} s` : ''} ${note ?? ''}`);
  return r;
}

const t0 = performance.now();
const mc = buildLine(track, corridor, PK(0, 'min-curvature'));
const mcMs = performance.now() - t0;
add('κ0 min-curv', mc, mcMs);
const t1 = performance.now();
const mt = buildLine(track, corridor, PK(0, 'min-time'));
add('κ0 min-time', mt, performance.now() - t1);
// exit-wide weighting (min speed over ±W m carries the apex speed into braking/exit)
for (const W of [30, 60]) {
  const tw = performance.now();
  const tr = minTimeTrace(track, corridor, PK(0, 'min-time'), 5, undefined, { speedWindowM: W });
  add(`κ0 exit-wide ±${W}`, lineFromOffsets(track, Float32Array.from(tr.offsets)), performance.now() - tw, `best iterate ${tr.bestIteration} of ${tr.iterations}; QSS ${tr.lapTimesS.map((x) => x.toFixed(2)).join(', ')}`);
}
const k85 = buildLine(track, corridor, PK(0.85, 'min-time'));
add('κ.85 min-time', k85);
add('κ.85 min-curv', buildLine(track, corridor, PK(0.85, 'min-curvature')));

// the owner's path (Ducati best lap) mapped into the corridor, raw and clamped to the box
const res = analyseRun(DEFAULT_RUN, model);
const trace = res.traces.get(res.best)!;
const ownOff = ownerOffsets(track, trace.lon, trace.lat);
const { loM, hiM } = offsetBounds(track, corridor, P);
let outside = 0;
for (let i = 0; i < ownOff.length; i++) if (ownOff[i] < loM[i] || ownOff[i] > hiM[i]) outside++;
const ownClamped = Float32Array.from(ownOff, (v, i) => Math.min(hiM[i], Math.max(loM[i], v)));
add('owner path (raw)', lineFromOffsets(track, ownOff), undefined, `${outside} of ${ownOff.length} stations outside the box`);
add('owner path (box)', lineFromOffsets(track, ownClamped));

const saved: Record<string, number[]> = { minCurv: Array.from(mc.offsetM), minTime: Array.from(mt.offsetM), owner: Array.from(ownClamped) };

if (opt('--only', '') !== 'quick') {
  for (const [label, init, rider] of [
    ['FT own ← min-time', Float32Array.from(mt.offsetM), 'own'],
    ['FT own ← owner', ownClamped, 'own'],
    ['FT own ← κ.85', Float32Array.from(k85.offsetM), 'own'],
  ] as const) {
    const t = performance.now();
    const o = createOptimiser(track, corridor, P, { init, rider });
    const startS = o.lapTimeS;
    let it = 0;
    const lapByIt: number[] = [];
    while (it < ITERS && !o.converged) {
      o.iterate();
      it++;
      lapByIt.push(o.lapTimeS);
      if (it % 5 === 0) console.error(`  ${label} it ${it}: ${o.lapTimeS.toFixed(3)} s (${((performance.now() - t) / 1000).toFixed(1)} s)`);
    }
    const ms = performance.now() - t;
    add(label, lineFromOffsets(track, Float32Array.from(o.offsetsM)), ms, `start ${startS.toFixed(3)} → ${o.lapTimeS.toFixed(3)} s, ${it} sweeps, converged ${o.converged}; laps ${lapByIt.filter((_, i) => i % 5 === 4).map((x) => x.toFixed(2)).join(' ')}`);
    saved[label] = Array.from(o.offsetsM);
  }
}

// the shipped path: lineMode 'lap-time' = lapTimeStart (fastest κ-line) + the own-rider descent,
// then buildLine reads the stored result
{
  const PL = PK(0, 'lap-time');
  const t = performance.now();
  const init = lapTimeStart(track, corridor, PL);
  const o = createOptimiser(track, corridor, PL, { init, rider: 'own' });
  let it = 0;
  while (it < LAP_TIME_ITERATIONS && !o.converged) {
    o.iterate();
    it++;
  }
  const ms = performance.now() - t;
  rememberLapTimeLine(track, PL, o.offsetsM, o.lapTimeS);
  add('lap-time (shipped)', buildLine(track, corridor, PL), ms, `start ${o.startLapTimeS.toFixed(3)} → ${o.lapTimeS.toFixed(3)} s, ${it} sweeps, converged ${o.converged}`);
  saved.lapTime = Array.from(o.offsetsM);
}

const save = opt('--save', '');
if (save) writeFileSync(save, JSON.stringify(saved));

console.log(`\n# Lap-time line, Serres pist (${track.centerline.length} stations), 1000 preset μ ${P.tyre.mu}, κ 0, kerb 1.0; BMW v2 fit\n`);
console.log(`| | ${rows.map((r) => r.label).join(' | ')} |`);
console.log(`|---|${rows.map(() => '---').join('|')}|`);
for (const k of CORNERS) console.log(`| ${k} g (apex) | ${rows.map((r) => f(r.fit.corners.find((c) => c.name === k)?.aLatG ?? NaN)).join(' | ')} |`);
console.log(`| K12 zone peak g (exit) | ${rows.map((r) => f(r.fit.corners.find((c) => c.name === 'K12')?.aLatPeakG ?? NaN)).join(' | ')} |`);
console.log(`| K4 radius apex / min ±30 m, m | ${rows.map((r) => apexRadius(r.line, r.fit, 'K4').map((x) => f(x, 0)).join(' / ')).join(' | ')} |`);
console.log(`| line length, m | ${rows.map((r) => f(r.line.lengthM, 0)).join(' | ')} |`);
console.log(`| QSS lap, preset rider, s | ${rows.map((r) => f(r.qssOwn, 3)).join(' | ')} |`);
console.log(`| QSS lap, ideal rider, s | ${rows.map((r) => f(r.qssIdeal, 3)).join(' | ')} |`);
console.log(`| BMW fit lap / ref-on-line, s | ${rows.map((r) => `${f(r.fit.lapTimeS)} / ${f(r.fit.alignedRefLapS)}`).join(' | ')} |`);
console.log(`| over 1.47 g (apex) | ${rows.map((r) => r.fit.corners.filter((c) => c.aLatG > 1.47).map((c) => c.name).join(' ') || 'none').join(' | ')} |`);
console.log(`| fit converged | ${rows.map((r) => `${r.fit.converged} (${r.fit.iterations})`).join(' | ')} |`);
console.log(`| build time, s | ${rows.map((r) => (r.ms ? f(r.ms / 1000, 2) : '')).join(' | ')} |`);
for (const r of rows) if (r.note) console.log(`- ${r.label}: ${r.note}`);
