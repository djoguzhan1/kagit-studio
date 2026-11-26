import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Clapperboard, Eraser, MoveHorizontal, Sparkles, SunDim } from 'lucide-react';
import type { MeshFrameOffsets, MeshPin, StudioProject, StudioTheme } from '../../types/studio';
import { BlobImage, KeycapButton } from '../ui/KeycapButton';
import { BrassRotaryDial } from '../ui/Studio3DControls';
import { MotionPlayIcon, SketchNibIcon } from '../ui/AnimatedStudioIcons';
import { soundEngine } from '../../engine/soundEngine';
import { createAnatomyMeshPins } from '../../engine/meshWarpEngine';
import {
  evaluateCartoonRainWalkPose,
  renderMultiLayerRiggedCharacter,
  type ArticulatedCartoonPose,
} from '../../engine/cartoonMotionEngine';
import { getOrBuildCachedRigPack } from '../../engine/characterIntakeEngine';
import {
  getCachedSampleHeroCanvas,
  preloadSampleHeroCanvas,
} from '../../engine/sampleHeroAsset';
import { useT } from '../../i18n/translations';
import { InstantAliveStage } from './InstantAliveStage';

export type DeskPreviewMode = 'draw' | 'paper' | 'puppet' | 'film';

interface InteractiveLightboxStageProps {
  project: StudioProject | null;
  theme: StudioTheme;
  lightboxDim: number;
  onLightboxDimChange: (val: number) => void;
  previewMode: DeskPreviewMode;
  onPreviewModeChange: (mode: DeskPreviewMode) => void;
  onOpenDraw: () => void;
  onCommitSketch: (sketchCanvas: HTMLCanvasElement, frameIndex: number) => Promise<void>;
  onSendSketchToStudio: (
    sketchCanvas: HTMLCanvasElement,
    destination: 'draw' | 'puppet' | 'film',
    title?: string
  ) => Promise<void>;
  onOpenPaperDemo: () => void;
  onOpenPuppetDemo: () => Promise<void>;
  onOpenFilmDemo: () => Promise<void>;
}

const DESK_INK_COLORS = [
  { hex: '#1C1917', label: 'Sumi' },
  { hex: '#E54D2E', label: 'Vermilion' },
  { hex: '#2563EB', label: 'Eskiz' },
];

/** Draws a crisp pair of A4 before (warm desk photo + blue rough) & after (clean cel ink) canvases */
function buildInstantPaperComparisonCanvases(): {
  before: HTMLCanvasElement;
  after: HTMLCanvasElement;
} {
  const W = 960;
  const H = 540;
  const before = document.createElement('canvas');
  before.width = W;
  before.height = H;
  const bctx = before.getContext('2d')!;

  const after = document.createElement('canvas');
  after.width = W;
  after.height = H;
  const actx = after.getContext('2d')!;

  // BEFORE: Warm tungsten desk shadow gradient + paper creases + non-photo blue guides
  const bgGrad = bctx.createLinearGradient(0, 0, W, H);
  bgGrad.addColorStop(0, '#EFE4CE');
  bgGrad.addColorStop(0.55, '#E2D3B6');
  bgGrad.addColorStop(1, '#C7B493');
  bctx.fillStyle = bgGrad;
  bctx.fillRect(0, 0, W, H);

  // Subtle hand shadow across bottom-right corner
  const shadowGrad = bctx.createRadialGradient(W * 0.85, H * 0.85, 30, W * 0.85, H * 0.85, 340);
  shadowGrad.addColorStop(0, 'rgba(54, 40, 26, 0.28)');
  shadowGrad.addColorStop(1, 'rgba(54, 40, 26, 0)');
  bctx.fillStyle = shadowGrad;
  bctx.fillRect(0, 0, W, H);

  // Notebook ruled fold & 2x2 grid pencil dividers
  bctx.strokeStyle = 'rgba(110, 96, 76, 0.4)';
  bctx.lineWidth = 2;
  bctx.beginPath();
  bctx.moveTo(W / 2, 16);
  bctx.lineTo(W / 2, H - 16);
  bctx.moveTo(24, H / 2);
  bctx.lineTo(W - 24, H / 2);
  bctx.stroke();

  // AFTER: Pure studio cel ivory sheet with crisp dashed 2x2 slice markers
  actx.fillStyle = '#FAF6EE';
  actx.fillRect(0, 0, W, H);
  actx.strokeStyle = 'rgba(37, 99, 235, 0.28)';
  actx.setLineDash([6, 6]);
  actx.lineWidth = 1.5;
  actx.beginPath();
  actx.moveTo(W / 2, 16);
  actx.lineTo(W / 2, H - 16);
  actx.moveTo(24, H / 2);
  actx.lineTo(W - 24, H / 2);
  actx.stroke();
  actx.setLineDash([]);

  const poses = [
    { cx: W * 0.25, cy: H * 0.27, sx: 1.16, sy: 0.84, yOff: 18, arm: -12, happy: false },
    { cx: W * 0.75, cy: H * 0.27, sx: 0.86, sy: 1.18, yOff: -18, arm: -38, happy: true },
    { cx: W * 0.25, cy: H * 0.76, sx: 1.0, sy: 1.02, yOff: -24, arm: -46, happy: true },
    { cx: W * 0.75, cy: H * 0.76, sx: 1.22, sy: 0.78, yOff: 20, arm: 14, happy: false },
  ];

  for (const p of poses) {
    // Blue rough construction circles ONLY on BEFORE canvas (stripped on AFTER!)
    bctx.save();
    bctx.strokeStyle = 'rgba(37, 99, 235, 0.62)';
    bctx.lineWidth = 2.6;
    bctx.beginPath();
    bctx.ellipse(p.cx, p.cy + p.yOff, 48 * p.sx, 44 * p.sy, 0, 0, Math.PI * 2);
    bctx.stroke();
    bctx.beginPath();
    bctx.moveTo(p.cx - 64, p.cy + 58);
    bctx.lineTo(p.cx + 64, p.cy + 58);
    bctx.moveTo(p.cx, p.cy - 62);
    bctx.lineTo(p.cx, p.cy + 62);
    bctx.stroke();
    bctx.restore();

    // Draw character ink on both (slightly softer graphite on BEFORE, razor-crisp sumi + warm tint on AFTER)
    for (const [ctx, isClean] of [
      [bctx, false],
      [actx, true],
    ] as const) {
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = isClean ? '#181512' : 'rgba(38, 34, 30, 0.82)';
      ctx.fillStyle = isClean ? '#181512' : 'rgba(38, 34, 30, 0.82)';
      ctx.lineWidth = isClean ? 4.8 : 4.0;

      // Ground baseline
      ctx.beginPath();
      ctx.moveTo(p.cx - 78, p.cy + 62);
      ctx.lineTo(p.cx + 78, p.cy + 62);
      ctx.stroke();

      ctx.translate(p.cx, p.cy + p.yOff);
      ctx.scale(p.sx, p.sy);

      if (isClean) {
        // Subtle studio cel color fill on AFTER side!
        ctx.fillStyle = '#FFFDF7';
        ctx.beginPath();
        ctx.ellipse(0, 6, 40, 36, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#E54D2E';
        ctx.beginPath();
        ctx.moveTo(-34, -18);
        ctx.quadraticCurveTo(0, -76, 40, -34);
        ctx.quadraticCurveTo(8, -24, -34, -18);
        ctx.fill();
        ctx.fillStyle = '#181512';
      }

      // Body
      ctx.beginPath();
      ctx.ellipse(0, 6, 40, 36, 0, 0, Math.PI * 2);
      ctx.stroke();

      // Hat
      ctx.beginPath();
      ctx.moveTo(-34, -18);
      ctx.quadraticCurveTo(0, -76, 40, -34);
      ctx.quadraticCurveTo(8, -24, -34, -18);
      ctx.stroke();

      // Arms
      ctx.beginPath();
      ctx.moveTo(-38, 4);
      ctx.quadraticCurveTo(-58, p.arm, -66, p.arm - 8);
      ctx.moveTo(38, 4);
      ctx.quadraticCurveTo(58, p.arm, 66, p.arm - 8);
      ctx.stroke();

      // Expression
      if (!p.happy) {
        ctx.lineWidth = 3.6;
        ctx.beginPath();
        ctx.moveTo(-18, -3);
        ctx.lineTo(-8, 2);
        ctx.lineTo(-18, 7);
        ctx.moveTo(18, -3);
        ctx.lineTo(8, 2);
        ctx.lineTo(18, 7);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(-13, -1, 4.5, 0, Math.PI * 2);
        ctx.arc(13, -1, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(0, 9, 9, 0.15, Math.PI - 0.15);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  return { before, after };
}

/** Draws the illustrated beret studio puppet onto a fast offscreen canvas for instant 60fps desk warping */
function buildInstantPuppetSourceCanvas(): HTMLCanvasElement {
  const W = 440;
  const H = 480;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  const cx = W / 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Legs + Ochre Boots
  ctx.strokeStyle = '#1C1917';
  ctx.lineWidth = 11;
  ctx.beginPath();
  ctx.moveTo(cx - 34, 326);
  ctx.lineTo(cx - 42, 404);
  ctx.moveTo(cx + 34, 326);
  ctx.lineTo(cx + 42, 404);
  ctx.stroke();

  ctx.fillStyle = '#D99B26';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.ellipse(cx - 48, 412, 20, 11, -0.08, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(cx + 48, 412, 20, 11, 0.08, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Arms + Mittens
  ctx.lineWidth = 11;
  ctx.beginPath();
  ctx.moveTo(cx - 52, 218);
  ctx.quadraticCurveTo(cx - 94, 232, cx - 118, 202);
  ctx.moveTo(cx + 52, 218);
  ctx.quadraticCurveTo(cx + 94, 232, cx + 118, 202);
  ctx.stroke();

  ctx.fillStyle = '#EFE6D5';
  ctx.lineWidth = 5;
  for (const hx of [cx - 120, cx + 120]) {
    ctx.beginPath();
    ctx.arc(hx, 200, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  // Charcoal Tunic
  ctx.fillStyle = '#2B2622';
  ctx.beginPath();
  ctx.moveTo(cx - 52, 200);
  ctx.quadraticCurveTo(cx - 72, 280, cx - 62, 336);
  ctx.quadraticCurveTo(cx, 350, cx + 62, 336);
  ctx.quadraticCurveTo(cx + 72, 280, cx + 52, 200);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Vermilion Scarf
  ctx.fillStyle = '#E54D2E';
  ctx.beginPath();
  ctx.roundRect(cx - 56, 184, 112, 26, 12);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx + 34, 206);
  ctx.quadraticCurveTo(cx + 62, 246, cx + 44, 286);
  ctx.lineTo(cx + 22, 276);
  ctx.quadraticCurveTo(cx + 34, 240, cx + 16, 206);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Ivory Head + Beret
  ctx.fillStyle = '#FAF3E4';
  ctx.lineWidth = 5.5;
  ctx.beginPath();
  ctx.ellipse(cx, 132, 58, 54, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#D99B26';
  ctx.beginPath();
  ctx.ellipse(cx - 4, 78, 65, 22, -0.14, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - 6, 56);
  ctx.quadraticCurveTo(cx - 2, 42, cx + 10, 44);
  ctx.stroke();

  // Rosy Cheeks, Eyes & Cheerful Smile
  ctx.fillStyle = 'rgba(229, 77, 46, 0.25)';
  ctx.beginPath();
  ctx.ellipse(cx - 33, 144, 11, 6, 0, 0, Math.PI * 2);
  ctx.ellipse(cx + 33, 144, 11, 6, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#1C1917';
  for (const ex of [cx - 22, cx + 22]) {
    ctx.beginPath();
    ctx.ellipse(ex, 128, 7, 10, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#FAF6EE';
    ctx.beginPath();
    ctx.arc(ex - 2.5, 124, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1C1917';
  }

  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(cx, 145, 11, 0.15, Math.PI - 0.15);
  ctx.stroke();

  return c;
}

export function InteractiveLightboxStage({
  project,
  theme,
  lightboxDim,
  onLightboxDimChange,
  previewMode,
  onPreviewModeChange,
  onOpenDraw,
  onCommitSketch,
  onSendSketchToStudio,
  onOpenPaperDemo,
  onOpenPuppetDemo,
  onOpenFilmDemo,
}: InteractiveLightboxStageProps) {
  const t = useT();
  const [stageView, setStageView] = useState<'live' | 'showcase'>('live');

  // ---- MODE 4: Live Interactive 6-Layer 2.5D Parallax Mini-Cinema ----
  const filmCanvasRef = useRef<HTMLCanvasElement>(null);
  const filmLookRef = useRef({ tx: 0, ty: 0, x: 0, y: 0 });

  // ---- MODE 1: Live Flipbook + Direct On-Paper G-Pen Ink Sketching ----
  const [showcaseIdx, setShowcaseIdx] = useState(0);
  const [showcasePlaying, setShowcasePlaying] = useState(true);
  const [inkColor, setInkColor] = useState('#1C1917');
  const [strokeCount, setStrokeCount] = useState(0);
  const [committing, setCommitting] = useState(false);

  const sketchCanvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef<{ active: boolean; lx: number; ly: number; lt: number; lw: number }>({
    active: false,
    lx: 0,
    ly: 0,
    lt: 0,
    lw: 6,
  });

  const frameCount = Math.max(1, project?.frames.length ?? 1);
  const activeShowcaseIdx = showcaseIdx % frameCount;
  const activeShowcaseFrame = project?.frames[activeShowcaseIdx] ?? null;

  useEffect(() => {
    if (stageView !== 'showcase' || previewMode !== 'draw' || !showcasePlaying || !project || project.frames.length <= 1) return;
    const ms = Math.max(65, Math.round(1000 / project.fps));
    const iv = setInterval(() => {
      setShowcaseIdx((i) => (i + 1) % project.frames.length);
    }, ms);
    return () => clearInterval(iv);
  }, [stageView, previewMode, showcasePlaying, project]);

  const clearDeskSketch = useCallback(() => {
    const c = sketchCanvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    ctx?.clearRect(0, 0, c.width, c.height);
    setStrokeCount(0);
  }, []);

  const toSketchPt = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = sketchCanvasRef.current!;
    const r = c.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / Math.max(1, r.width)) * c.width,
      y: ((e.clientY - r.top) / Math.max(1, r.height)) * c.height,
    };
  };

  const onSketchDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (previewMode !== 'draw') return;
    const c = sketchCanvasRef.current;
    if (!c) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setShowcasePlaying(false);
    const pt = toSketchPt(e);
    drawingRef.current = { active: true, lx: pt.x, ly: pt.y, lt: performance.now(), lw: 6.5 };
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = inkColor;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 3.2, 0, Math.PI * 2);
    ctx.fill();
    setStrokeCount((s) => s + 1);
  };

  const onSketchMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current.active) return;
    const c = sketchCanvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    const pt = toSketchPt(e);
    const now = performance.now();
    const dt = Math.max(1, now - drawingRef.current.lt);
    const dist = Math.hypot(pt.x - drawingRef.current.lx, pt.y - drawingRef.current.ly);
    const vel = dist / dt;
    const targetW = Math.max(2.6, Math.min(9.5, 8.2 - vel * 2.2));
    const lw = drawingRef.current.lw * 0.65 + targetW * 0.35;

    ctx.strokeStyle = inkColor;
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(drawingRef.current.lx, drawingRef.current.ly);
    ctx.lineTo(pt.x, pt.y);
    ctx.stroke();

    drawingRef.current = { active: true, lx: pt.x, ly: pt.y, lt: now, lw };
  };

  const onSketchUp = () => {
    drawingRef.current.active = false;
  };

  const handleCommitSketch = async () => {
    const c = sketchCanvasRef.current;
    if (!c || committing) return;
    setCommitting(true);
    try {
      soundEngine.clapperSnap();
      await onCommitSketch(c, activeShowcaseIdx);
      clearDeskSketch();
    } finally {
      setCommitting(false);
    }
  };

  // ---- MODE 2: Interactive A4 Before/After Split Wipe Curtain ----
  const [curtainPct, setCurtainPct] = useState(52);
  const paperCanvasRef = useRef<HTMLCanvasElement>(null);
  const paperPairRef = useRef<{ before: HTMLCanvasElement; after: HTMLCanvasElement } | null>(null);
  const draggingCurtainRef = useRef(false);

  useEffect(() => {
    if (stageView !== 'showcase' || previewMode !== 'paper') return;
    if (!paperPairRef.current) {
      paperPairRef.current = buildInstantPaperComparisonCanvases();
    }
    const c = paperCanvasRef.current;
    const pair = paperPairRef.current;
    if (!c || !pair) return;
    const ctx = c.getContext('2d')!;
    const splitX = Math.round((curtainPct / 100) * c.width);

    // Right side: Clean cel
    ctx.drawImage(pair.after, 0, 0, c.width, c.height);
    // Left side: Shadowed A4 photo + blue pencil
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, splitX, c.height);
    ctx.clip();
    ctx.drawImage(pair.before, 0, 0, c.width, c.height);
    ctx.restore();

    // Vermilion dividing line
    ctx.strokeStyle = '#E54D2E';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(splitX, 0);
    ctx.lineTo(splitX, c.height);
    ctx.stroke();
  }, [stageView, previewMode, curtainPct]);

  const updateCurtainFromPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const pct = Math.max(6, Math.min(94, ((e.clientX - r.left) / Math.max(1, r.width)) * 100));
    setCurtainPct(Math.round(pct));
  };

  // ---- MODE 3: Interactive Live 2D Mesh Rubber-Hose Puppet Sandbox ----
  const puppetCanvasRef = useRef<HTMLCanvasElement>(null);
  const puppetSourceRef = useRef<HTMLCanvasElement | null>(null);
  const puppetPinsRef = useRef<MeshPin[]>([]);
  const puppetOffsetsRef = useRef<MeshFrameOffsets>({});
  const puppetDragRef = useRef<{ pinId: string; startX: number; startY: number } | null>(null);
  const [draggingPinLabel, setDraggingPinLabel] = useState<string | null>(null);

  useEffect(() => {
    if (stageView !== 'showcase' || previewMode !== 'puppet') return;
    let cancelled = false;
    const syncHeroSource = (hero: HTMLCanvasElement) => {
      if (cancelled) return;
      puppetSourceRef.current = hero;
      const pack = getOrBuildCachedRigPack(hero);
      puppetPinsRef.current = createAnatomyMeshPins(pack.anatomy, 'humanoid');
      puppetOffsetsRef.current = {};
    };
    const cachedHero = getCachedSampleHeroCanvas();
    if (cachedHero) {
      syncHeroSource(cachedHero);
    } else {
      if (!puppetSourceRef.current) {
        syncHeroSource(buildInstantPuppetSourceCanvas());
      }
      void preloadSampleHeroCanvas().then((hero) => {
        if (hero) syncHeroSource(hero);
      });
    }

    let raf = 0;
    const startMs = performance.now();

    const loop = () => {
      const c = puppetCanvasRef.current;
      const src = puppetSourceRef.current;
      if (!c || !src) return;
      const ctx = c.getContext('2d')!;
      const W = c.width;
      const H = c.height;
      const elapsed = (performance.now() - startMs) / 1000;

      // Spring-back relaxation on non-dragged pins!
      const pins = puppetPinsRef.current;
      const curOffsets = puppetOffsetsRef.current;
      const activeDragId = puppetDragRef.current?.pinId ?? null;
      const combined: MeshFrameOffsets = {};

      for (const pin of pins) {
        const stored = curOffsets[pin.id] ?? { dx: 0, dy: 0 };
        if (pin.id !== activeDragId) {
          stored.dx *= 0.84;
          stored.dy *= 0.84;
          if (Math.abs(stored.dx) < 0.0005) stored.dx = 0;
          if (Math.abs(stored.dy) < 0.0005) stored.dy = 0;
          curOffsets[pin.id] = stored;
        }
        const breath = Math.sin(elapsed * 2.6);
        let idleDx = 0;
        let idleDy = 0;
        if (pin.role === 'head') idleDy = breath * 0.01;
        else if (pin.role === 'hand-l') {
          idleDx = -Math.sin(elapsed * 2.1) * 0.02;
          idleDy = Math.cos(elapsed * 2.6) * 0.02;
        }
        combined[pin.id] = { dx: stored.dx + idleDx, dy: stored.dy + idleDy };
      }

      ctx.fillStyle = project?.paperColor || '#F7F3E9';
      ctx.fillRect(0, 0, W, H);

      // Soft studio floor shadow
      ctx.fillStyle = 'rgba(28, 25, 23, 0.11)';
      ctx.beginPath();
      ctx.ellipse(W / 2, H * 0.88, 128, 18, 0, 0, Math.PI * 2);
      ctx.fill();

      const scale = Math.min((W * 0.78) / src.width, (H * 0.82) / src.height);
      const drawW = src.width * scale;
      const drawH = src.height * scale;
      const drawX = (W - drawW) / 2;
      const drawY = (H - drawH) / 2;

      const pack = getOrBuildCachedRigPack(src);
      const rootPin = pins.find((p) => p.role === 'root') ?? pins[0];
      const headPin = pins.find((p) => p.role === 'head');
      const handLPin = pins.find((p) => p.role === 'hand-l');
      const handRPin = pins.find((p) => p.role === 'hand-r');
      const footLPin = pins.find((p) => p.role === 'foot-l');
      const footRPin = pins.find((p) => p.role === 'foot-r');

      const rO = rootPin ? combined[rootPin.id] ?? { dx: 0, dy: 0 } : { dx: 0, dy: 0 };
      const hO = headPin ? combined[headPin.id] ?? { dx: 0, dy: 0 } : { dx: 0, dy: 0 };
      const hlO = handLPin ? combined[handLPin.id] ?? { dx: 0, dy: 0 } : { dx: 0, dy: 0 };
      const hrO = handRPin ? combined[handRPin.id] ?? { dx: 0, dy: 0 } : { dx: 0, dy: 0 };
      const flO = footLPin ? combined[footLPin.id] ?? { dx: 0, dy: 0 } : { dx: 0, dy: 0 };
      const frO = footRPin ? combined[footRPin.id] ?? { dx: 0, dy: 0 } : { dx: 0, dy: 0 };
      const relHx = hO.dx - rO.dx;
      const relHy = hO.dy - rO.dy;
      const sqY = Math.max(0.88, Math.min(1.14, 1 - relHy * 1.25));
      const skel = pack.skinnedMesh;
      const demoPose: ArticulatedCartoonPose = {
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
        blink: (elapsed % 3.5) < 0.12 ? 1 : 0,
        facing: 1,
      };
      const anc = renderMultiLayerRiggedCharacter(
        ctx,
        pack,
        demoPose,
        { x: drawX, y: drawY, w: drawW, h: drawH },
        {
          boilTick: Math.floor(elapsed * 6),
          ikOverrides:
            skel && skel.bones.length >= 11
              ? (() => {
                  const hL = skel.bones.length >= 17 ? skel.bones[14].end : skel.bones[4].end;
                  const hR = skel.bones.length >= 17 ? skel.bones[16].end : skel.bones[6].end;
                  const fL = skel.footLeft?.ball ?? skel.bones[8].end;
                  const fR = skel.footRight?.ball ?? skel.bones[10].end;
                  return {
                    handLeft: { x: drawX + (hL.x + hlO.dx) * drawW, y: drawY + (hL.y + hlO.dy) * drawH },
                    handRight: { x: drawX + (hR.x + hrO.dx) * drawW, y: drawY + (hR.y + hrO.dy) * drawH },
                    footLeft: { x: drawX + (fL.x + flO.dx) * drawW, y: drawY + (fL.y + flO.dy) * drawH },
                    footRight: { x: drawX + (fR.x + frO.dx) * drawW, y: drawY + (fR.y + frO.dy) * drawH },
                    headOffset: { x: relHx * drawW * 0.22, y: relHy * drawH * 0.22 },
                  };
                })()
              : null,
        }
      );

      const getPinPt = (pin: MeshPin) => {
        if (pin.role === 'root') return anc.pelvisScreen;
        if (pin.role === 'head') return { x: anc.headTopScreen.x, y: anc.headTopScreen.y + drawH * 0.1 };
        if (pin.role === 'hand-l') return anc.handLeftScreen;
        if (pin.role === 'hand-r') return anc.handRightScreen;
        if (pin.role === 'foot-l') return anc.footLeftScreen;
        if (pin.role === 'foot-r') return anc.footRightScreen;
        const off = combined[pin.id] ?? { dx: 0, dy: 0 };
        return { x: drawX + (pin.x + off.dx) * drawW, y: drawY + (pin.y + off.dy) * drawH };
      };

      const rp = rootPin ? getPinPt(rootPin) : { x: W / 2, y: H / 2 };

      ctx.save();
      ctx.strokeStyle = 'rgba(217, 155, 38, 0.45)';
      ctx.setLineDash([5, 5]);
      ctx.lineWidth = 2;
      for (const pin of pins) {
        if (rootPin && pin.id === rootPin.id) continue;
        const pt = getPinPt(pin);
        ctx.beginPath();
        ctx.moveTo(rp.x, rp.y);
        ctx.lineTo(pt.x, pt.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      for (const pin of pins) {
        const pt = getPinPt(pin);
        const isGrabbed = activeDragId === pin.id;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, isGrabbed ? 12 : 9, 0, Math.PI * 2);
        ctx.fillStyle = isGrabbed ? '#E54D2E' : pin.role === 'root' ? '#D99B26' : '#2563EB';
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#FFFDF8';
        ctx.stroke();
      }
      ctx.restore();

      raf = requestAnimationFrame(loop);
    };

    raf = requestAnimationFrame(loop);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [stageView, previewMode, project?.paperColor]);

  const onPuppetPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = puppetCanvasRef.current;
    const src = puppetSourceRef.current;
    if (!c || !src) return;
    const r = c.getBoundingClientRect();
    const x = ((e.clientX - r.left) / Math.max(1, r.width)) * c.width;
    const y = ((e.clientY - r.top) / Math.max(1, r.height)) * c.height;

    const scale = Math.min((c.width * 0.82) / src.width, (c.height * 0.86) / src.height);
    const drawW = src.width * scale;
    const drawH = src.height * scale;
    const drawX = (c.width - drawW) / 2;
    const drawY = (c.height - drawH) / 2;

    let bestPin: MeshPin | null = null;
    let bestDist = 72; // Generous grab radius for instant effortless fun!
    for (const pin of puppetPinsRef.current) {
      const off = puppetOffsetsRef.current[pin.id] ?? { dx: 0, dy: 0 };
      const px = drawX + (pin.x + off.dx) * drawW;
      const py = drawY + (pin.y + off.dy) * drawH;
      const d = Math.hypot(x - px, y - py);
      if (d < bestDist) {
        bestDist = d;
        bestPin = pin;
      }
    }
    if (bestPin) {
      e.currentTarget.setPointerCapture(e.pointerId);
      puppetDragRef.current = { pinId: bestPin.id, startX: x, startY: y };
      setDraggingPinLabel(bestPin.label);
      soundEngine.click(1.18);
    }
  };

  const onPuppetPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = puppetDragRef.current;
    const c = puppetCanvasRef.current;
    const src = puppetSourceRef.current;
    if (!drag || !c || !src) return;
    const r = c.getBoundingClientRect();
    const x = ((e.clientX - r.left) / Math.max(1, r.width)) * c.width;
    const y = ((e.clientY - r.top) / Math.max(1, r.height)) * c.height;

    const scale = Math.min((c.width * 0.82) / src.width, (c.height * 0.86) / src.height);
    const drawW = src.width * scale;
    const drawH = src.height * scale;
    const dx = Math.max(-0.28, Math.min(0.28, (x - drag.startX) / drawW));
    const dy = Math.max(-0.28, Math.min(0.28, (y - drag.startY) / drawH));
    puppetOffsetsRef.current[drag.pinId] = { dx, dy };
  };

  const onPuppetPointerUp = () => {
    if (puppetDragRef.current) {
      soundEngine.toggle(false);
    }
    puppetDragRef.current = null;
    setDraggingPinLabel(null);
  };

  // ---- MODE 4: 6-Layer 2.5D Parallax Rain-Lantern Live Mini-Cinema ----
  useEffect(() => {
    if (stageView !== 'showcase' || previewMode !== 'film') return;
    let raf = 0;
    const t0 = performance.now();

    const loop = (now: number) => {
      const c = filmCanvasRef.current;
      if (!c) {
        raf = requestAnimationFrame(loop);
        return;
      }
      const ctx = c.getContext('2d')!;
      const W = c.width;
      const H = c.height;
      const sec = (now - t0) / 1000;

      const lk = filmLookRef.current;
      lk.x += (lk.tx - lk.x) * 0.1;
      lk.y += (lk.ty - lk.y) * 0.1;
      const camX = lk.x * 58 + Math.sin(sec * 0.55) * 14;
      const camY = lk.y * 20;

      // Layer 1 (Z0 Sky): Deep stormy indigo-charcoal night sky + glowing moon halo
      const sky = ctx.createLinearGradient(0, 0, 0, H);
      sky.addColorStop(0, '#0F1422');
      sky.addColorStop(0.55, '#1B2233');
      sky.addColorStop(1, '#282321');
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, W, H);

      const moonX = W * 0.74 - camX * 0.12;
      const moonY = H * 0.24 - camY * 0.12;
      const halo = ctx.createRadialGradient(moonX, moonY, 8, moonX, moonY, 150);
      halo.addColorStop(0, 'rgba(255, 240, 200, 0.42)');
      halo.addColorStop(0.45, 'rgba(139, 185, 255, 0.14)');
      halo.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#F7EFE0';
      ctx.beginPath();
      ctx.arc(moonX, moonY, 24, 0, Math.PI * 2);
      ctx.fill();

      // Layer 2 (Z1 Far Mountains / Roof Silhouettes)
      ctx.save();
      ctx.translate(-camX * 0.25, -camY * 0.2);
      ctx.fillStyle = '#151A27';
      ctx.beginPath();
      ctx.moveTo(-80, H);
      ctx.lineTo(-80, H * 0.58);
      ctx.lineTo(140, H * 0.42);
      ctx.lineTo(310, H * 0.54);
      ctx.lineTo(540, H * 0.36);
      ctx.lineTo(780, H * 0.5);
      ctx.lineTo(W + 100, H * 0.4);
      ctx.lineTo(W + 100, H);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // Layer 3 (Z2 Midground Illustrated Townhouse Facades + Warm Lit Windows)
      ctx.save();
      ctx.translate(-camX * 0.55, -camY * 0.35);
      const buildings = [
        { x: 40, w: 155, h: 255 },
        { x: 205, w: 135, h: 215 },
        { x: 350, w: 185, h: 280 },
        { x: 545, w: 145, h: 230 },
        { x: 700, w: 200, h: 265 },
      ];
      for (let bi = 0; bi < buildings.length; bi++) {
        const b = buildings[bi];
        const by = H * 0.78 - b.h;
        ctx.fillStyle = bi % 2 === 0 ? '#1C1D25' : '#232128';
        ctx.strokeStyle = '#0F0F13';
        ctx.lineWidth = 2;
        ctx.fillRect(b.x, by, b.w, b.h);
        ctx.strokeRect(b.x, by, b.w, b.h);
        // Warm Klaus lit windows
        for (let wy = by + 28; wy < H * 0.72; wy += 52) {
          for (let wx = b.x + 22; wx < b.x + b.w - 30; wx += 48) {
            const lit = (bi + Math.floor(wx / 40) + Math.floor(wy / 50)) % 3 !== 0;
            ctx.fillStyle = lit ? 'rgba(248, 198, 96, 0.85)' : 'rgba(28, 34, 52, 0.85)';
            ctx.fillRect(wx, wy, 22, 30);
          }
        }
      }
      ctx.restore();

      // Layer 4 (Z3 Cobblestone Wet Street + Streetlamp + Reflections)
      ctx.save();
      ctx.translate(-camX * 0.8, -camY * 0.5);
      const roadGrad = ctx.createLinearGradient(0, H * 0.74, 0, H);
      roadGrad.addColorStop(0, '#222126');
      roadGrad.addColorStop(1, '#131215');
      ctx.fillStyle = roadGrad;
      ctx.fillRect(-100, H * 0.74, W + 200, H * 0.32);

      // Streetlamp casting warm golden pool on wet stones
      const lampX = W * 0.63;
      const lampTopY = H * 0.26;
      const lampGlow = ctx.createRadialGradient(lampX, lampTopY + 18, 6, lampX, lampTopY + 60, 230);
      lampGlow.addColorStop(0, 'rgba(255, 224, 138, 0.65)');
      lampGlow.addColorStop(0.45, 'rgba(229, 152, 54, 0.18)');
      lampGlow.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = lampGlow;
      ctx.fillRect(lampX - 240, lampTopY - 80, 480, 460);

      ctx.strokeStyle = '#121110';
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(lampX + 26, H * 0.78);
      ctx.lineTo(lampX + 26, lampTopY);
      ctx.quadraticCurveTo(lampX + 26, lampTopY - 14, lampX, lampTopY - 6);
      ctx.stroke();
      ctx.fillStyle = '#FFF0B8';
      ctx.beginPath();
      ctx.arc(lampX, lampTopY + 6, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // Layer 5 (Z4 Şapkalı Baron Walking in 2.5D Rainy Alley + Klaus Rim Light)
      ctx.save();
      const walkBob = Math.abs(Math.sin(sec * 5.2)) * 9;
      const hx = W * 0.43 - camX * 1.0 + Math.sin(sec * 0.7) * 26;
      const hy = H * 0.75 - camY * 0.6 - walkBob;

      // Ground contact shadow
      const filmGroundY = H * 0.79 - camY * 0.6;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
      ctx.beginPath();
      ctx.ellipse(hx, filmGroundY + 3, 48, 10, 0, 0, Math.PI * 2);
      ctx.fill();

      // Render Şapkalı Baron via flagship WebGL2 Conforming Skinned Mesh!
      const filmHero = getCachedSampleHeroCanvas();
      if (filmHero) {
        const fPack = getOrBuildCachedRigPack(filmHero);
        const fH = H * 0.42;
        const fW = fH * (filmHero.width / Math.max(1, filmHero.height));
        const fPose = evaluateCartoonRainWalkPose(sec, fPack.anatomy, 24, 'natural', 0);
        renderMultiLayerRiggedCharacter(
          ctx,
          fPack,
          fPose,
          {
            x: hx - fW * fPack.anatomy.centerX,
            y: filmGroundY - fH * fPack.anatomy.groundV,
            w: fW,
            h: fH,
          },
          {
            boilTick: Math.floor(sec * 6),
            klausLight: {
              lx: 0.78,
              ly: -0.45,
              rimR: 1.0,
              rimG: 0.84,
              rimB: 0.5,
              rimStrength: 0.72,
              shadowR: 0.07,
              shadowG: 0.1,
              shadowB: 0.22,
              shadowStrength: 0.32,
            },
            nightLampPos: { x: W * 0.62 - camX * 0.5, y: H * 0.34 - camY * 0.35 },
          }
        );
      } else {
        void preloadSampleHeroCanvas();
        ctx.fillStyle = '#25211E';
        ctx.strokeStyle = '#F7C968';
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.roundRect(hx - 24, hy - 74, 48, 56, 16);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();

      // Layer 6 (Z5 Foreground Parallax Rain Streaks + Cinema 2.39:1 Letterbox Bars)
      ctx.save();
      ctx.strokeStyle = 'rgba(186, 214, 255, 0.34)';
      ctx.lineWidth = 1.4;
      for (let r = 0; r < 56; r++) {
        const rx = ((r * 83 + sec * 240 - camX * 1.45) % (W + 120) + (W + 120)) % (W + 120) - 60;
        const ry = ((r * 61 + sec * 520) % (H + 80)) - 40;
        ctx.beginPath();
        ctx.moveTo(rx, ry);
        ctx.lineTo(rx - 9, ry + 26);
        ctx.stroke();
      }
      // Subtle 35mm cinema letterbox bars
      ctx.fillStyle = 'rgba(8, 8, 10, 0.82)';
      ctx.fillRect(0, 0, W, 30);
      ctx.fillRect(0, H - 30, W, 30);
      ctx.restore();

      raf = requestAnimationFrame(loop);
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [stageView, previewMode]);

  const glowIntensity = theme === 'night' ? 0.08 + lightboxDim * 0.16 : 0.14;

  return (
    <div className="desk-lightbox-bezel desk-lightbox-warmup rounded-[26px] p-3.5 sm:p-5 flex flex-col gap-3 select-none">
      {/* Top Bezel Header: Backlit LED + Clean 2-Pill Mode Switcher (No duplicate 4-card clutter!) */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-ink-brass">
          <span className="hardware-led" data-on="amber" data-pulse="true" />
          <span>{t('lightboxLabel')}</span>
        </div>

        <div
          role="tablist"
          aria-label="Işıklı Masa Görünümü"
          className="flex items-center gap-1 p-0.5 rounded-xl console-well border border-desk-border"
        >
          <button
            type="button"
            role="tab"
            aria-selected={stageView === 'live'}
            onClick={() => {
              soundEngine.click(1.12);
              setStageView('live');
            }}
            className={`px-2.5 py-1 rounded-lg font-mono text-[10px] font-bold inline-flex items-center gap-1.5 transition-all whitespace-nowrap ${
              stageView === 'live'
                ? 'bg-desk-panel text-desk-text border border-desk-border shadow-sm'
                : 'text-desk-muted hover:text-desk-text border border-transparent'
            }`}
          >
            <span className="hardware-led" data-on={stageView === 'live' ? 'vermilion' : undefined} />
            {t('magicTabLive')}
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={stageView === 'showcase'}
            onClick={() => {
              soundEngine.click(1.04);
              setStageView('showcase');
            }}
            className={`px-2.5 py-1 rounded-lg font-mono text-[10px] font-bold inline-flex items-center gap-1.5 transition-all whitespace-nowrap ${
              stageView === 'showcase'
                ? 'bg-desk-panel text-desk-text border border-desk-border shadow-sm'
                : 'text-desk-muted hover:text-desk-text border border-transparent'
            }`}
          >
            <span className="hardware-led" data-on={stageView === 'showcase' ? 'amber' : undefined} />
            {t('magicTabShowcase')}
          </button>
        </div>
      </div>

      {/* DEFAULT VIEW: 3-Second "Draw -> ANIMATE ⚡" Instant Magic Toy! */}
      {stageView === 'live' ? (
        <InstantAliveStage
          theme={theme}
          lightboxDim={lightboxDim}
          onLightboxDimChange={onLightboxDimChange}
          onSendToStudio={onSendSketchToStudio}
          onOpenBlankDesk={onOpenDraw}
        />
      ) : (
        <>
          {/* Compact 4-Demo Sub-Bar (Only visible when user chooses "Örnek Sahneler") */}
          <div className="flex items-center justify-center">
            <div
              role="tablist"
              aria-label="Örnek Sahneler"
              className="flex items-center gap-0.5 sm:gap-1 p-0.5 rounded-xl console-well border border-desk-border max-w-full overflow-x-auto"
            >
              {(
                [
                  { id: 'draw', label: t('modeDrawPill'), dot: 'amber' },
                  { id: 'paper', label: t('modePaperPill'), dot: 'vermilion' },
                  { id: 'puppet', label: t('modePuppetPill'), dot: 'emerald' },
                  { id: 'film', label: t('modeFilmPill'), dot: 'blue' },
                ] as const
              ).map((m) => {
                const active = previewMode === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => {
                      soundEngine.click(active ? 0.95 : 1.1);
                      onPreviewModeChange(m.id);
                    }}
                    className={`px-2 sm:px-2.5 py-1 rounded-lg font-mono text-[9.5px] sm:text-[10px] font-bold inline-flex items-center gap-1 sm:gap-1.5 transition-all whitespace-nowrap shrink-0 ${
                      active
                        ? 'bg-desk-panel text-desk-text border border-desk-border shadow-sm'
                        : 'text-desk-muted hover:text-desk-text border border-transparent'
                    }`}
                  >
                    <span className="hardware-led" data-on={active ? m.dot : undefined} />
                    {m.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Physical ACME Pegbar + Glowing Backlit Interactive Glass Sheet */}
          <div className="relative mx-auto w-full max-w-[740px] aspect-video mt-3">
        {/* Authentic 3-Hole ACME Pegbar */}
        <div
          className="absolute -top-5 left-1/2 -translate-x-1/2 h-5 px-5 rounded-t-lg bg-[#d8d1c2] border border-b-0 border-[#b2a996] flex items-center gap-6 pointer-events-none z-20 shadow-sm"
          aria-hidden="true"
        >
          <span className="w-2.5 h-2.5 rounded-full bg-[#2a2723]" />
          <span className="w-8 h-2 rounded-full bg-[#2a2723]" />
          <span className="w-2.5 h-2.5 rounded-full bg-[#2a2723]" />
        </div>

        <div
          className="relative w-full h-full rounded-xl overflow-hidden border border-black/25 transition-shadow duration-300"
          style={{
            backgroundColor: project?.paperColor || '#F7F3E9',
            filter: `brightness(${(0.76 + lightboxDim * 0.24).toFixed(2)})`,
            boxShadow:
              theme === 'night'
                ? `0 0 ${Math.round(35 + lightboxDim * 55)}px rgba(247, 234, 198, ${glowIntensity.toFixed(2)}), 0 24px 54px rgba(0,0,0,0.74)`
                : '0 20px 44px rgba(45, 37, 25, 0.2)',
          }}
        >
          {/* ====== LIVE MODE 1: DRAW DIRECTLY ON THE BACKLIT SHEET ====== */}
          {previewMode === 'draw' && (
            <>
              {activeShowcaseFrame?.thumbKey ? (
                <BlobImage
                  blobKey={activeShowcaseFrame.thumbKey}
                  alt={project?.name ?? 'Flipbook'}
                  className="w-full h-full object-contain pointer-events-none select-none"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center font-mono text-xs text-neutral-500">
                  {t('lightboxReady')}
                </div>
              )}

              {/* Direct 60fps G-Pen Drawing Overlay */}
              <canvas
                ref={sketchCanvasRef}
                width={1280}
                height={720}
                onPointerDown={onSketchDown}
                onPointerMove={onSketchMove}
                onPointerUp={onSketchUp}
                onPointerCancel={onSketchUp}
                className="absolute inset-0 w-full h-full cursor-crosshair touch-none z-10"
              />

              {/* Subtle floating ink palette & prompt pill */}
              <div className="absolute top-2.5 left-2.5 right-2.5 flex items-center justify-between gap-2 pointer-events-none z-20">
                <div className="px-2.5 py-1 rounded-full bg-neutral-950/75 backdrop-blur-sm text-[#F7F3E9] font-mono text-[10px] flex items-center gap-1.5 shadow min-w-0">
                  <span className="w-1.5 h-1.5 rounded-full bg-ink-vermilion animate-pulse shrink-0" />
                  <span className="truncate">{t('drawHint')}</span>
                </div>

                <div className="pointer-events-auto flex items-center gap-1 px-1.5 py-1 rounded-full bg-neutral-950/80 backdrop-blur-sm border border-white/15 shadow">
                  {DESK_INK_COLORS.map((c) => (
                    <button
                      key={c.hex}
                      type="button"
                      onClick={() => {
                        soundEngine.click(1.1);
                        setInkColor(c.hex);
                      }}
                      className={`w-4 h-4 rounded-full border transition-transform ${
                        inkColor === c.hex ? 'border-white scale-110 ring-1 ring-white/80' : 'border-white/30'
                      }`}
                      style={{ backgroundColor: c.hex }}
                      title={c.label}
                      aria-label={c.label}
                    />
                  ))}
                  {strokeCount > 0 && (
                    <button
                      type="button"
                      onClick={clearDeskSketch}
                      className="ml-0.5 p-0.5 rounded-full text-[#F7F3E9]/80 hover:text-ink-vermilion transition-colors"
                      title={t('drawClear')}
                      aria-label={t('drawClear')}
                    >
                      <Eraser className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>

              {/* Instant "Commit Sketch to Frame 1" CTA once user draws! */}
              {strokeCount > 0 && (
                <div className="absolute bottom-2.5 right-2.5 z-20">
                  <KeycapButton
                    size="sm"
                    variant="vermilion"
                    sheenPulse
                    disabled={committing}
                    onClick={() => void handleCommitSketch()}
                  >
                    <SketchNibIcon className="w-3.5 h-3.5" />
                    {t('drawCommitCta')}
                  </KeycapButton>
                </div>
              )}
            </>
          )}

          {/* ====== LIVE MODE 2: DRAGGABLE A4 BEFORE / AFTER WIPE ====== */}
          {previewMode === 'paper' && (
            <div
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                draggingCurtainRef.current = true;
                updateCurtainFromPointer(e);
              }}
              onPointerMove={(e) => {
                if (!draggingCurtainRef.current) return;
                updateCurtainFromPointer(e);
              }}
              onPointerUp={() => {
                draggingCurtainRef.current = false;
              }}
              className="relative w-full h-full cursor-ew-resize touch-none select-none"
            >
              <canvas ref={paperCanvasRef} width={960} height={540} className="w-full h-full block" />

              <span className="absolute top-2.5 left-2.5 px-2 py-0.5 rounded-md bg-neutral-950/80 text-[#F7F3E9] font-mono text-[9px] tracking-wider pointer-events-none">
                {t('paperBeforeTag')}
              </span>
              <span className="absolute top-2.5 right-2.5 px-2 py-0.5 rounded-md bg-ink-vermilion/90 text-white font-mono text-[9px] tracking-wider pointer-events-none">
                {t('paperAfterTag')} · {curtainPct}%
              </span>

              {/* Physical Brass/Vermilion Curtain Grab Handle */}
              <div
                className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-9 h-9 rounded-full bg-[#E54D2E] border-2 border-[#FAF6EE] shadow-xl flex items-center justify-center text-white pointer-events-none"
                style={{ left: `${curtainPct}%` }}
              >
                <MoveHorizontal className="w-4 h-4" />
              </div>
            </div>
          )}

          {/* ====== LIVE MODE 3: INTERACTIVE 2D MESH RUBBER PUPPET ====== */}
          {previewMode === 'puppet' && (
            <div className="relative w-full h-full select-none">
              <canvas
                ref={puppetCanvasRef}
                width={960}
                height={540}
                onPointerDown={onPuppetPointerDown}
                onPointerMove={onPuppetPointerMove}
                onPointerUp={onPuppetPointerUp}
                onPointerCancel={onPuppetPointerUp}
                className="w-full h-full block cursor-grab active:cursor-grabbing touch-none"
              />
              {draggingPinLabel && (
                <div className="absolute top-2.5 left-2.5 px-2.5 py-1 rounded-full bg-neutral-950/80 backdrop-blur-sm text-[#F7F3E9] font-mono text-[10px] flex items-center gap-1.5 pointer-events-none">
                  <span className="w-1.5 h-1.5 rounded-full bg-ink-emerald animate-pulse" />
                  <span>{draggingPinLabel}</span>
                </div>
              )}
            </div>
          )}

          {/* ====== LIVE MODE 4: INTERACTIVE LAYERED RAINY MINI-CINEMA ====== */}
          {previewMode === 'film' && (
            <div
              className="relative w-full h-full select-none"
              onPointerMove={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                filmLookRef.current.tx = ((e.clientX - r.left) / Math.max(1, r.width) - 0.5) * 2;
                filmLookRef.current.ty = ((e.clientY - r.top) / Math.max(1, r.height) - 0.5) * 2;
              }}
              onPointerLeave={() => {
                filmLookRef.current.tx = 0;
                filmLookRef.current.ty = 0;
              }}
            >
              <canvas ref={filmCanvasRef} width={960} height={540} className="w-full h-full block" />
              <div className="absolute top-2 left-2.5 px-2.5 py-0.5 rounded-full bg-neutral-950/80 backdrop-blur-sm text-[#F7F3E9] font-mono text-[9.5px] flex items-center gap-1.5 pointer-events-none">
                <span className="hardware-led" data-on="blue" data-pulse="true" />
                <span>{t('filmLiveBadge')}</span>
              </div>
            </div>
          )}

          <div className="absolute inset-0 paper-grain-overlay opacity-35 pointer-events-none z-10" />
        </div>
      </div>

      {/* Bottom Transport Console — Mobile-safe 2-row flex wrap so slider NEVER gets crushed! */}
      {previewMode === 'draw' && project && (
        <div className="rounded-2xl console-well border border-desk-border px-3 py-2.5 flex flex-col sm:flex-row sm:items-center gap-2.5">
          {/* Row 1 on mobile (middle on desktop): Full-width comfortable scrubber + note */}
          <div className="flex-1 flex flex-col gap-1 min-w-0 sm:order-2">
            <div className="flex items-center justify-between gap-2 font-mono text-[10px] text-desk-muted">
              <span className="truncate">
                {activeShowcaseFrame?.note || project.name || t('frameScrubFallback')}
              </span>
              <span className="shrink-0 text-desk-text/80">
                #{String(activeShowcaseIdx + 1).padStart(2, '0')}/{String(frameCount).padStart(2, '0')} · {project.fps} FPS
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={Math.max(0, frameCount - 1)}
              value={activeShowcaseIdx}
              onChange={(e) => {
                setShowcasePlaying(false);
                soundEngine.paperFlip();
                setShowcaseIdx(Number(e.target.value));
              }}
              className="studio-fader w-full"
              aria-label={t('frameScrubFallback')}
            />
          </div>

          {/* Row 2 on mobile (flanking on desktop): Tactile Play + Brass Dial + Dimmer + Open CTA */}
          <div className="flex items-center justify-between sm:contents gap-2">
            <div className="flex items-center gap-2 sm:order-1 shrink-0">
              <KeycapButton
                size="sm"
                variant="vermilion"
                led={showcasePlaying ? 'emerald' : 'off'}
                ledPulse={showcasePlaying}
                pressed={showcasePlaying}
                onClick={() => setShowcasePlaying((p) => !p)}
                title={t('playPause')}
              >
                <MotionPlayIcon playing={showcasePlaying} className="w-3.5 h-3.5" />
              </KeycapButton>

              <BrassRotaryDial
                value={activeShowcaseIdx}
                min={0}
                max={Math.max(1, frameCount - 1)}
                step={1}
                size={36}
                label={t('brassDialLabel')}
                onChange={(nextIdx) => {
                  setShowcasePlaying(false);
                  setShowcaseIdx(nextIdx);
                }}
              />
            </div>

            <div className="flex items-center gap-2 sm:order-3 shrink-0">
              <div
                className="hidden md:flex items-center gap-1.5 px-2 py-1 rounded-xl bg-desk-surface/65 border border-desk-border"
                title={t('dimmerLabel')}
              >
                <SunDim className="w-3.5 h-3.5 text-ink-brass" />
                <BrassRotaryDial
                  value={Math.round(lightboxDim * 100)}
                  min={40}
                  max={100}
                  step={10}
                  size={26}
                  label={t('dimmerLabel')}
                  onChange={(pct) => onLightboxDimChange(pct / 100)}
                />
              </div>

              <KeycapButton size="sm" variant="ivory" onClick={onOpenDraw}>
                <SketchNibIcon className="w-3.5 h-3.5" />
                {t('openOnDesk')}
              </KeycapButton>
            </div>
          </div>
        </div>
      )}

      {previewMode === 'paper' && (
        <div className="rounded-2xl console-well border border-desk-border px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2.5">
          <div className="text-xs text-desk-muted font-medium flex items-center gap-2">
            <Camera className="w-4 h-4 text-ink-vermilion shrink-0" />
            <span>{t('paperStageHint')}</span>
          </div>
          <KeycapButton
            size="sm"
            variant="vermilion"
            onClick={() => {
              soundEngine.shutter();
              onOpenPaperDemo();
            }}
          >
            {t('paperOpenCta')}
          </KeycapButton>
        </div>
      )}

      {previewMode === 'puppet' && (
        <div className="rounded-2xl console-well border border-desk-border px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2.5">
          <div className="text-xs text-desk-muted font-medium flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-ink-brass shrink-0" />
            <span>{t('puppetStageHint')}</span>
          </div>
          <KeycapButton
            size="sm"
            variant="brass"
            onClick={() => {
              soundEngine.click(1.15);
              void onOpenPuppetDemo();
            }}
          >
            {t('puppetOpenCta')}
          </KeycapButton>
        </div>
      )}

      {previewMode === 'film' && (
        <div className="rounded-2xl console-well border border-desk-border px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2.5">
          <div className="text-xs text-desk-muted font-medium flex items-center gap-2">
            <Clapperboard className="w-4 h-4 text-ink-blue shrink-0" />
            <span>{t('filmStageHint')}</span>
          </div>
          <KeycapButton
            size="sm"
            variant="brass"
            sheenPulse
            onClick={() => {
              soundEngine.projectorClick();
              void onOpenFilmDemo();
            }}
          >
            {t('filmOpenCta')}
          </KeycapButton>
        </div>
      )}
        </>
      )}
    </div>
  );
}
