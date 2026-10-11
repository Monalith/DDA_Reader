import { describe, expect, it } from 'vitest';
import { buildLine, chooseCurvatureScaleM, CURV_SCALE_M, CURV_SCALE_SURVEYED_M, effectiveHalfWidths, lineFromOffsets, polylineCurvature, smoothClosed } from '../../src/sim/line';
import { DEFAULT_SIM_PARAMS } from '../../src/sim/presets';
import type { Corridor } from '../../src/sim/types';
import type { LngLat, TrackModel } from '../../src/core/types';
import { CIRCUIT_SEGMENTS, circuitTrack, segmentIndices, trackFromSegments, type Seg } from './circuitFixture';

/**
 * How far past a MEASURED corridor edge the line may run with the default
 * params: the rider's kerb margin plus the kerb allowance `kerbM` (1.0 m by
 * default), less nothing — the 0.4 m bike half-width only ever tightens.
 */
const BOX_MARGIN = DEFAULT_SIM_PARAMS.tyre.kerbMarginM + (DEFAULT_SIM_PARAMS.tyre.kerbM ?? 1);

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
 * A circle of `radiusM` with a sinusoidal radial wobble of `ampM` amplitude and
 * roughly `waveM` wavelength — a stand-in for the long-wavelength positional
 * error a centerline traced onto a map carries. The cycle count is rounded so
 * the wobble closes with the loop; an unclosed wobble would put a curvature
 * step at the start line instead of the smooth error this is modelling.
 */
function wobbledCircle(
  radiusM: number,
  ampM: number,
  waveM: number,
  halfWidthM: number,
): { track: TrackModel; corridor: Corridor } {
  const lat0 = 41.073;
  const lng0 = 23.518;
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const n = Math.max(64, Math.round((2 * Math.PI * radiusM) / 2));
  const step = (2 * Math.PI * radiusM) / n;
  const cycles = Math.max(1, Math.round((2 * Math.PI * radiusM) / waveM));
  const centerline: LngLat[] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    const r = radiusM + ampM * Math.sin(cycles * a);
    centerline.push([lng0 + (r * Math.cos(a)) / mPerDegLng, lat0 + (r * Math.sin(a)) / mPerDegLat]);
  }
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + step;
  const track: TrackModel = {
    id: 'w', name: 'wobbled circle', center: [lng0, lat0], centerline, cumDistM: cum, lengthM: step * n,
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
    const margin = BOX_MARGIN + 1e-6;
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
    const margin = BOX_MARGIN + 1e-6;
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
    // This replaces an earlier curvature-variance check whose two values on
    // this fixture differed only at noise level, and which the previous
    // (diverging) solver passed by crossing its own instability. That metric
    // had no other consumer and has been deleted with its self-test.
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
    // NON-INCREASING, not strictly decreasing. Now that the solve converges,
    // this fixture's box saturates: at kappa = 0 and 0.25 the line is already
    // hard against the outer edge (offset -8.10 m on an 8.1 m box) and at
    // 0.75/1 hard against the inner one, so consecutive kappas can be
    // bit-identical. The strict ordering is asserted end to end below, where
    // it is a 100 m difference in line length rather than a rounding one.
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i].lengthM).toBeLessThanOrEqual(lines[i - 1].lengthM);
      expect(minRadius(lines[i])).toBeLessThanOrEqual(minRadius(lines[i - 1]));
    }
    // and the span is a real one, not a rounding difference
    expect(lines[0].lengthM - lines[4].lengthM).toBeGreaterThan(5);
    expect(minRadius(lines[0]) - minRadius(lines[4])).toBeGreaterThan(1);
    // the ends are on OPPOSITE sides of the centreline: minimum curvature runs
    // outside a constant-radius bend (the biggest radius available), minimum
    // distance runs inside it (the shortest path). A solver that ignored kappa
    // would put both on the same side.
    expect(minRadius(lines[0])).toBeGreaterThan(60);
    expect(minRadius(lines[4])).toBeLessThan(60);
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
      const margin = BOX_MARGIN + 1e-6;
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
    const margin = BOX_MARGIN + 1e-6;
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
    const bound = 1 + BOX_MARGIN + 1e-6;
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

  it('reads a fast corner through a long-wavelength centerline wobble, and still reads a hairpin', () => {
    // CURV_SCALE_M, pinned from both sides.
    //
    // A hand-placed or map-derived centerline wanders. Its error is NOT
    // per-vertex scatter — the real Serres centerline's local (2 m baseline)
    // noise measures 0.07 m while its residual against a 40 m mean is 2.6 m
    // rms — so it is long-wavelength, and a short curvature stencil reports
    // the wobble as a corner. A 1 m / 50 m wobble has curvature
    // 1*(2*pi/50)^2 = 0.016 1/m, FOUR TIMES the 0.004 of the 250 m bend it is
    // riding on, which is why the virtual rider was 6.5 % slow against the
    // real lap and slowest of all through the fast corners: see
    // docs/superpowers/notes/2026-10-10-virtual-vs-real.md.
    //
    // Measured on this fixture: the 250 m bend reads a minimum radius of
    // 110 m at a 10 m scale, 178 m at 20 m, 213 m at 30 m. The threshold
    // below is between the 10 m and 20 m readings, so a return to a 10 m
    // scale fails it.
    // kerbM 0: this pins the curvature SCALE, so the line must be held to the
    // fixture's own corridor rather than a kerb's width either side of it
    const P = {
      ...DEFAULT_SIM_PARAMS,
      tyre: { ...DEFAULT_SIM_PARAMS.tyre, kerbM: 0 },
      rider: { ...DEFAULT_SIM_PARAMS.rider, lineDeviationM: 0 },
    };
    const { track, corridor } = wobbledCircle(250, 1, 50, 0.01);
    const line = buildLine(track, corridor, P);
    let minR = Infinity;
    for (let i = 0; i < line.curvature.length; i++) {
      const k = Math.abs(line.curvature[i]);
      if (k > 1e-6) minR = Math.min(minR, 1 / k);
    }
    expect(minR).toBeGreaterThan(150);

    // The other side: smoothing cannot be raised freely, because past the
    // angular extent of a tight corner the window reaches onto the straights
    // either side and the corner's radius inflates — which would report a lap
    // the bike cannot ride. The 25 m hairpin reads 25.0 m at a 20 m scale,
    // 30.2 m at 45 m and 38.0 m at 60 m, so the bound below fails at 45 m.
    //
    // The corridor is PINNED to the centreline here (and the kerb margins are
    // zero) so the reading is the smoothing's alone: with a 12 m corridor the
    // exact minimum-curvature solve legitimately runs the hairpin wider than
    // 25 m (28.6 m measured), which is the optimiser, not the smoothing.
    const { track: ct, corridor: cc, segIdx } = circuitTrack(0.01, 2, 0.25);
    const cl = buildLine(ct, cc, { ...P, tyre: { ...P.tyre, kerbMarginM: 0, kerbM: 0 } });
    const hair = segmentIndices(segIdx, CIRCUIT_SEGMENTS.hairpin).map((i) => 1 / Math.abs(cl.curvature[i]));
    expect(Math.min(...hair)).toBeLessThan(28);
    expect(Math.min(...hair)).toBeGreaterThan(20);
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

  it('sets up for a corner from the middle of a long straight, not just at its ends', () => {
    // The horizon test. The earlier single-grid solve stopped after 60
    // Gauss-Seidel sweeps, which propagates information about 8 vertices (~16
    // m), so the offsets were a boundary layer around each curvature feature
    // and the line sat on the centreline everywhere else: measured 0.00 m in
    // the middle of a 1060 m straight. A converged, lap-wide solve puts the
    // line against the OUTSIDE edge there, because that is where a lap that is
    // about to turn left has to be. Nothing else in the generator can produce
    // a metres-scale offset 500 m from the nearest corner.
    const { track, corridor, segIdx } = circuitTrack();
    const line = buildLine(track, corridor, {
      ...DEFAULT_SIM_PARAMS,
      rider: { ...DEFAULT_SIM_PARAMS.rider, lineDeviationM: 0 },
    });
    for (const seg of [CIRCUIT_SEGMENTS.longStraight, CIRCUIT_SEGMENTS.backStraight]) {
      const idx = segmentIndices(segIdx, seg);
      const mid = idx[Math.floor(idx.length / 2)];
      expect(Math.abs(line.offsetM[mid])).toBeGreaterThan(3);
    }
  });

  it('widens a tight corner past the centreline radius instead of hugging its inside edge', () => {
    // The `k0^2 * d` term in `relax`. Without it a converged solve believes a
    // constant offset is free, so it pins the line to the inside edge of every
    // corner: the 25 m hairpin then reads 18.9 m, which is exactly
    // 25 - halfWidth, and the simulated lap is slower than the real one in
    // every slow corner. With it, the minimum-curvature end of kappa trades
    // the straights' width for radius and the hairpin reads over 30 m.
    const { track, corridor, segIdx } = circuitTrack();
    const line = buildLine(track, corridor, {
      ...DEFAULT_SIM_PARAMS,
      rider: { ...DEFAULT_SIM_PARAMS.rider, kappa: 0, lineDeviationM: 0 },
    });
    const idx = segmentIndices(segIdx, CIRCUIT_SEGMENTS.hairpin);
    const radii = idx.map((i) => 1 / Math.abs(line.curvature[i])).sort((a, b) => a - b);
    const median = radii[Math.floor(radii.length / 2)];
    expect(median).toBeGreaterThan(28);
    // and the tightest point of the hairpin is still not inside the edge
    expect(radii[0]).toBeGreaterThan(26);
  });
});

describe('smoothClosed', () => {
  it('preserves the sum (so a lap still closes) and cuts white noise', () => {
    const n = 400;
    const clean = new Float32Array(n);
    const noisy = new Float32Array(n);
    let s = 7;
    const rnd = (): number => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff - 0.5;
    };
    for (let i = 0; i < n; i++) {
      clean[i] = i >= 100 && i < 200 ? 0.02 : 0;
      noisy[i] = clean[i] + 0.01 * rnd();
    }
    const sum = (a: Float32Array): number => {
      let t = 0;
      for (let i = 0; i < a.length; i++) t += a[i];
      return t;
    };
    const out = smoothClosed(noisy, 10);
    expect(sum(out)).toBeCloseTo(sum(noisy), 4);
    // residual noise where the signal is flat must fall, by roughly sqrt(21)
    const rms = (a: Float32Array, from: number, to: number): number => {
      let t = 0;
      for (let i = from; i < to; i++) t += (a[i] - clean[i]) ** 2;
      return Math.sqrt(t / (to - from));
    };
    expect(rms(out, 250, 390)).toBeLessThan(rms(noisy, 250, 390) / 3);
  });

  it('wraps around the start line rather than tapering to it', () => {
    const n = 64;
    const a = new Float32Array(n).fill(1);
    const out = smoothClosed(a, 5);
    for (let i = 0; i < n; i++) expect(out[i]).toBeCloseTo(1, 5);
  });

  it('returns the input untouched when the window is degenerate', () => {
    const a = new Float32Array([1, 2, 3, 4]);
    expect(smoothClosed(a, 0)).toBe(a);
    expect(smoothClosed(new Float32Array([1, 2]), 5)).toHaveLength(2);
  });
});

describe('minimum-curvature line (exact bounded QP)', () => {
  // kappa 0, no wander, no kerb margins: the box is exactly the corridor less
  // the 0.4 m bike half-width, 12 m corridor -> +-5.6 m
  const P = {
    ...DEFAULT_SIM_PARAMS,
    tyre: { ...DEFAULT_SIM_PARAMS.tyre, kerbMarginM: 0, kerbM: 0 },
    rider: { ...DEFAULT_SIM_PARAMS.rider, kappa: 0, lineDeviationM: 0 },
  };
  const BOX = 6 - 0.4;
  const maxAbs = (a: Float32Array, idx?: number[]): number =>
    (idx ?? Array.from(a.keys())).reduce((m, i) => Math.max(m, Math.abs(a[i])), 0);

  it('runs outside-inside-outside through a 90° corner and cuts its peak curvature by more than a quarter', () => {
    // A rounded square: four 90° left corners of 30 m centreline radius
    // joined by 300 m straights, 12 m wide. The max-radius arc through a 90°
    // corner touches the outer edge on both straights and the inner edge at
    // the apex: r = R_in + w/(1 - cos 45°) = 24.4 + 11.2/0.293 = 62.6 m against
    // 30 m on the centreline (-52 % curvature). Minimum sum-of-squares
    // curvature is not minimum peak curvature, and the 20 m curvature scale
    // softens both, so the bound asserted is the brief's 25 %.
    const segs: Seg[] = [];
    for (let k = 0; k < 4; k++) segs.push({ kind: 'straight', lengthM: 300 }, { kind: 'arc', radiusM: 30, turnDeg: 90 });
    const t = trackFromSegments(segs, 6, 2);
    const line = buildLine(t.track, t.corridor, P, 6);
    const centreK = lineFromOffsets(t.track, new Float32Array(t.track.centerline.length)).curvature;
    const kC = maxAbs(centreK);
    const kL = maxAbs(line.curvature);
    expect(kL).toBeLessThanOrEqual(0.75 * kC);
    for (let k = 0; k < 4; k++) {
      const arc = segmentIndices(t.segIdx, 2 * k + 1);
      const before = segmentIndices(t.segIdx, 2 * k);
      const after = segmentIndices(t.segIdx, (2 * k + 2) % 8);
      // the apex: the line reaches the INNER bound (left turn: +BOX)
      const inner = Math.max(...arc.map((i) => line.offsetM[i]));
      expect(inner).toBeGreaterThan(BOX - 0.2);
      // entry and exit: the OUTER bound on the straights either side
      expect(Math.min(...before.slice(-80).map((i) => line.offsetM[i]))).toBeLessThan(-BOX + 0.2);
      expect(Math.min(...after.slice(0, 80).map((i) => line.offsetM[i]))).toBeLessThan(-BOX + 0.2);
    }
  });

  it('takes the full outer radius through a 180° oval end, the geometric optimum there', () => {
    // A 180° turn between PARALLEL straights cannot be ridden on a radius
    // larger than the outer edge's: the two outer edges are 2(R + w/2) apart
    // and a curve turning 180° with curvature <= k spans at least 2/k. So on
    // an oval the bound is R + 5.6 = 35.6 m (-16 % curvature), not the 25 %
    // a sub-180° corner allows; the line has to reach it.
    const segs: Seg[] = [
      { kind: 'straight', lengthM: 300 },
      { kind: 'arc', radiusM: 30, turnDeg: 180 },
      { kind: 'straight', lengthM: 300 },
      { kind: 'arc', radiusM: 30, turnDeg: 180 },
    ];
    const t = trackFromSegments(segs, 6, 2);
    const line = buildLine(t.track, t.corridor, P, 6);
    const kL = maxAbs(line.curvature);
    expect(1 / kL).toBeGreaterThan(30 + 0.9 * BOX);
  });

  it('solves a 3200-station lap well inside the UI budget', () => {
    const segs: Seg[] = [];
    for (let k = 0; k < 4; k++) segs.push({ kind: 'straight', lengthM: 300 }, { kind: 'arc', radiusM: 30, turnDeg: 90 });
    const t = trackFromSegments(segs, 6, 0.4); // ~3200 stations
    expect(t.track.centerline.length).toBeGreaterThan(3000);
    buildLine(t.track, t.corridor, P, 6); // warm-up
    const t0 = performance.now();
    buildLine(t.track, t.corridor, P, 6);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

describe('curvature scale per source (ducati-lateral note §7)', () => {
  /** The oval of `ovalTrack` with a lateral sine wobble (amplitude, wavelength, m) on both straights. */
  function wobbledOval(ampM: number, waveM: number): TrackModel {
    const { track } = ovalTrack(60, 400, 6);
    const lat0 = 41.073;
    const mPerDegLat = 111320;
    // the straights run along y = ∓60 m; push their vertices sideways
    const centerline = track.centerline.map(([lng, lat]): LngLat => {
      const y = (lat - lat0) * mPerDegLat;
      if (Math.abs(Math.abs(y) - 60) > 0.01) return [lng, lat];
      const x = (lng - track.centerline[0][0]) * 111320 * Math.cos((lat0 * Math.PI) / 180);
      return [lng, lat + (ampM * Math.sin((2 * Math.PI * x) / waveM)) / mPerDegLat];
    });
    return { ...track, centerline };
  }

  it('takes the 10 m scale for a clean centreline and keeps 20 m where 10 m reads straights as bends', () => {
    // measured on the real sources: Ducati GPS-lap centreline 0.48e-3 1/m on its straights at 10 m
    // (passes), BMW hand-placed map 1.50e-3 and pist Serres centreline 2.47e-3 (fail)
    expect(chooseCurvatureScaleM(ovalTrack(60, 400, 6).track.centerline)).toBe(CURV_SCALE_SURVEYED_M);
    expect(chooseCurvatureScaleM(wobbledOval(0.1, 30).centerline)).toBe(CURV_SCALE_SURVEYED_M);
    expect(chooseCurvatureScaleM(wobbledOval(0.3, 40).centerline)).toBe(CURV_SCALE_M);
    // no straight to judge it by: the map default
    expect(chooseCurvatureScaleM(circleTrack(100, 6).track.centerline)).toBe(CURV_SCALE_M);
  });

  it('lineFromOffsets measures curvature at the track\'s own scale (default 20 m)', () => {
    const { track } = ovalTrack(60, 400, 6);
    const zero = new Float32Array(track.centerline.length);
    expect(Array.from(lineFromOffsets(track, zero).curvature)).toEqual(Array.from(polylineCurvature(track.centerline, CURV_SCALE_M)));
    const t10 = { ...track, curvatureScaleM: CURV_SCALE_SURVEYED_M };
    expect(Array.from(lineFromOffsets(t10, zero).curvature)).toEqual(Array.from(polylineCurvature(track.centerline, CURV_SCALE_SURVEYED_M)));
    // the shorter scale blurs the 60 m end's entry less: the first arc vertex
    // past the straight reads closer to 1/60 at 10 m than at 20 m
    const { arcFrom } = ovalTrack(60, 400, 6);
    const i = arcFrom + 5;
    const k10 = Math.abs(lineFromOffsets(t10, zero).curvature[i]);
    const k20 = Math.abs(lineFromOffsets(track, zero).curvature[i]);
    expect(Math.abs(k10 - 1 / 60)).toBeLessThan(Math.abs(k20 - 1 / 60));
  });
});
