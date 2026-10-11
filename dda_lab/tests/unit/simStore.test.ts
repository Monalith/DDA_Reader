import { beforeEach, describe, expect, it } from 'vitest';
import {
  INITIAL_SIM_PARAMS, SIM_OCP_SESSION_ID, SIM_OPT_SESSION_ID, SIM_SESSION_ID, useLab, type OptimalRunner,
} from '../../src/state/store';
import { DEFAULT_SIM_PARAMS } from '../../src/sim/presets';
import { DERIVE_TABLE, deriveRider } from '../../src/sim/derive';
import { buildLine } from '../../src/sim/line';
import { idealParams, simulate } from '../../src/sim';
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
    const expected = simulate(track, corridor, useLab.getState().simParams, SIM_SESSION_ID, 'Virtual rider', '#c77dff');

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
      // destroyed. In v1 lean was -atan(lat_g) exactly; since v2 `lean` is the
      // BIKE roll (crown + hang-off, vehicle.ts), which is larger than the
      // ideal angle at lean and zero below ~0.15 g, so the check is now sign
      // agreement (left = negative, opposite to lat_g) wherever the bike is
      // actually leaning, plus the exact carry-through asserted above. A refit
      // from GPS (the bug this guards) would break the exact carry-through
      // long before it broke the sign.
      const sim = useLab.getState().sessions.find((s) => s.isSim)!;
      const lean = sim.channels.get('lean')!.data;
      const latG = sim.channels.get('lat_g')!.data;
      let signErrors = 0;
      let leaning = 0;
      for (let i = 0; i < lean.length; i++) {
        if (Math.abs(lean[i]) > 10) {
          leaning++;
          if (Math.sign(lean[i]) !== -Math.sign(latG[i])) signErrors++;
        }
      }
      expect(signErrors).toBe(0);
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

// ---- v2: derived rider, overrides, solver modes (plan W6 Task 6.4) --------

/** A runner that returns the kappa line's own offsets, like a 0-iteration optimiser. */
function kappaRunner(withSpeed = false): OptimalRunner & { calls: number } {
  const fn = (async (track, corridor, params, onProgress) => {
    fn.calls++;
    onProgress(0.5, 99);
    const line = buildLine(track, corridor, idealParams(params));
    const vMs = withSpeed ? new Float32Array(line.points.length).fill(25) : undefined;
    onProgress(1, 98);
    return { offsetsM: Float32Array.from(line.offsetM), vMs, lapTimeS: 98 };
  }) as OptimalRunner & { calls: number };
  fn.calls = 0;
  return fn;
}

describe('sim store v2', () => {
  beforeEach(() => {
    useLab.setState({
      sessions: [], tracks: [], activeTrackId: undefined, selectedLaps: [],
      simEnabled: false, simParams: INITIAL_SIM_PARAMS, simLine: undefined, simLapTimeS: undefined,
      corridor: undefined, solverMode: 'rider', statusMessage: null,
      simOptBusy: { freeTrajectory: false, ocp: false },
      simOptProgress: { freeTrajectory: 0, ocp: 0 },
      simOptLapTimeS: {}, simOptLines: {}, simOptStale: { freeTrajectory: false, ocp: false },
    });
  });

  it('starts from a rider already derived from aggressiveness and risk', () => {
    const p = INITIAL_SIM_PARAMS;
    expect(deriveRider(p.rider, p.tyre)).toEqual(p.rider);
  });

  it('re-derives the rider on every patch', () => {
    useLab.getState().setSimParams({ rider: { risk: 1 } });
    let r = useLab.getState().simParams.rider;
    expect(r.sBrake).toBeCloseTo(DERIVE_TABLE.sBrake.a + DERIVE_TABLE.sBrake.b, 12);
    expect(r.trailBrakeProfile).toBeCloseTo(1, 12);
    useLab.getState().setSimParams({ rider: { aggressiveness: 0 } });
    r = useLab.getState().simParams.rider;
    expect(r.throttleDelayS).toBeCloseTo(DERIVE_TABLE.throttleDelayS.a, 12);
    // a tyre patch moves the tyre-curve fields too
    const before = r.brakingG;
    useLab.getState().setSimParams({ tyre: { gripScale: 0.8 } });
    expect(useLab.getState().simParams.rider.brakingG).toBeLessThan(before);
  });

  it('patching a derived key pins it, and clearOverride lets it follow the sliders again', () => {
    useLab.getState().setSimParams({ rider: { sBrake: 0.4 } });
    expect(useLab.getState().simParams.rider.overrides).toContain('sBrake');
    useLab.getState().setSimParams({ rider: { risk: 1 } });
    expect(useLab.getState().simParams.rider.sBrake).toBe(0.4);
    // brakingG is not pinned, so it follows the pinned sBrake
    const pinnedBraking = useLab.getState().simParams.rider.brakingG;
    useLab.getState().clearOverride('sBrake');
    const r = useLab.getState().simParams.rider;
    expect(r.overrides).not.toContain('sBrake');
    expect(r.sBrake).toBeCloseTo(DERIVE_TABLE.sBrake.a + DERIVE_TABLE.sBrake.b, 12);
    expect(r.brakingG).toBeGreaterThan(pinnedBraking);
  });

  it('a non-derived rider key (kappa, line deviation) is never pinned', () => {
    useLab.getState().setSimParams({ rider: { kappa: 0.3, lineDeviationM: 1 } });
    expect(useLab.getState().simParams.rider.overrides).toEqual([]);
  });

  it('switching the solver mode computes nothing', () => {
    useLab.getState().setTrack(circleTrack());
    useLab.getState().setSimEnabled(true);
    const sessions = useLab.getState().sessions;
    useLab.getState().setSolverMode('ocp');
    expect(useLab.getState().solverMode).toBe('ocp');
    expect(useLab.getState().sessions).toBe(sessions);
  });

  it('runs an optimal solver only on runOptimal — never on a slider patch', async () => {
    useLab.getState().setTrack(circleTrack());
    useLab.getState().setSimEnabled(true);
    const runner = kappaRunner();
    await useLab.getState().runOptimal('freeTrajectory', runner);
    expect(runner.calls).toBe(1);
    const opt = useLab.getState().sessions.find((s) => s.id === SIM_OPT_SESSION_ID)!;
    expect(opt).toBeTruthy();
    const optLap = useLab.getState().simOptLapTimeS.freeTrajectory;
    expect(optLap).toBeGreaterThan(0);
    for (let k = 0; k < 10; k++) {
      useLab.getState().setSimParams({ rider: { risk: k / 10 } });
      useLab.getState().setSimParams({ tyre: { mu: 1 + k / 50 } });
    }
    useLab.getState().setSolverMode('freeTrajectory');
    useLab.getState().applyMachinePreset('600');
    expect(runner.calls).toBe(1);
    // the optimal lap is not recomputed by the patches
    expect(useLab.getState().simOptLapTimeS.freeTrajectory).toBe(optLap);
    expect(useLab.getState().sessions.filter((s) => s.id === SIM_OPT_SESSION_ID)).toHaveLength(1);
    // but it is flagged as out of date once machine or tyre moved
    expect(useLab.getState().simOptStale.freeTrajectory).toBe(true);
  });

  it('keeps the three sim sessions side by side, all selected, and removes all three on disable', async () => {
    useLab.getState().setTrack(circleTrack());
    useLab.getState().setSimEnabled(true);
    await useLab.getState().runOptimal('freeTrajectory', kappaRunner());
    await useLab.getState().runOptimal('ocp', kappaRunner(true));
    const st = useLab.getState();
    const ids = st.sessions.filter((s) => s.isSim).map((s) => s.id).sort();
    expect(ids).toEqual([SIM_SESSION_ID, SIM_OCP_SESSION_ID, SIM_OPT_SESSION_ID].sort());
    for (const id of ids) expect(st.selectedLaps.some((l) => l.sessionId === id)).toBe(true);
    // the OCP's own speed drives its lap: line length / 25 m/s
    expect(st.simOptLapTimeS.ocp).toBeCloseTo(st.simOptLines.ocp!.lengthM / 25, 3);
    expect(st.simOptLines.freeTrajectory).toBeTruthy();
    // a rider re-solve leaves the optimal sessions in place
    useLab.getState().setSimParams({ rider: { risk: 0.1 } });
    expect(useLab.getState().sessions.filter((s) => s.isSim)).toHaveLength(3);

    useLab.getState().setSimEnabled(false);
    const after = useLab.getState();
    expect(after.sessions.some((s) => s.isSim)).toBe(false);
    expect(after.selectedLaps.some((l) => ids.includes(l.sessionId))).toBe(false);
    expect(after.simOptLapTimeS).toEqual({});
  });

  it('reports progress and busy state while an optimal run is in flight', async () => {
    useLab.getState().setTrack(circleTrack());
    useLab.getState().setSimEnabled(true);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const runner: OptimalRunner = async (track, corridor, params, onProgress) => {
      onProgress(0.4, 90);
      await gate;
      const line = buildLine(track, corridor, idealParams(params));
      return { offsetsM: Float32Array.from(line.offsetM), lapTimeS: 90 };
    };
    const p = useLab.getState().runOptimal('freeTrajectory', runner);
    expect(useLab.getState().simOptBusy.freeTrajectory).toBe(true);
    expect(useLab.getState().simOptProgress.freeTrajectory).toBeCloseTo(0.4, 9);
    // a second click while busy does not start a second run
    const second = kappaRunner();
    await useLab.getState().runOptimal('freeTrajectory', second);
    expect(second.calls).toBe(0);
    release();
    await p;
    expect(useLab.getState().simOptBusy.freeTrajectory).toBe(false);
    expect(useLab.getState().simOptProgress.freeTrajectory).toBe(1);
  });

  it('a failing runner leaves a status message and no session', async () => {
    useLab.getState().setTrack(circleTrack());
    useLab.getState().setSimEnabled(true);
    await useLab.getState().runOptimal('ocp', async () => { throw new Error('bridge unreachable'); });
    const st = useLab.getState();
    expect(st.simOptBusy.ocp).toBe(false);
    expect(st.sessions.some((s) => s.id === SIM_OCP_SESSION_ID)).toBe(false);
    expect(st.statusMessage).toMatch(/bridge unreachable/);
  });

  it('drops a result that arrives after the simulator was switched off', async () => {
    useLab.getState().setTrack(circleTrack());
    useLab.getState().setSimEnabled(true);
    const runner: OptimalRunner = async (track, corridor, params) => {
      useLab.getState().setSimEnabled(false);
      const line = buildLine(track, corridor, idealParams(params));
      return { offsetsM: Float32Array.from(line.offsetM), lapTimeS: 1 };
    };
    await useLab.getState().runOptimal('freeTrajectory', runner);
    expect(useLab.getState().sessions.some((s) => s.isSim)).toBe(false);
  });

  it('records the corner count and the rider risk message with the rider lap', () => {
    useLab.getState().setTrack(circleTrack());
    useLab.getState().setSimEnabled(true);
    const st = useLab.getState();
    expect(Array.isArray(st.simCorners)).toBe(true);
    expect(st.simRisk).toBeNull();
  });
});

describe('corridor JSON export / import', () => {
  it('round-trips the corridor through the stored JSON record', async () => {
    const { useLab } = await import('../../src/state/store');
    const { circuitTrack } = await import('./circuitFixture');
    const t = circuitTrack();
    useLab.getState().setTrack(t);
    const n = t.centerline.length;
    const corridor = { stepM: 2, leftM: new Float32Array(n).fill(5), rightM: new Float32Array(n).fill(5), known: new Array<boolean>(n).fill(true) };
    useLab.setState({ corridor });
    const text = useLab.getState().exportCorridorJson();
    expect(text).not.toBeNull();
    useLab.setState({ corridor: undefined });
    expect(useLab.getState().importCorridorJson(text!)).toBe(true);
    const back = useLab.getState().corridor!;
    expect(back.known.filter(Boolean).length).toBeGreaterThan(n * 0.9);
    expect(useLab.getState().importCorridorJson('{"version":1}')).toBe(false);
    expect(useLab.getState().importCorridorJson('not json')).toBe(false);
  });

  it('accepts a .pist.json track model through the same import, with no session loaded', async () => {
    const { useLab } = await import('../../src/state/store');
    const fs = await import('node:fs');
    const text = fs.readFileSync(new URL('../../public/tracks/serres.pist.json', import.meta.url), 'utf8');
    useLab.setState({ tracks: [], activeTrackId: undefined, trackPackage: undefined, corridor: undefined, sessions: [] });
    expect(useLab.getState().importCorridorJson(text)).toBe(true);
    const st = useLab.getState();
    expect(st.trackPackage?.name).toBeTruthy();
    expect(st.activeTrackId).toMatch(/^pist-/);
    expect(st.corridor).toBeDefined();
    expect(st.statusMessage).toMatch(/Track model/);
    // a malformed package reports, not throws
    expect(useLab.getState().importCorridorJson('{"version":2,"centerline":[]}')).toBe(false);
    expect(useLab.getState().statusMessage).toMatch(/Track model import/);
  });

  it('keeps the track model corridor on Extract and reveals the line layers when the rider is enabled', async () => {
    const { useLab } = await import('../../src/state/store');
    const fs = await import('node:fs');
    const text = fs.readFileSync(new URL('../../public/tracks/serres.pist.json', import.meta.url), 'utf8');
    useLab.setState({ tracks: [], activeTrackId: undefined, trackPackage: undefined, corridor: undefined, sessions: [], simEnabled: false });
    expect(useLab.getState().importCorridorJson(text)).toBe(true);
    const before = useLab.getState().corridor!;
    useLab.setState({ corridor: undefined });
    await useLab.getState().extractCorridorNow();
    const st = useLab.getState();
    expect(st.corridor?.known.filter(Boolean).length).toBe(before.known.filter(Boolean).length);
    expect(st.statusMessage).toMatch(/comes from the track model/);
    // enabling the rider needs no session on a track model, and shows its layers
    useLab.getState().setWorkspace({ mapLayers: { ...st.workspace.mapLayers, idealLine: false, corridor: false } });
    useLab.getState().setSimEnabled(true);
    const on = useLab.getState();
    expect(on.simLine).toBeDefined();
    expect(on.simLapTimeS).toBeGreaterThan(60);
    expect(on.workspace.mapLayers.idealLine).toBe(true);
    expect(on.workspace.mapLayers.corridor).toBe(true);
  });
});
