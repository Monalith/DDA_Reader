// Turns store changes into usage events without touching the store: compare the
// previous and next snapshot of a few fields on every update. Kept free of the
// store import so unit tests can drive it with a fake subscribe.

export interface ObservedSession {
  id: string;
  name: string;
  source: string;
  laps: readonly unknown[];
  isExample?: boolean;
  isSim?: boolean;
}

export interface ObservedState {
  sessions: readonly ObservedSession[];
  selectedLaps: readonly unknown[];
  workspace: { panels: ReadonlyArray<{ id: string; title?: string }>; mathChannels: ReadonlyArray<{ name: string }> };
  markers: readonly unknown[];
  simEnabled: boolean;
  videoSync: { fileName?: string } | null;
}

export type Emit = (event: string, props?: Record<string, unknown>) => void;
export type Subscribe<S> = (listener: (state: S, prev: S) => void) => () => void;

export interface DeriveOptions {
  now?: () => number;
  /** Minimum gap between two lap_select events (ms). */
  lapSelectGapMs?: number;
  /** Template ids by their panel-id signature (`p1,p2,…`), see chartTemplates. */
  templates?: ReadonlyArray<{ id: string; panels: ReadonlyArray<{ id: string }> }>;
}

/** `vs-ref` when the panels are a fresh copy of that template (ids `t1-<stamp>`, …). */
export function templateOf(
  panels: ReadonlyArray<{ id: string }>,
  templates: DeriveOptions['templates'] = [],
): { id: string; stamp: string } | null {
  if (!panels.length) return null;
  const m = /^(.*)-([a-z0-9]+)$/.exec(panels[0].id);
  if (!m) return null;
  const stamp = m[2];
  const base: string[] = [];
  for (const p of panels) {
    if (!p.id.endsWith(`-${stamp}`)) return null;
    base.push(p.id.slice(0, -stamp.length - 1));
  }
  const sig = base.join(',');
  const t = templates.find((t) => t.panels.map((p) => p.id).join(',') === sig);
  return t ? { id: t.id, stamp } : null;
}

const ext = (s: ObservedSession) => (s.source || /\.([a-z0-9]+)$/i.exec(s.name)?.[1] || 'unknown').toLowerCase();

export function watchStore<S extends ObservedState>(subscribe: Subscribe<S>, emit: Emit, opts: DeriveOptions = {}): () => void {
  const now = opts.now ?? (() => Date.now());
  const gap = opts.lapSelectGapMs ?? 5000;
  let lastLapSelect = -Infinity;

  return subscribe((st, prev) => {
    try {
      if (st.sessions !== prev.sessions) {
        const before = new Set(prev.sessions.map((s) => s.id));
        for (const s of st.sessions) {
          if (before.has(s.id) || s.isSim) continue;
          if (s.isExample) emit('example_open', { name: s.name });
          else emit('file_open', { ext: ext(s), laps: s.laps.length });
        }
      }
      if (st.selectedLaps !== prev.selectedLaps && st.selectedLaps.length && st.sessions === prev.sessions) {
        const t = now();
        if (t - lastLapSelect >= gap) {
          lastLapSelect = t;
          emit('lap_select', { n: st.selectedLaps.length });
        }
      }
      const ws = st.workspace;
      const pws = prev.workspace;
      if (ws.panels !== pws.panels && ws.panels.some((p) => p.title)) {
        const t = templateOf(ws.panels, opts.templates);
        const pt = templateOf(pws.panels, opts.templates);
        if (t && (!pt || pt.stamp !== t.stamp)) emit('template_apply', { id: t.id });
      }
      if (ws.mathChannels !== pws.mathChannels && ws.mathChannels.length > pws.mathChannels.length) {
        emit('math_add', { n: ws.mathChannels.length });
      }
      if (st.markers !== prev.markers && st.markers.length > prev.markers.length && st.sessions === prev.sessions) {
        emit('marker_add');
      }
      if (st.simEnabled && !prev.simEnabled) emit('sim_enable');
      if (st.videoSync && st.videoSync.fileName !== prev.videoSync?.fileName) emit('video_open');
    } catch {
      /* analytics never breaks the app */
    }
  });
}
