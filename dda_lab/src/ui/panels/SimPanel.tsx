import { useCallback, useEffect, useRef } from 'react';
import { useLab } from '../../state/store';
import { MACHINE_PRESETS } from '../../sim/presets';
import { gripRiskMessage } from '../../sim/risk';
import type { SimParams } from '../../sim/types';
import { fmtLapTime } from '../../state/selectors';

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

/** Debounce window for slider-driven re-simulation (ms). simulate() itself costs ~3.3 ms;
 * the debounce exists so a fast drag — which can fire an 'input' event every couple of
 * milliseconds — coalesces into at most one re-solve per DEBOUNCE_MS, rather than one per tick. */
const DEBOUNCE_MS = 30;

export default function SimPanel() {
  const corridor = useLab((s) => s.corridor);
  const busy = useLab((s) => s.corridorBusy);
  const extract = useLab((s) => s.extractCorridorNow);
  const corridorToken = useLab((s) => s.corridorToken);
  const setCorridorToken = useLab((s) => s.setCorridorToken);
  const params = useLab((s) => s.simParams);
  const enabled = useLab((s) => s.simEnabled);
  const lapTimeS = useLab((s) => s.simLapTimeS);
  const setSimEnabled = useLab((s) => s.setSimEnabled);
  const setSimParams = useLab((s) => s.setSimParams);
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

  const resolved = corridor
    ? Math.round((100 * corridor.known.filter(Boolean).length) / corridor.known.length)
    : 0;
  const widths = corridor
    ? Array.from(corridor.leftM, (l, i) => l + corridor.rightM[i])
        .filter((_, i) => corridor.known[i])
        .sort((a, b) => a - b)
    : [];
  const medianWidth = widths.length ? widths[widths.length >> 1] : NaN;

  // Warn when the parameter combination asks the tyre for more than it has.
  // The threshold and the wording live in `sim/risk.ts` so they can be measured
  // against real solver output in a node test instead of being guessed here.
  const risk = useLab((s) => gripRiskMessage(s.sessions.find((x) => x.isSim)?.channels.get('grip_use')?.data));

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

      {risk && (
        <p className="sim-risk" data-testid="sim-risk" role="status">
          ⚠ {risk}
        </p>
      )}

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
            testId="sim-power" onChange={(v) => debouncedSetSimParams({ machine: { powerKw: v, presetId: 'custom' } })} />
          <Slider label="Mass" value={params.machine.massKg} min={120} max={400} step={1} unit="kg" decimals={0}
            testId="sim-mass" onChange={(v) => debouncedSetSimParams({ machine: { massKg: v, presetId: 'custom' } })} />
          <Slider label="Drag area" value={params.machine.cdA} min={0.2} max={0.6} step={0.01} unit="m²"
            testId="sim-cda" onChange={(v) => debouncedSetSimParams({ machine: { cdA: v, presetId: 'custom' } })} />
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

        <fieldset>
          <legend>Rider</legend>
          <Slider label="Line deviation" value={params.rider.lineDeviationM} min={0} max={3} step={0.05} unit="m" decimals={2}
            testId="sim-deviation" onChange={(v) => debouncedSetSimParams({ rider: { lineDeviationM: v } })} />
          <Slider label="Braking" value={params.rider.brakingG} min={0.4} max={1.6} step={0.01} unit="g"
            testId="sim-braking" onChange={(v) => debouncedSetSimParams({ rider: { brakingG: v } })} />
          <Slider label="Throttle delay" value={params.rider.throttleDelayS} min={0} max={1.5} step={0.01} unit="s"
            testId="sim-throttle" onChange={(v) => debouncedSetSimParams({ rider: { throttleDelayS: v } })} />
          <Slider label="Traction control" value={params.rider.tcThreshold} min={0} max={1} step={0.01}
            testId="sim-tc" onChange={(v) => debouncedSetSimParams({ rider: { tcThreshold: v } })} />
          <Slider label="Lean usage" value={params.rider.leanUsage} min={0.5} max={1} step={0.01}
            testId="sim-leanusage" onChange={(v) => debouncedSetSimParams({ rider: { leanUsage: v } })} />
          <Slider label="Line style (C↔V)" value={params.rider.kappa} min={0} max={1} step={0.01}
            testId="sim-kappa" onChange={(v) => debouncedSetSimParams({ rider: { kappa: v } })} />
          <Slider label="Trail brake depth" value={params.rider.trailBrakeDepth} min={0} max={1} step={0.01}
            testId="sim-tb-depth" onChange={(v) => debouncedSetSimParams({ rider: { trailBrakeDepth: v } })} />
          <Slider label="Brake release" value={params.rider.trailBrakeProfile} min={0} max={1} step={0.01}
            testId="sim-tb-profile" onChange={(v) => debouncedSetSimParams({ rider: { trailBrakeProfile: v } })} />
        </fieldset>
      </div>
    </div>
  );
}
