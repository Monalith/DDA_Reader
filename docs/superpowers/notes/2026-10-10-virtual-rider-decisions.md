# SDD ledger — plan: docs/superpowers/plans/2026-10-09-virtual-rider.md

Spec: docs/superpowers/specs/2026-10-09-virtual-rider-design.md (read, binding authority)
Branch: feature/virtual-rider, created from 18d1bbf on feature/merge-dda
Repo: /Users/macbookmini/projects/DDA_Reader

## Pre-flight conflict scan

### Cross-task: every pair sharing a file or an interface

| Producer | Consumer | Interface checked | Result |
|---|---|---|---|
| T1 `tiles.ts` | T2 | `Mosaic`, `metresPerPixel`, `lngLatToPixel`, `SAT_ZOOM` | agree |
| T1 `tiles.ts` | T4 store | `buildMosaic`, `tileRangeFor`, `SAT_ZOOM`, `TileLoader` | agree |
| T1 `Mosaic.missing` | T2 + T4 | T2 `.some(Boolean)` → all unknown; T4 `.every(Boolean)` → throw | agree, but see F-1 |
| T2 `sim/types.ts` | T5 | T2 creates the file, T5 appends param types | agree, sequential |
| T2 `extractCorridor(track, mosaic, trace, opts?)` | T4 store call | 3-arg call | agree |
| T2 `Corridor` | T3, T4, T6, T9 | `{stepM, leftM, rightM, known}` | agree |
| T3 `corridorCache.ts` | T4 store | `serializeCorridor`/`deserializeCorridor`/`corridorKey` | agree |
| T3 `corridorService.ts` | T4 store | `fetchCorridor`, `putCorridor` | **F-2** |
| T3 `GET/PUT /corridors/{key}` | T3 client | key charset vs server allowlist | agree (`corridorKey` regex test pins it) |
| T4 `core/types.ts` mapLayers | T10 panel | `corridor`, `idealLine` keys | agree |
| T4 `SimPanel.tsx` | T10 | T4 skeleton, T10 full replace | agree, sequential |
| T4 `MapView.tsx` sources | T10 | T4 adds both sources + layers, T10 only sets `idealLine` data | agree |
| T4 store | T10 store | T4 adds corridor state, T10 adds sim state | agree, sequential |
| T5 `presets.ts` | T6, T7, T8, T9, T10 | `SimParams`, `clampParams`, `DEFAULT_SIM_PARAMS`, `presetById` | agree |
| T6 `buildLine` → `Line` | T7, T9 | `{points, curvature, cumDistM, lengthM, offsetM}` | agree |
| T7 `solve` → `Envelope` | T8, T9 | `{v, longG, latG, leanDeg, tS, lapTimeS}` | agree |
| T8 `riderChannels` → `RiderChannels` | T9 | `{tps, gear, rpm, dtc}` | agree |
| T9 `core/types.ts` Session | T10 | `source: 'sim'`, `isSim` | agree (T4 touched a different part) |
| T9 `simulate()` | T10 store | `(track, corridor, params, id, name, color)` → `{session, line, lapTimeS}` | agree |

### Per-task: does each task's own text agree with itself?

| Task | Tests vs code it specifies | Files created vs later touched | Result |
|---|---|---|---|
| T1 | projection, mpp, tile range, mosaic stitch, missing flag — all implemented | tiles.ts only | agree |
| T2 | **F-3** — one test's regex cannot match the message the code throws | types.ts, corridor.ts | **F-3**, plus **F-4** |
| T3 | TS round-trip/fingerprint/key + 8 python endpoint tests vs the code | cache, service, bridge | agree; service has no unit test (accepted, thin) |
| T4 | corridorGeoJson left/right/gap vs implementation (north track → left is west) | SimLayers, browserTiles, SimPanel | agree |
| T5 | preset ordering vs the table (p/w 0.140 < 0.332 < 0.516; κ 0.1 < 0.45 < 0.85) | presets.ts, types.ts | agree |
| T6 | corridor-bound, κ variance, fallback, deviation clamp, 1/r | line.ts | agree |
| T7 | analytic circle, straight clamp, lean cap, monotonicity, all-minimum | solver.ts | agree |
| T8 | lengths, ranges, throttle shut/open, delay ordering, TC, gears | rider.ts | agree |
| T9 | channels, 10 Hz, one flying lap, no NaN, braking, no corridor | toSession, index | agree |
| T10 | store tests vs actions; **F-5** in the e2e | store, panel, MapView, css | **F-5** |

### Findings and rulings

**F-1 — one flaky tile out of 54 discards the whole extraction.**
`extractCorridor` marks every section unknown when *any* tile is missing, and neither
`buildMosaic` nor `browserTileLoader` retries. A single transient 5xx then yields a 0 %
corridor after ~54 requests.
Ruling: add two retries with a short backoff inside `browserTileLoader`. It touches no
interface and no test, and the throwaway probe needed retries against the real host.
Cost if wrong: a genuinely unreachable host takes ~3× longer to report failure.

**F-2 — `fetchCorridor` would make a real network call inside node unit tests.**
T4 wires `void get().loadCorridor()` into `setTrack`, and T10's store test calls
`setTrack`. Global Constraints forbid tests touching `fetch`; Node 18+ has a global
`fetch`, so the test would attempt a live request to 127.0.0.1:8777 — slow and flaky.
Ruling: `fetchCorridor` and `putCorridor` return early (`null` / `false`) when
`typeof window === 'undefined'`. Browser behaviour is unchanged and the store stays
testable without mocks. Cost if wrong: a future SSR or node caller silently gets no
corridor instead of an error.

**F-3 — a Task 2 test asserts a regex the code cannot satisfy.**
`expect(() => calibrateAsphalt(m, [])).toThrowError(/no-traces|no samples/i)` matches
against the *message*, but the thrown message is "Corridor extraction needs loaded GPS
laps to learn what asphalt looks like. Open a session first." — neither alternative
appears. The test fails against correct code.
Ruling: assert the typed error instead — `CorridorError` with `code === 'no-traces'`.
That is what the production path keys off, so it is the better assertion anyway.
Cost if wrong: none; it is strictly stronger than the regex.

**F-4 — obfuscated index arithmetic in Task 2's search loop.**
`const d = (sign * s * o.stepM) / o.stepM;` is `sign * s` with the step cancelled, then
multiplied by `o.stepM` again two lines later. Correct, unreadable, and a review magnet.
Ruling: rewrite as a plain signed offset in metres. Behaviour identical.
Cost if wrong: none.

**F-5 — the Task 10 e2e asserts a brittle lap count.**
`expect(...).toContainText('2 laps selected')` assumes the example page starts with
exactly one selected lap, but commit f55fd25 made the app "start with the 1000 + 600
example laps", so the count may already be 2 before the simulator runs.
Ruling: assert the simulated lap is present by name instead of by count.
Cost if wrong: the e2e stops catching a regression where the sim lap fails to join the
workspace selection — the store test still covers that.

Scan complete: 5 findings, 5 rulings, all folded into the plan text before Task 1.

## Progress

BASE for Task 1: 3758c8d

**R-6 — `npm run typecheck` cannot pass; it was already failing before this plan started.**
Global Constraints say "typecheck must pass before every commit". Measured: 7 `error TS`
lines at BASE 3758c8d and 7 at Task 1's HEAD, none under `src/sim/`. The pre-existing
failures are in `src/core/workspace.ts`, `src/ui/TopBar.tsx`, `src/ui/panels/MathPanel.tsx`
and `tests/unit/reimport.test.ts` — all untouched by this plan.
Ruling: the constraint means "introduces no NEW typecheck error against the 7-error
baseline". Fixing unrelated pre-existing breakage is scope the user did not ask for and
would put unreviewed edits into four files this plan never touches. Every task is checked
against the baseline instead; the final review gets told the baseline exists.
Cost if wrong: the branch merges with the same 7 errors it started with, and a genuinely
new error could hide among them if a later check only compares counts rather than paths —
so the check is by path (`^src/sim/|sim.*\.test\.ts`), not by count alone.

Task 1: implementer haiku, agent abef068620a3adc81, commit 3b65ad3, 5/5 tests, 0 sim typecheck errors
Task 1 review: spec PASS exact. 1 Important (vacuous padding test), 2 Minor.

**R-7 — the padding test is plan-mandated and vacuous; the finding wins.**
`tileRangeFor`'s test derives tx0/tx1 from the same points it then checks, so every point
is trivially inside the range whether or not `padPx` is applied. Deleting the padding
terms from the implementation would leave the test green. I wrote that test into the plan.
Ruling: fix the test. A test that cannot fail is worse than no test — it buys false
confidence in exactly the function a later task depends on for mosaic coverage. The plan
mandated it, but the spec says nothing about this test, and test hygiene is the review's
to enforce. Cost if wrong: a few minutes of rework on a test nobody else depends on.

Task 1: minor (deferred): buildMosaic assumes the loader returns exactly TILE_SIZE^2*3
bytes; a malformed tile corrupts the mosaic silently instead of being flagged in `missing`.
Carry to Task 4 — it owns the real browserTileLoader.
Task 1: minor (deferred): CONCURRENCY=12 worker-pool draining is never exercised (tests
use 2 jobs). Real use requests ~54 tiles.
Task 1: fix round 1/5 (1 addressed, 0 open; commits 3b65ad3..7dec6c8) — re-reviewer independently
broke tileRangeFor and confirmed the test fails, then restored it.
Task 1: complete (commits 3758c8d..7dec6c8, review clean)

BASE for Task 2: 7dec6c8
Task 2: implementer sonnet, agent a5c1e3217c93a1d76, commit 04c1797, DONE_WITH_CONCERNS.

**R-8 — the plan contradicted itself on the calibration floor; resolve it in the test, not the guard.**
The brief's `calibrateAsphalt` throws when `sats.length < 10`, but the brief's own first test
passes only 3 samples and expects success. Both are my plan text. The implementer resolved it
by lowering the guard to `=== 0`.
Ruling: the guard goes back to a real floor (8) and the TEST supplies enough samples instead.
Rationale: Review Focus item 1 exists because a percentile over a near-empty sample set yields
meaningless thresholds that mask or pass the entire image; `=== 0` lets one stray pixel
calibrate the whole track. The production caller passes thousands of samples, so a floor of 8
can only ever fire on a genuinely empty or broken trace — which is exactly what it is for.
Cost if wrong: a pathological track with fewer than 8 valid GPS pixels is refused instead of
being calibrated from almost nothing. That refusal is the better failure.
Task 2 review (opus): spec PASS; geometry verified CORRECT empirically (reviewer built an
asymmetric fixture: eastward 3.5/8.5, reversed 8.5/3.5 — no mirror, tracks travel direction).
Test hygiene weak: reviewer mutated the implementation 3 ways and all 6 tests stayed green —
(a) hard-wire known=false, (b) flip nyPx sign (mirror L/R), (c) gapTolerance 0.
3 Important → fix loop. 5 Minor → deferred below.

**R-9 — Minor 1 joins the fix round rather than being deferred.**
The reviewer notes my R-8 ruling was satisfied in letter but not intent: the widened test
passes 23 samples that are all the identical grey, so the percentiles are still unexercised
and the test's own name ("reject the field") is never asserted.
Ruling: fold it into this fix round. It is not an unrelated minor — it is the same defect
class as Important 1 (a test that cannot fail), in the very test my previous ruling created.
Deferring it would park a known-hollow test that I personally asked for.
Cost if wrong: one extra small edit in a file already being edited.

Task 2: minor (deferred): known[] is computed after medianFilterWrap, so a short pit-lane
leak (<=7 of 15 vertices) is laundered into a plausible width instead of being flagged.
Carry to the tasks that consume `known` (T4 display, T6 line bounds).
Task 2: minor (deferred): systematic INWARD bias up to stepM (0.5 m) per side — the edge is
the last rounded-pixel sample still asphalt. Corridor reads up to 1 m narrow, one-sided, not
zero-mean. Carry to T6: racing-line clearance assumes `l - 0.4` already.
Task 2: minor (deferred): Corridor.stepM is lengthM/(n-1) on a closed loop with n segments —
high by n/(n-1). Informational field only; also feeds the tangent stencil immaterially.
Task 2: minor (deferred): CorridorError code 'tiles-failed' declared but thrown only in T4.
Task 2: ⚠️ reviewer could not verify the real-imagery claim (Serres sat 0.069 vs 0.239) from
synthetic fixtures whose separation is far larger (0.03 vs 0.58). RESOLVED BY PLAN STRUCTURE:
Task 4 Step 10 is a visual-verification gate on live Serres tiles, which is exactly this check.
Not a gap — recorded so the T4 gate is not treated as optional.

FIX_BASE for Task 2 round 1: e63ef41
Task 2: fix round 1/5 (4 addressed, 0 open; commits e63ef41..72f0209) — re-reviewer independently
reproduced the mirror and known-hardwire mutations and confirmed red, then restored byte-exact.
9 tests (up from 6), suite 321/321.
Task 2: complete (commits 7dec6c8..72f0209, review clean)
Task 2: minor (deferred): the implementer used a `Co-Authored-By: Claude Sonnet 5` trailer on its
commits instead of this session's `Claude Opus 5 (1M context)` — each subagent follows its own
attribution reminder. Cosmetic git-history inconsistency; not worth a fix round.

BASE for Task 3: 72f0209
Task 3 review (opus): spec PASS verbatim, no deploy. Reviewer independently reproduced the
token and fingerprint mutations (red), probed corridorKey with 10 hostile/exotic names (all
match the server allowlist), and confirmed no test in this diff is vacuous — the pattern from
T1/T2 did not recur. 4 Important, 9 Minor.

**R-10 — Issue 4 is a defect in MY spec and it defeats the user's stated requirement.**
The user asked for "the corridor is created once and stays on the server". The reviewer showed
that can essentially never happen: `createTrackFromSession` calls `buildCenterline(lapTraces, 2)`
over THIS session's fastest laps (verified at src/state/trackActions.ts:127), and the S/F gate
comes from this session's own lap-1 GPS point. So every visitor's centerline differs in vertex
count, length AND first point — all three fingerprint fields — and `track.center` (their own
centerline's mean) can even produce a different storage KEY. Vertex-indexed storage is
unshareable by construction. The saving only ever materialises for the same user reloading.
Ruling: change the stored format to **geographic edge polylines** (`leftEdge`/`rightEdge` as
LngLat[]) and project the visitor's own centerline onto them on load, deriving leftM/rightM per
vertex. That is origin-independent, rotation-independent and centerline-independent, so it is
strictly more robust than arc-length resampling (which would still need a shared S/F origin).
The fingerprint relaxes to a geometric sanity check (centre within ~500 m, length within ~10 %).
Scope: this is a design change, not a finding — it becomes **Task 3b**, inserted before Task 4,
because Task 4's store wiring is the first consumer. Tasks 4/6 consume `Corridor` unchanged, so
only the serialisation boundary moves.
Cost if wrong: ~80 lines plus tests spent on sharing that, if the user only ever uses this
single-user, was never needed. Cheap against silently shipping a "shared" store that shares
nothing.

**R-11 — Minors 7 and 13 join the fix round; the rest defer.**
Minor 7 (deterministic `<key>.json.tmp`, concurrent writes can rename a corrupt file into place)
is the direct cause of Important 2's permanent-500 state, so fixing 2 without 7 leaves the hole
that creates it. Minor 13 (`corridors/` unignored, local dev writes land inside the repo) is a
repo-safety hazard the user's own notes already warn about for this tree (`git add -A`).
Cost if wrong: two small extra edits in files already being changed.

Task 3: minor (deferred): token comparison not timing-safe (use secrets.compare_digest); no
rate limiting on PUT.
Task 3: minor (deferred): 503 body names DDA_CORRIDOR_TOKEN, disclosing config state.
Task 3: minor (deferred): ORIGIN_TOLERANCE_DEG comment says metres, value is degrees (value is
correct and well chosen; comment only).
Task 3: minor (deferred): dead code in corridorKey — final slice(0,64) and the `t` prefix
fallback are unreachable.
Task 3: minor (deferred): `known` array passed by reference in both serialize and deserialize;
leftM/rightM are copied. Aliasing bug waiting to happen.
Task 3: minor (deferred): resolved-parent check in _corridor_path is unreachable given the
allowlist; honestly labelled belt-and-braces, keep.
Task 3: minor (deferred): test gaps — GET on a corrupt file, GET's bad-key 400 branch, absence
of the .tmp sibling after a successful write, wrong-typed payload fields.
Task 3: ⚠️ reviewer flagged "where does the write token come from — if a later task ships it in
client-side JS the guard is void". RESOLVED BY DESIGN: the plan's Task 10 puts it in a password
field the user types, persisted per-browser in localStorage. It is never in the bundle. Only the
token holder can publish, which is the intended and recorded limitation.
Task 3: ⚠️ nginx client_max_body_size on kos-web unknown — decides whether Issue 1 is Important
or Critical. Checking before the deploy step; Issue 1 is being fixed regardless.

FIX_BASE for Task 3 round 1: 21feb04
Task 3: fix round 1/5 (5 addressed, 0 open; commits 21feb04..8537645) — re-reviewer verified the
guard ORDER by execution: unauthenticated PUT with a 5 MB malformed body now returns 401 with a
24-byte response (was 422 with 8.4 MB). Corrupt-file GET self-heals to 404 and unlinks. No
.json.tmp orphans after success or forced failure. TS 10/10, python 33/33.
Task 3: complete (commits 72f0209..8537645, review clean)
Task 3: minor (deferred): with no Content-Length (chunked), `await request.body()` buffers the
whole body before the 413. Reachable only by a caller who already holds the write token, so
Important 1's amplification is fully closed; this is a token-holder memory vector only.

BASE for Task 3b: 8537645 (plan committed at 9e4a7f1-ish; see git log)
Task 3b: implementer sonnet, agent ad298218d362931f7, commit f8b0e3f, TS 9/9 + 330/330, py 33/33.
Implementer caught a real bug in my brief: MAX_EDGE_DIST_M = 30 let the nearest-point search
bridge straight through a deliberately-unknown 40 m gap (~20.5 m to the nearest known point on
the test circle). Tightened to 12 m, mutation-verified in both directions.

**R-12 — accept 12 m, and let Task 4's visual gate be the real judge.**
The constant trades gap sharpness against tolerance for an offset centerline. At 12 m, a track
at the 18 m width ceiling (9 m half) whose visitor centerline sits >3 m off-centre would mark
that side unknown; at 30 m, real gaps get bridged, which the test proves. Neither value is
derivable from first principles and both are defensible.
Ruling: take 12 m. Over-reporting "unknown" is the safe failure — the line generator falls back
to a uniform half width — whereas bridging a pit-lane gap silently widens the corridor into
somewhere the bike cannot go. Task 4 Step 10 renders the corridor over live Serres imagery, so
if 12 m is too tight it will be visible as gaps in ordinary corners rather than only at the pit
lane. Revisit there with evidence instead of guessing now.
Cost if wrong: wide circuits lose corridor on one side and fall back to the uniform width,
which is the behaviour they would have had anyway without a corridor.

FIX/REVIEW BASE for Task 3b: a09a892
Task 3b review (sonnet): spec PASS, quality PASS, no Critical/Important. Reviewer independently
reverted deserializeCorridor to v1 behaviour and confirmed the central sharing test goes red,
and mutated MAX_EDGE_DIST_M back to 30 and confirmed the gap test goes red. Security tests in
test_bridge.py confirmed byte-for-byte unchanged.
Task 3b: complete (commits a09a892..f8b0e3f, review clean)
Task 3b: minor (deferred): the "rejects malformed input" NaN-in-leftEdge case is masked by an
earlier length-mismatch short-circuit, so it never exercises the per-point isLngLat validation
it appears to target — deleting that loop leaves all 9 tests green. The logic itself is correct
(reviewer verified with a same-length fixture). Inherited verbatim from my brief. ONE-LINE FIX:
make that fixture the same length as the stored arrays. Flag to the final review.
Task 3b: minor (deferred): nearestEdgeDistM uses nearest-VERTEX, not nearest-point-on-segment.
~0.2 m error on a 200 m circle, but on a tight hairpin where the offset edge folds over itself
it could report a confidently wrong width instead of unknown. Serres has hairpins — Task 4's
visual gate is the place this would show.

BASE for Task 4: f8b0e3f
Task 4: implementer sonnet, agent a4858bf1b7814d252, commit 828f570, 2/2 + suite 332, typecheck clean.
First attempt failed the visual gate because MY brief used ?example=serres_R6_1-19-849 — that param
takes an EXAMPLES id, not a filename, and App.tsx:14 loads nothing under automation without a valid
one. Fixed in the plan (a52be68) and re-run with ?example=bike1000.

VISUAL GATE, judged by me on /tmp/sim-fit.png and /tmp/sim-k2-hairpin.png:
PASS overall — the orange/cyan edges trace the whole Serres circuit and sit on the real asphalt at
every corner I can see at 100 m zoom. Two defects at 20 m zoom.

**R-13 — the K1 defect is NOT the nearest-vertex projection; the implementer misdiagnosed it.**
`fetchCorridor` needs a bridge, none is running locally, so it returned null and the corridor on
screen is the DIRECT extraction output — `deserializeCorridor`'s projection never ran. The real
causes are two, and both are mine:
 (a) Task 2's deferred minor, now proven to matter: `known[]` is computed from the MEDIAN-FILTERED
     widths, so a short leak across the K1 infield is laundered into a plausible width instead of
     being rejected by the 18 m ceiling. That is the diagonal cyan line crossing the dirt, and it
     is consistent with the median width coming back 15.0 m against a ~12 m circuit.
 (b) `SimLayers.offsetPoint` builds its normal from +-1 vertex while `corridor.ts` uses a +-10 m
     stencil. At a hairpin those two normals differ materially, so what is drawn is not what the
     physics would consume.
Ruling: fix both before Group B. (a) requires a vertex to pass the width checks on the RAW widths
as well as the filtered ones — the filter keeps smoothing, but it stops laundering. (b) makes the
renderer use the same stencil as the extractor.
Rationale: Group B builds the racing line inside this corridor. A laundered 20 m width at K1 means
the line generator is told it may use the infield, and the lap time that comes out is wrong in a
way no unit test would catch. 78 % resolved is already below the 85 % the plan expected, and (a)
will push it lower — that is correct, not a regression: honest unknown beats invented asphalt.
Cost if wrong: a stricter `known` could mark genuinely good sections unknown, and those fall back
to a uniform half width. Visible immediately on the next gate run.

FIX_BASE for Task 4 round 1: 828f570
Task 4: fix round 1/5 (2 addressed, 1 NEW found; commits 828f570..912bccd). Defects A and B fixed
and mutation-verified. % resolved 78 -> 75, median width 15.0 -> 14.5 m — both moved the right way.
But the K1 diagonal PERSISTS: the implementer's diagnostic found a third, distinct cause. At the
hairpin the perpendicular search reaches ACROSS THE FOLD to the adjacent leg's real asphalt,
giving left=2 m / right=16 m at vertices ~1431-1470 of 1561 — a 18 m total that sits under the
ceiling, so no guard fires. Correct diagnosis; neither of my two fixes could have caught it.

**R-14 — bound the search by the local radius of curvature.**
The search half-width is a flat 25 m, but at a hairpin of radius r the opposite leg is only ~2r
away, so a 20 m hairpin puts real asphalt 40 m away and a 25 m search finds it. No width ceiling
can tell that apart from a wide track, because 2+16 is a perfectly ordinary width.
Ruling: cap the per-vertex search at `min(halfSearchM, 0.9 / |curvature|)`. A 20 m hairpin gets an
18 m cap and the opposite leg becomes unreachable; a straight has ~zero curvature and keeps the
full 25 m. The curvature is already computable from the centerline the extractor holds, so this
costs one pass and no new inputs.
Rationale: this is the last defect gating Group B. The racing line is generated INSIDE this
corridor, so a 16 m right-side reading at K1 tells the line generator it may run the bike through
the infield onto the opposite straight. That is not a cosmetic error — it is a lap time that is
wrong for a reason no unit test downstream would surface.
Cost if wrong: genuinely wide sections inside tight corners get clipped to 0.9r and the corridor
reads narrower there than it is. The racing line stays on the track; it just has less room than
it really has. That is the safe direction.
Task 4: fix round 2/5 (curvature cap implemented + mutation-verified on its own synthetic hairpin
test; commit 61dc500). K1 UNCHANGED. Implementer's diagnostic: at vertices 1425-1473 the +-10 m
stencil curvature reads near-straight (implied radius 164-1286 m), so the cap never engages. It
stopped rather than guess a fourth theory, exactly as instructed. % resolved 75, median 14.5 m.

**R-15 — K1 is a parallel-asphalt leak, not a hairpin fold; reject by the circuit's OWN median width.**
The section is near-straight with a 2 m / 16 m split, so there is real asphalt ~16 m to one side of
a straight piece of track: the pit lane or a parallel service road. My original probe flagged
exactly this zone (9.4 % of sections saturating at the search limit — pit lane, run-off, paddock).
No curvature or centerline test can catch it, because the pit lane is not near the centerline at
all; and the run is ~40 vertices long, far too long for a 15-wide median to smooth away.
Ruling: mark a vertex unknown when its width exceeds 1.6x the MEDIAN WIDTH OF THIS CIRCUIT,
computed over the vertices that already passed the other checks. Self-calibrating, so it needs no
new magic absolute: a genuinely wide circuit has a high median and its wide sections still pass,
while a 12 m circuit rejects an 18 m reading. The absolute 18 m ceiling stays as a backstop.
Rationale: this is the last thing gating Group B, and it is cheap and principled. If it does not
work I accept the corridor as it stands — 75 % resolved and visibly on the asphalt everywhere I
looked — and record the leak as a known limitation rather than spend a fourth round.
Cost if wrong: a circuit with genuinely varied width (a wide start straight into a narrow infield)
loses its widest sections to the fallback uniform width. Visible on the next gate run.
Task 4: fix round 3/5 — fresh implementer on OPUS (previous agent's transcript was gone, could not
resume). Commit c7f6125. Gate: known[i] cleared when width > 1.25 x p10(this circuit's known
widths), 18 m ceiling kept as backstop. Threshold DERIVED from a live extraction dump, not guessed:
Serres known widths p1 12.5 / p10 13.0 / p25 13.5 / p50 14.5 / p90 16.5 / p100 18.0, MAD 1.00.
Every median/MAD-anchored candidate lands above 18 m because the contaminated centre drags it up;
p10 = 13.0 matches the published ~12 m. The leak run reads 16.5-18.0 so the limit must sit below
16.5; the honest body runs to 16.0 so it must sit at/above 16.0 -> factor window (1.231, 1.269),
and 1.25 is its centre. Pit-lane run 1425-1473: 32 resolved -> 0. Mutation: gate removed -> red;
anchor swapped to the median -> red (so the lower-quantile choice is pinned by the test too).
Suite 370 passing. % resolved 75 -> 65, median width unchanged at 14.5 m.

**R-16 — accept Task 4. The residual K1 reading is not worth deleting real track for.**
The implementer showed the surviving K1 vertices read exactly 16.0 m, one search step under the
limit, and that the honest 12.5-13.0 m readings are ALREADY 38-48 % strongly asymmetric because
the centerline is a GPS racing line that genuinely runs off-centre. The 16.0 m bin is
statistically indistinguishable from 15.5 m, and tightening below 16.0 would cost 222 rejections
instead of 121 with no evidence the extra 100 are leaks. It stopped rather than reach for a fifth
theory, which is the right call: that would be deleting real track to improve a screenshot.
Ruling: Task 4 is done. The corridor is 65 % resolved, visibly on the asphalt everywhere I looked,
and the remaining 35 % falls back to a uniform half width — the same behaviour as having no
corridor at all, which is a safe failure.
Cost if wrong: the simulated line gets slightly more room than it should on a short stretch behind
K16. Bounded and visible.

**R-17 — the 14.5 m median is probably not a defect.**
The implementer flagged that the median did not move and reads ~2 m above the published 12 m, and
called it a systematic over-read. I think it is mostly correct behaviour: `gapTolerance` bridges up
to 4 steps (2 m), so the corridor includes kerbs and paved shoulder — which is what a racing line
actually uses, and the plan's own expected band was 11-16 m. The line generator already subtracts
0.4 m per side and adds an explicit kerb margin on top.
Ruling: not a defect, record it. Revisit only if the simulated lines visibly run off the asphalt.
Cost if wrong: the corridor is ~1 m generous per side and the racing line is allowed onto the
kerb. For a motorcycle lap sim that is closer to right than a corridor stopping at the white line.

Task 4: minor (deferred): a hairpin-fixture assertion was flipped from known===true to false
because the new gate correctly refuses a 13.0 m reading on a 5 m fixture (a 2.6x outlier); the
curvature-cap coverage moved onto rightM, which is independent of known[] and still goes red
without the cap. Reasonable, but the final review should confirm that fixture still earns its keep.

**R-18 — moved to an isolated git worktree after finding a live concurrent writer.**
Mid-Task-4 I found uncommitted edits in the shared tree to exactly my plan's files — `sim/types.ts`
carrying Task 5's `MachineParams`/`TyreTrackParams`/`RiderParams` byte-for-byte, plus `store.ts`,
`SimPanel.tsx`, `MapView.tsx`, `presets.ts`, `panels.css`, and fixes that cleared the 7 typecheck
baseline errors. I asked the two busy peer sessions; both ruled themselves out with evidence
(projects-68 is in motoracelaps-ios and only read from this tree; projects-e7 is in kudosim).
projects-e7 then stat'ed the files and found three written in a single pass at 08:58:40 — AFTER I
sent my message — so it is a live writer, not stale work to plan around.
Ruling: `git worktree add ../DDA_Reader-vr -b feature/virtual-rider-wt c7f6125`, node_modules
symlinked, suite verified green there (12/12 on simCorridor). Tasks 5-10 run in the worktree.
Rationale: I cannot coordinate with a session I cannot identify, and "avoid those files" does not
hold when the file set is still growing. A worktree makes it a non-problem without touching one
byte of anyone else's work — which is not mine to discard. Both peers independently suggested it.
Cost if wrong: a later merge of feature/virtual-rider-wt into feature/virtual-rider has to
reconcile whatever the other writer commits. That is a visible, ordinary merge, versus two sessions
silently overwriting each other in one checkout.
Note: the shared tree keeps `feature/virtual-rider` at c7f6125 plus the other writer's uncommitted
work, untouched.
Task 4 review (sonnet): spec PASS, quality PASS. Reviewer verified the four gates compose
monotonically (the p10 gate can only tighten, never loosen), confirmed the p10 pass reads a frozen
snapshot of known[] before mutating it (not self-referential), and grepped that the tangent stencil
really converged to one definition imported by renderer and serializer. 0 typecheck errors, 370/370.
Task 4: complete (commits a52be68..c7f6125, review clean)
Task 4: minor (deferred): the flipped hairpin test still pins the curvature cap, but via its
`rightM < 12` assertion, NOT via `known === false` — with the cap removed `known` is still false,
just for a different reason (the absolute ceiling). The test is not decorative; the report's
framing was only half right. For the final review.
Task 4: minor (deferred): `extractCorridorNow` has no guard against the active track changing
during the ~15 s tile fetch, unlike `loadCorridor` which checks `activeTrack(get())?.id`. Switch
tracks mid-extraction and the old track's corridor is installed against the new one. Verbatim from
my brief, so not an implementer defect. ONE-LINE FIX — fold into Task 10, which touches the store.

Task 5: implementer haiku, agent a3c8ce5425412b8c4, commit 4fe330a, 6/6. Mutations: swapping the
250/600 power figures -> red; stripping clampParams to identity -> red.
BASE for Task 5: c7f6125
Task 5 review (sonnet): spec PASS, quality PASS with findings. Reviewer checked the preset
arithmetic by hand (p/w 0.140 < 0.332 < 0.516 < 0.545; kappa 0.1 < 0.45 < 0.85; lean 52<56<58<59)
and reproduced the clamp-identity mutation. 1 Important: the clamp test never covered cgHeightM,
the wheelie-limit divisor — proven by setting its bound to 0 and watching all 6 tests stay green.
Task 5: fix round 1/5 (1 addressed + 1 minor; commit f9541d1) — cgHeightM and wheelbaseM added to
the divisor test, lean-limit test extended to the full chain. Mutation: bound to 0 -> red.
Task 5: complete (commits c7f6125..f9541d1, review clean)
Task 5: minor (deferred): presets.ts's header cites Cycle World for "mu is shared across the
classes" but the data has mu rising 1.25 -> 1.35. MINE to resolve — the citation supports equal
lateral g on identical tyres, while the presets model different tyre classes, so the comment is
the thing that is wrong, not the numbers. Fix the comment in Task 11's pass.
Task 5: minor (deferred): per-element gearRatios are unclamped; no slider exposes them yet.

Task 6: implementer sonnet, agent ab705f65c0f1035d2, commit cd518e3, 6 tests (one beyond the brief),
suite 347. Found TWO real bugs in MY brief:
 (a) the corridor-bound test could not fail — the 5 m default fallback was narrower than the test's
     6 m corridor, masking a buildLine that ignored the corridor entirely. Added a 3 m-corridor test
     that does go red.
 (b) `polylineCurvature`'s third triangle side used the sign-flipped vectors (|p2+p0| instead of
     |p2-p0|), understating curvature ~20x on a 100 m circle. Confirmed against corridor.ts's
     already-correct stencilCurvature.
Also replaced solveOffsets' fixed push-to-box-edge shortTarget with an anti-diffusion sharpening
term (SHARPEN_GAIN 0.5), after sweeping the original coefficient over [0.01, 0.99] and finding it
could never produce the kappa ordering on a corridor with no shape contrast.

**R-19 — accept the SHARPEN_GAIN substitution.**
The brief's shortTarget translated the whole loop uniformly instead of concentrating curvature, so
it could not express kappa at all on a constant-radius fixture. The implementer swept it and showed
only noise-level flukes. Ruling: take the anti-diffusion term; it is bounded by the existing box
clamp and it actually produces the property the plan requires. Its own concern stands — it is
unvalidated on a real track with straights and corners, which Task 11's cross-check against the
BMW lap will exercise.
Cost if wrong: the line looks ragged on a real circuit and SHARPEN_GAIN needs retuning. Visible.

**R-20 — three user requirements folded into the plan (commit 6aeab58).**
After seeing the first screenshots the user asked for: a real throttle<->brake transition (no step
from 100 % throttle to 100 % brake); two trail-braking sliders, depth and release profile; and a
warning if the settings imply a crash.
Ruling on where each belongs: DEPTH goes in the SOLVER, because how far braking is carried changes
the velocity envelope (it scales the longitudinal share taken from the friction ellipse at lean).
PROFILE goes in the RIDER layer, because it changes only the trace. The transition itself is
asymmetric RATE LIMITS on two now-separate channels (tps and brake) plus mutual exclusion with a
1.15 overlap allowance — that is what makes an instantaneous flip impossible rather than merely
discouraged. The risk warning reads a new `grip_use` channel (friction-circle demand) and fires
above 0.98.
Also added Task 11: cross-check the virtual rider against the real BMW 1:19.81 Serres lap channel
by channel, with the deliverable being a documented comparison including what still does not match.
Cost if wrong: the rate-limit constants are estimates. Task 11 measures the real transition time
off the BMW lap and is the place to correct them.
Task 6: complete (commit cd518e3) — review deferred to the final whole-branch review; the task's own
findings were self-caught and are recorded above (R-19).
Task 7: implementer sonnet, agent aacc87de850075ce8, commit f57dd07, 17 new tests, suite 358/358.
Added gripUse to Envelope, trailBrakeDepth/trailBrakeProfile to RiderParams + clampParams defaults
(0.6 / 0.6). Mutations 1-3 red as required. Mutation 4 is a FINDING it raised itself: the
"never exceeds the friction circle" test is trivially satisfied by an all-zero gripUse, so it is
not proof the channel is populated — the companion "tracks the demand" test is what catches that.
Honest call, both kept.
BASE for Task 7: cd518e3
Task 8: implementer sonnet, agent ab794831a47af1fdc, commit d8242f6, 21 tests, suite 379/379.
FOUR of its five mutation checks exposed tests that could not fail (OVERLAP clamp, gear constant,
dtc zeros, plus a type bug in my own trailBrakeProfile test where whole RiderChannels objects were
passed where Float32Array was expected — vitest's untyped transform silently gave both sides
fallRate 0). All fixed and re-verified red/green. Best self-auditing of any task so far.

Task 6+7 review (opus): Task 7 COMPLIANT and physics verified by hand. Task 6 FAILS.

**R-21 — Task 6's kappa mechanism is broken and the shipped default is on the wrong side of it.**
The reviewer derived the per-sweep gain of the checkerboard mode as 1 + OMEGA*(2*wShort - wCurv - 1),
which exceeds 1 exactly when kappa > 2/2.85 = 0.7018, and measured the threshold to match. With the
in-sweep clamp removed and lineDeviationM 0, max|offset| is 289 m at kappa=0.85 and 2.2e7 m at
kappa=1 on a 6 m corridor; with the clamp it saturates into a +-6.1 m vertex-to-vertex saw-tooth.
On a 977 m synthetic oval that gives r_min 2.1 m and a 114 s lap against 26 s at kappa=0.
DEFAULT_RIDER.kappa is 0.85, and so are the 1000 and panigale-v4 presets. And below the threshold
kappa does nothing useful either: max|offset| FALLS 0.42 -> 0.24 m as kappa goes 0.5 -> 0.70, and
the variance ordering the tests assert holds only by crossing the instability, non-monotonically.
Ruling: replace the anti-diffusion term with the standard racing-line blend — minimum CURVATURE at
kappa=0 (widest arc, the C line) against minimum DISTANCE at kappa=1 (shortest path, which cuts to
the inside and concentrates the turn, the V line). Both are stable averaging operators. The
Gauss-Seidel target becomes
    target = (p + q)/2 + (1 - 2*kappa) * baseCurv[i] * h^2 / 2
so the two objectives are the SAME expression with opposite sign: +k0h^2/2 straightens (minimum
curvature), -k0h^2/2 pulls to the inside (minimum distance), and kappa=0.5 is pure smoothing.
Checkerboard gain is |1 - 2*OMEGA| = 0.2, unconditionally stable.
Rationale: this is the textbook formulation, it is what the research in the spec actually describes,
and unlike the previous two attempts it is stable BY CONSTRUCTION rather than by clamping. R-19
accepted the anti-diffusion term on the evidence then available; that evidence was a constant-radius
fixture, which is exactly the case where a uniform translation and a real shape change look alike.
R-19 is superseded.
Cost if wrong: a third attempt at the line generator. Bounded — the solver, the rider layer and the
corridor are all independently verified and unaffected.
Task 6 fix round (opus, commit 12bbc65): kappa mechanism replaced with the minimum-curvature /
minimum-distance blend. Now stable at every kappa (clamped == unclamped throughout), line length
monotone 986.4 -> 965.8 m as kappa 0 -> 1, lap 28.07 -> 26.16 s. 11 mutations applied, 11 killed —
and TWO of its first attempts survived and it caught them itself (a wrong stencil that happened to
land on a circle's own arc still read 1/60; a gripUse test where the 250 was drag-limited just below
the lean limit so even the broken code read 0.998). It also corrected MY sign: this file's
convention is d>0 = left, so `2*kappa - 1` is right and my `1 - 2*kappa` labelled minimum distance
as minimum curvature. Suite 394.

**R-22 — the user's three observations have one root cause, which the implementer already named.**
User, watching the running app: (1) too many throttle/brake transitions; (2) the sim tops out at
240-250 km/h on the straight where the real BMW reaches 270; (3) it is far too slow in fast corners
whatever the settings.
(3) and (2) are the same defect. `solveOffsets` is Gauss-Seidel at OMEGA 0.6 over 60 sweeps, which
diffuses about 8 vertices — roughly 16 m. The implementer's own concern #1 says it plainly: offsets
form a boundary layer around each curvature feature and the line "does not set up for a corner from
far out". A racing line through a fast sweeper is fast precisely because it uses the full width to
MAXIMISE RADIUS, and that requires setting up hundreds of metres early. With a 16 m horizon the line
keeps the centerline's own radius, so `v = sqrt(a_lat*r)` is capped far too low in fast corners —
and the low exit speed is then never recovered on the straight, which is (2). Checked the top-speed
maths: `topSpeedMs` for the 1000 gives ~88 m/s = 317 km/h, so 240-250 is not a drag limit, it is a
corner-exit deficit.
The implementer also named the correct fix and scoped it out: more sweeps make it WORSE because
minimising curvature around a closed loop has an unconstrained zero mode (a uniform offset), so the
solve drifts onto one wall. The fix is a GAUGE CONDITION — pin the mean offset — after which more
sweeps genuinely converge to the global minimum-curvature line.
Ruling: fix it. Pin the mean offset each sweep, then raise the sweep count until the line converges,
coarse-to-fine if a flat sweep count is too slow to keep the sliders live.
(1) is separate: the QSS envelope has many small local speed minima, so `longG` changes sign often
and the rate limiter faithfully reproduces every one. Needs a low-pass on the demand plus a
dead-band, so a 2 km/h dip does not become a brake application.
Cost if wrong: the line generator takes a fourth pass. Everything else is independently verified.
Task 6 fix round 2 (opus, commit fb889d3): all three user observations fixed and MEASURED.
Sweeper apex 116.6 -> 173.9 km/h; straight-line top speed 195.5 -> 275.0 km/h (the user's 270
complaint); lap 79.14 -> 62.64 s; brake applications per lap 72 -> 9; simulate() 1.32 -> 3.18 ms,
well inside the ~50 ms budget. 405 tests. 10 mutations, 10 killed — and TWO survived its first
attempt (hysteresis and low-pass each passed by the other's mechanism) which it caught and fixed by
choosing observables that isolate each: a 0.5 Hz oscillation the filter passes for the hysteresis,
and per-sample ripple rather than brake level for the low-pass, because the rate limiter ratchets
the level up regardless.

**R-23 — my diagnosis was half wrong, and the implementer's correction is the better one.**
I attributed the slow fast-corner to a 16 m solver horizon. The gauge + convergence did help
(sweeper median 249.4 -> 283.4 at that stage), but the implementer then derived that the widest arc
through a 90 deg / 250 m corner in a 12 m corridor is only 256.1 m — a 2.4 % radius gain — so the
horizon was never worth 85 km/h. What was actually costing it was NOISE in the curvature feeding
`v = sqrt(a_lat*r)`: a scattered centerline made the sweeper's minimum radius read 80.7 m against a
true 250 m. Fixed at the source with a 10 m centred moving average, window size chosen by
measurement (the largest that still reads a 25 m hairpin as tighter than it is; at 20 m+ it reads it
as wider, which would report an unrideable lap as rideable).
It also found that the linearisation `k_eff = k0 + d''` makes a constant offset free, which is why
a converged solve pinned the inside edge of every corner, and that the missing `k0^2*d` term removes
the need for a gauge condition at all.
Ruling: accept all of it. Also accept its weakening of one existing kappa test from strict to
non-increasing per step — the converged solve saturates that circle fixture's box at both ends, so
the test was wrong, not the code; it strengthened the end-to-end assertion instead and M10 confirms
"kappa ignored" still goes red.
Cost if wrong: CURV_SMOOTH_M is a fixed 10 m rather than sized from the measured scatter, so a much
noisier centerline would still bleed radius. Task 11 measures this against the real BMW lap.

**R-24 — kappa=0.85 is the wrong line for a fast corner, and that is now the biggest known gap.**
The implementer's remaining concern (a): a minimum-distance line is right for a hairpin a 1000 can
point-and-shoot out of, and wrong for a fast sweeper where radius is everything. A single lap-wide
kappa cannot express both, which is why the user still sees the sim behind the BMW in fast corners.
Ruling: note it, do not fix it now. A corner-speed-dependent blend is a design change of its own,
and Task 11's cross-check against the real lap is where the evidence for its shape comes from —
building it before that measurement would be guessing. Recorded as the top candidate for the next
round of work.
Cost if wrong: fast corners stay slower than the real rider. Visible, bounded, and already visible
to the user.
Task 9: implementer sonnet, agent ae86d164fb6f69255, commit b4798d5, 411 tests. Mutation 5 exposed
ANOTHER vacuous test in my brief: the "faster with harder braking" test used a pure circle, where
the braking pass has nothing to do, so brakingG was a no-op and toBeLessThanOrEqual passed on equal
lap times. Swapped to a closed oval with a real braking zone and tightened to strict toBeLessThan.
Sanity: cornerLine 13.95 s, 300 m circle 30.74 s via solve(), 30.39 s end-to-end via simulate().
BASE for Task 10: b4798d5
Task 10: implementer sonnet, agent ade19535c34d5bc11, commit 82f0bd9, 417 unit + e2e. Visual gate
PASSED all 8 checklist items. Simulated lap 1:24.97 against the real BMW 1:19.81 — 6.5 % slow.
Caught two more unfalsifiable tests in my brief (brakingG on a circle again; an e2e that only checked
the map source existed, not that it was populated) and a stray vite server from the MAIN repo
squatting on port 5190, which made its first mutation runs silently test the wrong codebase.
Reported a lap-time cliff exactly at kappa=1 on this circuit's tight sequence — recorded, not patched.
Task 10: complete (commit b4798d5..82f0bd9)

**R-25 — "a rider brakes once per corner" is a structural property, not a smoothing parameter.**
User, watching the app: "A rider brakes only once in a corner. There is no throttle-brake
oscillation." The dead-band from R-23 cut chatter but left ~1.8 applications per corner, because it
filters a per-sample LEVEL and the user is describing an EVENT structure.
Ruling: post-process the brake demand into discrete events before the rate limiter — find runs above
the onset threshold, merge runs separated by less than MERGE_GAP_S, drop runs under MIN_EVENT_S,
reshape each event to rise-then-fall monotonically, and zero the throttle for the event's duration.
Keyed by gap rather than by turn.sRange so riderChannels' signature stays (line, env, params).
Result (commit 1981f1c): applications per corner 1.8 -> 1.0 exactly, overlap samples 68 -> 3, lap
time bit-identical. On a second synthetic fixture with handwritten chatter, 3/corner -> 1/corner.
The implementer again caught its own unfalsifiable test before shipping — its first fixture used a
0.2 s micro-gap that the pre-existing 0.12 s low-pass already swallowed, so it passed against the
unfixed code; widened to 0.5 s computed from the decay time needed to actually cross the threshold.
Cost if wrong: MERGE_GAP_S 0.8 s is unvalidated against real telemetry and could merge two genuinely
separate applications in a chicane. Task 11 measures it off the BMW lap.
Task 11: implementer opus, agent add148c460522d1ff, commit 69cb11c, 420 tests.
LAP 1:24.97 -> 1:20.47 against the real 1:19.81 — +0.8 %, explicitly NOT fitted (the smoothing scale
was bracketed by an implied-lateral-g test and by the hairpins, never by lap time).

**R-26 — my standing kappa hypothesis was FALSIFIED by the data, and the real cause was measurement.**
I had flagged "a single lap-wide kappa cannot be right; the 1000's 0.85 takes a point-and-shoot line
through fast sweepers" as the top candidate for the fast-corner deficit. Tested: across kappa 0 ->
0.95 the fast corners' radius moves ~3 m out of a 40 m deficit, and kappa = 0 — the corner-speed end
— is SLOWER overall. kappa = 0.85 actually has the smallest mean per-corner error. A corner-speed
blend would have been built on a wrong premise.
The real cause: the curvature channel at the 10 m scale was reporting the centerline's long-
wavelength wander as corners — local 2 m scatter is only 0.07 m, but 2.6 m rms against a 40 m mean
— which implied 5.7 g peak lateral and 464 m of lap over 1.6 g. Worst in fast corners, as 2e/L^2
predicts. Fixed by CURV_SMOOTH_M 10 m -> CURV_SCALE_M 20 m. R-24 is superseded: it named the right
symptom and the wrong mechanism.
Cost if wrong: 20 m is bracketed on both sides by physics, so the risk is a circuit whose real
corners are shorter than 20 m reading as straighter than they are. The hairpin bound is what guards
that and it was measured, not assumed.

**R-27 — the reference lap is not logged telemetry, and that caps what this cross-check can prove.**
`serres_BMW_1-19-81.json` has `gaz_pct` and `vites` NULL in all 3186 rows, and no GPS: lat/lon is a
hand-placed map line at +-15-20 m with distance integrated from speed. Only `hiz_kmh` and its
derivative are real.
Consequence: rider.ts's four rate constants CANNOT be measured from it, the real racing line cannot
be compared at all, and real lateral g is unknown (geometry implies 1.95 g even at the 20 m scale),
so mu = 1.33 stays an assumption worth about +-2.5 s per 0.1 — the 0.8 % agreement sits inside that
band. Ruling: record this prominently rather than let the 0.8 % read as more validation than it is.
Closing the remaining per-corner errors (K3 -11, K4 -15, K16 +12 km/h, which currently cancel in the
total) needs a centerline with real positional accuracy — satellite-traced edges or a GPS lap.
