// Browser-only Web Worker around the pure free-trajectory optimiser. Not
// imported by any test (vitest runs in node without Worker). Load with
//   new Worker(new URL('./freeTrajectory.worker.ts', import.meta.url), { type: 'module' })
//
// Protocol (plan "Shared interface contract"):
//   in : { type:'run', id, track, corridor, params, iterations } | { type:'cancel', id }
//   out: { type:'progress', id, frac, lapTimeS } | { type:'done', id, offsetsM, lapTimeS } | { type:'error', id, message }
//
// One iteration runs per macrotask, so a 'cancel' (or a newer 'run', which
// supersedes the current one) is seen within one iteration (~0.2 s on a
// 1.5k-sample track). A cancelled run posts nothing further.
import type { TrackModel } from '../core/types';
import { createOptimiser } from './freeTrajectory';
import type { Corridor, SimParams } from './types';

type InMsg =
  | { type: 'run'; id: number | string; track: TrackModel; corridor: Corridor | undefined; params: SimParams; iterations: number }
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
  try {
    const opt = createOptimiser(msg.track, msg.corridor, msg.params);
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
