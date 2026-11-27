import type {
  AudioTrackData,
  EasingType,
  PartTransform,
  PuppetKeyframe,
  PuppetPart,
  PuppetRig,
} from '../types/studio';
import { canvasToPngBlob, getBlobBitmap, makeId, saveBlob } from './db';
import { localizePinOrPartLabel, type StudioLocale } from '../i18n/translations';
import { getVoiceEffectRate, rmsToMouthViseme, type MouthViseme } from './audioEngine';
import { drawCartoonMouth, type PrestonBlairViseme } from './cartoonMotionEngine';
import { getOrBuildCachedRigPack } from './characterIntakeEngine';
import type { LimbPartId } from './skeletonSkinEngine';

export const IDENTITY_TRANSFORM: PartTransform = {
  dx: 0,
  dy: 0,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
};

/**
 * Pure bone-hierarchy cycle detector: returns true if setting `childId.parentId = candidateParentId`
 * would form a self-loop or cycle (A -> B -> A or deeper A -> B -> C -> A).
 */
export function wouldCreateBoneCycle(
  parts: PuppetPart[],
  childId: string,
  candidateParentId: string | null
): boolean {
  if (!candidateParentId) return false;
  if (candidateParentId === childId) return true;
  const byId = new Map(parts.map((p) => [p.id, p]));
  const visited = new Set<string>([childId]);
  let cur: string | null = candidateParentId;
  while (cur) {
    if (visited.has(cur)) return true;
    visited.add(cur);
    cur = byId.get(cur)?.parentId ?? null;
  }
  return false;
}

export type RigPresetId = 'breathe' | 'bounce' | 'wave' | 'walk' | 'dance';

export interface WorldBoneGeometry {
  partId: string;
  pivotX: number;
  pivotY: number;
  parentPivotX: number | null;
  parentPivotY: number | null;
  rotHandleX: number;
  rotHandleY: number;
  scaleHandleX: number;
  scaleHandleY: number;
  centerX: number;
  centerY: number;
  radius: number;
  worldRotationRad: number;
}

export interface RenderPuppetFrameOptions {
  audio?: AudioTrackData | null;
  selectedPartId?: string | null;
  showSkeleton?: boolean;
  paperColor?: string;
  partBitmaps?: ReadonlyMap<string, CanvasImageSource>;
  customMouths?: Partial<Record<'closed' | 'A' | 'E' | 'O', CanvasImageSource>>;
}

export function applyEasing(t: number, easing: EasingType): number {
  const c = Math.max(0, Math.min(1, t));
  switch (easing) {
    case 'step':
      return c < 1 ? 0 : 1;
    case 'easeInOut':
      return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2;
    case 'bounce': {
      const n1 = 7.5625;
      const d1 = 2.75;
      if (c < 1 / d1) return n1 * c * c;
      if (c < 2 / d1) {
        const x = c - 1.5 / d1;
        return n1 * x * x + 0.75;
      }
      if (c < 2.5 / d1) {
        const x = c - 2.25 / d1;
        return n1 * x * x + 0.9375;
      }
      const x = c - 2.625 / d1;
      return n1 * x * x + 0.984375;
    }
    case 'elastic': {
      if (c === 0 || c === 1) return c;
      const c4 = (2 * Math.PI) / 3;
      return Math.pow(2, -10 * c) * Math.sin((c * 10 - 0.75) * c4) + 1;
    }
    case 'linear':
    default:
      return c;
  }
}

export function interpolateRigTransforms(
  rig: PuppetRig,
  frameIndex: number
): Record<string, PartTransform> {
  const sorted = [...rig.keyframes].sort((a, b) => a.frame - b.frame);
  if (sorted.length === 0) return {};
  if (frameIndex <= sorted[0].frame) return { ...sorted[0].transforms };
  if (frameIndex >= sorted[sorted.length - 1].frame) {
    return { ...sorted[sorted.length - 1].transforms };
  }

  let prev: PuppetKeyframe = sorted[0];
  let next: PuppetKeyframe = sorted[1];
  for (let i = 0; i < sorted.length - 1; i++) {
    if (frameIndex >= sorted[i].frame && frameIndex <= sorted[i + 1].frame) {
      prev = sorted[i];
      next = sorted[i + 1];
      break;
    }
  }

  const span = next.frame - prev.frame;
  const rawT = span > 0 ? (frameIndex - prev.frame) / span : 0;
  const eased = applyEasing(rawT, prev.easing);

  const out: Record<string, PartTransform> = {};
  for (const part of rig.parts) {
    const a = prev.transforms[part.id] ?? IDENTITY_TRANSFORM;
    const b = next.transforms[part.id] ?? IDENTITY_TRANSFORM;
    out[part.id] = {
      dx: a.dx + (b.dx - a.dx) * eased,
      dy: a.dy + (b.dy - a.dy) * eased,
      rotation: a.rotation + (b.rotation - a.rotation) * eased,
      scaleX: a.scaleX + (b.scaleX - a.scaleX) * eased,
      scaleY: a.scaleY + (b.scaleY - a.scaleY) * eased,
    };
  }
  return out;
}

/** 2D affine matrix [a, b, c, d, e, f] for pure world-space FK bone math */
type Mat2D = [number, number, number, number, number, number];

function mulMat(m1: Mat2D, m2: Mat2D): Mat2D {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

function applyMat(m: Mat2D, x: number, y: number): { x: number; y: number } {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

function buildLocalBoneMatrix(part: PuppetPart, tr: PartTransform): Mat2D {
  const px = part.x + part.pivotX;
  const py = part.y + part.pivotY;
  const rad = (tr.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const t1: Mat2D = [1, 0, 0, 1, px + tr.dx, py + tr.dy];
  const r: Mat2D = [cos, sin, -sin, cos, 0, 0];
  const s: Mat2D = [tr.scaleX, 0, 0, tr.scaleY, 0, 0];
  const t2: Mat2D = [1, 0, 0, 1, -px, -py];
  return mulMat(mulMat(mulMat(t1, r), s), t2);
}

/** Computes exact world-space canvas coordinates for every bone pivot, arrow & rotation gizmo handle */
export function computeRigWorldGeometry(
  rig: PuppetRig,
  frameIndex: number,
  canvasW: number,
  canvasH: number
): { joints: Map<string, WorldBoneGeometry>; fitScale: number } {
  const transforms = interpolateRigTransforms(rig, frameIndex);
  const partsById = new Map(rig.parts.map((p) => [p.id, p]));
  const fitScale = Math.min((canvasW * 0.86) / rig.sourceW, (canvasH * 0.86) / rig.sourceH);
  const offsetX = (canvasW - rig.sourceW * fitScale) / 2;
  const offsetY = (canvasH - rig.sourceH * fitScale) / 2;

  const baseMat: Mat2D = [fitScale, 0, 0, fitScale, offsetX, offsetY];
  const worldMats = new Map<string, Mat2D>();

  const getWorldMat = (part: PuppetPart, visited = new Set<string>()): Mat2D => {
    const cached = worldMats.get(part.id);
    if (cached) return cached;
    visited.add(part.id);
    const parent = part.parentId ? partsById.get(part.parentId) : undefined;
    const parentMat =
      parent && !visited.has(parent.id) ? getWorldMat(parent, visited) : baseMat;
    const localMat = buildLocalBoneMatrix(part, transforms[part.id] ?? IDENTITY_TRANSFORM);
    const m = mulMat(parentMat, localMat);
    worldMats.set(part.id, m);
    return m;
  };

  const joints = new Map<string, WorldBoneGeometry>();
  for (const part of rig.parts) {
    const m = getWorldMat(part);
    const piv = applyMat(m, part.x + part.pivotX, part.y + part.pivotY);
    const ctr = applyMat(m, part.x + part.w * 0.5, part.y + part.h * 0.5);
    const worldRot = Math.atan2(m[1], m[0]);

    const handleDist = Math.max(46, Math.min(82, Math.max(part.w, part.h) * fitScale * 0.55));
    const hx = piv.x + Math.sin(worldRot) * handleDist;
    const hy = piv.y - Math.cos(worldRot) * handleDist;

    const radius = Math.max(24, Math.hypot(part.w, part.h) * fitScale * 0.36);
    const sx = ctr.x + Math.cos(worldRot + Math.PI * 0.25) * radius;
    const sy = ctr.y + Math.sin(worldRot + Math.PI * 0.25) * radius;

    let parentPivotX: number | null = null;
    let parentPivotY: number | null = null;
    if (part.parentId && partsById.has(part.parentId)) {
      const parentPart = partsById.get(part.parentId)!;
      const pm = getWorldMat(parentPart);
      const pp = applyMat(pm, parentPart.x + parentPart.pivotX, parentPart.y + parentPart.pivotY);
      parentPivotX = pp.x;
      parentPivotY = pp.y;
    }

    joints.set(part.id, {
      partId: part.id,
      pivotX: piv.x,
      pivotY: piv.y,
      parentPivotX,
      parentPivotY,
      rotHandleX: hx,
      rotHandleY: hy,
      scaleHandleX: sx,
      scaleHandleY: sy,
      centerX: ctr.x,
      centerY: ctr.y,
      radius,
      worldRotationRad: worldRot,
    });
  }

  return { joints, fitScale };
}

function applyParentChain(
  ctx: CanvasRenderingContext2D,
  part: PuppetPart,
  partsById: Map<string, PuppetPart>,
  transforms: Record<string, PartTransform>,
  visited = new Set<string>()
): void {
  const chain: PuppetPart[] = [];
  let cur: PuppetPart | undefined = part;
  while (cur && !visited.has(cur.id)) {
    visited.add(cur.id);
    chain.unshift(cur);
    cur = cur.parentId ? partsById.get(cur.parentId) : undefined;
  }

  for (const node of chain) {
    const tr = transforms[node.id] ?? IDENTITY_TRANSFORM;
    const px = node.x + node.pivotX;
    const py = node.y + node.pivotY;
    ctx.translate(px + tr.dx, py + tr.dy);
    ctx.rotate((tr.rotation * Math.PI) / 180);
    ctx.scale(tr.scaleX, tr.scaleY);
    ctx.translate(-px, -py);
  }
}

function mapMouthVisemeToPrestonBlair(v: MouthViseme): PrestonBlairViseme {
  if (v === 'closed') return 'closed';
  if (v === 'half') return 'EE';
  if (v === 'round') return 'OO';
  return 'AA';
}

function mapPrestonBlairToMouthSlot(v: PrestonBlairViseme): MouthViseme {
  if (v === 'closed') return 'closed';
  if (v === 'EE' || v === 'FV') return 'half';
  if (v === 'OH' || v === 'OO') return 'round';
  return 'wide';
}

function drawPuppetFrameCore(
  ctx: CanvasRenderingContext2D,
  rig: PuppetRig,
  frameIndex: number,
  canvasW: number,
  canvasH: number,
  partBitmaps: ReadonlyMap<string, CanvasImageSource>,
  options?: RenderPuppetFrameOptions
): void {
  if (options?.paperColor) {
    ctx.fillStyle = options.paperColor;
    ctx.fillRect(0, 0, canvasW, canvasH);
  } else {
    ctx.clearRect(0, 0, canvasW, canvasH);
  }

  const transforms = interpolateRigTransforms(rig, frameIndex);
  const partsById = new Map(rig.parts.map((p) => [p.id, p]));
  const fitScale = Math.min((canvasW * 0.86) / rig.sourceW, (canvasH * 0.86) / rig.sourceH);
  const offsetX = (canvasW - rig.sourceW * fitScale) / 2;
  const offsetY = (canvasH - rig.sourceH * fitScale) / 2;

  const activeAudio = options?.audio && !options.audio.muted ? options.audio : null;
  const fxRate = getVoiceEffectRate(activeAudio?.voiceEffect);
  const audioIdx =
    activeAudio && activeAudio.rmsPerFrame.length > 0
      ? Math.floor(frameIndex * fxRate) % activeAudio.rmsPerFrame.length
      : 0;
  const prevAudioIdx =
    activeAudio && activeAudio.rmsPerFrame.length > 0
      ? Math.max(0, (Math.floor(frameIndex * fxRate) - 1 + activeAudio.rmsPerFrame.length) % activeAudio.rmsPerFrame.length)
      : 0;
  const rms =
    activeAudio && activeAudio.rmsPerFrame.length > 0
      ? activeAudio.rmsPerFrame[audioIdx]
      : null;
  const prevRms =
    activeAudio && activeAudio.rmsPerFrame.length > 0
      ? activeAudio.rmsPerFrame[prevAudioIdx]
      : 0;

  const formantViseme: PrestonBlairViseme | null =
    activeAudio && activeAudio.visemesPerFrame && activeAudio.visemesPerFrame.length > 0
      ? activeAudio.visemesPerFrame[audioIdx % activeAudio.visemesPerFrame.length]
      : rms !== null
        ? mapMouthVisemeToPrestonBlair(rmsToMouthViseme(rms, prevRms))
        : null;

  const activeSlotViseme: MouthViseme | null = formantViseme
    ? mapPrestonBlairToMouthSlot(formantViseme)
    : rms !== null
      ? rmsToMouthViseme(rms, prevRms)
      : null;

  const hasMouthSlots = rig.parts.some((p) => Boolean(p.mouthSlot));
  const headPart =
    rig.parts.find((p) => /baş|kafa|head/i.test(p.name)) ??
    (rig.parts.length === 1 ? rig.parts[0] : null);

  const sorted = [...rig.parts].sort((a, b) => a.zIndex - b.zIndex);

  for (const part of sorted) {
    if (hasMouthSlots && part.mouthSlot && activeSlotViseme) {
      if (part.mouthSlot !== activeSlotViseme) continue;
    }

    const bmp = partBitmaps.get(part.blobKey);
    if (!bmp) continue;

    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(fitScale, fitScale);
    applyParentChain(ctx, part, partsById, transforms);

    // Capsule ball-joint weld on large child limb rotations (zero white seam wedges)
    const ownTr = transforms[part.id] ?? IDENTITY_TRANSFORM;
    if (part.parentId && Math.abs(ownTr.rotation) > 12) {
      const sockR = Math.max(6, Math.min(part.w, part.h) * 0.32);
      ctx.save();
      ctx.beginPath();
      ctx.arc(part.x + part.pivotX, part.y + part.pivotY, sockR, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(bmp, part.x - 1, part.y - 1, part.w + 2, part.h + 2);
      ctx.restore();
    }

    ctx.drawImage(bmp, part.x, part.y, part.w, part.h);

    // Clean lower-face viseme lip-sync (replaces vertical head stretching!)
    if (!hasMouthSlots && headPart && part.id === headPart.id && (formantViseme || options?.customMouths?.closed)) {
      const mouthVis = formantViseme ?? 'closed';
      const mouthOpen = rms !== null ? Math.min(1, rms * 1.25) : 0;
      if (mouthVis !== 'closed' || options?.customMouths?.closed) {
        const mx = part.x + part.w * 0.5;
        const my = part.y + (rig.parts.length === 1 ? part.h * 0.24 : part.h * 0.72);
        const mScale = Math.max(0.55, Math.min(1.45, part.w / 145));
        drawCartoonMouth(ctx, mx, my, mScale, mouthVis, mouthVis === 'closed' ? 0 : Math.max(0.35, mouthOpen), 0, {
          customMouths: options?.customMouths,
        });
      }
    }

    ctx.restore();
  }

  // Draw Architectural Bone Hierarchy Arrows & Interactive On-Canvas Gizmo
  if (options?.showSkeleton && rig.parts.length > 0) {
    const { joints } = computeRigWorldGeometry(rig, frameIndex, canvasW, canvasH);

    for (const j of joints.values()) {
      if (j.parentPivotX !== null && j.parentPivotY !== null) {
        const dx = j.pivotX - j.parentPivotX;
        const dy = j.pivotY - j.parentPivotY;
        const len = Math.hypot(dx, dy);
        if (len > 4) {
          const nx = -dy / len;
          const ny = dx / len;
          ctx.save();
          ctx.fillStyle = 'rgba(217, 155, 38, 0.28)';
          ctx.strokeStyle = 'rgba(217, 155, 38, 0.85)';
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.moveTo(j.parentPivotX + nx * 6, j.parentPivotY + ny * 6);
          ctx.lineTo(j.pivotX, j.pivotY);
          ctx.lineTo(j.parentPivotX - nx * 6, j.parentPivotY - ny * 6);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          ctx.restore();
        }
      }
    }

    for (const j of joints.values()) {
      const isSelected = j.partId === options.selectedPartId;
      ctx.save();

      if (isSelected) {
        ctx.strokeStyle = 'rgba(229, 77, 46, 0.65)';
        ctx.lineWidth = 1.8;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.arc(j.centerX, j.centerY, j.radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.strokeStyle = '#E54D2E';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(j.pivotX, j.pivotY);
        ctx.lineTo(j.rotHandleX, j.rotHandleY);
        ctx.stroke();

        ctx.fillStyle = '#D99B26';
        ctx.beginPath();
        ctx.arc(j.rotHandleX, j.rotHandleY, 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 2.5;
        ctx.stroke();

        ctx.save();
        ctx.translate(j.scaleHandleX, j.scaleHandleY);
        ctx.rotate(j.worldRotationRad + Math.PI * 0.25);
        ctx.fillStyle = '#16A34A';
        ctx.fillRect(-7, -7, 14, 14);
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 2.2;
        ctx.strokeRect(-7, -7, 14, 14);
        ctx.restore();
      }

      ctx.fillStyle = isSelected ? '#E54D2E' : '#2563EB';
      ctx.beginPath();
      ctx.arc(j.pivotX, j.pivotY, isSelected ? 8 : 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 2.2;
      ctx.stroke();
      ctx.restore();
    }
  }
}

/**
 * Synchronous zero-blocking cutout renderer for 60 FPS requestAnimationFrame playback
 * when part bitmaps are pre-cached in memory.
 */
export function renderPuppetFrameSync(
  ctx: CanvasRenderingContext2D,
  rig: PuppetRig,
  frameIndex: number,
  canvasW: number,
  canvasH: number,
  partBitmaps: ReadonlyMap<string, CanvasImageSource>,
  options?: RenderPuppetFrameOptions
): boolean {
  for (const part of rig.parts) {
    if (!partBitmaps.has(part.blobKey)) return false;
  }
  drawPuppetFrameCore(ctx, rig, frameIndex, canvasW, canvasH, partBitmaps, options);
  return true;
}

export async function renderPuppetFrame(
  ctx: CanvasRenderingContext2D,
  rig: PuppetRig,
  frameIndex: number,
  canvasW: number,
  canvasH: number,
  options?: RenderPuppetFrameOptions
): Promise<void> {
  if (options?.partBitmaps && renderPuppetFrameSync(ctx, rig, frameIndex, canvasW, canvasH, options.partBitmaps, options)) {
    return;
  }
  const loaded = new Map<string, CanvasImageSource>();
  for (const part of rig.parts) {
    const cached = options?.partBitmaps?.get(part.blobKey);
    if (cached) {
      loaded.set(part.blobKey, cached);
    } else {
      const bmp = await getBlobBitmap(part.blobKey);
      if (bmp) loaded.set(part.blobKey, bmp);
    }
  }
  drawPuppetFrameCore(ctx, rig, frameIndex, canvasW, canvasH, loaded, options);
}

/** 1-Click Editable Physical Motion Presets honoring the real bone hierarchy */
export function generateMotionPresetKeyframes(
  rig: PuppetRig,
  preset: RigPresetId
): PuppetKeyframe[] {
  const N = Math.max(8, rig.totalFrames);
  const q1 = Math.round(N * 0.25);
  const q2 = Math.round(N * 0.5);
  const q3 = Math.round(N * 0.75);
  const end = N - 1;

  const base = (): Record<string, PartTransform> => {
    const m: Record<string, PartTransform> = {};
    for (const p of rig.parts) m[p.id] = { ...IDENTITY_TRANSFORM };
    return m;
  };

  const root = rig.parts.find((p) => p.parentId === null) ?? rig.parts[0];
  const head = rig.parts.find((p) => /baş|kafa|head/i.test(p.name));
  const armR = rig.parts.find((p) => /sağ kol|kol sağ|right arm|kol/i.test(p.name));
  const armL = rig.parts.find((p) => /sol kol|kol sol|left arm/i.test(p.name));
  const legL = rig.parts.find((p) => /sol bacak|bacak sol|left leg/i.test(p.name));
  const legR = rig.parts.find((p) => /sağ bacak|bacak sağ|right leg/i.test(p.name));

  if (preset === 'breathe') {
    const inhale = base();
    if (root) inhale[root.id] = { dx: 0, dy: -6, rotation: 0, scaleX: 1.03, scaleY: 1.05 };
    if (head) inhale[head.id] = { dx: 0, dy: -2, rotation: -3, scaleX: 1, scaleY: 1 };
    if (armR && armR.id !== root?.id) inhale[armR.id] = { dx: 0, dy: 0, rotation: -6, scaleX: 1, scaleY: 1 };
    if (armL && armL.id !== root?.id) inhale[armL.id] = { dx: 0, dy: 0, rotation: 6, scaleX: 1, scaleY: 1 };

    return [
      { id: makeId('kf'), frame: 0, easing: 'easeInOut', transforms: base() },
      { id: makeId('kf'), frame: q2, easing: 'easeInOut', transforms: inhale },
      { id: makeId('kf'), frame: end, easing: 'easeInOut', transforms: base() },
    ];
  }

  if (preset === 'bounce') {
    const squash = base();
    const peak = base();
    if (root) {
      squash[root.id] = { dx: 0, dy: 20, rotation: 0, scaleX: 1.12, scaleY: 0.88 };
      peak[root.id] = { dx: 0, dy: -60, rotation: 3, scaleX: 0.94, scaleY: 1.08 };
    }
    if (head && head.id !== root?.id) {
      squash[head.id] = { dx: 0, dy: 4, rotation: 3, scaleX: 1, scaleY: 1 };
      peak[head.id] = { dx: 0, dy: -2, rotation: -6, scaleX: 1, scaleY: 1 };
    }
    return [
      { id: makeId('kf'), frame: 0, easing: 'easeInOut', transforms: base() },
      { id: makeId('kf'), frame: q1, easing: 'easeInOut', transforms: squash },
      { id: makeId('kf'), frame: q2, easing: 'bounce', transforms: peak },
      { id: makeId('kf'), frame: q3, easing: 'easeInOut', transforms: squash },
      { id: makeId('kf'), frame: end, easing: 'easeInOut', transforms: base() },
    ];
  }

  if (preset === 'wave') {
    const targetArm = armR ?? head ?? root;
    const up = base();
    const down = base();
    if (root && root.id !== targetArm?.id) {
      up[root.id] = { dx: -8, dy: -3, rotation: -3, scaleX: 0.99, scaleY: 1.02 };
      down[root.id] = { dx: -5, dy: 2, rotation: -1, scaleX: 1.01, scaleY: 0.99 };
    }
    if (targetArm) {
      up[targetArm.id] = { dx: 0, dy: 0, rotation: -46, scaleX: 1, scaleY: 1 };
      down[targetArm.id] = { dx: 0, dy: 0, rotation: 16, scaleX: 1, scaleY: 1 };
    }
    if (armL && armL.id !== targetArm?.id && armL.id !== root?.id) {
      up[armL.id] = { dx: 0, dy: 0, rotation: 10, scaleX: 1, scaleY: 1 };
      down[armL.id] = { dx: 0, dy: 0, rotation: 4, scaleX: 1, scaleY: 1 };
    }
    if (head && head.id !== targetArm?.id) {
      up[head.id] = { dx: 0, dy: 0, rotation: 8, scaleX: 1, scaleY: 1 };
      down[head.id] = { dx: 0, dy: 0, rotation: -6, scaleX: 1, scaleY: 1 };
    }
    return [
      { id: makeId('kf'), frame: 0, easing: 'easeInOut', transforms: base() },
      { id: makeId('kf'), frame: q1, easing: 'easeInOut', transforms: up },
      { id: makeId('kf'), frame: q2, easing: 'easeInOut', transforms: down },
      { id: makeId('kf'), frame: q3, easing: 'easeInOut', transforms: up },
      { id: makeId('kf'), frame: end, easing: 'easeInOut', transforms: base() },
    ];
  }

  if (preset === 'dance') {
    const grooveL = base();
    const dipMid = base();
    const grooveR = base();
    if (root) {
      grooveL[root.id] = { dx: -18, dy: -8, rotation: -6, scaleX: 0.97, scaleY: 1.04 };
      dipMid[root.id] = { dx: 0, dy: 14, rotation: 0, scaleX: 1.07, scaleY: 0.93 };
      grooveR[root.id] = { dx: 18, dy: -8, rotation: 6, scaleX: 0.97, scaleY: 1.04 };
    }
    if (head && head.id !== root?.id) {
      grooveL[head.id] = { dx: 0, dy: -2, rotation: 9, scaleX: 1, scaleY: 1 };
      dipMid[head.id] = { dx: 0, dy: 3, rotation: 0, scaleX: 1, scaleY: 1 };
      grooveR[head.id] = { dx: 0, dy: -2, rotation: -9, scaleX: 1, scaleY: 1 };
    }
    if (armL && armL.id !== root?.id) {
      grooveL[armL.id] = { dx: 0, dy: 0, rotation: 42, scaleX: 1, scaleY: 1 };
      dipMid[armL.id] = { dx: 0, dy: 0, rotation: 14, scaleX: 1, scaleY: 1 };
      grooveR[armL.id] = { dx: 0, dy: 0, rotation: -24, scaleX: 1, scaleY: 1 };
    }
    if (armR && armR.id !== root?.id) {
      grooveL[armR.id] = { dx: 0, dy: 0, rotation: 24, scaleX: 1, scaleY: 1 };
      dipMid[armR.id] = { dx: 0, dy: 0, rotation: -14, scaleX: 1, scaleY: 1 };
      grooveR[armR.id] = { dx: 0, dy: 0, rotation: -42, scaleX: 1, scaleY: 1 };
    }
    if (legL && legL.id !== root?.id) {
      grooveL[legL.id] = { dx: 0, dy: -6, rotation: 12, scaleX: 1, scaleY: 1 };
      grooveR[legL.id] = { dx: 0, dy: 0, rotation: -8, scaleX: 1, scaleY: 1 };
    }
    if (legR && legR.id !== root?.id) {
      grooveL[legR.id] = { dx: 0, dy: 0, rotation: 8, scaleX: 1, scaleY: 1 };
      grooveR[legR.id] = { dx: 0, dy: -6, rotation: -12, scaleX: 1, scaleY: 1 };
    }
    return [
      { id: makeId('kf'), frame: 0, easing: 'easeInOut', transforms: dipMid },
      { id: makeId('kf'), frame: q1, easing: 'easeInOut', transforms: grooveL },
      { id: makeId('kf'), frame: q2, easing: 'easeInOut', transforms: dipMid },
      { id: makeId('kf'), frame: q3, easing: 'easeInOut', transforms: grooveR },
      { id: makeId('kf'), frame: end, easing: 'easeInOut', transforms: dipMid },
    ];
  }

  // Genuine 8-Beat Richard Williams Walk Cycle with Horizontal Weight Sway & Stride Translation!
  const makeWalkPose = (
    hipDx: number,
    hipDy: number,
    hipRot: number,
    sqY: number,
    legLAng: number,
    legRAng: number,
    legLDx: number,
    legRDx: number,
    legLDy: number,
    legRDy: number,
    armLAng: number,
    armRAng: number,
    headRot: number
  ) => {
    const tr = base();
    if (root) {
      tr[root.id] = {
        dx: hipDx,
        dy: hipDy,
        rotation: hipRot,
        scaleX: Number((1 / sqY).toFixed(3)),
        scaleY: sqY,
      };
    }
    if (head && head.id !== root?.id) {
      tr[head.id] = {
        dx: Math.round(-hipDx * 0.25),
        dy: Math.round(hipDy * 0.15),
        rotation: headRot,
        scaleX: 1,
        scaleY: 1,
      };
    }
    if (legL && legL.id !== root?.id) tr[legL.id] = { dx: legLDx, dy: legLDy, rotation: legLAng, scaleX: 1, scaleY: 1 };
    if (legR && legR.id !== root?.id) tr[legR.id] = { dx: legRDx, dy: legRDy, rotation: legRAng, scaleX: 1, scaleY: 1 };
    if (armL && armL.id !== root?.id) {
      tr[armL.id] = { dx: Math.round(-armLAng * 0.12), dy: 0, rotation: armLAng, scaleX: 1, scaleY: 1 };
    }
    if (armR && armR.id !== root?.id) {
      tr[armR.id] = { dx: Math.round(-armRAng * 0.12), dy: 0, rotation: armRAng, scaleX: 1, scaleY: 1 };
    }
    return tr;
  };

  const contactA = makeWalkPose(4, 0, 3, 1.0, 26, -24, -6, 6, 0, 0, -22, 22, -2);
  const downA = makeWalkPose(7, 8, 4, 0.94, 18, -14, -4, 4, 0, -4, -18, 18, 4);
  const passingA = makeWalkPose(3, -4, 1, 1.02, -4, 6, 1, -2, 0, -14, 4, -4, 2);
  const upA = makeWalkPose(-2, -10, -2, 1.04, -18, 22, 5, -5, 0, -6, 18, -18, -3);
  const contactB = makeWalkPose(-4, 0, -3, 1.0, -24, 26, 6, -6, 0, 0, 22, -22, 2);
  const downB = makeWalkPose(-7, 8, -4, 0.94, -14, 18, 4, -4, -4, 0, 18, -18, -4);
  const passingB = makeWalkPose(-3, -4, -1, 1.02, 6, -4, -2, 1, -14, 0, -4, 4, -2);
  const upB = makeWalkPose(2, -10, 2, 1.04, 22, -18, -5, 5, -6, 0, -18, 18, 3);

  const f = (u: number) => Math.max(0, Math.min(end, Math.round(u * end)));
  return [
    { id: makeId('kf'), frame: 0, easing: 'easeInOut', transforms: contactA },
    { id: makeId('kf'), frame: f(0.125), easing: 'easeInOut', transforms: downA },
    { id: makeId('kf'), frame: f(0.25), easing: 'easeInOut', transforms: passingA },
    { id: makeId('kf'), frame: f(0.375), easing: 'easeInOut', transforms: upA },
    { id: makeId('kf'), frame: f(0.5), easing: 'easeInOut', transforms: contactB },
    { id: makeId('kf'), frame: f(0.625), easing: 'easeInOut', transforms: downB },
    { id: makeId('kf'), frame: f(0.75), easing: 'easeInOut', transforms: passingB },
    { id: makeId('kf'), frame: f(0.875), easing: 'easeInOut', transforms: upB },
    { id: makeId('kf'), frame: end, easing: 'easeInOut', transforms: contactA },
  ];
}

export function extractLassoCutout(
  sourceCanvas: HTMLCanvasElement,
  polygon: { x: number; y: number }[]
): { canvas: HTMLCanvasElement; x: number; y: number; w: number; h: number } | null {
  if (polygon.length < 3) return null;
  let minX = sourceCanvas.width;
  let minY = sourceCanvas.height;
  let maxX = 0;
  let maxY = 0;
  for (const pt of polygon) {
    if (pt.x < minX) minX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y > maxY) maxY = pt.y;
  }
  const pad = 4;
  const x = Math.max(0, Math.floor(minX - pad));
  const y = Math.max(0, Math.floor(minY - pad));
  const w = Math.min(sourceCanvas.width - x, Math.ceil(maxX - x + pad * 2));
  const h = Math.min(sourceCanvas.height - y, Math.ceil(maxY - y + pad * 2));
  if (w < 8 || h < 8) return null;

  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d')!;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(polygon[0].x - x, polygon[0].y - y);
  for (let i = 1; i < polygon.length; i++) {
    ctx.lineTo(polygon[i].x - x, polygon[i].y - y);
  }
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(sourceCanvas, x, y, w, h, 0, 0, w, h);
  ctx.restore();

  return { canvas: out, x, y, w, h };
}

function sampleLocalBodyFillStyle(
  filledCanvas: HTMLCanvasElement,
  cx: number,
  cy: number,
  fallback: string
): string {
  const ctx = filledCanvas.getContext('2d');
  if (!ctx) return fallback;
  const sw = filledCanvas.width;
  const sh = filledCanvas.height;
  const rx = Math.max(0, Math.min(sw - 1, Math.round(cx)));
  const ry = Math.max(0, Math.min(sh - 1, Math.round(cy)));
  const x0 = Math.max(0, rx - 8);
  const y0 = Math.max(0, ry - 8);
  const bw = Math.min(sw - x0, 17);
  const bh = Math.min(sh - y0, 17);
  const data = ctx.getImageData(x0, y0, bw, bh).data;
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let cnt = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 200) continue;
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    if (lum < 45) continue; // skip pure ink border pixels
    sr += data[i];
    sg += data[i + 1];
    sb += data[i + 2];
    cnt++;
  }
  if (cnt === 0) {
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 180) continue;
      sr += data[i];
      sg += data[i + 1];
      sb += data[i + 2];
      cnt++;
    }
  }
  if (cnt === 0) return fallback;
  return `rgb(${Math.round(sr / cnt)}, ${Math.round(sg / cnt)}, ${Math.round(sb / cnt)})`;
}

/**
 * 1-Click Geodesic Auto-Splitter for Parçalı Kukla (Cutout Puppet Mode):
 * Segments a character canvas into Torso (root) + Head + L/R Arms + L/R Legs with
 * circular ball-joint capsule overlap (`r_joint = 0.55 * limbWidth`) + inpainted torso sockets
 * (`0 px` shoulder/crotch wedge gaps under ±35° rotation!).
 */
export async function autoSplitCanvasToPuppetParts(
  sourceCanvas: HTMLCanvasElement,
  locale: StudioLocale = 'tr'
): Promise<PuppetPart[]> {
  const sw = sourceCanvas.width;
  const sh = sourceCanvas.height;
  if (sw < 16 || sh < 16) return [];

  const pack = getOrBuildCachedRigPack(sourceCanvas);
  const rootId = makeId('prt');

  const specs: {
    id: LimbPartId;
    nameTr: string;
    nameEn: string;
    zIndex: number;
    isRoot: boolean;
  }[] = [
    { id: 'torso', nameTr: 'Gövde', nameEn: 'Torso', zIndex: 3, isRoot: true },
    { id: 'leg_l', nameTr: 'Sol Bacak', nameEn: 'Left Leg', zIndex: 1, isRoot: false },
    { id: 'leg_r', nameTr: 'Sağ Bacak', nameEn: 'Right Leg', zIndex: 2, isRoot: false },
    { id: 'arm_l', nameTr: 'Sol Kol', nameEn: 'Left Arm', zIndex: 4, isRoot: false },
    { id: 'head', nameTr: 'Baş', nameEn: 'Head', zIndex: 5, isRoot: false },
    { id: 'arm_r', nameTr: 'Sağ Kol', nameEn: 'Right Arm', zIndex: 6, isRoot: false },
  ];

  const distinctLimbCount = (['head', 'arm_l', 'arm_r', 'leg_l', 'leg_r'] as LimbPartId[]).filter(
    (id) => (pack.parts[id]?.pixelCount ?? 0) >= 24
  ).length;
  if (!pack.useMultiPart && distinctLimbCount < 2) {
    const blobKey = await saveBlob(await canvasToPngBlob(pack.filledCanvas));
    return [
      {
        id: rootId,
        name: localizePinOrPartLabel('Gövde', locale),
        parentId: null,
        blobKey,
        x: 0,
        y: 0,
        w: sw,
        h: sh,
        pivotX: Math.round(pack.anatomy.centerX * sw),
        pivotY: Math.round(pack.anatomy.hipV * sh),
        zIndex: 1,
        mouthSlot: null,
      },
    ];
  }

  // Optional pre-inpainted socket layer from conformingMeshEngine (`inpaintSocketRegion`)
  let socketCanvas: HTMLCanvasElement | null = null;
  const socketRgba = pack.skinnedMesh?.inpaintedSocketOnlyRgba;
  if (socketRgba && socketRgba.length === sw * sh * 4) {
    socketCanvas = document.createElement('canvas');
    socketCanvas.width = sw;
    socketCanvas.height = sh;
    socketCanvas.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(socketRgba), sw, sh), 0, 0);
  }

  // Precompute per-part circular ball-joint capsule radius (`r_joint = 0.55 * limbWidth`)
  const jointCapsuleByPart = new Map<LimbPartId, { pivX: number; pivY: number; rJoint: number }>();
  for (const sp of specs) {
    const seg = pack.parts[sp.id];
    if (!seg || seg.pixelCount < 6) continue;
    const rawW = Math.max(8, (seg.u1 - seg.u0) * sw);
    const rawH = Math.max(8, (seg.v1 - seg.v0) * sh);
    const limbWidth =
      sp.id === 'head'
        ? Math.max(14, rawW * 0.34)
        : sp.id === 'torso'
          ? Math.max(14, rawW * 0.3)
          : Math.max(12, Math.min(rawW, rawH));
    const rJoint = Math.max(8, Math.min(Math.round(Math.min(sw, sh) * 0.075), Math.round(0.55 * limbWidth)));
    jointCapsuleByPart.set(sp.id, {
      pivX: seg.root.x * sw,
      pivY: seg.root.y * sh,
      rJoint,
    });
  }

  const parts: PuppetPart[] = [];
  for (const sp of specs) {
    const seg = pack.parts[sp.id];
    if (!seg || seg.pixelCount < 6) continue;
    const cap = jointCapsuleByPart.get(sp.id)!;
    const pad = 6;

    let minPxX = Math.floor(seg.u0 * sw) - pad;
    let minPxY = Math.floor(seg.v0 * sh) - pad;
    let maxPxX = Math.ceil(seg.u1 * sw) + pad;
    let maxPxY = Math.ceil(seg.v1 * sh) + pad;

    // Expand bbox around own capsule ball-joint
    minPxX = Math.min(minPxX, Math.floor(cap.pivX - cap.rJoint - 2));
    minPxY = Math.min(minPxY, Math.floor(cap.pivY - cap.rJoint - 2));
    maxPxX = Math.max(maxPxX, Math.ceil(cap.pivX + cap.rJoint + 2));
    maxPxY = Math.max(maxPxY, Math.ceil(cap.pivY + cap.rJoint + 2));

    // For torso root, also encompass every child limb's socket capsule so inpainted sockets never clip!
    if (sp.isRoot) {
      for (const [childId, cCap] of jointCapsuleByPart.entries()) {
        if (childId === 'torso') continue;
        minPxX = Math.min(minPxX, Math.floor(cCap.pivX - cCap.rJoint - 2));
        minPxY = Math.min(minPxY, Math.floor(cCap.pivY - cCap.rJoint - 2));
        maxPxX = Math.max(maxPxX, Math.ceil(cCap.pivX + cCap.rJoint + 2));
        maxPxY = Math.max(maxPxY, Math.ceil(cCap.pivY + cCap.rJoint + 2));
      }
    }

    const x0 = Math.max(0, minPxX);
    const y0 = Math.max(0, minPxY);
    const x1 = Math.min(sw, maxPxX);
    const y1 = Math.min(sh, maxPxY);
    const pw = Math.max(8, x1 - x0);
    const ph = Math.max(8, y1 - y0);

    const pc = document.createElement('canvas');
    pc.width = pw;
    pc.height = ph;
    const pctx = pc.getContext('2d')!;

    if (sp.isRoot) {
      // 1) Inpaint circular ball sockets behind every child limb pivot (shoulders, hips, neck)
      for (const childId of ['leg_l', 'leg_r', 'arm_l', 'arm_r', 'head'] as LimbPartId[]) {
        const cCap = jointCapsuleByPart.get(childId);
        if (!cCap) continue;
        const sampleY =
          childId === 'leg_l' || childId === 'leg_r'
            ? Math.max(0, cCap.pivY - cCap.rJoint * 0.45)
            : childId === 'head'
              ? Math.min(sh - 1, cCap.pivY + cCap.rJoint * 0.45)
              : cCap.pivY;
        const sampleX =
          childId === 'arm_l'
            ? Math.min(sw - 1, cCap.pivX + cCap.rJoint * 0.45)
            : childId === 'arm_r'
              ? Math.max(0, cCap.pivX - cCap.rJoint * 0.45)
              : cCap.pivX;
        const fillStyle = sampleLocalBodyFillStyle(pack.filledCanvas, sampleX, sampleY, pack.faceFillColor);

        pctx.save();
        pctx.beginPath();
        pctx.arc(cCap.pivX - x0, cCap.pivY - y0, cCap.rJoint * 0.92, 0, Math.PI * 2);
        pctx.clip();
        pctx.fillStyle = fillStyle;
        pctx.fillRect(0, 0, pw, ph);
        pctx.drawImage(pack.filledCanvas, x0, y0, pw, ph, 0, 0, pw, ph);
        pctx.restore();
      }
      // 2) Composite conforming socket inpainting layer underneath torso strokes
      if (socketCanvas) {
        pctx.drawImage(socketCanvas, x0, y0, pw, ph, 0, 0, pw, ph);
      }
    } else {
      // Child limb circular ball-joint capsule (`r_joint = 0.55 * limbWidth`)
      const pivLx = cap.pivX - x0;
      const pivLy = cap.pivY - y0;
      const limbFill = sampleLocalBodyFillStyle(pack.filledCanvas, cap.pivX, cap.pivY, pack.faceFillColor);
      pctx.save();
      pctx.beginPath();
      pctx.arc(pivLx, pivLy, cap.rJoint, 0, Math.PI * 2);
      pctx.clip();
      // Draw character silhouette pixels inside the circular joint tab, backed by solid limb color inside the joint core
      pctx.drawImage(pack.filledCanvas, x0, y0, pw, ph, 0, 0, pw, ph);
      pctx.globalCompositeOperation = 'destination-over';
      pctx.fillStyle = limbFill;
      pctx.beginPath();
      pctx.arc(pivLx, pivLy, cap.rJoint * 0.78, 0, Math.PI * 2);
      pctx.fill();
      pctx.restore();
    }

    pctx.drawImage(seg.canvas, x0, y0, pw, ph, 0, 0, pw, ph);
    // Clip strictly to the character's original outer silhouette so joint capsules NEVER bulge into exterior air!
    pctx.save();
    pctx.globalCompositeOperation = 'destination-in';
    pctx.drawImage(pack.filledCanvas, x0, y0, pw, ph, 0, 0, pw, ph);
    pctx.restore();

    const blobKey = await saveBlob(await canvasToPngBlob(pc));

    parts.push({
      id: sp.isRoot ? rootId : makeId('prt'),
      name: localizePinOrPartLabel(sp.nameTr, locale),
      parentId: sp.isRoot ? null : rootId,
      blobKey,
      x: x0,
      y: y0,
      w: pw,
      h: ph,
      pivotX: Math.max(0, Math.min(pw, Math.round(cap.pivX - x0))),
      pivotY: Math.max(0, Math.min(ph, Math.round(cap.pivY - y0))),
      zIndex: sp.zIndex,
      mouthSlot: null,
    });
  }

  if (parts.length > 0 && !parts.some((p) => p.parentId === null)) {
    parts[0].parentId = null;
    const fallbackRoot = parts[0].id;
    for (let i = 1; i < parts.length; i++) {
      parts[i].parentId = fallbackRoot;
    }
  }

  return parts;
}
