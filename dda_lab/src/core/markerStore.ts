// Markers survive a reload: they are kept in localStorage keyed by the session (file) name,
// and travel inside .lab.json bundles and standalone marker JSON files.
import type { DataMarker, Session } from './types';

export const MARKERS_KEY = 'dda-lab-markers';

export interface SavedMarker {
  sessionName: string;
  idx: number;
  name: string;
  color: string;
  note?: string;
}

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const defaultStore = (): Store | undefined => (typeof localStorage !== 'undefined' ? localStorage : undefined);

export function toSaved(markers: DataMarker[], sessions: Session[]): SavedMarker[] {
  const out: SavedMarker[] = [];
  for (const m of markers) {
    const s = sessions.find((x) => x.id === m.sessionId);
    if (!s) continue;
    out.push({ sessionName: s.name, idx: m.idx, name: m.name, color: m.color, note: m.note });
  }
  return out;
}

export function loadSavedMarkers(storage = defaultStore()): SavedMarker[] {
  try {
    const raw = storage?.getItem(MARKERS_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? arr.filter(isSavedMarker) : [];
  } catch {
    return [];
  }
}

export function isSavedMarker(v: unknown): v is SavedMarker {
  const m = v as SavedMarker;
  return !!m && typeof m === 'object' && typeof m.sessionName === 'string' && typeof m.idx === 'number' && typeof m.name === 'string';
}

/**
 * Persist the current markers. Entries of sessions that are not loaded right now are kept
 * (so closing a file does not forget its markers); loaded sessions are replaced.
 */
export function persistMarkers(markers: DataMarker[], sessions: Session[], storage = defaultStore()): SavedMarker[] {
  const loaded = new Set(sessions.map((s) => s.name));
  const kept = loadSavedMarkers(storage).filter((m) => !loaded.has(m.sessionName));
  const next = [...kept, ...toSaved(markers, sessions)];
  try {
    storage?.setItem(MARKERS_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable */
  }
  return next;
}

/** Saved markers for a session name, skipping ones already present at the same sample. */
export function markersToRestore(saved: SavedMarker[], session: Session, existing: DataMarker[]): SavedMarker[] {
  return saved.filter(
    (m) => m.sessionName === session.name && m.idx >= 0 && m.idx < session.t.length && !existing.some((e) => e.sessionId === session.id && e.idx === m.idx),
  );
}

/** Standalone marker file (Markers → Export). */
export function markersToJson(markers: DataMarker[], sessions: Session[]): string {
  return JSON.stringify({ version: 1, kind: 'dda-lab-markers', markers: toSaved(markers, sessions) }, null, 2);
}

export function parseMarkersJson(text: string): SavedMarker[] {
  const j = JSON.parse(text) as { kind?: string; markers?: unknown };
  if (!j || j.kind !== 'dda-lab-markers' || !Array.isArray(j.markers)) throw new Error('Not a DDA Lab markers file');
  return j.markers.filter(isSavedMarker);
}
