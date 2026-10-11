import { describe, expect, it } from 'vitest';
import { riderChannels } from '../../src/sim/rider';
import { solve } from '../../src/sim/solver';
import { clampParams, DEFAULT_SIM_PARAMS } from '../../src/sim/presets';
import { circuitTrack, testCaps } from './circuitFixture';
import { findCorners } from '../../src/sim/corners';
import { eventProfile } from '../../src/sim/events';
import { buildLine } from '../../src/sim/line';
import type { Envelope } from '../../src/sim/types';

// v2 (spec §2.7): the rider's brake and throttle ARE the corner-event
// template. The v1 per-sample lag layer and its 20-odd tests (dead-bands,
// event merging, rate limits, the OVERLAP clamp) are gone with it; what they
// guarded — one brake per corner, no simultaneous drive-and-brake, alive
// channels — is asserted here on the event-driven path.

const P = clampParams(DEFAULT_SIM_PARAMS);

/** Rises through 5 % in a cyclic channel. */
const applications = (b: Float32Array): number => {
  let c = 0;
  for (let i = 0; i < b.length; i++) if (b[(i - 1 + b.length) % b.length] < 5 && b[i] >= 5) c++;
  return c;
};

function run(params = P) {
  const line = buildLine(circuitTrack(), undefined, params);
  const env = solve(line, params);
  const ev = eventProfile(line, env, findCorners(line, env.v, params), params, testCaps(line, params));
  /** env with the event speed, as index.ts hands it over. */
  const evEnv: Envelope = { ...env, v: ev.v, tS: ev.tS, lapTimeS: ev.lapTimeS };
  return { line, env, ev, evEnv, ch: riderChannels(line, evEnv, params, ev) };
}

describe('riderChannels from the corner-event profile (v2)', () => {
  const { line, env, ev, evEnv, ch } = run();

  it('produces finite channels of the line length, in range', () => {
    const n = line.points.length;
    for (const [name, data] of Object.entries(ch)) {
      expect(data.length, name).toBe(n);
      for (let i = 0; i < n; i++) expect(Number.isFinite(data[i]), `${name}[${i}]`).toBe(true);
    }
    for (let i = 0; i < n; i++) {
      expect(ch.tps[i]).toBeGreaterThanOrEqual(0);
      expect(ch.tps[i]).toBeLessThanOrEqual(100);
      expect(ch.brake[i]).toBeGreaterThanOrEqual(0);
      expect(ch.brake[i]).toBeLessThanOrEqual(100);
      expect(ch.gear[i]).toBeGreaterThanOrEqual(1);
      expect(ch.gear[i]).toBeLessThanOrEqual(P.machine.gearRatios.length);
    }
  });

  it('takes brake and tps from the events verbatim, no rate limits or dead-bands', () => {
    expect(Array.from(ch.brake)).toEqual(Array.from(ev.brake));
    expect(Array.from(ch.tps)).toEqual(Array.from(ev.tps));
  });

  it('brakes exactly once per section with hasBrake, on the five-corner fixture', () => {
    expect(applications(ch.brake)).toBe(ev.corners.filter((c) => c.hasBrake).length);
    expect(applications(ch.brake)).toBe(5);
  });

  it('never drives and brakes meaningfully at once', () => {
    // the owner's constraint #1 in channel form: a real throttle and a real
    // brake never read at the same sample
    let both = 0;
    let alive = 0;
    for (let i = 0; i < ch.tps.length; i++) {
      if (ch.tps[i] > 20 && ch.brake[i] > 20) both++;
      if (ch.tps[i] > 50 || ch.brake[i] > 50) alive++;
    }
    expect(both).toBe(0);
    expect(alive).toBeGreaterThan(100);
  });

  it('rises through the gears as speed rises', () => {
    let up = 0;
    for (let i = 1; i < ch.gear.length; i++) {
      if (evEnv.v[i] > evEnv.v[i - 1] + 0.5) expect(ch.gear[i]).toBeGreaterThanOrEqual(ch.gear[i - 1]);
      if (ch.gear[i] > ch.gear[i - 1]) up++;
    }
    expect(up).toBeGreaterThan(0);
    expect(Math.max(...ch.gear)).toBeGreaterThan(Math.min(...ch.gear));
  });

  it('reports TC intervention only where the bike is driving', () => {
    for (let i = 0; i < ch.dtc.length; i++) {
      if (env.longG[i] <= 0) expect(ch.dtc[i]).toBe(0);
      expect(ch.dtc[i]).toBeGreaterThanOrEqual(0);
      expect(ch.dtc[i]).toBeLessThanOrEqual(100);
    }
  });

  it('keeps gear, rpm and dtc from the envelope model whether or not events are given', () => {
    const ideal = riderChannels(line, evEnv, P);
    expect(Array.from(ch.gear)).toEqual(Array.from(ideal.gear));
    expect(Array.from(ch.rpm)).toEqual(Array.from(ideal.rpm));
    expect(Array.from(ch.dtc)).toEqual(Array.from(ideal.dtc));
  });

  it('without ev (optimal modes) reads brake and throttle off the longitudinal g', () => {
    const ideal = riderChannels(line, env, P);
    for (let i = 0; i < env.longG.length; i++) {
      if (env.longG[i] > 0.05) {
        expect(ideal.tps[i]).toBeGreaterThan(0);
        expect(ideal.brake[i]).toBe(0);
      } else if (env.longG[i] < -0.05) {
        expect(ideal.brake[i]).toBeGreaterThan(0);
        expect(ideal.tps[i]).toBe(0);
      }
    }
  });
});
