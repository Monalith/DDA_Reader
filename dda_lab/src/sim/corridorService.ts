// Client for the corridor store on the DDA Lab bridge.
//
// The corridor is extracted once and kept on the server, so visitors share one
// copy instead of each browser fetching ~54 satellite tiles.
//
// NOTE: src/bridge/client.ts hardcodes http://127.0.0.1:8777, which makes it
// local-only — on the deployed site that address is the VISITOR's machine. The
// corridor client therefore talks to its own origin in production and only
// falls back to the local bridge in dev.
import type { TrackModel } from '../core/types';
import { corridorKey, deserializeCorridor, serializeCorridor } from './corridorCache';
import type { Corridor } from './types';

export const LOCAL_BRIDGE = 'http://127.0.0.1:8777';
const TIMEOUT_MS = 8000;

/** Same origin in production; the local bridge when running `npm run dev`. */
export function corridorBase(): string {
  if (typeof window === 'undefined') return LOCAL_BRIDGE;
  return import.meta.env.DEV ? LOCAL_BRIDGE : window.location.origin;
}

async function withTimeout(url: string, init: RequestInit): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The stored corridor for this track, or null when there is none or it is stale. */
export async function fetchCorridor(track: TrackModel): Promise<Corridor | null> {
  // No window means a unit test or a node caller: never reach the network there.
  if (typeof window === 'undefined') return null;
  const res = await withTimeout(`${corridorBase()}/corridors/${corridorKey(track)}`, { method: 'GET' });
  if (!res || !res.ok) return null;
  try {
    // deserializeCorridor re-checks the centerline fingerprint, so a corridor
    // stored before the start line moved is rejected rather than misaligned
    return deserializeCorridor(track, await res.json());
  } catch {
    return null;
  }
}

/** Store a freshly extracted corridor. Returns false when the host is read-only. */
export async function putCorridor(track: TrackModel, c: Corridor, token: string): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  const res = await withTimeout(`${corridorBase()}/corridors/${corridorKey(track)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Corridor-Token': token },
    body: JSON.stringify(serializeCorridor(track, c)),
  });
  return Boolean(res?.ok);
}
