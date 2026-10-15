// Frame cache for instant scrubbing: the synced laps are pre-extracted once into small JPEG
// frames (≈640 px wide, on a fixed `fps` grid) kept in memory and in IndexedDB (keyed by the
// file's name + size + mtime), plus a bounded LRU of decoded ImageBitmaps for drawing.
//
// Extraction never blocks the UI: phase 1 plays a hidden muted copy of the video fast and grabs
// frames in requestVideoFrameCallback; phase 2 seeks to whatever slots were dropped.
import { cacheSlot, cacheSlots, estimateFps, Lru, nearestCachedSlot } from './sync';

export interface CacheOptions {
  /** Grid rate, frames per second of video. */
  fps: number;
  /** Width of a cached frame, px. */
  width: number;
  /** Most frames one build may hold (the rate drops to fit). */
  maxFrames: number;
  /** Decoded bitmaps kept ready to draw. */
  decodedMax: number;
  /** JPEG quality 0..1. */
  quality: number;
}

export const DEFAULT_CACHE_OPTIONS: CacheOptions = { fps: 15, width: 640, maxFrames: 6000, decodedMax: 90, quality: 0.78 };

export interface CacheProgress {
  done: number;
  total: number;
  phase: 'idb' | 'play' | 'seek' | 'done';
}

export function fileCacheKey(f: Pick<File, 'name' | 'size' | 'lastModified'>): string {
  return `${f.name}|${f.size}|${f.lastModified}`;
}

// ---- IndexedDB (best effort: any failure just means "no persistent cache") ----------

const DB_NAME = 'dda-lab-video';
const STORE = 'frames';

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** Key layout: [fileKey, fpsMilli, slot] so one file+rate is a contiguous key range. */
const idbKey = (fileKey: string, fps: number, k: number): IDBValidKey => [fileKey, Math.round(fps * 1000), k];

async function idbLoad(db: IDBDatabase, fileKey: string, fps: number, k0: number, k1: number): Promise<Map<number, Blob>> {
  return new Promise((resolve) => {
    const out = new Map<number, Blob>();
    try {
      const tx = db.transaction(STORE, 'readonly');
      const range = IDBKeyRange.bound(idbKey(fileKey, fps, k0), idbKey(fileKey, fps, k1));
      const req = tx.objectStore(STORE).openCursor(range);
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return resolve(out);
        const key = c.key as [string, number, number];
        if (c.value instanceof Blob) out.set(key[2], c.value);
        c.continue();
      };
      req.onerror = () => resolve(out);
    } catch {
      resolve(out);
    }
  });
}

function idbPut(db: IDBDatabase, fileKey: string, fps: number, items: Array<[number, Blob]>): void {
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const st = tx.objectStore(STORE);
    for (const [k, b] of items) st.put(b, idbKey(fileKey, fps, k));
  } catch {
    /* quota / private mode */
  }
}

// ---- the cache -------------------------------------------------------------------------

export class FrameCache {
  readonly blobs = new Map<number, Blob>();
  readonly decoded: Lru<number, ImageBitmap>;
  private decoding = new Map<number, Promise<ImageBitmap | undefined>>();
  /** Grid rate actually in use (may be below opts.fps for a long range). */
  fps: number;
  private abort = false;
  building = false;

  constructor(
    readonly fileKey: string,
    readonly opts: CacheOptions = DEFAULT_CACHE_OPTIONS,
  ) {
    this.fps = opts.fps;
    this.decoded = new Lru<number, ImageBitmap>(opts.decodedMax, (b) => b.close());
  }

  get size(): number {
    return this.blobs.size;
  }

  /** Approximate bytes held (JPEGs + decoded bitmaps). */
  bytes(): number {
    let n = 0;
    for (const b of this.blobs.values()) n += b.size;
    return n + this.decoded.size * this.opts.width * Math.round((this.opts.width * 9) / 16) * 4;
  }

  slotOf(t: number): number {
    return cacheSlot(t, this.fps);
  }

  /** Nearest cached slot to video time t (±2 slots), or null. */
  nearest(t: number): number | null {
    return nearestCachedSlot(this.slotOf(t), (k) => this.blobs.has(k));
  }

  /** Decoded bitmap for slot k if ready (synchronous, for instant drawing). */
  bitmapNow(k: number): ImageBitmap | undefined {
    return this.decoded.get(k);
  }

  decode(k: number): Promise<ImageBitmap | undefined> {
    const ready = this.decoded.get(k);
    if (ready) return Promise.resolve(ready);
    const pending = this.decoding.get(k);
    if (pending) return pending;
    const blob = this.blobs.get(k);
    if (!blob) return Promise.resolve(undefined);
    const p = createImageBitmap(blob)
      .then((bmp) => {
        this.decoded.set(k, bmp);
        return bmp;
      })
      .catch(() => undefined)
      .finally(() => this.decoding.delete(k));
    this.decoding.set(k, p);
    return p;
  }

  /** Decode the slots around k ahead of time (both directions, nearest first). */
  prefetch(k: number, radius = 12): void {
    const budget = Math.min(radius, Math.floor(this.opts.decodedMax / 3));
    for (let d = 0; d <= budget; d++) {
      for (const j of d ? [k + d, k - d] : [k]) {
        if (this.blobs.has(j) && !this.decoded.has(j) && !this.decoding.has(j) && this.decoding.size < 6) void this.decode(j);
      }
    }
  }

  cancel(): void {
    this.abort = true;
  }

  dispose(): void {
    this.cancel();
    this.decoded.clear();
    this.blobs.clear();
  }

  /**
   * Fill the cache for video times [range] from `url`. Resolves when every slot is cached
   * (or the build is cancelled). `onProgress` is called often; throttle in the UI.
   */
  async build(url: string, range: [number, number], duration: number, onProgress: (p: CacheProgress) => void, playRate = 4): Promise<void> {
    this.abort = false;
    this.building = true;
    try {
      const { fps, slots } = cacheSlots(range, this.opts.fps, duration, this.opts.maxFrames);
      if (fps !== this.fps) {
        // a different grid: the frames held are on the old one
        this.fps = fps;
        this.blobs.clear();
        this.decoded.clear();
      }
      const total = slots.length;
      if (!total) return onProgress({ done: 0, total: 0, phase: 'done' });
      const want = new Set(slots);
      const count = () => slots.reduce((n, k) => n + (this.blobs.has(k) ? 1 : 0), 0);

      // 0) frames from an earlier visit
      onProgress({ done: count(), total, phase: 'idb' });
      const db = await openDb();
      if (db) {
        const got = await idbLoad(db, this.fileKey, fps, slots[0], slots[total - 1]);
        for (const [k, b] of got) if (want.has(k)) this.blobs.set(k, b);
      }
      let done = count();
      onProgress({ done, total, phase: done >= total ? 'done' : 'play' });
      if (done >= total || this.abort) return;

      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      v.crossOrigin = 'anonymous';
      // must be rendered for requestVideoFrameCallback; invisible and inert
      Object.assign(v.style, { position: 'fixed', left: '0', top: '0', width: '4px', height: '4px', opacity: '0.01', pointerEvents: 'none', zIndex: '-1' });
      document.body.appendChild(v);
      v.src = url;
      try {
        await once(v, 'loadedmetadata', 15000);
        const w = Math.min(this.opts.width, v.videoWidth || this.opts.width);
        const h = Math.max(2, Math.round((w * (v.videoHeight || 9)) / (v.videoWidth || 16)));
        const pendingPut: Array<[number, Blob]> = [];
        let inflight = 0;
        const claimed = new Set<number>();
        const grab = (k: number): void => {
          if (this.blobs.has(k) || claimed.has(k) || !want.has(k)) return;
          const oc = new OffscreenCanvas(w, h);
          const ctx = oc.getContext('2d');
          if (!ctx) return;
          ctx.drawImage(v, 0, 0, w, h);
          claimed.add(k);
          inflight++;
          void oc
            .convertToBlob({ type: 'image/jpeg', quality: this.opts.quality })
            .then((b) => {
              this.blobs.set(k, b);
              pendingPut.push([k, b]);
              if (db && pendingPut.length >= 30) idbPut(db, this.fileKey, fps, pendingPut.splice(0));
            })
            .catch(() => claimed.delete(k))
            .finally(() => inflight--);
          done++;
          onProgress({ done, total, phase: 'play' });
        };

        // 1) fast muted playback, grabbing presented frames near grid slots
        const a = slots[0] / fps;
        const b = slots[total - 1] / fps;
        const hasRvfc = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
        if (hasRvfc && total > 20) {
          v.currentTime = a;
          await once(v, 'seeked', 5000);
          v.playbackRate = playRate;
          await new Promise<void>((resolve) => {
            let finished = false;
            const end = () => {
              if (finished) return;
              finished = true;
              v.pause();
              resolve();
            };
            const tick = (_now: number, meta: VideoFrameCallbackMetadata) => {
              if (this.abort) return end();
              const mt = meta.mediaTime;
              const k = Math.round(mt * fps);
              if (Math.abs(mt - k / fps) <= 0.5 / fps) grab(k);
              if (mt >= b || v.ended) return end();
              v.requestVideoFrameCallback(tick);
            };
            v.requestVideoFrameCallback(tick);
            v.addEventListener('ended', end, { once: true });
            v.play().catch(end);
            // a stalled decoder must not hang the build
            const watchdog = window.setInterval(() => {
              if (finished) return window.clearInterval(watchdog);
              if (v.paused && !v.ended) v.play().catch(end);
            }, 1000);
          });
        }

        // 2) seek to each slot still missing
        for (const k of slots) {
          if (this.abort) break;
          if (this.blobs.has(k) || claimed.has(k)) continue;
          onProgress({ done, total, phase: 'seek' });
          v.currentTime = Math.min(k / fps, Math.max(0, duration - 0.01));
          const ok = await once(v, 'seeked', 3000);
          if (!ok) continue;
          grab(k);
          // yield so the UI breathes between seeks
          if (k % 8 === 0) await new Promise((r) => setTimeout(r, 0));
        }
        while (inflight > 0) await new Promise((r) => setTimeout(r, 10));
        if (db && pendingPut.length) idbPut(db, this.fileKey, fps, pendingPut.splice(0));
      } finally {
        v.removeAttribute('src');
        v.load();
        v.remove();
      }
      onProgress({ done: count(), total, phase: 'done' });
    } finally {
      this.building = false;
    }
  }
}

/** Frame-rate estimate: play a hidden muted copy briefly and read presented media times. */
export async function probeFps(url: string, maxMs = 1500): Promise<number | null> {
  if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) return null;
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  Object.assign(v.style, { position: 'fixed', left: '0', top: '0', width: '4px', height: '4px', opacity: '0.01', pointerEvents: 'none', zIndex: '-1' });
  document.body.appendChild(v);
  v.src = url;
  try {
    if (!(await once(v, 'loadedmetadata', 8000))) return null;
    const times: number[] = [];
    await new Promise<void>((resolve) => {
      const stop = window.setTimeout(resolve, maxMs);
      const tick = (_n: number, m: VideoFrameCallbackMetadata) => {
        times.push(m.mediaTime);
        if (times.length >= 24) {
          window.clearTimeout(stop);
          return resolve();
        }
        v.requestVideoFrameCallback(tick);
      };
      v.requestVideoFrameCallback(tick);
      v.play().catch(() => resolve());
    });
    return estimateFps(times);
  } finally {
    v.pause();
    v.removeAttribute('src');
    v.load();
    v.remove();
  }
}

function once(el: HTMLElement, ev: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const t = window.setTimeout(() => {
      el.removeEventListener(ev, h);
      resolve(false);
    }, timeoutMs);
    const h = () => {
      window.clearTimeout(t);
      resolve(true);
    };
    el.addEventListener(ev, h, { once: true });
  });
}
