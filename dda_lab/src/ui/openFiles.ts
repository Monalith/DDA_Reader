// Shared "open these files" flow used by the top bar, the Laps panel and the Examples menu.
import { loadBundleFromFile, loadSessionFromFile, isBundle } from '../core/sessionLoader';
import { activeTrack, SESSION_COLORS, useLab } from '../state/store';
import { ensureTrackForSession, saveTrackLocal } from '../state/trackActions';
import { parsePistPackage } from '../core/pistPackage';
import { isLabSessionFile, parseLabSession } from '../core/labSession';

/** Opening real data closes the bundled examples (they are just a demo). */
export function closeExamples(): void {
  const st = useLab.getState();
  for (const s of st.sessions) if (s.isExample) st.removeSession(s.id);
}

export async function openFiles(files: File[], opts: { example?: boolean; colors?: Record<string, string> } = {}): Promise<void> {
  const { addSession, setStatus } = useLab.getState();
  if (!opts.example) closeExamples();
  for (const f of files) {
    // a saved lab session ("Save session") replaces everything that is open
    if (await isLabSessionFile(f)) {
      setStatus(`Restoring session ${f.name}…`);
      try {
        const s = parseLabSession(await f.text());
        useLab.getState().restoreLabSession(s);
        const st = useLab.getState();
        setStatus(`${f.name}: ${s.sessions.length} run${s.sessions.length === 1 ? '' : 's'}, ${st.selectedLaps.length} lap${st.selectedLaps.length === 1 ? '' : 's'} in the workspace, ${st.markers.length} marker${st.markers.length === 1 ? '' : 's'} restored`);
      } catch (e) {
        setStatus(`${f.name}: ${(e as Error).message}`);
      }
      continue;
    }
    // a `.pist.json` track model (or any JSON that is one) is not a session:
    // it becomes the track and the rider's corridor
    if (await isPistPackage(f)) {
      try {
        useLab.getState().applyTrackPackage(parsePistPackage(await f.text()));
      } catch (e) {
        setStatus(`${f.name}: ${(e as Error).message}`);
      }
      continue;
    }
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
    const color = opts.colors?.[f.name] ?? SESSION_COLORS[useLab.getState().sessions.length % SESSION_COLORS.length];
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

/** A pist package by name, or by content for any other .json (version 2 with a centerline and edges). */
async function isPistPackage(f: File): Promise<boolean> {
  const name = f.name.toLowerCase();
  if (name.endsWith('.pist.json')) return true;
  if (!name.endsWith('.json')) return false;
  try {
    const head = await f.slice(0, 2048).text();
    return head.includes('"version"') && head.includes('"leftEdge"') || (head.includes('"version": 2') && head.includes('"direction"'));
  } catch {
    return false;
  }
}
