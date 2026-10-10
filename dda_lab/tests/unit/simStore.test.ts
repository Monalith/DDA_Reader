import { beforeEach, describe, expect, it } from 'vitest';
import { SIM_SESSION_ID, useLab } from '../../src/state/store';
import { DEFAULT_SIM_PARAMS } from '../../src/sim/presets';
import { simulate } from '../../src/sim';
import { circuitTrack } from './circuitFixture';
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
      sessions: [], tracks: [], activeTrackId: undefined, selectedLaps: [],
      simEnabled: false, simParams: DEFAULT_SIM_PARAMS, simLine: undefined, simLapTimeS: undefined,
      corridor: undefined,
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
    // A perfect, symmetric circle has no braking zone at all (it is laterally
    // grip-limited at a constant speed all the way round), so brakingG is
    // provably inert here — verified empirically, identical lapTimeS to 15
    // significant digits with brakingG at 1.1 and at 1.6. mu changes the
    // lateral limit itself, so it always moves the lap time on this track.
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

  // Added beyond the brief's literal test list: test 1 only checks that a sim
  // session exists, not that it is actually comparable with a real lap. A
  // session that never joins selectedLaps would still pass test 1 while being
  // invisible in the chart stack, the map trace and the lap table — this is
  // the better observable.
  it('the sim session joins selectedLaps so it is directly comparable with a real lap', () => {
    useLab.getState().setTrack(circleTrack());
    useLab.getState().setSimEnabled(true);
    expect(useLab.getState().selectedLaps.some((l) => l.sessionId === SIM_SESSION_ID)).toBe(true);
    useLab.getState().setSimEnabled(false);
    expect(useLab.getState().selectedLaps.some((l) => l.sessionId === SIM_SESSION_ID)).toBe(false);
  });

  // C1. `toSession` used to label every channel `note: 'simulated'`, and two
  // mechanisms in `refreshSession()` then destroyed the solver's output:
  // `computeDerived` recomputed long_g/lat_g/curvature from `speed` and the
  // Float32 GPS polyline and mutated the channels in place, and
  // `fillMissingChannels` read `note` as "placeholder" and replaced `speed` and
  // `lean` with GPS estimates. Measured on the Serres sim session: speed
  // 117.7 -> 109.6 km/h, long_g -1.059 -> -0.085 g, lat_g -0.024 -> -18.63 g,
  // lean +52.4 -> -54.9 deg (sign flipped).
  //
  // Nothing covered it: simToSession.test.ts tests `simulate()` directly and
  // this file only asserted existence, lap time and selection. This is the
  // store-level round trip — through refreshAll(), twice.
  it('keeps the solver channels through refreshAll instead of refitting them from GPS', () => {
    // The 3044 m synthetic circuit, not `circleTrack`: a constant-radius
    // circle has long_g ~ 0 and one unchanging curvature everywhere, so the
    // GPS refit would happen to agree with the solver and the test would pass
    // either way. This fixture has a 600 m straight into a fast sweeper, a
    // 25 m hairpin, corners both ways and 0.25 m of centerline scatter.
    const { track, corridor } = circuitTrack(6, 2, 0.25);
    useLab.setState({ corridor });
    useLab.getState().setTrack(track);
    useLab.getState().setSimEnabled(true);

    // the same call the store makes, so the comparison is against the solver
    const expected = simulate(track, corridor, DEFAULT_SIM_PARAMS, SIM_SESSION_ID, 'Virtual rider', '#c77dff');

    const worstDiff = (name: string): number => {
      const got = useLab.getState().sessions.find((s) => s.isSim)!.channels.get(name)!.data;
      const want = expected.session.channels.get(name)!.data;
      expect(got).toHaveLength(want.length);
      let worst = 0;
      for (let i = 0; i < want.length; i++) worst = Math.max(worst, Math.abs(got[i] - want[i]));
      return worst;
    };
    const check = () => {
      for (const name of ['speed', 'long_g', 'lat_g', 'lean']) {
        // exact, to Float32 round-off: these channels must be carried through
        // untouched, not merely be close to the refit
        expect(worstDiff(name)).toBeLessThan(1e-6);
      }
      // and the channels are mutually consistent, which is what the overwrite
      // destroyed: the app writes lean as -atan(lat_g) (left = negative), so
      // tan(lean) + lat_g is zero up to resampling error everywhere. The
      // residual is 1.1e-3, from `toSession` interpolating `lean` and `lat_g`
      // onto the 10 Hz grid independently (interpolating an angle and
      // interpolating its tangent do not commute). Before this fix the same
      // measure was 385.
      const sim = useLab.getState().sessions.find((s) => s.isSim)!;
      const lean = sim.channels.get('lean')!.data;
      const latG = sim.channels.get('lat_g')!.data;
      let worst = 0;
      let leaning = 0;
      for (let i = 0; i < lean.length; i++) {
        worst = Math.max(worst, Math.abs(Math.tan((lean[i] * Math.PI) / 180) + latG[i]));
        if (Math.abs(lean[i]) > 10) leaning++;
      }
      expect(worst).toBeLessThan(0.01);
      expect(leaning).toBeGreaterThan(0); // an all-zero lean channel cannot pass
    };

    check();
    // a second refresh must be just as stable — the overwrite was idempotent in
    // the wrong direction, so one pass was enough to lose the data for good
    useLab.getState().setTrack(track);
    check();

    // the solver's speed really is a solver speed, not the GPS ground speed
    // `fillMissingChannels` used to substitute
    const sim = useLab.getState().sessions.find((s) => s.isSim)!;
    const speed = sim.channels.get('speed')!.data;
    const gps = sim.channels.get('gps_speed')!.data;
    let maxSpeedGap = 0;
    for (let i = 0; i < speed.length; i++) {
      if (Number.isFinite(gps[i])) maxSpeedGap = Math.max(maxSpeedGap, Math.abs(speed[i] - gps[i]));
    }
    expect(maxSpeedGap).toBeGreaterThan(0);
  });

  it('does nothing when enabled with no track loaded', () => {
    useLab.getState().setSimEnabled(true);
    expect(useLab.getState().sessions).toHaveLength(0);
    expect(useLab.getState().statusMessage).toMatch(/track/i);
  });
});
