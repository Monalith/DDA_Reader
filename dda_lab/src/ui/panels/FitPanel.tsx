// "Fit to reference" in the sim panel: pick the lap to fit, run the fit (a
// Worker, ~30 s), then tune every corner by hand. A corner is picked on the
// map (its zone / apex on the fitted line) or in the corner bar; its sliders
// sit here, on the left.
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { activeTrack, fitReferenceLap, useLab } from '../../state/store';
import { fmtDelta, fmtLapTime } from '../../state/selectors';
import { MIN_SPEED_OFF_KMH, SETTING_BOUNDS, type CornerSetting } from '../../sim/fitModel';
import { lapReferenceProblem } from '../../sim/lapReference';
import { fitRunner } from './simRunners';
import { RangeInput } from './RangeInput';

const DEBOUNCE_MS = 30;

type NumKey = Exclude<keyof CornerSetting, 'coast'>;

interface SliderDef {
  key: NumKey;
  label: string;
  step: number;
  help: string;
  /** End labels either side of the track (low, high). */
  ends?: [string, string];
  format: (v: number, ctx: { vMinRefKmh: number }) => string;
}

const pct = (v: number): string => `×${v.toFixed(2)}`;

/** The corner sliders, in the order a rider thinks through a corner. */
const SLIDERS: SliderDef[] = [
  {
    key: 'kappa',
    label: 'Line C ↔ V',
    step: 0.01,
    ends: ['C', 'V'],
    help: 'Line shape in this corner: C (0) = a round, minimum-curvature arc that carries speed; V (1) = the shortest path — straight in, a tight apex, straight out. The fitted value reproduces the reference lap\'s own line.',
    format: (v) => `${v < 0.34 ? 'C' : v > 0.66 ? 'V' : 'C/V'} ${v.toFixed(2)}`,
  },
  {
    key: 'apexShiftM',
    label: 'Apex shift',
    step: 1,
    help: 'Moves the corner\'s line pattern along the track: − = an earlier apex, + = a later apex.',
    format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(0)} m`,
  },
  {
    key: 'brakeScale',
    label: 'Braking',
    step: 0.01,
    help: 'Braking g into this corner, × the fitted rider\'s (later and harder ↔ earlier and softer). Bounded by the front tyre.',
    format: pct,
  },
  {
    key: 'minSpeedDeltaKmh',
    label: 'Min speed',
    step: 0.5,
    help: 'The corner\'s minimum speed (where the reference was slowest on this stretch): a V corner is braked down to a low minimum, a C corner carries speed. At the right end it is off and only the line and grip limit the speed.',
    format: (v, c) => (v >= MIN_SPEED_OFF_KMH ? 'off' : `${(c.vMinRefKmh + v).toFixed(1)} km/h`),
  },
  {
    key: 'slideOut',
    label: 'Slide out',
    step: 0.01,
    ends: ['0', '1'],
    help: 'Enter fast and let the bike slide out wide before the apex: the line drifts toward the outside on the entry (back on the apex at the apex), the sliding tyre scrubs speed (≈ 0.15 × lateral g at max) so the braking ends later and more speed is carried in, and the lateral grip may run a few % over while sliding. 0 = off.',
    format: (v) => (v <= 0 ? 'off' : v.toFixed(2)),
  },
  {
    key: 'latScale',
    label: 'Corner grip',
    step: 0.01,
    help: 'Lateral g the rider uses in this corner\'s zone, × the fitted rider\'s (corner speed at the same line).',
    format: pct,
  },
  {
    key: 'rollOnS',
    label: 'Roll-on',
    step: 0.05,
    help: 'Throttle roll-on after the apex: the drive reaches 90 % after this many seconds (0 = full drive at the apex).',
    format: (v) => `${v.toFixed(2)} s`,
  },
  {
    key: 'exitScale',
    label: 'Exit drive',
    step: 0.01,
    help: 'Drive g from the apex to the end of the corner\'s zone, ×. Power, wheelie and the tyre still limit it.',
    format: pct,
  },
  {
    key: 'runScale',
    label: 'Straight drive',
    step: 0.01,
    help: 'Drive g on the run after the exit to the next corner, ×.',
    format: pct,
  },
];

/** Lap picker + Fit button + progress/status, for the sim panel's mode bar. */
export function FitControls() {
  const sessions = useLab((s) => s.sessions);
  const refLap = useLab((s) => s.refLap);
  const fitRefLap = useLab((s) => s.fitRefLap);
  const setFitRefLap = useLab((s) => s.setFitRefLap);
  const runFit = useLab((s) => s.runFit);
  const busy = useLab((s) => s.fitBusy);
  const progress = useLab((s) => s.fitProgress);
  const simFit = useLab((s) => s.simFit);
  const track = useLab((s) => activeTrack(s));

  const options = useMemo(() => {
    const out: Array<{ value: string; label: string }> = [];
    for (const s of sessions) {
      if (s.isSim) continue;
      for (const l of s.laps) {
        if ((!s.reference && l.kind !== 'flying') || lapReferenceProblem(s, l, track)) continue;
        out.push({ value: `${s.id}|${l.n}`, label: `${s.name} · L${l.n} · ${fmtLapTime(l.timeS)}${s.reference ? ' (corner summary)' : ''}${l.isBest ? ' ★' : ''}` });
      }
    }
    return out;
  }, [sessions, track]);
  const pick = fitReferenceLap({ sessions, refLap, fitRefLap }, track);
  const value = fitRefLap ? `${fitRefLap.sessionId}|${fitRefLap.lap}` : '';

  return (
    <>
      <select
        className="sim-fit-ref"
        data-testid="sim-fit-ref"
        value={value}
        title="The lap the rider is fitted to: any loaded lap with GPS (its own line is the fit's line), or a lap file with a corner summary"
        onChange={(e) => {
          const [sid, n] = e.target.value.split('|');
          setFitRefLap(e.target.value ? { sessionId: sid, lap: Number(n) } : undefined);
        }}
      >
        <option value="">Auto{pick ? `: ${pick.session.name} · L${pick.lap.n}` : ' (no usable lap)'}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <button
        className="btn primary"
        data-testid="sim-fit-run"
        disabled={!pick || busy}
        title={pick ? `Fit the rider to ${pick.session.name} lap ${pick.lap.n}: line, longitudinal g and speed in every corner (≤ 30 s)` : 'Open a lap with GPS on a track with turns, or a lap JSON with a corner summary (viraj_ozeti)'}
        onClick={() => void runFit(fitRunner)}
      >
        {busy ? 'Fitting…' : 'Fit'}
      </button>
      {busy && (
        <span className="sim-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={Math.round((progress?.frac ?? 0) * 100)} data-testid="sim-fit-progress">
          <span style={{ width: `${Math.round((progress?.frac ?? 0) * 100)}%` }} />
        </span>
      )}
      <span className="sim-fit-status num" data-testid="sim-fit-status" role="status">
        {busy
          ? `${progress?.stage ?? ''}${progress?.error != null ? ` · error ${progress.error.toFixed(1)}` : ''}`
          : simFit
            ? `Fit: ${simFit.refName} ${fmtLapTime(simFit.lapTimeS)} · ref ${fmtLapTime(simFit.refLapTimeS)} (${fmtDelta(simFit.lapTimeS - simFit.refLapTimeS)})`
            : pick
              ? `Reference: ${pick.session.name} · L${pick.lap.n}`
              : 'No reference lap loaded'}
      </span>
    </>
  );
}

/** Corner bar, the selected corner's sliders, and the per-corner table. */
export function FitCornerPanel() {
  const simFit = useLab((s) => s.simFit);
  const model = useLab((s) => s.fitModel);
  const settings = useLab((s) => s.fitSettings);
  const sel = useLab((s) => s.fitCorner);
  const setSel = useLab((s) => s.setFitCorner);
  const setCornerSetting = useLab((s) => s.setCornerSetting);
  const resetCorner = useLab((s) => s.resetCornerSettings);

  // debounced store updates (each one re-rides the lap and refreshes the workspace)
  const pending = useRef<{ k: number; patch: Partial<CornerSetting> } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const change = useCallback(
    (k: number, patch: Partial<CornerSetting>) => {
      pending.current = pending.current && pending.current.k === k ? { k, patch: { ...pending.current.patch, ...patch } } : { k, patch };
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        const p = pending.current;
        pending.current = null;
        if (p) setCornerSetting(p.k, p.patch);
      }, DEBOUNCE_MS);
    },
    [setCornerSetting],
  );
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  // a corner picked on the map: bring its editor (and its table row) into view
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (sel == null) return;
    leftRef.current?.scrollIntoView({ block: 'nearest' });
    rightRef.current?.querySelector('tr.sel')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  if (!simFit || !model || !settings) return null;
  const K = model.corners.length;
  const k = sel != null && sel >= 0 && sel < K ? sel : null;
  const cur = k != null ? settings[k] : null;
  const fitted = k != null ? model.fitted[k] : null;
  const row = k != null ? simFit.rows[k] : null;
  const changed = (j: number): boolean => JSON.stringify(settings[j]) !== JSON.stringify(model.fitted[j]);

  const chips = (
    <div className="sim-fit-corners" role="listbox" aria-label="Corners" data-testid="sim-fit-corners">
      {model.corners.map((c, j) => {
        const r = simFit.rows[j];
        return (
          <button
            key={c.name + j}
            role="option"
            aria-selected={j === k}
            className={`sim-fit-chip${j === k ? ' sel' : ''}${changed(j) ? ' tuned' : ''}${r && r.vRmsKmh > 3 ? ' warn' : ''}`}
            data-testid={`sim-fit-chip-${j}`}
            title={r ? `${c.name} ${c.dir > 0 ? 'left' : 'right'}: apex ${r.apexSimKmh.toFixed(1)} vs ref ${r.apexRefKmh.toFixed(1)} km/h, speed error ${r.vRmsKmh.toFixed(1)} km/h rms${settings[j].slideOut > 0 ? ` · slide out ${settings[j].slideOut.toFixed(2)}` : ''}${changed(j) ? ' · tuned' : ''}` : c.name}
            onClick={() => setSel(j === k ? null : j)}
          >
            {c.name}
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="sim-fit" data-testid="sim-fit">
      <div className="sim-fit-left" ref={leftRef}>
        {k != null && cur && fitted && row ? (
          <div className="sim-fit-editor" data-testid="sim-fit-editor">
            <div className="sim-fit-editor-head">
              <button className="btn" aria-label="Previous corner" data-testid="sim-fit-prev" onClick={() => setSel((k - 1 + K) % K)}>◀</button>
              <strong className="sim-fit-corner-name" data-testid="sim-fit-corner-name">
                {model.corners[k].name} {model.corners[k].dir > 0 ? 'L' : 'R'}
              </strong>
              <button className="btn" aria-label="Next corner" data-testid="sim-fit-next" onClick={() => setSel((k + 1) % K)}>▶</button>
              <span className="bp-spacer" />
              <button className="btn" data-testid="sim-fit-reset-corner" disabled={!changed(k)} title="Back to the fitted values for this corner" onClick={() => resetCorner(k)}>
                Reset corner
              </button>
            </div>
            <div className="sim-fit-editor-stats num">
              apex {row.apexSimKmh.toFixed(1)} / ref {row.apexRefKmh.toFixed(1)} km/h · v ±{row.vRmsKmh.toFixed(1)} km/h · a ±{row.aRmsG.toFixed(2)} g · {row.aLatPeakG.toFixed(2)} g
            </div>
            {SLIDERS.map((d) => {
              const [lo, hi] = SETTING_BOUNDS[d.key];
              const ctx = { vMinRefKmh: model.corners[k].vMinRefMs * 3.6 };
              const moved = Math.abs(cur[d.key] - fitted[d.key]) > 1e-9;
              return (
                <label key={d.key} className={`sim-slider sim-fit-slider${moved ? ' moved' : ''}`} title={`${d.help}\nFitted: ${d.format(fitted[d.key], ctx)}`}>
                  <span className="sim-slider-label">{d.label}</span>
                  <span className="sim-fit-range">
                    <span className="sim-fit-end" aria-hidden="true">{d.ends?.[0]}</span>
                    <RangeInput
                      min={lo}
                      max={hi}
                      step={d.step}
                      value={cur[d.key]}
                      testId={`sim-fit-${d.key}`}
                      format={(v) => d.format(v, ctx)}
                      onChange={(v) => change(k, { [d.key]: v })}
                    />
                    <span className="sim-fit-end" aria-hidden="true">{d.ends?.[1]}</span>
                  </span>
                </label>
              );
            })}
            <label className="sim-fit-check" title="Where the reference neither braked nor drove before the apex, the fitted rider coasts there too. Off: brakes and drives as late as the caps allow.">
              <input type="checkbox" checked={cur.coast} data-testid="sim-fit-coast" onChange={(e) => change(k, { coast: e.target.checked })} />
              Coast before the apex (as the reference)
            </label>
          </div>
        ) : (
          <p className="sim-fit-hint" data-testid="sim-fit-hint">Pick a corner on the map (its apex or zone on the fitted line) or on the right to set it.</p>
        )}
      </div>

      <div className="sim-fit-right" ref={rightRef}>
        {chips}
        <table className="sim-fit-table" data-testid="sim-fit-table">
          <thead>
            <tr>
              <th>Corner</th>
              <th title="Reference apex speed on the fit's line">Apex ref</th>
              <th title="Fitted rider's apex speed">Apex sim</th>
              <th>Δ</th>
              <th title="RMS speed error over the corner's stretch (approach, apex, exit)">v rms</th>
              <th title="RMS longitudinal-g error over the corner's stretch">a rms</th>
              <th title="Peak lateral g in the zone">Lat g</th>
              <th title="Lean the peak lateral g needs (ideal lean)">Lean °</th>
              <th title="Slide out on the entry (0 = off)">Slide</th>
              <th title={`Margin to the preset's lateral ceiling min(μ, tan(maxLean·leanUsage)) = ${simFit.ceilingG.toFixed(2)} g (${simFit.ceilingLeanDeg.toFixed(1)}°)`}>Margin %</th>
            </tr>
          </thead>
          <tbody>
            {simFit.rows.map((r, j) => {
              const d = r.apexSimKmh - r.apexRefKmh;
              return (
                <tr
                  key={r.name + j}
                  className={`${r.marginPct < 0 ? 'over' : r.marginPct < 10 ? 'near' : ''}${j === k ? ' sel' : ''}`}
                  onClick={() => setSel(j)}
                >
                  <td>{r.name} {r.dir > 0 ? 'L' : 'R'}{changed(j) ? ' •' : ''}</td>
                  <td className="num">{r.apexRefKmh.toFixed(1)}</td>
                  <td className="num">{r.apexSimKmh.toFixed(1)}</td>
                  <td className="num">{d >= 0 ? '+' : ''}{d.toFixed(1)}</td>
                  <td className="num">{r.vRmsKmh.toFixed(1)}</td>
                  <td className="num">{r.aRmsG.toFixed(2)}</td>
                  <td className="num">{r.aLatPeakG.toFixed(2)}</td>
                  <td className="num">{r.leanDeg.toFixed(1)}</td>
                  <td className="num" data-testid={`sim-fit-slide-${j}`}>{settings[j].slideOut > 0 ? settings[j].slideOut.toFixed(2) : '–'}</td>
                  <td className="num">{r.marginPct.toFixed(0)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="sim-fit-note">
          {simFit.pathTrusted ? 'Line: the reference lap\'s own GPS path.' : 'Line: the rider\'s line, its C↔V style fitted per corner (the reference\'s path is not measured).'} The reference speed ridden on this line: {fmtLapTime(simFit.alignedRefLapS)}. Fit error {simFit.stats.errorBefore.toFixed(1)} → {simFit.stats.errorAfter.toFixed(1)} in {simFit.stats.refineRounds} rounds ({simFit.stats.refineSolves} solves, {(simFit.stats.ms / 1000).toFixed(1)} s).{' '}
          <button className="linkish" data-testid="sim-fit-reset-all" onClick={() => resetCorner()}>Reset all corners</button>
        </p>
      </div>
    </div>
  );
}
