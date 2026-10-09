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
  /** Provenance note, e.g. "estimated from GPS" for a channel the file did not contain. */
  note?: string;
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
  /** speed where the bike starts turning in (lean rises past the threshold before the apex) */
  turnInKmh?: number;
  /** speed at brake onset / at throttle re-application */
  brakeKmh?: number;
  throttleKmh?: number;
  /** seconds spent in the turn */
  timeS?: number;
  /** timeS minus the best loaded lap's time in this turn (filled by the reports) */
  vsBestS?: number;
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
  /** Bundled example (Examples menu on the map); closed when real data is opened. */
  isExample?: boolean;
  /** Sample-index ranges of laps the user deleted; re-detected laps centred in one stay dropped. */
  deletedRanges?: Array<[number, number]>;
}

/** Optional fixed axis range; null/undefined bound = automatic. */
export interface AxisRange {
  min?: number | null;
  max?: number | null;
}

export interface ChartPanelConfig {
  id: string;
  channels: { name: string; axis: 'L' | 'R'; width?: number; fill?: 'zero' }[];
  /** Optional title shown in the panel head (templates use it). */
  title?: string;
  /** X axis of this panel only; absent = the workspace setting. */
  xAxis?: 'time' | 'distance';
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
  mathChannels: MathChannelDef[];
  mapLayers: Record<string, boolean>;
  /** Look of the per-turn gain/loss labels on the charts. */
  turnLabels?: TurnLabelStyle;
}

export interface TurnLabelStyle {
  /** on the charts (at the turn lines) */
  show: boolean;
  /** on the satellite map, next to each turn */
  onMap?: boolean;
  /** also show the apex-speed delta (km/h) against the best lap in that turn */
  speed?: boolean;
  size: number; // px
  gain: string; // faster than the best (−)
  loss: string; // slower (+)
  best: string;
  /** turn names on the map (K1…) */
  turnSize?: number;
  turnColor?: string;
  /** km/h labels next to apex / brake / throttle points */
  pointSize?: number;
}

export const DEFAULT_TURN_LABELS: TurnLabelStyle = { show: false, onMap: true, speed: true, size: 16, gain: '#00e676', loss: '#ff3d57', best: '#ffffff', turnSize: 15, turnColor: '#ffd166', pointSize: 13 };

/** A math channel: one formula for every lap, optionally overridden per lap (key = `${sessionId}:${lapN}`). */
export interface MathChannelDef {
  name: string;
  unit: string;
  expr: string;
  color: string;
  /** Formula for one run (session) only, keyed by session id; overrides `expr` there. */
  perSession?: Record<string, string>;
  perLap?: Record<string, string>;
}

/** A user-placed data marker: a fixed sample of one session, shown on every chart and the map. */
export interface DataMarker {
  id: string;
  name: string;
  color: string;
  sessionId: string;
  idx: number;
  /** Free-text note the user attached to the marker. */
  note?: string;
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
  turnLabels: { ...DEFAULT_TURN_LABELS },
  // point overlays (apex / turn-in / brake / throttle / gates / schema) start hidden: Layers menu turns them on
  mapLayers: {
    satellite: true, centerline: true, turns: true, trace: true,
    apex: false, turnin: false, brake: false, throttle: false, gates: false, schema: false,
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
