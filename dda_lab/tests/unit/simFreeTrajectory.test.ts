import { describe, expect, it } from 'vitest';
import { createOptimiser, optimiseOffsets } from '../../src/sim/freeTrajectory';
import { buildLine, lineFromOffsets, offsetBounds } from '../../src/sim/line';
import { solve } from '../../src/sim/solver';
import { DEFAULT_SIM_PARAMS, clampParams } from '../../src/sim/presets';
import { circuitTrack } from './circuitFixture';

// the ideal rider the optimiser uses internally
const P = clampParams({
  ...DEFAULT_SIM_PARAMS,
  rider: { ...DEFAULT_SIM_PARAMS.rider, sBrake: 1, sDrive: 1, sLat: 1, rollRateFrac: 1 },
});

// 15 s: the optimiser runs several laps per test; at the 5 s default the box
// test already sat at 4.7 s, and the min-time line (pist-line note §7) adds
// ~0.1 s per κ-line it starts from.
describe('optimiseOffsets', { timeout: 15_000 }, () => {
  it('is never slower than the kappa line it starts from, and its lap time is reproducible', () => {
    const { track } = circuitTrack();
    const start = solve(buildLine(track, undefined, P), P).lapTimeS;
    const r = optimiseOffsets(track, undefined, P, { iterations: 3 });
    expect(r.lapTimeS).toBeLessThanOrEqual(start + 1e-6);
    expect(solve(lineFromOffsets(track, r.offsetsM), P).lapTimeS).toBeCloseTo(r.lapTimeS, 6);
  });

  it('actually improves on the kappa line of a timid rider, judged as the ideal rider', () => {
    const { track, corridor } = circuitTrack();
    const timid = clampParams({ ...DEFAULT_SIM_PARAMS, rider: { ...DEFAULT_SIM_PARAMS.rider, sBrake: 0.3, sDrive: 0.3, sLat: 0.3 } });
    const start = solve(buildLine(track, corridor, P), P).lapTimeS;
    const r = optimiseOffsets(track, corridor, timid, { iterations: 3 });
    // rider params are ignored: the result is the ideal rider's lap
    expect(solve(lineFromOffsets(track, r.offsetsM), P).lapTimeS).toBeCloseTo(r.lapTimeS, 6);
    expect(r.lapTimeS).toBeLessThan(start - 0.05);
  });

  it('stays inside the corridor box', () => {
    const { track } = circuitTrack();
    const r = optimiseOffsets(track, undefined, P, { iterations: 2 });
    for (const d of r.offsetsM) expect(Math.abs(d)).toBeLessThanOrEqual(5 + P.tyre.kerbMarginM + 1e-6);
    // and inside offsetBounds exactly, with a narrow asymmetric corridor
    const { corridor } = circuitTrack(3);
    corridor.leftM.fill(2);
    const { loM, hiM } = offsetBounds(track, corridor, P);
    const r2 = optimiseOffsets(track, corridor, P, { iterations: 2 });
    for (let i = 0; i < r2.offsetsM.length; i++) {
      expect(r2.offsetsM[i]).toBeGreaterThanOrEqual(loM[i] - 1e-6);
      expect(r2.offsetsM[i]).toBeLessThanOrEqual(hiM[i] + 1e-6);
    }
  });

  it('reports progress and honours cancellation', () => {
    const { track } = circuitTrack();
    const fr: number[] = [];
    let calls = 0;
    const r = optimiseOffsets(track, undefined, P, {
      iterations: 50,
      onProgress: (f) => fr.push(f),
      shouldCancel: () => ++calls > 3,
    });
    expect(r.iterationsDone).toBeLessThan(50);
    expect(fr.length).toBeGreaterThan(0);
    for (const f of fr) expect(f).toBeGreaterThanOrEqual(0);
    for (const f of fr) expect(f).toBeLessThanOrEqual(1);
    expect(Number.isFinite(r.lapTimeS)).toBe(true);
  });

  it('cancelled before the first iteration returns the starting line', () => {
    const { track } = circuitTrack();
    const start = solve(buildLine(track, undefined, P), P).lapTimeS;
    const r = optimiseOffsets(track, undefined, P, { iterations: 10, shouldCancel: () => true });
    expect(r.iterationsDone).toBe(0);
    expect(r.lapTimeS).toBeLessThanOrEqual(start + 1e-6);
  });

  it('one iteration on a ~1500-sample track takes under 2 s', () => {
    const { track } = circuitTrack();
    expect(track.centerline.length).toBeGreaterThan(1400);
    const opt = createOptimiser(track, undefined, P);
    const t0 = performance.now();
    opt.iterate();
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(2000);
  });
});
