// "Save session": the whole lab state in one `.lab.json` file that reopens exactly as it was —
// every loaded run (all its laps and raw channels), the track models and the `.pist.json`
// package in use, the workspace laps / names / colours, markers, chart layout and zoom, the
// virtual rider's parameters and the fitted rider. Derived and math channels are recomputed
// on load, the sim lap is re-ridden.
//
// Typed arrays are tagged (`{__ta:'f32'|'f64', d:[…]}`) so any Float32Array/Float64Array in
// the state round-trips without a per-field schema.
import { z } from 'zod';
import type { Channel, DataMarker, Session, TrackModel, Workspace } from './types';
import { DEFAULT_PROC } from './types';
import { parseWorkspace, serializeWorkspace } from './workspace';
import { bundleDecimals } from './bundle';
import type { LapMeta, LapRef, CursorPos } from '../state/store';
import type { Corridor, RiderParams, SimParams, SolverMode } from '../sim/types';
import type { PistPackage } from './pistPackage';

export const LAB_SESSION_VERSION = 2;
export const LAB_SESSION_KIND = 'dda-lab-session';

/** What a lab session file carries (the state slice worth keeping). */
export interface LabSessionState {
  sessions: Session[];
  tracks: TrackModel[];
  activeTrackId?: string;
  trackPackage?: PistPackage;
  corridor?: Corridor;
  selectedLaps: LapRef[];
  lapMeta: Record<string, LapMeta>;
  refLap?: LapRef;
  xRange: [number, number] | null;
  workspace: Workspace;
  mapColorBy: string;
  markers: DataMarker[];
  activeMarkerId: string | null;
  clickPos: CursorPos | null;
  simParams: SimParams;
  simEnabled: boolean;
  solverMode: SolverMode;
  riderFit: { refLap: { sessionId: string; lapN: number } | null; fittedRider: RiderParams | null };
  /** Onboard video sync. The video file itself is not stored: only its name and offset. */
  video?: LabSessionVideo;
}

/** Video ⇔ session sync carried by a lab session: video_time = session.t[idx] − offsetS. */
export interface LabSessionVideo {
  fileName: string;
  offsetS: number;
  sessionId: string;
}

// ---- typed-array tagging ----------------------------------------------------

type Tagged = { __ta: 'f32' | 'f64'; d: (number | null)[] };

const num = (v: number, decimals: number | null): number | null =>
  !Number.isFinite(v) ? null : decimals === null ? v : Number(v.toFixed(decimals));

/** Deep copy with typed arrays tagged; `decimals` rounds their values (null = exact). */
export function toPlain(v: unknown, decimals: number | null = null): unknown {
  if (v instanceof Float32Array) return { __ta: 'f32', d: Array.from(v, (x) => num(x, decimals)) } satisfies Tagged;
  if (v instanceof Float64Array) return { __ta: 'f64', d: Array.from(v, (x) => num(x, decimals)) } satisfies Tagged;
  if (Array.isArray(v)) return v.map((x) => toPlain(x, decimals));
  if (v instanceof Map) return { __map: Array.from(v.entries(), ([k, x]) => [k, toPlain(x, decimals)]) };
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (x !== undefined) out[k] = toPlain(x, decimals);
    return out;
  }
  return typeof v === 'number' && !Number.isFinite(v) ? null : v;
}

/** Inverse of `toPlain`. */
export function fromPlain(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(fromPlain);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ((o.__ta === 'f32' || o.__ta === 'f64') && Array.isArray(o.d)) {
      const d = (o.d as (number | null)[]).map((x) => (x === null ? NaN : x));
      return o.__ta === 'f32' ? Float32Array.from(d) : Float64Array.from(d);
    }
    if (Array.isArray(o.__map)) return new Map((o.__map as [string, unknown][]).map(([k, x]) => [k, fromPlain(x)]));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) out[k] = fromPlain(x);
    return out;
  }
  return v;
}

// ---- sessions --------------------------------------------------------------

interface PlainChannel {
  name: string;
  unit: string;
  kind: Channel['kind'];
  color?: string;
  data: Tagged;
  raw?: { t: Tagged; v: Tagged };
  proc: Channel['proc'];
  note?: string;
}

interface PlainSession {
  id: string;
  name: string;
  source: Session['source'];
  color: string;
  t: Tagged;
  channels: PlainChannel[];
  laps: Session['laps'];
  meta: Session['meta'];
  turnHints?: unknown;
  sfHint?: unknown;
  lapsFromFile?: boolean;
  reference?: unknown;
  deletedRanges?: Array<[number, number]>;
}

function sessionToPlain(s: Session): PlainSession {
  const channels: PlainChannel[] = [];
  for (const ch of s.channels.values()) {
    if (ch.kind === 'math' || ch.kind === 'derived') continue; // recomputed on load
    const dec = bundleDecimals(ch.name);
    channels.push({
      name: ch.name,
      unit: ch.unit,
      kind: ch.kind,
      color: ch.color,
      data: toPlain(ch.data, dec) as Tagged,
      raw: ch.raw ? { t: toPlain(ch.raw.t, 3) as Tagged, v: toPlain(ch.raw.v, dec) as Tagged } : undefined,
      proc: ch.proc,
      note: ch.note,
    });
  }
  return {
    id: s.id,
    name: s.name,
    source: s.source,
    color: s.color,
    t: toPlain(s.t, 3) as Tagged,
    channels,
    laps: s.laps,
    meta: s.meta,
    turnHints: s.turnHints,
    sfHint: s.sfHint,
    lapsFromFile: s.lapsFromFile,
    reference: s.reference ? toPlain(s.reference, 4) : undefined,
    deletedRanges: s.deletedRanges,
  };
}

function sessionFromPlain(p: PlainSession): Session {
  const channels = new Map<string, Channel>();
  for (const c of p.channels) {
    channels.set(c.name, {
      name: c.name,
      unit: c.unit,
      kind: c.kind,
      color: c.color,
      data: fromPlain(c.data) as Float32Array,
      raw: c.raw ? { t: fromPlain(c.raw.t) as Float64Array, v: fromPlain(c.raw.v) as Float32Array } : undefined,
      proc: c.proc ?? { ...DEFAULT_PROC },
      note: c.note,
    });
  }
  return {
    id: p.id,
    name: p.name,
    source: p.source,
    color: p.color,
    t: fromPlain(p.t) as Float64Array,
    channels,
    laps: p.laps,
    meta: p.meta,
    turnHints: p.turnHints as Session['turnHints'],
    sfHint: p.sfHint as Session['sfHint'],
    // the laps come from this file: never cleared when the start line moves
    lapsFromFile: true,
    reference: p.reference ? (fromPlain(p.reference) as Session['reference']) : undefined,
    deletedRanges: p.deletedRanges,
  };
}

// ---- the file --------------------------------------------------------------

export interface LabSessionFile {
  version: typeof LAB_SESSION_VERSION;
  kind: typeof LAB_SESSION_KIND;
  createdAt: string;
  sessions: PlainSession[];
  tracks: unknown[];
  activeTrackId?: string;
  trackPackage?: unknown;
  corridor?: unknown;
  selectedLaps: LapRef[];
  lapMeta: Record<string, LapMeta>;
  refLap?: LapRef;
  xRange: [number, number] | null;
  workspace: unknown;
  mapColorBy: string;
  markers: DataMarker[];
  activeMarkerId: string | null;
  clickPos: CursorPos | null;
  simParams: unknown;
  simEnabled: boolean;
  solverMode: SolverMode;
  riderFit: { refLap: { sessionId: string; lapN: number } | null; fittedRider: unknown };
  video?: LabSessionVideo;
}

export function serializeLabSession(st: LabSessionState): string {
  // the virtual rider's own lap is re-ridden on load, not stored
  const sessions = st.sessions.filter((s) => !s.isSim);
  const ids = new Set(sessions.map((s) => s.id));
  const file: LabSessionFile = {
    version: LAB_SESSION_VERSION,
    kind: LAB_SESSION_KIND,
    createdAt: new Date().toISOString(),
    sessions: sessions.map(sessionToPlain),
    tracks: st.tracks.map((t) => toPlain(t, 3)),
    activeTrackId: st.activeTrackId,
    trackPackage: st.trackPackage ? toPlain(st.trackPackage) : undefined,
    corridor: st.corridor ? toPlain(st.corridor, 2) : undefined,
    selectedLaps: st.selectedLaps.filter((l) => ids.has(l.sessionId)),
    lapMeta: st.lapMeta,
    refLap: st.refLap && ids.has(st.refLap.sessionId) ? st.refLap : undefined,
    xRange: st.xRange,
    workspace: JSON.parse(serializeWorkspace(st.workspace)),
    mapColorBy: st.mapColorBy,
    markers: st.markers.filter((m) => ids.has(m.sessionId)),
    activeMarkerId: st.activeMarkerId,
    clickPos: st.clickPos && ids.has(st.clickPos.sessionId) ? st.clickPos : null,
    simParams: toPlain(st.simParams),
    simEnabled: st.simEnabled,
    solverMode: st.solverMode,
    riderFit: { refLap: st.riderFit.refLap, fittedRider: st.riderFit.fittedRider ? toPlain(st.riderFit.fittedRider) : null },
    video: st.video && ids.has(st.video.sessionId) && Number.isFinite(st.video.offsetS) ? { fileName: st.video.fileName, offsetS: st.video.offsetS, sessionId: st.video.sessionId } : undefined,
  };
  return JSON.stringify(file);
}

/** Content check: a lab session file (the name may have been changed). */
export function looksLikeLabSession(j: unknown): boolean {
  return !!j && typeof j === 'object' && (j as LabSessionFile).kind === LAB_SESSION_KIND && (j as LabSessionFile).version === LAB_SESSION_VERSION;
}

export async function isLabSessionFile(f: File): Promise<boolean> {
  if (!f.name.toLowerCase().endsWith('.json')) return false;
  try {
    const head = await f.slice(0, 256).text();
    return head.includes(`"kind":"${LAB_SESSION_KIND}"`) || head.includes(`"kind": "${LAB_SESSION_KIND}"`);
  } catch {
    return false;
  }
}

const LapRefZ = z.object({ sessionId: z.string(), lap: z.number() });
const FileZ = z.object({
  version: z.literal(LAB_SESSION_VERSION),
  kind: z.literal(LAB_SESSION_KIND),
  createdAt: z.string(),
  sessions: z.array(z.unknown()),
  tracks: z.array(z.unknown()),
  activeTrackId: z.string().optional(),
  trackPackage: z.unknown().optional(),
  corridor: z.unknown().optional(),
  selectedLaps: z.array(LapRefZ),
  lapMeta: z.record(z.string(), z.object({ name: z.string(), color: z.string() })),
  refLap: LapRefZ.optional(),
  xRange: z.tuple([z.number(), z.number()]).nullable(),
  workspace: z.unknown(),
  mapColorBy: z.string(),
  markers: z.array(z.object({ id: z.string(), name: z.string(), color: z.string(), sessionId: z.string(), idx: z.number(), note: z.string().optional() })),
  activeMarkerId: z.string().nullable(),
  clickPos: z.object({ sessionId: z.string(), idx: z.number() }).nullable(),
  simParams: z.unknown(),
  simEnabled: z.boolean(),
  solverMode: z.enum(['rider', 'freeTrajectory', 'ocp']),
  riderFit: z.object({ refLap: z.object({ sessionId: z.string(), lapN: z.number() }).nullable(), fittedRider: z.unknown().nullable() }),
  video: z.object({ fileName: z.string(), offsetS: z.number(), sessionId: z.string() }).optional(),
});

/** Parse a lab session file back into the state slice (derived/math channels NOT yet computed). */
export function parseLabSession(json: string): LabSessionState {
  const f = FileZ.parse(JSON.parse(json));
  const sessions = f.sessions.map((p) => sessionFromPlain(p as PlainSession));
  const tracks = f.tracks.map((t) => fromPlain(t) as TrackModel);
  return {
    sessions,
    tracks,
    activeTrackId: f.activeTrackId,
    trackPackage: f.trackPackage ? (fromPlain(f.trackPackage) as PistPackage) : undefined,
    corridor: f.corridor ? (fromPlain(f.corridor) as Corridor) : undefined,
    selectedLaps: f.selectedLaps,
    lapMeta: f.lapMeta,
    refLap: f.refLap,
    xRange: f.xRange,
    workspace: parseWorkspace(JSON.stringify(f.workspace ?? {})),
    mapColorBy: f.mapColorBy,
    markers: f.markers,
    activeMarkerId: f.activeMarkerId,
    clickPos: f.clickPos,
    simParams: fromPlain(f.simParams) as SimParams,
    simEnabled: f.simEnabled,
    solverMode: f.solverMode,
    riderFit: { refLap: f.riderFit.refLap, fittedRider: f.riderFit.fittedRider ? (fromPlain(f.riderFit.fittedRider) as RiderParams) : null },
    video: f.video,
  };
}
