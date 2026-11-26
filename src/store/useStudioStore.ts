import { create } from 'zustand';
import {
  ASPECT_DIMENSIONS,
  type AspectPreset,
  type AudioTrackData,
  type BrushSettings,
  type CameraKeyframe,
  type CelFrame,
  type CelLayer,
  type FieldGuideConfig,
  type LayerRole,
  type MeshWarpRig,
  type OnionSkinConfig,
  type PuppetRig,
  type ReferenceItem,
  type SceneAtmosphereId,
  type StudioLocale,
  type StudioMode,
  type StudioProject,
  type StudioScene,
  type StudioTheme,
} from '../types/studio';
import type { FilmProjectGraph } from '../types/film';
import type { CharacterMasterRig } from '../types/masterRig';
import {
  canvasToPngBlob,
  canvasToWebpOrJpegBlob,
  clearScopedStorage,
  collectAllReferencedBlobKeys,
  getBlobBitmap,
  loadAllProjects,
  loadBlob,
  loadGuestBlob,
  loadGuestProjectsOnly,
  makeId,
  requestPersistentStorage,
  saveAllProjects,
  saveBlob,
  setActiveStorageScope,
  StorageQuotaError,
  sweepUnreferencedBlobs,
} from '../engine/db';
import {
  deleteCloudAccount,
  deleteCloudProject,
  fetchAuthMe,
  isStarterDemoProject,
  logoutAccount,
  pushLocalChangesToCloud,
  resetCloudSyncMemo,
  syncUserVault,
  type CloudSyncStatus,
  type CloudUser,
} from '../engine/cloudSync';
import { createBounceExerciseProject, createStarterFlipbookProject, createStarterFlipbookShellProject, hydrateStarterFlipbookProject } from '../engine/starterFlipbook';
import { soundEngine } from '../engine/soundEngine';
import { timelapseRecorder } from '../engine/timelapseRecorder';
import { loadTourProgress, saveTourProgress } from '../engine/tourConfig';
import {
  loadPerformancePref,
  savePerformancePref,
  type PerformancePref,
} from '../engine/deviceTierEngine';

let registeredCanvasFlusher: (() => Promise<void>) | null = null;

/** Registers active DrawWorkspace canvas flusher so frame/scene/play/export actions NEVER lose the last stroke */
export function registerCanvasFlusher(fn: (() => Promise<void>) | null): void {
  registeredCanvasFlusher = fn;
}

export function flushActiveCanvasNow(): Promise<void> {
  return registeredCanvasFlusher ? registeredCanvasFlusher() : Promise.resolve();
}

/** Pure helpers to keep 2D camera keyframe indices synced when frames are inserted, deleted, or reordered */
export function shiftCameraKeyframesOnInsert(
  keyframes: CameraKeyframe[] | undefined,
  insertAt: number
): CameraKeyframe[] {
  if (!keyframes || keyframes.length === 0) return [];
  return keyframes
    .map((kf) => (kf.frame >= insertAt ? { ...kf, frame: kf.frame + 1 } : kf))
    .sort((a, b) => a.frame - b.frame);
}

export function shiftCameraKeyframesOnDelete(
  keyframes: CameraKeyframe[] | undefined,
  deletedIndex: number
): CameraKeyframe[] {
  if (!keyframes || keyframes.length === 0) return [];
  return keyframes
    .filter((kf) => kf.frame !== deletedIndex)
    .map((kf) => (kf.frame > deletedIndex ? { ...kf, frame: kf.frame - 1 } : kf))
    .sort((a, b) => a.frame - b.frame);
}

export function shiftCameraKeyframesOnMove(
  keyframes: CameraKeyframe[] | undefined,
  fromIndex: number,
  toIndex: number
): CameraKeyframe[] {
  if (!keyframes || keyframes.length === 0 || fromIndex === toIndex) return keyframes ?? [];
  return keyframes
    .map((kf) => {
      if (kf.frame === fromIndex) return { ...kf, frame: toIndex };
      if (fromIndex < toIndex && kf.frame > fromIndex && kf.frame <= toIndex) {
        return { ...kf, frame: kf.frame - 1 };
      }
      if (fromIndex > toIndex && kf.frame >= toIndex && kf.frame < fromIndex) {
        return { ...kf, frame: kf.frame + 1 };
      }
      return kf;
    })
    .sort((a, b) => a.frame - b.frame);
}

export interface ToastNotice {
  id: string;
  message: string;
  tone: 'ok' | 'error' | 'info';
}

const PREFS_KEY = 'kagit:ui-prefs:v1';

interface UiPrefs {
  theme: StudioTheme;
  locale: StudioLocale;
  soundEnabled: boolean;
  lightboxDim: number;
}

function loadUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<UiPrefs>;
      return {
        theme: p.theme === 'day' ? 'day' : 'night',
        locale: p.locale === 'en' ? 'en' : 'tr',
        soundEnabled: p.soundEnabled ?? true,
        lightboxDim: typeof p.lightboxDim === 'number' ? p.lightboxDim : 1,
      };
    }
  } catch {
    // ignore
  }
  return { theme: 'night', locale: 'tr', soundEnabled: true, lightboxDim: 1 };
}

function saveUiPrefs(prefs: UiPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // ignore
  }
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let cloudSyncTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleCloudPush(): void {
  const user = useStudioStore.getState().cloudUser;
  if (!user) return;
  if (cloudSyncTimer) clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(() => {
    cloudSyncTimer = null;
    const state = useStudioStore.getState();
    if (!state.cloudUser) return;
    const uid = state.cloudUser.id;
    useStudioStore.setState({ cloudSyncStatus: 'syncing' });
    void pushLocalChangesToCloud(uid, state.projects)
      .then(() => {
        if (useStudioStore.getState().cloudUser?.id === uid) {
          useStudioStore.setState({ cloudSyncStatus: 'synced', cloudLastSyncedAt: Date.now() });
        }
      })
      .catch(() => {
        if (useStudioStore.getState().cloudUser?.id === uid) {
          useStudioStore.setState({
            cloudSyncStatus: typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'error',
          });
        }
      });
  }, 1400);
}

function schedulePersist(projects: StudioProject[]): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void saveAllProjects(projects)
      .then(() => {
        scheduleCloudPush();
      })
      .catch((err) => {
        if (err instanceof StorageQuotaError) {
          useStudioStore.getState().notify(err.message, 'error');
        }
      });
  }, 180);
}

function createBlankFrame(): CelFrame {
  return {
    id: makeId('frm'),
    hold: 1,
    thumbKey: null,
    note: '',
    cameraShake: 0,
    layers: [
      {
        id: makeId('lyr'),
        name: 'Eskiz (Mavi)',
        role: 'rough',
        visible: true,
        locked: false,
        opacity: 0.75,
        blendMode: 'source-over',
        blobKey: null,
      },
      {
        id: makeId('lyr'),
        name: 'Boya',
        role: 'color',
        visible: true,
        locked: false,
        opacity: 1,
        blendMode: 'source-over',
        blobKey: null,
      },
      {
        id: makeId('lyr'),
        name: 'Mürekkep',
        role: 'ink',
        visible: true,
        locked: false,
        opacity: 1,
        blendMode: 'multiply',
        blobKey: null,
      },
    ],
  };
}

/** Ensures every loaded legacy or new project has a consistent scenes[] array & activeSceneId */
function normalizeProject(p: StudioProject): StudioProject {
  if (p.scenes && p.scenes.length > 0) {
    const activeSc = p.scenes.find((s) => s.id === p.activeSceneId) ?? p.scenes[0];
    return {
      ...p,
      paperStyle: p.paperStyle ?? 'bristol',
      meshRigs: p.meshRigs ?? [],
      recentColors: p.recentColors ?? p.palette.slice(0, 6),
      activeSceneId: activeSc.id,
      frames: activeSc.frames,
      backgroundBlobKey: activeSc.backgroundBlobKey ?? p.backgroundBlobKey ?? null,
      backgroundParallax: activeSc.backgroundParallax ?? p.backgroundParallax ?? 0.35,
      cameraKeyframes: activeSc.cameraKeyframes ?? p.cameraKeyframes ?? [],
      atmosphere: activeSc.atmosphere ?? p.atmosphere ?? 'none',
    };
  }
  const scId = makeId('scn');
  const firstScene: StudioScene = {
    id: scId,
    name: 'Sahne 1',
    frames: p.frames.length > 0 ? p.frames : [createBlankFrame()],
    backgroundBlobKey: p.backgroundBlobKey ?? null,
    backgroundParallax: p.backgroundParallax ?? 0.35,
    cameraKeyframes: p.cameraKeyframes ?? [],
    atmosphere: p.atmosphere ?? 'none',
  };
  return {
    ...p,
    paperStyle: p.paperStyle ?? 'bristol',
    meshRigs: p.meshRigs ?? [],
    recentColors: p.recentColors ?? p.palette.slice(0, 6),
    scenes: [firstScene],
    activeSceneId: scId,
    frames: firstScene.frames,
    backgroundBlobKey: firstScene.backgroundBlobKey,
    backgroundParallax: firstScene.backgroundParallax,
    cameraKeyframes: firstScene.cameraKeyframes,
    atmosphere: firstScene.atmosphere,
  };
}

/** Helper to update the active scene and mirror its fields to project.frames / background / camera */
function patchActiveScene(
  proj: StudioProject,
  updater: (scene: StudioScene) => StudioScene
): StudioProject {
  const norm = normalizeProject(proj);
  const scenes = (norm.scenes ?? []).map((sc) =>
    sc.id === norm.activeSceneId ? updater(sc) : sc
  );
  const active = scenes.find((s) => s.id === norm.activeSceneId) ?? scenes[0];
  return {
    ...norm,
    scenes,
    frames: active.frames,
    backgroundBlobKey: active.backgroundBlobKey ?? null,
    backgroundParallax: active.backgroundParallax ?? 0.35,
    cameraKeyframes: active.cameraKeyframes ?? [],
    atmosphere: active.atmosphere ?? 'none',
    updatedAt: new Date().toISOString(),
  };
}

interface StudioState {
  ready: boolean;
  projects: StudioProject[];
  activeProjectId: string | null;
  activeFrameIndex: number;
  activeLayerId: string | null;
  mode: StudioMode;
  exportOpen: boolean;
  filmExportOpen: boolean;
  puppetExportOpen: boolean;
  pendingSamplePaper: boolean;

  // Living Studio Guide & 10s Overview Show
  activeTourMode: StudioMode | null;
  overviewShowOpen: boolean;
  completedTours: StudioMode[];
  guideSeen: boolean;

  // Legal/Privacy Center & Adaptive Device Performance Tier
  legalOpen: boolean;
  legalTab: 'privacy' | 'terms' | 'storage' | 'perf';
  performancePref: PerformancePref;

  // Optional Cloud Account & Per-User Isolated Sync Vault (Cloudflare Workers + D1)
  cloudUser: CloudUser | null;
  googleAuthEnabled: boolean;
  cloudApiAvailable: boolean;
  cloudSyncStatus: CloudSyncStatus;
  cloudLastSyncedAt: number | null;
  cloudBlobBytes: number;
  accountModalOpen: boolean;
  guestImportableCount: number;

  theme: StudioTheme;
  locale: StudioLocale;
  soundEnabled: boolean;
  lightboxDim: number;
  zenMode: boolean;
  rightRailTab: 'layers' | 'table' | 'camera';
  autoSwitchedLayer: { fromId: string; toId: string } | null;

  brush: BrushSettings;
  onion: OnionSkinConfig;
  guides: FieldGuideConfig;

  isPlaying: boolean;
  playbackFrameIndex: number | null;
  loopPlayback: boolean;
  loopRange: { start: number; end: number } | null;
  toast: ToastNotice | null;

  // Lifecycle
  bootstrap: () => Promise<void>;
  notify: (message: string, tone?: 'ok' | 'error' | 'info') => void;
  clearToast: () => void;

  // UI & Theme
  setTheme: (theme: StudioTheme) => void;
  setLocale: (locale: StudioLocale) => void;
  toggleSound: () => void;
  setLightboxDim: (val: number) => void;
  toggleZenMode: () => void;
  setZenMode: (zen: boolean) => void;
  setRightRailTab: (tab: 'layers' | 'table' | 'camera') => void;
  setMode: (mode: StudioMode) => void;
  setExportOpen: (open: boolean) => void;
  setFilmExportOpen: (open: boolean) => void;
  setPuppetExportOpen: (open: boolean) => void;
  clearPendingSamplePaper: () => void;

  // Living Studio Guide Actions
  startTour: (targetMode?: StudioMode) => Promise<void>;
  stopTour: () => void;
  completeTour: (mode: StudioMode) => void;
  resetTourProgress: () => void;
  setOverviewShowOpen: (open: boolean) => void;
  markGuideSeen: () => void;

  // Legal & Device Performance Actions
  openLegal: (tab?: 'privacy' | 'terms' | 'storage' | 'perf') => void;
  closeLegal: () => void;
  setPerformancePref: (pref: PerformancePref) => void;

  // Cloud Account & Isolated Vault Actions
  openAccountModal: () => void;
  closeAccountModal: () => void;
  completeCloudSignIn: (user: CloudUser, googleEnabled?: boolean) => Promise<void>;
  syncCloudNow: (silent?: boolean) => Promise<void>;
  importGuestProjectsToAccount: () => Promise<number>;
  signOutAccount: () => Promise<void>;
  permanentlyDeleteAccount: () => Promise<void>;

  // Brush / Onion / Guides
  updateBrush: (patch: Partial<BrushSettings>) => void;
  updateOnion: (patch: Partial<OnionSkinConfig>) => void;
  updateGuides: (patch: Partial<FieldGuideConfig>) => void;

  // Playback
  setPlaying: (playing: boolean) => void;
  setPlaybackFrameIndex: (index: number | null) => void;
  toggleLoop: () => void;
  setLoopRange: (range: { start: number; end: number } | null) => void;

  // Projects & Multi-Scene
  createProject: (name: string, aspect: AspectPreset, fps: 8 | 12 | 15 | 24) => StudioProject;
  openOrCreateBlankProject: (
    name: string,
    aspect: AspectPreset,
    fps: 8 | 12 | 15 | 24
  ) => StudioProject;
  openProject: (id: string, targetMode?: StudioMode) => void;
  importProject: (project: StudioProject) => void;
  deleteProject: (id: string) => Promise<void>;
  renameProject: (id: string, name: string) => void;
  updateProjectSettings: (
    patch: Partial<
      Pick<StudioProject, 'fps' | 'paperColor' | 'paperStyle' | 'paperGrain' | 'palette'>
    >
  ) => void;

  // 1-Click Starter Experiences
  openSamplePaperDemo: () => void;
  openSampleMeshPuppetDemo: () => Promise<void>;
  openBounceExerciseTemplate: () => Promise<void>;
  openFilmDirectorDemo: () => Promise<void>;
  commitDeskSketchToProject: (sketchCanvas: HTMLCanvasElement, frameIndex: number) => Promise<void>;
  commitDeskSketchToStudio: (
    sketchCanvas: HTMLCanvasElement,
    destination: 'draw' | 'puppet' | 'film',
    title?: string
  ) => Promise<void>;
  updateFilmGraph: (filmGraph: FilmProjectGraph) => void;

  // Multi-Scene Sequencer
  addScene: (name?: string) => void;
  selectScene: (sceneId: string) => void;
  deleteScene: (sceneId: string) => void;
  renameScene: (sceneId: string, name: string) => void;

  // Fixed Background, 2D Cinematic Camera & Atmosphere
  setSceneBackground: (blobKey: string | null) => void;
  setBackgroundParallax: (val: number) => void;
  upsertCameraKeyframe: (kf: CameraKeyframe) => void;
  clearCameraKeyframes: () => void;
  setFrameCameraShake: (frameIndex: number, strength: number) => void;
  setSceneAtmosphere: (atmosphere: SceneAtmosphereId) => void;

  // Frames & Layers
  selectFrame: (index: number) => void;
  selectLayer: (layerId: string) => void;
  addFrameAfterCurrent: (copyCurrent?: boolean) => Promise<void>;
  addImportedPaperFrames: (
    blobs: {
      blob: Blob;
      thumbBlob: Blob;
      transparentBg: boolean;
      paperOriginalBlob?: Blob | null;
    }[]
  ) => Promise<void>;
  deleteFrame: (index: number) => void;
  setFrameHold: (index: number, hold: number) => void;
  updateFrameNote: (index: number, note: string) => void;
  moveFrame: (fromIndex: number, toIndex: number) => void;
  updateLayerBlobAndThumb: (
    frameId: string,
    layerId: string,
    layerBlobKey: string,
    thumbKey: string
  ) => void;
  addLayerToCurrentFrame: (name: string, role: LayerRole) => void;
  updateLayerInCurrentFrame: (layerId: string, patch: Partial<CelLayer>) => void;
  moveLayerInCurrentFrame: (layerId: string, direction: 'up' | 'down') => void;
  deleteLayerInCurrentFrame: (layerId: string) => void;

  // Rigs (Both 2D Mesh Warp & Classic Cutout FK) / Audio / References
  upsertRig: (rig: PuppetRig) => void;
  deleteRig: (rigId: string) => void;
  upsertMeshRig: (rig: MeshWarpRig) => void;
  deleteMeshRig: (rigId: string) => void;
  bakeCanvasesToFrames: (canvases: HTMLCanvasElement[], replace: boolean) => Promise<void>;
  bakeRenderedShotToFrames: (
    count: number,
    renderFrame: (ctx: CanvasRenderingContext2D, frameIndex: number, w: number, h: number) => void,
    options?: {
      replace?: boolean;
      notePrefix?: string;
      layerName?: string;
      topLayerName?: string;
      onProgress?: (done: number, total: number) => void;
    }
  ) => Promise<number>;
  setAudioTrack: (audio: AudioTrackData | null) => void;
  updateAudioTrack: (patch: Partial<AudioTrackData>) => void;
  addReference: (item: ReferenceItem) => void;
  deleteReference: (id: string) => void;
  /** Shared V4 360° 2.5D multi-view character rig carried across Desk, Puppet & Film studios */
  activeMasterRig: CharacterMasterRig | null;
  setActiveMasterRig: (rig: CharacterMasterRig | null) => void;
  ensureStarterProjectHydrated: () => Promise<void>;
}

const initialPrefs = loadUiPrefs();
const initialTour = loadTourProgress();
soundEngine.setEnabled(initialPrefs.soundEnabled);
if (typeof document !== 'undefined') {
  document.documentElement.setAttribute('data-theme', initialPrefs.theme);
  document.documentElement.setAttribute('lang', initialPrefs.locale);
}

let starterHydrationPromise: Promise<void> | null = null;

export const useStudioStore = create<StudioState>((set, get) => ({
  ready: false,
  projects: [],
  activeProjectId: null,
  activeFrameIndex: 0,
  activeLayerId: null,
  mode: 'desk',
  exportOpen: false,
  filmExportOpen: false,
  puppetExportOpen: false,
  pendingSamplePaper: false,

  activeTourMode: null,
  overviewShowOpen: false,
  completedTours: initialTour.completed,
  guideSeen: initialTour.guideSeen,

  legalOpen: false,
  legalTab: 'privacy',
  performancePref: loadPerformancePref(),

  cloudUser: null,
  googleAuthEnabled: false,
  cloudApiAvailable: false,
  cloudSyncStatus: 'guest',
  cloudLastSyncedAt: null,
  cloudBlobBytes: 0,
  accountModalOpen: false,
  guestImportableCount: 0,
  activeMasterRig: null,
  setActiveMasterRig: (rig) => set({ activeMasterRig: rig }),
  ensureStarterProjectHydrated: async () => {
    const pending = get().projects.find((p) => p.starterPendingHydration);
    if (!pending) return;
    if (starterHydrationPromise) return starterHydrationPromise;
    starterHydrationPromise = (async () => {
      try {
        const hydrated = normalizeProject(await hydrateStarterFlipbookProject(pending));
        const curProjects = get().projects.map((p) => (p.id === pending.id ? hydrated : p));
        await saveAllProjects(curProjects);
        const isCurrent = get().activeProjectId === pending.id;
        const inkLyr = hydrated.frames[0]?.layers.find((l) => l.role === 'ink') ?? hydrated.frames[0]?.layers[0];
        set({
          projects: curProjects,
          ...(isCurrent ? { activeLayerId: inkLyr?.id ?? null } : {}),
        });
      } finally {
        starterHydrationPromise = null;
      }
    })();
    return starterHydrationPromise;
  },

  theme: initialPrefs.theme,
  locale: initialPrefs.locale,
  soundEnabled: initialPrefs.soundEnabled,
  lightboxDim: initialPrefs.lightboxDim,
  zenMode: false,
  rightRailTab: 'layers',
  autoSwitchedLayer: null,

  brush: {
    tool: 'gpen',
    shapeKind: 'line',
    color: '#1C1917',
    size: 5,
    opacity: 1,
    stabilizer: 0.42,
    pressureEnabled: true,
    palmRejection: false,
    symmetryX: false,
    bucketReferenceInk: true,
    bucketGapClose: 2,
  },
  onion: {
    enabled: true,
    prevCount: 2,
    nextCount: 1,
    opacity: 0.34,
    colored: true,
  },
  guides: {
    enabled: false,
    thirds: true,
    safeFrame: true,
    centerCross: true,
    underlay: 'none',
    underlayOpacity: 0.34,
    vp1: { x: 0.5, y: 0.44 },
    vp2: { x: 0.86, y: 0.44 },
  },

  isPlaying: false,
  playbackFrameIndex: null,
  loopPlayback: true,
  loopRange: null,
  toast: null,

  bootstrap: async () => {
    void requestPersistentStorage();
    setActiveStorageScope('guest');
    let projects = (await loadAllProjects()).map(normalizeProject);
    let createdShell = false;
    if (projects.length === 0) {
      const starter = normalizeProject(createStarterFlipbookShellProject());
      projects = [starter];
      createdShell = true;
    } else {
      void sweepUnreferencedBlobs(projects).catch(() => {});
    }

    const first = projects[0];
    const inkLayer =
      first?.frames[0]?.layers.find((l) => l.role === 'ink') ?? first?.frames[0]?.layers[0];
    timelapseRecorder.setProject(first?.id ?? null);

    let initialMode: StudioMode = 'desk';
    let authStatusParam: string | null = null;
    let authErrorParam: string | null = null;
    if (typeof window !== 'undefined' && window.location.search) {
      try {
        const sp = new URLSearchParams(window.location.search);
        authStatusParam = sp.get('auth');
        authErrorParam = sp.get('auth_error');
        const modeParam = sp.get('mode');
        if (
          modeParam === 'draw' ||
          modeParam === 'paper' ||
          modeParam === 'puppet' ||
          modeParam === 'film'
        ) {
          initialMode = modeParam;
        }
        if (authStatusParam || authErrorParam || modeParam) {
          sp.delete('auth');
          sp.delete('auth_error');
          sp.delete('mode');
          const clean = sp.toString();
          const nextUrl = `${window.location.pathname}${clean ? `?${clean}` : ''}${window.location.hash}`;
          window.history.replaceState({}, '', nextUrl);
        }
      } catch {
        // ignore URL parse error
      }
    }

    set({
      ready: true,
      mode: initialMode,
      projects,
      activeProjectId: first?.id ?? null,
      activeFrameIndex: 0,
      activeLayerId: inkLayer?.id ?? null,
    });

    if (createdShell && initialMode !== 'desk') {
      void get().ensureStarterProjectHydrated();
    }

    // Non-blocking first-party cloud session check (zero delay for guests or offline devices)

    void fetchAuthMe().then(async (res) => {
      set({
        googleAuthEnabled: res.googleEnabled,
        cloudApiAvailable: res.apiAvailable,
      });
      if (authErrorParam) {
        const isEn = get().locale === 'en';
        const msgMap: Record<string, string> = {
          google_not_configured: isEn
            ? 'Google Sign-In is almost ready — use Email & Password for now.'
            : 'Google ile giriş anahtarları bekleniyor — şimdilik e-posta/şifre ile girebilirsin.',
          google_cancelled: isEn ? 'Google sign-in was cancelled.' : 'Google girişi iptal edildi.',
          google_state_invalid: isEn ? 'Sign-in session expired, please try again.' : 'Giriş oturumu zaman aşımına uğradı, tekrar dene.',
        };
        get().notify(
          msgMap[authErrorParam] || (isEn ? 'Could not complete Google sign-in.' : 'Google girişi tamamlanamadı, tekrar dene.'),
          'error'
        );
      }
      if (res.user) {
        await get().completeCloudSignIn(res.user, res.googleEnabled);
        if (authStatusParam === 'ok') {
          const isEn = get().locale === 'en';
          get().notify(
            isEn ? `Signed in with Google (${res.user.email})` : `Google ile giriş yapıldı (${res.user.email})`,
            'ok'
          );
        }
      }
    });
  },

  openAccountModal: () => set({ accountModalOpen: true }),
  closeAccountModal: () => set({ accountModalOpen: false }),

  completeCloudSignIn: async (user, googleEnabled) => {
    void flushActiveCanvasNow();
    if (cloudSyncTimer) {
      clearTimeout(cloudSyncTimer);
      cloudSyncTimer = null;
    }

    // Count non-starter guest projects currently on this device (before switching scope!)
    const guestProjects = (await loadGuestProjectsOnly()).map(normalizeProject);
    const importableGuest = guestProjects.filter((p) => !isStarterDemoProject(p));

    // Switch IndexedDB namespace strictly to this user's isolated vault
    setActiveStorageScope(user.id);
    let scopedLocal = (await loadAllProjects()).map(normalizeProject);

    set((s) => ({
      cloudUser: user,
      googleAuthEnabled: googleEnabled ?? s.googleAuthEnabled,
      cloudApiAvailable: true,
      cloudSyncStatus: 'syncing',
      guestImportableCount: importableGuest.length,
    }));

    try {
      const { mergedProjects, totalBlobBytes } = await syncUserVault(user.id, scopedLocal);
      let finalProjects = mergedProjects.map(normalizeProject);
      if (finalProjects.length === 0) {
        const starter = normalizeProject(await createStarterFlipbookProject());
        finalProjects = [starter];
      }
      await saveAllProjects(finalProjects);

      const first = finalProjects[0];
      const inkLayer =
        first?.frames[0]?.layers.find((l) => l.role === 'ink') ?? first?.frames[0]?.layers[0] ?? null;
      timelapseRecorder.setProject(first?.id ?? null);

      set({
        projects: finalProjects,
        activeProjectId: first?.id ?? null,
        activeFrameIndex: 0,
        activeLayerId: inkLayer?.id ?? null,
        cloudSyncStatus: 'synced',
        cloudLastSyncedAt: Date.now(),
        cloudBlobBytes: totalBlobBytes,
        isPlaying: false,
        playbackFrameIndex: null,
      });
    } catch {
      if (scopedLocal.length === 0) {
        const starter = normalizeProject(await createStarterFlipbookProject());
        scopedLocal = [starter];
        await saveAllProjects(scopedLocal);
      }
      const first = scopedLocal[0];
      const inkLayer =
        first?.frames[0]?.layers.find((l) => l.role === 'ink') ?? first?.frames[0]?.layers[0] ?? null;
      set({
        projects: scopedLocal,
        activeProjectId: first?.id ?? null,
        activeFrameIndex: 0,
        activeLayerId: inkLayer?.id ?? null,
        cloudSyncStatus: typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'error',
      });
    }
  },

  syncCloudNow: async (silent = false) => {
    const user = get().cloudUser;
    if (!user) return;
    await flushActiveCanvasNow();
    set({ cloudSyncStatus: 'syncing' });
    try {
      const current = get().projects;
      const { mergedProjects, changedLocally, totalBlobBytes } = await syncUserVault(user.id, current);
      if (changedLocally) {
        const normalized = mergedProjects.map(normalizeProject);
        await saveAllProjects(normalized);
        const curActive = get().activeProjectId;
        const stillExists = normalized.find((p) => p.id === curActive) ?? normalized[0] ?? null;
        const inkLayer =
          stillExists?.frames[0]?.layers.find((l) => l.role === 'ink') ??
          stillExists?.frames[0]?.layers[0] ??
          null;
        set({
          projects: normalized,
          activeProjectId: stillExists?.id ?? null,
          activeLayerId: get().activeLayerId ?? inkLayer?.id ?? null,
        });
      }
      set({
        cloudSyncStatus: 'synced',
        cloudLastSyncedAt: Date.now(),
        cloudBlobBytes: totalBlobBytes,
      });
      if (!silent) {
        get().notify(
          get().locale === 'en' ? 'Cloud vault synced!' : 'Bulut kasası senkronize edildi!',
          'ok'
        );
      }
    } catch {
      set({
        cloudSyncStatus: typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'error',
      });
      if (!silent) {
        get().notify(
          get().locale === 'en'
            ? 'Sync failed — your drawings remain safely saved locally.'
            : 'Senkronizasyon başarısız — çizimlerin yerelde güvende.',
          'error'
        );
      }
    }
  },

  importGuestProjectsToAccount: async () => {
    const user = get().cloudUser;
    if (!user) return 0;
    const guestProjects = (await loadGuestProjectsOnly()).map(normalizeProject);
    const importable = guestProjects.filter((p) => !isStarterDemoProject(p));
    if (importable.length === 0) {
      set({ guestImportableCount: 0 });
      return 0;
    }

    const existingIds = new Set(get().projects.map((p) => p.id));
    const toAdd: StudioProject[] = [];
    const guestBlobKeys = collectAllReferencedBlobKeys(importable);

    // Copy every referenced binary blob from guest scope into the signed-in user's isolated scope
    for (const key of guestBlobKeys) {
      const blob = await loadGuestBlob(key);
      if (blob) {
        await saveBlob(blob, key);
      }
    }

    const nowIso = new Date().toISOString();
    for (const gp of importable) {
      if (existingIds.has(gp.id)) continue;
      toAdd.push({ ...gp, updatedAt: nowIso });
    }

    if (toAdd.length > 0) {
      const next = [...toAdd, ...get().projects];
      await saveAllProjects(next);
      set({ projects: next, guestImportableCount: 0 });
      await get().syncCloudNow(true);
    } else {
      set({ guestImportableCount: 0 });
    }

    get().notify(
      get().locale === 'en'
        ? `${toAdd.length} local notebook(s) imported into your cloud vault!`
        : `${toAdd.length} misafir defteri özel bulut kasana aktarıldı!`,
      'ok'
    );
    return toAdd.length;
  },

  signOutAccount: async () => {
    const user = get().cloudUser;
    if (!user) return;
    await flushActiveCanvasNow();
    if (cloudSyncTimer) {
      clearTimeout(cloudSyncTimer);
      cloudSyncTimer = null;
    }
    // Best-effort final push before logout so zero edits are lost
    await pushLocalChangesToCloud(user.id, get().projects).catch(() => {});
    await logoutAccount();
    resetCloudSyncMemo(user.id);
    // Strict shared-device privacy: wipe signed-out account's local IndexedDB copy completely
    await clearScopedStorage(user.id);
    setActiveStorageScope('guest');

    let guestProjects = (await loadAllProjects()).map(normalizeProject);
    if (guestProjects.length === 0) {
      const starter = normalizeProject(await createStarterFlipbookProject());
      guestProjects = [starter];
      await saveAllProjects(guestProjects);
    }
    const first = guestProjects[0];
    const inkLayer =
      first?.frames[0]?.layers.find((l) => l.role === 'ink') ?? first?.frames[0]?.layers[0] ?? null;
    timelapseRecorder.setProject(first?.id ?? null);

    set({
      cloudUser: null,
      cloudSyncStatus: 'guest',
      cloudLastSyncedAt: null,
      cloudBlobBytes: 0,
      guestImportableCount: 0,
      accountModalOpen: false,
      mode: 'desk',
      projects: guestProjects,
      activeProjectId: first?.id ?? null,
      activeFrameIndex: 0,
      activeLayerId: inkLayer?.id ?? null,
      isPlaying: false,
      playbackFrameIndex: null,
    });

    get().notify(
      get().locale === 'en'
        ? 'Signed out — account cache cleared from this device.'
        : 'Çıkış yapıldı — bu cihazdaki hesap önbelleği temizlendi.',
      'info'
    );
  },

  permanentlyDeleteAccount: async () => {
    const user = get().cloudUser;
    if (!user) return;
    await deleteCloudAccount();
    resetCloudSyncMemo(user.id);
    await clearScopedStorage(user.id);
    setActiveStorageScope('guest');

    let guestProjects = (await loadAllProjects()).map(normalizeProject);
    if (guestProjects.length === 0) {
      const starter = normalizeProject(await createStarterFlipbookProject());
      guestProjects = [starter];
      await saveAllProjects(guestProjects);
    }
    const first = guestProjects[0];
    const inkLayer =
      first?.frames[0]?.layers.find((l) => l.role === 'ink') ?? first?.frames[0]?.layers[0] ?? null;
    timelapseRecorder.setProject(first?.id ?? null);

    set({
      cloudUser: null,
      cloudSyncStatus: 'guest',
      cloudLastSyncedAt: null,
      cloudBlobBytes: 0,
      guestImportableCount: 0,
      accountModalOpen: false,
      mode: 'desk',
      projects: guestProjects,
      activeProjectId: first?.id ?? null,
      activeFrameIndex: 0,
      activeLayerId: inkLayer?.id ?? null,
      isPlaying: false,
      playbackFrameIndex: null,
    });

    get().notify(
      get().locale === 'en'
        ? 'Account and all cloud backups permanently deleted.'
        : 'Hesabın ve tüm bulut yedeklerin kalıcı olarak silindi.',
      'info'
    );
  },

  notify: (message, tone = 'ok') => {
    const id = makeId('tst');
    set({ toast: { id, message, tone } });
    setTimeout(() => {
      if (get().toast?.id === id) set({ toast: null });
    }, 3200);
  },

  clearToast: () => set({ toast: null }),

  setTheme: (theme) => {
    document.documentElement.setAttribute('data-theme', theme);
    const { locale, soundEnabled, lightboxDim } = get();
    saveUiPrefs({ theme, locale, soundEnabled, lightboxDim });
    set({ theme });
  },

  setLocale: (locale) => {
    document.documentElement.setAttribute('lang', locale);
    const { theme, soundEnabled, lightboxDim } = get();
    saveUiPrefs({ theme, locale, soundEnabled, lightboxDim });
    set({ locale });
  },

  toggleSound: () => {
    const next = !get().soundEnabled;
    soundEngine.setEnabled(next);
    if (next) soundEngine.toggle(true);
    const { theme, locale, lightboxDim } = get();
    saveUiPrefs({ theme, locale, soundEnabled: next, lightboxDim });
    set({ soundEnabled: next });
  },

  setLightboxDim: (val) => {
    const clamped = Math.max(0.35, Math.min(1, val));
    const { theme, locale, soundEnabled } = get();
    saveUiPrefs({ theme, locale, soundEnabled, lightboxDim: clamped });
    set({ lightboxDim: clamped });
  },

  toggleZenMode: () => set((s) => ({ zenMode: !s.zenMode })),
  setZenMode: (zen) => set({ zenMode: zen }),
  setRightRailTab: (tab) => set({ rightRailTab: tab }),

  setMode: (mode) => {
    if (get().mode === 'draw' && mode !== 'draw') {
      void flushActiveCanvasNow();
    }
    if (mode !== 'desk') {
      const active = get().projects.find((p) => p.id === get().activeProjectId);
      if (active?.starterPendingHydration) {
        void get().ensureStarterProjectHydrated();
      }
    }
    set({
      mode,
      isPlaying: false,
      playbackFrameIndex: null,
      filmExportOpen: false,
      puppetExportOpen: false,
      zenMode: mode === 'draw' ? get().zenMode : false,
    });
  },
  setExportOpen: (open) => {
    if (open) {
      void flushActiveCanvasNow();
      void get().ensureStarterProjectHydrated();
    }
    set({ exportOpen: open, isPlaying: false, playbackFrameIndex: null });
  },
  setFilmExportOpen: (open) => {
    set({ filmExportOpen: open });
  },
  setPuppetExportOpen: (open) => {
    set({ puppetExportOpen: open });
  },
  clearPendingSamplePaper: () => set({ pendingSamplePaper: false }),

  startTour: async (targetMode) => {
    const dest = targetMode ?? get().mode;
    const prev = get();
    saveTourProgress({ completed: prev.completedTours, guideSeen: true });
    set({
      activeTourMode: null,
      overviewShowOpen: false,
      guideSeen: true,
      exportOpen: false,
      filmExportOpen: false,
      puppetExportOpen: false,
      toast: null,
    });

    if (dest !== get().mode) {
      if (dest === 'desk') {
        get().setMode('desk');
      } else if (dest === 'puppet') {
        await get().openSampleMeshPuppetDemo();
      } else if (dest === 'film') {
        await get().openFilmDirectorDemo();
      } else if (dest === 'paper') {
        const cur = get().projects.find((p) => p.id === get().activeProjectId) ?? get().projects[0];
        if (cur) get().openProject(cur.id, 'paper');
        else get().openSamplePaperDemo();
      } else if (dest === 'draw') {
        const cur = get().projects.find((p) => p.id === get().activeProjectId) ?? get().projects[0];
        if (cur) get().openProject(cur.id, 'draw');
        else get().openOrCreateBlankProject('', '16:9', 12);
      }
    }
    set({ activeTourMode: dest });
  },

  stopTour: () => set({ activeTourMode: null }),

  completeTour: (finishedMode) => {
    const cur = get();
    const nextCompleted = Array.from(new Set([...cur.completedTours, finishedMode]));
    saveTourProgress({ completed: nextCompleted, guideSeen: true });
    set({
      activeTourMode: cur.activeTourMode === finishedMode ? null : cur.activeTourMode,
      completedTours: nextCompleted,
      guideSeen: true,
    });
  },

  resetTourProgress: () => {
    saveTourProgress({ completed: [], guideSeen: true });
    set({ completedTours: [], guideSeen: true });
  },

  setOverviewShowOpen: (open) => {
    if (open) {
      saveTourProgress({ completed: get().completedTours, guideSeen: true });
      set({ overviewShowOpen: true, activeTourMode: null, guideSeen: true });
    } else {
      set({ overviewShowOpen: false });
    }
  },

  markGuideSeen: () => {
    if (get().guideSeen) return;
    saveTourProgress({ completed: get().completedTours, guideSeen: true });
    set({ guideSeen: true });
  },

  openLegal: (tab = 'privacy') => {
    set({ legalOpen: true, legalTab: tab, overviewShowOpen: false, activeTourMode: null });
  },

  closeLegal: () => set({ legalOpen: false }),

  setPerformancePref: (pref) => {
    savePerformancePref(pref);
    set({ performancePref: pref });
  },

  updateBrush: (patch) => {
    const cur = get();
    const nextBrush = { ...cur.brush, ...patch };
    let nextActiveLayerId = cur.activeLayerId;
    let nextAutoSwitched = cur.autoSwitchedLayer;
    let autoToast: string | null = null;

    // Smart Tool -> Layer Routing (respects manual user selection while eliminating first-time traps!)
    if (patch.tool && patch.tool !== cur.brush.tool && cur.mode === 'draw' && cur.activeProjectId) {
      const proj = cur.projects.find((p) => p.id === cur.activeProjectId);
      const frame = proj?.frames[cur.activeFrameIndex];
      const curLayer = frame?.layers.find((l) => l.id === cur.activeLayerId);
      if (frame && curLayer) {
        if (patch.tool === 'blue-rough' && curLayer.role !== 'rough') {
          const rough = frame.layers.find((l) => l.role === 'rough' && l.visible && !l.locked);
          if (rough) {
            nextActiveLayerId = rough.id;
            nextAutoSwitched = {
              fromId: cur.autoSwitchedLayer?.fromId ?? curLayer.id,
              toId: rough.id,
            };
            autoToast =
              cur.locale === 'en'
                ? 'Switched to Rough (Blue) layer — hide in one tap on export'
                : 'Eskiz (Mavi) katmanına geçildi — dışa aktarmada tek tuşla gizlenebilir';
          }
        } else if (
          patch.tool === 'bucket' &&
          nextBrush.bucketReferenceInk &&
          curLayer.role === 'ink'
        ) {
          const colorLayer = frame.layers.find((l) => l.role === 'color' && l.visible && !l.locked);
          if (colorLayer) {
            nextActiveLayerId = colorLayer.id;
            nextAutoSwitched = {
              fromId: cur.autoSwitchedLayer?.fromId ?? curLayer.id,
              toId: colorLayer.id,
            };
            autoToast =
              cur.locale === 'en'
                ? 'Switched to Color layer — fills cleanly underneath your ink lines'
                : 'Boya katmanına geçildi — çizgilerinin altı tertemiz boyanır';
          }
        } else if (
          (patch.tool === 'gpen' ||
            patch.tool === 'pencil' ||
            patch.tool === 'dry-brush' ||
            patch.tool === 'screentone' ||
            patch.tool === 'marker' ||
            patch.tool === 'shape') &&
          cur.autoSwitchedLayer &&
          cur.activeLayerId === cur.autoSwitchedLayer.toId
        ) {
          const origin = frame.layers.find(
            (l) => l.id === cur.autoSwitchedLayer!.fromId && l.visible && !l.locked
          );
          if (origin) {
            nextActiveLayerId = origin.id;
          }
          nextAutoSwitched = null;
        }
      }
    }

    if (patch.color && cur.activeProjectId) {
      const colorUp = patch.color.toUpperCase();
      const nextProjects = cur.projects.map((p) => {
        if (p.id !== cur.activeProjectId) return p;
        const prevRecent = p.recentColors ?? [];
        const merged = [colorUp, ...prevRecent.filter((c) => c.toUpperCase() !== colorUp)].slice(0, 8);
        return { ...p, recentColors: merged };
      });
      schedulePersist(nextProjects);
      set({
        brush: nextBrush,
        projects: nextProjects,
        activeLayerId: nextActiveLayerId,
        autoSwitchedLayer: nextAutoSwitched,
      });
    } else {
      set({
        brush: nextBrush,
        activeLayerId: nextActiveLayerId,
        autoSwitchedLayer: nextAutoSwitched,
      });
    }
    if (autoToast) {
      get().notify(autoToast, 'info');
    }
  },

  updateOnion: (patch) => set((s) => ({ onion: { ...s.onion, ...patch } })),
  updateGuides: (patch) => set((s) => ({ guides: { ...s.guides, ...patch } })),

  setPlaying: (playing) => {
    if (playing) {
      void flushActiveCanvasNow();
      set({ isPlaying: true, playbackFrameIndex: get().activeFrameIndex });
    } else {
      set({ isPlaying: false, playbackFrameIndex: null });
    }
  },
  setPlaybackFrameIndex: (index) => set({ playbackFrameIndex: index }),
  toggleLoop: () => set((s) => ({ loopPlayback: !s.loopPlayback })),
  setLoopRange: (range) => set({ loopRange: range }),

  createProject: (name, aspect, fps) => {
    void flushActiveCanvasNow();
    const dim = ASPECT_DIMENSIONS[aspect];
    const now = new Date().toISOString();
    const firstFrame = createBlankFrame();
    const scId = makeId('scn');
    const scene: StudioScene = {
      id: scId,
      name: 'Sahne 1',
      frames: [firstFrame],
      backgroundBlobKey: null,
      backgroundParallax: 0.35,
      cameraKeyframes: [],
      atmosphere: 'none',
    };
    const defaultTitle = get().locale === 'en' ? 'New Animation' : 'Yeni Çizgi Film';
    const project: StudioProject = {
      id: makeId('prj'),
      name: name.trim() || defaultTitle,
      aspect,
      width: dim.w,
      height: dim.h,
      fps,
      paperColor: '#F7F3E9',
      paperStyle: 'bristol',
      paperGrain: 0.32,
      frames: [firstFrame],
      scenes: [scene],
      activeSceneId: scId,
      backgroundBlobKey: null,
      backgroundParallax: 0.35,
      cameraKeyframes: [],
      atmosphere: 'none',
      rigs: [],
      meshRigs: [],
      audio: null,
      references: [],
      palette: [
        '#1C1917',
        '#E54D2E',
        '#2563EB',
        '#D99B26',
        '#16A34A',
        '#8B5E3C',
        '#EFE6D5',
      ],
      recentColors: ['#1C1917', '#E54D2E', '#2563EB', '#D99B26'],
      createdAt: now,
      updatedAt: now,
    };

    const next = [project, ...get().projects];
    schedulePersist(next);
    timelapseRecorder.setProject(project.id);
    const ink = firstFrame.layers.find((l) => l.role === 'ink') ?? firstFrame.layers[0];
    set({
      projects: next,
      activeProjectId: project.id,
      activeFrameIndex: 0,
      activeLayerId: ink.id,
      autoSwitchedLayer: null,
      loopRange: null,
      mode: 'draw',
      isPlaying: false,
      playbackFrameIndex: null,
    });
    return project;
  },

  openOrCreateBlankProject: (name, aspect, fps) => {
    const customName = name.trim();
    if (!customName) {
      const reusable = get().projects.find((p) => {
        const isDefaultName = p.name === 'Yeni Çizgi Film' || p.name === 'New Animation';
        const singleScene = !p.scenes || p.scenes.length <= 1;
        const singleBlankFrame =
          p.frames.length === 1 &&
          p.frames[0].layers.every((l) => !l.blobKey) &&
          !p.frames[0].note;
        return (
          isDefaultName &&
          singleScene &&
          singleBlankFrame &&
          !p.audio &&
          !p.backgroundBlobKey &&
          p.aspect === aspect &&
          p.fps === fps
        );
      });
      if (reusable) {
        get().openProject(reusable.id, 'draw');
        return reusable;
      }
    }
    return get().createProject(name, aspect, fps);
  },

  openProject: (id, targetMode = 'draw') => {
    if (get().activeProjectId !== id) {
      void flushActiveCanvasNow();
    }
    const p = get().projects.find((x) => x.id === id);
    if (!p) return;
    timelapseRecorder.setProject(p.id);
    const ink = p.frames[0]?.layers.find((l) => l.role === 'ink') ?? p.frames[0]?.layers[0] ?? null;
    set({
      activeProjectId: p.id,
      activeFrameIndex: 0,
      activeLayerId: ink?.id ?? null,
      autoSwitchedLayer: null,
      loopRange: null,
      mode: targetMode,
      isPlaying: false,
      playbackFrameIndex: null,
    });
  },

  importProject: (project) => {
    void flushActiveCanvasNow();
    const norm = normalizeProject(project);
    const next = [norm, ...get().projects.filter((p) => p.id !== norm.id)];
    schedulePersist(next);
    timelapseRecorder.setProject(norm.id);
    const ink = norm.frames[0]?.layers.find((l) => l.role === 'ink') ?? norm.frames[0]?.layers[0];
    set({
      projects: next,
      activeProjectId: norm.id,
      activeFrameIndex: 0,
      activeLayerId: ink?.id ?? null,
      autoSwitchedLayer: null,
      loopRange: null,
      mode: 'draw',
      isPlaying: false,
      playbackFrameIndex: null,
    });
  },

  deleteProject: async (id) => {
    const remaining = get().projects.filter((p) => p.id !== id);
    await saveAllProjects(remaining);
    void sweepUnreferencedBlobs(remaining).catch(() => {});
    const user = get().cloudUser;
    if (user) {
      void deleteCloudProject(user.id, id);
    }
    const fallback = remaining[0] ?? null;
    const deletedActive = get().activeProjectId === id;
    if (deletedActive) {
      timelapseRecorder.setProject(fallback?.id ?? null);
    }
    const fallbackInk =
      fallback?.frames[0]?.layers.find((l) => l.role === 'ink') ??
      fallback?.frames[0]?.layers[0] ??
      null;
    set({
      projects: remaining,
      activeProjectId: deletedActive ? fallback?.id ?? null : get().activeProjectId,
      activeFrameIndex: deletedActive ? 0 : get().activeFrameIndex,
      activeLayerId: deletedActive ? fallbackInk?.id ?? null : get().activeLayerId,
      autoSwitchedLayer: null,
      loopRange: null,
      isPlaying: false,
      playbackFrameIndex: null,
      mode: deletedActive ? 'desk' : get().mode,
    });
  },

  renameProject: (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const next = get().projects.map((p) =>
      p.id === id ? { ...p, name: trimmed, updatedAt: new Date().toISOString() } : p
    );
    schedulePersist(next);
    set({ projects: next });
  },

  updateProjectSettings: (patch) => {
    const pid = get().activeProjectId;
    if (!pid) return;
    const next = get().projects.map((p) =>
      p.id === pid ? { ...p, ...patch, updatedAt: new Date().toISOString() } : p
    );
    schedulePersist(next);
    set({ projects: next });
  },

  openSamplePaperDemo: () => {
    let target = get().projects.find((p) => p.id === get().activeProjectId) ?? get().projects[0];
    if (!target) {
      target = get().createProject('Örnek Kağıt Tarama', '16:9', 12);
    }
    set({
      activeProjectId: target.id,
      mode: 'paper',
      pendingSamplePaper: true,
      isPlaying: false,
    });
  },

  openSampleMeshPuppetDemo: async () => {
    let target = get().projects.find((p) => p.id === get().activeProjectId) ?? get().projects[0];
    if (!target) {
      const title = get().locale === 'en' ? 'My Live Puppet' : 'Canlı Kuklam';
      target = get().createProject(title, '16:9', 12);
    }
    const hasAnyRig = (target.meshRigs?.length ?? 0) > 0;
    if (!hasAnyRig) {
      const { createSampleMeshWarpRig } = await import('../engine/starterPresets');
      const sampleRig = await createSampleMeshWarpRig();
      const nextProjects = get().projects.map((p) =>
        p.id === target!.id
          ? {
              ...p,
              meshRigs: [sampleRig, ...(p.meshRigs ?? [])],
              updatedAt: new Date().toISOString(),
            }
          : p
      );
      schedulePersist(nextProjects);
      set({
        projects: nextProjects,
        activeProjectId: target.id,
        mode: 'puppet',
        isPlaying: false,
      });
      get().notify(
        get().locale === 'en'
          ? 'Live puppet ready — drag any pin, pick a move, or make it talk!'
          : 'Canlı kukla hazır — pimleri sürükle, hareket seç veya konuştur!'
      );
    } else {
      set({ activeProjectId: target.id, mode: 'puppet', isPlaying: false });
    }
  },

  openBounceExerciseTemplate: async () => {
    const locale = get().locale;
    const title =
      locale === 'en' ? '12-Frame Bouncing Ball Drill' : '12 Kare Zıplayan Top Egzersizi';
    const existing = get().projects.find((p) => p.name === title);
    if (existing) {
      const ink =
        existing.frames[0]?.layers.find((l) => l.role === 'ink') ?? existing.frames[0]?.layers[0];
      set((s) => ({
        activeProjectId: existing.id,
        activeFrameIndex: 0,
        activeLayerId: ink?.id ?? null,
        mode: 'draw',
        isPlaying: false,
        guides: { ...s.guides, enabled: true, underlay: 'bounce' },
      }));
      return;
    }

    const drill = normalizeProject(await createBounceExerciseProject(title));
    const next = [drill, ...get().projects];
    schedulePersist(next);
    const ink = drill.frames[0]?.layers.find((l) => l.role === 'ink') ?? drill.frames[0]?.layers[0];
    set((s) => ({
      projects: next,
      activeProjectId: drill.id,
      activeFrameIndex: 0,
      activeLayerId: ink?.id ?? null,
      loopRange: null,
      mode: 'draw',
      isPlaying: false,
      guides: { ...s.guides, enabled: true, underlay: 'bounce' },
    }));
    get().notify(
      locale === 'en'
        ? '12-Frame Bounce guide enabled — trace each numbered oval!'
        : '12 Kare Zıplama kılavuzu açıldı — numaralı daireleri takip ederek çiz!'
    );
  },

  openFilmDirectorDemo: async () => {
    let target = get().projects.find((p) => p.id === get().activeProjectId) ?? get().projects[0];
    if (!target) {
      const title = get().locale === 'en' ? 'My Short Film' : 'Mini Filmim';
      target = get().createProject(title, '16:9', 12);
    }
    if (!target.filmGraph) {
      const { compileDirectorPromptToFilmGraph, DIRECTOR_PRESETS } = await import('../engine/film25dEngine');
      const graph = compileDirectorPromptToFilmGraph(DIRECTOR_PRESETS[0].prompt);
      const nextProjects = get().projects.map((p) =>
        p.id === target!.id ? { ...p, filmGraph: graph, updatedAt: new Date().toISOString() } : p
      );
      schedulePersist(nextProjects);
      set({ projects: nextProjects, activeProjectId: target.id, mode: 'film', isPlaying: false });
    } else {
      set({ activeProjectId: target.id, mode: 'film', isPlaying: false });
    }
  },

  updateFilmGraph: (filmGraph) => {
    const pid = get().activeProjectId;
    if (!pid) return;
    const nextProjects = get().projects.map((p) =>
      p.id === pid ? { ...p, filmGraph, updatedAt: new Date().toISOString() } : p
    );
    schedulePersist(nextProjects);
    set({ projects: nextProjects });
  },

  commitDeskSketchToProject: async (sketchCanvas, frameIndex) => {
    let target = get().projects[0];
    if (!target) {
      target = get().createProject('İlk Çizimim', '16:9', 12);
    }
    const safeIdx = Math.max(0, Math.min(target.frames.length - 1, frameIndex));
    const frame = target.frames[safeIdx];
    const inkLayer = frame.layers.find((l) => l.role === 'ink') ?? frame.layers[frame.layers.length - 1];
    if (!inkLayer) return;

    // Composite existing ink layer + new live desk sketch at native project resolution
    const comp = document.createElement('canvas');
    comp.width = target.width;
    comp.height = target.height;
    const ctx = comp.getContext('2d')!;
    if (inkLayer.blobKey) {
      const existingBmp = await getBlobBitmap(inkLayer.blobKey);
      if (existingBmp) ctx.drawImage(existingBmp, 0, 0, target.width, target.height);
    }
    ctx.drawImage(sketchCanvas, 0, 0, target.width, target.height);

    const newInkKey = await saveBlob(await canvasToPngBlob(comp));

    // Re-render frame thumbnail including all visible layers + updated ink
    const thumb = document.createElement('canvas');
    thumb.width = 512;
    thumb.height = Math.max(144, Math.round((target.height / target.width) * 512));
    const tctx = thumb.getContext('2d')!;
    tctx.fillStyle = target.paperColor || '#F7F3E9';
    tctx.fillRect(0, 0, thumb.width, thumb.height);
    for (const l of frame.layers) {
      if (!l.visible) continue;
      if (l.id === inkLayer.id) {
        tctx.save();
        tctx.globalAlpha = l.opacity;
        tctx.drawImage(comp, 0, 0, thumb.width, thumb.height);
        tctx.restore();
      } else if (l.blobKey) {
        const bmp = await getBlobBitmap(l.blobKey);
        if (bmp) {
          tctx.save();
          tctx.globalAlpha = l.opacity;
          tctx.drawImage(bmp, 0, 0, thumb.width, thumb.height);
          tctx.restore();
        }
      }
    }
    const newThumbKey = await saveBlob(await canvasToWebpOrJpegBlob(thumb, 0.88));

    const nextProjects = get().projects.map((p) => {
      if (p.id !== target!.id) return p;
      return patchActiveScene(p, (sc) => ({
        ...sc,
        frames: sc.frames.map((f, idx) =>
          idx !== safeIdx
            ? f
            : {
                ...f,
                thumbKey: newThumbKey,
                layers: f.layers.map((l) =>
                  l.id === inkLayer.id ? { ...l, blobKey: newInkKey } : l
                ),
              }
        ),
      }));
    });
    schedulePersist(nextProjects);
    set({
      projects: nextProjects,
      activeProjectId: target.id,
      activeFrameIndex: safeIdx,
      activeLayerId: inkLayer.id,
      mode: 'draw',
      isPlaying: false,
    });
    const locale = get().locale;
    get().notify(
      locale === 'en'
        ? `Your sketch was inked onto Frame #${safeIdx + 1} — keep animating!`
        : `Çizimin Kare #${safeIdx + 1} mürekkep katmanına işlendi — devam edebilirsin!`
    );
  },

  commitDeskSketchToStudio: async (sketchCanvas, destination, title) => {
    const locale = get().locale;
    const defaultTitle =
      title?.trim() ||
      (locale === 'en' ? 'My Live Sketch' : 'Canlı Çizimim');

    // Crop sketch tightly around drawn pixels with generous margin for puppet/film actors
    if (destination === 'draw') {
      const proj = get().createProject(defaultTitle, '16:9', 12);
      const frame = proj.frames[0];
      const inkLayer = frame.layers.find((l) => l.role === 'ink') ?? frame.layers[frame.layers.length - 1];
      const comp = document.createElement('canvas');
      comp.width = proj.width;
      comp.height = proj.height;
      comp.getContext('2d')!.drawImage(sketchCanvas, 0, 0, proj.width, proj.height);
      const inkKey = await saveBlob(await canvasToPngBlob(comp));

      const thumb = document.createElement('canvas');
      thumb.width = 512;
      thumb.height = Math.max(144, Math.round((proj.height / proj.width) * 512));
      const tctx = thumb.getContext('2d')!;
      tctx.fillStyle = proj.paperColor;
      tctx.fillRect(0, 0, thumb.width, thumb.height);
      tctx.drawImage(comp, 0, 0, thumb.width, thumb.height);
      const thumbKey = await saveBlob(await canvasToWebpOrJpegBlob(thumb, 0.88));

      const nextProjects = get().projects.map((p) =>
        p.id === proj.id
          ? patchActiveScene(p, (sc) => ({
              ...sc,
              frames: sc.frames.map((f, idx) =>
                idx !== 0
                  ? f
                  : {
                      ...f,
                      thumbKey,
                      layers: f.layers.map((l) =>
                        l.id === inkLayer.id ? { ...l, blobKey: inkKey } : l
                      ),
                    }
              ),
            }))
          : p
      );
      schedulePersist(nextProjects);
      set({
        projects: nextProjects,
        activeProjectId: proj.id,
        activeFrameIndex: 0,
        activeLayerId: inkLayer.id,
        mode: 'draw',
        isPlaying: false,
      });
      get().notify(
        locale === 'en'
          ? 'Your sketch opened on the drawing desk!'
          : 'Çizimin çizim masasına açıldı — devam edebilirsin!'
      );
      return;
    }

    const { prepareCharacterCanvas } = await import('../engine/characterIntakeEngine');
    const prepared = prepareCharacterCanvas(sketchCanvas, { maxDim: 768, stripPaper: false });
    const cropped = prepared.canvas;
    const anatomy = prepared.anatomy;
    const blobKey = await saveBlob(await canvasToPngBlob(cropped));

    let target = get().projects.find((p) => p.id === get().activeProjectId) ?? get().projects[0];
    if (!target) {
      target = get().createProject(defaultTitle, '16:9', 12);
    }

    if (destination === 'puppet') {
      const { createAnatomyMeshPins, generateMeshPresetFrames } = await import('../engine/meshWarpEngine');
      const pins = createAnatomyMeshPins(anatomy, 'humanoid');
      const totalFrames = 24;
      const rig: MeshWarpRig = {
        id: makeId('mrg'),
        name: defaultTitle,
        sourceBlobKey: blobKey,
        sourceW: cropped.width,
        sourceH: cropped.height,
        pins,
        frames: generateMeshPresetFrames(pins, totalFrames, 'dance'),
        totalFrames,
        lineBoil: 0.35,
        mouthPos: {
          x: Number(anatomy.mouthX.toFixed(3)),
          y: Number(anatomy.mouthY.toFixed(3)),
          scale: Number(anatomy.mouthScale.toFixed(2)),
        },
        autoBlink: true,
      };
      const nextProjects = get().projects.map((p) =>
        p.id === target!.id
          ? {
              ...p,
              meshRigs: [rig, ...(p.meshRigs ?? [])],
              updatedAt: new Date().toISOString(),
            }
          : p
      );
      schedulePersist(nextProjects);
      set({
        projects: nextProjects,
        activeProjectId: target.id,
        mode: 'puppet',
        isPlaying: false,
      });
      get().notify(
        locale === 'en'
          ? 'Your sketch is live with anatomical 2-bone joints!'
          : 'Çizimin otomatik eklemlerle canlı kukla olarak hazır!'
      );
      return;
    }

    // destination === 'film'
    const { compileDirectorPromptToFilmGraph, DIRECTOR_PRESETS, extractStyleDNAFromPixels } =
      await import('../engine/film25dEngine');
    const cctx = cropped.getContext('2d')!;
    const rgba = cctx.getImageData(0, 0, cropped.width, cropped.height).data;
    const styleDna = extractStyleDNAFromPixels(rgba, cropped.width, cropped.height);
    const baseGraph = compileDirectorPromptToFilmGraph(DIRECTOR_PRESETS[0].prompt, {
      id: makeId('act'),
      name: defaultTitle,
      sourceBlobKey: blobKey,
      sourceW: cropped.width,
      sourceH: cropped.height,
      styleDna,
      rigidHeadEndY: anatomy.headEndV,
      secondaryPhysics: false,
      decomposed: null,
    });
    const nextProjects = get().projects.map((p) =>
      p.id === target!.id
        ? { ...p, filmGraph: baseGraph, updatedAt: new Date().toISOString() }
        : p
    );
    schedulePersist(nextProjects);
    set({
      projects: nextProjects,
      activeProjectId: target.id,
      mode: 'film',
      isPlaying: false,
    });
    get().notify(
      locale === 'en'
        ? 'Your sketch is starring in the rainy mini film!'
        : 'Çizimin yağmurlu mini filmin başrolünde — oynat veya yönet!'
    );
  },

  addScene: (name) => {
    void flushActiveCanvasNow();
    const pid = get().activeProjectId;
    const p = get().projects.find((x) => x.id === pid);
    if (!p) return;
    const norm = normalizeProject(p);
    const scList = norm.scenes ?? [];
    const newFrame = createBlankFrame();
    const prefix = get().locale === 'en' ? 'Scene' : 'Sahne';
    const newSc: StudioScene = {
      id: makeId('scn'),
      name: name?.trim() || `${prefix} ${scList.length + 1}`,
      frames: [newFrame],
      backgroundBlobKey: null,
      backgroundParallax: 0.35,
      cameraKeyframes: [],
      atmosphere: 'none',
    };
    const nextProjects = get().projects.map((proj) =>
      proj.id === pid
        ? {
            ...norm,
            scenes: [...scList, newSc],
            activeSceneId: newSc.id,
            frames: newSc.frames,
            backgroundBlobKey: null,
            cameraKeyframes: [],
            atmosphere: 'none' as SceneAtmosphereId,
            updatedAt: new Date().toISOString(),
          }
        : proj
    );
    schedulePersist(nextProjects);
    const ink = newFrame.layers.find((l) => l.role === 'ink') ?? newFrame.layers[0];
    set({
      projects: nextProjects,
      activeFrameIndex: 0,
      activeLayerId: ink.id,
      autoSwitchedLayer: null,
      loopRange: null,
      isPlaying: false,
      playbackFrameIndex: null,
    });
  },

  selectScene: (sceneId) => {
    void flushActiveCanvasNow();
    const pid = get().activeProjectId;
    const p = get().projects.find((x) => x.id === pid);
    if (!p) return;
    const norm = normalizeProject(p);
    const target = (norm.scenes ?? []).find((s) => s.id === sceneId);
    if (!target) return;

    const nextProjects = get().projects.map((proj) =>
      proj.id === pid
        ? {
            ...norm,
            activeSceneId: target.id,
            frames: target.frames,
            backgroundBlobKey: target.backgroundBlobKey ?? null,
            backgroundParallax: target.backgroundParallax ?? 0.35,
            cameraKeyframes: target.cameraKeyframes ?? [],
            atmosphere: target.atmosphere ?? 'none',
          }
        : proj
    );
    schedulePersist(nextProjects);
    const ink =
      target.frames[0]?.layers.find((l) => l.role === 'ink') ?? target.frames[0]?.layers[0];
    set({
      projects: nextProjects,
      activeFrameIndex: 0,
      activeLayerId: ink?.id ?? null,
      autoSwitchedLayer: null,
      loopRange: null,
      isPlaying: false,
      playbackFrameIndex: null,
    });
  },

  deleteScene: (sceneId) => {
    void flushActiveCanvasNow();
    const pid = get().activeProjectId;
    const p = get().projects.find((x) => x.id === pid);
    if (!p) return;
    const norm = normalizeProject(p);
    const scList = norm.scenes ?? [];
    if (scList.length <= 1) return;
    const remaining = scList.filter((s) => s.id !== sceneId);
    const active = remaining.find((s) => s.id === norm.activeSceneId) ?? remaining[0];
    const nextProjects = get().projects.map((proj) =>
      proj.id === pid
        ? {
            ...norm,
            scenes: remaining,
            activeSceneId: active.id,
            frames: active.frames,
            backgroundBlobKey: active.backgroundBlobKey ?? null,
            backgroundParallax: active.backgroundParallax ?? 0.35,
            cameraKeyframes: active.cameraKeyframes ?? [],
            atmosphere: active.atmosphere ?? 'none',
            updatedAt: new Date().toISOString(),
          }
        : proj
    );
    schedulePersist(nextProjects);
    // Always re-bind activeLayerId to the remaining active scene's first frame so drawing never locks up!
    const nextInk =
      active.frames[0]?.layers.find((l) => l.role === 'ink') ?? active.frames[0]?.layers[0] ?? null;
    set({
      projects: nextProjects,
      activeFrameIndex: 0,
      activeLayerId: nextInk?.id ?? null,
      autoSwitchedLayer: null,
      loopRange: null,
      isPlaying: false,
      playbackFrameIndex: null,
    });
  },

  renameScene: (sceneId, name) => {
    const pid = get().activeProjectId;
    if (!name.trim()) return;
    const nextProjects = get().projects.map((proj) => {
      if (proj.id !== pid) return proj;
      const norm = normalizeProject(proj);
      return {
        ...norm,
        scenes: (norm.scenes ?? []).map((s) =>
          s.id === sceneId ? { ...s, name: name.trim() } : s
        ),
        updatedAt: new Date().toISOString(),
      };
    });
    schedulePersist(nextProjects);
    set({ projects: nextProjects });
  },

  setSceneBackground: (blobKey) => {
    const pid = get().activeProjectId;
    const nextProjects = get().projects.map((proj) =>
      proj.id === pid
        ? patchActiveScene(proj, (sc) => ({ ...sc, backgroundBlobKey: blobKey }))
        : proj
    );
    schedulePersist(nextProjects);
    set({ projects: nextProjects });
  },

  setBackgroundParallax: (val) => {
    const pid = get().activeProjectId;
    const clamped = Math.max(0, Math.min(1, val));
    const nextProjects = get().projects.map((proj) =>
      proj.id === pid
        ? patchActiveScene(proj, (sc) => ({ ...sc, backgroundParallax: clamped }))
        : proj
    );
    schedulePersist(nextProjects);
    set({ projects: nextProjects });
  },

  upsertCameraKeyframe: (kf) => {
    const pid = get().activeProjectId;
    const nextProjects = get().projects.map((proj) =>
      proj.id === pid
        ? patchActiveScene(proj, (sc) => {
            const list = [...(sc.cameraKeyframes ?? [])];
            const idx = list.findIndex((k) => k.frame === kf.frame);
            if (idx >= 0) list[idx] = kf;
            else list.push(kf);
            list.sort((a, b) => a.frame - b.frame);
            return { ...sc, cameraKeyframes: list };
          })
        : proj
    );
    schedulePersist(nextProjects);
    set({ projects: nextProjects });
  },

  clearCameraKeyframes: () => {
    const pid = get().activeProjectId;
    const nextProjects = get().projects.map((proj) =>
      proj.id === pid
        ? patchActiveScene(proj, (sc) => ({ ...sc, cameraKeyframes: [] }))
        : proj
    );
    schedulePersist(nextProjects);
    set({ projects: nextProjects });
  },

  setFrameCameraShake: (frameIndex, strength) => {
    const pid = get().activeProjectId;
    const nextProjects = get().projects.map((proj) =>
      proj.id === pid
        ? patchActiveScene(proj, (sc) => ({
            ...sc,
            frames: sc.frames.map((f, i) =>
              i === frameIndex ? { ...f, cameraShake: Math.max(0, Math.min(3, strength)) } : f
            ),
          }))
        : proj
    );
    schedulePersist(nextProjects);
    set({ projects: nextProjects });
  },

  setSceneAtmosphere: (atmosphere) => {
    const pid = get().activeProjectId;
    const nextProjects = get().projects.map((proj) =>
      proj.id === pid
        ? patchActiveScene(proj, (sc) => ({ ...sc, atmosphere }))
        : proj
    );
    schedulePersist(nextProjects);
    set({ projects: nextProjects });
  },

  selectFrame: (index) => {
    const curState = get();
    const p = curState.projects.find((x) => x.id === curState.activeProjectId);
    if (!p || p.frames.length === 0) return;
    const clamped = Math.max(0, Math.min(p.frames.length - 1, index));
    if (clamped !== curState.activeFrameIndex) {
      void flushActiveCanvasNow();
    }
    const currentLayerId = curState.activeLayerId;
    const prevFrame = p.frames[curState.activeFrameIndex];
    const prevRole = prevFrame?.layers.find((l) => l.id === currentLayerId)?.role ?? 'ink';
    const nextFrame = p.frames[clamped];
    const matchedLayer =
      nextFrame.layers.find((l) => l.role === prevRole) ??
      nextFrame.layers.find((l) => l.role === 'ink') ??
      nextFrame.layers[0];
    set({
      activeFrameIndex: clamped,
      activeLayerId: matchedLayer?.id ?? null,
      autoSwitchedLayer: null,
    });
  },

  selectLayer: (layerId) => set({ activeLayerId: layerId, autoSwitchedLayer: null }),

  addFrameAfterCurrent: async (copyCurrent = false) => {
    // Wait for any in-flight stroke persistence BEFORE cloning or switching so the last stroke is NEVER lost!
    await flushActiveCanvasNow();
    const { projects, activeProjectId, activeFrameIndex, activeLayerId } = get();
    const p = projects.find((x) => x.id === activeProjectId);
    if (!p) return;

    const prevFrame = p.frames[activeFrameIndex];
    const prevRole = prevFrame?.layers.find((l) => l.id === activeLayerId)?.role ?? 'ink';

    let newFrame: CelFrame;
    if (copyCurrent && prevFrame) {
      const src = prevFrame;
      const clonedLayers: CelLayer[] = [];
      for (const l of src.layers) {
        let newBlobKey: string | null = null;
        if (l.blobKey) {
          const b = await loadBlob(l.blobKey);
          if (b) newBlobKey = await saveBlob(b);
        }
        clonedLayers.push({ ...l, id: makeId('lyr'), blobKey: newBlobKey });
      }
      let newThumbKey: string | null = null;
      if (src.thumbKey) {
        const tb = await loadBlob(src.thumbKey);
        if (tb) newThumbKey = await saveBlob(tb);
      }
      newFrame = {
        id: makeId('frm'),
        hold: src.hold,
        layers: clonedLayers,
        thumbKey: newThumbKey,
        note: src.note,
        cameraShake: 0,
      };
    } else {
      newFrame = createBlankFrame();
    }

    const insertAt = Math.min(p.frames.length, activeFrameIndex + 1);
    const nextProjects = get().projects.map((proj) =>
      proj.id === p.id
        ? patchActiveScene(proj, (sc) => {
            const frames = [...sc.frames];
            frames.splice(insertAt, 0, newFrame);
            return {
              ...sc,
              frames,
              cameraKeyframes: shiftCameraKeyframesOnInsert(sc.cameraKeyframes, insertAt),
            };
          })
        : proj
    );
    schedulePersist(nextProjects);
    const matched =
      newFrame.layers.find((l) => l.role === prevRole) ??
      newFrame.layers.find((l) => l.role === 'ink') ??
      newFrame.layers[0];
    set({
      projects: nextProjects,
      activeFrameIndex: insertAt,
      activeLayerId: matched.id,
      autoSwitchedLayer: null,
    });
  },

  addImportedPaperFrames: async (items) => {
    const pid = get().activeProjectId;
    let targetProject = get().projects.find((x) => x.id === pid);
    if (!targetProject) {
      targetProject = get().createProject('Kağıt Animasyonu', '16:9', 12);
    }

    const newFrames: CelFrame[] = [];
    for (const item of items) {
      const paperBlobKey = await saveBlob(item.blob);
      const thumbKey = await saveBlob(item.thumbBlob);
      const origKey = item.paperOriginalBlob ? await saveBlob(item.paperOriginalBlob) : null;
      newFrames.push({
        id: makeId('frm'),
        hold: 1,
        thumbKey,
        paperOriginalBlobKey: origKey,
        note: 'Kağıt taraması',
        cameraShake: 0,
        layers: [
          {
            id: makeId('lyr'),
            name: 'Boya',
            role: 'color',
            visible: true,
            locked: false,
            opacity: 1,
            blendMode: 'source-over',
            blobKey: null,
          },
          {
            id: makeId('lyr'),
            name: 'Kağıt Mürekkebi',
            role: 'ink',
            visible: true,
            locked: false,
            opacity: 1,
            blendMode: item.transparentBg ? 'source-over' : 'multiply',
            blobKey: paperBlobKey,
          },
        ],
      });
    }

    const isSingleBlank =
      targetProject.frames.length === 1 &&
      targetProject.frames[0].layers.every((l) => !l.blobKey);

    const mergedFrames = isSingleBlank
      ? newFrames
      : [...targetProject.frames, ...newFrames];
    const jumpIndex = isSingleBlank ? 0 : targetProject.frames.length;

    const nextProjects = get().projects.map((proj) =>
      proj.id === targetProject!.id
        ? patchActiveScene(proj, (sc) => ({ ...sc, frames: mergedFrames }))
        : proj
    );
    schedulePersist(nextProjects);

    const targetFrame = mergedFrames[jumpIndex];
    const colorLayer =
      targetFrame.layers.find((l) => l.role === 'color') ?? targetFrame.layers[0];
    set({
      projects: nextProjects,
      activeProjectId: targetProject.id,
      activeFrameIndex: jumpIndex,
      activeLayerId: colorLayer.id,
    });
  },

  deleteFrame: (index) => {
    void flushActiveCanvasNow();
    const pid = get().activeProjectId;
    const p = get().projects.find((x) => x.id === pid);
    if (!p || p.frames.length <= 1) return;

    const prevFrame = p.frames[get().activeFrameIndex];
    const prevRole = prevFrame?.layers.find((l) => l.id === get().activeLayerId)?.role ?? 'ink';

    const nextFrames = p.frames.filter((_, i) => i !== index);
    const nextIdx = Math.min(index, nextFrames.length - 1);
    const nextProjects = get().projects.map((proj) =>
      proj.id === pid
        ? patchActiveScene(proj, (sc) => ({
            ...sc,
            frames: nextFrames,
            cameraKeyframes: shiftCameraKeyframesOnDelete(sc.cameraKeyframes, index),
          }))
        : proj
    );
    schedulePersist(nextProjects);
    const matched =
      nextFrames[nextIdx].layers.find((l) => l.role === prevRole) ??
      nextFrames[nextIdx].layers.find((l) => l.role === 'ink') ??
      nextFrames[nextIdx].layers[0];
    set({
      projects: nextProjects,
      activeFrameIndex: nextIdx,
      activeLayerId: matched.id,
      autoSwitchedLayer: null,
    });
  },

  setFrameHold: (index, hold) => {
    const pid = get().activeProjectId;
    const clamped = Math.max(1, Math.min(24, Math.round(hold)));
    const nextProjects = get().projects.map((proj) =>
      proj.id === pid
        ? patchActiveScene(proj, (sc) => ({
            ...sc,
            frames: sc.frames.map((f, i) => (i === index ? { ...f, hold: clamped } : f)),
          }))
        : proj
    );
    schedulePersist(nextProjects);
    set({ projects: nextProjects });
  },

  updateFrameNote: (index, note) => {
    const pid = get().activeProjectId;
    const nextProjects = get().projects.map((proj) =>
      proj.id === pid
        ? patchActiveScene(proj, (sc) => ({
            ...sc,
            frames: sc.frames.map((f, i) => (i === index ? { ...f, note } : f)),
          }))
        : proj
    );
    schedulePersist(nextProjects);
    set({ projects: nextProjects });
  },

  moveFrame: (fromIndex, toIndex) => {
    void flushActiveCanvasNow();
    const pid = get().activeProjectId;
    const p = get().projects.find((x) => x.id === pid);
    if (!p || fromIndex === toIndex) return;
    if (toIndex < 0 || toIndex >= p.frames.length) return;

    const nextFrames = [...p.frames];
    const [moved] = nextFrames.splice(fromIndex, 1);
    nextFrames.splice(toIndex, 0, moved);

    const nextProjects = get().projects.map((proj) =>
      proj.id === pid
        ? patchActiveScene(proj, (sc) => ({
            ...sc,
            frames: nextFrames,
            cameraKeyframes: shiftCameraKeyframesOnMove(sc.cameraKeyframes, fromIndex, toIndex),
          }))
        : proj
    );
    schedulePersist(nextProjects);
    set({ projects: nextProjects, activeFrameIndex: toIndex });
  },

  updateLayerBlobAndThumb: (frameId, layerId, layerBlobKey, thumbKey) => {
    const pid = get().activeProjectId;
    const nextProjects = get().projects.map((proj) =>
      proj.id === pid
        ? patchActiveScene(proj, (sc) => ({
            ...sc,
            frames: sc.frames.map((f) =>
              f.id !== frameId
                ? f
                : {
                    ...f,
                    thumbKey,
                    layers: f.layers.map((l) =>
                      l.id === layerId ? { ...l, blobKey: layerBlobKey } : l
                    ),
                  }
            ),
          }))
        : proj
    );
    schedulePersist(nextProjects);
    set({ projects: nextProjects });
  },

  addLayerToCurrentFrame: (name, role) => {
    const pid = get().activeProjectId;
    const fIdx = get().activeFrameIndex;
    const newLayer: CelLayer = {
      id: makeId('lyr'),
      name,
      role,
      visible: true,
      locked: false,
      opacity: role === 'rough' ? 0.75 : 1,
      blendMode: role === 'ink' ? 'multiply' : 'source-over',
      blobKey: null,
    };
    const nextProjects = get().projects.map((proj) =>
      proj.id === pid
        ? patchActiveScene(proj, (sc) => ({
            ...sc,
            frames: sc.frames.map((f, i) =>
              i === fIdx ? { ...f, layers: [...f.layers, newLayer] } : f
            ),
          }))
        : proj
    );
    schedulePersist(nextProjects);
    set({ projects: nextProjects, activeLayerId: newLayer.id, autoSwitchedLayer: null });
  },

  updateLayerInCurrentFrame: (layerId, patch) => {
    const pid = get().activeProjectId;
    const fIdx = get().activeFrameIndex;
    const nextProjects = get().projects.map((proj) =>
      proj.id === pid
        ? patchActiveScene(proj, (sc) => ({
            ...sc,
            frames: sc.frames.map((f, i) =>
              i !== fIdx
                ? f
                : {
                    ...f,
                    layers: f.layers.map((l) => (l.id === layerId ? { ...l, ...patch } : l)),
                  }
            ),
          }))
        : proj
    );
    schedulePersist(nextProjects);
    set({ projects: nextProjects });
  },

  moveLayerInCurrentFrame: (layerId, direction) => {
    const pid = get().activeProjectId;
    const fIdx = get().activeFrameIndex;
    const nextProjects = get().projects.map((proj) =>
      proj.id === pid
        ? patchActiveScene(proj, (sc) => ({
            ...sc,
            frames: sc.frames.map((f, i) => {
              if (i !== fIdx) return f;
              const idx = f.layers.findIndex((l) => l.id === layerId);
              if (idx < 0) return f;
              // Visual stack displays layers top-to-bottom (reversed), so moving visually 'up' increments index!
              const targetIdx = direction === 'up' ? idx + 1 : idx - 1;
              if (targetIdx < 0 || targetIdx >= f.layers.length) return f;
              const nextLayers = [...f.layers];
              const [moved] = nextLayers.splice(idx, 1);
              nextLayers.splice(targetIdx, 0, moved);
              return { ...f, layers: nextLayers };
            }),
          }))
        : proj
    );
    schedulePersist(nextProjects);
    set({ projects: nextProjects });
  },

  deleteLayerInCurrentFrame: (layerId) => {
    const pid = get().activeProjectId;
    const fIdx = get().activeFrameIndex;
    let nextActive: string | null = get().activeLayerId;

    const nextProjects = get().projects.map((proj) =>
      proj.id === pid
        ? patchActiveScene(proj, (sc) => ({
            ...sc,
            frames: sc.frames.map((f, i) => {
              if (i !== fIdx || f.layers.length <= 1) return f;
              const remaining = f.layers.filter((l) => l.id !== layerId);
              if (nextActive === layerId) nextActive = remaining[remaining.length - 1].id;
              return { ...f, layers: remaining };
            }),
          }))
        : proj
    );
    schedulePersist(nextProjects);
    set({ projects: nextProjects, activeLayerId: nextActive, autoSwitchedLayer: null });
  },

  upsertRig: (rig) => {
    const pid = get().activeProjectId;
    const nextProjects = get().projects.map((proj) => {
      if (proj.id !== pid) return proj;
      const exists = proj.rigs.some((r) => r.id === rig.id);
      const rigs = exists ? proj.rigs.map((r) => (r.id === rig.id ? rig : r)) : [...proj.rigs, rig];
      return { ...proj, rigs, updatedAt: new Date().toISOString() };
    });
    schedulePersist(nextProjects);
    set({ projects: nextProjects });
  },

  deleteRig: (rigId) => {
    const pid = get().activeProjectId;
    const nextProjects = get().projects.map((proj) =>
      proj.id === pid
        ? {
            ...proj,
            rigs: proj.rigs.filter((r) => r.id !== rigId),
            updatedAt: new Date().toISOString(),
          }
        : proj
    );
    schedulePersist(nextProjects);
    set({ projects: nextProjects });
  },

  upsertMeshRig: (rig) => {
    const pid = get().activeProjectId;
    const nextProjects = get().projects.map((proj) => {
      if (proj.id !== pid) return proj;
      const list = proj.meshRigs ?? [];
      const exists = list.some((r) => r.id === rig.id);
      const meshRigs = exists ? list.map((r) => (r.id === rig.id ? rig : r)) : [rig, ...list];
      return { ...proj, meshRigs, updatedAt: new Date().toISOString() };
    });
    schedulePersist(nextProjects);
    set({ projects: nextProjects });
  },

  deleteMeshRig: (rigId) => {
    const pid = get().activeProjectId;
    const nextProjects = get().projects.map((proj) =>
      proj.id === pid
        ? {
            ...proj,
            meshRigs: (proj.meshRigs ?? []).filter((r) => r.id !== rigId),
            updatedAt: new Date().toISOString(),
          }
        : proj
    );
    schedulePersist(nextProjects);
    set({ projects: nextProjects });
  },

  bakeCanvasesToFrames: async (canvases, replace) => {
    const pid = get().activeProjectId;
    const p = get().projects.find((x) => x.id === pid);
    if (!p || canvases.length === 0) return;

    const newFrames: CelFrame[] = [];
    for (let i = 0; i < canvases.length; i++) {
      const c = canvases[i];
      const pngBlob = await new Promise<Blob>((resolve, reject) =>
        c.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG hatası'))), 'image/png')
      );
      const inkKey = await saveBlob(pngBlob);

      const tw = 512;
      const th = Math.max(180, Math.round((p.height / p.width) * tw));
      const tc = document.createElement('canvas');
      tc.width = tw;
      tc.height = th;
      const tctx = tc.getContext('2d')!;
      tctx.fillStyle = p.paperColor;
      tctx.fillRect(0, 0, tw, th);
      tctx.drawImage(c, 0, 0, tw, th);
      const thumbKey = await saveBlob(await canvasToWebpOrJpegBlob(tc, 0.86));

      newFrames.push({
        id: makeId('frm'),
        hold: 1,
        thumbKey,
        note: `Canlı Kukla #${i + 1}`,
        cameraShake: 0,
        layers: [
          {
            id: makeId('lyr'),
            name: 'Kukla Katmanı',
            role: 'paper',
            visible: true,
            locked: false,
            opacity: 1,
            blendMode: 'source-over',
            blobKey: inkKey,
          },
          {
            id: makeId('lyr'),
            name: 'Üst Çizim (Efekt)',
            role: 'ink',
            visible: true,
            locked: false,
            opacity: 1,
            blendMode: 'source-over',
            blobKey: null,
          },
        ],
      });
    }

    const nextFrames = replace ? newFrames : [...p.frames, ...newFrames];
    const jumpIndex = replace ? 0 : p.frames.length;

    const nextProjects = get().projects.map((proj) =>
      proj.id === pid
        ? patchActiveScene(proj, (sc) => ({ ...sc, frames: nextFrames }))
        : proj
    );
    schedulePersist(nextProjects);
    const ink =
      nextFrames[jumpIndex].layers.find((l) => l.role === 'ink') ??
      nextFrames[jumpIndex].layers[0];
    set({
      projects: nextProjects,
      activeFrameIndex: jumpIndex,
      activeLayerId: ink.id,
      mode: 'draw',
    });
  },

  bakeRenderedShotToFrames: async (count, renderFrame, options) => {
    const pid = get().activeProjectId;
    const p = get().projects.find((x) => x.id === pid);
    if (!p || count <= 0) return 0;

    const locale = get().locale;
    const replace = options?.replace ?? false;
    const notePrefix = options?.notePrefix ?? (locale === 'en' ? 'Film Shot' : 'Film Planı');
    const layerName = options?.layerName ?? (locale === 'en' ? 'Film Scene' : 'Film Sahnesi');
    const topLayerName =
      options?.topLayerName ?? (locale === 'en' ? 'Top Ink (Effects)' : 'Üst Çizim (Efekt)');

    // Reuse 1 single main canvas + 1 thumbnail canvas (zero 132 MB RAM spike!)
    const workCanvas = document.createElement('canvas');
    workCanvas.width = p.width;
    workCanvas.height = p.height;
    const wctx = workCanvas.getContext('2d')!;

    const tw = 384;
    const th = Math.max(144, Math.round((p.height / p.width) * tw));
    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = tw;
    thumbCanvas.height = th;
    const tctx = thumbCanvas.getContext('2d')!;

    const newFrames: CelFrame[] = [];
    for (let i = 0; i < count; i++) {
      wctx.clearRect(0, 0, p.width, p.height);
      renderFrame(wctx, i, p.width, p.height);

      // High-quality WebP (10x faster than lossless 1280x720 PNG for opaque film scenes!)
      const frameBlob = await canvasToWebpOrJpegBlob(workCanvas, 0.92);
      const frameKey = await saveBlob(frameBlob);

      tctx.fillStyle = p.paperColor;
      tctx.fillRect(0, 0, tw, th);
      tctx.drawImage(workCanvas, 0, 0, tw, th);
      const thumbKey = await saveBlob(await canvasToWebpOrJpegBlob(thumbCanvas, 0.82));

      newFrames.push({
        id: makeId('frm'),
        hold: 1,
        thumbKey,
        note: `${notePrefix} · #${i + 1}`,
        cameraShake: 0,
        layers: [
          {
            id: makeId('lyr'),
            name: layerName,
            role: 'paper',
            visible: true,
            locked: false,
            opacity: 1,
            blendMode: 'source-over',
            blobKey: frameKey,
          },
          {
            id: makeId('lyr'),
            name: topLayerName,
            role: 'ink',
            visible: true,
            locked: false,
            opacity: 1,
            blendMode: 'source-over',
            blobKey: null,
          },
        ],
      });

      options?.onProgress?.(i + 1, count);
      // Yield to browser UI thread every frame so progress stays smooth & never stalls!
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    const latestP = get().projects.find((x) => x.id === pid);
    if (!latestP) return 0;
    const nextFrames = replace ? newFrames : [...latestP.frames, ...newFrames];
    const jumpIndex = replace ? 0 : latestP.frames.length;

    const nextProjects = get().projects.map((proj) =>
      proj.id === pid
        ? patchActiveScene(proj, (sc) => ({ ...sc, frames: nextFrames }))
        : proj
    );
    schedulePersist(nextProjects);
    const ink =
      nextFrames[jumpIndex].layers.find((l) => l.role === 'ink') ??
      nextFrames[jumpIndex].layers[0];
    set({
      projects: nextProjects,
      activeFrameIndex: jumpIndex,
      activeLayerId: ink.id,
      filmExportOpen: false,
      mode: 'draw',
    });
    return newFrames.length;
  },

  setAudioTrack: (audio) => {
    const pid = get().activeProjectId;
    const nextProjects = get().projects.map((proj) =>
      proj.id === pid
        ? { ...proj, audio, updatedAt: new Date().toISOString() }
        : proj
    );
    schedulePersist(nextProjects);
    set({ projects: nextProjects });
  },

  updateAudioTrack: (patch) => {
    const pid = get().activeProjectId;
    const nextProjects = get().projects.map((proj) =>
      proj.id === pid && proj.audio
        ? { ...proj, audio: { ...proj.audio, ...patch }, updatedAt: new Date().toISOString() }
        : proj
    );
    schedulePersist(nextProjects);
    set({ projects: nextProjects });
  },

  addReference: (item) => {
    const pid = get().activeProjectId;
    const nextProjects = get().projects.map((proj) =>
      proj.id === pid
        ? {
            ...proj,
            references: [...proj.references, item],
            updatedAt: new Date().toISOString(),
          }
        : proj
    );
    schedulePersist(nextProjects);
    set({ projects: nextProjects });
  },

  deleteReference: (id) => {
    const pid = get().activeProjectId;
    const nextProjects = get().projects.map((proj) =>
      proj.id === pid
        ? {
            ...proj,
            references: proj.references.filter((r) => r.id !== id),
            updatedAt: new Date().toISOString(),
          }
        : proj
    );
    schedulePersist(nextProjects);
    set({ projects: nextProjects });
  },
}));
