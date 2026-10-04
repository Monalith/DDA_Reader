// Geodesy helpers. All distances in metres, angles in degrees.
import type { Gate, LngLat } from './types';

const R_EARTH = 6371008.8; // mean Earth radius (IUGG)
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** Great-circle distance between two [lng,lat] points, in metres. */
export function haversineM(a: LngLat, b: LngLat): number {
  const lat1 = a[1] * D2R;
  const lat2 = b[1] * D2R;
  const dLat = lat2 - lat1;
  const dLng = (b[0] - a[0]) * D2R;
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial bearing a -> b, degrees clockwise from north, in [0,360). */
export function bearingDeg(a: LngLat, b: LngLat): number {
  const lat1 = a[1] * D2R;
  const lat2 = b[1] * D2R;
  const dLng = (b[0] - a[0]) * D2R;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  const deg = Math.atan2(y, x) * R2D;
  return (deg + 360) % 360;
}

/** Equirectangular projection to local metres around `origin`: [east, north]. */
export function toLocalM(origin: LngLat, p: LngLat): [number, number] {
  const latRef = origin[1] * D2R;
  const x = (p[0] - origin[0]) * D2R * Math.cos(latRef) * R_EARTH;
  const y = (p[1] - origin[1]) * D2R * R_EARTH;
  return [x, y];
}

/** Inverse of {@link toLocalM}. */
export function fromLocalM(origin: LngLat, xy: [number, number]): LngLat {
  const latRef = origin[1] * D2R;
  const lng = origin[0] + (xy[0] / (R_EARTH * Math.cos(latRef))) * R2D;
  const lat = origin[1] + (xy[1] / R_EARTH) * R2D;
  return [lng, lat];
}

/**
 * Cumulative GPS distance in metres. NaN until the first valid fix; across NaN
 * gaps the last cumulative value is held (no distance is invented).
 */
export function cumulativeDistanceM(lng: Float32Array, lat: Float32Array): Float32Array {
  const n = Math.min(lng.length, lat.length);
  const out = new Float32Array(n).fill(NaN);
  let acc = 0;
  let prev: LngLat | null = null;
  for (let i = 0; i < n; i++) {
    const ok = !Number.isNaN(lng[i]) && !Number.isNaN(lat[i]);
    if (ok) {
      const p: LngLat = [lng[i], lat[i]];
      if (prev) acc += haversineM(prev, p);
      prev = p;
      out[i] = acc;
    } else if (prev) {
      out[i] = acc; // hold last
    }
  }
  return out;
}

/**
 * Where the segment p0 -> p1 crosses `gate`.
 *
 * The gate is a line through `gate.at` perpendicular to `gate.bearingDeg`
 * (the direction of travel through it), `2*halfWidthM` wide. Returns the
 * fraction 0..1 along the segment at which the crossing happens, in the
 * forward direction only, or null when there is no valid crossing.
 */
export function segmentCrossing(p0: LngLat, p1: LngLat, gate: Gate): number | null {
  if (
    Number.isNaN(p0[0]) || Number.isNaN(p0[1]) ||
    Number.isNaN(p1[0]) || Number.isNaN(p1[1])
  ) {
    return null;
  }
  const a = toLocalM(gate.at, p0);
  const b = toLocalM(gate.at, p1);
  const th = gate.bearingDeg * D2R;
  // forward unit vector (bearing: 0 = north) and the gate line direction
  const fx = Math.sin(th);
  const fy = Math.cos(th);
  const s0 = a[0] * fx + a[1] * fy;
  const s1 = b[0] * fx + b[1] * fy;
  if (!(s0 < 0 && s1 >= 0)) return null; // not a forward crossing
  const denom = s1 - s0;
  if (denom === 0) return null;
  const f = -s0 / denom;
  // lateral offset at the crossing point must be inside the gate width
  const lx = a[0] + (b[0] - a[0]) * f;
  const ly = a[1] + (b[1] - a[1]) * f;
  const lateral = Math.abs(lx * fy - ly * fx);
  if (lateral > gate.halfWidthM) return null;
  return f;
}
