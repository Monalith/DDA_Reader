import { create } from 'zustand';
import { computeDerived } from '../core/derived';
import { applyProc } from '../core/processing';
import { evaluate, orderByDependencies, parseExpr, type EvalEnv } from '../core/mathExpr';
import { detectLaps, withoutDeletedLaps } from '../core/laps';
import { alignedChannel, applyDeltaT, applyRefDeltas, applySectorTimes, applyTotalDist, applyTrackLapDist } from './derivedExtras';
import { defaultSectorGates, normalizeTrackOrigin, projectToTrack } from '../core/track';
import { bearingDeg } from '../core/geo';
import { loadSavedMarkers, markersToRestore, persistMarkers } from '../core/markerStore';
import { parseWorkspace, serializeWorkspace } from '../core/workspace';

/** Workspace (panels, math, label colours…) is remembered in this browser between visits. */
export const WORKSPACE_KEY = 'dda-lab-workspace';
function loadWorkspaceLocal(): Workspace {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(WORKSPACE_KEY) : null;
    const ws = raw ? parseWorkspace(raw) : DEFAULT_WORKSPACE;
    // one-time migration: point overlays now start hidden (older saved workspaces had them all on)
    if (raw && typeof localStorage !== 'undefined' && !localStorage.getItem('dda-lab-layers-v2')) {
      localStorage.setItem('dda-lab-layers-v2', '1');
      return { ...ws, mapLayers: { ...DEFAULT_WORKSPACE.mapLayers } };
    }
    return ws;
  } catch {
    return DEFAULT_WORKSPACE;
  }
}
import {
  DEFAULT_PROC,
  DEFAULT_WORKSPACE,
  type Channel,
  type ChannelProc,
  type DataMarker,
  type Gate,
  type Lap,
  type MathChannelDef,
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

export type MathDef = MathChannelDef;

export const SESSION_COLORS = ['#ff6a00', '#3da5ff', '#3ddc84', '#ffd166', '#c77dff', '#ff4d6d', '#4dd0e1', '#f4a261'];
export const MARKER_COLORS = ['#ffd166', '#4dd0e1', '#ff4d6d', '#c77dff', '#3ddc84', '#f4a261', '#3da5ff', '#ffffff'];

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
  bottomTab: 'laps' | 'track' | 'channels' | 'math' | 'reports' | 'external' | 'cursor' | 'markers';
  statusMessage: string | null;
  /** User-placed data markers (fixed samples). */
  markers: DataMarker[];
  /** Marker whose values the Markers panel shows. */
  activeMarkerId: string | null;
  /** Last sample the user clicked (chart or map); the 📍 Mark button places markers here. */
  clickPos: CursorPos | null;

  addSession(s: Session): void;
  removeSession(id: string): void;
  /** Change a run's colour (map trace, chart lines and lap table); laps with their own colour keep it. */
  setSessionColor(id: string, color: string): void;
  replaceSession(s: Session): void;
  toggleLap(sessionId: string, lap: number): void;
  selectOnlyLap(sessionId: string, lap: number): void;
  setRefLap(sel: LapRef | undefined): void;
  setCursor(c: CursorPos | null): void;
  setXRange(r: [number, number] | null): void;
  setWorkspace(patch: Partial<Workspace>): void;
  setChannelProc(sessionId: string, ch: string, proc: ChannelProc): void;
  applyProcToAll(ch: string, proc: ChannelProc): void;
  /** Add or update a math channel. Existing per-lap formulas are kept unless `def.perLap` is given. */
  addMathChannel(def: MathDef): void;
  removeMathChannel(name: string): void;
  /** Set (or clear with null) the formula of one math channel for one lap only. */
  setMathLapExpr(name: string, sessionId: string, lap: number, expr: string | null): void;
  /** Set (or clear with null) the formula of one math channel for one run (session) only. */
  setMathSessionExpr(name: string, sessionId: string, expr: string | null): void;
  /**
   * Place a marker. `prefer: 'click'` (the 📍 button) uses the last clicked sample and falls
   * back to the hover cursor; `'hover'` (the M key) the other way round. Null when neither exists.
   */
  addMarkerAtCursor(prefer?: 'click' | 'hover'): DataMarker | null;
  addMarker(sessionId: string, idx: number, patch?: Partial<Pick<DataMarker, 'name' | 'color' | 'note'>>): DataMarker;
  updateMarker(id: string, patch: Partial<Pick<DataMarker, 'name' | 'color' | 'idx' | 'note'>>): void;
  setClickPos(c: CursorPos | null): void;
  removeMarker(id: string): void;
  clearMarkers(): void;
  setActiveMarker(id: string | null): void;
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

/**
 * Recompute math channels for one session from the workspace definitions. A per-lap
 * formula (`def.perLap[sessionId:lapN]`) replaces the channel's values inside that lap.
 */
/** Context for ref()/run() in formulas: every loaded run and the reference lap. */
export interface MathContext {
  sessions: Session[];
  ref?: { session: Session; lap: Lap };
}

export function recomputeMath(session: Session, defs: MathDef[], ctx?: MathContext): void {
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
      n: session.t.length,
      aligned: (name, target, by) => {
        if (!ctx) throw new Error('ref()/run() need loaded runs');
        let t: { session: Session; lap: Lap } | undefined;
        if (target.kind === 'ref') {
          t = ctx.ref;
          if (!t) throw new Error('ref(): pick a reference lap (◉) first');
        } else {
          const rs = ctx.sessions[target.n - 1];
          if (!rs) throw new Error(`run(): there are ${ctx.sessions.length} loaded run(s), no run ${target.n}`);
          const lap = rs.laps.find((l) => l.isBest) ?? rs.laps.find((l) => l.kind === 'flying') ?? rs.laps[0];
          if (!lap) throw new Error(`run(): run ${target.n} has no laps`);
          t = { session: rs, lap };
        }
        if (!t.session.channels.has(name)) throw new Error(`'${name}' does not exist in ${t.session.name}`);
        return alignedChannel(session, t.session, t.lap, name, by);
      },
    };
    const byName = defs.find((d) => d.name === def.name)!;
    try {
      const baseExpr = def.perSession?.[session.id] ?? def.expr;
      const data = evaluate(parseExpr(baseExpr), env);
      const overrides = Object.entries(def.perLap ?? {}).filter(([k]) => k.startsWith(`${session.id}:`));
      const lapErrors: string[] = [];
      for (const [k, lapExpr] of overrides) {
        const lapN = Number(k.slice(session.id.length + 1));
        const lap = session.laps.find((l) => l.n === lapN);
        if (!lap) continue;
        try {
          const d = evaluate(parseExpr(lapExpr), env);
          for (let i = lap.startIdx; i <= lap.endIdx && i < data.length; i++) data[i] = d[i];
        } catch (e) {
          lapErrors.push(`L${lapN}: ${(e as Error).message}`);
          for (let i = lap.startIdx; i <= lap.endIdx && i < data.length; i++) data[i] = NaN;
        }
      }
      session.channels.set(def.name, {
        name: def.name,
        unit: byName.unit,
        kind: 'math',
        color: byName.color,
        data,
        proc: { ...DEFAULT_PROC },
        expr: lapErrors.length ? `${def.expr}  // error: ${lapErrors.join('; ')}` : def.expr,
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
  allSessions?: Session[],
): Session {
  for (const ch of session.channels.values()) {
    if (ch.kind === 'raw' || ch.kind === 'external') ch.data = applyProc(ch, session);
  }
  if (track && session.laps.length === 0) {
    session.laps = withoutDeletedLaps(detectLaps(session, track.startFinish, track.sectors), session.deletedRanges);
  }
  computeDerived(session, track);
  if (track) {
    applyTrackLapDist(session, track);
    applySectorTimes(session, track);
  }
  applyTotalDist(session);
  applyDeltaT(session, ref?.session, ref?.lap);
  applyRefDeltas(session, ref?.session, ref?.lap);
  recomputeMath(session, defs, { sessions: allSessions ?? [session], ref });
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
  return st.sessions.map((s) => refreshSession(s, track, st.workspace.mathChannels, ref, st.sessions));
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
  workspace: loadWorkspaceLocal(),
  mapColorBy: 'brake',
  mapMaximized: false,
  bottomTab: 'laps',
  statusMessage: null,
  markers: [],
  activeMarkerId: null,
  clickPos: null,

  addSession(s) {
    const { workspace, sessions } = get();
    recomputeMath(s, workspace.mathChannels, { sessions: [...sessions, s], ref: refOf(get()) });
    const best = s.laps.find((l) => l.isBest) ?? s.laps.find((l) => l.kind === 'flying') ?? s.laps[0];
    const refLap = get().refLap ?? (best ? { sessionId: s.id, lap: best.n } : undefined);
    const next = { ...get(), sessions: [...sessions, s], refLap };
    set({
      sessions: refreshAll(next),
      selectedLaps: best ? [...get().selectedLaps, { sessionId: s.id, lap: best.n }] : get().selectedLaps,
      refLap,
    });
    // markers saved earlier for a file of the same name come back
    const restored = markersToRestore(loadSavedMarkers(), s, get().markers);
    if (restored.length) {
      const n0 = get().markers.length;
      set({
        markers: [
          ...get().markers,
          ...restored.map((m, i) => ({ id: `m${Date.now().toString(36)}r${n0 + i}`, name: m.name, color: m.color, note: m.note, sessionId: s.id, idx: m.idx })),
        ],
      });
    }
  },
  removeSession(id) {
    set((st) => ({
      sessions: st.sessions.filter((s) => s.id !== id),
      selectedLaps: st.selectedLaps.filter((l) => l.sessionId !== id),
      lapMeta: Object.fromEntries(Object.entries(st.lapMeta).filter(([k]) => !k.startsWith(`${id}:`))),
      refLap: st.refLap?.sessionId === id ? undefined : st.refLap,
      cursor: st.cursor?.sessionId === id ? null : st.cursor,
      clickPos: st.clickPos?.sessionId === id ? null : st.clickPos,
      workspace: {
        ...st.workspace,
        mathChannels: st.workspace.mathChannels.map((d) => {
          if (!d.perSession?.[id] && !Object.keys(d.perLap ?? {}).some((k) => k.startsWith(`${id}:`))) return d;
          const perSession = { ...(d.perSession ?? {}) };
          delete perSession[id];
          const perLap = Object.fromEntries(Object.entries(d.perLap ?? {}).filter(([k]) => !k.startsWith(`${id}:`)));
          const next: MathDef = { ...d };
          if (Object.keys(perSession).length) next.perSession = perSession;
          else delete next.perSession;
          if (Object.keys(perLap).length) next.perLap = perLap;
          else delete next.perLap;
          return next;
        }),
      },
      markers: st.markers.filter((m) => m.sessionId !== id),
      activeMarkerId: st.markers.some((m) => m.id === st.activeMarkerId && m.sessionId === id) ? null : st.activeMarkerId,
    }));
  },
  replaceSession(s) {
    set((st) => ({ sessions: st.sessions.map((x) => (x.id === s.id ? s : x)) }));
  },
  setSessionColor(id, color) {
    set((st) => {
      const prev = st.sessions.find((x) => x.id === id)?.color;
      // laps of this run that still wear the old run colour follow it; custom lap colours stay
      const lapMeta = { ...st.lapMeta };
      for (const [k, m] of Object.entries(lapMeta)) if (k.startsWith(`${id}:`) && m.color === prev) lapMeta[k] = { ...m, color };
      return { sessions: st.sessions.map((x) => (x.id === id ? { ...x, color } : x)), lapMeta };
    });
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
        return refreshSession(s, track, st.workspace.mathChannels, refOf(st), st.sessions);
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
        return refreshSession(s, track, st.workspace.mathChannels, refOf(st), st.sessions);
      }),
    });
  },
  addMathChannel(def) {
    const st = get();
    const prev = st.workspace.mathChannels.find((d) => d.name === def.name);
    const merged: MathDef = { ...def, perLap: def.perLap ?? prev?.perLap, perSession: def.perSession ?? prev?.perSession };
    if (!merged.perLap || !Object.keys(merged.perLap).length) delete merged.perLap;
    if (!merged.perSession || !Object.keys(merged.perSession).length) delete merged.perSession;
    const defs = [...st.workspace.mathChannels.filter((d) => d.name !== def.name), merged];
    for (const s of st.sessions) recomputeMath(s, defs, { sessions: st.sessions, ref: refOf(st) });
    set({
      workspace: { ...st.workspace, mathChannels: defs },
      sessions: st.sessions.map((s) => ({ ...s, channels: new Map(s.channels) })),
    });
  },
  setMathLapExpr(name, sessionId, lap, expr) {
    const st = get();
    const cur = st.workspace.mathChannels.find((d) => d.name === name);
    if (!cur) return;
    const perLap = { ...(cur.perLap ?? {}) };
    const k = lapKey(sessionId, lap);
    if (expr && expr.trim()) perLap[k] = expr.trim();
    else delete perLap[k];
    const next: MathDef = { ...cur };
    if (Object.keys(perLap).length) next.perLap = perLap;
    else delete next.perLap;
    const defs = st.workspace.mathChannels.map((d) => (d.name === name ? next : d));
    for (const s of st.sessions) recomputeMath(s, defs, { sessions: st.sessions, ref: refOf(st) });
    set({
      workspace: { ...st.workspace, mathChannels: defs },
      sessions: st.sessions.map((s) => ({ ...s, channels: new Map(s.channels) })),
    });
  },
  setMathSessionExpr(name, sessionId, expr) {
    const st = get();
    const cur = st.workspace.mathChannels.find((d) => d.name === name);
    if (!cur) return;
    const perSession = { ...(cur.perSession ?? {}) };
    if (expr && expr.trim()) perSession[sessionId] = expr.trim();
    else delete perSession[sessionId];
    const next: MathDef = { ...cur };
    if (Object.keys(perSession).length) next.perSession = perSession;
    else delete next.perSession;
    const defs = st.workspace.mathChannels.map((d) => (d.name === name ? next : d));
    for (const s of st.sessions) recomputeMath(s, defs, { sessions: st.sessions, ref: refOf(st) });
    set({
      workspace: { ...st.workspace, mathChannels: defs },
      sessions: st.sessions.map((s) => ({ ...s, channels: new Map(s.channels) })),
    });
  },
  addMarker(sessionId, idx, patch) {
    const st = get();
    const n = st.markers.length + 1;
    const m: DataMarker = {
      id: `m${Date.now().toString(36)}${n}`,
      name: patch?.name ?? `M${n}`,
      color: patch?.color ?? MARKER_COLORS[(n - 1) % MARKER_COLORS.length],
      sessionId,
      idx,
      note: patch?.note,
    };
    set({ markers: [...st.markers, m], activeMarkerId: m.id });
    persistMarkers(get().markers, get().sessions);
    return m;
  },
  addMarkerAtCursor(prefer = 'click') {
    const { cursor, clickPos, addMarker } = get();
    const at = prefer === 'click' ? (clickPos ?? cursor) : (cursor ?? clickPos);
    if (!at) return null;
    return addMarker(at.sessionId, at.idx);
  },
  setClickPos(c) {
    set({ clickPos: c });
  },
  updateMarker(id, patch) {
    set((st) => ({ markers: st.markers.map((m) => (m.id === id ? { ...m, ...patch } : m)) }));
    persistMarkers(get().markers, get().sessions);
  },
  removeMarker(id) {
    set((st) => {
      const markers = st.markers.filter((m) => m.id !== id);
      return { markers, activeMarkerId: st.activeMarkerId === id ? (markers[markers.length - 1]?.id ?? null) : st.activeMarkerId };
    });
    persistMarkers(get().markers, get().sessions);
  },
  clearMarkers() {
    set({ markers: [], activeMarkerId: null });
    persistMarkers([], get().sessions);
  },
  setActiveMarker(id) {
    set({ activeMarkerId: id });
  },
  removeMathChannel(name) {
    const st = get();
    const defs = st.workspace.mathChannels.filter((d) => d.name !== name);
    for (const s of st.sessions) recomputeMath(s, defs, { sessions: st.sessions, ref: refOf(st) });
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
        return refreshSession(s, track, st.workspace.mathChannels, refOf(st), st.sessions);
      }),
    });
  },
  setTrack(t0) {
    const st = get();
    const t = normalizeTrackOrigin(t0);
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
    const gone = session.laps.find((l) => l.n === lap);
    if (!gone) return;
    session.deletedRanges = [...(session.deletedRanges ?? []), [gone.startIdx, gone.endIdx]];
    session.laps = withoutDeletedLaps(session.laps.filter((l) => l !== gone), session.deletedRanges);
    const meta = { ...st.lapMeta };
    delete meta[lapKey(sessionId, lap)];
    const refLap = st.refLap?.sessionId === sessionId && st.refLap.lap === lap ? undefined : st.refLap;
    const track = activeTrack(st);
    // per-lap formulas and markers of the deleted lap go with it
    const mathChannels = st.workspace.mathChannels.map((d) => {
      if (!d.perLap || !(lapKey(sessionId, lap) in d.perLap)) return d;
      const perLap = { ...d.perLap };
      delete perLap[lapKey(sessionId, lap)];
      const next: MathDef = { ...d };
      if (Object.keys(perLap).length) next.perLap = perLap;
      else delete next.perLap;
      return next;
    });
    const markers = st.markers.filter((m) => !(m.sessionId === sessionId && m.idx >= gone.startIdx && m.idx <= gone.endIdx));
    set({
      lapMeta: meta,
      refLap,
      markers,
      activeMarkerId: markers.some((m) => m.id === st.activeMarkerId) ? st.activeMarkerId : (markers[0]?.id ?? null),
      workspace: { ...st.workspace, mathChannels },
      selectedLaps: st.selectedLaps.filter((l) => !(l.sessionId === sessionId && l.lap === lap)),
      cursor: st.cursor?.sessionId === sessionId ? null : st.cursor,
      sessions: st.sessions.map((s) => (s.id === sessionId ? refreshSession(s, track, mathChannels, refOf({ ...st, refLap }), st.sessions) : s)),
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
    const next: TrackModel = normalizeTrackOrigin({ ...track, startFinish: sf, sectors });
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

// autosave the workspace (debounced) so panel layouts, math channels and label styles survive a reload
let wsTimer: ReturnType<typeof setTimeout> | null = null;
useLab.subscribe((st, prev) => {
  if (st.workspace === prev.workspace) return;
  if (wsTimer) clearTimeout(wsTimer);
  wsTimer = setTimeout(() => {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(WORKSPACE_KEY, serializeWorkspace(st.workspace));
    } catch {
      /* storage unavailable */
    }
  }, 300);
});
