// Per-corner values of the virtual rider's OWN parameters (spec: "Fit to lap"
// redesign, 2026-10-14). A corner override is not a new cap layer: it is the
// same sBrake / sLat / throttleDelayS… the rider has lap-wide, applied to the
// stations of one corner of the track model (`TrackModel.turns[].sRange`).
// `riderFit.ts` fills them from a recorded lap; the Rider panel edits them.
//
// WHERE a corner's value is in force depends on what the key does:
//
//   zone   kappa, sLat, leanUsage, rollRateFrac, slideOut — inside the corner's
//          zone (sRange), cosine-tapered to the lap-wide value over TAPER_M;
//   brake  sBrake, trailBrakeDepth, trailBrakeProfile, brakeRiseGps — on the
//          approach: after the previous corner's apex up to this apex (the
//          braking INTO the corner happens before its zone starts);
//   drive  sDrive, throttleDelayS, rollOnS — on the exit: this apex up to the
//          next corner's apex.
//
// The brake / drive stretches tile the lap; neighbouring stretches blend over
// TAPER_M across their common boundary (the caps), so nothing steps.
import { toLocalM } from '../core/geo';
import type { TrackModel } from '../core/types';
import { buildLine, lineFromOffsets, offsetBounds } from './line';
import { effectiveMu } from './tyre';
import type { Corridor, EnvelopeCaps, Line, RiderParams, SimParams } from './types';
import { idealLeanLimitRad } from './vehicle';

/** The rider keys a corner may override. `kappa` is the corner's C↔V line shape. */
export type CornerRiderKey =
  | 'sBrake'
  | 'sDrive'
  | 'sLat'
  | 'leanUsage'
  | 'trailBrakeDepth'
  | 'trailBrakeProfile'
  | 'brakeRiseGps'
  | 'throttleDelayS'
  | 'rollOnS'
  | 'rollRateFrac'
  | 'kappa'
  | 'slideOut';

export const CORNER_RIDER_KEYS: readonly CornerRiderKey[] = [
  'kappa', 'sBrake', 'trailBrakeDepth', 'trailBrakeProfile', 'brakeRiseGps',
  'sLat', 'leanUsage', 'throttleDelayS', 'rollOnS', 'sDrive', 'rollRateFrac', 'slideOut',
];

/** Slider / fit bounds of every corner key (the same ranges `clampParams` holds the lap-wide values to). */
export const CORNER_RIDER_BOUNDS: Record<CornerRiderKey, [number, number]> = {
  sBrake: [0.1, 1],
  sDrive: [0.1, 1],
  sLat: [0.1, 1],
  leanUsage: [0, 1],
  trailBrakeDepth: [0, 1],
  trailBrakeProfile: [0, 1],
  brakeRiseGps: [0.5, 20],
  throttleDelayS: [0, 2],
  rollOnS: [0.1, 3],
  rollRateFrac: [0.1, 1],
  kappa: [0, 1],
  slideOut: [0, 1],
};

/** Which stretch of the lap a corner's value of the key covers (see the header). */
export const CORNER_KEY_REGION: Record<CornerRiderKey, 'zone' | 'brake' | 'drive'> = {
  kappa: 'zone',
  sLat: 'zone',
  leanUsage: 'zone',
  rollRateFrac: 'zone',
  slideOut: 'zone',
  sBrake: 'brake',
  trailBrakeDepth: 'brake',
  trailBrakeProfile: 'brake',
  brakeRiseGps: 'brake',
  sDrive: 'drive',
  throttleDelayS: 'drive',
  rollOnS: 'drive',
};

/** One corner's overrides; a missing key = the lap-wide value. */
export type CornerRider = Partial<Record<CornerRiderKey, number>>;
/** Keyed by `TrackModel.turns[].n`. */
export type CornerRiders = Record<number, CornerRider>;

/** A track-model corner mapped onto a line's stations (i0 → i1 may wrap past the start line). */
export interface CornerZone {
  n: number;
  name: string;
  dir: 'L' | 'R';
  i0: number;
  i1: number;
  iApex: number;
}

/** Taper of a corner value into its neighbours, metres. */
export const TAPER_M = 25;
/** Slide out: the entry starts this far before the zone start, metres. */
const SLIDE_LEAD_M = 20;
/** Peak outward line offset at slideOut 1, metres. */
const SLIDE_OFFSET_M = 1.5;
/** Ceiling on the curvature the outward drift itself adds, 1/m (a short entry drifts less). */
const SLIDE_CURV_MAX = 1 / 250;
/** Scrub deceleration per lateral g at slideOut 1 (≈ sin of a 9° slip angle). */
const SLIDE_SCRUB_K = 0.15;
/** Lateral-cap excess at slideOut 1 (sliding past the grip peak), entry only. */
const SLIDE_LAT_EXCESS = 0.06;
const G = 9.81;

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const cyc = (a: number, b: number, n: number): number => (((b - a) % n) + n) % n;

/** Nearest station of `line` to the distance s (wrapped onto the loop). */
function stationAt(line: Line, s: number): number {
  const n = line.points.length;
  const L = line.lengthM;
  const ss = ((s % L) + L) % L;
  const c = line.cumDistM;
  let lo = 0;
  let hi = n - 1;
  if (ss >= c[n - 1]) return ss - c[n - 1] <= L - ss ? n - 1 : 0;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (c[mid] <= ss) lo = mid;
    else hi = mid;
  }
  return ss - c[lo] <= c[hi] - ss ? lo : hi;
}

/** Is station i inside [i0, i1] (wrapping when i0 > i1)? */
function inZone(z: CornerZone, i: number): boolean {
  return z.i0 <= z.i1 ? i >= z.i0 && i <= z.i1 : i >= z.i0 || i <= z.i1;
}

/**
 * The track model's turns as station ranges on `line`. `sRange` is along the
 * centreline; the line's `cumDistM` is used as the same parameter (offsets are
 * small against the zone lengths).
 */
export function cornerZones(line: Line, track: TrackModel): CornerZone[] {
  const n = line.points.length;
  if (n < 3) return [];
  return track.turns.map((t) => {
    const i0 = stationAt(line, t.sRange[0]);
    const i1 = stationAt(line, t.sRange[1]);
    // the apex: the zone station nearest the turn's geometric apex
    let iApex = i0;
    let best = Infinity;
    const len = cyc(i0, i1, n);
    for (let d = 0; d <= len; d++) {
      const i = (i0 + d) % n;
      const [x, y] = toLocalM(t.apexGeo, line.points[i]);
      const dd = x * x + y * y;
      if (dd < best) {
        best = dd;
        iApex = i;
      }
    }
    return { n: t.n, name: t.name || `T${t.n}`, dir: t.dir, i0, i1, iApex };
  });
}

/** Index into `zones` of the zone holding station i (nearest apex where zones overlap), else −1. */
export function zoneOwnerAt(zones: CornerZone[], i: number): number {
  let best = -1;
  let bd = Infinity;
  zones.forEach((z, k) => {
    if (!inZone(z, i)) return;
    const d = Math.abs(i - z.iApex);
    if (d < bd) {
      bd = d;
      best = k;
    }
  });
  return best;
}

/** The corner station i brakes into: the next apex at or after i (wrapping). */
export function brakeOwnerAt(zones: CornerZone[], i: number): number {
  let best = -1;
  let first = -1;
  zones.forEach((z, k) => {
    if (z.iApex >= i && (best < 0 || z.iApex < zones[best].iApex)) best = k;
    if (first < 0 || z.iApex < zones[first].iApex) first = k;
  });
  return best >= 0 ? best : first;
}

/** The corner station i drives out of: the last apex at or before i (wrapping). */
export function driveOwnerAt(zones: CornerZone[], i: number): number {
  let best = -1;
  let last = -1;
  zones.forEach((z, k) => {
    if (z.iApex <= i && (best < 0 || z.iApex > zones[best].iApex)) best = k;
    if (last < 0 || z.iApex > zones[last].iApex) last = k;
  });
  return best >= 0 ? best : last;
}

/** A corner's value of `key`, clamped to its bounds, or undefined. */
function cornerValue(params: SimParams, n: number, key: CornerRiderKey): number | undefined {
  const x = params.rider.corners?.[n]?.[key];
  if (x === undefined || !Number.isFinite(x)) return undefined;
  const [lo, hi] = CORNER_RIDER_BOUNDS[key];
  return clamp(x, lo, hi);
}

/** The lap-wide value of a corner key. */
export function lapValue(rider: RiderParams, key: CornerRiderKey): number {
  if (key === 'slideOut') return rider.slideOut ?? 0;
  return rider[key];
}

/** The rider in force at station `i`: lap-wide values with the owning corner's overrides on top. */
export function riderAt(params: SimParams, zones: CornerZone[], i: number): RiderParams {
  const rider = params.rider;
  if (!rider.corners || !zones.length) return rider;
  const own = { zone: zoneOwnerAt(zones, i), brake: brakeOwnerAt(zones, i), drive: driveOwnerAt(zones, i) };
  let out: RiderParams | null = null;
  for (const key of CORNER_RIDER_KEYS) {
    const k = own[CORNER_KEY_REGION[key]];
    if (k < 0) continue;
    const x = cornerValue(params, zones[k].n, key);
    if (x === undefined) continue;
    out ??= { ...rider };
    if (key === 'slideOut') out.slideOut = x;
    else out[key] = x;
  }
  return out ?? rider;
}

/**
 * `riderAt` as a per-station accessor with the merged riders cached per owner
 * triple (a solve asks for every station; there are only a few dozen distinct
 * riders on a lap).
 */
export function riderAccessor(params: SimParams, zones: CornerZone[]): (i: number) => RiderParams {
  const cache = new Map<string, RiderParams>();
  return (i: number): RiderParams => {
    if (!params.rider.corners || !zones.length) return params.rider;
    const key = `${zoneOwnerAt(zones, i)},${brakeOwnerAt(zones, i)},${driveOwnerAt(zones, i)}`;
    let r = cache.get(key);
    if (!r) {
      r = riderAt(params, zones, i);
      cache.set(key, r);
    }
    return r;
  };
}

/** True when any corner overrides anything, or a lap-wide slide out is set (the fast path when neither is). */
export function hasCornerOverrides(params: SimParams): boolean {
  if ((params.rider.slideOut ?? 0) > 0) return true;
  const cs = params.rider.corners;
  if (!cs) return false;
  for (const c of Object.values(cs)) {
    if (!c) continue;
    for (const v of Object.values(c)) if (v !== undefined && Number.isFinite(v)) return true;
  }
  return false;
}

/** Corner slide out in force (its own, else the lap-wide), 0..1. */
function slideOf(params: SimParams, z: CornerZone): number {
  return cornerValue(params, z.n, 'slideOut') ?? clamp(params.rider.slideOut ?? 0, 0, 1);
}

/**
 * Weight of a stretch at every station: 1 on [a, b] (wrapping), a cosine
 * taper over TAPER_M outside it.
 */
export function windowWeights(n: number, stepM: number, a: number, b: number): Float32Array {
  const w = new Float32Array(n);
  const len = cyc(a, b, n);
  const taper = Math.max(1, Math.round(TAPER_M / stepM));
  for (let d = 0; d <= len; d++) w[(a + d) % n] = 1;
  for (let d = 1; d <= taper; d++) {
    const f = 0.5 * (1 + Math.cos((Math.PI * d) / (taper + 1)));
    const ib = (a - d + n) % n;
    const ia = (b + d) % n;
    w[ib] = Math.max(w[ib], f);
    w[ia] = Math.max(w[ia], f);
  }
  return w;
}

/** The stretch a corner's value of a key covers, as [first, last] stations. */
function regionOf(region: 'zone' | 'brake' | 'drive', zones: CornerZone[], k: number, n: number): [number, number] {
  const z = zones[k];
  if (region === 'zone') return [z.i0, z.i1];
  const order = zones.map((_, j) => j).sort((x, y) => zones[x].iApex - zones[y].iApex);
  const r = order.indexOf(k);
  const prev = zones[order[(r - 1 + order.length) % order.length]].iApex;
  const next = zones[order[(r + 1) % order.length]].iApex;
  if (order.length === 1) return region === 'brake' ? [(z.iApex + 1) % n, z.iApex] : [z.iApex, (z.iApex - 1 + n) % n];
  return region === 'brake' ? [(prev + 1) % n, z.iApex] : [z.iApex, (next - 1 + n) % n];
}

/**
 * The value of `key` at every station with the corners' values blended in
 * (each corner's stretch at weight 1, its taper outside; overlapping weights
 * normalised, the lap-wide value filling what is left). Undefined when no
 * corner overrides the key.
 */
export function cornerField(line: Line, params: SimParams, zones: CornerZone[], key: CornerRiderKey): Float64Array | undefined {
  const n = line.points.length;
  const lap = lapValue(params.rider, key);
  const vals = zones.map((z) => cornerValue(params, z.n, key));
  if (!vals.some((v) => v !== undefined)) return undefined;
  const region = CORNER_KEY_REGION[key];
  const stepM = line.lengthM / n;
  const sumW = new Float64Array(n);
  const sumWV = new Float64Array(n);
  zones.forEach((_, k) => {
    // a corner without its own value still takes part (at the lap-wide value) so the blend is symmetric
    const v = vals[k] ?? lap;
    const [a, b] = regionOf(region, zones, k, n);
    const w = windowWeights(n, stepM, a, b);
    for (let i = 0; i < n; i++) {
      if (w[i] <= 0) continue;
      sumW[i] += w[i];
      sumWV[i] += w[i] * v;
    }
  });
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const W = sumW[i];
    out[i] = W >= 1 ? sumWV[i] / W : sumWV[i] + (1 - W) * lap;
  }
  return out;
}

/**
 * Corner z's entry for the slide out: stations from SLIDE_LEAD_M before its
 * zone start to its apex, each with sin(π·t) (t 0 → 1 along the entry).
 */
export function slideEntry(line: Line, z: CornerZone): Array<{ i: number; w: number }> {
  const n = line.points.length;
  const lead = Math.round(SLIDE_LEAD_M / (line.lengthM / n));
  const a = (z.i0 - lead + n) % n;
  const len = cyc(a, z.iApex, n);
  if (len < 2 || len > n / 2) return [];
  const out: Array<{ i: number; w: number }> = [];
  for (let d = 0; d <= len; d++) out.push({ i: (a + d) % n, w: Math.sin((Math.PI * d) / len) });
  return out;
}

/**
 * Per-station caps that express the corner overrides for `solve()`: lateral
 * ceiling from sLat/leanUsage, braking from sBrake, drive from sDrive,
 * `scrubCoef` from slideOut — computed with the SAME formulas the lap-wide
 * rider uses (`tyre.ts` effectiveMu, `vehicle.ts`), only per zone. Returns
 * undefined when nothing is overridden so the rider path stays byte-identical.
 */
export function riderCapsForLine(line: Line, params: SimParams, zones: CornerZone[]): EnvelopeCaps | undefined {
  if (!hasCornerOverrides(params) || !zones.length) return undefined;
  const n = line.points.length;
  const r = params.rider;
  const fLat = cornerField(line, params, zones, 'sLat');
  const fLean = cornerField(line, params, zones, 'leanUsage');
  const fBrake = cornerField(line, params, zones, 'sBrake');
  const fDrive = cornerField(line, params, zones, 'sDrive');
  const slides = zones.map((z) => slideOf(params, z));
  const anySlide = slides.some((s) => s > 0);
  if (!fLat && !fLean && !fBrake && !fDrive && !anySlide) return undefined;

  const m = params.machine;
  const pinnedBrakingG = r.overrides.includes('brakingG');
  const aLat = new Float32Array(n);
  const axis = new Float32Array(n);
  const brake = new Float32Array(n);
  const drive = new Float32Array(n);
  // the lean → lateral-g inversion is the costly part: once per distinct leanUsage
  const tanIdeal = new Map<number, number>();
  const tanFor = (lean: number): number => {
    let t = tanIdeal.get(lean);
    if (t === undefined) {
      t = Math.tan(idealLeanLimitRad(m, (params.tyre.maxLeanDeg * lean * Math.PI) / 180));
      tanIdeal.set(lean, t);
    }
    return t;
  };
  for (let i = 0; i < n; i++) {
    const s = {
      sBrake: fBrake ? fBrake[i] : r.sBrake,
      sDrive: fDrive ? fDrive[i] : r.sDrive,
      sLat: fLat ? fLat[i] : r.sLat,
    };
    const mu = effectiveMu(params.tyre, s);
    const lean = fLean ? fLean[i] : r.leanUsage;
    // the solver's own formulas (prepare(): aLatMax, aLatTyre, aBrakeMax, aDriveMax)
    aLat[i] = Math.max(0.1, Math.min(mu.lat, tanFor(lean)) * G);
    axis[i] = Math.max(0.1, mu.lat * G);
    brake[i] = Math.max(0.1, (pinnedBrakingG ? Math.min(r.brakingG, mu.brake) : mu.brake) * G);
    drive[i] = Math.max(0.1, mu.drive * G);
  }
  let scrub: Float32Array | undefined;
  zones.forEach((z, k) => {
    const s = slides[k];
    if (!(s > 0)) return;
    scrub ??= new Float32Array(n);
    for (const { i, w } of slideEntry(line, z)) {
      scrub[i] = Math.max(scrub[i], s * SLIDE_SCRUB_K * w);
      aLat[i] *= 1 + s * SLIDE_LAT_EXCESS * w;
      axis[i] = Math.max(axis[i], aLat[i]);
    }
  });
  return { aLatMs2: aLat, latAxisMs2: axis, brakeMs2: brake, driveMs2: drive, ...(scrub ? { scrubCoef: scrub } : {}) };
}

/** The C (κ 0) and V (κ 1) minimum-curvature lines and the offset box, for per-corner κ. */
export interface CornerLineBasis {
  cOffsetsM: Float32Array;
  vOffsetsM: Float32Array;
  loM: Float32Array;
  hiM: Float32Array;
}

const basisCache = new WeakMap<TrackModel, { key: string; corridor: Corridor | undefined; basis: CornerLineBasis }>();

/** C / V lines and the box (cached per track, corridor and tyre margins: they do not depend on the rider). */
export function cornerLineBasis(track: TrackModel, corridor: Corridor | undefined, params: SimParams): CornerLineBasis {
  const key = `${params.tyre.kerbMarginM}|${params.tyre.kerbM ?? ''}`;
  const hit = basisCache.get(track);
  if (hit && hit.key === key && hit.corridor === corridor) return hit.basis;
  const flat = (kappa: number): SimParams => ({ ...params, rider: { ...params.rider, kappa, lineMode: 'min-curvature', lineDeviationM: 0 } });
  const { loM, hiM } = offsetBounds(track, corridor, params);
  const basis: CornerLineBasis = {
    cOffsetsM: Float32Array.from(buildLine(track, corridor, flat(0)).offsetM),
    vOffsetsM: Float32Array.from(buildLine(track, corridor, flat(1)).offsetM),
    loM,
    hiM,
  };
  basisCache.set(track, { key, corridor, basis });
  return basis;
}

/** True when the line itself changes with the overrides (κ or a slide out somewhere). */
export function lineHasOverrides(params: SimParams, zones: CornerZone[]): boolean {
  return zones.some((z) => cornerValue(params, z.n, 'kappa') !== undefined || slideOf(params, z) > 0);
}

/**
 * The offsets of the rider's line with per-corner κ and slide out, on top of
 * the lap-wide line's offsets `base`: inside a zone that overrides κ the
 * offsets move by (κ_k − κ_lap)·(V − C) (25 m cosine taper), so a corner κ
 * equal to the lap-wide κ changes nothing; a slide out widens the entry
 * toward the outside (back on the normal line at the apex). Kept inside the box.
 */
export function riderOffsets(base: Float32Array, stepM: number, basis: CornerLineBasis, params: SimParams, zones: CornerZone[], line: Line): Float32Array {
  const n = base.length;
  const d = Float32Array.from(base);
  const kLap = params.rider.kappa;
  for (const z of zones) {
    const kz = cornerValue(params, z.n, 'kappa');
    if (kz === undefined) continue;
    const dk = kz - kLap;
    if (Math.abs(dk) < 1e-9) continue;
    const w = windowWeights(n, stepM, z.i0, z.i1);
    for (let i = 0; i < n; i++) if (w[i] > 0) d[i] += w[i] * dk * (basis.vOffsetsM[i] - basis.cOffsetsM[i]);
  }
  for (const z of zones) {
    const s = slideOf(params, z);
    if (!(s > 0)) continue;
    const entry = slideEntry(line, z);
    const L = entry.length * stepM;
    const dir = z.dir === 'L' ? 1 : -1;
    const amp = -dir * s * Math.min(SLIDE_OFFSET_M, (SLIDE_CURV_MAX * L * L) / (2 * Math.PI * Math.PI));
    for (const { i, w } of entry) d[i] += amp * w * w;
  }
  for (let i = 0; i < n; i++) {
    const b = base[i];
    d[i] = clamp(d[i], Math.min(basis.loM[i], b), Math.max(basis.hiM[i], b));
  }
  return d;
}

/**
 * The rider's line on a given lap-wide line `base` (already `buildLine(...)`
 * for these params): exactly `base` when no corner changes the line.
 */
export function riderLineOn(track: TrackModel, corridor: Corridor | undefined, base: Line, params: SimParams, zones: CornerZone[]): Line {
  if (!lineHasOverrides(params, zones)) return base;
  const basis = cornerLineBasis(track, corridor, params);
  const n = base.points.length;
  return lineFromOffsets(track, riderOffsets(base.offsetM, base.lengthM / n, basis, params, zones, base));
}

/**
 * The rider's line with per-corner κ: lap-wide `buildLine`, then inside each
 * zone that overrides `kappa` the offsets blend between the C (κ 0) and V
 * (κ 1) lines with a 25 m cosine taper; `slideOut` widens the entry. Without
 * overrides this is exactly `buildLine(...)`.
 */
export function riderLine(track: TrackModel, corridor: Corridor | undefined, params: SimParams): { line: Line; zones: CornerZone[] } {
  const base = buildLine(track, corridor, params);
  const zones = cornerZones(base, track);
  return { line: riderLineOn(track, corridor, base, params, zones), zones };
}
