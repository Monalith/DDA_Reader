import { useEffect, useMemo, useState } from 'react';
import 'uplot/dist/uPlot.min.css';
import './charts.css';
import type { Workspace } from '../core/types';
import { activeTrack, useLab } from '../state/store';
import { allChannelNames } from '../state/selectors';
import ChartPanel from './ChartPanel';
import { focusRangeLabel, stepTurnIndex, turnFocusRange, turnOptionLabel } from './focus';

type Panel = Workspace['panels'][number];

export default function ChartStack() {
  const sessions = useLab((s) => s.sessions);
  const panels = useLab((s) => s.workspace.panels);
  const xAxis = useLab((s) => s.workspace.xAxis);
  const setWorkspace = useLab((s) => s.setWorkspace);
  const xRange = useLab((s) => s.xRange);
  const setXRange = useLab((s) => s.setXRange);
  const track = useLab(activeTrack);

  const names = useMemo(() => allChannelNames(sessions), [sessions]);
  const [axisFor, setAxisFor] = useState<Record<string, 'L' | 'R'>>({});

  // ---- focus on a turn ---------------------------------------------------
  const turns = track?.turns ?? [];
  const byDistance = xAxis === 'distance';
  const focusDisabled = !byDistance || turns.length === 0;
  const focusTitle = !byDistance
    ? 'Switch X axis to Distance to focus on turns'
    : turns.length === 0
      ? 'No turns detected on the active track'
      : 'Zoom every chart to one turn';
  // index into `turns`, or null for the whole lap
  const [turnIdx, setTurnIdx] = useState<number | null>(null);

  // A drag-select or "Reset zoom" elsewhere no longer matches a turn window.
  useEffect(() => {
    if (xRange == null) setTurnIdx(null);
  }, [xRange]);

  const focusOn = (idx: number | null) => {
    setTurnIdx(idx);
    const turn = idx == null ? undefined : turns[idx];
    setXRange(turn ? turnFocusRange(turn) : null);
  };
  const step = (dir: 1 | -1) => focusOn(stepTurnIndex(turnIdx, turns.length, dir));

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

        <span className="focus-group" data-testid="focus-group">
          <span className="focus-label">Focus</span>
          <button
            className="btn-mini"
            data-testid="focus-prev"
            disabled={focusDisabled}
            title={focusDisabled ? focusTitle : 'Previous turn'}
            onClick={() => step(-1)}
          >
            ◀ prev turn
          </button>
          <select
            data-testid="focus-turn"
            aria-label="Focus on turn"
            disabled={focusDisabled}
            title={focusTitle}
            value={turnIdx == null ? '' : String(turnIdx)}
            onChange={(e) => focusOn(e.target.value === '' ? null : Number(e.target.value))}
          >
            <option value="">— whole lap —</option>
            {turns.map((t, i) => (
              <option key={t.n} value={String(i)}>
                {turnOptionLabel(t)}
              </option>
            ))}
          </select>
          <button
            className="btn-mini"
            data-testid="focus-next"
            disabled={focusDisabled}
            title={focusDisabled ? focusTitle : 'Next turn'}
            onClick={() => step(1)}
          >
            next turn ▶
          </button>
          <span className="focus-range" data-testid="focus-range">
            {focusRangeLabel(xRange, xAxis)}
          </span>
          {xRange && (
            <button className="btn-mini" onClick={() => setXRange(null)} title="Reset the x zoom">
              Reset zoom
            </button>
          )}
        </span>
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
