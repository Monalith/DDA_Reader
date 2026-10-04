import { plausibleFlyingLaps } from '../core/laps';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { Lap, Session } from '../core/types';
import { useLab } from '../state/store';
import { fmtDelta, fmtLapTime, shade } from '../state/selectors';
import './charts.css';

const KMH_TO_MPH = 0.621371;

type SortKey = 'lap' | 'time' | 'vmax';

interface Row {
  sessionId: string;
  sessionName: string;
  sessionIdx: number;
  color: string;
  lap: Lap;
  vmaxKmh: number;
  deltaS: number;
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

function buildRows(sessions: Session[]): Row[] {
  const rows: Row[] = [];
  sessions.forEach((s, sessionIdx) => {
    // Δ against the session's best plausible lap (isBest), not the raw minimum
    let bestFlying = s.laps.find((l) => l.isBest)?.timeS ?? Infinity;
    if (!Number.isFinite(bestFlying)) for (const l of s.laps) if (l.kind === 'flying' && Number.isFinite(l.timeS) && l.timeS < bestFlying) bestFlying = l.timeS;
    s.laps.forEach((lap, li) => {
      const factor = s.laps.length > 1 ? 1.25 - (li / Math.max(1, s.laps.length - 1)) * 0.5 : 1;
      rows.push({
        sessionId: s.id,
        sessionName: s.name,
        sessionIdx,
        color: shade(s.color, factor),
        lap,
        vmaxKmh: lapVmaxKmh(s, lap),
        deltaS: Number.isFinite(bestFlying) && Number.isFinite(lap.timeS) ? lap.timeS - bestFlying : NaN,
      });
    });
  });
  return rows;
}

function cmpNum(a: number, b: number): number {
  const af = Number.isFinite(a);
  const bf = Number.isFinite(b);
  if (!af && !bf) return 0;
  if (!af) return 1;
  if (!bf) return -1;
  return a - b;
}

export default function LapTable() {
  const sessions = useLab((s) => s.sessions);
  const selectedLaps = useLab((s) => s.selectedLaps);
  const refLap = useLab((s) => s.refLap);
  const unitMph = useLab((s) => s.workspace.unitMph);
  const toggleLap = useLab((s) => s.toggleLap);
  const selectOnlyLap = useLab((s) => s.selectOnlyLap);
  const deleteLap = useLab((s) => s.deleteLap);
  const setRefLap = useLab((s) => s.setRefLap);

  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'lap', dir: 1 });
  const [focusIdx, setFocusIdx] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => buildRows(sessions), [sessions]);
  const plausible = useMemo(() => new Set(sessions.flatMap((s) => plausibleFlyingLaps(s.laps))), [sessions]);

  const sorted = useMemo(() => {
    const out = [...rows];
    out.sort((a, b) => {
      let c = 0;
      if (sort.key === 'lap') c = a.sessionIdx - b.sessionIdx || a.lap.n - b.lap.n;
      else if (sort.key === 'time') c = cmpNum(a.lap.timeS, b.lap.timeS);
      else c = cmpNum(b.vmaxKmh, a.vmaxKmh); // vmax: bigger first for dir=1
      return c * sort.dir;
    });
    return out;
  }, [rows, sort]);

  const isSelected = useCallback(
    (r: Row) => selectedLaps.some((l) => l.sessionId === r.sessionId && l.lap === r.lap.n),
    [selectedLaps],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && sorted[focusIdx]) {
        e.preventDefault();
        const r = sorted[focusIdx];
        deleteLap(r.sessionId, r.lap.n);
        setFocusIdx(Math.max(0, Math.min(focusIdx, sorted.length - 2)));
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      if (!sorted.length) return;
      const next = Math.min(sorted.length - 1, Math.max(0, focusIdx + (e.key === 'ArrowDown' ? 1 : -1)));
      setFocusIdx(next);
      const r = sorted[next];
      selectOnlyLap(r.sessionId, r.lap.n);
      const tr = scrollRef.current?.querySelectorAll('tbody tr')[next];
      (tr as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
    },
    [focusIdx, sorted, selectOnlyLap, deleteLap],
  );

  const header = (key: SortKey, label: string, cls = '') => (
    <th
      className={`sortable ${cls} ${sort.key === key ? 'sorted' : ''}`}
      onClick={() => setSort((s) => ({ key, dir: s.key === key ? ((s.dir * -1) as 1 | -1) : 1 }))}
      title={`Sort by ${label}`}
    >
      {label}
      {sort.key === key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
    </th>
  );

  const vUnit = unitMph ? 'mph' : 'km/h';
  const flying = rows.filter((r) => r.lap.kind === 'flying').length;

  return (
    <div className="lap-table-wrap">
      <div className="lap-table-head">
        <span>
          Laps <strong>{rows.length}</strong>
        </span>
        <span>
          flying <strong>{flying}</strong>
        </span>
        <span>
          sessions <strong>{sessions.length}</strong>
        </span>
        <span>
          selected <strong>{selectedLaps.length}</strong>
        </span>
      </div>
      <div className="lap-table-scroll" ref={scrollRef} tabIndex={0} onKeyDown={onKeyDown} aria-label="Lap table">
        {rows.length === 0 ? (
          <div className="lap-table-empty">No laps yet — open a session.</div>
        ) : (
          <table className="lap-table">
            <thead>
              <tr>
                <th className="c" title="Overlay">◻</th>
                <th className="c" title="Reference lap">◉</th>
                <th className="l" />
                {header('lap', 'Lap', 'l')}
                <th className="l">Kind</th>
                {header('time', 'Time')}
                <th>S1</th>
                <th>S2</th>
                <th>S3</th>
                <th>Δbest</th>
                {header('vmax', `Vmax (${vUnit})`)}
                <th className="c" title="Delete lap" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, i) => {
                const sel = isSelected(r);
                const isRef = refLap?.sessionId === r.sessionId && refLap.lap === r.lap.n;
                const sec = r.lap.sectorsS ?? [];
                const vmax = Number.isFinite(r.vmaxKmh) ? r.vmaxKmh * (unitMph ? KMH_TO_MPH : 1) : NaN;
                return (
                  <tr
                    key={`${r.sessionId}:${r.lap.n}`}
                    className={`${sel ? 'sel' : ''} ${i === focusIdx ? 'focused' : ''} ${r.lap.kind}`}
                    onClick={(e) => {
                      setFocusIdx(i);
                      if (e.shiftKey) toggleLap(r.sessionId, r.lap.n);
                      else selectOnlyLap(r.sessionId, r.lap.n);
                    }}
                    title={`${r.sessionName} — lap ${r.lap.n}`}
                  >
                    <td className="c">
                      <input
                        type="checkbox"
                        checked={sel}
                        aria-label={`Overlay lap ${r.lap.n}`}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggleLap(r.sessionId, r.lap.n)}
                      />
                    </td>
                    <td className="c">
                      <input
                        type="radio"
                        name="lab-ref-lap"
                        checked={isRef}
                        aria-label={`Reference lap ${r.lap.n}`}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => setRefLap({ sessionId: r.sessionId, lap: r.lap.n })}
                      />
                    </td>
                    <td className="l">
                      <span className="lap-sw" style={{ background: r.color }} />
                    </td>
                    <td className="l">
                      {r.lap.n}
                      {r.lap.isBest ? ' 🏆' : ''}
                    </td>
                    <td className="l">
                      <span className={`lap-kind ${r.lap.kind === 'flying' && !plausible.has(r.lap) ? 'dim' : ''}`} title={r.lap.kind === 'flying' && !plausible.has(r.lap) ? 'Implausible lap time (cut lap, pit or merged-run gap)' : undefined}>
                        {r.lap.kind === 'flying' && !plausible.has(r.lap) ? 'flying*' : r.lap.kind}
                      </span>
                    </td>
                    <td>{fmtLapTime(r.lap.timeS)}</td>
                    <td>{Number.isFinite(sec[0]) ? sec[0].toFixed(2) : '–'}</td>
                    <td>{Number.isFinite(sec[1]) ? sec[1].toFixed(2) : '–'}</td>
                    <td>{Number.isFinite(sec[2]) ? sec[2].toFixed(2) : '–'}</td>
                    <td className={`lap-delta ${Number.isFinite(r.deltaS) ? (r.deltaS <= 0 ? 'good' : 'bad') : ''}`}>
                      {fmtDelta(r.deltaS)}
                    </td>
                    <td>{Number.isFinite(vmax) ? vmax.toFixed(1) : '–'}</td>
                    <td className="c">
                      <button
                        className="lap-del"
                        data-testid={`lap-del-${r.sessionId}-${r.lap.n}`}
                        title="Delete this lap from the session (Delete key on a selected row)"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteLap(r.sessionId, r.lap.n);
                        }}
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
    </div>
  );
}
