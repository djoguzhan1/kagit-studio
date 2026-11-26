import type { PaperStyleId } from '../types/studio';

let graphiteMaskCache: HTMLCanvasElement | null = null;
let screentoneCache: Map<string, CanvasPattern | null> = new Map();

/** Procedural 64x64 paper-tooth alpha mask so 2B Graphite Pencil genuinely catches paper grain! */
export function getGraphiteGrainCanvas(): HTMLCanvasElement {
  if (graphiteMaskCache) return graphiteMaskCache;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(64, 64);
  const d = img.data;
  let seed = 1337;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  for (let i = 0; i < 64 * 64; i++) {
    const n = rand();
    // Paper tooth peaks catch dark graphite; valleys stay lightly untouched
    const alpha = n > 0.38 ? Math.round((n - 0.35) * 320) : 0;
    const p = i * 4;
    d[p] = 255;
    d[p + 1] = 255;
    d[p + 2] = 255;
    d[p + 3] = Math.min(255, alpha);
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
    // Classic red school notebook vertical margin rule
    ctx.strokeStyle = 'rgba(229, 77, 46, 0.28)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(width * 0.1 + 0.5, 0);
    ctx.lineTo(width * 0.1 + 0.5, height);
    ctx.stroke();
    ctx.restore();
  } else if (paperStyle === 'acme12') {
    // Classic Disney/Studio 12-Field Animation Graticule Chart
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
    // Bold center axes & 10-field TV safe box
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
    // Warm subtle fiber specks for kraft drafting board
    ctx.save();
    ctx.fillStyle = 'rgba(84, 58, 34, 0.08)';
    for (let i = 0; i < 60; i++) {
      const x = ((i * 197) % width);
      const y = ((i * 313) % height);
      ctx.fillRect(x, y, 4, 1.5);
    }
    ctx.restore();
  }

  if (lightboxDim < 0.99) {
    ctx.fillStyle = `rgba(24, 20, 16, ${(1 - lightboxDim) * 0.42})`;
    ctx.fillRect(0, 0, width, height);
  }
}
