import { describe, expect, it } from 'vitest';
import { createOptimiser, LAT_G_PENALTY_DEFAULT, latGPenaltyS, optimiseOffsets } from '../../src/sim/freeTrajectory';
import { createLapTimeRun, runLapTimeLine } from '../../src/sim/lapTimeLine';
import { buildLine, lineFromOffsets, offsetBounds } from '../../src/sim/line';
import { solve } from '../../src/sim/solver';
import { DEFAULT_SIM_PARAMS, clampParams } from '../../src/sim/presets';
import { circuitTrack } from './circuitFixture';

// the ideal rider the optimiser uses internally
const P0 = clampParams({
  ...DEFAULT_SIM_PARAMS,
  rider: { ...DEFAULT_SIM_PARAMS.rider, sBrake: 1, sDrive: 1, sLat: 1, rollRateFrac: 1 },
});
const P = P0;

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

  it('takes a warm start (FreeTrajStart.init), clamped into the box, and never loses to it', () => {
    const { track, corridor } = circuitTrack();
    // no wander, so the κ-line is the only built start
    const P = clampParams({ ...P0, rider: { ...P0.rider, lineDeviationM: 0 } });
    const { loM, hiM } = offsetBounds(track, corridor, P);
    // a deliberately poor start: the box's left edge everywhere (out of the box where it is narrower)
    const init = Float32Array.from(hiM, (v) => v + 2);
    const clamped = Float32Array.from(init, (v, i) => Math.min(hiM[i], Math.max(loM[i], v)));
    const opt = createOptimiser(track, corridor, P, { init });
    const kappaLine = solve(buildLine(track, corridor, P), P).lapTimeS;
    expect(opt.startLapTimeS).toBeCloseTo(Math.min(kappaLine, solve(lineFromOffsets(track, clamped), P).lapTimeS), 6);
    // a good start is taken: the optimiser's own result fed back in starts there
    const r = optimiseOffsets(track, corridor, P, { iterations: 2 });
    const again = createOptimiser(track, corridor, P, { init: r.offsetsM });
    expect(again.startLapTimeS).toBeCloseTo(r.lapTimeS, 6);
    // a wrong-length init is ignored
    expect(createOptimiser(track, corridor, P, { init: new Float32Array(3) }).startLapTimeS).toBeCloseTo(kappaLine, 6);
  });

  it("rider 'own' judges the caller's params (no wander), not the ideal rider", () => {
    const { track, corridor } = circuitTrack();
    const timid = clampParams({ ...DEFAULT_SIM_PARAMS, rider: { ...DEFAULT_SIM_PARAMS.rider, sBrake: 0.5, sLat: 0.6 } });
    const r = optimiseOffsets(track, corridor, timid, { iterations: 1, rider: 'own' });
    const own = clampParams({ ...timid, rider: { ...timid.rider, lineDeviationM: 0 } });
    expect(solve(lineFromOffsets(track, r.offsetsM), own).lapTimeS).toBeCloseTo(r.lapTimeS, 6);
    expect(solve(lineFromOffsets(track, r.offsetsM), P).lapTimeS).toBeLessThan(r.lapTimeS);
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

// pist-line note §9: forceInit, the soft lateral-g ceiling, the multi-start run
describe('lap-time line extras (note §9)', { timeout: 60_000 }, () => {
  const own = clampParams({ ...DEFAULT_SIM_PARAMS, rider: { ...DEFAULT_SIM_PARAMS.rider, lineDeviationM: 0 } });

  it('forceInit starts from the init alone, even when the κ-line is faster', () => {
    const { track, corridor } = circuitTrack();
    const { hiM } = offsetBounds(track, corridor, own);
    const init = Float32Array.from(hiM); // the left edge everywhere: a poor line
    const t = solve(lineFromOffsets(track, init), own).lapTimeS;
    expect(createOptimiser(track, corridor, own, { init, rider: 'own' }).startLapTimeS).toBeLessThan(t);
    expect(createOptimiser(track, corridor, own, { init, rider: 'own', forceInit: true }).startLapTimeS).toBeCloseTo(t, 6);
  });

  it('latGPenaltyS: λ·Σ excess²·ds; 0.1 g over 20 m at the default λ ≈ 0.1 s; zero on the QSS speed', () => {
    const { track, corridor } = circuitTrack();
    const line = buildLine(track, corridor, own);
    const env = solve(line, own);
    // the QSS speed never asks more than the rider's lateral limit (≤ the 1.4 g ceiling)
    expect(latGPenaltyS(line, env, { ceilingG: 1.4, lambda: LAT_G_PENALTY_DEFAULT })).toBe(0);
    // a reference speed that asks exactly ceiling + 0.1 g over a 20 m stretch
    const n = line.points.length;
    const v = new Float32Array(n);
    let len = 0;
    for (let i = 0; i < n - 1; i++) {
      const k = Math.abs(line.curvature[i]);
      if (len < 20 && k > 1e-3) {
        v[i] = Math.sqrt((1.5 * 9.81) / k);
        len += line.cumDistM[i + 1] - line.cumDistM[i];
      }
    }
    const pen = latGPenaltyS(line, null, { vRefMs: v, ceilingG: 1.4, lambda: LAT_G_PENALTY_DEFAULT });
    expect(pen).toBeGreaterThan(0.08);
    expect(pen).toBeLessThan(0.12);
  });

  it('the penalty shapes the descent: the objective is lap + penalty, lapTimeS the pure lap', () => {
    const { track, corridor } = circuitTrack();
    const line = buildLine(track, corridor, own);
    // a reference 10 % faster than the rider everywhere: over the ceiling in every corner
    const v = Float32Array.from(solve(line, own).v, (x) => x * 1.1);
    const latG = { vRefMs: v, ceilingG: 1.4, lambda: LAT_G_PENALTY_DEFAULT };
    const o = createOptimiser(track, corridor, own, { rider: 'own', latG });
    o.iterate();
    const best = lineFromOffsets(track, Float32Array.from(o.offsetsM));
    const env = solve(best, own);
    expect(o.lapTimeS).toBeCloseTo(env.lapTimeS, 6);
    expect(o.objective).toBeCloseTo(env.lapTimeS + latGPenaltyS(best, env, latG), 6);
    expect(o.objective).toBeGreaterThan(o.lapTimeS);
  });

  it('multi-start keeps the fastest QSS lap and reports "start k/n" progress', () => {
    const { track, corridor } = circuitTrack();
    const { loM } = offsetBounds(track, corridor, own);
    const poor = lineFromOffsets(track, Float32Array.from(loM));
    const stages = new Set<string>();
    const r = runLapTimeLine(track, corridor, { ...own, rider: { ...own.rider, lineMode: 'lap-time' } }, { warmStarts: [poor], iterations: 2 }, (p) =>
      stages.add(`${p.start}/${p.starts} ${p.labels[p.start - 1]}`),
    );
    expect(r.starts.map((s) => s.label)).toEqual(['κ-line', 'owner path']);
    expect([...stages]).toEqual(['1/2 κ-line', '2/2 owner path']);
    for (const s of r.starts) expect(r.lapTimeS).toBeLessThanOrEqual(s.lapTimeS);
    expect(solve(lineFromOffsets(track, r.offsetsM), own).lapTimeS).toBeCloseTo(r.lapTimeS, 6);
  });

  it('stops at the time budget with the best line so far', () => {
    const { track, corridor } = circuitTrack();
    let clock = 0;
    const run = createLapTimeRun(track, corridor, own, { budgetMs: 1, now: () => clock });
    expect(run.step()).toBe(true); // first sweep inside the budget
    clock = 5;
    expect(run.step()).toBe(false);
    const r = run.result();
    expect(r.outOfBudget).toBe(true);
    expect(r.starts[0].sweeps).toBe(1);
  });
});
