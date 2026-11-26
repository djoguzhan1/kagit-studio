import type { MeshFrameOffsets, MeshPin } from '../types/studio';
import type { FilmEmotionId, VisemeId } from '../types/film';
import {
  solveTwoBoneIK,
  type RiggedCharacterPack,
  type SegmentedLimbPart,
  type Vec2,
} from './skeletonSkinEngine';
import {
  evaluateArchetypeSilhouetteMesh,
  evaluateConformingSkinnedMesh,
} from './dualQuatSkinning';
import {
  drawInpaintedSocketBackingPass,
  renderConformingMeshAuto,
  renderConformingMeshWebGLGpuSkinned,
} from './webglSkinnedRenderer';
import {
  evaluateUniversalCreatureMesh,
  UNIVERSAL_CREATURE_CATALOG,
  type UniversalActionId,
} from './universalCreatureRig';
import type { KlausLightConfig } from './cpuRasterizer';
import { probeSoftwareRenderer } from './deviceTierEngine';

export type CartoonMoodId = 'natural' | 'joy' | 'cool' | 'sneak' | 'sprint';

/**
 * KÂĞIT Cartoon Motion Engine — Disney 12 Principles & Richard Williams Motion Craft.
 * Pure, deterministic, zero-DOM-required animation math powering:
 * - Automatic Silhouette Anatomy Detection (works on stickmen, cats, robots, ghosts, anything!)
 * - Richard Williams Contact -> Down -> Passing -> Up Walk Cycles with Ground-Locked Stance
 * - Volume-Preserving Squash & Stretch (sx * sy = 1) anchored strictly on the floor line
 * - Anticipation -> Parabolic Gravity Arc -> Impact Squash -> Overlapping Follow-Through
 * - Rigid-Head Protected 14x14 Articulated Cel Mesh with True Circular Shoulder Arm Arcs
 * - 2nd-Order Damped Harmonic Spring-Mass Physics for Interactive Rubber-Hose Stretching
 */

export interface DrawingAnatomy {
  centerX: number; // 0..1 horizontal center of mass
  headEndV: number; // 0.24..0.44 neck boundary protecting skull/face from warping
  headCenterX: number; // 0..1
  headCenterY: number; // 0..1
  mouthX: number; // 0..1 exact lower-face mouth anchor
  mouthY: number; // 0..1
  mouthScale: number; // 0.65..1.35 relative to character width
  neckX: number; // 0..1 scarf / collar attachment
  neckY: number; // 0..1
  hipV: number; // 0.58..0.72 hip / waist pivot
  shoulderLeftX: number; // 0..1
  shoulderRightX: number; // 0..1
  shoulderY: number; // 0..1
  handLeftX: number; // 0..1
  handLeftY: number; // 0..1
  handRightX: number; // 0..1
  handRightY: number; // 0..1
  footLeftX: number; // 0..1
  footRightX: number; // 0..1
  groundV: number; // 0.85..0.99 actual bottom pixel contact line
  bipedal: boolean; // true if distinct left/right leg stance detected
}

export interface ArticulatedCartoonPose {
  /** Horizontal offset in normalized character width (-0.5..0.5) */
  hipShiftX: number;
  /** Vertical bounce / lift in normalized character height (positive = UP off ground, negative = crouch DOWN) */
  hipLiftY: number;
  /** Volume-preserving vertical scale (sx = 1 / sy strictly!) */
  squashY: number;
  squashX: number;
  /** Torso lean in radians (positive = leans right) */
  torsoLeanRad: number;
  /** Contrapposto chest twist / counter-tilt in radians */
  chestCounterRad: number;
  /** Overlapping head angle in radians (lags behind torso!) */
  headTiltRad: number;
  /** Subtle overlapping head vertical bob in normalized height */
  headLagY: number;
  /** Subtle horizontal head lead/turn (-1..1) */
  headTurnX: number;
  /** True circular arm swing angles in radians (positive = forward/up, negative = back/down) */
  leftArmAngle: number;
  rightArmAngle: number;
  /** Secondary wrist/hand flex lag in radians */
  leftArmLag: number;
  rightArmLag: number;
  /** Horizontal leg stride (-1 = back, +1 = forward) */
  leftLegStride: number;
  rightLegStride: number;
  /** Vertical foot lift during Passing Pose arc (0 = strictly planted on ground, >0 = lifted!) */
  leftFootLift: number;
  rightFootLift: number;
  /** V3 Reverse-Foot Roll (-1 = toe push-off / plantarflexion, 0 = flat sole, +1 = heel-strike dorsiflexion) */
  leftFootRoll?: number;
  rightFootRoll?: number;
  /** V3 Relaxed wrist/hand follow-through pitch in radians */
  leftWristLag?: number;
  rightWristLag?: number;
  /** V3 Subtle clavicle shrug / 2.5D shoulder turn offset (-1..1) */
  shoulderShrugL?: number;
  shoulderShrugR?: number;
  /** V3 Knee bend pole direction (-1 = natural forward knee, +1 = reversed) */
  kneePoleDir?: -1 | 1;
  /** True on the exact beat a foot plants onto the floor (triggers dust puffs / puddle ripples!) */
  footContact: boolean;
  /** Which side planted (-1 left, 0 both, +1 right) */
  contactSide: -1 | 0 | 1;
  /** Speech & facial acting state */
  mouthOpen: number;
  viseme: VisemeId;
  /** 0 = open eyes, 1 = natural blink closed */
  blink: number;
  /** Facing direction (+1 right, -1 left) */
  facing: 1 | -1;
}

export interface SpringPinState {
  dx: number;
  dy: number;
  vx: number;
  vy: number;
}

export interface DanceLeapState {
  active: boolean;
  startSec: number;
  fromX: number;
  toX: number;
  currentX: number;
  facing: 1 | -1;
}

// ============================================================================
// 1. EASING & TIMING CURVES (Real Studio Animation Curves — Never Flat Sines!)
// ============================================================================

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function easeInOutCubic(t: number): number {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

export function easeOutCubic(t: number): number {
  const x = clamp01(t);
  return 1 - Math.pow(1 - x, 3);
}

export function easeInQuad(t: number): number {
  const x = clamp01(t);
  return x * x;
}

export function easeOutBack(t: number, overshoot = 1.45): number {
  const x = clamp01(t);
  const c3 = overshoot + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + overshoot * Math.pow(x - 1, 2);
}

/** Authentic asymmetric cartoon breathing curve: 40% smooth inhale, 10% hold, 50% relaxed exhale */
export function organicBreathCurve(phase01: number): number {
  const p = ((phase01 % 1) + 1) % 1;
  if (p < 0.4) {
    return easeOutCubic(p / 0.4);
  }
  if (p < 0.5) {
    return 1.0;
  }
  return 1 - easeInOutCubic((p - 0.5) / 0.5);
}

/**
 * Evaluates a single leg's authentic Richard Williams Walk Stride, Passing-Pose Lift & Reverse-Foot Ankle Roll.
 * cycle01 in [0, 1):
 *   0.00      = Heel-Strike Contact (footRoll = +0.84 dorsiflexed, heel touches ground first!)
 *   0.08..0.34 = Flat Planted Stance (footRoll = 0.00, 100% flush sole carrying body weight, 0.00px slip!)
 *   0.34..0.50 = Ball/Toe Push-Off Roll (footRoll ramps 0 -> -0.92, heel peels up while toes stay planted!)
 *   0.50..0.90 = Swing / Passing Phase (55°–62° natural knee bend, footRoll = -0.46 relaxed ankle!)
 *   0.90..1.00 = Reach / Pre-Contact (ankle smoothly lifts to +0.84 ready for next heel-strike!)
 */
export function evalNaturalFootRoll(cycle01: number): number {
  const p = ((cycle01 % 1) + 1) % 1;
  if (p < 0.09) {
    // Heel-strike -> flat sole settle
    return 0.84 * (1 - easeOutCubic(p / 0.09));
  }
  if (p < 0.34) {
    // 100% flat planted stance!
    return 0;
  }
  if (p < 0.50) {
    // Toe push-off roll (heel rises smoothly while ball & toe press floor!)
    return -0.92 * easeInOutCubic((p - 0.34) / 0.16);
  }
  if (p < 0.86) {
    // Relaxed hanging ankle during passing swing
    const u = (p - 0.50) / 0.36;
    return -0.92 * (1 - easeOutCubic(Math.min(1, u * 1.6))) - 0.44 * easeOutCubic(Math.min(1, u * 1.6));
  }
  // Smooth pre-contact dorsiflexion preparing heel for next contact!
  const u = (p - 0.86) / 0.14;
  return -0.44 + 1.28 * easeInOutCubic(u);
}

/**
 * Exact velocity-matched walk ground speed (px/sec) so scrolling backgrounds move at
 * the EXACT speed of planted stance feet (`v = 2 * strideSpanPx * walkHz` -> 0.00px foot slip!).
 */
export function computeExactWalkGroundSpeedPx(
  drawH: number,
  anatomy: DrawingAnatomy,
  mood: CartoonMoodId
): number {
  const legPx = Math.max(24, (anatomy.groundV - anatomy.hipV) * drawH);
  const walkHz =
    mood === 'sprint' ? 1.85 : mood === 'sneak' ? 0.64 : mood === 'cool' ? 0.82 : mood === 'natural' ? 0.96 : 1.04;
  const strideAmp =
    mood === 'sprint' ? 1.18 : mood === 'sneak' ? 0.76 : mood === 'cool' ? 0.86 : mood === 'natural' ? 0.94 : 1.0;
  const strideSpanPx = legPx * 0.48 * strideAmp;
  return 2 * strideSpanPx * walkHz;
}

export function evalWilliamsLeg(cycle01: number): { stride: number; lift: number; planted: boolean; footRoll: number } {
  const p = ((cycle01 % 1) + 1) % 1;
  const footRoll = evalNaturalFootRoll(p);
  if (p < 0.5) {
    // Stance phase: linear ground velocity (0.00px foot slip against moving floor!)
    const u = p / 0.5;
    const stride = 1 - 2 * u;
    return { stride, lift: 0, planted: true, footRoll };
  }
  // Swing phase: curved Passing Pose arc from -1 (back) forward to +1 (front contact)
  const u = (p - 0.5) / 0.5;
  const stride = -1 + 2 * easeInOutCubic(u);
  const lift = Math.pow(Math.sin(u * Math.PI), 1.1);
  return { stride, lift, planted: false, footRoll };
}

/**
 * Evaluates Richard Williams Vertical Hip Pelvis Wave for a full 2-step walk cycle:
 *   0.00 Contact -> 0.14 Down (lowest!) -> 0.25 Passing -> 0.37 Up (highest!) -> 0.50 Contact (repeat)
 */
export function evalWilliamsHipBounce(cycle01: number): { hipY: number; downSquash: number } {
  // Two bounces per full L+R cycle
  const stepPhase = (((cycle01 * 2) % 1) + 1) % 1;
  let hipY = 0;
  if (stepPhase < 0.26) {
    // Contact (0) -> Down (-1.0) at 0.26
    const u = stepPhase / 0.26;
    hipY = -Math.sin(u * Math.PI * 0.5);
  } else if (stepPhase < 0.72) {
    // Down (-1.0) -> Passing (0.2) -> Up (+1.0) at 0.72
    const u = (stepPhase - 0.26) / 0.46;
    hipY = -1 + 2 * easeInOutCubic(u);
  } else {
    // Up (+1.0) -> next Contact (0)
    const u = (stepPhase - 0.72) / 0.28;
    hipY = 1 - easeInQuad(u);
  }
  // Subtle compression right at Down pose, slight lift stretch at Up push-off
  const downSquash = Math.max(0, -hipY);
  return { hipY, downSquash };
}

// ============================================================================
// 2. AUTOMATIC SILHOUETTE ANATOMY ANALYZER (Works on ANY User Drawing!)
// ============================================================================

export function defaultDrawingAnatomy(): DrawingAnatomy {
  return {
    centerX: 0.5,
    headEndV: 0.36,
    headCenterX: 0.5,
    headCenterY: 0.22,
    mouthX: 0.5,
    mouthY: 0.28,
    mouthScale: 1,
    neckX: 0.5,
    neckY: 0.37,
    hipV: 0.65,
    shoulderLeftX: 0.34,
    shoulderRightX: 0.66,
    shoulderY: 0.41,
    handLeftX: 0.18,
    handLeftY: 0.48,
    handRightX: 0.82,
    handRightY: 0.48,
    footLeftX: 0.38,
    footRightX: 0.62,
    groundV: 0.94,
    bipedal: true,
  };
}

/** Pure pixel analyzer: inspects opaque ink distribution to locate real head, arms, neck & feet */
export function analyzeDrawingAnatomyFromPixels(
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): DrawingAnatomy {
  const def = defaultDrawingAnatomy();
  if (width < 8 || height < 8 || rgba.length < width * height * 4) return def;

  const bands = 24;
  const bandCount = new Float32Array(bands);
  const bandSumX = new Float32Array(bands);
  const bandMinX = new Float32Array(bands).fill(1);
  const bandMaxX = new Float32Array(bands).fill(0);

  let totalMass = 0;
  let totalSumX = 0;
  let maxOpaqueY = 0;
  let minOpaqueY = height - 1;

  // Bottom leg split detection (for bipedal vs single-base detection)
  let botLeftMass = 0;
  let botMidMass = 0;
  let botRightMass = 0;
  let botLeftSumX = 0;
  let botRightSumX = 0;

  const stepX = Math.max(1, Math.floor(width / 120));
  const stepY = Math.max(1, Math.floor(height / 120));

  for (let y = 0; y < height; y += stepY) {
    const v = y / Math.max(1, height - 1);
    const bi = Math.min(bands - 1, Math.floor(v * bands));
    for (let x = 0; x < width; x += stepX) {
      const a = rgba[(y * width + x) * 4 + 3];
      if (a < 28) continue;
      const u = x / Math.max(1, width - 1);
      totalMass++;
      totalSumX += u;
      if (y > maxOpaqueY) maxOpaqueY = y;
      if (y < minOpaqueY) minOpaqueY = y;

      bandCount[bi]++;
      bandSumX[bi] += u;
      if (u < bandMinX[bi]) bandMinX[bi] = u;
      if (u > bandMaxX[bi]) bandMaxX[bi] = u;
    }
  }

  if (totalMass < 12) return def;

  const centerX = Math.max(0.28, Math.min(0.72, totalSumX / totalMass));
  const topV = minOpaqueY / Math.max(1, height - 1);
  const groundV = Math.max(0.75, Math.min(0.99, maxOpaqueY / Math.max(1, height - 1)));
  const spanV = Math.max(0.25, groundV - topV);

  // Locate head center in top 32% of actual drawn height
  let headMass = 0;
  let headSumX = 0;
  let headSumY = 0;
  let headMaxWidth = 0;

  // Find neck pinch (narrowest band between 24% and 46% of drawn height)
  let neckV = topV + spanV * 0.36;
  let minNeckSpan = Infinity;

  // Find widest left/right arm extremities in 30%..65% of drawn height
  let handLeftX = 1;
  let handLeftY = topV + spanV * 0.46;
  let handRightX = 0;
  let handRightY = topV + spanV * 0.46;

  for (let bi = 0; bi < bands; bi++) {
    if (bandCount[bi] === 0) continue;
    const bv = (bi + 0.5) / bands;
    const relV = (bv - topV) / spanV;
    const bw = Math.max(0, bandMaxX[bi] - bandMinX[bi]);
    const bcx = bandSumX[bi] / bandCount[bi];

    if (relV >= 0.02 && relV <= 0.33) {
      headMass += bandCount[bi];
      headSumX += bandSumX[bi];
      headSumY += bv * bandCount[bi];
      if (bw > headMaxWidth) headMaxWidth = bw;
    }

    if (relV >= 0.18 && relV <= 0.45 && bw > 0.01) {
      if (bw < minNeckSpan * 0.96) {
        minNeckSpan = bw;
        neckV = bv;
      }
    } else if (relV > 0.45 && relV <= 0.54 && bw > 0.01 && headMaxWidth > 0 && minNeckSpan > headMaxWidth * 0.72) {
      // Only extend neck scan below 45% for huge big-headed chibi / kid-drawn proportions where
      // the face was still wide all the way down to 45%!
      if (bw < minNeckSpan * 0.92) {
        minNeckSpan = bw;
        neckV = bv;
      }
    }

    if (relV >= 0.3 && relV <= 0.66) {
      if (bandMinX[bi] < handLeftX) {
        handLeftX = bandMinX[bi];
        handLeftY = bv;
      }
      if (bandMaxX[bi] > handRightX) {
        handRightX = bandMaxX[bi];
        handRightY = bv;
      }
    }
    void bcx;
  }

  // Analyze bottom 26% of drawn height for foot locations & TRUE transparent leg-gap bipedal check!
  const legStartY = Math.floor((topV + spanV * 0.72) * (height - 1));
  const legEndY = Math.min(maxOpaqueY, Math.floor((topV + spanV * 0.95) * (height - 1)));
  let legSplitRows = 0;
  let legTestedRows = 0;
  for (let y = legStartY; y <= maxOpaqueY; y += stepY) {
    let rowMinX = width;
    let rowMaxX = -1;
    for (let x = 0; x < width; x += stepX) {
      const a = rgba[(y * width + x) * 4 + 3];
      if (a < 28) continue;
      if (x < rowMinX) rowMinX = x;
      if (x > rowMaxX) rowMaxX = x;
      const u = x / Math.max(1, width - 1);
      if (u < centerX - 0.04) {
        botLeftMass++;
        botLeftSumX += u;
      } else if (u > centerX + 0.04) {
        botRightMass++;
        botRightSumX += u;
      } else {
        botMidMass++;
      }
    }
    // Check whether this leg-zone row has a genuine transparent air gap between left & right legs
    // (Prevents solid ghosts, blobs, and flared A-line dresses from falsely testing bipedal = true!)
    if (y <= legEndY && rowMaxX - rowMinX >= Math.max(6, width * 0.08)) {
      legTestedRows++;
      const midStart = Math.round(rowMinX + (rowMaxX - rowMinX) * 0.28);
      const midEnd = Math.round(rowMinX + (rowMaxX - rowMinX) * 0.72);
      let gapPx = 0;
      for (let x = midStart; x <= midEnd; x += Math.max(1, stepX)) {
        if (rgba[(y * width + x) * 4 + 3] < 28) gapPx++;
      }
      if (gapPx >= 2) legSplitRows++;
    }
  }

  const headCenterX = headMass > 0 ? Math.max(0.28, Math.min(0.72, headSumX / headMass)) : centerX;
  const headCenterY =
    headMass > 0 ? Math.max(0.1, Math.min(0.38, headSumY / headMass)) : topV + spanV * 0.2;
  // Allow big-headed chibi / kid-drawn proportions (up to 56% height) when a real narrow neck exists!
  const headEndV = Math.max(0.25, Math.min(0.56, Math.max(headCenterY + 0.09, neckV)));
  const mouthY = Math.min(headEndV - 0.03, headCenterY + spanV * 0.075);
  const mouthScale = Math.max(0.7, Math.min(1.3, headMaxWidth > 0 ? headMaxWidth * 2.4 : 1));

  const footLeftX =
    botLeftMass > 2 ? Math.max(0.12, Math.min(centerX - 0.06, botLeftSumX / botLeftMass)) : centerX - 0.13;
  const footRightX =
    botRightMass > 2 ? Math.min(0.88, Math.max(centerX + 0.06, botRightSumX / botRightMass)) : centerX + 0.13;
  const hasRealLegGap = legTestedRows > 0 && legSplitRows >= Math.max(2, Math.floor(legTestedRows * 0.34));
  const bipedal =
    botLeftMass > 2 &&
    botRightMass > 2 &&
    hasRealLegGap &&
    botMidMass < (botLeftMass + botRightMass) * 0.75;

  const safeHandLeftX = handLeftX < 0.9 ? Math.max(0.06, Math.min(centerX - 0.12, handLeftX)) : centerX - 0.28;
  const safeHandRightX = handRightX > 0.1 ? Math.min(0.94, Math.max(centerX + 0.12, handRightX)) : centerX + 0.28;

  const shoulderSpan = Math.max(0.11, Math.min(0.2, (safeHandRightX - safeHandLeftX) * 0.28));

  return {
    centerX,
    headEndV,
    headCenterX,
    headCenterY,
    mouthX: headCenterX,
    mouthY,
    mouthScale,
    neckX: headCenterX,
    neckY: Math.min(0.56, headEndV + 0.02),
    hipV: Math.min(0.76, Math.max(headEndV + 0.16, Math.min(0.74, topV + spanV * 0.65))),
    shoulderLeftX: Math.max(0.18, headCenterX - shoulderSpan),
    shoulderRightX: Math.min(0.82, headCenterX + shoulderSpan),
    shoulderY: Math.min(0.58, headEndV + 0.045),
    handLeftX: safeHandLeftX,
    handLeftY: Math.max(headEndV + 0.02, Math.min(0.72, handLeftY)),
    handRightX: safeHandRightX,
    handRightY: Math.max(headEndV + 0.02, Math.min(0.72, handRightY)),
    footLeftX,
    footRightX,
    groundV,
    bipedal,
  };
}

export function analyzeCanvasAnatomy(canvas: HTMLCanvasElement): DrawingAnatomy {
  const ctx = canvas.getContext('2d');
  if (!ctx) return defaultDrawingAnatomy();
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  return analyzeDrawingAnatomyFromPixels(data, canvas.width, canvas.height);
}

/** Creates anatomical control pins tailored directly to the user's drawn character! */
export function createAnatomyPins(anatomy: DrawingAnatomy): MeshPin[] {
  return [
    { id: 'pin_root', label: 'Gövde', role: 'root', x: anatomy.centerX, y: (anatomy.neckY + anatomy.hipV) * 0.54 },
    { id: 'pin_head', label: 'Baş', role: 'head', x: anatomy.headCenterX, y: anatomy.headCenterY },
    { id: 'pin_hand_l', label: 'Sol El', role: 'hand-l', x: anatomy.handLeftX, y: anatomy.handLeftY },
    { id: 'pin_hand_r', label: 'Sağ El', role: 'hand-r', x: anatomy.handRightX, y: anatomy.handRightY },
    { id: 'pin_foot_l', label: 'Sol Ayak', role: 'foot-l', x: anatomy.footLeftX, y: Math.min(0.9, anatomy.groundV - 0.04) },
    { id: 'pin_foot_r', label: 'Sağ Ayak', role: 'foot-r', x: anatomy.footRightX, y: Math.min(0.9, anatomy.groundV - 0.04) },
  ];
}

// ============================================================================
// 3. 12-PRINCIPLES POSE EVALUATORS (Dance, Rainy Walk, Expressive Talk)
// ============================================================================

export function evaluateCartoonDancePose(
  tSec: number,
  leap: DanceLeapState | null,
  cadenceFps: 12 | 24 = 12,
  mood: CartoonMoodId = 'joy'
): ArticulatedCartoonPose {
  // Quantize pose clock for authentic classic cel animation timing (On-2s = 12 FPS, Smooth = 24 FPS)
  const qSec = Math.floor(tSec * cadenceFps) / cadenceFps;
  const prevQSec = Math.max(0, qSec - 1 / cadenceFps);

  // Natural blinking every ~3.4s
  const blinkMod = (qSec + 0.9) % 3.4;
  const blink = blinkMod < 0.12 ? Math.sin((blinkMod / 0.12) * Math.PI) : 0;

  // Interactive Click-to-Leap: Anticipation Crouch -> Parabolic Gravity Arc -> 1-Frame Impact Hit-Stop Squash -> Elastic Settle!
  if (leap && leap.active) {
    const leapDur = 0.86;
    const age = qSec - leap.startSec;
    if (age >= 0 && age < leapDur) {
      const p = age / leapDur;
      const dir = leap.facing;
      let squashY = 1;
      let hipLiftY = 0;
      let torsoLeanRad = 0;
      let headTiltRad = 0;
      let headLagY = 0;
      let leftArmAngle = 0;
      let rightArmAngle = 0;
      let leftLegStride = 0;
      let rightLegStride = 0;
      let leftFootLift = 0;
      let rightFootLift = 0;
      let footContact = false;

      if (p < 0.18) {
        const u = easeOutCubic(p / 0.18);
        squashY = 1 - 0.2 * u;
        hipLiftY = -0.05 * u;
        torsoLeanRad = dir * 0.14 * u;
        headTiltRad = -dir * 0.08 * u;
        leftArmAngle = -0.75 * u;
        rightArmAngle = -0.75 * u;
      } else if (p < 0.76) {
        const u = (p - 0.18) / 0.58;
        const arc = 4 * u * (1 - u);
        hipLiftY = arc * 0.44;
        const speedStretch = Math.abs(u - 0.5) * 2;
        squashY = 1.03 + speedStretch * 0.15;
        torsoLeanRad = dir * (0.18 * (1 - u * 1.6));
        headTiltRad = -torsoLeanRad * 0.45;
        headLagY = (u < 0.5 ? 0.028 : -0.025) * (1 - arc * 0.4);
        leftArmAngle = 1.05 - u * 0.35;
        rightArmAngle = 1.15 - u * 0.25;
        leftLegStride = dir * (0.65 * Math.sin(u * Math.PI));
        rightLegStride = -dir * (0.55 * Math.sin(u * Math.PI));
        leftFootLift = arc * 0.8;
        rightFootLift = arc * 0.9;
      } else {
        // Impact Hit-Stop (first 6% holds peak compression for visceral cartoon weight!) + Elastic Overshoot Settle
        const u = (p - 0.76) / 0.24;
        const prevAge = prevQSec - leap.startSec;
        footContact = prevAge < leapDur * 0.76 && age >= leapDur * 0.76;
        const uSettled = u < 0.2 ? 0.18 : (u - 0.2) / 0.8;
        const damp = u < 0.2 ? 0.95 : Math.exp(-uSettled * 4.2) * Math.sin((uSettled + 0.16) * Math.PI * 2.0);
        squashY = 1 - 0.22 * damp;
        hipLiftY = -0.05 * Math.max(0, damp);
        headLagY = 0.038 * Math.sin(Math.min(1, u * 1.35) * Math.PI);
        torsoLeanRad = dir * 0.09 * (1 - u);
        leftArmAngle = 0.35 * (1 - u) - 0.4 * Math.max(0, damp);
        rightArmAngle = 0.35 * (1 - u) - 0.4 * Math.max(0, damp);
      }

      squashY = Math.max(0.78, Math.min(1.22, squashY));
      return {
        hipShiftX: 0,
        hipLiftY,
        squashY,
        squashX: 1 / squashY,
        torsoLeanRad,
        chestCounterRad: -torsoLeanRad * 0.25,
        headTiltRad,
        headLagY,
        headTurnX: dir * 0.25,
        leftArmAngle,
        rightArmAngle,
        leftArmLag: -torsoLeanRad * 0.4,
        rightArmLag: -torsoLeanRad * 0.4,
        leftLegStride,
        rightLegStride,
        leftFootLift,
        rightFootLift,
        footContact,
        contactSide: 0,
        mouthOpen: 0,
        viseme: 'closed',
        blink,
        facing: dir,
      };
    }
  }

  // V3 FLAGSHIP: Non-Exaggerated Natural Everyday Walk ("Doğal Yürüyüş")!
  // Real heel-strike -> flat stance -> 58° passing knee -> toe push-off + relaxed arm pendulum & wrist follow-through!
  if (mood === 'natural') {
    const walkHz = 0.96;
    const cycle = (qSec * walkHz) % 1;
    const prevCycle = (prevQSec * walkHz) % 1;
    const leftLeg = evalWilliamsLeg(cycle);
    const rightLeg = evalWilliamsLeg((cycle + 0.5) % 1);
    const { hipY, downSquash } = evalWilliamsHipBounce(cycle);
    const { hipY: delayedHipY } = evalWilliamsHipBounce((cycle - 0.15 + 1) % 1);
    const armCycle = (cycle - 0.12 + 1) % 1;
    const armPhase = Math.cos(armCycle * Math.PI * 2);
    const wristPhase = Math.sin(armCycle * Math.PI * 2);
    const leftPlant = prevCycle > 0.84 && cycle < 0.2;
    const rightPlant = prevCycle < 0.5 && cycle >= 0.5;
    const squashY = Math.max(0.94, Math.min(1.04, 1 - downSquash * 0.032 + Math.max(0, hipY) * 0.016));
    return {
      hipShiftX: Math.sin(cycle * Math.PI * 2) * 0.022,
      hipLiftY: hipY * 0.022,
      squashY,
      squashX: 1 / squashY,
      torsoLeanRad: 0.048 + Math.max(0, hipY) * 0.012,
      chestCounterRad: -Math.sin(cycle * Math.PI * 2) * 0.038,
      headTiltRad: 0.015 + delayedHipY * 0.024,
      headLagY: (delayedHipY - hipY) * 0.014,
      headTurnX: 0.12 + Math.sin(qSec * 0.7) * 0.06,
      leftArmAngle: -armPhase * 0.46,
      rightArmAngle: armPhase * 0.46,
      leftArmLag: -wristPhase * 0.14,
      rightArmLag: wristPhase * 0.14,
      leftWristLag: -wristPhase * 0.18,
      rightWristLag: wristPhase * 0.18,
      shoulderShrugL: -armPhase * 0.16,
      shoulderShrugR: armPhase * 0.16,
      leftLegStride: leftLeg.stride * 0.92,
      rightLegStride: rightLeg.stride * 0.92,
      leftFootLift: leftLeg.lift * 0.92,
      rightFootLift: rightLeg.lift * 0.92,
      leftFootRoll: leftLeg.footRoll,
      rightFootRoll: rightLeg.footRoll,
      footContact: leftPlant || rightPlant,
      contactSide: leftPlant ? -1 : rightPlant ? 1 : 0,
      mouthOpen: 0,
      viseme: 'closed',
      blink,
      facing: 1,
    };
  }

  // Distinct Theatrical Acting Styles in Dance/Paper Stage!
  if (mood === 'cool') {
    // Slow confident swagger: leaned slightly back, rhythmic head nod, smooth low groove
    const g = qSec * 0.85;
    const sway = Math.sin(g * Math.PI * 2);
    const nod = Math.pow(Math.max(0, Math.sin(g * Math.PI * 4)), 1.6);
    const lag = Math.sin((g - 0.12) * Math.PI * 2);
    const squashY = 1 - nod * 0.055;
    return {
      hipShiftX: sway * 0.06,
      hipLiftY: -nod * 0.02,
      squashY,
      squashX: 1 / squashY,
      torsoLeanRad: -0.075 + sway * 0.04,
      chestCounterRad: -lag * 0.06,
      headTiltRad: -0.05 + nod * 0.12,
      headLagY: nod * 0.015,
      headTurnX: sway * 0.28,
      leftArmAngle: -0.18 + lag * 0.28,
      rightArmAngle: 0.25 - lag * 0.25,
      leftArmLag: -lag * 0.14,
      rightArmLag: lag * 0.14,
      leftLegStride: -Math.max(0, -sway) * 0.22,
      rightLegStride: Math.max(0, sway) * 0.22,
      leftFootLift: Math.pow(Math.max(0, sway), 2.2) * 0.14,
      rightFootLift: Math.pow(Math.max(0, -sway), 2.2) * 0.14,
      footContact: false,
      contactSide: 0,
      mouthOpen: 0,
      viseme: 'closed',
      blink,
      facing: 1,
    };
  }

  if (mood === 'sneak') {
    // Classic Cartoon Tiptoe Sneak: crouched forward, high cautious knee lifts, furtive left-right glances!
    const cycle = (qSec * 0.62) % 1;
    const prevCycle = (prevQSec * 0.62) % 1;
    const leftLeg = evalWilliamsLeg(cycle);
    const rightLeg = evalWilliamsLeg((cycle + 0.5) % 1);
    const leftPlant = prevCycle > 0.85 && cycle < 0.2;
    const rightPlant = prevCycle < 0.5 && cycle >= 0.5;
    const tiptoeHold = Math.sin(cycle * Math.PI * 4);
    const glance = Math.sin(qSec * 1.4);
    const squashY = 0.9 + Math.max(0, tiptoeHold) * 0.05;
    return {
      hipShiftX: Math.sin(cycle * Math.PI * 2) * 0.04,
      hipLiftY: -0.025 + Math.max(0, tiptoeHold) * 0.026,
      squashY,
      squashX: 1 / squashY,
      torsoLeanRad: 0.16 + Math.sin(cycle * Math.PI * 4) * 0.025,
      chestCounterRad: -Math.sin(cycle * Math.PI * 2) * 0.05,
      headTiltRad: -0.1 + Math.sin(cycle * Math.PI * 2) * 0.04,
      headLagY: 0.01,
      headTurnX: glance * 0.55,
      leftArmAngle: 0.22 + Math.cos(cycle * Math.PI * 2) * 0.2,
      rightArmAngle: 0.22 - Math.cos(cycle * Math.PI * 2) * 0.2,
      leftArmLag: 0.16,
      rightArmLag: 0.16,
      leftLegStride: leftLeg.stride * 0.68,
      rightLegStride: rightLeg.stride * 0.68,
      leftFootLift: Math.pow(leftLeg.lift, 0.85) * 0.88,
      rightFootLift: Math.pow(rightLeg.lift, 0.85) * 0.88,
      footContact: leftPlant || rightPlant,
      contactSide: leftPlant ? -1 : rightPlant ? 1 : 0,
      mouthOpen: 0,
      viseme: 'closed',
      blink,
      facing: 1,
    };
  }

  if (mood === 'sprint') {
    // High-energy Hero Sprint in place with deep forward lean, pumping bent elbows & airborne flight!
    const cycle = (qSec * 1.85) % 1;
    const prevCycle = (prevQSec * 1.85) % 1;
    const leftLeg = evalWilliamsLeg(cycle);
    const rightLeg = evalWilliamsLeg((cycle + 0.5) % 1);
    const { hipY, downSquash } = evalWilliamsHipBounce(cycle);
    const armPhase = Math.cos(((cycle - 0.1 + 1) % 1) * Math.PI * 2);
    const leftPlant = prevCycle > 0.8 && cycle < 0.25;
    const rightPlant = prevCycle < 0.5 && cycle >= 0.5;
    const squashY = Math.max(0.84, Math.min(1.14, 1 - downSquash * 0.1 + Math.max(0, hipY) * 0.07));
    return {
      hipShiftX: Math.sin(cycle * Math.PI * 2) * 0.025,
      hipLiftY: 0.045 + hipY * 0.08,
      squashY,
      squashX: 1 / squashY,
      torsoLeanRad: 0.25 + hipY * 0.03,
      chestCounterRad: -Math.sin(cycle * Math.PI * 2) * 0.08,
      headTiltRad: -0.09 + Math.sin(cycle * Math.PI * 4 - 0.8) * 0.05,
      headLagY: -hipY * 0.018,
      headTurnX: 0.3,
      leftArmAngle: -armPhase * 1.05 + 0.25,
      rightArmAngle: armPhase * 1.05 + 0.25,
      leftArmLag: -armPhase * 0.35,
      rightArmLag: armPhase * 0.35,
      leftLegStride: leftLeg.stride * 1.18,
      rightLegStride: rightLeg.stride * 1.18,
      leftFootLift: leftLeg.lift * 1.28,
      rightFootLift: rightLeg.lift * 1.28,
      footContact: leftPlant || rightPlant,
      contactSide: leftPlant ? -1 : rightPlant ? 1 : 0,
      mouthOpen: 0,
      viseme: 'closed',
      blink,
      facing: 1,
    };
  }

  // Default ('joy'): 3.6-second Two-Beat Cartoon Dance Phrase (Groove Weight-Transfer + Joyful Hop!)
  const phraseDur = 3.6;
  const p = ((qSec % phraseDur) + phraseDur) % phraseDur / phraseDur;
  const prevP = ((prevQSec % phraseDur) + phraseDur) % phraseDur / phraseDur;

  if (p < 0.62) {
    // BEAT 1 (0..62%): Rhythmic Weight-Transfer Groove — shifting left/right onto alternating knees with overlapping shoulders & head!
    const g = (p / 0.62) * 2; // 2 smooth left-right groove cycles
    const sway = Math.sin(g * Math.PI * 2);
    const kneeDip = Math.pow(Math.abs(Math.sin(g * Math.PI * 2)), 1.4);
    const lagSway = Math.sin((g - 0.09) * Math.PI * 2); // Arms/head lag 2 frames behind hips!
    const headLag = Math.sin((g - 0.14) * Math.PI * 2);

    const squashY = 1 - kneeDip * 0.09 + (1 - kneeDip) * 0.03;
    const stepL = Math.max(0, -sway);
    const stepR = Math.max(0, sway);

    return {
      hipShiftX: sway * 0.075,
      hipLiftY: -kneeDip * 0.025 + (1 - kneeDip) * 0.02,
      squashY,
      squashX: 1 / squashY,
      torsoLeanRad: sway * 0.085,
      chestCounterRad: -lagSway * 0.065,
      headTiltRad: -headLag * 0.11,
      headLagY: (kneeDip - 0.5) * 0.02,
      headTurnX: sway * 0.22,
      leftArmAngle: 0.42 + lagSway * 0.48,
      rightArmAngle: 0.42 - lagSway * 0.48,
      leftArmLag: -sway * 0.18,
      rightArmLag: sway * 0.18,
      leftLegStride: -stepL * 0.28,
      rightLegStride: stepR * 0.28,
      leftFootLift: Math.pow(Math.max(0, sway), 1.6) * 0.25,
      rightFootLift: Math.pow(Math.max(0, -sway), 1.6) * 0.25,
      footContact: false,
      contactSide: 0,
      mouthOpen: 0,
      viseme: 'closed',
      blink,
      facing: 1,
    };
  }

  // BEAT 2 (62..100%): Classic Disney Anticipation -> Joyful Hop -> Impact Squash & Settle!
  const j = (p - 0.62) / 0.38;
  const prevJ = prevP >= 0.62 ? (prevP - 0.62) / 0.38 : -1;
  let squashY = 1;
  let hipLiftY = 0;
  let torsoLeanRad = 0;
  let headTiltRad = 0;
  let headLagY = 0;
  let leftArmAngle = 0;
  let rightArmAngle = 0;
  let leftFootLift = 0;
  let rightFootLift = 0;
  let footContact = false;

  if (j < 0.22) {
    // Anticipation crouch!
    const u = easeOutCubic(j / 0.22);
    squashY = 1 - 0.17 * u;
    hipLiftY = -0.045 * u;
    torsoLeanRad = 0.06 * u;
    leftArmAngle = -0.58 * u;
    rightArmAngle = -0.58 * u;
  } else if (j < 0.72) {
    // Launch stretch -> gravity apex hang!
    const u = (j - 0.22) / 0.5;
    const arc = 4 * u * (1 - u);
    hipLiftY = arc * 0.28;
    squashY = 1.02 + Math.abs(u - 0.5) * 0.22;
    torsoLeanRad = -0.05 * Math.sin(u * Math.PI);
    headTiltRad = 0.08 * Math.sin(u * Math.PI);
    headLagY = u < 0.5 ? 0.022 : -0.02;
    leftArmAngle = 1.05 * Math.sin(Math.min(1, u * 1.15) * Math.PI * 0.65);
    rightArmAngle = 1.12 * Math.sin(Math.min(1, u * 1.15) * Math.PI * 0.65);
    leftFootLift = arc * 0.7;
    rightFootLift = arc * 0.7;
  } else {
    // Landing squash + elastic damped bounce settle!
    const u = (j - 0.72) / 0.28;
    footContact = prevJ < 0.72 && j >= 0.72;
    const damp = Math.exp(-u * 4.2) * Math.sin(u * Math.PI * 2.0);
    squashY = 1 - 0.19 * damp;
    hipLiftY = -0.04 * Math.max(0, damp);
    headLagY = 0.032 * Math.sin(Math.min(1, u * 1.3) * Math.PI);
    leftArmAngle = 0.4 * (1 - u) - 0.35 * Math.max(0, damp);
    rightArmAngle = 0.4 * (1 - u) - 0.35 * Math.max(0, damp);
  }

  squashY = Math.max(0.8, Math.min(1.2, squashY));
  return {
    hipShiftX: 0,
    hipLiftY,
    squashY,
    squashX: 1 / squashY,
    torsoLeanRad,
    chestCounterRad: -torsoLeanRad * 0.3,
    headTiltRad,
    headLagY,
    headTurnX: 0,
    leftArmAngle,
    rightArmAngle,
    leftArmLag: 0.14 * (1 - squashY),
    rightArmLag: -0.14 * (1 - squashY),
    leftLegStride: -hipLiftY * 0.6,
    rightLegStride: hipLiftY * 0.6,
    leftFootLift,
    rightFootLift,
    footContact,
    contactSide: 0,
    mouthOpen: 0,
    viseme: 'closed',
    blink,
    facing: 1,
  };
}

/**
 * Evaluates a true Richard Williams Walk Cycle for the Rainy Lantern Mini-Film mode!
 * Guarantees planted stance feet, curved Passing Pose foot lifts, figure-8 hips,
 * contrapposto chest twist, arc arm swings with follow-through lag, and overlapping head bob.
 */
export function evaluateCartoonRainWalkPose(
  tSec: number,
  anatomy: DrawingAnatomy,
  cadenceFps: 12 | 24 = 12,
  mood: CartoonMoodId = 'joy',
  startle = 0
): ArticulatedCartoonPose {
  const qSec = Math.floor(tSec * cadenceFps) / cadenceFps;
  const prevQSec = Math.max(0, qSec - 1 / cadenceFps);

  // Mood-calibrated stride cadence, posture & acting flavor (with non-exaggerated V3 'natural' baseline!)
  const walkHz =
    mood === 'sprint'
      ? 1.85
      : mood === 'sneak'
        ? 0.64
        : mood === 'cool'
          ? 0.82
          : mood === 'natural'
            ? 0.96
            : 1.04;
  const cycle = (qSec * walkHz) % 1;
  const prevCycle = (prevQSec * walkHz) % 1;

  const leftPlant = prevCycle > 0.82 && cycle < 0.22;
  const rightPlant = prevCycle < 0.5 && cycle >= 0.5;
  const footContact = leftPlant || rightPlant;
  const contactSide: -1 | 0 | 1 = leftPlant ? -1 : rightPlant ? 1 : 0;

  const leftLeg = evalWilliamsLeg(cycle);
  const rightLeg = evalWilliamsLeg((cycle + 0.5) % 1);
  const { hipY, downSquash } = evalWilliamsHipBounce(cycle);
  const { hipY: delayedHipY } = evalWilliamsHipBounce((cycle - 0.16 + 1) % 1);

  const armCycle = (cycle - 0.12 + 1) % 1;
  const armPhase = Math.cos(armCycle * Math.PI * 2);
  const wristLag = Math.sin(armCycle * Math.PI * 2);
  const breath = organicBreathCurve(qSec * 0.35);

  const facing: 1 | -1 = 1;
  const legScale = anatomy.bipedal ? 1.0 : 0.38;
  const strideAmp =
    mood === 'sprint' ? 1.18 : mood === 'sneak' ? 0.76 : mood === 'cool' ? 0.86 : mood === 'natural' ? 0.94 : 1.0;
  const liftAmp =
    mood === 'sprint' ? 1.25 : mood === 'sneak' ? 1.32 : mood === 'cool' ? 0.74 : mood === 'natural' ? 0.94 : 1.0;
  const armAmp =
    mood === 'sprint' ? 1.02 : mood === 'sneak' ? 0.32 : mood === 'cool' ? 0.42 : mood === 'natural' ? 0.48 : 0.62;
  const baseLean =
    mood === 'sprint' ? 0.22 : mood === 'sneak' ? 0.18 : mood === 'cool' ? -0.055 : mood === 'natural' ? 0.048 : 0.075;
  const baseHipLift = mood === 'sprint' ? 0.032 : mood === 'sneak' ? -0.045 : 0;
  const bounceAmp =
    mood === 'sprint' ? 0.068 : mood === 'sneak' ? 0.022 : mood === 'cool' ? 0.024 : mood === 'natural' ? 0.023 : 0.040;

  // Lightning startle reaction: sudden startled hop + arms up + gasp!
  const st = clamp01(startle);
  const squashAmp = mood === 'sprint' ? 0.085 : mood === 'natural' ? 0.032 : 0.062;
  const squashY = Math.max(
    0.85,
    Math.min(
      1.15,
      1 - downSquash * squashAmp + Math.max(0, hipY) * (mood === 'natural' ? 0.016 : 0.032) + breath * 0.01 + st * 0.12
    )
  );
  const hipShiftX = Math.sin(cycle * Math.PI * 2) * (mood === 'cool' ? 0.042 : mood === 'natural' ? 0.022 : 0.03);

  const blinkMod = (qSec + 1.4) % 3.8;
  const blink = st > 0.25 ? 0 : blinkMod < 0.12 ? Math.sin((blinkMod / 0.12) * Math.PI) : 0;

  return {
    hipShiftX,
    hipLiftY: baseHipLift + hipY * (anatomy.bipedal ? bounceAmp : bounceAmp * 1.25) + st * 0.09,
    squashY,
    squashX: 1 / squashY,
    torsoLeanRad: facing * (baseLean + Math.max(0, hipY) * (mood === 'natural' ? 0.012 : 0.024)) - st * 0.12,
    chestCounterRad: -Math.sin(cycle * Math.PI * 2) * (mood === 'cool' ? 0.07 : mood === 'natural' ? 0.038 : 0.05),
    headTiltRad:
      (mood === 'sneak' ? -0.12 : mood === 'cool' ? -0.04 : mood === 'natural' ? 0.015 : 0.03) +
      delayedHipY * (mood === 'natural' ? 0.024 : 0.048) -
      st * 0.16,
    headLagY: (delayedHipY - hipY) * (mood === 'natural' ? 0.014 : 0.024),
    headTurnX: mood === 'sneak' ? Math.sin(qSec * 1.5) * 0.55 : facing * 0.14 + Math.sin(qSec * 0.85) * 0.08,
    leftArmAngle: (mood === 'sneak' ? 0.2 : 0) - armPhase * armAmp + st * 0.75,
    rightArmAngle: (mood === 'sneak' ? 0.2 : 0) + armPhase * armAmp + st * 0.75,
    leftArmLag: -wristLag * (mood === 'natural' ? 0.14 : 0.18),
    rightArmLag: wristLag * (mood === 'natural' ? 0.14 : 0.18),
    leftWristLag: -wristLag * (mood === 'natural' ? 0.18 : 0.22),
    rightWristLag: wristLag * (mood === 'natural' ? 0.18 : 0.22),
    shoulderShrugL: -armPhase * (mood === 'natural' ? 0.15 : 0.22),
    shoulderShrugR: armPhase * (mood === 'natural' ? 0.15 : 0.22),
    leftLegStride: leftLeg.stride * legScale * strideAmp,
    rightLegStride: rightLeg.stride * legScale * strideAmp,
    leftFootLift: Math.min(1.0, Math.pow(leftLeg.lift, mood === 'sneak' ? 0.85 : 1.0) * legScale * Math.min(1.0, liftAmp)),
    rightFootLift: Math.min(1.0, Math.pow(rightLeg.lift, mood === 'sneak' ? 0.85 : 1.0) * legScale * Math.min(1.0, liftAmp)),
    leftFootRoll: leftLeg.footRoll * legScale,
    rightFootRoll: rightLeg.footRoll * legScale,
    footContact,
    contactSide,
    mouthOpen: st > 0.25 ? st * 0.78 : 0,
    viseme: st > 0.25 ? 'OH' : 'closed',
    blink,
    facing,
  };
}

/**
 * Evaluates Natural Expressive Co-Speech Acting for Talk Mode:
 * organic breathing, spontaneous blinking, syllable head nods, and open-hand emphasis gestures!
 */
export function evaluateCartoonTalkPose(
  tSec: number,
  smoothVoiceAmp: number,
  voicePeakDelta: number,
  cadenceFps: 12 | 24 = 24
): ArticulatedCartoonPose {
  const qSec = Math.floor(tSec * cadenceFps) / cadenceFps;
  const amp = clamp01(smoothVoiceAmp);
  const breath = organicBreathCurve(qSec * 0.28);

  // Expressive 6-shape viseme driven by voice loudness + subtle cadence texture
  let viseme: VisemeId = 'closed';
  if (amp > 0.08) {
    const tex = (Math.sin(qSec * 19.3) + 1) * 0.5;
    if (amp > 0.62) viseme = tex > 0.35 ? 'AA' : 'OH';
    else if (amp > 0.36) viseme = tex > 0.5 ? 'EE' : 'OH';
    else if (amp > 0.18) viseme = tex > 0.5 ? 'OO' : 'EE';
    else viseme = 'FV';
  }

  // Co-speech acting: stressed syllables trigger forward head nod + slight chest expansion + gesturing hands!
  const gestureWave = Math.sin(qSec * 4.2);
  const emphasis = Math.min(1, amp * 0.85 + Math.max(0, voicePeakDelta) * 1.4);
  const nod = emphasis * 0.095 * Math.sin(qSec * 8.5 + 0.4);
  const squashY = 1 + breath * 0.025 + emphasis * 0.055;

  const blinkMod = (qSec + 0.5) % 3.1;
  const blink = blinkMod < 0.11 ? Math.sin((blinkMod / 0.11) * Math.PI) : 0;

  return {
    hipShiftX: Math.sin(qSec * 1.35) * 0.024,
    hipLiftY: breath * 0.012 + emphasis * 0.028,
    squashY,
    squashX: 1 / squashY,
    torsoLeanRad: Math.sin(qSec * 1.6) * 0.035 + emphasis * 0.03,
    chestCounterRad: -Math.sin(qSec * 2.1) * 0.03,
    headTiltRad: Math.sin(qSec * 2.4) * 0.055 + nod,
    headLagY: -emphasis * 0.014,
    headTurnX: Math.sin(qSec * 1.1) * 0.14,
    // Right hand emphasizes slightly ahead of left hand (asymmetric natural acting!)
    leftArmAngle: 0.12 + emphasis * (0.42 + gestureWave * 0.25),
    rightArmAngle: 0.22 + emphasis * (0.58 - gestureWave * 0.22),
    leftArmLag: emphasis * 0.14 * Math.cos(qSec * 4.2),
    rightArmLag: -emphasis * 0.14 * Math.cos(qSec * 4.2),
    leftLegStride: -0.06,
    rightLegStride: 0.06,
    leftFootLift: 0,
    rightFootLift: 0,
    footContact: false,
    contactSide: 0,
    mouthOpen: amp,
    viseme,
    blink,
    facing: 1,
  };
}

// ============================================================================
// 4. 2ND-ORDER DAMPED HARMONIC SPRING-MASS SOLVER (For "Çekiştir" Rubber Mode!)
// ============================================================================

/** Advances spring-mass pin displacements with genuine cartoon elastic overshoot & neighbor wave coupling */
export function stepSpringPins(
  pins: MeshPin[],
  springs: Record<string, SpringPinState>,
  draggingPinId: string | null,
  dtSec: number,
  stiffness = 185,
  damping = 12.5
): MeshFrameOffsets {
  const dt = Math.min(0.033, Math.max(0.004, dtSec));
  const out: MeshFrameOffsets = {};

  // Ensure every pin has spring state
  for (const p of pins) {
    if (!springs[p.id]) {
      springs[p.id] = { dx: 0, dy: 0, vx: 0, vy: 0 };
    }
  }

  // Root / dragged pin influence creates gentle secondary follow-through wave on adjacent pins
  const dragState = draggingPinId ? springs[draggingPinId] : null;

  for (const p of pins) {
    const s = springs[p.id];
    if (p.id === draggingPinId) {
      s.vx = 0;
      s.vy = 0;
      out[p.id] = { dx: s.dx, dy: s.dy };
      continue;
    }

    // Subtle coupling toward dragged pin so body responds organically when pulling an arm or head!
    let targetDx = 0;
    let targetDy = 0;
    if (dragState && p.role === 'root') {
      targetDx = dragState.dx * 0.22;
      targetDy = dragState.dy * 0.22;
    }

    const ax = -stiffness * (s.dx - targetDx) - damping * s.vx;
    const ay = -stiffness * (s.dy - targetDy) - damping * s.vy;
    s.vx += ax * dt;
    s.vy += ay * dt;
    s.dx += s.vx * dt;
    s.dy += s.vy * dt;

    // Clamp safely so mesh never explodes
    s.dx = Math.max(-0.45, Math.min(0.45, s.dx));
    s.dy = Math.max(-0.45, Math.min(0.45, s.dy));
    if (Math.hypot(s.dx, s.dy) < 0.0005 && Math.hypot(s.vx, s.vy) < 0.002) {
      s.dx = 0;
      s.dy = 0;
      s.vx = 0;
      s.vy = 0;
    }
    out[p.id] = { dx: s.dx, dy: s.dy };
  }

  return out;
}

// ============================================================================
// 5. RIGID-HEAD-PROTECTED ARTICULATED CEL MESH DEFORMER & RENDERER
// ============================================================================

/**
 * Pure articulated cel vertex deformer:
 * - Skull / Face region (v <= anatomy.headEndV) stays 100% RIGID (rotates cleanly around neck pivot!)
 * - Arms rotate along TRUE CIRCULAR ARCS around detected shoulder joints!
 * - Legs stride smoothly with grounded Stance + lifted Passing Pose arcs!
 * - Volume-preserving Squash & Stretch anchored strictly on anatomy.groundV (zero floor floating!)
 */
export function deformArticulatedVertex(
  u: number,
  v: number,
  anatomy: DrawingAnatomy,
  pose: ArticulatedCartoonPose,
  boilAmount = 0,
  boilTick = 0
): { x: number; y: number } {
  const cx = anatomy.centerX;
  const gV = anatomy.groundV;
  const neckV = anatomy.headEndV;

  // Smooth neck transition band so head never snaps or shears
  const headBlend =
    v <= neckV
      ? 1
      : v >= neckV + 0.075
        ? 0
        : 1 - (v - neckV) / 0.075;

  // 1. Ground-anchored volume-preserving Squash & Stretch
  let bx = cx + (u - cx) * pose.squashX + pose.hipShiftX;
  let by = gV - (gV - v) * pose.squashY;

  // 2. Torso forward lean & contrapposto chest counter-tilt around hip pivot
  const aboveHip = Math.max(0, (anatomy.hipV - v) / Math.max(0.2, anatomy.hipV));
  bx += Math.sin(pose.torsoLeanRad) * aboveHip * 0.17;
  by += (1 - Math.cos(pose.torsoLeanRad)) * aboveHip * 0.05;
  bx += Math.sin(pose.chestCounterRad) * aboveHip * 0.05;

  // 3. True Circular Shoulder-Pivot Arm Arcs (Disney Principle #7: Arcs!)
  if (v > neckV - 0.02 && v < anatomy.hipV + 0.08) {
    const vertMask = Math.sin(clamp01((v - (neckV - 0.02)) / Math.max(0.15, anatomy.hipV + 0.1 - neckV)) * Math.PI);
    if (u < anatomy.shoulderLeftX) {
      const reachW = clamp01((anatomy.shoulderLeftX - u) / Math.max(0.12, anatomy.shoulderLeftX));
      const w = Math.pow(reachW, 0.85) * vertMask;
      const angle = (pose.leftArmAngle + pose.leftArmLag * reachW) * w;
      const px = anatomy.shoulderLeftX;
      const py = anatomy.shoulderY;
      const rx = bx - px;
      const ry = by - py;
      const ca = Math.cos(angle);
      const sa = Math.sin(angle);
      bx = px + rx * ca - ry * sa;
      by = py + rx * sa + ry * ca;
    } else if (u > anatomy.shoulderRightX) {
      const reachW = clamp01((u - anatomy.shoulderRightX) / Math.max(0.12, 1 - anatomy.shoulderRightX));
      const w = Math.pow(reachW, 0.85) * vertMask;
      const angle = -(pose.rightArmAngle + pose.rightArmLag * reachW) * w;
      const px = anatomy.shoulderRightX;
      const py = anatomy.shoulderY;
      const rx = bx - px;
      const ry = by - py;
      const ca = Math.cos(angle);
      const sa = Math.sin(angle);
      bx = px + rx * ca - ry * sa;
      by = py + rx * sa + ry * ca;
    }
  }

  // 4. Articulated Legs: Ground-Locked Stance + Curved Passing-Pose Foot Lift!
  if (v > anatomy.hipV) {
    const legT = clamp01((v - anatomy.hipV) / Math.max(0.12, gV - anatomy.hipV));
    const smoothLeg = legT * legT * (3 - 2 * legT);
    const isLeft = u < cx;
    const stride = isLeft ? pose.leftLegStride : pose.rightLegStride;
    const lift = isLeft ? pose.leftFootLift : pose.rightFootLift;
    // Knee bends subtly forward during passing lift, foot glides horizontally along stride
    bx += stride * smoothLeg * 0.135;
    // Planted foot (lift === 0) stays STRICTLY on gV! Swinging foot arcs cleanly upward!
    by -= lift * smoothLeg * 0.095;
  }

  // 5. Rigid Skull Protection (rotates & translates cleanly around neck pivot — ZERO melting face!)
  if (headBlend > 0.001) {
    const neckWorldX =
      cx +
      pose.hipShiftX +
      Math.sin(pose.torsoLeanRad) * ((anatomy.hipV - neckV) / Math.max(0.2, anatomy.hipV)) * 0.17;
    const neckWorldY = gV - (gV - neckV) * pose.squashY + pose.headLagY;

    const hx = u - anatomy.neckX;
    const hy = v - neckV;
    const totalHeadRot = pose.headTiltRad + pose.torsoLeanRad * 0.45;
    const ch = Math.cos(totalHeadRot);
    const sh = Math.sin(totalHeadRot);
    // Subtle projective depth turn (center shifts slightly more than outer edge)
    const faceDepth = Math.sqrt(Math.max(0, 1 - Math.min(1, Math.abs(hx) / 0.24) ** 2));
    const headX = neckWorldX + (hx * ch - hy * sh) + pose.headTurnX * faceDepth * 0.032;
    const headY = neckWorldY + (hx * sh + hy * ch);

    bx = bx * (1 - headBlend) + headX * headBlend;
    by = by * (1 - headBlend) + headY * headBlend;
  }

  // 6. Vertical Jump/Hop Lift
  by -= pose.hipLiftY;

  // 7. Subtle 3-frame hand-drawn cel line-boil (never melts face!)
  if (boilAmount > 0.001) {
    const bScale = boilAmount * (1 - headBlend * 0.65) * 0.0038;
    const s1 = Math.sin(u * 41.7 + v * 29.3 + (boilTick % 3) * 17.9) * 43758.5453;
    const s2 = Math.sin(u * 63.1 + v * 19.7 + (boilTick % 3) * 31.3) * 43758.5453;
    bx += ((s1 - Math.floor(s1)) * 2 - 1) * bScale;
    by += ((s2 - Math.floor(s2)) * 2 - 1) * bScale;
  }

  return {
    x: Math.max(-0.35, Math.min(1.35, bx)),
    y: Math.max(-0.55, Math.min(1.25, by)),
  };
}

function drawSeamFreeTriangle(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  sx0: number, sy0: number, sx1: number, sy1: number, sx2: number, sy2: number,
  dx0: number, dy0: number, dx1: number, dy1: number, dx2: number, dy2: number
) {
  const denom = sx0 * (sy1 - sy2) + sx1 * (sy2 - sy0) + sx2 * (sy0 - sy1);
  if (Math.abs(denom) < 1e-4) return;

  // Sub-pixel 0.65px outward clip expansion eliminates hairline cracks between mesh triangles!
  const cx = (dx0 + dx1 + dx2) / 3;
  const cy = (dy0 + dy1 + dy2) / 3;
  const pad = (x: number, y: number): [number, number] => {
    const vx = x - cx;
    const vy = y - cy;
    const len = Math.hypot(vx, vy) || 1;
    return [x + (vx / len) * 0.65, y + (vy / len) * 0.65];
  };
  const [e0x, e0y] = pad(dx0, dy0);
  const [e1x, e1y] = pad(dx1, dy1);
  const [e2x, e2y] = pad(dx2, dy2);

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(e0x, e0y);
  ctx.lineTo(e1x, e1y);
  ctx.lineTo(e2x, e2y);
  ctx.closePath();
  ctx.clip();

  const a = (dx0 * (sy1 - sy2) + dx1 * (sy2 - sy0) + dx2 * (sy0 - sy1)) / denom;
  const b = (dy0 * (sy1 - sy2) + dy1 * (sy2 - sy0) + dy2 * (sy0 - sy1)) / denom;
  const c = (dx0 * (sx2 - sx1) + dx1 * (sx0 - sx2) + dx2 * (sx1 - sx0)) / denom;
  const d = (dy0 * (sx2 - sx1) + dy1 * (sx0 - sx2) + dy2 * (sx1 - sx0)) / denom;
  const e =
    (dx0 * (sx1 * sy2 - sx2 * sy1) + dx1 * (sx2 * sy0 - sx0 * sy2) + dx2 * (sx0 * sy1 - sx1 * sy0)) /
    denom;
  const f =
    (dy0 * (sx1 * sy2 - sx2 * sy1) + dy1 * (sx2 * sy0 - sx0 * sy2) + dy2 * (sx0 * sy1 - sx1 * sy0)) /
    denom;

  ctx.transform(a, b, c, d, e, f);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

/**
 * Renders ANY user drawing with 14x14 articulated cel mesh deformation and returns
 * live screen-space anchor coordinates (neck, mouth, left/right feet) for scarf, mouth, and ripples!
 */
export function renderArticulatedCharacter(
  ctx: CanvasRenderingContext2D,
  actor: HTMLCanvasElement,
  anatomy: DrawingAnatomy,
  pose: ArticulatedCartoonPose,
  bounds: { x: number; y: number; w: number; h: number },
  opts?: { cols?: number; rows?: number; boilAmount?: number; boilTick?: number }
): {
  neckScreen: { x: number; y: number };
  mouthScreen: { x: number; y: number };
  footLeftScreen: { x: number; y: number };
  footRightScreen: { x: number; y: number };
} {
  const cols = opts?.cols ?? 12;
  const rows = opts?.rows ?? 12;
  const boilAmt = opts?.boilAmount ?? 0.35;
  const boilTick = opts?.boilTick ?? 0;

  const verts: { x: number; y: number }[] = new Array((cols + 1) * (rows + 1));
  for (let r = 0; r <= rows; r++) {
    const v = r / rows;
    for (let c = 0; c <= cols; c++) {
      const u = c / cols;
      const pt = deformArticulatedVertex(u, v, anatomy, pose, boilAmt, boilTick);
      verts[r * (cols + 1) + c] = {
        x: bounds.x + pt.x * bounds.w,
        y: bounds.y + pt.y * bounds.h,
      };
    }
  }

  const aw = actor.width;
  const ah = actor.height;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i00 = r * (cols + 1) + c;
      const i10 = i00 + 1;
      const i01 = i00 + (cols + 1);
      const i11 = i01 + 1;
      const p00 = verts[i00];
      const p10 = verts[i10];
      const p01 = verts[i01];
      const p11 = verts[i11];
      const su0 = (c / cols) * aw;
      const sv0 = (r / rows) * ah;
      const su1 = ((c + 1) / cols) * aw;
      const sv1 = ((r + 1) / rows) * ah;
      drawSeamFreeTriangle(ctx, actor, su0, sv0, su1, sv0, su0, sv1, p00.x, p00.y, p10.x, p10.y, p01.x, p01.y);
      drawSeamFreeTriangle(ctx, actor, su1, sv0, su1, sv1, su0, sv1, p10.x, p10.y, p11.x, p11.y, p01.x, p01.y);
    }
  }

  const mapAnchor = (u: number, v: number) => {
    const p = deformArticulatedVertex(u, v, anatomy, pose, 0, boilTick);
    return { x: bounds.x + p.x * bounds.w, y: bounds.y + p.y * bounds.h };
  };

  return {
    neckScreen: mapAnchor(anatomy.neckX, anatomy.neckY),
    mouthScreen: mapAnchor(anatomy.mouthX, anatomy.mouthY),
    footLeftScreen: mapAnchor(anatomy.footLeftX, anatomy.groundV),
    footRightScreen: mapAnchor(anatomy.footRightX, anatomy.groundV),
  };
}

/** Draws an expressive 6-shape hand-drawn cartoon mouth matching real animation acting */
export function drawCartoonMouth(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale: number,
  viseme: VisemeId,
  mouthOpen: number,
  tiltRad: number
) {
  if (viseme === 'closed' || mouthOpen < 0.06) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(tiltRad);
  const s = Math.max(0.7, Math.min(1.45, scale));

  let rx = 11 * s;
  let ry = 4 * s;
  let showTeeth = false;
  let showTongue = false;

  if (viseme === 'AA') {
    rx = (13 + mouthOpen * 7) * s;
    ry = (10 + mouthOpen * 9) * s;
    showTeeth = true;
    showTongue = true;
  } else if (viseme === 'OH') {
    rx = (10 + mouthOpen * 5) * s;
    ry = (11 + mouthOpen * 7) * s;
    showTongue = true;
  } else if (viseme === 'OO') {
    rx = (7 + mouthOpen * 3) * s;
    ry = (7.5 + mouthOpen * 4) * s;
  } else if (viseme === 'EE') {
    rx = (15 + mouthOpen * 6) * s;
    ry = (5.5 + mouthOpen * 4) * s;
    showTeeth = true;
  } else if (viseme === 'FV') {
    rx = 12 * s;
    ry = 3.8 * s;
    showTeeth = true;
  }

  // Crisp studio outline halo so mouth reads cleanly on dark OR light sketches
  ctx.fillStyle = '#1E1614';
  ctx.strokeStyle = '#FAF6EE';
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.save();
  ctx.clip();
  if (showTeeth) {
    ctx.fillStyle = '#FFFDF7';
    ctx.fillRect(-rx, -ry, rx * 2, ry * 0.48);
  }
  if (showTongue) {
    ctx.fillStyle = '#E54D2E';
    ctx.beginPath();
    ctx.ellipse(0, ry * 0.65, rx * 0.68, ry * 0.52, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  ctx.strokeStyle = '#1C1917';
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

// ============================================================================
// 6. MULTI-LAYER 2-BONE IK CHARACTER RENDERER (TRUE BENDING KNEES & ELBOWS!)
// ============================================================================

/**
 * Renders a single independent limb cutout along a live 2-Bone IK chain (root -> mid -> end)
 * using a smooth 5x7 curved micro-mesh across its exact bounding box so knees & elbows bend
 * organically with ZERO rubber webbing across empty air!
 */
/**
 * Evaluates a single vertex along a 3-stage continuous skinned limb (Torso -> Upper Bone -> Lower Bone).
 * Guarantees ZERO shoulder/hip detachment because all pixels at proj <= 0 lock 100% identically
 * to the live torso transform and smoothly transition into the 2-Bone IK upper & lower bones!
 */
export function evaluateContinuousLimbPoint(
  u: number,
  v: number,
  mapTorsoPoint: (u: number, v: number) => Vec2,
  restRoot: Vec2,
  restMid: Vec2,
  restEnd: Vec2,
  liveRoot: Vec2,
  liveMid: Vec2,
  liveEnd: Vec2,
  actorW: number,
  actorH: number
): Vec2 {
  const rrX = restRoot.x * actorW;
  const rrY = restRoot.y * actorH;
  const rmX = restMid.x * actorW;
  const rmY = restMid.y * actorH;
  const reX = restEnd.x * actorW;
  const reY = restEnd.y * actorH;

  const restVecX = reX - rrX;
  const restVecY = reY - rrY;
  const restTotalLen = Math.hypot(restVecX, restVecY) || 1;
  const restAxisX = restVecX / restTotalLen;
  const restAxisY = restVecY / restTotalLen;

  const restUpperAng = Math.atan2(rmY - rrY, rmX - rrX);
  const restLowerAng = Math.atan2(reY - rmY, reX - rmX);
  const liveUpperAng = Math.atan2(liveMid.y - liveRoot.y, liveMid.x - liveRoot.x);
  const liveLowerAng = Math.atan2(liveEnd.y - liveMid.y, liveEnd.x - liveMid.x);

  const dUpper = wrapAngleDelta(liveUpperAng - restUpperAng);
  const dLower = wrapAngleDelta(liveLowerAng - restLowerAng);
  const cu = Math.cos(dUpper);
  const su = Math.sin(dUpper);
  const cl = Math.cos(dLower);
  const sl = Math.sin(dLower);

  const px = u * actorW;
  const py = v * actorH;
  const proj = ((px - rrX) * restAxisX + (py - rrY) * restAxisY) / restTotalLen;

  // Stage 1 -> Stage 2: Smooth continuous weld from Torso socket (proj <= 0) into Upper IK Bone (proj >= 0.24)
  const wUpperRaw = clamp01(proj / 0.24);
  const wUpper = wUpperRaw * wUpperRaw * (3 - 2 * wUpperRaw);

  // Stage 2 -> Stage 3: Smooth Disney curved bend across Elbow / Knee hinge (proj 0.36..0.68)
  const wLowerRaw = clamp01((proj - 0.36) / 0.32);
  const wLower = wLowerRaw * wLowerRaw * (3 - 2 * wLowerRaw);

  const ux = px - rrX;
  const uy = py - rrY;
  const pUpX = liveRoot.x + (ux * cu - uy * su);
  const pUpY = liveRoot.y + (ux * su + uy * cu);

  const lx = px - rmX;
  const ly = py - rmY;
  const pLowX = liveMid.x + (lx * cl - ly * sl);
  const pLowY = liveMid.y + (lx * sl + ly * cl);

  const limbX = pUpX * (1 - wLower) + pLowX * wLower;
  const limbY = pUpY * (1 - wLower) + pLowY * wLower;

  if (wUpper >= 0.999) {
    return { x: limbX, y: limbY };
  }
  const pTorso = mapTorsoPoint(u, v);
  return {
    x: pTorso.x * (1 - wUpper) + limbX * wUpper,
    y: pTorso.y * (1 - wUpper) + limbY * wUpper,
  };
}

function wrapAngleDelta(d: number): number {
  return Math.atan2(Math.sin(d), Math.cos(d));
}

function renderTwoBoneLimb(
  ctx: CanvasRenderingContext2D,
  part: SegmentedLimbPart,
  texCanvas: HTMLCanvasElement,
  mapTorsoPoint: (u: number, v: number) => Vec2,
  restRoot: Vec2,
  restMid: Vec2,
  restEnd: Vec2,
  liveRoot: Vec2,
  liveMid: Vec2,
  liveEnd: Vec2,
  actorW: number,
  actorH: number
) {
  if (part.pixelCount < 4) return;
  const sw = texCanvas.width;
  const sh = texCanvas.height;

  const su0 = Math.max(0, part.u0 - 0.03);
  const sv0 = Math.max(0, part.v0 - 0.03);
  const su1 = Math.min(1, part.u1 + 0.03);
  const sv1 = Math.min(1, part.v1 + 0.03);

  // Precompute invariants for hot-loop 5x7 curved mesh evaluation
  const rrX = restRoot.x * actorW;
  const rrY = restRoot.y * actorH;
  const rmX = restMid.x * actorW;
  const rmY = restMid.y * actorH;
  const reX = restEnd.x * actorW;
  const reY = restEnd.y * actorH;

  const restVecX = reX - rrX;
  const restVecY = reY - rrY;
  const restTotalLen = Math.hypot(restVecX, restVecY) || 1;
  const restAxisX = restVecX / restTotalLen;
  const restAxisY = restVecY / restTotalLen;

  const restUpperAng = Math.atan2(rmY - rrY, rmX - rrX);
  const restLowerAng = Math.atan2(reY - rmY, reX - rmX);
  const liveUpperAng = Math.atan2(liveMid.y - liveRoot.y, liveMid.x - liveRoot.x);
  const liveLowerAng = Math.atan2(liveEnd.y - liveMid.y, liveEnd.x - liveMid.x);

  const dUpper = wrapAngleDelta(liveUpperAng - restUpperAng);
  const dLower = wrapAngleDelta(liveLowerAng - restLowerAng);
  const cu = Math.cos(dUpper);
  const su = Math.sin(dUpper);
  const cl = Math.cos(dLower);
  const sl = Math.sin(dLower);

  const mapPt = (u: number, v: number): Vec2 => {
    const px = u * actorW;
    const py = v * actorH;
    const proj = ((px - rrX) * restAxisX + (py - rrY) * restAxisY) / restTotalLen;

    const wUpperRaw = clamp01(proj / 0.24);
    const wUpper = wUpperRaw * wUpperRaw * (3 - 2 * wUpperRaw);

    const wLowerRaw = clamp01((proj - 0.36) / 0.32);
    const wLower = wLowerRaw * wLowerRaw * (3 - 2 * wLowerRaw);

    const ux = px - rrX;
    const uy = py - rrY;
    const pUpX = liveRoot.x + (ux * cu - uy * su);
    const pUpY = liveRoot.y + (ux * su + uy * cu);

    const lx = px - rmX;
    const ly = py - rmY;
    const pLowX = liveMid.x + (lx * cl - ly * sl);
    const pLowY = liveMid.y + (lx * sl + ly * cl);

    const limbX = pUpX * (1 - wLower) + pLowX * wLower;
    const limbY = pUpY * (1 - wLower) + pLowY * wLower;

    if (wUpper >= 0.999) return { x: limbX, y: limbY };
    const pTorso = mapTorsoPoint(u, v);
    return {
      x: pTorso.x * (1 - wUpper) + limbX * wUpper,
      y: pTorso.y * (1 - wUpper) + limbY * wUpper,
    };
  };

  const cols = 4;
  const rows = 6;
  const verts: Vec2[] = new Array((cols + 1) * (rows + 1));
  for (let r = 0; r <= rows; r++) {
    const v = sv0 + (r / rows) * (sv1 - sv0);
    for (let c = 0; c <= cols; c++) {
      const u = su0 + (c / cols) * (su1 - su0);
      verts[r * (cols + 1) + c] = mapPt(u, v);
    }
  }

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i00 = r * (cols + 1) + c;
      const i10 = i00 + 1;
      const i01 = i00 + (cols + 1);
      const i11 = i01 + 1;
      const p00 = verts[i00];
      const p10 = verts[i10];
      const p01 = verts[i01];
      const p11 = verts[i11];
      const x0 = (su0 + (c / cols) * (su1 - su0)) * sw;
      const y0 = (sv0 + (r / rows) * (sv1 - sv0)) * sh;
      const x1 = (su0 + ((c + 1) / cols) * (su1 - su0)) * sw;
      const y1 = (sv0 + ((r + 1) / rows) * (sv1 - sv0)) * sh;
      drawSeamFreeTriangle(ctx, texCanvas, x0, y0, x1, y0, x0, y1, p00.x, p00.y, p10.x, p10.y, p01.x, p01.y);
      drawSeamFreeTriangle(ctx, texCanvas, x1, y0, x1, y1, x0, y1, p10.x, p10.y, p11.x, p11.y, p01.x, p01.y);
    }
  }
}

// Module-scoped reusable scratch canvases & deformed vertex buffer for zero-GC 60 FPS skinning!
let _actorCompCanvas: HTMLCanvasElement | null = null;
let _actorHaloCanvas: HTMLCanvasElement | null = null;
let _skinnedPosBuf = new Float32Array(2048);

function getUnifiedScratchCanvases(cw: number, ch: number): {
  comp: HTMLCanvasElement;
  halo: HTMLCanvasElement;
} | null {
  if (typeof document === 'undefined') return null;
  if (!_actorCompCanvas) _actorCompCanvas = document.createElement('canvas');
  if (!_actorHaloCanvas) _actorHaloCanvas = document.createElement('canvas');
  if (_actorCompCanvas.width !== cw || _actorCompCanvas.height !== ch) {
    _actorCompCanvas.width = cw;
    _actorCompCanvas.height = ch;
  }
  if (_actorHaloCanvas.width !== cw || _actorHaloCanvas.height !== ch) {
    _actorHaloCanvas.width = cw;
    _actorHaloCanvas.height = ch;
  }
  return { comp: _actorCompCanvas, halo: _actorHaloCanvas };
}

/** Draws subtle hand-drawn eyelid blink arcs right over the character's detected eyes! */
function drawNaturalBlinkEyelids(
  ctx: CanvasRenderingContext2D,
  pack: RiggedCharacterPack,
  blink: number,
  headMap: (u: number, v: number) => Vec2,
  actorW: number,
  headRot: number
) {
  if (!pack.eyes.found || blink < 0.14) return;
  const rPx = Math.max(4, pack.eyes.radius * actorW * 1.45);
  for (const eye of [pack.eyes.left, pack.eyes.right]) {
    const pt = headMap(eye.x, eye.y);
    ctx.save();
    ctx.translate(pt.x, pt.y);
    ctx.rotate(headRot);
    // Warm paper eyelid cover closing over the drawn dot
    ctx.fillStyle = pack.faceFillColor;
    ctx.beginPath();
    ctx.ellipse(0, 0, rPx * 1.1, rPx * Math.min(1.15, blink * 1.25), 0, 0, Math.PI * 2);
    ctx.fill();
    // Friendly closed-eye curved ink lash
    if (blink > 0.45) {
      ctx.strokeStyle = pack.inkColor || '#1C1917';
      ctx.lineWidth = Math.max(1.8, rPx * 0.28);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(0, -rPx * 0.1, rPx * 0.72, 0.2, Math.PI - 0.2);
      ctx.stroke();
    }
    ctx.restore();
  }
}

/**
 * Full 6-Emotion Cartoon Facial Acting + 3-Frame Eye-Lead Gaze + Organic Blinking.
 * Locks strictly onto detected eyes (`pack.eyes` or anatomical eye anchors) and `headMap`
 * so EVERY emotion button (neutral, happy, angry, tired, determined, surprised) produces
 * genuine, readable studio cartoon acting without harming the user's drawn art!
 */
export function drawCharacterFacialActing(
  ctx: CanvasRenderingContext2D,
  pack: RiggedCharacterPack,
  opts: {
    blink: number;
    emotion?: FilmEmotionId;
    eyeLeadX?: number;
    headMap: (u: number, v: number) => Vec2;
    actorW: number;
    headRot: number;
    mouthOpen?: number;
  }
) {
  const { blink, emotion = 'neutral', eyeLeadX = 0, headMap, actorW, headRot, mouthOpen = 0 } = opts;
  const eyes = pack.eyes;
  const rPx = Math.max(4, eyes.radius * actorW * 1.38);
  const ink = pack.inkColor || '#1C1917';
  const leftPt = headMap(eyes.left.x, eyes.left.y);
  const rightPt = headMap(eyes.right.x, eyes.right.y);

  // 1. Subtle 3-Frame Eye-Lead Catchlight / Gaze Glint inside detected eyes when not blinking
  if (eyes.found && blink < 0.35 && Math.abs(eyeLeadX) > 0.08) {
    const shift = Math.max(-1, Math.min(1, eyeLeadX)) * rPx * 0.42;
    for (const pt of [leftPt, rightPt]) {
      ctx.save();
      ctx.translate(pt.x, pt.y);
      ctx.rotate(headRot);
      ctx.fillStyle = 'rgba(255, 252, 240, 0.88)';
      ctx.beginPath();
      ctx.arc(shift, -rPx * 0.24, Math.max(1.4, rPx * 0.24), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // 2. Natural Eye Blink (always works when eyes detected; soft fallback if neutral & found)
  if (blink >= 0.14) {
    drawNaturalBlinkEyelids(ctx, pack, blink, headMap, actorW, headRot);
  }

  // 3. Expressive Cartoon Emotions (Brows, Heavy Lids, Blush, Joy Squints & Surprise Accents!)
  if (emotion === 'neutral') return;

  const browOffsetY = -rPx * 1.38;
  const browHalfW = rPx * 1.05;
  const browLineW = Math.max(2, rPx * 0.34);

  if (emotion === 'tired') {
    // Heavy half-closed upper eyelids + soft under-eye fatigue arcs
    for (const pt of [leftPt, rightPt]) {
      ctx.save();
      ctx.translate(pt.x, pt.y);
      ctx.rotate(headRot);
      // Droopy upper lid mask matching character's sampled face color
      ctx.fillStyle = pack.faceFillColor;
      ctx.beginPath();
      ctx.rect(-rPx * 1.25, -rPx * 1.2, rPx * 2.5, rPx * 1.15);
      ctx.fill();
      // Heavy lid line
      ctx.strokeStyle = ink;
      ctx.lineWidth = Math.max(1.8, rPx * 0.26);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-rPx * 1.05, -rPx * 0.05);
      ctx.quadraticCurveTo(0, rPx * 0.12, rPx * 1.05, -rPx * 0.05);
      ctx.stroke();
      // Subtle under-eye tired bag
      ctx.strokeStyle = 'rgba(72, 62, 58, 0.42)';
      ctx.lineWidth = Math.max(1.2, rPx * 0.16);
      ctx.beginPath();
      ctx.arc(0, rPx * 0.65, rPx * 0.72, 0.25, Math.PI - 0.25);
      ctx.stroke();
      ctx.restore();
    }
    return;
  }

  if (emotion === 'angry') {
    // Sharp V-angled furrowed studio cartoon eyebrows + subtle brow tension crease
    const pairs: { pt: Vec2; side: -1 | 1 }[] = [
      { pt: leftPt, side: -1 },
      { pt: rightPt, side: 1 },
    ];
    for (const { pt, side } of pairs) {
      ctx.save();
      ctx.translate(pt.x, pt.y);
      ctx.rotate(headRot);
      // Slight angled upper lid trim for fierce squint
      ctx.fillStyle = pack.faceFillColor;
      ctx.beginPath();
      ctx.moveTo(-rPx * 1.25, -rPx * 1.3);
      ctx.lineTo(rPx * 1.25, -rPx * 1.3);
      ctx.lineTo(rPx * 1.25, side < 0 ? -rPx * 0.1 : -rPx * 0.75);
      ctx.lineTo(-rPx * 1.25, side < 0 ? -rPx * 0.75 : -rPx * 0.1);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = ink;
      ctx.lineWidth = browLineW * 1.1;
      ctx.lineCap = 'round';
      ctx.beginPath();
      // Slants sharply downward toward the center nose bridge!
      ctx.moveTo(-browHalfW, browOffsetY + (side < 0 ? -rPx * 0.25 : rPx * 0.52));
      ctx.lineTo(browHalfW, browOffsetY + (side < 0 ? rPx * 0.52 : -rPx * 0.25));
      ctx.stroke();
      ctx.restore();
    }
    return;
  }

  if (emotion === 'determined') {
    // Focused heroic angled brows (less extreme than angry, crisp forward resolve!)
    const pairs: { pt: Vec2; side: -1 | 1 }[] = [
      { pt: leftPt, side: -1 },
      { pt: rightPt, side: 1 },
    ];
    for (const { pt, side } of pairs) {
      ctx.save();
      ctx.translate(pt.x, pt.y);
      ctx.rotate(headRot);
      ctx.strokeStyle = ink;
      ctx.lineWidth = browLineW;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-browHalfW, browOffsetY + (side < 0 ? -rPx * 0.12 : rPx * 0.34));
      ctx.lineTo(browHalfW, browOffsetY + (side < 0 ? rPx * 0.34 : -rPx * 0.12));
      ctx.stroke();
      ctx.restore();
    }
    return;
  }

  if (emotion === 'happy') {
    // Warm rosy cheek blushes + joyful raised curved brows + gentle resting smile if silent
    for (const pt of [leftPt, rightPt]) {
      ctx.save();
      ctx.translate(pt.x, pt.y);
      ctx.rotate(headRot);
      // Warm coral cartoon cheek blush
      ctx.fillStyle = 'rgba(235, 108, 92, 0.34)';
      ctx.beginPath();
      ctx.ellipse(0, rPx * 1.45, rPx * 1.15, rPx * 0.58, 0, 0, Math.PI * 2);
      ctx.fill();
      // Cheerful arched eyebrows
      ctx.strokeStyle = ink;
      ctx.lineWidth = Math.max(1.8, browLineW * 0.82);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(0, browOffsetY + rPx * 0.55, browHalfW * 0.92, Math.PI + 0.45, -0.45);
      ctx.stroke();
      ctx.restore();
    }
    if (mouthOpen < 0.08 && !pack.hasDrawnMouth) {
      const mPt = headMap(pack.anatomy.mouthX, pack.anatomy.mouthY);
      ctx.save();
      ctx.translate(mPt.x, mPt.y);
      ctx.rotate(headRot);
      ctx.strokeStyle = ink;
      ctx.lineWidth = Math.max(2, rPx * 0.3);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(0, -rPx * 0.25, rPx * 1.05, 0.32, Math.PI - 0.32);
      ctx.stroke();
      ctx.restore();
    }
    return;
  }

  if (emotion === 'surprised') {
    // High raised surprised brows + bright eye sparkle + small resting 'O' mouth when silent (if not already drawn!)
    for (const pt of [leftPt, rightPt]) {
      ctx.save();
      ctx.translate(pt.x, pt.y);
      ctx.rotate(headRot);
      ctx.strokeStyle = ink;
      ctx.lineWidth = Math.max(1.8, browLineW * 0.85);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(0, browOffsetY - rPx * 0.1, browHalfW * 0.9, Math.PI + 0.35, -0.35);
      ctx.stroke();
      // Crisp bright surprise glint
      ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
      ctx.beginPath();
      ctx.arc(-rPx * 0.25, -rPx * 0.25, Math.max(1.5, rPx * 0.26), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    if (mouthOpen < 0.08 && !pack.hasDrawnMouth) {
      const mPt = headMap(pack.anatomy.mouthX, pack.anatomy.mouthY);
      ctx.save();
      ctx.translate(mPt.x, mPt.y);
      ctx.rotate(headRot);
      ctx.fillStyle = '#7E1D15';
      ctx.strokeStyle = ink;
      ctx.lineWidth = Math.max(1.8, rPx * 0.26);
      ctx.beginPath();
      ctx.ellipse(0, 0, rPx * 0.58, rPx * 0.76, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }
}

export type StorybookWorldId = 'rainy' | 'meadow' | 'space' | 'concert' | 'escape';

/**
 * Evaluates bespoke 12-Principles acting poses tailored to all 5 Storybook Worlds!
 * - rainy: classic Richard Williams puddle walk + lightning startle
 * - meadow: buoyant Studio Ghibli hilltop stroll looking around at butterflies/train
 * - space: dreamy zero-gravity weightless floating with slow sinusoidal limb drift
 * - concert: high-energy 120 BPM beat-synced concert groove with raised cheering arms
 * - escape: dramatic forward-leaning cartoon panic sprint with periodic boulder-dodge leaps!
 */
export function evaluateCartoonWorldPose(
  world: StorybookWorldId,
  tSec: number,
  anatomy: DrawingAnatomy,
  cadenceFps: 12 | 24 = 12,
  mood: CartoonMoodId = 'joy',
  startle = 0
): ArticulatedCartoonPose {
  if (world === 'rainy') {
    return evaluateCartoonRainWalkPose(tSec, anatomy, cadenceFps, mood, startle);
  }

  const t = Math.floor(tSec * cadenceFps) / cadenceFps;

  if (world === 'meadow') {
    const base = evaluateCartoonRainWalkPose(tSec * 0.92, anatomy, cadenceFps, mood, 0);
    return {
      ...base,
      headTiltRad: base.headTiltRad + Math.sin(t * 1.4) * 0.08 - 0.04,
      leftArmAngle: base.leftArmAngle + 0.14 * Math.sin(t * 2.1),
      rightArmAngle: base.rightArmAngle - 0.14 * Math.sin(t * 2.1),
    };
  }

  if (world === 'space') {
    const floatY = 0.22 + Math.sin(t * 1.35) * 0.095;
    const roll = Math.sin(t * 0.85) * 0.24;
    const blinkCycle = (t + 0.7) % 4.6;
    const blink = blinkCycle < 0.14 ? Math.sin((blinkCycle / 0.14) * Math.PI) : 0;
    const speedMult = mood === 'sprint' ? 1.5 : mood === 'sneak' ? 0.6 : 1;
    return {
      hipLiftY: floatY,
      hipShiftX: Math.sin(t * 0.72) * 0.035,
      squashX: 1 + Math.sin(t * 1.35 + 1.2) * 0.025,
      squashY: 1 / (1 + Math.sin(t * 1.35 + 1.2) * 0.025),
      torsoLeanRad: roll,
      chestCounterRad: Math.sin(t * 1.1) * 0.08,
      headTiltRad: -roll * 0.4 + Math.sin(t * 1.6) * 0.12,
      headTurnX: Math.sin(t * 0.9) * 0.65,
      headLagY: Math.cos(t * 1.35) * 0.012,
      leftArmAngle: 0.45 + Math.sin(t * 1.8 * speedMult) * 0.42,
      rightArmAngle: 0.45 + Math.cos(t * 1.7 * speedMult) * 0.42,
      leftArmLag: Math.cos(t * 1.8 * speedMult) * 0.22,
      rightArmLag: -Math.sin(t * 1.7 * speedMult) * 0.22,
      leftLegStride: Math.sin(t * 1.4 * speedMult) * 0.48,
      rightLegStride: Math.sin(t * 1.4 * speedMult + Math.PI) * 0.48,
      leftFootLift: 0.55 + Math.sin(t * 1.5 * speedMult) * 0.28,
      rightFootLift: 0.55 + Math.cos(t * 1.5 * speedMult) * 0.28,
      blink,
      mouthOpen: Math.sin(t * 1.1) > 0.78 ? 0.35 : 0,
      viseme: Math.sin(t * 1.1) > 0.78 ? 'OO' : 'closed',
      facing: 1,
      footContact: false,
      contactSide: 0,
    };
  }

  if (world === 'concert') {
    const beat = (t * 2.0) % 1; // crisp 120 BPM concert groove!
    const bounce = Math.abs(Math.sin(t * Math.PI * 2.0));
    const impact = beat < 0.16 ? 1 - beat / 0.16 : 0;
    const sqY = 1 - impact * 0.14 + bounce * 0.06;
    const sqX = 1 / sqY;
    const cheer = Math.sin(t * Math.PI * 1.0);
    const blinkCycle = (t + 1.2) % 3.8;
    const blink = blinkCycle < 0.13 ? Math.sin((blinkCycle / 0.13) * Math.PI) : 0;
    const sway = mood === 'cool' ? 0.06 : mood === 'sprint' ? 0.16 : 0.11;
    const sing = Math.sin(t * 4.8) > 0.35 ? 0.52 : 0;
    return {
      hipLiftY: Math.pow(bounce, 1.35) * (mood === 'cool' ? 0.045 : 0.105),
      hipShiftX: Math.sin(t * Math.PI) * 0.04,
      squashX: sqX,
      squashY: sqY,
      torsoLeanRad: Math.sin(t * Math.PI) * sway,
      chestCounterRad: -Math.sin(t * Math.PI) * 0.09,
      headTiltRad: Math.sin(t * Math.PI * 2) * 0.13,
      headTurnX: Math.sin(t * Math.PI) * 0.45,
      headLagY: -Math.cos(t * Math.PI * 2) * 0.015,
      leftArmAngle: 0.52 + cheer * 0.32,
      rightArmAngle: 0.52 - cheer * 0.32,
      leftArmLag: Math.cos(t * Math.PI) * 0.18,
      rightArmLag: -Math.cos(t * Math.PI) * 0.18,
      leftLegStride: Math.sin(t * Math.PI) * 0.22,
      rightLegStride: -Math.sin(t * Math.PI) * 0.22,
      leftFootLift: beat > 0.5 ? Math.sin((beat - 0.5) * Math.PI * 2) * 0.38 : 0,
      rightFootLift: beat <= 0.5 ? Math.sin(beat * Math.PI * 2) * 0.38 : 0,
      blink,
      mouthOpen: sing,
      viseme: sing > 0 ? (Math.sin(t * 2.5) > 0 ? 'AA' : 'OH') : 'closed',
      facing: 1,
      footContact: beat < 0.08 || (beat >= 0.5 && beat < 0.58),
      contactSide: beat < 0.5 ? -1 : 1,
    };
  }

  // 'escape': dramatic turbo-sprint from rolling cartoon boulder with heroic dodge hops!
  const sprintBase = evaluateCartoonRainWalkPose(tSec * 1.18, anatomy, cadenceFps, 'sprint', 0);
  const hopPhase = (tSec % 2.9) / 2.9;
  const dodgeHop = hopPhase > 0.72 && hopPhase < 0.94 ? Math.sin(((hopPhase - 0.72) / 0.22) * Math.PI) : 0;
  return {
    ...sprintBase,
    hipLiftY: sprintBase.hipLiftY + dodgeHop * 0.17,
    torsoLeanRad: sprintBase.torsoLeanRad + 0.06,
    headTurnX: hopPhase > 0.45 && hopPhase < 0.65 ? -0.7 : 0.35, // nervous glance back at boulder!
    leftArmAngle: sprintBase.leftArmAngle + dodgeHop * 0.45,
    rightArmAngle: sprintBase.rightArmAngle + dodgeHop * 0.45,
    mouthOpen: dodgeHop > 0.2 || (hopPhase > 0.45 && hopPhase < 0.65) ? 0.62 : 0.18,
    viseme: dodgeHop > 0.2 ? 'OH' : 'EE',
  };
}

export interface CharacterLiveAnchors {
  neckScreen: Vec2;
  mouthScreen: Vec2;
  footLeftScreen: Vec2;
  footRightScreen: Vec2;
  headTopScreen: Vec2;
  handLeftScreen: Vec2;
  handRightScreen: Vec2;
  pelvisScreen: Vec2;
}

export interface RiggedIKOverrides {
  handLeft?: Vec2 | null;
  handRight?: Vec2 | null;
  footLeft?: Vec2 | null;
  footRight?: Vec2 | null;
  headOffset?: Vec2 | null;
}

/**
 * Crown-Jewel ZERO-KOPMA Multi-Layer 2-Bone IK Character Renderer!
 * Uses Continuous 3-Stage Torso->Upper->Lower Skinning so shoulders, armpits, hips & neck
 * NEVER tear or detach at any angle, plus Unified Outer-Perimeter-Only Paper Cutout Halo
 * on dark stages (ZERO internal white seam cuts across joints!), true horizontal facing mirror,
 * full 6-emotion facial acting + 3-frame eye-lead + organic blinking, and direct IK pin targets!
 */
export function renderMultiLayerRiggedCharacter(
  ctx: CanvasRenderingContext2D,
  pack: RiggedCharacterPack,
  pose: ArticulatedCartoonPose,
  bounds: { x: number; y: number; w: number; h: number },
  opts?: {
    boilTick?: number;
    nightLampPos?: Vec2 | null;
    smearVelX?: number;
    isReflection?: boolean;
    emotion?: FilmEmotionId;
    eyeLeadX?: number;
    ikOverrides?: RiggedIKOverrides | null;
    klausLight?: KlausLightConfig | null;
    forceCpuRaster?: boolean;
    universalAction?: UniversalActionId;
    yawDeg?: number;
  }
): CharacterLiveAnchors {
  const { anatomy } = pack;
  const W = bounds.w;
  const H = bounds.h;
  const boilTick = opts?.boilTick ?? 0;
  const isNight = Boolean(opts?.nightLampPos);
  const facingLeft = pose.facing < 0;
  const emotion = opts?.emotion ?? 'neutral';
  const rawEyeLead = opts?.eyeLeadX ?? 0;

  const pelvisRestX = bounds.x + anatomy.centerX * W;
  const pelvisX = pelvisRestX + pose.hipShiftX * W;
  const toWorld = (p: Vec2): Vec2 => (facingLeft ? { x: 2 * pelvisX - p.x, y: p.y } : p);

  // V4 Universal 7-Creature Real-Bone CoR Renderer (Quadruped 19-bone, Avian 16-bone, Aquatic 11-bone,
  // Serpentine 16-bone, Biped-Tailed Dino 24-bone, Amorphous/Vehicle 9-bone) — GPU 60 FPS + CPU Scanline 30 FPS!
  if (!pack.useMultiPart) {
    if (
      pack.skinnedMesh &&
      pack.skinnedMesh.creatureClass &&
      pack.skinnedMesh.creatureClass !== 'humanoid' &&
      pack.skinnedMesh.bones.length >= 6
    ) {
      const cMesh = pack.skinnedMesh;
      const cls = cMesh.creatureClass ?? 'humanoid';
      const phaseSec = boilTick * 0.165;
      const action: UniversalActionId =
        opts?.universalAction ?? UNIVERSAL_CREATURE_CATALOG[cls].defaultAction;
      const useGpuSkin = !opts?.forceCpuRaster && !probeSoftwareRenderer();
      const ev = evaluateUniversalCreatureMesh(
        cMesh,
        bounds,
        {
          timeSec: phaseSec,
          action,
          facingLeft,
          headTiltRad: pose.headTiltRad,
          mouthOpen: pose.mouthOpen,
          yawDeg: opts?.yawDeg ?? 0,
        },
        useGpuSkin
      );
      const renderOpts = {
        nightHalo: isNight,
        isReflection: opts?.isReflection,
        mirroredOrder: facingLeft,
        mirrorAxisX: facingLeft ? pelvisX : null,
        klausLight: opts?.klausLight,
        forceCpuRaster: opts?.forceCpuRaster,
      };
      let cDrawn = false;
      if (useGpuSkin && ev.gpuBones.length > 0) {
        cDrawn = renderConformingMeshWebGLGpuSkinned(
          ctx,
          pack.filledCanvas,
          cMesh,
          ev.gpuBones,
          bounds,
          ev.bbox,
          renderOpts
        );
        if (!cDrawn) {
          const cpuEv = evaluateUniversalCreatureMesh(
            cMesh,
            bounds,
            {
              timeSec: phaseSec,
              action,
              facingLeft,
              headTiltRad: pose.headTiltRad,
              mouthOpen: pose.mouthOpen,
              yawDeg: opts?.yawDeg ?? 0,
            },
            false
          );
          renderConformingMeshAuto(ctx, pack.filledCanvas, cMesh, cpuEv.positions, renderOpts);
          cDrawn = true;
        }
      }
      if (!cDrawn) {
        renderConformingMeshAuto(ctx, pack.filledCanvas, cMesh, ev.positions, renderOpts);
      }
      const headPt = toWorld(ev.headAnchor);
      const groundY = bounds.y + anatomy.groundV * H;
      return {
        mouthScreen: { x: headPt.x, y: headPt.y + H * 0.04 },
        neckScreen: { x: headPt.x, y: headPt.y + H * 0.09 },
        footLeftScreen: toWorld({ x: bounds.x + W * 0.34, y: groundY }),
        footRightScreen: toWorld({ x: bounds.x + W * 0.66, y: groundY }),
        headTopScreen: { x: headPt.x, y: Math.max(bounds.y, headPt.y - H * 0.08) },
        handLeftScreen: toWorld({ x: bounds.x + W * 0.25, y: bounds.y + H * 0.52 }),
        handRightScreen: toWorld({ x: bounds.x + W * 0.75, y: bounds.y + H * 0.52 }),
        pelvisScreen: { x: pelvisX, y: bounds.y + anatomy.hipV * H },
      };
    }

    if (pack.silhouetteMesh) {
      const silMesh = pack.silhouetteMesh;
      if (_skinnedPosBuf.length < silMesh.vertexCount * 2) {
        _skinnedPosBuf = new Float32Array(silMesh.vertexCount * 2);
      }
      const archKind = pack.archetype === 'quadruped' ? 'quadruped' : 'floater';
      const phaseSec = boilTick * 0.165;
      const ev = evaluateArchetypeSilhouetteMesh(
        silMesh,
        archKind,
        anatomy,
        pose,
        bounds,
        phaseSec,
        _skinnedPosBuf
      );
      renderConformingMeshAuto(ctx, pack.filledCanvas, silMesh, ev.positions, {
        nightHalo: isNight,
        isReflection: opts?.isReflection,
        mirroredOrder: facingLeft,
        mirrorAxisX: facingLeft ? ev.pelvisX : null,
        klausLight: opts?.klausLight,
        forceCpuRaster: opts?.forceCpuRaster,
      });
      if (!opts?.isReflection) {
        ctx.save();
        if (facingLeft) {
          ctx.translate(ev.pelvisX, 0);
          ctx.scale(-1, 1);
          ctx.translate(-ev.pelvisX, 0);
        }
        drawCharacterFacialActing(ctx, pack, {
          blink: pose.blink,
          emotion,
          eyeLeadX: facingLeft ? -rawEyeLead : rawEyeLead,
          headMap: ev.headMapLocal,
          actorW: W,
          headRot: ev.headTotalRot,
          mouthOpen: pose.mouthOpen,
        });
        ctx.restore();
      }
      return ev.anchors;
    }

    const tex = isNight ? pack.nightFilledCanvas : pack.filledCanvas;
    const localPose: ArticulatedCartoonPose = facingLeft
      ? {
          ...pose,
          hipShiftX: -pose.hipShiftX,
          torsoLeanRad: -pose.torsoLeanRad,
          headTiltRad: -pose.headTiltRad,
          headTurnX: -pose.headTurnX,
          facing: 1,
        }
      : pose;

    ctx.save();
    if (facingLeft) {
      ctx.translate(pelvisX, 0);
      ctx.scale(-1, 1);
      ctx.translate(-pelvisX, 0);
    }
    const anchors = renderArticulatedCharacter(ctx, tex, anatomy, localPose, bounds, {
      cols: 12,
      rows: 12,
      boilAmount: opts?.isReflection ? 0 : 0.26,
      boilTick,
    });
    const headTopLocal = {
      x: anchors.neckScreen.x,
      y: bounds.y + Math.max(0.04, anatomy.headCenterY - 0.12) * H - localPose.hipLiftY * H,
    };
    if (!opts?.isReflection) {
      drawCharacterFacialActing(ctx, pack, {
        blink: localPose.blink,
        emotion,
        eyeLeadX: facingLeft ? -rawEyeLead : rawEyeLead,
        headMap: (u, v) => {
          const d = deformArticulatedVertex(u, v, anatomy, localPose, 0, boilTick);
          return { x: bounds.x + d.x * W, y: bounds.y + d.y * H };
        },
        actorW: W,
        headRot: localPose.headTiltRad + localPose.torsoLeanRad * 0.45,
        mouthOpen: localPose.mouthOpen,
      });
    }
    ctx.restore();

    return {
      neckScreen: toWorld(anchors.neckScreen),
      mouthScreen: toWorld(anchors.mouthScreen),
      footLeftScreen: toWorld(anchors.footLeftScreen),
      footRightScreen: toWorld(anchors.footRightScreen),
      headTopScreen: toWorld(headTopLocal),
      handLeftScreen: toWorld({
        x: bounds.x + anatomy.handLeftX * W,
        y: bounds.y + anatomy.handLeftY * H - localPose.hipLiftY * H,
      }),
      handRightScreen: toWorld({
        x: bounds.x + anatomy.handRightX * W,
        y: bounds.y + anatomy.handRightY * H - localPose.hipLiftY * H,
      }),
      pelvisScreen: {
        x: pelvisX,
        y: bounds.y + anatomy.hipV * H - localPose.hipLiftY * H,
      },
    };
  }

  // ---- 0. V3 ZERO-KOPMA 21-BONE CONFORMING SKINNED MESH (GPU VERTEX-SKINNING + ZERO-GC CPU SCANLINE!) ----
  if (pack.useMultiPart && pack.skinnedMesh) {
    const mesh = pack.skinnedMesh;
    if (_skinnedPosBuf.length < mesh.vertexCount * 2) {
      _skinnedPosBuf = new Float32Array(mesh.vertexCount * 2);
    }

    // Use pure 0ms GPU Vertex-Shader Skinning on hardware GPUs when fine CPU head-turn micro-parallax isn't needed!
    const canPureGpuSkin =
      !opts?.forceCpuRaster &&
      !probeSoftwareRenderer() &&
      Math.abs(pose.headTurnX) < 0.06 &&
      Math.abs(pose.headLagY) < 0.015;

    const ev = evaluateConformingSkinnedMesh(
      mesh,
      anatomy,
      pose,
      bounds,
      opts?.ikOverrides,
      _skinnedPosBuf,
      canPureGpuSkin
    );

    // Warm directional streetlamp backlight aura (world space behind character)
    if (isNight && opts?.nightLampPos && !opts.isReflection) {
      const lampDirX = opts.nightLampPos.x >= ev.pelvisX ? 1 : -1;
      const glowX = ev.pelvisX + lampDirX * (W * 0.08);
      const glowY = ev.pelvisY - ev.torsoLen * 0.65;
      const aura = ctx.createRadialGradient(glowX, glowY, 12, glowX, glowY, Math.max(W, H) * 0.58);
      aura.addColorStop(0, 'rgba(255, 222, 146, 0.30)');
      aura.addColorStop(0.52, 'rgba(255, 200, 110, 0.10)');
      aura.addColorStop(1, 'rgba(255, 200, 110, 0)');
      ctx.fillStyle = aura;
      ctx.beginPath();
      ctx.arc(glowX, glowY, Math.max(W, H) * 0.58, 0, Math.PI * 2);
      ctx.fill();
    }

    // Cartoon smear speed lines behind travel direction
    const smear = Math.abs(opts?.smearVelX ?? 0);
    if (!opts?.isReflection && smear > 0.25) {
      const dir = (opts?.smearVelX ?? 1) >= 0 ? -1 : 1;
      ctx.save();
      ctx.strokeStyle = isNight ? 'rgba(255, 232, 182, 0.42)' : 'rgba(28, 25, 23, 0.2)';
      ctx.lineWidth = 2.6;
      ctx.lineCap = 'round';
      for (let s = 0; s < 3; s++) {
        const sy = ev.pelvisY - ev.torsoLen * (0.2 + s * 0.38);
        const len = (24 + s * 14) * Math.min(1.6, smear);
        ctx.beginPath();
        ctx.moveTo(ev.pelvisX + dir * (W * 0.24), sy);
        ctx.lineTo(ev.pelvisX + dir * (W * 0.24 + len), sy + s * 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    const renderOpts = {
      mirroredOrder: facingLeft,
      nightHalo: isNight,
      isReflection: opts?.isReflection,
      mirrorAxisX: facingLeft ? ev.pelvisX : null,
      klausLight: opts?.klausLight,
      forceCpuRaster: opts?.forceCpuRaster,
    };

    let drawn = false;
    if (canPureGpuSkin && ev.gpuBones.length > 0) {
      drawn = renderConformingMeshWebGLGpuSkinned(
        ctx,
        pack.filledCanvas,
        mesh,
        ev.gpuBones,
        bounds,
        ev.screenBbox,
        renderOpts
      );
      if (!drawn) {
        // Fallback if WebGL unavailable -> evaluate CPU vertices cleanly for Zero-GC CPU Scanline!
        const cpuEv = evaluateConformingSkinnedMesh(
          mesh,
          anatomy,
          pose,
          bounds,
          opts?.ikOverrides,
          _skinnedPosBuf,
          false
        );
        renderConformingMeshAuto(ctx, pack.filledCanvas, mesh, cpuEv.positions, renderOpts);
        drawn = true;
      }
    }
    if (!drawn) {
      if (!opts?.isReflection && ev.gpuBones.length > 1) {
        drawInpaintedSocketBackingPass(ctx, mesh, ev.gpuBones[1], bounds, renderOpts.mirrorAxisX);
      }
      renderConformingMeshAuto(ctx, pack.filledCanvas, mesh, ev.positions, renderOpts);
    }

    // Crisp 6-emotion facial acting + organic eye blink + 3-frame eye-lead locked to live rigid head!
    if (!opts?.isReflection) {
      ctx.save();
      if (facingLeft) {
        ctx.translate(ev.pelvisX, 0);
        ctx.scale(-1, 1);
        ctx.translate(-ev.pelvisX, 0);
      }
      drawCharacterFacialActing(ctx, pack, {
        blink: pose.blink,
        emotion,
        eyeLeadX: facingLeft ? -rawEyeLead : rawEyeLead,
        headMap: ev.headMapLocal,
        actorW: W,
        headRot: ev.headTotalRot,
        mouthOpen: pose.mouthOpen,
      });
      ctx.restore();
    }

    return ev.anchors;
  }

  // ---- 1. LIVE KINEMATIC SPINE & EXACT TORSO-LOCKED SOCKET POSITIONS (Legacy Fallback) ----
  const groundY = bounds.y + anatomy.groundV * H;
  const legRestH = Math.max(20, (anatomy.groundV - anatomy.hipV) * H);
  const pelvisY = groundY - legRestH * pose.squashY - pose.hipLiftY * H;

  // In local facing-right coordinate frame (mirrored cleanly around pelvisX when facingLeft!)
  const torsoAng = facingLeft ? -pose.torsoLeanRad : pose.torsoLeanRad;
  const headTiltLocal = facingLeft ? -pose.headTiltRad : pose.headTiltRad;
  const headTurnLocal = facingLeft ? -pose.headTurnX : pose.headTurnX;
  const eyeLeadLocal = facingLeft ? -rawEyeLead : rawEyeLead;
  const ct = Math.cos(torsoAng);
  const st = Math.sin(torsoAng);

  // Exact torso-local -> local-screen map (matches drawTorsoPart transform to 0.000px precision!)
  const mapTorsoPoint = (u: number, v: number): Vec2 => {
    const lx = (u - anatomy.centerX) * W * pose.squashX;
    const ly = (v - anatomy.hipV) * H * pose.squashY;
    return {
      x: pelvisX + lx * ct - ly * st,
      y: pelvisY + lx * st + ly * ct,
    };
  };

  const neckPt = mapTorsoPoint(anatomy.neckX, anatomy.headEndV);
  const neckX = neckPt.x;
  const neckY = neckPt.y;
  const torsoLen = Math.max(12, Math.hypot(neckX - pelvisX, neckY - pelvisY));

  // Lock BOTH shoulders & BOTH hips directly to the segmented torso sockets
  const shLeft = mapTorsoPoint(pack.parts.arm_l.root.x, pack.parts.arm_l.root.y);
  const shRight = mapTorsoPoint(pack.parts.arm_r.root.x, pack.parts.arm_r.root.y);
  const hipLeft = mapTorsoPoint(pack.parts.leg_l.root.x, pack.parts.leg_l.root.y);
  const hipRight = mapTorsoPoint(pack.parts.leg_r.root.x, pack.parts.leg_r.root.y);

  const ikOvr = opts?.ikOverrides;

  // ---- 2. SOLVE TRUE 2-BONE IK FOR BOTH LEGS (Clean Richard Williams Stride & Forward Knee!) ----
  const solveLeg = (
    part: SegmentedLimbPart,
    liveHip: Vec2,
    stride: number,
    lift: number,
    isLeft: boolean,
    explicitTarget?: Vec2 | null
  ) => {
    const restLegLen = Math.max(
      20,
      Math.hypot((part.end.x - part.root.x) * W, (part.end.y - part.root.y) * H)
    );
    const upperLen = explicitTarget ? restLegLen * 0.51 : legRestH * 0.53;
    const lowerLen = explicitTarget ? restLegLen * 0.5 : legRestH * 0.51;
    let footTargetX: number;
    let footTargetY: number;
    if (explicitTarget) {
      footTargetX = facingLeft ? 2 * pelvisX - explicitTarget.x : explicitTarget.x;
      footTargetY = explicitTarget.y;
    } else {
      const strideSpan = W * 0.26;
      const stanceOffset = (isLeft ? -0.025 : 0.025) * W;
      footTargetX = pelvisX + stanceOffset + stride * strideSpan;
      footTargetY = groundY - Math.max(0, pose.hipLiftY) * H * 0.78 - lift * legRestH * 0.34;
    }
    // Always bend forward (+X in local frame, which mirrors cleanly to -X when facingLeft!)
    return solveTwoBoneIK(liveHip.x, liveHip.y, footTargetX, footTargetY, upperLen, lowerLen, -1);
  };

  const legLIK = solveLeg(pack.parts.leg_l, hipLeft, pose.leftLegStride, pose.leftFootLift, true, ikOvr?.footLeft);
  const legRIK = solveLeg(pack.parts.leg_r, hipRight, pose.rightLegStride, pose.rightFootLift, false, ikOvr?.footRight);

  // ---- 3. SOLVE TRUE 2-BONE IK FOR BOTH ARMS (Symmetric Natural Downward Elbow Curve!) ----
  const solveArm = (
    part: SegmentedLimbPart,
    liveShoulder: Vec2,
    swingAngle: number,
    lag: number,
    isLeft: boolean,
    explicitTarget?: Vec2 | null
  ) => {
    const restVecX = (part.end.x - part.root.x) * W;
    const restVecY = (part.end.y - part.root.y) * H;
    const restLen = Math.max(16, Math.hypot(restVecX, restVecY));
    const upperLen = restLen * 0.53;
    const lowerLen = restLen * 0.52;
    let targetX: number;
    let targetY: number;
    if (explicitTarget) {
      targetX = facingLeft ? 2 * pelvisX - explicitTarget.x : explicitTarget.x;
      targetY = explicitTarget.y;
    } else {
      const baseAng = Math.atan2(restVecY, restVecX);
      const dirSign = isLeft ? 1 : -1;
      const clampedSwing = Math.max(-0.95, Math.min(1.05, swingAngle));
      const targetAng = baseAng + dirSign * clampedSwing * 0.72;
      const reach = restLen * (0.94 - Math.min(0.14, Math.abs(clampedSwing) * 0.09));
      targetX = liveShoulder.x + Math.cos(targetAng + dirSign * lag * 0.28) * reach;
      targetY = liveShoulder.y + Math.sin(targetAng + dirSign * lag * 0.28) * reach;
    }
    const bendDir: 1 | -1 = restVecX < 0 ? -1 : 1;
    return solveTwoBoneIK(liveShoulder.x, liveShoulder.y, targetX, targetY, upperLen, lowerLen, bendDir);
  };

  const armLIK = solveArm(pack.parts.arm_l, shLeft, pose.leftArmAngle, pose.leftArmLag, true, ikOvr?.handLeft);
  const armRIK = solveArm(pack.parts.arm_r, shRight, pose.rightArmAngle, pose.rightArmLag, false, ikOvr?.handRight);

  // ---- 4. SOFT WARM DIRECTIONAL STREETLAMP BACKLIGHT HALO (World Space!) ----
  if (isNight && opts?.nightLampPos && !opts.isReflection) {
    const lampDirX = opts.nightLampPos.x >= pelvisX ? 1 : -1;
    const glowX = pelvisX + lampDirX * (W * 0.08);
    const glowY = pelvisY - torsoLen * 0.65;
    const aura = ctx.createRadialGradient(glowX, glowY, 12, glowX, glowY, Math.max(W, H) * 0.58);
    aura.addColorStop(0, 'rgba(255, 222, 146, 0.30)');
    aura.addColorStop(0.52, 'rgba(255, 200, 110, 0.10)');
    aura.addColorStop(1, 'rgba(255, 200, 110, 0)');
    ctx.fillStyle = aura;
    ctx.beginPath();
    ctx.arc(glowX, glowY, Math.max(W, H) * 0.58, 0, Math.PI * 2);
    ctx.fill();
  }

  // ---- 5. OPTIONAL CARTOON SMEAR MOTION ARCS (World Space — ALWAYS Behind Direction of Travel!) ----
  const smear = Math.abs(opts?.smearVelX ?? 0);
  if (!opts?.isReflection && smear > 0.25) {
    const dir = (opts?.smearVelX ?? 1) >= 0 ? -1 : 1;
    ctx.save();
    ctx.strokeStyle = isNight ? 'rgba(255, 232, 182, 0.42)' : 'rgba(28, 25, 23, 0.2)';
    ctx.lineWidth = 2.6;
    ctx.lineCap = 'round';
    for (let s = 0; s < 3; s++) {
      const sy = pelvisY - torsoLen * (0.2 + s * 0.38);
      const len = (24 + s * 14) * Math.min(1.6, smear);
      ctx.beginPath();
      ctx.moveTo(pelvisX + dir * (W * 0.24), sy);
      ctx.lineTo(pelvisX + dir * (W * 0.24 + len), sy + s * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Tightly welded head pivot (prevents any neck gap during bounces while preserving expressive tilt!)
  const headTotalRot = headTiltLocal + torsoAng * 0.42;
  const headOffX = ikOvr?.headOffset ? (facingLeft ? -ikOvr.headOffset.x : ikOvr.headOffset.x) : 0;
  const headOffY = ikOvr?.headOffset ? ikOvr.headOffset.y : 0;
  const headPivotX = neckX + headTurnLocal * W * 0.018 + headOffX;
  const headPivotY = neckY + Math.max(-2.5, Math.min(2.5, pose.headLagY * H * 0.35)) + headOffY;

  // Pure clean ink/gouache renderer targeting any 2D context (screen directly in daylight, or unified scratch in night!)
  const renderUnifiedLayers = (target: CanvasRenderingContext2D, ox: number, oy: number) => {
    const shift = (p: Vec2): Vec2 => ({ x: p.x - ox, y: p.y - oy });
    const shiftedTorsoMap = (u: number, v: number): Vec2 => shift(mapTorsoPoint(u, v));
    const pickClean = (part: SegmentedLimbPart, isFar: boolean): HTMLCanvasElement =>
      isFar && !opts?.isReflection ? part.darkCanvas : part.canvas;

    const drawTorsoClean = () => {
      const part = pack.parts.torso;
      if (part.pixelCount < 4) return;
      target.save();
      target.translate(pelvisX - ox, pelvisY - oy);
      target.rotate(torsoAng);
      target.scale(pose.squashX, pose.squashY);
      target.drawImage(part.canvas, -anatomy.centerX * W, -anatomy.hipV * H, W, H);
      target.restore();
    };

    const drawHeadClean = () => {
      const part = pack.parts.head;
      if (part.pixelCount < 4) return;
      target.save();
      target.translate(headPivotX - ox, headPivotY - oy);
      target.rotate(headTotalRot);
      target.drawImage(part.canvas, -anatomy.neckX * W, -anatomy.headEndV * H, W, H);
      target.restore();

      if (!opts?.isReflection) {
        drawCharacterFacialActing(target, pack, {
          blink: pose.blink,
          emotion,
          eyeLeadX: eyeLeadLocal,
          headMap: (u, v) => {
            const lx = (u - anatomy.neckX) * W;
            const ly = (v - anatomy.headEndV) * H;
            const ch = Math.cos(headTotalRot);
            const sh = Math.sin(headTotalRot);
            return {
              x: headPivotX - ox + lx * ch - ly * sh,
              y: headPivotY - oy + lx * sh + ly * ch,
            };
          },
          actorW: W,
          headRot: headTotalRot,
          mouthOpen: pose.mouthOpen,
        });
      }
    };

    const drawLimb = (part: SegmentedLimbPart, ik: { root: Vec2; mid: Vec2; end: Vec2 }, isFar: boolean) => {
      renderTwoBoneLimb(
        target,
        part,
        pickClean(part, isFar),
        shiftedTorsoMap,
        part.root,
        part.mid,
        part.end,
        shift(ik.root),
        shift(ik.mid),
        shift(ik.end),
        W,
        H
      );
    };

    // Always draw far-side (right in local facing-right space) behind torso and near-side in front;
    // when facingLeft is active, the horizontal mirror flips the visual facing cleanly to LEFT!
    drawLimb(pack.parts.arm_r, armRIK, true);
    drawLimb(pack.parts.leg_r, legRIK, true);
    drawTorsoClean();
    drawLimb(pack.parts.leg_l, legLIK, false);
    drawHeadClean();
    drawLimb(pack.parts.arm_l, armLIK, false);
  };

  // ---- 6. UNIFIED COMPOSITE + OUTER-PERIMETER-ONLY PAPER HALO (ZERO INTERNAL WHITE SEAMS!) ----
  ctx.save();
  if (facingLeft) {
    ctx.translate(pelvisX, 0);
    ctx.scale(-1, 1);
    ctx.translate(-pelvisX, 0);
  }
  if (isNight) {
    const padX = Math.ceil(W * 0.55);
    const padY = Math.ceil(H * 0.45);
    const cw = Math.max(64, Math.ceil(W + padX * 2));
    const ch = Math.max(64, Math.ceil(H + padY * 2));
    const ox = Math.floor(pelvisX - anatomy.centerX * W - padX);
    const oy = Math.floor(pelvisY - anatomy.hipV * H - padY);
    const scratch = getUnifiedScratchCanvases(cw, ch);

    if (scratch) {
      const cctx = scratch.comp.getContext('2d')!;
      const hctx = scratch.halo.getContext('2d')!;
      cctx.clearRect(0, 0, cw, ch);
      renderUnifiedLayers(cctx, ox, oy);

      if (!opts?.isReflection) {
        // Subtle warm lantern rim light in dark film scenes (zero crude opaque white sticker!)
        hctx.globalCompositeOperation = 'source-over';
        hctx.clearRect(0, 0, cw, ch);
        hctx.drawImage(scratch.comp, 0, 0);
        hctx.globalCompositeOperation = 'source-in';
        hctx.fillStyle = opts?.nightLampPos ? 'rgba(245, 208, 138, 0.36)' : 'rgba(250, 244, 228, 0.45)';
        hctx.fillRect(0, 0, cw, ch);
        hctx.globalCompositeOperation = 'source-over';

        const r = 1.25;
        const offsets: [number, number][] = [
          [r, 0], [-r, 0], [0, r], [0, -r],
          [r * 0.72, r * 0.72], [-r * 0.72, r * 0.72],
          [r * 0.72, -r * 0.72], [-r * 0.72, -r * 0.72],
        ];
        for (const [dx, dy] of offsets) {
          ctx.drawImage(scratch.halo, ox + dx, oy + dy);
        }
      }
      // Draw crisp unbroken unified character right on top!
      ctx.drawImage(scratch.comp, ox, oy);
    } else {
      renderUnifiedLayers(ctx, 0, 0);
    }
  } else {
    renderUnifiedLayers(ctx, 0, 0);
  }
  ctx.restore();

  // Compute exact world-space mouth & head-top anchors attached cleanly to live head transform
  const mapHeadLocal = (u: number, v: number): Vec2 => {
    const lx = (u - anatomy.neckX) * W;
    const ly = (v - anatomy.headEndV) * H;
    const ch = Math.cos(headTotalRot);
    const sh = Math.sin(headTotalRot);
    return { x: headPivotX + lx * ch - ly * sh, y: headPivotY + lx * sh + ly * ch };
  };

  return {
    neckScreen: toWorld({ x: neckX, y: neckY }),
    mouthScreen: toWorld(mapHeadLocal(anatomy.mouthX, anatomy.mouthY)),
    footLeftScreen: toWorld(legLIK.end),
    footRightScreen: toWorld(legRIK.end),
    headTopScreen: toWorld(mapHeadLocal(anatomy.headCenterX, Math.max(0.03, anatomy.headCenterY - 0.13))),
    handLeftScreen: toWorld(armLIK.end),
    handRightScreen: toWorld(armRIK.end),
    pelvisScreen: { x: pelvisX, y: pelvisY },
  };
}
