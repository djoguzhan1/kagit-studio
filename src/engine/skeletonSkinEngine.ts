import type { DrawingAnatomy } from './cartoonMotionEngine';
import {
  buildConformingSkinnedMeshRGBA,
  buildSilhouetteConformingMeshRGBA,
  type ConformingMeshBuildOptions,
  type ConformingSkinnedMesh,
  type UniversalCreatureClass,
} from './conformingMeshEngine';
import {
  buildUniversalCreatureMeshRGBA,
  classifyUniversalCreatureRGBA,
} from './universalCreatureRig';
import {
  buildCreatureMeshAsync,
  buildFullRigPackInWorkerAsync,
  buildHumanoidMeshAsync,
  buildSilhouetteMeshAsync,
} from './rigWorkerClient';

/**
 * KÂĞIT Skeleton & Ink-Graph Skinning Engine
 * ------------------------------------------
 * Pure, deterministic, real-time (<15ms) 2D character rigging engine:
 * 1. Closed-Contour Gouache Volume Fill — gives outline doodles solid hand-painted volume
 * 2. Ink-Graph Geodesic Limb Segmentation — separates Head, Torso, Back/Front Arms & Legs
 *    along drawn ink paths (zero cross-air rubber webbing!)
 * 3. Analytic 2-Bone Inverse Kinematics (IK) — true bending knees & elbows with soft knee-lock guard
 * 4. Face Eye Detector — locates user-drawn eyes for authentic organic blinking
 */

export type LimbPartId = 'head' | 'torso' | 'arm_l' | 'arm_r' | 'leg_l' | 'leg_r';

export interface Vec2 {
  x: number;
  y: number;
}

export interface TwoBoneIKSolution {
  root: Vec2;
  mid: Vec2;
  end: Vec2;
  upperAngle: number;
  lowerAngle: number;
}

export interface DetectedEyes {
  found: boolean;
  left: Vec2; // normalized 0..1 of actor
  right: Vec2;
  radius: number; // normalized 0..1
}

export interface SegmentedLimbPart {
  id: LimbPartId;
  canvas: HTMLCanvasElement;
  /** Pre-tinted slightly darker limb cutout for far-side depth separation (zero per-frame ctx.filter!) */
  darkCanvas: HTMLCanvasElement;
  /** Pre-baked crisp warm paper-cutout halo version for crystal-clear night scene readability (zero ctx.filter!) */
  nightCanvas: HTMLCanvasElement;
  /** Pre-baked far-side night cutout */
  nightFarCanvas: HTMLCanvasElement;
  /** Normalized 0..1 bounding box inside full actor canvas */
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  /** Primary joint anchor (normalized 0..1 of full actor canvas) */
  root: Vec2;
  /** Mid hinge joint (elbow / knee, normalized 0..1) */
  mid: Vec2;
  /** End effector (wrist / ankle, normalized 0..1) */
  end: Vec2;
  /** Number of opaque pixels owned by this part */
  pixelCount: number;
}

export type CharacterArchetype = 'humanoid' | 'quadruped' | 'floater';

export interface RiggedCharacterPack {
  /** Solid interior-filled full actor canvas (for fallback & shadows) */
  filledCanvas: HTMLCanvasElement;
  /** Night-lit warm paper-cutout rim version of filledCanvas (for single-blob night fallback) */
  nightFilledCanvas: HTMLCanvasElement;
  /** Original outline/color canvas */
  sourceCanvas: HTMLCanvasElement;
  anatomy: DrawingAnatomy;
  eyes: DetectedEyes;
  parts: Record<LimbPartId, SegmentedLimbPart>;
  /** True when distinct articulated limbs were cleanly extracted (false for single-blob ghosts/clouds) */
  useMultiPart: boolean;
  /** Auto-detected character archetype so animals, birds & blobs animate naturally without bad cuts */
  archetype: CharacterArchetype;
  /** V4 Universal 7-Class Creature Rig Type (humanoid, quadruped, avian_winged, aquatic_fish, serpentine_tentacle, biped_tailed, amorphous_vehicle) */
  creatureClass: UniversalCreatureClass;
  /** Dominant warm fill hex used for eyelid blinks */
  faceFillColor: string;
  /** Sampled dark ink color of the drawing for invisible continuous joint-socket welds */
  inkColor: string;
  /** True when artist already drew a prominent mouth/grin (prevents double-mouth overlays!) */
  hasDrawnMouth: boolean;
  /** Zero-Kopma continuous topology-aware 11-bone conforming skinned mesh (for humanoid 2D/2.5D rendering!) */
  skinnedMesh: ConformingSkinnedMesh | null;
  /** Air-split WebGL2 silhouette conforming mesh for quadrupeds, ghosts, clouds & custom-pin rigs (0 air webbing!) */
  silhouetteMesh: ConformingSkinnedMesh | null;
  /** Optional artist-uploaded custom mouth sprites (closed, A, E, O) resolved for live lip-sync */
  customMouthBitmaps?: Partial<Record<'closed' | 'A' | 'E' | 'O', CanvasImageSource>>;
}

export interface PreparedLimbPartRGBA {
  id: LimbPartId;
  rgba: Uint8ClampedArray;
  darkRgba: Uint8ClampedArray;
  nightRgba: Uint8ClampedArray;
  nightFarRgba: Uint8ClampedArray;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  root: Vec2;
  mid: Vec2;
  end: Vec2;
  pixelCount: number;
}

export interface PreparedRigPackBaseRGBA {
  filledRgba: Uint8ClampedArray;
  nightFilledRgba: Uint8ClampedArray;
  sw: number;
  sh: number;
  anatomy: DrawingAnatomy;
  eyes: DetectedEyes;
  partsRgba: Record<LimbPartId, PreparedLimbPartRGBA>;
  archetype: CharacterArchetype;
  faceFillColor: string;
  inkColor: string;
  hasDrawnMouth: boolean;
}

// ============================================================================
// 1. ANALYTIC 2-BONE INVERSE KINEMATICS (True Bending Knees & Elbows!)
// ============================================================================

/**
 * Pure analytic 2-Bone IK solver using Law of Cosines with soft knee/elbow hyperextension clamp.
 * bendDir: +1 bends mid-joint clockwise from root->target vector, -1 bends counter-clockwise.
 */
export function solveTwoBoneIK(
  rootX: number,
  rootY: number,
  targetX: number,
  targetY: number,
  len1: number,
  len2: number,
  bendDir: 1 | -1
): TwoBoneIKSolution {
  const l1 = Math.max(0.001, len1);
  const l2 = Math.max(0.001, len2);
  const dx = targetX - rootX;
  const dy = targetY - rootY;
  const rawDist = Math.hypot(dx, dy);

  const minDist = Math.abs(l1 - l2) + 0.002;
  const maxDist = (l1 + l2) * 0.994; // Soft-knee guard prevents snappy straight-leg pop!
  const d = Math.max(minDist, Math.min(maxDist, rawDist || minDist));

  const baseAngle = Math.atan2(dy, dx);
  const cosAlpha = Math.max(-1, Math.min(1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d)));
  const alpha = Math.acos(cosAlpha);

  const upperAngle = baseAngle + bendDir * alpha;
  const midX = rootX + Math.cos(upperAngle) * l1;
  const midY = rootY + Math.sin(upperAngle) * l1;

  const endX = rootX + Math.cos(baseAngle) * d;
  const endY = rootY + Math.sin(baseAngle) * d;
  const lowerAngle = Math.atan2(endY - midY, endX - midX);

  return {
    root: { x: rootX, y: rootY },
    mid: { x: midX, y: midY },
    end: { x: endX, y: endY },
    upperAngle,
    lowerAngle,
  };
}

// ============================================================================
// 2. CLOSED-CONTOUR AUTOMATIC GOUACHE VOLUME FILL (Pure Pixel Engine!)
// ============================================================================

/**
 * Finds enclosed interior transparent cavities (head circle, coat/torso polygon, hat)
 * using exterior border BFS with 1px morphological gap-closing so sketchy outlines still seal cleanly!
 * Returns a new RGBA buffer with warm hand-painted paper/gouache volume UNDER the original crisp strokes.
 */
export function fillClosedContoursRGBA(
  srcRgba: Uint8ClampedArray,
  width: number,
  height: number,
  headEndV: number
): { rgba: Uint8ClampedArray; filledPixels: number } {
  const out = new Uint8ClampedArray(srcRgba);
  if (width < 8 || height < 8) return { rgba: out, filledPixels: 0 };

  const pw = width + 2;
  const ph = height + 2;
  const total = pw * ph;

  // Build binary wall mask (opaque stroke = 1)
  const wall = new Uint8Array(total);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (srcRgba[(y * width + x) * 4 + 3] > 52) {
        wall[(y + 1) * pw + (x + 1)] = 1;
      }
    }
  }

  // Morphological closing (dilate R=3 -> erode R=3) ONLY for exterior flood leak prevention:
  // Seals sketchy 1..6px hand-drawn loop endpoint gaps so 4-stroke faces NEVER crack,
  // while keeping true wide U-cavities (between legs/arms > 8px) completely open!
  const closeR = 3;
  const dilH = new Uint8Array(total);
  for (let y = 0; y < ph; y++) {
    const row = y * pw;
    for (let x = 0; x < pw; x++) {
      const x0 = Math.max(0, x - closeR);
      const x1 = Math.min(pw - 1, x + closeR);
      for (let kx = x0; kx <= x1; kx++) {
        if (wall[row + kx]) {
          dilH[row + x] = 1;
          break;
        }
      }
    }
  }
  const dil = new Uint8Array(total);
  for (let y = 0; y < ph; y++) {
    const y0 = Math.max(0, y - closeR);
    const y1 = Math.min(ph - 1, y + closeR);
    const row = y * pw;
    for (let x = 0; x < pw; x++) {
      for (let ky = y0; ky <= y1; ky++) {
        if (dilH[ky * pw + x]) {
          dil[row + x] = 1;
          break;
        }
      }
    }
  }
  const eroH = new Uint8Array(total);
  for (let y = 0; y < ph; y++) {
    const row = y * pw;
    for (let x = 0; x < pw; x++) {
      if (x < closeR || x >= pw - closeR) continue;
      let all = 1;
      for (let kx = x - closeR; kx <= x + closeR; kx++) {
        if (!dil[row + kx]) {
          all = 0;
          break;
        }
      }
      eroH[row + x] = all;
    }
  }
  const sealed = new Uint8Array(wall);
  for (let y = closeR; y < ph - closeR; y++) {
    const row = y * pw;
    for (let x = closeR; x < pw - closeR; x++) {
      let all = 1;
      for (let ky = y - closeR; ky <= y + closeR; ky++) {
        if (!eroH[ky * pw + x]) {
          all = 0;
          break;
        }
      }
      if (all) sealed[row + x] = 1;
    }
  }

  // BFS flood-fill from outer border (0, 0) to mark all exterior air pixels
  const exterior = new Uint8Array(total);
  const queue = new Int32Array(total);
  let qHead = 0;
  let qTail = 0;
  exterior[0] = 1;
  queue[qTail++] = 0;

  while (qHead < qTail) {
    const cur = queue[qHead++];
    const cx = cur % pw;
    const cy = (cur - cx) / pw;

    if (cx > 0) {
      const n = cur - 1;
      if (!exterior[n] && !sealed[n]) {
        exterior[n] = 1;
        queue[qTail++] = n;
      }
    }
    if (cx + 1 < pw) {
      const n = cur + 1;
      if (!exterior[n] && !sealed[n]) {
        exterior[n] = 1;
        queue[qTail++] = n;
      }
    }
    if (cy > 0) {
      const n = cur - pw;
      if (!exterior[n] && !sealed[n]) {
        exterior[n] = 1;
        queue[qTail++] = n;
      }
    }
    if (cy + 1 < ph) {
      const n = cur + pw;
      if (!exterior[n] && !sealed[n]) {
        exterior[n] = 1;
        queue[qTail++] = n;
      }
    }
  }

  // Distinguish hollow outline doodles (head/torso interiors transparent -> deserve warm gouache fill!)
  // from already solid-filled / paper-extracted artwork (where enclosed transparent cavities are
  // intentional negative space such as hands-on-hips armpit holes or cane-to-leg gaps!).
  let totalInterior = 0;
  let opaqueInterior = 0;
  let headInterior = 0;
  let headOpaqueInterior = 0;
  for (let y = 0; y < height; y++) {
    const v = y / Math.max(1, height - 1);
    const inHead = v <= headEndV + 0.02;
    for (let x = 0; x < width; x++) {
      const pIdx = (y + 1) * pw + (x + 1);
      if (exterior[pIdx]) continue;
      totalInterior++;
      if (inHead) headInterior++;
      const srcA = srcRgba[(y * width + x) * 4 + 3];
      if (srcA >= 210) {
        opaqueInterior++;
        if (inHead) headOpaqueInterior++;
      }
    }
  }
  const alreadySolidArt =
    totalInterior > 64 &&
    opaqueInterior / totalInterior > 0.62 &&
    (headInterior < 24 || headOpaqueInterior / headInterior > 0.8);
  if (alreadySolidArt) {
    return { rgba: out, filledPixels: 0 };
  }

  // Fill every non-exterior interior pixel UNDERNEATH existing crisp strokes with warm gouache gradient!
  let filledPixels = 0;
  for (let y = 0; y < height; y++) {
    const v = y / Math.max(1, height - 1);
    const inHead = v <= headEndV + 0.02;
    for (let x = 0; x < width; x++) {
      const pIdx = (y + 1) * pw + (x + 1);
      if (exterior[pIdx]) continue;

      const oIdx = (y * width + x) * 4;
      const srcA = srcRgba[oIdx + 3];
      if (srcA >= 245) continue; // Already fully opaque painted ink/color!

      const u = x / Math.max(1, width - 1);
      // Warm hand-painted cream gouache shading (subtle top-left key light -> warm parchment shadow!)
      const shade = 1 - ((u - 0.35) * 0.06 + (v - 0.25) * 0.07);
      const baseR = inHead ? 252 : 244;
      const baseG = inHead ? 246 : 234;
      const baseB = inHead ? 232 : 215;

      const fr = Math.max(0, Math.min(255, Math.round(baseR * shade)));
      const fg = Math.max(0, Math.min(255, Math.round(baseG * shade)));
      const fb = Math.max(0, Math.min(255, Math.round(baseB * shade)));

      // Alpha-composite existing anti-aliased stroke OVER the warm gouache interior fill!
      const sa = srcA / 255;
      out[oIdx] = Math.round(srcRgba[oIdx] * sa + fr * (1 - sa));
      out[oIdx + 1] = Math.round(srcRgba[oIdx + 1] * sa + fg * (1 - sa));
      out[oIdx + 2] = Math.round(srcRgba[oIdx + 2] * sa + fb * (1 - sa));
      out[oIdx + 3] = 255;
      filledPixels++;
    }
  }

  return { rgba: out, filledPixels };
}

// ============================================================================
// 3. GEODESIC INK-GRAPH LIMB SEGMENTATION (Pure, Zero Cross-Air Webbing!)
// ============================================================================

const PART_ORDER: LimbPartId[] = ['head', 'torso', 'arm_l', 'arm_r', 'leg_l', 'leg_r'];

/**
 * Scans the lower-mid torso band (below armpits, above hips) from centerX outward
 * to find the TRUE left and right walls of the drawn torso/coat!
 */
function detectTorsoWalls(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  anatomy: DrawingAnatomy
): { leftU: number; rightU: number } {
  const cx = Math.max(2, Math.min(width - 3, Math.round(anatomy.centerX * (width - 1))));
  const y0 = Math.max(1, Math.round((anatomy.headEndV + (anatomy.hipV - anatomy.headEndV) * 0.22) * (height - 1)));
  const y1 = Math.min(height - 2, Math.round((anatomy.hipV - 0.04) * (height - 1)));

  const leftWalls: number[] = [];
  const rightWalls: number[] = [];

  for (let y = y0; y <= y1; y++) {
    let lx = cx;
    let gap = 0;
    for (let x = cx; x >= 0; x--) {
      if (rgba[(y * width + x) * 4 + 3] > 28) {
        lx = x;
        gap = 0;
      } else {
        gap++;
        if (gap > Math.max(2, Math.round(width * 0.028))) break;
      }
    }
    let rx = cx;
    gap = 0;
    for (let x = cx; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] > 28) {
        rx = x;
        gap = 0;
      } else {
        gap++;
        if (gap > Math.max(2, Math.round(width * 0.028))) break;
      }
    }
    if (rx - lx >= 2) {
      leftWalls.push(lx / Math.max(1, width - 1));
      rightWalls.push(rx / Math.max(1, width - 1));
    }
  }

  if (leftWalls.length === 0) {
    return {
      leftU: Math.max(0.24, Math.min(anatomy.centerX - 0.08, anatomy.shoulderLeftX)),
      rightU: Math.min(0.76, Math.max(anatomy.centerX + 0.08, anatomy.shoulderRightX)),
    };
  }
  // Use inner waist quantile (70th pct for leftU = innermost left wall, 30th pct for rightU = innermost right wall)
  // so hands resting on hips or wide sleeves NEVER pull the torso wall outward into the arms!
  leftWalls.sort((a, b) => a - b);
  rightWalls.sort((a, b) => a - b);
  const innerL = leftWalls[Math.min(leftWalls.length - 1, Math.floor(leftWalls.length * 0.7))];
  const innerR = rightWalls[Math.max(0, Math.floor(rightWalls.length * 0.3))];
  return {
    leftU: Math.max(0.2, Math.min(anatomy.centerX - 0.06, innerL)),
    rightU: Math.min(0.8, Math.max(anatomy.centerX + 0.06, innerR)),
  };
}

/**
 * Computes geodesic ink-aware limb ownership for every pixel on a compact grid!
 * Flows preferentially through drawn ink (cost 2) and strongly penalizes crossing empty air (cost 24),
 * guaranteeing independent arms & legs that NEVER stick together across air!
 */
export function computeGeodesicPartLabels(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  anatomy: DrawingAnatomy
): { labels: Int8Array; counts: Record<LimbPartId, number> } {
  const N = width * height;
  const labels = new Int8Array(N).fill(-1);
  const dist = new Int32Array(N).fill(1_000_000);
  const opaque = new Uint8Array(N);

  for (let i = 0; i < N; i++) {
    if (rgba[i * 4 + 3] > 28) opaque[i] = 1;
  }

  const torsoWalls = detectTorsoWalls(rgba, width, height, anatomy);
  const torsoLeftCol = Math.round(torsoWalls.leftU * (width - 1));
  const torsoRightCol = Math.round(torsoWalls.rightU * (width - 1));

  // Fast Dial's bucket queue (O(N) integer priority queue — zero GC pressure!)
  const MAX_COST = 4096;
  const buckets: number[][] = Array.from({ length: MAX_COST }, () => []);

  const pushSeedAt = (idx: number, partIdx: number, initCost = 0) => {
    if (idx < 0 || idx >= N) return;
    if (initCost < dist[idx]) {
      dist[idx] = initCost;
      labels[idx] = partIdx;
      buckets[initCost].push(idx);
    }
  };

  const pushSeed = (nx: number, ny: number, partIdx: number, initCost = 0) => {
    const gx = Math.max(0, Math.min(width - 1, Math.round(nx * (width - 1))));
    const gy = Math.max(0, Math.min(height - 1, Math.round(ny * (height - 1))));
    // Snap seed to nearest opaque pixel within a small search radius so seeds always land ON the drawing!
    let bestIdx = gy * width + gx;
    let bestD2 = opaque[bestIdx] ? 0 : Infinity;
    if (bestD2 > 0) {
      const rad = Math.max(4, Math.round(Math.min(width, height) * 0.1));
      for (let dy = -rad; dy <= rad; dy++) {
        const y = gy + dy;
        if (y < 0 || y >= height) continue;
        for (let dx = -rad; dx <= rad; dx++) {
          const x = gx + dx;
          if (x < 0 || x >= width) continue;
          const idx = y * width + x;
          if (!opaque[idx]) continue;
          const d2 = dx * dx + dy * dy;
          if (d2 < bestD2) {
            bestD2 = d2;
            bestIdx = idx;
          }
        }
      }
    }
    pushSeedAt(bestIdx, partIdx, initCost);
  };

  const seedSegment = (x0: number, y0: number, x1: number, y1: number, partIdx: number, steps = 5) => {
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      pushSeed(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, partIdx, 0);
    }
  };

  const neckRow = Math.round(anatomy.headEndV * (height - 1));
  const hipRow = Math.round(anatomy.hipV * (height - 1));
  const midCol = Math.round(anatomy.centerX * (width - 1));
  const headCol = Math.round(anatomy.headCenterX * (width - 1));
  // Measure true head horizontal envelope near upper-head (above shoulders) so broad suit shoulders
  // NEVER get swallowed into the rotating head segment!
  let headMinCol = Math.max(0, headCol - Math.round(width * 0.17));
  let headMaxCol = Math.min(width - 1, headCol + Math.round(width * 0.17));
  const hScanY0 = Math.max(0, Math.round((anatomy.headCenterY - 0.09) * (height - 1)));
  const hScanY1 = Math.max(hScanY0 + 1, Math.min(neckRow - 3, Math.round((anatomy.headCenterY - 0.02) * (height - 1))));
  let measuredL = width;
  let measuredR = 0;
  for (let y = hScanY0; y <= hScanY1; y++) {
    for (let x = 0; x < width; x++) {
      if (opaque[y * width + x]) {
        if (x < measuredL) measuredL = x;
        if (x > measuredR) measuredR = x;
      }
    }
  }
  if (measuredR > measuredL && measuredR - measuredL < width * 0.56) {
    headMinCol = Math.max(0, measuredL - 2);
    headMaxCol = Math.min(width - 1, measuredR + 2);
  }
  // Effective shoulder top row (broad blocky shoulders can start above chin level!)
  const shoulderTopRow = Math.max(2, Math.round((anatomy.headEndV - 0.09) * (height - 1)));

  // 0: Head (center + crown)
  seedSegment(anatomy.headCenterX, Math.max(0.06, anatomy.headCenterY - 0.08), anatomy.headCenterX, anatomy.headCenterY + 0.04, 0, 4);
  // 1: Torso (spine from below neck down to hips + upper inner shoulders outside head envelope!)
  seedSegment(anatomy.centerX, Math.min(anatomy.hipV - 0.04, anatomy.neckY + 0.05), anatomy.centerX, anatomy.hipV - 0.03, 1, 5);

  // 2 & 3: Direct silhouette-aware seeding for BOTH Left Arm and Right Arm!
  // Every opaque pixel protruding beyond the real torso walls in the upper-body zone seeds its arm directly!
  const armMinRow = Math.max(0, shoulderTopRow);
  const armMaxRow = Math.min(height - 1, hipRow + 1);
  let seededArmL = false;
  let seededArmR = false;
  for (let y = armMinRow; y <= armMaxRow; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (!opaque[idx]) continue;
      if (x <= torsoLeftCol - 2) {
        pushSeedAt(idx, 2, 0);
        seededArmL = true;
      } else if (x >= torsoRightCol + 2) {
        pushSeedAt(idx, 3, 0);
        seededArmR = true;
      } else if (y < neckRow && (x < headMinCol - 1 || x > headMaxCol + 1)) {
        // Broad shoulders rising above chin height belong to Torso, never Head!
        pushSeedAt(idx, 1, 0);
      }
    }
  }
  if (!seededArmL) {
    seedSegment(
      (torsoWalls.leftU + anatomy.handLeftX) * 0.5,
      (anatomy.shoulderY + anatomy.handLeftY) * 0.5,
      anatomy.handLeftX,
      anatomy.handLeftY,
      2,
      4
    );
  }
  if (!seededArmR) {
    seedSegment(
      (torsoWalls.rightU + anatomy.handRightX) * 0.5,
      (anatomy.shoulderY + anatomy.handRightY) * 0.5,
      anatomy.handRightX,
      anatomy.handRightY,
      3,
      4
    );
  }

  // 4: Left Leg (upper-thigh right below hip -> foot)
  seedSegment(
    Math.min(anatomy.centerX - 0.06, (anatomy.centerX - 0.08 + anatomy.footLeftX) * 0.5),
    Math.min(anatomy.groundV - 0.08, anatomy.hipV + 0.04),
    anatomy.footLeftX,
    Math.max(anatomy.hipV + 0.1, anatomy.groundV - 0.03),
    4,
    6
  );
  // 5: Right Leg (upper-thigh right below hip -> foot)
  seedSegment(
    Math.max(anatomy.centerX + 0.06, (anatomy.centerX + 0.08 + anatomy.footRightX) * 0.5),
    Math.min(anatomy.groundV - 0.08, anatomy.hipV + 0.04),
    anatomy.footRightX,
    Math.max(anatomy.hipV + 0.1, anatomy.groundV - 0.03),
    5,
    6
  );

  // 4-neighbor geodesic propagation
  for (let c = 0; c < MAX_COST; c++) {
    const b = buckets[c];
    if (b.length === 0) continue;
    for (let bi = 0; bi < b.length; bi++) {
      const cur = b[bi];
      if (dist[cur] < c) continue;
      const lbl = labels[cur];
      const cx = cur % width;
      const cy = (cur - cx) / width;

      const relax = (nx: number, ny: number) => {
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) return;
        const nIdx = ny * width + nx;
        // Cheap through opaque character pixels, very expensive across empty air (keeps canes/props on hands, never legs!)
        let stepCost = opaque[nIdx] ? 2 : 44;
        // Hanging arms & hand-held props (canes, umbrellas, staffs) outside the torso flow swiftly downward from hands
        if (opaque[nIdx] && ny > hipRow && ((lbl === 2 && nx < torsoLeftCol - 2) || (lbl === 3 && nx > torsoRightCol + 2))) {
          stepCost = 1;
        }

        // Soft anatomical boundary guards so parts respect natural joints cleanly:
        // - Head stays inside head horizontal column & above neck line; torso/arms may occupy shoulders beside head!
        if (lbl === 0 && (ny > neckRow + 1 || nx < headMinCol - 2 || nx > headMaxCol + 2)) stepCost += 18;
        if (lbl !== 0 && ny < neckRow - 1 && nx >= headMinCol && nx <= headMaxCol) stepCost += 18;
        // - Torso stays cleanly inside torso walls and yields outer upper thighs to legs (keeping center hem intact!)
        if (lbl === 1 && (nx < torsoLeftCol - 1 || nx > torsoRightCol + 1)) stepCost += 18;
        if (lbl === 1 && ny > hipRow + 2 && Math.abs(nx - midCol) > 3) stepCost += 14;
        // - Arms stop cleanly at the torso wall (never bite into chest!)
        if (lbl === 2 && nx > torsoLeftCol + 1) stepCost += 14;
        if (lbl === 3 && nx < torsoRightCol - 1) stepCost += 14;
        // - Legs stay below hips and respect left/right midline
        if ((lbl === 4 || lbl === 5) && ny < hipRow - 1) stepCost += 12;
        if (lbl === 4 && nx > midCol + 2) stepCost += 12;
        if (lbl === 5 && nx < midCol - 2) stepCost += 12;

        const nd = c + stepCost;
        if (nd < dist[nIdx] && nd < MAX_COST) {
          dist[nIdx] = nd;
          labels[nIdx] = lbl;
          buckets[nd].push(nIdx);
        }
      };

      relax(cx - 1, cy);
      relax(cx + 1, cy);
      relax(cx, cy - 1);
      relax(cx, cy + 1);
    }
  }

  const counts: Record<LimbPartId, number> = {
    head: 0,
    torso: 0,
    arm_l: 0,
    arm_r: 0,
    leg_l: 0,
    leg_r: 0,
  };
  for (let i = 0; i < N; i++) {
    if (!opaque[i]) continue;
    const lbl = labels[i];
    if (lbl >= 0 && lbl < PART_ORDER.length) {
      counts[PART_ORDER[lbl]]++;
    }
  }

  return { labels, counts };
}

// ============================================================================
// 4. FACE EYE DETECTOR (Detects Real Drawn Eyes for Natural Blinking!)
// ============================================================================

export function detectFaceEyesFromPixels(
  srcRgba: Uint8ClampedArray,
  width: number,
  height: number,
  anatomy: DrawingAnatomy
): DetectedEyes {
  const fallback: DetectedEyes = {
    found: false,
    left: { x: anatomy.headCenterX - 0.065, y: anatomy.headCenterY - 0.015 },
    right: { x: anatomy.headCenterX + 0.065, y: anatomy.headCenterY - 0.015 },
    radius: 0.024,
  };
  if (width < 24 || height < 24) return fallback;

  const cxPx = Math.round(anatomy.headCenterX * width);
  const spanX = Math.max(6, Math.round(width * 0.14));

  // Locate the brightest vertical face band inside the head (skips dark hats on top & dark grins below!)
  const headTopPx = Math.max(2, Math.floor(height * 0.03));
  const headBotPx = Math.min(height - 3, Math.ceil(anatomy.headEndV * height));
  let faceStartRow = Math.max(headTopPx, Math.floor((anatomy.headCenterY - 0.08) * height));
  let faceEndRow = Math.min(headBotPx, Math.ceil((anatomy.headCenterY + 0.06) * height));

  // Find the LARGEST contiguous bright vertical face band inside the head
  // (skips striped horns / hat ornaments on top AND dark open grins below!)
  let bestRunTop = -1;
  let bestRunBot = -1;
  let curRunTop = -1;
  const faceScanHalfW = Math.max(4, Math.round(width * 0.09));
  for (let y = headTopPx; y <= headBotPx; y++) {
    let brightCnt = 0;
    let totalCnt = 0;
    for (let x = Math.max(1, cxPx - faceScanHalfW); x <= Math.min(width - 2, cxPx + faceScanHalfW); x++) {
      const i = (y * width + x) * 4;
      if (srcRgba[i + 3] < 140) continue;
      totalCnt++;
      const lum = 0.299 * srcRgba[i] + 0.587 * srcRgba[i + 1] + 0.114 * srcRgba[i + 2];
      if (lum > 165) brightCnt++;
    }
    const isBrightRow = totalCnt > 3 && brightCnt / totalCnt > 0.34;
    if (isBrightRow) {
      if (curRunTop === -1) curRunTop = y;
      if (y - curRunTop > bestRunBot - bestRunTop) {
        bestRunTop = curRunTop;
        bestRunBot = y;
      }
    } else {
      curRunTop = -1;
    }
  }
  // Focus eye search on the upper face band (10%..44% of face height) so wide smiles/beards never interfere!
  if (bestRunTop >= 0 && bestRunBot - bestRunTop >= Math.max(10, height * 0.07)) {
    const faceH = bestRunBot - bestRunTop;
    faceStartRow = Math.max(headTopPx, bestRunTop + Math.round(faceH * 0.08));
    faceEndRow = Math.min(headBotPx, bestRunTop + Math.round(faceH * 0.44));
  }

  const yMin = faceStartRow;
  const yMax = Math.max(yMin + 4, faceEndRow);

  const findDarkEyeDot = (x0: number, x1: number): { x: number; y: number; count: number } => {
    let sx = 0;
    let sy = 0;
    let cnt = 0;
    const lx0 = Math.max(1, x0);
    const lx1 = Math.min(width - 2, x1);
    for (let y = yMin; y <= yMax; y++) {
      for (let x = lx0; x <= lx1; x++) {
        const i = (y * width + x) * 4;
        const a = srcRgba[i + 3];
        if (a < 150) continue;
        const lum = 0.299 * srcRgba[i] + 0.587 * srcRgba[i + 1] + 0.114 * srcRgba[i + 2];
        if (lum < 95) {
          // Prefer dark pupils surrounded by light sclera/face pixels rather than outer side hair!
          const lOff = (y * width + Math.max(0, x - 3)) * 4;
          const rOff = (y * width + Math.min(width - 1, x + 3)) * 4;
          const lBright = srcRgba[lOff + 3] > 140 && srcRgba[lOff] + srcRgba[lOff + 1] + srcRgba[lOff + 2] > 420;
          const rBright = srcRgba[rOff + 3] > 140 && srcRgba[rOff] + srcRgba[rOff + 1] + srcRgba[rOff + 2] > 420;
          const weight = lBright || rBright ? 3 : 1;
          sx += x * weight;
          sy += y * weight;
          cnt += weight;
        }
      }
    }
    if (cnt < 3 || cnt > (yMax - yMin + 1) * (lx1 - lx0 + 1) * 1.45) {
      return { x: 0, y: 0, count: 0 };
    }
    return { x: sx / cnt / width, y: sy / cnt / height, count: cnt };
  };

  const innerSpan = Math.max(5, Math.round(width * 0.095));
  const leftEye = findDarkEyeDot(cxPx - innerSpan, cxPx - 2);
  const rightEye = findDarkEyeDot(cxPx + 2, cxPx + innerSpan);

  if (leftEye.count >= 3 && rightEye.count >= 3) {
    const avgY = (leftEye.y + rightEye.y) * 0.5;
    if (Math.abs(leftEye.y - rightEye.y) < 0.06 && rightEye.x - leftEye.x > 0.032) {
      const approxR = Math.max(
        0.018,
        Math.min(0.034, Math.sqrt((leftEye.count + rightEye.count) * 0.25) / Math.max(width, height) * 0.85)
      );
      return {
        found: true,
        left: { x: leftEye.x, y: avgY },
        right: { x: rightEye.x, y: avgY },
        radius: approxR,
      };
    }
  }

  // Fallback with wider span if eyes are wide-set
  const wideL = findDarkEyeDot(cxPx - spanX, cxPx - 2);
  const wideR = findDarkEyeDot(cxPx + 2, cxPx + spanX);
  if (wideL.count >= 3 && wideR.count >= 3) {
    const avgY = (wideL.y + wideR.y) * 0.5;
    if (Math.abs(wideL.y - wideR.y) < 0.06 && wideR.x - wideL.x > 0.04) {
      return {
        found: true,
        left: { x: wideL.x, y: avgY },
        right: { x: wideR.x, y: avgY },
        radius: 0.024,
      };
    }
  }
  return fallback;
}

/**
 * Pure pixel-space baker for pre-tinted far limbs and crisp hand-cut paper-halo night cutouts!
 * Runs ONCE at rig-build time (<3ms) so the 60fps & GIF loops use ZERO ctx.filter calls!
 */
function bakePartVariantsRGBA(
  srcBuf: Uint8ClampedArray,
  sw: number,
  sh: number,
  bbox: { minX: number; minY: number; maxX: number; maxY: number },
  haloRadius: number,
  includeDarkAndFar = true
): {
  darkRgba: Uint8ClampedArray;
  nightRgba: Uint8ClampedArray;
  nightFarRgba: Uint8ClampedArray;
} {
  const darkBuf = includeDarkAndFar ? new Uint8ClampedArray(sw * sh * 4) : new Uint8ClampedArray(0);
  const nightBuf = new Uint8ClampedArray(sw * sh * 4);
  const nightFarBuf = includeDarkAndFar ? new Uint8ClampedArray(sw * sh * 4) : new Uint8ClampedArray(0);
  if (bbox.maxX < bbox.minX || bbox.maxY < bbox.minY) {
    return { darkRgba: darkBuf, nightRgba: nightBuf, nightFarRgba: nightFarBuf };
  }

  const pad = haloRadius + 1;
  const x0 = Math.max(0, bbox.minX - pad);
  const y0 = Math.max(0, bbox.minY - pad);
  const x1 = Math.min(sw - 1, bbox.maxX + pad);
  const y1 = Math.min(sh - 1, bbox.maxY + pad);

  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  const hMax = new Uint8Array(bw * bh);
  const dil = new Uint8Array(bw * bh);

  for (let ly = 0; ly < bh; ly++) {
    const y = y0 + ly;
    const rowOff = y * sw;
    const hRow = ly * bw;
    for (let lx = 0; lx < bw; lx++) {
      let mx = 0;
      const sx0 = Math.max(x0, x0 + lx - haloRadius);
      const sx1 = Math.min(x1, x0 + lx + haloRadius);
      for (let sx = sx0; sx <= sx1; sx++) {
        const a = srcBuf[(rowOff + sx) * 4 + 3];
        if (a > mx) mx = a;
      }
      hMax[hRow + lx] = mx;
    }
  }
  for (let ly = 0; ly < bh; ly++) {
    const sy0 = Math.max(0, ly - haloRadius);
    const sy1 = Math.min(bh - 1, ly + haloRadius);
    const dRow = ly * bw;
    for (let lx = 0; lx < bw; lx++) {
      let mx = 0;
      for (let sy = sy0; sy <= sy1; sy++) {
        const a = hMax[sy * bw + lx];
        if (a > mx) mx = a;
      }
      dil[dRow + lx] = mx;
    }
  }

  for (let ly = 0; ly < bh; ly++) {
    const y = y0 + ly;
    const dRow = ly * bw;
    for (let lx = 0; lx < bw; lx++) {
      const x = x0 + lx;
      const off = (y * sw + x) * 4;
      const a = srcBuf[off + 3];
      const haloA = dil[dRow + lx];

      if (includeDarkAndFar && a > 0) {
        darkBuf[off] = Math.round(srcBuf[off] * 0.85);
        darkBuf[off + 1] = Math.round(srcBuf[off + 1] * 0.84);
        darkBuf[off + 2] = Math.round(srcBuf[off + 2] * 0.87);
        darkBuf[off + 3] = a;
      }

      if (haloA > 16) {
        const sa = a / 255;
        const ha = Math.min(1, (haloA / 255) * 0.9);
        const outA = sa + ha * (1 - sa);
        if (outA > 0.01) {
          const nr = (srcBuf[off] * sa + 252 * ha * (1 - sa)) / outA;
          const ng = (srcBuf[off + 1] * sa + 240 * ha * (1 - sa)) / outA;
          const nb = (srcBuf[off + 2] * sa + 212 * ha * (1 - sa)) / outA;
          nightBuf[off] = Math.min(255, Math.round(nr));
          nightBuf[off + 1] = Math.min(255, Math.round(ng));
          nightBuf[off + 2] = Math.min(255, Math.round(nb));
          nightBuf[off + 3] = Math.min(255, Math.round(outA * 255));

          if (includeDarkAndFar) {
            const fr = (srcBuf[off] * 0.86 * sa + 218 * ha * (1 - sa)) / outA;
            const fg = (srcBuf[off + 1] * 0.86 * sa + 212 * ha * (1 - sa)) / outA;
            const fb = (srcBuf[off + 2] * 0.9 * sa + 196 * ha * (1 - sa)) / outA;
            nightFarBuf[off] = Math.min(255, Math.round(fr));
            nightFarBuf[off + 1] = Math.min(255, Math.round(fg));
            nightFarBuf[off + 2] = Math.min(255, Math.round(fb));
            nightFarBuf[off + 3] = Math.min(255, Math.round(outA * 255));
          }
        }
      }
    }
  }

  return { darkRgba: darkBuf, nightRgba: nightBuf, nightFarRgba: nightFarBuf };
}

/** Pure Worker-safe box-area RGBA downsampler (replaces DOM gctx.drawImage) */
function downsampleRgbaToGrid(
  src: Uint8ClampedArray,
  sw: number,
  sh: number,
  gw: number,
  gh: number
): Uint8ClampedArray {
  if (sw === gw && sh === gh) return new Uint8ClampedArray(src);
  const dst = new Uint8ClampedArray(gw * gh * 4);
  const scaleX = sw / gw;
  const scaleY = sh / gh;

  for (let gy = 0; gy < gh; gy++) {
    const sy0 = Math.floor(gy * scaleY);
    const sy1 = Math.min(sh, Math.max(sy0 + 1, Math.ceil((gy + 1) * scaleY)));
    for (let gx = 0; gx < gw; gx++) {
      const sx0 = Math.floor(gx * scaleX);
      const sx1 = Math.min(sw, Math.max(sx0 + 1, Math.ceil((gx + 1) * scaleX)));
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sa = 0;
      let cnt = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        const ro = sy * sw;
        for (let sx = sx0; sx < sx1; sx++) {
          const o = (ro + sx) * 4;
          const a = src[o + 3];
          sr += src[o] * a;
          sg += src[o + 1] * a;
          sb += src[o + 2] * a;
          sa += a;
          cnt++;
        }
      }
      const dOff = (gy * gw + gx) * 4;
      if (sa > 0 && cnt > 0) {
        dst[dOff] = Math.round(sr / sa);
        dst[dOff + 1] = Math.round(sg / sa);
        dst[dOff + 2] = Math.round(sb / sa);
        dst[dOff + 3] = Math.round(sa / cnt);
      }
    }
  }
  return dst;
}

function rgbaToHtmlCanvas(rgba: Uint8ClampedArray, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  if (rgba.length === w * h * 4) {
    const ctx = c.getContext('2d');
    if (ctx) {
      const img = ctx.createImageData(w, h);
      img.data.set(rgba);
      ctx.putImageData(img, 0, 0);
    }
  }
  return c;
}

// ============================================================================
// 5. PURE RGBA WORKER-SAFE PACK BUILDER + MAIN-THREAD CANVAS HYDRATION
// ============================================================================

/**
 * Pure pixel-buffer (`Uint8ClampedArray`) character base builder with ZERO DOM/HTMLCanvas dependencies.
 * Runs identically inside `rigWorker.ts` (off-main-thread!), Node/Vitest, and browsers.
 */
export function prepareRigPackBaseRGBA(
  srcRgba: Uint8ClampedArray,
  sw: number,
  sh: number,
  initialAnatomy: DrawingAnatomy
): PreparedRigPackBaseRGBA {
  const anatomy: DrawingAnatomy = { ...initialAnatomy };

  // 1. Auto-fill enclosed head/torso contours with warm gouache paper volume
  const { rgba: filledRgba } = fillClosedContoursRGBA(srcRgba, sw, sh, anatomy.headEndV);

  const haloR = Math.max(2, Math.min(5, Math.round(Math.min(sw, sh) * 0.014)));
  const { nightRgba: nightFilledRgba } = bakePartVariantsRGBA(
    filledRgba,
    sw,
    sh,
    { minX: 0, minY: 0, maxX: sw - 1, maxY: sh - 1 },
    haloR,
    false
  );

  // 2. Detect real drawn eyes for natural blinking
  const eyes = detectFaceEyesFromPixels(srcRgba, sw, sh, anatomy);

  // 3. Downscale to compact analysis grid (<= 112px) in pure RGBA (zero DOM canvas!)
  const maxGrid = 112;
  const scale = Math.min(1, maxGrid / Math.max(sw, sh));
  const gw = Math.max(24, Math.round(sw * scale));
  const gh = Math.max(24, Math.round(sh * scale));
  const gData = downsampleRgbaToGrid(filledRgba, sw, sh, gw, gh);

  const torsoWalls = detectTorsoWalls(gData, gw, gh, anatomy);
  const { labels, counts } = computeGeodesicPartLabels(gData, gw, gh, anatomy);

  const jointSpecs: Record<LimbPartId, { root: Vec2; mid: Vec2; end: Vec2 }> = {
    head: {
      root: { x: anatomy.neckX, y: anatomy.headEndV },
      mid: { x: anatomy.headCenterX, y: anatomy.headCenterY },
      end: { x: anatomy.headCenterX, y: Math.max(0.02, anatomy.headCenterY - 0.14) },
    },
    torso: {
      root: { x: anatomy.centerX, y: anatomy.hipV },
      mid: { x: anatomy.centerX, y: (anatomy.hipV + anatomy.neckY) * 0.5 },
      end: { x: anatomy.neckX, y: anatomy.headEndV },
    },
    arm_l: {
      root: { x: torsoWalls.leftU, y: anatomy.shoulderY },
      mid: {
        x: (torsoWalls.leftU + anatomy.handLeftX) * 0.5,
        y: (anatomy.shoulderY + anatomy.handLeftY) * 0.5 + 0.02,
      },
      end: { x: anatomy.handLeftX, y: anatomy.handLeftY },
    },
    arm_r: {
      root: { x: torsoWalls.rightU, y: anatomy.shoulderY },
      mid: {
        x: (torsoWalls.rightU + anatomy.handRightX) * 0.5,
        y: (anatomy.shoulderY + anatomy.handRightY) * 0.5 + 0.02,
      },
      end: { x: anatomy.handRightX, y: anatomy.handRightY },
    },
    leg_l: {
      root: { x: Math.max(torsoWalls.leftU + 0.02, anatomy.centerX - 0.075), y: anatomy.hipV },
      mid: {
        x: (anatomy.centerX - 0.075 + anatomy.footLeftX) * 0.5,
        y: (anatomy.hipV + anatomy.groundV) * 0.5,
      },
      end: { x: anatomy.footLeftX, y: anatomy.groundV },
    },
    leg_r: {
      root: { x: Math.min(torsoWalls.rightU - 0.02, anatomy.centerX + 0.075), y: anatomy.hipV },
      mid: {
        x: (anatomy.centerX + 0.075 + anatomy.footRightX) * 0.5,
        y: (anatomy.hipV + anatomy.groundV) * 0.5,
      },
      end: { x: anatomy.footRightX, y: anatomy.groundV },
    },
  };

  // Refine real shoulder Y and hip X directly from segmented pixels
  {
    const armLCol = Math.round(torsoWalls.leftU * (gw - 1));
    const armRCol = Math.round(torsoWalls.rightU * (gw - 1));
    const armLYs: number[] = [];
    const armRYs: number[] = [];
    const hipBand0 = Math.max(0, Math.round((anatomy.hipV - 0.02) * (gh - 1)));
    const hipBand1 = Math.min(gh - 1, Math.round((anatomy.hipV + 0.09) * (gh - 1)));
    let legLX = 0;
    let legLCnt = 0;
    let legRX = 0;
    let legRCnt = 0;

    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        if (gData[(y * gw + x) * 4 + 3] <= 28) continue;
        const lbl = labels[y * gw + x];
        if (lbl === 2 && x >= armLCol - 6 && x <= armLCol + 2) {
          armLYs.push(y);
        } else if (lbl === 3 && x >= armRCol - 2 && x <= armRCol + 6) {
          armRYs.push(y);
        } else if (lbl === 4 && y >= hipBand0 && y <= hipBand1) {
          legLX += x;
          legLCnt++;
        } else if (lbl === 5 && y >= hipBand0 && y <= hipBand1) {
          legRX += x;
          legRCnt++;
        }
      }
    }
    if (armLYs.length > 2) {
      armLYs.sort((a, b) => a - b);
      jointSpecs.arm_l.root.y = armLYs[Math.floor(armLYs.length * 0.24)] / Math.max(1, gh - 1);
    }
    if (armRYs.length > 2) {
      armRYs.sort((a, b) => a - b);
      jointSpecs.arm_r.root.y = armRYs[Math.floor(armRYs.length * 0.24)] / Math.max(1, gh - 1);
    }
    if (legLCnt > 1) jointSpecs.leg_l.root.x = Math.min(anatomy.centerX - 0.03, legLX / legLCnt / Math.max(1, gw - 1));
    if (legRCnt > 1) jointSpecs.leg_r.root.x = Math.max(anatomy.centerX + 0.03, legRX / legRCnt / Math.max(1, gw - 1));
  }

  const partsRgba = {} as Record<LimbPartId, PreparedLimbPartRGBA>;
  const jointOverlapPx = Math.max(10, Math.round(Math.min(sw, sh) * 0.068));
  const hipMaxY = Math.round(anatomy.hipV * (sh - 1)) + 4;

  PART_ORDER.forEach((partId, partIdx) => {
    const spec = jointSpecs[partId];
    const outBuf = new Uint8ClampedArray(sw * sh * 4);

    const jxPx = spec.root.x * (sw - 1);
    const jyPx = spec.root.y * (sh - 1);

    let minX = sw;
    let minY = sh;
    let maxX = 0;
    let maxY = 0;
    let pxCount = 0;

    for (let y = 0; y < sh; y++) {
      const gy = Math.min(gh - 1, Math.floor((y / Math.max(1, sh - 1)) * (gh - 1)));
      const gRow = gy * gw;
      for (let x = 0; x < sw; x++) {
        const srcOff = (y * sw + x) * 4;
        const a = filledRgba[srcOff + 3];
        if (a < 16) continue;

        const gx = Math.min(gw - 1, Math.floor((x / Math.max(1, sw - 1)) * (gw - 1)));
        const owner = labels[gRow + gx];

        let keepAlpha = 0;
        if (owner === partIdx) {
          keepAlpha = 1;
        } else if (partId !== 'torso') {
          const isLeg = partId === 'leg_l' || partId === 'leg_r';
          const isArm = partId === 'arm_l' || partId === 'arm_r';
          const effectiveOverlap = isLeg ? jointOverlapPx * 1.45 : isArm ? jointOverlapPx * 1.4 : jointOverlapPx;
          const d2 = (x - jxPx) * (x - jxPx) + (y - jyPx) * (y - jyPx);
          if (d2 < effectiveOverlap * effectiveOverlap && (owner === 1 || (isLeg && (owner === 4 || owner === 5)))) {
            const t = 1 - Math.sqrt(d2) / effectiveOverlap;
            keepAlpha = t * t * (3 - 2 * t) * 0.98;
          } else if (partId === 'head' && owner === 1) {
            const dyNeck = y - anatomy.headEndV * (sh - 1);
            const dxNeck = Math.abs(x - anatomy.neckX * (sw - 1));
            if (dyNeck >= 0 && dyNeck < jointOverlapPx * 0.9 && dxNeck < sw * 0.16) {
              keepAlpha = (1 - dyNeck / (jointOverlapPx * 0.9)) * 0.92;
            }
          }
        } else if (partId === 'torso' && y <= hipMaxY + jointOverlapPx * 1.2) {
          const nearNeck = Math.hypot(x - anatomy.neckX * sw, y - anatomy.headEndV * sh) < jointOverlapPx * 1.1;
          const nearShL = Math.hypot(x - jointSpecs.arm_l.root.x * sw, y - jointSpecs.arm_l.root.y * sh) < jointOverlapPx * 1.35;
          const nearShR = Math.hypot(x - jointSpecs.arm_r.root.x * sw, y - jointSpecs.arm_r.root.y * sh) < jointOverlapPx * 1.35;
          const nearHipL = Math.hypot(x - jointSpecs.leg_l.root.x * sw, y - jointSpecs.leg_l.root.y * sh) < jointOverlapPx * 1.25;
          const nearHipR = Math.hypot(x - jointSpecs.leg_r.root.x * sw, y - jointSpecs.leg_r.root.y * sh) < jointOverlapPx * 1.25;
          if (
            (nearNeck && owner === 0) ||
            (nearShL && owner === 2) ||
            (nearShR && owner === 3) ||
            (nearHipL && owner === 4) ||
            (nearHipR && owner === 5)
          ) {
            keepAlpha = 0.92;
          }
        }

        if (keepAlpha > 0.02) {
          outBuf[srcOff] = filledRgba[srcOff];
          outBuf[srcOff + 1] = filledRgba[srcOff + 1];
          outBuf[srcOff + 2] = filledRgba[srcOff + 2];
          outBuf[srcOff + 3] = Math.round(a * keepAlpha);
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          pxCount++;
        }
      }
    }

    let refinedEnd = { ...spec.end };
    if (pxCount > 12) {
      const tipBand = Math.max(4, Math.round((maxX - minX) * 0.14));
      if (partId === 'arm_l') {
        let sy = 0;
        let cnt = 0;
        for (let y = minY; y <= maxY; y++) {
          for (let x = minX; x <= Math.min(maxX, minX + tipBand); x++) {
            if (outBuf[(y * sw + x) * 4 + 3] > 60) {
              sy += y;
              cnt++;
            }
          }
        }
        refinedEnd = {
          x: minX / Math.max(1, sw - 1),
          y: cnt > 0 ? sy / cnt / Math.max(1, sh - 1) : spec.end.y,
        };
      } else if (partId === 'arm_r') {
        let sy = 0;
        let cnt = 0;
        for (let y = minY; y <= maxY; y++) {
          for (let x = Math.max(minX, maxX - tipBand); x <= maxX; x++) {
            if (outBuf[(y * sw + x) * 4 + 3] > 60) {
              sy += y;
              cnt++;
            }
          }
        }
        refinedEnd = {
          x: maxX / Math.max(1, sw - 1),
          y: cnt > 0 ? sy / cnt / Math.max(1, sh - 1) : spec.end.y,
        };
      } else if (partId === 'leg_l' || partId === 'leg_r') {
        const footBand = Math.max(4, Math.round((maxY - minY) * 0.12));
        let sx = 0;
        let cnt = 0;
        for (let y = Math.max(minY, maxY - footBand); y <= maxY; y++) {
          for (let x = minX; x <= maxX; x++) {
            if (outBuf[(y * sw + x) * 4 + 3] > 60) {
              sx += x;
              cnt++;
            }
          }
        }
        refinedEnd = {
          x: cnt > 0 ? sx / cnt / Math.max(1, sw - 1) : spec.end.x,
          y: maxY / Math.max(1, sh - 1),
        };
      }
    }
    const refinedMid: Vec2 = {
      x: (spec.root.x + refinedEnd.x) * 0.5,
      y: (spec.root.y + refinedEnd.y) * 0.5,
    };

    const { darkRgba, nightRgba, nightFarRgba } = bakePartVariantsRGBA(
      outBuf,
      sw,
      sh,
      { minX, minY, maxX, maxY },
      haloR,
      true
    );

    partsRgba[partId] = {
      id: partId,
      rgba: outBuf,
      darkRgba,
      nightRgba,
      nightFarRgba,
      u0: maxX >= minX ? minX / sw : 0,
      v0: maxY >= minY ? minY / sh : 0,
      u1: maxX >= minX ? (maxX + 1) / sw : 1,
      v1: maxY >= minY ? (maxY + 1) / sh : 1,
      root: spec.root,
      mid: refinedMid,
      end: refinedEnd,
      pixelCount: pxCount,
    };
  });

  const totalOpaque = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
  const aspectWH = sw / Math.max(1, sh);
  const hasRealLegs =
    anatomy.bipedal &&
    counts.leg_l / totalOpaque > 0.012 &&
    counts.leg_r / totalOpaque > 0.012 &&
    counts.head / totalOpaque > 0.04;

  let neckMinRowW = sw;
  let bodyMaxRowW = 1;
  const ny0 = Math.max(0, Math.floor((anatomy.headEndV - 0.06) * sh));
  const ny1 = Math.min(sh - 1, Math.ceil((anatomy.headEndV + 0.06) * sh));
  const by0 = Math.max(0, Math.floor(anatomy.headEndV * sh));
  const by1 = Math.min(sh - 1, Math.ceil(Math.min(0.9, anatomy.groundV - 0.06) * sh));
  for (let y = ny0; y <= by1; y += 2) {
    let lx = sw;
    let rx = -1;
    const row = y * sw;
    for (let x = 0; x < sw; x += 2) {
      if (filledRgba[(row + x) * 4 + 3] > 28) {
        if (x < lx) lx = x;
        if (x > rx) rx = x;
      }
    }
    if (rx > lx) {
      const rw = rx - lx;
      if (y <= ny1 && rw < neckMinRowW) neckMinRowW = rw;
      if (y >= by0 && rw > bodyMaxRowW) bodyMaxRowW = rw;
    }
  }
  const hasRealNeckNarrowing = neckMinRowW < bodyMaxRowW * 0.66;

  const hasDressHumanoidSilhouette =
    !anatomy.bipedal &&
    aspectWH <= 1.22 &&
    hasRealNeckNarrowing &&
    counts.head / totalOpaque > 0.04 &&
    counts.arm_l / totalOpaque > 0.014 &&
    counts.arm_r / totalOpaque > 0.014 &&
    anatomy.handRightX - anatomy.handLeftX > 0.56;

  let archetype: CharacterArchetype = 'floater';
  if (aspectWH > 1.22 && anatomy.bipedal) {
    archetype = 'quadruped';
  } else if ((hasRealLegs || hasDressHumanoidSilhouette) && aspectWH <= 1.22) {
    archetype = 'humanoid';
  }

  const fx = Math.max(0, Math.min(sw - 1, Math.round(anatomy.headCenterX * (sw - 1))));
  const fy = Math.max(0, Math.min(sh - 1, Math.round(anatomy.headCenterY * (sh - 1))));
  const fOff = (fy * sw + fx) * 4;
  const faceFillColor =
    filledRgba[fOff + 3] > 200 && filledRgba[fOff] + filledRgba[fOff + 1] + filledRgba[fOff + 2] > 320
      ? `rgb(${filledRgba[fOff]}, ${filledRgba[fOff + 1]}, ${filledRgba[fOff + 2]})`
      : '#FAF3E4';

  let inkR = 28;
  let inkG = 25;
  let inkB = 23;
  let inkCnt = 0;
  let sumIR = 0;
  let sumIG = 0;
  let sumIB = 0;
  const stepInk = Math.max(1, Math.floor((sw * sh) / 2400));
  for (let i = 0; i < sw * sh; i += stepInk) {
    const o = i * 4;
    if (srcRgba[o + 3] < 160) continue;
    const lum = 0.299 * srcRgba[o] + 0.587 * srcRgba[o + 1] + 0.114 * srcRgba[o + 2];
    if (lum < 120) {
      sumIR += srcRgba[o];
      sumIG += srcRgba[o + 1];
      sumIB += srcRgba[o + 2];
      inkCnt++;
    }
  }
  if (inkCnt > 4) {
    inkR = Math.round(sumIR / inkCnt);
    inkG = Math.round(sumIG / inkCnt);
    inkB = Math.round(sumIB / inkCnt);
  }
  const inkColor = `rgb(${inkR}, ${inkG}, ${inkB})`;

  const mx0 = Math.max(0, Math.floor((anatomy.mouthX - 0.065) * sw));
  const mx1 = Math.min(sw - 1, Math.ceil((anatomy.mouthX + 0.065) * sw));
  const my0 = Math.max(0, Math.floor((anatomy.mouthY - 0.038) * sh));
  const my1 = Math.min(sh - 1, Math.ceil((anatomy.mouthY + 0.038) * sh));
  let mouthDarkPx = 0;
  let mouthTotalPx = 0;
  for (let y = my0; y <= my1; y++) {
    for (let x = mx0; x <= mx1; x++) {
      const o = (y * sw + x) * 4;
      mouthTotalPx++;
      if (filledRgba[o + 3] > 180) {
        const lum = 0.299 * filledRgba[o] + 0.587 * filledRgba[o + 1] + 0.114 * filledRgba[o + 2];
        if (lum < 95) mouthDarkPx++;
      }
    }
  }
  const hasDrawnMouth = mouthTotalPx > 12 && mouthDarkPx / mouthTotalPx >= 0.14;

  return {
    filledRgba,
    nightFilledRgba,
    sw,
    sh,
    anatomy,
    eyes,
    partsRgba,
    archetype,
    faceFillColor,
    inkColor,
    hasDrawnMouth,
  };
}

export function resolveCreatureClassFromBaseRGBA(
  base: PreparedRigPackBaseRGBA,
  explicit?: UniversalCreatureClass
): UniversalCreatureClass {
  if (explicit) return explicit;
  if (base.archetype === 'humanoid') return 'humanoid';
  const auto = classifyUniversalCreatureRGBA(base.filledRgba, base.sw, base.sh, base.anatomy);
  if (auto.creatureClass !== 'humanoid') return auto.creatureClass;
  return base.archetype === 'quadruped' ? 'quadruped' : 'amorphous_vehicle';
}

export function hydrateRigPackFromWorkerData(
  sourceCanvas: HTMLCanvasElement,
  base: PreparedRigPackBaseRGBA,
  skinnedMesh: ConformingSkinnedMesh | null,
  silhouetteMesh: ConformingSkinnedMesh | null,
  creatureClass: UniversalCreatureClass
): RiggedCharacterPack {
  const { sw, sh } = base;
  const anatomy = base.anatomy;
  const filledCanvas = rgbaToHtmlCanvas(base.filledRgba, sw, sh);
  const nightFilledCanvas = rgbaToHtmlCanvas(base.nightFilledRgba, sw, sh);

  const parts = {} as Record<LimbPartId, SegmentedLimbPart>;
  for (const partId of PART_ORDER) {
    const p = base.partsRgba[partId];
    parts[partId] = {
      id: partId,
      canvas: rgbaToHtmlCanvas(p.rgba, sw, sh),
      darkCanvas: rgbaToHtmlCanvas(p.darkRgba, sw, sh),
      nightCanvas: rgbaToHtmlCanvas(p.nightRgba, sw, sh),
      nightFarCanvas: rgbaToHtmlCanvas(p.nightFarRgba, sw, sh),
      u0: p.u0,
      v0: p.v0,
      u1: p.u1,
      v1: p.v1,
      root: { ...p.root },
      mid: { ...p.mid },
      end: { ...p.end },
      pixelCount: p.pixelCount,
    };
  }

  const isHumanoid = creatureClass === 'humanoid';
  if (isHumanoid && skinnedMesh && skinnedMesh.bones.length >= 11) {
    parts.arm_l.root = { ...skinnedMesh.bones[3].start };
    parts.arm_l.mid = { ...skinnedMesh.bones[3].end };
    parts.arm_l.end = { ...skinnedMesh.bones[4].end };
    parts.arm_r.root = { ...skinnedMesh.bones[5].start };
    parts.arm_r.mid = { ...skinnedMesh.bones[5].end };
    parts.arm_r.end = { ...skinnedMesh.bones[6].end };
    parts.leg_l.root = { ...skinnedMesh.bones[7].start };
    parts.leg_l.mid = { ...skinnedMesh.bones[7].end };
    parts.leg_l.end = { ...skinnedMesh.bones[8].end };
    parts.leg_r.root = { ...skinnedMesh.bones[9].start };
    parts.leg_r.mid = { ...skinnedMesh.bones[9].end };
    parts.leg_r.end = { ...skinnedMesh.bones[10].end };

    anatomy.handLeftX = skinnedMesh.bones[4].end.x;
    anatomy.handLeftY = skinnedMesh.bones[4].end.y;
    anatomy.handRightX = skinnedMesh.bones[6].end.x;
    anatomy.handRightY = skinnedMesh.bones[6].end.y;
    anatomy.footLeftX = skinnedMesh.bones[8].end.x;
    anatomy.footRightX = skinnedMesh.bones[10].end.x;
  }

  return {
    filledCanvas,
    nightFilledCanvas,
    sourceCanvas,
    anatomy,
    eyes: base.eyes,
    parts,
    useMultiPart: isHumanoid,
    archetype: isHumanoid ? 'humanoid' : creatureClass === 'quadruped' ? 'quadruped' : base.archetype,
    creatureClass,
    faceFillColor: base.faceFillColor,
    inkColor: base.inkColor,
    hasDrawnMouth: base.hasDrawnMouth,
    skinnedMesh,
    silhouetteMesh,
  };
}

export interface BuildRigPackOptions {
  creatureClass?: UniversalCreatureClass;
  meshOptions?: ConformingMeshBuildOptions;
  /** Optional coalescing channel key: cancels any superseded in-flight worker request on the same channel */
  channelKey?: string;
  signal?: AbortSignal;
}

export function buildRiggedCharacterPack(
  sourceCanvas: HTMLCanvasElement,
  anatomy: DrawingAnatomy,
  opts?: BuildRigPackOptions
): RiggedCharacterPack {
  const sw = sourceCanvas.width;
  const sh = sourceCanvas.height;
  const sctx = sourceCanvas.getContext('2d', { willReadFrequently: true })!;
  const srcRgba = sctx.getImageData(0, 0, sw, sh).data;

  const base = prepareRigPackBaseRGBA(srcRgba, sw, sh, anatomy);
  const creatureClass = resolveCreatureClassFromBaseRGBA(base, opts?.creatureClass);
  const skinnedMesh =
    creatureClass === 'humanoid'
      ? buildConformingSkinnedMeshRGBA(base.filledRgba, base.sw, base.sh, base.anatomy, opts?.meshOptions)
      : buildUniversalCreatureMeshRGBA(base.filledRgba, base.sw, base.sh, base.anatomy, creatureClass, opts?.meshOptions);
  const silhouetteMesh =
    skinnedMesh ?? buildSilhouetteConformingMeshRGBA(base.filledRgba, base.sw, base.sh);
  return hydrateRigPackFromWorkerData(sourceCanvas, base, skinnedMesh, silhouetteMesh, creatureClass);
}

/**
 * INKTROPE V4 Full-Pipeline Async Rig Builder — offloads BOTH `prepareRigPackBaseRGBA`
 * (gouache contour fill, halo variants, geodesic limb segmentation) AND conforming mesh
 * construction (`rigWorker.ts`) off the UI thread with cancellable request coalescing!
 */
export async function buildRiggedCharacterPackAsync(
  sourceCanvas: HTMLCanvasElement,
  anatomy: DrawingAnatomy,
  opts?: BuildRigPackOptions
): Promise<RiggedCharacterPack> {
  const sw = sourceCanvas.width;
  const sh = sourceCanvas.height;
  const sctx = sourceCanvas.getContext('2d', { willReadFrequently: true });
  if (!sctx) {
    return buildRiggedCharacterPack(sourceCanvas, anatomy, opts);
  }
  const srcRgba = sctx.getImageData(0, 0, sw, sh).data;

  const fullWorkerRes = await buildFullRigPackInWorkerAsync(srcRgba, sw, sh, anatomy, {
    creatureClass: opts?.creatureClass,
    meshOptions: opts?.meshOptions,
    channelKey: opts?.channelKey,
    signal: opts?.signal,
  });

  if (fullWorkerRes) {
    return hydrateRigPackFromWorkerData(
      sourceCanvas,
      fullWorkerRes.base,
      fullWorkerRes.skinnedMesh,
      fullWorkerRes.silhouetteMesh,
      fullWorkerRes.creatureClass
    );
  }

  // Fallback path if Worker is disabled in Node/Vitest
  const base = prepareRigPackBaseRGBA(srcRgba, sw, sh, anatomy);
  const creatureClass = resolveCreatureClassFromBaseRGBA(base, opts?.creatureClass);
  const skinnedMesh =
    creatureClass === 'humanoid'
      ? await buildHumanoidMeshAsync(base.filledRgba, base.sw, base.sh, base.anatomy, opts?.meshOptions)
      : await buildCreatureMeshAsync(base.filledRgba, base.sw, base.sh, base.anatomy, creatureClass, opts?.meshOptions);
  const silhouetteMesh =
    skinnedMesh ?? (await buildSilhouetteMeshAsync(base.filledRgba, base.sw, base.sh));
  return hydrateRigPackFromWorkerData(sourceCanvas, base, skinnedMesh, silhouetteMesh, creatureClass);
}
