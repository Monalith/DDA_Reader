import { parseDda, type ParsedDda } from './ddaParser';
import { makeTimeBase, resampleLinear, resampleStep } from './resample';
import { computeDerived } from './derived';
import { lapsFromMarkers } from './laps';
import { ddaReaderCsvToSession } from './csvImport';
import { parseBundle, type ParsedBundle } from './bundle';
import { DDA_NAME_MAP, DEFAULT_PROC, type Channel, type Lap, type Session, type TrackModel } from './types';

const STEP_CHANNELS = new Set(['gear', 'lap_mark', 'int1', 'int2', 'dist']);

let seq = 0;
export function newSessionId(): string {
  seq += 1;
  return `s${Date.now().toString(36)}${seq}`;
}

/** Build a 10 Hz Session from the decoder output. */
export function sessionFromParsed(p: ParsedDda, name: string, color: string): Session {
  const t = makeTimeBase(p.durationS, 10);
  const channels = new Map<string, Channel>();
  for (const desc of p.channels) {
    const series = p.series[desc.name];
    if (!series) continue;
    const mapped = DDA_NAME_MAP[desc.name] ?? { name: desc.name.toLowerCase(), unit: desc.unit };
    const rawV = Float32Array.from(series.v);
    const isLapChannel = mapped.name === 'lap_mark' || mapped.name === 'int1' || mapped.name === 'int2';
    let data: Float32Array;
    if (isLapChannel) {
      // 1 at the 10 Hz sample nearest to a crossing, NaN elsewhere
      data = new Float32Array(t.length).fill(NaN);
      const events = isLapChannel && mapped.name === 'lap_mark' ? p.lapEvents : crossingTimes(series.t, series.v);
      for (const ev of events) {
        const idx = Math.min(t.length - 1, Math.max(0, Math.round(ev * 10)));
        data[idx] = 1;
      }
    } else if (STEP_CHANNELS.has(mapped.name)) {
      data = resampleStep(series.t, rawV, t);
    } else {
      data = resampleLinear(series.t, rawV, t);
    }
    channels.set(mapped.name, {
      name: mapped.name,
      unit: mapped.unit,
      kind: 'raw',
      data,
      raw: { t: series.t, v: rawV },
      proc: { ...DEFAULT_PROC, filter: { type: 'none' } },
    });
  }
  // DIST arrives in km; keep metres internally.
  const dist = channels.get('dist');
  if (dist) {
    dist.unit = 'm';
    dist.data = dist.data.map((v) => v * 1000);
    dist.raw = dist.raw ? { t: dist.raw.t, v: dist.raw.v.map((v) => v * 1000) } : undefined;
  }
  const session: Session = {
    id: newSessionId(),
    name,
    source: 'dda',
    color,
    t,
    channels,
    laps: [],
    meta: { track: p.meta.track, rider: p.meta.rider, note: p.meta.note },
  };
  session.laps = lapsFromMarkers(session);
  return session;
}

/** Lap-type channels store 0xFF for "no crossing"; anything else is hundredths within that second. */
function crossingTimes(t: Float64Array, v: Float64Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < v.length; i++) {
    if (v[i] !== 255 && Number.isFinite(v[i])) out.push(t[i] + v[i] / 100);
  }
  return out;
}

interface DdaReaderJson {
  header?: { track_name?: string; rider_name?: string; session_note?: string };
  records: Array<Record<string, number | boolean | null>>;
  laps?: Array<{ lap_number: number; start_index: number; end_index: number; duration_s: number; is_best?: boolean }>;
}

const JSON_FIELDS: Array<[string, string, string]> = [
  // [json key, channel name, unit]
  ['speed_kmh', 'speed', 'km/h'],
  ['rpm', 'rpm', 'rpm'],
  ['tps_pct', 'tps', '%'],
  ['gear', 'gear', ''],
  ['lean_angle_deg', 'lean', 'deg'],
  ['torque_fast_pct', 'tq_fast', '%'],
  ['torque_slow_pct', 'tq_slow', '%'],
  ['distance_m', 'dist', 'm'],
  ['gps_lat', 'gps_lat', 'deg'],
  ['gps_lon', 'gps_lon', 'deg'],
  ['gps_alt_m', 'gps_alt', 'm'],
];

export function sessionFromDdaReaderJson(j: DdaReaderJson, name: string, color: string): Session {
  const n = j.records.length;
  const t = new Float64Array(n);
  for (let i = 0; i < n; i++) t[i] = Number(j.records[i].time_s ?? i / 10);
  const channels = new Map<string, Channel>();
  for (const [key, chName, unit] of JSON_FIELDS) {
    const data = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const v = j.records[i][key];
      data[i] = typeof v === 'number' ? v : NaN;
    }
    channels.set(chName, { name: chName, unit, kind: 'raw', data, proc: { ...DEFAULT_PROC, filter: { type: 'none' } } });
  }
  const laps: Lap[] = (j.laps ?? []).map((l, i, arr) => ({
    n: l.lap_number,
    startIdx: l.start_index,
    endIdx: l.end_index,
    timeS: l.duration_s,
    sectorsS: [],
    isBest: Boolean(l.is_best),
    kind: i === 0 ? 'out' : i === arr.length - 1 ? 'in' : 'flying',
  }));
  return {
    id: newSessionId(),
    name,
    source: 'json',
    color,
    t,
    channels,
    laps,
    meta: {
      track: j.header?.track_name ?? '',
      rider: j.header?.rider_name ?? '',
      note: j.header?.session_note ?? '',
    },
  };
}

export function isBundleFile(file: File): boolean {
  return file.name.toLowerCase().endsWith('.lab.json');
}

/** A .lab.json bundle: one standalone session per stored lap, plus track and workspace. */
export async function loadBundleFromFile(file: File, track?: TrackModel): Promise<ParsedBundle> {
  const parsed = parseBundle(await file.text(), newSessionId);
  for (const { session } of parsed.sessions) computeDerived(session, parsed.track ?? track);
  return parsed;
}

export async function loadSessionFromFile(file: File, color: string, track?: TrackModel): Promise<Session> {
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  const base = file.name.replace(/\.[^.]+$/, '');
  let session: Session;
  if (ext === 'dda') {
    const buf = await file.arrayBuffer();
    session = sessionFromParsed(parseDda(buf), base, color);
  } else if (ext === 'json') {
    const text = await file.text();
    session = sessionFromDdaReaderJson(JSON.parse(text) as DdaReaderJson, base, color);
  } else if (ext === 'csv') {
    const text = await file.text();
    session = ddaReaderCsvToSession(text, base);
    session.color = color;
  } else {
    throw new Error(`Unsupported file type: .${ext}`);
  }
  computeDerived(session, track);
  return session;
}
