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
import { describe, expect, it } from 'vitest';
import { buildCenterline } from '../../src/core/track';
import { buildLine } from '../../src/sim/line';
import { solve } from '../../src/sim/solver';
import { clampParams, DEFAULT_SIM_PARAMS } from '../../src/sim/presets';
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
    // path reports 80.47 s on the extracted corridor. 79.34 s here. A band
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
    // THE finding. 147 kW -> 79.34 s; 400 kW (the clamp's ceiling) -> 78.92 s.
    // Past ~200 kW the forward pass is grip-limited essentially everywhere, so
    // the curve is flat: power buys 0.4 s and 1:17 is 2 s away.
    const stock = lapAt(P.machine.powerKw);
    const absurd = lapAt(400);
    expect(stock - absurd).toBeLessThan(0.8);
    expect(absurd).toBeGreaterThan(77.5);
  });

  it('answers the rider and the tyre instead — which is where 1:17 comes from', () => {
    // Same circuit, same 147 kW: the trail-brake pair alone is worth 18 s
    // across its square, and the rider's own choices at their best reach
    // 1:17.1. That is the honest answer to "raise the power to see 1:17": the
    // power slider is not the one that gets there.
    const timid = lapAt(P.machine.powerKw, { trailBrakeDepth: 0, trailBrakeProfile: 0 });
    const brave = lapAt(P.machine.powerKw, { trailBrakeDepth: 1, trailBrakeProfile: 1 });
    expect(timid - brave).toBeGreaterThan(15);
    const best = lapAt(P.machine.powerKw, {
      trailBrakeDepth: 1, trailBrakeProfile: 1, tcThreshold: 1, brakingG: 1.33, leanUsage: 1,
    });
    expect(best).toBeLessThan(77.5);
    // and it is worth more than every kilowatt above stock put together
    expect(best).toBeLessThan(lapAt(400));
  });
});
