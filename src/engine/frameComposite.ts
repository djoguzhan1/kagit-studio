import type { CelFrame, StudioProject, StudioScene } from '../types/studio';
import { getBlobBitmap } from './db';
import { renderPaperSurface } from './brushTextures';
import { applySceneAtmosphere, evaluateCameraAtFrame } from './cameraEngine';

/**
 * Converts an opaque `multiply`-mode scanned paper layer into clean transparent-paper ink RGBA
 * (`alpha = originalAlpha * clamp01((paperWhite - lum) / range)`) so both Onion-Skin silhouettes
 * AND `transparentBg: true` PNG/Sprite exports never leave a solid white/opaque paper box!
 */
export function convertMultiplySourceToTransparentCanvas(
  source: CanvasImageSource,
  w: number,
  h: number
): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(source, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;

  // Quick check: if corners are already transparent, preserve as-is!
  const cornerAlpha =
    d[3] +
    d[(w - 1) * 4 + 3] +
    d[((h - 1) * w) * 4 + 3] +
    d[((h - 1) * w + (w - 1)) * 4 + 3];
  if (cornerAlpha < 64) {
    return c;
  }

  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a === 0) continue;
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const sat = Math.max(r, g, b) - Math.min(r, g, b);
    // Pure ivory/white paper (~236..255, low chroma) maps cleanly to alpha = 0!
    const inkDensity = Math.max((242 - lum) / 210, sat > 28 ? (sat - 20) / 160 : 0);
    if (inkDensity <= 0.02) {
      d[i + 3] = 0;
    } else {
      const outA = Math.min(1, inkDensity * 1.18);
      d[i + 3] = Math.round(a * outA);
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/**
 * Pure single-frame compositor supporting:
 * - Physical Paper Surface (Bristol / Grid / Lined / Kraft / ACME 12-Field)
 * - Fixed Scene Background Plane + Parallax depth
 * - 2D Cinematic Camera Transform (Zoom / Pan / Tilt) + 4-Frame Impact Shake
 * - Scene Atmosphere Lighting
 * - Clean `multiply -> alpha` keying when `transparentBg: true`!
 * - Optional target canvas framing (`9:16` Reels / `1:1` Square letterbox-pillarbox on paper surface!)
 */
export async function renderFrameComposite(
  project: StudioProject,
  frame: CelFrame,
  options?: {
    width?: number;
    height?: number;
    hideRoughBlue?: boolean;
    transparentBg?: boolean;
    scene?: StudioScene;
    frameIndexInScene?: number;
  }
): Promise<HTMLCanvasElement> {
  const outW = options?.width ?? project.width;
  const outH = options?.height ?? project.height;
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d')!;

  const sc = options?.scene;
  const camKeyframes = sc?.cameraKeyframes ?? project.cameraKeyframes;
  const framesList = sc?.frames ?? project.frames;
  const fIdx =
    options?.frameIndexInScene ?? Math.max(0, framesList.findIndex((f) => f.id === frame.id));
  const bgKey = sc?.backgroundBlobKey ?? project.backgroundBlobKey ?? null;
  const parallax = sc?.backgroundParallax ?? project.backgroundParallax ?? 0.35;
  const atmosphere = sc?.atmosphere ?? project.atmosphere ?? 'none';

  if (!options?.transparentBg) {
    renderPaperSurface(
      ctx,
      outW,
      outH,
      project.paperColor || '#F7F3E9',
      project.paperStyle ?? 'bristol',
      1
    );
  }

  // Aspect-preserving inner stage box (so 16:9 exported into 9:16 Reels or 1:1 Square never stretches!)
  const projAspect = project.width / Math.max(1, project.height);
  const outAspect = outW / Math.max(1, outH);
  let w = outW;
  let h = outH;
  let offX = 0;
  let offY = 0;
  if (Math.abs(projAspect - outAspect) > 0.02) {
    const fit = Math.min(outW / project.width, outH / project.height);
    w = Math.round(project.width * fit);
    h = Math.round(project.height * fit);
    offX = Math.round((outW - w) / 2);
    offY = Math.round((outH - h) / 2);
  }

  const cam = evaluateCameraAtFrame(camKeyframes, framesList, fIdx, w, h);

  ctx.save();
  if (offX !== 0 || offY !== 0) {
    ctx.beginPath();
    ctx.rect(offX, offY, w, h);
    ctx.clip();
    ctx.translate(offX, offY);
  }

  if (!options?.transparentBg && bgKey) {
    const bgBmp = await getBlobBitmap(bgKey);
    if (bgBmp) {
      ctx.save();
      ctx.translate(w / 2 + cam.shakeX * parallax, h / 2 + cam.shakeY * parallax);
      const bgZoom = 1 + (cam.zoom - 1) * parallax;
      ctx.scale(bgZoom, bgZoom);
      ctx.rotate(((cam.tiltDeg * parallax) * Math.PI) / 180);
      ctx.translate(-w / 2 - cam.panX * w * parallax, -h / 2 - cam.panY * h * parallax);
      ctx.drawImage(bgBmp, 0, 0, w, h);
      ctx.restore();
    }
  }

  ctx.save();
  ctx.translate(w / 2 + cam.shakeX, h / 2 + cam.shakeY);
  ctx.scale(cam.zoom, cam.zoom);
  ctx.rotate((cam.tiltDeg * Math.PI) / 180);
  ctx.translate(-w / 2 - cam.panX * w, -h / 2 - cam.panY * h);

  for (const layer of frame.layers) {
    if (!layer.visible || !layer.blobKey) continue;
    if (options?.hideRoughBlue && layer.role === 'rough') continue;
    const bmp = await getBlobBitmap(layer.blobKey);
    if (!bmp) continue;
    ctx.save();
    ctx.globalAlpha = layer.opacity;
    if (options?.transparentBg && layer.blendMode === 'multiply') {
      const keyed = convertMultiplySourceToTransparentCanvas(bmp, w, h);
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(keyed, 0, 0, w, h);
    } else {
      ctx.globalCompositeOperation =
        layer.blendMode === 'multiply' ? 'multiply' : 'source-over';
      ctx.drawImage(bmp, 0, 0, w, h);
    }
    ctx.restore();
  }
  ctx.restore();
  ctx.restore();

  if (!options?.transparentBg) {
    applySceneAtmosphere(ctx, outW, outH, atmosphere);
  }

  return canvas;
}
