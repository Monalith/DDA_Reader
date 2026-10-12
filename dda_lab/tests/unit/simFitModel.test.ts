// The per-corner fit model (src/sim/fitModel.ts) and the reference from any
// loaded lap (src/sim/lapReference.ts) on the Serres pist track model: the
// Ducati Run036 best lap (its own GPS line, gitignored _inbox: skipped when
// absent) and the BMW video lap (hand-placed path, bundled example).
import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { computeDerived } from '../../src/core/derived';
import { detectLaps } from '../../src/core/laps';
import { sessionFromDdaReaderJson } from '../../src/core/sessionLoader';
import type { Lap, Session } from '../../src/core/types';
import { lateralCeilingG } from '../../src/sim/fitRider';
import {
  applyFit,
  buildFitModel,
  cornerErrors,
  fitRows,
  fitSession,
  MIN_SPEED_OFF_KMH,
  slideEntry,
  tunedCaps,
  tunedOffsets,
  type CornerSetting,
  type FitModel,
} from '../../src/sim/fitModel';
import { lapReferenceProblem, referenceFromLap, type LapReference } from '../../src/sim/lapReference';
import { lineFromOffsets } from '../../src/sim/line';
import { clampParams, DEFAULT_SIM_PARAMS } from '../../src/sim/presets';
import { parseReference } from '../../src/sim/reference';
import { solve } from '../../src/sim/solver';
import { loadPistModel } from '../../scripts/lib/fitLines';

const PIST = new URL('../../public/tracks/serres.pist.json', import.meta.url).pathname;
const BMW = new URL('../../public/examples/serres_BMW_1-19-81_v2.json', import.meta.url).pathname;
const DUCATI = '/Users/macbookmini/projects/DDA_Reader/_inbox/Run036-219926-00.00.json';
const HAS_DUCATI = existsSync(DUCATI);

const P = clampParams(DEFAULT_SIM_PARAMS);
const pist = loadPistModel(PIST);
const track = pist.track;
const corridor = pist.corridor ?? undefined;

const cyc = (a: number, b: number, n: number): number => (((b - a) % n) + n) % n;

describe.skipIf(!HAS_DUCATI)('fit model on the Ducati Run036 best lap (measured GPS path)', () => {
  let session: Session;
  let lap: Lap;
  let lr: LapReference;
  let model: FitModel;

  beforeAll(() => {
    session = sessionFromDdaReaderJson(JSON.parse(readFileSync(DUCATI, 'utf8')), 'Run036', '#f00');
    computeDerived(session, track);
    if (!session.laps.length) session.laps = detectLaps(session, track.startFinish, track.sectors);
    lap = session.laps.find((l) => l.isBest) ?? session.laps[0];
    lr = referenceFromLap(session, lap, track);
    model = buildFitModel(track, corridor, P, lr, { budgetMs: 3000 });
  }, 120_000);

  it('referenceFromLap: 16 corners, one apex each (≥ 15 m apart, in order), trusted path, lap time and length', () => {
    const ref = lr.ref;
    expect(lr.pathTrusted).toBe(true);
    expect(ref.corners.length).toBe(16);
    for (let k = 1; k < ref.corners.length; k++) {
      expect(ref.corners[k].apexM).toBeGreaterThan(ref.corners[k - 1].apexM);
      expect(ref.corners[k].apexM - ref.corners[k - 1].apexM).toBeGreaterThanOrEqual(15);
    }
    expect(ref.lapTimeS).toBeCloseTo(lap.timeS, 6);
    expect(Math.abs(ref.lengthM - track.lengthM) / track.lengthM).toBeLessThan(0.1);
  });

  it('lapReferenceProblem: null for the Ducati lap, a reason without GPS', () => {
    expect(lapReferenceProblem(session, lap, track)).toBeNull();
    const channels = new Map(session.channels);
    channels.delete('gps_lon');
    channels.delete('gps_lat');
    const noGps: Session = { ...session, channels, reference: undefined };
    const why = lapReferenceProblem(noGps, lap, track);
    expect(why).toMatch(/GPS/);
    expect(() => referenceFromLap(noGps, lap, track)).toThrow(/GPS/);
  });

  it('applyFit with the fitted settings reproduces the fit stats; neutral settings keep the base line', () => {
    const r = applyFit(track, model, model.fitted);
    const e = cornerErrors(model, r.line, r.env).reduce((a, b) => a + b, 0);
    expect(Math.abs(e - model.stats.errorAfter)).toBeLessThan(1e-6);
    // the fitted κ is the base line's own (path trusted: κ is not refined), no apex shift
    const neutral: CornerSetting[] = model.corners.map((c, k) => ({ ...model.fitted[k], kappa: c.kappaBase, apexShiftM: 0, latScale: 1, brakeScale: 1, exitScale: 1, runScale: 1, slideOut: 0 }));
    const off = tunedOffsets(model, neutral);
    expect(Array.from(off)).toEqual(Array.from(model.baseOffsetsM));
  });

  it('refine lowers the error; median per-corner speed RMS under 3 km/h', () => {
    expect(model.stats.errorAfter).toBeLessThan(model.stats.errorBefore);
    const r = applyFit(track, model, model.fitted);
    const rows = fitRows(model, r.line, r.env, lateralCeilingG(model.params));
    expect(rows.length).toBe(16);
    const v = rows.map((x) => x.vRmsKmh).sort((a, b) => a - b);
    const median = (v[7] + v[8]) / 2;
    expect(median).toBeLessThan(3);
  });

  describe('tuning is local and directional', () => {
    const K = 4;
    const set = (patch: Partial<CornerSetting>): CornerSetting[] => model.fitted.map((s, k) => (k === K ? { ...s, ...patch } : { ...s }));

    it('a higher latScale on one corner raises its apex speed, a corner two away stays within 0.5 km/h', () => {
      // the corner's minimum-speed ceiling off in both runs: with it on, K5's
      // fitted ceiling (−0.9 km/h) binds at its apex and a lateral cap cannot
      // show there (by design: the slower of the two limits wins)
      const OFF = { minSpeedDeltaKmh: MIN_SPEED_OFF_KMH };
      const lat = Math.min(1.4, Math.max(1.2, model.fitted[K].latScale * 1.2));
      const base = applyFit(track, model, set(OFF));
      const up = applyFit(track, model, set({ ...OFF, latScale: lat }));
      const c = model.corners[K];
      const far = model.corners[K + 2];
      expect(up.env.v[c.iApex]).toBeGreaterThan(base.env.v[c.iApex] + 0.1);
      expect(Math.abs(up.env.v[far.iApex] - base.env.v[far.iApex]) * 3.6).toBeLessThan(0.5);
    });

    it('line style κ 1 vs 0 on one corner moves the offsets only near that corner', () => {
      const c = model.corners[K];
      const o0 = tunedOffsets(model, set({ kappa: 0 }));
      const o1 = tunedOffsets(model, set({ kappa: 1 }));
      const n = o0.length;
      const step = model.vertexStepM;
      let changedNear = 0;
      for (let i = 0; i < n; i++) {
        // vertex distance to the zone (0 inside)
        const inZone = cyc(c.zone[0], i, n) <= cyc(c.zone[0], c.zone[1], n);
        const dV = inZone ? 0 : Math.min(cyc(i, c.zone[0], n), cyc(c.zone[1], i, n));
        if (dV * step > 150) expect(o1[i]).toBe(o0[i]);
        else if (o1[i] !== o0[i]) changedNear++;
      }
      expect(changedNear).toBeGreaterThan(0);
    });

    it('a minimum-speed delta of −10 km/h caps the corner minimum; off removes the ceiling', () => {
      const c = model.corners[K];
      const r = applyFit(track, model, set({ minSpeedDeltaKmh: -10 }));
      expect(r.env.v[c.iMin] * 3.6).toBeLessThanOrEqual(c.vMinRefMs * 3.6 - 10 + 0.5);
      const off = tunedCaps(model, set({ minSpeedDeltaKmh: MIN_SPEED_OFF_KMH }));
      expect(off.vMaxMs![c.iMin]).toBe(Infinity);
    });
  });

  describe('slide out', () => {
    // a braking corner (K5 on serres.pist.json: a slow apex after a long stop)
    const pick = (): number => {
      // the corner with the lowest reference apex speed: always a braked corner
      let kb = 0;
      model.corners.forEach((c, k) => {
        if (c.vApexRefMs < model.corners[kb].vApexRefMs) kb = k;
      });
      return kb;
    };
    const withSlide = (k: number, s: number): CornerSetting[] => model.fitted.map((x, j) => ({ ...x, slideOut: j === k ? s : 0 }));

    it('slideOut 0 everywhere is exactly the plain lap (no scrub array, same offsets and speeds)', () => {
      const zero = withSlide(0, 0);
      const caps = tunedCaps(model, zero);
      expect(caps.scrubCoef).toBeUndefined();
      const plain = { ...caps };
      delete (plain as { scrubCoef?: unknown }).scrubCoef;
      const r0 = applyFit(track, model, zero);
      const line = lineFromOffsets(track, tunedOffsets(model, zero));
      const r1 = solve(line, model.params, plain);
      expect(Array.from(r0.env.v)).toEqual(Array.from(r1.v));
      // and the solver without scrubCoef ≡ with an all-zero scrubCoef
      const r2 = solve(line, model.params, { ...plain, scrubCoef: new Float32Array(line.points.length) });
      expect(Array.from(r2.v)).toEqual(Array.from(r1.v));
    });

    it('slideOut 1: faster on the entry (braking ends later), wide before the apex, apex speed close to the plain lap', () => {
      const k = pick();
      const c = model.corners[k];
      const base = applyFit(track, model, withSlide(k, 0));
      const slid = applyFit(track, model, withSlide(k, 1));
      const entry = slideEntry(model, k);
      expect(entry.length).toBeGreaterThan(5);
      // speed carried into the entry: higher at its start
      const i0 = entry[0].i;
      expect(slid.env.v[i0]).toBeGreaterThan(base.env.v[i0] + 0.3);
      // outward (−dir) offset before the apex, peaking mid-entry; the apex point unchanged
      const im = entry[Math.floor(entry.length / 2)].i;
      const dOff = (i: number): number => (slid.line.offsetM![i] - base.line.offsetM![i]) * -c.dir;
      expect(dOff(im)).toBeGreaterThan(0.2);
      expect(Math.abs(dOff(c.iApex))).toBeLessThan(0.05);
      // the scrub takes the extra speed off: apex within 2 km/h
      expect(Math.abs(slid.env.v[c.iApex] - base.env.v[c.iApex]) * 3.6).toBeLessThan(2);
    });
  });

  it('fitSession: a Session with the sim speed and the reference speed / long g', () => {
    const s = fitSession(model, applyFit(track, model, model.fitted), 'fit-test', '#0af');
    for (const ch of ['speed', 'ref_speed_kmh', 'ref_long_g']) expect(s.channels.has(ch)).toBe(true);
    // channels are on the session's time grid (toSession resamples from the line's stations)
    expect(s.channels.get('ref_speed_kmh')!.data.length).toBe(s.t.length);
    expect(s.channels.get('speed')!.data.length).toBe(s.t.length);
  });
});

describe('solver per-station speed ceiling (caps.vMaxMs)', () => {
  const line = lineFromOffsets(track, new Float32Array(track.centerline.length));
  const free = solve(line, P);

  it('an all-Infinity ceiling changes nothing', () => {
    const r = solve(line, P, { vMaxMs: new Float32Array(line.points.length).fill(Infinity) });
    expect(Array.from(r.v)).toEqual(Array.from(free.v));
    expect(r.lapTimeS).toBe(free.lapTimeS);
  });

  it('one finite ceiling caps the speed at that station and slows the lap', () => {
    // the fastest station
    let i0 = 0;
    for (let i = 1; i < free.v.length; i++) if (free.v[i] > free.v[i0]) i0 = i;
    const cap = free.v[i0] - 10;
    const vMax = new Float32Array(line.points.length).fill(Infinity);
    vMax[i0] = cap;
    const r = solve(line, P, { vMaxMs: vMax });
    expect(r.v[i0]).toBeLessThanOrEqual(cap + 1e-3);
    expect(r.lapTimeS).toBeGreaterThan(free.lapTimeS);
  });
});

describe('fit model on the BMW video lap (hand-placed path)', () => {
  it('runs with a 3 s budget: 16 corners, the refine lowers the error', () => {
    const ref = parseReference(JSON.parse(readFileSync(BMW, 'utf8')));
    const m = buildFitModel(track, corridor, P, { ref, pathTrusted: false, label: ref.name }, { budgetMs: 3000 });
    expect(m.pathTrusted).toBe(false);
    expect(m.corners.length).toBe(16);
    expect(m.fitted.length).toBe(16);
    expect(m.stats.errorAfter).toBeLessThan(m.stats.errorBefore);
  }, 60_000);
});
