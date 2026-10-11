// Browser-side runners for the two optimal solver modes (spec v2 §2.10).
//
// The store takes a runner by injection (`runOptimal(mode, runner)`) so its
// tests need no Worker and no network. This module is the one place the panel
// gets the real ones from:
//
//   freeTrajectory — W2's `freeTrajectory.worker.ts`, one Worker for the page,
//                    a newer request cancels the running one, results cached
//                    by corridor key + machine/tyre (`optCache`);
//   ocp            — the LOCAL bridge's job (`submitOcp` + `waitForOcp`): the
//                    solve runs on this computer (owner decision 2026-10-11),
//                    so the user must be running the DDA Lab bridge locally.
import type { OptimalMode, OptimalRunner } from '../../state/store';
import { idealParams } from '../../sim/freeTrajectory';
import { lineFromOffsets } from '../../sim/line';
import { buildOcpRequest, ocpBase, submitOcp, waitForOcp } from '../../sim/ocpClient';
import { optCacheKey, readOpt, writeOpt, type KVStorage } from '../../sim/optCache';
import { cachedLapTimeLine, lapTimeVariant, rememberLapTimeLine } from '../../sim/lapTimeLine';
import { solve } from '../../sim/solver';

export interface Availability {
  ok: boolean;
  /** Tooltip when not ok. */
  reason?: string;
}

/** Iterations per free-trajectory run: converges in ~20-30 on the fixtures (W2). */
const FREE_TRAJ_ITERATIONS = 60;

function safeStorage(): KVStorage | undefined {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : undefined;
  } catch {
    return undefined;
  }
}

let worker: Worker | null = null;
let seq = 0;

function freeTrajWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('../../sim/freeTrajectory.worker.ts', import.meta.url), { type: 'module' });
  }
  return worker;
}

/**
 * The run a newer request cancels. A cancelled run posts nothing further, so
 * its promise is rejected here instead of hanging (the store's busy flag
 * would otherwise never clear).
 */
let pending: { id: number; reject: (e: Error) => void } | null = null;
function supersede(w: Worker, id: number, reject: (e: Error) => void): void {
  if (id > 1) w.postMessage({ type: 'cancel', id: id - 1 });
  pending?.reject(new Error('superseded by a newer optimiser run'));
  pending = { id, reject };
}

type WorkerOut =
  | { type: 'progress'; id: number; frac: number; lapTimeS: number; start?: number; starts?: number; label?: string }
  | { type: 'done'; id: number; offsetsM: Float32Array; lapTimeS: number; info?: { kept: string; ms: number; outOfBudget: boolean; starts?: Array<{ label: string; lapTimeS: number }> } }
  | { type: 'error'; id: number; message: string };

const freeTrajectoryRunner: OptimalRunner = (track, corridor, params, onProgress) =>
  new Promise((resolve, reject) => {
    const storage = safeStorage();
    const key = optCacheKey(track, params, 'freeTrajectory');
    const cached = readOpt(key, track.centerline.length, storage);
    if (cached) {
      const lapTimeS = solve(lineFromOffsets(track, cached), idealParams(params)).lapTimeS;
      onProgress(1, lapTimeS);
      resolve({ offsetsM: cached, lapTimeS });
      return;
    }
    const w = freeTrajWorker();
    const id = ++seq;
    // a newer request supersedes the running one (plan Review Focus #5)
    supersede(w, id, reject);
    const onMessage = (e: MessageEvent<WorkerOut>): void => {
      const m = e.data;
      if (!m || m.id !== id) return;
      if (m.type === 'progress') {
        onProgress(m.frac, m.lapTimeS);
      } else if (m.type === 'done') {
        w.removeEventListener('message', onMessage);
        if (pending?.id === id) pending = null;
        writeOpt(key, m.offsetsM, m.lapTimeS, storage);
        resolve({ offsetsM: m.offsetsM, lapTimeS: m.lapTimeS });
      } else if (m.type === 'error') {
        w.removeEventListener('message', onMessage);
        if (pending?.id === id) pending = null;
        reject(new Error(m.message));
      }
    };
    w.addEventListener('message', onMessage);
    w.postMessage({ type: 'run', id, track, corridor, params, iterations: FREE_TRAJ_ITERATIONS });
  });

/**
 * `lineMode: 'lap-time'` (pist-line note §8-9): the same worker, judged by the
 * rider's own QSS lap; multi-start — the fastest κ-line, plus the owner's GPS
 * path (`ctx.warmStarts`) when a recorded lap is loaded — keep the fastest; the
 * soft lateral-g ceiling on when a reference lap (`ctx.reference`) is loaded.
 * Cached per track + machine + tyre + rider + those starts/reference
 * (lapTimeLine.ts, memory + localStorage).
 */
export const lapTimeLineRunner: OptimalRunner = (track, corridor, params, onProgress, ctx) =>
  new Promise((resolve, reject) => {
    const storage = safeStorage();
    const warmStartOffsets = ctx?.warmStarts ?? [];
    const variant = lapTimeVariant({
      warmStarts: warmStartOffsets.map((o) => lineFromOffsets(track, o)),
      reference: ctx?.reference,
    });
    const cached = cachedLapTimeLine(track, params, storage, variant);
    if (cached) {
      const lapTimeS = solve(lineFromOffsets(track, cached), { ...params, rider: { ...params.rider, lineDeviationM: 0 } }).lapTimeS;
      onProgress(1, lapTimeS);
      resolve({ offsetsM: cached, lapTimeS });
      return;
    }
    const w = freeTrajWorker();
    const id = ++seq;
    supersede(w, id, reject);
    const onMessage = (e: MessageEvent<WorkerOut>): void => {
      const m = e.data;
      if (!m || m.id !== id) return;
      if (m.type === 'progress') {
        onProgress(m.frac, m.lapTimeS, m.start != null && m.starts != null ? { start: m.start, starts: m.starts, label: m.label ?? '' } : undefined);
      } else if (m.type === 'done') {
        w.removeEventListener('message', onMessage);
        if (pending?.id === id) pending = null;
        rememberLapTimeLine(track, params, m.offsetsM, m.lapTimeS, storage, variant);
        resolve({ offsetsM: m.offsetsM, lapTimeS: m.lapTimeS, info: m.info });
      } else if (m.type === 'error') {
        w.removeEventListener('message', onMessage);
        if (pending?.id === id) pending = null;
        reject(new Error(m.message));
      }
    };
    w.addEventListener('message', onMessage);
    w.postMessage({
      type: 'run',
      id,
      track,
      corridor,
      params,
      iterations: 0,
      lapTimeRun: { warmStartOffsets, reference: ctx?.reference },
    });
  });

const ocpRunner: OptimalRunner = async (track, corridor, params, onProgress) => {
  const { id } = await submitOcp(buildOcpRequest(track, corridor, params));
  const r = await waitForOcp(id, { onProgress: (frac) => onProgress(frac) });
  return { offsetsM: Float32Array.from(r.offsetsM), vMs: Float32Array.from(r.vMs), lapTimeS: r.lapTimeS };
};

export function optimalRunner(mode: OptimalMode): OptimalRunner | null {
  if (mode === 'freeTrajectory') return typeof Worker === 'undefined' ? null : freeTrajectoryRunner;
  if (mode === 'ocp') return typeof fetch === 'undefined' ? null : ocpRunner;
  return null;
}

export async function optimalAvailability(mode: OptimalMode): Promise<Availability> {
  if (mode === 'freeTrajectory') {
    return typeof Worker === 'undefined'
      ? { ok: false, reason: 'The free-trajectory optimiser needs Web Workers, which this browser does not provide.' }
      : { ok: true };
  }
  // ocp: the LOCAL bridge answers 404 for an unknown job when the service is
  // up, 503 (`ocp_unavailable`) when it runs without the ocp package, and the
  // fetch itself fails when no bridge is running on this computer
  try {
    const res = await fetch(`${ocpBase()}/ocp/jobs/availability-probe`, { method: 'GET' });
    if (res.status === 404) {
      // the OCP service answers {"error":"not_found"}; a bridge WITHOUT the
      // /ocp routes (older deploy) answers FastAPI's own {"detail":"Not Found"}
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return body?.error === 'not_found'
        ? { ok: true }
        : { ok: false, reason: 'The local DDA Lab bridge is an older build without the OCP solver.' };
    }
    if (res.status === 503) return { ok: false, reason: 'The local DDA Lab bridge is running without the OCP solver (ocp/ + casadi missing).' };
    return { ok: false, reason: `The lab bridge answered ${res.status} to the OCP probe.` };
  } catch {
    return { ok: false, reason: 'Full OCP runs on this computer: start the DDA Lab bridge (desktop app) on 127.0.0.1:8777 first.' };
  }
}
