import type { Lap, Session, Workspace } from '../core/types';
import type { LabState, LapRef } from './store';

export interface OverlayLine {
  key: string;
  label: string;
  color: string;
  x: Float64Array;
  y: Float32Array;
  axis: 'L' | 'R';
  sessionId: string;
  lap: number;
  startIdx: number;
  channel: string;
}

export function findLap(s: Session, n: number): Lap | undefined {
  return s.laps.find((l) => l.n === n);
}

export function lapLabel(s: Session, lap: Lap, multiSession: boolean): string {
  return multiSession ? `${s.name} L${lap.n}` : `L${lap.n}`;
}

/** Shade a hex colour by a factor (0.6..1.4) to distinguish laps of one session. */
export function shade(hex: string, factor: number): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  const f = (c: string) => Math.max(0, Math.min(255, Math.round(parseInt(c, 16) * factor)));
  return `rgb(${f(m[1])},${f(m[2])},${f(m[3])})`;
}

/** X values for a lap slice: lap distance (m) or time since lap start (s). */
export function lapX(s: Session, lap: Lap, xAxis: Workspace['xAxis']): Float64Array {
  const n = lap.endIdx - lap.startIdx + 1;
  const out = new Float64Array(n);
  if (xAxis === 'distance') {
    const d = s.channels.get('lap_dist')?.data;
    if (d) {
      for (let i = 0; i < n; i++) out[i] = d[lap.startIdx + i];
      // lap_dist may be NaN in the first samples; patch with 0. The sample shared
      // with the next lap restarts at 0: keep x monotonic so uPlot never draws back.
      if (!Number.isFinite(out[0])) out[0] = 0;
      for (let i = 1; i < n; i++) if (!Number.isFinite(out[i]) || out[i] < out[i - 1]) out[i] = out[i - 1];
      return out;
    }
  }
  const t0 = s.t[lap.startIdx];
  for (let i = 0; i < n; i++) out[i] = s.t[lap.startIdx + i] - t0;
  return out;
}

export function selectedLapEntries(state: Pick<LabState, 'sessions' | 'selectedLaps'>): Array<{ s: Session; lap: Lap; ref: LapRef }> {
  const out: Array<{ s: Session; lap: Lap; ref: LapRef }> = [];
  for (const ref of state.selectedLaps) {
    const s = state.sessions.find((x) => x.id === ref.sessionId);
    if (!s) continue;
    const lap = findLap(s, ref.lap);
    if (lap) out.push({ s, lap, ref });
  }
  return out;
}

/** Series for one chart panel: one line per selected lap per channel. */
export function overlaySeries(
  state: Pick<LabState, 'sessions' | 'selectedLaps' | 'workspace'>,
  panel: Workspace['panels'][number],
): OverlayLine[] {
  const entries = selectedLapEntries(state);
  const multi = new Set(entries.map((e) => e.s.id)).size > 1;
  const lines: OverlayLine[] = [];
  entries.forEach(({ s, lap }, li) => {
    const perSession = entries.filter((e) => e.s.id === s.id);
    const k = perSession.findIndex((e) => e.lap === lap);
    const factor = perSession.length > 1 ? 1.25 - (k / Math.max(1, perSession.length - 1)) * 0.6 : 1;
    const x = lapX(s, lap, state.workspace.xAxis);
    panel.channels.forEach((pc, ci) => {
      const ch = s.channels.get(pc.name);
      if (!ch) return;
      const y = ch.data.slice(lap.startIdx, lap.endIdx + 1);
      const base = ch.color && panel.channels.length > 1 ? ch.color : s.color;
      lines.push({
        key: `${s.id}:${lap.n}:${pc.name}`,
        label: `${lapLabel(s, lap, multi)} ${pc.name}`,
        color: panel.channels.length > 1 && ci > 0 ? shade(base, 0.7) : shade(base, factor),
        x,
        y,
        axis: pc.axis,
        sessionId: s.id,
        lap: lap.n,
        startIdx: lap.startIdx,
        channel: pc.name,
      });
      void li;
    });
  });
  return lines;
}

/** Sample index in a session for an x position (distance or lap time) within a lap. */
export function cursorIdxFromX(s: Session, lap: Lap, x: number, xAxis: Workspace['xAxis']): number {
  const xs = lapX(s, lap, xAxis);
  let lo = 0;
  let hi = xs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lap.startIdx + lo;
}

/** X position of a session sample index within its lap (inverse of cursorIdxFromX). */
export function xFromIdx(s: Session, idx: number, xAxis: Workspace['xAxis']): { lap: Lap; x: number } | null {
  const lap = s.laps.find((l) => idx >= l.startIdx && idx <= l.endIdx);
  if (!lap) return null;
  const xs = lapX(s, lap, xAxis);
  return { lap, x: xs[idx - lap.startIdx] };
}

export function allChannelNames(sessions: Session[]): string[] {
  const names = new Set<string>();
  for (const s of sessions) for (const n of s.channels.keys()) names.add(n);
  return [...names].sort();
}

export function fmtLapTime(s: number): string {
  if (!Number.isFinite(s)) return '–';
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(2).padStart(5, '0')}`;
}

export function fmtDelta(s: number): string {
  if (!Number.isFinite(s)) return '–';
  return `${s >= 0 ? '+' : '−'}${Math.abs(s).toFixed(2)}`;
}
