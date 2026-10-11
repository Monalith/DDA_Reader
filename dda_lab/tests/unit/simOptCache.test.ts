import { describe, expect, it } from 'vitest';
import { type KVStorage, OPT_STORAGE_PREFIX, optCacheKey, readOpt, writeOpt } from '../../src/sim/optCache';
import { corridorKey } from '../../src/sim/corridorCache';
import { DEFAULT_SIM_PARAMS } from '../../src/sim/presets';
import { circuitTrack } from './circuitFixture';

function memStorage(): KVStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
}

const P = DEFAULT_SIM_PARAMS;

describe('optCacheKey', () => {
  const { track } = circuitTrack();
  it('starts with the corridor key and names the mode', () => {
    const k = optCacheKey(track, P, 'freeTrajectory');
    expect(k.startsWith(corridorKey(track))).toBe(true);
    expect(k).not.toBe(optCacheKey(track, P, 'ocp'));
  });
  it('ignores the rider: two different aggressiveness/risk settings give the same key', () => {
    const a = { ...P, rider: { ...P.rider, aggressiveness: 0.1, risk: 0.2, sLat: 0.3 } };
    const b = { ...P, rider: { ...P.rider, aggressiveness: 0.9, risk: 0.95, sLat: 1 } };
    expect(optCacheKey(track, a, 'freeTrajectory')).toBe(optCacheKey(track, b, 'freeTrajectory'));
  });
  it('changes with the machine and the tyre', () => {
    const base = optCacheKey(track, P, 'freeTrajectory');
    expect(optCacheKey(track, { ...P, machine: { ...P.machine, powerKw: P.machine.powerKw + 1 } }, 'freeTrajectory')).not.toBe(base);
    expect(optCacheKey(track, { ...P, tyre: { ...P.tyre, mu: P.tyre.mu + 0.05 } }, 'freeTrajectory')).not.toBe(base);
  });
  it('does not depend on object key order', () => {
    const reordered = { ...P, machine: Object.fromEntries(Object.entries(P.machine).reverse()) as typeof P.machine };
    expect(optCacheKey(track, reordered, 'freeTrajectory')).toBe(optCacheKey(track, P, 'freeTrajectory'));
  });
});

describe('readOpt / writeOpt', () => {
  it('round-trips exactly through an injected storage', () => {
    const st = memStorage();
    const offs = Float32Array.from([0.1, -2.345678, 3.3333333, 0, 1e-7]);
    writeOpt('rt-1', offs, 61.234, st);
    expect(st.map.has(OPT_STORAGE_PREFIX + 'rt-1')).toBe(true);
    // a fresh storage view of the same data (bypass memory by a second key copy)
    const st2 = memStorage();
    st2.map.set(OPT_STORAGE_PREFIX + 'rt-copy', st.map.get(OPT_STORAGE_PREFIX + 'rt-1')!);
    const back = readOpt('rt-copy', 5, st2);
    expect(back).not.toBeNull();
    expect(Array.from(back!)).toEqual(Array.from(offs));
  });
  it('serves from memory without storage', () => {
    const offs = Float32Array.from([1, 2, 3]);
    writeOpt('mem-1', offs, 50);
    const back = readOpt('mem-1', 3);
    expect(Array.from(back!)).toEqual([1, 2, 3]);
    // a copy, so the caller cannot corrupt the cache
    back![0] = 99;
    expect(readOpt('mem-1', 3)![0]).toBe(1);
  });
  it('returns null on a length mismatch', () => {
    const st = memStorage();
    writeOpt('len-1', Float32Array.from([1, 2, 3]), 50, st);
    expect(readOpt('len-1', 4, st)).toBeNull();
  });
  it('returns null on malformed JSON or a wrong shape', () => {
    const st = memStorage();
    st.map.set(OPT_STORAGE_PREFIX + 'bad-1', '{not json');
    expect(readOpt('bad-1', 3, st)).toBeNull();
    st.map.set(OPT_STORAGE_PREFIX + 'bad-2', JSON.stringify({ v: 1, lapTimeS: 50, offsetsM: [1, 'x', 3] }));
    expect(readOpt('bad-2', 3, st)).toBeNull();
    st.map.set(OPT_STORAGE_PREFIX + 'bad-3', JSON.stringify([1, 2, 3]));
    expect(readOpt('bad-3', 3, st)).toBeNull();
    expect(readOpt('missing', 3, st)).toBeNull();
  });
  it('survives a storage that throws', () => {
    const throwing: KVStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(() => writeOpt('thr-1', Float32Array.from([1]), 1, throwing)).not.toThrow();
    expect(readOpt('thr-2', 1, throwing)).toBeNull();
  });
});
