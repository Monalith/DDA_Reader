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
  /**
   * 3D road channels (spec v2 §2.3), one per line sample. All OPTIONAL and
   * treated as zero when absent: there is no elevation data yet (Serres has
   * ~8 m of relief, below DEM noise), but the solver's g-budget already takes
   * them so a DEM reader can be added without touching the passes.
   */
  /** Road grade along the line, radians, uphill positive. */
  slopeRad?: Float32Array;
  /** Banking, radians, surface falling toward the turn centre positive. */
  bankRad?: Float32Array;
  /** Normal curvature (vertical), 1/m, compression (dip) positive. */
  nu?: Float32Array;
}

/**
 * Which solver produces the lap (spec v2 §2.10). `fit` is the reference-fit
 * rider (`fitRider.ts`): per-corner caps fitted to a reference lap's speed.
 */
export type SolverMode = 'rider' | 'freeTrajectory' | 'ocp' | 'fit';

/** The racing line's κ = 0 objective (`RiderParams.lineMode`). */
export type LineMode = 'min-curvature' | 'min-time' | 'lap-time';

/**
 * Per-sample overrides of the rider's lap-wide ceilings for `solve()`, one
 * value per line sample, m/s². Absent arrays keep the v2 ceilings. Used by the
 * reference-fit rider: each corner gets its own lateral, braking and drive g.
 */
export interface EnvelopeCaps {
  /** Lateral ceiling (replaces min(μ_lat_eff, tan φ_max)·g); also the ellipse's lateral axis. */
  aLatMs2?: Float32Array;
  /**
   * The friction ellipse's lateral axis, when it should differ from
   * `aLatMs2` (a rider who stops at 1.3 g lateral still has the tyre's
   * remaining grip for braking and drive). Defaults to `aLatMs2`.
   */
  latAxisMs2?: Float32Array;
  /** Tyre braking ceiling (replaces μ_brake_eff·g); trail-brake share and stoppie still apply. */
  brakeMs2?: Float32Array;
  /** Drive ceiling (replaces μ_drive_eff·g); power, ellipse, TC and wheelie still apply. */
  driveMs2?: Float32Array;
  /**
   * Fraction (0…1) of the drive the bike has AFTER power, ellipse, TC and
   * wheelie: a rider rolling the throttle on (fitRider's roll-on ramp). A cap
   * on `driveMs2` cannot express it where the engine, not the tyre, limits.
   */
  driveScale?: Float32Array;
  /**
   * Ceiling on the NET forward acceleration, m/s² (after drag, rolling and
   * grade): a coasting rider who neither brakes nor drives beyond the
   * losses (0 = hold speed at most). Unlike `driveMs2` it is not cut by the
   * ellipse at lean, so a hold stays a hold in a corner.
   */
  accelMaxMs2?: Float32Array;
  /** Skip the roll-rate pass: a fitted rider's transitions are already in its lateral caps. */
  skipRollRate?: boolean;
}

/**
 * One corner section found by `corners.ts` (spec v2 §2.4). Indices are into
 * the `Line` samples. A section has exactly ONE brake and ONE throttle
 * transition; a chicane with several lean flips is still one section.
 */
export interface Corner {
  /** Brake point; equals `iT` when `hasBrake` is false. */
  iB: number;
  /** Turn-in: |κ| rises past the turn-in fraction of its peak. */
  iT: number;
  /** Speed apex: minimum of the speed profile inside the section. */
  iA: number;
  /** Geometric apex: maximum |κ| inside the section. */
  iAgeo: number;
  /** Throttle pick-up. */
  iP: number;
  /** Exit: |κ| falls below the fraction, lean drops, or the next brake point. */
  iE: number;
  /** +1 left, -1 right, by the sign of κ at the geometric apex. */
  dir: 1 | -1;
  /** False when the entry speed is already at or under the apex speed. */
  hasBrake: boolean;
  /** Sample indices where κ changes sign inside the section (chicane). */
  flips: number[];
}

/**
 * The rider parameters that `derive.ts` computes from `aggressiveness` and
 * `risk` (spec v2 §2.6). Any of them can be pinned by the user through
 * `RiderParams.overrides`, in which case derivation leaves it alone.
 */
export type DerivedRiderKey =
  | 'sBrake'
  | 'sDrive'
  | 'sLat'
  | 'brakingG'
  | 'brakeRiseGps'
  | 'throttleDelayS'
  | 'rollOnS'
  | 'rollRateFrac'
  | 'trailBrakeDepth'
  | 'trailBrakeProfile'
  | 'leanUsage'
  | 'tcThreshold';

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
  /**
   * Combined tyre demand as a fraction of the RIDER's grip ceiling (μ_eff,
   * spec v2 §2.8); 1.0 means the rider's own allowed-slip limit. In v1 this
   * was normalised to μ_peak.
   */
  gripUse: Float32Array;
  /** Same demand against the TYRE's peak μ. Optional until the v2 solver fills it. */
  gripUsePeak?: Float32Array;
  /** Elapsed time at each sample, seconds from the start line. */
  tS: Float64Array;
  lapTimeS: number;
}

export interface MachineParams {
  presetId: string;
  powerKw: number;
  /** Bike plus rider and fuel. */
  massKg: number;
  /** Rider alone, kg (part of `massKg`); sets the hang-off CG shift. */
  riderMassKg: number;
  /** Drag area, m^2. */
  cdA: number;
  wheelbaseM: number;
  /** Combined CG height when upright, metres. */
  cgHeightM: number;
  /**
   * Horizontal distance from the REAR contact point to the combined CG, metres
   * (spec v2 §2.1, R1 §3.1 symbol `b`). Sets the wheelie limit `g·b/h_φ` and
   * the stoppie limit `g·(p−b)/h_φ`; v1 assumed `b = p/2`.
   */
  cgRearM: number;
  /** Tyre crown (section) radius, metres; moves the contact point at lean. */
  tyreCrownM: number;
  /** Rider hang-off: lateral CG shift of the rider's mass, metres (0 = sits upright). */
  hangOffM: number;
  finalDrive: number;
  /** Gearbox ratios, first to top. Used only by the rpm/gear model. */
  gearRatios: number[];
}

export interface TyreTrackParams {
  /**
   * Peak LATERAL friction coefficient (μ_y). Named `mu` for v1 compatibility.
   * The rider never gets all of it: the solver scales it by the allowed-slip
   * grip fraction `g(sLat)` (spec v2 §2.2).
   */
  mu: number;
  /** Peak LONGITUDINAL friction coefficient (μ_x). Undefined means equal to `mu`. */
  muX?: number;
  /** Maximum usable lean angle, degrees. */
  maxLeanDeg: number;
  /** How far past the extracted asphalt edge the line may run, metres. */
  kerbMarginM: number;
  /**
   * Kerb allowance, metres: how far the line-generator's box extends past a
   * MEASURED corridor edge (a pist `.pist.json` edge sits at the asphalt/kerb
   * line, and a rider uses the kerb). Added on top of `kerbMarginM`; not
   * applied to the flat fallback half-width when there is no corridor.
   * Undefined means `DEFAULT_KERB_M` (1.0 m).
   */
  kerbM?: number;
  /** One multiplier on mu standing in for surface and temperature. */
  gripScale: number;
}

export interface RiderParams {
  /**
   * AGGRESSIVENESS, 0..1 (spec v2 §2.6): how fast the rider makes transitions.
   * Drives roll rate (`rollRateFrac`), brake build (`brakeRiseGps`), throttle
   * pick-up delay (`throttleDelayS`) and roll-on time (`rollOnS`). Timing, not
   * force level.
   */
  aggressiveness: number;
  /**
   * RISK-TAKING, 0..1: how close to the tyre's peak slip the rider goes.
   * Drives the three allowed-slip fractions (`sBrake`, `sDrive`, `sLat`) and
   * through them `brakingG`, `leanUsage` and the trail-brake pair. Force level,
   * not timing.
   */
  risk: number;
  /**
   * Derived keys the user has pinned in the advanced panel. `deriveRider()`
   * recomputes every derived field EXCEPT these from `aggressiveness`/`risk`.
   */
  overrides: DerivedRiderKey[];
  /**
   * Allowed slip as a fraction of the slip at peak grip, 0..1, three axes
   * (spec v2 §2.2): front braking, rear drive, lateral. The usable μ on each
   * axis is `μ_peak · gripFraction(s)`; s = 1 is the friction ceiling v1 used.
   */
  sBrake: number;
  sDrive: number;
  sLat: number;
  /** Throttle roll-on time, 20 % → 90 %, seconds (spec v2 §2.5). */
  rollOnS: number;
  /** Fraction of the Biniewicz lateral-jerk roll-rate bound the rider uses, 0..1 (spec v2 §2.5). */
  rollRateFrac: number;
  /** RMS lateral wander from the ideal line, metres. */
  lineDeviationM: number;
  /** Peak braking deceleration the rider will use, g. */
  brakingG: number;
  /**
   * How fast the TYRE's share of braking deceleration can build once the
   * brake goes on, g per second.
   *
   * Peak retardation is not available the instant the lever moves: the front
   * tyre can only carry 1.1 g once the machine's mass has pitched forward onto
   * it, and that rotation takes fork travel and damping time, on top of the
   * rider's own progressive squeeze. Without this the velocity profile's
   * leading edge is a step — one sample from zero to the full ceiling — which
   * is what made `long_g` read as a square plateau rather than a braking
   * trace. Aero and rolling losses are NOT rate-limited by it; they do not
   * wait for the fork. See the backward pass in `solver.ts`.
   */
  brakeRiseGps: number;
  /** Delay between the apex and the throttle coming back, seconds. */
  throttleDelayS: number;
  /** Slip the traction control allows before cutting torque, 0..1. */
  tcThreshold: number;
  /** Fraction of the tyre's lean limit the rider actually uses, 0..1. */
  leanUsage: number;
  /** Line style: 0 = C line (even curvature), 1 = V line (squared off). */
  kappa: number;
  /**
   * What the κ = 0 end of the line minimises (src/sim/line.ts):
   * 'min-time' (default when absent) weights the curvature by the QSS speed
   * squared and iterates line ↔ speed profile, so a fast sweeper is opened at
   * the cost of a slow hairpin; 'min-curvature' is the plain Σκ² line.
   */
  lineMode?: LineMode;
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
