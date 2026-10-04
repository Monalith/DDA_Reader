// One-click presets: ready-made math channels and channel filters.
import type { ChannelProc } from './types';

export interface MathPreset {
  id: string;
  name: string; // channel name created
  label: string; // human title
  unit: string;
  color: string;
  expr: string;
  doc: string;
  needs: string[]; // channels that must exist
  group: 'Dynamics' | 'Rider inputs' | 'Engine' | 'GPS & lap' | 'Signal' | 'Flags';
}

export const MATH_PRESETS: MathPreset[] = [
  // Dynamics
  { id: 'long_g_wheel', name: 'long_g_wheel', label: 'Longitudinal G (wheel speed)', unit: 'g', color: '#ffd166',
    expr: 'accel_g(lowpass(speed, 1.5))', doc: 'Braking (−) and acceleration (+) from the filtered wheel speed.', needs: ['speed'], group: 'Dynamics' },
  { id: 'long_g_gps', name: 'long_g_gps', label: 'Longitudinal G (GPS speed)', unit: 'g', color: '#f4a261',
    expr: 'accel_g(lowpass(gps_speed, 1.0))', doc: 'Same as above from GPS speed; immune to wheel slip.', needs: ['gps_speed'], group: 'Dynamics' },
  { id: 'lat_g_est', name: 'lat_g_est', label: 'Lateral G estimate', unit: 'g', color: '#c77dff',
    expr: 'kmh2ms(speed)^2 / clamp(radius, 5, 2000) / g', doc: 'v²/r from speed and GPS corner radius.', needs: ['speed', 'radius'], group: 'Dynamics' },
  { id: 'total_g_est', name: 'total_g_est', label: 'Combined G', unit: 'g', color: '#ff6a00',
    expr: 'hypot(long_g, lat_g)', doc: 'Friction-circle magnitude.', needs: ['long_g', 'lat_g'], group: 'Dynamics' },
  { id: 'brake_dist_rate', name: 'speed_loss_rate', label: 'Speed loss rate', unit: 'km/h/s', color: '#ff4d6d',
    expr: 'max(0, 0 - deriv(lowpass(speed, 2)))', doc: 'How fast speed is being scrubbed (braking intensity).', needs: ['speed'], group: 'Dynamics' },
  // Rider inputs
  { id: 'tps_rate', name: 'tps_rate', label: 'Throttle rate', unit: '%/s', color: '#3ddc84',
    expr: 'deriv(smooth(tps, 3))', doc: 'How quickly the throttle is opened or closed.', needs: ['tps'], group: 'Rider inputs' },
  { id: 'lean_rate', name: 'lean_rate', label: 'Lean rate', unit: 'deg/s', color: '#4dd0e1',
    expr: 'deriv(lowpass(lean, 2))', doc: 'Roll speed: how fast the bike is flicked into / out of a corner.', needs: ['lean'], group: 'Rider inputs' },
  { id: 'lean_abs', name: 'lean_abs', label: 'Absolute lean', unit: 'deg', color: '#3da5ff',
    expr: 'abs(lean)', doc: 'Lean angle without side sign.', needs: ['lean'], group: 'Rider inputs' },
  { id: 'coasting', name: 'coasting', label: 'Coasting flag', unit: '', color: '#8b95a5',
    expr: 'where(tps < 3 && long_g > -0.15 && speed > 40, 1, 0)', doc: '1 when neither braking nor on throttle at speed.', needs: ['tps', 'long_g', 'speed'], group: 'Rider inputs' },
  { id: 'trail_brake', name: 'trail_brake', label: 'Trail-braking flag', unit: '', color: '#ff4d4f',
    expr: 'where(long_g < -0.2 && abs(lean) > 25, 1, 0)', doc: 'Braking while already leaned over.', needs: ['long_g', 'lean'], group: 'Rider inputs' },
  { id: 'throttle_lean', name: 'throttle_at_lean', label: 'Throttle while leaned', unit: '%', color: '#3ddc84',
    expr: 'where(abs(lean) > 30, tps, 0)', doc: 'Throttle opening only while lean angle exceeds 30°.', needs: ['lean', 'tps'], group: 'Rider inputs' },
  // Engine
  { id: 'gear_ratio', name: 'gear_ratio', label: 'RPM per km/h', unit: 'rpm/kmh', color: '#ffd166',
    expr: 'where(speed > 30, rpm / speed, 0)', doc: 'Constant per gear; steps show shifts, dips show clutch slip/wheelspin.', needs: ['rpm', 'speed'], group: 'Engine' },
  { id: 'rpm_rate', name: 'rpm_rate', label: 'RPM rate', unit: 'rpm/s', color: '#f4a261',
    expr: 'deriv(smooth(rpm, 3))', doc: 'Engine acceleration; negative spikes = downshifts.', needs: ['rpm'], group: 'Engine' },
  { id: 'rpm_pct', name: 'rpm_pct', label: 'RPM % of redline', unit: '%', color: '#ff6a00',
    expr: 'rpm / 14500 * 100', doc: 'Edit the redline constant for your bike.', needs: ['rpm'], group: 'Engine' },
  { id: 'shift_up', name: 'shift_up', label: 'Upshift events', unit: '', color: '#3ddc84',
    expr: 'rising(diff(gear) > 0)', doc: '1 on the sample of each upshift.', needs: ['gear'], group: 'Engine' },
  { id: 'shift_down', name: 'shift_down', label: 'Downshift events', unit: '', color: '#ff4d6d',
    expr: 'rising(diff(gear) < 0)', doc: '1 on the sample of each downshift.', needs: ['gear'], group: 'Engine' },
  // GPS & lap
  { id: 'slip_pct', name: 'slip_est', label: 'Wheel slip %', unit: '%', color: '#ff4d4f',
    expr: 'where(gps_speed > 30, (speed - gps_speed) / gps_speed * 100, 0)', doc: 'Rear wheel speed vs GPS ground speed.', needs: ['speed', 'gps_speed'], group: 'GPS & lap' },
  { id: 'vmin_lap', name: 'v_min_lap', label: 'Lap minimum speed', unit: 'km/h', color: '#8b95a5',
    expr: 'lap_min(speed)', doc: 'Slowest point of each lap, as a flat line.', needs: ['speed'], group: 'GPS & lap' },
  { id: 'v_vs_lapavg', name: 'v_vs_lap_avg', label: 'Speed vs lap average', unit: 'km/h', color: '#3da5ff',
    expr: 'speed - lap_mean(speed)', doc: 'Positive on straights, negative in corners.', needs: ['speed'], group: 'GPS & lap' },
  { id: 'lap_elapsed', name: 'lap_elapsed', label: 'Lap elapsed time', unit: 's', color: '#e6e9ef',
    expr: 'lap_time(speed)', doc: 'Seconds since the lap started.', needs: ['speed'], group: 'GPS & lap' },
  { id: 'alt_rate', name: 'climb_rate', label: 'Climb rate', unit: 'm/s', color: '#4dd0e1',
    expr: 'deriv(lowpass(gps_alt, 0.3))', doc: 'Elevation change rate from GPS altitude.', needs: ['gps_alt'], group: 'GPS & lap' },
  // Signal
  { id: 'speed_smooth', name: 'speed_smooth', label: 'Speed (1 Hz low-pass)', unit: 'km/h', color: '#ffb703',
    expr: 'lowpass(speed, 1)', doc: 'Clean speed trace for overlays.', needs: ['speed'], group: 'Signal' },
  { id: 'speed_hf', name: 'speed_chatter', label: 'Speed high-frequency', unit: 'km/h', color: '#8b95a5',
    expr: 'highpass(speed, 2)', doc: 'Fast wheel-speed oscillation: chatter, bumps, slip.', needs: ['speed'], group: 'Signal' },
  { id: 'lean_sg', name: 'lean_sg', label: 'Lean (Savitzky-Golay 9)', unit: 'deg', color: '#c77dff',
    expr: 'sg(lean, 9)', doc: 'Smooth lean that keeps the peaks.', needs: ['lean'], group: 'Signal' },
  // Flags
  { id: 'wot', name: 'wot', label: 'Wide-open throttle', unit: '', color: '#3ddc84',
    expr: 'where(tps >= 95, 1, 0)', doc: '1 at full throttle.', needs: ['tps'], group: 'Flags' },
  { id: 'braking', name: 'braking', label: 'Braking flag', unit: '', color: '#ff4d4f',
    expr: 'where(long_g < -0.25, 1, 0)', doc: '1 while decelerating harder than 0.25 g.', needs: ['long_g'], group: 'Flags' },
  { id: 'tc_active', name: 'tc_active', label: 'Traction control active', unit: '', color: '#ffd166',
    expr: 'where(tq_fast > 0 || tq_slow > 0, 1, 0)', doc: '1 when the ECU is cutting torque.', needs: ['tq_fast', 'tq_slow'], group: 'Flags' },
];

export interface FilterPreset {
  id: string;
  label: string;
  doc: string;
  /** channels it is meant for (empty = any) */
  forChannels: string[];
  proc: Partial<ChannelProc>;
}

export const FILTER_PRESETS: FilterPreset[] = [
  { id: 'none', label: 'Raw (no filter)', doc: 'Remove any filter.', forChannels: [], proc: { filter: { type: 'none' } } },
  { id: 'lp_speed', label: 'Speed: Butterworth 1 Hz', doc: 'Removes wheel-speed noise, keeps braking points.', forChannels: ['speed', 'gps_speed'], proc: { filter: { type: 'butter', cutoffHz: 1 } } },
  { id: 'lp_speed_fast', label: 'Speed: Butterworth 2.5 Hz', doc: 'Light smoothing.', forChannels: ['speed', 'gps_speed'], proc: { filter: { type: 'butter', cutoffHz: 2.5 } } },
  { id: 'ma_lean', label: 'Lean: moving average 5', doc: 'Half-second average for lean angle.', forChannels: ['lean'], proc: { filter: { type: 'ma', n: 5 } } },
  { id: 'sg_lean', label: 'Lean: Savitzky-Golay 9', doc: 'Smooths while preserving max-lean peaks.', forChannels: ['lean'], proc: { filter: { type: 'sg', n: 9 } } },
  { id: 'ma_tps', label: 'Throttle: moving average 3', doc: 'Removes sensor steps.', forChannels: ['tps'], proc: { filter: { type: 'ma', n: 3 } } },
  { id: 'lp_rpm', label: 'RPM: Butterworth 3 Hz', doc: 'Removes ignition ripple.', forChannels: ['rpm'], proc: { filter: { type: 'butter', cutoffHz: 3 } } },
  { id: 'ma3', label: 'Any: moving average 3', doc: 'Generic light smoothing.', forChannels: [], proc: { filter: { type: 'ma', n: 3 } } },
  { id: 'ma9', label: 'Any: moving average 9', doc: 'Generic heavy smoothing.', forChannels: [], proc: { filter: { type: 'ma', n: 9 } } },
  { id: 'lp05', label: 'Any: Butterworth 0.5 Hz', doc: 'Trend only.', forChannels: [], proc: { filter: { type: 'butter', cutoffHz: 0.5 } } },
  { id: 'gps_blend', label: 'Speed: GPS/wheel blend', doc: 'Wheel at low speed, GPS at high speed.', forChannels: ['speed'], proc: { source: 'blend' } },
  { id: 'gps_only', label: 'Speed: GPS source', doc: 'Use GPS ground speed as the speed channel.', forChannels: ['speed'], proc: { source: 'gps' } },
];

export function presetsForChannel(name: string): FilterPreset[] {
  return FILTER_PRESETS.filter((p) => !p.forChannels.length || p.forChannels.includes(name));
}
