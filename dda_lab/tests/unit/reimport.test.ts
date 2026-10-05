import { describe, expect, it } from 'vitest';
import { ddaReaderCsvToSession } from '../../src/core/csvImport';
import { lapToCsv, lapToBundleLap, makeBundle } from '../../src/core/bundle';
import { looksLikeBundle } from '../../src/core/sessionLoader';
import { visibleCsv } from '../../src/core/exportVisible';
import { DEFAULT_PROC, DEFAULT_WORKSPACE, type Channel, type Session } from '../../src/core/types';

function session(): Session {
  const n = 50;
  const t = Float64Array.from({ length: n }, (_, i) => i / 10);
  const ch = (name: string, data: Float32Array, unit = '', kind: Channel['kind'] = 'raw'): Channel => ({ name, unit, kind, data, proc: { ...DEFAULT_PROC } });
  return {
    id: 's', name: 's', source: 'dda', color: '#fff', t,
    channels: new Map([
      ['speed', ch('speed', Float32Array.from({ length: n }, (_, i) => 100 + i), 'km/h')],
      ['gear', ch('gear', new Float32Array(n).fill(3))],
      ['gps_lat', ch('gps_lat', Float32Array.from({ length: n }, (_, i) => 41.07 + i * 1e-5), 'deg')],
      ['gps_lon', ch('gps_lon', new Float32Array(n).fill(23.52), 'deg')],
      ['lap_dist', ch('lap_dist', Float32Array.from({ length: n }, (_, i) => i * 2), 'm', 'derived')],
      ['my_math', ch('my_math', new Float32Array(n).fill(7), '', 'math')],
    ]),
    laps: [{ n: 1, startIdx: 0, endIdx: n - 1, timeS: 4.9, sectorsS: [], isBest: true, kind: 'flying' }],
    meta: { track: '', rider: '', note: '' },
  };
}

describe('files DDA Lab writes can be opened again', () => {
  it('a per-lap CSV (Laps → Export CSV) reopens as a one-lap session with its raw channels', () => {
    const s = session();
    const csv = lapToCsv(s, s.laps[0]);
    const back = ddaReaderCsvToSession(csv, 'L1');
    expect(back.laps).toHaveLength(1);
    expect(back.lapsFromFile).toBe(true);
    expect(back.channels.get('speed')!.data[10]).toBeCloseTo(110, 2);
    expect(back.channels.get('speed')!.kind).toBe('raw');
    expect(back.channels.get('gps_lat')!.data[0]).toBeCloseTo(41.07, 4);
    expect(back.channels.has('lap_dist')).toBe(false); // derived: recomputed on load
    expect(back.channels.get('my_math')!.kind).toBe('external'); // unknown name kept as external
  });
  it('the "Export visible" CSV explains that it is a spreadsheet export', () => {
    const s = session();
    const csv = visibleCsv({
      xAxis: 'distance', range: null,
      panels: [{ id: 'p', lines: [{ key: 'k', label: 's L1 speed', color: '#fff', x: Float64Array.from([0, 2, 4]), y: Float32Array.from([1, 2, 3]), axis: 'L', sessionId: 's', lap: 1, startIdx: 0, channel: 'speed' }] }],
    });
    expect(() => ddaReaderCsvToSession(csv, 'vis')).toThrow(/Export visible/);
  });
  it('a bundle is recognised by content even when renamed', () => {
    const s = session();
    const text = makeBundle([lapToBundleLap(s, s.laps[0], 'L1', '#f00')], undefined, DEFAULT_WORKSPACE);
    expect(looksLikeBundle(JSON.parse(text))).toBe(true);
    expect(looksLikeBundle({ records: [] })).toBe(false);
  });
});
