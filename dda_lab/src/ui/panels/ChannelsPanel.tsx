import { useMemo, useState } from 'react';
import { autoGpsLag } from '../../core/processing';
import { presetsForChannel } from '../../core/presets';
import { DEFAULT_PROC, type Channel, type ChannelKind, type ChannelProc, type Session } from '../../core/types';
import { useLab } from '../../state/store';

/** Short human summary of a channel's processing, shown as a badge in the row. */
function procSummary(proc: ChannelProc): string {
  const parts: string[] = [];
  if (proc.source === 'gps') parts.push('GPS');
  else if (proc.source === 'blend') parts.push('blend');
  const f = proc.filter;
  if (f && f.type === 'butter') parts.push(`butter ${f.cutoffHz ?? 2} Hz`);
  else if (f && f.type === 'ma') parts.push(`ma ${f.n ?? 5}`);
  else if (f && f.type === 'sg') parts.push(`sg ${f.n ?? 9}`);
  if (proc.invert) parts.push('inv');
  if (proc.scale !== 1 || proc.offset !== 0) parts.push(`×${proc.scale}${proc.offset ? ` ${proc.offset > 0 ? '+' : ''}${proc.offset}` : ''}`);
  if (proc.gpsLagS) parts.push(`lag ${proc.gpsLagS}s`);
  return parts.length ? parts.join(' · ') : 'raw';
}

const KIND_ORDER: ChannelKind[] = ['raw', 'derived', 'math', 'external'];
const KIND_LABEL: Record<ChannelKind, string> = {
  raw: 'Raw',
  derived: 'Derived',
  math: 'Math',
  external: 'External',
};

/** Channels whose underlying source can be switched, with per-channel labels. */
const SOURCE_OPTIONS: Record<string, Array<{ value: 'wheel' | 'gps' | 'blend'; label: string }>> = {
  speed: [
    { value: 'wheel', label: 'Wheel' },
    { value: 'gps', label: 'GPS' },
    { value: 'blend', label: 'Blend' },
  ],
  dist: [
    { value: 'wheel', label: 'ECU' },
    { value: 'gps', label: 'GPS' },
  ],
};

function num(v: string, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function ProcEditor({ session, ch }: { session: Session; ch: Channel }) {
  const { setChannelProc, applyProcToAll, setStatus } = useLab.getState();
  const [proc, setProc] = useState<ChannelProc>(() => ({
    ...DEFAULT_PROC,
    ...ch.proc,
    filter: { ...ch.proc.filter },
  }));
  const patch = (p: Partial<ChannelProc>) => setProc((prev) => ({ ...prev, ...p }));
  const sources = SOURCE_OPTIONS[ch.name];
  const ftype = proc.filter?.type ?? 'none';

  function auto() {
    const wheel = session.channels.get('speed')?.data;
    const gps = session.channels.get('gps_speed')?.data;
    if (!wheel || !gps) {
      setStatus('Auto lag needs speed and gps_speed');
      return;
    }
    const dt = session.t.length > 1 ? session.t[1] - session.t[0] : 0.1;
    const lag = autoGpsLag(wheel, gps, dt);
    patch({ gpsLagS: Math.round(lag * 100) / 100 });
    setStatus(`GPS lag ≈ ${lag.toFixed(2)} s`);
  }

  return (
    <div className="ch-editor" data-testid={`ch-editor-${ch.name}`}>
      <div className="bp-row">
        {sources && (
          <>
            <span className="bp-label">Source</span>
            <select
              className="bp-select"
              data-testid="ch-source"
              value={proc.source ?? sources[0].value}
              onChange={(e) => patch({ source: e.target.value as ChannelProc['source'] })}
            >
              {sources.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </>
        )}
        <span className="bp-label">Scale</span>
        <input
          className="bp-input num"
          data-testid="ch-scale"
          type="number"
          step="0.001"
          value={proc.scale}
          onChange={(e) => patch({ scale: num(e.target.value, 1) })}
        />
        <span className="bp-label">Offset</span>
        <input
          className="bp-input num"
          data-testid="ch-offset"
          type="number"
          step="0.1"
          value={proc.offset}
          onChange={(e) => patch({ offset: num(e.target.value, 0) })}
        />
        <label className="bp-row tight">
          <input
            type="checkbox"
            data-testid="ch-invert"
            checked={Boolean(proc.invert)}
            onChange={(e) => patch({ invert: e.target.checked })}
          />
          <span className="bp-label">Invert</span>
        </label>
      </div>

      <div className="bp-row">
        <span className="bp-label">Filter</span>
        <select
          className="bp-select"
          data-testid="ch-filter"
          value={ftype}
          onChange={(e) =>
            patch({
              filter: {
                type: e.target.value as ChannelProc['filter']['type'],
                n: proc.filter?.n ?? 5,
                cutoffHz: proc.filter?.cutoffHz ?? 2,
              },
            })
          }
        >
          <option value="none">None</option>
          <option value="ma">Moving average</option>
          <option value="sg">Savitzky–Golay</option>
          <option value="butter">Butterworth</option>
        </select>
        {(ftype === 'ma' || ftype === 'sg') && (
          <>
            <span className="bp-label">{ftype === 'ma' ? 'n' : 'window'}</span>
            <input
              className="bp-input num"
              data-testid="ch-filter-n"
              type="number"
              min="1"
              step={ftype === 'sg' ? 2 : 1}
              value={proc.filter?.n ?? 5}
              onChange={(e) => patch({ filter: { ...proc.filter, type: ftype, n: Math.max(1, num(e.target.value, 5)) } })}
            />
          </>
        )}
        {ftype === 'butter' && (
          <>
            <span className="bp-label">cutoff Hz</span>
            <input
              className="bp-input num"
              data-testid="ch-filter-cutoff"
              type="number"
              min="0.05"
              step="0.05"
              value={proc.filter?.cutoffHz ?? 2}
              onChange={(e) =>
                patch({ filter: { ...proc.filter, type: 'butter', cutoffHz: Math.max(0.01, num(e.target.value, 2)) } })
              }
            />
          </>
        )}
        <span className="bp-label">GPS lag s</span>
        <input
          className="bp-input num"
          data-testid="ch-gpslag"
          type="number"
          step="0.05"
          value={proc.gpsLagS ?? 0}
          onChange={(e) => patch({ gpsLagS: num(e.target.value, 0) })}
        />
        <button className="bp-btn" data-testid="ch-gpslag-auto" onClick={auto}>
          Auto
        </button>
      </div>

      <div className="bp-row">
        <button
          className="bp-btn primary"
          data-testid="ch-apply"
          onClick={() => setChannelProc(session.id, ch.name, { ...proc, filter: { ...proc.filter } })}
        >
          Apply
        </button>
        <button
          className="bp-btn"
          data-testid="ch-reset"
          onClick={() => {
            const d: ChannelProc = { ...DEFAULT_PROC, filter: { type: 'none' } };
            setProc(d);
            setChannelProc(session.id, ch.name, d);
          }}
        >
          Reset
        </button>
        <button
          className="bp-btn"
          data-testid="ch-apply-all"
          onClick={() => applyProcToAll(ch.name, { ...proc, filter: { ...proc.filter } })}
        >
          Apply to all sessions
        </button>
      </div>
    </div>
  );
}

export default function ChannelsPanel() {
  const sessions = useLab((s) => s.sessions);
  const selectedLaps = useLab((s) => s.selectedLaps);
  const { setChannelProc, applyProcToAll } = useLab.getState();
  const [pick, setPick] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const sessionId = pick ?? selectedLaps[0]?.sessionId ?? sessions[0]?.id ?? null;
  const session = sessions.find((s) => s.id === sessionId) ?? sessions[0];

  const groups = useMemo(() => {
    const g = new Map<ChannelKind, Channel[]>();
    if (session) {
      for (const ch of session.channels.values()) {
        const list = g.get(ch.kind) ?? [];
        list.push(ch);
        g.set(ch.kind, list);
      }
      for (const list of g.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    }
    return g;
  }, [session]);

  if (!session) return <div className="bp-empty">Load a session to see its channels.</div>;

  return (
    <div data-testid="channels-panel">
      <div className="bp-row" style={{ marginBottom: 8 }}>
        <span className="bp-label">Session</span>
        <select
          className="bp-select"
          data-testid="ch-session"
          value={session.id}
          onChange={(e) => {
            setPick(e.target.value);
            setOpen(null);
          }}
        >
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <span className="bp-label num">{session.channels.size} channels</span>
      </div>

      <div className="ch-groups">
        {KIND_ORDER.filter((k) => groups.get(k)?.length).map((kind) => (
          <div key={kind}>
            <div className="ch-group-title">{KIND_LABEL[kind]}</div>
            <div className="ch-list">
              {(groups.get(kind) ?? []).map((ch) => {
                const presets = presetsForChannel(ch.name);
                const summary = procSummary(ch.proc);
                return (
                  <div key={ch.name}>
                    <div className="ch-row" data-testid={`ch-row-${ch.name}`}>
                      <span className="bp-swatch" style={{ background: ch.color || session.color }} />
                      <span className="cname">{ch.name}</span>
                      <span className="unit">{ch.unit}</span>
                      <span className="bp-badge">{KIND_LABEL[ch.kind]}</span>
                      <select
                        className="bp-select mini"
                        data-testid={`ch-preset-${ch.name}`}
                        value=""
                        title="Quick filter preset"
                        onChange={(e) => {
                          const preset = presets.find((p) => p.id === e.target.value);
                          e.currentTarget.value = '';
                          if (!preset) return;
                          const merged: ChannelProc = {
                            ...ch.proc,
                            ...preset.proc,
                            filter: { ...(preset.proc.filter ?? ch.proc.filter) },
                          };
                          setChannelProc(session.id, ch.name, merged);
                        }}
                      >
                        <option value="">Quick filter…</option>
                        {presets.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.label}
                          </option>
                        ))}
                      </select>
                      <span
                        className={`bp-badge proc${summary === 'raw' ? '' : ' on'}`}
                        data-testid={`ch-proc-${ch.name}`}
                        title="Current processing"
                      >
                        {summary}
                      </span>
                      {sessions.length > 1 && (
                        <button
                          className="bp-btn"
                          data-testid={`ch-row-apply-all-${ch.name}`}
                          title="Copy this channel's processing to every loaded session"
                          onClick={() => applyProcToAll(ch.name, { ...ch.proc, filter: { ...ch.proc.filter } })}
                        >
                          Apply to all sessions
                        </button>
                      )}
                      <button
                        className="bp-btn"
                        title="Processing"
                        data-testid={`ch-gear-${ch.name}`}
                        onClick={() => setOpen((o) => (o === ch.name ? null : ch.name))}
                      >
                        ⚙
                      </button>
                    </div>
                    {open === ch.name && (
                      <ProcEditor key={`${session.id}:${ch.name}:${summary}`} session={session} ch={ch} />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
