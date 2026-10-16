// Onboard video in the map pane, synchronised with the telemetry.
//
//  data → video: hovering / clicking a chart or the map moves the video to that sample
//                (cached frames are drawn on a canvas instantly, the <video> settles after);
//  video → data: while playing (or scrubbing the video's own bar) the store cursor follows the
//                video, marked `cursorSource: 'video'` so the follow logic never loops back.
//
// Sync: video_time = session.t[idx] − offsetS (src/video/sync.ts).
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import './video.css';
import { useLab, type CursorPos } from '../state/store';
import { fmtLapTime } from '../state/selectors';
import { DEFAULT_CACHE_OPTIONS, FrameCache, fileCacheKey, probeFps, type CacheProgress } from '../video/frameCache';
import { syncIdxForCursor, syncedWorkspaceLap, xRangeIdxRange } from '../video/follow';
import {
  fmtTimecode,
  frameIndexAt,
  idxForVideoTime,
  lapAtIdx,
  lapsVideoRange,
  loadStoredSyncs,
  roundOffset,
  stepFrames,
  storeSync,
  videoTimeOfIdx,
} from '../video/sync';
import type { Session } from '../core/types';

const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4];
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv)$/i;
const SETTLE_MS = 140;
const HAS_RVFC = typeof HTMLVideoElement !== 'undefined' && 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

// ---- live "what is on screen" for the overlay (outside React state: updated per frame) ----
interface LiveInfo {
  idx: number | null;
  vt: number;
}
let live: LiveInfo = { idx: null, vt: 0 };
const liveSubs = new Set<() => void>();
function emitLive(next: LiveInfo): void {
  if (next.idx === live.idx && Math.abs(next.vt - live.vt) < 1e-3) return;
  live = next;
  for (const f of liveSubs) f();
}
const subscribeLive = (f: () => void) => {
  liveSubs.add(f);
  return () => liveSubs.delete(f);
};
const getLive = () => live;

// ---- measurements (read with browser_evaluate: window.__video) ----
interface VideoStats {
  scrubMs: number[];
  pointerToDrawMs: number[];
  seekMs: number[];
  draws: number;
  cacheFrames: number;
  cacheBytes: number;
  cacheFps: number;
  decoded: number;
  lastVideoT: number;
  lastIdx: number | null;
}
const stats: VideoStats = { scrubMs: [], pointerToDrawMs: [], seekMs: [], draws: 0, cacheFrames: 0, cacheBytes: 0, cacheFps: 0, decoded: 0, lastVideoT: 0, lastIdx: null };
const pushStat = (a: number[], v: number) => {
  a.push(Math.round(v * 100) / 100);
  if (a.length > 300) a.shift();
};
let lastPointerTs = 0;
if (typeof window !== 'undefined') {
  (window as unknown as { __video: VideoStats }).__video = stats;
  window.addEventListener('pointermove', (e) => (lastPointerTs = e.timeStamp), { capture: true, passive: true });
}

function overlayValues(s: Session | undefined, idx: number | null) {
  if (!s || idx == null) return null;
  const v = (n: string) => s.channels.get(n)?.data[idx];
  const lap = lapAtIdx(s.laps, idx);
  return {
    speed: v('speed') ?? v('gps_speed'),
    gear: v('gear'),
    rpm: v('rpm'),
    lean: v('lean'),
    tps: v('tps'),
    lap: lap?.n,
    lapTime: lap ? s.t[idx] - s.t[lap.startIdx] : undefined,
  };
}

const f0 = (x: number | undefined) => (x === undefined || !Number.isFinite(x) ? '–' : x.toFixed(0));

function VideoOverlay({ session }: { session: Session | undefined }) {
  const info = useSyncExternalStore(subscribeLive, getLive);
  const o = overlayValues(session, info.idx);
  return (
    <div className="video-overlay" data-testid="video-overlay">
      {o ? (
        <>
          <div className="vo-big num" data-testid="video-overlay-speed">
            {f0(o.speed)}
            <span className="vo-unit">km/h</span>
          </div>
          <div className="vo-row num">
            <span>G {o.gear === undefined || !Number.isFinite(o.gear) ? '–' : Math.round(o.gear)}</span>
            <span>{f0(o.rpm)} rpm</span>
          </div>
          <div className="vo-row num">
            <span>lean {o.lean === undefined || !Number.isFinite(o.lean) ? '–' : `${o.lean.toFixed(0)}°`}</span>
            <span>tps {f0(o.tps)}%</span>
          </div>
          {o.lap !== undefined && (
            <div className="vo-row num">
              <span>L{o.lap}</span>
              <span>{fmtLapTime(o.lapTime ?? NaN)}</span>
            </div>
          )}
        </>
      ) : (
        <div className="vo-row dim">outside the synced run</div>
      )}
      <div className="vo-tc num" data-testid="video-timecode">
        {fmtTimecode(info.vt)}
      </div>
    </div>
  );
}

/**
 * 🏁 START badge on the picture: the displayed frame is within one frame of the start line;
 * before it a dim "before start" hint. Shown with or without the HUD.
 */
function StartLineBadge({ startS, fps }: { startS: number | undefined; fps: number }) {
  const info = useSyncExternalStore(subscribeLive, getLive);
  if (startS === undefined) return null;
  const frame = 1 / (fps > 0 ? fps : 30);
  const d = info.vt - startS;
  if (Math.abs(d) < frame - 1e-6)
    return (
      <div className="video-start-badge" data-testid="video-start-badge">
        🏁 START
      </div>
    );
  if (d < 0)
    return (
      <div className="video-before-start dim num" data-testid="video-before-start">
        before start · −{fmtTimecode(-d)}
      </div>
    );
  return null;
}

/** Text lines drawn on an exported frame. */
function overlayLines(session: Session | undefined, idx: number | null, vt: number): string[] {
  const o = overlayValues(session, idx);
  const out: string[] = [];
  if (o) {
    out.push(`${f0(o.speed)} km/h   G ${o.gear === undefined || !Number.isFinite(o.gear) ? '–' : Math.round(o.gear)}   ${f0(o.rpm)} rpm`);
    out.push(`lean ${o.lean === undefined || !Number.isFinite(o.lean) ? '–' : o.lean.toFixed(0) + '°'}   tps ${f0(o.tps)}%`);
    if (o.lap !== undefined) out.push(`L${o.lap}  ${fmtLapTime(o.lapTime ?? NaN)}`);
  }
  out.push(fmtTimecode(vt));
  return out;
}

export function MapVideoToggle() {
  const view = useLab((s) => s.videoView);
  const setView = useLab((s) => s.setVideoView);
  return (
    <div className="map-video-toggle" role="group" aria-label="Map or video" data-testid="map-video-toggle">
      {(['map', 'video', 'both'] as const).map((v) => (
        <button
          key={v}
          className={view === v ? 'active' : ''}
          data-testid={`map-video-toggle-${v}`}
          aria-pressed={view === v}
          title={v === 'both' ? 'Map with the video as picture-in-picture' : v === 'map' ? 'Show the map' : 'Show the onboard video'}
          onClick={() => setView(v)}
        >
          {v === 'map' ? 'Map' : v === 'video' ? 'Video' : 'Both'}
        </button>
      ))}
    </div>
  );
}

export default function VideoPanel() {
  const view = useLab((s) => s.videoView);
  const sessions = useLab((s) => s.sessions);
  const sync = useLab((s) => s.videoSync);
  const follow = useLab((s) => s.videoFollow);
  const reopen = useLab((s) => s.videoReopenName);
  const selectedLaps = useLab((s) => s.selectedLaps);
  const { setVideoSync, setVideoFollow, setStatus } = useLab.getState();

  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ duration: number; w: number; h: number } | null>(null);
  const [fps, setFps] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [loop, setLoop] = useState<'off' | 'lap' | 'range'>('off');
  const [overlay, setOverlay] = useState(true);
  const [progress, setProgress] = useState<CacheProgress | null>(null);
  const [cacheScope, setCacheScope] = useState<'laps' | 'all'>('laps');
  const [dragOver, setDragOver] = useState(false);
  const [offsetText, setOffsetText] = useState('0');
  const [lapPick, setLapPick] = useState<number | ''>('');
  const [curT, setCurT] = useState(0);
  const [muted, setMuted] = useState(true);

  const panelRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cacheRef = useRef<FrameCache | null>(null);
  const targetT = useRef<number | null>(null);
  const pendingSeek = useRef<number | null>(null);
  const seekStart = useRef<number>(0);
  const settleTimer = useRef<number | null>(null);
  const lastIdx = useRef<number | null>(null);
  const loopRange = useRef<[number, number] | null>(null);
  const rvfcId = useRef<number | null>(null);
  const autoCached = useRef<string | null>(null);

  const session = useMemo(() => sessions.find((s) => s.id === sync?.sessionId), [sessions, sync?.sessionId]);
  const realSessions = useMemo(() => sessions.filter((s) => !s.isSim), [sessions]);
  const effFps = fps ?? 30;
  const startVideoS = useLab((s) => s.videoSync?.startVideoS);

  // latest values for the long-lived callbacks
  const ctl = useRef({ session, sync, meta, playing, loop, effFps, view, file });
  ctl.current = { session, sync, meta, playing, loop, effFps, view, file };

  useEffect(() => {
    if (sync) setOffsetText(String(roundOffset(sync.offsetS)));
  }, [sync]);

  // ---------------------------------------------------------------- drawing / seeking
  const hideCanvas = useCallback(() => {
    const c = canvasRef.current;
    if (c && c.style.visibility !== 'hidden') c.style.visibility = 'hidden';
  }, []);

  const draw = useCallback((bmp: ImageBitmap) => {
    const c = canvasRef.current;
    if (!c) return;
    if (c.width !== bmp.width || c.height !== bmp.height) {
      c.width = bmp.width;
      c.height = bmp.height;
    }
    c.getContext('2d')?.drawImage(bmp, 0, 0);
    c.style.visibility = 'visible';
    stats.draws++;
  }, []);

  const seekVideo = useCallback((t: number) => {
    const v = videoRef.current;
    if (!v) return;
    if (v.seeking) {
      pendingSeek.current = t;
      return;
    }
    seekStart.current = performance.now();
    v.currentTime = t;
  }, []);

  /** Push the store cursor to the sample at video time vt (video → data). */
  const driveCursor = useCallback((vt: number) => {
    const { session: s, sync: sy } = ctl.current;
    if (!s || !sy) return;
    const idx = idxForVideoTime(s.t, vt, sy.offsetS);
    emitLive({ idx, vt });
    stats.lastVideoT = vt;
    stats.lastIdx = idx;
    if (idx == null || idx === lastIdx.current) return;
    lastIdx.current = idx;
    useLab.getState().setCursor({ sessionId: s.id, idx }, 'video');
  }, []);

  /**
   * Show video time vt as fast as possible: a cached frame now, the real frame once the
   * cursor rests. `t0` is when the request started (latency stats).
   */
  const showAt = useCallback(
    (vtIn: number, opts: { fromData: boolean; idx?: number | null; t0?: number }) => {
      const v = videoRef.current;
      const m = ctl.current.meta;
      if (!v || !m) return;
      const vt = Math.max(0, Math.min(m.duration - 0.001, vtIn));
      targetT.current = vt;
      if (opts.fromData) {
        emitLive({ idx: opts.idx ?? null, vt });
        stats.lastVideoT = vt;
      } else driveCursor(vt);
      const cache = cacheRef.current;
      let drew = false;
      let cachedSlot: number | null = null;
      if (cache && cache.size) {
        cachedSlot = cache.nearest(vt);
        if (cachedSlot != null) {
          const bmp = cache.bitmapNow(cachedSlot);
          if (bmp) {
            draw(bmp);
            drew = true;
          } else {
            const k = cachedSlot;
            void cache.decode(k).then((b) => {
              if (b && targetT.current === vt && !ctl.current.playing) {
                draw(b);
                if (opts.t0 !== undefined) pushStat(stats.scrubMs, performance.now() - opts.t0);
              }
            });
          }
          cache.prefetch(cachedSlot);
        }
      }
      if (drew) {
        const now = performance.now();
        if (opts.t0 !== undefined) pushStat(stats.scrubMs, now - opts.t0);
        if (lastPointerTs) pushStat(stats.pointerToDrawMs, now - lastPointerTs);
      }
      if (settleTimer.current != null) window.clearTimeout(settleTimer.current);
      if (cachedSlot == null) {
        // nothing cached here: seek the element directly (coalesced while it is busy)
        seekVideo(vt);
      } else {
        settleTimer.current = window.setTimeout(() => {
          settleTimer.current = null;
          if (targetT.current === vt) seekVideo(vt);
        }, SETTLE_MS);
      }
    },
    [draw, driveCursor, seekVideo],
  );

  const onSeeked = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    pushStat(stats.seekMs, performance.now() - seekStart.current);
    if (pendingSeek.current != null) {
      const t = pendingSeek.current;
      pendingSeek.current = null;
      seekStart.current = performance.now();
      v.currentTime = t;
      return;
    }
    setCurT(v.currentTime);
    if (targetT.current == null || Math.abs(v.currentTime - targetT.current) < 0.03) hideCanvas();
  }, [hideCanvas]);

  /** Exact seek (frame steps, jumps): the element itself, cursor follows. */
  const seekExact = useCallback(
    (t: number) => {
      const m = ctl.current.meta;
      if (!m) return;
      const vt = Math.max(0, Math.min(m.duration - 0.001, t));
      targetT.current = vt;
      hideCanvas();
      if (settleTimer.current != null) window.clearTimeout(settleTimer.current);
      seekVideo(vt);
      driveCursor(vt);
      setCurT(vt);
    },
    [driveCursor, hideCanvas, seekVideo],
  );

  const currentVideoT = useCallback((): number => {
    const v = videoRef.current;
    if (!v) return 0;
    if (!v.paused) return v.currentTime;
    return targetT.current ?? v.currentTime;
  }, []);

  // ---------------------------------------------------------------- data → video
  useEffect(
    () =>
      useLab.subscribe((st, prev) => {
        const t0 = performance.now();
        const c = ctl.current;
        if (!c.meta || !c.sync || !c.session) return;
        if (st.videoFollow === 'off') return;
        let target: CursorPos | null = null;
        let isClick = false;
        if (st.clickPos !== prev.clickPos && st.clickPos) {
          target = st.clickPos;
          isClick = true;
        } else if (st.videoFollow === 'hover' && st.cursor !== prev.cursor && st.cursor && st.cursorSource === 'user' && !c.playing) {
          target = st.cursor;
        }
        if (!target) return;
        if (c.view === 'map' && !c.playing) return; // nothing on screen to move
        const idx = syncIdxForCursor(st, target, c.sync.sessionId);
        if (idx == null) return;
        const vt = videoTimeOfIdx(c.session.t, idx, c.sync.offsetS);
        lastIdx.current = idx;
        if (c.playing && isClick) {
          const v = videoRef.current;
          if (v) v.currentTime = Math.max(0, vt);
          return;
        }
        showAt(vt, { fromData: true, idx, t0 });
      }),
    [showAt],
  );

  // ---------------------------------------------------------------- video → data (playback)
  const armLoop = useCallback(() => {
    const { session: s, sync: sy, loop: lp } = ctl.current;
    loopRange.current = null;
    if (!s || !sy || lp === 'off') return;
    const st = useLab.getState();
    const idx = idxForVideoTime(s.t, currentVideoT(), sy.offsetS) ?? lastIdx.current;
    if (idx == null) return;
    if (lp === 'lap') {
      const lap = lapAtIdx(s.laps, idx);
      if (lap) loopRange.current = [videoTimeOfIdx(s.t, lap.startIdx, sy.offsetS), videoTimeOfIdx(s.t, lap.endIdx, sy.offsetS)];
    } else if (st.xRange) {
      const r = xRangeIdxRange(s, idx, st.xRange, st.workspace.xAxis);
      if (r) loopRange.current = [videoTimeOfIdx(s.t, r[0], sy.offsetS), videoTimeOfIdx(s.t, r[1], sy.offsetS)];
    }
  }, [currentVideoT]);

  useEffect(() => {
    armLoop();
  }, [loop, armLoop]);

  const onFrame = useCallback(
    (_now: number, m: VideoFrameCallbackMetadata) => {
      const v = videoRef.current;
      if (!v) return;
      hideCanvas();
      let mt = m.mediaTime;
      const lr = loopRange.current;
      if (lr && (mt >= lr[1] || mt < lr[0] - 0.5)) {
        v.currentTime = Math.max(0, lr[0]);
        mt = lr[0];
      }
      targetT.current = null;
      driveCursor(mt);
      if (!v.paused) rvfcId.current = v.requestVideoFrameCallback(onFrame);
    },
    [driveCursor, hideCanvas],
  );

  const onPlay = useCallback(() => {
    setPlaying(true);
    armLoop();
    const v = videoRef.current;
    if (v && HAS_RVFC) rvfcId.current = v.requestVideoFrameCallback(onFrame);
  }, [armLoop, onFrame]);

  const onPause = useCallback(() => {
    setPlaying(false);
    const v = videoRef.current;
    if (v && rvfcId.current != null && HAS_RVFC) v.cancelVideoFrameCallback(rvfcId.current);
    rvfcId.current = null;
    if (v) {
      targetT.current = v.currentTime;
      setCurT(v.currentTime);
    }
  }, []);

  const onTimeUpdate = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (!v.paused) setCurT(v.currentTime);
    // browsers without requestVideoFrameCallback: drive from timeupdate
    if (!v.paused && !HAS_RVFC) driveCursor(v.currentTime);
  }, [driveCursor]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v || !ctl.current.meta) return;
    if (v.paused) {
      if (targetT.current != null && Math.abs(v.currentTime - targetT.current) > 0.02) v.currentTime = targetT.current;
      void v.play();
    } else v.pause();
  }, []);

  const playFromCursor = useCallback(() => {
    const { session: s, sync: sy } = ctl.current;
    const v = videoRef.current;
    if (!s || !sy || !v) return;
    const st = useLab.getState();
    const idx = syncIdxForCursor(st, st.cursor ?? st.clickPos, sy.sessionId);
    if (idx == null) return setStatus('Put the cursor on a sample of the synced run first');
    v.currentTime = Math.max(0, videoTimeOfIdx(s.t, idx, sy.offsetS));
    targetT.current = v.currentTime;
    void v.play();
  }, [setStatus]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = rate;
  }, [rate, url]);

  // ---------------------------------------------------------------- open / close
  const openFile = useCallback(
    (f: File) => {
      if (!(f.type.startsWith('video/') || VIDEO_EXT.test(f.name))) {
        setStatus(`${f.name} is not a video`);
        return;
      }
      cacheRef.current?.dispose();
      cacheRef.current = new FrameCache(fileCacheKey(f), DEFAULT_CACHE_OPTIONS);
      autoCached.current = null;
      setProgress(null);
      setMeta(null);
      setFps(null);
      setPlaying(false);
      lastIdx.current = null;
      targetT.current = null;
      setUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return URL.createObjectURL(f);
      });
      setFile(f);
      const st = useLab.getState();
      const real = st.sessions.filter((s) => !s.isSim);
      const stored = loadStoredSyncs(typeof localStorage === 'undefined' ? undefined : localStorage)[f.name];
      let sessionId: string | undefined;
      let offsetS = 0;
      if (st.videoSync && st.videoSync.fileName === f.name && real.some((s) => s.id === st.videoSync!.sessionId)) {
        sessionId = st.videoSync.sessionId;
        offsetS = st.videoSync.offsetS;
      } else if (stored) {
        offsetS = stored.offsetS;
        sessionId = real.find((s) => s.name === stored.sessionName)?.id;
      }
      sessionId ??= (st.cursor && real.some((s) => s.id === st.cursor!.sessionId) ? st.cursor.sessionId : undefined) ?? real[0]?.id ?? '';
      setVideoSync({ sessionId, fileName: f.name, offsetS });
      useLab.setState({ videoReopenName: null });
      if (st.videoView === 'map') st.setVideoView('video');
      setStatus(`Video ${f.name} opened${stored || st.videoSync?.fileName === f.name ? ` — sync restored (offset ${roundOffset(offsetS)} s)` : ' — set the sync (Sync here / offset)'}`);
    },
    [setStatus, setVideoSync],
  );

  useEffect(
    () => () => {
      cacheRef.current?.dispose();
    },
    [],
  );

  const onLoadedMeta = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    setMeta({ duration: v.duration, w: v.videoWidth, h: v.videoHeight });
    v.playbackRate = rate;
    if (url) void probeFps(url).then((f) => f && setFps(f));
    // first picture: the synced cursor's moment if there is one
    const st = useLab.getState();
    const { session: s, sync: sy } = ctl.current;
    const idx = s && sy ? syncIdxForCursor(st, st.clickPos ?? st.cursor, sy.sessionId) : null;
    if (s && sy && idx != null) {
      const vt = videoTimeOfIdx(s.t, idx, sy.offsetS);
      if (vt >= 0 && vt <= v.duration) {
        v.currentTime = vt;
        targetT.current = vt;
        emitLive({ idx, vt });
      }
    }
  }, [rate, url]);

  // ---------------------------------------------------------------- frame cache
  const cacheRange = useCallback((): [number, number] | null => {
    const { session: s, sync: sy, meta: m } = ctl.current;
    if (!m) return null;
    const all: [number, number] = [0, m.duration];
    if (cacheScope === 'all' || !s || !sy) return all;
    const st = useLab.getState();
    const laps = st.selectedLaps.filter((r) => r.sessionId === s.id).map((r) => s.laps.find((l) => l.n === r.lap)).filter((l) => !!l);
    const r = lapsVideoRange(s.t, laps, sy.offsetS);
    if (!r) return all;
    const a = Math.max(0, r[0]);
    const b = Math.min(m.duration, r[1]);
    return b > a ? [a, b] : all;
  }, [cacheScope]);

  const runCache = useCallback(async () => {
    const cache = cacheRef.current;
    if (!cache || !url || !meta) return;
    if (cache.building) {
      cache.cancel();
      return;
    }
    const range = cacheRange();
    if (!range) return;
    let raf = 0;
    let last: CacheProgress | null = null;
    const t0 = performance.now();
    await cache.build(url, range, meta.duration, (p) => {
      last = p;
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          setProgress(last);
        });
    });
    cancelAnimationFrame(raf);
    stats.cacheFrames = cache.size;
    stats.cacheBytes = cache.bytes();
    stats.cacheFps = cache.fps;
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    setProgress({ done: cache.size, total: last ? (last as CacheProgress).total : cache.size, phase: 'done' });
    setStatus(`Video pre-processed: ${cache.size} frames at ${cache.fps.toFixed(1)} fps (${fmtTimecode(range[0])}–${fmtTimecode(range[1])}) in ${secs} s, ${(cache.bytes() / 1e6).toFixed(0)} MB`);
  }, [url, meta, cacheRange, setStatus]);

  // pre-process once per opened video, as soon as it is known
  useEffect(() => {
    if (!meta || !url || autoCached.current === url) return;
    autoCached.current = url;
    void runCache();
  }, [meta, url, runCache]);

  useEffect(() => {
    const id = window.setInterval(() => {
      const c = cacheRef.current;
      if (c) stats.decoded = c.decoded.size;
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  // ---------------------------------------------------------------- sync controls
  const setOffset = useCallback(
    (off: number, sessionId?: string) => {
      const { sync: sy, session: s } = ctl.current;
      if (!sy) return;
      const offsetS = roundOffset(off);
      const sid = sessionId ?? sy.sessionId;
      setVideoSync({ ...sy, sessionId: sid, offsetS });
      const sess = useLab.getState().sessions.find((x) => x.id === sid) ?? s;
      storeSync(typeof localStorage === 'undefined' ? undefined : localStorage, sy.fileName, { offsetS, sessionName: sess?.name, startVideoS: sy.startVideoS });
      // show the same sample under the new offset
      const idx = lastIdx.current;
      if (sess && idx != null && !ctl.current.playing) {
        ctl.current = { ...ctl.current, sync: { ...sy, sessionId: sid, offsetS }, session: sess };
        showAt(videoTimeOfIdx(sess.t, idx, offsetS), { fromData: true, idx });
      }
    },
    [setVideoSync, showAt],
  );

  const syncHere = useCallback(() => {
    const st = useLab.getState();
    const pos = st.clickPos ?? st.cursor;
    if (!pos) return setStatus('Click the matching sample on a chart or the map first, then press Sync here');
    const s = st.sessions.find((x) => x.id === pos.sessionId);
    if (!s) return;
    const vt = currentVideoT();
    lastIdx.current = pos.idx;
    setOffset(s.t[pos.idx] - vt, s.id);
    setStatus(`Synced: video ${fmtTimecode(vt)} = ${s.name} t=${s.t[pos.idx].toFixed(2)} s (offset ${roundOffset(s.t[pos.idx] - vt)} s)`);
  }, [currentVideoT, setOffset, setStatus]);

  const syncLapStart = useCallback(() => {
    const { session: s } = ctl.current;
    if (!s || lapPick === '') return;
    const lap = s.laps.find((l) => l.n === lapPick);
    if (!lap) return;
    lastIdx.current = lap.startIdx;
    setOffset(s.t[lap.startIdx] - currentVideoT());
    setStatus(`Synced: L${lap.n} start = video ${fmtTimecode(currentVideoT())}`);
  }, [lapPick, currentVideoT, setOffset, setStatus]);

  // ---------------------------------------------------------------- start line
  const setStartLine = useCallback(() => {
    if (!ctl.current.meta) return;
    const vt = currentVideoT();
    const lapN = lapPick === '' ? undefined : lapPick;
    useLab.getState().setVideoStartLine(vt, lapN);
    emitLive({ idx: live.idx, vt }); // the badge appears on this very frame
    setStatus(`Start line = video ${fmtTimecode(vt)} (frame ${frameIndexAt(vt, ctl.current.effFps)}${lapN !== undefined ? `, L${lapN} start` : ''})`);
  }, [currentVideoT, lapPick, setStatus]);

  const goToStartLine = useCallback(() => {
    const st = useLab.getState().videoSync?.startVideoS;
    if (st === undefined) return;
    seekExact(st);
    emitLive({ idx: live.idx, vt: st });
  }, [seekExact]);

  const clearStartLine = useCallback(() => {
    useLab.getState().setVideoStartLine(null);
    setStatus('Start line cleared');
  }, [setStatus]);

  // ---------------------------------------------------------------- export
  const frameCanvas = useCallback((): HTMLCanvasElement | null => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return null;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const shownCanvas = canvasRef.current;
    if (shownCanvas && shownCanvas.style.visibility === 'visible') ctx.drawImage(shownCanvas, 0, 0, c.width, c.height);
    else ctx.drawImage(v, 0, 0);
    if (overlay) {
      const lines = overlayLines(ctl.current.session, live.idx, live.vt);
      const fs = Math.max(14, Math.round(c.height / 26));
      ctx.font = `600 ${fs}px Inter, system-ui, sans-serif`;
      const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + fs;
      const h = lines.length * fs * 1.3 + fs * 0.6;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(fs * 0.5, fs * 0.5, w, h);
      ctx.fillStyle = '#fff';
      lines.forEach((l, i) => ctx.fillText(l, fs, fs * 0.5 + fs * 1.3 * (i + 1)));
    }
    return c;
  }, [overlay]);

  const saveFrame = useCallback(() => {
    const c = frameCanvas();
    if (!c) return;
    c.toBlob((b) => {
      if (!b) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = `${(file?.name ?? 'frame').replace(/\.[^.]+$/, '')}_${fmtTimecode(live.vt).replace(/[:.]/g, '-')}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, 'image/png');
  }, [frameCanvas, file]);

  const copyFrame = useCallback(() => {
    const c = frameCanvas();
    if (!c) return;
    c.toBlob(async (b) => {
      if (!b) return;
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': b })]);
        setStatus('Frame copied to the clipboard');
      } catch (e) {
        setStatus(`Copy failed: ${(e as Error).message}`);
      }
    }, 'image/png');
  }, [frameCanvas, setStatus]);

  // ---------------------------------------------------------------- keys
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      const v = videoRef.current;
      if (!v || !ctl.current.meta) return;
      const t = currentVideoT();
      let handled = true;
      if (e.key === ' ') togglePlay();
      else if (e.key === ',') seekExact(stepFrames(t, ctl.current.effFps, -1, ctl.current.meta.duration));
      else if (e.key === '.') seekExact(stepFrames(t, ctl.current.effFps, 1, ctl.current.meta.duration));
      else if (e.key === 'ArrowLeft') seekExact(t - (e.shiftKey ? 5 : 1));
      else if (e.key === 'ArrowRight') seekExact(t + (e.shiftKey ? 5 : 1));
      else if ((e.key === 's' || e.key === 'S') && !e.metaKey && !e.ctrlKey && !e.altKey) setStartLine();
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    [currentVideoT, seekExact, setStartLine, togglePlay],
  );

  const onFullscreen = useCallback(() => {
    const el = panelRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.();
  }, []);

  // ---------------------------------------------------------------- render
  const workspaceLap = sync ? syncedWorkspaceLap({ sessions, selectedLaps, workspace: useLab.getState().workspace }, sync.sessionId) : undefined;
  const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  const building = !!cacheRef.current?.building && progress?.phase !== 'done';

  const dropProps = {
    onDragOver: (e: React.DragEvent) => {
      if (!Array.from(e.dataTransfer.items ?? []).some((i) => i.kind === 'file')) return;
      e.preventDefault();
      e.stopPropagation();
      setDragOver(true);
    },
    onDragLeave: () => setDragOver(false),
    onDrop: (e: React.DragEvent) => {
      const f = Array.from(e.dataTransfer.files).find((x) => x.type.startsWith('video/') || VIDEO_EXT.test(x.name));
      setDragOver(false);
      if (!f) return;
      e.preventDefault();
      e.stopPropagation();
      openFile(f);
    },
  };

  return (
    <div
      ref={panelRef}
      className={`video-panel view-${view} ${dragOver ? 'drag-over' : ''}`}
      data-testid="video-panel"
      tabIndex={0}
      onKeyDown={onKeyDown}
      {...dropProps}
    >
      <input
        ref={inputRef}
        type="file"
        accept="video/*,.mp4,.mov,.m4v,.webm,.mkv"
        hidden
        data-testid="video-open-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) openFile(f);
          e.target.value = '';
        }}
      />

      <div className="video-top">
        <button className="vbtn" data-testid="video-open" onClick={() => inputRef.current?.click()} title="Open an onboard video (or drop it here)">
          🎬 Open video
        </button>
        {file && (
          <span className="video-name" title={file.name} data-testid="video-name">
            {file.name}
            {meta && (
              <span className="dim num">
                {' '}
                · {fmtTimecode(meta.duration)} · {fps ? `${fps} fps` : 'fps…'} · {meta.w}×{meta.h}
              </span>
            )}
          </span>
        )}
        {file && (
          <>
            <label className="vfield" title="Run the video is synced to">
              run
              <select
                data-testid="video-session"
                value={sync?.sessionId ?? ''}
                onChange={(e) => setOffset(sync?.offsetS ?? 0, e.target.value)}
              >
                {realSessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="vfield" title="What moves the video: chart/map hover, clicks only, or nothing (set Off while syncing)">
              follow
              <select data-testid="video-follow" value={follow} onChange={(e) => setVideoFollow(e.target.value as typeof follow)}>
                <option value="hover">hover</option>
                <option value="click">click</option>
                <option value="off">off</option>
              </select>
            </label>
          </>
        )}
      </div>

      {file && (
        <div className="video-sync-row">
          <button
            className="vbtn accent"
            data-testid="video-sync-here"
            onClick={syncHere}
            title="This video frame = the last clicked sample (or the cursor). Tip: set follow to off, find the frame, click the sample, press this."
          >
            ⇔ Sync here
          </button>
          <span className={`video-start-line ${startVideoS !== undefined ? 'set' : ''}`}>
            <button
              className="vbtn accent"
              data-testid="video-start-line"
              onClick={setStartLine}
              disabled={!meta}
              title="This video frame is the start line (S). Pick a lap first to say which lap starts here."
            >
              🏁 Start line
            </button>
            {startVideoS !== undefined && (
              <>
                <span className="video-start-line-tc num" data-testid="video-start-line-tc" title={`Start line at video ${fmtTimecode(startVideoS)} (frame ${frameIndexAt(startVideoS, effFps)})`}>
                  {fmtTimecode(startVideoS)}
                </span>
                <button className="vbtn small" data-testid="video-start-line-go" onClick={goToStartLine} title="Go to the start-line frame">
                  ⤓
                </button>
                <button className="vbtn small" data-testid="video-start-line-clear" onClick={clearStartLine} title="Clear the start line">
                  ✕
                </button>
              </>
            )}
          </span>
          <label className="vfield" title="video_time = session_time − offset (s)">
            offset
            <input
              className="num"
              data-testid="video-offset"
              type="number"
              step={0.01}
              value={offsetText}
              onChange={(e) => {
                setOffsetText(e.target.value);
                const n = Number(e.target.value);
                if (e.target.value.trim() !== '' && Number.isFinite(n)) setOffset(n);
              }}
            />
          </label>
          {(
            [
              ['−1s', -1, 'video-nudge-m1'],
              ['−0.1', -0.1, 'video-nudge-m01'],
              ['−1f', -1 / effFps, 'video-nudge-mf'],
              ['+1f', 1 / effFps, 'video-nudge-pf'],
              ['+0.1', 0.1, 'video-nudge-p01'],
              ['+1s', 1, 'video-nudge-p1'],
            ] as const
          ).map(([label, d, id]) => (
            <button key={id} className="vbtn small" data-testid={id} onClick={() => setOffset((sync?.offsetS ?? 0) + d)} title={`offset ${d > 0 ? '+' : ''}${d.toFixed(3)} s`}>
              {label}
            </button>
          ))}
          {session && session.laps.length > 0 && (
            <span className="vfield" title="Shortcut: this video frame is where the picked lap starts">
              <select data-testid="video-lap-pick" value={lapPick} onChange={(e) => setLapPick(e.target.value === '' ? '' : Number(e.target.value))}>
                <option value="">lap…</option>
                {session.laps.map((l) => (
                  <option key={l.n} value={l.n}>
                    L{l.n} {fmtLapTime(l.timeS)}
                  </option>
                ))}
              </select>
              <button className="vbtn small" data-testid="video-sync-lap" disabled={lapPick === ''} onClick={syncLapStart}>
                start = frame
              </button>
            </span>
          )}
        </div>
      )}

      <div className="video-stage" data-testid="video-stage">
        {!file && (
          <div className="video-empty" data-testid="video-empty">
            {reopen ? (
              <>
                <div>The saved session was synced to</div>
                <div className="video-reopen-name">{reopen}</div>
                <button className="vbtn accent" data-testid="video-reopen" onClick={() => inputRef.current?.click()}>
                  Re-open video {reopen}
                </button>
              </>
            ) : (
              <>
                <div>Drop an onboard video here (mp4 / mov / webm)</div>
                <button className="vbtn accent" onClick={() => inputRef.current?.click()}>
                  Open video…
                </button>
                <div className="dim">The video follows the chart cursor once synced; it is pre-processed for instant scrubbing.</div>
              </>
            )}
          </div>
        )}
        <video
          ref={videoRef}
          data-testid="video-element"
          src={url ?? undefined}
          muted={muted}
          playsInline
          preload="auto"
          onLoadedMetadata={onLoadedMeta}
          onSeeked={onSeeked}
          onPlay={onPlay}
          onPause={onPause}
          onTimeUpdate={onTimeUpdate}
          onClick={togglePlay}
          style={{ visibility: file ? 'visible' : 'hidden' }}
        />
        <canvas ref={canvasRef} data-testid="video-canvas" className="video-canvas" style={{ visibility: 'hidden' }} onClick={togglePlay} />
        {file && overlay && <VideoOverlay session={session} />}
        {file && <StartLineBadge startS={startVideoS} fps={effFps} />}
        {file && reopen && reopen !== file.name && (
          <button className="vbtn accent video-reopen-banner" data-testid="video-reopen" onClick={() => inputRef.current?.click()}>
            The restored session is synced to {reopen}: re-open it
          </button>
        )}
        {file && sync && !session &&<div className="video-warn">Pick the run this video belongs to</div>}
        {file && session && sync && workspaceLap === undefined && (
          <div className="video-hint dim">Tip: add a lap of {session.name} to the workspace so other runs' cursors map onto it.</div>
        )}
      </div>

      {file && (
        <div className="video-bottom">
          <div className="video-seek-wrap">
          <input
            className="video-seek"
            data-testid="video-seek"
            type="range"
            min={0}
            max={meta?.duration ?? 0}
            step={0.01}
            value={Math.min(curT, meta?.duration ?? 0)}
            onChange={(e) => {
              const t = Number(e.target.value);
              setCurT(t);
              showAt(t, { fromData: false, t0: performance.now() });
            }}
          />
          {startVideoS !== undefined && meta && meta.duration > 0 && (
            <button
              type="button"
              className="video-seek-flag"
              data-testid="video-seek-start-flag"
              style={{ ['--f' as string]: String(Math.max(0, Math.min(1, startVideoS / meta.duration))) }}
              onClick={goToStartLine}
              title={`Start line ${fmtTimecode(startVideoS)} — click to go there`}
            >
              🏁
            </button>
          )}
          </div>
          <div className="video-transport">
            <button className="vbtn" data-testid="video-play" onClick={togglePlay} title="Play / pause (Space)" disabled={!meta}>
              {playing ? '⏸' : '▶'}
            </button>
            <button className="vbtn small" data-testid="video-play-cursor" onClick={playFromCursor} title="Play from the chart cursor">
              ▶ cursor
            </button>
            <button className="vbtn small" data-testid="video-jump-m5" onClick={() => seekExact(currentVideoT() - 5)} title="−5 s (Shift+←)">
              −5s
            </button>
            <button className="vbtn small" data-testid="video-jump-m1" onClick={() => seekExact(currentVideoT() - 1)} title="−1 s (←)">
              −1s
            </button>
            <button
              className="vbtn small"
              data-testid="video-step-prev"
              onClick={() => seekExact(stepFrames(currentVideoT(), effFps, -1, meta?.duration))}
              title="Previous frame (,)"
            >
              ◂|
            </button>
            <button
              className="vbtn small"
              data-testid="video-step-next"
              onClick={() => seekExact(stepFrames(currentVideoT(), effFps, 1, meta?.duration))}
              title="Next frame (.)"
            >
              |▸
            </button>
            <button className="vbtn small" data-testid="video-jump-p1" onClick={() => seekExact(currentVideoT() + 1)} title="+1 s (→)">
              +1s
            </button>
            <button className="vbtn small" data-testid="video-jump-p5" onClick={() => seekExact(currentVideoT() + 5)} title="+5 s (Shift+→)">
              +5s
            </button>
            <span className="video-tc num">{fmtTimecode(curT)}</span>
            <label className="vfield" title="Playback speed">
              <select data-testid="video-speed" value={SPEEDS.includes(rate) ? String(rate) : ''} onChange={(e) => e.target.value && setRate(Number(e.target.value))}>
                {!SPEEDS.includes(rate) && <option value="">{rate.toFixed(2)}×</option>}
                {SPEEDS.map((s) => (
                  <option key={s} value={s}>
                    {s}×
                  </option>
                ))}
              </select>
              <input
                className="video-speed-fine"
                data-testid="video-speed-fine"
                type="range"
                min={0.1}
                max={4}
                step={0.05}
                value={rate}
                onChange={(e) => setRate(Number(e.target.value))}
              />
            </label>
            <label className="vfield" title="Loop the current lap or the zoomed chart range">
              loop
              <select data-testid="video-loop" value={loop} onChange={(e) => setLoop(e.target.value as typeof loop)}>
                <option value="off">off</option>
                <option value="lap">lap</option>
                <option value="range">x-range</option>
              </select>
            </label>
            <span className="video-spacer" />
            <button className={`vbtn small ${overlay ? 'active' : ''}`} data-testid="video-overlay-toggle" onClick={() => setOverlay((o) => !o)} title="Data overlay">
              HUD
            </button>
            <button className={`vbtn small ${muted ? '' : 'active'}`} data-testid="video-mute" onClick={() => setMuted((m) => !m)} title="Sound">
              {muted ? '🔇' : '🔊'}
            </button>
            <button className="vbtn small" data-testid="video-copy-frame" onClick={copyFrame} title="Copy this frame (with the HUD) to the clipboard">
              Copy
            </button>
            <button className="vbtn small" data-testid="video-save-frame" onClick={saveFrame} title="Save this frame as PNG (with the HUD)">
              PNG
            </button>
            <button className="vbtn small" data-testid="video-fullscreen" onClick={onFullscreen} title="Fullscreen">
              ⛶
            </button>
          </div>
          <div className="video-cache-row">
            <select data-testid="video-cache-scope" value={cacheScope} onChange={(e) => setCacheScope(e.target.value as typeof cacheScope)} title="What to pre-process">
              <option value="laps">workspace laps</option>
              <option value="all">whole video</option>
            </select>
            <button className="vbtn small" data-testid="video-cache-run" onClick={() => void runCache()} disabled={!meta} title="Pre-extract frames for instant scrubbing">
              {building ? 'Stop' : progress?.phase === 'done' ? 'Re-process' : 'Pre-process'}
            </button>
            <div
              className="video-cache-progress"
              data-testid="video-cache-progress"
              data-done={progress?.done ?? 0}
              data-total={progress?.total ?? 0}
              data-phase={progress?.phase ?? 'idle'}
              title={progress ? `${progress.done}/${progress.total} frames (${progress.phase})` : 'not pre-processed'}
            >
              <div className="bar" style={{ width: `${pct}%` }} />
              <span className="num">
                {progress ? (progress.phase === 'done' ? `${progress.done} frames ready` : `${pct}% · ${progress.phase}`) : 'no frame cache'}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
