# DDA Lab — Math channels & filters guide

Math channels are new channels computed from existing ones with a short formula. They
behave like any other channel: plot them, put them on the map colour ramp, use them in
reports or in other formulas.

## 1. Quick start

1. Open the **Math** tab (bottom panel).
2. Either click a **preset** (one click, done) or type a formula:
   - **Name**: `gear_ratio` (letters, digits, `_`; this becomes the channel name)
   - **Unit**: `rpm/kmh`
   - **Expression**: `where(speed > 30, rpm / speed, 0)`
3. The green ✓ confirms the formula parses. **Add / Update** creates the channel.
4. Add it to a chart panel with “+ channel”.

Formulas are recalculated automatically when you change a filter, the start line, the
reference lap or import a new session. They are saved in the workspace.

## 2. Channel names you can use

| Name | Unit | Meaning |
|---|---|---|
| `speed` | km/h | wheel speed (after its filter / source setting) |
| `gps_speed` | km/h | ground speed from GPS |
| `rpm` | rpm | engine speed |
| `tps` | % | throttle opening |
| `gear` | – | 0..6 |
| `lean` | deg | lean angle, left negative / right positive |
| `tq_fast`, `tq_slow` | % | torque reduction (traction control) |
| `dist` | m | ECU odometer |
| `gps_lat`, `gps_lon`, `gps_alt` | deg, m | GPS position / altitude |
| `long_g`, `lat_g`, `total_g` | g | accelerations (derived) |
| `curvature`, `radius` | 1/m, m | corner geometry from GPS (derived) |
| `slip` | % | wheel vs GPS speed (derived) |
| `phase` | – | 0 coast, 1 brake, 2 throttle (derived) |
| `time` | s | seconds since the start of the file (derived) |
| `lap_time` | s | seconds since the lap start, NaN outside laps (derived) |
| `lap_dist` | m | distance since the start line (derived) |
| `total_dist` | m | distance covered over the laps still in the file, continuous lap after lap; deleting a lap removes its metres (derived) |
| `delta_t` | s | time gained/lost vs the reference lap (derived) |
| `delta_d` | m | metres ahead (+) / behind (−) the reference lap at the same lap time (derived) |
| `pi`, `e`, `g` | – | constants 3.14159…, 2.71828…, 9.80665 |

Any math or imported CSV channel can be used by its name as well.

## 3. Operators

`+ - * / ^` arithmetic · `< <= > >= == !=` comparisons (result 1 or 0) · `&& || !` logic ·
parentheses for grouping. Numbers are plain: `3.6`, `0.25`.

## 4. Functions

### Elementwise
`abs(x)`, `sqrt(x)`, `sign(x)`, `floor(x)`, `ceil(x)`, `round(x)`, `exp(x)`, `log(x)`, `log10(x)`,
`sin cos tan asin acos atan`, `atan2(y, x)`, `min(a,b)`, `max(a,b)`, `pow(a,b)`, `mod(a,b)`,
`hypot(a,b)`, `clamp(x, lo, hi)`, `where(cond, a, b)`, `isnan(x)`, `nanfill(x, v)`,
`deg2rad(x)`, `rad2deg(x)`, `kmh2ms(x)`, `ms2kmh(x)`.

### Calculus & time
- `deriv(ch)` — rate of change per second. `deriv(speed)` = km/h per second.
- `accel_g(speed)` — longitudinal acceleration in **g** straight from a km/h channel.
- `integ(ch)` — running integral over time; `integ(kmh2ms(speed))` = distance in m.
- `integ_x(y, x)` — integral with **your own x channel** (trapezoid rule): `integ_x(long_g, lap_dist)` integrates g over
  metres, `integ_x(rpm, lap_time)` over lap time (`time` / `lap_time` are channels). A wrap of x (lap distance going back to 0) is skipped.
- `lap_integ(y)`, `lap_integ_x(y, x)` — the same integrals restarting from 0 at every lap start.
- `deriv_x(y, x)` — dy/dx with your own x channel: `deriv_x(speed, lap_dist)` = km/h per metre.
- The **∫ Integral** builder in the Math editor writes these for you: pick y, pick dx (time or any channel), tick
  “restart every lap”, press **Build formula**.
- `cumsum(ch)`, `diff(ch)` — running sum / sample difference.
- `shift(ch, seconds)` moves a channel later (negative = earlier); `lag(ch, samples)` same in samples (10 per second).

### Rolling windows (window `n` in samples; 10 samples = 1 s)
`smooth(ch, n)` / `rolling_mean`, `rolling_min`, `rolling_max`, `rolling_std`, `median(ch, n)`.

### Filters
- `lowpass(ch, hz)` — zero-phase Butterworth low-pass. Typical: speed 1 Hz, lean 2 Hz, rpm 3 Hz.
- `highpass(ch, hz)` — what the low-pass removed (vibration, chatter, slip).
- `sg(ch, n)` — Savitzky-Golay: smooth but keeps peaks (odd `n`, e.g. 7–15).

### Statistics
- Whole channel: `mean(ch)`, `std(ch)`, `cmin(ch)`, `cmax(ch)` (constant across the session).
- Per lap: `lap_min`, `lap_max`, `lap_mean`, `lap_sum`, `lap_first`, `lap_last` (constant within each lap).
- `lap_time(ch)` seconds since the lap start, `lap_progress(ch)` 0–1 through the lap.

### Events
- `rising(cond)` / `falling(cond)` — 1 on the sample where the condition turns true / false.
- `hold(cond, seconds)` — 1 for N seconds after the condition was true.

## 5. Recipes

| Goal | Formula |
|---|---|
| Braking force in g | `accel_g(lowpass(speed, 1.5))` (negative = braking) |
| Brake marker | `rising(accel_g(lowpass(speed,1.5)) < -0.3)` |
| Trail braking | `where(long_g < -0.2 && abs(lean) > 25, 1, 0)` |
| Throttle while leaned | `where(abs(lean) > 30, tps, 0)` |
| Lean rate (flick speed) | `deriv(lowpass(lean, 2))` |
| Gear ratio / wheelspin check | `where(speed > 30, rpm / speed, 0)` |
| Upshift markers | `rising(diff(gear) > 0)` |
| Wheel slip % | `(speed - gps_speed) / gps_speed * 100` |
| Speed relative to lap average | `speed - lap_mean(speed)` |
| Corner speed only | `where(abs(lean) > 20, speed, 0)` |
| Time at full throttle per lap (s) | `lap_sum(where(tps >= 95, 1, 0)) / 10` |
| Lateral g from geometry | `kmh2ms(speed)^2 / clamp(radius, 5, 2000) / g` |

## 5b. A different formula for one run or one lap

Every math channel has a default formula. In the editor, **Formula applies to** lets you pick
**one run** (session: all its laps) or **one lap** instead of “all runs and laps”. The formula you save
then replaces the channel’s values there only; everything else keeps the default. Typical use: one
bike needs an offset or a different correction (`speed + 3`, `rpm * 1.02`) while the others stay as
they are, on the same plot. Run and lap formulas are listed under the channel (badges **run** / **lap**);
✕ returns to the default. Removing the run or lap removes its formula.

### Editing on the cards
Math channels are cards: change the unit, colour or **formula right on the card** (Enter saves,
Esc reverts). Preset cards are editable too: adjust the formula or the channel name, then **Add**.

### Your own templates
**★ Save as preset** in the editor (or ★ on any channel/preset card) keeps a formula under
**Presets → My presets**, stored in this browser. Your presets can be edited and saved on their
card, or deleted with ✕.


## 5b-ter. Reading another run or the reference lap in a formula

- `ref(ch)` — channel `ch` of the **reference lap** (◉) at the same lap distance. `speed - ref(speed)`
  is the speed delta, `speed / ref(speed)` the ratio, `rpm - ref(rpm)` the rpm delta.
- `ref_t(ch)` — the same aligned by **lap time**: `lap_dist - ref_t(lap_dist)` = metres ahead of the
  reference at the same moment (that is the built-in `delta_d`).
- `run(ch, n)` / `run_t(ch, n)` — channel `ch` of the **n-th loaded run** (1 = first chip in the top
  bar) at its best lap. `run(speed, 2) - speed`, `tps / run(tps, 1)`.
- Built-in deltas need no formula: `delta_t`, `delta_d`, `d_speed`, `d_rpm`, `d_tps`, `d_lean`…

Every chart panel can have its **own x axis** (⚙ → X axis → distance / lap time); the shared zoom
only applies to panels on the workspace axis. The **Templates…** menu has *Δ lap time vs distance*,
*Δ distance vs lap time* and the combined view ready-made.

## 5c. Markers (fixed data points)

Hover a chart (or click the map) and press **M** or **📍 Mark**: a marker is pinned to that sample.
Markers draw as a coloured vertical line with a flag on every chart, as a pin on the map, and their
values appear **fixed** under each chart (one chip per marker, one number per plotted line) and in
the **Markers** tab (every channel × every selected lap at that point). In other laps a marker is read
at the same lap distance / lap time, so you compare laps at exactly one spot. Rename, recolour, jump
to or delete markers in the Markers tab.

Markers are **saved automatically** per file (reopen a file of the same name and they come back),
travel inside .lab.json bundles, and can be exported/imported as a JSON file in the Markers tab.
Markers can be **dragged** left/right by their flag on any chart; **double-click** the flag (or ✎)
to write a **note**, ✕ on the flag or on the value chip removes it. The **📍 Mark** button places the
marker where you **last clicked** (chart or map); the **M** key places it under the mouse.

## 5c-bis. Δ vs reference channels and chart templates

With a reference lap chosen (◉), every lap gets `d_speed`, `d_gps_speed`, `d_rpm`, `d_tps`,
`d_lean`, `d_long_g`, `d_lat_g`, `d_gear`: the lap’s value **minus the reference lap at the same
lap distance** (0 on the reference itself). Together with `delta_t` they drive the **Templates…**
menu above the charts: *Δ vs reference (stock style)* draws them with a zero line and green/red
fill (gain/loss; for `delta_t` red = slower), plus *Speed vs reference*, *Braking*, *Cornering*,
*Engine & traction*, *GPS vs wheel* and *Default*. A template replaces the panels; edit them freely afterwards.

## 5c-ter. Time won or lost in every turn

With a track model, every turn line on the charts shows, for each plotted lap, how much time
that lap **won (−, green) or lost (+, red) in that turn against the best loaded lap in the same
turn** (`best` marks the fastest). The Reports → Turns table has the same as *Turn time s* and
*vs best lap in turn (s)*. The best is searched over every plausible flying lap of every open file.

## 5d. Exports show what you see

Every export follows the workspace: deleted laps are gone for good and only the laps listed in the
**Laps** tab are written. **⤓ Export visible** (above the charts) writes one CSV with exactly the
plotted lines, resampled every 1 m (or 0.1 s), limited to the zoomed x range. The Laps tab’s
**Export CSV** has a “visible range only” switch when a zoom is active. Reports use the same laps.

## 5e. Missing channels are estimated

A run that lacks a channel gets an estimate on import, marked **estimated** in the Channels tab:
`speed` from GPS ground speed, `dist` by integrating speed, `lean` from GPS curvature (v²κ/g).
Real channels in the file are never replaced.

## 5f. Zooming the Y axis

Drag the Y axis up to zoom in, down to zoom out (around the value you grabbed); shift+drag pans;
the mouse wheel over the axis zooms; double-click returns to automatic. The range is stored per
panel (also editable in the panel ⚙ settings).

## 6. Channel filters (Channels tab)

Each raw channel has a ⚙ editor: **source** (speed: wheel / GPS / blend), **scale + offset**
(`y = a·x + b`), **filter** (none, moving average `n`, Savitzky-Golay `n`, Butterworth cutoff Hz),
**GPS lag** (auto = cross-correlation of wheel vs GPS speed) and **invert**. The **Presets** row
applies the common choices with one click; **Apply to all sessions** copies the setting.

Derived channels (`long_g`, `delta_t` …) and math channels are recomputed from the filtered
value, so filtering `speed` also cleans every formula that uses it.

## 6b. Virtual rider v2 — the model behind the Sim tab

The **Sim** tab drives a virtual lap round the active track. The result is an ordinary session
(`Virtual rider`, plus `Ideal line` / `Physics limit` for the optimal modes), so every chart,
map colour, Δ channel and formula above works on it. Units inside the solver are metres,
seconds, m/s and radians; the session carries km/h and degrees like any recording.
Design: `docs/superpowers/specs/2026-10-11-virtual-rider-design-v2.md`; research R1-R4 under
`docs/superpowers/research/`. Every coefficient marked *öneri* is a proposal awaiting
calibration on the owner's laps.

### The line and the envelope

The κ-line (C↔V line style slider) is built from the centerline and the extracted corridor as
before. The quasi-steady-state (QSS) solver then finds the fastest speed profile on that line
that no limit below forbids; in v2 that envelope is an **upper bound**, and the rider's events
(below) decide where under it the lap actually runs: `v = min(v_event, v_QSS)`.

### Below-peak tyre: the scaled friction ellipse (R2 §3.4-3.5)

The rider never uses the tyre's peak. Each axis keeps the share the allowed slip `s` (a fraction
of the slip at peak force) gives, through a normalised Magic Formula:

```
g(s, C) = sin( C · atan( tan(π/(2C)) · s ) )         g(0) = 0, g(1) = 1, monotone
μ_brake = μx · gripScale · g(sBrake, 1.6)            front, braking
μ_drive = μx · gripScale · g(sDrive, 1.6)            rear, drive
μ_lat   = μy · gripScale · g(sLat,   1.3)            lateral
(a_x / (μ_long·g̃))² + (a_y / (μ_lat·g̃))² ≤ 1
```

Control values: g(0.5; 1.6) = 0.856, g(0.6; 1.6) = 0.92, g(0.8; 1.6) = 0.985. The curve is flat
near the peak, which is why riding under the limit costs little lap time and buys a lot of
margin. `grip_use` is now measured against the rider's own ceiling (μ_eff): 1.0 means "the
rider's margin is used up", not "the tyre is gone"; `gripUsePeak` is the same demand against
μ_peak. The banner fires above 1.05 on the first and says whether the second still holds.

### Load transfer: wheelie and stoppie (R1 §3.1)

With `b` = rear contact → CG (`cgRearM`), `p` the wheelbase, `h` the CG height and `t` the tyre
crown radius, the CG height at bike lean φ and the two pitch limits are

```
h_φ        = t + (h − t)·cos φ
a_wheelie  = g·b/h_φ − F_D·h/(m·h_φ)                 drive cap (front lifts)
a_stoppie  = g·(p − b)/h_φ                           tyre braking cap (rear lifts); drag adds on top
braking (tyre share) = min(μ_brake·g·ellipse, a_stoppie, brakingG·g)
```

v1 used `g·p/(2h)`, i.e. `b = p/2` and no drag term. Presets carry `b/p ≈ 0.49` (R1's S1000RR +
rider estimate 0.70/1.44), *öneri*.

### Bike lean vs ideal lean: crown and hang-off (R1 §3.2)

The ideal lean is `tan φ_i = a_y/g̃`. The motorcycle leans further because the contact patch
rolls round the tyre crown, and less when the rider hangs off (rider mass `m_r` moved `d_r`
inside, combined offset `e = m_r·d_r/m`):

```
φ_bike = φ_i + asin( t·sin φ_i / R ) − atan2(e, h − t),     R = √((h − t)² + e²)
```

The tyre's lean limit applies to `φ_bike`, so the corner-speed limit is the ideal lean that
inverts it (bisection, monotone). With t = 0.08 m and no hang-off a 58° tyre limit is only ~51°
ideal (≈ 1.24 g); 0.25 m of hang-off gives most of it back. The `lean` channel is the bike lean,
comparable with an IMU. Presets: `tyreCrownM` 0.06-0.08, `hangOffM` 0.2-0.25 m, `riderMassKg`
75 kg (*öneri*).

### 3D road budget (R1 §3.5, no data yet)

With slope σ, banking β and normal curvature ν the tyres see

```
ã_x = a_x + g·sin σ      ã_y = v²κ − g·cos σ·sin β      g̃ = g·cos σ·cos β + v²·ν
```

and the ellipse, the lean and the pitch limits use `g̃`, `ã_x`, `ã_y`. All three channels are
zero until a DEM reader exists, and then the model reproduces v1 bit for bit.

### Roll rate (R1 §3.3, Biniewicz)

`φ̇_max(V, φ) = rollRateFrac · (β0 + β1·V)/g · cos²φ`, β0 = 23.5 m/s³, β1 = −0.31 s⁻²
(thesis values; the paper's 32.56 is *doğrulanmadı*). The envelope adds `v ≤ φ̇_max / |dφ/ds|`,
iterated 2-3 times; this is what makes S-bends and chicanes cost time.

### Corner events: one brake, one throttle per corner (R3 §3)

Corners are found on the speed profile, not the geometry: local minima of `v_QSS` whose
prominence is at least `max(8 km/h, 5 % · v)`; two minima with no room to accelerate between them
(`gap < v²/(2·a_drive)`) are ONE corner (a chicane, with its lean flips listed). Per corner:

```
A  speed apex (min v)          Ageo  max |κ|
T  turn-in: |κ| rises past 0.25·|κ|max      E  exit: |κ| falls below it, or the next B
B  brake point (from the template)          P  throttle pick-up = A + throttleDelayS
hasBrake = v_entry > v_A + 8 km/h            (a flat-out kink gets no brake event)
```

The event template integrates backward from A for braking — tyre deceleration builds at
`brakeRiseGps`, plateaus at the braking cap and releases with `brakeShare(latUse, depth, profile)`
as lean comes on; B is where that curve meets the previous corner's drive curve — and forward
from A for the drive: maintenance throttle (`a_x ≈ 0`) until P, a smooth roll-on over `rollOnS`
to the drive cap, then full throttle until the next B. `brake` and `tps` come straight from the
template; the header shows the corner count and how many of them are braked for, and
`cornerEventsGeoJson` gives the B/T/A/P/E points for the map.

### Aggressiveness and Risk (R3 §5; all *öneri*)

Two sliders produce every other rider number (`src/sim/derive.ts`, `DERIVE_TABLE`).
**A** (aggressiveness) is timing; **R** (risk) is force level.

| Derived | Formula | A/R = 0 → 1 |
|---|---|---|
| sBrake | 0.30 + 0.65·R | 0.30 → 0.95 |
| sDrive | 0.50 + 0.45·R | 0.50 → 0.95 |
| sLat | 0.55 + 0.42·R | 0.55 → 0.97 |
| brakingG | μx · gripScale · g(sBrake, 1.6) | via the tyre curve |
| leanUsage | g(sLat, 1.3) | ~0.78 → ~0.99 |
| trailBrakeDepth | 0.3 + 0.6·R | 0.3 → 0.9 |
| trailBrakeProfile | R | 0 → 1 |
| brakeRiseGps | (0.6 + 0.4·A) · 2.8 g/s | 1.7 → 2.8 g/s (2.8 measured on both reference laps) |
| throttleDelayS | 1.6 − 1.4·A | 1.6 → 0.2 s |
| rollOnS | 1.2 − 0.8·A | 1.2 → 0.4 s |
| rollRateFrac | 0.5 + 0.5·A | 50 → 100 % of the bound |
| tcThreshold | 0.5 | constant |

Open **Gelişmiş** to see the derived values. Moving one pins it (lock icon, orange): it then
ignores the sliders until you click the lock. The two parameters are separable in data: A shows
in roll rate, brake build, pick-up time and roll-on; R in braking g, lean and slip percentiles.

### Solver modes

| Mode | What | When it runs |
|---|---|---|
| **Sürücü** | the model above, the human rider | live, on every slider (< 50 ms) |
| **Serbest yörünge** | line offsets and speed optimised together for the IDEAL rider (s = 1, full roll rate, braking at μx) | in a Web Worker, on **Hesapla** |
| **Tam OCP** | minimum-time optimal control (CasADi) on the lab server | on **Hesapla**, minutes; greyed when the bridge is unreachable |

All three can be loaded at once (`sim`, `sim-opt`, `sim-ocp`): rider vs ideal line vs physics
limit, compared with the usual Δ tools. A slider never starts an optimal run; after a machine or
tyre change an optimal lap is shown struck through as out of date until you press Hesapla again.

## 7. Tips

- Compare `deriv(speed)` on raw vs `lowpass(speed, 1)`: differentiation amplifies noise, so filter first.
- Flags (0/1) are easiest to read on their own chart panel or as a map colour.
- A formula that references a channel which does not exist in a session evaluates to NaN there; the Math tab shows the error text in the channel list.
- Names must be unique; re-adding with the same name updates the formula.
