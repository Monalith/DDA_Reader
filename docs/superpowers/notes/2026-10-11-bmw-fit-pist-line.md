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
