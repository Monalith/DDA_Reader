import { useMemo, useRef } from 'react';
import { markersToJson, parseMarkersJson } from '../../core/markerStore';
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
  const fileRef = useRef<HTMLInputElement>(null);
  const exportJson = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([markersToJson(markers, sessions)], { type: 'application/json' }));
    a.download = `dda-lab-markers-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const importJson = async (f: File | undefined) => {
    if (!f) return;
    try {
      const saved = parseMarkersJson(await f.text());
      let n = 0;
      for (const m of saved) {
        const s = sessions.find((x) => x.name === m.sessionName);
        if (!s || m.idx < 0 || m.idx >= s.t.length) continue;
        if (markers.some((e) => e.sessionId === s.id && e.idx === m.idx)) continue;
        useLab.getState().addMarker(s.id, m.idx, { name: m.name, color: m.color, note: m.note });
        n++;
      }
      useLab.getState().setStatus(`${n} marker${n === 1 ? '' : 's'} imported (${saved.length - n} skipped: file not open or already present)`);
    } catch (e) {
      useLab.getState().setStatus(`Error: ${(e as Error).message}`);
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };
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
  const importRow = (
    <>
      <input ref={fileRef} type="file" accept=".json" hidden data-testid="markers-import-input" onChange={(e) => importJson(e.target.files?.[0])} />
      <button className="bp-btn" data-testid="markers-import" onClick={() => fileRef.current?.click()} title="Load a markers file saved with Export">
        Import…
      </button>
    </>
  );
  if (!markers.length) {
    return (
      <div className="bp-empty" data-testid="markers-empty">
        No markers yet. Click a chart (or the map) and press <strong>📍 Mark</strong>, or hover and press <kbd>M</kbd>. Each marker pins the
        data at that point: its values stay visible under every chart and here. Markers are remembered per file (reopen the same file and
        they come back) and travel inside .lab.json bundles. {importRow}
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
          <button className="bp-btn" data-testid="markers-export" onClick={exportJson} title="Save the markers (names, notes, positions) to a JSON file">
            Export
          </button>
          {importRow}
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
          the table compares laps at exactly that point. Markers are saved automatically per file and inside .lab.json bundles.
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
