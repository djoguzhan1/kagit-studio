import type {
  BrushSettings,
  CameraKeyframe,
  CelFrame,
  FieldGuideConfig,
  OnionSkinConfig,
  PaperStyleId,
  SceneAtmosphereId,
  ShapeKind,
} from '../types/studio';
import {
  canvasToPngBlob,
  canvasToWebpOrJpegBlob,
  getBlobBitmap,
  saveBlob,
} from './db';
import { runSmartFloodFill } from './paperWorkerClient';
import {
  GRAIN_TILE_SIZE,
  getGraphiteGrainCanvas,
  getScreentonePattern,
  renderPaperSurface,
} from './brushTextures';
import { renderUnderlayGuide } from './underlayGuides';
import { applySceneAtmosphere, evaluateCameraAtFrame } from './cameraEngine';
import { convertMultiplySourceToTransparentCanvas } from './frameComposite';
import { timelapseRecorder } from './timelapseRecorder';

export interface DirtyRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DirtyUndoEntry {
  layerId: string;
  rect: DirtyRect;
  before: Uint8ClampedArray;
  after: Uint8ClampedArray;
}

interface FrameHistoryBucket {
  undo: DirtyUndoEntry[];
  redo: DirtyUndoEntry[];
  bytes: number;
}

const MAX_TOTAL_HISTORY_BYTES = 48 * 1024 * 1024;

/** Pure helper: extracts a sub-rectangle from a full RGBA pixel buffer (10x less RAM than full-frame undo!) */
export function extractRgbaRect(
  fullRgba: Uint8ClampedArray,
  fullW: number,
  rect: DirtyRect
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rect.w * rect.h * 4);
  for (let row = 0; row < rect.h; row++) {
    const srcStart = ((rect.y + row) * fullW + rect.x) * 4;
    const dstStart = row * rect.w * 4;
    out.set(fullRgba.subarray(srcStart, srcStart + rect.w * 4), dstStart);
  }
  return out;
}

/** Pure helper: patches a dirty sub-rectangle back into a full RGBA pixel buffer */
export function applyRgbaRect(
  fullRgba: Uint8ClampedArray,
  fullW: number,
  rect: DirtyRect,
  patch: Uint8ClampedArray
): void {
  for (let row = 0; row < rect.h; row++) {
    const dstStart = ((rect.y + row) * fullW + rect.x) * 4;
    const srcStart = row * rect.w * 4;
    fullRgba.set(patch.subarray(srcStart, srcStart + rect.w * 4), dstStart);
  }
}

export interface FloatingSelection {
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
  w: number;
  h: number;
  dx: number;
  dy: number;
  rotation: number; // degrees
  scale: number;
  flipX: boolean;
}

/** Shared cross-frame lasso clipboard so Ctrl+C on Frame 1 -> Ctrl+V on Frame 2 works */
let sharedClipboard: {
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
  w: number;
  h: number;
} | null = null;

function hexToRgba(hex: string, alpha = 255): [number, number, number, number] {
  const clean = hex.replace('#', '');
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean.padEnd(6, '0');
  const n = parseInt(full.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, alpha];
}

function rgbToHex(r: number, g: number, b: number): string {
  return (
    '#' +
    [r, g, b]
      .map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  );
}

function getMaxUndoSteps(): number {
  const mem =
    typeof navigator !== 'undefined'
      ? (navigator as unknown as { deviceMemory?: number }).deviceMemory
      : 8;
  if (typeof mem === 'number' && mem <= 4) return 24;
  return 40;
}

function entryByteSize(entry: DirtyUndoEntry): number {
  return entry.before.byteLength + entry.after.byteLength + 64;
}

/**
 * 10/10 High-Performance 60/120fps Imperative Canvas2D Studio Engine:
 * - Offscreen `strokeCanvas` Stroke Accumulator (`0%` semi-transparent joint knots!)
 * - World-Locked Seamless `128x128` Paper-Tooth Graphite & Continuous 5-Bristle Dry Brush
 * - Tapered Tangent-Capsule G-Pen (`0%` high-speed beading) + Stabilizer Tail Catch-Up
 * - Per-Frame LRU Dirty-Rect Undo/Redo (`<= 48 MB`, survives frame switches!)
 * - Zero Full-Canvas GPU->CPU Readbacks on Brush Strokes, Undo & Redo
 */
export class StudioCanvasEngine {
  private displayCanvas: HTMLCanvasElement;
  private displayCtx: CanvasRenderingContext2D;
  private width: number;
  private height: number;
  private paperColor: string;
  private paperStyle: PaperStyleId = 'bristol';
  private atmosphere: SceneAtmosphereId = 'none';
  private lightboxDim = 1.0;
  private activeFrameIndex = 0;
  private cameraKeyframes: CameraKeyframe[] = [];
  private framesMeta: CelFrame[] = [];
  private forceCameraOverlay = false;

  private layerCanvases = new Map<string, HTMLCanvasElement>();
  private frame: CelFrame | null = null;
  private activeLayerId: string | null = null;
  private bgCanvas: HTMLCanvasElement | null = null;
  private bgBlobKeyLoaded: string | null = null;

  private onionPrevCanvases: HTMLCanvasElement[] = [];
  private onionNextCanvases: HTMLCanvasElement[] = [];
  private tintCanvas: HTMLCanvasElement;
  private tintCtx: CanvasRenderingContext2D;
  private cleanTimelapseCanvas: HTMLCanvasElement | null = null;

  // Offscreen stroke accumulator for homogeneous semi-transparent strokes & erasers
  private strokeCanvas: HTMLCanvasElement;
  private strokeCtx: CanvasRenderingContext2D;
  private hasStrokeBuffer = false;
  private strokeLayerId: string | null = null;
  private strokeIsEraser = false;
  private activeStrokeOpacity = 1;

  // Scratch canvas for grain-masked graphite dabbing (256x256 default, auto-expands for huge brushes)
  private grainScratch: HTMLCanvasElement;
  private grainScratchCtx: CanvasRenderingContext2D;

  // Bezier stroke & dirty bounding box state
  private isDrawing = false;
  private activePointerId: number | null = null;
  private activePointerType = 'mouse';
  private lastPressure = 0.72;
  private lastRawPt = { x: 0, y: 0 };
  private strokeBeforeFull: Uint8ClampedArray | null = null;
  private dirtyMinX = 0;
  private dirtyMinY = 0;
  private dirtyMaxX = 0;
  private dirtyMaxY = 0;

  private ropeX = 0;
  private ropeY = 0;
  private prevPt = { x: 0, y: 0 };
  private midPt = { x: 0, y: 0 };
  private lastTime = 0;
  private lastWidth = 4;
  private lastVelocity = 0;
  private lastDryNormal: { nx: number; ny: number } | null = null;
  private lastDryNormalMirror: { nx: number; ny: number } | null = null;

  // Shift straight-line or Shape preview state
  private shapePreview: {
    kind: ShapeKind;
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    isEraser: boolean;
  } | null = null;

  // Lasso + 4-corner Free Transform state
  private lassoPoints: { x: number; y: number }[] = [];
  private floating: FloatingSelection | null = null;
  private floatMode: 'none' | 'move' | 'scale' | 'rotate' = 'none';
  private floatDragStart = {
    x: 0,
    y: 0,
    cx: 0,
    cy: 0,
    origDx: 0,
    origDy: 0,
    origScale: 1,
    origRot: 0,
    startDist: 1,
    startAngle: 0,
  };

  // Per-Frame LRU Dirty-Rect Undo / Redo Map
  private frameHistory = new Map<string, FrameHistoryBucket>();

  private brush: BrushSettings;
  private onion: OnionSkinConfig;
  private guides: FieldGuideConfig;

  private dirty = false;
  private rafId: number | null = null;
  private disposed = false;

  public onHistoryChange?: (canUndo: boolean, canRedo: boolean) => void;
  public onFloatingChange?: (hasFloating: boolean) => void;
  public onStrokeCommit?: (layerId: string, frameId: string) => void;
  public onColorPicked?: (hex: string) => void;
  public onBlockedDraw?: (reason: 'locked' | 'hidden' | 'no-layer', layerName?: string) => void;

  constructor(
    displayCanvas: HTMLCanvasElement,
    width: number,
    height: number,
    paperColor: string,
    brush: BrushSettings,
    onion: OnionSkinConfig,
    guides: FieldGuideConfig
  ) {
    this.displayCanvas = displayCanvas;
    this.displayCanvas.width = width;
    this.displayCanvas.height = height;
    this.displayCtx = displayCanvas.getContext('2d', { alpha: false, willReadFrequently: true })!;
    this.width = width;
    this.height = height;
    this.paperColor = paperColor;
    this.brush = brush;
    this.onion = onion;
    this.guides = guides;

    this.tintCanvas = document.createElement('canvas');
    this.tintCanvas.width = width;
    this.tintCanvas.height = height;
    this.tintCtx = this.tintCanvas.getContext('2d')!;

    this.strokeCanvas = document.createElement('canvas');
    this.strokeCanvas.width = width;
    this.strokeCanvas.height = height;
    this.strokeCtx = this.strokeCanvas.getContext('2d')!;

    this.grainScratch = document.createElement('canvas');
    this.grainScratch.width = 256;
    this.grainScratch.height = 256;
    this.grainScratchCtx = this.grainScratch.getContext('2d')!;
  }

  private createLayerCanvas(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = this.width;
    c.height = this.height;
    // Initialize 2D context with willReadFrequently so dirty sub-rect reads never stall GPU
    c.getContext('2d', { willReadFrequently: true });
    return c;
  }

  private getOrCreateFrameHistory(frameId: string): FrameHistoryBucket {
    const existing = this.frameHistory.get(frameId);
    if (existing) {
      // Refresh LRU order
      this.frameHistory.delete(frameId);
      this.frameHistory.set(frameId, existing);
      return existing;
    }
    const created: FrameHistoryBucket = { undo: [], redo: [], bytes: 0 };
    this.frameHistory.set(frameId, created);
    return created;
  }

  private enforceTotalHistoryBudget(protectedFrameId: string | null): void {
    let total = 0;
    for (const bucket of this.frameHistory.values()) {
      total += bucket.bytes;
    }
    if (total <= MAX_TOTAL_HISTORY_BYTES) return;

    for (const [fid, bucket] of this.frameHistory.entries()) {
      if (total <= MAX_TOTAL_HISTORY_BYTES) break;
      if (fid === protectedFrameId && this.frameHistory.size > 1) continue;
      while (bucket.redo.length > 0 && total > MAX_TOTAL_HISTORY_BYTES) {
        const dropped = bucket.redo.shift()!;
        const sz = entryByteSize(dropped);
        bucket.bytes = Math.max(0, bucket.bytes - sz);
        total -= sz;
      }
      while (bucket.undo.length > 0 && total > MAX_TOTAL_HISTORY_BYTES) {
        if (fid === protectedFrameId && bucket.undo.length <= 4) break;
        const dropped = bucket.undo.shift()!;
        const sz = entryByteSize(dropped);
        bucket.bytes = Math.max(0, bucket.bytes - sz);
        total -= sz;
      }
      if (bucket.undo.length === 0 && bucket.redo.length === 0 && fid !== protectedFrameId) {
        this.frameHistory.delete(fid);
      }
    }
  }

  public canUndo(): boolean {
    if (!this.frame) return false;
    return (this.frameHistory.get(this.frame.id)?.undo.length ?? 0) > 0;
  }

  public canRedo(): boolean {
    if (!this.frame) return false;
    return (this.frameHistory.get(this.frame.id)?.redo.length ?? 0) > 0;
  }

  public getLayerCanvas(layerId: string): HTMLCanvasElement | undefined {
    return this.layerCanvases.get(layerId);
  }

  public setSettings(
    brush: BrushSettings,
    onion: OnionSkinConfig,
    guides: FieldGuideConfig,
    paperColor: string,
    lightboxDim: number,
    paperStyle: PaperStyleId = 'bristol',
    atmosphere: SceneAtmosphereId = 'none',
    activeFrameIndex = 0,
    cameraKeyframes: CameraKeyframe[] = [],
    framesMeta: CelFrame[] = [],
    forceCameraOverlay = false
  ): void {
    this.brush = brush;
    this.onion = onion;
    this.guides = guides;
    this.paperColor = paperColor;
    this.paperStyle = paperStyle;
    this.atmosphere = atmosphere;
    this.lightboxDim = lightboxDim;
    this.activeFrameIndex = activeFrameIndex;
    this.cameraKeyframes = cameraKeyframes;
    this.framesMeta = framesMeta;
    this.forceCameraOverlay = forceCameraOverlay;
    this.requestRender();
  }

  public getLoadedFrameId(): string | null {
    return this.frame?.id ?? null;
  }

  public cancelActiveStroke(): boolean {
    if (!this.isDrawing) return false;
    const active = this.getActiveLayer();
    if (active && this.strokeBeforeFull) {
      active.ctx.putImageData(
        new ImageData(new Uint8ClampedArray(this.strokeBeforeFull), this.width, this.height),
        0,
        0
      );
    }
    if (this.hasStrokeBuffer) {
      this.strokeCtx.clearRect(0, 0, this.width, this.height);
      this.hasStrokeBuffer = false;
      this.strokeLayerId = null;
    }
    this.isDrawing = false;
    this.activePointerId = null;
    this.strokeBeforeFull = null;
    this.shapePreview = null;
    this.lassoPoints = [];
    this.lastDryNormal = null;
    this.lastDryNormalMirror = null;
    this.requestRender();
    return true;
  }

  public async setBackgroundBlobKey(blobKey: string | null | undefined): Promise<void> {
    const key = blobKey ?? null;
    if (key === this.bgBlobKeyLoaded) return;
    this.bgBlobKeyLoaded = key;
    if (!key) {
      this.bgCanvas = null;
      this.requestRender();
      return;
    }
    const bmp = await getBlobBitmap(key);
    if (!bmp || this.disposed) return;
    const c = document.createElement('canvas');
    c.width = this.width;
    c.height = this.height;
    c.getContext('2d')!.drawImage(bmp, 0, 0, this.width, this.height);
    this.bgCanvas = c;
    this.requestRender();
  }

  public setActiveLayerId(layerId: string | null): void {
    if (this.floating) this.commitFloatingSelection();
    this.activeLayerId = layerId;
  }

  public updateFrameMetadata(frame: CelFrame): void {
    this.frame = frame;
    const validIds = new Set<string>();
    for (const layer of frame.layers) {
      validIds.add(layer.id);
      if (!this.layerCanvases.has(layer.id)) {
        this.layerCanvases.set(layer.id, this.createLayerCanvas());
      }
    }
    // Prune deleted layers from memory and from this frame's undo/redo history
    for (const existingId of [...this.layerCanvases.keys()]) {
      if (!validIds.has(existingId)) {
        this.layerCanvases.delete(existingId);
      }
    }
    const hist = this.frameHistory.get(frame.id);
    if (hist) {
      const prevUndoLen = hist.undo.length;
      const prevRedoLen = hist.redo.length;
      hist.undo = hist.undo.filter((e) => validIds.has(e.layerId));
      hist.redo = hist.redo.filter((e) => validIds.has(e.layerId));
      if (hist.undo.length !== prevUndoLen || hist.redo.length !== prevRedoLen) {
        hist.bytes =
          hist.undo.reduce((s, e) => s + entryByteSize(e), 0) +
          hist.redo.reduce((s, e) => s + entryByteSize(e), 0);
        this.onHistoryChange?.(hist.undo.length > 0, hist.redo.length > 0);
      }
    }
    this.requestRender();
  }

  public async loadFrame(
    frame: CelFrame,
    activeLayerId: string | null,
    prevFrames: CelFrame[],
    nextFrames: CelFrame[],
    frameIndex = 0
  ): Promise<void> {
    if (this.floating) this.commitFloatingSelection();
    if (this.hasStrokeBuffer) {
      this.strokeCtx.clearRect(0, 0, this.width, this.height);
      this.hasStrokeBuffer = false;
      this.strokeLayerId = null;
    }
    this.frame = frame;
    this.activeLayerId = activeLayerId;
    this.activeFrameIndex = frameIndex;

    // Preserve per-frame Undo/Redo across frame switches!
    const hist = this.getOrCreateFrameHistory(frame.id);
    this.onHistoryChange?.(hist.undo.length > 0, hist.redo.length > 0);

    this.layerCanvases.clear();
    for (const layer of frame.layers) {
      const c = this.createLayerCanvas();
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      if (layer.blobKey) {
        const bmp = await getBlobBitmap(layer.blobKey);
        if (bmp && !this.disposed) {
          ctx.drawImage(bmp, 0, 0, this.width, this.height);
        }
      }
      this.layerCanvases.set(layer.id, c);
    }

    this.onionPrevCanvases = await this.buildOnionComposites(prevFrames);
    this.onionNextCanvases = await this.buildOnionComposites(nextFrames);

    this.requestRender();
  }

  private async buildOnionComposites(frames: CelFrame[]): Promise<HTMLCanvasElement[]> {
    const out: HTMLCanvasElement[] = [];
    for (const f of frames) {
      const c = document.createElement('canvas');
      c.width = this.width;
      c.height = this.height;
      const ctx = c.getContext('2d')!;
      for (const l of f.layers) {
        if (!l.visible || !l.blobKey) continue;
        const bmp = await getBlobBitmap(l.blobKey);
        if (!bmp || this.disposed) continue;
        ctx.save();
        ctx.globalAlpha = l.opacity;
        // Convert opaque scanned `multiply` paper layers into ink-only silhouettes so Onion Skin never turns into a solid red/blue box!
        const drawable =
          l.blendMode === 'multiply'
            ? convertMultiplySourceToTransparentCanvas(bmp, this.width, this.height)
            : bmp;
        ctx.drawImage(drawable, 0, 0, this.width, this.height);
        ctx.restore();
      }
      out.push(c);
    }
    return out;
  }

  public requestRender(): void {
    if (this.disposed) return;
    this.dirty = true;
    if (this.rafId === null) {
      this.rafId = requestAnimationFrame(() => {
        this.rafId = null;
        if (this.dirty && !this.disposed) {
          this.dirty = false;
          this.render();
        }
      });
    }
  }

  public sampleColorAt(x: number, y: number): string {
    const px = Math.max(0, Math.min(this.width - 1, Math.round(x)));
    const py = Math.max(0, Math.min(this.height - 1, Math.round(y)));
    const pixel = this.displayCtx.getImageData(px, py, 1, 1).data;
    return rgbToHex(pixel[0], pixel[1], pixel[2]);
  }

  private drawTintedOnion(source: HTMLCanvasElement, tintColor: string, alpha: number): void {
    const ctx = this.displayCtx;
    if (this.onion.colored) {
      this.tintCtx.clearRect(0, 0, this.width, this.height);
      this.tintCtx.globalCompositeOperation = 'source-over';
      this.tintCtx.globalAlpha = 1;
      this.tintCtx.drawImage(source, 0, 0);
      this.tintCtx.globalCompositeOperation = 'source-in';
      this.tintCtx.fillStyle = tintColor;
      this.tintCtx.fillRect(0, 0, this.width, this.height);
      this.tintCtx.globalCompositeOperation = 'source-over';

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.drawImage(this.tintCanvas, 0, 0);
      ctx.restore();
    } else {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.drawImage(source, 0, 0);
      ctx.restore();
    }
  }

  private getFloatingHandlePositions(f: FloatingSelection) {
    const cx = f.x + f.w / 2 + f.dx;
    const cy = f.y + f.h / 2 + f.dy;
    const hw = (f.w * f.scale) / 2;
    const hh = (f.h * f.scale) / 2;
    const rad = (f.rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const rotPt = (lx: number, ly: number) => ({
      x: cx + lx * cos - ly * sin,
      y: cy + lx * sin + ly * cos,
    });
    return {
      cx,
      cy,
      corners: [rotPt(-hw, -hh), rotPt(hw, -hh), rotPt(hw, hh), rotPt(-hw, hh)],
      rotKnob: rotPt(0, -hh - 34),
      topMid: rotPt(0, -hh),
    };
  }

  public render(): void {
    const ctx = this.displayCtx;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    // 1. Physical Paper Surface
    renderPaperSurface(
      ctx,
      this.width,
      this.height,
      this.paperColor,
      this.paperStyle,
      this.lightboxDim
    );

    // 2. Fixed Project/Scene Background Plane
    if (this.bgCanvas) {
      ctx.drawImage(this.bgCanvas, 0, 0);
    }

    // 3. Animator Underlay Guides
    renderUnderlayGuide(
      ctx,
      this.width,
      this.height,
      this.guides,
      this.activeFrameIndex,
      this.brush.symmetryX
    );

    // 4. Red/Blue Onion Skinning
    if (this.onion.enabled) {
      const prevSlice = this.onionPrevCanvases.slice(0, this.onion.prevCount);
      prevSlice.forEach((canvas, idx) => {
        const falloff = Math.pow(0.6, idx);
        this.drawTintedOnion(canvas, '#E11D48', this.onion.opacity * falloff);
      });

      const nextSlice = this.onionNextCanvases.slice(0, this.onion.nextCount);
      nextSlice.forEach((canvas, idx) => {
        const falloff = Math.pow(0.6, idx);
        this.drawTintedOnion(canvas, '#2563EB', this.onion.opacity * 0.85 * falloff);
      });
    }

    // 5. Active Frame Cel Layers (+ live homogeneous `strokeCanvas` preview!)
    if (this.frame) {
      for (const layer of this.frame.layers) {
        if (!layer.visible) continue;
        const lc = this.layerCanvases.get(layer.id);
        if (!lc) continue;

        if (this.hasStrokeBuffer && this.strokeLayerId === layer.id) {
          this.tintCtx.clearRect(0, 0, this.width, this.height);
          this.tintCtx.globalCompositeOperation = 'source-over';
          this.tintCtx.globalAlpha = 1;
          this.tintCtx.drawImage(lc, 0, 0);
          this.tintCtx.globalCompositeOperation = this.strokeIsEraser
            ? 'destination-out'
            : 'source-over';
          this.tintCtx.globalAlpha = this.activeStrokeOpacity;
          this.tintCtx.drawImage(this.strokeCanvas, 0, 0);
          this.tintCtx.globalCompositeOperation = 'source-over';
          this.tintCtx.globalAlpha = 1;

          ctx.save();
          ctx.globalAlpha = layer.opacity;
          ctx.globalCompositeOperation =
            layer.blendMode === 'multiply' ? 'multiply' : 'source-over';
          ctx.drawImage(this.tintCanvas, 0, 0);
          ctx.restore();
        } else {
          ctx.save();
          ctx.globalAlpha = layer.opacity;
          ctx.globalCompositeOperation =
            layer.blendMode === 'multiply' ? 'multiply' : 'source-over';
          ctx.drawImage(lc, 0, 0);
          ctx.restore();
        }
      }
    }

    // 6. Scene Lighting Atmosphere
    applySceneAtmosphere(ctx, this.width, this.height, this.atmosphere);

    // 7. Live Shape / Shift-Line rubber-band preview
    if (this.shapePreview) {
      this.drawShapeGeometry(ctx, this.shapePreview, true);
      if (this.brush.symmetryX) {
        this.drawShapeGeometry(
          ctx,
          {
            ...this.shapePreview,
            x0: this.width - this.shapePreview.x0,
            x1: this.width - this.shapePreview.x1,
          },
          true
        );
      }
    }

    // 8. Floating Lasso Selection + Interactive 4-Corner Scale & Brass Rotation Handle
    if (this.floating) {
      const f = this.floating;
      const handles = this.getFloatingHandlePositions(f);
      ctx.save();
      ctx.translate(handles.cx, handles.cy);
      ctx.rotate((f.rotation * Math.PI) / 180);
      ctx.scale(f.flipX ? -f.scale : f.scale, f.scale);
      ctx.drawImage(f.canvas, -f.w / 2, -f.h / 2);
      ctx.strokeStyle = '#E54D2E';
      ctx.lineWidth = 2 / Math.max(0.2, f.scale);
      ctx.setLineDash([6 / Math.max(0.2, f.scale), 4 / Math.max(0.2, f.scale)]);
      ctx.strokeRect(-f.w / 2, -f.h / 2, f.w, f.h);
      ctx.restore();

      ctx.save();
      ctx.strokeStyle = '#E54D2E';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(handles.topMid.x, handles.topMid.y);
      ctx.lineTo(handles.rotKnob.x, handles.rotKnob.y);
      ctx.stroke();

      ctx.fillStyle = '#D99B26';
      ctx.beginPath();
      ctx.arc(handles.rotKnob.x, handles.rotKnob.y, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 2;
      ctx.stroke();

      for (const c of handles.corners) {
        ctx.fillStyle = '#E54D2E';
        ctx.fillRect(c.x - 6.5, c.y - 6.5, 13, 13);
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 2;
        ctx.strokeRect(c.x - 6.5, c.y - 6.5, 13, 13);
      }
      ctx.restore();
    }

    if (this.lassoPoints.length > 1) {
      ctx.save();
      ctx.strokeStyle = '#E54D2E';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(this.lassoPoints[0].x, this.lassoPoints[0].y);
      for (let i = 1; i < this.lassoPoints.length; i++) {
        ctx.lineTo(this.lassoPoints[i].x, this.lassoPoints[i].y);
      }
      ctx.stroke();
      ctx.restore();
    }

    // 9. Field Guides
    if (this.guides.enabled) {
      ctx.save();
      ctx.strokeStyle = 'rgba(37, 99, 235, 0.24)';
      ctx.lineWidth = 1.25;
      if (this.guides.thirds) {
        ctx.beginPath();
        ctx.moveTo(this.width / 3, 0);
        ctx.lineTo(this.width / 3, this.height);
        ctx.moveTo((this.width * 2) / 3, 0);
        ctx.lineTo((this.width * 2) / 3, this.height);
        ctx.moveTo(0, this.height / 3);
        ctx.lineTo(this.width, this.height / 3);
        ctx.moveTo(0, (this.height * 2) / 3);
        ctx.lineTo(this.width, (this.height * 2) / 3);
        ctx.stroke();
      }
      if (this.guides.safeFrame) {
        const mx = this.width * 0.06;
        const my = this.height * 0.06;
        ctx.setLineDash([8, 6]);
        ctx.strokeRect(mx, my, this.width - mx * 2, this.height - my * 2);
        ctx.setLineDash([]);
      }
      if (this.guides.centerCross) {
        const cx = this.width / 2;
        const cy = this.height / 2;
        ctx.beginPath();
        ctx.moveTo(cx - 18, cy);
        ctx.lineTo(cx + 18, cy);
        ctx.moveTo(cx, cy - 18);
        ctx.lineTo(cx, cy + 18);
        ctx.stroke();
      }
      ctx.restore();
    }

    // 10. Live 2D Cinematic Camera Viewfinder Overlay
    this.renderCameraViewfinder(ctx);
  }

  private renderCameraViewfinder(ctx: CanvasRenderingContext2D): void {
    const frames = this.framesMeta.length > 0 ? this.framesMeta : this.frame ? [this.frame] : [];
    const cam = evaluateCameraAtFrame(
      this.cameraKeyframes,
      frames,
      this.activeFrameIndex,
      this.width,
      this.height
    );
    const curShake = this.frame?.cameraShake ?? 0;
    const isTransformed =
      Math.abs(cam.zoom - 1) > 0.005 ||
      Math.abs(cam.panX) > 0.002 ||
      Math.abs(cam.panY) > 0.002 ||
      Math.abs(cam.tiltDeg) > 0.05 ||
      curShake > 0;

    if (!this.forceCameraOverlay && !isTransformed) return;

    const w = this.width;
    const h = this.height;
    const vw = w / Math.max(0.25, cam.zoom);
    const vh = h / Math.max(0.25, cam.zoom);
    const cx = w / 2 + cam.panX * w;
    const cy = h / 2 + cam.panY * h;
    const rad = (-cam.tiltDeg * Math.PI) / 180;

    ctx.save();

    if (isTransformed) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, w, h);
      const hw = vw / 2;
      const hh = vh / 2;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const pt = (lx: number, ly: number) => ({
        x: cx + lx * cos - ly * sin,
        y: cy + lx * sin + ly * cos,
      });
      const c0 = pt(-hw, -hh);
      const c1 = pt(hw, -hh);
      const c2 = pt(hw, hh);
      const c3 = pt(-hw, hh);
      ctx.moveTo(c0.x, c0.y);
      ctx.lineTo(c1.x, c1.y);
      ctx.lineTo(c2.x, c2.y);
      ctx.lineTo(c3.x, c3.y);
      ctx.closePath();
      ctx.fillStyle = 'rgba(18, 16, 14, 0.28)';
      ctx.fill('evenodd');
      ctx.restore();
    }

    ctx.translate(cx, cy);
    ctx.rotate(rad);
    const inset = isTransformed ? 0 : 10;
    const rx = -vw / 2 + inset;
    const ry = -vh / 2 + inset;
    const rw = Math.max(24, vw - inset * 2);
    const rh = Math.max(24, vh - inset * 2);

    ctx.strokeStyle = isTransformed ? 'rgba(229, 77, 46, 0.92)' : 'rgba(217, 155, 38, 0.72)';
    ctx.lineWidth = Math.max(2, Math.min(3.5, w / 420));
    ctx.setLineDash([10, 6]);
    ctx.strokeRect(rx, ry, rw, rh);
    ctx.setLineDash([]);

    const bLen = Math.min(28, rw * 0.14, rh * 0.14);
    ctx.strokeStyle = isTransformed ? '#E54D2E' : '#D99B26';
    ctx.lineWidth = Math.max(3, Math.min(4.5, w / 300));
    ctx.beginPath();
    ctx.moveTo(rx, ry + bLen);
    ctx.lineTo(rx, ry);
    ctx.lineTo(rx + bLen, ry);
    ctx.moveTo(rx + rw - bLen, ry);
    ctx.lineTo(rx + rw, ry);
    ctx.lineTo(rx + rw, ry + bLen);
    ctx.moveTo(rx + rw, ry + rh - bLen);
    ctx.lineTo(rx + rw, ry + rh);
    ctx.lineTo(rx + rw - bLen, ry + rh);
    ctx.moveTo(rx + bLen, ry + rh);
    ctx.lineTo(rx, ry + rh);
    ctx.lineTo(rx, ry + rh - bLen);
    ctx.stroke();

    ctx.strokeStyle = isTransformed ? 'rgba(229, 77, 46, 0.55)' : 'rgba(217, 155, 38, 0.45)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-10, 0);
    ctx.lineTo(10, 0);
    ctx.moveTo(0, -10);
    ctx.lineTo(0, 10);
    ctx.stroke();

    if (curShake > 0) {
      ctx.strokeStyle = 'rgba(229, 77, 46, 0.55)';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      const amp = curShake * 5;
      ctx.strokeRect(rx - amp, ry - amp, rw + amp * 2, rh + amp * 2);
      ctx.setLineDash([]);
    }

    const panXStr = `${cam.panX >= 0 ? '+' : ''}${Math.round(cam.panX * 100)}%`;
    const panYStr = `${cam.panY >= 0 ? '+' : ''}${Math.round(cam.panY * 100)}%`;
    const shakeStr = curShake > 0 ? ` · ⚡${curShake}` : '';
    const label = isTransformed
      ? `KAMERA ${cam.zoom.toFixed(2)}x · ${panXStr}, ${panYStr}${shakeStr}`
      : `KAMERA 1.00x`;
    const fontSize = Math.max(12, Math.round(w / 92));
    ctx.font = `700 ${fontSize}px "JetBrains Mono", monospace`;
    const textW = ctx.measureText(label).width;
    const pillX = Math.max(-w / 2 + 10, rx + 8);
    const pillY = Math.max(-h / 2 + 10, ry + 8);
    const pillH = fontSize + 10;
    const pillW = textW + 18;
    ctx.fillStyle = isTransformed ? 'rgba(229, 77, 46, 0.92)' : 'rgba(28, 25, 23, 0.82)';
    ctx.beginPath();
    ctx.roundRect(pillX, pillY, pillW, pillH, 6);
    ctx.fill();
    ctx.fillStyle = '#FAF6EE';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, pillX + 9, pillY + pillH / 2 + 0.5);

    ctx.restore();
  }

  /** Renders clean artwork without onion skin, guides, lasso handles, or camera overlay for crisp timelapse videos */
  private captureCleanTimelapse(): void {
    if (typeof document === 'undefined') return;
    if (!this.cleanTimelapseCanvas) {
      this.cleanTimelapseCanvas = document.createElement('canvas');
    }
    if (
      this.cleanTimelapseCanvas.width !== this.width ||
      this.cleanTimelapseCanvas.height !== this.height
    ) {
      this.cleanTimelapseCanvas.width = this.width;
      this.cleanTimelapseCanvas.height = this.height;
    }
    const cctx = this.cleanTimelapseCanvas.getContext('2d', { alpha: false });
    if (!cctx) return;

    cctx.globalCompositeOperation = 'source-over';
    cctx.globalAlpha = 1;
    renderPaperSurface(cctx, this.width, this.height, this.paperColor, this.paperStyle, 1);
    if (this.bgCanvas) {
      cctx.drawImage(this.bgCanvas, 0, 0);
    }
    if (this.frame) {
      for (const layer of this.frame.layers) {
        if (!layer.visible) continue;
        const lc = this.layerCanvases.get(layer.id);
        if (!lc) continue;
        cctx.save();
        cctx.globalAlpha = layer.opacity;
        cctx.globalCompositeOperation =
          layer.blendMode === 'multiply' ? 'multiply' : 'source-over';
        cctx.drawImage(lc, 0, 0);
        cctx.restore();
      }
    }
    applySceneAtmosphere(cctx, this.width, this.height, this.atmosphere);
    void timelapseRecorder.captureCanvas(this.cleanTimelapseCanvas);
  }

  private drawShapeGeometry(
    ctx: CanvasRenderingContext2D,
    shape: { kind: ShapeKind; x0: number; y0: number; x1: number; y1: number; isEraser: boolean },
    previewOnly: boolean
  ): void {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1.5, this.brush.size);
    if (shape.isEraser && !previewOnly) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle =
        this.brush.tool === 'blue-rough'
          ? '#2563EB'
          : previewOnly && shape.isEraser
            ? '#E54D2E'
            : this.brush.color;
      ctx.globalAlpha = previewOnly ? Math.max(0.55, this.brush.opacity * 0.85) : this.brush.opacity;
    }

    ctx.beginPath();
    if (shape.kind === 'line') {
      ctx.moveTo(shape.x0, shape.y0);
      ctx.lineTo(shape.x1, shape.y1);
    } else if (shape.kind === 'rect') {
      ctx.rect(
        Math.min(shape.x0, shape.x1),
        Math.min(shape.y0, shape.y1),
        Math.abs(shape.x1 - shape.x0),
        Math.abs(shape.y1 - shape.y0)
      );
    } else if (shape.kind === 'ellipse') {
      const cx = (shape.x0 + shape.x1) / 2;
      const cy = (shape.y0 + shape.y1) / 2;
      const rx = Math.max(1, Math.abs(shape.x1 - shape.x0) / 2);
      const ry = Math.max(1, Math.abs(shape.y1 - shape.y0) / 2);
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    }
    ctx.stroke();
    ctx.restore();
  }

  private getActiveLayer(): {
    id: string;
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
  } | null {
    if (!this.frame || !this.activeLayerId) return null;
    const meta = this.frame.layers.find((l) => l.id === this.activeLayerId);
    if (!meta || meta.locked || !meta.visible) return null;
    const canvas = this.layerCanvases.get(meta.id);
    if (!canvas) return null;
    return { id: meta.id, canvas, ctx: canvas.getContext('2d', { willReadFrequently: true })! };
  }

  private resetDirtyBounds(x: number, y: number, pad: number): void {
    this.dirtyMinX = x - pad;
    this.dirtyMinY = y - pad;
    this.dirtyMaxX = x + pad;
    this.dirtyMaxY = y + pad;
    if (this.brush.symmetryX) {
      const mx = this.width - x;
      this.dirtyMinX = Math.min(this.dirtyMinX, mx - pad);
      this.dirtyMaxX = Math.max(this.dirtyMaxX, mx + pad);
    }
  }

  private expandDirtyBounds(x: number, y: number, pad: number): void {
    this.dirtyMinX = Math.min(this.dirtyMinX, x - pad);
    this.dirtyMinY = Math.min(this.dirtyMinY, y - pad);
    this.dirtyMaxX = Math.max(this.dirtyMaxX, x + pad);
    this.dirtyMaxY = Math.max(this.dirtyMaxY, y + pad);
    if (this.brush.symmetryX) {
      const mx = this.width - x;
      this.dirtyMinX = Math.min(this.dirtyMinX, mx - pad);
      this.dirtyMaxX = Math.max(this.dirtyMaxX, mx + pad);
    }
  }

  private getClampedDirtyRect(fullRect = false): DirtyRect {
    if (fullRect) {
      return { x: 0, y: 0, w: this.width, h: this.height };
    }
    const x0 = Math.max(0, Math.floor(this.dirtyMinX));
    const y0 = Math.max(0, Math.floor(this.dirtyMinY));
    const x1 = Math.min(this.width, Math.ceil(this.dirtyMaxX));
    const y1 = Math.min(this.height, Math.ceil(this.dirtyMaxY));
    return {
      x: x0,
      y: y0,
      w: Math.max(1, x1 - x0),
      h: Math.max(1, y1 - y0),
    };
  }

  /** Commits `strokeCanvas` onto `active.ctx` reading ONLY the dirty sub-rectangle (zero full-canvas readback!) */
  private commitStrokeBufferToLayer(layerId: string, ctx: CanvasRenderingContext2D): void {
    const rect = this.getClampedDirtyRect(false);
    const beforePatch = new Uint8ClampedArray(
      ctx.getImageData(rect.x, rect.y, rect.w, rect.h).data
    );

    ctx.save();
    ctx.globalCompositeOperation = this.strokeIsEraser ? 'destination-out' : 'source-over';
    ctx.globalAlpha = this.activeStrokeOpacity;
    ctx.drawImage(
      this.strokeCanvas,
      rect.x,
      rect.y,
      rect.w,
      rect.h,
      rect.x,
      rect.y,
      rect.w,
      rect.h
    );
    ctx.restore();

    const afterPatch = new Uint8ClampedArray(ctx.getImageData(rect.x, rect.y, rect.w, rect.h).data);

    this.strokeCtx.clearRect(rect.x, rect.y, rect.w, rect.h);
    this.hasStrokeBuffer = false;
    this.strokeLayerId = null;

    this.pushUndo({ layerId, rect, before: beforePatch, after: afterPatch });
    if (this.frame) {
      this.onStrokeCommit?.(layerId, this.frame.id);
    }
    this.render();
    this.captureCleanTimelapse();
  }

  private commitDirtyUndo(layerId: string, ctx: CanvasRenderingContext2D, fullRect = false): void {
    if (!this.strokeBeforeFull) return;
    const rect = this.getClampedDirtyRect(fullRect);
    const beforePatch = extractRgbaRect(this.strokeBeforeFull, this.width, rect);
    const afterPatch = new Uint8ClampedArray(ctx.getImageData(rect.x, rect.y, rect.w, rect.h).data);
    this.pushUndo({ layerId, rect, before: beforePatch, after: afterPatch });
    this.strokeBeforeFull = null;
    if (this.frame) {
      this.onStrokeCommit?.(layerId, this.frame.id);
    }

    this.render();
    this.captureCleanTimelapse();
  }

  public async handlePointerDown(
    x: number,
    y: number,
    pressure: number,
    pointerId: number,
    pointerType: string,
    modifiers?: { altKey?: boolean; shiftKey?: boolean }
  ): Promise<void> {
    if (this.brush.palmRejection && pointerType === 'touch') return;

    if (this.brush.tool === 'eyedropper' || modifiers?.altKey) {
      const hex = this.sampleColorAt(x, y);
      this.onColorPicked?.(hex);
      return;
    }

    const active = this.getActiveLayer();
    if (!active) {
      const meta = this.frame?.layers.find((l) => l.id === this.activeLayerId);
      if (!meta) {
        this.onBlockedDraw?.('no-layer');
      } else if (meta.locked) {
        this.onBlockedDraw?.('locked', meta.name);
      } else if (!meta.visible) {
        this.onBlockedDraw?.('hidden', meta.name);
      }
      return;
    }

    // 4-Corner Scale + Brass Rotation + Drag Move hit-testing for Floating Lasso Selection
    if (this.floating) {
      const f = this.floating;
      const handles = this.getFloatingHandlePositions(f);

      if (Math.hypot(x - handles.rotKnob.x, y - handles.rotKnob.y) < 18) {
        this.floatMode = 'rotate';
        this.activePointerId = pointerId;
        this.floatDragStart = {
          x,
          y,
          cx: handles.cx,
          cy: handles.cy,
          origDx: f.dx,
          origDy: f.dy,
          origScale: f.scale,
          origRot: f.rotation,
          startDist: 1,
          startAngle: Math.atan2(y - handles.cy, x - handles.cx),
        };
        return;
      }

      for (const corner of handles.corners) {
        if (Math.hypot(x - corner.x, y - corner.y) < 18) {
          this.floatMode = 'scale';
          this.activePointerId = pointerId;
          this.floatDragStart = {
            x,
            y,
            cx: handles.cx,
            cy: handles.cy,
            origDx: f.dx,
            origDy: f.dy,
            origScale: f.scale,
            origRot: f.rotation,
            startDist: Math.max(10, Math.hypot(x - handles.cx, y - handles.cy)),
            startAngle: 0,
          };
          return;
        }
      }

      const maxR = Math.max(f.w, f.h) * f.scale * 0.65 + 16;
      if (Math.hypot(x - handles.cx, y - handles.cy) <= maxR) {
        this.floatMode = 'move';
        this.activePointerId = pointerId;
        this.floatDragStart = {
          x,
          y,
          cx: handles.cx,
          cy: handles.cy,
          origDx: f.dx,
          origDy: f.dy,
          origScale: f.scale,
          origRot: f.rotation,
          startDist: 1,
          startAngle: 0,
        };
        return;
      }

      this.commitFloatingSelection();
    }

    // Reference-Aware Gap-Closing Smart Flood Fill Bucket!
    if (this.brush.tool === 'bucket') {
      const before = active.ctx.getImageData(0, 0, this.width, this.height);
      const otherInkLayer = this.brush.bucketReferenceInk
        ? this.frame?.layers.find((l) => l.role === 'ink' && l.visible && l.id !== active.id)
        : undefined;
      const otherInkCanvas = otherInkLayer ? this.layerCanvases.get(otherInkLayer.id) : undefined;
      let barrierRgba: Uint8ClampedArray | undefined = otherInkCanvas
        ? otherInkCanvas.getContext('2d', { willReadFrequently: true })!.getImageData(
            0,
            0,
            this.width,
            this.height
          ).data
        : undefined;
      const isSeparateBarrier = Boolean(barrierRgba);

      if (!barrierRgba && this.brush.bucketGapClose > 0) {
        const sx = Math.max(0, Math.min(this.width - 1, Math.round(x)));
        const sy = Math.max(0, Math.min(this.height - 1, Math.round(y)));
        const seedAlpha = before.data[(sy * this.width + sx) * 4 + 3];
        if (seedAlpha < 24) {
          barrierRgba = before.data;
        }
      }

      const filled = await runSmartFloodFill({
        width: this.width,
        height: this.height,
        targetRgba: before.data,
        barrierRgba,
        startX: x,
        startY: y,
        fillColor: hexToRgba(this.brush.color, Math.round(this.brush.opacity * 255)),
        tolerance: 28,
        expandPx: isSeparateBarrier ? 1 : 0,
        gapClosePx: barrierRgba ? this.brush.bucketGapClose : 0,
      });

      const after = new ImageData(new Uint8ClampedArray(filled), this.width, this.height);
      active.ctx.putImageData(after, 0, 0);
      this.pushUndo({
        layerId: active.id,
        rect: { x: 0, y: 0, w: this.width, h: this.height },
        before: new Uint8ClampedArray(before.data),
        after: new Uint8ClampedArray(after.data),
      });
      this.requestRender();
      if (this.frame) {
        this.onStrokeCommit?.(active.id, this.frame.id);
      }
      this.render();
      this.captureCleanTimelapse();
      return;
    }

    if (this.brush.tool === 'lasso') {
      this.isDrawing = true;
      this.activePointerId = pointerId;
      this.activePointerType = pointerType;
      this.lassoPoints = [{ x, y }];
      this.requestRender();
      return;
    }

    // Shape drafting tool OR Shift-held Straight Line Assist
    if (this.brush.tool === 'shape' || modifiers?.shiftKey) {
      this.isDrawing = true;
      this.activePointerId = pointerId;
      this.activePointerType = pointerType;
      this.strokeBeforeFull = new Uint8ClampedArray(
        active.ctx.getImageData(0, 0, this.width, this.height).data
      );
      this.resetDirtyBounds(x, y, this.brush.size + 16);
      this.shapePreview = {
        kind: this.brush.tool === 'shape' ? this.brush.shapeKind : 'line',
        x0: x,
        y0: y,
        x1: x,
        y1: y,
        isEraser: this.brush.tool === 'eraser',
      };
      this.requestRender();
      return;
    }

    // Smooth Textured Quadratic Bezier Stroke Start on Offscreen `strokeCanvas`!
    this.isDrawing = true;
    this.activePointerId = pointerId;
    this.activePointerType = pointerType;
    this.lastPressure = pressure;
    this.lastRawPt = { x, y };
    this.lastDryNormal = null;
    this.lastDryNormalMirror = null;

    this.strokeCtx.clearRect(0, 0, this.width, this.height);
    this.hasStrokeBuffer = true;
    this.strokeLayerId = active.id;
    this.strokeIsEraser = this.brush.tool === 'eraser';
    this.activeStrokeOpacity =
      this.brush.tool === 'marker'
        ? Math.min(0.42, this.brush.opacity * 0.42)
        : this.brush.opacity;

    this.ropeX = x;
    this.ropeY = y;
    this.prevPt = { x, y };
    this.midPt = { x, y };
    this.lastTime = performance.now();
    this.lastVelocity = 0;
    this.lastWidth = this.computeStrokeWidth(pressure, 0);
    this.resetDirtyBounds(x, y, this.lastWidth * 2 + 16);
    this.drawSymmetricSegment(
      this.strokeCtx,
      { x, y },
      { x, y },
      { x, y },
      this.lastWidth,
      this.lastWidth,
      pressure,
      0
    );
    this.requestRender();
  }

  public handlePointerMove(x: number, y: number, pressure: number, pointerId: number): void {
    if (this.activePointerId !== pointerId) return;

    if (this.floatMode !== 'none' && this.floating) {
      if (this.floatMode === 'move') {
        this.floating.dx = this.floatDragStart.origDx + (x - this.floatDragStart.x);
        this.floating.dy = this.floatDragStart.origDy + (y - this.floatDragStart.y);
      } else if (this.floatMode === 'scale') {
        const dist = Math.max(
          10,
          Math.hypot(x - this.floatDragStart.cx, y - this.floatDragStart.cy)
        );
        this.floating.scale = Math.max(
          0.2,
          Math.min(4, this.floatDragStart.origScale * (dist / this.floatDragStart.startDist))
        );
      } else if (this.floatMode === 'rotate') {
        const ang = Math.atan2(y - this.floatDragStart.cy, x - this.floatDragStart.cx);
        this.floating.rotation =
          this.floatDragStart.origRot + ((ang - this.floatDragStart.startAngle) * 180) / Math.PI;
      }
      this.requestRender();
      return;
    }

    if (!this.isDrawing) return;

    if (this.shapePreview) {
      this.shapePreview.x1 = x;
      this.shapePreview.y1 = y;
      this.expandDirtyBounds(x, y, this.brush.size + 16);
      this.requestRender();
      return;
    }

    if (this.brush.tool === 'lasso') {
      const prev = this.lassoPoints[this.lassoPoints.length - 1];
      if (!prev || Math.hypot(x - prev.x, y - prev.y) > 4) {
        this.lassoPoints.push({ x, y });
        this.requestRender();
      }
      return;
    }

    if (!this.hasStrokeBuffer) return;

    this.lastRawPt = { x, y };
    this.lastPressure = pressure;

    const alpha = 1 - Math.min(0.86, Math.max(0, this.brush.stabilizer));
    this.ropeX += (x - this.ropeX) * alpha;
    this.ropeY += (y - this.ropeY) * alpha;

    const now = performance.now();
    const dt = Math.max(1, now - this.lastTime);
    const dist = Math.hypot(this.ropeX - this.prevPt.x, this.ropeY - this.prevPt.y);
    if (dist < 0.9) return;

    const velocity = dist / dt;
    this.lastVelocity = this.lastVelocity * 0.65 + velocity * 0.35;
    const targetW = this.computeStrokeWidth(pressure, this.lastVelocity);
    const nextWidth = this.lastWidth * 0.62 + targetW * 0.38;

    const nextMid = {
      x: (this.prevPt.x + this.ropeX) * 0.5,
      y: (this.prevPt.y + this.ropeY) * 0.5,
    };

    const pad = Math.max(this.lastWidth, nextWidth) * 2 + 16;
    this.expandDirtyBounds(this.ropeX, this.ropeY, pad);
    this.expandDirtyBounds(nextMid.x, nextMid.y, pad);

    this.drawSymmetricSegment(
      this.strokeCtx,
      this.midPt,
      this.prevPt,
      nextMid,
      this.lastWidth,
      nextWidth,
      pressure,
      this.lastVelocity
    );

    this.midPt = nextMid;
    this.prevPt = { x: this.ropeX, y: this.ropeY };
    this.lastTime = now;
    this.lastWidth = nextWidth;
    this.requestRender();
  }

  public handlePointerUp(pointerId: number): void {
    if (this.activePointerId !== pointerId) return;
    this.activePointerId = null;

    if (this.floatMode !== 'none') {
      this.floatMode = 'none';
      return;
    }

    if (!this.isDrawing) return;
    this.isDrawing = false;

    const active = this.getActiveLayer();

    if (this.shapePreview) {
      if (active && this.strokeBeforeFull) {
        this.drawShapeGeometry(active.ctx, this.shapePreview, false);
        if (this.brush.symmetryX) {
          this.drawShapeGeometry(
            active.ctx,
            {
              ...this.shapePreview,
              x0: this.width - this.shapePreview.x0,
              x1: this.width - this.shapePreview.x1,
            },
            false
          );
        }
        this.commitDirtyUndo(active.id, active.ctx, false);
      }
      this.shapePreview = null;
      this.requestRender();
      return;
    }

    if (this.brush.tool === 'lasso') {
      if (active && this.lassoPoints.length >= 4) {
        this.liftLassoSelection(active);
      }
      this.lassoPoints = [];
      this.requestRender();
      return;
    }

    // Stabilizer tail catch-up: smoothly glide `ropeX/ropeY` into `lastRawPt` so stabilized lines never fall short!
    if (this.hasStrokeBuffer) {
      const remDist = Math.hypot(this.lastRawPt.x - this.midPt.x, this.lastRawPt.y - this.midPt.y);
      if (remDist > 0.35) {
        const catchSteps = Math.max(2, Math.min(8, Math.ceil(remDist / 4)));
        const startRx = this.ropeX;
        const startRy = this.ropeY;
        for (let s = 1; s <= catchSteps; s++) {
          const t = s / catchSteps;
          const ease = t * (2 - t);
          const nx = startRx + (this.lastRawPt.x - startRx) * ease;
          const ny = startRy + (this.lastRawPt.y - startRy) * ease;
          const nextMid =
            s === catchSteps
              ? { x: this.lastRawPt.x, y: this.lastRawPt.y }
              : { x: (this.prevPt.x + nx) * 0.5, y: (this.prevPt.y + ny) * 0.5 };
          const taperW =
            this.brush.tool === 'gpen'
              ? Math.max(0.8, this.lastWidth * (1 - t * 0.18))
              : this.lastWidth;
          const pad = Math.max(this.lastWidth, taperW) * 2 + 16;
          this.expandDirtyBounds(nx, ny, pad);
          this.expandDirtyBounds(nextMid.x, nextMid.y, pad);
          this.drawSymmetricSegment(
            this.strokeCtx,
            this.midPt,
            this.prevPt,
            nextMid,
            this.lastWidth,
            taperW,
            this.lastPressure,
            this.lastVelocity
          );
          this.midPt = nextMid;
          this.prevPt = { x: nx, y: ny };
          this.lastWidth = taperW;
        }
        this.ropeX = this.lastRawPt.x;
        this.ropeY = this.lastRawPt.y;
      }

      if (active) {
        this.commitStrokeBufferToLayer(active.id, active.ctx);
      } else {
        this.strokeCtx.clearRect(0, 0, this.width, this.height);
        this.hasStrokeBuffer = false;
        this.strokeLayerId = null;
      }
    }

    this.lastDryNormal = null;
    this.lastDryNormalMirror = null;
  }

  private computeStrokeWidth(pressure: number, velocity: number): number {
    const base = this.brush.size;
    // True stylus check (`pointerType === 'pen'`) — NEVER treat real 0.50 stylus pressure as fake mouse default!
    const isRealPen =
      this.brush.pressureEnabled && this.activePointerType === 'pen' && pressure > 0;
    const p = isRealPen ? Math.max(0.05, Math.min(1, pressure)) : 0.72;

    if (this.brush.tool === 'gpen') {
      const velFactor = Math.max(0.38, Math.min(1.3, 1.22 - velocity * 0.26));
      const pFactor = 0.3 + p * 1.18;
      return Math.max(1, base * velFactor * pFactor);
    }
    if (this.brush.tool === 'dry-brush') {
      const velFactor = Math.max(0.55, Math.min(1.4, 1.25 - velocity * 0.16));
      return Math.max(3, base * 1.65 * velFactor * (0.55 + p * 0.7));
    }
    if (this.brush.tool === 'pencil' || this.brush.tool === 'blue-rough') {
      return Math.max(1.2, base * (0.64 + p * 0.56));
    }
    if (this.brush.tool === 'marker' || this.brush.tool === 'screentone') {
      return Math.max(6, base * 2.0);
    }
    if (this.brush.tool === 'eraser') {
      return Math.max(4, base * 2.1);
    }
    return base;
  }

  private drawSymmetricSegment(
    ctx: CanvasRenderingContext2D,
    p0: { x: number; y: number },
    ctrl: { x: number; y: number },
    p1: { x: number; y: number },
    w0: number,
    w1: number,
    pressure: number,
    velocity: number
  ): void {
    this.drawBezierSegment(ctx, p0, ctrl, p1, w0, w1, pressure, velocity, false);
    if (this.brush.symmetryX) {
      const mx = (v: number) => this.width - v;
      this.drawBezierSegment(
        ctx,
        { x: mx(p0.x), y: p0.y },
        { x: mx(ctrl.x), y: ctrl.y },
        { x: mx(p1.x), y: p1.y },
        w0,
        w1,
        pressure,
        velocity,
        true
      );
    }
  }

  private ensureGrainScratchSize(minSide: number): void {
    if (this.grainScratch.width >= minSide && this.grainScratch.height >= minSide) return;
    const next = Math.max(256, Math.ceil(minSide / 64) * 64);
    this.grainScratch.width = next;
    this.grainScratch.height = next;
    this.grainScratchCtx = this.grainScratch.getContext('2d')!;
  }

  /** Fills a smooth variable-width tangent capsule between `(x0, y0, r0)` and `(x1, y1, r1)` (`0` beading!) */
  private fillVariableCapsule(
    ctx: CanvasRenderingContext2D,
    x0: number,
    y0: number,
    r0: number,
    x1: number,
    y1: number,
    r1: number
  ): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const d = Math.hypot(dx, dy);
    if (d < 0.001 || d <= Math.abs(r1 - r0)) {
      ctx.beginPath();
      if (r0 >= r1) {
        ctx.arc(x0, y0, r0, 0, Math.PI * 2);
      } else {
        ctx.arc(x1, y1, r1, 0, Math.PI * 2);
      }
      ctx.fill();
      return;
    }

    const ux = dx / d;
    const uy = dy / d;
    const nx = -uy;
    const ny = ux;
    const cosA = Math.max(-1, Math.min(1, (r0 - r1) / d));
    const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));

    // Left and right external tangent unit normals
    const lnx = ux * cosA + nx * sinA;
    const lny = uy * cosA + ny * sinA;
    const rnx = ux * cosA - nx * sinA;
    const rny = uy * cosA - ny * sinA;

    ctx.beginPath();
    ctx.arc(x0, y0, r0, 0, Math.PI * 2);
    ctx.arc(x1, y1, r1, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(x0 + lnx * r0, y0 + lny * r0);
    ctx.lineTo(x1 + lnx * r1, y1 + lny * r1);
    ctx.lineTo(x1 + rnx * r1, y1 + rny * r1);
    ctx.lineTo(x0 + rnx * r0, y0 + rny * r0);
    ctx.closePath();
    ctx.fill();
  }

  /** Renders 6 distinct artist brushes onto `strokeCanvas` (full base coverage; stroke opacity applied once!) */
  private drawBezierSegment(
    ctx: CanvasRenderingContext2D,
    p0: { x: number; y: number },
    ctrl: { x: number; y: number },
    p1: { x: number; y: number },
    w0: number,
    w1: number,
    pressure: number,
    velocity: number,
    isMirrored: boolean
  ): void {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (this.brush.tool === 'eraser') {
      // Accumulate opaque mask on `strokeCanvas`; `destination-out` + `activeStrokeOpacity` applied once!
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
      ctx.globalAlpha = 1;
      ctx.lineWidth = (w0 + w1) * 0.5;
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.quadraticCurveTo(ctrl.x, ctrl.y, p1.x, p1.y);
      ctx.stroke();
      ctx.restore();
      return;
    }

    if (this.brush.tool === 'marker') {
      // Drawn at alpha=1 on `strokeCanvas` so overlapping turns have ZERO dark joint blobs!
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = this.brush.color;
      ctx.globalAlpha = 1;
      ctx.lineWidth = (w0 + w1) * 0.5;
      ctx.lineCap = 'square';
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.quadraticCurveTo(ctrl.x, ctrl.y, p1.x, p1.y);
      ctx.stroke();
      ctx.restore();
      return;
    }

    if (this.brush.tool === 'screentone') {
      const pattern = getScreentonePattern(ctx, this.brush.color);
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = pattern ?? this.brush.color;
      ctx.globalAlpha = 1;
      ctx.lineWidth = (w0 + w1) * 0.5;
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.quadraticCurveTo(ctrl.x, ctrl.y, p1.x, p1.y);
      ctx.stroke();
      ctx.restore();
      return;
    }

    const chord =
      Math.hypot(ctrl.x - p0.x, ctrl.y - p0.y) + Math.hypot(p1.x - ctrl.x, p1.y - ctrl.y);

    // 5-Bristle Dry Sumi-e Brush with continuous normal interpolation across curves (`0` corner cracks!)
    if (this.brush.tool === 'dry-brush') {
      const dx = p1.x - p0.x;
      const dy = p1.y - p0.y;
      const len = Math.hypot(dx, dy);
      const prevNorm = isMirrored ? this.lastDryNormalMirror : this.lastDryNormal;
      const rawEnd =
        len > 0.25 ? { nx: -dy / len, ny: dx / len } : (prevNorm ?? { nx: 0, ny: 1 });
      const startN = prevNorm ?? rawEnd;
      // Smoothly blend end normal to prevent bristle flip on sharp corners
      const blendX = startN.nx * 0.35 + rawEnd.nx * 0.65;
      const blendY = startN.ny * 0.35 + rawEnd.ny * 0.65;
      const blendLen = Math.hypot(blendX, blendY) || 1;
      const endN = { nx: blendX / blendLen, ny: blendY / blendLen };
      const midNxRaw = (startN.nx + endN.nx) * 0.5;
      const midNyRaw = (startN.ny + endN.ny) * 0.5;
      const midLen = Math.hypot(midNxRaw, midNyRaw) || 1;
      const midN = { nx: midNxRaw / midLen, ny: midNyRaw / midLen };

      if (isMirrored) {
        this.lastDryNormalMirror = endN;
      } else {
        this.lastDryNormal = endN;
      }

      const avgW = (w0 + w1) * 0.5;
      const midW = avgW;
      const dryBreak = Math.min(0.75, velocity * 0.24);
      const bristles = [-0.42, -0.21, 0, 0.21, 0.42];
      ctx.strokeStyle = this.brush.color;
      ctx.globalCompositeOperation = 'source-over';

      for (let b = 0; b < bristles.length; b++) {
        const bf = bristles[b];
        const bAlpha = Math.max(0.24, 0.94 - dryBreak * (0.45 + (b % 2) * 0.4));
        ctx.globalAlpha = bAlpha;
        ctx.lineWidth = Math.max(1.1, avgW * (b === 2 ? 0.34 : 0.22));
        ctx.beginPath();
        ctx.moveTo(p0.x + startN.nx * (bf * w0), p0.y + startN.ny * (bf * w0));
        ctx.quadraticCurveTo(
          ctrl.x + midN.nx * (bf * midW),
          ctrl.y + midN.ny * (bf * midW),
          p1.x + endN.nx * (bf * w1),
          p1.y + endN.ny * (bf * w1)
        );
        ctx.stroke();
      }
      ctx.restore();
      return;
    }

    // 2B Graphite Pencil & Non-Photo Blue Sketch Pencil with Seamless 128x128 World-Locked Paper Tooth!
    if (this.brush.tool === 'pencil' || this.brush.tool === 'blue-rough') {
      const color = this.brush.tool === 'blue-rough' ? '#2563EB' : this.brush.color;
      const isRealPen =
        this.brush.pressureEnabled && this.activePointerType === 'pen' && pressure > 0;
      const pAlpha = isRealPen ? Math.min(1, 0.4 + pressure * 0.65) : 0.78;
      const grain = getGraphiteGrainCanvas();
      const tile = GRAIN_TILE_SIZE;
      const steps = Math.max(1, Math.ceil(chord / Math.max(1.5, (w0 + w1) * 0.22)));

      ctx.globalCompositeOperation = 'source-over';
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const omt = 1 - t;
        const x = omt * omt * p0.x + 2 * omt * t * ctrl.x + t * t * p1.x;
        const y = omt * omt * p0.y + 2 * omt * t * ctrl.y + t * t * p1.y;
        const r = Math.max(1.2, (w0 + (w1 - w0) * t) * 0.62);
        const diam = Math.max(4, Math.ceil(r * 2 + 4));
        this.ensureGrainScratchSize(diam);
        const gctx = this.grainScratchCtx;

        // Snap dab box top-left to integer canvas coords so world grain NEVER crawls when `diam` changes!
        const originX = Math.floor(x - diam * 0.5);
        const originY = Math.floor(y - diam * 0.5);
        const localCx = x - originX;
        const localCy = y - originY;

        gctx.clearRect(0, 0, diam, diam);
        gctx.globalCompositeOperation = 'source-over';
        gctx.fillStyle = color;
        gctx.beginPath();
        gctx.arc(localCx, localCy, r, 0, Math.PI * 2);
        gctx.fill();

        gctx.globalCompositeOperation = 'destination-in';
        const tx = ((originX % tile) + tile) % tile;
        const ty = ((originY % tile) + tile) % tile;
        for (let gy = -ty; gy < diam; gy += tile) {
          for (let gx = -tx; gx < diam; gx += tile) {
            gctx.drawImage(grain, gx, gy);
          }
        }

        ctx.globalAlpha = pAlpha * 0.72;
        ctx.drawImage(this.grainScratch, 0, 0, diam, diam, originX, originY, diam, diam);
      }
      ctx.restore();
      return;
    }

    // G-Pen Manga Dip Nib: continuous variable-width tangent capsules (`0` beading, `0` opacity knots!)
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = this.brush.color;
    ctx.globalAlpha = 1;
    const steps = Math.max(1, Math.min(48, Math.ceil(chord / Math.max(2, Math.min(w0, w1) * 0.6))));
    let prevX = p0.x;
    let prevY = p0.y;
    let prevR = Math.max(0.55, w0 * 0.5);

    if (chord < 0.5) {
      ctx.beginPath();
      ctx.arc(prevX, prevY, prevR, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const omt = 1 - t;
      const x = omt * omt * p0.x + 2 * omt * t * ctrl.x + t * t * p1.x;
      const y = omt * omt * p0.y + 2 * omt * t * ctrl.y + t * t * p1.y;
      const r = Math.max(0.55, (w0 + (w1 - w0) * t) * 0.5);
      this.fillVariableCapsule(ctx, prevX, prevY, prevR, x, y, r);
      prevX = x;
      prevY = y;
      prevR = r;
    }
    ctx.restore();
  }

  private liftLassoSelection(active: {
    id: string;
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
  }): void {
    const pts = this.lassoPoints;
    let minX = this.width;
    let minY = this.height;
    let maxX = 0;
    let maxY = 0;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    minX = Math.max(0, Math.floor(minX));
    minY = Math.max(0, Math.floor(minY));
    maxX = Math.min(this.width, Math.ceil(maxX));
    maxY = Math.min(this.height, Math.ceil(maxY));
    const bw = maxX - minX;
    const bh = maxY - minY;
    if (bw < 6 || bh < 6) return;

    this.strokeBeforeFull = new Uint8ClampedArray(
      active.ctx.getImageData(0, 0, this.width, this.height).data
    );

    const cut = document.createElement('canvas');
    cut.width = bw;
    cut.height = bh;
    const cctx = cut.getContext('2d')!;
    cctx.save();
    cctx.beginPath();
    cctx.moveTo(pts[0].x - minX, pts[0].y - minY);
    for (let i = 1; i < pts.length; i++) cctx.lineTo(pts[i].x - minX, pts[i].y - minY);
    cctx.closePath();
    cctx.clip();
    cctx.drawImage(active.canvas, -minX, -minY);
    cctx.restore();

    active.ctx.save();
    active.ctx.globalCompositeOperation = 'destination-out';
    active.ctx.beginPath();
    active.ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) active.ctx.lineTo(pts[i].x, pts[i].y);
    active.ctx.closePath();
    active.ctx.fill();
    active.ctx.restore();

    this.floating = {
      canvas: cut,
      x: minX,
      y: minY,
      w: bw,
      h: bh,
      dx: 0,
      dy: 0,
      rotation: 0,
      scale: 1,
      flipX: false,
    };
    this.onFloatingChange?.(true);
  }

  public copyFloatingToClipboard(): boolean {
    if (!this.floating) return false;
    const clone = document.createElement('canvas');
    clone.width = this.floating.w;
    clone.height = this.floating.h;
    clone.getContext('2d')!.drawImage(this.floating.canvas, 0, 0);
    sharedClipboard = {
      canvas: clone,
      x: this.floating.x + this.floating.dx,
      y: this.floating.y + this.floating.dy,
      w: this.floating.w,
      h: this.floating.h,
    };
    return true;
  }

  public pasteClipboardAsFloating(): boolean {
    if (!sharedClipboard) return false;
    const active = this.getActiveLayer();
    if (!active) return false;
    if (this.floating) this.commitFloatingSelection();

    this.strokeBeforeFull = new Uint8ClampedArray(
      active.ctx.getImageData(0, 0, this.width, this.height).data
    );
    const clone = document.createElement('canvas');
    clone.width = sharedClipboard.w;
    clone.height = sharedClipboard.h;
    clone.getContext('2d')!.drawImage(sharedClipboard.canvas, 0, 0);

    this.floating = {
      canvas: clone,
      x: Math.max(0, Math.min(this.width - sharedClipboard.w, sharedClipboard.x)),
      y: Math.max(0, Math.min(this.height - sharedClipboard.h, sharedClipboard.y)),
      w: sharedClipboard.w,
      h: sharedClipboard.h,
      dx: 0,
      dy: 0,
      rotation: 0,
      scale: 1,
      flipX: false,
    };
    this.onFloatingChange?.(true);
    this.requestRender();
    return true;
  }

  public transformFloating(delta: { rotation?: number; scale?: number; flipX?: boolean }): void {
    if (!this.floating) return;
    if (delta.rotation) this.floating.rotation += delta.rotation;
    if (delta.scale) {
      this.floating.scale = Math.max(0.2, Math.min(4, this.floating.scale * delta.scale));
    }
    if (delta.flipX) this.floating.flipX = !this.floating.flipX;
    this.requestRender();
  }

  public commitFloatingSelection(): void {
    if (!this.floating) return;
    const active = this.getActiveLayer();
    if (active) {
      const f = this.floating;
      if (!this.strokeBeforeFull) {
        this.strokeBeforeFull = new Uint8ClampedArray(
          active.ctx.getImageData(0, 0, this.width, this.height).data
        );
      }
      active.ctx.save();
      const cx = f.x + f.w / 2 + f.dx;
      const cy = f.y + f.h / 2 + f.dy;
      active.ctx.translate(cx, cy);
      active.ctx.rotate((f.rotation * Math.PI) / 180);
      active.ctx.scale(f.flipX ? -f.scale : f.scale, f.scale);
      active.ctx.drawImage(f.canvas, -f.w / 2, -f.h / 2);
      active.ctx.restore();
      this.commitDirtyUndo(active.id, active.ctx, true);
    }
    this.floating = null;
    this.onFloatingChange?.(false);
    this.requestRender();
  }

  public clearActiveLayer(): void {
    const active = this.getActiveLayer();
    if (!active) return;
    if (this.floating) this.commitFloatingSelection();
    this.strokeBeforeFull = new Uint8ClampedArray(
      active.ctx.getImageData(0, 0, this.width, this.height).data
    );
    active.ctx.clearRect(0, 0, this.width, this.height);
    this.commitDirtyUndo(active.id, active.ctx, true);
    this.requestRender();
  }

  private pushUndo(entry: DirtyUndoEntry): void {
    if (!this.frame) return;
    const hist = this.getOrCreateFrameHistory(this.frame.id);
    // Clear redo stack and reclaim its bytes
    for (const r of hist.redo) {
      hist.bytes = Math.max(0, hist.bytes - entryByteSize(r));
    }
    hist.redo = [];

    hist.undo.push(entry);
    hist.bytes += entryByteSize(entry);

    const limit = getMaxUndoSteps();
    while (hist.undo.length > limit) {
      const dropped = hist.undo.shift()!;
      hist.bytes = Math.max(0, hist.bytes - entryByteSize(dropped));
    }
    this.enforceTotalHistoryBudget(this.frame.id);
    this.onHistoryChange?.(hist.undo.length > 0, false);
  }

  public undo(): string | null {
    if (this.floating) this.commitFloatingSelection();
    if (!this.frame) return null;
    const hist = this.frameHistory.get(this.frame.id);
    if (!hist) return null;
    const entry = hist.undo.pop();
    if (!entry) return null;

    const lc = this.layerCanvases.get(entry.layerId);
    if (lc) {
      const ctx = lc.getContext('2d', { willReadFrequently: true })!;
      ctx.putImageData(
        new ImageData(new Uint8ClampedArray(entry.before), entry.rect.w, entry.rect.h),
        entry.rect.x,
        entry.rect.y
      );
    }
    hist.redo.push(entry);
    this.onHistoryChange?.(hist.undo.length > 0, hist.redo.length > 0);
    this.requestRender();
    return entry.layerId;
  }

  public redo(): string | null {
    if (!this.frame) return null;
    const hist = this.frameHistory.get(this.frame.id);
    if (!hist) return null;
    const entry = hist.redo.pop();
    if (!entry) return null;

    const lc = this.layerCanvases.get(entry.layerId);
    if (lc) {
      const ctx = lc.getContext('2d', { willReadFrequently: true })!;
      ctx.putImageData(
        new ImageData(new Uint8ClampedArray(entry.after), entry.rect.w, entry.rect.h),
        entry.rect.x,
        entry.rect.y
      );
    }
    hist.undo.push(entry);
    this.onHistoryChange?.(hist.undo.length > 0, hist.redo.length > 0);
    this.requestRender();
    return entry.layerId;
  }

  private createCompositeThumbCanvas(): HTMLCanvasElement {
    const tw = 512;
    const th = Math.max(180, Math.round((this.height / this.width) * tw));
    const tc = document.createElement('canvas');
    tc.width = tw;
    tc.height = th;
    const tctx = tc.getContext('2d')!;
    tctx.fillStyle = this.paperStyle === 'kraft' ? '#D9C29C' : this.paperColor;
    tctx.fillRect(0, 0, tw, th);
    if (this.bgCanvas) {
      tctx.drawImage(this.bgCanvas, 0, 0, tw, th);
    }
    if (this.frame) {
      for (const layer of this.frame.layers) {
        if (!layer.visible) continue;
        const c = this.layerCanvases.get(layer.id);
        if (!c) continue;
        tctx.save();
        tctx.globalAlpha = layer.opacity;
        tctx.globalCompositeOperation =
          layer.blendMode === 'multiply' ? 'multiply' : 'source-over';
        tctx.drawImage(c, 0, 0, tw, th);
        tctx.restore();
      }
    }
    return tc;
  }

  /** Synchronously snapshots a layer canvas + composite thumbnail BEFORE any `await` so rapid frame switches NEVER race! */
  public snapshotLayerAndThumbSync(
    layerId: string
  ): { layerSnap: HTMLCanvasElement; thumbSnap: HTMLCanvasElement } | null {
    if (this.floating) this.commitFloatingSelection();
    const lc = this.layerCanvases.get(layerId);
    if (!lc) return null;

    const layerSnap = document.createElement('canvas');
    layerSnap.width = this.width;
    layerSnap.height = this.height;
    layerSnap.getContext('2d')!.drawImage(lc, 0, 0);

    const thumbSnap = this.createCompositeThumbCanvas();
    return { layerSnap, thumbSnap };
  }

  public async persistSnapshot(
    snap: { layerSnap: HTMLCanvasElement; thumbSnap: HTMLCanvasElement },
    existingLayerBlobKey: string | null,
    existingThumbKey: string | null | undefined
  ): Promise<{ layerBlobKey: string; thumbKey: string }> {
    const [pngBlob, thumbBlob] = await Promise.all([
      canvasToPngBlob(snap.layerSnap),
      canvasToWebpOrJpegBlob(snap.thumbSnap, 0.86),
    ]);
    const [layerBlobKey, thumbKey] = await Promise.all([
      saveBlob(pngBlob, existingLayerBlobKey ?? undefined),
      saveBlob(thumbBlob, existingThumbKey ?? undefined),
    ]);
    return { layerBlobKey, thumbKey };
  }

  public async persistThumbOnly(
    existingThumbKey: string | null | undefined
  ): Promise<string | null> {
    if (!this.frame) return null;
    const tc = this.createCompositeThumbCanvas();
    const thumbBlob = await canvasToWebpOrJpegBlob(tc, 0.86);
    return saveBlob(thumbBlob, existingThumbKey ?? undefined);
  }

  public async persistLayerAndThumb(
    layerId: string,
    existingLayerBlobKey: string | null,
    existingThumbKey: string | null | undefined
  ): Promise<{ layerBlobKey: string; thumbKey: string } | null> {
    const snap = this.snapshotLayerAndThumbSync(layerId);
    if (!snap) return null;
    return this.persistSnapshot(snap, existingLayerBlobKey, existingThumbKey);
  }

  public dispose(): void {
    this.disposed = true;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.layerCanvases.clear();
    this.onionPrevCanvases = [];
    this.onionNextCanvases = [];
    this.bgCanvas = null;
    this.cleanTimelapseCanvas = null;
    this.frameHistory.clear();
  }
}
