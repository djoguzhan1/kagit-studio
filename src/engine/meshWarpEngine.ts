import type { AudioTrackData, MeshFrameOffsets, MeshPin, MeshWarpRig } from '../types/studio';
import { getBlobBitmap, makeId } from './db';
import { localizePinOrPartLabel, type StudioLocale } from '../i18n/translations';
import { getVoiceEffectRate, rmsToMouthViseme, type MouthViseme } from './audioEngine';
import {
  drawCartoonMouth,
  drawCharacterFacialActing,
  easeOutCubic,
  evalWilliamsHipBounce,
  evalWilliamsLeg,
  organicBreathCurve,
  renderMultiLayerRiggedCharacter,
  type ArticulatedCartoonPose,
  type DrawingAnatomy,
} from './cartoonMotionEngine';
import {
  getOrBuildCachedRigPack,
  prepareCharacterCanvas,
  stripPaperBackgroundBfsRGBA,
} from './characterIntakeEngine';
import type { CharacterArchetype } from './skeletonSkinEngine';
import { solveGeodesicArapMesh } from './arapSolver';
import { renderConformingMeshAuto } from './webglSkinnedRenderer';

export type MeshPresetId = 'breathe' | 'bounce' | 'walk' | 'wave' | 'dance' | 'stretch';
export type PinTemplateId = 'humanoid' | 'creature' | 'simple';
export type PuppetBackdropId = 'paper' | 'transparent' | 'night' | 'sunset';

export interface Vec2 {
  x: number;
  y: number;
}

/** Maps auto-detected silhouette archetype into the ideal default Canlı Kukla pin template */
export function archetypeToPinTemplate(archetype: CharacterArchetype): PinTemplateId {
  if (archetype === 'quadruped') return 'creature';
  if (archetype === 'floater') return 'simple';
  return 'humanoid';
}

/**
 * Pure RGBA Adaptive Exterior BFS Paper Remover (testable in Node & Browser).
 * Strips white OR warm/shadowed notebook paper strictly from outside edges inward,
 * preserving interior white eyes, teeth, faces, and clothing 100% opaque!
 */
export function cleanWhitePaperRGBA(
  data: Uint8ClampedArray,
  w: number,
  h: number
): boolean {
  return stripPaperBackgroundBfsRGBA(data, w, h);
}

/**
 * Draws an uploaded drawing/photo, removes paper via exterior BFS (preserving white eyes/faces),
 * and tight-crops around the real character silhouette so feet and pins align accurately!
 */
export function cleanUploadedCharacterImage(
  img: HTMLImageElement,
  maxDim = 768
): HTMLCanvasElement {
  return prepareCharacterCanvas(img, { maxDim, stripPaper: true }).canvas;
}

/**
 * Creates anatomy-matched control pins from a character's real detected silhouette!
 * Works for ALL 3 templates (`humanoid`, `creature`, `simple`) so custom drawings
 * — whether stickmen, cats, ghosts, or clouds — ALWAYS receive dead-center joints.
 */
export function createAnatomyMeshPins(
  anatomy: DrawingAnatomy,
  template: PinTemplateId = 'humanoid'
): MeshPin[] {
  const cx = Number(anatomy.centerX.toFixed(3));
  const headX = Number(anatomy.headCenterX.toFixed(3));
  const headY = Number(Math.max(0.1, Math.min(0.42, anatomy.headCenterY)).toFixed(3));
  const rootY = Number(Math.max(0.4, Math.min(0.72, (anatomy.shoulderY + anatomy.hipV) * 0.55)).toFixed(3));
  const handLX = Number(Math.max(0.06, Math.min(cx - 0.1, anatomy.handLeftX)).toFixed(3));
  const handLY = Number(Math.max(0.26, Math.min(0.76, anatomy.handLeftY)).toFixed(3));
  const handRX = Number(Math.min(0.94, Math.max(cx + 0.1, anatomy.handRightX)).toFixed(3));
  const handRY = Number(Math.max(0.26, Math.min(0.76, anatomy.handRightY)).toFixed(3));
  const footLX = Number(Math.max(0.14, Math.min(cx - 0.04, anatomy.footLeftX)).toFixed(3));
  const footRX = Number(Math.min(0.86, Math.max(cx + 0.04, anatomy.footRightX)).toFixed(3));
  const footY = Number(Math.max(0.74, Math.min(0.96, anatomy.groundV - 0.03)).toFixed(3));

  if (template === 'creature') {
    return [
      { id: makeId('pin'), label: 'Gövde', role: 'root', x: cx, y: rootY },
      { id: makeId('pin'), label: 'Baş', role: 'head', x: headX, y: headY },
      { id: makeId('pin'), label: 'Sol Pati', role: 'foot-l', x: footLX, y: footY },
      { id: makeId('pin'), label: 'Sağ Pati', role: 'foot-r', x: footRX, y: footY },
      { id: makeId('pin'), label: 'Kuyruk', role: 'tail', x: handLX, y: Number(Math.max(0.32, rootY - 0.04).toFixed(3)) },
    ];
  }

  if (template === 'simple') {
    return [
      { id: makeId('pin'), label: 'Üst', role: 'head', x: headX, y: headY },
      { id: makeId('pin'), label: 'Merkez', role: 'root', x: cx, y: rootY },
      { id: makeId('pin'), label: 'Sol', role: 'hand-l', x: handLX, y: rootY },
      { id: makeId('pin'), label: 'Sağ', role: 'hand-r', x: handRX, y: rootY },
    ];
  }

  return [
    { id: makeId('pin'), label: 'Gövde', role: 'root', x: cx, y: rootY },
    { id: makeId('pin'), label: 'Baş', role: 'head', x: headX, y: headY },
    { id: makeId('pin'), label: 'Sol El', role: 'hand-l', x: handLX, y: handLY },
    { id: makeId('pin'), label: 'Sağ El', role: 'hand-r', x: handRX, y: handRY },
    { id: makeId('pin'), label: 'Sol Ayak', role: 'foot-l', x: footLX, y: footY },
    { id: makeId('pin'), label: 'Sağ Ayak', role: 'foot-r', x: footRX, y: footY },
  ];
}

/**
 * Applies a manual pin drag either to the single active frame or smoothly propagated across all frames
 * (delta-preserving so preset motion keeps playing around the user's new pose!).
 */
export function applyPinEditToFrames(
  frames: MeshFrameOffsets[],
  totalFrames: number,
  frameIdx: number,
  pinId: string,
  newDx: number,
  newDy: number,
  mode: 'single' | 'all'
): MeshFrameOffsets[] {
  const prevAtCur = frames[frameIdx]?.[pinId] ?? { dx: 0, dy: 0 };
  const deltaX = newDx - prevAtCur.dx;
  const deltaY = newDy - prevAtCur.dy;

  return Array.from({ length: totalFrames }, (_, i) => {
    const base = { ...(frames[i] ?? {}) };
    if (mode === 'all') {
      const cur = base[pinId] ?? { dx: 0, dy: 0 };
      base[pinId] = {
        dx: Number((cur.dx + deltaX).toFixed(4)),
        dy: Number((cur.dy + deltaY).toFixed(4)),
      };
    } else if (i === frameIdx) {
      base[pinId] = {
        dx: Number(newDx.toFixed(4)),
        dy: Number(newDy.toFixed(4)),
      };
    }
    return base;
  });
}

/** 1-Click standard anatomical pin layouts (normalized 0..1) */
export function createPinTemplate(template: PinTemplateId): MeshPin[] {
  if (template === 'creature') {
    return [
      { id: makeId('pin'), label: 'Gövde', role: 'root', x: 0.5, y: 0.56 },
      { id: makeId('pin'), label: 'Baş', role: 'head', x: 0.5, y: 0.3 },
      { id: makeId('pin'), label: 'Sol Pati', role: 'foot-l', x: 0.36, y: 0.78 },
      { id: makeId('pin'), label: 'Sağ Pati', role: 'foot-r', x: 0.64, y: 0.78 },
      { id: makeId('pin'), label: 'Kuyruk', role: 'tail', x: 0.24, y: 0.52 },
    ];
  }
  if (template === 'simple') {
    return [
      { id: makeId('pin'), label: 'Üst', role: 'head', x: 0.5, y: 0.28 },
      { id: makeId('pin'), label: 'Merkez', role: 'root', x: 0.5, y: 0.54 },
      { id: makeId('pin'), label: 'Sol', role: 'hand-l', x: 0.3, y: 0.54 },
      { id: makeId('pin'), label: 'Sağ', role: 'hand-r', x: 0.7, y: 0.54 },
    ];
  }
  return [
    { id: makeId('pin'), label: 'Gövde', role: 'root', x: 0.5, y: 0.54 },
    { id: makeId('pin'), label: 'Baş', role: 'head', x: 0.5, y: 0.26 },
    { id: makeId('pin'), label: 'Sol El', role: 'hand-l', x: 0.27, y: 0.48 },
    { id: makeId('pin'), label: 'Sağ El', role: 'hand-r', x: 0.73, y: 0.48 },
    { id: makeId('pin'), label: 'Sol Ayak', role: 'foot-l', x: 0.41, y: 0.82 },
    { id: makeId('pin'), label: 'Sağ Ayak', role: 'foot-r', x: 0.59, y: 0.82 },
  ];
}

/** Deterministic lightweight pseudo-noise for authentic 3-frame hand-drawn boiling lines */
function boilNoise(idx: number, boilPhase: number): number {
  const s = Math.sin(idx * 127.1 + boilPhase * 311.7) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
}

/**
 * Pure 2D Radial-Basis / Soft-Cage Vertex Deformation.
 * Smoothly bends any single drawing around user pins with zero tearing and <2ms cost.
 */
export function deformPoint(
  u: number,
  v: number,
  pins: MeshPin[],
  offsets: MeshFrameOffsets
): Vec2 {
  if (pins.length === 0) return { x: u, y: v };

  let sumW = 0;
  let dispX = 0;
  let dispY = 0;

  for (let i = 0; i < pins.length; i++) {
    const p = pins[i];
    const off = offsets[p.id];
    const dx = u - p.x;
    const dy = v - p.y;
    const d2 = dx * dx + dy * dy;
    // Smooth Shepard weight with generous falloff for rubber-hose cartoon flexibility
    const w = 1 / Math.pow(d2 + 0.014, 1.45);
    sumW += w;
    if (off) {
      dispX += w * off.dx;
      dispY += w * off.dy;
    }
  }

  if (sumW <= 1e-9) return { x: u, y: v };
  return {
    x: u + dispX / sumW,
    y: v + dispY / sumW,
  };
}

/** Computes deformed grid vertices (cols+1) * (rows+1) in normalized 0..1 coordinates */
export function computeDeformedMeshGrid(
  pins: MeshPin[],
  offsets: MeshFrameOffsets,
  cols: number,
  rows: number,
  boilAmount = 0,
  frameIndex = 0
): Vec2[] {
  const verts: Vec2[] = new Array((cols + 1) * (rows + 1));
  const boilPhase = Math.floor(frameIndex / 2) % 3;
  const boilAmp = boilAmount * 0.0045;

  let k = 0;
  for (let r = 0; r <= rows; r++) {
    const v = r / rows;
    for (let c = 0; c <= cols; c++) {
      const u = c / cols;
      const pt = deformPoint(u, v, pins, offsets);
      if (boilAmp > 0 && r > 0 && r < rows && c > 0 && c < cols) {
        pt.x += boilNoise(k * 2, boilPhase) * boilAmp;
        pt.y += boilNoise(k * 2 + 1, boilPhase) * boilAmp;
      }
      verts[k++] = pt;
    }
  }
  return verts;
}

/**
 * Draws one affine-mapped textured triangle on Canvas2D with 0.55px centroid expansion
 * to eliminate sub-pixel anti-aliasing seams between adjacent triangles.
 */
function drawTexturedTriangle(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  sx0: number,
  sy0: number,
  sx1: number,
  sy1: number,
  sx2: number,
  sy2: number,
  dx0: number,
  dy0: number,
  dx1: number,
  dy1: number,
  dx2: number,
  dy2: number
): void {
  const denom = (sx1 - sx0) * (sy2 - sy0) - (sx2 - sx0) * (sy1 - sy0);
  if (Math.abs(denom) < 1e-6) return;

  // Expand destination triangle slightly (~0.55px) from centroid to hide seams
  const cx = (dx0 + dx1 + dx2) / 3;
  const cy = (dy0 + dy1 + dy2) / 3;
  const expand = (px: number, py: number) => {
    const vx = px - cx;
    const vy = py - cy;
    const len = Math.hypot(vx, vy) || 1;
    return [px + (vx / len) * 0.55, py + (vy / len) * 0.55];
  };
  const [ex0, ey0] = expand(dx0, dy0);
  const [ex1, ey1] = expand(dx1, dy1);
  const [ex2, ey2] = expand(dx2, dy2);

  const a = ((dx1 - dx0) * (sy2 - sy0) - (dx2 - dx0) * (sy1 - sy0)) / denom;
  const b = ((dy1 - dy0) * (sy2 - sy0) - (dy2 - dy0) * (sy1 - sy0)) / denom;
  const c = ((sx1 - sx0) * (dx2 - dx0) - (sx2 - sx0) * (dx1 - dx0)) / denom;
  const d = ((sx1 - sx0) * (dy2 - dy0) - (sx2 - sx0) * (dy1 - dy0)) / denom;
  const e = dx0 - a * sx0 - c * sy0;
  const f = dy0 - b * sx0 - d * sy0;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(ex0, ey0);
  ctx.lineTo(ex1, ey1);
  ctx.lineTo(ex2, ey2);
  ctx.closePath();
  ctx.clip();
  ctx.transform(a, b, c, d, e, f);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

/** Draws expressive cartoon lip-sync mouth shapes cleanly over the deformed head position */
function drawCartoonMouthViseme(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  viseme: MouthViseme
): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#1C1917';
  ctx.lineWidth = Math.max(2.2, size * 0.12);

  if (viseme === 'closed') {
    ctx.beginPath();
    ctx.moveTo(-size * 0.45, 0);
    ctx.quadraticCurveTo(0, size * 0.16, size * 0.45, 0);
    ctx.stroke();
  } else if (viseme === 'half') {
    ctx.fillStyle = '#B83324';
    ctx.beginPath();
    ctx.ellipse(0, 0, size * 0.46, size * 0.22, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // Tiny upper teeth highlight
    ctx.fillStyle = '#FAF6EE';
    ctx.fillRect(-size * 0.24, -size * 0.18, size * 0.48, size * 0.1);
  } else if (viseme === 'round') {
    ctx.fillStyle = '#8F2418';
    ctx.beginPath();
    ctx.ellipse(0, size * 0.04, size * 0.28, size * 0.34, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else {
    // 'wide' — joyful loud cartoon 'A' mouth with tongue!
    ctx.fillStyle = '#8F2418';
    ctx.beginPath();
    ctx.moveTo(-size * 0.52, -size * 0.15);
    ctx.quadraticCurveTo(0, -size * 0.24, size * 0.52, -size * 0.15);
    ctx.quadraticCurveTo(size * 0.45, size * 0.48, 0, size * 0.48);
    ctx.quadraticCurveTo(-size * 0.45, size * 0.48, -size * 0.52, -size * 0.15);
    ctx.closePath();
    ctx.fill();
    // Tongue accent
    ctx.fillStyle = '#E55A47';
    ctx.beginPath();
    ctx.ellipse(0, size * 0.32, size * 0.28, size * 0.14, 0, 0, Math.PI * 2);
    ctx.fill();
    // Upper teeth
    ctx.fillStyle = '#FAF6EE';
    ctx.fillRect(-size * 0.34, -size * 0.15, size * 0.68, size * 0.14);
    ctx.stroke();
  }
  ctx.restore();
}

export function getMeshStageLayout(
  sourceW: number,
  sourceH: number,
  canvasW: number,
  canvasH: number
): { drawX: number; drawY: number; drawW: number; drawH: number; scale: number } {
  const scale = Math.min((canvasW * 0.82) / sourceW, (canvasH * 0.82) / sourceH);
  const drawW = sourceW * scale;
  const drawH = sourceH * scale;
  return {
    drawX: (canvasW - drawW) / 2,
    drawY: (canvasH - drawH) / 2,
    drawW,
    drawH,
    scale,
  };
}

/** Renders one frame of a 2D Mesh Warp rig (zero WebGL, silky 60 FPS on phones & desktops) */
export async function renderMeshWarpFrame(
  ctx: CanvasRenderingContext2D,
  rig: MeshWarpRig,
  frameIndex: number,
  canvasW: number,
  canvasH: number,
  options?: {
    paperColor?: string;
    backdrop?: PuppetBackdropId;
    audio?: AudioTrackData | null;
    selectedPinId?: string | null;
    showPins?: boolean;
    showMeshGrid?: boolean;
    showMouthMarker?: boolean;
    isRecording?: boolean;
    liveDragOverride?: { pinId: string; dx: number; dy: number } | null;
    /** Optional output map populated with exact rendered screen coordinates of every pin (100% accurate hit-test!) */
    outPinPositions?: Map<string, Vec2> | null;
  }
): Promise<void> {
  const backdrop = options?.backdrop ?? (options?.paperColor ? 'paper' : 'transparent');
  if (backdrop === 'night') {
    const g = ctx.createLinearGradient(0, 0, 0, canvasH);
    g.addColorStop(0, '#111827');
    g.addColorStop(0.65, '#1E293B');
    g.addColorStop(1, '#0F172A');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, canvasW, canvasH);
    // Warm spotlight pool behind puppet
    const spot = ctx.createRadialGradient(
      canvasW * 0.5,
      canvasH * 0.48,
      20,
      canvasW * 0.5,
      canvasH * 0.5,
      canvasW * 0.42
    );
    spot.addColorStop(0, 'rgba(217, 155, 38, 0.22)');
    spot.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = spot;
    ctx.fillRect(0, 0, canvasW, canvasH);
  } else if (backdrop === 'sunset') {
    const g = ctx.createLinearGradient(0, 0, 0, canvasH);
    g.addColorStop(0, '#F5C487');
    g.addColorStop(0.55, '#E78A5B');
    g.addColorStop(1, '#583A4E');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, canvasW, canvasH);
  } else if (backdrop === 'paper' && options?.paperColor) {
    ctx.fillStyle = options.paperColor;
    ctx.fillRect(0, 0, canvasW, canvasH);
  } else {
    ctx.clearRect(0, 0, canvasW, canvasH);
  }

  const bmp = await getBlobBitmap(rig.sourceBlobKey);
  if (!bmp) return;

  const safeIdx = Math.max(0, frameIndex % Math.max(1, rig.totalFrames));
  const baseOffsets: MeshFrameOffsets = rig.frames[safeIdx] ?? {};

  // Audio-reactive head bob & talking bounce (rate-synced to Chipmunk / Giant voice FX!)
  const audio = options?.audio;
  const fxRate = getVoiceEffectRate(audio?.voiceEffect);
  const audioIdx =
    audio && audio.rmsPerFrame.length > 0
      ? Math.floor(safeIdx * fxRate) % audio.rmsPerFrame.length
      : 0;
  const prevAudioIdx =
    audio && audio.rmsPerFrame.length > 0
      ? Math.max(0, (Math.floor(safeIdx * fxRate) - 1 + audio.rmsPerFrame.length) % audio.rmsPerFrame.length)
      : 0;
  const rms =
    audio && !audio.muted && audio.rmsPerFrame.length > 0
      ? audio.rmsPerFrame[audioIdx]
      : 0;
  const prevRms =
    audio && !audio.muted && audio.rmsPerFrame.length > 0
      ? audio.rmsPerFrame[prevAudioIdx]
      : 0;

  const effectiveOffsets: MeshFrameOffsets = { ...baseOffsets };
  if (options?.liveDragOverride) {
    effectiveOffsets[options.liveDragOverride.pinId] = {
      dx: options.liveDragOverride.dx,
      dy: options.liveDragOverride.dy,
    };
  }
  if (rms > 0.08) {
    for (const pin of rig.pins) {
      if (pin.role === 'head') {
        const cur = effectiveOffsets[pin.id] ?? { dx: 0, dy: 0 };
        effectiveOffsets[pin.id] = {
          dx: cur.dx + Math.sin(safeIdx * 0.9) * rms * 0.018,
          dy: cur.dy - rms * 0.032,
        };
      }
    }
  }

  const layout = getMeshStageLayout(rig.sourceW, rig.sourceH, canvasW, canvasH);
  const pack = getOrBuildCachedRigPack(bmp);
  const { anatomy } = pack;
  const emotion = rig.emotion ?? 'neutral';

  // Determine whether to run Studio 2-Bone IK + Continuous LBS (zero jelly sticking!)
  // or Enhanced Gouache Elastic Cage (for quadrupeds, ghosts, clouds, custom extra pins, or mesh-grid inspection!)
  const rootPin = rig.pins.find((p) => p.role === 'root');
  const headPin = rig.pins.find((p) => p.role === 'head');
  const handLPin = rig.pins.find((p) => p.role === 'hand-l');
  const handRPin = rig.pins.find((p) => p.role === 'hand-r');
  const footLPin = rig.pins.find((p) => p.role === 'foot-l');
  const footRPin = rig.pins.find((p) => p.role === 'foot-r');
  const hasCustomOrTail = rig.pins.some((p) => p.role === 'custom' || p.role === 'tail');

  const useStudioIK =
    pack.useMultiPart &&
    !hasCustomOrTail &&
    !options?.showMeshGrid &&
    Boolean(rootPin && headPin && handLPin && handRPin && footLPin && footRPin);

  // ---- DYNAMIC GROUND CONTACT SHADOW & LANDING/STEP DUST PUFFS (Weight & Gravity!) ----
  if (backdrop !== 'transparent') {
    const rOff = rootPin ? effectiveOffsets[rootPin.id] ?? { dx: 0, dy: 0 } : { dx: 0, dy: 0 };
    const prevIdx = (safeIdx - 1 + rig.totalFrames) % Math.max(1, rig.totalFrames);
    const prevRootDy = rootPin ? rig.frames[prevIdx]?.[rootPin.id]?.dy ?? 0 : 0;
    const prev2Idx = (safeIdx - 2 + rig.totalFrames) % Math.max(1, rig.totalFrames);
    const prev2RootDy = rootPin ? rig.frames[prev2Idx]?.[rootPin.id]?.dy ?? 0 : 0;

    const liftNorm = Math.max(0, -rOff.dy);
    const squashCompress = Math.max(0, rOff.dy);
    const floorX = layout.drawX + (anatomy.centerX + rOff.dx) * layout.drawW;
    const floorY = layout.drawY + anatomy.groundV * layout.drawH + 4;
    const shadowScale = Math.max(0.36, Math.min(1.18, 1 - liftNorm * 2.4 + squashCompress * 1.6));
    const shadowAlpha = Math.max(
      0.08,
      Math.min(0.42, (backdrop === 'night' ? 0.36 : 0.24) * (1 - liftNorm * 1.9 + squashCompress))
    );

    ctx.save();
    // Soft outer ambient shadow
    ctx.fillStyle =
      backdrop === 'night'
        ? `rgba(4, 6, 14, ${(shadowAlpha * 1.15).toFixed(3)})`
        : `rgba(28, 22, 16, ${(shadowAlpha * 0.55).toFixed(3)})`;
    ctx.beginPath();
    ctx.ellipse(floorX, floorY + 2, layout.drawW * 0.36 * shadowScale, Math.max(7, layout.drawH * 0.036 * shadowScale), 0, 0, Math.PI * 2);
    ctx.fill();

    // Tight crisp foot contact shadow
    ctx.fillStyle =
      backdrop === 'night'
        ? `rgba(2, 4, 10, ${(shadowAlpha * 1.35).toFixed(3)})`
        : `rgba(24, 18, 12, ${shadowAlpha.toFixed(3)})`;
    ctx.beginPath();
    ctx.ellipse(floorX, floorY, layout.drawW * 0.22 * shadowScale, Math.max(4, layout.drawH * 0.02 * shadowScale), 0, 0, Math.PI * 2);
    ctx.fill();

    // Deterministic cartoon impact dust puffs when landing from a jump/bounce or heavy crouch!
    const impactStrength = Math.max(
      0,
      Math.min(1, (rOff.dy - prevRootDy) * 14 + (prevRootDy < -0.02 && rOff.dy >= -0.01 ? 0.85 : 0))
    );
    const echoStrength = Math.max(
      0,
      Math.min(1, (prevRootDy - prev2RootDy) * 10)
    );
    const dustPower = Math.max(impactStrength, echoStrength * 0.65);
    if (dustPower > 0.16 && liftNorm < 0.04) {
      const dustAge = impactStrength > 0.16 ? 0.25 : 0.65;
      const dustAlpha = (1 - dustAge) * Math.min(1, dustPower) * (backdrop === 'night' ? 0.38 : 0.55);
      ctx.fillStyle =
        backdrop === 'night'
          ? `rgba(245, 226, 184, ${dustAlpha.toFixed(3)})`
          : `rgba(214, 198, 170, ${dustAlpha.toFixed(3)})`;
      for (const side of [-1, 1]) {
        for (let p = 0; p < 2; p++) {
          const dx = side * layout.drawW * (0.16 + dustAge * 0.18 + p * 0.08);
          const dy = -dustAge * layout.drawH * (0.045 + p * 0.022);
          const rad = Math.max(4, layout.drawW * (0.032 + p * 0.014) * (0.7 + dustAge * 0.5));
          ctx.beginPath();
          ctx.arc(floorX + dx, floorY + dy, rad, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.restore();
  }

  // Smooth organic periodic blink curve (0..1)
  let blinkVal = 0;
  if (rig.autoBlink) {
    const blinkCycle = Math.max(20, rig.totalFrames);
    const blinkPhase = safeIdx % blinkCycle;
    if (blinkPhase === blinkCycle - 3) blinkVal = 0.62;
    else if (blinkPhase === blinkCycle - 2) blinkVal = 1.0;
    else if (blinkPhase === blinkCycle - 1) blinkVal = 0.45;
  }

  let liveMouthX = layout.drawX + (rig.mouthPos?.x ?? anatomy.mouthX) * layout.drawW;
  let liveMouthY = layout.drawY + (rig.mouthPos?.y ?? anatomy.mouthY) * layout.drawH;
  let liveHeadTop: Vec2 = {
    x: layout.drawX + anatomy.headCenterX * layout.drawW,
    y: layout.drawY + Math.max(0.03, anatomy.headCenterY - 0.13) * layout.drawH,
  };
  let liveHeadRot = 0;
  const solvedPinPositions = new Map<string, Vec2>();

  if (useStudioIK && rootPin && headPin && handLPin && handRPin && footLPin && footRPin) {
    const rootOff = effectiveOffsets[rootPin.id] ?? { dx: 0, dy: 0 };
    const headOff = effectiveOffsets[headPin.id] ?? { dx: 0, dy: 0 };
    const handLOff = effectiveOffsets[handLPin.id] ?? { dx: 0, dy: 0 };
    const handROff = effectiveOffsets[handRPin.id] ?? { dx: 0, dy: 0 };
    const footLOff = effectiveOffsets[footLPin.id] ?? { dx: 0, dy: 0 };
    const footROff = effectiveOffsets[footRPin.id] ?? { dx: 0, dy: 0 };

    const headRelDx = headOff.dx - rootOff.dx;
    const headRelDy = headOff.dy - rootOff.dy;
    const squashY = Math.max(0.84, Math.min(1.18, 1 - headRelDy * 1.45));
    const squashX = 1 / squashY;
    const torsoLeanRad = Math.max(-0.34, Math.min(0.34, headRelDx * 1.15));
    const headTiltRad = Math.max(-0.42, Math.min(0.42, headRelDx * 1.45));
    liveHeadRot = headTiltRad + torsoLeanRad * 0.42;

    const artPose: ArticulatedCartoonPose = {
      hipShiftX: rootOff.dx,
      hipLiftY: -rootOff.dy,
      squashY,
      squashX,
      torsoLeanRad,
      chestCounterRad: -torsoLeanRad * 0.25,
      headTiltRad,
      headLagY: headRelDy * 0.3,
      headTurnX: Math.max(-1, Math.min(1, headRelDx * 3.5)),
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
      mouthOpen: rms,
      viseme: 'closed',
      blink: blinkVal,
      facing: 1,
    };

    const skel = pack.skinnedMesh;
    const hLRest =
      skel && skel.bones.length >= 17
        ? skel.bones[14].end
        : skel && skel.bones.length >= 11
          ? skel.bones[4].end
          : pack.parts.arm_l.end;
    const hRRest =
      skel && skel.bones.length >= 17
        ? skel.bones[16].end
        : skel && skel.bones.length >= 11
          ? skel.bones[6].end
          : pack.parts.arm_r.end;
    const fLRest =
      skel?.footLeft?.ball ??
      (skel && skel.bones.length >= 11 ? skel.bones[8].end : pack.parts.leg_l.end);
    const fRRest =
      skel?.footRight?.ball ??
      (skel && skel.bones.length >= 11 ? skel.bones[10].end : pack.parts.leg_r.end);

    // V3 Real Foot-Lock Crouch: dragging root downward while feet stay unmoved pins both feet
    // strictly to the floor so knees & ankles bend naturally into a real grounded crouch!
    const footLDy = Math.abs(footLOff.dy) < 0.004 && rootOff.dy > 0.008 ? 0 : footLOff.dy;
    const footRDy = Math.abs(footROff.dy) < 0.004 && rootOff.dy > 0.008 ? 0 : footROff.dy;

    const anchors = renderMultiLayerRiggedCharacter(
      ctx,
      pack,
      artPose,
      { x: layout.drawX, y: layout.drawY, w: layout.drawW, h: layout.drawH },
      {
        boilTick: Math.floor(safeIdx / 2),
        nightLampPos: backdrop === 'night' ? { x: canvasW * 0.5, y: canvasH * 0.25 } : null,
        emotion,
        ikOverrides: {
          handLeft: {
            x: layout.drawX + (hLRest.x + handLOff.dx) * layout.drawW,
            y: layout.drawY + (hLRest.y + handLOff.dy) * layout.drawH,
          },
          handRight: {
            x: layout.drawX + (hRRest.x + handROff.dx) * layout.drawW,
            y: layout.drawY + (hRRest.y + handROff.dy) * layout.drawH,
          },
          footLeft: {
            x: layout.drawX + (fLRest.x + footLOff.dx) * layout.drawW,
            y: layout.drawY + (fLRest.y + footLDy) * layout.drawH,
          },
          footRight: {
            x: layout.drawX + (fRRest.x + footROff.dx) * layout.drawW,
            y: layout.drawY + (fRRest.y + footRDy) * layout.drawH,
          },
          headOffset: {
            x: headRelDx * layout.drawW * 0.22,
            y: headRelDy * layout.drawH * 0.22,
          },
        },
      }
    );

    // Record exact solved IK end-effectors so visible pin handles & click hit-tests agree to 0.000 px!
    solvedPinPositions.set(rootPin.id, anchors.pelvisScreen);
    solvedPinPositions.set(headPin.id, {
      x: anchors.headTopScreen.x,
      y: anchors.headTopScreen.y + layout.drawH * 0.1,
    });
    solvedPinPositions.set(handLPin.id, anchors.handLeftScreen);
    solvedPinPositions.set(handRPin.id, anchors.handRightScreen);
    solvedPinPositions.set(footLPin.id, anchors.footLeftScreen);
    solvedPinPositions.set(footRPin.id, anchors.footRightScreen);
    liveHeadTop = anchors.headTopScreen;

    // Anchor mouth directly onto the moving head + honor any custom user mouthPos adjustment!
    const customMouthDx = rig.mouthPos ? (rig.mouthPos.x - anatomy.mouthX) * layout.drawW : 0;
    const customMouthDy = rig.mouthPos ? (rig.mouthPos.y - anatomy.mouthY) * layout.drawH : 0;
    const ch = Math.cos(liveHeadRot);
    const sh = Math.sin(liveHeadRot);
    liveMouthX = anchors.mouthScreen.x + customMouthDx * ch - customMouthDy * sh;
    liveMouthY = anchors.mouthScreen.y + customMouthDx * sh + customMouthDy * ch;
  } else if (pack.silhouetteMesh) {
    // V3 ZERO-MERGING GEODESIC ARAP PIN SOLVER (no cross-air Shepard RBF webbing, locally rigid volume!)
    const silMesh = pack.silhouetteMesh;
    const boilPhase = Math.floor(safeIdx / 2) % 3;
    const boilAmp = rig.lineBoil * 0.004;
    const arap = solveGeodesicArapMesh(silMesh, rig.pins, effectiveOffsets, layout, {
      iterations: 3,
      boilAmp,
      boilPhase,
    });
    const pos = arap.positions;

    renderConformingMeshAuto(ctx, pack.filledCanvas, silMesh, pos, {
      nightHalo: backdrop === 'night',
    });

    if (options?.showMeshGrid) {
      ctx.save();
      ctx.strokeStyle = 'rgba(37, 99, 235, 0.28)';
      ctx.lineWidth = 1;
      const tris = silMesh.triangles;
      ctx.beginPath();
      for (let i = 0; i < tris.length; i += 3) {
        const a = tris[i] * 2;
        const b = tris[i + 1] * 2;
        const c = tris[i + 2] * 2;
        ctx.moveTo(pos[a], pos[a + 1]);
        ctx.lineTo(pos[b], pos[b + 1]);
        ctx.lineTo(pos[c], pos[c + 1]);
        ctx.lineTo(pos[a], pos[a + 1]);
      }
      ctx.stroke();
      ctx.restore();
    }

    drawCharacterFacialActing(ctx, pack, {
      blink: blinkVal,
      emotion,
      headMap: (u, v) => {
        const dp = deformPoint(u, v, rig.pins, effectiveOffsets);
        return { x: layout.drawX + dp.x * layout.drawW, y: layout.drawY + dp.y * layout.drawH };
      },
      actorW: layout.drawW,
      headRot: 0,
      mouthOpen: rms,
    });

    const deformedHeadTop = deformPoint(
      anatomy.headCenterX,
      Math.max(0.03, anatomy.headCenterY - 0.13),
      rig.pins,
      effectiveOffsets
    );
    liveHeadTop = {
      x: layout.drawX + deformedHeadTop.x * layout.drawW,
      y: layout.drawY + deformedHeadTop.y * layout.drawH,
    };

    if (rig.mouthPos) {
      const deformedMouth = deformPoint(rig.mouthPos.x, rig.mouthPos.y, rig.pins, effectiveOffsets);
      liveMouthX = layout.drawX + deformedMouth.x * layout.drawW;
      liveMouthY = layout.drawY + deformedMouth.y * layout.drawH;
    }
  } else {
    // Enhanced Closed-Contour Gouache Elastic Cage (with crisp Night Rim Halo on dark stages!)
    const texSource: CanvasImageSource =
      backdrop === 'night' ? pack.nightFilledCanvas : pack.filledCanvas;
    const texW = pack.filledCanvas.width;
    const texH = pack.filledCanvas.height;

    const mem = typeof navigator !== 'undefined' ? (navigator as unknown as { deviceMemory?: number }).deviceMemory : 8;
    const cols = typeof mem === 'number' && mem <= 4 ? 8 : 10;
    const rows = typeof mem === 'number' && mem <= 4 ? 10 : 12;

    const verts = computeDeformedMeshGrid(
      rig.pins,
      effectiveOffsets,
      cols,
      rows,
      rig.lineBoil,
      safeIdx
    );

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i00 = r * (cols + 1) + c;
        const i10 = i00 + 1;
        const i01 = i00 + (cols + 1);
        const i11 = i01 + 1;

        const u0 = (c / cols) * texW;
        const v0 = (r / rows) * texH;
        const u1 = ((c + 1) / cols) * texW;
        const v1 = ((r + 1) / rows) * texH;

        const p00 = verts[i00];
        const p10 = verts[i10];
        const p01 = verts[i01];
        const p11 = verts[i11];

        const x00 = layout.drawX + p00.x * layout.drawW;
        const y00 = layout.drawY + p00.y * layout.drawH;
        const x10 = layout.drawX + p10.x * layout.drawW;
        const y10 = layout.drawY + p10.y * layout.drawH;
        const x01 = layout.drawX + p01.x * layout.drawW;
        const y01 = layout.drawY + p01.y * layout.drawH;
        const x11 = layout.drawX + p11.x * layout.drawW;
        const y11 = layout.drawY + p11.y * layout.drawH;

        drawTexturedTriangle(ctx, texSource, u0, v0, u1, v0, u1, v1, x00, y00, x10, y10, x11, y11);
        drawTexturedTriangle(ctx, texSource, u0, v0, u1, v1, u0, v1, x00, y00, x11, y11, x01, y01);
      }
    }

    // Optional debug / craftsmanship wireframe overlay
    if (options?.showMeshGrid) {
      ctx.save();
      ctx.strokeStyle = 'rgba(37, 99, 235, 0.24)';
      ctx.lineWidth = 1;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const i00 = r * (cols + 1) + c;
          const p00 = verts[i00];
          const p10 = verts[i00 + 1];
          const p01 = verts[i00 + cols + 1];
          ctx.beginPath();
          ctx.moveTo(layout.drawX + p00.x * layout.drawW, layout.drawY + p00.y * layout.drawH);
          ctx.lineTo(layout.drawX + p10.x * layout.drawW, layout.drawY + p10.y * layout.drawH);
          ctx.moveTo(layout.drawX + p00.x * layout.drawW, layout.drawY + p00.y * layout.drawH);
          ctx.lineTo(layout.drawX + p01.x * layout.drawW, layout.drawY + p01.y * layout.drawH);
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    // Full 6-Emotion Facial Acting + Detected-Eye Blink on Elastic Cage (cats, ghosts, clouds too!)
    drawCharacterFacialActing(ctx, pack, {
      blink: blinkVal,
      emotion,
      headMap: (u, v) => {
        const dp = deformPoint(u, v, rig.pins, effectiveOffsets);
        return { x: layout.drawX + dp.x * layout.drawW, y: layout.drawY + dp.y * layout.drawH };
      },
      actorW: layout.drawW,
      headRot: 0,
      mouthOpen: rms,
    });

    const deformedHeadTop = deformPoint(
      anatomy.headCenterX,
      Math.max(0.03, anatomy.headCenterY - 0.13),
      rig.pins,
      effectiveOffsets
    );
    liveHeadTop = {
      x: layout.drawX + deformedHeadTop.x * layout.drawW,
      y: layout.drawY + deformedHeadTop.y * layout.drawH,
    };

    if (rig.mouthPos) {
      const deformedMouth = deformPoint(rig.mouthPos.x, rig.mouthPos.y, rig.pins, effectiveOffsets);
      liveMouthX = layout.drawX + deformedMouth.x * layout.drawW;
      liveMouthY = layout.drawY + deformedMouth.y * layout.drawH;
    }
  }

  // Expressive anime surprise sparks above head when emotion === 'surprised'!
  if (emotion === 'surprised') {
    ctx.save();
    ctx.strokeStyle = '#E54D2E';
    ctx.lineWidth = Math.max(2.4, layout.drawW * 0.014);
    ctx.lineCap = 'round';
    for (const ang of [-2.15, -1.57, -0.99]) {
      const r1 = layout.drawH * 0.045;
      const r2 = layout.drawH * 0.105;
      ctx.beginPath();
      ctx.moveTo(liveHeadTop.x + Math.cos(ang) * r1, liveHeadTop.y + Math.sin(ang) * r1 - 4);
      ctx.lineTo(liveHeadTop.x + Math.cos(ang) * r2, liveHeadTop.y + Math.sin(ang) * r2 - 4);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Genuine Preston Blair 6-Viseme Auto Lip-Sync Mouth (rate-synced to Chipmunk/Giant voice FX!)
  if (rig.mouthPos) {
    const mSize = Math.max(16, (rig.mouthPos.scale || 1) * layout.drawW * 0.095);
    const hasAudio = Boolean(audio && !audio.muted && audio.rmsPerFrame.length > 0);
    if (hasAudio && audio) {
      const formantViseme =
        audio.visemesPerFrame && audio.visemesPerFrame.length > 0
          ? audio.visemesPerFrame[audioIdx % audio.visemesPerFrame.length]
          : null;
      if (formantViseme) {
        if (formantViseme !== 'closed') {
          const mouthScale = Math.max(0.65, Math.min(1.65, (rig.mouthPos.scale || 1) * (layout.drawW / 245)));
          drawCartoonMouth(ctx, liveMouthX, liveMouthY, mouthScale, formantViseme, Math.max(0.4, rms * 1.2), liveHeadRot);
        } else {
          drawCartoonMouthViseme(ctx, liveMouthX, liveMouthY, mSize, 'closed');
        }
      } else {
        const viseme = rmsToMouthViseme(rms, prevRms);
        drawCartoonMouthViseme(ctx, liveMouthX, liveMouthY, mSize, viseme);
      }
    }

    // Visual target indicator whenever the user is placing/adjusting the Mouth Position!
    if (options?.showMouthMarker) {
      ctx.save();
      if (!audio || audio.muted) {
        ctx.globalAlpha = 0.72;
        drawCartoonMouthViseme(ctx, liveMouthX, liveMouthY, mSize, 'half');
        ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = '#D99B26';
      ctx.lineWidth = 2.2;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.arc(liveMouthX, liveMouthY, Math.max(18, mSize * 0.65), 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
  }

  // Export exact rendered pin screen coordinates for 100% accurate pointer hit-testing in MeshWarpStage!
  if (options?.outPinPositions) {
    options.outPinPositions.clear();
    for (const pin of rig.pins) {
      const off = effectiveOffsets[pin.id] ?? { dx: 0, dy: 0 };
      const solved = solvedPinPositions.get(pin.id);
      if (solved) {
        options.outPinPositions.set(pin.id, solved);
      } else {
        options.outPinPositions.set(pin.id, {
          x: layout.drawX + (pin.x + off.dx) * layout.drawW,
          y: layout.drawY + (pin.y + off.dy) * layout.drawH,
        });
      }
    }
  }

  // Interactive Control Pin Handles (locked directly onto solved 2-Bone IK end-effectors!)
  if (options?.showPins) {
    const getPinVisualPos = (pin: MeshPin): { x: number; y: number; rawX: number; rawY: number } => {
      const off = effectiveOffsets[pin.id] ?? { dx: 0, dy: 0 };
      const rawX = layout.drawX + (pin.x + off.dx) * layout.drawW;
      const rawY = layout.drawY + (pin.y + off.dy) * layout.drawH;
      const solved = solvedPinPositions.get(pin.id);
      return solved ? { x: solved.x, y: solved.y, rawX, rawY } : { x: rawX, y: rawY, rawX, rawY };
    };

    const rootVisualPin = rig.pins.find((p) => p.role === 'root') ?? rig.pins[0];
    if (rootVisualPin) {
      const rp = getPinVisualPos(rootVisualPin);
      ctx.save();
      ctx.strokeStyle = 'rgba(217, 155, 38, 0.55)';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      for (const pin of rig.pins) {
        if (pin.id === rootVisualPin.id) continue;
        const pp = getPinVisualPos(pin);
        ctx.beginPath();
        ctx.moveTo(rp.x, rp.y);
        ctx.lineTo(pp.x, pp.y);
        ctx.stroke();
      }
      ctx.restore();
    }

    for (const pin of rig.pins) {
      const pp = getPinVisualPos(pin);
      const px = pp.x;
      const py = pp.y;
      const isSelected = pin.id === options.selectedPinId;

      ctx.save();
      // If user drags a limb target beyond anatomical reach, draw a subtle elastic reach tether!
      if (isSelected && Math.hypot(pp.rawX - px, pp.rawY - py) > 16) {
        ctx.strokeStyle = 'rgba(229, 77, 46, 0.55)';
        ctx.lineWidth = 1.6;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(pp.rawX, pp.rawY);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      if (isSelected) {
        ctx.strokeStyle = options.isRecording ? '#EF4444' : '#E54D2E';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(px, py, 16, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.fillStyle =
        pin.role === 'root' ? '#D99B26' : isSelected ? '#E54D2E' : '#2563EB';
      ctx.beginPath();
      ctx.arc(px, py, isSelected ? 10 : 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 2.5;
      ctx.stroke();

      ctx.font = 'bold 11px "JetBrains Mono", monospace';
      const activeLocale: StudioLocale = typeof document !== 'undefined' && document.documentElement.lang === 'en' ? 'en' : 'tr';
      const dispPinLabel = localizePinOrPartLabel(pin.label, activeLocale);
      const labelW = ctx.measureText(dispPinLabel).width + 10;
      ctx.fillStyle = 'rgba(22, 21, 19, 0.84)';
      ctx.beginPath();
      ctx.roundRect(px - labelW / 2, py + 13, labelW, 18, 5);
      ctx.fill();
      ctx.fillStyle = '#F7F3E9';
      ctx.textAlign = 'center';
      ctx.fillText(dispPinLabel, px, py + 26);
      ctx.restore();
    }
  }
}

/**
 * 1-Click Studio-Quality Motion Presets (Disney 12 Principles + Richard Williams Curves).
 * Features anticipation, volume preservation, passing-pose foot arcs & overlapping follow-through!
 */
export function generateMeshPresetFrames(
  pins: MeshPin[],
  totalFrames: number,
  preset: MeshPresetId
): MeshFrameOffsets[] {
  const N = Math.max(8, totalFrames);
  const out: MeshFrameOffsets[] = [];

  for (let f = 0; f < N; f++) {
    const u = f / N; // 0..1 normalized cycle
    const phase = u * Math.PI * 2;
    const offsets: MeshFrameOffsets = {};

    for (const p of pins) {
      let dx = 0;
      let dy = 0;

      if (preset === 'breathe') {
        // Asymmetric organic breathing (40% inhale ease-out, 10% hold, 50% exhale) + overlapping lag!
        const b = organicBreathCurve(u) - 0.5;
        const bLag = organicBreathCurve((u - 0.14 + 1) % 1) - 0.5;
        const bHead = organicBreathCurve((u - 0.18 + 1) % 1) - 0.5;
        if (p.role === 'head') {
          dy = -0.026 * bHead;
          dx = 0.008 * Math.sin(phase);
        } else if (p.role === 'root') {
          dy = -0.015 * b;
        } else if (p.role === 'hand-l') {
          dx = -0.018 * b;
          dy = -0.016 * bLag;
        } else if (p.role === 'hand-r') {
          dx = 0.018 * b;
          dy = -0.016 * bLag;
        } else if (p.role === 'tail') {
          dx = 0.032 * Math.sin(phase - 0.75);
          dy = -0.02 * bLag;
        }
      } else if (preset === 'bounce') {
        // Authentic 5-phase Disney Jump: Anticipation -> Stretch Launch -> Gravity Hang -> Squash Impact -> Damped Settle!
        let lift = 0;
        let squash = 0;
        let stretch = 0;
        let armDy = 0;
        let headLag = 0;

        if (u < 0.2) {
          // Anticipation crouch (weight drops, hands pull down/back)
          const k = easeOutCubic(u / 0.2);
          squash = k * 0.9;
          lift = k * 0.048;
          armDy = k * 0.045;
        } else if (u < 0.72) {
          // True gravity parabolic hang: 4*t*(1-t)
          const k = (u - 0.2) / 0.52;
          const arc = 4 * k * (1 - k);
          lift = -arc * 0.165;
          stretch = Math.abs(k - 0.5) * 1.4;
          armDy = -arc * 0.07 - 0.025;
          headLag = k < 0.5 ? 0.018 : -0.016;
        } else {
          // Impact squash + elastic overshoot settle!
          const k = (u - 0.72) / 0.28;
          const damp = Math.exp(-k * 4.2) * Math.sin(k * Math.PI * 2.0);
          squash = Math.max(0, damp);
          lift = damp * 0.055;
          headLag = Math.sin(Math.min(1, k * 1.35) * Math.PI) * 0.026;
          armDy = damp * 0.04;
        }

        if (p.role === 'head') {
          dy = lift - stretch * 0.022 + headLag;
        } else if (p.role === 'root') {
          dy = lift;
        } else if (p.role === 'hand-l') {
          dx = -squash * 0.052 + stretch * 0.018;
          dy = lift + armDy;
        } else if (p.role === 'hand-r') {
          dx = squash * 0.052 - stretch * 0.018;
          dy = lift + armDy;
        } else if (p.role === 'foot-l') {
          dx = -squash * 0.036;
          dy = Math.min(0, lift * 0.62);
        } else if (p.role === 'foot-r') {
          dx = squash * 0.036;
          dy = Math.min(0, lift * 0.62);
        } else {
          dy = lift;
        }
      } else if (preset === 'walk') {
        // Genuine Richard Williams Contact -> Down -> Passing -> Up Walk Cycle!
        const leftLeg = evalWilliamsLeg(u);
        const rightLeg = evalWilliamsLeg((u + 0.5) % 1);
        const { hipY } = evalWilliamsHipBounce(u);
        const { hipY: delayedHipY } = evalWilliamsHipBounce((u - 0.16 + 1) % 1);
        // Arms lag 0.12 cycles behind legs (overlapping action!)
        const armPhase = Math.cos(((u - 0.12 + 1) % 1) * Math.PI * 2);

        const bob = -hipY * 0.034;
        const headBob = -delayedHipY * 0.038;
        const lateralShift = Math.sin(phase) * 0.02;

        if (p.role === 'root') {
          dy = bob;
          dx = lateralShift;
        } else if (p.role === 'head') {
          dy = headBob;
          dx = lateralShift * 0.65 + Math.cos(phase - 0.4) * 0.012;
        } else if (p.role === 'foot-l') {
          dx = leftLeg.stride * 0.082;
          dy = -leftLeg.lift * 0.052; // Strictly 0 during planted stance, curved arc at Passing Pose!
        } else if (p.role === 'foot-r') {
          dx = rightLeg.stride * 0.082;
          dy = -rightLeg.lift * 0.052;
        } else if (p.role === 'hand-l') {
          dx = -armPhase * 0.072;
          dy = bob - Math.abs(armPhase) * 0.022;
        } else if (p.role === 'hand-r') {
          dx = armPhase * 0.072;
          dy = bob - Math.abs(armPhase) * 0.022;
        } else if (p.role === 'tail') {
          dx = -Math.sin(phase - 0.6) * 0.055;
          dy = headBob;
        }
      } else if (preset === 'wave') {
        // Lively cartoon overhead wave + hip weight shift + joyful counter head tilt!
        const shift = Math.sin(phase) * 0.024;
        const waveX = Math.sin(phase * 2);
        const waveY = Math.cos(phase * 2 - 0.55); // Elliptical figure-8 arc!
        if (p.role === 'root') {
          dx = -0.02 + shift * 0.5;
          dy = -Math.abs(Math.sin(phase)) * 0.014;
        } else if (p.role === 'hand-l') {
          // Expressive high free-hand wave (great for Baron whose right hand holds his cane!)
          dx = -0.065 + waveX * 0.085;
          dy = -0.245 + waveY * 0.042;
        } else if (p.role === 'hand-r') {
          dx = 0.04 + waveX * 0.055;
          dy = -0.195 + waveY * 0.032;
        } else if (p.role === 'head') {
          dx = 0.024 * Math.sin(phase - 0.35);
          dy = -0.016 * Math.cos(phase - 0.35);
        }
      } else if (preset === 'dance') {
        // Rhythmic weight-transfer groove with knee dip + 0.12-cycle staggered shoulder/head follow-through!
        const sway = Math.sin(phase);
        const armLag = Math.sin(phase - 0.72);
        const headLag = Math.sin(phase - 1.0);
        const kneeDip = Math.pow(Math.abs(Math.sin(phase)), 1.35);

        if (p.role === 'root') {
          dx = sway * 0.052;
          dy = kneeDip * 0.034 - 0.012;
        } else if (p.role === 'head') {
          dx = -headLag * 0.042;
          dy = kneeDip * 0.038 - 0.014;
        } else if (p.role === 'hand-l') {
          dx = armLag * 0.058;
          dy = -0.075 + Math.sin(phase * 2 - 0.6) * 0.062;
        } else if (p.role === 'hand-r') {
          dx = armLag * 0.058;
          dy = -0.075 - Math.sin(phase * 2 - 0.6) * 0.062;
        } else if (p.role === 'foot-l') {
          dy = -Math.pow(Math.max(0, sway), 1.6) * 0.042;
        } else if (p.role === 'foot-r') {
          dy = -Math.pow(Math.max(0, -sway), 1.6) * 0.042;
        }
      } else if (preset === 'stretch') {
        // Volume-preserving damped harmonic cartoon twang (overshoot & settle!)
        const elastic = Math.sin(u * Math.PI * 3.0) * Math.exp(-u * 2.1);
        if (p.role === 'head') dy = -0.115 * elastic;
        else if (p.role === 'hand-l') {
          dx = 0.055 * elastic; // Inward pull when stretching up (volume preservation!)
          dy = -0.045 * elastic;
        } else if (p.role === 'hand-r') {
          dx = -0.055 * elastic;
          dy = -0.045 * elastic;
        } else if (p.role === 'root') {
          dy = -0.042 * elastic;
        }
      }

      offsets[p.id] = { dx, dy };
    }

    out.push(offsets);
  }
  return out;
}

/** 3-tap moving average smoother for Live Puppeteering REC performances */
export function smoothRecordedMeshFrames(
  frames: MeshFrameOffsets[],
  pins: MeshPin[]
): MeshFrameOffsets[] {
  const N = frames.length;
  if (N < 3) return frames;
  return frames.map((_, i) => {
    const prev = frames[(i - 1 + N) % N];
    const cur = frames[i];
    const next = frames[(i + 1) % N];
    const smoothed: MeshFrameOffsets = {};
    for (const p of pins) {
      const a = prev[p.id] ?? { dx: 0, dy: 0 };
      const b = cur[p.id] ?? { dx: 0, dy: 0 };
      const c = next[p.id] ?? { dx: 0, dy: 0 };
      smoothed[p.id] = {
        dx: a.dx * 0.22 + b.dx * 0.56 + c.dx * 0.22,
        dy: a.dy * 0.22 + b.dy * 0.56 + c.dy * 0.22,
      };
    }
    return smoothed;
  });
}
