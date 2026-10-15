import { describe, expect, it } from 'vitest';
import { fromPlain, looksLikeLabSession, parseLabSession, serializeLabSession, toPlain, type LabSessionState } from '../../src/core/labSession';
import { DEFAULT_PROC, DEFAULT_WORKSPACE, type Session, type TrackModel } from '../../src/core/types';
import { DEFAULT_SIM_PARAMS } from '../../src/sim/presets';

function session(id: string, n = 50): Session {
  const t = Float64Array.from({ length: n }, (_, i) => i / 10);
  const speed = Float32Array.from({ length: n }, (_, i) => 100 + i * 0.5);
  const lean = Float32Array.from({ length: n }, (_, i) => (i % 7) - 3);
  const derived = Float32Array.from({ length: n }, () => 1);
  return {
    id,
    name: `run-${id}`,
    source: 'dda',
    color: '#ff0000',
    t,
    channels: new Map([
      ['speed', { name: 'speed', unit: 'km/h', kind: 'raw', data: speed, proc: { ...DEFAULT_PROC, scale: 1.05 } }],
      ['lean', { name: 'lean', unit: 'deg', kind: 'raw', data: lean, proc: { ...DEFAULT_PROC }, raw: { t: Float64Array.from([0, 0.02]), v: Float32Array.from([1, 2]) } }],
      ['gps_speed', { name: 'gps_speed', unit: 'km/h', kind: 'derived', data: derived, proc: { ...DEFAULT_PROC } }],
    ]),
    laps: [
      { n: 1, startIdx: 0, endIdx: 24, timeS: 2.4, sectorsS: [1.2, 1.2], isBest: false, kind: 'out' },
      { n: 2, startIdx: 25, endIdx: 49, timeS: 2.4, sectorsS: [1.1, 1.3], isBest: true, kind: 'flying' },
    ],
    meta: { track: 'Serres', rider: 'me', note: '' },
    deletedRanges: [[3, 4]],
  };
}

const track: TrackModel = {
  id: 'trk',
  name: 'Track',
  center: [23.5, 41.1],
  centerline: [[23.5, 41.1], [23.501, 41.1]],
  cumDistM: Float64Array.from([0, 83.2]),
  lengthM: 83.2,
  startFinish: { id: 'sf', name: 'S/F', type: 'sf', at: [23.5, 41.1], bearingDeg: 90, halfWidthM: 10 },
  sectors: [],
  turns: [{ n: 1, name: 'K1', dir: 'L', apexGeo: [23.5005, 41.1], radiusM: 40, sRange: [10, 50] }],
};

function state(): LabSessionState {
  return {
    sessions: [session('a'), session('b'), { ...session('sim'), isSim: true }],
    tracks: [track],
    activeTrackId: 'trk',
    trackPackage: undefined,
    corridor: { stepM: 2, leftM: Float32Array.from([5, 5.5]), rightM: Float32Array.from([6, 6]), known: [true, false] },
    selectedLaps: [{ sessionId: 'a', lap: 2 }, { sessionId: 'sim', lap: 1 }],
    lapMeta: { 'a:2': { name: 'me L2', color: '#00ff00' } },
    refLap: { sessionId: 'a', lap: 2 },
    xRange: [100, 900],
    workspace: { ...DEFAULT_WORKSPACE, xAxis: 'time', mathChannels: [{ name: 'x2', unit: '', expr: 'speed*2', color: '#fff' }] },
    mapColorBy: 'lean',
    markers: [{ id: 'm1', name: 'M1', color: '#abc', sessionId: 'a', idx: 30, note: 'apex' }, { id: 'm2', name: 'M2', color: '#abc', sessionId: 'sim', idx: 3 }],
    activeMarkerId: 'm1',
    clickPos: { sessionId: 'b', idx: 12 },
    simParams: { ...DEFAULT_SIM_PARAMS, rider: { ...DEFAULT_SIM_PARAMS.rider, aggressiveness: 0.3, corners: { 1: { sBrake: 0.2 } } } },
    simEnabled: true,
    solverMode: 'rider',
    riderFit: { refLap: { sessionId: 'a', lapN: 2 }, fittedRider: { ...DEFAULT_SIM_PARAMS.rider, risk: 0.1 } },
  };
}

describe('toPlain / fromPlain', () => {
  it('round-trips typed arrays, maps and NaN', () => {
    const v = { a: Float32Array.from([1, NaN, 3]), b: Float64Array.from([0.5]), m: new Map([['k', [1, 2]]]), n: null, s: 'x' };
    const back = fromPlain(JSON.parse(JSON.stringify(toPlain(v)))) as typeof v;
    expect(back.a).toBeInstanceOf(Float32Array);
    expect(Array.from(back.a).map((x) => (Number.isNaN(x) ? 'nan' : x))).toEqual([1, 'nan', 3]);
    expect(back.b).toBeInstanceOf(Float64Array);
    expect(back.m.get('k')).toEqual([1, 2]);
    expect(back.n).toBeNull();
    expect(back.s).toBe('x');
  });
});

describe('lab session file', () => {
  const json = serializeLabSession(state());
  const back = parseLabSession(json);

  it('is recognised by content', () => {
    expect(looksLikeLabSession(JSON.parse(json))).toBe(true);
    expect(looksLikeLabSession({ version: 1, laps: [] })).toBe(false);
  });

  it('keeps every real run with its raw channels, laps and settings; drops the sim and derived channels', () => {
    expect(back.sessions.map((s) => s.id)).toEqual(['a', 'b']);
    const a = back.sessions[0];
    expect(a.t.length).toBe(50);
    expect(a.t[49]).toBeCloseTo(4.9, 6);
    expect([...a.channels.keys()]).toEqual(['speed', 'lean']);
    expect(a.channels.get('speed')!.data[10]).toBeCloseTo(105, 3);
    expect(a.channels.get('speed')!.proc.scale).toBe(1.05);
    expect(a.channels.get('lean')!.raw!.v[1]).toBe(2);
    expect(a.laps).toHaveLength(2);
    expect(a.laps[1].kind).toBe('flying');
    expect(a.lapsFromFile).toBe(true);
    expect(a.deletedRanges).toEqual([[3, 4]]);
    expect(a.meta.rider).toBe('me');
  });

  it('keeps the track, corridor, workspace laps, markers, chart state and rider', () => {
    expect(back.tracks[0].cumDistM).toBeInstanceOf(Float64Array);
    expect(back.tracks[0].turns[0].name).toBe('K1');
    expect(back.activeTrackId).toBe('trk');
    expect(back.corridor!.leftM[1]).toBeCloseTo(5.5, 2);
    expect(back.corridor!.known).toEqual([true, false]);
    // sim-session references are not saved; real ones are
    expect(back.selectedLaps).toEqual([{ sessionId: 'a', lap: 2 }]);
    expect(back.lapMeta['a:2'].name).toBe('me L2');
    expect(back.refLap).toEqual({ sessionId: 'a', lap: 2 });
    expect(back.xRange).toEqual([100, 900]);
    expect(back.workspace.xAxis).toBe('time');
    expect(back.workspace.mathChannels[0].expr).toBe('speed*2');
    expect(back.mapColorBy).toBe('lean');
    expect(back.markers.map((m) => m.id)).toEqual(['m1']);
    expect(back.markers[0].note).toBe('apex');
    expect(back.clickPos).toEqual({ sessionId: 'b', idx: 12 });
    expect(back.simParams.rider.aggressiveness).toBe(0.3);
    expect(back.simParams.rider.corners).toEqual({ 1: { sBrake: 0.2 } });
    expect(back.simEnabled).toBe(true);
    expect(back.solverMode).toBe('rider');
    expect(back.riderFit.refLap).toEqual({ sessionId: 'a', lapN: 2 });
    expect(back.riderFit.fittedRider!.risk).toBe(0.1);
  });

  it('rejects a foreign file', () => {
    expect(() => parseLabSession(JSON.stringify({ version: 1, laps: [], workspace: {} }))).toThrow();
  });
});
