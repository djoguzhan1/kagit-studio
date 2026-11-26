import type { CameraKeyframe, CelFrame, SceneAtmosphereId } from '../types/studio';

export interface CameraSample {
  zoom: number;
  panX: number; // normalized -0.5..0.5
  panY: number; // normalized -0.5..0.5
  tiltDeg: number;
  shakeX: number; // pixels
  shakeY: number; // pixels
}

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/**
 * Pure 2D Cinematic Camera Interpolator + 4-Frame Decaying Impact Shake.
 * Used identically during live Ring-Buffer playback AND MP4/WebM/GIF export!
 */
export function evaluateCameraAtFrame(
  keyframes: CameraKeyframe[] | undefined,
  frames: CelFrame[],
  frameIndex: number,
  canvasW: number,
  canvasH: number
): CameraSample {
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  let tiltDeg = 0;

  if (keyframes && keyframes.length > 0) {
    const sorted = [...keyframes].sort((a, b) => a.frame - b.frame);
    if (frameIndex <= sorted[0].frame) {
      ({ zoom, panX, panY, tiltDeg } = sorted[0]);
    } else if (frameIndex >= sorted[sorted.length - 1].frame) {
      ({ zoom, panX, panY, tiltDeg } = sorted[sorted.length - 1]);
    } else {
      for (let i = 0; i < sorted.length - 1; i++) {
        const a = sorted[i];
        const b = sorted[i + 1];
        if (frameIndex >= a.frame && frameIndex <= b.frame) {
          const span = Math.max(1, b.frame - a.frame);
          const t = easeInOutQuad((frameIndex - a.frame) / span);
          zoom = a.zoom + (b.zoom - a.zoom) * t;
          panX = a.panX + (b.panX - a.panX) * t;
          panY = a.panY + (b.panY - a.panY) * t;
          tiltDeg = a.tiltDeg + (b.tiltDeg - a.tiltDeg) * t;
          break;
        }
      }
    }
  }

  // Deterministic 4-frame decaying impact camera shake impulse!
  let shakeX = 0;
  let shakeY = 0;
  for (let d = 0; d < 4; d++) {
    const srcIdx = frameIndex - d;
    if (srcIdx < 0 || srcIdx >= frames.length) continue;
    const strength = frames[srcIdx]?.cameraShake ?? 0;
    if (strength > 0) {
      const decay = Math.pow(0.58, d);
      const amp = strength * 12 * decay * (Math.min(canvasW, canvasH) / 720);
      const signX = d % 2 === 0 ? 1 : -1;
      const signY = d % 3 === 0 ? -1 : 1;
      shakeX += signX * amp;
      shakeY += signY * amp * 0.72;
    }
  }

  return { zoom, panX, panY, tiltDeg, shakeX, shakeY };
}

/** Applies subtle, painterly Canvas2D scene lighting atmosphere (zero WebGL cost) */
export function applySceneAtmosphere(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  atmosphere: SceneAtmosphereId | undefined
): void {
  if (!atmosphere || atmosphere === 'none') return;
  ctx.save();
  if (atmosphere === 'sunset') {
    const g = ctx.createLinearGradient(0, 0, 0, height);
    g.addColorStop(0, 'rgba(229, 98, 46, 0.16)');
    g.addColorStop(0.6, 'rgba(245, 180, 54, 0.1)');
    g.addColorStop(1, 'rgba(84, 38, 62, 0.18)');
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, height);
  } else if (atmosphere === 'night-lamp') {
    const r = ctx.createRadialGradient(
      width * 0.5,
      height * 0.42,
      Math.min(width, height) * 0.14,
      width * 0.5,
      height * 0.5,
      Math.max(width, height) * 0.72
    );
    r.addColorStop(0, 'rgba(255, 232, 178, 0.04)');
    r.addColorStop(1, 'rgba(14, 22, 46, 0.44)');
    ctx.fillStyle = r;
    ctx.fillRect(0, 0, width, height);
  } else if (atmosphere === 'vintage-1970') {
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = 'rgba(232, 214, 176, 0.22)';
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'source-over';
    const vig = ctx.createRadialGradient(
      width / 2,
      height / 2,
      Math.min(width, height) * 0.32,
      width / 2,
      height / 2,
      Math.max(width, height) * 0.68
    );
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(34, 24, 14, 0.28)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, width, height);
  }
  ctx.restore();
}
