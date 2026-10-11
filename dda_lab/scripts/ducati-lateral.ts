// Measured lateral g of the owner's Ducati laps against the reference-fit
// rider (docs/superpowers/notes/2026-10-11-ducati-lateral-g.md).
//
//   cd dda_lab && npx vite-node scripts/ducati-lateral.ts [run.json] [--track serres.pist.json] [--json out.json]
//
// Prints:
//   0. the channel identity check (accel_lat_g vs tan(lean) vs v²κ/g from the GPS line);
//   1. per corner, best lap and the median over the kept (flying) laps: apex
//      speed, v²κ/g at the lap's own apex, tan(lean) at the zone's peak lean,
//      the peak lean, and where the GPS line sits in the pist corridor;
//   2. the reference fit on the owner's best lap (Panigale V4 preset, μ 1.35,
//      maxLean 59°) on the pist race line, κ 0 and κ 0.85, kerb 1.0: fitted
//      lateral cap per corner against the measured one;
//   3. the fitted envelope's latG / lean channels against the measured lean over the lap.
import { writeFileSync } from 'node:fs';
import { CURV_SCALE_M, DEFAULT_RUN, DEFAULT_TRACK, analyseRun, curvatureScaleSweep, f, fitAndCompare, fitOnPist, median, ownLine, rmse, sg, type MeasuredCorner } from './lib/ducatiLateral';
import { loadPistModel } from './lib/fitLines';

{
  const argv = process.argv.slice(2);
  const opt = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const trackPath = opt('--track') ?? DEFAULT_TRACK;
  const jsonOut = opt('--json');
  const runPath = argv.find((a) => a.endsWith('.json') && !a.endsWith('.pist.json') && a !== jsonOut) ?? DEFAULT_RUN;
  const model = loadPistModel(trackPath);
  const res = analyseRun(runPath, model);
  const { gs, kept, best, channels: ch } = res;
  const bt = res.traces.get(best)!;
  const bm = res.measured.get(best)!;
  const ref = res.refs.get(best)!;
  const cal = res.cal;
  console.log(`# Ducati lateral g (${runPath.split('/').pop()}, track ${model.pkg.name} ${model.pkg.lengthM.toFixed(0)} m)\n`);
  console.log(
    `Ground speed: GPS lag ${gs.lagS.toFixed(2)} s; wheel/ground = ${gs.a.toFixed(4)} + ${gs.b.toFixed(4)}·(1 − cos φ) (n ${gs.n}, rms ${gs.rms.toFixed(4)}). ` +
      `Kept laps ${kept.join(', ')}; best ${best} (${bt.lapTimeS.toFixed(1)} s, GPS ${bt.lengthM.toFixed(0)} m, speed rescale ×${bt.speedScale.toFixed(4)}). ` +
      `GPS lap length, kept laps: ${kept.map((l) => res.traces.get(l)!.lengthM.toFixed(0)).join(' / ')} m (median ${median(kept.map((l) => res.traces.get(l)!.lengthM)).toFixed(0)}); pist centreline ${model.pkg.lengthM.toFixed(0)} m.\n`,
  );
  console.log('## 0. Channel identity (best lap, per 10 Hz record)\n');
  console.log('| quantity | value |\n|---|---|');
  const rows: Array<[string, string]> = [
    ['records', String(ch.n)],
    ['max abs(accel_lat_g − tan(lean))', f(ch.accelLatVsTanLeanMaxAbs, 4)],
    ['corr(accel_lat_g, tan lean)', f(ch.corrAccelLatTanLean, 4)],
    ['corr(v²κ/g GPS, tan lean), all / cornering (abs tan φ > 0.3)', `${f(ch.corrGpsTanLean, 3)} / ${f(ch.corrGpsTanLeanCornering, 3)}`],
    ['peak / p99 abs v²κ/g (GPS line, ground speed, κ over 20 m)', `${f(ch.peakGpsG)} / ${f(ch.p99GpsG)}`],
    ['peak / p99 tan abs(lean)', `${f(ch.peakTanLeanG)} / ${f(ch.p99TanLeanG)}`],
    ['peak abs accel_lat_g', f(ch.peakAccelLatG)],
    ['(v_dash / v_ground)² in corners, median', f(ch.dashOverGround, 3)],
    ['IMU lean on straights (abs κ < 1/1500, v > 144 km/h), signed mean, deg', f(ch.imuZeroDeg, 2)],
    ['zero b fitted so tan abs(φ − b) ≈ abs v²κ/g, deg', f(ch.fitZeroDeg, 2)],
    ['two-parameter fit tan(abs(φ − b) − c) ≈ abs v²κ/g: b / c, deg; rms after, g', `${f(ch.fit2ZeroDeg, 1)} / ${f(ch.fit2ExcessDeg, 1)}; ${f(ch.fit2Rms, 3)}`],
    ['median tan abs φ − abs v²κ/g, left / right corners, raw', `${sg(ch.leftRaw)} / ${sg(ch.rightRaw)}`],
    ['same with the straight-line zero removed', `${sg(ch.leftZ)} / ${sg(ch.rightZ)}`],
    ['rms(abs v²κ/g − tan abs φ), raw / zero removed, g (cornering)', `${f(ch.rmsRaw, 3)} / ${f(ch.rmsZ, 3)}`],
    ['LS slope abs v²κ/g on tan abs(φ − zero)', f(ch.slopeZ, 3)],
    ...ch.windows.map((w) => [`κ window ${w.windowM} m: p99 abs v²κ/g / slope / corr`, `${f(w.p99G)} / ${f(w.slope, 3)} / ${f(w.corr, 3)}`] as [string, string]),
    ['sign: lean vs κ', ch.leanSignVsKappa > 0 ? 'same (left +)' : 'opposite (left −)'],
  ];
  for (const [a, b] of rows) console.log(`| ${a} | ${b} |`);

  console.log('\n## 1. Per corner (best lap / median of kept laps)\n');
  console.log('| corner | apex v km/h | g v²κ apex | g v²κ zone max | tan(lean max) raw | calibrated lean g | lean max °, raw | apex: inside offset m / inner half-width m (frac; median) | entry / exit: outside frac (median) |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  bm.forEach((c, k) => {
    const all = kept.map((l) => res.measured.get(l)![k]);
    const med = (g: (x: MeasuredCorner) => number): number => median(all.map(g));
    console.log(
      `| ${c.name} ${c.dir > 0 ? 'L' : 'R'} | ${f(c.vMinKmh, 1)} / ${f(med((x) => x.vMinKmh), 1)} | ${f(c.gGpsApex)} / ${f(med((x) => x.gGpsApex))} | ${f(c.gGpsMax)} / ${f(med((x) => x.gGpsMax))} | ${f(c.gLean)} / ${f(med((x) => x.gLean))} | ${f(c.gLeanCal)} / ${f(med((x) => x.gLeanCal))} | ${f(c.leanMaxDeg, 1)} / ${f(med((x) => x.leanMaxDeg), 1)} | ${f(c.offInsideM, 1)} / ${f(c.wInsideM, 1)} (${f(c.insideFrac)}; ${f(med((x) => x.insideFrac))}) | ${f(c.entryOutFrac)} / ${f(c.exitOutFrac)} (${f(med((x) => x.entryOutFrac))} / ${f(med((x) => x.exitOutFrac))}) |`,
    );
  });

  console.log('\n## κ scale: the sim pipeline (±L stencil, ±L mean) on the best lap\'s GPS line, per-corner zone max v²κ/g\n');
  const sweep = curvatureScaleSweep(bt, ref, bm, [20, 14, 12, 10, 8, 7, 5]);
  console.log(`| corner | measured v²κ (20 m heading window) | calibrated lean g | ${sweep.map((r) => `${r.scaleM}/${r.scaleM} m`).join(' | ')} |`);
  console.log(`|---|---|---|${sweep.map(() => '---').join('|')}|`);
  bm.forEach((c, k) => console.log(`| ${c.name} ${c.dir > 0 ? 'L' : 'R'} | ${f(c.gGpsMax)} | ${f(c.gLeanCal)} | ${sweep.map((r) => f(r.zoneMaxG[k])).join(' | ')} |`));
  console.log(`| **− calibrated lean g: mean / rms / max abs** | | | ${sweep.map((r) => `${sg(r.vsCal.bias, 3)} / ${f(r.vsCal.rmse, 3)} / ${f(r.vsCal.maxAbs)}`).join(' | ')} |`);
  console.log(`| **− measured v²κ: mean / rms** | | | ${sweep.map((r) => `${sg(r.vsGps.bias, 3)} / ${f(r.vsGps.rmse, 3)}`).join(' | ')} |`);
  console.log(`| **straights (v > 180 km/h, abs lean < 5°, n ${sweep[0].straightN}): abs κ p95 / p99, 1e-3/m** | | | ${sweep.map((r) => `${f(r.straightP95 * 1000, 3)} / ${f(r.straightP99 * 1000, 3)}`).join(' | ')} |`);
  console.log(`| **lap p99 abs v²κ/g** | | | ${sweep.map((r) => f(r.p99G)).join(' | ')} |`);

  console.log("\n## 2-3. Reference fit on the owner's best lap (Panigale V4, μ 1.35, maxLean 59°)\n");
  const own = ownLine(bt);
  const ownScale = ownLine(bt, CURV_SCALE_M);
  const runs = [
    fitAndCompare(`own GPS line (sim κ, chosen scale)`, own, ref, bt, cal),
    fitAndCompare(`own GPS line (sim κ, map scale ${CURV_SCALE_M} m)`, ownScale, ref, bt, cal),
    fitAndCompare('own GPS line (κ over 20 m, as measured)', { ...own, curvature: Float32Array.from(bt.kappa) }, ref, bt, cal),
    ...[0, 0.85].map((k) => fitOnPist(ref, bt, model, k, 1.0, cal)),
  ];
  console.log(`| corner | measured v²κ zone max | tan(lean max) raw | calibrated lean g | ${runs.map((r) => `${r.label}: apex sim / ref km/h, fitted cap g`).join(' | ')} |`);
  console.log(`|---|---|---|---|${runs.map(() => '---').join('|')}|`);
  bm.forEach((c, k) => {
    const cells = runs.map((r) => {
      const x = r.fit.corners[k];
      return `${f(x.vApexMs * 3.6, 1)} / ${f(x.vApexRefMs * 3.6, 1)}, ${f(x.aLatG)}`;
    });
    console.log(`| ${c.name} ${c.dir > 0 ? 'L' : 'R'} | ${f(c.gGpsMax)} | ${f(c.gLean)} | ${f(c.gLeanCal)} | ${cells.join(' | ')} |`);
  });
  for (const r of runs) {
    const dc = r.aLatG.map((g, k) => g - bm[k].gLeanCal);
    const dt = r.aLatG.map((g, k) => g - bm[k].gLean);
    const dv = r.aLatG.map((g, k) => g - bm[k].gGpsMax);
    console.log(
      `\n- ${r.label}: line ${r.lineLengthM.toFixed(0)} m; lap fit ${r.fit.lapTimeS.toFixed(2)} s / ref ${r.fit.refLapTimeS.toFixed(2)} s / ref-on-line ${r.fit.alignedRefLapS.toFixed(2)} s; ${r.fit.iterations} it, ${r.fit.converged ? 'converged' : 'NOT converged'}; max apex abs Δ ${f(Math.max(...r.fit.residuals.apexKmh.map(Math.abs)), 1)} km/h; alignment ${r.fit.alignment.method}, apex shift mean/max ${r.fit.alignment.residual.meanAbsM.toFixed(1)}/${r.fit.alignment.residual.maxAbsM.toFixed(1)} m. ` +
        `Fitted apex cap − calibrated lean g: mean ${sg(dc.reduce((a, b) => a + b, 0) / dc.length)}, rms ${f(rmse(dc))}, max abs ${f(Math.max(...dc.map(Math.abs)))}; − raw tan(lean max): mean ${sg(dt.reduce((a, b) => a + b, 0) / dt.length)}, rms ${f(rmse(dt))}. ` +
        `Fitted apex cap − v²κ zone max: mean ${sg(dv.reduce((a, b) => a + b, 0) / dv.length)}, rms ${f(rmse(dv))}. ` +
        `Along the lap (calibrated lean g > 0.3, n ${r.vsCal.n}): abs latG_env minus raw tan abs φ rmse ${f(r.vsTan.rmse, 3)} / p95 ${f(r.vsTan.p95, 3)} / bias ${sg(r.vsTan.bias, 3)} g; minus calibrated lean g ${f(r.vsCal.rmse, 3)} / ${f(r.vsCal.p95, 3)} / ${sg(r.vsCal.bias, 3)}; minus v²κ/g ${f(r.vsGps.rmse, 3)} / ${f(r.vsGps.p95, 3)} / ${sg(r.vsGps.bias, 3)}; lean rmse ${f(r.leanRmseDeg, 1)}°. ` +
        `Over 1.35 g at the apex: ${r.fit.corners.filter((x) => x.aLatG > 1.35).map((x) => `${x.name} ${x.aLatG.toFixed(2)}`).join(', ') || 'none'}.`,
    );
    if (r.fit.notes.length) console.log(`  notes: ${r.fit.notes.join(' · ')}`);
  }
  if (jsonOut) {
    writeFileSync(
      jsonOut,
      JSON.stringify(
        {
          gs,
          kept,
          best,
          channels: ch,
          lengths: Object.fromEntries(kept.map((l) => [l, res.traces.get(l)!.lengthM])),
          measured: Object.fromEntries(kept.map((l) => [l, res.measured.get(l)])),
          fits: runs.map((r) => ({ label: r.label, lineM: r.lineLengthM, aLatG: r.aLatG, envPeakG: r.envPeakG, vsTan: r.vsTan, vsCal: r.vsCal, vsGps: r.vsGps, leanRmseDeg: r.leanRmseDeg, lap: r.fit.lapTimeS, refOnLine: r.fit.alignedRefLapS, corners: r.fit.corners.map((c) => ({ name: c.name, vSim: c.vApexMs * 3.6, vRef: c.vApexRefMs * 3.6, aLatG: c.aLatG, peak: c.aLatPeakG, binding: c.binding })) })),
        },
        null,
        1,
      ),
    );
  }
}
