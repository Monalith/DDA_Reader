// Shared "open these files" flow used by the top bar, the Laps panel and the Examples menu.
import { loadBundleFromFile, loadSessionFromFile, isBundle } from '../core/sessionLoader';
import { activeTrack, SESSION_COLORS, useLab } from '../state/store';
import { ensureTrackForSession, saveTrackLocal } from '../state/trackActions';

/** Opening real data closes the bundled examples (they are just a demo). */
export function closeExamples(): void {
  const st = useLab.getState();
  for (const s of st.sessions) if (s.isExample) st.removeSession(s.id);
}

export async function openFiles(files: File[], opts: { example?: boolean } = {}): Promise<void> {
  const { addSession, setStatus } = useLab.getState();
  if (!opts.example) closeExamples();
  for (const f of files) {
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
    if (opts.example) s.isExample = true;
    addSession(s);
    ensureTrackForSession(s);
    let extra = '';
    if (s.turnHints?.length && useLab.getState().applyTurnHints(s.id)) {
      saveTrackLocal(activeTrack(useLab.getState())!);
      extra = ` · ${s.turnHints.length} turns applied to the track`;
    }
    setStatus(`${f.name}: ${s.laps.length} laps, ${(s.t[s.t.length - 1] / 60).toFixed(1)} min${extra}`);
  }
}
