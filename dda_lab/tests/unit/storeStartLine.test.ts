import { beforeEach, describe, expect, it } from 'vitest';
import { fromLocalM } from '../../src/core/geo';
import { DEFAULT_PROC, type Channel, type Lap, type Session } from '../../src/core/types';
import { buildTrackFromSession } from '../../src/state/trackActions';
import { lapKey, useLab } from '../../src/state/store';

// Same oval as trackActions.test.ts: two R=50 semicircles + two 200 m straights.
const R = 50, STRAIGHT = 200, ARC = Math.PI * R, PERIM = 2 * STRAIGHT + 2 * ARC;
const ORIGIN: [number, number] = [11.0, 45.0];
function ovalPoint(sArc: number): [number, number] {
  let s = ((sArc % PERIM) + PERIM) % PERIM;
  if (s < STRAIGHT) return [s, -R];
  s -= STRAIGHT;
  if (s < ARC) { const a = -Math.PI / 2 + s / R; return [STRAIGHT + R * Math.cos(a), R * Math.sin(a)]; }
  s -= ARC;
  if (s < STRAIGHT) return [STRAIGHT - s, R];
  s -= STRAIGHT;
  const a = Math.PI / 2 + s / R; return [R * Math.cos(a), R * Math.sin(a)];
}
function ch(name: string, unit: string, data: Float32Array): Channel { return { name, unit, kind: 'raw', data, proc: { ...DEFAULT_PROC } }; }
function makeSession(nLaps = 4): Session {
  const perLap = Math.round(PERIM / 2);
  const n = perLap * nLaps;
  const t = new Float64Array(n), lng = new Float32Array(n), lat = new Float32Array(n);
  for (let i = 0; i < n; i++) { t[i] = i / 10; const p = fromLocalM(ORIGIN, ovalPoint(i * 2)); lng[i] = p[0]; lat[i] = p[1]; }
  const laps: Lap[] = [];
  for (let k = 0; k < nLaps; k++) laps.push({ n: k + 1, startIdx: k * perLap, endIdx: Math.min(n - 1, (k + 1) * perLap), timeS: perLap / 10, sectorsS: [], isBest: k === 1, kind: 'flying' });
  const channels = new Map<string, Channel>([
    ['gps_lon', ch('gps_lon', 'deg', lng)], ['gps_lat', ch('gps_lat', 'deg', lat)],
    ['speed', ch('speed', 'km/h', new Float32Array(n).fill(72))], ['rpm', ch('rpm', 'rpm', new Float32Array(n).fill(6000))],
    ['tps', ch('tps', '%', new Float32Array(n).fill(50))], ['gear', ch('gear', '', new Float32Array(n).fill(3))],
    ['lean', ch('lean', 'deg', new Float32Array(n).fill(0))],
  ]);
  return { id: 'oval', name: 'oval', source: 'dda', color: '#f80', t, channels, laps, meta: { track: 'Oval', rider: '', note: '' } };
}

describe('store: start line, lap meta, turns', () => {
  beforeEach(() => {
    useLab.setState({ sessions: [], tracks: [], activeTrackId: undefined, selectedLaps: [], lapMeta: {}, refLap: undefined, cursor: null });
  });

  it('setStartLine moves the gate and re-detects laps with sector times', () => {
    const s = makeSession();
    useLab.getState().addSession(s);
    const track = buildTrackFromSession(s)!;
    useLab.getState().setTrack(track);
    const before = useLab.getState().sessions[0].laps.map((l) => l.startIdx);
    // new start line at the middle of the top straight (local x=100, y=R), heading -x
    const at = fromLocalM(ORIGIN, [100, R]);
    useLab.getState().setStartLine(at);
    const st = useLab.getState();
    const tr = st.tracks.find((t) => t.id === st.activeTrackId)!;
    expect(Math.abs(tr.startFinish.at[0] - at[0])).toBeLessThan(1e-4);
    expect(Math.abs(tr.startFinish.at[1] - at[1])).toBeLessThan(1e-4);
    expect(tr.sectors.length).toBeGreaterThanOrEqual(2);
    const laps = st.sessions[0].laps;
    expect(laps.length).toBeGreaterThanOrEqual(3);
    expect(laps.map((l) => l.startIdx)).not.toEqual(before);
    const flying = laps.filter((l) => l.kind === 'flying');
    expect(flying.every((l) => Math.abs(l.timeS - PERIM / 20) < 1)).toBe(true);
    expect(flying.some((l) => l.sectorsS.length === tr.sectors.length + 1)).toBe(true);
  });

  it('lap meta name/colour and removal from the workspace', () => {
    const s = makeSession();
    useLab.getState().addSession(s);
    const st = useLab.getState();
    expect(st.selectedLaps).toEqual([{ sessionId: 'oval', lap: 2 }]);
    st.setLapMeta('oval', 2, { name: 'Best oval', color: '#00ff00' });
    expect(useLab.getState().lapMeta[lapKey('oval', 2)]).toEqual({ name: 'Best oval', color: '#00ff00' });
    useLab.getState().removeLapFromWorkspace('oval', 2);
    expect(useLab.getState().selectedLaps).toEqual([]);
    expect(useLab.getState().lapMeta[lapKey('oval', 2)]).toBeUndefined();
  });

  it('deleted laps stay deleted when the start line moves (and never reach an export)', () => {
    const s = makeSession(6);
    useLab.getState().addSession(s);
    useLab.getState().setTrack(buildTrackFromSession(s)!);
    const victim = useLab.getState().sessions[0].laps.find((l) => l.n === 3)!;
    const [a, b] = [victim.startIdx, victim.endIdx];
    useLab.getState().deleteLap('oval', 3);
    useLab.getState().setStartLine(fromLocalM(ORIGIN, [100, R]));
    const st = useLab.getState();
    const laps = st.sessions[0].laps;
    expect(laps.length).toBeGreaterThan(0);
    const mid = (l: Lap) => (l.startIdx + l.endIdx) / 2;
    expect(laps.some((l) => mid(l) >= a && mid(l) <= b)).toBe(false);
    expect(laps.filter((l) => l.isBest).length).toBe(1);
    // every workspace lap (what the Laps panel exports) still exists in the session
    for (const r of st.selectedLaps) expect(laps.some((l) => l.n === r.lap)).toBe(true);
  });

  it('deleting every lap does not bring them back on the next refresh', () => {
    const s = makeSession();
    useLab.getState().addSession(s);
    useLab.getState().setTrack(buildTrackFromSession(s)!);
    for (const l of [...useLab.getState().sessions[0].laps]) useLab.getState().deleteLap('oval', l.n);
    expect(useLab.getState().sessions[0].laps).toEqual([]);
    useLab.getState().setTrack({ ...useLab.getState().tracks[0] });
    expect(useLab.getState().sessions[0].laps).toEqual([]);
    expect(useLab.getState().selectedLaps).toEqual([]);
  });

  it('removing a session drops its lap meta too', () => {
    useLab.getState().addSession(makeSession());
    useLab.getState().setLapMeta('oval', 2, { name: 'x' });
    useLab.getState().removeSession('oval');
    expect(useLab.getState().lapMeta).toEqual({});
  });

  it('updateTurns renumbers and renames turns', () => {
    const s = makeSession();
    useLab.getState().addSession(s);
    const track = buildTrackFromSession(s)!;
    useLab.getState().setTrack(track);
    expect(track.turns.length).toBe(2);
    useLab.getState().updateTurns([{ ...track.turns[1], name: 'Hairpin' }]);
    const st = useLab.getState();
    const tr = st.tracks.find((t) => t.id === st.activeTrackId)!;
    expect(tr.turns).toHaveLength(1);
    expect(tr.turns[0]).toMatchObject({ n: 1, name: 'Hairpin' });
  });
});
