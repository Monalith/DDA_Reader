import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PROC, DEFAULT_WORKSPACE, type Channel, type Lap, type Session } from '../../src/core/types';
import { loadUserPresets, saveUserPresets, upsertUserPreset, type UserMathPreset } from '../../src/core/presets';
import { parseWorkspace, serializeWorkspace } from '../../src/core/workspace';
import { recomputeMath, useLab } from '../../src/state/store';

function session(id: string, v: number): Session {
  const n = 100;
  const t = Float64Array.from({ length: n }, (_, i) => i / 10);
  const ch = (name: string, data: Float32Array): Channel => ({ name, unit: '', kind: 'raw', data, proc: { ...DEFAULT_PROC } });
  const laps: Lap[] = [{ n: 1, startIdx: 0, endIdx: 49, timeS: 5, sectorsS: [], isBest: true, kind: 'flying' }, { n: 2, startIdx: 50, endIdx: 99, timeS: 5, sectorsS: [], isBest: false, kind: 'flying' }];
  return { id, name: id, source: 'csv', color: '#fff', t, channels: new Map([['speed', ch('speed', new Float32Array(n).fill(v))]]), laps, meta: { track: '', rider: '', note: '' } };
}

describe('math formula per run (session)', () => {
  it('perSession replaces the default formula for that run only; perLap still wins inside its lap', () => {
    const a = session('a', 10);
    const b = session('b', 10);
    const defs = [{ name: 'k', unit: '', expr: 'speed', color: '#fff', perSession: { b: 'speed + 5' }, perLap: { 'b:2': 'speed * 0' } }];
    recomputeMath(a, defs);
    recomputeMath(b, defs);
    expect(a.channels.get('k')!.data[10]).toBe(10);
    expect(b.channels.get('k')!.data[10]).toBe(15);
    expect(b.channels.get('k')!.data[75]).toBe(0);
  });
  it('survives the workspace schema', () => {
    const w = parseWorkspace(serializeWorkspace({ ...DEFAULT_WORKSPACE, mathChannels: [{ name: 'k', unit: '', expr: 'speed', color: '#fff', perSession: { a: 'speed+1' } }] }));
    expect(w.mathChannels[0].perSession).toEqual({ a: 'speed+1' });
  });
});

describe('store: setMathSessionExpr', () => {
  beforeEach(() => {
    useLab.setState({ sessions: [], selectedLaps: [], markers: [], activeMarkerId: null, cursor: null, clickPos: null, refLap: undefined, lapMeta: {}, workspace: { ...DEFAULT_WORKSPACE, mathChannels: [] } });
    useLab.getState().addSession(session('a', 10));
    useLab.getState().addSession(session('b', 10));
  });
  it('sets, keeps through a default update, clears, and is pruned with the session', () => {
    const st = useLab.getState();
    st.addMathChannel({ name: 'k', unit: '', expr: 'speed', color: '#fff' });
    st.setMathSessionExpr('k', 'b', 'speed + 3');
    const val = (id: string) => useLab.getState().sessions.find((s) => s.id === id)!.channels.get('k')!.data[10];
    expect(val('a')).toBe(10);
    expect(val('b')).toBe(13);
    useLab.getState().addMathChannel({ name: 'k', unit: '', expr: 'speed * 2', color: '#fff' });
    expect(val('a')).toBe(20);
    expect(val('b')).toBe(13); // run-specific formula kept
    useLab.getState().setMathSessionExpr('k', 'b', null);
    expect(val('b')).toBe(20);
    useLab.getState().setMathSessionExpr('k', 'b', 'speed - 1');
    useLab.getState().removeSession('b');
    expect(useLab.getState().workspace.mathChannels[0].perSession).toBeUndefined();
  });
});

describe('user math presets', () => {
  it('upsert by name, round-trip through storage, ignore junk', () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    let list: UserMathPreset[] = [];
    list = upsertUserPreset(list, { name: 'my_g', label: 'My G', unit: 'g', color: '#f00', expr: 'accel_g(speed)', doc: '' }, ['speed']);
    list = upsertUserPreset(list, { name: 'my_g', label: 'My G v2', unit: 'g', color: '#f00', expr: 'accel_g(lowpass(speed, 1))', doc: '' }, ['speed']);
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe('My G v2');
    saveUserPresets(list, storage);
    expect(loadUserPresets(storage)[0]).toMatchObject({ id: 'user_my_g', group: 'My presets', expr: 'accel_g(lowpass(speed, 1))' });
    mem.set('dda-lab-math-presets', '{"nope":1}');
    expect(loadUserPresets(storage)).toEqual([]);
  });
});
