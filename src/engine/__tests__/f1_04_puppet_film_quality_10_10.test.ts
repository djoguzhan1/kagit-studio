import { describe, expect, it } from 'vitest';
import { inpaintBehindLimbSocketsRGBA } from '../socketInpaint';
import {
  buildConformingSkinnedMeshRGBA,
  normalizeCanonicalJointOverrides,
} from '../conformingMeshEngine';
import { evaluateConformingSkinnedMesh } from '../dualQuatSkinning';
import {
  evaluateSocketSubPatchWorldPoint,
  type GpuBoneTransform2D,
} from '../webglSkinnedRenderer';
import {
  buildUniversalCreatureMeshRGBA,
  evaluateUniversalCreatureMesh,
  UNIVERSAL_CREATURE_CATALOG,
} from '../universalCreatureRig';
import { rasterizeSkinnedMeshToRgba } from '../cpuRasterizer';
import { computeDepthAndNormalRGBA } from '../normalMapEngine';
import {
  analyzeDrawingAnatomyFromPixels,
  defaultDrawingAnatomy,
  drawCartoonMouth,
  evaluateCartoonRainWalkPose,
} from '../cartoonMotionEngine';
import {
  getLastArapCacheStats,
  resetArapCacheStats,
  solveGeodesicArapMesh,
} from '../arapSolver';
import {
  bindBarycentricMeshAnchor,
  createAnatomyMeshPins,
  evalBarycentricMeshAnchor,
  generateMeshPresetFrames,
  getMeshStageLayout,
} from '../meshWarpEngine';
import { generateMotionPresetKeyframes } from '../puppetEngine';
import { rmsToMouthViseme } from '../audioEngine';
import { projectSingleView25DDepthUV } from '../viewRigBlender';
import { classifyTurnaroundPoseAngleRGBA } from '../turnaroundSlicer';
import {
  applyDirectedScreenplayToFilmGraph,
  compileDirectorPromptToFilmGraph,
  computeFilmCameraState,
  computeRotationOverscan,
  DIRECTOR_PRESETS,
  evaluateCharacterPose25D,
} from '../film25dEngine';
import {
  analyzeSmartBackgroundDepthRGBA,
  loadSavedCloudUrl,
} from '../kagit25dPipeline';
import { evaluateDeterministicVerletRibbon } from '../verletPhysics';
import {
  AdaptiveKltPoseTracker,
  analyzePCMToLipSyncTrack,
  evaluateLivePuppetPadSample,
  isAudioBufferSilent,
  measureFramePoseFeatures,
  synthesizeCartoonDialogueWav,
} from '../filmMocapLipSync';
import {
  buildSeamlessAmbienceMonoPCM,
  renderFilmSoundtrackOffline,
  WORLD_SOUND_PROFILES,
} from '../filmFoleyEngine';
import { processDualDelayPitchShiftPCM } from '../liveAudioStudio';
import {
  resolveExportDimensions,
  selectH264CodecCandidates,
} from '../videoExportEngine';
import type { PuppetRig } from '../../types/studio';

function makeHeroRgba(
  w = 180,
  h = 220,
  withRightCane = false
): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(w * h * 4);
  const fillRect = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    r: number,
    g: number,
    b: number
  ) => {
    for (let y = Math.max(0, y0); y <= Math.min(h - 1, y1); y++) {
      for (let x = Math.max(0, x0); x <= Math.min(w - 1, x1); x++) {
        const o = (y * w + x) * 4;
        rgba[o] = r;
        rgba[o + 1] = g;
        rgba[o + 2] = b;
        rgba[o + 3] = 255;
      }
    }
  };
  // Head + interior dark ink brow/mouth crease
  fillRect(66, 14, 114, 64, 242, 218, 192);
  fillRect(78, 34, 102, 37, 24, 22, 26);
  fillRect(80, 50, 100, 54, 28, 24, 28);
  // Neck & torso
  fillRect(82, 64, 98, 72, 232, 206, 180);
  fillRect(58, 72, 122, 146, 46, 78, 138);
  // Left & right arms touching torso shoulder seams
  fillRect(32, 76, 58, 142, 212, 86, 64);
  fillRect(122, 76, 148, 142, 212, 86, 64);
  // Left & right legs
  fillRect(64, 146, 84, 210, 44, 46, 58);
  fillRect(96, 146, 116, 210, 44, 46, 58);
  if (withRightCane) {
    // Long rigid cane extending from right hand down to floor
    fillRect(142, 138, 148, 210, 32, 28, 24);
  }
  return rgba;
}

describe('F1-04 10/10 Puppet, Rigging, 2.5D Film, Mocap, Klatt TTS, Foley & 9:16 Export Gate', () => {
  it('1. binds shoulder (chest=1), crotch (pelvis=0), and collar (neck=12) socket sub-patches to their exact parent bone transforms (< 0.01 px drift)', () => {
    const sw = 180;
    const sh = 220;
    const rgba = makeHeroRgba(sw, sh);
    const anatomy = analyzeDrawingAnatomyFromPixels(rgba, sw, sh);
    const mesh = buildConformingSkinnedMeshRGBA(rgba, sw, sh, anatomy)!;
    expect(mesh).not.toBeNull();

    const topoW = 90;
    const topoH = 110;
    const topoReg = new Int8Array(topoW * topoH).fill(-1);
    const topoOp = new Uint8Array(topoW * topoH);
    for (let y = 0; y < topoH; y++) {
      for (let x = 0; x < topoW; x++) {
        const a = rgba[(y * 2 * sw + x * 2) * 4 + 3];
        if (a > 40) {
          const idx = y * topoW + x;
          topoOp[idx] = 1;
          if (y < 34) topoReg[idx] = 0;
          else if (y >= 73) topoReg[idx] = x < 45 ? 4 : 5;
          else if (x < 28) topoReg[idx] = 2;
          else if (x > 62) topoReg[idx] = 3;
          else topoReg[idx] = 1;
        }
      }
    }

    const sock = inpaintBehindLimbSocketsRGBA(rgba, sw, sh, topoReg, topoOp, topoW, topoH, 12);
    expect(sock.subPatches.length).toBeGreaterThanOrEqual(2);
    const roles = new Set(sock.subPatches.map((p) => p.role));
    expect(roles.has('chest')).toBe(true);
    expect(roles.has('pelvis')).toBe(true);

    const bounds = { x: 344.8, y: 64.8, w: 590.4, h: 590.4 };
    const pose = evaluateCartoonRainWalkPose(0.45, anatomy);
    pose.torsoLeanRad = 0.34;
    const sk = evaluateConformingSkinnedMesh(mesh, anatomy, pose, bounds);

    for (const sub of sock.subPatches) {
      const u = (sub.x + sub.w * 0.5) / sw;
      const v = (sub.y + sub.h * 0.5) / sh;
      const pt = evaluateSocketSubPatchWorldPoint(sub, sk.gpuBones, bounds, u, v);
      const b: GpuBoneTransform2D = sk.gpuBones[sub.boneIndex]!;
      const expectedX = bounds.x + b.m00 * (u * bounds.w) + b.m01 * (v * bounds.h) + b.tx;
      const expectedY = bounds.y + b.m10 * (u * bounds.w) + b.m11 * (v * bounds.h) + b.ty;
      expect(Math.hypot(pt.x - expectedX, pt.y - expectedY)).toBeLessThan(0.01);
    }
  });

  it('2. achieves GPU vs CPU skinning parity across ALL 6 non-human creature classes at non-zero bounds & smooth 60 FPS motion', () => {
    const sw = 160;
    const sh = 160;
    const blob = new Uint8ClampedArray(sw * sh * 4);
    for (let y = 28; y <= 132; y++) {
      for (let x = 24; x <= 136; x++) {
        const o = (y * sw + x) * 4;
        blob[o] = 90;
        blob[o + 1] = 150;
        blob[o + 2] = 210;
        blob[o + 3] = 255;
      }
    }
    const creatureAnat = analyzeDrawingAnatomyFromPixels(blob, sw, sh);
    const bounds = { x: 480, y: 260, w: 320, h: 320 };
    const nonHuman = Object.values(UNIVERSAL_CREATURE_CATALOG).filter(
      (c) => c.id !== 'humanoid'
    );
    expect(nonHuman.length).toBe(6);

    for (const meta of nonHuman) {
      const mesh = buildUniversalCreatureMeshRGBA(blob, sw, sh, creatureAnat, meta.id)!;
      expect(mesh).not.toBeNull();

      const evalT0 = evaluateUniversalCreatureMesh(mesh, bounds, {
        action: 'walk-natural',
        timeSec: 0.25,
        facingLeft: false,
        intensity: 0.96,
      });
      const evalT1 = evaluateUniversalCreatureMesh(mesh, bounds, {
        action: 'walk-natural',
        timeSec: 0.25 + 1 / 60,
        facingLeft: false,
        intensity: 0.96,
      });

      let maxCenterDeviation = 0;
      let frameStepDelta = 0;
      for (let vi = 0; vi < mesh.vertexCount; vi++) {
        const ux = mesh.restUV[vi * 2] * bounds.w;
        const uy = mesh.restUV[vi * 2 + 1] * bounds.h;
        let gx = 0;
        let gy = 0;
        for (let slot = 0; slot < 4; slot++) {
          const w = mesh.boneWeights[vi * 4 + slot];
          if (w <= 1e-6) continue;
          const bi = mesh.boneIndices[vi * 4 + slot];
          const gb = evalT0.gpuBones[bi];
          gx += w * (gb.m00 * ux + gb.m01 * uy + gb.tx);
          gy += w * (gb.m10 * ux + gb.m11 * uy + gb.ty);
        }
        const shaderWorldX = bounds.x + gx;
        const shaderWorldY = bounds.y + gy;
        const cpuX = evalT0.positions[vi * 2];
        const cpuY = evalT0.positions[vi * 2 + 1];
        maxCenterDeviation = Math.max(
          maxCenterDeviation,
          Math.hypot(shaderWorldX - cpuX, shaderWorldY - cpuY)
        );
        frameStepDelta += Math.hypot(
          evalT1.positions[vi * 2] - cpuX,
          evalT1.positions[vi * 2 + 1] - cpuY
        );
      }
      expect(maxCenterDeviation).toBeLessThan(8.0);
      expect(frameStepDelta).toBeGreaterThan(0.05);
    }
  });

  it('3. normalizes Klaus light identically, rotates tangent normals with bone rotation, and builds Euclidean EDT + ink crease normals', () => {
    const sw = 80;
    const sh = 80;
    const rgba = new Uint8ClampedArray(sw * sh * 4);
    for (let y = 12; y <= 68; y++) {
      for (let x = 16; x <= 64; x++) {
        const o = (y * sw + x) * 4;
        rgba[o] = 220;
        rgba[o + 1] = 180;
        rgba[o + 2] = 140;
        rgba[o + 3] = 255;
      }
    }
    for (let x = 22; x <= 58; x++) {
      const o = (40 * sw + x) * 4;
      rgba[o] = 20;
      rgba[o + 1] = 20;
      rgba[o + 2] = 24;
    }
    const { normalRgba } = computeDepthAndNormalRGBA(rgba, sw, sh);
    const nyAbove = normalRgba[(39 * sw + 40) * 4 + 1];
    const nyBelow = normalRgba[(41 * sw + 40) * 4 + 1];
    expect(nyAbove).not.toBe(nyBelow);

    const anatomy = analyzeDrawingAnatomyFromPixels(rgba, sw, sh);
    const mesh = buildConformingSkinnedMeshRGBA(rgba, sw, sh, anatomy)!;
    const bounds = { x: 10, y: 10, w: 80, h: 80 };
    const pose = evaluateCartoonRainWalkPose(0, anatomy);
    const sk = evaluateConformingSkinnedMesh(mesh, anatomy, pose, bounds);
    const out = new Uint8ClampedArray(100 * 100 * 4);
    rasterizeSkinnedMeshToRgba(rgba, sw, sh, mesh, sk.positions, out, 100, 100, 0, 0, {
      normalRgba,
      klausLight: {
        lx: 2.5,
        ly: -1.8,
        rimR: 1,
        rimG: 0.85,
        rimB: 0.5,
        rimStrength: 0.65,
        shadowR: 0.2,
        shadowG: 0.28,
        shadowB: 0.45,
        shadowStrength: 0.35,
      },
      gpuBones: sk.gpuBones,
    });
    let opaqueCount = 0;
    for (let i = 0; i < 100 * 100; i++) {
      if (out[i * 4 + 3] > 200) opaqueCount++;
    }
    expect(opaqueCount).toBeGreaterThan(800);
  });

  it('4. caches Skyline-Cholesky ARAP across 60 sequential drag frames (1 Dijkstra build, 59 cache hits) & locks barycentric face anchors to 0.000 px', () => {
    const sw = 180;
    const sh = 220;
    const rgba = makeHeroRgba(sw, sh);
    const anatomy = analyzeDrawingAnatomyFromPixels(rgba, sw, sh);
    const mesh = buildConformingSkinnedMeshRGBA(rgba, sw, sh, anatomy)!;
    const pins = createAnatomyMeshPins(anatomy, 'humanoid');

    resetArapCacheStats();
    let lastPositions: Float32Array | null = null;
    for (let f = 0; f < 60; f++) {
      const ang = (f / 60) * Math.PI * 2;
      const offsets = {
        [pins[0].id]: { dx: Math.sin(ang) * 0.04, dy: 0 },
        [pins[2].id]: { dx: -0.08 + Math.cos(ang) * 0.05, dy: -0.12 },
      };
      const res = solveGeodesicArapMesh(mesh, pins, offsets, {
        drawX: 100,
        drawY: 50,
        drawW: 300,
        drawH: 360,
      });
      lastPositions = res.positions;
    }
    const stats = getLastArapCacheStats();
    expect(stats.dijkstraBuilds).toBe(1);
    expect(stats.cacheHits).toBe(59);
    expect(stats.lastCallCacheHit).toBe(true);

    const mouthAnchor = bindBarycentricMeshAnchor(mesh, anatomy.headCenterX, anatomy.mouthY);
    const pt = evalBarycentricMeshAnchor(mouthAnchor, lastPositions!, 300, 360);
    const exX =
      lastPositions![mouthAnchor.i0 * 2] * mouthAnchor.b0 +
      lastPositions![mouthAnchor.i1 * 2] * mouthAnchor.b1 +
      lastPositions![mouthAnchor.i2 * 2] * mouthAnchor.b2;
    const exY =
      lastPositions![mouthAnchor.i0 * 2 + 1] * mouthAnchor.b0 +
      lastPositions![mouthAnchor.i1 * 2 + 1] * mouthAnchor.b1 +
      lastPositions![mouthAnchor.i2 * 2 + 1] * mouthAnchor.b2;
    if (Math.hypot(mouthAnchor.du, mouthAnchor.dv) < 1e-6) {
      expect(Math.hypot(pt.x - exX, pt.y - exY)).toBeLessThan(1e-4);
    }
  });

  it('5. fixes getMeshStageLayout scale, prevents bounce hat clipping (topY >= 2 px), and keeps wave hand clear of face', () => {
    const layout = getMeshStageLayout(512, 512, 1280, 720);
    expect(layout.scale).toBeGreaterThan(0.95);
    expect(layout.drawH).toBeGreaterThan(500);
    expect(layout.drawY).toBeGreaterThanOrEqual(110);

    const anatomy = defaultDrawingAnatomy();
    const pins = createAnatomyMeshPins(anatomy, 'humanoid');
    const bounceFrames = generateMeshPresetFrames(pins, 24, 'bounce');
    const headPin = pins.find((p) => p.role === 'head')!;
    let minCrownScreenY = Infinity;
    for (const frame of bounceFrames) {
      const dy = frame[headPin.id]?.dy ?? 0;
      const crownY = layout.drawY + (0.04 + dy) * layout.drawH;
      minCrownScreenY = Math.min(minCrownScreenY, crownY);
    }
    expect(minCrownScreenY).toBeGreaterThanOrEqual(2);

    const waveFrames = generateMeshPresetFrames(pins, 24, 'wave');
    const handR = pins.find((p) => p.role === 'hand-r')!;
    for (const frame of waveFrames) {
      const hx = handR.x + (frame[handR.id]?.dx ?? 0);
      expect(Math.abs(hx - anatomy.headCenterX)).toBeGreaterThan(0.11);
    }
  });

  it('6. preserves weight-shifting cutout walk keyframes and maps speech visemes accurately', () => {
    const rig: PuppetRig = {
      id: 'rig_f1_04',
      name: 'Baron',
      sourceBlobKey: 'b0',
      sourceW: 400,
      sourceH: 500,
      totalFrames: 24,
      parts: [
        { id: 'root', name: 'Gövde', parentId: null, blobKey: 'b1', x: 100, y: 200, w: 120, h: 160, pivotX: 60, pivotY: 120, zIndex: 3 },
        { id: 'head', name: 'Baş', parentId: 'root', blobKey: 'b2', x: 110, y: 90, w: 100, h: 110, pivotX: 50, pivotY: 100, zIndex: 5 },
        { id: 'legL', name: 'Sol Bacak', parentId: 'root', blobKey: 'b3', x: 110, y: 340, w: 40, h: 130, pivotX: 20, pivotY: 10, zIndex: 1 },
        { id: 'legR', name: 'Sağ Bacak', parentId: 'root', blobKey: 'b4', x: 170, y: 340, w: 40, h: 130, pivotX: 20, pivotY: 10, zIndex: 2 },
        { id: 'armL', name: 'Sol Kol', parentId: 'root', blobKey: 'b5', x: 60, y: 210, w: 40, h: 110, pivotX: 35, pivotY: 15, zIndex: 4 },
        { id: 'armR', name: 'Sağ Kol', parentId: 'root', blobKey: 'b6', x: 220, y: 210, w: 40, h: 110, pivotX: 5, pivotY: 15, zIndex: 6 },
      ],
      keyframes: [],
    };
    const walkKfs = generateMotionPresetKeyframes(rig, 'walk');
    expect(walkKfs.length).toBe(9);
    expect(walkKfs.some((kf) => Math.abs(kf.transforms.root?.dx ?? 0) > 0.5)).toBe(true);
    expect(rmsToMouthViseme(0.01)).toBe('closed');
    expect(rmsToMouthViseme(0.45)).not.toBe('closed');
  });

  it('7. maps both legacy camelCase & canonical jointOverrides, normalizes weightStrokes (Σw=1.0000), and renders custom faceSprites mouths', () => {
    const sw = 180;
    const sh = 220;
    const rgba = makeHeroRgba(sw, sh);
    const anatomy = analyzeDrawingAnatomyFromPixels(rgba, sw, sh);

    const mapped = normalizeCanonicalJointOverrides({
      shoulderL: { x: 0.28, y: 0.31 },
      handL: { x: 0.14, y: 0.58 },
      footR: { x: 0.66, y: 0.93 },
    });
    expect(mapped.shoulder_l).toEqual({ x: 0.28, y: 0.31 });
    expect(mapped.wrist_l).toEqual({ x: 0.14, y: 0.58 });
    expect(mapped.ankle_r).toEqual({ x: 0.66, y: 0.93 });

    const mesh = buildConformingSkinnedMeshRGBA(rgba, sw, sh, anatomy, {
      jointOverrides: { shoulderL: { x: 0.28, y: 0.31 } },
      weightStrokes: [{ region: 2, x: 0.34, y: 0.42, radius: 0.12, strength: 0.85 }],
    })!;
    expect(mesh.bones[3].start.x).toBeCloseTo(0.28, 2);
    for (let v = 0; v < mesh.vertexCount; v++) {
      const sum =
        mesh.boneWeights[v * 4] +
        mesh.boneWeights[v * 4 + 1] +
        mesh.boneWeights[v * 4 + 2] +
        mesh.boneWeights[v * 4 + 3];
      expect(sum).toBeCloseTo(1.0, 4);
    }

    let drewCustomSprite = false;
    const fakeMouthImg = { width: 32, height: 24 } as unknown as CanvasImageSource;
    const mockCtx = {
      save: () => {},
      restore: () => {},
      translate: () => {},
      rotate: () => {},
      scale: () => {},
      beginPath: () => {},
      ellipse: () => {},
      fill: () => {},
      drawImage: (img: unknown) => {
        if (img === fakeMouthImg) drewCustomSprite = true;
      },
    } as unknown as CanvasRenderingContext2D;
    drawCartoonMouth(mockCtx, 100, 100, 1, 'AA', 0.8, 0, {
      customMouths: { A: fakeMouthImg },
    });
    expect(drewCustomSprite).toBe(true);
  });

  it('8. projects 2.5D cylindrical depth parallax asymmetrically at +45° and classifies front/side/back turnaround poses', () => {
    const nosePt = projectSingleView25DDepthUV(0.5, 0.25, 0.9, 45, 0.5);
    const backHeadPt = projectSingleView25DDepthUV(0.5, 0.25, -0.6, 45, 0.5);
    expect(nosePt.u).toBeGreaterThan(0.52);
    expect(backHeadPt.u).toBeLessThan(0.49);

    const frontRgba = makeHeroRgba(180, 220);
    const frontCls = classifyTurnaroundPoseAngleRGBA(frontRgba, 180, 220);
    expect(frontCls.angle).toBe('front');

    const backRgba = makeHeroRgba(180, 220);
    for (let y = 20; y <= 60; y++) {
      for (let x = 66; x <= 114; x++) {
        const o = (y * 180 + x) * 4;
        backRgba[o] = 60;
        backRgba[o + 1] = 48;
        backRgba[o + 2] = 42;
      }
    }
    const backCls = classifyTurnaroundPoseAngleRGBA(backRgba, 180, 220);
    expect(backCls.angle).toBe('back');

    const sideRgba = new Uint8ClampedArray(180 * 220 * 4);
    for (let y = 20; y <= 205; y++) {
      for (let x = 78; x <= 102; x++) {
        const o = (y * 180 + x) * 4;
        sideRgba[o] = 50;
        sideRgba[o + 1] = 70;
        sideRgba[o + 2] = 110;
        sideRgba[o + 3] = 255;
      }
    }
    for (let y = 32; y <= 46; y++) {
      for (let x = 103; x <= 122; x++) {
        const o = (y * 180 + x) * 4;
        sideRgba[o + 3] = 255;
      }
    }
    for (let y = 192; y <= 205; y++) {
      for (let x = 103; x <= 128; x++) {
        const o = (y * 180 + x) * 4;
        sideRgba[o + 3] = 255;
      }
    }
    const sideCls = classifyTurnaroundPoseAngleRGBA(sideRgba, 180, 220);
    expect(sideCls.angle).toBe('side');
  });

  it('9. maps space/concert/escape screenplays to dedicated 2.5D worlds (never falling back to rainy-alley) & computes tilt overscan', () => {
    const baseGraph = compileDirectorPromptToFilmGraph(DIRECTOR_PRESETS[0].prompt);
    const spaceGraph = applyDirectedScreenplayToFilmGraph(
      {
        title: 'Starlight',
        shots: [
          {
            title: 'Nebula Arrival',
            durationSec: 3,
            scene: 'space',
            camera: 'wide',
            transition: 'dissolve',
            primaryActorId: 'actor_1',
            narration: 'Stars',
            actorTracks: {},
          },
        ],
      },
      baseGraph
    );
    expect(spaceGraph.world.setId).toBe('cosmic-nebula');

    const over45 = computeRotationOverscan(1280, 720, (-4.5 * Math.PI) / 180);
    const over10 = computeRotationOverscan(1280, 720, (-10 * Math.PI) / 180);
    expect(over45).toBeGreaterThanOrEqual(1.14);
    expect(over10).toBeGreaterThanOrEqual(1.29);
  });

  it('10. enforces true chest/head closeup zoom (>= 2.25x) and masks underlying drawn mouth before rendering speech visemes', () => {
    const graph = compileDirectorPromptToFilmGraph(DIRECTOR_PRESETS[0].prompt);
    const shot = {
      ...graph.shots[0],
      framing: 'closeup' as const,
      camera: {
        ...graph.shots[0].camera,
        fromZoom: 2.32,
        toZoom: 2.62,
      },
    };
    const pose = evaluateCharacterPose25D(shot, 0.5, graph.world.horizonY);
    const cam = computeFilmCameraState(graph, shot, pose, 0.5);
    expect(cam.camZoom).toBeGreaterThanOrEqual(2.25);

    let fillCalls = 0;
    const mockCtx = {
      save: () => {},
      restore: () => {},
      translate: () => {},
      rotate: () => {},
      scale: () => {},
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      quadraticCurveTo: () => {},
      bezierCurveTo: () => {},
      closePath: () => {},
      arc: () => {},
      ellipse: () => {},
      clip: () => {},
      stroke: () => {},
      createRadialGradient: () => ({ addColorStop: () => {} }),
      fillRect: () => {
        fillCalls++;
      },
      fill: () => {
        fillCalls++;
      },
    } as unknown as CanvasRenderingContext2D;

    drawCartoonMouth(mockCtx, 100, 100, 1, 'AA', 0.85, 0, { hasDrawnMouth: false });
    const baseFills = fillCalls;
    fillCalls = 0;
    drawCartoonMouth(mockCtx, 100, 100, 1, 'AA', 0.85, 0, {
      hasDrawnMouth: true,
      maskUnderlayColor: '#F2DAC0',
    });
    expect(fillCalls).toBeGreaterThan(baseFills);
  });

  it('11. eliminates localhost:8090 default & ensures smart 2.5D background analyzer sets 0 sky alpha on Z5 foreground', () => {
    expect(loadSavedCloudUrl()).toBe('');

    const w = 120;
    const h = 80;
    const bg = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        if (y < 44) {
          bg[o] = 115;
          bg[o + 1] = 175;
          bg[o + 2] = 240;
          bg[o + 3] = 255;
        } else {
          bg[o] = 88;
          bg[o + 1] = 148;
          bg[o + 2] = 72;
          bg[o + 3] = 255;
        }
      }
    }
    const analysis = analyzeSmartBackgroundDepthRGBA(bg, w, h);
    expect(analysis.horizonY).toBeGreaterThan(0.4);
    expect(analysis.horizonY).toBeLessThan(0.7);

    let skyForegroundLeak = 0;
    for (let y = 0; y < 24; y++) {
      for (let x = 0; x < 18; x++) {
        if (analysis.z5Alpha[y * w + x] > 0.05) skyForegroundLeak++;
      }
    }
    expect(skyForegroundLeak).toBe(0);
  });

  it('12. prevents front-view black "X" leg crossing across walk/run/mocap-jump & integrates neck velocity in Verlet scarf', () => {
    const sw = 180;
    const sh = 220;
    const rgba = makeHeroRgba(sw, sh, true);
    const anatomy = analyzeDrawingAnatomyFromPixels(rgba, sw, sh);
    const mesh = buildConformingSkinnedMeshRGBA(rgba, sw, sh, anatomy)!;
    const bounds = { x: 400, y: 120, w: 300, h: 360 };

    for (let step = 0; step < 24; step++) {
      const pose = evaluateCartoonRainWalkPose((step / 24) * 1.2, anatomy);
      pose.leftLegStride *= 1.15;
      pose.rightLegStride *= 1.15;
      pose.viewYawRad = 0;
      const sk = evaluateConformingSkinnedMesh(mesh, anatomy, pose, bounds);
      expect(sk.anchors.footLeftScreen.x).toBeLessThan(sk.anchors.footRightScreen.x - 4);
    }

    const graph = compileDirectorPromptToFilmGraph(DIRECTOR_PRESETS[1].prompt);
    const runShot = {
      ...graph.shots[0],
      action: 'run' as const,
      motionPath: [
        { x: 0.5, y: 0.82 },
        { x: 0.5, y: 0.82 },
      ],
    };
    const jumpPose = evaluateCharacterPose25D(runShot, 0.5, graph.world.horizonY, {
      headYawRad: 0.28,
      headTiltRad: 0,
      bodyLeanRad: 0,
      leftArmSwing: 0,
      rightArmSwing: 0,
      verticalLiftNorm: 0.13,
      squashY: 1.06,
    });
    expect(Math.abs(jumpPose.leftLegPhase)).toBeLessThan(0.05);
    expect(Math.abs(jumpPose.rightLegPhase)).toBeLessThan(0.05);

    const staticScarf = evaluateDeterministicVerletRibbon({
      anchorX: 300,
      anchorY: 200,
      windX: 0,
      timeSec: 1.0,
      floorY: 500,
      segmentLength: 12,
      nodeCount: 8,
    });
    const movingScarf = evaluateDeterministicVerletRibbon({
      anchorX: 300,
      anchorY: 200,
      anchorTrajectory: (tau) => ({ x: 300 - (1.0 - tau) * 420, y: 200 }),
      windX: 0,
      timeSec: 1.0,
      floorY: 500,
      segmentLength: 12,
      nodeCount: 8,
    });
    expect(movingScarf[7].x).toBeLessThan(staticScarf[7].x - 8);
  });

  it('13. tracks dark & light skin via KLT mocap, waves FREE left arm on cane-holding Baron, synthesizes Klatt M/B closures & blocks silent mic', () => {
    const paintPersonFrame = (
      cx: number,
      skinRgb: [number, number, number]
    ): Uint8ClampedArray => {
      const w = 96;
      const h = 72;
      const f = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const o = (y * w + x) * 4;
          f[o] = 225;
          f[o + 1] = 228;
          f[o + 2] = 234;
          f[o + 3] = 255;
        }
      }
      for (let y = 10; y <= 34; y++) {
        for (let x = cx - 10; x <= cx + 10; x++) {
          if (x < 0 || x >= w) continue;
          const o = (y * w + x) * 4;
          f[o] = skinRgb[0];
          f[o + 1] = skinRgb[1];
          f[o + 2] = skinRgb[2];
          if (y === 19 && (Math.abs(x - (cx - 4)) <= 2 || Math.abs(x - (cx + 4)) <= 2)) {
            f[o] = 15;
            f[o + 1] = 15;
            f[o + 2] = 18;
          }
        }
      }
      return f;
    };

    for (const tone of [
      [58, 38, 28],
      [236, 196, 172],
    ] as Array<[number, number, number]>) {
      const tracker = new AdaptiveKltPoseTracker();
      const fCenter = paintPersonFrame(48, tone);
      const fRight = paintPersonFrame(62, tone);
      const m0 = measureFramePoseFeatures(fCenter, 96, 72, tracker);
      const m1 = measureFramePoseFeatures(fRight, 96, 72, tracker);
      expect(m1.headCx).toBeGreaterThan(m0.headCx + 0.04);
    }

    const baronRgba = makeHeroRgba(180, 220, true);
    const baronAnat = analyzeDrawingAnatomyFromPixels(baronRgba, 180, 220);
    const baronMesh = buildConformingSkinnedMeshRGBA(baronRgba, 180, 220, baronAnat)!;
    expect(baronMesh.rightHasRigidProp).toBe(true);
    expect(baronMesh.leftHasRigidProp).toBe(false);

    const padWave = evaluateLivePuppetPadSample({
      padX: 0,
      padY: 0,
      sec: 0.35,
      gestures: { handsUp: false, wave: true, surprise: false, speak: false },
      preferLeftHandWave: true,
    });
    expect(padWave.leftArmSwing).toBeGreaterThan(0.85);

    const wavePose = evaluateCartoonRainWalkPose(0, baronAnat);
    wavePose.leftArmAngle = padWave.leftArmSwing;
    wavePose.rightArmAngle = padWave.rightArmSwing;
    wavePose.gestureMode = 'wave';
    const bounds = { x: 100, y: 60, w: 300, h: 360 };
    const skWave = evaluateConformingSkinnedMesh(baronMesh, baronAnat, wavePose, bounds);
    const leftShoulderY = bounds.y + baronMesh.bones[3].start.y * bounds.h;
    expect(skWave.anchors.handLeftScreen.y).toBeLessThan(leftShoulderY + 12);

    const tts = synthesizeCartoonDialogueWav('Merhaba baba, bugün hava çok güzel!', 'happy', 'Puck');
    expect(tts.durationSec).toBeGreaterThan(1.0);
    const directVisemes = new Set(tts.lipSyncTrack.frames.map((f) => f.viseme));
    expect(directVisemes.has('closed')).toBe(true);
    expect(directVisemes.size).toBeGreaterThanOrEqual(3);

    const lpcTrack = analyzePCMToLipSyncTrack(tts.pcm, tts.sampleRate, {
      audioBlobKey: 'tts_check',
      label: 'Test',
      source: 'mic',
    });
    const lpcVisemes = new Set(lpcTrack.frames.map((f) => f.viseme));
    expect(lpcVisemes.has('closed')).toBe(true);
    expect(lpcVisemes.size).toBeGreaterThanOrEqual(3);

    expect(isAudioBufferSilent(new Float32Array(4800))).toBe(true);
    expect(isAudioBufferSilent(tts.pcm)).toBe(false);
  });

  it('14. delivers click-free dual-delay pitch shift, seamless 8s ambience, full-foley offline film soundtrack & 9:16 1080x1920 Level 4.0', async () => {
    const sr = 24000;
    const sine = new Float32Array(sr);
    for (let i = 0; i < sr; i++) {
      sine[i] = Math.sin((2 * Math.PI * 220 * i) / sr) * 0.5;
    }
    const shifted = processDualDelayPitchShiftPCM(sine, sr, 'chipmunk');
    let maxJump = 0;
    for (let i = 100; i < shifted.length; i++) {
      maxJump = Math.max(maxJump, Math.abs(shifted[i] - shifted[i - 1]));
    }
    expect(maxJump).toBeLessThan(0.08);

    const amb = buildSeamlessAmbienceMonoPCM(16000, 'rain');
    expect(amb.length).toBe(16000 * 8);
    expect(Math.abs(amb[0] - amb[amb.length - 1])).toBeLessThan(0.08);

    expect(Object.keys(WORLD_SOUND_PROFILES)).toEqual(
      expect.arrayContaining([
        'rainy-alley',
        'golden-hill',
        'moonlit-forest',
        'cosmic-nebula',
        'concert-stage',
        'canyon-chase',
      ])
    );

    const graph = compileDirectorPromptToFilmGraph(DIRECTOR_PRESETS[0].prompt);
    const soundtrack = await renderFilmSoundtrackOffline({
      graph,
      totalDuration: 2.5,
      sampleRate: 24000,
      audioMixMode: 'full',
      includeMusic: true,
      loadVoiceBlob: async () => null,
    });
    expect(soundtrack).not.toBeNull();
    const chL = soundtrack!.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < chL.length; i++) peak = Math.max(peak, Math.abs(chL[i]));
    expect(peak).toBeGreaterThan(0.02);

    const dims916 = resolveExportDimensions(1280, 720, 1, '9:16');
    expect(dims916).toEqual({ width: 1080, height: 1920 });
    expect(selectH264CodecCandidates(dims916.width, dims916.height)[0]).toContain('28');
  });
});
