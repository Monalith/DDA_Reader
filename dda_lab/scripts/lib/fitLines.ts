// The lines the reference fit can run on (scripts/fit-reference.ts, tests/unit/simFitPist.test.ts):
//
//   map     the reference file's own lat/lon (a hand-placed map polyline, ±15-20 m), no corridor,
//           the 5 m fallback half-width, the preset's κ — the original fit setup;
//   centre  a `.pist.json` track model's surveyed centreline as the line itself (offset 0);
//   race    the rider module's racing line inside the track model's corridor (its asphalt edges),
//           `buildLine` with κ (the preset's unless overridden). κ = 0 is minimum curvature
//           ('min-curvature') or its speed-weighted minimum-time approximation ('min-time', the
//           default), κ = 1 minimum distance (src/sim/line.ts).
import { readFileSync } from 'node:fs';
import { corridorFromPist, parsePistPackage, trackFromPist, type PistPackage } from '../../src/core/pistPackage';
import { normalizeTrackOrigin } from '../../src/core/track';
import type { TrackModel } from '../../src/core/types';
import { buildLine, lineFromOffsets } from '../../src/sim/line';
import type { Corridor, Line, LineMode, SimParams } from '../../src/sim/types';
import { serresTrack, type ReferenceRow } from './referenceLap';

export type LineKind = 'map' | 'centre' | 'race';

export interface PistModel {
  pkg: PistPackage;
  track: TrackModel;
  corridor: Corridor | null;
}

/** A `.pist.json` as the lab applies it (store.applyTrackPackage): track rolled to its gate + corridor. */
export function loadPistModel(path: string): PistModel {
  const pkg = parsePistPackage(readFileSync(path, 'utf8'));
  const track = normalizeTrackOrigin(trackFromPist(pkg));
  return { pkg, track, corridor: corridorFromPist(pkg, track) };
}

export function fitLine(kind: LineKind, P: SimParams, rows: ReferenceRow[], model?: PistModel, kappa?: number, lineMode?: LineMode): Line {
  const p: SimParams = { ...P, rider: { ...P.rider, ...(kappa === undefined ? {} : { kappa }), ...(lineMode === undefined ? {} : { lineMode }) } };
  if (kind === 'map') return buildLine(serresTrack(rows), undefined, p);
  if (!model) throw new Error(`line '${kind}' needs a track model (--track file.pist.json)`);
  if (kind === 'centre') return lineFromOffsets(model.track, new Float32Array(model.track.centerline.length));
  return buildLine(model.track, model.corridor ?? undefined, p);
}
