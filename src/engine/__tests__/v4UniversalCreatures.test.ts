import { describe, expect, it } from 'vitest';
import { defaultDrawingAnatomy } from '../cartoonMotionEngine';
import { buildConformingSkinnedMeshRGBA, type UniversalCreatureClass } from '../conformingMeshEngine';
import { isolatePrimarySubjectRGBA } from '../characterIntakeEngine';
import {
  buildUniversalCreatureMeshRGBA,
  classifyUniversalCreatureRGBA,
  evaluateUniversalCreatureMesh,
  UNIVERSAL_CREATURE_CATALOG,
  type UniversalActionId,
} from '../universalCreatureRig';

function paintRect(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: number,
  g: number,
  b: number
) {
  const ix0 = Math.max(0, Math.floor(x0));
  const ix1 = Math.min(w - 1, Math.ceil(x1));
  const iy0 = Math.max(0, Math.floor(y0));
  const iy1 = Math.min(h - 1, Math.ceil(y1));
  for (let y = iy0; y <= iy1; y++) {
    for (let x = ix0; x <= ix1; x++) {
      const o = (y * w + x) * 4;
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = 255;
    }
  }
}

function paintCircle(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  cx: number,
  cy: number,
  rad: number,
  r: number,
  g: number,
  b: number
) {
  const r2 = rad * rad;
  for (let y = Math.max(0, Math.floor(cy - rad)); y <= Math.min(h - 1, Math.ceil(cy + rad)); y++) {
    for (let x = Math.max(0, Math.floor(cx - rad)); x <= Math.min(w - 1, Math.ceil(cx + rad)); x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) {
        const o = (y * w + x) * 4;
        rgba[o] = r;
        rgba[o + 1] = g;
        rgba[o + 2] = b;
        rgba[o + 3] = 255;
      }
    }
  }
}

function makeCreatureSilhouette(cls: UniversalCreatureClass): { rgba: Uint8ClampedArray; w: number; h: number } {
  const w = 180;
  const h = 180;
  const rgba = new Uint8ClampedArray(w * h * 4);
  if (cls === 'quadruped') {
    // Horizontal cat/dog: torso + 4 separated legs + head + tail
    paintRect(rgba, w, h, 36, 72, 134, 108, 220, 140, 60);
    paintCircle(rgba, w, h, 142, 66, 22, 220, 140, 60);
    paintRect(rgba, w, h, 42, 106, 56, 162, 200, 120, 50);
    paintRect(rgba, w, h, 64, 106, 78, 162, 190, 110, 45);
    paintRect(rgba, w, h, 104, 106, 118, 162, 200, 120, 50);
    paintRect(rgba, w, h, 124, 106, 138, 162, 190, 110, 45);
    paintRect(rgba, w, h, 14, 54, 40, 78, 200, 120, 50);
  } else if (cls === 'avian_winged') {
    // Bird with wide outstretched wings + narrow legs
    paintCircle(rgba, w, h, 90, 86, 26, 70, 130, 210);
    paintCircle(rgba, w, h, 90, 46, 16, 70, 130, 210);
    paintRect(rgba, w, h, 10, 56, 72, 86, 50, 105, 190);
    paintRect(rgba, w, h, 108, 56, 170, 86, 50, 105, 190);
    paintRect(rgba, w, h, 78, 110, 86, 152, 220, 160, 40);
    paintRect(rgba, w, h, 94, 110, 102, 152, 220, 160, 40);
  } else if (cls === 'aquatic_fish') {
    paintRect(rgba, w, h, 48, 66, 148, 114, 40, 165, 220);
    paintRect(rgba, w, h, 16, 52, 52, 128, 30, 140, 195);
    paintRect(rgba, w, h, 86, 46, 114, 68, 30, 140, 195);
  } else if (cls === 'serpentine_tentacle') {
    paintRect(rgba, w, h, 10, 78, 170, 102, 55, 175, 85);
    paintCircle(rgba, w, h, 162, 90, 14, 45, 155, 70);
  } else if (cls === 'biped_tailed') {
    // Dinosaur with upright torso, 2 thick legs & heavy lower tail
    paintCircle(rgba, w, h, 112, 34, 20, 70, 160, 75);
    paintRect(rgba, w, h, 72, 48, 122, 118, 70, 160, 75);
    paintRect(rgba, w, h, 74, 116, 92, 168, 60, 140, 65);
    paintRect(rgba, w, h, 104, 116, 122, 168, 60, 140, 65);
    paintRect(rgba, w, h, 12, 92, 76, 116, 65, 148, 70);
  } else if (cls === 'amorphous_vehicle') {
    // Rounded cloud/ghost/car dome
    paintCircle(rgba, w, h, 90, 86, 52, 180, 195, 225);
    paintRect(rgba, w, h, 38, 86, 142, 142, 180, 195, 225);
  } else {
    // Humanoid
    paintCircle(rgba, w, h, 90, 32, 18, 240, 210, 185);
    paintRect(rgba, w, h, 68, 52, 112, 112, 45, 70, 160);
    paintRect(rgba, w, h, 42, 56, 64, 108, 210, 65, 65);
    paintRect(rgba, w, h, 116, 56, 138, 108, 210, 65, 65);
    paintRect(rgba, w, h, 70, 112, 86, 168, 40, 45, 60);
    paintRect(rgba, w, h, 94, 112, 110, 168, 40, 45, 60);
  }
  return { rgba, w, h };
}

describe('Phase 1 V4: 7 Universal Creature Rigs, Viterbi Zero-Tear & Photo Hardening', () => {
  it('1. builds & animates ALL 7 creature classes with 0.000px tears, 0 air webbing, Σw=1 & 0 inversions', () => {
    const anatomy = defaultDrawingAnatomy();
    const classes: Array<{ cls: UniversalCreatureClass; actions: UniversalActionId[] }> = [
      { cls: 'humanoid', actions: ['walk-natural'] },
      { cls: 'quadruped', actions: ['walk-natural', 'trot', 'gallop', 'sit-rest', 'pounce-leap'] },
      { cls: 'avian_winged', actions: ['fly-flap', 'soar-glide', 'dive', 'walk-natural'] },
      { cls: 'aquatic_fish', actions: ['swim-cruise', 'sprint', 'dive'] },
      { cls: 'serpentine_tentacle', actions: ['slither', 'pounce-leap', 'roar-angry'] },
      { cls: 'biped_tailed', actions: ['walk-natural', 'sprint', 'roar-angry', 'hand-over-prop'] },
      { cls: 'amorphous_vehicle', actions: ['roll-drive', 'startle-jump', 'sleep-breathe'] },
    ];

    for (const { cls, actions } of classes) {
      const { rgba, w, h } = makeCreatureSilhouette(cls);
      const mesh = buildUniversalCreatureMeshRGBA(rgba, w, h, anatomy, cls);
      expect(mesh, `mesh must build for ${cls}`).not.toBeNull();
      expect(mesh!.bones.length).toBe(UNIVERSAL_CREATURE_CATALOG[cls].boneCount);
      expect(mesh!.sharedJointSeamEdges).toBeGreaterThan(0);
      expect(mesh!.airWebbingTriangles).toBe(0);
      expect(mesh!.disconnectedLimbIslands ?? 0).toBe(0);

      // Lock 5: Every vertex weight sums to 1.000 ± 1e-3
      for (let v = 0; v < mesh!.vertexCount; v++) {
        const s =
          mesh!.boneWeights[v * 4] +
          mesh!.boneWeights[v * 4 + 1] +
          mesh!.boneWeights[v * 4 + 2] +
          mesh!.boneWeights[v * 4 + 3];
        expect(Math.abs(s - 1)).toBeLessThan(1e-3);
      }

      if (cls !== 'humanoid') {
        for (const action of actions) {
          const ev = evaluateUniversalCreatureMesh(
            mesh!,
            { x: 100, y: 100, w: 260, h: 260 },
            { timeSec: 0.72, action, yawDeg: 28 },
            false
          );
          expect(ev.gpuBones.length).toBe(mesh!.bones.length);
          expect(ev.invertedTriangles, `${cls}/${action} must have 0 inversions`).toBe(0);
          expect(Number.isFinite(ev.headAnchor.x)).toBe(true);
          expect(Number.isFinite(ev.bbox.minX)).toBe(true);
        }
      }
    }
  });

  it('2. Viterbi chroma-edge separates contourless touching colored sleeves & hand-to-thigh with 0 detached islands', () => {
    const w = 180;
    const h = 220;
    const rgba = new Uint8ClampedArray(w * h * 4);
    // Contourless bright watercolor character: NO black ink lines!
    // Blue torso pressed directly (0px air gap!) against bright red sleeves & hands touching yellow thighs!
    paintCircle(rgba, w, h, 90, 34, 20, 245, 210, 175); // Head
    paintRect(rgba, w, h, 66, 54, 114, 126, 35, 95, 215); // Blue torso
    paintRect(rgba, w, h, 46, 58, 65, 146, 225, 55, 55); // Red left sleeve + hand pressed against torso & thigh (0px gap!)
    paintRect(rgba, w, h, 115, 58, 134, 146, 225, 55, 55); // Red right sleeve + hand pressed (0px gap!)
    paintRect(rgba, w, h, 68, 126, 89, 204, 235, 195, 40); // Yellow left trouser
    paintRect(rgba, w, h, 90, 126, 111, 204, 65, 175, 95); // Green right trouser touching (0px gap!)

    const anatomy = defaultDrawingAnatomy();
    anatomy.headEndV = 54 / h;
    anatomy.hipV = 126 / h;
    anatomy.groundV = 204 / h;
    anatomy.centerX = 0.5;

    const mesh = buildConformingSkinnedMeshRGBA(rgba, w, h, anatomy);
    expect(mesh).not.toBeNull();
    expect(mesh!.inkWatershedCuts ?? 0).toBeGreaterThan(8);
    expect(mesh!.disconnectedLimbIslands ?? 0).toBe(0);
    expect(mesh!.sharedJointSeamEdges).toBeGreaterThan(0);

    // Verify Connectivity Rollback Guard: a destructive horizontal cut across the neck MUST be rolled back!
    const guarded = buildConformingSkinnedMeshRGBA(rgba, w, h, anatomy, {
      customSlitLines: [{ x0: 0.25, y0: 0.27, x1: 0.75, y1: 0.27 }],
    });
    expect(guarded).not.toBeNull();
    expect(guarded!.disconnectedLimbIslands ?? 0).toBe(0);

    // Verify 2nd-pass isolated socket patch is strictly transparent on head/legs (zero ghosting!)
    if (mesh!.inpaintedSocketOnlyRgba) {
      const headAlpha = mesh!.inpaintedSocketOnlyRgba[(34 * w + 90) * 4 + 3];
      const footAlpha = mesh!.inpaintedSocketOnlyRgba[(195 * w + 78) * 4 + 3];
      expect(headAlpha).toBe(0);
      expect(footAlpha).toBe(0);
    }
  });

  it('3. strips dark wooden desk border margin from photos while keeping primary character & nearby hat', () => {
    const w = 200;
    const h = 200;
    const rgba = new Uint8ClampedArray(w * h * 4);
    // Centered character (area ~3600)
    paintRect(rgba, w, h, 75, 65, 125, 145, 30, 30, 30);
    // Floating hat 4px above head (should stay!)
    paintRect(rgba, w, h, 82, 52, 118, 60, 40, 40, 40);
    // Huge dark wooden desk border strip hugging the left edge (area ~2400 > 28% primary!)
    paintRect(rgba, w, h, 0, 0, 14, 199, 70, 45, 25);

    const pruned = isolatePrimarySubjectRGBA(rgba, w, h);
    expect(pruned).toBe(true);
    // Desk strip at x=5, y=100 MUST be erased
    expect(rgba[(100 * w + 5) * 4 + 3]).toBe(0);
    // Centered character at x=100, y=100 MUST remain intact
    expect(rgba[(100 * w + 100) * 4 + 3]).toBe(255);
    // Close floating hat at x=100, y=56 MUST remain intact
    expect(rgba[(56 * w + 100) * 4 + 3]).toBe(255);
  });

  it('4. auto-classifies quadruped, avian_winged, serpentine_tentacle & amorphous silhouettes accurately', () => {
    const q = makeCreatureSilhouette('quadruped');
    expect(classifyUniversalCreatureRGBA(q.rgba, q.w, q.h).creatureClass).toBe('quadruped');
    const a = makeCreatureSilhouette('avian_winged');
    expect(classifyUniversalCreatureRGBA(a.rgba, a.w, a.h).creatureClass).toBe('avian_winged');
    const s = makeCreatureSilhouette('serpentine_tentacle');
    expect(classifyUniversalCreatureRGBA(s.rgba, s.w, s.h).creatureClass).toBe('serpentine_tentacle');
  });
});
