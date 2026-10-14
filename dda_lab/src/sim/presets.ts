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
import { deriveRider } from './derive';
import type { MachineParams, RiderParams, SimParams, TyreTrackParams } from './types';

export interface MachinePreset {
  id: string;
  label: string;
  machine: Omit<MachineParams, 'presetId'>;
  tyre: TyreTrackParams;
  kappa: number;
}

// Peak μ (lateral) per class, re-calibrated for v2 on 2026-10-11: with the
// rider below the slip peak (gripFraction(s) < 1) the SAME lap times need a
// higher tyre peak — 1.33 -> 1.40 on the 1000 (R2 §5 risk 2; +5.3 % on every
// class). These are peak values the rider never fully uses.
export const MACHINE_PRESETS: MachinePreset[] = [
  {
    id: '250',
    label: '250 cc (Ninja 400 / RC390 class)',
    machine: {
      powerKw: 33, massKg: 235, cdA: 0.36, wheelbaseM: 1.37,
      riderMassKg: 75, // source: R1 §3.2 hang-off table, m_r 75 kg (rider in leathers), öneri
      cgRearM: 0.671, // source: R1 §3.1 S1000RR+rider b/p = 0.70/1.44 = 0.486; here 0.49, öneri
      tyreCrownM: 0.06, // source: R1 §3.2 t = 0.06 column; 140-150 section rear on this class, öneri
      hangOffM: 0.2, // source: R1 §3.2 d_r range 0-0.3 m; less seat to move across on a small bike, öneri
      cgHeightM: 0.58, finalDrive: 3.07, gearRatios: [2.92, 2.06, 1.6, 1.33, 1.15, 1.0],
    },
    tyre: { mu: 1.32, maxLeanDeg: 52, kerbMarginM: 0.3, gripScale: 1 },
    kappa: 0.1,
  },
  {
    id: '600',
    label: '600 cc supersport (R6 / ZX-6R class)',
    machine: {
      powerKw: 88, massKg: 265, cdA: 0.33, wheelbaseM: 1.38,
      riderMassKg: 75, // source: R1 §3.2 hang-off table, m_r 75 kg, öneri
      cgRearM: 0.676, // source: R1 §3.1 S1000RR+rider b/p = 0.486; here 0.49, öneri
      tyreCrownM: 0.07, // source: R1 §3.2 t 0.06-0.09; 180/55 rear, between the 250 and 1000 classes, öneri
      hangOffM: 0.25, // source: R1 §3.2 table, d_r 0.25 m track hang-off, öneri
      cgHeightM: 0.56, finalDrive: 2.81, gearRatios: [2.58, 2.0, 1.67, 1.44, 1.29, 1.15],
    },
    tyre: { mu: 1.37, maxLeanDeg: 56, kerbMarginM: 0.4, gripScale: 1 },
    kappa: 0.45,
  },
  {
    id: '1000',
    label: '1000 cc superbike (R1 / ZX-10R class)',
    machine: {
      powerKw: 147, massKg: 285, cdA: 0.34, wheelbaseM: 1.41,
      riderMassKg: 75, // source: R1 §3.2 hang-off table, m_r 75 kg, öneri
      cgRearM: 0.691, // source: R1 §3.1 S1000RR+rider b/p = 0.486; here 0.49, öneri
      tyreCrownM: 0.08, // source: R1 §3.2 worked example t = 0.08 (190/55-17 race rear), öneri
      hangOffM: 0.25, // source: R1 §3.2 table, d_r 0.25 m track hang-off, öneri
      cgHeightM: 0.55, finalDrive: 2.56, gearRatios: [2.6, 2.0, 1.67, 1.44, 1.29, 1.15],
    },
    tyre: { mu: 1.4, maxLeanDeg: 58, kerbMarginM: 0.5, gripScale: 1 },
    kappa: 0.85,
  },
  {
    id: 'panigale-v4',
    label: 'Ducati Panigale V4',
    machine: {
      powerKw: 158, massKg: 290, cdA: 0.34, wheelbaseM: 1.47,
      riderMassKg: 75, // source: R1 §3.2 hang-off table, m_r 75 kg, öneri (W4 replaces with the owner's mass)
      cgRearM: 0.72, // source: R1 §3.1 S1000RR+rider b/p = 0.486; here 0.49, öneri
      tyreCrownM: 0.08, // source: R1 §3.2 worked example t = 0.08 (200/60-17 race rear), öneri
      hangOffM: 0.25, // source: R1 §3.2 table, d_r 0.25 m track hang-off, öneri (W4 fits the owner laps)
      cgHeightM: 0.55, finalDrive: 2.5, gearRatios: [2.46, 1.94, 1.64, 1.45, 1.32, 1.21],
    },
    tyre: { mu: 1.42, maxLeanDeg: 59, kerbMarginM: 0.5, gripScale: 1 },
    kappa: 0.85,
  },
  {
    id: 'custom',
    label: 'Custom',
    machine: {
      powerKw: 100, massKg: 270, cdA: 0.34, wheelbaseM: 1.4,
      riderMassKg: 75, // source: R1 §3.2 hang-off table, m_r 75 kg, öneri
      cgRearM: 0.686, // source: R1 §3.1 S1000RR+rider b/p = 0.486; here 0.49, öneri
      tyreCrownM: 0.08, // source: R1 §3.2 worked example t = 0.08, öneri
      hangOffM: 0.2, // source: R1 §3.2 d_r range 0-0.3 m, mid-range, öneri
      cgHeightM: 0.56, finalDrive: 2.7, gearRatios: [2.6, 2.0, 1.67, 1.44, 1.29, 1.15],
    },
    tyre: { mu: 1.37, maxLeanDeg: 56, kerbMarginM: 0.4, gripScale: 1 },
    kappa: 0.5,
  },
];

export function presetById(id: string): MachinePreset {
  return MACHINE_PRESETS.find((p) => p.id === id) ?? MACHINE_PRESETS[MACHINE_PRESETS.length - 1];
}

/**
 * The default rider: everything but the line parameters is DERIVED from the
 * two top-level sliders (spec v2 §2.6, `deriveRider`). Calibrated on the BMW
 * Serres reference on 2026-10-11 (notes/2026-10-11-v2-calibration.md):
 * A 0.9 / R 0.5 on the 1000 preset gives 80.07 s against the real 79.81, a
 * 0.36 s brake build (real 0.32), 9 corner sections and 10 brake applications
 * (real 7-14). The owner's own Ducati laps sit near A 0.25 / R 0.0 with a
 * gripScale of ~0.9 (93 s against 95.8).
 */
const DEFAULT_RIDER_BASE: RiderParams = {
  aggressiveness: 0.9,
  risk: 0.5,
  overrides: [],
  lineDeviationM: 0.4,
  kappa: presetById('1000').kappa,
  lineMode: 'min-time',
  // derived below; zeros here only so the object is complete before deriveRider()
  sBrake: 0, sDrive: 0, sLat: 0, rollOnS: 0, rollRateFrac: 0,
  brakingG: 0, brakeRiseGps: 0, throttleDelayS: 0, tcThreshold: 0, leanUsage: 0,
  trailBrakeDepth: 0, trailBrakeProfile: 0,
};
const DEFAULT_RIDER: RiderParams = deriveRider(DEFAULT_RIDER_BASE, presetById('1000').tyre);

export const DEFAULT_SIM_PARAMS: SimParams = {
  machine: { presetId: '1000', ...presetById('1000').machine },
  tyre: { ...presetById('1000').tyre },
  rider: { ...DEFAULT_RIDER },
};

/** Default kerb allowance past a measured corridor edge, metres (`TyreTrackParams.kerbM`). */
export const DEFAULT_KERB_M = 1.0;

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
      riderMassKg: clamp(p.machine.riderMassKg, 40, 150),
      cgHeightM: clamp(p.machine.cgHeightM, 0.2, 1.0),
      // b must stay strictly inside the wheelbase or a stoppie/wheelie limit
      // goes to zero and the solver stalls at V_MIN.
      cgRearM: clamp(p.machine.cgRearM, 0.2 * p.machine.wheelbaseM, 0.8 * p.machine.wheelbaseM),
      tyreCrownM: clamp(p.machine.tyreCrownM, 0, 0.15),
      hangOffM: clamp(p.machine.hangOffM, 0, 0.5),
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
      muX: p.tyre.muX === undefined ? undefined : clamp(p.tyre.muX, 0.3, 1.8),
      maxLeanDeg: clamp(p.tyre.maxLeanDeg, 15, 70),
      kerbMarginM: clamp(p.tyre.kerbMarginM, 0, 3),
      kerbM: clamp(p.tyre.kerbM ?? DEFAULT_KERB_M, 0, 3),
      gripScale: clamp(p.tyre.gripScale, 0.3, 1.2),
    },
    rider: {
      aggressiveness: clamp(p.rider.aggressiveness, 0, 1),
      risk: clamp(p.rider.risk, 0, 1),
      overrides: Array.isArray(p.rider.overrides) ? [...p.rider.overrides] : [],
      // a zero allowed slip would be zero grip: floor it where the tyre still works
      sBrake: clamp(p.rider.sBrake, 0.1, 1),
      sDrive: clamp(p.rider.sDrive, 0.1, 1),
      sLat: clamp(p.rider.sLat, 0.1, 1),
      rollOnS: clamp(p.rider.rollOnS, 0.1, 3),
      rollRateFrac: clamp(p.rider.rollRateFrac, 0.1, 1),
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
      lineMode: p.rider.lineMode === 'min-curvature' || p.rider.lineMode === 'lap-time' ? p.rider.lineMode : 'min-time',
      trailBrakeDepth: clamp(p.rider.trailBrakeDepth, 0, 1),
      trailBrakeProfile: clamp(p.rider.trailBrakeProfile, 0, 1),
      // per-corner overrides (cornerRider.ts clamps each value where it is read)
      ...(p.rider.slideOut !== undefined ? { slideOut: clamp(p.rider.slideOut, 0, 1) } : {}),
      ...(p.rider.corners ? { corners: p.rider.corners } : {}),
    },
  };
}
