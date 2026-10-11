# Longitudinal g: making the simulated braking trace mean something

2026-10-11. Referenced from `src/sim/solver.ts` and `src/sim/presets.ts`.
Measurement code: `tests/unit/gTraceMetrics.ts`; assertions:
`tests/unit/simLongG.test.ts`.

## The complaint

> longitudinal g is not meaningful — update it so it converges on the BMW and
> R6 data.

The solver's braking trace was a square plateau: a near-constant −1.10 g with
a one-sample leading edge. Both real laps are shaped and vary corner to corner.

## 1. What the two reference files actually contain

| | BMW `serres_BMW_1-19-81.json` | R6 `serres_R6_1-19-849.json` |
|---|---|---|
| `hiz_kmh` | real, OCR of the dash at 25 Hz (1323 ocr / 33 manual / 640 interp frames), ±1–2 km/h | real, overlay read at 25 Hz, ±3 km/h |
| `boylamsal_g` | **derived** from `hiz_kmh` | **derived** from `hiz_kmh` |
| `gaz_pct` | **null in all 3186 rows** | real, 551 distinct values |
| `vites` | **null in all 3186 rows** | real, gears 2–5 |
| `lat` / `lon` | hand-placed map line, ±15–20 m | **byte-identical to the BMW's in all 3186 rows** |
| lean, brake pressure, rpm | absent | absent |

So the R6 file adds two real channels (throttle, gear) and no more. Its
metadata claims the position was fitted to a GPS trace at 2.7 m mean deviation;
it is in fact the same hand-placed line as the BMW's, so position is not an
independent channel in either file. `boylamsal_g` is the derivative of the one
measured channel in both: median |dv/dt − `boylamsal_g`| is 0.047 g on the BMW
and 0.131 g on the R6.

### Two artefacts, both excluded from the reference statistics

- **R6, 1645–1685 m (−2.16 g).** The file's own metadata flags it: "K10
  girişindeki ani hız düşüşü gösterge gecikmesi olabilir". No tyre makes
  2.16 g.
- **BMW, 360–384 m (−1.42 g).** This is the figure the lap's braking range was
  previously quoted against, and it is an OCR misread. The raw frames read
  149, 149, 145, 141, 141, 131, 131, 131, 133, 133, 130 km/h in consecutive
  0.04 s frames: the speed goes *down* to 131 and back *up* to 133 in the
  middle of a braking zone. Differentiating the smoothed series turns a 2–4 km/h
  misread into a 1.42 g excursion at 144 km/h, 69 m before the K1 apex — the
  lap's deepest braking at half its top speed with the bike already turning.
  Excluded, the BMW's deepest zone is −1.24 g at 258 km/h, which agrees with
  the R6's independent −1.06 g at 232 km/h.

## 2. Decomposing the real peaks

Peak `boylamsal_g` per braking zone, minus the aero and rolling deceleration at
the speed it occurred at (`lossDecelMs2` with each preset's `cdA` and mass):

| zone | BMW total | at | loss | **tyre** | R6 total | at | loss | **tyre** |
|---|---|---|---|---|---|---|---|---|
| K1 | −1.24 | 258 | 0.39 | **0.85** | −1.06 | 232 | 0.34 | **0.72** |
| K4 | −0.72 | 148 | 0.14 | **0.58** | — | | | |
| K5 | −1.07 | 130 | 0.11 | **0.95** | −0.96 | 139 | 0.13 | **0.82** |
| K10 | −0.74 | 137 | 0.12 | **0.62** | −0.86 | 151 | 0.15 | **0.71** |
| K11 | −0.85 | 153 | 0.15 | **0.70** | −1.04 | 132 | 0.12 | **0.92** |
| K13 | −0.84 | 180 | 0.20 | **0.64** | −0.90 | 177 | 0.20 | **0.70** |
| K14 | −0.68 | 142 | 0.13 | **0.54** | −0.53 | 128 | 0.11 | **0.41** |

Two readings:

1. **The losses are a third of the deepest braking peak and a tenth of the
   shallowest.** That v² spread is the physical reason a real lap's braking is
   deepest off the fastest straight. The solver had the loss term in its
   forward pass and not in its backward one, so it could not reproduce it with
   any constant.
2. **Neither rider asked the front tyre for more than 0.95 g, and mostly for
   0.54–0.72 g.** The shipped `brakingG` was 1.1.

## 3. The build rate

The hardest zone on each lap is the one place where the brake goes on from a
settled straight, so its leading edge is the build and nothing else:

- BMW: −0.08 g at 272 km/h → −1.10 g 30 m later. 0.40 s, **2.7 g/s**.
- R6: −0.04 g at 249 km/h → −1.07 g 25 m later. 0.37 s, **2.8 g/s**.

Two bikes, two riders, agreeing to 4 %. That is a machine property — fork
travel and damping, the time the mass takes to pitch onto the front tyre — plus
the rider's squeeze, and it is what `rider.brakeRiseGps` is. Note that both
figures are an *upper bound* on the true build: the underlying speed traces are
smoothed (the BMW file ships its own `duzgun_hiz_kmh` column), and smoothing
lengthens an edge.

## 4. What changed

1. `aLoss` is added to the backward pass's available deceleration, outside the
   friction ellipse, because drag is not carried by a contact patch.
2. The tyre's share of braking is rate-limited to `brakeRiseGps` from brake-on.
   The limit is anchored at brake-on, which is where the braking curve meets
   the drive curve, so it is a property of passes 2 and 3 **together** and the
   two now iterate (`BRAKE_RATE_ITERS`). Reading the onset off the backward
   pass alone fails quietly: that pass's zone runs back up the straight to
   where it would meet the drag-limited top speed, 80 m earlier than the bike
   ever gets, and a clock started there is already 0.66 s old at the real
   braking point — enough to make the limit inert above 1 g/s while still
   looking applied.
3. `gripUse` adds the losses back before judging the tyre, so a −1.25 g peak
   at 250 km/h reads as 0.85 g of front tyre rather than as over the limit.
4. `brakingG` 1.1 → 0.85 and `brakeRiseGps` 2.8, from §2 and §3.

## 5. What is left, and why

The braking body (p25 −0.95/−0.86 against the references' −0.70/−0.67) and the
mean zone peak (−0.94/−0.91 against −0.88/−0.87) are still 0.06–0.25 g deep.
That is **the solver being optimal, not a defect**: a quasi-steady-state solve
brakes at the ceiling in every zone, and §2 shows both real riders asking for
0.85–0.95 g once and 0.54–0.72 g everywhere else. Modelling that difference as
physics would be modelling a human's judgement as a force. The `Braking`
slider is the honest place for it, and dropping it to 0.70 — the mean of the
measured tyre shares — brings the 1000's p25 to −0.810 and its mean zone peak
to −0.823, both inside the references, and costs 0.83 s of lap time
(79.53 → 80.36). The default stays at the measured 0.85, which is the top of
what the real riders asked for, not the average.
