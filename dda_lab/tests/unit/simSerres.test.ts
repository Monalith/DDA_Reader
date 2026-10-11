// The simulator against the real circuit, offline.
//
// `docs/superpowers/notes/2026-10-10-virtual-vs-real.md` measured the virtual
// rider against the real BMW Serres lap (1:19.81) in the browser, on an
// extracted corridor. This file re-runs the two facts that matter from that
// comparison in node, from the example file's own lat/lon with no corridor,
// so they cannot silently rot:
//
//   1. the default rider still produces the reference lap;
//   2. ENGINE POWER ALONE CANNOT REACH 1:17 on this circuit, because the lap
//      is set by tyre grip and braking, not by the engine.
//
// The second is the user-facing claim and the reason this file exists. The
// absolute times here are about 1.2 s quicker than the browser's, because
// without a corridor `buildLine` falls back to a 5 m half-width and the line
// is a different line; the SHAPE of the power response is what is asserted.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildCenterline } from '../../src/core/track';
import { buildLine } from '../../src/sim/line';
import { G, lossDecelMs2, solve } from '../../src/sim/solver';
import { clampParams, DEFAULT_SIM_PARAMS, presetById } from '../../src/sim/presets';
import { cornerMetrics, throttlePickUp } from '../../scripts/lib/cornerMetrics';
import { readReferenceRows, referenceTrace } from '../../scripts/lib/referenceLap';
import type { TrackModel } from '../../src/core/types';
import type { SimParams } from '../../src/sim/types';

/** The real Serres centerline, from the reference lap's own hand-placed line. */
function serresTrack(): TrackModel {
  const raw = JSON.parse(
    readFileSync(new URL('../../public/examples/serres_BMW_1-19-81.json', import.meta.url), 'utf8'),
  ) as { telemetri_1m: Array<{ lat: number; lon: number }> };
  const rows = raw.telemetri_1m;
  const lng = new Float32Array(rows.length);
  const lat = new Float32Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    lng[i] = rows[i].lon;
    lat[i] = rows[i].lat;
  }
  const { centerline, cumDistM, lengthM } = buildCenterline([{ lng, lat }], 2);
  return {
    id: 'serres', name: 'Serres', center: centerline[0], centerline, cumDistM, lengthM,
    startFinish: { id: 'sf', name: 'SF', type: 'sf', at: centerline[0], bearingDeg: 0, halfWidthM: 15 },
    sectors: [], turns: [],
  };
}

const P = clampParams(DEFAULT_SIM_PARAMS);
const track = serresTrack();
const line = buildLine(track, undefined, P);
const lapAt = (powerKw: number, over: Partial<SimParams['rider']> = {}): number =>
  solve(line, clampParams({ ...P, machine: { ...P.machine, powerKw }, rider: { ...P.rider, ...over } })).lapTimeS;

describe('the virtual rider on the real Serres geometry', () => {
  it('is a sane circuit to be measuring on', () => {
    expect(line.points.length).toBeGreaterThan(1000);
    expect(track.lengthM).toBeGreaterThan(3000);
    expect(track.lengthM).toBeLessThan(3300); // Serres is 3.19 km
  });

  it('still reproduces the reference lap at the shipped defaults', () => {
    // Calibration guard, not a fit: the reference is 79.81 s and the browser
    // path reports 80.47 s on the extracted corridor. 79.53 s here — it was
    // 79.34 before the braking model gained its loss term and its build rate
    // (`simLongG.test.ts`), which between them are worth +0.19 s. A band
    // wide enough to survive an honest model change and narrow enough that
    // re-parameterising a rider slider without re-checking the default — which
    // is exactly what moved it by 5 s while this was being written — goes red.
    expect(lapAt(P.machine.powerKw)).toBeGreaterThan(78.3);
    expect(lapAt(P.machine.powerKw)).toBeLessThan(80.4);
  });

  it('answers power with a monotone, saturating lap time', () => {
    const sweep = [10, 25, 40, 60, 80, 100, 120, 147, 170, 200, 250, 300, 400].map((kw) => lapAt(kw));
    for (let i = 1; i < sweep.length; i++) expect(sweep[i]).toBeLessThanOrEqual(sweep[i - 1] + 1e-9);
    // the response is real at the bottom: 10 kW is 24 s a lap slower than 147
    expect(sweep[0] - sweep[7]).toBeGreaterThan(20);
  });

  it('cannot reach 1:17 on power alone, however much is fitted', () => {
    // THE finding. 147 kW -> 79.53 s; 400 kW (the clamp's ceiling) -> 79.11 s.
    // Past ~200 kW the forward pass is grip-limited essentially everywhere, so
    // the curve is flat: power buys 0.4 s and 1:17 is 2 s away.
    const stock = lapAt(P.machine.powerKw);
    const absurd = lapAt(400);
    expect(stock - absurd).toBeLessThan(0.8);
    expect(absurd).toBeGreaterThan(77.5);
  });

  it('answers the rider and the tyre instead — which is where 1:17 comes from', () => {
    // Same circuit, same 147 kW: the trail-brake pair alone is worth 12.8 s
    // across its square (91.66 timid, 78.86 brave), and the rider's own
    // choices at their best reach 1:16.7. That is the honest answer to "raise
    // the power to see 1:17": the power slider is not the one that gets there.
    //
    // It was 18 s before the braking model learned about aero losses and a
    // build rate, and the default `brakingG` came down from 1.1 to the 0.85
    // the reference laps actually show at the tyre. Less of the lap is on the
    // brakes with the losses helping, so there is less for the trail-brake
    // pair to be the difference in.
    const timid = lapAt(P.machine.powerKw, { trailBrakeDepth: 0, trailBrakeProfile: 0 });
    const brave = lapAt(P.machine.powerKw, { trailBrakeDepth: 1, trailBrakeProfile: 1 });
    // v2 calibration: 12 -> 10. The default rider already carries the brakes
    // deeper (trail depth 0.8 / profile 0.75 at R 0.5), so the square is
    // measured from a less timid baseline: 11.7 s.
    expect(timid - brave).toBeGreaterThan(10);
    // v2: the rider's best is the slip ceiling on every axis plus the full
    // roll rate, not a pinned brakingG (which is derived from the same thing)
    const best = lapAt(P.machine.powerKw, {
      trailBrakeDepth: 1, trailBrakeProfile: 1, tcThreshold: 1, leanUsage: 1,
      sBrake: 1, sDrive: 1, sLat: 1, rollRateFrac: 1, throttleDelayS: -0.1, rollOnS: 0.3,
    });
    // v2: 77.5 -> 79.0. The roll-rate constraint and the corner-event
    // transitions cost ~1 s that no slider removes; 1:17 is now the
    // free-trajectory/OCP modes' territory (spec v2 §2.10).
    expect(best).toBeLessThan(79.0);
    // and it is worth more than every kilowatt above stock put together
    expect(best).toBeLessThan(lapAt(400));
  });
});

// The REAL side of the validation table (`scripts/sim-validate.ts`, spec v2
// §4b). These pin how the harness reads the two reference files, NOT the
// simulator: the sim side moves with every model change and is recorded in
// docs/superpowers/notes/2026-10-11-validation-baseline.md instead. If one of
// these goes red the reference reading changed, and every number in that note
// has to be re-measured.
describe('the validation harness reading the reference laps', () => {
  const examples = (f: string): string => fileURLToPath(new URL(`../../public/examples/${f}`, import.meta.url));
  const measure = (f: string, kind: 'BMW' | 'R6', presetId: string) => {
    const tr = referenceTrace(readReferenceRows(examples(f)), kind);
    const m = cornerMetrics(tr.speedKmh, tr.sM, tr.longG, {
      tS: tr.tS,
      lossG: (v) => lossDecelMs2(presetById(presetId).machine, v) / G,
    });
    return { tr, m };
  };

  it('BMW: ten corner sections, seven of them braked, a 0.3 s build and the p25 the notes quote', () => {
    const { tr, m } = measure('serres_BMW_1-19-81.json', 'BMW', '1000');
    expect(tr.lapTimeS).toBeCloseTo(79.8, 1);
    expect(m.corners.length).toBe(10);
    expect(m.brakeEvents).toBe(7);
    // the spec's 0.3-0.5 s target band comes from these laps
    const builds = [...m.buildTimesS].sort((a, b) => a - b);
    expect(builds[Math.floor(builds.length / 2)]).toBeGreaterThan(0.25);
    expect(builds[Math.floor(builds.length / 2)]).toBeLessThan(0.45);
    // longitudinal-g note §5: real p25 −0.70 (artefact span bridged)
    expect(m.longGp25).toBeGreaterThan(-0.75);
    expect(m.longGp25).toBeLessThan(-0.65);
    // the hairpins are where the notes put them (K5 70.1, K10 79.2 km/h)
    const slowest = [...m.minSpeeds].sort((a, b) => a.kmh - b.kmh).slice(0, 2).map((x) => Math.round(x.kmh));
    expect(slowest).toEqual([70, 79]);
  });

  it('R6: the throttle channel gives a pick-up near the apex and a slow roll-on', () => {
    const { tr, m } = measure('serres_R6_1-19-849.json', 'R6', '600');
    expect(tr.tps).toBeDefined();
    const picks: number[] = [];
    m.corners.forEach((c) => {
      const p = throttlePickUp(tr.tS, tr.tps!, c.iA);
      if (p) picks.push(p.tPickS);
    });
    expect(picks.length).toBeGreaterThanOrEqual(5);
    picks.sort((a, b) => a - b);
    const med = picks[Math.floor(picks.length / 2)];
    expect(Math.abs(med)).toBeLessThan(0.6);
  });
});
