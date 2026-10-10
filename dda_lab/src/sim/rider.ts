// The rider lag layer: what the quasi-steady-state envelope cannot say.
//
// The solver gives the speed a perfect actuator would hold. Real telemetry has
// a throttle trace that lags the apex, a brake release that ramps, a traction
// control that cuts torque, and a gearbox. Those are what the chart stack is
// for, so they are modelled here as first-order lags on top of the envelope
// rather than being solved for.
import type { Envelope, Line, SimParams } from './types';
import { clampParams } from './presets';

export interface RiderChannels {
  /** Throttle position, %. */
  tps: Float32Array;
  /** Brake application, %. Separate from tps on purpose — see the rate limits. */
  brake: Float32Array;
  /** Selected gear, 1..n. */
  gear: Float32Array;
  rpm: Float32Array;
  /** Traction-control intervention, % of torque cut. */
  dtc: Float32Array;
}

/**
 * How much brake the rider may still be holding at full throttle, as a
 * multiplier on the brake channel. Above 1 the two are mutually exclusive with
 * margin; at 1 they simply cannot sum past 100 %. Trail braking is a small
 * overlap, not a large one.
 */
const OVERLAP = 1.15;

/**
 * First-order low-pass on the raw demand, seconds, applied BEFORE the rate
 * limiter.
 *
 * The rate limiter is faithful: it reproduces every wiggle the envelope hands
 * it, including the small local speed minima a quasi-steady-state solve leaves
 * behind wherever the curvature is slightly uneven. A 2 km/h dip is a sign
 * change in `longG`, and without this the limiter answers it with a real brake
 * application. A rider does not: the hands follow the trend, not the sample.
 * 0.12 s is the same order as the neuromuscular delay already modelled by
 * `throttleDelayS`, and short enough that a real braking point moves by a
 * couple of metres rather than tens.
 */
const DEMAND_TAU_S = 0.12;

/**
 * Brake dead-band, as a percentage of the rider's own peak braking: a sample
 * only counts toward a braking RUN once the smoothed demand passes `_ON`, and
 * the run ends again only once it falls below `_OFF`.
 *
 * The gap is what stops a single borderline sample from flickering the run
 * boundary, and the absolute level is what stops a trivial lift being
 * reported as braking at all: at the default `brakingG` = 1.1, 12 % is 0.13 g,
 * which a closed throttle supplies on its own. Nobody touches the lever for
 * that.
 *
 * This dead-band alone is NOT what keeps a rider's brake to one application
 * per corner — see `MERGE_GAP_S` below for that. It only decides which raw
 * samples are "braking" before the event layer looks at them.
 */
const BRAKE_ON_PCT = 12;
const BRAKE_OFF_PCT = 4;

/**
 * A rider brakes once per corner: squeeze on, hold, bleed off. Any run of
 * raw braking samples that ends and restarts within `MERGE_GAP_S` is not a
 * second application — it is the same squeeze riding over a shallow local
 * speed minimum the quasi-steady-state envelope leaves behind (see
 * `CURV_SMOOTH_M` in `line.ts`, which removes most but not all of these).
 * The lever was never released in between, so the gap is filled rather than
 * dropped to zero.
 *
 * Chosen by measurement on the 5-corner synthetic circuit
 * (`circuitFixture.ts`, `jitterM = 0.25`): after the existing low-pass and
 * dead-band, the leftover chatter inside one corner has release-to-reapply
 * gaps of 0.22-0.40 s, while the gap between the end of one corner's braking
 * and the start of the next corner's is never under 1.58 s. 0.8 s sits in the
 * middle of that 4x margin, comfortably merging the former without ever
 * merging two distinct corners.
 */
const MERGE_GAP_S = 0.8;

/**
 * Two braking runs are also the same application — whatever the gap between
 * them — when the bike never left the corner in between: the rider did not get
 * back on the throttle (`_THR_PCT`) and the tyre never came off its lateral
 * limit (`_LAT_USE`). That is one squeeze riding over a shallow local speed
 * minimum, not a second grab of the lever.
 *
 * `MERGE_GAP_S` cannot cover this case, because it is a TIME gap and the gap
 * inside a long corner can be longer than the gap between two corners.
 * Measured on the synthetic circuit (`circuitFixture.ts`, `jitterM = 0.25`),
 * which holds its 250 m sweeper at the lateral limit for 390 m:
 *
 *   gap INSIDE one corner:   1.3-1.8 s, peak throttle 8-10 %, lateral 1.19-1.33 g
 *   gap BETWEEN two corners: 1.2-14.8 s, peak throttle 50-100 %, lateral down to 0.00-0.49 g
 *
 * The time gaps overlap completely; the throttle and the lateral load separate
 * cleanly, with about a factor of two of margin either side of both thresholds.
 * Requiring BOTH conditions is what keeps the 50 %-throttle / 0.49 g case —
 * the sweeper exit into the next corner, genuinely a second application —
 * from being swallowed.
 */
const SAME_CORNER_THR_PCT = 25;
const SAME_CORNER_LAT_USE = 0.7;

/**
 * A run shorter than this is a momentary dip answered by the rate limiter
 * and the dead-band already, not a deliberate application a rider would
 * notice. Chosen as roughly the time a rider's hand takes to engage the
 * lever at all; shorter than the fastest `BRAKE_ON_PCT_S` ramp below would
 * ever need to reach a meaningful level.
 */
const MIN_EVENT_S = 0.15;

/** Rolling radius of a 190/55-17 rear, metres. */
const WHEEL_RADIUS_M = 0.31;
const RPM_LIMIT = 14000;
const RPM_MIN = 3500;

export function riderChannels(line: Line, env: Envelope, params: SimParams): RiderChannels {
  const p = clampParams(params);
  const n = line.points.length;
  const tps = new Float32Array(n);
  const brake = new Float32Array(n);
  const gear = new Float32Array(n);
  const rpm = new Float32Array(n);
  const dtc = new Float32Array(n);
  if (!n) return { tps, brake, gear, rpm, dtc };

  // ---- raw demand from the envelope ------------------------------------
  // longG > 0 means driving, < 0 braking. These are the two demands a rider is
  // answering; they are deliberately kept as separate channels, because the
  // interesting part of a lap is what happens BETWEEN them.
  const thrDemand = new Float32Array(n);
  const brkDemand = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const g = env.longG[i];
    thrDemand[i] = g > 0 ? Math.min(100, (g / 0.9) * 100) : 0;
    brkDemand[i] = g < 0 ? Math.min(100, (-g / p.rider.brakingG) * 100) : 0;
  }

  // ---- rate limits: the reason a lap has transitions at all -------------
  //
  // A rider cannot step from 100 % throttle to 100 % brake. Hands and levers
  // move at a finite speed, load transfers onto the front tyre over a real
  // interval, and asking for full brake before that load has arrived is how you
  // tuck the front. So every channel is rate-limited in %/s, asymmetrically,
  // because applying and releasing are not the same action:
  //
  //   - the brake comes ON fast but not instantly (initial bite, then squeeze)
  //   - the brake comes OFF at a rate the two trail-brake sliders set: abrupt
  //     when the rider is done braking at turn-in, a long progressive bleed
  //     when they carry the brakes deep and hard. That release is the whole
  //     craft of trail braking — it is what keeps load on the front while the
  //     bike is turning.
  //
  //     This is a CEILING on how fast the hand can move, not the shape of the
  //     release: the shape now comes out of the envelope, because both sliders
  //     live in `brakeEllipse` in the solver. `trailBrakeDepth` leads the
  //     blend, because depth is what decides how long the lever is still
  //     loaded — a bled-off-over-an-arc release is a slow one — and
  //     `trailBrakeProfile` follows, because a braver rider is still holding
  //     more pressure when the release starts. Neither is the only thing
  //     either parameter does any more, which was the defect: a release-rate
  //     constant cannot move the lap time, so the slider was inert.
  //   - the throttle comes ON slowly (and is additionally delayed by
  //     `throttleDelayS`), because cracking it open at lean is the other way to
  //     crash
  //   - the throttle comes OFF fast; shutting it is a reflex
  //
  // These are estimates of how fast a rider actually moves, not measurements.
  // A later task cross-checks against a real lap and will retune them.
  const BRAKE_ON_PCT_S = 700; // ~0.14 s to full pressure
  const trailBrake = 0.6 * p.rider.trailBrakeDepth + 0.4 * p.rider.trailBrakeProfile;
  const BRAKE_OFF_PCT_S = 1400 - 1250 * trailBrake; // 1400 -> 150
  const THROTTLE_ON_PCT_S = 350; // ~0.3 s to full
  const THROTTLE_OFF_PCT_S = 1200;

  const rateLimit = (prev: number, target: number, dt: number, upPctS: number, downPctS: number): number => {
    const maxStep = (target > prev ? upPctS : downPctS) * dt;
    const delta = target - prev;
    return Math.abs(delta) <= maxStep ? target : prev + Math.sign(delta) * maxStep;
  };

  // ---- demand low-pass and the raw (per-sample) dead-band ---------------
  // Both are pre-passes: they need the full arrays before the event layer
  // below can look ahead and behind a given sample.
  const fThr = new Float32Array(n);
  const fBrk = new Float32Array(n);
  const rawBraking = new Uint8Array(n);
  fThr[0] = thrDemand[0];
  fBrk[0] = brkDemand[0];
  rawBraking[0] = brkDemand[0] >= BRAKE_ON_PCT ? 1 : 0;
  {
    let braking = rawBraking[0] === 1;
    for (let i = 1; i < n; i++) {
      const dt = Math.max(1e-3, env.tS[i] - env.tS[i - 1]);
      const aD = 1 - Math.exp(-dt / DEMAND_TAU_S);
      fThr[i] = fThr[i - 1] + aD * (thrDemand[i] - fThr[i - 1]);
      fBrk[i] = fBrk[i - 1] + aD * (brkDemand[i] - fBrk[i - 1]);
      if (!braking && fBrk[i] >= BRAKE_ON_PCT) braking = true;
      else if (braking && fBrk[i] < BRAKE_OFF_PCT) braking = false;
      rawBraking[i] = braking ? 1 : 0;
    }
  }

  // ---- braking EVENTS, not per-sample levels -----------------------------
  //
  // A rider brakes once per corner: on, hold, bleed off. The per-sample
  // dead-band above answers chattering around a threshold; it does not stop
  // a corner's shallow local speed minima from reading as separate
  // applications, because each one legitimately crosses BOTH the ON and the
  // OFF level on its own. So the raw dead-band runs are merged into events
  // (`MERGE_GAP_S`), tiny leftover runs are dropped (`MIN_EVENT_S`), and each
  // surviving event is reshaped to rise to one peak and bleed off — never a
  // second peak inside the same event.
  const inEvent = new Uint8Array(n);
  const brkTarget = new Float32Array(n); // 0 outside every event

  // 1. raw runs of rawBraking
  const rawRuns: Array<[number, number]> = [];
  {
    let i = 0;
    while (i < n) {
      if (!rawBraking[i]) { i++; continue; }
      let j = i;
      while (j < n && rawBraking[j]) j++;
      rawRuns.push([i, j - 1]);
      i = j;
    }
  }

  // 2. merge runs separated by less than MERGE_GAP_S of time, or by a gap the
  //    bike spent still in the same corner (see SAME_CORNER_*)
  const aLatMaxG = Math.max(
    0.1,
    Math.min(p.tyre.mu * p.tyre.gripScale, Math.tan((p.tyre.maxLeanDeg * p.rider.leanUsage * Math.PI) / 180)),
  );
  /** True when nothing between `a` and `b` (exclusive) looks like leaving the corner. */
  const sameCorner = (a: number, b: number): boolean => {
    let any = false;
    for (let i = a + 1; i < b; i++) {
      any = true;
      if (fThr[i] >= SAME_CORNER_THR_PCT) return false;
      if (Math.abs(env.latG[i]) / aLatMaxG <= SAME_CORNER_LAT_USE) return false;
    }
    return any;
  };
  const mergedRuns: Array<[number, number]> = [];
  for (const run of rawRuns) {
    const last = mergedRuns[mergedRuns.length - 1];
    if (last && (env.tS[run[0]] - env.tS[last[1]] < MERGE_GAP_S || sameCorner(last[1], run[0]))) last[1] = run[1];
    else mergedRuns.push([run[0], run[1]]);
  }

  // 3. drop runs shorter than MIN_EVENT_S, and shape the survivors
  for (const [s, e] of mergedRuns) {
    if (env.tS[e] - env.tS[s] < MIN_EVENT_S) continue;
    const len = e - s + 1;
    const level = new Float32Array(len);
    // fill: a raw sample keeps its own smoothed demand; a gap sample (one
    // that fell briefly below the dead-band inside a merged run) is linearly
    // interpolated between its enclosing raw samples — the lever was never
    // actually released, so the level never drops to zero in between.
    for (let i = s; i <= e; i++) {
      if (rawBraking[i]) { level[i - s] = fBrk[i]; continue; }
      let pi = i - 1;
      while (pi >= s && !rawBraking[pi]) pi--;
      let ni = i + 1;
      while (ni <= e && !rawBraking[ni]) ni++;
      const pv = pi >= s ? fBrk[pi] : fBrk[s];
      const nv = ni <= e ? fBrk[ni] : fBrk[e];
      const pt = pi >= s ? env.tS[pi] : env.tS[s];
      const nt = ni <= e ? env.tS[ni] : env.tS[e];
      const frac = nt > pt ? (env.tS[i] - pt) / (nt - pt) : 0;
      level[i - s] = pv + frac * (nv - pv);
    }
    // monotone shape: non-decreasing up to the peak, non-increasing after —
    // no second peak inside one event. The release RATE CEILING is still
    // governed by the two trail-brake sliders, in the rate limiter below;
    // this only removes a re-rise in the TARGET it is tracking.
    let peakOff = 0;
    for (let k = 1; k < len; k++) if (level[k] > level[peakOff]) peakOff = k;
    let running = 0;
    for (let k = 0; k <= peakOff; k++) {
      running = Math.max(running, level[k]);
      level[k] = running;
    }
    running = level[peakOff];
    for (let k = peakOff + 1; k < len; k++) {
      running = Math.min(running, level[k]);
      level[k] = running;
    }
    for (let i = s; i <= e; i++) {
      inEvent[i] = 1;
      brkTarget[i] = level[i - s];
    }
  }

  // No throttle inside a braking event, beyond the small trail-brake overlap
  // the OVERLAP clamp still allows on the way out: zeroing the FILTERED
  // throttle demand (rather than the raw per-sample one) means a positive
  // longG blip inside a merged event's gap cannot restart the throttle lag
  // early, which is the other half of the throttle/brake oscillation the
  // per-sample dead-band could not stop on its own.
  for (let i = 0; i < n; i++) if (inEvent[i]) fThr[i] = 0;

  // ---- throttle lag, then both channels through their rate limits -------
  // The lag is in seconds, so it is applied against the envelope's own time
  // vector: the same delay costs more samples where the bike is slow.
  const tau = Math.max(1e-3, p.rider.throttleDelayS);
  let lagged = fThr[0];
  let thr = thrDemand[0];
  let brk = brkDemand[0];
  for (let i = 0; i < n; i++) {
    const dt = i === 0 ? 0.01 : Math.max(1e-3, env.tS[i] - env.tS[i - 1]);
    const alpha = 1 - Math.exp(-dt / tau);

    lagged = fThr[i] < lagged ? fThr[i] : lagged + alpha * (fThr[i] - lagged);

    brk = rateLimit(brk, brkTarget[i], dt, BRAKE_ON_PCT_S, BRAKE_OFF_PCT_S);
    thr = rateLimit(thr, lagged, dt, THROTTLE_ON_PCT_S, THROTTLE_OFF_PCT_S);

    // Mutual exclusion. A rider can hold a trickle of throttle against the
    // brakes, but not drive and stop at once: the throttle available is what is
    // left after the brake has taken its share, with a little overlap allowed.
    const allowance = Math.max(0, 100 - OVERLAP * brk);
    thr = Math.min(thr, allowance);

    tps[i] = Math.min(100, Math.max(0, thr));
    brake[i] = Math.min(100, Math.max(0, brk));
  }

  // ---- gear and rpm -----------------------------------------------------
  const ratios = p.machine.gearRatios;
  const top = ratios.length;
  // speed at the rev limit in each gear
  const vAtLimit = ratios.map(
    (r) => (RPM_LIMIT * 2 * Math.PI * WHEEL_RADIUS_M) / (60 * r * p.machine.finalDrive),
  );
  for (let i = 0; i < n; i++) {
    let g = 1;
    while (g < top && env.v[i] > vAtLimit[g - 1]) g++;
    gear[i] = g;
    const rev = (env.v[i] * 60 * ratios[g - 1] * p.machine.finalDrive) / (2 * Math.PI * WHEEL_RADIUS_M);
    rpm[i] = Math.min(RPM_LIMIT, Math.max(RPM_MIN, rev));
  }

  // ---- traction control -------------------------------------------------
  // TC cuts when the drive demand plus the lateral demand would exceed what the
  // threshold allows. A low threshold means an intrusive system.
  const allowed = 0.55 + 0.45 * p.rider.tcThreshold;
  const aLatMax = Math.max(
    0.1,
    Math.min(p.tyre.mu * p.tyre.gripScale, Math.tan((p.tyre.maxLeanDeg * p.rider.leanUsage * Math.PI) / 180)),
  );
  for (let i = 0; i < n; i++) {
    if (env.longG[i] <= 0) continue; // braking or coasting: nothing to cut
    const latUse = Math.min(1, Math.abs(env.latG[i]) / aLatMax);
    const longUse = Math.min(1, env.longG[i] / (p.tyre.mu * p.tyre.gripScale));
    const total = Math.hypot(latUse, longUse);
    if (total > allowed) dtc[i] = Math.min(100, ((total - allowed) / Math.max(0.05, 1 - allowed)) * 100);
  }

  return { tps, brake, gear, rpm, dtc };
}
