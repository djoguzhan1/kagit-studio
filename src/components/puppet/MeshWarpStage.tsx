import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AudioLines,
  Clapperboard,
  Download,
  Film,
  Grid,
  Image as ImageIcon,
  Layers,
  Mic,
  Plus,
  Radio,
  Redo2,
  RotateCcw,
  Sparkles,
  Square,
  Trash2,
  Undo2,
  Upload,
  Volume2,
  VolumeX,
  Wand2,
  X,
} from 'lucide-react';
import { useStudioStore } from '../../store/useStudioStore';
import { useT } from '../../i18n/translations';
import type { MeshFrameOffsets, MeshPin, MeshWarpRig } from '../../types/studio';
import type { FilmEmotionId } from '../../types/film';
import {
  applyPinEditToFrames,
  archetypeToPinTemplate,
  createAnatomyMeshPins,
  createPinTemplate,
  generateMeshPresetFrames,
  getMeshStageLayout,
  renderMeshWarpFrame,
  smoothRecordedMeshFrames,
  type MeshPresetId,
  type PinTemplateId,
  type PuppetBackdropId,
} from '../../engine/meshWarpEngine';
import type { VoiceEffectId } from '../../engine/liveAudioStudio';
import {
  erasePaperPocketAtPointRGBA,
  getOrBuildCachedRigPack,
  prepareCharacterCanvas,
} from '../../engine/characterIntakeEngine';
import { renderFrameComposite } from '../../engine/frameComposite';
import { canvasToPngBlob, getBlobBitmap, makeId, saveBlob } from '../../engine/db';
import { analyzeAndStoreAudio, MicVoiceRecorder, StudioAudioPlayer } from '../../engine/audioEngine';
import { synthesizeCartoonDialogueWav } from '../../engine/filmMocapLipSync';
import { createSampleMeshWarpRig } from '../../engine/starterPresets';
import { drawKagitSealStamp, triggerDownload } from '../../engine/exportEngine';
import {
  encodeFramesToMp4WebCodecs,
  pickBestMediaRecorderFormat,
} from '../../engine/videoExportEngine';
import { runGifEncode } from '../../engine/paperWorkerClient';
import { soundEngine } from '../../engine/soundEngine';
import { KeycapButton } from '../ui/KeycapButton';
import { MotionPlayIcon } from '../ui/AnimatedStudioIcons';
import { ToggleLeverSwitch } from '../ui/Studio3DControls';
import {
  countRigViews,
  createMasterRigFromFront,
  type CharacterMasterRig,
} from '../../types/masterRig';
import { extractViewAnchorsFromCanvas } from '../../engine/turnaroundSlicer';
import { MasterRigRuntimeCache, renderMasterRigCharacter } from '../../engine/viewRigBlender';
import { evaluateCartoonDancePose } from '../../engine/cartoonMotionEngine';
import { UNIVERSAL_CREATURE_CATALOG } from '../../engine/universalCreatureRig';
import CharacterMasterModal from '../rig/CharacterMasterModal';

const MAX_UNDO = 25;

export default function MeshWarpStage() {
  const t = useT();
  const {
    projects,
    activeProjectId,
    activeFrameIndex,
    locale,
    soundEnabled,
    puppetExportOpen,
    setPuppetExportOpen,
    upsertMeshRig,
    deleteMeshRig,
    bakeRenderedShotToFrames,
    setAudioTrack,
    updateAudioTrack,
    updateFilmGraph,
    setMode,
    notify,
    activeMasterRig,
    setActiveMasterRig,
  } = useStudioStore();

  const project = projects.find((p) => p.id === activeProjectId);
  const meshRigs = project?.meshRigs ?? [];
  const [activeRigId, setActiveRigId] = useState<string | null>(() => meshRigs[0]?.id ?? null);
  const activeRig = meshRigs.find((r) => r.id === activeRigId) ?? meshRigs[0] ?? null;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const audioPlayerRef = useRef<StudioAudioPlayer | null>(null);
  const recorderRef = useRef<MicVoiceRecorder | null>(null);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [rightTab, setRightTab] = useState<'motion' | 'voice' | 'pins'>('motion');
  const [rigFrame, setRigFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [playSpeed, setPlaySpeed] = useState<0.5 | 1 | 1.5>(1);
  const [activePreset, setActivePreset] = useState<MeshPresetId | null>('bounce');
  const [backdrop, setBackdrop] = useState<PuppetBackdropId>('paper');
  const [selectedPinId, setSelectedPinId] = useState<string | null>(null);
  const [toolMode, setToolMode] = useState<'drag' | 'add-pin' | 'mouth' | 'erase-pocket'>('drag');
  const [editScope, setEditScope] = useState<'all' | 'single'>('all');
  const [showMeshGrid, setShowMeshGrid] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dragOverStage, setDragOverStage] = useState(false);

  // Voice & $0 Type-to-Speak State
  const [micRecording, setMicRecording] = useState(false);
  const [speechText, setSpeechText] = useState('');
  const [voiceTone, setVoiceTone] = useState('Puck');
  const [synthesizing, setSynthesizing] = useState(false);

  // Live Puppeteering REC State (Cancellable + Leak-Free)
  const [liveRecCountdown, setLiveRecCountdown] = useState<number | null>(null);
  const [liveRecording, setLiveRecording] = useState(false);
  const liveRecFramesRef = useRef<MeshFrameOffsets[]>([]);
  // V4 2.5D 360° Multi-Angle Modal & Conditional Yaw Slider
  const [masterModalOpen, setMasterModalOpen] = useState(false);
  const [modalInitialRig, setModalInitialRig] = useState<CharacterMasterRig | null>(null);
  const [puppetAngleDeg, setPuppetAngleDeg] = useState(0);
  const puppetMasterCacheRef = useRef<MasterRigRuntimeCache | null>(null);
  const activeDragOffsetRef = useRef<{ pinId: string; dx: number; dy: number } | null>(null);
  const lastPinPositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());

  // Undo / Redo History Stacks for Active Mesh Rig
  const pastRef = useRef<MeshWarpRig[]>([]);
  const futureRef = useRef<MeshWarpRig[]>([]);
  const [histCounts, setHistCounts] = useState({ past: 0, future: 0 });

  // Unified Export State
  const [exportingKind, setExportingKind] = useState<null | 'video' | 'gif' | 'draw'>(null);
  const [exportPct, setExportPct] = useState(0);
  const [exportLabel, setExportLabel] = useState('');
  const exportAbortRef = useRef(false);

  const dragRef = useRef<{
    pinId: string;
    startX: number;
    startY: number;
    origDx: number;
    origDy: number;
    drawW: number;
    drawH: number;
  } | null>(null);

  const activeRigRef = useRef(activeRig);
  activeRigRef.current = activeRig;
  const rigFrameRef = useRef(rigFrame);
  rigFrameRef.current = rigFrame;
  const playSpeedRef = useRef(playSpeed);
  playSpeedRef.current = playSpeed;

  const hasDrawnCel = useMemo(
    () => Boolean(project?.frames.some((f) => f.layers.some((l) => Boolean(l.blobKey)))),
    [project?.frames]
  );

  const motionPresets = useMemo<{ id: MeshPresetId; label: string }[]>(
    () => [
      { id: 'breathe', label: t('puppetMoveBreathe') },
      { id: 'bounce', label: t('puppetMoveBounce') },
      { id: 'walk', label: t('puppetMoveWalk') },
      { id: 'wave', label: t('puppetMoveWave') },
      { id: 'dance', label: t('puppetMoveDance') },
      { id: 'stretch', label: t('puppetMoveStretch') },
    ],
    [t]
  );

  const voiceTones = useMemo(
    () => [
      { id: 'Puck', label: t('filmVoiceYoungHero') },
      { id: 'Aoede', label: t('filmVoiceWarmNarrator') },
      { id: 'Kore', label: t('filmVoiceSoftGentle') },
      { id: 'Charon', label: t('filmVoiceDeepDrama') },
    ],
    [t]
  );

  const emotionOptions = useMemo<{ id: FilmEmotionId; label: string }[]>(
    () => [
      { id: 'neutral', label: t('filmMoodNeutral') },
      { id: 'happy', label: t('filmMoodHappy') },
      { id: 'angry', label: t('filmMoodAngry') },
      { id: 'tired', label: t('filmMoodTired') },
      { id: 'determined', label: t('filmMoodDetermined') },
      { id: 'surprised', label: t('filmMoodSurprised') },
    ],
    [t]
  );

  const voiceFxOptions = useMemo<{ id: VoiceEffectId; label: string }[]>(
    () => [
      { id: 'natural', label: t('puppetVoiceFxNatural') },
      { id: 'chipmunk', label: t('puppetVoiceFxChipmunk') },
      { id: 'giant', label: t('puppetVoiceFxGiant') },
      { id: 'robot', label: t('puppetVoiceFxRobot') },
    ],
    [t]
  );

  // Sync activeRigId when rigs are added/removed
  useEffect(() => {
    if (activeRigId && !meshRigs.some((r) => r.id === activeRigId)) {
      setActiveRigId(meshRigs[0]?.id ?? null);
    } else if (!activeRigId && meshRigs[0]) {
      setActiveRigId(meshRigs[0].id);
    }
  }, [activeRigId, meshRigs]);

  const commitRig = useCallback(
    (next: MeshWarpRig, recordHistory = true) => {
      if (recordHistory && activeRigRef.current) {
        pastRef.current = [...pastRef.current.slice(-(MAX_UNDO - 1)), activeRigRef.current];
        futureRef.current = [];
        setHistCounts({ past: pastRef.current.length, future: 0 });
      }
      upsertMeshRig(next);
    },
    [upsertMeshRig]
  );

  const handleUndo = useCallback(() => {
    const past = pastRef.current;
    if (past.length === 0 || !activeRigRef.current) return;
    const prev = past[past.length - 1];
    pastRef.current = past.slice(0, -1);
    futureRef.current = [activeRigRef.current, ...futureRef.current.slice(0, MAX_UNDO - 1)];
    setHistCounts({ past: pastRef.current.length, future: futureRef.current.length });
    upsertMeshRig(prev);
    soundEngine.click(0.92);
  }, [upsertMeshRig]);

  const handleRedo = useCallback(() => {
    const future = futureRef.current;
    if (future.length === 0 || !activeRigRef.current) return;
    const next = future[0];
    futureRef.current = future.slice(1);
    pastRef.current = [...pastRef.current, activeRigRef.current];
    setHistCounts({ past: pastRef.current.length, future: futureRef.current.length });
    upsertMeshRig(next);
    soundEngine.click(1.08);
  }, [upsertMeshRig]);

  const redrawStage = useCallback(
    async (fIdx: number, rigOverride?: MeshWarpRig) => {
      const rig = rigOverride ?? activeRigRef.current;
      const canvas = canvasRef.current;
      if (!canvas || !rig || !project) return;
      canvas.width = project.width;
      canvas.height = project.height;
      const ctx = canvas.getContext('2d')!;
      // V4 360° 2.5D multi-view rendering when artist turned the conditional angle slider!
      if (activeMasterRig && countRigViews(activeMasterRig) >= 2 && Math.abs(puppetAngleDeg) > 4) {
        if (!puppetMasterCacheRef.current) {
          puppetMasterCacheRef.current = new MasterRigRuntimeCache(activeMasterRig);
        } else {
          puppetMasterCacheRef.current.syncRig(activeMasterRig);
        }
        const bmp = await getBlobBitmap(rig.sourceBlobKey);
        if (bmp) {
          const srcC = document.createElement('canvas');
          srcC.width = bmp.width;
          srcC.height = bmp.height;
          srcC.getContext('2d')?.drawImage(bmp, 0, 0);
          const pack = getOrBuildCachedRigPack(srcC);
          ctx.clearRect(0, 0, project.width, project.height);
          if (backdrop !== 'transparent') {
            ctx.fillStyle = backdrop === 'night' ? '#141316' : project.paperColor || '#F7F3E9';
            ctx.fillRect(0, 0, project.width, project.height);
          }
          const tSec = fIdx / Math.max(8, project.fps || 12);
          const pose = evaluateCartoonDancePose(tSec, null, 24, 'natural');
          const layout = getMeshStageLayout(project.width, project.height, rig.sourceW, rig.sourceH);
          renderMasterRigCharacter(
            ctx,
            puppetMasterCacheRef.current,
            pack,
            pose,
            { x: layout.drawX, y: layout.drawY, w: layout.drawW, h: layout.drawH },
            {
              boilTick: fIdx,
              yawDeg: puppetAngleDeg,
              universalAction: UNIVERSAL_CREATURE_CATALOG[activeMasterRig.creatureClass].defaultAction,
            }
          );
          return;
        }
      }
      await renderMeshWarpFrame(ctx, rig, fIdx, project.width, project.height, {
        paperColor: project.paperColor,
        backdrop,
        audio: project.audio,
        selectedPinId,
        showPins: !playing || liveRecording,
        showMeshGrid,
        showMouthMarker: toolMode === 'mouth',
        isRecording: liveRecording,
        liveDragOverride: liveRecording ? null : activeDragOffsetRef.current,
        outPinPositions: lastPinPositionsRef.current,
      });
    },
    [project, backdrop, selectedPinId, playing, showMeshGrid, toolMode, liveRecording, activeMasterRig, puppetAngleDeg]
  );

  const handleOpenPuppetMasterModal = useCallback(async () => {
    if (!activeRig) return;
    soundEngine.click(1.12);
    if (activeMasterRig && activeMasterRig.views.front?.dataUrl) {
      setModalInitialRig(activeMasterRig);
      setMasterModalOpen(true);
      return;
    }
    const bmp = await getBlobBitmap(activeRig.sourceBlobKey);
    if (!bmp) return;
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext('2d')?.drawImage(bmp, 0, 0);
    const pack = getOrBuildCachedRigPack(c);
    const anchors = extractViewAnchorsFromCanvas(c);
    setModalInitialRig(
      createMasterRigFromFront(
        c.toDataURL('image/png'),
        pack.creatureClass,
        activeRig.name,
        anchors,
        c.width,
        c.height
      )
    );
    setMasterModalOpen(true);
  }, [activeRig, activeMasterRig]);

  useEffect(() => {
    if (!playing && !liveRecording) {
      void redrawStage(rigFrame);
    }
  }, [rigFrame, activeRig, playing, liveRecording, redrawStage]);

  // Smooth Playback & Live Puppeteering Clock (Stable refs, zero audio restart on edits!)
  useEffect(() => {
    if ((!playing && !liveRecording) || !activeRigRef.current || !project) {
      audioPlayerRef.current?.stop();
      return;
    }
    if (!audioPlayerRef.current) audioPlayerRef.current = new StudioAudioPlayer();
    const player = audioPlayerRef.current;
    let cancelled = false;
    let raf = 0;

    if (liveRecording && activeRigRef.current) {
      const curRig = activeRigRef.current;
      liveRecFramesRef.current = Array.from({ length: curRig.totalFrames }, (_, i) => ({
        ...(curRig.frames[i] ?? {}),
      }));
    }

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

      const tick = () => {
        if (cancelled) return;
        const curRig = activeRigRef.current;
        if (!curRig) return;
        const elapsed = (performance.now() - start) / 1000;
        const effectiveFps = project.fps * (liveRecording ? 1 : playSpeedRef.current);
        const rawF = Math.floor(elapsed * effectiveFps);

        if (liveRecording && rawF >= curRig.totalFrames) {
          const smoothed = smoothRecordedMeshFrames(liveRecFramesRef.current, curRig.pins);
          commitRig({ ...curRig, frames: smoothed });
          setActivePreset(null);
          setLiveRecording(false);
          setPlaying(true);
          soundEngine.clapperSnap();
          notify(
            locale === 'en'
              ? 'Live puppet performance recorded & smoothed!'
              : 'Canlı kukla performansın kaydedildi ve yumuşatıldı!'
          );
          return;
        }

        const f = rawF % Math.max(1, curRig.totalFrames);
        if (f !== lastF) {
          if (f < lastF && canAudio && project.audio) {
            player.startAt(0, project.audio.volume, false, project.audio.voiceEffect ?? 'natural');
          }
          lastF = f;
          rigFrameRef.current = f;
          setRigFrame(f);

          if (liveRecording) {
            const drag = activeDragOffsetRef.current;
            if (drag) {
              liveRecFramesRef.current[f] = {
                ...(liveRecFramesRef.current[f] ?? {}),
                [drag.pinId]: { dx: drag.dx, dy: drag.dy },
              };
            }
            void redrawStage(f, { ...curRig, frames: liveRecFramesRef.current });
          } else {
            void redrawStage(f);
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
    };
  }, [playing, liveRecording, project, soundEnabled, redrawStage, commitRig, locale, notify]);

  // Clean up mic, audio player & countdown interval on unmount (ZERO leaks!)
  useEffect(() => {
    return () => {
      if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
      recorderRef.current?.cleanup();
      audioPlayerRef.current?.dispose();
    };
  }, []);

  // =========================================================================
  // CHARACTER LOADING (GRADIENT BFS + PENCIL BOOST + AUTO-CROP + ARCHETYPE!)
  // =========================================================================
  const createRigFromCanvas = useCallback(
    async (
      canvas: HTMLCanvasElement,
      name: string,
      opts?: {
        stripPaper?: boolean;
        boostedPencil?: boolean;
        isolatedPrimary?: boolean;
        cleanedPockets?: number;
        preppedArchetype?: 'humanoid' | 'quadruped' | 'floater';
      }
    ) => {
      const prepared = prepareCharacterCanvas(canvas, {
        maxDim: 768,
        stripPaper: opts?.stripPaper ?? false,
      });
      if (prepared.empty) {
        notify(t('puppetEmptyUploadError'), 'error');
        return;
      }
      const archetype = opts?.preppedArchetype ?? prepared.archetype;
      const tpl = archetypeToPinTemplate(archetype);
      const blob = await canvasToPngBlob(prepared.canvas);
      const sourceBlobKey = await saveBlob(blob);
      const pins = createAnatomyMeshPins(prepared.anatomy, tpl);
      const totalFrames = 24;
      const newRig: MeshWarpRig = {
        id: makeId('mrg'),
        name,
        sourceBlobKey,
        sourceW: prepared.width,
        sourceH: prepared.height,
        pins,
        frames: generateMeshPresetFrames(pins, totalFrames, 'breathe'),
        totalFrames,
        lineBoil: 0.25,
        mouthPos: {
          x: Number(prepared.anatomy.mouthX.toFixed(3)),
          y: Number(prepared.anatomy.mouthY.toFixed(3)),
          scale: Number(prepared.anatomy.mouthScale.toFixed(2)),
        },
        autoBlink: true,
        emotion: 'neutral',
      };
      upsertMeshRig(newRig);
      setActiveRigId(newRig.id);
      setSelectedPinId(pins[1]?.id ?? pins[0]?.id ?? null);
      setActivePreset('breathe');
      setRigFrame(0);
      setPlaying(true);
      soundEngine.clapperSnap();
      const cleanedNotes: string[] = [];
      if (opts?.isolatedPrimary || prepared.isolatedPrimary) {
        cleanedNotes.push(locale === 'en' ? 'corners cleaned' : 'kenar imzaları ayıklandı');
      }
      if ((opts?.cleanedPockets ?? prepared.cleanedPockets) > 0) {
        cleanedNotes.push(locale === 'en' ? 'inner gaps cleared' : 'kapalı boşluklar temizlendi');
      }
      if (opts?.boostedPencil || prepared.boostedPencil) {
        cleanedNotes.push(locale === 'en' ? 'ink sharpened' : 'çizgiler netleştirildi');
      }
      const extraNote = cleanedNotes.length > 0 ? ` (${cleanedNotes.join(', ')})` : '';
      notify(
        locale === 'en'
          ? `"${name}" rigged with ${pins.length} anatomical joints${extraNote} — drag any pin or pick a move!`
          : `"${name}" ${pins.length} otomatik eklemle canlandırıldı${extraNote} — pimleri sürükle veya hareket seç!`
      );
    },
    [locale, notify, t, upsertMeshRig]
  );

  const importImageFile = useCallback(
    async (file: File) => {
      if (!file.type.startsWith('image/')) {
        notify(locale === 'en' ? 'Please pick an image file (PNG/JPG/WebP)' : 'Lütfen bir görsel dosyası seç (PNG/JPG/WebP)', 'error');
        return;
      }
      const url = URL.createObjectURL(file);
      try {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const el = new Image();
          el.onload = () => resolve(el);
          el.onerror = reject;
          el.src = url;
        });
        // Gradient-tolerant BFS paper removal (preserves white eyes/teeth!) + faint pencil boost + tight ground-locked crop!
        const prepared = prepareCharacterCanvas(img, { maxDim: 768, stripPaper: true });
        if (prepared.empty) {
          notify(t('puppetEmptyUploadError'), 'error');
          return;
        }
        await createRigFromCanvas(
          prepared.canvas,
          file.name.replace(/\.[^.]+$/, '').slice(0, 26) || 'Kukla',
          {
            stripPaper: false,
            boostedPencil: prepared.boostedPencil,
            isolatedPrimary: prepared.isolatedPrimary,
            cleanedPockets: prepared.cleanedPockets,
            preppedArchetype: prepared.archetype,
          }
        );
      } catch {
        notify(locale === 'en' ? 'Could not read image file' : 'Görsel dosyası okunamadı', 'error');
      } finally {
        URL.revokeObjectURL(url);
      }
    },
    [createRigFromCanvas, locale, notify, t]
  );

  const handleLoadFromActiveFrame = async () => {
    if (!project) return;
    const frame = project.frames[activeFrameIndex] ?? project.frames[0];
    if (!frame || frame.layers.every((l) => !l.blobKey)) {
      notify(
        locale === 'en'
          ? 'Your active drawing frame is blank — draw something first or pick Sample Hero!'
          : 'Aktif çizim karesi boş — önce çizim yap ya da Örnek Karakteri dene!',
        'info'
      );
      return;
    }
    const c = await renderFrameComposite(project, frame, {
      transparentBg: true,
      hideRoughBlue: true,
    });
    await createRigFromCanvas(
      c,
      locale === 'en' ? `My Drawing #${activeFrameIndex + 1}` : `Çizimim #${activeFrameIndex + 1}`,
      { stripPaper: false }
    );
  };

  const handleUploadDrawing = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await importImageFile(file);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // Support Ctrl+V image paste straight onto the Canlı Kukla stage!
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) {
          const f = item.getAsFile();
          if (f) {
            e.preventDefault();
            void importImageFile(f);
            return;
          }
        }
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [importImageFile]);

  const handleLoadSampleCharacter = async () => {
    const sample = await createSampleMeshWarpRig();
    upsertMeshRig(sample);
    setActiveRigId(sample.id);
    setSelectedPinId(sample.pins[1]?.id ?? null);
    setActivePreset('bounce');
    setRigFrame(0);
    setPlaying(true);
    soundEngine.clapperSnap();
    notify(
      locale === 'en'
        ? 'Horned Baron ready — bend pins, bounce, or make it talk!'
        : 'Şapkalı Baron sahnede — bük, zıplat veya konuştur!'
    );
  };

  const applyTemplate = async (tpl: PinTemplateId) => {
    if (!activeRig) return;
    const bmp = await getBlobBitmap(activeRig.sourceBlobKey);
    const pins = bmp
      ? createAnatomyMeshPins(getOrBuildCachedRigPack(bmp).anatomy, tpl)
      : createPinTemplate(tpl);
    const presetToKeep = activePreset ?? 'breathe';
    const frames = generateMeshPresetFrames(pins, activeRig.totalFrames, presetToKeep);
    commitRig({ ...activeRig, pins, frames });
    setSelectedPinId(pins[0]?.id ?? null);
    soundEngine.click(1.06);
  };

  const applyPreset = (preset: MeshPresetId) => {
    if (!activeRig) return;
    const frames = generateMeshPresetFrames(activeRig.pins, activeRig.totalFrames, preset);
    commitRig({ ...activeRig, frames });
    setActivePreset(preset);
    setPlaying(true);
    soundEngine.click(1.1);
  };

  const handleDeleteSelectedPin = useCallback(() => {
    const rig = activeRigRef.current;
    if (!rig || !selectedPinId) return;
    if (rig.pins.length <= 2) {
      notify(
        locale === 'en' ? 'At least 2 pins are required' : 'En az 2 eklem pimi kalmalı',
        'info'
      );
      return;
    }
    const nextPins = rig.pins.filter((p) => p.id !== selectedPinId);
    const nextFrames = rig.frames.map((fr) => {
      const copy = { ...fr };
      delete copy[selectedPinId];
      return copy;
    });
    commitRig({ ...rig, pins: nextPins, frames: nextFrames });
    setSelectedPinId(nextPins[0]?.id ?? null);
    soundEngine.click(0.95);
  }, [selectedPinId, commitRig, locale, notify]);

  const handleChangeLoopLength = (newTotal: number) => {
    if (!activeRig || newTotal === activeRig.totalFrames) return;
    const nextFrames = activePreset
      ? generateMeshPresetFrames(activeRig.pins, newTotal, activePreset)
      : Array.from({ length: newTotal }, (_, i) => {
          const srcIdx = Math.min(
            activeRig.frames.length - 1,
            Math.floor((i / newTotal) * activeRig.frames.length)
          );
          return { ...(activeRig.frames[srcIdx] ?? {}) };
        });
    commitRig({ ...activeRig, totalFrames: newTotal, frames: nextFrames });
    setRigFrame((f) => Math.min(newTotal - 1, f));
    soundEngine.click(1.04);
  };

  // =========================================================================
  // CANCELLABLE, LEAK-FREE LIVE RECORDING (3-2-1 + EARLY STOP)
  // =========================================================================
  const cancelLiveCountdown = useCallback(() => {
    if (countdownTimerRef.current) {
      clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    setLiveRecCountdown(null);
  }, []);

  const handleToggleLiveRec = () => {
    if (!activeRig) return;
    if (liveRecCountdown !== null) {
      cancelLiveCountdown();
      return;
    }
    if (liveRecording) {
      // Finish early and smooth recorded frames!
      const smoothed = smoothRecordedMeshFrames(liveRecFramesRef.current, activeRig.pins);
      commitRig({ ...activeRig, frames: smoothed });
      setActivePreset(null);
      setLiveRecording(false);
      setPlaying(true);
      soundEngine.clapperSnap();
      notify(
        locale === 'en' ? 'Live take saved!' : 'Canlı kayıt tamamlandı!'
      );
      return;
    }

    setPlaying(false);
    setToolMode('drag');
    setLiveRecCountdown(3);
    let rem = 3;
    soundEngine.click(1.25);
    countdownTimerRef.current = setInterval(() => {
      rem--;
      if (rem <= 0) {
        if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
        countdownTimerRef.current = null;
        setLiveRecCountdown(null);
        setRigFrame(0);
        setLiveRecording(true);
        soundEngine.clapperSnap();
      } else {
        setLiveRecCountdown(rem);
        soundEngine.click(1.25);
      }
    }, 650);
  };

  // =========================================================================
  // SMOOTH 60 FPS PIN DRAGGING (COMMITS ONCE ON POINTERUP!)
  // =========================================================================
  const handleCanvasPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!activeRig || !project) return;
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const cx = ((e.clientX - rect.left) / Math.max(1, rect.width)) * project.width;
    const cy = ((e.clientY - rect.top) / Math.max(1, rect.height)) * project.height;
    const layout = getMeshStageLayout(activeRig.sourceW, activeRig.sourceH, project.width, project.height);
    const nx = (cx - layout.drawX) / layout.drawW;
    const ny = (cy - layout.drawY) / layout.drawH;

    if (toolMode === 'add-pin') {
      if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;
      const newPin: MeshPin = {
        id: makeId('pin'),
        label: `${locale === 'en' ? 'Pin' : 'Pim'} ${activeRig.pins.length + 1}`,
        role: 'custom',
        x: Number(nx.toFixed(3)),
        y: Number(ny.toFixed(3)),
      };
      commitRig({ ...activeRig, pins: [...activeRig.pins, newPin] });
      setSelectedPinId(newPin.id);
      setToolMode('drag');
      soundEngine.click(1.15);
      return;
    }

    if (toolMode === 'mouth') {
      if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;
      commitRig({
        ...activeRig,
        mouthPos: {
          x: Number(nx.toFixed(3)),
          y: Number(ny.toFixed(3)),
          scale: activeRig.mouthPos?.scale ?? 1,
        },
      });
      setToolMode('drag');
      soundEngine.click(1.2);
      notify(locale === 'en' ? 'Mouth position updated!' : 'Ağız konumu güncellendi!');
      return;
    }

    if (toolMode === 'erase-pocket') {
      if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;
      const targetRig = activeRig;
      void (async () => {
        const bmp = await getBlobBitmap(targetRig.sourceBlobKey);
        if (!bmp) return;
        const work = document.createElement('canvas');
        work.width = bmp.width;
        work.height = bmp.height;
        const wctx = work.getContext('2d', { willReadFrequently: true })!;
        wctx.drawImage(bmp, 0, 0);
        const im = wctx.getImageData(0, 0, work.width, work.height);
        const cleared = erasePaperPocketAtPointRGBA(
          im.data,
          work.width,
          work.height,
          nx * (work.width - 1),
          ny * (work.height - 1)
        );
        if (cleared < 8) {
          notify(
            locale === 'en'
              ? 'Click inside an enclosed white gap to clear it.'
              : 'Temizlemek için kapalı bir beyaz boşluğun içine tıkla.'
          );
          return;
        }
        wctx.putImageData(im, 0, 0);
        const newKey = await saveBlob(await canvasToPngBlob(work));
        commitRig({ ...targetRig, sourceBlobKey: newKey });
        soundEngine.click(1.22);
        notify(
          locale === 'en'
            ? 'Pocket cleared! Click another gap or press Esc when done.'
            : 'Boşluk temizlendi! Başka alan varsa tıkla veya Esc ile çık.'
        );
      })();
      return;
    }

    const curOffsets = activeRig.frames[rigFrame] ?? {};
    let bestPin: MeshPin | null = null;
    let bestDist = 38;
    for (const pin of activeRig.pins) {
      const off = curOffsets[pin.id] ?? { dx: 0, dy: 0 };
      const solved = lastPinPositionsRef.current.get(pin.id);
      const px = solved ? solved.x : layout.drawX + (pin.x + off.dx) * layout.drawW;
      const py = solved ? solved.y : layout.drawY + (pin.y + off.dy) * layout.drawH;
      const d = Math.hypot(cx - px, cy - py);
      if (d < bestDist) {
        bestDist = d;
        bestPin = pin;
      }
    }

    if (bestPin) {
      setSelectedPinId(bestPin.id);
      e.currentTarget.setPointerCapture(e.pointerId);
      const off = curOffsets[bestPin.id] ?? { dx: 0, dy: 0 };
      dragRef.current = {
        pinId: bestPin.id,
        startX: cx,
        startY: cy,
        origDx: off.dx,
        origDy: off.dy,
        drawW: layout.drawW,
        drawH: layout.drawH,
      };
      activeDragOffsetRef.current = { pinId: bestPin.id, dx: off.dx, dy: off.dy };
    }
  };

  const handleCanvasPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || !activeRig || !project) return;
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const cx = ((e.clientX - rect.left) / Math.max(1, rect.width)) * project.width;
    const cy = ((e.clientY - rect.top) / Math.max(1, rect.height)) * project.height;
    const dx = drag.origDx + (cx - drag.startX) / drag.drawW;
    const dy = drag.origDy + (cy - drag.startY) / drag.drawH;

    activeDragOffsetRef.current = { pinId: drag.pinId, dx, dy };
    if (!liveRecording) {
      void redrawStage(rigFrameRef.current);
    }
  };

  const handleCanvasPointerUp = () => {
    const drag = dragRef.current;
    const finalOff = activeDragOffsetRef.current;
    dragRef.current = null;
    activeDragOffsetRef.current = null;

    if (drag && finalOff && activeRig && !liveRecording) {
      const nextFrames = applyPinEditToFrames(
        activeRig.frames,
        activeRig.totalFrames,
        rigFrameRef.current,
        drag.pinId,
        finalOff.dx,
        finalOff.dy,
        editScope
      );
      commitRig({ ...activeRig, frames: nextFrames });
    }
  };

  // =========================================================================
  // VOICE: $0 TYPE & SPEAK + MICROPHONE + FILE UPLOAD + MUTE / CLEAR
  // =========================================================================
  const handleTypeAndSpeak = async () => {
    if (!project || synthesizing) return;
    const text = speechText.trim() || (locale === 'en' ? 'Hello, I am alive!' : 'Merhaba, ben canlandım!');
    setSynthesizing(true);
    try {
      const synth = synthesizeCartoonDialogueWav(text, 'happy', voiceTone);
      const label = voiceTones.find((v) => v.id === voiceTone)?.label ?? 'Ses';
      const track = await analyzeAndStoreAudio(synth.blob, `${label}: ${text.slice(0, 18)}`, project.fps);
      setAudioTrack(track);
      setPlaying(true);
      soundEngine.clapperSnap();
      notify(
        locale === 'en'
          ? `Puppet voice ready (${track.durationSec.toFixed(1)}s)!`
          : `Kukla konuşmaya hazır (${track.durationSec.toFixed(1)}s)!`
      );
    } catch {
      notify(locale === 'en' ? 'Could not synthesize voice' : 'Ses oluşturulamadı', 'error');
    } finally {
      setSynthesizing(false);
    }
  };

  const toggleMicRecord = async () => {
    if (!project) return;
    if (micRecording && recorderRef.current) {
      try {
        const blob = await recorderRef.current.stop();
        setMicRecording(false);
        const track = await analyzeAndStoreAudio(
          blob,
          locale === 'en' ? 'Live Voice' : 'Canlı Seslendirme',
          project.fps
        );
        setAudioTrack(track);
        setPlaying(true);
        notify(
          locale === 'en'
            ? 'Voice recorded — your puppet is speaking!'
            : 'Sesin yüklendi — kuklan şimdi konuşuyor!'
        );
      } catch {
        setMicRecording(false);
        recorderRef.current?.cleanup();
      }
      return;
    }
    try {
      const rec = new MicVoiceRecorder();
      await rec.start();
      recorderRef.current = rec;
      setMicRecording(true);
      notify(
        locale === 'en' ? 'Speak now — click again to stop' : 'Konuşmaya başla — bitirmek için tekrar bas',
        'info'
      );
    } catch {
      notify(locale === 'en' ? 'Microphone permission denied' : 'Mikrofon izni alınamadı', 'error');
    }
  };

  // =========================================================================
  // UNIFIED DIRECT PUPPET EXPORTS (VIDEO + GIF + PNG + FAST SEND TO DRAW!)
  // =========================================================================
  const handleExportPuppetVideo = async () => {
    if (!activeRig || !project || exportingKind) return;
    setPlaying(false);
    exportAbortRef.current = false;
    setExportingKind('video');
    setExportPct(5);
    setExportLabel(t('filmExportPreparing'));

    const exportPlayer = new StudioAudioPlayer();
    try {
      const W = 1280;
      const H = 720;
      const fps = project.fps;
      const off = document.createElement('canvas');
      off.width = W;
      off.height = H;
      const ctx = off.getContext('2d', { alpha: false })!;

      const loops = project.audio ? Math.max(2, Math.min(4, Math.ceil((project.audio.durationSec * fps) / activeRig.totalFrames))) : 2;
      const totalSteps = activeRig.totalFrames * loops;
      const chosen = pickBestMediaRecorderFormat();

      // Universal WhatsApp/iPhone MP4 path via WebCodecs H.264 when native MP4 MediaRecorder isn't available!
      if (!chosen || chosen.ext !== 'mp4') {
        const exportFps = Math.max(8, Math.round(fps * playSpeed));
        const mp4Blob = await encodeFramesToMp4WebCodecs({
          width: W,
          height: H,
          fps: exportFps,
          totalFrames: totalSteps,
          shouldAbort: () => exportAbortRef.current,
          onProgress: (done, total) => {
            setExportPct(Math.min(96, Math.round((done / Math.max(1, total)) * 90) + 5));
            setExportLabel(`${done}/${total}`);
          },
          drawFrame: async (wctx, i) => {
            const f = i % activeRig.totalFrames;
            await renderMeshWarpFrame(wctx, activeRig, f, W, H, {
              paperColor: project.paperColor,
              backdrop: backdrop === 'transparent' ? 'paper' : backdrop,
              audio: project.audio,
              showPins: false,
              showMeshGrid: false,
            });
            if (i >= totalSteps - Math.round(exportFps * 0.5)) {
              drawKagitSealStamp(wctx, W, H, 0.85);
            }
          },
        });
        if (mp4Blob) {
          const safeName = activeRig.name.replace(/[^a-zA-Z0-9ğüşıöçĞÜŞİÖÇ_-]/g, '_').slice(0, 32) || 'kukla';
          triggerDownload(mp4Blob, `${safeName}.mp4`);
          soundEngine.clapperSnap();
          notify(locale === 'en' ? 'Puppet MP4 downloaded!' : 'Kukla videosu (.mp4) indirildi!');
          setPuppetExportOpen(false);
          return;
        }
      }

      if (!chosen || typeof off.captureStream !== 'function') {
        notify(t('exportWebViewFallbackToast'), 'info');
        return;
      }
      const mime = chosen.mime;

      const videoStream = off.captureStream(fps);
      const tracks: MediaStreamTrack[] = [...videoStream.getVideoTracks()];
      let startSilentAudio: (() => void) | null = null;
      if (project.audio && !project.audio.muted) {
        await exportPlayer.ensureLoaded(project.audio);
        const attached = exportPlayer.attachSilentExportStream(
          project.audio.volume,
          project.audio.voiceEffect ?? 'natural'
        );
        if (attached) {
          tracks.push(...attached.stream.getAudioTracks());
          startSilentAudio = attached.start;
        }
      }

      const recorder = new MediaRecorder(new MediaStream(tracks), {
        mimeType: mime,
        videoBitsPerSecond: 5_500_000,
      });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunks.push(ev.data);
      };

      const stepMs = Math.round(1000 / Math.max(8, fps * playSpeed));

      recorder.start();
      startSilentAudio?.();

      for (let i = 0; i < totalSteps; i++) {
        if (exportAbortRef.current) break;
        const f = i % activeRig.totalFrames;
        await renderMeshWarpFrame(ctx, activeRig, f, W, H, {
          paperColor: project.paperColor,
          backdrop: backdrop === 'transparent' ? 'paper' : backdrop,
          audio: project.audio,
          showPins: false,
          showMeshGrid: false,
        });
        if (i >= totalSteps - Math.round(fps * 0.5)) {
          drawKagitSealStamp(ctx, W, H, 0.85);
        }
        setExportPct(Math.min(95, Math.round(((i + 1) / totalSteps) * 90) + 5));
        setExportLabel(`${i + 1}/${totalSteps}`);
        await new Promise((r) => setTimeout(r, stepMs));
      }

      exportPlayer.stop();
      const stopped = new Promise<void>((res) => {
        recorder.onstop = () => res();
      });
      if (recorder.state !== 'inactive') recorder.stop();
      await stopped;

      if (exportAbortRef.current) {
        notify(locale === 'en' ? 'Export cancelled' : 'İndirme iptal edildi', 'info');
        return;
      }

      const ext = mime.includes('mp4') ? 'mp4' : 'webm';
      const safe = activeRig.name.replace(/[^a-zA-Z0-9ğüşıöçĞÜŞİÖÇ_-]/g, '_').slice(0, 32) || 'kukla';
      triggerDownload(new Blob(chunks, { type: mime }), `${safe}.${ext}`);
      soundEngine.clapperSnap();
      notify(locale === 'en' ? 'Puppet video downloaded!' : 'Kukla videosu indirildi!');
      setPuppetExportOpen(false);
    } catch {
      notify(locale === 'en' ? 'Video export failed' : 'Video oluşturulamadı', 'error');
    } finally {
      exportPlayer.dispose();
      setExportingKind(null);
      setExportPct(0);
    }
  };

  const handleExportPuppetGif = async () => {
    if (!activeRig || !project || exportingKind) return;
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
        await renderMeshWarpFrame(ctx, activeRig, f, W, H, {
          paperColor: project.paperColor,
          backdrop: backdrop === 'transparent' ? 'paper' : backdrop,
          audio: project.audio,
          showPins: false,
          showMeshGrid: false,
        });
        frames.push({ rgba: new Uint8ClampedArray(ctx.getImageData(0, 0, W, H).data), hold: 1 });
        setExportPct(5 + Math.round(((f + 1) / activeRig.totalFrames) * 68));
        setExportLabel(`GIF ${f + 1}/${activeRig.totalFrames}`);
        await new Promise<void>((r) => setTimeout(r, 0));
      }

      if (exportAbortRef.current) return;
      setExportPct(80);
      const effectiveFps = Math.max(6, Math.round(project.fps * playSpeed));
      const gifBlob = await runGifEncode({
        width: W,
        height: H,
        delayCs: Math.max(3, Math.round(100 / effectiveFps)),
        frames,
      });
      const safe = activeRig.name.replace(/[^a-zA-Z0-9ğüşıöçĞÜŞİÖÇ_-]/g, '_').slice(0, 32) || 'kukla';
      triggerDownload(gifBlob, `${safe}.gif`);
      soundEngine.clapperSnap();
      notify(locale === 'en' ? 'Puppet GIF downloaded!' : 'Animasyonlu GIF indirildi!');
      setPuppetExportOpen(false);
    } catch {
      notify(locale === 'en' ? 'GIF export failed' : 'GIF oluşturulamadı', 'error');
    } finally {
      setExportingKind(null);
      setExportPct(0);
    }
  };

  const handleDownloadPuppetPng = async () => {
    if (!activeRig || !project) return;
    const c = document.createElement('canvas');
    c.width = project.width;
    c.height = project.height;
    const ctx = c.getContext('2d')!;
    await renderMeshWarpFrame(ctx, activeRig, rigFrame, project.width, project.height, {
      paperColor: backdrop === 'transparent' ? undefined : project.paperColor,
      backdrop,
      audio: project.audio,
      showPins: false,
      showMeshGrid: false,
    });
    const blob = await canvasToPngBlob(c);
    const safe = activeRig.name.replace(/[^a-zA-Z0-9ğüşıöçĞÜŞİÖÇ_-]/g, '_').slice(0, 32) || 'kukla';
    triggerDownload(blob, `${safe}_kare${rigFrame + 1}.png`);
    soundEngine.shutter();
    notify(locale === 'en' ? 'HD PNG frame downloaded!' : 'HD kukla karesi indirildi!');
  };

  // FAST, NON-BLOCKING SEND TO DRAW (< 2.5s via reusable canvas + WebP!)
  const handleSendToDraw = async () => {
    if (!activeRig || !project || exportingKind) return;
    setPlaying(false);
    setExportingKind('draw');
    setExportPct(5);
    try {
      // Pre-render cleanly frame-by-frame into reusable canvas via async helper
      const framesToBake = activeRig.totalFrames;
      const preRendered: ImageBitmap[] = [];
      const work = document.createElement('canvas');
      work.width = project.width;
      work.height = project.height;
      const wctx = work.getContext('2d')!;
      for (let f = 0; f < framesToBake; f++) {
        await renderMeshWarpFrame(wctx, activeRig, f, project.width, project.height, {
          backdrop: 'transparent',
          audio: project.audio,
          showPins: false,
          showMeshGrid: false,
        });
        preRendered.push(await createImageBitmap(work));
        setExportPct(Math.round(((f + 1) / framesToBake) * 45));
      }

      const added = await bakeRenderedShotToFrames(
        preRendered.length,
        (ctx, idx, w, h) => {
          ctx.drawImage(preRendered[idx], 0, 0, w, h);
        },
        {
          replace: false,
          notePrefix: locale === 'en' ? 'Puppet' : 'Kukla',
          layerName: locale === 'en' ? 'Puppet Layer' : 'Kukla Sahnesi',
          topLayerName: locale === 'en' ? 'Top Ink (Effects)' : 'Üst Çizim (Efekt)',
          onProgress: (done, total) => {
            setExportPct(45 + Math.round((done / total) * 55));
            setExportLabel(`${t('puppetSendingToDraw')}… ${done}/${total}`);
          },
        }
      );
      preRendered.forEach((b) => b.close());
      setPuppetExportOpen(false);
      soundEngine.clapperSnap();
      notify(
        locale === 'en'
          ? `${added} puppet frames sent to Draw Desk!`
          : `${added} kukla karesi Çizim Masası'na aktarıldı!`
      );
    } finally {
      setExportingKind(null);
      setExportPct(0);
    }
  };

  // Bridge to Mini Film WITH real StyleDNA + anatomy extraction (no unwanted scarf on custom art!)
  const handleSendToFilm = async () => {
    if (!activeRig || !project) return;
    soundEngine.projectorClick();
    const { compileDirectorPromptToFilmGraph, DIRECTOR_PRESETS, extractStyleDNAFromCanvas } =
      await import('../../engine/film25dEngine');
    const bmp = await getBlobBitmap(activeRig.sourceBlobKey);
    const dna = bmp ? extractStyleDNAFromCanvas(bmp) : undefined;
    const pack = bmp ? getOrBuildCachedRigPack(bmp) : null;
    const baseGraph =
      project.filmGraph ?? compileDirectorPromptToFilmGraph(DIRECTOR_PRESETS[0].prompt);
    updateFilmGraph({
      ...baseGraph,
      actor: {
        ...baseGraph.actor,
        name: activeRig.name,
        sourceBlobKey: activeRig.sourceBlobKey,
        sourceW: activeRig.sourceW,
        sourceH: activeRig.sourceH,
        rigidHeadEndY: pack?.anatomy.headEndV ?? baseGraph.actor.rigidHeadEndY,
        secondaryPhysics: false,
        styleDna: dna ?? baseGraph.actor.styleDna,
        decomposed: null,
      },
    });
    setMode('film');
    notify(
      locale === 'en'
        ? `"${activeRig.name}" is now starring in Short Film!`
        : `"${activeRig.name}" Mini Film sahnesinde başrole alındı!`
    );
  };

  // Keyboard Shortcuts (Space, Left/Right, Ctrl+Z/Y, Delete, Escape)
  useEffect(() => {
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
        if (liveRecCountdown !== null) {
          cancelLiveCountdown();
          return;
        }
        if (toolMode !== 'drag') {
          setToolMode('drag');
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
      if (e.code === 'Space' && activeRigRef.current) {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key === 'ArrowLeft' && activeRigRef.current) {
        e.preventDefault();
        setPlaying(false);
        const total = activeRigRef.current.totalFrames;
        setRigFrame((f) => (f - 1 + total) % total);
      } else if (e.key === 'ArrowRight' && activeRigRef.current) {
        e.preventDefault();
        setPlaying(false);
        const total = activeRigRef.current.totalFrames;
        setRigFrame((f) => (f + 1) % total);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedPinId && !playing) {
        e.preventDefault();
        handleDeleteSelectedPin();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    cancelLiveCountdown,
    exportingKind,
    handleDeleteSelectedPin,
    handleRedo,
    handleUndo,
    liveRecCountdown,
    playing,
    puppetExportOpen,
    selectedPinId,
    setPuppetExportOpen,
    toolMode,
  ]);

  if (!project) return null;

  return (
    <div
      className="flex-1 flex flex-col lg:flex-row min-h-0 overflow-hidden select-none relative"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          if (!dragOverStage) setDragOverStage(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOverStage(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOverStage(false);
        const file = e.dataTransfer.files?.[0];
        if (file) void importImageFile(file);
      }}
    >
      {dragOverStage && (
        <div className="pointer-events-none absolute inset-3 z-40 rounded-3xl border-2 border-dashed border-ink-brass bg-black/65 backdrop-blur-sm flex flex-col items-center justify-center gap-2">
          <Upload className="w-10 h-10 text-ink-brass animate-bounce" />
          <span className="font-mono text-sm font-bold text-ink-brass">{t('puppetDropHint')}</span>
        </div>
      )}
      {/* MAIN INTERACTIVE FLEX PUPPET STAGE */}
      <div className="flex-1 flex flex-col min-h-0 p-3 gap-2.5 overflow-hidden">
        {!activeRig ? (
          <div className="flex-1 rounded-3xl console-well border border-dashed border-desk-border flex flex-col items-center justify-center p-8 text-center gap-4">
            <Sparkles className="w-10 h-10 text-ink-brass" />
            <div className="max-w-md space-y-1.5">
              <h3 className="text-lg font-extrabold text-desk-text">{t('puppetEmptyFlexTitle')}</h3>
              <p className="text-xs text-desk-muted leading-relaxed">{t('puppetEmptyFlexDesc')}</p>
            </div>
            <div className="flex flex-wrap justify-center gap-2.5">
              <KeycapButton variant="vermilion" size="md" onClick={() => void handleLoadSampleCharacter()}>
                <Sparkles className="w-4 h-4" />
                {t('puppetTrySample')}
              </KeycapButton>
              <KeycapButton variant="ivory" size="md" onClick={() => void handleLoadFromActiveFrame()}>
                <Layers className="w-4 h-4" />
                {t('puppetFromMyArt')}
              </KeycapButton>
              <KeycapButton variant="brass" size="md" onClick={() => fileInputRef.current?.click()}>
                <Upload className="w-4 h-4" />
                {t('puppetUploadArt')}
              </KeycapButton>
            </div>
          </div>
        ) : (
          <>
            {/* Compact Top Stage Utility Bar (Rig Switcher + Undo/Redo + Speed) */}
            <div className="flex flex-wrap items-center justify-between gap-2 shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <span className="hardware-led" data-on={playing ? 'emerald' : 'amber'} />
                {meshRigs.length > 1 ? (
                  <select
                    value={activeRig.id}
                    onChange={(e) => {
                      setActiveRigId(e.target.value);
                      setRigFrame(0);
                      setConfirmDelete(false);
                    }}
                    className="px-2.5 py-1 rounded-lg console-well border border-desk-border text-xs font-bold text-desk-text max-w-[220px]"
                  >
                    {meshRigs.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="font-mono text-xs font-bold text-desk-text truncate max-w-[220px]">
                    {activeRig.name}
                  </span>
                )}
                {toolMode === 'mouth' && (
                  <span className="px-2 py-0.5 rounded-full bg-ink-brass/20 border border-ink-brass font-mono text-[10px] font-bold text-ink-brass">
                    {t('puppetMouthPosHint')}
                  </span>
                )}
                {toolMode === 'erase-pocket' && (
                  <span className="px-2 py-0.5 rounded-full bg-ink-emerald/20 border border-ink-emerald font-mono text-[10px] font-bold text-ink-emerald">
                    {t('puppetErasePocketHint')}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void handleOpenPuppetMasterModal()}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-bold inline-flex items-center gap-1 border transition-colors ${
                    countRigViews(activeMasterRig) >= 3
                      ? 'bg-emerald-950/75 border-emerald-400/50 text-emerald-200 hover:border-emerald-300'
                      : 'console-well border-ink-brass/45 text-ink-brass hover:border-ink-brass'
                  }`}
                >
                  <Sparkles className="w-3.5 h-3.5 shrink-0" />
                  <span>
                    {countRigViews(activeMasterRig) >= 3
                      ? `${t('v4Ready360')} (${countRigViews(activeMasterRig)}/4)`
                      : t('v4AnglesPill')}
                  </span>
                </button>
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

                <div className="flex items-center gap-0.5 p-0.5 rounded-lg console-well border border-desk-border font-mono text-[10px]">
                  {([0.5, 1, 1.5] as const).map((sp) => (
                    <button
                      key={sp}
                      type="button"
                      onClick={() => setPlaySpeed(sp)}
                      className={`px-1.5 py-0.5 rounded-md font-bold transition-colors ${
                        playSpeed === sp
                          ? 'bg-desk-panel text-ink-brass'
                          : 'text-desk-muted hover:text-desk-text'
                      }`}
                    >
                      {sp}×
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Live 16:9 Stage Canvas */}
            <div className="flex-1 min-h-0 flex items-center justify-center relative">
              <div
                className={`relative max-w-full max-h-full aspect-video rounded-2xl overflow-hidden border border-black/30 shadow-2xl ${
                  backdrop === 'transparent' ? 'bg-neutral-900/40' : ''
                }`}
              >
                <canvas
                  ref={canvasRef}
                  onPointerDown={handleCanvasPointerDown}
                  onPointerMove={handleCanvasPointerMove}
                  onPointerUp={handleCanvasPointerUp}
                  onPointerCancel={handleCanvasPointerUp}
                  className={`w-full h-full block touch-none ${
                    toolMode === 'drag' ? 'cursor-grab active:cursor-grabbing' : 'cursor-crosshair'
                  }`}
                />

                {/* Cancellable 3-2-1 Live Performance Countdown */}
                {liveRecCountdown !== null && (
                  <div className="absolute inset-0 bg-black/55 flex flex-col items-center justify-center gap-2 pointer-events-none">
                    <span className="font-mono text-7xl font-extrabold text-ink-vermilion drop-shadow-lg">
                      {liveRecCountdown}
                    </span>
                    <span className="font-mono text-xs text-white/95">{t('puppetLiveRecReady')}</span>
                  </div>
                )}

                {liveRecording && (
                  <div className="absolute top-3 left-3 px-3 py-1 rounded-full bg-red-600 text-white font-mono text-xs font-bold flex items-center gap-2 shadow-lg animate-pulse">
                    <span className="w-2 h-2 rounded-full bg-white" />
                    {t('puppetLiveRecBadge')} · {rigFrame + 1}/{activeRig.totalFrames}
                  </div>
                )}
              </div>
            </div>

            {/* Conditional sleek 360° turn slider — ONLY appears when 2+ angles exist! */}
            {activeMasterRig && countRigViews(activeMasterRig) >= 2 && (
              <div className="shrink-0 px-3 py-1.5 rounded-xl console-well border border-ink-brass/35 flex items-center gap-2.5 text-[11px]">
                <span className="font-bold text-ink-brass shrink-0">{t('v4TurnPreviewLabel')}</span>
                <input
                  type="range"
                  min={-180}
                  max={180}
                  step={5}
                  value={puppetAngleDeg}
                  onChange={(e) => setPuppetAngleDeg(Number(e.target.value))}
                  className="flex-1 accent-ink-brass h-1.5 cursor-pointer"
                />
                <span className="font-mono text-desk-muted w-9 text-right shrink-0">
                  {puppetAngleDeg > 0 ? `+${puppetAngleDeg}°` : `${puppetAngleDeg}°`}
                </span>
                {puppetAngleDeg !== 0 && (
                  <button
                    type="button"
                    onClick={() => setPuppetAngleDeg(0)}
                    className="text-[10px] font-bold text-desk-muted hover:text-ink-brass"
                  >
                    0°
                  </button>
                )}
              </div>
            )}

            {/* Bottom Transport & Direct Export Bar */}
            <div className="rounded-2xl bg-desk-surface border border-desk-border px-3 py-2 flex flex-wrap items-center gap-2 shrink-0">
              <KeycapButton
                size="sm"
                variant="vermilion"
                pressed={playing}
                led={playing ? 'emerald' : 'off'}
                ledPulse={playing}
                onClick={() => setPlaying((v) => !v)}
              >
                <MotionPlayIcon playing={playing} className="w-3.5 h-3.5" />
                {playing ? t('puppetStop') : t('puppetPlay')}
              </KeycapButton>

              <KeycapButton
                size="sm"
                variant={liveRecording || liveRecCountdown !== null ? 'vermilion' : 'brass'}
                pressed={liveRecording}
                led={liveRecording ? 'vermilion' : 'amber'}
                ledPulse={liveRecording}
                onClick={handleToggleLiveRec}
              >
                <Radio className="w-3.5 h-3.5" />
                {liveRecCountdown !== null
                  ? `${t('puppetLiveRecCancel')} (${liveRecCountdown})`
                  : liveRecording
                    ? t('puppetLiveRecStop')
                    : t('puppetLiveRec')}
              </KeycapButton>

              <input
                type="range"
                min={0}
                max={Math.max(0, activeRig.totalFrames - 1)}
                value={rigFrame}
                onChange={(e) => {
                  setPlaying(false);
                  setRigFrame(Number(e.target.value));
                }}
                className="studio-fader flex-1 min-w-[100px]"
              />
              <span className="font-mono text-xs text-desk-muted w-12 text-right tabular-nums">
                {rigFrame + 1}/{activeRig.totalFrames}
              </span>

              <button
                type="button"
                disabled={Boolean(exportingKind)}
                onClick={() => void handleSendToDraw()}
                className="px-2.5 py-1.5 rounded-xl console-well border border-desk-border hover:border-ink-brass text-[11px] font-bold text-desk-text inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                <Film className="w-3.5 h-3.5 text-ink-brass" />
                {exportingKind === 'draw' ? exportLabel || `${t('puppetSendingToDraw')}…` : t('puppetSendToDraw')}
              </button>

              <KeycapButton
                data-tour="puppet-export"
                size="sm"
                variant="brass"
                disabled={Boolean(exportingKind)}
                onClick={() => setPuppetExportOpen(true)}
              >
                <Download className="w-3.5 h-3.5" />
                {t('puppetDownloadBtn')}
              </KeycapButton>
            </div>
          </>
        )}
      </div>

      {/* RIGHT CLEAN 3-TAB CONTROL DECK (ZERO VERTICAL OVERFLOW AT 1280x800!) */}
      <aside className="w-full lg:w-[316px] shrink-0 border-t lg:border-t-0 lg:border-l border-desk-border bg-desk-surface flex flex-col lg:overflow-hidden">
        <div className="p-2 border-b border-desk-border flex items-center gap-1 shrink-0">
          {(
            [
              { id: 'motion', label: t('puppetRightTabMotion') },
              { id: 'voice', label: t('puppetRightTabVoice') },
              { id: 'pins', label: t('puppetRightTabPins') },
            ] as const
          ).map((tabItem) => (
            <button
              key={tabItem.id}
              type="button"
              data-tour={tabItem.id === 'voice' ? 'puppet-voice-tab' : undefined}
              onClick={() => {
                soundEngine.click(1.04);
                setRightTab(tabItem.id);
              }}
              className={`flex-1 py-1.5 px-1.5 rounded-lg text-[11px] font-bold border transition-colors flex items-center justify-center gap-1 whitespace-nowrap ${
                rightTab === tabItem.id
                  ? 'bg-desk-panel border-ink-brass text-desk-text shadow-sm'
                  : 'border-transparent text-desk-muted hover:text-desk-text'
              }`}
            >
              {tabItem.id === 'voice' && project.audio && !project.audio.muted && (
                <span className="hardware-led" data-on="emerald" />
              )}
              {tabItem.label}
            </button>
          ))}
        </div>

        <div className="p-3 lg:flex-1 lg:overflow-y-auto space-y-3">
          {/* TAB 1: MOTION & CHARACTER */}
          {rightTab === 'motion' && (
            <>
              <div className="rounded-2xl console-well border border-desk-border p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-desk-muted">
                    {t('puppetSourceTitle')}
                  </span>
                  {activeRig && !confirmDelete && (
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(true)}
                      className="text-desk-muted hover:text-ink-vermilion"
                      title={t('puppetDeleteTitle')}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {activeRig && confirmDelete && (
                    <div className="flex items-center gap-1 font-mono text-[9.5px]">
                      <span className="text-ink-vermilion">{t('puppetDeleteConfirm')}</span>
                      <button
                        type="button"
                        onClick={() => {
                          deleteMeshRig(activeRig.id);
                          setConfirmDelete(false);
                          setPlaying(false);
                        }}
                        className="px-1.5 py-0.5 rounded bg-ink-vermilion text-white font-bold"
                      >
                        {t('puppetDeleteYes')}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(false)}
                        className="px-1.5 py-0.5 rounded bg-desk-panel text-desk-muted"
                      >
                        {t('puppetDeleteNo')}
                      </button>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-3 gap-1.5">
                  <button
                    type="button"
                    onClick={() => void handleLoadSampleCharacter()}
                    className="py-1.5 px-2 rounded-lg bg-desk-surface border border-desk-border hover:border-ink-brass text-[10.5px] font-bold text-desk-text"
                  >
                    {t('puppetBtnSample')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleLoadFromActiveFrame()}
                    className={`py-1.5 px-2 rounded-lg border text-[10.5px] font-bold ${
                      hasDrawnCel
                        ? 'bg-ink-brass/15 border-ink-brass text-desk-text'
                        : 'bg-desk-surface border-desk-border hover:border-desk-muted text-desk-text'
                    }`}
                  >
                    {t('puppetBtnMyArt')}
                  </button>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="py-1.5 px-2 rounded-lg bg-desk-surface border border-desk-border hover:border-desk-muted text-[10.5px] font-bold text-desk-text"
                  >
                    {t('puppetBtnUpload')}
                  </button>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={handleUploadDrawing}
                />
              </div>

              {activeRig && (
                <>
                  {/* 6 1-Tap Motion Presets WITH Clear Active Highlight */}
                  <div
                    data-tour="puppet-moves"
                    className="rounded-2xl console-well border border-desk-border p-3 space-y-2"
                  >
                    <div className="font-mono text-[10px] font-bold uppercase tracking-wider text-ink-brass flex items-center gap-1.5">
                      <Wand2 className="w-3.5 h-3.5" />
                      {t('puppetMovesTitle')}
                    </div>
                    <div className="grid grid-cols-2 gap-1.5">
                      {motionPresets.map((pr) => {
                        const isActive = activePreset === pr.id;
                        return (
                          <button
                            key={pr.id}
                            type="button"
                            onClick={() => applyPreset(pr.id)}
                            className={`py-2 px-2 rounded-xl border text-[11px] font-bold transition-all flex items-center justify-center gap-1.5 ${
                              isActive
                                ? 'bg-desk-panel border-ink-vermilion text-desk-text shadow-sm'
                                : 'bg-desk-surface border-desk-border hover:border-ink-brass text-desk-muted hover:text-desk-text'
                            }`}
                          >
                            {isActive && <span className="hardware-led" data-on="vermilion" />}
                            {pr.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* 6 Expressive Cartoon Facial Emotions (Works on BOTH 2-Bone IK & Elastic Creatures!) */}
                  <div className="rounded-2xl console-well border border-desk-border p-3 space-y-2">
                    <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-desk-muted block">
                      {t('puppetEmotionTitle')}
                    </span>
                    <div className="grid grid-cols-3 gap-1">
                      {emotionOptions.map((em) => {
                        const active = (activeRig.emotion ?? 'neutral') === em.id;
                        return (
                          <button
                            key={em.id}
                            type="button"
                            onClick={() => {
                              commitRig({ ...activeRig, emotion: em.id });
                              soundEngine.click(1.06);
                            }}
                            className={`py-1.5 px-1 rounded-lg border text-[10px] font-bold transition-colors ${
                              active
                                ? 'bg-desk-panel border-ink-brass text-desk-text shadow-sm'
                                : 'bg-desk-surface border-desk-border text-desk-muted hover:text-desk-text'
                            }`}
                          >
                            {em.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Stage Backdrop Selector */}
                  <div className="rounded-2xl console-well border border-desk-border p-3 space-y-2">
                    <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-desk-muted block">
                      {t('puppetBackdropTitle')}
                    </span>
                    <div className="grid grid-cols-4 gap-1">
                      {(
                        [
                          { id: 'paper', label: t('puppetBgPaper') },
                          { id: 'night', label: t('puppetBgNight') },
                          { id: 'sunset', label: t('puppetBgSunset') },
                          { id: 'transparent', label: t('puppetBgClear') },
                        ] as const
                      ).map((bg) => (
                        <button
                          key={bg.id}
                          type="button"
                          onClick={() => setBackdrop(bg.id)}
                          className={`py-1.5 px-1 rounded-lg border text-[10px] font-bold transition-colors ${
                            backdrop === bg.id
                              ? 'bg-desk-panel border-ink-brass text-desk-text'
                              : 'bg-desk-surface border-desk-border text-desk-muted hover:text-desk-text'
                          }`}
                        >
                          {bg.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Clean Bridge to Short Film Studio (Zero "2.5D" jargon, extracts real StyleDNA!) */}
                  <div className="rounded-2xl console-well border border-ink-brass/35 p-3 space-y-2">
                    <div className="font-mono text-[10px] font-bold uppercase tracking-wider text-ink-brass flex items-center gap-1.5">
                      <Clapperboard className="w-3.5 h-3.5" />
                      {t('puppetFilmBridgeTitle')}
                    </div>
                    <KeycapButton
                      size="sm"
                      variant="brass"
                      onClick={() => void handleSendToFilm()}
                      className="w-full"
                    >
                      <Clapperboard className="w-3.5 h-3.5" />
                      {t('puppetFilmBridgeBtn')}
                    </KeycapButton>
                  </div>
                </>
              )}
            </>
          )}

          {/* TAB 2: VOICE & TALKING STUDIO ($0 TYPE-TO-SPEAK + MIC + WAVEFORM + BLINK) */}
          {rightTab === 'voice' && activeRig && (
            <>
              {/* 100% $0 Offline Type & Speak */}
              <div className="rounded-2xl console-well border border-desk-border p-3 space-y-2">
                <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-ink-brass flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5" />
                  {t('puppetVoiceTitle')}
                </span>
                <input
                  type="text"
                  value={speechText}
                  onChange={(e) => setSpeechText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleTypeAndSpeak();
                  }}
                  placeholder={t('puppetVoicePlaceholder')}
                  className="w-full rounded-lg bg-desk-surface border border-desk-border px-2.5 py-1.5 text-xs text-desk-text select-text focus:outline-none focus:border-ink-brass"
                />
                <div className="flex gap-1.5">
                  <select
                    value={voiceTone}
                    onChange={(e) => setVoiceTone(e.target.value)}
                    className="flex-1 min-w-0 rounded-lg bg-desk-surface border border-desk-border px-2 py-1.5 text-[11px] font-bold text-desk-text"
                  >
                    {voiceTones.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.label}
                      </option>
                    ))}
                  </select>
                  <KeycapButton
                    size="sm"
                    variant="brass"
                    disabled={synthesizing}
                    onClick={() => void handleTypeAndSpeak()}
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    {t('puppetVoiceSpeakBtn')}
                  </KeycapButton>
                </div>

                {/* Microphone & File Upload */}
                <div className="flex gap-1.5 pt-1 border-t border-desk-border">
                  <KeycapButton
                    size="sm"
                    variant={micRecording ? 'vermilion' : 'graphite'}
                    led={micRecording ? 'vermilion' : project.audio ? 'emerald' : 'off'}
                    ledPulse={micRecording}
                    onClick={() => void toggleMicRecord()}
                    className="flex-1"
                  >
                    {micRecording ? <Square className="w-3 h-3 fill-current" /> : <Mic className="w-3.5 h-3.5" />}
                    {micRecording ? t('puppetVoiceMicStop') : t('puppetVoiceMicBtn')}
                  </KeycapButton>
                  <button
                    type="button"
                    onClick={() => audioInputRef.current?.click()}
                    className="px-2.5 py-1.5 rounded-lg bg-desk-surface border border-desk-border text-desk-muted hover:text-desk-text"
                    title={t('puppetVoiceUploadTitle')}
                  >
                    <Upload className="w-3.5 h-3.5" />
                  </button>
                  <input
                    ref={audioInputRef}
                    type="file"
                    accept="audio/*"
                    className="hidden"
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      const track = await analyzeAndStoreAudio(f, f.name, project.fps);
                      setAudioTrack(track);
                      setPlaying(true);
                      notify(locale === 'en' ? 'Audio loaded!' : 'Ses yüklendi!');
                    }}
                  />
                </div>

                {/* Active Audio Waveform + Mute + Remove */}
                {project.audio && (
                  <div className="p-2 rounded-xl bg-desk-surface/80 border border-ink-emerald/40 space-y-1.5">
                    <div className="flex items-center justify-between gap-1 font-mono text-[9.5px]">
                      <span className="text-ink-emerald font-bold truncate flex items-center gap-1">
                        <AudioLines className="w-3 h-3 shrink-0" />
                        {project.audio.name} ({project.audio.durationSec.toFixed(1)}s)
                      </span>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => updateAudioTrack({ muted: !project.audio!.muted })}
                          className="p-1 rounded hover:bg-desk-panel text-desk-muted hover:text-desk-text"
                          title={project.audio.muted ? t('puppetVoiceUnmute') : t('puppetVoiceMute')}
                        >
                          {project.audio.muted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5 text-ink-emerald" />}
                        </button>
                        <button
                          type="button"
                          onClick={() => setAudioTrack(null)}
                          className="p-1 rounded hover:bg-desk-panel text-desk-muted hover:text-ink-vermilion"
                          title={t('puppetVoiceClear')}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                    <div className="h-6 flex items-end gap-[2px] px-0.5">
                      {project.audio.peaks.filter((_, idx) => idx % 4 === 0).map((pk, idx) => (
                        <span
                          key={idx}
                          className={`flex-1 rounded-t ${project.audio?.muted ? 'bg-desk-muted/40' : 'bg-ink-emerald/80'}`}
                          style={{ height: `${Math.max(12, Math.round(pk * 100))}%` }}
                        />
                      ))}
                    </div>

                    {/* Real Web Audio Cartoon Voice FX (Live Playback + MP4 Export!) */}
                    <div className="pt-1.5 border-t border-desk-border/70 space-y-1">
                      <span className="font-mono text-[9.5px] font-bold uppercase tracking-wider text-desk-muted block">
                        {t('puppetVoiceFxTitle')}
                      </span>
                      <div className="grid grid-cols-4 gap-1">
                        {voiceFxOptions.map((fx) => {
                          const active = (project.audio?.voiceEffect ?? 'natural') === fx.id;
                          return (
                            <button
                              key={fx.id}
                              type="button"
                              onClick={() => {
                                updateAudioTrack({ voiceEffect: fx.id });
                                soundEngine.click(1.08);
                              }}
                              className={`py-1 px-1 rounded-md border text-[10px] font-bold transition-colors ${
                                active
                                  ? 'bg-desk-panel border-ink-brass text-ink-brass'
                                  : 'bg-desk-surface border-desk-border text-desk-muted hover:text-desk-text'
                              }`}
                            >
                              {fx.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Mouth Position + Mouth Size + Live Auto-Blink */}
              <div className="rounded-2xl console-well border border-desk-border p-3 space-y-2.5">
                <button
                  type="button"
                  onClick={() => setToolMode((m) => (m === 'mouth' ? 'drag' : 'mouth'))}
                  className={`w-full py-2 px-3 rounded-xl text-xs font-bold border transition-colors ${
                    toolMode === 'mouth'
                      ? 'bg-ink-brass text-neutral-950 border-ink-brass shadow'
                      : 'bg-desk-surface border-desk-border hover:border-ink-brass text-desk-text'
                  }`}
                >
                  {t('puppetMouthPosBtn')}
                </button>

                {activeRig.mouthPos && (
                  <div>
                    <div className="flex justify-between font-mono text-[10px] text-desk-muted mb-0.5">
                      <span>{t('puppetMouthSize')}</span>
                      <span className="text-desk-text font-bold">
                        {Math.round(activeRig.mouthPos.scale * 100)}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0.6}
                      max={1.6}
                      step={0.05}
                      value={activeRig.mouthPos.scale}
                      onChange={(e) =>
                        commitRig(
                          {
                            ...activeRig,
                            mouthPos: { ...activeRig.mouthPos!, scale: Number(e.target.value) },
                          },
                          false
                        )
                      }
                      className="studio-fader w-full"
                    />
                  </div>
                )}

                <div className="pt-1.5 border-t border-desk-border flex items-center justify-between">
                  <span className="font-mono text-[10px] font-bold text-desk-text">
                    {t('puppetAutoBlink')}
                  </span>
                  <ToggleLeverSwitch
                    checked={Boolean(activeRig.autoBlink)}
                    onChange={(val) => commitRig({ ...activeRig, autoBlink: val })}
                  />
                </div>
              </div>
            </>
          )}

          {/* TAB 3: PINS, POSE SCOPE & TEXTURE */}
          {rightTab === 'pins' && activeRig && (
            <>
              <div className="rounded-2xl console-well border border-desk-border p-3 space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-desk-muted">
                    {t('puppetPinsTitle')} ({activeRig.pins.length})
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      commitRig({
                        ...activeRig,
                        frames: Array.from({ length: activeRig.totalFrames }, () => ({})),
                      });
                      setActivePreset(null);
                    }}
                    className="font-mono text-[10px] text-desk-muted hover:text-desk-text inline-flex items-center gap-1"
                  >
                    <RotateCcw className="w-3 h-3" />
                    {t('puppetResetPose')}
                  </button>
                </div>

                <div className="grid grid-cols-3 gap-1">
                  {(
                    [
                      { id: 'humanoid', label: t('puppetTplHuman') },
                      { id: 'creature', label: t('puppetTplAnimal') },
                      { id: 'simple', label: t('puppetTplSimple') },
                    ] as const
                  ).map((tpl) => (
                    <button
                      key={tpl.id}
                      type="button"
                      onClick={() => void applyTemplate(tpl.id)}
                      className="py-1.5 rounded-lg border border-desk-border bg-desk-surface text-[10px] font-mono text-desk-muted hover:text-desk-text"
                    >
                      {tpl.label}
                    </button>
                  ))}
                </div>

                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    onClick={() => setToolMode((m) => (m === 'add-pin' ? 'drag' : 'add-pin'))}
                    className={`py-1.5 px-2 rounded-lg text-[11px] font-bold border flex items-center justify-center gap-1 ${
                      toolMode === 'add-pin'
                        ? 'bg-ink-vermilion text-white border-ink-vermilion'
                        : 'bg-desk-surface border-desk-border text-desk-text'
                    }`}
                  >
                    <Plus className="w-3.5 h-3.5" />
                    {t('puppetAddPin')}
                  </button>
                  <button
                    type="button"
                    disabled={!selectedPinId || activeRig.pins.length <= 2}
                    onClick={handleDeleteSelectedPin}
                    className="py-1.5 px-2 rounded-lg text-[11px] font-bold border border-desk-border bg-desk-surface text-ink-vermilion hover:border-ink-vermilion disabled:opacity-40 flex items-center justify-center gap-1"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    {t('puppetDeletePin')}
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    setPlaying(false);
                    setToolMode((m) => (m === 'erase-pocket' ? 'drag' : 'erase-pocket'));
                  }}
                  className={`w-full py-1.5 px-2.5 rounded-lg text-[11px] font-bold border flex items-center justify-center gap-1.5 transition-colors ${
                    toolMode === 'erase-pocket'
                      ? 'bg-ink-emerald text-white border-ink-emerald'
                      : 'bg-desk-surface border-desk-border text-desk-text hover:border-ink-emerald'
                  }`}
                >
                  <Wand2 className="w-3.5 h-3.5" />
                  {t('puppetErasePocket')}
                </button>

                {/* Drag Scope: Full Loop vs Single Frame */}
                <div className="pt-2 border-t border-desk-border space-y-1">
                  <span className="font-mono text-[9.5px] text-desk-muted block">
                    {t('puppetEditScope')}
                  </span>
                  <div className="grid grid-cols-2 gap-1">
                    <button
                      type="button"
                      onClick={() => setEditScope('all')}
                      className={`py-1 rounded-lg text-[10.5px] font-bold border ${
                        editScope === 'all'
                          ? 'bg-desk-panel border-ink-brass text-desk-text'
                          : 'bg-desk-surface border-desk-border text-desk-muted'
                      }`}
                    >
                      {t('puppetScopeAll')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditScope('single')}
                      className={`py-1 rounded-lg text-[10.5px] font-bold border ${
                        editScope === 'single'
                          ? 'bg-desk-panel border-ink-brass text-desk-text'
                          : 'bg-desk-surface border-desk-border text-desk-muted'
                      }`}
                    >
                      {t('puppetScopeSingle')}
                    </button>
                  </div>
                </div>
              </div>

              {/* Hand-Drawn Wobble + Mesh Lines + Loop Length */}
              <div className="rounded-2xl console-well border border-desk-border p-3 space-y-2.5">
                <div>
                  <div className="flex justify-between font-mono text-[10px] text-desk-muted mb-0.5">
                    <span>{t('puppetWobbleLabel')}</span>
                    <span className="text-desk-text font-bold">
                      {Math.round(activeRig.lineBoil * 100)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={activeRig.lineBoil}
                    onChange={(e) =>
                      commitRig({ ...activeRig, lineBoil: Number(e.target.value) }, false)
                    }
                    className="studio-fader w-full"
                  />
                </div>

                <div className="flex items-center justify-between">
                  <span className="font-mono text-[10px] text-desk-muted flex items-center gap-1.5">
                    <Grid className="w-3.5 h-3.5" />
                    {t('puppetGridToggle')}
                  </span>
                  <ToggleLeverSwitch checked={showMeshGrid} onChange={setShowMeshGrid} />
                </div>

                <div className="pt-1.5 border-t border-desk-border space-y-1">
                  <span className="font-mono text-[9.5px] text-desk-muted block">
                    {t('puppetLoopFrames')}
                  </span>
                  <div className="grid grid-cols-3 gap-1">
                    {[12, 24, 36].map((cnt) => (
                      <button
                        key={cnt}
                        type="button"
                        onClick={() => handleChangeLoopLength(cnt)}
                        className={`py-1 rounded-lg font-mono text-[10.5px] font-bold border ${
                          activeRig.totalFrames === cnt
                            ? 'bg-desk-panel border-ink-brass text-desk-text'
                            : 'bg-desk-surface border-desk-border text-desk-muted'
                        }`}
                      >
                        {cnt}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </aside>

      {/* UNIFIED PUPPET EXPORT MODAL (Opened by BOTH TopConsoleBar 'İndir' AND Bottom 'Kuklayı İndir'!) */}
      {puppetExportOpen && activeRig && (
        <div
          onClick={() => !exportingKind && setPuppetExportOpen(false)}
          className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
        >
          <div
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-2xl rounded-3xl bg-desk-surface border border-desk-border shadow-2xl overflow-hidden"
          >
            <div className="px-5 py-4 border-b border-desk-border flex items-center justify-between">
              <div>
                <h2 className="text-base font-extrabold text-desk-text">{t('puppetExportTitle')}</h2>
                <p className="font-mono text-[10.5px] text-desk-muted mt-0.5">
                  {activeRig.name} · {activeRig.pins.length} · {activeRig.totalFrames} · {t('puppetExportSub')}
                </p>
              </div>
              <button
                type="button"
                disabled={Boolean(exportingKind)}
                onClick={() => setPuppetExportOpen(false)}
                className="p-2 rounded-xl console-well border border-desk-border text-desk-muted hover:text-desk-text disabled:opacity-40"
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
                {exportingKind !== 'draw' && (
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => {
                        exportAbortRef.current = true;
                      }}
                      className="px-3 py-1 rounded-lg bg-desk-panel border border-desk-border hover:border-ink-vermilion font-mono text-[10.5px] font-bold text-ink-vermilion"
                    >
                      {t('filmExportCancel')}
                    </button>
                  </div>
                )}
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
                  disabled={Boolean(exportingKind)}
                  onClick={() => void handleExportPuppetVideo()}
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
                  disabled={Boolean(exportingKind)}
                  onClick={() => void handleExportPuppetGif()}
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
                  disabled={Boolean(exportingKind)}
                  onClick={() => void handleDownloadPuppetPng()}
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
                  disabled={Boolean(exportingKind)}
                  onClick={() => void handleSendToDraw()}
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
      {modalInitialRig && (
        <CharacterMasterModal
          open={masterModalOpen}
          initialRig={modalInitialRig}
          onClose={() => setMasterModalOpen(false)}
          onSave={(saved) => {
            setActiveMasterRig(saved);
            setModalInitialRig(saved);
            setMasterModalOpen(false);
            if (puppetMasterCacheRef.current) {
              puppetMasterCacheRef.current.syncRig(saved);
            }
            const vc = countRigViews(saved);
            notify(
              locale === 'en'
                ? `Saved ${vc}/4 2.5D angles for "${saved.name}"`
                : `"${saved.name}" için ${vc}/4 2.5D açı kaydedildi`,
              'ok'
            );
          }}
        />
      )}
    </div>
  );
}
