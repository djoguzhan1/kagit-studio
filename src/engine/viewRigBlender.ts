import type { CharacterMasterRig, CharacterViewAngle } from '../types/masterRig';
import { getAvailableRigAngles } from '../types/masterRig';
import type { FilmEmotionId } from '../types/film';
import type { RiggedCharacterPack, Vec2 } from './skeletonSkinEngine';
import { buildRiggedCharacterPack } from './skeletonSkinEngine';
import {
  analyzeDrawingAnatomyFromPixels,
  renderMultiLayerRiggedCharacter,
  type ArticulatedCartoonPose,
  type CharacterLiveAnchors,
  type RiggedIKOverrides,
} from './cartoonMotionEngine';
import type { KlausLightConfig } from './cpuRasterizer';
import type { UniversalActionId } from './universalCreatureRig';

/**
 * INKTROPE V4 — 360° 2.5D Multi-View Rig Blender & Mobile LRU-2 Memory Cache.
 *
 * Maps any continuous 360° yaw angle (-180°..+180°) across the artist's available
 * real drawings (front 0°, threeQuarter ±45°, side ±90° auto-mirrored for left, back ±180°):
 * - Zero pop/flicker: cosine micro-crossfade across view sector boundaries (~14° band)
 * - Spherical 2.5D perspective foreshortening between discrete angles (clamped >= 0.78!)
 * - Dynamic Klaus 2.5D light-shift so scene illumination sweeps naturally around the body
 * - Mobile LRU-2 cache: keeps 'front' + at most 2 active secondary view rigs in RAM
 */

export interface ViewBlendLayer {
  angle: CharacterViewAngle;
  mirrorX: boolean;
  /** Subtle spherical 2.5D perspective horizontal foreshortening (0.78..1.00) */
  squashX: number;
  /** Subtle vertical parallax shear in radians (-0.06..+0.06) */
  skewY: number;
  /** Layer blend opacity (primary + secondary = 1.0) */
  opacity: number;
}

export interface Resolved25DViewBlend {
  normalizedYawDeg: number;
  primary: ViewBlendLayer;
  secondary: ViewBlendLayer | null;
  /** -1..+1 horizontal directional light rotation shift as character turns */
  lightShiftX: number;
  /** True when the character is currently facing away from camera (> 115° yaw) */
  isBackFacing: boolean;
  /** Human-friendly angle sector label */
  activeSector: CharacterViewAngle;
}

/** Normalizes any degree angle cleanly into [-180, +180] */
export function normalizeYawDeg(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  let a = ((deg + 180) % 360 + 360) % 360 - 180;
  if (a === -180 && deg > 0) a = 180;
  return a;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / Math.max(1e-5, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Resolves exact 360° 2.5D multi-view blending for any combination of uploaded drawings!
 *
 * Angle convention:
 * -   0° = Front (facing camera)
 * - +45° = 3/4 Right (facing camera-right)   | -45° = 3/4 Left (mirrored)
 * - +90° = Side Right (profile facing right) | -90° = Side Left (mirrored)
 * - ±180° = Back (facing away from camera)
 */
export function resolve25DViewBlend(
  yawDeg: number,
  availableAngles: CharacterViewAngle[]
): Resolved25DViewBlend {
  const yaw = normalizeYawDeg(yawDeg);
  const absYaw = Math.abs(yaw);
  const sign = yaw < 0 ? -1 : 1;
  const yawRad = (yaw * Math.PI) / 180;
  const lightShiftX = Math.sin(yawRad);

  const hasFront = availableAngles.includes('front');
  const has34 = availableAngles.includes('threeQuarter');
  const hasSide = availableAngles.includes('side');
  const hasBack = availableAngles.includes('back');

  const fallbackFront: CharacterViewAngle = hasFront
    ? 'front'
    : availableAngles[0] ?? 'front';

  // Helper: subtle spherical perspective compression based on angular delta from a view's canonical yaw
  const makeLayer = (
    angle: CharacterViewAngle,
    canonicalAbsYaw: number,
    opacity: number,
    mirrorX: boolean
  ): ViewBlendLayer => {
    const deltaRad = ((absYaw - canonicalAbsYaw) * Math.PI) / 180;
    // Never collapse below 0.78x so hand-drawn strokes always stay crisp and volumetric!
    const squashX = clamp(0.80 + 0.20 * Math.cos(deltaRad * 1.15), 0.78, 1.0);
    const skewY = clamp(Math.sin(deltaRad) * sign * 0.032, -0.055, 0.055);
    return {
      angle,
      mirrorX,
      squashX,
      skewY,
      opacity: clamp(opacity, 0, 1),
    };
  };

  // Build ordered control nodes on [0°, 180°] based on what views the artist provided
  interface AngleNode {
    deg: number;
    angle: CharacterViewAngle;
    canMirror: boolean;
  }
  const nodes: AngleNode[] = [{ deg: 0, angle: fallbackFront, canMirror: false }];
  if (has34) nodes.push({ deg: 45, angle: 'threeQuarter', canMirror: true });
  if (hasSide) nodes.push({ deg: 90, angle: 'side', canMirror: true });
  if (hasBack) nodes.push({ deg: 180, angle: 'back', canMirror: false });

  // Single-view fallback: tasteful spherical foreshortening + clean mirror past 90°
  if (nodes.length === 1) {
    const mirror = yaw < -6;
    const squash = clamp(0.80 + 0.20 * Math.abs(Math.cos(yawRad)), 0.78, 1.0);
    const skew = clamp(Math.sin(yawRad) * 0.035, -0.055, 0.055);
    return {
      normalizedYawDeg: yaw,
      primary: {
        angle: fallbackFront,
        mirrorX: mirror,
        squashX: squash,
        skewY: skew,
        opacity: 1,
      },
      secondary: null,
      lightShiftX,
      isBackFacing: absYaw > 115,
      activeSector: fallbackFront,
    };
  }

  // Find bracketing nodes [loNode, hiNode] around absYaw
  let loIdx = 0;
  for (let i = 0; i < nodes.length - 1; i++) {
    if (absYaw >= nodes[i].deg) loIdx = i;
  }
  const loNode = nodes[loIdx];
  const hiNode = nodes[Math.min(nodes.length - 1, loIdx + 1)];

  // If beyond the last available node (e.g., user has Front + Side only and turns to 140°)
  if (loNode === hiNode || absYaw >= hiNode.deg) {
    const mirror = hiNode.canMirror ? sign < 0 : false;
    return {
      normalizedYawDeg: yaw,
      primary: makeLayer(hiNode.angle, hiNode.deg, 1, mirror),
      secondary: null,
      lightShiftX,
      isBackFacing: absYaw > 115,
      activeSector: hiNode.angle,
    };
  }

  // Midpoint transition band (±8° around midpoint -> fast ~70ms visual switch without ghost double-image!)
  const mid = (loNode.deg + hiNode.deg) * 0.5;
  const halfBand = Math.min(10, (hiNode.deg - loNode.deg) * 0.22);
  const blendToHi = smoothstep(mid - halfBand, mid + halfBand, absYaw);

  const loMirror = loNode.canMirror ? sign < 0 : false;
  const hiMirror = hiNode.canMirror ? sign < 0 : false;

  if (blendToHi <= 0.02) {
    return {
      normalizedYawDeg: yaw,
      primary: makeLayer(loNode.angle, loNode.deg, 1, loMirror),
      secondary: null,
      lightShiftX,
      isBackFacing: absYaw > 115,
      activeSector: loNode.angle,
    };
  }
  if (blendToHi >= 0.98) {
    return {
      normalizedYawDeg: yaw,
      primary: makeLayer(hiNode.angle, hiNode.deg, 1, hiMirror),
      secondary: null,
      lightShiftX,
      isBackFacing: absYaw > 115,
      activeSector: hiNode.angle,
    };
  }

  // Smooth micro-crossfade across the sector boundary
  const hiDominant = blendToHi >= 0.5;
  const primaryNode = hiDominant ? hiNode : loNode;
  const secondaryNode = hiDominant ? loNode : hiNode;
  const primaryOp = hiDominant ? blendToHi : 1 - blendToHi;
  const secondaryOp = 1 - primaryOp;

  return {
    normalizedYawDeg: yaw,
    primary: makeLayer(
      primaryNode.angle,
      primaryNode.deg,
      primaryOp,
      primaryNode.canMirror ? sign < 0 : false
    ),
    secondary: makeLayer(
      secondaryNode.angle,
      secondaryNode.deg,
      secondaryOp,
      secondaryNode.canMirror ? sign < 0 : false
    ),
    lightShiftX,
    isBackFacing: absYaw > 115,
    activeSector: primaryNode.angle,
  };
}

// ============================================================================
// MOBILE-SAFE LRU-2 RUNTIME CACHE FOR MULTI-ANGLE RIGGED CHARACTER PACKS
// ============================================================================

interface CachedAngleRig {
  dataUrl: string;
  pack: RiggedCharacterPack;
  lastUsed: number;
}

/**
 * Keeps 'front' permanently hot + at most 2 secondary angle rigs (LRU-2 eviction)
 * so 360° 2.5D rotation stays ultra-fast without blowing mobile Safari/Android canvas memory!
 */
export class MasterRigRuntimeCache {
  private cache = new Map<CharacterViewAngle, CachedAngleRig>();
  private loading = new Set<CharacterViewAngle>();
  private rigKey = '';
  private maxSecondary = 2;

  constructor(private rig: CharacterMasterRig) {
    this.rigKey = this.computeRigKey(rig);
  }

  private computeRigKey(rig: CharacterMasterRig): string {
    return `${rig.id}|${rig.creatureClass}|${rig.updatedAt}`;
  }

  public syncRig(rig: CharacterMasterRig): void {
    const nextKey = this.computeRigKey(rig);
    if (nextKey !== this.rigKey) {
      this.rig = rig;
      this.rigKey = nextKey;
      this.cache.clear();
      this.loading.clear();
    }
  }

  public getAvailableAngles(): CharacterViewAngle[] {
    return getAvailableRigAngles(this.rig);
  }

  public getPack(angle: CharacterViewAngle): RiggedCharacterPack | null {
    const slot = this.rig.views[angle];
    if (!slot?.dataUrl) return null;

    const existing = this.cache.get(angle);
    if (existing && existing.dataUrl === slot.dataUrl) {
      existing.lastUsed = performance.now();
      return existing.pack;
    }

    // Trigger asynchronous load + rig build if not already loading
    if (!this.loading.has(angle) && typeof Image !== 'undefined' && typeof document !== 'undefined') {
      this.loading.add(angle);
      const url = slot.dataUrl;
      const keySnap = this.rigKey;
      const img = new Image();
      img.onload = () => {
        this.loading.delete(angle);
        if (this.rigKey !== keySnap) return;
        const c = document.createElement('canvas');
        c.width = img.naturalWidth || slot.width || 512;
        c.height = img.naturalHeight || slot.height || 512;
        const ctx = c.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, c.width, c.height);
        const imgData = ctx.getImageData(0, 0, c.width, c.height);
        const anatomy = analyzeDrawingAnatomyFromPixels(imgData.data, c.width, c.height);
        const pack = buildRiggedCharacterPack(c, anatomy, {
          creatureClass: this.rig.creatureClass,
          meshOptions: {
            customSlitLines: this.rig.customSlitLines,
            jointOverrides: this.rig.jointOverrides,
          },
        });
        this.put(angle, url, pack);
      };
      img.onerror = () => {
        this.loading.delete(angle);
      };
      img.src = url;
    }

    return null;
  }

  public prewarmAngle(angle: CharacterViewAngle, pack: RiggedCharacterPack, dataUrl: string): void {
    this.put(angle, dataUrl, pack);
  }

  private put(angle: CharacterViewAngle, dataUrl: string, pack: RiggedCharacterPack): void {
    this.cache.set(angle, { dataUrl, pack, lastUsed: performance.now() });
    this.evictSecondaryIfNeeded();
  }

  private evictSecondaryIfNeeded(): void {
    const secondaries: Array<[CharacterViewAngle, CachedAngleRig]> = [];
    for (const [ang, entry] of this.cache.entries()) {
      if (ang !== 'front') secondaries.push([ang, entry]);
    }
    if (secondaries.length <= this.maxSecondary) return;
    secondaries.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    while (secondaries.length > this.maxSecondary) {
      const oldest = secondaries.shift();
      if (oldest) this.cache.delete(oldest[0]);
    }
  }

  public dispose(): void {
    this.cache.clear();
    this.loading.clear();
  }
}

export interface RenderMasterRigOptions {
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
  yawDeg: number;
}

/**
 * Renders any 1..4 angle CharacterMasterRig smoothly across full 360° (-180°..+180°):
 * - Single shared skeleton animation clock across Front / 3-4 / Side / Back
 * - Spherical 2.5D perspective foreshortening + fast cosine micro-crossfade across sector boundaries
 * - Dynamic Klaus 2.5D normal-map light-shift around the body
 * - Suppresses front facial mouth/eyes when viewing Back (180°)
 */
export function renderMasterRigCharacter(
  ctx: CanvasRenderingContext2D,
  cache: MasterRigRuntimeCache | null,
  fallbackFrontPack: RiggedCharacterPack,
  pose: ArticulatedCartoonPose,
  bounds: { x: number; y: number; w: number; h: number },
  opts: RenderMasterRigOptions
): { anchors: CharacterLiveAnchors; blend: Resolved25DViewBlend } {
  const available = cache ? cache.getAvailableAngles() : (['front'] as CharacterViewAngle[]);
  const blend = resolve25DViewBlend(opts.yawDeg, available);

  const drawLayer = (layer: ViewBlendLayer): CharacterLiveAnchors => {
    const pack = (cache ? cache.getPack(layer.angle) : null) ?? fallbackFrontPack;
    const facing: 1 | -1 = layer.mirrorX ? -1 : 1;
    const hideFrontFace = layer.angle === 'back';
    const layerPose: ArticulatedCartoonPose = {
      ...pose,
      facing,
      mouthOpen: hideFrontFace ? 0 : pose.mouthOpen,
      viseme: hideFrontFace ? 'closed' : pose.viseme,
    };

    const shiftedLight: KlausLightConfig | null | undefined = opts.klausLight
      ? {
          ...opts.klausLight,
          lx: Math.max(-1, Math.min(1, opts.klausLight.lx + blend.lightShiftX * 0.42)),
        }
      : opts.klausLight;

    const pivotX = bounds.x + bounds.w * 0.5;
    const pivotY = bounds.y + bounds.h;

    ctx.save();
    ctx.globalAlpha *= layer.opacity;
    ctx.translate(pivotX, pivotY);
    // Spherical 2.5D foreshortening + micro vertical turn parallax around grounded pivot
    ctx.transform(layer.squashX, layer.skewY, 0, 1, 0, 0);
    ctx.translate(-pivotX, -pivotY);
    const anchors = renderMultiLayerRiggedCharacter(ctx, pack, layerPose, bounds, {
      boilTick: opts.boilTick,
      nightLampPos: opts.nightLampPos,
      smearVelX: opts.smearVelX,
      isReflection: opts.isReflection,
      emotion: hideFrontFace ? 'neutral' : opts.emotion,
      eyeLeadX: opts.eyeLeadX,
      ikOverrides: opts.ikOverrides,
      klausLight: shiftedLight,
      forceCpuRaster: opts.forceCpuRaster,
      universalAction: opts.universalAction,
      yawDeg: blend.normalizedYawDeg,
    });
    ctx.restore();
    return anchors;
  };

  if (blend.secondary && blend.secondary.opacity > 0.02) {
    drawLayer(blend.secondary);
  }
  const anchors = drawLayer(blend.primary);
  return { anchors, blend };
}

