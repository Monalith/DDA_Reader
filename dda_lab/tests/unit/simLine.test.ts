import { describe, expect, it } from 'vitest';
import { buildLine, curvatureVariance, effectiveHalfWidths } from '../../src/sim/line';
import { DEFAULT_SIM_PARAMS } from '../../src/sim/presets';
import type { Corridor } from '../../src/sim/types';
import type { LngLat, TrackModel } from '../../src/core/types';

/** A circular track of `radiusM`, sampled every ~2 m, with a uniform corridor. */
function circleTrack(radiusM: number, halfWidthM: number): { track: TrackModel; corridor: Corridor } {
  const lat0 = 41.073;
  const lng0 = 23.518;
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const n = Math.max(64, Math.round((2 * Math.PI * radiusM) / 2));
  const centerline: LngLat[] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    centerline.push([lng0 + (radiusM * Math.cos(a)) / mPerDegLng, lat0 + (radiusM * Math.sin(a)) / mPerDegLat]);
  }
  const cum = new Float64Array(n);
  const step = (2 * Math.PI * radiusM) / n;
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + step;
  const track: TrackModel = {
    id: 'c', name: 'circle', center: [lng0, lat0], centerline, cumDistM: cum, lengthM: step * n,
    startFinish: { id: 'sf', name: 'SF', type: 'sf', at: centerline[0], bearingDeg: 0, halfWidthM: 15 },
    sectors: [], turns: [],
  };
  const corridor: Corridor = {
    stepM: step,
    leftM: new Float32Array(n).fill(halfWidthM),
    rightM: new Float32Array(n).fill(halfWidthM),
    known: new Array(n).fill(true),
  };
  return { track, corridor };
}

/**
 * An oval (`straightM` straights, `radiusM` semicircular ends) whose first few
 * vertices are packed `packedDsM` apart and the rest `dsM` apart — a stand-in
 * for the way a real centerline's sampling density varies around a lap.
 */
function ovalTrack(
  radiusM: number,
  straightM: number,
  halfWidthM: number,
  dsM = 2,
  packedDsM = dsM,
  packedCount = 0,
): { track: TrackModel; corridor: Corridor; arcFrom: number; arcTo: number } {
  const lat0 = 41.073;
  const lng0 = 23.518;
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const pts: Array<[number, number]> = [];
  const step = (): number => (pts.length < packedCount ? packedDsM : dsM);
  for (let s = 0; s < straightM; s += step()) pts.push([s, -radiusM]);
  const arcFrom = pts.length;
  const arc = Math.PI * radiusM;
  for (let s = 0; s < arc; s += step()) {
    const a = -Math.PI / 2 + s / radiusM;
    pts.push([straightM + radiusM * Math.cos(a), radiusM * Math.sin(a)]);
  }
  const arcTo = pts.length - 1;
  for (let s = 0; s < straightM; s += step()) pts.push([straightM - s, radiusM]);
  for (let s = 0; s < arc; s += step()) {
    const a = Math.PI / 2 + s / radiusM;
    pts.push([radiusM * Math.cos(a), radiusM * Math.sin(a)]);
  }
  const n = pts.length;
  const centerline: LngLat[] = pts.map(([x, y]) => [lng0 + x / mPerDegLng, lat0 + y / mPerDegLat]);
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    cum[i] = cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  const lengthM = cum[n - 1] + Math.hypot(pts[0][0] - pts[n - 1][0], pts[0][1] - pts[n - 1][1]);
  const track: TrackModel = {
    id: 'o', name: 'oval', center: [lng0, lat0], centerline, cumDistM: cum, lengthM,
    startFinish: { id: 'sf', name: 'SF', type: 'sf', at: centerline[0], bearingDeg: 0, halfWidthM: 15 },
    sectors: [], turns: [],
  };
  const corridor: Corridor = {
    stepM: lengthM / Math.max(1, n - 1),
    leftM: new Float32Array(n).fill(halfWidthM),
    rightM: new Float32Array(n).fill(halfWidthM),
    known: new Array(n).fill(true),
  };
  return { track, corridor, arcFrom, arcTo };
}

describe('buildLine', () => {
  it('produces one point per centerline vertex and stays inside the corridor', () => {
    const { track, corridor } = circleTrack(100, 6);
    const line = buildLine(track, corridor, DEFAULT_SIM_PARAMS);
    expect(line.points).toHaveLength(track.centerline.length);
    const margin = DEFAULT_SIM_PARAMS.tyre.kerbMarginM + 1e-6;
    for (let i = 0; i < line.offsetM.length; i++) {
      expect(line.offsetM[i]).toBeLessThanOrEqual(corridor.leftM[i] + margin);
      expect(line.offsetM[i]).toBeGreaterThanOrEqual(-(corridor.rightM[i] + margin));
    }
  });

  it('actually uses the corridor rather than the default fallback width', () => {
    // A corridor narrower than buildLine's own default fallback (5 m): if
    // buildLine ignored the corridor argument and fell back to the default,
    // this bound would be violated. Guards against the fallback test's
    // default (5 m) happening to be wider than every corridor under test,
    // which would let a "corridor ignored" bug slip through unnoticed.
    const { track, corridor } = circleTrack(100, 3);
    const line = buildLine(track, corridor, DEFAULT_SIM_PARAMS);
    const margin = DEFAULT_SIM_PARAMS.tyre.kerbMarginM + 1e-6;
    for (let i = 0; i < line.offsetM.length; i++) {
      expect(line.offsetM[i]).toBeLessThanOrEqual(corridor.leftM[i] + margin);
      expect(line.offsetM[i]).toBeGreaterThanOrEqual(-(corridor.rightM[i] + margin));
    }
  });

  it('trades line length for corner radius monotonically across kappa', () => {
    // kappa = 0 is minimum curvature: the widest arc the corridor allows, so
    // the LONGEST line and the LARGEST radius. kappa = 1 is minimum distance:
    // the shortest line, taken by cutting to the inside, so the SMALLEST
    // radius. On a constant-radius circle with a uniform corridor both
    // quantities are unambiguous and there is no corridor shape for the
    // solver to exploit instead, so the ordering has to come from kappa.
    //
    // This replaces an earlier `curvatureVariance(kappa=0) < (kappa=1)` check
    // whose two values on this fixture differ only at noise level, and which
    // the previous (diverging) solver passed by crossing its own instability.
    const { track, corridor } = circleTrack(60, 8);
    const at = (kappa: number) =>
      buildLine(track, corridor, {
        ...DEFAULT_SIM_PARAMS,
        rider: { ...DEFAULT_SIM_PARAMS.rider, kappa, lineDeviationM: 0 },
      });
    const kappas = [0, 0.25, 0.5, 0.75, 1];
    const lines = kappas.map(at);
    const minRadius = (l: ReturnType<typeof at>): number => {
      let maxK = 0;
      for (let i = 0; i < l.curvature.length; i++) maxK = Math.max(maxK, Math.abs(l.curvature[i]));
      return 1 / maxK;
    };
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i].lengthM).toBeLessThan(lines[i - 1].lengthM);
      expect(minRadius(lines[i])).toBeLessThan(minRadius(lines[i - 1]));
    }
    // and the span is a real one, not a rounding difference
    expect(lines[0].lengthM - lines[4].lengthM).toBeGreaterThan(5);
    expect(minRadius(lines[0]) - minRadius(lines[4])).toBeGreaterThan(1);
  });

  it('keeps the offsets inside the corridor with no rider deviation at all', () => {
    // C2: every other containment test runs at the default lineDeviationM of
    // 0.4, where the wander block's own clamp silently re-imposes the box —
    // so deleting the clamp inside the Gauss-Seidel sweep left them all
    // green. With lineDeviationM = 0 the wander block does not run and the
    // sweep's clamp is the only thing holding the line on the track.
    //
    // The corridor has to be narrow enough for the clamp to actually bind:
    // minimising curvature around a closed loop has no bounded solution (you
    // cannot straighten a circle), so the unclamped sweep drifts steadily
    // outwards and the corridor is what stops it. On a 30 m circle it reaches
    // ~3.5 m against this corridor's 0.6 m box.
    const { track, corridor } = circleTrack(30, 0.5);
    for (const kappa of [0, 0.5, 1]) {
      const line = buildLine(track, corridor, {
        ...DEFAULT_SIM_PARAMS,
        rider: { ...DEFAULT_SIM_PARAMS.rider, kappa, lineDeviationM: 0 },
      });
      const margin = DEFAULT_SIM_PARAMS.tyre.kerbMarginM + 1e-6;
      for (let i = 0; i < line.offsetM.length; i++) {
        expect(line.offsetM[i]).toBeLessThanOrEqual(corridor.leftM[i] + margin);
        expect(line.offsetM[i]).toBeGreaterThanOrEqual(-(corridor.rightM[i] + margin));
      }
    }
  });

  it('a non-zero lineDeviationM actually moves the line', () => {
    // I2: making wander() return 0 left every test green — only its clamp was
    // tested, never its effect. The corridor here is wide enough that the
    // deviation has room to show up without the box eating it.
    const { track, corridor } = circleTrack(100, 8);
    const ideal = buildLine(track, corridor, {
      ...DEFAULT_SIM_PARAMS,
      rider: { ...DEFAULT_SIM_PARAMS.rider, lineDeviationM: 0 },
    });
    const wandering = buildLine(track, corridor, {
      ...DEFAULT_SIM_PARAMS,
      rider: { ...DEFAULT_SIM_PARAMS.rider, lineDeviationM: 1.5 },
    });
    let maxDiff = 0;
    for (let i = 0; i < ideal.offsetM.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(wandering.offsetM[i] - ideal.offsetM[i]));
    }
    // 1.5 m RMS deviation, scaled by 1.4 in buildLine, must move the line by
    // at least a good fraction of a metre somewhere around the lap
    expect(maxDiff).toBeGreaterThan(0.5);
  });

  it('falls back to a uniform half width when there is no corridor', () => {
    const { track } = circleTrack(100, 6);
    const line = buildLine(track, undefined, DEFAULT_SIM_PARAMS, 5);
    expect(line.points).toHaveLength(track.centerline.length);
    for (let i = 0; i < line.offsetM.length; i++) {
      expect(Math.abs(line.offsetM[i])).toBeLessThanOrEqual(5 + DEFAULT_SIM_PARAMS.tyre.kerbMarginM + 1e-6);
    }
  });

  it('clamps the deviation so a huge lineDeviationM cannot push the line off track', () => {
    const { track, corridor } = circleTrack(100, 6);
    const line = buildLine(track, corridor, {
      ...DEFAULT_SIM_PARAMS,
      rider: { ...DEFAULT_SIM_PARAMS.rider, lineDeviationM: 50 },
    });
    const margin = DEFAULT_SIM_PARAMS.tyre.kerbMarginM + 1e-6;
    for (let i = 0; i < line.offsetM.length; i++) {
      expect(line.offsetM[i]).toBeLessThanOrEqual(corridor.leftM[i] + margin);
      expect(line.offsetM[i]).toBeGreaterThanOrEqual(-(corridor.rightM[i] + margin));
    }
  });

  it('stays inside the measured width where the corridor is unknown', () => {
    // I1: the old code used a flat `fallbackHalfWidthM` (5 m) at every
    // unknown vertex, so on a narrow circuit with unknown stretches — 35 % of
    // vertices on the real circuit — the line ran metres outside the asphalt
    // that WAS measured either side of the gap. Here every KNOWN vertex reads
    // 1 m, so any sane interpolation across the gaps is also 1 m, and the
    // bound is independent of how the interpolation is implemented.
    const { track, corridor } = circleTrack(30, 1);
    const n = corridor.known.length;
    // long unknown runs (20 of every 50 vertices), so a drifting solve has
    // room to escape rather than being held by its known neighbours
    for (let i = 0; i < n; i++) corridor.known[i] = i % 50 >= 20;
    expect(corridor.known.filter((k) => !k).length).toBeGreaterThan(n * 0.3);
    const line = buildLine(track, corridor, {
      ...DEFAULT_SIM_PARAMS,
      rider: { ...DEFAULT_SIM_PARAMS.rider, kappa: 0, lineDeviationM: 0 },
    });
    const bound = 1 + DEFAULT_SIM_PARAMS.tyre.kerbMarginM + 1e-6;
    for (let i = 0; i < line.offsetM.length; i++) {
      expect(Math.abs(line.offsetM[i])).toBeLessThanOrEqual(bound);
    }
  });

  it('interpolates unknown half-widths between the nearest known neighbours', () => {
    const corridor: Corridor = {
      stepM: 1,
      leftM: Float32Array.from([2, 0, 0, 0, 0, 12, 0, 0, 0, 0]),
      rightM: Float32Array.from([3, 0, 0, 0, 0, 7, 0, 0, 0, 0]),
      known: [true, false, false, false, false, true, false, false, false, false],
    };
    const { leftM, rightM } = effectiveHalfWidths(10, corridor, 5);
    // known vertices untouched
    expect(leftM[0]).toBeCloseTo(2, 6);
    expect(leftM[5]).toBeCloseTo(12, 6);
    // i=2: 2 steps past vertex 0, 3 steps before vertex 5 -> w = 0.4
    expect(leftM[2]).toBeCloseTo(2 * 0.6 + 12 * 0.4, 5);
    expect(rightM[2]).toBeCloseTo(3 * 0.6 + 7 * 0.4, 5);
    // i=7 wraps: 2 steps past vertex 5, 3 steps before vertex 0 -> w = 0.4
    expect(leftM[7]).toBeCloseTo(12 * 0.6 + 2 * 0.4, 5);
    expect(rightM[7]).toBeCloseTo(7 * 0.6 + 3 * 0.4, 5);
    // nothing known anywhere -> the flat fallback, which is the only case it
    // is actually the right answer for
    const none = effectiveHalfWidths(10, { ...corridor, known: new Array(10).fill(false) }, 5);
    for (let i = 0; i < 10; i++) {
      expect(none.leftM[i]).toBe(5);
      expect(none.rightM[i]).toBe(5);
    }
  });

  it('treats a non-finite stored width as unknown instead of throwing', () => {
    // I6: the finiteness guard checked leftM only, so a NaN in rightM with
    // known = true propagated through the box into fromLocalM. buildLine is
    // public and takes a plain Corridor, so it must degrade, not throw.
    const { track, corridor } = circleTrack(100, 6);
    corridor.rightM[5] = NaN;
    corridor.leftM[9] = NaN;
    const line = buildLine(track, corridor, DEFAULT_SIM_PARAMS);
    expect(line.offsetM.every(Number.isFinite)).toBe(true);
    expect(line.points.every(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat))).toBe(true);
    expect(Number.isFinite(line.lengthM)).toBe(true);
  });

  it('sizes the curvature stencil from the whole lap, not the first few segments', () => {
    // I5: polylineCurvature estimated its vertex spacing from the first 10
    // segments and applied the resulting index stencil everywhere, so on a
    // centerline whose sampling density varies the stencil was the wrong
    // PHYSICAL length everywhere but the start. Here the first 40 vertices sit
    // 0.2 m apart and the rest 2 m apart: the first-10 estimate gives a
    // +-50-vertex stencil, which on the 2 m stretches spans +-100 m and
    // reaches right across the 60 m-radius end onto both straights. The
    // lap-wide average (~1.9 m, as corridor.ts's stencilK takes it) gives
    // +-5 vertices = +-10 m, which is the stencil that was intended.
    const { track, corridor, arcFrom, arcTo } = ovalTrack(60, 300, 0.02, 2, 0.1, 40);
    const line = buildLine(track, corridor, {
      ...DEFAULT_SIM_PARAMS,
      rider: { ...DEFAULT_SIM_PARAMS.rider, lineDeviationM: 0 },
    });
    // corridor pinned to the centerline, so the line IS the oval: mid-arc
    // curvature must read 1/60 whatever the sampling density
    const mid = Math.round((arcFrom + arcTo) / 2);
    expect(Math.abs(line.curvature[mid])).toBeGreaterThan(0.8 / 60);
    expect(Math.abs(line.curvature[mid])).toBeLessThan(1.2 / 60);
  });

  it('curvatureVariance is zero for a uniform bend and positive for a concentrated one', () => {
    const mk = (curvature: Float32Array) => ({
      points: [] as LngLat[], curvature, cumDistM: new Float64Array(0), lengthM: 0,
      offsetM: new Float32Array(0),
    });
    expect(curvatureVariance(mk(new Float32Array(100).fill(0.01)))).toBeCloseTo(0, 12);
    const concentrated = new Float32Array(100);
    for (let i = 0; i < 10; i++) concentrated[i] = 0.1;
    expect(curvatureVariance(mk(concentrated))).toBeGreaterThan(0);
    expect(curvatureVariance(mk(new Float32Array(0)))).toBe(0);
  });

  it('gives a constant-radius circle a curvature close to 1/r', () => {
    const { track, corridor } = circleTrack(100, 0.01); // corridor pinned to the centerline
    const line = buildLine(track, corridor, {
      ...DEFAULT_SIM_PARAMS,
      rider: { ...DEFAULT_SIM_PARAMS.rider, lineDeviationM: 0 },
    });
    const mid = Math.floor(line.curvature.length / 2);
    expect(Math.abs(line.curvature[mid])).toBeCloseTo(1 / 100, 3);
  });
});
