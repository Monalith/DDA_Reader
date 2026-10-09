// Map sources for the simulator: the extracted corridor and the generated line.
import type { Feature, FeatureCollection, LineString } from 'geojson';
import { fromLocalM } from '../core/geo';
import type { LngLat, TrackModel } from '../core/types';
import { stencilK, stencilLeftNormal } from '../sim/corridor';
import type { Corridor, Line } from '../sim/types';

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
