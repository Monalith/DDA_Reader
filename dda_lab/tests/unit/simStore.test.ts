import { beforeEach, describe, expect, it } from 'vitest';
import { useLab } from '../../src/state/store';
import { DEFAULT_SIM_PARAMS } from '../../src/sim/presets';
import type { LngLat, TrackModel } from '../../src/core/types';

function circleTrack(radiusM = 300): TrackModel {
  const lat0 = 41.073;
  const lng0 = 23.518;
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const n = Math.round((2 * Math.PI * radiusM) / 2);
  const centerline: LngLat[] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    centerline.push([lng0 + (radiusM * Math.cos(a)) / mPerDegLng, lat0 + (radiusM * Math.sin(a)) / mPerDegLat]);
  }
  const step = (2 * Math.PI * radiusM) / n;
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + step;
  return {
    id: 'c', name: 'circle', center: [lng0, lat0], centerline, cumDistM: cum, lengthM: step * n,
    startFinish: { id: 'sf', name: 'SF', type: 'sf', at: centerline[0], bearingDeg: 0, halfWidthM: 15 },
    sectors: [], turns: [],
  };
}

describe('sim store', () => {
  beforeEach(() => {
    useLab.setState({
      sessions: [], tracks: [], activeTrackId: undefined, selectedLaps: [], refLap: undefined, cursor: null, statusMessage: null,
      simEnabled: false, simParams: DEFAULT_SIM_PARAMS, simLine: undefined, simLapTimeS: undefined, corridor: undefined,
    });
  });
  it('adds a sim session when the simulator is enabled', () => {
    useLab.getState().setTrack(circleTrack());
    useLab.getState().setSimEnabled(true);
    const st = useLab.getState();
    expect(st.sessions.some((s) => s.isSim)).toBe(true);
    expect(st.simLapTimeS).toBeGreaterThan(0);
  });
  it('removes the sim session again when disabled', () => {
    useLab.getState().setTrack(circleTrack());
    useLab.getState().setSimEnabled(true);
    useLab.getState().setSimEnabled(false);
    expect(useLab.getState().sessions.some((s) => s.isSim)).toBe(false);
  });
  it('re-simulates in place on a parameter change, keeping exactly one sim session', () => {
    useLab.getState().setTrack(circleTrack());
    useLab.getState().setSimEnabled(true);
    const before = useLab.getState().simLapTimeS!;
    // a constant-radius circle never brakes, so change the grip instead of the braking g
    useLab.getState().setSimParams({ tyre: { mu: 0.8 } });
    const after = useLab.getState().simLapTimeS!;
    expect(useLab.getState().sessions.filter((s) => s.isSim)).toHaveLength(1);
    expect(after).not.toBe(before);
  });
  it('a machine preset fills machine, tyre and kappa together', () => {
    useLab.getState().applyMachinePreset('250');
    const p = useLab.getState().simParams;
    expect(p.machine.presetId).toBe('250');
    expect(p.machine.powerKw).toBe(33);
    expect(p.tyre.maxLeanDeg).toBe(52);
    expect(p.rider.kappa).toBeCloseTo(0.1, 6);
  });
  it('does nothing when enabled with no track loaded', () => {
    useLab.getState().setSimEnabled(true);
    expect(useLab.getState().sessions).toHaveLength(0);
    expect(useLab.getState().statusMessage).toMatch(/track/i);
  });
});
