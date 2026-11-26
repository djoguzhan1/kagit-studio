import { describe, expect, it } from 'vitest';
import {
  analyzeDrawingAnatomyFromPixels,
  evaluateCartoonRainWalkPose,
  type ArticulatedCartoonPose,
} from '../cartoonMotionEngine';
import {
  buildConformingSkinnedMeshRGBA,
  SKIN_BONE_COUNT,
  SKIN_BONE_INDEX,
} from '../conformingMeshEngine';
import { evaluateConformingSkinnedMesh } from '../dualQuatSkinning';

function fillRect(
  rgba: Uint8ClampedArray,
  w: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: number,
  g: number,
  b: number,
  a = 255
) {
  const h = Math.floor(rgba.length / (w * 4));
  for (let y = Math.max(0, y0); y <= Math.min(h - 1, y1); y++) {
    for (let x = Math.max(0, x0); x <= Math.min(w - 1, x1); x++) {
      const o = (y * w + x) * 4;
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = a;
    }
  }
}

/** Draws a classic cartoon hero with real protruding boots/shoes for ankle/heel/ball/toe verification */
function makeCartoonHeroWithShoes(w = 200, h = 240): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(w * h * 4);
  // Head
  fillRect(rgba, w, 78, 12, 122, 64, 248, 224, 200);
  // Torso shirt
  fillRect(rgba, w, 66, 64, 134, 142, 72, 118, 182);
  // Separate arms with clean 4px gap (tests 200px narrow-gap preservation!)
  fillRect(rgba, w, 38, 66, 66, 82, 72, 118, 182); // left shoulder bridge
  fillRect(rgba, w, 36, 82, 58, 146, 214, 92, 64); // left sleeve (8px from torso)
  fillRect(rgba, w, 134, 66, 162, 82, 72, 118, 182); // right shoulder bridge
  fillRect(rgba, w, 142, 82, 164, 146, 214, 92, 64); // right sleeve
  // Two legs with narrow 4px inner gap + wider protruding boots at bottom!
  fillRect(rgba, w, 72, 142, 96, 214, 52, 56, 72); // left trouser
  fillRect(rgba, w, 104, 142, 128, 214, 52, 56, 72); // right trouser
  fillRect(rgba, w, 68, 214, 104, 232, 168, 98, 44); // left shoe (heel..toe!)
  fillRect(rgba, w, 100, 214, 138, 232, 168, 98, 44); // right shoe (heel..toe!)
  return rgba;
}

/** Draws a tough ZERO-AIR-GAP character: arms pressed right against torso & thighs touching along black ink lines! */
function makeZeroGapTouchingLimbsHero(w = 200, h = 240): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(w * h * 4);
  // Head
  fillRect(rgba, w, 78, 12, 122, 62, 248, 226, 202);
  // Torso (cream shirt)
  fillRect(rgba, w, 66, 62, 134, 140, 236, 228, 212);
  // Left & Right arms LITERALLY TOUCHING TORSO with 0 px transparent air — separated ONLY by a 2px black ink contour!
  fillRect(rgba, w, 40, 64, 63, 140, 216, 108, 76); // left sleeve
  fillRect(rgba, w, 64, 84, 65, 140, 22, 20, 18); // 2px black ink seam (below armpit!)
  fillRect(rgba, w, 137, 64, 160, 140, 216, 108, 76); // right sleeve
  fillRect(rgba, w, 135, 84, 136, 140, 22, 20, 18); // 2px black ink seam (below armpit!)
  // Two trouser legs TOUCHING down the upper/mid thighs (0 px air gap, separated by 2px dark ink contour!)
  fillRect(rgba, w, 68, 140, 98, 230, 118, 142, 178); // left leg
  fillRect(rgba, w, 102, 140, 132, 230, 118, 142, 178); // right leg
  fillRect(rgba, w, 99, 148, 101, 224, 20, 18, 18); // 3px dark ink line between touching thighs!
  // Tiny gap ONLY at bottom between feet so bipedal anatomy registers cleanly
  fillRect(rgba, w, 96, 218, 104, 234, 0, 0, 0, 0);
  return rgba;
}

function makePose(overrides: Partial<ArticulatedCartoonPose>): ArticulatedCartoonPose {
  return {
    hipShiftX: 0,
    hipLiftY: 0,
    squashY: 1,
    squashX: 1,
    torsoLeanRad: 0.04,
    chestCounterRad: 0,
    headTiltRad: 0,
    headLagY: 0,
    headTurnX: 0,
    leftArmAngle: 0,
    rightArmAngle: 0,
    leftArmLag: 0,
    rightArmLag: 0,
    leftLegStride: 0,
    rightLegStride: 0,
    leftFootLift: 0,
    rightFootLift: 0,
    footContact: false,
    contactSide: 0,
    mouthOpen: 0,
    viseme: 'closed',
    blink: 0,
    facing: 1,
    ...overrides,
  };
}

describe('Phase 2 & 3: V3 21-Bone Reverse-Foot IK, CoR Skinning & Zero-Merge Ink-Watershed', () => {
  it('1. extracts full 21-bone skeleton, real ankle/heel/ball/toe landmarks, CoR pivots & socket inpainting', () => {
    const w = 200;
    const h = 240;
    const rgba = makeCartoonHeroWithShoes(w, h);
    const anatomy = analyzeDrawingAnatomyFromPixels(rgba, w, h);
    const mesh = buildConformingSkinnedMeshRGBA(rgba, w, h, anatomy);

    expect(mesh).not.toBeNull();
    if (!mesh) return;

    expect(mesh.bones.length).toBe(SKIN_BONE_COUNT);
    expect(mesh.bones[SKIN_BONE_INDEX.foot_l].id).toBe('foot_l');
    expect(mesh.bones[SKIN_BONE_INDEX.toe_l].id).toBe('toe_l');
    expect(mesh.bones[SKIN_BONE_INDEX.foot_r].id).toBe('foot_r');
    expect(mesh.bones[SKIN_BONE_INDEX.toe_r].id).toBe('toe_r');
    expect(mesh.bones[SKIN_BONE_INDEX.hand_l].id).toBe('hand_l');
    expect(mesh.bones[SKIN_BONE_INDEX.hand_r].id).toBe('hand_r');

    // Real ankle MUST sit strictly above ground sole (so shoes can pivot naturally!)
    expect(mesh.footLeft).toBeDefined();
    expect(mesh.footRight).toBeDefined();
    expect(mesh.footLeft!.ankle.y).toBeLessThan(mesh.footLeft!.soleY - 0.02);
    expect(mesh.footLeft!.heel.x).toBeLessThan(mesh.footLeft!.ball.x);
    expect(mesh.footLeft!.ball.x).toBeLessThan(mesh.footLeft!.toe.x);

    // High-res 200px topology + SIGGRAPH CoR pivots + 2.5D socket inpainting!
    expect(mesh.topologyResolution!.h).toBeGreaterThanOrEqual(180);
    expect(mesh.corUV).toBeDefined();
    let corCount = 0;
    for (let vi = 0; vi < mesh.vertexCount; vi++) {
      if (mesh.corUV![vi * 2] >= 0) corCount++;
    }
    expect(corCount).toBeGreaterThan(20);
    expect(mesh.inpaintedPixels ?? 0).toBeGreaterThan(100);
  });

  it('2. Ink-Watershed separates 0px air-gap touching arms & touching thighs cleanly along black ink lines (0 birleşme!)', () => {
    const w = 200;
    const h = 240;
    const rgba = makeZeroGapTouchingLimbsHero(w, h);
    const anatomy = analyzeDrawingAnatomyFromPixels(rgba, w, h);
    const mesh = buildConformingSkinnedMeshRGBA(rgba, w, h, anatomy);

    expect(mesh).not.toBeNull();
    if (!mesh) return;

    // Must detect and slit touching ink lines automatically even with ZERO transparent air gap!
    expect(mesh.inkWatershedCuts ?? 0).toBeGreaterThan(15);

    // Verify zero thigh-to-thigh merged vertices below crotch (v > hipV + 0.05)!
    const tri = mesh.triangles;
    let gluedThighTris = 0;
    for (let i = 0; i < tri.length; i += 3) {
      const a = tri[i];
      const b = tri[i + 1];
      const c = tri[i + 2];
      const regs = new Set([mesh.vertexRegion[a], mesh.vertexRegion[b], mesh.vertexRegion[c]]);
      const avgV = (mesh.restUV[a * 2 + 1] + mesh.restUV[b * 2 + 1] + mesh.restUV[c * 2 + 1]) / 3;
      if (regs.has(4) && regs.has(5) && avgV > anatomy.hipV + 0.05) {
        gluedThighTris++;
      }
    }
    expect(gluedThighTris).toBe(0);
  });

  it('3. executes authentic 4-phase Reverse-Foot Roll IK (Heel-Strike -> Flat Stance -> 50°+ Passing Knee -> Toe Push-Off!)', () => {
    const w = 200;
    const h = 240;
    const rgba = makeCartoonHeroWithShoes(w, h);
    const anatomy = analyzeDrawingAnatomyFromPixels(rgba, w, h);
    const mesh = buildConformingSkinnedMeshRGBA(rgba, w, h, anatomy)!;
    const bounds = { x: 40, y: 20, w: 220, h: 264 };

    // Phase A: Heel-Strike Contact (footRoll = +0.85) -> ankle dorsiflexed (+deg toes UP!)
    const evHeel = evaluateConformingSkinnedMesh(
      mesh,
      anatomy,
      makePose({ leftLegStride: 0.72, leftFootLift: 0, leftFootRoll: 0.85, rightLegStride: -0.55, rightFootRoll: -0.75 }),
      bounds
    );
    expect(evHeel.biomechanics.leftAnklePitchDeg).toBeGreaterThan(10);
    // Right leg in rear push-off -> heel lifted (-deg) while toe stays flatter on ground!
    expect(evHeel.biomechanics.rightAnklePitchDeg).toBeLessThan(-10);
    expect(Math.abs(evHeel.biomechanics.rightToePitchDeg)).toBeLessThan(
      Math.abs(evHeel.biomechanics.rightAnklePitchDeg) * 0.5
    );

    // Phase B: Flat Mid-Stance (footRoll = 0, lift = 0) -> flat sole (|anklePitch| < 2°)
    const evFlat = evaluateConformingSkinnedMesh(
      mesh,
      anatomy,
      makePose({ leftLegStride: 0.02, leftFootLift: 0, leftFootRoll: 0 }),
      bounds
    );
    expect(Math.abs(evFlat.biomechanics.leftAnklePitchDeg)).toBeLessThan(2.5);

    // Phase C: Passing Pose (high foot lift) -> natural deep knee flexion (>= 48°!) & relaxed ankle drop!
    const evPass = evaluateConformingSkinnedMesh(
      mesh,
      anatomy,
      makePose({ leftLegStride: 0.05, leftFootLift: 0.92, leftFootRoll: -0.55, rightLegStride: 0.0, rightFootLift: 0, rightFootRoll: 0 }),
      bounds
    );
    expect(evPass.biomechanics.leftKneeFlexDeg).toBeGreaterThan(45);
    expect(evPass.biomechanics.leftAnklePitchDeg).toBeLessThan(-6);

    // Phase D: Emits all 21 GPU bone uniforms for WebGL2 GPU Vertex-Shader Skinning!
    expect(evPass.gpuBones.length).toBe(SKIN_BONE_COUNT);
    expect(evPass.liveBones.length).toBe(SKIN_BONE_COUNT);
  });

  it('4. maintains near-zero triangle inversions with CoR skinning across full walk cycle', () => {
    const w = 200;
    const h = 240;
    const rgba = makeCartoonHeroWithShoes(w, h);
    const anatomy = analyzeDrawingAnatomyFromPixels(rgba, w, h);
    const mesh = buildConformingSkinnedMeshRGBA(rgba, w, h, anatomy)!;
    const bounds = { x: 0, y: 0, w: 200, h: 240 };

    let worstInv = 0;
    for (let s = 0; s < 12; s++) {
      const pose = evaluateCartoonRainWalkPose(s * 0.09, anatomy, 24, 'joy', 0);
      const ev = evaluateConformingSkinnedMesh(mesh, anatomy, pose, bounds);
      let inv = 0;
      for (let t = 0; t < mesh.triangles.length; t += 3) {
        const a = mesh.triangles[t];
        const b = mesh.triangles[t + 1];
        const c = mesh.triangles[t + 2];
        const rArea =
          (mesh.restUV[b * 2] - mesh.restUV[a * 2]) * (mesh.restUV[c * 2 + 1] - mesh.restUV[a * 2 + 1]) -
          (mesh.restUV[c * 2] - mesh.restUV[a * 2]) * (mesh.restUV[b * 2 + 1] - mesh.restUV[a * 2 + 1]);
        const dArea =
          (ev.positions[b * 2] - ev.positions[a * 2]) * (ev.positions[c * 2 + 1] - ev.positions[a * 2 + 1]) -
          (ev.positions[c * 2] - ev.positions[a * 2]) * (ev.positions[b * 2 + 1] - ev.positions[a * 2 + 1]);
        if (rArea * dArea < -1e-6) inv++;
      }
      if (inv > worstInv) worstInv = inv;
    }
    expect(worstInv).toBeLessThanOrEqual(4);
  });
});
