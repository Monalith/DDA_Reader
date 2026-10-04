// Shared data model for DDA Lab. Keep in sync with docs/superpowers/plans/2026-10-04-dda-lab.md.
export type LngLat = [number, number]; // [lng, lat]
export type ChannelKind = 'raw' | 'derived' | 'math' | 'external';

export interface FilterSpec {
  type: 'none' | 'ma' | 'sg' | 'butter';
  n?: number;
  cutoffHz?: number;
}

export interface ChannelProc {
  source?: 'wheel' | 'gps' | 'blend';
  scale: number;
  offset: number;
  filter: FilterSpec;
  gpsLagS?: number;
  invert?: boolean;
}

export const DEFAULT_PROC: ChannelProc = { scale: 1, offset: 0, filter: { type: 'none' } };

export interface Channel {
  name: string;
  unit: string;
  kind: ChannelKind;
  color?: string;
  data: Float32Array; // on session.t (10 Hz)
  raw?: { t: Float64Array; v: Float32Array }; // native rate (e.g. RPM 50 Hz)
  proc: ChannelProc;
  expr?: string; // math channels
}

export interface Gate {
  id: string;
  name: string;
  type: 'sf' | 'split';
  at: LngLat;
  bearingDeg: number;
  halfWidthM: number;
}

export interface Lap {
  n: number;
  startIdx: number;
  endIdx: number;
  timeS: number;
  sectorsS: number[];
  isBest: boolean;
  kind: 'flying' | 'out' | 'in';
}

export interface TurnMetrics {
  lap: number;
  turn: number;
  entryKmh: number;
  apexKmh: number;
  exitKmh: number;
  maxLeanDeg: number;
  brakeDistM: number;
  throttleOnDistM: number;
  apexDevM?: number;
}

export interface Turn {
  n: number;
  name: string;
  dir: 'L' | 'R';
  apexGeo: LngLat;
  radiusM: number;
  sRange: [number, number];
}

export interface SchemaPoint {
  x: number;
  y: number;
}

export interface SchemaLayer {
  imageDataUrl: string;
  affine: [number, number, number, number, number, number] | null;
  apexes: (SchemaPoint & { turn?: number; label?: string })[];
  racingLine: SchemaPoint[];
  trackOutline: SchemaPoint[];
  markers: (SchemaPoint & { type: 'brake' | 'throttle' | 'note'; text?: string })[];
  startFinish?: SchemaPoint;
  turnLabels: (SchemaPoint & { n: number })[];
}

export interface TrackModel {
  id: string;
  name: string;
  center: LngLat;
  centerline: LngLat[];
  cumDistM: Float64Array;
  lengthM: number;
  startFinish: Gate;
  sectors: Gate[];
  turns: Turn[];
  schema?: SchemaLayer;
}

/** Turn geometry carried by an imported file (e.g. a track-map telemetry JSON). */
export interface TurnHint {
  name: string;
  dir: 'L' | 'R';
  apexGeo: LngLat;
  startGeo: LngLat;
  endGeo: LngLat;
  brakeGeo?: LngLat;
}

export interface Session {
  id: string;
  name: string;
  source: 'dda' | 'json' | 'csv';
  color: string;
  t: Float64Array;
  channels: Map<string, Channel>;
  laps: Lap[];
  meta: { track: string; rider: string; note: string };
  /** Optional turn definitions and start/finish point from the source file. */
  turnHints?: TurnHint[];
  sfHint?: LngLat;
  /** Laps came from the file itself (not from gates/beacon): keep them when the start line moves. */
  lapsFromFile?: boolean;
}

/** Optional fixed axis range; null/undefined bound = automatic. */
export interface AxisRange {
  min?: number | null;
  max?: number | null;
}

export interface ChartPanelConfig {
  id: string;
  channels: { name: string; axis: 'L' | 'R'; width?: number }[];
  /** Left / right Y axis ranges (auto when absent). */
  yL?: AxisRange;
  yR?: AxisRange;
  /** X axis: linked to the shared zoom (default) or an independent range. */
  x?: { linked: boolean; min?: number | null; max?: number | null };
  /** Default line width for the panel (px). */
  lineWidth?: number;
}

export interface Workspace {
  version: 1;
  xAxis: 'time' | 'distance';
  unitMph: boolean;
  splitPct: number;
  panels: ChartPanelConfig[];
  mathChannels: { name: string; unit: string; expr: string; color: string }[];
  mapLayers: Record<string, boolean>;
}

export const DEFAULT_WORKSPACE: Workspace = {
  version: 1,
  xAxis: 'distance',
  unitMph: false,
  splitPct: 62,
  panels: [
    { id: 'p1', channels: [{ name: 'speed', axis: 'L' }, { name: 'gps_speed', axis: 'L' }] },
    { id: 'p2', channels: [{ name: 'rpm', axis: 'L' }] },
    { id: 'p3', channels: [{ name: 'tps', axis: 'L' }, { name: 'long_g', axis: 'R' }] },
    { id: 'p4', channels: [{ name: 'lean', axis: 'L' }] },
    { id: 'p5', channels: [{ name: 'delta_t', axis: 'L' }] },
    { id: 'p6', channels: [{ name: 'gear', axis: 'L' }] },
  ],
  mathChannels: [],
  mapLayers: {
    satellite: true, centerline: true, turns: true, apex: true, brake: true,
    throttle: true, gates: true, trace: true, schema: true,
  },
};

/** Canonical raw channel names produced by the .dda decoder (DDA+ GPS 1714 set). */
export const RAW_CHANNEL_NAMES = [
  'speed', 'rpm', 'tps', 'dist', 'gear', 'lean', 'tq_fast', 'tq_slow',
  'gps_alt', 'gps_lon', 'gps_lat', 'lap_mark', 'int1', 'int2',
] as const;

/** Map from DDA descriptor names to canonical channel names + units. */
export const DDA_NAME_MAP: Record<string, { name: string; unit: string }> = {
  SPEED: { name: 'speed', unit: 'km/h' },
  RPM: { name: 'rpm', unit: 'rpm' },
  GAS: { name: 'tps', unit: '%' },
  DIST: { name: 'dist', unit: 'km' },
  GEAR: { name: 'gear', unit: '' },
  PSI_LEAN_ANGLE: { name: 'lean', unit: 'deg' },
  TORQUE_FAST: { name: 'tq_fast', unit: '%' },
  TORQUE_SLOW: { name: 'tq_slow', unit: '%' },
  GPS_ALT: { name: 'gps_alt', unit: 'm' },
  GPS_LON: { name: 'gps_lon', unit: 'deg' },
  GPS_LAT: { name: 'gps_lat', unit: 'deg' },
  LAP: { name: 'lap_mark', unit: 's' },
  INT_LAP1: { name: 'int1', unit: 's' },
  INT_LAP2: { name: 'int2', unit: 's' },
  TEMP: { name: 'temp', unit: '°C' },
  DTC: { name: 'dtc', unit: '%' },
};
