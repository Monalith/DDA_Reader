# Virtual Rider & Lap-Time Simulator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A parametric virtual motorcycle rider in DDA Lab: machine / tyre-track / rider sliders produce a simulated lap that renders through the existing map, charts, cursor and Δt machinery.

**Architecture:** Track boundaries are extracted from Esri satellite tiles by asphalt segmentation. A κ-parameterised racing line is generated inside that corridor. A quasi-steady-state three-pass solver turns the line's curvature into a velocity profile; a rider lag layer adds the channels that make the charts meaningful. The result is packaged as an ordinary `Session`, so no new visualisation code is needed.

**Tech Stack:** TypeScript (strict), React 19, Zustand, MapLibre GL 6, Vitest (node environment), Playwright.

**Spec:** `docs/superpowers/specs/2026-10-09-virtual-rider-design.md` (commit df9565c)

## Global Constraints

- All new code lives under `dda_lab/src/sim/`. Tests go in `dda_lab/tests/unit/`.
- Vitest runs with `environment: 'node'` (`vitest.config.ts`). **No test may touch `fetch`, `document`, `Image`, `OffscreenCanvas` or `localStorage`.** Every browser dependency is injected as a function parameter so the pure logic is node-testable.
- TypeScript strict. `npm run typecheck` must pass before every commit.
- Distances in metres, angles in degrees, speeds in m/s inside the solver and km/h only at the `Session` boundary (matches `DDA_NAME_MAP`: `speed` is km/h).
- Positions are `LngLat = [number, number]` i.e. `[lng, lat]` — never `[lat, lng]`.
- Esri World Imagery native maximum zoom is **18** (`ESRI_MAX_TILE_Z` in `src/ui/MapView.tsx:71`). The extractor pins z18 and never requests deeper.
- Reuse `src/core/geo.ts` (`haversineM`, `bearingDeg`, `toLocalM`, `fromLocalM`) and `src/core/filters.ts` (`movingAverage`) rather than writing new geodesy or filtering.
- Commit after every task with a `feat(sim):` or `test(sim):` prefix.

## Review Focus

These are input classes the spec implies but that no task's happy-path tests would exercise. Each has a test assigned to the task that owns the code.

1. **No GPS traces loaded when the corridor is extracted** — asphalt calibration samples the pixels under the loaded traces; with none, the percentile calls operate on an empty array and produce `NaN` thresholds, masking everything or nothing. Expected: throw a named error the UI turns into a status message. *(Task 2, Step 9)*
2. **Partial tile failure** — a 404 or timeout leaves a black hole in the mosaic; black reads as non-asphalt, so the corridor silently collapses to zero width there rather than reporting unknown. Expected: unfetched tiles are tracked and their sections are marked unknown and interpolated, not zeroed. *(Task 2, Step 13)*
3. **Straight sections (curvature ≈ 0)** — `v_lat = √(a_lat·r)` goes to infinity as `r → ∞`, putting `Infinity` into the velocity profile and `NaN` into every downstream channel. Expected: clamped by the drag-limited top speed. *(Task 7, Step 9)*
4. **A slider dragged to its minimum (μ = 0, power = 0, mass = 0)** — divisions by zero send `NaN`/`Infinity` into the `Session`, which breaks every chart at once and is hard to attribute. Expected: parameters are clamped to physical floors on entry and the solver always returns a finite profile. *(Task 7, Step 13)*
5. **Cached corridor after the start line moves** — `setStartLine()` calls `normalizeTrackOrigin()` (`src/core/track.ts:363`), which *rotates* `centerline`, so a corridor cached against the old origin is silently misaligned by the rotation offset. Expected: the cache records the centerline length and first point, and a mismatch invalidates it. *(Task 3, Step 9)*

---

## File Structure

| File | Responsibility |
|---|---|
| `src/sim/tiles.ts` | Web-Mercator tile maths and mosaic assembly from an injected tile loader |
| `src/sim/corridor.ts` | Asphalt mask, perpendicular cross-sections, left/right edges, leak rejection |
| `src/sim/corridorCache.ts` | Corridor serialisation and staleness check |
| `src/sim/browserTiles.ts` | The one browser-only module: fetch + `OffscreenCanvas` → `ImageData` |
| `src/sim/types.ts` | `Corridor`, `Line`, `SimParams`, `Envelope` |
| `src/sim/presets.ts` | Machine / tyre-track / rider preset tables with sources |
| `src/sim/line.ts` | κ-parameterised racing line inside the corridor |
| `src/sim/solver.ts` | QSS three-pass velocity envelope |
| `src/sim/rider.ts` | Lag layer: brake ramp, throttle delay, TC, gear/rpm |
| `src/sim/toSession.ts` | Arc-length → 10 Hz time grid; synthetic `Session` |
| `src/sim/index.ts` | `simulate()` — the extension seam |
| `src/ui/panels/SimPanel.tsx` | Three slider groups, extract button, lap-time readout |
| `src/ui/SimLayers.ts` | `corridorGeoJson()`, `idealLineGeoJson()` |

Modified: `src/state/store.ts`, `src/ui/panels/BottomPanels.tsx`, `src/ui/MapView.tsx`, `src/core/types.ts`.

---

# Group A — Corridor extraction

Physics must not be built on an unverified corridor. Group A ends with the extracted edges visible on the Serres satellite map.

---

### Task 1: Tile maths and mosaic assembly

**Files:**
- Create: `dda_lab/src/sim/tiles.ts`
- Test: `dda_lab/tests/unit/simTiles.test.ts`

**Interfaces:**
- Consumes: `LngLat` from `src/core/types.ts`
- Produces:
  - `export const TILE_SIZE = 256`
  - `export const SAT_ZOOM = 18`
  - `export function lngLatToPixel(p: LngLat, z: number): [number, number]`
  - `export function pixelToLngLat(px: [number, number], z: number): LngLat`
  - `export function metresPerPixel(lat: number, z: number): number`
  - `export interface TileRange { tx0: number; tx1: number; ty0: number; ty1: number; z: number }`
  - `export function tileRangeFor(points: LngLat[], z: number, padPx: number): TileRange`
  - `export interface Mosaic { width: number; height: number; originPx: [number, number]; rgb: Uint8ClampedArray; missing: boolean[] }`
  - `export type TileLoader = (z: number, x: number, y: number) => Promise<Uint8ClampedArray | null>`
  - `export function tileUrl(z: number, x: number, y: number): string`
  - `export async function buildMosaic(range: TileRange, load: TileLoader): Promise<Mosaic>`

- [ ] **Step 1: Write the failing test for the projection round-trip**

Create `dda_lab/tests/unit/simTiles.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { lngLatToPixel, metresPerPixel, pixelToLngLat, SAT_ZOOM, tileRangeFor } from '../../src/sim/tiles';
import type { LngLat } from '../../src/core/types';

const SERRES: LngLat = [23.51802, 41.0730586];

describe('tiles', () => {
  it('round-trips lng/lat through pixel space', () => {
    const px = lngLatToPixel(SERRES, SAT_ZOOM);
    const back = pixelToLngLat(px, SAT_ZOOM);
    expect(back[0]).toBeCloseTo(SERRES[0], 9);
    expect(back[1]).toBeCloseTo(SERRES[1], 9);
  });

  it('gives 0.45 m/px at z18 at the Serres latitude', () => {
    // 156543.03392 * cos(41.073) / 2^18
    expect(metresPerPixel(SERRES[1], SAT_ZOOM)).toBeCloseTo(0.45, 2);
  });

  it('covers every point, with padding, in the tile range', () => {
    const pts: LngLat[] = [SERRES, [23.525, 41.078], [23.512, 41.069]];
    const r = tileRangeFor(pts, SAT_ZOOM, 60);
    for (const p of pts) {
      const [x, y] = lngLatToPixel(p, SAT_ZOOM);
      expect(Math.floor(x / 256)).toBeGreaterThanOrEqual(r.tx0);
      expect(Math.floor(x / 256)).toBeLessThanOrEqual(r.tx1);
      expect(Math.floor(y / 256)).toBeGreaterThanOrEqual(r.ty0);
      expect(Math.floor(y / 256)).toBeLessThanOrEqual(r.ty1);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd dda_lab && npx vitest run tests/unit/simTiles.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/sim/tiles"`.

- [ ] **Step 3: Implement the projection helpers**

Create `dda_lab/src/sim/tiles.ts`:

```ts
// Web-Mercator tile maths for the satellite corridor extractor.
//
// Esri World Imagery has no native imagery past z18 (see ESRI_MAX_TILE_Z in
// MapView.tsx), so the extractor pins z18: ~0.45 m/px at European latitudes,
// which puts ~22 px across a 10 m wide circuit.
import type { LngLat } from '../core/types';

export const TILE_SIZE = 256;
export const SAT_ZOOM = 18;

/** Equatorial circumference / 256, the z0 ground resolution in m/px. */
const EQUATOR_MPP = 156543.03392;

export function lngLatToPixel(p: LngLat, z: number): [number, number] {
  const n = TILE_SIZE * 2 ** z;
  const s = Math.sin((p[1] * Math.PI) / 180);
  const clamped = Math.min(0.9999, Math.max(-0.9999, s));
  return [
    ((p[0] + 180) / 360) * n,
    (0.5 - Math.log((1 + clamped) / (1 - clamped)) / (4 * Math.PI)) * n,
  ];
}

export function pixelToLngLat(px: [number, number], z: number): LngLat {
  const n = TILE_SIZE * 2 ** z;
  return [
    (px[0] / n) * 360 - 180,
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * px[1]) / n))) * 180) / Math.PI,
  ];
}

export function metresPerPixel(lat: number, z: number): number {
  return (EQUATOR_MPP * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
}

export interface TileRange {
  tx0: number;
  tx1: number;
  ty0: number;
  ty1: number;
  z: number;
}

export function tileRangeFor(points: LngLat[], z: number, padPx: number): TileRange {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const p of points) {
    const [x, y] = lngLatToPixel(p, z);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  if (!Number.isFinite(x0)) throw new Error('tileRangeFor: no finite points');
  return {
    z,
    tx0: Math.floor((x0 - padPx) / TILE_SIZE),
    tx1: Math.floor((x1 + padPx) / TILE_SIZE),
    ty0: Math.floor((y0 - padPx) / TILE_SIZE),
    ty1: Math.floor((y1 + padPx) / TILE_SIZE),
  };
}

export function tileUrl(z: number, x: number, y: number): string {
  return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd dda_lab && npx vitest run tests/unit/simTiles.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing test for mosaic assembly**

Append to `dda_lab/tests/unit/simTiles.test.ts`:

```ts
import { buildMosaic, TILE_SIZE, type TileLoader } from '../../src/sim/tiles';

function solidTile(r: number, g: number, b: number): Uint8ClampedArray {
  const a = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 3);
  for (let i = 0; i < TILE_SIZE * TILE_SIZE; i++) {
    a[i * 3] = r;
    a[i * 3 + 1] = g;
    a[i * 3 + 2] = b;
  }
  return a;
}

describe('buildMosaic', () => {
  const range = { tx0: 10, tx1: 11, ty0: 20, ty1: 20, z: 18 };

  it('stitches tiles side by side at the right offsets', async () => {
    const load: TileLoader = async (_z, x) => solidTile(x === 10 ? 10 : 200, 0, 0);
    const m = await buildMosaic(range, load);
    expect(m.width).toBe(TILE_SIZE * 2);
    expect(m.height).toBe(TILE_SIZE);
    expect(m.originPx).toEqual([10 * TILE_SIZE, 20 * TILE_SIZE]);
    expect(m.rgb[0]).toBe(10); // left tile
    expect(m.rgb[TILE_SIZE * 3]).toBe(200); // first pixel of the right tile
    expect(m.missing.some(Boolean)).toBe(false);
  });

  it('flags tiles that failed to load instead of leaving silent black', async () => {
    const load: TileLoader = async (_z, x) => (x === 11 ? null : solidTile(10, 0, 0));
    const m = await buildMosaic(range, load);
    expect(m.missing[0]).toBe(false);
    expect(m.missing[1]).toBe(true);
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `cd dda_lab && npx vitest run tests/unit/simTiles.test.ts`
Expected: FAIL — `buildMosaic is not a function`.

- [ ] **Step 7: Implement mosaic assembly**

Append to `dda_lab/src/sim/tiles.ts`:

```ts
/** Loads one tile as tightly packed RGB, or null when it could not be fetched. */
export type TileLoader = (z: number, x: number, y: number) => Promise<Uint8ClampedArray | null>;

export interface Mosaic {
  width: number;
  height: number;
  /** Pixel coordinate (at `range.z`) of the mosaic's top-left corner. */
  originPx: [number, number];
  /** Tightly packed RGB, `width * height * 3`. */
  rgb: Uint8ClampedArray;
  /** One flag per tile in row-major (ty outer, tx inner) order; true = not fetched. */
  missing: boolean[];
}

/** Maximum tiles fetched at once, to stay polite to the imagery server. */
const CONCURRENCY = 12;

export async function buildMosaic(range: TileRange, load: TileLoader): Promise<Mosaic> {
  const cols = range.tx1 - range.tx0 + 1;
  const rows = range.ty1 - range.ty0 + 1;
  const width = cols * TILE_SIZE;
  const height = rows * TILE_SIZE;
  const rgb = new Uint8ClampedArray(width * height * 3);
  const missing = new Array<boolean>(cols * rows).fill(false);

  const jobs: Array<{ tx: number; ty: number; slot: number }> = [];
  for (let ty = range.ty0; ty <= range.ty1; ty++) {
    for (let tx = range.tx0; tx <= range.tx1; tx++) {
      jobs.push({ tx, ty, slot: (ty - range.ty0) * cols + (tx - range.tx0) });
    }
  }

  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const job = jobs[next++];
      if (!job) return;
      let tile: Uint8ClampedArray | null = null;
      try {
        tile = await load(range.z, job.tx, job.ty);
      } catch {
        tile = null;
      }
      if (!tile) {
        missing[job.slot] = true;
        continue;
      }
      const ox = (job.tx - range.tx0) * TILE_SIZE;
      const oy = (job.ty - range.ty0) * TILE_SIZE;
      for (let r = 0; r < TILE_SIZE; r++) {
        const src = r * TILE_SIZE * 3;
        const dst = ((oy + r) * width + ox) * 3;
        rgb.set(tile.subarray(src, src + TILE_SIZE * 3), dst);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));

  return {
    width,
    height,
    originPx: [range.tx0 * TILE_SIZE, range.ty0 * TILE_SIZE],
    rgb,
    missing,
  };
}
```

- [ ] **Step 8: Run the tests and the type check**

Run: `cd dda_lab && npx vitest run tests/unit/simTiles.test.ts && npm run typecheck`
Expected: PASS (5 tests), typecheck clean.

- [ ] **Step 9: Commit**

```bash
git add dda_lab/src/sim/tiles.ts dda_lab/tests/unit/simTiles.test.ts
git commit -m "feat(sim): web-mercator tile maths and mosaic assembly

Injected TileLoader keeps the module node-testable; failed tiles are
flagged in Mosaic.missing instead of leaving silent black pixels.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Corridor extraction from a mosaic

**Files:**
- Create: `dda_lab/src/sim/types.ts`, `dda_lab/src/sim/corridor.ts`
- Test: `dda_lab/tests/unit/simCorridor.test.ts`

**Interfaces:**
- Consumes: `Mosaic`, `metresPerPixel`, `lngLatToPixel` from `src/sim/tiles.ts`; `TrackModel`, `LngLat` from `src/core/types.ts`
- Produces:
  - `export interface Corridor { stepM: number; leftM: Float32Array; rightM: Float32Array; known: boolean[] }` (in `src/sim/types.ts`)
  - `export class CorridorError extends Error { constructor(public code: 'no-traces' | 'no-track' | 'tiles-failed', message: string) }`
  - `export function calibrateAsphalt(m: Mosaic, samplesPx: Array<[number, number]>): { satMax: number; valLo: number; valHi: number }`
  - `export function extractCorridor(track: TrackModel, mosaic: Mosaic, tracePoints: LngLat[], opts?: CorridorOpts): Corridor`
  - `export interface CorridorOpts { halfSearchM?: number; stepM?: number; gapTolerance?: number; maxWidthM?: number }`

The corridor is sampled **once per centerline vertex** so `leftM[i]` and `rightM[i]` line up with `track.centerline[i]` and `track.cumDistM[i]` with no interpolation anywhere.

- [ ] **Step 1: Write the failing test for asphalt calibration**

Create `dda_lab/tests/unit/simCorridor.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { calibrateAsphalt } from '../../src/sim/corridor';
import { TILE_SIZE, type Mosaic } from '../../src/sim/tiles';

/** A mosaic with a grey horizontal band (asphalt) on a green field. */
function bandMosaic(bandHalfPx: number): Mosaic {
  const width = TILE_SIZE;
  const height = TILE_SIZE;
  const rgb = new Uint8ClampedArray(width * height * 3);
  const mid = height / 2;
  for (let y = 0; y < height; y++) {
    const onBand = Math.abs(y - mid) <= bandHalfPx;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      if (onBand) {
        rgb[i] = 128; rgb[i + 1] = 130; rgb[i + 2] = 132; // grey, saturation ~0.03
      } else {
        rgb[i] = 60; rgb[i + 1] = 120; rgb[i + 2] = 50; // green, saturation ~0.58
      }
    }
  }
  return { width, height, originPx: [0, 0], rgb, missing: [false] };
}

describe('calibrateAsphalt', () => {
  it('derives thresholds that accept the band and reject the field', () => {
    const m = bandMosaic(12);
    const samples: Array<[number, number]> = [[10, 128], [60, 128], [200, 128]];
    const cal = calibrateAsphalt(m, samples);
    expect(cal.satMax).toBeLessThan(0.2);
    expect(cal.valLo).toBeLessThan(129);
    expect(cal.valHi).toBeGreaterThan(129);
  });

  it('throws a named error when there are no samples to calibrate from', () => {
    const m = bandMosaic(12);
    expect(() => calibrateAsphalt(m, [])).toThrowError(/no-traces|no samples/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd dda_lab && npx vitest run tests/unit/simCorridor.test.ts`
Expected: FAIL — cannot resolve `../../src/sim/corridor`.

- [ ] **Step 3: Create the shared sim types**

Create `dda_lab/src/sim/types.ts`:

```ts
// Shared data model for the virtual rider. See
// docs/superpowers/specs/2026-10-09-virtual-rider-design.md
import type { LngLat } from '../core/types';

/**
 * Track boundaries, one entry per centerline vertex of the track it was built
 * for. `leftM[i]` / `rightM[i]` are the distances in metres from
 * `centerline[i]` to the asphalt edge, left and right of the direction of
 * travel. `known[i]` is false where extraction could not decide.
 */
export interface Corridor {
  /** Centerline spacing the corridor was sampled at, metres (informational). */
  stepM: number;
  leftM: Float32Array;
  rightM: Float32Array;
  known: boolean[];
}

/** A generated racing line, sampled at the same spacing as the centerline. */
export interface Line {
  points: LngLat[];
  /** Signed curvature, 1/m, positive = turning left. */
  curvature: Float32Array;
  /** Cumulative distance along the line, metres. */
  cumDistM: Float64Array;
  lengthM: number;
  /** Lateral offset from the centerline that produced each point, metres. */
  offsetM: Float32Array;
}

/** The solver's velocity profile and the g's that produced it. */
export interface Envelope {
  /** Speed along the line, m/s. */
  v: Float32Array;
  /** Longitudinal acceleration, g (negative = braking). */
  longG: Float32Array;
  /** Lateral acceleration, g (signed, positive = turning left). */
  latG: Float32Array;
  /** Lean angle, degrees (signed, positive = leaning left). */
  leanDeg: Float32Array;
  /** Elapsed time at each sample, seconds from the start line. */
  tS: Float64Array;
  lapTimeS: number;
}
```

- [ ] **Step 4: Implement calibration**

Create `dda_lab/src/sim/corridor.ts`:

```ts
// Track corridor from satellite imagery.
//
// Asphalt is separated from its surroundings by COLOUR SATURATION, not
// brightness: measured over the Serres lap, on-track saturation is 0.069
// against 0.239 off-track (3.5x), while brightness differs by only ~21 grey
// levels. Thresholds are calibrated per track from the pixels under the loaded
// GPS traces, which are asphalt by definition.
import { movingAverage } from '../core/filters';
import { toLocalM } from '../core/geo';
import type { LngLat, TrackModel } from '../core/types';
import { lngLatToPixel, metresPerPixel, type Mosaic } from './tiles';
import type { Corridor } from './types';

export class CorridorError extends Error {
  constructor(public code: 'no-traces' | 'no-track' | 'tiles-failed', message: string) {
    super(message);
    this.name = 'CorridorError';
  }
}

export interface AsphaltCal {
  satMax: number;
  valLo: number;
  valHi: number;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}

/** Saturation (0..1) and value (0..255) of one mosaic pixel; NaN when outside. */
function pixelSV(m: Mosaic, x: number, y: number): [number, number] {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= m.width || yi >= m.height) return [NaN, NaN];
  const i = (yi * m.width + xi) * 3;
  const r = m.rgb[i];
  const g = m.rgb[i + 1];
  const b = m.rgb[i + 2];
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  return [mx > 0 ? (mx - mn) / mx : 0, (r + g + b) / 3];
}

/**
 * Asphalt thresholds from pixels known to be on the track. Widened past the
 * observed range so kerbs and shadows at the edges are not cut off before the
 * gap tolerance gets a chance to bridge them.
 */
export function calibrateAsphalt(m: Mosaic, samplesPx: Array<[number, number]>): AsphaltCal {
  const sats: number[] = [];
  const vals: number[] = [];
  for (const [x, y] of samplesPx) {
    const [s, v] = pixelSV(m, x, y);
    if (Number.isFinite(s) && Number.isFinite(v)) {
      sats.push(s);
      vals.push(v);
    }
  }
  if (sats.length < 10) {
    throw new CorridorError(
      'no-traces',
      'Corridor extraction needs loaded GPS laps to learn what asphalt looks like. Open a session first.',
    );
  }
  sats.sort((a, b) => a - b);
  vals.sort((a, b) => a - b);
  return {
    satMax: percentile(sats, 97),
    valLo: percentile(vals, 2) - 25,
    valHi: percentile(vals, 98) + 35,
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd dda_lab && npx vitest run tests/unit/simCorridor.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Write the failing test for edge extraction**

Append to `dda_lab/tests/unit/simCorridor.test.ts`:

```ts
import { extractCorridor } from '../../src/sim/corridor';
import { lngLatToPixel, metresPerPixel, SAT_ZOOM, type Mosaic } from '../../src/sim/tiles';
import type { LngLat, TrackModel } from '../../src/core/types';

const LAT = 41.073;
const LNG = 23.518;

/**
 * A straight east-west track of known width, rendered into a synthetic mosaic,
 * with a matching TrackModel whose centerline runs down the middle of it.
 */
function straightTrack(widthM: number): { track: TrackModel; mosaic: Mosaic; trace: LngLat[] } {
  const mpp = metresPerPixel(LAT, SAT_ZOOM);
  const n = 120; // centerline vertices, 2 m apart
  const stepM = 2;
  const centerline: LngLat[] = [];
  // 2 m east per step, using the same local projection the extractor uses
  const mPerDegLng = 111320 * Math.cos((LAT * Math.PI) / 180);
  for (let i = 0; i < n; i++) centerline.push([LNG + (i * stepM) / mPerDegLng, LAT]);

  const origin = lngLatToPixel(centerline[0], SAT_ZOOM);
  const end = lngLatToPixel(centerline[n - 1], SAT_ZOOM);
  const pad = 200;
  const width = Math.ceil(Math.abs(end[0] - origin[0])) + pad * 2;
  const height = pad * 2;
  const originPx: [number, number] = [origin[0] - pad, origin[1] - pad];
  const rgb = new Uint8ClampedArray(width * height * 3);
  const halfPx = widthM / 2 / mpp;
  for (let y = 0; y < height; y++) {
    const onBand = Math.abs(y - (origin[1] - originPx[1])) <= halfPx;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      if (onBand) { rgb[i] = 128; rgb[i + 1] = 130; rgb[i + 2] = 132; }
      else { rgb[i] = 60; rgb[i + 1] = 120; rgb[i + 2] = 50; }
    }
  }

  const cumDistM = new Float64Array(n);
  for (let i = 1; i < n; i++) cumDistM[i] = cumDistM[i - 1] + stepM;
  const track: TrackModel = {
    id: 't', name: 'straight', center: centerline[0], centerline, cumDistM,
    lengthM: cumDistM[n - 1],
    startFinish: { id: 'sf', name: 'SF', type: 'sf', at: centerline[0], bearingDeg: 90, halfWidthM: 15 },
    sectors: [], turns: [],
  };
  return { track, mosaic: { width, height, originPx, rgb, missing: [false] }, trace: centerline };
}

describe('extractCorridor', () => {
  it('recovers a known track width to within half a metre', () => {
    const { track, mosaic, trace } = straightTrack(12);
    const c = extractCorridor(track, mosaic, trace);
    expect(c.leftM.length).toBe(track.centerline.length);
    const mid = Math.floor(c.leftM.length / 2);
    const widths: number[] = [];
    for (let i = mid - 20; i <= mid + 20; i++) widths.push(c.leftM[i] + c.rightM[i]);
    const median = widths.sort((a, b) => a - b)[Math.floor(widths.length / 2)];
    expect(median).toBeGreaterThan(11.5);
    expect(median).toBeLessThan(12.5);
  });

  it('rejects sections wider than the ceiling instead of reporting them', () => {
    const { track, mosaic, trace } = straightTrack(40); // wider than maxWidthM
    const c = extractCorridor(track, mosaic, trace, { maxWidthM: 18 });
    const mid = Math.floor(c.known.length / 2);
    expect(c.known[mid]).toBe(false);
  });

  it('marks sections over a missing tile as unknown rather than zero width', () => {
    const { track, mosaic, trace } = straightTrack(12);
    const holed: Mosaic = { ...mosaic, missing: [true] };
    const c = extractCorridor(track, holed, trace);
    expect(c.known.every((k) => k === false)).toBe(true);
  });

  it('throws no-traces when no GPS points are supplied', () => {
    const { track, mosaic } = straightTrack(12);
    expect(() => extractCorridor(track, mosaic, [])).toThrowError(/no-traces|asphalt/i);
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `cd dda_lab && npx vitest run tests/unit/simCorridor.test.ts`
Expected: FAIL — `extractCorridor is not a function`.

- [ ] **Step 8: Implement edge extraction**

Append to `dda_lab/src/sim/corridor.ts`:

```ts
export interface CorridorOpts {
  /** How far either side of the centerline to search, metres. */
  halfSearchM?: number;
  /** Search step along the perpendicular, metres. */
  stepM?: number;
  /** Consecutive non-asphalt steps bridged before the edge is called, in steps. */
  gapTolerance?: number;
  /** Widths above this are a leak into pit lane / run-off / paddock, metres. */
  maxWidthM?: number;
}

const DEFAULTS: Required<CorridorOpts> = {
  halfSearchM: 25,
  stepM: 0.5,
  gapTolerance: 4,
  maxWidthM: 18,
};

/** Median over a wrapping window; the centerline is a closed loop. */
function medianFilterWrap(a: Float32Array, n: number): Float32Array {
  const out = new Float32Array(a.length);
  const h = n >> 1;
  const buf: number[] = [];
  for (let i = 0; i < a.length; i++) {
    buf.length = 0;
    for (let k = -h; k <= h; k++) {
      const j = (i + k + a.length) % a.length;
      if (Number.isFinite(a[j])) buf.push(a[j]);
    }
    buf.sort((x, y) => x - y);
    out[i] = buf.length ? buf[buf.length >> 1] : NaN;
  }
  return out;
}

/**
 * Left/right asphalt edge at every centerline vertex.
 *
 * At each vertex the centerline tangent is taken over a +-10 m stencil (GPS
 * noise makes immediate neighbours useless), and the perpendicular is walked
 * outwards in `stepM` steps. `gapTolerance` steps of non-asphalt are bridged so
 * kerbs, white lines and shadows do not end the search early.
 */
export function extractCorridor(
  track: TrackModel,
  mosaic: Mosaic,
  tracePoints: LngLat[],
  opts: CorridorOpts = {},
): Corridor {
  const o = { ...DEFAULTS, ...opts };
  const cl = track.centerline;
  const n = cl.length;
  if (n < 3) throw new CorridorError('no-track', 'The track has no usable centerline.');

  const [ox, oy] = mosaic.originPx;
  const toMosaic = (p: LngLat): [number, number] => {
    const [x, y] = lngLatToPixel(p, SAT_ZOOM_REF);
    return [x - ox, y - oy];
  };

  const cal = calibrateAsphalt(mosaic, tracePoints.map(toMosaic));
  const mpp = metresPerPixel(track.center[1], SAT_ZOOM_REF);

  const isAsphalt = (x: number, y: number): boolean => {
    const [s, v] = pixelSV(mosaic, x, y);
    if (!Number.isFinite(s)) return false;
    return s <= cal.satMax && v >= cal.valLo && v <= cal.valHi;
  };

  // A mosaic with any missing tile cannot be trusted anywhere: the hole's
  // position is known per tile, but a corridor with silent gaps is worse than
  // one the caller is told to re-extract.
  const anyMissing = mosaic.missing.some(Boolean);

  // tangent stencil: ~10 m either side
  const stepAlongM = track.lengthM / Math.max(1, n - 1);
  const k = Math.max(1, Math.round(10 / Math.max(0.1, stepAlongM)));

  const leftRaw = new Float32Array(n);
  const rightRaw = new Float32Array(n);
  const nSteps = Math.round(o.halfSearchM / o.stepM);

  for (let i = 0; i < n; i++) {
    const a = cl[(i - k + n) % n];
    const b = cl[(i + k) % n];
    const am = toLocalM(cl[i], a);
    const bm = toLocalM(cl[i], b);
    const tx = bm[0] - am[0];
    const ty = bm[1] - am[1];
    const len = Math.hypot(tx, ty);
    if (len < 1e-6) {
      leftRaw[i] = NaN;
      rightRaw[i] = NaN;
      continue;
    }
    // left of travel in east/north metres, then into mosaic pixels (y is down)
    const nxM = -ty / len;
    const nyM = tx / len;
    const [cx, cy] = toMosaic(cl[i]);
    const nxPx = nxM / mpp;
    const nyPx = -nyM / mpp;

    for (const [sign, out] of [[1, leftRaw], [-1, rightRaw]] as const) {
      let edge = 0;
      let gap = 0;
      for (let s = 1; s <= nSteps; s++) {
        const d = (sign * s * o.stepM) / o.stepM; // step index, signed
        const px = cx + nxPx * d * o.stepM;
        const py = cy + nyPx * d * o.stepM;
        if (isAsphalt(px, py)) {
          edge = s * o.stepM;
          gap = 0;
        } else if (++gap > o.gapTolerance) {
          break;
        }
      }
      out[i] = edge;
    }
  }

  const leftM = medianFilterWrap(leftRaw, 15);
  const rightM = medianFilterWrap(rightRaw, 15);
  const known = new Array<boolean>(n);
  for (let i = 0; i < n; i++) {
    const w = leftM[i] + rightM[i];
    known[i] =
      !anyMissing &&
      Number.isFinite(w) &&
      w > 3 &&
      w <= o.maxWidthM &&
      leftM[i] < o.halfSearchM - o.stepM &&
      rightM[i] < o.halfSearchM - o.stepM;
  }

  return { stepM: stepAlongM, leftM, rightM, known };
}
```

Add the zoom import at the top of the file — change the `./tiles` import line to:

```ts
import { lngLatToPixel, metresPerPixel, SAT_ZOOM as SAT_ZOOM_REF, type Mosaic } from './tiles';
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `cd dda_lab && npx vitest run tests/unit/simCorridor.test.ts && npm run typecheck`
Expected: PASS (6 tests), typecheck clean. The `no-traces` and missing-tile tests cover Review Focus items 1 and 2.

- [ ] **Step 10: Commit**

```bash
git add dda_lab/src/sim/types.ts dda_lab/src/sim/corridor.ts dda_lab/tests/unit/simCorridor.test.ts
git commit -m "feat(sim): extract track corridor from satellite imagery

Saturation separates asphalt 3.5:1 where brightness gives only ~21 grey
levels. Thresholds calibrate per track from pixels under the loaded GPS
traces. Leaks into pit lane and run-off are rejected by a width ceiling;
missing tiles mark sections unknown rather than zero width.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Corridor cache and staleness

**Files:**
- Create: `dda_lab/src/sim/corridorCache.ts`
- Test: `dda_lab/tests/unit/simCorridorCache.test.ts`

**Interfaces:**
- Consumes: `Corridor` from `src/sim/types.ts`; `TrackModel` from `src/core/types.ts`
- Produces:
  - `export interface CachedCorridor { version: 1; trackId: string; nPoints: number; lengthM: number; firstPoint: LngLat; stepM: number; leftM: number[]; rightM: number[]; known: boolean[] }`
  - `export function serializeCorridor(track: TrackModel, c: Corridor): CachedCorridor`
  - `export function deserializeCorridor(track: TrackModel, raw: unknown): Corridor | null`

- [ ] **Step 1: Write the failing test**

Create `dda_lab/tests/unit/simCorridorCache.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { deserializeCorridor, serializeCorridor } from '../../src/sim/corridorCache';
import type { Corridor } from '../../src/sim/types';
import type { LngLat, TrackModel } from '../../src/core/types';

function mkTrack(centerline: LngLat[], lengthM: number, id = 't1'): TrackModel {
  const cum = new Float64Array(centerline.length);
  for (let i = 1; i < centerline.length; i++) cum[i] = (i * lengthM) / (centerline.length - 1);
  return {
    id, name: 'x', center: centerline[0], centerline, cumDistM: cum, lengthM,
    startFinish: { id: 'sf', name: 'SF', type: 'sf', at: centerline[0], bearingDeg: 0, halfWidthM: 15 },
    sectors: [], turns: [],
  };
}

const CL: LngLat[] = [[23.5, 41.0], [23.501, 41.0], [23.502, 41.0], [23.503, 41.0]];
const corridor: Corridor = {
  stepM: 2,
  leftM: Float32Array.from([5, 5, 6, 6]),
  rightM: Float32Array.from([5, 5, 4, 4]),
  known: [true, true, true, false],
};

describe('corridor cache', () => {
  it('round-trips a corridor', () => {
    const t = mkTrack(CL, 6);
    const back = deserializeCorridor(t, serializeCorridor(t, corridor));
    expect(back).not.toBeNull();
    expect(Array.from(back!.leftM)).toEqual([5, 5, 6, 6]);
    expect(back!.known).toEqual([true, true, true, false]);
  });

  it('rejects a cache whose point count no longer matches', () => {
    const t = mkTrack(CL, 6);
    const raw = serializeCorridor(t, corridor);
    const shorter = mkTrack(CL.slice(0, 3), 4);
    expect(deserializeCorridor(shorter, raw)).toBeNull();
  });

  it('rejects a cache taken before the start line moved', () => {
    // setStartLine -> normalizeTrackOrigin rotates the centerline, so the same
    // vertices now begin at a different point and the offsets no longer line up.
    const t = mkTrack(CL, 6);
    const raw = serializeCorridor(t, corridor);
    const rotated = mkTrack([...CL.slice(2), ...CL.slice(0, 2)], 6);
    expect(deserializeCorridor(rotated, raw)).toBeNull();
  });

  it('rejects malformed input instead of throwing', () => {
    const t = mkTrack(CL, 6);
    expect(deserializeCorridor(t, null)).toBeNull();
    expect(deserializeCorridor(t, { version: 99 })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd dda_lab && npx vitest run tests/unit/simCorridorCache.test.ts`
Expected: FAIL — cannot resolve `../../src/sim/corridorCache`.

- [ ] **Step 3: Implement the cache**

Create `dda_lab/src/sim/corridorCache.ts`:

```ts
// Corridor persistence. A corridor is indexed by centerline vertex, so it is
// only valid for the exact centerline it was built against. setStartLine()
// calls normalizeTrackOrigin(), which ROTATES the centerline — the vertex count
// and length survive but every index shifts, so the first point is fingerprinted
// too and a rotated track invalidates the cache.
import type { LngLat, TrackModel } from '../core/types';
import type { Corridor } from './types';

export interface CachedCorridor {
  version: 1;
  trackId: string;
  nPoints: number;
  lengthM: number;
  firstPoint: LngLat;
  stepM: number;
  leftM: number[];
  rightM: number[];
  known: boolean[];
}

export function serializeCorridor(track: TrackModel, c: Corridor): CachedCorridor {
  return {
    version: 1,
    trackId: track.id,
    nPoints: track.centerline.length,
    lengthM: track.lengthM,
    firstPoint: track.centerline[0],
    stepM: c.stepM,
    leftM: Array.from(c.leftM, (v) => Math.round(v * 100) / 100),
    rightM: Array.from(c.rightM, (v) => Math.round(v * 100) / 100),
    known: c.known,
  };
}

/** How far the first centerline point may move before the cache is stale, metres. */
const ORIGIN_TOLERANCE_DEG = 1e-6; // ~0.1 m

export function deserializeCorridor(track: TrackModel, raw: unknown): Corridor | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Partial<CachedCorridor>;
  if (c.version !== 1) return null;
  if (c.trackId !== track.id) return null;
  if (c.nPoints !== track.centerline.length) return null;
  if (!Array.isArray(c.leftM) || !Array.isArray(c.rightM) || !Array.isArray(c.known)) return null;
  if (c.leftM.length !== track.centerline.length) return null;
  if (c.rightM.length !== track.centerline.length) return null;
  if (c.known.length !== track.centerline.length) return null;
  if (typeof c.lengthM !== 'number' || Math.abs(c.lengthM - track.lengthM) > 1) return null;
  const fp = c.firstPoint;
  if (!Array.isArray(fp) || fp.length !== 2) return null;
  if (
    Math.abs(fp[0] - track.centerline[0][0]) > ORIGIN_TOLERANCE_DEG ||
    Math.abs(fp[1] - track.centerline[0][1]) > ORIGIN_TOLERANCE_DEG
  ) {
    return null;
  }
  return {
    stepM: typeof c.stepM === 'number' ? c.stepM : track.lengthM / Math.max(1, track.centerline.length - 1),
    leftM: Float32Array.from(c.leftM),
    rightM: Float32Array.from(c.rightM),
    known: c.known,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd dda_lab && npx vitest run tests/unit/simCorridorCache.test.ts && npm run typecheck`
Expected: PASS (4 tests). The rotation test covers Review Focus item 5.

- [ ] **Step 5: Commit**

```bash
git add dda_lab/src/sim/corridorCache.ts dda_lab/tests/unit/simCorridorCache.test.ts
git commit -m "feat(sim): corridor cache with centerline fingerprinting

A corridor is indexed by centerline vertex, and setStartLine rotates the
centerline, so the cache fingerprints the point count, length and first
point and invalidates itself on a rotation.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Browser tile loader, store wiring, map layer — corridor visible

**Files:**
- Create: `dda_lab/src/sim/browserTiles.ts`, `dda_lab/src/ui/SimLayers.ts`, `dda_lab/src/ui/panels/SimPanel.tsx`
- Modify: `dda_lab/src/state/store.ts`, `dda_lab/src/ui/panels/BottomPanels.tsx`, `dda_lab/src/ui/MapView.tsx`, `dda_lab/src/core/types.ts`
- Test: `dda_lab/tests/unit/simLayers.test.ts`

**Interfaces:**
- Consumes: `buildMosaic`, `tileRangeFor`, `tileUrl`, `SAT_ZOOM`, `TileLoader` from `src/sim/tiles.ts`; `extractCorridor`, `CorridorError` from `src/sim/corridor.ts`; `serializeCorridor`, `deserializeCorridor` from `src/sim/corridorCache.ts`
- Produces:
  - `export const browserTileLoader: TileLoader` (in `src/sim/browserTiles.ts`)
  - `export function corridorGeoJson(track: TrackModel, c: Corridor): FeatureCollection<LineString, { side: 'left' | 'right' }>` (in `src/ui/SimLayers.ts`)
  - Store: `corridor?: Corridor`, `corridorBusy: boolean`, `extractCorridorNow(): Promise<void>`
  - `src/core/types.ts`: `'sim'` added to `LabState['bottomTab']`'s union — note this union lives in `store.ts`, and `mapLayers` gains `corridor` and `idealLine` keys in `DEFAULT_WORKSPACE`

- [ ] **Step 1: Write the failing test for the GeoJSON builder**

Create `dda_lab/tests/unit/simLayers.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { corridorGeoJson } from '../../src/ui/SimLayers';
import type { Corridor } from '../../src/sim/types';
import type { LngLat, TrackModel } from '../../src/core/types';

const CL: LngLat[] = [[23.5, 41.0], [23.5, 41.0005], [23.5, 41.001], [23.5, 41.0015]];

function mkTrack(): TrackModel {
  const cum = new Float64Array([0, 55, 110, 165]);
  return {
    id: 't', name: 'n', center: CL[0], centerline: CL, cumDistM: cum, lengthM: 165,
    startFinish: { id: 'sf', name: 'SF', type: 'sf', at: CL[0], bearingDeg: 0, halfWidthM: 15 },
    sectors: [], turns: [],
  };
}

describe('corridorGeoJson', () => {
  it('emits one left and one right line, offset to either side of the centerline', () => {
    const c: Corridor = {
      stepM: 55,
      leftM: Float32Array.from([6, 6, 6, 6]),
      rightM: Float32Array.from([6, 6, 6, 6]),
      known: [true, true, true, true],
    };
    const fc = corridorGeoJson(mkTrack(), c);
    expect(fc.features).toHaveLength(2);
    const left = fc.features.find((f) => f.properties.side === 'left')!;
    const right = fc.features.find((f) => f.properties.side === 'right')!;
    // the track runs north, so left is west (smaller lng) and right is east
    expect(left.geometry.coordinates[1][0]).toBeLessThan(23.5);
    expect(right.geometry.coordinates[1][0]).toBeGreaterThan(23.5);
  });

  it('breaks the line where the corridor is unknown rather than drawing through it', () => {
    const c: Corridor = {
      stepM: 55,
      leftM: Float32Array.from([6, 6, 6, 6]),
      rightM: Float32Array.from([6, 6, 6, 6]),
      known: [true, false, true, true],
    };
    const fc = corridorGeoJson(mkTrack(), c);
    const left = fc.features.filter((f) => f.properties.side === 'left');
    expect(left.length).toBeGreaterThan(1); // split into separate segments
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd dda_lab && npx vitest run tests/unit/simLayers.test.ts`
Expected: FAIL — cannot resolve `../../src/ui/SimLayers`.

- [ ] **Step 3: Implement the GeoJSON builder**

Create `dda_lab/src/ui/SimLayers.ts`:

```ts
// Map sources for the simulator: the extracted corridor and the generated line.
import type { Feature, FeatureCollection, LineString } from 'geojson';
import { fromLocalM, toLocalM } from '../core/geo';
import type { LngLat, TrackModel } from '../core/types';
import type { Corridor, Line } from '../sim/types';

export type CorridorProps = { side: 'left' | 'right' };

/** Unit normal pointing left of travel at centerline vertex `i`, in east/north metres. */
function leftNormal(cl: LngLat[], i: number): [number, number] {
  const n = cl.length;
  const a = cl[(i - 1 + n) % n];
  const b = cl[(i + 1) % n];
  const am = toLocalM(cl[i], a);
  const bm = toLocalM(cl[i], b);
  const tx = bm[0] - am[0];
  const ty = bm[1] - am[1];
  const len = Math.hypot(tx, ty);
  return len < 1e-9 ? [0, 0] : [-ty / len, tx / len];
}

/** Offset a centerline vertex sideways by `d` metres (positive = left of travel). */
export function offsetPoint(cl: LngLat[], i: number, d: number): LngLat {
  const [nx, ny] = leftNormal(cl, i);
  return fromLocalM(cl[i], [nx * d, ny * d]);
}

/**
 * The corridor as two edge lines. Runs of unknown sections break the line into
 * separate features, so the map shows a gap where extraction could not decide
 * instead of a straight line through the uncertainty.
 */
export function corridorGeoJson(track: TrackModel, c: Corridor): FeatureCollection<LineString, CorridorProps> {
  const cl = track.centerline;
  const features: Array<Feature<LineString, CorridorProps>> = [];
  for (const side of ['left', 'right'] as const) {
    const dist = side === 'left' ? c.leftM : c.rightM;
    let run: LngLat[] = [];
    const flush = (): void => {
      if (run.length > 1) {
        features.push({ type: 'Feature', properties: { side }, geometry: { type: 'LineString', coordinates: run } });
      }
      run = [];
    };
    for (let i = 0; i < cl.length; i++) {
      if (!c.known[i] || !Number.isFinite(dist[i])) {
        flush();
        continue;
      }
      run.push(offsetPoint(cl, i, side === 'left' ? dist[i] : -dist[i]));
    }
    flush();
  }
  return { type: 'FeatureCollection', features };
}

export type IdealLineProps = { kind: 'idealLine' };

export function idealLineGeoJson(line: Line): FeatureCollection<LineString, IdealLineProps> {
  if (line.points.length < 2) return { type: 'FeatureCollection', features: [] };
  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { kind: 'idealLine' },
      geometry: { type: 'LineString', coordinates: line.points },
    }],
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd dda_lab && npx vitest run tests/unit/simLayers.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Implement the browser tile loader**

Create `dda_lab/src/sim/browserTiles.ts`:

```ts
// The only browser-dependent part of corridor extraction: fetch a tile and read
// its pixels. Esri World Imagery sends `Access-Control-Allow-Origin: *`, so the
// canvas is not tainted and getImageData() works.
import { TILE_SIZE, tileUrl, type TileLoader } from './tiles';

export const browserTileLoader: TileLoader = async (z, x, y) => {
  let blob: Blob;
  try {
    const res = await fetch(tileUrl(z, x, y), { mode: 'cors', credentials: 'omit' });
    if (!res.ok) return null;
    blob = await res.blob();
  } catch {
    return null;
  }
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(blob);
  } catch {
    return null;
  }
  try {
    const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0, TILE_SIZE, TILE_SIZE);
    const { data } = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE); // RGBA
    const rgb = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 3);
    for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
      rgb[j] = data[i];
      rgb[j + 1] = data[i + 1];
      rgb[j + 2] = data[i + 2];
    }
    return rgb;
  } finally {
    bmp.close();
  }
};
```

- [ ] **Step 6: Wire the store**

In `dda_lab/src/state/store.ts`, add `'sim'` to the `bottomTab` union on the `LabState` interface:

```ts
  bottomTab: 'laps' | 'track' | 'channels' | 'math' | 'reports' | 'external' | 'cursor' | 'markers' | 'sim';
```

Add to the `LabState` interface, after `clickPos`:

```ts
  /** Track boundaries extracted from satellite imagery for the active track. */
  corridor?: Corridor;
  /** True while tiles are being fetched. */
  corridorBusy: boolean;
  /** Fetch tiles for the active track and extract its corridor. */
  extractCorridorNow(): Promise<void>;
```

Add these imports at the top of `store.ts`:

```ts
import { browserTileLoader } from '../sim/browserTiles';
import { CorridorError, extractCorridor } from '../sim/corridor';
import { deserializeCorridor, serializeCorridor } from '../sim/corridorCache';
import { buildMosaic, SAT_ZOOM, tileRangeFor } from '../sim/tiles';
import type { Corridor } from '../sim/types';
```

Add to the store body, after `clickPos: null,`:

```ts
  corridor: undefined,
  corridorBusy: false,
```

And the action, after `setStatus`:

```ts
  async extractCorridorNow() {
    const st = get();
    const track = activeTrack(st);
    if (!track) {
      set({ statusMessage: 'Load a session first — the corridor is extracted along its track.' });
      return;
    }
    // a corridor cached for this exact centerline is reused
    const cached = loadCorridorCache(track);
    if (cached) {
      set({ corridor: cached });
      return;
    }
    const trace: LngLat[] = [];
    for (const s of st.sessions) {
      const lng = s.channels.get('gps_lon')?.data;
      const lat = s.channels.get('gps_lat')?.data;
      if (!lng || !lat) continue;
      for (let i = 0; i < lng.length; i += 5) {
        if (Number.isFinite(lng[i]) && Number.isFinite(lat[i]) && (lng[i] !== 0 || lat[i] !== 0)) {
          trace.push([lng[i], lat[i]]);
        }
      }
    }
    set({ corridorBusy: true, statusMessage: 'Fetching satellite tiles…' });
    try {
      const range = tileRangeFor(track.centerline, SAT_ZOOM, 80);
      const mosaic = await buildMosaic(range, browserTileLoader);
      if (mosaic.missing.every(Boolean)) {
        throw new CorridorError('tiles-failed', 'No satellite tiles could be fetched. Check the network connection.');
      }
      const corridor = extractCorridor(track, mosaic, trace);
      saveCorridorCache(track, corridor);
      const pct = Math.round((100 * corridor.known.filter(Boolean).length) / corridor.known.length);
      set({ corridor, statusMessage: `Corridor extracted — ${pct} % of the track resolved.` });
    } catch (e) {
      const msg = e instanceof CorridorError ? e.message : `Corridor extraction failed: ${(e as Error).message}`;
      set({ statusMessage: msg });
    } finally {
      set({ corridorBusy: false });
    }
  },
```

Add the cache helpers near `loadWorkspaceLocal` at the top of `store.ts`:

```ts
/** Corridors are cached per track in this browser; the key carries the track id. */
const CORRIDOR_KEY = 'dda-lab-corridor';

function loadCorridorCache(track: TrackModel): Corridor | undefined {
  try {
    if (typeof localStorage === 'undefined') return undefined;
    const raw = localStorage.getItem(`${CORRIDOR_KEY}:${track.id}`);
    return (raw ? deserializeCorridor(track, JSON.parse(raw)) : null) ?? undefined;
  } catch {
    return undefined;
  }
}

function saveCorridorCache(track: TrackModel, c: Corridor): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(`${CORRIDOR_KEY}:${track.id}`, JSON.stringify(serializeCorridor(track, c)));
  } catch {
    /* quota or storage unavailable: the corridor still works this session */
  }
}
```

In `setStartLine`, after the `set({ tracks, activeTrackId: next.id, sessions, selectedLaps, cursor: null });` line, add `corridor: undefined` to that same `set` call so a rotated centerline drops the in-memory corridor too.

- [ ] **Step 7: Add the map layers**

In `dda_lab/src/core/types.ts`, add the two keys to `DEFAULT_WORKSPACE.mapLayers`:

```ts
    apex: false, turnin: false, brake: false, throttle: false, gates: false, schema: false,
    corridor: false, idealLine: false,
```

In `dda_lab/src/ui/MapView.tsx`:

1. Add `'corridor'` and `'idealLine'` to the source-id list in `addDataLayers` (the `for (const id of [...])` array at line ~1006).
2. Add the layers inside `addDataLayers`, after the `centerline-line` layer:

```ts
  map.addLayer({
    id: 'corridor-line',
    type: 'line',
    source: 'corridor',
    paint: {
      'line-color': ['case', ['==', ['get', 'side'], 'left'], '#ff6a00', '#4dd0e1'],
      'line-width': zoomWidth(1, 2.5),
      'line-opacity': 0.85,
    },
  });
  map.addLayer({
    id: 'ideal-line',
    type: 'line',
    source: 'idealLine',
    paint: { 'line-color': '#c77dff', 'line-width': zoomWidth(2, 4), 'line-opacity': 0.95 },
  });
```

3. Import the builders and the store slice at the top of the component:

```ts
import { corridorGeoJson } from './SimLayers';
```

4. In the "track model + schema" effect (line ~381), add after the `gates` line:

```ts
    setData(map, 'corridor', track && corridor ? corridorGeoJson(track, corridor) : EMPTY);
```

and read `const corridor = useLab((s) => s.corridor);` with the other store selectors, adding `corridor` to that effect's dependency array.

5. In the "layer toggles" effect, add:

```ts
    setVis(map, 'corridor-line', mapLayers.corridor !== false);
    setVis(map, 'ideal-line', mapLayers.idealLine !== false);
```

- [ ] **Step 8: Create the panel skeleton and register the tab**

Create `dda_lab/src/ui/panels/SimPanel.tsx`:

```tsx
import { useLab } from '../../state/store';

export default function SimPanel() {
  const corridor = useLab((s) => s.corridor);
  const busy = useLab((s) => s.corridorBusy);
  const extract = useLab((s) => s.extractCorridorNow);
  const setWorkspace = useLab((s) => s.setWorkspace);
  const workspace = useLab((s) => s.workspace);

  const resolved = corridor
    ? Math.round((100 * corridor.known.filter(Boolean).length) / corridor.known.length)
    : 0;
  const widths = corridor
    ? Array.from(corridor.leftM, (l, i) => l + corridor.rightM[i]).filter((w, i) => corridor.known[i])
        .sort((a, b) => a - b)
    : [];
  const medianWidth = widths.length ? widths[widths.length >> 1] : NaN;

  return (
    <div className="panel" data-testid="sim-panel">
      <div className="panel-row">
        <button data-testid="sim-extract" disabled={busy} onClick={() => void extract()}>
          {busy ? 'Extracting…' : 'Extract corridor'}
        </button>
        <label>
          <input
            type="checkbox"
            checked={workspace.mapLayers.corridor !== false}
            onChange={(e) => setWorkspace({ mapLayers: { ...workspace.mapLayers, corridor: e.target.checked } })}
          />
          Show on map
        </label>
      </div>
      {corridor && (
        <p className="panel-note num" data-testid="sim-corridor-stats">
          {resolved} % resolved · median width {medianWidth.toFixed(1)} m
        </p>
      )}
    </div>
  );
}
```

In `dda_lab/src/ui/panels/BottomPanels.tsx`, add to `TABS` after `markers`:

```ts
  { id: 'sim', label: 'Sim' },
```

and to the body:

```tsx
        {tab === 'sim' && <SimPanel />}
```

with `import SimPanel from './SimPanel';` at the top.

- [ ] **Step 9: Run the full unit suite and the type check**

Run: `cd dda_lab && npm test && npm run typecheck`
Expected: every test passes, typecheck clean.

- [ ] **Step 10: Visual verification — the corridor on Serres**

This is the gate for Group A. The physics in Group B is built on this corridor, so it must be seen to be correct before anything else is written.

```bash
cd dda_lab && npm run dev
```

Then with Playwright (or by hand in the browser):
1. Open `http://localhost:5173/?example=serres_R6_1-19-849`.
2. Open the **Sim** tab, press **Extract corridor**.
3. Wait for the status line, then screenshot the map.

Confirm by eye, against the satellite image:
- Orange (left) and cyan (right) lines sit on the actual asphalt edges all the way round.
- The reported median width is between 11 and 16 m.
- "% resolved" is at least 85.
- Gaps appear near the pit lane and the paved run-off, not in the middle of ordinary corners.

If the edges are visibly off the asphalt, stop and fix the extractor before Task 5 — do not proceed on an unverified corridor.

- [ ] **Step 11: Commit**

```bash
git add dda_lab/src/sim/browserTiles.ts dda_lab/src/ui/SimLayers.ts dda_lab/src/ui/panels/SimPanel.tsx \
        dda_lab/src/state/store.ts dda_lab/src/ui/panels/BottomPanels.tsx dda_lab/src/ui/MapView.tsx \
        dda_lab/src/core/types.ts dda_lab/tests/unit/simLayers.test.ts
git commit -m "feat(sim): extract and draw the track corridor on the map

Sim tab with an Extract corridor button; edges drawn orange (left) and
cyan (right), broken where extraction could not decide. Corridor cached
per track in localStorage and dropped when the start line moves.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

# Group B — Solver, rider and UI

---

### Task 5: Parameters and presets

**Files:**
- Create: `dda_lab/src/sim/presets.ts`
- Modify: `dda_lab/src/sim/types.ts`
- Test: `dda_lab/tests/unit/simPresets.test.ts`

**Interfaces:**
- Produces (in `src/sim/types.ts`):
  - `export interface MachineParams { presetId: string; powerKw: number; massKg: number; cdA: number; wheelbaseM: number; cgHeightM: number; finalDrive: number; gearRatios: number[] }`
  - `export interface TyreTrackParams { mu: number; maxLeanDeg: number; kerbMarginM: number; gripScale: number }`
  - `export interface RiderParams { lineDeviationM: number; brakingG: number; throttleDelayS: number; tcThreshold: number; leanUsage: number; kappa: number }`
  - `export interface SimParams { machine: MachineParams; tyre: TyreTrackParams; rider: RiderParams }`
- Produces (in `src/sim/presets.ts`):
  - `export interface MachinePreset { id: string; label: string; machine: Omit<MachineParams, 'presetId'>; tyre: TyreTrackParams; kappa: number }`
  - `export const MACHINE_PRESETS: MachinePreset[]`
  - `export function presetById(id: string): MachinePreset`
  - `export const DEFAULT_SIM_PARAMS: SimParams`
  - `export function clampParams(p: SimParams): SimParams`

- [ ] **Step 1: Write the failing test**

Create `dda_lab/tests/unit/simPresets.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { clampParams, DEFAULT_SIM_PARAMS, MACHINE_PRESETS, presetById } from '../../src/sim/presets';

describe('presets', () => {
  it('ships the three classes the research covers plus the owner bike and custom', () => {
    const ids = MACHINE_PRESETS.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['250', '600', '1000', 'panigale-v4', 'custom']));
  });

  it('orders power-to-weight and kappa the way the research says', () => {
    const p250 = presetById('250');
    const p600 = presetById('600');
    const p1000 = presetById('1000');
    const pw = (p: typeof p250) => p.machine.powerKw / p.machine.massKg;
    expect(pw(p250)).toBeLessThan(pw(p600));
    expect(pw(p600)).toBeLessThan(pw(p1000));
    // low power -> C line (kappa 0), high power -> V line (kappa 1)
    expect(p250.kappa).toBeLessThan(p600.kappa);
    expect(p600.kappa).toBeLessThan(p1000.kappa);
  });

  it('raises the lean limit with the class, matching the tyre data', () => {
    expect(presetById('250').tyre.maxLeanDeg).toBeLessThan(presetById('1000').tyre.maxLeanDeg);
  });

  it('falls back to custom for an unknown id instead of throwing', () => {
    expect(presetById('nope').id).toBe('custom');
  });
});

describe('clampParams', () => {
  it('holds every divisor above its physical floor', () => {
    const c = clampParams({
      ...DEFAULT_SIM_PARAMS,
      machine: { ...DEFAULT_SIM_PARAMS.machine, powerKw: 0, massKg: 0 },
      tyre: { ...DEFAULT_SIM_PARAMS.tyre, mu: 0, gripScale: 0, maxLeanDeg: 0 },
      rider: { ...DEFAULT_SIM_PARAMS.rider, brakingG: 0 },
    });
    expect(c.machine.powerKw).toBeGreaterThan(0);
    expect(c.machine.massKg).toBeGreaterThan(0);
    expect(c.tyre.mu).toBeGreaterThan(0);
    expect(c.tyre.gripScale).toBeGreaterThan(0);
    expect(c.tyre.maxLeanDeg).toBeGreaterThan(0);
    expect(c.rider.brakingG).toBeGreaterThan(0);
  });

  it('keeps kappa, lean usage and TC threshold inside 0..1', () => {
    const c = clampParams({
      ...DEFAULT_SIM_PARAMS,
      rider: { ...DEFAULT_SIM_PARAMS.rider, kappa: 5, leanUsage: -2, tcThreshold: 9 },
    });
    expect(c.rider.kappa).toBe(1);
    expect(c.rider.leanUsage).toBe(0);
    expect(c.rider.tcThreshold).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd dda_lab && npx vitest run tests/unit/simPresets.test.ts`
Expected: FAIL — cannot resolve `../../src/sim/presets`.

- [ ] **Step 3: Add the parameter types**

Append to `dda_lab/src/sim/types.ts`:

```ts
export interface MachineParams {
  presetId: string;
  powerKw: number;
  /** Bike plus rider and fuel. */
  massKg: number;
  /** Drag area, m^2. */
  cdA: number;
  wheelbaseM: number;
  cgHeightM: number;
  finalDrive: number;
  /** Gearbox ratios, first to top. Used only by the rpm/gear model. */
  gearRatios: number[];
}

export interface TyreTrackParams {
  /** Peak tyre-road friction coefficient. */
  mu: number;
  /** Maximum usable lean angle, degrees. */
  maxLeanDeg: number;
  /** How far past the extracted asphalt edge the line may run, metres. */
  kerbMarginM: number;
  /** One multiplier on mu standing in for surface and temperature. */
  gripScale: number;
}

export interface RiderParams {
  /** RMS lateral wander from the ideal line, metres. */
  lineDeviationM: number;
  /** Peak braking deceleration the rider will use, g. */
  brakingG: number;
  /** Delay between the apex and the throttle coming back, seconds. */
  throttleDelayS: number;
  /** Slip the traction control allows before cutting torque, 0..1. */
  tcThreshold: number;
  /** Fraction of the tyre's lean limit the rider actually uses, 0..1. */
  leanUsage: number;
  /** Line style: 0 = C line (even curvature), 1 = V line (squared off). */
  kappa: number;
}

export interface SimParams {
  machine: MachineParams;
  tyre: TyreTrackParams;
  rider: RiderParams;
}
```

- [ ] **Step 4: Implement the presets**

Create `dda_lab/src/sim/presets.ts`:

```ts
// Machine, tyre and rider presets.
//
// Sources (see the spec for the full argument):
// - Kevin Cameron, "The Two Basic Styles of Motorcycle Cornering", Cycle World:
//   low-powered machines must use the corner-speed style because they cannot
//   recover exit speed; powerful ones square the corner off. So kappa tracks
//   power-to-weight rather than being an independent taste.
// - Cycle World "MotoGP Extreme Lean": with identical tyres a ZX-10R, GSX-R750
//   and R6 reached the SAME lateral g, so mu is shared across the classes and
//   only the lean limit (tyre construction) and the line differ.
// - Brembo MotoGP data (Le Mans, Austria, Aragon): peak deceleration ~1.5 g.
//   Production machinery on road-legal race rubber sits well below that.
// - Lean limits ~50-55 deg (street race tyre) to ~63 deg (MotoGP tyre) are
//   practitioner figures, not measured here: treat them as starting points.
import type { MachineParams, RiderParams, SimParams, TyreTrackParams } from './types';

export interface MachinePreset {
  id: string;
  label: string;
  machine: Omit<MachineParams, 'presetId'>;
  tyre: TyreTrackParams;
  kappa: number;
}

export const MACHINE_PRESETS: MachinePreset[] = [
  {
    id: '250',
    label: '250 cc (Ninja 400 / RC390 class)',
    machine: { powerKw: 33, massKg: 235, cdA: 0.36, wheelbaseM: 1.37, cgHeightM: 0.58, finalDrive: 3.07, gearRatios: [2.92, 2.06, 1.6, 1.33, 1.15, 1.0] },
    tyre: { mu: 1.25, maxLeanDeg: 52, kerbMarginM: 0.3, gripScale: 1 },
    kappa: 0.1,
  },
  {
    id: '600',
    label: '600 cc supersport (R6 / ZX-6R class)',
    machine: { powerKw: 88, massKg: 265, cdA: 0.33, wheelbaseM: 1.38, cgHeightM: 0.56, finalDrive: 2.81, gearRatios: [2.58, 2.0, 1.67, 1.44, 1.29, 1.15] },
    tyre: { mu: 1.3, maxLeanDeg: 56, kerbMarginM: 0.4, gripScale: 1 },
    kappa: 0.45,
  },
  {
    id: '1000',
    label: '1000 cc superbike (R1 / ZX-10R class)',
    machine: { powerKw: 147, massKg: 285, cdA: 0.34, wheelbaseM: 1.41, cgHeightM: 0.55, finalDrive: 2.56, gearRatios: [2.6, 2.0, 1.67, 1.44, 1.29, 1.15] },
    tyre: { mu: 1.33, maxLeanDeg: 58, kerbMarginM: 0.5, gripScale: 1 },
    kappa: 0.85,
  },
  {
    id: 'panigale-v4',
    label: 'Ducati Panigale V4',
    machine: { powerKw: 158, massKg: 290, cdA: 0.34, wheelbaseM: 1.47, cgHeightM: 0.55, finalDrive: 2.5, gearRatios: [2.46, 1.94, 1.64, 1.45, 1.32, 1.21] },
    tyre: { mu: 1.35, maxLeanDeg: 59, kerbMarginM: 0.5, gripScale: 1 },
    kappa: 0.85,
  },
  {
    id: 'custom',
    label: 'Custom',
    machine: { powerKw: 100, massKg: 270, cdA: 0.34, wheelbaseM: 1.4, cgHeightM: 0.56, finalDrive: 2.7, gearRatios: [2.6, 2.0, 1.67, 1.44, 1.29, 1.15] },
    tyre: { mu: 1.3, maxLeanDeg: 56, kerbMarginM: 0.4, gripScale: 1 },
    kappa: 0.5,
  },
];

export function presetById(id: string): MachinePreset {
  return MACHINE_PRESETS.find((p) => p.id === id) ?? MACHINE_PRESETS[MACHINE_PRESETS.length - 1];
}

const DEFAULT_RIDER: RiderParams = {
  lineDeviationM: 0.4,
  brakingG: 1.1,
  throttleDelayS: 0.25,
  tcThreshold: 0.5,
  leanUsage: 0.95,
  kappa: presetById('1000').kappa,
};

export const DEFAULT_SIM_PARAMS: SimParams = {
  machine: { presetId: '1000', ...presetById('1000').machine },
  tyre: { ...presetById('1000').tyre },
  rider: { ...DEFAULT_RIDER },
};

const clamp = (v: number, lo: number, hi: number): number =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;

/**
 * Hold every value inside a physically meaningful range. The sliders can reach
 * their own minima, and a zero mass, zero power or zero mu would put Infinity
 * into the velocity profile and NaN into every channel of the session, which
 * breaks all the charts at once and is hard to attribute. Clamping here means
 * the solver can assume finite, non-zero divisors.
 */
export function clampParams(p: SimParams): SimParams {
  return {
    machine: {
      presetId: p.machine.presetId,
      powerKw: clamp(p.machine.powerKw, 1, 400),
      massKg: clamp(p.machine.massKg, 60, 500),
      cdA: clamp(p.machine.cdA, 0.1, 1.5),
      wheelbaseM: clamp(p.machine.wheelbaseM, 1.0, 2.0),
      cgHeightM: clamp(p.machine.cgHeightM, 0.2, 1.0),
      finalDrive: clamp(p.machine.finalDrive, 1.5, 5),
      gearRatios: p.machine.gearRatios.length ? p.machine.gearRatios : [...presetById('custom').machine.gearRatios],
    },
    tyre: {
      mu: clamp(p.tyre.mu, 0.3, 1.8),
      maxLeanDeg: clamp(p.tyre.maxLeanDeg, 15, 70),
      kerbMarginM: clamp(p.tyre.kerbMarginM, 0, 3),
      gripScale: clamp(p.tyre.gripScale, 0.3, 1.2),
    },
    rider: {
      lineDeviationM: clamp(p.rider.lineDeviationM, 0, 5),
      brakingG: clamp(p.rider.brakingG, 0.2, 1.8),
      throttleDelayS: clamp(p.rider.throttleDelayS, 0, 2),
      tcThreshold: clamp(p.rider.tcThreshold, 0, 1),
      leanUsage: clamp(p.rider.leanUsage, 0, 1),
      kappa: clamp(p.rider.kappa, 0, 1),
    },
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd dda_lab && npx vitest run tests/unit/simPresets.test.ts && npm run typecheck`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add dda_lab/src/sim/presets.ts dda_lab/src/sim/types.ts dda_lab/tests/unit/simPresets.test.ts
git commit -m "feat(sim): machine, tyre and rider presets with clamping

kappa tracks power-to-weight because the racing line is a consequence of
it (Cameron). mu is shared across classes because identical tyres gave
identical lateral g; only the lean limit and the line differ.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: κ-parameterised racing line

**Files:**
- Create: `dda_lab/src/sim/line.ts`
- Test: `dda_lab/tests/unit/simLine.test.ts`

**Interfaces:**
- Consumes: `Corridor`, `Line`, `SimParams` from `src/sim/types.ts`; `TrackModel` from `src/core/types.ts`; `offsetPoint` is reimplemented locally (do **not** import from `src/ui/`, which would pull UI into the solver)
- Produces:
  - `export function buildLine(track: TrackModel, corridor: Corridor | undefined, params: SimParams, fallbackHalfWidthM?: number): Line`
  - `export function curvatureVariance(line: Line): number`

The line is found by minimising, over the lateral offsets `d[i]`, a weighted sum of **squared curvature** (the corner-speed objective) and **squared curvature rate** inverted (the squaring objective). κ interpolates between the two. The minimiser is 60 Gauss-Seidel sweeps over the offsets with the corridor as a hard box constraint — enough to converge on a 2 m grid and still well under a millisecond.

- [ ] **Step 1: Write the failing test**

Create `dda_lab/tests/unit/simLine.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildLine, curvatureVariance } from '../../src/sim/line';
import { DEFAULT_SIM_PARAMS } from '../../src/sim/presets';
import type { Corridor } from '../../src/sim/types';
import type { LngLat, TrackModel } from '../../src/core/types';

/** A circular track of `radiusM`, sampled every ~2 m, with a uniform corridor. */
function circleTrack(radiusM: number, halfWidthM: number): { track: TrackModel; corridor: Corridor } {
  const lat0 = 41.073;
  const lng0 = 23.518;
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const n = Math.max(64, Math.round((2 * Math.PI * radiusM) / 2));
  const centerline: LngLat[] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    centerline.push([lng0 + (radiusM * Math.cos(a)) / mPerDegLng, lat0 + (radiusM * Math.sin(a)) / mPerDegLat]);
  }
  const cum = new Float64Array(n);
  const step = (2 * Math.PI * radiusM) / n;
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + step;
  const track: TrackModel = {
    id: 'c', name: 'circle', center: [lng0, lat0], centerline, cumDistM: cum, lengthM: step * n,
    startFinish: { id: 'sf', name: 'SF', type: 'sf', at: centerline[0], bearingDeg: 0, halfWidthM: 15 },
    sectors: [], turns: [],
  };
  const corridor: Corridor = {
    stepM: step,
    leftM: new Float32Array(n).fill(halfWidthM),
    rightM: new Float32Array(n).fill(halfWidthM),
    known: new Array(n).fill(true),
  };
  return { track, corridor };
}

describe('buildLine', () => {
  it('produces one point per centerline vertex and stays inside the corridor', () => {
    const { track, corridor } = circleTrack(100, 6);
    const line = buildLine(track, corridor, DEFAULT_SIM_PARAMS);
    expect(line.points).toHaveLength(track.centerline.length);
    const margin = DEFAULT_SIM_PARAMS.tyre.kerbMarginM + 1e-6;
    for (let i = 0; i < line.offsetM.length; i++) {
      expect(line.offsetM[i]).toBeLessThanOrEqual(corridor.leftM[i] + margin);
      expect(line.offsetM[i]).toBeGreaterThanOrEqual(-(corridor.rightM[i] + margin));
    }
  });

  it('spreads curvature more evenly at kappa=0 than at kappa=1', () => {
    const { track, corridor } = circleTrack(60, 8);
    const c = buildLine(track, corridor, {
      ...DEFAULT_SIM_PARAMS,
      rider: { ...DEFAULT_SIM_PARAMS.rider, kappa: 0, lineDeviationM: 0 },
    });
    const v = buildLine(track, corridor, {
      ...DEFAULT_SIM_PARAMS,
      rider: { ...DEFAULT_SIM_PARAMS.rider, kappa: 1, lineDeviationM: 0 },
    });
    expect(curvatureVariance(c)).toBeLessThan(curvatureVariance(v));
  });

  it('falls back to a uniform half width when there is no corridor', () => {
    const { track } = circleTrack(100, 6);
    const line = buildLine(track, undefined, DEFAULT_SIM_PARAMS, 5);
    expect(line.points).toHaveLength(track.centerline.length);
    for (let i = 0; i < line.offsetM.length; i++) {
      expect(Math.abs(line.offsetM[i])).toBeLessThanOrEqual(5 + DEFAULT_SIM_PARAMS.tyre.kerbMarginM + 1e-6);
    }
  });

  it('clamps the deviation so a huge lineDeviationM cannot push the line off track', () => {
    const { track, corridor } = circleTrack(100, 6);
    const line = buildLine(track, corridor, {
      ...DEFAULT_SIM_PARAMS,
      rider: { ...DEFAULT_SIM_PARAMS.rider, lineDeviationM: 50 },
    });
    const margin = DEFAULT_SIM_PARAMS.tyre.kerbMarginM + 1e-6;
    for (let i = 0; i < line.offsetM.length; i++) {
      expect(line.offsetM[i]).toBeLessThanOrEqual(corridor.leftM[i] + margin);
      expect(line.offsetM[i]).toBeGreaterThanOrEqual(-(corridor.rightM[i] + margin));
    }
  });

  it('gives a constant-radius circle a curvature close to 1/r', () => {
    const { track, corridor } = circleTrack(100, 0.01); // corridor pinned to the centerline
    const line = buildLine(track, corridor, {
      ...DEFAULT_SIM_PARAMS,
      rider: { ...DEFAULT_SIM_PARAMS.rider, lineDeviationM: 0 },
    });
    const mid = Math.floor(line.curvature.length / 2);
    expect(Math.abs(line.curvature[mid])).toBeCloseTo(1 / 100, 3);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd dda_lab && npx vitest run tests/unit/simLine.test.ts`
Expected: FAIL — cannot resolve `../../src/sim/line`.

- [ ] **Step 3: Implement the line builder**

Create `dda_lab/src/sim/line.ts`:

```ts
// The racing line, parameterised by kappa.
//
// kappa = 0 is the corner-speed ("C") line: minimise squared curvature, which
// spreads the direction change over the longest possible arc.
// kappa = 1 is the point-and-shoot ("V") line: concentrate curvature in a short
// zone and straighten the exit, which is what a powerful bike wants.
//
// Both are the same optimisation with a different penalty: the C objective
// penalises curvature itself, the V objective penalises curvature CHANGE very
// little and curvature a lot only where it is already low, which pushes the
// solution towards "straight, then a sharp bit, then straight".
import { fromLocalM, toLocalM } from '../core/geo';
import type { LngLat, TrackModel } from '../core/types';
import type { Corridor, Line, SimParams } from './types';

/** Gauss-Seidel sweeps. 60 converges on a 2 m grid and stays well under 1 ms. */
const SWEEPS = 60;
/** Relaxation factor; over-relaxation above 1 converges faster but oscillates. */
const OMEGA = 0.6;

function leftNormal(cl: LngLat[], i: number): [number, number] {
  const n = cl.length;
  const a = cl[(i - 1 + n) % n];
  const b = cl[(i + 1) % n];
  const am = toLocalM(cl[i], a);
  const bm = toLocalM(cl[i], b);
  const tx = bm[0] - am[0];
  const ty = bm[1] - am[1];
  const len = Math.hypot(tx, ty);
  return len < 1e-9 ? [0, 0] : [-ty / len, tx / len];
}

/** Deterministic smooth pseudo-noise in [-1,1]: the same params give the same line. */
function wander(i: number, n: number, seed: number): number {
  let s = 0;
  for (let h = 1; h <= 3; h++) {
    s += Math.sin((2 * Math.PI * h * i) / n + seed * h * 1.7) / h;
  }
  return s / 1.833; // normalise 1 + 1/2 + 1/3
}

/**
 * Lateral offsets that minimise the kappa-weighted curvature objective, subject
 * to the corridor as a hard box constraint.
 */
function solveOffsets(
  n: number,
  stepM: number,
  baseCurv: Float32Array,
  loM: Float32Array,
  hiM: Float32Array,
  kappa: number,
): Float32Array {
  const d = new Float32Array(n);
  // Curvature of the offset line, to first order:  k_eff = k0 - d'' .
  // Minimising sum(k_eff^2) is a smoothing of d towards k0 * stepM^2.
  // The V objective trades the curvature penalty for a shortness penalty, which
  // pulls the line towards the inside of the corner and concentrates the turn.
  const wCurv = 1 - 0.85 * kappa;
  const wShort = 0.85 * kappa;
  const h2 = stepM * stepM;
  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    for (let i = 0; i < n; i++) {
      const p = d[(i - 1 + n) % n];
      const q = d[(i + 1) % n];
      // curvature term wants  d[i] = (p + q)/2 + k0*h^2/2
      const curvTarget = (p + q) / 2 + (baseCurv[i] * h2) / 2;
      // shortness term wants the line pulled to the inside of the bend:
      // positive curvature (left turn) -> negative offset is the inside
      const shortTarget = baseCurv[i] >= 0 ? -hiM[i] : loM[i];
      const target = (wCurv * curvTarget + wShort * shortTarget) / (wCurv + wShort);
      const next = d[i] + OMEGA * (target - d[i]);
      d[i] = Math.min(hiM[i], Math.max(loM[i], next));
    }
  }
  return d;
}

/** Signed curvature of a closed polyline in local metres, 1/m, + = left. */
function polylineCurvature(points: LngLat[], stencilM: number): Float32Array {
  const n = points.length;
  const out = new Float32Array(n);
  if (n < 3) return out;
  // estimate spacing from the first few segments
  let span = 0;
  for (let i = 1; i < Math.min(n, 11); i++) {
    const m = toLocalM(points[i - 1], points[i]);
    span += Math.hypot(m[0], m[1]);
  }
  const ds = span / Math.min(n - 1, 10);
  const k = Math.max(1, Math.round(stencilM / Math.max(0.1, ds)));
  for (let i = 0; i < n; i++) {
    const p0 = toLocalM(points[i], points[(i - k + n) % n]);
    const p2 = toLocalM(points[i], points[(i + k) % n]);
    const ax = -p0[0];
    const ay = -p0[1];
    const bx = p2[0];
    const by = p2[1];
    const cross = ax * by - ay * bx;
    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    const lc = Math.hypot(bx - ax, by - ay);
    const denom = la * lb * lc;
    out[i] = denom > 1e-9 ? (2 * cross) / denom : 0;
  }
  return out;
}

export function buildLine(
  track: TrackModel,
  corridor: Corridor | undefined,
  params: SimParams,
  fallbackHalfWidthM = 5,
): Line {
  const cl = track.centerline;
  const n = cl.length;
  const stepM = track.lengthM / Math.max(1, n);
  const margin = params.tyre.kerbMarginM;

  // box constraints: hi = how far left, lo = how far right (negative)
  const hiM = new Float32Array(n);
  const loM = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const useCorridor = corridor && corridor.known[i] && Number.isFinite(corridor.leftM[i]);
    const l = useCorridor ? corridor.leftM[i] : fallbackHalfWidthM;
    const r = useCorridor ? corridor.rightM[i] : fallbackHalfWidthM;
    // leave half a bike's width inside the edge, then allow the kerb margin
    hiM[i] = Math.max(0, l - 0.4) + margin;
    loM[i] = -(Math.max(0, r - 0.4) + margin);
  }

  const baseCurv = polylineCurvature(cl, 10);
  const d = solveOffsets(n, stepM, baseCurv, loM, hiM, params.rider.kappa);

  // rider wander: a deterministic smooth deviation, clamped back into the box
  const dev = params.rider.lineDeviationM;
  if (dev > 0) {
    for (let i = 0; i < n; i++) {
      const w = d[i] + dev * 1.4 * wander(i, n, 1);
      d[i] = Math.min(hiM[i], Math.max(loM[i], w));
    }
  }

  const points: LngLat[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const [nx, ny] = leftNormal(cl, i);
    points[i] = fromLocalM(cl[i], [nx * d[i], ny * d[i]]);
  }

  const cumDistM = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const m = toLocalM(points[i - 1], points[i]);
    cumDistM[i] = cumDistM[i - 1] + Math.hypot(m[0], m[1]);
  }
  const closing = toLocalM(points[n - 1], points[0]);
  const lengthM = cumDistM[n - 1] + Math.hypot(closing[0], closing[1]);

  return { points, curvature: polylineCurvature(points, 10), cumDistM, lengthM, offsetM: d };
}

/** Variance of |curvature| — low means the turn is spread out, high means squared off. */
export function curvatureVariance(line: Line): number {
  const k = line.curvature;
  if (!k.length) return 0;
  let mean = 0;
  for (let i = 0; i < k.length; i++) mean += Math.abs(k[i]);
  mean /= k.length;
  let v = 0;
  for (let i = 0; i < k.length; i++) v += (Math.abs(k[i]) - mean) ** 2;
  return v / k.length;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd dda_lab && npx vitest run tests/unit/simLine.test.ts && npm run typecheck`
Expected: PASS (5 tests). If the κ ordering test fails, adjust `wShort`'s coefficient — the required property is that κ=1 concentrates curvature more than κ=0, not a specific weight.

- [ ] **Step 5: Commit**

```bash
git add dda_lab/src/sim/line.ts dda_lab/tests/unit/simLine.test.ts
git commit -m "feat(sim): kappa-parameterised racing line inside the corridor

kappa=0 minimises squared curvature (corner-speed C line); kappa=1 adds a
shortness penalty that pulls the line to the inside and concentrates the
direction change (point-and-shoot V line). The corridor is a hard box
constraint, so no parameter can push the line off the asphalt.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: QSS three-pass solver

**Files:**
- Create: `dda_lab/src/sim/solver.ts`
- Test: `dda_lab/tests/unit/simSolver.test.ts`

**Interfaces:**
- Consumes: `Line`, `SimParams`, `Envelope` from `src/sim/types.ts`; `clampParams` from `src/sim/presets.ts`
- Produces:
  - `export const G = 9.81`
  - `export function solve(line: Line, params: SimParams): Envelope`
  - `export function topSpeedMs(params: SimParams): number`

- [ ] **Step 1: Write the failing test**

Create `dda_lab/tests/unit/simSolver.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { G, solve, topSpeedMs } from '../../src/sim/solver';
import { clampParams, DEFAULT_SIM_PARAMS } from '../../src/sim/presets';
import type { Line, SimParams } from '../../src/sim/types';
import type { LngLat } from '../../src/core/types';

/** A perfectly circular line of constant radius, as the solver sees it. */
function circleLine(radiusM: number, n = 400): Line {
  const points: LngLat[] = [];
  const lat0 = 41.073;
  const lng0 = 23.518;
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    points.push([lng0 + (radiusM * Math.cos(a)) / mPerDegLng, lat0 + (radiusM * Math.sin(a)) / mPerDegLat]);
  }
  const step = (2 * Math.PI * radiusM) / n;
  const cumDistM = new Float64Array(n);
  for (let i = 1; i < n; i++) cumDistM[i] = cumDistM[i - 1] + step;
  return {
    points,
    curvature: new Float32Array(n).fill(1 / radiusM),
    cumDistM,
    lengthM: step * n,
    offsetM: new Float32Array(n),
  };
}

/** A dead-straight line of `lengthM`. */
function straightLine(lengthM: number, n = 400): Line {
  const points: LngLat[] = [];
  const lat0 = 41.073;
  const lng0 = 23.518;
  const mPerDegLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const cumDistM = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const s = (lengthM * i) / (n - 1);
    cumDistM[i] = s;
    points.push([lng0 + s / mPerDegLng, lat0]);
  }
  return { points, curvature: new Float32Array(n), cumDistM, lengthM, offsetM: new Float32Array(n) };
}

const P: SimParams = clampParams(DEFAULT_SIM_PARAMS);

describe('solve', () => {
  it('matches the analytic lap time of a constant-radius circle', () => {
    const r = 80;
    const line = circleLine(r);
    const env = solve(line, P);
    // grip-limited speed on a circle: v = sqrt(a_lat * r)
    const aLat = Math.min(P.tyre.mu * P.tyre.gripScale, Math.tan((P.tyre.maxLeanDeg * P.rider.leanUsage * Math.PI) / 180)) * G;
    const vExpected = Math.sqrt(aLat * r);
    const tExpected = line.lengthM / vExpected;
    expect(env.lapTimeS).toBeGreaterThan(tExpected * 0.95);
    expect(env.lapTimeS).toBeLessThan(tExpected * 1.05);
  });

  it('clamps a straight to the drag-limited top speed instead of infinity', () => {
    const env = solve(straightLine(3000), P);
    const vMax = Math.max(...Array.from(env.v));
    expect(Number.isFinite(vMax)).toBe(true);
    expect(vMax).toBeLessThanOrEqual(topSpeedMs(P) * 1.01);
    expect(env.v.every((v) => Number.isFinite(v) && v > 0)).toBe(true);
  });

  it('never exceeds the lean limit', () => {
    const env = solve(circleLine(40), P);
    const maxLean = Math.max(...Array.from(env.leanDeg, Math.abs));
    expect(maxLean).toBeLessThanOrEqual(P.tyre.maxLeanDeg * P.rider.leanUsage + 0.5);
  });

  it('gets faster with more braking g and slower with less grip', () => {
    const line = circleLine(60);
    const base = solve(line, P).lapTimeS;
    const harder = solve(line, clampParams({ ...P, rider: { ...P.rider, brakingG: P.rider.brakingG + 0.3 } })).lapTimeS;
    const slippery = solve(line, clampParams({ ...P, tyre: { ...P.tyre, mu: P.tyre.mu - 0.3 } })).lapTimeS;
    expect(harder).toBeLessThanOrEqual(base + 1e-6);
    expect(slippery).toBeGreaterThan(base);
  });

  it('gets faster with more power', () => {
    const line = straightLine(2000);
    const base = solve(line, P).lapTimeS;
    const strong = solve(line, clampParams({ ...P, machine: { ...P.machine, powerKw: P.machine.powerKw * 1.5 } })).lapTimeS;
    expect(strong).toBeLessThan(base);
  });

  it('returns a finite profile with every parameter at its minimum', () => {
    const broken = clampParams({
      machine: { ...P.machine, powerKw: 0, massKg: 0, cdA: 0, cgHeightM: 0, wheelbaseM: 0 },
      tyre: { mu: 0, maxLeanDeg: 0, kerbMarginM: 0, gripScale: 0 },
      rider: { lineDeviationM: 0, brakingG: 0, throttleDelayS: 0, tcThreshold: 0, leanUsage: 0, kappa: 0 },
    });
    const env = solve(circleLine(60), broken);
    expect(Number.isFinite(env.lapTimeS)).toBe(true);
    expect(env.lapTimeS).toBeGreaterThan(0);
    expect(env.v.every((v) => Number.isFinite(v) && v > 0)).toBe(true);
    expect(env.longG.every(Number.isFinite)).toBe(true);
    expect(env.latG.every(Number.isFinite)).toBe(true);
  });

  it('produces a monotonically increasing time vector', () => {
    const env = solve(circleLine(60), P);
    for (let i = 1; i < env.tS.length; i++) expect(env.tS[i]).toBeGreaterThan(env.tS[i - 1]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd dda_lab && npx vitest run tests/unit/simSolver.test.ts`
Expected: FAIL — cannot resolve `../../src/sim/solver`.

- [ ] **Step 3: Implement the solver**

Create `dda_lab/src/sim/solver.ts`:

```ts
// Quasi-steady-state lap solver: three O(n) passes over the line.
//
//   (1) lateral limit   v_lat = sqrt(a_lat_max * r)
//   (2) backward pass   braking into every speed minimum
//   (3) forward pass    acceleration out of it
//   v(s) = min of the three;  t = integral ds / v
//
// Combined grip is the friction ellipse: longitudinal capacity falls as lateral
// use rises, which is what makes trail braking and progressive throttle come out
// of the model rather than being scripted.
import { clampParams } from './presets';
import type { Envelope, Line, SimParams } from './types';

export const G = 9.81;

/** Air density at sea level, kg/m^3. */
const RHO = 1.225;
/** Rolling and driveline losses as an equivalent deceleration, m/s^2. */
const ROLLING = 0.15;
/** Nothing below this is a real speed; keeps every division finite. */
const V_MIN = 2;

/** Drag-limited top speed: where engine power equals drag plus rolling losses. */
export function topSpeedMs(params: SimParams): number {
  const p = clampParams(params);
  const power = p.machine.powerKw * 1000;
  // solve  power = 0.5*rho*cdA*v^3 + m*ROLLING*v  by bisection
  let lo = V_MIN;
  let hi = 200;
  for (let i = 0; i < 60; i++) {
    const v = (lo + hi) / 2;
    const need = 0.5 * RHO * p.machine.cdA * v ** 3 + p.machine.massKg * ROLLING * v;
    if (need > power) hi = v;
    else lo = v;
  }
  return lo;
}

export function solve(line: Line, params: SimParams): Envelope {
  const p = clampParams(params);
  const n = line.points.length;
  const v = new Float32Array(n);
  const longG = new Float32Array(n);
  const latG = new Float32Array(n);
  const leanDeg = new Float32Array(n);
  const tS = new Float64Array(n);
  if (n < 2) return { v, longG, latG, leanDeg, tS, lapTimeS: 0 };

  const mu = p.tyre.mu * p.tyre.gripScale;
  const leanLimitDeg = p.tyre.maxLeanDeg * p.rider.leanUsage;
  // the lean angle and the tyre both cap lateral acceleration; the lower wins
  const aLatMax = Math.max(0.1, Math.min(mu, Math.tan((leanLimitDeg * Math.PI) / 180)) * G);
  const aBrakeMax = Math.max(0.1, p.rider.brakingG * G);
  const vTop = topSpeedMs(p);
  // wheelie limit: beyond this the front lifts and no more torque gets through
  const aWheelie = (G * p.machine.wheelbaseM) / (2 * p.machine.cgHeightM);
  const power = p.machine.powerKw * 1000;

  /** Arc length of the segment ending at i (wrapping at the start line). */
  const dsAt = (i: number): number => {
    const d = i === 0 ? line.lengthM - line.cumDistM[n - 1] : line.cumDistM[i] - line.cumDistM[i - 1];
    return Math.max(0.05, d);
  };

  // ---- pass 1: lateral limit -------------------------------------------
  for (let i = 0; i < n; i++) {
    const k = Math.abs(line.curvature[i]);
    const r = k > 1e-6 ? 1 / k : Infinity;
    const vLat = Number.isFinite(r) ? Math.sqrt(aLatMax * r) : Infinity;
    v[i] = Math.max(V_MIN, Math.min(vTop, vLat));
  }

  /** Fraction of grip still available longitudinally at speed `vv` and curvature `k`. */
  const ellipse = (vv: number, k: number): number => {
    const aLat = vv * vv * Math.abs(k);
    const used = Math.min(1, aLat / aLatMax);
    return Math.sqrt(Math.max(0, 1 - used * used));
  };

  // ---- pass 2: backward (braking) --------------------------------------
  // two laps of the loop so braking carries across the start line
  for (let pass = 0; pass < 2; pass++) {
    for (let step = n - 1; step >= 0; step--) {
      const i = step;
      const j = (i + 1) % n;
      const ds = dsAt(j);
      const a = aBrakeMax * ellipse(v[j], line.curvature[j]);
      const vMax = Math.sqrt(v[j] * v[j] + 2 * a * ds);
      if (v[i] > vMax) v[i] = Math.max(V_MIN, vMax);
    }
  }

  // ---- pass 3: forward (acceleration) ----------------------------------
  for (let pass = 0; pass < 2; pass++) {
    for (let step = 0; step < n; step++) {
      const i = step;
      const j = (i - 1 + n) % n;
      const ds = dsAt(i);
      const vv = Math.max(V_MIN, v[j]);
      const aPower = power / (p.machine.massKg * vv);
      const aGrip = mu * G * ellipse(vv, line.curvature[j]);
      const aDrag = (0.5 * RHO * p.machine.cdA * vv * vv) / p.machine.massKg + ROLLING;
      // traction control shaves drive torque as the grip demand approaches the limit
      const tcFactor = 0.6 + 0.4 * p.rider.tcThreshold;
      const a = Math.min(aPower, aGrip * tcFactor, aWheelie) - aDrag;
      const vMax = Math.sqrt(Math.max(V_MIN * V_MIN, vv * vv + 2 * a * ds));
      if (v[i] > vMax) v[i] = Math.max(V_MIN, vMax);
    }
  }

  // ---- integrate and fill the g channels -------------------------------
  let t = 0;
  for (let i = 0; i < n; i++) {
    tS[i] = t;
    const ds = dsAt((i + 1) % n);
    const vNext = v[(i + 1) % n];
    const vAvg = Math.max(V_MIN, (v[i] + vNext) / 2);
    t += ds / vAvg;
    longG[i] = (vNext * vNext - v[i] * v[i]) / (2 * ds * G);
    const aLat = (v[i] * v[i] * line.curvature[i]) / G;
    latG[i] = aLat;
    leanDeg[i] = (Math.atan(aLat) * 180) / Math.PI;
  }

  return { v, longG, latG, leanDeg, tS, lapTimeS: t };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd dda_lab && npx vitest run tests/unit/simSolver.test.ts && npm run typecheck`
Expected: PASS (7 tests). The straight-line test covers Review Focus item 3; the all-minimum test covers item 4.

- [ ] **Step 5: Commit**

```bash
git add dda_lab/src/sim/solver.ts dda_lab/tests/unit/simSolver.test.ts
git commit -m "feat(sim): quasi-steady-state three-pass lap solver

Lateral limit, backward braking pass and forward acceleration pass,
coupled by the friction ellipse so trail braking and progressive throttle
fall out of the model. Straights clamp to the drag-limited top speed
rather than going infinite.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Rider lag layer and gear/rpm model

**Files:**
- Create: `dda_lab/src/sim/rider.ts`
- Test: `dda_lab/tests/unit/simRider.test.ts`

**Interfaces:**
- Consumes: `Envelope`, `Line`, `SimParams` from `src/sim/types.ts`; `topSpeedMs` from `src/sim/solver.ts`
- Produces:
  - `export interface RiderChannels { tps: Float32Array; gear: Float32Array; rpm: Float32Array; dtc: Float32Array }`
  - `export function riderChannels(line: Line, env: Envelope, params: SimParams): RiderChannels`

- [ ] **Step 1: Write the failing test**

Create `dda_lab/tests/unit/simRider.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { riderChannels } from '../../src/sim/rider';
import { solve } from '../../src/sim/solver';
import { clampParams, DEFAULT_SIM_PARAMS } from '../../src/sim/presets';
import type { Line } from '../../src/sim/types';
import type { LngLat } from '../../src/core/types';

/** Straight, then a 50 m radius corner, then straight again. */
function cornerLine(n = 600): Line {
  const lat0 = 41.073;
  const lng0 = 23.518;
  const mPerDegLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const curvature = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const f = i / n;
    curvature[i] = f > 0.4 && f < 0.6 ? 1 / 50 : 0;
  }
  const stepM = 2;
  const cumDistM = new Float64Array(n);
  const points: LngLat[] = [];
  for (let i = 0; i < n; i++) {
    cumDistM[i] = i * stepM;
    points.push([lng0 + (i * stepM) / mPerDegLng, lat0]);
  }
  return { points, curvature, cumDistM, lengthM: n * stepM, offsetM: new Float32Array(n) };
}

const P = clampParams(DEFAULT_SIM_PARAMS);

describe('riderChannels', () => {
  it('produces channels of the same length as the line', () => {
    const line = cornerLine();
    const ch = riderChannels(line, solve(line, P), P);
    expect(ch.tps).toHaveLength(line.points.length);
    expect(ch.gear).toHaveLength(line.points.length);
    expect(ch.rpm).toHaveLength(line.points.length);
    expect(ch.dtc).toHaveLength(line.points.length);
  });

  it('keeps throttle in 0..100 and gear in 1..top', () => {
    const line = cornerLine();
    const ch = riderChannels(line, solve(line, P), P);
    for (let i = 0; i < ch.tps.length; i++) {
      expect(ch.tps[i]).toBeGreaterThanOrEqual(0);
      expect(ch.tps[i]).toBeLessThanOrEqual(100);
      expect(ch.gear[i]).toBeGreaterThanOrEqual(1);
      expect(ch.gear[i]).toBeLessThanOrEqual(P.machine.gearRatios.length);
      expect(Number.isInteger(ch.gear[i])).toBe(true);
    }
  });

  it('shuts the throttle under braking and opens it on the way out', () => {
    const line = cornerLine();
    const env = solve(line, P);
    const ch = riderChannels(line, env, P);
    // the slowest point is the apex; find it
    let apex = 0;
    for (let i = 1; i < env.v.length; i++) if (env.v[i] < env.v[apex]) apex = i;
    const beforeApex = ch.tps[Math.max(0, apex - 30)];
    const afterApex = ch.tps[Math.min(ch.tps.length - 1, apex + 80)];
    expect(beforeApex).toBeLessThan(40);
    expect(afterApex).toBeGreaterThan(beforeApex);
  });

  it('delays the throttle more when throttleDelayS is larger', () => {
    const line = cornerLine();
    const env = solve(line, P);
    const quick = riderChannels(line, env, clampParams({ ...P, rider: { ...P.rider, throttleDelayS: 0 } }));
    const slow = riderChannels(line, env, clampParams({ ...P, rider: { ...P.rider, throttleDelayS: 1.5 } }));
    let apex = 0;
    for (let i = 1; i < env.v.length; i++) if (env.v[i] < env.v[apex]) apex = i;
    const at = Math.min(env.v.length - 1, apex + 20);
    expect(slow.tps[at]).toBeLessThan(quick.tps[at]);
  });

  it('reports TC intervention only where the drive demand is high', () => {
    const line = cornerLine();
    const ch = riderChannels(line, solve(line, P), P);
    expect(ch.dtc.every((d) => d >= 0 && d <= 100)).toBe(true);
    // no intervention while hard on the brakes at the start of the braking zone
    expect(Math.max(...Array.from(ch.dtc.slice(0, 50)))).toBe(0);
  });

  it('rises through the gears as speed rises', () => {
    const line = cornerLine();
    const env = solve(line, P);
    const ch = riderChannels(line, env, P);
    let fastest = 0;
    let slowest = 0;
    for (let i = 1; i < env.v.length; i++) {
      if (env.v[i] > env.v[fastest]) fastest = i;
      if (env.v[i] < env.v[slowest]) slowest = i;
    }
    expect(ch.gear[fastest]).toBeGreaterThanOrEqual(ch.gear[slowest]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd dda_lab && npx vitest run tests/unit/simRider.test.ts`
Expected: FAIL — cannot resolve `../../src/sim/rider`.

- [ ] **Step 3: Implement the lag layer**

Create `dda_lab/src/sim/rider.ts`:

```ts
// The rider lag layer: what the quasi-steady-state envelope cannot say.
//
// The solver gives the speed a perfect actuator would hold. Real telemetry has
// a throttle trace that lags the apex, a brake release that ramps, a traction
// control that cuts torque, and a gearbox. Those are what the chart stack is
// for, so they are modelled here as first-order lags on top of the envelope
// rather than being solved for.
import type { Envelope, Line, SimParams } from './types';
import { clampParams, } from './presets';

export interface RiderChannels {
  /** Throttle position, %. */
  tps: Float32Array;
  /** Selected gear, 1..n. */
  gear: Float32Array;
  rpm: Float32Array;
  /** Traction-control intervention, % of torque cut. */
  dtc: Float32Array;
}

/** Rolling radius of a 190/55-17 rear, metres. */
const WHEEL_RADIUS_M = 0.31;
const RPM_LIMIT = 14000;
const RPM_MIN = 3500;

export function riderChannels(line: Line, env: Envelope, params: SimParams): RiderChannels {
  const p = clampParams(params);
  const n = line.points.length;
  const tps = new Float32Array(n);
  const gear = new Float32Array(n);
  const rpm = new Float32Array(n);
  const dtc = new Float32Array(n);
  if (!n) return { tps, gear, rpm, dtc };

  // ---- raw demand from the envelope ------------------------------------
  // longG > 0 means driving, < 0 braking. Map drive demand to throttle and
  // braking to a closed throttle; coasting sits in between.
  const demand = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const g = env.longG[i];
    demand[i] = g > 0 ? Math.min(100, (g / 0.9) * 100) : Math.max(0, 12 + g * 30);
  }

  // ---- first-order lag on the throttle ---------------------------------
  // The delay is in seconds, so it is applied against the envelope's own time
  // vector: the same delay costs more samples where the bike is slow.
  const tau = Math.max(1e-3, p.rider.throttleDelayS);
  let y = demand[0];
  for (let i = 0; i < n; i++) {
    const dt = i === 0 ? 0.01 : Math.max(1e-3, env.tS[i] - env.tS[i - 1]);
    const alpha = 1 - Math.exp(-dt / tau);
    // opening the throttle lags; shutting it is immediate (riders close fast)
    y = demand[i] < y ? demand[i] : y + alpha * (demand[i] - y);
    tps[i] = Math.min(100, Math.max(0, y));
  }

  // ---- gear and rpm -----------------------------------------------------
  const ratios = p.machine.gearRatios;
  const top = ratios.length;
  // speed at the rev limit in each gear
  const vAtLimit = ratios.map(
    (r) => (RPM_LIMIT * 2 * Math.PI * WHEEL_RADIUS_M) / (60 * r * p.machine.finalDrive),
  );
  for (let i = 0; i < n; i++) {
    let g = 1;
    while (g < top && env.v[i] > vAtLimit[g - 1]) g++;
    gear[i] = g;
    const rev = (env.v[i] * 60 * ratios[g - 1] * p.machine.finalDrive) / (2 * Math.PI * WHEEL_RADIUS_M);
    rpm[i] = Math.min(RPM_LIMIT, Math.max(RPM_MIN, rev));
  }

  // ---- traction control -------------------------------------------------
  // TC cuts when the drive demand plus the lateral demand would exceed what the
  // threshold allows. A low threshold means an intrusive system.
  const allowed = 0.55 + 0.45 * p.rider.tcThreshold;
  const aLatMax = Math.max(
    0.1,
    Math.min(p.tyre.mu * p.tyre.gripScale, Math.tan((p.tyre.maxLeanDeg * p.rider.leanUsage * Math.PI) / 180)),
  );
  for (let i = 0; i < n; i++) {
    if (env.longG[i] <= 0) continue; // braking or coasting: nothing to cut
    const latUse = Math.min(1, Math.abs(env.latG[i]) / aLatMax);
    const longUse = Math.min(1, env.longG[i] / (p.tyre.mu * p.tyre.gripScale));
    const total = Math.hypot(latUse, longUse);
    if (total > allowed) dtc[i] = Math.min(100, ((total - allowed) / Math.max(0.05, 1 - allowed)) * 100);
  }

  return { tps, gear, rpm, dtc };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd dda_lab && npx vitest run tests/unit/simRider.test.ts && npm run typecheck`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add dda_lab/src/sim/rider.ts dda_lab/tests/unit/simRider.test.ts
git commit -m "feat(sim): rider lag layer with throttle delay, TC and gear model

The QSS envelope has no tps, gear, rpm or dtc, and those are what the
chart stack is for. First-order lag on the throttle against the envelope's
own time vector, so the same delay costs more samples where the bike is
slow.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Synthetic Session and the simulate() seam

**Files:**
- Create: `dda_lab/src/sim/toSession.ts`, `dda_lab/src/sim/index.ts`
- Modify: `dda_lab/src/core/types.ts`
- Test: `dda_lab/tests/unit/simToSession.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 5-8; `makeTimeBase` from `src/core/resample.ts`; `Session`, `Channel`, `Lap`, `DEFAULT_PROC` from `src/core/types.ts`
- Produces:
  - `export function toSession(line: Line, env: Envelope, ch: RiderChannels, params: SimParams, id: string, name: string, color: string): Session`
  - `export function simulate(track: TrackModel, corridor: Corridor | undefined, params: SimParams, id: string, name: string, color: string): { session: Session; line: Line; lapTimeS: number }` (in `src/sim/index.ts`)
  - `src/core/types.ts`: `Session.source` union gains `'sim'`, and a new optional `isSim?: boolean`

- [ ] **Step 1: Write the failing test**

Create `dda_lab/tests/unit/simToSession.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { simulate } from '../../src/sim';
import { clampParams, DEFAULT_SIM_PARAMS } from '../../src/sim/presets';
import type { Corridor } from '../../src/sim/types';
import type { LngLat, TrackModel } from '../../src/core/types';

function circleTrack(radiusM: number): { track: TrackModel; corridor: Corridor } {
  const lat0 = 41.073;
  const lng0 = 23.518;
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const n = Math.round((2 * Math.PI * radiusM) / 2);
  const centerline: LngLat[] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    centerline.push([lng0 + (radiusM * Math.cos(a)) / mPerDegLng, lat0 + (radiusM * Math.sin(a)) / mPerDegLat]);
  }
  const step = (2 * Math.PI * radiusM) / n;
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + step;
  return {
    track: {
      id: 'c', name: 'circle', center: [lng0, lat0], centerline, cumDistM: cum, lengthM: step * n,
      startFinish: { id: 'sf', name: 'SF', type: 'sf', at: centerline[0], bearingDeg: 0, halfWidthM: 15 },
      sectors: [], turns: [],
    },
    corridor: {
      stepM: step,
      leftM: new Float32Array(n).fill(6),
      rightM: new Float32Array(n).fill(6),
      known: new Array(n).fill(true),
    },
  };
}

const P = clampParams(DEFAULT_SIM_PARAMS);

describe('simulate', () => {
  it('returns a Session with the channels the charts and map need', () => {
    const { track, corridor } = circleTrack(300);
    const { session } = simulate(track, corridor, P, 'sim1', 'Virtual', '#c77dff');
    for (const name of ['speed', 'gps_lon', 'gps_lat', 'long_g', 'lean', 'tps', 'gear', 'rpm', 'dtc']) {
      expect(session.channels.has(name), `missing channel ${name}`).toBe(true);
    }
    expect(session.source).toBe('sim');
    expect(session.isSim).toBe(true);
  });

  it('puts every channel on the same 10 Hz time base', () => {
    const { track, corridor } = circleTrack(300);
    const { session } = simulate(track, corridor, P, 'sim1', 'Virtual', '#c77dff');
    expect(session.t[1] - session.t[0]).toBeCloseTo(0.1, 6);
    for (const ch of session.channels.values()) expect(ch.data).toHaveLength(session.t.length);
  });

  it('carries exactly one flying lap whose time matches the solver', () => {
    const { track, corridor } = circleTrack(300);
    const { session, lapTimeS } = simulate(track, corridor, P, 'sim1', 'Virtual', '#c77dff');
    expect(session.laps).toHaveLength(1);
    expect(session.laps[0].kind).toBe('flying');
    expect(session.laps[0].isBest).toBe(true);
    expect(session.laps[0].timeS).toBeCloseTo(lapTimeS, 1);
    expect(session.lapsFromFile).toBe(true);
  });

  it('emits no NaN in any channel', () => {
    const { track, corridor } = circleTrack(300);
    const { session } = simulate(track, corridor, P, 'sim1', 'Virtual', '#c77dff');
    for (const [name, ch] of session.channels) {
      for (let i = 0; i < ch.data.length; i++) {
        expect(Number.isFinite(ch.data[i]), `${name}[${i}] is not finite`).toBe(true);
      }
    }
  });

  it('speeds up when the rider brakes harder', () => {
    const { track, corridor } = circleTrack(120);
    const slow = simulate(track, corridor, clampParams({ ...P, rider: { ...P.rider, brakingG: 0.6 } }), 'a', 'A', '#fff');
    const fast = simulate(track, corridor, clampParams({ ...P, rider: { ...P.rider, brakingG: 1.4 } }), 'b', 'B', '#fff');
    expect(fast.lapTimeS).toBeLessThanOrEqual(slow.lapTimeS);
  });

  it('runs without a corridor, using the fallback half width', () => {
    const { track } = circleTrack(300);
    const { session, lapTimeS } = simulate(track, undefined, P, 'sim1', 'Virtual', '#c77dff');
    expect(lapTimeS).toBeGreaterThan(0);
    expect(session.channels.get('speed')!.data.length).toBe(session.t.length);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd dda_lab && npx vitest run tests/unit/simToSession.test.ts`
Expected: FAIL — cannot resolve `../../src/sim`.

- [ ] **Step 3: Extend the Session type**

In `dda_lab/src/core/types.ts`, change the `Session.source` line:

```ts
  source: 'dda' | 'json' | 'csv' | 'sim';
```

and add after `isExample`:

```ts
  /** Produced by the virtual rider, not by a file; marker persistence skips it. */
  isSim?: boolean;
```

- [ ] **Step 4: Implement the session builder**

Create `dda_lab/src/sim/toSession.ts`:

```ts
// Package the simulation as an ordinary Session.
//
// This is the whole point of the design: a Session goes through
// refreshSession() like any loaded file, so the map trace, the heat maps, the
// chart stack, the cursor, the lap table and delta_t all work with no new
// visualisation code. Everything here exists to satisfy that contract.
import { makeTimeBase } from '../core/resample';
import { DEFAULT_PROC, type Channel, type Lap, type Session } from '../core/types';
import type { RiderChannels } from './rider';
import type { Envelope, Line, SimParams } from './types';

/** Linear interpolation of `src` (indexed by line sample) onto the 10 Hz grid. */
function onTimeGrid(src: ArrayLike<number>, srcT: Float64Array, t: Float64Array): Float32Array {
  const out = new Float32Array(t.length);
  const n = srcT.length;
  let j = 0;
  for (let i = 0; i < t.length; i++) {
    const tt = t[i];
    while (j < n - 2 && srcT[j + 1] < tt) j++;
    const t0 = srcT[j];
    const t1 = srcT[Math.min(n - 1, j + 1)];
    const f = t1 > t0 ? (tt - t0) / (t1 - t0) : 0;
    const v0 = src[j];
    const v1 = src[Math.min(n - 1, j + 1)];
    out[i] = v0 + Math.min(1, Math.max(0, f)) * (v1 - v0);
  }
  return out;
}

/** Nearest-sample lookup, for channels that must not be interpolated (gear). */
function onTimeGridStep(src: ArrayLike<number>, srcT: Float64Array, t: Float64Array): Float32Array {
  const out = new Float32Array(t.length);
  const n = srcT.length;
  let j = 0;
  for (let i = 0; i < t.length; i++) {
    while (j < n - 2 && srcT[j + 1] <= t[i]) j++;
    out[i] = src[j];
  }
  return out;
}

function channel(name: string, unit: string, data: Float32Array, color?: string): Channel {
  return { name, unit, kind: 'raw', data, proc: { ...DEFAULT_PROC }, color, note: 'simulated' };
}

export function toSession(
  line: Line,
  env: Envelope,
  ch: RiderChannels,
  params: SimParams,
  id: string,
  name: string,
  color: string,
): Session {
  const t = makeTimeBase(env.lapTimeS, 10);
  const srcT = env.tS;

  const lon = Float64Array.from(line.points, (p) => p[0]);
  const lat = Float64Array.from(line.points, (p) => p[1]);

  const channels = new Map<string, Channel>();
  channels.set('speed', channel('speed', 'km/h', onTimeGrid(Float32Array.from(env.v, (v) => v * 3.6), srcT, t)));
  channels.set('gps_lon', channel('gps_lon', 'deg', onTimeGrid(lon, srcT, t)));
  channels.set('gps_lat', channel('gps_lat', 'deg', onTimeGrid(lat, srcT, t)));
  channels.set('long_g', channel('long_g', 'g', onTimeGrid(env.longG, srcT, t)));
  channels.set('lat_g', channel('lat_g', 'g', onTimeGrid(env.latG, srcT, t)));
  channels.set('lean', channel('lean', 'deg', onTimeGrid(env.leanDeg, srcT, t)));
  channels.set('tps', channel('tps', '%', onTimeGrid(ch.tps, srcT, t)));
  channels.set('rpm', channel('rpm', 'rpm', onTimeGrid(ch.rpm, srcT, t)));
  channels.set('dtc', channel('dtc', '%', onTimeGrid(ch.dtc, srcT, t)));
  channels.set('gear', channel('gear', '', onTimeGridStep(ch.gear, srcT, t)));
  channels.set(
    'lap_dist',
    channel('lap_dist', 'm', onTimeGrid(Float64Array.from(line.cumDistM), srcT, t)),
  );

  const lap: Lap = {
    n: 1,
    startIdx: 0,
    endIdx: t.length - 1,
    timeS: env.lapTimeS,
    sectorsS: [],
    isBest: true,
    kind: 'flying',
  };

  return {
    id,
    name,
    source: 'sim',
    color,
    t,
    channels,
    laps: [lap],
    meta: {
      track: '',
      rider: 'Virtual rider',
      note: `${params.machine.presetId} · κ ${params.rider.kappa.toFixed(2)} · brake ${params.rider.brakingG.toFixed(2)} g`,
    },
    // the lap comes from the simulation, not from gates: keep it when the start line moves
    lapsFromFile: true,
    isSim: true,
  };
}
```

Create `dda_lab/src/sim/index.ts`:

```ts
// The virtual rider's single entry point.
//
// EXTENSION SEAM: solve() and riderChannels() sit behind this call. A
// time-domain dynamic solver (load transfer, tyre slip, preview controller) can
// replace both without touching the line generator, the corridor extractor,
// toSession, the store or the UI.
import type { TrackModel } from '../core/types';
import { buildLine } from './line';
import { clampParams } from './presets';
import { riderChannels } from './rider';
import { solve } from './solver';
import { toSession } from './toSession';
import type { Corridor, Line, SimParams } from './types';
import type { Session } from '../core/types';

export interface SimResult {
  session: Session;
  line: Line;
  lapTimeS: number;
}

export function simulate(
  track: TrackModel,
  corridor: Corridor | undefined,
  params: SimParams,
  id: string,
  name: string,
  color: string,
): SimResult {
  const p = clampParams(params);
  const line = buildLine(track, corridor, p);
  const env = solve(line, p);
  const ch = riderChannels(line, env, p);
  return { session: toSession(line, env, ch, p, id, name, color), line, lapTimeS: env.lapTimeS };
}

export { buildLine } from './line';
export { solve, topSpeedMs } from './solver';
export { riderChannels } from './rider';
export * from './types';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd dda_lab && npx vitest run tests/unit/simToSession.test.ts && npm test && npm run typecheck`
Expected: PASS — the new file's 6 tests, and the whole suite still green.

- [ ] **Step 6: Commit**

```bash
git add dda_lab/src/sim/toSession.ts dda_lab/src/sim/index.ts dda_lab/src/core/types.ts dda_lab/tests/unit/simToSession.test.ts
git commit -m "feat(sim): package the simulation as an ordinary Session

simulate() is the extension seam: the solver and the rider layer sit
behind one call, so a time-domain solver can replace them later without
touching the line generator, the corridor, the store or the UI.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Sim panel, live sliders and visual verification

**Files:**
- Modify: `dda_lab/src/state/store.ts`, `dda_lab/src/ui/panels/SimPanel.tsx`, `dda_lab/src/ui/MapView.tsx`, `dda_lab/src/ui/panels/panels.css`
- Test: `dda_lab/tests/unit/simStore.test.ts`, `dda_lab/tests/e2e/sim.spec.ts`

**Interfaces:**
- Consumes: `simulate`, `SimParams`, `Line` from `src/sim`; `DEFAULT_SIM_PARAMS`, `MACHINE_PRESETS`, `presetById` from `src/sim/presets`; `idealLineGeoJson` from `src/ui/SimLayers`
- Produces:
  - Store: `simParams: SimParams`, `simLine?: Line`, `simLapTimeS?: number`, `simEnabled: boolean`, `setSimParams(patch: DeepPartial<SimParams>): void`, `setSimEnabled(on: boolean): void`, `applyMachinePreset(id: string): void`

- [ ] **Step 1: Write the failing store test**

Create `dda_lab/tests/unit/simStore.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { useLab } from '../../src/state/store';
import { DEFAULT_SIM_PARAMS } from '../../src/sim/presets';
import type { LngLat, TrackModel } from '../../src/core/types';

function circleTrack(radiusM = 300): TrackModel {
  const lat0 = 41.073;
  const lng0 = 23.518;
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const n = Math.round((2 * Math.PI * radiusM) / 2);
  const centerline: LngLat[] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    centerline.push([lng0 + (radiusM * Math.cos(a)) / mPerDegLng, lat0 + (radiusM * Math.sin(a)) / mPerDegLat]);
  }
  const step = (2 * Math.PI * radiusM) / n;
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + step;
  return {
    id: 'c', name: 'circle', center: [lng0, lat0], centerline, cumDistM: cum, lengthM: step * n,
    startFinish: { id: 'sf', name: 'SF', type: 'sf', at: centerline[0], bearingDeg: 0, halfWidthM: 15 },
    sectors: [], turns: [],
  };
}

describe('sim store', () => {
  beforeEach(() => {
    useLab.setState({
      sessions: [], tracks: [], activeTrackId: undefined, selectedLaps: [],
      simEnabled: false, simParams: DEFAULT_SIM_PARAMS, simLine: undefined, simLapTimeS: undefined,
      corridor: undefined,
    });
  });

  it('adds a sim session when the simulator is enabled', () => {
    useLab.getState().setTrack(circleTrack());
    useLab.getState().setSimEnabled(true);
    const st = useLab.getState();
    expect(st.sessions.some((s) => s.isSim)).toBe(true);
    expect(st.simLapTimeS).toBeGreaterThan(0);
  });

  it('removes the sim session again when disabled', () => {
    useLab.getState().setTrack(circleTrack());
    useLab.getState().setSimEnabled(true);
    useLab.getState().setSimEnabled(false);
    expect(useLab.getState().sessions.some((s) => s.isSim)).toBe(false);
  });

  it('re-simulates in place on a parameter change, keeping exactly one sim session', () => {
    useLab.getState().setTrack(circleTrack());
    useLab.getState().setSimEnabled(true);
    const before = useLab.getState().simLapTimeS!;
    useLab.getState().setSimParams({ rider: { brakingG: 1.6 } });
    const after = useLab.getState().simLapTimeS!;
    expect(useLab.getState().sessions.filter((s) => s.isSim)).toHaveLength(1);
    expect(after).not.toBe(before);
  });

  it('a machine preset fills machine, tyre and kappa together', () => {
    useLab.getState().applyMachinePreset('250');
    const p = useLab.getState().simParams;
    expect(p.machine.presetId).toBe('250');
    expect(p.machine.powerKw).toBe(33);
    expect(p.tyre.maxLeanDeg).toBe(52);
    expect(p.rider.kappa).toBeCloseTo(0.1, 6);
  });

  it('does nothing when enabled with no track loaded', () => {
    useLab.getState().setSimEnabled(true);
    expect(useLab.getState().sessions).toHaveLength(0);
    expect(useLab.getState().statusMessage).toMatch(/track/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd dda_lab && npx vitest run tests/unit/simStore.test.ts`
Expected: FAIL — `setSimEnabled is not a function`.

- [ ] **Step 3: Wire the simulator into the store**

In `dda_lab/src/state/store.ts`, add to the imports:

```ts
import { simulate } from '../sim';
import { DEFAULT_SIM_PARAMS, presetById } from '../sim/presets';
import type { Line, SimParams } from '../sim/types';
```

Add to the `LabState` interface, next to `corridor`:

```ts
  /** Virtual rider parameters. */
  simParams: SimParams;
  /** True while a simulated lap is in the workspace. */
  simEnabled: boolean;
  /** The generated line, for the map layer. */
  simLine?: Line;
  simLapTimeS?: number;
  setSimEnabled(on: boolean): void;
  /** Patch any subset of the three parameter groups and re-simulate. */
  setSimParams(patch: { machine?: Partial<SimParams['machine']>; tyre?: Partial<SimParams['tyre']>; rider?: Partial<SimParams['rider']> }): void;
  /** Load a machine preset: machine, tyre and the kappa default together. */
  applyMachinePreset(id: string): void;
```

Add to the store body next to `corridor: undefined`:

```ts
  simParams: DEFAULT_SIM_PARAMS,
  simEnabled: false,
  simLine: undefined,
  simLapTimeS: undefined,
```

Add a module-level helper above `useLab`:

```ts
export const SIM_SESSION_ID = 'sim';
const SIM_COLOR = '#c77dff';
```

Add the actions after `extractCorridorNow`:

```ts
  setSimEnabled(on) {
    if (!on) {
      set((st) => ({
        simEnabled: false,
        simLine: undefined,
        simLapTimeS: undefined,
        sessions: st.sessions.filter((s) => s.id !== SIM_SESSION_ID),
        selectedLaps: st.selectedLaps.filter((l) => l.sessionId !== SIM_SESSION_ID),
        refLap: st.refLap?.sessionId === SIM_SESSION_ID ? undefined : st.refLap,
        cursor: st.cursor?.sessionId === SIM_SESSION_ID ? null : st.cursor,
      }));
      return;
    }
    set({ simEnabled: true });
    runSim(set, get);
  },
  setSimParams(patch) {
    set((st) => ({
      simParams: {
        machine: { ...st.simParams.machine, ...patch.machine },
        tyre: { ...st.simParams.tyre, ...patch.tyre },
        rider: { ...st.simParams.rider, ...patch.rider },
      },
    }));
    if (get().simEnabled) runSim(set, get);
  },
  applyMachinePreset(id) {
    const preset = presetById(id);
    set((st) => ({
      simParams: {
        machine: { presetId: preset.id, ...preset.machine },
        tyre: { ...preset.tyre },
        rider: { ...st.simParams.rider, kappa: preset.kappa },
      },
    }));
    if (get().simEnabled) runSim(set, get);
  },
```

Add the runner below the store definition (it needs `refreshAll`, which is already in the module):

```ts
/**
 * Run the simulator and put its session in the workspace, replacing any previous
 * one. The sim session is an ordinary Session, so it goes through refreshAll()
 * and picks up derived channels, math channels and delta_t like a loaded file.
 */
function runSim(
  set: (partial: Partial<LabState>) => void,
  get: () => LabState,
): void {
  const st = get();
  const track = activeTrack(st);
  if (!track) {
    set({ statusMessage: 'The simulator needs a track — open a session first.' });
    return;
  }
  const { session, line, lapTimeS } = simulate(
    track,
    st.corridor,
    st.simParams,
    SIM_SESSION_ID,
    'Virtual rider',
    SIM_COLOR,
  );
  const others = st.sessions.filter((s) => s.id !== SIM_SESSION_ID);
  const next = { ...st, sessions: [...others, session] };
  const selectedLaps = st.selectedLaps.some((l) => l.sessionId === SIM_SESSION_ID)
    ? st.selectedLaps
    : [...st.selectedLaps, { sessionId: SIM_SESSION_ID, lap: 1 }];
  set({ sessions: refreshAll(next), selectedLaps, simLine: line, simLapTimeS: lapTimeS });
}
```

In `removeSession`, leave the existing behaviour alone; in `persistMarkers` call sites nothing changes because the sim session carries no markers.

- [ ] **Step 4: Run the store test to verify it passes**

Run: `cd dda_lab && npx vitest run tests/unit/simStore.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Build the full panel**

Replace `dda_lab/src/ui/panels/SimPanel.tsx` with:

```tsx
import { useLab } from '../../state/store';
import { MACHINE_PRESETS } from '../../sim/presets';
import { fmtLapTime } from '../../state/selectors';

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  decimals?: number;
  testId: string;
  onChange: (v: number) => void;
}

function Slider({ label, value, min, max, step, unit, decimals = 2, testId, onChange }: SliderProps) {
  return (
    <label className="sim-slider">
      <span className="sim-slider-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        data-testid={testId}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="sim-slider-value num">
        {value.toFixed(decimals)}
        {unit ? ` ${unit}` : ''}
      </span>
    </label>
  );
}

export default function SimPanel() {
  const corridor = useLab((s) => s.corridor);
  const busy = useLab((s) => s.corridorBusy);
  const extract = useLab((s) => s.extractCorridorNow);
  const params = useLab((s) => s.simParams);
  const enabled = useLab((s) => s.simEnabled);
  const lapTimeS = useLab((s) => s.simLapTimeS);
  const setSimEnabled = useLab((s) => s.setSimEnabled);
  const setSimParams = useLab((s) => s.setSimParams);
  const applyPreset = useLab((s) => s.applyMachinePreset);
  const workspace = useLab((s) => s.workspace);
  const setWorkspace = useLab((s) => s.setWorkspace);

  const resolved = corridor
    ? Math.round((100 * corridor.known.filter(Boolean).length) / corridor.known.length)
    : 0;
  const widths = corridor
    ? Array.from(corridor.leftM, (l, i) => l + corridor.rightM[i])
        .filter((_, i) => corridor.known[i])
        .sort((a, b) => a - b)
    : [];
  const medianWidth = widths.length ? widths[widths.length >> 1] : NaN;

  const layer = (key: 'corridor' | 'idealLine', label: string) => (
    <label>
      <input
        type="checkbox"
        checked={workspace.mapLayers[key] !== false}
        onChange={(e) => setWorkspace({ mapLayers: { ...workspace.mapLayers, [key]: e.target.checked } })}
      />
      {label}
    </label>
  );

  return (
    <div className="panel sim-panel" data-testid="sim-panel">
      <div className="panel-row sim-head">
        <label>
          <input
            type="checkbox"
            checked={enabled}
            data-testid="sim-enable"
            onChange={(e) => setSimEnabled(e.target.checked)}
          />
          Virtual rider
        </label>
        <span className="sim-laptime num" data-testid="sim-laptime">
          {enabled && lapTimeS != null ? fmtLapTime(lapTimeS) : '—'}
        </span>
        <span className="bp-spacer" />
        <button data-testid="sim-extract" disabled={busy} onClick={() => void extract()}>
          {busy ? 'Extracting…' : 'Extract corridor'}
        </button>
        {corridor && (
          <span className="panel-note num" data-testid="sim-corridor-stats">
            {resolved} % · {medianWidth.toFixed(1)} m wide
          </span>
        )}
        {layer('corridor', 'Corridor')}
        {layer('idealLine', 'Line')}
      </div>

      <div className="sim-groups">
        <fieldset>
          <legend>Machine</legend>
          <label className="sim-slider">
            <span className="sim-slider-label">Preset</span>
            <select
              value={params.machine.presetId}
              data-testid="sim-preset"
              onChange={(e) => applyPreset(e.target.value)}
            >
              {MACHINE_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </label>
          <Slider label="Power" value={params.machine.powerKw} min={10} max={250} step={1} unit="kW" decimals={0}
            testId="sim-power" onChange={(v) => setSimParams({ machine: { powerKw: v, presetId: 'custom' } })} />
          <Slider label="Mass" value={params.machine.massKg} min={120} max={400} step={1} unit="kg" decimals={0}
            testId="sim-mass" onChange={(v) => setSimParams({ machine: { massKg: v, presetId: 'custom' } })} />
          <Slider label="Drag area" value={params.machine.cdA} min={0.2} max={0.6} step={0.01} unit="m²"
            testId="sim-cda" onChange={(v) => setSimParams({ machine: { cdA: v, presetId: 'custom' } })} />
        </fieldset>

        <fieldset>
          <legend>Tyre / track</legend>
          <Slider label="Friction μ" value={params.tyre.mu} min={0.6} max={1.7} step={0.01}
            testId="sim-mu" onChange={(v) => setSimParams({ tyre: { mu: v } })} />
          <Slider label="Max lean" value={params.tyre.maxLeanDeg} min={30} max={68} step={0.5} unit="°" decimals={1}
            testId="sim-lean" onChange={(v) => setSimParams({ tyre: { maxLeanDeg: v } })} />
          <Slider label="Kerb margin" value={params.tyre.kerbMarginM} min={0} max={2} step={0.1} unit="m" decimals={1}
            testId="sim-kerb" onChange={(v) => setSimParams({ tyre: { kerbMarginM: v } })} />
          <Slider label="Grip scale" value={params.tyre.gripScale} min={0.4} max={1.1} step={0.01}
            testId="sim-grip" onChange={(v) => setSimParams({ tyre: { gripScale: v } })} />
        </fieldset>

        <fieldset>
          <legend>Rider</legend>
          <Slider label="Line deviation" value={params.rider.lineDeviationM} min={0} max={3} step={0.05} unit="m" decimals={2}
            testId="sim-deviation" onChange={(v) => setSimParams({ rider: { lineDeviationM: v } })} />
          <Slider label="Braking" value={params.rider.brakingG} min={0.4} max={1.6} step={0.01} unit="g"
            testId="sim-braking" onChange={(v) => setSimParams({ rider: { brakingG: v } })} />
          <Slider label="Throttle delay" value={params.rider.throttleDelayS} min={0} max={1.5} step={0.01} unit="s"
            testId="sim-throttle" onChange={(v) => setSimParams({ rider: { throttleDelayS: v } })} />
          <Slider label="Traction control" value={params.rider.tcThreshold} min={0} max={1} step={0.01}
            testId="sim-tc" onChange={(v) => setSimParams({ rider: { tcThreshold: v } })} />
          <Slider label="Lean usage" value={params.rider.leanUsage} min={0.5} max={1} step={0.01}
            testId="sim-leanusage" onChange={(v) => setSimParams({ rider: { leanUsage: v } })} />
          <Slider label="Line style (C↔V)" value={params.rider.kappa} min={0} max={1} step={0.01}
            testId="sim-kappa" onChange={(v) => setSimParams({ rider: { kappa: v } })} />
        </fieldset>
      </div>
    </div>
  );
}
```

Append to `dda_lab/src/ui/panels/panels.css`:

```css
.sim-panel .sim-head { gap: 10px; align-items: center; flex-wrap: wrap; }
.sim-panel .sim-laptime { font-size: 18px; font-variant-numeric: tabular-nums; color: #c77dff; }
.sim-groups { display: flex; gap: 14px; flex-wrap: wrap; align-items: flex-start; }
.sim-groups fieldset { border: 1px solid #2a323d; border-radius: 6px; padding: 8px 10px; min-width: 260px; }
.sim-groups legend { color: #9aa7b8; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; }
.sim-slider { display: grid; grid-template-columns: 110px 1fr 76px; gap: 8px; align-items: center; margin: 4px 0; }
.sim-slider-label { color: #9aa7b8; font-size: 12px; }
.sim-slider-value { font-size: 12px; text-align: right; font-variant-numeric: tabular-nums; }
.sim-slider input[type='range'] { width: 100%; }
```

- [ ] **Step 6: Draw the ideal line on the map**

In `dda_lab/src/ui/MapView.tsx`, read the line with the other selectors:

```ts
  const simLine = useLab((s) => s.simLine);
```

add the import:

```ts
import { corridorGeoJson, idealLineGeoJson } from './SimLayers';
```

and in the "track model + schema" effect, after the `corridor` line:

```ts
    setData(map, 'idealLine', simLine ? idealLineGeoJson(simLine) : EMPTY);
```

adding `simLine` to that effect's dependency array.

- [ ] **Step 7: Write the e2e test**

Create `dda_lab/tests/e2e/sim.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

test('the virtual rider produces a lap that the map and charts follow', async ({ page }) => {
  await page.goto('/?example=serres_R6_1-19-849');
  await page.getByTestId('bp-tab-sim').click();
  await expect(page.getByTestId('sim-panel')).toBeVisible();

  // enable the simulator: a lap time appears
  await page.getByTestId('sim-enable').check();
  const lapTime = page.getByTestId('sim-laptime');
  await expect(lapTime).not.toHaveText('—');
  const before = await lapTime.textContent();

  // the simulated lap joins the lap table
  await expect(page.getByTestId('bottom-panels')).toContainText('2 laps selected');

  // dragging the braking slider changes the lap time
  const braking = page.getByTestId('sim-braking');
  await braking.fill('1.5');
  await braking.dispatchEvent('change');
  await expect(lapTime).not.toHaveText(before!);

  // the ideal line is on the map
  const hasLine = await page.evaluate(() => {
    const m = (window as unknown as { __map?: { getSource: (id: string) => unknown } }).__map;
    return Boolean(m?.getSource('idealLine'));
  });
  expect(hasLine).toBe(true);
});
```

If `window.__map` is not already exposed, add `(window as unknown as Record<string, unknown>).__map = map;` right after the map is created in `MapView.tsx`, guarded by `import.meta.env.DEV`.

- [ ] **Step 8: Run the full suite**

Run: `cd dda_lab && npm test && npm run typecheck && npx playwright test tests/e2e/sim.spec.ts`
Expected: all unit tests pass, typecheck clean, the e2e test passes.

- [ ] **Step 9: Visual verification**

```bash
cd dda_lab && npm run dev
```

With the browser (or Playwright screenshots) on `http://localhost:5173/?example=serres_R6_1-19-849`:

1. Sim tab → **Extract corridor** → the orange/cyan edges sit on the asphalt.
2. Tick **Virtual rider** → a purple lap appears in the lap table with a plausible time (Serres on a 1000 is roughly 1:35-1:50; a wildly different number means the solver or the line is wrong, not the UI).
3. The purple ideal line is on the map, inside the corridor, taking a recognisable racing line — wide in, tight at the apex, wide out.
4. Drag **Line style (C↔V)** from 0 to 1 and watch the line change shape on the map: at 0 a long sweeping arc, at 1 a squared-off line.
5. Drag **Braking** and watch the lap time and the `long_g` chart move together.
6. Move the chart cursor and confirm the bike marker tracks along the simulated lap on the map.
7. Select a real lap as reference (◉) and confirm the `delta_t` panel draws a Δt curve between the real and simulated laps.

Capture a screenshot of each of steps 3, 4 and 7. If the line does not look like a racing line, fix `line.ts` before calling this done.

- [ ] **Step 10: Commit**

```bash
git add dda_lab/src/state/store.ts dda_lab/src/ui/panels/SimPanel.tsx dda_lab/src/ui/panels/panels.css \
        dda_lab/src/ui/MapView.tsx dda_lab/tests/unit/simStore.test.ts dda_lab/tests/e2e/sim.spec.ts
git commit -m "feat(sim): virtual rider panel with live sliders

Three parameter groups drive simulate() on every change; the result goes
through refreshAll() as an ordinary session, so the map, the charts, the
cursor and delta_t pick it up with no new visualisation code.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-review notes

- **Spec coverage.** Corridor extraction → Tasks 1-4. κ line → Task 6. QSS solver → Task 7. Rider lag layer → Task 8. Synthetic Session + extension seam → Task 9. Three parameter groups + presets → Tasks 5, 10. Map layers → Tasks 4, 10. Error handling → Task 4 Step 6 (status messages) and Task 7 (clamping). Testing → every task. Disk-cache: the spec said `tracks/<trackId>/corridor.json`; the browser has no filesystem, so this is `localStorage` keyed by track id, with the same fingerprinting. Raise it with the owner if they want an export button instead.
- **Review Focus coverage.** Item 1 → Task 2 Step 9. Item 2 → Task 2 Step 9. Item 3 → Task 7 Step 4. Item 4 → Task 7 Step 4. Item 5 → Task 3 Step 4.
- **Known tuning risk.** The κ ordering in Task 6 and the lap-time plausibility in Task 10 depend on weights that may need one round of adjustment against the real Serres data. Both tests assert the *property* (κ=1 concentrates curvature more than κ=0; the lap time is in a plausible band), not a specific constant, so tuning does not mean rewriting tests.
