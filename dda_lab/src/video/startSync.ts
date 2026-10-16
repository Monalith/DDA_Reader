// Start-line sync (pure; unit-tested in tests/unit/videoStartSync.test.ts).
//
// The user marks the video frame where the bike crosses the start line (🏁). The data is
// then aligned so that the chosen lap's start sample (its start/finish gate crossing) shows
// at exactly that frame:  video_time(lap.startIdx) = session.t[lap.startIdx] − offsetS = startVideoS.

import type { Lap, Session } from '../core/types';
import { roundOffset, type VideoSync } from './sync';

export interface StartLapOptions {
  /** Explicit lap number (wins when it exists in the session). */
  lapN?: number;
  /** The workspace reference lap; used only when it belongs to this session. */
  refLap?: { sessionId: string; lap: number };
  /** Current offset; with it the lap whose start is nearest to the start line is chosen. */
  currentOffsetS?: number;
  /** Video time (s) of the start line. */
  startVideoS: number;
}

function validLap(session: Session, l: Lap | undefined): l is Lap {
  return !!l && Number.isInteger(l.startIdx) && l.startIdx >= 0 && l.startIdx < session.t.length && Number.isFinite(session.t[l.startIdx]);
}

/**
 * Lap whose start the video start line marks. Priority: explicit lapN → reference lap of
 * this session → lap whose start (under the current offset) is nearest to the start line →
 * best lap → first flying lap → first lap.
 */
export function pickStartLap(session: Session, opts: StartLapOptions): Lap | undefined {
  const laps = session.laps.filter((l) => validLap(session, l));
  if (!laps.length) return undefined;
  if (opts.lapN != null) {
    const l = laps.find((x) => x.n === opts.lapN);
    if (l) return l;
  }
  if (opts.refLap && opts.refLap.sessionId === session.id) {
    const l = laps.find((x) => x.n === opts.refLap!.lap);
    if (l) return l;
  }
  if (opts.currentOffsetS != null && Number.isFinite(opts.currentOffsetS) && Number.isFinite(opts.startVideoS)) {
    let best: Lap | undefined;
    let bestD = Infinity;
    for (const l of laps) {
      const d = Math.abs(session.t[l.startIdx] - opts.currentOffsetS - opts.startVideoS);
      if (d < bestD) {
        bestD = d;
        best = l;
      }
    }
    if (best) return best;
  }
  return laps.find((l) => l.isBest) ?? laps.find((l) => l.kind === 'flying') ?? laps[0];
}

/** Offset that puts the lap's start sample at video time startVideoS. */
export function offsetForStartLine(session: Session, lap: Lap, startVideoS: number): number {
  return roundOffset(session.t[lap.startIdx] - startVideoS);
}

/** Sync re-aligned to the start line, with the lap used; null without a usable lap. */
export function applyStartLine(
  sync: VideoSync,
  session: Session,
  startVideoS: number,
  lapN?: number,
  refLap?: { sessionId: string; lap: number },
): { sync: VideoSync; lap: Lap } | null {
  if (!Number.isFinite(startVideoS)) return null;
  const lap = pickStartLap(session, { lapN, refLap, currentOffsetS: sync.offsetS, startVideoS });
  if (!lap) return null;
  const offsetS = offsetForStartLine(session, lap, startVideoS);
  if (!Number.isFinite(offsetS)) return null;
  return { sync: { ...sync, sessionId: session.id, offsetS, startVideoS }, lap };
}
