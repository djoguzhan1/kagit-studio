import type { UniversalCreatureClass } from '../engine/conformingMeshEngine';
import type { UniversalActionId } from '../engine/universalCreatureRig';
import type { CharacterMasterRig } from './masterRig';

/**
 * KÂĞIT 2.5D Film Director — Deterministic FilmGraph IR & .kagit25d Protocol Types.
 * Works 100% locally in-browser today and directly accepts Cloud GPU .kagit25d packages tomorrow.
 */

export type FilmStyleTag = 'ink-watercolor' | 'anime-cel' | 'storybook' | 'sketch';

export interface StyleDNA {
  palette: string[];
  inkColor: string;
  accentColor: string;
  /** Optional sampled warm paper/face interior fill color for clean mouth underlay masking */
  paperBaseColor?: string;
  /** -1 (cool moonlight/rain) .. 0 (neutral) .. +1 (warm sunset/parchment) */
  warmTemp: number;
  contrast: number; // 0..1
  lineWeightPx: number; // estimated stroke thickness in px
  styleTag: FilmStyleTag;
}

export type WorldSetId =
  | 'rainy-alley'
  | 'golden-hill'
  | 'moonlit-forest'
  | 'cosmic-nebula'
  | 'concert-stage'
  | 'canyon-chase'
  | 'custom';

export type FilmAspectRatio = '16:9' | '9:16' | '1:1';
export type FilmAudioMixMode = 'full' | 'voice-only' | 'muted';
export type FilmGestureMode = 'none' | 'wave' | 'handsUp' | 'surprise';

export type WeatherKind = 'none' | 'rain' | 'wind-leaves' | 'fireflies' | 'snow';
export type CinemaLookId =
  | 'natural'
  | 'watercolor'
  | 'cinema-35mm'
  | 'vibrant-anime'
  | 'vintage-ink';

export type ShotFraming = 'wide' | 'medium' | 'closeup' | 'low-angle';
export type ShotTimingMode = 'on2s-12fps' | 'hybrid-12-24' | 'smooth-24fps';

export type FilmActionId =
  | 'walk-tired'
  | 'walk-hero'
  | 'run'
  | 'jump-joy'
  | 'wave'
  | 'kneel-pickup'
  | 'surprise'
  | 'talk-hero'
  | 'idle-breathe';

export type FilmEmotionId =
  | 'neutral'
  | 'tired'
  | 'surprised'
  | 'happy'
  | 'determined'
  | 'angry';

export type FilmPropId = 'none' | 'glowing-letter' | 'lantern' | 'umbrella';

export interface FilmCameraTrack {
  fromX: number; // normalized pan -0.45..0.45
  fromY: number;
  fromZoom: number; // 0.85..3.0
  toX: number;
  toY: number;
  toZoom: number;
  tiltDeg: number; // -12..12
  dofStrength: number; // 0..1 depth-of-field bokeh on far/mid background planes
  handheld: number; // 0..1 subtle cinema camera breath
}

export type VisemeId = 'closed' | 'AA' | 'EE' | 'OH' | 'OO' | 'FV';

export interface VoiceLipSyncFrame {
  /** Seconds relative to shot start */
  t: number;
  /** Normalized vocal energy 0..1 */
  energy: number;
  /** Classified Preston Blair mouth viseme shape */
  viseme: VisemeId;
}

export interface VoiceLipSyncTrack {
  /** IndexedDB binary audio blob key (webm/wav/mp3/ogg) */
  audioBlobKey: string;
  durationSec: number;
  sampleRateHz: number;
  frames: VoiceLipSyncFrame[];
  /** Compact 48-bar normalized amplitude waveform for timeline preview */
  waveform: number[];
  source: 'mic' | 'file';
  label: string;
}

export interface MotionCaptureSample {
  /** Seconds relative to shot start */
  t: number;
  /** 2.5D head yaw in radians (-0.61..+0.61) */
  headYawRad: number;
  /** Rigid head tilt in radians (-0.38..+0.38) */
  headTiltRad: number;
  /** Torso lean in radians (-0.32..+0.32) */
  bodyLeanRad: number;
  /** Left arm raise/swing (-0.8..+1.15) */
  leftArmSwing: number;
  /** Right arm raise/swing (-0.8..+1.15) */
  rightArmSwing: number;
  /** Vertical jump lift in normalized actor heights (0..0.34) */
  verticalLiftNorm: number;
  /** Volume-preserving squash/stretch Y factor (0.82..1.18) */
  squashY: number;
  /** Optional synchronized mouth energy (0..1) */
  mouthOpen?: number;
  /** Optional synchronized mouth viseme */
  viseme?: VisemeId;
  /** Optional upper-body gesture hint for IK mode selection */
  gestureMode?: FilmGestureMode;
}

export interface MotionCaptureTrack {
  source: 'webcam' | 'video' | 'live-pad';
  durationSec: number;
  fps: number;
  samples: MotionCaptureSample[];
  createdAt: string;
  label: string;
}

export interface LivePerformanceOverride {
  headYawRad?: number;
  headTiltRad?: number;
  bodyLeanRad?: number;
  leftArmSwing?: number;
  rightArmSwing?: number;
  verticalLiftNorm?: number;
  squashY?: number;
  mouthOpen?: number;
  viseme?: VisemeId;
  gestureMode?: FilmGestureMode;
}

export interface ShotActorTrack {
  actorId: string;
  action: FilmActionId;
  /** Optional V4 7-creature expanded acting/motion action */
  universalAction?: UniversalActionId;
  emotion: FilmEmotionId;
  /** Ground-plane waypoints normalized 0..1 */
  motionPath: { x: number; y: number }[];
  /** Optional 360° 2.5D character facing angle in degrees (-180..+180) */
  viewYawDeg?: number;
  /** Optional gaze target pointing dynamically at another cast member's live head! */
  lookAtActorId?: string | null;
  prop?: FilmPropId;
  dialogue?: string;
}

export interface FilmShot {
  id: string;
  title: string;
  durationSec: number; // 1.2..10
  framing: ShotFraming;
  timingMode: ShotTimingMode;
  action: FilmActionId;
  /** Optional V4 expanded creature-aware action */
  universalAction?: UniversalActionId;
  emotion: FilmEmotionId;
  prop: FilmPropId;
  /** 2.5D head yaw target in degrees (-35..+35) */
  headAngleX: number;
  /** Optional 360° 2.5D body facing angle in degrees (-180..+180) */
  viewYawDeg?: number;
  /** Ground-plane motion waypoints normalized 0..1 (x: horizontal, y: ground depth 0.58..0.92) */
  motionPath: { x: number; y: number }[];
  /** Interactive on-canvas Look-At magnet normalized 0..1 */
  lookAt: { x: number; y: number } | null;
  /** Optional spoken dialogue line driving viseme lip-sync + cinema subtitle */
  dialogue: string;
  /** Optional Phase-4 recorded/uploaded voice audio + real formant viseme track */
  voiceTrack?: VoiceLipSyncTrack | null;
  /** Optional Phase-4 webcam / reference video / live-pad 2.5D motion capture curve */
  mocapTrack?: MotionCaptureTrack | null;
  /** Optional V4 multi-actor (1..6 cast) per-actor choreography & gaze tracks */
  actorTracks?: Record<string, ShotActorTrack>;
  /** Optional dramatic lightning flash timestamp inside this shot (seconds) */
  lightningAtSec: number | null;
  camera: FilmCameraTrack;
  transition: 'cut' | 'dissolve';
}

export type DecomposedPartRole =
  | 'leg_l'
  | 'leg_r'
  | 'arm_l'
  | 'torso'
  | 'arm_r'
  | 'head'
  | 'scarf';

export interface DecomposedPart25D {
  id: string;
  role: DecomposedPartRole;
  label: string;
  /** IndexedDB binary PNG blobKey (amodal overlap-completed cutout!) */
  blobKey: string;
  /** Bounding box in source actor pixels */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Anatomical joint pivot in part-local pixels */
  pivotX: number;
  pivotY: number;
  zIndex: number;
  /** 1.0 = completely rigid (skull/face), 0.2..0.7 = flexible cloth/limb */
  rigidity: number;
}

export interface DecomposedCharacterRig25D {
  parts: DecomposedPart25D[];
  depthBlobKey: string | null;
  normalBlobKey: string | null;
  sourceEngine: 'local-cv' | 'cloud-gpu';
  createdAt: string;
}

export interface BackgroundPlane25D {
  zLayer: 'z0' | 'z1' | 'z2' | 'z3' | 'z5';
  label: string;
  parallax: number;
  blobKey: string;
}

export interface DecomposedBackgroundSet25D {
  planes: BackgroundPlane25D[];
  depthBlobKey: string | null;
  horizonY: number;
  lightAngleDeg: number;
  sourceEngine: 'local-cv' | 'cloud-gpu';
  createdAt: string;
}

export interface FilmActor {
  id: string;
  name: string;
  /** IndexedDB PNG blob key (null = built-in editorial studio hero) */
  sourceBlobKey: string | null;
  sourceW: number;
  sourceH: number;
  styleDna: StyleDNA;
  /** Head/face rigid zone cutoff normalized 0..1 (protects skull/face from rubber distortion!) */
  rigidHeadEndY: number;
  /** Enable Verlet physical cloth/scarf follow-through ribbon */
  secondaryPhysics: boolean;
  /** Optional user-tuned character scale multiplier (0.7..1.4, default 1.0) */
  scale?: number;
  /** Optional Phase-3 decomposed multi-part amodal rig + depth/normal maps */
  decomposed?: DecomposedCharacterRig25D | null;
  /** Optional V4 universal 7-class creature type */
  creatureClass?: UniversalCreatureClass;
  /** Optional V4 360° 2.5D multi-angle master rig (Front / Side / Back / 3-4) */
  masterRig?: CharacterMasterRig | null;
}

export interface FilmWorldConfig {
  setId: WorldSetId;
  /** Optional user-uploaded background image blobKey auto-sliced into 2.5D parallax planes */
  customBgBlobKey: string | null;
  /** Optional Phase-3 decomposed 5/6-plane parallax background set (Z0..Z5) */
  decomposedBg?: DecomposedBackgroundSet25D | null;
  horizonY: number; // 0.35..0.72
  weather: WeatherKind;
  weatherIntensity: number; // 0..1
  windStrength: number; // -1..1
  /** Klaus-style 2.5D normal-mapped cel relighting & rim light */
  klausLighting: boolean;
  /** 35mm cinema letterbox + warm halation + paper/film grain */
  cinemaGrade: boolean;
  /** Live $0 in-browser Cinema Look applied in both stage preview and exports */
  cinemaLook?: CinemaLookId;
  /** Toggle 2.39:1 cinema letterbox bars */
  letterbox?: boolean;
  /** Subtle analog film/paper grain & vignette intensity (0..1) */
  grainStrength?: number;
  /** Key light direction angle in degrees (-180..180) */
  lightAngleDeg: number;
  /** Automatically harmonize world colors to match actor's Style-DNA */
  harmonizeToStyleDna: boolean;
}

export interface FilmProjectGraph {
  version: '2.5d-v1';
  prompt: string;
  actor: FilmActor;
  /** Optional V4 multi-actor cast (1..6 actors, actors[0] stays synced with actor for 100% legacy compatibility!) */
  actors?: FilmActor[];
  world: FilmWorldConfig;
  shots: FilmShot[];
  foleyEnabled: boolean;
  musicBedEnabled: boolean;
}
