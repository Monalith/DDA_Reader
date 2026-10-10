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
  /** Lean angle, degrees (signed, positive = leaning left). */
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
   * How much of the remaining longitudinal share the rider actually spends on
   * braking as lean increases, 0..1. At 1 the brakes are carried to the apex
   * (trail braking); at 0 braking fades out as soon as the bike is leaned,
   * which is straight-line braking.
   */
  trailBrakeDepth: number;
  /** Shape of the brake-release taper into the corner, 0..1. */
  trailBrakeProfile: number;
}

export interface SimParams {
  machine: MachineParams;
  tyre: TyreTrackParams;
  rider: RiderParams;
}
