// Importer for "track-map telemetry" JSON files: a lap sampled along the track
// distance (e.g. extracted from an onboard video), with Turkish or English keys.
//
//   { meta: { ad, pist, tur_suresi, ... },
//     viraj_ozeti: [{ viraj:'K1', yon:'Sağ'|'Sol', bolge_m:[a,b], apeks_m, fren_basi_m }],
//     telemetri_1m: [{ s_m, t_s, hiz_kmh, gaz_pct, vites, boylamsal_g, lat, lon }] }
import { makeTimeBase, resampleLinear, resampleStep } from './resample';
import { DEFAULT_PROC, type Channel, type LngLat, type Session, type TurnHint } from './types';

type Row = Record<string, unknown>;

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);

/** Field aliases: canonical channel → accepted keys (first match wins). */
const FIELD_ALIASES: Record<string, string[]> = {
  t: ['t_s', 'time_s', 't', 'time'],
  s: ['s_m', 'dist_m', 'distance_m', 's'],
  speed: ['hiz_kmh', 'speed_kmh', 'speed', 'v_kmh'],
  tps: ['gaz_pct', 'tps_pct', 'throttle_pct', 'tps'],
  gear: ['vites', 'gear'],
  long_g: ['boylamsal_g', 'long_g', 'accel_long_g'],
  lat_g: ['yanal_g', 'lat_g', 'accel_lat_g'],
  rpm: ['devir', 'rpm'],
  lean: ['yatis_deg', 'lean_angle_deg', 'lean'],
  gps_lat: ['lat', 'gps_lat', 'enlem'],
  gps_lon: ['lon', 'lng', 'gps_lon', 'boylam'],
  gps_alt: ['alt_m', 'gps_alt_m', 'yukseklik_m'],
};

const UNITS: Record<string, string> = {
  speed: 'km/h', tps: '%', gear: '', long_g: 'g', lat_g: 'g', rpm: 'rpm', lean: 'deg',
  gps_lat: 'deg', gps_lon: 'deg', gps_alt: 'm', dist: 'm',
};

export interface TelemetryJson {
  meta?: Row;
  telemetri_1m?: Row[];
  telemetry?: Row[];
  samples?: Row[];
  viraj_ozeti?: Row[];
  turns?: Row[];
}

/** True when the object looks like a track-map telemetry file. */
export function isTelemetryJson(j: unknown): j is TelemetryJson {
  if (!j || typeof j !== 'object') return false;
  const o = j as TelemetryJson;
  const rows = o.telemetri_1m ?? o.telemetry ?? o.samples;
  return Array.isArray(rows) && rows.length > 1 && typeof rows[0] === 'object';
}

function pick(row: Row, keys: string[]): unknown {
  for (const k of keys) if (k in row) return row[k];
  return undefined;
}

function parseLapTime(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return NaN;
  const m = /^(\d+):(\d+(?:\.\d+)?)$/.exec(v.trim());
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  const n = Number(v.replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
}

export function telemetryJsonToSession(j: TelemetryJson, name: string, color: string, makeId: () => string): Session {
  const rows = (j.telemetri_1m ?? j.telemetry ?? j.samples ?? []) as Row[];
  const tNative = Float64Array.from(rows, (r) => num(pick(r, FIELD_ALIASES.t)));
  if (!tNative.every(Number.isFinite)) throw new Error('telemetry rows need a numeric time field (t_s)');
  const durationS = tNative[tNative.length - 1];
  const t = makeTimeBase(durationS, 10);
  const channels = new Map<string, Channel>();
  const add = (chName: string, data: Float32Array, unit: string) =>
    channels.set(chName, { name: chName, unit, kind: 'raw', data, proc: { ...DEFAULT_PROC, filter: { type: 'none' } } });

  for (const [chName, keys] of Object.entries(FIELD_ALIASES)) {
    if (chName === 't' || chName === 's') continue;
    const v = Float32Array.from(rows, (r) => num(pick(r, keys)));
    if (!v.some(Number.isFinite)) continue; // e.g. gaz_pct all null
    const data = chName === 'gear' ? resampleStep(tNative, v, t) : resampleLinear(tNative, v, t);
    add(chName, data, UNITS[chName] ?? '');
  }
  const sNative = Float32Array.from(rows, (r) => num(pick(r, FIELD_ALIASES.s)));
  if (sNative.some(Number.isFinite)) add('dist', resampleLinear(tNative, sNative, t), 'm');

  const meta = (j.meta ?? {}) as Row;
  const lapTime = parseLapTime(meta.tur_suresi ?? meta.lap_time);
  const session: Session = {
    id: makeId(),
    name,
    source: 'json',
    color,
    t,
    channels,
    laps: [
      {
        n: 1,
        startIdx: 0,
        endIdx: t.length - 1,
        timeS: Number.isFinite(lapTime) ? lapTime : durationS,
        sectorsS: [],
        isBest: true,
        kind: 'flying',
      },
    ],
    meta: {
      track: String(meta.pist ?? meta.track ?? ''),
      rider: String(meta.kisa_ad ?? meta.rider ?? ''),
      note: String(meta.ad ?? meta.note ?? meta.kaynak ?? ''),
    },
  };

  // Turn hints: map metre positions to the lat/lon of the nearest row.
  const geoAt = (sM: number): LngLat | undefined => {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < rows.length; i++) {
      const d = Math.abs(sNative[i] - sM);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best < 0) return undefined;
    const lon = num(pick(rows[best], FIELD_ALIASES.gps_lon));
    const lat = num(pick(rows[best], FIELD_ALIASES.gps_lat));
    return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : undefined;
  };
  const turnRows = (j.viraj_ozeti ?? j.turns ?? []) as Row[];
  const hints: TurnHint[] = [];
  for (const r of turnRows) {
    const range = (r.bolge_m ?? r.range_m) as unknown;
    const apexM = num(r.apeks_m ?? r.apex_m);
    if (!Array.isArray(range) || range.length !== 2 || !Number.isFinite(apexM)) continue;
    const apexGeo = geoAt(apexM);
    const startGeo = geoAt(num(range[0]));
    const endGeo = geoAt(num(range[1]));
    if (!apexGeo || !startGeo || !endGeo) continue;
    const dirRaw = String(r.yon ?? r.dir ?? '').toLowerCase();
    const dir: 'L' | 'R' = dirRaw.startsWith('sol') || dirRaw.startsWith('l') ? 'L' : 'R';
    const brakeM = num(r.fren_basi_m ?? r.brake_m);
    hints.push({
      name: String(r.viraj ?? r.name ?? `T${hints.length + 1}`),
      dir,
      apexGeo,
      startGeo,
      endGeo,
      brakeGeo: Number.isFinite(brakeM) ? geoAt(brakeM) : undefined,
    });
  }
  session.lapsFromFile = true;
  if (hints.length) session.turnHints = hints;
  const sf = geoAt(0);
  if (sf) session.sfHint = sf;
  return session;
}
