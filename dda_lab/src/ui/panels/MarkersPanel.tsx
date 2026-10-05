import { useMemo } from 'react';
import { lapMetaOf, useLab } from '../../state/store';
import { allChannelNames, fmtLapTime, markerIdxInLap, markerX, selectedLapEntries, xFromIdx } from '../../state/selectors';

function fmt(v: number | undefined | null): string {
  if (v == null || !Number.isFinite(v)) return '–';
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 100) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

/**
 * Markers tab: the list of placed markers (rename, recolour, jump, delete) and a fixed
 * value table for the active marker — every channel of every selected lap at the marker.
 */
export default function MarkersPanel() {
  const sessions = useLab((s) => s.sessions);
  const selectedLaps = useLab((s) => s.selectedLaps);
  const lapMeta = useLab((s) => s.lapMeta);
  const markers = useLab((s) => s.markers);
  const activeMarkerId = useLab((s) => s.activeMarkerId);
  const xAxis = useLab((s) => s.workspace.xAxis);
  const { updateMarker, removeMarker, clearMarkers, setActiveMarker, setCursor } = useLab.getState();

  const active = markers.find((m) => m.id === activeMarkerId) ?? markers[0];
  const entries = useMemo(() => selectedLapEntries({ sessions, selectedLaps }), [sessions, selectedLaps]);
  const names = useMemo(() => allChannelNames(sessions), [sessions]);

  const cols = useMemo(() => {
    if (!active) return [];
    return entries.map(({ s, lap }) => {
      const idx = markerIdxInLap(sessions, active, s, lap, xAxis);
      const meta = lapMetaOf({ sessions, lapMeta }, s.id, lap.n);
      return {
        key: `${s.id}:${lap.n}`,
        header: meta.name,
        color: meta.color,
        session: s,
        idx,
        own: active.sessionId === s.id && idx === active.idx,
        lapTimeS: idx === null ? NaN : s.t[idx] - s.t[lap.startIdx],
        distM: idx === null ? NaN : s.channels.get('lap_dist')?.data[idx],
      };
    });
  }, [active, entries, sessions, lapMeta, xAxis]);

  if (!sessions.length) return <div className="bp-empty">Load a session.</div>;
  if (!markers.length) {
    return (
      <div className="bp-empty" data-testid="markers-empty">
        No markers yet. Hover a chart (or click the map) and press <kbd>M</kbd> or the <strong>📍 Mark</strong> button
        above the charts. Each marker pins the data at that point: its values stay visible under every chart and here.
      </div>
    );
  }

  const where = (m: typeof markers[number]) => {
    const s = sessions.find((x) => x.id === m.sessionId);
    if (!s) return '';
    const hit = xFromIdx(s, m.idx, xAxis);
    const x = markerX(sessions, m, xAxis);
    const lapName = hit ? lapMetaOf({ sessions, lapMeta }, s.id, hit.lap.n).name : s.name;
    return `${lapName} · ${x === null ? '' : xAxis === 'distance' ? `${x.toFixed(0)} m` : `${x.toFixed(2)} s`}`;
  };

  return (
    <div data-testid="markers-panel" className="markers-grid">
      <div className="markers-list">
        <div className="bp-row" style={{ marginBottom: 6 }}>
          <span className="ch-group-title" style={{ margin: 0 }}>Markers ({markers.length})</span>
          <span className="bp-spacer" style={{ flex: 1 }} />
          <button className="bp-btn danger" onClick={clearMarkers} title="Remove every marker">
            Clear all
          </button>
        </div>
        {markers.map((m) => (
          <div
            className={`marker-row${m.id === active?.id ? ' on' : ''}`}
            key={m.id}
            data-testid={`marker-row-${m.id}`}
            onClick={() => setActiveMarker(m.id)}
          >
            <input
              type="color"
              className="bp-input"
              value={m.color}
              style={{ width: 26, height: 22, padding: 0 }}
              onChange={(e) => updateMarker(m.id, { color: e.target.value })}
              title="Marker colour"
            />
            <input
              className="bp-input"
              value={m.name}
              style={{ width: 70 }}
              onChange={(e) => updateMarker(m.id, { name: e.target.value })}
              title="Marker name"
            />
            <span className="bp-label marker-where">{where(m)}</span>
            <input
              className="bp-input"
              value={m.note ?? ''}
              placeholder="note…"
              style={{ flex: 1, minWidth: 80 }}
              data-testid={`marker-note-input-${m.id}`}
              onChange={(e) => updateMarker(m.id, { note: e.target.value })}
              title="Note for this marker"
            />
            <button
              className="bp-btn tiny"
              title="Move the cursor to this marker"
              onClick={(e) => {
                e.stopPropagation();
                setActiveMarker(m.id);
                setCursor({ sessionId: m.sessionId, idx: m.idx });
              }}
            >
              go
            </button>
            <button
              className="bp-btn tiny danger"
              data-testid={`marker-del-${m.id}`}
              title="Remove this marker"
              onClick={(e) => {
                e.stopPropagation();
                removeMarker(m.id);
              }}
            >
              ✕
            </button>
          </div>
        ))}
        <p className="bp-label" style={{ marginTop: 8 }}>
          A marker is fixed to one sample. In other laps it is read at the same {xAxis === 'distance' ? 'lap distance' : 'lap time'}, so
          the table compares laps at exactly that point.
        </p>
      </div>

      <div className="markers-table">
        {active && cols.length === 0 && <div className="bp-empty">Select at least one lap to see values.</div>}
        {active && cols.length > 0 && (
          <table className="bp-table marker-values" data-testid="marker-table">
            <thead>
              <tr>
                <th className="name" style={{ color: active.color }}>
                  {active.name}
                </th>
                {cols.map((c) => (
                  <th key={c.key} style={{ color: c.color }} title={c.own ? 'the marked sample' : 'same position in this lap'}>
                    {c.header}
                    {c.own ? ' ●' : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="name">lap time</td>
                {cols.map((c) => (
                  <td key={c.key}>{fmtLapTime(c.lapTimeS)}</td>
                ))}
              </tr>
              <tr>
                <td className="name">lap dist (m)</td>
                {cols.map((c) => (
                  <td key={c.key}>{fmt(c.distM)}</td>
                ))}
              </tr>
              {names.map((n) => (
                <tr key={n} data-testid={`marker-row-ch-${n}`}>
                  <td className="name">{n}</td>
                  {cols.map((c) => (
                    <td key={c.key}>{c.idx === null ? '–' : fmt(c.session.channels.get(n)?.data[c.idx])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
