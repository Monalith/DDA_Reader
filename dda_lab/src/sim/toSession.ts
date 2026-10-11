// Package the simulation as an ordinary Session.
//
// This is the whole point of the design: a Session goes through
// refreshSession() like any loaded file, so the map trace, the heat maps, the
// chart stack, the cursor, the lap table and delta_t all work with no new
// visualisation code. Everything here exists to satisfy that contract.
import { makeTimeBase } from '../core/resample';
import { DEFAULT_PROC, type Channel, type Lap, type Session } from '../core/types';
import type { RiderChannels } from './rider';
import type { Envelope, Line, SimParams } from './types';

/** Linear interpolation of `src` (indexed by line sample) onto the 10 Hz grid. */
function onTimeGrid(src: ArrayLike<number>, srcT: Float64Array, t: Float64Array): Float32Array {
  const out = new Float32Array(t.length);
  const n = srcT.length;
  let j = 0;
  for (let i = 0; i < t.length; i++) {
    const tt = t[i];
    while (j < n - 2 && srcT[j + 1] < tt) j++;
    const t0 = srcT[j];
    const t1 = srcT[Math.min(n - 1, j + 1)];
    const f = t1 > t0 ? (tt - t0) / (t1 - t0) : 0;
    const v0 = src[j];
    const v1 = src[Math.min(n - 1, j + 1)];
    out[i] = v0 + Math.min(1, Math.max(0, f)) * (v1 - v0);
  }
  return out;
}

/** Nearest-sample lookup, for channels that must not be interpolated (gear). */
function onTimeGridStep(src: ArrayLike<number>, srcT: Float64Array, t: Float64Array): Float32Array {
  const out = new Float32Array(t.length);
  const n = srcT.length;
  let j = 0;
  for (let i = 0; i < t.length; i++) {
    while (j < n - 2 && srcT[j + 1] <= t[i]) j++;
    out[i] = src[j];
  }
  return out;
}

/**
 * NO `note` HERE. `note` means "estimated placeholder, replace me when the real
 * thing turns up" — `fillMissingChannels` gates on it — so labelling the
 * solver's own output with it made `refreshSession()` throw the solver's
 * `speed` and `lean` away and substitute GPS estimates. The session carries
 * `isSim: true` instead, and `derived.ts` reads that as ownership.
 */
function channel(name: string, unit: string, data: Float32Array, color?: string): Channel {
  return { name, unit, kind: 'raw', data, proc: { ...DEFAULT_PROC }, color };
}

export function toSession(
  line: Line,
  env: Envelope,
  ch: RiderChannels,
  params: SimParams,
  id: string,
  name: string,
  color: string,
): Session {
  const t = makeTimeBase(env.lapTimeS, 10);
  const srcT = env.tS;

  const lon = Float64Array.from(line.points, (p) => p[0]);
  const lat = Float64Array.from(line.points, (p) => p[1]);

  const channels = new Map<string, Channel>();
  channels.set('speed', channel('speed', 'km/h', onTimeGrid(Float32Array.from(env.v, (v) => v * 3.6), srcT, t)));
  channels.set('gps_lon', channel('gps_lon', 'deg', onTimeGrid(lon, srcT, t)));
  channels.set('gps_lat', channel('gps_lat', 'deg', onTimeGrid(lat, srcT, t)));
  channels.set('long_g', channel('long_g', 'g', onTimeGrid(env.longG, srcT, t)));
  channels.set('lat_g', channel('lat_g', 'g', onTimeGrid(env.latG, srcT, t)));
  channels.set('lean', channel('lean', 'deg', onTimeGrid(env.leanDeg, srcT, t)));
  channels.set('tps', channel('tps', '%', onTimeGrid(ch.tps, srcT, t)));
  channels.set('brake', channel('brake', '%', onTimeGrid(ch.brake, srcT, t)));
  channels.set('rpm', channel('rpm', 'rpm', onTimeGrid(ch.rpm, srcT, t)));
  channels.set('dtc', channel('dtc', '%', onTimeGrid(ch.dtc, srcT, t)));
  // 1.0 = the tyre is exactly at its limit; above that is a fall, not a lap
  channels.set('grip_use', channel('grip_use', '', onTimeGrid(env.gripUse, srcT, t)));
  // v2 (spec §2.8): grip_use is against the RIDER's allowed-slip ceiling;
  // this one is against the tyre's peak, so the two together say how much
  // margin the rider left
  if (env.gripUsePeak) channels.set('grip_use_peak', channel('grip_use_peak', '', onTimeGrid(env.gripUsePeak, srcT, t)));
  channels.set('gear', channel('gear', '', onTimeGridStep(ch.gear, srcT, t)));
  channels.set(
    'lap_dist',
    channel('lap_dist', 'm', onTimeGrid(Float64Array.from(line.cumDistM), srcT, t)),
  );

  const lap: Lap = {
    n: 1,
    startIdx: 0,
    endIdx: t.length - 1,
    timeS: env.lapTimeS,
    sectorsS: [],
    isBest: true,
    kind: 'flying',
  };

  return {
    id,
    name,
    source: 'sim',
    color,
    t,
    channels,
    laps: [lap],
    meta: {
      track: '',
      rider: 'Virtual rider',
      note: `${params.machine.presetId} · κ ${params.rider.kappa.toFixed(2)} · brake ${params.rider.brakingG.toFixed(2)} g`,
    },
    // the lap comes from the simulation, not from gates: keep it when the start line moves
    lapsFromFile: true,
    isSim: true,
  };
}
