import { create } from 'zustand';
import { computeDerived } from '../core/derived';
import { applyProc } from '../core/processing';
import { evaluate, orderByDependencies, parseExpr, type EvalEnv } from '../core/mathExpr';
import { detectLaps } from '../core/laps';
import { applyDeltaT, applySectorTimes, applyTrackLapDist } from './derivedExtras';
import { defaultSectorGates, projectToTrack } from '../core/track';
import { bearingDeg } from '../core/geo';
import {
  DEFAULT_PROC,
  DEFAULT_WORKSPACE,
  type Channel,
  type ChannelProc,
  type Gate,
  type Lap,
  type LngLat,
  type Session,
  type Turn,
  type TrackModel,
  type Workspace,
} from '../core/types';

export interface LapRef {
  sessionId: string;
  lap: number;
}

export interface CursorPos {
  sessionId: string;
  idx: number;
}

export interface LapMeta {
  name: string;
  color: string;
}

export const lapKey = (sessionId: string, lap: number): string => `${sessionId}:${lap}`;

export interface MathDef {
  name: string;
  unit: string;
  expr: string;
  color: string;
}

export const SESSION_COLORS = ['#ff6a00', '#3da5ff', '#3ddc84', '#ffd166', '#c77dff', '#ff4d6d', '#4dd0e1', '#f4a261'];

export interface LabState {
  sessions: Session[];
  tracks: TrackModel[];
  activeTrackId?: string;
  selectedLaps: LapRef[];
  /** User-editable name/colour per workspace lap, keyed by lapKey(). */
  lapMeta: Record<string, LapMeta>;
  refLap?: LapRef;
  cursor: CursorPos | null;
  xRange: [number, number] | null;
  workspace: Workspace;
  mapColorBy: 'speed' | 'tps' | 'lean' | 'brake' | 'solid';
  mapMaximized: boolean;
  bottomTab: 'laps' | 'track' | 'channels' | 'math' | 'reports' | 'external' | 'cursor';
  statusMessage: string | null;

  addSession(s: Session): void;
  removeSession(id: string): void;
  replaceSession(s: Session): void;
  toggleLap(sessionId: string, lap: number): void;
  selectOnlyLap(sessionId: string, lap: number): void;
  setRefLap(sel: LapRef | undefined): void;
  setCursor(c: CursorPos | null): void;
  setXRange(r: [number, number] | null): void;
  setWorkspace(patch: Partial<Workspace>): void;
  setChannelProc(sessionId: string, ch: string, proc: ChannelProc): void;
  applyProcToAll(ch: string, proc: ChannelProc): void;
  addMathChannel(def: MathDef): void;
  removeMathChannel(name: string): void;
  addExternalChannels(sessionId: string, channels: Channel[]): void;
  setTrack(t: TrackModel): void;
  setLapMeta(sessionId: string, lap: number, patch: Partial<LapMeta>): void;
  removeLapFromWorkspace(sessionId: string, lap: number): void;
  /** Delete a lap from its session entirely (table, workspace, reference). */
  deleteLap(sessionId: string, lap: number): void;
  /** Place the start/finish line at a map point; rebuilds sector gates and re-detects every lap. */
  setStartLine(at: LngLat, bearing?: number): void;
  updateTurns(turns: Turn[]): void;
  /** Replace the track's turns (and optionally the start line) with the hints carried by a session. */
  applyTurnHints(sessionId: string): boolean;
  setMapColorBy(c: LabState['mapColorBy']): void;
  setMapMaximized(v: boolean): void;
  setBottomTab(t: LabState['bottomTab']): void;
  setStatus(msg: string | null): void;
}

export function activeTrack(state: Pick<LabState, 'tracks' | 'activeTrackId'>): TrackModel | undefined {
  return state.tracks.find((t) => t.id === state.activeTrackId);
}

/** Recompute math channels for one session from the workspace definitions. */
export function recomputeMath(session: Session, defs: MathDef[]): void {
  for (const [name, ch] of session.channels) if (ch.kind === 'math') session.channels.delete(name);
  if (!defs.length) return;
  const ordered = orderByDependencies(defs);
  const lapStarts = session.laps.map((l) => l.startIdx);
  const dtS = session.t.length > 1 ? session.t[1] - session.t[0] : 0.1;
  for (const def of ordered) {
    const env: EvalEnv = {
      get: (n) => {
        const c = session.channels.get(n);
        if (!c) throw new Error(`unknown channel '${n}'`);
        return c.data;
      },
      dtS,
      lapStarts,
    };
    const byName = defs.find((d) => d.name === def.name)!;
    try {
      const data = evaluate(parseExpr(def.expr), env);
      session.channels.set(def.name, {
        name: def.name,
        unit: byName.unit,
        kind: 'math',
        color: byName.color,
        data,
        proc: { ...DEFAULT_PROC },
        expr: def.expr,
      });
    } catch (e) {
      session.channels.set(def.name, {
        name: def.name,
        unit: byName.unit,
        kind: 'math',
        color: byName.color,
        data: new Float32Array(session.t.length).fill(NaN),
        proc: { ...DEFAULT_PROC },
        expr: `${def.expr}  // error: ${(e as Error).message}`,
      });
    }
  }
}

/** Re-run processing + derived + math for a session (after a proc or track change). */
export function refreshSession(
  session: Session,
  track: TrackModel | undefined,
  defs: MathDef[],
  ref?: { session: Session; lap: Lap },
): Session {
  for (const ch of session.channels.values()) {
    if (ch.kind === 'raw' || ch.kind === 'external') ch.data = applyProc(ch, session);
  }
  if (track && session.laps.length === 0) {
    session.laps = detectLaps(session, track.startFinish, track.sectors);
  }
  computeDerived(session, track);
  if (track) {
    applyTrackLapDist(session, track);
    applySectorTimes(session, track);
  }
  applyDeltaT(session, ref?.session, ref?.lap);
  recomputeMath(session, defs);
  return { ...session, channels: new Map(session.channels) };
}

function refOf(st: Pick<LabState, 'sessions' | 'refLap'>): { session: Session; lap: Lap } | undefined {
  if (!st.refLap) return undefined;
  const session = st.sessions.find((s) => s.id === st.refLap!.sessionId);
  const lap = session?.laps.find((l) => l.n === st.refLap!.lap);
  return session && lap ? { session, lap } : undefined;
}

/** Refresh every session against the current track and reference lap. */
function refreshAll(st: Pick<LabState, 'sessions' | 'refLap' | 'tracks' | 'activeTrackId' | 'workspace'>, track = activeTrack(st)): Session[] {
  const ref = refOf(st);
  return st.sessions.map((s) => refreshSession(s, track, st.workspace.mathChannels, ref));
}

export function defaultLapMeta(st: Pick<LabState, 'sessions'>, sessionId: string, lap: number): LapMeta {
  const s = st.sessions.find((x) => x.id === sessionId);
  return { name: s ? `${s.name} L${lap}` : `L${lap}`, color: s?.color ?? '#ffffff' };
}

export function lapMetaOf(st: Pick<LabState, 'sessions' | 'lapMeta'>, sessionId: string, lap: number): LapMeta {
  return st.lapMeta[lapKey(sessionId, lap)] ?? defaultLapMeta(st, sessionId, lap);
}

export const useLab = create<LabState>((set, get) => ({
  sessions: [],
  tracks: [],
  activeTrackId: undefined,
  selectedLaps: [],
  lapMeta: {},
  refLap: undefined,
  cursor: null,
  xRange: null,
  workspace: DEFAULT_WORKSPACE,
  mapColorBy: 'speed',
  mapMaximized: false,
  bottomTab: 'laps',
  statusMessage: null,

  addSession(s) {
    const { workspace, sessions } = get();
    recomputeMath(s, workspace.mathChannels);
    const best = s.laps.find((l) => l.isBest) ?? s.laps.find((l) => l.kind === 'flying') ?? s.laps[0];
    const refLap = get().refLap ?? (best ? { sessionId: s.id, lap: best.n } : undefined);
    const next = { ...get(), sessions: [...sessions, s], refLap };
    set({
      sessions: refreshAll(next),
      selectedLaps: best ? [...get().selectedLaps, { sessionId: s.id, lap: best.n }] : get().selectedLaps,
      refLap,
    });
  },
  removeSession(id) {
    set((st) => ({
      sessions: st.sessions.filter((s) => s.id !== id),
      selectedLaps: st.selectedLaps.filter((l) => l.sessionId !== id),
      refLap: st.refLap?.sessionId === id ? undefined : st.refLap,
      cursor: st.cursor?.sessionId === id ? null : st.cursor,
    }));
  },
  replaceSession(s) {
    set((st) => ({ sessions: st.sessions.map((x) => (x.id === s.id ? s : x)) }));
  },
  toggleLap(sessionId, lap) {
    set((st) => {
      const exists = st.selectedLaps.some((l) => l.sessionId === sessionId && l.lap === lap);
      return {
        selectedLaps: exists
          ? st.selectedLaps.filter((l) => !(l.sessionId === sessionId && l.lap === lap))
          : [...st.selectedLaps, { sessionId, lap }],
      };
    });
  },
  selectOnlyLap(sessionId, lap) {
    set({ selectedLaps: [{ sessionId, lap }] });
  },
  setRefLap(sel) {
    set({ refLap: sel });
    set({ sessions: refreshAll(get()) });
  },
  setCursor(c) {
    set({ cursor: c });
  },
  setXRange(r) {
    set({ xRange: r });
  },
  setWorkspace(patch) {
    set((st) => ({ workspace: { ...st.workspace, ...patch } }));
  },
  setChannelProc(sessionId, chName, proc) {
    const st = get();
    const track = activeTrack(st);
    set({
      sessions: st.sessions.map((s) => {
        if (s.id !== sessionId) return s;
        const ch = s.channels.get(chName);
        if (ch) ch.proc = proc;
        return refreshSession(s, track, st.workspace.mathChannels, refOf(st));
      }),
    });
  },
  applyProcToAll(chName, proc) {
    const st = get();
    const track = activeTrack(st);
    set({
      sessions: st.sessions.map((s) => {
        const ch = s.channels.get(chName);
        if (ch) ch.proc = { ...proc };
        return refreshSession(s, track, st.workspace.mathChannels, refOf(st));
      }),
    });
  },
  addMathChannel(def) {
    const st = get();
    const defs = [...st.workspace.mathChannels.filter((d) => d.name !== def.name), def];
    for (const s of st.sessions) recomputeMath(s, defs);
    set({
      workspace: { ...st.workspace, mathChannels: defs },
      sessions: st.sessions.map((s) => ({ ...s, channels: new Map(s.channels) })),
    });
  },
  removeMathChannel(name) {
    const st = get();
    const defs = st.workspace.mathChannels.filter((d) => d.name !== name);
    for (const s of st.sessions) recomputeMath(s, defs);
    set({
      workspace: { ...st.workspace, mathChannels: defs },
      sessions: st.sessions.map((s) => ({ ...s, channels: new Map(s.channels) })),
    });
  },
  addExternalChannels(sessionId, channels) {
    const st = get();
    const track = activeTrack(st);
    set({
      sessions: st.sessions.map((s) => {
        if (s.id !== sessionId) return s;
        for (const c of channels) s.channels.set(c.name, c);
        return refreshSession(s, track, st.workspace.mathChannels, refOf(st));
      }),
    });
  },
  setTrack(t) {
    const st = get();
    const tracks = [...st.tracks.filter((x) => x.id !== t.id), t];
    set({
      tracks,
      activeTrackId: t.id,
      sessions: refreshAll(st, t),
    });
  },
  setLapMeta(sessionId, lap, patch) {
    set((st) => {
      const k = lapKey(sessionId, lap);
      const cur = st.lapMeta[k] ?? defaultLapMeta(st, sessionId, lap);
      return { lapMeta: { ...st.lapMeta, [k]: { ...cur, ...patch } } };
    });
  },
  deleteLap(sessionId, lap) {
    const st = get();
    const session = st.sessions.find((s) => s.id === sessionId);
    if (!session) return;
    session.laps = session.laps.filter((l) => l.n !== lap);
    if (!session.laps.some((l) => l.isBest)) {
      const flying = session.laps.filter((l) => l.kind === 'flying');
      const best = flying.sort((a, b) => a.timeS - b.timeS)[0];
      if (best) best.isBest = true;
    }
    const meta = { ...st.lapMeta };
    delete meta[lapKey(sessionId, lap)];
    const refLap = st.refLap?.sessionId === sessionId && st.refLap.lap === lap ? undefined : st.refLap;
    const track = activeTrack(st);
    set({
      lapMeta: meta,
      refLap,
      selectedLaps: st.selectedLaps.filter((l) => !(l.sessionId === sessionId && l.lap === lap)),
      cursor: st.cursor?.sessionId === sessionId ? null : st.cursor,
      sessions: st.sessions.map((s) => (s.id === sessionId ? refreshSession(s, track, st.workspace.mathChannels, refOf({ ...st, refLap })) : s)),
    });
  },
  removeLapFromWorkspace(sessionId, lap) {
    set((st) => {
      const meta = { ...st.lapMeta };
      delete meta[lapKey(sessionId, lap)];
      return {
        selectedLaps: st.selectedLaps.filter((l) => !(l.sessionId === sessionId && l.lap === lap)),
        lapMeta: meta,
      };
    });
  },
  setStartLine(at, bearing) {
    const st = get();
    const track = activeTrack(st);
    if (!track) return;
    // Snap to the nearest centerline vertex so a click beside the tarmac still
    // yields a gate the laps actually cross; heading = centerline direction there.
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < track.centerline.length; i++) {
      const dx = (track.centerline[i][0] - at[0]) * Math.cos((at[1] * Math.PI) / 180);
      const dy = track.centerline[i][1] - at[1];
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    const snapped: LngLat = track.centerline[best];
    const nx = (best + 1) % track.centerline.length;
    const b = bearing ?? bearingDeg(track.centerline[best], track.centerline[nx]);
    const sf: Gate = { ...track.startFinish, at: snapped, bearingDeg: b };
    const sectors = defaultSectorGates(track.centerline, track.cumDistM, sf, Math.max(2, track.sectors.length + 1));
    const next: TrackModel = { ...track, startFinish: sf, sectors };
    for (const s of st.sessions) if (!s.lapsFromFile) s.laps = [];
    const tracks = [...st.tracks.filter((x) => x.id !== next.id), next];
    const sessions = refreshAll({ ...st, tracks, activeTrackId: next.id }, next);
    // keep workspace laps whose number still exists
    const selectedLaps = st.selectedLaps.filter((r) => sessions.find((s) => s.id === r.sessionId)?.laps.some((l) => l.n === r.lap));
    set({ tracks, activeTrackId: next.id, sessions, selectedLaps, cursor: null });
  },
  updateTurns(turns) {
    const st = get();
    const track = activeTrack(st);
    if (!track) return;
    const next: TrackModel = { ...track, turns: turns.map((t, i) => ({ ...t, n: i + 1 })) };
    set({ tracks: [...st.tracks.filter((x) => x.id !== next.id), next], sessions: refreshAll({ ...st, tracks: [next], activeTrackId: next.id }, next) });
  },
  applyTurnHints(sessionId) {
    const st = get();
    const track = activeTrack(st);
    const session = st.sessions.find((s) => s.id === sessionId);
    if (!track || !session?.turnHints?.length) return false;
    // move the start/finish first if the hint is clearly elsewhere (> 30 m)
    if (session.sfHint) {
      const cur = projectToTrack(track, track.startFinish.at).sM;
      const hinted = projectToTrack(track, session.sfHint);
      const L = track.lengthM;
      const d = Math.abs(((hinted.sM - cur + L / 2) % L + L) % L - L / 2);
      if (hinted.offM < 40 && d > 30) get().setStartLine(session.sfHint);
    }
    const tr = activeTrack(get())!;
    const L = tr.lengthM;
    const turns: Turn[] = [];
    for (const h of session.turnHints) {
      const a = projectToTrack(tr, h.startGeo);
      const b = projectToTrack(tr, h.endGeo);
      const ap = projectToTrack(tr, h.apexGeo);
      if (a.offM > 60 || b.offM > 60 || ap.offM > 60) continue; // hint does not belong to this track
      let s0 = a.sM;
      let s1 = b.sM;
      if (s1 < s0) s1 += L; // wraps past the start line
      const [s0c, s1c] = s1 > L ? [s0, L] : [s0, s1];
      turns.push({
        n: turns.length + 1,
        name: h.name,
        dir: h.dir,
        apexGeo: h.apexGeo,
        radiusM: Math.max(10, (s1c - s0c) / Math.PI),
        sRange: [s0c, s1c],
      });
    }
    if (!turns.length) return false;
    turns.sort((x, y) => x.sRange[0] - y.sRange[0]);
    get().updateTurns(turns);
    return true;
  },
  setMapColorBy(c) {
    set({ mapColorBy: c });
  },
  setMapMaximized(v) {
    set({ mapMaximized: v });
  },
  setBottomTab(t) {
    set({ bottomTab: t });
  },
  setStatus(msg) {
    set({ statusMessage: msg });
  },
}));
