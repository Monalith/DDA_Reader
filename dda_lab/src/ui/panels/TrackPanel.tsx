// Track tab: edit the active track model — name, turn table (name / direction /
// arc-length range), merge & delete turns, add a turn at the cursor — plus
// rebuild-from-session, save to localStorage and JSON export.
//
// Every mutation goes through the store (`setTrack` / `updateTurns`, which
// renumbers turns) and is then persisted with `saveTrackLocal`, so the on-disk
// model never drifts from what the map and the charts show.
import { useEffect, useRef, useState } from 'react';
import { projectToTrack } from '../../core/track';
import type { LngLat, Session, Turn } from '../../core/types';
import {
  buildTrackFromSession,
  exportTrackJson,
  saveTrackLocal,
} from '../../state/trackActions';
import { activeTrack, useLab } from '../../state/store';

/**
 * Text/number input that keeps its own draft while focused and only reports a
 * change on blur or Enter — editing a turn name must not rebuild the track (and
 * every lap derived from it) on each keystroke.
 */
function CommitInput({
  value,
  onCommit,
  testId,
  type = 'text',
  step,
  className = 'bp-input',
  width,
  ariaLabel,
}: {
  value: string;
  onCommit: (v: string) => void;
  testId?: string;
  type?: 'text' | 'number';
  step?: number;
  className?: string;
  width?: number;
  ariaLabel?: string;
}) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);

  const commit = () => {
    if (draft !== value) onCommit(draft);
  };

  return (
    <input
      className={className}
      data-testid={testId}
      aria-label={ariaLabel}
      type={type}
      step={step}
      style={width ? { width } : undefined}
      value={draft}
      onFocus={() => {
        focused.current = true;
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        focused.current = false;
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit();
          (e.target as HTMLInputElement).blur();
        } else if (e.key === 'Escape') {
          setDraft(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

function fmtRadius(r: number): string {
  if (!Number.isFinite(r)) return '∞';
  return r >= 1000 ? `${Math.round(r)}` : r.toFixed(1);
}

/** GPS fix of a session sample, or null when there is no fix there. */
function gpsAt(s: Session, idx: number): LngLat | null {
  const lng = s.channels.get('gps_lon')?.data;
  const lat = s.channels.get('gps_lat')?.data;
  if (!lng || !lat) return null;
  const i = Math.max(0, Math.min(idx, lng.length - 1, lat.length - 1));
  if (!Number.isFinite(lng[i]) || !Number.isFinite(lat[i])) return null;
  if (lng[i] === 0 && lat[i] === 0) return null;
  return [lng[i], lat[i]];
}

export default function TrackPanel() {
  const tracks = useLab((s) => s.tracks);
  const activeTrackId = useLab((s) => s.activeTrackId);
  const sessions = useLab((s) => s.sessions);
  const cursor = useLab((s) => s.cursor);
  const track = activeTrack({ tracks, activeTrackId });

  /** Apply a turn list through the store, then persist the resulting track. */
  function commitTurns(turns: Turn[]): void {
    useLab.getState().updateTurns(turns);
    const t = activeTrack(useLab.getState());
    if (t) saveTrackLocal(t);
  }

  function patchTurn(i: number, patch: Partial<Turn>): void {
    if (!track) return;
    commitTurns(track.turns.map((t, k) => (k === i ? { ...t, ...patch } : t)));
  }

  function mergeWithNext(i: number): void {
    if (!track) return;
    const a = track.turns[i];
    const b = track.turns[i + 1];
    if (!a || !b) return;
    const merged: Turn = {
      ...a,
      name: a.name,
      apexGeo: a.radiusM <= b.radiusM ? a.apexGeo : b.apexGeo,
      radiusM: Math.min(a.radiusM, b.radiusM),
      sRange: [a.sRange[0], b.sRange[1]],
    };
    commitTurns([...track.turns.slice(0, i), merged, ...track.turns.slice(i + 2)]);
  }

  function deleteTurn(i: number): void {
    if (!track) return;
    commitTurns(track.turns.filter((_, k) => k !== i));
  }

  function rebuild(): void {
    const s = sessions.find((x) => x.laps.length > 0);
    if (!s) return;
    const built = buildTrackFromSession(s);
    if (!built) return;
    useLab.getState().setTrack(built);
    saveTrackLocal(built);
  }

  function addTurnAtCursor(): void {
    if (!track || !cursor) return;
    const s = sessions.find((x) => x.id === cursor.sessionId);
    if (!s) return;
    const p = gpsAt(s, cursor.idx);
    if (!p) return;
    const { sM } = projectToTrack(track, p);
    if (!Number.isFinite(sM)) return;
    const turn: Turn = {
      n: 0, // updateTurns() renumbers
      name: '',
      dir: 'L',
      apexGeo: p,
      radiusM: 50,
      sRange: [sM - 40, sM + 40],
    };
    const next = [...track.turns, turn].sort((a, b) => a.sRange[0] - b.sRange[0]);
    const at = next.indexOf(turn);
    turn.name = `T${at + 1}`;
    commitTurns(next);
  }

  if (!track) {
    return (
      <div className="bp-empty" data-testid="track-panel">
        No track model yet — open a session with GPS
      </div>
    );
  }

  const canAdd = Boolean(cursor && sessions.some((s) => s.id === cursor.sessionId));

  return (
    <div data-testid="track-panel" className="tp-wrap">
      <div className="bp-row tp-head">
        <span className="bp-label">Track</span>
        <CommitInput
          className="bp-input tp-name"
          testId="track-name"
          ariaLabel="Track name"
          value={track.name}
          onCommit={(name) => {
            const next = { ...track, name };
            useLab.getState().setTrack(next);
            saveTrackLocal(next);
          }}
        />
        <span className="bp-label num" data-testid="track-length">
          {(track.lengthM / 1000).toFixed(3)} km
        </span>
        <span className="bp-label num" data-testid="track-turn-count">
          {track.turns.length} turn{track.turns.length === 1 ? '' : 's'}
        </span>
        <button className="bp-btn" data-testid="track-rebuild" onClick={rebuild} disabled={!sessions.some((s) => s.laps.length > 0)}>
          Rebuild from session
        </button>
        {sessions.filter((s) => s.turnHints?.length).map((s) => (
          <button
            key={s.id}
            className="bp-btn"
            data-testid={`track-hints-${s.id}`}
            title={`Replace turns with the ${s.turnHints!.length} turns defined in ${s.name}`}
            onClick={() => {
              if (useLab.getState().applyTurnHints(s.id)) saveTrackLocal(activeTrack(useLab.getState())!);
            }}
          >
            Turns from {s.name}
          </button>
        ))}
        <button className="bp-btn" data-testid="track-save" onClick={() => saveTrackLocal(track)}>
          Save
        </button>
        <button className="bp-btn" data-testid="track-export" onClick={() => exportTrackJson(track)}>
          Export JSON
        </button>
      </div>

      <div className="tp-hint" data-testid="track-hint">
        Use 🏁 Start line on the map to move the start/finish; laps and sectors are recomputed.
      </div>

      <table className="bp-table tp-turns" data-testid="track-turns">
        <thead>
          <tr>
            <th>#</th>
            <th className="name">Name</th>
            <th>Dir</th>
            <th>Start m</th>
            <th>End m</th>
            <th>Radius m</th>
            <th className="name">Actions</th>
          </tr>
        </thead>
        <tbody>
          {track.turns.map((t, i) => (
            <tr key={`${t.n}:${t.sRange[0].toFixed(1)}`} data-testid={`turn-row-${t.n}`}>
              <td>{t.n}</td>
              <td className="name">
                <CommitInput
                  testId={`turn-name-${t.n}`}
                  ariaLabel={`Turn ${t.n} name`}
                  value={t.name}
                  width={110}
                  onCommit={(name) => patchTurn(i, { name })}
                />
              </td>
              <td>
                <select
                  className="bp-select"
                  data-testid={`turn-dir-${t.n}`}
                  aria-label={`Turn ${t.n} direction`}
                  value={t.dir}
                  onChange={(e) => patchTurn(i, { dir: e.target.value as Turn['dir'] })}
                >
                  <option value="L">L</option>
                  <option value="R">R</option>
                </select>
              </td>
              <td>
                <CommitInput
                  className="bp-input num"
                  testId={`turn-start-${t.n}`}
                  ariaLabel={`Turn ${t.n} start metres`}
                  type="number"
                  step={1}
                  width={78}
                  value={t.sRange[0].toFixed(0)}
                  onCommit={(v) => {
                    const x = Number(v);
                    if (Number.isFinite(x)) patchTurn(i, { sRange: [x, t.sRange[1]] });
                  }}
                />
              </td>
              <td>
                <CommitInput
                  className="bp-input num"
                  testId={`turn-end-${t.n}`}
                  ariaLabel={`Turn ${t.n} end metres`}
                  type="number"
                  step={1}
                  width={78}
                  value={t.sRange[1].toFixed(0)}
                  onCommit={(v) => {
                    const x = Number(v);
                    if (Number.isFinite(x)) patchTurn(i, { sRange: [t.sRange[0], x] });
                  }}
                />
              </td>
              <td data-testid={`turn-radius-${t.n}`}>{fmtRadius(t.radiusM)}</td>
              <td className="name">
                <div className="bp-row tight">
                  <button
                    className="bp-btn"
                    data-testid={`turn-merge-${t.n}`}
                    disabled={i >= track.turns.length - 1}
                    onClick={() => mergeWithNext(i)}
                    title="Merge this turn with the next one"
                  >
                    Merge with next
                  </button>
                  <button
                    className="bp-btn danger"
                    data-testid={`turn-del-${t.n}`}
                    onClick={() => deleteTurn(i)}
                    title="Delete this turn"
                  >
                    Delete
                  </button>
                </div>
              </td>
            </tr>
          ))}
          {!track.turns.length && (
            <tr>
              <td className="name" colSpan={7}>
                No turns — rebuild from a session or add one at the cursor.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="bp-row tp-foot">
        <button className="bp-btn" data-testid="turn-add-cursor" onClick={addTurnAtCursor} disabled={!canAdd}>
          Add turn at cursor
        </button>
        <span className="bp-label">
          {canAdd ? 'Uses the current chart/map cursor position.' : 'Move the cursor on a chart or the map first.'}
        </span>
      </div>
    </div>
  );
}
