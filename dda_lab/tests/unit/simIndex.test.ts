import { describe, expect, it } from 'vitest';
import { effectiveMu } from '../../src/sim/tyre';
import { stoppieLimitMs2 } from '../../src/sim/vehicle';
import { envelopeFromEvent, eventCaps, idealParams, simulate } from '../../src/sim';
import { buildLine } from '../../src/sim/line';
import { clampParams, DEFAULT_SIM_PARAMS } from '../../src/sim/presets';
import { G, lossDecelMs2, solve } from '../../src/sim/solver';
import type { EventProfile } from '../../src/sim/events';
import { circuitTrack } from './circuitFixture';

const { track, corridor } = circuitTrack(6, 2, 0.25);
const P = clampParams(DEFAULT_SIM_PARAMS);

describe('simulate() — rider mode', () => {
  it('returns corners and a sim session with brake and tps channels', () => {
    const r = simulate(track, corridor, P, 'sim', 'Virtual rider', '#fff');
    expect(r.mode).toBe('rider');
    expect(Array.isArray(r.corners)).toBe(true);
    expect(r.session.isSim).toBe(true);
    expect(r.session.channels.has('brake')).toBe(true);
    expect(r.session.channels.has('tps')).toBe(true);
    expect(Number.isFinite(r.lapTimeS)).toBe(true);
    expect(r.lapTimeS).toBeGreaterThan(0);
  });

  it("defaults to 'rider' and matches an explicit 'rider' call", () => {
    const a = simulate(track, corridor, P, 'sim', 'x', '#fff');
    const b = simulate(track, corridor, P, 'sim', 'x', '#fff', 'rider');
    expect(a.lapTimeS).toBe(b.lapTimeS);
  });

  it('the lap time is the event profile, never faster than the QSS envelope', () => {
    const line = buildLine(track, corridor, P);
    const env = solve(line, P);
    const r = simulate(track, corridor, P, 'sim', 'x', '#fff');
    expect(r.lapTimeS).toBeGreaterThanOrEqual(env.lapTimeS - 1e-9);
  });
});

describe('envelopeFromEvent', () => {
  const line = buildLine(track, corridor, P);
  const env = solve(line, P);

  it('returns the envelope unchanged when the events do not bind', () => {
    const ev: EventProfile = { v: Float32Array.from(env.v), brake: new Float32Array(env.v.length), tps: new Float32Array(env.v.length), tS: env.tS, lapTimeS: env.lapTimeS, corners: [] };
    expect(envelopeFromEvent(line, env, ev)).toBe(env);
  });

  it('takes v, tS and lap time from the events and recomputes the g channels from v', () => {
    const v = Float32Array.from(env.v, (x) => x * 0.9);
    const tS = Float64Array.from(env.tS, (t) => t / 0.9);
    const ev: EventProfile = { v, brake: new Float32Array(v.length), tps: new Float32Array(v.length), tS, lapTimeS: env.lapTimeS / 0.9, corners: [] };
    const out = envelopeFromEvent(line, env, ev);
    expect(out.v).toBe(v);
    expect(out.tS).toBe(tS);
    expect(out.lapTimeS).toBeCloseTo(env.lapTimeS / 0.9, 9);
    for (let i = 0; i < v.length; i += 37) {
      expect(out.latG[i]).toBeCloseTo((v[i] * v[i] * line.curvature[i]) / G, 4);
      // longG scales with v^2 exactly
      expect(out.longG[i]).toBeCloseTo(env.longG[i] * 0.81, 3);
      // the app's lean convention survives: left = negative, opposite to latG.
      // Gated on the BIKE lean, not on latG: with the rider hanging off, the
      // bike itself stays upright below ~0.15 g (vehicle.ts clamps the crown/
      // hang-off correction at zero), so a small latG legitimately has lean 0.
      if (Math.abs(out.leanDeg[i]) > 0.5) expect(Math.sign(out.leanDeg[i])).toBe(-Math.sign(out.latG[i]));
      expect(Math.abs(out.leanDeg[i])).toBeLessThanOrEqual(Math.abs(env.leanDeg[i]) + 1e-4);
    }
  });
});

describe('eventCaps', () => {
  const line = buildLine(track, corridor, P);
  const caps = eventCaps(line, P);
  const straight = line.curvature.findIndex((k) => Math.abs(k) < 1e-5);

  it('brakes with the tyre at min(μ_brake_eff, stoppie) upright, without drag', () => {
    expect(straight).toBeGreaterThanOrEqual(0);
    // v2 caps (W1): the rider's allowed-slip μ on the front, or the stoppie
    // limit if that binds first; `brakingG` only acts when pinned.
    const want = Math.min(effectiveMu(P.tyre, P.rider).brake * G, stoppieLimitMs2(P.machine, 0));
    // |κ| < 1e-5 is not exactly 0: a few micro-g of lateral use remain
    expect(caps.brakeCapMs2(straight, 50)).toBeCloseTo(want, 4);
    expect(caps.brakeCapMs2(straight, 50)).toBeLessThanOrEqual(want);
  });

  it('drives no harder than the engine power allows and passes losses through', () => {
    const v = 60;
    expect(caps.driveCapMs2(straight, v)).toBeLessThanOrEqual((P.machine.powerKw * 1000) / (P.machine.massKg * v) + 1e-9);
    expect(caps.lossDecelMs2(v)).toBeCloseTo(lossDecelMs2(P.machine, v), 12);
  });

  it('leaves less longitudinal grip at lean than upright', () => {
    const apex = line.curvature.reduce((b, k, i) => (Math.abs(k) > Math.abs(line.curvature[b]) ? i : b), 0);
    const vApex = Math.sqrt(0.9 * P.tyre.mu * G / Math.abs(line.curvature[apex]));
    expect(caps.brakeCapMs2(apex, vApex)).toBeLessThan(caps.brakeCapMs2(straight, vApex));
    expect(caps.driveCapMs2(apex, vApex)).toBeLessThanOrEqual(caps.driveCapMs2(straight, vApex));
  });
});

describe('simulate() — optimal modes', () => {
  it('idealParams puts the rider at the tyre ceiling', () => {
    const ip = idealParams(P);
    expect(ip.rider.sBrake).toBe(1);
    expect(ip.rider.sDrive).toBe(1);
    expect(ip.rider.sLat).toBe(1);
    expect(ip.rider.rollRateFrac).toBe(1);
    expect(ip.rider.leanUsage).toBe(1);
    expect(ip.rider.brakingG).toBeCloseTo((P.tyre.muX ?? P.tyre.mu) * P.tyre.gripScale, 12);
    // machine and tyre untouched
    expect(ip.machine).toEqual(P.machine);
    expect(ip.tyre).toEqual(P.tyre);
  });

  it('builds the line from the optimiser offsets', () => {
    const offsetsM = buildLine(track, corridor, { ...P, rider: { ...P.rider, lineDeviationM: 0 } }).offsetM;
    const r = simulate(track, corridor, P, 'sim-opt', 'Ideal line', '#0ff', 'freeTrajectory', { offsetsM });
    expect(r.mode).toBe('freeTrajectory');
    expect(Array.from(r.line.offsetM)).toEqual(Array.from(offsetsM));
    expect(r.session.isSim).toBe(true);
    expect(r.session.id).toBe('sim-opt');
    // the ideal rider is at least as fast as the human on the same geometry
    const human = simulate(track, corridor, { ...P, rider: { ...P.rider, lineDeviationM: 0 } }, 'sim', 'x', '#fff');
    expect(r.lapTimeS).toBeLessThanOrEqual(human.lapTimeS + 1e-6);
  });

  it('uses a supplied speed profile (OCP) for v and the lap time', () => {
    const n = track.centerline.length;
    const offsetsM = new Float32Array(n);
    const vMs = new Float32Array(n).fill(30);
    const r = simulate(track, corridor, P, 'sim-ocp', 'OCP', '#f0f', 'ocp', { offsetsM, vMs });
    expect(r.lapTimeS).toBeCloseTo(r.line.lengthM / 30, 3);
    const speed = r.session.channels.get('speed')!.data;
    for (let i = 0; i < speed.length; i += 50) expect(speed[i]).toBeCloseTo(108, 3);
  });

  it('refuses offsets that do not match the track', () => {
    expect(() => simulate(track, corridor, P, 'sim-opt', 'x', '#fff', 'freeTrajectory', { offsetsM: new Float32Array(3) })).toThrow(RangeError);
  });
});
