// The rider's channels: what the velocity envelope cannot say on its own.
//
// v2 (spec §2.7): brake and throttle ARE the corner-event template
// (`events.ts`) — one brake and one throttle transition per corner section,
// with the measured build, pick-up and roll-on timing. The v1 per-sample lag
// layer (first-order lags, dead-bands, event-merging heuristics) is gone: it
// post-processed a per-sample envelope that braked into every curvature
// wiggle, and none of its constants could move the lap time.
//
// Without an `EventProfile` (the optimal solver modes, which have an ideal
// rider and no corner events) brake and throttle are read straight off the
// sign of the longitudinal acceleration. Gear, rpm and traction control are
// the same in both cases.
import type { Envelope, Line, SimParams } from './types';
import type { EventProfile } from './events';
import { clampParams } from './presets';

export interface RiderChannels {
  /** Throttle position, %. */
  tps: Float32Array;
  /** Brake application, %. Separate from tps on purpose — see the rate limits. */
  brake: Float32Array;
  /** Selected gear, 1..n. */
  gear: Float32Array;
  rpm: Float32Array;
  /** Traction-control intervention, % of torque cut. */
  dtc: Float32Array;
}

/** Rolling radius of a 190/55-17 rear, metres. */
const WHEEL_RADIUS_M = 0.31;
const RPM_LIMIT = 14000;
const RPM_MIN = 3500;

/**
 * The rider's channels along the line.
 *
 * With `ev` (spec v2 §2.7): `brake` and `tps` are the corner-event profile's
 * own traces (`events.ts`), unaltered. Pass an `env` whose `v`/`tS` are the
 * event speed and clock so gear, rpm and dtc follow the speed the session
 * reports. Without `ev`: the ideal-rider read-off used by the optimal modes.
 */
export function riderChannels(line: Line, env: Envelope, params: SimParams, ev?: EventProfile): RiderChannels {
  const p = clampParams(params);
  const n = line.points.length;
  const tps = new Float32Array(n);
  const brake = new Float32Array(n);
  const gear = new Float32Array(n);
  const rpm = new Float32Array(n);
  const dtc = new Float32Array(n);
  if (!n) return { tps, brake, gear, rpm, dtc };

  if (ev) {
    // v2: the corner-event template already IS the rider's hands — one brake
    // and one throttle transition per section, with the measured build,
    // pick-up and roll-on timing. No rate limits, dead-bands or merging here.
    for (let i = 0; i < n; i++) {
      tps[i] = Math.min(100, Math.max(0, ev.tps[i] ?? 0));
      brake[i] = Math.min(100, Math.max(0, ev.brake[i] ?? 0));
    }
  } else {
    // Ideal rider (optimal modes): the envelope's own longitudinal demand,
    // as a percentage of the tyre's braking ceiling and of a 0.9 g drive.
    const muX = (p.tyre.muX ?? p.tyre.mu) * p.tyre.gripScale;
    for (let i = 0; i < n; i++) {
      const g = env.longG[i];
      tps[i] = g > 0 ? Math.min(100, (g / 0.9) * 100) : 0;
      brake[i] = g < 0 ? Math.min(100, (-g / Math.max(0.2, muX)) * 100) : 0;
    }
  }

  // ---- gear and rpm -----------------------------------------------------
  const ratios = p.machine.gearRatios;
  const top = ratios.length;
  // speed at the rev limit in each gear
  const vAtLimit = ratios.map(
    (r) => (RPM_LIMIT * 2 * Math.PI * WHEEL_RADIUS_M) / (60 * r * p.machine.finalDrive),
  );
  for (let i = 0; i < n; i++) {
    let g = 1;
    while (g < top && env.v[i] > vAtLimit[g - 1]) g++;
    gear[i] = g;
    const rev = (env.v[i] * 60 * ratios[g - 1] * p.machine.finalDrive) / (2 * Math.PI * WHEEL_RADIUS_M);
    rpm[i] = Math.min(RPM_LIMIT, Math.max(RPM_MIN, rev));
  }

  // ---- traction control -------------------------------------------------
  // TC cuts when the drive demand plus the lateral demand would exceed what the
  // threshold allows. A low threshold means an intrusive system.
  const allowed = 0.55 + 0.45 * p.rider.tcThreshold;
  const aLatMax = Math.max(
    0.1,
    Math.min(p.tyre.mu * p.tyre.gripScale, Math.tan((p.tyre.maxLeanDeg * p.rider.leanUsage * Math.PI) / 180)),
  );
  for (let i = 0; i < n; i++) {
    if (env.longG[i] <= 0) continue; // braking or coasting: nothing to cut
    const latUse = Math.min(1, Math.abs(env.latG[i]) / aLatMax);
    const longUse = Math.min(1, env.longG[i] / (p.tyre.mu * p.tyre.gripScale));
    const total = Math.hypot(latUse, longUse);
    if (total > allowed) dtc[i] = Math.min(100, ((total - allowed) / Math.max(0.05, 1 - allowed)) * 100);
  }

  return { tps, brake, gear, rpm, dtc };
}
