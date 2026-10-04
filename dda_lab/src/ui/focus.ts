// Pure helpers behind the "focus on a region" toolbar and the map's
// focus-following / overzoom behaviour. No DOM and no MapLibre runtime import,
// so everything here is unit-testable in the node environment.
import type { ExpressionSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { Turn, Workspace } from '../core/types';

/** Metres of run-off kept either side of a turn when focusing on it. */
export const FOCUS_PAD_M = 60;

/** Zoom window the vector line widths interpolate across. */
export const WIDTH_ZOOM_LO = 15;
export const WIDTH_ZOOM_HI = 21;

export type TurnLike = Pick<Turn, 'n' | 'name' | 'sRange'>;

/**
 * The x range (lap distance, m) to zoom to for one turn: its sRange padded by
 * `pad` on both sides and clamped to >= 0.
 *
 * A turn whose sRange wraps across the start/finish line (start > end) cannot be
 * expressed as a single ascending window, so it degrades to a `pad`-sized window
 * at its entry.
 */
export function turnFocusRange(turn: Pick<TurnLike, 'sRange'>, pad = FOCUS_PAD_M): [number, number] {
  const lo = Math.max(0, turn.sRange[0] - pad);
  const hi = Math.max(0, turn.sRange[1] + pad);
  return hi > lo ? [lo, hi] : [lo, lo + 2 * pad];
}

/** "T3 Hairpin", or plain "T3" when the turn carries no distinct name. */
export function turnOptionLabel(turn: Pick<TurnLike, 'n' | 'name'>): string {
  const name = (turn.name ?? '').trim();
  return !name || name === `T${turn.n}` ? `T${turn.n}` : `T${turn.n} ${name}`;
}

/**
 * Next/previous turn index for the ◀ / ▶ buttons. `null` means "whole lap":
 * stepping forward from there lands on the first turn, backward on the last.
 * Stepping past either end clamps.
 */
export function stepTurnIndex(cur: number | null, count: number, dir: 1 | -1): number | null {
  if (count <= 0) return null;
  if (cur == null) return dir > 0 ? 0 : count - 1;
  return Math.max(0, Math.min(count - 1, cur + dir));
}

/** 1240 -> "1,240" */
export function fmtMetres(v: number): string {
  const n = Math.round(v);
  const sign = n < 0 ? '-' : '';
  return sign + String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Toolbar read-out, e.g. "Focus: 1,240–1,520 m" (or seconds on the time axis). */
export function focusRangeLabel(range: [number, number] | null, xAxis: Workspace['xAxis']): string {
  if (!range) return 'Focus: whole lap';
  if (xAxis === 'distance') return `Focus: ${fmtMetres(range[0])}–${fmtMetres(range[1])} m`;
  return `Focus: ${range[0].toFixed(2)}–${range[1].toFixed(2)} s`;
}

/**
 * Contiguous [first, last] index runs (inclusive, offsets into `xs`) whose value
 * lies inside `range`. Non-finite x breaks a run.
 */
export function inRangeSegments(xs: ArrayLike<number>, range: [number, number]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i < xs.length; i++) {
    const v = xs[i];
    const inside = Number.isFinite(v) && v >= range[0] && v <= range[1];
    if (inside) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      out.push([start, i - 1]);
      start = -1;
    }
  }
  if (start >= 0) out.push([start, xs.length - 1]);
  return out;
}

/**
 * Raster basemap opacity by zoom. Imagery providers stop at z18/19; past that
 * MapLibre only scales up the deepest real tile, so the blurry raster is faded
 * out and the vector layers (trace, centerline, turns, gates, highlights) take
 * over: 1.0 up to z18.5, 0.6 at z19.5, 0.25 from z21 on.
 */
export function rasterOpacityByZoom(): ExpressionSpecification {
  return ['interpolate', ['linear'], ['zoom'], 18.5, 1, 19.5, 0.6, 21, 0.25, 22, 0.25];
}

/** Line width that grows with zoom, e.g. zoomWidth(3, 6): 3 px at z15, 6 px at z21. */
export function zoomWidth(lo: number, hi: number): ExpressionSpecification {
  return ['interpolate', ['linear'], ['zoom'], WIDTH_ZOOM_LO, lo, WIDTH_ZOOM_HI, hi];
}

/** Same ramp as {@link zoomWidth}, for circle radii and text sizes. */
export function zoomRadius(lo: number, hi: number): ExpressionSpecification {
  return zoomWidth(lo, hi);
}

/**
 * Background shade by zoom. Once the imagery has faded the plain backdrop is all
 * that is left behind the traces, so it lightens to keep dark trace colours
 * (blue / red ramp ends) readable.
 */
export function backgroundColorByZoom(): ExpressionSpecification {
  return ['interpolate', ['linear'], ['zoom'], 18, '#0e1116', 19.5, '#1b222c', 21, '#2b3340'];
}
