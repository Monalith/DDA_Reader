# Rider model v2 — merge and first calibration (2026-10-11)

Branch: `feature/rider-v2-merge` (W0 + W1..W6 merged). Suite: 645 vitest, 74 pytest, typecheck clean.
Harness: `cd dda_lab && npx vite-node scripts/sim-validate.ts` (BMW + R6 references, `DEFAULT_SIM_PARAMS`).
Sweep driver used here: `scratchpad/dbg/sweep.ts` (A × R × μ × gripScale grid over `validate()`).

## 1. What the merge changed on top of the six packages

- `index.ts` wires W1's `brakeCapMs2`/`driveCapMs2` into the event caps and passes the event
  profile to `riderChannels`; W6's stubs for `corners.ts`/`events.ts` replaced by W3's files.
- `rider.ts`: the v1 per-sample lag layer (dead-bands, event merging, rate limits, OVERLAP clamp)
  is deleted. Without an `EventProfile` (optimal modes) brake/tps are read off the sign of `longG`.
- `circuitFixture.testCaps` delegates to the production caps, so the W3 tests run against W1 physics.
- `simRunners.ts` wired: free-trajectory Worker (cancel on newer request, `optCache`) and the OCP
  bridge job (`submitOcp`/`waitForOcp`, corridor token). OCP availability probes `/ocp/jobs/<id>`.
- `MapView`: `cornerEvents` source + circle/label layers (B red, T orange, A white, P green, E blue),
  toggled with the ideal line. `toSession`: `grip_use_peak` channel.
- `DEFAULT_SIM_PARAMS.rider` is now DERIVED from A/R (`presets.ts`); the solver tests probe the
  ceiling rider explicitly (`simSolver.test.ts` P).

## 2. Calibration decisions (derive.ts, presets.ts)

| Map | Before (W3/W6 proposal) | After | Why |
|---|---|---|---|
| `sBrake` | 0.30 + 0.65 R | **0.15 + 0.60 R** | owner's typical tyre peak 0.50 g on a 1.42 tyre needs g ≈ 0.35 (s 0.15); BMW deepest 0.98 g at R ≈ 0.4 |
| `sLat` | 0.55 + 0.42 R | **0.85 + 0.15 R** | lateral is camber thrust, curve flat; the BMW brakes softly yet carries v1 corner speeds |
| `leanUsage` | g(sLat) | **min(1, 0.87 + 0.35 R)** | owner p99 lean 51.2° = 0.87 of 59° at R ≈ 0; BMW at the limit from R ≈ 0.37 |
| `trailBrakeDepth` / `Profile` | 0.3+0.6R / R | **0.6+0.4R / 0.5+0.5R** | the pair is worth ~12 s on Serres; a soft-braking 1:19.8 must still trail deep |
| `throttleDelayS` | 1.6 − 1.4 A | **0.4 − 0.5 A** | R6 picks up at the apex (−0.06 s), owner reaches 20 % at +0.20 s; the 2 s Champ School window was brake-release→drive |
| `rollRateFrac` | 0.5 + 0.5 A | **0.4 + 0.6 A** | owner 0.48 of the Biniewicz bound at A ≈ 0.3 |
| preset `mu` | 1.25 / 1.30 / 1.33 / 1.35 | **1.32 / 1.37 / 1.40 / 1.42** (+5.3 %) | with g(s) < 1 the same laps need a higher PEAK (R2 §5 risk 2) |
| defaults | A 0.7 / R 0.5 | **A 0.9 / R 0.5** | BMW lap +0.28 s |

Also from W1's follow-up: roll-rate jerk floor `J_Y_MIN = 6 m/s³`, dφ/ds on a 20 m stencil, 3° lean
dead-band (Serres 85.84 → 80.76 s before the maps above).

## 3. Where the defaults land (harness, 1000 preset, no corridor)

| metric | BMW real | sim | R6 real | sim | target | |
|---|---|---|---|---|---|---|
| lap time, s | 79.79 | 80.07 | 79.80 | 80.07 | ±0.5 | PASS |
| braked sections | 7 | 9 | 6 | 9 | 7-14 | PASS |
| brake applications | — | 10 | — | 10 | 7-14 | PASS (v1: 13-16) |
| corner min-speed RMSE, km/h | — | 6.7 (bias −0.5) | — | 4.6 | ≤ 5 | BMW FAIL (K3 geometry gap, −17 km/h) |
| brake build −0.1 g → 90 %, s | 0.32 | 0.36 | 0.65 | 0.36 | 0.3-0.5 | PASS (v1: 0.25) |
| tyre brake peak median / deepest, g | −0.65 / −0.98 | −1.12 / −1.14 | −0.78 / −0.94 | same | — | still 0.15-0.4 g too deep |
| long_g p25, g | −0.70 | −1.10 | −0.66 | −1.10 | −0.70 ± 0.10 | **FAIL** |
| t_pick − t_apex, s | — | 0.30 | −0.06 | 0.30 | real ± 0.3 | R6 FAIL (harness reads 10 % held 0.3 s after a ~0 s delay + roll-on) |
| roll-on 20→90 %, s | — | 0.30 | 3.26 | 0.30 | real ± 0.3 | R6 FAIL |

### Why p25 and the brake peak do not close

The real riders' braking distribution is wide: one zone at 0.85-0.95 g of tyre, the rest at
0.54-0.72. The event template brakes every zone to the same `sBrake` ceiling (build → plateau →
trail release), so once the ceiling is set for the lap time, p25 sits at the plateau. Lowering
`sBrake` to the real p25 (R ≈ 0.25) costs +5 s of lap time at the same A — the sim then loses
time the real rider makes up by braking LATER (brake points are not a parameter yet) and by the
geometry (K3). This is the R3 §5 "zone-to-zone variation" item the selection record rejected in
favour of physics (stoppie + drag), which gives the speed-dependent peak but not the soft typical
zone. Candidate for v2.1: a per-zone braking fraction tied to the entry-speed rank, or a brake-point
margin (`Δs_brake`, R4 §5 step 8) that trades peak g for a later brake point.

### Roll-on

Real 20→90 % roll-on is 3.3 s (R6) and 7 s (owner) because the drive out of a corner is lean- and
grip-limited; the template ramps the acceleration to the cap in `rollOnS` (0.3-1.2 s) and the cap
itself then rises with lean, so the TPS channel reaches 90 % early. Matching the real TPS trace
needs `tps` defined from the torque actually usable at the current lean, not from the ramp.
Lap-time-neutral; v2.1.

## 4. The owner's laps (Panigale V4 preset, Run036, 1:35.8)

Identification (W4, `notes/2026-10-11-ducati-identification.md`): brake peak 0.80 g tyre / typical
0.50; build 0.52-0.95 s; roll-rate p90 31°/s (0.48 of bound); throttle 20 % at +0.20 s; lean p99
51.2°; slip p95 5.3 % corrected. With the maps above the sweep gives:

| A | R | gripScale | sim lap | p25 | tyre peak med/deep |
|---|---|---|---|---|---|
| 0.3 | 0 | 1.0 | 90.5 s | −0.52 | −0.47 / −0.49 |
| 0.3 | 0 | 0.9 | 93.6 s | −0.48 | −0.43 / −0.44 |
| 0.2 | 0 | 0.9 | 92.8 s | −0.48 | −0.42 / −0.44 |

The owner is **A ≈ 0.25, R ≈ 0, gripScale ≈ 0.9** → 93 s against 95.8 (spec §4a asked ±1 s; this is
−3 s). The typical braking (−0.48 vs measured −0.50) and the build match; the remaining 3 s is the
same brake-point/roll-on structure as above plus the owner's line (κ 0.85 preset vs an amateur's
line, unmeasured).

## 5. Open items carried to v2.1

1. Brake-point margin or per-zone braking fraction (p25, brake peak).
2. TPS from usable torque at lean (roll-on trace).
3. Reference geometry: K3 −17 km/h in the BMW file is the line, not the model.
4. `DERIVE_TABLE` coefficients remain `öneri`; one owner lap and two video-derived laps are the
   whole calibration set.
5. Deploy: `deploy_lab.sh` (lab) and `--with-ocp` (bridge service) not run — owner's call.
