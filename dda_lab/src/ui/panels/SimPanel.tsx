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
      <input type="range" min={min} max={max} step={step} value={value} data-testid={testId} onChange={(e) => onChange(Number(e.target.value))} />
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

  const resolved = corridor ? Math.round((100 * corridor.known.filter(Boolean).length) / corridor.known.length) : 0;
  const widths = corridor
    ? Array.from(corridor.leftM, (l, i) => l + corridor.rightM[i]).filter((_, i) => corridor.known[i]).sort((a, b) => a - b)
    : [];
  const medianWidth = widths.length ? widths[widths.length >> 1] : NaN;

  const layer = (key: 'corridor' | 'idealLine', label: string) => (
    <label className="bp-label" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
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
      <div className="bp-row sim-head">
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 700 }}>
          <input type="checkbox" checked={enabled} data-testid="sim-enable" onChange={(e) => setSimEnabled(e.target.checked)} />
          Virtual rider
        </label>
        <span className="sim-laptime num" data-testid="sim-laptime">
          {enabled && lapTimeS != null ? fmtLapTime(lapTimeS) : '—'}
        </span>
        <span className="bp-spacer" style={{ flex: 1 }} />
        <button className="bp-btn" data-testid="sim-extract" disabled={busy} onClick={() => void extract()}>
          {busy ? 'Extracting…' : 'Extract corridor'}
        </button>
        {corridor && (
          <span className="bp-label num" data-testid="sim-corridor-stats">
            {resolved} % · {medianWidth.toFixed(1)} m wide
          </span>
        )}
        <input
          type="password"
          className="bp-input sim-token"
          placeholder="Publish token"
          title="Set to store a newly extracted corridor on the server for everyone. Reading never needs it."
          value={corridorToken}
          data-testid="sim-token"
          onChange={(e) => setCorridorToken(e.target.value)}
        />
        {layer('corridor', 'Corridor')}
        {layer('idealLine', 'Line')}
      </div>

      <div className="sim-groups">
        <fieldset>
          <legend>Machine</legend>
          <label className="sim-slider">
            <span className="sim-slider-label">Preset</span>
            <select className="bp-select" value={params.machine.presetId} data-testid="sim-preset" onChange={(e) => applyPreset(e.target.value)}>
              {MACHINE_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </label>
          <Slider label="Power" value={params.machine.powerKw} min={10} max={250} step={1} unit="kW" decimals={0} testId="sim-power" onChange={(v) => setSimParams({ machine: { powerKw: v, presetId: 'custom' } })} />
          <Slider label="Mass" value={params.machine.massKg} min={120} max={400} step={1} unit="kg" decimals={0} testId="sim-mass" onChange={(v) => setSimParams({ machine: { massKg: v, presetId: 'custom' } })} />
          <Slider label="Drag area" value={params.machine.cdA} min={0.2} max={0.6} step={0.01} unit="m²" testId="sim-cda" onChange={(v) => setSimParams({ machine: { cdA: v, presetId: 'custom' } })} />
        </fieldset>

        <fieldset>
          <legend>Tyre / track</legend>
          <Slider label="Friction μ" value={params.tyre.mu} min={0.6} max={1.7} step={0.01} testId="sim-mu" onChange={(v) => setSimParams({ tyre: { mu: v } })} />
          <Slider label="Max lean" value={params.tyre.maxLeanDeg} min={30} max={68} step={0.5} unit="°" decimals={1} testId="sim-lean" onChange={(v) => setSimParams({ tyre: { maxLeanDeg: v } })} />
          <Slider label="Kerb margin" value={params.tyre.kerbMarginM} min={0} max={2} step={0.1} unit="m" decimals={1} testId="sim-kerb" onChange={(v) => setSimParams({ tyre: { kerbMarginM: v } })} />
          <Slider label="Grip scale" value={params.tyre.gripScale} min={0.4} max={1.1} step={0.01} testId="sim-grip" onChange={(v) => setSimParams({ tyre: { gripScale: v } })} />
        </fieldset>

        <fieldset>
          <legend>Rider</legend>
          <Slider label="Line deviation" value={params.rider.lineDeviationM} min={0} max={3} step={0.05} unit="m" testId="sim-deviation" onChange={(v) => setSimParams({ rider: { lineDeviationM: v } })} />
          <Slider label="Braking" value={params.rider.brakingG} min={0.4} max={1.6} step={0.01} unit="g" testId="sim-braking" onChange={(v) => setSimParams({ rider: { brakingG: v } })} />
          <Slider label="Throttle delay" value={params.rider.throttleDelayS} min={0} max={1.5} step={0.01} unit="s" testId="sim-throttle" onChange={(v) => setSimParams({ rider: { throttleDelayS: v } })} />
          <Slider label="Traction control" value={params.rider.tcThreshold} min={0} max={1} step={0.01} testId="sim-tc" onChange={(v) => setSimParams({ rider: { tcThreshold: v } })} />
          <Slider label="Lean usage" value={params.rider.leanUsage} min={0.5} max={1} step={0.01} testId="sim-leanusage" onChange={(v) => setSimParams({ rider: { leanUsage: v } })} />
          <Slider label="Line style (C↔V)" value={params.rider.kappa} min={0} max={1} step={0.01} testId="sim-kappa" onChange={(v) => setSimParams({ rider: { kappa: v } })} />
        </fieldset>
      </div>
    </div>
  );
}
