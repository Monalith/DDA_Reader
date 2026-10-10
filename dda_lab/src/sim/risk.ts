// The one thing the simulator has to refuse to report quietly: a parameter
// combination whose lap time is only reachable by asking the tyre for more
// grip than it has.
//
// Kept out of the panel so it can be measured in a node test. The panel only
// renders what this returns.

/**
 * Fraction of the friction circle above which `grip_use` is reported as an
 * overload.
 *
 * The solver's three passes hold `grip_use` at or under 1 BY CONSTRUCTION: the
 * lateral limit caps `v` at `sqrt(aLatMax * r)`, and both longitudinal passes
 * spend only what the friction ellipse leaves. What is left above 1 is
 * discretisation, not physics — `grip_use` combines point quantities computed
 * from a velocity profile whose passes evaluate the ellipse at the neighbouring
 * sample, so a corner whose curvature changes between two samples reads
 * slightly high.
 *
 * Measured on the 3044 m synthetic circuit at a 2 m sampling with 0.25 m of
 * centerline scatter, over all five machine presets and a 225-point sweep of
 * `mu` 0.4-1.8 x `brakingG` 0.3-1.8 x `trailBrakeDepth` 0-1 x `leanUsage`
 * 0.6-1.0: the worst peak anywhere was **1.0072**. On the real Serres
 * centerline at the shipped defaults it is 1.0006.
 *
 * 1.05 is therefore ~7x the worst measured discretisation residual, and far
 * below anything a genuine overload would produce. The previous 0.98 fired on
 * the shipped defaults (peak 1.0164, 5.5 % of samples) — a permanent false
 * alarm, which is worse than no banner because it makes a real one
 * indistinguishable.
 */
export const GRIP_WARN = 1.05;

/**
 * Warning text for a `grip_use` channel, or null when there is nothing to warn
 * about. The percentage of the lap is counted against the SAME threshold as the
 * peak, so the two numbers in the message describe one condition.
 */
export function gripRiskMessage(gripUse: ArrayLike<number> | undefined | null): string | null {
  if (!gripUse || !gripUse.length) return null;
  let peak = 0;
  let over = 0;
  let finite = 0;
  for (let i = 0; i < gripUse.length; i++) {
    const g = gripUse[i];
    if (!Number.isFinite(g)) continue;
    finite++;
    if (g > peak) peak = g;
    if (g > GRIP_WARN) over++;
  }
  // `peak` only ever rises off 0 on a finite sample, so getting past here
  // guarantees `finite >= 1` and the division below is safe. An all-NaN or
  // empty channel leaves `peak` at 0 and is reported as nothing to warn about,
  // which is correct: there is no lap there to warn about.
  if (peak <= GRIP_WARN) return null;
  const pct = (100 * over) / finite;
  return (
    `Tyre demand peaks at ${(peak * 100).toFixed(0)} % of the friction circle, over ` +
    `${pct < 1 ? pct.toFixed(1) : pct.toFixed(0)} % of the lap. At these settings the front ` +
    `would let go on the brakes — lower the trail brake depth or the braking g.`
  );
}
