// Usage statistics client: a small queue of events posted to the bridge
// (/api/stats/events, bridge/stats.py). Never throws, never blocks the UI.
// Flushes every 10 s, at 20 queued events, and when the tab is hidden / closed
// (navigator.sendBeacon, fetch keepalive as the fallback).
import { apiBase } from '../auth/client';

export interface TrackEvent {
  event: string;
  ts: string;
  props?: Record<string, unknown>;
}

/** Delivers one batch; returns false when it could not be handed off. */
export type Sender = (url: string, body: string, beacon: boolean) => boolean | Promise<boolean>;

export interface TrackerOptions {
  sender?: Sender;
  endpoint?: () => string;
  anonId?: () => string;
  /** false → track() is a no-op (automation / opt-out). */
  enabled?: () => boolean;
  now?: () => Date;
  flushEvery?: number;
  maxQueue?: number;
}

export const ANON_KEY = 'dda-lab-anon-id';
const MAX_BATCH = 50; // server cap per POST
const MAX_PENDING = 500; // never grow unbounded when the bridge is down

function randomId(): string {
  try {
    const c = (globalThis as { crypto?: Crypto }).crypto;
    if (c?.randomUUID) return c.randomUUID();
  } catch {
    /* fall through */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

let memoryAnonId: string | null = null;
export function anonId(): string {
  try {
    const ls = globalThis.localStorage;
    let id = ls?.getItem(ANON_KEY);
    if (!id) {
      id = randomId();
      ls?.setItem(ANON_KEY, id);
    }
    return id;
  } catch {
    return (memoryAnonId ??= randomId());
  }
}

export const defaultSender: Sender = (url, body, beacon) => {
  try {
    const nav = globalThis.navigator as Navigator | undefined;
    // Always a beacon when available (fire-and-forget, survives page close); `beacon` only
    // marks the hide/close flush. text/plain is CORS-safelisted → no preflight in dev.
    void beacon;
    if (nav?.sendBeacon && nav.sendBeacon(url, new Blob([body], { type: 'text/plain' }))) return true;
    if (typeof fetch !== 'function') return false;
    void fetch(url, {
      method: 'POST',
      body,
      keepalive: true,
      credentials: 'include',
      headers: { 'content-type': 'text/plain' },
    }).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
};

/** Automation (Playwright sets navigator.webdriver) is not counted unless ?track=1. */
export function trackingAllowed(): boolean {
  try {
    const forced = new URLSearchParams(globalThis.location?.search ?? '').get('track');
    if (forced === '1') return true;
    if (forced === '0') return false;
    return !(globalThis.navigator as Navigator | undefined)?.webdriver;
  } catch {
    return false;
  }
}

export interface Tracker {
  track(event: string, props?: Record<string, unknown>): void;
  flush(beacon?: boolean): void;
  pending(): number;
  dispose(): void;
}

export function createTracker(opts: TrackerOptions = {}): Tracker {
  const sender = opts.sender ?? defaultSender;
  const endpoint = opts.endpoint ?? (() => `${apiBase()}/api/stats/events`);
  const getAnon = opts.anonId ?? anonId;
  const enabled = opts.enabled ?? trackingAllowed;
  const now = opts.now ?? (() => new Date());
  const flushEvery = opts.flushEvery ?? 10_000;
  const maxQueue = opts.maxQueue ?? 20;
  let queue: TrackEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const flush = (beacon = false) => {
    clearTimer();
    try {
      while (queue.length) {
        const batch = queue.slice(0, MAX_BATCH);
        const body = JSON.stringify({ anonId: getAnon(), events: batch });
        const ok = sender(endpoint(), body, beacon);
        if (ok === false) break; // keep for the next attempt
        queue = queue.slice(batch.length);
        if (ok instanceof Promise) void ok.catch(() => undefined);
      }
    } catch {
      /* never throw */
    }
  };

  return {
    track(event, props) {
      try {
        if (!enabled()) return;
        const ev: TrackEvent = { event, ts: now().toISOString() };
        if (props && Object.keys(props).length) ev.props = props;
        queue.push(ev);
        if (queue.length > MAX_PENDING) queue = queue.slice(-MAX_PENDING);
        if (queue.length >= maxQueue) flush();
        else if (timer === null) timer = setTimeout(() => flush(), flushEvery);
      } catch {
        /* never throw */
      }
    },
    flush,
    pending: () => queue.length,
    dispose() {
      clearTimer();
      queue = [];
    },
  };
}

let shared: Tracker | null = null;
function tracker(): Tracker {
  return (shared ??= createTracker());
}

/** Record a usage event (queued; sent in batches). Safe to call anywhere. */
export function track(event: string, props?: Record<string, unknown>): void {
  tracker().track(event, props);
}

/** For export buttons (CSV, PNG, workspace…): `trackExport('csv')`. */
export function trackExport(kind: string, props?: Record<string, unknown>): void {
  track('export', { kind, ...props });
}

export function flushTracking(beacon = false): void {
  tracker().flush(beacon);
}
