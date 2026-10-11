// Browser-side runners for the two optimal solver modes (spec v2 §2.10).
//
// The store takes a runner by injection (`runOptimal(mode, runner)`) so its
// tests need no Worker and no network. This module is the one place the panel
// gets the real ones from:
//
//   freeTrajectory — W2's `freeTrajectory.worker.ts`, one Worker for the page,
//                    a newer request cancels the running one, results cached
//                    by corridor key + machine/tyre (`optCache`);
//   ocp            — W5's bridge job (`submitOcp` + `waitForOcp`), POST needs
//                    the corridor write token the panel already holds.
import { useLab, type OptimalMode, type OptimalRunner } from '../../state/store';
import { idealParams } from '../../sim/freeTrajectory';
import { lineFromOffsets } from '../../sim/line';
import { buildOcpRequest, ocpBase, submitOcp, waitForOcp } from '../../sim/ocpClient';
import { optCacheKey, readOpt, writeOpt, type KVStorage } from '../../sim/optCache';
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

type WorkerOut =
  | { type: 'progress'; id: number; frac: number; lapTimeS: number }
  | { type: 'done'; id: number; offsetsM: Float32Array; lapTimeS: number }
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
    if (id > 1) w.postMessage({ type: 'cancel', id: id - 1 });
    const onMessage = (e: MessageEvent<WorkerOut>): void => {
      const m = e.data;
      if (!m || m.id !== id) return;
      if (m.type === 'progress') {
        onProgress(m.frac, m.lapTimeS);
      } else if (m.type === 'done') {
        w.removeEventListener('message', onMessage);
        writeOpt(key, m.offsetsM, m.lapTimeS, storage);
        resolve({ offsetsM: m.offsetsM, lapTimeS: m.lapTimeS });
      } else if (m.type === 'error') {
        w.removeEventListener('message', onMessage);
        reject(new Error(m.message));
      }
    };
    w.addEventListener('message', onMessage);
    w.postMessage({ type: 'run', id, track, corridor, params, iterations: FREE_TRAJ_ITERATIONS });
  });

const ocpRunner: OptimalRunner = async (track, corridor, params, onProgress) => {
  const token = useLab.getState().corridorToken;
  const { id } = await submitOcp(buildOcpRequest(track, corridor, params), undefined, { token: token || undefined });
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
  // ocp: the bridge answers 404 for an unknown job when the service is up,
  // 503 (`ocp_unavailable`) when deployed without --with-ocp, and the fetch
  // itself fails when there is no bridge at all
  try {
    const res = await fetch(`${ocpBase()}/ocp/jobs/availability-probe`, { method: 'GET' });
    if (res.status === 404) return { ok: true };
    if (res.status === 503) return { ok: false, reason: 'The lab bridge is up but was deployed without the OCP service (deploy_lab.sh --with-ocp).' };
    return { ok: false, reason: `The lab bridge answered ${res.status} to the OCP probe.` };
  } catch {
    return { ok: false, reason: 'Full OCP needs the lab bridge, which is not reachable from this page.' };
  }
}
