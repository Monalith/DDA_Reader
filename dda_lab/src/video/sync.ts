// Onboard video ⇔ telemetry sync math (pure; unit-tested in tests/unit/videoSync.test.ts).
//
// The model is one offset per session:  video_time = session_time(sample) − offsetS.
// Everything here works on plain arrays so it can run without the store or the DOM.

export interface VideoSync {
  sessionId: string;
  fileName: string;
  offsetS: number;
  /** Video time (s) the user marked as the start line (🏁 Start line button); undefined until set. */
  startVideoS?: number;
}

/** Video time (s) of a session sample. */
export function videoTimeOfIdx(t: ArrayLike<number>, idx: number, offsetS: number): number {
  const i = Math.max(0, Math.min(t.length - 1, idx));
  return t[i] - offsetS;
}

/** Index of the sample nearest to session time `time` (t sorted ascending); −1 when t is empty. */
export function nearestIdx(t: ArrayLike<number>, time: number): number {
  const n = t.length;
  if (!n) return -1;
  if (time <= t[0]) return 0;
  if (time >= t[n - 1]) return n - 1;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= time) lo = mid;
    else hi = mid;
  }
  return time - t[lo] <= t[hi] - time ? lo : hi;
}

/**
 * Sample matching a video time, or null when the video time falls outside the
 * session (more than half a sample period before its first / after its last sample).
 */
export function idxForVideoTime(t: ArrayLike<number>, videoT: number, offsetS: number): number | null {
  const n = t.length;
  if (!n) return null;
  const st = videoT + offsetS;
  const dt = n > 1 ? (t[n - 1] - t[0]) / (n - 1) : 0.1;
  if (st < t[0] - dt / 2 || st > t[n - 1] + dt / 2) return null;
  return nearestIdx(t, st);
}

/** Offset that makes video time `videoT` show session time `sessionT`. */
export function offsetFromPair(sessionT: number, videoT: number): number {
  return sessionT - videoT;
}

/** Round an offset to the input's 0.01 s / 1e-4 resolution without float noise. */
export function roundOffset(v: number): number {
  return Math.round(v * 10000) / 10000;
}

// ---- frames ------------------------------------------------------------------

/** Index of the frame displayed at time t (frame i covers [i/fps, (i+1)/fps)). */
export function frameIndexAt(t: number, fps: number): number {
  return Math.floor(t * fps + 1e-4);
}

/** Seek target for frame i: its centre, so rounding never lands on a neighbour. */
export function frameSeekTime(i: number, fps: number): number {
  return (Math.max(0, i) + 0.5) / fps;
}

/** Time after stepping n frames from t (lands on the frame centre). */
export function stepFrames(t: number, fps: number, n: number, duration = Infinity): number {
  const maxFrame = Number.isFinite(duration) ? Math.max(0, Math.floor(duration * fps - 1e-6)) : Infinity;
  const i = Math.max(0, Math.min(maxFrame, frameIndexAt(t, fps) + n));
  return frameSeekTime(i, fps);
}

const COMMON_FPS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 100, 119.88, 120, 240];

/**
 * Frame-rate estimate from consecutive presented media times (requestVideoFrameCallback):
 * the median positive step, snapped to a common rate when within 1.5 %.
 */
export function estimateFps(mediaTimes: number[]): number | null {
  const d: number[] = [];
  for (let i = 1; i < mediaTimes.length; i++) {
    const x = mediaTimes[i] - mediaTimes[i - 1];
    if (x > 1e-4 && x < 0.5) d.push(x);
  }
  if (d.length < 3) return null;
  d.sort((a, b) => a - b);
  // the smallest steps are true frame steps; larger ones are dropped frames
  const q = d[Math.floor(d.length * 0.25)];
  const raw = 1 / q;
  let best = raw;
  let bestErr = Infinity;
  for (const f of COMMON_FPS) {
    const err = Math.abs(f - raw) / f;
    if (err < bestErr) {
      bestErr = err;
      best = f;
    }
  }
  return bestErr < 0.015 ? best : Math.round(raw * 100) / 100;
}

// ---- frame cache grid ---------------------------------------------------------

/** Grid slot of the cache (k ↔ time k / cacheFps) nearest to video time t. */
export function cacheSlot(t: number, cacheFps: number): number {
  return Math.round(t * cacheFps);
}

/**
 * Grid slots covering [a, b] (clamped to [0, duration]), at most `maxFrames`:
 * the rate drops so the whole range fits. Returns the slots and the rate used.
 */
export function cacheSlots(range: [number, number], cacheFps: number, duration: number, maxFrames: number): { fps: number; slots: number[] } {
  const a = Math.max(0, Math.min(range[0], range[1]));
  const b = Math.min(Number.isFinite(duration) ? duration : Infinity, Math.max(range[0], range[1]));
  if (!(b > a)) return { fps: cacheFps, slots: [] };
  let fps = cacheFps;
  if ((b - a) * fps + 1 > maxFrames) fps = Math.max(0.5, (maxFrames - 1) / (b - a));
  const k0 = Math.max(0, Math.ceil(a * fps - 1e-9));
  const k1 = Math.floor(b * fps + 1e-9);
  const slots: number[] = [];
  for (let k = k0; k <= k1 && slots.length < maxFrames; k++) slots.push(k);
  return { fps, slots };
}

/** Nearest slot present in `has`, searching ±maxDist slots around k; null when none. */
export function nearestCachedSlot(k: number, has: (k: number) => boolean, maxDist = 2): number | null {
  if (has(k)) return k;
  for (let d = 1; d <= maxDist; d++) {
    if (has(k - d)) return k - d;
    if (has(k + d)) return k + d;
  }
  return null;
}

/** Small LRU map; `onEvict` releases evicted values (ImageBitmap.close). */
export class Lru<K, V> {
  private m = new Map<K, V>();
  constructor(
    public capacity: number,
    private onEvict?: (v: V, k: K) => void,
  ) {}
  get size(): number {
    return this.m.size;
  }
  has(k: K): boolean {
    return this.m.has(k);
  }
  get(k: K): V | undefined {
    const v = this.m.get(k);
    if (v === undefined) return undefined;
    this.m.delete(k);
    this.m.set(k, v);
    return v;
  }
  set(k: K, v: V): void {
    const old = this.m.get(k);
    if (old !== undefined) {
      this.m.delete(k);
      if (old !== v) this.onEvict?.(old, k);
    }
    this.m.set(k, v);
    while (this.m.size > this.capacity) {
      const first = this.m.keys().next();
      if (first.done) break;
      const ev = this.m.get(first.value)!;
      this.m.delete(first.value);
      this.onEvict?.(ev, first.value);
    }
  }
  clear(): void {
    if (this.onEvict) for (const [k, v] of this.m) this.onEvict(v, k);
    this.m.clear();
  }
}

// ---- ranges --------------------------------------------------------------------

export interface LapLike {
  n: number;
  startIdx: number;
  endIdx: number;
}

export function lapAtIdx<L extends LapLike>(laps: L[], idx: number): L | undefined {
  return laps.find((l) => idx >= l.startIdx && idx <= l.endIdx);
}

/** Video-time range of a lap. */
export function lapVideoRange(t: ArrayLike<number>, lap: LapLike, offsetS: number): [number, number] {
  return [videoTimeOfIdx(t, lap.startIdx, offsetS), videoTimeOfIdx(t, lap.endIdx, offsetS)];
}

/**
 * Sample range of a chart x-range inside one lap. `xs` is the lap's x array
 * (lap distance or lap time, `lapX`), monotonic; returns absolute session indices.
 */
export function xRangeToIdxRange(xs: ArrayLike<number>, lapStartIdx: number, xRange: [number, number]): [number, number] | null {
  const lo = Math.min(xRange[0], xRange[1]);
  const hi = Math.max(xRange[0], xRange[1]);
  let a = -1;
  let b = -1;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    if (!Number.isFinite(x)) continue;
    if (x >= lo && a < 0) a = i;
    if (x <= hi) b = i;
  }
  if (a < 0 || b < a) return null;
  return [lapStartIdx + a, lapStartIdx + b];
}

/** Union of the selected laps' video ranges (for pre-processing), or null without laps. */
export function lapsVideoRange(t: ArrayLike<number>, laps: LapLike[], offsetS: number, padS = 1): [number, number] | null {
  if (!laps.length) return null;
  let a = Infinity;
  let b = -Infinity;
  for (const l of laps) {
    const [x, y] = lapVideoRange(t, l, offsetS);
    a = Math.min(a, x);
    b = Math.max(b, y);
  }
  return [a - padS, b + padS];
}

// ---- formatting / persistence --------------------------------------------------

/** mm:ss.cc (or h:mm:ss.cc) */
export function fmtTimecode(t: number): string {
  if (!Number.isFinite(t)) return '–';
  const sign = t < 0 ? '−' : '';
  const a = Math.abs(t);
  const h = Math.floor(a / 3600);
  const m = Math.floor((a % 3600) / 60);
  const s = a - h * 3600 - m * 60;
  const ss = s.toFixed(2).padStart(5, '0');
  return h ? `${sign}${h}:${String(m).padStart(2, '0')}:${ss}` : `${sign}${String(m).padStart(2, '0')}:${ss}`;
}

export const VIDEO_SYNC_KEY = 'dda-lab-video-sync';

export interface StoredSync {
  offsetS: number;
  sessionName?: string;
  startVideoS?: number;
}

type KV = Pick<Storage, 'getItem' | 'setItem'>;

export function loadStoredSyncs(storage: KV | undefined): Record<string, StoredSync> {
  try {
    const raw = storage?.getItem(VIDEO_SYNC_KEY);
    const j = raw ? JSON.parse(raw) : {};
    return j && typeof j === 'object' ? (j as Record<string, StoredSync>) : {};
  } catch {
    return {};
  }
}

export function storeSync(storage: KV | undefined, fileName: string, s: StoredSync): void {
  try {
    const all = loadStoredSyncs(storage);
    all[fileName] = s;
    storage?.setItem(VIDEO_SYNC_KEY, JSON.stringify(all));
  } catch {
    /* storage blocked: the sync only lives for this page */
  }
}
