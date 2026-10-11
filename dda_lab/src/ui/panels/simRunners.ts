// Browser-side runners for the two optimal solver modes (spec v2 §2.10).
//
// The store takes a runner by injection (`runOptimal(mode, runner)`) so its
// tests need no Worker and no network. This module is the one place the panel
// gets the real ones from.
//
// MERGE: wire `freeTrajectory` to W2's `freeTrajectory.worker.ts` (create the
// worker once, post `run`, map `progress`/`done`/`error`, post `cancel` on a
// new request; check `optCache` first) and `ocp` to W5's
// `submitOcp`/`pollOcp` (return `{ offsetsM, vMs, lapTimeS }`), and make
// `optimalAvailability('ocp')` probe the bridge. Until then both modes report
// themselves unavailable and the panel greys the "Hesapla" button.
import type { OptimalMode, OptimalRunner } from '../../state/store';

export interface Availability {
  ok: boolean;
  /** Tooltip when not ok. */
  reason?: string;
}

export function optimalRunner(_mode: OptimalMode): OptimalRunner | null {
  return null;
}

export async function optimalAvailability(mode: OptimalMode): Promise<Availability> {
  return {
    ok: false,
    reason:
      mode === 'ocp'
        ? 'Full OCP needs the lab bridge, which is not reachable from this build.'
        : 'The free-trajectory optimiser is not available in this build yet.',
  };
}
