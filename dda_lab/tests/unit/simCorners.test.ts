import { describe, expect, it } from 'vitest';
import { findCorners, K_FRAC, PROM_FRAC, PROM_MIN_MS } from '../../src/sim/corners';
import { buildLine } from '../../src/sim/line';
import { solve } from '../../src/sim/solver';
import { clampParams, DEFAULT_SIM_PARAMS, presetById } from '../../src/sim/presets';
import type { Corner, SimParams } from '../../src/sim/types';
import { chicaneTrack, circuitTrack, trackFromSegments } from './circuitFixture';

// The plain minimum-curvature line: these tests are about the corner
// detector on the fixture's five known corners. The default min-time line
// (pist-line note §7) rides the 250 m sweeper as a double apex at κ 0.85 —
// two curvature peaks, so the detector rightly finds six sections there.
const P = clampParams({ ...DEFAULT_SIM_PARAMS, rider: { ...DEFAULT_SIM_PARAMS.rider, lineMode: 'min-curvature' } });

/** Cyclic distance forward from `a` to `b` in a lap of `n` samples. */
const fwd = (a: number, b: number, n: number): number => (b - a + n) % n;

/**
 * The event order B ≤ T < A ≤ P ≤ E, read CYCLICALLY: a section may straddle
 * the start line (the circuit fixture's last corner exits across it), so the
 * indices are all in [0, n) and the order is checked as distances from B.
 */
function expectOrdered(c: Corner, n: number): void {
  const dT = fwd(c.iB, c.iT, n);
  const dA = fwd(c.iB, c.iA, n);
  const dP = fwd(c.iB, c.iP, n);
  const dE = fwd(c.iB, c.iE, n);
  expect(dT).toBeLessThan(dA);
  expect(dA).toBeLessThanOrEqual(dP);
  expect(dP).toBeLessThanOrEqual(dE);
  expect(dE).toBeLessThan(n);
  for (const i of [c.iB, c.iT, c.iA, c.iAgeo, c.iP, c.iE]) {
    expect(Number.isInteger(i)).toBe(true);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(i).toBeLessThan(n);
  }
}

describe('findCorners', () => {
  it('exports the thresholds the spec names (öneri values)', () => {
    expect(K_FRAC).toBe(0.25);
    expect(PROM_MIN_MS).toBeCloseTo(8 / 3.6, 9);
    expect(PROM_FRAC).toBe(0.05);
  });

  it('finds five sections on the five-corner circuit, each with one B and one P, in order', () => {
    const line = buildLine(circuitTrack(), undefined, P);
    const env = solve(line, P);
    const cs = findCorners(line, env.v, P);
    expect(cs.length).toBe(5);
    const n = line.points.length;
    for (const c of cs) {
      expectOrdered(c, n);
      expect(c.hasBrake).toBe(true);
      // the speed apex is the slowest sample of the section's own stretch
      expect(env.v[c.iA]).toBeLessThanOrEqual(env.v[c.iT] + 1e-6);
      expect(env.v[c.iA]).toBeLessThanOrEqual(env.v[c.iE] + 1e-6);
    }
    // sorted by apex, and the directions are the fixture's: L R L L L
    for (let k = 1; k < cs.length; k++) expect(cs[k].iA).toBeGreaterThan(cs[k - 1].iA);
    expect(cs.map((c) => c.dir)).toEqual([1, -1, 1, 1, 1]);
  });

  it('finds the same five on the jittered circuit (GPS-like centerline)', () => {
    const { track, corridor } = circuitTrack(6, 2, 0.25);
    const line = buildLine(track, corridor, P);
    const env = solve(line, P);
    expect(findCorners(line, env.v, P).length).toBe(5);
  });

  it('a chicane is one section with a flip', () => {
    const line = buildLine(chicaneTrack(), undefined, P);
    const env = solve(line, P);
    const cs = findCorners(line, env.v, P);
    // The fixture's three closing bends were flat-out in v1; the v2 roll-rate
    // limit makes each a (shallow) corner of its own, so assert the chicane
    // itself: exactly ONE section carries the flip, and it is braked.
    const chicane = cs.filter((c) => c.flips.length >= 1);
    expect(chicane.length).toBe(1);
    expect(chicane[0].hasBrake).toBe(true);
    for (const c of cs) expectOrdered(c, line.points.length);
  });

  it('a kink taken flat out has no brake event', () => {
    // 400 m radius bends on the 250 preset: v_lat ≈ 70 m/s, top speed ≈ 52 m/s
    const pre = presetById('250');
    const P250: SimParams = clampParams({
      ...DEFAULT_SIM_PARAMS,
      machine: { presetId: '250', ...pre.machine },
      tyre: { ...pre.tyre },
    });
    const kink = trackFromSegments([
      { kind: 'straight', lengthM: 500 },
      { kind: 'arc', radiusM: 400, turnDeg: 180 },
      { kind: 'straight', lengthM: 500 },
      { kind: 'arc', radiusM: 400, turnDeg: 180 },
    ]);
    const kinkLine = buildLine(kink, undefined, P250);
    const kinkEnv = solve(kinkLine, P250);
    const cs = findCorners(kinkLine, kinkEnv.v, P250);
    expect(cs.every((c) => !c.hasBrake)).toBe(true);
  });

  it('ignores speed dips below the prominence threshold', () => {
    // a jittered 100 m circle: the speed wobbles with the curvature noise but
    // never by 8 km/h, so there is no corner section on it at all
    const circle = trackFromSegments([{ kind: 'arc', radiusM: 100, turnDeg: 360 }], 6, 2, 0.25);
    const line = buildLine(circle, undefined, P);
    const env = solve(line, P);
    let lo = Infinity;
    let hi = -Infinity;
    for (const x of env.v) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
    expect(hi - lo).toBeGreaterThan(0); // there IS a wobble to ignore
    expect(findCorners(line, env.v, P)).toEqual([]);
  });

  it('a synthetic dip just under the threshold is ignored and one just over it is kept', () => {
    const line = buildLine(circuitTrack(), undefined, P);
    const n = line.points.length;
    const dip = (depth: number): Float32Array => {
      const v = new Float32Array(n).fill(50);
      for (let i = 0; i < n; i++) {
        const d = Math.min(Math.abs(i - 300), n - Math.abs(i - 300));
        if (d < 40) v[i] = 50 - depth * (1 - d / 40);
      }
      return v;
    };
    // threshold at 47.5 m/s apex is max(2.22, 0.05·47.5 = 2.375)
    expect(findCorners(line, dip(2.2), P).length).toBe(0);
    expect(findCorners(line, dip(2.6), P).length).toBe(1);
    // the opts override the threshold
    expect(findCorners(line, dip(2.6), P, { promMinMs: 5, promFrac: 0 }).length).toBe(0);
  });
});
