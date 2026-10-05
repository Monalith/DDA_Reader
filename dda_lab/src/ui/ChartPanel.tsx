import { useEffect, useMemo, useRef } from 'react';
import uPlot from 'uplot';
import { attachXInteractions, attachYInteractions } from './chartInteractions';
import type { DataMarker, Session, Workspace } from '../core/types';
import { activeTrack, useLab, type CursorPos, type LapRef } from '../state/store';
import { cursorIdxFromX, findLap, markerIdxInLap, markerX, overlaySeries, xFromIdx, type OverlayLine } from '../state/selectors';

/** A marker resolved for one panel: its x on this axis and its fixed value on every line. */
interface MarkerCol {
  m: DataMarker;
  x: number | null;
  values: (number | null)[];
}

function resolveMarkers(markers: DataMarker[], sessions: Session[], lines: OverlayLine[], xAxis: Workspace['xAxis']): MarkerCol[] {
  return markers.map((m) => {
    const x = markerX(sessions, m, xAxis);
    const values = lines.map((l) => {
      const s = sessions.find((ss) => ss.id === l.sessionId);
      const lap = s && findLap(s, l.lap);
      if (!s || !lap) return null;
      const idx = markerIdxInLap(sessions, m, s, lap, xAxis);
      if (idx === null) return null;
      const v = s.channels.get(l.channel)?.data[idx];
      return v != null && Number.isFinite(v) ? v : null;
    });
    return { m, x, values };
  });
}

const KMH_TO_MPH = 0.621371;
const SPEED_CHANNELS = new Set(['speed', 'gps_speed']);
/** How far to look around the cursor row for a value of a lap that has no sample exactly there. */
const NEAR_ROWS = 40;

type Panel = Workspace['panels'][number];

/** uPlot range function honouring fixed bounds; undefined/null bound = auto with 5 % padding. */
function axisRange(r: Panel['yL']): uPlot.Scale['range'] {
  return (_u: uPlot, dataMin: number | null, dataMax: number | null) => {
    let lo = dataMin ?? 0;
    let hi = dataMax ?? 1;
    if (hi === lo) {
      lo -= 1;
      hi += 1;
    }
    const pad = (hi - lo) * 0.05;
    const min = r?.min ?? lo - pad;
    const max = r?.max ?? hi + pad;
    return [Math.min(min, max), Math.max(min, max)] as [number, number];
  };
}

function lineWidthFor(panel: Panel, channel: string): number {
  const ch = panel.channels.find((c) => c.name === channel);
  return ch?.width ?? panel.lineWidth ?? 1.5;
}

function isRefLine(line: OverlayLine, ref: LapRef | undefined): boolean {
  return !!ref && ref.sessionId === line.sessionId && ref.lap === line.lap;
}

/**
 * uPlot needs strictly increasing x. Lap distance can wrap back to 0 on the sample after the
 * gate, which would otherwise draw a line straight back across the plot, so those points are
 * dropped.
 */
function monotonic(x: Float64Array, y: Float32Array): [Float64Array, Float32Array] {
  let ok = true;
  for (let i = 1; i < x.length; i++) {
    if (!(x[i] > x[i - 1])) {
      ok = false;
      break;
    }
  }
  if (ok) return [x, y];
  const xs: number[] = [];
  const ys: number[] = [];
  let last = -Infinity;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    if (!Number.isFinite(v) || v <= last) continue;
    last = v;
    xs.push(v);
    ys.push(y[i]);
  }
  return [new Float64Array(xs), new Float32Array(ys)];
}

/** Join per-line (x, y) tables into a single aligned uPlot data set. */
function joinLines(lines: OverlayLine[]): uPlot.AlignedData {
  if (!lines.length) return [new Float64Array(0)];
  const tables = lines.map((l) => monotonic(l.x, l.y) as unknown as uPlot.AlignedData);
  return uPlot.join(tables);
}

function fmtVal(line: OverlayLine, v: number | null | undefined, unitMph: boolean): string {
  if (v == null || !Number.isFinite(v)) return '–';
  const out = unitMph && SPEED_CHANNELS.has(line.channel) ? v * KMH_TO_MPH : v;
  const a = Math.abs(out);
  return a >= 1000 ? out.toFixed(0) : a >= 100 ? out.toFixed(1) : a >= 10 ? out.toFixed(2) : out.toFixed(3);
}

function unitOf(sessions: Session[], line: OverlayLine, unitMph: boolean): string {
  const u = sessions.find((s) => s.id === line.sessionId)?.channels.get(line.channel)?.unit ?? '';
  return unitMph && SPEED_CHANNELS.has(line.channel) ? 'mph' : u;
}

export default function ChartPanel({ panel }: { panel: Panel }) {
  const sessions = useLab((s) => s.sessions);
  const selectedLaps = useLab((s) => s.selectedLaps);
  const lapMeta = useLab((s) => s.lapMeta);
  const workspace = useLab((s) => s.workspace);
  const refLap = useLab((s) => s.refLap);
  const cursor = useLab((s) => s.cursor);
  const xRange = useLab((s) => s.xRange);
  const track = useLab(activeTrack);
  const markers = useLab((s) => s.markers);
  const activeMarkerId = useLab((s) => s.activeMarkerId);

  const xAxis = workspace.xAxis;
  const unitMph = workspace.unitMph;

  const lines = useMemo(
    () => overlaySeries({ sessions, selectedLaps, workspace, lapMeta }, panel),
    [sessions, selectedLaps, workspace, lapMeta, panel],
  );
  const data = useMemo(() => joinLines(lines), [lines]);
  const markerCols = useMemo(() => resolveMarkers(markers, sessions, lines, xAxis), [markers, sessions, lines, xAxis]);
  const markersRef = useRef<MarkerCol[]>(markerCols);
  markersRef.current = markerCols;
  const activeMarkerRef = useRef(activeMarkerId);
  activeMarkerRef.current = activeMarkerId;

  const hostRef = useRef<HTMLDivElement>(null);
  const uRef = useRef<uPlot | null>(null);
  const legendRefs = useRef<(HTMLElement | null)[]>([]);

  // Mutable mirrors so uPlot hooks always see current values without re-creating the chart.
  const linesRef = useRef<OverlayLine[]>(lines);
  const sessionsRef = useRef<Session[]>(sessions);
  const xAxisRef = useRef<Workspace['xAxis']>(xAxis);
  const unitRef = useRef<boolean>(unitMph);
  const trackRef = useRef(track);
  const cursorRef = useRef<CursorPos | null>(cursor);
  const fromStore = useRef(false);
  const rafRef = useRef<number | null>(null);
  const pendingRef = useRef<CursorPos | null>(null);

  linesRef.current = lines;
  sessionsRef.current = sessions;
  xAxisRef.current = xAxis;
  unitRef.current = unitMph;
  trackRef.current = track;
  cursorRef.current = cursor;
  const panelRef = useRef(panel);
  panelRef.current = panel;

  const hasR = lines.some((l) => l.axis === 'R');
  // Chart is rebuilt only when its structure changes; otherwise setData/setScale is used.
  const signature = useMemo(
    () =>
      [
        xAxis,
        hasR ? 'R' : '-',
        lines.map((l) => `${l.key}|${l.axis}|${l.color}|${isRefLine(l, refLap) ? 'r' : 'n'}`).join(';'),
        JSON.stringify([panel.yL, panel.yR, panel.lineWidth, panel.channels.map((c) => c.width ?? null)]),
      ].join('#'),
    [xAxis, hasR, lines, refLap, panel],
  );

  const updateLegend = (idx: number | null | undefined) => {
    const u = uRef.current;
    const ls = linesRef.current;
    for (let i = 0; i < ls.length; i++) {
      const el = legendRefs.current[i];
      if (!el) continue;
      let v: number | null = null;
      if (u && idx != null) {
        const arr = u.data[i + 1] as ArrayLike<number | null | undefined> | undefined;
        // joined data has holes where this lap has no sample at that x: take the nearest one
        if (arr) {
          for (let d = 0; d <= NEAR_ROWS; d++) {
            const a = arr[idx - d];
            if (d <= idx && a != null && Number.isFinite(a)) {
              v = a;
              break;
            }
            const b = arr[idx + d];
            if (b != null && Number.isFinite(b)) {
              v = b;
              break;
            }
          }
        }
      }
      el.textContent = fmtVal(ls[i], v, unitRef.current);
    }
  };

  // ---- create / destroy the uPlot instance -------------------------------
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (!lines.length) {
      uRef.current?.destroy();
      uRef.current = null;
      return;
    }

    const opts: uPlot.Options = {
      width: host.clientWidth || 600,
      height: 150,
      padding: [6, hasR ? 4 : 10, 0, 4],
      legend: { show: false },
      cursor: {
        sync: { key: 'lab', setSeries: false },
        drag: { x: true, y: false, setScale: false },
        y: false,
      },
      scales: {
        x: { time: false },
        L: { range: axisRange(panel.yL) },
        ...(hasR ? { R: { range: axisRange(panel.yR) } } : {}),
      },
      axes: [
        {
          scale: 'x',
          side: 2,
          label: xAxisRef.current === 'distance' ? 'Distance (m)' : 'Time (s)',
          labelSize: 18,
          stroke: '#8b95a5',
          grid: { stroke: '#232a34', width: 1 },
          ticks: { stroke: '#232a34' },
          font: '10px Inter, system-ui, sans-serif',
          labelFont: '10px Inter, system-ui, sans-serif',
        },
        {
          scale: 'L',
          side: 3,
          size: 44,
          stroke: '#8b95a5',
          grid: { stroke: '#1d232c', width: 1 },
          ticks: { stroke: '#232a34' },
          font: '10px Inter, system-ui, sans-serif',
        },
        ...(hasR
          ? [
              {
                scale: 'R',
                side: 1 as const,
                size: 42,
                stroke: '#8b95a5',
                grid: { show: false },
                ticks: { stroke: '#232a34' },
                font: '10px Inter, system-ui, sans-serif',
              },
            ]
          : []),
      ],
      series: [
        {},
        ...lines.map((l) => ({
          label: l.label,
          scale: l.axis,
          stroke: l.color,
          width: lineWidthFor(panel, l.channel) + (isRefLine(l, refLap) ? 1 : 0),
          spanGaps: true,
          points: { show: false },
        })),
      ],
      hooks: {
        setCursor: [
          (u) => {
            updateLegend(u.cursor.idx);
            if (fromStore.current) return;
            if (!u.cursor.event) return; // only the chart under the mouse publishes
            const idx = u.cursor.idx;
            if (idx == null) return;
            const xv = (u.data[0] as ArrayLike<number>)[idx];
            if (xv == null || !Number.isFinite(xv)) return;
            const line = linesRef.current[0];
            if (!line) return;
            const s = sessionsRef.current.find((x) => x.id === line.sessionId);
            if (!s) return;
            const lap = findLap(s, line.lap);
            if (!lap) return;
            const sIdx = cursorIdxFromX(s, lap, xv, xAxisRef.current);
            const cur = cursorRef.current;
            if (cur && cur.sessionId === s.id && cur.idx === sIdx) return;
            pendingRef.current = { sessionId: s.id, idx: sIdx };
            if (rafRef.current == null) {
              rafRef.current = requestAnimationFrame(() => {
                rafRef.current = null;
                const p = pendingRef.current;
                pendingRef.current = null;
                if (p) useLab.getState().setCursor(p);
              });
            }
          },
        ],
        setSelect: [
          (u) => {
            const sel = u.select;
            if (!sel || sel.width <= 2) return;
            const min = u.posToVal(sel.left, 'x');
            const max = u.posToVal(sel.left + sel.width, 'x');
            u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
            if (Number.isFinite(min) && Number.isFinite(max) && max > min) useLab.getState().setXRange([min, max]);
          },
        ],
        draw: [
          (u) => {
            const ctx = u.ctx;
            const { left, top, width, height } = u.bbox;
            const dpr = devicePixelRatio;
            ctx.save();
            ctx.beginPath();
            ctx.rect(left, top, width, height);
            ctx.clip();
            const t = trackRef.current;
            if (t && xAxisRef.current === 'distance') {
              ctx.setLineDash([3, 3]);
              ctx.lineWidth = 1;
              ctx.strokeStyle = 'rgba(139,149,165,0.55)';
              ctx.fillStyle = 'rgba(139,149,165,0.9)';
              ctx.font = `${10 * dpr}px Inter, system-ui, sans-serif`;
              for (const turn of t.turns) {
                const px = u.valToPos(turn.sRange[0], 'x', true);
                if (!Number.isFinite(px) || px < left || px > left + width) continue;
                ctx.beginPath();
                ctx.moveTo(px, top);
                ctx.lineTo(px, top + height);
                ctx.stroke();
                ctx.fillText(turn.name || `T${turn.n}`, px + 2 * dpr, top + 10 * dpr);
              }
            }
            // ---- user markers: solid vertical line + flag with the name ----
            ctx.setLineDash([]);
            ctx.font = `bold ${10 * dpr}px Inter, system-ui, sans-serif`;
            for (const mc of markersRef.current) {
              if (mc.x === null) continue;
              const px = u.valToPos(mc.x, 'x', true);
              if (!Number.isFinite(px) || px < left || px > left + width) continue;
              const active = mc.m.id === activeMarkerRef.current;
              ctx.strokeStyle = mc.m.color;
              ctx.lineWidth = (active ? 2 : 1.25) * dpr;
              ctx.beginPath();
              ctx.moveTo(px, top);
              ctx.lineTo(px, top + height);
              ctx.stroke();
              const label = mc.m.name;
              const tw = ctx.measureText(label).width;
              const bh = 13 * dpr;
              ctx.fillStyle = mc.m.color;
              ctx.fillRect(px, top + height - bh, tw + 8 * dpr, bh);
              ctx.fillStyle = '#10141a';
              ctx.fillText(label, px + 4 * dpr, top + height - 3 * dpr);
              // value dots on every line at the marker
              for (let i = 0; i < mc.values.length; i++) {
                const v = mc.values[i];
                const line = linesRef.current[i];
                if (v == null || !line) continue;
                const py = u.valToPos(v, line.axis, true);
                if (!Number.isFinite(py)) continue;
                ctx.beginPath();
                ctx.arc(px, py, 3 * dpr, 0, Math.PI * 2);
                ctx.fillStyle = line.color;
                ctx.fill();
                ctx.lineWidth = 1 * dpr;
                ctx.strokeStyle = '#10141a';
                ctx.stroke();
              }
            }
            ctx.restore();
          },
        ],
      },
    };

    const u = new uPlot(opts, data, host);
    uRef.current = u;

    const extentOf = (): [number, number] => {
      const xs = u.data[0] as ArrayLike<number>;
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < xs.length; i++) {
        const v = xs[i];
        if (!Number.isFinite(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      return min < max ? [min, max] : [0, 1];
    };
    const setRange = (r: [number, number] | null) => {
      const st = useLab.getState();
      const cur = st.workspace.panels.find((p) => p.id === panelRef.current.id);
      if (cur && cur.x?.linked === false) {
        st.setWorkspace({
          panels: st.workspace.panels.map((p) => (p.id === cur.id ? { ...p, x: { linked: false, min: r ? r[0] : null, max: r ? r[1] : null } } : p)),
        });
      } else {
        st.setXRange(r);
      }
    };
    const onDblClick = () => setRange(null);
    u.over.addEventListener('dblclick', onDblClick);
    const detachX = attachXInteractions(u, {
      get: () => {
        const sc = u.scales.x;
        return sc.min != null && sc.max != null ? [sc.min, sc.max] : extentOf();
      },
      extent: extentOf,
      set: (r) => setRange(r),
      reset: () => setRange(null),
    });

    // ---- y axes: drag up/down to zoom, committed to the panel's fixed range ----
    const axisEls = u.root.querySelectorAll<HTMLElement>('.u-axis');
    const yDataExtent = (scale: 'L' | 'R'): [number, number] => {
      let lo = Infinity;
      let hi = -Infinity;
      linesRef.current.forEach((l, i) => {
        if (l.axis !== scale) return;
        const arr = u.data[i + 1] as ArrayLike<number | null | undefined>;
        for (let k = 0; k < arr.length; k++) {
          const v = arr[k];
          if (v == null || !Number.isFinite(v)) continue;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      });
      return lo < hi ? [lo, hi] : [0, 1];
    };
    const yIo = (scale: 'L' | 'R') => ({
      get: (): [number, number] => {
        const sc = u.scales[scale];
        return sc.min != null && sc.max != null ? [sc.min, sc.max] : yDataExtent(scale);
      },
      extent: () => yDataExtent(scale),
      set: (r: [number, number], commit: boolean) => {
        u.setScale(scale, { min: r[0], max: r[1] });
        if (!commit) return;
        const st = useLab.getState();
        const key = scale === 'L' ? 'yL' : 'yR';
        st.setWorkspace({
          panels: st.workspace.panels.map((p) => (p.id === panelRef.current.id ? { ...p, [key]: { min: r[0], max: r[1] } } : p)),
        });
      },
      reset: () => {
        const st = useLab.getState();
        const key = scale === 'L' ? 'yL' : 'yR';
        st.setWorkspace({ panels: st.workspace.panels.map((p) => (p.id === panelRef.current.id ? { ...p, [key]: undefined } : p)) });
      },
    });
    const detachYs: (() => void)[] = [];
    if (axisEls[1]) detachYs.push(attachYInteractions(u, axisEls[1], 'L', yIo('L')));
    if (hasR && axisEls[2]) detachYs.push(attachYInteractions(u, axisEls[2], 'R', yIo('R')));

    const ro = new ResizeObserver(() => {
      const w = host.clientWidth;
      if (w > 0) u.setSize({ width: w, height: 150 });
    });
    ro.observe(host);

    return () => {
      ro.disconnect();
      detachX();
      for (const d of detachYs) d();
      u.over.removeEventListener('dblclick', onDblClick);
      u.destroy();
      if (uRef.current === u) uRef.current = null;
    };
    // Rebuild only when the chart structure changes (series/axes/x meaning).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  // ---- data updates without re-creating ---------------------------------
  useEffect(() => {
    const u = uRef.current;
    if (!u) return;
    u.setData(data, xRange == null);
    updateLegend(u.cursor.idx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // ---- x zoom from the store -------------------------------------------
  useEffect(() => {
    const u = uRef.current;
    if (!u) return;
    const xs = u.data[0] as ArrayLike<number>;
    if (!xs || xs.length === 0) return;
    // full extent (x is not necessarily monotonic: lap distance can wrap at the gate)
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < xs.length; i++) {
      const v = xs[i];
      if (!Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const linked = panel.x?.linked ?? true;
    if (!linked) {
      const lo = panel.x?.min ?? null;
      const hi = panel.x?.max ?? null;
      const a = lo ?? min;
      const b = hi ?? max;
      if (a < b) u.setScale('x', { min: a, max: b });
      return;
    }
    if (xRange) {
      u.setScale('x', { min: xRange[0], max: xRange[1] });
      return;
    }
    if (min < max) u.setScale('x', { min, max });
  }, [xRange, data, panel.x]);

  // ---- cursor coming from elsewhere (map click, other panels) -----------
  useEffect(() => {
    const u = uRef.current;
    if (!u || !cursor) return;
    const s = sessions.find((x) => x.id === cursor.sessionId);
    if (!s) return;
    const at = xFromIdx(s, cursor.idx, xAxis);
    const plotted = at && lines.some((l) => l.sessionId === cursor.sessionId && l.lap === at.lap.n);
    // the cursor may point at a lap this panel does not draw → park the crosshair off-plot
    const left = plotted && Number.isFinite(at.x) ? u.valToPos(at.x, 'x') : -10;
    if (!Number.isFinite(left)) return;
    fromStore.current = true;
    try {
      u.setCursor({ left: left < -10 || left > u.width ? -10 : left, top: 0 });
    } finally {
      fromStore.current = false;
    }
  }, [cursor, sessions, xAxis, lines]);

  // ---- unit toggle refreshes the legend text ---------------------------
  useEffect(() => {
    updateLegend(uRef.current?.cursor.idx ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unitMph, lines]);

  // ---- markers changed: repaint the overlay ----------------------------
  useEffect(() => {
    uRef.current?.redraw(false, true);
  }, [markerCols, activeMarkerId]);

  legendRefs.current.length = lines.length;

  const jumpTo = (m: DataMarker) => {
    const st = useLab.getState();
    st.setActiveMarker(m.id);
    st.setCursor({ sessionId: m.sessionId, idx: m.idx });
  };

  return (
    <>
      {lines.length === 0 ? (
        <div className="chart-plot-empty">Select laps in the lap table to plot {panel.channels.map((c) => c.name).join(', ') || 'channels'}.</div>
      ) : (
        <div className="chart-plot" ref={hostRef} />
      )}
      <div className="chart-legend" data-testid={`chart-legend-${panel.id}`}>
        {lines.map((l, i) => (
          <span className="lg" key={l.key} style={{ borderColor: l.color }} title={l.label}>
            <span className="lg-head">
              <i style={{ background: l.color, height: isRefLine(l, refLap) ? 3 : 2 }} />
              <span className="lg-name">{l.label}</span>
            </span>
            <span className="lg-value">
              <b
                style={{ color: l.color }}
                ref={(el) => {
                  legendRefs.current[i] = el;
                }}
              >
                –
              </b>
              <span className="lg-unit">{unitOf(sessions, l, unitMph)}</span>
            </span>
          </span>
        ))}
      </div>
      {markerCols.length > 0 && lines.length > 0 && (
        <div className="chart-markers" data-testid={`chart-markers-${panel.id}`}>
          {markerCols.map((mc) => (
            <button
              type="button"
              className={`mk${mc.m.id === activeMarkerId ? ' on' : ''}`}
              key={mc.m.id}
              style={{ borderColor: mc.m.color }}
              onClick={() => jumpTo(mc.m)}
              title={`${mc.m.name}: move the cursor here`}
            >
              <span className="mk-name" style={{ background: mc.m.color }}>
                {mc.m.name}
              </span>
              {lines.map((l, i) => (
                <span className="mk-val" key={l.key} title={l.label} style={{ color: l.color }}>
                  {fmtVal(l, mc.values[i], unitMph)}
                </span>
              ))}
              <span
                role="button"
                tabIndex={0}
                className="mk-x"
                data-testid={`marker-chip-del-${mc.m.id}`}
                title={`Remove marker ${mc.m.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  useLab.getState().removeMarker(mc.m.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.stopPropagation();
                    useLab.getState().removeMarker(mc.m.id);
                  }
                }}
              >
                ✕
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
