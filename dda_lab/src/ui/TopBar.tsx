import { useRef, useState } from 'react';
import { isBundle, loadBundleFromFile, loadSessionFromFile } from '../core/sessionLoader';
import { parseWorkspace, serializeWorkspace } from '../core/workspace';
import { activeTrack, SESSION_COLORS, useLab } from '../state/store';
import { ensureTrackForSession, saveTrackLocal } from '../state/trackActions';

function download(name: string, text: string, mime = 'application/json') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export default function TopBar() {
  const fileRef = useRef<HTMLInputElement>(null);
  const wsRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const sessions = useLab((s) => s.sessions);
  const workspace = useLab((s) => s.workspace);
  const status = useLab((s) => s.statusMessage);
  const track = useLab((s) => activeTrack(s));
  const { addSession, removeSession, setWorkspace, setStatus } = useLab.getState();

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    try {
      for (const f of Array.from(files)) {
        if (await isBundle(f)) {
          setStatus(`Loading bundle ${f.name}…`);
          const b = await loadBundleFromFile(f, activeTrack(useLab.getState()));
          if (b.track) useLab.getState().setTrack(b.track);
          useLab.setState({ workspace: b.workspace });
          b.sessions.forEach(({ session, name, color: c }, li) => {
            addSession(session);
            useLab.getState().setLapMeta(session.id, session.laps[0].n, { name, color: c });
            for (const m of b.markers.filter((x) => x.lapIndex === li)) useLab.getState().addMarker(session.id, m.idxInLap, { name: m.name, color: m.color, note: m.note });
          });
          setStatus(`${f.name}: ${b.sessions.length} laps restored`);
          continue;
        }
        const color = SESSION_COLORS[useLab.getState().sessions.length % SESSION_COLORS.length];
        setStatus(`Loading ${f.name}…`);
        const s = await loadSessionFromFile(f, color, activeTrack(useLab.getState()));
        addSession(s);
        ensureTrackForSession(s);
        let extra = '';
        if (s.turnHints?.length && useLab.getState().applyTurnHints(s.id)) {
          saveTrackLocal(activeTrack(useLab.getState())!);
          extra = ` · ${s.turnHints.length} turns applied to the track`;
        }
        setStatus(`${f.name}: ${s.laps.length} laps, ${(s.t[s.t.length - 1] / 60).toFixed(1)} min${extra}`);
      }
    } catch (e) {
      setStatus(`Error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function onWorkspaceFile(files: FileList | null) {
    if (!files?.[0]) return;
    try {
      const ws = parseWorkspace(await files[0].text());
      useLab.setState({ workspace: ws });
      setStatus('Workspace loaded');
    } catch (e) {
      setStatus(`Workspace error: ${(e as Error).message}`);
    }
  }

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-main">DDA</span>
        <span className="brand-sub">LAB</span>
      </div>
      <button className="btn primary" onClick={() => fileRef.current?.click()} disabled={busy} data-testid="open-files-btn">
        {busy ? 'Loading…' : '📂 Open sessions'}
      </button>
      <input ref={fileRef} type="file" multiple accept=".dda,.json,.csv,.lab.json" hidden data-testid="open-files" onChange={(e) => onFiles(e.target.files)} />
      <div className="chips">
        {sessions.map((s) => (
          <span className="chip" key={s.id} style={{ borderColor: s.color }}>
            <input
              type="color"
              className="chip-color"
              data-testid={`session-color-${s.id}`}
              value={/^#[0-9a-f]{6}$/i.test(s.color) ? s.color : '#ffffff'}
              title="Run colour (map trace, chart lines)"
              aria-label={`Colour for ${s.name}`}
              onChange={(e) => useLab.getState().setSessionColor(s.id, e.target.value)}
            />
            {s.name}
            <small className="num">{s.laps.filter((l) => l.kind === 'flying').length} laps</small>
            <button className="chip-x" title="Remove" onClick={() => removeSession(s.id)}>
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="spacer" />
      {track && (
        <span className="track-badge" title={`${track.turns.length} turns, ${(track.lengthM / 1000).toFixed(3)} km`}>
          🏁 {track.name}
        </span>
      )}
      <div className="seg" role="group" aria-label="X axis">
        <button className={workspace.xAxis === 'distance' ? 'on' : ''} onClick={() => setWorkspace({ xAxis: 'distance' })}>
          Distance
        </button>
        <button className={workspace.xAxis === 'time' ? 'on' : ''} onClick={() => setWorkspace({ xAxis: 'time' })}>
          Time
        </button>
      </div>
      <div className="seg" role="group" aria-label="Units">
        <button className={!workspace.unitMph ? 'on' : ''} onClick={() => setWorkspace({ unitMph: false })}>
          km/h
        </button>
        <button className={workspace.unitMph ? 'on' : ''} onClick={() => setWorkspace({ unitMph: true })}>
          mph
        </button>
      </div>
      <button className="btn" onClick={() => download('workspace.json', serializeWorkspace(workspace))} title="Save workspace">
        💾
      </button>
      <button className="btn" onClick={() => wsRef.current?.click()} title="Load workspace">
        📑
      </button>
      <input ref={wsRef} type="file" accept=".json" hidden onChange={(e) => onWorkspaceFile(e.target.files)} />
      {status && <span className="status">{status}</span>}
    </header>
  );
}
