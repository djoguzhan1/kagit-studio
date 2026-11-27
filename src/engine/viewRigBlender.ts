import type { CharacterMasterRig, CharacterViewAngle, CustomMouthKey, ViewAnchors } from '../types/masterRig';
import { getAvailableRigAngles } from '../types/masterRig';
import type { FilmEmotionId } from '../types/film';
import type { RiggedCharacterPack, Vec2 } from './skeletonSkinEngine';
import { buildRiggedCharacterPackAsync } from './skeletonSkinEngine';
import {
  analyzeDrawingAnatomyFromPixels,
  drawCartoonMouth,
  renderMultiLayerRiggedCharacter,
  type ArticulatedCartoonPose,
  type CharacterLiveAnchors,
  type RiggedIKOverrides,
} from './cartoonMotionEngine';
import type { KlausLightConfig } from './cpuRasterizer';
import type { UniversalActionId } from './universalCreatureRig';

/**
 * INKTROPE V4 — 360° 2.5D Multi-View Rig Blender, Single-View Depth Parallax & Mobile LRU-2 Cache.
 *
 * - Single-view mode: cylindrical 2.5D depth-map perspective projection (`u' = c_u + (u - c_u)*cos(psi) + k_yaw * z(u,v) * sin(psi)`)
 *   so nose/chest/crown step forward while ears/back recede instead of flat 2D horizontal crushing!
 * - Multi-view mode: background Worker rig construction (`buildRiggedCharacterPackAsync`), 5-line anchor &
 *   21-bone spine registration across sector crossfades, and live `faceSprites.mouths` ink-harmonized lip-sync!
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
  let a = (((deg + 180) % 360) + 360) % 360 - 180;
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
 * Pure cylindrical 2.5D depth-relief UV projection for single-view yaw rotation:
 * Front-facing surface features (`zNorm > 0`: nose, chest, hat brim) translate forward with `sin(yaw)`
 * while lateral edges foreshorten smoothly (`>= 0.78`), avoiding flat cardboard horizontal scaling.
 */
export function projectSingleView25DDepthUV(
  u: number,
  v: number,
  depthNorm: number,
  yawDeg: number,
  centerU = 0.5
): { u: number; v: number } {
  const yaw = normalizeYawDeg(yawDeg);
  const psi = (yaw * Math.PI) / 180;
  const foreshorten = clamp(0.80 + 0.20 * Math.abs(Math.cos(psi)), 0.78, 1.0);
  const kYaw = 0.085;
  const z = clamp(depthNorm, -1, 1);
  return {
    u: centerU + (u - centerU) * foreshorten + kYaw * z * Math.sin(psi),
    v: v + (u - centerU) * Math.sin(psi) * 0.022,
  };
}

/**
 * Resolves exact 360° 2.5D multi-view blending for any combination of uploaded drawings!
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

  const makeLayer = (
    angle: CharacterViewAngle,
    canonicalAbsYaw: number,
    opacity: number,
    mirrorX: boolean
  ): ViewBlendLayer => {
    const deltaRad = ((absYaw - canonicalAbsYaw) * Math.PI) / 180;
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

  interface AngleNode {
    deg: number;
    angle: CharacterViewAngle;
    canMirror: boolean;
  }
  const nodes: AngleNode[] = [{ deg: 0, angle: fallbackFront, canMirror: false }];
  if (has34) nodes.push({ deg: 45, angle: 'threeQuarter', canMirror: true });
  if (hasSide) nodes.push({ deg: 90, angle: 'side', canMirror: true });
  if (hasBack) nodes.push({ deg: 180, angle: 'back', canMirror: false });

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

  let loIdx = 0;
  for (let i = 0; i < nodes.length - 1; i++) {
    if (absYaw >= nodes[i].deg) loIdx = i;
  }
  const loNode = nodes[loIdx];
  const hiNode = nodes[Math.min(nodes.length - 1, loIdx + 1)];

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
// CUSTOM MOUTH INK-STYLE HARMONIZER + WORKER-BACKED LRU-2 RUNTIME CACHE
// ============================================================================

function parseRgbString(rgb: string): [number, number, number] {
  const m = rgb.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (!m) return [28, 25, 23];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function harmonizeMouthSpriteToInk(
  img: HTMLImageElement,
  inkColor: string,
  autoInkStyle: boolean
): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(16, img.naturalWidth || 96);
  c.height = Math.max(16, img.naturalHeight || 96);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return c;
  ctx.drawImage(img, 0, 0, c.width, c.height);
  if (!autoInkStyle) return c;

  const [ir, ig, ib] = parseRgbString(inkColor);
  const im = ctx.getImageData(0, 0, c.width, c.height);
  const d = im.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 24) continue;
    const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    if (lum < 110) {
      const k = 0.72;
      d[i] = Math.round(d[i] * (1 - k) + ir * k);
      d[i + 1] = Math.round(d[i + 1] * (1 - k) + ig * k);
      d[i + 2] = Math.round(d[i + 2] * (1 - k) + ib * k);
    }
  }
  ctx.putImageData(im, 0, 0);
  return c;
}

interface CachedAngleRig {
  dataUrl: string;
  pack: RiggedCharacterPack;
  lastUsed: number;
}

export class MasterRigRuntimeCache {
  private cache = new Map<CharacterViewAngle, CachedAngleRig>();
  private loading = new Set<CharacterViewAngle>();
  private customMouths: Partial<Record<CustomMouthKey, CanvasImageSource>> = {};
  private customMouthSig = '';
  private rigKey = '';
  private maxSecondary = 2;

  constructor(private rig: CharacterMasterRig) {
    this.rigKey = this.computeRigKey(rig);
    this.syncCustomMouths(rig);
  }

  private computeRigKey(rig: CharacterMasterRig): string {
    const slits = rig.customSlitLines?.length ?? 0;
    const strokes = rig.weightStrokes?.length ?? 0;
    const joints = rig.jointOverrides ? Object.keys(rig.jointOverrides).length : 0;
    return `${rig.id}|${rig.creatureClass}|${rig.updatedAt}|s${slits}|w${strokes}|j${joints}`;
  }

  private computeMouthSig(rig: CharacterMasterRig): string {
    const m = rig.faceSprites?.mouths;
    if (!m) return '';
    return `${Boolean(rig.faceSprites?.autoInkStyle)}|${m.closed?.length ?? 0}|${m.A?.length ?? 0}|${m.E?.length ?? 0}|${m.O?.length ?? 0}`;
  }

  private syncCustomMouths(rig: CharacterMasterRig): void {
    const nextSig = this.computeMouthSig(rig);
    if (nextSig === this.customMouthSig) return;
    this.customMouthSig = nextSig;
    const mouths = rig.faceSprites?.mouths;
    if (!mouths || typeof Image === 'undefined' || typeof document === 'undefined') {
      this.customMouths = {};
      return;
    }
    const autoInk = rig.faceSprites?.autoInkStyle ?? true;
    const nextMap: Partial<Record<CustomMouthKey, CanvasImageSource>> = {};
    const keys: CustomMouthKey[] = ['closed', 'A', 'E', 'O'];
    for (const key of keys) {
      const url = mouths[key];
      if (!url) continue;
      const img = new Image();
      img.onload = () => {
        if (this.customMouthSig !== nextSig) return;
        const refInk = this.cache.get('front')?.pack.inkColor ?? '#1C1917';
        nextMap[key] = harmonizeMouthSpriteToInk(img, refInk, autoInk);
        this.customMouths = { ...nextMap };
        for (const entry of this.cache.values()) {
          entry.pack.customMouthBitmaps = this.customMouths;
        }
      };
      img.src = url;
    }
  }

  public syncRig(rig: CharacterMasterRig): void {
    this.rig = rig;
    this.syncCustomMouths(rig);
    const nextKey = this.computeRigKey(rig);
    if (nextKey !== this.rigKey) {
      this.rigKey = nextKey;
      this.cache.clear();
      this.loading.clear();
    }
  }

  public getAvailableAngles(): CharacterViewAngle[] {
    return getAvailableRigAngles(this.rig);
  }

  public getViewAnchors(angle: CharacterViewAngle): ViewAnchors | null {
    return this.rig.views[angle]?.anchors ?? null;
  }

  public getCustomMouths(): Partial<Record<CustomMouthKey, CanvasImageSource>> {
    return this.customMouths;
  }

  public getPack(angle: CharacterViewAngle): RiggedCharacterPack | null {
    const slot = this.rig.views[angle];
    if (!slot?.dataUrl) return null;

    const existing = this.cache.get(angle);
    if (existing && existing.dataUrl === slot.dataUrl) {
      existing.lastUsed = performance.now();
      existing.pack.customMouthBitmaps = this.customMouths;
      return existing.pack;
    }

    // Trigger non-blocking off-main-thread Worker rig construction (`buildRiggedCharacterPackAsync`)
    if (!this.loading.has(angle) && typeof Image !== 'undefined' && typeof document !== 'undefined') {
      this.loading.add(angle);
      const url = slot.dataUrl;
      const keySnap = this.rigKey;
      const rigSnap = this.rig;
      const img = new Image();
      img.onload = () => {
        if (this.rigKey !== keySnap) {
          this.loading.delete(angle);
          return;
        }
        const c = document.createElement('canvas');
        c.width = img.naturalWidth || slot.width || 512;
        c.height = img.naturalHeight || slot.height || 512;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        if (!ctx) {
          this.loading.delete(angle);
          return;
        }
        ctx.drawImage(img, 0, 0, c.width, c.height);
        const imgData = ctx.getImageData(0, 0, c.width, c.height);
        const anatomy = analyzeDrawingAnatomyFromPixels(imgData.data, c.width, c.height);
        void buildRiggedCharacterPackAsync(c, anatomy, {
          creatureClass: rigSnap.creatureClass,
          meshOptions: {
            customSlitLines: rigSnap.customSlitLines,
            jointOverrides: angle === 'front' ? rigSnap.jointOverrides : undefined,
            weightStrokes: angle === 'front' ? rigSnap.weightStrokes : undefined,
          },
          channelKey: `master-cache:${rigSnap.id}:${angle}`,
        })
          .then((pack) => {
            this.loading.delete(angle);
            if (this.rigKey !== keySnap) return;
            pack.customMouthBitmaps = this.customMouths;
            this.put(angle, url, pack);
          })
          .catch(() => {
            this.loading.delete(angle);
          });
      };
      img.onerror = () => {
        this.loading.delete(angle);
      };
      img.src = url;
    }

    return null;
  }

  public prewarmAngle(angle: CharacterViewAngle, pack: RiggedCharacterPack, dataUrl: string): void {
    pack.customMouthBitmaps = this.customMouths;
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
  timeSec?: number;
  nightLampPos?: Vec2 | null;
  smearVelX?: number;
  isReflection?: boolean;
  emotion?: FilmEmotionId;
  eyeLeadX?: number;
  ikOverrides?: RiggedIKOverrides | null;
  klausLight?: KlausLightConfig | null;
  forceCpuRaster?: boolean;
  universalAction?: UniversalActionId;
  customMouths?: Partial<Record<CustomMouthKey, CanvasImageSource>>;
  yawDeg: number;
}

/**
 * Renders any 1..4 angle CharacterMasterRig smoothly across full 360° (-180°..+180°):
 * - Single-view rigs use true 2.5D cylindrical depth-map parallax (head/chest/hat turn relief + viewYawRad foreshortening)
 *   rather than flat cardboard horizontal scaling.
 * - Multi-view rigs register 5-line sole/spine anchors across sector crossfades so both 21-bone posed views align to 0.0 px.
 * - Integrates artist-uploaded `faceSprites.mouths` live across all angles except Back (180°).
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
  const yawRad = (blend.normalizedYawDeg * Math.PI) / 180;
  const isSingleView25D = available.length <= 1;
  const primaryAnchorsRef = cache?.getViewAnchors(blend.primary.angle) ?? null;
  const effectiveCustomMouths =
    opts.customMouths ?? cache?.getCustomMouths() ?? fallbackFrontPack.customMouthBitmaps;

  const drawLayer = (layer: ViewBlendLayer, isSecondary: boolean): CharacterLiveAnchors => {
    const pack = (cache ? cache.getPack(layer.angle) : null) ?? fallbackFrontPack;
    const facing: 1 | -1 = layer.mirrorX ? -1 : 1;
    const hideFrontFace = layer.angle === 'back' || (isSingleView25D && blend.isBackFacing);

    // Drive true 2.5D cylindrical head/hat/chest parallax & front-corridor leg foreshortening!
    const syntheticHeadTurn = isSingleView25D
      ? clamp(pose.headTurnX + Math.sin(yawRad) * 0.92 * facing, -1, 1)
      : clamp(pose.headTurnX + (blend.lightShiftX * 0.28) * facing, -1, 1);

    const layerPose: ArticulatedCartoonPose = {
      ...pose,
      facing,
      headTurnX: syntheticHeadTurn,
      viewYawRad: yawRad,
      mouthOpen: hideFrontFace ? 0 : pose.mouthOpen,
      viseme: hideFrontFace ? 'closed' : pose.viseme,
    };

    const baseLight: KlausLightConfig = opts.klausLight ?? {
      lx: -0.34,
      ly: -0.58,
      rimR: 0.99,
      rimG: 0.96,
      rimB: 0.88,
      rimStrength: 0.24,
      shadowR: 0.16,
      shadowG: 0.14,
      shadowB: 0.18,
      shadowStrength: 0.18,
    };
    const shiftedLight: KlausLightConfig = {
      ...baseLight,
      lx: clamp(baseLight.lx + blend.lightShiftX * 0.55, -0.96, 0.96),
    };

    // Register secondary view's 5-line sole/center anchor strictly onto primary view during cross-morph!
    let regDx = 0;
    let regDy = 0;
    if (isSecondary && cache && primaryAnchorsRef) {
      const secAnchors = cache.getViewAnchors(layer.angle);
      if (secAnchors) {
        const secCenterU = layer.mirrorX ? 1 - secAnchors.centerU : secAnchors.centerU;
        const priCenterU = blend.primary.mirrorX ? 1 - primaryAnchorsRef.centerU : primaryAnchorsRef.centerU;
        regDx = (priCenterU - secCenterU) * bounds.w;
        regDy = (primaryAnchorsRef.soleV - secAnchors.soleV) * bounds.h;
      }
    }

    // In single-view 2.5D mode, avoid flat horizontal crush: combine mild cosine envelope (>=0.86)
    // with depth-relief nose/chest lead (`projectSingleView25DDepthUV`) + internal shader parallax!
    const effectiveSquashX = isSingleView25D
      ? clamp(0.86 + 0.14 * Math.abs(Math.cos(yawRad)), 0.86, 1.0)
      : layer.squashX;
    const depthReliefShiftPx = isSingleView25D
      ? (projectSingleView25DDepthUV(0.5, 0.5, 0.32, blend.normalizedYawDeg).u - 0.5) * bounds.w
      : 0;

    const pivotX = bounds.x + bounds.w * 0.5;
    const pivotY = bounds.y + bounds.h;
    const layerBounds = {
      x: bounds.x + regDx + depthReliefShiftPx,
      y: bounds.y + regDy,
      w: bounds.w,
      h: bounds.h,
    };

    ctx.save();
    ctx.globalAlpha *= layer.opacity;
    ctx.translate(pivotX, pivotY);
    ctx.transform(effectiveSquashX, layer.skewY, 0, 1, 0, 0);
    ctx.translate(-pivotX, -pivotY);
    const anchors = renderMultiLayerRiggedCharacter(ctx, pack, layerPose, layerBounds, {
      boilTick: opts.boilTick,
      timeSec: opts.timeSec,
      nightLampPos: opts.nightLampPos,
      smearVelX: opts.smearVelX,
      isReflection: opts.isReflection,
      emotion: hideFrontFace ? 'neutral' : opts.emotion,
      eyeLeadX: opts.eyeLeadX,
      ikOverrides: opts.ikOverrides,
      klausLight: shiftedLight,
      forceCpuRaster: opts.forceCpuRaster,
      universalAction: opts.universalAction,
      customMouths: effectiveCustomMouths,
      suppressCheekBlush: true,
      yawDeg: blend.normalizedYawDeg,
    });

    // Render artist-uploaded custom mouth sprites (or active speaking viseme) locked onto the head!
    const hasUploadedMouths = Boolean(
      effectiveCustomMouths &&
        (effectiveCustomMouths.closed ||
          effectiveCustomMouths.A ||
          effectiveCustomMouths.E ||
          effectiveCustomMouths.O)
    );
    if (
      !hideFrontFace &&
      !opts.isReflection &&
      (hasUploadedMouths || (layerPose.viseme !== 'closed' && layerPose.mouthOpen > 0.08))
    ) {
      const mScale = clamp(bounds.w / 245, 0.6, 1.6);
      const mRot = layerPose.headTiltRad + layerPose.torsoLeanRad * 0.42;
      drawCartoonMouth(
        ctx,
        anchors.mouthScreen.x,
        anchors.mouthScreen.y,
        mScale,
        layerPose.viseme,
        layerPose.mouthOpen,
        mRot,
        {
          maskUnderlayColor: pack.faceFillColor,
          hasDrawnMouth: pack.hasDrawnMouth,
          customMouths: effectiveCustomMouths,
        }
      );
    }

    ctx.restore();
    return anchors;
  };

  if (blend.secondary && blend.secondary.opacity > 0.02) {
    drawLayer(blend.secondary, true);
  }
  const anchors = drawLayer(blend.primary, false);
  return { anchors, blend };
}
