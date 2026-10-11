# Rider Model v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-sample rider of the DDA Lab virtual rider with a corner-event rider driven by two top-level parameters (aggressiveness, risk), a below-peak-slip tyre, load-transfer limits, and two optional optimal solvers behind a mode switch.

**Architecture:** The κ-line and the `Session` packaging are unchanged. The QSS solver gains load transfer, a slip-scaled ellipse, a 3D g-budget (zero data) and a roll-rate constraint, and becomes an upper bound. A new corner segmentation finds one brake and one throttle event per corner; an event template turns those into the speed, brake and throttle traces. `derive.ts` maps aggressiveness/risk to every other rider number. A Web Worker free-trajectory optimiser and a server-side CasADi OCP produce two more `Session`s for comparison.

**Tech Stack:** TypeScript strict, React 19, Zustand, Vitest (node environment), Playwright; Python 3.11 FastAPI bridge (`dda_lab_bridge.py`, venv `/Users/macbookmini/projects/dda_venv`), CasADi (bundled IPOPT) for the OCP.

**Spec:** `docs/superpowers/specs/2026-10-11-virtual-rider-design-v2.md` (commit cfd9c10). Decisions: `docs/superpowers/notes/2026-10-11-model-selection.md`. Research: `docs/superpowers/research/2026-10-11-r1..r4-*.md`.

## Global Constraints

- All new TS code lives under `dda_lab/src/sim/` (UI under `dda_lab/src/ui/`); tests in `dda_lab/tests/unit/`. Vitest runs with `environment: 'node'`: **no test may touch `fetch`, `document`, `Worker`, `OffscreenCanvas` or `localStorage`**; browser dependencies are injected as function parameters.
- TypeScript strict. `cd dda_lab && npm run typecheck` must pass before every commit. `npx vitest run` must stay green (507 tests at cfd9c10 / 21de0c0).
- Units: metres, seconds, m/s and **radians** inside `src/sim/` (degrees only where a field is named `...Deg`); km/h only at the `Session` boundary. Lean channel sign: **left = negative** (`Envelope.leanDeg` doc).
- Browser budget: the rider mode must re-solve in < 50 ms for a ~1600-sample line (Serres, 2 m). Optimal modes run off the main thread and are triggered by a button, never on slider drag.
- **Package file ownership** (parallel work, separate worktrees, one branch each): W1 `vehicle.ts`, `tyre.ts`, `solver.ts` (+ their tests, `simLongG.test.ts`); W2 `freeTrajectory.ts`, `freeTrajectory.worker.ts`, `optCache.ts`; W3 `corners.ts`, `events.ts`, `rider.ts`, `circuitFixture.ts` (+ tests); W4 `scripts/*`, `tests/unit/simSerres.test.ts`, `tests/unit/gTraceMetrics.ts`; W5 `dda_lab_bridge.py`, `tests/test_bridge.py`, `ocp/*`, `deploy_lab.sh`, `src/sim/ocpClient.ts`; W6 `presets.ts`, `derive.ts`, `index.ts`, `risk.ts`, `state/store.ts`, `ui/panels/SimPanel.tsx`, `ui/SimLayers.ts`, `docs/MATH_GUIDE.md` (+ tests). **`types.ts` is frozen** (W0); a package that needs a type change messages the coordinator instead of editing it.
- Every coefficient that is a proposal rather than a measurement carries a comment naming the source and the tag `öneri` or `doğrulanmadı`, exactly as `presets.ts` already does.
- Commit after every task with `feat(sim):`, `fix(sim):`, `test(sim):` or `feat(bridge):`; author `-c user.name="Eren Uyanık" -c user.email="erenuyanik@gmail.com"`; trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Worktrees do not contain `dda_lab/node_modules`: run `ln -s /Users/macbookmini/projects/DDA_Reader/dda_lab/node_modules <worktree>/dda_lab/node_modules` first.

## Review Focus

1. **A corner the rider does not brake for** (fast kink, entry speed ≤ apex speed): the event template must emit no brake event and no throttle lift-off/re-apply pair; v1 produced a brake dab here. *(W3 Task 3.1, `hasBrake` test)*
2. **A chicane** (two opposite-sign curvature peaks with no room to accelerate between them): must be ONE corner section with one B and one P and `flips.length ≥ 1`, never two sections. *(W3 Task 3.1 chicane test)*
3. **`sLat` → 0.1, `sBrake` → 0.1 (risk slider at minimum)**: grip fraction floors at g(0.1) ≈ 0.15, the lap must stay finite, no NaN, and the lap time must be monotone in risk. *(W1 Task 1.2 monotonicity test; W1 Task 1.4 finite test)*
4. **Zero 3D channels must reproduce v1 bit-for-bit** — otherwise every calibration note in the repo is silently invalidated. *(W1 Task 1.3 bit-identity test against a stored v1 envelope)*
5. **The optimal solvers must never block the UI or run on slider drag**: the worker is created once, cancelled on a new request, and the store must not call `simulate()` for `freeTrajectory`/`ocp` from `setSimParams`. *(W6 Task 6.4 store test; W2 Task 2.3 cancellation test on the pure core)*
6. **Hang-off larger than physically possible with the rider mass** (`hangOffM` 0.5 with `riderMassKg` 40): the lean inverse must still converge (bisection bounds) and never return NaN. *(W1 Task 1.1 test)*

---

## File Structure

| File | Owner | Responsibility |
|---|---|---|
| `src/sim/vehicle.ts` (new) | W1 | CG height at lean, wheelie/stoppie limits, bike-lean ↔ ideal-lean conversion, roll-rate bound |
| `src/sim/tyre.ts` (extend) | W1 | `gripFraction` (exists), `effectiveMu(tyre, rider)` |
| `src/sim/solver.ts` (modify) | W1 | QSS passes with load transfer, μ_eff ellipse, 3D g-budget, roll-rate constraint; `gripUse`/`gripUsePeak` |
| `src/sim/corners.ts` (new) | W3 | Corner segmentation on a speed profile |
| `src/sim/events.ts` (new) | W3 | Event template → `v_event`, `brake`, `tps`; `v = min(v_event, v_qss)` |
| `src/sim/rider.ts` (rewrite) | W3 | Channels from events (brake/tps) + gear/rpm/dtc; legacy per-sample path kept behind a flag until merge |
| `src/sim/freeTrajectory.ts` (new) | W2 | Pure offset optimiser (coordinate-descent over corridor offsets, QSS inner loop) |
| `src/sim/freeTrajectory.worker.ts` (new) | W2 | Worker wrapper: run/progress/cancel messages |
| `src/sim/optCache.ts` (new) | W2 | Result cache keyed by corridor key + machine/tyre; memory + localStorage (injected storage) |
| `src/sim/ocpClient.ts` (new) | W5 | `POST/GET /ocp/jobs` client, polling, result → `Line` + `Envelope` |
| `ocp/ocp_motorcycle.py`, `ocp/job_queue.py` (new) | W5 | CasADi direct-collocation minimum-time OCP; single-worker queue |
| `dda_lab_bridge.py` (modify) | W5 | `/ocp/jobs` endpoints |
| `src/sim/derive.ts` (exists, wire) | W6 | A/R → rider fields (skeleton from W0) |
| `src/sim/index.ts` (modify) | W6 | `simulate(track, corridor, params, mode)`; wires corners/events; rider mode only; Fable wires W2/W5 at merge |
| `src/sim/risk.ts` (modify) | W6 | Banner on `gripUse` (μ_eff) + secondary `gripUsePeak` |
| `src/state/store.ts` (modify) | W6 | `solverMode`, three sim sessions, `deriveRider` on patch, `runOptimal()` action |
| `src/ui/panels/SimPanel.tsx` (modify) | W6 | Mode switch, A/R sliders, advanced panel, Hesapla button, corner count |
| `src/ui/SimLayers.ts` (modify) | W6 | Corner event markers GeoJSON |
| `scripts/sim-validate.ts`, `scripts/ducati-identify.ts` (new) | W4 | Validation harness and owner-lap identification (run with `npx vite-node`) |

---

## Shared interface contract (all packages code against this; nothing else is assumed)

```ts
// vehicle.ts (W1)
export const BINIEWICZ_JY = { beta0: 23.5, beta1: -0.31 } as const;   // m/s^3, 1/s^2 — thesis values, "doğrulanmadı" vs paper 32.56
export function cgHeightAtLean(m: MachineParams, phiRad: number): number;          // t + (h - t)·cos φ
export function wheelieLimitMs2(m: MachineParams, vMs: number, phiRad: number): number; // g·b/h_φ − F_D·h/(m·h_φ), ≥ 0.1
export function stoppieLimitMs2(m: MachineParams, phiRad: number): number;         // g·(p−b)/h_φ (tyre share; drag added by caller), ≥ 0.1
export function bikeLeanRad(m: MachineParams, idealLeanRad: number): number;       // crown + hang-off correction, R1 §3.2
export function idealLeanLimitRad(m: MachineParams, maxBikeLeanRad: number): number; // inverse of bikeLeanRad by bisection
export function rollRateBoundRadPerS(vMs: number, phiRad: number): number;         // (β0 + β1·V)/g · cos²φ, floor 0.05 rad/s

// tyre.ts (W0 + W1)
export function gripFraction(s: number, axis: 'long' | 'lat'): number;             // exists
export function effectiveMu(tyre: TyreTrackParams, rider: RiderParams): { brake: number; drive: number; lat: number };
//   brake = (muX ?? mu)·gripScale·g(sBrake,'long'); drive = same with sDrive; lat = mu·gripScale·g(sLat,'lat')

// solver.ts (W1) — signature unchanged
export function solve(line: Line, params: SimParams): Envelope;   // fills gripUse (μ_eff) AND gripUsePeak (μ_peak)
export function brakeCapMs2(line: Line, params: SimParams, i: number, vMs: number): number; // tyre braking decel available at sample i (ellipse·brakeShare·stoppie), WITHOUT drag
export function driveCapMs2(line: Line, params: SimParams, i: number, vMs: number): number; // drive accel available (power, ellipse·TC, wheelie), WITHOUT drag
export function lossDecelMs2(machine, vMs): number;               // exists
export function brakeShare(latUse, depth, profile): number;       // exists

// corners.ts (W3)
export interface CornerOpts { kFrac?: number /*0.25*/; promMinMs?: number /*8 km/h = 2.22*/; promFrac?: number /*0.05*/ }
export function findCorners(line: Line, v: Float32Array, params: SimParams, opts?: CornerOpts): Corner[];

// events.ts (W3)
export interface EventProfile { v: Float32Array; brake: Float32Array /*0..100*/; tps: Float32Array /*0..100*/; tS: Float64Array; lapTimeS: number; corners: Corner[] }
export interface EventCaps { brakeCapMs2(i: number, vMs: number): number; driveCapMs2(i: number, vMs: number): number; lossDecelMs2(vMs: number): number }
export function eventProfile(line: Line, env: Envelope, corners: Corner[], params: SimParams, caps: EventCaps): EventProfile;

// rider.ts (W3)
export function riderChannels(line: Line, env: Envelope, params: SimParams, ev?: EventProfile): RiderChannels; // ev given → brake/tps from events

// freeTrajectory.ts (W2)
export interface FreeTrajOpts { iterations: number; onProgress?: (frac: number, lapTimeS: number) => void; shouldCancel?: () => boolean }
export function optimiseOffsets(track: TrackModel, corridor: Corridor | undefined, params: SimParams, opts: FreeTrajOpts): { offsetsM: Float32Array; lapTimeS: number; iterationsDone: number };
// worker protocol: { type:'run', id, track, corridor, params, iterations } → { type:'progress', id, frac, lapTimeS } | { type:'done', id, offsetsM, lapTimeS } | { type:'error', id, message }; { type:'cancel', id }

// optCache.ts (W2)
export interface KVStorage { getItem(k: string): string | null; setItem(k: string, v: string): void }
export function optCacheKey(track: TrackModel, params: SimParams, mode: 'freeTrajectory' | 'ocp'): string;   // corridorKey(track) + hash of machine+tyre (NOT rider)
export function readOpt(key: string, nPoints: number, storage?: KVStorage): Float32Array | null;
export function writeOpt(key: string, offsetsM: Float32Array, lapTimeS: number, storage?: KVStorage): void;

// ocpClient.ts (W5)
export interface OcpJobRequest { key: string; centerline: LngLat[]; leftM: number[]; rightM: number[]; machine: MachineParams; tyre: TyreTrackParams }
export interface OcpResult { offsetsM: number[]; vMs: number[]; lapTimeS: number }
export async function submitOcp(req: OcpJobRequest, fetchImpl?: typeof fetch): Promise<{ id: string }>;
export async function pollOcp(id: string, fetchImpl?: typeof fetch): Promise<{ status: 'queued' | 'running' | 'done' | 'error'; progress?: number; result?: OcpResult; message?: string }>;
export function envelopeFromSpeed(line: Line, vMs: Float32Array): Envelope;  // longG/latG/lean/tS from v and κ (for optimal modes)

// derive.ts (W0, W6) — exists: deriveRider(rider, tyre), DERIVE_TABLE, DERIVED_KEYS
// index.ts (W6)
export function simulate(track, corridor, params, id, name, color, mode: SolverMode = 'rider'): SimResult & { corners?: Corner[] };
```

---

# W1 — Vehicle, tyre, solver

### Task 1.1: vehicle.ts — load transfer and lean conversion

**Files:** Create `dda_lab/src/sim/vehicle.ts`; Test `dda_lab/tests/unit/simVehicle.test.ts`.
**Interfaces:** Produces the `vehicle.ts` block above. Consumes `MachineParams` (W0).

- [ ] **Step 1: failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { bikeLeanRad, cgHeightAtLean, idealLeanLimitRad, rollRateBoundRadPerS, stoppieLimitMs2, wheelieLimitMs2 } from '../../src/sim/vehicle';
import { DEFAULT_SIM_PARAMS } from '../../src/sim/presets';

const M = { ...DEFAULT_SIM_PARAMS.machine, wheelbaseM: 1.44, cgRearM: 0.70, cgHeightM: 0.62, tyreCrownM: 0.08, hangOffM: 0, riderMassKg: 75, massKg: 270, cdA: 0.34 };
const G = 9.81;

describe('vehicle limits', () => {
  it('stoppie limit upright is g·(p−b)/h', () => {
    expect(stoppieLimitMs2(M, 0)).toBeCloseTo((G * 0.74) / 0.62, 6); // 1.19 g, R1 §3.1
  });
  it('wheelie limit upright at rest is g·b/h, and falls with speed (drag lifts the front)', () => {
    expect(wheelieLimitMs2(M, 0, 0)).toBeCloseTo((G * 0.70) / 0.62, 6);
    expect(wheelieLimitMs2(M, 60, 0)).toBeLessThan(wheelieLimitMs2(M, 0, 0));
  });
  it('CG height drops at lean through the crown radius', () => {
    expect(cgHeightAtLean(M, 0)).toBeCloseTo(0.62, 9);
    expect(cgHeightAtLean(M, Math.PI / 4)).toBeCloseTo(0.08 + 0.54 * Math.SQRT1_2, 6);
  });
  it('crown adds lean; hang-off takes it back', () => {
    const phiI = (45 * Math.PI) / 180;
    const noHang = bikeLeanRad(M, phiI);
    expect(noHang - phiI).toBeGreaterThan((4 * Math.PI) / 180);   // R1 table: +6.2° at t=0.08
    expect(noHang - phiI).toBeLessThan((8 * Math.PI) / 180);
    const hang = bikeLeanRad({ ...M, hangOffM: 0.25 }, phiI);
    expect(hang).toBeLessThan(noHang);
  });
  it('idealLeanLimitRad inverts bikeLeanRad and never returns NaN', () => {
    const maxBike = (58 * Math.PI) / 180;
    const phiI = idealLeanLimitRad(M, maxBike);
    expect(bikeLeanRad(M, phiI)).toBeCloseTo(maxBike, 4);
    const extreme = idealLeanLimitRad({ ...M, hangOffM: 0.5, riderMassKg: 40 }, maxBike);
    expect(Number.isFinite(extreme)).toBe(true);
    expect(extreme).toBeGreaterThan(0);
  });
  it('roll-rate bound: ~100°/s at 20 m/s upright, halves at 45°', () => {
    const w20 = rollRateBoundRadPerS(20, 0);
    expect((w20 * 180) / Math.PI).toBeGreaterThan(90);
    expect((w20 * 180) / Math.PI).toBeLessThan(110);
    expect(rollRateBoundRadPerS(20, Math.PI / 4)).toBeCloseTo(w20 / 2, 6);
    expect(rollRateBoundRadPerS(40, 0)).toBeLessThan(w20);
  });
});
```

- [ ] **Step 2:** `cd dda_lab && npx vitest run tests/unit/simVehicle.test.ts` → FAIL (module missing).
- [ ] **Step 3: implement** per R1 §3.1-3.3 (formulas in the interface block; `bikeLeanRad`: `e = riderMassKg·hangOffM/massKg`, `R = hypot(h−t, e)`, `δ = asin(min(1, t·sinφ_i/R)) − atan2(e, h−t)`, return `φ_i + δ`; `idealLeanLimitRad`: bisection on `[0, π/2)` for 40 iterations, return lower bound if never reached). Drag height `h_D = cgHeightM`. Air density and `lossDecelMs2` conventions as in `solver.ts`.
- [ ] **Step 4:** tests PASS, `npm run typecheck` clean.
- [ ] **Step 5: commit** `feat(sim): vehicle load-transfer limits and crown/hang-off lean conversion`.

### Task 1.2: tyre.ts — effectiveMu and monotonicity

**Files:** Modify `dda_lab/src/sim/tyre.ts`; Test `dda_lab/tests/unit/simTyre.test.ts`.

- [ ] **Step 1: failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { effectiveMu, gripFraction } from '../../src/sim/tyre';
import { DEFAULT_SIM_PARAMS } from '../../src/sim/presets';

describe('gripFraction', () => {
  it('matches the SEL-2004 derived table (R2 §3.4)', () => {
    expect(gripFraction(0.5, 'long')).toBeCloseTo(0.856, 2);
    expect(gripFraction(0.6, 'long')).toBeCloseTo(0.92, 2);
    expect(gripFraction(0.8, 'long')).toBeCloseTo(0.985, 2);
    expect(gripFraction(1, 'long')).toBeCloseTo(1, 9);
    expect(gripFraction(0, 'long')).toBe(0);
  });
  it('is monotone on both axes', () => {
    for (const axis of ['long', 'lat'] as const) {
      let prev = -1;
      for (let s = 0; s <= 1.0001; s += 0.01) { const g = gripFraction(s, axis); expect(g).toBeGreaterThanOrEqual(prev); prev = g; }
    }
  });
});
describe('effectiveMu', () => {
  const tyre = { ...DEFAULT_SIM_PARAMS.tyre, mu: 1.3, muX: 1.2, gripScale: 1 };
  it('scales each axis by its own allowed slip', () => {
    const r = { ...DEFAULT_SIM_PARAMS.rider, sBrake: 1, sDrive: 0.5, sLat: 1 };
    const mu = effectiveMu(tyre, r);
    expect(mu.brake).toBeCloseTo(1.2, 9);
    expect(mu.drive).toBeCloseTo(1.2 * 0.856, 2);
    expect(mu.lat).toBeCloseTo(1.3, 9);
  });
  it('muX undefined means muX = mu', () => {
    expect(effectiveMu({ ...tyre, muX: undefined }, DEFAULT_SIM_PARAMS.rider).brake).toBeCloseTo(1.3, 9);
  });
});
```

- [ ] **Step 2-5:** run → FAIL, implement, PASS, commit `feat(sim): effective mu per axis from allowed slip`.

### Task 1.3: solver.ts — 3D g-budget with bit-identity guard

**Files:** Modify `dda_lab/src/sim/solver.ts`; Test `dda_lab/tests/unit/simSolver.test.ts` (append).

- [ ] **Step 1: record the v1 envelope first.** Before touching `solver.ts`, add to `simSolver.test.ts` a test that solves the 5-corner `circuitFixture` at `DEFAULT_SIM_PARAMS` and asserts `env.lapTimeS` equals the value you print now (`console.log(env.lapTimeS.toFixed(6))`), to 6 decimals, and `Array.from(env.v).slice(0, 50)` equals a snapshot (`expect(...).toMatchInlineSnapshot()`). Commit this test alone: `test(sim): pin the v1 envelope before the v2 solver changes`.
- [ ] **Step 2: implement the g-budget** (R1 §3.5): per sample `σ = line.slopeRad?.[i] ?? 0`, `β = line.bankRad?.[i] ?? 0`, `ν = line.nu?.[i] ?? 0`; `gTilde = G·cosσ·cosβ + v²·ν`; lateral demand `aY = v²κ − G·cosσ·sinβ`; longitudinal budget in both passes subtracts `G·sinσ` (uphill costs drive, helps braking). Lateral limit from `v² ≤ (μ_lat·G·cosσ·cosβ + G·cosσ·sinβ)/(|κ| − μ_lat·ν)` with the v1 cap when the denominator ≤ 0.
- [ ] **Step 3:** the pinned test from Step 1 must still pass **unchanged** (zero channels = v1). Add a test with `slopeRad` filled with +0.05 on a straight line: lap time increases; with −0.05: decreases.
- [ ] **Step 4: commit** `feat(sim): 3D road g-budget in the QSS passes, zero data reproduces v1`.

### Task 1.4: solver.ts — load transfer, μ_eff ellipse, roll-rate, gripUsePeak, caps

**Files:** Modify `solver.ts`; Tests `simSolver.test.ts`, `simLongG.test.ts` (update expectations with reasons in comments).

- [ ] **Step 1: failing tests**

```ts
it('lap time is monotone in risk through the allowed-slip fractions', () => {
  const line = circuitLine(); // from circuitFixture
  const t = (s: number) => solve(line, clampParams({ ...P, rider: { ...P.rider, sBrake: s, sDrive: s, sLat: s } })).lapTimeS;
  expect(t(0.1)).toBeGreaterThan(t(0.5));
  expect(t(0.5)).toBeGreaterThan(t(1));
  expect(Number.isFinite(t(0.1))).toBe(true);
});
it('braking never exceeds the stoppie limit plus drag', () => {
  const env = solve(straightIntoHairpin(), P);
  for (let i = 0; i < env.v.length; i++) {
    const cap = stoppieLimitMs2(P.machine, 0) + lossDecelMs2(P.machine, env.v[i]);
    expect(-env.longG[i] * 9.81).toBeLessThanOrEqual(cap + 0.05);
  }
});
it('gripUse is normalised to the rider ceiling and gripUsePeak to the tyre', () => {
  const env = solve(circuitLine(), clampParams({ ...P, rider: { ...P.rider, sLat: 0.5, sBrake: 0.5, sDrive: 0.5 } }));
  const peakUse = Math.max(...env.gripUse); const peakTyre = Math.max(...env.gripUsePeak!);
  expect(peakUse).toBeLessThanOrEqual(1.05);
  expect(peakTyre).toBeLessThan(peakUse);           // the tyre has more than the rider uses
});
it('a lower roll-rate fraction slows a chicane but not a constant-radius circle', () => {
  const slow = { ...P, rider: { ...P.rider, rollRateFrac: 0.2 } };
  expect(solve(chicaneLine(), clampParams(slow)).lapTimeS).toBeGreaterThan(solve(chicaneLine(), P).lapTimeS);
  expect(solve(circleLine(60), clampParams(slow)).lapTimeS).toBeCloseTo(solve(circleLine(60), P).lapTimeS, 3);
});
it('with hang-off the lean-limited 1000 preset corners faster', () => {
  const base = solve(circleLine(60), P).lapTimeS;
  const hang = solve(circleLine(60), clampParams({ ...P, machine: { ...P.machine, hangOffM: 0.3 } })).lapTimeS;
  expect(hang).toBeLessThan(base);
});
```

- [ ] **Step 2: implement.** (a) `aLatMax = min(μ_lat_eff, tan(idealLeanLimitRad(m, maxLeanDeg·leanUsage)))·g̃`; (b) backward pass tyre share `min(aBrakeMax·brakeEllipse, stoppieLimitMs2(m, φ))` where `aBrakeMax = μ_brake_eff·g̃` (drop the `brakingG` cap: it is now derived from the same quantity — keep `min(…, brakingG·g)` only if `brakingG` is in `overrides`; document); (c) forward pass `min(aPower, μ_drive_eff·g̃·ellipse·tcFactor, wheelieLimitMs2(m, v, φ))`; (d) after the passes, roll-rate constraint loop ×3: `φ(s)` from `bikeLeanRad(atan(aY/g̃))`, `dφ/ds` by central difference, `v ≤ rollRateFrac·rollRateBoundRadPerS(v, φ)/|dφ/ds|`, then re-run backward+forward; (e) `leanDeg` = **bike** lean (negated, left negative); (f) `gripUse` divides by μ_eff per axis (hypot of lat/lat_eff and long/long_eff), `gripUsePeak` by μ_peak; (g) export `brakeCapMs2` and `driveCapMs2` returning the same per-sample caps the passes use (no drag).
- [ ] **Step 3:** all tests PASS; `simLongG.test.ts` expectations updated with a comment on every changed number explaining which limit moved it.
- [ ] **Step 4: commit** `feat(sim): load-transfer limits, allowed-slip ellipse and roll-rate constraint in the solver`.

---

# W2 — Free-trajectory mode

### Task 2.1: optimiseOffsets core

**Files:** Create `dda_lab/src/sim/freeTrajectory.ts`; Test `dda_lab/tests/unit/simFreeTrajectory.test.ts`.
**Consumes:** `offsetBounds`, `lineFromOffsets`, `buildLine` (`line.ts`), `solve` (`solver.ts`), `clampParams`.

- [ ] **Step 1: failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { optimiseOffsets } from '../../src/sim/freeTrajectory';
import { buildLine, lineFromOffsets } from '../../src/sim/line';
import { solve } from '../../src/sim/solver';
import { DEFAULT_SIM_PARAMS, clampParams } from '../../src/sim/presets';
import { circuitTrack } from './circuitFixture'; // W3 adds this export; until then build a track inline as simLine.test.ts does

const P = clampParams({ ...DEFAULT_SIM_PARAMS, rider: { ...DEFAULT_SIM_PARAMS.rider, sBrake: 1, sDrive: 1, sLat: 1, rollRateFrac: 1 } });

describe('optimiseOffsets', () => {
  it('is never slower than the kappa line it starts from', () => {
    const track = circuitTrack();
    const start = solve(buildLine(track, undefined, P), P).lapTimeS;
    const r = optimiseOffsets(track, undefined, P, { iterations: 20 });
    expect(r.lapTimeS).toBeLessThanOrEqual(start + 1e-6);
    expect(solve(lineFromOffsets(track, r.offsetsM), P).lapTimeS).toBeCloseTo(r.lapTimeS, 6);
  });
  it('stays inside the corridor box', () => {
    const track = circuitTrack();
    const r = optimiseOffsets(track, undefined, P, { iterations: 5 });
    for (const d of r.offsetsM) expect(Math.abs(d)).toBeLessThanOrEqual(5 + P.tyre.kerbMarginM + 1e-6);
  });
  it('reports progress and honours cancellation', () => {
    const track = circuitTrack(); const fr: number[] = []; let calls = 0;
    const r = optimiseOffsets(track, undefined, P, { iterations: 50, onProgress: (f) => fr.push(f), shouldCancel: () => ++calls > 3 });
    expect(r.iterationsDone).toBeLessThan(50);
    expect(fr.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2-3: implement.** Start from `buildLine(...).offsetM`. Each iteration: for a set of control knots every ~20 m, try `±step` perturbations smoothed with a raised-cosine window (±40 m), accept if `solve(lineFromOffsets(...)).lapTimeS` improves, shrink `step` when nothing improves (coordinate descent; no gradient). Clamp to `offsetBounds`. Ideal rider: force `sBrake=sDrive=sLat=rollRateFrac=1` inside (copy params). Time budget: each `solve` ~1 ms → 50 iterations × ~80 knots × 2 = ~8 s; acceptable in a worker. Call `onProgress(iter/iterations, best)` per iteration and check `shouldCancel()`.
- [ ] **Step 4: commit** `feat(sim): free-trajectory offset optimiser (ideal rider, coordinate descent)`.

### Task 2.2: worker wrapper and cache

**Files:** Create `freeTrajectory.worker.ts`, `optCache.ts`; Test `simOptCache.test.ts` (cache only — the worker file is browser-only and excluded from tests).

- [ ] Cache tests: round-trip through an injected in-memory `KVStorage`; key ignores `rider` (two different A/R give the same key) and changes with `machine.powerKw`; `readOpt` returns null on length mismatch and on malformed JSON.
- [ ] Worker: `self.onmessage` handles `run`/`cancel` per the protocol; `cancel` flips a flag read by `shouldCancel`; posts `done` with `offsetsM` as a transferable.
- [ ] Commit `feat(sim): free-trajectory worker and result cache`.

---

# W3 — Corner segmentation, event template, rider channels

### Task 3.1: corners.ts

**Files:** Create `corners.ts`; Test `simCorners.test.ts`; Modify `tests/unit/circuitFixture.ts` to also export `circuitTrack(): TrackModel` and `chicaneTrack(): TrackModel` (a straight → right 60 m → left 60 m with 15 m between → straight).

- [ ] **Step 1: failing tests**

```ts
it('finds five sections on the five-corner circuit, each with one B and one P', () => {
  const line = buildLine(circuitTrack(), undefined, P); const env = solve(line, P);
  const cs = findCorners(line, env.v, P);
  expect(cs.length).toBe(5);
  for (const c of cs) { expect(c.iB).toBeLessThanOrEqual(c.iT); expect(c.iT).toBeLessThan(c.iA); expect(c.iA).toBeLessThanOrEqual(c.iP); expect(c.iP).toBeLessThanOrEqual(c.iE); }
});
it('a chicane is one section with a flip', () => {
  const line = buildLine(chicaneTrack(), undefined, P); const env = solve(line, P);
  const cs = findCorners(line, env.v, P);
  expect(cs.length).toBe(1); expect(cs[0].flips.length).toBeGreaterThanOrEqual(1);
});
it('a kink taken flat out has no brake event', () => {
  // a 400 m radius bend on the 250 preset: v_lat > top speed
  const cs = findCorners(kinkLine, kinkEnv.v, P250);
  expect(cs.every((c) => !c.hasBrake)).toBe(true);
});
it('ignores speed dips below the prominence threshold', () => { /* jittered circle: 0 sections */ });
```

- [ ] **Step 2-3: implement** spec §2.4: local minima of `v` (wrap-around), prominence = `min(maxLeft, maxRight) − v[min]` with the search bounded by the neighbouring minima; keep if `≥ max(promMinMs, promFrac·v[min])`; merge neighbours when the rise between them `< threshold` or the gap `< v²/(2·a_drive)` (`a_drive` from `driveCapMs2`-free estimate `μ·g·0.5`); `iT`/`iE` from `|κ|` smoothed over 20 m at `kFrac·|κ|max` of the section; `hasBrake = v[iBcandidate] > v[iA] + promMinMs`; `dir = sign(κ[iAgeo])`; `flips` where `sign(κ)` changes inside `[iT, iE]`.
- [ ] **Step 4: commit** `feat(sim): corner segmentation with one brake and one throttle event per section`.

### Task 3.2: events.ts

**Files:** Create `events.ts`; Test `simEvents.test.ts`.

- [ ] **Step 1: failing tests**

```ts
it('v_event never exceeds the QSS envelope and is C1 at the joins', () => {
  const ev = eventProfile(line, env, corners, P, caps);
  for (let i = 0; i < ev.v.length; i++) expect(ev.v[i]).toBeLessThanOrEqual(env.v[i] + 1e-4);
  // no jump in longitudinal accel larger than the brake jerk over one sample
  const dsMax = 2.5; const jerkPerSample = P.rider.brakeRiseGps * 9.81 * (dsMax / 20);
  for (let i = 2; i < ev.v.length; i++) { const a1 = (ev.v[i]**2 - ev.v[i-1]**2)/4, a0 = (ev.v[i-1]**2 - ev.v[i-2]**2)/4; expect(Math.abs(a1 - a0)).toBeLessThan(jerkPerSample * 3 + 0.3); }
});
it('exactly one brake application and one throttle pick-up per section', () => {
  const ev = eventProfile(line, env, corners, P, caps);
  for (const c of corners) {
    const b = Array.from(ev.brake.slice(c.iB, c.iE + 1)); const rises = b.filter((x, k) => k > 0 && b[k-1] < 5 && x >= 5).length + (b[0] >= 5 ? 1 : 0);
    expect(rises).toBe(c.hasBrake ? 1 : 0);
    const t = Array.from(ev.tps.slice(c.iA, c.iE + 1)); let down = 0; for (let k = 1; k < t.length; k++) if (t[k] < t[k-1] - 1) down++;
    expect(down).toBe(0);                      // throttle never closes again before the exit
  }
});
it('brake build takes 0.3-0.5 s to 90 % of peak at default aggressiveness', () => { /* measure on the hardest zone */ });
it('higher aggressiveness gives a faster lap; higher risk gives a faster lap', () => { /* monotone, via caps that read sBrake etc. */ });
```

- [ ] **Step 2-3: implement** spec §2.5. Backward from `iA` with `v_A = env.v[iA]`: integrate `dv²/ds = 2(a_tyre + loss)` where `a_tyre = min(J_b·t_on, caps.brakeCapMs2(i, v)·brakeShare(latUse, depth, profile))`, `t_on` accumulated along the backward walk (so the build is at the START of braking, i.e. the far end of the walk: do the walk twice — first to find B, then forward from B with the rate limit); B = first index where the braking curve meets the previous section's drive curve. Forward from `iA`: hold `a_x = 0` (speed constant, drag compensated) for `throttleDelayS`; then ramp `a_x` from 0 to `caps.driveCapMs2` over `rollOnS` with a smoothstep; continue at the cap until the next section's B. `brake` channel = `100·a_tyre/g_b_peak`, `tps` = `100·ramp` (0 in the delay window, maintenance 8 % while in the window). `tS` by trapezoid. Sections without `hasBrake`: no brake segment; throttle closes at `iT` to maintenance and reopens at P.
- [ ] **Step 4: commit** `feat(sim): corner-event speed, brake and throttle template`.

### Task 3.3: rider.ts from events

**Files:** Modify `rider.ts`; Test `simRider.test.ts` (rewrite the event-related tests; keep gear/rpm/dtc tests).

- [ ] `riderChannels(line, env, params, ev?)`: when `ev` is given, `brake = ev.brake`, `tps = ev.tps` (rate limits and dead-bands **not** applied), gear/rpm from `env.v`, dtc as today. When `ev` is absent, keep the v1 path verbatim but mark the block `// LEGACY (v1 per-sample) — removed at merge once index.ts passes `ev``. Tests: with `ev`, brake applications per section = 1; legacy tests unchanged.
- [ ] Commit `feat(sim): rider channels from the corner-event profile`.

---

# W4 — Validation harness and owner-lap identification

### Task 4.1: `scripts/sim-validate.ts`

**Files:** Create `dda_lab/scripts/sim-validate.ts`, `dda_lab/scripts/lib/cornerMetrics.ts`; Test `tests/unit/simCornerMetrics.test.ts`. Run with `cd dda_lab && npx vite-node scripts/sim-validate.ts <reference.json>`.

- [ ] `cornerMetrics(speedKmh: Float32Array, distM: Float32Array, longG?: Float32Array)` → `{ brakeEvents: number; minSpeeds: {sM, kmh}[]; buildTimesS: number[]; longGp25: number; lapTimeS: number }` using the same prominence rule as `corners.ts` (import `findCorners`-free helper: reimplement minima+prominence on a measured speed trace — spec §2.4 says the same thresholds apply to real data). Tests on a synthetic trace with known 3 dips.
- [ ] The script loads `_inbox/serres_BMW_1-19-81.json` / `serres_R6_1-19-849.json` (`telemetri_1m`: `s_m`, `hiz_kmh`, `boylamsal_g`), builds the Serres track as `simSerres.test.ts` does today, runs `simulate()` in rider mode at `DEFAULT_SIM_PARAMS`, and prints a table: metric | real | sim | target (spec §4b) | PASS/FAIL. Exit code 1 on any FAIL. Until W1/W3 land it runs against v1 and documents the baseline numbers in `docs/superpowers/notes/2026-10-11-validation-baseline.md`.
- [ ] Commit `feat(sim): validation harness with per-corner metrics`.

### Task 4.2: `scripts/ducati-identify.ts`

**Files:** Create `dda_lab/scripts/ducati-identify.ts`, `dda_lab/scripts/lib/ddaLap.ts` (lap splitting of `_inbox/Run036-219926-00.00.json` `records[]` by `lap` field, GPS → arc length via `haversineM`), `scripts/lib/slipCorrection.ts`; Test `tests/unit/slipCorrection.test.ts`.

- [ ] Slip correction (R2 §3.6): select samples `tps_pct < 8 && |accel_long_g| < 0.05 && torque_fast_pct == 0 && torque_slow_pct == 0`; least squares `slip = c0 + c2·(1 − cos lean)`; test: a synthetic trace with `slip = 0.5 + 10·(1−cosφ)` recovers c2 to 2 %.
- [ ] Metrics per R3 §6.3 (a)-(f): braking g peak/typical, build time, roll-rate p90 at turn-in (signed lean derivative, Savitzky-Golay 5), `t_pick`, roll-on 20→90 %, corrected slip p50/p95 in the drive phase, DTC-active slip median, lean p99. Then (g): invert the `DERIVE_TABLE` maps to A and R candidates, weighted median, print disagreements. Output JSON to `docs/superpowers/notes/2026-10-11-ducati-identification.json` and a Markdown summary next to it.
- [ ] Commit `feat(sim): owner-lap parameter identification script`.

---

# W5 — Full OCP on the bridge

### Task 5.1: job queue and endpoints

**Files:** Modify `dda_lab_bridge.py`; Create `ocp/__init__.py`, `ocp/job_queue.py`; Test `tests/test_bridge.py` (append).

- [ ] Tests (FastAPI `TestClient`, monkeypatched solver function that sleeps 0.05 s and returns a fixed result): `POST /ocp/jobs` → 202 `{id}`; `GET /ocp/jobs/{id}` → `queued|running|done` with `result`; second concurrent POST is `queued` behind the first (single worker); unknown id → 404; body with mismatched array lengths → 422; key not matching `^[a-z0-9][a-z0-9-]{0,63}$` → 422; job older than `OCP_TTL_S` is purged; `OCP_TIMEOUT_S` (default 900) kills a long job → `error`.
- [ ] Implement: `threading.Thread` worker + `queue.Queue`, results in memory + `DATA_DIR/ocp/<id>.json`; token header `X-Corridor-Token` reuse for POST (same env `DDA_CORRIDOR_TOKEN`); request body `{key, centerline:[[lng,lat]...], leftM:[], rightM:[], machine:{}, tyre:{}}` capped at 20 000 points.
- [ ] Commit `feat(bridge): OCP job queue and endpoints`.

### Task 5.2: CasADi minimum-time OCP

**Files:** Create `ocp/ocp_motorcycle.py`; Test `tests/test_ocp.py` (marked slow; a 200 m circle must give lap time within 2 % of `2πr/√(μ g r)` for a point mass with huge power).

- [ ] `pip install casadi` into `dda_venv` (bundles IPOPT). Model in the arc-length domain on the centerline (Perantoni & Limebeer form): states `n` (lateral offset), `ξ` (heading error), `v`, `φ` (roll), `φ̇`; controls `a_x` (longitudinal tyre accel), `φ̈`; `dt/ds = (1 − n·κ_c)/(v·cos ξ)`; constraints: corridor `−rightM ≤ n ≤ leftM`, ellipse with μx/μy, stoppie/wheelie (R1 §3.1), roll-rate bound (Biniewicz), power `a_x ≤ P/(m v) − drag`, `|φ| ≤ maxLean`; objective `∫ dt`; periodic boundary. Direct collocation (trapezoid) on ~2 m nodes, IPOPT with `max_iter 3000`, warm start from the QSS speed profile (compute a simple forward-backward in numpy). Returns `{offsetsM (=n at centerline vertices), vMs, lapTimeS, iterations}`.
- [ ] Commit `feat(bridge): CasADi direct-collocation minimum-time motorcycle OCP`.

### Task 5.3: `src/sim/ocpClient.ts` and deploy script

- [ ] Tests with an injected `fetchImpl`: submit builds the right body from `TrackModel`+`Corridor`+`SimParams`; `pollOcp` maps statuses; `envelopeFromSpeed` on a circle reproduces `latG = v²κ/g` and a monotone `tS`. Base URL: same-origin relative in production, `http://127.0.0.1:8777` in dev (copy the rule from `corridorService.ts`).
- [ ] `deploy_lab.sh`: upload `ocp/` and install `casadi` in the droplet venv **only when `--with-ocp` is passed**; default deploy unchanged. Do NOT run the deploy.
- [ ] Commit `feat(sim): OCP client and opt-in deploy of the OCP service`.

---

# W6 — Presets, derive wiring, store, UI, docs

### Task 6.1: derive tests and preset recalibration placeholders

**Files:** `derive.ts`, `presets.ts`; Test `simDerive.test.ts`, `simPresets.test.ts`.

- [ ] Tests: `deriveRider` at A=R=0 and 1 reproduces the `DERIVE_TABLE` end points; a key in `overrides` is untouched; `brakingG = muX·gripScale·g(sBrake)`; `leanUsage = g(sLat,'lat')`; output is a new object. Presets: every preset has `cgRearM` within 0.4-0.6 of the wheelbase, `riderMassKg < massKg`; every new preset number has a source comment (grep test on the file text for `// source:` or `öneri`).
- [ ] Commit `test(sim): derive and preset invariants`.

### Task 6.2: index.ts mode switch and rider wiring

- [ ] `simulate(track, corridor, params, id, name, color, mode = 'rider')`: rider mode → `buildLine → solve → findCorners → eventProfile(caps from solver's brakeCapMs2/driveCapMs2/lossDecelMs2) → riderChannels(..., ev) → toSession` with `env.v` replaced by `ev.v` and `tS`/`lapTimeS` from `ev` (write a small `envelopeFromEvent(env, ev)` helper here). `freeTrajectory`/`ocp` modes: accept an optional `offsetsM`+`vMs` argument (`OptimalInput`) and build `Line` via `lineFromOffsets`, envelope via `envelopeFromSpeed`-like helper (define it in `index.ts` as `envelopeFromSpeed` is W5's; W6 writes its own private copy and Fable dedupes at merge). Until W3 lands, `findCorners`/`eventProfile` imports will not exist: **W6 codes the wiring behind a `try`-free static import and commits last**, or stubs by typing against the contract — coordinate with Fable; the expected path is that W6's index.ts commit happens after W1/W3 merge.
- [ ] Test `simIndex.test.ts`: rider mode returns `corners`; the session has `brake` and `tps` channels; `isSim` true.
- [ ] Commit `feat(sim): simulate() with solver mode and corner-event wiring`.

### Task 6.3: risk.ts

- [ ] `gripRiskMessage(gripUse, gripUsePeak?)`: banner text names both figures: "… % of the rider's grip ceiling (… % of the tyre)". Tests updated.
- [ ] Commit `feat(sim): risk banner normalised to the rider ceiling`.

### Task 6.4: store

- [ ] State: `solverMode: SolverMode` (default `'rider'`), `simOptBusy: { freeTrajectory: boolean; ocp: boolean }`, `simOptProgress`, three session ids `SIM_SESSION_ID`, `SIM_OPT_SESSION_ID = 'sim-opt'`, `SIM_OCP_SESSION_ID = 'sim-ocp'`. `setSimParams` runs `deriveRider` on every patch (unless the patched key is in `overrides`; patching a derived key adds it to `overrides`; a new action `clearOverride(key)` removes it). `setSolverMode(mode)` only switches which session is highlighted; it never computes. `runOptimal(mode, runner)` takes an injected runner `(track, corridor, params, onProgress) => Promise<{offsetsM, vMs?, lapTimeS}>` so the node test can drive it without a Worker; on completion it builds the session via `simulate(..., mode, optimalInput)` and `refreshAll`. `setSimParams` must **not** trigger `runOptimal`. Tests in `simStore.test.ts` cover: derive on patch, override pinning, no optimal run on slider patch, three sessions coexisting, `setSimEnabled(false)` removes all three.
- [ ] Commit `feat(sim): store with solver modes, derived rider and optimal runs`.

### Task 6.5: SimPanel and layers

- [ ] Panel: mode switch (three segmented buttons, optimal ones disabled with a tooltip when the bridge is unreachable for `ocp`); "Hesapla" button + progress bar for optimal modes; Rider group: Aggressiveness and Risk sliders, then "Gelişmiş" disclosure listing every `DERIVED_KEYS` value with a lock icon showing override state; Machine group adds `cgRearM`, `tyreCrownM`, `hangOffM`; header shows lap time and `corners.length` + brake count. `SimLayers.ts`: `cornerEventsGeoJson(line, corners)` → points with `kind: 'B'|'T'|'A'|'P'|'E'`; test in `simLayers.test.ts`.
- [ ] Visual check with the dev server and Playwright (`npm run dev`; drag Risk, assert the lap time text changes and the map trace updates); screenshot to the scratchpad, not the repo.
- [ ] Commit `feat(sim): v2 panel with aggressiveness/risk, advanced overrides and solver modes`.

### Task 6.6: MATH_GUIDE

- [ ] Update `docs/MATH_GUIDE.md` sections for the ellipse scaling, load transfer, lean conversion, corner events, A/R mapping with the formulas from spec §2; cite research files.
- [ ] Commit `docs: math guide for rider model v2`.

---

## Merge (Fable)

1. Merge order: W1 → W3 → W6 → W2 → W5 → W4 (W4 last because it recalibrates). Resolve `index.ts` wiring; delete the LEGACY block in `rider.ts`; dedupe `envelopeFromSpeed`.
2. Run `npm run typecheck`, `npx vitest run`, `pytest tests/`.
3. Run `scripts/sim-validate.ts` on BMW/R6 and `scripts/ducati-identify.ts`; recalibrate `muY`/`muX` presets and `DERIVE_TABLE` so (a) the owner's fitted A/R reproduce 1:35.8 ± 1 s on the Panigale preset and (b) the BMW metrics meet spec §4b. Record in `notes/2026-10-11-v2-calibration.md`.
4. Code review per package (`code-review` skill, high), fix, Playwright visual check, single squash-free merge commit on `feature/virtual-rider`, push. Deploy of the lab (`deploy_lab.sh`) and of the OCP service only on the owner's word.
