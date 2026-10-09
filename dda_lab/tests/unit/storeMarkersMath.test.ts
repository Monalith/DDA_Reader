import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PROC, DEFAULT_WORKSPACE, type Channel, type Lap, type Session } from '../../src/core/types';
import { applyTotalDist } from '../../src/state/derivedExtras';
import { lapKey, recomputeMath, useLab } from '../../src/state/store';
import { markerIdxInLap, markerX } from '../../src/state/selectors';
import { parseWorkspace, serializeWorkspace } from '../../src/core/workspace';

function ch(name: string, data: Float32Array, unit = ''): Channel {
  return { name, unit, kind: 'raw', data, proc: { ...DEFAULT_PROC } };
}

/** 3 laps × 100 samples at 10 Hz, constant 36 km/h (10 m/s) → each lap is 99 m of lap_dist. */
function session(id = 's1'): Session {
  const n = 300;
  const t = Float64Array.from({ length: n }, (_, i) => i / 10);
  const speed = new Float32Array(n).fill(36);
  const lapDist = new Float32Array(n);
  for (let i = 0; i < n; i++) lapDist[i] = i % 100;
  const laps: Lap[] = [0, 1, 2].map((k) => ({
    n: k + 1, startIdx: k * 100, endIdx: k * 100 + 99, timeS: 10, sectorsS: [], isBest: k === 1, kind: 'flying',
  }));
  const channels = new Map<string, Channel>([
    ['speed', ch('speed', speed, 'km/h')],
    ['lap_dist', { ...ch('lap_dist', lapDist, 'm'), kind: 'derived' }],
  ]);
  return { id, name: id, source: 'csv', color: '#fff', t, channels, laps, meta: { track: '', rider: '', note: '' } };
}

describe('total_dist follows the laps that still exist', () => {
  it('is continuous across laps', () => {
    const s = session();
    applyTotalDist(s);
    const d = s.channels.get('total_dist')!.data;
    expect(d[0]).toBe(0);
    expect(d[99]).toBe(99);
    expect(d[100]).toBe(99); // second lap starts where the first ended
    expect(d[250]).toBe(99 * 2 + 50);
  });
  it('drops the metres of a deleted lap', () => {
    const s = session();
    s.laps = s.laps.filter((l) => l.n !== 1);
    applyTotalDist(s);
    const d = s.channels.get('total_dist')!.data;
    expect(Number.isNaN(d[50])).toBe(true); // deleted lap: no data
    expect(d[100]).toBe(0); // lap 2 is now the first lap
    expect(d[250]).toBe(99 + 50);
  });
});

describe('per-lap math formulas', () => {
  it('override replaces the values inside one lap only', () => {
    const s = session();
    recomputeMath(s, [{ name: 'k', unit: '', expr: 'speed * 1', color: '#0f0', perLap: { [lapKey('s1', 2)]: 'speed * 2' } }]);
    const k = s.channels.get('k')!.data;
    expect(k[50]).toBe(36);
    expect(k[150]).toBe(72);
    expect(k[250]).toBe(36);
  });
  it('an override for another session is ignored, a broken one yields NaN in that lap', () => {
    const s = session();
    recomputeMath(s, [{ name: 'k', unit: '', expr: 'speed', color: '#0f0', perLap: { [lapKey('other', 2)]: 'speed * 9', [lapKey('s1', 3)]: 'nope(' } }]);
    const k = s.channels.get('k')!;
    expect(k.data[150]).toBe(36);
    expect(Number.isNaN(k.data[250])).toBe(true);
    expect(k.expr).toContain('L3');
  });
  it('round-trips through the workspace JSON', () => {
    const w = parseWorkspace(
      serializeWorkspace({ ...DEFAULT_WORKSPACE, mathChannels: [{ name: 'k', unit: '', expr: 'speed', color: '#fff', perLap: { 'a:1': 'speed*2' } }] }),
    );
    expect(w.mathChannels[0].perLap).toEqual({ 'a:1': 'speed*2' });
  });
});

describe('store: per-lap formulas and markers', () => {
  beforeEach(() => {
    useLab.setState({
      sessions: [], tracks: [], activeTrackId: undefined, selectedLaps: [], lapMeta: {}, refLap: undefined, cursor: null,
      markers: [], activeMarkerId: null, workspace: { ...DEFAULT_WORKSPACE, mathChannels: [] },
    });
    useLab.getState().addSession(session());
  });

  it('setMathLapExpr adds, recomputes and clears an override', () => {
    const st = useLab.getState();
    st.addMathChannel({ name: 'k', unit: '', expr: 'speed', color: '#fff' });
    st.setMathLapExpr('k', 's1', 2, 'speed * 3');
    let s = useLab.getState().sessions[0];
    expect(s.channels.get('k')!.data[150]).toBe(108);
    expect(useLab.getState().workspace.mathChannels[0].perLap).toEqual({ 's1:2': 'speed * 3' });
    // updating the default formula keeps the override
    useLab.getState().addMathChannel({ name: 'k', unit: '', expr: 'speed + 1', color: '#fff' });
    s = useLab.getState().sessions[0];
    expect(s.channels.get('k')!.data[50]).toBe(37);
    expect(s.channels.get('k')!.data[150]).toBe(108);
    useLab.getState().setMathLapExpr('k', 's1', 2, null);
    expect(useLab.getState().workspace.mathChannels[0].perLap).toBeUndefined();
    expect(useLab.getState().sessions[0].channels.get('k')!.data[150]).toBe(37);
  });

  it('deleting a lap drops its override, its markers and its total distance', () => {
    const st = useLab.getState();
    st.addMathChannel({ name: 'k', unit: '', expr: 'speed', color: '#fff' });
    st.setMathLapExpr('k', 's1', 1, 'speed * 3');
    st.addMarker('s1', 50);
    st.addMarker('s1', 150, { name: 'apex' });
    st.deleteLap('s1', 1);
    const now = useLab.getState();
    expect(now.workspace.mathChannels[0].perLap).toBeUndefined();
    expect(now.markers.map((m) => m.name)).toEqual(['apex']);
    expect(now.activeMarkerId).toBe(now.markers[0].id);
    const td = now.sessions[0].channels.get('total_dist')!.data;
    expect(td[100]).toBe(0);
    expect(td[250]).toBe(99 + 50);
  });

  it('markers: place at cursor, rename, resolve in another lap, remove', () => {
    const st = useLab.getState();
    expect(st.addMarkerAtCursor()).toBeNull();
    st.setCursor({ sessionId: 's1', idx: 125 });
    const m = useLab.getState().addMarkerAtCursor()!;
    expect(m.name).toBe('M1');
    expect(useLab.getState().activeMarkerId).toBe(m.id);
    useLab.getState().updateMarker(m.id, { name: 'brake', color: '#123456' });
    const cur = useLab.getState();
    expect(cur.markers[0]).toMatchObject({ name: 'brake', color: '#123456', idx: 125 });
    const s = cur.sessions[0];
    expect(markerX([s], cur.markers[0], 'distance')).toBe(25);
    expect(markerIdxInLap([s], cur.markers[0], s, s.laps[0], 'distance')).toBe(25);
    expect(markerIdxInLap([s], cur.markers[0], s, s.laps[1], 'distance')).toBe(125);
    expect(markerX([s], cur.markers[0], 'time')).toBeCloseTo(2.5, 6);
    cur.removeMarker(m.id);
    expect(useLab.getState().markers).toHaveLength(0);
    expect(useLab.getState().activeMarkerId).toBeNull();
  });

  it('removing a session removes its markers', () => {
    useLab.getState().addMarker('s1', 10);
    useLab.getState().removeSession('s1');
    expect(useLab.getState().markers).toHaveLength(0);
  });
});

describe('store: run colour', () => {
  it('setSessionColor recolours the run and its default-coloured laps, keeps custom lap colours', () => {
    useLab.setState({ sessions: [], selectedLaps: [], lapMeta: {}, markers: [], activeMarkerId: null, cursor: null, refLap: undefined });
    const s = session();
    s.color = '#ff0000';
    useLab.getState().addSession(s);
    useLab.getState().setLapMeta('s1', 1, { name: 'A' }); // default colour = run colour
    useLab.getState().setLapMeta('s1', 2, { color: '#123456' }); // custom
    useLab.getState().setSessionColor('s1', '#00ff00');
    const st = useLab.getState();
    expect(st.sessions[0].color).toBe('#00ff00');
    expect(st.lapMeta['s1:1'].color).toBe('#00ff00');
    expect(st.lapMeta['s1:2'].color).toBe('#123456');
  });
});
