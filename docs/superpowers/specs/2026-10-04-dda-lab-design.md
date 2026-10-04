# DDA Lab — Professional telemetry analysis UI (design spec)

Date: 2026-10-04. Status: approved by owner (all recommended options accepted).

## Goal
A MoTeC-i2-class analysis workspace for Ducati DDA(+GPS) sessions: analysis panels on
the left, a full-height map on the right, multi-session/lap comparison, derived and
user-defined (math) channels, track model with turns/apexes, ready reports, external
CSV alignment, and import of a drawn track schema interpreted by Claude (local bridge).

## Non-goals
Video overlay/export (stays in the existing viewer); cloud sync; mobile layout.

## Stack and location
- `DDA_Reader/dda_lab/` — Vite + React 18 + TypeScript (strict), Zustand, uPlot (charts),
  MapLibre GL (map; Esri World Imagery raster + OSM raster; no API keys), Zod (validation),
  Vitest + Playwright. Production build → `DDA_Reader/viewer_lab/` (static).
- `DDA_Reader/dda_lab_bridge.py` — FastAPI on 127.0.0.1:8777, started by the PyQt GUI
  (and runnable standalone). Endpoints: `/health`, `/analyze-schema` (image → JSON via
  `claude -p`), `/files` (optional: list .dda in a folder). Everything stays on this Mac.
- GUI: "🚀 Launch Viewer" opens `viewer_lab/index.html` (old viewer remains as
  "Classic viewer").

## Data model (TypeScript)
```
Session { id, name, source: 'dda'|'json'|'csv', color, t: Float64Array /*s, 10 Hz*/,
          channels: Map<string, Channel>, laps: Lap[], meta: {track, rider, note} }
Channel { name, unit, kind: 'raw'|'derived'|'math'|'external', data: Float32Array,
          raw?: {t: Float64Array, v: Float32Array} /* native rate, e.g. RPM 50 Hz */,
          proc: ChannelProc }
ChannelProc { source?: 'wheel'|'gps'|'blend', scale: 1, offset: 0,
              filter: {type:'none'|'ma'|'sg'|'butter', n?, cutoffHz?},
              gpsLagS?: number, invert?: boolean }
Lap { n, startIdx, endIdx, timeS, sectorsS: number[], isBest, kind: 'flying'|'out'|'in' }
TrackModel { id, name, center: LngLat, centerline: LngLat[] /*2 m*/, lengthM,
             startFinish: Gate, sectors: Gate[], turns: Turn[], schema?: SchemaLayer }
Turn { n, name, dir: 'L'|'R', apexGeo: LngLat, radiusM, sIdxRange: [startM, endM] }
SchemaLayer { imageUrl, affine: number[6], apexes: Pt[], racingLine: Pt[], markers: Marker[] }
```
Common 10 Hz time base; GPS-derived distance; lap-relative distance for overlays.

## Input
- `.dda` parsed in-browser by a TypeScript port of the slot-packed decoder
  (channel table read from file; rates/sizes from a name→spec table; whole-second stream).
  Must match the Python parser byte-for-byte on sample_run.dda (test).
- `.json` / `.csv` from DDA_Reader exports (column auto-mapping).
- External CSV: column mapping dialog (time column, unit, decimal separator), time offset
  slider with live chart preview, resample to 10 Hz (linear/step), added as `external`.

## Channel processing pipeline
raw → source select (Speed: wheel/GPS/blend; Distance: ECU/GPS) → `a·x+b` → filter
(none / moving average N / Savitzky-Golay / Butterworth low-pass fc) → corrections
(GPS lag shift, auto-align by cross-correlation of GPS vs wheel speed; sign invert) →
display. Derived channels consume the processed output. Settings per channel, per
session, saved in workspace; "reset" and "apply to all sessions".

## Derived channels (computed at load)
gps_speed, long_g, lat_g, total_g, curvature/radius, wheel_slip (gps vs wheel), phase
(brake/coast/throttle), sector time, delta-T vs reference lap (time variance).

## Layout (left analysis / right map)
Top bar: sessions chips [+], X axis Time|Distance, units km/h|mph, workspace save/load.
Left (62%, draggable splitter): lap table (Lap, Time, S1..S3, Δbest, Vmax, sortable,
multi-select for overlay) → chart stack (uPlot, shared cursor, linked zoom via drag,
double-click reset, add/remove panels, multi-channel per panel with L/R axis, turn
markers) → bottom tabs: Channels | Math | Reports | External | Cursor values.
Right (38%): MapLibre map, layers toggle (satellite/OSM/plain, centerline, turn numbers,
apex ▲ brake ● throttle ◆ max-lean ∠, selected lap traces colored by speed/throttle/lean/
brake, sector gates, cursor bike icon, schema overlay), tools: measure, edit gates, fit,
maximize. Chart hover → map cursor; map click → chart cursor.

## Track model
From best 5 laps: resample GPS at 2 m, align by distance, average → centerline.
Curvature (3-point circle) → signed peaks → turns (threshold R<150 m, min separation
30 m; user can merge/split/rename). Per lap per turn: geometric apex (max curvature),
dynamic apex (min speed), brake point (long_g < −0.3 g onset), throttle-on (TPS > 20 %
after apex), max lean. Sector gates: default 3 equal-distance, draggable, perpendicular
to centerline. Saved as `tracks/<id>.json`, auto-recognized by GPS center (≤3 km).
GPX/OSM import optional.

## Reports (bottom tab)
Sector table (lap × sector, best cells green, theoretical best, consistency σ);
Turn table (turn × lap: entry/apex/exit speed, max lean, brake distance, throttle-on
distance, apex deviation to schema if present); histograms (gear %, RPM, throttle);
G-G diagram; lean vs throttle matrix; "where I lost time" summary vs best lap.
All exportable CSV/PNG.

## Math channels
Safe expression evaluator (own tokenizer/parser, no eval). Identifiers = channel names;
operators + - * / ^ comparisons && || !; functions abs min max sqrt pow deriv integ
smooth(ch,n) shift(ch,s) lap_min lap_max where(c,a,b). Dependency-ordered recompute;
unit/color/name user-defined; stored in workspace.

## Schema import + Claude bridge
Map panel → "Import schema" (PNG/JPG/PDF; PDF page 1 rasterized). POST to bridge.
Bridge runs `claude -p` with the image path and a fixed prompt requesting strict JSON:
`{track_outline, racing_line, apexes[{turn,x,y,label}], markers[{type,x,y,text}],
start_finish, turn_labels}` with normalized 0..1 image coordinates. Zod-validated; one
retry on invalid JSON. UI shows image as semi-transparent overlay; user picks 3+ point
pairs (image ↔ map) → affine least squares; fine-tune sliders. Saved in track JSON as
`schema`. Layers: coach apexes (orange) vs computed apexes (white); apex deviation (m)
into turn table. If bridge/claude unavailable → manual marking mode. Image and Claude
output remain local (`tracks/schemas/`).

## Workspace
`workspace.json`: panel layout, channel procs, math channels, selected sessions/laps,
map layers. Export/import.

## Testing
Vitest: dda parser port vs Python output; resampling; centerline/turn detection on
synthetic circles; apex/brake detection; expression engine; affine fit; CSV mapping.
Playwright: layout, cursor sync, lap overlay, CSV import, schema import w/ mocked bridge.
pytest: bridge schema validation, claude-missing error path.

## Implementation order (separate plans/commits)
1 skeleton+loading+charts+map+cursor+lap table · 2 processing pipeline + multi-session ·
3 track model + layers · 4 reports · 5 math channels + external CSV · 6 schema + bridge.
