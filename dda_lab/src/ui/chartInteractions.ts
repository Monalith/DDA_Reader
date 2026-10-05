// Mouse interactions for a uPlot chart's x axis: pan, zoom and axis-drag zoom.
// Pure helpers (tested) + an attach() that wires DOM events to a range setter.
import type uPlot from 'uplot';

export interface XRangeIO {
  /** current visible range */
  get(): [number, number];
  /** full data extent */
  extent(): [number, number];
  set(range: [number, number]): void;
  reset(): void;
}

export const MIN_SPAN_FRACTION = 0.002;

/** Zoom the range by `factor` (>1 zooms in) around the anchor value, clamped to the extent. */
export function zoomRange(cur: [number, number], extent: [number, number], factor: number, anchor: number): [number, number] {
  const [a, b] = cur;
  const span = b - a;
  const minSpan = (extent[1] - extent[0]) * MIN_SPAN_FRACTION;
  const newSpan = Math.max(minSpan, Math.min(extent[1] - extent[0], span / factor));
  const t = span > 0 ? (anchor - a) / span : 0.5;
  let lo = anchor - newSpan * t;
  let hi = lo + newSpan;
  if (lo < extent[0]) {
    lo = extent[0];
    hi = lo + newSpan;
  }
  if (hi > extent[1]) {
    hi = extent[1];
    lo = hi - newSpan;
  }
  return [lo, hi];
}

/** Shift the range by `delta` (data units), clamped to the extent. */
export function panRange(cur: [number, number], extent: [number, number], delta: number): [number, number] {
  const span = cur[1] - cur[0];
  let lo = cur[0] + delta;
  if (lo < extent[0]) lo = extent[0];
  if (lo + span > extent[1]) lo = extent[1] - span;
  return [lo, lo + span];
}

/** Drag on the axis: dx pixels → zoom factor (right = in, left = out). */
export function dragZoomFactor(dxPx: number): number {
  return Math.exp(dxPx / 120);
}

export interface YRangeIO {
  /** current visible range of the scale */
  get(): [number, number];
  /** data extent of the scale (zoom-out is allowed up to Y_EXTENT_FACTOR × this span) */
  extent(): [number, number];
  /** live update while dragging (commit=false) and final value on release (commit=true) */
  set(range: [number, number], commit: boolean): void;
  /** back to automatic range */
  reset(): void;
}

export const Y_EXTENT_FACTOR = 6;

/** Zoom-out limit for a y scale: the data span widened symmetrically by Y_EXTENT_FACTOR. */
export function yOuterExtent(ext: [number, number]): [number, number] {
  const span = Math.max(1e-9, ext[1] - ext[0]);
  const mid = (ext[0] + ext[1]) / 2;
  return [mid - (span * Y_EXTENT_FACTOR) / 2, mid + (span * Y_EXTENT_FACTOR) / 2];
}

/** Drag on the y axis: dy pixels → zoom factor (up = in, down = out). */
export function dragZoomFactorY(dyPx: number): number {
  return Math.exp(-dyPx / 120);
}

/**
 * Attach mouse behaviour to one y axis band (`axisEl` is the axis DOM element):
 *  - left-drag up zooms in, down zooms out, around the value under the grab point;
 *    shift+drag pans; the change is committed on release
 *  - wheel zooms around the pointer, shift+wheel pans
 *  - double-click resets to the automatic range
 * Returns a cleanup function.
 */
export function attachYInteractions(u: uPlot, axisEl: HTMLElement, scaleKey: string, io: YRangeIO): () => void {
  const over = u.over;
  const valAt = (clientY: number): number => {
    const r = over.getBoundingClientRect();
    return u.posToVal(clientY - r.top, scaleKey);
  };
  let dragging = false;
  let startY = 0;
  let startRange: [number, number] = io.get();
  let anchor = 0;
  let pan = false;

  const onDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    pan = e.shiftKey;
    startY = e.clientY;
    startRange = io.get();
    anchor = valAt(e.clientY);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  const onMove = (e: MouseEvent) => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    if (pan) {
      const span = startRange[1] - startRange[0];
      const delta = (dy / Math.max(1, over.clientHeight)) * span;
      io.set(panRange(startRange, yOuterExtent(io.extent()), delta), false);
    } else {
      io.set(zoomRange(startRange, yOuterExtent(io.extent()), dragZoomFactorY(dy), anchor), false);
    }
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    io.set(io.get(), true);
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const cur = io.get();
    const outer = yOuterExtent(io.extent());
    if (e.shiftKey) {
      const span = cur[1] - cur[0];
      io.set(panRange(cur, outer, ((e.deltaY || e.deltaX) / Math.max(1, over.clientHeight)) * span), true);
      return;
    }
    io.set(zoomRange(cur, outer, Math.exp(-e.deltaY / 300), valAt(e.clientY)), true);
  };
  const onDbl = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    io.reset();
  };
  axisEl.addEventListener('mousedown', onDown);
  axisEl.addEventListener('wheel', onWheel, { passive: false });
  axisEl.addEventListener('dblclick', onDbl);
  axisEl.style.cursor = 'ns-resize';
  axisEl.title = 'Drag up/down to zoom the Y axis · shift+drag pans · double-click = auto';
  return () => {
    axisEl.removeEventListener('mousedown', onDown);
    axisEl.removeEventListener('wheel', onWheel);
    axisEl.removeEventListener('dblclick', onDbl);
    onUp();
  };
}

/**
 * Attach mouse behaviour to a chart:
 *  - plot area: middle-drag pans, right-drag zooms (right = in), wheel zooms around the
 *    cursor, shift+wheel pans, double-click resets (uPlot's own left-drag select stays).
 *  - x-axis band: left-drag zooms (right = in / left = out) around the grab point, wheel zooms.
 * Returns a cleanup function.
 */
export function attachXInteractions(u: uPlot, io: XRangeIO): () => void {
  const over = u.over;
  const axisEl = u.root.querySelector<HTMLElement>('.u-axis'); // first axis = x
  const valAt = (clientX: number): number => {
    const r = over.getBoundingClientRect();
    return u.posToVal(clientX - r.left, 'x');
  };
  const pxToVal = (px: number): number => {
    const [a, b] = io.get();
    return (px / Math.max(1, over.clientWidth)) * (b - a);
  };

  let mode: 'none' | 'pan' | 'rzoom' | 'axis' = 'none';
  let startX = 0;
  let startRange: [number, number] = io.get();
  let anchor = 0;
  let moved = false;

  const onDown = (e: MouseEvent) => {
    if (e.button === 1 || e.button === 2) {
      e.preventDefault();
      mode = e.button === 1 ? 'pan' : 'rzoom';
      startX = e.clientX;
      startRange = io.get();
      anchor = valAt(e.clientX);
      moved = false;
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    }
  };
  const onAxisDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    mode = 'axis';
    startX = e.clientX;
    startRange = io.get();
    anchor = valAt(e.clientX);
    moved = false;
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  const onMove = (e: MouseEvent) => {
    const dx = e.clientX - startX;
    if (Math.abs(dx) > 2) moved = true;
    if (mode === 'pan') {
      const span = startRange[1] - startRange[0];
      const delta = -(dx / Math.max(1, over.clientWidth)) * span;
      io.set(panRange(startRange, io.extent(), delta));
    } else if (mode === 'rzoom' || mode === 'axis') {
      io.set(zoomRange(startRange, io.extent(), dragZoomFactor(dx), anchor));
    }
  };
  const onUp = () => {
    mode = 'none';
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };
  const onContext = (e: MouseEvent) => {
    e.preventDefault();
    // right-click without drag = step zoom out
    if (!moved) io.set(zoomRange(io.get(), io.extent(), 1 / 1.5, valAt(e.clientX)));
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const cur = io.get();
    if (e.shiftKey) {
      io.set(panRange(cur, io.extent(), pxToVal(e.deltaY || e.deltaX)));
      return;
    }
    const factor = Math.exp(-e.deltaY / 300);
    io.set(zoomRange(cur, io.extent(), factor, valAt(e.clientX)));
  };
  const onAuxClick = (e: MouseEvent) => {
    if (e.button === 1) e.preventDefault();
  };

  over.addEventListener('mousedown', onDown);
  over.addEventListener('contextmenu', onContext);
  over.addEventListener('wheel', onWheel, { passive: false });
  over.addEventListener('auxclick', onAuxClick);
  axisEl?.addEventListener('mousedown', onAxisDown);
  axisEl?.addEventListener('wheel', onWheel, { passive: false });
  if (axisEl) axisEl.style.cursor = 'ew-resize';

  return () => {
    over.removeEventListener('mousedown', onDown);
    over.removeEventListener('contextmenu', onContext);
    over.removeEventListener('wheel', onWheel);
    over.removeEventListener('auxclick', onAuxClick);
    axisEl?.removeEventListener('mousedown', onAxisDown);
    axisEl?.removeEventListener('wheel', onWheel);
    onUp();
  };
}
