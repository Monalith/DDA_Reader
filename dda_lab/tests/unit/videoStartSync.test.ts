import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PROC, type Channel, type Lap, type Session } from '../../src/core/types';
import { applyStartLine, offsetForStartLine, pickStartLap } from '../../src/video/startSync';
import { useLab } from '../../src/state/store';
import { parseLabSession } from '../../src/core/labSession';
import { fromLocalM } from '../../src/core/geo';
import { buildTrackFromSession } from '../../src/state/trackActions';

// oval of storeStartLine.test.ts: two R=50 semicircles + two 200 m straights, 20 m/s at 10 Hz
const R = 50, STRAIGHT = 200, ARC = Math.PI * R, PERIM = 2 * STRAIGHT + 2 * ARC;
const ORIGIN: [number, number] = [11.0, 45.0];
function ovalPoint(sArc: number): [number, number] {
  let x = ((sArc % PERIM) + PERIM) % PERIM;
  if (x < STRAIGHT) return [x, -R];
  x -= STRAIGHT;
  if (x < ARC) { const a = -Math.PI / 2 + x / R; return [STRAIGHT + R * Math.cos(a), R * Math.sin(a)]; }
  x -= ARC;
  if (x < STRAIGHT) return [STRAIGHT - x, R];
  x -= STRAIGHT;
  const a = Math.PI / 2 + x / R; return [R * Math.cos(a), R * Math.sin(a)];
}
function makeOval(nLaps = 4): Session {
  const perLap = Math.round(PERIM / 2);
  const n = perLap * nLaps;
  const t = new Float64Array(n), lng = new Float32Array(n), lat = new Float32Array(n);
  for (let i = 0; i < n; i++) { t[i] = i / 10; const p = fromLocalM(ORIGIN, ovalPoint(i * 2)); lng[i] = p[0]; lat[i] = p[1]; }
  const laps: Lap[] = [];
  for (let k = 0; k < nLaps; k++) laps.push({ n: k + 1, startIdx: k * perLap, endIdx: Math.min(n - 1, (k + 1) * perLap), timeS: perLap / 10, sectorsS: [], isBest: k === 1, kind: 'flying' });
  const c = (name: string, unit: string, data: Float32Array): Channel => ({ name, unit, kind: 'raw', data, proc: { ...DEFAULT_PROC } });
  const channels = new Map<string, Channel>([
    ['gps_lon', c('gps_lon', 'deg', lng)], ['gps_lat', c('gps_lat', 'deg', lat)],
    ['speed', c('speed', 'km/h', new Float32Array(n).fill(72))], ['rpm', c('rpm', 'rpm', new Float32Array(n).fill(6000))],
    ['tps', c('tps', '%', new Float32Array(n).fill(50))], ['gear', c('gear', '', new Float32Array(n).fill(3))],
    ['lean', c('lean', 'deg', new Float32Array(n).fill(0))],
  ]);
  return { id: 'oval', name: 'oval', source: 'dda', color: '#f80', t, channels, laps, meta: { track: 'Oval', rider: '', note: '' } };
}

// 10 Hz session, t starts at 100 s; laps of 60 s (600 samples) starting at 50 s into the run.
function makeSession(id = 's1', nLaps = 3): Session {
  const n = 500 + nLaps * 600 + 100;
  const t = new Float64Array(n);
  for (let i = 0; i < n; i++) t[i] = 100 + i / 10;
  const laps: Lap[] = [];
  for (let k = 0; k < nLaps; k++) {
    laps.push({ n: k + 1, startIdx: 500 + k * 600, endIdx: 500 + (k + 1) * 600, timeS: 60, sectorsS: [], isBest: k === 1, kind: k === 0 ? 'out' : 'flying' });
  }
  const ch = (name: string): Channel => ({ name, unit: '', kind: 'raw', data: new Float32Array(n), proc: { ...DEFAULT_PROC } });
  return { id, name: id, source: 'dda', color: '#f80', t, channels: new Map([['speed', ch('speed')]]), laps, meta: { track: '', rider: '', note: '' } };
}

describe('startSync (pure)', () => {
  const s = makeSession();
  // lap starts at session t = 150, 210, 270

  it('offsetForStartLine puts the lap start at the start-line frame', () => {
    expect(offsetForStartLine(s, s.laps[2], 30)).toBeCloseTo(240, 6);
    expect(s.t[s.laps[2].startIdx] - offsetForStartLine(s, s.laps[2], 30)).toBeCloseTo(30, 6);
  });

  it('pickStartLap priorities', () => {
    // explicit lapN
    expect(pickStartLap(s, { lapN: 3, refLap: { sessionId: 's1', lap: 1 }, currentOffsetS: 0, startVideoS: 150 })!.n).toBe(3);
    // unknown lapN falls through to the reference lap of this session
    expect(pickStartLap(s, { lapN: 9, refLap: { sessionId: 's1', lap: 1 }, currentOffsetS: 0, startVideoS: 270 })!.n).toBe(1);
    // ref lap of another session is ignored → nearest under the current offset (offset 100: starts at 50, 110, 170)
    expect(pickStartLap(s, { refLap: { sessionId: 'other', lap: 1 }, currentOffsetS: 100, startVideoS: 165 })!.n).toBe(3);
    expect(pickStartLap(s, { currentOffsetS: 100, startVideoS: 60 })!.n).toBe(1);
    // no offset → best lap
    expect(pickStartLap(s, { startVideoS: 0 })!.n).toBe(2);
    // no best → first flying
    const nb = { ...s, laps: s.laps.map((l) => ({ ...l, isBest: false })) };
    expect(pickStartLap(nb, { startVideoS: 0 })!.n).toBe(2);
    const out = { ...s, laps: [{ ...s.laps[0], isBest: false }] };
    expect(pickStartLap(out, { startVideoS: 0 })!.n).toBe(1);
    expect(pickStartLap({ ...s, laps: [] }, { startVideoS: 0 })).toBeUndefined();
  });

  it('applyStartLine returns the re-aligned sync, or null without laps', () => {
    const r = applyStartLine({ sessionId: 's1', fileName: 'v.mp4', offsetS: 100 }, s, 112, undefined, undefined)!;
    expect(r.lap.n).toBe(2); // starts at 50/110/170 under offset 100 → 110 is nearest to 112
    expect(r.sync).toEqual({ sessionId: 's1', fileName: 'v.mp4', offsetS: 98, startVideoS: 112 });
    expect(applyStartLine({ sessionId: 's1', fileName: 'v.mp4', offsetS: 0 }, { ...s, laps: [] }, 10)).toBeNull();
    expect(applyStartLine({ sessionId: 's1', fileName: 'v.mp4', offsetS: 0 }, s, NaN)).toBeNull();
  });
});

describe('store: video start line', () => {
  beforeEach(() => {
    useLab.setState({ sessions: [], tracks: [], activeTrackId: undefined, selectedLaps: [], lapMeta: {}, refLap: undefined, cursor: null, videoSync: null, statusMessage: null, videoReopenName: null });
  });

  it('no video / no session / no laps → status message, never throws', () => {
    useLab.getState().setVideoStartLine(12);
    expect(useLab.getState().statusMessage).toMatch(/Open a video/);
    useLab.getState().setVideoSync({ sessionId: 'missing', fileName: 'v.mp4', offsetS: 5 });
    useLab.getState().setVideoStartLine(12);
    expect(useLab.getState().videoSync).toMatchObject({ offsetS: 5, startVideoS: 12 });
    expect(useLab.getState().statusMessage).toMatch(/open \/ pick a session/);
    const s = makeSession('s1', 0);
    useLab.setState({ sessions: [s] });
    useLab.getState().setVideoSync({ sessionId: 's1', fileName: 'v.mp4', offsetS: 5 });
    useLab.getState().syncVideoToStartLine();
    expect(useLab.getState().statusMessage).toMatch(/no laps/);
    expect(useLab.getState().videoSync!.offsetS).toBe(5);
  });

  it('setVideoStartLine aligns the picked lap start to the start-line frame; clear keeps the offset', () => {
    const s = makeSession();
    useLab.setState({ sessions: [s] });
    useLab.getState().setVideoSync({ sessionId: 's1', fileName: 'v.mp4', offsetS: 0 });
    useLab.getState().setVideoStartLine(83.45, 3);
    const sy = useLab.getState().videoSync!;
    expect(sy.startVideoS).toBe(83.45);
    expect(sy.offsetS).toBeCloseTo(s.t[s.laps[2].startIdx] - 83.45, 4);
    expect(useLab.getState().statusMessage).toBe('Start line synced: L3 start = video 01:23.45 (offset 186.5500 s)');
    // without lapN: nearest lap under the current offset stays L3
    useLab.getState().setVideoStartLine(84);
    expect(useLab.getState().videoSync!.offsetS).toBeCloseTo(270 - 84, 4);
    useLab.getState().setVideoStartLine(null);
    expect(useLab.getState().videoSync!.startVideoS).toBeUndefined();
    expect(useLab.getState().videoSync!.offsetS).toBeCloseTo(186, 4);
  });

  it('re-syncs after the laps change (re-detection) and with the reference lap', () => {
    const s = makeSession();
    useLab.setState({ sessions: [s] });
    useLab.getState().setVideoSync({ sessionId: 's1', fileName: 'v.mp4', offsetS: 0 });
    useLab.getState().setVideoStartLine(20, 2); // L2 start t=210 → offset 190
    expect(useLab.getState().videoSync!.offsetS).toBeCloseTo(190, 4);
    // gate moved: every lap now starts 3 s later
    s.laps = s.laps.map((l) => ({ ...l, startIdx: l.startIdx + 30, endIdx: l.endIdx + 30 }));
    useLab.getState().syncVideoToStartLine();
    expect(useLab.getState().videoSync!.offsetS).toBeCloseTo(193, 4);
    expect(useLab.getState().videoSync!.startVideoS).toBe(20);
    // choosing the reference lap L3 in this session moves the sync to it
    useLab.getState().setRefLap({ sessionId: 's1', lap: 3 });
    expect(useLab.getState().videoSync!.offsetS).toBeCloseTo(253, 4);
    expect(useLab.getState().statusMessage).toMatch(/^Start line synced: L3/);
  });

  it('setVideoSync without a start line keeps the one of the same file', () => {
    useLab.getState().setVideoSync({ sessionId: 's1', fileName: 'v.mp4', offsetS: 0, startVideoS: 7 });
    useLab.getState().setVideoSync({ sessionId: 's1', fileName: 'v.mp4', offsetS: 3 });
    expect(useLab.getState().videoSync).toEqual({ sessionId: 's1', fileName: 'v.mp4', offsetS: 3, startVideoS: 7 });
    useLab.getState().setVideoSync({ sessionId: 's1', fileName: 'other.mp4', offsetS: 3 });
    expect(useLab.getState().videoSync!.startVideoS).toBeUndefined();
  });

  it('the start line round-trips through a lab session', () => {
    const s = makeSession();
    useLab.setState({ sessions: [s] });
    useLab.getState().setVideoSync({ sessionId: 's1', fileName: 'v.mp4', offsetS: 0 });
    useLab.getState().setVideoStartLine(20, 2);
    const json = useLab.getState().serializeLabSession();
    const parsed = parseLabSession(json);
    expect(parsed.video).toMatchObject({ fileName: 'v.mp4', sessionId: 's1', startVideoS: 20 });
    expect(parsed.video!.offsetS).toBeCloseTo(190, 4);
  });

  it('moving the start gate on the map re-detects laps and re-aligns the start line', () => {
    const s = makeOval();
    useLab.getState().addSession(s);
    useLab.getState().setTrack(buildTrackFromSession(s)!);
    const sess0 = useLab.getState().sessions[0];
    const l2 = sess0.laps.find((l) => l.n === 2)!;
    useLab.getState().setVideoSync({ sessionId: 'oval', fileName: 'oval.mp4', offsetS: 0 });
    useLab.getState().setVideoStartLine(40, 2);
    expect(useLab.getState().videoSync!.offsetS).toBeCloseTo(sess0.t[l2.startIdx] - 40, 4);
    const before = useLab.getState().videoSync!.offsetS;
    useLab.getState().setStartLine(fromLocalM(ORIGIN, [100, R]));
    const st = useLab.getState();
    const sy = st.videoSync!;
    expect(sy.startVideoS).toBe(40);
    expect(sy.offsetS).not.toBeCloseTo(before, 2);
    // some re-detected lap now starts exactly at the start-line frame
    const sess = st.sessions[0];
    expect(sess.laps.some((l) => Math.abs(sess.t[l.startIdx] - sy.offsetS - 40) < 1e-3)).toBe(true);
    // and it is within one lap of the old alignment
    expect(Math.abs(sy.offsetS - before)).toBeLessThan(PERIM / 20);
  });
});
