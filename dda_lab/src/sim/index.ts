// The virtual rider's single entry point.
//
// EXTENSION SEAM: solve() and riderChannels() sit behind this call. A
// time-domain dynamic solver (load transfer, tyre slip, preview controller) can
// replace both without touching the line generator, the corridor extractor,
// toSession, the store or the UI.
import type { Session, TrackModel } from '../core/types';
import { buildLine } from './line';
import { clampParams } from './presets';
import { riderChannels } from './rider';
import { solve } from './solver';
import { toSession } from './toSession';
import type { Corridor, Line, SimParams } from './types';

export interface SimResult {
  session: Session;
  line: Line;
  lapTimeS: number;
}

export function simulate(
  track: TrackModel,
  corridor: Corridor | undefined,
  params: SimParams,
  id: string,
  name: string,
  color: string,
): SimResult {
  const p = clampParams(params);
  const line = buildLine(track, corridor, p);
  const env = solve(line, p);
  const ch = riderChannels(line, env, p);
  return { session: toSession(line, env, ch, p, id, name, color), line, lapTimeS: env.lapTimeS };
}

export { buildLine } from './line';
export { solve, topSpeedMs } from './solver';
export { riderChannels } from './rider';
export * from './types';
