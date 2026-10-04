import { beforeEach, describe, expect, it } from 'vitest';
import { fromLocalM } from '../../src/core/geo';
import { DEFAULT_PROC, type Channel, type Lap, type Session } from '../../src/core/types';
import {
  TRACKS_STORAGE_KEY,
  buildTrackFromSession,
  loadTracks,
  saveTrack,
  sessionGpsCenter,
} from '../../src/state/trackActions';

// ---------------------------------------------------------------------------
// Synthetic oval (Task 3 geometry): two R = 50 m semicircles joined by 200 m
// straights → 2 · 200 + 2 · π · 50 = 714.16 m, both ends turning left.
// ---------------------------------------------------------------------------
const R = 50;
const STRAIGHT = 200;
const ARC = Math.PI * R;
const PERIM = 2 * STRAIGHT + 2 * ARC;
const ORIGIN: [number, number] = [11.0, 45.0];
const STEP_M = 2; // 10 Hz at 20 m/s = 72 km/h
const SPEED_KMH = 72;

function ovalPoint(sArc: number): [number, number] {
  let s = ((sArc % PERIM) + PERIM) % PERIM;
  if (s < STRAIGHT) return [s, -R]; // bottom straight, +x
  s -= STRAIGHT;
  if (s < ARC) {
    const a = -Math.PI / 2 + s / R; // right semicircle around (STRAIGHT, 0)
    return [STRAIGHT + R * Math.cos(a), R * Math.sin(a)];
  }
  s -= ARC;
  if (s < STRAIGHT) return [STRAIGHT - s, R]; // top straight, −x
  s -= STRAIGHT;
  const a = Math.PI / 2 + s / R; // left semicircle around (0, 0)
  return [R * Math.cos(a), R * Math.sin(a)];
}

function ch(name: string, unit: string, data: Float32Array): Channel {
  return { name, unit, kind: 'raw', data, proc: { ...DEFAULT_PROC } };
}

function makeOvalSession(nLaps = 3): Session {
  const perLap = Math.round(PERIM / STEP_M);
  const n = perLap * nLaps;
  const t = new Float64Array(n);
  const lng = new Float32Array(n);
  const lat = new Float32Array(n);
  const speed = new Float32Array(n).fill(SPEED_KMH);
  for (let i = 0; i < n; i++) {
    t[i] = i / 10;
    const p = fromLocalM(ORIGIN, ovalPoint(i * STEP_M));
    lng[i] = p[0];
    lat[i] = p[1];
  }
  const laps: Lap[] = [];
  for (let k = 0; k < nLaps; k++) {
    laps.push({
      n: k + 1,
      startIdx: k * perLap,
      endIdx: (k + 1) * perLap - 1,
      timeS: perLap / 10,
      sectorsS: [],
      isBest: k === 0,
      kind: 'flying',
    });
  }
  return {
    id: 'oval1',
    name: 'oval',
    source: 'dda',
    color: '#ff6a00',
    t,
    channels: new Map([
      ['gps_lon', ch('gps_lon', 'deg', lng)],
      ['gps_lat', ch('gps_lat', 'deg', lat)],
      ['speed', ch('speed', 'km/h', speed)],
    ]),
    laps,
    meta: { track: 'Test Oval', rider: 'r', note: '' },
  };
}

/** Minimal in-memory localStorage polyfill for the node test environment. */
function installLocalStorage(): void {
  const mem = new Map<string, string>();
  const ls = {
    get length() {
      return mem.size;
    },
    clear: () => mem.clear(),
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    key: (i: number) => [...mem.keys()][i] ?? null,
    removeItem: (k: string) => void mem.delete(k),
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
  } as Storage;
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true, writable: true });
}

describe('trackActions', () => {
  beforeEach(() => installLocalStorage());

  it('builds a track from an oval session: 2 turns, length ≈ 714 m', () => {
    const t = buildTrackFromSession(makeOvalSession());
    expect(t).not.toBeNull();
    const track = t!;
    expect(track.turns.length).toBe(2);
    expect(track.lengthM).toBeGreaterThan(PERIM * 0.9);
    expect(track.lengthM).toBeLessThan(PERIM * 1.1);
    expect(track.id).toBe('test-oval');
    expect(track.name).toBe('Test Oval');
    expect(track.sectors.length).toBe(2); // 3 sectors = S/F + 2 splits
    expect(track.startFinish.halfWidthM).toBe(15);
    expect(track.cumDistM.length).toBe(track.centerline.length);
  });

  it('returns null without laps or without GPS', () => {
    const noLaps = makeOvalSession();
    noLaps.laps = [];
    expect(buildTrackFromSession(noLaps)).toBeNull();

    const noGps = makeOvalSession();
    noGps.channels.delete('gps_lon');
    expect(buildTrackFromSession(noGps)).toBeNull();
  });

  it('reports the GPS centre of a session', () => {
    const c = sessionGpsCenter(makeOvalSession());
    expect(c).not.toBeNull();
    expect(c![0]).toBeCloseTo(ORIGIN[0], 2);
    expect(c![1]).toBeCloseTo(ORIGIN[1], 2);
  });

  it('round-trips a track through localStorage', () => {
    const track = buildTrackFromSession(makeOvalSession())!;
    saveTrack(track); // no document in node → download is skipped
    expect(localStorage.getItem(TRACKS_STORAGE_KEY)).toBeTruthy();

    const back = loadTracks();
    expect(back.length).toBe(1);
    expect(back[0].id).toBe(track.id);
    expect(back[0].cumDistM).toBeInstanceOf(Float64Array);
    expect(back[0].cumDistM.length).toBe(track.cumDistM.length);
    expect(back[0].cumDistM[back[0].cumDistM.length - 1]).toBeCloseTo(
      track.cumDistM[track.cumDistM.length - 1],
      6,
    );
    expect(back[0].centerline.length).toBe(track.centerline.length);
    expect(back[0].turns.length).toBe(track.turns.length);
  });

  it('loadTracks tolerates missing or corrupt storage', () => {
    expect(loadTracks()).toEqual([]);
    localStorage.setItem(TRACKS_STORAGE_KEY, '{not json');
    expect(loadTracks()).toEqual([]);
  });
});
