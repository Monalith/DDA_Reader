// Map sources for the simulator: the extracted corridor and the generated line.
import type { Feature, FeatureCollection, LineString } from 'geojson';
import { fromLocalM, toLocalM } from '../core/geo';
import type { LngLat, TrackModel } from '../core/types';
import type { Corridor, Line } from '../sim/types';

export type CorridorProps = { side: 'left' | 'right' };

/** Unit normal pointing left of travel at centerline vertex `i`, in east/north metres. */
function leftNormal(cl: LngLat[], i: number): [number, number] {
  const n = cl.length;
  const a = cl[(i - 1 + n) % n];
  const b = cl[(i + 1) % n];
  const am = toLocalM(cl[i], a);
  const bm = toLocalM(cl[i], b);
  const tx = bm[0] - am[0];
  const ty = bm[1] - am[1];
  const len = Math.hypot(tx, ty);
  return len < 1e-9 ? [0, 0] : [-ty / len, tx / len];
}

/** Offset a centerline vertex sideways by `d` metres (positive = left of travel). */
export function offsetPoint(cl: LngLat[], i: number, d: number): LngLat {
  const [nx, ny] = leftNormal(cl, i);
  return fromLocalM(cl[i], [nx * d, ny * d]);
}

/**
 * The corridor as two edge lines. Runs of unknown sections break the line into
 * separate features, so the map shows a gap where extraction could not decide
 * instead of a straight line through the uncertainty.
 */
export function corridorGeoJson(track: TrackModel, c: Corridor): FeatureCollection<LineString, CorridorProps> {
  const cl = track.centerline;
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
      run.push(offsetPoint(cl, i, side === 'left' ? dist[i] : -dist[i]));
    }
    flush();
  }
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
