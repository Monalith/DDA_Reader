// Result cache for the optimal solver modes (spec v2 §2.10: "sonuç
// `(trackKey, machine, tyre)` anahtarıyla önbellek"). A free-trajectory run
// takes seconds and an OCP minutes, and neither depends on the rider sliders,
// so a result is reusable for as long as the circuit, the machine and the tyre
// stay the same.
//
// Two layers: an in-memory map (always) and a key-value storage the caller
// injects (the browser passes `localStorage`; tests pass a Map). Nothing here
// touches a browser global, so it runs under vitest's node environment.
import type { TrackModel } from '../core/types';
import { corridorKey } from './corridorCache';
import type { SimParams } from './types';

export interface KVStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

/** Storage namespace, so the cache never collides with the app's other keys. */
export const OPT_STORAGE_PREFIX = 'ddaLab.opt.';

/** Entries kept in memory; each is one Float32Array of ~1.5k samples. */
const MEMORY_MAX = 8;

const memory = new Map<string, { offsetsM: Float32Array; lapTimeS: number }>();

/** JSON with object keys sorted, so the hash does not depend on construction order. */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** FNV-1a, 32 bit, as 8 hex characters. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * `corridorKey(track)` + mode + a hash of the machine and the tyre. The RIDER
 * is deliberately not part of it: the optimal modes always solve for the ideal
 * rider, so moving the aggressiveness/risk sliders must hit the same entry.
 * `presetId` is a label, not physics, and is left out too.
 */
export function optCacheKey(track: TrackModel, params: SimParams, mode: 'freeTrajectory' | 'ocp'): string {
  const { presetId: _presetId, ...machine } = params.machine;
  void _presetId;
  const hash = fnv1a(stableStringify({ machine, tyre: params.tyre }));
  return `${corridorKey(track)}.${mode === 'freeTrajectory' ? 'ft' : 'ocp'}.${hash}`;
}

interface StoredOpt {
  v: 1;
  lapTimeS: number;
  offsetsM: number[];
}

function remember(key: string, offsetsM: Float32Array, lapTimeS: number): void {
  memory.delete(key);
  memory.set(key, { offsetsM: Float32Array.from(offsetsM), lapTimeS });
  while (memory.size > MEMORY_MAX) memory.delete(memory.keys().next().value as string);
}

/**
 * Cached offsets for `key`, or null when there are none, when they were
 * computed for a centerline with a different number of points, or when the
 * stored entry is malformed. Always a fresh copy.
 */
export function readOpt(key: string, nPoints: number, storage?: KVStorage): Float32Array | null {
  const hit = memory.get(key);
  if (hit) return hit.offsetsM.length === nPoints ? Float32Array.from(hit.offsetsM) : null;
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(OPT_STORAGE_PREFIX + key);
  } catch {
    return null;
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const s = parsed as Partial<StoredOpt> | null;
  if (!s || typeof s !== 'object' || s.v !== 1 || !Array.isArray(s.offsetsM)) return null;
  if (typeof s.lapTimeS !== 'number' || !Number.isFinite(s.lapTimeS)) return null;
  if (s.offsetsM.length !== nPoints) return null;
  for (const d of s.offsetsM) if (typeof d !== 'number' || !Number.isFinite(d)) return null;
  const out = Float32Array.from(s.offsetsM);
  remember(key, out, s.lapTimeS);
  return out;
}

/**
 * Store a result in memory and, when given, in `storage`. A storage that
 * throws (quota, private mode) is ignored: the cache is an optimisation.
 * Float32 values survive JSON exactly (every float32 is a double).
 */
export function writeOpt(key: string, offsetsM: Float32Array, lapTimeS: number, storage?: KVStorage): void {
  remember(key, offsetsM, lapTimeS);
  if (!storage) return;
  const rec: StoredOpt = { v: 1, lapTimeS, offsetsM: Array.from(offsetsM) };
  try {
    storage.setItem(OPT_STORAGE_PREFIX + key, JSON.stringify(rec));
  } catch {
    // quota exceeded or storage unavailable: memory still has it
  }
}
