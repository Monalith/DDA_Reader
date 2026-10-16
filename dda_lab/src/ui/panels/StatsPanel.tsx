// Usage statistics dashboard (admin only): GET /api/stats/summary (bridge/stats.py).
import { useEffect, useState, type ReactNode } from 'react';
import { apiBase, useAuth } from '../../auth/client';

interface DayRow {
  day: string;
  sessions: number;
  events: number;
  users: number;
}

export interface StatsSummary {
  days: number;
  since: string;
  totals: { events: number; sessions: number; users: number; anonymous: number };
  series: DayRow[];
  topEvents: Array<{ event: string; count: number }>;
  files: Array<{ ext: string; count: number }>;
  examples: Array<{ name: string; count: number }>;
  features: Record<string, number>;
  users: Array<{ email: string; name: string; last_seen: string; events: number }>;
}

const DAY_CHOICES = [7, 30, 90] as const;
const FEATURE_LABELS: Record<string, string> = {
  file_open: 'Files opened',
  example_open: 'Examples opened',
  lap_select: 'Lap selections',
  template_apply: 'Templates applied',
  math_add: 'Math channels',
  marker_add: 'Markers',
  sim_enable: 'Sim enabled',
  video_open: 'Videos synced',
  export: 'Exports',
};

const fmt = (n: number) => n.toLocaleString('en-US');

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function DayBars({ series }: { series: DayRow[] }) {
  // Bars stretch to the card width (preserveAspectRatio none); labels are HTML so they don't stretch.
  const H = 100;
  const n = Math.max(1, series.length);
  const max = Math.max(1, ...series.map((d) => d.sessions));
  const labelEvery = Math.ceil(n / 8);
  return (
    <div className="stats-chart">
      <div className="stats-chart-y num">
        <span>{max}</span>
        <span>{Math.round(max / 2)}</span>
        <span>0</span>
      </div>
      <div className="stats-chart-main">
        <svg className="stats-bars" viewBox={`0 0 ${n} ${H}`} preserveAspectRatio="none" role="img" aria-label="Sessions per day" data-testid="stats-bars">
          <line x1={0} x2={n} y1={H / 2} y2={H / 2} className="grid" />
          <line x1={0} x2={n} y1={H} y2={H} className="grid" />
          {series.map((d, i) => {
            const h = (d.sessions / max) * H;
            return (
              <rect key={d.day} x={i + 0.12} y={H - h} width={0.76} height={h} className="bar">
                <title>{`${d.day}: ${d.sessions} sessions · ${d.events} events · ${d.users} users`}</title>
              </rect>
            );
          })}
        </svg>
        <div className="stats-chart-x">
          {series.map((d, i) => (
            <span key={d.day}>{i % labelEvery === 0 ? d.day.slice(5) : ''}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

function SmallTable<T>({ title, rows, cols, empty }: { title: string; rows: T[]; cols: Array<[string, (r: T) => ReactNode, boolean?]>; empty: string }) {
  return (
    <div className="stats-card">
      <div className="stats-card-title">{title}</div>
      {rows.length === 0 ? (
        <div className="bp-empty">{empty}</div>
      ) : (
        <table className="bp-table">
          <thead>
            <tr>
              {cols.map(([h, , num]) => (
                <th key={h} className={num ? 'num' : 'name'}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {cols.map(([h, f, num]) => (
                  <td key={h} className={num ? 'num' : 'name'}>
                    {f(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function StatsPanel() {
  const auth = useAuth();
  const [days, setDays] = useState<number>(30);
  const [data, setData] = useState<StatsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const isAdmin = auth.user?.role === 'admin';

  useEffect(() => {
    if (!isAdmin) return;
    let alive = true;
    setBusy(true);
    setError(null);
    fetch(`${apiBase()}/api/stats/summary?days=${days}`, { credentials: 'include' })
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 403 ? 'admin only' : `HTTP ${r.status}`);
        return (await r.json()) as StatsSummary;
      })
      .then((j) => alive && setData(j))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
  }, [days, isAdmin, reload]);

  if (auth.loading) return <div className="bp-empty">Loading…</div>;
  if (!isAdmin) return <div className="bp-empty" data-testid="stats-admin-only">Usage statistics: admin only.</div>;

  const t = data?.totals;
  return (
    <div className="stats-panel" data-testid="stats-panel">
      <div className="bp-row">
        <strong>Usage statistics</strong>
        <span className="bp-label">Last</span>
        <div className="stats-days" role="group" aria-label="Period">
          {DAY_CHOICES.map((d) => (
            <button key={d} className={`bp-btn${days === d ? ' primary' : ''}`} onClick={() => setDays(d)} data-testid={`stats-days-${d}`}>
              {d} d
            </button>
          ))}
        </div>
        <button className="bp-btn" onClick={() => setReload((n) => n + 1)} disabled={busy}>
          {busy ? 'Loading…' : 'Refresh'}
        </button>
        {error && <span className="bp-err">Could not load: {error}</span>}
      </div>

      <div className="stats-kpis">
        {(
          [
            ['Sessions', t?.sessions],
            ['Signed-in users', t?.users],
            ['Anonymous visitors', t?.anonymous],
            ['Events', t?.events],
          ] as Array<[string, number | undefined]>
        ).map(([label, v]) => (
          <div key={label} className="stats-kpi" data-testid={`stats-kpi-${label.split(' ')[0].toLowerCase()}`}>
            <div className="v num">{v === undefined ? '–' : fmt(v)}</div>
            <div className="l">{label}</div>
          </div>
        ))}
      </div>

      {data && (
        <>
          <div className="stats-card">
            <div className="stats-card-title">Sessions per day (since {data.since})</div>
            <DayBars series={data.series} />
          </div>
          <div className="stats-grid">
            <SmallTable
              title="Feature usage"
              rows={Object.entries(data.features)}
              cols={[
                ['Feature', ([k]) => FEATURE_LABELS[k] ?? k],
                ['Count', ([, n]) => fmt(n), true],
              ]}
              empty="No data"
            />
            <SmallTable
              title="Top events"
              rows={data.topEvents}
              cols={[
                ['Event', (r) => <span className="bp-mono">{r.event}</span>],
                ['Count', (r) => fmt(r.count), true],
              ]}
              empty="No events yet"
            />
            <SmallTable
              title="Files opened (by type)"
              rows={data.files}
              cols={[
                ['Type', (r) => <span className="bp-mono">.{r.ext}</span>],
                ['Count', (r) => fmt(r.count), true],
              ]}
              empty="No files opened"
            />
            <SmallTable
              title="Examples opened"
              rows={data.examples}
              cols={[
                ['Example', (r) => r.name],
                ['Count', (r) => fmt(r.count), true],
              ]}
              empty="No examples opened"
            />
          </div>
          <SmallTable
            title="Signed-in users"
            rows={data.users}
            cols={[
              ['E-mail', (r) => r.email],
              ['Name', (r) => r.name || '–'],
              ['Last seen', (r) => fmtWhen(r.last_seen)],
              ['Events', (r) => fmt(r.events), true],
            ]}
            empty="No signed-in users in this period"
          />
        </>
      )}
    </div>
  );
}
