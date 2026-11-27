import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Minimize2, Plus } from 'lucide-react';
import { useStudioStore } from '../../store/useStudioStore';
import type { StudioCanvasEngine } from '../../engine/canvasEngine';
import { soundEngine } from '../../engine/soundEngine';
import { useT } from '../../i18n/translations';
import { MotionPlayIcon } from '../ui/AnimatedStudioIcons';
import ToolDeck from './ToolDeck';
import DrawingStage from './DrawingStage';
import LayerReferenceRail from './LayerReferenceRail';
import XSheetTimeline from './XSheetTimeline';
import { RadialQuickWheel } from './RadialQuickWheel';

export default function DrawWorkspace() {
  const {
    projects,
    activeProjectId,
    activeFrameIndex,
    playbackFrameIndex,
    isPlaying,
    setPlaying,
    selectFrame,
    addFrameAfterCurrent,
    updateLayerBlobAndThumb,
    zenMode,
    toggleZenMode,
    setZenMode,
  } = useStudioStore();
  const t = useT();
  const engineRef = useRef<StudioCanvasEngine | null>(null);
  const lastPointerRef = useRef({ x: 480, y: 340 });
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [mobileLayersOpen, setMobileLayersOpen] = useState(false);
  const [wheelState, setWheelState] = useState<{ open: boolean; x: number; y: number }>({
    open: false,
    x: 480,
    y: 340,
  });

  const project = projects.find((p) => p.id === activeProjectId);
  const frameCount = project?.frames.length ?? 1;

  // Global Tab (Zen Mode) + Q (Radial Quick Wheel) shortcuts
  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') {
        lastPointerRef.current = { x: e.clientX, y: e.clientY };
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if ((e.target as HTMLElement | null)?.isContentEditable) return;

      if (e.key === 'Tab' && !useStudioStore.getState().activeTourMode) {
        e.preventDefault();
        soundEngine.toggle(!useStudioStore.getState().zenMode);
        toggleZenMode();
      } else if (e.key.toLowerCase() === 'q') {
        e.preventDefault();
        soundEngine.click(1.1);
        setWheelState((prev) =>
          prev.open
            ? { ...prev, open: false }
            : { open: true, x: lastPointerRef.current.x, y: lastPointerRef.current.y }
        );
      }
    };
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [toggleZenMode]);

  const persistAfterHistory = (layerId: string | null) => {
    const eng = engineRef.current;
    if (!layerId || !eng) return;
    const st = useStudioStore.getState();
    const proj = st.projects.find((p) => p.id === st.activeProjectId);
    const frame = proj?.frames[st.activeFrameIndex];
    const layer = frame?.layers.find((l) => l.id === layerId);
    if (!proj || !frame || !layer || eng.getLoadedFrameId() !== frame.id) return;

    // Capture canvas pixels synchronously so rapid Undo + Frame Switch never races!
    const snap = eng.snapshotLayerAndThumbSync(layerId);
    if (!snap) return;
    const capturedProjId = proj.id;
    const capturedSceneId = proj.activeSceneId;
    const capturedFrameId = frame.id;
    void eng.persistSnapshot(snap, layer.blobKey, frame.thumbKey).then((res) => {
      updateLayerBlobAndThumb(
        capturedFrameId,
        layerId,
        res.layerBlobKey,
        res.thumbKey,
        capturedProjId,
        capturedSceneId
      );
    });
  };

  const handleUndo = () => persistAfterHistory(engineRef.current?.undo() ?? null);
  const handleRedo = () => persistAfterHistory(engineRef.current?.redo() ?? null);

  const handleOpenQuickWheelCentered = () => {
    soundEngine.click(1.1);
    const cx = typeof window !== 'undefined' ? Math.round(window.innerWidth / 2) : 480;
    const cy = typeof window !== 'undefined' ? Math.round(window.innerHeight / 2) : 340;
    setWheelState((prev) => (prev.open ? { ...prev, open: false } : { open: true, x: cx, y: cy }));
  };

  return (
    <div className="relative flex-1 flex flex-col min-h-0">
      <div className="flex-1 flex flex-col lg:flex-row min-h-0">
        {!zenMode && (
          <ToolDeck
            canUndo={canUndo}
            canRedo={canRedo}
            onUndo={handleUndo}
            onRedo={handleRedo}
            onClearLayer={() => engineRef.current?.clearActiveLayer()}
            onToggleMobileLayers={() => setMobileLayersOpen((v) => !v)}
            onOpenQuickWheel={handleOpenQuickWheelCentered}
          />
        )}

        <div
          className="flex-1 flex min-w-0 min-h-0"
          onContextMenu={(e) => {
            e.preventDefault();
            soundEngine.click(1.12);
            setWheelState({ open: true, x: e.clientX, y: e.clientY });
          }}
        >
          <DrawingStage
            engineRef={engineRef}
            onHistoryState={(u, r) => {
              setCanUndo(u);
              setCanRedo(r);
            }}
          />
        </div>

        {!zenMode && (
          <LayerReferenceRail
            mobileOpen={mobileLayersOpen}
            onCloseMobile={() => setMobileLayersOpen(false)}
          />
        )}
      </div>
      {!zenMode && <XSheetTimeline />}

      <RadialQuickWheel
        open={wheelState.open}
        x={wheelState.x}
        y={wheelState.y}
        onClose={() => setWheelState((s) => ({ ...s, open: false }))}
        onUndo={handleUndo}
      />

      {zenMode && (
        <div className="toast-pop-in fixed bottom-4 left-1/2 -translate-x-1/2 z-40 px-2 py-1 rounded-full bg-desk-panel/95 backdrop-blur-md border border-ink-brass/55 shadow-2xl flex items-center gap-1">
          <button
            type="button"
            disabled={activeFrameIndex <= 0}
            onClick={() => {
              soundEngine.paperFlip();
              selectFrame(Math.max(0, activeFrameIndex - 1));
            }}
            className="min-w-[44px] min-h-[44px] p-2 rounded-full hover:bg-desk-well text-desk-text disabled:opacity-35 inline-flex items-center justify-center transition-colors"
            title={t('stagePrevPaper')}
            aria-label={t('stagePrevPaper')}
          >
            <ChevronLeft className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={() => setPlaying(!isPlaying)}
            className="min-h-[44px] px-3.5 rounded-full bg-ink-vermilion text-white font-mono text-[11px] font-bold inline-flex items-center justify-center gap-1.5"
            title={t('playPause')}
          >
            <MotionPlayIcon playing={isPlaying} className="w-3.5 h-3.5" />
            <span>
              #{(playbackFrameIndex ?? activeFrameIndex) + 1}/{frameCount}
            </span>
          </button>

          <button
            type="button"
            disabled={activeFrameIndex >= frameCount - 1}
            onClick={() => {
              soundEngine.paperFlip();
              selectFrame(Math.min(frameCount - 1, activeFrameIndex + 1));
            }}
            className="min-w-[44px] min-h-[44px] p-2 rounded-full hover:bg-desk-well text-desk-text disabled:opacity-35 inline-flex items-center justify-center transition-colors"
            title={t('stageNextPaper')}
            aria-label={t('stageNextPaper')}
          >
            <ChevronRight className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={() => {
              soundEngine.paperFlip();
              void addFrameAfterCurrent(false);
            }}
            className="min-h-[44px] px-3 rounded-full console-well border border-desk-border hover:border-ink-brass text-[11px] font-mono font-bold text-desk-text inline-flex items-center justify-center gap-1 transition-colors"
            title={t('xsheetBlankFrame')}
          >
            <Plus className="w-3.5 h-3.5 text-ink-brass" />
            <span>{t('radialNewFrame')}</span>
          </button>

          <span className="w-px h-5 bg-desk-border mx-0.5" aria-hidden="true" />

          <button
            type="button"
            onClick={() => {
              soundEngine.toggle(false);
              setZenMode(false);
            }}
            className="min-h-[44px] px-3 rounded-full text-xs font-mono font-bold text-ink-brass hover:text-desk-text inline-flex items-center justify-center gap-1 transition-colors"
          >
            <Minimize2 className="w-3.5 h-3.5" />
            <span>{t('exitZen')}</span>
          </button>
        </div>
      )}
    </div>
  );
}
