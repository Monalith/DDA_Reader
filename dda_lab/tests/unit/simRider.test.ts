import { describe, expect, it } from 'vitest';
import { riderChannels } from '../../src/sim/rider';
import { solve } from '../../src/sim/solver';
import { clampParams, DEFAULT_SIM_PARAMS } from '../../src/sim/presets';
import { cornerLine } from './simSolver.test';
import { circuitTrack } from './circuitFixture';
import { buildLine } from '../../src/sim/line';
import type { Envelope, Line } from '../../src/sim/types';
import type { LngLat } from '../../src/core/types';

const P = clampParams(DEFAULT_SIM_PARAMS);

/** The OVERLAP clamp's own constant, repeated here so the test states the bound it checks. */
const OVERLAP = 1.15;
/** The throttle the clamp leaves available beside a given brake level. */
const allowanceFor = (brakePct: number): number => Math.max(0, 100 - OVERLAP * brakePct);

/**
 * A synthetic envelope that actually drives the OVERLAP clamp into binding.
 *
 * T4: the previous version of this fixture (50 samples of −1.1 g at 100 Hz,
 * then +0.9 g) was silently invalidated by the brake-EVENT layer added in
 * 1981f1c. Inside an event the filtered throttle demand is forced to zero, and
 * the event now runs ~0.39 s past the demand drop — by which time the brake has
 * bled from 100 % to about 40 % and is still falling at the rate limit, while
 * the throttle is only starting from zero. The two never met: the clamp never
 * bound, and replacing `allowance` with a constant 100 left all 31 rider tests
 * green.
 *
 * What makes them meet is a COARSE time grid. The braking event ends at the
 * last sample whose filtered demand is still above `BRAKE_OFF_PCT`, so a
 * 33 Hz grid ends it up to one sample early and leaves the brake correspondingly
 * higher (47 % rather than 42 %); and one sample is then 350 * 0.03 = 10.5
 * points of throttle, so the throttle catches the falling brake inside the
 * overlap band instead of stepping past it. Measured at this exact
 * configuration the clamp holds the throttle at 93.68 % against a brake of
 * 5.50 % — `tps + 1.15 * brake` exactly 100.000.
 *
 * The brake demand is ONE sample of −1.8 g against a `brakingG` of 0.4, which
 * saturates the brake demand at 100 % immediately (`riderChannels` seeds its
 * running brake value from the raw demand at sample 0), then full throttle
 * demand for the rest of the fixture.
 */
function brakeToThrottleEnvelope(dtS = 0.03, n = 200): { line: Line; env: Envelope } {
  const points: LngLat[] = Array.from({ length: n }, () => [23.518, 41.073] as LngLat);
  const line: Line = {
    points,
    curvature: new Float32Array(n),
    cumDistM: new Float64Array(n),
    lengthM: n,
    offsetM: new Float32Array(n),
  };
  const longG = new Float32Array(n);
  const tS = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    longG[i] = i === 0 ? -1.8 : 0.9;
    tS[i] = i * dtS;
  }
  const env: Envelope = {
    v: new Float32Array(n).fill(30),
    longG,
    latG: new Float32Array(n),
    leanDeg: new Float32Array(n),
    gripUse: new Float32Array(n),
    tS,
    lapTimeS: n * dtS,
  };
  return { line, env };
}

/**
 * A flat fixture whose only content is a `longG` trace given as a function of
 * time, for exercising the demand filter and the dead-band in isolation.
 */
function constantDemand(n: number, dtS: number, gAt: (t: number) => number): { line: Line; env: Envelope } {
  const points: LngLat[] = Array.from({ length: n }, () => [23.518, 41.073] as LngLat);
  const longG = new Float32Array(n);
  const tS = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    tS[i] = i * dtS;
    longG[i] = gAt(tS[i]);
  }
  return {
    line: {
      points, curvature: new Float32Array(n), cumDistM: new Float64Array(n),
      lengthM: n, offsetM: new Float32Array(n),
    },
    env: {
      v: new Float32Array(n).fill(40), longG, latG: new Float32Array(n),
      leanDeg: new Float32Array(n), gripUse: new Float32Array(n), tS, lapTimeS: n * dtS,
    },
  };
}

describe('riderChannels', () => {
  it('produces channels of the same length as the line', () => {
    const line = cornerLine();
    const ch = riderChannels(line, solve(line, P), P);
    expect(ch.tps).toHaveLength(line.points.length);
    expect(ch.gear).toHaveLength(line.points.length);
    expect(ch.rpm).toHaveLength(line.points.length);
    expect(ch.dtc).toHaveLength(line.points.length);
  });

  it('keeps throttle in 0..100 and gear in 1..top', () => {
    const line = cornerLine();
    const ch = riderChannels(line, solve(line, P), P);
    for (let i = 0; i < ch.tps.length; i++) {
      expect(ch.tps[i]).toBeGreaterThanOrEqual(0);
      expect(ch.tps[i]).toBeLessThanOrEqual(100);
      expect(ch.gear[i]).toBeGreaterThanOrEqual(1);
      expect(ch.gear[i]).toBeLessThanOrEqual(P.machine.gearRatios.length);
      expect(Number.isInteger(ch.gear[i])).toBe(true);
    }
  });

  it('shuts the throttle under braking and opens it on the way out', () => {
    const line = cornerLine();
    const env = solve(line, P);
    const ch = riderChannels(line, env, P);
    // the slowest point is the apex; find it
    let apex = 0;
    for (let i = 1; i < env.v.length; i++) if (env.v[i] < env.v[apex]) apex = i;
    const beforeApex = ch.tps[Math.max(0, apex - 30)];
    const afterApex = ch.tps[Math.min(ch.tps.length - 1, apex + 80)];
    expect(beforeApex).toBeLessThan(40);
    expect(afterApex).toBeGreaterThan(beforeApex);
  });

  it('delays the throttle more when throttleDelayS is larger', () => {
    const line = cornerLine();
    const env = solve(line, P);
    const quick = riderChannels(line, env, clampParams({ ...P, rider: { ...P.rider, throttleDelayS: 0 } }));
    const slow = riderChannels(line, env, clampParams({ ...P, rider: { ...P.rider, throttleDelayS: 1.5 } }));
    let apex = 0;
    for (let i = 1; i < env.v.length; i++) if (env.v[i] < env.v[apex]) apex = i;
    // the corner itself is a constant-radius arc with zero longitudinal
    // demand throughout, so the throttle only starts opening again once the
    // line straightens on exit; pick a point there, well into the ramp.
    const at = Math.min(env.v.length - 1, apex + 70);
    expect(slow.tps[at]).toBeLessThan(quick.tps[at]);
  });

  it('reports TC intervention only where the drive demand is high', () => {
    const line = cornerLine();
    const ch = riderChannels(line, solve(line, P), P);
    expect(ch.dtc.every((d) => d >= 0 && d <= 100)).toBe(true);
    // no intervention while hard on the brakes at the start of the braking zone
    expect(Math.max(...Array.from(ch.dtc.slice(0, 50)))).toBe(0);
    // but it does intervene somewhere on this line, under exit acceleration —
    // an all-zero dtc channel would satisfy both checks above trivially
    expect(Math.max(...Array.from(ch.dtc))).toBeGreaterThan(0);
  });

  it('rises through the gears as speed rises', () => {
    const line = cornerLine();
    const env = solve(line, P);
    const ch = riderChannels(line, env, P);
    let fastest = 0;
    let slowest = 0;
    for (let i = 1; i < env.v.length; i++) {
      if (env.v[i] > env.v[fastest]) fastest = i;
      if (env.v[i] < env.v[slowest]) slowest = i;
    }
    // strictly greater, and more than one gear is actually used — a constant
    // gear channel would satisfy >= trivially, so this also checks variety.
    expect(ch.gear[fastest]).toBeGreaterThan(ch.gear[slowest]);
    expect(new Set(Array.from(ch.gear)).size).toBeGreaterThan(1);
  });

  it('never steps straight from full throttle to full brake', () => {
    const line = cornerLine();
    const env = solve(line, P);
    const ch = riderChannels(line, env, P);
    // find the hardest throttle-to-brake transition and measure how long it took
    let worstPctPerS = 0;
    for (let i = 1; i < ch.tps.length; i++) {
      const dt = Math.max(1e-3, env.tS[i] - env.tS[i - 1]);
      worstPctPerS = Math.max(worstPctPerS, Math.abs(ch.brake[i] - ch.brake[i - 1]) / dt);
    }
    // the brake-on rate limit is 700 %/s; nothing may exceed it
    expect(worstPctPerS).toBeLessThan(760);
  });

  it('does not drive and stop at the same time', () => {
    // T4: this used to assert `tps + brake/1.15 < 101`, DIVIDING where the
    // clamp multiplies. `tps <= 100 - 1.15*brake` bounds `tps + brake/1.15` at
    // `100 - 0.28*brake`, which cannot reach 101 for any brake level at all,
    // so the assertion was unfalsifiable. The clamp's actual guarantee is that
    // the throttle never exceeds what the brake leaves.
    const line = cornerLine();
    const ch = riderChannels(line, solve(line, P), P);
    for (let i = 0; i < ch.tps.length; i++) {
      expect(ch.tps[i]).toBeLessThanOrEqual(allowanceFor(ch.brake[i]) + 1e-3);
    }
  });

  it('bleeds the brake off more slowly at a higher trailBrakeProfile', () => {
    const line = cornerLine();
    const env = solve(line, P);
    const abrupt = riderChannels(line, env, clampParams({ ...P, rider: { ...P.rider, trailBrakeProfile: 0 } }));
    const smooth = riderChannels(line, env, clampParams({ ...P, rider: { ...P.rider, trailBrakeProfile: 1 } }));
    const fallRate = (b: Float32Array): number => {
      let worst = 0;
      for (let i = 1; i < b.length; i++) {
        const dt = Math.max(1e-3, env.tS[i] - env.tS[i - 1]);
        worst = Math.max(worst, (b[i - 1] - b[i]) / dt);
      }
      return worst;
    };
    expect(fallRate(smooth.brake)).toBeLessThan(fallRate(abrupt.brake));
  });

  it('bleeds the brake off more slowly at a higher trailBrakeDepth too', () => {
    // The release-rate CEILING is now set by both trail-brake sliders, with
    // depth leading (see BRAKE_OFF_PCT_S). The envelope is held fixed so this
    // is purely the rider layer: the trace has to keep looking right while
    // neither parameter is confined to the trace any more.
    const line = cornerLine();
    const env = solve(line, P);
    const shallow = riderChannels(line, env, clampParams({ ...P, rider: { ...P.rider, trailBrakeDepth: 0 } }));
    const deep = riderChannels(line, env, clampParams({ ...P, rider: { ...P.rider, trailBrakeDepth: 1 } }));
    const fallRate = (b: Float32Array): number => {
      let worst = 0;
      for (let i = 1; i < b.length; i++) {
        const dt = Math.max(1e-3, env.tS[i] - env.tS[i - 1]);
        worst = Math.max(worst, (b[i - 1] - b[i]) / dt);
      }
      return worst;
    };
    // 0.6 * 1250 = 750 %/s of authority, so this is not a rounding difference
    expect(fallRate(deep.brake)).toBeLessThan(fallRate(shallow.brake) - 300);
  });

  it('clamps the throttle against a still-falling brake, and the clamp really binds', () => {
    // The OVERLAP clamp, exercised. See `brakeToThrottleEnvelope` for why the
    // previous fixture could not reach it. Two assertions: the invariant holds
    // everywhere, AND there is at least one sample where the clamp is what is
    // holding the throttle down — without the second, replacing `allowance`
    // with a constant 100 would leave the first green, which is exactly what
    // happened before.
    const { line, env } = brakeToThrottleEnvelope();
    const pp = clampParams({
      ...P,
      // the slowest brake release the model allows (both trail-brake sliders
      // at 1 => BRAKE_OFF_PCT_S = 150), which is what keeps the brake falling
      // long enough for the overlap clamp to be the binding constraint
      rider: { ...P.rider, trailBrakeDepth: 1, trailBrakeProfile: 1, throttleDelayS: 0, brakingG: 0.4 },
    });
    const ch = riderChannels(line, env, pp);
    let binding = 0;
    for (let i = 0; i < ch.tps.length; i++) {
      const allow = allowanceFor(ch.brake[i]);
      expect(ch.tps[i]).toBeLessThanOrEqual(allow + 1e-3);
      // the clamp's fingerprint: the brake is still on, the throttle is open,
      // and the throttle is sitting exactly on the allowance rather than on
      // its own rate limit
      if (ch.brake[i] > 1 && ch.tps[i] > 1 && Math.abs(ch.tps[i] - allow) < 1e-3) binding++;
    }
    expect(binding).toBeGreaterThan(0);
  });

  it('holds some brake past turn-in when the rider trail brakes', () => {
    const line = cornerLine();
    const env = solve(line, P);
    const ch = riderChannels(line, env, clampParams({
      ...P,
      rider: { ...P.rider, trailBrakeDepth: 1, trailBrakeProfile: 1 },
    }));
    let apex = 0;
    for (let i = 1; i < env.v.length; i++) if (env.v[i] < env.v[apex]) apex = i;
    // somewhere in the second half of the entry there is still brake pressure
    const entry = ch.brake.slice(Math.floor(apex * 0.75), apex);
    expect(Math.max(...Array.from(entry))).toBeGreaterThan(5);
  });

  it('brakes exactly once per corner over a lap, not once per curvature wiggle', () => {
    // The chattering the user saw. A quasi-steady-state envelope on a
    // centerline with any scatter in it has dozens of shallow local speed
    // minima, every one of which is a sign change in longG; the rate limiter
    // on its own answers each with a real brake application.
    //
    // `circuitTrack()`'s ground truth, independent of any curvature-noise
    // reading, is its own segment list: it has FIVE arcs (sweeper, link1,
    // hairpin, and two unnamed closing bends) — not four, despite that being
    // this fixture's name in earlier rounds' reports; `segIdx` below counts
    // them directly off the geometry rather than off a noisy curvature
    // estimate. The count was 72 before the low-pass/dead-band, 9 after
    // those (still ~2 per corner), and is exactly 5 — one per corner — with
    // the event-merging in this round.
    const { track, corridor, segIdx } = circuitTrack(6, 2, 0.25);
    const isArc = new Set([1, 3, 5, 7, 9]);
    let corners = 0;
    let prevArc = isArc.has(segIdx[segIdx.length - 1]);
    for (let i = 0; i < segIdx.length; i++) {
      const cur = isArc.has(segIdx[i]);
      if (cur && !prevArc) corners++;
      prevArc = cur;
    }
    expect(corners).toBe(5);

    const line = buildLine(track, corridor, P);
    const env = solve(line, P);
    const ch = riderChannels(line, env, P);
    const n = ch.brake.length;
    let apps = 0;
    for (let i = 0; i < n; i++) {
      if (ch.brake[(i - 1 + n) % n] <= 0 && ch.brake[i] > 0) apps++;
    }
    // exactly one application per corner — not merely "a handful": a
    // one-per-wiggle channel runs to dozens, and zero would mean the channel
    // is simply dead, but this fixture's corner count is known exactly, so
    // the count the rider produces should match it exactly too.
    expect(apps).toBe(corners);
    // the applications that do happen are real ones, not 2 % flickers
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, ch.brake[i]);
    expect(peak).toBeGreaterThan(50);
  });

  it('brakes at most once per corner on a fixture with a known, controlled corner count', () => {
    // `circuitTrack()` is a real solved lap, which is the right fixture for
    // the measurement above but leaves the exact shape of each corner's
    // chatter up to the solver's noise. This fixture is the inverse: the
    // longG trace is handwritten, so the corner count AND the chatter inside
    // each corner are both exactly known. Each of `corners` braking zones is
    // built from three real sub-applications (g = -1.0, well past the 12 %
    // ON level) separated by two brief 0.5 s dips to g = 0 — long enough that
    // the demand low-pass (tau 0.12 s) actually carries the filtered level
    // below the 4 % OFF threshold inside the gap (a shorter dip would be
    // swallowed by the low-pass alone and never exercise the merge logic at
    // all — the first version of this fixture used 0.2 s and passed against
    // the UN-merged implementation too, for exactly that reason), but still
    // under MERGE_GAP_S (0.8 s) so the event layer merges it back into one
    // application. Corners are separated by a 1.5 s throttle zone,
    // comfortably longer than MERGE_GAP_S so they are never merged into
    // each other.
    const corners = 6;
    const dtS = 0.01;
    const subRunLen = 40; // 0.4 s of real braking
    const microGapLen = 50; // 0.5 s dip: past the low-pass alone, under MERGE_GAP_S
    const throttleLen = 150; // 1.5 s, well over MERGE_GAP_S
    const subRuns = 3;
    const leadInLen = 100; // 1 s of neutral throttle before the first corner, so the
    // edge-counting below (which does not wrap) sees a real 0->on transition
    // for every corner, including the first — without it, corner 1 would
    // start "already braking" at sample 0 and be silently undercounted.
    const perCorner = subRuns * subRunLen + (subRuns - 1) * microGapLen + throttleLen;
    const n = leadInLen + corners * perCorner;
    const points: LngLat[] = Array.from({ length: n }, () => [23.518, 41.073] as LngLat);
    const longG = new Float32Array(n);
    const tS = new Float64Array(n);
    for (let i = 0; i < leadInLen; i++) longG[i] = 0.6;
    for (let c = 0; c < corners; c++) {
      let i = leadInLen + c * perCorner;
      for (let r = 0; r < subRuns; r++) {
        for (let k = 0; k < subRunLen; k++) longG[i++] = -1.0;
        if (r < subRuns - 1) for (let k = 0; k < microGapLen; k++) longG[i++] = 0;
      }
      for (let k = 0; k < throttleLen; k++) longG[i++] = 0.6;
    }
    for (let i = 0; i < n; i++) tS[i] = i * dtS;
    const line: Line = {
      points, curvature: new Float32Array(n), cumDistM: new Float64Array(n),
      lengthM: n, offsetM: new Float32Array(n),
    };
    const env: Envelope = {
      v: new Float32Array(n).fill(40), longG, latG: new Float32Array(n),
      leanDeg: new Float32Array(n), gripUse: new Float32Array(n), tS, lapTimeS: n * dtS,
    };
    const ch = riderChannels(line, env, P);
    let apps = 0;
    for (let i = 1; i < n; i++) if (ch.brake[i - 1] <= 0 && ch.brake[i] > 0) apps++;
    // the fixture has `corners` braking zones and nothing else, built from
    // `subRuns` raw sub-applications each — a channel with no event-merging
    // would read `corners * subRuns` applications, not `corners`
    expect(apps).toBe(corners);
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, ch.brake[i]);
    expect(peak).toBeGreaterThan(60);
  });

  it('never drives and brakes meaningfully at once, except during the trail-brake release', () => {
    // The other half of the oscillation the user described: not just
    // repeated brake applications, but throttle and brake both reading a
    // real value at the same sample. A little overlap is correct — the
    // trail-brake release, where the brake is bleeding off a corner's peak
    // while the throttle is already rising for the exit — so this does not
    // assert zero overlap, which a dead channel would also satisfy. It
    // asserts the overlap stays rare and small on a full solved lap with
    // scatter, where the un-suppressed channel overlapped on 68 of 1600
    // samples (4.25 %).
    const { track, corridor } = circuitTrack(6, 2, 0.25);
    const line = buildLine(track, corridor, P);
    const env = solve(line, P);
    const ch = riderChannels(line, env, P);
    const TRICKLE = 5;
    let overlapSamples = 0;
    let maxSum = 0;
    for (let i = 0; i < ch.tps.length; i++) {
      if (ch.tps[i] > TRICKLE && ch.brake[i] > TRICKLE) {
        overlapSamples++;
        maxSum = Math.max(maxSum, ch.tps[i] + ch.brake[i]);
      }
    }
    expect(overlapSamples).toBeGreaterThan(0);
    expect(overlapSamples).toBeLessThanOrEqual(10);
    // and even during that overlap the throttle never exceeds what the brake
    // leaves it — the OVERLAP clamp's actual bound, not the `< 101` on the raw
    // sum, which the clamp makes unreachable on its own (see T4)
    expect(maxSum).toBeLessThanOrEqual(100 + 1e-3);
  });

  it('drops a braking run too short for a rider to have made', () => {
    // Deferred #7: MIN_EVENT_S (0.15 s) never fired on any fixture — setting it
    // to 0 left all 113 sim tests passing, so an unverified filter sat in the
    // brake path. Getting a run UNDER 0.15 s past the dead-band is delicate,
    // because the hysteresis keeps a run alive until the filtered demand falls
    // below BRAKE_OFF_PCT (4 %) and that release is itself a 0.12 s exponential:
    // from the 12 % ON level down to 4 % takes 0.12*ln(3) = 0.133 s on its own.
    // So the run has to cross ON by the smallest possible margin and stop
    // immediately: two samples of 79 % demand at 100 Hz put the filtered demand
    // at 12.13 %, just over ON, and the decay back under OFF then takes 0.133 s,
    // for a total run of 0.14 s.
    const dtS = 0.01;
    const mkRun = (len: number, level: number) => {
      const n = 200;
      const points: LngLat[] = Array.from({ length: n }, () => [23.518, 41.073] as LngLat);
      const longG = new Float32Array(n);
      const tS = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        longG[i] = i >= 1 && i <= len ? -level * P.rider.brakingG : 0;
        tS[i] = i * dtS;
      }
      const line: Line = {
        points, curvature: new Float32Array(n), cumDistM: new Float64Array(n),
        lengthM: n, offsetM: new Float32Array(n),
      };
      const env: Envelope = {
        v: new Float32Array(n).fill(40), longG, latG: new Float32Array(n),
        leanDeg: new Float32Array(n), gripUse: new Float32Array(n), tS, lapTimeS: n * dtS,
      };
      return riderChannels(line, env, P);
    };
    // 0.14 s of run: under MIN_EVENT_S, so no lever movement at all
    const tooShort = mkRun(2, 0.79);
    expect(Math.max(...Array.from(tooShort.brake))).toBe(0);
    // one more sample of the same demand carries the run to 0.17 s, past
    // MIN_EVENT_S, and the brake is applied. The two fixtures differ by a
    // single sample, so this pins the threshold rather than merely bracketing
    // it: with MIN_EVENT_S at 0 the first case applies the brake too.
    const longEnough = mkRun(3, 0.79);
    expect(Math.max(...Array.from(longEnough.brake))).toBeGreaterThan(10);
  });

  it('ignores a trivial lift but answers a real deceleration', () => {
    // The dead-band, in isolation. 0.1 g of deceleration against a 1.1 g
    // rider is 9 % of peak braking — a closed throttle supplies that, and a
    // rider does not touch the lever for it. 1.0 g is a braking zone.
    const mk = (g: number): { line: Line; env: Envelope } => {
      const n = 400;
      const dtS = 0.01;
      const points: LngLat[] = Array.from({ length: n }, () => [23.518, 41.073] as LngLat);
      const longG = new Float32Array(n);
      const tS = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        longG[i] = i < 100 ? 0 : g;
        tS[i] = i * dtS;
      }
      return {
        line: {
          points, curvature: new Float32Array(n), cumDistM: new Float64Array(n),
          lengthM: n, offsetM: new Float32Array(n),
        },
        env: {
          v: new Float32Array(n).fill(40), longG, latG: new Float32Array(n),
          leanDeg: new Float32Array(n), gripUse: new Float32Array(n), tS, lapTimeS: n * dtS,
        },
      };
    };
    const lift = mk(-0.1);
    const liftCh = riderChannels(lift.line, lift.env, P);
    expect(Math.max(...Array.from(liftCh.brake))).toBe(0);

    const real = mk(-1.0);
    const realCh = riderChannels(real.line, real.env, P);
    expect(Math.max(...Array.from(realCh.brake))).toBeGreaterThan(60);
  });

  it('latches the brake through a slow demand oscillation across the ON level', () => {
    // HYSTERESIS specifically, which the low-pass cannot stand in for: this
    // demand swings slowly enough (0.5 Hz against the 0.12 s filter) that the
    // filter passes ~90 % of it. It crosses the 12 % ON level once per cycle
    // but never falls near the 4 % OFF level, so the brake must go on once and
    // stay on. With a single threshold it would release and re-apply on every
    // one of the ten cycles.
    const n = 1000;
    const dtS = 0.01;
    const { line, env } = constantDemand(n, dtS, (t) => -(0.12 + 0.04 * Math.sin(Math.PI * t)));
    const ch = riderChannels(line, env, P);
    let apps = 0;
    for (let i = 1; i < n; i++) if (ch.brake[i - 1] <= 0 && ch.brake[i] > 0) apps++;
    expect(apps).toBeLessThanOrEqual(1);
    // and it really is braking, so the count is not trivially low
    expect(Math.max(...Array.from(ch.brake))).toBeGreaterThan(8);
  });

  it('low-passes a sample-to-sample demand instead of answering every sample', () => {
    // THE LOW-PASS specifically, which hysteresis cannot stand in for: the
    // demand alternates between nothing and 0.35 g on consecutive samples, so
    // it goes below the 4 % OFF level every other sample and the dead-band
    // releases however wide its gap is.
    //
    // What distinguishes the two is the RIPPLE, not the level: unfiltered, the
    // rate limiter chases a target that reverses every sample and the channel
    // saws by its full per-sample allowance (6.5 % at the default
    // trailBrakeProfile); filtered, the target itself only ripples by about
    // 1.3 % and the channel follows it smoothly.
    const n = 600;
    const dtS = 0.01;
    const { line, env } = constantDemand(n, dtS, (t) => (Math.round(t / dtS) % 2 === 0 ? 0 : -0.35));
    const ch = riderChannels(line, env, P);
    let worstStep = 0;
    let lowest = Infinity;
    for (let i = Math.floor(n / 2); i < n; i++) {
      worstStep = Math.max(worstStep, Math.abs(ch.brake[i] - ch.brake[i - 1]));
      lowest = Math.min(lowest, ch.brake[i]);
    }
    expect(worstStep).toBeLessThan(2);
    // and it is really braking, so a dead channel cannot pass
    expect(lowest).toBeGreaterThan(8);
  });
});
