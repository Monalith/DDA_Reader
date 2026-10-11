// Machine, tyre and rider presets.
//
// Sources (see the spec for the full argument):
// - Kevin Cameron, "The Two Basic Styles of Motorcycle Cornering", Cycle World:
//   low-powered machines must use the corner-speed style because they cannot
//   recover exit speed; powerful ones square the corner off. So kappa tracks
//   power-to-weight rather than being an independent taste.
// - Cycle World "MotoGP Extreme Lean": on IDENTICAL tyres a ZX-10R, GSX-R750
//   and R6 reached the SAME lateral g. That is a statement about the tyre, not
//   about the bike: it says engine size does not buy grip. It does NOT say the
//   classes below share a mu, because they are not on identical tyres — each
//   preset carries the rubber its class actually races on, so mu rises with
//   the tyre class (1.25 street race -> 1.35 Panigale-class) while the bikes
//   themselves contribute nothing to it.
// - Brembo MotoGP data (Le Mans, Austria, Aragon): peak deceleration ~1.5 g.
//   Production machinery on road-legal race rubber sits well below that.
// - Lean limits ~50-55 deg (street race tyre) to ~63 deg (MotoGP tyre) are
//   practitioner figures, not measured here: treat them as starting points.
import type { MachineParams, RiderParams, SimParams, TyreTrackParams } from './types';

export interface MachinePreset {
  id: string;
  label: string;
  machine: Omit<MachineParams, 'presetId'>;
  tyre: TyreTrackParams;
  kappa: number;
}

export const MACHINE_PRESETS: MachinePreset[] = [
  {
    id: '250',
    label: '250 cc (Ninja 400 / RC390 class)',
    machine: { powerKw: 33, massKg: 235, cdA: 0.36, wheelbaseM: 1.37, cgHeightM: 0.58, finalDrive: 3.07, gearRatios: [2.92, 2.06, 1.6, 1.33, 1.15, 1.0] },
    tyre: { mu: 1.25, maxLeanDeg: 52, kerbMarginM: 0.3, gripScale: 1 },
    kappa: 0.1,
  },
  {
    id: '600',
    label: '600 cc supersport (R6 / ZX-6R class)',
    machine: { powerKw: 88, massKg: 265, cdA: 0.33, wheelbaseM: 1.38, cgHeightM: 0.56, finalDrive: 2.81, gearRatios: [2.58, 2.0, 1.67, 1.44, 1.29, 1.15] },
    tyre: { mu: 1.3, maxLeanDeg: 56, kerbMarginM: 0.4, gripScale: 1 },
    kappa: 0.45,
  },
  {
    id: '1000',
    label: '1000 cc superbike (R1 / ZX-10R class)',
    machine: { powerKw: 147, massKg: 285, cdA: 0.34, wheelbaseM: 1.41, cgHeightM: 0.55, finalDrive: 2.56, gearRatios: [2.6, 2.0, 1.67, 1.44, 1.29, 1.15] },
    tyre: { mu: 1.33, maxLeanDeg: 58, kerbMarginM: 0.5, gripScale: 1 },
    kappa: 0.85,
  },
  {
    id: 'panigale-v4',
    label: 'Ducati Panigale V4',
    machine: { powerKw: 158, massKg: 290, cdA: 0.34, wheelbaseM: 1.47, cgHeightM: 0.55, finalDrive: 2.5, gearRatios: [2.46, 1.94, 1.64, 1.45, 1.32, 1.21] },
    tyre: { mu: 1.35, maxLeanDeg: 59, kerbMarginM: 0.5, gripScale: 1 },
    kappa: 0.85,
  },
  {
    id: 'custom',
    label: 'Custom',
    machine: { powerKw: 100, massKg: 270, cdA: 0.34, wheelbaseM: 1.4, cgHeightM: 0.56, finalDrive: 2.7, gearRatios: [2.6, 2.0, 1.67, 1.44, 1.29, 1.15] },
    tyre: { mu: 1.3, maxLeanDeg: 56, kerbMarginM: 0.4, gripScale: 1 },
    kappa: 0.5,
  },
];

export function presetById(id: string): MachinePreset {
  return MACHINE_PRESETS.find((p) => p.id === id) ?? MACHINE_PRESETS[MACHINE_PRESETS.length - 1];
}

const DEFAULT_RIDER: RiderParams = {
  lineDeviationM: 0.4,
  // How hard the rider brakes with the TYRE, which is not the same as the
  // deceleration the data shows: aero and rolling losses are now a separate
  // term in the solver's backward pass, so this is only the contact patch's
  // share. It was 1.1 while the model had no loss term at all and that 1.1
  // stood in for both.
  //
  // 0.85 is measured, on both reference laps, by taking each braking zone's
  // peak `boylamsal_g` and subtracting the aero and rolling deceleration at
  // the speed it happened at (`docs/.../2026-10-11-longitudinal-g.md` has the
  // table). The hardest zone on the lap comes out at 0.80-0.92 g of tyre on
  // the BMW and 0.72 g on the R6; the slow corners are 0.41-0.70, which is the
  // rider choosing not to use everything, not the tyre running out. So 0.85 is
  // the top of what the real riders asked the front tyre for, and the solver
  // being quasi-steady-state will then use it at every zone — see the report.
  brakingG: 0.85,
  // Measured off the leading edge of the hardest braking zone on each
  // reference lap, which is the one place on the lap where the brake goes on
  // from a settled straight and the build is not entangled with a corner:
  //   BMW  -0.08 g at 272 km/h -> -1.10 g 30 m later, 0.40 s: 2.7 g/s
  //   R6   -0.04 g at 249 km/h -> -1.07 g 25 m later, 0.37 s: 2.8 g/s
  // Two different bikes and two different riders agreeing to 4 % is a good
  // sign this is the machine (fork travel and damping) rather than taste.
  brakeRiseGps: 2.8,
  throttleDelayS: 0.25,
  tcThreshold: 0.5,
  leanUsage: 0.95,
  kappa: presetById('1000').kappa,
  // A quick road-racer: carries the brakes most of the way to the apex and
  // uses most of the grip the tyre has left while doing it.
  //
  // These two were 0.6 / 0.6 while `trailBrakeDepth` scaled the remaining
  // longitudinal share at every lean (and `trailBrakeProfile` did nothing at
  // all). Both now mean what the names say — see `brakeShare` in `solver.ts`:
  // depth is the lateral-grip-use fraction at which braking has CEASED, and
  // profile is how much of the remaining grip is used on the way there.
  //
  // 0.85 / 0.80 is where the default has to sit to keep reproducing the
  // reference BMW Serres lap (1:19.81): 79.34 s on the offline harness against
  // the 79.29 s the old default gave on the same harness, so the calibration of
  // docs/superpowers/notes/2026-10-10-virtual-vs-real.md survives to 0.05 s.
  // 0.6 / 0.6 in the new units — a rider off the brakes by 68 % of the tyre's
  // lateral capacity, and only evenly hard before that — is 81.71 s, i.e. 2.4 s
  // a lap slower, which is a plausible club rider rather than a fast one.
  trailBrakeDepth: 0.85,
  trailBrakeProfile: 0.8,
};

export const DEFAULT_SIM_PARAMS: SimParams = {
  machine: { presetId: '1000', ...presetById('1000').machine },
  tyre: { ...presetById('1000').tyre },
  rider: { ...DEFAULT_RIDER },
};

const clamp = (v: number, lo: number, hi: number): number =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;

/**
 * Hold every value inside a physically meaningful range. The sliders can reach
 * their own minima, and a zero mass, zero power or zero mu would put Infinity
 * into the velocity profile and NaN into every channel of the session, which
 * breaks all the charts at once and is hard to attribute. Clamping here means
 * the solver can assume finite, non-zero divisors.
 */
export function clampParams(p: SimParams): SimParams {
  return {
    machine: {
      presetId: p.machine.presetId,
      powerKw: clamp(p.machine.powerKw, 1, 400),
      massKg: clamp(p.machine.massKg, 60, 500),
      cdA: clamp(p.machine.cdA, 0.1, 1.5),
      wheelbaseM: clamp(p.machine.wheelbaseM, 1.0, 2.0),
      cgHeightM: clamp(p.machine.cgHeightM, 0.2, 1.0),
      finalDrive: clamp(p.machine.finalDrive, 1.5, 5),
      // Each ratio is a divisor in the rpm/gear model, so a zero, a negative or
      // a NaN would put Infinity or NaN into `rpm` and `gear`. Clamp the
      // elements as well as the length.
      gearRatios: p.machine.gearRatios.length
        ? p.machine.gearRatios.map((r) => clamp(r, 0.5, 6))
        : [...presetById('custom').machine.gearRatios],
    },
    tyre: {
      mu: clamp(p.tyre.mu, 0.3, 1.8),
      maxLeanDeg: clamp(p.tyre.maxLeanDeg, 15, 70),
      kerbMarginM: clamp(p.tyre.kerbMarginM, 0, 3),
      gripScale: clamp(p.tyre.gripScale, 0.3, 1.2),
    },
    rider: {
      lineDeviationM: clamp(p.rider.lineDeviationM, 0, 5),
      brakingG: clamp(p.rider.brakingG, 0.2, 1.8),
      // A zero would mean the brake never develops any force at all and the
      // bike never slows; the ceiling is an instant application, i.e. the
      // unlimited pass this replaced.
      brakeRiseGps: clamp(p.rider.brakeRiseGps, 0.5, 20),
      throttleDelayS: clamp(p.rider.throttleDelayS, 0, 2),
      tcThreshold: clamp(p.rider.tcThreshold, 0, 1),
      leanUsage: clamp(p.rider.leanUsage, 0, 1),
      kappa: clamp(p.rider.kappa, 0, 1),
      trailBrakeDepth: clamp(p.rider.trailBrakeDepth, 0, 1),
      trailBrakeProfile: clamp(p.rider.trailBrakeProfile, 0, 1),
    },
  };
}
