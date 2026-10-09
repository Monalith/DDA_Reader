import { beforeEach, describe, expect, it } from 'vitest';
import { bestTurnTimes, fmtTurnDelta, turnDeltas, turnTimesForLap } from '../../src/core/turnTimes';
import { loadSavedMarkers, markersToRestore, markersToJson, parseMarkersJson, persistMarkers, toSaved } from '../../src/core/markerStore';
import { lapToBundleLap, makeBundle, parseBundle } from '../../src/core/bundle';
import { DEFAULT_PROC, DEFAULT_WORKSPACE, type Channel, type Lap, type Session, type TrackModel } from '../../src/core/types';
import { useLab } from '../../src/state/store';

/** Two laps on a 100 m "track": lap 1 constant 10 m/s, lap 2 slower (5 m/s) in the second half. */
function session(id = 's'): Session {
  const n = 300;
  const t = Float64Array.from({ length: n }, (_, i) => i / 10);
  const lapDist = new Float32Array(n);
  for (let i = 0; i < 100; i++) lapDist[i] = i; // lap 1: 1 m per sample
  for (let i = 100; i < 300; i++) {
    const j = i - 100;
    lapDist[i] = j < 50 ? j : 50 + (j - 50) * 0.5; // lap 2: slows to 0.5 m/sample after 50 m
  }
  const ch = (name: string, data: Float32Array, unit = '', kind: Channel['kind'] = 'raw'): Channel => ({ name, unit, kind, data, proc: { ...DEFAULT_PROC } });
  const laps: Lap[] = [
    { n: 1, startIdx: 0, endIdx: 99, timeS: 10, sectorsS: [], isBest: true, kind: 'flying' },
    { n: 2, startIdx: 100, endIdx: 299, timeS: 15, sectorsS: [], isBest: false, kind: 'flying' },
  ];
  return { id, name: id, source: 'csv', color: '#fff', t, channels: new Map([['speed', ch('speed', new Float32Array(n).fill(36))], ['lap_dist', ch('lap_dist', lapDist, 'm', 'derived')]]), laps, meta: { track: '', rider: '', note: '' } };
}
const track = {
  turns: [
    { n: 1, name: 'T1', dir: 'L', apexGeo: [0, 0], radiusM: 10, sRange: [10, 30] },
    { n: 2, name: 'T2', dir: 'R', apexGeo: [0, 0], radiusM: 10, sRange: [60, 80] },
  ],
} as unknown as TrackModel;

describe('time in turns vs the best lap', () => {
  it('measures the time between the turn boundaries per lap', () => {
    const s = session();
    expect(turnTimesForLap(s, s.laps[0], track).map((v) => Number(v.toFixed(2)))).toEqual([2, 2]);
    expect(turnTimesForLap(s, s.laps[1], track).map((v) => Number(v.toFixed(2)))).toEqual([2, 4]);
  });
  it('best is the minimum over loaded laps; deltas are + for lost time and "best" at 0', () => {
    const s = session();
    const best = bestTurnTimes([s], track);
    expect(best.best.map((v) => Number(v.toFixed(2)))).toEqual([2, 2]);
    expect(best.who[1]).toEqual({ sessionId: 's', lap: 1 });
    const d2 = turnDeltas(s, s.laps[1], track, best);
    expect(fmtTurnDelta(d2[0])).toBe('best');
    expect(fmtTurnDelta(d2[1])).toBe('+2.00');
    expect(fmtTurnDelta(-0.123)).toBe('−0.12');
  });
});

describe('markers are saved', () => {
  const mem = new Map<string, string>();
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  beforeEach(() => mem.clear());

  it('persist keeps other files, replaces the loaded one, restore skips duplicates', () => {
    const s = session('Run010');
    const other = { sessionName: 'Run016', idx: 5, name: 'X', color: '#fff' };
    mem.set('dda-lab-markers', JSON.stringify([other, { sessionName: 'Run010', idx: 1, name: 'old', color: '#000' }]));
    const saved = persistMarkers([{ id: 'a', name: 'M1', color: '#ff0', sessionId: 'Run010', idx: 42, note: 'hi' }], [s], storage);
    expect(saved).toEqual([other, { sessionName: 'Run010', idx: 42, name: 'M1', color: '#ff0', note: 'hi' }]);
    expect(loadSavedMarkers(storage)).toHaveLength(2);
    const r = markersToRestore(loadSavedMarkers(storage), s, [{ id: 'b', name: 'dup', color: '#fff', sessionId: 'Run010', idx: 42 }]);
    expect(r).toEqual([]); // same sample already there
    expect(markersToRestore(loadSavedMarkers(storage), s, [])).toHaveLength(1);
  });
  it('round-trips through the markers JSON file and the lab bundle', () => {
    const s = session('Run010');
    const m = { id: 'a', name: 'Brake', color: '#ff0', sessionId: 'Run010', idx: 150, note: 'late' };
    const json = markersToJson([m], [s]);
    expect(parseMarkersJson(json)).toEqual(toSaved([m], [s]));
    expect(() => parseMarkersJson('{"x":1}')).toThrow();
    const bl = lapToBundleLap(s, s.laps[1], 'L2', '#f00');
    const text = makeBundle([bl], undefined, DEFAULT_WORKSPACE, [{ lapIndex: 0, idxInLap: 50, name: 'Brake', color: '#ff0', note: 'late' }]);
    const parsed = parseBundle(text);
    expect(parsed.markers).toEqual([{ lapIndex: 0, idxInLap: 50, name: 'Brake', color: '#ff0', note: 'late' }]);
  });
  it('store: markers of a reopened file come back', () => {
    // the store uses the browser's localStorage; give node one
    if (typeof globalThis.localStorage === 'undefined') {
      const m = new Map<string, string>();
      (globalThis as unknown as { localStorage: unknown }).localStorage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
    }
    useLab.setState({ sessions: [], selectedLaps: [], markers: [], activeMarkerId: null, cursor: null, clickPos: null, refLap: undefined, lapMeta: {} });
    globalThis.localStorage.removeItem('dda-lab-markers');
    useLab.getState().addSession(session('Run010'));
    useLab.getState().addMarker('Run010', 33, { name: 'Apex', note: 'n' });
    useLab.getState().removeSession('Run010');
    expect(useLab.getState().markers).toHaveLength(0);
    useLab.getState().addSession(session('Run010'));
    expect(useLab.getState().markers).toMatchObject([{ idx: 33, name: 'Apex', note: 'n' }]);
  });
});
