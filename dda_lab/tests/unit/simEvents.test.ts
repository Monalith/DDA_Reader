import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCenterline } from '../../src/core/track';
import type { TrackModel } from '../../src/core/types';
import { findCorners } from '../../src/sim/corners';
import { eventProfile, type EventProfile } from '../../src/sim/events';
import { buildLine } from '../../src/sim/line';
import { G, solve, topSpeedMs } from '../../src/sim/solver';
import { clampParams, DEFAULT_SIM_PARAMS } from '../../src/sim/presets';
import { deriveRider } from '../../src/sim/derive';
import type { Corner, Envelope, Line, SimParams } from '../../src/sim/types';
import { chicaneTrack, circuitTrack, testCaps, trackFromSegments } from './circuitFixture';

const P = clampParams(DEFAULT_SIM_PARAMS);

interface Run { line: Line; env: Envelope; corners: Corner[]; ev: EventProfile; params: SimParams }

function run(track: Parameters<typeof buildLine>[0], params: SimParams = P, corridor?: Parameters<typeof buildLine>[1]): Run {
  const line = buildLine(track, corridor, params);
  const env = solve(line, params);
  const corners = findCorners(line, env.v, params);
  const ev = eventProfile(line, env, corners, params, testCaps(line, params));
  return { line, env, corners, ev, params };
}

/** The samples of a section from `a` to `b` inclusive, walking forward across the start line. */
function cyc(arr: Float32Array, a: number, b: number): number[] {
  const n = arr.length;
  const out: number[] = [];
  for (let i = a; ; i = (i + 1) % n) {
    out.push(arr[i]);
    if (i === b) break;
  }
  return out;
}

/** Brake applications in a (cyclic) channel: rises through 5 %. */
function brakeApplications(brake: Float32Array): number {
  let c = 0;
  for (let i = 0; i < brake.length; i++) {
    const prev = brake[(i - 1 + brake.length) % brake.length];
    if (prev < 5 && brake[i] >= 5) c++;
  }
  return c;
}

const circuit = run(circuitTrack());

describe('eventProfile', () => {
  it('returns finite channels of the line length and a monotone clock', () => {
    const { ev, line } = circuit;
    const n = line.points.length;
    for (const a of [ev.v, ev.brake, ev.tps, ev.tS]) expect(a.length).toBe(n);
    for (let i = 0; i < n; i++) {
      for (const a of [ev.v, ev.brake, ev.tps, ev.tS]) expect(Number.isFinite(a[i])).toBe(true);
      expect(ev.brake[i]).toBeGreaterThanOrEqual(0);
      expect(ev.brake[i]).toBeLessThanOrEqual(100);
      expect(ev.tps[i]).toBeGreaterThanOrEqual(0);
      expect(ev.tps[i]).toBeLessThanOrEqual(100);
      if (i > 0) expect(ev.tS[i]).toBeGreaterThan(ev.tS[i - 1]);
    }
    expect(ev.tS[0]).toBe(0);
    expect(ev.lapTimeS).toBeGreaterThan(ev.tS[n - 1]);
    expect(ev.corners.length).toBe(5);
  });

  it('recomputes the lap time from the event speed, never faster than the QSS bound', () => {
    const { ev, env, line } = circuit;
    let t = 0;
    const n = line.points.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ds = j === 0 ? line.lengthM - line.cumDistM[n - 1] : line.cumDistM[j] - line.cumDistM[i];
      t += ds / Math.max(2, (ev.v[i] + ev.v[j]) / 2);
    }
    expect(ev.lapTimeS).toBeCloseTo(t, 6);
    expect(ev.lapTimeS).toBeGreaterThanOrEqual(env.lapTimeS);
    expect(ev.lapTimeS).toBeLessThan(env.lapTimeS * 1.1);
  });

  it('v_event never exceeds the QSS envelope and is C1 at the joins', () => {
    const { ev, env } = circuit;
    for (let i = 0; i < ev.v.length; i++) expect(ev.v[i]).toBeLessThanOrEqual(env.v[i] + 1e-4);
    // no jump in longitudinal accel larger than the brake jerk over one sample
    const dsMax = 2.5;
    const jerkPerSample = P.rider.brakeRiseGps * 9.81 * (dsMax / 20);
    for (let i = 2; i < ev.v.length; i++) {
      const a1 = (ev.v[i] ** 2 - ev.v[i - 1] ** 2) / 4;
      const a0 = (ev.v[i - 1] ** 2 - ev.v[i - 2] ** 2) / 4;
      expect(Math.abs(a1 - a0)).toBeLessThan(jerkPerSample * 3 + 0.3);
    }
  });

  it('is jerk-limited where it is not clipped: |da| per sample stays near J·dt', () => {
    const { ev, env, line } = circuit;
    const n = line.points.length;
    const J = P.rider.brakeRiseGps * G;
    let worst = 0;
    for (let i = 2; i < n; i++) {
      // only where the event profile is its own (not riding the QSS bound)
      if (ev.v[i] >= env.v[i] - 1e-3 || ev.v[i - 1] >= env.v[i - 1] - 1e-3 || ev.v[i - 2] >= env.v[i - 2] - 1e-3) continue;
      const ds1 = line.cumDistM[i] - line.cumDistM[i - 1];
      const ds0 = line.cumDistM[i - 1] - line.cumDistM[i - 2];
      const a1 = (ev.v[i] ** 2 - ev.v[i - 1] ** 2) / (2 * ds1);
      const a0 = (ev.v[i - 1] ** 2 - ev.v[i - 2] ** 2) / (2 * ds0);
      const dt = ds1 / Math.max(2, ev.v[i - 1]);
      worst = Math.max(worst, Math.abs(a1 - a0) / (J * dt));
    }
    // the drive cap moves with speed and lean on its own, so not exactly 1
    expect(worst).toBeLessThan(2.5);
  });

  it('exactly one brake application and one throttle pick-up per section', () => {
    const { ev } = circuit;
    for (const c of ev.corners) {
      const b = cyc(ev.brake, c.iB, c.iE);
      const rises = b.filter((x, k) => k > 0 && b[k - 1] < 5 && x >= 5).length + (b[0] >= 5 ? 1 : 0);
      expect(rises).toBe(c.hasBrake ? 1 : 0);
      const t = cyc(ev.tps, c.iA, c.iE);
      let down = 0;
      for (let k = 1; k < t.length; k++) if (t[k] < t[k - 1] - 1) down++;
      expect(down).toBe(0); // throttle never closes again before the exit
      // and it does reach the pick-up and the roll-on inside the section's events
      expect(ev.tps[c.iP]).toBeGreaterThan(0);
    }
  });

  it('the number of brake applications on the lap equals the sections with hasBrake', () => {
    const { ev } = circuit;
    expect(ev.corners.filter((c) => c.hasBrake).length).toBe(5);
    expect(brakeApplications(ev.brake)).toBe(ev.corners.filter((c) => c.hasBrake).length);
    // and the same on the GPS-jittered centerline
    const { track, corridor } = circuitTrack(6, 2, 0.25);
    const j = run(track, P, corridor);
    expect(brakeApplications(j.ev.brake)).toBe(j.ev.corners.filter((c) => c.hasBrake).length);
  });

  it('a section without hasBrake emits no brake, and the throttle only lifts', () => {
    const { line, env, corners, params } = circuit;
    // force the sweeper (the first section) to be taken without the brake
    const forced = corners.map((c, k) => (k === 0 ? { ...c, hasBrake: false } : c));
    const ev = eventProfile(line, env, forced, params, testCaps(line, params));
    const c0 = ev.corners[0];
    expect(c0.hasBrake).toBe(false);
    expect(c0.iB).toBe(c0.iT);
    // nothing on the brake from the end of the previous section's exit to the sweeper's exit
    const prevE = ev.corners[ev.corners.length - 1].iE;
    expect(Math.max(...cyc(ev.brake, prevE, c0.iE))).toBe(0);
    expect(brakeApplications(ev.brake)).toBe(4);
    for (let i = 0; i < ev.v.length; i++) expect(ev.v[i]).toBeLessThanOrEqual(env.v[i] + 1e-4);
  });

  it('a chicane is ONE brake and one throttle pick-up, carried through the flip', () => {
    const r = run(chicaneTrack());
    expect(r.ev.corners.length).toBe(1);
    expect(r.ev.corners[0].flips.length).toBeGreaterThanOrEqual(1);
    expect(brakeApplications(r.ev.brake)).toBe(1);
    const c = r.ev.corners[0];
    const t = cyc(r.ev.tps, c.iA, c.iE);
    for (let k = 1; k < t.length; k++) expect(t[k]).toBeGreaterThanOrEqual(t[k - 1] - 1);
  });

  it('with no corner sections it is the QSS profile, no brake', () => {
    const pre = DEFAULT_SIM_PARAMS;
    const oval = trackFromSegments([
      { kind: 'straight', lengthM: 500 },
      { kind: 'arc', radiusM: 900, turnDeg: 180 },
      { kind: 'straight', lengthM: 500 },
      { kind: 'arc', radiusM: 900, turnDeg: 180 },
    ]);
    const r = run(oval, clampParams(pre));
    expect(r.corners.length).toBe(0);
    expect(Math.max(...r.ev.brake)).toBe(0);
    for (let i = 0; i < r.ev.v.length; i++) expect(r.ev.v[i]).toBeCloseTo(r.env.v[i], 5);
    expect(r.ev.lapTimeS).toBeCloseTo(r.env.lapTimeS, 6);
  });

  it('brake build takes 0.3-0.5 s to 90 % of peak at default aggressiveness', () => {
    // the v2 default rider: A = 0.7, R = 0.5 through deriveRider (2.46 g/s,
    // ~1.24 g of tyre). The v1 preset's 2.8 g/s into 0.85 g is a 0.27 s
    // build, which is what the measured 0.37-0.40 s (R3 §4.1) said was too fast.
    const rider = deriveRider(P.rider, P.tyre);
    const { ev } = run(circuitTrack(), clampParams({ ...P, rider }));
    // the hardest zone: the section whose brake peak is highest
    let best = { peak: 0, start: 0 };
    for (const c of ev.corners) {
      const n = ev.brake.length;
      let peak = 0;
      for (let i = c.iB; i !== c.iA; i = (i + 1) % n) peak = Math.max(peak, ev.brake[i]);
      if (peak > best.peak) best = { peak, start: c.iB };
    }
    const n = ev.brake.length;
    let i = best.start;
    while (ev.brake[i] <= 0) i = (i + 1) % n;
    const t0 = ev.tS[(i - 1 + n) % n];
    while (ev.brake[i] < 0.9 * best.peak) i = (i + 1) % n;
    const build = ev.tS[i] - t0;
    expect(build).toBeGreaterThan(0.3);
    expect(build).toBeLessThan(0.5);
  });

  it('higher aggressiveness gives a faster lap; higher risk gives a faster lap', () => {
    const lap = (A: number, R: number): number => {
      const rider = deriveRider({ ...P.rider, aggressiveness: A, risk: R, overrides: [] }, P.tyre);
      return run(circuitTrack(), clampParams({ ...P, rider })).ev.lapTimeS;
    };
    expect(lap(0.9, 0.5)).toBeLessThan(lap(0.5, 0.5));
    expect(lap(0.5, 0.5)).toBeLessThan(lap(0.1, 0.5));
    expect(lap(0.5, 0.9)).toBeLessThan(lap(0.5, 0.5));
    expect(lap(0.5, 0.5)).toBeLessThan(lap(0.5, 0.1));
  });

  it('on the real Serres geometry: 7-14 sections (spec §2.4 acceptance), one brake each', () => {
    const raw = JSON.parse(
      readFileSync(new URL('../../public/examples/serres_BMW_1-19-81.json', import.meta.url), 'utf8'),
    ) as { telemetri_1m: Array<{ lat: number; lon: number }> };
    const rows = raw.telemetri_1m;
    const { centerline, cumDistM, lengthM } = buildCenterline(
      [{ lng: Float32Array.from(rows, (r) => r.lon), lat: Float32Array.from(rows, (r) => r.lat) }],
      2,
    );
    const track: TrackModel = {
      id: 'serres', name: 'Serres', center: centerline[0], centerline, cumDistM, lengthM,
      startFinish: { id: 'sf', name: 'SF', type: 'sf', at: centerline[0], bearingDeg: 0, halfWidthM: 15 },
      sectors: [], turns: [],
    };
    for (const params of [P, clampParams({ ...P, rider: deriveRider(P.rider, P.tyre) })]) {
      const r = run(track, params);
      expect(r.ev.corners.length).toBeGreaterThanOrEqual(7);
      expect(r.ev.corners.length).toBeLessThanOrEqual(14);
      expect(brakeApplications(r.ev.brake)).toBe(r.ev.corners.filter((c) => c.hasBrake).length);
      expect(r.ev.lapTimeS).toBeLessThan(r.env.lapTimeS + 3);
    }
  });

  it('a later throttle pick-up costs time', () => {
    const slow = clampParams({ ...P, rider: { ...P.rider, throttleDelayS: 1.2 } });
    expect(run(circuitTrack(), slow).ev.lapTimeS).toBeGreaterThan(circuit.ev.lapTimeS);
  });

  it('segmentation plus the event template run well inside the slider budget', () => {
    const { line, env } = circuit;
    const caps = testCaps(line, P);
    // warm up, then time the best of a few
    findCorners(line, env.v, P);
    let best = Infinity;
    for (let k = 0; k < 5; k++) {
      const t0 = performance.now();
      const cs = findCorners(line, env.v, P);
      eventProfile(line, env, cs, P, caps);
      best = Math.min(best, performance.now() - t0);
    }
    expect(best).toBeLessThan(50);
  });

  it('stays finite at the risk-slider minimum and at a top-speed-limited lap', () => {
    const rider = deriveRider({ ...P.rider, aggressiveness: 0, risk: 0, overrides: [] }, P.tyre);
    const r = run(circuitTrack(), clampParams({ ...P, rider }));
    expect(Number.isFinite(r.ev.lapTimeS)).toBe(true);
    for (const x of r.ev.v) expect(x).toBeGreaterThan(0);
    expect(topSpeedMs(P)).toBeGreaterThan(Math.max(...circuit.ev.v) - 1e-3);
  });
});
