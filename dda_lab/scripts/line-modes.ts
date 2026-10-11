// Min-curvature against min-time racing line on Serres (pist-line note §7):
// the reference-fit rider's lateral cap per corner, the lap, and the K4
// radius, for the BMW (1000 preset) and the owner's Ducati (Panigale V4
// params) on the pist race line, κ 0 and 0.85, kerb 1.0.
//
//   cd dda_lab && npx vite-node scripts/line-modes.ts [--track serres.pist.json] [--bmw ref.json] [--run ducati.json]
import { readFileSync } from 'node:fs';
import { buildLine, minTimeTrace } from '../src/sim/line';
import { fitRider } from '../src/sim/fitRider';
import { clampParams, DEFAULT_SIM_PARAMS } from '../src/sim/presets';
import { parseReference } from '../src/sim/reference';
import { solve } from '../src/sim/solver';
import type { Line, LineMode, SimParams } from '../src/sim/types';
import type { RiderFit } from '../src/sim/fitRider';
import { DEFAULT_RUN, DEFAULT_TRACK, analyseRun, fitAndCompare, ownLine, panigaleParams } from './lib/ducatiLateral';
import { fitLine, loadPistModel } from './lib/fitLines';
import { readReferenceRows } from './lib/referenceLap';

const CORNERS = ['K2', 'K3', 'K4', 'K6', 'K8', 'K9', 'K12'];
const MODES: LineMode[] = ['min-curvature', 'min-time'];
const f = (x: number, d = 2): string => (Number.isFinite(x) ? x.toFixed(d) : '—');

/** Radius at the fit's matched apex of `name`, and the smallest within ±30 m of it, m. */
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
  fit: RiderFit;
  line: Line;
  qssLapS: number;
  buildMs: number;
  iters: string;
}

function row(label: string, line: Line, fit: RiderFit, P: SimParams, buildMs: number, iters = ''): Row {
  return { label, fit, line, qssLapS: solve(line, P).lapTimeS, buildMs, iters };
}

function table(title: string, rows: Row[], own?: { line: Line; fit: RiderFit }): void {
  console.log(`\n## ${title}\n`);
  console.log(`| | ${rows.map((r) => r.label).join(' | ')}${own ? ' | owner GPS line' : ''} |`);
  console.log(`|---|${rows.map(() => '---').join('|')}${own ? '|---' : ''}|`);
  for (const k of CORNERS) {
    const cells = rows.map((r) => f(r.fit.corners.find((c) => c.name === k)?.aLatG ?? NaN));
    const o = own ? ` | ${f(own.fit.corners.find((c) => c.name === k)?.aLatG ?? NaN)}` : '';
    console.log(`| ${k} g (apex) | ${cells.join(' | ')}${o} |`);
  }
  const r4 = (l: Line, ft: RiderFit): string => {
    const [a, m] = apexRadius(l, ft, 'K4');
    return `${f(a, 0)} / ${f(m, 0)}`;
  };
  console.log(`| K4 radius at apex / min ±30 m, m | ${rows.map((r) => r4(r.line, r.fit)).join(' | ')}${own ? ` | ${r4(own.line, own.fit)}` : ''} |`);
  console.log(`| line length, m | ${rows.map((r) => f(r.line.lengthM, 0)).join(' | ')}${own ? ` | ${f(own.line.lengthM, 0)}` : ''} |`);
  console.log(`| fit lap / ref, s | ${rows.map((r) => `${f(r.fit.lapTimeS)} / ${f(r.fit.refLapTimeS)}`).join(' | ')}${own ? ` | ${f(own.fit.lapTimeS)} / ${f(own.fit.refLapTimeS)}` : ''} |`);
  console.log(`| ref speed on this line, s | ${rows.map((r) => f(r.fit.alignedRefLapS)).join(' | ')}${own ? ` | ${f(own.fit.alignedRefLapS)}` : ''} |`);
  console.log(`| QSS lap, preset rider, s | ${rows.map((r) => f(r.qssLapS, 3)).join(' | ')}${own ? ' | ' : ''} |`);
  console.log(`| over ceiling (apex) | ${rows.map((r) => r.fit.corners.filter((c) => c.aLatG > r.fit.ceiling.aLatG + 1e-9).map((c) => c.name).join(' ') || 'none').join(' | ')}${own ? ' | ' : ''} |`);
  console.log(`| buildLine ms; min-time iterations | ${rows.map((r) => `${f(r.buildMs, 0)}; ${r.iters}`).join(' | ')}${own ? ' | ' : ''} |`);
}

{
  const argv = process.argv.slice(2);
  const opt = (name: string, d: string): string => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : d;
  };
  const model = loadPistModel(opt('--track', DEFAULT_TRACK));
  const bmwPath = opt('--bmw', '/Users/macbookmini/projects/DDA_Reader/_inbox/serres_BMW_1-19-81.json');
  const runPath = opt('--run', DEFAULT_RUN);
  console.log(`# Line modes on ${model.pkg.name} (${model.track.centerline.length} stations)`);

  // BMW: 1000 preset, the 1:19.81 reference
  const bmwRef = parseReference(JSON.parse(readFileSync(bmwPath, 'utf8')));
  const rows = readReferenceRows(bmwPath);
  const bmw: Row[] = [];
  for (const kappa of [0, 0.85]) {
    for (const mode of MODES) {
      const P0 = clampParams(DEFAULT_SIM_PARAMS);
      const P = { ...P0, tyre: { ...P0.tyre, kerbM: 1 }, rider: { ...P0.rider, kappa, lineMode: mode } };
      fitLine('race', P, rows, model, kappa, mode);
      const t0 = performance.now();
      const line = fitLine('race', P, rows, model, kappa, mode);
      const ms = performance.now() - t0;
      const tr = mode === 'min-time' ? minTimeTrace(model.track, model.corridor ?? undefined, P) : null;
      const iters = tr ? `${tr.iterations} (best ${tr.bestIteration}; p95 Δ ${tr.movedP95M.map((x) => x.toFixed(2)).join(', ')} m; QSS ${tr.lapTimesS.map((x) => x.toFixed(2)).join(', ')} s)` : '';
      bmw.push(row(`κ ${kappa} ${mode}`, line, fitRider(line, P, bmwRef), P, ms, iters));
    }
  }
  table('BMW 1:19.81 (1000 preset), pist race line, kerb 1.0', bmw);

  // Ducati: the owner's best lap, Panigale V4 params
  const res = analyseRun(runPath, model);
  const trace = res.traces.get(res.best)!;
  const ref = res.refs.get(res.best)!;
  const duc: Row[] = [];
  for (const kappa of [0, 0.85]) {
    for (const mode of MODES) {
      const P = { ...panigaleParams(1), rider: { ...panigaleParams(1).rider, kappa, lineMode: mode } };
      const t0 = performance.now();
      const line = buildLine(model.track, model.corridor ?? undefined, P);
      const ms = performance.now() - t0;
      const tr = mode === 'min-time' ? minTimeTrace(model.track, model.corridor ?? undefined, P) : null;
      const iters = tr ? `${tr.iterations} (best ${tr.bestIteration})` : '';
      const fc = fitAndCompare(`κ ${kappa} ${mode}`, line, ref, trace, res.cal, 1);
      duc.push(row(`κ ${kappa} ${mode}`, line, fc.fit, P, ms, iters));
    }
  }
  const own = ownLine(trace);
  const ownFit = fitAndCompare('own', own, ref, trace, res.cal, 1);
  table(`Ducati best lap ${res.best} (Panigale V4, μ 1.35, 59°), pist race line, kerb 1.0`, duc, { line: own, fit: ownFit.fit });
}
