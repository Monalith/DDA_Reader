// The virtual rider's single entry point.
//
// EXTENSION SEAM: everything that turns a track into a lap sits behind this
// call, chosen by the SOLVER MODE (spec v2 §2.10):
//
//   rider           buildLine → solve (QSS upper bound) → findCorners →
//                   eventProfile → riderChannels → toSession. The human rider,
//                   live on every slider (< 50 ms).
//   freeTrajectory  the line comes from the optimiser's offsets (W2 worker),
//   ocp             or from the OCP's offsets and speed (W5 bridge). Both are
//                   the IDEAL rider (`idealParams`) and are only ever run from
//                   the "Hesapla" button, never from a slider (store.ts).
//
// The line generator, the corridor extractor, toSession, the store and the UI
// do not change with the mode.
import type { Session, TrackModel } from '../core/types';
import { findCorners } from './corners';
import { DERIVED_KEYS } from './derive';
import { eventProfile, type EventCaps, type EventProfile } from './events';
import { buildLine, lineFromOffsets } from './line';
import { clampParams } from './presets';
import { riderChannels } from './rider';
import { brakeCapMs2, driveCapMs2, G, lossDecelMs2, solve } from './solver';
import { toSession } from './toSession';
import type { Corner, Corridor, Envelope, Line, SimParams, SolverMode } from './types';

export interface SimResult {
  session: Session;
  line: Line;
  /** The envelope the session was packaged from (line-sampled; grip channels for the risk banner). */
  envelope: Envelope;
  lapTimeS: number;
  mode: SolverMode;
  /** Corner sections (rider mode only). */
  corners?: Corner[];
}

/** What an optimal solver hands back: offsets off the centerline, and optionally its own speed. */
export interface OptimalInput {
  /** One per centerline vertex, metres, left positive. */
  offsetsM: Float32Array;
  /** One per centerline vertex, m/s. Absent → the QSS envelope of the ideal rider on that line. */
  vMs?: Float32Array;
}

/** Floor on speed when integrating time, m/s (same as the solver's V_MIN). */
const V_MIN = 2;

/**
 * The IDEAL rider for the optimal modes: every allowed slip at the tyre's peak,
 * the full roll-rate bound, full lean, and braking at the tyre's longitudinal
 * peak. Machine and tyre are untouched. Every derived key is pinned so a later
 * `deriveRider` cannot pull the ideal rider back to the sliders.
 *
 * MERGE: W2's `optimiseOffsets` forces only s* and rollRateFrac; it should
 * call this so its lap time and `simulate(..., 'freeTrajectory')` agree.
 */
export function idealParams(params: SimParams): SimParams {
  const p = clampParams(params);
  return {
    machine: { ...p.machine },
    tyre: { ...p.tyre },
    rider: {
      ...p.rider,
      overrides: [...DERIVED_KEYS],
      sBrake: 1,
      sDrive: 1,
      sLat: 1,
      rollRateFrac: 1,
      leanUsage: 1,
      brakingG: (p.tyre.muX ?? p.tyre.mu) * p.tyre.gripScale,
      lineDeviationM: 0,
    },
  };
}

/**
 * Tyre force caps for the event template: exactly the per-sample caps the
 * solver's own passes use (load transfer, μ_eff ellipse, trail-brake taper,
 * roll-dependent stoppie/wheelie limits), WITHOUT drag — the template adds
 * `lossDecelMs2` itself.
 */
export function eventCaps(line: Line, params: SimParams): EventCaps {
  const p = clampParams(params);
  return {
    brakeCapMs2: (i, v) => brakeCapMs2(line, p, i, v),
    driveCapMs2: (i, v) => driveCapMs2(line, p, i, v),
    lossDecelMs2: (v) => lossDecelMs2(p.machine, v),
  };
}

/** Arc length of the segment ending at sample i (wrapping at the start line). */
function dsAt(line: Line, i: number): number {
  const n = line.points.length;
  const d = i === 0 ? line.lengthM - line.cumDistM[n - 1] : line.cumDistM[i] - line.cumDistM[i - 1];
  return Math.max(0.05, d);
}

/**
 * Envelope for a speed profile that did not come out of `solve()` on this
 * exact line: longG/latG from v and κ (same discretisation as the solver),
 * lean scaled from `base` so W1's crown/hang-off correction is kept, and the
 * grip channels taken from `base` (an upper bound: `v ≤ base.v` in rider mode).
 *
 * MERGE: W5 ships a public `envelopeFromSpeed(line, vMs)` in ocpClient.ts;
 * dedupe against this private copy.
 */
function envelopeFromSpeed(line: Line, v: Float32Array, base: Envelope, tS?: Float64Array, lapTimeS?: number): Envelope {
  const n = line.points.length;
  const longG = new Float32Array(n);
  const latG = new Float32Array(n);
  const leanDeg = new Float32Array(n);
  const seg = new Float32Array(n);
  const t = tS ?? new Float64Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ds = dsAt(line, j);
    seg[i] = (v[j] * v[j] - v[i] * v[i]) / (2 * ds * G);
    if (!tS) {
      t[i] = acc;
      acc += ds / Math.max(V_MIN, (v[i] + v[j]) / 2);
    }
  }
  for (let i = 0; i < n; i++) {
    longG[i] = (seg[(i - 1 + n) % n] + seg[i]) / 2;
    latG[i] = (v[i] * v[i] * line.curvature[i]) / G;
    const ideal = Math.atan(Math.abs(latG[i]));
    const baseIdeal = Math.atan(Math.abs(base.latG[i] ?? 0));
    leanDeg[i] =
      baseIdeal > 1e-6 && Number.isFinite(base.leanDeg[i])
        ? base.leanDeg[i] * (ideal / baseIdeal)
        : (-Math.atan(latG[i]) * 180) / Math.PI;
  }
  return {
    v,
    longG,
    latG,
    leanDeg,
    gripUse: base.gripUse,
    gripUsePeak: base.gripUsePeak,
    tS: t,
    lapTimeS: lapTimeS ?? acc,
  };
}

/**
 * The rider-mode envelope: the event profile's speed, time and lap time on
 * the QSS envelope's line. Returns `env` itself when the events do not bind
 * anywhere, so a lap without corner events is the v1 lap bit for bit.
 */
export function envelopeFromEvent(line: Line, env: Envelope, ev: EventProfile): Envelope {
  let same = ev.v.length === env.v.length;
  for (let i = 0; same && i < ev.v.length; i++) same = ev.v[i] === env.v[i];
  if (same) return env;
  return envelopeFromSpeed(line, ev.v, env, ev.tS, ev.lapTimeS);
}

export function simulate(
  track: TrackModel,
  corridor: Corridor | undefined,
  params: SimParams,
  id: string,
  name: string,
  color: string,
  mode: SolverMode = 'rider',
  optimal?: OptimalInput,
): SimResult {
  const p = clampParams(params);

  if (mode !== 'rider') {
    const ip = idealParams(p);
    const n = track.centerline.length;
    if (optimal && optimal.offsetsM.length !== n) {
      throw new RangeError(`optimal offsets have ${optimal.offsetsM.length} samples, the track has ${n}`);
    }
    if (optimal?.vMs && optimal.vMs.length !== n) {
      throw new RangeError(`optimal speed has ${optimal.vMs.length} samples, the track has ${n}`);
    }
    // no optimiser result yet → the κ-line driven by the ideal rider
    const line = optimal ? lineFromOffsets(track, optimal.offsetsM) : buildLine(track, corridor, ip);
    const qss = solve(line, ip);
    const env = optimal?.vMs
      ? envelopeFromSpeed(line, Float32Array.from(optimal.vMs, (x) => Math.max(V_MIN, x)), qss)
      : qss;
    const ch = riderChannels(line, env, ip);
    return { session: toSession(line, env, ch, ip, id, name, color), line, envelope: env, lapTimeS: env.lapTimeS, mode };
  }

  const line = buildLine(track, corridor, p);
  const qss = solve(line, p);
  const corners = findCorners(line, qss.v, p);
  const ev = eventProfile(line, qss, corners, p, eventCaps(line, p));
  const env = envelopeFromEvent(line, qss, ev);
  const ch = riderChannels(line, env, p, ev);
  return {
    session: toSession(line, env, ch, p, id, name, color),
    line,
    envelope: env,
    lapTimeS: env.lapTimeS,
    mode,
    corners: ev.corners,
  };
}

export { buildLine } from './line';
export { solve, topSpeedMs } from './solver';
export { riderChannels } from './rider';
export * from './types';
