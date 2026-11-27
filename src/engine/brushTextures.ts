import type { PaperStyleId } from '../types/studio';

export const GRAIN_TILE_SIZE = 128;

let graphiteMaskCache: HTMLCanvasElement | null = null;
const screentoneCache: Map<string, CanvasPattern | null> = new Map();

function hash2d(ix: number, iy: number, period: number): number {
  const wx = ((ix % period) + period) % period;
  const wy = ((iy % period) + period) % period;
  let h = (wx * 374761393 + wy * 668265263) ^ 0x5bf03635;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function seamlessValueNoise(x: number, y: number, cellSize: number, tileSize: number): number {
  const period = Math.max(2, Math.round(tileSize / cellSize));
  const gx = (x / tileSize) * period;
  const gy = (y / tileSize) * period;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);

  const n00 = hash2d(x0, y0, period);
  const n10 = hash2d(x0 + 1, y0, period);
  const n01 = hash2d(x0, y0 + 1, period);
  const n11 = hash2d(x0 + 1, y0 + 1, period);
  const nx0 = n00 + (n10 - n00) * u;
  const nx1 = n01 + (n11 - n01) * u;
  return nx0 + (nx1 - nx0) * v;
}

/**
 * Seamless toroidal 128x128 multi-scale cold-press cotton paper tooth mask
 * so 2B Graphite & Non-Photo Blue pencils catch authentic paper fibers without visible tiling or clipping!
 */
export function getGraphiteGrainCanvas(): HTMLCanvasElement {
  if (graphiteMaskCache) return graphiteMaskCache;
  const size = GRAIN_TILE_SIZE;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const d = img.data;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const coarse = seamlessValueNoise(x, y, 6, size);
      const medium = seamlessValueNoise(x + 37, y + 19, 3, size);
      const fine = hash2d(x + 11, y + 73, size);
      const tooth = coarse * 0.44 + medium * 0.34 + fine * 0.22;
      // Peaks of cotton fibers catch graphite; valleys stay lightly untouched
      const alpha = tooth > 0.35 ? Math.round(Math.min(255, (tooth - 0.32) * 380)) : 0;
      const p = (y * size + x) * 4;
      d[p] = 255;
      d[p + 1] = 255;
      d[p + 2] = 255;
      d[p + 3] = alpha;
    }
  }
  ctx.putImageData(img, 0, 0);
  graphiteMaskCache = c;
  return c;
}

/** Screen-locked Manga Halftone Screentone pattern in the active ink color */
export function getScreentonePattern(
  ctx: CanvasRenderingContext2D,
  color: string
): CanvasPattern | null {
  const key = color.toLowerCase();
  if (screentoneCache.has(key)) return screentoneCache.get(key) ?? null;

  const tile = document.createElement('canvas');
  tile.width = 10;
  tile.height = 10;
  const tctx = tile.getContext('2d')!;
  tctx.fillStyle = color;
  tctx.beginPath();
  tctx.arc(2.5, 2.5, 1.75, 0, Math.PI * 2);
  tctx.arc(7.5, 7.5, 1.75, 0, Math.PI * 2);
  tctx.fill();

  const pattern = ctx.createPattern(tile, 'repeat');
  if (screentoneCache.size > 24) screentoneCache.clear();
  screentoneCache.set(key, pattern);
  return pattern;
}

/**
 * Draws authentic physical animation paper surfaces (Bristol, Grid, Lined, Kraft, ACME 12-Field)
 * directly onto the canvas background before cel layers.
 */
export function renderPaperSurface(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  paperColor: string,
  paperStyle: PaperStyleId = 'bristol',
  lightboxDim = 1
): void {
  const baseColor = paperStyle === 'kraft' ? '#D9C29C' : paperColor;
  ctx.fillStyle = baseColor;
  ctx.fillRect(0, 0, width, height);

  if (paperStyle === 'grid') {
    ctx.save();
    ctx.strokeStyle = 'rgba(59, 130, 246, 0.14)';
    ctx.lineWidth = 1;
    const step = 32;
    ctx.beginPath();
    for (let x = step; x < width; x += step) {
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, height);
    }
    for (let y = step; y < height; y += step) {
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(width, y + 0.5);
    }
    ctx.stroke();
    ctx.restore();
  } else if (paperStyle === 'lined') {
    ctx.save();
    ctx.strokeStyle = 'rgba(59, 130, 246, 0.16)';
    ctx.lineWidth = 1;
    const step = 38;
    ctx.beginPath();
    for (let y = step * 2; y < height; y += step) {
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(width, y + 0.5);
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(229, 77, 46, 0.28)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(width * 0.1 + 0.5, 0);
    ctx.lineTo(width * 0.1 + 0.5, height);
    ctx.stroke();
    ctx.restore();
  } else if (paperStyle === 'acme12') {
    ctx.save();
    const cx = width / 2;
    const cy = height / 2;
    ctx.strokeStyle = 'rgba(37, 99, 235, 0.17)';
    ctx.lineWidth = 1;
    const cols = 12;
    const rows = 12;
    const stepX = width / cols;
    const stepY = height / rows;
    ctx.beginPath();
    for (let c = 1; c < cols; c++) {
      ctx.moveTo(c * stepX, 0);
      ctx.lineTo(c * stepX, height);
    }
    for (let r = 1; r < rows; r++) {
      ctx.moveTo(0, r * stepY);
      ctx.lineTo(width, r * stepY);
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(229, 77, 46, 0.24)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, height);
    ctx.moveTo(0, cy);
    ctx.lineTo(width, cy);
    ctx.stroke();
    ctx.strokeRect(stepX, stepY, width - stepX * 2, height - stepY * 2);
    ctx.restore();
  } else if (paperStyle === 'kraft') {
    ctx.save();
    ctx.fillStyle = 'rgba(84, 58, 34, 0.08)';
    for (let i = 0; i < 60; i++) {
      const x = (i * 197) % width;
      const y = (i * 313) % height;
      ctx.fillRect(x, y, 4, 1.5);
    }
    ctx.restore();
  }

  if (lightboxDim < 0.99) {
    ctx.fillStyle = `rgba(24, 20, 16, ${(1 - lightboxDim) * 0.42})`;
    ctx.fillRect(0, 0, width, height);
  }
}
