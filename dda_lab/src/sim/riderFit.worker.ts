// Browser-only Web Worker around `fitRiderToLap` (riderFit.ts): "Fit to lap"
// runs up to ~25 s, off the main thread. Not imported by any test.
//
//   in : { type:'fit', id, track, corridor, params, lapRef, budgetMs }
//   out: { type:'progress', id, frac, stage, error? } | { type:'done', id, result } | { type:'error', id, message }
//
// `result` is a RiderFitResult (plain data: typed arrays and numbers). The fit
// is synchronous inside the worker; a newer request terminates this worker
// instead of cancelling it.
import type { TrackModel } from '../core/types';
import type { LapReference } from './lapReference';
import { fitRiderToLap } from './riderFit';
import type { Corridor, SimParams } from './types';

interface FitMsg {
  type: 'fit';
  id: number;
  track: TrackModel;
  corridor: Corridor | undefined;
  params: SimParams;
  lapRef: LapReference;
  budgetMs?: number;
}

self.onmessage = (e: MessageEvent<FitMsg>): void => {
  const m = e.data;
  if (m.type !== 'fit') return;
  try {
    let last = 0;
    const result = fitRiderToLap(m.track, m.corridor, m.params, m.lapRef, {
      budgetMs: m.budgetMs ?? 25_000,
      onProgress: (p) => {
        const t = Date.now();
        if (p.frac < 1 && t - last < 150) return;
        last = t;
        self.postMessage({ type: 'progress', id: m.id, ...p });
      },
    });
    self.postMessage({ type: 'done', id: m.id, result });
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: (err as Error).message });
  }
};
