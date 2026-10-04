import { useEffect, useRef } from 'react';
import type { AxisRange, ChartPanelConfig } from '../core/types';

interface Props {
  panel: ChartPanelConfig;
  xAxis: 'time' | 'distance';
  onChange(next: ChartPanelConfig): void;
  onClose(): void;
}

const num = (v: string): number | null => {
  if (v.trim() === '') return null;
  const n = Number(v.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

function RangeRow({ label, value, onChange, testId }: { label: string; value: AxisRange | undefined; onChange(r: AxisRange | undefined): void; testId: string }) {
  const auto = value?.min == null && value?.max == null;
  return (
    <div className="ps-row">
      <span className="ps-label">{label}</span>
      <input
        type="number"
        step="any"
        placeholder="auto"
        value={value?.min ?? ''}
        data-testid={`${testId}-min`}
        onChange={(e) => onChange({ ...value, min: num(e.target.value) })}
      />
      <span className="ps-dash">–</span>
      <input
        type="number"
        step="any"
        placeholder="auto"
        value={value?.max ?? ''}
        data-testid={`${testId}-max`}
        onChange={(e) => onChange({ ...value, max: num(e.target.value) })}
      />
      <button className="btn-mini" disabled={auto} onClick={() => onChange(undefined)} title="Automatic range" data-testid={`${testId}-auto`}>
        auto
      </button>
    </div>
  );
}

/** Per-panel settings popover: Y ranges, independent X range, line widths. */
export default function PanelSettings({ panel, xAxis, onChange, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const hasR = panel.channels.some((c) => c.axis === 'R');
  const linked = panel.x?.linked ?? true;
  const xUnit = xAxis === 'distance' ? 'm' : 's';
  const set = (patch: Partial<ChartPanelConfig>) => onChange({ ...panel, ...patch });

  return (
    <div className="panel-settings" ref={ref} data-testid={`panel-settings-${panel.id}`} role="dialog" aria-label="Panel settings">
      <div className="ps-title">
        Panel settings
        <button className="btn-mini" onClick={onClose} title="Close">
          ✕
        </button>
      </div>

      <div className="ps-section">Y axis</div>
      <RangeRow label="Left" value={panel.yL} onChange={(yL) => set({ yL })} testId={`ps-${panel.id}-yl`} />
      {hasR && <RangeRow label="Right" value={panel.yR} onChange={(yR) => set({ yR })} testId={`ps-${panel.id}-yr`} />}

      <div className="ps-section">X axis ({xUnit})</div>
      <label className="ps-row ps-check">
        <input
          type="checkbox"
          checked={linked}
          data-testid={`ps-${panel.id}-xlinked`}
          onChange={(e) => set({ x: { ...panel.x, linked: e.target.checked } })}
        />
        Linked to the shared zoom / focus
      </label>
      {!linked && (
        <RangeRow
          label="Range"
          value={{ min: panel.x?.min, max: panel.x?.max }}
          onChange={(r) => set({ x: { linked: false, min: r?.min ?? null, max: r?.max ?? null } })}
          testId={`ps-${panel.id}-x`}
        />
      )}

      <div className="ps-section">Line width (px)</div>
      <div className="ps-row">
        <span className="ps-label">Panel</span>
        <input
          type="range"
          min={0.5}
          max={5}
          step={0.25}
          value={panel.lineWidth ?? 1.5}
          data-testid={`ps-${panel.id}-width`}
          onChange={(e) => set({ lineWidth: Number(e.target.value) })}
        />
        <span className="num ps-val">{(panel.lineWidth ?? 1.5).toFixed(2)}</span>
      </div>
      {panel.channels.map((c) => (
        <div className="ps-row" key={c.name}>
          <span className="ps-label ps-chan">{c.name}</span>
          <input
            type="range"
            min={0.5}
            max={5}
            step={0.25}
            value={c.width ?? panel.lineWidth ?? 1.5}
            data-testid={`ps-${panel.id}-width-${c.name}`}
            onChange={(e) =>
              set({ channels: panel.channels.map((x) => (x.name === c.name ? { ...x, width: Number(e.target.value) } : x)) })
            }
          />
          <span className="num ps-val">{(c.width ?? panel.lineWidth ?? 1.5).toFixed(2)}</span>
          {c.width != null && (
            <button
              className="btn-mini"
              title="Use panel width"
              onClick={() => set({ channels: panel.channels.map((x) => (x.name === c.name ? { name: x.name, axis: x.axis } : x)) })}
            >
              ↺
            </button>
          )}
        </div>
      ))}
      <div className="ps-foot">
        <button
          className="btn-mini"
          data-testid={`ps-${panel.id}-reset`}
          onClick={() => set({ yL: undefined, yR: undefined, x: undefined, lineWidth: undefined, channels: panel.channels.map((c) => ({ name: c.name, axis: c.axis })) })}
        >
          Reset panel
        </button>
      </div>
    </div>
  );
}
