import type { FilmEmotionId, FilmProjectGraph, VisemeId } from './film';

export type StudioTheme = 'night' | 'day';

export type StudioLocale = 'tr' | 'en';

export type StudioMode = 'desk' | 'draw' | 'paper' | 'puppet' | 'film';

export type AspectPreset = '16:9' | '9:16' | '1:1' | '4:3';

export const ASPECT_DIMENSIONS: Record<AspectPreset, { w: number; h: number; label: string }> = {
  '16:9': { w: 1280, h: 720, label: '16:9 Sinema' },
  '9:16': { w: 720, h: 1280, label: '9:16 Reels / Shorts' },
  '1:1': { w: 960, h: 960, label: '1:1 Kare' },
  '4:3': { w: 1024, h: 768, label: '4:3 Klasik TV' },
};

export type BrushToolId =
  | 'gpen'
  | 'pencil'
  | 'blue-rough'
  | 'marker'
  | 'dry-brush'
  | 'screentone'
  | 'shape'
  | 'bucket'
  | 'lasso'
  | 'eyedropper'
  | 'eraser';

export type ShapeKind = 'line' | 'ellipse' | 'rect';

export type PaperStyleId = 'bristol' | 'grid' | 'lined' | 'kraft' | 'acme12';

export type UnderlayGuideId = 'none' | 'bounce' | 'walk' | 'head-turn' | 'wave' | 'persp1' | 'persp2';

export type SceneAtmosphereId = 'none' | 'sunset' | 'night-lamp' | 'vintage-1970';

export type LayerRole = 'ink' | 'color' | 'rough' | 'paper';

export type LayerBlendMode = 'source-over' | 'multiply';

export interface CelLayer {
  id: string;
  name: string;
  role: LayerRole;
  visible: boolean;
  locked: boolean;
  opacity: number; // 0..1
  blendMode: LayerBlendMode;
  /** IndexedDB binary PNG Blob key (never Base64 in JSON!) */
  blobKey: string | null;
}

export interface CelFrame {
  id: string;
  /** Exposure hold count in frames (1 = on 1s, 2 = on 2s, 3 = on 3s, etc.) */
  hold: number;
  layers: CelLayer[];
  /** Cached 512px WebP thumbnail blobKey for crisp X-Sheet & Desk preview */
  thumbKey?: string | null;
  /** Optional warped original paper photo blobKey for Before/After transformation clip */
  paperOriginalBlobKey?: string | null;
  note?: string;
  /** Optional 1-click Impact Camera Shake impulse on this frame (0 = none, 1..3 = strength) */
  cameraShake?: number;
}

export interface CameraKeyframe {
  frame: number;
  zoom: number; // 0.8..2.4
  panX: number; // normalized -0.5..0.5 of width
  panY: number; // normalized -0.5..0.5 of height
  tiltDeg: number; // -15..15
}

export interface StudioScene {
  id: string;
  name: string;
  frames: CelFrame[];
  /** Fixed background plane rendered underneath all frames of this scene */
  backgroundBlobKey?: string | null;
  backgroundParallax?: number; // 0..1
  cameraKeyframes?: CameraKeyframe[];
  atmosphere?: SceneAtmosphereId;
}

export type EasingType = 'linear' | 'easeInOut' | 'elastic' | 'bounce' | 'step';

export interface PuppetPart {
  id: string;
  name: string;
  /** Parent part id for true Forward Kinematics hierarchy (null = root) */
  parentId: string | null;
  /** IndexedDB binary PNG Blob key (transparent cutout) */
  blobKey: string;
  /** Position of part top-left in source rig coordinates */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Pivot point relative to part top-left (in part pixels) */
  pivotX: number;
  pivotY: number;
  zIndex: number;
  /** Optional mouth viseme slot for real Audio RMS lip-sync */
  mouthSlot?: 'closed' | 'half' | 'wide' | 'round' | null;
}

export interface PartTransform {
  dx: number;
  dy: number;
  rotation: number; // degrees
  scaleX: number;
  scaleY: number;
}

export interface PuppetKeyframe {
  id: string;
  /** Frame index along the puppet timeline (0..totalFrames-1) */
  frame: number;
  easing: EasingType;
  transforms: Record<string, PartTransform>;
}

export interface PuppetRig {
  id: string;
  name: string;
  sourceBlobKey: string;
  sourceW: number;
  sourceH: number;
  parts: PuppetPart[];
  keyframes: PuppetKeyframe[];
  totalFrames: number;
}

/** Single-Drawing 2D Mesh/Cage Warp Pin (Animate any drawing in 10 seconds without cutting!) */
export interface MeshPin {
  id: string;
  label: string;
  role: 'root' | 'head' | 'hand-l' | 'hand-r' | 'foot-l' | 'foot-r' | 'tail' | 'custom';
  /** Rest position normalized 0..1 of source image */
  x: number;
  y: number;
}

export interface MeshFrameOffsets {
  /** Per-pin displacement in normalized source coordinates */
  [pinId: string]: { dx: number; dy: number };
}

export interface MeshWarpRig {
  id: string;
  name: string;
  sourceBlobKey: string;
  sourceW: number;
  sourceH: number;
  pins: MeshPin[];
  /** Per-frame pin displacements (length = totalFrames) */
  frames: MeshFrameOffsets[];
  totalFrames: number;
  /** Optional hand-drawn 3-frame boiling line wobble intensity 0..1 */
  lineBoil: number;
  /** Optional cartoon auto lip-sync mouth placement (normalized 0..1) */
  mouthPos?: { x: number; y: number; scale: number } | null;
  /** Optional auto eye blink placement */
  autoBlink?: boolean;
  /** Optional expressive cartoon facial acting emotion */
  emotion?: FilmEmotionId;
}

export interface AudioTrackData {
  id: string;
  name: string;
  blobKey: string;
  mimeType: string;
  durationSec: number;
  /** Normalized 0..1 waveform peaks for fast timeline drawing */
  peaks: number[];
  /** Frame-level RMS loudness 0..1 at project FPS for genuine lip-sync */
  rmsPerFrame: number[];
  /** Frame-level Preston Blair 6-Viseme formant classification (AA / EE / OH / OO / FV / closed) */
  visemesPerFrame?: VisemeId[];
  /** Optional real-time Web Audio cartoon voice filter applied on playback & video export */
  voiceEffect?: 'natural' | 'chipmunk' | 'giant' | 'robot';
  volume: number;
  muted: boolean;
}

export interface ReferenceItem {
  id: string;
  name: string;
  blobKey: string;
  swatches: string[];
}

export interface StudioProject {
  id: string;
  name: string;
  aspect: AspectPreset;
  width: number;
  height: number;
  fps: 8 | 12 | 15 | 24;
  /** Paper background color (warm ivory default) */
  paperColor: string;
  /** Paper surface style (Bristol, Grid, Lined, Kraft, ACME 12-Field) */
  paperStyle?: PaperStyleId;
  /** Paper tooth grain intensity 0..1 */
  paperGrain: number;
  /** Active scene's frames (always kept in sync with scenes[activeSceneIndex].frames) */
  frames: CelFrame[];
  /** Multi-scene storyboard array (auto-migrated cleanly for legacy single-scene projects) */
  scenes?: StudioScene[];
  activeSceneId?: string;
  /** Fixed background plane shortcut for active scene */
  backgroundBlobKey?: string | null;
  backgroundParallax?: number;
  cameraKeyframes?: CameraKeyframe[];
  atmosphere?: SceneAtmosphereId;
  rigs: PuppetRig[];
  meshRigs?: MeshWarpRig[];
  filmGraph?: FilmProjectGraph | null;
  audio: AudioTrackData | null;
  references: ReferenceItem[];
  palette: string[];
  recentColors?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface OnionSkinConfig {
  enabled: boolean;
  prevCount: 1 | 2 | 3;
  nextCount: 1 | 2 | 3;
  opacity: number; // 0.1..0.75
  colored: boolean; // true = red prev / blue next
}

export interface BrushSettings {
  tool: BrushToolId;
  shapeKind: ShapeKind;
  color: string;
  size: number;
  opacity: number;
  stabilizer: number; // 0..0.85 lazy-rope smoothing
  pressureEnabled: boolean;
  palmRejection: boolean;
  /** Horizontal mirror symmetry drawing */
  symmetryX: boolean;
  /** Bucket fill references upper Ink layer & closes small gaps */
  bucketReferenceInk: boolean;
  bucketGapClose: number; // 0..4 px
}

export interface FieldGuideConfig {
  enabled: boolean;
  thirds: boolean;
  safeFrame: boolean;
  centerCross: boolean;
  underlay: UnderlayGuideId;
  underlayOpacity: number; // 0.15..0.6
  vp1: { x: number; y: number }; // normalized 0..1
  vp2: { x: number; y: number }; // normalized 0..1
}
