import { useCallback, useEffect, useRef, useState } from 'react';
import { useLab, type OptimalMode } from '../../state/store';
import { DERIVED_KEYS } from '../../sim/derive';
import { MACHINE_PRESETS } from '../../sim/presets';
import type { DerivedRiderKey, SimParams, SolverMode } from '../../sim/types';
import { fmtDelta, fmtLapTime } from '../../state/selectors';
import { optimalAvailability, optimalRunner, type Availability } from './simRunners';
import { rangeValue } from './simRange';
import './SimPanel.css';

type SimPatch = { machine?: Partial<SimParams['machine']>; tyre?: Partial<SimParams['tyre']>; rider?: Partial<SimParams['rider']> };

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  decimals?: number;
  testId: string;
  /** One sentence saying what the slider means, shown as a tooltip. */
  help?: string;
  onChange: (v: number) => void;
}

interface RangeProps {
  value: number;
  min: number;
  max: number;
  step: number;
  testId: string;
  unit?: string;
  decimals?: number;
  onChange: (v: number) => void;
}

/**
 * A range input that follows the user immediately. The store update behind it
 * is debounced, and React restores a controlled input to its prop after every
 * change event — so bound straight to the store, each arrow-key press started
 * again from the stale value and twenty presses moved it one step. The local
 * value carries the edit (thumb AND readout) until the store catches up, then
 * the prop wins again.
 */
function RangeInput({ value, min, max, step, testId, unit, decimals = 2, onChange }: RangeProps) {
  const [local, setLocal] = useState<number | null>(null);
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    // the store moved (debounce flushed, or a slider elsewhere re-derived it)
    setSeen(value);
    setLocal(null);
  }
  const shown = local ?? value;
  return (
    <>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={rangeValue(shown, min, max, step)}
        data-testid={testId}
        onChange={(e) => {
          const v = Number(e.target.value);
          setLocal(v);
          onChange(v);
        }}
      />
      <span className="sim-slider-value num">
        {shown.toFixed(decimals)}
        {unit ? ` ${unit}` : ''}
      </span>
    </>
  );
}

function Slider({ label, value, min, max, step, unit, decimals = 2, testId, help, onChange }: SliderProps) {
  return (
    <label className="sim-slider" title={help}>
      <span className="sim-slider-label">{label}</span>
      <RangeInput value={value} min={min} max={max} step={step} unit={unit} decimals={decimals} testId={testId} onChange={onChange} />
    </label>
  );
}

/** Slider range, unit and help for every derived rider key (advanced panel). */
const ADVANCED: Record<DerivedRiderKey, { label: string; min: number; max: number; step: number; unit?: string; decimals?: number; help: string }> = {
  sBrake: { label: 'Brake slip', min: 0.1, max: 1, step: 0.01, help: 'Front-tyre slip the rider allows on the brakes, as a fraction of the slip at peak grip (Risk).' },
  sDrive: { label: 'Drive slip', min: 0.1, max: 1, step: 0.01, help: 'Rear-tyre slip the rider allows on the way out (Risk).' },
  sLat: { label: 'Lateral slip', min: 0.1, max: 1, step: 0.01, help: 'Side slip the rider allows at lean (Risk).' },
  brakingG: { label: 'Braking', min: 0.2, max: 1.8, step: 0.01, unit: 'g', help: 'Peak braking asked of the FRONT TYRE: μx · grip(brake slip). Aero and rolling losses add to it on the charts.' },
  brakeRiseGps: { label: 'Brake build', min: 0.5, max: 8, step: 0.1, unit: 'g/s', decimals: 1, help: 'How fast braking builds once the lever moves (Aggressiveness). Both reference Serres laps build at about 2.8 g/s.' },
  throttleDelayS: { label: 'Throttle delay', min: 0, max: 2, step: 0.01, unit: 's', help: 'Time from the apex to picking up the throttle (Aggressiveness).' },
  rollOnS: { label: 'Roll-on', min: 0.1, max: 3, step: 0.01, unit: 's', help: 'Throttle 20 → 90 % time (Aggressiveness).' },
  rollRateFrac: { label: 'Roll rate', min: 0.1, max: 1, step: 0.01, help: 'Share of the Biniewicz roll-rate bound the rider uses when flicking the bike (Aggressiveness).' },
  trailBrakeDepth: { label: 'Trail depth', min: 0, max: 1, step: 0.01, help: 'How deep into the corner the brakes are carried. 0 = off before the bike leans; 1 = on at full lean (Risk).' },
  trailBrakeProfile: { label: 'Trail at lean', min: 0, max: 1, step: 0.01, help: 'How hard the rider brakes once leaned. 0 = timid, 1 = nearly all the grip left (Risk).' },
  leanUsage: { label: 'Lean usage', min: 0.5, max: 1, step: 0.01, help: 'Share of the tyre lean limit the rider uses: grip(lateral slip) (Risk).' },
  tcThreshold: { label: 'Traction control', min: 0, max: 1, step: 0.01, help: 'Slip traction control allows before cutting torque.' },
};

const MODES: Array<{ mode: SolverMode; label: string; help: string }> = [
  { mode: 'rider', label: 'Sürücü', help: 'Human rider driven by Aggressiveness and Risk. Live on every slider.' },
  { mode: 'freeTrajectory', label: 'Serbest yörünge', help: 'Line and speed optimised together for the ideal rider. Runs in the background on "Hesapla".' },
  { mode: 'ocp', label: 'Tam OCP', help: 'Full minimum-time optimal control, solved by the DDA Lab bridge on THIS computer (seconds on Serres). Runs on "Hesapla".' },
];

function LockIcon({ locked }: { locked: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3" y="7" width="10" height="8" rx="1.5" fill="currentColor" />
      <path
        d={locked ? 'M5 7V5a3 3 0 0 1 6 0v2' : 'M5 7V5a3 3 0 0 1 6 0'}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        transform={locked ? undefined : 'translate(3 -1)'}
      />
    </svg>
  );
}

/** Debounce window for slider-driven re-simulation (ms). simulate() itself costs ~3.3 ms;
 * the debounce exists so a fast drag — which can fire an 'input' event every couple of
 * milliseconds — coalesces into at most one re-solve per DEBOUNCE_MS, rather than one per tick. */
const DEBOUNCE_MS = 30;

export default function SimPanel() {
  const corridor = useLab((s) => s.corridor);
  const busy = useLab((s) => s.corridorBusy);
  const extract = useLab((s) => s.extractCorridorNow);
  const publishCorridor = useLab((s) => s.publishCorridor);
  const exportCorridorJson = useLab((s) => s.exportCorridorJson);
  const importCorridorJson = useLab((s) => s.importCorridorJson);
  const corridorFileRef = useRef<HTMLInputElement>(null);
  const corridorToken = useLab((s) => s.corridorToken);
  const setCorridorToken = useLab((s) => s.setCorridorToken);
  const params = useLab((s) => s.simParams);
  const enabled = useLab((s) => s.simEnabled);
  const lapTimeS = useLab((s) => s.simLapTimeS);
  const corners = useLab((s) => s.simCorners);
  const risk = useLab((s) => s.simRisk);
  const solverMode = useLab((s) => s.solverMode);
  const optBusy = useLab((s) => s.simOptBusy);
  const optProgress = useLab((s) => s.simOptProgress);
  const optLap = useLab((s) => s.simOptLapTimeS);
  const optStale = useLab((s) => s.simOptStale);
  const setSimEnabled = useLab((s) => s.setSimEnabled);
  const setSimParams = useLab((s) => s.setSimParams);
  const clearOverride = useLab((s) => s.clearOverride);
  const setSolverMode = useLab((s) => s.setSolverMode);
  const runOptimal = useLab((s) => s.runOptimal);
  const applyPreset = useLab((s) => s.applyMachinePreset);
  const workspace = useLab((s) => s.workspace);
  const setWorkspace = useLab((s) => s.setWorkspace);

  // Debounced wrapper around setSimParams: slider drags call this on every tick, but the
  // (relatively) expensive re-solve + refreshAll() only runs DEBOUNCE_MS after the last tick.
  const pendingRef = useRef<SimPatch | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedSetSimParams = useCallback(
    (patch: SimPatch) => {
      pendingRef.current = {
        machine: { ...pendingRef.current?.machine, ...patch.machine },
        tyre: { ...pendingRef.current?.tyre, ...patch.tyre },
        rider: { ...pendingRef.current?.rider, ...patch.rider },
      };
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        const p = pendingRef.current;
        pendingRef.current = null;
        if (p) setSimParams(p);
      }, DEBOUNCE_MS);
    },
    [setSimParams],
  );
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  // which optimal modes can run here (worker present, bridge reachable)
  const [avail, setAvail] = useState<Record<OptimalMode, Availability>>({
    freeTrajectory: { ok: false, reason: 'Checking…' },
    ocp: { ok: false, reason: 'Checking…' },
  });
  useEffect(() => {
    let live = true;
    void Promise.all([optimalAvailability('freeTrajectory'), optimalAvailability('ocp')]).then(([ft, ocp]) => {
      if (live) setAvail({ freeTrajectory: ft, ocp });
    });
    return () => {
      live = false;
    };
  }, []);

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

  const brakeCount = corners?.filter((c) => c.hasBrake).length ?? 0;
  const optimal = solverMode === 'rider' ? null : solverMode;
  const pinned = new Set(params.rider.overrides);
  const hesapla = () => {
    if (!optimal) return;
    const runner = optimalRunner(optimal);
    if (runner) void runOptimal(optimal, runner);
  };

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
        {enabled && corners && (
          <span className="sim-counts" data-testid="sim-corner-count" title="Corner sections found on the rider lap, and how many of them are braked for">
            {corners.length} corners · {brakeCount} brake
          </span>
        )}
        <span className="bp-spacer" />
        <button data-testid="sim-extract" disabled={busy} onClick={() => void extract()}>
          {busy ? 'Extracting…' : 'Extract corridor'}
        </button>
        {corridor && (
          <span className="panel-note num" data-testid="sim-corridor-stats">
            {resolved} % · {medianWidth.toFixed(1)} m wide
          </span>
        )}
        <button
          data-testid="sim-publish"
          disabled={busy || !corridor}
          title="Save the current corridor to the bridge (a local bridge needs no token)"
          onClick={() => void publishCorridor()}
        >
          Save
        </button>
        <button
          data-testid="sim-corridor-export"
          disabled={!corridor}
          title="Download the corridor as JSON"
          onClick={() => {
            const text = exportCorridorJson();
            if (!text) return;
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
            a.download = 'corridor.json';
            a.click();
            URL.revokeObjectURL(a.href);
          }}
        >
          ⤓ JSON
        </button>
        <button data-testid="sim-corridor-import" title="Import a corridor JSON for the loaded circuit" onClick={() => corridorFileRef.current?.click()}>
          ⤒ JSON
        </button>
        <input
          ref={corridorFileRef}
          type="file"
          accept=".json,application/json"
          hidden
          data-testid="sim-corridor-file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void f.text().then((t) => importCorridorJson(t));
          }}
        />
        <input
          type="password"
          className="sim-token"
          placeholder="Publish token"
          title="Set to store a newly extracted corridor on the server for everyone. Reading never needs it."
          value={corridorToken}
          data-testid="sim-token"
          onChange={(e) => setCorridorToken(e.target.value)}
        />
        {layer('corridor', 'Corridor')}
        {layer('idealLine', 'Line')}
      </div>

      <div className="sim-modebar">
        <div className="seg" role="radiogroup" aria-label="Solver mode" data-testid="sim-mode">
          {MODES.map(({ mode, label, help }) => {
            const a = mode === 'rider' ? { ok: true } : avail[mode];
            return (
              <button
                key={mode}
                role="radio"
                aria-checked={solverMode === mode}
                className={solverMode === mode ? 'on' : ''}
                disabled={!a.ok}
                title={a.ok ? help : a.reason}
                data-testid={`sim-mode-${mode}`}
                onClick={() => setSolverMode(mode)}
              >
                {label}
              </button>
            );
          })}
        </div>
        {optimal && (
          <>
            <button
              className="btn primary"
              data-testid="sim-hesapla"
              disabled={optBusy[optimal] || !avail[optimal].ok}
              title={avail[optimal].ok ? 'Run the optimal solver for the current machine and tyre' : avail[optimal].reason}
              onClick={hesapla}
            >
              {optBusy[optimal] ? 'Hesaplanıyor…' : 'Hesapla'}
            </button>
            <span className="sim-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100}
              aria-valuenow={Math.round(optProgress[optimal] * 100)} data-testid="sim-progress">
              <span style={{ width: `${Math.round(optProgress[optimal] * 100)}%` }} />
            </span>
          </>
        )}
        {(['freeTrajectory', 'ocp'] as const).map((m) =>
          optLap[m] != null ? (
            <span key={m} className={`sim-opt-time num${optStale[m] ? ' stale' : ''}`} data-testid={`sim-opt-time-${m}`}
              title={optStale[m] ? 'Machine or tyre changed since this was computed — press Hesapla again' : undefined}>
              {m === 'ocp' ? 'OCP' : 'Ideal'} {fmtLapTime(optLap[m]!)}
              {lapTimeS != null ? ` (${fmtDelta(optLap[m]! - lapTimeS)})` : ''}
            </span>
          ) : null,
        )}
      </div>

      {risk && (
        <p className="sim-risk" data-testid="sim-risk" role="status">
          ⚠ {risk}
        </p>
      )}

      <div className="sim-groups">
        <fieldset disabled={optimal !== null}>
          <legend>Rider</legend>
          <div className="sim-top-sliders">
            <Slider label="Aggressiveness" value={params.rider.aggressiveness} min={0} max={1} step={0.01}
              help="How fast the rider makes transitions: roll rate, brake build, throttle pick-up and roll-on. Timing, not force."
              testId="sim-aggressiveness" onChange={(v) => debouncedSetSimParams({ rider: { aggressiveness: v } })} />
            <Slider label="Risk" value={params.rider.risk} min={0} max={1} step={0.01}
              help="How close to the tyre's peak slip the rider goes: braking g, lean and trail braking. Force, not timing."
              testId="sim-risk-slider" onChange={(v) => debouncedSetSimParams({ rider: { risk: v } })} />
          </div>
          {optimal && <p className="sim-ideal-note">Ideal rider: the optimal modes ignore Aggressiveness and Risk.</p>}
          <Slider label="Line style (C↔V)" value={params.rider.kappa} min={0} max={1} step={0.01}
            testId="sim-kappa" onChange={(v) => debouncedSetSimParams({ rider: { kappa: v } })} />
          <Slider label="Line deviation" value={params.rider.lineDeviationM} min={0} max={3} step={0.05} unit="m" decimals={2}
            testId="sim-deviation" onChange={(v) => debouncedSetSimParams({ rider: { lineDeviationM: v } })} />
          <details className="sim-advanced" data-testid="sim-advanced">
            <summary>Gelişmiş — derived values ({pinned.size} pinned)</summary>
            {DERIVED_KEYS.map((key) => {
              const meta = ADVANCED[key];
              const isPinned = pinned.has(key);
              const value = (params.rider as unknown as Record<DerivedRiderKey, number>)[key];
              return (
                <div key={key} className={`sim-adv-row${isPinned ? ' pinned' : ''}`} title={meta.help}>
                  <button
                    type="button"
                    className={`sim-lock${isPinned ? ' pinned' : ''}`}
                    data-testid={`sim-lock-${key}`}
                    aria-label={isPinned ? `${meta.label}: pinned, click to follow the sliders again` : `${meta.label}: derived`}
                    title={isPinned ? 'Pinned by you — click to derive it from Aggressiveness/Risk again' : 'Derived — move the slider to pin it'}
                    onClick={() => isPinned && clearOverride(key)}
                  >
                    <LockIcon locked={isPinned} />
                  </button>
                  <span className="sim-slider-label">{meta.label}</span>
                  <RangeInput min={meta.min} max={meta.max} step={meta.step} value={value}
                    unit={meta.unit} decimals={meta.decimals ?? 2} testId={`sim-adv-${key}`}
                    onChange={(v) => debouncedSetSimParams({ rider: { [key]: v } })} />
                </div>
              );
            })}
          </details>
        </fieldset>

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
            testId="sim-power" onChange={(v) => debouncedSetSimParams({ machine: { powerKw: v, presetId: 'custom' } })} />
          <Slider label="Mass" value={params.machine.massKg} min={120} max={400} step={1} unit="kg" decimals={0}
            help="Bike plus rider and fuel."
            testId="sim-mass" onChange={(v) => debouncedSetSimParams({ machine: { massKg: v, presetId: 'custom' } })} />
          <Slider label="Rider mass" value={params.machine.riderMassKg} min={40} max={150} step={1} unit="kg" decimals={0}
            help="The rider alone (part of Mass). With hang-off it sets how far the combined CG moves inside."
            testId="sim-rider-mass" onChange={(v) => debouncedSetSimParams({ machine: { riderMassKg: v, presetId: 'custom' } })} />
          <Slider label="Drag area" value={params.machine.cdA} min={0.2} max={0.6} step={0.01} unit="m²"
            testId="sim-cda" onChange={(v) => debouncedSetSimParams({ machine: { cdA: v, presetId: 'custom' } })} />
          <Slider label="CG from rear" value={params.machine.cgRearM} min={0.4} max={1.0} step={0.005} unit="m" decimals={3}
            help="Horizontal distance from the rear contact patch to the combined CG. Sets the wheelie (g·b/h) and stoppie (g·(p−b)/h) limits."
            testId="sim-cg-rear" onChange={(v) => debouncedSetSimParams({ machine: { cgRearM: v, presetId: 'custom' } })} />
          <Slider label="Tyre crown" value={params.machine.tyreCrownM} min={0} max={0.12} step={0.005} unit="m" decimals={3}
            help="Tyre section radius. The contact patch rolls round it at lean, so the bike leans further than the ideal angle."
            testId="sim-crown" onChange={(v) => debouncedSetSimParams({ machine: { tyreCrownM: v, presetId: 'custom' } })} />
          <Slider label="Hang-off" value={params.machine.hangOffM} min={0} max={0.4} step={0.01} unit="m"
            help="How far the rider moves their mass inside the bike. Less bike lean for the same corner speed."
            testId="sim-hangoff" onChange={(v) => debouncedSetSimParams({ machine: { hangOffM: v, presetId: 'custom' } })} />
        </fieldset>

        <fieldset>
          <legend>Tyre / track</legend>
          <Slider label="Friction μ" value={params.tyre.mu} min={0.6} max={1.7} step={0.01}
            testId="sim-mu" onChange={(v) => debouncedSetSimParams({ tyre: { mu: v } })} />
          <Slider label="Max lean" value={params.tyre.maxLeanDeg} min={30} max={68} step={0.5} unit="°" decimals={1}
            testId="sim-lean" onChange={(v) => debouncedSetSimParams({ tyre: { maxLeanDeg: v } })} />
          <Slider label="Kerb margin" value={params.tyre.kerbMarginM} min={0} max={2} step={0.1} unit="m" decimals={1}
            testId="sim-kerb" onChange={(v) => debouncedSetSimParams({ tyre: { kerbMarginM: v } })} />
          <Slider label="Grip scale" value={params.tyre.gripScale} min={0.4} max={1.1} step={0.01}
            testId="sim-grip" onChange={(v) => debouncedSetSimParams({ tyre: { gripScale: v } })} />
        </fieldset>
      </div>
    </div>
  );
}
