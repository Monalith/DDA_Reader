// Chart templates: ready-made panel layouts. The "vs reference" ones work like a stock
// chart — the d_* channels (lap minus the reference lap at the same distance) are drawn
// with a zero line and green/red fill, so gains and losses jump out.
import type { ChartPanelConfig } from './types';

export interface ChartTemplate {
  id: string;
  label: string;
  doc: string;
  panels: ChartPanelConfig[];
}

const z = (name: string, axis: 'L' | 'R' = 'L'): ChartPanelConfig['channels'][number] => ({ name, axis, fill: 'zero' });
const c = (name: string, axis: 'L' | 'R' = 'L'): ChartPanelConfig['channels'][number] => ({ name, axis });

export const CHART_TEMPLATES: ChartTemplate[] = [
  {
    id: 'default',
    label: 'Default',
    doc: 'Speed, rpm, throttle + long g, lean, delta time, gear.',
    panels: [
      { id: 'p1', channels: [c('speed'), c('gps_speed')] },
      { id: 'p2', channels: [c('rpm')] },
      { id: 'p3', channels: [c('tps'), c('long_g', 'R')] },
      { id: 'p4', channels: [c('lean')] },
      { id: 'p5', channels: [c('delta_t')] },
      { id: 'p6', channels: [c('gear')] },
    ],
  },
  {
    id: 'vs-ref',
    label: 'Δ vs reference (stock style)',
    doc: 'Every lap minus the reference lap: time, speed, throttle, lean and long g deltas with green/red fill. Pick the reference lap (◉) first.',
    panels: [
      { id: 't1', title: 'Δ time vs reference (s) — below zero = faster', channels: [z('delta_t')], lineWidth: 2 },
      { id: 't2', title: 'Δ speed vs reference (km/h)', channels: [z('d_speed')], lineWidth: 2 },
      { id: 't3', title: 'Δ throttle (%)', channels: [z('d_tps')] },
      { id: 't4', title: 'Δ lean (deg)', channels: [z('d_lean')] },
      { id: 't5', title: 'Δ long g', channels: [z('d_long_g')] },
    ],
  },
  {
    id: 'delta-time-distance',
    label: 'Δ lap time vs distance',
    doc: 'Time gained/lost against the reference lap along the track (x = lap distance). Below zero = faster.',
    panels: [
      { id: 'dt1', title: 'Δ lap time vs reference (s) — x: distance', channels: [z('delta_t')], lineWidth: 2, xAxis: 'distance' },
      { id: 'dt2', title: 'Speed (km/h)', channels: [c('speed')], xAxis: 'distance' },
    ],
  },
  {
    id: 'delta-distance-time',
    label: 'Δ distance vs lap time',
    doc: 'Metres ahead (+) or behind (−) the reference lap at the same lap time (x = lap time).',
    panels: [
      { id: 'dd1', title: 'Δ distance vs reference (m) — x: lap time', channels: [z('delta_d')], lineWidth: 2, xAxis: 'time' },
      { id: 'dd2', title: 'Speed (km/h) — x: lap time', channels: [c('speed')], xAxis: 'time' },
    ],
  },
  {
    id: 'delta-both',
    label: 'Δ time (distance) + Δ distance (time)',
    doc: 'Both delta views together: Δ lap time over distance and Δ distance over lap time, each panel on its own x axis.',
    panels: [
      { id: 'db1', title: 'Δ lap time vs reference (s) — x: distance', channels: [z('delta_t')], lineWidth: 2, xAxis: 'distance' },
      { id: 'db2', title: 'Δ distance vs reference (m) — x: lap time', channels: [z('delta_d')], lineWidth: 2, xAxis: 'time' },
      { id: 'db3', title: 'Δ speed vs reference (km/h)', channels: [z('d_speed')], xAxis: 'distance' },
    ],
  },
  {
    id: 'speed-vs-ref',
    label: 'Speed vs reference',
    doc: 'Speed traces of every lap with the Δ speed stock panel and Δ time underneath.',
    panels: [
      { id: 's1', title: 'Speed (km/h)', channels: [c('speed')], lineWidth: 2 },
      { id: 's2', title: 'Δ speed vs reference (km/h)', channels: [z('d_speed')], lineWidth: 2 },
      { id: 's3', title: 'Δ time vs reference (s)', channels: [z('delta_t')] },
    ],
  },
  {
    id: 'braking',
    label: 'Braking',
    doc: 'Speed, long g with zero line, throttle, gear and Δ time — where the time is won under braking.',
    panels: [
      { id: 'b1', channels: [c('speed')] },
      { id: 'b2', title: 'Long g (negative = braking)', channels: [z('long_g')] },
      { id: 'b3', channels: [c('tps'), c('gear', 'R')] },
      { id: 'b4', title: 'Δ time vs reference (s)', channels: [z('delta_t')] },
    ],
  },
  {
    id: 'cornering',
    label: 'Cornering',
    doc: 'Lean, lateral g, Δ lean vs reference, speed and throttle.',
    panels: [
      { id: 'c1', channels: [c('lean')] },
      { id: 'c2', title: 'Lateral g', channels: [z('lat_g')] },
      { id: 'c3', title: 'Δ lean vs reference (deg)', channels: [z('d_lean')] },
      { id: 'c4', channels: [c('speed'), c('tps', 'R')] },
    ],
  },
  {
    id: 'engine',
    label: 'Engine & traction',
    doc: 'rpm, Δ rpm vs reference, gear, torque reduction and slip.',
    panels: [
      { id: 'e1', channels: [c('rpm'), c('gear', 'R')] },
      { id: 'e2', title: 'Δ rpm vs reference', channels: [z('d_rpm')] },
      { id: 'e3', channels: [c('tq_fast'), c('tq_slow')] },
      { id: 'e4', title: 'Slip (%)', channels: [z('slip')] },
    ],
  },
  {
    id: 'gps',
    label: 'GPS vs wheel',
    doc: 'Wheel vs GPS speed, smoothed GPS, slip and altitude.',
    panels: [
      { id: 'g1', channels: [c('speed'), c('gps_speed'), c('gps_smooth')] },
      { id: 'g2', title: 'Slip (%)', channels: [z('slip')] },
      { id: 'g3', channels: [c('gps_alt')] },
    ],
  },
];

export function templateById(id: string): ChartTemplate | undefined {
  return CHART_TEMPLATES.find((t) => t.id === id);
}

/** Fresh copies with unique ids, so applying a template twice never collides. */
export function templatePanels(t: ChartTemplate): ChartPanelConfig[] {
  const stamp = Date.now().toString(36);
  return t.panels.map((p) => ({ ...p, id: `${p.id}-${stamp}`, channels: p.channels.map((ch) => ({ ...ch })) }));
}
