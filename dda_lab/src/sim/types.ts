// Shared data model for the virtual rider. See
// docs/superpowers/specs/2026-10-09-virtual-rider-design.md
import type { LngLat } from '../core/types';

/**
 * Track boundaries, one entry per centerline vertex of the track it was built
 * for. `leftM[i]` / `rightM[i]` are the distances in metres from
 * `centerline[i]` to the asphalt edge, left and right of the direction of
 * travel. `known[i]` is false where extraction could not decide.
 */
export interface Corridor {
  /** Centerline spacing the corridor was sampled at, metres (informational). */
  stepM: number;
  leftM: Float32Array;
  rightM: Float32Array;
  known: boolean[];
}

/** A generated racing line, sampled at the same spacing as the centerline. */
export interface Line {
  points: LngLat[];
  /** Signed curvature, 1/m, positive = turning left. */
  curvature: Float32Array;
  /** Cumulative distance along the line, metres. */
  cumDistM: Float64Array;
  lengthM: number;
  /** Lateral offset from the centerline that produced each point, metres. */
  offsetM: Float32Array;
}

/** The solver's velocity profile and the g's that produced it. */
export interface Envelope {
  /** Speed along the line, m/s. */
  v: Float32Array;
  /** Longitudinal acceleration, g (negative = braking). */
  longG: Float32Array;
  /** Lateral acceleration, g (signed, positive = turning left). */
  latG: Float32Array;
  /**
   * Lean angle, degrees, signed in the APP's convention: left = NEGATIVE, the
   * same as every recorded lap (`fillMissingChannels` in `core/derived.ts`
   * estimates `lean` as −atan(v²κ/g)). So `tan(leanDeg) = −latG`: the two are
   * opposite in sign by construction, because `latG` is positive for a left
   * turn and `lean` is negative for one. Writing it the other way round — as
   * this field used to — put the sim's `lean` trace upside down against every
   * real lap in the chart stack.
   */
  leanDeg: Float32Array;
  /** Combined tyre demand as a fraction of the friction circle; 1.0 is the limit. */
  gripUse: Float32Array;
  /** Elapsed time at each sample, seconds from the start line. */
  tS: Float64Array;
  lapTimeS: number;
}

export interface MachineParams {
  presetId: string;
  powerKw: number;
  /** Bike plus rider and fuel. */
  massKg: number;
  /** Drag area, m^2. */
  cdA: number;
  wheelbaseM: number;
  cgHeightM: number;
  finalDrive: number;
  /** Gearbox ratios, first to top. Used only by the rpm/gear model. */
  gearRatios: number[];
}

export interface TyreTrackParams {
  /** Peak tyre-road friction coefficient. */
  mu: number;
  /** Maximum usable lean angle, degrees. */
  maxLeanDeg: number;
  /** How far past the extracted asphalt edge the line may run, metres. */
  kerbMarginM: number;
  /** One multiplier on mu standing in for surface and temperature. */
  gripScale: number;
}

export interface RiderParams {
  /** RMS lateral wander from the ideal line, metres. */
  lineDeviationM: number;
  /** Peak braking deceleration the rider will use, g. */
  brakingG: number;
  /** Delay between the apex and the throttle coming back, seconds. */
  throttleDelayS: number;
  /** Slip the traction control allows before cutting torque, 0..1. */
  tcThreshold: number;
  /** Fraction of the tyre's lean limit the rider actually uses, 0..1. */
  leanUsage: number;
  /** Line style: 0 = C line (even curvature), 1 = V line (squared off). */
  kappa: number;
  /**
   * EXTENT of trail braking, 0..1: how deep into the corner the rider carries
   * the brakes at all, as the lateral-grip-use fraction at which brake
   * pressure has reached zero. At 1 the brakes can be carried to maximum lean;
   * at 0 they are off by the time the bike is properly leaned, which is
   * straight-line braking. See `brakeShare` in `solver.ts`.
   */
  trailBrakeDepth: number;
  /**
   * MAGNITUDE of trail braking, 0..1: how much of the still-available
   * longitudinal grip the rider dares to use at a given lean angle on the way
   * to the depth limit. 0 is timid (pressure falls away as soon as the bike
   * leans), 1 is brave (nearly the whole remaining share of the friction
   * ellipse). Orthogonal to `trailBrakeDepth`: that one sets WHERE braking
   * stops, this one HOW HARD it is until then.
   */
  trailBrakeProfile: number;
}

export interface SimParams {
  machine: MachineParams;
  tyre: TyreTrackParams;
  rider: RiderParams;
}
