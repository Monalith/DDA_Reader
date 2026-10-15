// Store-aware glue between the lab cursor and the synced video session.
import type { Lap, Session, Workspace } from '../core/types';
import { cursorIdxFromX, findLap, lapX, xFromIdx } from '../state/selectors';
import type { CursorPos, LapRef } from '../state/store';
import { lapAtIdx, xRangeToIdxRange } from './sync';

interface FollowState {
  sessions: Session[];
  selectedLaps: LapRef[];
  workspace: Pick<Workspace, 'xAxis'>;
}

/** The synced session's lap shown in the workspace (first selected), if any. */
export function syncedWorkspaceLap(st: FollowState, syncSessionId: string): Lap | undefined {
  const s = st.sessions.find((x) => x.id === syncSessionId);
  if (!s) return undefined;
  for (const r of st.selectedLaps) if (r.sessionId === syncSessionId) return findLap(s, r.lap);
  return undefined;
}

/**
 * Sample of the synced session that a cursor points at. A cursor on another run (the
 * charts publish the first plotted lap) is carried over at the same lap distance / lap
 * time onto the synced session's lap in the workspace. Null when there is no such lap.
 */
export function syncIdxForCursor(st: FollowState, cursor: CursorPos | null, syncSessionId: string): number | null {
  if (!cursor) return null;
  const ss = st.sessions.find((x) => x.id === syncSessionId);
  if (!ss) return null;
  if (cursor.sessionId === syncSessionId) return Math.max(0, Math.min(ss.t.length - 1, cursor.idx));
  const cs = st.sessions.find((x) => x.id === cursor.sessionId);
  if (!cs) return null;
  const hit = xFromIdx(cs, cursor.idx, st.workspace.xAxis);
  if (!hit) return null;
  const lap = syncedWorkspaceLap(st, syncSessionId);
  if (!lap) return null;
  return cursorIdxFromX(ss, lap, hit.x, st.workspace.xAxis);
}

/** Sample range of the chart zoom (xRange) inside the lap holding `idx`. */
export function xRangeIdxRange(s: Session, idx: number, xRange: [number, number], xAxis: Workspace['xAxis']): [number, number] | null {
  const lap = lapAtIdx(s.laps, idx) ?? s.laps[0];
  if (!lap) return null;
  return xRangeToIdxRange(lapX(s, lap, xAxis), lap.startIdx, xRange);
}
