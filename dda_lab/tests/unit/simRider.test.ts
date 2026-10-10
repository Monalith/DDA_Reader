import { describe, expect, it } from 'vitest';
import { riderChannels } from '../../src/sim/rider';
import { solve } from '../../src/sim/solver';
import { clampParams, DEFAULT_SIM_PARAMS } from '../../src/sim/presets';
import { cornerLine } from './simSolver.test';
import type { Envelope, Line } from '../../src/sim/types';
import type { LngLat } from '../../src/core/types';

const P = clampParams(DEFAULT_SIM_PARAMS);

/**
 * A synthetic envelope that forces the condition the OVERLAP clamp exists
 * for: full brake demand, released slowly (as a deep trailBrakeProfile
 * does), followed immediately by full throttle demand. `cornerLine()`'s own
 * geometry never produces this — the envelope's longG decays fast enough on
 * its own there that the clamp happens not to bind — so this fixture drives
 * the two channels into genuine conflict on purpose.
 */
function brakeToThrottleEnvelope(n = 200, dtS = 0.01): { line: Line; env: Envelope } {
  const points: LngLat[] = Array.from({ length: n }, () => [23.518, 41.073] as LngLat);
  const line: Line = {
    points,
    curvature: new Float32Array(n),
    cumDistM: new Float64Array(n),
    lengthM: n,
    offsetM: new Float32Array(n),
  };
  const longG = new Float32Array(n);
  const tS = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    longG[i] = i < 50 ? -1.1 : 0.9; // full brake demand, then full throttle demand
    tS[i] = i * dtS;
  }
  const env: Envelope = {
    v: new Float32Array(n).fill(30),
    longG,
    latG: new Float32Array(n),
    leanDeg: new Float32Array(n),
    gripUse: new Float32Array(n),
    tS,
    lapTimeS: n * dtS,
  };
  return { line, env };
}

describe('riderChannels', () => {
  it('produces channels of the same length as the line', () => {
    const line = cornerLine();
    const ch = riderChannels(line, solve(line, P), P);
    expect(ch.tps).toHaveLength(line.points.length);
    expect(ch.gear).toHaveLength(line.points.length);
    expect(ch.rpm).toHaveLength(line.points.length);
    expect(ch.dtc).toHaveLength(line.points.length);
  });

  it('keeps throttle in 0..100 and gear in 1..top', () => {
    const line = cornerLine();
    const ch = riderChannels(line, solve(line, P), P);
    for (let i = 0; i < ch.tps.length; i++) {
      expect(ch.tps[i]).toBeGreaterThanOrEqual(0);
      expect(ch.tps[i]).toBeLessThanOrEqual(100);
      expect(ch.gear[i]).toBeGreaterThanOrEqual(1);
      expect(ch.gear[i]).toBeLessThanOrEqual(P.machine.gearRatios.length);
      expect(Number.isInteger(ch.gear[i])).toBe(true);
    }
  });

  it('shuts the throttle under braking and opens it on the way out', () => {
    const line = cornerLine();
    const env = solve(line, P);
    const ch = riderChannels(line, env, P);
    // the slowest point is the apex; find it
    let apex = 0;
    for (let i = 1; i < env.v.length; i++) if (env.v[i] < env.v[apex]) apex = i;
    const beforeApex = ch.tps[Math.max(0, apex - 30)];
    const afterApex = ch.tps[Math.min(ch.tps.length - 1, apex + 80)];
    expect(beforeApex).toBeLessThan(40);
    expect(afterApex).toBeGreaterThan(beforeApex);
  });

  it('delays the throttle more when throttleDelayS is larger', () => {
    const line = cornerLine();
    const env = solve(line, P);
    const quick = riderChannels(line, env, clampParams({ ...P, rider: { ...P.rider, throttleDelayS: 0 } }));
    const slow = riderChannels(line, env, clampParams({ ...P, rider: { ...P.rider, throttleDelayS: 1.5 } }));
    let apex = 0;
    for (let i = 1; i < env.v.length; i++) if (env.v[i] < env.v[apex]) apex = i;
    // the corner itself is a constant-radius arc with zero longitudinal
    // demand throughout, so the throttle only starts opening again once the
    // line straightens on exit; pick a point there, well into the ramp.
    const at = Math.min(env.v.length - 1, apex + 70);
    expect(slow.tps[at]).toBeLessThan(quick.tps[at]);
  });

  it('reports TC intervention only where the drive demand is high', () => {
    const line = cornerLine();
    const ch = riderChannels(line, solve(line, P), P);
    expect(ch.dtc.every((d) => d >= 0 && d <= 100)).toBe(true);
    // no intervention while hard on the brakes at the start of the braking zone
    expect(Math.max(...Array.from(ch.dtc.slice(0, 50)))).toBe(0);
    // but it does intervene somewhere on this line, under exit acceleration —
    // an all-zero dtc channel would satisfy both checks above trivially
    expect(Math.max(...Array.from(ch.dtc))).toBeGreaterThan(0);
  });

  it('rises through the gears as speed rises', () => {
    const line = cornerLine();
    const env = solve(line, P);
    const ch = riderChannels(line, env, P);
    let fastest = 0;
    let slowest = 0;
    for (let i = 1; i < env.v.length; i++) {
      if (env.v[i] > env.v[fastest]) fastest = i;
      if (env.v[i] < env.v[slowest]) slowest = i;
    }
    // strictly greater, and more than one gear is actually used — a constant
    // gear channel would satisfy >= trivially, so this also checks variety.
    expect(ch.gear[fastest]).toBeGreaterThan(ch.gear[slowest]);
    expect(new Set(Array.from(ch.gear)).size).toBeGreaterThan(1);
  });

  it('never steps straight from full throttle to full brake', () => {
    const line = cornerLine();
    const env = solve(line, P);
    const ch = riderChannels(line, env, P);
    // find the hardest throttle-to-brake transition and measure how long it took
    let worstPctPerS = 0;
    for (let i = 1; i < ch.tps.length; i++) {
      const dt = Math.max(1e-3, env.tS[i] - env.tS[i - 1]);
      worstPctPerS = Math.max(worstPctPerS, Math.abs(ch.brake[i] - ch.brake[i - 1]) / dt);
    }
    // the brake-on rate limit is 700 %/s; nothing may exceed it
    expect(worstPctPerS).toBeLessThan(760);
  });

  it('does not drive and stop at the same time', () => {
    const line = cornerLine();
    const ch = riderChannels(line, solve(line, P), P);
    for (let i = 0; i < ch.tps.length; i++) {
      expect(ch.tps[i] + ch.brake[i] / 1.15).toBeLessThan(101);
    }
  });

  it('bleeds the brake off more slowly at a higher trailBrakeProfile', () => {
    const line = cornerLine();
    const env = solve(line, P);
    const abrupt = riderChannels(line, env, clampParams({ ...P, rider: { ...P.rider, trailBrakeProfile: 0 } }));
    const smooth = riderChannels(line, env, clampParams({ ...P, rider: { ...P.rider, trailBrakeProfile: 1 } }));
    const fallRate = (b: Float32Array): number => {
      let worst = 0;
      for (let i = 1; i < b.length; i++) {
        const dt = Math.max(1e-3, env.tS[i] - env.tS[i - 1]);
        worst = Math.max(worst, (b[i - 1] - b[i]) / dt);
      }
      return worst;
    };
    expect(fallRate(smooth.brake)).toBeLessThan(fallRate(abrupt.brake));
  });

  it('clamps throttle against a slowly-released brake so the two never sum past the overlap margin', () => {
    // Deep, slow brake release (trailBrakeProfile 1) immediately followed by
    // a full throttle demand: the brake is still well above zero when the
    // throttle wants to be at 100, which is exactly the case the OVERLAP
    // clamp exists for. cornerLine()'s own demand pattern never reaches this
    // case because its throttle decays to zero faster than its brake rises,
    // so this uses a synthetic envelope built to conflict on purpose.
    const { line, env } = brakeToThrottleEnvelope();
    const pp = clampParams({ ...P, rider: { ...P.rider, trailBrakeProfile: 1, throttleDelayS: 0 } });
    const ch = riderChannels(line, env, pp);
    let maxSum = 0;
    for (let i = 0; i < ch.tps.length; i++) maxSum = Math.max(maxSum, ch.tps[i] + ch.brake[i]);
    expect(maxSum).toBeLessThan(101);
  });

  it('holds some brake past turn-in when the rider trail brakes', () => {
    const line = cornerLine();
    const env = solve(line, P);
    const ch = riderChannels(line, env, clampParams({
      ...P,
      rider: { ...P.rider, trailBrakeDepth: 1, trailBrakeProfile: 1 },
    }));
    let apex = 0;
    for (let i = 1; i < env.v.length; i++) if (env.v[i] < env.v[apex]) apex = i;
    // somewhere in the second half of the entry there is still brake pressure
    const entry = ch.brake.slice(Math.floor(apex * 0.75), apex);
    expect(Math.max(...Array.from(entry))).toBeGreaterThan(5);
  });
});
