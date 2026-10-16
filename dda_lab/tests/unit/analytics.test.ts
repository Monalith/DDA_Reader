import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTracker, type Sender } from '../../src/analytics/track';
import { templateOf, watchStore, type ObservedState } from '../../src/analytics/derive';

interface Sent {
  url: string;
  body: { anonId: string; events: Array<{ event: string; ts: string; props?: Record<string, unknown> }> };
  beacon: boolean;
}

function recorder(result: boolean | (() => boolean) = true) {
  const sent: Sent[] = [];
  const sender: Sender = (url, body, beacon) => {
    sent.push({ url, body: JSON.parse(body), beacon });
    return typeof result === 'function' ? result() : result;
  };
  return { sent, sender };
}

const base = (sender: Sender, extra: Parameters<typeof createTracker>[0] = {}) =>
  createTracker({ sender, endpoint: () => '/api/stats/events', anonId: () => 'anon-t', enabled: () => true, ...extra });

describe('tracker queue', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('flushes after 10 s with the anonId and ISO timestamps', () => {
    const { sent, sender } = recorder();
    const t = base(sender);
    t.track('app_open', { viewport: '800x600' });
    t.track('lap_select');
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(9_999);
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('/api/stats/events');
    expect(sent[0].beacon).toBe(false);
    expect(sent[0].body.anonId).toBe('anon-t');
    expect(sent[0].body.events.map((e) => e.event)).toEqual(['app_open', 'lap_select']);
    expect(sent[0].body.events[0].props).toEqual({ viewport: '800x600' });
    expect(sent[0].body.events[1].props).toBeUndefined();
    expect(() => new Date(sent[0].body.events[0].ts).toISOString()).not.toThrow();
    expect(t.pending()).toBe(0);
  });

  it('flushes immediately at 20 events', () => {
    const { sent, sender } = recorder();
    const t = base(sender);
    for (let i = 0; i < 19; i++) t.track('e');
    expect(sent).toHaveLength(0);
    t.track('e');
    expect(sent).toHaveLength(1);
    expect(sent[0].body.events).toHaveLength(20);
  });

  it('beacon flush (page hidden) sends everything in batches of 50', () => {
    const { sent, sender } = recorder();
    const t = base(sender, { maxQueue: 1000 });
    for (let i = 0; i < 120; i++) t.track('e');
    t.flush(true);
    expect(sent.map((s) => s.body.events.length)).toEqual([50, 50, 20]);
    expect(sent.every((s) => s.beacon)).toBe(true);
  });

  it('keeps the queue when the sender refuses and retries later', () => {
    let ok = false;
    const { sent, sender } = recorder(() => ok);
    const t = base(sender);
    t.track('a');
    t.flush();
    expect(t.pending()).toBe(1);
    ok = true;
    t.track('b');
    t.flush();
    expect(t.pending()).toBe(0);
    expect(sent.at(-1)!.body.events.map((e) => e.event)).toEqual(['a', 'b']);
  });

  it('never throws, even when the sender does', () => {
    const t = base(() => {
      throw new Error('offline');
    });
    expect(() => {
      for (let i = 0; i < 25; i++) t.track('e');
      t.flush(true);
    }).not.toThrow();
  });

  it('is a no-op when disabled (automation)', () => {
    const { sent, sender } = recorder();
    const t = base(sender, { enabled: () => false });
    t.track('app_open');
    vi.advanceTimersByTime(20_000);
    t.flush(true);
    expect(sent).toHaveLength(0);
    expect(t.pending()).toBe(0);
  });
});

// ---- store-derived events ------------------------------------------------------

function fakeStore(initial: ObservedState) {
  let state = initial;
  const listeners = new Set<(s: ObservedState, p: ObservedState) => void>();
  return {
    subscribe(l: (s: ObservedState, p: ObservedState) => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    set(patch: Partial<ObservedState>) {
      const prev = state;
      state = { ...state, ...patch };
      for (const l of listeners) l(state, prev);
    },
    get: () => state,
  };
}

const empty = (): ObservedState => ({
  sessions: [],
  selectedLaps: [],
  workspace: { panels: [{ id: 'p1' }], mathChannels: [] },
  markers: [],
  simEnabled: false,
  videoSync: null,
});

const TEMPLATES = [
  { id: 'vs-ref', panels: [{ id: 't1' }, { id: 't2' }] },
  { id: 'braking', panels: [{ id: 'b1' }] },
];

describe('watchStore', () => {
  it('derives file/example/lap/template/math/marker/sim/video events', () => {
    const st = fakeStore(empty());
    const events: Array<[string, Record<string, unknown> | undefined]> = [];
    let now = 0;
    const stop = watchStore(st.subscribe, (e, p) => events.push([e, p]), { now: () => now, templates: TEMPLATES });

    const dda = { id: 's1', name: 'Run036', source: 'dda', laps: [1, 2, 3] };
    st.set({ sessions: [dda] });
    st.set({ sessions: [dda, { id: 'ex', name: 'Serres', source: 'json', laps: [1], isExample: true }] });
    st.set({ sessions: [...st.get().sessions, { id: 'sim', name: 'Virtual rider', source: 'sim', laps: [1], isSim: true }] });
    st.set({ selectedLaps: [{ lap: 1 }] });
    now = 1000;
    st.set({ selectedLaps: [{ lap: 2 }] }); // throttled
    now = 6000;
    st.set({ selectedLaps: [{ lap: 2 }, { lap: 3 }] });
    st.set({ workspace: { ...st.get().workspace, panels: [{ id: 't1-abc', title: 'Δ' }, { id: 't2-abc', title: 'Δ' }] } });
    st.set({ workspace: { ...st.get().workspace, panels: [{ id: 't1-abc', title: 'Δ!' }, { id: 't2-abc', title: 'Δ' }] } }); // edit, same stamp
    st.set({ workspace: { ...st.get().workspace, mathChannels: [{ name: 'm1' }] } });
    st.set({ workspace: { ...st.get().workspace, mathChannels: [] } });
    st.set({ markers: [{}] });
    st.set({ simEnabled: true });
    st.set({ simEnabled: false });
    st.set({ videoSync: { fileName: 'onboard.mp4' } });
    st.set({ videoSync: { fileName: 'onboard.mp4' } });
    stop();
    st.set({ simEnabled: true });

    expect(events).toEqual([
      ['file_open', { ext: 'dda', laps: 3 }],
      ['example_open', { name: 'Serres' }],
      ['lap_select', { n: 1 }],
      ['lap_select', { n: 2 }],
      ['template_apply', { id: 'vs-ref' }],
      ['math_add', { n: 1 }],
      ['marker_add', undefined],
      ['sim_enable', undefined],
      ['video_open', undefined],
    ]);
  });

  it('does not count markers restored together with a newly opened file', () => {
    const st = fakeStore(empty());
    const events: string[] = [];
    watchStore(st.subscribe, (e) => events.push(e));
    st.set({ sessions: [{ id: 's1', name: 'a', source: 'csv', laps: [] }], markers: [{}, {}] });
    expect(events).toEqual(['file_open']);
  });

  it('templateOf recognises fresh template copies only', () => {
    expect(templateOf([{ id: 'b1-x9' }], TEMPLATES)).toEqual({ id: 'braking', stamp: 'x9' });
    expect(templateOf([{ id: 't1-a' }, { id: 't2-b' }], TEMPLATES)).toBeNull();
    expect(templateOf([{ id: 'p1' }], TEMPLATES)).toBeNull();
    expect(templateOf([], TEMPLATES)).toBeNull();
  });
});
