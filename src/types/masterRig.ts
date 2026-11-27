import type { CustomSlitLine, UniversalCreatureClass } from '../engine/conformingMeshEngine';

/**
 * INKTROPE V4 — Multi-View 360° 2.5D Character Master Rig Types.
 * Preserves 100% of the artist's original hand-drawn pixels across Front, 3/4, Side, and Back views,
 * calibrated to 0.0 px height alignment via 5 anatomical horizontal anchor lines.
 */

export type CharacterViewAngle = 'front' | 'threeQuarter' | 'side' | 'back';

export type ViewSourceKind =
  | 'original_drawing'
  | 'traced_drawing'
  | 'multi_pose_sheet'
  | 'ai_style_locked';

export interface ViewAnchors {
  /** 0..1 top of head / crown pixel */
  headTopV: number;
  /** 0..1 eye / upper-face calibration line */
  eyeLineV: number;
  /** 0..1 shoulder / upper-back calibration line */
  shoulderV: number;
  /** 0..1 waist / pelvis calibration line */
  hipV: number;
  /** 0..1 bottom sole / ground contact line */
  soleV: number;
  /** 0..1 horizontal center of mass */
  centerU: number;
  /** Normalized body span (soleV - headTopV) */
  heightFrac: number;
}

export interface RigViewSlot {
  angle: CharacterViewAngle;
  /** Transparent-background PNG data URL aligned to the Front view's 5-line anchors */
  dataUrl: string;
  source: ViewSourceKind;
  anchors: ViewAnchors;
  width: number;
  height: number;
  createdAt: number;
}

export type CustomMouthKey = 'closed' | 'A' | 'E' | 'O' | 'U' | 'smile';
export type CustomEyeKey = 'neutral' | 'happy' | 'surprised' | 'angry';

export interface CustomFaceSprites {
  /** Default true = zero-effort Style-DNA automatic ink mouth & eyes */
  autoInkStyle: boolean;
  mouths?: Partial<Record<CustomMouthKey, string>>;
  eyes?: Partial<Record<CustomEyeKey, string>>;
}

export interface WeightStroke {
  /** Anatomical region id (0:head, 1:torso, 2:arm_l, 3:arm_r, 4:leg_l, 5:leg_r) */
  region: number;
  /** Normalized 0..1 UV stroke center */
  x: number;
  y: number;
  /** Normalized 0..1 brush radius */
  radius: number;
  /** Brush blend strength 0..1 */
  strength: number;
}

export interface CharacterMasterRig {
  id: string;
  name: string;
  creatureClass: UniversalCreatureClass;
  /** Multi-angle 2.5D view bank (front is always canonical 0° anchor) */
  views: Partial<Record<CharacterViewAngle, RigViewSlot>>;
  /** Optional 5-second manual scissor slit lines to separate touching limbs */
  customSlitLines?: CustomSlitLine[];
  /** Optional 5-second dragged joint pin overrides in normalized UV (0..1) */
  jointOverrides?: Record<string, { x: number; y: number }>;
  /** Optional interactive weight/region paint strokes preserving Σw = 1 */
  weightStrokes?: Array<{ region: number; x: number; y: number; radius: number; strength: number }>;
  /** Optional artist-drawn mouth/eye sprite replacements */
  faceSprites?: CustomFaceSprites;
  updatedAt: number;
}

export const VIEW_ANGLE_ORDER: CharacterViewAngle[] = ['front', 'side', 'back', 'threeQuarter'];

export function defaultViewAnchors(): ViewAnchors {
  return {
    headTopV: 0.08,
    eyeLineV: 0.19,
    shoulderV: 0.34,
    hipV: 0.62,
    soleV: 0.94,
    centerU: 0.5,
    heightFrac: 0.86,
  };
}

export function createMasterRigFromFront(
  frontDataUrl: string,
  creatureClass: UniversalCreatureClass = 'humanoid',
  name = 'Karakter',
  anchors: ViewAnchors = defaultViewAnchors(),
  width = 512,
  height = 512
): CharacterMasterRig {
  const now = Date.now();
  return {
    id: `rig-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name,
    creatureClass,
    views: {
      front: {
        angle: 'front',
        dataUrl: frontDataUrl,
        source: 'original_drawing',
        anchors,
        width,
        height,
        createdAt: now,
      },
    },
    faceSprites: { autoInkStyle: true },
    updatedAt: now,
  };
}

export function getAvailableRigAngles(rig?: CharacterMasterRig | null): CharacterViewAngle[] {
  if (!rig?.views) return ['front'];
  const list: CharacterViewAngle[] = [];
  for (const ang of VIEW_ANGLE_ORDER) {
    if (rig.views[ang]?.dataUrl) list.push(ang);
  }
  return list.length > 0 ? list : ['front'];
}

export function countRigViews(rig?: CharacterMasterRig | null): number {
  if (!rig?.views) return 1;
  let n = 0;
  for (const ang of VIEW_ANGLE_ORDER) {
    if (rig.views[ang]?.dataUrl) n++;
  }
  return Math.max(1, n);
}
