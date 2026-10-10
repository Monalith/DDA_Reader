// Machine, tyre and rider presets.
//
// Sources (see the spec for the full argument):
// - Kevin Cameron, "The Two Basic Styles of Motorcycle Cornering", Cycle World:
//   low-powered machines must use the corner-speed style because they cannot
//   recover exit speed; powerful ones square the corner off. So kappa tracks
//   power-to-weight rather than being an independent taste.
// - Cycle World "MotoGP Extreme Lean": with identical tyres a ZX-10R, GSX-R750
//   and R6 reached the SAME lateral g, so mu is shared across the classes and
//   only the lean limit (tyre construction) and the line differ.
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
  brakingG: 1.1,
  throttleDelayS: 0.25,
  tcThreshold: 0.5,
  leanUsage: 0.95,
  kappa: presetById('1000').kappa,
  // a competent road-racer: carries the brakes a fair way in, releases progressively
  trailBrakeDepth: 0.6,
  trailBrakeProfile: 0.6,
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
      gearRatios: p.machine.gearRatios.length ? p.machine.gearRatios : [...presetById('custom').machine.gearRatios],
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
      throttleDelayS: clamp(p.rider.throttleDelayS, 0, 2),
      tcThreshold: clamp(p.rider.tcThreshold, 0, 1),
      leanUsage: clamp(p.rider.leanUsage, 0, 1),
      kappa: clamp(p.rider.kappa, 0, 1),
      trailBrakeDepth: clamp(p.rider.trailBrakeDepth, 0, 1),
      trailBrakeProfile: clamp(p.rider.trailBrakeProfile, 0, 1),
    },
  };
}
