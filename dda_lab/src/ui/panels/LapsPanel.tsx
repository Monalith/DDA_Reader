// Laps panel: the user's working set of laps — import from file, name/colour each lap,
// pick the reference, reorder, remove, and export the set as a bundle or per-lap CSVs.
import { useCallback, useMemo, useRef, useState } from 'react';
import { lapToBundleLap, lapToCsv, makeBundle, type BundleLap } from '../../core/bundle';
import { isBundle, loadBundleFromFile, loadSessionFromFile } from '../../core/sessionLoader';
import type { Lap, Session } from '../../core/types';
import { activeTrack, lapMetaOf, SESSION_COLORS, useLab, type LapRef } from '../../state/store';
import { ensureTrackForSession } from '../../state/trackActions';
import { fmtLapTime, selectedLapEntries } from '../../state/selectors';
import './laps.css';

const KMH_TO_MPH = 0.621371;

/** A session queued for lap picking after an import, with the ticked lap numbers. */
interface Picker {
  sessionId: string;
  base: string;
  checked: number[];
}

function download(name: string, text: string, mime = 'application/json'): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function lapVmaxKmh(s: Session, lap: Lap): number {
  const ch = s.channels.get('speed');
  if (!ch) return NaN;
  let m = -Infinity;
  for (let i = lap.startIdx; i <= lap.endIdx && i < ch.data.length; i++) {
    const v = ch.data[i];
    if (Number.isFinite(v) && v > m) m = v;
  }
  return m === -Infinity ? NaN : m;
}

/** <input type="color"> only accepts #rrggbb; fall back for rgb()/named colours. */
function hexColor(c: string): string {
  return /^#[0-9a-f]{6}$/i.test(c) ? c : '#ffffff';
}

function safeFileName(s: string): string {
  return (s.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'lap').slice(0, 120);
}

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export default function LapsPanel() {
  const sessions = useLab((s) => s.sessions);
  const selectedLaps = useLab((s) => s.selectedLaps);
  const lapMeta = useLab((s) => s.lapMeta);
  const refLap = useLab((s) => s.refLap);
  const unitMph = useLab((s) => s.workspace.unitMph);

  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [pickers, setPickers] = useState<Picker[]>([]);
  /** Uncommitted text of the name input currently being edited, keyed by lapKey. */
  const [draft, setDraft] = useState<Record<string, string>>({});
  const xRange = useLab((s) => s.xRange);
  const [visibleOnly, setVisibleOnly] = useState(true);

  const entries = useMemo(() => selectedLapEntries({ sessions, selectedLaps }), [sessions, selectedLaps]);
  const vUnit = unitMph ? 'mph' : 'km/h';

  // ---- import ------------------------------------------------------------
  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    const { addSession, setStatus } = useLab.getState();
    setBusy(true);
    const queued: Picker[] = [];
    try {
      for (const f of Array.from(files)) {
        const st = useLab.getState();
        const color = SESSION_COLORS[st.sessions.length % SESSION_COLORS.length];
        setStatus(`Loading ${f.name}…`);
        if (await isBundle(f)) {
          // a bundle: its laps join the workspace directly with their saved names/colours
          const b = await loadBundleFromFile(f, activeTrack(st));
          if (b.track && !activeTrack(st)) useLab.getState().setTrack(b.track);
          for (const { session, name, color: c } of b.sessions) {
            addSession(session);
            useLab.getState().setLapMeta(session.id, session.laps[0].n, { name, color: c });
          }
          setStatus(`${f.name}: ${b.sessions.length} lap${b.sessions.length === 1 ? '' : 's'} added to the workspace`);
          continue;
        }
        const s = await loadSessionFromFile(f, color, activeTrack(st));
        addSession(s);
        ensureTrackForSession(s);
        // addSession auto-selects the session's best lap: pre-tick it in the picker.
        const auto = useLab.getState().selectedLaps.filter((l) => l.sessionId === s.id).map((l) => l.lap);
        queued.push({ sessionId: s.id, base: f.name.replace(/\.[^.]+$/, ''), checked: auto });
        setStatus(`${f.name}: ${s.laps.length} laps`);
      }
      setPickers((p) => [...p, ...queued]);
    } catch (e) {
      setStatus(`Error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  const togglePick = (sessionId: string, lap: number) =>
    setPickers((ps) =>
      ps.map((p) =>
        p.sessionId === sessionId
          ? { ...p, checked: p.checked.includes(lap) ? p.checked.filter((n) => n !== lap) : [...p.checked, lap] }
          : p,
      ),
    );

  function addPicked(p: Picker) {
    const { toggleLap, setLapMeta } = useLab.getState();
    const laps = [...p.checked].sort((a, b) => a - b);
    for (const n of laps) {
      const already = useLab.getState().selectedLaps.some((l) => l.sessionId === p.sessionId && l.lap === n);
      if (!already) toggleLap(p.sessionId, n);
      setLapMeta(p.sessionId, n, { name: `${p.base} L${n}` });
    }
    setPickers((ps) => ps.filter((x) => x.sessionId !== p.sessionId));
  }

  // ---- export ------------------------------------------------------------
  function exportBundle() {
    const st = useLab.getState();
    const laps: BundleLap[] = selectedLapEntries(st).map(({ s, lap }) => {
      const meta = lapMetaOf(st, s.id, lap.n);
      return lapToBundleLap(s, lap, meta.name, meta.color);
    });
    if (!laps.length) {
      st.setStatus('No laps in the workspace to export');
      return;
    }
    download(`dda-lab-${today()}.lab.json`, makeBundle(laps, activeTrack(st), st.workspace));
    st.setStatus(`Bundle exported: ${laps.length} lap${laps.length === 1 ? '' : 's'}`);
  }

  function exportCsv() {
    const st = useLab.getState();
    const list = selectedLapEntries(st);
    if (!list.length) {
      st.setStatus('No laps in the workspace to export');
      return;
    }
    const visible = visibleOnly && st.xRange ? { xAxis: st.workspace.xAxis, range: st.xRange } : undefined;
    for (const { s, lap } of list) {
      const meta = lapMetaOf(st, s.id, lap.n);
      download(`${safeFileName(meta.name)}${visible ? '-visible' : ''}.csv`, lapToCsv(s, lap, visible), 'text/csv');
    }
    st.setStatus(`${list.length} CSV file${list.length === 1 ? '' : 's'} exported${visible ? ' (visible range only)' : ''}`);
  }

  // ---- row actions -------------------------------------------------------
  /** Reorder the workspace laps: swap this ref with its neighbour in selectedLaps. */
  const move = useCallback((ref: LapRef, dir: -1 | 1) => {
    useLab.setState((st) => {
      const next: LapRef[] = [...st.selectedLaps];
      const idx = next.findIndex((l) => l.sessionId === ref.sessionId && l.lap === ref.lap);
      const to = idx + dir;
      if (idx < 0 || to < 0 || to >= next.length) return {};
      [next[idx], next[to]] = [next[to], next[idx]];
      return { selectedLaps: next };
    });
  }, []);

  const commitName = (sessionId: string, lap: number, key: string) => {
    const v = draft[key];
    setDraft((d) => {
      const { [key]: _drop, ...rest } = d;
      void _drop;
      return rest;
    });
    if (v !== undefined && v.trim()) useLab.getState().setLapMeta(sessionId, lap, { name: v.trim() });
  };

  return (
    <div className="laps-panel" data-testid="laps-panel">
      <div className="bp-row laps-toolbar">
        <button className="bp-btn primary" data-testid="laps-import" disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? 'Loading…' : '📂 Import lap from file…'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".dda,.json,.csv,.lab.json"
          multiple
          hidden
          data-testid="laps-import-input"
          onChange={(e) => onFiles(e.target.files)}
        />
        <span className="bp-spacer-flex" />
        <span className="bp-label" title="Exports contain only the laps listed below (deleted laps are never included)">
          exports = these {entries.length} lap{entries.length === 1 ? '' : 's'}
        </span>
        {xRange && (
          <label className="bp-label" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }} title="Limit the CSV rows to the zoomed chart range">
            <input type="checkbox" data-testid="laps-export-visible" checked={visibleOnly} onChange={(e) => setVisibleOnly(e.target.checked)} />
            visible range only
          </label>
        )}
        <button className="bp-btn" data-testid="laps-export-bundle" disabled={!entries.length} onClick={exportBundle}>
          Export bundle (.lab.json)
        </button>
        <button className="bp-btn" data-testid="laps-export-csv" disabled={!entries.length} onClick={exportCsv}>
          Export CSV
        </button>
      </div>

      {pickers.length > 0 && (
        <div className="laps-pickers" data-testid="laps-picker">
          {pickers.map((p) => {
            const s = sessions.find((x) => x.id === p.sessionId);
            if (!s) return null;
            return (
              <div className="laps-picker" key={p.sessionId} data-testid={`laps-picker-${p.sessionId}`}>
                <div className="bp-row laps-picker-head">
                  <strong>{p.base}</strong>
                  <span className="bp-label">pick laps to add ({s.laps.length} found)</span>
                  <span className="bp-spacer-flex" />
                  <button
                    className="bp-btn primary"
                    data-testid={`laps-picker-add-${p.sessionId}`}
                    disabled={!p.checked.length}
                    onClick={() => addPicked(p)}
                  >
                    Add selected
                  </button>
                  <button
                    className="bp-btn"
                    data-testid={`laps-picker-cancel-${p.sessionId}`}
                    onClick={() => setPickers((ps) => ps.filter((x) => x.sessionId !== p.sessionId))}
                  >
                    Dismiss
                  </button>
                </div>
                <div className="laps-picker-list">
                  {s.laps.map((lap) => {
                    const vmax = lapVmaxKmh(s, lap) * (unitMph ? KMH_TO_MPH : 1);
                    return (
                      <label className="laps-picker-item" key={lap.n} data-testid={`laps-pick-${p.sessionId}-${lap.n}`}>
                        <input
                          type="checkbox"
                          checked={p.checked.includes(lap.n)}
                          onChange={() => togglePick(p.sessionId, lap.n)}
                          aria-label={`Lap ${lap.n}`}
                        />
                        <span className="n">L{lap.n}</span>
                        <span className="kind">{lap.kind}</span>
                        <span className="num">{fmtLapTime(lap.timeS)}</span>
                        <span className="num dim">{Number.isFinite(vmax) ? `${vmax.toFixed(1)} ${vUnit}` : '–'}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {entries.length === 0 ? (
        <div className="bp-empty" data-testid="laps-empty">
          No laps in the workspace — tick laps in the lap table or import from a file.
        </div>
      ) : (
        <table className="bp-table laps-table">
          <thead>
            <tr>
              <th className="c" title="Colour">◧</th>
              <th className="name">Name</th>
              <th className="name">Source</th>
              <th>Time</th>
              <th className="c" title="Reference lap">◉</th>
              <th className="c">Order</th>
              <th className="c" />
            </tr>
          </thead>
          <tbody>
            {entries.map(({ s, lap, ref }, i) => {
              const key = `${ref.sessionId}:${ref.lap}`;
              const meta = lapMetaOf({ sessions, lapMeta }, ref.sessionId, ref.lap);
              const isRef = refLap?.sessionId === ref.sessionId && refLap.lap === ref.lap;
              return (
                <tr
                  key={key}
                  data-testid={`laps-row-${ref.sessionId}-${ref.lap}`}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    // only the row itself: Delete inside the name input edits text
                    if (e.key === 'Delete' && e.target === e.currentTarget) {
                      e.preventDefault();
                      useLab.getState().removeLapFromWorkspace(ref.sessionId, ref.lap);
                    }
                  }}
                >
                  <td className="c">
                    <input
                      type="color"
                      className="laps-color"
                      data-testid={`laps-color-${ref.sessionId}-${ref.lap}`}
                      value={hexColor(meta.color)}
                      aria-label={`Colour for ${meta.name}`}
                      onChange={(e) => useLab.getState().setLapMeta(ref.sessionId, ref.lap, { color: e.target.value })}
                    />
                  </td>
                  <td className="name">
                    <input
                      className="bp-input laps-name"
                      data-testid={`laps-name-${ref.sessionId}-${ref.lap}`}
                      value={draft[key] ?? meta.name}
                      aria-label={`Name for lap ${ref.lap}`}
                      onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                      onBlur={() => commitName(ref.sessionId, ref.lap, key)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          commitName(ref.sessionId, ref.lap, key);
                          (e.target as HTMLInputElement).blur();
                        }
                      }}
                    />
                  </td>
                  <td className="name dim">
                    {s.name} · L{lap.n}
                  </td>
                  <td className="num">{fmtLapTime(lap.timeS)}</td>
                  <td className="c">
                    <input
                      type="radio"
                      name="laps-panel-ref"
                      checked={isRef}
                      aria-label={`Reference lap ${ref.lap}`}
                      data-testid={`laps-ref-${ref.sessionId}-${ref.lap}`}
                      onChange={() => useLab.getState().setRefLap({ sessionId: ref.sessionId, lap: ref.lap })}
                    />
                  </td>
                  <td className="c laps-order">
                    <button
                      className="bp-btn tiny"
                      title="Move up"
                      data-testid={`laps-up-${ref.sessionId}-${ref.lap}`}
                      disabled={i === 0}
                      onClick={() => move(ref, -1)}
                    >
                      ↑
                    </button>
                    <button
                      className="bp-btn tiny"
                      title="Move down"
                      data-testid={`laps-down-${ref.sessionId}-${ref.lap}`}
                      disabled={i === entries.length - 1}
                      onClick={() => move(ref, 1)}
                    >
                      ↓
                    </button>
                  </td>
                  <td className="c">
                    <button
                      className="bp-btn tiny danger"
                      title="Remove from workspace"
                      data-testid={`laps-remove-${ref.sessionId}-${ref.lap}`}
                      onClick={() => useLab.getState().removeLapFromWorkspace(ref.sessionId, ref.lap)}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
