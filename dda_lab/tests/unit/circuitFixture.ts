// Shared synthetic-circuit fixture for the virtual-rider sim tests. Kept out
// of a *.test.ts file so that importing it does not re-register that file's
// suites in every test file that needs the fixture.
import type { LngLat, TrackModel } from '../../src/core/types';
import type { Corridor, Line, SimParams } from '../../src/sim/types';
import type { EventCaps } from '../../src/sim/events';
import { brakeCapMs2, driveCapMs2, lossDecelMs2 } from '../../src/sim/solver';
import { clampParams } from '../../src/sim/presets';

/** Named segments of `circuitTrack`, in order. */
export const CIRCUIT_SEGMENTS = {
  longStraight: 0,
  sweeper: 1,
  link1: 3,
  shortStraight: 4,
  hairpin: 5,
  backStraight: 6,
} as const;

/** One piece of a synthetic track: a straight, or a constant-radius arc (positive `turnDeg` = left). */
export type Seg = { kind: 'straight'; lengthM: number } | { kind: 'arc'; radiusM: number; turnDeg: number };

/** What every synthetic-track builder here returns. */
export interface SyntheticTrack {
  track: TrackModel;
  corridor: Corridor;
  /** Index into the segment list for every centerline vertex. */
  segIdx: number[];
}

/**
 * A `SyntheticTrack` that is ALSO a `TrackModel` (the track's own fields are
 * spread onto it), so `buildLine(circuitTrack(), undefined, P)` works as the
 * rider-model-v2 plan writes it, while every existing caller that destructures
 * `{ track, corridor, segIdx }` keeps working unchanged.
 */
export type TrackAndParts = TrackModel & SyntheticTrack;

/**
 * Build a closed track from straight and arc segments at `dsM` spacing, with a
 * constant-width corridor of `halfWidthM` either side. The caller is
 * responsible for the segments closing the loop in position and heading.
 *
 * `jitterM` adds deterministic per-vertex scatter, standing in for what a
 * centerline extracted from real GPS or from map tiles actually looks like.
 */
export function trackFromSegments(
  segs: Seg[],
  halfWidthM = 6,
  dsM = 2,
  jitterM = 0,
  id = 'syn',
  name = 'synthetic track',
): TrackAndParts {
  const lat0 = 41.073;
  const lng0 = 23.518;
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const pts: Array<[number, number]> = [];
  const segIdx: number[] = [];
  let x = 0;
  let y = 0;
  let th = 0;
  segs.forEach((sg, si) => {
    if (sg.kind === 'straight') {
      const cnt = Math.max(1, Math.round(sg.lengthM / dsM));
      const ds = sg.lengthM / cnt;
      for (let i = 0; i < cnt; i++) {
        pts.push([x, y]);
        segIdx.push(si);
        x += ds * Math.cos(th);
        y += ds * Math.sin(th);
      }
    } else {
      const dth = (sg.turnDeg * Math.PI) / 180;
      const arcLen = Math.abs(dth) * sg.radiusM;
      const cnt = Math.max(1, Math.round(arcLen / dsM));
      const kk = Math.sign(dth) / sg.radiusM;
      const ds = arcLen / cnt;
      for (let i = 0; i < cnt; i++) {
        pts.push([x, y]);
        segIdx.push(si);
        x += ds * Math.cos(th + (kk * ds) / 2);
        y += ds * Math.sin(th + (kk * ds) / 2);
        th += kk * ds;
      }
    }
  });
  const n = pts.length;
  if (jitterM > 0) {
    let s = 12345;
    const rnd = (): number => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff - 0.5;
    };
    for (let i = 0; i < n; i++) {
      pts[i][0] += jitterM * 2 * rnd();
      pts[i][1] += jitterM * 2 * rnd();
    }
  }
  const centerline: LngLat[] = pts.map(([px, py]) => [lng0 + px / mPerDegLng, lat0 + py / mPerDegLat]);
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    cum[i] = cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  const lengthM = cum[n - 1] + Math.hypot(pts[0][0] - pts[n - 1][0], pts[0][1] - pts[n - 1][1]);
  const track: TrackModel = {
    id, name, center: [lng0, lat0], centerline, cumDistM: cum, lengthM,
    startFinish: { id: 'sf', name: 'SF', type: 'sf', at: centerline[0], bearingDeg: 0, halfWidthM: 15 },
    sectors: [], turns: [],
  };
  const corridor: Corridor = {
    stepM: lengthM / Math.max(1, n - 1),
    leftM: new Float32Array(n).fill(halfWidthM),
    rightM: new Float32Array(n).fill(halfWidthM),
    known: new Array(n).fill(true),
  };
  return { ...track, track, corridor, segIdx };
}

/**
 * A closed synthetic circuit with the two cases a lap simulator has to get
 * right at once: a 600 m straight into a genuinely FAST 250 m-radius sweeper,
 * and a tight 25 m hairpin onto a 1060 m straight, all inside a 12 m corridor.
 * Linking corners are 60 m. Total 3044 m at a 2 m sampling, which is the same
 * order as the real circuit the virtual rider is checked against.
 *
 * The straight lengths are chosen so the loop closes in BOTH position and
 * heading (total turning exactly 360 degrees, displacement zero to ~1 cm) —
 * `buildLine` and the solver both wrap at the start line, and an unclosed
 * fixture would put a spurious curvature spike there and quietly invalidate
 * every measurement taken on it.
 *
 * `jitterM` adds deterministic per-vertex scatter (see `trackFromSegments`).
 * The sim's behaviour on a mathematically exact centerline is not the
 * behaviour the user sees.
 *
 * The result is both `{ track, corridor, segIdx }` and the `TrackModel`
 * itself (see `TrackAndParts`).
 */
export function circuitTrack(halfWidthM = 6, dsM = 2, jitterM = 0): TrackAndParts {
  return trackFromSegments(
    [
      { kind: 'straight', lengthM: 600 },
      { kind: 'arc', radiusM: 250, turnDeg: 90 },
      { kind: 'straight', lengthM: 120 },
      { kind: 'arc', radiusM: 60, turnDeg: -90 },
      { kind: 'straight', lengthM: 150 },
      { kind: 'arc', radiusM: 25, turnDeg: 180 },
      { kind: 'straight', lengthM: 1060 },
      { kind: 'arc', radiusM: 60, turnDeg: 90 },
      { kind: 'straight', lengthM: 360 },
      { kind: 'arc', radiusM: 60, turnDeg: 90 },
    ],
    halfWidthM,
    dsM,
    jitterM,
    'syn',
    'synthetic circuit',
  );
}

/**
 * A closed track whose ONLY corner is a chicane: a 300 m straight, a right
 * 60 m-radius 90 deg, 15 m, a left 60 m-radius 90 deg, then a loop back made
 * of two 180 deg LEFT arcs (900 m and 832.5 m radius) that every preset takes
 * flat out (lateral limit above top speed).
 *
 * Closure: the chicane steps the line 135 m to the right, which the two arcs'
 * radius difference (2 × 67.5 m) takes back; the return straight is the two
 * outbound straights plus the chicane's 120 m of advance. Total turning
 * +360 deg. About 6.8 km.
 */
export function chicaneTrack(halfWidthM = 6, dsM = 2, jitterM = 0): TrackAndParts {
  return trackFromSegments(
    [
      { kind: 'straight', lengthM: 300 },
      { kind: 'arc', radiusM: 60, turnDeg: -90 },
      { kind: 'straight', lengthM: 15 },
      { kind: 'arc', radiusM: 60, turnDeg: 90 },
      { kind: 'straight', lengthM: 200 },
      { kind: 'arc', radiusM: 900, turnDeg: 180 },
      { kind: 'straight', lengthM: 620 },
      { kind: 'arc', radiusM: 832.5, turnDeg: 180 },
    ],
    halfWidthM,
    dsM,
    jitterM,
    'chicane',
    'synthetic chicane',
  );
}

/**
 * `EventCaps` for tests: exactly the production caps (`brakeCapMs2` /
 * `driveCapMs2` from solver.ts — load transfer, μ_eff ellipse, trail-brake
 * taper, roll-dependent stoppie/wheelie limits), so the event template is
 * clipped against the same QSS envelope the app uses. `index.ts` builds the
 * same object; this copy only saves tests the import of index.ts.
 */
export function testCaps(line: Line, params: SimParams): EventCaps {
  const p = clampParams(params);
  return {
    brakeCapMs2: (i, v) => brakeCapMs2(line, p, i, v),
    driveCapMs2: (i, v) => driveCapMs2(line, p, i, v),
    lossDecelMs2: (v) => lossDecelMs2(p.machine, v),
  };
}

/** Indices of one named segment of `circuitTrack`. */
export function segmentIndices(segIdx: number[], seg: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < segIdx.length; i++) if (segIdx[i] === seg) out.push(i);
  return out;
}
