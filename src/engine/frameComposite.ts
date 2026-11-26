import type { CelFrame, StudioProject, StudioScene } from '../types/studio';
import { getBlobBitmap } from './db';
import { renderPaperSurface } from './brushTextures';
import { applySceneAtmosphere, evaluateCameraAtFrame } from './cameraEngine';

/**
 * Pure single-frame compositor supporting:
 * - Physical Paper Surface (Bristol / Grid / Lined / Kraft / ACME 12-Field)
 * - Fixed Scene Background Plane + Parallax depth
 * - 2D Cinematic Camera Transform (Zoom / Pan / Tilt) + 4-Frame Impact Shake
 * - Scene Atmosphere Lighting
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
  const w = options?.width ?? project.width;
  const h = options?.height ?? project.height;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;

  const sc = options?.scene;
  const camKeyframes = sc?.cameraKeyframes ?? project.cameraKeyframes;
  const framesList = sc?.frames ?? project.frames;
  const fIdx =
    options?.frameIndexInScene ?? Math.max(0, framesList.findIndex((f) => f.id === frame.id));
  const bgKey = sc?.backgroundBlobKey ?? project.backgroundBlobKey ?? null;
  const parallax = sc?.backgroundParallax ?? project.backgroundParallax ?? 0.35;
  const atmosphere = sc?.atmosphere ?? project.atmosphere ?? 'none';

  const cam = evaluateCameraAtFrame(camKeyframes, framesList, fIdx, w, h);

  if (!options?.transparentBg) {
    renderPaperSurface(ctx, w, h, project.paperColor || '#F7F3E9', project.paperStyle ?? 'bristol', 1);
  }

  // Fixed Background Plane with smooth parallax depth
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

  // Foreground Cel Layers transformed by 2D Cinematic Camera + Impact Shake
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
    ctx.globalCompositeOperation =
      layer.blendMode === 'multiply' ? 'multiply' : 'source-over';
    ctx.drawImage(bmp, 0, 0, w, h);
    ctx.restore();
  }
  ctx.restore();

  if (!options?.transparentBg) {
    applySceneAtmosphere(ctx, w, h, atmosphere);
  }

  return canvas;
}
