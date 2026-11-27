import { beforeEach, describe, expect, it, vi } from 'vitest';

// Deterministic in-memory idb-keyval mock for Node tests
const memIdb = new Map<string, unknown>();
vi.mock('idb-keyval', () => ({
  get: async (k: string) => memIdb.get(k),
  set: async (k: string, v: unknown) => {
    memIdb.set(k, v);
  },
  setMany: async (entries: [string, unknown][]) => {
    for (const [k, v] of entries) memIdb.set(k, v);
  },
  del: async (k: string) => {
    memIdb.delete(k);
  },
  clear: async () => {
    memIdb.clear();
  },
  keys: async () => Array.from(memIdb.keys()),
}));

import {
  detectPaperCorners,
  processPaperScan,
  sliceGridCells,
  type QuadCorners,
} from '../paperWorker';
import { inpaintBehindLimbSocketsRGBA } from '../socketInpaint';
import { drawInpaintedSocketBackingPass } from '../webglSkinnedRenderer';
import {
  resolveExportDimensions,
  selectH264CodecCandidates,
} from '../videoExportEngine';
import { renderAudioTrackOffline } from '../audioEngine';
import { GRAIN_TILE_SIZE, getGraphiteGrainCanvas } from '../brushTextures';
import { StudioCanvasEngine } from '../canvasEngine';
import { convertMultiplySourceToTransparentCanvas } from '../frameComposite';
import { decodeSharedStage, encodeSharedStage, type ShareStrokeRecord } from '../shareCodec';
import {
  encodePdfTextLiteral,
  generateFlipbookPdfBlob,
  measureHelveticaWidthPt,
  truncatePdfTextToWidth,
} from '../flipbookPdf';
import {
  buildZipBlob,
  crc32,
  encodeDosDateTime,
  parseZipBytes,
} from '../zipBuilder';
import {
  collectAllReferencedBlobKeys,
  loadBlob,
  saveAllProjects,
  saveBlob,
  setActiveStorageScope,
  sweepUnreferencedBlobs,
} from '../db';
import {
  exportPortableBackupZip,
  importPortableBackupZip,
  SAFE_IMPORT_MIMES,
  sanitizeImportMime,
} from '../exportEngine';
import {
  exportKagit25dPackage,
  importKagit25dPackage,
} from '../kagit25dPipeline';
import { fillClosedContoursRGBA } from '../skeletonSkinEngine';
import { registerCanvasFlusher, useStudioStore } from '../../store/useStudioStore';
import type { BrushSettings, CelFrame, FieldGuideConfig, OnionSkinConfig, StudioProject } from '../../types/studio';
import type { FilmActor, FilmProjectGraph } from '../../types/film';
import worker from '../../../worker/index.js';

import exportEngineSrc from '../exportEngine.ts?raw';
import puppetStudioSrc from '../../components/puppet/PuppetStudio.tsx?raw';
import meshWarpSrc from '../../components/puppet/MeshWarpStage.tsx?raw';
import instantAliveSrc from '../../components/desk/InstantAliveStage.tsx?raw';
import filmStudioSrc from '../../components/film/FilmDirectorStudio.tsx?raw';
import drawingStageSrc from '../../components/studio/DrawingStage.tsx?raw';

// ============================================================================
// Lightweight Pure-Pixel HTMLCanvasElement + ImageData Polyfill for Node Vitest
// ============================================================================

class MockImageData {
  public data: Uint8ClampedArray;
  public width: number;
  public height: number;
  constructor(dataOrW: Uint8ClampedArray | number, wOrH: number, maybeH?: number) {
    if (typeof dataOrW === 'number') {
      this.width = dataOrW;
      this.height = wOrH;
      this.data = new Uint8ClampedArray(this.width * this.height * 4);
    } else {
      this.data = dataOrW;
      this.width = wOrH;
      this.height = maybeH ?? Math.max(1, Math.floor(dataOrW.length / (4 * wOrH)));
    }
  }
}

function parseColorRgba(style: unknown): [number, number, number, number] {
  if (typeof style !== 'string') return [28, 25, 23, 255];
  const s = style.trim();
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    const full =
      hex.length === 3
        ? hex
            .split('')
            .map((c) => c + c)
            .join('')
        : hex.padEnd(6, '0');
    const n = parseInt(full.slice(0, 6), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
  }
  const m = s.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i);
  if (m) {
    const a = m[4] !== undefined ? Math.round(Number(m[4]) * 255) : 255;
    return [Number(m[1]) | 0, Number(m[2]) | 0, Number(m[3]) | 0, Math.max(0, Math.min(255, a))];
  }
  return [28, 25, 23, 255];
}

interface PathSubCmd {
  kind: 'move' | 'line' | 'quad' | 'arc' | 'rect';
  vals: number[];
}

class MockCanvas2D {
  public width: number;
  public height: number;
  public pixels: Uint8ClampedArray;
  private ctxObj: Record<string, unknown>;

  constructor(w = 300, h = 150) {
    this.width = w;
    this.height = h;
    this.pixels = new Uint8ClampedArray(w * h * 4);
    this.ctxObj = this.buildContext();
  }

  private resizeIfNeeded() {
    const len = Math.max(1, this.width) * Math.max(1, this.height) * 4;
    if (this.pixels.length !== len) {
      this.pixels = new Uint8ClampedArray(len);
    }
  }

  private blendPixel(px: number, py: number, sr: number, sg: number, sb: number, saNorm: number, op: string) {
    if (px < 0 || py < 0 || px >= this.width || py >= this.height || saNorm <= 0) return;
    const o = (py * this.width + px) * 4;
    const dr = this.pixels[o];
    const dg = this.pixels[o + 1];
    const db = this.pixels[o + 2];
    const da = this.pixels[o + 3] / 255;

    if (op === 'destination-out') {
      this.pixels[o + 3] = Math.round(da * (1 - saNorm) * 255);
      return;
    }
    if (op === 'destination-in') {
      this.pixels[o + 3] = Math.round(da * saNorm * 255);
      return;
    }
    if (op === 'source-in') {
      const outA = da * saNorm;
      this.pixels[o] = sr;
      this.pixels[o + 1] = sg;
      this.pixels[o + 2] = sb;
      this.pixels[o + 3] = Math.round(outA * 255);
      return;
    }

    // Porter-Duff source-over (straight alpha)
    const outA = saNorm + da * (1 - saNorm);
    if (outA <= 1e-5) {
      this.pixels[o] = 0;
      this.pixels[o + 1] = 0;
      this.pixels[o + 2] = 0;
      this.pixels[o + 3] = 0;
      return;
    }
    this.pixels[o] = Math.round((sr * saNorm + dr * da * (1 - saNorm)) / outA);
    this.pixels[o + 1] = Math.round((sg * saNorm + dg * da * (1 - saNorm)) / outA);
    this.pixels[o + 2] = Math.round((sb * saNorm + db * da * (1 - saNorm)) / outA);
    this.pixels[o + 3] = Math.round(outA * 255);
  }

  private buildContext(): Record<string, unknown> {
    let globalAlpha = 1;
    let globalCompositeOperation = 'source-over';
    let fillStyle: unknown = '#000000';
    let strokeStyle: unknown = '#000000';
    let lineWidth = 1;
    const stack: { ga: number; gco: string; fs: unknown; ss: unknown; lw: number }[] = [];
    let cmds: PathSubCmd[] = [];

    const ctx: Record<string, unknown> = {
      canvas: this,
      get globalAlpha() {
        return globalAlpha;
      },
      set globalAlpha(v: number) {
        globalAlpha = Math.max(0, Math.min(1, v));
      },
      get globalCompositeOperation() {
        return globalCompositeOperation;
      },
      set globalCompositeOperation(v: string) {
        globalCompositeOperation = v;
      },
      get fillStyle() {
        return fillStyle;
      },
      set fillStyle(v: unknown) {
        fillStyle = v;
      },
      get strokeStyle() {
        return strokeStyle;
      },
      set strokeStyle(v: unknown) {
        strokeStyle = v;
      },
      get lineWidth() {
        return lineWidth;
      },
      set lineWidth(v: number) {
        lineWidth = v;
      },
      lineCap: 'round',
      lineJoin: 'round',
      font: '12px sans-serif',
      textAlign: 'left',
      textBaseline: 'alphabetic',
      save: () => {
        stack.push({
          ga: globalAlpha,
          gco: globalCompositeOperation,
          fs: fillStyle,
          ss: strokeStyle,
          lw: lineWidth,
        });
      },
      restore: () => {
        const s = stack.pop();
        if (s) {
          globalAlpha = s.ga;
          globalCompositeOperation = s.gco;
          fillStyle = s.fs;
          strokeStyle = s.ss;
          lineWidth = s.lw;
        }
      },
      setLineDash: () => {},
      translate: () => {},
      rotate: () => {},
      scale: () => {},
      transform: () => {},
      clip: () => {},
      fillText: () => {},
      measureText: (t: string) => ({ width: t.length * 7 }),
      createPattern: () => '#000000',
      createLinearGradient: () => ({ addColorStop: () => {} }),
      createRadialGradient: () => ({ addColorStop: () => {} }),
      createImageData: (w: number, h: number) => new MockImageData(w, h),
      clearRect: (x: number, y: number, w: number, h: number) => {
        this.resizeIfNeeded();
        const x0 = Math.max(0, Math.floor(x));
        const y0 = Math.max(0, Math.floor(y));
        const x1 = Math.min(this.width, Math.ceil(x + w));
        const y1 = Math.min(this.height, Math.ceil(y + h));
        for (let py = y0; py < y1; py++) {
          this.pixels.fill(0, (py * this.width + x0) * 4, (py * this.width + x1) * 4);
        }
      },
      fillRect: (x: number, y: number, w: number, h: number) => {
        this.resizeIfNeeded();
        const [r, g, b, a] = parseColorRgba(fillStyle);
        const sa = (a / 255) * globalAlpha;
        const x0 = Math.max(0, Math.floor(x));
        const y0 = Math.max(0, Math.floor(y));
        const x1 = Math.min(this.width, Math.ceil(x + w));
        const y1 = Math.min(this.height, Math.ceil(y + h));
        for (let py = y0; py < y1; py++) {
          for (let px = x0; px < x1; px++) {
            this.blendPixel(px, py, r, g, b, sa, globalCompositeOperation);
          }
        }
      },
      strokeRect: () => {},
      roundRect: (x: number, y: number, w: number, h: number) => {
        cmds.push({ kind: 'rect', vals: [x, y, w, h] });
      },
      beginPath: () => {
        cmds = [];
      },
      closePath: () => {},
      moveTo: (x: number, y: number) => {
        cmds.push({ kind: 'move', vals: [x, y] });
      },
      lineTo: (x: number, y: number) => {
        cmds.push({ kind: 'line', vals: [x, y] });
      },
      quadraticCurveTo: (cx: number, cy: number, x: number, y: number) => {
        cmds.push({ kind: 'quad', vals: [cx, cy, x, y] });
      },
      arc: (cx: number, cy: number, r: number) => {
        cmds.push({ kind: 'arc', vals: [cx, cy, r] });
      },
      ellipse: (cx: number, cy: number, rx: number) => {
        cmds.push({ kind: 'arc', vals: [cx, cy, rx] });
      },
      rect: (x: number, y: number, w: number, h: number) => {
        cmds.push({ kind: 'rect', vals: [x, y, w, h] });
      },
      fill: () => {
        this.resizeIfNeeded();
        const [r, g, b, a] = parseColorRgba(fillStyle);
        const sa = (a / 255) * globalAlpha;
        const polyPts: { x: number; y: number }[] = [];
        for (const c of cmds) {
          if (c.kind === 'arc') {
            const [cx, cy, rad] = c.vals;
            const x0 = Math.max(0, Math.floor(cx - rad));
            const y0 = Math.max(0, Math.floor(cy - rad));
            const x1 = Math.min(this.width - 1, Math.ceil(cx + rad));
            const y1 = Math.min(this.height - 1, Math.ceil(cy + rad));
            for (let py = y0; py <= y1; py++) {
              for (let px = x0; px <= x1; px++) {
                if (Math.hypot(px + 0.5 - cx, py + 0.5 - cy) <= rad) {
                  this.blendPixel(px, py, r, g, b, sa, globalCompositeOperation);
                }
              }
            }
          } else if (c.kind === 'move' || c.kind === 'line') {
            polyPts.push({ x: c.vals[0], y: c.vals[1] });
          }
        }
        if (polyPts.length >= 3) {
          let minY = this.height;
          let maxY = 0;
          for (const p of polyPts) {
            if (p.y < minY) minY = p.y;
            if (p.y > maxY) maxY = p.y;
          }
          const y0 = Math.max(0, Math.floor(minY));
          const y1 = Math.min(this.height - 1, Math.ceil(maxY));
          for (let py = y0; py <= y1; py++) {
            const sy = py + 0.5;
            const xs: number[] = [];
            for (let i = 0, j = polyPts.length - 1; i < polyPts.length; j = i++) {
              const yi = polyPts[i].y;
              const yj = polyPts[j].y;
              if ((yi > sy) !== (yj > sy)) {
                xs.push(
                  polyPts[i].x + ((polyPts[j].x - polyPts[i].x) * (sy - yi)) / (yj - yi)
                );
              }
            }
            xs.sort((u, v) => u - v);
            for (let k = 0; k + 1 < xs.length; k += 2) {
              const x0 = Math.max(0, Math.floor(xs[k]));
              const x1 = Math.min(this.width - 1, Math.ceil(xs[k + 1]));
              for (let px = x0; px <= x1; px++) {
                this.blendPixel(px, py, r, g, b, sa, globalCompositeOperation);
              }
            }
          }
        }
      },
      stroke: () => {
        this.resizeIfNeeded();
        const [r, g, b, a] = parseColorRgba(strokeStyle);
        const sa = (a / 255) * globalAlpha;
        const rad = Math.max(0.6, lineWidth * 0.5);
        const painted = new Uint8Array(this.width * this.height);
        const stampDisk = (cx: number, cy: number) => {
          const x0 = Math.max(0, Math.floor(cx - rad));
          const y0 = Math.max(0, Math.floor(cy - rad));
          const x1 = Math.min(this.width - 1, Math.ceil(cx + rad));
          const y1 = Math.min(this.height - 1, Math.ceil(cy + rad));
          for (let py = y0; py <= y1; py++) {
            for (let px = x0; px <= x1; px++) {
              const idx = py * this.width + px;
              if (painted[idx]) continue;
              if (Math.hypot(px + 0.5 - cx, py + 0.5 - cy) <= rad) {
                painted[idx] = 1;
                this.blendPixel(px, py, r, g, b, sa, globalCompositeOperation);
              }
            }
          }
        };
        let curX = 0;
        let curY = 0;
        for (const c of cmds) {
          if (c.kind === 'move') {
            curX = c.vals[0];
            curY = c.vals[1];
            stampDisk(curX, curY);
          } else if (c.kind === 'line') {
            const [nx, ny] = c.vals;
            const steps = Math.max(1, Math.ceil(Math.hypot(nx - curX, ny - curY)));
            for (let s = 0; s <= steps; s++) {
              const t = s / steps;
              stampDisk(curX + (nx - curX) * t, curY + (ny - curY) * t);
            }
            curX = nx;
            curY = ny;
          } else if (c.kind === 'quad') {
            const [qx, qy, nx, ny] = c.vals;
            const steps = Math.max(
              2,
              Math.ceil(Math.hypot(qx - curX, qy - curY) + Math.hypot(nx - qx, ny - qy))
            );
            for (let s = 0; s <= steps; s++) {
              const t = s / steps;
              const omt = 1 - t;
              stampDisk(
                omt * omt * curX + 2 * omt * t * qx + t * t * nx,
                omt * omt * curY + 2 * omt * t * qy + t * t * ny
              );
            }
            curX = nx;
            curY = ny;
          }
        }
      },
      getImageData: (x: number, y: number, w: number, h: number) => {
        this.resizeIfNeeded();
        const out = new Uint8ClampedArray(w * h * 4);
        for (let row = 0; row < h; row++) {
          const sy = y + row;
          if (sy < 0 || sy >= this.height) continue;
          for (let col = 0; col < w; col++) {
            const sx = x + col;
            if (sx < 0 || sx >= this.width) continue;
            const so = (sy * this.width + sx) * 4;
            const doff = (row * w + col) * 4;
            out[doff] = this.pixels[so];
            out[doff + 1] = this.pixels[so + 1];
            out[doff + 2] = this.pixels[so + 2];
            out[doff + 3] = this.pixels[so + 3];
          }
        }
        return new MockImageData(out, w, h);
      },
      putImageData: (img: MockImageData, dx: number, dy: number) => {
        this.resizeIfNeeded();
        for (let row = 0; row < img.height; row++) {
          const ty = dy + row;
          if (ty < 0 || ty >= this.height) continue;
          for (let col = 0; col < img.width; col++) {
            const tx = dx + col;
            if (tx < 0 || tx >= this.width) continue;
            const so = (row * img.width + col) * 4;
            const doff = (ty * this.width + tx) * 4;
            this.pixels[doff] = img.data[so];
            this.pixels[doff + 1] = img.data[so + 1];
            this.pixels[doff + 2] = img.data[so + 2];
            this.pixels[doff + 3] = img.data[so + 3];
          }
        }
      },
      drawImage: (src: MockCanvas2D, ...args: number[]) => {
        this.resizeIfNeeded();
        src.resizeIfNeeded();
        let sx = 0;
        let sy = 0;
        let sw = src.width;
        let sh = src.height;
        let dx = 0;
        let dy = 0;
        let dw = src.width;
        let dh = src.height;
        if (args.length === 2) {
          [dx, dy] = args;
        } else if (args.length === 4) {
          [dx, dy, dw, dh] = args;
        } else if (args.length >= 8) {
          [sx, sy, sw, sh, dx, dy, dw, dh] = args;
        }
        const x0 = Math.max(0, Math.floor(dx));
        const y0 = Math.max(0, Math.floor(dy));
        const x1 = Math.min(this.width, Math.ceil(dx + dw));
        const y1 = Math.min(this.height, Math.ceil(dy + dh));
        for (let py = y0; py < y1; py++) {
          const uSrcY = Math.min(
            src.height - 1,
            Math.max(0, Math.floor(sy + ((py - dy) / Math.max(1, dh)) * sh))
          );
          for (let px = x0; px < x1; px++) {
            const uSrcX = Math.min(
              src.width - 1,
              Math.max(0, Math.floor(sx + ((px - dx) / Math.max(1, dw)) * sw))
            );
            const so = (uSrcY * src.width + uSrcX) * 4;
            const sa = (src.pixels[so + 3] / 255) * globalAlpha;
            this.blendPixel(
              px,
              py,
              src.pixels[so],
              src.pixels[so + 1],
              src.pixels[so + 2],
              sa,
              globalCompositeOperation
            );
          }
        }
      },
    };
    return ctx;
  }

  public getContext(): Record<string, unknown> {
    this.resizeIfNeeded();
    return this.ctxObj;
  }

  public toBlob(cb: (b: Blob | null) => void, mime = 'image/png') {
    // Emit valid minimal JPEG/PNG byte headers for PDF & backup tests
    if (mime === 'image/jpeg') {
      const jpegStub = new Uint8Array([
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9,
      ]);
      cb(new Blob([jpegStub], { type: 'image/jpeg' }));
      return;
    }
    const pngStub = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    cb(new Blob([pngStub], { type: mime }));
  }
}

function installCanvasDomShim() {
  (globalThis as unknown as Record<string, unknown>).ImageData = MockImageData;
  (globalThis as unknown as Record<string, unknown>).requestAnimationFrame = (fn: FrameRequestCallback) => {
    return setTimeout(() => fn(performance.now()), 0) as unknown as number;
  };
  (globalThis as unknown as Record<string, unknown>).cancelAnimationFrame = (id: number) => {
    clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
  };
  const urlObj = URL as unknown as Record<string, unknown>;
  urlObj.createObjectURL = () => 'blob:mock';
  urlObj.revokeObjectURL = () => {};
  (globalThis as unknown as Record<string, unknown>).document = {
    documentElement: { setAttribute: () => {}, lang: 'tr' },
    visibilityState: 'visible',
    addEventListener: () => {},
    removeEventListener: () => {},
    body: { appendChild: () => {}, removeChild: () => {} },
    createElement: (tag: string) => {
      if (tag === 'canvas') return new MockCanvas2D(300, 150);
      return { click: () => {}, style: {}, setAttribute: () => {} };
    },
  };
}

installCanvasDomShim();

const FULL_CORNERS: QuadCorners = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

describe('F1-03 10/10 Draw, Paper Scan, WebCodecs MP4, Share & PDF/ZIP Regression Gate', () => {
  beforeEach(() => {
    memIdb.clear();
    setActiveStorageScope('guest');
    registerCanvasFlusher(null);
  });

  it('1. paperWorker preserves 90x90 solid black fills (0% hollowing), faint 2px graphite, shadow steps & ink/blue crossings', () => {
    const W = 320;
    const H = 240;
    const rgba = new Uint8ClampedArray(W * H * 4);

    // Warm paper illumination with cast hand shadow on right third (x >= 210)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const inShadow = x >= 210;
        const base = inShadow ? 156 : 240;
        const p = (y * W + x) * 4;
        rgba[p] = base;
        rgba[p + 1] = base - 3;
        rgba[p + 2] = base - 8;
        rgba[p + 3] = 255;
      }
    }

    // 1A: 90x90 solid black torso block at (40..130, 50..140)
    for (let y = 50; y < 140; y++) {
      for (let x = 40; x < 130; x++) {
        const p = (y * W + x) * 4;
        rgba[p] = 18;
        rgba[p + 1] = 17;
        rgba[p + 2] = 16;
      }
    }

    // 1B: Faint 2px 2H/HB graphite line at y = 180..181, x = 40..150
    for (let y = 180; y < 182; y++) {
      for (let x = 40; x < 150; x++) {
        const p = (y * W + x) * 4;
        rgba[p] = 184;
        rgba[p + 1] = 181;
        rgba[p + 2] = 176;
      }
    }

    // 1C: Non-photo blue sketch line crossing black ink at x = 85, y = 20..165
    for (let y = 20; y < 165; y++) {
      for (let x = 84; x <= 86; x++) {
        const insideBlack = y >= 50 && y < 140;
        if (insideBlack) continue;
        const p = (y * W + x) * 4;
        rgba[p] = 75;
        rgba[p + 1] = 135;
        rgba[p + 2] = 232;
      }
    }

    const res = processPaperScan({
      width: W,
      height: H,
      rgba,
      corners: FULL_CORNERS,
      outWidth: W,
      outHeight: H,
      transparentBg: true,
      preserveColor: false,
      sensitivity: 62,
      inkStrength: 70,
      stripBluePencil: true,
      stripRedPencil: false,
    });

    // Center of 90x90 black block MUST stay solid dark ink (ZERO white donut hollowing!)
    let hollowedPixels = 0;
    for (let y = 65; y < 125; y++) {
      for (let x = 55; x < 115; x++) {
        const a = res.rgba[(y * W + x) * 4 + 3];
        if (a < 220) hollowedPixels++;
      }
    }
    const centerAlpha = res.rgba[(95 * W + 85) * 4 + 3];
    expect(centerAlpha).toBeGreaterThanOrEqual(245);
    expect(hollowedPixels).toBe(0);

    // Faint 2px graphite stroke preserved
    const pencilAlpha = res.rgba[(180 * W + 95) * 4 + 3];
    expect(pencilAlpha).toBeGreaterThanOrEqual(90);

    // Sharp cast shadow boundary at x = 210 produces ZERO false ink lines
    let falseShadowInk = 0;
    for (let y = 30; y < 210; y++) {
      for (let x = 206; x <= 214; x++) {
        if (res.rgba[(y * W + x) * 4 + 3] > 35) falseShadowInk++;
      }
    }
    expect(falseShadowInk).toBe(0);

    // Non-photo blue outside black block stripped cleanly while black block remains solid
    expect(res.rgba[(30 * W + 85) * 4 + 3]).toBeLessThanOrEqual(10);
  });

  it('2. detectPaperCorners locks onto A4 sheet on both light desks and glare-spotted dark desks + bilinear sliceGridCells', () => {
    const W = 240;
    const H = 180;
    const expected: QuadCorners = [
      { x: 0.15, y: 0.15 },
      { x: 0.85, y: 0.15 },
      { x: 0.85, y: 0.85 },
      { x: 0.15, y: 0.85 },
    ];

    // 2A: Light desk (RGB 212,206,195) with white A4 sheet (RGB 248,246,242)
    const lightDesk = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const inSheet = x >= W * 0.15 && x <= W * 0.85 && y >= H * 0.15 && y <= H * 0.85;
        const p = (y * W + x) * 4;
        lightDesk[p] = inSheet ? 248 : 212;
        lightDesk[p + 1] = inSheet ? 246 : 206;
        lightDesk[p + 2] = inSheet ? 242 : 195;
        lightDesk[p + 3] = 255;
      }
    }
    const cLight = detectPaperCorners({ width: W, height: H, rgba: lightDesk });
    for (let i = 0; i < 4; i++) {
      expect(Math.hypot(cLight[i].x - expected[i].x, cLight[i].y - expected[i].y)).toBeLessThan(0.035);
    }

    // 2B: Dark desk with bright 10x10 specular glare spot in top-left corner (4..14, 4..14)
    const glareDesk = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const inSheet = x >= W * 0.15 && x <= W * 0.85 && y >= H * 0.15 && y <= H * 0.85;
        const inGlare = x >= 4 && x < 14 && y >= 4 && y < 14;
        const v = inGlare ? 255 : inSheet ? 242 : 36;
        const p = (y * W + x) * 4;
        glareDesk[p] = v;
        glareDesk[p + 1] = v;
        glareDesk[p + 2] = v;
        glareDesk[p + 3] = 255;
      }
    }
    const cGlare = detectPaperCorners({ width: W, height: H, rgba: glareDesk });
    for (let i = 0; i < 4; i++) {
      expect(Math.hypot(cGlare[i].x - expected[i].x, cGlare[i].y - expected[i].y)).toBeLessThan(0.035);
    }

    // 2C: Premultiplied bilinear `sliceGridCells` produces smooth sub-pixel alpha without RGB dark fringes
    const gridW = 120;
    const gridH = 120;
    const gridRgba = new Uint8ClampedArray(gridW * gridH * 4);
    for (let i = 10; i < 50; i++) {
      const p = (i * gridW + i) * 4;
      gridRgba[p] = 220;
      gridRgba[p + 1] = 40;
      gridRgba[p + 2] = 30;
      gridRgba[p + 3] = 255;
    }
    const cells = sliceGridCells({
      width: gridW,
      height: gridH,
      rgba: gridRgba,
      cols: 2,
      rows: 2,
      outWidth: 100,
      outHeight: 100,
      autoCenter: false,
      transparentBg: true,
    });
    expect(cells).toHaveLength(4);
    // Semi-transparent interpolated edge pixels keep pure red hue (R > 180) instead of bleeding black (0,0,0)
    let semiCount = 0;
    for (let i = 0; i < 100 * 100; i++) {
      const a = cells[0][i * 4 + 3];
      if (a > 40 && a < 210) {
        semiCount++;
        expect(cells[0][i * 4]).toBeGreaterThan(170);
      }
    }
    expect(semiCount).toBeGreaterThan(10);
  });

  it('3. socketInpaint preserves 1x native stripe detail across arm+leg+neck sockets & drawInpaintedSocketBackingPass matches shader transform', () => {
    const W = 120;
    const H = 160;
    const rgba = new Uint8ClampedArray(W * H * 4);
    const partMap = new Int8Array(W * H).fill(-1);

    // Paint character with alternating horizontal shirt stripes (2px period -> would collapse under 4x4 block!)
    for (let y = 15; y < 145; y++) {
      for (let x = 25; x < 95; x++) {
        const p = (y * W + x) * 4;
        const isStripe = y % 2 === 0;
        rgba[p] = isStripe ? 210 : 50;
        rgba[p + 1] = isStripe ? 65 : 130;
        rgba[p + 2] = isStripe ? 55 : 200;
        rgba[p + 3] = 255;

        if (y < 42 && x >= 42 && x < 78) {
          partMap[y * W + x] = 0; // head/neck
        } else if (y >= 42 && y < 105 && x < 42) {
          partMap[y * W + x] = 2; // left arm
        } else if (y >= 42 && y < 105 && x >= 78) {
          partMap[y * W + x] = 3; // right arm
        } else if (y >= 105 && x >= 35 && x < 58) {
          partMap[y * W + x] = 4; // left leg
        } else if (y >= 105 && x >= 62 && x < 85) {
          partMap[y * W + x] = 5; // right leg
        } else if (y >= 42 && y < 105 && x >= 42 && x < 78) {
          partMap[y * W + x] = 1; // torso
        }
      }
    }

    const topoOp = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) {
      if (partMap[i] >= 0) topoOp[i] = 1;
    }
    const inp = inpaintBehindLimbSocketsRGBA(rgba, W, H, partMap, topoOp, W, H, 14);

    expect('inpaintedBackRgba' in (inp as unknown as Record<string, unknown>)).toBe(false);
    expect(inp.inpaintedPixels).toBeGreaterThan(80);
    expect(inp.armPixels).toBeGreaterThan(20);
    expect(inp.legPixels).toBeGreaterThan(10);
    expect(inp.neckPixels).toBeGreaterThan(10);
    expect(inp.socketOnlyRgba[(52 * W + 38) * 4 + 3]).toBeGreaterThan(0); // left arm socket
    expect(inp.socketOnlyRgba[(52 * W + 81) * 4 + 3]).toBeGreaterThan(0); // right arm socket
    expect(inp.socketOnlyRgba[(39 * W + 60) * 4 + 3]).toBeGreaterThan(0); // neck socket
    expect(inp.socketOnlyRgba[(108 * W + 46) * 4 + 3]).toBeGreaterThan(0); // hip/leg socket

    // Verify 1x native resolution (neighboring rows inside a 4x4 cell preserve distinct stripe colors!)
    const rowEvenR = inp.socketOnlyRgba[(52 * W + 40) * 4];
    const rowOddR = inp.socketOnlyRgba[(53 * W + 40) * 4];
    expect(Math.abs(rowEvenR - rowOddR)).toBeGreaterThan(40);

    // Verify exact affine alignment in `drawInpaintedSocketBackingPass` (`u_bounds.xy + applyBone`)
    let mat = [1, 0, 0, 1, 0, 0];
    let drawnArgs: number[] = [];
    const spyCtx = {
      save: () => {},
      restore: () => {},
      globalAlpha: 1,
      globalCompositeOperation: 'source-over',
      fillStyle: '#000',
      translate: (tx: number, ty: number) => {
        const [a, b, c, d, e, f] = mat;
        mat = [a, b, c, d, a * tx + c * ty + e, b * tx + d * ty + f];
      },
      transform: (a2: number, b2: number, c2: number, d2: number, e2: number, f2: number) => {
        const [a1, b1, c1, d1, e1, f1] = mat;
        mat = [
          a1 * a2 + c1 * b2,
          b1 * a2 + d1 * b2,
          a1 * c2 + c1 * d2,
          b1 * c2 + d1 * d2,
          a1 * e2 + c1 * f2 + e1,
          b1 * e2 + d1 * f2 + f1,
        ];
      },
      drawImage: (_img: unknown, dx: number, dy: number, dw: number, dh: number) => {
        drawnArgs = [dx, dy, dw, dh];
      },
    } as unknown as CanvasRenderingContext2D;

    const bounds = { x: 145, y: 62, w: W, h: H };
    const ang = 0.32;
    const cos = Math.cos(ang);
    const sin = Math.sin(ang);
    const restX = 60;
    const restY = 70;
    const worldX = 68;
    const worldY = 74;
    const chestBone = {
      m00: cos,
      m01: -sin,
      tx: worldX - (cos * restX - sin * restY),
      m10: sin,
      m11: cos,
      ty: worldY - (sin * restX + cos * restY),
      rotRad: ang,
    };
    const fakeMesh = {
      inpaintedDims: { w: W, h: H },
      inpaintedSocketOnlyRgba: inp.socketOnlyRgba,
    } as unknown as Parameters<typeof drawInpaintedSocketBackingPass>[1];

    const drew = drawInpaintedSocketBackingPass(spyCtx, fakeMesh, chestBone, bounds);
    expect(drew).toBe(true);
    expect(drawnArgs).toEqual([0, 0, W, H]);

    // Test arbitrary local vertex (lx, ly) = (38, 52):
    const lx = 38;
    const ly = 52;
    const canvasX = mat[0] * lx + mat[2] * ly + mat[4];
    const canvasY = mat[1] * lx + mat[3] * ly + mat[5];
    const shaderX = bounds.x + chestBone.m00 * lx + chestBone.m01 * ly + chestBone.tx;
    const shaderY = bounds.y + chestBone.m10 * lx + chestBone.m11 * ly + chestBone.ty;
    expect(Math.hypot(canvasX - shaderX, canvasY - shaderY)).toBeLessThan(1e-6);
  });

  it('4. WebCodecs H.264 selects Level 3.1 / 4.0 / 4.2 by macroblocks, resolves 9:16 & 1:1, and prioritizes WebCodecs across all 5 studios', () => {
    expect(selectH264CodecCandidates(1280, 720)[0]).toBe('avc1.64001f');
    expect(selectH264CodecCandidates(1920, 1080)[0]).toBe('avc1.640028');
    expect(selectH264CodecCandidates(1080, 1920)[0]).toBe('avc1.640028');
    expect(selectH264CodecCandidates(2560, 1440)[0]).toBe('avc1.64002a');

    expect(resolveExportDimensions(1280, 720, 1, '9:16')).toEqual({ width: 1080, height: 1920 });
    expect(resolveExportDimensions(1280, 720, 1, '1:1')).toEqual({ width: 1080, height: 1080 });
    expect(resolveExportDimensions(1280, 720, 0.5, '9:16')).toEqual({ width: 540, height: 960 });

    // Inverted priority checks (`!support.nativeMp4Mime && support.webCodecsMp4` or `chosen.ext !== 'mp4'`) MUST NEVER return!
    expect(exportEngineSrc).not.toContain('!support.nativeMp4Mime');
    expect(exportEngineSrc).toContain('if (support.webCodecsMp4)');
    expect(puppetStudioSrc).not.toContain("chosen.ext !== 'mp4'");
    expect(meshWarpSrc).not.toContain("chosen.ext !== 'mp4'");
    expect(instantAliveSrc).not.toContain("chosen.ext !== 'mp4'");
    expect(filmStudioSrc).not.toContain('if (!soundOn || !chosen');
  });

  it('5. renderAudioTrackOffline applies exact volume gain & chipmunk / giant / robot DSP voice effects', async () => {
    const sr = 48_000;
    const len = sr; // 1.0s 440Hz sine wave
    const ch = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      ch[i] = Math.sin((2 * Math.PI * 440 * i) / sr) * 0.8;
    }
    const fakeAudioBuf = {
      sampleRate: sr,
      length: len,
      duration: 1.0,
      numberOfChannels: 1,
      getChannelData: () => ch,
    } as unknown as AudioBuffer;

    const rms = (arr: Float32Array) => {
      let s = 0;
      for (let i = 0; i < arr.length; i++) s += arr[i] * arr[i];
      return Math.sqrt(s / Math.max(1, arr.length));
    };

    const full = await renderAudioTrackOffline({
      sourceBuffer: fakeAudioBuf,
      durationSec: 1.0,
      volume: 1.0,
      voiceEffect: 'natural',
    });
    const quarter = await renderAudioTrackOffline({
      sourceBuffer: fakeAudioBuf,
      durationSec: 1.0,
      volume: 0.25,
      voiceEffect: 'natural',
    });
    const ratio = rms(quarter.getChannelData(0)) / rms(full.getChannelData(0));
    expect(ratio).toBeGreaterThan(0.24);
    expect(ratio).toBeLessThan(0.26);

    const chipmunk = await renderAudioTrackOffline({
      sourceBuffer: fakeAudioBuf,
      durationSec: 1.0,
      volume: 1.0,
      voiceEffect: 'chipmunk',
      loop: false,
    });
    const giant = await renderAudioTrackOffline({
      sourceBuffer: fakeAudioBuf,
      durationSec: 1.5,
      volume: 1.0,
      voiceEffect: 'giant',
      loop: false,
    });
    // Chipmunk (1.44x) finishes 1.0s source in ~0.694s; Giant (0.74x) stretches 1.0s source to ~1.35s
    expect(chipmunk.duration).toBeLessThan(0.75);
    expect(giant.duration).toBeGreaterThan(1.3);

    const robot = await renderAudioTrackOffline({
      sourceBuffer: fakeAudioBuf,
      durationSec: 0.5,
      volume: 1.0,
      voiceEffect: 'robot',
    });
    // Robot 58Hz ring modulation alters instantaneous samples vs natural sine
    let diffEnergy = 0;
    const natData = full.getChannelData(0);
    const robData = robot.getChannelData(0);
    for (let i = 0; i < robData.length; i++) {
      diffEnergy += Math.abs(robData[i] - natData[i]);
    }
    expect(diffEnergy / robData.length).toBeGreaterThan(0.05);
  });

  it('6. StudioCanvasEngine eliminates semi-transparent marker knots, supports size=64 128x128 grain, continuous 0.50 pen pressure & stabilizer catch-up', async () => {
    expect(GRAIN_TILE_SIZE).toBe(128);
    const grain = getGraphiteGrainCanvas();
    expect(grain.width).toBe(128);
    expect(grain.height).toBe(128);

    const display = new MockCanvas2D(240, 160) as unknown as HTMLCanvasElement;
    const brush: BrushSettings = {
      tool: 'marker',
      shapeKind: 'line',
      color: '#1C1917',
      size: 12,
      opacity: 0.5, // activeStrokeOpacity = min(0.42, 0.5 * 0.42) = 0.21 -> ~54/255 alpha!
      stabilizer: 0,
      pressureEnabled: true,
      palmRejection: false,
      symmetryX: false,
      bucketReferenceInk: true,
      bucketGapClose: 2,
    };
    const onion: OnionSkinConfig = {
      enabled: false,
      prevCount: 1,
      nextCount: 1,
      opacity: 0.3,
      colored: true,
    };
    const guides: FieldGuideConfig = {
      enabled: false,
      thirds: false,
      safeFrame: false,
      centerCross: false,
      underlay: 'none',
      underlayOpacity: 0.3,
      vp1: { x: 0.5, y: 0.5 },
      vp2: { x: 0.8, y: 0.5 },
    };

    const frame1: CelFrame = {
      id: 'frm_1',
      hold: 1,
      layers: [
        {
          id: 'lyr_ink_1',
          name: 'Mürekkep',
          role: 'ink',
          visible: true,
          locked: false,
          opacity: 1,
          blendMode: 'source-over',
          blobKey: null,
        },
      ],
    };

    const eng = new StudioCanvasEngine(display, 240, 160, '#F7F3E9', brush, onion, guides);
    await eng.loadFrame(frame1, 'lyr_ink_1', [], [], 0);

    // Draw 14 overlapping slow segments back-and-forth in ONE stroke: max alpha MUST NOT stack!
    await eng.handlePointerDown(40, 80, 0.7, 1, 'pen');
    for (let i = 1; i <= 14; i++) {
      eng.handlePointerMove(40 + i * 6, 80, 0.7, 1);
    }
    eng.handlePointerUp(1);

    const lyrCanvas = eng.getLayerCanvas('lyr_ink_1') as unknown as MockCanvas2D;
    let maxAlpha = 0;
    for (let i = 3; i < lyrCanvas.pixels.length; i += 4) {
      if (lyrCanvas.pixels[i] > maxAlpha) maxAlpha = lyrCanvas.pixels[i];
    }
    const expectedSinglePassAlpha = Math.round(0.21 * 255); // 54
    expect(maxAlpha).toBeGreaterThanOrEqual(expectedSinglePassAlpha - 2);
    expect(maxAlpha).toBeLessThanOrEqual(expectedSinglePassAlpha + 2);

    // Size=64 pencil dab does NOT clip at 64px
    eng.clearActiveLayer();
    eng.setSettings({ ...brush, tool: 'pencil', size: 64, opacity: 1 }, onion, guides, '#F7F3E9', 1);
    await eng.handlePointerDown(120, 80, 0.95, 2, 'pen');
    eng.handlePointerUp(2);
    let minY = 160;
    let maxY = 0;
    for (let y = 0; y < 160; y++) {
      for (let x = 0; x < 240; x++) {
        if (lyrCanvas.pixels[(y * 240 + x) * 4 + 3] > 0) {
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    expect(maxY - minY).toBeGreaterThan(66);

    // Pen pressure = 0.50 continuity check (no jump at 0.50!)
    const priv = eng as unknown as {
      activePointerType: string;
      computeStrokeWidth: (p: number, v: number) => number;
    };
    eng.setSettings({ ...brush, tool: 'gpen', size: 10 }, onion, guides, '#F7F3E9', 1);
    priv.activePointerType = 'pen';
    const w49 = priv.computeStrokeWidth(0.49, 0);
    const w50 = priv.computeStrokeWidth(0.5, 0);
    const w51 = priv.computeStrokeWidth(0.51, 0);
    expect(Math.abs(w50 - w49)).toBeLessThan(0.25);
    expect(Math.abs(w51 - w50)).toBeLessThan(0.25);
    expect(w51).toBeGreaterThan(w50);
    expect(w50).toBeGreaterThan(w49);

    // Stabilizer tail catch-up reaches final pointer coordinate on pointerup
    eng.clearActiveLayer();
    eng.setSettings(
      { ...brush, tool: 'gpen', size: 6, opacity: 1, stabilizer: 0.82 },
      onion,
      guides,
      '#F7F3E9',
      1
    );
    await eng.handlePointerDown(30, 80, 0.8, 3, 'pen');
    eng.handlePointerMove(100, 80, 0.8, 3);
    eng.handlePointerMove(180, 80, 0.8, 3);
    eng.handlePointerUp(3);

    let maxPaintedX = 0;
    for (let y = 74; y <= 86; y++) {
      for (let x = 0; x < 240; x++) {
        if (lyrCanvas.pixels[(y * 240 + x) * 4 + 3] > 128 && x > maxPaintedX) {
          maxPaintedX = x;
        }
      }
    }
    expect(maxPaintedX).toBeGreaterThanOrEqual(178);

    // Also verify non-passive wheel listener & getCoalescedEvents wiring in DrawingStage.tsx
    expect(drawingStageSrc).toContain("addEventListener('wheel', onNativeWheel, { passive: false })");
    expect(drawingStageSrc).not.toContain('onWheel={');
    expect(drawingStageSrc).toContain('getCoalescedEvents');
  });

  it('7. preserves per-frame Undo/Redo across frame switches, binds activeLayerId on moveFrame & restores deleted frames via undoDeleteFrame', async () => {
    const display = new MockCanvas2D(160, 120) as unknown as HTMLCanvasElement;
    const brush: BrushSettings = {
      tool: 'gpen',
      shapeKind: 'line',
      color: '#1C1917',
      size: 8,
      opacity: 1,
      stabilizer: 0,
      pressureEnabled: false,
      palmRejection: false,
      symmetryX: false,
      bucketReferenceInk: true,
      bucketGapClose: 2,
    };
    const onion: OnionSkinConfig = { enabled: false, prevCount: 1, nextCount: 1, opacity: 0.3, colored: true };
    const guides: FieldGuideConfig = {
      enabled: false,
      thirds: false,
      safeFrame: false,
      centerCross: false,
      underlay: 'none',
      underlayOpacity: 0.3,
      vp1: { x: 0.5, y: 0.5 },
      vp2: { x: 0.8, y: 0.5 },
    };

    const f1: CelFrame = {
      id: 'frame_A',
      hold: 1,
      layers: [{ id: 'lyr_A', name: 'Ink', role: 'ink', visible: true, locked: false, opacity: 1, blendMode: 'source-over', blobKey: null }],
    };
    const f2: CelFrame = {
      id: 'frame_B',
      hold: 1,
      layers: [{ id: 'lyr_B', name: 'Ink', role: 'ink', visible: true, locked: false, opacity: 1, blendMode: 'source-over', blobKey: null }],
    };

    const eng = new StudioCanvasEngine(display, 160, 120, '#F7F3E9', brush, onion, guides);
    await eng.loadFrame(f1, 'lyr_A', [], [], 0);
    await eng.handlePointerDown(20, 60, 0.7, 1, 'mouse');
    eng.handlePointerMove(120, 60, 0.7, 1);
    eng.handlePointerUp(1);
    expect(eng.canUndo()).toBe(true);

    // Switch to Frame B (which has 0 strokes), then switch back to Frame A -> Undo MUST still be active!
    await eng.loadFrame(f2, 'lyr_B', [f1], [], 1);
    expect(eng.canUndo()).toBe(false);
    await eng.loadFrame(f1, 'lyr_A', [], [f2], 0);
    expect(eng.canUndo()).toBe(true);

    const undoneLayer = eng.undo();
    expect(undoneLayer).toBe('lyr_A');
    const cA = eng.getLayerCanvas('lyr_A') as unknown as MockCanvas2D;
    let remainingOpaque = 0;
    for (let i = 3; i < cA.pixels.length; i += 4) {
      if (cA.pixels[i] > 0) remainingOpaque++;
    }
    expect(remainingOpaque).toBe(0);
    expect(eng.canRedo()).toBe(true);

    // Store: moveFrame binds activeLayerId to moved destination frame + deleteFrame / undoDeleteFrame round-trip
    useStudioStore.setState({ projects: [], activeProjectId: null });
    const proj = useStudioStore.getState().createProject('Test Sahne', '16:9', 12);
    await useStudioStore.getState().addFrameAfterCurrent(false);
    await useStudioStore.getState().addFrameAfterCurrent(false);
    useStudioStore.getState().updateFrameNote(1, 'Önemli Ara Kare');
    useStudioStore.getState().selectFrame(0);

    // Move frame 2 -> 0 while frame 0 was active: activeLayerId must belong to new frames[0]!
    useStudioStore.getState().moveFrame(2, 0);
    const afterMove = useStudioStore.getState();
    const pMove = afterMove.projects.find((p) => p.id === proj.id)!;
    expect(pMove.frames[afterMove.activeFrameIndex].layers.some((l) => l.id === afterMove.activeLayerId)).toBe(true);

    // Delete frame with note 'Önemli Ara Kare' and restore it via undoDeleteFrame
    const noteIdx = pMove.frames.findIndex((f) => f.note === 'Önemli Ara Kare');
    const deletedId = pMove.frames[noteIdx].id;
    useStudioStore.getState().deleteFrame(noteIdx);
    expect(useStudioStore.getState().projects[0].frames).toHaveLength(2);
    expect(useStudioStore.getState().lastDeletedFrame?.frame.id).toBe(deletedId);

    useStudioStore.getState().undoDeleteFrame();
    const restoredProj = useStudioStore.getState().projects[0];
    expect(restoredProj.frames).toHaveLength(3);
    expect(restoredProj.frames[noteIdx].id).toBe(deletedId);
    expect(restoredProj.frames[noteIdx].note).toBe('Önemli Ara Kare');
  });

  it('8. converts opaque multiply paper scans to transparent ink-only alpha for Onion-Skin & transparent PNG export + seals 5px sketch gaps', () => {
    const src = new MockCanvas2D(40, 40);
    // Fill opaque cream paper RGB(246, 242, 234, 255)
    for (let i = 0; i < 40 * 40; i++) {
      src.pixels[i * 4] = 246;
      src.pixels[i * 4 + 1] = 242;
      src.pixels[i * 4 + 2] = 234;
      src.pixels[i * 4 + 3] = 255;
    }
    // Paint dark ink cross at center (20, 20)
    for (let x = 12; x <= 28; x++) {
      const o = (20 * 40 + x) * 4;
      src.pixels[o] = 18;
      src.pixels[o + 1] = 16;
      src.pixels[o + 2] = 15;
    }

    const clean = convertMultiplySourceToTransparentCanvas(
      src as unknown as HTMLCanvasElement,
      40,
      40
    ) as unknown as MockCanvas2D;
    // Empty paper corner (2, 2) MUST be transparent (alpha === 0)
    expect(clean.pixels[(2 * 40 + 2) * 4 + 3]).toBe(0);
    // Dark ink center (20, 20) MUST stay opaque (alpha >= 235)
    expect(clean.pixels[(20 * 40 + 20) * 4 + 3]).toBeGreaterThanOrEqual(235);

    // 4-stroke hollow head with 5px endpoint gap at top seals cleanly via R=3 morphological closing!
    const headW = 80;
    const headH = 80;
    const headRgba = new Uint8ClampedArray(headW * headH * 4);
    for (let deg = 12; deg < 360; deg += 2) {
      // 12° gap (~5.2px chord gap at r=25)
      const rad = (deg * Math.PI) / 180;
      const x = Math.round(40 + Math.cos(rad) * 25);
      const y = Math.round(40 + Math.sin(rad) * 25);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const o = ((y + dy) * headW + (x + dx)) * 4;
          headRgba[o] = 24;
          headRgba[o + 1] = 22;
          headRgba[o + 2] = 20;
          headRgba[o + 3] = 255;
        }
      }
    }
    const sealed = fillClosedContoursRGBA(headRgba, headW, headH, 0.9);
    expect(sealed.filledPixels).toBeGreaterThan(1200);
    expect(sealed.rgba[(40 * headW + 40) * 4 + 3]).toBe(255);
  });

  it('9. shareCodec v2 compresses 50 hero + 30 buddy strokes (< 1,800 chars, 0 dropped strokes) & decodes legacy v1 tokens', () => {
    const makeStrokes = (count: number, seedOffset: number): ShareStrokeRecord[] => {
      const colors = ['#1C1917', '#E54D2E', '#2563EB', '#D99B26'];
      const list: ShareStrokeRecord[] = [];
      for (let i = 0; i < count; i++) {
        const pts: { x: number; y: number }[] = [];
        const bx = 180 + ((i * 37 + seedOffset) % 720);
        const by = 110 + ((i * 53 + seedOffset) % 440);
        // Star/zigzag corners so RDP sharp-vertex fidelity is tested
        for (let p = 0; p < 14; p++) {
          pts.push({
            x: bx + p * 6,
            y: by + (p % 2 === 0 ? 0 : 18),
          });
        }
        list.push({ color: colors[i % colors.length], width: 4 + (i % 5), points: pts });
      }
      return list;
    };

    const hero = makeStrokes(50, 0);
    const buddy = makeStrokes(30, 100);
    const token = encodeSharedStage({
      strokes: hero,
      buddyStrokes: buddy,
      toy: 'dance',
      world: 'meadow',
      mood: 'joy',
      prop: 'cape',
      voiceFx: 'chipmunk',
    });

    expect(token.startsWith('z.')).toBe(true);
    expect(token.length).toBeLessThan(1800);

    const decoded = decodeSharedStage(`#inktrope=${token}`);
    expect(decoded).not.toBeNull();
    expect(decoded!.strokes).toHaveLength(50);
    expect(decoded!.buddyStrokes).toHaveLength(30);
    expect(decoded!.world).toBe('meadow');
    expect(decoded!.prop).toBe('cape');
    expect(decoded!.voiceFx).toBe('chipmunk');

    // Sharp zigzag peak at index 1 preserved within <= 1px
    expect(Math.abs(decoded!.strokes[0].points[1].y - hero[0].points[1].y)).toBeLessThanOrEqual(1);

    // Legacy v1 uncompressed JSON base64url compatibility
    const legacyJson = JSON.stringify({
      v: 1,
      t: 'film',
      w: 'rainy',
      m: 'cool',
      p: 'umbrella',
      f: 'giant',
      s: [['#1C1917', 6, [100, 120, 180, 220]]],
    });
    const legacyB64u = btoa(legacyJson)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
    const fromKagit = decodeSharedStage(`#kagit=${legacyB64u}`);
    const fromInktrope = decodeSharedStage(`#inktrope=${legacyB64u}`);
    expect(fromKagit?.strokes).toHaveLength(1);
    expect(fromKagit?.voiceFx).toBe('giant');
    expect(fromInktrope?.prop).toBe('umbrella');
  });

  it('10. Cloudflare Worker /api/share stores & retrieves short snapshots with nosniff and rejects >512KB or invalid payloads', async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const mockDb = {
      prepare(sql: string) {
        const q = sql.replace(/\s+/g, ' ').trim();
        const runWith = (params: unknown[]) => {
          if (q.startsWith('CREATE TABLE')) return { results: [] };
          if (q.startsWith('DELETE FROM shared_snapshots')) {
            const now = Number(params[0]);
            for (const [k, v] of rows.entries()) {
              if (Number(v.expires_at) < now) rows.delete(k);
            }
            return { results: [] };
          }
          if (q.startsWith('SELECT COUNT(*) as cnt FROM shared_snapshots')) {
            const [ipHash, since] = params;
            const cnt = [...rows.values()].filter(
              (r) => r.ip_hash === ipHash && Number(r.created_at) > Number(since)
            ).length;
            return { results: [{ cnt }] };
          }
          if (q.startsWith('INSERT INTO shared_snapshots')) {
            const [id, kind, payload_b64, mime_type, byte_size, ip_hash, created_at, expires_at] = params;
            rows.set(String(id), {
              id,
              kind,
              payload_b64,
              mime_type,
              byte_size,
              ip_hash,
              created_at,
              expires_at,
            });
            return { results: [] };
          }
          if (q.startsWith('SELECT id, kind, payload_b64')) {
            const hit = rows.get(String(params[0])) ?? null;
            return { results: hit ? [hit] : [] };
          }
          return { results: [] };
        };
        return {
          bind(...params: unknown[]) {
            return {
              run: async () => runWith(params),
              first: async () => runWith(params).results[0] ?? null,
            };
          },
          run: async () => runWith([]),
        };
      },
    };
    const env = {
      DB: mockDb,
      ASSETS: { fetch: async () => new Response('ok') },
    };

    // Valid POST /api/share
    const postRes = await worker.fetch(
      new Request('https://inktrope.com/api/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.10' },
        body: JSON.stringify({
          kind: 'project',
          payloadB64: 'eJyrVkrLz1eyUkpKLFKqBQAdegQ9',
          mimeType: 'application/x-inktrope-snapshot',
        }),
      }),
      env,
      {}
    );
    expect(postRes.status).toBe(201);
    expect(postRes.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const postJson = (await postRes.json()) as { ok: boolean; id: string };
    expect(postJson.ok).toBe(true);
    expect(postJson.id).toMatch(/^[A-Za-z0-9_-]{8,12}$/);

    // Valid GET /api/share/:id
    const getRes = await worker.fetch(
      new Request(`https://inktrope.com/api/share/${postJson.id}`),
      env,
      {}
    );
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const getJson = (await getRes.json()) as { payloadB64: string; kind: string };
    expect(getJson.kind).toBe('project');
    expect(getJson.payloadB64).toBe('eJyrVkrLz1eyUkpKLFKqBQAdegQ9');

    // Reject > 512 KB payload (413)
    const hugeRes = await worker.fetch(
      new Request('https://inktrope.com/api/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'project',
          payloadB64: 'A'.repeat(530_000),
          mimeType: 'application/x-inktrope-snapshot',
        }),
      }),
      env,
      {}
    );
    expect(hugeRes.status).toBe(413);

    // Reject XSS / invalid MIME or invalid kind (400)
    const badMimeRes = await worker.fetch(
      new Request('https://inktrope.com/api/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'project',
          payloadB64: 'eJyrVkrLz1eyUkpKLFKqBQAdegQ9',
          mimeType: 'text/html',
        }),
      }),
      env,
      {}
    );
    expect(badMimeRes.status).toBe(400);
  });

  it('11. flipbookPdf writes binary PDF 1.4 header, exact xref offsets, Turkish glyphs, truncated titles, frame.hold cards & flush right thumb-edge', async () => {
    // 7 unique 9:16 portrait frames, with Frame #1 held for 2 exposures -> 8 physical cards (#001..#008), 7 XObjects!
    const portraitCanvases = Array.from(
      { length: 7 },
      () => new MockCanvas2D(360, 640) as unknown as HTMLCanvasElement
    );
    const longTurkishTitle =
      'Yeni Çizgi Film — Şapkalı Baron ve Yağmurlu İstanbul Gecesi Çok Uzun Proje Başlığı Testi ğĞşŞİıöÖüÜçÇ';

    const pdfBlob = await generateFlipbookPdfBlob(portraitCanvases, longTurkishTitle, 12, {
      holds: [2, 1, 1, 1, 1, 1, 1],
      locale: 'tr',
    });
    const bytes = new Uint8Array(await pdfBlob.arrayBuffer());

    // Binary PDF 1.4 header check: `%PDF-1.4\n%\xE2\xE3\xCF\xD3\n`
    expect(Array.from(bytes.slice(10, 14))).toEqual([0xe2, 0xe3, 0xcf, 0xd3]);

    const latin1 = new TextDecoder('latin1').decode(bytes);

    // Type1 Helvetica Turkish `/Differences` vector encoding present
    expect(latin1).toContain(
      '/Differences [ 208 /Gbreve 221 /Idotaccent 222 /Scedilla 240 /gbreve 253 /dotlessi 254 /scedilla ]'
    );
    const encodedTr = encodePdfTextLiteral('Şapkalı ğĞİı');
    expect(encodedTr).toContain('\\336'); // Ş (222)
    expect(encodedTr).toContain('\\375'); // ı (253)
    expect(encodedTr).toContain('\\360'); // ğ (240)
    expect(encodedTr).toContain('\\320'); // Ğ (208)
    expect(encodedTr).toContain('\\335'); // İ (221)

    // Header truncation guarantees 0pt overlap with right cut instruction
    const trunc = truncatePdfTextToWidth(longTurkishTitle, 9.5, 290);
    expect(measureHelveticaWidthPt(trunc, 9.5)).toBeLessThanOrEqual(290);

    // 8 physical exposure cards (#001..#008) from 7 unique JPEG XObjects (/Im0../Im6, no /Im7!)
    expect(latin1).toContain('(#001)');
    expect(latin1).toContain('(#008)');
    expect((latin1.match(/\/Im0 Do/g) ?? []).length).toBe(2); // Frame #1 held for 2 cards!
    expect(latin1).toContain('/Im6 Do');
    expect(latin1).not.toContain('/Im7 ');

    // Every xref offset matches exact byte position of `<id> 0 obj\n`
    const xrefIdx = latin1.indexOf('xref\n');
    expect(xrefIdx).toBeGreaterThan(0);
    const xrefLines = latin1
      .slice(xrefIdx)
      .split('\n')
      .filter((l: string) => /^\d{10} 00000 n /.test(l));
    expect(xrefLines.length).toBeGreaterThan(7);
    xrefLines.forEach((line: string, idx: number) => {
      const offset = Number(line.slice(0, 10));
      const marker = `${idx + 1} 0 obj\n`;
      const sliceStr = latin1.slice(offset, offset + marker.length);
      expect(sliceStr).toBe(marker);
    });

    // Right thumb-edge flush check on 9:16 portrait card #1:
    // MarginX=24, CardW=267.64, artPad=5 => right card art edge = 24 + 267.64 - 5 = 286.64 (0.00pt dead strip!)
    const cmMatch = latin1.match(/q\n([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm\n\/Im0 Do/);
    expect(cmMatch).not.toBeNull();
    const drawW = Number(cmMatch![1]);
    const drawX = Number(cmMatch![3]);
    expect(Math.abs(drawX + drawW - (24 + 267.64 - 5))).toBeLessThan(0.05);
  });

  it('12. zipBuilder enforces CRC-32 + Deflate (method=8) + DOS date & preserves multi-actor filmGraph.actors[0..3] without overwriting IDB keys', async () => {
    const { dosDate } = encodeDosDateTime(new Date('2026-05-15T10:20:30Z'));
    expect(dosDate).not.toBe(0);

    const samplePayload = new TextEncoder().encode('INKTROPE CRC & Deflate Test');
    const validZip = new Uint8Array(
      await buildZipBlob([{ name: 'hello.txt', data: samplePayload }]).arrayBuffer()
    );
    expect(new TextDecoder().decode(parseZipBytes(validZip).get('hello.txt'))).toBe(
      'INKTROPE CRC & Deflate Test'
    );

    // Flip 1 bit in payload -> mandatory IEEE CRC-32 check MUST throw!
    const corrupted = new Uint8Array(validZip);
    corrupted[30 + 'hello.txt'.length + 4] ^= 0xff;
    expect(() => parseZipBytes(corrupted)).toThrow(/CRC-32/i);

    // MIME sanitizer strips SVG/HTML XSS vectors
    expect(SAFE_IMPORT_MIMES.has('image/svg+xml')).toBe(false);
    expect(sanitizeImportMime('text/html', 'image/png')).toBe('image/png');
    expect(sanitizeImportMime('image/svg+xml', 'image/png')).toBe('image/png');
    expect(sanitizeImportMime('audio/mpeg', 'audio/webm')).toBe('audio/mpeg');

    // Multi-actor (4 cast members) GC + .inktrope.zip (including OS method=8 Deflate!) + .kagit25d non-overwriting round-trip
    const existingProtectedKey = await saveBlob(
      new Blob([new Uint8Array([9, 9, 9, 9])], { type: 'image/png' }),
      'shared_collision_key'
    );
    expect(existingProtectedKey).toBe('shared_collision_key');

    const actorKeys: string[] = [];
    const actors: FilmActor[] = [];
    for (let i = 0; i < 4; i++) {
      const srcKey = await saveBlob(new Blob([new Uint8Array([10 + i, 20, 30])], { type: 'image/png' }));
      const partKey = await saveBlob(new Blob([new Uint8Array([40 + i, 50, 60])], { type: 'image/png' }));
      const depthKey = await saveBlob(new Blob([new Uint8Array([70 + i, 80, 90])], { type: 'image/png' }));
      actorKeys.push(srcKey, partKey, depthKey);
      actors.push({
        id: `actor_${i}`,
        name: `Oyuncu ${i + 1}`,
        sourceBlobKey: srcKey,
        sourceW: 256,
        sourceH: 256,
        styleDna: {
          palette: ['#1C1917'],
          inkColor: '#1C1917',
          accentColor: '#E54D2E',
          warmTemp: 0,
          contrast: 0.8,
          lineWeightPx: 3,
          styleTag: 'ink-watercolor',
        },
        rigidHeadEndY: 0.35,
        secondaryPhysics: false,
        decomposed: {
          parts: [
            {
              id: `pt_${i}`,
              role: 'torso',
              label: 'Gövde',
              blobKey: partKey,
              x: 0,
              y: 0,
              w: 100,
              h: 100,
              pivotX: 50,
              pivotY: 50,
              zIndex: 1,
              rigidity: 0.8,
            },
          ],
          depthBlobKey: depthKey,
          normalBlobKey: null,
          sourceEngine: 'local-cv',
          createdAt: new Date().toISOString(),
        },
      });
    }

    const filmGraph: FilmProjectGraph = {
      version: '2.5d-v1',
      prompt: 'Test kadrosu',
      actor: actors[0],
      actors,
      world: {
        setId: 'rainy-alley',
        customBgBlobKey: null,
        horizonY: 0.56,
        weather: 'rain',
        weatherIntensity: 0.5,
        windStrength: 0.2,
        klausLighting: true,
        cinemaGrade: true,
        lightAngleDeg: 25,
        harmonizeToStyleDna: true,
      },
      shots: [],
      foleyEnabled: true,
      musicBedEnabled: true,
    };

    const project: StudioProject = {
      id: 'prj_multi_cast',
      name: 'Dört Oyunculu Film',
      aspect: '16:9',
      width: 1280,
      height: 720,
      fps: 12,
      paperColor: '#F7F3E9',
      paperGrain: 0.25,
      frames: [
        {
          id: 'f0',
          hold: 1,
          layers: [
            {
              id: 'l0',
              name: 'Ink',
              role: 'ink',
              visible: true,
              locked: false,
              opacity: 1,
              blendMode: 'source-over',
              blobKey: null,
            },
          ],
        },
      ],
      rigs: [],
      filmGraph,
      audio: null,
      references: [],
      palette: ['#1C1917'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // GC sweep MUST retain 100% of actors[0..3] blobs!
    const refs = collectAllReferencedBlobKeys([project]);
    for (const k of actorKeys) {
      expect(refs.has(k)).toBe(true);
    }
    await saveAllProjects([project]);
    // Keep a second project referencing `shared_collision_key` so GC keeps it too
    const protectorProj: StudioProject = { ...project, id: 'prj_prot', backgroundBlobKey: 'shared_collision_key', filmGraph: null };
    await sweepUnreferencedBlobs([project, protectorProj]);
    for (const k of actorKeys) {
      expect(await loadBlob(k)).not.toBeNull();
    }

    // Export .inktrope.zip, recompress entries with Node `zlib.deflateRawSync` (method = 8!), and re-import!
    const exportedBackup = await exportPortableBackupZip(project);
    const storeMap = parseZipBytes(new Uint8Array(await exportedBackup.blob.arrayBuffer()));

    const zlibSpec = `node:${'zlib'}`;
    const zlib = (await import(/* @vite-ignore */ zlibSpec)) as {
      deflateRawSync: (buf: Uint8Array) => Uint8Array;
    };
    // Build a genuine method=8 Deflate ZIP buffer to simulate macOS Finder / Windows Explorer re-zipping
    function buildDeflateMethod8Zip(entries: Map<string, Uint8Array>): Uint8Array {
      const localChunks: Uint8Array[] = [];
      const centralChunks: Uint8Array[] = [];
      let localOffset = 0;
      for (const [name, raw] of entries.entries()) {
        const nameBytes = new TextEncoder().encode(name);
        const deflated = new Uint8Array(zlib.deflateRawSync(raw));
        const entryCrc = crc32(raw);

        const lh = new Uint8Array(30 + nameBytes.length);
        const ldv = new DataView(lh.buffer);
        ldv.setUint32(0, 0x04034b50, true);
        ldv.setUint16(4, 20, true);
        ldv.setUint16(8, 8, true); // method = 8 (Deflate!)
        ldv.setUint32(14, entryCrc, true);
        ldv.setUint32(18, deflated.length, true);
        ldv.setUint32(22, raw.length, true);
        ldv.setUint16(26, nameBytes.length, true);
        lh.set(nameBytes, 30);
        localChunks.push(lh, deflated);

        const ch = new Uint8Array(46 + nameBytes.length);
        const cdv = new DataView(ch.buffer);
        cdv.setUint32(0, 0x02014b50, true);
        cdv.setUint16(4, 20, true);
        cdv.setUint16(6, 20, true);
        cdv.setUint16(10, 8, true); // method = 8 (Deflate!)
        cdv.setUint32(16, entryCrc, true);
        cdv.setUint32(20, deflated.length, true);
        cdv.setUint32(24, raw.length, true);
        cdv.setUint16(28, nameBytes.length, true);
        cdv.setUint32(42, localOffset, true);
        ch.set(nameBytes, 46);
        centralChunks.push(ch);

        localOffset += lh.length + deflated.length;
      }
      const centralSize = centralChunks.reduce((s, c) => s + c.length, 0);
      const eocd = new Uint8Array(22);
      const edv = new DataView(eocd.buffer);
      edv.setUint32(0, 0x06054b50, true);
      edv.setUint16(8, entries.size, true);
      edv.setUint16(10, entries.size, true);
      edv.setUint32(12, centralSize, true);
      edv.setUint32(16, localOffset, true);

      const total = localOffset + centralSize + 22;
      const out = new Uint8Array(total);
      let pos = 0;
      for (const c of [...localChunks, ...centralChunks, eocd]) {
        out.set(c, pos);
        pos += c.length;
      }
      return out;
    }

    const deflatedZipBytes = buildDeflateMethod8Zip(storeMap);
    const deflatedCopy = new Uint8Array(deflatedZipBytes.byteLength);
    deflatedCopy.set(deflatedZipBytes);
    const deflatedFile = Object.assign(
      new Blob([deflatedCopy], { type: 'application/zip' }),
      { name: 'eski_yedek.kagit.zip' }
    ) as unknown as File;
    const restoredProj = await importPortableBackupZip(deflatedFile, 'tr');
    expect(restoredProj.filmGraph?.actors).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
      const ra = restoredProj.filmGraph!.actors![i];
      expect(ra.sourceBlobKey).toBeTruthy();
      expect(await loadBlob(ra.sourceBlobKey!)).not.toBeNull();
      expect(await loadBlob(ra.decomposed!.parts[0].blobKey)).not.toBeNull();
      expect(await loadBlob(ra.decomposed!.depthBlobKey!)).not.toBeNull();
    }

    // Craft a .kagit25d archive containing `blobs/shared_collision_key.png` with attacker bytes [7,7,7,7]:
    // `importKagit25dPackage` MUST mint a fresh key and NEVER overwrite local `shared_collision_key` ([9,9,9,9])!
    const collisionGraph: FilmProjectGraph = {
      ...filmGraph,
      actor: { ...actors[0], sourceBlobKey: 'shared_collision_key', decomposed: null },
      actors: [
        { ...actors[0], sourceBlobKey: 'shared_collision_key', decomposed: null },
        actors[1],
        actors[2],
      ],
    };
    await exportKagit25dPackage(filmGraph, 'multi_actor_pkg');
    const craftedPkgBlob = buildZipBlob([
      {
        name: 'manifest.json',
        data: new TextEncoder().encode(
          JSON.stringify({ format: 'kagit25d', version: '1.2', graph: collisionGraph })
        ),
      },
      { name: 'blobs/shared_collision_key.png', data: new Uint8Array([7, 7, 7, 7]) },
      {
        name: `blobs/${actors[1].sourceBlobKey}.png`,
        data: new Uint8Array([11, 20, 30]),
      },
      {
        name: `blobs/${actors[2].sourceBlobKey}.png`,
        data: new Uint8Array([12, 20, 30]),
      },
    ]);
    const pkgFile = Object.assign(
      new Blob([await craftedPkgBlob.arrayBuffer()], { type: 'application/zip' }),
      { name: 'scene.kagit25d' }
    ) as unknown as File;
    const importedGraph = await importKagit25dPackage(pkgFile, 'en');

    expect(importedGraph.actor.sourceBlobKey).not.toBe('shared_collision_key');
    expect(importedGraph.actors).toHaveLength(3);
    expect(importedGraph.actors![1].sourceBlobKey).toBeTruthy();
    expect(importedGraph.actors![2].sourceBlobKey).toBeTruthy();

    // Original local `shared_collision_key` MUST still hold [9, 9, 9, 9]!
    const originalProtected = await loadBlob('shared_collision_key');
    expect(Array.from(new Uint8Array(await originalProtected!.arrayBuffer()))).toEqual([9, 9, 9, 9]);
  });
});
