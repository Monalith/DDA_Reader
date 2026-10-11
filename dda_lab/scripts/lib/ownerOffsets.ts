// The owner's GPS path (a Ducati DDA lap trace) mapped into a track model's
// corridor frame: one lateral offset per centerline station, measured along the
// same ~10 m stencil normal `lineFromOffsets` uses, so
// `lineFromOffsets(track, ownerOffsets(...))` reproduces the owner's path on
// the pist centreline's stations (pist-line note §7.4 / §8).
import { toLocalM } from '../../src/core/geo';
import type { LngLat, TrackModel } from '../../src/core/types';
import { stencilK, stencilLeftNormal } from '../../src/sim/corridor';

/** Path crossings farther than this from the centreline are another part of the circuit, m. */
const MAX_ACROSS_M = 25;

/**
 * Signed offset (+ left) where the polyline (lon/lat, closed) crosses each
 * station's normal; the crossing nearest the centreline wins. Stations with no
 * crossing (none should exist on a lap of the same circuit) are interpolated.
 */
export function ownerOffsets(track: TrackModel, lon: ArrayLike<number>, lat: ArrayLike<number>): Float32Array {
  const cl = track.centerline;
  const n = cl.length;
  const N = lon.length;
  const k = stencilK(track);
  const out = new Float32Array(n).fill(Number.NaN);
  for (let i = 0; i < n; i++) {
    const [nx, ny] = stencilLeftNormal(cl, i, k);
    const tx = ny;
    const ty = -nx;
    let best = Number.NaN;
    let prev = toLocalM(cl[i], [lon[N - 1], lat[N - 1]] as LngLat);
    let pa = prev[0] * tx + prev[1] * ty;
    let pc = prev[0] * nx + prev[1] * ny;
    for (let j = 0; j < N; j++) {
      const q = toLocalM(cl[i], [lon[j], lat[j]] as LngLat);
      const a = q[0] * tx + q[1] * ty;
      const c = q[0] * nx + q[1] * ny;
      if ((a <= 0 && pa > 0) || (a >= 0 && pa < 0) || a === 0) {
        const w = pa === a ? 0 : pa / (pa - a);
        const across = pc + w * (c - pc);
        if (Math.abs(across) < MAX_ACROSS_M && !(Math.abs(across) >= Math.abs(best))) best = across;
      }
      pa = a;
      pc = c;
    }
    out[i] = best;
  }
  // fill gaps linearly (wrapping)
  const ok: number[] = [];
  for (let i = 0; i < n; i++) if (Number.isFinite(out[i])) ok.push(i);
  if (ok.length === 0) return new Float32Array(n);
  for (let q = 0; q < ok.length; q++) {
    const a = ok[q];
    const b = ok[(q + 1) % ok.length];
    const gap = (b - a + n) % n;
    for (let g = 1; g < gap; g++) out[(a + g) % n] = out[a] + ((out[b] - out[a]) * g) / gap;
  }
  return out;
}
