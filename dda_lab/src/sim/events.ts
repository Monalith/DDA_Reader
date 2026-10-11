// STUB (W6) — replaced by W1/W2/W3/W5 at merge
//
// Contract-only placeholder for W3's corner-event template. Returns the QSS
// envelope's own speed and time with zero brake/throttle, so the rider mode
// reproduces the v1 lap until the real file lands.
import type { Corner, Envelope, Line, SimParams } from './types';

export interface EventProfile {
  v: Float32Array;
  /** 0..100 */
  brake: Float32Array;
  /** 0..100 */
  tps: Float32Array;
  tS: Float64Array;
  lapTimeS: number;
  corners: Corner[];
}

export interface EventCaps {
  brakeCapMs2(i: number, vMs: number): number;
  driveCapMs2(i: number, vMs: number): number;
  lossDecelMs2(vMs: number): number;
}

export function eventProfile(
  line: Line,
  env: Envelope,
  corners: Corner[],
  _params: SimParams,
  _caps: EventCaps,
): EventProfile {
  const n = line.points.length;
  return {
    v: Float32Array.from(env.v),
    brake: new Float32Array(n),
    tps: new Float32Array(n),
    tS: Float64Array.from(env.tS),
    lapTimeS: env.lapTimeS,
    corners,
  };
}
