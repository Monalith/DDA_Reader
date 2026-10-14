# Fit to lap = calibrate the virtual rider (2026-10-14)

Owner's words: 'fit to reference' must not create a new channel/layer. It adapts the EXISTING virtual rider's parameters to the ridden lap; the owner then moves those same sliders to see how much their own riding could improve. Primary criterion: speed profile; also consider the line and long_g (from GPS speed).

## Design
- Fit lives in Rider mode ('Sürücü'): a 'Fit to lap' row (lap picker + Run + status). The separate 'fit' SolverMode, FitPanel, fitModel.ts, CornerSetting caps are removed.
- Fitted quantities: lap-wide A/R + pinned derived keys, and per-corner overrides of the rider's own keys (src/sim/cornerRider.ts CornerRiderKey), keyed by track-model turn n.
- Objective per station: ((v−vRef)/1 m/s)² + 0.3·((aLong−aRef)/0.1 g)²; line term 0.3·(offset−GPS offset)²/(1 m)² only for kappa/slideOut when the reference path is measured GPS.
- Machine/tyre are NOT fitted (preset or one-off identification).
- After a fit every slider shows the fitted value; edits start from there; a new fit overwrites; Reset corner → fitted values.
- Targets: Run036 L6 |lap−95.80| ≤ 1.0 s, corner min-speed RMSE < 4 km/h, fit ≤ 30 s in a worker, rider slider re-solve < 50 ms.
