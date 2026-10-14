// Slider metadata for the rider's derived keys, shared by the advanced panel
// and the per-corner editor (SimPanel, RiderFit).
import type { CornerRiderKey } from '../../sim/cornerRider';
import type { DerivedRiderKey } from '../../sim/types';

export interface SliderMeta {
  label: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
  decimals?: number;
  help: string;
}

/** Slider range, unit and help for every derived rider key (advanced panel). */
export const ADVANCED: Record<DerivedRiderKey, SliderMeta> = {
  sBrake: { label: 'Brake slip', min: 0.1, max: 1, step: 0.01, help: 'Front-tyre slip the rider allows on the brakes, as a fraction of the slip at peak grip (Risk).' },
  sDrive: { label: 'Drive slip', min: 0.1, max: 1, step: 0.01, help: 'Rear-tyre slip the rider allows on the way out (Risk).' },
  sLat: { label: 'Lateral slip', min: 0.1, max: 1, step: 0.01, help: 'Side slip the rider allows at lean (Risk).' },
  brakingG: { label: 'Braking', min: 0.2, max: 1.8, step: 0.01, unit: 'g', help: 'Peak braking asked of the FRONT TYRE: μx · grip(brake slip). Aero and rolling losses add to it on the charts.' },
  brakeRiseGps: { label: 'Brake build', min: 0.5, max: 8, step: 0.1, unit: 'g/s', decimals: 1, help: 'How fast braking builds once the lever moves (Aggressiveness). Both reference Serres laps build at about 2.8 g/s.' },
  throttleDelayS: { label: 'Throttle delay', min: 0, max: 2, step: 0.01, unit: 's', help: 'Time from the apex to picking up the throttle (Aggressiveness).' },
  rollOnS: { label: 'Roll-on', min: 0.1, max: 3, step: 0.01, unit: 's', help: 'Throttle 20 → 90 % time (Aggressiveness).' },
  rollRateFrac: { label: 'Roll rate', min: 0.1, max: 1, step: 0.01, help: 'Share of the Biniewicz roll-rate bound the rider uses when flicking the bike (Aggressiveness).' },
  trailBrakeDepth: { label: 'Trail depth', min: 0, max: 1, step: 0.01, help: 'How deep into the corner the brakes are carried. 0 = off before the bike leans; 1 = on at full lean (Risk).' },
  trailBrakeProfile: { label: 'Trail at lean', min: 0, max: 1, step: 0.01, help: 'How hard the rider brakes once leaned. 0 = timid, 1 = nearly all the grip left (Risk).' },
  leanUsage: { label: 'Lean usage', min: 0.5, max: 1, step: 0.01, help: 'Share of the tyre lean limit the rider uses: grip(lateral slip) (Risk).' },
  tcThreshold: { label: 'Traction control', min: 0, max: 1, step: 0.01, help: 'Slip traction control allows before cutting torque.' },
};

/** The per-corner editor's rows: the derived ranges, plus κ and slide out. */
export const CORNER_SLIDERS: Record<CornerRiderKey, SliderMeta> = {
  kappa: { label: 'Line C↔V', min: 0, max: 1, step: 0.01, help: 'Line shape in this corner: C (0) = a round arc that carries speed; V (1) = straight in, tight apex, straight out.' },
  slideOut: { label: 'Slide out', min: 0, max: 1, step: 0.05, help: 'Enter fast and let the bike slide wide before the apex; the slide scrubs speed. 0 = off.' },
  sBrake: ADVANCED.sBrake,
  sDrive: ADVANCED.sDrive,
  sLat: ADVANCED.sLat,
  leanUsage: ADVANCED.leanUsage,
  trailBrakeDepth: ADVANCED.trailBrakeDepth,
  trailBrakeProfile: ADVANCED.trailBrakeProfile,
  brakeRiseGps: ADVANCED.brakeRiseGps,
  throttleDelayS: ADVANCED.throttleDelayS,
  rollOnS: ADVANCED.rollOnS,
  rollRateFrac: ADVANCED.rollRateFrac,
};
