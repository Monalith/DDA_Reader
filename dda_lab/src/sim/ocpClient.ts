// Client for the full minimum-time OCP on the DDA Lab bridge (spec v2 §2.10).
//
// The OCP runs server side (`POST /ocp/jobs`, `GET /ocp/jobs/{id}`, CasADi +
// IPOPT, minutes on the droplet). This module builds the job body from the
// browser's own track/corridor/params, polls, and turns the result into the
// same `Line` + `Envelope` pair the rider mode produces, so the OCP lap can be
// packaged by `toSession` like any other.
//
// Network access is always through an injected `fetchImpl` (default: global
// `fetch`), so the unit tests never reach the network (vitest runs in node).
import type { LngLat, TrackModel } from '../core/types';
import { corridorKey } from './corridorCache';
import { LOCAL_BRIDGE } from './corridorService';
import { lineFromOffsets, offsetBounds } from './line';
import type { Corridor, Envelope, Line, MachineParams, SimParams, TyreTrackParams } from './types';

const G = 9.81;
/** Below this a speed is not real; keeps the time integral finite. */
const V_MIN = 0.5;

export interface OcpJobRequest {
  key: string;
  centerline: LngLat[];
  /** Line box, metres left of the centerline (bike half width and kerb margin already applied). */
  leftM: number[];
  /** Line box, metres right of the centerline, positive. */
  rightM: number[];
  machine: MachineParams;
  tyre: TyreTrackParams;
}

export interface OcpResult {
  /** Lateral offset from the centerline at every centerline vertex, metres, left positive. */
  offsetsM: number[];
  /** Speed at every centerline vertex, m/s. */
  vMs: number[];
  lapTimeS: number;
}

export type OcpStatus = 'queued' | 'running' | 'done' | 'error';

export interface OcpPoll {
  status: OcpStatus;
  progress?: number;
  result?: OcpResult;
  message?: string;
}

export interface OcpSubmitOpts {
  /** The corridor-store write token (`X-Corridor-Token`); the bridge refuses POSTs without it. */
  token?: string;
}

/**
 * ALWAYS the local bridge (owner decision 2026-10-11): the server only serves
 * the app, the OCP solve runs on the computer that asked for it — every user
 * runs the DDA Lab bridge (the desktop build) locally. Corridors are
 * different: they are shared data and keep `corridorBase()`.
 */
export function ocpBase(): string {
  return LOCAL_BRIDGE;
}

function defaultFetch(): typeof fetch {
  return (...args: Parameters<typeof fetch>) => fetch(...args);
}

/**
 * The job body for this track. The widths are the SAME box the browser's line
 * generators use (`offsetBounds`: half a bike inside the edge, plus the kerb
 * margin), so the OCP line and the rider/free-trajectory lines are comparable.
 */
export function buildOcpRequest(track: TrackModel, corridor: Corridor | undefined, params: SimParams): OcpJobRequest {
  const { loM, hiM } = offsetBounds(track, corridor, params);
  const n = track.centerline.length;
  const leftM = new Array<number>(n);
  const rightM = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    leftM[i] = Math.max(0, hiM[i]);
    rightM[i] = Math.max(0, -loM[i]);
  }
  return {
    key: corridorKey(track),
    centerline: track.centerline.map((p) => [p[0], p[1]] as LngLat),
    leftM,
    rightM,
    machine: params.machine,
    tyre: params.tyre,
  };
}

/** Queue a job. Resolves to its id; rejects with a readable message when the bridge says no. */
export async function submitOcp(
  req: OcpJobRequest,
  fetchImpl: typeof fetch = defaultFetch(),
  opts: OcpSubmitOpts = {},
): Promise<{ id: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['X-Corridor-Token'] = opts.token;
  const res = await fetchImpl(`${ocpBase()}/ocp/jobs`, {
    method: 'POST',
    headers,
    body: JSON.stringify(req),
  });
  if (res.status === 401) throw new Error('OCP: the bridge rejected the token (X-Corridor-Token)');
  if (res.status === 503) {
    let err: unknown;
    try {
      err = ((await res.json()) as { error?: unknown })?.error;
    } catch {
      err = undefined;
    }
    throw new Error(
      err === 'ocp_unavailable'
        ? 'OCP: the full OCP service is not installed on this host (deploy_lab.sh --with-ocp)'
        : 'OCP: the bridge is read-only (no DDA_CORRIDOR_TOKEN on the host)',
    );
  }
  if (res.status === 429) throw new Error('OCP: the server is busy (job queue full), try again later');
  if (res.status === 413) throw new Error('OCP: track too large for the server');
  if (res.status === 422) throw new Error('OCP: the bridge rejected the job body');
  if (!res.ok) throw new Error(`OCP: submit failed (HTTP ${res.status})`);
  const body = (await res.json()) as { id?: unknown };
  if (typeof body?.id !== 'string' || !body.id) throw new Error('OCP: the bridge did not return a job id');
  return { id: body.id };
}

function finiteArray(a: unknown): a is number[] {
  return Array.isArray(a) && a.every((x) => typeof x === 'number' && Number.isFinite(x));
}

function parseResult(r: unknown): OcpResult | null {
  if (!r || typeof r !== 'object') return null;
  const o = r as Record<string, unknown>;
  if (!finiteArray(o.offsetsM) || !finiteArray(o.vMs)) return null;
  if (o.offsetsM.length !== o.vMs.length || o.vMs.length < 2) return null;
  if (typeof o.lapTimeS !== 'number' || !Number.isFinite(o.lapTimeS) || o.lapTimeS <= 0) return null;
  return { offsetsM: o.offsetsM, vMs: o.vMs, lapTimeS: o.lapTimeS };
}

/** One status read. Never throws: network failures and malformed replies come back as `error`. */
export async function pollOcp(id: string, fetchImpl: typeof fetch = defaultFetch()): Promise<OcpPoll> {
  let res: Response;
  try {
    res = await fetchImpl(`${ocpBase()}/ocp/jobs/${encodeURIComponent(id)}`, { method: 'GET' });
  } catch (e) {
    return { status: 'error', message: `OCP: bridge unreachable (${(e as Error).message})` };
  }
  if (res.status === 404) return { status: 'error', message: 'OCP: job not found (expired or bridge restarted)' };
  if (!res.ok) return { status: 'error', message: `OCP: poll failed (HTTP ${res.status})` };
  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    return { status: 'error', message: 'OCP: malformed reply' };
  }
  const progress = typeof body.progress === 'number' && Number.isFinite(body.progress) ? body.progress : undefined;
  switch (body.status) {
    case 'queued':
    case 'running':
      return progress === undefined ? { status: body.status } : { status: body.status, progress };
    case 'done': {
      const result = parseResult(body.result);
      if (!result) return { status: 'error', message: 'OCP: malformed result' };
      return progress === undefined ? { status: 'done', result } : { status: 'done', progress, result };
    }
    case 'error':
      return { status: 'error', message: typeof body.message === 'string' ? body.message : 'OCP: job failed' };
    default:
      return { status: 'error', message: `OCP: unknown status ${String(body.status)}` };
  }
}

export interface OcpWaitOpts {
  fetchImpl?: typeof fetch;
  /** Poll interval, ms (default 2000). */
  intervalMs?: number;
  /** Injected for tests; default `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (frac: number, status: OcpStatus) => void;
  shouldCancel?: () => boolean;
}

/** Poll until the job finishes. Resolves with the result; rejects on error or cancellation. */
export async function waitForOcp(id: string, opts: OcpWaitOpts = {}): Promise<OcpResult> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const interval = opts.intervalMs ?? 2000;
  for (;;) {
    if (opts.shouldCancel?.()) throw new Error('OCP: cancelled');
    const p = await pollOcp(id, opts.fetchImpl);
    if (p.status === 'done' && p.result) return p.result;
    if (p.status === 'error') throw new Error(p.message ?? 'OCP: job failed');
    opts.onProgress?.(p.progress ?? 0, p.status);
    await sleep(interval);
  }
}

/**
 * Envelope for a given speed profile along `line` (the optimal modes produce v
 * directly, so there is no QSS to run): longG from v·dv/ds, latG = v²κ/g,
 * lean with tan(lean) = −latG (app convention, left negative), tS by the
 * trapezoid rule. `gripUse`/`gripUsePeak` are the combined g over `mu`
 * (the ideal rider has no allowed-slip margin, so the two are equal).
 */
export function envelopeFromSpeed(line: Line, vMs: Float32Array, mu = 1): Envelope {
  const n = line.points.length;
  const v = new Float32Array(n);
  for (let i = 0; i < n; i++) v[i] = Math.max(V_MIN, Number.isFinite(vMs[i]) ? vMs[i] : V_MIN);
  const segAfter = (i: number): number =>
    Math.max(1e-3, i === n - 1 ? line.lengthM - line.cumDistM[n - 1] : line.cumDistM[i + 1] - line.cumDistM[i]);

  const longG = new Float32Array(n);
  const latG = new Float32Array(n);
  const leanDeg = new Float32Array(n);
  const gripUse = new Float32Array(n);
  const tS = new Float64Array(n);
  const muSafe = mu > 0 ? mu : 1;
  for (let i = 0; i < n; i++) {
    const ip = (i - 1 + n) % n;
    const inx = (i + 1) % n;
    const ds = segAfter(ip) + segAfter(i);
    const dvds = (v[inx] - v[ip]) / ds;
    longG[i] = (v[i] * dvds) / G;
    latG[i] = (v[i] * v[i] * line.curvature[i]) / G;
    leanDeg[i] = (-Math.atan(latG[i]) * 180) / Math.PI;
    gripUse[i] = Math.hypot(longG[i], latG[i]) / muSafe;
  }
  for (let i = 1; i < n; i++) tS[i] = tS[i - 1] + (2 * segAfter(i - 1)) / (v[i - 1] + v[i]);
  const lapTimeS = tS[n - 1] + (2 * segAfter(n - 1)) / (v[n - 1] + v[0]);
  return { v, longG, latG, leanDeg, gripUse, gripUsePeak: Float32Array.from(gripUse), tS, lapTimeS };
}

/** OCP result → the `Line` (from the offsets) and its `Envelope` (from the speeds). */
export function ocpResultToLine(
  track: TrackModel,
  result: OcpResult,
  params: SimParams,
): { line: Line; envelope: Envelope } {
  const n = track.centerline.length;
  if (result.offsetsM.length !== n || result.vMs.length !== n) {
    throw new Error(`OCP: result has ${result.offsetsM.length} points, the centerline has ${n}`);
  }
  const line = lineFromOffsets(track, Float32Array.from(result.offsetsM));
  const mu = params.tyre.mu * params.tyre.gripScale;
  const envelope = envelopeFromSpeed(line, Float32Array.from(result.vMs), mu);
  return { line, envelope };
}
