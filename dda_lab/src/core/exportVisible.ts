// "Export what I see": every line of every chart panel, resampled on a uniform x grid
// over the visible x range, as one CSV. Deleted laps never reach here (they are gone from
// the sessions) and only workspace laps are plotted, so the file matches the screen.
import type { OverlayLine } from '../state/selectors';
import { toCsv } from './reports';

export interface VisibleExportInput {
  xAxis: 'time' | 'distance';
  /** visible range; null = full extent of the plotted lines */
  range: [number, number] | null;
  panels: { id: string; lines: OverlayLine[] }[];
}

/** Grid step: 1 m on distance, 0.1 s on time. */
export function gridStep(xAxis: 'time' | 'distance'): number {
  return xAxis === 'distance' ? 1 : 0.1;
}

/** Linear interpolation of a (monotonic x, y) line at xq; NaN outside the line. */
export function interpAt(x: Float64Array, y: Float32Array, xq: number): number {
  const n = x.length;
  if (!n || xq < x[0] || xq > x[n - 1]) return NaN;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (x[mid] < xq) lo = mid + 1;
    else hi = mid;
  }
  if (x[lo] === xq || lo === 0) return y[lo];
  const x0 = x[lo - 1];
  const x1 = x[lo];
  if (!(x1 > x0)) return y[lo];
  const t = (xq - x0) / (x1 - x0);
  const a = y[lo - 1];
  const b = y[lo];
  if (!Number.isFinite(a)) return b;
  if (!Number.isFinite(b)) return a;
  return a + (b - a) * t;
}

export function visibleExtent(lines: OverlayLine[]): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const l of lines) {
    for (let i = 0; i < l.x.length; i++) {
      const v = l.x[i];
      if (!Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  return lo < hi ? [lo, hi] : null;
}

/** Build the CSV rows: header = x + one column per plotted line (lap label + channel). */
export function visibleRows(input: VisibleExportInput): (string | number)[][] {
  const lines = input.panels.flatMap((p) => p.lines);
  const ext = input.range ?? visibleExtent(lines);
  if (!ext || !lines.length) return [];
  const step = gridStep(input.xAxis);
  const [a, b] = ext;
  const start = Math.ceil(a / step) * step;
  const count = Math.floor((b - start) / step) + 1;
  if (count <= 0) return [];
  const header = [input.xAxis === 'distance' ? 'Distance_m' : 'Time_s', ...lines.map((l) => l.label)];
  const rows: (string | number)[][] = [header];
  for (let k = 0; k < count; k++) {
    const xq = start + k * step;
    rows.push([Number(xq.toFixed(3)), ...lines.map((l) => interpAt(l.x, l.y, xq))]);
  }
  return rows;
}

export function visibleCsv(input: VisibleExportInput): string {
  return toCsv(visibleRows(input));
}
