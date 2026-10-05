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
| `lap_dist` | m | distance since the start line (derived) |
| `total_dist` | m | distance covered over the laps still in the file, continuous lap after lap; deleting a lap removes its metres (derived) |
| `delta_t` | s | time gained/lost vs the reference lap (derived) |
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
  metres, `integ_x(rpm, lap_time(rpm))` over lap time. A wrap of x (lap distance going back to 0) is skipped.
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

## 5b. A different formula for one lap

Every math channel has a default formula. In the editor, **Formula applies to** lets you pick one of the
laps in your workspace instead of “all laps”: the formula you save then replaces the channel’s values
inside that lap only (other laps keep the default). Per-lap formulas are listed under the channel with
a **lap** badge; ✕ returns that lap to the default. Deleting the lap deletes its formula. Typical use:
a different gear ratio or correction factor for a lap ridden with another setup.

## 5c. Markers (fixed data points)

Hover a chart (or click the map) and press **M** or **📍 Mark**: a marker is pinned to that sample.
Markers draw as a coloured vertical line with a flag on every chart, as a pin on the map, and their
values appear **fixed** under each chart (one chip per marker, one number per plotted line) and in
the **Markers** tab (every channel × every selected lap at that point). In other laps a marker is read
at the same lap distance / lap time, so you compare laps at exactly one spot. Rename, recolour, jump
to or delete markers in the Markers tab.

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

## 7. Tips

- Compare `deriv(speed)` on raw vs `lowpass(speed, 1)`: differentiation amplifies noise, so filter first.
- Flags (0/1) are easiest to read on their own chart panel or as a map colour.
- A formula that references a channel which does not exist in a session evaluates to NaN there; the Math tab shows the error text in the channel list.
- Names must be unique; re-adding with the same name updates the formula.
