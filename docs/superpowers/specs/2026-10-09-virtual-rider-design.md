# Virtual rider & lap-time simulator (design spec)

Date: 2026-10-09. Status: approved by owner (all design sections accepted).
Builds on `2026-10-04-dda-lab-design.md`.

## Goal

A parametric virtual motorcycle rider inside DDA Lab. The user sets machine, tyre/track
and rider parameters with sliders; the app computes the lap the virtual rider would do
on the loaded circuit and shows it as a lap that behaves exactly like a recorded one —
map trace, heat maps, chart stack, data slider (cursor), lap table and Δt against the
reference lap.

Two modes from one solver:

- **Benchmark** — no reference lap needed. Track geometry + parameters → achievable lap.
- **Coaching / what-if** — with a reference lap selected, the Δt curve shows where the
  parameter change wins or loses time ("0.05 g harder braking = −0.4 s").

## Non-goals

Full multibody dynamics, suspension, chassis flex, tyre thermal models, setup
optimisation, multi-bike racing. The solver interface is designed so a time-domain
dynamic solver can replace the quasi-steady-state core later (see *Extension seam*).

## Key architectural decision

**The simulator output is an ordinary `Session`.** It flows through `refreshSession()`
like any loaded file, so derived channels, math channels, `delta_t`, the map trace,
the heat maps, the cursor and the lap table all work with **zero new visualisation
code**. This is the single most important constraint on the design: anything the
simulator produces must fit the existing `Session` / `Channel` model.

## Research basis (why the ideal line depends on the bike)

The "ideal line" is not one curve; it is a function of power-to-weight. Sources:

- Kevin Cameron, *The Two Basic Styles of Motorcycle Cornering*, Cycle World.
  **Corner-speed style**: largest possible radius, enter wide / apex / exit wide.
  **Point-and-shoot**: enter at less than full lean, brake late and hard, do most of
  the direction change in a short zone ("squaring off"), then treat the exit as a
  "curved dragstrip". Cameron is explicit that low-powered machines "had no choice but
  to ride in corner-speed style" — they lack the acceleration to recover exit speed.
  So the line is a *consequence* of power-to-weight, not an independent preference.
  Same article: Honda data had 125/250 apex speeds "at least 15 percent faster" than 500s.
- Cycle World, *MotoGP Extreme Lean* (Ask the Geek). Moto3 up to 7.5 mph (~12 km/h)
  faster mid-corner than MotoGP at Phillip Island. With identical tyres a ZX-10R,
  GSX-R750 and YZF-R6 reached the **same lateral g** — the difference is riding style,
  not grip. The big bike makes a *tighter* arc near the apex at *lower* speed, which is
  why it still shows the same lean angle.
- Practitioner consensus (lower confidence, forum/community): maximum lean ≈ 50-55°
  (Moto3 / street race tyre), 56-58° (Moto2), 60-64° (MotoGP; Márquez 64°+).
  Community line taxonomy **C line (Moto3) → U line (Moto2) → V line (MotoGP/1000)**
  matches Cameron's account.
- Brembo (Le Mans T9, Austria, Aragon 2025-2026): MotoGP peak deceleration **~1.5 g**.
- Same rider / same circuit lap-time deltas (anecdotal, r/Trackdays): 600↔1000 ≈ 1-2 s,
  400↔600 ≈ 8-10 s. Used only as a sanity band for the presets, never as a target.

**Modelling consequence.** Rather than arguing early-vs-late apex terminology, the line
is parameterised by **κ, the curvature-distribution shape**: κ=0 spreads curvature
evenly over a long arc (C line), κ=1 concentrates it in a short zone and straightens
the exit (V line). κ's default comes from the machine preset; the user can override it.
This is what the physics actually consumes.

## Track corridor from satellite imagery (verified)

The line needs track boundaries, which `TrackModel` does not have.

**Rejected: `SchemaLayer.trackOutline`.** Measured on the owner's own schema
(`tracks/schemas/schema-6kh2n09j/schema_result.json`): `track_outline` (76 pts) and
`racing_line` (70 pts) are the *same curve* — median separation 0.0031 normalised units
(5.2 px in a 1680 px image), max 0.0155. It is one open polyline, not an inner/outer
pair, at 20-60 m point spacing, produced by vision over a screenshot of DDA Lab itself.
It carries no corridor information by construction. It stays as a map overlay only.

**Accepted: asphalt segmentation of Esri World Imagery.** Verified with a throwaway
probe over the Serres lap:

| Measurement | Result |
|---|---|
| Tile CORS | `Access-Control-Allow-Origin: *` → pixels readable, canvas not tainted |
| Ground resolution at z18, lat 41.07 | **0.450 m/px** → a 10 m track is 22 px |
| Tiles for one lap | 54 (9×6), all fetched |
| Discriminator | **Saturation**: on-track 0.069 vs ±20 m off-track 0.239 (3.5×). Brightness alone is weak (−21 grey levels) |
| Recovered width, 1573 sections at 2 m | median **14.5 m** (p5 12.0, p75 16.0). Serres is ~12 m plus kerbs → correct order |
| Racing line offset from corridor centre | mean +0.95 m, **sd 5.21 m** — the track width the rider actually uses |
| Known leak | **9.4 %** of sections hit the ±25 m search limit (p95 = 27.5 m): pit lane, asphalt run-off, paddock |

Leak mitigations, all cheap: a width ceiling (~18 m), rejection of sections whose width
jumps sharply against their neighbours, and the GPS lap envelope as a lower bound.

Esri native imagery stops at z18 (`ESRI_MAX_TILE_Z` in `MapView.tsx`); beyond that
MapLibre overzooms, so the extractor pins z18 and never requests deeper.

## Modules — `src/sim/` (all pure, unit-tested)

| File | Responsibility | In → Out |
|---|---|---|
| `presets.ts` | Preset tables (250 / 600 / 1000 / Panigale V4 / custom; tyre-track; rider archetypes), each value carrying its source in a comment | — |
| `corridor.ts` | Tile fetch → asphalt mask → perpendicular sections every 2 m → left/right offsets → median filter + leak rejection | `TrackModel` → `Corridor` |
| `line.ts` | κ-parameterised line inside the corridor, plus lateral-deviation noise | `TrackModel`+`Corridor`+`LineParams` → `Line` |
| `solver.ts` | QSS three-pass velocity envelope | `Line`+`SimParams` → `v, long_g, lat_g, lean` |
| `rider.ts` | Lag layer: brake-release ramp, throttle-application delay, TC torque cut, gear/rpm model | envelope → `tps, gear, rpm, dtc` |
| `toSession.ts` | Resample arc-length → 10 Hz time grid; build the synthetic `Session` (GPS lon/lat from the line) | `Line`+channels → `Session` |
| `index.ts` | `simulate(track, corridor, params): Session` — the **extension seam** | |

### Corridor extraction

1. Tile range from the centerline bounding box at z18; fetch with
   `crossOrigin='anonymous'`, draw into an `OffscreenCanvas`, read back once.
2. Calibrate the asphalt threshold from pixels under the loaded GPS traces (certainly
   asphalt): `sat ≤ p97(sat_on_line)`, `p2(val)−25 ≤ val ≤ p98(val)+35`.
3. For every 2 m of centerline, take the perpendicular and grow outwards in 0.5 m steps
   from the centre, tolerating up to 4 consecutive non-asphalt steps (kerbs, shadows,
   white lines). Record left/right edge offsets.
4. Median filter (width 15) along the track; reject and interpolate sections over the
   width ceiling or with a sharp jump against neighbours.
5. Store it **on the server**, not per browser: a corridor is extracted once and every
   visitor gets the same one. The store is the FastAPI bridge, which is already deployed
   (kos-web droplet → nginx → systemd `dda-lab` on 127.0.0.1:8777 → cloudflared →
   `https://dda.kitchenonstage.com`; `GET /health` verified live). Two endpoints:
   `GET /corridors/<key>` public, `PUT /corridors/<key>` guarded by `DDA_CORRIDOR_TOKEN`,
   files under `/opt/dda-lab/corridors/`. The key is geographic (slugified name plus the
   track centre to three decimals), because `track.id` is regenerated on every load.
   The write endpoint is internet-facing, so the key is allowlisted against
   `^[a-z0-9][a-z0-9-]{0,63}$`, the payload is size- and shape-checked, and the write goes
   through a temp file and a rename.
   The stored record still carries the centerline fingerprint (point count, length, first
   point) so a corridor saved before the start line moved is rejected rather than
   silently misaligned.

### Solver — QSS three passes, O(n)

```
① lateral limit   v_lat(s) = √( a_lat_max · r(s) )      a_lat_max = min( μ·g , g·tan(lean_max) )
② backward pass   v² ← v² + 2·a_brake·ds                a_brake from brake-g × remaining friction ellipse
③ forward pass    a_drive = min( P/(m·v) , ellipse remainder , wheelie limit ) × TC factor
④ v(s) = min(①,②,③)                                    t = ∫ ds/v
```

Combined grip is the friction ellipse: longitudinal capacity falls as lateral use rises.
The wheelie limit caps acceleration at `g·wheelbase/(2·cg_height)`. ~2000 points at 2 m,
three O(n) passes → sub-millisecond, so the sliders stay live without a worker.

### Rider lag layer

First-order lags on top of the envelope so the output *looks* like real telemetry:
brake-release ramp, post-apex throttle-application delay (the user's "time to
accelerate"), TC torque cut when slip demand exceeds the threshold, plus a gear/rpm
model from gear ratios and the speed trace. This is what makes the chart stack
meaningful — the envelope alone has no `rpm`, `gear`, `tps` or `dtc`.

## Parameters

| Group | Sliders |
|---|---|
| **Machine** | class preset, power (kW), mass (kg incl. rider), CdA, wheelbase, cg height, final drive + gear ratios (used only by the rpm/gear model) |
| **Tyre / track** | friction μ, maximum lean angle, kerb-usage margin (m beyond the corridor), grip scale (a single multiplier on μ standing in for surface and temperature) |
| **Rider** | **ideal-line deviation** (m RMS), **braking longitudinal g**, **throttle-application delay** (s), **traction control** (intervention threshold), **lean-angle usage** (% of tyre limit), **κ line style** (C↔U↔V) |

Preset defaults come from the research above and carry their source inline. A preset is
a starting point; every value stays individually editable.

## Store integration

New state: `simParams: SimParams`, `simSessionId?: string`, `corridor?: Corridor`.
Action `setSimParams(patch)` → `simulate()` → `replaceSession()` (first call
`addSession()`), debounced 30 ms while a slider is dragged. The synthetic session is
flagged `isSim: true` so file-bound features (marker persistence, re-import) skip it.

## UI

- `bottomTab` gains `'sim'` → `SimPanel.tsx` with three collapsible groups, a
  "Extract corridor" button and the computed lap time in the header.
- Two new map layers: `corridor` (extracted edges) and `idealLine` (the generated line).
- Everything else — trace, heat maps, charts, cursor, Δt — is existing machinery.

## Error handling

Tiles unreachable or CORS-blocked → corridor extraction fails with a status message and
the panel falls back to a uniform half-width slider; the simulator still runs. No track
loaded → the sim tab explains it needs a track. No stored corridor for this track → the
one small `GET` on track load returns 404 and the fallback applies; tile extraction is
only ever run from the button, never automatically (it is ~54 network requests). No
write token → extraction still works for this session, it just is not published.

## Testing

- `corridor.test.ts` — edge extraction over a synthetic raster with a known corridor;
  leak rejection; cache round-trip.
- `line.test.ts` — κ=0 gives low curvature variance, κ=1 high concentration; the line
  stays inside the corridor for every κ.
- `solver.test.ts` — analytic lap time on a constant-radius circle; energy consistency;
  parameter monotonicity (brake g ↑ → lap time ↓, μ ↓ → lap time ↑).
- `toSession.test.ts` — channel completeness, 10 Hz grid, GPS round-trip.
- Playwright e2e — drag a slider, assert the map trace and charts update.
- Visual verification with a dev server and Playwright before the work is called done,
  per the project's standing rule.

## Extension seam

`simulate()` takes `(track, corridor, params)` and returns a `Session`. `solver.ts` +
`rider.ts` sit behind that single call, so a time-domain dynamic solver (load transfer,
tyre slip, preview controller) can replace them without touching the line generator,
the corridor extractor, `toSession`, the store or the UI.
