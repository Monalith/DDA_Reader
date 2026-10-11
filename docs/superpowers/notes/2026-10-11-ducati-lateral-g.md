# Ducati owner laps: measured lateral g against the reference-fit rider (2026-10-11)

The question: does the virtual rider's lateral g hold up against real measured data? The data is the
owner's Ducati run `_inbox/Run036-219926-00.00.json`: 10 Hz, 9 flying laps, best lap 6 at 1:35.8. The
comparison is made on the pist Serres geometry, and against the BMW fit of
`2026-10-11-bmw-fit-pist-line.md` §6.

**Report command:** `cd dda_lab && npx vite-node scripts/ducati-lateral.ts [run.json] [--track serres.pist.json] [--json out.json]`.
The defaults are the run and track above. All numbers below come from that script.

## 0. What the channels are

### `accel_lat_g` is not a sensor

`accel_lat_g` equals tan(`lean_angle_deg`) on all 10188 records: max |Δ| 0.0064 (rounding),
correlation 1.0000. dda_core writes it that way, which `scripts/lib/ddaLap.ts` already noted. So the
file has two independent lateral-g measures, not three:

- **(i) v²κ/g from the GPS line.**
  - **κ.** The lap's own GPS path (smoothed fixes, shifted by the 0.16 s GPS lag) on a 1 m grid, with
    heading taken from 10 m chords and differenced over 20 m.
  - **v.** Ground speed. The dash speed cannot be used as it is. Against the windowed, lag-corrected
    GPS speed, wheel/ground = **1.053 + 0.426·(1 − cos φ)** (n 2204, rms 0.032).
    - **Why.** The rear tyre rolls on a smaller radius at lean, so the dash reads 5 % high upright and
      about 18 % high at 45°. Raw dash speed would overstate v²κ by **×1.35** in corners.
    - **Check.** The corrected speed integrates to the GPS lap length within 0.3 % (rescale ×0.997).
- **(ii) tan(lean)** from the PSI IMU.

### How the two compare (best lap, 958 records)

| | value |
|---|---|
| corr(v²κ/g, tan lean), all / cornering (\|tan φ\| > 0.3) | **0.995 / 0.997** |
| peak / p99 \|v²κ/g\| | **1.12 / 1.08 g** |
| peak / p99 tan\|lean\| (= peak \|accel_lat_g\|) | 1.22 / 1.21 g (lean 50.7°) |
| median tan\|φ\| − \|v²κ/g\|, left / right corners | +0.03 / +0.08 g |
| rms(tan\|φ\| − \|v²κ/g\|), cornering | 0.097 g |
| fit tan(\|φ − b\| − c) ≈ \|v²κ/g\| | **b = 0.7°** (signed IMU zero), **c = 2.1°** (bike roll beyond the effective lean); rms after 0.063 g |
| mean lean on fast straights | 2.2° (includes camber and crosswind, so it is not a clean zero: removing it flips the asymmetry to +0.10 / +0.01) |
| κ window 10 / 14 / 20 / 30 m: p99 v²κ/g | 1.12 / 1.10 / 1.08 / 1.07 |

### Which one to trust

**v²κ/g on the GPS line, with ground speed, is the trustworthy measured lateral g.**

- **It is the kinematic definition.** Its only model is the wheel/GPS speed fit, and that closes
  on lap distance.
- **tan(lean) is a roll angle.** It equals lateral g only for a zero-width tyre with no hang-off.
- **tan(lean) cross-checks v²κ/g.** It tracks it at r = 0.997 but reads about 0.055 g high, 5–7 %.
  - **What the gap is.** Exactly what the brief expected: an offset of **~2–3°**. That is 2.1° of
    symmetric extra roll (the tyre's crown rolls the bike past the resultant; the owner's hang-off
    does not cancel it, whereas the panigale preset's 0.25 m hang-off assumes it does) plus a 0.7°
    signed IMU zero.
  - **Calibrated lean g.** tan(|φ − 0.7°| − 2.1°) is used below as the "calibrated lean g".
- **κ smoothing explains little.** Shrinking the window from 20 to 10 m raises p99 by only 0.04 g.

**The owner's measured lateral g is about 1.0–1.13 g per corner, peaking at 1.12 g** (p99 1.08 g).
Raw tan(lean) says 1.22 g, which overstates it by ~0.1 g.

## 1. Measured per corner

Corners are the pist package's 16, matched by position: each pist apex is projected onto the lap's GPS
path, and the lap's own |κ| peak of the corner's direction is taken within ±40 m. Each cell gives the
best lap / the median of the 9 kept laps.

| corner | apex v km/h | v²κ g at apex | v²κ g zone max | tan(lean max) raw | calibrated lean g | lean max ° | apex: inside offset / inner half-width, m (frac; median) | entry / exit outside frac (median) |
|---|---|---|---|---|---|---|---|---|
| K1 R | 88.2 / 87.8 | 0.99 / 1.00 | 0.99 / 1.02 | 0.99 / 1.08 | 0.90 / 0.98 | 44.8 / 47.1 | 4.4 / 7.2 (0.60; 0.53) | 0.21 / 0.23 (0.17 / 0.28) |
| K2 R | 99.6 / 98.6 | 1.03 / 1.02 | 1.06 / 1.05 | 1.22 / 1.21 | 1.10 / 1.09 | 50.6 / 50.4 | 3.2 / 7.2 (0.44; 0.36) | 0.37 / −0.68 (0.39 / −0.57) |
| K3 L | 120.3 / 116.5 | 1.05 / 1.04 | 1.07 / 1.06 | 1.09 / 1.00 | 1.04 / 0.96 | 47.4 / 45.1 | 3.3 / 6.6 (0.49; 0.40) | 0.10 / −0.26 (0.11 / −0.26) |
| K4 L | 129.7 / 121.0 | 0.92 / 1.07 | 0.92 / 1.08 | 0.90 / 1.04 | 0.86 / 0.99 | 42.1 / 46.2 | 6.8 / 6.9 (0.99; 0.86) | −0.67 / −0.65 (−0.49 / −0.72) |
| K5 R | 63.4 / 66.8 | 0.98 / 1.02 | 1.06 / 1.07 | 1.22 / 1.26 | 1.11 / 1.14 | 50.7 / 51.6 | 3.5 / 6.2 (0.57; 0.67) | −0.36 / −0.53 (0.01 / −0.48) |
| K6 L | 93.5 / 91.5 | 1.01 / 1.03 | 1.02 / 1.04 | 1.02 / 1.02 | 0.97 / 0.97 | 45.4 / 45.4 | 4.1 / 6.4 (0.64; 0.45) | 0.31 / 0.28 (0.36 / 0.35) |
| K7 R | 95.1 / 92.6 | 0.79 / 0.79 | 0.79 / 0.79 | 0.95 / 0.83 | 0.86 / 0.75 | 43.5 / 39.7 | 8.1 / 6.4 (1.26; 1.26) | −0.70 / −0.75 (−0.78 / −0.75) |
| K8 L | 93.5 / 93.5 | 1.12 / 1.05 | 1.13 / 1.05 | 1.16 / 1.09 | 1.11 / 1.04 | 49.3 / 47.6 | 3.9 / 6.7 (0.59; 0.59) | 0.28 / 0.57 (0.27 / 0.72) |
| K9 L | 129.0 / 127.2 | 1.01 / 0.99 | 1.01 / 1.01 | 1.05 / 1.05 | 1.00 / 1.00 | 46.4 / 46.4 | 2.7 / 6.9 (0.39; 0.53) | 0.13 / −0.47 (0.09 / −0.30) |
| K10 L | 72.9 / 72.9 | 1.10 / 1.09 | 1.10 / 1.10 | 1.22 / 1.17 | 1.16 / 1.11 | 50.7 / 49.5 | 6.5 / 6.6 (0.99; 1.02) | 0.06 / −0.30 (0.22 / −0.30) |
| K11 R | 79.4 / 77.0 | 0.94 / 0.94 | 1.02 / 1.02 | 1.15 / 1.15 | 1.04 / 1.04 | 49.0 / 49.0 | 0.0 / 6.8 (0.01; −0.07) | 0.57 / 0.35 (0.01 / 0.24) |
| K12 R | 93.7 / 87.2 | 1.08 / 0.98 | 1.08 / 1.00 | 1.15 / 1.14 | 1.04 / 1.04 | 48.9 / 48.8 | −0.7 / 7.4 (−0.09; −0.09) | 0.25 / 0.16 (0.11 / −0.02) |
| K13 R | 105.5 / 108.0 | 1.05 / 1.03 | 1.05 / 1.04 | 1.18 / 1.18 | 1.07 / 1.07 | 49.7 / 49.7 | 5.8 / 6.5 (0.90; 0.93) | 0.15 / −0.81 (0.29 / −0.73) |
| K14 L | 99.1 / 98.3 | 0.86 / 0.92 | 0.88 / 0.96 | 0.92 / 0.92 | 0.87 / 0.87 | 42.5 / 42.5 | 2.9 / 6.4 (0.44; 0.29) | −0.10 / −0.18 (0.11 / −0.14) |
| K15 R | 87.6 / 89.9 | 1.02 / 0.99 | 1.03 / 1.01 | 1.18 / 1.08 | 1.07 / 0.98 | 49.7 / 47.3 | 4.2 / 6.1 (0.69; 0.94) | −0.04 / −0.16 (−0.10 / −0.18) |
| K16 R | 133.1 / 140.5 | 0.86 / 0.89 | 0.87 / 0.90 | 0.82 / 0.83 | 0.74 / 0.75 | 39.3 / 39.6 | 2.4 / 6.3 (0.38; 0.51) | 0.17 / −0.17 (0.06 / −0.27) |

**Reading the columns.**

- **Inside frac.** The offset toward the corner's inside at the lap's apex, divided by the pist inner
  half-width: 1 = on the inner edge.
- **Outside frac.** The offset toward the outside at the pist zone's entry and exit, divided by the
  outer half-width: 1 = on the outer edge; negative = on the inside half.
- **Lap length.** The GPS lap is 3100 m (median of the kept laps, 3093–3105). The pist centreline is
  3170 m and the pist κ 0.85 race line 3032 m.

**Does the owner use the width? Only on the inside, and only at some corners.**

- **Apexes reach the inner edge** at K4, K10, K13 and K15 (0.86–1.02). K7 sits 1.7 m past the edge,
  which is kerb or GPS-to-imagery registration of ~1–2 m.
- **Apexes stay near the centre** at K11 and K12 (0.0 / −0.1 of 6.8–7.4 m).
- **The typical apex is 0.4–0.6.**
- **Entries and exits almost never go to the outside edge.** Their median outside fraction is −0.3 to
  +0.4, so the bike stays within the middle ~60 % of the road.

The owner's line is a "narrow, inside" line: shorter than the centreline (3100 vs 3170 m), with almost
no outside-in width.

**Apex speeds.** The best lap's apex speeds sit within ±3 % of the median at most corners. The
exceptions are K4 +7 %, K12 +7 %, K5 −5 % and K16 −5 %.

## 2. Model on the owner's own speed

`src/sim/referenceFromDda.ts` builds a `Reference` from the best lap:

- **Template axis.** The lap's GPS metres, rotated so metre 0 is the pist gate.
- **Speed.** Ground speed against distance.
- **Corners.** The 16 pist corners, re-located on the lap's own |κ| peaks.
- **Brake point.** The last speed peak before each corner's minimum, where the drop is at least
  10 km/h.

The reference fit (`fitRider`) uses the panigale-v4 preset with μ 1.35 and maxLean 59°, so the
ceiling is 1.35 g = 53.5°. It was run on four lines:

- **(a) Own line, sim κ.** The owner's own GPS line as a sim `Line` (`lineFromOffsets`, the sim's
  curvature: 20 m stencil plus a ±20 m mean).
- **(b) Own line, measured κ.** The same line with the measured 20 m κ.
- **(c) and (d) pist race lines.** κ 0 and κ 0.85, kerb 1.0.

Apex speeds are reproduced on every line: max |Δ| 0.0–3.8 km/h (K14 on the own line). The fitted
lateral cap per corner, against the measured value:

| corner | v²κ zone max (measured) | calibrated lean g | (a) own line, sim κ | (b) own line, κ 20 m | (c) race κ 0 | (d) race κ 0.85 |
|---|---|---|---|---|---|---|
| K1 R | 0.99 | 0.90 | 0.91 | 0.96 | 0.87 | 1.19 |
| K2 R | 1.06 | 1.10 | 1.00 | 0.99 | 1.01 | 1.06 |
| K3 L | 1.07 | 1.04 | 0.96 | 1.01 | 1.07 | 1.35 |
| K4 L | 0.92 | 0.86 | 0.80 | 0.92 | **1.28** | **1.39** |
| K5 R | 1.06 | 1.11 | 0.89 | 0.97 | 0.74 | 1.04 |
| K6 L | 1.02 | 0.97 | 0.95 | 0.99 | **1.23** | 1.03 |
| K7 R | 0.79 | 0.86 | **0.49** | 0.79 | 0.41 | 0.30 |
| K8 L | 1.13 | 1.11 | 0.98 | 1.11 | 0.89 | 1.03 |
| K9 L | 1.01 | 1.00 | 0.91 | 1.00 | 0.86 | 1.01 |
| K10 L | 1.10 | 1.16 | 1.04 | 1.08 | 0.88 | 1.12 |
| K11 R | 1.02 | 1.04 | 1.07 | 1.14 | 1.03 | **1.43** |
| K12 R | 1.08 | 1.04 | 1.01 | 1.04 | 0.97 | 1.15 |
| K13 R | 1.05 | 1.07 | 0.98 | 1.03 | 0.89 | 1.02 |
| K14 L | 0.88 | 0.87 | 0.79 | 0.90 | 0.65 | 0.66 |
| K15 R | 1.03 | 1.07 | 0.90 | 1.01 | 0.82 | 0.96 |
| K16 R | 0.87 | 0.74 | 0.77 | 0.84 | 0.94 | 1.11 |
| **cap − v²κ: mean / rms, g** | | | −0.10 / 0.12 | **−0.02 / 0.05** | −0.09 / 0.21 | +0.05 / 0.24 |
| **cap − calibrated lean g: mean / rms** | | | −0.09 / 0.13 | **−0.01 / 0.07** | −0.09 / 0.24 | +0.06 / 0.27 |
| line m; lap fit / ref / ref-on-line, s | | | 3096; 94.47 / 95.80 / 95.61 | 3096; 94.96 / 95.80 / 95.88 | 3197; 97.38 / 95.80 / 99.76 | 3032; 90.62 / 95.80 / 93.77 |

**The lateral-g derivation is validated, with one bias.**

- **On the owner's own line with the measured curvature (b),** the fitted lateral cap reproduces
  v²κ to −0.02 ± 0.05 g. It reproduces the independent lean measurement to −0.01 ± 0.07 g, with a max
  |Δ| of 0.13 g.
  - **Example.** K8: fit 1.11 g, lean 1.11 g, v²κ 1.13 g.
  - **Example.** K10: fit 1.08 g, lean 1.16 g, v²κ 1.10 g.
- **The bias: the sim's own curvature pipeline (a) reads low by 0.10 g (9 %) on average.**
  - **Cause.** `polylineCurvature` uses a ±20 m three-point stencil and then a ±20 m moving average
    (CURV_SCALE_M = 20).
  - **Size.** Up to 0.30 g at the K7 flick, and 0.12–0.15 g at K4, K8 and K15.
  - **Where the 20 m came from.** It was calibrated on the BMW file's hand-placed ±15–20 m map
    polyline.
  - **The GPS line does not need it.** It is clean: on straights above 198 km/h, the p95 radius with
    the 20 m κ is 3.7 km. A ±10 m stencil with a ±10 m mean reproduces the 20 m-window κ within 0.02 g
    per corner (K7 0.76 vs 0.79).
- **On the pist race lines (c, d), the apex speed is matched but the lateral g follows that line's
  curvature, not the owner's** (rms 0.21–0.24 g). Through K3–K4 and K6:
  - **The κ 0 line is tighter than the path the owner rode.** At K4: R ≈ 108 m against 150–200 m,
    with both measured through the same sim pipeline. At K6: κ 17.6 against 13.5 ×10⁻³.
  - **Why: it is a global minimum of Σκ².** It exits K2 wide-left and stays on the left edge from K3
    to K4, treating K3 and K4 as one arc.
  - **What the owner does instead.** He crosses to the right before K3 and turns earlier. That spreads
    the K3–K4 heading change, about 1.75 rad on both lines, over a longer distance.
  - **Minimum curvature is not minimum time.** It weights the slow K2 like the fast K3–K4.

## 3. Model against measurement along the lap at the same lateral g

Every sim station is compared with the measured value at the same reference metre, through the fit's
warp, on stations where the calibrated lean g is above 0.3. Envelope |latG| minus each measurement,
reported as rmse / p95 |Δ| / bias in g:

| line | vs raw tan\|lean\| | vs calibrated lean g | vs v²κ/g | lean rmse |
|---|---|---|---|---|
| (a) own, sim κ | 0.132 / 0.243 / −0.050 | 0.116 / 0.222 / +0.016 | 0.104 / 0.210 / +0.016 | 5.9° |
| (b) own, κ 20 m | 0.131 / 0.245 / −0.050 | 0.115 / 0.220 / +0.016 | 0.094 / 0.197 / +0.016 | 6.1° |
| (c) race κ 0 | 0.244 / 0.450 / −0.112 | 0.214 / 0.399 / −0.046 | 0.202 / 0.382 / −0.046 | 11.0° |
| (d) race κ 0.85 | 0.274 / 0.553 / −0.085 | 0.257 / 0.519 / −0.030 | 0.247 / 0.477 / −0.030 | 13.0° |

**Not within 0.05 g, on any line.**

- **The bias is within 0.05 g** on the owner's line (+0.016 g against both measured lateral g's).
- **The rmse is 0.09–0.12 g.** That is at the floor set by the two measurements themselves: tan(lean)
  against v²κ is 0.097 g rms raw and 0.063 g calibrated, per sample.
- **What dominates the residual.** Speed between the apexes and the ±5–24 m apex warp, not the
  lateral-g formula. The QSS rider rides each segment at its cap; the owner does not. The fitted lap is
  0.8–1.3 s quicker than the reference on its own line, and none of the four runs meets the 0.3 s lap
  tolerance.
- **Raw tan(lean) reads 0.05 g above the model,** which is the 2.1° roll excess of §0.
- **On the pist lines, the error is the line, not the rider.**

## 4. BMW context

### What the owner reaches

The owner reaches **1.08 g p99 and 1.12 g peak** (v²κ). Lean p99 is 51.2°, whose tan is 1.24 g as
raw roll and ~1.1 g calibrated.

At the three corners the BMW fit leaves over the 1.40 g ceiling:

| corner | owner (apex v, v²κ, lean) | BMW demand on race κ 0 / kerb 1.0 | BMW demand on κ 0.85 |
|---|---|---|---|
| K4 | 129.7 km/h, 0.92 g, 42° | 1.84 g (61.5°) | 1.99 g (63.3°) |
| K6 | 93.5 km/h, 1.02 g, 45° | 1.50 g (56.3°) | 1.25 g |
| K12 | 93.7 km/h, 1.08 g, 49° | 1.66 g (58.9°) | 1.95 g (62.9°) |

### The BMW on the owner's line

Scale the owner's measured g by (v_BMW / v_owner)², with the radius unchanged: g_BMW = g_owner·(v_B/v_O)².

| corner | BMW / owner speed | BMW on the owner's line |
|---|---|---|
| K4 | 158.5 / 129.7 (×1.20) | 1.32 g |
| K6 | ×1.10 | 1.20 g |
| K12 | ×1.30 | **1.77 g** |
| K8 | ×1.29 | **1.83 g** |
| K9 | ×1.24 | 1.53 g |
| K15 | ×1.22 | 1.49 g |
| K2 | ×1.20 | 1.43 g |

The other nine corners are 1.09–1.36 g. The BMW's whole lap is ×1.20 faster.

### What is plausible

- **Lean.** Lateral g is tan of the effective lean: 1.40 g = 54.5°, 1.50 g = 56.3°, 1.60 g = 58°,
  1.73 g = 60°, 1.84 g = 61.5°, 2.0 g = 63.4°.
- **Where the classes sit.** These are practitioner figures, not measured here:
  - a superbike on slicks sustains ~55–58° (1.45–1.6 g);
  - ~60° (1.73 g) is the top of production-based racing;
  - 62–64° (1.9–2.0 g) is MotoGP-only territory.
- **K4 and K6 are line artefacts.** The owner's real path through K4 is straight enough that the BMW's
  158.5 km/h needs only 1.3 g. So the 1.84 g is a property of the pist min-curvature line, not of the
  BMW reference.
- **K8 and K12 are where the BMW reference is implausible.**
  - **K12.** The BMW is 30 % faster than the owner there (lap average 20 %). It needs 1.66–1.77 g
    (59–60.5°) on both the widest pist line and the owner's.
  - **K8.** It needs 1.47 g on the pist line and 1.83 g on the owner's.
  - **Possible causes.** The BMW's speeds there are suspect: they are dash readings, unverified
    against GPS, and placed to within ±20 m.
- **What a dash over-read would do.** The Ducati's own dash over-reads lean-dependently, by ×1.35 in g
  at 45°.
  - **The average is fine.** The BMW speed integrates to 3040 m, against 3032–3100 m for a real ridden
    line, so there is no large average over-read.
  - **Corners cannot be checked.** That closure says nothing about a lean-dependent over-read in the
    corners, which would inflate exactly these numbers.

## 5. Verdict

1. **Validated, with a ~0.1 g bias.** On the owner's own line with the measured curvature, the fit's
   apex lateral g matches GPS v²κ to −0.02 ± 0.05 g and the IMU lean to −0.01 ± 0.07 g. The sim's
   default curvature smoothing (CURV_SCALE_M 20: stencil plus mean) reads 0.10 g low (up to 0.3 g at
   flicks).
2. **The measured lateral g is v²κ/g with lean-corrected ground speed.** It peaks at 1.12 g (p99
   1.08). tan(lean), which is `accel_lat_g`, tracks it at r 0.997 but reads ~0.055 g high: 2.1° of tyre
   roll plus a 0.7° IMU zero. The raw dash speed would claim ×1.35.
3. **Along the lap the model is not within 0.05 g:** rms 0.09–0.12 g, p95 0.2 g. The bias is small
   (+0.016 g); the residual is speed between the apexes and warp, at the floor of the measurements'
   own 0.06–0.10 g agreement. Lap times are not converged: 0.8–3.2 s fast.
4. **BMW: K4 and K6 are artefacts; K8 and K12 are implausible.** K4 and K6 go away on the owner's real
   line (1.3 / 1.2 g). K12 at 1.66–1.77 g and K8 at up to 1.8 g are implausible for the BMW reference
   (59–61° on any line); the BMW is 29–30 % faster than the owner there, against 20 % on the lap.
5. **Fix next.**
   - **(a) Curvature scale.** Make CURV_SCALE_M per source: ~10 m for GPS or pist geometry, 20 m only
     for hand-placed map lines.
   - **(b) Line target.** Replace the global min-Σκ² target at the K2→K3–K4 sequence with a
     speed-weighted (minimum-time-like) line, since the owner's path beats it at K4 and K6.
   - **(c) The fitted rider's between-apex speed.** Coast and roll-on caps are needed to close the lap
     and zone times (the owner's 7 s roll-on).
   - **(d) The BMW's K8 and K12.** Check its speed and position against video or GPS.

## 6. Files

- **`dda_lab/src/sim/referenceFromDda.ts`** (new, pure). It provides:
  - `fitGroundSpeed`: GPS lag plus the wheel/ground lean model;
  - `ddaLapTrace`: one lap on a 1 m grid from the gate, with ground speed, lean and κ;
  - `pathCurvature`;
  - `referenceFromDda`: the `Reference`;
  - `trackCornersFromPist`.
- **`dda_lab/scripts/ducati-lateral.ts`** (new CLI) and **`dda_lab/scripts/lib/ducatiLateral.ts`**
  (new). The lib covers:
  - the channel check, per-corner measurement and corridor offset;
  - `ownLine`;
  - `fitAndCompare` / `fitOnPist`;
  - the panigale μ 1.35 / 59° params.
  - **Commit note.** `scripts/lib` is gitignored at the root, so these need `git add -f`.
- **`dda_lab/tests/unit/simRefFromDda.test.ts`** (new).
  - **Synthetic circle.** Length, κ = 1/R, v²κ/g = tan(lean), and the gate at metre 0.
  - **Ducati best lap** (runs when `_inbox` has the file):
    - 16 pist corners in order, with directions;
    - lap length within 3 % of the pist length, between the κ 0.85 line and the centreline;
    - speed closure within 1 %;
    - accel_lat = tan(lean), and v²κ against tan(lean) r > 0.98.
  - **Why 3 %, not the brief's 2 %.** The owner's line is 3094 m against the 3170 m centreline
    (−2.4 %), as a ridden line should be.
- **Suite.** 678 / 680 pass. The 2 failures are the intentionally red BMW assertions in
  `simFitRider.test.ts`. Typecheck is clean.

## 7. Fix (a): curvature scale per source

The sim pipeline (`polylineCurvature`: ±L three-point stencil, then a ±L mean) on the best lap's own
GPS line, per corner zone max v²κ/g. The report command prints it as "κ scale".

| L (stencil / mean), m | 20/20 | 14/14 | 12/12 | **10/10** | 8/8 | 7/7 | 5/5 |
|---|---|---|---|---|---|---|---|
| zone max − calibrated lean g: mean / rms / max abs | −0.079 / 0.120 / 0.37 | −0.038 / 0.077 / 0.22 | −0.024 / 0.065 / 0.17 | **−0.010 / 0.056 / 0.11** | +0.014 / 0.060 / 0.15 | +0.030 / 0.068 / 0.18 | +0.076 / 0.099 / 0.20 |
| − measured v²κ (20 m heading window): mean / rms | −0.088 / 0.110 | −0.047 / 0.058 | −0.033 / 0.040 | −0.019 / 0.021 | +0.005 / 0.011 | +0.021 / 0.026 | +0.067 / 0.072 |
| straights (> 180 km/h, \|lean\| < 5°): \|κ\| p95, 10⁻³/m | 0.175 | 0.200 | 0.202 | 0.234 | 0.289 | 0.330 | 0.429 |
| K7 zone max, g (0.79 v²κ / 0.86 lean) | 0.49 | 0.64 | 0.70 | 0.76 | 0.81 | 0.83 | 0.86 |

**10 m is chosen.** It has the smallest bias and rmse against the independent measurement (the
calibrated lean), and its straights stay at R 4.3 km.

**The scale is per source, not global.** On the same "straights" test, the other sources fail at
10 m:

| centreline | \|κ\| p95 on straights (\|κ\|₄₀ < 1/1500 for ±40 m), 10⁻³/m, 20 m / 10 m |
|---|---|
| Ducati GPS laps (`buildTrackFromSession`) | 0.16 / **0.48** |
| BMW hand-placed map | 0.50 / 1.50 |
| pist Serres centreline | 0.84 / 2.47 |
| pist race line κ 0 / κ 0.85 (follows the traced edges) | 2.0 / 5.0 and 3.3 / 13.6 |

**How it is wired.**

- `TrackModel.curvatureScaleM` sets the scale; unset means 20 m.
- `chooseCurvatureScaleM(centerline)` picks 10 m when the straights' |κ| p95 at 10 m is below
  1/1000 m⁻¹, else 20 m.
- `buildTrackFromSession` sets it.
- `lineFromOffsets` measures `line.curvature` at the track's scale. This is the κ behind the solver,
  `toSession`/`latG` and `fitRider`.
- The pist and map tracks stay at 20 m.
- The min-curvature optimiser's input (`buildLine`'s `baseCurv`) stays at 20 m whatever the track.
- The corridor hairpin cap (`corridor.ts`) and the roll-rate stencil are unchanged.

## 8. Fix (c): coast, roll-on and entry minimum in the fitted rider

**Where the time actually was.** Before the fix, on the own line, the fitted lap was 0.9 s quick.

- **−0.81 s of it was in decelerating stations, not on the straights.** On the runs the sim was
  2–5 km/h *slower* than the owner.
- **It came back 10–15 km/h faster before the next apex.** The owner finishes braking 40–60 m before
  an apex and runs in with neither brake nor throttle. At K11 he dips 5 km/h below the apex speed
  21 m early. The QSS rider instead brakes at a reduced fitted cap all the way to the κ peak.

**What `fitRider` now does,** all from the reference's own speed trace on the line
(aRef = d(v²/2)/ds over ±10 m):

- **Roll-on (`rollOnS`).**
  - **What it measures.** The time from the apex to where the reference first uses 90 % of the
    preset's drive (`driveCapMs2` at its speed), or 90 % of its own run level when it never gets near
    the cap.
  - **How it is applied.** The drive the bike has after power and wheelie (new
    `EnvelopeCaps.driveScale`) rises 1 − e^(−t·ln10/rollOnS).
  - **Why against the cap, not the reference's peak.** The BMW leaves K5 at 1.46 g, past the wheelie
    limit, and its own peak would time the roll-on to that figure.
- **Coast (`coastFrac`, `coastInM`).**
  - **Where.** Stations with |aRef| ≤ 0.1 g: the run-in before an apex, and stretches ≥ 20 m
    mid-run.
  - **What the sim does there.** No tyre braking, and a net acceleration no higher than the
    reference's (new `EnvelopeCaps.accelMaxMs2`, applied after drag). So a hold stays a hold at lean.
- **Entry minimum.** A reference speed minimum ≥ 8 m before the apex and ≥ 2 km/h below it gets its
  own lateral segment, corrected on the minimum. Used at Ducati K11 and BMW K8.
- **`runG`.**
  - **Target.** The reference's speed at the next corner's brake point.
  - **Over-drive.** It is also cut where the sim drives into a peak above the reference and brakes it
    off (Ducati K15 → K16: +26 km/h at 1.0 g against 0.4 g).
- **Lap target.** The reference speed over this line (`alignedRefLapS`), not the reference clock.
- **Damping.** 20 rounds, corrections damped from round 10. Without damping, the BMW K8 → K9 pair
  limit-cycles.
- **Two old rule bugs.**
  - **Brake point behind the previous apex.** A brake point that lies behind the previous apex
    (K15's, before K14) drove K15's brake cap to its floor and set K14 0.9–3.7 km/h slow.
  - **Over-drove branch.** The "over-drove" branch took precedence even when the over-drive was
    smaller than the apex deficit.

**Fit against the reference speed ridden on the same line.**

| line | before: fit / ref-on-line, s (Δ; max apex Δ) | after |
|---|---|---|
| **Ducati own GPS line, sim κ** (20 m before, 10 m after) | 94.47 / 95.61 (−1.14; 1.7 km/h) | **96.01 / 95.80 (+0.21; 0.9 km/h), converged in 6** |
| Ducati own line at 20 m, new fit | — | 95.59 / 95.61 (−0.02; 0.4) |
| Ducati own line, measured κ | 94.96 / 95.88 (−0.92; 3.8) | 95.75 / 95.88 (−0.13; 1.0) |
| Ducati on pist race κ 0 | 97.38 / 99.76 (−2.38; 0.6) | 99.55 / 99.76 (−0.21; 0.4) |
| Ducati on pist race κ 0.85 | 90.62 / 93.77 (−3.15; 0.0) | 92.73 / 93.77 (−1.04; 0.6), not converged |
| **BMW on pist race κ 0.85** | 79.08 / 79.61 (−0.53; K9 4.5) | **79.37 / 79.61 (−0.24; 0.9), converged in 18** |
| BMW map line | 78.80 / 79.33 (−0.53; K14 7.2) | 79.30 / 79.33 (−0.03; K14 6.6, which has no κ peak; others ≤ 1.1) |

**Ducati per corner after both fixes,** fitted apex cap on the own line, g:

| corner | K1 | K2 | K3 | K4 | K5 | K6 | K7 | K8 | K9 | K10 | K11 | K12 | K13 | K14 | K15 | K16 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| v²κ zone max (measured) | 0.99 | 1.06 | 1.07 | 0.92 | 1.06 | 1.02 | 0.79 | 1.13 | 1.01 | 1.10 | 1.02 | 1.08 | 1.05 | 0.88 | 1.03 | 0.87 |
| calibrated lean g | 0.90 | 1.10 | 1.04 | 0.86 | 1.11 | 0.97 | 0.86 | 1.11 | 1.00 | 1.16 | 1.04 | 1.04 | 1.07 | 0.87 | 1.07 | 0.74 |
| before (§2 (a)) | 0.91 | 1.00 | 0.96 | 0.80 | 0.89 | 0.95 | 0.49 | 0.98 | 0.91 | 1.04 | 1.07 | 1.01 | 0.98 | 0.79 | 0.90 | 0.77 |
| **after** | 0.96 | 1.00 | 1.02 | 0.91 | 0.97 | 0.99 | 0.75 | 1.10 | 0.99 | 1.09 | 1.13 | 1.07 | 1.03 | 0.87 | 1.00 | 0.84 |

**Summary, before → after.**

| measure | before | after |
|---|---|---|
| cap − calibrated lean, mean / rms | −0.09 / 0.13 g | **−0.01 / 0.07 g** |
| cap − v²κ, mean / rms | −0.10 / 0.12 g | −0.02 / 0.05 g |
| along the lap, envelope − calibrated lean: rmse / p95 / bias | 0.116 / 0.222 / +0.016 g | 0.092 / 0.182 / +0.006 g |
| along the lap, envelope − v²κ: rmse / p95 / bias | 0.104 / 0.210 / +0.016 g | 0.073 / 0.169 / +0.006 g |
| lean rmse | 5.9° | 5.7° |

**Not fixed.**

- **The Ducati on the pist κ 0.85 line** is still 1.0 s quick. That is fix (b), the line itself.
- **BMW zone times against the reference clock stay red** in `simFitRider.test.ts`: lap −0.51 s
  (−0.48 s of it is line distance), K1 zone −0.68 s. Against the reference speed over the line, the
  zones are within 0.3 s (K5 +0.28 s: the 1.46 g exit).
