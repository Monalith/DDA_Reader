import { describe, expect, it } from 'vitest';
import {
  cacheSlot,
  cacheSlots,
  estimateFps,
  fmtTimecode,
  frameIndexAt,
  frameSeekTime,
  idxForVideoTime,
  lapAtIdx,
  lapsVideoRange,
  lapVideoRange,
  loadStoredSyncs,
  Lru,
  nearestCachedSlot,
  nearestIdx,
  offsetFromPair,
  roundOffset,
  stepFrames,
  storeSync,
  videoTimeOfIdx,
  xRangeToIdxRange,
} from '../../src/video/sync';
import { parseLabSession, serializeLabSession, type LabSessionState } from '../../src/core/labSession';
import { DEFAULT_PROC, DEFAULT_WORKSPACE } from '../../src/core/types';
import { DEFAULT_SIM_PARAMS } from '../../src/sim/presets';

function labState(): LabSessionState {
  const n = 20;
  return {
    sessions: [
      {
        id: 'a',
        name: 'run-a',
        source: 'dda',
        color: '#f00',
        t: Float64Array.from({ length: n }, (_, i) => i / 10),
        channels: new Map([['speed', { name: 'speed', unit: 'km/h', kind: 'raw', data: new Float32Array(n).fill(100), proc: { ...DEFAULT_PROC } }]]),
        laps: [{ n: 1, startIdx: 0, endIdx: n - 1, timeS: 1.9, sectorsS: [], isBest: true, kind: 'flying' }],
        meta: { track: 'Serres', rider: 'me', note: '' },
      },
    ],
    tracks: [],
    selectedLaps: [{ sessionId: 'a', lap: 1 }],
    lapMeta: {},
    xRange: null,
    workspace: { ...DEFAULT_WORKSPACE },
    mapColorBy: 'speed',
    markers: [],
    activeMarkerId: null,
    clickPos: null,
    simParams: DEFAULT_SIM_PARAMS,
    simEnabled: false,
    solverMode: 'rider',
    riderFit: { refLap: null, fittedRider: null },
  };
}

const t = Float64Array.from({ length: 101 }, (_, i) => 10 + i / 10); // 10.0 .. 20.0 s at 10 Hz

describe('video sync math', () => {
  it('maps samples to video time and back through the offset', () => {
    const off = 7.25; // video 0 = session 7.25 s
    expect(videoTimeOfIdx(t, 0, off)).toBeCloseTo(2.75, 9);
    expect(videoTimeOfIdx(t, 50, off)).toBeCloseTo(7.75, 9);
    for (const i of [0, 1, 37, 99, 100]) expect(idxForVideoTime(t, videoTimeOfIdx(t, i, off), off)).toBe(i);
    // nearest sample in between
    expect(idxForVideoTime(t, 7.75 + 0.04, off)).toBe(50);
    expect(idxForVideoTime(t, 7.75 + 0.06, off)).toBe(51);
    // outside the run
    expect(idxForVideoTime(t, 0, off)).toBeNull();
    expect(idxForVideoTime(t, 2.75 - 0.04, off)).toBe(0);
    expect(idxForVideoTime(t, 12.75 + 0.2, off)).toBeNull();
    expect(idxForVideoTime(new Float64Array(0), 1, 0)).toBeNull();
  });

  it('clamps indexes and finds the nearest sample', () => {
    expect(videoTimeOfIdx(t, -5, 0)).toBe(10);
    expect(videoTimeOfIdx(t, 1e6, 0)).toBe(20);
    expect(nearestIdx(t, 0)).toBe(0);
    expect(nearestIdx(t, 99)).toBe(100);
    expect(nearestIdx(t, 15.049)).toBe(50);
    expect(nearestIdx(t, 15.051)).toBe(51);
    expect(nearestIdx([], 1)).toBe(-1);
  });

  it('derives the offset from a frame/sample pair ("Sync here")', () => {
    const off = offsetFromPair(t[42], 3.5);
    expect(off).toBeCloseTo(14.2 - 3.5, 9);
    expect(videoTimeOfIdx(t, 42, off)).toBeCloseTo(3.5, 9);
    expect(roundOffset(10.700000000000001)).toBe(10.7);
    expect(roundOffset(-0.033333333)).toBe(-0.0333);
  });

  it('frame index / seek / step math', () => {
    expect(frameIndexAt(0, 30)).toBe(0);
    expect(frameIndexAt(1 / 30, 30)).toBe(1);
    expect(frameIndexAt(1 / 30 - 1e-3, 30)).toBe(0);
    expect(frameIndexAt(frameSeekTime(57, 30), 30)).toBe(57);
    expect(frameSeekTime(-3, 25)).toBeCloseTo(0.02, 9);
    // one step lands on the next frame's centre
    expect(frameIndexAt(stepFrames(1.0, 30, 1), 30)).toBe(31);
    expect(frameIndexAt(stepFrames(1.0, 30, -1), 30)).toBe(29);
    expect(frameIndexAt(stepFrames(0, 30, -1), 30)).toBe(0);
    // never past the last frame
    expect(frameIndexAt(stepFrames(9.99, 30, 5, 10), 30)).toBe(299);
    // 29.97
    expect(frameIndexAt(stepFrames(10, 29.97, 1), 29.97)).toBe(Math.floor(10 * 29.97 + 1e-4) + 1);
  });

  it('estimates fps from presented media times, ignoring dropped frames', () => {
    const at = (fps: number, n: number, drop: number[] = []) =>
      Array.from({ length: n }, (_, i) => i / fps).filter((_, i) => !drop.includes(i));
    expect(estimateFps(at(30, 20))).toBe(30);
    expect(estimateFps(at(25, 20, [3, 4, 9]))).toBe(25);
    expect(estimateFps(at(29.97, 30))).toBe(29.97);
    expect(estimateFps(at(59.94, 30, [5, 11]))).toBe(59.94);
    expect(estimateFps(at(37, 30))).toBe(37);
    expect(estimateFps([0, 0.1])).toBeNull();
  });

  it('builds the cache grid and drops the rate to stay within the frame cap', () => {
    const a = cacheSlots([1, 3], 15, 100, 1000);
    expect(a.fps).toBe(15);
    expect(a.slots[0]).toBe(15);
    expect(a.slots[a.slots.length - 1]).toBe(45);
    expect(a.slots.length).toBe(31);
    // clamped to the video
    const b = cacheSlots([-5, 2], 10, 1.5, 1000);
    expect(b.slots[0]).toBe(0);
    expect(b.slots[b.slots.length - 1]).toBe(15);
    // a long range fits the cap
    const c = cacheSlots([0, 600], 15, 600, 4000);
    expect(c.slots.length).toBeLessThanOrEqual(4000);
    expect(c.fps).toBeLessThan(15);
    expect(c.slots[c.slots.length - 1] / c.fps).toBeCloseTo(600, 0);
    expect(cacheSlots([5, 5], 15, 10, 100).slots).toEqual([]);
    expect(cacheSlot(1.04, 15)).toBe(16);
  });

  it('finds the nearest cached slot', () => {
    const have = new Set([10, 13]);
    const has = (k: number) => have.has(k);
    expect(nearestCachedSlot(10, has)).toBe(10);
    expect(nearestCachedSlot(11, has)).toBe(10);
    expect(nearestCachedSlot(12, has)).toBe(13);
    expect(nearestCachedSlot(16, has)).toBeNull();
    expect(nearestCachedSlot(16, has, 3)).toBe(13);
  });

  it('LRU keeps the most recent and releases evicted values', () => {
    const evicted: number[] = [];
    const l = new Lru<number, string>(3, (_v, k) => evicted.push(k));
    l.set(1, 'a');
    l.set(2, 'b');
    l.set(3, 'c');
    expect(l.get(1)).toBe('a'); // 1 is now the newest
    l.set(4, 'd');
    expect(evicted).toEqual([2]);
    expect(l.has(2)).toBe(false);
    expect(l.size).toBe(3);
    l.set(3, 'c2'); // replaced value is released too
    expect(evicted).toEqual([2, 3]);
    l.clear();
    expect(l.size).toBe(0);
    expect(evicted.sort()).toEqual([1, 2, 3, 3, 4]);
  });

  it('lap and x-range helpers', () => {
    const laps = [
      { n: 1, startIdx: 0, endIdx: 40 },
      { n: 2, startIdx: 40, endIdx: 100 },
    ];
    expect(lapAtIdx(laps, 20)?.n).toBe(1);
    expect(lapAtIdx(laps, 60)?.n).toBe(2);
    expect(lapAtIdx(laps, 200)).toBeUndefined();
    const r = lapVideoRange(t, laps[1], 10);
    expect(r[0]).toBeCloseTo(4, 9);
    expect(r[1]).toBeCloseTo(10, 9);
    const u = lapsVideoRange(t, laps, 10, 0.5)!;
    expect(u[0]).toBeCloseTo(-0.5, 9);
    expect(u[1]).toBeCloseTo(10.5, 9);
    expect(lapsVideoRange(t, [], 0)).toBeNull();
    // lap x array (lap distance), with a NaN at the start
    const xs = [NaN, 0, 10, 20, 30, 40, 50];
    expect(xRangeToIdxRange(xs, 100, [15, 42])).toEqual([103, 105]);
    expect(xRangeToIdxRange(xs, 100, [42, 15])).toEqual([103, 105]);
    expect(xRangeToIdxRange(xs, 100, [60, 70])).toBeNull();
  });

  it('formats timecodes', () => {
    expect(fmtTimecode(0)).toBe('00:00.00');
    expect(fmtTimecode(75.256)).toBe('01:15.26');
    expect(fmtTimecode(3725.5)).toBe('1:02:05.50');
    expect(fmtTimecode(-1.5)).toBe('−00:01.50');
    expect(fmtTimecode(NaN)).toBe('–');
  });

  it('persists the offset per file name', () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    expect(loadStoredSyncs(storage)).toEqual({});
    storeSync(storage, 'serres.mp4', { offsetS: 12.34, sessionName: 'Run036' });
    storeSync(storage, 'other.mov', { offsetS: -1 });
    expect(loadStoredSyncs(storage)['serres.mp4']).toEqual({ offsetS: 12.34, sessionName: 'Run036' });
    expect(Object.keys(loadStoredSyncs(storage))).toHaveLength(2);
    mem.set('dda-lab-video-sync', '{broken');
    expect(loadStoredSyncs(storage)).toEqual({});
    expect(loadStoredSyncs(undefined)).toEqual({});
  });

  it('round-trips the video sync through a lab session file', () => {
    const serialize = serializeLabSession;
    const parse = parseLabSession;
    const state = labState();
    const withVideo = parse(serialize({ ...state, video: { fileName: 'serres.mp4', offsetS: 12.5, sessionId: state.sessions[0].id } }));
    expect(withVideo.video).toEqual({ fileName: 'serres.mp4', offsetS: 12.5, sessionId: state.sessions[0].id });
    // no video → no field; a sync to a run that is not in the file is dropped
    expect(parse(serialize(state)).video).toBeUndefined();
    expect(parse(serialize({ ...state, video: { fileName: 'x.mp4', offsetS: 1, sessionId: 'nope' } })).video).toBeUndefined();
  });
});
