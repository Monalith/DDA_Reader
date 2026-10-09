// Time spent in every turn, per lap, and the gain/loss against the best loaded lap in
// that turn ("how much did I win or lose in T3 compared with my best T3").
import { plausibleFlyingLaps } from './laps';
import type { Lap, Session, TrackModel } from './types';

/** Seconds between entering turn.sRange[0] and leaving turn.sRange[1] (NaN when not crossed). */
export function turnTimesForLap(s: Session, lap: Lap, track: TrackModel): number[] {
  const d = s.channels.get('lap_dist')?.data;
  const out = new Array<number>(track.turns.length).fill(NaN);
  if (!d) return out;
  // time at which the lap distance reaches `sM` (linear interpolation between samples)
  const timeAt = (sM: number): number => {
    let prev = -1;
    for (let i = lap.startIdx; i <= lap.endIdx && i < d.length; i++) {
      const x = d[i];
      if (!Number.isFinite(x)) continue;
      if (x >= sM) {
        if (prev < 0 || d[prev] === x) return s.t[i];
        const f = (sM - d[prev]) / (x - d[prev]);
        return s.t[prev] + f * (s.t[i] - s.t[prev]);
      }
      prev = i;
    }
    return NaN;
  };
  track.turns.forEach((turn, k) => {
    const [s0, s1] = turn.sRange;
    const tIn = timeAt(s0);
    const tOut = timeAt(s1);
    if (Number.isFinite(tIn) && Number.isFinite(tOut) && tOut > tIn) out[k] = tOut - tIn;
  });
  return out;
}

export interface BestTurnTimes {
  /** best (lowest) time per turn across the loaded laps, NaN when nobody crossed it */
  best: number[];
  /** who set it */
  who: ({ sessionId: string; lap: number } | null)[];
}

/** Best time per turn over every plausible flying lap of every loaded session. */
export function bestTurnTimes(sessions: Session[], track: TrackModel): BestTurnTimes {
  const n = track.turns.length;
  const best = new Array<number>(n).fill(NaN);
  const who = new Array<{ sessionId: string; lap: number } | null>(n).fill(null);
  for (const s of sessions) {
    for (const lap of plausibleFlyingLaps(s.laps)) {
      const tt = turnTimesForLap(s, lap, track);
      for (let k = 0; k < n; k++) {
        if (Number.isFinite(tt[k]) && (!Number.isFinite(best[k]) || tt[k] < best[k])) {
          best[k] = tt[k];
          who[k] = { sessionId: s.id, lap: lap.n };
        }
      }
    }
  }
  return { best, who };
}

/** Lap time in each turn minus the best: + = lost, − = gained (0 on the best lap itself). */
export function turnDeltas(s: Session, lap: Lap, track: TrackModel, best: BestTurnTimes): number[] {
  const tt = turnTimesForLap(s, lap, track);
  return tt.map((v, k) => (Number.isFinite(v) && Number.isFinite(best.best[k]) ? v - best.best[k] : NaN));
}

export function fmtTurnDelta(v: number): string {
  if (!Number.isFinite(v)) return '–';
  if (Math.abs(v) < 0.0005) return 'best';
  return `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}`;
}
