// Per-corner overrides of the virtual rider's own keys (src/sim/cornerRider.ts)
// and the rider mode riding them (src/sim/index.ts), on the pist Serres model.
import { beforeAll, describe, expect, it } from 'vitest';
import type { TrackModel } from '../../src/core/types';
import { eventCaps, simulate } from '../../src/sim';
import {
  brakeOwnerAt,
  cornerZones,
  driveOwnerAt,
  hasCornerOverrides,
  riderAt,
  riderCapsForLine,
  riderLine,
  TAPER_M,
  zoneOwnerAt,
  type CornerZone,
} from '../../src/sim/cornerRider';
import { findCorners } from '../../src/sim/corners';
import { eventProfile } from '../../src/sim/events';
import { buildLine } from '../../src/sim/line';
import { clampParams, DEFAULT_SIM_PARAMS } from '../../src/sim/presets';
import { solve } from '../../src/sim/solver';
import type { Line, SimParams } from '../../src/sim/types';
import { loadPistModel } from '../../scripts/lib/fitLines';

const pist = loadPistModel(new URL('../../public/tracks/serres-v6.pist.json', import.meta.url).pathname);
const track = pist.track;
const corridor = pist.corridor ?? undefined;
const P = clampParams(DEFAULT_SIM_PARAMS);
const withCorners = (corners: NonNullable<SimParams['rider']['corners']>, extra: Partial<SimParams['rider']> = {}): SimParams => ({
  ...P,
  rider: { ...P.rider, ...extra, corners },
});

let base: Line;
let zones: CornerZone[];
beforeAll(() => {
  base = buildLine(track, corridor, P);
  zones = cornerZones(base, track);
});

const zoneOf = (n: number): CornerZone => zones.find((z) => z.n === n)!;
/** Stations of a zone (wrapping). */
const stationsOf = (z: CornerZone, n: number): number[] => {
  const out: number[] = [];
  for (let i = z.i0; ; i = (i + 1) % n) {
    out.push(i);
    if (i === z.i1) break;
  }
  return out;
};

describe('cornerZones', () => {
  it('maps every track turn onto the line, apex inside its zone', () => {
    expect(zones.length).toBe(track.turns.length);
    expect(zones.length).toBe(16);
    const n = base.points.length;
    for (const z of zones) {
      expect(stationsOf(z, n)).toContain(z.iApex);
      // sRange metres → stations (2 m centreline spacing)
      const t = track.turns.find((x) => x.n === z.n)!;
      expect(Math.abs(base.cumDistM[z.i0] - t.sRange[0])).toBeLessThan(3);
    }
  });

  it('a zone across the start line wraps (i0 > i1) and owns the stations either side of it', () => {
    const L = track.lengthM;
    const wrapped: TrackModel = { ...track, turns: track.turns.map((t) => (t.n === 1 ? { ...t, sRange: [L - 30, 50] as [number, number] } : t)) };
    const zw = cornerZones(base, wrapped);
    const k1 = zw.findIndex((z) => z.n === 1);
    const z1 = zw[k1];
    expect(z1.i0).toBeGreaterThan(z1.i1);
    expect(zoneOwnerAt(zw, 0)).toBe(k1);
    expect(zoneOwnerAt(zw, base.points.length - 5)).toBe(k1);
    expect(zoneOwnerAt(zw, z1.i1 + 10)).not.toBe(k1);
  });
});

describe('riderAt / hasCornerOverrides', () => {
  it('without overrides: the lap-wide rider itself', () => {
    expect(hasCornerOverrides(P)).toBe(false);
    expect(hasCornerOverrides(withCorners({}))).toBe(false);
    expect(hasCornerOverrides(withCorners({ 3: {} }))).toBe(false);
    expect(riderAt(P, zones, 100)).toBe(P.rider);
    const p = withCorners({});
    expect(riderAt(p, zones, 100)).toBe(p.rider);
  });

  it('true for any corner value or a lap-wide slide out', () => {
    expect(hasCornerOverrides(withCorners({ 3: { sLat: 0.5 } }))).toBe(true);
    expect(hasCornerOverrides({ ...P, rider: { ...P.rider, slideOut: 0.2 } })).toBe(true);
  });

  it('zone keys in the zone, brake keys on the approach, drive keys on the exit', () => {
    const p = withCorners({ 3: { sLat: 0.5, sBrake: 0.3, rollOnS: 2 } });
    const z3 = zoneOf(3);
    const k3 = zones.indexOf(z3);
    const z2 = zoneOf(2);
    // at the apex: all three (brake owner = this apex, drive owner = this apex)
    const atApex = riderAt(p, zones, z3.iApex);
    expect(atApex.sLat).toBe(0.5);
    expect(atApex.sBrake).toBe(0.3);
    expect(atApex.rollOnS).toBe(2);
    // the approach, after K2's apex and before K3's zone: braking into K3
    const iApp = z3.i0 - 10;
    expect(iApp).toBeGreaterThan(z2.iApex);
    expect(brakeOwnerAt(zones, iApp)).toBe(k3);
    const app = riderAt(p, zones, iApp);
    expect(app.sBrake).toBe(0.3);
    expect(app.sLat).toBe(P.rider.sLat);
    expect(app.rollOnS).toBe(P.rider.rollOnS);
    // the exit run after K3's zone, before K4's apex: driving out of K3
    const iRun = z3.i1 + 5;
    expect(driveOwnerAt(zones, iRun)).toBe(k3);
    const run = riderAt(p, zones, iRun);
    expect(run.rollOnS).toBe(2);
    expect(run.sBrake).not.toBe(0.3);
    // another corner: lap-wide
    expect(riderAt(p, zones, zoneOf(8).iApex)).toBe(p.rider);
  });

  it('clamps a corner value to the slider bounds', () => {
    const p = withCorners({ 3: { sLat: 5, throttleDelayS: -1 } });
    const r = riderAt(p, zones, zoneOf(3).iApex);
    expect(r.sLat).toBe(1);
    expect(r.throttleDelayS).toBe(0);
  });
});

describe('no overrides: byte-identical to the lap-wide rider', () => {
  it('riderCapsForLine is undefined and riderLine is buildLine', () => {
    expect(riderCapsForLine(base, P, zones)).toBeUndefined();
    expect(riderCapsForLine(base, withCorners({}), zones)).toBeUndefined();
    const { line } = riderLine(track, corridor, withCorners({}));
    expect(Array.from(line.offsetM)).toEqual(Array.from(base.offsetM));
    expect(line.lengthM).toBe(base.lengthM);
  });

  it("simulate(…, 'rider') with empty corners = the previous buildLine → solve → findCorners → eventProfile path", () => {
    const r = simulate(track, corridor, withCorners({}), 'sim', 'x', '#fff', 'rider');
    // the pre-2026-10-14 rider path, verbatim
    const line = buildLine(track, corridor, P);
    const qss = solve(line, P);
    const ev = eventProfile(line, qss, findCorners(line, qss.v, P), P, eventCaps(line, P));
    expect(r.lapTimeS).toBe(ev.lapTimeS);
    expect(Array.from(r.envelope.v)).toEqual(Array.from(ev.v));
    expect(r.zones?.length).toBe(16);
  });
});

describe('overrides', () => {
  it('a κ override moves the offsets only inside its zone and the 25 m taper', () => {
    const z = zoneOf(3);
    const p = withCorners({ 3: { kappa: 0 } });
    const { line } = riderLine(track, corridor, p);
    const n = base.points.length;
    const taper = Math.round(TAPER_M / (base.lengthM / n)) + 1;
    let inside = 0;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(line.offsetM[i] - base.offsetM[i]);
      const fromZone = Math.min((z.i0 - i + n) % n, (i - z.i1 + n) % n);
      const inZone = stationsOf(z, n).includes(i);
      if (!inZone && fromZone > taper) expect(d).toBe(0);
      if (inZone) inside = Math.max(inside, d);
    }
    expect(inside).toBeGreaterThan(0.3);
  });

  it('a slide out widens the entry toward the outside, scrubs, and is back on the line at the apex', () => {
    const z = zoneOf(5); // a right-hander: outside = left = positive offset
    expect(z.dir).toBe('R');
    const p = withCorners({ 5: { slideOut: 1 } });
    const { line, zones: zz } = riderLine(track, corridor, p);
    const n = base.points.length;
    const mid = (z.i0 + Math.round((z.iApex - z.i0) / 3) + n) % n;
    expect(line.offsetM[mid] - base.offsetM[mid]).toBeGreaterThan(0.1);
    expect(Math.abs(line.offsetM[z.iApex] - base.offsetM[z.iApex])).toBeLessThan(1e-3);
    const caps = riderCapsForLine(line, p, zz)!;
    expect(caps.scrubCoef).toBeDefined();
    expect(caps.scrubCoef![mid]).toBeGreaterThan(0);
    expect(caps.scrubCoef![zoneOf(10).iApex]).toBe(0);
  });

  it('a corner sLat lowers the lateral cap in its zone only and slows the lap', () => {
    const z = zoneOf(3);
    const p = withCorners({ 3: { sLat: 0.3 } });
    const caps = riderCapsForLine(base, p, zones)!;
    const lapWide = riderCapsForLine(base, withCorners({ 3: { sLat: P.rider.sLat } }), zones)!;
    expect(caps.aLatMs2![z.iApex]).toBeLessThan(lapWide.aLatMs2![z.iApex] - 0.5);
    const far = zoneOf(10).iApex;
    expect(caps.aLatMs2![far]).toBe(lapWide.aLatMs2![far]);
    const a = simulate(track, corridor, P, 'sim', 'x', '#fff');
    const b = simulate(track, corridor, p, 'sim', 'x', '#fff');
    expect(b.lapTimeS).toBeGreaterThan(a.lapTimeS + 0.1);
    expect(b.envelope.v[z.iApex]).toBeLessThan(a.envelope.v[z.iApex]);
  });

  it('per-corner timing keys reach the event template (throttle delay / roll-on on the exit)', () => {
    const a = simulate(track, corridor, P, 'sim', 'x', '#fff');
    const b = simulate(track, corridor, withCorners({ 10: { throttleDelayS: 1.5, rollOnS: 3 } }), 'sim', 'x', '#fff');
    expect(b.lapTimeS).toBeGreaterThan(a.lapTimeS + 0.05);
  });
});
