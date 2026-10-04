import { useMemo, useState } from 'react';
import 'uplot/dist/uPlot.min.css';
import './charts.css';
import type { Workspace } from '../core/types';
import { useLab } from '../state/store';
import { allChannelNames } from '../state/selectors';
import ChartPanel from './ChartPanel';

type Panel = Workspace['panels'][number];

export default function ChartStack() {
  const sessions = useLab((s) => s.sessions);
  const panels = useLab((s) => s.workspace.panels);
  const xAxis = useLab((s) => s.workspace.xAxis);
  const setWorkspace = useLab((s) => s.setWorkspace);
  const xRange = useLab((s) => s.xRange);
  const setXRange = useLab((s) => s.setXRange);

  const names = useMemo(() => allChannelNames(sessions), [sessions]);
  const [axisFor, setAxisFor] = useState<Record<string, 'L' | 'R'>>({});

  const update = (next: Panel[]) => setWorkspace({ panels: next });

  const addPanel = () =>
    update([...panels, { id: `p${Date.now()}`, channels: [{ name: 'speed', axis: 'L' }] }]);

  const removePanel = (id: string) => update(panels.filter((p) => p.id !== id));

  const removeChannel = (id: string, name: string) =>
    update(panels.map((p) => (p.id === id ? { ...p, channels: p.channels.filter((c) => c.name !== name) } : p)));

  const addChannel = (id: string, name: string) => {
    const axis = axisFor[id] ?? 'L';
    update(
      panels.map((p) =>
        p.id === id && !p.channels.some((c) => c.name === name)
          ? { ...p, channels: [...p.channels, { name, axis }] }
          : p,
      ),
    );
  };

  if (sessions.length === 0) {
    return (
      <div className="chart-stack">
        <div className="chart-stack-empty">Open .dda/.json/.csv sessions to start</div>
      </div>
    );
  }

  return (
    <div className="chart-stack">
      <div className="chart-stack-bar">
        <button className="btn-mini" onClick={addPanel} title="Add a chart panel">
          + Panel
        </button>
        <span>
          {panels.length} panel{panels.length === 1 ? '' : 's'} · x: {xAxis}
        </span>
        <span className="spacer" style={{ flex: '1 1 auto' }} />
        {xRange && (
          <button className="btn-mini" onClick={() => setXRange(null)} title="Reset the x zoom">
            Reset zoom
          </button>
        )}
      </div>

      {panels.map((panel) => {
        const free = names.filter((n) => !panel.channels.some((c) => c.name === n));
        const axis = axisFor[panel.id] ?? 'L';
        return (
          <div className="chart-panel" key={panel.id}>
            <div className="chart-panel-head">
              {panel.channels.map((c) => (
                <button
                  className="chan-pill"
                  key={c.name}
                  onClick={() => removeChannel(panel.id, c.name)}
                  title={`Remove ${c.name}`}
                >
                  {c.name} <span className="ax">{c.axis}</span> ×
                </button>
              ))}
              <select
                value=""
                aria-label="Add channel"
                onChange={(e) => {
                  if (e.target.value) addChannel(panel.id, e.target.value);
                  e.currentTarget.value = '';
                }}
              >
                <option value="">+ channel…</option>
                {free.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              <button
                className={`btn-mini axis-toggle ${axis === 'R' ? 'on' : ''}`}
                title="Axis for newly added channels"
                onClick={() => setAxisFor((m) => ({ ...m, [panel.id]: axis === 'L' ? 'R' : 'L' }))}
              >
                {axis}
              </button>
              <span className="spacer" style={{ flex: '1 1 auto' }} />
              <button className="btn-mini" onClick={() => removePanel(panel.id)} title="Remove panel">
                ⨉
              </button>
            </div>
            <ChartPanel panel={panel} />
          </div>
        );
      })}
    </div>
  );
}
