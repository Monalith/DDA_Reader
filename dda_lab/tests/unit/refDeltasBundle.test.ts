import { beforeEach, describe, expect, it } from 'vitest';
import { bundleDecimals, lapToBundleLap, makeBundle, parseBundle } from '../../src/core/bundle';
import { applyRefDeltas } from '../../src/state/derivedExtras';
import { CHART_TEMPLATES, templatePanels } from '../../src/core/chartTemplates';
import { parseWorkspace, serializeWorkspace } from '../../src/core/workspace';
import { DEFAULT_PROC, DEFAULT_WORKSPACE, type Channel, type Lap, type Session } from '../../src/core/types';
import { useLab } from '../../src/state/store';

function ch(name: string, data: Float32Array, unit = '', kind: Channel['kind'] = 'raw'): Channel {
  return { name, unit, kind, data, proc: { ...DEFAULT_PROC } };
}

/** Two laps of 100 samples; lap 2 is 10 km/h faster everywhere. lap_dist = 0..99 in both. */
function session(): Session {
  const n = 200;
  const t = Float64Array.from({ length: n }, (_, i) => i / 10);
  const speed = Float32Array.from({ length: n }, (_, i) => (i < 100 ? 100 : 110));
  const lapDist = Float32Array.from({ length: n }, (_, i) => i % 100);
  const lat = Float32Array.from({ length: n }, (_, i) => 41.0695152 + i * 1e-5);
  const lon = Float32Array.from({ length: n }, () => 23.5205154);
  const laps: Lap[] = [0, 1].map((k) => ({ n: k + 1, startIdx: k * 100, endIdx: k * 100 + 99, timeS: 10, sectorsS: [], isBest: k === 1, kind: 'flying' }));
  return {
    id: 's', name: 's', source: 'csv', color: '#fff', t,
    channels: new Map([
      ['speed', ch('speed', speed, 'km/h')],
      ['gps_lat', ch('gps_lat', lat, 'deg')],
      ['gps_lon', ch('gps_lon', lon, 'deg')],
      ['lap_dist', ch('lap_dist', lapDist, 'm', 'derived')],
    ]),
    laps, meta: { track: '', rider: '', note: '' },
  };
}

describe('bundle export keeps GPS precision and only raw data', () => {
  it('uses 7 decimals for coordinates (≈1 cm) and 4 elsewhere', () => {
    expect(bundleDecimals('gps_lat')).toBe(7);
    expect(bundleDecimals('gps_lon')).toBe(7);
    expect(bundleDecimals('speed')).toBe(4);
  });
  it('round-trips coordinates without quantising the track and recomputes derived channels', () => {
    const s = session();
    const bl = lapToBundleLap(s, s.laps[0], 'L1', '#f00');
    expect(bl.channels.map((c) => c.name)).toEqual(['speed', 'gps_lat', 'gps_lon']); // derived dropped
    const lat = bl.channels.find((c) => c.name === 'gps_lat')!.data;
    expect(lat[0]).toBeCloseTo(41.0695152, 6);
    // the ~1 m step survives (Float32 source ≈ 4e-6 resolution; toFixed(4) would have made it 0)
    expect(lat[1]! - lat[0]!).toBeGreaterThan(5e-6);
    expect(lat[1]! - lat[0]!).toBeLessThan(2e-5);
    const parsed = parseBundle(makeBundle([bl], undefined, DEFAULT_WORKSPACE));
    expect(parsed.sessions[0].session.lapsFromFile).toBe(true);
    expect(parsed.sessions[0].session.channels.has('lap_dist')).toBe(false);
  });
});

describe('d_* channels against the reference lap', () => {
  it('is 0 on the reference lap and value − reference elsewhere', () => {
    const s = session();
    applyRefDeltas(s, s, s.laps[0]);
    const d = s.channels.get('d_speed')!;
    expect(d.unit).toBe('km/h');
    expect(d.data[50]).toBe(0);
    expect(d.data[150]).toBeCloseTo(10, 5);
  });
  it('is NaN without a reference', () => {
    const s = session();
    applyRefDeltas(s, undefined, undefined);
    expect(Number.isNaN(s.channels.get('d_speed')!.data[150])).toBe(true);
  });
});

describe('chart templates', () => {
  it('every template has unique panel ids and the stock ones use zero fill', () => {
    for (const t of CHART_TEMPLATES) {
      const ids = new Set(t.panels.map((p) => p.id));
      expect(ids.size).toBe(t.panels.length);
    }
    const vs = CHART_TEMPLATES.find((t) => t.id === 'vs-ref')!;
    expect(vs.panels.every((p) => p.channels.every((c) => c.fill === 'zero'))).toBe(true);
    const a = templatePanels(vs);
    expect(a[0].id).not.toBe(vs.panels[0].id);
  });
  it('fill and title survive the workspace schema', () => {
    const w = parseWorkspace(serializeWorkspace({ ...DEFAULT_WORKSPACE, panels: [{ id: 'x', title: 'T', channels: [{ name: 'd_speed', axis: 'L', fill: 'zero' }] }] }));
    expect(w.panels[0].title).toBe('T');
    expect(w.panels[0].channels[0].fill).toBe('zero');
  });
});

describe('store: click position and marker notes', () => {
  beforeEach(() => {
    useLab.setState({ sessions: [], selectedLaps: [], markers: [], activeMarkerId: null, cursor: null, clickPos: null, refLap: undefined, lapMeta: {} });
    useLab.getState().addSession(session());
  });
  it('📍 prefers the last click, M prefers the hover cursor', () => {
    const st = useLab.getState();
    st.setCursor({ sessionId: 's', idx: 20 });
    st.setClickPos({ sessionId: 's', idx: 70 });
    expect(useLab.getState().addMarkerAtCursor('click')!.idx).toBe(70);
    expect(useLab.getState().addMarkerAtCursor('hover')!.idx).toBe(20);
    useLab.getState().setCursor(null);
    expect(useLab.getState().addMarkerAtCursor('hover')!.idx).toBe(70); // falls back to the click
  });
  it('notes are stored and moving a marker keeps them', () => {
    const m = useLab.getState().addMarker('s', 10, { note: 'late brake' });
    useLab.getState().updateMarker(m.id, { idx: 15 });
    expect(useLab.getState().markers[0]).toMatchObject({ idx: 15, note: 'late brake' });
  });
});
