import { describe, expect, it } from 'vitest';
import { DERIVE_TABLE, DERIVED_KEYS, deriveRider } from '../../src/sim/derive';
import { DEFAULT_SIM_PARAMS } from '../../src/sim/presets';
import { gripFraction } from '../../src/sim/tyre';
import type { DerivedRiderKey, RiderParams, TyreTrackParams } from '../../src/sim/types';

const TYRE: TyreTrackParams = { ...DEFAULT_SIM_PARAMS.tyre, mu: 1.3, muX: 1.1, gripScale: 0.95 };
const rider = (a: number, r: number, overrides: DerivedRiderKey[] = []): RiderParams => ({
  ...DEFAULT_SIM_PARAMS.rider,
  aggressiveness: a,
  risk: r,
  overrides,
});
const num = (r: RiderParams, k: DerivedRiderKey): number => (r as unknown as Record<DerivedRiderKey, number>)[k];

describe('deriveRider', () => {
  it.each([0, 1])('reproduces the DERIVE_TABLE end points at A = R = %d', (x) => {
    const out = deriveRider(rider(x, x), TYRE);
    for (const key of DERIVED_KEYS) {
      if (key === 'brakingG' || key === 'leanUsage') continue; // tyre-curve keys, below
      const t = DERIVE_TABLE[key];
      const want = t.from === 'const' ? t.a : t.a + t.b * x;
      expect(num(out, key), key).toBeCloseTo(want, 12);
    }
  });

  it('derives brakingG as muX * gripScale * g(sBrake) and leanUsage from its own capped map', () => {
    for (const r of [0, 0.3, 0.7, 1]) {
      const out = deriveRider(rider(0.5, r), TYRE);
      expect(out.brakingG).toBeCloseTo(1.1 * 0.95 * gripFraction(out.sBrake, 'long'), 12);
      // calibration 2026-10-11: lean usage is NOT g(sLat) — the owner uses 87 %
      // of the lean limit at the bottom of the risk scale, the BMW reference
      // leans to the limit at R ~0.35, so the map is steep and capped at 1
      const t = DERIVE_TABLE.leanUsage;
      expect(out.leanUsage).toBeCloseTo(Math.min(1, t.a + t.b * r), 12);
    }
  });

  it('falls back to mu for brakingG when muX is not set', () => {
    const out = deriveRider(rider(0.5, 0.5), { ...TYRE, muX: undefined });
    expect(out.brakingG).toBeCloseTo(1.3 * 0.95 * gripFraction(out.sBrake, 'long'), 12);
  });

  it('leaves every key in overrides untouched', () => {
    const base = { ...rider(0.9, 0.9, ['sBrake', 'brakingG', 'throttleDelayS']), sBrake: 0.42, brakingG: 0.77, throttleDelayS: 1.23 };
    const out = deriveRider(base, TYRE);
    expect(out.sBrake).toBe(0.42);
    expect(out.brakingG).toBe(0.77);
    expect(out.throttleDelayS).toBe(1.23);
    // and the others still follow the sliders
    expect(out.sLat).toBeCloseTo(DERIVE_TABLE.sLat.a + DERIVE_TABLE.sLat.b * 0.9, 12);
  });

  it('a pinned sBrake still drives an unpinned brakingG', () => {
    const out = deriveRider({ ...rider(0.5, 0.5, ['sBrake']), sBrake: 0.2 }, TYRE);
    expect(out.brakingG).toBeCloseTo(1.1 * 0.95 * gripFraction(0.2, 'long'), 12);
  });

  it('returns a new object and does not mutate its input', () => {
    const input = rider(0.2, 0.8, ['rollOnS']);
    const snapshot = JSON.stringify(input);
    const out = deriveRider(input, TYRE);
    expect(out).not.toBe(input);
    expect(out.overrides).not.toBe(input.overrides);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('is monotone: more risk never lowers a force-level field', () => {
    let prev = deriveRider(rider(0.5, 0), TYRE);
    for (let r = 0.1; r <= 1.0001; r += 0.1) {
      const cur = deriveRider(rider(0.5, r), TYRE);
      for (const k of ['sBrake', 'sDrive', 'sLat', 'brakingG', 'leanUsage', 'trailBrakeDepth', 'trailBrakeProfile'] as const) {
        expect(cur[k], k).toBeGreaterThanOrEqual(prev[k] - 1e-12);
      }
      prev = cur;
    }
  });

  it('clamps out-of-range sliders and NaN to 0..1', () => {
    const hi = deriveRider(rider(7, 7), TYRE);
    const one = deriveRider(rider(1, 1), TYRE);
    expect(hi.sBrake).toBeCloseTo(one.sBrake, 12);
    const nan = deriveRider(rider(Number.NaN, Number.NaN), TYRE);
    const zero = deriveRider(rider(0, 0), TYRE);
    expect(nan.rollOnS).toBeCloseTo(zero.rollOnS, 12);
  });
});
