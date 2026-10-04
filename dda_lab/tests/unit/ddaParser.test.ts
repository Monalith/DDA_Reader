import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { CHANNEL_SPECS, parseDda } from '../../src/core/ddaParser';

const here = dirname(fileURLToPath(import.meta.url));
const samplePath = resolve(here, '../../public/sample/sample_run.dda');
const fixturePath = resolve(here, '../fixtures/sample_expected.json');

const expected = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  version: number;
  meta: { track: string; rider: string; odo: number };
  descriptorNames: string[];
  dataChannelNames: string[];
  durationS: number;
  n: Record<string, number>;
  speed_first100: number[];
  speed_t_first10: number[];
  speed_max: number;
  rpm_first100: number[];
  rpm_max: number;
  lat_at3000: number;
  lon_at3000: number;
  lat_first20: number[];
  lon_first20: number[];
  alt_first20: number[];
  lean_first20: number[];
  tps_first20: number[];
  gear_first20: number[];
  dist_first20: number[];
  dist_last: number;
  lap_raw_first20: number[];
  lap_events: number[];
  int1_events: number[];
  int2_events: number[];
};

function buf(): ArrayBuffer {
  const b = readFileSync(samplePath);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

function closeTo(actual: ArrayLike<number>, want: number[], tol = 1e-6) {
  expect(actual.length).toBeGreaterThanOrEqual(want.length);
  for (let i = 0; i < want.length; i++) {
    expect(Math.abs(actual[i] - want[i]), `index ${i}: ${actual[i]} != ${want[i]}`).toBeLessThan(tol);
  }
}

describe('CHANNEL_SPECS', () => {
  it('matches the dda_merge.py table for the known channels', () => {
    expect(CHANNEL_SPECS.SPEED).toEqual([2, 10]);
    expect(CHANNEL_SPECS.RPM).toEqual([2, 2]);
    expect(CHANNEL_SPECS.TEMP).toEqual([1, 100]);
    expect(CHANNEL_SPECS.GAS).toEqual([1, 5]);
    expect(CHANNEL_SPECS.DIST).toEqual([3, 100]);
    expect(CHANNEL_SPECS.GEAR).toEqual([1, 10]);
    expect(CHANNEL_SPECS.PSI_LEAN_ANGLE).toEqual([2, 5]);
    expect(CHANNEL_SPECS.TORQUE_FAST).toEqual([1, 5]);
    expect(CHANNEL_SPECS.TORQUE_SLOW).toEqual([1, 5]);
    expect(CHANNEL_SPECS.DTC).toEqual([1, 5]);
    expect(CHANNEL_SPECS.GPS_ALT).toEqual([2, 10]);
    expect(CHANNEL_SPECS.GPS_LON).toEqual([4, 10]);
    expect(CHANNEL_SPECS.GPS_LAT).toEqual([4, 10]);
    expect(CHANNEL_SPECS.LAP).toEqual([1, 100]);
    expect(CHANNEL_SPECS.INT_LAP1).toEqual([1, 100]);
    expect(CHANNEL_SPECS.INT_LAP2).toEqual([1, 100]);
    expect(CHANNEL_SPECS.ACQ).toEqual([0, 0]);
  });
});

describe('parseDda on sample_run.dda', () => {
  const p = parseDda(buf());

  it('reads header metadata', () => {
    expect(p.meta.track).toBe(expected.meta.track);
    expect(p.meta.rider).toBe(expected.meta.rider);
    expect(p.meta.odo).toBe(expected.meta.odo);
    expect(p.meta.track).toBe('Sonoma Raceway');
  });

  it('reads the descriptor table (ACQ first, 15 descriptors)', () => {
    expect(p.descriptors.map((d) => d.name)).toEqual(expected.descriptorNames);
    expect(p.descriptors.length).toBe(15);
    expect(p.descriptors[0].name).toBe('ACQ');
    expect(p.descriptors[1].desc.length).toBeGreaterThan(0);
  });

  it('exposes the 14 canonical data channels', () => {
    expect(p.channels.map((c) => c.name)).toEqual(expected.dataChannelNames);
    expect(Object.keys(p.series).sort()).toEqual([...expected.dataChannelNames].sort());
  });

  it('matches the Python duration', () => {
    expect(p.durationS).toBeCloseTo(expected.durationS, 6);
    expect(p.durationS).toBe(1109);
  });

  it('matches the Python sample counts per channel', () => {
    for (const [name, n] of Object.entries(expected.n)) {
      expect(p.series[name].v.length, name).toBe(n);
      expect(p.series[name].t.length, name).toBe(n);
    }
  });

  it('matches the Python speed samples and timestamps', () => {
    closeTo(p.series.speed.v, expected.speed_first100);
    closeTo(p.series.speed.t, expected.speed_t_first10, 1e-9);
    let max = -Infinity;
    for (const x of p.series.speed.v) if (x > max) max = x;
    expect(max).toBeCloseTo(expected.speed_max, 6);
    expect(max).toBeGreaterThan(183);
    expect(max).toBeLessThan(184);
  });

  it('matches the Python rpm samples', () => {
    closeTo(p.series.rpm.v, expected.rpm_first100);
    expect(p.series.rpm.t[1]).toBeCloseTo(0.02, 9);
  });

  it('matches the Python GPS / lean / tps / gear / dist samples', () => {
    closeTo(p.series.gps_lat.v, expected.lat_first20);
    closeTo(p.series.gps_lon.v, expected.lon_first20);
    closeTo(p.series.gps_alt.v, expected.alt_first20);
    closeTo(p.series.lean.v, expected.lean_first20);
    closeTo(p.series.tps.v, expected.tps_first20);
    closeTo(p.series.gear.v, expected.gear_first20);
    closeTo(p.series.dist.v, expected.dist_first20);
    expect(p.series.gps_lat.v[3000]).toBeCloseTo(expected.lat_at3000, 6);
    expect(p.series.gps_lon.v[3000]).toBeCloseTo(expected.lon_at3000, 6);
    expect(p.series.gps_lat.v[3000]).toBeGreaterThan(38.1);
    expect(p.series.gps_lat.v[3000]).toBeLessThan(38.3);
  });

  it('keeps raw lap marker bytes and exposes crossing times', () => {
    closeTo(p.series.lap_mark.v, expected.lap_raw_first20);
    expect(Array.from(p.lapEvents).map((x) => +x.toFixed(6)))
      .toEqual(expected.lap_events.map((x) => +x.toFixed(6)));
    expect(p.lapEvents.length).toBe(4);
    expect(p.intEvents.int1).toEqual(expected.int1_events);
    expect(p.intEvents.int2).toEqual(expected.int2_events);
  });
});

describe('parseDda errors and scaling', () => {
  it('rejects a non-DDA buffer', () => {
    expect(() => parseDda(new ArrayBuffer(1000))).toThrow();
  });

  it('decodes a hand-built one-second stream with correct scales', () => {
    // header: version 4, "DDA\0", 2 descriptors (ACQ + SPEED)
    const count = 2;
    const dataStart = 430 + 80 * count;
    const speedPerSec = 10; // 100 / periodCs 10
    const bytes = new Uint8Array(dataStart + speedPerSec * 2);
    const dv = new DataView(bytes.buffer);
    dv.setUint16(0, 4, true);
    bytes.set([0x44, 0x44, 0x41, 0x00], 2);
    const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
    bytes.set(enc('TestTrack'), 0x2a);
    bytes.set(enc('TestRider'), 0x6a);
    dv.setUint32(0xb2, 12345, true);
    bytes[0x1ad] = count;
    bytes.set(enc('ACQ'), 0x1ae);
    bytes.set(enc('SPEED'), 0x1ae + 80);
    bytes.set(enc('Vehicle speed'), 0x1ae + 80 + 0x16);
    bytes.set(enc('km/h'), 0x1ae + 80 + 0x16 + 14);
    for (let i = 0; i < speedPerSec; i++) dv.setUint16(dataStart + i * 2, 1000 + i, true);

    const q = parseDda(bytes.buffer);
    expect(q.meta.track).toBe('TestTrack');
    expect(q.meta.rider).toBe('TestRider');
    expect(q.meta.odo).toBe(12345);
    expect(q.descriptors[1].desc).toBe('Vehicle speed');
    expect(q.descriptors[1].unit).toBe('km/h');
    expect(q.descriptors[1].sizeBytes).toBe(2);
    expect(q.descriptors[1].periodCs).toBe(10);
    expect(q.channels.map((c) => c.name)).toEqual(['speed']);
    expect(q.series.speed.v.length).toBe(speedPerSec);
    expect(q.series.speed.v[0]).toBeCloseTo(1000 * 0.065625, 9);
    expect(q.series.speed.t[2]).toBeCloseTo(0.2, 9);
    expect(q.durationS).toBe(1);
    expect(q.lapEvents.length).toBe(0);
  });
});
