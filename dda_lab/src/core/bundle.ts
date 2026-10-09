// Lab bundle: exports the workspace laps (sliced channel data), the track model
// and the workspace settings as one JSON file that reopens standalone.
import { z } from 'zod';
import { DEFAULT_PROC, type Channel, type Lap, type Session, type TrackModel, type Workspace } from './types';
import { parseWorkspace, serializeWorkspace } from './workspace';
import { toCsv } from './reports';

export const BUNDLE_VERSION = 1;

export interface BundleLap {
  name: string;
  color: string;
  sourceSession: string;
  lapNumber: number;
  timeS: number;
  sectorsS: number[];
  meta: Session['meta'];
  t: number[];
  channels: { name: string; unit: string; kind: Channel['kind']; data: (number | null)[] }[];
}

export interface LabBundle {
  version: typeof BUNDLE_VERSION;
  createdAt: string;
  workspace: unknown;
  track: SerializedTrackJson | null;
  laps: BundleLap[];
  /** markers placed on the exported laps (lapIndex = position in `laps`) */
  markers?: BundleMarker[];
}

export interface BundleMarker {
  lapIndex: number;
  idxInLap: number;
  name: string;
  color: string;
  note?: string;
}

export type SerializedTrackJson = Omit<TrackModel, 'cumDistM'> & { cumDistM: number[] };

export function serializeTrackJson(t: TrackModel): SerializedTrackJson {
  return { ...t, cumDistM: Array.from(t.cumDistM) };
}

export function deserializeTrackJson(o: SerializedTrackJson): TrackModel {
  return { ...o, cumDistM: Float64Array.from(o.cumDistM) };
}

/** Decimals kept per channel: GPS coordinates need 7 (≈1 cm); 4 would quantise the track to ~10 m. */
export function bundleDecimals(name: string): number {
  return name === 'gps_lat' || name === 'gps_lon' ? 7 : name === 'curvature' ? 6 : 4;
}

const roundTo = (decimals: number) => (v: number): number | null => (Number.isFinite(v) ? Number(v.toFixed(decimals)) : null);

export function lapToBundleLap(s: Session, lap: Lap, name: string, color: string): BundleLap {
  const a = lap.startIdx;
  const b = Math.min(lap.endIdx, s.t.length - 1);
  const t0 = s.t[a];
  const channels: BundleLap['channels'] = [];
  for (const ch of s.channels.values()) {
    if (ch.kind === 'math') continue; // recomputed from the workspace definitions
    if (ch.kind === 'derived') continue; // recomputed from raw on import (gps_speed, long_g, lap_dist, d_*…)
    channels.push({ name: ch.name, unit: ch.unit, kind: ch.kind, data: Array.from(ch.data.slice(a, b + 1), roundTo(bundleDecimals(ch.name))) });
  }
  return {
    name,
    color,
    sourceSession: s.name,
    lapNumber: lap.n,
    timeS: lap.timeS,
    sectorsS: lap.sectorsS,
    meta: s.meta,
    t: Array.from(s.t.slice(a, b + 1), (v) => Number((v - t0).toFixed(3))),
    channels,
  };
}

export function makeBundle(laps: BundleLap[], track: TrackModel | undefined, workspace: Workspace, markers: BundleMarker[] = []): string {
  const bundle: LabBundle = {
    version: BUNDLE_VERSION,
    createdAt: new Date().toISOString(),
    workspace: JSON.parse(serializeWorkspace(workspace)),
    track: track ? serializeTrackJson(track) : null,
    laps,
    markers,
  };
  return JSON.stringify(bundle);
}

const BundleLapZ = z.object({
  name: z.string(),
  color: z.string(),
  sourceSession: z.string(),
  lapNumber: z.number(),
  timeS: z.number(),
  sectorsS: z.array(z.number()),
  meta: z.object({ track: z.string(), rider: z.string(), note: z.string() }),
  t: z.array(z.number()),
  channels: z.array(
    z.object({
      name: z.string(),
      unit: z.string(),
      kind: z.enum(['raw', 'derived', 'math', 'external']),
      data: z.array(z.number().nullable()),
    }),
  ),
});

const BundleZ = z.object({
  version: z.literal(BUNDLE_VERSION),
  createdAt: z.string(),
  workspace: z.unknown(),
  track: z.unknown().nullable(),
  laps: z.array(BundleLapZ),
  markers: z
    .array(z.object({ lapIndex: z.number(), idxInLap: z.number(), name: z.string(), color: z.string(), note: z.string().optional() }))
    .optional(),
});

export interface ParsedBundle {
  workspace: Workspace;
  track: TrackModel | null;
  /** One Session per lap, each with a single flying lap n=1, plus its display meta. */
  sessions: { session: Session; name: string; color: string }[];
  markers: BundleMarker[];
}

let seq = 0;

/** Parse a bundle into standalone one-lap sessions. */
export function parseBundle(json: string, makeId: () => string = () => `b${Date.now().toString(36)}${++seq}`): ParsedBundle {
  const b = BundleZ.parse(JSON.parse(json));
  const workspace = parseWorkspace(JSON.stringify(b.workspace ?? {}));
  const track = b.track ? deserializeTrackJson(b.track as SerializedTrackJson) : null;
  const sessions = b.laps.map((bl) => {
    const t = Float64Array.from(bl.t);
    const channels = new Map<string, Channel>();
    for (const c of bl.channels) {
      channels.set(c.name, {
        name: c.name,
        unit: c.unit,
        kind: c.kind === 'external' ? 'external' : c.kind === 'derived' ? 'derived' : 'raw',
        data: Float32Array.from(c.data, (v) => (v === null ? NaN : v)),
        proc: { ...DEFAULT_PROC },
      });
    }
    const session: Session = {
      id: makeId(),
      name: bl.name,
      source: 'json',
      color: bl.color,
      t,
      channels,
      laps: [
        {
          n: bl.lapNumber,
          startIdx: 0,
          endIdx: t.length - 1,
          timeS: bl.timeS,
          sectorsS: bl.sectorsS,
          isBest: true,
          kind: 'flying',
        },
      ],
      meta: bl.meta,
      // the lap boundaries come from the file: never cleared when the start line moves
      lapsFromFile: true,
    };
    return { session, name: bl.name, color: bl.color };
  });
  return { workspace, track, sessions, markers: b.markers ?? [] };
}

/**
 * One lap as a DDA_Reader-style CSV (10 Hz rows, every channel including math). With
 * `visible`, only the rows inside the chart's x range (lap distance in m or lap time in s)
 * are written, so the file matches what is on screen.
 */
export function lapToCsv(s: Session, lap: Lap, visible?: { xAxis: 'time' | 'distance'; range: [number, number] }): string {
  const names = [...s.channels.values()].map((c) => c.name);
  const rows: (string | number)[][] = [['Time_s', ...names]];
  const t0 = s.t[lap.startIdx];
  const lapDist = s.channels.get('lap_dist')?.data;
  for (let i = lap.startIdx; i <= lap.endIdx && i < s.t.length; i++) {
    if (visible) {
      const x = visible.xAxis === 'distance' && lapDist ? lapDist[i] : s.t[i] - t0;
      if (!(x >= visible.range[0] && x <= visible.range[1])) continue;
    }
    rows.push([Number((s.t[i] - t0).toFixed(2)), ...names.map((n) => s.channels.get(n)!.data[i])]);
  }
  return toCsv(rows);
}
