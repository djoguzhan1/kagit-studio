import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Crosshair,
  Download,
  Film,
  Image as ImageIcon,
  Lasso,
  Layers,
  Mic,
  Plus,
  Redo2,
  Sparkles,
  Square,
  Trash2,
  Undo2,
  Upload,
  X,
} from 'lucide-react';
import { useStudioStore } from '../../store/useStudioStore';
import { localizeActorName, localizePinOrPartLabel, useT, useTFmt, type TranslationKey } from '../../i18n/translations';
import { safeSetPointerCapture } from '../../utils/pointerCapture';
import { useModalA11y } from '../../hooks/useModalA11y';
import type {
  EasingType,
  PartTransform,
  PuppetKeyframe,
  PuppetPart,
  PuppetRig,
} from '../../types/studio';
import { canvasToPngBlob, getBlobBitmap, makeId, saveBlob } from '../../engine/db';
import {
  autoSplitCanvasToPuppetParts,
  computeRigWorldGeometry,
  extractLassoCutout,
  generateMotionPresetKeyframes,
  IDENTITY_TRANSFORM,
  interpolateRigTransforms,
  renderPuppetFrame,
  renderPuppetFrameSync,
  wouldCreateBoneCycle,
  type RigPresetId,
} from '../../engine/puppetEngine';
import { prepareCharacterCanvas } from '../../engine/characterIntakeEngine';
import {
  encodeFramesToMp4WebCodecs,
  pickBestMediaRecorderFormat,
} from '../../engine/videoExportEngine';
import { renderFrameComposite } from '../../engine/frameComposite';
import {
  analyzeAndStoreAudio,
  decodeAudioBlobToMonoPCM,
  isAudioBufferSilent,
  MicVoiceRecorder,
  renderAudioTrackOffline,
  rmsToMouthViseme,
  StudioAudioPlayer,
} from '../../engine/audioEngine';
import { createSampleMeshWarpRig } from '../../engine/starterPresets';
import { drawKagitSealStamp, triggerDownload } from '../../engine/exportEngine';
import { runGifEncode } from '../../engine/paperWorkerClient';
import { soundEngine } from '../../engine/soundEngine';
import { KeycapButton } from '../ui/KeycapButton';
import { JointBoneIcon, MotionPlayIcon } from '../ui/AnimatedStudioIcons';
import MeshWarpStage from './MeshWarpStage';

const MAX_UNDO = 25;

export default function PuppetStudio() {
  const t = useT();
  const tf = useTFmt();
  const {
    projects,
    activeProjectId,
    activeFrameIndex,
    locale,
    soundEnabled,
    puppetExportOpen,
    setPuppetExportOpen,
    upsertRig,
    deleteRig,
    bakeRenderedShotToFrames,
    setAudioTrack,
    notify,
    activeMasterRig,
  } = useStudioStore();

  const project = projects.find((p) => p.id === activeProjectId);
  const [activeRigId, setActiveRigId] = useState<string | null>(
    () => project?.rigs[0]?.id ?? null
  );
  const activeRig = project?.rigs.find((r) => r.id === activeRigId) ?? project?.rigs[0] ?? null;

  const [engineTab, setEngineTab] = useState<'mesh' | 'cutout'>('mesh');
  const [subMode, setSubMode] = useState<'cut' | 'animate'>('cut');
  const [selectedPartId, setSelectedPartId] = useState<string | null>(null);
  const [placingPivot, setPlacingPivot] = useState(false);
  const [autoSplitting, setAutoSplitting] = useState(false);
  const [partNameDraft, setPartNameDraft] = useState(() => localizePinOrPartLabel('Gövde', locale));
  const [confirmDeleteRig, setConfirmDeleteRig] = useState(false);

  const cutCanvasRef = useRef<HTMLCanvasElement>(null);
  const sourceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [lassoPts, setLassoPts] = useState<{ x: number; y: number }[]>([]);
  const [drawingLasso, setDrawingLasso] = useState(false);

  // Undo / Redo for Cutout Rig
  const pastRef = useRef<PuppetRig[]>([]);
  const futureRef = useRef<PuppetRig[]>([]);
  const [histCounts, setHistCounts] = useState({ past: 0, future: 0 });

  // Export state for Cutout Mode
  const [exportingKind, setExportingKind] = useState<null | 'video' | 'gif' | 'draw'>(null);
  const activeTourMode = useStudioStore((st) => st.activeTourMode);
  useEffect(() => {
    if (activeTourMode === 'puppet' && engineTab !== 'mesh') {
      setEngineTab('mesh');
    }
  }, [activeTourMode, engineTab]);
  const cutoutExportDialogRef = useModalA11y<HTMLDivElement>({
    open: Boolean(engineTab === 'cutout' && puppetExportOpen && activeRig),
    onClose: () => setPuppetExportOpen(false),
    closeDisabled: Boolean(exportingKind),
    modal: true,
  });
  const [exportPct, setExportPct] = useState(0);
  const [exportLabel, setExportLabel] = useState('');
  const exportAbortRef = useRef(false);

  // Smooth On-Canvas Bone Gizmo drag state (commits once on pointerUp!)
  const gizmoDragRef = useRef<{
    mode: 'move' | 'rotate' | 'scale';
    partId: string;
    startX: number;
    startY: number;
    pivotX: number;
    pivotY: number;
    startAngle: number;
    origTransform: PartTransform;
    fitScale: number;
    latestPatch: Partial<PartTransform>;
  } | null>(null);

  const stageCanvasRef = useRef<HTMLCanvasElement>(null);
  const timelineRangeRef = useRef<HTMLInputElement>(null);
  const frameReadoutRef = useRef<HTMLSpanElement>(null);
  const partBitmapMapRef = useRef<Map<string, CanvasImageSource>>(new Map());
  const customMouthImagesRef = useRef<Partial<Record<'closed' | 'A' | 'E' | 'O', CanvasImageSource>>>({});
  const audioPlayerRef = useRef<StudioAudioPlayer | null>(null);
  const recorderRef = useRef<MicVoiceRecorder | null>(null);
  const [recording, setRecording] = useState(false);
  const [rigFrame, setRigFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [easing, setEasing] = useState<EasingType>('easeInOut');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeRigRef = useRef(activeRig);
  activeRigRef.current = activeRig;
  const rigFrameRef = useRef(rigFrame);
  rigFrameRef.current = rigFrame;

  // Pre-warm part ImageBitmaps in RAM for 0-blocking synchronous rAF playback
  useEffect(() => {
    if (!activeRig) {
      partBitmapMapRef.current.clear();
      return;
    }
    let cancelled = false;
    void (async () => {
      const next = new Map<string, CanvasImageSource>();
      for (const part of activeRig.parts) {
        const cached = partBitmapMapRef.current.get(part.blobKey);
        if (cached) {
          next.set(part.blobKey, cached);
        } else {
          const bmp = await getBlobBitmap(part.blobKey);
          if (bmp) next.set(part.blobKey, bmp);
        }
      }
      if (!cancelled) {
        partBitmapMapRef.current = next;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeRig]);

  useEffect(() => {
    const mouths = activeMasterRig?.faceSprites?.mouths;
    if (!mouths) {
      customMouthImagesRef.current = {};
      return;
    }
    let cancelled = false;
    const nextMap: Partial<Record<'closed' | 'A' | 'E' | 'O', CanvasImageSource>> = {};
    for (const k of ['closed', 'A', 'E', 'O'] as const) {
      const url = mouths[k];
      if (!url) continue;
      const img = new Image();
      img.onload = () => {
        if (!cancelled) {
          nextMap[k] = img;
          customMouthImagesRef.current = { ...nextMap };
        }
      };
      img.src = url;
    }
    return () => {
      cancelled = true;
    };
  }, [activeMasterRig?.faceSprites?.mouths, activeMasterRig?.updatedAt]);

  const easingOptions = useMemo<{ id: EasingType; label: string }[]>(
    () => [
      { id: 'easeInOut', label: t('puppetCutCurveSmooth') },
      { id: 'linear', label: t('puppetCutCurveLinear') },
      { id: 'bounce', label: t('puppetCutCurveBounce') },
      { id: 'elastic', label: t('puppetCutCurveElastic') },
      { id: 'step', label: t('puppetCutCurveStepped') },
    ],
    [t]
  );

  const mouthSlots = useMemo<{ id: PuppetPart['mouthSlot']; label: string }[]>(
    () => [
      { id: null, label: t('puppetCutMouthNormal') },
      { id: 'closed', label: t('puppetCutMouthClosed') },
      { id: 'half', label: t('puppetCutMouthHalf') },
      { id: 'wide', label: t('puppetCutMouthWide') },
      { id: 'round', label: t('puppetCutMouthRound') },
    ],
    [t]
  );

  const motionPresets = useMemo<{ id: RigPresetId; label: string }[]>(
    () => [
      { id: 'breathe', label: t('puppetMoveBreathe') },
      { id: 'bounce', label: t('puppetMoveBounce') },
      { id: 'wave', label: t('puppetMoveWave') },
      { id: 'walk', label: t('puppetMoveWalk') },
      { id: 'dance', label: t('puppetMoveDance') },
    ],
    [t]
  );

  const commitRig = useCallback(
    (next: PuppetRig, recordHistory = true) => {
      if (recordHistory && activeRigRef.current) {
        pastRef.current = [...pastRef.current.slice(-(MAX_UNDO - 1)), activeRigRef.current];
        futureRef.current = [];
        setHistCounts({ past: pastRef.current.length, future: 0 });
      }
      upsertRig(next);
    },
    [upsertRig]
  );

  const handleUndo = useCallback(() => {
    const past = pastRef.current;
    if (past.length === 0 || !activeRigRef.current) return;
    const prev = past[past.length - 1];
    pastRef.current = past.slice(0, -1);
    futureRef.current = [activeRigRef.current, ...futureRef.current.slice(0, MAX_UNDO - 1)];
    setHistCounts({ past: pastRef.current.length, future: futureRef.current.length });
    upsertRig(prev);
    soundEngine.click(0.92);
  }, [upsertRig]);

  const handleRedo = useCallback(() => {
    const future = futureRef.current;
    if (future.length === 0 || !activeRigRef.current) return;
    const next = future[0];
    futureRef.current = future.slice(1);
    pastRef.current = [...pastRef.current, activeRigRef.current];
    setHistCounts({ past: pastRef.current.length, future: futureRef.current.length });
    upsertRig(next);
    soundEngine.click(1.08);
  }, [upsertRig]);

  const createRigFromCanvas = async (canvas: HTMLCanvasElement, name: string) => {
    const blob = await canvasToPngBlob(canvas);
    const sourceBlobKey = await saveBlob(blob);
    const rig: PuppetRig = {
      id: makeId('rig'),
      name,
      sourceBlobKey,
      sourceW: canvas.width,
      sourceH: canvas.height,
      parts: [],
      keyframes: [
        {
          id: makeId('kf'),
          frame: 0,
          easing: 'easeInOut',
          transforms: {},
        },
      ],
      totalFrames: 24,
    };
    upsertRig(rig);
    setActiveRigId(rig.id);
    setSubMode('cut');
    setConfirmDeleteRig(false);
    notify(tf('puppetCutLoadedToast', { name: localizeActorName(name, locale) }));
  };

  const handleLoadSampleCutout = async () => {
    const sample = await createSampleMeshWarpRig();
    const bmp = await getBlobBitmap(sample.sourceBlobKey);
    if (!bmp) return;
    const c = document.createElement('canvas');
    c.width = sample.sourceW;
    c.height = sample.sourceH;
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    await createRigFromCanvas(c, localizeActorName('Şapkalı Baron', locale));
  };

  const handleLoadFromCurrentFrame = async () => {
    if (!project) return;
    const frame = project.frames[activeFrameIndex] ?? project.frames[0];
    if (!frame || frame.layers.every((l) => !l.blobKey)) {
      notify(t('puppetBlankFrameInfo'), 'info');
      return;
    }
    const raw = await renderFrameComposite(project, frame, {
      transparentBg: true,
      hideRoughBlue: true,
    });
    const prepared = prepareCharacterCanvas(raw, { maxDim: 768, stripPaper: false });
    await createRigFromCanvas(
      prepared.canvas,
      tf('puppetFramePuppetName', { num: activeFrameIndex + 1 })
    );
  };

  const handleUploadSource = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = reject;
        el.src = url;
      });
      // Unified BFS paper removal (preserves white eyes/teeth!) + faint pencil boost + tight auto-crop!
      const prepared = prepareCharacterCanvas(img, { maxDim: 768, stripPaper: true });
      if (prepared.empty) {
        notify(t('puppetEmptyUploadError'), 'error');
        return;
      }
      await createRigFromCanvas(prepared.canvas, file.name.replace(/\.[^.]+$/, '').slice(0, 26) || localizeActorName('Kukla', locale));
    } catch {
      notify(t('puppetErrReadImage'), 'error');
    } finally {
      URL.revokeObjectURL(url);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleAutoCutParts = async () => {
    if (!activeRig || autoSplitting) return;
    setAutoSplitting(true);
    try {
      let src = sourceCanvasRef.current;
      if (!src) {
        const bmp = await getBlobBitmap(activeRig.sourceBlobKey);
        if (!bmp) return;
        const c = document.createElement('canvas');
        c.width = activeRig.sourceW;
        c.height = activeRig.sourceH;
        c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
        src = c;
        sourceCanvasRef.current = c;
      }
      const autoParts = await autoSplitCanvasToPuppetParts(src, locale);
      if (autoParts.length === 0) {
        notify(t('puppetErrDetectParts'), 'error');
        return;
      }
      const nextTransforms: Record<string, PartTransform> = {};
      for (const p of autoParts) nextTransforms[p.id] = { ...IDENTITY_TRANSFORM };
      const updated: PuppetRig = {
        ...activeRig,
        parts: autoParts,
        keyframes: [
          {
            id: makeId('kf'),
            frame: 0,
            easing: 'easeInOut',
            transforms: nextTransforms,
          },
        ],
      };
      commitRig(updated);
      setSelectedPartId(autoParts[0]?.id ?? null);
      setSubMode('animate');
      soundEngine.clapperSnap();
      notify(tf('puppetAutoSplitToast', { count: autoParts.length }));
    } finally {
      setAutoSplitting(false);
    }
  };

  const redrawCutCanvas = useCallback(async () => {
    const canvas = cutCanvasRef.current;
    if (!canvas || !activeRig) return;

    const bmp = await getBlobBitmap(activeRig.sourceBlobKey);
    if (!bmp) return;

    const src = document.createElement('canvas');
    src.width = activeRig.sourceW;
    src.height = activeRig.sourceH;
    src.getContext('2d')!.drawImage(bmp, 0, 0, activeRig.sourceW, activeRig.sourceH);
    sourceCanvasRef.current = src;

    canvas.width = activeRig.sourceW;
    canvas.height = activeRig.sourceH;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = project?.paperColor || '#F7F3E9';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(src, 0, 0);

    for (const part of activeRig.parts) {
      const isSel = part.id === selectedPartId;
      ctx.strokeStyle = isSel ? '#E54D2E' : 'rgba(37, 99, 235, 0.72)';
      ctx.lineWidth = isSel ? 3 : 2;
      ctx.setLineDash([7, 5]);
      ctx.strokeRect(part.x, part.y, part.w, part.h);
      ctx.setLineDash([]);

      ctx.fillStyle = isSel ? '#E54D2E' : '#D99B26';
      ctx.beginPath();
      ctx.arc(part.x + part.pivotX, part.y + part.pivotY, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = '#161513';
      ctx.font = 'bold 14px "JetBrains Mono", monospace';
      ctx.fillText(part.name, part.x + 6, Math.max(18, part.y + 18));
    }

    if (lassoPts.length > 1) {
      ctx.strokeStyle = '#E54D2E';
      ctx.fillStyle = 'rgba(229, 77, 46, 0.14)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(lassoPts[0].x, lassoPts[0].y);
      for (let i = 1; i < lassoPts.length; i++) ctx.lineTo(lassoPts[i].x, lassoPts[i].y);
      ctx.stroke();
      ctx.fill();
    }
  }, [activeRig, selectedPartId, lassoPts, project?.paperColor]);

  // FIXED: includes `engineTab` so returning to Cutout ALWAYS paints the full-res cutter canvas!
  useEffect(() => {
    if (engineTab === 'cutout' && subMode === 'cut') {
      void redrawCutCanvas();
    }
  }, [engineTab, subMode, redrawCutCanvas]);

  const buildRigWithTransformPatch = useCallback(
    (rig: PuppetRig, frameIdx: number, partId: string, patch: Partial<PartTransform>): PuppetRig => {
      const curAll = interpolateRigTransforms(rig, frameIdx);
      const curPart = curAll[partId] ?? IDENTITY_TRANSFORM;
      const nextPart: PartTransform = { ...curPart, ...patch };
      const existingKf = rig.keyframes.find((k) => k.frame === frameIdx);
      let nextKeyframes: PuppetKeyframe[];
      if (existingKf) {
        nextKeyframes = rig.keyframes.map((k) =>
          k.frame === frameIdx
            ? { ...k, easing, transforms: { ...k.transforms, [partId]: nextPart } }
            : k
        );
      } else {
        nextKeyframes = [
          ...rig.keyframes,
          {
            id: makeId('kf'),
            frame: frameIdx,
            easing,
            transforms: { ...curAll, [partId]: nextPart },
          },
        ].sort((a, b) => a.frame - b.frame);
      }
      return { ...rig, keyframes: nextKeyframes };
    },
    [easing]
  );

  const redrawAnimStage = useCallback(
    async (frameIdx: number, rigOverride?: PuppetRig) => {
      const rig = rigOverride ?? activeRigRef.current;
      const canvas = stageCanvasRef.current;
      if (!canvas || !rig || !project) return;
      if (canvas.width !== project.width) canvas.width = project.width;
      if (canvas.height !== project.height) canvas.height = project.height;
      const ctx = canvas.getContext('2d')!;
      await renderPuppetFrame(ctx, rig, frameIdx, project.width, project.height, {
        audio: project.audio,
        selectedPartId,
        showSkeleton: !playing,
        paperColor: project.paperColor,
        partBitmaps: partBitmapMapRef.current,
        customMouths: customMouthImagesRef.current,
      });
    },
    [project, selectedPartId, playing]
  );

  useEffect(() => {
    if (engineTab === 'cutout' && subMode === 'animate' && !playing) {
      void redrawAnimStage(rigFrame);
    }
  }, [engineTab, subMode, rigFrame, activeRig, playing, redrawAnimStage]);

  // Zero-Blocking Playback Loop: renders directly to Canvas via cached ImageBitmaps & updates DOM refs without 60Hz React re-renders!
  useEffect(() => {
    if (engineTab !== 'cutout' || !playing || !activeRigRef.current || !project) {
      audioPlayerRef.current?.stop();
      return;
    }
    if (!audioPlayerRef.current) audioPlayerRef.current = new StudioAudioPlayer();
    const player = audioPlayerRef.current;
    let cancelled = false;
    let raf = 0;

    const run = async () => {
      const canAudio = Boolean(project.audio && !project.audio.muted && soundEnabled);
      if (canAudio && project.audio) {
        await player.ensureLoaded(project.audio);
        if (!cancelled) {
          player.startAt(0, project.audio.volume, false, project.audio.voiceEffect ?? 'natural');
        }
      }
      const start = performance.now();
      let lastF = -1;
      let lastReactSyncMs = 0;

      const tick = (nowMs: number) => {
        if (cancelled || !activeRigRef.current) return;
        const curRig = activeRigRef.current;
        const totalFrames = Math.max(1, curRig.totalFrames);
        const elapsed = (nowMs - start) / 1000;
        const f = Math.floor(elapsed * project.fps) % totalFrames;
        if (f !== lastF) {
          if (f < lastF && canAudio && project.audio) {
            player.startAt(0, project.audio.volume, false, project.audio.voiceEffect ?? 'natural');
          }
          lastF = f;
          rigFrameRef.current = f;

          // Update timeline slider & frame readout directly via DOM refs (< 0.05 ms, 0 React reconciliation!)
          if (timelineRangeRef.current) {
            timelineRangeRef.current.value = String(f);
          }
          if (frameReadoutRef.current) {
            frameReadoutRef.current.textContent = `${f + 1} / ${totalFrames}`;
          }
          // Throttle React state sync to ~8 Hz solely for keyframe badge / viseme pill display
          if (nowMs - lastReactSyncMs >= 120) {
            lastReactSyncMs = nowMs;
            setRigFrame(f);
          }

          const canvas = stageCanvasRef.current;
          if (canvas) {
            if (canvas.width !== project.width) canvas.width = project.width;
            if (canvas.height !== project.height) canvas.height = project.height;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              const drawnSync = renderPuppetFrameSync(
                ctx,
                curRig,
                f,
                project.width,
                project.height,
                partBitmapMapRef.current,
                {
                  audio: project.audio,
                  showSkeleton: false,
                  paperColor: project.paperColor,
                  customMouths: customMouthImagesRef.current,
                }
              );
              if (!drawnSync) {
                void redrawAnimStage(f);
              }
            }
          }
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    };

    void run();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      player.stop();
      setRigFrame(rigFrameRef.current);
    };
  }, [engineTab, playing, project, soundEnabled, redrawAnimStage]);

  useEffect(() => {
    return () => {
      recorderRef.current?.cleanup();
      audioPlayerRef.current?.dispose();
    };
  }, []);

  const updatePartTransform = useCallback(
    (partId: string, patch: Partial<PartTransform>, recordHistory = true) => {
      if (!activeRigRef.current) return;
      const next = buildRigWithTransformPatch(activeRigRef.current, rigFrameRef.current, partId, patch);
      commitRig(next, recordHistory);
    },
    [buildRigWithTransformPatch, commitRig]
  );

  // Smooth On-Canvas Bone Gizmo Pointer Drag (Commits once on pointerUp!)
  const handleStagePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!activeRig || !project || playing || activeRig.parts.length === 0) return;
    const canvas = stageCanvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / Math.max(1, rect.width)) * project.width;
    const y = ((e.clientY - rect.top) / Math.max(1, rect.height)) * project.height;

    const { joints, fitScale } = computeRigWorldGeometry(
      activeRig,
      rigFrame,
      project.width,
      project.height
    );
    const curTransforms = interpolateRigTransforms(activeRig, rigFrame);

    if (selectedPartId && joints.has(selectedPartId)) {
      const selJ = joints.get(selectedPartId)!;
      if (Math.hypot(x - selJ.rotHandleX, y - selJ.rotHandleY) < 24) {
        safeSetPointerCapture(e.currentTarget, e.pointerId);
        gizmoDragRef.current = {
          mode: 'rotate',
          partId: selectedPartId,
          startX: x,
          startY: y,
          pivotX: selJ.pivotX,
          pivotY: selJ.pivotY,
          startAngle: Math.atan2(y - selJ.pivotY, x - selJ.pivotX),
          origTransform: { ...(curTransforms[selectedPartId] ?? IDENTITY_TRANSFORM) },
          fitScale,
          latestPatch: {},
        };
        return;
      }
      if (Math.hypot(x - selJ.scaleHandleX, y - selJ.scaleHandleY) < 22) {
        safeSetPointerCapture(e.currentTarget, e.pointerId);
        gizmoDragRef.current = {
          mode: 'scale',
          partId: selectedPartId,
          startX: x,
          startY: y,
          pivotX: selJ.centerX,
          pivotY: selJ.centerY,
          startAngle: 0,
          origTransform: { ...(curTransforms[selectedPartId] ?? IDENTITY_TRANSFORM) },
          fitScale,
          latestPatch: {},
        };
        return;
      }
    }

    const sorted = [...activeRig.parts].sort((a, b) => b.zIndex - a.zIndex);
    for (const part of sorted) {
      const j = joints.get(part.id);
      if (!j) continue;
      if (
        Math.hypot(x - j.pivotX, y - j.pivotY) < 22 ||
        Math.hypot(x - j.centerX, y - j.centerY) < j.radius
      ) {
        setSelectedPartId(part.id);
        safeSetPointerCapture(e.currentTarget, e.pointerId);
        gizmoDragRef.current = {
          mode: 'move',
          partId: part.id,
          startX: x,
          startY: y,
          pivotX: j.pivotX,
          pivotY: j.pivotY,
          startAngle: 0,
          origTransform: { ...(curTransforms[part.id] ?? IDENTITY_TRANSFORM) },
          fitScale,
          latestPatch: {},
        };
        return;
      }
    }
  };

  const handleStagePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = gizmoDragRef.current;
    if (!drag || !project || !activeRigRef.current) return;
    const canvas = stageCanvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / Math.max(1, rect.width)) * project.width;
    const y = ((e.clientY - rect.top) / Math.max(1, rect.height)) * project.height;

    let patch: Partial<PartTransform>;
    if (drag.mode === 'rotate') {
      const curAngle = Math.atan2(y - drag.pivotY, x - drag.pivotX);
      const deltaDeg = ((curAngle - drag.startAngle) * 180) / Math.PI;
      patch = { rotation: Math.round(drag.origTransform.rotation + deltaDeg) };
    } else if (drag.mode === 'scale') {
      const dx = Math.abs(x - drag.pivotX);
      const dy = Math.abs(y - drag.pivotY);
      const startDx = Math.max(12, Math.abs(drag.startX - drag.pivotX));
      const startDy = Math.max(12, Math.abs(drag.startY - drag.pivotY));
      patch = {
        scaleX: Math.max(0.4, Math.min(2.2, Number((drag.origTransform.scaleX * (dx / startDx)).toFixed(2)))),
        scaleY: Math.max(0.4, Math.min(2.2, Number((drag.origTransform.scaleY * (dy / startDy)).toFixed(2)))),
      };
    } else {
      patch = {
        dx: Math.round(drag.origTransform.dx + (x - drag.startX) / drag.fitScale),
        dy: Math.round(drag.origTransform.dy + (y - drag.startY) / drag.fitScale),
      };
    }

    drag.latestPatch = patch;
    // Preview smoothly without hammering Zustand / IndexedDB at 60 FPS!
    const previewRig = buildRigWithTransformPatch(
      activeRigRef.current,
      rigFrameRef.current,
      drag.partId,
      patch
    );
    void redrawAnimStage(rigFrameRef.current, previewRig);
  };

  const handleStagePointerUp = () => {
    const drag = gizmoDragRef.current;
    gizmoDragRef.current = null;
    if (drag && Object.keys(drag.latestPatch).length > 0) {
      updatePartTransform(drag.partId, drag.latestPatch, true);
    }
  };

  // Lasso Cutting Handlers
  const getCutCanvasCoords = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = cutCanvasRef.current!;
    const r = c.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / Math.max(1, r.width)) * c.width,
      y: ((e.clientY - r.top) / Math.max(1, r.height)) * c.height,
    };
  };

  const handleCutPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!activeRig) return;
    const pt = getCutCanvasCoords(e);

    if (placingPivot && selectedPartId) {
      const updatedParts = activeRig.parts.map((p) =>
        p.id === selectedPartId ? { ...p, pivotX: pt.x - p.x, pivotY: pt.y - p.y } : p
      );
      commitRig({ ...activeRig, parts: updatedParts });
      setPlacingPivot(false);
      soundEngine.click(1.1);
      notify(t('puppetJointUpdated'));
      return;
    }

    safeSetPointerCapture(e.currentTarget, e.pointerId);
    setDrawingLasso(true);
    setLassoPts([pt]);
  };

  const handleCutPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingLasso) return;
    const pt = getCutCanvasCoords(e);
    setLassoPts((prev) => {
      const last = prev[prev.length - 1];
      if (!last || Math.hypot(pt.x - last.x, pt.y - last.y) > 4) {
        return [...prev, pt];
      }
      return prev;
    });
  };

  const handleCutPointerUp = async () => {
    if (!drawingLasso || !activeRig || !sourceCanvasRef.current) return;
    setDrawingLasso(false);

    if (lassoPts.length >= 4) {
      const cut = extractLassoCutout(sourceCanvasRef.current, lassoPts);
      if (cut) {
        const blob = await canvasToPngBlob(cut.canvas);
        const blobKey = await saveBlob(blob);
        const rootPart = activeRig.parts.find((p) => p.parentId === null);
        const newPart: PuppetPart = {
          id: makeId('prt'),
          name: partNameDraft.trim() || `${t('puppetPartPrefix')} ${activeRig.parts.length + 1}`,
          parentId: activeRig.parts.length === 0 ? null : rootPart?.id ?? null,
          blobKey,
          x: cut.x,
          y: cut.y,
          w: cut.w,
          h: cut.h,
          pivotX: cut.w / 2,
          pivotY: cut.h / 2,
          zIndex: activeRig.parts.length + 1,
          mouthSlot: null,
        };
        const updated: PuppetRig = {
          ...activeRig,
          parts: [...activeRig.parts, newPart],
          keyframes: activeRig.keyframes.map((kf) => ({
            ...kf,
            transforms: { ...kf.transforms, [newPart.id]: { ...IDENTITY_TRANSFORM } },
          })),
        };
        commitRig(updated);
        setSelectedPartId(newPart.id);
        const baseSuggestions = ['Gövde', 'Baş', 'Sağ Kol', 'Sol Kol', 'Sağ Bacak', 'Sol Bacak', 'Kuyruk'];
        setPartNameDraft(localizePinOrPartLabel(baseSuggestions[(activeRig.parts.length + 1) % baseSuggestions.length], locale));
        soundEngine.shutter();
        notify(tf('puppetPartCutToast', { name: localizePinOrPartLabel(newPart.name, locale) }));
      }
    }
    setLassoPts([]);
  };

  const applyMotionPreset = (presetId: RigPresetId) => {
    if (!activeRig || activeRig.parts.length === 0) return;
    const keyframes = generateMotionPresetKeyframes(activeRig, presetId);
    commitRig({ ...activeRig, keyframes });
    setPlaying(true);
    soundEngine.click(1.1);
  };

  const handleDeleteKeyframe = (kfId: string) => {
    if (!activeRig || activeRig.keyframes.length <= 1) return;
    commitRig({
      ...activeRig,
      keyframes: activeRig.keyframes.filter((k) => k.id !== kfId),
    });
    soundEngine.click(0.92);
  };

  // Fast Single-Canvas Send to Draw + Direct GIF/Video/PNG Exports for Cutout Mode!
  const handleSendCutoutToDraw = async () => {
    if (!activeRig || !project || activeRig.parts.length === 0 || exportingKind) return;
    setPlaying(false);
    setExportingKind('draw');
    setExportPct(5);
    try {
      const preRendered: ImageBitmap[] = [];
      const work = document.createElement('canvas');
      work.width = project.width;
      work.height = project.height;
      const wctx = work.getContext('2d')!;
      for (let f = 0; f < activeRig.totalFrames; f++) {
        await renderPuppetFrame(wctx, activeRig, f, project.width, project.height, {
          audio: project.audio,
          showSkeleton: false,
        });
        preRendered.push(await createImageBitmap(work));
        setExportPct(Math.round(((f + 1) / activeRig.totalFrames) * 45));
      }
      const added = await bakeRenderedShotToFrames(
        preRendered.length,
        (ctx, idx, w, h) => ctx.drawImage(preRendered[idx], 0, 0, w, h),
        {
          replace: false,
          notePrefix: t('puppetNotePrefix'),
          layerName: t('puppetLayerSceneName'),
          topLayerName: t('filmLayerTopEffects'),
          onProgress: (done, total) => {
            setExportPct(45 + Math.round((done / total) * 55));
            setExportLabel(`${t('puppetSendingToDraw')}… ${done}/${total}`);
          },
        }
      );
      preRendered.forEach((b) => b.close());
      setPuppetExportOpen(false);
      soundEngine.clapperSnap();
      notify(tf('puppetFramesSentDraw', { count: added }));
    } finally {
      setExportingKind(null);
      setExportPct(0);
    }
  };

  const handleExportCutoutGif = async () => {
    if (!activeRig || !project || activeRig.parts.length === 0 || exportingKind) return;
    setPlaying(false);
    exportAbortRef.current = false;
    setExportingKind('gif');
    setExportPct(5);
    try {
      const W = 540;
      const H = 304;
      const off = document.createElement('canvas');
      off.width = W;
      off.height = H;
      const ctx = off.getContext('2d', { willReadFrequently: true })!;
      const frames: { rgba: Uint8ClampedArray; hold: number }[] = [];
      for (let f = 0; f < activeRig.totalFrames; f++) {
        if (exportAbortRef.current) return;
        await renderPuppetFrame(ctx, activeRig, f, W, H, {
          audio: project.audio,
          showSkeleton: false,
          paperColor: project.paperColor,
        });
        frames.push({ rgba: new Uint8ClampedArray(ctx.getImageData(0, 0, W, H).data), hold: 1 });
        setExportPct(5 + Math.round(((f + 1) / activeRig.totalFrames) * 70));
        await new Promise<void>((r) => setTimeout(r, 0));
      }
      if (exportAbortRef.current) return;
      const gifBlob = await runGifEncode({
        width: W,
        height: H,
        delayCs: Math.max(3, Math.round(100 / project.fps)),
        frames,
      });
      const safe = activeRig.name.replace(/[^a-zA-Z0-9ğüşıöçĞÜŞİÖÇ_-]/g, '_').slice(0, 32) || 'kukla';
      triggerDownload(gifBlob, `${safe}.gif`);
      soundEngine.clapperSnap();
      notify(t('puppetGifDownloaded'));
      setPuppetExportOpen(false);
    } finally {
      setExportingKind(null);
      setExportPct(0);
    }
  };

  const handleExportCutoutVideo = async () => {
    if (!activeRig || !project || activeRig.parts.length === 0 || exportingKind) return;
    setPlaying(false);
    exportAbortRef.current = false;
    setExportingKind('video');
    setExportPct(5);
    const exportPlayer = new StudioAudioPlayer();
    try {
      const W = 1280;
      const H = 720;
      const off = document.createElement('canvas');
      off.width = W;
      off.height = H;
      const ctx = off.getContext('2d', { alpha: false })!;
      const totalSteps = activeRig.totalFrames * 2;
      let offlineAudio: AudioBuffer | null = null;
      if (project.audio && !project.audio.muted && project.audio.volume > 0.001) {
        await exportPlayer.ensureLoaded(project.audio);
        const rawBuf = exportPlayer.getDecodedBuffer();
        if (rawBuf) {
          offlineAudio = await renderAudioTrackOffline({
            sourceBuffer: rawBuf,
            durationSec: totalSteps / project.fps,
            volume: project.audio.volume,
            voiceEffect: project.audio.voiceEffect ?? 'natural',
            loop: true,
          }).catch(() => rawBuf);
        }
      }

      if (typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined') {
        const mp4Blob = await encodeFramesToMp4WebCodecs({
          width: W,
          height: H,
          fps: project.fps,
          totalFrames: totalSteps,
          audioBuffer: offlineAudio,
          audioVolume: 1,
          shouldAbort: () => exportAbortRef.current,
          onProgress: (done, total) => setExportPct(Math.min(96, Math.round((done / Math.max(1, total)) * 90) + 5)),
          drawFrame: async (wctx, i) => {
            await renderPuppetFrame(wctx, activeRig, i % activeRig.totalFrames, W, H, {
              audio: project.audio,
              showSkeleton: false,
              paperColor: project.paperColor,
            });
            if (i >= totalSteps - Math.round(project.fps * 0.4)) drawKagitSealStamp(wctx, W, H, 0.85);
          },
        });
        if (mp4Blob) {
          const safe = activeRig.name.replace(/[^a-zA-Z0-9ğüşıöçĞÜŞİÖÇ_-]/g, '_').slice(0, 32) || 'kukla';
          triggerDownload(mp4Blob, `${safe}.mp4`);
          soundEngine.clapperSnap();
          notify(t('puppetMp4Downloaded'));
          setPuppetExportOpen(false);
          return;
        }
      }
      const chosen = pickBestMediaRecorderFormat(Boolean(project.audio && !project.audio.muted));
      if (!chosen || typeof off.captureStream !== 'function') {
        notify(t('exportWebViewFallbackToast'), 'info');
        return;
      }
      const mime = chosen.mime;
      const tracks = [...off.captureStream(project.fps).getVideoTracks()];
      let startSilent: (() => void) | null = null;
      if (project.audio && !project.audio.muted) {
        await exportPlayer.ensureLoaded(project.audio);
        const att = exportPlayer.attachSilentExportStream(project.audio.volume);
        if (att) {
          tracks.push(...att.stream.getAudioTracks());
          startSilent = att.start;
        }
      }
      const recorder = new MediaRecorder(new MediaStream(tracks), { mimeType: mime, videoBitsPerSecond: 5_000_000 });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunks.push(ev.data);
      };
      const stepMs = Math.round(1000 / Math.max(8, project.fps));
      recorder.start();
      startSilent?.();
      for (let i = 0; i < totalSteps; i++) {
        if (exportAbortRef.current) break;
        await renderPuppetFrame(ctx, activeRig, i % activeRig.totalFrames, W, H, {
          audio: project.audio,
          showSkeleton: false,
          paperColor: project.paperColor,
        });
        if (i >= totalSteps - Math.round(project.fps * 0.4)) drawKagitSealStamp(ctx, W, H, 0.85);
        setExportPct(Math.min(95, Math.round(((i + 1) / totalSteps) * 90) + 5));
        await new Promise((r) => setTimeout(r, stepMs));
      }
      exportPlayer.stop();
      const stopped = new Promise<void>((res) => {
        recorder.onstop = () => res();
      });
      if (recorder.state !== 'inactive') recorder.stop();
      await stopped;
      if (exportAbortRef.current) return;
      const ext = mime.includes('mp4') ? 'mp4' : 'webm';
      const safe = activeRig.name.replace(/[^a-zA-Z0-9ğüşıöçĞÜŞİÖÇ_-]/g, '_').slice(0, 32) || 'kukla';
      triggerDownload(new Blob(chunks, { type: mime }), `${safe}.${ext}`);
      soundEngine.clapperSnap();
      notify(t('puppetVideoDownloaded'));
      setPuppetExportOpen(false);
    } finally {
      exportPlayer.dispose();
      setExportingKind(null);
      setExportPct(0);
    }
  };

  const handleDownloadCutoutPng = async () => {
    if (!activeRig || !project) return;
    const c = document.createElement('canvas');
    c.width = project.width;
    c.height = project.height;
    const ctx = c.getContext('2d')!;
    await renderPuppetFrame(ctx, activeRig, rigFrame, project.width, project.height, {
      audio: project.audio,
      showSkeleton: false,
      paperColor: project.paperColor,
    });
    const blob = await canvasToPngBlob(c);
    const safe = activeRig.name.replace(/[^a-zA-Z0-9ğüşıöçĞÜŞİÖÇ_-]/g, '_').slice(0, 32) || 'kukla';
    triggerDownload(blob, `${safe}_kare${rigFrame + 1}.png`);
    soundEngine.shutter();
    notify(t('puppetPngDownloaded'));
  };

  const toggleMicRecord = async () => {
    if (!project) return;
    if (recording && recorderRef.current) {
      try {
        const blob = await recorderRef.current.stop();
        setRecording(false);
        const { pcm } = await decodeAudioBlobToMonoPCM(blob);
        let peak = 0;
        let sumSq = 0;
        for (let i = 0; i < pcm.length; i++) {
          const v = Math.abs(pcm[i]);
          if (v > peak) peak = v;
          sumSq += pcm[i] * pcm[i];
        }
        const rms = pcm.length > 0 ? Math.sqrt(sumSq / pcm.length) : 0;
        if (pcm.length === 0 || peak < 0.015 || rms < 0.003 || isAudioBufferSilent(pcm)) {
          notify(t('micSilentWarning' as TranslationKey), 'error');
          return;
        }
        const track = await analyzeAndStoreAudio(
          blob,
          t('puppetVoiceTrackLabel'),
          project.fps
        );
        setAudioTrack(track);
        notify(t('puppetVoiceLipReady'));
      } catch {
        setRecording(false);
        recorderRef.current?.cleanup();
      }
      return;
    }
    try {
      const rec = new MicVoiceRecorder();
      await rec.start();
      recorderRef.current = rec;
      setRecording(true);
    } catch {
      notify(t('puppetMicDeniedErr'), 'error');
    }
  };

  // Keyboard shortcuts for Cutout mode
  useEffect(() => {
    if (engineTab !== 'cutout') return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inInput =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);

      if (e.key === 'Escape') {
        if (puppetExportOpen && !exportingKind) {
          setPuppetExportOpen(false);
          return;
        }
        if (placingPivot) {
          setPlacingPivot(false);
          return;
        }
      }
      if (inInput) return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        handleRedo();
        return;
      }
      if (e.code === 'Space' && subMode === 'animate' && activeRigRef.current) {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key === 'ArrowLeft' && subMode === 'animate' && activeRigRef.current) {
        e.preventDefault();
        setPlaying(false);
        const total = activeRigRef.current.totalFrames;
        setRigFrame((f) => (f - 1 + total) % total);
      } else if (e.key === 'ArrowRight' && subMode === 'animate' && activeRigRef.current) {
        e.preventDefault();
        setPlaying(false);
        const total = activeRigRef.current.totalFrames;
        setRigFrame((f) => (f + 1) % total);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    engineTab,
    exportingKind,
    handleRedo,
    handleUndo,
    placingPivot,
    puppetExportOpen,
    setPuppetExportOpen,
    subMode,
  ]);

  if (!project) return null;

  const selectedPart = activeRig?.parts.find((p) => p.id === selectedPartId) ?? null;
  const curTransforms = activeRig ? interpolateRigTransforms(activeRig, rigFrame) : {};
  const selTransform = selectedPartId
    ? curTransforms[selectedPartId] ?? IDENTITY_TRANSFORM
    : IDENTITY_TRANSFORM;

  const currentRms =
    project.audio && !project.audio.muted && project.audio.rmsPerFrame.length > 0
      ? project.audio.rmsPerFrame[rigFrame % project.audio.rmsPerFrame.length]
      : 0;
  const currentViseme = rmsToMouthViseme(currentRms);
  const visemeHumanLabel =
    currentViseme === 'closed'
      ? t('puppetCutMouthStateClosed')
      : currentViseme === 'half'
        ? t('puppetCutMouthStateHalf')
        : currentViseme === 'round'
          ? t('puppetCutMouthStateRound')
          : t('puppetCutMouthStateWide');

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden desk-surface-mat select-none">
      {/* Calm 2-Pill Studio Sub-Header */}
      <div className="px-4 py-1.5 border-b border-desk-border bg-desk-surface/95 flex flex-wrap items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-1 p-1 rounded-xl console-well border border-desk-border">
          <button
            type="button"
            onClick={() => {
              setPlaying(false);
              setEngineTab('mesh');
            }}
            className={`px-3 py-1 rounded-lg text-xs font-bold inline-flex items-center gap-1.5 transition-all ${
              engineTab === 'mesh'
                ? 'bg-desk-panel text-desk-text border border-ink-brass shadow-sm'
                : 'text-desk-muted hover:text-desk-text border border-transparent'
            }`}
          >
            <span className="hardware-led" data-on={engineTab === 'mesh' ? 'amber' : undefined} />
            {t('puppetTabFlex')}
          </button>
          <button
            type="button"
            onClick={() => {
              setPlaying(false);
              setEngineTab('cutout');
            }}
            className={`px-3 py-1 rounded-lg text-xs font-bold inline-flex items-center gap-1.5 transition-all ${
              engineTab === 'cutout'
                ? 'bg-desk-panel text-desk-text border border-desk-border shadow-sm'
                : 'text-desk-muted hover:text-desk-text border border-transparent'
            }`}
          >
            <JointBoneIcon className="w-3.5 h-3.5" />
            {t('puppetTabCutout')}
          </button>
        </div>

        <span className="font-mono text-[11px] text-desk-muted hidden md:inline">
          {engineTab === 'mesh' ? t('puppetHintFlex') : t('puppetHintCutout')}
        </span>
      </div>

      {engineTab === 'mesh' ? (
        <MeshWarpStage />
      ) : (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden p-3 gap-2.5">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={handleUploadSource}
          />

          {!activeRig ? (
            /* Clean Single Focused Empty Card (NO Duplicate Top Toolbar Buttons!) */
            <div className="flex-1 flex items-center justify-center p-4">
              <div className="rounded-3xl bg-desk-surface border border-desk-border p-10 text-center max-w-xl w-full space-y-4 shadow-xl">
                <JointBoneIcon className="w-11 h-11 text-ink-brass mx-auto" />
                <h2 className="text-xl font-extrabold text-desk-text">
                  {t('puppetCutoutEmptyTitle')}
                </h2>
                <p className="text-sm text-desk-muted leading-relaxed">
                  {t('puppetCutoutEmptyDesc')}
                </p>
                <div className="flex flex-wrap justify-center gap-2.5 pt-2">
                  <KeycapButton
                    size="md"
                    variant="vermilion"
                    onClick={() => void handleLoadSampleCutout()}
                  >
                    <Sparkles className="w-4 h-4" />
                    {t('puppetTrySample')}
                  </KeycapButton>
                  <KeycapButton
                    size="md"
                    variant="ivory"
                    onClick={() => void handleLoadFromCurrentFrame()}
                  >
                    <Layers className="w-4 h-4" />
                    {t('puppetFromMyArt')}
                  </KeycapButton>
                  <KeycapButton
                    size="md"
                    variant="brass"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Upload className="w-4 h-4" />
                    {t('puppetUploadArt')}
                  </KeycapButton>
                </div>
              </div>
            </div>
          ) : (
            <>
              {/* Compact Top Cutout Toolbar */}
              <div className="flex flex-wrap items-center justify-between gap-2 shrink-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <KeycapButton
                    size="sm"
                    variant="brass"
                    onClick={() => void handleLoadSampleCutout()}
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    {t('puppetTrySample')}
                  </KeycapButton>
                  <KeycapButton
                    size="sm"
                    variant="ivory"
                    onClick={() => void handleLoadFromCurrentFrame()}
                  >
                    <Plus className="w-3.5 h-3.5" />
                    {t('puppetBtnMyArt')}
                  </KeycapButton>
                  <KeycapButton size="sm" onClick={() => fileInputRef.current?.click()}>
                    <Upload className="w-3.5 h-3.5" />
                    {t('puppetBtnUpload')}
                  </KeycapButton>
                  {project.rigs.length > 0 && (
                    <select
                      value={activeRig.id}
                      onChange={(e) => {
                        setActiveRigId(e.target.value);
                        setSelectedPartId(null);
                        setConfirmDeleteRig(false);
                      }}
                      className="px-2.5 py-1.5 rounded-lg console-well border border-desk-border text-xs text-desk-text font-bold"
                    >
                      {project.rigs.map((r) => (
                        <option key={r.id} value={r.id}>
                          {localizeActorName(r.name, locale)} ({r.parts.length})
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    type="button"
                    disabled={histCounts.past === 0}
                    onClick={handleUndo}
                    title={t('puppetUndoTitle')}
                    className="p-1.5 rounded-lg console-well border border-desk-border text-desk-muted hover:text-desk-text disabled:opacity-35"
                  >
                    <Undo2 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={histCounts.future === 0}
                    onClick={handleRedo}
                    title={t('puppetRedoTitle')}
                    className="p-1.5 rounded-lg console-well border border-desk-border text-desk-muted hover:text-desk-text disabled:opacity-35"
                  >
                    <Redo2 className="w-3.5 h-3.5" />
                  </button>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  <div className="flex gap-1 p-1 rounded-xl console-well border border-desk-border">
                    <KeycapButton
                      size="sm"
                      variant={subMode === 'cut' ? 'brass' : 'graphite'}
                      pressed={subMode === 'cut'}
                      led={subMode === 'cut' ? 'amber' : 'off'}
                      onClick={() => {
                        setPlaying(false);
                        setSubMode('cut');
                      }}
                    >
                      <Lasso className="w-3.5 h-3.5" />
                      {t('puppetCutStep1')}
                    </KeycapButton>
                    <KeycapButton
                      size="sm"
                      variant={subMode === 'animate' ? 'ivory' : 'graphite'}
                      pressed={subMode === 'animate'}
                      led={subMode === 'animate' ? 'emerald' : 'off'}
                      onClick={() => setSubMode('animate')}
                    >
                      <JointBoneIcon className="w-3.5 h-3.5" />
                      {t('puppetCutStep2')}
                    </KeycapButton>
                  </div>

                  <button
                    type="button"
                    disabled={activeRig.parts.length === 0 || Boolean(exportingKind)}
                    onClick={() => void handleSendCutoutToDraw()}
                    className="px-2.5 py-1.5 rounded-xl console-well border border-desk-border hover:border-ink-brass text-[11px] font-bold text-desk-text inline-flex items-center gap-1.5 disabled:opacity-45"
                  >
                    <Film className="w-3.5 h-3.5 text-ink-brass" />
                    {exportingKind === 'draw' ? exportLabel || `${t('puppetSendingToDraw')}…` : t('puppetSendToDraw')}
                  </button>

                  <KeycapButton
                    size="sm"
                    variant="brass"
                    disabled={activeRig.parts.length === 0 || Boolean(exportingKind)}
                    onClick={() => setPuppetExportOpen(true)}
                  >
                    <Download className="w-3.5 h-3.5" />
                    {t('puppetDownloadBtn')}
                  </KeycapButton>
                </div>
              </div>

              {/* Main 2-Column Cutout Workspace — Fits Strictly Inside 1280x800 (ZERO Bottom Clip!) */}
              <div className="flex-1 min-h-0 flex flex-col lg:flex-row gap-3 overflow-y-auto lg:overflow-hidden">
                <div className="shrink-0 min-h-[268px] sm:min-h-[340px] lg:shrink lg:min-h-0 lg:flex-1 min-w-0 rounded-2xl bg-desk-surface border border-desk-border p-3 shadow-xl flex flex-col gap-2 overflow-hidden">
                  {subMode === 'cut' ? (
                    <>
                      <div className="flex flex-wrap items-center justify-between gap-2 shrink-0">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[11px] font-bold uppercase text-desk-muted">
                            {t('puppetCutPartName')}:
                          </span>
                          <input
                            type="text"
                            value={partNameDraft}
                            onChange={(e) => setPartNameDraft(e.target.value)}
                            className="px-2.5 py-1 rounded-lg console-well border border-desk-border text-xs text-desk-text w-32 select-text"
                          />
                        </div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <KeycapButton
                            size="sm"
                            variant="vermilion"
                            disabled={autoSplitting}
                            onClick={() => void handleAutoCutParts()}
                          >
                            <Sparkles className="w-3.5 h-3.5" />
                            {autoSplitting ? t('puppetCutAutoSplitting') : t('puppetCutAutoSplit')}
                          </KeycapButton>
                          <KeycapButton
                            size="sm"
                            variant={placingPivot ? 'brass' : 'graphite'}
                            pressed={placingPivot}
                            led={placingPivot ? 'amber' : 'off'}
                            disabled={!selectedPartId}
                            onClick={() => setPlacingPivot((v) => !v)}
                          >
                            <Crosshair className="w-3.5 h-3.5" />
                            {placingPivot ? t('puppetCutClickJoint') : t('puppetCutMoveJoint')}
                          </KeycapButton>
                        </div>
                      </div>

                      <div className="flex-1 min-h-0 rounded-xl overflow-hidden console-well border border-desk-border flex items-center justify-center p-2">
                        <canvas
                          ref={cutCanvasRef}
                          onPointerDown={handleCutPointerDown}
                          onPointerMove={handleCutPointerMove}
                          onPointerUp={() => void handleCutPointerUp()}
                          className={`max-w-full max-h-full object-contain rounded-lg touch-none ${
                            placingPivot ? 'cursor-crosshair' : 'cursor-cell'
                          }`}
                        />
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="flex-1 min-h-0 rounded-xl overflow-hidden console-well border border-desk-border flex items-center justify-center p-1.5">
                        <canvas
                          ref={stageCanvasRef}
                          onPointerDown={handleStagePointerDown}
                          onPointerMove={handleStagePointerMove}
                          onPointerUp={handleStagePointerUp}
                          onPointerCancel={handleStagePointerUp}
                          className="max-w-full max-h-full object-contain rounded-lg cursor-grab active:cursor-grabbing touch-none"
                        />
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-1.5 font-mono text-[11px] text-desk-muted px-0.5 shrink-0">
                        <span className="truncate">{t('puppetCutStageTip')}</span>
                        <div className="flex items-center gap-1">
                          <span>{t('puppetCutQuickLoop')}:</span>
                          {motionPresets.map((pr) => (
                            <button
                              key={pr.id}
                              type="button"
                              onClick={() => applyMotionPreset(pr.id)}
                              className="px-2 py-0.5 rounded bg-desk-panel border border-desk-border hover:border-ink-brass text-desk-text font-bold"
                            >
                              {pr.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Compact Keyframe Transport — Fits Cleanly Above y:790px at 1280x800! */}
                      <div className="rounded-xl console-well border border-desk-border px-3 py-2 space-y-1.5 shrink-0">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <KeycapButton
                              size="sm"
                              variant="vermilion"
                              pressed={playing}
                              led={playing ? 'emerald' : 'off'}
                              ledPulse={playing}
                              onClick={() => setPlaying((p) => !p)}
                            >
                              <MotionPlayIcon playing={playing} className="w-3.5 h-3.5" />
                              {playing ? t('puppetStop') : t('puppetPlay')}
                            </KeycapButton>
                            <span
                              ref={frameReadoutRef}
                              className="font-mono text-xs text-desk-text tabular-nums"
                            >
                              {rigFrame + 1} / {activeRig.totalFrames}
                            </span>
                          </div>

                          <input
                            ref={timelineRangeRef}
                            type="range"
                            min={0}
                            max={Math.max(1, activeRig.totalFrames - 1)}
                            value={rigFrame}
                            onChange={(e) => {
                              setPlaying(false);
                              setRigFrame(Number(e.target.value));
                            }}
                            className="studio-fader flex-1 min-w-[120px]"
                          />

                          <div className="flex items-center gap-1.5">
                            <KeycapButton
                              size="sm"
                              variant={recording ? 'vermilion' : 'graphite'}
                              led={recording ? 'vermilion' : project.audio ? 'emerald' : 'off'}
                              ledPulse={recording}
                              onClick={() => void toggleMicRecord()}
                            >
                              {recording ? <Square className="w-3 h-3 fill-current" /> : <Mic className="w-3.5 h-3.5" />}
                              {recording ? t('puppetVoiceMicStop') : t('puppetVoiceMicBtn')}
                            </KeycapButton>
                            {project.audio && !project.audio.muted && (
                              <span className="font-mono text-[11px] px-2 py-1 rounded bg-desk-panel border border-desk-border text-ink-brass">
                                {t('puppetCutVoiceActive')} · {visemeHumanLabel}
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-mono text-[11px] text-desk-muted">
                            {t('puppetCutKeyframes')}:
                          </span>
                          {activeRig.keyframes.map((kf) => (
                            <span
                              key={kf.id}
                              className={`inline-flex items-center rounded font-mono text-[11px] border overflow-hidden ${
                                kf.frame === rigFrame
                                  ? 'bg-ink-brass text-[#1c1405] border-ink-brass font-bold'
                                  : 'bg-desk-surface border-desk-border text-desk-muted'
                              }`}
                            >
                              <button
                                type="button"
                                onClick={() => {
                                  setPlaying(false);
                                  setRigFrame(kf.frame);
                                }}
                                className="px-2 py-0.5 hover:opacity-80"
                              >
                                #{kf.frame + 1}
                              </button>
                              {activeRig.keyframes.length > 1 && (
                                <button
                                  type="button"
                                  onClick={() => handleDeleteKeyframe(kf.id)}
                                  className="px-1 py-0.5 hover:bg-black/20"
                                  title={t('puppetDeleteTitle')}
                                >
                                  ×
                                </button>
                              )}
                            </span>
                          ))}
                        </div>
                      </div>
                    </>
                  )}
                </div>

                {/* Right Bone Tree & Part Inspector */}
                <aside className="w-full lg:w-[316px] shrink-0 rounded-2xl bg-desk-surface border border-desk-border p-3 shadow-xl flex flex-col gap-3 overflow-y-auto">
                  <div className="flex items-center justify-between border-b border-desk-border pb-2 shrink-0">
                    <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-desk-muted">
                      {t('puppetCutTreeTitle')} ({activeRig.parts.length})
                    </span>
                    {!confirmDeleteRig ? (
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteRig(true)}
                        className="text-desk-muted hover:text-ink-vermilion"
                        title={t('puppetDeleteTitle')}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    ) : (
                      <div className="flex items-center gap-1 font-mono text-[11px]">
                        <span className="text-ink-vermilion">{t('puppetDeleteConfirm')}</span>
                        <button
                          type="button"
                          onClick={() => {
                            deleteRig(activeRig.id);
                            setActiveRigId(null);
                            setConfirmDeleteRig(false);
                          }}
                          className="px-1.5 py-0.5 rounded bg-ink-vermilion text-white font-bold"
                        >
                          {t('puppetDeleteYes')}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteRig(false)}
                          className="px-1.5 py-0.5 rounded bg-desk-panel text-desk-muted"
                        >
                          {t('puppetDeleteNo')}
                        </button>
                      </div>
                    )}
                  </div>

                  {activeRig.parts.length === 0 ? (
                    <p className="text-xs text-desk-muted py-4 text-center leading-relaxed">
                      {t('puppetCutTreeEmpty')}
                    </p>
                  ) : (
                    <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                      {activeRig.parts.map((part) => {
                        const isSel = part.id === selectedPartId;
                        const parentName = activeRig.parts.find((p) => p.id === part.parentId)?.name;
                        return (
                          <div
                            key={part.id}
                            onClick={() => setSelectedPartId(part.id)}
                            className={`p-2 rounded-xl border cursor-pointer flex items-center justify-between gap-2 ${
                              isSel
                                ? 'bg-desk-panel border-ink-vermilion'
                                : 'console-well border-desk-border hover:border-desk-muted'
                            }`}
                          >
                            <div className="min-w-0">
                              <div className="text-xs font-bold text-desk-text truncate flex items-center gap-1.5">
                                <span
                                  className="hardware-led"
                                  data-on={isSel ? 'vermilion' : undefined}
                                />
                                {localizePinOrPartLabel(part.name, locale)}
                              </div>
                              <div className="font-mono text-[11px] text-desk-muted">
                                {parentName ? `↳ ${localizePinOrPartLabel(parentName, locale)}` : t('puppetCutRootBone')}
                              </div>
                            </div>

                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                commitRig({
                                  ...activeRig,
                                  parts: activeRig.parts
                                    .filter((p) => p.id !== part.id)
                                    .map((p) =>
                                      p.parentId === part.id ? { ...p, parentId: null } : p
                                    ),
                                });
                                if (selectedPartId === part.id) setSelectedPartId(null);
                              }}
                              className="text-desk-muted hover:text-ink-vermilion"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {selectedPart && (
                    <div className="pt-2.5 border-t border-desk-border space-y-2.5">
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block font-mono text-[11px] text-desk-muted mb-1">
                            {t('puppetCutParentLabel')}
                          </label>
                          <select
                            value={selectedPart.parentId ?? ''}
                            onChange={(e) => {
                              const candidate = e.target.value || null;
                              // FIXED: mathematically blocks circular bone hierarchies (A -> B -> A)!
                              if (wouldCreateBoneCycle(activeRig.parts, selectedPart.id, candidate)) {
                                return;
                              }
                              commitRig({
                                ...activeRig,
                                parts: activeRig.parts.map((p) =>
                                  p.id === selectedPart.id ? { ...p, parentId: candidate } : p
                                ),
                              });
                            }}
                            className="w-full px-2 py-1.5 rounded-lg console-well border border-desk-border text-xs text-desk-text"
                          >
                            <option value="">{t('puppetCutRootOption')}</option>
                            {activeRig.parts
                              .filter((p) => !wouldCreateBoneCycle(activeRig.parts, selectedPart.id, p.id))
                              .map((p) => (
                                <option key={p.id} value={p.id}>
                                  {localizePinOrPartLabel(p.name, locale)}
                                </option>
                              ))}
                          </select>
                        </div>

                        <div>
                          <label className="block font-mono text-[11px] text-desk-muted mb-1">
                            {t('puppetCutMouthLabel')}
                          </label>
                          <select
                            value={selectedPart.mouthSlot ?? ''}
                            onChange={(e) => {
                              const val = (e.target.value || null) as PuppetPart['mouthSlot'];
                              commitRig({
                                ...activeRig,
                                parts: activeRig.parts.map((p) =>
                                  p.id === selectedPart.id ? { ...p, mouthSlot: val } : p
                                ),
                              });
                            }}
                            className="w-full px-2 py-1.5 rounded-lg console-well border border-desk-border text-xs text-desk-text"
                          >
                            {mouthSlots.map((m) => (
                              <option key={m.label} value={m.id ?? ''}>
                                {m.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>

                      {subMode === 'animate' && (
                        <div className="rounded-xl console-well border border-desk-border p-2.5 space-y-2">
                          <div>
                            <div className="flex justify-between font-mono text-[11px] text-desk-muted mb-0.5">
                              <span>{t('puppetCutAngle')}</span>
                              <span className="text-desk-text font-bold">{Math.round(selTransform.rotation)}°</span>
                            </div>
                            <input
                              type="range"
                              min={-150}
                              max={150}
                              value={selTransform.rotation}
                              onChange={(e) =>
                                updatePartTransform(selectedPart.id, { rotation: Number(e.target.value) }, false)
                              }
                              className="studio-fader w-full"
                            />
                          </div>

                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <div className="flex justify-between font-mono text-[11px] text-desk-muted mb-0.5">
                                <span>{t('puppetCutStretchX')}</span>
                                <span>{selTransform.scaleX.toFixed(2)}</span>
                              </div>
                              <input
                                type="range"
                                min={0.6}
                                max={1.5}
                                step={0.05}
                                value={selTransform.scaleX}
                                onChange={(e) =>
                                  updatePartTransform(selectedPart.id, { scaleX: Number(e.target.value) }, false)
                                }
                                className="studio-fader w-full"
                              />
                            </div>
                            <div>
                              <div className="flex justify-between font-mono text-[11px] text-desk-muted mb-0.5">
                                <span>{t('puppetCutStretchY')}</span>
                                <span>{selTransform.scaleY.toFixed(2)}</span>
                              </div>
                              <input
                                type="range"
                                min={0.6}
                                max={1.5}
                                step={0.05}
                                value={selTransform.scaleY}
                                onChange={(e) =>
                                  updatePartTransform(selectedPart.id, { scaleY: Number(e.target.value) }, false)
                                }
                                className="studio-fader w-full"
                              />
                            </div>
                          </div>

                          <div>
                            <span className="block font-mono text-[11px] text-desk-muted mb-1">
                              {t('puppetCutCurve')}
                            </span>
                            <div className="flex flex-wrap gap-1">
                              {easingOptions.map((ec) => (
                                <button
                                  key={ec.id}
                                  type="button"
                                  onClick={() => setEasing(ec.id)}
                                  className={`px-2 py-0.5 rounded font-mono text-[11px] border ${
                                    easing === ec.id
                                      ? 'border-ink-brass bg-ink-brass/20 text-desk-text font-bold'
                                      : 'border-desk-border text-desk-muted'
                                  }`}
                                >
                                  {ec.label}
                                </button>
                              ))}
                            </div>
                          </div>

                          <KeycapButton
                            size="sm"
                            variant="brass"
                            onClick={() => updatePartTransform(selectedPart.id, {}, true)}
                            className="w-full"
                          >
                            <Check className="w-3.5 h-3.5" />
                            #{rigFrame + 1} · {t('puppetCutSaveKey')}
                          </KeycapButton>
                        </div>
                      )}
                    </div>
                  )}
                </aside>
              </div>
            </>
          )}

          {/* Unified Export Modal for Cutout Puppet Mode too! */}
          {puppetExportOpen && activeRig && (
            <div
              onClick={() => !exportingKind && setPuppetExportOpen(false)}
              className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
            >
              <div
                ref={cutoutExportDialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="cutout-puppet-export-title"
                onClick={(e) => e.stopPropagation()}
                className="w-full max-w-2xl max-h-[calc(100dvh-1.5rem)] flex flex-col overflow-y-auto rounded-3xl bg-desk-surface border border-desk-border shadow-2xl"
              >
                <div className="px-5 py-4 border-b border-desk-border flex items-center justify-between shrink-0">
                  <div>
                    <h2 id="cutout-puppet-export-title" className="text-base font-extrabold text-desk-text">{t('puppetExportTitle')}</h2>
                    <p className="font-mono text-[11px] text-desk-muted mt-0.5">
                      {localizeActorName(activeRig.name, locale)} · {activeRig.parts.length} · {activeRig.totalFrames} · {t('puppetExportSub')}
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label={t('exportCloseAria')}
                    disabled={Boolean(exportingKind)}
                    onClick={() => setPuppetExportOpen(false)}
                    className="min-w-[44px] min-h-[44px] p-2 rounded-xl inline-flex items-center justify-center console-well border border-desk-border text-desk-muted hover:text-desk-text disabled:opacity-40"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {exportingKind && (
                  <div className="px-5 py-3 bg-desk-well/80 border-b border-desk-border space-y-2">
                    <div className="flex items-center justify-between font-mono text-xs">
                      <span className="text-desk-text font-bold">{exportLabel || t('filmExportPreparing')}</span>
                      <span className="text-ink-brass font-bold">{exportPct}%</span>
                    </div>
                    <div className="h-2 rounded-full bg-black/40 overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-ink-vermilion to-ink-brass transition-all duration-150"
                        style={{ width: `${exportPct}%` }}
                      />
                    </div>
                  </div>
                )}

                <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="p-4 rounded-2xl console-well border border-ink-vermilion/40 flex flex-col justify-between gap-3">
                    <div className="space-y-1">
                      <div className="font-bold text-sm text-desk-text flex items-center gap-2">
                        <Film className="w-4 h-4 text-ink-vermilion" />
                        {t('puppetExportVideoTitle')}
                      </div>
                      <p className="text-[11px] text-desk-muted leading-snug">{t('puppetExportVideoDesc')}</p>
                    </div>
                    <KeycapButton
                      size="sm"
                      variant="vermilion"
                      className="w-full"
                      disabled={activeRig.parts.length === 0 || Boolean(exportingKind)}
                      onClick={() => void handleExportCutoutVideo()}
                    >
                      <Download className="w-3.5 h-3.5" />
                      {t('puppetExportVideoBtn')}
                    </KeycapButton>
                  </div>

                  <div className="p-4 rounded-2xl console-well border border-ink-brass/40 flex flex-col justify-between gap-3">
                    <div className="space-y-1">
                      <div className="font-bold text-sm text-desk-text flex items-center gap-2">
                        <Sparkles className="w-4 h-4 text-ink-brass" />
                        {t('puppetExportGifTitle')}
                      </div>
                      <p className="text-[11px] text-desk-muted leading-snug">{t('puppetExportGifDesc')}</p>
                    </div>
                    <KeycapButton
                      size="sm"
                      variant="brass"
                      className="w-full"
                      disabled={activeRig.parts.length === 0 || Boolean(exportingKind)}
                      onClick={() => void handleExportCutoutGif()}
                    >
                      <Download className="w-3.5 h-3.5" />
                      {t('puppetExportGifBtn')}
                    </KeycapButton>
                  </div>

                  <div className="p-4 rounded-2xl console-well border border-desk-border flex flex-col justify-between gap-3">
                    <div className="space-y-1">
                      <div className="font-bold text-sm text-desk-text flex items-center gap-2">
                        <ImageIcon className="w-4 h-4 text-ink-emerald" />
                        {t('puppetExportPngTitle')}
                      </div>
                      <p className="text-[11px] text-desk-muted leading-snug">{t('puppetExportPngDesc')}</p>
                    </div>
                    <button
                      type="button"
                      disabled={activeRig.parts.length === 0 || Boolean(exportingKind)}
                      onClick={() => void handleDownloadCutoutPng()}
                      className="w-full py-2 px-3 rounded-xl bg-desk-panel border border-desk-border hover:border-ink-emerald text-xs font-bold text-desk-text inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
                    >
                      <Download className="w-3.5 h-3.5" />
                      {t('puppetExportPngBtn')}
                    </button>
                  </div>

                  <div className="p-4 rounded-2xl console-well border border-desk-border flex flex-col justify-between gap-3">
                    <div className="space-y-1">
                      <div className="font-bold text-sm text-desk-text flex items-center gap-2">
                        <Layers className="w-4 h-4 text-ink-brass" />
                        {t('puppetExportDrawTitle')}
                      </div>
                      <p className="text-[11px] text-desk-muted leading-snug">{t('puppetExportDrawDesc')}</p>
                    </div>
                    <button
                      type="button"
                      disabled={activeRig.parts.length === 0 || Boolean(exportingKind)}
                      onClick={() => void handleSendCutoutToDraw()}
                      className="w-full py-2 px-3 rounded-xl bg-desk-panel border border-desk-border hover:border-ink-brass text-xs font-bold text-desk-text inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
                    >
                      <Layers className="w-3.5 h-3.5" />
                      {t('puppetExportDrawBtn')}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
