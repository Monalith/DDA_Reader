// Shared synthetic-circuit fixture for the virtual-rider sim tests. Kept out
// of a *.test.ts file so that importing it does not re-register that file's
// suites in every test file that needs the fixture.
import type { LngLat, TrackModel } from '../../src/core/types';
import type { Corridor } from '../../src/sim/types';

/** Named segments of `circuitTrack`, in order. */
export const CIRCUIT_SEGMENTS = {
  longStraight: 0,
  sweeper: 1,
  link1: 3,
  shortStraight: 4,
  hairpin: 5,
  backStraight: 6,
} as const;

type Seg = { kind: 'straight'; lengthM: number } | { kind: 'arc'; radiusM: number; turnDeg: number };

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
 * `jitterM` adds deterministic per-vertex scatter, standing in for what a
 * centerline extracted from real GPS or from map tiles actually looks like.
 * The sim's behaviour on a mathematically exact centerline is not the
 * behaviour the user sees.
 */
export function circuitTrack(
  halfWidthM = 6,
  dsM = 2,
  jitterM = 0,
): { track: TrackModel; corridor: Corridor; segIdx: number[] } {
  const lat0 = 41.073;
  const lng0 = 23.518;
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const segs: Seg[] = [
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
  ];
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
    id: 'syn', name: 'synthetic circuit', center: [lng0, lat0], centerline, cumDistM: cum, lengthM,
    startFinish: { id: 'sf', name: 'SF', type: 'sf', at: centerline[0], bearingDeg: 0, halfWidthM: 15 },
    sectors: [], turns: [],
  };
  const corridor: Corridor = {
    stepM: lengthM / Math.max(1, n - 1),
    leftM: new Float32Array(n).fill(halfWidthM),
    rightM: new Float32Array(n).fill(halfWidthM),
    known: new Array(n).fill(true),
  };
  return { track, corridor, segIdx };
}

/** Indices of one named segment of `circuitTrack`. */
export function segmentIndices(segIdx: number[], seg: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < segIdx.length; i++) if (segIdx[i] === seg) out.push(i);
  return out;
}
