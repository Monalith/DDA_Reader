// Browser-only Web Worker around `buildFitModel` (fitModel.ts): the per-corner
// fit runs up to ~30 s, off the main thread. Not imported by any test.
//
//   in : { type:'fit', id, track, corridor, params, lapRef, budgetMs }
//   out: { type:'progress', id, frac, stage, error? } | { type:'done', id, model } | { type:'error', id, message }
//
// The fit is synchronous inside the worker; a newer request terminates this
// worker (fitRunner in ui/panels/simRunners.ts) instead of cancelling it.
import type { TrackModel } from '../core/types';
import { buildFitModel } from './fitModel';
import type { LapReference } from './lapReference';
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
    const model = buildFitModel(m.track, m.corridor, m.params, m.lapRef, {
      budgetMs: m.budgetMs,
      onProgress: (p) => {
        const t = Date.now();
        if (p.frac < 1 && t - last < 150) return;
        last = t;
        self.postMessage({ type: 'progress', id: m.id, ...p });
      },
    });
    self.postMessage({ type: 'done', id: m.id, model });
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: (err as Error).message });
  }
};
