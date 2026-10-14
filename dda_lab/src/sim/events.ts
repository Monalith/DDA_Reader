// Corner-event template (spec v2 §2.5, research R3 §4).
//
// The QSS envelope is the speed a perfect actuator could hold. A rider makes
// ONE brake and ONE throttle transition per corner section (owner constraint
// #1), with finite rates, so the lap is built here from events instead:
//
//   ... full throttle ──► throttle closes and the brake builds at J_b
//   (B: brake point) ──► plateau at the brake cap ──► release, tapered by the
//   cap's trail-brake share and rate-limited at J_b into the apex ──► A:
//   maintenance throttle (a_x = 0, drag compensated) for `throttleDelayS`
//   after the apex plateau ──► P: roll-on to the drive cap over `rollOnS`
//   (smoothstep) ──► full throttle, NEVER closed again before the next B.
//
// The brake point B is found by shooting: the throttle-close / brake-build
// curve is started on the previous section's drive curve and the start is
// bisected until the curve arrives at the apex speed. The shot rides down
// onto the LATEST approach `vb` (built backward from the apex with the same
// cap, release limit, build-from-brake-on and one-application lock), which
// keeps the arrival speed monotone in the start point. The template's own
// joins are C¹ (the tyre force is continuous; only its rate steps). The
// result is clipped to the QSS envelope, v ≤ env.v, which stays the physical
// upper bound (ellipse, stoppie, wheelie, power, roll rate); where the
// template meets that bound it inherits the bound's own kinks (the v1
// solver steps from drive to braking at its brake-on).
//
// The tyre caps are INJECTED (`EventCaps`): `index.ts` passes the solver's
// `brakeCapMs2` / `driveCapMs2` / `lossDecelMs2`. The trail-brake release
// lives inside `brakeCapMs2` (it is `ellipse · brakeShare(latUse, depth,
// profile)`, contract §solver.ts), so it is not applied a second time here.
import { PROM_FRAC, PROM_MIN_MS } from './corners';
import { clampParams } from './presets';
import { G } from './solver';
import type { Corner, Envelope, Line, RiderParams, SimParams } from './types';

export interface EventProfile {
  /** Speed along the line, m/s; `min(v_event, env.v)`. */
  v: Float32Array;
  /** Brake, 0..100: tyre braking deceleration as a share of the lap's peak brake cap. */
  brake: Float32Array;
  /** Throttle, 0..100. */
  tps: Float32Array;
  /** Elapsed time at each sample, s, recomputed from `v`. */
  tS: Float64Array;
  lapTimeS: number;
  /**
   * The input sections with the template's own event points: `iB` is where
   * the brake starts (= `iT` without a brake), `iP` the throttle pick-up,
   * `iE` clamped to before the next section's throttle close, `hasBrake`
   * false when the template needed no brake at all. Use THESE, not the
   * `findCorners` output, for markers and for counting brake events.
   */
  corners: Corner[];
}

export interface EventCaps {
  /** Tyre braking deceleration available at sample i and speed v, m/s², WITHOUT drag (includes the trail-brake share). */
  brakeCapMs2(i: number, vMs: number): number;
  /** Drive acceleration available at sample i and speed v, m/s², WITHOUT drag. */
  driveCapMs2(i: number, vMs: number): number;
  /** Aero + rolling deceleration at speed v, m/s². */
  lossDecelMs2(vMs: number): number;
}

/**
 * Maintenance throttle, %: what holds speed against drag between the apex and
 * the pick-up. Source: plan W3 Task 3.2 ("maintenance 8 %"), R3 §4.2
 * (Champions School ~2 s neutral-throttle window); öneri.
 */
const TPS_MAINT = 8;

/**
 * A brake trace whose peak is under this share is not an application: the
 * section is re-solved as a throttle lift. Matches the 5 % rise level the
 * brake-count tests and `cornerMetrics` use; öneri.
 */
const BRAKE_MIN_PCT = 5;

/**
 * The apex PLATEAU: samples within this of the apex speed are "at the apex"
 * (a long sweeper held at the lateral limit drifts down a fraction of a m/s
 * as drag eats the speed the ellipse cannot replace). The brake must be done
 * where the plateau starts, and the throttle delay counts from where it ends.
 * max(0.3 m/s, 1 %) — öneri, numerical rather than physical.
 */
const PLATEAU_TOL_MS = 0.3;
const PLATEAU_TOL_FRAC = 0.01;

/**
 * A brake that has been above this level and falls back under it is being
 * RELEASED, %, and from then on may only keep falling (no second squeeze in
 * the same section). Above it the pressure is free to follow the trail-brake
 * share, which wobbles with the curvature — a fast bend inside a long braking
 * zone (Serres, before the hairpin) is a modulation of one application, not
 * a second one. Locking at half the peak instead cost 2.5 s there: the bend
 * locked the lever at 36 % for the rest of the zone. öneri — owner constraint
 * #1 made numerical; twice `BRAKE_MIN_PCT`.
 */
const RELEASE_LOCK_PCT = 10;

/** Arrival tolerance at the apex for the brake-point bisection: max(0.1 m/s, 0.5 %). Numerical. */
const ARRIVE_TOL_MS = 0.1;
const ARRIVE_TOL_FRAC = 0.005;

/**
 * How much earlier (in seconds at the apex speed) the exact-arrival brake
 * start may be than the near-arrival one before the near one is used. öneri.
 */
const EARLY_START_MAX_S = 0.5;

/** Fixed-point iterations for the latest approach's own brake build (solver.ts converges in 3-4). */
const VB_BUILD_ITERS = 4;

/** A shot within this of the latest approach `vb` rides it exactly, m/s. Numerical. */
const RIDE_EPS_MS = 0.05;

/** Floor on any speed, m/s; keeps every division finite. */
const V_MIN = 1;
/** Bisection steps on the brake point: 2^-40 of the zone, far below a millimetre. */
const BISECT_ITERS = 40;

const smoothstep = (x: number): number => {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
};

/** How the throttle-close / brake curve may end. */
type Mode = 'brake' | 'coast' | 'maint';

interface Drive {
  /** Sample index of k = 0 (the section's brake target A1). */
  base: number;
  /** Samples to the next section's A1 (n for a single section). */
  L: number;
  pos: Float64Array;
  v: Float64Array;
  /** Tyre longitudinal acceleration, m/s² (drive positive, brake negative). */
  u: Float64Array;
  brake: Float32Array;
  tps: Float32Array;
  /** Throttle pick-up sample (offset from base). */
  kP: number;
}

export function eventProfile(
  line: Line,
  env: Envelope,
  corners: Corner[],
  params: SimParams,
  caps: EventCaps,
  /**
   * Per-corner rider (cornerRider.ts `riderAccessor`): a section's brake
   * build is read at its turn-in (the approach), its throttle delay and
   * roll-on at its exit. Absent = the lap-wide rider for every section.
   */
  riderAt?: (i: number) => RiderParams,
): EventProfile {
  const p = clampParams(params);
  const n = Math.min(line.points.length, env.v.length);
  const v = new Float32Array(n);
  const brake = new Float32Array(n);
  const tps = new Float32Array(n);
  const tS = new Float64Array(n);
  const idx = (k: number): number => ((k % n) + n) % n;
  const fwd = (a: number, b: number): number => (b - a + n) % n;

  // segment length ending at i, wrapping at the start line (as solver.ts)
  const ds = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const d = i === 0 ? line.lengthM - line.cumDistM[n - 1] : line.cumDistM[i] - line.cumDistM[i - 1];
    ds[i] = Math.max(0.05, d);
  }

  const finish = (outCorners: Corner[]): EventProfile => {
    let t = 0;
    for (let i = 0; i < n; i++) {
      tS[i] = t;
      const j = (i + 1) % n;
      t += ds[j] / Math.max(2, (v[i] + v[j]) / 2);
    }
    return { v, brake, tps, tS, lapTimeS: t, corners: outCorners };
  };

  if (n < 3 || !corners.length) {
    // no corner section: nothing to brake for, the bound is the lap
    for (let i = 0; i < n; i++) {
      v[i] = env.v[i];
      tps[i] = 100;
    }
    return finish(corners.map((c) => ({ ...c, flips: [...c.flips] })));
  }

  const J0 = Math.max(0.1, p.rider.brakeRiseGps * G);
  const delay0 = p.rider.throttleDelayS;
  const rollOn0 = Math.max(0.05, p.rider.rollOnS);
  const loss = (vv: number): number => caps.lossDecelMs2(vv);

  // the brake channel's 100 %: the largest tyre braking the caps allow on the lap
  let gbPeak = 0.1;
  for (let i = 0; i < n; i++) gbPeak = Math.max(gbPeak, caps.brakeCapMs2(i, env.v[i]));
  /** Tyre deceleration that counts as a brake application, m/s². */
  const appMin = (BRAKE_MIN_PCT / 100) * gbPeak;
  /** Tyre deceleration under which a brake that was above it counts as released, m/s². */
  const lockLvl = (RELEASE_LOCK_PCT / 100) * gbPeak;

  /** Throttle % for tyre acceleration u at sample i and speed vv. */
  const tpsOf = (u: number, vv: number, i: number): number => {
    const lo = loss(vv);
    if (u <= 0) return 0;
    if (u <= lo) return (TPS_MAINT * u) / Math.max(1e-6, lo);
    const span = caps.driveCapMs2(i, vv) - lo;
    if (span <= 1e-6) return 100;
    return TPS_MAINT + (100 - TPS_MAINT) * Math.min(1, (u - lo) / span);
  };

  // ---- per section: target speed, brake target A1, hold end H --------------
  const cs = [...corners].sort((a, b) => a.iA - b.iA);
  const K = cs.length;
  const isLocalMin = (i: number): boolean => env.v[i] <= env.v[idx(i - 1)] && env.v[i] <= env.v[idx(i + 1)];
  const sec = cs.map((c) => {
    const vT = env.v[c.iA];
    const thr = Math.max(PROM_MIN_MS, PROM_FRAC * vT);
    const tol = Math.max(PLATEAU_TOL_MS, PLATEAU_TOL_FRAC * vT);
    const atApex = (i: number): boolean => env.v[i] <= vT + tol || (isLocalMin(i) && env.v[i] <= vT + thr);
    // A1: the first apex of the section — where the ONE brake must be done
    let a1 = c.iA;
    for (let s = 0, i = c.iT; s <= fwd(c.iT, c.iA); s++, i = idx(i + 1)) {
      if (atApex(i)) {
        a1 = i;
        break;
      }
    }
    // H: the last apex — the throttle delay counts from here
    let h = c.iA;
    for (let s = 0, i = c.iA; s <= fwd(c.iA, c.iE); s++, i = idx(i + 1)) if (atApex(i)) h = i;
    // the section's own rider values (per-corner overrides), else the lap-wide ones
    const rb = riderAt?.(c.iT);
    const rd = riderAt?.(c.iE);
    const J = rb ? Math.max(0.1, rb.brakeRiseGps * G) : J0;
    const delayS = rd ? rd.throttleDelayS : delay0;
    const rollOnS = rd ? Math.max(0.05, rd.rollOnS) : rollOn0;
    return { c, vT, a1, h, J, delayS, rollOnS };
  });

  // ---- drive curve of section c: hold from A1, pick-up, roll-on, full -------
  const drive = (c: number, vH: number): Drive => {
    const { a1, h, delayS, rollOnS } = sec[c];
    const L = K === 1 ? n : fwd(a1, sec[(c + 1) % K].a1) || n;
    const pos = new Float64Array(L + 1);
    const vv = new Float64Array(L + 1);
    const u = new Float64Array(L + 1);
    const tp = new Float32Array(L + 1);
    for (let k = 1; k <= L; k++) pos[k] = pos[k - 1] + ds[idx(a1 + k)];
    vv[0] = Math.max(V_MIN, vH);
    // maintenance hold at vH up to the end of the apex plateau, then the delay
    const tPick = pos[fwd(a1, h)] / vv[0] + delayS;
    let t = 0;
    let kP = L;
    for (let k = 0; k <= L; k++) {
      const i = idx(a1 + k);
      const r = t < tPick ? 0 : smoothstep((t - tPick) / rollOnS);
      if (kP === L && t >= tPick) kP = k;
      const lo = loss(vv[k]);
      const dc = caps.driveCapMs2(i, vv[k]);
      u[k] = r * dc + (1 - r) * lo;
      tp[k] = TPS_MAINT + (100 - TPS_MAINT) * r;
      if (k === L) break;
      const d = pos[k + 1] - pos[k];
      const aNet = r * (dc - lo);
      vv[k + 1] = Math.sqrt(Math.max(V_MIN * V_MIN, vv[k] * vv[k] + 2 * aNet * d));
      t += d / Math.max(V_MIN, 0.5 * (vv[k] + vv[k + 1]));
    }
    return { base: a1, L, pos, v: vv, u, brake: new Float32Array(L + 1), tps: tp, kP };
  };

  // ---- shooting the brake point of section c on the previous drive curve ----
  interface Shot { s0: number; vEnd: number; mode: Mode }
  const shootSection = (c: number, D: Drive): Shot & { rec: (D: Drive) => number } => {
    const { vT, c: corner, J } = sec[c];
    const L = D.L;
    const kLo = Math.min(D.kP, L - 1);
    /**
     * The LATEST approach (backward from A1 at the target speed): brake cap
     * with its trail-brake share, release rate-limited at J into the apex,
     * and the same one-application lock read backward (once the pressure
     * has been up and falls under the lock level further back, it may not
     * rise again further back). `vb` is the floor every shot rides down onto;
     * `tToA` is its time to the apex, which paces the release.
     */
    const backward = (mode: Mode): { vb: Float64Array; tToA: Float64Array } => {
      const vb = new Float64Array(L + 1);
      const tToA = new Float64Array(L + 1);
      // time since vb's own brake-on, from the previous iteration (∞ = no
      // build limit on the first): vb builds at J from where it leaves the
      // drive curve, so a shot that lands on it early is not handed a step
      const tOn = new Float64Array(L + 1).fill(Number.POSITIVE_INFINITY);
      for (let iter = 0; iter < VB_BUILD_ITERS; iter++) {
        vb[L] = vT;
        tToA[L] = 0;
        let peakB = 0;
        let lockB = Number.POSITIVE_INFINITY;
        for (let k = L; k > kLo; k--) {
          const i = idx(D.base + k);
          const lo = loss(vb[k]);
          const cap = mode === 'brake' ? caps.brakeCapMs2(i, vb[k]) : 0;
          const aT = Math.min(cap, J * tToA[k] - lo, J * tOn[k], lockB);
          const b = Math.max(0, aT);
          if (b > peakB) peakB = b;
          if (lockB < Number.POSITIVE_INFINITY || (peakB >= appMin && b < appMin) || (peakB >= lockLvl && b < lockLvl)) {
            lockB = Math.min(lockB, b);
          }
          const d = D.pos[k] - D.pos[k - 1];
          vb[k - 1] = Math.sqrt(vb[k] * vb[k] + 2 * Math.max(0, aT + lo) * d);
          tToA[k - 1] = tToA[k] + d / Math.max(V_MIN, 0.5 * (vb[k] + vb[k - 1]));
        }
        if (iter === VB_BUILD_ITERS - 1) break;
        // brake-on = where vb leaves the drive curve (last crossing walking back)
        let kOn = kLo;
        for (let k = L; k >= kLo; k--) {
          if (vb[k] >= D.v[k]) {
            kOn = k;
            break;
          }
        }
        let t = 0;
        for (let k = 0; k <= L; k++) {
          if (k <= kOn) tOn[k] = 0;
          else {
            t += (D.pos[k] - D.pos[k - 1]) / Math.max(V_MIN, 0.5 * (vb[k] + vb[k - 1]));
            tOn[k] = t;
          }
        }
      }
      return { vb, tToA };
    };
    const back: Partial<Record<Mode, { vb: Float64Array; tToA: Float64Array }>> = {};
    const backFor = (mode: Mode): { vb: Float64Array; tToA: Float64Array } => (back[mode] ??= backward(mode));
    const sLo = D.pos[kLo];
    const sHi = D.pos[L];
    // Riding down `vb` lands a sample-discretisation hair above vT (measured
    // up to 0.09 m/s on Serres); without a tolerance that hair reads as
    // "too fast" for every late start and the bisection settles on a start
    // far too early (a 3 s coast before one Serres corner). The excess is
    // removed by the clip to the envelope.
    const arriveTol = Math.max(ARRIVE_TOL_MS, ARRIVE_TOL_FRAC * vT);

    /**
     * Integrate from s0 to the target. The tyre force falls from the drive
     * curve's value at J (throttle closing, then brake building), bounded
     * below by the brake cap (with its trail-brake share) and by the release
     * rate limit J·(time to the apex). A brake that has been applied and then
     * let go below the application level is locked off: one application by
     * construction. The shot never goes under the latest approach `vb`: when
     * it reaches it, it rides it down (same release law, so the join is
     * tangent), which makes the arrival speed monotone in s0 — an early start
     * arrives at vT rather than stopping short of the apex.
     */
    const shoot = (s0: number, mode: Mode, out?: Drive): number => {
      const { vb, tToA } = backFor(mode === 'maint' ? 'coast' : mode);
      const useFloor = mode !== 'maint';
      let k0 = kLo;
      while (k0 < L - 1 && D.pos[k0 + 1] <= s0) k0++;
      const seg = D.pos[k0 + 1] - D.pos[k0];
      const f = seg > 0 ? Math.min(1, Math.max(0, (s0 - D.pos[k0]) / seg)) : 0;
      const v0 = D.v[k0] + f * (D.v[k0 + 1] - D.v[k0]);
      const u0 = D.u[k0] + f * (D.u[k0 + 1] - D.u[k0]);
      // partial first step at the start state
      let vv = Math.sqrt(Math.max(V_MIN * V_MIN, v0 * v0 + 2 * (u0 - loss(v0)) * (D.pos[k0 + 1] - s0)));
      let tau = (D.pos[k0 + 1] - s0) / Math.max(V_MIN, 0.5 * (v0 + vv));
      let peak = 0;
      let lock = Number.POSITIVE_INFINITY;

      for (let k = k0 + 1; k <= L; k++) {
        const i = idx(D.base + k);
        const lo = loss(vv);
        const cap = mode === 'brake' ? caps.brakeCapMs2(i, vv) : 0;
        const ceil = Math.min(cap, J * tToA[k] - lo, lock);
        const floor = mode === 'brake' ? Number.NEGATIVE_INFINITY : mode === 'coast' ? 0 : lo;
        const dNext = k < L ? D.pos[k + 1] - D.pos[k] : 1;
        // tyre force that lands exactly on vb at the next sample (the shot
        // rides vb once it is on it); when the shot is clearly BELOW vb
        // (started early) it is not pushed up, it just does not brake
        // (throttle closes, coasts) until it meets vb
        const uClose = u0 - J * tau;
        const landVb = lo + (vb[k + 1 <= L ? k + 1 : L] ** 2 - vv * vv) / (2 * dNext);
        const onFloor = useFloor && k < L
          ? (vv >= vb[k] - RIDE_EPS_MS ? landVb : Math.min(landVb, Math.max(uClose, 0)))
          : Number.NEGATIVE_INFINITY;
        const uOwn = Math.max(uClose, -ceil, floor);
        const u = Math.max(uOwn, onFloor);

        // Once the brake has been let go (`RELEASE_LOCK_PCT`, or the
        // application level for a light one) it can only go on falling: ONE
        // application, whatever the cap does later (an earlier apex inside
        // the zone puts a deep dip in the trail-brake share). The shot then
        // simply starts earlier and carries less brake through it. A blip
        // that goes to zero again (the throttle-close overshooting onto vb)
        // also counts as let go, so the bisection rejects that start.
        const b = Math.max(0, -u);
        if (b > peak) peak = b;
        if (lock < Number.POSITIVE_INFINITY || (peak > 0 && peak < lockLvl && b <= 0) || (peak >= appMin && b < appMin) || (peak >= lockLvl && b < lockLvl)) {
          lock = Math.min(lock, b);
        }
        if (out) {
          out.v[k] = vv;
          out.u[k] = u;
          out.brake[k] = Math.min(100, (100 * Math.max(0, -u)) / gbPeak);
          out.tps[k] = tpsOf(u, vv, i);
        }
        if (k === L) break;
        const d = D.pos[k + 1] - D.pos[k];
        const vn = Math.sqrt(Math.max(V_MIN * V_MIN, vv * vv + 2 * (u - lo) * d));
        tau += d / Math.max(V_MIN, 0.5 * (vv + vn));
        vv = vn;
      }
      return vv;
    };

    const solveMode = (mode: Mode): Shot => {
      if (mode === 'maint') {
        // lift at turn-in to maintenance, if T lies on this stretch
        const kT = fwd(D.base, corner.iT);
        const s0 = kT >= kLo && kT <= L ? D.pos[kT] : sHi;
        return { s0, vEnd: shoot(s0, mode), mode };
      }
      const vEndLo = shoot(sLo, mode);
      const fLo = vEndLo - vT;
      /** Latest start whose arrival excess is within tol (bisection; f grows with s0). */
      const latest = (tol: number): Shot => {
        let lo = sLo;
        let hi = sHi;
        let vLo = vEndLo;
        for (let it = 0; it < BISECT_ITERS; it++) {
          const mid = 0.5 * (lo + hi);
          const vm = shoot(mid, mode);
          if (vm - vT > tol) hi = mid;
          else {
            lo = mid;
            vLo = vm;
          }
        }
        return { s0: lo, vEnd: vLo, mode };
      };
      const thr = Math.max(PROM_MIN_MS, PROM_FRAC * vT);
      if (fLo > thr) return { s0: sLo, vEnd: vEndLo, mode }; // cannot shed the speed: clipped later
      const exact = fLo <= arriveTol ? latest(arriveTol) : undefined;
      const near = latest(thr);
      // A one-application approach can be impossible to the exact apex speed
      // when a bend at the lateral limit sits inside the braking zone (the
      // trail-brake share is zero there): the exact solution then coasts for
      // seconds from far back (Serres before T10: 3 s). Arriving up to the
      // corner threshold too fast instead — the clip to the envelope takes
      // the rest, a dip below the brake-event threshold by definition — is
      // what a rider does. Prefer it when the exact start is much earlier.
      if (!exact) return near;
      const vRef = Math.max(V_MIN, vT);
      return near.s0 - exact.s0 > EARLY_START_MAX_S * vRef ? near : exact;
    };

    let shot: Shot;
    const noLiftNeeded = D.v[L] - vT <= 1e-3;
    if (noLiftNeeded) shot = solveMode('maint');
    else if (corner.hasBrake) {
      shot = solveMode('brake');
      // a brake too light to be an application is a lift
      const probe: Drive = { ...D, v: D.v.slice(), u: D.u.slice(), brake: new Float32Array(L + 1), tps: D.tps.slice() };
      shoot(shot.s0, 'brake', probe);
      let peak = 0;
      for (const b of probe.brake) peak = Math.max(peak, b);
      if (peak < BRAKE_MIN_PCT) shot = solveMode('coast');
    } else shot = solveMode('coast');
    const s = shot;
    return {
      ...s,
      rec: (out: Drive): number => {
        shoot(s.s0, s.mode, out);
        let k0 = kLo;
        while (k0 < L - 1 && D.pos[k0 + 1] <= s.s0) k0++;
        return k0;
      },
    };
  };

  // ---- assemble: two rounds so each drive curve starts at its true apex speed
  let vH = sec.map((s) => s.vT);
  let drives = sec.map((_, c) => drive(c, vH[c]));
  let shots = sec.map((_, c) => shootSection(c, drives[(c - 1 + K) % K]));
  // hold at the speed the shot actually arrives with (C0 at A1); the clip to the envelope trims any excess
  const vH2 = shots.map((s) => s.vEnd);
  if (vH2.some((x, c) => Math.abs(x - vH[c]) > 1e-3)) {
    vH = vH2;
    drives = sec.map((_, c) => drive(c, vH[c]));
    shots = sec.map((_, c) => shootSection(c, drives[(c - 1 + K) % K]));
  }
  const closeK = new Array<number>(K); // in the PREVIOUS section's drive: first sample the shot changed
  shots.forEach((s, c) => {
    const D = drives[(c - 1 + K) % K];
    closeK[c] = s.rec(D) + 1;
  });

  for (let c = 0; c < K; c++) {
    const D = drives[c];
    for (let k = 0; k < D.L; k++) {
      const i = idx(D.base + k);
      v[i] = Math.min(Math.max(V_MIN, D.v[k]), env.v[i]);
      brake[i] = D.brake[k];
      tps[i] = Math.min(100, Math.max(0, D.tps[k]));
    }
  }

  // ---- the template's own event points ----------------------------------
  const out: Corner[] = sec.map((s, c) => {
    const corner = s.c;
    const prev = drives[(c - 1 + K) % K];
    const own = drives[c];
    const shot = shots[c];
    let hasBrake = false;
    let iB = corner.iT;
    if (shot.mode === 'brake') {
      for (let k = closeK[c]; k <= prev.L; k++) {
        if (prev.brake[k] > 0) {
          iB = idx(prev.base + k);
          hasBrake = true;
          break;
        }
      }
    }
    const iP = idx(own.base + own.kP);
    // E: no later than the sample before the next section's throttle starts closing
    const kNextClose = closeK[(c + 1) % K] - 1;
    let kE = fwd(own.base, corner.iE);
    if (kE > own.L) kE = own.L;
    kE = Math.max(own.kP, Math.min(kE, kNextClose));
    return { ...corner, iB, iP, iE: idx(own.base + kE), hasBrake, flips: [...corner.flips] };
  });

  return finish(out);
}
