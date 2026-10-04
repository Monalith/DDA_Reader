import { useEffect, useMemo, useRef, useState } from 'react';
import {
  gearUsagePct,
  ggPoints,
  histogram,
  leanVsThrottle,
  sectorTable,
  timeLossSummary,
  toCsv,
} from '../../core/reports';
import { turnMetrics } from '../../core/track';
import type { Lap, Session, TurnMetrics } from '../../core/types';
import { activeTrack, useLab } from '../../state/store';
import { findLap, fmtLapTime, selectedLapEntries } from '../../state/selectors';

type Sub = 'sector' | 'turns' | 'hist' | 'gg' | 'leantps' | 'loss';
const SUBS: Array<{ id: Sub; label: string }> = [
  { id: 'sector', label: 'Sector' },
  { id: 'turns', label: 'Turns' },
  { id: 'hist', label: 'Histograms' },
  { id: 'gg', label: 'G-G' },
  { id: 'leantps', label: 'Lean×TPS' },
  { id: 'loss', label: 'Time loss' },
];

type Rows = (string | number)[][];

const LEAN_BINS = Array.from({ length: 13 }, (_, i) => -60 + i * 10); // 10° bins
const TPS_BINS = [0, 20, 40, 60, 80, 100]; // 20 % bins
const RPM_BINS = Array.from({ length: 27 }, (_, i) => i * 500); // 500 rpm bins
const TPS_HIST_BINS = Array.from({ length: 11 }, (_, i) => i * 10); // 10 % bins

// ---------------------------------------------------------------------------
// download helpers
// ---------------------------------------------------------------------------
function saveBlob(name: string, blob: Blob): void {
  if (typeof document === 'undefined') return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function saveDataUrl(name: string, dataUrl: string): void {
  if (typeof document === 'undefined') return;
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = name;
  a.click();
}

/** Render a table of rows onto a canvas so table reports can be exported as PNG too. */
function rowsToPngDataUrl(rows: Rows): string | null {
  if (typeof document === 'undefined' || !rows.length) return null;
  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d');
  if (!ctx) return null;
  const pad = 8;
  const rowH = 18;
  ctx.font = '12px ui-monospace, Menlo, monospace';
  const nCols = Math.max(...rows.map((r) => r.length));
  const widths: number[] = [];
  for (let c = 0; c < nCols; c++) {
    let w = 0;
    for (const r of rows) w = Math.max(w, ctx.measureText(String(r[c] ?? '')).width);
    widths.push(Math.ceil(w) + 14);
  }
  cv.width = widths.reduce((a, b) => a + b, 0) + pad * 2;
  cv.height = rows.length * rowH + pad * 2;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#0e1116';
  g.fillRect(0, 0, cv.width, cv.height);
  g.font = '12px ui-monospace, Menlo, monospace';
  g.textBaseline = 'middle';
  rows.forEach((r, i) => {
    g.fillStyle = i === 0 ? '#8b95a5' : '#e6e9ef';
    let x = pad;
    for (let c = 0; c < nCols; c++) {
      g.fillText(String(r[c] ?? ''), x, pad + i * rowH + rowH / 2);
      x += widths[c];
    }
  });
  return cv.toDataURL('image/png');
}

/** Stitch every canvas inside a container horizontally into one PNG. */
function canvasesToPngDataUrl(root: HTMLElement): string | null {
  const list = Array.from(root.querySelectorAll('canvas')) as HTMLCanvasElement[];
  if (!list.length) return null;
  if (list.length === 1) return list[0].toDataURL('image/png');
  const gap = 10;
  const w = list.reduce((a, c) => a + c.width, 0) + gap * (list.length - 1);
  const h = Math.max(...list.map((c) => c.height));
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const g = out.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#0e1116';
  g.fillRect(0, 0, w, h);
  let x = 0;
  for (const c of list) {
    g.drawImage(c, x, 0);
    x += c.width + gap;
  }
  return out.toDataURL('image/png');
}

// ---------------------------------------------------------------------------
// canvas chart primitive
// ---------------------------------------------------------------------------
function ChartCanvas({
  caption,
  width = 320,
  height = 170,
  draw,
  testid,
}: {
  caption: string;
  width?: number;
  height?: number;
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void;
  testid?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#0e1116';
    ctx.fillRect(0, 0, width, height);
    draw(ctx, width, height);
  }, [draw, width, height]);
  return (
    <div className="rp-chart">
      <canvas ref={ref} width={width} height={height} data-testid={testid} />
      <span className="cap">{caption}</span>
    </div>
  );
}

function barChart(labels: string[], values: number[], unit: string) {
  return (ctx: CanvasRenderingContext2D, w: number, h: number) => {
    const pad = { l: 30, r: 6, t: 8, b: 20 };
    const max = Math.max(1e-9, ...values);
    const iw = w - pad.l - pad.r;
    const ih = h - pad.t - pad.b;
    ctx.strokeStyle = '#262d37';
    ctx.beginPath();
    ctx.moveTo(pad.l, pad.t);
    ctx.lineTo(pad.l, pad.t + ih);
    ctx.lineTo(pad.l + iw, pad.t + ih);
    ctx.stroke();
    ctx.fillStyle = '#8b95a5';
    ctx.font = '9px sans-serif';
    ctx.fillText(`${max.toFixed(max < 10 ? 1 : 0)}${unit}`, 2, pad.t + 7);
    const bw = iw / Math.max(1, values.length);
    values.forEach((v, i) => {
      const bh = (v / max) * ih;
      ctx.fillStyle = '#ff6a00';
      ctx.fillRect(pad.l + i * bw + 1, pad.t + ih - bh, Math.max(1, bw - 2), bh);
    });
    ctx.fillStyle = '#8b95a5';
    const every = Math.ceil(labels.length / 8);
    labels.forEach((l, i) => {
      if (i % every) return;
      ctx.fillText(l, pad.l + i * bw, h - 6);
    });
  };
}

// ---------------------------------------------------------------------------
const TURN_METRICS: Array<{ id: keyof TurnMetrics; label: string; higherBetter: boolean; digits: number }> = [
  { id: 'entryKmh', label: 'Entry km/h', higherBetter: true, digits: 1 },
  { id: 'apexKmh', label: 'Apex km/h', higherBetter: true, digits: 1 },
  { id: 'exitKmh', label: 'Exit km/h', higherBetter: true, digits: 1 },
  { id: 'maxLeanDeg', label: 'Max lean °', higherBetter: true, digits: 1 },
  { id: 'brakeDistM', label: 'Brake dist m', higherBetter: false, digits: 1 },
  { id: 'throttleOnDistM', label: 'Throttle-on m', higherBetter: false, digits: 1 },
  { id: 'apexDevM', label: 'Apex dev m', higherBetter: false, digits: 2 },
];

function concatLap(s: Session, name: string, laps: Lap[]): Float32Array {
  const ch = s.channels.get(name)?.data;
  if (!ch) return new Float32Array(0);
  const total = laps.reduce((a, l) => a + (l.endIdx - l.startIdx + 1), 0);
  const out = new Float32Array(total);
  let k = 0;
  for (const l of laps) {
    for (let i = l.startIdx; i <= l.endIdx; i++) out[k++] = ch[i];
  }
  return out;
}

export default function ReportsPanel() {
  const sessions = useLab((s) => s.sessions);
  const selectedLaps = useLab((s) => s.selectedLaps);
  const refLapRef = useLab((s) => s.refLap);
  const track = useLab((s) => activeTrack(s));
  const [sub, setSub] = useState<Sub>('sector');
  const [metric, setMetric] = useState<keyof TurnMetrics>('apexKmh');
  const [pick, setPick] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const sessionId = pick ?? selectedLaps[0]?.sessionId ?? sessions[0]?.id ?? null;
  const session = sessions.find((s) => s.id === sessionId) ?? sessions[0];

  const laps = useMemo(() => {
    if (!session) return [];
    return selectedLapEntries({ sessions, selectedLaps })
      .filter((e) => e.s.id === session.id)
      .map((e) => e.lap);
  }, [sessions, selectedLaps, session]);

  // --- sector -------------------------------------------------------------
  const sector = useMemo(() => (session ? sectorTable(session) : null), [session]);
  const sectorRows = useMemo<Rows>(() => {
    if (!sector) return [];
    const n = sector.sectors[0]?.length ?? 0;
    const head = ['Lap', ...Array.from({ length: n }, (_, i) => `S${i + 1}`), 'Total'];
    const body = sector.laps.map((lapN, i) => {
      const row = sector.sectors[i] ?? [];
      const total = row.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
      return [lapN, ...row.map((v) => (Number.isFinite(v) ? v.toFixed(2) : '')), total.toFixed(2)];
    });
    return [head, ...body, [], ['Theoretical best', sector.theoreticalBest.toFixed(2)], ['Sigma', sector.sigma.toFixed(3)]];
  }, [sector]);

  // --- turns --------------------------------------------------------------
  const turnTable = useMemo(() => {
    if (!session || !track || !track.turns.length || !laps.length) return null;
    const perLap = laps.map((lap) => {
      let m: TurnMetrics[] = [];
      try {
        m = turnMetrics(session, lap, track);
      } catch {
        m = [];
      }
      return { lap, byTurn: new Map(m.map((x) => [x.turn, x])) };
    });
    return perLap;
  }, [session, track, laps]);

  const turnRows = useMemo<Rows>(() => {
    if (!turnTable || !track) return [];
    const spec = TURN_METRICS.find((m) => m.id === metric)!;
    const head = ['Turn', ...turnTable.map((p) => `L${p.lap.n}`)];
    const body = track.turns.map((t) => [
      `T${t.n}`,
      ...turnTable.map((p) => {
        const v = p.byTurn.get(t.n)?.[metric];
        return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(spec.digits) : '';
      }),
    ]);
    return [[spec.label], head, ...body];
  }, [turnTable, track, metric]);

  // --- histograms ---------------------------------------------------------
  const hist = useMemo(() => {
    if (!session || !laps.length) return null;
    const gear = concatLap(session, 'gear', laps);
    const rpm = concatLap(session, 'rpm', laps);
    const tps = concatLap(session, 'tps', laps);
    const gearPct = gear.length ? gearUsagePct(gear) : {};
    return {
      gearLabels: Object.keys(gearPct).sort((a, b) => Number(a) - Number(b)),
      gearPct,
      rpm: rpm.length ? histogram(rpm, RPM_BINS) : [],
      tps: tps.length ? histogram(tps, TPS_HIST_BINS) : [],
    };
  }, [session, laps]);

  const histRows = useMemo<Rows>(() => {
    if (!hist) return [];
    const rows: Rows = [['Gear', 'Usage %']];
    for (const g of hist.gearLabels) rows.push([g, (hist.gearPct[Number(g)] ?? 0).toFixed(1)]);
    rows.push([], ['RPM bin', 'Samples']);
    hist.rpm.forEach((c, i) => rows.push([RPM_BINS[i] ?? '', c]));
    rows.push([], ['TPS bin %', 'Samples']);
    hist.tps.forEach((c, i) => rows.push([TPS_HIST_BINS[i] ?? '', c]));
    return rows;
  }, [hist]);

  // --- G-G ----------------------------------------------------------------
  const gg = useMemo(() => {
    if (!session || !laps.length) return [];
    return laps.map((lap) => {
      let pts: [number, number][] = [];
      try {
        pts = ggPoints(session, lap);
      } catch {
        pts = [];
      }
      return { lap, pts };
    });
  }, [session, laps]);

  const ggRows = useMemo<Rows>(() => {
    const rows: Rows = [['lap', 'lat_g', 'long_g']];
    for (const { lap, pts } of gg) for (const p of pts) rows.push([lap.n, p[0].toFixed(3), p[1].toFixed(3)]);
    return rows;
  }, [gg]);

  // --- lean × tps ---------------------------------------------------------
  const heat = useMemo(() => {
    if (!session || !laps.length) return null;
    let acc: number[][] | null = null;
    for (const lap of laps) {
      let m: number[][] = [];
      try {
        m = leanVsThrottle(session, lap, LEAN_BINS, TPS_BINS);
      } catch {
        m = [];
      }
      if (!m.length) continue;
      if (!acc) acc = m.map((r) => r.slice());
      else for (let i = 0; i < m.length; i++) for (let j = 0; j < m[i].length; j++) acc[i][j] += m[i][j];
    }
    return acc;
  }, [session, laps]);

  const heatRows = useMemo<Rows>(() => {
    if (!heat) return [];
    const head = ['lean / tps', ...TPS_BINS.map((b) => `${b}%`)];
    return [head, ...heat.map((row, i) => [`${LEAN_BINS[i] ?? ''}°`, ...row])];
  }, [heat]);

  // --- time loss ----------------------------------------------------------
  const refLap = useMemo(() => {
    if (!refLapRef) return null;
    const s = sessions.find((x) => x.id === refLapRef.sessionId);
    if (!s) return null;
    const lap = findLap(s, refLapRef.lap);
    return lap ? { s, lap } : null;
  }, [refLapRef, sessions]);

  const loss = useMemo(() => {
    if (!session || !track || !refLap || !laps.length) return null;
    if (!session.channels.has('delta_t')) return null;
    return laps.map((lap) => {
      let items: { turn: number; lossS: number }[] = [];
      try {
        items = timeLossSummary(session, lap, refLap.lap, track);
      } catch {
        items = [];
      }
      return { lap, items };
    });
  }, [session, track, refLap, laps]);

  const lossRows = useMemo<Rows>(() => {
    if (!loss) return [];
    const rows: Rows = [['lap', 'turn', 'loss_s']];
    for (const { lap, items } of loss) for (const it of items) rows.push([lap.n, `T${it.turn}`, it.lossS.toFixed(3)]);
    return rows;
  }, [loss]);

  const rows: Rows =
    sub === 'sector'
      ? sectorRows
      : sub === 'turns'
        ? turnRows
        : sub === 'hist'
          ? histRows
          : sub === 'gg'
            ? ggRows
            : sub === 'leantps'
              ? heatRows
              : lossRows;

  function exportCsv() {
    if (!rows.length) return;
    saveBlob(`${session?.name ?? 'report'}-${sub}.csv`, new Blob([toCsv(rows)], { type: 'text/csv' }));
  }

  function exportPng() {
    const base = `${session?.name ?? 'report'}-${sub}.png`;
    const fromCanvas = bodyRef.current ? canvasesToPngDataUrl(bodyRef.current) : null;
    const url = fromCanvas ?? rowsToPngDataUrl(rows);
    if (url) saveDataUrl(base, url);
  }

  if (!session) return <div className="bp-empty">Load a session to see reports.</div>;

  return (
    <div data-testid="reports-panel">
      <div className="bp-row rp-subtabs" style={{ marginBottom: 8 }}>
        {SUBS.map((x) => (
          <button
            key={x.id}
            className={`bp-btn ${sub === x.id ? 'on' : ''}`}
            data-testid={`rp-sub-${x.id}`}
            onClick={() => setSub(x.id)}
          >
            {x.label}
          </button>
        ))}
        <span className="bp-spacer" style={{ flex: 1 }} />
        <select className="bp-select" data-testid="rp-session" value={session.id} onChange={(e) => setPick(e.target.value)}>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <button className="bp-btn" data-testid="rp-export-csv" onClick={exportCsv} disabled={!rows.length}>
          Export CSV
        </button>
        <button className="bp-btn" data-testid="rp-export-png" onClick={exportPng}>
          PNG
        </button>
      </div>

      <div ref={bodyRef} data-testid={`rp-body-${sub}`}>
        {sub === 'sector' &&
          (sector && sector.laps.length ? (
            <table className="bp-table" data-testid="rp-sector-table">
              <thead>
                <tr>
                  <th className="name">Lap</th>
                  {Array.from({ length: sector.sectors[0]?.length ?? 0 }, (_, i) => (
                    <th key={i}>S{i + 1}</th>
                  ))}
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {sector.laps.map((lapN, i) => {
                  const row = sector.sectors[i] ?? [];
                  const total = row.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
                  const bestTotal = Math.min(
                    ...sector.sectors.map((r) => r.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0)),
                  );
                  return (
                    <tr key={lapN}>
                      <td className="name">{lapN}</td>
                      {row.map((v, j) => (
                        <td key={j} className={v === sector.bestPerSector[j] ? 'best' : ''}>
                          {Number.isFinite(v) ? v.toFixed(2) : '–'}
                        </td>
                      ))}
                      <td className={Math.abs(total - bestTotal) < 1e-6 ? 'best' : ''}>{fmtLapTime(total)}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td className="name">Theoretical best</td>
                  <td colSpan={(sector.sectors[0]?.length ?? 0) + 1}>
                    {fmtLapTime(sector.theoreticalBest)} · σ {sector.sigma.toFixed(3)} s
                  </td>
                </tr>
              </tfoot>
            </table>
          ) : (
            <div className="bp-empty">No sector times — a track with sector gates is needed.</div>
          ))}

        {sub === 'turns' &&
          (turnTable && track ? (
            <>
              <div className="bp-row" style={{ marginBottom: 6 }}>
                <span className="bp-label">Metric</span>
                <select
                  className="bp-select"
                  data-testid="rp-turn-metric"
                  value={metric}
                  onChange={(e) => setMetric(e.target.value as keyof TurnMetrics)}
                >
                  {TURN_METRICS.map((m) => (
                    <option key={String(m.id)} value={String(m.id)}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
              <table className="bp-table" data-testid="rp-turn-table">
                <thead>
                  <tr>
                    <th className="name">Turn</th>
                    {turnTable.map((p) => (
                      <th key={p.lap.n}>L{p.lap.n}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {track.turns.map((t) => {
                    const spec = TURN_METRICS.find((m) => m.id === metric)!;
                    const vals = turnTable.map((p) => {
                      const v = p.byTurn.get(t.n)?.[metric];
                      return typeof v === 'number' && Number.isFinite(v) ? v : NaN;
                    });
                    const finite = vals.filter((v) => Number.isFinite(v));
                    const best = finite.length ? (spec.higherBetter ? Math.max(...finite) : Math.min(...finite)) : NaN;
                    const span = finite.length ? Math.max(...finite) - Math.min(...finite) || 1 : 1;
                    return (
                      <tr key={t.n}>
                        <td className="name">
                          T{t.n} {t.dir}
                        </td>
                        {vals.map((v, i) => {
                          const gap = Number.isFinite(v) ? Math.abs(v - best) / span : 0;
                          return (
                            <td
                              key={i}
                              className={Number.isFinite(v) && v === best ? 'best' : ''}
                              style={
                                Number.isFinite(v) && v !== best
                                  ? { color: `hsl(${Math.round(90 - gap * 90)} 70% 62%)` }
                                  : undefined
                              }
                            >
                              {Number.isFinite(v) ? v.toFixed(spec.digits) : '–'}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          ) : (
            <div className="bp-empty">Turn metrics need an active track and at least one selected lap.</div>
          ))}

        {sub === 'hist' &&
          (hist ? (
            <div className="rp-charts">
              <ChartCanvas
                testid="rp-hist-gear"
                caption="Gear usage %"
                draw={barChart(
                  hist.gearLabels,
                  hist.gearLabels.map((g) => hist.gearPct[Number(g)] ?? 0),
                  '%',
                )}
              />
              <ChartCanvas
                testid="rp-hist-rpm"
                caption="RPM (500 rpm bins)"
                draw={barChart(hist.rpm.map((_, i) => String(RPM_BINS[i] ?? '')), hist.rpm, '')}
              />
              <ChartCanvas
                testid="rp-hist-tps"
                caption="TPS (10 % bins)"
                draw={barChart(hist.tps.map((_, i) => String(TPS_HIST_BINS[i] ?? '')), hist.tps, '')}
              />
            </div>
          ) : (
            <div className="bp-empty">Select laps to build histograms.</div>
          ))}

        {sub === 'gg' &&
          (gg.length ? (
            <div className="rp-charts">
              <ChartCanvas
                testid="rp-gg"
                caption="lat_g (x) vs long_g (y), ±1.5 g"
                width={260}
                height={260}
                draw={(ctx, w, h) => {
                  const pad = 24;
                  const span = 3; // −1.5 .. +1.5 g
                  const sx = (v: number) => pad + ((v + 1.5) / span) * (w - pad * 2);
                  const sy = (v: number) => h - pad - ((v + 1.5) / span) * (h - pad * 2);
                  ctx.strokeStyle = '#262d37';
                  ctx.beginPath();
                  for (const g of [-1, 0, 1]) {
                    ctx.moveTo(sx(g), pad);
                    ctx.lineTo(sx(g), h - pad);
                    ctx.moveTo(pad, sy(g));
                    ctx.lineTo(w - pad, sy(g));
                  }
                  ctx.stroke();
                  ctx.fillStyle = '#8b95a5';
                  ctx.font = '9px sans-serif';
                  ctx.fillText('+1.5', w - pad - 14, sy(0) - 3);
                  ctx.fillText('+1.5', sx(0) + 3, pad + 8);
                  for (const { lap, pts } of gg) {
                    ctx.fillStyle = session.color;
                    for (const p of pts) {
                      if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
                      ctx.fillRect(sx(p[0]) - 1, sy(p[1]) - 1, 2, 2);
                    }
                    void lap;
                  }
                }}
              />
            </div>
          ) : (
            <div className="bp-empty">Select laps for the G-G diagram.</div>
          ))}

        {sub === 'leantps' &&
          (heat ? (
            <div className="rp-charts">
              <ChartCanvas
                testid="rp-leantps"
                caption="Lean (10° bins) × TPS (20 % bins), colour = sample count"
                width={Math.max(220, (heat[0]?.length ?? 1) * 40 + 60)}
                height={Math.max(160, heat.length * 14 + 30)}
                draw={(ctx, w, h) => {
                  const rowsN = heat.length;
                  const colsN = heat[0]?.length ?? 0;
                  const left = 46;
                  const top = 14;
                  const cw = (w - left - 6) / Math.max(1, colsN);
                  const chh = (h - top - 14) / Math.max(1, rowsN);
                  let max = 0;
                  for (const r of heat) for (const v of r) max = Math.max(max, v);
                  ctx.font = '9px sans-serif';
                  for (let i = 0; i < rowsN; i++) {
                    for (let j = 0; j < colsN; j++) {
                      const f = max ? heat[i][j] / max : 0;
                      ctx.fillStyle = f === 0 ? '#151a21' : `hsl(${Math.round(210 - f * 190)} 80% ${20 + f * 40}%)`;
                      ctx.fillRect(left + j * cw, top + i * chh, cw - 1, chh - 1);
                    }
                    ctx.fillStyle = '#8b95a5';
                    ctx.fillText(`${LEAN_BINS[i] ?? ''}°`, 4, top + i * chh + chh - 2);
                  }
                  for (let j = 0; j < colsN; j++) {
                    ctx.fillStyle = '#8b95a5';
                    ctx.fillText(`${TPS_BINS[j] ?? ''}%`, left + j * cw, h - 3);
                  }
                }}
              />
            </div>
          ) : (
            <div className="bp-empty">Select laps for the lean × throttle matrix.</div>
          ))}

        {sub === 'loss' &&
          (loss ? (
            <div className="rp-loss" data-testid="rp-loss">
              {loss.map(({ lap, items }) => (
                <div key={lap.n}>
                  <div className="bp-label">
                    L{lap.n} vs ref {refLap ? `${refLap.s.name} L${refLap.lap.n}` : '–'}
                  </div>
                  <ul>
                    {items.length === 0 && <li className="bp-label">no measurable difference</li>}
                    {items.map((it) => (
                      <li key={it.turn}>
                        T{it.turn}
                        {'  '}
                        <span className={it.lossS >= 0 ? 'bad' : 'good'}>
                          {it.lossS >= 0 ? '+' : '−'}
                          {Math.abs(it.lossS).toFixed(2)} s
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ) : (
            <div className="bp-empty">Time loss needs an active track, a reference lap and the delta_t channel.</div>
          ))}
      </div>
    </div>
  );
}
