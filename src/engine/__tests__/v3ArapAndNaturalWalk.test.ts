import { describe, expect, it } from 'vitest';
import { solveGeodesicArapMesh } from '../arapSolver';
import {
  analyzeDrawingAnatomyFromPixels,
  computeExactWalkGroundSpeedPx,
  evalNaturalFootRoll,
  evaluateCartoonDancePose,
  evaluateCartoonRainWalkPose,
} from '../cartoonMotionEngine';
import { buildSilhouetteConformingMeshRGBA } from '../conformingMeshEngine';
import {
  compileDirectorPromptToFilmGraph,
  computeMotionPathArcDistance,
  DIRECTOR_PRESETS,
  evaluateCharacterPose25D,
} from '../film25dEngine';
import type { MeshPin } from '../../types/studio';

function fillRect(rgba: Uint8ClampedArray, w: number, x0: number, y0: number, x1: number, y1: number) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const o = (y * w + x) * 4;
      rgba[o] = 44;
      rgba[o + 1] = 42;
      rgba[o + 2] = 48;
      rgba[o + 3] = 255;
    }
  }
}

describe('Phase 4: V3 Geodesic ARAP Zero-Merging Canlı Kukla & Natural Everyday Walk', () => {
  it('1. Geodesic ARAP moves dragged limb smoothly with 0.000px cross-air pull onto disconnected limb', () => {
    const w = 160;
    const h = 160;
    const rgba = new Uint8ClampedArray(w * h * 4);
    // Two completely separate vertical islands separated by 36px of transparent air!
    fillRect(rgba, w, 24, 30, 56, 130);   // Left island (u ~ 0.15..0.35)
    fillRect(rgba, w, 104, 30, 136, 130); // Right island (u ~ 0.65..0.85)

    const sil = buildSilhouetteConformingMeshRGBA(rgba, w, h)!;
    expect(sil).not.toBeNull();

    const pins: MeshPin[] = [
      { id: 'left_top', label: 'LTop', role: 'custom', x: 0.25, y: 0.25 },
      { id: 'left_bot', label: 'LBot', role: 'custom', x: 0.25, y: 0.78 },
    ];
    const offsets = {
      left_top: { dx: 0, dy: 0 },
      left_bot: { dx: 0.14, dy: -0.06 }, // Strong pull on left island!
    };
    const layout = { drawX: 0, drawY: 0, drawW: 200, drawH: 200 };
    const res = solveGeodesicArapMesh(sil, pins, offsets, layout, { iterations: 3 });

    let leftMovedMax = 0;
    let rightMovedMax = 0;
    for (let vi = 0; vi < sil.vertexCount; vi++) {
      const u = sil.restUV[vi * 2];
      const v = sil.restUV[vi * 2 + 1];
      const d = Math.hypot(res.positions[vi * 2] - u * 200, res.positions[vi * 2 + 1] - v * 200);
      if (u < 0.45) leftMovedMax = Math.max(leftMovedMax, d);
      else if (u > 0.55) rightMovedMax = Math.max(rightMovedMax, d);
    }
    // Left island responds strongly to dragged pin; right island across empty air moves 0.000 px (within Float32 ULP)!
    expect(leftMovedMax).toBeGreaterThan(20);
    expect(rightMovedMax).toBeLessThan(1e-4);
  });

  it('2. Natural Everyday Walk executes exact 4-phase ankle roll & calm non-exaggerated human kinematics', () => {
    // 4-Phase Reverse-Foot ankle curve checks
    expect(evalNaturalFootRoll(0.0)).toBeGreaterThan(0.75);      // Heel-strike dorsiflexion
    expect(Math.abs(evalNaturalFootRoll(0.22))).toBeLessThan(0.01); // 100% flat planted stance!
    expect(evalNaturalFootRoll(0.49)).toBeLessThan(-0.82);       // Ball/toe push-off heel lift!
    expect(evalNaturalFootRoll(0.72)).toBeLessThan(-0.35);       // Relaxed passing plantarflexion

    const rgba = new Uint8ClampedArray(120 * 160 * 4);
    fillRect(rgba, 120, 44, 12, 76, 48);
    fillRect(rgba, 120, 38, 48, 82, 102);
    fillRect(rgba, 120, 40, 102, 54, 152);
    fillRect(rgba, 120, 66, 102, 80, 152);
    const anatomy = analyzeDrawingAnatomyFromPixels(rgba, 120, 160);

    const danceNat = evaluateCartoonDancePose(0.25, null, 24, 'natural');
    expect(Math.abs(danceNat.hipLiftY)).toBeLessThanOrEqual(0.03); // Calm, non-exaggerated!
    expect(Math.abs(danceNat.leftArmAngle)).toBeLessThanOrEqual(0.55);
    expect(danceNat.leftFootRoll).toBeDefined();
    expect(danceNat.leftWristLag).toBeDefined();

    const walkNat = evaluateCartoonRainWalkPose(0.5, anatomy, 24, 'natural', 0);
    expect(Math.abs(walkNat.hipLiftY)).toBeLessThanOrEqual(0.032);
    expect(walkNat.leftFootRoll).toBeDefined();
    expect(walkNat.rightFootRoll).toBeDefined();

    const speedNat = computeExactWalkGroundSpeedPx(240, anatomy, 'natural');
    const speedSprint = computeExactWalkGroundSpeedPx(240, anatomy, 'sprint');
    expect(speedNat).toBeGreaterThan(40);
    expect(speedSprint).toBeGreaterThan(speedNat * 1.8);
  });

  it('3. 2.5D Mini Film integrates cumulative path distance for 0-slip velocity-locked Reverse-Foot walking', () => {
    const path = [
      { x: 0.15, y: 0.8 },
      { x: 0.85, y: 0.8 },
    ];
    const half = computeMotionPathArcDistance(path, 0.5);
    const full = computeMotionPathArcDistance(path, 1.0);
    expect(full.totalDist).toBeCloseTo(0.7, 2);
    expect(half.cumDist).toBeCloseTo(0.35, 2);

    const graph = compileDirectorPromptToFilmGraph(DIRECTOR_PRESETS[0].prompt);
    const walkShot = {
      ...graph.shots[0],
      action: 'walk-hero' as const,
      motionPath: path,
      durationSec: 4,
    };
    const poseMid = evaluateCharacterPose25D(walkShot, 1.5, graph.world.horizonY);
    expect(poseMid.leftFootRoll).toBeDefined();
    expect(poseMid.rightFootRoll).toBeDefined();
    expect(poseMid.leftWristLag).toBeDefined();
    expect(poseMid.facing).toBe(1);
  });
});
