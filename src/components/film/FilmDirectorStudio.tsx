import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  AudioLines,
  ChevronDown,
  ChevronUp,
  Clapperboard,
  CloudLightning,
  Copy,
  Crosshair,
  Download,
  Film,
  Image as ImageIcon,
  Layers,
  Mic,
  Music,
  Package,
  Palette,
  Plus,
  Redo2,
  Repeat,
  Scissors,
  SlidersHorizontal,
  Sparkles,
  Square,
  Trash2,
  Undo2,
  Upload,
  Video,
  Volume2,
  Wand2,
  X,
} from 'lucide-react';
import { useStudioStore } from '../../store/useStudioStore';
import { localizeActorName, localizeProjectName, localizeSceneOrNote, useT, useTFmt, type TranslationKey } from '../../i18n/translations';
import { safeSetPointerCapture } from '../../utils/pointerCapture';
import { useModalA11y } from '../../hooks/useModalA11y';
import type {
  CinemaLookId,
  FilmActionId,
  FilmActor,
  FilmEmotionId,
  FilmProjectGraph,
  FilmPropId,
  FilmShot,
  LivePerformanceOverride,
  MotionCaptureTrack,
  ShotFraming,
  ShotTimingMode,
  VisemeId,
  VoiceLipSyncTrack,
  WeatherKind,
  WorldSetId,
} from '../../types/film';
import {
  applyDirectedScreenplayToFilmGraph,
  compileDirectorPromptToFilmGraph,
  computeFilmCameraState,
  DIRECTOR_PRESETS,
  evaluateCharacterPose25D,
  extractStyleDNAFromCanvas,
  getDefaultHeroActorCanvas,
  getGraphActors,
  mapUniversalActionToLegacyFilmAction,
  patchShotFromRevisionPrompt,
  projectWorldToScreen,
  render25DFilmFrame,
  render25DFilmFrameAtGlobalTime,
  resolveFilmTimeline,
  unprojectScreenToWorld,
} from '../../engine/film25dEngine';
import { requestAiDirectedFilm } from '../../engine/aiStudioClient';
import {
  countRigViews,
  createMasterRigFromFront,
  type CharacterMasterRig,
} from '../../types/masterRig';
import { extractViewAnchorsFromCanvas } from '../../engine/turnaroundSlicer';
import { MasterRigRuntimeCache } from '../../engine/viewRigBlender';
import { UNIVERSAL_CREATURE_CATALOG, type UniversalActionId } from '../../engine/universalCreatureRig';
import CharacterMasterModal from '../rig/CharacterMasterModal';
import { FilmFoleyEngine } from '../../engine/filmFoleyEngine';
import {
  onSampleHeroReady,
  SAMPLE_HERO_NAME_TR,
} from '../../engine/sampleHeroAsset';
import {
  analyzeAudioBlobToLipSyncTrack,
  analyzePCMToLipSyncTrack,
  classifyLiveAnalyserViseme,
  synthesizeCartoonDialogueWav,
} from '../../engine/filmMocapLipSync';
import {
  decomposeBackgroundPipeline,
  decomposeCharacterPipeline,
  exportKagit25dPackage,
  importKagit25dPackage,
  loadSavedCloudUrl,
  pingCloudPipeline,
  saveCloudUrl,
  synthesizeCharacterVoiceRemote,
  transcodeBroadcastMp4Remote,
  type CloudPipelineStatus,
} from '../../engine/kagit25dPipeline';
import { drawKagitSealStamp, triggerDownload } from '../../engine/exportEngine';
import {
  encodeFramesToMp4WebCodecs,
  pickBestMediaRecorderFormat,
} from '../../engine/videoExportEngine';
import { runGifEncode } from '../../engine/paperWorkerClient';
import { renderFrameComposite } from '../../engine/frameComposite';
import { canvasToPngBlob, getBlobBitmap, loadBlob, makeId, saveBlob } from '../../engine/db';
import { soundEngine } from '../../engine/soundEngine';
import { BlobImage, KeycapButton } from '../ui/KeycapButton';
import { ToggleLeverSwitch } from '../ui/Studio3DControls';
import { MotionPlayIcon } from '../ui/AnimatedStudioIcons';
import PerformanceMocapDeck from './PerformanceMocapDeck';
import { prepareCharacterCanvas } from '../../engine/characterIntakeEngine';

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image failed to load'));
    img.src = src;
  });
}

const CINEMA_LOOK_SWATCHES: Record<CinemaLookId, string> = {
  natural: 'from-[#F4EBD9] via-[#D99B26]/35 to-[#2D2620]',
  watercolor: 'from-[#FFE4B5] via-[#E58A52]/65 to-[#3D3129]',
  'cinema-35mm': 'from-[#23485E] via-[#D97C36]/60 to-[#141A24]',
  'vibrant-anime': 'from-[#68B8FF] via-[#FFD88B]/65 to-[#1F3A68]',
  'vintage-ink': 'from-[#DEC9A4] via-[#8F6F49]/70 to-[#2A2018]',
};

const MAX_UNDO_HISTORY = 30;

export default function FilmDirectorStudio() {
  const t = useT();
  const tf = useTFmt();
  const {
    projects,
    activeProjectId,
    activeFrameIndex,
    locale,
    soundEnabled,
    filmExportOpen,
    setFilmExportOpen,
    updateFilmGraph,
    bakeRenderedShotToFrames,
    notify,
  } = useStudioStore();

  const project = projects.find((p) => p.id === activeProjectId);
  const graph: FilmProjectGraph = useMemo(
    () => project?.filmGraph ?? compileDirectorPromptToFilmGraph(DIRECTOR_PRESETS[0].prompt),
    [project?.filmGraph]
  );

  // Localized option lists
  const actionOptions = useMemo<{ id: FilmActionId; label: string }[]>(
    () => [
      { id: 'walk-tired', label: t('filmActWalkTired') },
      { id: 'walk-hero', label: t('filmActWalkHero') },
      { id: 'run', label: t('filmActRun') },
      { id: 'surprise', label: t('filmActSurprise') },
      { id: 'kneel-pickup', label: t('filmActKneel') },
      { id: 'jump-joy', label: t('filmActJump') },
      { id: 'wave', label: t('filmActWave') },
      { id: 'talk-hero', label: t('filmActTalk') },
      { id: 'idle-breathe', label: t('filmActIdle') },
    ],
    [t]
  );

  const emotionOptions = useMemo<{ id: FilmEmotionId; label: string }[]>(
    () => [
      { id: 'neutral', label: t('filmMoodNeutral') },
      { id: 'tired', label: t('filmMoodTired') },
      { id: 'surprised', label: t('filmMoodSurprised') },
      { id: 'happy', label: t('filmMoodHappy') },
      { id: 'determined', label: t('filmMoodDetermined') },
      { id: 'angry', label: t('filmMoodAngry') },
    ],
    [t]
  );

  const framingOptions = useMemo<{ id: ShotFraming; label: string }[]>(
    () => [
      { id: 'wide', label: t('filmFrameWide') },
      { id: 'medium', label: t('filmFrameMedium') },
      { id: 'closeup', label: t('filmFrameCloseup') },
      { id: 'low-angle', label: t('filmFrameLow') },
    ],
    [t]
  );

  const framingLabelMap = useMemo<Record<ShotFraming, string>>(
    () => ({
      wide: t('filmFrameWide'),
      medium: t('filmFrameMedium'),
      closeup: t('filmFrameCloseup'),
      'low-angle': t('filmFrameLow'),
    }),
    [t]
  );

  const timingOptions = useMemo<{ id: ShotTimingMode; label: string }[]>(
    () => [
      { id: 'on2s-12fps', label: t('filmRhythmClassic') },
      { id: 'hybrid-12-24', label: t('filmRhythmHybrid') },
      { id: 'smooth-24fps', label: t('filmRhythmSmooth') },
    ],
    [t]
  );

  const propOptions = useMemo<{ id: FilmPropId; label: string }[]>(
    () => [
      { id: 'none', label: t('filmPropNone') },
      { id: 'glowing-letter', label: t('filmPropLetter') },
      { id: 'lantern', label: t('filmPropLantern') },
      { id: 'umbrella', label: t('filmPropUmbrella') },
    ],
    [t]
  );

  const weatherOptions = useMemo<{ id: WeatherKind; label: string }[]>(
    () => [
      { id: 'none', label: t('filmWeatherNone') },
      { id: 'rain', label: t('filmWeatherRain') },
      { id: 'wind-leaves', label: t('filmWeatherLeaves') },
      { id: 'fireflies', label: t('filmWeatherFireflies') },
      { id: 'snow', label: t('filmWeatherSnow') },
    ],
    [t]
  );

  const cinemaLooks = useMemo<{ id: CinemaLookId; label: string; desc: string }[]>(
    () => [
      { id: 'natural', label: t('filmLookNatural'), desc: t('filmLookNaturalDesc') },
      { id: 'watercolor', label: t('filmLookWatercolor'), desc: t('filmLookWatercolorDesc') },
      { id: 'cinema-35mm', label: t('filmLookCinema35'), desc: t('filmLookCinema35Desc') },
      { id: 'vibrant-anime', label: t('filmLookAnime'), desc: t('filmLookAnimeDesc') },
      { id: 'vintage-ink', label: t('filmLookVintage'), desc: t('filmLookVintageDesc') },
    ],
    [t]
  );

  const studioVoices = useMemo(
    () => [
      { id: 'Puck', label: t('filmVoiceYoungHero') },
      { id: 'Aoede', label: t('filmVoiceWarmNarrator') },
      { id: 'Kore', label: t('filmVoiceSoftGentle') },
      { id: 'Charon', label: t('filmVoiceDeepDrama') },
    ],
    [t]
  );

  // Core Director UI State
  const [promptDraft, setPromptDraft] = useState(() => localizeSceneOrNote(graph.prompt, locale));
  const [revisionDraft, setRevisionDraft] = useState('');
  const [selectedShotIdx, setSelectedShotIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [playAllMode, setPlayAllMode] = useState(true);
  const [globalSec, setGlobalSec] = useState(0);
  const [showGizmos, setShowGizmos] = useState(false);
  const [soundOn, setSoundOn] = useState(graph.foleyEnabled);
  const [musicOn, setMusicOn] = useState(graph.musicBedEnabled);
  const [leftTab, setLeftTab] = useState<'story' | 'stage' | 'look' | 'inspector'>('story');
  const [rightTab, setRightTab] = useState<'acting' | 'camera'>('acting');
  const [cameraFineOpen, setCameraFineOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Undo / Redo History Stacks
  const historyPastRef = useRef<FilmProjectGraph[]>([]);
  const historyFutureRef = useRef<FilmProjectGraph[]>([]);
  const [historyCounts, setHistoryCounts] = useState({ past: 0, future: 0 });

  // Export & Baking State
  const [exportingKind, setExportingKind] = useState<null | 'video' | 'gif' | 'draw'>(null);
  const activeTourMode = useStudioStore((st) => st.activeTourMode);
  useEffect(() => {
    if (activeTourMode === 'film' && leftTab !== 'story') {
      setLeftTab('story');
    }
  }, [activeTourMode, leftTab]);
  useEffect(() => {
    setPromptDraft((cur) => localizeSceneOrNote(cur, locale));
  }, [locale]);
  const filmExportDialogRef = useModalA11y<HTMLDivElement>({
    open: filmExportOpen,
    onClose: () => setFilmExportOpen(false),
    closeDisabled: Boolean(exportingKind),
    modal: true,
  });
  const [exportPct, setExportPct] = useState(0);
  const [exportLabel, setExportLabel] = useState('');
  const exportAbortRef = useRef(false);

  // Decompose, Voice & Optional Local Server State (ZERO auto-ping on mount!)
  const [decomposingActor, setDecomposingActor] = useState(false);
  const [decomposingBg, setDecomposingBg] = useState(false);
  const [compilingRemote, setCompilingRemote] = useState(false);
  const [cloudUrl, setCloudUrl] = useState(() => loadSavedCloudUrl());
  const [cloudStatus, setCloudStatus] = useState<CloudPipelineStatus>({
    online: false,
    url: '',
    device: 'browser',
    mode: 'offline',
    models: [],
  });
  const [pingingCloud, setPingingCloud] = useState(false);

  // Offline Before/After Cinema Look Split Curtain
  const [comparePreview, setComparePreview] = useState<{
    beforeUrl: string;
    afterUrl: string;
    lookLabel: string;
  } | null>(null);
  const [compareSplitPct, setCompareSplitPct] = useState(52);

  // Mocap & Voice State
  const [mocapDeckOpen, setMocapDeckOpen] = useState(false);
  const [recordingVoice, setRecordingVoice] = useState(false);
  const [analyzingVoice, setAnalyzingVoice] = useState(false);
  const [synthesizingVoice, setSynthesizingVoice] = useState(false);
  const [aiVoiceName, setAiVoiceName] = useState('Puck');
  const [liveVoiceVu, setLiveVoiceVu] = useState(0);
  const [liveVoiceViseme, setLiveVoiceViseme] = useState<VisemeId>('closed');

  // Refs for smooth 60 FPS playback without React re-render churn
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const actorFileRef = useRef<HTMLInputElement | null>(null);
  const extraActorFileRef = useRef<HTMLInputElement | null>(null);
  const bgFileRef = useRef<HTMLInputElement | null>(null);

  // V4 1..6 Multi-Actor Cast & Shared 360° 2.5D Master Modal State
  const castActors = useMemo(() => getGraphActors(graph), [graph]);
  const [selectedActorId, setSelectedActorId] = useState<string>(graph.actor.id);
  const selectedActor = useMemo(
    () => castActors.find((a) => a.id === selectedActorId) ?? graph.actor,
    [castActors, selectedActorId, graph.actor]
  );
  const extraActorBitmapsRef = useRef<Map<string, HTMLCanvasElement | ImageBitmap>>(new Map());
  const actorMasterCachesRef = useRef<Map<string, MasterRigRuntimeCache>>(new Map());
  const [masterModalOpen, setMasterModalOpen] = useState(false);
  const [masterModalInitialRig, setMasterModalInitialRig] = useState<CharacterMasterRig | null>(null);
  const pkgImportRef = useRef<HTMLInputElement | null>(null);
  const voiceFileRef = useRef<HTMLInputElement | null>(null);

  const actorBitmapRef = useRef<HTMLCanvasElement | ImageBitmap>(getDefaultHeroActorCanvas());
  const customBgBitmapRef = useRef<ImageBitmap | null>(null);
  const decomposedPartsMapRef = useRef<Map<string, ImageBitmap>>(new Map());
  const bgPlanesMapRef = useRef<Map<string, ImageBitmap>>(new Map());
  const foleyRef = useRef<FilmFoleyEngine | null>(null);
  const liveOverrideRef = useRef<LivePerformanceOverride | null>(null);

  const graphRef = useRef(graph);
  graphRef.current = graph;
  const playAllModeRef = useRef(playAllMode);
  playAllModeRef.current = playAllMode;
  const soundOnRef = useRef(soundOn);
  soundOnRef.current = soundOn;
  const musicOnRef = useRef(musicOn);
  musicOnRef.current = musicOn;
  const masterSoundRef = useRef(soundEnabled);
  masterSoundRef.current = soundEnabled;
  const globalSecRef = useRef(globalSec);
  globalSecRef.current = globalSec;
  const selectedShotIdxRef = useRef(selectedShotIdx);
  selectedShotIdxRef.current = selectedShotIdx;
  const showGizmosRef = useRef(showGizmos);
  showGizmosRef.current = showGizmos;
  const gazeLabelRef = useRef(t('filmGazeLabel'));
  gazeLabelRef.current = t('filmGazeLabel');

  // Fixed Mic Recording Refs (ZERO stale closure bug!)
  const recordingVoiceRef = useRef(false);
  const voiceRecRef = useRef<MediaRecorder | null>(null);
  const voiceStreamRef = useRef<MediaStream | null>(null);
  const voiceCtxRef = useRef<AudioContext | null>(null);
  const voiceRafRef = useRef<number>(0);
  const voiceChunksRef = useRef<Blob[]>([]);

  const dragTargetRef = useRef<{ kind: 'waypoint'; idx: number } | { kind: 'lookAt' } | null>(null);
  const [assetVersion, setAssetVersion] = useState(0);

  const safeShotIdx = Math.max(0, Math.min(graph.shots.length - 1, selectedShotIdx));
  const activeShot = graph.shots[safeShotIdx] ?? graph.shots[0];
  const totalDuration = useMemo(
    () => graph.shots.reduce((s, sh) => s + Math.max(0.5, sh.durationSec), 0),
    [graph.shots]
  );
  const hasDrawnCel = useMemo(
    () =>
      Boolean(
        project?.frames.some((f) => f.layers.some((l) => Boolean(l.blobKey)))
      ),
    [project?.frames]
  );

  // Sync promptDraft when active project or prompt changes externally
  useEffect(() => {
    setPromptDraft(localizeSceneOrNote(graph.prompt, locale));
  }, [project?.id, graph.prompt, locale]);

  // Persist initial default filmGraph if project opened straight into film mode
  useEffect(() => {
    if (project && !project.filmGraph) {
      updateFilmGraph(graph);
    }
  }, [project, graph, updateFilmGraph]);

  // Undo-aware graph commit
  const commitGraph = useCallback(
    (next: FilmProjectGraph, recordHistory = true) => {
      if (recordHistory) {
        historyPastRef.current = [...historyPastRef.current.slice(-(MAX_UNDO_HISTORY - 1)), graphRef.current];
        historyFutureRef.current = [];
        setHistoryCounts({ past: historyPastRef.current.length, future: 0 });
      }
      updateFilmGraph(next);
    },
    [updateFilmGraph]
  );

  const handleUndo = useCallback(() => {
    const past = historyPastRef.current;
    if (past.length === 0) return;
    const prev = past[past.length - 1];
    historyPastRef.current = past.slice(0, -1);
    historyFutureRef.current = [graphRef.current, ...historyFutureRef.current.slice(0, MAX_UNDO_HISTORY - 1)];
    setHistoryCounts({ past: historyPastRef.current.length, future: historyFutureRef.current.length });
    updateFilmGraph(prev);
    soundEngine.click(0.92);
  }, [updateFilmGraph]);

  const handleRedo = useCallback(() => {
    const future = historyFutureRef.current;
    if (future.length === 0) return;
    const next = future[0];
    historyFutureRef.current = future.slice(1);
    historyPastRef.current = [...historyPastRef.current, graphRef.current];
    setHistoryCounts({ past: historyPastRef.current.length, future: historyFutureRef.current.length });
    updateFilmGraph(next);
    soundEngine.click(1.08);
  }, [updateFilmGraph]);

  const patchActiveShot = useCallback(
    (updater: (shot: FilmShot) => FilmShot, recordHistory = true) => {
      const cur = graphRef.current;
      const idx = Math.max(0, Math.min(cur.shots.length - 1, selectedShotIdxRef.current));
      const nextShots = cur.shots.map((s, i) => (i === idx ? updater(s) : s));
      commitGraph({ ...cur, shots: nextShots }, recordHistory);
    },
    [commitGraph]
  );

  // Repaint automatically the instant the official Baron mascot PNG finishes decoding on cold mount
  useEffect(() => {
    return onSampleHeroReady(() => {
      if (!graphRef.current.actor.sourceBlobKey) {
        actorBitmapRef.current = getDefaultHeroActorCanvas();
        setAssetVersion((v) => v + 1);
      }
    });
  }, []);

  // Decode Actor, Custom BG, Decomposed Parts & 5-Plane BG Bitmaps cleanly
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (graph.actor.sourceBlobKey) {
        const bmp = await getBlobBitmap(graph.actor.sourceBlobKey);
        if (!cancelled) actorBitmapRef.current = bmp ?? getDefaultHeroActorCanvas();
      } else {
        actorBitmapRef.current = getDefaultHeroActorCanvas();
      }

      if (graph.world.customBgBlobKey) {
        const bgBmp = await getBlobBitmap(graph.world.customBgBlobKey);
        if (!cancelled) customBgBitmapRef.current = bgBmp;
      } else {
        customBgBitmapRef.current = null;
      }

      const partMap = new Map<string, ImageBitmap>();
      if (graph.actor.decomposed?.parts) {
        for (const pt of graph.actor.decomposed.parts) {
          const bmp = await getBlobBitmap(pt.blobKey);
          if (bmp && !cancelled) partMap.set(pt.blobKey, bmp);
        }
      }
      if (!cancelled) decomposedPartsMapRef.current = partMap;

      const planeMap = new Map<string, ImageBitmap>();
      if (graph.world.decomposedBg?.planes) {
        for (const pl of graph.world.decomposedBg.planes) {
          const bmp = await getBlobBitmap(pl.blobKey);
          if (bmp && !cancelled) planeMap.set(pl.blobKey, bmp);
        }
      }
      if (!cancelled) {
        bgPlanesMapRef.current = planeMap;
      }

      // Decode secondary 2..6 cast bitmaps & sync 360° MasterRig runtime caches
      const extraMap = new Map<string, HTMLCanvasElement | ImageBitmap>();
      const allCast = getGraphActors(graph);
      for (const act of allCast) {
        if (act.id !== graph.actor.id) {
          if (act.sourceBlobKey) {
            const b = await getBlobBitmap(act.sourceBlobKey);
            if (b && !cancelled) extraMap.set(act.id, b);
          } else {
            extraMap.set(act.id, getDefaultHeroActorCanvas());
          }
        }
        if (act.masterRig) {
          const existing = actorMasterCachesRef.current.get(act.id);
          if (existing) existing.syncRig(act.masterRig);
          else actorMasterCachesRef.current.set(act.id, new MasterRigRuntimeCache(act.masterRig));
        }
      }
      if (!cancelled) {
        extraActorBitmapsRef.current = extraMap;
        setAssetVersion((v) => v + 1);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    graph.actor.sourceBlobKey,
    graph.actor.decomposed,
    graph.actor.masterRig,
    graph.actors,
    graph.world.customBgBlobKey,
    graph.world.decomposedBg,
  ]);

  // Render helper (supports full timeline cross-dissolve in All mode or single-shot loop)
  const drawFrameAt = useCallback(
    (timeSec: number, isLivePlaying: boolean) => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      const curGraph = graphRef.current;
      const opts = {
        actorSource: actorBitmapRef.current,
        extraActorSources: extraActorBitmapsRef.current,
        actorMasterCaches: actorMasterCachesRef.current,
        decomposedPartBitmaps: decomposedPartsMapRef.current,
        customBgSource: customBgBitmapRef.current,
        bgPlaneBitmaps: bgPlanesMapRef.current,
        liveOverride: liveOverrideRef.current,
        showDirectorGizmos: !isLivePlaying && showGizmosRef.current,
        showLetterbox: curGraph.world.letterbox ?? curGraph.world.cinemaGrade,
        gazeLabel: gazeLabelRef.current,
      };

      if (playAllModeRef.current) {
        return render25DFilmFrameAtGlobalTime(ctx, curGraph, timeSec, canvas.width, canvas.height, opts);
      }
      const idx = Math.max(0, Math.min(curGraph.shots.length - 1, selectedShotIdxRef.current));
      const shot = curGraph.shots[idx];
      const dur = Math.max(0.5, shot.durationSec);
      const localSec = ((timeSec % dur) + dur) % dur;
      const tel = render25DFilmFrame(ctx, curGraph, shot, localSec, canvas.width, canvas.height, opts);
      return { ...tel, shotIndex: idx, localSec, totalDuration: dur };
    },
    []
  );

  // Sync live pose override cleanly without full React re-render
  const handleLivePoseChange = useCallback(
    (override: LivePerformanceOverride | null) => {
      liveOverrideRef.current = override;
      if (!playing) {
        drawFrameAt(globalSecRef.current, false);
      }
    },
    [playing, drawFrameAt]
  );

  // Repaint whenever paused state, graph, assets, gizmos or scrubber changes
  useEffect(() => {
    if (!playing) {
      drawFrameAt(globalSec, false);
    }
  }, [playing, globalSec, graph, safeShotIdx, playAllMode, showGizmos, assetVersion, locale, drawFrameAt]);

  // Smoothly reflect live sound/music/master-mute changes WITHOUT restarting playback!
  useEffect(() => {
    if (!playing || !foleyRef.current) return;
    const effectiveSound = soundOn && soundEnabled;
    foleyRef.current.setMasterMuted(!effectiveSound);
    if (effectiveSound) {
      foleyRef.current.updateAmbience(graph.world.weather, graph.world.weatherIntensity, musicOn);
    }
  }, [playing, soundOn, soundEnabled, musicOn, graph.world.weather, graph.world.weatherIntensity]);

  // ROCK-SOLID CONTINUOUS PLAYBACK ENGINE (Zero audio restart on shot cuts, throttled scrubber UI!)
  useEffect(() => {
    if (!playing) {
      foleyRef.current?.stop();
      return;
    }

    if (!foleyRef.current) foleyRef.current = new FilmFoleyEngine({ monitorToSpeakers: true });
    const foley = foleyRef.current;
    const initialGraph = graphRef.current;
    const effectiveAudio = soundOnRef.current && masterSoundRef.current;
    foley.setMasterMuted(!effectiveAudio);
    if (effectiveAudio) {
      foley.startAmbience(
        initialGraph.world.weather,
        initialGraph.world.weatherIntensity,
        musicOnRef.current
      );
    }

    let rafId = 0;
    let lastTs = performance.now();
    let lastUiSyncTs = lastTs;
    let accSec = globalSecRef.current;
    let wasFootContact = false;
    let lastShotIdx = -1;
    let thunderFiredForShot = -1;

    const triggerShotVoiceIfPresent = (shot: FilmShot, offsetSec: number) => {
      if (!soundOnRef.current || !masterSoundRef.current) return;
      if (shot.voiceTrack?.audioBlobKey) {
        const key = shot.voiceTrack.audioBlobKey;
        void loadBlob(key).then((blob) => {
          if (blob) void foley.playVoiceBlob(key, blob, offsetSec);
        });
      } else {
        foley.stopVoice();
      }
    };

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - lastTs) / 1000);
      lastTs = now;

      const curGraph = graphRef.current;
      const loopDur = playAllModeRef.current
        ? curGraph.shots.reduce((s, sh) => s + Math.max(0.5, sh.durationSec), 0)
        : Math.max(0.5, curGraph.shots[Math.min(curGraph.shots.length - 1, selectedShotIdxRef.current)].durationSec);

      accSec += dt;
      if (accSec >= loopDur) {
        accSec = 0;
        wasFootContact = false;
        lastShotIdx = -1;
        thunderFiredForShot = -1;
      }
      globalSecRef.current = accSec;

      const res = drawFrameAt(accSec, true);
      if (res) {
        if (res.shotIndex !== lastShotIdx) {
          lastShotIdx = res.shotIndex;
          wasFootContact = false;
          thunderFiredForShot = -1;
          if (playAllModeRef.current && res.shotIndex !== selectedShotIdxRef.current) {
            selectedShotIdxRef.current = res.shotIndex;
            setSelectedShotIdx(res.shotIndex);
          }
          const sh = curGraph.shots[res.shotIndex];
          if (sh) triggerShotVoiceIfPresent(sh, res.localSec);
        }

        if (soundOnRef.current && masterSoundRef.current) {
          foley.setDialogueDucking(res.speaking);
          if (res.pose.footContact && !wasFootContact) {
            foley.triggerFootstep(curGraph.world.setId, 0.85);
          }
          wasFootContact = res.pose.footContact;
          if (res.lightningFlash > 0.7 && thunderFiredForShot !== res.shotIndex) {
            thunderFiredForShot = res.shotIndex;
            foley.triggerThunder();
          }
        }
      }

      // Throttle React scrubber readout to ~15 Hz (zero 60 FPS full-tree re-renders!)
      if (now - lastUiSyncTs >= 66) {
        lastUiSyncTs = now;
        setGlobalSec(accSec);
      }
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafId);
      foley.stop();
      setGlobalSec(globalSecRef.current);
    };
  }, [playing, drawFrameAt]);

  // Clean up mic & foley on unmount
  useEffect(() => {
    return () => {
      cancelAnimationFrame(voiceRafRef.current);
      voiceStreamRef.current?.getTracks().forEach((tr) => tr.stop());
      if (voiceCtxRef.current) void voiceCtxRef.current.close().catch(() => {});
      foleyRef.current?.dispose();
    };
  }, []);

  // =========================================================================
  // INTERACTIVE PIXEL-ACCURATE ROTA & BAKIŞ POINTER DRAG (PROJECTED MATRIX!)
  // =========================================================================
  const getStageCameraContext = () => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const localSec = playAllMode
      ? resolveFilmTimeline(graph.shots, globalSec).localSec
      : globalSec % Math.max(0.5, activeShot.durationSec);
    const pose = evaluateCharacterPose25D(activeShot, localSec, graph.world.horizonY, liveOverrideRef.current);
    const cam = computeFilmCameraState(graph, activeShot, pose, localSec);
    return { canvas, cam };
  };

  const handleStagePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (playing || !showGizmos) return;
    const ctxInfo = getStageCameraContext();
    if (!ctxInfo) return;
    const { canvas, cam } = ctxInfo;
    const rect = canvas.getBoundingClientRect();
    const sx = ((e.clientX - rect.left) / Math.max(1, rect.width)) * canvas.width;
    const sy = ((e.clientY - rect.top) / Math.max(1, rect.height)) * canvas.height;

    const hitRadius = 26;
    if (activeShot.lookAt) {
      const lp = projectWorldToScreen(activeShot.lookAt.x, activeShot.lookAt.y, cam, canvas.width, canvas.height);
      if (Math.hypot(sx - lp.x, sy - lp.y) < hitRadius) {
        dragTargetRef.current = { kind: 'lookAt' };
        safeSetPointerCapture(e.currentTarget, e.pointerId);
        return;
      }
    }

    for (let i = 0; i < activeShot.motionPath.length; i++) {
      const sp = projectWorldToScreen(
        activeShot.motionPath[i].x,
        activeShot.motionPath[i].y,
        cam,
        canvas.width,
        canvas.height
      );
      if (Math.hypot(sx - sp.x, sy - sp.y) < hitRadius) {
        dragTargetRef.current = { kind: 'waypoint', idx: i };
        safeSetPointerCapture(e.currentTarget, e.pointerId);
        return;
      }
    }
  };

  const handleStagePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragTargetRef.current) return;
    const ctxInfo = getStageCameraContext();
    if (!ctxInfo) return;
    const { canvas, cam } = ctxInfo;
    const rect = canvas.getBoundingClientRect();
    const sx = ((e.clientX - rect.left) / Math.max(1, rect.width)) * canvas.width;
    const sy = ((e.clientY - rect.top) / Math.max(1, rect.height)) * canvas.height;
    const worldPt = unprojectScreenToWorld(sx, sy, cam, canvas.width, canvas.height);

    const nx = Math.max(0.06, Math.min(0.94, worldPt.x));
    const ny = Math.max(0.12, Math.min(0.92, worldPt.y));

    if (dragTargetRef.current.kind === 'lookAt') {
      patchActiveShot((sh) => ({ ...sh, lookAt: { x: nx, y: ny } }), false);
    } else {
      const idx = dragTargetRef.current.idx;
      const groundY = Math.max(graph.world.horizonY + 0.06, Math.min(0.9, ny));
      patchActiveShot(
        (sh) => ({
          ...sh,
          motionPath: sh.motionPath.map((pt, i) => (i === idx ? { x: nx, y: groundY } : pt)),
        }),
        false
      );
    }
  };

  const handleStagePointerUp = () => {
    dragTargetRef.current = null;
  };

  // =========================================================================
  // STORY COMPILER & 1-SENTENCE REVISION
  // =========================================================================
  const handleCompilePrompt = async (customPrompt?: string, forcePresetWorld = false) => {
    const text = (customPrompt ?? promptDraft).trim();
    if (!text) return;
    setPlaying(false);
    setCompilingRemote(true);
    try {
      const worldSeed = forcePresetWorld
        ? {
            customBgBlobKey: graph.world.customBgBlobKey,
            decomposedBg: graph.world.decomposedBg ?? null,
            cinemaLook: graph.world.cinemaLook ?? 'natural',
            letterbox: graph.world.letterbox ?? true,
            grainStrength: graph.world.grainStrength ?? 0.35,
          }
        : {
            setId: graph.world.setId,
            customBgBlobKey: graph.world.customBgBlobKey,
            decomposedBg: graph.world.decomposedBg ?? null,
            cinemaLook: graph.world.cinemaLook ?? 'natural',
            letterbox: graph.world.letterbox ?? true,
            grainStrength: graph.world.grainStrength ?? 0.35,
          };

      const cast = getGraphActors(graph);
      let next = compileDirectorPromptToFilmGraph(text, graph.actor, worldSeed);
      next = { ...next, actors: cast };

      // V4 Single-Command Live AI Film Director (Llama 3.3 70B FP8 Fast — ~2.88s, 0 pixels touched!)
      // Silently falls back to instant $0 local director if offline or quota capped.
      let directedViaAi = false;
      if (!forcePresetWorld) {
        const aiRes = await requestAiDirectedFilm({
          prompt: text,
          locale,
          actors: cast.map((a) => ({
            id: a.id,
            name: a.name,
            creatureClass: a.creatureClass ?? 'humanoid',
            viewCount: countRigViews(a.masterRig),
          })),
        });
        if (aiRes.ok && aiRes.screenplay && aiRes.screenplay.shots.length > 0) {
          next = applyDirectedScreenplayToFilmGraph(aiRes.screenplay, { ...next, prompt: text });
          directedViaAi = true;
        }
      }

      commitGraph(next);
      setPromptDraft(text);
      setSelectedShotIdx(0);
      setGlobalSec(0);
      soundEngine.clapperSnap();
      notify(
        directedViaAi
          ? tf('filmStagedMultiToast', { shots: next.shots.length, actors: cast.length })
          : tf('filmStagedSingleToast', { shots: next.shots.length })
      );
    } finally {
      setCompilingRemote(false);
    }
  };

  const handleApplyRevision = (instructionText?: string) => {
    const clean = (instructionText ?? revisionDraft).trim();
    if (!clean) return;
    setPlaying(false);
    patchActiveShot((sh) => patchShotFromRevisionPrompt(sh, clean));
    if (!instructionText) setRevisionDraft('');
    soundEngine.click(1.12);
    notify(tf('filmShotUpdatedToast', { num: safeShotIdx + 1 }));
  };

  // --- V4 1..6 Cast Helpers (Multi-File Batch Add!) & 2.5D Master Modal ---
  const handleAddExtraActorFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files ?? []).filter((f) => f.type.startsWith('image/'));
    e.target.value = '';
    if (selected.length === 0) return;
    const cast = getGraphActors(graph);
    const slotsLeft = 6 - cast.length;
    if (slotsLeft <= 0) {
      notify(t('filmMaxActorsNote'), 'info');
      return;
    }
    const batch = selected.slice(0, slotsLeft);
    const added: FilmActor[] = [];
    try {
      for (let i = 0; i < batch.length; i++) {
        const file = batch[i];
        const url = URL.createObjectURL(file);
        try {
          const img = await loadImageElement(url);
          const c = document.createElement('canvas');
          c.width = img.naturalWidth || 512;
          c.height = img.naturalHeight || 512;
          c.getContext('2d')?.drawImage(img, 0, 0);
          const prepared = prepareCharacterCanvas(c, { maxDim: 768, stripPaper: true });
          if (prepared.empty) continue;
          const blob = await canvasToPngBlob(prepared.canvas);
          const sourceBlobKey = await saveBlob(blob);
          const styleDna = extractStyleDNAFromCanvas(prepared.canvas);
          added.push({
            id: makeId('act'),
            name:
              file.name.replace(/\.[^.]+$/, '').slice(0, 18) ||
              `Oyuncu ${cast.length + added.length + 1}`,
            sourceBlobKey,
            sourceW: prepared.width,
            sourceH: prepared.height,
            styleDna,
            rigidHeadEndY: prepared.anatomy.headEndV,
            secondaryPhysics: false,
            scale: 0.96,
            creatureClass:
              prepared.archetype === 'quadruped'
                ? 'quadruped'
                : prepared.archetype === 'floater'
                  ? 'amorphous_vehicle'
                  : 'humanoid',
          });
        } finally {
          URL.revokeObjectURL(url);
        }
      }
      if (added.length === 0) {
        notify(t('filmErrReadDrawing'), 'error');
        return;
      }
      const nextCast = [...cast, ...added];
      commitGraph({ ...graph, actors: nextCast });
      setSelectedActorId(added[added.length - 1].id);
      soundEngine.clapperSnap();
      notify(
        added.length === 1
          ? tf('filmActorJoinedOne', { name: localizeActorName(added[0].name, locale), total: nextCast.length })
          : tf('filmActorJoinedMany', { count: added.length, total: nextCast.length })
      );
    } catch {
      notify(t('filmErrReadDrawing'), 'error');
    }
  };

  const handleRemoveCastActor = (actorId: string) => {
    if (actorId === graph.actor.id) return;
    const nextCast = getGraphActors(graph).filter((a) => a.id !== actorId);
    commitGraph({ ...graph, actors: nextCast });
    if (selectedActorId === actorId) setSelectedActorId(graph.actor.id);
    soundEngine.click(0.95);
  };

  const handleOpenActorMasterModal = async () => {
    soundEngine.click(1.12);
    const target = selectedActor;
    if (target.masterRig?.views?.front?.dataUrl) {
      setMasterModalInitialRig(target.masterRig);
      setMasterModalOpen(true);
      return;
    }
    const src =
      target.id === graph.actor.id
        ? actorBitmapRef.current
        : extraActorBitmapsRef.current.get(target.id) ?? actorBitmapRef.current;
    const c = document.createElement('canvas');
    c.width = src.width || 512;
    c.height = src.height || 512;
    c.getContext('2d')?.drawImage(src, 0, 0, c.width, c.height);
    const anchors = extractViewAnchorsFromCanvas(c);
    setMasterModalInitialRig(
      createMasterRigFromFront(
        c.toDataURL('image/png'),
        target.creatureClass ?? 'humanoid',
        target.name,
        anchors,
        c.width,
        c.height
      )
    );
    setMasterModalOpen(true);
  };

  const handleSaveActorMasterRig = (saved: CharacterMasterRig) => {
    const targetId = selectedActor.id;
    const cast = getGraphActors(graph);
    const nextCast = cast.map((a) =>
      a.id === targetId ? { ...a, creatureClass: saved.creatureClass, masterRig: saved } : a
    );
    commitGraph({
      ...graph,
      actor: nextCast[0],
      actors: nextCast,
    });
    const existingCache = actorMasterCachesRef.current.get(targetId);
    if (existingCache) existingCache.syncRig(saved);
    else actorMasterCachesRef.current.set(targetId, new MasterRigRuntimeCache(saved));
    setMasterModalOpen(false);
    setMasterModalInitialRig(saved);
    setAssetVersion((v) => v + 1);
    const vc = countRigViews(saved);
    notify(tf('filmActorAnglesUpdated', { name: localizeActorName(selectedActor.name, locale), count: vc }));
  };

  const patchSelectedActorInShot = (patch: {
    universalAction?: UniversalActionId;
    viewYawDeg?: number;
    lookAtActorId?: string | null;
  }) => {
    const isLead = selectedActor.id === graph.actor.id;
    patchActiveShot((sh) => {
      const prevTrack = sh.actorTracks?.[selectedActor.id] ?? {
        actorId: selectedActor.id,
        action: isLead ? sh.action : 'idle-breathe',
        universalAction: isLead ? sh.universalAction : undefined,
        emotion: sh.emotion,
        motionPath: isLead
          ? sh.motionPath
          : [
              { x: 0.65, y: 0.81 },
              { x: 0.65, y: 0.81 },
            ],
        viewYawDeg: isLead ? sh.viewYawDeg ?? 0 : -35,
        lookAtActorId: null,
      };
      const nextUa = patch.universalAction ?? prevTrack.universalAction;
      const nextLegacyAction = nextUa ? mapUniversalActionToLegacyFilmAction(nextUa) : prevTrack.action;
      const nextTrack = {
        ...prevTrack,
        action: nextLegacyAction,
        universalAction: nextUa,
        viewYawDeg: patch.viewYawDeg !== undefined ? patch.viewYawDeg : prevTrack.viewYawDeg,
        lookAtActorId: patch.lookAtActorId !== undefined ? patch.lookAtActorId : prevTrack.lookAtActorId,
      };
      return {
        ...sh,
        ...(isLead
          ? {
              action: nextLegacyAction,
              universalAction: nextUa,
              viewYawDeg: nextTrack.viewYawDeg,
            }
          : {}),
        actorTracks: {
          ...(sh.actorTracks ?? {}),
          [selectedActor.id]: nextTrack,
        },
      };
    });
  };

  // =========================================================================
  // ACTOR & WORLD MANAGEMENT (FIXED: ALWAYS CLEARS DECOMPOSED ON SWITCH!)
  // =========================================================================
  const handleUploadActor = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const url = URL.createObjectURL(file);
      const img = await loadImageElement(url);
      URL.revokeObjectURL(url);
      // Unified BFS paper removal (preserves white eyes/teeth!) + ground-locked tight auto-crop + anatomy!
      const prepared = prepareCharacterCanvas(img, { maxDim: 768, stripPaper: true });
      const dna = extractStyleDNAFromCanvas(prepared.canvas);
      const blob = await canvasToPngBlob(prepared.canvas);
      const key = await saveBlob(blob);

      commitGraph({
        ...graph,
        actor: {
          ...graph.actor,
          name: file.name.replace(/\.[^.]+$/, '').slice(0, 26) || 'Oyuncu',
          sourceBlobKey: key,
          sourceW: prepared.width,
          sourceH: prepared.height,
          rigidHeadEndY: prepared.anatomy.headEndV,
          secondaryPhysics: false, // Never bolt an unwanted red scarf onto user's custom art!
          styleDna: dna,
          decomposed: null, // ALWAYS clear stale decomposed parts!
        },
      });
      soundEngine.shutter();
      const extraClean =
        prepared.isolatedPrimary || prepared.cleanedPockets > 0 ? t('filmCleanExtraNote') : '';
      notify(tf('filmExtractedOnStage', { extra: extraClean }));
    } catch {
      notify(t('filmErrReadImage'), 'error');
    } finally {
      if (actorFileRef.current) actorFileRef.current.value = '';
    }
  };

  const handleUseActiveDrawingAsActor = async () => {
    if (!project) return;
    const frame = project.frames[activeFrameIndex] ?? project.frames[0];
    if (!frame) return;
    const raw = await renderFrameComposite(project, frame, {
      width: 960,
      height: Math.round((project.height / project.width) * 960),
      hideRoughBlue: true,
      transparentBg: true,
    });
    const prepared = prepareCharacterCanvas(raw, { maxDim: 768, stripPaper: false });
    const dna = extractStyleDNAFromCanvas(prepared.canvas);
    const key = await saveBlob(await canvasToPngBlob(prepared.canvas));
    commitGraph({
      ...graph,
      actor: {
        ...graph.actor,
        name: `${localizeProjectName(project.name, locale)} #${activeFrameIndex + 1}`,
        sourceBlobKey: key,
        sourceW: prepared.width,
        sourceH: prepared.height,
        rigidHeadEndY: prepared.anatomy.headEndV,
        secondaryPhysics: false, // Preserve user's own outfit cleanly!
        styleDna: dna,
        decomposed: null, // ALWAYS clear stale decomposed parts!
      },
    });
    soundEngine.clapperSnap();
    notify(t('filmActiveCroppedToast'));
  };

  const handleRestoreDefaultHero = () => {
    const hero = getDefaultHeroActorCanvas();
    commitGraph({
      ...graph,
      actor: {
        ...graph.actor,
        name: localizeActorName(SAMPLE_HERO_NAME_TR, locale),
        sourceBlobKey: null,
        sourceW: hero.width,
        sourceH: hero.height,
        rigidHeadEndY: 0.31,
        secondaryPhysics: false,
        decomposed: null, // FIXED: always clears decomposed rig!
      },
    });
    soundEngine.click(1.04);
  };

  const handleDecomposeActor = async () => {
    if (decomposingActor) return;
    setDecomposingActor(true);
    try {
      const rig = await decomposeCharacterPipeline(
        actorBitmapRef.current,
        graph.actor.styleDna,
        cloudStatus.online ? cloudStatus.url : undefined
      );
      commitGraph({
        ...graph,
        actor: {
          ...graph.actor,
          decomposed: rig,
        },
      });
      soundEngine.clapperSnap();
      notify(tf('filmLimbsSplitToast', { count: rig.parts.length }));
    } catch {
      notify(t('filmErrSplitLimbs'), 'error');
    } finally {
      setDecomposingActor(false);
    }
  };

  const handleUploadCustomBg = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setDecomposingBg(true);
    try {
      const url = URL.createObjectURL(file);
      const img = await loadImageElement(url);
      URL.revokeObjectURL(url);
      const c = document.createElement('canvas');
      c.width = 1280;
      c.height = 720;
      c.getContext('2d')!.drawImage(img, 0, 0, 1280, 720);
      const key = await saveBlob(await canvasToPngBlob(c));
      const decomposedBg = await decomposeBackgroundPipeline(
        c,
        graph.world.horizonY,
        cloudStatus.online ? cloudStatus.url : undefined
      );
      commitGraph({
        ...graph,
        world: {
          ...graph.world,
          setId: 'custom',
          customBgBlobKey: key,
          decomposedBg,
        },
      });
      soundEngine.shutter();
      notify(t('filmBgSlicedToast'));
    } catch {
      notify(t('filmErrBgUpload'), 'error');
    } finally {
      setDecomposingBg(false);
      if (bgFileRef.current) bgFileRef.current.value = '';
    }
  };

  // =========================================================================
  // LIVE $0 BEFORE / AFTER CINEMA LOOK COMPARISON (WORKS 100% OFFLINE!)
  // =========================================================================
  const handleOpenLookCompare = () => {
    setPlaying(false);
    const W = 1280;
    const H = 720;
    const resolved = playAllMode
      ? resolveFilmTimeline(graph.shots, globalSec)
      : {
          shotIndex: safeShotIdx,
          shot: activeShot,
          localSec: globalSec % Math.max(0.5, activeShot.durationSec),
          totalDuration: activeShot.durationSec,
        };
    const renderLookUrl = (lookOverride: CinemaLookId) => {
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const ctx = c.getContext('2d')!;
      render25DFilmFrame(ctx, graph, resolved.shot, resolved.localSec, W, H, {
        actorSource: actorBitmapRef.current,
        extraActorSources: extraActorBitmapsRef.current,
        actorMasterCaches: actorMasterCachesRef.current,
        decomposedPartBitmaps: decomposedPartsMapRef.current,
        customBgSource: customBgBitmapRef.current,
        bgPlaneBitmaps: bgPlanesMapRef.current,
        liveOverride: liveOverrideRef.current,
        showDirectorGizmos: false,
        showLetterbox: graph.world.letterbox ?? graph.world.cinemaGrade,
        cinemaLookOverride: lookOverride,
      });
      return c.toDataURL('image/png');
    };

    const chosenLook: CinemaLookId =
      (graph.world.cinemaLook ?? 'natural') === 'natural'
        ? 'watercolor'
        : graph.world.cinemaLook ?? 'watercolor';

    // If user clicked compare while on 'natural', preview Watercolor so comparison is immediately dramatic!
    if ((graph.world.cinemaLook ?? 'natural') === 'natural') {
      commitGraph({ ...graph, world: { ...graph.world, cinemaLook: 'watercolor' } });
    }

    const beforeUrl = renderLookUrl('natural');
    const afterUrl = renderLookUrl(chosenLook);
    const lookLabel = cinemaLooks.find((l) => l.id === chosenLook)?.label ?? t('filmStyledScene');
    setComparePreview({ beforeUrl, afterUrl, lookLabel });
    setCompareSplitPct(50);
    soundEngine.shutter();
  };

  // Optional local server check (strictly opt-in, ZERO auto-ping!)
  const handlePingCloud = async () => {
    if (pingingCloud) return;
    setPingingCloud(true);
    saveCloudUrl(cloudUrl);
    try {
      const status = await pingCloudPipeline(cloudUrl);
      setCloudStatus(status);
      if (status.online) {
        soundEngine.toggle(true);
        notify(t('filmLocalAccelOk'));
      } else {
        notify(t('filmLocalAccelNone'), 'info');
      }
    } finally {
      setPingingCloud(false);
    }
  };

  const handleExportPackage = async () => {
    try {
      const fname = await exportKagit25dPackage(graph, project?.name || 'inktrope_film');
      soundEngine.click(1.1);
      notify(tf('filmPkgSavedToast', { name: fname }));
    } catch {
      notify(t('filmErrPkgExport'), 'error');
    }
  };

  const handleImportPackage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const restored = await importKagit25dPackage(file);
      commitGraph(restored);
      setPromptDraft(restored.prompt);
      setSelectedShotIdx(0);
      setGlobalSec(0);
      soundEngine.clapperSnap();
      notify(t('filmPkgLoadedToast'));
    } catch (err) {
      notify(err instanceof Error ? err.message : t('filmErrPkgRead'), 'error');
    } finally {
      if (pkgImportRef.current) pkgImportRef.current.value = '';
    }
  };

  // =========================================================================
  // VOICE RECORDING (FIXED 6.4s AUTO-STOP VIA REF!) & $0 CARTOON VOICE SYNTH
  // =========================================================================
  const stopMicVoiceResources = useCallback(() => {
    cancelAnimationFrame(voiceRafRef.current);
    voiceStreamRef.current?.getTracks().forEach((tr) => tr.stop());
    voiceStreamRef.current = null;
    if (voiceCtxRef.current) {
      void voiceCtxRef.current.close().catch(() => {});
      voiceCtxRef.current = null;
    }
    setLiveVoiceVu(0);
    setLiveVoiceViseme('closed');
    handleLivePoseChange(null);
  }, [handleLivePoseChange]);

  const stopMicVoiceRecording = useCallback(async () => {
    if (!recordingVoiceRef.current) return;
    recordingVoiceRef.current = false;
    setRecordingVoice(false);
    setAnalyzingVoice(true);
    try {
      const mr = voiceRecRef.current;
      if (mr && mr.state !== 'inactive') {
        const stopped = new Promise<void>((res) => {
          mr.onstop = () => res();
        });
        mr.stop();
        await stopped;
      }
      stopMicVoiceResources();
      if (voiceChunksRef.current.length > 0) {
        const blob = new Blob(voiceChunksRef.current, { type: mr?.mimeType || 'audio/webm' });
        const blobKey = await saveBlob(blob);
        const track = await analyzeAudioBlobToLipSyncTrack(
          blob,
          blobKey,
          `${t('filmShotWord')} #${selectedShotIdxRef.current + 1}`,
          'mic'
        );
        patchActiveShot((sh) => ({
          ...sh,
          voiceTrack: track,
          durationSec: Math.max(sh.durationSec, Math.min(6.5, track.durationSec)),
        }));
        soundEngine.clapperSnap();
        notify(tf('filmVoiceLipReady', { sec: track.durationSec }));
      }
    } catch {
      notify(t('filmErrVoiceAnalyze'), 'error');
    } finally {
      voiceRecRef.current = null;
      setAnalyzingVoice(false);
    }
  }, [locale, notify, patchActiveShot, stopMicVoiceResources, t]);

  const handleToggleMicVoice = async () => {
    if (recordingVoiceRef.current) {
      await stopMicVoiceRecording();
      return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      notify(t('filmMicUnavailableInfo'), 'info');
      return;
    }

    setPlaying(false);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      voiceStreamRef.current = stream;
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      const actx = new AC();
      voiceCtxRef.current = actx;
      const src = actx.createMediaStreamSource(stream);
      const analyser = actx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);

      const freqBins = new Uint8Array(analyser.frequencyBinCount);
      const timeBins = new Uint8Array(analyser.fftSize);
      const startTime = performance.now();

      voiceChunksRef.current = [];
      const mr = new MediaRecorder(stream);
      mr.ondataavailable = (ev) => {
        if (ev.data.size > 0) voiceChunksRef.current.push(ev.data);
      };
      mr.start(100);
      voiceRecRef.current = mr;
      recordingVoiceRef.current = true;
      setRecordingVoice(true);
      soundEngine.shutter();

      const monitor = () => {
        if (!recordingVoiceRef.current || !voiceCtxRef.current) return;
        analyser.getByteFrequencyData(freqBins);
        analyser.getByteTimeDomainData(timeBins);
        const { viseme, energy } = classifyLiveAnalyserViseme(
          freqBins,
          timeBins,
          actx.sampleRate
        );
        setLiveVoiceVu(energy);
        setLiveVoiceViseme(viseme);
        handleLivePoseChange({ viseme, mouthOpen: energy });

        // FIXED: calls stopMicVoiceRecording directly via ref — NEVER spawns a second recorder!
        if (performance.now() - startTime > 6400) {
          void stopMicVoiceRecording();
          return;
        }
        voiceRafRef.current = requestAnimationFrame(monitor);
      };
      voiceRafRef.current = requestAnimationFrame(monitor);
    } catch {
      stopMicVoiceResources();
      notify(t('filmMicDeniedErr'), 'error');
    }
  };

  const handleUploadVoiceFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAnalyzingVoice(true);
    try {
      const blobKey = await saveBlob(file);
      const track = await analyzeAudioBlobToLipSyncTrack(
        file,
        blobKey,
        file.name.replace(/\.[^.]+$/, '').slice(0, 22),
        'file'
      );
      patchActiveShot((sh) => ({
        ...sh,
        voiceTrack: track,
        durationSec: Math.max(sh.durationSec, Math.min(6.5, track.durationSec)),
      }));
      soundEngine.clapperSnap();
      notify(tf('filmAudioLipReady', { sec: track.durationSec }));
    } catch {
      notify(t('filmErrAudioRead'), 'error');
    } finally {
      setAnalyzingVoice(false);
      if (voiceFileRef.current) voiceFileRef.current.value = '';
    }
  };

  // 100% $0 Browser Expressive Cartoon Voice Synth (uses optional server ONLY if connected!)
  const handleSynthesizeVoice = async () => {
    if (synthesizingVoice) return;
    const text = activeShot.dialogue.trim();
    if (!text) {
      notify(t('filmTypeLineFirst'), 'info');
      return;
    }
    setSynthesizingVoice(true);
    try {
      const voiceLabel = studioVoices.find((v) => v.id === aiVoiceName)?.label ?? 'Ses';
      let track: VoiceLipSyncTrack;

      if (cloudStatus.online) {
        try {
          const { blob } = await synthesizeCharacterVoiceRemote(
            cloudStatus.url,
            text,
            activeShot.emotion,
            aiVoiceName
          );
          const blobKey = await saveBlob(blob);
          track = await analyzeAudioBlobToLipSyncTrack(
            blob,
            blobKey,
            `${voiceLabel} · ${text.slice(0, 14)}`,
            'file'
          );
        } catch {
          // Seamless silent fallback to $0 in-browser formant synthesizer
          const local = synthesizeCartoonDialogueWav(text, activeShot.emotion, aiVoiceName);
          const blobKey = await saveBlob(local.blob);
          track = analyzePCMToLipSyncTrack(local.pcm, local.sampleRate, {
            audioBlobKey: blobKey,
            label: `${voiceLabel} · ${text.slice(0, 14)}`,
            source: 'file',
          });
        }
      } else {
        const local = synthesizeCartoonDialogueWav(text, activeShot.emotion, aiVoiceName);
        const blobKey = await saveBlob(local.blob);
        track = analyzePCMToLipSyncTrack(local.pcm, local.sampleRate, {
          audioBlobKey: blobKey,
          label: `${voiceLabel} · ${text.slice(0, 14)}`,
          source: 'file',
        });
      }

      patchActiveShot((sh) => ({
        ...sh,
        voiceTrack: track,
        durationSec: Math.max(sh.durationSec, Math.min(6.5, track.durationSec + 0.25)),
      }));
      soundEngine.clapperSnap();
      notify(tf('filmSynthReadyToast', { sec: track.durationSec }));
    } catch {
      notify(t('filmErrSynthVoice'), 'error');
    } finally {
      setSynthesizingVoice(false);
    }
  };

  const handleCommitMocap = useCallback(
    (track: MotionCaptureTrack, voiceTrack?: VoiceLipSyncTrack | null) => {
      patchActiveShot((sh) => ({
        ...sh,
        mocapTrack: track,
        voiceTrack: voiceTrack ?? sh.voiceTrack,
        durationSec: Math.max(sh.durationSec, Math.min(6.5, track.durationSec)),
      }));
    },
    [patchActiveShot]
  );

  // =========================================================================
  // UNIFIED EXPORTS: SILENT-AUDIO VIDEO + $0 GIF + HD PNG + FAST BAKE TO DRAW!
  // =========================================================================
  const handleCancelExport = () => {
    exportAbortRef.current = true;
  };

  const handleExportFilmVideo = async () => {
    if (exportingKind) return;
    setPlaying(false);
    exportAbortRef.current = false;
    setExportingKind('video');
    setExportPct(3);
    setExportLabel(t('filmExportPreparing'));

    let exportFoley: FilmFoleyEngine | null = null;
    try {
      const W = 1280;
      const H = 720;
      const fps = 24;
      const off = document.createElement('canvas');
      off.width = W;
      off.height = H;
      const ctx = off.getContext('2d', { alpha: false })!;

      const chosen = pickBestMediaRecorderFormat();
      const safeName = (project?.name || 'inktrope_film').replace(/[^a-zA-Z0-9ğüşıöçĞÜŞİÖÇ_-]/g, '_');

      // Universal offline H.264 MP4 fast path via WebCodecs (works on iOS/WhatsApp/TikTok, zero real-time wait!)
      // Used whenever audio is off, or MediaRecorder is unavailable/non-MP4 without sound!
      if (!soundOn || !chosen || typeof off.captureStream !== 'function') {
        const totalSteps = Math.max(12, Math.round(totalDuration * fps));
        const mp4Blob = await encodeFramesToMp4WebCodecs({
          width: W,
          height: H,
          fps,
          totalFrames: totalSteps + 1,
          shouldAbort: () => exportAbortRef.current,
          onProgress: (done, total) => {
            setExportPct(Math.min(97, Math.round((done / Math.max(1, total)) * 94) + 3));
          },
          drawFrame: (fctx, idx) => {
            const gSec = Math.min(totalDuration - 0.001, (idx / totalSteps) * totalDuration);
            const res = render25DFilmFrameAtGlobalTime(fctx, graph, gSec, W, H, {
              actorSource: actorBitmapRef.current,
              extraActorSources: extraActorBitmapsRef.current,
              actorMasterCaches: actorMasterCachesRef.current,
              decomposedPartBitmaps: decomposedPartsMapRef.current,
              customBgSource: customBgBitmapRef.current,
              bgPlaneBitmaps: bgPlanesMapRef.current,
              showDirectorGizmos: false,
              showLetterbox: graph.world.letterbox ?? graph.world.cinemaGrade,
            });
            if (idx >= totalSteps - Math.round(fps * 0.55)) {
              const alpha = (idx - (totalSteps - Math.round(fps * 0.55))) / (fps * 0.55);
              drawKagitSealStamp(fctx, W, H, Math.min(1, alpha));
            }
            setExportLabel(
              `${t('filmShotWord')} ${res.shotIndex + 1}/${graph.shots.length} · ${Math.round((idx / totalSteps) * 100)}%`
            );
          },
        });
        if (exportAbortRef.current) {
          notify(t('filmExportCancelled'), 'info');
          return;
        }
        if (mp4Blob) {
          triggerDownload(mp4Blob, `${safeName}_film.mp4`);
          soundEngine.clapperSnap();
          notify(t('filmMp4Downloaded'));
          setFilmExportOpen(false);
          return;
        }
        if (!chosen || typeof off.captureStream !== 'function') {
          notify(t('exportWebViewFallbackToast'), 'info');
          return;
        }
      }
      const mime = chosen.mime;

      const videoStream = off.captureStream(fps);
      const tracks: MediaStreamTrack[] = [...videoStream.getVideoTracks()];

      // FIXED: monitorToSpeakers = false so silent export NEVER blasts speakers!
      exportFoley = new FilmFoleyEngine({ monitorToSpeakers: false });
      const audioStream = soundOn ? exportFoley.attachStreamDestination() : null;
      if (audioStream) tracks.push(...audioStream.getAudioTracks());

      const voiceBlobCache = new Map<string, Blob>();
      for (const sh of graph.shots) {
        if (sh.voiceTrack?.audioBlobKey) {
          const b = await loadBlob(sh.voiceTrack.audioBlobKey);
          if (b) voiceBlobCache.set(sh.voiceTrack.audioBlobKey, b);
        }
      }

      const combined = new MediaStream(tracks);
      const recorder = new MediaRecorder(combined, {
        mimeType: mime,
        videoBitsPerSecond: 6_500_000,
      });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunks.push(ev.data);
      };

      recorder.start();
      if (soundOn) {
        exportFoley.startAmbience(graph.world.weather, graph.world.weatherIntensity, musicOn);
      }

      const totalSteps = Math.max(12, Math.round(totalDuration * fps));
      const stepMs = 1000 / fps;
      let wasFootContact = false;
      let lastShot = -1;
      let thunderShot = -1;

      for (let i = 0; i <= totalSteps; i++) {
        if (exportAbortRef.current) break;
        const gSec = Math.min(totalDuration - 0.001, (i / totalSteps) * totalDuration);
        const res = render25DFilmFrameAtGlobalTime(ctx, graph, gSec, W, H, {
          actorSource: actorBitmapRef.current,
          extraActorSources: extraActorBitmapsRef.current,
          actorMasterCaches: actorMasterCachesRef.current,
          decomposedPartBitmaps: decomposedPartsMapRef.current,
          customBgSource: customBgBitmapRef.current,
          bgPlaneBitmaps: bgPlanesMapRef.current,
          showDirectorGizmos: false,
          showLetterbox: graph.world.letterbox ?? graph.world.cinemaGrade,
        });

        if (res.shotIndex !== lastShot) {
          lastShot = res.shotIndex;
          wasFootContact = false;
          thunderShot = -1;
          const sh = graph.shots[res.shotIndex];
          if (soundOn && sh?.voiceTrack?.audioBlobKey) {
            const vb = voiceBlobCache.get(sh.voiceTrack.audioBlobKey);
            if (vb) void exportFoley.playVoiceBlob(sh.voiceTrack.audioBlobKey, vb, 0);
          } else {
            exportFoley.stopVoice();
          }
        }
        if (soundOn) {
          exportFoley.setDialogueDucking(res.speaking);
          if (res.pose.footContact && !wasFootContact) {
            exportFoley.triggerFootstep(graph.world.setId, 0.85);
          }
          wasFootContact = res.pose.footContact;
          if (res.lightningFlash > 0.7 && thunderShot !== res.shotIndex) {
            thunderShot = res.shotIndex;
            exportFoley.triggerThunder();
          }
        }

        if (i >= totalSteps - Math.round(fps * 0.55)) {
          const alpha = (i - (totalSteps - Math.round(fps * 0.55))) / (fps * 0.55);
          drawKagitSealStamp(ctx, W, H, Math.min(1, alpha));
        }

        setExportPct(Math.min(95, Math.round((i / totalSteps) * 92) + 3));
        setExportLabel(`${t('filmShotWord')} ${res.shotIndex + 1}/${graph.shots.length} · ${Math.round((i / totalSteps) * 100)}%`);
        await new Promise((r) => setTimeout(r, stepMs));
      }

      exportFoley.stop();
      const stopped = new Promise<void>((res) => {
        recorder.onstop = () => res();
      });
      if (recorder.state !== 'inactive') recorder.stop();
      await stopped;

      if (exportAbortRef.current) {
        notify(t('filmExportCancelled'), 'info');
        return;
      }

      const rawBlob = new Blob(chunks, { type: mime });
      const ext = mime.includes('mp4') ? 'mp4' : 'webm';

      if (cloudStatus.online) {
        try {
          setExportPct(97);
          const mp4Blob = await transcodeBroadcastMp4Remote(cloudStatus.url, rawBlob, ext);
          triggerDownload(mp4Blob, `${safeName}_film.mp4`);
          soundEngine.clapperSnap();
          notify(t('filmMp4Downloaded'));
          setFilmExportOpen(false);
          return;
        } catch {
          // Fall back cleanly to WebM
        }
      }

      triggerDownload(rawBlob, `${safeName}_film.${ext}`);
      soundEngine.clapperSnap();
      notify(t('filmVideoDownloaded'));
      setFilmExportOpen(false);
    } catch {
      notify(t('filmErrVideoExport'), 'error');
    } finally {
      exportFoley?.dispose();
      setExportingKind(null);
      setExportPct(0);
    }
  };

  const handleExportFilmGif = async () => {
    if (exportingKind) return;
    setPlaying(false);
    exportAbortRef.current = false;
    setExportingKind('gif');
    setExportPct(5);
    setExportLabel(t('filmExportPreparing'));

    try {
      const W = 560;
      const H = 315;
      const fps = 10;
      const capDur = Math.min(totalDuration, 9.5);
      const totalFrames = Math.max(8, Math.min(85, Math.round(capDur * fps)));
      const off = document.createElement('canvas');
      off.width = W;
      off.height = H;
      const ctx = off.getContext('2d', { willReadFrequently: true })!;

      const frames: { rgba: Uint8ClampedArray; hold: number }[] = [];
      for (let i = 0; i < totalFrames; i++) {
        if (exportAbortRef.current) return;
        const gSec = Math.min(totalDuration - 0.001, (i / totalFrames) * capDur);
        render25DFilmFrameAtGlobalTime(ctx, graph, gSec, W, H, {
          actorSource: actorBitmapRef.current,
          extraActorSources: extraActorBitmapsRef.current,
          actorMasterCaches: actorMasterCachesRef.current,
          decomposedPartBitmaps: decomposedPartsMapRef.current,
          customBgSource: customBgBitmapRef.current,
          bgPlaneBitmaps: bgPlanesMapRef.current,
          showDirectorGizmos: false,
          showLetterbox: graph.world.letterbox ?? graph.world.cinemaGrade,
        });
        frames.push({ rgba: new Uint8ClampedArray(ctx.getImageData(0, 0, W, H).data), hold: 1 });
        setExportPct(5 + Math.round(((i + 1) / totalFrames) * 65));
        setExportLabel(`GIF ${i + 1}/${totalFrames}`);
        await new Promise<void>((r) => setTimeout(r, 0));
      }

      if (exportAbortRef.current) return;
      setExportPct(78);
      setExportLabel(t('filmPackingGif'));
      const gifBlob = await runGifEncode({
        width: W,
        height: H,
        delayCs: Math.round(100 / fps),
        frames,
      });
      const safeName = (project?.name || 'inktrope_film').replace(/[^a-zA-Z0-9ğüşıöçĞÜŞİÖÇ_-]/g, '_');
      triggerDownload(gifBlob, `${safeName}_film.gif`);
      soundEngine.clapperSnap();
      notify(t('filmGifDownloaded'));
      setFilmExportOpen(false);
    } catch {
      notify(t('filmErrGifExport'), 'error');
    } finally {
      setExportingKind(null);
      setExportPct(0);
    }
  };

  const handleDownloadPosterPng = () => {
    const W = 1280;
    const H = 720;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d')!;
    render25DFilmFrameAtGlobalTime(ctx, graph, globalSec, W, H, {
      actorSource: actorBitmapRef.current,
      extraActorSources: extraActorBitmapsRef.current,
      actorMasterCaches: actorMasterCachesRef.current,
      decomposedPartBitmaps: decomposedPartsMapRef.current,
      customBgSource: customBgBitmapRef.current,
      bgPlaneBitmaps: bgPlanesMapRef.current,
      liveOverride: liveOverrideRef.current,
      showDirectorGizmos: false,
      showLetterbox: graph.world.letterbox ?? graph.world.cinemaGrade,
    });
    const safeName = (project?.name || 'inktrope_film').replace(/[^a-zA-Z0-9ğüşıöçĞÜŞİÖÇ_-]/g, '_');
    c.toBlob((blob) => {
      if (!blob) return;
      triggerDownload(blob, `${safeName}_plan${safeShotIdx + 1}.png`);
      soundEngine.shutter();
      notify(t('filmPngDownloaded'));
    }, 'image/png');
  };

  // FIXED: Fast, single-canvas, yielded, zero-stall Send to Draw (< 2s instead of 14s+ hang!)
  const handleSendShotToDraw = async () => {
    if (!project || exportingKind) return;
    setPlaying(false);
    setExportingKind('draw');
    setExportPct(5);
    const fps = Math.min(12, project.fps);
    const count = Math.max(6, Math.min(20, Math.round(activeShot.durationSec * fps)));
    try {
      const added = await bakeRenderedShotToFrames(
        count,
        (ctx, idx, w, h) => {
          const localSec = (idx / Math.max(1, count - 1)) * Math.max(0.5, activeShot.durationSec - 0.05);
          render25DFilmFrame(ctx, graph, activeShot, localSec, w, h, {
            actorSource: actorBitmapRef.current,
            extraActorSources: extraActorBitmapsRef.current,
            actorMasterCaches: actorMasterCachesRef.current,
            decomposedPartBitmaps: decomposedPartsMapRef.current,
            customBgSource: customBgBitmapRef.current,
            bgPlaneBitmaps: bgPlanesMapRef.current,
            showDirectorGizmos: false,
            showLetterbox: false,
          });
        },
        {
          replace: false,
          notePrefix: `${t('filmShotWord')} ${safeShotIdx + 1}`,
          layerName: t('filmLayerSceneName'),
          topLayerName: t('filmLayerTopEffects'),
          onProgress: (done, total) => {
            setExportPct(Math.round((done / total) * 100));
            setExportLabel(`${t('filmSendingToDraw')}… ${done}/${total}`);
          },
        }
      );
      soundEngine.clapperSnap();
      notify(tf('filmFramesSentDraw', { count: added }));
    } catch {
      notify(t('filmErrTransferFrames'), 'error');
    } finally {
      setExportingKind(null);
      setExportPct(0);
    }
  };

  // =========================================================================
  // SHOT TIMELINE HELPERS (REORDER, DUPLICATE, CLEAN ADD)
  // =========================================================================
  const selectShotAndSeek = useCallback(
    (idx: number) => {
      const curShots = graphRef.current.shots;
      const safe = Math.max(0, Math.min(curShots.length - 1, idx));
      setSelectedShotIdx(safe);
      let acc = 0;
      for (let i = 0; i < safe; i++) acc += Math.max(0.5, curShots[i].durationSec);
      const nextTime = acc + 0.05;
      globalSecRef.current = nextTime;
      setGlobalSec(nextTime);
    },
    []
  );

  const handleMoveShot = (idx: number, dir: -1 | 1) => {
    const target = idx + dir;
    if (target < 0 || target >= graph.shots.length) return;
    const nextShots = [...graph.shots];
    const [moved] = nextShots.splice(idx, 1);
    nextShots.splice(target, 0, moved);
    commitGraph({ ...graph, shots: nextShots });
    selectShotAndSeek(target);
    soundEngine.click(1.04);
  };

  const handleDuplicateShot = (idx: number) => {
    const sh = graph.shots[idx];
    if (!sh) return;
    const copy: FilmShot = {
      ...sh,
      id: makeId('sht'),
      title: `${t('filmShotWord')} ${graph.shots.length + 1} · ${framingLabelMap[sh.framing]}`,
      camera: { ...sh.camera },
      motionPath: sh.motionPath.map((p) => ({ ...p })),
      lookAt: sh.lookAt ? { ...sh.lookAt } : null,
    };
    const nextShots = [...graph.shots];
    nextShots.splice(idx + 1, 0, copy);
    commitGraph({ ...graph, shots: nextShots });
    selectShotAndSeek(idx + 1);
    soundEngine.click(1.08);
  };

  const handleAddCleanShot = () => {
    // FIXED: clean brand-new shot — NEVER clones previous shot's voiceTrack or mocapTrack!
    const nextShot: FilmShot = {
      id: makeId('sht'),
      title: `${t('filmShotWord')} ${graph.shots.length + 1} · ${t('filmFrameMedium')}`,
      durationSec: 2.6,
      framing: 'medium',
      timingMode: 'on2s-12fps',
      action: 'walk-hero',
      emotion: 'neutral',
      prop: 'none',
      headAngleX: 0,
      motionPath: [
        { x: 0.34, y: 0.8 },
        { x: 0.54, y: 0.8 },
      ],
      lookAt: { x: 0.68, y: 0.52 },
      dialogue: '',
      lightningAtSec: null,
      voiceTrack: null,
      mocapTrack: null,
      camera: {
        fromX: -0.04,
        fromY: -0.04,
        fromZoom: 1.24,
        toX: 0.04,
        toY: -0.06,
        toZoom: 1.4,
        tiltDeg: 0,
        dofStrength: 0.42,
        handheld: 0.25,
      },
      transition: 'cut',
    };
    commitGraph({ ...graph, shots: [...graph.shots, nextShot] });
    selectShotAndSeek(graph.shots.length);
    soundEngine.click(1.1);
  };

  // =========================================================================
  // KEYBOARD SHORTCUTS (Space, Left/Right, Ctrl+Z/Y, G, L, Escape)
  // =========================================================================
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
        if (comparePreview) {
          setComparePreview(null);
          return;
        }
        if (filmExportOpen && !exportingKind) {
          setFilmExportOpen(false);
          return;
        }
        if (mocapDeckOpen) {
          setMocapDeckOpen(false);
          handleLivePoseChange(null);
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

      if (e.code === 'Space') {
        e.preventDefault();
        soundEngine.click(1.04);
        setPlaying((p) => !p);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setPlaying(false);
        selectShotAndSeek(selectedShotIdxRef.current - 1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setPlaying(false);
        selectShotAndSeek(selectedShotIdxRef.current + 1);
      } else if (e.key.toLowerCase() === 'g') {
        setShowGizmos((v) => !v);
      } else if (e.key.toLowerCase() === 'l') {
        setPlayAllMode((v) => !v);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    comparePreview,
    exportingKind,
    filmExportOpen,
    handleLivePoseChange,
    handleRedo,
    handleUndo,
    mocapDeckOpen,
    selectShotAndSeek,
    setFilmExportOpen,
  ]);

  const activeLookId: CinemaLookId = graph.world.cinemaLook ?? 'natural';
  const activeGrain = graph.world.grainStrength ?? 0.35;
  const activeLetterbox = graph.world.letterbox ?? graph.world.cinemaGrade;

  return (
    <div className="flex-1 flex flex-col min-h-0 desk-surface-mat overflow-hidden">
      {/* Main 3-Column Director Console (Stage first on mobile/tablet via order!) */}
      <div className="flex-1 flex flex-col lg:flex-row min-h-0 overflow-hidden">
        {/* LEFT RAIL: 3 Desktop Tabs + 4th Mobile Inspector Tab */}
        <aside className={`order-2 lg:order-1 relative z-10 w-full lg:w-[292px] ${leftTab === 'inspector' ? 'shrink-0 lg:flex-none' : 'flex-1 min-h-0 overflow-y-auto lg:flex-none'} lg:shrink-0 border-b lg:border-b-0 lg:border-r border-desk-border bg-desk-surface flex flex-col lg:overflow-hidden`}>
          <div className="p-2 border-b border-desk-border flex items-center gap-1 shrink-0">
            {(
              [
                { id: 'story', label: t('filmTabStory'), mobileOnly: false },
                { id: 'stage', label: t('filmTabStage'), mobileOnly: false },
                { id: 'look', label: t('filmTabLook'), mobileOnly: false },
                { id: 'inspector', label: t('filmTabInspectorMobile'), mobileOnly: true },
              ] as const
            ).map((tabItem) => (
              <button
                key={tabItem.id}
                type="button"
                data-tour={tabItem.id === 'look' ? 'film-look-tab' : undefined}
                onClick={() => {
                  soundEngine.click(1.04);
                  setLeftTab(tabItem.id);
                }}
                className={`${tabItem.mobileOnly ? 'lg:hidden ' : ''}flex-1 py-1.5 px-1.5 rounded-lg text-[11px] font-bold border transition-colors flex items-center justify-center gap-1 whitespace-nowrap ${
                  leftTab === tabItem.id
                    ? 'bg-desk-panel border-ink-brass text-desk-text shadow-sm'
                    : 'border-transparent text-desk-muted hover:text-desk-text'
                }`}
              >
                {tabItem.id === 'look' && activeLookId !== 'natural' && (
                  <span className="hardware-led" data-on="emerald" />
                )}
                {tabItem.label}
              </button>
            ))}
          </div>

          {/* Always-Visible Ultra-Clean Cast & 2.5D Quick Bar (Zero Tab Hunting!) */}
          <div className="px-2.5 py-2 border-b border-desk-border bg-desk-panel/45 space-y-1.5 shrink-0">
            <div className="flex items-center justify-between gap-1">
              <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-ink-brass flex items-center gap-1">
                <Palette className="w-3 h-3 shrink-0" />
                {t('filmCastTitle')} ({castActors.length}/6)
              </span>
              <div className="flex items-center gap-1">
                {castActors.length < 6 && (
                  <button
                    type="button"
                    onClick={() => extraActorFileRef.current?.click()}
                    title={t('filmPickMultiDrawingsTitle')}
                    className="px-2 py-0.5 rounded-full bg-desk-surface hover:bg-desk-panel border border-desk-border hover:border-ink-brass text-[11px] font-bold text-desk-text transition-colors whitespace-nowrap"
                  >
                    {t('filmAddActorBtn')}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void handleOpenActorMasterModal()}
                  className={`px-2 py-0.5 rounded-full text-[11px] font-bold inline-flex items-center gap-1 border transition-colors whitespace-nowrap ${
                    countRigViews(selectedActor.masterRig) >= 3
                      ? 'bg-emerald-950/70 border-emerald-400/50 text-emerald-200'
                      : 'bg-ink-brass/15 hover:bg-ink-brass/25 border-ink-brass/50 text-ink-brass'
                  }`}
                >
                  <Sparkles className="w-3 h-3 shrink-0" />
                  <span>
                    {countRigViews(selectedActor.masterRig) >= 2
                      ? `2.5D · ${countRigViews(selectedActor.masterRig)}/4`
                      : t('v4AnglesPill')}
                  </span>
                </button>
              </div>
            </div>
            <input
              ref={extraActorFileRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => void handleAddExtraActorFile(e)}
            />
            <div className="flex items-center gap-1 overflow-x-auto pb-0.5">
              {castActors.map((act) => {
                const active = act.id === selectedActor.id;
                const vc = countRigViews(act.masterRig);
                return (
                  <div
                    key={act.id}
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold border transition-colors shrink-0 ${
                      active
                        ? 'bg-ink-brass text-neutral-950 border-ink-brass'
                        : 'bg-desk-surface/80 border-desk-border text-desk-muted hover:text-desk-text'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedActorId(act.id)}
                      className="truncate max-w-[92px]"
                    >
                      {localizeActorName(act.name, locale)}
                      {vc >= 2 ? ` · ${vc}/4` : ''}
                    </button>
                    {act.id !== graph.actor.id && (
                      <button
                        type="button"
                        onClick={() => handleRemoveCastActor(act.id)}
                        className="opacity-70 hover:opacity-100"
                        aria-label={t('v4BtnRemove')}
                      >
                        <X className="w-2.5 h-2.5" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className={`${leftTab === 'inspector' ? 'hidden lg:block ' : ''}p-3 lg:flex-1 lg:overflow-y-auto space-y-3`}>
            {/* TAB 1: STORY & QUICK DIRECTOR REVISIONS */}
            {leftTab === 'story' && (
              <>
                <div data-tour="film-story" className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-ink-brass flex items-center gap-1.5">
                      <Clapperboard className="w-3.5 h-3.5" />
                      {t('filmScriptHeader')}
                    </span>
                    <span className="font-mono text-[11px] text-desk-muted">TR / EN</span>
                  </div>
                  <textarea
                    value={promptDraft}
                    onChange={(e) => setPromptDraft(e.target.value)}
                    rows={4}
                    placeholder={t('filmScriptPlaceholder')}
                    className="w-full rounded-xl console-well border border-desk-border p-2.5 text-xs text-desk-text leading-relaxed focus:outline-none focus:border-ink-vermilion resize-none"
                  />
                  <KeycapButton
                    size="sm"
                    variant="vermilion"
                    className="w-full"
                    disabled={compilingRemote}
                    onClick={() => void handleCompilePrompt()}
                  >
                    <Wand2 className="w-3.5 h-3.5" />
                    {compilingRemote ? t('filmCompiling') : t('filmCompileBtn')}
                  </KeycapButton>
                  <div className="text-[11px] text-desk-muted text-center font-medium">
                    ✦ {t('filmDirectAiBadge')}
                  </div>

                  {/* 4 Ready Director Stories */}
                  <div className="pt-1 space-y-1">
                    <span className="font-mono text-[11px] uppercase tracking-wider text-desk-muted">
                      {t('filmPresetsLabel')}
                    </span>
                    {DIRECTOR_PRESETS.map((pr) => {
                      const presetKeyMap: Record<string, TranslationKey> = {
                        'rainy-letter': 'filmPresetRainy',
                        'golden-hill': 'filmPresetGolden',
                        'moonlit-forest': 'filmPresetMoonlit',
                        'snowy-lantern': 'filmPresetSnowy',
                      };
                      const localizedPrompt = localizeSceneOrNote(pr.prompt, locale);
                      return (
                        <button
                          key={pr.id}
                          type="button"
                          onClick={() => void handleCompilePrompt(localizedPrompt, true)}
                          className="w-full text-left px-2.5 py-2 rounded-lg bg-desk-panel/70 hover:bg-desk-panel border border-desk-border text-[11px] font-semibold leading-snug text-desk-muted hover:text-desk-text transition-colors whitespace-normal"
                        >
                          ✦ {t(presetKeyMap[pr.id] ?? 'filmPresetRainy')}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* 1-Sentence Surgical Shot Revision + 1-Tap Chips */}
                <div className="pt-2.5 border-t border-desk-border space-y-2">
                  <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-desk-muted block">
                    {t('filmReviseLabel')} (#{safeShotIdx + 1})
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {(
                      [
                        { label: t('filmChipSlower'), cmd: 'Daha yavaş' },
                        { label: t('filmChipCloseup'), cmd: 'Yakın çekim' },
                        { label: t('filmChipLightning'), cmd: 'Şimşek çaksın' },
                        { label: t('filmChipRun'), cmd: 'Koşsun' },
                        { label: t('filmChipSmile'), cmd: 'Gülümsesin' },
                      ] as const
                    ).map((chip) => (
                      <button
                        key={chip.cmd}
                        type="button"
                        onClick={() => handleApplyRevision(chip.cmd)}
                        className="px-2 py-1 rounded-full bg-desk-panel/80 hover:bg-desk-panel border border-desk-border hover:border-ink-brass text-[11px] font-semibold text-desk-muted hover:text-desk-text transition-colors"
                      >
                        + {chip.label}
                      </button>
                    ))}
                  </div>
                  <div className="flex gap-1.5">
                    <input
                      type="text"
                      value={revisionDraft}
                      onChange={(e) => setRevisionDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleApplyRevision();
                      }}
                      placeholder={t('filmRevisePlaceholder')}
                      className="flex-1 min-w-0 rounded-lg console-well border border-desk-border px-2.5 py-1.5 text-[11px] text-desk-text focus:outline-none focus:border-ink-brass"
                    />
                    <button
                      type="button"
                      onClick={() => handleApplyRevision()}
                      className="px-2.5 py-1.5 rounded-lg bg-desk-panel border border-desk-border hover:border-ink-brass text-[11px] font-bold text-desk-text shrink-0"
                    >
                      {t('filmReviseBtn')}
                    </button>
                  </div>
                </div>
              </>
            )}

            {/* TAB 2: CAST & SET */}
            {leftTab === 'stage' && (
              <>
                <div className="space-y-2">
                  {/* Style Color Swatches */}
                  <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl console-well border border-desk-border">
                    <div className="flex items-center gap-1">
                      {graph.actor.styleDna.palette.slice(0, 5).map((col, idx) => (
                        <span
                          key={`${col}-${idx}`}
                          className="w-3.5 h-3.5 rounded-full border border-black/30"
                          style={{ backgroundColor: col }}
                        />
                      ))}
                    </div>
                    <span className="font-mono text-[11px] text-desk-muted ml-auto">
                      {graph.actor.decomposed ? t('filmPartsReady') : t('filmSinglePiece')}
                    </span>
                  </div>

                  <div className="grid grid-cols-3 gap-1">
                    <button
                      type="button"
                      onClick={() => actorFileRef.current?.click()}
                      className="py-1.5 px-1.5 rounded-lg bg-desk-panel border border-desk-border hover:border-ink-vermilion text-[11px] font-bold text-desk-text inline-flex items-center justify-center gap-1"
                    >
                      <Upload className="w-3 h-3 shrink-0" />
                      <span className="truncate">{t('filmUploadDrawing')}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleUseActiveDrawingAsActor()}
                      className={`py-1.5 px-1.5 rounded-lg border text-[11px] font-bold inline-flex items-center justify-center gap-1 ${
                        hasDrawnCel
                          ? 'bg-ink-brass/15 border-ink-brass text-desk-text'
                          : 'bg-desk-panel border-desk-border hover:border-ink-brass text-desk-text'
                      }`}
                    >
                      <ImageIcon className="w-3 h-3 shrink-0" />
                      <span className="truncate">{t('filmFromDrawing')}</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleRestoreDefaultHero}
                      className="py-1.5 px-1.5 rounded-lg bg-desk-panel border border-desk-border hover:border-ink-brass text-[11px] font-bold text-desk-muted hover:text-desk-text truncate"
                    >
                      {t('filmDefaultHero')}
                    </button>
                  </div>
                  <input
                    ref={actorFileRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={handleUploadActor}
                  />

                  {/* Limb Split / Single Piece */}
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      disabled={decomposingActor}
                      onClick={() => void handleDecomposeActor()}
                      className="flex-1 py-1.5 px-2.5 rounded-lg bg-desk-panel border border-ink-brass/60 hover:border-ink-brass text-[11px] font-bold text-desk-text inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
                    >
                      <Scissors className="w-3.5 h-3.5 text-ink-brass" />
                      {decomposingActor
                        ? t('filmDecomposing')
                        : graph.actor.decomposed
                          ? t('filmReDecomposeBtn')
                          : t('filmDecomposeBtn')}
                    </button>
                    {graph.actor.decomposed && (
                      <button
                        type="button"
                        onClick={() =>
                          commitGraph({ ...graph, actor: { ...graph.actor, decomposed: null } })
                        }
                        className="py-1.5 px-2 rounded-lg bg-desk-panel border border-desk-border text-[11px] font-bold text-desk-muted hover:text-ink-vermilion"
                      >
                        {t('filmSinglePiece')}
                      </button>
                    )}
                  </div>

                  {graph.actor.decomposed && (
                    <div className="p-2 rounded-xl console-well border border-ink-emerald/40 space-y-1.5">
                      <div className="flex items-center justify-between font-mono text-[11px] text-ink-emerald">
                        <span>● {t('filmPartsReady')}</span>
                      </div>
                      <div className="grid grid-cols-6 gap-1">
                        {graph.actor.decomposed.parts.map((pt) => (
                          <div
                            key={pt.id}
                            className="aspect-square rounded-md bg-black/25 border border-desk-border overflow-hidden flex items-center justify-center p-0.5"
                            title={pt.label}
                          >
                            <BlobImage
                              blobKey={pt.blobKey}
                              alt={pt.label}
                              className="w-full h-full object-contain"
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Character Size Slider */}
                  <div className="space-y-1">
                    <div className="flex justify-between font-mono text-[11px] text-desk-muted">
                      <span>{t('filmActorScale')}</span>
                      <span className="text-desk-text font-bold">
                        {Math.round((graph.actor.scale ?? 1) * 100)}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0.7}
                      max={1.4}
                      step={0.05}
                      value={graph.actor.scale ?? 1}
                      onChange={(e) =>
                        commitGraph(
                          { ...graph, actor: { ...graph.actor, scale: Number(e.target.value) } },
                          false
                        )
                      }
                      className="w-full accent-ink-brass"
                    />
                  </div>

                  <ToggleLeverSwitch
                    checked={graph.actor.secondaryPhysics}
                    onChange={(val) =>
                      commitGraph({ ...graph, actor: { ...graph.actor, secondaryPhysics: val } })
                    }
                    label={t('filmScarfPhysics')}
                  />
                </div>

                {/* World & Atmosphere */}
                <div className="pt-2.5 border-t border-desk-border space-y-2">
                  <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-desk-muted flex items-center gap-1.5">
                    <Layers className="w-3.5 h-3.5" />
                    {t('filmWorldTitle')}
                  </span>
                  <div className="grid grid-cols-3 gap-1">
                    {(
                      [
                        { id: 'rainy-alley', label: t('filmWorldRain') },
                        { id: 'golden-hill', label: t('filmWorldSunset') },
                        { id: 'moonlit-forest', label: t('filmWorldForest') },
                      ] as const
                    ).map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() =>
                          commitGraph({
                            ...graph,
                            world: {
                              ...graph.world,
                              setId: s.id as WorldSetId,
                              weather:
                                s.id === 'rainy-alley'
                                  ? 'rain'
                                  : s.id === 'golden-hill'
                                    ? 'wind-leaves'
                                    : 'fireflies',
                              weatherIntensity: Math.max(0.5, graph.world.weatherIntensity),
                            },
                          })
                        }
                        className={`py-1.5 px-1.5 rounded-lg text-[11px] font-bold border transition-colors ${
                          graph.world.setId === s.id
                            ? 'bg-desk-panel border-ink-brass text-desk-text'
                            : 'bg-desk-surface/60 border-desk-border text-desk-muted hover:text-desk-text'
                        }`}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>

                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      disabled={decomposingBg}
                      onClick={() => bgFileRef.current?.click()}
                      className="flex-1 py-1.5 px-2.5 rounded-lg bg-desk-panel border border-desk-border hover:border-ink-brass text-[11px] font-bold text-desk-text inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
                    >
                      <ImageIcon className="w-3.5 h-3.5" />
                      {decomposingBg ? '…' : t('filmUploadBg')}
                    </button>
                    {graph.world.customBgBlobKey && (
                      <>
                        {graph.world.setId !== 'custom' && (
                          <button
                            type="button"
                            onClick={() =>
                              commitGraph({ ...graph, world: { ...graph.world, setId: 'custom' } })
                            }
                            className="py-1.5 px-2 rounded-lg bg-ink-brass/20 border border-ink-brass text-[11px] font-bold text-desk-text"
                          >
                            {t('filmWorldCustom')}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() =>
                            commitGraph({
                              ...graph,
                              world: {
                                ...graph.world,
                                setId: 'rainy-alley',
                                customBgBlobKey: null,
                                decomposedBg: null,
                              },
                            })
                          }
                          className="py-1.5 px-2 rounded-lg bg-desk-panel border border-desk-border text-[11px] font-bold text-ink-vermilion"
                        >
                          {t('filmClearBg')}
                        </button>
                      </>
                    )}
                    <input
                      ref={bgFileRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={handleUploadCustomBg}
                    />
                  </div>

                  {/* Weather Chips */}
                  <div className="space-y-1">
                    <span className="font-mono text-[11px] text-desk-muted block">
                      {t('filmWeatherLabel')}
                    </span>
                    <div className="flex flex-wrap gap-1">
                      {weatherOptions.map((w) => (
                        <button
                          key={w.id}
                          type="button"
                          onClick={() =>
                            commitGraph({
                              ...graph,
                              world: {
                                ...graph.world,
                                weather: w.id,
                                weatherIntensity:
                                  w.id === 'none' ? 0 : Math.max(0.55, graph.world.weatherIntensity),
                              },
                            })
                          }
                          className={`flex-1 min-w-[30%] px-1.5 py-1 rounded-md text-[11px] font-bold border text-center whitespace-nowrap ${
                            graph.world.weather === w.id
                              ? 'bg-desk-panel border-ink-vermilion text-desk-text'
                              : 'border-desk-border text-desk-muted hover:text-desk-text'
                          }`}
                        >
                          {w.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Horizon + Weather Intensity + Wind */}
                  <div className="space-y-1.5 pt-0.5">
                    <div className="space-y-0.5">
                      <div className="flex justify-between font-mono text-[11px] text-desk-muted">
                        <span>{t('filmHorizonDepth')}</span>
                        <span className="text-desk-text font-bold">
                          {Math.round(graph.world.horizonY * 100)}%
                        </span>
                      </div>
                      <input
                        type="range"
                        min={0.38}
                        max={0.7}
                        step={0.01}
                        value={graph.world.horizonY}
                        onChange={(e) =>
                          commitGraph(
                            { ...graph, world: { ...graph.world, horizonY: Number(e.target.value) } },
                            false
                          )
                        }
                        className="w-full accent-ink-brass"
                      />
                    </div>

                    {graph.world.weather !== 'none' && (
                      <div className="space-y-0.5">
                        <div className="flex justify-between font-mono text-[11px] text-desk-muted">
                          <span>{t('filmWeatherIntensity')}</span>
                          <span className="text-desk-text font-bold">
                            {Math.round(graph.world.weatherIntensity * 100)}%
                          </span>
                        </div>
                        <input
                          type="range"
                          min={0.1}
                          max={1}
                          step={0.05}
                          value={graph.world.weatherIntensity}
                          onChange={(e) =>
                            commitGraph(
                              {
                                ...graph,
                                world: {
                                  ...graph.world,
                                  weatherIntensity: Number(e.target.value),
                                },
                              },
                              false
                            )
                          }
                          className="w-full accent-ink-brass"
                        />
                      </div>
                    )}

                    <div className="space-y-0.5">
                      <div className="flex justify-between font-mono text-[11px] text-desk-muted">
                        <span>{t('filmWindSpeed')}</span>
                        <span className="text-desk-text font-bold">
                          {Math.round(graph.world.windStrength * 100)}%
                        </span>
                      </div>
                      <input
                        type="range"
                        min={-1}
                        max={1}
                        step={0.1}
                        value={graph.world.windStrength}
                        onChange={(e) =>
                          commitGraph(
                            {
                              ...graph,
                              world: { ...graph.world, windStrength: Number(e.target.value) },
                            },
                            false
                          )
                        }
                        className="w-full accent-ink-brass"
                      />
                    </div>
                  </div>
                </div>
              </>
            )}

            {/* TAB 3: 100% $0 LIVE CINEMA LOOKS (ZERO DEAD ENDS, ZERO AUTO NETWORK ERRORS!) */}
            {leftTab === 'look' && (
              <>
                <div className="space-y-1.5">
                  <div>
                    <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-ink-brass flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5" />
                      {t('filmLookTitle')}
                    </span>
                    <p className="text-[11px] text-desk-muted mt-0.5 leading-snug">
                      {t('filmLookSubtitle')}
                    </p>
                  </div>

                  {/* 5 Real-Time Cinema Looks (compact cards so all controls + package buttons fit cleanly at 1280x800!) */}
                  <div className="space-y-1">
                    {cinemaLooks.map((lk) => {
                      const active = activeLookId === lk.id;
                      return (
                        <button
                          key={lk.id}
                          type="button"
                          onClick={() => {
                            soundEngine.click(1.06);
                            commitGraph({
                              ...graph,
                              world: {
                                ...graph.world,
                                cinemaLook: lk.id,
                                cinemaGrade: true,
                              },
                            });
                          }}
                          className={`w-full px-2 py-1.5 rounded-xl border text-left flex items-center gap-2 transition-all ${
                            active
                              ? 'bg-desk-panel border-ink-brass shadow-sm'
                              : 'bg-desk-surface/60 border-desk-border hover:border-ink-brass/50'
                          }`}
                        >
                          <span
                            className={`w-6 h-6 rounded-md shrink-0 bg-gradient-to-br ${CINEMA_LOOK_SWATCHES[lk.id]} border border-white/15 shadow-inner`}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="text-[11px] font-bold text-desk-text truncate leading-tight">
                              {lk.label}
                            </div>
                            <div className="text-[11px] text-desk-muted truncate leading-tight">
                              {lk.desc}
                            </div>
                          </div>
                          {active && <span className="hardware-led" data-on="emerald" />}
                        </button>
                      );
                    })}
                  </div>

                  {/* Live Bokeh DOF + Grain + Cinema Bars */}
                  <div className="pt-1.5 border-t border-desk-border space-y-1.5">
                    <div className="space-y-0.5">
                      <div className="flex justify-between font-mono text-[11px] text-desk-muted">
                        <span>{t('filmDofLabel')}</span>
                        <span className="text-desk-text font-bold">
                          {Math.round(activeShot.camera.dofStrength * 100)}%
                        </span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={activeShot.camera.dofStrength}
                        onChange={(e) =>
                          patchActiveShot(
                            (sh) => ({
                              ...sh,
                              camera: { ...sh.camera, dofStrength: Number(e.target.value) },
                            }),
                            false
                          )
                        }
                        className="w-full accent-ink-brass"
                      />
                    </div>

                    <div className="space-y-0.5">
                      <div className="flex justify-between font-mono text-[11px] text-desk-muted">
                        <span>{t('filmGrainLabel')}</span>
                        <span className="text-desk-text font-bold">
                          {Math.round(activeGrain * 100)}%
                        </span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={activeGrain}
                        onChange={(e) =>
                          commitGraph(
                            {
                              ...graph,
                              world: { ...graph.world, grainStrength: Number(e.target.value) },
                            },
                            false
                          )
                        }
                        className="w-full accent-ink-brass"
                      />
                    </div>

                    <ToggleLeverSwitch
                      checked={activeLetterbox}
                      onChange={(val) =>
                        commitGraph({
                          ...graph,
                          world: { ...graph.world, letterbox: val, cinemaGrade: true },
                        })
                      }
                      label={t('filmLetterboxToggle')}
                    />
                  </div>

                  {/* Instant 100% Offline Before/After Comparison + Still PNG */}
                  <div className="grid grid-cols-1 gap-1.5 pt-1">
                    <KeycapButton
                      size="sm"
                      variant="brass"
                      className="w-full"
                      onClick={handleOpenLookCompare}
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      {t('filmCompareBtn')}
                    </KeycapButton>
                    <button
                      type="button"
                      onClick={handleDownloadPosterPng}
                      className="w-full py-1.5 px-2.5 rounded-lg bg-desk-panel border border-desk-border hover:border-ink-brass text-[11px] font-bold text-desk-text inline-flex items-center justify-center gap-1.5"
                    >
                      <ImageIcon className="w-3.5 h-3.5" />
                      {t('filmDownloadStill')}
                    </button>
                  </div>
                </div>

                {/* Portable Film Package (.kagit25d) + Dev-Only Local Accelerator (Hidden in Production!) */}
                <div className="pt-2 border-t border-desk-border space-y-2">
                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      type="button"
                      onClick={() => void handleExportPackage()}
                      className="py-1.5 px-2 rounded-lg bg-desk-panel border border-desk-border hover:border-ink-brass text-[11px] font-bold text-desk-text inline-flex items-center justify-center gap-1"
                    >
                      <Package className="w-3 h-3" />
                      {t('filmExportPackage')}
                    </button>
                    <button
                      type="button"
                      onClick={() => pkgImportRef.current?.click()}
                      className="py-1.5 px-2 rounded-lg bg-desk-panel border border-desk-border hover:border-ink-brass text-[11px] font-bold text-desk-text inline-flex items-center justify-center gap-1"
                    >
                      <Upload className="w-3 h-3" />
                      {t('filmImportPackage')}
                    </button>
                    <input
                      ref={pkgImportRef}
                      type="file"
                      accept=".kagit25d,.zip"
                      className="hidden"
                      onChange={handleImportPackage}
                    />
                  </div>

                  {(import.meta.env.DEV ||
                    (typeof window !== 'undefined' &&
                      new URLSearchParams(window.location.search).get('devServer') === '1')) && (
                    <>
                      <button
                        type="button"
                        onClick={() => setAdvancedOpen((v) => !v)}
                        className="w-full flex items-center justify-between text-[11px] font-mono text-desk-muted hover:text-desk-text"
                      >
                        <span>{t('filmAdvancedServerTitle')}</span>
                        {advancedOpen ? (
                          <ChevronUp className="w-3.5 h-3.5" />
                        ) : (
                          <ChevronDown className="w-3.5 h-3.5" />
                        )}
                      </button>

                      {advancedOpen && (
                        <div className="space-y-2 pt-1">
                          <div className="flex items-center justify-between font-mono text-[11px] px-2 py-1.5 rounded-lg console-well border border-desk-border">
                            <span className={cloudStatus.online ? 'text-ink-emerald' : 'text-desk-muted'}>
                              ● {cloudStatus.online ? t('filmServerConnected') : t('filmServerOffline')}
                            </span>
                          </div>
                          <div className="flex gap-1">
                            <input
                              type="text"
                              value={cloudUrl}
                              onChange={(e) => setCloudUrl(e.target.value)}
                              className="flex-1 min-w-0 rounded-lg console-well border border-desk-border px-2 py-1 font-mono text-[11px] text-desk-text"
                            />
                            <button
                              type="button"
                              disabled={pingingCloud}
                              onClick={() => void handlePingCloud()}
                              className="px-2 py-1 rounded-lg bg-desk-panel border border-desk-border hover:border-ink-brass text-[11px] font-bold text-desk-text shrink-0"
                            >
                              {pingingCloud ? '…' : t('filmServerConnect')}
                            </button>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        </aside>

        {/* CENTER STAGE: Live 16:9 Cinema Monitor + Projected Rota & Bakış + Canlı Performans */}
        <main className="order-1 lg:order-2 shrink-0 min-h-[248px] sm:min-h-[340px] md:min-h-[432px] lg:shrink lg:min-h-0 lg:flex-1 min-w-0 flex flex-col items-center justify-center p-2 sm:p-2.5 lg:p-3 overflow-hidden relative">
          {/* Compact Cinema Header Strip */}
          <div className="w-full max-w-[780px] flex flex-wrap items-center justify-between gap-2 mb-2 shrink-0">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="hardware-led" data-on={playing ? 'vermilion' : 'emerald'} />
              <span className="font-mono text-[11px] font-bold text-desk-text truncate">
                {t('filmShotWord')} {safeShotIdx + 1} · {framingLabelMap[activeShot.framing]} ·{' '}
                {activeShot.durationSec.toFixed(1)}s
              </span>
              {activeShot.voiceTrack && (
                <span className="px-1.5 py-0.5 rounded bg-ink-emerald/15 border border-ink-emerald/40 font-mono text-[11px] font-bold text-ink-emerald">
                  🎙️
                </span>
              )}
              {activeShot.mocapTrack && (
                <span className="px-1.5 py-0.5 rounded bg-ink-brass/15 border border-ink-brass/40 font-mono text-[11px] font-bold text-ink-brass">
                  🎭
                </span>
              )}
            </div>

            <div className="flex items-center gap-1.5">
              {/* Undo / Redo */}
              <button
                type="button"
                disabled={historyCounts.past === 0}
                onClick={handleUndo}
                title={t('filmUndoTitle')}
                className="p-1.5 rounded-lg console-well border border-desk-border text-desk-muted hover:text-desk-text disabled:opacity-35 transition-colors"
              >
                <Undo2 className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                disabled={historyCounts.future === 0}
                onClick={handleRedo}
                title={t('filmRedoTitle')}
                className="p-1.5 rounded-lg console-well border border-desk-border text-desk-muted hover:text-desk-text disabled:opacity-35 transition-colors"
              >
                <Redo2 className="w-3.5 h-3.5" />
              </button>

              <button
                type="button"
                onClick={() => {
                  soundEngine.click(1.06);
                  setPlaying(false);
                  setMocapDeckOpen((v) => {
                    if (v) handleLivePoseChange(null);
                    return !v;
                  });
                }}
                className={`px-2.5 py-1 rounded-lg border font-mono text-[11px] font-bold inline-flex items-center gap-1.5 transition-colors ${
                  mocapDeckOpen
                    ? 'bg-ink-vermilion text-white border-ink-vermilion shadow'
                    : 'bg-desk-surface border-desk-border text-desk-text hover:border-ink-vermilion'
                }`}
              >
                <Video className="w-3.5 h-3.5" />
                {t('filmStageCapture')}
              </button>

              <button
                type="button"
                onClick={() => {
                  soundEngine.click(1.04);
                  setShowGizmos((v) => !v);
                }}
                className={`px-2.5 py-1 rounded-lg border font-mono text-[11px] font-bold inline-flex items-center gap-1.5 transition-colors ${
                  showGizmos
                    ? 'bg-ink-brass/20 border-ink-brass text-desk-text'
                    : 'bg-desk-surface border-desk-border text-desk-muted hover:text-desk-text'
                }`}
              >
                <Crosshair className="w-3.5 h-3.5" />
                {t('filmStagePath')}
              </button>
            </div>
          </div>

          {/* 16:9 Cinema Stage Frame */}
          <div className="w-full max-w-[780px] aspect-video rounded-2xl overflow-hidden border-2 border-desk-border shadow-2xl bg-neutral-950 relative shrink-0">
            <canvas
              ref={canvasRef}
              width={1280}
              height={720}
              onPointerDown={handleStagePointerDown}
              onPointerMove={handleStagePointerMove}
              onPointerUp={handleStagePointerUp}
              onPointerCancel={handleStagePointerUp}
              className={`w-full h-full block ${showGizmos && !playing ? 'cursor-crosshair' : 'cursor-default'}`}
            />

            {/* 100% Offline Before / After Cinema Look Split Curtain Overlay */}
            {comparePreview && (
              <div className="absolute inset-0 z-20 bg-neutral-950 select-none">
                <img
                  src={comparePreview.beforeUrl}
                  alt={t('filmOriginalScene')}
                  className="absolute inset-0 w-full h-full object-contain pointer-events-none"
                />
                <div
                  className="absolute inset-0 overflow-hidden pointer-events-none"
                  style={{ clipPath: `inset(0 0 0 ${compareSplitPct}%)` }}
                >
                  <img
                    src={comparePreview.afterUrl}
                    alt={comparePreview.lookLabel}
                    className="w-full h-full object-contain"
                  />
                </div>
                <div
                  className="absolute top-0 bottom-0 w-0.5 bg-ink-brass shadow-lg pointer-events-none"
                  style={{ left: `${compareSplitPct}%` }}
                >
                  <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-7 h-7 rounded-full bg-ink-brass text-neutral-950 font-mono text-[11px] font-black flex items-center justify-center shadow-xl border-2 border-white">
                    ↔
                  </div>
                </div>

                <div className="absolute top-2.5 left-3 px-2 py-0.5 rounded-md bg-black/75 font-mono text-[11px] font-bold text-white/90">
                  {t('filmOriginalScene')}
                </div>
                <div className="absolute top-2.5 right-3 px-2 py-0.5 rounded-md bg-ink-brass text-neutral-950 font-mono text-[11px] font-bold">
                  {comparePreview.lookLabel}
                </div>

                <div className="absolute bottom-2.5 left-3 right-3 flex items-center gap-2.5 bg-black/80 backdrop-blur-sm px-3 py-1.5 rounded-xl border border-white/15">
                  <span className="font-mono text-[11px] text-white/75">{t('filmBeforeTag')}</span>
                  <input
                    type="range"
                    min={5}
                    max={95}
                    value={compareSplitPct}
                    onChange={(e) => setCompareSplitPct(Number(e.target.value))}
                    className="flex-1 accent-ink-brass"
                  />
                  <span className="font-mono text-[11px] text-ink-brass">{t('filmAfterTag')}</span>
                  <button
                    type="button"
                    onClick={handleDownloadPosterPng}
                    className="px-2.5 py-1 rounded-lg bg-ink-brass text-neutral-950 font-mono text-[11px] font-bold"
                  >
                    {t('filmDownloadStill')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setComparePreview(null)}
                    className="px-2 py-1 rounded-lg bg-white/15 text-white font-mono text-[11px] font-bold hover:bg-white/25"
                  >
                    {t('filmClose')}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Live Pose & Performance Capture Deck */}
          {mocapDeckOpen && (
            <PerformanceMocapDeck
              activeShot={activeShot}
              shotIndex={safeShotIdx}
              onLivePoseChange={handleLivePoseChange}
              onCommitMocap={handleCommitMocap}
              onClearMocap={() => patchActiveShot((sh) => ({ ...sh, mocapTrack: null }))}
              onClose={() => {
                setMocapDeckOpen(false);
                handleLivePoseChange(null);
              }}
              notify={notify}
            />
          )}
        </main>

        {/* RIGHT RAIL: Clean 2-Tab Shot Inspector (Acting | Camera & Voice) */}
        <aside className={`order-3 relative z-10 w-full lg:w-[272px] ${leftTab === 'inspector' ? 'flex flex-1 min-h-0 overflow-y-auto' : 'hidden'} lg:flex lg:flex-none lg:shrink-0 border-t lg:border-t-0 lg:border-l border-desk-border bg-desk-surface flex-col lg:overflow-hidden`}>
          <div className="p-2 border-b border-desk-border flex items-center gap-1 shrink-0">
            {(
              [
                { id: 'acting', label: t('filmRightActing') },
                { id: 'camera', label: t('filmRightCamera') },
              ] as const
            ).map((tabItem) => (
              <button
                key={tabItem.id}
                type="button"
                onClick={() => {
                  soundEngine.click(1.04);
                  setRightTab(tabItem.id);
                }}
                className={`flex-1 py-1.5 px-2 rounded-lg text-[11px] font-bold border transition-colors ${
                  rightTab === tabItem.id
                    ? 'bg-desk-panel border-ink-vermilion text-desk-text shadow-sm'
                    : 'border-transparent text-desk-muted hover:text-desk-text'
                }`}
              >
                {tabItem.label}
              </button>
            ))}
          </div>

          <div className="p-3 lg:flex-1 lg:overflow-y-auto space-y-3">
            {/* RIGHT TAB 1: ACTING */}
            {rightTab === 'acting' && (
              <>
                {/* Cast Switcher & Look-At Actor when 2..6 actors are in scene */}
                {castActors.length >= 2 && (
                  <div className="space-y-1.5 pb-2 border-b border-desk-border">
                    <div className="flex flex-wrap gap-1">
                      {castActors.map((act) => (
                        <button
                          key={act.id}
                          type="button"
                          onClick={() => setSelectedActorId(act.id)}
                          className={`px-2 py-0.5 rounded-full text-[11px] font-bold border transition-colors ${
                            act.id === selectedActor.id
                              ? 'bg-ink-brass text-neutral-950 border-ink-brass'
                              : 'border-desk-border text-desk-muted hover:text-desk-text'
                          }`}
                        >
                          {localizeActorName(act.name, locale)}
                        </button>
                      ))}
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[11px] text-desk-muted shrink-0">
                        {t('filmLookAtLabel')}
                      </span>
                      <select
                        value={activeShot.actorTracks?.[selectedActor.id]?.lookAtActorId ?? ''}
                        onChange={(e) =>
                          patchSelectedActorInShot({ lookAtActorId: e.target.value || null })
                        }
                        className="flex-1 min-w-0 px-2 py-1 rounded-md console-well border border-desk-border text-[11px] font-bold text-desk-text"
                      >
                        <option value="">{t('filmLookAtCamera')}</option>
                        {castActors
                          .filter((a) => a.id !== selectedActor.id)
                          .map((other) => (
                            <option key={other.id} value={other.id}>
                              {localizeActorName(other.name, locale)}
                            </option>
                          ))}
                      </select>
                    </div>
                  </div>
                )}

                {/* Creature-Smart V4 Expanded Actions when non-humanoid or multi-cast */}
                {(selectedActor.creatureClass && selectedActor.creatureClass !== 'humanoid') ||
                castActors.length >= 2 ? (
                  <div className="space-y-1">
                    <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-ink-brass block">
                      {t(
                        ({
                          humanoid: 'v4CreatureHumanoid',
                          quadruped: 'v4CreatureQuadruped',
                          avian_winged: 'v4CreatureAvian',
                          aquatic_fish: 'v4CreatureAquatic',
                          serpentine_tentacle: 'v4CreatureSerpentine',
                          biped_tailed: 'v4CreatureBipedTailed',
                          amorphous_vehicle: 'v4CreatureAmorphous',
                        } as const)[selectedActor.creatureClass ?? 'humanoid']
                      )}{' '}
                      · {t('filmActionGroupAct')}
                    </span>
                    <div className="flex flex-wrap gap-1">
                      {UNIVERSAL_CREATURE_CATALOG[selectedActor.creatureClass ?? 'humanoid'].recommendedActions
                        .slice(0, 6)
                        .map((ua) => {
                          const curUa =
                            activeShot.actorTracks?.[selectedActor.id]?.universalAction ??
                            activeShot.universalAction;
                          return (
                            <button
                              key={ua}
                              type="button"
                              onClick={() => patchSelectedActorInShot({ universalAction: ua })}
                              className={`px-2 py-1 rounded-lg text-[11px] font-bold border transition-colors ${
                                curUa === ua
                                  ? 'bg-ink-brass text-neutral-950 border-ink-brass'
                                  : 'border-desk-border text-desk-muted hover:text-desk-text'
                              }`}
                            >
                              {ua.replace(/-/g, ' ')}
                            </button>
                          );
                        })}
                    </div>
                  </div>
                ) : null}

                {/* 360° 2.5D Character Angle Slider (appears when 2+ views exist!) */}
                {countRigViews(selectedActor.masterRig) >= 2 && (
                  <div className="space-y-1">
                    <div className="flex justify-between font-mono text-[11px] text-desk-muted">
                      <span>{t('filmAngleSliderLabel')}</span>
                      <span className="text-ink-brass font-bold">
                        {activeShot.actorTracks?.[selectedActor.id]?.viewYawDeg ?? activeShot.viewYawDeg ?? 0}°
                      </span>
                    </div>
                    <input
                      type="range"
                      min={-180}
                      max={180}
                      step={5}
                      value={
                        activeShot.actorTracks?.[selectedActor.id]?.viewYawDeg ??
                        activeShot.viewYawDeg ??
                        0
                      }
                      onChange={(e) =>
                        patchSelectedActorInShot({ viewYawDeg: Number(e.target.value) })
                      }
                      className="w-full accent-ink-brass"
                    />
                  </div>
                )}

                <div className="space-y-1.5">
                  <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-desk-muted block">
                    {t('filmActionLabel')}
                  </span>
                  <div className="grid grid-cols-3 gap-1">
                    {actionOptions.map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        title={a.label}
                        onClick={() => patchActiveShot((sh) => ({ ...sh, action: a.id }))}
                        className={`py-1.5 px-1 rounded-lg text-[11px] font-bold border transition-colors truncate ${
                          activeShot.action === a.id
                            ? 'bg-desk-panel border-ink-vermilion text-desk-text'
                            : 'border-desk-border text-desk-muted hover:text-desk-text'
                        }`}
                      >
                        {a.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-desk-muted block">
                    {t('filmMoodLabel')}
                  </span>
                  <div className="grid grid-cols-3 gap-1">
                    {emotionOptions.map((em) => (
                      <button
                        key={em.id}
                        type="button"
                        onClick={() => patchActiveShot((sh) => ({ ...sh, emotion: em.id }))}
                        className={`py-1.5 px-1 rounded-lg text-[11px] font-bold border transition-colors truncate ${
                          activeShot.emotion === em.id
                            ? 'bg-desk-panel border-ink-brass text-desk-text'
                            : 'border-desk-border text-desk-muted hover:text-desk-text'
                        }`}
                      >
                        {em.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-1">
                  <div className="flex justify-between font-mono text-[11px] text-desk-muted">
                    <span>{t('filmHeadTurnLabel')}</span>
                    <span className="text-desk-text font-bold">{activeShot.headAngleX}°</span>
                  </div>
                  <input
                    type="range"
                    min={-35}
                    max={35}
                    step={1}
                    value={activeShot.headAngleX}
                    onChange={(e) =>
                      patchActiveShot(
                        (sh) => ({ ...sh, headAngleX: Number(e.target.value), lookAt: null }),
                        false
                      )
                    }
                    className="w-full accent-ink-vermilion"
                  />
                </div>

                <div className="space-y-1.5">
                  <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-desk-muted block">
                    {t('filmPropLabel')}
                  </span>
                  <div className="grid grid-cols-2 gap-1">
                    {propOptions.map((pr) => (
                      <button
                        key={pr.id}
                        type="button"
                        onClick={() => patchActiveShot((sh) => ({ ...sh, prop: pr.id }))}
                        className={`py-1.5 px-2 rounded-lg text-[11px] font-bold border transition-colors truncate ${
                          activeShot.prop === pr.id
                            ? 'bg-desk-panel border-ink-brass text-desk-text'
                            : 'border-desk-border text-desk-muted hover:text-desk-text'
                        }`}
                      >
                        {pr.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Lightning & Thunder Switch (FIXED: pointer-events-none on thumb span!) */}
                <div className="pt-2 border-t border-desk-border flex items-center justify-between">
                  <span className="font-mono text-[11px] font-bold text-desk-text inline-flex items-center gap-1.5">
                    <CloudLightning className="w-3.5 h-3.5 text-ink-brass" />
                    {t('filmLightningToggle')}
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={activeShot.lightningAtSec !== null}
                    onClick={() => {
                      soundEngine.toggle(activeShot.lightningAtSec === null);
                      patchActiveShot((sh) => ({
                        ...sh,
                        lightningAtSec: sh.lightningAtSec === null ? 0.75 : null,
                      }));
                    }}
                    className={`relative w-10 h-5 rounded-full border transition-colors ${
                      activeShot.lightningAtSec !== null
                        ? 'bg-ink-brass/30 border-ink-brass'
                        : 'console-well border-desk-border'
                    }`}
                  >
                    <span
                      className={`pointer-events-none absolute top-0.5 w-3.5 h-3.5 rounded-full transition-all ${
                        activeShot.lightningAtSec !== null
                          ? 'left-5 bg-ink-brass'
                          : 'left-0.5 bg-desk-muted'
                      }`}
                    />
                  </button>
                </div>
              </>
            )}

            {/* RIGHT TAB 2: CAMERA & VOICE */}
            {rightTab === 'camera' && (
              <>
                <div className="space-y-1.5">
                  <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-desk-muted block">
                    {t('filmFramingLabel')}
                  </span>
                  <div className="grid grid-cols-2 gap-1">
                    {framingOptions.map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => {
                          const endPt = activeShot.motionPath[activeShot.motionPath.length - 1] ?? {
                            x: 0.5,
                            y: 0.8,
                          };
                          const camPatch =
                            f.id === 'closeup'
                              ? { fromZoom: 1.72, toZoom: 1.96, fromY: -0.14, toY: -0.17, tiltDeg: -1.5, dofStrength: 0.75 }
                              : f.id === 'medium'
                                ? { fromZoom: 1.24, toZoom: 1.44, fromY: -0.05, toY: -0.08, tiltDeg: 0, dofStrength: 0.45 }
                                : f.id === 'low-angle'
                                  ? { fromZoom: 1.16, toZoom: 1.36, fromY: 0.04, toY: -0.02, tiltDeg: -4.5, dofStrength: 0.5 }
                                  : { fromZoom: 1.0, toZoom: 1.12, fromY: 0, toY: -0.02, tiltDeg: 0, dofStrength: 0.22 };
                          patchActiveShot((sh) => ({
                            ...sh,
                            framing: f.id,
                            title: `${t('filmShotWord')} ${safeShotIdx + 1} · ${f.label}`,
                            camera: {
                              ...sh.camera,
                              fromX: (endPt.x - 0.5) * 0.3,
                              toX: (endPt.x - 0.5) * 0.3,
                              ...camPatch,
                            },
                          }));
                        }}
                        className={`py-1.5 px-2 rounded-lg text-[11px] font-bold border transition-colors ${
                          activeShot.framing === f.id
                            ? 'bg-desk-panel border-ink-vermilion text-desk-text'
                            : 'border-desk-border text-desk-muted hover:text-desk-text'
                        }`}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Collapsible Manual Camera Fine-Tune */}
                <div className="rounded-xl console-well border border-desk-border p-2 space-y-2">
                  <button
                    type="button"
                    onClick={() => setCameraFineOpen((v) => !v)}
                    className="w-full flex items-center justify-between font-mono text-[11px] font-bold text-desk-muted hover:text-desk-text"
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <SlidersHorizontal className="w-3 h-3 text-ink-brass" />
                      {t('filmCameraFineTune')}
                    </span>
                    {cameraFineOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                  </button>
                  {cameraFineOpen && (
                    <div className="space-y-1.5 pt-1">
                      <div>
                        <div className="flex justify-between font-mono text-[11px] text-desk-muted">
                          <span>{t('filmCamZoom')}</span>
                          <span>{activeShot.camera.toZoom.toFixed(2)}×</span>
                        </div>
                        <input
                          type="range"
                          min={0.95}
                          max={2.3}
                          step={0.05}
                          value={activeShot.camera.toZoom}
                          onChange={(e) => {
                            const z = Number(e.target.value);
                            patchActiveShot(
                              (sh) => ({
                                ...sh,
                                camera: {
                                  ...sh.camera,
                                  fromZoom: Math.max(0.95, Number((z - 0.14).toFixed(2))),
                                  toZoom: z,
                                },
                              }),
                              false
                            );
                          }}
                          className="w-full accent-ink-brass"
                        />
                      </div>
                      <div>
                        <div className="flex justify-between font-mono text-[11px] text-desk-muted">
                          <span>{t('filmCamTilt')}</span>
                          <span>{activeShot.camera.tiltDeg.toFixed(1)}°</span>
                        </div>
                        <input
                          type="range"
                          min={-10}
                          max={10}
                          step={0.5}
                          value={activeShot.camera.tiltDeg}
                          onChange={(e) =>
                            patchActiveShot(
                              (sh) => ({
                                ...sh,
                                camera: { ...sh.camera, tiltDeg: Number(e.target.value) },
                              }),
                              false
                            )
                          }
                          className="w-full accent-ink-brass"
                        />
                      </div>
                      <div>
                        <div className="flex justify-between font-mono text-[11px] text-desk-muted">
                          <span>{t('filmCamHandheld')}</span>
                          <span>{Math.round(activeShot.camera.handheld * 100)}%</span>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.05}
                          value={activeShot.camera.handheld}
                          onChange={(e) =>
                            patchActiveShot(
                              (sh) => ({
                                ...sh,
                                camera: { ...sh.camera, handheld: Number(e.target.value) },
                              }),
                              false
                            )
                          }
                          className="w-full accent-ink-brass"
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* Animation Flow + Duration + Transition */}
                <div className="space-y-2">
                  <div className="space-y-1">
                    <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-desk-muted block">
                      {t('filmRhythmLabel')}
                    </span>
                    <div className="grid grid-cols-3 gap-1">
                      {timingOptions.map((tm) => (
                        <button
                          key={tm.id}
                          type="button"
                          onClick={() => patchActiveShot((sh) => ({ ...sh, timingMode: tm.id }))}
                          className={`py-1 px-1 rounded-lg text-[11px] font-bold border ${
                            activeShot.timingMode === tm.id
                              ? 'bg-desk-panel border-ink-brass text-desk-text'
                              : 'border-desk-border text-desk-muted hover:text-desk-text'
                          }`}
                        >
                          {tm.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-0.5">
                    <div className="flex justify-between font-mono text-[11px] text-desk-muted">
                      <span>{t('filmDurationLabel')}</span>
                      <span className="text-desk-text font-bold">
                        {activeShot.durationSec.toFixed(1)}s
                      </span>
                    </div>
                    <input
                      type="range"
                      min={1.2}
                      max={6}
                      step={0.2}
                      value={activeShot.durationSec}
                      onChange={(e) =>
                        patchActiveShot(
                          (sh) => ({ ...sh, durationSec: Number(e.target.value) }),
                          false
                        )
                      }
                      className="w-full accent-ink-brass"
                    />
                  </div>

                  {/* Shot Transition In: Cut vs Real Cross-Dissolve */}
                  {safeShotIdx > 0 && (
                    <div className="space-y-1">
                      <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-desk-muted block">
                        {t('filmTransitionLabel')}
                      </span>
                      <div className="grid grid-cols-2 gap-1">
                        <button
                          type="button"
                          onClick={() => patchActiveShot((sh) => ({ ...sh, transition: 'cut' }))}
                          className={`py-1.5 px-2 rounded-lg text-[11px] font-bold border ${
                            activeShot.transition === 'cut'
                              ? 'bg-desk-panel border-ink-brass text-desk-text'
                              : 'border-desk-border text-desk-muted'
                          }`}
                        >
                          ✂️ {t('filmTransCut')}
                        </button>
                        <button
                          type="button"
                          onClick={() => patchActiveShot((sh) => ({ ...sh, transition: 'dissolve' }))}
                          className={`py-1.5 px-2 rounded-lg text-[11px] font-bold border ${
                            activeShot.transition === 'dissolve'
                              ? 'bg-desk-panel border-ink-brass text-desk-text'
                              : 'border-desk-border text-desk-muted'
                          }`}
                        >
                          ✨ {t('filmTransDissolve')}
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Dialogue + Voice Recording + 100% $0 Speak Line */}
                <div className="pt-2 border-t border-desk-border space-y-2">
                  <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-ink-brass block">
                    {t('filmDialogueLabel')}
                  </span>
                  <input
                    type="text"
                    value={localizeSceneOrNote(activeShot.dialogue, locale)}
                    onChange={(e) =>
                      patchActiveShot((sh) => ({ ...sh, dialogue: e.target.value }), false)
                    }
                    placeholder={t('filmDialoguePlaceholder')}
                    className="w-full rounded-lg console-well border border-desk-border px-2.5 py-1.5 text-[11px] text-desk-text focus:outline-none focus:border-ink-vermilion"
                  />

                  <div className="flex items-center gap-1.5">
                    <select
                      aria-label={t('filmVoiceCharacter')}
                      value={aiVoiceName}
                      onChange={(e) => setAiVoiceName(e.target.value)}
                      className="flex-1 min-w-0 rounded-lg console-well border border-desk-border px-2 py-1.5 text-[11px] font-bold text-desk-text"
                    >
                      {studioVoices.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={synthesizingVoice}
                      onClick={() => void handleSynthesizeVoice()}
                      className="px-2.5 py-1.5 rounded-lg bg-ink-brass/20 border border-ink-brass text-ink-brass hover:bg-ink-brass/30 text-[11px] font-bold inline-flex items-center gap-1 shrink-0 disabled:opacity-50"
                    >
                      <Sparkles className="w-3 h-3" />
                      {synthesizingVoice ? t('filmVoiceSpeaking') : t('filmVoiceSpeak')}
                    </button>
                  </div>

                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      type="button"
                      disabled={analyzingVoice}
                      onClick={() => void handleToggleMicVoice()}
                      className={`py-1.5 px-2 rounded-lg text-[11px] font-bold border inline-flex items-center justify-center gap-1 ${
                        recordingVoice
                          ? 'bg-red-600 text-white border-red-500 animate-pulse'
                          : 'bg-desk-panel border-desk-border hover:border-ink-vermilion text-desk-text'
                      }`}
                    >
                      {recordingVoice ? (
                        <>
                          <Square className="w-3 h-3 fill-current" />
                          {t('filmVoiceMicStop')}
                        </>
                      ) : (
                        <>
                          <Mic className="w-3 h-3 text-ink-vermilion" />
                          {t('filmVoiceMicStart')}
                        </>
                      )}
                    </button>
                    <button
                      type="button"
                      disabled={analyzingVoice}
                      onClick={() => voiceFileRef.current?.click()}
                      className="py-1.5 px-2 rounded-lg bg-desk-panel border border-desk-border hover:border-ink-brass text-[11px] font-bold text-desk-text inline-flex items-center justify-center gap-1"
                    >
                      <Upload className="w-3 h-3" />
                      {t('filmVoiceUpload')}
                    </button>
                    <input
                      ref={voiceFileRef}
                      type="file"
                      accept="audio/*"
                      className="hidden"
                      onChange={handleUploadVoiceFile}
                    />
                  </div>

                  {recordingVoice && (
                    <div className="p-2 rounded-lg bg-red-600/15 border border-red-500/40 space-y-1">
                      <div className="flex justify-between font-mono text-[11px] text-red-400">
                        <span>● REC</span>
                        <span>{liveVoiceViseme.toUpperCase()}</span>
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-black/40 overflow-hidden">
                        <div
                          className="h-full bg-red-500 transition-all duration-75"
                          style={{ width: `${Math.min(100, Math.round(liveVoiceVu * 100))}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {activeShot.voiceTrack && (
                    <div className="p-2 rounded-xl console-well border border-ink-emerald/40 space-y-1.5">
                      <div className="flex items-center justify-between font-mono text-[11px]">
                        <span className="text-ink-emerald font-bold inline-flex items-center gap-1">
                          <AudioLines className="w-3 h-3" />
                          {t('filmVoiceSynced')} ({activeShot.voiceTrack.durationSec}s)
                        </span>
                        <button
                          type="button"
                          onClick={() => patchActiveShot((sh) => ({ ...sh, voiceTrack: null }))}
                          className="text-desk-muted hover:text-ink-vermilion"
                          title={t('filmVoiceRemove')}
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                      <div className="h-6 flex items-end gap-[2px] px-1">
                        {activeShot.voiceTrack.waveform.map((amp, i) => (
                          <span
                            key={i}
                            className="flex-1 rounded-t bg-ink-emerald/80"
                            style={{ height: `${Math.max(12, Math.round(amp * 100))}%` }}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </aside>
      </div>

      {/* BOTTOM MULTI-SHOT STORYBOARD & TIMELINE */}
      <footer className="border-t border-desk-border bg-desk-surface px-3 py-2 shrink-0 space-y-2 z-20">
        {/* Transport + Audio + Loop Mode + Export Controls */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 flex-wrap">
            <KeycapButton
              data-tour="film-play"
              size="sm"
              variant={playing ? 'brass' : 'vermilion'}
              onClick={() => {
                soundEngine.click(1.06);
                setPlaying((p) => !p);
              }}
            >
              {playing ? (
                <>
                  <Square className="w-3.5 h-3.5 fill-current" />
                  {t('filmStop')}
                </>
              ) : (
                <>
                  <MotionPlayIcon playing={false} className="w-3.5 h-3.5" />
                  {playAllMode ? t('filmPlayAll') : t('filmPlayShot')}
                </>
              )}
            </KeycapButton>

            {/* Full Film vs Single Shot Loop Toggle */}
            <button
              type="button"
              onClick={() => {
                soundEngine.click(1.04);
                setPlayAllMode((v) => !v);
              }}
              className={`px-2 py-1.5 rounded-lg border font-mono text-[11px] font-bold inline-flex items-center gap-1 transition-colors ${
                !playAllMode
                  ? 'bg-ink-brass/20 border-ink-brass text-desk-text'
                  : 'console-well border-desk-border text-desk-muted hover:text-desk-text'
              }`}
              title="L"
            >
              <Repeat className="w-3 h-3" />
              {playAllMode ? t('filmModeAll') : t('filmModeLoop')}
            </button>

            <button
              type="button"
              onClick={() => {
                soundEngine.toggle(!soundOn);
                setSoundOn((v) => !v);
              }}
              className={`px-2 py-1.5 rounded-lg border font-mono text-[11px] font-bold inline-flex items-center gap-1 transition-colors ${
                soundOn && soundEnabled
                  ? 'bg-desk-panel border-ink-emerald text-ink-emerald'
                  : 'console-well border-desk-border text-desk-muted'
              }`}
            >
              <Volume2 className="w-3.5 h-3.5" />
              {t('filmAmbience')}
            </button>

            <button
              type="button"
              onClick={() => {
                soundEngine.toggle(!musicOn);
                setMusicOn((v) => !v);
              }}
              className={`px-2 py-1.5 rounded-lg border font-mono text-[11px] font-bold inline-flex items-center gap-1 transition-colors ${
                musicOn && soundOn && soundEnabled
                  ? 'bg-desk-panel border-ink-brass text-ink-brass'
                  : 'console-well border-desk-border text-desk-muted'
              }`}
            >
              <Music className="w-3.5 h-3.5" />
              {t('filmMusic')}
            </button>
          </div>

          {/* Time Scrubber */}
          <div className="flex items-center gap-2 flex-1 max-w-md min-w-[160px]">
            <span className="font-mono text-[11px] text-desk-muted tabular-nums shrink-0">
              {globalSec.toFixed(1)}s / {(playAllMode ? totalDuration : activeShot.durationSec).toFixed(1)}s
            </span>
            <input
              type="range"
              min={0}
              max={Math.max(0.5, playAllMode ? totalDuration - 0.02 : activeShot.durationSec - 0.02)}
              step={0.05}
              value={Math.min(
                playAllMode ? totalDuration - 0.02 : activeShot.durationSec - 0.02,
                globalSec
              )}
              onChange={(e) => {
                setPlaying(false);
                const val = Number(e.target.value);
                globalSecRef.current = val;
                setGlobalSec(val);
                if (playAllMode) {
                  const res = resolveFilmTimeline(graph.shots, val);
                  setSelectedShotIdx(res.shotIndex);
                }
              }}
              className="flex-1 accent-ink-vermilion"
            />
          </div>

          {/* Right Actions: Fast Send to Draw + Unified Film Export */}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={Boolean(exportingKind)}
              onClick={() => void handleSendShotToDraw()}
              className="px-2.5 py-1.5 rounded-xl console-well border border-desk-border hover:border-ink-brass text-[11px] font-bold text-desk-text inline-flex items-center gap-1.5 disabled:opacity-50"
            >
              <Film className="w-3.5 h-3.5 text-ink-brass" />
              {exportingKind === 'draw' ? exportLabel || `${t('filmSendingToDraw')}…` : t('filmSendToDraw')}
            </button>

            <KeycapButton
              size="sm"
              variant="brass"
              disabled={Boolean(exportingKind)}
              onClick={() => setFilmExportOpen(true)}
            >
              <Download className="w-3.5 h-3.5" />
              {t('filmDownloadBtn')}
            </KeycapButton>
          </div>
        </div>

        {/* Horizontal Storyboard Shot Cards (With Reorder, Localized Duplicate, Clean Add & Dissolve Badge) */}
        <div className="flex items-center gap-2 overflow-x-auto pb-0.5">
          {graph.shots.map((sh, idx) => {
            const active = idx === safeShotIdx;
            const actLabel = actionOptions.find((a) => a.id === sh.action)?.label ?? sh.action;
            return (
              <div
                key={sh.id}
                onClick={() => {
                  setPlaying(false);
                  selectShotAndSeek(idx);
                }}
                className={`group shrink-0 w-52 px-2.5 py-1.5 rounded-xl border cursor-pointer transition-all ${
                  active
                    ? 'bg-desk-panel border-ink-vermilion shadow-md'
                    : 'console-well border-desk-border hover:border-ink-brass/70'
                }`}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="font-mono text-[11px] font-bold text-desk-text truncate flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-ink-brass shrink-0" />
                    {t('filmShotWord')} {idx + 1} · {framingLabelMap[sh.framing]}
                  </span>

                  {active && (
                    <div className="flex items-center gap-0.5 shrink-0">
                      {idx > 0 && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleMoveShot(idx, -1);
                          }}
                          aria-label={t('filmMoveLeft')}
                          title={t('filmMoveLeft')}
                          className="min-w-[28px] min-h-[28px] rounded inline-flex items-center justify-center text-desk-muted hover:text-desk-text hover:bg-desk-surface"
                        >
                          <ArrowLeft className="w-3 h-3" />
                        </button>
                      )}
                      {idx < graph.shots.length - 1 && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleMoveShot(idx, 1);
                          }}
                          aria-label={t('filmMoveRight')}
                          title={t('filmMoveRight')}
                          className="min-w-[28px] min-h-[28px] rounded inline-flex items-center justify-center text-desk-muted hover:text-desk-text hover:bg-desk-surface"
                        >
                          <ArrowRight className="w-3 h-3" />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDuplicateShot(idx);
                        }}
                        aria-label={t('filmDuplicateShot')}
                        title={t('filmDuplicateShot')}
                        className="min-w-[28px] min-h-[28px] rounded inline-flex items-center justify-center text-desk-muted hover:text-ink-brass hover:bg-desk-surface"
                      >
                        <Copy className="w-3 h-3" />
                      </button>
                      {graph.shots.length > 1 && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            const nextShots = graph.shots.filter((_, i) => i !== idx);
                            commitGraph({ ...graph, shots: nextShots });
                            setSelectedShotIdx(Math.max(0, idx - 1));
                          }}
                          aria-label={t('filmDeleteShot')}
                          title={t('filmDeleteShot')}
                          className="min-w-[28px] min-h-[28px] rounded inline-flex items-center justify-center text-desk-muted hover:text-ink-vermilion hover:bg-desk-surface"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  )}
                </div>

                <div className="mt-0.5 flex items-center justify-between font-mono text-[11px] text-desk-muted">
                  <span className="truncate">
                    {sh.durationSec.toFixed(1)}s · {actLabel}
                  </span>
                  <span className="flex items-center gap-1 shrink-0">
                    {idx > 0 && sh.transition === 'dissolve' && <span title={t('filmTransDissolve')}>✨</span>}
                    {sh.voiceTrack && <span>🎙️</span>}
                    {sh.mocapTrack && <span>🎭</span>}
                  </span>
                </div>
              </div>
            );
          })}

          <button
            type="button"
            onClick={handleAddCleanShot}
            className="shrink-0 h-[52px] px-3 rounded-xl border border-dashed border-desk-border hover:border-ink-brass text-desk-muted hover:text-desk-text font-mono text-[11px] font-bold inline-flex items-center gap-1.5 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            {t('filmAddShot')}
          </button>
        </div>
      </footer>

      {/* UNIFIED FILM EXPORT MODAL (Opened by BOTH TopConsoleBar 'İndir' and Bottom 'Filmi İndir'!) */}
      {filmExportOpen && (
        <div
          onClick={() => !exportingKind && setFilmExportOpen(false)}
          className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
        >
          <div
            ref={filmExportDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="film-export-modal-title"
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-2xl max-h-[calc(100dvh-1.5rem)] flex flex-col overflow-y-auto rounded-3xl bg-desk-surface border border-desk-border shadow-2xl"
          >
            <div className="px-5 py-4 border-b border-desk-border flex items-center justify-between shrink-0">
              <div>
                <h2 id="film-export-modal-title" className="text-base font-extrabold text-desk-text">
                  {t('filmExportModalTitle')}
                </h2>
                <p className="font-mono text-[11px] text-desk-muted mt-0.5">
                  {graph.shots.length} {t('filmShotWord')} · {totalDuration.toFixed(1)}s · 1280×720 ·{' '}
                  {t('filmExportModalSub')}
                </p>
              </div>
              <button
                type="button"
                aria-label={t('exportCloseAria')}
                disabled={Boolean(exportingKind)}
                onClick={() => setFilmExportOpen(false)}
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
                {exportingKind !== 'draw' && (
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={handleCancelExport}
                      className="px-3 py-1 rounded-lg bg-desk-panel border border-desk-border hover:border-ink-vermilion font-mono text-[11px] font-bold text-ink-vermilion"
                    >
                      {t('filmExportCancel')}
                    </button>
                  </div>
                )}
              </div>
            )}

            <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* 1. Sound Film Video */}
              <div className="p-4 rounded-2xl console-well border border-ink-vermilion/40 flex flex-col justify-between gap-3">
                <div className="space-y-1">
                  <div className="font-bold text-sm text-desk-text flex items-center gap-2">
                    <Clapperboard className="w-4 h-4 text-ink-vermilion" />
                    {t('filmExportVideoTitle')}
                  </div>
                  <p className="text-[11px] text-desk-muted leading-snug">
                    {t('filmExportVideoDesc')}
                  </p>
                </div>
                <KeycapButton
                  size="sm"
                  variant="vermilion"
                  className="w-full"
                  disabled={Boolean(exportingKind)}
                  onClick={() => void handleExportFilmVideo()}
                >
                  <Download className="w-3.5 h-3.5" />
                  {t('filmExportVideoBtn')}
                </KeycapButton>
              </div>

              {/* 2. Shareable Animated GIF */}
              <div className="p-4 rounded-2xl console-well border border-ink-brass/40 flex flex-col justify-between gap-3">
                <div className="space-y-1">
                  <div className="font-bold text-sm text-desk-text flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-ink-brass" />
                    {t('filmExportGifTitle')}
                  </div>
                  <p className="text-[11px] text-desk-muted leading-snug">
                    {t('filmExportGifDesc')}
                  </p>
                </div>
                <KeycapButton
                  size="sm"
                  variant="brass"
                  className="w-full"
                  disabled={Boolean(exportingKind)}
                  onClick={() => void handleExportFilmGif()}
                >
                  <Download className="w-3.5 h-3.5" />
                  {t('filmExportGifBtn')}
                </KeycapButton>
              </div>

              {/* 3. High-Res Film Poster PNG */}
              <div className="p-4 rounded-2xl console-well border border-desk-border flex flex-col justify-between gap-3">
                <div className="space-y-1">
                  <div className="font-bold text-sm text-desk-text flex items-center gap-2">
                    <ImageIcon className="w-4 h-4 text-ink-emerald" />
                    {t('filmExportPosterTitle')}
                  </div>
                  <p className="text-[11px] text-desk-muted leading-snug">
                    {t('filmExportPosterDesc')}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={Boolean(exportingKind)}
                  onClick={handleDownloadPosterPng}
                  className="w-full py-2 px-3 rounded-xl bg-desk-panel border border-desk-border hover:border-ink-emerald text-xs font-bold text-desk-text inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
                >
                  <Download className="w-3.5 h-3.5" />
                  {t('filmExportPosterBtn')}
                </button>
              </div>

              {/* 4. Fast Send Shot to Draw Desk */}
              <div className="p-4 rounded-2xl console-well border border-desk-border flex flex-col justify-between gap-3">
                <div className="space-y-1">
                  <div className="font-bold text-sm text-desk-text flex items-center gap-2">
                    <Film className="w-4 h-4 text-ink-brass" />
                    {t('filmExportDrawTitle')}
                  </div>
                  <p className="text-[11px] text-desk-muted leading-snug">
                    {t('filmExportDrawDesc')}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={Boolean(exportingKind)}
                  onClick={() => void handleSendShotToDraw()}
                  className="w-full py-2 px-3 rounded-xl bg-desk-panel border border-desk-border hover:border-ink-brass text-xs font-bold text-desk-text inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
                >
                  <Film className="w-3.5 h-3.5" />
                  {t('filmExportDrawBtn')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {masterModalInitialRig && (
        <CharacterMasterModal
          open={masterModalOpen}
          initialRig={masterModalInitialRig}
          onClose={() => setMasterModalOpen(false)}
          onSave={handleSaveActorMasterRig}
        />
      )}
    </div>
  );
}
