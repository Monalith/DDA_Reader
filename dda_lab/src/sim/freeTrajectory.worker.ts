// Browser-only Web Worker around the pure free-trajectory optimiser. Not
// imported by any test (vitest runs in node without Worker). Load with
//   new Worker(new URL('./freeTrajectory.worker.ts', import.meta.url), { type: 'module' })
//
// Protocol (plan "Shared interface contract"):
//   in : { type:'run', id, track, corridor, params, iterations, init?, rider? } | { type:'cancel', id }
//        (init/rider: `FreeTrajStart`; `lapTimeStart: true` computes the
//        'lap-time' line's warm start here, off the main thread;
//        `lapTimeRun: {...}` runs the multi-start / lateral-g-penalty
//        'lap-time' line instead (lapTimeLine.ts `createLapTimeRun`, note §9):
//        warm starts as offsets, the reference lap for the penalty)
//   out: { type:'progress', id, frac, lapTimeS, start?, starts?, label? } | { type:'done', id, offsetsM, lapTimeS, info? } | { type:'error', id, message }
//
// One iteration runs per macrotask, so a 'cancel' (or a newer 'run', which
// supersedes the current one) is seen within one iteration (~0.2 s on a
// 1.5k-sample track). A cancelled run posts nothing further.
import type { TrackModel } from '../core/types';
import { createOptimiser } from './freeTrajectory';
import { createLapTimeRun, lapTimeStart, type LapTimeRunOpts } from './lapTimeLine';
import { lineFromOffsets } from './line';
import type { Reference } from './reference';
import type { Corridor, SimParams } from './types';

/** `lapTimeRun` options as they cross the worker boundary (lines as offsets). */
export interface LapTimeRunMsg {
  warmStartOffsets?: Float32Array[];
  minTimeStart?: boolean;
  reference?: Reference;
  latGPenalty?: number;
  knotSpacingM?: number;
  budgetMs?: number;
}

type InMsg =
  | {
      type: 'run';
      id: number | string;
      track: TrackModel;
      corridor: Corridor | undefined;
      params: SimParams;
      iterations: number;
      init?: Float32Array;
      rider?: 'ideal' | 'own';
      lapTimeStart?: boolean;
      lapTimeRun?: LapTimeRunMsg;
    }
  | { type: 'cancel'; id: number | string };

let current: number | string | null = null;
const post = (msg: unknown, transfer: Transferable[] = []): void => self.postMessage(msg, { transfer });

self.onmessage = (e: MessageEvent<InMsg>): void => {
  const msg = e.data;
  if (msg.type === 'cancel') {
    if (current === msg.id) current = null;
    return;
  }
  if (msg.type !== 'run') return;
  const { id } = msg;
  current = id;
  const live = (): boolean => current === id;
  if (msg.lapTimeRun) return runLapTime(msg.track, msg.corridor, msg.params, msg.lapTimeRun, id, live);
  try {
    const init = msg.lapTimeStart ? lapTimeStart(msg.track, msg.corridor, msg.params) : msg.init;
    const opt = createOptimiser(msg.track, msg.corridor, msg.params, { init, rider: msg.rider });
    const total = Math.max(0, Math.floor(msg.iterations));
    let done = 0;
    post({ type: 'progress', id, frac: 0, lapTimeS: opt.lapTimeS });
    const finish = (): void => {
      const offsetsM = Float32Array.from(opt.offsetsM);
      post({ type: 'done', id, offsetsM, lapTimeS: opt.lapTimeS }, [offsetsM.buffer]);
      if (live()) current = null;
    };
    const step = (): void => {
      if (!live()) return;
      try {
        if (done >= total || opt.converged) return finish();
        opt.iterate(() => !live());
        done++;
        post({ type: 'progress', id, frac: opt.converged ? 1 : done / total, lapTimeS: opt.lapTimeS });
        setTimeout(step, 0);
      } catch (err) {
        post({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
      }
    };
    setTimeout(step, 0);
  } catch (err) {
    post({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
  }
};

/** The multi-start 'lap-time' run, one sweep per macrotask. */
function runLapTime(
  track: TrackModel,
  corridor: Corridor | undefined,
  params: SimParams,
  m: LapTimeRunMsg,
  id: number | string,
  live: () => boolean,
): void {
  try {
    const opts: LapTimeRunOpts = {
      warmStarts: (m.warmStartOffsets ?? []).map((o) => lineFromOffsets(track, o)),
      minTimeStart: m.minTimeStart,
      reference: m.reference,
      latGPenalty: m.latGPenalty,
      knotSpacingM: m.knotSpacingM,
      budgetMs: m.budgetMs,
    };
    const run = createLapTimeRun(track, corridor, params, opts);
    const prog = (): void => {
      const p = run.progress;
      post({ type: 'progress', id, frac: p.frac, lapTimeS: p.lapTimeS, start: p.start, starts: p.starts, label: p.labels[p.start - 1] });
    };
    prog();
    const step = (): void => {
      if (!live()) return;
      try {
        const more = run.step(() => !live());
        if (!live()) return;
        if (more) {
          prog();
          setTimeout(step, 0);
          return;
        }
        const r = run.result();
        const offsetsM = Float32Array.from(r.offsetsM);
        const info = {
          kept: r.starts[r.best].label,
          ms: r.ms,
          outOfBudget: r.outOfBudget,
          starts: r.starts.map((s) => ({ label: s.label, lapTimeS: s.lapTimeS, objective: s.objective, sweeps: s.sweeps, converged: s.converged, ms: s.ms })),
        };
        post({ type: 'done', id, offsetsM, lapTimeS: r.lapTimeS, info }, [offsetsM.buffer]);
        current = null;
      } catch (err) {
        post({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
      }
    };
    setTimeout(step, 0);
  } catch (err) {
    post({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
  }
}
