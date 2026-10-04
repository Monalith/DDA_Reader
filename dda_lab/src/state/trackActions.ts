// Track-model wiring: build a TrackModel from a session's GPS trace, persist it in
// localStorage (+ optional JSON download), and auto-attach a track when a session loads.
import { plausibleFlyingLaps } from '../core/laps';
import { bearingDeg } from '../core/geo';
import {
  buildCenterline,
  curvature,
  defaultSectorGates,
  detectTurns,
  recognizeTrack,
} from '../core/track';
import type { Gate, LngLat, Session, TrackModel } from '../core/types';
import { activeTrack, useLab } from './store';

export const TRACKS_STORAGE_KEY = 'lab.tracks';

/** Number of best flying laps averaged into the centerline. */
const CENTERLINE_LAPS = 5;

export interface SerializedTrack extends Omit<TrackModel, 'cumDistM'> {
  cumDistM: number[];
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function storage(): Storage | null {
  try {
    const ls = globalThis.localStorage as Storage | undefined;
    return ls ?? null;
  } catch {
    return null;
  }
}

function download(name: string, text: string, mime = 'application/json'): void {
  if (typeof document === 'undefined') return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function serializeTrack(t: TrackModel): SerializedTrack {
  return { ...t, cumDistM: Array.from(t.cumDistM) };
}

export function deserializeTrack(o: SerializedTrack): TrackModel {
  return { ...o, cumDistM: Float64Array.from(o.cumDistM ?? []) };
}

/** Mean position of a centerline / point list. */
function meanLngLat(pts: LngLat[]): LngLat {
  let lng = 0;
  let lat = 0;
  for (const p of pts) {
    lng += p[0];
    lat += p[1];
  }
  const n = Math.max(1, pts.length);
  return [lng / n, lat / n];
}

/** Mean of a session's finite GPS fixes, or null when it has no usable GPS. */
export function sessionGpsCenter(s: Session): LngLat | null {
  const lng = s.channels.get('gps_lon')?.data;
  const lat = s.channels.get('gps_lat')?.data;
  if (!lng || !lat) return null;
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let i = 0; i < lng.length; i++) {
    if (!Number.isFinite(lng[i]) || !Number.isFinite(lat[i])) continue;
    if (lng[i] === 0 && lat[i] === 0) continue;
    sx += lng[i];
    sy += lat[i];
    n++;
  }
  if (!n) return null;
  return [sx / n, sy / n];
}

function gpsPointAt(s: Session, idx: number): LngLat | null {
  const lng = s.channels.get('gps_lon')?.data;
  const lat = s.channels.get('gps_lat')?.data;
  if (!lng || !lat) return null;
  for (let i = idx; i < Math.min(lng.length, idx + 50); i++) {
    if (Number.isFinite(lng[i]) && Number.isFinite(lat[i]) && !(lng[i] === 0 && lat[i] === 0)) {
      return [lng[i], lat[i]];
    }
  }
  return null;
}

/**
 * Build a track model from a session: the best (fastest) flying laps give the centerline,
 * lap 1's start sample gives the start/finish gate, then curvature → turns → 3 sectors.
 * Returns null when the session has no laps or no GPS.
 */
export function buildTrackFromSession(s: Session): TrackModel | null {
  if (!s.laps.length) return null;
  const lngCh = s.channels.get('gps_lon')?.data;
  const latCh = s.channels.get('gps_lat')?.data;
  if (!lngCh || !latCh) return null;

  const flying = plausibleFlyingLaps(s.laps);
  const pool = (flying.length ? flying : s.laps)
    .slice()
    .sort((a, b) => a.timeS - b.timeS)
    .slice(0, CENTERLINE_LAPS);
  if (!pool.length) return null;

  const lapTraces = pool
    .map((l) => ({
      lng: lngCh.slice(l.startIdx, l.endIdx + 1),
      lat: latCh.slice(l.startIdx, l.endIdx + 1),
    }))
    .filter((x) => x.lng.length > 3);
  if (!lapTraces.length) return null;

  const { centerline, cumDistM, lengthM } = buildCenterline(lapTraces, 2);
  if (centerline.length < 4) return null;

  const sfLap = s.laps.find((l) => l.n === 1) ?? s.laps[0];
  const at = gpsPointAt(s, sfLap.startIdx) ?? centerline[0];
  const next = gpsPointAt(s, sfLap.startIdx + 1) ?? centerline[1] ?? at;
  const startFinish: Gate = {
    id: 'sf',
    name: 'S/F',
    type: 'sf',
    at,
    bearingDeg: bearingDeg(at, next),
    halfWidthM: 15,
  };

  const curv = curvature(centerline);
  const turns = detectTurns(centerline, curv, cumDistM);
  const sectors = defaultSectorGates(centerline, cumDistM, startFinish, 3);
  const center = meanLngLat(centerline);
  const name = s.meta.track || 'Track';
  const id = slug(s.meta.track) || `track-${center[0].toFixed(3)}-${center[1].toFixed(3)}`;

  return { id, name, center, centerline, cumDistM, lengthM, startFinish, sectors, turns };
}

/** Read every track saved in localStorage. */
export function loadTracks(): TrackModel[] {
  const ls = storage();
  if (!ls) return [];
  try {
    const raw = ls.getItem(TRACKS_STORAGE_KEY);
    if (!raw) return [];
    const map = JSON.parse(raw) as Record<string, SerializedTrack>;
    return Object.values(map)
      .filter((t) => t && typeof t === 'object')
      .map(deserializeTrack);
  } catch {
    return [];
  }
}

/** Persist one track in localStorage (keyed by id), without downloading anything. */
export function saveTrackLocal(t: TrackModel): void {
  const ls = storage();
  if (!ls) return;
  let map: Record<string, SerializedTrack> = {};
  try {
    const raw = ls.getItem(TRACKS_STORAGE_KEY);
    if (raw) map = JSON.parse(raw) as Record<string, SerializedTrack>;
  } catch {
    map = {};
  }
  map[t.id] = serializeTrack(t);
  try {
    ls.setItem(TRACKS_STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* quota / disabled storage: ignore */
  }
}

/** Download a track as `<id>.json`. */
export function exportTrackJson(t: TrackModel): void {
  download(`${t.id}.json`, JSON.stringify(serializeTrack(t), null, 2));
}

/** Persist to localStorage **and** hand the user a `<id>.json` file. */
export function saveTrack(t: TrackModel): void {
  saveTrackLocal(t);
  exportTrackJson(t);
}

function uniqueById(tracks: TrackModel[]): TrackModel[] {
  const map = new Map<string, TrackModel>();
  for (const t of tracks) map.set(t.id, t);
  return [...map.values()];
}

/**
 * Called after a session is added: pick a known track whose centre matches the session's
 * GPS, otherwise derive a new one from the session itself and remember it.
 */
export function ensureTrackForSession(s: Session): void {
  const st = useLab.getState();
  if (activeTrack(st)) return;
  const center = sessionGpsCenter(s);
  if (!center) return;

  const known = uniqueById([...loadTracks(), ...st.tracks]);
  const recognized = known.length ? recognizeTrack(known, center) : undefined;
  // A stored model shorter than 500 m or without corners is degenerate: rebuild it.
  if (recognized && recognized.lengthM >= 500 && recognized.turns.length >= 2) {
    st.setTrack(recognized);
    return;
  }
  const built = buildTrackFromSession(s);
  if (!built) return;
  st.setTrack(built);
  saveTrackLocal(built);
}
