import { useEffect, useMemo, useState } from 'react';
import 'uplot/dist/uPlot.min.css';
import './charts.css';
import { DEFAULT_TURN_LABELS, type Workspace } from '../core/types';
import { activeTrack, useLab } from '../state/store';
import { allChannelNames, overlaySeries } from '../state/selectors';
import { visibleCsv } from '../core/exportVisible';
import { CHART_TEMPLATES, templateById, templatePanels } from '../core/chartTemplates';

function download(name: string, text: string, mime = 'text/csv'): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
import ChartPanel from './ChartPanel';
import PanelSettings from './PanelSettings';
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
  const hasCursor = useLab((s) => s.cursor !== null);
  const nMarkers = useLab((s) => s.markers.length);
  const nSelected = useLab((s) => s.selectedLaps.length);

  /** CSV of exactly what the charts show: every line of every panel over the visible range. */
  const exportVisible = () => {
    const st = useLab.getState();
    const csv = visibleCsv({
      xAxis: st.workspace.xAxis,
      range: st.xRange,
      panels: st.workspace.panels.map((p) => ({ id: p.id, lines: overlaySeries(st, p) })),
    });
    if (!csv.trim()) {
      st.setStatus('Nothing plotted to export');
      return;
    }
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    download(`dda-lab-visible-${stamp}.csv`, csv);
    st.setStatus(st.xRange ? 'Exported the visible range of every chart' : 'Exported every plotted lap (full range)');
  };

  // ---- markers: button + "M" key place one at the cursor ----------------
  const hasClick = useLab((s) => s.clickPos !== null);
  const placeMarker = (prefer: 'click' | 'hover') => {
    const st = useLab.getState();
    const m = st.addMarkerAtCursor(prefer);
    st.setStatus(m ? `Marker ${m.name} placed — drag its flag to move it, double-click it for a note` : 'Click a chart or the map first to place a marker');
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'm' && e.key !== 'M') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;
      e.preventDefault();
      placeMarker('hover');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const [labelsOpen, setLabelsOpen] = useState(false);
  const turnLabels = useLab((s) => s.workspace.turnLabels ?? DEFAULT_TURN_LABELS);
  const setTurnLabels = (patch: Partial<typeof turnLabels>) => setWorkspace({ turnLabels: { ...turnLabels, ...patch } });
  const updatePanel = (next: Panel) => update(panels.map((p) => (p.id === next.id ? next : p)));

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
        <button
          className="btn-mini marker-btn"
          data-testid="add-marker"
          disabled={!hasCursor && !hasClick}
          onClick={() => placeMarker('click')}
          title={hasClick ? 'Place a marker where you last clicked (M key = under the mouse)' : 'Click a chart or the map, then press this (or M under the mouse)'}
        >
          📍 Mark{nMarkers ? ` (${nMarkers})` : ''}
        </button>
        <select
          className="template-select"
          data-testid="chart-template"
          aria-label="Chart template"
          value=""
          title="Replace the panels with a ready-made layout"
          onChange={(e) => {
            const t = templateById(e.target.value);
            if (t) {
              setWorkspace({ panels: templatePanels(t) });
              useLab.getState().setStatus(`Template "${t.label}": ${t.doc}`);
            }
            e.currentTarget.value = '';
          }}
        >
          <option value="">Templates…</option>
          {CHART_TEMPLATES.map((t) => (
            <option key={t.id} value={t.id} title={t.doc}>
              {t.label}
            </option>
          ))}
        </select>
        {nMarkers > 0 && (
          <button className="btn-mini" onClick={() => useLab.getState().setBottomTab('markers')} title="Open the Markers tab">
            values
          </button>
        )}
        <button
          className="btn-mini export-visible"
          data-testid="export-visible"
          disabled={!nSelected}
          onClick={exportVisible}
          title="CSV of exactly what the charts show: the plotted laps and channels, visible x range only"
        >
          ⤓ Export visible
        </button>
        <span className="labels-wrap">
          <button
            className={`btn-mini ${labelsOpen ? 'on' : ''}`}
            data-testid="turn-labels-btn"
            onClick={() => setLabelsOpen((v) => !v)}
            title="Per-turn gain/loss labels: size and colours"
          >
            <span style={{ color: turnLabels.gain }}>−</span>
            <span style={{ color: turnLabels.loss }}>+</span> labels
          </button>
          {labelsOpen && (
            <div className="panel-settings labels-pop" data-testid="turn-labels-pop" role="dialog" aria-label="Turn label style">
              <div className="ps-title">
                Turn labels
                <button className="btn-mini" onClick={() => setLabelsOpen(false)} title="Close">
                  ✕
                </button>
              </div>
              <label className="ps-row ps-check">
                <input type="checkbox" checked={turnLabels.onMap !== false} data-testid="turn-labels-map" onChange={(e) => setTurnLabels({ onMap: e.target.checked })} /> On the map (next to each turn)
              </label>
              <label className="ps-row ps-check">
                <input type="checkbox" checked={turnLabels.speed !== false} data-testid="turn-labels-speed" onChange={(e) => setTurnLabels({ speed: e.target.checked })} /> Also apex speed Δ (km/h) vs the best lap
              </label>
              <label className="ps-row ps-check">
                <input type="checkbox" checked={turnLabels.show} data-testid="turn-labels-charts" onChange={(e) => setTurnLabels({ show: e.target.checked })} /> On the charts (at the turn lines)
              </label>
              <div className="ps-row">
                <span className="ps-label">Size</span>
                <input type="range" min={10} max={24} step={1} value={turnLabels.size} data-testid="turn-labels-size" onChange={(e) => setTurnLabels({ size: Number(e.target.value) })} />
                <span className="num ps-val">{turnLabels.size}px</span>
              </div>
              {(
                [
                  ['gain', 'Gained (−)'],
                  ['loss', 'Lost (+)'],
                  ['best', 'best'],
                ] as const
              ).map(([key, label]) => (
                <div className="ps-row" key={key}>
                  <span className="ps-label" style={{ width: 80 }}>{label}</span>
                  <input type="color" value={turnLabels[key]} data-testid={`turn-labels-${key}`} onChange={(e) => setTurnLabels({ [key]: e.target.value })} />
                  <span className="label-preview" style={{ color: turnLabels[key], fontSize: turnLabels.size }}>
                    {key === 'gain' ? '−0.12' : key === 'loss' ? '+0.26' : 'best'}
                  </span>
                </div>
              ))}
              <div className="ps-row" style={{ gap: 4, flexWrap: 'wrap' }}>
                <span className="ps-label">Themes</span>
                {(
                  [
                    ['Vivid', { gain: '#00e676', loss: '#ff3d57', best: '#ffffff' }],
                    ['Classic', { gain: '#3ddc84', loss: '#ff4d6d', best: '#ffd166' }],
                    ['Cool', { gain: '#40c4ff', loss: '#ff6e40', best: '#eeff41' }],
                    ['Mono', { gain: '#ffffff', loss: '#b0bec5', best: '#ffd600' }],
                  ] as const
                ).map(([name, th]) => (
                  <button key={name} className="btn-mini" onClick={() => setTurnLabels(th)} title={`${th.gain} / ${th.loss} / ${th.best}`}>
                    {name}
                  </button>
                ))}
              </div>
              <div className="ps-foot">
                <button className="btn-mini" onClick={() => setTurnLabels({ ...DEFAULT_TURN_LABELS })}>
                  Reset
                </button>
              </div>
            </div>
          )}
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
              {panel.title && <span className="panel-title">{panel.title}</span>}
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
              {(panel.yL || panel.yR || panel.x?.linked === false || panel.lineWidth != null) && (
                <span className="chan-pill dim" title="Custom scale / width">custom</span>
              )}
              <button
                className={`btn-mini ${settingsFor === panel.id ? 'on' : ''}`}
                data-testid={`panel-gear-${panel.id}`}
                onClick={() => setSettingsFor(settingsFor === panel.id ? null : panel.id)}
                title="Panel settings: Y range, X range, line width"
              >
                ⚙
              </button>
              <button className="btn-mini" onClick={() => removePanel(panel.id)} title="Remove panel">
                ⨉
              </button>
              {settingsFor === panel.id && (
                <PanelSettings panel={panel} xAxis={xAxis} onChange={updatePanel} onClose={() => setSettingsFor(null)} />
              )}
            </div>
            <ChartPanel panel={panel} />
          </div>
        );
      })}
    </div>
  );
}
