# The virtual rider against the real BMW lap (Serres, 1:19.81)

Task 11. Everything before this proved the simulator is internally consistent.
This is the first time it was put against a real lap.

**Result: 1:24.97 → 1:20.47 against the real 1:19.81** (+0.66 s, +0.8 %), and
the gap closed by fixing something that is not a bike parameter at all — the
length scale the *reference geometry's* curvature is measured over. The two κ
hypotheses the brief asked about were tested and **falsified**. Nothing in
`presets.ts` was changed.

---

## 0. What the reference actually contains — read this first

`public/examples/serres_BMW_1-19-81.json` is **not** logged telemetry. Its own
metadata says so:

- `"Yalnızca hız var; gaz, vites ve devir okunamadı."` — only speed; throttle,
  gear and rpm could not be read. Confirmed: `gaz_pct` and `vites` are
  **null in all 3186 rows**. The brief's suggestion to measure
  `BRAKE_ON_PCT_S` / `THROTTLE_ON_PCT_S` off `gaz_pct` cannot be carried out:
  there is no throttle or brake trace to measure.
- `"konum: ±15–20 m (GPS yok, mesafe hızdan)"` — **there is no GPS**. The
  `lat`/`lon` columns are the file author's own hand-placed ideal line on a
  map, with distance integrated from speed. So the "real lap's line" cannot be
  compared against the simulated line: the real line was never measured.
- Speed was read off an onboard video's dash at 25 Hz, 68 % automatically,
  35 frames by hand, the rest interpolated.

So exactly **two** channels are real: `hiz_kmh` (measured) and `boylamsal_g`
(its derivative). Everything else in the comparison below is either derived
from those two or is geometry of unknown accuracy. The whole analysis is built
on that: **the speed is trusted, the geometry is not.**

Everything was run from node against `dda_lab/public/examples/*.json` directly.
The corridor was extracted once in a real browser (65 % resolved, 14.5 m wide)
and its map geojson re-projected onto the node-side centerline for the offline
runs (46 % resolved there, because the reprojection's 12 m nearest-edge test is
stricter than the in-browser indexing); headline lap times below are the
browser's, per-corner tables are the node harness's.

---

## 1. The measured comparison, before any change

Lap: **sim 1:24.97 vs real 1:19.81 (+6.5 %).** Per channel:

| channel | real | sim (before) | note |
|---|---|---|---|
| top speed | 272.0 km/h | 265.0 | fine — fixed in an earlier round |
| min speed | 70.1 km/h | 64.4 | sim slower in every corner |
| `long_g` peak braking | **−1.42 g** (once, K1 from 250 km/h); −0.68…−1.07 elsewhere | −1.10 everywhere it brakes | `brakingG` 1.1 sits *between* the real peak and the real typical |
| `long_g` peak drive | +0.87 g | +0.96 | sim drives slightly harder |
| `lat_g` | **not measured** | 1.33 peak | only inferable from speed × geometry |
| `lean`, `tps`, `brake`, `rpm`, `gear` | **not in the file** | — | not comparable at all |
| corner minimum speed | — | **−13 km/h mean, −33 km/h worst (K4)** | the user's "too slow in fast corners" |

Which constraint sets the simulated corner speed: **14 of the 16 corners were
lateral-grip-limited**, i.e. the line's radius, not the braking or the engine.
And the radius the sim's line reported was **58–85 % of the radius the real
rider's own measured apex speed requires** at any believable lateral g:

| turn | real min km/h | sim min km/h | sim min radius | radius the real speed needs at 1.33 g |
|---|---|---|---|---|
| K1 | 103.3 | 80.3 | 39 m | 63 m |
| K3 | 134.0 | 110.2 | 73 m | 106 m |
| K4 | 137.8 | 104.6 | 65 m | 112 m |
| K8 | 112.9 | 97.0 | 56 m | 75 m |
| K5 (hairpin) | 70.1 | 64.4 | 25 m | 29 m |
| K10 (hairpin) | 79.2 | 72.7 | 31 m | 37 m |

The deficit is worst in the *fast* corners (K3, K4) and almost absent in the
hairpins — exactly the user's report, and exactly the signature of an error
that scales with radius.

---

## 2. The hypotheses, tested one at a time

### H1 — "a single lap-wide κ cannot be right; 0.85 is too near the minimum-distance end for a fast sweeper". **FALSIFIED.**

Swept κ over the real circuit and looked at the line's radius, not just the
lap time:

| κ | lap | K3 min radius / speed | K4 min radius / speed | K1 min radius / speed |
|---|---|---|---|---|
| 0.00 | 85.89 | 70 m / 107.9 | 71 m / 109.0 | 44 m / 85.7 |
| 0.40 | 85.10 | 70 m / 108.5 | 73 m / 108.5 | 39 m / 80.8 |
| 0.85 (default) | 84.65 | 73 m / 110.2 | 65 m / 104.6 | 39 m / 80.3 |
| 0.95 | 86.99 | 71 m / 109.2 | 62 m / 101.4 | 32 m / 72.7 |

κ moves the fast corners' radius by about **3 m out of a 40 m deficit**, and
κ = 0 — the corner-speed end the hypothesis says a fast sweeper wants — is
*slower overall*, not faster. A corner-speed-dependent κ blend would therefore
have bought a fraction of a second and left the symptom in place. Re-tested
after the fix (§3) and the conclusion is unchanged: at the corrected curvature
scale the fast-corner residual moves from −11 km/h (κ = 0.85) to −8 km/h
(κ = 0), while the slow corners go 8 km/h *over* the real speed. κ = 0.85 is
also the value whose per-corner error is closest to zero on average (−1.1 km/h,
against +6.8 at κ = 0), so the preset is left alone.

### H2 — the reference geometry is wrong, not the line. **CONFIRMED, and it is the whole 6.5 %.**

The decisive measurement needs no model at all. Take the **measured** speed and
the curvature the geometry reports, and ask what lateral acceleration the
rider would have had to produce:

| curvature scale | implied real lat g p50 | p90 | p99 | peak | metres of lap over 1.6 g |
|---|---|---|---|---|---|
| **10 m (shipped)** | 0.80 | 1.81 | **2.85** | **5.73** | **464 m** |
| 15 m | 0.85 | 1.59 | 2.10 | 3.00 | 312 m |
| **20 m** | 0.87 | 1.50 | 2.00 | 2.11 | 212 m |
| 30 m | 0.86 | 1.36 | 1.80 | 1.99 | 82 m |
| 40 m | 0.81 | 1.30 | 1.74 | 1.95 | 44 m |

At the shipped 10 m scale the geometry claims the BMW pulled **5.7 g** and held
over 1.6 g for 464 metres. No tyre does that, so at 10 m the curvature channel
is reporting *noise*, not corners. The mechanism is standard: a three-point
stencil of half-width L turns a lateral position error e into a curvature error
of about 2e/L², i.e. a spurious radius of L²/2e — and since a fast corner's
true curvature is small, it is the fast corners that drown first. That is why
the deficit scaled with radius.

The error is **long-wavelength**, which is why nobody caught it earlier and why
it cannot be estimated from the trace: the real centerline's *local* (2 m
baseline) scatter is **0.07 m** — a third of the synthetic test fixture's
0.146 m, i.e. locally it looks cleaner than the fixture — while its residual
against a 40 m mean is **2.6 m rms**. It is a smooth wander of a hand-placed
map polyline, exactly as the file's ±15–20 m accuracy note says.

### H3 — `brakingG` 1.1 is too low (real peak −1.42 g). **REJECTED.**

The −1.42 g is a single event: K1, braking from 250 km/h, where aero load is
highest. In the other five braked corners the real peak is **−0.68 to −1.07 g**.
Setting `brakingG` = 1.4 buys 1.0 s but makes the simulated bike brake harder
than the real one in 13 of 14 braking zones — a fitted lap, not a validated
model. Left at 1.1.

### H4 — `MERGE_GAP_S` (0.8 s) merges two genuinely separate applications. **NOT on the real lap, but the rule itself is incomplete.** See §3.2.

### H5 — one-at-a-time parameter probes (all against the real lap)

| probe | lap | top speed | mean corner error |
|---|---|---|---|
| baseline (after §3) | 80.04 | 270 | −1.1 km/h |
| `brakingG` 0.9 / 1.4 | 81.02 / 79.04 | 265 / 275 | −1.6 / −0.8 |
| `trailBrakeDepth` 0.2 / 1.0 | 81.31 / 79.09 | — | −1.7 / −0.7 |
| `throttleDelayS` 0.05 | **80.04 (no change)** | — | −1.1 |
| `leanUsage` 1.0 | **80.04 (no change)** | — | −1.1 |
| `mu` 1.25 / 1.45 | 82.20 / 77.49 | — | −4.3 / +2.9 |
| `powerKw` 125 / 170 | 80.23 / 79.92 | 260 / 279 | −1.1 |

Two of these are findings in their own right:

- **`leanUsage` is inert on the 1000 preset.** `aLatMax = min(mu, tan(lean))`;
  with mu 1.33 and tan(58° × 0.95) = 1.43 the tyre always binds first. The
  slider does nothing at all until it drops below about 0.88. Same for the
  250 preset in reverse (lean binds, mu never does).
- **`throttleDelayS` cannot change the lap time by construction.** The rider
  layer is applied *after* the envelope, so nothing in `rider.ts` — delay, rate
  limits, trail-brake profile — can move a single second. Worth knowing before
  anyone tunes those constants hoping to.
- **mu is worth ±2.5 s per ±0.1.** The 0.8 % lap-time agreement below is well
  inside the uncertainty of mu alone. Do not read it as 0.8 %-accurate physics.

---

## 3. What was changed

### 3.1 `line.ts`: `CURV_SMOOTH_M` 10 m → `CURV_SCALE_M` 20 m (stencil *and* smoothing)

Bracketed from two sides, neither of which is the lap time:

- **Lower bound, from §2/H2**: below ~20 m the geometry claims lateral
  accelerations no tyre can produce.
- **Upper bound**: at 25 m and above the *tight* corners inflate past what
  their own measured apex speeds allow (K5's hairpin: 29 m implied, 32 m
  reported at 20 m, 36 m at 25 m, 40 m at 40 m) and the simulated lap starts
  beating the real one through every slow corner by 5–13 km/h — a lap the bike
  cannot ride.

20 m is the conservative end of that bracket. It costs nothing on clean
geometry: on the synthetic circuit the 25 m hairpin reads **25.1 m** at 20 m
against 24.1 m at 10 m (true 25), and the 250 m sweeper 246 m against 253 m.

The lap-time agreement is a *consequence*, not the target, and is reported as
such: the fit was not tuned to 1:19.81 and lands 0.66 s the wrong side of it.

### 3.2 `rider.ts`: merge braking runs that never left the corner

Raising the curvature scale exposed a real gap in the one-application-per-corner
rule from task 8. On the synthetic circuit the rider started producing **7**
applications for 5 corners: two extra 18–20 % dabs *inside* the 250 m sweeper,
1.8 s apart. `MERGE_GAP_S` cannot reach them, because the gap inside one long
corner is **longer** than the gap between two corners (1.8 s vs 1.2 s here), so
no time threshold separates the two cases. The throttle and the lateral load do,
with about 2× margin either way:

| | time gap | peak throttle in the gap | lateral g in the gap |
|---|---|---|---|
| inside one corner | 1.3–1.8 s | 8–10 % | 1.19–1.33 |
| between two corners | 1.2–14.8 s | 50–100 % | down to 0.00–0.49 |

So two runs are also merged when, between them, the rider never got back on the
throttle (< 25 %) **and** the tyre never came off its lateral limit (> 0.7 of
it). Both conditions are required: the 50 % / 0.49 g case is the sweeper exit
into the next corner, a genuinely separate application, and an either-or rule
would swallow it. Confirmed by mutation: dropping the clause gives 7 ≠ 5;
making it unconditional gives 1 ≠ 5.

These two are the only code changes. `presets.ts` is untouched.

### Tests

`npm test`: **420 passing** (419 before; one added). Typecheck clean under
`src/sim/` and the touched test file.

- The existing `simRider` test *"brakes exactly once per corner over a lap"*
  **went red (7 vs 5)** when the curvature scale changed. The test was right and
  the merge rule was incomplete — it is the change that was fixed, not the test.
- Added `simLine` *"reads a fast corner through a long-wavelength centerline
  wobble, and still reads a hairpin"*, on a new fixture: a 250 m circle carrying
  a 1 m / 50 m radial wobble (curvature 0.016 1/m, **four times** the 0.004 of
  the bend it rides on). Mutation-checked in **both** directions: back to a 10 m
  scale → the bend reads 110 m, fails `> 150`; out to a 45 m scale → the hairpin
  reads 30.2 m, fails `< 28`.

---

## 4. Where it stands now

Browser, full shipped path, real extracted corridor: **1:20.47 vs 1:19.81.**
Per 200 m block the two laps are now within ±0.4 s everywhere except 2000–2400 m
(+1.4 s total, K11→K13). Speed-trace overlay across the whole lap is close
enough to read as the same lap.

| turn | real min km/h | sim min km/h | Δ | apex position Δ | brake point Δ |
|---|---|---|---|---|---|
| K1 | 103.3 | 103.3 | **0.0** | +35 m | −16 m |
| K2 | 108.9 | 104.4 | −4.5 | +34 m | — |
| K3 | 134.0 | 123.2 | **−10.8** | +47 m | — |
| K4 | 137.8 | 123.1 | **−14.7** | −119 m | — |
| K5 | 70.1 | 70.1 | **0.0** | +30 m | +25 m |
| K6 | 103.2 | 102.7 | −0.5 | +22 m | — |
| K7 | 122.9 | 119.9 | −3.0 | 0 m | — |
| K8 | 112.9 | 116.2 | +3.3 | +19 m | — |
| K9 | 126.9 | 133.0 | +6.1 | 0 m | — |
| K10 | 79.2 | 77.1 | −2.1 | +2 m | +29 m |
| K11 | 89.9 | 90.9 | +1.0 | 0 m | +4 m |
| K12 | 94.4 | 96.2 | +1.8 | +6 m | — |
| K13 | 117.9 | 115.3 | −2.6 | −86 m | −22 m |
| K14 | 116.2 | 112.0 | −4.2 | 0 m | −37 m |
| K15 | 107.1 | 108.0 | +0.9 | −17 m | — |
| K16 | 135.2 | 147.3 | **+12.1** | 0 m | — |

Ten of sixteen corners are within 3 km/h. The **braking points** land within
−37…+29 m of the real ones in all six corners where the file records a measured
brake point — out of braking zones 150–300 m long, with nothing fitted to them.
The **apex** (speed minimum) sits within 6 m in ten corners.

---

## 5. What still does not match, and what it would take

1. **K3 and K4 are still 11 and 15 km/h slow; K16 is 12 km/h fast.** This is
   the real residual, and the lap-time agreement partly *hides* it — the errors
   cancel. All three are the corners where the reference geometry is least
   trustworthy: K4's reported minimum radius moves 60 → 84 → 105 → 120 m as the
   measuring scale goes 10 → 20 → 30 → 40 m and has not converged, and K16's
   moves 51 → 125 → 155 → 172. No smoothing length reads both K4 and K5
   correctly at once, because one needs more and the other needs less.
   **What it would take:** a centerline with real positional accuracy. Either
   track the circuit's edges from satellite imagery and take the geometry from
   the corridor (the extractor already produces it, at 65 % coverage), or use a
   lap with actual GPS. A curvature scale chosen per-corner from the local
   radius would paper over it; it would not be a measurement.

2. **The real lateral g is still unknown.** Even at a 40 m scale the geometry
   implies a 1.95 g peak. Either the reference line is still wrong, or the real
   rider's line differs from it by metres — unknowable from this file. Until
   that closes, `mu = 1.33` is an assumption that happens to produce the right
   lap time, and it is worth ±2.5 s per 0.1.

3. **The sim still brakes about twice as often as the rider does**: 16 brake
   applications on the real circuit against 7 corners the file flags as braked
   (14 if every net-deceleration run counts). The §3.2 rule fixed the synthetic
   case; several sub-0.5 s, 0.3 g dabs survive on real geometry. **What it would
   take:** the same corner-identity idea applied to *events* rather than gaps —
   drop an application that never reaches a meaningful level and sits inside a
   neighbouring one's corner — or, better, geometry clean enough not to produce
   them.

4. **The transition shapes cannot be compared at all.** The simulated braking g
   reaches 90 % of its peak in **0.02–0.07 s** (the backward pass is a step);
   the real trace takes **0.2–3.3 s**. But the real `long_g` is the derivative
   of a speed trace that is 68 % auto-read and partly interpolated, so its
   transitions are smeared by the reconstruction and that comparison proves
   nothing. And since no `rider.ts` constant affects the envelope (§2/H5),
   `BRAKE_ON_PCT_S`, `THROTTLE_ON_PCT_S` and friends remain **unvalidated
   estimates**. **What it would take:** one lap of real logged brake-pressure
   and throttle-position data. Nothing in this repo can substitute for it.

5. **The risk banner now fires harder** (13 % of the lap at 100 % of the
   friction circle, up from 6 %) simply because more of the lap is now spent at
   the lateral limit, which is what a correctly-measured fast corner looks like.
   The banner's threshold was already known to sit near the `gripUse`
   index-stagger noise floor (task 10, concern 2); this makes it louder. It
   needs a real threshold, not a tweak.

6. **κ remains unvalidated as a *style* parameter.** It was shown not to be the
   cause of the fast-corner deficit, but nothing here shows that κ = 0.85 is
   what a 1000 actually does, because the real line was never measured. That
   test needs a GPS lap.
