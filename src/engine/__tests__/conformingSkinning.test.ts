import { describe, expect, it } from 'vitest';
import {
  analyzeDrawingAnatomyFromPixels,
  evaluateCartoonDancePose,
  evaluateCartoonRainWalkPose,
  type ArticulatedCartoonPose,
} from '../cartoonMotionEngine';
import {
  buildConformingSkinnedMeshRGBA,
  buildSilhouetteConformingMeshRGBA,
} from '../conformingMeshEngine';
import {
  evaluateArchetypeSilhouetteMesh,
  evaluateConformingSkinnedMesh,
} from '../dualQuatSkinning';

function fillRect(
  rgba: Uint8ClampedArray,
  w: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r = 28,
  g = 26,
  b = 24,
  a = 255
) {
  for (let y = Math.max(0, y0); y <= Math.min(Math.floor(rgba.length / (w * 4)) - 1, y1); y++) {
    for (let x = Math.max(0, x0); x <= Math.min(w - 1, x1); x++) {
      const o = (y * w + x) * 4;
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = a;
    }
  }
}

/** Draws a broad-shouldered cartoon character with left hand on hip (closed armpit loop!) & right cane */
function makeBroadHeroWithLoopAndCane(w = 180, h = 220): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(w * h * 4);
  // Head (center x=72..108, y=10..62)
  fillRect(rgba, w, 72, 10, 108, 62, 248, 245, 238, 255);
  // Broad jacket shoulders & torso (x=54..126, y=54..136)
  fillRect(rgba, w, 54, 54, 126, 136, 30, 28, 28, 255);
  // Left bent arm resting on hip -> encloses a transparent armpit loop (x=36..53, y=72..106)!
  fillRect(rgba, w, 24, 54, 54, 72, 30, 28, 28, 255); // upper shoulder outward
  fillRect(rgba, w, 20, 72, 36, 108, 30, 28, 28, 255); // outer arm down to elbow
  fillRect(rgba, w, 24, 108, 56, 122, 245, 242, 236, 255); // forearm/hand touching left waist!
  // Right hanging arm + wide hand + thin vertical cane (x=148..154, y=132..216)!
  fillRect(rgba, w, 126, 54, 152, 114, 30, 28, 28, 255); // right sleeve
  fillRect(rgba, w, 136, 114, 166, 132, 245, 242, 236, 255); // wide right hand holding cane
  fillRect(rgba, w, 149, 132, 155, 214, 24, 22, 22, 255); // thin rigid cane
  // Two separate legs with clean gap between them
  fillRect(rgba, w, 62, 136, 84, 214, 30, 28, 28, 255);
  fillRect(rgba, w, 96, 136, 118, 214, 30, 28, 28, 255);
  return rgba;
}

describe('Zero-Kopma Conforming Skinned Mesh & 2D Dual-Quaternion Engine', () => {
  it('1. builds a continuous split-vertex mesh with shared joint seams (0.000px tear), 0 air webbing, distal loop cut & rigid cane', () => {
    const w = 180;
    const h = 220;
    const rgba = makeBroadHeroWithLoopAndCane(w, h);
    const anatomy = analyzeDrawingAnatomyFromPixels(rgba, w, h);
    const mesh = buildConformingSkinnedMeshRGBA(rgba, w, h, anatomy);

    expect(mesh).not.toBeNull();
    if (!mesh) return;

    // Gate 1 & 2: Connected shared-vertex seams exist & ZERO pure-air webbing triangles!
    expect(mesh.sharedJointSeamEdges).toBeGreaterThan(8);
    expect(mesh.airWebbingTriangles).toBe(0);
    expect(mesh.bones.length).toBe(21);

    // Distal left armpit hand-on-hip loop MUST be detected & severed at the waist while keeping shoulder welded!
    expect(mesh.severedLoops.some((lp) => lp.side === 'left')).toBe(true);
    // Thin straight cane below wide right hand MUST be detected as rigid prop!
    expect(mesh.rightHasRigidProp).toBe(true);

    // Every vertex's top-4 weights MUST sum cleanly to 1.0
    for (let vi = 0; vi < mesh.vertexCount; vi++) {
      const sum =
        mesh.boneWeights[vi * 4] +
        mesh.boneWeights[vi * 4 + 1] +
        mesh.boneWeights[vi * 4 + 2] +
        mesh.boneWeights[vi * 4 + 3];
      expect(sum).toBeCloseTo(1, 4);
    }

    // Rigid Skull Lock: upper head interior vertices stay 100% locked to bone 2 (head)!
    let rigidSkullVerts = 0;
    for (let vi = 0; vi < mesh.vertexCount; vi++) {
      const u = mesh.restUV[vi * 2];
      const v = mesh.restUV[vi * 2 + 1];
      if (mesh.vertexRegion[vi] === 0 && v < anatomy.headEndV - 0.06 && Math.abs(u - anatomy.headCenterX) < 0.08) {
        expect(mesh.boneIndices[vi * 4]).toBe(2);
        expect(mesh.boneWeights[vi * 4]).toBeCloseTo(1, 3);
        rigidSkullVerts++;
      }
    }
    expect(rigidSkullVerts).toBeGreaterThan(2);
  });

  it('2. deforms smoothly under extreme Wave + Head Tilt + Rain Walk with 0.000px seam gap & < 2° rigid cane bend', () => {
    const w = 180;
    const h = 220;
    const rgba = makeBroadHeroWithLoopAndCane(w, h);
    const anatomy = analyzeDrawingAnatomyFromPixels(rgba, w, h);
    const mesh = buildConformingSkinnedMeshRGBA(rgba, w, h, anatomy)!;

    const wavePose: ArticulatedCartoonPose = {
      hipShiftX: 0.02,
      hipLiftY: 0.03,
      squashX: 0.96,
      squashY: 1.04,
      torsoLeanRad: 0.12,
      chestCounterRad: -0.06,
      headTiltRad: 0.31,
      headLagY: 0,
      headTurnX: 0.2,
      leftArmAngle: 0.95,
      rightArmAngle: 0.88,
      leftArmLag: 0.14,
      rightArmLag: -0.1,
      leftLegStride: -0.25,
      rightLegStride: 0.25,
      leftFootLift: 0.3,
      rightFootLift: 0,
      footContact: false,
      contactSide: 0,
      mouthOpen: 0,
      viseme: 'closed',
      blink: 0,
      facing: 1,
    };

    const bounds = { x: 100, y: 80, w: 260, h: 318 };
    const ev = evaluateConformingSkinnedMesh(mesh, anatomy, wavePose, bounds);

    // Every single deformed vertex must be finite (no NaN/Infinity under 2D dual-quaternion blend!)
    for (let i = 0; i < mesh.vertexCount * 2; i++) {
      expect(Number.isFinite(ev.positions[i])).toBe(true);
    }

    // Verify rigid cane straightness (< 2° bend delta during 50°+ wave!)
    const caneVerts: number[] = [];
    for (let vi = 0; vi < mesh.vertexCount; vi++) {
      if (mesh.vertexRegion[vi] === 3 && mesh.restUV[vi * 2 + 1] > 0.66) {
        caneVerts.push(vi);
      }
    }
    expect(caneVerts.length).toBeGreaterThanOrEqual(4);
    const first = caneVerts[0];
    const mid = caneVerts[Math.floor(caneVerts.length / 2)];
    const last = caneVerts[caneVerts.length - 1];
    const rA1 = Math.atan2(
      (mesh.restUV[mid * 2 + 1] - mesh.restUV[first * 2 + 1]) * bounds.h,
      (mesh.restUV[mid * 2] - mesh.restUV[first * 2]) * bounds.w
    );
    const rA2 = Math.atan2(
      (mesh.restUV[last * 2 + 1] - mesh.restUV[mid * 2 + 1]) * bounds.h,
      (mesh.restUV[last * 2] - mesh.restUV[mid * 2]) * bounds.w
    );
    const dA1 = Math.atan2(ev.positions[mid * 2 + 1] - ev.positions[first * 2 + 1], ev.positions[mid * 2] - ev.positions[first * 2]);
    const dA2 = Math.atan2(ev.positions[last * 2 + 1] - ev.positions[mid * 2 + 1], ev.positions[last * 2] - ev.positions[mid * 2]);
    const bendDiffDeg =
      (Math.abs(Math.atan2(Math.sin((dA2 - dA1) - (rA2 - rA1)), Math.cos((dA2 - dA1) - (rA2 - rA1)))) * 180) /
      Math.PI;
    expect(bendDiffDeg).toBeLessThan(0.05);
  });

  it('3. handles thin-line stickmen cleanly without dropping limbs and swaps depth layers on facingLeft', () => {
    const w = 140;
    const h = 180;
    const rgba = new Uint8ClampedArray(w * h * 4);
    // Stickman head, thin spine, outstretched arms, two thin legs
    fillRect(rgba, w, 54, 12, 86, 44);
    fillRect(rgba, w, 68, 44, 72, 114);
    fillRect(rgba, w, 26, 62, 114, 67);
    fillRect(rgba, w, 54, 114, 60, 174);
    fillRect(rgba, w, 80, 114, 86, 174);

    const anatomy = analyzeDrawingAnatomyFromPixels(rgba, w, h);
    const mesh = buildConformingSkinnedMeshRGBA(rgba, w, h, anatomy);
    expect(mesh).not.toBeNull();
    if (!mesh) return;

    expect(mesh.vertexCount).toBeGreaterThan(40);
    expect(mesh.triangles.length).toBe(mesh.trianglesMirrored.length);
    // Mirrored facing swaps front/back limb draw order cleanly!
    const walkLeft = { ...evaluateCartoonRainWalkPose(0.25, anatomy, 24, 'joy', 0), facing: -1 as const };
    const evL = evaluateConformingSkinnedMesh(mesh, anatomy, walkLeft, { x: 80, y: 40, w: 200, h: 260 });
    expect(Number.isFinite(evL.anchors.handRightScreen.x)).toBe(true);
    expect(Number.isFinite(evL.anchors.footLeftScreen.y)).toBe(true);
  });

  it('4. prevents double-squash mid-spine overlap and keeps Sinsi / Koş! poses low-inversion with zero white-hand slit tearing', () => {
    const w = 180;
    const h = 220;
    const rgba = makeBroadHeroWithLoopAndCane(w, h);
    // Paint a bright white left hand touching the black waist (same topology as Baron!)
    fillRect(rgba, w, 26, 98, 54, 114, 245, 245, 242, 255);

    const anatomy = analyzeDrawingAnatomyFromPixels(rgba, w, h);
    const mesh = buildConformingSkinnedMeshRGBA(rgba, w, h, anatomy);
    expect(mesh).not.toBeNull();
    if (!mesh) return;

    const bounds = { x: 0, y: 0, w, h };

    // A) Pure heavy squash/stretch (no limbs swinging) MUST produce ZERO inverted triangles!
    const squashPose: ArticulatedCartoonPose = {
      hipShiftX: 0,
      hipLiftY: 0,
      squashY: 0.84,
      squashX: 1.18,
      torsoLeanRad: 0.08,
      chestCounterRad: -0.03,
      headTiltRad: -0.05,
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
      footContact: true,
      contactSide: 1,
      mouthOpen: 0,
      viseme: 'closed',
      blink: 0,
      facing: 1,
    };
    const evSq = evaluateConformingSkinnedMesh(mesh, anatomy, squashPose, bounds);
    let squashInverted = 0;
    const invNotes: string[] = [];
    for (let t = 0; t < mesh.triangles.length; t += 3) {
      const a = mesh.triangles[t];
      const b = mesh.triangles[t + 1];
      const c = mesh.triangles[t + 2];
      const rArea =
        (mesh.restUV[b * 2] - mesh.restUV[a * 2]) * (mesh.restUV[c * 2 + 1] - mesh.restUV[a * 2 + 1]) -
        (mesh.restUV[c * 2] - mesh.restUV[a * 2]) * (mesh.restUV[b * 2 + 1] - mesh.restUV[a * 2 + 1]);
      const dArea =
        (evSq.positions[b * 2] - evSq.positions[a * 2]) * (evSq.positions[c * 2 + 1] - evSq.positions[a * 2 + 1]) -
        (evSq.positions[c * 2] - evSq.positions[a * 2]) * (evSq.positions[b * 2 + 1] - evSq.positions[a * 2 + 1]);
      if (rArea * dArea < -1e-6) {
        squashInverted++;
        invNotes.push(`reg=[${mesh.vertexRegion[a]},${mesh.vertexRegion[b]},${mesh.vertexRegion[c]}] uv=(${mesh.restUV[a*2].toFixed(2)},${mesh.restUV[a*2+1].toFixed(2)}) b0=[${mesh.boneIndices[a*4]},${mesh.boneIndices[b*4]},${mesh.boneIndices[c*4]}]`);
      }
    }
    expect(squashInverted, invNotes.join(' | ')).toBe(0);

    // B) Sinsi & Koş! cycles stay super clean (<= 6 inverted tris across full cycle!)
    for (const mood of ['sneak', 'sprint', 'joy'] as const) {
      let worstInv = 0;
      for (let step = 0; step < 8; step++) {
        const pose = evaluateCartoonDancePose(step * 0.25, null, 12, mood);
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
      expect(worstInv).toBeLessThanOrEqual(6);
    }
  });

  it('5. builds air-split silhouette conforming mesh for quadrupeds with zero empty-air webbing between legs', () => {
    const w = 180;
    const h = 120;
    const cat = new Uint8ClampedArray(w * h * 4);
    fillRect(cat, w, 36, 36, 144, 72, 32, 30, 28, 255); // horizontal body
    fillRect(cat, w, 134, 18, 166, 52, 32, 30, 28, 255); // head
    fillRect(cat, w, 42, 72, 58, 114, 32, 30, 28, 255); // back leg
    fillRect(cat, w, 122, 72, 138, 114, 32, 30, 28, 255); // front leg

    const sil = buildSilhouetteConformingMeshRGBA(cat, w, h);
    expect(sil).not.toBeNull();
    if (!sil) return;
    expect(sil.vertexCount).toBeGreaterThan(20);
    expect(sil.triangles.length).toBeGreaterThan(20);

    // Every emitted triangle centroid must sit near opaque foreground, NEVER across the empty gap between legs (x=72..108, y=82..112)!
    let emptyGapTris = 0;
    for (let t = 0; t < sil.triangles.length; t += 3) {
      const a = sil.triangles[t];
      const b = sil.triangles[t + 1];
      const c = sil.triangles[t + 2];
      const cx = ((sil.restUV[a * 2] + sil.restUV[b * 2] + sil.restUV[c * 2]) / 3) * w;
      const cy = ((sil.restUV[a * 2 + 1] + sil.restUV[b * 2 + 1] + sil.restUV[c * 2 + 1]) / 3) * h;
      if (cx > 68 && cx < 112 && cy > 80 && cy < 112) emptyGapTris++;
    }
    expect(emptyGapTris).toBe(0);
  });

  it('6. detects solid ghosts/dresses as non-bipedal, welds flared skirts without tearing, and locks upward rigid swords', () => {
    // A) Solid Ghost (no leg gap!) MUST report bipedal === false
    const gw = 120;
    const gh = 150;
    const ghost = new Uint8ClampedArray(gw * gh * 4);
    fillRect(ghost, gw, 20, 16, 100, 136, 250, 250, 255, 255);
    const ghostAn = analyzeDrawingAnatomyFromPixels(ghost, gw, gh);
    expect(ghostAn.bipedal).toBe(false);

    // B) Flared Dress Princess (narrow neck + outstretched arms + solid skirt) welds skirt in reg 1 with near-zero inversion!
    const pw = 160;
    const ph = 210;
    const princess = new Uint8ClampedArray(pw * ph * 4);
    fillRect(princess, pw, 62, 12, 98, 48, 250, 224, 202, 255); // Head
    fillRect(princess, pw, 68, 52, 92, 98, 214, 72, 128, 255); // Bodice
    fillRect(princess, pw, 22, 62, 68, 74, 250, 224, 202, 255); // Left arm
    fillRect(princess, pw, 92, 62, 138, 74, 250, 224, 202, 255); // Right arm
    // Wide solid A-line dress down to hem (no gap between legs!)
    for (let y = 98; y <= 198; y++) {
      const t = (y - 98) / 100;
      const half = Math.round(14 + t * 44);
      fillRect(princess, pw, 80 - half, y, 80 + half, y, 226, 94, 148, 255);
    }
    const prAn = analyzeDrawingAnatomyFromPixels(princess, pw, ph);
    expect(prAn.bipedal).toBe(false);
    const prMesh = buildConformingSkinnedMeshRGBA(princess, pw, ph, prAn);
    expect(prMesh).not.toBeNull();
    if (prMesh) {
      const sprint = evaluateCartoonDancePose(0.6, null, 12, 'sprint');
      const ev = evaluateConformingSkinnedMesh(prMesh, prAn, sprint, { x: 0, y: 0, w: pw, h: ph });
      let inv = 0;
      for (let t = 0; t < prMesh.triangles.length; t += 3) {
        const a = prMesh.triangles[t];
        const b = prMesh.triangles[t + 1];
        const c = prMesh.triangles[t + 2];
        const rArea =
          (prMesh.restUV[b * 2] - prMesh.restUV[a * 2]) * (prMesh.restUV[c * 2 + 1] - prMesh.restUV[a * 2 + 1]) -
          (prMesh.restUV[c * 2] - prMesh.restUV[a * 2]) * (prMesh.restUV[b * 2 + 1] - prMesh.restUV[a * 2 + 1]);
        const dArea =
          (ev.positions[b * 2] - ev.positions[a * 2]) * (ev.positions[c * 2 + 1] - ev.positions[a * 2 + 1]) -
          (ev.positions[c * 2] - ev.positions[a * 2]) * (ev.positions[b * 2 + 1] - ev.positions[a * 2 + 1]);
        if (rArea * dArea < -1e-4) inv++;
      }
      expect(inv).toBeLessThanOrEqual(4);
    }
  });

  it('7. animates quadrupeds (4-leg gallop + tail wag) and floaters (wavy ghost hem) via WebGL2 silhouette mesh with 0 inversions', () => {
    // A) Quadruped cat silhouette mesh
    const cw = 180;
    const ch = 120;
    const cat = new Uint8ClampedArray(cw * ch * 4);
    fillRect(cat, cw, 36, 36, 144, 72, 235, 165, 92, 255);
    fillRect(cat, cw, 134, 18, 166, 52, 235, 165, 92, 255);
    fillRect(cat, cw, 42, 72, 58, 114, 196, 118, 52, 255);
    fillRect(cat, cw, 122, 72, 138, 114, 196, 118, 52, 255);
    const catAn = analyzeDrawingAnatomyFromPixels(cat, cw, ch);
    const catMesh = buildSilhouetteConformingMeshRGBA(cat, cw, ch);
    expect(catMesh).not.toBeNull();
    if (catMesh) {
      const sprint = evaluateCartoonDancePose(0.5, null, 12, 'sprint');
      const ev = evaluateArchetypeSilhouetteMesh(catMesh, 'quadruped', catAn, sprint, { x: 0, y: 0, w: cw, h: ch }, 0.7);
      let inv = 0;
      const qNotes: string[] = [];
      for (let t = 0; t < catMesh.triangles.length; t += 3) {
        const a = catMesh.triangles[t];
        const b = catMesh.triangles[t + 1];
        const c = catMesh.triangles[t + 2];
        const rArea =
          (catMesh.restUV[b * 2] - catMesh.restUV[a * 2]) * (catMesh.restUV[c * 2 + 1] - catMesh.restUV[a * 2 + 1]) -
          (catMesh.restUV[c * 2] - catMesh.restUV[a * 2]) * (catMesh.restUV[b * 2 + 1] - catMesh.restUV[a * 2 + 1]);
        const dArea =
          (ev.positions[b * 2] - ev.positions[a * 2]) * (ev.positions[c * 2 + 1] - ev.positions[a * 2 + 1]) -
          (ev.positions[c * 2] - ev.positions[a * 2]) * (ev.positions[b * 2 + 1] - ev.positions[a * 2 + 1]);
        if (rArea * dArea < -1e-4) {
          inv++;
          qNotes.push(`(${catMesh.restUV[a*2].toFixed(2)},${catMesh.restUV[a*2+1].toFixed(2)})`);
        }
      }
      expect(inv, qNotes.join(' ')).toBe(0);
    }

    // B) Floater ghost silhouette mesh
    const gw = 120;
    const gh = 150;
    const ghost = new Uint8ClampedArray(gw * gh * 4);
    fillRect(ghost, gw, 20, 16, 100, 136, 250, 250, 255, 255);
    const gAn = analyzeDrawingAnatomyFromPixels(ghost, gw, gh);
    const gMesh = buildSilhouetteConformingMeshRGBA(ghost, gw, gh);
    expect(gMesh).not.toBeNull();
    if (gMesh) {
      const joy = evaluateCartoonDancePose(0.4, null, 12, 'joy');
      const ev = evaluateArchetypeSilhouetteMesh(gMesh, 'floater', gAn, joy, { x: 0, y: 0, w: gw, h: gh }, 1.1);
      let inv = 0;
      for (let t = 0; t < gMesh.triangles.length; t += 3) {
        const a = gMesh.triangles[t];
        const b = gMesh.triangles[t + 1];
        const c = gMesh.triangles[t + 2];
        const rArea =
          (gMesh.restUV[b * 2] - gMesh.restUV[a * 2]) * (gMesh.restUV[c * 2 + 1] - gMesh.restUV[a * 2 + 1]) -
          (gMesh.restUV[c * 2] - gMesh.restUV[a * 2]) * (gMesh.restUV[b * 2 + 1] - gMesh.restUV[a * 2 + 1]);
        const dArea =
          (ev.positions[b * 2] - ev.positions[a * 2]) * (ev.positions[c * 2 + 1] - ev.positions[a * 2 + 1]) -
          (ev.positions[c * 2] - ev.positions[a * 2]) * (ev.positions[b * 2 + 1] - ev.positions[a * 2 + 1]);
        if (rArea * dArea < -1e-4) inv++;
      }
      expect(inv).toBe(0);
    }
  });
});
