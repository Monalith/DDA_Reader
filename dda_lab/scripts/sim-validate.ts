// Validation harness, spec v2 §4(b): the simulator against the BMW and R6
// Serres laps, corner by corner.
//
//   cd dda_lab && npx vite-node scripts/sim-validate.ts [reference.json ...]
//
// Defaults to the two reference files in the repository's `_inbox/`. For each
// file: build the Serres track from the file's own lat/lon (as
// `tests/unit/simSerres.test.ts` does; no corridor), run `simulate()` at
// `DEFAULT_SIM_PARAMS`, put both laps on a 1 m grid and measure them with the
// SAME functions (`scripts/lib/cornerMetrics.ts`). Prints the metric table
// (metric | real | sim | target | PASS/FAIL) and a per-corner table, both as
// Markdown. Exit code 1 if any gated metric fails.
//
// The script runs whatever `simulate()` is in the tree: before the v2 merge
// that is the v1 per-sample rider, and its numbers are the BASELINE recorded
// in docs/superpowers/notes/2026-10-11-validation-baseline.md.
import { simulate } from '../src/sim/index';
import { G, lossDecelMs2 } from '../src/sim/solver';
import { clampParams, DEFAULT_SIM_PARAMS, presetById } from '../src/sim/presets';
import type { SimParams } from '../src/sim/types';
import { cornerMetrics, median, rollOn, throttlePickUp, type CornerMetrics } from './lib/cornerMetrics';
import {
  brakeApplications,
  readReferenceRows,
  referenceKind,
  referenceTrace,
  serresTrack,
  sessionTrace,
  type DistTrace,
} from './lib/referenceLap';

const INBOX = '/Users/macbookmini/projects/DDA_Reader/_inbox';
const DEFAULT_FILES = [`${INBOX}/serres_BMW_1-19-81.json`, `${INBOX}/serres_R6_1-19-849.json`];

/** Spec v2 §4(b) targets. */
const TARGET = {
  lapErrS: 0.5,
  brakeEvents: [7, 14] as const,
  minSpeedRmseKmh: 5,
  buildS: [0.3, 0.5] as const,
  longGp25: [-0.8, -0.6] as const,
  pickRollTolS: 0.3,
};

/** Position match window for corner apexes, fraction of the lap. */
const MATCH_FRAC = 0.02;

interface Row {
  metric: string;
  real: string;
  sim: string;
  target: string;
  verdict: 'PASS' | 'FAIL' | 'info';
}

const f = (x: number, d = 2): string => (Number.isFinite(x) ? x.toFixed(d) : '—');
const inRange = (x: number, [a, b]: readonly [number, number]): boolean => x >= a && x <= b;

/** Throttle pick-up and roll-on, median over the braked corners. */
function throttleTiming(tr: DistTrace, m: CornerMetrics): { pick: number; roll: number; nPick: number; nRoll: number } {
  if (!tr.tps) return { pick: Number.NaN, roll: Number.NaN, nPick: 0, nRoll: 0 };
  const picks: number[] = [];
  const rolls: number[] = [];
  m.corners.forEach((c, k) => {
    const p = throttlePickUp(tr.tS, tr.tps!, c.iA);
    if (!p) return;
    picks.push(p.tPickS);
    const next = m.corners[k + 1];
    const r = rollOn(tr.tS, tr.tps!, p.iP, next ? next.iA : tr.tS.length - 1);
    if (r) rolls.push(r.rollOnS);
  });
  return { pick: median(picks), roll: median(rolls), nPick: picks.length, nRoll: rolls.length };
}

interface Match {
  realSM: number;
  realKmh: number;
  simSM?: number;
  simKmh?: number;
}

/** Pair each real apex with the nearest unused sim apex by lap fraction. */
function matchCorners(real: CornerMetrics, realLen: number, sim: CornerMetrics, simLen: number): Match[] {
  const used = new Set<number>();
  return real.minSpeeds.map((r) => {
    let best = -1;
    let bestD = MATCH_FRAC;
    sim.minSpeeds.forEach((s, k) => {
      const d = Math.abs(s.sM / simLen - r.sM / realLen);
      if (!used.has(k) && d <= bestD) {
        bestD = d;
        best = k;
      }
    });
    if (best < 0) return { realSM: r.sM, realKmh: r.kmh };
    used.add(best);
    return { realSM: r.sM, realKmh: r.kmh, simSM: sim.minSpeeds[best].sM, simKmh: sim.minSpeeds[best].kmh };
  });
}

export function validate(
  path: string,
  params: SimParams = DEFAULT_SIM_PARAMS,
): { rows: Row[]; matches: Match[]; title: string } {
  const kind = referenceKind(path);
  const rows = readReferenceRows(path);
  const real = referenceTrace(rows, kind);
  const realMachine = presetById(kind === 'R6' ? '600' : '1000').machine;

  const P = clampParams(params);
  const res = simulate(serresTrack(rows), undefined, P, 'sim', 'Sim', '#888');
  const sim = sessionTrace(res.session, res.lapTimeS);

  const realM = cornerMetrics(real.speedKmh, real.sM, real.longG, {
    tS: real.tS,
    lossG: (v) => lossDecelMs2(realMachine, v) / G,
  });
  const simM = cornerMetrics(sim.speedKmh, sim.sM, sim.longG, {
    tS: sim.tS,
    lossG: (v) => lossDecelMs2(P.machine, v) / G,
  });

  const out: Row[] = [];
  const lapErr = sim.lapTimeS - real.lapTimeS;
  out.push({
    metric: 'lap time, s (error)',
    real: f(real.lapTimeS),
    sim: `${f(sim.lapTimeS)} (${lapErr >= 0 ? '+' : ''}${f(lapErr)})`,
    target: `|err| ≤ ${TARGET.lapErrS}`,
    verdict: Math.abs(lapErr) <= TARGET.lapErrS ? 'PASS' : 'FAIL',
  });
  out.push({
    metric: 'braked corner sections (speed + tyre g)',
    real: String(realM.brakeEvents),
    sim: String(simM.brakeEvents),
    target: `${TARGET.brakeEvents[0]}-${TARGET.brakeEvents[1]}`,
    verdict: inRange(simM.brakeEvents, TARGET.brakeEvents) ? 'PASS' : 'FAIL',
  });
  const apps = sim.brake ? brakeApplications(sim.brake) : Number.NaN;
  out.push({
    metric: 'brake applications (sim `brake` ≥ 5 %)',
    real: '—',
    sim: String(apps),
    target: `${TARGET.brakeEvents[0]}-${TARGET.brakeEvents[1]}`,
    verdict: inRange(apps, TARGET.brakeEvents) ? 'PASS' : 'FAIL',
  });
  const matches = matchCorners(realM, real.lengthM, simM, sim.lengthM);
  const paired = matches.filter((m) => m.simKmh !== undefined);
  const rmse = Math.sqrt(paired.reduce((s, m) => s + (m.simKmh! - m.realKmh) ** 2, 0) / Math.max(1, paired.length));
  const bias = paired.reduce((s, m) => s + (m.simKmh! - m.realKmh), 0) / Math.max(1, paired.length);
  out.push({
    metric: `corner min-speed RMSE, km/h (${paired.length}/${matches.length} matched; bias)`,
    real: '—',
    sim: `${f(rmse, 1)} (${bias >= 0 ? '+' : ''}${f(bias, 1)})`,
    target: `≤ ${TARGET.minSpeedRmseKmh}`,
    verdict: paired.length && rmse <= TARGET.minSpeedRmseKmh ? 'PASS' : 'FAIL',
  });
  const realBuild = median(realM.buildTimesS);
  const simBuild = median(simM.buildTimesS);
  out.push({
    metric: 'brake build −0.1 g → 90 % peak, s (median)',
    real: f(realBuild),
    sim: f(simBuild),
    target: `${TARGET.buildS[0]}-${TARGET.buildS[1]}`,
    verdict: inRange(simBuild, TARGET.buildS) ? 'PASS' : 'FAIL',
  });
  out.push({
    metric: 'brake build rate 10-90 %, g/s (median)',
    real: f(median(realM.buildRatesGps), 1),
    sim: f(median(simM.buildRatesGps), 1),
    target: '—',
    verdict: 'info',
  });
  out.push({
    metric: 'tyre brake peak, g (median / deepest)',
    real: `${f(median(realM.brakePeaksG))} / ${f(Math.min(...realM.brakePeaksG))}`,
    sim: `${f(median(simM.brakePeaksG))} / ${f(Math.min(...simM.brakePeaksG))}`,
    target: '—',
    verdict: 'info',
  });
  out.push({
    metric: 'long_g p25 (braking samples), g',
    real: f(realM.longGp25),
    sim: f(simM.longGp25),
    target: '−0.70 ± 0.10',
    verdict: inRange(simM.longGp25, TARGET.longGp25) ? 'PASS' : 'FAIL',
  });
  const rt = throttleTiming(real, realM);
  const st = throttleTiming(sim, simM);
  const gated = kind === 'R6';
  const near = (a: number, b: number): boolean => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= TARGET.pickRollTolS;
  out.push({
    metric: `t_pick (tps > 10 % held 0.3 s) − t_apex, s (median; n real/sim)`,
    real: rt.nPick ? `${f(rt.pick)} (${rt.nPick})` : 'no tps',
    sim: `${f(st.pick)} (${st.nPick})`,
    target: gated ? `real ± ${TARGET.pickRollTolS}` : '—',
    verdict: gated ? (near(st.pick, rt.pick) ? 'PASS' : 'FAIL') : 'info',
  });
  out.push({
    metric: `roll-on tps 20 → 90 %, s (median; n real/sim)`,
    real: rt.nRoll ? `${f(rt.roll)} (${rt.nRoll})` : 'no tps',
    sim: `${f(st.roll)} (${st.nRoll})`,
    target: gated ? `real ± ${TARGET.pickRollTolS}` : '—',
    verdict: gated ? (near(st.roll, rt.roll) ? 'PASS' : 'FAIL') : 'info',
  });
  return { rows: out, matches, title: `${kind} — ${path.split('/').pop()}` };
}

function main(): void {
  const files = process.argv.slice(2).filter((a) => a.endsWith('.json'));
  let failed = 0;
  console.log(`# sim-validate — simulate() at DEFAULT_SIM_PARAMS (${DEFAULT_SIM_PARAMS.machine.presetId} preset), no corridor\n`);
  for (const path of files.length ? files : DEFAULT_FILES) {
    const { rows, matches, title } = validate(path);
    console.log(`## ${title}\n`);
    console.log('| metric | real | sim | target | verdict |');
    console.log('|---|---|---|---|---|');
    for (const r of rows) console.log(`| ${r.metric} | ${r.real} | ${r.sim} | ${r.target} | ${r.verdict} |`);
    console.log('\n| real apex s, m | real min km/h | sim apex s, m | sim min km/h | Δ km/h |');
    console.log('|---|---|---|---|---|');
    for (const m of matches) {
      const d = m.simKmh !== undefined ? m.simKmh - m.realKmh : Number.NaN;
      console.log(`| ${f(m.realSM, 0)} | ${f(m.realKmh, 1)} | ${m.simSM !== undefined ? f(m.simSM, 0) : 'unmatched'} | ${m.simKmh !== undefined ? f(m.simKmh, 1) : '—'} | ${Number.isFinite(d) ? (d >= 0 ? '+' : '') + f(d, 1) : '—'} |`);
    }
    console.log('');
    failed += rows.filter((r) => r.verdict === 'FAIL').length;
  }
  console.log(failed ? `${failed} gated metric(s) FAIL` : 'all gated metrics PASS');
  process.exitCode = failed ? 1 : 0;
}

// run as a script only; `validate()` is importable by the calibration sweep
// vite-node strips the script path from argv, so the sweep that imports
// validate() opts out with an env flag instead
if (!process.env.SIM_VALIDATE_LIB) main();
