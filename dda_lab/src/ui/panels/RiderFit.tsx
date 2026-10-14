// "Fit to lap" in the Rider mode (spec 2026-10-14): fit the virtual rider's
// own parameters to a ridden lap, then move the same sliders — lap-wide above,
// per corner here — to see what the owner's riding could gain.
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { activeTrack, riderFitLap, useLab } from '../../state/store';
import { lapReferenceProblem } from '../../sim/lapReference';
import { CORNER_RIDER_KEYS, type CornerRiderKey } from '../../sim/cornerRider';
import type { RiderParams } from '../../sim/types';
import { CORNER_SLIDERS } from './riderSliders';
import { RangeInput } from './RangeInput';

const DEBOUNCE_MS = 30;

/** The lap-wide value of a corner key (slide out defaults to off). */
export function lapWideValue(rider: RiderParams, key: CornerRiderKey): number {
  if (key === 'slideOut') return rider.slideOut ?? 0;
  return (rider as unknown as Record<string, number>)[key];
}

/** What the rider uses in corner n: its override, else the lap-wide value. */
export function effectiveCornerValue(rider: RiderParams, n: number, key: CornerRiderKey): number {
  return rider.corners?.[n]?.[key] ?? lapWideValue(rider, key);
}

const sign = (d: number, digits: number): string => `${d >= 0 ? '+' : ''}${d.toFixed(digits)}`;

/** Lap picker + Run + status, at the top of the Rider fieldset. */
export function FitToLapRow() {
  const sessions = useLab((s) => s.sessions);
  const refLap = useLab((s) => s.refLap);
  const riderFit = useLab((s) => s.riderFit);
  const setFitRefLap = useLab((s) => s.setFitRefLap);
  const runRiderFit = useLab((s) => s.runRiderFit);
  const resetRiderToFit = useLab((s) => s.resetRiderToFit);
  const track = useLab((s) => activeTrack(s));

  const options = useMemo(() => {
    const out: Array<{ value: string; label: string; problem: string | null }> = [];
    for (const s of sessions) {
      if (s.isSim) continue;
      for (const l of s.laps) {
        if (!s.reference && l.kind !== 'flying') continue;
        out.push({ value: `${s.id}|${l.n}`, label: `${s.name} · L${l.n}`, problem: lapReferenceProblem(s, l, track) });
      }
    }
    return out;
  }, [sessions, track]);
  const pick = riderFitLap({ sessions, refLap, riderFit }, track);
  const value = riderFit.refLap ? `${riderFit.refLap.sessionId}|${riderFit.refLap.lapN}` : '';
  const { busy, progress, ref, lapTimeS } = riderFit;

  let status: string;
  if (ref && lapTimeS != null) {
    status = `You ${ref.refLapTimeS.toFixed(2)} · Virtual you ${lapTimeS.toFixed(1)} (${sign(lapTimeS - ref.refLapTimeS, 1)})`;
  } else if (pick) {
    status = `Lap: ${pick.session.name} · L${pick.lap.n}`;
  } else {
    status = 'No usable lap loaded';
  }

  return (
    <div className="sim-fit-row">
      <span className="sim-slider-label" title="Fit the virtual rider's own parameters (Aggressiveness, Risk, the derived values and every corner) to a ridden lap: speed first, then longitudinal g and the line.">
        Fit to lap
      </span>
      <select
        className="sim-fit-ref"
        data-testid="sim-fit-ref"
        value={value}
        title="The lap the rider is fitted to"
        onChange={(e) => {
          const [sid, n] = e.target.value.split('|');
          if (e.target.value) setFitRefLap(sid, Number(n));
        }}
      >
        <option value="" disabled={!!riderFit.refLap}>Auto{pick ? `: ${pick.session.name} · L${pick.lap.n}` : ''}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={!!o.problem} title={o.problem ?? undefined}>
            {o.label}
          </option>
        ))}
      </select>
      <button
        className="btn primary"
        data-testid="sim-fit-run"
        disabled={busy || !pick}
        title={pick ? `Fit the rider to ${pick.session.name} lap ${pick.lap.n} (≤ 30 s in the background)` : 'Open a recorded lap with GPS on a track with turns'}
        onClick={() => void runRiderFit()}
      >
        {busy ? `${progress?.stage ?? 'Fitting'} ${Math.round((progress?.frac ?? 0) * 100)} %` : 'Run'}
      </button>
      {busy && (
        <span className="sim-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={Math.round((progress?.frac ?? 0) * 100)} data-testid="sim-fit-progress">
          <span style={{ width: `${Math.round((progress?.frac ?? 0) * 100)}%` }} />
        </span>
      )}
      <span className="sim-fit-status num" data-testid="sim-fit-status" role="status"
        title={riderFit.refOnLineS != null ? `Your speed ridden on the rider's line: ${riderFit.refOnLineS.toFixed(2)} s` : undefined}>
        {status}
      </span>
      {riderFit.fittedRider && !busy && (
        <button className="linkish" data-testid="sim-fit-reset" title="Every rider slider (lap-wide and per corner) back to the fitted values" onClick={resetRiderToFit}>
          Back to fit
        </button>
      )}
      {riderFit.error && (
        <span className="sim-fit-error" data-testid="sim-fit-error" role="alert">{riderFit.error}</span>
      )}
    </div>
  );
}

/** Corner chips, the selected corner's sliders and the fit table, below the advanced panel. */
export function CornerSection() {
  const track = useLab((s) => activeTrack(s));
  const rider = useLab((s) => s.simParams.rider);
  const rows = useLab((s) => s.riderFit.rows);
  const fitted = useLab((s) => s.riderFit.fittedRider);
  const sel = useLab((s) => s.fitCorner);
  const setSel = useLab((s) => s.setFitCorner);
  const setCornerRider = useLab((s) => s.setCornerRider);
  const clearKey = useLab((s) => s.clearCornerRiderKey);
  const clearCorner = useLab((s) => s.clearCornerRider);

  // debounced store updates: each one re-rides the lap
  const pending = useRef<{ n: number; patch: Partial<Record<CornerRiderKey, number>> } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const p = pending.current;
    pending.current = null;
    if (p) setCornerRider(p.n, p.patch);
  }, [setCornerRider]);
  const change = useCallback(
    (n: number, patch: Partial<Record<CornerRiderKey, number>>) => {
      if (pending.current && pending.current.n !== n) flush();
      pending.current = { n, patch: { ...pending.current?.patch, ...patch } };
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, DEBOUNCE_MS);
    },
    [flush],
  );
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const editorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (sel != null) editorRef.current?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const turns = track?.turns ?? [];
  if (!turns.length) return null;
  const rowOf = new Map(rows.map((r) => [r.n, r]));
  const turn = sel != null ? turns.find((t) => t.n === sel) : undefined;
  const overrides = turn ? (rider.corners?.[turn.n] ?? {}) : {};
  const hasOverride = (n: number): boolean => Object.keys(rider.corners?.[n] ?? {}).length > 0;
  const differsFromFit = (n: number): boolean =>
    JSON.stringify(rider.corners?.[n] ?? {}) !== JSON.stringify(fitted?.corners?.[n] ?? {});
  const row = turn ? rowOf.get(turn.n) : undefined;

  return (
    <div className="sim-corners" data-testid="sim-corners">
      <div className="sim-corners-head">
        <span className="sim-slider-label">Corners</span>
        <span className="bp-spacer" />
        <button className="linkish" data-testid="sim-corners-reset"
          title={fitted ? 'Every corner back to its fitted values' : 'Drop every corner override'}
          onClick={() => clearCorner()}>
          Reset all corners
        </button>
      </div>
      <div className="sim-fit-corners" role="listbox" aria-label="Corners">
        {turns.map((t) => {
          const r = rowOf.get(t.n);
          return (
            <button
              key={t.n}
              role="option"
              aria-selected={t.n === sel}
              className={`sim-fit-chip${t.n === sel ? ' sel' : ''}${r ? ` grade-${r.grade}` : ''}`}
              data-testid={`sim-corner-chip-${t.n}`}
              title={r ? `${t.name}: apex ${r.apexSimKmh.toFixed(1)} vs you ${r.apexRefKmh.toFixed(1)} km/h · v ±${r.vRmsKmh.toFixed(1)} km/h (${r.grade})` : t.name}
              onClick={() => setSel(t.n === sel ? null : t.n)}
            >
              {t.name}
              {hasOverride(t.n) && <span className="sim-corner-dot" aria-label="has corner values" />}
            </button>
          );
        })}
      </div>

      {turn && (
        <div className="sim-corner-editor" data-testid="sim-corner-editor" ref={editorRef}>
          <div className="sim-fit-editor-head">
            <strong className="sim-fit-corner-name" data-testid="sim-corner-name">{turn.name} {turn.dir}</strong>
            {row && (
              <span className="sim-fit-editor-stats num">
                apex {row.apexSimKmh.toFixed(1)} / you {row.apexRefKmh.toFixed(1)} km/h · v ±{row.vRmsKmh.toFixed(1)} · a ±{row.aRmsG.toFixed(2)} g
              </span>
            )}
            <span className="bp-spacer" />
            <button className="btn" data-testid="sim-corner-reset" disabled={!differsFromFit(turn.n)}
              title={fitted ? 'This corner back to its fitted values' : 'Drop this corner\'s values (lap-wide again)'}
              onClick={() => clearCorner(turn.n)}>
              Reset corner
            </button>
          </div>
          {CORNER_RIDER_KEYS.map((key) => {
            const meta = CORNER_SLIDERS[key];
            const isSet = overrides[key] !== undefined;
            return (
              <div key={key} className={`sim-adv-row${isSet ? ' pinned' : ''}`} title={meta.help}>
                <button
                  type="button"
                  className={`sim-lock${isSet ? ' pinned' : ''}`}
                  data-testid={`sim-corner-clear-${key}`}
                  disabled={!isSet}
                  aria-label={isSet ? `${meta.label}: this corner's own value, click for the lap-wide value` : `${meta.label}: lap-wide value`}
                  title={isSet ? `This corner's own value — click to use the lap-wide ${lapWideValue(rider, key).toFixed(meta.decimals ?? 2)}` : 'Lap-wide value — move the slider to set this corner'}
                  onClick={() => clearKey(turn.n, key)}
                >
                  {isSet ? '●' : '○'}
                </button>
                <span className="sim-slider-label">{meta.label}</span>
                <RangeInput min={meta.min} max={meta.max} step={meta.step}
                  value={effectiveCornerValue(rider, turn.n, key)}
                  unit={meta.unit} decimals={meta.decimals ?? 2} testId={`sim-corner-${key}`}
                  onChange={(v) => change(turn.n, { [key]: v })} />
              </div>
            );
          })}
        </div>
      )}

      {rows.length > 0 && (
        <table className="sim-fit-table" data-testid="sim-fit-table">
          <thead>
            <tr>
              <th>Corner</th>
              <th title="Your apex speed">Apex ref</th>
              <th title="The virtual rider's apex speed">Apex sim</th>
              <th title="RMS speed error over the corner's stretch, km/h">v rms</th>
              <th title="RMS longitudinal-g error over the corner's stretch">a rms</th>
              <th title="RMS line offset from your GPS path, m (– when the path is not measured)">Line rms</th>
              <th title="Peak lateral g in the zone">Lat g</th>
              <th>Grade</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.n} className={`grade-${r.grade}${r.n === sel ? ' sel' : ''}`} onClick={() => setSel(r.n)}>
                <td>{r.name}{hasOverride(r.n) ? ' •' : ''}</td>
                <td className="num">{r.apexRefKmh.toFixed(1)}</td>
                <td className="num">{r.apexSimKmh.toFixed(1)}</td>
                <td className="num">{r.vRmsKmh.toFixed(1)}</td>
                <td className="num">{r.aRmsG.toFixed(2)}</td>
                <td className="num">{r.lineRmsM != null ? r.lineRmsM.toFixed(1) : '–'}</td>
                <td className="num">{r.latPeakG.toFixed(2)}</td>
                <td className="sim-grade">{r.grade}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
