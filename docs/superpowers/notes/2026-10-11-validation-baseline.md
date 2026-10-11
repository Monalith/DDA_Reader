# Validation baseline: the v1 simulator against spec v2 §4(b)

2026-10-11, W4 Task 4.1. Harness: `dda_lab/scripts/sim-validate.ts`
(metrics in `scripts/lib/cornerMetrics.ts`, trace loading in
`scripts/lib/referenceLap.ts`). Measured on branch `w4-validation-harness`
from `feature/virtual-rider` @ ecaf5e3. That tree still has the **v1**
per-sample rider and solver, so these are the numbers the v2 merge (W1 + W3 +
W6) has to beat. The script exits 1 while any gated row fails, which it does
now.

```
cd dda_lab && npx vite-node scripts/sim-validate.ts            # both _inbox files
cd dda_lab && npx vite-node scripts/sim-validate.ts <ref.json>  # one file
```

(`vite-node` is not a dependency of `dda_lab`. `npx` fetches vite-node 6.0.0
on first use, and that version runs these scripts unchanged.)

## How both laps are measured

- **Same grid, same functions.** The reference file's `telemetri_1m` is
  already on a 1 m grid. The simulated `Session` (10 Hz) is resampled onto
  1 m of `lap_dist`. Both go through `cornerMetrics()`.
- **Corner sections** use spec §2.4 on the *measured* speed: local minima with
  prominence ≥ max(8 km/h, 5 %·v). Neighbours merge when the recovery between
  them is under that threshold or their gap is < v²/(2·0.5·μ·g), with μ = 1.33.
  A section counts as **braked** when its tyre g (total + aero/rolling loss,
  `lossDecelMs2`) stays under −0.20 g for ≥ 0.3 s between entry and apex
  (R3 §3.2, B row). Real losses use the 1000 preset for the BMW file and the
  600 preset for the R6 file. The sim uses its own machine.
- **Build** runs from −0.1 g to 90 % of the zone's tyre peak, with crossing
  times interpolated (R3 §6.2 step 3). **Rate** is 0.8·|peak| over the
  10→90 % rise, the same definition as `gTraceMetrics.riseRateGps`.
- **long_g p25** is the 25th percentile of the negative *total* long_g
  samples on the 1 m grid. The artefact spans (BMW 360–384 m, R6 1645–1685 m)
  are bridged linearly in `boylamsal_g`.
- **t_pick** is the first time in [A−1 s, A+3 s] at which tps > 10 % and holds
  for 0.3 s (never more than 5 points below its pick-up value), minus t(A).
  **Roll-on** is the time from tps passing 20 % to passing 90 %, searched up
  to the next apex. Corners where 90 % is never reached are skipped.
- **Min-speed RMSE**: each real apex is paired with the nearest unused sim
  apex by lap fraction (window 2 % of the lap). Unmatched apexes are listed
  and left out of the RMSE.
- The sim runs **without a corridor**, so `buildLine` uses its 5 m half-width
  fallback. That is the `simSerres.test.ts` setup. The browser path with the
  extracted corridor is about 0.9 s slower (80.47 s,
  notes/2026-10-10-virtual-vs-real.md).

## Baseline: BMW, `serres_BMW_1-19-81.json`

| metric | real | sim (v1) | target | verdict |
|---|---|---|---|---|
| lap time, s (error) | 79.79 | 79.53 (−0.25) | \|err\| ≤ 0.5 | PASS |
| braked corner sections (speed + tyre g) | 7 | 10 | 7–14 | PASS |
| brake applications (sim `brake` ≥ 5 %) | — | 13 | 7–14 | PASS |
| corner min-speed RMSE, km/h (9/10 matched; bias) | — | 6.7 (−2.4) | ≤ 5 | **FAIL** |
| brake build −0.1 g → 90 % peak, s (median) | 0.32 | 0.25 | 0.3–0.5 | **FAIL** |
| brake build rate 10–90 %, g/s (median) | 1.7 | 2.6 | — | info |
| tyre brake peak, g (median / deepest) | −0.65 / −0.98 | −0.85 / −0.85 | — | info |
| long_g p25 (braking samples), g | −0.70 | −0.95 | −0.70 ± 0.10 | **FAIL** |
| t_pick − t_apex, s (median; n) | no tps | 0.31 (10) | — | info |
| roll-on tps 20 → 90 %, s (median; n) | no tps | 1.61 (7) | — | info |

| real apex s, m | real min km/h | sim apex s, m | sim min km/h | Δ km/h |
|---|---|---|---|---|
| 440 | 103.3 | 472 | 102.0 | −1.3 |
| 576 | 108.9 | 591 | 105.2 | −3.7 |
| 803 | 134.0 | 819 | 116.8 | **−17.2** |
| 1063 | 70.1 | 1047 | 67.4 | −2.7 |
| 1235 | 103.2 | 1193 | 104.3 | +1.1 |
| 1369 | 112.9 | 1313 | 112.9 | +0.0 |
| 1709 | 79.2 | 1633 | 79.8 | +0.6 |
| 2017 | 89.9 | 1961 | 84.0 | −5.9 |
| 2513 | 117.9 | unmatched | — | — |
| 2758 | 107.1 | 2615 | 114.1 | +7.0 |

## Baseline: R6, `serres_R6_1-19-849.json`

| metric | real | sim (v1) | target | verdict |
|---|---|---|---|---|
| lap time, s (error) | 79.80 | 79.53 (−0.27) | \|err\| ≤ 0.5 | PASS |
| braked corner sections (speed + tyre g) | 6 | 10 | 7–14 | PASS |
| brake applications (sim `brake` ≥ 5 %) | — | 13 | 7–14 | PASS |
| corner min-speed RMSE, km/h (6/7 matched; bias) | — | 5.0 (−2.7) | ≤ 5 | PASS |
| brake build −0.1 g → 90 % peak, s (median) | 0.65 | 0.25 | 0.3–0.5 | **FAIL** |
| brake build rate 10–90 %, g/s (median) | 1.1 | 2.6 | — | info |
| tyre brake peak, g (median / deepest) | −0.78 / −0.94 | −0.85 / −0.85 | — | info |
| long_g p25 (braking samples), g | −0.66 | −0.95 | −0.70 ± 0.10 | **FAIL** |
| t_pick − t_apex, s (median; n real/sim) | −0.22 (7) | 0.31 (10) | real ± 0.3 | **FAIL** |
| roll-on tps 20 → 90 %, s (median; n real/sim) | 3.26 (6) | 1.61 (7) | real ± 0.3 | **FAIL** |

| real apex s, m | real min km/h | sim apex s, m | sim min km/h | Δ km/h |
|---|---|---|---|---|
| 432 | 104.5 | 472 | 102.0 | −2.5 |
| 1059 | 71.5 | 1047 | 67.4 | −4.1 |
| 1239 | 114.4 | 1193 | 104.3 | −10.1 |
| 1699 | 80.7 | 1633 | 79.8 | −0.9 |
| 2030 | 86.8 | 1961 | 84.0 | −2.8 |
| 2494 | 123.5 | unmatched | — | — |
| 2740 | 110.0 | 2615 | 114.1 | +4.1 |

## Reading the baseline

1. **The spec's "v1" column is stale.** Spec §4(b) quotes 16 brake events and
   a 0.02–0.07 s build for v1. Both figures predate the brake-rate limit and
   loss term that `2026-10-11-longitudinal-g.md` added. The v1 currently in
   the tree has a **0.25 s** build: 0.85 g at `brakeRiseGps` 2.8 g/s, so
   (0.765 − 0.1)/2.8 ≈ 0.24 s. It has **13** brake-channel applications and
   10 braked sections. It still misses the 0.3–0.5 s band, because the v1
   rider ramps at the measured *maximum* rate in every zone. The real median
   rate is 1.7 g/s (BMW) and 1.1 g/s (R6), against 2.6 in the sim. Only the
   hardest zone on each real lap builds at 2.7–2.8 g/s.
2. **long_g p25 −0.95 against −0.70/−0.66.** This is the quasi-steady-state
   solver braking at its ceiling in every zone. The longitudinal-g note §5
   predicted it, and it is what the v2 event template plus R-scaled `sBrake`
   has to fix. The deepest real tyre peaks (−0.98 BMW, −0.94 R6) are *above*
   the sim's flat −0.85, while the real medians (−0.65, −0.78) are below it.
3. **Corner speed: geometry, not the rider.** BMW K3 (803 m) is −17 km/h and
   accounts for most of the 6.7 km/h RMSE. Without it the BMW RMSE is about
   3.7 km/h. This is the fast-corner radius deficit of
   notes/2026-10-10-virtual-vs-real.md §1–2: the hand-placed reference line
   is noisy, so its curvature is unreliable. The spec says this gap "stays,
   reported". The 2513/2494 m apex (118–124 km/h) has **no** sim apex
   within 2 % of the lap. The sim takes that section without a speed minimum
   of ≥ 8 km/h prominence.
4. **The two reference files segment differently.** The R6 has 7 sections and
   the BMW has 10. The R6's dips at 539, 796 and 1363 m are only
   4.5–6.9 km/h deep, below the 8 km/h prominence. Either that rider carries
   more speed there, or the ±3 km/h overlay read smooths the dips. The
   threshold is the spec's and was **not** tuned to make the two files agree.
5. **R6 throttle.** The real rider picks up the throttle *before* the speed
   apex (median −0.22 s). The v1 sim picks up 0.31 s after it. The real
   roll-on is slow, 3.26 s from 20 to 90 %, because there is a long
   part-throttle phase on the exits. The v1 sim takes 1.61 s. Both rows feed
   `throttleDelayS` and `rollOnS` in `DERIVE_TABLE`. The Ducati
   identification (`2026-10-11-ducati-identification.md`) is the
   owner-specific counterpart.
6. **Real build: R6 0.65 s vs BMW 0.32 s.** The R6's speed is an overlay read
   at ±3 km/h and is smoother, and smoothing lengthens an edge (the
   longitudinal-g note §3). The BMW figure is the better build reference. Both
   files are an *upper bound* on the true build.

## Reference-side guards

`tests/unit/simSerres.test.ts`, block "the validation harness reading the
reference laps", pins the **real** column: BMW 10 sections / 7 braked / median
build 0.25–0.45 s / p25 in (−0.75, −0.65) / slowest apexes 70 and 79 km/h, and
an R6 pick-up median within ±0.6 s of the apex. If one of those changes, the
way the harness reads the files changed, and every number above has to be
re-measured. The sim column is deliberately **not** pinned there, because the
merge is expected to move it.
