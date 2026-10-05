import { describe, expect, it } from 'vitest';
import { lapToBundleLap, lapToCsv, makeBundle, parseBundle } from '../../src/core/bundle';
import { DEFAULT_PROC, DEFAULT_WORKSPACE, type Channel, type Session } from '../../src/core/types';

function session(): Session {
  const t = Float64Array.from({ length: 50 }, (_, i) => i / 10);
  const ch = (name: string, f: (i: number) => number) => ({
    name, unit: 'u', kind: 'raw' as const, data: Float32Array.from({ length: 50 }, (_, i) => f(i)), proc: { ...DEFAULT_PROC },
  });
  const channels = new Map<string, Channel>([
    ['speed', ch('speed', (i) => i * 2)],
    ['rpm', ch('rpm', (i) => 5000 + i)],
    ['math1', { ...ch('math1', () => 1), kind: 'math' as const }],
  ]);
  return {
    id: 's1', name: 'Run010', source: 'dda', color: '#ff6a00', t, channels,
    laps: [{ n: 3, startIdx: 10, endIdx: 29, timeS: 1.9, sectorsS: [0.5, 0.7, 0.7], isBest: true, kind: 'flying' }],
    meta: { track: 'Serres', rider: 'me', note: '' },
  };
}

describe('lab bundle', () => {
  it('round-trips a lap with name and colour, dropping math channels', () => {
    const s = session();
    const bl = lapToBundleLap(s, s.laps[0], 'Best Serres', '#00ff00');
    const json = makeBundle([bl], undefined, DEFAULT_WORKSPACE);
    const parsed = parseBundle(json, () => 'x1');
    expect(parsed.sessions).toHaveLength(1);
    const { session: rs, name, color } = parsed.sessions[0];
    expect(name).toBe('Best Serres');
    expect(color).toBe('#00ff00');
    expect(rs.t.length).toBe(20);
    expect(rs.t[0]).toBe(0);
    expect(rs.channels.has('math1')).toBe(false);
    expect(rs.channels.get('speed')!.data[0]).toBeCloseTo(20);
    expect(rs.laps[0]).toMatchObject({ n: 3, startIdx: 0, endIdx: 19, timeS: 1.9, kind: 'flying' });
    expect(parsed.workspace.panels.length).toBe(6);
  });

  it('rejects an unknown bundle version', () => {
    expect(() => parseBundle(JSON.stringify({ version: 99, createdAt: '', workspace: {}, track: null, laps: [] }))).toThrow();
  });

  it('writes a lap CSV with a Time_s column and one row per sample', () => {
    const s = session();
    const csv = lapToCsv(s, s.laps[0]);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('Time_s,speed,rpm,math1'); // the CSV mirrors the screen: math channels included
    expect(lines).toHaveLength(21);
    expect(lines[1].startsWith('0,20,5010')).toBe(true);
  });
});
