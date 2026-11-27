import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  Copy,
  FlipHorizontal2,
  Maximize2,
  RotateCcw,
  RotateCw,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { flushActiveCanvasNow, registerCanvasFlusher, useStudioStore } from '../../store/useStudioStore';
import { StudioCanvasEngine } from '../../engine/canvasEngine';
import { renderFrameComposite } from '../../engine/frameComposite';
import { StudioAudioPlayer } from '../../engine/audioEngine';
import { soundEngine } from '../../engine/soundEngine';
import { KeycapButton } from '../ui/KeycapButton';
import { BrassRotaryDial } from '../ui/Studio3DControls';
import { localizeLayerName, useT } from '../../i18n/translations';
import { safeSetPointerCapture } from '../../utils/pointerCapture';

interface DrawingStageProps {
  onHistoryState: (canUndo: boolean, canRedo: boolean) => void;
  engineRef: React.MutableRefObject<StudioCanvasEngine | null>;
}

/** Max frames held in RAM during streaming ring-buffer playback (constant < 45MB even at 300 frames!) */
const RING_BUFFER_SIZE = 6;

export default function DrawingStage({ onHistoryState, engineRef }: DrawingStageProps) {
  const {
    projects,
    activeProjectId,
    activeFrameIndex,
    activeLayerId,
    brush,
    onion,
    guides,
    lightboxDim,
    theme,
    rightRailTab,
    isPlaying,
    loopPlayback,
    loopRange,
    setPlaying,
    setPlaybackFrameIndex,
    selectFrame,
    updateBrush,
    updateOnion,
    updateGuides,
    updateProjectSettings,
    addFrameAfterCurrent,
    updateLayerBlobAndThumb,
    notify,
  } = useStudioStore();
  const t = useT();

  const project = projects.find((p) => p.id === activeProjectId);
  const frame = project?.frames[activeFrameIndex];
  const activeLayerMeta = frame?.layers.find((l) => l.id === activeLayerId) ?? null;
  const activeLayerBlocked = !activeLayerMeta || activeLayerMeta.locked || !activeLayerMeta.visible;

  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playbackCanvasRef = useRef<HTMLCanvasElement>(null);
  const brushRingRef = useRef<HTMLDivElement>(null);
  const audioPlayerRef = useRef<StudioAudioPlayer | null>(null);

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [rotationDeg, setRotationDeg] = useState(0);
  const [mirrored, setMirrored] = useState(false);
  const [spacePanning, setSpacePanning] = useState(false);
  const [hasFloating, setHasFloating] = useState(false);
  const [pickedColorBadge, setPickedColorBadge] = useState<string | null>(null);
  const [hasSessionStroke, setHasSessionStroke] = useState(false);

  const spaceUsedPanRef = useRef(false);
  const loadedFrameIdxRef = useRef<number>(-1);
  const lastBlockedToastRef = useRef<number>(0);

  // Tactile 115ms paper flip direction animation
  const prevFrameIdxRef = useRef(activeFrameIndex);
  const [flipClass, setFlipClass] = useState('');

  // Multi-touch gesture tracking (2-finger Pinch/Pan/Rotate + 2-finger tap Undo / 3-finger Redo)
  const activeTouchesRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchStartRef = useRef<{
    dist: number;
    angle: number;
    cx: number;
    cy: number;
    zoom: number;
    panX: number;
    panY: number;
    rot: number;
    moved: boolean;
    startTime: number;
    maxCount: number;
  } | null>(null);

  const [isInteractingView, setIsInteractingView] = useState(false);
  const zoomPanRef = useRef({ zoom: 1, pan: { x: 0, y: 0 } });
  zoomPanRef.current = { zoom, pan };

  const pendingTouchBucketRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    startClientX: number;
    startClientY: number;
    cancelled: boolean;
  } | null>(null);

  const panDragRef = useRef<{ active: boolean; startX: number; startY: number; ox: number; oy: number }>({
    active: false,
    startX: 0,
    startY: 0,
    ox: 0,
    oy: 0,
  });

  const persistQueueRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPersistRef = useRef<{
    projectId: string;
    sceneId?: string;
    frameId: string;
    layerId: string;
  } | null>(null);
  const inFlightPersistRef = useRef<Promise<void> | null>(null);

  const flushPersistNow = useCallback(
    (explicit?: {
      projectId?: string;
      sceneId?: string;
      frameId: string;
      layerId: string;
    }): Promise<void> => {
      if (persistQueueRef.current) {
        clearTimeout(persistQueueRef.current);
        persistQueueRef.current = null;
      }
      const target = explicit ?? pendingPersistRef.current;
      pendingPersistRef.current = null;
      if (!target) {
        return inFlightPersistRef.current ?? Promise.resolve();
      }

      const eng = engineRef.current;
      const state = useStudioStore.getState();
      const targetProjId = target.projectId ?? state.activeProjectId;
      const curProj = state.projects.find((p) => p.id === targetProjId);
      const targetSceneId = target.sceneId ?? curProj?.activeSceneId;
      const curScene = curProj?.scenes?.find((s) => s.id === targetSceneId);
      const framesPool = curScene?.frames ?? curProj?.frames ?? [];
      const curFrame = framesPool.find((f) => f.id === target.frameId);
      const curLayer = curFrame?.layers.find((l) => l.id === target.layerId);
      if (!eng || !curProj || !curFrame || !curLayer || eng.getLoadedFrameId() !== curFrame.id) {
        return inFlightPersistRef.current ?? Promise.resolve();
      }

      // Synchronously snapshot layer + composite thumbnail BEFORE any await so frame/scene/project transitions NEVER race!
      const snap = eng.snapshotLayerAndThumbSync(curLayer.id);
      if (!snap) {
        return inFlightPersistRef.current ?? Promise.resolve();
      }

      const prevPromise = inFlightPersistRef.current ?? Promise.resolve();
      const capturedProjId = curProj.id;
      const capturedSceneId = targetSceneId;
      const capturedFrameId = curFrame.id;
      const capturedLayerId = curLayer.id;
      const existingLayerBlobKey = curLayer.blobKey;
      const existingThumbKey = curFrame.thumbKey;

      const p = prevPromise
        .then(() => eng.persistSnapshot(snap, existingLayerBlobKey, existingThumbKey))
        .then((res) => {
          updateLayerBlobAndThumb(
            capturedFrameId,
            capturedLayerId,
            res.layerBlobKey,
            res.thumbKey,
            capturedProjId,
            capturedSceneId
          );
        })
        .finally(() => {
          if (inFlightPersistRef.current === p) inFlightPersistRef.current = null;
        });
      inFlightPersistRef.current = p;
      return p;
    },
    [engineRef, updateLayerBlobAndThumb]
  );

  const flushPersistLayer = useCallback(
    (layerId: string, targetFrameId?: string) => {
      const state = useStudioStore.getState();
      const curProj = state.projects.find((p) => p.id === state.activeProjectId);
      const fid = targetFrameId ?? curProj?.frames[state.activeFrameIndex]?.id;
      if (!curProj || !fid) return;
      pendingPersistRef.current = {
        projectId: curProj.id,
        sceneId: curProj.activeSceneId,
        frameId: fid,
        layerId,
      };
      if (persistQueueRef.current) clearTimeout(persistQueueRef.current);
      persistQueueRef.current = setTimeout(() => {
        persistQueueRef.current = null;
        void flushPersistNow();
      }, 110);
    },
    [flushPersistNow]
  );

  // Register synchronous flusher so frame switches, duplicate, play, scenes, and export NEVER lose the latest stroke!
  useEffect(() => {
    registerCanvasFlusher(() => flushPersistNow());
    return () => {
      void flushPersistNow();
      registerCanvasFlusher(null);
    };
  }, [flushPersistNow]);

  // Trigger 115ms paper flip micro-animation on manual frame changes + 85ms Audio Scrub!
  useEffect(() => {
    const prev = prevFrameIdxRef.current;
    prevFrameIdxRef.current = activeFrameIndex;
    if (isPlaying || prev === activeFrameIndex) return;

    setFlipClass(activeFrameIndex > prev ? 'sheet-flip-next' : 'sheet-flip-prev');
    const timer = setTimeout(() => setFlipClass(''), 130);

    // 85ms real Audio Scrubbing when flipping through frames!
    if (project?.audio && !project.audio.muted) {
      let frameStartSlot = 0;
      for (let i = 0; i < activeFrameIndex; i++) {
        frameStartSlot += Math.max(1, project.frames[i]?.hold ?? 1);
      }
      const sec = frameStartSlot / project.fps;
      if (!audioPlayerRef.current) audioPlayerRef.current = new StudioAudioPlayer();
      void audioPlayerRef.current.ensureLoaded(project.audio).then(() => {
        audioPlayerRef.current?.playScrubSlice(
          sec,
          project.audio!.volume,
          project.audio!.muted,
          0.085,
          project.audio!.voiceEffect ?? 'natural'
        );
      });
    }

    return () => clearTimeout(timer);
  }, [activeFrameIndex, isPlaying, project]);

  // Initialize CanvasEngine
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !project) return;
    setHasSessionStroke(false);
    loadedFrameIdxRef.current = -1;

    const eng = new StudioCanvasEngine(
      canvas,
      project.width,
      project.height,
      project.paperColor,
      brush,
      onion,
      guides
    );
    eng.onHistoryChange = (u, r) => onHistoryState(u, r);
    eng.onFloatingChange = (has) => setHasFloating(has);
    eng.onStrokeCommit = (layerId, committedFrameId) => {
      setHasSessionStroke(true);
      const st = useStudioStore.getState();
      const cp = st.projects.find((p) => p.id === st.activeProjectId);
      const cf = cp?.frames.find((f) => f.id === committedFrameId);
      if (cf && !cf.thumbKey) {
        void flushPersistNow({ frameId: committedFrameId, layerId });
      } else {
        flushPersistLayer(layerId, committedFrameId);
      }
    };
    eng.onColorPicked = (hex) => {
      soundEngine.click(1.3);
      updateBrush({ color: hex });
      setPickedColorBadge(hex);
      setTimeout(() => setPickedColorBadge((cur) => (cur === hex ? null : cur)), 1400);
      notify(`${t('stageColorPicked')}: ${hex}`, 'info');
    };
    eng.onBlockedDraw = (reason, layerName) => {
      const now = performance.now();
      if (now - lastBlockedToastRef.current < 1400) return;
      lastBlockedToastRef.current = now;
      soundEngine.click(0.65);
      const dispLayer = layerName ? localizeLayerName(layerName, useStudioStore.getState().locale) : '';
      if (reason === 'locked') {
        notify(`"${dispLayer}" ${t('stageLayerLocked')}`, 'error');
      } else if (reason === 'hidden') {
        notify(`"${dispLayer}" ${t('stageLayerHidden')}`, 'error');
      } else {
        notify(t('stageNoLayer'), 'error');
      }
    };

    engineRef.current = eng;
    return () => {
      void flushPersistNow();
      eng.dispose();
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, project?.width, project?.height]);

  useEffect(() => {
    if (!engineRef.current || !project) return;
    engineRef.current.setSettings(
      brush,
      onion,
      guides,
      project.paperColor,
      lightboxDim,
      project.paperStyle ?? 'bristol',
      project.atmosphere ?? 'none',
      activeFrameIndex,
      project.cameraKeyframes ?? [],
      project.frames,
      rightRailTab === 'camera'
    );
  }, [brush, onion, guides, project, lightboxDim, activeFrameIndex, rightRailTab, engineRef]);

  useEffect(() => {
    if (!engineRef.current || !project) return;
    void engineRef.current.setBackgroundBlobKey(project.backgroundBlobKey);
  }, [project?.backgroundBlobKey, project, engineRef]);

  useEffect(() => {
    engineRef.current?.setActiveLayerId(activeLayerId);
  }, [activeLayerId, engineRef]);

  useEffect(() => {
    if (frame) engineRef.current?.updateFrameMetadata(frame);
  }, [frame, engineRef]);

  const frameId = frame?.id;
  useEffect(() => {
    // NEVER reload the editing canvas during playback, and await in-flight canvas flushes before loading target frame blobs!
    if (isPlaying || !engineRef.current || !project || !frame) return;
    if (
      engineRef.current.getLoadedFrameId() === frame.id &&
      loadedFrameIdxRef.current === activeFrameIndex
    ) {
      return;
    }
    let cancelled = false;
    const targetFrameIdx = activeFrameIndex;
    const targetFrameId = frame.id;

    void (async () => {
      await flushActiveCanvasNow();
      if (cancelled || !engineRef.current) return;
      const latestState = useStudioStore.getState();
      const latestProj = latestState.projects.find((p) => p.id === latestState.activeProjectId);
      const latestFrame = latestProj?.frames[targetFrameIdx];
      if (!latestProj || !latestFrame || latestFrame.id !== targetFrameId) return;

      loadedFrameIdxRef.current = targetFrameIdx;
      const prevFrames = [];
      for (let i = 1; i <= 3; i++) {
        if (targetFrameIdx - i >= 0) prevFrames.push(latestProj.frames[targetFrameIdx - i]);
      }
      const nextFrames = [];
      for (let i = 1; i <= 3; i++) {
        if (targetFrameIdx + i < latestProj.frames.length) {
          nextFrames.push(latestProj.frames[targetFrameIdx + i]);
        }
      }
      await engineRef.current.loadFrame(
        latestFrame,
        latestState.activeLayerId,
        prevFrames,
        nextFrames,
        targetFrameIdx
      );
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameId, project?.id, project?.activeSceneId, activeFrameIndex, isPlaying]);

  /**
   * 10/10 Constant-Memory Streaming Ring-Buffer Playback Loop!
   * Renders Fixed Background + Parallax + 2D Cinematic Camera + Impact Shake + Atmosphere live
   * and respects In/Out Loop Range while keeping RAM < 45MB even at 300 frames.
   */
  useEffect(() => {
    if (!isPlaying || !project || project.frames.length === 0) {
      audioPlayerRef.current?.stop();
      return;
    }

    const canvas = playbackCanvasRef.current;
    if (!canvas) return;
    canvas.width = project.width;
    canvas.height = project.height;
    const ctx = canvas.getContext('2d', { alpha: false })!;

    const rangeStart = loopRange ? Math.max(0, Math.min(project.frames.length - 1, loopRange.start)) : 0;
    const rangeEnd = loopRange
      ? Math.max(rangeStart, Math.min(project.frames.length - 1, loopRange.end))
      : project.frames.length - 1;

    const timelineSlots: number[] = [];
    for (let idx = rangeStart; idx <= rangeEnd; idx++) {
      const hold = Math.max(1, project.frames[idx]?.hold ?? 1);
      for (let h = 0; h < hold; h++) timelineSlots.push(idx);
    }

    if (!audioPlayerRef.current) {
      audioPlayerRef.current = new StudioAudioPlayer();
    }

    let cancelled = false;
    let raf = 0;
    const ringCache = new Map<number, HTMLCanvasElement>();
    const inflight = new Set<number>();

    const renderSingleFrame = async (fIdx: number): Promise<HTMLCanvasElement | null> => {
      if (ringCache.has(fIdx)) return ringCache.get(fIdx)!;
      if (inflight.has(fIdx)) return null;
      inflight.add(fIdx);
      try {
        const f = project.frames[fIdx];
        if (!f) return null;
        const c = await renderFrameComposite(project, f, {
          width: project.width,
          height: project.height,
          frameIndexInScene: fIdx,
        });
        if (cancelled) return null;
        ringCache.set(fIdx, c);
        while (ringCache.size > RING_BUFFER_SIZE) {
          const oldest = ringCache.keys().next().value;
          if (oldest === undefined) break;
          ringCache.delete(oldest);
        }
        return c;
      } finally {
        inflight.delete(fIdx);
      }
    };

    const prefetchAhead = (startSlot: number) => {
      const total = timelineSlots.length;
      for (let offset = 0; offset < RING_BUFFER_SIZE; offset++) {
        const slot = (startSlot + offset) % total;
        const fIdx = timelineSlots[slot];
        if (!ringCache.has(fIdx)) {
          void renderSingleFrame(fIdx);
        }
      }
    };

    const run = async () => {
      // Ensure the latest edited stroke is persisted before rendering the playback ring buffer!
      await flushPersistNow();
      if (cancelled) return;
      // Warm up the first frame before starting clock
      const firstFrame = await renderSingleFrame(timelineSlots[0]);
      if (cancelled) return;
      if (firstFrame) ctx.drawImage(firstFrame, 0, 0);
      setPlaybackFrameIndex(timelineSlots[0]);
      prefetchAhead(1);

      let rangeStartExposureSlot = 0;
      for (let idx = 0; idx < rangeStart; idx++) {
        rangeStartExposureSlot += Math.max(1, project.frames[idx]?.hold ?? 1);
      }
      const rangeStartOffsetSec = rangeStartExposureSlot / project.fps;

      if (project.audio && !project.audio.muted) {
        await audioPlayerRef.current!.ensureLoaded(project.audio);
        if (!cancelled) {
          const liveAudio =
            useStudioStore.getState().projects.find((p) => p.id === project.id)?.audio ??
            project.audio;
          audioPlayerRef.current!.startAt(
            rangeStartOffsetSec,
            liveAudio.volume,
            liveAudio.muted,
            liveAudio.voiceEffect ?? 'natural'
          );
        }
      }

      const startTime = performance.now();
      let lastSlot = -1;
      let slotRenderSeq = 0;

      const drawSlotSafely = (fIdx: number) => {
        const seq = ++slotRenderSeq;
        const cached = ringCache.get(fIdx);
        if (cached) {
          ctx.drawImage(cached, 0, 0);
        } else {
          void renderSingleFrame(fIdx).then((c) => {
            if (c && !cancelled && seq === slotRenderSeq) {
              ctx.drawImage(c, 0, 0);
            }
          });
        }
      };

      const tick = () => {
        if (cancelled) return;
        const elapsedSec = (performance.now() - startTime) / 1000;
        const rawSlot = Math.floor(elapsedSec * project.fps);

        if (rawSlot >= timelineSlots.length) {
          if (loopPlayback) {
            const loopSlot = rawSlot % timelineSlots.length;
            if (loopSlot < lastSlot) {
              const liveAudio = useStudioStore
                .getState()
                .projects.find((p) => p.id === project.id)?.audio;
              if (liveAudio && !liveAudio.muted) {
                audioPlayerRef.current?.startAt(
                  rangeStartOffsetSec,
                  liveAudio.volume,
                  liveAudio.muted,
                  liveAudio.voiceEffect ?? 'natural'
                );
              }
            }
            if (loopSlot !== lastSlot) {
              lastSlot = loopSlot;
              const fIdx = timelineSlots[loopSlot];
              drawSlotSafely(fIdx);
              prefetchAhead(loopSlot + 1);
              setPlaybackFrameIndex(fIdx);
            }
          } else {
            setPlaying(false);
            return;
          }
        } else if (rawSlot !== lastSlot) {
          lastSlot = rawSlot;
          const fIdx = timelineSlots[rawSlot];
          drawSlotSafely(fIdx);
          prefetchAhead(rawSlot + 1);
          setPlaybackFrameIndex(fIdx);
        }

        raf = requestAnimationFrame(tick);
      };

      raf = requestAnimationFrame(tick);
    };

    void run();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      ringCache.clear();
      audioPlayerRef.current?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, loopPlayback, loopRange, project?.id, project?.activeSceneId, project?.fps]);

  useEffect(() => {
    if (!isPlaying || !project?.audio) return;
    audioPlayerRef.current?.setLiveVolumeAndMute(project.audio.volume, project.audio.muted);
  }, [isPlaying, project?.audio?.volume, project?.audio?.muted, project?.audio]);

  useEffect(() => {
    return () => {
      audioPlayerRef.current?.dispose();
    };
  }, []);

  // Non-passive native Wheel listener: cursor-anchored Ctrl/Cmd+Wheel zoom ('0' passive listener console errors!) + smooth 2-finger trackpad pan
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    let wheelIdleTimer: ReturnType<typeof setTimeout> | null = null;

    const onNativeWheel = (e: WheelEvent) => {
      if (useStudioStore.getState().isPlaying) return;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        setIsInteractingView(true);
        const rect = el.getBoundingClientRect();
        const mx = e.clientX - (rect.left + rect.width / 2);
        const my = e.clientY - (rect.top + rect.height / 2);
        const cur = zoomPanRef.current;
        const factor = e.deltaY < 0 ? 1.1 : 0.9;
        const nextZoom = Math.max(0.25, Math.min(6, Number((cur.zoom * factor).toFixed(3))));
        const ratio = nextZoom / Math.max(0.05, cur.zoom);
        const nextPan = {
          x: Math.round(mx - (mx - cur.pan.x) * ratio),
          y: Math.round(my - (my - cur.pan.y) * ratio),
        };
        zoomPanRef.current = { zoom: nextZoom, pan: nextPan };
        setZoom(nextZoom);
        setPan(nextPan);
      } else if (Math.abs(e.deltaX) > 0.5 || Math.abs(e.deltaY) > 0.5) {
        e.preventDefault();
        setIsInteractingView(true);
        const cur = zoomPanRef.current;
        const nextPan = {
          x: Math.round(cur.pan.x - e.deltaX),
          y: Math.round(cur.pan.y - e.deltaY),
        };
        zoomPanRef.current = { zoom: cur.zoom, pan: nextPan };
        setPan(nextPan);
      }
      if (wheelIdleTimer) clearTimeout(wheelIdleTimer);
      wheelIdleTimer = setTimeout(() => setIsInteractingView(false), 120);
    };

    el.addEventListener('wheel', onNativeWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onNativeWheel);
      if (wheelIdleTimer) clearTimeout(wheelIdleTimer);
    };
  }, [project?.id, Boolean(frame)]);

  // Animator Keyboard Shortcuts + Cross-Frame Ctrl+C / Ctrl+V + Smart Space Pan/Play + Ctrl+S Flush
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable
      ) {
        return;
      }

      if (e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        spaceUsedPanRef.current = false;
        setSpacePanning(true);
        return;
      }

      const key = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && key === 's') {
        e.preventDefault();
        void flushPersistNow().then(() => {
          soundEngine.click(1.1);
          notify(t('stageSavedToast'), 'ok');
        });
        return;
      }
      if ((e.ctrlKey || e.metaKey) && key === 'z') {
        e.preventDefault();
        const lid = e.shiftKey ? engineRef.current?.redo() : engineRef.current?.undo();
        if (lid) flushPersistLayer(lid);
        soundEngine.click(0.85);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && key === 'y') {
        e.preventDefault();
        const lid = engineRef.current?.redo();
        if (lid) flushPersistLayer(lid);
        soundEngine.click(1.05);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && key === 'c') {
        if (engineRef.current?.copyFloatingToClipboard()) {
          e.preventDefault();
          soundEngine.click(1.15);
          notify(t('stageSelectionCopied'), 'info');
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && key === 'v') {
        if (engineRef.current?.pasteClipboardAsFloating()) {
          e.preventDefault();
          soundEngine.paperFlip();
          notify(t('stageSelectionPasted'), 'info');
        }
        return;
      }

      // Never trigger single-letter tool shortcuts while Ctrl / Cmd / Alt modifier is held!
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (key === ',' || key === 'arrowleft') {
        e.preventDefault();
        const cur = useStudioStore.getState().activeFrameIndex;
        if (cur > 0) {
          soundEngine.paperFlip();
          selectFrame(cur - 1);
        }
      } else if (key === '.' || key === 'arrowright') {
        e.preventDefault();
        const st = useStudioStore.getState();
        const p = st.projects.find((x) => x.id === st.activeProjectId);
        if (p && st.activeFrameIndex < p.frames.length - 1) {
          soundEngine.paperFlip();
          selectFrame(st.activeFrameIndex + 1);
        }
      } else if (key === '[') {
        e.preventDefault();
        const sz = useStudioStore.getState().brush.size;
        updateBrush({ size: Math.max(1, sz - 2) });
      } else if (key === ']') {
        e.preventDefault();
        const sz = useStudioStore.getState().brush.size;
        updateBrush({ size: Math.min(48, sz + 2) });
      } else if (key === 'enter') {
        if (hasFloating) {
          engineRef.current?.commitFloatingSelection();
        } else {
          setPlaying(!useStudioStore.getState().isPlaying);
        }
      } else if (key === 'o') {
        const cur = useStudioStore.getState().onion.enabled;
        soundEngine.toggle(!cur);
        updateOnion({ enabled: !cur });
      } else if (key === 'h') {
        soundEngine.click(1.1);
        setMirrored((m) => !m);
      } else if (key === 'b') {
        updateBrush({ tool: 'gpen' });
      } else if (key === 'p') {
        updateBrush({ tool: 'pencil' });
      } else if (key === 'm') {
        updateBrush({ tool: 'blue-rough' });
      } else if (key === 'k') {
        updateBrush({ tool: 'marker' });
      } else if (key === 'd') {
        updateBrush({ tool: 'dry-brush' });
      } else if (key === 't') {
        updateBrush({ tool: 'screentone' });
      } else if (key === 's') {
        updateBrush({ tool: 'shape' });
      } else if (key === 'g') {
        updateBrush({ tool: 'bucket' });
      } else if (key === 'l') {
        updateBrush({ tool: 'lasso' });
      } else if (key === 'i') {
        updateBrush({ tool: 'eyedropper' });
      } else if (key === 'e') {
        updateBrush({ tool: 'eraser' });
      } else if (key === 'n') {
        soundEngine.paperFlip();
        void addFrameAfterCurrent(false);
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        setSpacePanning(false);
        if (!spaceUsedPanRef.current) {
          setPlaying(!useStudioStore.getState().isPlaying);
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [
    engineRef,
    flushPersistLayer,
    flushPersistNow,
    selectFrame,
    setPlaying,
    updateOnion,
    updateBrush,
    addFrameAfterCurrent,
    hasFloating,
    notify,
    t,
  ]);

  if (!project || !frame) return null;

  const clientToCanvas = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = clientX - cx;
    const dy = clientY - cy;
    const rad = (-rotationDeg * Math.PI) / 180;
    const rx = dx * Math.cos(rad) - dy * Math.sin(rad);
    const ry = dx * Math.sin(rad) + dy * Math.cos(rad);
    const baseW = canvas.offsetWidth * zoom;
    const baseH = canvas.offsetHeight * zoom;
    const normX = rx / baseW + 0.5;
    const normY = ry / baseH + 0.5;
    const finalX = mirrored ? 1 - normX : normX;
    return {
      x: finalX * project.width,
      y: normY * project.height,
    };
  };

  /** Imperatively positions live 120 FPS Brush Size Ring with zero React re-renders */
  const isCrosshairTool =
    brush.tool === 'bucket' ||
    brush.tool === 'eyedropper' ||
    brush.tool === 'lasso' ||
    brush.tool === 'shape';

  const updateLiveBrushCursor = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const ring = brushRingRef.current;
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (
      !ring ||
      !stage ||
      !canvas ||
      e.pointerType === 'touch' ||
      isPlaying ||
      spacePanning ||
      activeLayerBlocked ||
      isCrosshairTool
    ) {
      if (ring) ring.style.opacity = '0';
      return;
    }
    const stageRect = stage.getBoundingClientRect();
    const displayScale = (canvas.offsetWidth * zoom) / project.width;
    const effectivePx =
      brush.tool === 'eraser'
        ? brush.size * 2.1
        : brush.tool === 'marker' || brush.tool === 'screentone'
          ? brush.size * 1.9
          : brush.tool === 'dry-brush'
            ? brush.size * 1.65
            : brush.size;
    const diameter = Math.max(6, Math.min(180, effectivePx * displayScale));

    const x = e.clientX - stageRect.left;
    const y = e.clientY - stageRect.top;
    ring.style.opacity = '1';
    ring.style.width = `${diameter}px`;
    ring.style.height = `${diameter}px`;
    ring.style.transform = `translate3d(${x - diameter / 2}px, ${y - diameter / 2}px, 0)`;
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (isPlaying) return;

    // Multi-touch Pinch/Pan/Rotate + 2-Finger Undo / 3-Finger Redo
    if (e.pointerType === 'touch') {
      activeTouchesRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const count = activeTouchesRef.current.size;
      if (count >= 2) {
        // Cancel any accidental single-finger stroke or deferred touch bucket immediately when 2nd finger lands!
        engineRef.current?.cancelActiveStroke();
        if (pendingTouchBucketRef.current) {
          pendingTouchBucketRef.current.cancelled = true;
          pendingTouchBucketRef.current = null;
        }
        setIsInteractingView(true);
        const pts = [...activeTouchesRef.current.values()];
        const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        const angle = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x);
        const cx = (pts[0].x + pts[1].x) / 2;
        const cy = (pts[0].y + pts[1].y) / 2;
        pinchStartRef.current = {
          dist: Math.max(10, dist),
          angle,
          cx,
          cy,
          zoom,
          panX: pan.x,
          panY: pan.y,
          rot: rotationDeg,
          moved: false,
          startTime: performance.now(),
          maxCount: Math.max(count, pinchStartRef.current?.maxCount ?? 2),
        };
        return;
      }
    }

    if (spacePanning || e.button === 1) {
      if (spacePanning) spaceUsedPanRef.current = true;
      safeSetPointerCapture(e.currentTarget, e.pointerId);
      setIsInteractingView(true);
      panDragRef.current = {
        active: true,
        startX: e.clientX,
        startY: e.clientY,
        ox: pan.x,
        oy: pan.y,
      };
      return;
    }

    if (e.button !== 0 && e.pointerType === 'mouse') return;
    safeSetPointerCapture(e.currentTarget, e.pointerId);
    const pos = clientToCanvas(e.clientX, e.clientY);

    // Pinch-Safe Touch Bucket: defer single-finger touch flood fill to pointerup so 2-finger pinch never floods canvas!
    if (e.pointerType === 'touch' && brush.tool === 'bucket' && !e.altKey) {
      pendingTouchBucketRef.current = {
        pointerId: e.pointerId,
        x: pos.x,
        y: pos.y,
        startClientX: e.clientX,
        startClientY: e.clientY,
        cancelled: false,
      };
      return;
    }

    if (!activeLayerBlocked) {
      setHasSessionStroke(true);
    }
    void engineRef.current?.handlePointerDown(
      pos.x,
      pos.y,
      e.pressure,
      e.pointerId,
      e.pointerType,
      { altKey: e.altKey, shiftKey: e.shiftKey }
    );
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    updateLiveBrushCursor(e);

    if (e.pointerType === 'touch' && activeTouchesRef.current.has(e.pointerId)) {
      activeTouchesRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (
        pendingTouchBucketRef.current &&
        pendingTouchBucketRef.current.pointerId === e.pointerId &&
        Math.hypot(
          e.clientX - pendingTouchBucketRef.current.startClientX,
          e.clientY - pendingTouchBucketRef.current.startClientY
        ) > 10
      ) {
        pendingTouchBucketRef.current.cancelled = true;
        pendingTouchBucketRef.current = null;
      }
      if (activeTouchesRef.current.size >= 2 && pinchStartRef.current) {
        const pts = [...activeTouchesRef.current.values()];
        const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        const angle = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x);
        const cx = (pts[0].x + pts[1].x) / 2;
        const cy = (pts[0].y + pts[1].y) / 2;
        const ps = pinchStartRef.current;
        if (Math.abs(dist - ps.dist) > 10 || Math.hypot(cx - ps.cx, cy - ps.cy) > 10) {
          ps.moved = true;
        }
        const nextZoom = Math.max(0.25, Math.min(6, ps.zoom * (dist / ps.dist)));
        const deltaDeg = ((angle - ps.angle) * 180) / Math.PI;
        setZoom(Number(nextZoom.toFixed(2)));
        setPan({ x: ps.panX + (cx - ps.cx), y: ps.panY + (cy - ps.cy) });
        if (Math.abs(deltaDeg) > 6) setRotationDeg(Math.round(ps.rot + deltaDeg));
        return;
      }
    }

    if (panDragRef.current.active) {
      setPan({
        x: panDragRef.current.ox + (e.clientX - panDragRef.current.startX),
        y: panDragRef.current.oy + (e.clientY - panDragRef.current.startY),
      });
      return;
    }
    if (isPlaying) return;

    // W3C Pointer Events Level 3 'getCoalescedEvents()' for 120Hz/240Hz Apple Pencil & Wacom precision!
    const rawEv = e.nativeEvent;
    const coalesced =
      typeof rawEv.getCoalescedEvents === 'function' ? rawEv.getCoalescedEvents() : [];
    const samples = coalesced.length > 0 ? coalesced : [rawEv];
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const pos = clientToCanvas(s.clientX, s.clientY);
      engineRef.current?.handlePointerMove(pos.x, pos.y, s.pressure, e.pointerId);
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === 'touch') {
      activeTouchesRef.current.delete(e.pointerId);
      const pendingBucket = pendingTouchBucketRef.current;
      if (pendingBucket && pendingBucket.pointerId === e.pointerId) {
        pendingTouchBucketRef.current = null;
        if (!pendingBucket.cancelled && !pinchStartRef.current) {
          if (!activeLayerBlocked) setHasSessionStroke(true);
          void engineRef.current?.handlePointerDown(
            pendingBucket.x,
            pendingBucket.y,
            0.5,
            e.pointerId,
            'touch'
          );
        }
        return;
      }
      if (activeTouchesRef.current.size === 0 && pinchStartRef.current) {
        const ps = pinchStartRef.current;
        pinchStartRef.current = null;
        setIsInteractingView(false);
        // Quick 2-finger tap -> Undo; quick 3-finger tap -> Redo!
        if (!ps.moved && performance.now() - ps.startTime < 280) {
          if (ps.maxCount >= 3) {
            const lid = engineRef.current?.redo();
            if (lid) flushPersistLayer(lid);
            soundEngine.click(1.1);
            notify(t('redoThreeFinger'), 'info');
          } else {
            const lid = engineRef.current?.undo();
            if (lid) flushPersistLayer(lid);
            soundEngine.click(0.85);
            notify(t('undoTwoFinger'), 'info');
          }
        }
        return;
      }
    }

    if (panDragRef.current.active) {
      panDragRef.current.active = false;
      setIsInteractingView(false);
      return;
    }
    engineRef.current?.handlePointerUp(e.pointerId);
  };

  const resetDeskView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setRotationDeg(0);
    setMirrored(false);
  };

  const aspectRatio = `${project.width} / ${project.height}`;
  // Dynamic warm light-table spill glow synced to lightboxDim
  const glowIntensity = theme === 'night' ? Math.max(0, (lightboxDim - 0.35) * 0.28) : 0;
  const showBlankWhisper =
    !isPlaying &&
    !hasSessionStroke &&
    !hasFloating &&
    project.frames.length === 1 &&
    frame.layers.every((l) => !l.blobKey) &&
    guides.underlay === 'none' &&
    (project.paperStyle ?? 'bristol') === 'bristol' &&
    !project.backgroundBlobKey;

  const isPortraitOrSquare = project.height >= project.width;

  return (
    <div
      ref={stageRef}
      className="relative flex-1 desk-surface-mat overflow-hidden flex items-center justify-center px-3 pb-7 pt-11 sm:px-5 sm:pb-8 sm:pt-10 select-none"
    >
      {/* Live 120 FPS Dual-Contrast Brush Size Ring Cursor (stage-relative at all breakpoints!) */}
      <div
        ref={brushRingRef}
        aria-hidden="true"
        className="pointer-events-none absolute top-0 left-0 z-40 rounded-full opacity-0"
        style={{
          border: '1.5px solid rgba(28, 25, 23, 0.85)',
          boxShadow: '0 0 0 1px rgba(247, 243, 233, 0.9), inset 0 0 0 1px rgba(247, 243, 233, 0.5)',
          willChange: 'transform',
        }}
      />

      {/* Eyedropper Sampled Color Chip */}
      {pickedColorBadge && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30 px-3 py-1 rounded-full bg-desk-panel border border-desk-border shadow-xl flex items-center gap-2 font-mono text-xs">
          <span
            className="w-4 h-4 rounded-full border border-white/40"
            style={{ backgroundColor: pickedColorBadge }}
          />
          <span>{pickedColorBadge}</span>
        </div>
      )}

      {/* Minimal Silent Level-3 Floating Desk Ergonomics Bar */}
      <div className="absolute top-2.5 right-3 z-20 flex items-center gap-0.5 p-1 rounded-xl bg-desk-surface/95 border border-desk-border shadow-lg">
        <button
          type="button"
          onClick={() => setZoom((z) => Math.max(0.4, Number((z - 0.15).toFixed(2))))}
          title={t('stageZoomOut')}
          className="min-w-[36px] min-h-[36px] p-2 rounded-lg inline-flex items-center justify-center text-desk-muted hover:text-desk-text hover:bg-desk-panel transition-colors"
        >
          <ZoomOut className="w-3.5 h-3.5" />
        </button>
        <span className="font-mono text-[11px] text-desk-muted px-1 w-10 text-center">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          onClick={() => setZoom((z) => Math.min(4, Number((z + 0.15).toFixed(2))))}
          title={t('stageZoomIn')}
          className="min-w-[36px] min-h-[36px] p-2 rounded-lg inline-flex items-center justify-center text-desk-muted hover:text-desk-text hover:bg-desk-panel transition-colors"
        >
          <ZoomIn className="w-3.5 h-3.5" />
        </button>
        <div className="w-px h-4 bg-desk-border mx-0.5" />
        <button
          type="button"
          onClick={() => setRotationDeg((r) => r - 15)}
          title={t('stageRotateL')}
          className="min-w-[36px] min-h-[36px] p-2 rounded-lg inline-flex items-center justify-center text-desk-muted hover:text-desk-text hover:bg-desk-panel transition-colors"
        >
          <RotateCcw className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setRotationDeg((r) => r + 15)}
          title={t('stageRotateR')}
          className="min-w-[36px] min-h-[36px] p-2 rounded-lg inline-flex items-center justify-center text-desk-muted hover:text-desk-text hover:bg-desk-panel transition-colors"
        >
          <RotateCw className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={() => {
            soundEngine.toggle(!mirrored);
            setMirrored((m) => !m);
          }}
          title={t('stageMirrorView')}
          className={`min-w-[36px] min-h-[36px] p-2 rounded-lg inline-flex items-center justify-center transition-colors ${
            mirrored
              ? 'bg-ink-brass/20 text-ink-brass'
              : 'text-desk-muted hover:text-desk-text hover:bg-desk-panel'
          }`}
        >
          <FlipHorizontal2 className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={resetDeskView}
          title={t('stageResetView')}
          className="min-w-[36px] min-h-[36px] p-2 rounded-lg inline-flex items-center justify-center text-desk-muted hover:text-desk-text hover:bg-desk-panel transition-colors"
        >
          <Maximize2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Lasso Transform + Cross-Frame Copy Floating HUD */}
      {hasFloating && (
        <div className="absolute top-2.5 left-3 z-20 flex flex-wrap items-center gap-1.5 p-1.5 rounded-xl bg-desk-surface border border-ink-vermilion shadow-xl">
          <span className="font-mono text-[11px] text-ink-vermilion px-1.5">
            {t('stageSelectionTag')}
          </span>
          <KeycapButton
            size="sm"
            tilt={false}
            onClick={() => engineRef.current?.transformFloating({ rotation: -10 })}
            className="px-2"
          >
            -10°
          </KeycapButton>
          <KeycapButton
            size="sm"
            tilt={false}
            onClick={() => engineRef.current?.transformFloating({ rotation: 10 })}
            className="px-2"
          >
            +10°
          </KeycapButton>
          <KeycapButton
            size="sm"
            tilt={false}
            onClick={() => engineRef.current?.transformFloating({ flipX: true })}
            title={t('stageSelectionMirror')}
            className="px-2"
          >
            <FlipHorizontal2 className="w-3.5 h-3.5" />
          </KeycapButton>
          <KeycapButton
            size="sm"
            tilt={false}
            onClick={() => {
              if (engineRef.current?.copyFloatingToClipboard()) {
                notify(t('stageSelectionCopied'), 'info');
              }
            }}
            title={t('stageSelectionCopy')}
            className="px-2"
          >
            <Copy className="w-3.5 h-3.5" />
          </KeycapButton>
          <KeycapButton
            size="sm"
            variant="vermilion"
            onClick={() => engineRef.current?.commitFloatingSelection()}
          >
            <Check className="w-3.5 h-3.5" />
            {t('stageSelectionApply')}
          </KeycapButton>
        </div>
      )}

      {/* Physical Backlit Animation Paper Sheet with Interactive ACME 3-Hole Pegbar */}
      <div
        className={`relative max-w-full max-h-full ${
          isInteractingView ? 'transition-none' : 'transition-transform duration-75'
        }`}
        style={{
          width: isPortraitOrSquare ? 'auto' : 'min(96%, 1040px)',
          height: isPortraitOrSquare ? 'min(90%, 540px)' : 'auto',
          maxHeight: 'calc(100% - 1.4rem)',
          aspectRatio,
          transform: `translate3d(${pan.x}px, ${pan.y}px, 0) rotate(${rotationDeg}deg) scale(${
            mirrored ? -zoom : zoom
          }, ${zoom})`,
        }}
      >
        {/* Interactive ACME 3-Hole Pegbar: Left=Prev, Middle=Guides, Right=Next */}
        <div className="absolute -top-6 left-1/2 -translate-x-1/2 h-6 px-5 rounded-t-lg bg-[#d8d1c2] border border-b-0 border-[#b2a996] flex items-center gap-6 shadow-sm z-10">
          <button
            type="button"
            onClick={() => {
              if (activeFrameIndex > 0) {
                soundEngine.paperFlip();
                selectFrame(activeFrameIndex - 1);
              }
            }}
            className="w-3 h-3 rounded-full bg-[#2a2723] hover:bg-ink-vermilion transition-colors shadow-inner"
            title={t('stagePrevPaper')}
            aria-label={t('stagePrevPaper')}
          />
          <button
            type="button"
            onClick={() => {
              soundEngine.toggle(!guides.enabled);
              updateGuides({ enabled: !guides.enabled });
            }}
            className={`w-10 h-2.5 rounded-full transition-colors shadow-inner ${
              guides.enabled ? 'bg-ink-blue' : 'bg-[#2a2723] hover:bg-ink-brass'
            }`}
            title={t('stageToggleGuides')}
            aria-label={t('stageToggleGuides')}
          />
          <button
            type="button"
            onClick={() => {
              if (activeFrameIndex < project.frames.length - 1) {
                soundEngine.paperFlip();
                selectFrame(activeFrameIndex + 1);
              }
            }}
            className="w-3 h-3 rounded-full bg-[#2a2723] hover:bg-ink-vermilion transition-colors shadow-inner"
            title={t('stageNextPaper')}
            aria-label={t('stageNextPaper')}
          />
        </div>

        <div
          className={`relative w-full h-full rounded-md overflow-hidden border border-black/25 ${flipClass}`}
          style={{
            boxShadow:
              glowIntensity > 0
                ? `0 0 85px rgba(247, 232, 198, ${glowIntensity.toFixed(3)}), 0 24px 68px rgba(0,0,0,0.7)`
                : 'var(--paper-shadow)',
          }}
        >
          <canvas
            ref={canvasRef}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onPointerLeave={() => {
              if (brushRingRef.current) brushRingRef.current.style.opacity = '0';
            }}
            className={`w-full h-full block touch-none ${
              spacePanning
                ? 'cursor-grab active:cursor-grabbing'
                : activeLayerBlocked
                  ? 'cursor-not-allowed'
                  : isCrosshairTool
                    ? 'cursor-crosshair'
                    : 'cursor-none'
            } ${isPlaying ? 'hidden' : ''}`}
          />

          <canvas
            ref={playbackCanvasRef}
            className={`w-full h-full block ${isPlaying ? '' : 'hidden'}`}
          />

          {project.paperGrain > 0 && (
            <div
              className="absolute inset-0 paper-grain-overlay"
              style={{ opacity: project.paperGrain }}
            />
          )}

          {/* First-Time Blank-Canvas Starter Whisper (vanishes automatically on first stroke!) */}
          {showBlankWhisper && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center p-4 text-center">
              <div className="max-w-md rounded-2xl bg-[#1c1917]/5 border border-[#1c1917]/10 px-4 py-3 space-y-2.5">
                <p className="text-xs font-medium text-[#3b352c]/80 leading-relaxed">
                  {t('stageWhisperMain')}
                </p>
                <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      soundEngine.toggle(true);
                      updateGuides({ underlay: 'bounce' });
                    }}
                    className="px-2.5 py-1 rounded-full bg-[#FAF6EE]/90 border border-[#1c1917]/20 text-[11px] font-semibold text-[#1c1917] hover:border-[#E54D2E] hover:text-[#E54D2E] transition-colors cursor-pointer"
                  >
                    {t('stageWhisperBounce')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      soundEngine.toggle(true);
                      updateGuides({ underlay: 'walk' });
                    }}
                    className="px-2.5 py-1 rounded-full bg-[#FAF6EE]/90 border border-[#1c1917]/20 text-[11px] font-semibold text-[#1c1917] hover:border-[#2563EB] hover:text-[#2563EB] transition-colors cursor-pointer"
                  >
                    {t('stageWhisperWalk')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      soundEngine.click(1.05);
                      updateProjectSettings({ paperStyle: 'grid' });
                    }}
                    className="px-2.5 py-1 rounded-full bg-[#FAF6EE]/90 border border-[#1c1917]/20 text-[11px] font-semibold text-[#1c1917] hover:border-[#D99B26] hover:text-[#9a6a0e] transition-colors cursor-pointer"
                  >
                    {t('stageWhisperGrid')}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Bottom discrete desk stamp */}
        <div
          className="absolute -bottom-6 left-0 right-0 flex items-center justify-between font-mono text-[11px] text-desk-muted pointer-events-none"
          style={{ transform: mirrored ? 'scaleX(-1)' : undefined }}
        >
          <div className="flex items-center gap-3">
            <span>
              {t('stageFrameLabel')} #{String(activeFrameIndex + 1).padStart(3, '0')}
            </span>
            <span>
              {t('stageHoldLabel')}: {frame.hold}{' '}
              {frame.hold === 1 ? t('stageHoldSingular') : t('stageHoldUnit')}
            </span>
            {rotationDeg !== 0 && (
              <span>
                {t('stageAngleLabel')}: {rotationDeg}°
              </span>
            )}
            {mirrored && <span className="text-ink-brass">{t('stageMirrorTag')}</span>}
          </div>
          <span
            className={`hidden xl:inline opacity-65 truncate ${
              project.frames.length > 1 ? 'pr-24' : ''
            }`}
          >
            {t('stageShortcutHint')}
          </span>
        </div>
      </div>

      {/* Physical Knurled Brass Flip & Roll Quick Scrub Dial (Bottom-Right of Desk) */}
      {project.frames.length > 1 && !isPlaying && (
        <div className="absolute bottom-2.5 right-3 z-20 hidden sm:flex items-center gap-2.5 px-3 py-1.5 rounded-2xl bg-desk-surface/95 border border-desk-border shadow-xl">
          <BrassRotaryDial
            value={activeFrameIndex}
            min={0}
            max={project.frames.length - 1}
            step={1}
            size={32}
            label={t('stageFlipDialTitle')}
            onChange={(next) => {
              if (next !== activeFrameIndex) selectFrame(next);
            }}
          />
          <div className="flex flex-col">
            <span className="font-mono text-[11px] uppercase tracking-wider text-ink-brass">
              {t('stageFlipLabel')}
            </span>
            <span className="font-mono text-[11px] text-desk-muted">
              {activeFrameIndex + 1}/{project.frames.length}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
