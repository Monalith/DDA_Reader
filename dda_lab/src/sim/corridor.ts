// Track corridor from satellite imagery.
//
// Asphalt is separated from its surroundings by COLOUR SATURATION, not
// brightness: measured over the Serres lap, on-track saturation is 0.069
// against 0.239 off-track (3.5x), while brightness differs by only ~21 grey
// levels. Thresholds are calibrated per track from the pixels under the loaded
// GPS traces, which are asphalt by definition.
import { toLocalM } from '../core/geo';
import type { LngLat, TrackModel } from '../core/types';
import { lngLatToPixel, metresPerPixel, SAT_ZOOM as SAT_ZOOM_REF, type Mosaic } from './tiles';
import type { Corridor } from './types';

export class CorridorError extends Error {
  constructor(public code: 'no-traces' | 'no-track' | 'tiles-failed', message: string) {
    super(message);
    this.name = 'CorridorError';
  }
}

export interface AsphaltCal {
  satMax: number;
  valLo: number;
  valHi: number;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}

/** Saturation (0..1) and value (0..255) of one mosaic pixel; NaN when outside. */
function pixelSV(m: Mosaic, x: number, y: number): [number, number] {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= m.width || yi >= m.height) return [NaN, NaN];
  const i = (yi * m.width + xi) * 3;
  const r = m.rgb[i];
  const g = m.rgb[i + 1];
  const b = m.rgb[i + 2];
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  return [mx > 0 ? (mx - mn) / mx : 0, (r + g + b) / 3];
}

/**
 * Asphalt thresholds from pixels known to be on the track. Widened past the
 * observed range so kerbs and shadows at the edges are not cut off before the
 * gap tolerance gets a chance to bridge them.
 */
export function calibrateAsphalt(m: Mosaic, samplesPx: Array<[number, number]>): AsphaltCal {
  const sats: number[] = [];
  const vals: number[] = [];
  for (const [x, y] of samplesPx) {
    const [s, v] = pixelSV(m, x, y);
    if (Number.isFinite(s) && Number.isFinite(v)) {
      sats.push(s);
      vals.push(v);
    }
  }
  if (sats.length < 8) {
    throw new CorridorError(
      'no-traces',
      'Corridor extraction needs loaded GPS laps to learn what asphalt looks like. Open a session first.',
    );
  }
  sats.sort((a, b) => a - b);
  vals.sort((a, b) => a - b);
  return {
    satMax: percentile(sats, 97),
    valLo: percentile(vals, 2) - 25,
    valHi: percentile(vals, 98) + 35,
  };
}

export interface CorridorOpts {
  /** How far either side of the centerline to search, metres. */
  halfSearchM?: number;
  /** Search step along the perpendicular, metres. */
  stepM?: number;
  /** Consecutive non-asphalt steps bridged before the edge is called, in steps. */
  gapTolerance?: number;
  /** Widths above this are a leak into pit lane / run-off / paddock, metres. */
  maxWidthM?: number;
}

const DEFAULTS: Required<CorridorOpts> = {
  halfSearchM: 25,
  stepM: 0.5,
  gapTolerance: 4,
  maxWidthM: 18,
};

/**
 * Index half-width of a ~`strideM` metre tangent stencil for this track's
 * vertex spacing. Immediate-neighbour (`k=1`) tangents are too noisy to use
 * directly — GPS jitter between adjacent samples swings the perpendicular
 * around — so both the extractor and anything that draws or re-offsets the
 * same corridor need to agree on this wider stencil, or what gets drawn is
 * not the corridor that was actually measured.
 */
export function stencilK(track: Pick<TrackModel, 'centerline' | 'lengthM'>, strideM = 10): number {
  const stepAlongM = track.lengthM / Math.max(1, track.centerline.length - 1);
  return Math.max(1, Math.round(strideM / Math.max(0.1, stepAlongM)));
}

/**
 * Unit normal pointing left of travel at centerline vertex `i`, using a
 * +-`k`-vertex stencil (east/north metres). `[0, 0]` marks a degenerate
 * (coincident) stencil.
 */
export function stencilLeftNormal(cl: LngLat[], i: number, k: number): [number, number] {
  const n = cl.length;
  const a = cl[(i - k + n) % n];
  const b = cl[(i + k) % n];
  const am = toLocalM(cl[i], a);
  const bm = toLocalM(cl[i], b);
  const tx = bm[0] - am[0];
  const ty = bm[1] - am[1];
  const len = Math.hypot(tx, ty);
  return len < 1e-9 ? [0, 0] : [-ty / len, tx / len];
}

/** Median over a wrapping window; the centerline is a closed loop. */
function medianFilterWrap(a: Float32Array, n: number): Float32Array {
  const out = new Float32Array(a.length);
  const h = n >> 1;
  const buf: number[] = [];
  for (let i = 0; i < a.length; i++) {
    buf.length = 0;
    for (let k = -h; k <= h; k++) {
      const j = (i + k + a.length) % a.length;
      if (Number.isFinite(a[j])) buf.push(a[j]);
    }
    buf.sort((x, y) => x - y);
    out[i] = buf.length ? buf[buf.length >> 1] : NaN;
  }
  return out;
}

/**
 * Left/right asphalt edge at every centerline vertex.
 *
 * At each vertex the centerline tangent is taken over a +-10 m stencil (GPS
 * noise makes immediate neighbours useless), and the perpendicular is walked
 * outwards in `stepM` steps. `gapTolerance` steps of non-asphalt are bridged so
 * kerbs, white lines and shadows do not end the search early.
 */
export function extractCorridor(
  track: TrackModel,
  mosaic: Mosaic,
  tracePoints: LngLat[],
  opts: CorridorOpts = {},
): Corridor {
  const o = { ...DEFAULTS, ...opts };
  const cl = track.centerline;
  const n = cl.length;
  if (n < 3) throw new CorridorError('no-track', 'The track has no usable centerline.');

  const [ox, oy] = mosaic.originPx;
  const toMosaic = (p: LngLat): [number, number] => {
    const [x, y] = lngLatToPixel(p, SAT_ZOOM_REF);
    return [x - ox, y - oy];
  };

  const cal = calibrateAsphalt(mosaic, tracePoints.map(toMosaic));
  const mpp = metresPerPixel(track.center[1], SAT_ZOOM_REF);

  const isAsphalt = (x: number, y: number): boolean => {
    const [s, v] = pixelSV(mosaic, x, y);
    if (!Number.isFinite(s)) return false;
    return s <= cal.satMax && v >= cal.valLo && v <= cal.valHi;
  };

  // A mosaic with any missing tile cannot be trusted anywhere: the hole's
  // position is known per tile, but a corridor with silent gaps is worse than
  // one the caller is told to re-extract.
  const anyMissing = mosaic.missing.some(Boolean);

  // tangent stencil: ~10 m either side
  const stepAlongM = track.lengthM / Math.max(1, n - 1);
  const k = stencilK(track);

  const leftRaw = new Float32Array(n);
  const rightRaw = new Float32Array(n);
  const nSteps = Math.round(o.halfSearchM / o.stepM);

  for (let i = 0; i < n; i++) {
    const [nxM, nyM] = stencilLeftNormal(cl, i, k);
    if (nxM === 0 && nyM === 0) {
      leftRaw[i] = NaN;
      rightRaw[i] = NaN;
      continue;
    }
    // left of travel in east/north metres, then into mosaic pixels (y is down)
    const [cx, cy] = toMosaic(cl[i]);
    const nxPx = nxM / mpp;
    const nyPx = -nyM / mpp;

    for (const [sign, out] of [[1, leftRaw], [-1, rightRaw]] as const) {
      let edge = 0;
      let gap = 0;
      for (let s = 1; s <= nSteps; s++) {
        const offsetM = sign * s * o.stepM; // + = left of travel, - = right
        if (isAsphalt(cx + nxPx * offsetM, cy + nyPx * offsetM)) {
          edge = s * o.stepM;
          gap = 0;
        } else if (++gap > o.gapTolerance) {
          break;
        }
      }
      out[i] = edge;
    }
  }

  const leftM = medianFilterWrap(leftRaw, 15);
  const rightM = medianFilterWrap(rightRaw, 15);
  // A short leak (e.g. the search escaping across an infield at a hairpin)
  // can get smoothed into a plausible-looking width by the median filter
  // before the ceiling below ever sees it. `known[]` must see the raw
  // reading too — leftM/rightM stay filtered (the smoothing is still
  // wanted for the drawn/consumed edge), but a vertex is only `known` if
  // BOTH the raw and the filtered width pass the same checks.
  const passes = (l: number, r: number): boolean => {
    const w = l + r;
    return (
      Number.isFinite(w) &&
      w > 3 &&
      w <= o.maxWidthM &&
      l < o.halfSearchM - o.stepM &&
      r < o.halfSearchM - o.stepM
    );
  };
  const known = new Array<boolean>(n);
  for (let i = 0; i < n; i++) {
    known[i] = !anyMissing && passes(leftM[i], rightM[i]) && passes(leftRaw[i], rightRaw[i]);
  }

  return { stepM: stepAlongM, leftM, rightM, known };
}
