// CSV import: DDA_Reader's own export format, plus arbitrary external CSV
// (datalogger, suspension potentiometers, brake pressure, ...) mapped onto the
// session time base.
//
// NOTE: resampling helpers are intentionally private to this module so that it
// stays independent of src/core/resample.ts while that file is written.

import Papa from 'papaparse';
import { DEFAULT_PROC, type Channel, type Lap, type Session } from './types';

export interface CsvMapping {
  timeCol: string;
  timeUnit: 's' | 'ms';
  decimal: '.' | ',';
  channels: { col: string; name: string; unit: string }[];
  offsetS: number;
  method: 'linear' | 'step';
}

export interface CsvSniff {
  columns: string[];
  preview: string[][];
  isDdaReaderExport: boolean;
  delimiter: ',' | ';' | '\t';
  decimal: '.' | ',';
}

/** Header prefix written by DDA_Reader's CSV exporter. */
const DDA_HEADER_PREFIX = 'Time_s,Speed_kmh';

// ---------------------------------------------------------------- utilities

const DELIMITERS: (',' | ';' | '\t')[] = [',', ';', '\t'];

function splitLines(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim() !== '');
}

function countOutsideQuotes(line: string, ch: string): number {
  let n = 0;
  let inQ = false;
  for (const c of line) {
    if (c === '"') inQ = !inQ;
    else if (!inQ && c === ch) n++;
  }
  return n;
}

function detectDelimiter(lines: string[]): ',' | ';' | '\t' {
  // The header row is the reliable signal: it holds structural delimiters but
  // (unlike data rows) no decimal separators. Ties break on how many body rows
  // repeat the same field count.
  const header = lines[0] ?? '';
  const body = lines.slice(1, 6);
  let best: ',' | ';' | '\t' = ',';
  let bestScore = -1;
  let bestFallback = -1;
  let fallback: ',' | ';' | '\t' = ',';
  for (const d of DELIMITERS) {
    const hc = countOutsideQuotes(header, d);
    const consistent = body.filter((l) => countOutsideQuotes(l, d) === hc).length;
    const score = hc > 0 ? hc * 100 + consistent : -1;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
    const total = body.reduce((a, l) => a + countOutsideQuotes(l, d), 0);
    if (total > bestFallback) {
      bestFallback = total;
      fallback = d;
    }
  }
  return bestScore > 0 ? best : fallback;
}

function detectDecimal(lines: string[], delimiter: ',' | ';' | '\t'): '.' | ',' {
  if (delimiter === ',') return '.';
  // comma decimal looks like 12,5 inside a field
  const body = lines.slice(1, 20).join('\n');
  return /\d,\d/.test(body) ? ',' : '.';
}

function parseRows(text: string, delimiter: string): string[][] {
  const res = Papa.parse<string[]>(text.trim(), {
    delimiter,
    skipEmptyLines: true,
  });
  return (res.data ?? []).map((row) => row.map((c) => (c ?? '').trim()));
}

function num(raw: string | undefined, decimal: '.' | ',' = '.'): number {
  if (raw === undefined) return NaN;
  let s = raw.trim();
  if (s === '' || s === '-' || /^(nan|na|null|none)$/i.test(s)) return NaN;
  if (decimal === ',') s = s.replace(/\./g, '').replace(/,/g, '.');
  const v = Number(s);
  return Number.isFinite(v) ? v : NaN;
}

/** Linear interpolation onto `tOut`; NaN outside the source range or across gaps. */
function resampleLinearLocal(
  t: Float64Array,
  v: Float32Array,
  tOut: Float64Array,
): Float32Array {
  const out = new Float32Array(tOut.length);
  const n = t.length;
  if (n === 0) {
    out.fill(NaN);
    return out;
  }
  let j = 0;
  for (let i = 0; i < tOut.length; i++) {
    const x = tOut[i];
    if (x < t[0] || x > t[n - 1]) {
      out[i] = NaN;
      continue;
    }
    while (j < n - 2 && t[j + 1] < x) j++;
    while (j > 0 && t[j] > x) j--;
    const t0 = t[j];
    const t1 = t[j + 1];
    const v0 = v[j];
    const v1 = v[j + 1];
    if (t1 === undefined || !(t1 > t0)) {
      out[i] = v0;
    } else if (!Number.isFinite(v0) || !Number.isFinite(v1)) {
      out[i] = x === t0 ? v0 : x === t1 ? v1 : NaN;
    } else {
      out[i] = v0 + ((v1 - v0) * (x - t0)) / (t1 - t0);
    }
  }
  return out;
}

/** Zero-order hold: value of the last sample at or before each output time. */
function resampleStepLocal(
  t: Float64Array,
  v: Float32Array,
  tOut: Float64Array,
): Float32Array {
  const out = new Float32Array(tOut.length);
  const n = t.length;
  if (n === 0) {
    out.fill(NaN);
    return out;
  }
  let j = 0;
  for (let i = 0; i < tOut.length; i++) {
    const x = tOut[i];
    if (x < t[0] || x > t[n - 1]) {
      out[i] = NaN;
      continue;
    }
    while (j < n - 1 && t[j + 1] <= x) j++;
    while (j > 0 && t[j] > x) j--;
    out[i] = v[j];
  }
  return out;
}

// ------------------------------------------------------------------- sniffing

export function sniffCsv(text: string): CsvSniff {
  const lines = splitLines(text);
  if (lines.length === 0) {
    return {
      columns: [],
      preview: [],
      isDdaReaderExport: false,
      delimiter: ',',
      decimal: '.',
    };
  }
  const delimiter = detectDelimiter(lines);
  const decimal = detectDecimal(lines, delimiter);
  const rows = parseRows(lines.join('\n'), delimiter);
  const columns = rows[0] ?? [];
  return {
    columns,
    preview: rows.slice(1, 6),
    isDdaReaderExport: text.trimStart().startsWith(DDA_HEADER_PREFIX),
    delimiter,
    decimal,
  };
}

// ----------------------------------------------------- DDA_Reader CSV export

interface DdaColSpec {
  col: string;
  name: string;
  unit: string;
  step?: boolean;
}

/** DDA_Reader export column -> canonical channel. */
const DDA_COLUMNS: DdaColSpec[] = [
  { col: 'Speed_kmh', name: 'speed', unit: 'km/h' },
  { col: 'RPM', name: 'rpm', unit: 'rpm' },
  { col: 'TPS_pct', name: 'tps', unit: '%' },
  { col: 'Gear', name: 'gear', unit: '', step: true },
  { col: 'LeanAngle_deg', name: 'lean', unit: 'deg' },
  { col: 'DTC_Fast_pct', name: 'tq_fast', unit: '%' },
  { col: 'DTC_Slow_pct', name: 'tq_slow', unit: '%' },
  { col: 'Distance_m', name: 'dist', unit: 'm' },
  { col: 'GPS_Lat', name: 'gps_lat', unit: 'deg' },
  { col: 'GPS_Lon', name: 'gps_lon', unit: 'deg' },
  { col: 'GPS_Alt_m', name: 'gps_alt', unit: 'm' },
];

function makeTimeBaseLocal(durationS: number, hz = 10): Float64Array {
  const n = Math.max(1, Math.floor(durationS * hz + 1e-9) + 1);
  const t = new Float64Array(n);
  for (let i = 0; i < n; i++) t[i] = i / hz;
  return t;
}

/** Parse a DDA_Reader standard CSV export into a 10 Hz Session. */
export function ddaReaderCsvToSession(text: string, name: string): Session {
  const sniff = sniffCsv(text);
  const rows = parseRows(text, sniff.delimiter);
  if (rows.length < 2) throw new Error('ddaReaderCsvToSession: no data rows');
  const header = rows[0];
  const idx = new Map<string, number>(header.map((h, i) => [h, i]));
  const timeIdx = idx.get('Time_s');
  // "Export visible" writes one column per plotted lap+channel ("merged_all L53 speed") on a
  // distance/time grid: a spreadsheet file, not a session.
  if (header[0] === 'Distance_m' || (timeIdx === 0 && header.slice(1).some((h) => /\s/.test(h)))) {
    throw new Error(
      'This CSV is a chart export (⤓ Export visible) meant for spreadsheets. To reopen laps in DDA Lab use Laps → Export bundle (.lab.json), or Export CSV for per-lap files.',
    );
  }
  if (timeIdx === undefined) {
    throw new Error('ddaReaderCsvToSession: missing Time_s column (expected a DDA_Reader or DDA Lab lap CSV)');
  }
  const body = rows.slice(1);
  const dec = sniff.decimal;

  const tNative = new Float64Array(body.length);
  for (let i = 0; i < body.length; i++) tNative[i] = num(body[i][timeIdx], dec);

  const durationS = tNative.length ? tNative[tNative.length - 1] - tNative[0] : 0;
  const t = makeTimeBaseLocal(durationS, 10);
  const t0 = tNative.length ? tNative[0] : 0;
  const tRel = new Float64Array(tNative.length);
  for (let i = 0; i < tNative.length; i++) tRel[i] = tNative[i] - t0;

  const channels = new Map<string, Channel>();
  for (const spec of DDA_COLUMNS) {
    const ci = idx.get(spec.col);
    if (ci === undefined) continue;
    const v = new Float32Array(body.length);
    for (let i = 0; i < body.length; i++) v[i] = num(body[i][ci], dec);
    const data = spec.step
      ? resampleStepLocal(tRel, v, t)
      : resampleLinearLocal(tRel, v, t);
    channels.set(spec.name, {
      name: spec.name,
      unit: spec.unit,
      kind: 'raw',
      data,
      raw: { t: tRel, v },
      proc: { ...DEFAULT_PROC, filter: { ...DEFAULT_PROC.filter } },
    });
  }

  // DDA Lab's own lap CSV (Laps → Export CSV): columns are canonical channel names
  // (speed, rpm, gps_lat …) plus derived/math ones. Raw names become raw channels,
  // anything else is kept as an external channel so nothing is lost.
  let labExport = false;
  for (let ci = 0; ci < header.length; ci++) {
    const col = header[ci];
    if (ci === timeIdx || col === 'Lap' || channels.has(col) || DDA_COLUMNS.some((s) => s.col === col)) continue;
    if (!/^[a-z][a-z0-9_]*$/.test(col)) continue;
    const spec = LAB_CHANNELS[col];
    if (spec?.derived) continue; // recomputed from raw on load (gps_speed, long_g, lap_dist, d_* …)
    const v = new Float32Array(body.length);
    let finite = 0;
    for (let i = 0; i < body.length; i++) {
      v[i] = num(body[i][ci], dec);
      if (Number.isFinite(v[i])) finite++;
    }
    if (!finite) continue;
    labExport = true;
    const data = col === 'gear' ? resampleStepLocal(tRel, v, t) : resampleLinearLocal(tRel, v, t);
    channels.set(col, {
      name: col,
      unit: spec?.unit ?? '',
      kind: spec ? 'raw' : 'external',
      data,
      raw: { t: tRel, v },
      proc: { ...DEFAULT_PROC, filter: { ...DEFAULT_PROC.filter } },
    });
  }

  // Laps from the Lap column: a change of value starts a new lap.
  const lapIdx = idx.get('Lap');
  let laps: Lap[] = [];
  if (lapIdx !== undefined) {
    const lapNative = new Float32Array(body.length);
    for (let i = 0; i < body.length; i++) lapNative[i] = num(body[i][lapIdx], dec);
    const lapOn10Hz = resampleStepLocal(tRel, lapNative, t);
    laps = lapsFromLapColumn(lapOn10Hz, t);
  } else if (labExport) {
    // a DDA Lab lap CSV is exactly one lap
    laps = [{ n: 1, startIdx: 0, endIdx: t.length - 1, timeS: durationS, sectorsS: [], isBest: true, kind: 'flying' }];
  }

  if (!channels.size) {
    throw new Error(`No known channel columns in this CSV (header: ${header.slice(0, 6).join(', ')}…)`);
  }

  return {
    id: `csv-${name}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    source: 'csv',
    color: '#ff6a00',
    t,
    channels,
    laps,
    meta: { track: '', rider: '', note: '' },
    lapsFromFile: labExport && lapIdx === undefined ? true : undefined,
  };
}

/** Canonical DDA Lab channel names: unit, and whether the loader recomputes them. */
const LAB_CHANNELS: Record<string, { unit: string; derived?: boolean }> = {
  speed: { unit: 'km/h' }, rpm: { unit: 'rpm' }, tps: { unit: '%' }, dist: { unit: 'km' }, gear: { unit: '' },
  lean: { unit: 'deg' }, tq_fast: { unit: '%' }, tq_slow: { unit: '%' }, gps_alt: { unit: 'm' },
  gps_lon: { unit: 'deg' }, gps_lat: { unit: 'deg' }, lap_mark: { unit: 's' }, int1: { unit: 's' }, int2: { unit: 's' },
  temp: { unit: '°C' }, dtc: { unit: '%' },
  gps_speed: { unit: 'km/h', derived: true }, gps_smooth: { unit: 'km/h', derived: true }, long_g: { unit: 'g', derived: true },
  lat_g: { unit: 'g', derived: true }, total_g: { unit: 'g', derived: true }, curvature: { unit: '1/m', derived: true },
  radius: { unit: 'm', derived: true }, slip: { unit: '%', derived: true }, phase: { unit: '', derived: true },
  lap_dist: { unit: 'm', derived: true }, total_dist: { unit: 'm', derived: true }, delta_t: { unit: 's', derived: true },
  time: { unit: 's', derived: true }, lap_time: { unit: 's', derived: true },
  bearing: { unit: 'deg', derived: true },
  d_speed: { unit: '', derived: true }, d_gps_speed: { unit: '', derived: true }, d_rpm: { unit: '', derived: true },
  d_tps: { unit: '', derived: true }, d_lean: { unit: '', derived: true }, d_long_g: { unit: '', derived: true },
  d_lat_g: { unit: '', derived: true }, d_gear: { unit: '', derived: true },
};

function lapsFromLapColumn(lapValues: Float32Array, t: Float64Array): Lap[] {
  const n = lapValues.length;
  if (n === 0) return [];
  const starts: number[] = [0];
  for (let i = 1; i < n; i++) {
    const prev = lapValues[i - 1];
    const cur = lapValues[i];
    const changed = Number.isNaN(prev) !== Number.isNaN(cur) || (!Number.isNaN(cur) && cur !== prev);
    if (changed) starts.push(i);
  }
  const laps: Lap[] = [];
  for (let k = 0; k < starts.length; k++) {
    const startIdx = starts[k];
    const nextStart = k + 1 < starts.length ? starts[k + 1] : n;
    const endIdx = nextStart - 1;
    const tEnd = t[Math.min(nextStart, n - 1)];
    const kind: Lap['kind'] =
      starts.length > 1 && k === 0 ? 'out' : k === starts.length - 1 && starts.length > 1 ? 'in' : 'flying';
    laps.push({
      n: k + 1,
      startIdx,
      endIdx,
      timeS: tEnd - t[startIdx],
      sectorsS: [],
      isBest: false,
      kind,
    });
  }
  const flying = laps.filter((l) => l.kind === 'flying' && l.timeS > 0);
  if (flying.length) {
    let best = flying[0];
    for (const l of flying) if (l.timeS < best.timeS) best = l;
    best.isBest = true;
  }
  return laps;
}

// ---------------------------------------------------------- external mapping

/** Map selected columns of an arbitrary CSV onto `tBase` as `external` channels. */
export function externalCsvToChannels(
  text: string,
  map: CsvMapping,
  tBase: Float64Array,
): Channel[] {
  const sniff = sniffCsv(text);
  const rows = parseRows(text, sniff.delimiter);
  if (rows.length < 2) throw new Error('externalCsvToChannels: no data rows');
  const header = rows[0];
  const idx = new Map<string, number>(header.map((h, i) => [h, i]));
  const timeIdx = idx.get(map.timeCol);
  if (timeIdx === undefined) {
    throw new Error(`externalCsvToChannels: time column "${map.timeCol}" not found`);
  }
  const body = rows.slice(1);
  const dec = map.decimal;
  const scaleT = map.timeUnit === 'ms' ? 1e-3 : 1;

  const t = new Float64Array(body.length);
  for (let i = 0; i < body.length; i++) {
    t[i] = num(body[i][timeIdx], dec) * scaleT + map.offsetS;
  }

  const out: Channel[] = [];
  for (const def of map.channels) {
    const ci = idx.get(def.col);
    if (ci === undefined) {
      throw new Error(`externalCsvToChannels: column "${def.col}" not found`);
    }
    const v = new Float32Array(body.length);
    for (let i = 0; i < body.length; i++) v[i] = num(body[i][ci], dec);
    const data =
      map.method === 'step'
        ? resampleStepLocal(t, v, tBase)
        : resampleLinearLocal(t, v, tBase);
    out.push({
      name: def.name,
      unit: def.unit,
      kind: 'external',
      data,
      raw: { t, v },
      proc: { ...DEFAULT_PROC, filter: { ...DEFAULT_PROC.filter } },
    });
  }
  return out;
}
