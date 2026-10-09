// GeoJSON builders for the map pane. Pure functions, no DOM / MapLibre import,
// so they are unit-testable in the node environment.
//
// Everything consumes the canonical channel names ('gps_lon', 'gps_lat',
// 'speed', 'tps', 'lean', 'long_g') and degrades gracefully when a channel is
// missing (empty FeatureCollection instead of throwing).
import type { Feature, FeatureCollection, LineString, Point } from 'geojson';
import { applyAffine } from '../core/affine';
import { haversineM } from '../core/geo';
import { TURN_IN_APPROACH_M, TURN_IN_LEAN_DEG, turnInIndex } from '../core/track';
import type { Lap, LngLat, Session, TrackModel, TurnMetrics } from '../core/types';

export type ColorBy = 'speed' | 'tps' | 'lean' | 'brake' | 'solid';

export type TraceProps = {
  color: string;
  idx: number;
  sessionId: string;
  lap: number;
};

export type MarkerProps = {
  kind: 'apex' | 'brake' | 'throttle' | 'turn' | 'turnin';
  /** lap tag + colour for multi-lap marker sets */
  lapTag?: string;
  color?: string;
  /** label offset [x, y] in em: laps stack downwards so their labels never overlap */
  offset?: [number, number];
  /** speed at the point (km/h) */
  kmh?: number;
  /** track distance of the point (m from the start line) */
  sM?: number;
  turn: number;
  label: string;
};

const NEUTRAL = '#5a6676'; // non-braking segments in 'brake' colour mode

/** Colour ramp stops: blue -> green -> yellow -> red. */
const RAMP: Array<[number, [number, number, number]]> = [
  [0, [32, 96, 255]],
  [1 / 3, [0, 200, 120]],
  [2 / 3, [255, 210, 0]],
  [1, [255, 40, 40]],
];

function hex(rgb: [number, number, number]): string {
  return `#${rgb.map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Map a value in [min,max] onto a blue -> green -> yellow -> red ramp.
 * Values outside the range clamp to the end stops; NaN yields the low stop.
 */
export function rampColor(v: number, min: number, max: number): string {
  const span = max - min;
  let t = span > 0 && Number.isFinite(v) ? (v - min) / span : 0;
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < RAMP.length; i++) {
    const [t1, c1] = RAMP[i];
    if (t <= t1 || i === RAMP.length - 1) {
      const [t0, c0] = RAMP[i - 1];
      const u = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
      return hex([
        c0[0] + (c1[0] - c0[0]) * u,
        c0[1] + (c1[1] - c0[1]) * u,
        c0[2] + (c1[2] - c0[2]) * u,
      ]);
    }
  }
  return hex(RAMP[0][1]);
}

function chan(s: Session, name: string): Float32Array | undefined {
  return s.channels.get(name)?.data;
}

function finiteRange(v: Float32Array, from: number, to: number): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (let i = from; i <= to && i < v.length; i++) {
    const x = v[i];
    if (!Number.isFinite(x)) continue;
    if (x < min) min = x;
    if (x > max) max = x;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [0, 1];
  return [min, max];
}

/** Braking intensity colour: light orange at -0.15 g, saturated red at -1.0 g. */
function brakeColor(g: number): string {
  if (!Number.isFinite(g) || g >= -0.15) return NEUTRAL;
  const u = Math.max(0, Math.min(1, (-g - 0.15) / 0.85));
  return hex([255, Math.round(150 - 150 * u), Math.round(100 - 100 * u)]);
}

/**
 * One LineString feature per consecutive GPS pair of a lap, each carrying a
 * 'color' property (used with `line-color: ['get','color']`).
 */
export function traceGeoJson(
  s: Session,
  lap: Lap,
  colorBy: ColorBy,
  solidColor?: string,
): FeatureCollection<LineString, TraceProps> {
  const lng = chan(s, 'gps_lon');
  const lat = chan(s, 'gps_lat');
  const features: Array<Feature<LineString, TraceProps>> = [];
  if (!lng || !lat) return { type: 'FeatureCollection', features };

  const last = Math.min(lap.endIdx, lng.length - 1, lat.length - 1);
  let value: Float32Array | undefined;
  let lo = 0;
  let hi = 1;
  if (colorBy === 'speed') {
    value = chan(s, 'speed');
    if (value) [lo, hi] = finiteRange(value, lap.startIdx, last);
  } else if (colorBy === 'tps') {
    value = chan(s, 'tps');
    lo = 0;
    hi = 100;
  } else if (colorBy === 'lean') {
    value = chan(s, 'lean');
    lo = 0;
    hi = 55;
  } else if (colorBy === 'brake') {
    value = chan(s, 'long_g');
  }

  for (let i = lap.startIdx; i < last; i++) {
    const a: LngLat = [lng[i], lat[i]];
    const b: LngLat = [lng[i + 1], lat[i + 1]];
    if (!a.every(Number.isFinite) || !b.every(Number.isFinite)) continue;
    let color = solidColor ?? s.color;
    if (colorBy === 'brake') color = value ? brakeColor(value[i]) : NEUTRAL;
    else if (colorBy !== 'solid' && value) {
      const v = colorBy === 'lean' ? Math.abs(value[i]) : value[i];
      color = rampColor(v, lo, hi);
    }
    features.push({
      type: 'Feature',
      properties: { color, idx: i, sessionId: s.id, lap: lap.n },
      geometry: { type: 'LineString', coordinates: [a, b] },
    });
  }
  return { type: 'FeatureCollection', features };
}

/** Averaged track centerline as a single LineString. */
export function centerlineGeoJson(t: TrackModel): Feature<LineString, { name: string }> {
  return {
    type: 'Feature',
    properties: { name: t.name },
    geometry: { type: 'LineString', coordinates: t.centerline.map((p) => [p[0], p[1]]) },
  };
}

/**
 * Distance along the centerline of the nearest centerline vertex to `p`.
 * Local equivalent of core/track.projectToTrack, kept here so the GeoJSON
 * builders stay dependency-free.
 */
function projectS(t: TrackModel, p: LngLat): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < t.centerline.length; i++) {
    const d = haversineM(t.centerline[i], p);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return t.cumDistM[best] ?? 0;
}

function inRange(sM: number, range: [number, number], lengthM: number): boolean {
  const [a, b] = range;
  if (a <= b) return sM >= a && sM <= b;
  // wrapped range across the start/finish line
  return sM >= a || sM <= b || (lengthM > 0 && sM >= a - lengthM);
}

function pointFeature(at: LngLat, props: MarkerProps): Feature<Point, MarkerProps> {
  return { type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [at[0], at[1]] } };
}

/**
 * Turn numbers plus the dynamic apex / brake-point / throttle-on positions of
 * one lap.
 *
 * - apex: sample with the minimum speed inside the turn's sRange
 * - brake: first sample before the apex with long_g < -0.3 (walking backwards)
 * - throttle: first sample after the apex with tps > 20
 */
export function markersGeoJson(
  t: TrackModel,
  metrics: TurnMetrics[],
  s: Session,
  lap: Lap,
  opts: { lapTag?: string; color?: string; turnLabels?: boolean; row?: number } = {},
): FeatureCollection<Point, MarkerProps> {
  const features: Array<Feature<Point, MarkerProps>> = [];
  const tag = opts.lapTag ? `${opts.lapTag} ` : '';
  const color = opts.color;
  const row = opts.row ?? 0;
  const off = (dir: 1 | -1): [number, number] => [0.8 * dir, row * 1.15];
  if (opts.turnLabels !== false) {
    for (const turn of t.turns) {
      features.push(pointFeature(turn.apexGeo, { kind: 'turn', turn: turn.n, label: turn.name && turn.name !== `T${turn.n}` ? `${turn.n} ${turn.name}` : String(turn.n) }));
    }
  }

  const lng = chan(s, 'gps_lon');
  const lat = chan(s, 'gps_lat');
  const speed = chan(s, 'speed');
  if (!lng || !lat || !t.centerline.length) return { type: 'FeatureCollection', features };
  const longG = chan(s, 'long_g');
  const tps = chan(s, 'tps');
  const lean = chan(s, 'lean');
  const curvature = chan(s, 'curvature');
  const kmh = (i: number): string => (speed && Number.isFinite(speed[i]) ? `${Math.round(speed[i])}` : '');
  const kmhNum = (i: number): number | undefined => (speed && Number.isFinite(speed[i]) ? speed[i] : undefined);
  const last = Math.min(lap.endIdx, lng.length - 1, lat.length - 1);

  // One projection pass over the lap samples.
  const sAt = new Float64Array(Math.max(0, last - lap.startIdx + 1)).fill(NaN);
  for (let i = lap.startIdx; i <= last; i++) {
    if (!Number.isFinite(lng[i]) || !Number.isFinite(lat[i])) continue;
    sAt[i - lap.startIdx] = projectS(t, [lng[i], lat[i]]);
  }

  const wanted = metrics.length ? new Set(metrics.map((m) => m.turn)) : new Set(t.turns.map((x) => x.n));
  let prevApex = -1;
  for (const turn of t.turns) {
    if (!wanted.has(turn.n)) continue;
    let apexIdx = -1;
    let apexSpeed = Infinity;
    let maxLean = 0;
    let iApproach = lap.startIdx;
    let approachFound = false;
    for (let i = lap.startIdx; i <= last; i++) {
      const sM = sAt[i - lap.startIdx];
      if (!approachFound && Number.isFinite(sM) && inRange(sM, [turn.sRange[0] - TURN_IN_APPROACH_M, turn.sRange[1]], t.lengthM)) {
        iApproach = i;
        approachFound = true;
      }
      if (!Number.isFinite(sM) || !inRange(sM, turn.sRange, t.lengthM)) continue;
      if (lean && Number.isFinite(lean[i])) maxLean = Math.max(maxLean, Math.abs(lean[i]));
      const v = speed ? speed[i] : 0;
      if (!Number.isFinite(v)) continue;
      if (v < apexSpeed) {
        apexSpeed = v;
        apexIdx = i;
      }
    }
    if (apexIdx < 0) continue;
    features.push(
      pointFeature([lng[apexIdx], lat[apexIdx]], {
        kind: 'apex',
        turn: turn.n,
        label: Number.isFinite(apexSpeed) ? `${tag}${Math.round(apexSpeed)}` : '',
        lapTag: opts.lapTag,
        color,
        offset: off(1),
        kmh: Number.isFinite(apexSpeed) ? apexSpeed : undefined,
        sM: sAt[apexIdx - lap.startIdx],
      }),
    );
    // turn-in point: where the lean rises past the threshold before the apex
    const iTI = turnInIndex(lean, curvature, 0, apexIdx, lng.length, Math.max(prevApex + 1, iApproach), Math.max(TURN_IN_LEAN_DEG, 0.3 * maxLean));
    if (iTI >= 0 && iTI !== apexIdx && Number.isFinite(lng[iTI]) && Number.isFinite(lat[iTI])) {
      features.push(pointFeature([lng[iTI], lat[iTI]], { kind: 'turnin', turn: turn.n, label: `${tag}${kmh(iTI)}`, lapTag: opts.lapTag, color, offset: off(1), kmh: kmhNum(iTI), sM: sAt[iTI - lap.startIdx] }));
    }

    if (longG) {
      const floor = Math.max(lap.startIdx, prevApex);
      for (let i = apexIdx; i > floor; i--) {
        if (longG[i] < -0.3) {
          if (Number.isFinite(lng[i]) && Number.isFinite(lat[i])) {
            // brake onset = start of this braking run (never before the previous apex)
            let o = i;
            while (o - 1 > floor && longG[o - 1] < -0.3) o--;
            const bi = Number.isFinite(lng[o]) && Number.isFinite(lat[o]) ? o : i;
            features.push(pointFeature([lng[bi], lat[bi]], { kind: 'brake', turn: turn.n, label: `${tag}${kmh(bi)}`, lapTag: opts.lapTag, color, offset: off(-1), kmh: kmhNum(bi), sM: sAt[bi - lap.startIdx] }));
          }
          break;
        }
      }
    }
    if (tps) {
      for (let i = apexIdx; i <= last; i++) {
        if (tps[i] > 20) {
          if (Number.isFinite(lng[i]) && Number.isFinite(lat[i])) {
            features.push(pointFeature([lng[i], lat[i]], { kind: 'throttle', turn: turn.n, label: `${tag}${kmh(i)}`, lapTag: opts.lapTag, color, offset: off(1), kmh: kmhNum(i), sM: sAt[i - lap.startIdx] }));
          }
          break;
        }
      }
    }
    prevApex = apexIdx;
  }
  return { type: 'FeatureCollection', features };
}

/** Start/finish + sector gates as short lines of 2*halfWidthM across the track. */
export function gatesGeoJson(t: TrackModel): FeatureCollection<LineString, { id: string; name: string; type: string }> {
  const R = 6371008.8;
  const D2R = Math.PI / 180;
  const gates = [t.startFinish, ...t.sectors].filter(Boolean);
  return {
    type: 'FeatureCollection',
    features: gates.map((g) => {
      const th = g.bearingDeg * D2R;
      const dLat = ((Math.cos(th) * g.halfWidthM) / R) / D2R;
      const dLng = ((Math.sin(th) * g.halfWidthM) / (R * Math.cos(g.at[1] * D2R))) / D2R;
      return {
        type: 'Feature' as const,
        properties: { id: g.id, name: g.name, type: g.type },
        geometry: {
          type: 'LineString' as const,
          coordinates: [
            [g.at[0] - dLng, g.at[1] - dLat],
            [g.at[0] + dLng, g.at[1] + dLat],
          ],
        },
      };
    }),
  };
}

export type SchemaProps = {
  kind: 'outline' | 'racingLine' | 'schemaApex' | 'schemaMarker' | 'schemaSF' | 'schemaTurn';
  label: string;
  mtype?: string;
};

/**
 * The imported coach schema (racing line, outline, apexes, markers) transformed
 * from normalized image coordinates (0..1, origin top-left) to [lng,lat] with
 * `track.schema.affine`. Empty when no schema or no fitted affine.
 */
export function schemaGeoJson(t: TrackModel): FeatureCollection<LineString | Point, SchemaProps> {
  const features: Array<Feature<LineString | Point, SchemaProps>> = [];
  const schema = t.schema;
  if (!schema || !schema.affine) return { type: 'FeatureCollection', features };
  const A = schema.affine;
  const xf = (p: { x: number; y: number }): [number, number] => applyAffine(A, [p.x, p.y]);

  if (schema.trackOutline.length > 1) {
    features.push({
      type: 'Feature',
      properties: { kind: 'outline', label: '' },
      geometry: { type: 'LineString', coordinates: schema.trackOutline.map(xf) },
    });
  }
  if (schema.racingLine.length > 1) {
    features.push({
      type: 'Feature',
      properties: { kind: 'racingLine', label: '' },
      geometry: { type: 'LineString', coordinates: schema.racingLine.map(xf) },
    });
  }
  for (const a of schema.apexes) {
    features.push({
      type: 'Feature',
      properties: { kind: 'schemaApex', label: a.label ?? (a.turn != null ? String(a.turn) : '') },
      geometry: { type: 'Point', coordinates: xf(a) },
    });
  }
  for (const m of schema.markers) {
    features.push({
      type: 'Feature',
      properties: { kind: 'schemaMarker', label: m.text ?? '', mtype: m.type },
      geometry: { type: 'Point', coordinates: xf(m) },
    });
  }
  if (schema.startFinish) {
    features.push({
      type: 'Feature',
      properties: { kind: 'schemaSF', label: 'S/F' },
      geometry: { type: 'Point', coordinates: xf(schema.startFinish) },
    });
  }
  for (const l of schema.turnLabels) {
    features.push({
      type: 'Feature',
      properties: { kind: 'schemaTurn', label: String(l.n) },
      geometry: { type: 'Point', coordinates: xf(l) },
    });
  }
  return { type: 'FeatureCollection', features };
}

/** The four normalized image corners in TL, TR, BR, BL order. */
export const IMAGE_CORNERS: Array<[number, number]> = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];
