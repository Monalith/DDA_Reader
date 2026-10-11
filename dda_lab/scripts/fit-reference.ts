// Reference-fit rider report: fit the per-corner rider (src/sim/fitRider.ts)
// to the BMW and R6 Serres laps and print one Markdown table per lap.
//
//   cd dda_lab && npx vite-node scripts/fit-reference.ts [reference.json ...]
//        [--track serres.pist.json] [--line map|centre|race] [--kappa 0..1] [--compare]
//
// Default (no --track): the Serres track from the file's own lat/lon, no
// corridor, `DEFAULT_SIM_PARAMS` (1000 preset, μ 1.40) — the map line. With
// --track the default line is `race` (the rider's line inside the track
// model's corridor, the preset's κ); `--line centre` rides the track model's
// centreline itself. `--compare` fits every line (map, centre, race at the
// preset's κ, κ = 0 minimum curvature, κ = 1 minimum distance) and prints a
// compact comparison. Env: FIT_ITER overrides the iteration cap.
import { readFileSync } from 'node:fs';
import { fitRider, type RiderFit } from '../src/sim/fitRider';
import { G } from '../src/sim/solver';
import type { Line } from '../src/sim/types';
import { clampParams, DEFAULT_SIM_PARAMS } from '../src/sim/presets';
import { parseReference } from '../src/sim/reference';
import { fitLine, loadPistModel, type LineKind, type PistModel } from './lib/fitLines';
import { readReferenceRows } from './lib/referenceLap';

const INBOX = '/Users/macbookmini/projects/DDA_Reader/_inbox';
const DEFAULT_FILES = [`${INBOX}/serres_BMW_1-19-81.json`, `${INBOX}/serres_R6_1-19-849.json`];

const f = (x: number | null | undefined, d = 1): string => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(d));
const sg = (x: number, d = 1): string => `${x >= 0 ? '+' : ''}${x.toFixed(d)}`;
const deg = (g: number): number => (Math.atan(g) * 180) / Math.PI;

export interface FitRun {
  fit: RiderFit;
  line: Line;
  lineLengthM: number;
  label: string;
}

/** Reference position tolerance for `shiftedApexG`, metres (the file's stated ±15-20 m). */
export const REF_POS_TOL_M = 20;

/**
 * Lateral g at each matched apex if the reference were shifted by up to
 * ±tol metres along the line: |κ(apex)|·min(v_ref over ±tol)²/g. The κ peak
 * is the line's (fixed); only the reference's position is uncertain, so this
 * is the best case the reference's own position error allows.
 */
export function shiftedApexG(run: FitRun, tolM = REF_POS_TOL_M): number[] {
  const { line, fit } = run;
  const v = fit.alignment.vRefMs;
  const s = line.cumDistM;
  const L = line.lengthM;
  return fit.corners.map((c) => {
    let vmin = Infinity;
    for (let j = 0; j < s.length; j++) {
      let d = Math.abs(s[j] - s[c.iApex]);
      d = Math.min(d, L - d);
      if (d <= tolM) vmin = Math.min(vmin, v[j]);
    }
    return (vmin * vmin * Math.abs(line.curvature[c.iApex])) / G;
  });
}

export function fitFile(path: string, maxIter?: number, kind: LineKind = 'map', model?: PistModel, kappa?: number): FitRun {
  const ref = parseReference(JSON.parse(readFileSync(path, 'utf8')));
  const P = clampParams(DEFAULT_SIM_PARAMS);
  const line = fitLine(kind, P, readReferenceRows(path), model, kappa);
  const k = kappa ?? P.rider.kappa;
  const label = kind === 'race' ? `race κ ${k.toFixed(2)}` : kind === 'map' ? `map (κ ${k.toFixed(2)}, 5 m)` : 'pist centreline';
  return { fit: fitRider(line, P, ref, maxIter === undefined ? {} : { maxIter }), line, lineLengthM: line.lengthM, label };
}

/** Corners whose fitted lateral cap (apex / zone peak) is above `ceil·tol`. */
export function overCeiling(fit: RiderFit, tol = 1): { apex: string[]; peak: string[] } {
  const c = fit.ceiling.aLatG * tol + 1e-9;
  return {
    apex: fit.corners.filter((x) => x.aLatG > c).map((x) => x.name),
    peak: fit.corners.filter((x) => x.aLatPeakG > c).map((x) => x.name),
  };
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
  const oc = overCeiling(fit);
  rows.push('');
  rows.push(
    `Lap: reference ${f(fit.refLapTimeS, 2)} s, fit ${f(fit.lapTimeS, 2)} s (${sg(r.lapS, 2)} s); the reference speed integrated over this line: ${f(fit.alignedRefLapS, 2)} s. ` +
      `Apex |Δ| max ${f(Math.max(...absDv))} km/h, mean ${f(absDv.reduce((a, b) => a + b, 0) / absDv.length, 2)}; zone |Δt| max ${f(Math.max(...absDt), 2)} s. ` +
      `${fit.iterations} iterations, ${fit.converged ? 'converged' : 'NOT converged'}. ` +
      `Ceiling (1000 preset): ${f(ceil.aLatG, 2)} g = ${f(ceil.leanDeg)}°; over it at the apex ${oc.apex.length}, anywhere in the zone ${oc.peak.length} of ${fit.corners.length} corners. ` +
      `Alignment: ${fit.alignment.method}; apex shift vs uniform scale |mean| ${f(fit.alignment.residual.meanAbsM)} m, max ${f(fit.alignment.residual.maxAbsM)} m.`,
  );
  if (fit.notes.length) rows.push('', ...fit.notes.map((n) => `- ${n}`));
  return rows.join('\n');
}

/** Compact multi-line comparison: per corner apex ref / sim and the apex / zone-peak lateral g on every line. */
export function compareTable(runs: FitRun[]): string {
  const out: string[] = [];
  const head = runs.map((r) => r.label);
  out.push(`| corner | apex ref km/h | ${head.map((h) => `${h}: apex sim / Δ zone t vs ref-on-line / g apex / g peak`).join(' | ')} |`);
  out.push(`|---|---|${head.map(() => '---').join('|')}|`);
  const base = runs[0].fit;
  base.corners.forEach((c, k) => {
    const cells = runs.map(({ fit }) => {
      const x = fit.corners[k];
      const ceil = fit.ceiling.aLatG;
      const mark = (g: number): string => (g > ceil * 1.05 ? `**${f(g, 2)}**` : g > ceil ? `*${f(g, 2)}*` : f(g, 2));
      return `${f(x.vApexMs * 3.6)} / ${sg(x.zoneTimeSimS - x.zoneTimeRefOnLineS, 2)} / ${mark(x.aLatG)} / ${mark(x.aLatPeakG)}`;
    });
    out.push(`| ${c.name} ${c.dir > 0 ? 'L' : 'R'} | ${f(c.vApexRefMs * 3.6)} | ${cells.join(' | ')} |`);
  });
  const row = (name: string, g: (r: FitRun) => string): void => {
    out.push(`| ${name} | | ${runs.map(g).join(' | ')} |`);
  };
  row('line length, m', (r) => f(r.lineLengthM, 0));
  row('lap fit / ref, s', (r) => `${f(r.fit.lapTimeS, 2)} / ${f(r.fit.refLapTimeS, 2)}`);
  row('ref speed on this line, s', (r) => f(r.fit.alignedRefLapS, 2));
  row('fit − ref-on-line, s', (r) => sg(r.fit.lapTimeS - r.fit.alignedRefLapS, 2));
  row('max apex |Δ| km/h', (r) => f(Math.max(...r.fit.residuals.apexKmh.map(Math.abs))));
  row('over 1.40 g apex / peak', (r) => {
    const o = overCeiling(r.fit);
    return `${o.apex.length} / ${o.peak.length}`;
  });
  row('over 1.47 g (×1.05) apex / peak', (r) => {
    const o = overCeiling(r.fit, 1.05);
    return `${o.apex.length} / ${o.peak.length}`;
  });
  row(`over 1.40 / 1.47 g with the reference shifted ≤ ${REF_POS_TOL_M} m (apex)`, (r) => {
    const g = shiftedApexG(r);
    const c = r.fit.ceiling.aLatG;
    return `${g.filter((x) => x > c).length} / ${g.filter((x) => x > c * 1.05).length}`;
  });
  row('apex shift mean / max, m', (r) => `${f(r.fit.alignment.residual.meanAbsM)} / ${f(r.fit.alignment.residual.maxAbsM)}`);
  out.push('');
  out.push('Cells: fitted apex km/h / zone time minus the reference speed ridden over the same zone of this line, s / fitted lateral cap at the apex, g / largest cap in the zone, g. *italic* > 1.40 g ceiling, **bold** > 1.47 g (ceiling × 1.05).');
  out.push('');
  out.push(`Apex lateral g if the reference sits up to ±${REF_POS_TOL_M} m off along the line (|κ_apex|·min v_ref(±${REF_POS_TOL_M} m)²/g):`);
  out.push('');
  out.push(`| corner | ${head.join(' | ')} |`);
  out.push(`|---|${head.map(() => '---').join('|')}|`);
  const sh = runs.map((r) => shiftedApexG(r));
  base.corners.forEach((c, k) => {
    const ceil = base.ceiling.aLatG;
    const mark = (g: number): string => (g > ceil * 1.05 ? `**${f(g, 2)}**` : g > ceil ? `*${f(g, 2)}*` : f(g, 2));
    out.push(`| ${c.name} ${c.dir > 0 ? 'L' : 'R'} | ${sh.map((x) => mark(x[k])).join(' | ')} |`);
  });
  out.push('');
  for (const r of runs) {
    const o = overCeiling(r.fit);
    out.push(`- ${r.label}: over the ceiling at the apex ${o.apex.join(', ') || 'none'}; in the zone ${o.peak.join(', ') || 'none'}. Notes: ${r.fit.notes.filter((n) => !n.startsWith('over the lateral')).join(' · ')}`);
  }
  return out.join('\n');
}

{
  const argv = process.argv.slice(2);
  const opt = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const trackPath = opt('--track');
  const lineArg = opt('--line');
  const kappaArg = opt('--kappa');
  const compare = argv.includes('--compare');
  const optVals = new Set([trackPath, lineArg, kappaArg].filter(Boolean));
  const files = argv.filter((a) => a.endsWith('.json') && !a.endsWith('.pist.json') && !optVals.has(a));
  if (!files.length) files.push(...DEFAULT_FILES);
  const it = process.env.FIT_ITER ? Number(process.env.FIT_ITER) : undefined;
  const model = trackPath ? loadPistModel(trackPath) : undefined;
  if (lineArg && !['map', 'centre', 'center', 'race'].includes(lineArg)) throw new Error(`--line ${lineArg}: map | centre | race`);
  const kind: LineKind = lineArg === 'center' ? 'centre' : ((lineArg as LineKind | undefined) ?? (model ? 'race' : 'map'));
  const kappa = kappaArg === undefined ? undefined : Number(kappaArg);
  if (model) {
    const pct = model.corridor ? Math.round((100 * model.corridor.known.filter(Boolean).length) / model.corridor.known.length) : 0;
    console.log(`Track model "${model.pkg.name}": ${(model.track.lengthM / 1000).toFixed(3)} km, ${model.pkg.corners.length} corners, corridor ${pct} % resolved, gate ${model.pkg.startFinish ? model.pkg.startFinish.at.map((x) => x.toFixed(6)).join(', ') : '—'}`);
  }
  for (const path of files) {
    if (compare) {
      if (!model) throw new Error('--compare needs --track file.pist.json');
      const runs = [
        fitFile(path, it, 'map'),
        fitFile(path, it, 'centre', model),
        fitFile(path, it, 'race', model),
        fitFile(path, it, 'race', model, 0),
        fitFile(path, it, 'race', model, 1),
      ];
      console.log(`\n## Compare: ${runs[0].fit.reference} (${path.split('/').pop()})\n`);
      console.log(compareTable(runs));
      if (argv.includes('--full')) {
        for (const r of runs) {
          console.log(`\n### ${r.fit.reference} on ${r.label}\n`);
          console.log(fitTable(r.fit));
        }
      }
      continue;
    }
    const r = fitFile(path, it, kind, model, kappa);
    console.log(`\n## Fit: ${r.fit.reference} (${path.split('/').pop()}) on ${r.label}, line ${r.lineLengthM.toFixed(0)} m\n`);
    console.log(fitTable(r.fit));
  }
}
