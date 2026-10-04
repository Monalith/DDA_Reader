import { useMemo } from 'react';
import { useLab } from '../../state/store';
import {
  allChannelNames,
  cursorIdxFromX,
  fmtLapTime,
  lapLabel,
  selectedLapEntries,
  xFromIdx,
} from '../../state/selectors';

function fmt(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return '–';
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 100) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

export default function CursorPanel() {
  const sessions = useLab((s) => s.sessions);
  const selectedLaps = useLab((s) => s.selectedLaps);
  const cursor = useLab((s) => s.cursor);
  const xAxis = useLab((s) => s.workspace.xAxis);

  const entries = useMemo(() => selectedLapEntries({ sessions, selectedLaps }), [sessions, selectedLaps]);
  const names = useMemo(() => allChannelNames(sessions), [sessions]);

  /** Lap-relative x of the cursor, used to line every selected lap up with it. */
  const cursorX = useMemo(() => {
    if (!cursor) return null;
    const s = sessions.find((x) => x.id === cursor.sessionId);
    if (!s) return null;
    const hit = xFromIdx(s, cursor.idx, xAxis);
    return hit ? hit.x : null;
  }, [cursor, sessions, xAxis]);

  const cols = useMemo(() => {
    const multi = new Set(entries.map((e) => e.s.id)).size > 1;
    return entries.map(({ s, lap }) => {
      let idx: number;
      if (cursor && cursor.sessionId === s.id && cursor.idx >= lap.startIdx && cursor.idx <= lap.endIdx) {
        idx = cursor.idx;
      } else if (cursorX !== null) {
        idx = cursorIdxFromX(s, lap, cursorX, xAxis);
      } else {
        idx = lap.startIdx;
      }
      idx = Math.min(lap.endIdx, Math.max(lap.startIdx, idx));
      return {
        key: `${s.id}:${lap.n}`,
        header: multi ? `${s.name} L${lap.n}` : lapLabel(s, lap, true),
        color: s.color,
        session: s,
        lap,
        idx,
        lapTimeS: s.t[idx] - s.t[lap.startIdx],
        distM: s.channels.get('lap_dist')?.data[idx],
      };
    });
  }, [entries, cursor, cursorX, xAxis]);

  if (!sessions.length) return <div className="bp-empty">Load a session.</div>;
  if (!cols.length) return <div className="bp-empty">Select at least one lap to see cursor values.</div>;

  return (
    <div data-testid="cursor-panel">
      <div className="bp-row" style={{ marginBottom: 6 }}>
        <span className="bp-label">
          Cursor {cursor ? `@ idx ${cursor.idx}` : '— hover a chart or the map'} · x axis {xAxis}
        </span>
      </div>
      <table className="bp-table" data-testid="cursor-table">
        <thead>
          <tr>
            <th className="name">Channel</th>
            {cols.map((c) => (
              <th key={c.key} style={{ color: c.color }}>
                {c.header}
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
            <tr key={n} data-testid={`cursor-row-${n}`}>
              <td className="name">{n}</td>
              {cols.map((c) => (
                <td key={c.key}>{fmt(c.session.channels.get(n)?.data[c.idx])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
