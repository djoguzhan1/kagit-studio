import type { MeshWarpRig } from '../types/studio';
import { analyzeCanvasAnatomy } from './cartoonMotionEngine';
import { canvasToPngBlob, makeId, saveBlob } from './db';
import {
  createAnatomyMeshPins,
  createPinTemplate,
  generateMeshPresetFrames,
} from './meshWarpEngine';
import {
  preloadSampleHeroCanvas,
  SAMPLE_HERO_NAME_TR,
} from './sampleHeroAsset';

/**
 * Generates a realistic, warm desk-lamp lit A4 sketchbook photograph containing
 * a 2×2 grid of 4 hand-inked animation poses of our official studio mascot ("Şapkalı Baron")
 * with Non-Photo Blue construction guides & slight desk shadows so users WITHOUT a webcam
 * can experience Paper Auto-Corner, Blue Pencil Removal, Before/After Curtain, and 2×2 Grid-Slice!
 */
export async function generateSampleA4PaperFile(): Promise<File> {
  const W = 1200;
  const H = 900;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;

  const heroCanvas = await preloadSampleHeroCanvas();

  // Dark wooden desk surround around the A4 sheet so Auto-Corner detection locks right onto the paper!
  ctx.fillStyle = '#2A221B';
  ctx.fillRect(0, 0, W, H);

  // Subtle paper sheet shadow on desk
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.42)';
  ctx.fillRect(102, 74, 1004, 760);

  // Warm tungsten-lit sketchbook A4 paper with natural gradient shadow
  const grad = ctx.createLinearGradient(92, 62, 1108, 838);
  grad.addColorStop(0, '#F5ECD8');
  grad.addColorStop(0.55, '#EBE0C8');
  grad.addColorStop(1, '#D7C8AC');
  ctx.fillStyle = grad;
  ctx.fillRect(92, 62, 1016, 768);

  // Faint sketchbook grid divider lines (2x2)
  ctx.strokeStyle = 'rgba(130, 115, 92, 0.35)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(600, 62);
  ctx.lineTo(600, 830);
  ctx.moveTo(92, 446);
  ctx.lineTo(1108, 446);
  ctx.stroke();

  // Draw 4 expressive squash-and-stretch animation poses in the 2x2 cells!
  const poses = [
    { cx: 346, cy: 268, sx: 1.12, sy: 0.88, yOff: 20, rot: -0.04 },
    { cx: 854, cy: 268, sx: 0.9, sy: 1.12, yOff: -26, rot: 0.05 },
    { cx: 346, cy: 650, sx: 1.0, sy: 1.02, yOff: -42, rot: -0.05 },
    { cx: 854, cy: 650, sx: 1.16, sy: 0.84, yOff: 24, rot: 0.03 },
  ];

  for (const p of poses) {
    // Non-Photo Blue rough construction sketch (cleanly stripped by Paper Camera worker!)
    ctx.save();
    ctx.strokeStyle = 'rgba(52, 118, 224, 0.55)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(p.cx, p.cy + p.yOff - 24, 58 * p.sx, 78 * p.sy, p.rot, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p.cx - 96, p.cy + 110);
    ctx.lineTo(p.cx + 96, p.cy + 110);
    ctx.stroke();
    ctx.restore();

    // Ground tick in fountain ink
    ctx.save();
    ctx.strokeStyle = '#191614';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(p.cx - 110, p.cy + 116);
    ctx.lineTo(p.cx + 110, p.cy + 116);
    ctx.stroke();

    if (heroCanvas) {
      // Draw real hand-inked Baron in expressive squash/stretch bounce sequence!
      const drawH = 224;
      const drawW = drawH * (heroCanvas.width / Math.max(1, heroCanvas.height));
      ctx.translate(p.cx, p.cy + 114 + p.yOff);
      ctx.rotate(p.rot);
      ctx.scale(p.sx, p.sy);
      ctx.drawImage(heroCanvas, -drawW / 2, -drawH, drawW, drawH);
    } else {
      // Fallback sketch silhouette if offline/headless
      ctx.translate(p.cx, p.cy + p.yOff);
      ctx.scale(p.sx, p.sy);
      ctx.beginPath();
      ctx.ellipse(0, 8, 56, 52, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }
  ctx.restore();

  const blob = await new Promise<Blob>((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('Örnek A4 oluşturulamadı'))), 'image/jpeg', 0.9)
  );
  return new File([blob], 'ornek-a4-4kare-defter.jpg', { type: 'image/jpeg' });
}

/**
 * Loads our official hand-inked transparent studio mascot ("Şapkalı Baron")
 * pre-rigged with 6 anatomical 2-Bone IK pins + auto-blink + calibrated mouth
 * so users immediately feel "Single Hand-Drawn Sketch -> Instant Cartoon Animation"!
 */
export async function createSampleMeshWarpRig(): Promise<MeshWarpRig> {
  const heroCanvas = await preloadSampleHeroCanvas();
  if (heroCanvas) {
    const W = heroCanvas.width;
    const H = heroCanvas.height;
    const blob = await canvasToPngBlob(heroCanvas);
    const sourceBlobKey = await saveBlob(blob);
    const anatomy = analyzeCanvasAnatomy(heroCanvas);
    const pins = createAnatomyMeshPins(anatomy, 'humanoid');
    const totalFrames = 24;
    return {
      id: makeId('mrg'),
      name: `${SAMPLE_HERO_NAME_TR} (Hazır Kukla)`,
      sourceBlobKey,
      sourceW: W,
      sourceH: H,
      pins,
      frames: generateMeshPresetFrames(pins, totalFrames, 'bounce'),
      totalFrames,
      lineBoil: 0.32,
      mouthPos: {
        x: Number(anatomy.mouthX.toFixed(3)),
        y: Number(Math.max(0.18, Math.min(0.28, anatomy.headCenterY + 0.025)).toFixed(3)),
        scale: 1.0,
      },
      autoBlink: true,
    };
  }

  // Safe vector fallback when running offline/headless without static assets
  const W = 720;
  const H = 840;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  const cx = 360;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#1C1917';
  ctx.fillStyle = '#2B2622';
  ctx.lineWidth = 14;
  ctx.beginPath();
  ctx.ellipse(cx, 226, 92, 88, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#FAF3E4';
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#2B2622';
  ctx.fillRect(cx - 88, 330, 176, 240);
  ctx.strokeRect(cx - 88, 330, 176, 240);

  const blob = await canvasToPngBlob(c);
  const sourceBlobKey = await saveBlob(blob);
  const pins = createPinTemplate('humanoid');
  const totalFrames = 24;
  return {
    id: makeId('mrg'),
    name: `${SAMPLE_HERO_NAME_TR} (Hazır Kukla)`,
    sourceBlobKey,
    sourceW: W,
    sourceH: H,
    pins,
    frames: generateMeshPresetFrames(pins, totalFrames, 'bounce'),
    totalFrames,
    lineBoil: 0.35,
    mouthPos: { x: 0.5, y: 0.28, scale: 1.0 },
    autoBlink: true,
  };
}
