# BMW reference fit on the pist Serres geometry (2026-10-11)

Follow-up to `2026-10-11-bmw-fit.md`. That fit ran on DDA Lab's hand-placed map line, where the
BMW rider needed 1.5–2.0 g at K2, K5, K8, K11 and K12 against a 1.40 g ceiling. The question here:
does the lateral g come within reach once the line runs on the real, surveyed Serres geometry from
`pist`?

**Short answer: no, not on any line.** The real geometry clears the map line's K2, K5 and K11. It
makes K3, K4, K6, K8, K9, K12 and K16 tighter than the map line showed them. On the best line
(κ = 0, minimum curvature) 9 of the 16 apexes are still over 1.40 g. With the reference allowed to
sit ±20 m off, 7 still are, and 6 of those are over 1.47 g (ceiling × 1.05).

## 1. Setup

- **Geometry.** `pist/scripts/export-serres.ts` (not committed) runs the Node golden pipeline with the
  dual trace (`SERRES_OUTER` / `SERRES_INNER`, cached z18 mosaic) and detects corners with
  `detectOnSmoothed`, as the UI does. It writes `_inbox/serres.pist.json`: **3169.96 m**, 3156 stations,
  cw, edges known 3154/3156, converged, **16 corners** (K5, K11, K13 and K14 compound).
  - **Gate.** The BMW file's finish line (`telemetri_1m[0]`, 41.0730586 / 23.51802) is 5.6 m from
    centreline station 0, so the gate sits there, with bearing 132.1°.
  - **Gate hint not used.** The suggested hint (41.0735, 23.5200) is 152 m off the track. Its nearest
    station is 91 m down the straight, so it was not used.
  - **Same as the bundled file.** The package matches the bundled `dda_lab/public/tracks/serres.pist.json`
    (3169.93 m, same gate) except for a 0.2° gate bearing.
  - **Length is right.** The official circuit length is 3186 m, so the pist centreline is consistent
    with it.
- **Corners and alignment.** The fit aligns the reference's **own 16 corners** (`viraj_ozeti`) to the
  line's |κ| peaks (`alignRef.ts`). The pist corner list is not used for matching. All five lines
  matched 16/16 in order, with no corner out of order and no split needed. The pist detection also
  gives 16, so no K11/K12 split was needed.
- **Lines** (`dda_lab/scripts/lib/fitLines.ts`):
  - **map**: today's default. The BMW file's lat/lon, no corridor, 5 m fallback half-width, the
    preset's κ = 0.85.
  - **pist centreline**: the track model's centreline itself, with offset 0.
  - **race**: `buildLine` inside the pist corridor (100 % resolved, width p50 13.5 m, p5–p95
    12.0–15.7 m), at κ = 0.85 (the 1000 preset), κ = 0 and κ = 1.
  - **κ convention.** In `line.ts`, **κ = 0 is minimum curvature and κ = 1 is minimum distance**. The
    brief called κ = 1 "pure min-curvature", which is the other way round, so both ends were run.
- **Rider.** The 1000 preset, μ 1.40, ceiling 1.40 g = 54.5°. Fit as in the previous note (12 rounds).
- **Report command:** `cd dda_lab && npx vite-node scripts/fit-reference.ts --track ../_inbox/serres.pist.json --compare [--full]`.
  Single line: `--line map|centre|race [--kappa k]`. With `--track` the default line is `race`.

## 2. Comparison (BMW 1:19.81)

Each cell reads: fitted apex km/h / zone time minus the reference speed ridden over the same zone of
this line (s) / fitted lateral cap at the apex (g) / largest cap in the zone (g). Bold marks a value
over 1.47 g, *italic* a value over 1.40 g.

| corner | apex ref | map κ .85 | pist centreline | race κ .85 | race κ 0 (min curv.) | race κ 1 (min dist.) |
|---|---|---|---|---|---|---|
| K1 R | 103.3 | 103.3 / −0.18 / 1.21 / **1.69** | 103.3 / −0.33 / **1.87** / **1.87** | 103.3 / −0.07 / **1.77** / **1.77** | 103.3 / −0.30 / 1.37 / 1.37 | 103.3 / −0.03 / **2.26** / **2.26** |
| K2 R | 119.8 | 119.8 / −0.06 / **1.72** / **1.72** | 121.0 / +0.02 / **1.48** / **1.48** | 120.5 / +0.07 / **1.67** / **1.67** | 119.8 / −0.00 / *1.42* / *1.42* | 120.6 / +0.02 / **1.60** / **1.60** |
| K3 L | 135.5 | 135.5 / −0.04 / 1.25 / 1.25 | 135.5 / −0.01 / **1.80** / **1.80** | 135.5 / −0.03 / **1.72** / **1.72** | 135.5 / −0.06 / **1.63** / **1.63** | 135.5 / −0.00 / **1.80** / **1.80** |
| K4 L | 158.5 | 158.5 / −0.05 / 0.99 / **1.97** | 158.5 / −0.09 / **2.44** / **2.44** | 158.5 / −0.08 / **1.93** / **1.93** | 158.5 / −0.01 / **1.80** / **1.80** | 157.5 / −0.04 / **2.29** / **2.29** |
| K5 R | 70.1 | 70.1 / +0.21 / *1.44* / *1.44* | 70.1 / +0.38 / 1.08 / 1.08 | 70.1 / +0.26 / 1.25 / 1.25 | 70.1 / +0.56 / 0.92 / 0.92 | 70.1 / +0.24 / 1.23 / 1.23 |
| K6 L | 103.7 | 103.7 / −0.04 / 1.31 / 1.31 | 103.7 / −0.04 / **1.98** / **1.98** | 103.7 / −0.04 / *1.44* / *1.44* | 103.7 / −0.06 / **1.58** / **1.58** | 103.7 / −0.03 / **1.94** / **1.94** |
| K7 R | 124.8 | 124.8 / −0.01 / 0.61 / 0.61 | 124.8 / −0.02 / **2.14** / **2.14** | 124.8 / +0.00 / 0.86 / 0.86 | 123.9 / +0.01 / 1.00 / 1.00 | 124.8 / −0.03 / 0.37 / 0.37 |
| K8 L | 122.9 | 122.9 / −0.10 / **1.57** / **1.57** | 120.2 / −0.13 / **2.50** / **2.50** | 122.9 / −0.19 / **1.76** / **1.76** | 122.9 / −0.19 / **1.75** / **1.75** | 117.9 / −0.07 / **2.50** / **2.50** |
| K9 L | 159.8 | 159.1 / −0.07 / 1.32 / 1.32 | 155.5 / −0.07 / **2.50** / **2.50** | 154.9 / +0.02 / **1.75** / **1.75** | 156.7 / +0.02 / **1.76** / **1.76** | 155.8 / −0.03 / **2.50** / **2.50** |
| K10 L | 79.2 | 79.2 / +0.07 / 1.31 / 1.31 | 79.2 / +0.35 / 1.20 / 1.20 | 79.2 / +0.08 / 1.34 / 1.34 | 79.2 / +0.43 / 1.04 / 1.04 | 79.2 / +0.29 / *1.46* / *1.46* |
| K11 R | 89.9 | 89.9 / −0.11 / **1.52** / **1.52** | 89.9 / −0.13 / *1.46* / *1.46* | 89.9 / −0.16 / **1.63** / **1.63** | 89.9 / −0.13 / 1.25 / 1.25 | 89.9 / −0.16 / **1.66** / **1.66** |
| K12 R | 124.2 | 123.7 / +0.04 / **1.73** / **1.73** | 124.2 / −0.08 / **2.33** / **2.33** | 124.2 / −0.01 / **1.89** / **1.89** | 124.2 / +0.02 / **1.78** / **1.78** | 120.9 / +0.00 / **2.50** / **2.50** |
| K13 R | 117.9 | 117.9 / −0.16 / 1.15 / **2.04** | 117.9 / +0.04 / 1.17 / **1.80** | 117.9 / +0.20 / 1.25 / **1.63** | 117.9 / +0.00 / 1.21 / 1.21 | 117.9 / +0.27 / 1.31 / **1.97** |
| K14 L | 116.2 | 116.2 / +0.51 / 0.40 / 0.40 | 116.2 / +0.02 / *1.41* / *1.41* | 116.2 / −0.01 / 0.89 / 0.89 | 116.2 / −0.08 / 0.85 / 0.85 | 124.0 / +0.08 / 0.25 / **1.97** |
| K15 R | 107.1 | 107.1 / −0.18 / 1.17 / 1.21 | 107.1 / −0.10 / **1.86** / **1.86** | 107.1 / −0.13 / **1.57** / **1.57** | 107.1 / −0.12 / *1.41* / *1.41* | 107.1 / −0.11 / **2.23** / **2.40** |
| K16 R | 168.7 | 168.7 / +0.01 / 0.90 / 1.19 | 157.5 / +0.15 / **2.50** / **2.50** | 168.7 / −0.03 / **1.57** / **1.57** | 168.7 / −0.00 / **1.50** / **1.50** | 161.0 / +0.08 / **2.50** / **2.50** |

Summary per line:

| | map κ .85 | pist centreline | race κ .85 | race κ 0 | race κ 1 |
|---|---|---|---|---|---|
| line length, m | 3039 | 3170 | 3050 | 3203 | 3063 |
| **lap: fit / reference, s** | 79.20 / 79.81 | 84.04 / 79.81 | 80.05 / 79.81 | 85.04 / 79.81 | 81.01 / 79.81 |
| **reference speed ridden on this line, s** | 79.43 | 84.05 | 80.23 | 85.01 | 80.49 |
| fit − reference-on-line, s (rider effect) | −0.23 | −0.02 | −0.18 | +0.03 | +0.52 |
| max apex \|Δ\|, km/h | 0.7 | 11.2 (K16, capped at 2.5 g) | 4.9 (K9) | 3.1 (K9) | 7.8 |
| **apexes over 1.40 g** (apex / anywhere in zone) | 5 / 8 | 13 / 14 | 11 / 12 | **9 / 9** | 12 / 14 |
| apexes over 1.47 g (ceiling × 1.05) | 4 / 7 | 11 / 12 | 10 / 11 | 7 / 7 | 11 / 13 |
| apexes over 1.40 / 1.47 g with the reference shifted ≤ 20 m | 3 / 2 | 11 / 10 | 10 / 8 | **7 / 6** | 11 / 10 |
| apex shift against a uniform scale, mean / max, m | 13.4 / 34.6 | 10.9 / 52.2 | 11.1 / 53.2 | 19.7 / 51.5 | 7.5 / 23.4 |

"Shifted ≤ 20 m" is |κ_apex| · min v_ref(±20 m)² / g. The line's κ peak stays where it is, and the
reference speed is allowed to sit up to its stated ±20 m position error along the line. This is the
best case the reference's own position error allows. Per corner, race κ 0 / race κ .85:

| | K1 | K2 | K3 | K4 | K6 | K8 | K9 | K11 | K12 | K15 | K16 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| race κ 0, g | 1.37 | 1.22 | **1.59** | **1.61** | **1.56** | **1.49** | **1.62** | 1.25 | **1.58** | *1.41* | 1.34 |
| race κ .85, g | **1.76** | 1.31 | **1.67** | **1.73** | *1.43* | **1.49** | **1.57** | **1.63** | **1.67** | **1.56** | *1.43* |

The corners not listed (K5, K7, K10, K13, K14) are ≤ 1.40 g on both lines.

## 3. Inherent lap time per line: distance against rider

The "reference speed ridden on this line" row separates the two effects:

- **Distance.** The BMW speed integrates to 3040 m. The pist racing line at the preset's κ is 3050 m,
  and its reference-on-line lap is 80.23 s (+0.42 s on the clock). The centreline (3170 m) and the
  minimum-curvature line (3203 m) are 130–160 m longer than the distance the BMW's speed covers.
  - **Effect on lap time.** Reference-on-line rises to 84–85 s, entirely distance.
  - **Shape of the real line.** The BMW did not ride the centreline or a wide min-curvature line. Its
    lap is as short as a κ ≈ 0.85 line, unless the dash under-reads by ≈ 5 %. That cannot be ruled
    out from the speed alone, but nothing else points to it.
- **Rider.** The fitted rider stays within 0.25 s of the reference-on-line lap on every line except
  κ = 1 (+0.52 s). On κ = 1, K8, K9, K12 and K16 hit the 2.5 g cap bound and the apexes cannot be met.
  The rider model reproduces the speed. The question is only whether the g it needs is physical.
- **Zone times.** Zone-time residuals against the reference clock grow on the pist lines: K15 +1.7 s,
  K5 +0.6–1.7 s. Measured against the reference speed on the same line, they stay within 0.2–0.5 s.
  These are the reference's along-track position errors (apex shift up to 52 m), not rider errors.

## 4. Verdict

**On no line does the BMW rider stay inside the 1.40 g / 54.5° ceiling, not even inside ×1.05.**
The closest is the minimum-curvature line (κ = 0):

- 9 apexes over 1.40 g at the reference positions;
- 7 apexes over 1.40 g with ±20 m of reference position error allowed;
- K3, K4, K6, K8, K9 and K12 stay at **1.5–1.6 g** whatever is done.

What the over-ceiling corners say:

1. **Line, map against real geometry.**
   - **Cleared by the real geometry.** K5 (1.44 g → 0.9–1.25 g), K11 (1.52 g → 1.25 g on κ 0) and K2
     (1.72 g → 1.42 g, 1.22 g shifted) were line artefacts of the hand-placed map line. So were the
     second |κ| peaks in K1, K4 and K13.
   - **Tightened by the real geometry.** The map line flattered K3, K4, K6, K9, K12 and K16. Its
     5 m-box line through a ±20 m polyline was wider than the real asphalt allows there. K4, for
     example: 0.99 g at the apex on the map line, 1.8–1.9 g on every pist racing line.
2. **Reference position error (±20 m).**
   - **What it buys.** 0.1–0.4 g where the reference minimum sits off the line's κ peak: K9
     1.75 → 1.57 g, K12 1.89 → 1.67 g, K16 1.57 → 1.43 g (κ .85).
   - **Why it falls short.** The peaks themselves are tighter than the BMW's apex speeds allow. Its
     slowest speed within ±20 m of K3/K4/K8/K9 still needs ≥ 1.5 g on any line.
3. **κ style.** Moving from the preset's κ 0.85 to κ 0 brings K1 (1.77 → 1.37 g) and K11
   (1.63 → 1.25 g) under the ceiling, 11 → 9 apexes over.
   - **Small gains elsewhere.** K15 falls 1.57 → 1.41 g, K16 1.57 → 1.50 g, K4 1.93 → 1.80 g and
     K12 1.89 → 1.78 g.
   - **What it costs.** K6 rises 1.44 → 1.58 g, because the wide line tightens the K6–K7 flick.
   - **κ 1** is worse almost everywhere.
   - **Per-corner style.** A per-corner κ would take the best column per corner. That still leaves
     K3, K4, K6, K8, K9 and K12 at ≥ 1.49 g even with the ±20 m shift.
4. **What remains: K3–K4 (two lefts), K6–K8–K9, K12.**
   - **The R6 points to the reference.** The R6 lap on the same lines needs 1.9 g at K3/K4/K6 even on
     κ 0 with ±20 m tolerance (K3 1.94, K4 1.88, K6 1.92), and no tyre does that. The R6 is 13 km/h
     faster than the BMW at K3 and 7 km/h faster at K4. The reference's apex speeds and/or corner
     positions there are inconsistent with the surveyed circuit by more than any line choice can
     absorb.
   - **For the BMW alone,** 1.5–1.6 g (56–58°) is above the 1000 preset's μ 1.40 but within reach of
     a race-tyred superbike.
   - **The line generator could also be at fault.** The global min-Σκ² line may not be the max-radius
     line through the K3–K4 pair. At K3 the κ 0 line sits only 3.1 m of 7.0 m to the inside, so it
     treats K3 + K4 as one arc. A per-corner max-radius check is the next step before blaming the
     tyre.

**Default unchanged.** Step 5 of the brief was conditional on line (c) bringing every corner to
≤ 1.40 g (or ≤ 1.47 g). It does not, so the lab's default was **not** changed and no Playwright run
was made.

- **The UI already uses the pist model.** "Fit to reference" (`store.runFit`) fits on the active track
  and its corridor. When the pist Serres model is selected, that is line (c) at the preset's κ.
- **CLI default.** `fit-reference.ts` now uses `race` as its default line when `--track` is given.
- **The file input accepts the export.** The exported `serres.pist.json` (version 2,
  `provenance.tracedInner` 68 points) parses with `parsePistPackage`, and `openFiles.isPistPackage`
  takes it by its `.pist.json` name. This is asserted in `tests/unit/simFitPist.test.ts`.

## 5. Files

- `pist/scripts/export-serres.ts` (new, uncommitted): the export.
- `dda_lab/scripts/fit-reference.ts`: `--track`, `--line`, `--kappa`, `--compare`, `--full`; over-ceiling
  counts; the shifted-reference g.
- `dda_lab/scripts/lib/fitLines.ts` (new): map / centre / race line builders.
  - **Commit note.** `lib/` is in the root `.gitignore`, as for the other `scripts/lib` files, so it
    needs `git add -f`.
- `dda_lab/tests/unit/simFitPist.test.ts` (new): the fit on the pist model (centre and race) runs,
  matches 16 corners in order and reproduces the reference speed on the line; the exported file
  parses.
- **Suite status.** 672/674 pass. The 2 failures are the two literal BMW assertions in
  `simFitRider.test.ts` (lap within 0.3 s, zone times within 0.3 s), which the previous note keeps red
  on purpose. Typecheck is clean.

## 6. Full-width minimum-curvature line (2026-10-11, follow-up)

§4 left one suspect: the line generator. It has now been replaced, and the comparison re-run.

### 6.1 Diagnosis: why the κ = 0 line stopped short of the edges

Measured on the pist Serres corridor (1578 lab stations, box = edge − 0.4 m bike half-width + 0.5 m
`kerbMarginM`, p50 6.8 m per side), κ = 0:

- **Width use overall was not the problem.** |offset| / available side, histogram in tenths 0.0 … 1.0:
  old line `4.5 6.3 4.9 5.3 7.8 6.5 8.5 9.8 14.5 31.8` % — 32 % of stations already within 10 % of a
  bound. The line was against an edge on most straights and many corners; it was short at
  specific apexes: K9 0.4 of 7.7 m inside at the pist apex (1.4 m best within ±60 m), K16 1.8 of 7.8 m,
  K12 never reached the inside (still 3.1 m on the outside side), K3 3.7 of 7.1 m at the pist apex
  (6.9 m at its own apex 30-40 m away).
- **Not the safety margin.** 0.4 m half-width minus 0.5 m kerb margin = the box was already 0.1 m
  *outside* the pist edge.
- **Not the smoothing window.** Shrinking the curvature scale of the centreline input from 20 m to
  10 / 6 / 4 m moved the synthetic apex the wrong way (2.4 → 1.9 → 1.7 → 1.7 m inside).
- **Non-convergence: a minor part.** Solving the old functional exactly (new QP solver) lowered its
  objective by only 1.6 % and moved the Serres apexes by tenths of a metre to ~1.5 m (K3 3.7 → 5.1 m,
  K9 0.4 → 3.6 m).
- **The functional itself: the main cause.** The old line minimised Σκ² with the *small-slope*
  curvature `κ ≈ k0 + k0²·d + d''`. That drops the d′² terms of the exact offset-curve curvature
  `κ = [(1−k0 d)(k0(1−k0 d) + d″) + d′(k0′ d + 2 k0 d′)] / ((1−k0 d)² + d′²)^{3/2}`. They are not small
  where a line crosses the track into a corner: at a 25–30 % crossing slope the linearisation
  overstates the curvature by 20–30 %, so even the *exact* optimum refuses to cross far enough.
  Synthetic 90° corner (R 30 m, 12 m corridor, box ±5.6 m): apex 1.64 m inside on the old solve,
  2.02 m on the exact small-slope optimum, **5.60 m (on the bound)** with the exact curvature.

### 6.2 Method

`src/sim/line.ts` + new `src/sim/lineQp.ts`. The Heilmeier et al. 2019 / TUMFTM "mincurv" formulation:

- **Variables and bounds.** One offset per station along its normal, bounded by
  `[−(wR − 0.4 + kerbMarginM + kerbM), wL − 0.4 + kerbMarginM + kerbM]`.
- **Objective.** Minimise ½(1−κ)·Σ k²·|p′| − κ·G·Σ k0·d. This is the same κ blend with minimum
  distance as before, same `DIST_GAIN`. k is the exact curvature above, and |p′| is the line's own
  arc-length element.
- **Solve.** Gauss–Newton re-linearisation ("mincurv_iqp"), ≤ 8 passes, stopping once no station moves
  more than 1 cm; in practice 2–3 passes. Each pass is a bounded QP with a periodic pentadiagonal
  Hessian. It is solved to optimality by Bertsekas' projected Newton: an ε-active set, one banded
  LDLᵀ plus a rank-4 Woodbury wrap correction per iteration, and projected Armijo backtracking.
- **Why not primal-dual active-set.** A primal-dual active-set method was tried first and cycles on
  this Hessian (60 iterations, unconverged).
- **Speed.** 12–30 ms on Serres (1578 stations), 1.5–47 ms on a 3472-station fixture, well inside the
  200 ms budget.
- **Kerb allowance.** New `tyre.kerbM` (default **1.0 m**, `DEFAULT_KERB_M`, clamped 0–3). It is added on
  top of the existing per-preset `kerbMarginM` and applies **only past a measured corridor edge**, not
  to the 5 m fallback when there is no corridor, so `kerbM 0` reproduces the old box exactly. The sim
  panel has a "Kerb allowance" slider under the line-style κ slider.
- **Synthetic checks** (`tests/unit/simLine.test.ts`, kerb margins 0, box ±5.6 m):
  - **90° rounded square.** Peak |κ| is 0.0217 against the centreline's 0.0300, −28 %. The apex sits
    on the inner bound and the line touches the outer bound on both straights, within 0.2 m.
  - **180° oval end.** A 25 % cut is geometrically impossible here: a 180° turn between parallel
    straights cannot beat the outer radius R + w/2 = 35.6 m, which is −16 %. The test asserts a line
    radius > R + 0.9·5.6.
  - **Speed.** A 3200-station solve runs in < 200 ms.

### 6.3 Re-run (BMW 1:19.81, `fit-reference.ts --track ../_inbox/serres.pist.json --compare --full`)

Apex lateral g (fitted cap at the matched apex); in brackets the old Gauss–Seidel line of §2.

| | race κ .85 kerb 0 | race κ .85 kerb 1.0 | race κ 0 kerb 0 | race κ 0 kerb 1.0 |
|---|---|---|---|---|
| line length, m | 3049 (3050) | 3032 | 3190 (3203) | 3197 |
| lap fit / ref, s | 79.67 / 79.81 | 79.08 / 79.81 | 84.87 / 79.81 | 84.57 / 79.81 |
| reference speed ridden on this line, s | 80.14 (80.23) | 79.61 | 84.32 (85.01) | 84.68 |
| apexes over 1.40 g (apex / zone) | 10 / 10 (11 / 12) | 10 / 10 | 5 / 5 (9 / 9) | 6 / 7 |
| apexes over 1.47 g | 9 / 9 (10 / 11) | 9 / 9 | 4 / 4 (7 / 7) | 4 / 4 |
| over 1.40 / 1.47 g, reference shifted ≤ 20 m | 9 / 7 (10 / 8) | 9 / 6 | 3 / 3 (7 / 6) | 3 / 3 |
| K3 | **1.69** (1.72) | **1.70** | 1.35 (1.63) | 1.34 |
| K4 | **2.00** (1.93) | **1.99** | **1.82** (1.80) | **1.84** |
| K6 | 1.33 (1.44) | 1.25 | **1.53** (1.58) | **1.50** |
| K8 | **1.79** (1.76) | **1.71** | **1.60** (1.75) | **1.48** |
| K9 | **1.57** (1.75) | **1.55** | 1.31 (1.76) | 1.32 |
| K12 | **1.97** (1.89) | **1.95** | **1.69** (1.78) | **1.66** |

On race κ 0 / kerb 1.0, the apexes over 1.40 g are K2 1.46, K4 1.84, K6 1.50, K8 1.48, K12 1.66 and
K16 1.43. With the ±20 m reference shift: K4 1.64, K6 1.48 and K12 1.48. The R6 needs 1.6–2.0 g at
K3, K4, K6, K8 and K12 even on κ 0 / kerb 1.0, so the §4 point stands.

**Verdict: no, the BMW still does not fit under 1.40 g, but what is left is now three corners, not nine.**

- **What the line fixed.** The full-width minimum-curvature line (κ 0) clears **K3** (1.63 → 1.34 g)
  and **K9** (1.76 → 1.32 g). It brings K8 to 1.48 g with the kerb, and with the ±20 m shift to
  1.26 g.
  - **Count over 1.40 g:** 9 → 5–6 at the reference apexes, and 7 → 3 with the shift.
- **What is left, with the shift allowed:**
  - **K4: 1.64 g,** +0.24 g. With no shift, 1.84 g, +0.44 g. This is the worst.
  - **K12: 1.48 g,** +0.08 g. With no shift, 1.66 g.
  - **K6: 1.48 g,** +0.08 g. With no shift, 1.50 g.
- **The kerb buys little.** It is worth ≈ 0.1 g at K8 and nothing measurable elsewhere.
- **K4 and K12 look geometric, not line choice.**
  - **The test.** An experimental near-minimax line (iteratively reweighted Σ|κ|^p, p = 4 / 8, not
    committed) still gives K4 1.78 / 1.83 g and K12 1.83 / 1.76 g.
  - **What it means.** No line in this corridor gets K4 below ~1.75 g at the reference apex
    position.
  - **Where the answer lies.** The remaining gap at K4 is in the reference's speed or its position
    there, or in the tyre, not in the line.
- **κ .85 got slightly worse.** The preset's κ .85 is a little worse at K4/K12 (+0.07 g) than on the
  old line, because the exact solve commits harder to the minimum-distance pull there.

### 6.4 Test changes

- **`simLine.test.ts`.**
  - **Containment bounds.** The containment tests now include `kerbM`, because the box legitimately
    widened.
  - **Hairpin-smoothing test.** It now runs on a pinned corridor. It had encoded the old line hugging
    the centreline radius; the exact solve legitimately rides the 25 m hairpin at 28.6 m.
  - **`strideSchedule`.** The test is deleted along with the multigrid it described.
  - **New tests:** the three synthetic checks in §6.2.
- **`simSolver.test.ts`.** The envelope pin was re-pinned, 59.492084 → 59.285918 s: the fixture's line
  changed, the solver did not.
- **`simFitRider.test.ts`** (map line, still κ .85). The new line has no left |κ| peak at K14, so the
  K14 apex is set by the brake cap on its 0.10 g floor (+7.2 km/h). Thresholds changed:
  - K14 apex: tolerance 8 km/h;
  - lap against reference-on-line: 0.3 → 0.6 s, now −0.54 s;
  - zone times: 0.25 → 0.30 s (K5 reads 0.250).
- **`simFitPist.test.ts`.** The race-line lap against reference-on-line went 0.5 → 0.6 s, now −0.53 s,
  mostly K1.
- **Still red, unchanged.** The two literal BMW assertions (lap and zone times against the reference
  clock) are still red as intended. The lap is now −1.0 s.

## 7. Min-time line approximation (2026-10-11, follow-up to ducati-lateral note §5 item b)

### 7.1 Method

`src/sim/line.ts`, `lineMode: 'min-curvature' | 'min-time'` in `RiderParams` (default `'min-time'`;
absent = min-time; `clampParams` keeps it). The sim panel has a "Line objective" select next to the κ slider.

- **Iteration (`minTimeOffsets`).** (a) Solve the κ-blended minimum-curvature line. (b) Run the QSS
  (`solve`) with the rider's own params (no wander). (c) Re-solve with the curvature term weighted per
  station by w = (v/v_ref)², with v² smoothed over the 20 m curvature scale. v_ref² = Σκ²v²/Σκ² on the
  current line, the curvature-weighted mean, so the weights move curvature cost between corners without
  changing its total against the distance pull, and κ keeps its meaning. Add a small distance term,
  0.1·DIST_GAIN·(1 − κ). The solve is warm-started on the previous line (≤ 3 Gauss–Newton passes).
  (d) Repeat ≤ 4 times, with the weights damped (0.6 new), until the line moves < 0.1 m p95.
- **Safeguard.** The fixed-point iteration is not monotone in lap time. Each iterate's QSS lap is
  recorded, iterate 0 being the min-curvature line, and **the fastest iterate is returned**. So the
  min-time line is never slower than min-curvature on its own QSS rider.
- **κ semantics.** κ = 0 is the min-time line. κ = 1 is still minimum distance: the lengths match to
  < 1 m. In between, the blend works as before.
- **Weight strength.** (v/v_ref)⁴ and ⁶ were tried. They open the sweeper further but cost the
  hairpin's exit onto the next straight: +1.5 s and +3.5 s on the synthetic fixture. The spec's
  square is the best of the three.

### 7.2 QP fix found on the way (`src/sim/lineQp.ts`)

- **The bug.** The projected-Newton stopping test (|x − P(x − g/diag Q)| < 1e-5 m) is mis-scaled for
  this fourth-order Hessian, by ~(λ/h)⁴.
- **What it did.** At 0.4–0.9 m station spacing it declared the **centreline** optimal at iteration
  0. The old 3200-station speed test passed because it solved nothing. At 2 m spacing its "converged"
  10–30 iterations were in fact unconverged.
- **The fix.** Optimality is now the projected *reduced* Newton step, and the ε of the active set
  follows it. A new `admmBoxQp` (ADMM with residual balancing, ρ₀ = 1e-5·mean diag, O(n) banded solve
  per iteration) finds the active set and warm-starts projected Newton, which polishes it. Tolerances
  are 1 cm for ADMM and 1 mm for Newton.
- **Effect on the min-curvature line at 2 m.** It moved by tenths: Serres BMW κ 0 lap 85.22 → 85.21 s.
  The envelope pin moved, 59.285918 → 58.436497 s, but that is mostly the min-time default.

### 7.3 Synthetic (tests/unit/simLine.test.ts, `sweeperHairpin`)

The fixture is a 600 m straight, then a LEFT 90° R150 sweeper, a 60 m link, and a RIGHT 90° R15
hairpin, closed by a rounded rectangle. It is 12 m wide, with 2 m stations. Results at κ 0, 1000
preset:

| | min-curvature | min-time |
|---|---|---|
| sweeper mean-κ radius | 175 m | 182 m |
| sweeper min speed | 139 km/h | 150 km/h |
| hairpin peak radius | 36 m | 32 m |
| QSS lap | 59.782 s | 59.607 s (−0.175 s) |

- **The lap gain depends on spacing:**

  | | 2 m | 1.5 m | 1 m |
  |---|---|---|---|
  | lap gain | −0.175 s | −0.198 s | −0.060 s |

  The trade-off is flat, and min-curvature itself moves ±0.15 s with spacing.
- **Geometry variants** at 2 m gain −0.07 to −0.20 s.
- **At κ .85** the safeguard returns the min-curvature line.
- **The 5-corner circuit at the preset κ .85** gains −0.85 s: 59.29 → 58.44 s. The 250 m sweeper
  becomes a double apex (197 / 180 km/h), so the corner detector finds 6 sections. The
  detector/event/rider tests are pinned to `'min-curvature'` for that reason.

### 7.4 Serres (`scripts/line-modes.ts`; fit-reference also takes `--line-mode min-time|min-curvature|both`)

Fitted lateral cap at the matched apex, g. "HEAD" is the pre-§7 line (old QP, min-curvature).

**BMW 1:19.81, 1000 preset, pist race line, kerb 1.0**

| | κ0 HEAD | κ0 min-curv | κ0 min-time | κ.85 HEAD | κ.85 min-curv | κ.85 min-time |
|---|---|---|---|---|---|---|
| K2 | 1.51 | 1.52 | **1.64** | 1.71 | 1.71 | 1.71 |
| K3 | 1.35 | 1.35 | 1.32 | 1.69 | 1.70 | 1.70 |
| K4 | 1.84 | 1.84 | 1.85 | 1.99 | 1.99 | 1.99 |
| K6 | 1.50 | 1.50 | 1.44 | 1.25 | 1.25 | 1.25 |
| K8 | 1.49 | 1.49 | 1.48 | 1.71 | 1.71 | 1.71 |
| K9 | 1.32 | 1.32 | 1.28 | 1.55 | 1.55 | 1.55 |
| K12 | 1.66 | 1.65 | 1.63 | 1.95 | 1.95 | 1.95 |
| K4 radius at apex, m | 108 | 107 | 107 | 99 | 99 | 99 |
| line length, m | 3197 | 3196 | 3188 | 3032 | 3032 | 3032 |
| fit lap / ref-on-line, s | 85.22 / 84.68 | 85.21 / 84.67 | 84.93 / 84.54 | 79.37 / 79.61 | 79.37 / 79.61 | 79.37 / 79.61 |
| QSS lap, preset rider, s | 82.65 | 82.67 | **82.45** | 80.50 | 80.50 | 80.50 |

**Ducati best lap 6, Panigale V4 μ 1.35 / 59°, pist race line, kerb 1.0; owner's own GPS line for reference**

| | κ0 HEAD | κ0 min-curv | κ0 min-time | κ.85 (all) | owner GPS |
|---|---|---|---|---|---|
| K2 | 1.01 | 1.02 | 1.09 | 1.06 | 1.00 |
| K3 | 1.07 | 1.08 | 1.05 | 1.35 | 1.02 |
| K4 | 1.28 | 1.28 | 1.29 | 1.39 | 0.91 |
| K6 | 1.23 | 1.23 | 1.19 | 1.03 | 0.99 |
| K8 | 0.90 | 0.90 | 0.90 | 1.04 | 1.10 |
| K9 | 0.86 | 0.86 | 0.83 | 1.01 | 0.99 |
| K12 | 0.97 | 0.97 | 0.96 | 1.15 | 1.07 |
| K4 radius at apex, m | 108 | 107 | 107 | 99 | **152** |
| fit lap / ref-on-line, s | 99.55 / 99.76 | 99.54 / 99.75 | 99.11 / 99.37 | 92.73 / 93.77 | 96.01 / 95.80 |
| QSS lap, Panigale, s | 83.65 | 83.64 | **83.39** | 81.53 | — |

**Verdict: the speed-weighted line behaves as intended but does not fix K4.**

- **What it does.** It makes the slow K2 tighter: BMW 1.52 → 1.64 g. It relieves K3, K6 and K9 by
  0.03–0.06 g, and it shortens the κ 0 line by 8 m. It gains 0.22 s (BMW) and 0.25 s (Ducati) of QSS
  lap time.
- **What it does not do.** The K4 radius stays at 107 m, against the owner's 152 m. K4 g is unchanged.
- **Why K4 stays put.** Mapped into the pist frame, the owner's line has R 173 m at K4. He enters K4
  mid-track (+1 m), apexes at +7.6 m, and exits to the centre and beyond (−2.8 m, 50 m later). The race
  lines stay on the inside (+7 m) through the exit to set up what follows.
  - **It is not a local minimum.** Warm-starting the min-curvature/min-time solve from the owner's
    path converges back to the same line (83.63 / 83.35 s).
  - **The owner's path is faster but not curvature-optimal.** It has more Σκ² (0.139 against 0.111),
    yet the Panigale's QSS on it, clamped to the box, is 81.65 s against 83.4 s. That is the same as
    the κ .85 line (81.53 s).
  - **What the objective is missing.** Most of the remaining 2 s is distance / exit-speed coupling,
    which a curvature objective with a local speed weight cannot represent.
- **Next.** Use time-sensitivity weights that propagate each apex's dv into its braking and exit zones,
  or a direct lap-time descent such as `freeTrajectory`, started from the min-time line.
- **The other agent's new test.** Its BMW "every apex ≤ 1.47 g" assertion on κ 0 is red either way:
  K2 1.51 on HEAD, 1.64 on min-time.

### 7.5 Speed

- **Node, 3218 stations:** 150–220 ms for a 4-iteration min-time solve. That is 1 initial
  ADMM + Newton solve, then ≤ 4 × (QSS ~20 ms + warm QP), plus the final QSS. Min-curvature alone
  takes ~40 ms.
- **Serres, 1578 stations:** ~105 ms min-time, against 20–45 ms min-curvature.
- **In the browser (Playwright, Serres):** the whole `setSimParams` (line + QSS + events + session +
  `refreshAll`) takes 123–131 ms on min-time and 50–79 ms on min-curvature.
- **Tests.** `simLine` asserts < 300 ms for the 3200-station min-time solve.

### 7.6 Test changes

- **`simLine`.**
  - The QP describe is pinned to `'min-curvature'`.
  - The 3200-station test now also asserts that the apex reaches the bound; this catches the old
    false convergence.
  - New `min-time line` describe: default and clamp; the sweeper opened and the hairpin tightened;
    lap ≥ 0.1 s quicker; box at κ 0 / .5 / .85 / 1; never slower than iterate 0; κ 1 length; 300 ms.
- **`simCorners`, `simEvents`, `simRider`.** P is pinned to `'min-curvature'`, because of the
  five-corner fixture's double apex.
- **`simSolver`.** The envelope pin and the inline snapshot were re-pinned (58.436497 s).
- **`simLongG`.** The 600 brake onset bound went 1.1 → 1.15 s (now 1.104 s).
- **`simFreeTrajectory`.** The describe timeout went to 15 s; the box test already took 4.7 s at the 5 s
  default.

## 8. Direct lap-time line (2026-10-12, follow-up to §7.4 "Next")

**Short answer: the direct lap-time descent works.** On the pist Serres corridor it laps 4.2 s faster than the
κ 0.85 line on the same QSS rider and opens K4 from 107 m to 142 m. It is now `lineMode: 'lap-time'`, behind an
"Optimise line" button. The cheaper exit-wide weighting was also tried: it gains 0.4 s but does not open K4.

### 8.1 Diagnosis: what `freeTrajectory` is and what it needed

- **What it optimises.** It minimises the QSS lap (`solve`) over the lateral offsets inside exactly the
  `offsetBounds` box: corridor, kerb margin and `kerbM`. The search is derivative-free coordinate descent: one
  knot per 20 m, raised-cosine bumps of ±40 m, a step of 1 m (0.05–3 m adaptive), alternating sweeps.
- **What it was used for.** It drives the UI's "Serbest yörünge" (the free-trajectory solver mode) in the
  worker. That mode is judged by the *ideal* rider (all s* = 1). Its warm start was only the rider's κ-line,
  with and without wander.
- **What was added.** `createOptimiser(track, corridor, params, start?)` takes a new, optional
  `FreeTrajStart`. `optimiseOffsets` takes the same fields. The change is backward compatible: no `start`
  means the old behaviour.
  - **`init`.** Any warm start, clamped into the box. The κ-line is still evaluated and the faster of the two
    kept, so the result never loses to the κ-line.
  - **`rider: 'own'`.** Judges the line by the caller's own params with wander off, not the ideal rider. This
    is the rider every other line mode is judged by.
- **The owner's path.** `scripts/lib/ownerOffsets.ts` maps his path into the corridor frame. It intersects the
  Ducati best lap (Run036, lap 6) with every station's stencil normal, the same normal `lineFromOffsets` uses.
  28 of 1578 stations lie outside the box (kerb use), and the path is clamped for the warm start.
- **Runs.** Pist Serres, 1578 stations, 1000 preset, μ 1.40, κ 0, kerb 1.0, preset rider. Script:
  `scripts/lap-time-line.ts`.

| warm start | start → end, QSS lap (preset rider, no wander), s | sweeps | converged | Node time |
|---|---|---|---|---|
| κ 0 min-time | 82.450 → **77.326** | 31 | yes | 15.9 s |
| owner's path (box) | 80.690 → **76.766** | 23 | yes | 13.5 s |
| κ 0.85 min-time | 80.503 → **76.074** | 19 | yes | 12.6 s |
| shipped (`lapTimeStart`: fastest of κ {0, 0.5, 0.85, 1}, here κ 1) | 79.840 → **76.344** | 26 | yes | 13.8 s |

- **The descent is local.** The three starts end 1.25 s apart. All of them beat κ 0.85 (80.50 s) by more than
  3 s.
- **Is the gain real or a smoothing exploit?** Smoothing the offsets (±10 m) costs the descent's lines 0.3–0.5 s
  and the κ 0 lines 0.3–0.4 s, so the gain survives. The descent's lines are not artefacts of the 20 m
  curvature scale.
  - **One caveat.** Their maximum crossing slope is 0.53–0.58 against 0.37–0.41 for the others. At a 10 m
    curvature scale (noisy for every line on this centreline) they lose more than the owner's path does.

### 8.2 Per-corner table (BMW 1:19.81 v2 fit, lateral g at the matched apex)

- **What each cell means.** The fitted lateral cap at the matched apex, in g. "K12 zone peak" is the largest
  cap in K12's zone, which is the 2150–2175 m exit of v2-fit note §3.
- **The two lap columns.** The QSS lap rows for buildLine-built lines include the preset's 0.4 m wander. The
  rows for descent results do not. The descent from the κ 0.85 start is reported, as is the shipped one.

| | κ 0 min-curv | κ 0 min-time | κ 0 exit-wide ±60 m | κ .85 | owner path (box) | descent ← κ 0 min-time | descent ← owner | descent ← κ .85 | **lap-time (shipped)** |
|---|---|---|---|---|---|---|---|---|---|
| K2 | 1.52 | 1.64 | 1.43 | 1.71 | 1.49 | 1.55 | 1.35 | 1.49 | **1.45** |
| K3 | 1.35 | 1.32 | 1.28 | 1.70 | 1.20 | 1.13 | 1.08 | 1.16 | **1.18** |
| K4 | 1.84 | 1.85 | 1.77 | 1.99 | 1.16 | 1.51 | 1.47 | 1.21 | **1.41** |
| K6 | 1.50 | 1.45 | 1.41 | 1.26 | 1.15 | 1.05 | 0.94 | 1.14 | **1.13** |
| K8 | 1.23 | 1.23 | 1.18 | 1.42 | 1.36 | 1.09 | 0.91 | 1.34 | **0.88** |
| K9 | 1.31 | 1.26 | 1.09 | 1.55 | 1.40 | 1.12 | 1.18 | 1.23 | **0.97** |
| K12 apex | 1.42 | 1.43 | 1.47 | 1.66 | 1.26 | 1.73 | 1.73 | 1.71 | **1.78** |
| K12 zone peak (exit) | 2.10 | 2.17 | 2.03 | 2.32 | 1.26 | 1.76 | 1.73 | 1.71 | **1.83** |
| K4 radius at apex / min ±30 m, m | 107 / 107 | 107 / 107 | 112 / 112 | 99 / 99 | 170 / 170 | 137 / 133 | 138 / 136 | 165 / 161 | **142 / 131** |
| line length, m | 3196 | 3188 | 3181 | 3032 | 3097 | 3091 | 3071 | 3040 | 3052 |
| QSS lap, preset rider, s | 82.67 | 82.45 | 82.02 | 80.50 | 80.69 | 77.33 | 76.77 | 76.07 | 76.59 (76.34 no wander) |
| BMW fit lap / ref speed on line, s | 85.12 / 84.48 | 84.82 / 84.34 | 84.84 / 84.18 | 79.09 / 79.49 | 82.00 / 81.71 | 82.62 / 81.56 | 82.20 / 80.50 | 80.42 / 79.23 | 81.85 / 80.43 |
| apexes over 1.47 g | K2 K4 K6 | K2 K4 | K4 | 8 | K2 | K2 K4 K12 | K12 | K2 K12 | **K12** |

**Reading**

- **K4 opens and is no longer an outlier.** The shipped line opens K4 to 142 m at the matched apex (131 m
  minimum within ±30 m), against 107 m on the κ 0 lines. The owner's path is 170 m. K4 drops from 1.84 to
  1.41 g. The κ 0.85 start goes further, to 165 m / 1.21 g.
- **K2 and K6 fall under 1.47 g.** K2 is 1.45 g and K6 1.13 g. K3, K8 and K9 drop by 0.2–0.35 g.
- **The K12 exit zone falls, the apex rises.** The exit's zone peak goes from 2.10 to 1.83 g, because the line
  now runs wide out of K12 as the video shows. The descent pays for that with a tighter kerb-side apex:
  K12 1.42 → **1.78 g**. It is the one corner left over 1.47 g, on every descent result (1.71–1.78 g).
- **The fit itself is weaker on this line.** The line is straighter through K4, so `alignRef` notes "no left
  |κ| peak within 60 m" there. The K4 apex is fitted at −4.6 km/h and K14 at +6.5 km/h, and the fit stops at
  20 rounds, unconverged.
  - **Lap.** The fit laps 81.85 s against 80.43 s ref-on-line.
  - **Zone times.** K5 +1.4 s and K15 +1.6 s: the reference's distance anchors sit on a 3186 m lap, and this
    line is 3052 m.

### 8.3 Exit-wide weighting (implemented as a diagnostic, not wired)

- **Method.** `minTimeOffsets(..., mtOpts: { speedWindowM })` replaces each station's smoothed v² in the
  (v/v_ref)² weight with its minimum over ±W m.
- **Result.** With W = 30 or 60 m it gains 0.43 s over min-time (82.02 against 82.45 s) and moves K4 from 107 m
  to only 109–112 m. K12's exit drops 2.17 → 1.96–2.03 g, and K2 drops to 1.43–1.46 g.
- **Verdict.** It does not open K4, so it is not exposed. The default (`speedWindowM` absent) leaves the
  min-time line unchanged.

### 8.4 Wiring: `lineMode: 'lap-time'`

- **Where the result lives (`src/sim/lapTimeLine.ts`).** `buildLine` never runs the descent (~13 s). It reads
  a stored result, clamped into the current box.
  - **Two caches.** One is exact per (track, machine, tyre, rider), using the `optCache` mechanics: memory plus
    `localStorage`. The other holds the latest result per track. It is used **stale** when only a rider slider
    moved, and the panel says so.
  - **Fallback.** With no result, `buildLine` returns the min-time line.
  - **Warm start.** `lapTimeStart` picks the fastest of the min-time lines at the rider's κ and κ 0 / 0.5 /
    0.85 / 1.
- **Worker.** `freeTrajectory.worker.ts` takes `init`, `rider` and `lapTimeStart: true`, so the warm start is
  computed off the main thread too.
  - **Runner.** `lapTimeLineRunner` lives in `simRunners.ts`. A newer run now *rejects* the superseded run's
    promise instead of leaving it pending; before, the store's busy flag never cleared.
- **Store and panel.**
  - **Store.** `optimiseLine(runner)` with `simLineOptBusy`, `simLineOptProgress` and `simLineOptLapTimeS`.
    When a run finishes it sets `lineMode: 'lap-time'` and re-simulates.
  - **Panel.** "Line objective" gains **Lap time (optimised)**, plus an **Optimise line** button, a progress
    bar and a status line: optimised (lap) / stale / not optimised yet.
- **Fit to reference.** The fit uses `buildLine`, so it runs on the stored line.
  - **Scripts.** `scripts/fit-reference.ts --line-mode lap-time` runs the descent synchronously in
    `fitLine` (scripts/lib/fitLines.ts).
- **Browser** (`tests/e2e/lapTimeLine.spec.ts`, Playwright, Serres, κ 0, kerb 1.0):
  - **Run.** Optimise line takes 13.2–13.9 s from click to done. The lap goes 1:23.61 → 1:17.71.
  - **Re-simulation.** `setSimParams` on the stored line takes 43–44 ms.
  - **Fit.** Fit to reference on it: 1:21.85 against 1:19.81.
  - **Screenshots:** `scratchpad/laptime/lt-map-K2-K4.png` and `lt-map-K12-exit.png` (purple = optimised
    line, blue = owner lap 6), plus `lt-01-progress.png`, `lt-02-done.png` and `lt-03-fit.png`.

### 8.5 Tests

- **`simFreeTrajectory`.** The warm start is clamped, taken when faster, and ignored at the wrong length.
  `rider: 'own'` reproduces the caller's QSS lap.
- **`simLine`, "lap-time line" on `sweeperHairpin`.**
  - **The gain.** The descent laps 58.602 against 59.607 s for min-time, −1.0 s. The test asks for ≥ 0.1 s or a
    sweeper opened by ≥ 3 m.
  - **Fallback and caches.** The fallback is identical to min-time. buildLine reads the stored line, and a
    rider change reads it as stale.
  - **Box and time.** The line stays inside the box, and the run takes < 30 s (8.5 s measured).
- **`simLapTimeSerres` (new).**
  - **The shipped path.** It converges and beats κ 0.85 by > 1 s. **K4 is ≥ 130 m at the matched apex**
    (142 m), and the K12 zone peak is < 2.0 g.
  - **v2 ceiling.** Every apex is ≤ 1.47 g except the documented **K12**. The **red-by-design "no exceptions"**
    assertion moved here from `simFitRider`, where it is now red on K12 1.78 g alone.
  - **`simFitRider`.** The v2 block keeps its K2/K4/K6 exception test on the κ 0 min-curvature line.
- **Suite and typecheck.** The suite has 707 passing and 3 red by design: the two literal v1 BMW tests and the
  no-exceptions test above. Typecheck is clean for `tsconfig.app.json`, `tsconfig.json` and
  `scripts/tsconfig.json`.

### 8.6 Next

- **K12's apex.** The descent buys the wide exit with a tight kerb-side apex (1.78 g). Two things to try: a
  lateral-g penalty in the descent (the ceiling as a soft constraint), or a K12 warm start from the owner's path
  there (1.26 g).
- **Multi-start.** The warm start decides 1.25 s and K4 at 131–165 m. Running from the two fastest κ-lines
  would cost ~2× (~27 s in the worker).
- **The fit's alignment on wide-exit lines.** K4/K14 apex matching needs work: the descent's lines have no
  clean |κ| peak at K4.

## 9. Multi-start + soft lateral-g ceiling (2026-10-12, follow-up to §8.6)

**Short answer: partly.** With the penalty on and two starts, the BMW v2 fit puts **every apex under 1.47 g**,
K12 included (1.78 → 0.99 g). K2/K4/K6 stay under, K4 opens to 150 m, and the lap is 76.66 s (+0.31 s against
§8). But the K12 number is mostly the fit's apex matching. On that line `alignReference` matches K12 to the
*exit-side* |κ| peak (centreline 2115 m, R 90 m), not the kerb-side one (2052 m). The penalty's own measure is
the BMW speed fixed per station × |κ| over K12's kerb → exit. It drops from 1.76 to **1.55 g**, not under 1.47
g. In the browser, the owner path read from the .dda (not the JSON trace) wins the keep-best. The fit there
reads K12 **1.59 g**.

### 9.1 Method

- **Soft lateral-g ceiling** (`freeTrajectory.ts`, `FreeTrajStart.latG`, `latGPenaltyS`).
  - **The objective.** It becomes lap + λ_g · Σ_i max(0, v_ref,i²·|κ_i|/g − a_ceil)² · ds_i.
    - **κ.** κ is the trial line's own `line.curvature`, the one the fit's `aLatG` uses.
    - **The ceiling.** a_ceil = min(μ_lat, tan(maxLean·leanUsage)) = 1.40 g (`lateralCeilingG`).
    - **v_ref.** v_ref is the BMW v2 speed aligned (`alignReference`, the fit's corner matching) on start
      (a), held fixed per centerline station. Station i is the same cross-section on every line built from
      offsets.
  - **Default λ_g.** `LAT_G_PENALTY_DEFAULT` = 0.5 s/(g²·m), so 0.1 g held over 20 m costs 0.1 s.
  - **When it is on.** `latGPenalty` defaults to on when a reference is given (`refSpeedMs` or `reference`) and
    off otherwise.
  - **Without a reference.** The term would use the line's own QSS speed. **It is then zero by construction**:
    the QSS lateral pass caps v²|κ| at the rider's limit, which is ≤ the ceiling. A unit test checks this.
  - **What `lapTimeS` reports.** It stays the pure QSS lap; `objective` is the lap plus the penalty.
- **Multi-start** (`lapTimeLine.ts`, `createLapTimeRun` / `runLapTimeLine`, `LapTimeRunOpts`).
  - **The starts.** (a) is the fastest κ-line (`lapTimeStart`, as §8). (b) is each line in
    `warmStarts: Line[]`, the owner's GPS path through `ownerOffsets`. (c), optional, is the min-time line at
    the rider's κ.
  - **Each start is its own basin.** Each one runs with `forceInit`, so the κ-line is not compared in again.
  - **Keep-best.** The run keeps **the fastest QSS lap**, as specified. §9.2 shows what the objective rule would
    pick.
  - **Scheduling.** With one or two starts, every start runs to convergence. With three or more, every start
    gets 8 probe sweeps and then the fastest continues alone.
  - **Budget.** A 28 s wall-clock budget returns the best line so far and sets `outOfBudget`.
  - **Knot spacing.** `knotSpacingM` is exposed for the sensitivity run; the bump half-width stays 2× the
    spacing.
- **Browser.**
  - **The owner path.** `ownerOffsets` moved to `src/sim/ownerOffsets.ts`; `scripts/lib` re-exports it.
    `optimiseLine` (store) collects the extras through `lapTimeContext`.
    - **Reference.** The reference is picked as "Fit to reference" picks it.
    - **Owner path.** It is the reference lap when that is a recorded GPS lap. Otherwise it is the best lap of
      the first recorded session with `gps_lon`/`gps_lat`.
  - **Runner and worker.** The runner passes the owner path as offsets plus the `Reference`. The worker runs
    `createLapTimeRun` one sweep per macrotask.
  - **Progress and panel.** Progress carries `start k/n` and a label. The panel shows "start 2/2 (owner path) ·
    52 %", then "kept owner path of 2 starts · lateral-g penalty vs BMW v2 · 25.8 s".
  - **Cache.** The exact cache key gains a variant: the warm-start hashes, the reference and λ.

### 9.2 Serres results (`scripts/lap-time-multistart.ts`, Node, pist Serres, 1000 preset, κ 0, kerb 1.0; BMW v2 fit on `buildLine` with the 0.4 m wander)

Owner path = Ducati Run036 lap 6 from the JSON trace (`analyseRun`), as in §8.

| | single start (§8) | multi-start a,b | multi-start a,b + penalty (**shipped**) | multi-start a,b,c (probe 8) + penalty |
|---|---|---|---|---|
| K2 g (apex) | 1.45 | 1.45 | **1.41** | 1.54 |
| K4 g (apex) | 1.41 | 1.41 | **1.33** | 1.42 |
| K6 g (apex) | 1.13 | 1.13 | **1.15** | 1.08 |
| K12 g (apex) | 1.78 | 1.78 | **0.99** | 1.53 |
| K12 zone peak g (exit) | 1.83 | 1.83 | **0.99** | 1.53 |
| K12 fit apex at centreline s, m | 2052 | 2052 | **2115** | 2052 |
| K12 demand at the fixed v_ref, max over s 2030–2160 m, g | 1.76 | 1.76 | **1.55** | 1.43 |
| K4 radius at apex, m | 142 | 142 | **150** | 157 |
| QSS lap (no wander), s | 76.344 | 76.344 | **76.657** | 76.808 |
| kept start | κ-line | κ-line | κ-line | owner (out of budget) |
| apexes over 1.47 g | K12 | K12 | **none** | K2, K12 |
| BMW fit lap / ref-on-line, s | 81.85 / 80.43 | 81.85 / 80.43 | 82.23 / 80.91 | 81.23 / 80.10 |
| run time (Node), s | 12.9 | 26.3 | **27.0** | 28.5 (budget) |

**Each start run to convergence** (the `--only diag` run; QSS lap / fit K12 apex / fixed-v_ref K12 demand):

| start | no penalty | penalty λ 0.5 |
|---|---|---|
| (a) κ-line | 76.344 s / 1.78 g / 1.76 g, 26 sweeps, 12.6 s | 76.657 s / 0.99 g / 1.55 g, 26 sweeps, 13.3 s |
| (b) owner path | 76.766 s / 1.73 g / —, 23 sweeps, 13.2 s | 76.686 s / 1.53 g / 1.43 g, 25 sweeps, 12.5 s |
| (c) min-time | 77.241 s / 1.76 g / —, 31 sweeps, 14.9 s | 77.812 s / 1.54 g / —, 30 sweeps, 14.3 s |

**Reading**

- **The multi-start alone changes nothing** on this setup. The κ-line start is still the fastest
  (76.34 against 76.77 and 77.24 s), so the start-dependence of §8 is now *bounded* rather than removed.
  - **Start (c).** The min-time start is the slowest in every run.
  - **The budget.** Its 8 probe sweeps cost ~10 s per start, because the early sweeps are the expensive ones.
    Three starts do not fit 28 s, so (c) stays optional and off by default.
- **The penalty works on the corners it can see.**
  - **K12 measured at the fixed v_ref.** It falls from 1.76 to 1.55 g from the κ-line start, and to 1.43 g
    from the owner's.
  - **The cost.** It costs the κ-line start 0.31 s. It gains the owner start 0.08 s, because the descent is
    local and the penalty steers it into another basin.
  - **K2, K4 and K6.** They stay under 1.47 g; K4 opens further, to 150 m.
- **The fit's K12 = 0.99 g is an alignment artefact, not the corner.** The penalised κ-line straightens the
  kerb-side part of K12 (R 53 → 61 m at 2060 m). `findCorners` then matches K12's apex 63 m later, on the
  exit-side peak.
  - **What that does to the speed.** The BMW's 106 km/h apex speed is put there, against the 132 km/h the
    fixed alignment has at that station.
  - **Where the demand really is.** On the fixed v_ref the line still asks 1.48–1.54 g between 2060 and
    2131 m. The "every apex ≤ 1.47 g" test therefore passes on the fit, and the new K12-demand test is red
    (1.55 g).
- **Keep-best rule.** With keep-best by QSS lap, the κ-line + penalty line is kept (76.657 against 76.686 s).
  Keep-best by objective (lap + penalty: 76.735 against 76.713 s) would keep the owner start's line: fit K12
  1.53 g, demand 1.43 g. The difference is 0.03 s either way.

**λ sensitivity** (a,b, run to convergence; kept = fastest lap):

| λ_g, s/(g²·m) | kept | lap, s | fit K2 / K4 / K6 / K12, g | K12 fixed-v_ref demand, g | K4 R, m |
|---|---|---|---|---|---|
| 0.2 | owner | 76.522 | 1.47 / 1.51 / 1.08 / 1.58 | 1.47 | 134 |
| **0.5** | κ-line | 76.657 | 1.41 / 1.33 / 1.15 / **0.99** | 1.55 | 150 |
| 2.0 | owner | 76.458 | 1.54 / 1.52 / 1.13 / 1.53 | 1.43 | 132 |

The fit's per-corner g is **not monotonic in λ**. Which start wins flips, and the alignment re-matches K4 and
K12 differently on every line. The fixed-v_ref demand is the steadier measure (1.43–1.55 g).

### 9.3 Sensitivity: 10 m control spacing (a,b + penalty, no budget)

| | 20 m (shipped) | 10 m |
|---|---|---|
| kept | κ-line | κ-line |
| QSS lap, s | 76.657 | **76.026** |
| K2 / K4 / K6 g | 1.41 / 1.33 / 1.15 | 1.54 / 1.49 / 1.17 |
| K12 apex / zone peak g (fit apex at) | 0.99 / 0.99 (2115 m) | 1.64 / 1.64 (2048 m) |
| K12 fixed-v_ref demand, g | 1.55 | 1.52 |
| K4 radius, m | 150 | 143 |
| over 1.47 g | none | K2, K3, K4, K12 |
| run time (Node), s | 27.0 | **49.6** (25.7 + 23.4) |

- **K12 changes.** The fit moves back to the kerb-side peak, at 1.64 g. The fixed demand barely moves (1.52 g).
- **The lap.** It gains 0.63 s, but the line puts K2/K3/K4 over 1.47 g. This is the §8.1 caveat again: finer
  bumps buy curvature that the 20 m stencil only half sees.
- **Runtime.** It does **not** stay under 30 s (49.6 s), so 20 m stays.

### 9.4 Browser (`tests/e2e/lapTimeLine.spec.ts`, Playwright, BMW v2 + Run036.dda loaded, κ 0, kerb 1.0)

- **The run.** Optimise line takes **26.0–26.5 s** from click to done; the worker reports 25.8–25.9 s. Start
  2/2 begins at 15.0 s. The lap goes 1:23.61 → 1:17.07 (rider mode, with wander).
- **The starts.**
  - **κ-line.** 76.657 s, identical to Node.
  - **Owner path.** 76.488 s, so the **owner path is kept**. It is read from the .dda session's Float32
    `gps_lon/lat` on the browser's lap 6 slice, not from the JSON trace, and it descends into another basin.
- **The fit on it.** K2 1.45, K4 1.37, K6 1.08, **K12 1.59 g** (zone 1.59). The fit laps 1:22.23 against
  1:19.81.
- **Screenshots** (`scratchpad/k12/`):
  - **K12.** `lt-map-K12.png`: K11 → K12 → exit; purple = optimised, blue = owner lap 6.
  - **The rest.** `lt-map-K12-exit.png`, `lt-map-K2-K4.png`, `lt-01-progress.png`,
    `lt-01b-progress-start2.png` ("start 2/2 (owner path) · 52 %"), `lt-02-done.png` and `lt-03-fit.png`.

### 9.5 Tests

- **`simLapTimeSerres`.** It now runs multi-start (κ-line + owner, when the gitignored Run036 is present) with
  the penalty. The run has no budget cut, so a loaded runner still converges.
  - **What passes.** Every start converges. The run beats κ 0.85 by > 1 s (76.66 against 80.50 s), K4 is
    ≥ 130 m (150 m), and the K12 zone is < 2 g.
  - **"Every apex ≤ 1.47 g (no exceptions)" passes.** The exception list is now empty, so the "except K12"
    test merged into it.
  - **New, red by design.** "K12 kerb → exit demand at the reference speed ≤ 1.47 g" fails at 1.554 g.
- **`simFreeTrajectory` (+5).**
  - **`forceInit`.** It starts from the init alone.
  - **`latGPenaltyS`.** 0.1 g over 20 m ≈ 0.1 s, and the term is zero on the QSS speed.
  - **The objective.** The objective is lap + penalty, and `lapTimeS` is the pure lap.
  - **Multi-start.** It keeps the fastest lap and reports "1/2 κ-line", "2/2 owner path".
  - **Budget.** The run stops at the time budget.
- **`simFitRider`.** The comment is updated; the v2 κ 0 min-curvature K2/K4/K6 exception test is unchanged.
- **Suite and typecheck.** The suite has 712 passing and 3 red by design: the two literal v1 BMW tests, and the
  K12-demand test above. Typecheck is clean for `tsconfig.app.json`, `tsconfig.json` and
  `scripts/tsconfig.json`.

### 9.6 Next

- **Measure K12 against a fixed alignment.** The fit re-aligns the reference to every line, and on wide-exit
  lines K4/K12 apex matching jumps between |κ| peaks (§8.6 third item). Until it is pinned, the fit's per-corner
  g on descent lines is not a reliable ceiling check. Two options: pin the fit's alignment to the start line's,
  or report the fixed-v_ref demand next to it.
- **Get K12 under 1.47 g at the fixed v_ref.** A hard(er) ceiling would do it: λ ≥ 2 on K12 alone, or an
  exact-penalty |excess| term. The quadratic leaves 0.1–0.15 g of residual, which the lap time buys back.
- **`fit-reference.ts --line-mode lap-time`.** `scripts/lib/fitLines.ts` still runs the §8 single start.
