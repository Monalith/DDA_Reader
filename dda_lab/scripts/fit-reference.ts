// Reference-fit rider report: fit the per-corner rider (src/sim/fitRider.ts)
// to the BMW and R6 Serres laps and print one Markdown table per lap.
//
//   cd dda_lab && npx vite-node scripts/fit-reference.ts [reference.json ...]
//
// Same setup as scripts/sim-validate.ts: the Serres track from the file's own
// lat/lon, no corridor, `DEFAULT_SIM_PARAMS` (1000 preset, μ 1.40). Env:
// FIT_ITER overrides the iteration cap.
import { readFileSync } from 'node:fs';
import { fitRider, type RiderFit } from '../src/sim/fitRider';
import { buildLine } from '../src/sim/line';
import { clampParams, DEFAULT_SIM_PARAMS } from '../src/sim/presets';
import { parseReference } from '../src/sim/reference';
import { readReferenceRows, serresTrack } from './lib/referenceLap';

const INBOX = '/Users/macbookmini/projects/DDA_Reader/_inbox';
const DEFAULT_FILES = [`${INBOX}/serres_BMW_1-19-81.json`, `${INBOX}/serres_R6_1-19-849.json`];

const f = (x: number | null | undefined, d = 1): string => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(d));
const sg = (x: number, d = 1): string => `${x >= 0 ? '+' : ''}${x.toFixed(d)}`;
const deg = (g: number): number => (Math.atan(g) * 180) / Math.PI;

export function fitFile(path: string, maxIter?: number): RiderFit {
  const ref = parseReference(JSON.parse(readFileSync(path, 'utf8')));
  const P = clampParams(DEFAULT_SIM_PARAMS);
  const line = buildLine(serresTrack(readReferenceRows(path)), undefined, P);
  return fitRider(line, P, ref, maxIter === undefined ? {} : { maxIter });
}

export function fitTable(fit: RiderFit): string {
  const ceil = fit.ceiling;
  const rows: string[] = [];
  rows.push(
    '| corner | apex ref | apex sim | Δ km/h | zone t ref | zone t sim | Δ s | ref speed on line, s | aLat g (apex) | zone peak g | lean ° (apex) | ceiling ° | margin % (apex / peak) | brake g | drive g | run g | brake pt ref / sim, m | apex set by |',
  );
  rows.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const c of fit.corners) {
    const dv = (c.vApexMs - c.vApexRefMs) * 3.6;
    const dt = c.zoneTimeSimS - c.zoneTimeRefS;
    const mA = (100 * (ceil.aLatG - c.aLatG)) / ceil.aLatG;
    const mP = (100 * (ceil.aLatG - c.aLatPeakG)) / ceil.aLatG;
    rows.push(
      `| ${c.name} ${c.dir > 0 ? 'L' : 'R'} | ${f(c.vApexRefMs * 3.6)} | ${f(c.vApexMs * 3.6)} | ${sg(dv)} | ${f(c.zoneTimeRefS, 2)} | ${f(c.zoneTimeSimS, 2)} | ${sg(dt, 2)} | ${f(c.zoneTimeRefOnLineS, 2)} | ${f(c.aLatG, 2)} | ${f(c.aLatPeakG, 2)} | ${f(deg(c.aLatG))} | ${f(ceil.leanDeg)} | ${sg(mA, 0)} / ${sg(mP, 0)} | ${f(c.brakeG, 2)} | ${f(c.driveG, 2)} | ${f(c.runG, 2)} | ${f(c.brakeStartM, 0)} / ${f(c.simBrakeStartM, 0)} | ${c.binding} |`,
    );
  }
  const r = fit.residuals;
  const absDv = r.apexKmh.map(Math.abs);
  const absDt = r.zoneTimeS.map(Math.abs);
  rows.push('');
  rows.push(
    `Lap: reference ${f(fit.refLapTimeS, 2)} s, fit ${f(fit.lapTimeS, 2)} s (${sg(r.lapS, 2)} s); the reference speed integrated over this line: ${f(fit.alignedRefLapS, 2)} s. ` +
      `Apex |Δ| max ${f(Math.max(...absDv))} km/h, mean ${f(absDv.reduce((a, b) => a + b, 0) / absDv.length, 2)}; zone |Δt| max ${f(Math.max(...absDt), 2)} s. ` +
      `${fit.iterations} iterations, ${fit.converged ? 'converged' : 'NOT converged'}. ` +
      `Ceiling (1000 preset): ${f(ceil.aLatG, 2)} g = ${f(ceil.leanDeg)}°. ` +
      `Alignment: ${fit.alignment.method}; apex shift vs uniform scale |mean| ${f(fit.alignment.residual.meanAbsM)} m, max ${f(fit.alignment.residual.maxAbsM)} m.`,
  );
  if (fit.notes.length) rows.push('', ...fit.notes.map((n) => `- ${n}`));
  return rows.join('\n');
}

{
  const files = process.argv.slice(2).filter((a) => a.endsWith('.json'));
  if (!files.length) files.push(...DEFAULT_FILES);
  const it = process.env.FIT_ITER ? Number(process.env.FIT_ITER) : undefined;
  for (const path of files) {
    const fit = fitFile(path, it);
    console.log(`\n## Fit: ${fit.reference} (${path.split('/').pop()})\n`);
    console.log(fitTable(fit));
  }
}
