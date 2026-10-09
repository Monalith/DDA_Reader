import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PROC, DEFAULT_WORKSPACE, type Channel, type Lap, type Session } from '../../src/core/types';
import { alignedChannel, applyRefDeltas } from '../../src/state/derivedExtras';
import { evaluate, localDependencies, parseExpr, dependencies } from '../../src/core/mathExpr';
import { panelXAxis } from '../../src/state/selectors';
import { parseWorkspace, serializeWorkspace } from '../../src/core/workspace';
import { CHART_TEMPLATES } from '../../src/core/chartTemplates';
import { useLab } from '../../src/state/store';

function ch(name: string, data: Float32Array, unit = '', kind: Channel['kind'] = 'raw'): Channel {
  return { name, unit, kind, data, proc: { ...DEFAULT_PROC } };
}
/** One lap of 100 samples. speed constant `v`; lap_dist grows v/36 m per sample; lap_time 0.1 s steps. */
function run(id: string, v: number): Session {
  const n = 100;
  const t = Float64Array.from({ length: n }, (_, i) => i / 10);
  const ms = v / 3.6;
  const laps: Lap[] = [{ n: 1, startIdx: 0, endIdx: n - 1, timeS: 9.9, sectorsS: [], isBest: true, kind: 'flying' }];
  return {
    id, name: id, source: 'csv', color: '#fff', t,
    channels: new Map([
      ['speed', ch('speed', new Float32Array(n).fill(v), 'km/h')],
      ['lap_dist', ch('lap_dist', Float32Array.from({ length: n }, (_, i) => i * ms * 0.1), 'm', 'derived')],
      ['lap_time', ch('lap_time', Float32Array.from({ length: n }, (_, i) => i * 0.1), 's', 'derived')],
    ]),
    laps, meta: { track: '', rider: '', note: '' },
  };
}

describe('alignedChannel + delta_d', () => {
  it('aligns by distance and by lap time', () => {
    const a = run('a', 72); // 20 m/s
    const b = run('b', 36); // 10 m/s
    const byDist = alignedChannel(a, b, b.laps[0], 'speed', 'lap_dist');
    expect(byDist[10]).toBeCloseTo(36, 3); // a at 20 m → b's speed there
    expect(Number.isNaN(byDist[99])).toBe(true); // a reaches 198 m, b's lap only goes to 99 m
    applyRefDeltas(a, b, b.laps[0]);
    const dd = a.channels.get('delta_d')!.data;
    expect(dd[50]).toBeCloseTo(50, 2); // after 5 s a is 100 m, b 50 m → +50 m ahead
    expect(a.channels.get('d_speed')!.data[10]).toBeCloseTo(36, 3);
  });
});

describe('ref()/run() in formulas', () => {
  beforeEach(() => {
    useLab.setState({ sessions: [], selectedLaps: [], lapMeta: {}, markers: [], activeMarkerId: null, cursor: null, refLap: undefined, workspace: { ...DEFAULT_WORKSPACE, mathChannels: [] } });
    useLab.getState().addSession(run('a', 72));
    useLab.getState().addSession(run('b', 36));
  });
  it('dependencies vs local dependencies', () => {
    const ast = parseExpr('speed - run(rpm, 2)');
    expect(dependencies(ast)).toEqual(['speed', 'rpm']);
    expect(localDependencies(ast)).toEqual(['speed']);
    expect(localDependencies(parseExpr('ref(speed)'))).toEqual([]);
  });
  it('subtracts and divides another run', () => {
    useLab.getState().addMathChannel({ name: 'gap', unit: 'km/h', expr: 'speed - run(speed, 2)', color: '#fff' });
    useLab.getState().addMathChannel({ name: 'ratio', unit: '', expr: 'speed / ref(speed)', color: '#fff' });
    const [a, b] = useLab.getState().sessions;
    expect(a.channels.get('gap')!.data[10]).toBeCloseTo(36, 3);
    expect(b.channels.get('gap')!.data[10]).toBeCloseTo(0, 3);
    // reference = a's lap (first loaded best lap): ratio in b = 36/72 at the same distance
    expect(useLab.getState().refLap).toMatchObject({ sessionId: 'a', lap: 1 });
    expect(b.channels.get('ratio')!.data[10]).toBeCloseTo(0.5, 3);
    expect(a.channels.get('ratio')!.data[10]).toBeCloseTo(1, 3);
  });
  it('a formula made only of ref() terms works; errors are reported per run', () => {
    useLab.getState().addMathChannel({ name: 'r', unit: '', expr: 'ref(speed) * 2', color: '#fff' });
    expect(useLab.getState().sessions[1].channels.get('r')!.data[10]).toBeCloseTo(144, 3);
    useLab.getState().addMathChannel({ name: 'bad', unit: '', expr: 'run(speed, 9)', color: '#fff' });
    expect(useLab.getState().sessions[0].channels.get('bad')!.expr).toContain('no run 9');
  });
  it('evaluate() without a context rejects ref()', () => {
    expect(() => evaluate(parseExpr('ref(speed)'), { get: () => new Float32Array(3), dtS: 0.1, n: 3 })).toThrow(/only available/);
  });
});

describe('per-panel x axis', () => {
  it('falls back to the workspace axis and survives the schema', () => {
    expect(panelXAxis({ xAxis: undefined }, { xAxis: 'distance' })).toBe('distance');
    expect(panelXAxis({ xAxis: 'time' }, { xAxis: 'distance' })).toBe('time');
    const w = parseWorkspace(serializeWorkspace({ ...DEFAULT_WORKSPACE, panels: [{ id: 'p', channels: [], xAxis: 'time' }] }));
    expect(w.panels[0].xAxis).toBe('time');
  });
  it('delta templates exist and set their own axes', () => {
    const dd = CHART_TEMPLATES.find((t) => t.id === 'delta-distance-time')!;
    expect(dd.panels[0].channels[0].name).toBe('delta_d');
    expect(dd.panels.every((p) => p.xAxis === 'time')).toBe(true);
    const dt = CHART_TEMPLATES.find((t) => t.id === 'delta-time-distance')!;
    expect(dt.panels[0].xAxis).toBe('distance');
  });
});
