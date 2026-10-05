import { describe, expect, it } from 'vitest';
import { interpAt, visibleRows } from '../../src/core/exportVisible';
import { lapToCsv } from '../../src/core/bundle';
import { dragZoomFactorY, yOuterExtent, zoomRange } from '../../src/ui/chartInteractions';
import { computeDerived } from '../../src/core/derived';
import { DEFAULT_PROC, type Channel, type Session } from '../../src/core/types';
import type { OverlayLine } from '../../src/state/selectors';

function line(key: string, x: number[], y: number[]): OverlayLine {
  return { key, label: key, color: '#fff', x: Float64Array.from(x), y: Float32Array.from(y), axis: 'L', sessionId: 's', lap: 1, startIdx: 0, channel: 'c' };
}

describe('export visible', () => {
  it('interpolates linearly and is NaN outside the line', () => {
    const x = Float64Array.from([0, 10, 20]);
    const y = Float32Array.from([0, 100, 200]);
    expect(interpAt(x, y, 5)).toBe(50);
    expect(interpAt(x, y, 10)).toBe(100);
    expect(Number.isNaN(interpAt(x, y, 25))).toBe(true);
  });
  it('writes one column per line on a 1 m grid inside the visible range', () => {
    const rows = visibleRows({
      xAxis: 'distance',
      range: [2, 5],
      panels: [{ id: 'p', lines: [line('A speed', [0, 10], [0, 100]), line('B speed', [0, 10], [10, 110])] }],
    });
    expect(rows[0]).toEqual(['Distance_m', 'A speed', 'B speed']);
    expect(rows).toHaveLength(5); // x = 2,3,4,5
    expect(rows[1]).toEqual([2, 20, 30]);
    expect(rows[4]).toEqual([5, 50, 60]);
  });
  it('without a zoom uses the full extent of the plotted lines', () => {
    const rows = visibleRows({ xAxis: 'time', range: null, panels: [{ id: 'p', lines: [line('A', [0, 1], [0, 10])] }] });
    expect(rows[0][0]).toBe('Time_s');
    expect(rows).toHaveLength(12); // 0.0 .. 1.0
  });
  it('lapToCsv keeps only rows inside the visible range', () => {
    const n = 20;
    const t = Float64Array.from({ length: n }, (_, i) => i / 10);
    const ch = (name: string, data: Float32Array): Channel => ({ name, unit: '', kind: 'raw', data, proc: { ...DEFAULT_PROC } });
    const s: Session = {
      id: 's', name: 's', source: 'csv', color: '#fff', t,
      channels: new Map([['speed', ch('speed', new Float32Array(n).fill(50))], ['lap_dist', { ...ch('lap_dist', Float32Array.from({ length: n }, (_, i) => i * 5)), kind: 'derived' }]]),
      laps: [{ n: 1, startIdx: 0, endIdx: n - 1, timeS: 2, sectorsS: [], isBest: true, kind: 'flying' }],
      meta: { track: '', rider: '', note: '' },
    };
    const all = lapToCsv(s, s.laps[0]).trim().split('\n');
    expect(all).toHaveLength(21);
    const vis = lapToCsv(s, s.laps[0], { xAxis: 'distance', range: [20, 40] }).trim().split('\n');
    expect(vis).toHaveLength(6); // lap_dist 20,25,30,35,40
    const byTime = lapToCsv(s, s.laps[0], { xAxis: 'time', range: [0, 0.5] }).trim().split('\n');
    expect(byTime).toHaveLength(7);
  });
});

describe('y axis zoom helpers', () => {
  it('drag up zooms in, drag down zooms out', () => {
    expect(dragZoomFactorY(-120)).toBeCloseTo(Math.E, 6);
    expect(dragZoomFactorY(120)).toBeCloseTo(1 / Math.E, 6);
  });
  it('outer extent widens the data span symmetrically and zoomRange respects it', () => {
    expect(yOuterExtent([0, 10])).toEqual([-25, 35]);
    const r = zoomRange([0, 10], yOuterExtent([0, 10]), 0.5, 5);
    expect(r[1] - r[0]).toBeCloseTo(20, 6);
    expect(r[0]).toBeCloseTo(-5, 6);
  });
});

describe('missing channels are estimated on import', () => {
  function gpsOnlySession(): Session {
    // a 300 m straight at 10 m/s, 10 Hz, GPS only (like a video-telemetry file without ECU data)
    const n = 301;
    const t = Float64Array.from({ length: n }, (_, i) => i / 10);
    const lat = Float32Array.from({ length: n }, (_, i) => 41.07 + (i * 1) / 110_540);
    const lon = new Float32Array(n).fill(23.5);
    const ch = (name: string, data: Float32Array, unit: string): Channel => ({ name, unit, kind: 'raw', data, proc: { ...DEFAULT_PROC } });
    return {
      id: 'g', name: 'g', source: 'json', color: '#fff', t,
      channels: new Map([['gps_lat', ch('gps_lat', lat, 'deg')], ['gps_lon', ch('gps_lon', lon, 'deg')]]),
      laps: [{ n: 1, startIdx: 0, endIdx: n - 1, timeS: 30, sectorsS: [], isBest: true, kind: 'flying' }],
      meta: { track: '', rider: '', note: '' },
    };
  }
  it('fills speed, dist and lean with a provenance note', () => {
    const s = gpsOnlySession();
    computeDerived(s);
    const speed = s.channels.get('speed')!;
    expect(speed.note).toContain('estimated');
    expect(speed.data[150]).toBeGreaterThan(30);
    expect(speed.data[150]).toBeLessThan(42);
    const dist = s.channels.get('dist')!;
    expect(dist.note).toContain('estimated');
    expect(dist.data[300]).toBeGreaterThan(0.25);
    expect(dist.data[300]).toBeLessThan(0.35);
    const lean = s.channels.get('lean')!;
    expect(lean.note).toContain('estimated');
    expect(Math.abs(lean.data[150])).toBeLessThan(5); // straight line → ~0°
    // a second pass does not treat the estimates as real inputs and stays stable
    computeDerived(s);
    expect(s.channels.get('speed')!.note).toContain('estimated');
  });
  it('does not touch channels the file really has', () => {
    const s = gpsOnlySession();
    s.channels.set('speed', { name: 'speed', unit: 'km/h', kind: 'raw', data: new Float32Array(301).fill(99), proc: { ...DEFAULT_PROC } });
    computeDerived(s);
    expect(s.channels.get('speed')!.note).toBeUndefined();
    expect(s.channels.get('speed')!.data[10]).toBe(99);
  });
});
