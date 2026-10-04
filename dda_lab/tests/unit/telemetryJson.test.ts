import { describe, expect, it } from 'vitest';
import { isTelemetryJson, telemetryJsonToSession } from '../../src/core/telemetryJson';
import { computeDerived } from '../../src/core/derived';

function sample() {
  // 300 m straight at 36 km/h (10 m/s): one row per metre, 0.1 s apart
  const rows = Array.from({ length: 301 }, (_, i) => ({
    s_m: i, t_s: i / 10, hiz_kmh: 36, gaz_pct: null, vites: null, boylamsal_g: 0,
    lat: 41.07 + i * 1e-5, lon: 23.5,
  }));
  return {
    meta: { kisa_ad: 'BMW', ad: 'BMW onboard', pist: 'Serres Racing Circuit', tur_suresi: '1:19.81' },
    viraj_ozeti: [
      { viraj: 'K1', yon: 'Sağ', bolge_m: [100, 150], apeks_m: 120, fren_basi_m: 60 },
      { viraj: 'K2', yon: 'Sol', bolge_m: [200, 260], apeks_m: 230 },
    ],
    telemetri_1m: rows,
  };
}

describe('telemetry JSON import', () => {
  it('detects the layout', () => {
    expect(isTelemetryJson(sample())).toBe(true);
    expect(isTelemetryJson({ records: [] })).toBe(false);
  });
  it('builds a 10 Hz session with speed, gps, dist and one flying lap', () => {
    const s = telemetryJsonToSession(sample(), 'bmw', '#fff', () => 'x');
    expect(s.t.length).toBe(301);
    expect(s.channels.get('speed')!.data[50]).toBeCloseTo(36, 3);
    expect(s.channels.has('tps')).toBe(false); // all null
    expect(s.channels.get('dist')!.data[100]).toBeCloseTo(100, 1);
    expect(s.channels.get('gps_lat')!.data[0]).toBeCloseTo(41.07, 5);
    expect(s.laps).toHaveLength(1);
    expect(s.laps[0].timeS).toBeCloseTo(79.81, 2);
    expect(s.meta.track).toBe('Serres Racing Circuit');
  });
  it('carries turn hints with geo positions and the start/finish', () => {
    const s = telemetryJsonToSession(sample(), 'bmw', '#fff', () => 'x');
    expect(s.turnHints).toHaveLength(2);
    expect(s.turnHints![0]).toMatchObject({ name: 'K1', dir: 'R' });
    expect(s.turnHints![0].apexGeo[1]).toBeCloseTo(41.07 + 120e-5, 6);
    expect(s.turnHints![0].brakeGeo![1]).toBeCloseTo(41.07 + 60e-5, 6);
    expect(s.turnHints![1].dir).toBe('L');
    expect(s.sfHint![1]).toBeCloseTo(41.07, 6);
  });
  it('derives gps_smooth as a 0.4 Hz low-pass of gps_speed', () => {
    const s = telemetryJsonToSession(sample(), 'bmw', '#fff', () => 'x');
    computeDerived(s);
    const g = s.channels.get('gps_smooth')!;
    expect(g.unit).toBe('km/h');
    expect(g.data[150]).toBeGreaterThan(30);
    expect(g.data[150]).toBeLessThan(45);
  });
});
