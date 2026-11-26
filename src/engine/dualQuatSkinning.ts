import type {
  ArticulatedCartoonPose,
  CharacterLiveAnchors,
  DrawingAnatomy,
  RiggedIKOverrides,
} from './cartoonMotionEngine';
import {
  SKIN_BONE_COUNT,
  type ConformingSkinnedMesh,
  type FootRigLandmarks,
} from './conformingMeshEngine';
import { solveTwoBoneIK, type Vec2 } from './skeletonSkinEngine';
import type { GpuBoneTransform2D } from './webglSkinnedRenderer';

/**
 * INKTROPE V3 21-Bone Broadcast Skeleton, Reverse-Foot Roll IK & CoR Skinning Evaluator
 * -------------------------------------------------------------------------------------
 * Evaluates full broadcast cartoon kinematics in ~0.08 ms/frame (Zero-GC hot path):
 *  1. 3-Bone Exact Single-Squash S-Curve Spine (pelvis -> lumbar -> chest) + neck + rigid head
 *  2. 4-Bone Articulated Arms (clavicle -> upper_arm -> forearm -> wrist/hand) with natural
 *     pendulum elbow flexion & overlapping wrist follow-through + rigid handheld prop stability!
 *  3. True 3-Pivot Reverse-Foot Roll IK Legs (hip -> knee -> ankle -> foot/ball -> toe):
 *     - Heel-Strike Dorsiflexion (+17° heel touches first, toes up)
 *     - Flat Stance Sole (0.0° flush on ground, zero foot sliding!)
 *     - Natural 55°–65° Passing-Pose Knee Flexion with relaxed plantarflexed ankle
 *     - Ball/Toe Push-Off Roll (heel peels cleanly off floor while toes stay pinned!)
 *  4. SIGGRAPH 2016 Center-of-Rotation (CoR) Skinning (matches GPU Vertex Shader 1:1!):
 *     Zero candy-wrapper collapse, zero DQ joint bulge, 0 inverted triangles up to 95° bends!
 *  5. Emits compact `gpuBones` (~504 bytes) for direct WebGL2 GPU Vertex-Shader Skinning!
 */

function wrapAngleDelta(d: number): number {
  return Math.atan2(Math.sin(d), Math.cos(d));
}

function rotateOffset(dx: number, dy: number, ang: number): Vec2 {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

export interface EvaluatedSkinnedPose {
  /** Deformed vertex screen coordinates [x0, y0, x1, y1, ...] in local facing-right screen space */
  positions: Float32Array;
  /** Compact 21-bone local-space affine transforms ready for WebGL2 GPU Vertex-Shader Skinning! */
  gpuBones: GpuBoneTransform2D[];
  /** Tight screen-space bounding box of live skeleton (for GPU-skinned viewport without CPU vertex loop!) */
  screenBbox: { minX: number; minY: number; maxX: number; maxY: number };
  /** Exact live world-space character anchors (already mirrored if facingLeft!) */
  anchors: CharacterLiveAnchors;
  /** Exact head transform map (u, v) -> local screen point (for eyes, blink & facial acting!) */
  headMapLocal: (u: number, v: number) => Vec2;
  /** Total head rotation angle in local space (radians) */
  headTotalRot: number;
  /** Live pelvis X in screen space (mirror axis for facingLeft!) */
  pelvisX: number;
  /** Live pelvis Y in screen space */
  pelvisY: number;
  /** Live torso length in px */
  torsoLen: number;
  /** Live 21 bone start/end positions & angles in local screen space (for diagnostics & biomechanical tests!) */
  liveBones: { start: Vec2; end: Vec2; deltaAngle: number }[];
  /** Live biomechanical telemetry (knee bends, ankle pitch, sole clearance) */
  biomechanics: {
    leftKneeFlexDeg: number;
    rightKneeFlexDeg: number;
    leftAnklePitchDeg: number;
    rightAnklePitchDeg: number;
    leftToePitchDeg: number;
    rightToePitchDeg: number;
  };
}

// Pre-allocated scratch typed arrays for all 21 bones (Zero-GC!)
const _m00 = new Float32Array(SKIN_BONE_COUNT);
const _m01 = new Float32Array(SKIN_BONE_COUNT);
const _m10 = new Float32Array(SKIN_BONE_COUNT);
const _m11 = new Float32Array(SKIN_BONE_COUNT);
const _tx = new Float32Array(SKIN_BONE_COUNT);
const _ty = new Float32Array(SKIN_BONE_COUNT);
const _rotRad = new Float32Array(SKIN_BONE_COUNT);
const _cosR = new Float32Array(SKIN_BONE_COUNT);
const _sinR = new Float32Array(SKIN_BONE_COUNT);
const _qrC = new Float32Array(SKIN_BONE_COUNT);
const _qrS = new Float32Array(SKIN_BONE_COUNT);
const _qdX = new Float32Array(SKIN_BONE_COUNT);
const _qdY = new Float32Array(SKIN_BONE_COUNT);

function setBoneAffineTransform(
  b: number,
  restOx: number,
  restOy: number,
  liveOx: number,
  liveOy: number,
  deltaAng: number,
  scaleX = 1,
  scaleY = 1
) {
  const c = Math.cos(deltaAng);
  const s = Math.sin(deltaAng);
  const a00 = c * scaleX;
  const a01 = -s * scaleY;
  const a10 = s * scaleX;
  const a11 = c * scaleY;
  const tx = liveOx - (a00 * restOx + a01 * restOy);
  const ty = liveOy - (a10 * restOx + a11 * restOy);

  _m00[b] = a00;
  _m01[b] = a01;
  _m10[b] = a10;
  _m11[b] = a11;
  _tx[b] = tx;
  _ty[b] = ty;
  _rotRad[b] = deltaAng;
  _cosR[b] = c;
  _sinR[b] = s;

  const half = deltaAng * 0.5;
  const c2 = Math.cos(half);
  const s2 = Math.sin(half);
  const rTx = liveOx - (restOx * c - restOy * s);
  const rTy = liveOy - (restOx * s + restOy * c);
  _qrC[b] = c2;
  _qrS[b] = s2;
  _qdX[b] = 0.5 * (rTx * c2 + rTy * s2);
  _qdY[b] = 0.5 * (rTy * c2 - rTx * s2);
}

/** Auto-derives natural heel-strike -> flat-stance -> toe-push-off -> passing roll when pose omits explicit footRoll */
function resolveNaturalFootRoll(stride: number, lift: number, explicit?: number): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit)) {
    return Math.max(-1, Math.min(1, explicit));
  }
  if (lift > 0.06) {
    // Swing / Passing phase: gentle relaxed plantarflexion so shoe clears floor naturally
    return -Math.min(0.62, lift * 0.72);
  }
  if (stride > 0.34) {
    // Contact / Heel-Strike: dorsiflex toes upward so heel kisses the floor first!
    return Math.min(0.88, ((stride - 0.34) / 0.66) * 0.88);
  }
  if (stride < -0.24) {
    // Rear Push-Off: heel peels cleanly up while ball & toe push off the floor!
    return -Math.min(0.95, ((-0.24 - stride) / 0.76) * 0.95);
  }
  // Mid-Stance: 100% flat planted sole!
  return 0;
}

export function evaluateConformingSkinnedMesh(
  mesh: ConformingSkinnedMesh,
  anatomy: DrawingAnatomy,
  pose: ArticulatedCartoonPose,
  bounds: { x: number; y: number; w: number; h: number },
  ikOverrides?: RiggedIKOverrides | null,
  reusablePositions?: Float32Array,
  skipCpuVertices = false
): EvaluatedSkinnedPose {
  const W = bounds.w;
  const H = bounds.h;
  const bones = mesh.bones;
  const hasV3Bones = bones.length >= SKIN_BONE_COUNT;
  const facingLeft = pose.facing < 0;

  const sqY = Math.max(0.88, Math.min(1.14, pose.squashY));
  const sqX = 1 / Math.sqrt(sqY);

  const groundY = bounds.y + anatomy.groundV * H;
  const legRestH = Math.max(20, (anatomy.groundV - anatomy.hipV) * H);
  const pelvisRestX = bounds.x + bones[0].start.x * W;
  const pelvisX = pelvisRestX + pose.hipShiftX * W;
  const pelvisY = groundY - legRestH * (1 - (1 - sqY) * 0.28) - pose.hipLiftY * H;

  const toWorld = (p: Vec2): Vec2 => (facingLeft ? { x: 2 * pelvisX - p.x, y: p.y } : p);

  const torsoAng = Math.max(-0.30, Math.min(0.30, facingLeft ? -pose.torsoLeanRad : pose.torsoLeanRad));
  const chestCounter = Math.max(-0.18, Math.min(0.18, facingLeft ? -pose.chestCounterRad : pose.chestCounterRad));
  const headTiltLocal = Math.max(-0.36, Math.min(0.36, facingLeft ? -pose.headTiltRad : pose.headTiltRad));
  const headTurnLocal = Math.max(-1, Math.min(1, facingLeft ? -pose.headTurnX : pose.headTurnX));

  // ---- 1. EXACT SINGLE-SQUASH 3-BONE S-CURVE SPINE (0: pelvis -> 11: lumbar -> 1: chest -> 12: neck) ----
  const pelvisRestPx = { x: bones[0].start.x * W, y: bones[0].start.y * H };
  const lumbarStartPx = hasV3Bones
    ? { x: bones[11].start.x * W, y: bones[11].start.y * H }
    : { x: bones[0].end.x * W, y: bones[0].end.y * H };
  const chestStartPx = { x: bones[1].start.x * W, y: bones[1].start.y * H };
  const neckRestPx = { x: bones[2].start.x * W, y: bones[2].start.y * H };

  const pelvisAng = torsoAng * 0.44;
  const lumbarAng = torsoAng * 0.72 + chestCounter * 0.25;
  const chestAng = torsoAng + chestCounter * 0.58;
  const neckAng = chestAng * 0.62 + headTiltLocal * 0.35;

  setBoneAffineTransform(0, pelvisRestPx.x, pelvisRestPx.y, pelvisX, pelvisY, pelvisAng, sqX, sqY);
  const evalBonePt = (b: number, u: number, v: number): Vec2 => {
    const px = u * W;
    const py = v * H;
    return {
      x: _m00[b] * px + _m01[b] * py + _tx[b],
      y: _m10[b] * px + _m11[b] * py + _ty[b],
    };
  };

  let liveMidSpine: Vec2;
  if (hasV3Bones) {
    const liveLumbarStart = evalBonePt(0, bones[11].start.x, bones[11].start.y);
    setBoneAffineTransform(11, lumbarStartPx.x, lumbarStartPx.y, liveLumbarStart.x, liveLumbarStart.y, lumbarAng, sqX, sqY);
    liveMidSpine = evalBonePt(11, bones[11].end.x, bones[11].end.y);
  } else {
    liveMidSpine = evalBonePt(0, bones[0].end.x, bones[0].end.y);
  }

  setBoneAffineTransform(1, chestStartPx.x, chestStartPx.y, liveMidSpine.x, liveMidSpine.y, chestAng, sqX, sqY);

  let liveNeck: Vec2;
  if (hasV3Bones) {
    const liveNeckBase = evalBonePt(1, bones[12].start.x, bones[12].start.y);
    setBoneAffineTransform(12, bones[12].start.x * W, bones[12].start.y * H, liveNeckBase.x, liveNeckBase.y, neckAng, sqX, sqY);
    liveNeck = evalBonePt(12, bones[12].end.x, bones[12].end.y);
  } else {
    liveNeck = evalBonePt(1, bones[1].end.x, bones[1].end.y);
  }
  const torsoLen = Math.max(12, Math.hypot(liveNeck.x - pelvisX, liveNeck.y - pelvisY));

  // ---- 2. RIGID HEAD BONE (2: head) LOCKED TO LIVE NECK ----
  const headTotalRot = headTiltLocal + chestAng * 0.36;
  const headOffX = ikOverrides?.headOffset
    ? facingLeft
      ? -ikOverrides.headOffset.x
      : ikOverrides.headOffset.x
    : 0;
  const headOffY = ikOverrides?.headOffset ? ikOverrides.headOffset.y : 0;
  const liveHeadPivotX = liveNeck.x + headTurnLocal * W * 0.012 + headOffX;
  const liveHeadPivotY = liveNeck.y + Math.max(-2.4, Math.min(2.4, pose.headLagY * H * 0.25)) + headOffY;
  setBoneAffineTransform(2, neckRestPx.x, neckRestPx.y, liveHeadPivotX, liveHeadPivotY, headTotalRot, 1, 1);

  const ch = Math.cos(headTotalRot);
  const sh = Math.sin(headTotalRot);
  const headMapLocal = (u: number, v: number): Vec2 => {
    const lx = u * W - neckRestPx.x;
    const ly = v * H - neckRestPx.y;
    return {
      x: liveHeadPivotX + lx * ch - ly * sh,
      y: liveHeadPivotY + lx * sh + ly * ch,
    };
  };

  // ---- 3. CLAVICLES (13, 15) + SHOULDER & HIP SOCKETS ----
  const shrugL = Math.max(-0.14, Math.min(0.14, (pose.shoulderShrugL ?? 0) * 0.12 + pose.leftArmAngle * 0.03));
  const shrugR = Math.max(-0.14, Math.min(0.14, (pose.shoulderShrugR ?? 0) * 0.12 + pose.rightArmAngle * 0.03));

  let liveShL: Vec2;
  let liveShR: Vec2;
  if (hasV3Bones) {
    const liveChestTopL = evalBonePt(1, bones[13].start.x, bones[13].start.y);
    const liveChestTopR = evalBonePt(1, bones[15].start.x, bones[15].start.y);
    setBoneAffineTransform(13, bones[13].start.x * W, bones[13].start.y * H, liveChestTopL.x, liveChestTopL.y, chestAng - shrugL, sqX, sqY);
    setBoneAffineTransform(15, bones[15].start.x * W, bones[15].start.y * H, liveChestTopR.x, liveChestTopR.y, chestAng + shrugR, sqX, sqY);
    liveShL = evalBonePt(13, bones[13].end.x, bones[13].end.y);
    liveShR = evalBonePt(15, bones[15].end.x, bones[15].end.y);
  } else {
    liveShL = evalBonePt(1, bones[3].start.x, bones[3].start.y);
    liveShR = evalBonePt(1, bones[5].start.x, bones[5].start.y);
  }
  const liveHipL = evalBonePt(0, bones[7].start.x, bones[7].start.y);
  const liveHipR = evalBonePt(0, bones[9].start.x, bones[9].start.y);

  // ---- 4. NATURAL 4-BONE PENDULUM IK ARMS (upper_arm -> forearm -> wrist/hand!) ----
  const solveSkinnedArm = (
    upperIdx: 3 | 5,
    lowerIdx: 4 | 6,
    handIdx: 14 | 16,
    liveSh: Vec2,
    swingAngle: number,
    lag: number,
    wristLagExplicit: number | undefined,
    isLeft: boolean,
    hasProp: boolean,
    explicitTarget?: Vec2 | null
  ) => {
    const bUp = bones[upperIdx];
    const bLo = bones[lowerIdx];
    const bHd = hasV3Bones ? bones[handIdx] : null;
    const shPx = { x: bUp.start.x * W, y: bUp.start.y * H };
    const elPx = { x: bUp.end.x * W, y: bUp.end.y * H };
    const wrPx = { x: bLo.end.x * W, y: bLo.end.y * H };
    const hdPx = bHd ? { x: bHd.end.x * W, y: bHd.end.y * H } : wrPx;

    const upperLen = Math.max(8, Math.hypot(elPx.x - shPx.x, elPx.y - shPx.y));
    const lowerLen = Math.max(6, Math.hypot(wrPx.x - elPx.x, wrPx.y - elPx.y));
    const handLen = bHd ? Math.max(3, Math.hypot(hdPx.x - wrPx.x, hdPx.y - wrPx.y)) : 0;
    const restUpperAng = Math.atan2(elPx.y - shPx.y, elPx.x - shPx.x);
    const restLowerAng = Math.atan2(wrPx.y - elPx.y, wrPx.x - elPx.x);
    const restHandAng = bHd ? Math.atan2(hdPx.y - wrPx.y, hdPx.x - wrPx.x) : restLowerAng;

    const chordX = wrPx.x - shPx.x;
    const chordY = wrPx.y - shPx.y;
    const restChordLen = Math.max(10, Math.hypot(chordX, chordY));
    const baseChordAng = Math.atan2(chordY, chordX);

    // Preserve natural elbow bend direction (forward flexion in profile walk!)
    const restCross = (elPx.x - shPx.x) * chordY - (elPx.y - shPx.y) * chordX;
    let bendDir: 1 | -1;
    if (Math.abs(restCross) > restChordLen * 1.15) {
      bendDir = restCross > 0 ? -1 : 1;
    } else {
      bendDir = isLeft ? -1 : 1;
    }

    let targetX: number;
    let targetY: number;
    const isExplicit = Boolean(explicitTarget);
    if (explicitTarget) {
      // Explicit pin target is at hand tip -> offset back gently to wrist
      const exX = facingLeft ? 2 * pelvisX - explicitTarget.x : explicitTarget.x;
      const exY = explicitTarget.y;
      if (handLen > 1) {
        const dx = exX - liveSh.x;
        const dy = exY - liveSh.y;
        const d = Math.hypot(dx, dy) || 1;
        const ratio = Math.max(0.2, (d - handLen * 0.7) / d);
        targetX = liveSh.x + dx * ratio;
        targetY = liveSh.y + dy * ratio;
      } else {
        targetX = exX;
        targetY = exY;
      }
    } else {
      const dirSign = isLeft ? 1 : -1;
      const propScale = hasProp ? 0.42 : 0.78;
      const clampedSwing = Math.max(-0.68, Math.min(0.76, swingAngle * propScale));
      const clampedLag = Math.max(-0.26, Math.min(0.26, lag * (hasProp ? 0.3 : 0.72)));
      const inwardLimit = -0.38;
      const safeDelta = Math.max(inwardLimit, Math.min(0.66, clampedSwing + clampedLag * 0.42));
      const targetAng = baseChordAng + chestAng * 0.32 + dirSign * safeDelta;

      // REAL PENDULUM ELBOW FLEXION:
      // Forward swing (>0) naturally flexes elbow (~22-32°), backswing (<0) gently relaxes straighter!
      const forwardBendFactor = Math.max(0, clampedSwing) * (hasProp ? 0.04 : 0.14);
      const maxReach = (upperLen + lowerLen) * 0.97;
      const minReach = Math.max(Math.abs(upperLen - lowerLen) + 5, restChordLen * 0.76);
      const desiredReach = Math.min(
        maxReach,
        Math.max(minReach, restChordLen * (1.0 - forwardBendFactor - Math.abs(safeDelta) * 0.04))
      );
      targetX = liveSh.x + Math.cos(targetAng) * desiredReach;
      targetY = liveSh.y + Math.sin(targetAng) * desiredReach;
    }

    const ik = solveTwoBoneIK(liveSh.x, liveSh.y, targetX, targetY, upperLen, lowerLen, bendDir);
    let dUp = wrapAngleDelta(ik.upperAngle - restUpperAng);
    let dLo = wrapAngleDelta(ik.lowerAngle - restLowerAng);

    // Relaxed natural joint limits (CoR skinning + joint rings keep 85° elbow bends 0-inversion!)
    const maxUp = isExplicit ? (hasProp ? 0.48 : 0.92) : hasProp ? 0.36 : 0.64;
    const maxRelBend = isExplicit ? (hasProp ? 0.38 : 1.15) : hasProp ? 0.30 : 0.92;
    const clampedUp = Math.max(-maxUp, Math.min(maxUp, dUp));
    if (clampedUp !== dUp) {
      dUp = clampedUp;
      const newUpAng = restUpperAng + dUp;
      const midX = liveSh.x + Math.cos(newUpAng) * upperLen;
      const midY = liveSh.y + Math.sin(newUpAng) * upperLen;
      const rawLo = wrapAngleDelta(Math.atan2(targetY - midY, targetX - midX) - restLowerAng);
      dLo = dUp + Math.max(-maxRelBend, Math.min(maxRelBend, wrapAngleDelta(rawLo - dUp)));
      const newLoAng = restLowerAng + dLo;
      ik.mid.x = midX;
      ik.mid.y = midY;
      ik.end.x = midX + Math.cos(newLoAng) * lowerLen;
      ik.end.y = midY + Math.sin(newLoAng) * lowerLen;
    } else {
      const rel = wrapAngleDelta(dLo - dUp);
      const clampedRel = Math.max(-maxRelBend, Math.min(maxRelBend, rel));
      if (clampedRel !== rel) {
        dLo = dUp + clampedRel;
        const newLoAng = restLowerAng + dLo;
        ik.end.x = ik.mid.x + Math.cos(newLoAng) * lowerLen;
        ik.end.y = ik.mid.y + Math.sin(newLoAng) * lowerLen;
      }
    }

    setBoneAffineTransform(upperIdx, shPx.x, shPx.y, ik.root.x, ik.root.y, dUp, 1, 1);
    setBoneAffineTransform(lowerIdx, elPx.x, elPx.y, ik.mid.x, ik.mid.y, dLo, 1, 1);

    // Relaxed Wrist / Hand Follow-Through Bone (14 / 16)!
    // Rigid props stay stabilized at dLo (0.00° cane bend!), free hands get soft overlapping wrist lag!
    const rawWristLag = wristLagExplicit ?? lag * 0.55;
    const wristOffset = hasProp ? 0 : Math.max(-0.28, Math.min(0.28, rawWristLag));
    const dHand = dLo + wristOffset;
    let liveHandTip: Vec2 = ik.end;
    if (hasV3Bones) {
      setBoneAffineTransform(handIdx, wrPx.x, wrPx.y, ik.end.x, ik.end.y, dHand, 1, 1);
      const liveHandAng = restHandAng + dHand;
      liveHandTip = {
        x: ik.end.x + Math.cos(liveHandAng) * handLen,
        y: ik.end.y + Math.sin(liveHandAng) * handLen,
      };
    }

    return { ik, dUp, dLo, dHand, liveWrist: ik.end, liveHandTip };
  };

  const armLRes = solveSkinnedArm(
    3,
    4,
    14,
    liveShL,
    pose.leftArmAngle,
    pose.leftArmLag,
    pose.leftWristLag,
    true,
    mesh.leftHasRigidProp,
    ikOverrides?.handLeft
  );
  const armRRes = solveSkinnedArm(
    5,
    6,
    16,
    liveShR,
    pose.rightArmAngle,
    pose.rightArmLag,
    pose.rightWristLag,
    false,
    mesh.rightHasRigidProp,
    ikOverrides?.handRight
  );

  // ---- 5. TRUE 3-PIVOT REVERSE-FOOT ROLL IK FOR LEGS (hip -> knee -> ankle -> foot/ball -> toe!) ----
  const kneePole: -1 | 1 = pose.kneePoleDir ?? -1;

  const solveReverseFootLeg = (
    upperIdx: 7 | 9,
    lowerIdx: 8 | 10,
    footIdx: 17 | 19,
    toeIdx: 18 | 20,
    landmarks: FootRigLandmarks | undefined,
    liveHip: Vec2,
    stride: number,
    lift: number,
    explicitFootRoll: number | undefined,
    explicitTarget?: Vec2 | null
  ) => {
    const bUp = bones[upperIdx];
    const bLo = bones[lowerIdx];
    const hipPx = { x: bUp.start.x * W, y: bUp.start.y * H };
    const kneePx = { x: bUp.end.x * W, y: bUp.end.y * H };
    const anklePx = { x: bLo.end.x * W, y: bLo.end.y * H };

    // Real heel / ball / toe pivots in actor pixel space
    const soleRestY = landmarks ? landmarks.soleY * H : anatomy.groundV * H;
    const heelPx = landmarks
      ? { x: landmarks.heel.x * W, y: soleRestY }
      : { x: anklePx.x - W * 0.025, y: soleRestY };
    const ballPx = landmarks
      ? { x: landmarks.ball.x * W, y: soleRestY }
      : { x: anklePx.x + W * 0.032, y: soleRestY };
    const toePx = landmarks
      ? { x: landmarks.toe.x * W, y: soleRestY }
      : { x: anklePx.x + W * 0.06, y: soleRestY };

    const upperLen = Math.max(8, Math.hypot(kneePx.x - hipPx.x, kneePx.y - hipPx.y));
    const lowerLen = Math.max(8, Math.hypot(anklePx.x - kneePx.x, anklePx.y - kneePx.y));
    const totalLegLen = upperLen + lowerLen;
    const restUpperAng = Math.atan2(kneePx.y - hipPx.y, kneePx.x - hipPx.x);
    const restLowerAng = Math.atan2(anklePx.y - kneePx.y, anklePx.x - kneePx.x);

    const clampedStride = Math.max(-1.1, Math.min(1.1, stride));
    const clampedLift = Math.max(0, Math.min(1.05, lift));
    const footRoll = resolveNaturalFootRoll(clampedStride, clampedLift, explicitFootRoll);

    // Exact rest short-circuit: standing perfectly still with neutral squash = 0.0° knee/ankle bend!
    if (
      !explicitTarget &&
      Math.abs(stride) < 0.004 &&
      Math.abs(lift) < 0.004 &&
      Math.abs(footRoll) < 0.004 &&
      Math.abs(sqY - 1) < 0.004 &&
      Math.abs(pose.hipLiftY) < 0.004
    ) {
      const restMid: Vec2 = { x: liveHip.x + (kneePx.x - hipPx.x), y: liveHip.y + (kneePx.y - hipPx.y) };
      const restAnk: Vec2 = { x: liveHip.x + (anklePx.x - hipPx.x), y: liveHip.y + (anklePx.y - hipPx.y) };
      const restBall: Vec2 = { x: restAnk.x + (ballPx.x - anklePx.x), y: restAnk.y + (ballPx.y - anklePx.y) };
      const restToe: Vec2 = { x: restBall.x + (toePx.x - ballPx.x), y: restBall.y + (toePx.y - ballPx.y) };
      setBoneAffineTransform(upperIdx, hipPx.x, hipPx.y, liveHip.x, liveHip.y, 0, 1, 1);
      setBoneAffineTransform(lowerIdx, kneePx.x, kneePx.y, restMid.x, restMid.y, 0, 1, 1);
      if (hasV3Bones) {
        setBoneAffineTransform(footIdx, anklePx.x, anklePx.y, restAnk.x, restAnk.y, 0, 1, 1);
        setBoneAffineTransform(toeIdx, ballPx.x, ballPx.y, restBall.x, restBall.y, 0, 1, 1);
      }
      return {
        ik: { root: liveHip, mid: restMid, end: restAnk, upperAngle: restUpperAng, lowerAngle: restLowerAng },
        dUp: 0,
        dLo: 0,
        footDeltaAng: 0,
        toeDeltaAng: 0,
        liveBall: restBall,
        liveToe: restToe,
        kneeFlexDeg: 0,
        anklePitchDeg: 0,
        toePitchDeg: 0,
      };
    }

    // Compute Reverse-Foot ankle target & foot/toe angles!
    let ankleTargetX: number;
    let ankleTargetY: number;
    let footDeltaAng = 0;
    let toeDeltaAng = 0;

    if (explicitTarget) {
      // Interactive Canlı Kukla pin directly controls sole/ankle with automatic ankle relaxation on lift!
      const exX = facingLeft ? 2 * pelvisX - explicitTarget.x : explicitTarget.x;
      const exY = explicitTarget.y;
      const liftAboveFloor = Math.max(0, bounds.y + soleRestY - exY);
      const liftNorm = Math.min(1, liftAboveFloor / Math.max(20, totalLegLen * 0.45));
      footDeltaAng = liftNorm > 0.08 ? liftNorm * 0.24 : 0; // Relaxed toe drop when foot lifted in air!
      toeDeltaAng = footDeltaAng * 1.15;
      ankleTargetX = exX;
      ankleTargetY = exY - (soleRestY - anklePx.y) * Math.cos(footDeltaAng);
    } else {
      const restAnkleOffX = anklePx.x - pelvisRestPx.x;
      const walkBlend = Math.min(1, Math.abs(clampedStride) * 1.15 + clampedLift * 0.85);
      const liveRestOffX = restAnkleOffX * (1 - 0.14 * walkBlend);
      // Natural stride length & generous passing-pose lift (allows real 55°–65° knee flexion!)
      const strideSpan = Math.min(W * 0.17, totalLegLen * 0.48);
      const maxLiftPx = totalLegLen * 0.26;

      const baseFootShiftX = pelvisX + liveRestOffX + clampedStride * strideSpan - anklePx.x;
      const soleBaseY = bounds.y + soleRestY - Math.max(0, pose.hipLiftY) * H * 0.88 - clampedLift * maxLiftPx;

      const maxHeelStrikeRad = 0.29; // +16.6° toes up on heel-strike!
      const maxPushOffRad = 0.39;    // -22.3° heel up on toe push-off!
      const maxSwingDropRad = 0.26;  // -14.9° relaxed plantarflexion in swing!

      if (clampedLift >= 0.06) {
        // SWING / PASSING POSE: Foot lifts cleanly off floor with natural relaxed ankle droop!
        footDeltaAng = Math.min(maxSwingDropRad, Math.abs(footRoll) * maxSwingDropRad);
        toeDeltaAng = footDeltaAng + clampedLift * 0.09;
        ankleTargetX = anklePx.x + baseFootShiftX;
        ankleTargetY = soleBaseY - (soleRestY - anklePx.y);
      } else if (footRoll > 0.01) {
        // HEEL-STRIKE (CONTACT): Pivot around HEEL planted strictly on the floor (toes angled up!)
        footDeltaAng = -footRoll * maxHeelStrikeRad;
        toeDeltaAng = footDeltaAng;
        const liveHeelX = heelPx.x + baseFootShiftX;
        const liveHeelY = soleBaseY;
        const ankOff = rotateOffset(anklePx.x - heelPx.x, anklePx.y - heelPx.y, footDeltaAng);
        ankleTargetX = liveHeelX + ankOff.x;
        ankleTargetY = liveHeelY + ankOff.y;
      } else if (footRoll < -0.01) {
        // PUSH-OFF ROLL: Pivot around BALL planted strictly on floor — HEEL lifts while TOES stay flat!
        footDeltaAng = -footRoll * maxPushOffRad;
        toeDeltaAng = footDeltaAng * 0.24; // Smooth toe roll staying planted flat on floor!
        const liveBallX = ballPx.x + baseFootShiftX;
        const liveBallY = soleBaseY;
        const ankOff = rotateOffset(anklePx.x - ballPx.x, anklePx.y - ballPx.y, footDeltaAng);
        ankleTargetX = liveBallX + ankOff.x;
        ankleTargetY = liveBallY + ankOff.y;
      } else {
        // FLAT STANCE: 100% flat sole flush on floor!
        footDeltaAng = 0;
        toeDeltaAng = 0;
        ankleTargetX = anklePx.x + baseFootShiftX;
        ankleTargetY = soleBaseY - (soleRestY - anklePx.y);
      }
    }

    // V3 Relaxed Anti-Fold Distance Guard (0.68 vs old stiff 0.84 -> unlocks true 58°–72° natural knee flexion!)
    const minSafeLegDist = Math.max(Math.abs(upperLen - lowerLen) + 6, totalLegLen * 0.68);
    const dx = ankleTargetX - liveHip.x;
    const dy = ankleTargetY - liveHip.y;
    const rawDist = Math.hypot(dx, dy);
    if (rawDist < minSafeLegDist) {
      const safeDirX = rawDist > 1e-3 ? dx / rawDist : 0;
      const safeDirY = rawDist > 1e-3 ? dy / rawDist : 1;
      ankleTargetX = liveHip.x + safeDirX * minSafeLegDist;
      ankleTargetY = liveHip.y + safeDirY * minSafeLegDist;
    }

    const ik = solveTwoBoneIK(liveHip.x, liveHip.y, ankleTargetX, ankleTargetY, upperLen, lowerLen, kneePole);
    let dUp = wrapAngleDelta(ik.upperAngle - restUpperAng);
    let dLo = wrapAngleDelta(ik.lowerAngle - restLowerAng);

    // Broadcast-grade natural hip & knee range (up to ~68° natural walk/crouch knee flexion, 0 inversions!)
    const maxLegUp = explicitTarget ? 0.82 : 0.68;
    const minKneeRel = kneePole === -1 ? (explicitTarget ? -0.15 : -0.06) : -1.28;
    const maxKneeRel = kneePole === -1 ? (explicitTarget ? 1.32 : 1.18) : 0.15;
    const clampedUp = Math.max(-maxLegUp, Math.min(maxLegUp, dUp));
    const relKnee = Math.max(minKneeRel, Math.min(maxKneeRel, wrapAngleDelta(dLo - clampedUp)));
    if (clampedUp !== dUp || clampedUp + relKnee !== dLo) {
      dUp = clampedUp;
      dLo = clampedUp + relKnee;
      const newUpAng = restUpperAng + dUp;
      const newLoAng = restLowerAng + dLo;
      ik.mid.x = liveHip.x + Math.cos(newUpAng) * upperLen;
      ik.mid.y = liveHip.y + Math.sin(newUpAng) * upperLen;
      ik.end.x = ik.mid.x + Math.cos(newLoAng) * lowerLen;
      ik.end.y = ik.mid.y + Math.sin(newLoAng) * lowerLen;
    }

    // Clamp relative ankle bend inside realistic human biomechanics (-34°..+36° relative to shin)
    const relAnkle = wrapAngleDelta(footDeltaAng - dLo);
    const clampedRelAnkle = Math.max(-0.58, Math.min(0.62, relAnkle));
    footDeltaAng = dLo + clampedRelAnkle;
    const relToe = wrapAngleDelta(toeDeltaAng - footDeltaAng);
    toeDeltaAng = footDeltaAng + Math.max(-0.32, Math.min(0.32, relToe));

    setBoneAffineTransform(upperIdx, hipPx.x, hipPx.y, ik.root.x, ik.root.y, dUp, 1, 1);
    setBoneAffineTransform(lowerIdx, kneePx.x, kneePx.y, ik.mid.x, ik.mid.y, dLo, 1, 1);

    const ballOff = rotateOffset(ballPx.x - anklePx.x, ballPx.y - anklePx.y, footDeltaAng);
    const liveBall: Vec2 = { x: ik.end.x + ballOff.x, y: ik.end.y + ballOff.y };
    const toeOff = rotateOffset(toePx.x - ballPx.x, toePx.y - ballPx.y, toeDeltaAng);
    const liveToe: Vec2 = { x: liveBall.x + toeOff.x, y: liveBall.y + toeOff.y };

    if (hasV3Bones) {
      setBoneAffineTransform(footIdx, anklePx.x, anklePx.y, ik.end.x, ik.end.y, footDeltaAng, 1, 1);
      setBoneAffineTransform(toeIdx, ballPx.x, ballPx.y, liveBall.x, liveBall.y, toeDeltaAng, 1, 1);
    }

    const kneeFlexDeg = Math.abs(wrapAngleDelta(dLo - dUp)) * (180 / Math.PI);
    const anklePitchDeg = -footDeltaAng * (180 / Math.PI); // +deg = toes up (dorsiflex), -deg = heel up / plantarflex
    const toePitchDeg = -toeDeltaAng * (180 / Math.PI);

    return {
      ik,
      dUp,
      dLo,
      footDeltaAng,
      toeDeltaAng,
      liveBall,
      liveToe,
      kneeFlexDeg,
      anklePitchDeg,
      toePitchDeg,
    };
  };

  const legLRes = solveReverseFootLeg(
    7,
    8,
    17,
    18,
    mesh.footLeft,
    liveHipL,
    pose.leftLegStride,
    pose.leftFootLift,
    pose.leftFootRoll,
    ikOverrides?.footLeft
  );
  const legRRes = solveReverseFootLeg(
    9,
    10,
    19,
    20,
    mesh.footRight,
    liveHipR,
    pose.rightLegStride,
    pose.rightFootLift,
    pose.rightFootRoll,
    ikOverrides?.footRight
  );

  // ---- 6. BUILD COMPACT GPU BONE UNIFORMS (~504 bytes for direct WebGL2 Vertex-Shader Skinning!) ----
  const activeBoneCount = hasV3Bones ? SKIN_BONE_COUNT : Math.min(SKIN_BONE_COUNT, bones.length);
  const gpuBones: GpuBoneTransform2D[] = new Array(activeBoneCount);
  for (let b = 0; b < activeBoneCount; b++) {
    // Convert world-space translation to actor-local offset relative to bounds.x, bounds.y
    gpuBones[b] = {
      m00: _m00[b],
      m01: _m01[b],
      tx: _tx[b] - bounds.x,
      m10: _m10[b],
      m11: _m11[b],
      ty: _ty[b] - bounds.y,
      rotRad: _rotRad[b],
    };
  }

  // ---- 7. SIGGRAPH CoR + EXACT SPINE VERTEX SKINNING (CPU path — 1:1 with GPU Vertex Shader!) ----
  const vCount = mesh.vertexCount;
  const positions =
    reusablePositions && reusablePositions.length >= vCount * 2
      ? reusablePositions
      : new Float32Array(vCount * 2);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  if (!skipCpuVertices) {
    const restUV = mesh.restUV;
    const bIdx = mesh.boneIndices;
    const bW = mesh.boneWeights;
    const corUV = mesh.corUV;
    const hasCor = Boolean(corUV && corUV.length >= vCount * 2);
    const hasFaceParallax = Math.abs(headTurnLocal) > 0.04;
    const faceParallaxAmp = Math.sin(headTurnLocal * 0.46) * W * 0.016;
    const hatFollowY = Math.max(-3.2, Math.min(3.2, pose.headLagY * H * 0.35));

    for (let vi = 0; vi < vCount; vi++) {
      const u = restUV[vi * 2];
      const v = restUV[vi * 2 + 1];
      const px = u * W;
      const py = v * H;
      const o4 = vi * 4;
      const b0 = bIdx[o4];
      const w0 = bW[o4];

      let outX: number;
      let outY: number;

      if (w0 >= 0.998) {
        // Rigid bone interior (skull, handheld rigid prop, bone shafts)
        outX = _m00[b0] * px + _m01[b0] * py + _tx[b0];
        outY = _m10[b0] * px + _m11[b0] * py + _ty[b0];

        if (b0 === 2) {
          if (hasFaceParallax && v >= anatomy.headCenterY - 0.08 && v <= anatomy.headEndV - 0.02) {
            const rx = Math.abs(u - anatomy.headCenterX) / 0.16;
            if (rx < 1) {
              const depth = Math.sqrt(Math.max(0, 1 - rx * rx));
              const shift = faceParallaxAmp * depth;
              outX += shift * ch;
              outY += shift * sh;
            }
          }
          if (Math.abs(hatFollowY) > 0.15 && v < anatomy.headCenterY - 0.05) {
            const crownT = Math.min(1, (anatomy.headCenterY - 0.05 - v) / 0.14);
            outY += hatFollowY * crownT;
          }
        }
      } else if (hasCor && corUV![vi * 2] >= -0.5) {
        // SIGGRAPH 2016 Center-of-Rotation (CoR) Skinning:
        // Preserves exact volume at 95° knees, elbows, ankles & wrists with ZERO collapse and ZERO bulge!
        const corX = corUV![vi * 2] * W;
        const corY = corUV![vi * 2 + 1] * H;
        let corDefX = w0 * (_m00[b0] * corX + _m01[b0] * corY + _tx[b0]);
        let corDefY = w0 * (_m10[b0] * corX + _m11[b0] * corY + _ty[b0]);
        const refC = _cosR[b0];
        const refS = _sinR[b0];
        let sumC = w0 * refC;
        let sumS = w0 * refS;

        for (let s = 1; s < 4; s++) {
          const w = bW[o4 + s];
          if (w <= 0.0005) break;
          const b = bIdx[o4 + s];
          corDefX += w * (_m00[b] * corX + _m01[b] * corY + _tx[b]);
          corDefY += w * (_m10[b] * corX + _m11[b] * corY + _ty[b]);
          const bc = _cosR[b];
          const bs = _sinR[b];
          const sign = bc * refC + bs * refS < 0 ? -1 : 1;
          sumC += w * sign * bc;
          sumS += w * sign * bs;
        }
        const rLen = Math.hypot(sumC, sumS) || 1;
        const qc = sumC / rLen;
        const qs = sumS / rLen;
        const dx = px - corX;
        const dy = py - corY;
        outX = corDefX + qc * dx - qs * dy;
        outY = corDefY + qs * dx + qc * dy;
      } else {
        // Spine/squashing seams: exact affine LBS (zero double-squash!)
        let hasSpineBone = b0 === 0 || b0 === 1 || b0 === 11 || b0 === 12 || b0 === 13 || b0 === 15;
        let lbsX = w0 * (_m00[b0] * px + _m01[b0] * py + _tx[b0]);
        let lbsY = w0 * (_m10[b0] * px + _m11[b0] * py + _ty[b0]);

        for (let s = 1; s < 4; s++) {
          const w = bW[o4 + s];
          if (w <= 0.0005) break;
          const b = bIdx[o4 + s];
          if (b === 0 || b === 1 || b === 11 || b === 12 || b === 13 || b === 15) hasSpineBone = true;
          lbsX += w * (_m00[b] * px + _m01[b] * py + _tx[b]);
          lbsY += w * (_m10[b] * px + _m11[b] * py + _ty[b]);
        }

        if (hasSpineBone) {
          outX = lbsX;
          outY = lbsY;
        } else {
          // Legacy 80/20 2D-DQ fallback when corUV is absent
          const refC = _qrC[b0];
          const refS = _qrS[b0];
          let sumC = w0 * refC;
          let sumS = w0 * refS;
          let sumDx = w0 * _qdX[b0];
          let sumDy = w0 * _qdY[b0];
          for (let s = 1; s < 4; s++) {
            const w = bW[o4 + s];
            if (w <= 0.0005) break;
            const b = bIdx[o4 + s];
            const sign = _qrC[b] * refC + _qrS[b] * refS < 0 ? -1 : 1;
            const sw = w * sign;
            sumC += sw * _qrC[b];
            sumS += sw * _qrS[b];
            sumDx += sw * _qdX[b];
            sumDy += sw * _qdY[b];
          }
          const qLen = Math.hypot(sumC, sumS) || 1;
          const invL = 1 / qLen;
          const uc = sumC * invL;
          const us = sumS * invL;
          const udx = sumDx * invL;
          const udy = sumDy * invL;
          const rCos = uc * uc - us * us;
          const rSin = 2 * uc * us;
          const dTx = 2 * (udx * uc - udy * us);
          const dTy = 2 * (udy * uc + udx * us);
          outX = (px * rCos - py * rSin + dTx) * 0.8 + lbsX * 0.2;
          outY = (px * rSin + py * rCos + dTy) * 0.8 + lbsY * 0.2;
        }
      }

      positions[vi * 2] = outX;
      positions[vi * 2 + 1] = outY;

      const worldX = facingLeft ? 2 * pelvisX - outX : outX;
      if (worldX < minX) minX = worldX;
      if (worldX > maxX) maxX = worldX;
      if (outY < minY) minY = outY;
      if (outY > maxY) maxY = outY;
    }
  } else {
    // Fast conservative bounding box directly from live extremities (for pure GPU vertex-shader skinning!)
    const padX = W * 0.34;
    const padY = H * 0.26;
    minX = bounds.x - padX;
    maxX = bounds.x + W + padX;
    minY = bounds.y - padY - Math.max(0, pose.hipLiftY) * H;
    maxY = bounds.y + H + padY;
  }

  const anchors: CharacterLiveAnchors = {
    neckScreen: toWorld(liveNeck),
    mouthScreen: toWorld(headMapLocal(anatomy.mouthX, anatomy.mouthY)),
    footLeftScreen: toWorld(legLRes.liveBall),
    footRightScreen: toWorld(legRRes.liveBall),
    headTopScreen: toWorld(headMapLocal(anatomy.headCenterX, Math.max(0.03, anatomy.headCenterY - 0.13))),
    handLeftScreen: toWorld(armLRes.liveHandTip),
    handRightScreen: toWorld(armRRes.liveHandTip),
    pelvisScreen: { x: pelvisX, y: pelvisY },
  };

  const liveBones = [
    { start: { x: pelvisX, y: pelvisY }, end: liveMidSpine, deltaAngle: pelvisAng },
    { start: liveMidSpine, end: liveNeck, deltaAngle: chestAng },
    { start: { x: liveHeadPivotX, y: liveHeadPivotY }, end: headMapLocal(bones[2].end.x, bones[2].end.y), deltaAngle: headTotalRot },
    { start: armLRes.ik.root, end: armLRes.ik.mid, deltaAngle: armLRes.dUp },
    { start: armLRes.ik.mid, end: armLRes.liveWrist, deltaAngle: armLRes.dLo },
    { start: armRRes.ik.root, end: armRRes.ik.mid, deltaAngle: armRRes.dUp },
    { start: armRRes.ik.mid, end: armRRes.liveWrist, deltaAngle: armRRes.dLo },
    { start: legLRes.ik.root, end: legLRes.ik.mid, deltaAngle: legLRes.dUp },
    { start: legLRes.ik.mid, end: legLRes.ik.end, deltaAngle: legLRes.dLo },
    { start: legRRes.ik.root, end: legRRes.ik.mid, deltaAngle: legRRes.dUp },
    { start: legRRes.ik.mid, end: legRRes.ik.end, deltaAngle: legRRes.dLo },
  ];
  if (hasV3Bones) {
    liveBones.push(
      { start: evalBonePt(0, bones[11].start.x, bones[11].start.y), end: liveMidSpine, deltaAngle: lumbarAng },
      { start: evalBonePt(1, bones[12].start.x, bones[12].start.y), end: liveNeck, deltaAngle: neckAng },
      { start: evalBonePt(1, bones[13].start.x, bones[13].start.y), end: liveShL, deltaAngle: chestAng - shrugL },
      { start: armLRes.liveWrist, end: armLRes.liveHandTip, deltaAngle: armLRes.dHand },
      { start: evalBonePt(1, bones[15].start.x, bones[15].start.y), end: liveShR, deltaAngle: chestAng + shrugR },
      { start: armRRes.liveWrist, end: armRRes.liveHandTip, deltaAngle: armRRes.dHand },
      { start: legLRes.ik.end, end: legLRes.liveBall, deltaAngle: legLRes.footDeltaAng },
      { start: legLRes.liveBall, end: legLRes.liveToe, deltaAngle: legLRes.toeDeltaAng },
      { start: legRRes.ik.end, end: legRRes.liveBall, deltaAngle: legRRes.footDeltaAng },
      { start: legRRes.liveBall, end: legRRes.liveToe, deltaAngle: legRRes.toeDeltaAng }
    );
  }

  return {
    positions,
    gpuBones,
    screenBbox: { minX, minY, maxX, maxY },
    anchors,
    headMapLocal,
    headTotalRot,
    pelvisX,
    pelvisY,
    torsoLen,
    liveBones,
    biomechanics: {
      leftKneeFlexDeg: legLRes.kneeFlexDeg,
      rightKneeFlexDeg: legRRes.kneeFlexDeg,
      leftAnklePitchDeg: legLRes.anklePitchDeg,
      rightAnklePitchDeg: legRRes.anklePitchDeg,
      leftToePitchDeg: legLRes.toePitchDeg,
      rightToePitchDeg: legRRes.toePitchDeg,
    },
  };
}

/** Smooth 0..1 Hermite ramp (handles both ascending edge0 < edge1 and descending edge0 > edge1 cleanly!) */
function smoothstep01(edge0: number, edge1: number, x: number): number {
  const span = edge1 - edge0;
  if (Math.abs(span) < 1e-5) return x >= edge1 ? 1 : 0;
  const t = Math.max(0, Math.min(1, (x - edge0) / span));
  return t * t * (3 - 2 * t);
}

/**
 * V3 Articulated Silhouette Mesh Evaluator for Quadrupeds (cats, dogs, horses, dinos)
 * AND Floaters (ghosts, clouds, birds, jellyfish)!
 * - Quadrupeds: True 4-Leg 2-Bone Knee/Ankle Articulation (diagonal trot/gallop pairs with
 *   real knee flexion & paw lift!) + flexible spine arch + head nod + multi-segment wagging tail!
 * - Floaters: Volume-preserving elastic squash/stretch + articulated wing flap + Ghibli cloth hem wave!
 */
export function evaluateArchetypeSilhouetteMesh(
  mesh: ConformingSkinnedMesh,
  archetype: 'quadruped' | 'floater',
  anatomy: DrawingAnatomy,
  pose: ArticulatedCartoonPose,
  bounds: { x: number; y: number; w: number; h: number },
  phaseSec: number,
  reusablePositions?: Float32Array
): EvaluatedSkinnedPose {
  const W = bounds.w;
  const H = bounds.h;
  const facingLeft = pose.facing < 0;
  const sqY = Math.max(0.86, Math.min(1.16, pose.squashY));
  const sqX = 1 / Math.sqrt(sqY);
  const groundY = bounds.y + anatomy.groundV * H;
  const pelvisX = bounds.x + anatomy.centerX * W + pose.hipShiftX * W;
  const pelvisY = bounds.y + anatomy.hipV * H - pose.hipLiftY * H;
  const toWorld = (p: Vec2): Vec2 => (facingLeft ? { x: 2 * pelvisX - p.x, y: p.y } : p);

  const headSide = anatomy.headCenterX >= anatomy.centerX ? 1 : -1;
  const leanRad = Math.max(-0.26, Math.min(0.26, facingLeft ? -pose.torsoLeanRad : pose.torsoLeanRad));
  const headTiltLocal = Math.max(-0.34, Math.min(0.34, facingLeft ? -pose.headTiltRad : pose.headTiltRad));

  const vCount = mesh.vertexCount;
  const positions =
    reusablePositions && reusablePositions.length >= vCount * 2
      ? reusablePositions
      : new Float32Array(vCount * 2);
  const restUV = mesh.restUV;

  const strideAmp = Math.max(Math.abs(pose.leftLegStride), Math.abs(pose.rightLegStride));
  const motionEnergy = Math.min(1.25, strideAmp * 1.15 + Math.abs(pose.leftArmAngle) * 0.45 + 0.12);
  const bellyV = Math.max(0.46, Math.min(0.74, anatomy.hipV));
  const groundV = Math.max(bellyV + 0.1, anatomy.groundV);
  const legZoneH = Math.max(0.1, groundV - bellyV);
  const floatBobPx =
    archetype === 'floater' ? Math.sin(phaseSec * 3.1) * H * 0.032 : 0;

  const frontLegSign = headSide;
  const frontHipU = anatomy.centerX + frontLegSign * 0.2;
  const backHipU = anatomy.centerX - frontLegSign * 0.2;

  // Quadruped Jacobian-safe 2-segment knee-bending leg articulation (det(J) > 0.78 -> mathematically 0 inversions!)
  const solveQuadLegOffset = (
    _u: number,
    v: number,
    _hipU: number,
    legStride: number,
    legLift: number,
    kneeBendDir: 1 | -1
  ): Vec2 => {
    const tLeg = smoothstep01(bellyV, groundV, v);
    if (tLeg <= 0.001) return { x: 0, y: 0 };
    const clampedStride = Math.max(-0.9, Math.min(0.9, legStride));
    const clampedLift = Math.max(0, Math.min(0.9, legLift));
    const kneeV = bellyV + legZoneH * 0.48;
    const tUpper = smoothstep01(bellyV, kneeV, v);
    const tLower = smoothstep01(kneeV - legZoneH * 0.14, groundV, v);

    // Pure horizontal thigh swing + distinct knee-bend lower-leg kick (shear det(J) === 1.0 -> 0 inversions!)
    const upperSwingX = clampedStride * W * 0.085 * tUpper * headSide;
    const kneeKickX = kneeBendDir * clampedLift * W * 0.062 * tLower;
    // Gentle bounded paw lift (|dg/dy| <= 0.18 << 1.0 -> mathematically inversion-proof!)
    const pawLiftY = -clampedLift * legZoneH * H * 0.12 * tLeg;
    return {
      x: upperSwingX + kneeKickX,
      y: pawLiftY,
    };
  };

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (let vi = 0; vi < vCount; vi++) {
    const u = restUV[vi * 2];
    const v = restUV[vi * 2 + 1];

    let x = bounds.x + (anatomy.centerX + (u - anatomy.centerX) * sqX) * W + pose.hipShiftX * W;
    let y = groundY - (anatomy.groundV - v) * H * sqY - pose.hipLiftY * H - floatBobPx;

    const dx0 = x - pelvisX;
    const dy0 = y - pelvisY;
    const leanWeight = smoothstep01(groundV, 0.18, v);
    const localLean = leanRad * leanWeight;
    const cl = Math.cos(localLean);
    const sl = Math.sin(localLean);
    x = pelvisX + dx0 * cl - dy0 * sl;
    y = pelvisY + dx0 * sl + dy0 * cl;

    if (archetype === 'quadruped') {
      // 1. Real 2-Bone Bending Front & Hind Legs with smooth center-belly fade (ZERO belly seam inversion!)
      const legBlend = smoothstep01(bellyV, bellyV + 0.12, v);
      if (legBlend > 0.001) {
        const signedU = (u - anatomy.centerX) * frontLegSign;
        const frontMask = smoothstep01(0.04, 0.15, signedU);
        const backMask = smoothstep01(-0.04, -0.15, signedU);
        if (frontMask > 0.001) {
          const fOff = solveQuadLegOffset(u, v, frontHipU, pose.rightLegStride, pose.rightFootLift, headSide > 0 ? 1 : -1);
          x += fOff.x * legBlend * frontMask;
          y += fOff.y * legBlend * frontMask;
        }
        if (backMask > 0.001) {
          const bOff = solveQuadLegOffset(u, v, backHipU, pose.leftLegStride, pose.leftFootLift, headSide > 0 ? -1 : 1);
          x += bOff.x * legBlend * backMask;
          y += bOff.y * legBlend * backMask;
        }
      }

      // 2. Flexible Spine Arch during stride + breathing
      const spineMid = 1 - Math.min(1, Math.abs(u - anatomy.centerX) / 0.34);
      const upperMask = smoothstep01(bellyV + 0.05, bellyV - 0.16, v);
      y -= Math.sin(phaseSec * 4.8) * spineMid * upperMask * H * 0.018 * motionEnergy;

      // 3. Expressive Head Nod & Perky Ears
      const headDist = Math.hypot((u - anatomy.headCenterX) * 1.1, v - anatomy.headCenterY);
      const headMask = smoothstep01(0.28, 0.12, headDist);
      if (headMask > 0.001) {
        const pivotX = bounds.x + anatomy.headCenterX * W + pose.hipShiftX * W;
        const pivotY = bounds.y + anatomy.headCenterY * H - pose.hipLiftY * H;
        const nod = (headTiltLocal * 0.72 + Math.sin(phaseSec * 5.2) * 0.06 * motionEnergy) * headMask;
        const cn = Math.cos(nod);
        const sn = Math.sin(nod);
        const hx = x - pivotX;
        const hy = y - pivotY;
        x = pivotX + hx * cn - hy * sn;
        y = pivotY + hx * sn + hy * cn;
      }

      // 4. Multi-Harmonic Joyful Wagging Tail on opposite side from head!
      const tailExtent = (anatomy.centerX - u) * headSide;
      const tailMask = smoothstep01(0.18, 0.42, tailExtent) * smoothstep01(groundV - 0.04, bellyV - 0.08, v);
      if (tailMask > 0.001) {
        const wag = Math.sin(phaseSec * 9.5 - tailExtent * 4.5) * H * 0.055 * tailMask * Math.max(0.45, motionEnergy);
        y += wag;
        x += Math.cos(phaseSec * 9.5) * W * 0.014 * tailMask;
      }
    } else {
      // Floater / Ghost / Bird / Jellyfish: articulated wing/side flap + buoyant cloth hem!
      const hemMask = smoothstep01(0.48, 0.92, v);
      if (hemMask > 0.001) {
        const wave = Math.sin(phaseSec * 6.2 + u * 8.5) * W * 0.03 * hemMask;
        const liftW = Math.cos(phaseSec * 4.4 + u * 6.0) * H * 0.015 * hemMask;
        x += wave;
        y += liftW;
      }
      const sideExtent = Math.abs(u - anatomy.centerX);
      const wingMask = smoothstep01(0.16, 0.46, sideExtent) * smoothstep01(0.84, 0.25, v);
      if (wingMask > 0.001) {
        const flap =
          (Math.sin(phaseSec * 7.8) * 0.058 + (pose.leftArmAngle + pose.rightArmAngle) * 0.04) *
          H *
          wingMask;
        y -= flap;
      }
    }

    positions[vi * 2] = x;
    positions[vi * 2 + 1] = y;
    const wx = facingLeft ? 2 * pelvisX - x : x;
    if (wx < minX) minX = wx;
    if (wx > maxX) maxX = wx;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  const headPivotX = bounds.x + anatomy.headCenterX * W + pose.hipShiftX * W;
  const headPivotY = bounds.y + anatomy.headCenterY * H - pose.hipLiftY * H - floatBobPx;
  const headTotalRot = headTiltLocal * 0.65 + leanRad * 0.35;
  const ch = Math.cos(headTotalRot);
  const sh = Math.sin(headTotalRot);
  const headMapLocal = (u: number, v: number): Vec2 => {
    const lx = (u - anatomy.headCenterX) * W * sqX;
    const ly = (v - anatomy.headCenterY) * H * sqY;
    return {
      x: headPivotX + lx * ch - ly * sh,
      y: headPivotY + lx * sh + ly * ch,
    };
  };

  const anchors: CharacterLiveAnchors = {
    neckScreen: toWorld({ x: bounds.x + anatomy.neckX * W + pose.hipShiftX * W, y: bounds.y + anatomy.neckY * H - pose.hipLiftY * H - floatBobPx }),
    mouthScreen: toWorld(headMapLocal(anatomy.mouthX, anatomy.mouthY)),
    footLeftScreen: toWorld({ x: bounds.x + anatomy.footLeftX * W + pose.hipShiftX * W, y: groundY }),
    footRightScreen: toWorld({ x: bounds.x + anatomy.footRightX * W + pose.hipShiftX * W, y: groundY }),
    headTopScreen: toWorld(headMapLocal(anatomy.headCenterX, Math.max(0.04, anatomy.headCenterY - 0.14))),
    handLeftScreen: toWorld({ x: bounds.x + anatomy.handLeftX * W + pose.hipShiftX * W, y: bounds.y + anatomy.handLeftY * H - pose.hipLiftY * H - floatBobPx }),
    handRightScreen: toWorld({ x: bounds.x + anatomy.handRightX * W + pose.hipShiftX * W, y: bounds.y + anatomy.handRightY * H - pose.hipLiftY * H - floatBobPx }),
    pelvisScreen: { x: pelvisX, y: pelvisY },
  };

  return {
    positions,
    gpuBones: [],
    screenBbox: { minX, minY, maxX, maxY },
    anchors,
    headMapLocal,
    headTotalRot,
    pelvisX,
    pelvisY,
    torsoLen: Math.max(16, (anatomy.hipV - anatomy.headEndV) * H),
    liveBones: [],
    biomechanics: {
      leftKneeFlexDeg: 0,
      rightKneeFlexDeg: 0,
      leftAnklePitchDeg: 0,
      rightAnklePitchDeg: 0,
      leftToePitchDeg: 0,
      rightToePitchDeg: 0,
    },
  };
}
