import { describe, expect, it } from 'vitest';
import { DEFAULT_PROC, DEFAULT_WORKSPACE, type Channel, type Lap, type Session, type Workspace } from '../../src/core/types';
import {
  allChannelNames,
  cursorIdxFromX,
  lapX,
  overlaySeries,
  selectedLapEntries,
  xFromIdx,
} from '../../src/state/selectors';

const N = 20; // two laps of 10 samples at 10 Hz
const HZ = 10;

function ch(name: string, unit: string, values: number[]): Channel {
  return { name, unit, kind: 'raw', data: new Float32Array(values), proc: { ...DEFAULT_PROC } };
}

/** Synthetic session: 2 laps × 10 samples, lap_dist 0..90 m per lap. */
function makeSession(id = 's1', color = '#ff6a00'): Session {
  const t = new Float64Array(N);
  for (let i = 0; i < N; i++) t[i] = i / HZ;
  const speed: number[] = [];
  const lapDist: number[] = [];
  for (let i = 0; i < N; i++) {
    const k = i % 10;
    speed.push(100 + k);
    lapDist.push(k * 10);
  }
  const laps: Lap[] = [
    { n: 1, startIdx: 0, endIdx: 9, timeS: 1.0, sectorsS: [0.3, 0.3, 0.4], isBest: true, kind: 'flying' },
    { n: 2, startIdx: 10, endIdx: 19, timeS: 1.2, sectorsS: [0.4, 0.4, 0.4], isBest: false, kind: 'flying' },
  ];
  const channels = new Map<string, Channel>([
    ['speed', ch('speed', 'km/h', speed)],
    ['rpm', ch('rpm', 'rpm', speed.map((v) => v * 100))],
    ['lap_dist', ch('lap_dist', 'm', lapDist)],
  ]);
  return { id, name: id.toUpperCase(), source: 'dda', color, t, channels, laps, meta: { track: '', rider: '', note: '' } };
}

const WS: Workspace = { ...DEFAULT_WORKSPACE, xAxis: 'distance' };
const panel = (names: Array<[string, 'L' | 'R']>) => ({
  id: 'p1',
  channels: names.map(([name, axis]) => ({ name, axis })),
});

describe('lapX', () => {
  it('uses lap_dist in distance mode and lap-relative time in time mode', () => {
    const s = makeSession();
    const d = lapX(s, s.laps[1], 'distance');
    expect(Array.from(d)).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
    const tx = lapX(s, s.laps[1], 'time');
    expect(tx[0]).toBeCloseTo(0, 10);
    expect(tx[9]).toBeCloseTo(0.9, 10);
  });

  it('falls back to time when lap_dist is missing', () => {
    const s = makeSession();
    s.channels.delete('lap_dist');
    const d = lapX(s, s.laps[0], 'distance');
    expect(d[5]).toBeCloseTo(0.5, 10);
  });
});

describe('overlaySeries', () => {
  it('returns one line per selected lap per channel with sliced data', () => {
    const s = makeSession();
    const state = {
      sessions: [s],
      selectedLaps: [
        { sessionId: 's1', lap: 1 },
        { sessionId: 's1', lap: 2 },
      ],
      workspace: WS,
    };
    expect(selectedLapEntries(state)).toHaveLength(2);

    const lines = overlaySeries(state, panel([['speed', 'L']]));
    expect(lines.map((l) => l.key)).toEqual(['s1:1:speed', 's1:2:speed']);
    expect(lines.every((l) => l.x.length === 10 && l.y.length === 10)).toBe(true);
    expect(Array.from(lines[0].x)).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
    expect(lines[0].y[0]).toBeCloseTo(100, 5);
    expect(lines[1].startIdx).toBe(10);
    expect(lines[0].axis).toBe('L');
    // laps of one session get distinct shades
    expect(lines[0].color).not.toEqual(lines[1].color);
  });

  it('keeps per-channel axis assignment and skips unknown channels', () => {
    const s = makeSession();
    const state = { sessions: [s], selectedLaps: [{ sessionId: 's1', lap: 1 }], workspace: WS };
    const lines = overlaySeries(state, panel([['speed', 'L'], ['rpm', 'R'], ['nope', 'L']]));
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.axis)).toEqual(['L', 'R']);
    expect(lines[1].channel).toBe('rpm');
  });

  it('returns nothing when no laps are selected or the panel is empty', () => {
    const s = makeSession();
    expect(overlaySeries({ sessions: [s], selectedLaps: [], workspace: WS }, panel([['speed', 'L']]))).toHaveLength(0);
    expect(
      overlaySeries({ sessions: [s], selectedLaps: [{ sessionId: 's1', lap: 1 }], workspace: WS }, panel([])),
    ).toHaveLength(0);
  });

  it('labels lines with the session name when more than one session is selected', () => {
    const a = makeSession('s1');
    const b = makeSession('s2', '#3da5ff');
    const lines = overlaySeries(
      {
        sessions: [a, b],
        selectedLaps: [
          { sessionId: 's1', lap: 1 },
          { sessionId: 's2', lap: 2 },
        ],
        workspace: WS,
      },
      panel([['speed', 'L']]),
    );
    expect(lines).toHaveLength(2);
    expect(lines[0].label).toBe('S1 L1 speed');
    expect(lines[1].label).toBe('S2 L2 speed');
  });
});

describe('cursorIdxFromX / xFromIdx', () => {
  it('maps a distance back to the session sample index of that lap', () => {
    const s = makeSession();
    expect(cursorIdxFromX(s, s.laps[0], 30, 'distance')).toBe(3);
    expect(cursorIdxFromX(s, s.laps[1], 30, 'distance')).toBe(13);
    // between samples → first sample at or after x
    expect(cursorIdxFromX(s, s.laps[1], 35, 'distance')).toBe(14);
    // clamped at the lap bounds
    expect(cursorIdxFromX(s, s.laps[0], -100, 'distance')).toBe(0);
    expect(cursorIdxFromX(s, s.laps[0], 1e6, 'distance')).toBe(9);
  });

  it('maps lap time back to an index in time mode', () => {
    const s = makeSession();
    expect(cursorIdxFromX(s, s.laps[1], 0.5, 'time')).toBe(15);
    expect(cursorIdxFromX(s, s.laps[1], 0.45, 'time')).toBe(15);
    expect(cursorIdxFromX(s, s.laps[1], 0.0, 'time')).toBe(10);
  });

  it('round-trips an index through xFromIdx', () => {
    const s = makeSession();
    const at = xFromIdx(s, 13, 'distance');
    expect(at?.lap.n).toBe(2);
    expect(at?.x).toBe(30);
    expect(cursorIdxFromX(s, at!.lap, at!.x, 'distance')).toBe(13);

    const atT = xFromIdx(s, 4, 'time');
    expect(atT?.lap.n).toBe(1);
    expect(atT?.x).toBeCloseTo(0.4, 10);
  });

  it('returns null for an index outside every lap', () => {
    const s = makeSession();
    s.laps = [s.laps[0]];
    expect(xFromIdx(s, 15, 'distance')).toBeNull();
  });
});

describe('allChannelNames', () => {
  it('unions and sorts channel names across sessions', () => {
    const a = makeSession('s1');
    const b = makeSession('s2');
    b.channels.set('lean', ch('lean', 'deg', [0]));
    expect(allChannelNames([a, b])).toEqual(['lap_dist', 'lean', 'rpm', 'speed']);
  });
});
