import { describe, expect, it } from 'vitest';
import {
  ddaReaderCsvToSession,
  externalCsvToChannels,
  sniffCsv,
  type CsvMapping,
} from '../../src/core/csvImport';

const DDA_HEADER =
  'Time_s,Speed_kmh,Speed_mph,GPS_Speed_kmh,GPS_Speed_mph,Wheel_Slip_pct,RPM,TPS_pct,Gear,' +
  'LeanAngle_deg,DTC_Fast_pct,DTC_Slow_pct,Distance_m,GPS_Lat,GPS_Lon,GPS_Alt_m,GPS_Alt_ft,' +
  'Lap,Split1,Split2';

function ddaRow(i: number, lap: number, gps = true): string {
  const t = (i * 0.1).toFixed(1);
  const kmh = 100 + i;
  return [
    t,
    kmh.toFixed(3),
    (kmh / 1.609344).toFixed(3),
    (kmh + 1).toFixed(3),
    ((kmh + 1) / 1.609344).toFixed(3),
    '0.000',
    String(8000 + i * 10),
    '50.0',
    String(3),
    '-12.5',
    '1.0',
    '2.0',
    (i * 2.5).toFixed(2),
    gps ? (38.16 + i * 1e-5).toFixed(6) : '',
    gps ? (-122.45 + i * 1e-5).toFixed(6) : '',
    gps ? '30.0' : '',
    gps ? '98.4' : '',
    String(lap),
    '',
    '',
  ].join(',');
}

const DDA_CSV = [
  DDA_HEADER,
  ...Array.from({ length: 12 }, (_, i) => ddaRow(i, i < 4 ? 1 : i < 8 ? 2 : 3, i !== 5)),
].join('\n');

describe('sniffCsv', () => {
  it('detects a semicolon delimiter and comma decimal', () => {
    const text = 'time;speed;rpm\n0,0;10,5;8000\n0,1;11,0;8100\n0,2;12,5;8200\n';
    const r = sniffCsv(text);
    expect(r.delimiter).toBe(';');
    expect(r.decimal).toBe(',');
    expect(r.columns).toEqual(['time', 'speed', 'rpm']);
    expect(r.isDdaReaderExport).toBe(false);
  });

  it('detects a comma delimiter with dot decimals and tabs', () => {
    const comma = sniffCsv('a,b\n1.5,2.5\n');
    expect(comma.delimiter).toBe(',');
    expect(comma.decimal).toBe('.');
    const tab = sniffCsv('a\tb\n1.5\t2.5\n');
    expect(tab.delimiter).toBe('\t');
  });

  it('returns at most five preview rows', () => {
    const text = ['a,b', ...Array.from({ length: 9 }, (_, i) => `${i},${i}`)].join('\n');
    const r = sniffCsv(text);
    expect(r.preview.length).toBe(5);
    expect(r.preview[0]).toEqual(['0', '0']);
  });

  it('detects the DDA_Reader export header', () => {
    const r = sniffCsv(DDA_CSV);
    expect(r.isDdaReaderExport).toBe(true);
    expect(r.columns[0]).toBe('Time_s');
    expect(r.columns.length).toBe(20);
  });
});

describe('ddaReaderCsvToSession', () => {
  const s = ddaReaderCsvToSession(DDA_CSV, 'run1');

  it('builds a 10 Hz session', () => {
    expect(s.source).toBe('csv');
    expect(s.name).toBe('run1');
    expect(s.t.length).toBe(12);
    expect(s.t[1] - s.t[0]).toBeCloseTo(0.1, 9);
  });

  it('creates the eleven canonical raw channels', () => {
    expect(s.channels.size).toBe(11);
    for (const n of [
      'speed',
      'rpm',
      'tps',
      'gear',
      'lean',
      'tq_fast',
      'tq_slow',
      'dist',
      'gps_lat',
      'gps_lon',
      'gps_alt',
    ]) {
      expect(s.channels.has(n), n).toBe(true);
      expect(s.channels.get(n)!.kind).toBe('raw');
    }
    expect(s.channels.get('speed')!.unit).toBe('km/h');
    expect(s.channels.get('dist')!.unit).toBe('m');
  });

  it('keeps channel values', () => {
    expect(s.channels.get('speed')!.data[0]).toBeCloseTo(100, 3);
    expect(s.channels.get('rpm')!.data[2]).toBeCloseTo(8020, 3);
    expect(s.channels.get('dist')!.data[2]).toBeCloseTo(5, 3);
    expect(s.channels.get('gear')!.data[0]).toBe(3);
  });

  it('turns empty GPS cells into NaN', () => {
    expect(Number.isNaN(s.channels.get('gps_lat')!.raw!.v[5])).toBe(true);
    expect(s.channels.get('gps_lat')!.raw!.v[4]).toBeCloseTo(38.16004, 5);
  });

  it('derives laps from the Lap column with out/flying/in kinds', () => {
    expect(s.laps.length).toBe(3);
    expect(s.laps.map((l) => l.kind)).toEqual(['out', 'flying', 'in']);
    expect(s.laps[0].startIdx).toBe(0);
    expect(s.laps[1].startIdx).toBe(4);
    expect(s.laps[2].endIdx).toBe(11);
    expect(s.laps[1].timeS).toBeCloseTo(0.4, 6);
    expect(s.laps.filter((l) => l.isBest).length).toBe(1);
    expect(s.laps[1].isBest).toBe(true);
  });
});

describe('externalCsvToChannels', () => {
  const tBase = Float64Array.from({ length: 11 }, (_, i) => i * 0.1);

  it('maps selected columns onto the time base', () => {
    const text = 'time;brake;susp\n0,0;0,0;1,0\n500,0;10,0;2,0\n1000,0;20,0;3,0\n';
    const map: CsvMapping = {
      timeCol: 'time',
      timeUnit: 'ms',
      decimal: ',',
      channels: [
        { col: 'brake', name: 'brake_bar', unit: 'bar' },
        { col: 'susp', name: 'susp_front', unit: 'mm' },
      ],
      offsetS: 0,
      method: 'linear',
    };
    const chs = externalCsvToChannels(text, map, tBase);
    expect(chs.length).toBe(2);
    expect(chs[0].name).toBe('brake_bar');
    expect(chs[0].unit).toBe('bar');
    expect(chs[0].kind).toBe('external');
    expect(chs[0].proc.scale).toBe(1);
    expect(chs[0].data.length).toBe(tBase.length);
    expect(chs[0].data[0]).toBeCloseTo(0, 5);
    expect(chs[0].data[5]).toBeCloseTo(10, 5);
    expect(chs[0].data[10]).toBeCloseTo(20, 5);
    expect(chs[1].data[5]).toBeCloseTo(2, 5);
  });

  it('applies the time offset and NaN-pads outside the source range', () => {
    const text = 'time,v\n0,0\n0.5,10\n1.0,20\n';
    const map: CsvMapping = {
      timeCol: 'time',
      timeUnit: 's',
      decimal: '.',
      channels: [{ col: 'v', name: 'v', unit: '' }],
      offsetS: 0.3,
      method: 'linear',
    };
    const ch = externalCsvToChannels(text, map, tBase)[0];
    expect(Number.isNaN(ch.data[0])).toBe(true);
    expect(ch.data[3]).toBeCloseTo(0, 5);
    expect(ch.data[8]).toBeCloseTo(10, 5);
  });

  it('supports step resampling', () => {
    const text = 'time,v\n0,0\n0.5,10\n1.0,20\n';
    const map: CsvMapping = {
      timeCol: 'time',
      timeUnit: 's',
      decimal: '.',
      channels: [{ col: 'v', name: 'v', unit: '' }],
      offsetS: 0,
      method: 'step',
    };
    const ch = externalCsvToChannels(text, map, tBase)[0];
    expect(ch.data[3]).toBe(0);
    expect(ch.data[5]).toBe(10);
    expect(ch.data[9]).toBe(10);
  });

  it('throws when the time column is missing', () => {
    const map: CsvMapping = {
      timeCol: 'nope',
      timeUnit: 's',
      decimal: '.',
      channels: [{ col: 'v', name: 'v', unit: '' }],
      offsetS: 0,
      method: 'linear',
    };
    expect(() => externalCsvToChannels('time,v\n0,1\n', map, tBase)).toThrow();
  });
});
