import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  CircleDot,
  CloudRain,
  Dices,
  Download,
  Film,
  Flame,
  Hand,
  Mic,
  MicOff,
  Music,
  Music2,
  Pencil,
  Rocket,
  RotateCcw,
  Share2,
  Sparkles,
  Sun,
  Trash2,
  Umbrella,
  Undo2,
  Upload,
  UserPlus,
  Video,
  Volume2,
  Wand2,
  Wind,
  X,
} from 'lucide-react';
import type { MeshFrameOffsets, MeshPin, StudioTheme } from '../../types/studio';
import { KeycapButton } from '../ui/KeycapButton';
import { SketchNibIcon } from '../ui/AnimatedStudioIcons';
import { soundEngine } from '../../engine/soundEngine';
import { solveGeodesicArapMesh } from '../../engine/arapSolver';
import { prepareCharacterCanvas } from '../../engine/characterIntakeEngine';
import { renderConformingMeshAuto } from '../../engine/webglSkinnedRenderer';
import {
  encodeFramesToMp4WebCodecs,
  pickBestMediaRecorderFormat,
} from '../../engine/videoExportEngine';
import { runGifEncode } from '../../engine/paperWorkerClient';
import { evaluateDeterministicVerletRibbon } from '../../engine/verletPhysics';
import {
  analyzeCanvasAnatomy,
  createAnatomyPins,
  defaultDrawingAnatomy,
  drawCartoonMouth,
  evaluateCartoonDancePose,
  evaluateCartoonTalkPose,
  evaluateCartoonWorldPose,
  organicBreathCurve,
  renderMultiLayerRiggedCharacter,
  stepSpringPins,
  type ArticulatedCartoonPose,
  type CartoonMoodId,
  type CharacterLiveAnchors,
  type DanceLeapState,
  type DrawingAnatomy,
  type SpringPinState,
  type StorybookWorldId,
} from '../../engine/cartoonMotionEngine';
import {
  buildRiggedCharacterPack,
  buildRiggedCharacterPackAsync,
  type RiggedCharacterPack,
} from '../../engine/skeletonSkinEngine';
import {
  getCachedSampleHeroCanvas,
  preloadSampleHeroCanvas,
} from '../../engine/sampleHeroAsset';
import { drawStorybookWorldBackdrop, drawStorybookWorldForeground } from '../../engine/storybookWorlds';
import {
  recordAndEchoVoiceFx,
  recordSoundtrackVideo,
  type VoiceEffectId,
} from '../../engine/liveAudioStudio';
import {
  decodeSharedStage,
  encodeSharedStage,
  type ShareStrokeRecord,
  type StagePropId,
} from '../../engine/shareCodec';
import { useStudioStore } from '../../store/useStudioStore';
import { useT } from '../../i18n/translations';
import { getLiveDeviceProfile, reportRenderFrameTime } from '../../engine/deviceTierEngine';
import {
  countRigViews,
  createMasterRigFromFront,
  type CharacterMasterRig,
  type CharacterViewAngle,
  type RigViewSlot,
} from '../../types/masterRig';
import {
  alignViewCanvasToReference,
  assignItemsToViewAngles,
  extractViewAnchorsFromCanvas,
} from '../../engine/turnaroundSlicer';
import { MasterRigRuntimeCache, renderMasterRigCharacter } from '../../engine/viewRigBlender';
import { UNIVERSAL_CREATURE_CATALOG } from '../../engine/universalCreatureRig';
import CharacterMasterModal from '../rig/CharacterMasterModal';

export type AliveToyMode = 'dance' | 'talk' | 'film' | 'pull';

interface InstantAliveStageProps {
  theme: StudioTheme;
  lightboxDim: number;
  onLightboxDimChange: (val: number) => void;
  onSendToStudio: (
    sketchCanvas: HTMLCanvasElement,
    destination: 'draw' | 'puppet' | 'film',
    title?: string
  ) => Promise<void>;
  onOpenBlankDesk: () => void;
}

type StrokeRecord = ShareStrokeRecord;

interface DustPuff {
  x: number;
  y: number;
  vx: number;
  vy: number;
  bornSec: number;
  radius: number;
}

interface PuddleRipple {
  x: number;
  y: number;
  bornSec: number;
}

interface SparkBurst {
  x: number;
  y: number;
  bornSec: number;
}

interface FlingState {
  mode: 'idle' | 'grabbing' | 'flying' | 'dizzy';
  x: number;
  y: number;
  vx: number;
  vy: number;
  dizzyUntilSec: number;
  pointerStartX: number;
  pointerStartY: number;
  lastPx: number;
  lastPy: number;
  lastMs: number;
  movedPx: number;
}

interface BouncyBallState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  lastKickSec: number;
}

interface SurprisePrompt {
  id: string;
  tr: string;
  en: string;
  guide: 'cat' | 'robot' | 'hero' | 'ghost' | 'mushroom' | 'cloud';
}

const SURPRISE_PROMPTS: SurprisePrompt[] = [
  { id: 'cat', tr: 'Şemsiyeli şaşkın kedi', en: 'Surprised cat with umbrella', guide: 'cat' },
  { id: 'robot', tr: 'Kahvesini döken robot', en: 'Clumsy coffee robot', guide: 'robot' },
  { id: 'hero', tr: 'Pelerinli cesur çöp adam', en: 'Caped stickman hero', guide: 'hero' },
  { id: 'ghost', tr: 'Şapkalı neşeli hayalet', en: 'Happy ghost in a top hat', guide: 'ghost' },
  { id: 'mushroom', tr: 'Yağmurda dans eden mantar', en: 'Dancing rainy mushroom', guide: 'mushroom' },
  { id: 'cloud', tr: 'Güneş gözlüklü bulut', en: 'Cool cloud with shades', guide: 'cloud' },
];

const INK_SWATCHES = [
  { hex: '#1C1917', tr: 'Mürekkep', en: 'Ink' },
  { hex: '#E54D2E', tr: 'Kırmızı', en: 'Vermilion' },
  { hex: '#2563EB', tr: 'Mavi', en: 'Blue' },
  { hex: '#D99B26', tr: 'Altın', en: 'Gold' },
  { hex: '#16A34A', tr: 'Yeşil', en: 'Green' },
];

/** Draws a super-faint non-photo-blue drafting silhouette when a Surprise Prompt is active */
function drawGuideSilhouette(ctx: CanvasRenderingContext2D, guide: SurprisePrompt['guide']) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  ctx.strokeStyle = 'rgba(37, 99, 235, 0.17)';
  ctx.lineWidth = 4;
  ctx.setLineDash([12, 10]);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const cx = W / 2;
  const cy = H / 2 + 12;

  if (guide === 'cat') {
    ctx.beginPath();
    ctx.arc(cx, cy - 95, 72, 0, Math.PI * 2);
    ctx.moveTo(cx - 56, cy - 140);
    ctx.lineTo(cx - 70, cy - 205);
    ctx.lineTo(cx - 18, cy - 160);
    ctx.moveTo(cx + 56, cy - 140);
    ctx.lineTo(cx + 70, cy - 205);
    ctx.lineTo(cx + 18, cy - 160);
    ctx.ellipse(cx, cy + 55, 86, 105, 0, 0, Math.PI * 2);
    ctx.moveTo(cx + 76, cy + 120);
    ctx.bezierCurveTo(cx + 170, cy + 100, cx + 175, cy - 10, cx + 125, cy - 20);
    ctx.stroke();
  } else if (guide === 'robot') {
    ctx.strokeRect(cx - 82, cy - 195, 164, 118);
    ctx.strokeRect(cx - 96, cy - 60, 192, 168);
    ctx.beginPath();
    ctx.moveTo(cx, cy - 195);
    ctx.lineTo(cx, cy - 235);
    ctx.arc(cx, cy - 246, 12, 0, Math.PI * 2);
    ctx.moveTo(cx - 96, cy - 10);
    ctx.lineTo(cx - 168, cy + 40);
    ctx.moveTo(cx + 96, cy - 10);
    ctx.lineTo(cx + 168, cy + 32);
    ctx.moveTo(cx - 46, cy + 108);
    ctx.lineTo(cx - 46, cy + 195);
    ctx.moveTo(cx + 46, cy + 108);
    ctx.lineTo(cx + 46, cy + 195);
    ctx.stroke();
  } else if (guide === 'ghost') {
    ctx.beginPath();
    ctx.moveTo(cx - 105, cy + 150);
    ctx.lineTo(cx - 105, cy - 45);
    ctx.arc(cx, cy - 45, 105, Math.PI, 0, false);
    ctx.lineTo(cx + 105, cy + 150);
    ctx.quadraticCurveTo(cx + 70, cy + 112, cx + 35, cy + 150);
    ctx.quadraticCurveTo(cx, cy + 112, cx - 35, cy + 150);
    ctx.quadraticCurveTo(cx - 70, cy + 112, cx - 105, cy + 150);
    ctx.stroke();
    ctx.strokeRect(cx - 48, cy - 225, 96, 62);
    ctx.beginPath();
    ctx.moveTo(cx - 78, cy - 163);
    ctx.lineTo(cx + 78, cy - 163);
    ctx.stroke();
  } else if (guide === 'mushroom') {
    ctx.beginPath();
    ctx.arc(cx, cy - 35, 145, Math.PI, 0, false);
    ctx.closePath();
    ctx.stroke();
    ctx.beginPath();
    ctx.roundRect(cx - 58, cy - 35, 116, 175, 36);
    ctx.stroke();
  } else if (guide === 'cloud') {
    ctx.beginPath();
    ctx.arc(cx - 88, cy + 12, 72, Math.PI * 0.5, Math.PI * 1.65);
    ctx.arc(cx - 12, cy - 52, 92, Math.PI * 1.05, Math.PI * 1.95);
    ctx.arc(cx + 88, cy + 4, 76, Math.PI * 1.35, Math.PI * 0.5);
    ctx.closePath();
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(cx, cy - 140, 56, 0, Math.PI * 2);
    ctx.moveTo(cx, cy - 84);
    ctx.lineTo(cx, cy + 68);
    ctx.moveTo(cx - 125, cy - 35);
    ctx.lineTo(cx, cy - 52);
    ctx.lineTo(cx + 125, cy - 68);
    ctx.moveTo(cx, cy + 68);
    ctx.lineTo(cx - 72, cy + 195);
    ctx.moveTo(cx, cy + 68);
    ctx.lineTo(cx + 76, cy + 195);
    ctx.stroke();
  }
  ctx.restore();
}

/** Renders an optional raster sample underlay + vector strokes onto a 1280x720 canvas */
function paintStrokesOnCanvas(
  ctx: CanvasRenderingContext2D,
  strokes: StrokeRecord[],
  underlay?: HTMLCanvasElement | null
) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  if (underlay && underlay.width > 0 && underlay.height > 0) {
    const targetH = ctx.canvas.height * 0.78;
    const targetW = targetH * (underlay.width / underlay.height);
    const dx = (ctx.canvas.width - targetW) * 0.5;
    const dy = (ctx.canvas.height - targetH) * 0.52;
    ctx.drawImage(underlay, dx, dy, targetW, targetH);
  }
  for (const s of strokes) {
    if (s.points.length === 0) continue;
    ctx.save();
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (s.points.length === 1) {
      ctx.beginPath();
      ctx.arc(s.points[0].x, s.points[0].y, s.width * 0.5, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(s.points[0].x, s.points[0].y);
      for (let i = 1; i < s.points.length - 1; i++) {
        const midX = (s.points[i].x + s.points[i + 1].x) * 0.5;
        const midY = (s.points[i].y + s.points[i + 1].y) * 0.5;
        ctx.quadraticCurveTo(s.points[i].x, s.points[i].y, midX, midY);
      }
      const last = s.points[s.points.length - 1];
      ctx.lineTo(last.x, last.y);
      ctx.stroke();
    }
    ctx.restore();
  }
}

/** Crops drawn strokes tightly onto a crisp transparent actor canvas */
function cropSketchCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const sw = src.width;
  const sh = src.height;
  const sctx = src.getContext('2d');
  if (!sctx) return src;
  const data = sctx.getImageData(0, 0, sw, sh).data;
  let minX = sw;
  let minY = sh;
  let maxX = 0;
  let maxY = 0;
  for (let y = 0; y < sh; y += 2) {
    for (let x = 0; x < sw; x += 2) {
      if (data[(y * sw + x) * 4 + 3] > 24) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX <= minX || maxY <= minY) return src;
  const pad = Math.round(Math.max(maxX - minX, maxY - minY) * 0.08 + 16);
  const cx0 = Math.max(0, minX - pad);
  const cy0 = Math.max(0, minY - pad);
  const cw = Math.min(sw - cx0, maxX - minX + pad * 2);
  const ch = Math.min(sh - cy0, maxY - minY + pad * 2);

  const out = document.createElement('canvas');
  out.width = Math.max(96, cw);
  out.height = Math.max(96, ch);
  out.getContext('2d')!.drawImage(src, cx0, cy0, cw, ch, 0, 0, out.width, out.height);
  return out;
}

/** Builds a full RiggedCharacterPack directly from stroke records + optional raster sample (<12ms!) */
function buildPackFromStrokes(
  strokes: StrokeRecord[],
  underlay?: HTMLCanvasElement | null
): RiggedCharacterPack | null {
  if (strokes.length === 0 && !underlay) return null;
  // Pure raster mascot with no extra doodles on top: rig directly at native crisp resolution!
  if (strokes.length === 0 && underlay) {
    const anatomy: DrawingAnatomy = analyzeCanvasAnatomy(underlay);
    return buildRiggedCharacterPack(underlay, anatomy);
  }
  const off = document.createElement('canvas');
  off.width = 1280;
  off.height = 720;
  const octx = off.getContext('2d')!;
  paintStrokesOnCanvas(octx, strokes, underlay);
  const cropped = cropSketchCanvas(off);
  const anatomy: DrawingAnatomy = analyzeCanvasAnatomy(cropped);
  return buildRiggedCharacterPack(cropped, anatomy);
}

/** Off-main-thread Web Worker rig builder for zero UI jank on mobile phones & laptops */
async function buildPackFromStrokesAsync(
  strokes: StrokeRecord[],
  underlay?: HTMLCanvasElement | null
): Promise<RiggedCharacterPack | null> {
  if (strokes.length === 0 && !underlay) return null;
  if (strokes.length === 0 && underlay) {
    const anatomy: DrawingAnatomy = analyzeCanvasAnatomy(underlay);
    return buildRiggedCharacterPackAsync(underlay, anatomy);
  }
  const off = document.createElement('canvas');
  off.width = 1280;
  off.height = 720;
  const octx = off.getContext('2d')!;
  paintStrokesOnCanvas(octx, strokes, underlay);
  const cropped = cropSketchCanvas(off);
  const anatomy: DrawingAnatomy = analyzeCanvasAnatomy(cropped);
  return buildRiggedCharacterPackAsync(cropped, anatomy);
}

/** Generates a charming instant hand-drawn sketch so shy users feel cinema magic in 1 click */
function buildQuickSampleStrokes(): StrokeRecord[] {
  const strokes: StrokeRecord[] = [];
  const circle = (cx: number, cy: number, rx: number, ry: number, steps = 28) => {
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      pts.push({
        x: cx + Math.cos(a) * rx + Math.sin(i * 1.7) * 1.8,
        y: cy + Math.sin(a) * ry + Math.cos(i * 1.3) * 1.8,
      });
    }
    return pts;
  };

  strokes.push({ color: '#1C1917', width: 9, points: circle(640, 215, 68, 64) });
  strokes.push({
    color: '#E54D2E',
    width: 14,
    points: [
      { x: 562, y: 168 },
      { x: 598, y: 122 },
      { x: 668, y: 118 },
      { x: 722, y: 158 },
      { x: 650, y: 166 },
      { x: 572, y: 170 },
    ],
  });
  strokes.push({ color: '#1C1917', width: 12, points: [{ x: 616, y: 208 }, { x: 618, y: 218 }] });
  strokes.push({ color: '#1C1917', width: 12, points: [{ x: 664, y: 208 }, { x: 666, y: 218 }] });
  strokes.push({
    color: '#1C1917',
    width: 7,
    points: [
      { x: 616, y: 242 },
      { x: 642, y: 256 },
      { x: 668, y: 240 },
    ],
  });
  strokes.push({
    color: '#1C1917',
    width: 10,
    points: [
      { x: 604, y: 286 },
      { x: 582, y: 452 },
      { x: 698, y: 452 },
      { x: 676, y: 286 },
      { x: 604, y: 286 },
    ],
  });
  strokes.push({
    color: '#E54D2E',
    width: 14,
    points: [
      { x: 602, y: 288 },
      { x: 640, y: 294 },
      { x: 678, y: 288 },
    ],
  });
  strokes.push({
    color: '#1C1917',
    width: 9,
    points: [
      { x: 594, y: 318 },
      { x: 534, y: 344 },
      { x: 496, y: 296 },
    ],
  });
  strokes.push({
    color: '#1C1917',
    width: 9,
    points: [
      { x: 686, y: 318 },
      { x: 746, y: 342 },
      { x: 786, y: 284 },
    ],
  });
  strokes.push({
    color: '#1C1917',
    width: 10,
    points: [
      { x: 614, y: 454 },
      { x: 598, y: 572 },
      { x: 568, y: 580 },
    ],
  });
  strokes.push({
    color: '#1C1917',
    width: 10,
    points: [
      { x: 668, y: 454 },
      { x: 684, y: 572 },
      { x: 718, y: 580 },
    ],
  });
  return strokes;
}

/** Charming instant 2nd Buddy (cute bipedal cat-friend with pointy ears & blue bow!) */
function buildQuickBuddyStrokes(): StrokeRecord[] {
  const strokes: StrokeRecord[] = [];
  const circle = (cx: number, cy: number, rx: number, ry: number, steps = 26) => {
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      pts.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry });
    }
    return pts;
  };
  strokes.push({ color: '#1C1917', width: 9, points: circle(640, 224, 62, 56) });
  strokes.push({
    color: '#1C1917',
    width: 9,
    points: [{ x: 586, y: 186 }, { x: 578, y: 132 }, { x: 622, y: 168 }],
  });
  strokes.push({
    color: '#1C1917',
    width: 9,
    points: [{ x: 658, y: 168 }, { x: 702, y: 132 }, { x: 694, y: 186 }],
  });
  strokes.push({ color: '#1C1917', width: 11, points: [{ x: 618, y: 218 }, { x: 620, y: 226 }] });
  strokes.push({ color: '#1C1917', width: 11, points: [{ x: 662, y: 218 }, { x: 664, y: 226 }] });
  strokes.push({
    color: '#1C1917',
    width: 7,
    points: [{ x: 622, y: 244 }, { x: 640, y: 254 }, { x: 658, y: 244 }],
  });
  strokes.push({
    color: '#1C1917',
    width: 10,
    points: [
      { x: 604, y: 286 },
      { x: 586, y: 446 },
      { x: 694, y: 446 },
      { x: 676, y: 286 },
      { x: 604, y: 286 },
    ],
  });
  strokes.push({
    color: '#2563EB',
    width: 14,
    points: [{ x: 604, y: 290 }, { x: 640, y: 298 }, { x: 676, y: 290 }],
  });
  strokes.push({ color: '#1C1917', width: 9, points: [{ x: 594, y: 320 }, { x: 536, y: 344 }, { x: 506, y: 304 }] });
  strokes.push({ color: '#1C1917', width: 9, points: [{ x: 686, y: 320 }, { x: 744, y: 342 }, { x: 774, y: 300 }] });
  strokes.push({ color: '#1C1917', width: 10, points: [{ x: 614, y: 448 }, { x: 602, y: 564 }, { x: 574, y: 572 }] });
  strokes.push({ color: '#1C1917', width: 10, points: [{ x: 666, y: 448 }, { x: 678, y: 564 }, { x: 706, y: 572 }] });
  return strokes;
}

/**
 * Smart Cartoon Umbrella Renderer:
 * - On humanoid rigs: attaches outward at the live right hand (+14px) angled gently away from the face (NEVER slices eyes/ears!)
 * - On abstract/single-line doodles (!useMultiPart): floats cleanly centered above the doodle's own top crown (NEVER drifts onto Buddy!)
 */
function drawSmartCartoonUmbrella(
  ctx: CanvasRenderingContext2D,
  pack: RiggedCharacterPack,
  anchors: CharacterLiveAnchors,
  bounds: { x: number; y: number; w: number; h: number },
  tSec: number,
  tiltRad: number,
  isRainy: boolean
) {
  ctx.save();
  if (pack.useMultiPart) {
    // Automatically hold umbrella in the FREE hand if the right hand already carries a drawn rigid prop (e.g. Baron's cane!)
    const useLeftHand = Boolean(pack.skinnedMesh?.rightHasRigidProp && !pack.skinnedMesh?.leftHasRigidProp);
    const handPt = useLeftHand ? anchors.handLeftScreen : anchors.handRightScreen;
    const hx = handPt.x + (useLeftHand ? -8 : 10);
    const hy = Math.max(156, handPt.y);
    ctx.translate(hx, hy);
    ctx.rotate(tiltRad * 0.45 + (useLeftHand ? 0.16 : -0.18) + Math.sin(tSec * 2.4) * 0.04);
  } else {
    // Centered cleanly above abstract doodle's own top crown (NEVER drifts onto Buddy or clips top!)
    const topX = bounds.x + bounds.w * 0.5;
    const topY = Math.max(158, Math.min(bounds.y + bounds.h * 0.55, anchors.headTopScreen.y + 44));
    ctx.translate(topX + 16, topY);
    ctx.rotate(tiltRad * 0.35 - 0.1 + Math.sin(tSec * 2.4) * 0.04);
  }

  ctx.strokeStyle = '#6B4226';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(0, 10);
  ctx.lineTo(0, -96);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(-5.5, 10, 5.5, 0, Math.PI);
  ctx.stroke();

  const domeY = -92;
  const r = 56;
  ctx.fillStyle = '#D9432C';
  ctx.strokeStyle = '#1C1917';
  ctx.lineWidth = 2.8;
  ctx.beginPath();
  ctx.arc(0, domeY, r, Math.PI, 0);
  ctx.quadraticCurveTo(r * 0.5, domeY - 11, 0, domeY);
  ctx.quadraticCurveTo(-r * 0.5, domeY - 11, -r, domeY);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#FAF2DE';
  ctx.beginPath();
  ctx.moveTo(0, domeY - r);
  ctx.quadraticCurveTo(20, domeY - r * 0.5, 20, domeY - 4);
  ctx.quadraticCurveTo(0, domeY - 10, -20, domeY - 4);
  ctx.quadraticCurveTo(-20, domeY - r * 0.5, 0, domeY - r);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  if (isRainy) {
    ctx.strokeStyle = 'rgba(220, 240, 255, 0.72)';
    ctx.lineWidth = 1.4;
    for (let d = 0; d < 4; d++) {
      const dp = (tSec * 3.2 + d * 0.27) % 1;
      const sx = (d - 1.5) * 22 + (d % 2 === 0 ? 1 : -1) * dp * 11;
      const sy = domeY - r + 10 + Math.abs(d - 1.5) * 7 - Math.sin(dp * Math.PI) * 13;
      ctx.globalAlpha = 1 - dp;
      ctx.beginPath();
      ctx.arc(sx, sy, 1.5, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** Draws a wide billowing physical Verlet superhero cape (or flowing red scarf) behind the character */
function drawFlowingFabric(
  ctx: CanvasRenderingContext2D,
  anchorX: number,
  anchorY: number,
  windX: number,
  tSec: number,
  groundY: number,
  drawH: number,
  style: 'scarf' | 'cape',
  color = '#E54D2E'
) {
  const nodes = evaluateDeterministicVerletRibbon({
    anchorX,
    anchorY,
    windX: windX - Math.sin(tSec * 2.5) * 0.25,
    timeSec: tSec,
    floorY: groundY + 4,
    segmentLength: Math.max(style === 'cape' ? 16 : 12, drawH * (style === 'cape' ? 0.105 : 0.062)),
    nodeCount: 8,
  });

  ctx.save();
  if (style === 'cape') {
    const topPts: { x: number; y: number }[] = [];
    const botPts: { x: number; y: number }[] = [];
    const collarSpread = Math.max(14, drawH * 0.085);
    for (let i = 0; i < nodes.length; i++) {
      const u = i / (nodes.length - 1);
      const halfW = collarSpread + u * Math.max(24, drawH * 0.14);
      const shoulderLift = (1 - u) * (1 - u) * drawH * 0.04;
      topPts.push({ x: nodes[i].x, y: nodes[i].y - halfW * 0.36 - shoulderLift });
      botPts.push({ x: nodes[i].x, y: nodes[i].y + halfW * 0.82 - shoulderLift * 0.4 });
    }
    ctx.fillStyle = color;
    ctx.strokeStyle = '#F6C65B';
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.moveTo(topPts[0].x, topPts[0].y);
    for (let i = 1; i < topPts.length; i++) ctx.lineTo(topPts[i].x, topPts[i].y);
    for (let i = botPts.length - 1; i >= 0; i--) ctx.lineTo(botPts[i].x, botPts[i].y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else {
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(7, drawH * 0.042);
    ctx.beginPath();
    ctx.moveTo(nodes[0].x, nodes[0].y);
    for (let i = 1; i < nodes.length - 1; i++) {
      const mx = (nodes[i].x + nodes[i + 1].x) * 0.5;
      const my = (nodes[i].y + nodes[i + 1].y) * 0.5;
      ctx.quadraticCurveTo(nodes[i].x, nodes[i].y, mx, my);
    }
    ctx.lineTo(nodes[nodes.length - 1].x, nodes[nodes.length - 1].y);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255, 224, 152, 0.55)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.restore();
}

function drawDizzyStars(ctx: CanvasRenderingContext2D, headTop: { x: number; y: number }, tSec: number) {
  ctx.save();
  for (let i = 0; i < 3; i++) {
    const a = tSec * 5.2 + (i * Math.PI * 2) / 3;
    const sx = headTop.x + Math.cos(a) * 28;
    const sy = headTop.y - 16 + Math.sin(a) * 9;
    ctx.fillStyle = i % 2 === 0 ? '#F6C445' : '#FFF7D1';
    ctx.strokeStyle = '#1C1917';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (let k = 0; k < 10; k++) {
      const r = k % 2 === 0 ? 7.5 : 3.2;
      const ka = (k * Math.PI) / 5 + tSec * 3;
      if (k === 0) ctx.moveTo(sx + Math.cos(ka) * r, sy + Math.sin(ka) * r);
      else ctx.lineTo(sx + Math.cos(ka) * r, sy + Math.sin(ka) * r);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function drawSparkBursts(ctx: CanvasRenderingContext2D, bursts: SparkBurst[], tSec: number) {
  for (const b of bursts) {
    const age = tSec - b.bornSec;
    if (age < 0 || age > 0.48) continue;
    const u = age / 0.48;
    ctx.save();
    ctx.globalAlpha = 1 - u;
    ctx.strokeStyle = '#F6C445';
    ctx.lineWidth = 2.8;
    ctx.lineCap = 'round';
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.3;
      const r0 = 8 + u * 16;
      const r1 = 18 + u * 36;
      ctx.beginPath();
      ctx.moveTo(b.x + Math.cos(a) * r0, b.y + Math.sin(a) * r0);
      ctx.lineTo(b.x + Math.cos(a) * r1, b.y + Math.sin(a) * r1);
      ctx.stroke();
    }
    ctx.restore();
  }
}

function drawBouncyBall(ctx: CanvasRenderingContext2D, ball: BouncyBallState, floorY: number) {
  const r = 19;
  const h = Math.max(0, floorY - ball.y);
  const shScale = Math.max(0.35, 1 - h / 260);
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.beginPath();
  ctx.ellipse(ball.x, floorY + 2, r * 0.9 * shScale, 5 * shScale, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.translate(ball.x, ball.y);
  ctx.rotate(ball.rot);
  ctx.fillStyle = '#FFF9EC';
  ctx.strokeStyle = '#1C1917';
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.clip();
  ctx.fillStyle = '#E54D2E';
  ctx.beginPath();
  ctx.arc(-r * 0.55, -r * 0.25, r * 0.72, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#2563EB';
  ctx.beginPath();
  ctx.arc(r * 0.65, r * 0.45, r * 0.65, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.translate(ball.x, ball.y);
  ctx.strokeStyle = '#1C1917';
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/** Computes safe non-overlapping display dimensions for an actor in Solo or Duet mode! */
function fitActorSize(pack: RiggedCharacterPack, W: number, H: number, isDuet: boolean, maxHRatio: number): { w: number; h: number } {
  const aspect = pack.filledCanvas.width / Math.max(1, pack.filledCanvas.height);
  const maxH = Math.min(H * maxHRatio, isDuet ? 270 : 300);
  // Strict per-lane width cap in Duet mode (W * 0.28) guarantees ZERO overlap even for wide squiggles!
  const maxW = isDuet ? W * 0.28 : W * 0.42;
  let drawH = maxH;
  let drawW = drawH * aspect;
  if (drawW > maxW) {
    drawW = maxW;
    drawH = Math.max(84, drawW / Math.max(0.2, aspect));
  }
  return { w: drawW, h: drawH };
}

/**
 * Shared Feature-Film Quality Frame Renderer:
 * ZERO-KOPMA Continuous Skinning + Strict Duet Non-Overlap Lanes + 5 Worlds + Live Cinema Surprises + Props + Fling!
 */
function renderAliveToyFrame(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  pack: RiggedCharacterPack,
  buddyPack: RiggedCharacterPack | null,
  toy: AliveToyMode,
  world: StorybookWorldId,
  mood: CartoonMoodId,
  prop: StagePropId,
  tSec: number,
  opts: {
    cadenceFps: 12 | 24;
    leap: DanceLeapState;
    buddyHopUntilSec: number;
    filmSurpriseUntilSec: number;
    fling: FlingState;
    ball: BouncyBallState;
    voiceAmp: number;
    voicePeakDelta: number;
    lookX: number;
    lookY: number;
    pullTarget: 'hero' | 'buddy';
    pins: MeshPin[];
    offsets: MeshFrameOffsets;
    draggingPinId: string | null;
    dustPuffs: DustPuff[];
    ripples: PuddleRipple[];
    sparks: SparkBurst[];
    paperColor: string;
    playFoley?: boolean;
    isGifExport?: boolean;
    masterRigCache?: MasterRigRuntimeCache | null;
    heroYawDeg?: number;
  }
) {
  const anatomy = pack.anatomy;
  const isDuet = Boolean(buddyPack);
  const boilTick = Math.floor(tSec * 8);
  const boil = (seed: number) => Math.sin(boilTick * 19.3 + seed * 7.1);

  if (toy === 'film') {
    ctx.save();
    const metrics = drawStorybookWorldBackdrop(ctx, world, W, H, tSec, opts.lookX, opts.lookY, mood);
    const surpriseAge = opts.filmSurpriseUntilSec - tSec;
    const surpriseActive = surpriseAge > 0;
    const surpriseEnv = surpriseActive ? Math.sin((1 - surpriseAge / 0.65) * Math.PI) : 0;
    const effectiveLightning = Math.max(metrics.lightningFlash, world === 'rainy' ? surpriseEnv * 0.9 : 0);

    if (metrics.cameraShakeX !== 0 || metrics.cameraShakeY !== 0) {
      ctx.translate(metrics.cameraShakeX, metrics.cameraShakeY);
    }

    const groundY = metrics.groundY;
    const sz1 = fitActorSize(pack, W, H, isDuet, 0.54);
    const driftSpeed = mood === 'sprint' || world === 'escape' ? 1.1 : mood === 'sneak' ? 0.35 : 0.58;
    const driftX = Math.sin(tSec * driftSpeed) * (W * 0.045) - opts.lookX * 28;
    const heroCenterX = (isDuet ? W * 0.33 : W * 0.49) + driftX;

    const pose1 = evaluateCartoonWorldPose(world, tSec, anatomy, opts.cadenceFps, mood, effectiveLightning);
    if (surpriseActive && world !== 'rainy') {
      pose1.hipLiftY += surpriseEnv * 0.16;
      pose1.leftArmAngle += surpriseEnv * 0.4;
      pose1.rightArmAngle += surpriseEnv * 0.4;
      if (world === 'space') pose1.torsoLeanRad += surpriseEnv * 0.9;
    }

    const bounds1 = {
      x: heroCenterX - sz1.w * anatomy.centerX,
      y: groundY - sz1.h * anatomy.groundV,
      w: sz1.w,
      h: sz1.h,
    };

    let pose2: ArticulatedCartoonPose | null = null;
    let bounds2: { x: number; y: number; w: number; h: number } | null = null;
    if (buddyPack) {
      const sz2 = fitActorSize(buddyPack, W, H, true, 0.51);
      const bCenterX = W * 0.68 + driftX;
      pose2 = evaluateCartoonWorldPose(world, tSec + 0.38, buddyPack.anatomy, opts.cadenceFps, mood, effectiveLightning);
      if (surpriseActive && world !== 'rainy') {
        pose2.hipLiftY += surpriseEnv * 0.15;
      }
      bounds2 = {
        x: bCenterX - sz2.w * buddyPack.anatomy.centerX,
        y: groundY - sz2.h * buddyPack.anatomy.groundV,
        w: sz2.w,
        h: sz2.h,
      };
    }

    if (metrics.hasPuddle) {
      const drawRef = (p: RiggedCharacterPack, ps: ArticulatedCartoonPose, bd: { x: number; y: number; w: number; h: number }) => {
        ctx.save();
        ctx.translate(0, groundY + 4);
        ctx.scale(1, -0.44);
        ctx.translate(0, -groundY);
        ctx.globalAlpha = 0.4;
        renderMultiLayerRiggedCharacter(ctx, p, ps, bd, {
          boilTick,
          nightLampPos: metrics.lampPos,
          isReflection: true,
        });
        ctx.restore();
      };
      if (buddyPack && pose2 && bounds2) drawRef(buddyPack, pose2, bounds2);
      drawRef(pack, pose1, bounds1);

      ctx.save();
      ctx.strokeStyle = 'rgba(205, 224, 255, 0.22)';
      ctx.lineWidth = 1.3;
      for (let rl = 0; rl < 3; rl++) {
        const ry = groundY + 14 + rl * 15;
        const sway = Math.sin(tSec * 4.2 + rl * 1.7) * 7;
        ctx.beginPath();
        ctx.moveTo(heroCenterX - sz1.w * 0.4 + sway, ry);
        ctx.lineTo((isDuet ? W * 0.68 + driftX : heroCenterX) + sz1.w * 0.4 + sway, ry);
        ctx.stroke();
      }
      ctx.restore();
    }

    if (world !== 'space') {
      const drawShadow = (cx: number, w: number, lift: number) => {
        const s = Math.max(0.55, 1 - lift * 2.2);
        ctx.fillStyle = metrics.isDark ? 'rgba(0,0,0,0.44)' : 'rgba(28, 42, 18, 0.24)';
        ctx.beginPath();
        ctx.ellipse(cx, groundY + 4, w * 0.36 * s, 9 * s, 0, 0, Math.PI * 2);
        ctx.fill();
      };
      if (buddyPack && pose2 && bounds2) {
        drawShadow(bounds2.x + bounds2.w * buddyPack.anatomy.centerX, bounds2.w, pose2.hipLiftY);
      }
      drawShadow(heroCenterX, sz1.w, pose1.hipLiftY);
    }

    if (!opts.isGifExport && metrics.hasPuddle) {
      for (const rp of opts.ripples) {
        const age = tSec - rp.bornSec;
        if (age < 0 || age > 0.72) continue;
        const p = age / 0.72;
        ctx.save();
        ctx.strokeStyle = `rgba(220, 238, 255, ${(0.55 * (1 - p)).toFixed(2)})`;
        ctx.lineWidth = 1.9;
        ctx.beginPath();
        ctx.ellipse(rp.x, rp.y + 2, 10 + p * 40, 3.5 + p * 12, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }

    const drawActorInWorld = (
      p: RiggedCharacterPack,
      ps: ArticulatedCartoonPose,
      bd: { x: number; y: number; w: number; h: number },
      fabricColor: string,
      isHero: boolean
    ): CharacterLiveAnchors => {
      const nx = bd.x + p.anatomy.neckX * bd.w + ps.hipShiftX * bd.w;
      const ny = bd.y + p.anatomy.neckY * bd.h - ps.hipLiftY * bd.h + (1 - ps.squashY) * bd.h * 0.25;
      // Opt-in cape only — never force an unwanted red scarf onto uploaded user drawings!
      const fabricMode = prop === 'cape' ? 'cape' : null;
      if (fabricMode) {
        drawFlowingFabric(ctx, nx, ny, metrics.windX, tSec + (isHero ? 0 : 0.4), groundY, bd.h, fabricMode, fabricColor);
      }
      const useMultiViewHero = isHero && opts.masterRigCache && opts.masterRigCache.getAvailableAngles().length >= 2;
      const anc = useMultiViewHero
        ? renderMasterRigCharacter(ctx, opts.masterRigCache!, p, ps, bd, {
            boilTick,
            nightLampPos: metrics.isDark ? metrics.lampPos : null,
            smearVelX: mood === 'sprint' || world === 'escape' ? 1.15 : 0,
            yawDeg: opts.heroYawDeg ?? (ps.facing < 0 ? -75 : 75),
          }).anchors
        : renderMultiLayerRiggedCharacter(ctx, p, ps, bd, {
            boilTick,
            nightLampPos: metrics.isDark ? metrics.lampPos : null,
            smearVelX: mood === 'sprint' || world === 'escape' ? 1.15 : 0,
          });
      if (ps.mouthOpen > 0.15) {
        drawCartoonMouth(
          ctx,
          anc.mouthScreen.x,
          anc.mouthScreen.y,
          p.anatomy.mouthScale * (bd.w / 215),
          ps.viseme,
          ps.mouthOpen,
          ps.headTiltRad
        );
      }
      if (prop === 'umbrella' && isHero) {
        drawSmartCartoonUmbrella(ctx, p, anc, bd, tSec, ps.torsoLeanRad, world === 'rainy');
      } else if (world === 'rainy') {
        ctx.save();
        ctx.strokeStyle = 'rgba(220, 238, 255, 0.55)';
        ctx.lineWidth = 1.3;
        for (let d = 0; d < 3; d++) {
          const dp = (tSec * 2.8 + d * 0.33 + (isHero ? 0 : 0.5)) % 1;
          const side = d === 1 ? -1 : 1;
          const dx = anc.headTopScreen.x + side * (6 + dp * 18) + (d - 1) * 9;
          const dy = anc.headTopScreen.y - Math.sin(dp * Math.PI) * 14;
          ctx.globalAlpha = 1 - dp;
          ctx.beginPath();
          ctx.arc(dx, dy, 1.5, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.restore();
      }
      return anc;
    };

    if (buddyPack && pose2 && bounds2) {
      drawActorInWorld(buddyPack, pose2, bounds2, '#2563EB', false);
    }
    const anchors1 = drawActorInWorld(pack, pose1, bounds1, '#E54D2E', true);

    if (prop === 'ball' && !opts.isGifExport) {
      drawBouncyBall(ctx, opts.ball, groundY);
    }

    if (!opts.isGifExport && pose1.footContact && world !== 'space') {
      const footPt = pose1.contactSide <= 0 ? anchors1.footLeftScreen : anchors1.footRightScreen;
      const last = opts.ripples[opts.ripples.length - 1];
      if (!last || tSec - last.bornSec > 0.18) {
        if (metrics.hasPuddle) {
          opts.ripples.push({ x: footPt.x, y: groundY + 2, bornSec: tSec });
          if (opts.ripples.length > 8) opts.ripples.shift();
        }
        if (opts.playFoley) soundEngine.footstep(metrics.hasPuddle);
      }
    }

    drawSparkBursts(ctx, opts.sparks, tSec);
    drawStorybookWorldForeground(ctx, world, W, H, tSec, effectiveLightning);
    ctx.restore();
    return;
  }

  // Warm backlit ivory paper sheet for Dance, Talk, and Pull modes!
  ctx.fillStyle = opts.paperColor;
  ctx.fillRect(0, 0, W, H);

  const spot = ctx.createRadialGradient(W * 0.5, H * 0.48, 30, W * 0.5, H * 0.5, W * 0.62);
  spot.addColorStop(0, 'rgba(255, 252, 242, 0.65)');
  spot.addColorStop(1, 'rgba(218, 206, 184, 0.25)');
  ctx.fillStyle = spot;
  ctx.fillRect(0, 0, W, H);

  const floorY = H * 0.82;
  ctx.save();
  ctx.strokeStyle = 'rgba(28, 25, 23, 0.16)';
  ctx.lineWidth = 2.4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(W * 0.12, floorY + boil(1) * 0.6);
  ctx.quadraticCurveTo(W * 0.5, floorY + 3 + boil(2) * 0.7, W * 0.88, floorY + boil(3) * 0.6);
  ctx.stroke();
  ctx.restore();

  const heroSz = fitActorSize(pack, W, H, isDuet, 0.56);

  if (toy === 'pull') {
    const activePack = opts.pullTarget === 'buddy' && buddyPack ? buddyPack : pack;
    const passivePack = buddyPack ? (opts.pullTarget === 'buddy' ? pack : buddyPack) : null;
    const activeSz = fitActorSize(activePack, W, H, isDuet, 0.56);
    const activeX = isDuet ? (opts.pullTarget === 'buddy' ? W * 0.68 : W * 0.32) : W * 0.5;
    const dstX0 = activeX - activeSz.w * activePack.anatomy.centerX;
    const dstY0 = floorY - activeSz.h * activePack.anatomy.groundV;
    const breath = organicBreathCurve(tSec * 0.32);

    // Passive buddy stays visible & alive watching beside the stretched character (NEVER vanishes!)
    if (passivePack) {
      const pSz = fitActorSize(passivePack, W, H, true, 0.52);
      const pX = opts.pullTarget === 'buddy' ? W * 0.32 : W * 0.68;
      const pPose = evaluateCartoonDancePose(tSec * 0.7, null, opts.cadenceFps, 'cool');
      pPose.facing = pX < activeX ? 1 : -1;
      ctx.fillStyle = 'rgba(28, 25, 23, 0.11)';
      ctx.beginPath();
      ctx.ellipse(pX, floorY + 2, pSz.w * 0.34, 10, 0, 0, Math.PI * 2);
      ctx.fill();
      renderMultiLayerRiggedCharacter(
        ctx,
        passivePack,
        pPose,
        { x: pX - pSz.w * passivePack.anatomy.centerX, y: floorY - pSz.h * passivePack.anatomy.groundV, w: pSz.w, h: pSz.h },
        { boilTick }
      );
    }

    ctx.fillStyle = 'rgba(28, 25, 23, 0.13)';
    ctx.beginPath();
    ctx.ellipse(activeX, floorY + 2, activeSz.w * 0.38, 12, 0, 0, Math.PI * 2);
    ctx.fill();

    const liveOffsets: MeshFrameOffsets = {};
    for (const pin of opts.pins) {
      const uo = opts.offsets[pin.id];
      const breatheY = pin.role === 'head' ? -breath * 0.014 : pin.role === 'root' ? -breath * 0.008 : 0;
      const gifSway = opts.isGifExport && pin.role === 'head' ? Math.sin(tSec * Math.PI * 2) * 0.08 : 0;
      liveOffsets[pin.id] = { dx: (uo?.dx ?? 0) + gifSway, dy: (uo?.dy ?? 0) + breatheY };
    }

    const solvedPins = new Map<string, { x: number; y: number }>();
    const rootPin = opts.pins.find((p) => p.role === 'root');
    const headPin = opts.pins.find((p) => p.role === 'head');
    const handLPin = opts.pins.find((p) => p.role === 'hand-l');
    const handRPin = opts.pins.find((p) => p.role === 'hand-r');
    const footLPin = opts.pins.find((p) => p.role === 'foot-l');
    const footRPin = opts.pins.find((p) => p.role === 'foot-r');

    if (
      activePack.useMultiPart &&
      activePack.skinnedMesh &&
      rootPin &&
      headPin &&
      handLPin &&
      handRPin &&
      footLPin &&
      footRPin
    ) {
      // ZERO-WEBBING WebGL2 Conforming Skinned Mesh Pull Mode (rigid cane, rigid face, smooth 2-Bone IK!)
      const rO = liveOffsets[rootPin.id] ?? { dx: 0, dy: 0 };
      const hO = liveOffsets[headPin.id] ?? { dx: 0, dy: 0 };
      const hlO = liveOffsets[handLPin.id] ?? { dx: 0, dy: 0 };
      const hrO = liveOffsets[handRPin.id] ?? { dx: 0, dy: 0 };
      const flO = liveOffsets[footLPin.id] ?? { dx: 0, dy: 0 };
      const frO = liveOffsets[footRPin.id] ?? { dx: 0, dy: 0 };
      const relHx = hO.dx - rO.dx;
      const relHy = hO.dy - rO.dy;
      const sqY = Math.max(0.88, Math.min(1.14, 1 - relHy * 1.25));
      const skel = activePack.skinnedMesh;
      const pullPose: ArticulatedCartoonPose = {
        hipShiftX: rO.dx,
        hipLiftY: -rO.dy,
        squashY: sqY,
        squashX: 1 / sqY,
        torsoLeanRad: Math.max(-0.28, Math.min(0.28, relHx * 1.1)),
        chestCounterRad: -relHx * 0.2,
        headTiltRad: Math.max(-0.34, Math.min(0.34, relHx * 1.35)),
        headLagY: relHy * 0.25,
        headTurnX: Math.max(-1, Math.min(1, relHx * 3.0)),
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
      };
      const hLRest = skel.bones.length >= 17 ? skel.bones[14].end : skel.bones[4].end;
      const hRRest = skel.bones.length >= 17 ? skel.bones[16].end : skel.bones[6].end;
      const fLRest = skel.footLeft?.ball ?? skel.bones[8].end;
      const fRRest = skel.footRight?.ball ?? skel.bones[10].end;
      const fLDy = Math.abs(flO.dy) < 0.004 && rO.dy > 0.008 ? 0 : flO.dy;
      const fRDy = Math.abs(frO.dy) < 0.004 && rO.dy > 0.008 ? 0 : frO.dy;
      const anc = renderMultiLayerRiggedCharacter(
        ctx,
        activePack,
        pullPose,
        { x: dstX0, y: dstY0, w: activeSz.w, h: activeSz.h },
        {
          boilTick,
          ikOverrides: {
            handLeft: {
              x: dstX0 + (hLRest.x + hlO.dx) * activeSz.w,
              y: dstY0 + (hLRest.y + hlO.dy) * activeSz.h,
            },
            handRight: {
              x: dstX0 + (hRRest.x + hrO.dx) * activeSz.w,
              y: dstY0 + (hRRest.y + hrO.dy) * activeSz.h,
            },
            footLeft: {
              x: dstX0 + (fLRest.x + flO.dx) * activeSz.w,
              y: dstY0 + (fLRest.y + fLDy) * activeSz.h,
            },
            footRight: {
              x: dstX0 + (fRRest.x + frO.dx) * activeSz.w,
              y: dstY0 + (fRRest.y + fRDy) * activeSz.h,
            },
            headOffset: { x: relHx * activeSz.w * 0.22, y: relHy * activeSz.h * 0.22 },
          },
        }
      );
      solvedPins.set(rootPin.id, anc.pelvisScreen);
      solvedPins.set(headPin.id, { x: anc.headTopScreen.x, y: anc.headTopScreen.y + activeSz.h * 0.1 });
      solvedPins.set(handLPin.id, anc.handLeftScreen);
      solvedPins.set(handRPin.id, anc.handRightScreen);
      solvedPins.set(footLPin.id, anc.footLeftScreen);
      solvedPins.set(footRPin.id, anc.footRightScreen);
    } else if (activePack.silhouetteMesh) {
      // V3 Zero-Merging Geodesic ARAP Solver for quadrupeds, ghosts, doodles & custom pins!
      const silMesh = activePack.silhouetteMesh;
      const arap = solveGeodesicArapMesh(silMesh, opts.pins, liveOffsets, {
        drawX: dstX0,
        drawY: dstY0,
        drawW: activeSz.w,
        drawH: activeSz.h,
      });
      renderConformingMeshAuto(ctx, activePack.filledCanvas, silMesh, arap.positions);
    } else {
      ctx.drawImage(activePack.filledCanvas, dstX0, dstY0, activeSz.w, activeSz.h);
    }

    if (!opts.isGifExport) {
      for (const pin of opts.pins) {
        const off = liveOffsets[pin.id];
        const sp = solvedPins.get(pin.id);
        const px = sp ? sp.x : dstX0 + (pin.x + (off?.dx ?? 0)) * activeSz.w;
        const py = sp ? sp.y : dstY0 + (pin.y + (off?.dy ?? 0)) * activeSz.h;
        const isDragging = opts.draggingPinId === pin.id;
        ctx.save();
        ctx.fillStyle = isDragging ? '#E54D2E' : 'rgba(217, 155, 38, 0.94)';
        ctx.strokeStyle = '#FAF6EE';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(px, py, isDragging ? 11 : 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    }
    return;
  }

  if (toy === 'talk') {
    const heroX = isDuet ? W * 0.33 : W * 0.5;
    const pose1 = evaluateCartoonTalkPose(tSec, opts.voiceAmp, opts.voicePeakDelta, opts.cadenceFps);
    const bounds1 = {
      x: heroX - heroSz.w * anatomy.centerX,
      y: floorY - heroSz.h * anatomy.groundV,
      w: heroSz.w,
      h: heroSz.h,
    };

    if (pose1.mouthOpen > 0.14) {
      ctx.save();
      for (let ring = 0; ring < 2; ring++) {
        const rad = heroSz.w * 0.42 + ((tSec * 125 + ring * 52) % 86);
        const fade = Math.max(0, 1 - (rad - heroSz.w * 0.42) / 92);
        ctx.strokeStyle = `rgba(229, 77, 46, ${(0.28 * pose1.mouthOpen * fade).toFixed(2)})`;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(heroX, floorY - heroSz.h * (1 - anatomy.headCenterY), rad, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    ctx.fillStyle = 'rgba(28, 25, 23, 0.13)';
    ctx.beginPath();
    ctx.ellipse(heroX + pose1.hipShiftX * heroSz.w, floorY + 2, heroSz.w * 0.36, 11, 0, 0, Math.PI * 2);
    ctx.fill();

    const anc1 = renderMultiLayerRiggedCharacter(ctx, pack, pose1, bounds1, { boilTick });
    drawCartoonMouth(
      ctx,
      anc1.mouthScreen.x,
      anc1.mouthScreen.y,
      anatomy.mouthScale * (heroSz.w / 210),
      pose1.viseme,
      pose1.mouthOpen,
      pose1.headTiltRad + pose1.torsoLeanRad * 0.45
    );

    if (buddyPack) {
      const bSz = fitActorSize(buddyPack, W, H, true, 0.53);
      const bX = W * 0.68;
      const buddyVoice =
        opts.voiceAmp < 0.18
          ? Math.max(0, Math.sin(tSec * 7.4) * 0.55 + 0.15) * (Math.sin(tSec * 1.9) > 0.1 ? 1 : 0)
          : 0;
      const pose2 = evaluateCartoonTalkPose(tSec + 0.7, buddyVoice, buddyVoice * 0.2, opts.cadenceFps);
      pose2.facing = -1;
      if (opts.voiceAmp >= 0.18) {
        pose2.headTiltRad = Math.sin(tSec * 5.2) * 0.09;
      }
      ctx.fillStyle = 'rgba(28, 25, 23, 0.12)';
      ctx.beginPath();
      ctx.ellipse(bX, floorY + 2, bSz.w * 0.34, 10, 0, 0, Math.PI * 2);
      ctx.fill();
      const anc2 = renderMultiLayerRiggedCharacter(
        ctx,
        buddyPack,
        pose2,
        { x: bX - bSz.w * buddyPack.anatomy.centerX, y: floorY - bSz.h * buddyPack.anatomy.groundV, w: bSz.w, h: bSz.h },
        { boilTick }
      );
      drawCartoonMouth(
        ctx,
        anc2.mouthScreen.x,
        anc2.mouthScreen.y,
        buddyPack.anatomy.mouthScale * (bSz.w / 210),
        pose2.viseme,
        pose2.mouthOpen,
        pose2.headTiltRad
      );
    }
    return;
  }

  // Default: 'dance' — Strict Non-Overlapping Duet Lanes + Grab & Fling + Buddy Tap Hop + Props!
  const fling = opts.fling;
  const leap = opts.leap;
  let curX = leap.currentX;
  let extraLiftPx = 0;
  let smearX = mood === 'sprint' ? 1.15 : 0;
  let pose = evaluateCartoonDancePose(tSec, leap.active ? leap : null, opts.cadenceFps, mood);

  if (fling.mode === 'grabbing' || fling.mode === 'flying') {
    curX = fling.x;
    extraLiftPx = Math.max(0, floorY - fling.y);
    smearX = fling.mode === 'flying' ? fling.vx / 420 : 0;
    pose = {
      ...pose,
      hipLiftY: extraLiftPx / Math.max(1, heroSz.h),
      torsoLeanRad: Math.max(-0.48, Math.min(0.48, fling.vx * 0.00075)),
      leftArmAngle: 0.78 + Math.sin(tSec * 16) * 0.25,
      rightArmAngle: 0.78 + Math.cos(tSec * 16) * 0.25,
      leftLegStride: Math.sin(tSec * 15) * 0.55,
      rightLegStride: -Math.sin(tSec * 15) * 0.55,
      leftFootLift: 0.65,
      rightFootLift: 0.65,
      mouthOpen: 0.65,
      viseme: 'OH',
      facing: fling.vx < -40 ? -1 : 1,
    };
  } else {
    if (leap.active) {
      const leapDur = 0.86;
      const age = tSec - leap.startSec;
      if (age >= 0 && age < leapDur) {
        const p = age / leapDur;
        if (p >= 0.18 && p <= 0.76) {
          const u = (p - 0.18) / 0.58;
          curX = leap.fromX + (leap.toX - leap.fromX) * u;
          smearX = ((leap.toX - leap.fromX) / 220) * Math.sin(u * Math.PI);
        } else if (p > 0.76) {
          curX = leap.toX;
        } else {
          curX = leap.fromX;
        }
      }
    }
    if (fling.mode === 'dizzy' && tSec < fling.dizzyUntilSec) {
      pose.headTiltRad = Math.sin(tSec * 12) * 0.22;
      pose.torsoLeanRad = Math.sin(tSec * 7) * 0.09;
    }
  }

  const bounds = {
    x: curX - heroSz.w * anatomy.centerX,
    y: floorY - heroSz.h * anatomy.groundV,
    w: heroSz.w,
    h: heroSz.h,
  };

  let buddyAnc: CharacterLiveAnchors | null = null;
  if (buddyPack) {
    const bSz = fitActorSize(buddyPack, W, H, true, 0.52);
    const bX = W * 0.68;
    const bPose = evaluateCartoonDancePose(tSec + 0.22, null, opts.cadenceFps, mood);
    bPose.facing = curX < bX ? -1 : 1;
    const bHopAge = opts.buddyHopUntilSec - tSec;
    if (bHopAge > 0) {
      const hEnv = Math.sin((1 - bHopAge / 0.55) * Math.PI);
      bPose.hipLiftY += hEnv * 0.24;
      bPose.leftArmAngle += hEnv * 0.45;
      bPose.rightArmAngle += hEnv * 0.45;
    }
    ctx.fillStyle = 'rgba(28, 25, 23, 0.12)';
    ctx.beginPath();
    ctx.ellipse(bX, floorY + 2, bSz.w * 0.34, 10, 0, 0, Math.PI * 2);
    ctx.fill();
    if (prop === 'cape') {
      const bNeckY = floorY - bSz.h * (1 - buddyPack.anatomy.neckY) - bPose.hipLiftY * bSz.h;
      drawFlowingFabric(ctx, bX, bNeckY, 0.7, tSec + 0.3, floorY, bSz.h * 0.85, 'cape', '#2563EB');
    }
    buddyAnc = renderMultiLayerRiggedCharacter(
      ctx,
      buddyPack,
      bPose,
      { x: bX - bSz.w * buddyPack.anatomy.centerX, y: floorY - bSz.h * buddyPack.anatomy.groundV, w: bSz.w, h: bSz.h },
      { boilTick }
    );
  }

  const shadowScale = Math.max(0.35, 1 - pose.hipLiftY * 1.4);
  ctx.fillStyle = `rgba(28, 25, 23, ${(0.16 * shadowScale).toFixed(3)})`;
  ctx.beginPath();
  ctx.ellipse(curX + pose.hipShiftX * heroSz.w, floorY + 2, heroSz.w * 0.38 * shadowScale, 11 * shadowScale, 0, 0, Math.PI * 2);
  ctx.fill();

  if (leap.active && !opts.isGifExport && fling.mode === 'idle') {
    ctx.save();
    ctx.strokeStyle = 'rgba(229, 77, 46, 0.24)';
    ctx.lineWidth = 2.4;
    ctx.setLineDash([7, 7]);
    ctx.beginPath();
    const midX = (leap.fromX + leap.toX) * 0.5;
    ctx.moveTo(leap.fromX, floorY - 12);
    ctx.quadraticCurveTo(midX, floorY - heroSz.h * 0.72, leap.toX, floorY - 12);
    ctx.stroke();
    ctx.restore();
  }

  if (prop === 'cape') {
    const heroNeckX = bounds.x + anatomy.neckX * heroSz.w + pose.hipShiftX * heroSz.w;
    const heroNeckY = bounds.y + anatomy.neckY * heroSz.h - pose.hipLiftY * heroSz.h;
    drawFlowingFabric(
      ctx,
      heroNeckX,
      heroNeckY,
      smearX < -0.1 ? 1.3 : -1.1,
      tSec,
      floorY,
      heroSz.h * 0.92,
      'cape',
      '#E54D2E'
    );
  }

  const useMultiViewDance = opts.masterRigCache && opts.masterRigCache.getAvailableAngles().length >= 2;
  const heroAnc = useMultiViewDance
    ? renderMasterRigCharacter(ctx, opts.masterRigCache!, pack, pose, bounds, {
        boilTick,
        smearVelX: smearX,
        yawDeg: opts.heroYawDeg ?? Math.max(-95, Math.min(95, opts.lookX * 95)),
      }).anchors
    : renderMultiLayerRiggedCharacter(ctx, pack, pose, bounds, {
        boilTick,
        smearVelX: smearX,
      });

  if (pose.mouthOpen > 0.15) {
    drawCartoonMouth(
      ctx,
      heroAnc.mouthScreen.x,
      heroAnc.mouthScreen.y,
      anatomy.mouthScale * (heroSz.w / 210),
      pose.viseme,
      pose.mouthOpen,
      pose.headTiltRad
    );
  }

  if (prop === 'umbrella') {
    drawSmartCartoonUmbrella(ctx, pack, heroAnc, bounds, tSec, pose.torsoLeanRad, false);
  }

  if (fling.mode === 'dizzy' && tSec < fling.dizzyUntilSec) {
    drawDizzyStars(ctx, heroAnc.headTopScreen, tSec);
  }

  if (buddyAnc && !opts.isGifExport) {
    const dist = Math.hypot(
      heroAnc.handRightScreen.x - buddyAnc.handLeftScreen.x,
      heroAnc.handRightScreen.y - buddyAnc.handLeftScreen.y
    );
    const lastSpark = opts.sparks[opts.sparks.length - 1];
    if (dist < 48 && (!lastSpark || tSec - lastSpark.bornSec > 1.2)) {
      opts.sparks.push({
        x: (heroAnc.handRightScreen.x + buddyAnc.handLeftScreen.x) * 0.5,
        y: (heroAnc.handRightScreen.y + buddyAnc.handLeftScreen.y) * 0.5,
        bornSec: tSec,
      });
      if (opts.playFoley) soundEngine.highFive();
    }
  }

  if (prop === 'ball' && !opts.isGifExport) {
    drawBouncyBall(ctx, opts.ball, floorY);
  }

  drawSparkBursts(ctx, opts.sparks, tSec);

  if (!opts.isGifExport) {
    for (const puff of opts.dustPuffs) {
      const age = tSec - puff.bornSec;
      if (age < 0 || age > 0.52) continue;
      const u = age / 0.52;
      const px = puff.x + puff.vx * age * (1 - u * 0.45);
      const py = puff.y + puff.vy * age * (1 - u * 0.5);
      ctx.save();
      ctx.globalAlpha = (1 - u) * 0.65;
      ctx.fillStyle = '#E7DEC8';
      ctx.strokeStyle = '#6B6256';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(px, py, puff.radius * (0.7 + u * 0.85), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }
}

export function InstantAliveStage({
  theme,
  lightboxDim,
  onSendToStudio,
  onOpenBlankDesk,
}: InstantAliveStageProps) {
  const t = useT();
  const locale = useStudioStore((s) => s.locale);
  const notify = useStudioStore((s) => s.notify);
  const performancePref = useStudioStore((s) => s.performancePref);

  const [phase, setPhase] = useState<'draw' | 'alive'>('draw');
  const [drawTarget, setDrawTarget] = useState<'hero' | 'buddy'>('hero');
  const [toy, setToy] = useState<AliveToyMode>('dance');
  const [world, setWorld] = useState<StorybookWorldId>('rainy');
  const [mood, setMood] = useState<CartoonMoodId>('natural');
  const [prop, setProp] = useState<StagePropId>('none');
  const [voiceFx, setVoiceFx] = useState<VoiceEffectId>('natural');
  const [echoPhase, setEchoPhase] = useState<'idle' | 'recording' | 'playing'>('idle');
  const [hasBuddy, setHasBuddy] = useState(false);
  const [pullTarget, setPullTarget] = useState<'hero' | 'buddy'>('hero');
  const [cadenceFps, setCadenceFps] = useState<12 | 24>(12);
  const [inkColor, setInkColor] = useState('#1C1917');
  const [nibBold, setNibBold] = useState(false);
  const [strokeCount, setStrokeCount] = useState(0);
  const [ghostDismissed, setGhostDismissed] = useState(false);
  const [promptIdx, setPromptIdx] = useState<number | null>(null);
  const [gifExporting, setGifExporting] = useState(false);
  const [videoExporting, setVideoExporting] = useState(false);
  const [sendingStudio, setSendingStudio] = useState(false);
  const [micActive, setMicActive] = useState(false);
  const [micFallback, setMicFallback] = useState(false);
  const [liveAudioBar, setLiveAudioBar] = useState(0);
  const [dragOverUpload, setDragOverUpload] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  const drawCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const guideCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const aliveCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const heroStrokesRef = useRef<StrokeRecord[]>([]);
  const heroUnderlayRef = useRef<HTMLCanvasElement | null>(null);
  const buddyStrokesRef = useRef<StrokeRecord[]>([]);
  const activeStrokeRef = useRef<StrokeRecord | null>(null);
  const drawingRef = useRef(false);
  const lastPtRef = useRef<{ x: number; y: number } | null>(null);

  const rigPackRef = useRef<RiggedCharacterPack | null>(null);
  const buddyPackRef = useRef<RiggedCharacterPack | null>(null);
  const masterRigCacheRef = useRef<MasterRigRuntimeCache | null>(null);
  const [heroMasterRig, setHeroMasterRig] = useState<CharacterMasterRig | null>(null);
  const [masterModalOpen, setMasterModalOpen] = useState(false);
  const [multiViewHintDismissed, setMultiViewHintDismissed] = useState(false);
  const [heroYawManual, setHeroYawManual] = useState<number | null>(null);
  const heroYawManualRef = useRef<number | null>(null);
  heroYawManualRef.current = heroYawManual;

  const leapRef = useRef<DanceLeapState>({
    active: false,
    startSec: -10,
    fromX: 480,
    toX: 480,
    currentX: 480,
    facing: 1,
  });
  const buddyHopUntilRef = useRef(-10);
  const filmSurpriseUntilRef = useRef(-10);
  const flingRef = useRef<FlingState>({
    mode: 'idle',
    x: 480,
    y: 442,
    vx: 0,
    vy: 0,
    dizzyUntilSec: -10,
    pointerStartX: 0,
    pointerStartY: 0,
    lastPx: 0,
    lastPy: 0,
    lastMs: 0,
    movedPx: 0,
  });
  const ballRef = useRef<BouncyBallState>({ x: 640, y: 120, vx: -165, vy: 0, rot: 0, lastKickSec: -10 });
  const lookRef = useRef({ x: 0, y: 0, tx: 0, ty: 0 });
  const pinsRef = useRef<MeshPin[]>(createAnatomyPins(defaultDrawingAnatomy()));
  const springsRef = useRef<Record<string, SpringPinState>>({});
  const offsetsRef = useRef<MeshFrameOffsets>({});
  const draggingPinRef = useRef<string | null>(null);
  const dustPuffsRef = useRef<DustPuff[]>([]);
  const ripplesRef = useRef<PuddleRipple[]>([]);
  const sparksRef = useRef<SparkBurst[]>([]);
  const smoothVoiceRef = useRef(0);
  const echoVoiceLevelRef = useRef(0);
  const aliveStartPerfRef = useRef(0);

  const micStreamRef = useRef<MediaStream | null>(null);
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const micCtxRef = useRef<AudioContext | null>(null);
  const micDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const micHeardSoundRef = useRef(false);
  const hydratedHashRef = useRef<string | null>(null);

  const getActiveStrokes = useCallback(
    () => (drawTarget === 'buddy' ? buddyStrokesRef.current : heroStrokesRef.current),
    [drawTarget]
  );

  const activePrompt = promptIdx !== null ? SURPRISE_PROMPTS[promptIdx] : null;

  const redrawAllStrokes = useCallback(() => {
    const c = drawCanvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    paintStrokesOnCanvas(
      ctx,
      getActiveStrokes(),
      drawTarget === 'hero' ? heroUnderlayRef.current : null
    );
  }, [getActiveStrokes, drawTarget]);

  // Warm-preload official Baron mascot asset on mount so "Örnek Çiz" & empty "CANLANDIR" feel 0ms instant!
  useEffect(() => {
    void preloadSampleHeroCanvas();
  }, []);

  // Keep Hero lane centered cleanly in Solo mode (480) and Left Lane in Duet mode (312)!
  const repositionHeroForLane = useCallback((duetActive: boolean) => {
    const targetX = duetActive ? 312 : 480;
    leapRef.current = {
      active: false,
      startSec: -10,
      fromX: targetX,
      toX: targetX,
      currentX: targetX,
      facing: 1,
    };
    flingRef.current.x = targetX;
    flingRef.current.mode = 'idle';
  }, []);

  // --- Auto-load Shared Remix Link (`#kagit=...`) cleanly ONCE on mount ($0 serverless!) ---
  useEffect(() => {
    const hydrateFromHash = () => {
      if (typeof window === 'undefined') return;
      const rawHash = window.location.hash;
      if (!rawHash.startsWith('#kagit=')) return;
      if (hydratedHashRef.current === rawHash) return;
      const decoded = decodeSharedStage(rawHash);
      if (!decoded) return;
      hydratedHashRef.current = rawHash;
      heroStrokesRef.current = decoded.strokes;
      const pack = buildPackFromStrokes(decoded.strokes);
      if (!pack) return;
      rigPackRef.current = pack;
      pinsRef.current = createAnatomyPins(pack.anatomy);
      const duet = Boolean(decoded.buddyStrokes && decoded.buddyStrokes.length > 0);
      if (duet && decoded.buddyStrokes) {
        buddyStrokesRef.current = decoded.buddyStrokes;
        const bPack = buildPackFromStrokes(decoded.buddyStrokes);
        buddyPackRef.current = bPack;
        setHasBuddy(Boolean(bPack));
        repositionHeroForLane(Boolean(bPack));
      } else {
        buddyStrokesRef.current = [];
        buddyPackRef.current = null;
        setHasBuddy(false);
        repositionHeroForLane(false);
      }
      setStrokeCount(decoded.strokes.length);
      setToy(decoded.toy);
      setWorld(decoded.world);
      setMood(decoded.mood);
      setProp(decoded.prop);
      setVoiceFx(decoded.voiceFx);
      setPhase('alive');
      const curLocale = useStudioStore.getState().locale;
      useStudioStore
        .getState()
        .notify(
          duet
            ? curLocale === 'en'
              ? 'Friend duo scene loaded — hit Draw 2nd to add yourself!'
              : 'Arkadaşının 2 karakterli filmi açıldı — 2.\'yi Çiz ile kendini ekleyebilirsin!'
            : curLocale === 'en'
              ? 'Friend scene loaded — hit + Buddy to join in!'
              : 'Arkadaşının çizgi filmi açıldı — + Arkadaş ile yanına katıl!'
        );
    };
    hydrateFromHash();
    window.addEventListener('hashchange', hydrateFromHash);
    return () => window.removeEventListener('hashchange', hydrateFromHash);
  }, [repositionHeroForLane]);

  useEffect(() => {
    if (phase === 'draw') {
      const hasUnderlay = drawTarget === 'hero' && Boolean(heroUnderlayRef.current);
      setStrokeCount(getActiveStrokes().length + (hasUnderlay ? 1 : 0));
      redrawAllStrokes();
    }
  }, [phase, drawTarget, getActiveStrokes, redrawAllStrokes]);

  useEffect(() => {
    const gc = guideCanvasRef.current;
    if (!gc) return;
    const gctx = gc.getContext('2d');
    if (!gctx) return;
    if (!activePrompt || drawTarget === 'buddy') {
      gctx.clearRect(0, 0, gc.width, gc.height);
      return;
    }
    drawGuideSilhouette(gctx, activePrompt.guide);
  }, [activePrompt, phase, drawTarget]);

  const stopMic = useCallback(() => {
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((tr) => tr.stop());
      micStreamRef.current = null;
    }
    if (micCtxRef.current) {
      void micCtxRef.current.close().catch(() => {});
      micCtxRef.current = null;
    }
    micAnalyserRef.current = null;
    micDataRef.current = null;
    micHeardSoundRef.current = false;
    setMicActive(false);
  }, []);

  useEffect(() => {
    if (phase !== 'alive' || toy !== 'talk') {
      stopMic();
      setMicFallback(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('no-mic');
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cancelled) {
          stream.getTracks().forEach((tr) => tr.stop());
          return;
        }
        const AC =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AC) throw new Error('no-ac');
        const ctx = new AC();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        micStreamRef.current = stream;
        micCtxRef.current = ctx;
        micAnalyserRef.current = analyser;
        micDataRef.current = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
        setMicActive(true);
        setMicFallback(false);
      } catch {
        if (!cancelled) {
          setMicActive(false);
          setMicFallback(true);
        }
      }
    })();
    return () => {
      cancelled = true;
      stopMic();
    };
  }, [phase, toy, stopMic]);

  // Refresh pins cleanly when switching Pull target between Hero & Buddy
  useEffect(() => {
    const active = pullTarget === 'buddy' && buddyPackRef.current ? buddyPackRef.current : rigPackRef.current;
    if (!active) return;
    pinsRef.current = createAnatomyPins(active.anatomy);
    springsRef.current = {};
    offsetsRef.current = {};
  }, [pullTarget, hasBuddy]);

  // 60 FPS Live Animation & Physics Loop
  useEffect(() => {
    if (phase !== 'alive') return;
    let raf = 0;
    const t0 = performance.now();
    aliveStartPerfRef.current = t0;
    let prevNow = t0;
    let lastBarUpdate = 0;

    const spawnDust = (x: number, y: number, tSec: number, count = 5) => {
      for (let i = 0; i < count; i++) {
        dustPuffsRef.current.push({
          x: x + (Math.random() - 0.5) * 32,
          y: y - 4,
          vx: (Math.random() - 0.5) * 95,
          vy: -30 - Math.random() * 55,
          bornSec: tSec,
          radius: 7 + Math.random() * 6,
        });
      }
      if (dustPuffsRef.current.length > 22) dustPuffsRef.current.splice(0, 6);
    };

    let lastRenderAt = 0;
    const loop = (now: number) => {
      const profile = getLiveDeviceProfile(performancePref);
      const minIntervalMs = profile.targetFps >= 55 ? 0 : 1000 / profile.targetFps;
      if (minIntervalMs > 0 && now - lastRenderAt < minIntervalMs) {
        raf = requestAnimationFrame(loop);
        return;
      }
      lastRenderAt = now;
      const frameRenderStart = performance.now();
      const dtSec = Math.min(0.05, Math.max(0.004, (now - prevNow) / 1000));
      prevNow = now;

      const c = aliveCanvasRef.current;
      const pack = rigPackRef.current;
      if (c && pack) {
        const ctx = c.getContext('2d');
        if (ctx) {
          const tSec = (now - t0) / 1000;
          const floorY = toy === 'film' ? c.height * 0.77 : c.height * 0.82;

          lookRef.current.x += (lookRef.current.tx - lookRef.current.x) * 0.1;
          lookRef.current.y += (lookRef.current.ty - lookRef.current.y) * 0.1;

          const fl = flingRef.current;
          if (toy === 'dance' && fl.mode === 'flying') {
            fl.vy += 1550 * dtSec;
            fl.x += fl.vx * dtSec;
            fl.y += fl.vy * dtSec;

            if (fl.x < 110) {
              fl.x = 110;
              fl.vx = Math.abs(fl.vx) * 0.68;
              soundEngine.boing(1.1);
            } else if (fl.x > c.width - 110) {
              fl.x = c.width - 110;
              fl.vx = -Math.abs(fl.vx) * 0.68;
              soundEngine.boing(1.1);
            }
            if (fl.y < 120) {
              fl.y = 120;
              fl.vy = Math.abs(fl.vy) * 0.55;
            }
            if (fl.y >= floorY) {
              fl.y = floorY;
              if (Math.abs(fl.vy) > 220) {
                fl.vy = -Math.abs(fl.vy) * 0.44;
                fl.vx *= 0.74;
                spawnDust(fl.x, floorY, tSec, 6);
                soundEngine.softThump();
              } else {
                fl.vy = 0;
                fl.vx = 0;
                fl.mode = 'dizzy';
                fl.dizzyUntilSec = tSec + 1.15;
                leapRef.current.currentX = fl.x;
                leapRef.current.toX = fl.x;
                spawnDust(fl.x, floorY, tSec, 6);
                soundEngine.softThump();
              }
            }
          } else if (fl.mode === 'dizzy' && tSec >= fl.dizzyUntilSec) {
            fl.mode = 'idle';
          }

          if (prop === 'ball' && (toy === 'dance' || toy === 'film')) {
            const b = ballRef.current;
            b.vy += 980 * dtSec;
            b.x += b.vx * dtSec;
            b.y += b.vy * dtSec;
            b.rot += (b.vx / 22) * dtSec;

            if (b.x < 36) {
              b.x = 36;
              b.vx = Math.abs(b.vx) * 0.9;
            } else if (b.x > c.width - 36) {
              b.x = c.width - 36;
              b.vx = -Math.abs(b.vx) * 0.9;
            }
            if (b.y > floorY - 19) {
              b.y = floorY - 19;
              b.vy = -Math.max(360, Math.abs(b.vy) * 0.82);
            }
            const kickTargets = buddyPackRef.current
              ? [toy === 'dance' ? leapRef.current.currentX : c.width * 0.33, c.width * 0.68]
              : [toy === 'dance' ? leapRef.current.currentX : c.width * 0.49];
            for (const tx of kickTargets) {
              if (Math.abs(b.x - tx) < 58 && b.y > floorY - 170 && tSec - b.lastKickSec > 0.34) {
                b.vy = -520 - Math.random() * 140;
                b.vx = (b.x >= tx ? 1 : -1) * (210 + Math.random() * 130);
                b.lastKickSec = tSec;
                sparksRef.current.push({ x: b.x, y: b.y, bornSec: tSec });
                soundEngine.boing(1.28);
                break;
              }
            }
          }

          if (toy === 'pull') {
            offsetsRef.current = stepSpringPins(pinsRef.current, springsRef.current, draggingPinRef.current, dtSec);
          }

          let rawVoice = 0;
          if (toy === 'talk') {
            if (echoVoiceLevelRef.current > 0.01) {
              // Live Talking-Tom funny voice echo playback drives exact lipsync!
              rawVoice = echoVoiceLevelRef.current;
            } else {
              let liveMic = 0;
              if (micAnalyserRef.current && micDataRef.current) {
                micAnalyserRef.current.getByteTimeDomainData(micDataRef.current);
                let sum = 0;
                for (let i = 0; i < micDataRef.current.length; i++) {
                  const v = (micDataRef.current[i] - 128) / 128;
                  sum += v * v;
                }
                liveMic = Math.min(1, Math.sqrt(sum / micDataRef.current.length) * 5.2);
              }
              if (liveMic > 0.03) micHeardSoundRef.current = true;
              if (micHeardSoundRef.current && micAnalyserRef.current) {
                rawVoice = liveMic;
              } else {
                const phrase = (tSec % 2.15) / 2.15;
                const speaking = phrase < 0.72 ? Math.sin((phrase / 0.72) * Math.PI) : 0;
                const syllables = 0.25 + 0.75 * Math.pow(Math.abs(Math.sin(tSec * 9.8 + Math.sin(tSec * 3.1))), 1.3);
                rawVoice = speaking * syllables;
              }
            }
            if (now - lastBarUpdate > 75) {
              lastBarUpdate = now;
              setLiveAudioBar(rawVoice);
            }
          }

          const prevSmooth = smoothVoiceRef.current;
          const alpha = rawVoice > prevSmooth ? 0.36 : 0.16;
          smoothVoiceRef.current = prevSmooth + (rawVoice - prevSmooth) * alpha;
          const peakDelta = Math.max(0, rawVoice - prevSmooth);

          const lp = leapRef.current;
          if (lp.active && tSec - lp.startSec >= 0.86) {
            lp.currentX = lp.toX;
            lp.active = false;
            spawnDust(lp.toX, floorY, tSec, 5);
            soundEngine.softThump();
          }

          renderAliveToyFrame(ctx, c.width, c.height, pack, buddyPackRef.current, toy, world, mood, prop, tSec, {
            cadenceFps,
            leap: lp,
            buddyHopUntilSec: buddyHopUntilRef.current,
            filmSurpriseUntilSec: filmSurpriseUntilRef.current,
            fling: fl,
            ball: ballRef.current,
            voiceAmp: smoothVoiceRef.current,
            voicePeakDelta: peakDelta,
            lookX: lookRef.current.x,
            lookY: lookRef.current.y,
            pullTarget,
            pins: pinsRef.current,
            offsets: offsetsRef.current,
            draggingPinId: draggingPinRef.current,
            dustPuffs: dustPuffsRef.current,
            ripples: ripplesRef.current,
            sparks: sparksRef.current,
            paperColor: '#F7F3E9',
            playFoley: true,
            masterRigCache: masterRigCacheRef.current,
            heroYawDeg: heroYawManualRef.current ?? undefined,
          });
          reportRenderFrameTime(performance.now() - frameRenderStart);
        }
      }
      raf = requestAnimationFrame(loop);
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [phase, toy, world, mood, prop, cadenceFps, pullTarget, performancePref]);

  // --- Drawing Handlers ---
  const toCanvasCoords = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = drawCanvasRef.current!;
    const r = c.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / Math.max(1, r.width)) * c.width,
      y: ((e.clientY - r.top) / Math.max(1, r.height)) * c.height,
    };
  };

  const onDrawDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setGhostDismissed(true);
    const pt = toCanvasCoords(e);
    drawingRef.current = true;
    lastPtRef.current = pt;
    const stroke: StrokeRecord = { color: inkColor, width: nibBold ? 18 : 10, points: [pt] };
    activeStrokeRef.current = stroke;
    const list = getActiveStrokes();
    list.push(stroke);
    const hasUnderlay = drawTarget === 'hero' && Boolean(heroUnderlayRef.current);
    setStrokeCount(list.length + (hasUnderlay ? 1 : 0));
    soundEngine.pencilScratch(0.8);
    redrawAllStrokes();
  };

  const onDrawMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current || !activeStrokeRef.current) return;
    const pt = toCanvasCoords(e);
    const prev = lastPtRef.current ?? pt;
    const dist = Math.hypot(pt.x - prev.x, pt.y - prev.y);
    if (dist < 2.2) return;
    activeStrokeRef.current.points.push(pt);
    lastPtRef.current = pt;
    soundEngine.pencilScratch(dist / 14);
    redrawAllStrokes();
  };

  const onDrawUp = () => {
    drawingRef.current = false;
    activeStrokeRef.current = null;
    lastPtRef.current = null;
  };

  const handleUndo = () => {
    const list = getActiveStrokes();
    if (list.length > 0) {
      soundEngine.click(0.92);
      list.pop();
      const hasUnderlay = drawTarget === 'hero' && Boolean(heroUnderlayRef.current);
      setStrokeCount(list.length + (hasUnderlay ? 1 : 0));
      redrawAllStrokes();
      return;
    }
    if (drawTarget === 'hero' && heroUnderlayRef.current) {
      soundEngine.click(0.92);
      heroUnderlayRef.current = null;
      setStrokeCount(0);
      redrawAllStrokes();
    }
  };

  const handleClear = () => {
    soundEngine.paperFlip();
    if (drawTarget === 'buddy') {
      buddyStrokesRef.current = [];
    } else {
      heroStrokesRef.current = [];
      heroUnderlayRef.current = null;
    }
    setStrokeCount(0);
    redrawAllStrokes();
  };

  const handleSurpriseIdea = () => {
    soundEngine.click(1.16);
    setPromptIdx((prev) => (prev === null ? 0 : (prev + 1) % SURPRISE_PROMPTS.length));
  };

  const handleQuickSample = async () => {
    soundEngine.paperFlip();
    setGhostDismissed(true);
    setPromptIdx(null);
    if (drawTarget === 'buddy') {
      buddyStrokesRef.current = buildQuickBuddyStrokes();
      setStrokeCount(buddyStrokesRef.current.length);
      redrawAllStrokes();
      return;
    }
    const mascot = getCachedSampleHeroCanvas() ?? (await preloadSampleHeroCanvas());
    if (mascot) {
      heroUnderlayRef.current = mascot;
      heroStrokesRef.current = [];
      setStrokeCount(1);
    } else {
      heroUnderlayRef.current = null;
      heroStrokesRef.current = buildQuickSampleStrokes();
      setStrokeCount(heroStrokesRef.current.length);
    }
    redrawAllStrokes();
  };

  const handleAnimateNow = async () => {
    setGhostDismissed(true);
    let list = getActiveStrokes();
    let underlay = drawTarget === 'hero' ? heroUnderlayRef.current : null;
    // Zero-friction magic: clicking CANLANDIR on an empty sheet loads our official Baron mascot and animates immediately!
    if (list.length === 0 && !underlay) {
      if (drawTarget === 'buddy') {
        buddyStrokesRef.current = buildQuickBuddyStrokes();
        list = buddyStrokesRef.current;
        setStrokeCount(list.length);
      } else {
        const mascot = getCachedSampleHeroCanvas() ?? (await preloadSampleHeroCanvas());
        if (mascot) {
          heroUnderlayRef.current = mascot;
          underlay = mascot;
          setStrokeCount(1);
        } else {
          heroStrokesRef.current = buildQuickSampleStrokes();
          list = heroStrokesRef.current;
          setStrokeCount(list.length);
        }
      }
    }
    const pack = await buildPackFromStrokesAsync(list, underlay);
    if (!pack) return;

    if (drawTarget === 'buddy') {
      buddyPackRef.current = pack;
      setHasBuddy(true);
      repositionHeroForLane(true);
      setDrawTarget('hero');
      soundEngine.highFive();
      setPhase('alive');
      return;
    }

    rigPackRef.current = pack;
    pinsRef.current = createAnatomyPins(pack.anatomy);
    springsRef.current = {};
    offsetsRef.current = {};
    dustPuffsRef.current = [];
    ripplesRef.current = [];
    sparksRef.current = [];
    repositionHeroForLane(Boolean(buddyPackRef.current));
    soundEngine.magicAwaken();
    setMood('natural');
    setToy('dance');
    setPhase('alive');
  };

  // --- Direct Homepage Photo / Drawing Upload (1 Photo OR 2–4 Multi-Angle Photos!) + Drag-and-Drop + Ctrl+V Paste! ---
  const handleUploadImageFiles = useCallback(
    async (rawFiles: File[]) => {
      const files = rawFiles.filter((f) => f.type.startsWith('image/')).slice(0, 4);
      if (files.length === 0) return;

      const decodePreparedFile = async (file: File) => {
        const url = URL.createObjectURL(file);
        try {
          const img = await new Promise<HTMLImageElement>((resolve, reject) => {
            const el = new Image();
            el.onload = () => resolve(el);
            el.onerror = reject;
            el.src = url;
          });
          return prepareCharacterCanvas(img, { maxDim: 768, stripPaper: true });
        } finally {
          URL.revokeObjectURL(url);
        }
      };

      try {
        // Multi-photo 2.5D path (2..4 separate angle photos selected or dropped together!)
        if (files.length >= 2 && drawTarget !== 'buddy') {
          const mapped = assignItemsToViewAngles(files, { requireFront: true });
          const decoded: Array<{ angle: CharacterViewAngle; canvas: HTMLCanvasElement }> = [];
          for (const entry of mapped) {
            const prep = await decodePreparedFile(entry.item);
            if (!prep.empty) decoded.push({ angle: entry.angle, canvas: prep.canvas });
          }
          if (decoded.length === 0) {
            notify(
              locale === 'en'
                ? 'Could not detect drawings in these photos — try clearer ink!'
                : 'Bu fotoğraflarda çizim algılanamadı — daha net çizimler dene!',
              'error'
            );
            return;
          }

          const frontEntry = decoded.find((d) => d.angle === 'front') ?? decoded[0];
          const anatomy = analyzeCanvasAnatomy(frontEntry.canvas);
          const pack = await buildRiggedCharacterPackAsync(frontEntry.canvas, anatomy);
          const frontAnchors = extractViewAnchorsFromCanvas(pack.filledCanvas);
          const baseRig = createMasterRigFromFront(
            pack.filledCanvas.toDataURL('image/png'),
            pack.creatureClass,
            'Karakter',
            frontAnchors,
            pack.filledCanvas.width,
            pack.filledCanvas.height
          );
          const views: Partial<Record<CharacterViewAngle, RigViewSlot>> = { ...baseRig.views };
          for (const d of decoded) {
            if (d === frontEntry) continue;
            const slotAngle: CharacterViewAngle = d.angle === 'front' ? 'side' : d.angle;
            views[slotAngle] = alignViewCanvasToReference(
              d.canvas,
              frontAnchors,
              slotAngle,
              'original_drawing',
              512
            );
          }
          const fullRig: CharacterMasterRig = { ...baseRig, views, updatedAt: Date.now() };

          heroStrokesRef.current = [];
          heroUnderlayRef.current = frontEntry.canvas;
          setStrokeCount(1);
          setGhostDismissed(true);
          rigPackRef.current = pack;
          pinsRef.current = createAnatomyPins(pack.anatomy);
          springsRef.current = {};
          offsetsRef.current = {};
          dustPuffsRef.current = [];
          ripplesRef.current = [];
          sparksRef.current = [];
          setHeroYawManual(null);
          setHeroMasterRig(fullRig);
          setMultiViewHintDismissed(true);
          useStudioStore.getState().setActiveMasterRig(fullRig);
          if (!masterRigCacheRef.current) {
            masterRigCacheRef.current = new MasterRigRuntimeCache(fullRig);
          } else {
            masterRigCacheRef.current.syncRig(fullRig);
          }
          masterRigCacheRef.current.prewarmAngle('front', pack, fullRig.views.front?.dataUrl ?? '');
          repositionHeroForLane(Boolean(buddyPackRef.current));
          soundEngine.magicAwaken();
          setMood('natural');
          setToy('dance');
          setPhase('alive');
          const vc = countRigViews(fullRig);
          notify(
            locale === 'en'
              ? `✓ ${vc} angles stitched — drag the 360° slider below!`
              : `✓ ${vc} açı otomatik bağlandı — alttaki 360° sürgüyle dene!`,
            'ok'
          );
          return;
        }

        // Single-photo instant animate path
        const prepared = await decodePreparedFile(files[0]);
        if (prepared.empty) {
          notify(
            locale === 'en'
              ? 'Could not detect a character in this photo — try clearer ink!'
              : 'Bu fotoğrafta çizim algılanamadı — daha net bir çizim dene!',
            'error'
          );
          return;
        }
        const anatomy = analyzeCanvasAnatomy(prepared.canvas);
        const pack = await buildRiggedCharacterPackAsync(prepared.canvas, anatomy);

        if (drawTarget === 'buddy') {
          buddyPackRef.current = pack;
          setHasBuddy(true);
          repositionHeroForLane(true);
          setDrawTarget('hero');
          soundEngine.highFive();
          setPhase('alive');
          return;
        }

        const freshAnchors = extractViewAnchorsFromCanvas(pack.filledCanvas);
        const freshRig = createMasterRigFromFront(
          pack.filledCanvas.toDataURL('image/png'),
          pack.creatureClass,
          'Karakter',
          freshAnchors,
          pack.filledCanvas.width,
          pack.filledCanvas.height
        );

        heroStrokesRef.current = [];
        heroUnderlayRef.current = prepared.canvas;
        setStrokeCount(1);
        setGhostDismissed(true);
        rigPackRef.current = pack;
        pinsRef.current = createAnatomyPins(pack.anatomy);
        springsRef.current = {};
        offsetsRef.current = {};
        dustPuffsRef.current = [];
        ripplesRef.current = [];
        sparksRef.current = [];
        setHeroYawManual(null);
        setHeroMasterRig(freshRig);
        useStudioStore.getState().setActiveMasterRig(freshRig);
        masterRigCacheRef.current = new MasterRigRuntimeCache(freshRig);
        masterRigCacheRef.current.prewarmAngle('front', pack, freshRig.views.front?.dataUrl ?? '');
        repositionHeroForLane(Boolean(buddyPackRef.current));
        soundEngine.magicAwaken();
        setMood('natural');
        setToy('dance');
        setPhase('alive');
        notify(
          locale === 'en'
            ? 'Character extracted automatically & brought to life!'
            : 'Karakter kağıttan otomatik ayıklandı ve canlandı!'
        );
      } catch {
        notify(
          locale === 'en' ? 'Could not read image file' : 'Görsel dosyası okunamadı',
          'error'
        );
      } finally {
        if (uploadInputRef.current) uploadInputRef.current.value = '';
      }
    },
    [drawTarget, locale, notify, repositionHeroForLane]
  );

  // Support instant Ctrl+V clipboard image paste right onto the homepage lightbox!
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const items = e.clipboardData?.items;
      if (!items) return;
      const pasted: File[] = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          const f = items[i].getAsFile();
          if (f) pasted.push(f);
        }
      }
      if (pasted.length > 0) {
        e.preventDefault();
        void handleUploadImageFiles(pasted);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [handleUploadImageFiles]);

  // --- Instant 1-Click "+ Arkadaş" Auto-Hop + Optional Custom Draw + Crisp Remove (×) ---
  const handleInstantAddBuddy = () => {
    const strokes = buddyStrokesRef.current.length > 0 ? buddyStrokesRef.current : buildQuickBuddyStrokes();
    buddyStrokesRef.current = strokes;
    const bPack = buildPackFromStrokes(strokes);
    if (!bPack) return;
    buddyPackRef.current = bPack;
    setHasBuddy(true);
    repositionHeroForLane(true);
    const nowSec = (performance.now() - aliveStartPerfRef.current) / 1000;
    buddyHopUntilRef.current = nowSec + 0.55;
    sparksRef.current.push({ x: 650, y: 260, bornSec: nowSec });
    soundEngine.highFive();
  };

  const handleOpenDrawBuddy = () => {
    soundEngine.paperFlip();
    setDrawTarget('buddy');
    setPhase('draw');
  };

  const handleRemoveBuddy = () => {
    soundEngine.click(0.92);
    buddyPackRef.current = null;
    setHasBuddy(false);
    setPullTarget('hero');
    repositionHeroForLane(false);
  };

  // --- V4 2.5D Multi-Angle & 7-Creature Master Modal ---
  const handleOpenMasterAngles = () => {
    const pack = rigPackRef.current;
    if (!pack) return;
    soundEngine.click(1.12);
    setHeroMasterRig((prev) => {
      if (prev && prev.views.front?.dataUrl) return prev;
      const anchors = extractViewAnchorsFromCanvas(pack.filledCanvas);
      return createMasterRigFromFront(
        pack.filledCanvas.toDataURL('image/png'),
        pack.creatureClass,
        'Karakter',
        anchors,
        pack.filledCanvas.width,
        pack.filledCanvas.height
      );
    });
    setMasterModalOpen(true);
  };

  const handleSaveMasterRig = async (saved: CharacterMasterRig) => {
    setHeroMasterRig(saved);
    useStudioStore.getState().setActiveMasterRig(saved);
    setMasterModalOpen(false);
    setMultiViewHintDismissed(true);

    if (!masterRigCacheRef.current) {
      masterRigCacheRef.current = new MasterRigRuntimeCache(saved);
    } else {
      masterRigCacheRef.current.syncRig(saved);
    }

    const frontUrl = saved.views.front?.dataUrl;
    if (frontUrl) {
      const img = new Image();
      img.onload = async () => {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth || 512;
        c.height = img.naturalHeight || 512;
        const ctx = c.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(img, 0, 0);
        const anatomy = analyzeCanvasAnatomy(c);
        const rebuilt = await buildRiggedCharacterPackAsync(c, anatomy, {
          creatureClass: saved.creatureClass,
          meshOptions: {
            customSlitLines: saved.customSlitLines,
            jointOverrides: saved.jointOverrides,
          },
        });
        rigPackRef.current = rebuilt;
        pinsRef.current = createAnatomyPins(rebuilt.anatomy);
        masterRigCacheRef.current?.prewarmAngle('front', rebuilt, frontUrl);
      };
      img.src = frontUrl;
    }

    const vc = countRigViews(saved);
    if (vc >= 2) {
      notify(
        locale === 'en'
          ? `360° 2.5D character ready (${vc}/4 angles)`
          : `360° 2.5D karakter hazır (${vc}/4 açı)`,
        'ok'
      );
    }
  };

  // --- Talking-Tom 3s Live Voice Echo ---
  const handleVoiceEcho = async () => {
    if (echoPhase !== 'idle') return;
    soundEngine.click(1.18);
    await recordAndEchoVoiceFx({
      micStream: micStreamRef.current,
      effect: voiceFx,
      recordMs: 2600,
      onPhaseChange: setEchoPhase,
      onPlaybackLevel: (amp) => {
        echoVoiceLevelRef.current = amp;
      },
    });
  };

  // --- Alive Canvas Interactions ---
  const onAlivePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = aliveCanvasRef.current;
    const pack = rigPackRef.current;
    if (!c || !pack) return;
    const r = c.getBoundingClientRect();
    const cx = ((e.clientX - r.left) / Math.max(1, r.width)) * c.width;
    const cy = ((e.clientY - r.top) / Math.max(1, r.height)) * c.height;
    const nowSec = (performance.now() - aliveStartPerfRef.current) / 1000;

    if (toy === 'film') {
      // Live click-on-stage Cinema Surprise (Lightning / Hop / Spin / Confetti Burst!)
      filmSurpriseUntilRef.current = nowSec + 0.65;
      sparksRef.current.push({ x: cx, y: cy, bornSec: nowSec });
      if (world === 'rainy') soundEngine.softThump();
      else if (world === 'concert') soundEngine.highFive();
      else soundEngine.jumpWhoosh();
      return;
    }

    if (toy === 'dance') {
      // Clicking near Buddy #2 makes Buddy jump & celebrate!
      if (buddyPackRef.current && Math.abs(cx - c.width * 0.68) < 105 && cy > c.height * 0.25) {
        buddyHopUntilRef.current = nowSec + 0.55;
        sparksRef.current.push({ x: c.width * 0.68, y: c.height * 0.35, bornSec: nowSec });
        soundEngine.highFive();
        return;
      }

      const charX = flingRef.current.mode === 'idle' ? leapRef.current.currentX : flingRef.current.x;
      const floorY = c.height * 0.82;
      const nearHero = Math.abs(cx - charX) < 92 && cy > floorY - 295 && cy < floorY + 25;
      if (nearHero) {
        e.currentTarget.setPointerCapture(e.pointerId);
        flingRef.current = {
          mode: 'grabbing',
          x: charX,
          y: floorY,
          vx: 0,
          vy: 0,
          dizzyUntilSec: -10,
          pointerStartX: cx,
          pointerStartY: cy,
          lastPx: cx,
          lastPy: cy,
          lastMs: performance.now(),
          movedPx: 0,
        };
        leapRef.current.active = false;
        soundEngine.click(1.15);
        return;
      }

      const maxLeapX = buddyPackRef.current ? c.width * 0.54 : c.width - 135;
      const targetX = Math.max(125, Math.min(maxLeapX, cx));
      const fromX = leapRef.current.active ? leapRef.current.toX : leapRef.current.currentX;
      leapRef.current = {
        active: true,
        startSec: nowSec,
        fromX,
        toX: targetX,
        currentX: fromX,
        facing: targetX >= fromX ? 1 : -1,
      };
      soundEngine.jumpWhoosh();
      return;
    }

    if (toy === 'pull') {
      const activePack = pullTarget === 'buddy' && buddyPackRef.current ? buddyPackRef.current : pack;
      const isDuet = Boolean(buddyPackRef.current);
      const sz = fitActorSize(activePack, c.width, c.height, isDuet, 0.56);
      const activeX = isDuet ? (pullTarget === 'buddy' ? c.width * 0.68 : c.width * 0.32) : c.width * 0.5;
      const dstX0 = activeX - sz.w * activePack.anatomy.centerX;
      const dstY0 = c.height * 0.82 - sz.h * activePack.anatomy.groundV;
      let closestId: string | null = null;
      let bestDist = 54;
      for (const pin of pinsRef.current) {
        const off = offsetsRef.current[pin.id];
        const px = dstX0 + (pin.x + (off?.dx ?? 0)) * sz.w;
        const py = dstY0 + (pin.y + (off?.dy ?? 0)) * sz.h;
        const d = Math.hypot(cx - px, cy - py);
        if (d < bestDist) {
          bestDist = d;
          closestId = pin.id;
        }
      }
      if (closestId) {
        e.currentTarget.setPointerCapture(e.pointerId);
        draggingPinRef.current = closestId;
        soundEngine.click(1.1);
      }
    }
  };

  const onAlivePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = aliveCanvasRef.current;
    const pack = rigPackRef.current;
    if (!c) return;
    const r = c.getBoundingClientRect();
    const cx = ((e.clientX - r.left) / Math.max(1, r.width)) * c.width;
    const cy = ((e.clientY - r.top) / Math.max(1, r.height)) * c.height;

    if (toy === 'film') {
      lookRef.current.tx = ((e.clientX - r.left) / Math.max(1, r.width) - 0.5) * 2;
      lookRef.current.ty = ((e.clientY - r.top) / Math.max(1, r.height) - 0.5) * 2;
      return;
    }

    if (toy === 'dance' && flingRef.current.mode === 'grabbing') {
      const fl = flingRef.current;
      const nowMs = performance.now();
      const dt = Math.max(0.008, (nowMs - fl.lastMs) / 1000);
      const dx = cx - fl.lastPx;
      const dy = cy - fl.lastPy;
      fl.movedPx += Math.hypot(dx, dy);
      fl.vx = fl.vx * 0.45 + (dx / dt) * 0.55;
      fl.vy = fl.vy * 0.45 + (dy / dt) * 0.55;
      fl.x = Math.max(110, Math.min(c.width - 110, cx));
      fl.y = Math.max(160, Math.min(c.height * 0.82, cy + 95));
      fl.lastPx = cx;
      fl.lastPy = cy;
      fl.lastMs = nowMs;
      return;
    }

    if (toy === 'pull' && draggingPinRef.current && pack) {
      const pin = pinsRef.current.find((p) => p.id === draggingPinRef.current);
      if (!pin) return;
      const activePack = pullTarget === 'buddy' && buddyPackRef.current ? buddyPackRef.current : pack;
      const isDuet = Boolean(buddyPackRef.current);
      const sz = fitActorSize(activePack, c.width, c.height, isDuet, 0.56);
      const activeX = isDuet ? (pullTarget === 'buddy' ? c.width * 0.68 : c.width * 0.32) : c.width * 0.5;
      const dstX0 = activeX - sz.w * activePack.anatomy.centerX;
      const dstY0 = c.height * 0.82 - sz.h * activePack.anatomy.groundV;
      const u = (cx - dstX0) / Math.max(1, sz.w);
      const v = (cy - dstY0) / Math.max(1, sz.h);
      const dx = Math.max(-0.4, Math.min(0.4, u - pin.x));
      const dy = Math.max(-0.4, Math.min(0.4, v - pin.y));
      springsRef.current[pin.id] = { dx, dy, vx: 0, vy: 0 };
      offsetsRef.current[pin.id] = { dx, dy };
    }
  };

  const onAlivePointerUp = () => {
    if (draggingPinRef.current) soundEngine.toggle(false);
    draggingPinRef.current = null;

    if (toy === 'dance' && flingRef.current.mode === 'grabbing') {
      const fl = flingRef.current;
      if (fl.movedPx < 14) {
        fl.mode = 'idle';
        const nowSec = (performance.now() - aliveStartPerfRef.current) / 1000;
        const curX = leapRef.current.currentX;
        leapRef.current = { active: true, startSec: nowSec, fromX: curX, toX: curX, currentX: curX, facing: 1 };
        soundEngine.jumpWhoosh();
      } else {
        fl.mode = 'flying';
        fl.vx = Math.max(-1350, Math.min(1350, fl.vx));
        fl.vy = Math.max(-1150, Math.min(700, fl.vy));
        soundEngine.jumpWhoosh();
      }
    }
  };

  // --- 1-Click Shareable GIF Download ---
  const handleDownloadLiveGif = async () => {
    const pack = rigPackRef.current;
    if (!pack || gifExporting) return;
    setGifExporting(true);
    soundEngine.shutter();
    try {
      const gw = 480;
      const gh = 270;
      const off = document.createElement('canvas');
      off.width = gw;
      off.height = gh;
      const octx = off.getContext('2d', { willReadFrequently: true })!;
      const total = 24;
      const loopDur = toy === 'dance' ? 3.2 : 2.0;
      const frames: { rgba: Uint8ClampedArray; hold: number }[] = [];
      for (let i = 0; i < total; i++) {
        if (i > 0 && i % 4 === 0) await new Promise((r) => setTimeout(r, 0));
        const tSec = (i / total) * loopDur;
        const phrase = (tSec % 2.0) / 2.0;
        const fakeVoice =
          phrase < 0.78
            ? Math.sin((phrase / 0.78) * Math.PI) * (0.3 + 0.65 * Math.abs(Math.sin(tSec * 9.5)))
            : 0;
        const defaultHeroX = buddyPackRef.current ? gw * 0.33 : gw * 0.5;
        renderAliveToyFrame(octx, gw, gh, pack, buddyPackRef.current, toy, world, mood, prop, tSec, {
          cadenceFps,
          leap: { active: false, startSec: -10, fromX: defaultHeroX, toX: defaultHeroX, currentX: defaultHeroX, facing: 1 },
          buddyHopUntilSec: -10,
          filmSurpriseUntilSec: -10,
          fling: { ...flingRef.current, mode: 'idle' },
          ball: ballRef.current,
          voiceAmp: toy === 'talk' ? fakeVoice : 0,
          voicePeakDelta: toy === 'talk' ? fakeVoice * 0.25 : 0,
          lookX: Math.sin((i / total) * Math.PI * 2) * 0.4,
          lookY: 0,
          pullTarget,
          pins: pinsRef.current,
          offsets: {},
          draggingPinId: null,
          dustPuffs: [],
          ripples: [],
          sparks: [],
          paperColor: '#F7F3E9',
          isGifExport: true,
        });
        frames.push({ rgba: octx.getImageData(0, 0, gw, gh).data, hold: 1 });
      }
      const delayCs = Math.max(6, Math.round((loopDur / total) * 100));
      const gifBlob = await runGifEncode({ width: gw, height: gh, delayCs, frames });
      const url = URL.createObjectURL(gifBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `inktrope-canli-${toy}-${world}-${mood}.gif`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      notify(t('magicGifDone'));
    } catch {
      notify(locale === 'en' ? 'Could not create GIF' : 'GIF oluşturulamadı', 'error');
    } finally {
      setGifExporting(false);
    }
  };

  // --- 1-Click Soundtrack + Universal MP4 Video Download (WebCodecs H.264 + MediaRecorder!) ---
  const handleDownloadLiveVideo = async () => {
    const c = aliveCanvasRef.current;
    const pack = rigPackRef.current;
    if (!c || !pack || videoExporting) return;
    setVideoExporting(true);
    soundEngine.clapperSnap();
    try {
      const chosen = pickBestMediaRecorderFormat();
      // Prefer frame-accurate WebCodecs MP4 when browser lacks native MP4 MediaRecorder (e.g. Firefox/WebView!)
      if (!chosen || chosen.ext !== 'mp4') {
        const vw = 960;
        const vh = 540;
        const vFps = 24;
        const totalF = 72;
        const mp4Blob = await encodeFramesToMp4WebCodecs({
          width: vw,
          height: vh,
          fps: vFps,
          totalFrames: totalF,
          drawFrame: (octx, i) => {
            const tSec = i / vFps;
            const defaultHeroX = buddyPackRef.current ? vw * 0.33 : vw * 0.5;
            renderAliveToyFrame(octx, vw, vh, pack, buddyPackRef.current, toy, world, mood, prop, tSec, {
              cadenceFps,
              leap: { active: false, startSec: -10, fromX: defaultHeroX, toX: defaultHeroX, currentX: defaultHeroX, facing: 1 },
              buddyHopUntilSec: -10,
              filmSurpriseUntilSec: -10,
              fling: flingRef.current,
              ball: ballRef.current,
              voiceAmp: toy === 'talk' ? 0.55 * Math.abs(Math.sin(tSec * 8)) : 0,
              voicePeakDelta: 0,
              lookX: 0,
              lookY: 0,
              pullTarget,
              pins: pinsRef.current,
              offsets: offsetsRef.current,
              draggingPinId: null,
              dustPuffs: [],
              ripples: [],
              sparks: [],
              paperColor: '#F7F3E9',
              playFoley: false,
              isGifExport: true,
            });
          },
        });
        if (mp4Blob) {
          const url = URL.createObjectURL(mp4Blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `inktrope-film-${toy}-${world}-${mood}.mp4`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1500);
          notify(t('magicVideoDone'));
          return;
        }
      }

      if (typeof MediaRecorder === 'undefined') {
        notify(t('exportWebViewFallbackToast'), 'info');
        return;
      }
      const { blob, ext } = await recordSoundtrackVideo(c, {
        durationMs: 3000,
        mode: toy,
        world,
        micStream: toy === 'talk' ? micStreamRef.current : null,
        voiceFx,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `inktrope-film-${toy}-${world}-${mood}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      notify(t('magicVideoDone'));
    } catch {
      notify(locale === 'en' ? 'Could not record video' : 'Video kaydedilemedi', 'error');
    } finally {
      setVideoExporting(false);
    }
  };

  // --- 1-Click Zero-Server Remix Share Link (`#kagit=...`) ---
  const handleShareRemixLink = async () => {
    if (heroStrokesRef.current.length === 0) return;
    soundEngine.click(1.22);
    const token = encodeSharedStage({
      strokes: heroStrokesRef.current,
      buddyStrokes: hasBuddy && buddyStrokesRef.current.length > 0 ? buddyStrokesRef.current : undefined,
      toy,
      world,
      mood,
      prop,
      voiceFx,
    });
    const hashStr = `#kagit=${token}`;
    hydratedHashRef.current = hashStr;
    const shareUrl = `${window.location.origin}${window.location.pathname}${hashStr}`;
    try {
      window.history.replaceState(null, '', hashStr);
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(shareUrl);
      }
      notify(t('shareCopied'));
    } catch {
      notify(t('shareCopied'));
    }
  };

  const handleSendToStudio = async (destOverride?: 'draw' | 'puppet' | 'film') => {
    if (sendingStudio) return;
    setSendingStudio(true);
    try {
      const sketch =
        rigPackRef.current?.sourceCanvas ??
        (drawCanvasRef.current ? cropSketchCanvas(drawCanvasRef.current) : null);
      if (!sketch) {
        onOpenBlankDesk();
        return;
      }
      const dest: 'draw' | 'puppet' | 'film' =
        destOverride ?? (toy === 'film' ? 'film' : toy === 'pull' || toy === 'talk' ? 'puppet' : 'draw');
      await onSendToStudio(sketch, dest, activePrompt ? (locale === 'en' ? activePrompt.en : activePrompt.tr) : undefined);
    } finally {
      setSendingStudio(false);
    }
  };

  const toyHint =
    toy === 'dance'
      ? t('magicTapJumpHint')
      : toy === 'talk'
        ? micFallback
          ? t('magicTalkFallback')
          : t('magicTalkHint')
        : toy === 'film'
          ? t('magicFilmHint')
          : t('magicPullHint');

  return (
    <div className="space-y-3 select-none">
      <input
        ref={uploadInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length > 0) void handleUploadImageFiles(files);
        }}
      />
      {/* Glowing Lightbox Glass Window with Registration Pegbar */}
      <div className="relative pt-3">
        <div
          className="absolute top-0 left-1/2 -translate-x-1/2 z-20 flex items-center gap-3.5 px-4 py-1.5 rounded-t-xl border border-b-0 shadow-sm pointer-events-none"
          style={{
            background: theme === 'night' ? '#E4DCCB' : '#FAF6EE',
            borderColor: 'rgba(120,104,84,0.35)',
          }}
        >
          <span className="w-2.5 h-2.5 rounded-full bg-neutral-800/80 shadow-inner" />
          <span className="w-7 h-2 rounded-full bg-neutral-800/80 shadow-inner" />
          <span className="w-2.5 h-2.5 rounded-full bg-neutral-800/80 shadow-inner" />
        </div>

        <div
          data-tour="desk-canvas"
          onDragOver={(e) => {
            e.preventDefault();
            setDragOverUpload(true);
          }}
          onDragLeave={() => setDragOverUpload(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOverUpload(false);
            const files = Array.from(e.dataTransfer.files ?? []).filter((f) => f.type.startsWith('image/'));
            if (files.length > 0) void handleUploadImageFiles(files);
          }}
          className={`relative aspect-[16/9] w-full rounded-2xl overflow-hidden border transition-all duration-300 ${
            dragOverUpload ? 'ring-2 ring-ink-vermilion' : ''
          }`}
          style={{
            backgroundColor: '#F7F3E9',
            borderColor: dragOverUpload ? '#E54D2E' : 'rgba(217,155,38,0.45)',
            boxShadow:
              theme === 'night'
                ? `inset 0 0 36px rgba(255,244,214,${(0.32 * lightboxDim).toFixed(2)}), 0 0 ${Math.round(32 * lightboxDim)}px rgba(217,155,38,${(0.18 * lightboxDim).toFixed(2)})`
                : 'inset 0 1px 0 rgba(255,255,255,0.9), 0 12px 30px rgba(28,25,23,0.1)',
          }}
        >
          {dragOverUpload && (
            <div className="absolute inset-0 z-30 bg-neutral-950/65 backdrop-blur-[2px] flex items-center justify-center pointer-events-none">
              <div className="px-4 py-2 rounded-full bg-ink-vermilion text-white text-xs font-extrabold shadow-xl">
                {locale === 'en'
                  ? 'Drop 1 drawing or 2–4 angles at once!'
                  : 'Tek çizim veya 2–4 açıyı birden bırak!'}
              </div>
            </div>
          )}
          {phase === 'draw' ? (
            /* ====== ZONE 2 & 3 (DRAW PHASE): CLEAN ZERO-GUESSWORK SKETCH PAPER ====== */
            <>
              <canvas
                ref={guideCanvasRef}
                width={1280}
                height={720}
                className="absolute inset-0 w-full h-full pointer-events-none"
              />

              {strokeCount === 0 && (
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none select-none px-4 sm:px-6 pt-7 sm:pt-0 text-center gap-1.5 sm:gap-2">
                  {/* Subtle Non-Blocking 2.5s Ghost Ink Pencil Invitation (vanishes immediately on draw!) */}
                  {!activePrompt && !ghostDismissed && drawTarget === 'hero' && (
                    <svg
                      viewBox="0 0 120 62"
                      className="hidden sm:block w-24 h-12 overflow-visible opacity-85"
                      aria-hidden="true"
                    >
                      <path
                        d="M 42 32 A 18 18 0 1 1 78 32 A 18 18 0 1 1 42 32"
                        fill="none"
                        stroke="#2B2622"
                        strokeWidth="2.8"
                        strokeLinecap="round"
                        className="ghost-ink-stroke"
                      />
                      <path
                        d="M 52 28 L 52.5 28.5 M 67 28 L 67.5 28.5 M 52 38 Q 60 44 68 38"
                        fill="none"
                        stroke="#E54D2E"
                        strokeWidth="2.8"
                        strokeLinecap="round"
                        className="ghost-ink-stroke"
                        style={{ animationDelay: '0.45s' }}
                      />
                      <path
                        d="M 30 46 Q 48 56 88 46"
                        fill="none"
                        stroke="#D99B26"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        className="ghost-ink-stroke"
                        style={{ animationDelay: '0.85s' }}
                      />
                    </svg>
                  )}
                  <div className="px-4 py-3 rounded-2xl bg-[#F7F3E9]/90 backdrop-blur-sm border border-stone-300/70 shadow-sm max-w-md">
                    <div className="text-base sm:text-lg font-extrabold tracking-tight text-stone-800">
                      {drawTarget === 'buddy' ? t('buddyDrawTitle') : t('magicInviteTitle')}
                    </div>
                    <p className="text-[11.5px] sm:text-xs text-stone-600 mt-1 leading-relaxed">
                      {t('magicInviteSub')}
                    </p>
                  </div>
                </div>
              )}

              <canvas
                ref={drawCanvasRef}
                width={1280}
                height={720}
                onPointerDown={onDrawDown}
                onPointerMove={onDrawMove}
                onPointerUp={onDrawUp}
                onPointerCancel={onDrawUp}
                className="absolute inset-0 w-full h-full cursor-crosshair touch-none z-10"
              />

              <div className="absolute top-2.5 left-2.5 right-2.5 flex items-center justify-between gap-2 pointer-events-none z-20">
                {drawTarget === 'buddy' ? (
                  <button
                    type="button"
                    onClick={() => {
                      setDrawTarget('hero');
                      setPhase('alive');
                    }}
                    className="pointer-events-auto px-2.5 py-1 rounded-full bg-neutral-950/85 hover:bg-neutral-900 text-[#F7F3E9] text-[10.5px] font-bold inline-flex items-center gap-1 shadow"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" />
                    {locale === 'en' ? 'Back to Scene' : 'Sahneye Dön'}
                  </button>
                ) : (
                  <div className="pointer-events-auto flex items-center gap-1">
                    <button
                      type="button"
                      onClick={handleSurpriseIdea}
                      className="px-2.5 py-1 rounded-full bg-neutral-950/85 hover:bg-neutral-900 backdrop-blur-sm border border-white/15 text-[#F7F3E9] text-[10.5px] font-bold inline-flex items-center gap-1.5 shadow transition-transform active:scale-95"
                    >
                      <Dices className="w-3.5 h-3.5 text-ink-brass shrink-0" />
                      <span className="truncate max-w-[140px] sm:max-w-[220px]">
                        {activePrompt ? (locale === 'en' ? activePrompt.en : activePrompt.tr) : t('magicSurpriseBtn')}
                      </span>
                    </button>
                    {activePrompt && (
                      <button
                        type="button"
                        onClick={() => {
                          soundEngine.click(0.9);
                          setPromptIdx(null);
                        }}
                        className="p-1 rounded-full bg-neutral-950/85 hover:bg-ink-vermilion border border-white/15 text-[#F7F3E9] shadow transition-colors"
                        title={locale === 'en' ? 'Hide guide' : 'Rehberi gizle'}
                        aria-label={locale === 'en' ? 'Hide guide' : 'Rehberi gizle'}
                      >
                        <X className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                )}

                <div className="pointer-events-auto flex items-center gap-1 px-2 py-1 rounded-full bg-neutral-950/85 backdrop-blur-sm border border-white/15 shadow">
                  {INK_SWATCHES.map((sw) => (
                    <button
                      key={sw.hex}
                      type="button"
                      onClick={() => {
                        soundEngine.click(1.08);
                        setInkColor(sw.hex);
                      }}
                      className={`w-4 h-4 rounded-full border transition-transform ${
                        inkColor === sw.hex ? 'border-white scale-110 ring-1 ring-white/80' : 'border-white/30'
                      }`}
                      style={{ backgroundColor: sw.hex }}
                      title={locale === 'en' ? sw.en : sw.tr}
                      aria-label={locale === 'en' ? sw.en : sw.tr}
                    />
                  ))}

                  <span className="w-px h-3.5 bg-white/20 mx-0.5" />

                  <button
                    type="button"
                    onClick={() => {
                      soundEngine.click(1.04);
                      setNibBold(false);
                    }}
                    className={`px-1.5 py-0.5 rounded-full text-[9.5px] font-bold transition-colors ${
                      !nibBold ? 'bg-ink-brass text-neutral-950' : 'text-[#F7F3E9]/75 hover:text-white'
                    }`}
                  >
                    {t('thinNib')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      soundEngine.click(1.04);
                      setNibBold(true);
                    }}
                    className={`px-1.5 py-0.5 rounded-full text-[9.5px] font-bold transition-colors ${
                      nibBold ? 'bg-ink-brass text-neutral-950' : 'text-[#F7F3E9]/75 hover:text-white'
                    }`}
                  >
                    {t('thickNib')}
                  </button>

                  {strokeCount > 0 && (
                    <>
                      <span className="w-px h-3.5 bg-white/20 mx-0.5" />
                      <button
                        type="button"
                        onClick={handleUndo}
                        className="p-0.5 rounded-full text-[#F7F3E9]/85 hover:text-ink-brass transition-colors"
                        title={t('undoShort')}
                        aria-label={t('undoShort')}
                      >
                        <Undo2 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={handleClear}
                        className="p-0.5 rounded-full text-[#F7F3E9]/85 hover:text-ink-vermilion transition-colors"
                        title={t('drawClear')}
                        aria-label={t('drawClear')}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </>
                  )}
                </div>
              </div>
            </>
          ) : (
            /* ====== ZONE 2 & 3 (ALIVE PHASE): FIXED 4-ZONE CRYSTAL-CLEAR STAGE ====== */
            <>
              <canvas
                ref={aliveCanvasRef}
                width={960}
                height={540}
                onPointerDown={onAlivePointerDown}
                onPointerMove={onAlivePointerMove}
                onPointerUp={onAlivePointerUp}
                onPointerCancel={onAlivePointerUp}
                onPointerLeave={() => {
                  lookRef.current.tx = 0;
                  lookRef.current.ty = 0;
                  draggingPinRef.current = null;
                }}
                className={`w-full h-full block touch-none ${
                  toy === 'pull' || toy === 'dance'
                    ? 'cursor-grab active:cursor-grabbing'
                    : toy === 'film'
                      ? 'cursor-pointer'
                      : 'cursor-default'
                }`}
              />

              {/* ZONE 2 — TOP BAR: Left = Mode Selector / Tip | Right = Instant Buddy Control */}
              <div className="absolute top-2.5 left-2.5 right-2.5 flex items-center justify-between gap-2 pointer-events-none z-20">
                {toy === 'film' ? (
                  <div className="pointer-events-auto flex items-center gap-0.5 p-1 rounded-full bg-neutral-950/90 backdrop-blur-sm border border-white/15 shadow">
                    {(
                      [
                        { id: 'rainy', Icon: CloudRain, label: t('worldRainy') },
                        { id: 'meadow', Icon: Sun, label: t('worldMeadow') },
                        { id: 'space', Icon: Rocket, label: t('worldSpace') },
                        { id: 'concert', Icon: Music2, label: t('worldConcert') },
                        { id: 'escape', Icon: Flame, label: t('worldEscape') },
                      ] as const
                    ).map((w) => {
                      const WIcon = w.Icon;
                      return (
                        <button
                          key={w.id}
                          type="button"
                          onClick={() => {
                            soundEngine.click(1.12);
                            setWorld(w.id);
                          }}
                          className={`px-2 py-0.5 rounded-full text-[10px] font-bold inline-flex items-center gap-1 transition-all whitespace-nowrap ${
                            world === w.id
                              ? 'bg-ink-vermilion text-white shadow'
                              : 'text-[#F7F3E9]/85 hover:text-white'
                          }`}
                        >
                          <WIcon className="w-3 h-3 shrink-0" />
                          {w.label}
                        </button>
                      );
                    })}
                  </div>
                ) : toy === 'talk' ? (
                  <div className="pointer-events-auto flex items-center gap-0.5 p-1 rounded-full bg-neutral-950/90 backdrop-blur-sm border border-white/15 shadow">
                    {(
                      [
                        { id: 'natural', label: t('voiceNatural') },
                        { id: 'chipmunk', label: t('voiceChipmunk') },
                        { id: 'giant', label: t('voiceGiant') },
                        { id: 'robot', label: t('voiceRobot') },
                      ] as const
                    ).map((vf) => (
                      <button
                        key={vf.id}
                        type="button"
                        onClick={() => {
                          soundEngine.click(1.14);
                          setVoiceFx(vf.id);
                        }}
                        className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold transition-all whitespace-nowrap ${
                          voiceFx === vf.id
                            ? 'bg-ink-brass text-neutral-950 shadow'
                            : 'text-[#F7F3E9]/85 hover:text-white'
                        }`}
                      >
                        {vf.label}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="min-w-0 px-2 sm:px-2.5 py-1 rounded-full bg-neutral-950/85 backdrop-blur-sm text-[#F7F3E9] text-[10px] sm:text-[10.5px] font-semibold flex items-center gap-1.5 shadow max-w-[44%] sm:max-w-[58%]">
                    <span className="hardware-led shrink-0" data-on="emerald" data-pulse="true" />
                    <span className="truncate">{toyHint}</span>
                  </div>
                )}

                {/* Right Slot: Single Compact 2.5D Angles Pill + Instant Buddy Control! */}
                <div className="pointer-events-auto flex items-center gap-1 shrink-0">
                  {rigPackRef.current && rigPackRef.current.creatureClass !== 'humanoid' && (
                    <button
                      type="button"
                      onClick={handleOpenMasterAngles}
                      className="hidden sm:inline-flex px-2 py-1 rounded-full bg-neutral-950/90 hover:bg-neutral-900 border border-ink-brass/40 text-ink-brass text-[10px] font-bold items-center gap-1 shadow transition-all whitespace-nowrap shrink-0"
                      title={t('v4CreatureTypeLabel')}
                    >
                      <span>
                        {locale === 'en'
                          ? UNIVERSAL_CREATURE_CATALOG[rigPackRef.current.creatureClass].labelEn
                          : UNIVERSAL_CREATURE_CATALOG[rigPackRef.current.creatureClass].labelTr}
                      </span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleOpenMasterAngles}
                    className={`px-2 sm:px-2.5 py-1 rounded-full text-[9.5px] sm:text-[10px] font-bold inline-flex items-center gap-1 shadow transition-all active:scale-95 border whitespace-nowrap shrink-0 ${
                      countRigViews(heroMasterRig) >= 3
                        ? 'bg-emerald-950/90 border-emerald-400/50 text-emerald-200 hover:border-emerald-300'
                        : 'bg-neutral-950/90 hover:bg-neutral-900 border-ink-brass/45 text-ink-brass hover:border-ink-brass'
                    }`}
                  >
                    <Sparkles className="w-3 h-3 shrink-0" />
                    <span className="sm:hidden">
                      {countRigViews(heroMasterRig) >= 3
                        ? `360° (${countRigViews(heroMasterRig)}/4)`
                        : countRigViews(heroMasterRig) === 2
                          ? '2.5D · 2/4'
                          : '2.5D'}
                    </span>
                    <span className="hidden sm:inline">
                      {countRigViews(heroMasterRig) >= 3
                        ? `${t('v4Ready360')} (${countRigViews(heroMasterRig)}/4)`
                        : countRigViews(heroMasterRig) === 2
                          ? `${t('v4AnglesPill')} · 2/4`
                          : t('v4AnglesPill')}
                    </span>
                  </button>
                  {!hasBuddy ? (
                    <button
                      type="button"
                      onClick={handleInstantAddBuddy}
                      className="px-2 sm:px-2.5 py-1 rounded-full bg-neutral-950/90 hover:bg-neutral-900 border border-white/15 hover:border-ink-brass text-[#F7F3E9] text-[9.5px] sm:text-[10px] font-bold inline-flex items-center gap-1 shadow transition-all active:scale-95 whitespace-nowrap shrink-0"
                    >
                      <UserPlus className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-ink-brass shrink-0" />
                      {t('addBuddy')}
                    </button>
                  ) : (
                    <div className="flex items-center p-0.5 rounded-full bg-neutral-950/90 border border-ink-emerald/50 shadow">
                      <button
                        type="button"
                        onClick={handleOpenDrawBuddy}
                        className="px-2 py-0.5 rounded-full text-[10px] font-bold text-[#F7F3E9] hover:text-ink-brass inline-flex items-center gap-1 transition-colors"
                      >
                        <Pencil className="w-3 h-3 text-ink-emerald" />
                        {t('editBuddy')}
                      </button>
                      <button
                        type="button"
                        onClick={handleRemoveBuddy}
                        title={t('removeBuddy')}
                        aria-label={t('removeBuddy')}
                        className="p-1 rounded-full text-[#F7F3E9]/80 hover:bg-ink-vermilion hover:text-white transition-colors"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* ZONE 3 — BOTTOM BAR: Crisp Mode-Specific Live Controls (Desktop floats inside canvas; mobile docks cleanly below so feet & all pills stay 100% unobstructed!) */}
              {(toy === 'dance' || toy === 'film') && (
                <div className="hidden sm:flex absolute bottom-2.5 left-1/2 -translate-x-1/2 z-20 items-center gap-1 p-1 rounded-full bg-neutral-950/90 backdrop-blur-sm border border-white/15 shadow-lg">
                  {(
                    [
                      { id: 'natural', label: t('moodNatural') },
                      { id: 'joy', label: t('moodJoy') },
                      { id: 'cool', label: t('moodCool') },
                      { id: 'sneak', label: t('moodSneak') },
                      { id: 'sprint', label: t('moodSprint') },
                    ] as const
                  ).map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => {
                        soundEngine.click(1.14);
                        setMood(m.id);
                      }}
                      className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold transition-all whitespace-nowrap ${
                        mood === m.id
                          ? 'bg-ink-brass text-neutral-950 shadow'
                          : 'text-[#F7F3E9]/85 hover:text-white'
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}

                  <span className="w-px h-3.5 bg-white/20 mx-0.5" />

                  {(
                    [
                      { id: 'umbrella', Icon: Umbrella, label: t('propUmbrella') },
                      { id: 'cape', Icon: Wind, label: t('propCape') },
                      { id: 'ball', Icon: CircleDot, label: t('propBall') },
                    ] as const
                  ).map((pr) => {
                    const PIcon = pr.Icon;
                    const active = prop === pr.id;
                    return (
                      <button
                        key={pr.id}
                        type="button"
                        title={pr.label}
                        aria-label={pr.label}
                        onClick={() => {
                          soundEngine.click(1.18);
                          if (pr.id === 'ball') {
                            ballRef.current = { x: 640, y: 120, vx: -175, vy: 0, rot: 0, lastKickSec: -10 };
                          }
                          setProp((cur) => (cur === pr.id ? 'none' : pr.id));
                        }}
                        className={`px-2 py-0.5 rounded-full text-[10px] font-bold inline-flex items-center gap-1 transition-all whitespace-nowrap ${
                          active
                            ? 'bg-ink-vermilion text-white shadow'
                            : 'text-[#F7F3E9]/80 hover:text-white hover:bg-white/10'
                        }`}
                      >
                        <PIcon className="w-3 h-3 shrink-0" />
                        <span className="hidden sm:inline">{pr.label}</span>
                      </button>
                    );
                  })}

                  {toy === 'film' && (
                    <>
                      <span className="w-px h-3.5 bg-white/20 mx-0.5" />
                      <button
                        type="button"
                        onClick={() => {
                          soundEngine.click(1.06);
                          setCadenceFps((f) => (f === 12 ? 24 : 12));
                        }}
                        className="px-1.5 py-0.5 rounded-full font-mono text-[9px] font-bold text-ink-brass hover:bg-white/10"
                        title="12 / 24 FPS"
                      >
                        {cadenceFps}
                      </button>
                    </>
                  )}
                </div>
              )}

              {toy === 'talk' && (
                <div className="absolute bottom-2.5 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 px-2.5 py-1 rounded-full bg-neutral-950/90 backdrop-blur-sm border border-white/15 shadow-lg">
                  <div className="flex items-center gap-1 text-[#F7F3E9] text-[10px] font-bold">
                    {micActive ? (
                      <Mic className="w-3.5 h-3.5 text-ink-emerald" />
                    ) : (
                      <MicOff className="w-3.5 h-3.5 text-ink-brass" />
                    )}
                    <div className="flex items-end gap-0.5 h-3 w-8">
                      {[0.4, 0.85, 1, 0.7, 0.45].map((m, idx) => (
                        <span
                          key={idx}
                          className="w-1 rounded-full bg-ink-emerald transition-all duration-75"
                          style={{ height: `${Math.max(20, Math.min(100, Math.round(liveAudioBar * 100 * m)))}%` }}
                        />
                      ))}
                    </div>
                  </div>

                  <span className="w-px h-3.5 bg-white/20" />

                  <button
                    type="button"
                    disabled={echoPhase !== 'idle'}
                    onClick={() => void handleVoiceEcho()}
                    className={`px-2.5 py-0.5 rounded-full text-[10.5px] font-bold inline-flex items-center gap-1.5 transition-all whitespace-nowrap ${
                      echoPhase === 'recording'
                        ? 'bg-ink-vermilion text-white animate-pulse'
                        : echoPhase === 'playing'
                          ? 'bg-ink-emerald text-neutral-950'
                          : 'bg-ink-brass text-neutral-950 hover:brightness-110'
                    }`}
                  >
                    <Volume2 className="w-3.5 h-3.5" />
                    {echoPhase === 'recording'
                      ? t('voiceEchoRec')
                      : echoPhase === 'playing'
                        ? t('voiceEchoPlay')
                        : t('voiceEchoBtn')}
                  </button>
                </div>
              )}

              {toy === 'pull' && (
                <div className="absolute bottom-2.5 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1 p-1 rounded-full bg-neutral-950/90 backdrop-blur-sm border border-white/15 shadow-lg">
                  <button
                    type="button"
                    onClick={() => {
                      soundEngine.click(1.08);
                      springsRef.current = {};
                      offsetsRef.current = {};
                    }}
                    className="px-2.5 py-0.5 rounded-full text-[10px] font-bold text-[#F7F3E9] hover:text-ink-brass inline-flex items-center gap-1 transition-colors"
                  >
                    <RotateCcw className="w-3 h-3" />
                    {t('pullReset')}
                  </button>
                  {hasBuddy && (
                    <>
                      <span className="w-px h-3.5 bg-white/20 mx-0.5" />
                      <button
                        type="button"
                        onClick={() => {
                          soundEngine.click(1.12);
                          setPullTarget((p) => (p === 'hero' ? 'buddy' : 'hero'));
                        }}
                        className="px-2.5 py-0.5 rounded-full bg-ink-brass text-neutral-950 text-[10px] font-bold transition-colors"
                      >
                        {t('pullSwitch')} ({pullTarget === 'hero' ? '1' : '2'})
                      </button>
                    </>
                  )}
                </div>
              )}
            </>
          )}

          <div className="absolute inset-0 paper-grain-overlay opacity-30 pointer-events-none z-10" />
        </div>
      </div>

      {/* Mobile-only Docked Mood & Prop Bar (< sm): zero clipping & keeps character feet 100% visible */}
      {phase === 'alive' && (toy === 'dance' || toy === 'film') && (
        <div className="flex sm:hidden flex-wrap items-center justify-center gap-1 px-2 py-1.5 rounded-2xl bg-neutral-950/90 border border-white/15 shadow-md">
          {(
            [
              { id: 'natural', label: t('moodNatural') },
              { id: 'joy', label: t('moodJoy') },
              { id: 'cool', label: t('moodCool') },
              { id: 'sneak', label: t('moodSneak') },
              { id: 'sprint', label: t('moodSprint') },
            ] as const
          ).map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => {
                soundEngine.click(1.14);
                setMood(m.id);
              }}
              className={`px-2.5 py-1 rounded-full text-[11px] font-bold transition-all whitespace-nowrap ${
                mood === m.id
                  ? 'bg-ink-brass text-neutral-950 shadow'
                  : 'text-[#F7F3E9]/85 hover:text-white'
              }`}
            >
              {m.label}
            </button>
          ))}
          <span className="w-px h-3.5 bg-white/20 mx-0.5" />
          {(
            [
              { id: 'umbrella', Icon: Umbrella, label: t('propUmbrella') },
              { id: 'cape', Icon: Wind, label: t('propCape') },
              { id: 'ball', Icon: CircleDot, label: t('propBall') },
            ] as const
          ).map((pr) => {
            const PIcon = pr.Icon;
            const active = prop === pr.id;
            return (
              <button
                key={pr.id}
                type="button"
                title={pr.label}
                aria-label={pr.label}
                onClick={() => {
                  soundEngine.click(1.18);
                  if (pr.id === 'ball') {
                    ballRef.current = { x: 640, y: 120, vx: -175, vy: 0, rot: 0, lastKickSec: -10 };
                  }
                  setProp((cur) => (cur === pr.id ? 'none' : pr.id));
                }}
                className={`px-2 py-1 rounded-full text-[11px] font-bold inline-flex items-center gap-1 transition-all whitespace-nowrap ${
                  active
                    ? 'bg-ink-vermilion text-white shadow'
                    : 'text-[#F7F3E9]/80 hover:text-white hover:bg-white/10'
                }`}
              >
                <PIcon className="w-3 h-3 shrink-0" />
              </button>
            );
          })}
          {toy === 'film' && (
            <button
              type="button"
              onClick={() => {
                soundEngine.click(1.06);
                setCadenceFps((f) => (f === 12 ? 24 : 12));
              }}
              className="px-2 py-1 rounded-full font-mono text-[10px] font-bold text-ink-brass hover:bg-white/10"
              title="12 / 24 FPS"
            >
              {cadenceFps}
            </button>
          )}
        </div>
      )}

      {/* ZONE 4 — BOTTOM CONSOLE: Fixed 2-Row Tactile Controls, Zero Clutter, Zero Hidden CTAs */}
      {phase === 'draw' ? (
        <div className="rounded-2xl console-well border border-desk-border px-3 py-2.5 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <KeycapButton
              key="quick-sample"
              data-tour="desk-quick-draw"
              size="sm"
              variant="brass"
              onClick={handleQuickSample}
            >
              <Wand2 className="w-3.5 h-3.5" />
              {drawTarget === 'buddy' ? t('buddyQuickSample') : t('magicQuickSketchBtn')}
            </KeycapButton>

            <KeycapButton
              key="upload-photo"
              size="sm"
              variant="graphite"
              title={
                locale === 'en'
                  ? 'Pick 1 drawing or 2–4 angle photos at once (Front/Side/Back)'
                  : 'Tek çizim veya 2–4 açı fotoğrafını birden seç (Ön/Yan/Arka)'
              }
              onClick={() => uploadInputRef.current?.click()}
            >
              <Upload className="w-3.5 h-3.5 text-ink-brass" />
              {locale === 'en' ? 'Upload Drawing' : 'Çizim Yükle'}
            </KeycapButton>

            <KeycapButton
              key="animate-now"
              data-tour="desk-alive-actions"
              size="sm"
              variant={strokeCount > 0 ? 'vermilion' : 'graphite'}
              led={strokeCount > 0 ? 'emerald' : 'off'}
              ledPulse={strokeCount > 0}
              onClick={handleAnimateNow}
            >
              <Sparkles className="w-3.5 h-3.5" />
              {drawTarget === 'buddy' ? t('buddyAddDone') : t('magicAnimateBtn')} ⚡
            </KeycapButton>
          </div>

          <div className="flex items-center gap-2">
            {strokeCount > 0 ? (
              <KeycapButton
                size="sm"
                variant="ivory"
                disabled={sendingStudio}
                onClick={() => void handleSendToStudio('draw')}
              >
                <SketchNibIcon className="w-3.5 h-3.5" />
                {t('magicOpenStudio')}
              </KeycapButton>
            ) : (
              <KeycapButton size="sm" variant="ivory" onClick={onOpenBlankDesk}>
                <SketchNibIcon className="w-3.5 h-3.5" />
                {t('openOnDesk')}
              </KeycapButton>
            )}
          </div>
        </div>
      ) : (
        <div className="rounded-2xl console-well border border-desk-border px-3 py-2.5 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-1.5">
            <div data-tour="desk-alive-actions" className="flex flex-wrap items-center gap-1">
              {(
                [
                  { id: 'dance', label: t('magicToyDance'), icon: Music },
                  { id: 'talk', label: t('magicToyTalk'), icon: Mic },
                  { id: 'film', label: t('magicToyFilm'), icon: Film },
                  { id: 'pull', label: t('magicToyPull'), icon: Hand },
                ] as const
              ).map((item) => {
                const Icon = item.icon;
                const active = toy === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      soundEngine.click(1.12);
                      setToy(item.id);
                    }}
                    className={`px-2.5 py-1.5 rounded-xl text-[11px] font-bold inline-flex items-center gap-1.5 border transition-all ${
                      active
                        ? 'bg-ink-vermilion text-white border-ink-vermilion shadow-md'
                        : 'bg-desk-surface/85 text-desk-text border-desk-border hover:border-ink-brass'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {item.label}
                  </button>
                );
              })}
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                title={
                  locale === 'en'
                    ? 'Pick 1 drawing or 2–4 angle photos at once'
                    : 'Tek çizim veya 2–4 açı fotoğrafını birden seç'
                }
                onClick={() => uploadInputRef.current?.click()}
                className="px-2.5 py-1.5 rounded-xl text-[11px] font-bold text-desk-text bg-desk-surface/85 border border-desk-border hover:border-ink-brass inline-flex items-center gap-1 transition-colors"
              >
                <Upload className="w-3.5 h-3.5 text-ink-brass" />
                {locale === 'en' ? 'Upload' : 'Yükle'}
              </button>
              <button
                type="button"
                onClick={() => {
                  soundEngine.paperFlip();
                  setDrawTarget('hero');
                  setPhase('draw');
                }}
                className="px-2.5 py-1.5 rounded-xl text-[11px] font-bold text-desk-muted hover:text-desk-text bg-desk-surface/70 border border-desk-border inline-flex items-center gap-1 transition-colors"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                {t('magicBackToDraw')}
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-desk-border/70">
            <div className="flex flex-wrap items-center gap-1.5">
              <KeycapButton
                size="sm"
                variant="brass"
                disabled={gifExporting}
                onClick={() => void handleDownloadLiveGif()}
              >
                <Download className="w-3.5 h-3.5" />
                {gifExporting ? t('magicGifBusy') : t('magicDownloadGif')}
              </KeycapButton>

              <KeycapButton
                size="sm"
                variant="graphite"
                disabled={videoExporting}
                onClick={() => void handleDownloadLiveVideo()}
              >
                <Video className="w-3.5 h-3.5 text-ink-vermilion" />
                {videoExporting ? t('magicVideoBusy') : t('magicDownloadVideo')}
              </KeycapButton>

              <button
                type="button"
                onClick={() => void handleShareRemixLink()}
                className="px-2.5 py-1.5 rounded-xl text-[11px] font-bold text-desk-text bg-desk-surface/85 border border-desk-border hover:border-ink-brass inline-flex items-center gap-1 transition-colors"
              >
                <Share2 className="w-3.5 h-3.5 text-ink-brass" />
                {t('shareLink')}
              </button>
            </div>

            <KeycapButton
              size="sm"
              variant="ivory"
              disabled={sendingStudio}
              onClick={() => void handleSendToStudio()}
            >
              <Sparkles className="w-3.5 h-3.5" />
              {t('magicOpenStudio')} →
            </KeycapButton>
          </div>
        </div>
      )}
      {/* Dismissible 1-Time Subtle Multi-Angle Tip (Zero Clutter!) */}
      {phase === 'alive' && !multiViewHintDismissed && countRigViews(heroMasterRig) === 1 && (
        <div className="mt-1.5 px-2.5 py-1 rounded-xl bg-desk-surface/75 border border-ink-brass/25 flex items-center justify-between gap-2 text-[10.5px]">
          <button
            type="button"
            onClick={handleOpenMasterAngles}
            className="flex items-center gap-1.5 text-desk-muted hover:text-ink-brass transition-colors truncate"
          >
            <Sparkles className="w-3 h-3 text-ink-brass shrink-0" />
            <span className="truncate">{t('v4DeskHintMultiView')}</span>
            <span className="text-ink-brass font-bold shrink-0">{t('v4AnglesPill')} →</span>
          </button>
          <button
            type="button"
            onClick={() => setMultiViewHintDismissed(true)}
            className="p-0.5 text-desk-muted hover:text-desk-text shrink-0"
            aria-label={t('exportCloseAria')}
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* Optional compact 360° live angle slider ONLY when artist added 2+ angles */}
      {phase === 'alive' && countRigViews(heroMasterRig) >= 2 && (
        <div className="mt-1.5 px-3 py-1 rounded-xl bg-desk-surface/80 border border-ink-brass/35 flex items-center gap-2 text-[10.5px]">
          <span className="font-bold text-ink-brass shrink-0">{t('v4TurnPreviewLabel')}</span>
          <input
            type="range"
            min={-180}
            max={180}
            step={5}
            value={heroYawManual ?? 0}
            onChange={(e) => setHeroYawManual(Number(e.target.value))}
            className="flex-1 accent-ink-brass h-1.5 cursor-pointer"
          />
          <span className="font-mono text-desk-muted w-9 text-right shrink-0">
            {(heroYawManual ?? 0) > 0 ? `+${heroYawManual}°` : `${heroYawManual ?? 0}°`}
          </span>
          {heroYawManual !== null && (
            <button
              type="button"
              onClick={() => setHeroYawManual(null)}
              className="text-[10px] text-desk-muted hover:text-ink-brass font-bold"
            >
              Auto
            </button>
          )}
        </div>
      )}

      {heroMasterRig && (
        <CharacterMasterModal
          open={masterModalOpen}
          initialRig={heroMasterRig}
          onClose={() => setMasterModalOpen(false)}
          onSave={(saved) => void handleSaveMasterRig(saved)}
        />
      )}
    </div>
  );
}
