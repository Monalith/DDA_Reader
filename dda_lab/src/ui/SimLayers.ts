// Map sources for the simulator: the extracted corridor and the generated line.
import type { Feature, FeatureCollection, LineString, Point } from 'geojson';
import { fromLocalM } from '../core/geo';
import type { LngLat, TrackModel } from '../core/types';
import { stencilK, stencilLeftNormal } from '../sim/corridor';
import type { Corner, Corridor, Line } from '../sim/types';
import type { PistPackage } from '../core/pistPackage';

export type CorridorProps = { side: 'left' | 'right' };

/**
 * Offset a centerline vertex sideways by `d` metres (positive = left of
 * travel). `k` is the tangent stencil half-width in vertices — this MUST be
 * the same stencil `extractCorridor` used to measure the edge, or the line
 * drawn here is not the corridor that was actually measured (a mismatch is
 * most visible at a hairpin, where a +-1-vertex tangent and a +-10 m one can
 * point materially differently).
 */
export function offsetPoint(cl: LngLat[], i: number, d: number, k: number): LngLat {
  const [nx, ny] = stencilLeftNormal(cl, i, k);
  return fromLocalM(cl[i], [nx * d, ny * d]);
}

/**
 * The corridor as two edge lines. Runs of unknown sections break the line into
 * separate features, so the map shows a gap where extraction could not decide
 * instead of a straight line through the uncertainty.
 */
export function corridorGeoJson(track: TrackModel, c: Corridor): FeatureCollection<LineString, CorridorProps> {
  const cl = track.centerline;
  const k = stencilK(track);
  const features: Array<Feature<LineString, CorridorProps>> = [];
  for (const side of ['left', 'right'] as const) {
    const dist = side === 'left' ? c.leftM : c.rightM;
    let run: LngLat[] = [];
    const flush = (): void => {
      // A lone known vertex surrounded by unknown ones still ends its own run;
      // emit it as a degenerate (zero-length) line rather than dropping it, so
      // an isolated single point does not silently merge into a neighbouring
      // segment it is not actually connected to.
      if (run.length === 1) run = [run[0], run[0]];
      if (run.length > 1) {
        features.push({ type: 'Feature', properties: { side }, geometry: { type: 'LineString', coordinates: run } });
      }
      run = [];
    };
    for (let i = 0; i < cl.length; i++) {
      if (!c.known[i] || !Number.isFinite(dist[i])) {
        flush();
        continue;
      }
      run.push(offsetPoint(cl, i, side === 'left' ? dist[i] : -dist[i], k));
    }
    flush();
  }
  return { type: 'FeatureCollection', features };
}

export type CornerEventKind = 'B' | 'T' | 'A' | 'P' | 'E';
export type CornerEventProps = {
  kind: CornerEventKind;
  /** 1-based corner number along the lap. */
  corner: number;
  /** +1 left, -1 right. */
  dir: 1 | -1;
};

/**
 * Corner events of the rider-mode lap as map points (spec v2 §2.9): brake
 * point, turn-in, speed apex, throttle pick-up and exit. A corner taken
 * without braking has no B (its `iB` is only a copy of `iT`). Indices outside
 * the line are skipped rather than drawn at a wrong place.
 */
export function cornerEventsGeoJson(
  line: Line,
  corners: readonly Corner[] | undefined,
): FeatureCollection<Point, CornerEventProps> {
  const features: Array<Feature<Point, CornerEventProps>> = [];
  const n = line.points.length;
  (corners ?? []).forEach((c, k) => {
    const events: Array<[CornerEventKind, number]> = [
      ...(c.hasBrake ? [['B', c.iB] as [CornerEventKind, number]] : []),
      ['T', c.iT],
      ['A', c.iA],
      ['P', c.iP],
      ['E', c.iE],
    ];
    for (const [kind, i] of events) {
      if (!Number.isInteger(i) || i < 0 || i >= n) continue;
      features.push({
        type: 'Feature',
        properties: { kind, corner: k + 1, dir: c.dir },
        geometry: { type: 'Point', coordinates: line.points[i] },
      });
    }
  });
  return { type: 'FeatureCollection', features };
}

export type IdealLineProps = { kind: 'idealLine' };

export function idealLineGeoJson(line: Line): FeatureCollection<LineString, IdealLineProps> {
  if (line.points.length < 2) return { type: 'FeatureCollection', features: [] };
  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { kind: 'idealLine' },
      geometry: { type: 'LineString', coordinates: line.points },
    }],
  };
}

export type PistProps =
  | { kind: 'edge'; side: 'left' | 'right' }
  | { kind: 'centerline' }
  | { kind: 'corner'; n: number; name: string; dir: 'L' | 'R'; radiusM: number };

/**
 * A `.pist.json` track model as map features: the two asphalt edges (broken
 * where the package has no edge), the surveyed centreline and one point per
 * corner apex with its name.
 */
export function pistGeoJson(p: PistPackage | undefined): FeatureCollection<LineString | Point, PistProps> {
  const features: Array<Feature<LineString | Point, PistProps>> = [];
  if (!p) return { type: 'FeatureCollection', features };
  for (const [side, edge] of [['left', p.leftEdge], ['right', p.rightEdge]] as const) {
    let run: LngLat[] = [];
    const flush = (): void => {
      if (run.length >= 2) features.push({ type: 'Feature', properties: { kind: 'edge', side }, geometry: { type: 'LineString', coordinates: run } });
      run = [];
    };
    for (const q of edge) {
      if (q) run.push(q);
      else flush();
    }
    // the loop closes: join the last run back to the first station when both are known
    if (run.length && edge[0]) run.push(edge[0]);
    flush();
  }
  features.push({
    type: 'Feature',
    properties: { kind: 'centerline' },
    geometry: { type: 'LineString', coordinates: [...p.centerline, p.centerline[0]] },
  });
  for (const c of p.corners) {
    features.push({
      type: 'Feature',
      properties: { kind: 'corner', n: c.n, name: c.name, dir: c.dir, radiusM: c.radiusM },
      geometry: { type: 'Point', coordinates: c.apex },
    });
  }
  return { type: 'FeatureCollection', features };
}

export type FitCornerProps =
  | { kind: 'zone'; k: number; name: string; sel: boolean }
  | { kind: 'apex'; k: number; name: string; sel: boolean };

/**
 * The track model's corners on the rider's line ("Fit to lap", Rider mode):
 * each corner's zone as a line and its apex as a clickable point with its
 * name. `k` is the turn number `n`; picking one selects the corner whose
 * sliders the sim panel shows.
 */
export function fitCornersGeoJson(
  line: Line,
  zones: ReadonlyArray<{ n: number; name: string; i0: number; i1: number; iApex: number }>,
  selected: number | null,
): FeatureCollection<LineString | Point, FitCornerProps> {
  const n = line.points.length;
  const features: Array<Feature<LineString | Point, FitCornerProps>> = [];
  for (const z of zones) {
    const sel = z.n === selected;
    const coords: LngLat[] = [];
    const len = (((z.i1 - z.i0) % n) + n) % n;
    for (let d = 0; d <= len; d++) coords.push(line.points[(z.i0 + d) % n]);
    if (coords.length >= 2) {
      features.push({ type: 'Feature', properties: { kind: 'zone', k: z.n, name: z.name, sel }, geometry: { type: 'LineString', coordinates: coords } });
    }
    if (z.iApex >= 0 && z.iApex < n) {
      features.push({ type: 'Feature', properties: { kind: 'apex', k: z.n, name: z.name, sel }, geometry: { type: 'Point', coordinates: line.points[z.iApex] } });
    }
  }
  return { type: 'FeatureCollection', features };
}
