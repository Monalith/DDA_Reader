// TypeScript port of the slot-packed Ducati .dda (header v4) decoder.
// Reference implementation: tests/gen_fixture.py / ../../dda_merge.py (CHANNEL_SPECS).
import { DDA_NAME_MAP } from './types';

const HEADER_VERSION_OFFSET = 0x00;
const SIGNATURE_OFFSET = 0x02;
const PLACE_OFFSET = 0x2a;
const PLACE_LEN = 64;
const RIDER_OFFSET = 0x6a;
const RIDER_LEN = 64;
const ODO_OFFSET = 0xb2;
const CHANNEL_COUNT_OFFSET = 0x1ad;
const CHANNEL_TABLE_OFFSET = 0x1ae; // = 430
const DESCRIPTOR_SIZE = 80;
const DESC_TEXT_OFFSET = 0x16;

/** Channel name -> [byte size, sample period in 1/100 s]. Same table as dda_merge.py. */
export const CHANNEL_SPECS: Record<string, [sizeBytes: number, periodCs: number]> = {
  ACQ: [0, 0],
  SPEED: [2, 10],
  RPM: [2, 2],
  TEMP: [1, 100],
  GAS: [1, 5],
  DIST: [3, 100],
  GEAR: [1, 10],
  PSI_LEAN_ANGLE: [2, 5],
  TORQUE_FAST: [1, 5],
  TORQUE_SLOW: [1, 5],
  DTC: [1, 5],
  GPS_ALT: [2, 10],
  GPS_LON: [4, 10],
  GPS_LAT: [4, 10],
  LAP: [1, 100],
  INT_LAP1: [1, 100],
  INT_LAP2: [1, 100],
  FORK: [2, 1],
  SHOCK: [2, 1],
  P_FBAK: [2, 20],
  P_RBAK: [2, 20],
  F_SPD: [2, 5],
  R_SPD: [2, 5],
  V_BATT: [1, 20],
  DQS_SW: [1, 10],
  DTC_LEV: [1, 100],
  DAS_LEV: [1, 100],
};

const SIGNED = new Set(['GPS_LON', 'GPS_LAT', 'GPS_ALT']);
/** Lap-marker style channels: byte 0xFF = no crossing, else hundredths within the second. */
const MARKER_CHANNELS = new Set(['LAP', 'INT_LAP1', 'INT_LAP2']);

export interface DdaChannelDesc {
  /** canonical channel name (see DDA_NAME_MAP), e.g. 'speed' */
  name: string;
  unit: string;
  desc: string;
  sizeBytes: number;
  periodCs: number;
  /** original descriptor name as written in the file, e.g. 'PSI_LEAN_ANGLE' */
  ddaName: string;
}

export interface DdaDescriptor {
  /** descriptor name as written in the file (includes the leading 'ACQ' trigger) */
  name: string;
  desc: string;
  unit: string;
  sizeBytes: number;
  periodCs: number;
}

export interface ParsedDda {
  meta: { track: string; rider: string; note: string; odo: number };
  /** header version (4 for all known files) */
  version: number;
  /** the data-carrying channels in stream order, canonical names */
  channels: DdaChannelDesc[];
  /** every descriptor in the file in table order, raw names (first is 'ACQ') */
  descriptors: DdaDescriptor[];
  /** canonical name -> native-rate samples */
  series: Record<string, { t: Float64Array; v: Float64Array }>;
  durationS: number;
  /** start/finish crossing times in seconds, from the LAP channel */
  lapEvents: Float64Array;
  /** intermediate (split) crossing times in seconds */
  intEvents: { int1: number[]; int2: number[] };
  /** number of payload bytes actually consumed */
  bytesConsumed: number;
}

function cstr(bytes: Uint8Array, start: number, limit: number): string {
  const end = Math.min(start + limit, bytes.length);
  let i = start;
  while (i < end && bytes[i] !== 0) i++;
  let s = '';
  for (let k = start; k < i; k++) s += String.fromCharCode(bytes[k]); // latin1
  return s;
}

/** Physical scaling for a raw integer read from the stream. */
function scaleValue(ddaName: string, raw: number): number {
  switch (ddaName) {
    case 'SPEED':
      return raw * 0.065625;
    case 'GAS':
      return raw * 0.5;
    case 'PSI_LEAN_ANGLE':
      return raw * 0.054931640625 - 450;
    case 'GPS_LON':
    case 'GPS_LAT':
      return raw * 1e-6;
    case 'GPS_ALT':
      return raw * 0.1;
    default:
      return raw;
  }
}

function readLE(bytes: Uint8Array, pos: number, size: number, signed: boolean): number {
  let v = 0;
  for (let i = size - 1; i >= 0; i--) v = v * 256 + bytes[pos + i];
  if (signed) {
    const half = Math.pow(2, size * 8 - 1);
    if (v >= half) v -= half * 2;
  }
  return v;
}

export function parseDda(buf: ArrayBuffer): ParsedDda {
  const bytes = new Uint8Array(buf);
  if (bytes.length < CHANNEL_TABLE_OFFSET + DESCRIPTOR_SIZE) {
    throw new Error('not a DDA file: too short');
  }
  if (
    bytes[SIGNATURE_OFFSET] !== 0x44 ||
    bytes[SIGNATURE_OFFSET + 1] !== 0x44 ||
    bytes[SIGNATURE_OFFSET + 2] !== 0x41 ||
    bytes[SIGNATURE_OFFSET + 3] !== 0x00
  ) {
    throw new Error("not a DDA file: missing 'DDA' signature");
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = dv.getUint16(HEADER_VERSION_OFFSET, true);
  if (version !== 4) throw new Error(`unsupported DDA header version ${version}`);

  const track = cstr(bytes, PLACE_OFFSET, PLACE_LEN);
  const rider = cstr(bytes, RIDER_OFFSET, RIDER_LEN);
  const odo = dv.getUint32(ODO_OFFSET, true);
  const count = bytes[CHANNEL_COUNT_OFFSET];

  const descriptors: DdaDescriptor[] = [];
  const channels: DdaChannelDesc[] = [];
  for (let i = 0; i < count; i++) {
    const off = CHANNEL_TABLE_OFFSET + DESCRIPTOR_SIZE * i;
    const name = cstr(bytes, off, 16);
    const desc = cstr(bytes, off + DESC_TEXT_OFFSET, DESCRIPTOR_SIZE - DESC_TEXT_OFFSET);
    const unitOff = off + DESC_TEXT_OFFSET + desc.length + 1;
    const unit = cstr(bytes, unitOff, Math.max(0, off + DESCRIPTOR_SIZE - unitOff));
    const spec = CHANNEL_SPECS[name] ?? [0, 0];
    descriptors.push({ name, desc, unit, sizeBytes: spec[0], periodCs: spec[1] });
    if (spec[0] > 0 && spec[1] > 0) {
      const mapped = DDA_NAME_MAP[name];
      channels.push({
        name: mapped ? mapped.name : name.toLowerCase(),
        unit: mapped ? mapped.unit : unit,
        desc,
        sizeBytes: spec[0],
        periodCs: spec[1],
        ddaName: name,
      });
    }
  }

  const dataStart = CHANNEL_TABLE_OFFSET + DESCRIPTOR_SIZE * count;
  const payloadLen = Math.max(0, bytes.length - dataStart);

  // How many samples of each channel fit in the payload: decode in slot order.
  const bytesPerSecond =
    channels.reduce((sum, c) => sum + c.sizeBytes * (100 / c.periodCs), 0) || 1;
  const secs = Math.floor(payloadLen / bytesPerSecond) + 1; // + partial second
  const tArr: Float64Array[] = [];
  const vArr: Float64Array[] = [];
  const nArr: number[] = [];
  for (const c of channels) {
    const cap = Math.ceil((secs * 100) / c.periodCs) + 1;
    tArr.push(new Float64Array(cap));
    vArr.push(new Float64Array(cap));
    nArr.push(0);
  }

  const lapEventList: number[] = [];
  const intEvents: { int1: number[]; int2: number[] } = { int1: [], int2: [] };

  let pos = dataStart;
  let t = 0;
  let done = false;
  while (!done) {
    for (let ci = 0; ci < channels.length; ci++) {
      const c = channels[ci];
      if (t % c.periodCs !== 0) continue;
      if (pos + c.sizeBytes > bytes.length) {
        done = true;
        break;
      }
      const raw = readLE(bytes, pos, c.sizeBytes, SIGNED.has(c.ddaName));
      pos += c.sizeBytes;
      const tS = t / 100;
      const n = nArr[ci]++;
      tArr[ci][n] = tS;
      if (MARKER_CHANNELS.has(c.ddaName)) {
        vArr[ci][n] = raw; // keep the raw byte (0xFF = no crossing)
        if (raw !== 0xff) {
          const at = tS + raw / 100;
          if (c.ddaName === 'LAP') lapEventList.push(at);
          else if (c.ddaName === 'INT_LAP1') intEvents.int1.push(at);
          else intEvents.int2.push(at);
        }
      } else {
        vArr[ci][n] = scaleValue(c.ddaName, raw);
      }
    }
    if (done) break;
    t += 1;
  }

  const series: Record<string, { t: Float64Array; v: Float64Array }> = {};
  for (let ci = 0; ci < channels.length; ci++) {
    series[channels[ci].name] = {
      t: tArr[ci].subarray(0, nArr[ci]),
      v: vArr[ci].subarray(0, nArr[ci]),
    };
  }

  const bytesConsumed = pos - dataStart;
  const durationS = Math.floor(bytesConsumed / bytesPerSecond);

  return {
    meta: { track, rider, note: '', odo },
    version,
    channels,
    descriptors,
    series,
    durationS,
    lapEvents: Float64Array.from(lapEventList),
    intEvents,
    bytesConsumed,
  };
}
