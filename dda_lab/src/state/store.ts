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
import { browserTileLoader } from '../sim/browserTiles';
import { CorridorError, extractCorridor } from '../sim/corridor';
import { fetchCorridor, putCorridor } from '../sim/corridorService';
import { deserializeCorridor, serializeCorridor } from '../sim/corridorCache';
import { corridorFromPist, parsePistPackage, trackFromPist, type PistPackage } from '../core/pistPackage';
import { buildMosaic, SAT_ZOOM, tileRangeFor } from '../sim/tiles';
import { simulate } from '../sim';
import { lateralCeilingG } from '../sim/fitRider';
import { applyFit, buildFitModel, fitRows, fitSession, refTimeOnLine, type CornerSetting, type FitCornerRow, type FitModel, type FitProgress } from '../sim/fitModel';
import { lapReferenceProblem, referenceFromLap, type LapReference } from '../sim/lapReference';
import { ownerOffsets } from '../sim/ownerOffsets';
import type { Reference } from '../sim/reference';
import { DERIVED_KEYS, deriveRider } from '../sim/derive';
import { DEFAULT_SIM_PARAMS, presetById } from '../sim/presets';
import { gripRiskMessage } from '../sim/risk';
import type { Corner, Corridor, DerivedRiderKey, Line, SimParams, SolverMode } from '../sim/types';

export interface FitSummary {
  refName: string;
  lapTimeS: number;
  refLapTimeS: number;
  /** The reference speed integrated over the ridden (tuned) fit line, s. */
  alignedRefLapS: number;
  ceilingG: number;
  ceilingLeanDeg: number;
  rows: FitCornerRow[];
  notes: string[];
  /** The fit's own run: refinement rounds, error before → after, wall time. */
  stats: FitModel['stats'];
  pathTrusted: boolean;
}

/** Runs `buildFitModel` (the browser passes a Worker wrapper; tests run it inline). */
export type FitRunner = (
  track: TrackModel,
  corridor: Corridor | undefined,
  params: SimParams,
  lapRef: LapReference,
  onProgress: (p: FitProgress) => void,
) => Promise<FitModel>;

/** The two optimal solver modes (spec v2 §2.10). */
export type OptimalMode = Exclude<SolverMode, 'rider' | 'fit'>;

/**
 * An optimal solver, injected so a node test can drive `runOptimal` without a
 * Worker or a bridge. The browser passes a wrapper around the free-trajectory
 * worker (W2) or the OCP client (W5).
 */
export type OptimalRunner = (
  track: TrackModel,
  corridor: Corridor | undefined,
  params: SimParams,
  onProgress: (frac: number, lapTimeS?: number, stage?: { start: number; starts: number; label: string }) => void,
  /**
   * The lap-time line's extras (pist-line note §9): warm starts as offsets
   * (the owner's GPS path) and the reference lap for the lateral-g penalty.
   */
  ctx?: { warmStarts?: Float32Array[]; reference?: Reference },
) => Promise<{ offsetsM: Float32Array; vMs?: Float32Array; lapTimeS: number; info?: { kept: string; ms: number; outOfBudget: boolean; starts?: Array<{ label: string; lapTimeS: number }> } }>;

/** Rider with every non-pinned field derived from aggressiveness/risk. */
function withDerivedRider(p: SimParams): SimParams {
  return { ...p, rider: deriveRider(p.rider, p.tyre) };
}

/** The store's starting parameters: the shipped defaults with the rider derived. */
export const INITIAL_SIM_PARAMS: SimParams = withDerivedRider(DEFAULT_SIM_PARAMS);

const DERIVED_SET = new Set<string>(DERIVED_KEYS);

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

/**
 * The corridor write token. Corridors themselves live on the server; only this
 * one secret is per-user, because it decides who may publish one.
 */
const CORRIDOR_TOKEN_KEY = 'dda-lab-corridor-token';

function loadCorridorToken(): string {
  try {
    return typeof localStorage !== 'undefined' ? (localStorage.getItem(CORRIDOR_TOKEN_KEY) ?? '') : '';
  } catch {
    return '';
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
  bottomTab: 'laps' | 'track' | 'channels' | 'math' | 'reports' | 'external' | 'cursor' | 'markers' | 'sim';
  statusMessage: string | null;
  /** User-placed data markers (fixed samples). */
  markers: DataMarker[];
  /** Marker whose values the Markers panel shows. */
  activeMarkerId: string | null;
  /** Last sample the user clicked (chart or map); the 📍 Mark button places markers here. */
  clickPos: CursorPos | null;
  /**
   * The `.pist.json` track model in use (spec v2 follow-up, 2026-10-11): its
   * centreline is the active track and its asphalt edges the corridor, so the
   * virtual rider rides the surveyed model the map shows.
   */
  trackPackage?: PistPackage;
  /** Make a pist package the active track (sessions re-project onto it) and its edges the corridor. */
  applyTrackPackage(p: PistPackage): void;
  /** Drop the package overlay; the track and corridor it installed stay until replaced. */
  clearTrackPackage(): void;
  /** Track boundaries for the active track, from the server or freshly extracted. */
  corridor?: Corridor;
  /** True while tiles are being fetched or the store is being read. */
  corridorBusy: boolean;
  /** Ask the server for this track's stored corridor. Cheap; safe to call on load. */
  loadCorridor(): Promise<void>;
  /** Fetch tiles, extract the corridor and store it on the server. */
  extractCorridorNow(): Promise<void>;
  /** Write token for the corridor store; empty means this user cannot publish one. */
  corridorToken: string;
  setCorridorToken(t: string): void;
  /** Push the current corridor to the bridge again (with the token if one is set; a local bridge takes it without). */
  publishCorridor(): Promise<void>;
  /** The current corridor as the stored JSON record, or null when there is none. */
  exportCorridorJson(): string | null;
  /** Install a corridor from a stored JSON record; false when it is not this circuit's. */
  importCorridorJson(text: string): boolean;

  /** Virtual rider parameters. */
  simParams: SimParams;
  /** True while a simulated lap is in the workspace. */
  simEnabled: boolean;
  /** The generated line, for the map layer. */
  simLine?: Line;
  simLapTimeS?: number;
  /** Corner sections of the rider-mode lap (header count, map markers). */
  simCorners?: Corner[];
  /** Risk banner text for the rider-mode lap, or null. */
  simRisk: string | null;
  /** Which solver's session the panel highlights. Switching never computes. */
  solverMode: SolverMode;
  simOptBusy: Record<OptimalMode, boolean>;
  /** 0..1 per optimal mode. */
  simOptProgress: Record<OptimalMode, number>;
  simOptLapTimeS: Partial<Record<OptimalMode, number>>;
  simOptLines: Partial<Record<OptimalMode, Line>>;
  /** True once machine/tyre/line params moved after that optimal lap was computed. */
  simOptStale: Record<OptimalMode, boolean>;
  setSimEnabled(on: boolean): void;
  /**
   * Patch any subset of the three parameter groups, re-derive the rider from
   * aggressiveness/risk and re-simulate the RIDER mode only. Patching a derived
   * key pins it (adds it to `rider.overrides`). Never runs an optimal solver.
   */
  setSimParams(patch: { machine?: Partial<SimParams['machine']>; tyre?: Partial<SimParams['tyre']>; rider?: Partial<SimParams['rider']> }): void;
  /** Unpin a derived rider key so it follows the sliders again. */
  clearOverride(key: DerivedRiderKey): void;
  setSolverMode(mode: SolverMode): void;
  /** Run an optimal solver (the "Hesapla" button) and add its session. */
  runOptimal(mode: OptimalMode, runner: OptimalRunner): Promise<void>;
  /** "Optimise line" (lineMode 'lap-time', pist-line note §8): a run in progress. */
  simLineOptBusy: boolean;
  /** 0..1 while it runs. */
  simLineOptProgress: number;
  /** The rider's QSS lap on the last optimised line, s. */
  simLineOptLapTimeS?: number;
  /** Which warm start the run is descending (note §9: "start 2/2"), while it runs. */
  simLineOptStage?: { start: number; starts: number; label: string };
  /** What the last run used and kept: starts, reference, wall time. */
  simLineOptInfo?: { starts: string[]; reference?: string; kept?: string; ms?: number; outOfBudget?: boolean; startLapsS?: number[] };
  /**
   * Run the direct lap-time line optimiser (the runner stores its result in
   * lapTimeLine.ts), then switch `lineMode` to 'lap-time' and re-simulate, so
   * the rider mode and "Fit to reference" run on that line.
   */
  optimiseLine(runner: OptimalRunner): Promise<void>;
  /** Load a machine preset: machine, tyre and the kappa default together. */
  applyMachinePreset(id: string): void;
  /** Result of the last "Fit to reference" run (with the current corner settings), for the sim panel's table. */
  simFit?: FitSummary;
  /** The fitted per-corner model (fitModel.ts) and the corner settings it is ridden with. */
  fitModel?: FitModel;
  fitSettings?: CornerSetting[];
  /** Track the model was fitted on (a different active track invalidates it). */
  fitTrackId?: string;
  /** The fit's line (the tuned one), for the map. */
  fitLine?: Line;
  /** The corner picked on the map / in the corner bar, or null. */
  fitCorner: number | null;
  fitBusy: boolean;
  fitProgress?: FitProgress;
  /** The lap the fit is fitted to; unset = the reference lap, else the first usable. */
  fitRefLap?: { sessionId: string; lap: number };
  setFitRefLap(sel: { sessionId: string; lap: number } | undefined): void;
  /** Fit the per-corner rider to the chosen lap and add its session (inline without a runner). */
  runFit(runner?: FitRunner): Promise<void>;
  setFitCorner(k: number | null): void;
  /** Change one corner's settings and re-ride the fitted lap (no re-fit). */
  setCornerSetting(k: number, patch: Partial<CornerSetting>): void;
  /** Back to the fitted settings: one corner, or all. */
  resetCornerSettings(k?: number): void;

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

export const SIM_SESSION_ID = 'sim';
export const SIM_OPT_SESSION_ID = 'sim-opt';
export const SIM_OCP_SESSION_ID = 'sim-ocp';
const SIM_COLOR = '#c77dff';
/** Session id, name and colour per optimal mode (spec v2 §2.10: second and third colour). */
const OPT_SESSION: Record<OptimalMode, { id: string; name: string; color: string }> = {
  freeTrajectory: { id: SIM_OPT_SESSION_ID, name: 'Ideal line', color: '#2ec4b6' },
  ocp: { id: SIM_OCP_SESSION_ID, name: 'Physics limit', color: '#ff9f1c' },
};
export const SIM_FIT_SESSION_ID = 'sim-fit';
const SIM_FIT_COLOR = '#ff4d6d';
const ALL_SIM_IDS = new Set([SIM_SESSION_ID, SIM_OPT_SESSION_ID, SIM_OCP_SESSION_ID, SIM_FIT_SESSION_ID]);

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
  trackPackage: undefined,
  corridor: undefined,
  corridorBusy: false,
  corridorToken: loadCorridorToken(),
  simParams: INITIAL_SIM_PARAMS,
  simEnabled: false,
  simLine: undefined,
  simLapTimeS: undefined,
  simCorners: undefined,
  simRisk: null,
  solverMode: 'rider',
  simOptBusy: { freeTrajectory: false, ocp: false },
  simOptProgress: { freeTrajectory: 0, ocp: 0 },
  simOptLapTimeS: {},
  simOptLines: {},
  simOptStale: { freeTrajectory: false, ocp: false },
  simLineOptBusy: false,
  simLineOptProgress: 0,
  fitCorner: null,
  fitBusy: false,
  simLineOptLapTimeS: undefined,

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
  applyTrackPackage(p) {
    const st = get();
    const t = normalizeTrackOrigin(trackFromPist(p));
    const tracks = [...st.tracks.filter((x) => x.id !== t.id), t];
    const corridor = corridorFromPist(p, t) ?? undefined;
    const pct = corridor ? Math.round((100 * corridor.known.filter(Boolean).length) / corridor.known.length) : 0;
    set({
      tracks,
      activeTrackId: t.id,
      trackPackage: p,
      corridor,
      sessions: refreshAll({ ...st, tracks, activeTrackId: t.id }, t),
      cursor: null,
      statusMessage: corridor
        ? `Track model "${p.name}": ${t.turns.length} corners, ${(t.lengthM / 1000).toFixed(3)} km, corridor ${pct} % resolved.`
        : `Track model "${p.name}" loaded without usable edges.`,
    });
    if (get().simEnabled) runSim(set, get);
  },
  clearTrackPackage() {
    set({ trackPackage: undefined });
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
    // a pist package's edges beat the server corridor; only ask the server
    // when the active track is not the package's
    if (get().trackPackage && t.id.startsWith('pist-')) return;
    void get().loadCorridor();
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
    set({ tracks, activeTrackId: next.id, sessions, selectedLaps, cursor: null, corridor: undefined });
    void get().loadCorridor();
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
  setCorridorToken(t) {
    set({ corridorToken: t });
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(CORRIDOR_TOKEN_KEY, t);
    } catch {
      /* storage unavailable: the token still works this session */
    }
  },
  async publishCorridor() {
    const st = get();
    const track = activeTrack(st);
    if (!track || !st.corridor) {
      set({ statusMessage: 'Nothing to publish — extract or import a corridor first.' });
      return;
    }
    set({ corridorBusy: true });
    try {
      const saved = await putCorridor(track, st.corridor, st.corridorToken);
      set({
        statusMessage: saved
          ? 'Corridor saved to the bridge.'
          : 'The bridge refused the corridor — a public host needs the publish token; a local bridge must be running.',
      });
    } finally {
      set({ corridorBusy: false });
    }
  },
  exportCorridorJson() {
    const st = get();
    const track = activeTrack(st);
    if (!track || !st.corridor) return null;
    return JSON.stringify(serializeCorridor(track, st.corridor));
  },
  importCorridorJson(text) {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      set({ statusMessage: 'Corridor import: not valid JSON.' });
      return false;
    }
    // A `.pist.json` track model carries its own track AND corridor: it needs
    // no session loaded, and becomes the active track the rider runs on.
    if (raw && typeof raw === 'object' && (raw as { version?: unknown }).version === 2 && Array.isArray((raw as { centerline?: unknown }).centerline)) {
      try {
        get().applyTrackPackage(parsePistPackage(text));
        return true;
      } catch (e) {
        set({ statusMessage: `Track model import: ${(e as Error).message}` });
        return false;
      }
    }
    const track = activeTrack(get());
    if (!track) {
      set({ statusMessage: 'Load a session or a .pist.json track model first — a corridor belongs to its track.' });
      return false;
    }
    const corridor = deserializeCorridor(track, raw);
    if (!corridor) {
      set({ statusMessage: 'Corridor import: this file is not a corridor of the loaded circuit.' });
      return false;
    }
    const pct = Math.round((100 * corridor.known.filter(Boolean).length) / corridor.known.length);
    set({ corridor, statusMessage: `Corridor imported — ${pct} % of the track resolved.` });
    if (get().simEnabled) runSim(set, get);
    return true;
  },
  async loadCorridor() {
    const track = activeTrack(get());
    if (!track) return;
    set({ corridorBusy: true });
    try {
      const stored = await fetchCorridor(track);
      // a track change while the request was in flight must not install the wrong corridor
      if (stored && activeTrack(get())?.id === track.id) set({ corridor: stored });
    } finally {
      set({ corridorBusy: false });
    }
  },
  async extractCorridorNow() {
    const st = get();
    const track = activeTrack(st);
    if (!track) {
      set({ statusMessage: 'Load a session first — the corridor is extracted along its track.' });
      return;
    }
    // a .pist.json track model carries surveyed asphalt edges: they ARE the
    // corridor, nothing stored or extracted from GPS may replace them
    if (st.trackPackage && track.id.startsWith('pist-')) {
      const c = corridorFromPist(st.trackPackage, track);
      if (c) {
        const pct = Math.round((100 * c.known.filter(Boolean).length) / c.known.length);
        set({ corridor: c, statusMessage: `Corridor comes from the track model "${st.trackPackage.name}" (${pct} % resolved) — nothing to extract.` });
        if (get().simEnabled) runSim(set, get);
        return;
      }
    }
    // the server already has one for this exact centerline: use it, fetch nothing
    const stored = await fetchCorridor(track);
    if (stored) {
      // a track change while the request was in flight must not install the wrong corridor
      if (activeTrack(get())?.id === track.id) set({ corridor: stored, statusMessage: 'Corridor loaded from the server.' });
      return;
    }
    const trace: LngLat[] = [];
    for (const s of st.sessions) {
      const lng = s.channels.get('gps_lon')?.data;
      const lat = s.channels.get('gps_lat')?.data;
      if (!lng || !lat) continue;
      for (let i = 0; i < lng.length; i += 5) {
        if (Number.isFinite(lng[i]) && Number.isFinite(lat[i]) && (lng[i] !== 0 || lat[i] !== 0)) {
          trace.push([lng[i], lat[i]]);
        }
      }
    }
    set({ corridorBusy: true, statusMessage: 'Fetching satellite tiles…' });
    try {
      const range = tileRangeFor(track.centerline, SAT_ZOOM, 80);
      const mosaic = await buildMosaic(range, browserTileLoader);
      if (mosaic.missing.every(Boolean)) {
        throw new CorridorError('tiles-failed', 'No satellite tiles could be fetched. Check the network connection.');
      }
      const corridor = extractCorridor(track, mosaic, trace);
      const pct = Math.round((100 * corridor.known.filter(Boolean).length) / corridor.known.length);
      // the ~15 s tile fetch above gives the user ample time to switch tracks; the
      // corridor just extracted is for `track`, not necessarily the active one any more
      if (activeTrack(get())?.id !== track.id) return;
      set({ corridor, statusMessage: `Corridor extracted — ${pct} % of the track resolved.` });
      // publish it so nobody has to extract this track again
      const token = get().corridorToken;
      if (token) {
        const saved = await putCorridor(track, corridor, token);
        if (activeTrack(get())?.id !== track.id) return;
        set({
          statusMessage: saved
            ? `Corridor extracted (${pct} % resolved) and saved to the server.`
            : `Corridor extracted (${pct} % resolved), but the server refused to store it — check the token.`,
        });
      }
    } catch (e) {
      const msg = e instanceof CorridorError ? e.message : `Corridor extraction failed: ${(e as Error).message}`;
      set({ statusMessage: msg });
    } finally {
      set({ corridorBusy: false });
    }
  },
  setSimEnabled(on) {
    if (!on) {
      set((st) => ({
        simEnabled: false,
        simLine: undefined,
        simLapTimeS: undefined,
        simCorners: undefined,
        simRisk: null,
        simOptLapTimeS: {},
        simOptLines: {},
        simOptStale: { freeTrajectory: false, ocp: false },
        simFit: undefined,
        fitModel: undefined,
        fitSettings: undefined,
        fitLine: undefined,
        fitCorner: null,
        sessions: st.sessions.filter((s) => !ALL_SIM_IDS.has(s.id)),
        selectedLaps: st.selectedLaps.filter((l) => !ALL_SIM_IDS.has(l.sessionId)),
        refLap: st.refLap && ALL_SIM_IDS.has(st.refLap.sessionId) ? undefined : st.refLap,
        cursor: st.cursor && ALL_SIM_IDS.has(st.cursor.sessionId) ? null : st.cursor,
      }));
      return;
    }
    // the rider's line and corridor are what the user switched on to see:
    // reveal those map layers (they start hidden) instead of asking for a
    // second click in the Layers menu
    const ws = get().workspace;
    const ml = ws.mapLayers;
    const simEnabledPatch: Partial<LabState> = { simEnabled: true };
    if (ml.idealLine === false || ml.corridor === false) {
      simEnabledPatch.workspace = { ...ws, mapLayers: { ...ml, idealLine: true, corridor: true } };
    }
    set(simEnabledPatch);
    runSim(set, get);
  },
  setSimParams(patch) {
    set((st) => {
      // patching a derived key by hand pins it (spec v2 §2.6 advanced panel)
      const pinned = new Set<DerivedRiderKey>(patch.rider?.overrides ?? st.simParams.rider.overrides ?? []);
      for (const k of Object.keys(patch.rider ?? {})) if (DERIVED_SET.has(k)) pinned.add(k as DerivedRiderKey);
      const next: SimParams = {
        machine: { ...st.simParams.machine, ...patch.machine },
        tyre: { ...st.simParams.tyre, ...patch.tyre },
        rider: { ...st.simParams.rider, ...patch.rider, overrides: [...pinned] },
      };
      return { simParams: withDerivedRider(next), simOptStale: staleAfter(st, patch) };
    });
    if (get().simEnabled) runSim(set, get);
  },
  clearOverride(key) {
    set((st) => {
      const rider = { ...st.simParams.rider, overrides: st.simParams.rider.overrides.filter((k) => k !== key) };
      return { simParams: withDerivedRider({ ...st.simParams, rider }) };
    });
    if (get().simEnabled) runSim(set, get);
  },
  setSolverMode(mode) {
    // highlight only: the optimal solvers run from runOptimal (the button)
    set({ solverMode: mode });
  },
  async runOptimal(mode, runner) {
    const st0 = get();
    if (st0.simOptBusy[mode]) return;
    const track = activeTrack(st0);
    if (!track) {
      set({ statusMessage: 'The simulator needs a track — open a session first.' });
      return;
    }
    if (!st0.simEnabled) get().setSimEnabled(true);
    const { corridor, simParams } = get();
    const trackId = track.id;
    const setBusy = (busy: boolean): void =>
      set({ simOptBusy: { ...get().simOptBusy, [mode]: busy } });
    setBusy(true);
    set({ simOptProgress: { ...get().simOptProgress, [mode]: 0 } });
    try {
      const r = await runner(track, corridor, simParams, (frac) => {
        set({ simOptProgress: { ...get().simOptProgress, [mode]: Math.min(1, Math.max(0, frac)) } });
      });
      const st = get();
      // the simulator was switched off or the track changed while it ran
      if (!st.simEnabled || st.activeTrackId !== trackId) return;
      const meta = OPT_SESSION[mode];
      const res = simulate(track, corridor, simParams, meta.id, meta.name, meta.color, mode, {
        offsetsM: r.offsetsM,
        vMs: r.vMs,
      });
      const others = st.sessions.filter((s) => s.id !== meta.id);
      const next = { ...st, sessions: [...others, res.session] };
      const selectedLaps = st.selectedLaps.some((l) => l.sessionId === meta.id)
        ? st.selectedLaps
        : [...st.selectedLaps, { sessionId: meta.id, lap: 1 }];
      set({
        sessions: refreshAll(next),
        selectedLaps,
        simOptLapTimeS: { ...st.simOptLapTimeS, [mode]: res.lapTimeS },
        simOptLines: { ...st.simOptLines, [mode]: res.line },
        simOptStale: { ...st.simOptStale, [mode]: false },
        simOptProgress: { ...st.simOptProgress, [mode]: 1 },
      });
    } catch (e) {
      set({ statusMessage: `${mode === 'ocp' ? 'Full OCP' : 'Free trajectory'} failed: ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  },
  async optimiseLine(runner) {
    const st0 = get();
    if (st0.simLineOptBusy) return;
    const track = activeTrack(st0);
    if (!track) {
      set({ statusMessage: 'The simulator needs a track — open a session first.' });
      return;
    }
    if (!st0.simEnabled) get().setSimEnabled(true);
    const { corridor, simParams } = get();
    const trackId = track.id;
    // note §9: the reference lap (lateral-g penalty) and the owner's GPS path (a warm start)
    const ctx = lapTimeContext(get(), track);
    set({
      simLineOptBusy: true,
      simLineOptProgress: 0,
      simLineOptStage: undefined,
      simLineOptInfo: { starts: ['κ-line', ...(ctx.ownerName ? [ctx.ownerName] : [])], reference: ctx.reference?.name },
    });
    const t0 = performance.now();
    try {
      const r = await runner(
        track,
        corridor,
        simParams,
        (frac, _lap, stage) => set({ simLineOptProgress: Math.min(1, Math.max(0, frac)), ...(stage ? { simLineOptStage: stage } : {}) }),
        { warmStarts: ctx.warmStarts, reference: ctx.reference },
      );
      if (get().activeTrackId !== trackId) return;
      const info = get().simLineOptInfo;
      set({
        simLineOptLapTimeS: r.lapTimeS,
        simLineOptProgress: 1,
        simLineOptInfo: info && {
          ...info,
          kept: r.info?.kept,
          ms: r.info?.ms ?? performance.now() - t0,
          outOfBudget: r.info?.outOfBudget,
          startLapsS: r.info?.starts?.map((x) => x.lapTimeS),
        },
      });
      // the runner stored the line; this re-simulates the rider mode on it
      get().setSimParams({ rider: { lineMode: 'lap-time' } });
    } catch (e) {
      set({ statusMessage: `Optimise line failed: ${(e as Error).message}` });
    } finally {
      set({ simLineOptBusy: false, simLineOptStage: undefined });
    }
  },
  setFitRefLap(sel) {
    set({ fitRefLap: sel });
  },
  async runFit(runner) {
    const st0 = get();
    if (st0.fitBusy) return;
    const track = activeTrack(st0);
    if (!track) {
      set({ statusMessage: 'The simulator needs a track — open a session first.' });
      return;
    }
    const pick = fitReferenceLap(st0, track);
    if (!pick) {
      set({ statusMessage: 'Fit to reference needs a lap: open a lap JSON with a corner summary (viraj_ozeti), or any recorded lap with GPS on a track with turns.' });
      return;
    }
    let lapRef: LapReference;
    try {
      lapRef = referenceFromLap(pick.session, pick.lap, track);
    } catch (e) {
      set({ statusMessage: `Fit to reference: ${(e as Error).message}` });
      return;
    }
    if (!st0.simEnabled) get().setSimEnabled(true);
    const { corridor, simParams } = get();
    set({ fitBusy: true, fitProgress: { frac: 0, stage: 'starting' } });
    try {
      const onProgress = (p: FitProgress): void => set({ fitProgress: p });
      const model = runner
        ? await runner(track, corridor, simParams, lapRef, onProgress)
        : buildFitModel(track, corridor, simParams, lapRef, { budgetMs: 2000, onProgress });
      if (activeTrack(get())?.id !== track.id) return; // the track changed meanwhile
      set({ fitModel: model, fitSettings: model.fitted.map((x) => ({ ...x })), fitTrackId: track.id, fitCorner: get().fitCorner ?? null });
      rideFit(set, get);
    } catch (e) {
      set({ statusMessage: `Fit to reference failed: ${(e as Error).message}` });
    } finally {
      set({ fitBusy: false });
    }
  },
  setFitCorner(k) {
    set({ fitCorner: k });
  },
  setCornerSetting(k, patch) {
    const st = get();
    if (!st.fitSettings || k < 0 || k >= st.fitSettings.length) return;
    const fitSettings = st.fitSettings.map((x, j) => (j === k ? { ...x, ...patch } : x));
    set({ fitSettings });
    rideFit(set, get);
  },
  resetCornerSettings(k) {
    const st = get();
    if (!st.fitModel || !st.fitSettings) return;
    const fitted = st.fitModel.fitted;
    set({ fitSettings: st.fitSettings.map((x, j) => (k === undefined || j === k ? { ...fitted[j] } : x)) });
    rideFit(set, get);
  },
  applyMachinePreset(id) {
    const preset = presetById(id);
    set((st) => ({
      simParams: withDerivedRider({
        machine: { presetId: preset.id, ...preset.machine },
        tyre: { ...preset.tyre },
        rider: { ...st.simParams.rider, kappa: preset.kappa },
      }),
      simOptStale: staleAfter(st, { machine: {} }),
    }));
    if (get().simEnabled) runSim(set, get);
  },
}));

/**
 * The lap-time line's extras from the loaded sessions (pist-line note §9):
 *   reference  the reference lap's session when it carries a corner summary,
 *              else the first that does (the same rule as "Fit to reference");
 *   warm start the owner's GPS path: the reference lap when it is a recorded
 *              lap with GPS, else the best lap of the first recorded session
 *              with GPS, mapped into the corridor (`ownerOffsets`).
 */
function lapTimeContext(
  st: Pick<LabState, 'sessions' | 'refLap'>,
  track: TrackModel,
): { reference?: Reference; warmStarts: Float32Array[]; ownerName?: string } {
  const refSession =
    (st.refLap && st.sessions.find((x) => x.id === st.refLap!.sessionId && x.reference)) ?? st.sessions.find((x) => x.reference);
  const gps = (x: Session): boolean => !x.isSim && !x.reference && x.channels.has('gps_lon') && x.channels.has('gps_lat');
  const fromRef = st.refLap ? st.sessions.find((x) => x.id === st.refLap!.sessionId && gps(x)) : undefined;
  const session = fromRef ?? st.sessions.find(gps);
  const lap = session && (fromRef ? session.laps.find((l) => l.n === st.refLap!.lap) : (session.laps.find((l) => l.isBest) ?? session.laps.find((l) => l.kind === 'flying')));
  const warmStarts: Float32Array[] = [];
  let ownerName: string | undefined;
  if (session && lap) {
    const lonC = session.channels.get('gps_lon')!.data;
    const latC = session.channels.get('gps_lat')!.data;
    const lon: number[] = [];
    const lat: number[] = [];
    for (let i = lap.startIdx; i <= lap.endIdx && i < lonC.length; i++) {
      if (Number.isFinite(lonC[i]) && Number.isFinite(latC[i])) {
        lon.push(lonC[i]);
        lat.push(latC[i]);
      }
    }
    if (lon.length > 50) {
      warmStarts.push(ownerOffsets(track, lon, lat));
      ownerName = `${session.name} lap ${lap.n}`;
    }
  }
  return { reference: refSession?.reference, warmStarts, ownerName };
}

/**
 * Which optimal laps go out of date after a patch. The optimal solvers use the
 * ideal rider, so a rider patch only matters through the line (kappa, line
 * deviation are not used either — the optimiser owns the line); machine and
 * tyre always do.
 */
function staleAfter(
  st: Pick<LabState, 'simOptStale' | 'simOptLapTimeS'>,
  patch: { machine?: object; tyre?: object; rider?: object },
): LabState['simOptStale'] {
  const touches = patch.machine !== undefined || patch.tyre !== undefined;
  return {
    freeTrajectory: st.simOptStale.freeTrajectory || (touches && st.simOptLapTimeS.freeTrajectory !== undefined),
    ocp: st.simOptStale.ocp || (touches && st.simOptLapTimeS.ocp !== undefined),
  };
}

/**
 * The lap "Fit to reference" fits to: the chosen one (`fitRefLap`), else the
 * reference lap when it can be one, else the first session with a corner
 * summary, else the best flying lap of the first recorded session with GPS.
 */
export function fitReferenceLap(
  st: Pick<LabState, 'sessions' | 'refLap' | 'fitRefLap'>,
  track: TrackModel | undefined,
): { session: Session; lap: Lap } | undefined {
  const find = (sel: { sessionId: string; lap: number } | undefined): { session: Session; lap: Lap } | undefined => {
    if (!sel) return undefined;
    const session = st.sessions.find((x) => x.id === sel.sessionId && !x.isSim);
    const lap = session?.laps.find((l) => l.n === sel.lap);
    return session && lap && !lapReferenceProblem(session, lap, track) ? { session, lap } : undefined;
  };
  const best = (session: Session): Lap | undefined =>
    session.laps.find((l) => l.isBest) ?? session.laps.find((l) => l.kind === 'flying') ?? session.laps[0];
  const chosen = find(st.fitRefLap) ?? find(st.refLap);
  if (chosen) return chosen;
  const withRef = st.sessions.find((x) => x.reference && x.laps.length);
  if (withRef) return { session: withRef, lap: best(withRef)! };
  for (const session of st.sessions) {
    if (session.isSim) continue;
    const lap = best(session);
    if (lap && !lapReferenceProblem(session, lap, track)) return { session, lap };
  }
  return undefined;
}

/** Ride the fitted model with the current corner settings: session, line, table. */
function rideFit(set: (partial: Partial<LabState>) => void, get: () => LabState): void {
  const st = get();
  const track = activeTrack(st);
  const model = st.fitModel;
  const settings = st.fitSettings;
  if (!track || !model || !settings || st.fitTrackId !== track.id) return;
  try {
    const applied = applyFit(track, model, settings);
    const session = fitSession(model, applied, SIM_FIT_SESSION_ID, SIM_FIT_COLOR);
    const ceil = lateralCeilingG(model.params);
    const summary: FitSummary = {
      refName: model.reference,
      lapTimeS: applied.env.lapTimeS,
      refLapTimeS: model.refLapTimeS,
      // the reference speed on the line actually ridden (the tuned C↔V line)
      alignedRefLapS: refTimeOnLine(applied.line, model.vRefMs),
      ceilingG: ceil,
      ceilingLeanDeg: (Math.atan(ceil) * 180) / Math.PI,
      rows: fitRows(model, applied.line, applied.env, ceil),
      notes: model.notes,
      stats: model.stats,
      pathTrusted: model.pathTrusted,
    };
    const others = st.sessions.filter((x) => x.id !== SIM_FIT_SESSION_ID);
    const next = { ...st, sessions: [...others, session] };
    const selectedLaps = st.selectedLaps.some((l) => l.sessionId === SIM_FIT_SESSION_ID)
      ? st.selectedLaps
      : [...st.selectedLaps, { sessionId: SIM_FIT_SESSION_ID, lap: 1 }];
    set({ sessions: refreshAll(next), selectedLaps, simFit: summary, fitLine: applied.line });
  } catch (e) {
    set({ statusMessage: `Fit: ${(e as Error).message}` });
  }
}

/**
 * Run the simulator and put its session in the workspace, replacing any previous
 * one. The sim session is an ordinary Session, so it goes through refreshAll()
 * and picks up derived channels, math channels and delta_t like a loaded file.
 */
function runSim(
  set: (partial: Partial<LabState>) => void,
  get: () => LabState,
): void {
  const st = get();
  const track = activeTrack(st);
  if (!track) {
    set({ statusMessage: 'The simulator needs a track — open a session first.' });
    return;
  }
  // RIDER mode only: this runs on every slider patch, so it must never touch
  // the optimal solvers (plan Review Focus #5) — those are `runOptimal`.
  const { session, line, lapTimeS, corners, envelope } = simulate(
    track,
    st.corridor,
    st.simParams,
    SIM_SESSION_ID,
    'Virtual rider',
    SIM_COLOR,
    'rider',
  );
  const others = st.sessions.filter((s) => s.id !== SIM_SESSION_ID);
  const next = { ...st, sessions: [...others, session] };
  const selectedLaps = st.selectedLaps.some((l) => l.sessionId === SIM_SESSION_ID)
    ? st.selectedLaps
    : [...st.selectedLaps, { sessionId: SIM_SESSION_ID, lap: 1 }];
  set({
    sessions: refreshAll(next),
    selectedLaps,
    simLine: line,
    simLapTimeS: lapTimeS,
    simCorners: corners,
    simRisk: gripRiskMessage(envelope.gripUse, envelope.gripUsePeak),
  });
}

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
