import type { CelFrame, StudioProject } from '../types/studio';
import { canvasToPngBlob, canvasToWebpOrJpegBlob, makeId, saveBlob } from './db';

/**
 * Calligraphic variable-weight ink curve (simulating a hand-inked G-Pen dip nib).
 */
function drawInkStroke(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  cx: number,
  cy: number,
  x1: number,
  y1: number,
  minW: number,
  maxW: number,
  steps = 24
): void {
  let px = x0;
  let py = y0;
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const inv = 1 - t;
    const x = inv * inv * x0 + 2 * inv * t * cx + t * t * x1;
    const y = inv * inv * y0 + 2 * inv * t * cy + t * t * y1;
    const taper = Math.sin(t * Math.PI);
    ctx.lineWidth = minW + (maxW - minW) * taper;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(x, y);
    ctx.stroke();
    px = x;
    py = y;
  }
}

/**
 * Generates an editorial-grade, multi-layered 16-frame hand-inked starter animation:
 * "Kağıt Uçak & Rüzgar" (12 FPS)
 * Features layered Ghibli-inspired sunlit hillside depth, drifting warm clouds,
 * a stylized beret-wearing young animator with billowing cloak & multi-fold vermilion scarf,
 * a banked 3D origami paper plane sweeping a full loop-de-loop with calligraphic air ribbons,
 * drifting golden embers, and authentic Non-Photo Blue animator timing arcs on the Eskiz layer.
 */
export async function createStarterFlipbookProject(): Promise<StudioProject> {
  const W = 1280;
  const H = 720;
  const frameCount = 16;
  const frames: CelFrame[] = [];

  const roughCanvas = document.createElement('canvas');
  roughCanvas.width = W;
  roughCanvas.height = H;
  const rctx = roughCanvas.getContext('2d')!;

  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = W;
  colorCanvas.height = H;
  const cctx = colorCanvas.getContext('2d')!;

  const inkCanvas = document.createElement('canvas');
  inkCanvas.width = W;
  inkCanvas.height = H;
  const ictx = inkCanvas.getContext('2d')!;

  const thumbCanvas = document.createElement('canvas');
  thumbCanvas.width = 512;
  thumbCanvas.height = 288;
  const tctx = thumbCanvas.getContext('2d')!;

  const planePath = [
    { x: 334, y: 368, ang: -0.24, sc: 0.92, bank: 0.12, note: 'Hazırlık (Nişan)' },
    { x: 304, y: 378, ang: -0.36, sc: 0.92, bank: 0.18, note: 'Geri Çekme' },
    { x: 372, y: 336, ang: -0.44, sc: 0.98, bank: 0.25, note: 'Fırlatma!' },
    { x: 486, y: 278, ang: -0.46, sc: 1.06, bank: 0.2, note: '' },
    { x: 610, y: 218, ang: -0.34, sc: 1.14, bank: 0.12, note: 'Yükseliş' },
    { x: 736, y: 176, ang: -0.12, sc: 1.2, bank: -0.04, note: '' },
    { x: 856, y: 174, ang: 0.24, sc: 1.16, bank: -0.22, note: 'Tepe Kavis' },
    { x: 944, y: 232, ang: 0.86, sc: 1.06, bank: -0.35, note: 'Döngü Girişi' },
    { x: 958, y: 328, ang: 1.92, sc: 0.94, bank: -0.25, note: '' },
    { x: 878, y: 392, ang: 2.94, sc: 0.88, bank: -0.08, note: 'Ters Süzülüş' },
    { x: 778, y: 362, ang: -2.24, sc: 0.92, bank: 0.14, note: '' },
    { x: 746, y: 280, ang: -1.08, sc: 1.0, bank: 0.28, note: 'Loop Çıkışı' },
    { x: 818, y: 216, ang: -0.3, sc: 1.12, bank: 0.18, note: '' },
    { x: 950, y: 190, ang: -0.14, sc: 1.2, bank: 0.08, note: 'Rüzgar Hızı' },
    { x: 1098, y: 170, ang: -0.1, sc: 1.26, bank: 0.04, note: '' },
    { x: 1218, y: 152, ang: -0.07, sc: 1.18, bank: 0.02, note: 'Ufka Süzülüş' },
  ];

  for (let i = 0; i < frameCount; i++) {
    const p = planePath[i];
    const tNorm = i / frameCount;
    const windWave = Math.sin(tNorm * Math.PI * 2);
    const windWave2 = Math.cos(tNorm * Math.PI * 2);

    const armPull =
      i === 0
        ? -0.24
        : i === 1
          ? -0.58
          : i === 2
            ? 0.48
            : i === 3
              ? 0.74
              : Math.max(0.14, 0.74 - (i - 3) * 0.075);
    const torsoLean = i === 1 ? -0.09 : i >= 2 && i <= 5 ? 0.11 : 0.03;

    rctx.clearRect(0, 0, W, H);
    cctx.clearRect(0, 0, W, H);
    ictx.clearRect(0, 0, W, H);

    // ------------------------------------------------------------------
    // 1. NON-PHOTO BLUE ANIMATOR CONSTRUCTION & FLIGHT ARC LAYER
    // ------------------------------------------------------------------
    rctx.save();
    rctx.strokeStyle = 'rgba(37, 99, 235, 0.30)';
    rctx.fillStyle = 'rgba(37, 99, 235, 0.48)';
    rctx.lineWidth = 1.8;
    rctx.setLineDash([7, 7]);
    rctx.beginPath();
    rctx.moveTo(planePath[0].x, planePath[0].y);
    for (let k = 1; k < planePath.length; k++) {
      rctx.lineTo(planePath[k].x, planePath[k].y);
    }
    rctx.stroke();
    rctx.setLineDash([]);

    for (let k = 0; k < planePath.length; k++) {
      const kp = planePath[k];
      rctx.beginPath();
      rctx.arc(kp.x, kp.y, k === i ? 6.5 : 2.6, 0, Math.PI * 2);
      if (k === i) rctx.fill();
      else rctx.stroke();
    }
    rctx.restore();

    // ------------------------------------------------------------------
    // 2. WARM EDITORIAL WATERCOLOR / CEL ATMOSPHERE LAYER
    // ------------------------------------------------------------------
    cctx.save();
    // Soft warm golden-hour upper sky wash
    const skyGrad = cctx.createLinearGradient(0, 0, 0, 520);
    skyGrad.addColorStop(0, 'rgba(217, 155, 38, 0.09)');
    skyGrad.addColorStop(0.65, 'rgba(229, 98, 46, 0.04)');
    skyGrad.addColorStop(1, 'rgba(247, 243, 233, 0)');
    cctx.fillStyle = skyGrad;
    cctx.fillRect(0, 0, W, 520);

    // Layered warm sun halo & glowing disc
    const sunHalo = cctx.createRadialGradient(1020, 175, 22, 1020, 175, 195);
    sunHalo.addColorStop(0, 'rgba(235, 176, 60, 0.34)');
    sunHalo.addColorStop(0.55, 'rgba(229, 98, 46, 0.11)');
    sunHalo.addColorStop(1, 'rgba(229, 98, 46, 0)');
    cctx.fillStyle = sunHalo;
    cctx.beginPath();
    cctx.arc(1020, 175, 195, 0, Math.PI * 2);
    cctx.fill();

    cctx.fillStyle = 'rgba(244, 200, 106, 0.42)';
    cctx.beginPath();
    cctx.arc(1020, 175, 72, 0, Math.PI * 2);
    cctx.fill();

    // Gently drifting painterly clouds (parallax drift)
    const cloudDrift = i * 4.5;
    cctx.fillStyle = 'rgba(255, 252, 245, 0.72)';
    for (const cl of [
      { x: 560 + cloudDrift, y: 126, s: 1.0 },
      { x: 180 + cloudDrift * 0.6, y: 175, s: 0.75 },
    ]) {
      cctx.beginPath();
      cctx.arc(cl.x, cl.y, 26 * cl.s, 0, Math.PI * 2);
      cctx.arc(cl.x + 28 * cl.s, cl.y - 8 * cl.s, 32 * cl.s, 0, Math.PI * 2);
      cctx.arc(cl.x + 60 * cl.s, cl.y + 2 * cl.s, 22 * cl.s, 0, Math.PI * 2);
      cctx.fill();
    }

    // Distant misty ochre ridge behind the main hill
    cctx.fillStyle = 'rgba(168, 126, 84, 0.14)';
    cctx.beginPath();
    cctx.moveTo(0, 610);
    cctx.quadraticCurveTo(460, 440, 880, 520);
    cctx.quadraticCurveTo(1100, 560, 1280, 488);
    cctx.lineTo(1280, 720);
    cctx.lineTo(0, 720);
    cctx.closePath();
    cctx.fill();

    // Foreground warm earth-umber hillside
    const hillGrad = cctx.createLinearGradient(0, 500, 0, 720);
    hillGrad.addColorStop(0, 'rgba(139, 94, 60, 0.22)');
    hillGrad.addColorStop(1, 'rgba(92, 62, 42, 0.34)');
    cctx.fillStyle = hillGrad;
    cctx.beginPath();
    cctx.moveTo(0, 610);
    cctx.quadraticCurveTo(300, 498, 650, 586);
    cctx.quadraticCurveTo(960, 650, 1280, 558);
    cctx.lineTo(1280, 720);
    cctx.lineTo(0, 720);
    cctx.closePath();
    cctx.fill();

    // Grounded soft character cast shadow on hilltop
    const charX = 274;
    const charY = 532;
    cctx.fillStyle = 'rgba(28, 25, 23, 0.16)';
    cctx.beginPath();
    cctx.ellipse(charX - 6, charY + 34, 66, 13, -0.05, 0, Math.PI * 2);
    cctx.fill();

    // Stylized editorial young animator silhouette (full cape/coat + boots + beret + multi-fold scarf)
    cctx.save();
    cctx.translate(charX, charY);
    cctx.rotate(torsoLean);

    // Shaded ochre boots + trousers
    cctx.fillStyle = '#3A322C';
    cctx.beginPath();
    cctx.moveTo(-22, -26);
    cctx.lineTo(-34, 24);
    cctx.lineTo(-14, 24);
    cctx.lineTo(-4, -22);
    cctx.closePath();
    cctx.fill();

    cctx.beginPath();
    cctx.moveTo(8, -24);
    cctx.lineTo(24, 22);
    cctx.lineTo(42, 20);
    cctx.lineTo(24, -26);
    cctx.closePath();
    cctx.fill();

    cctx.fillStyle = '#C88918';
    cctx.beginPath();
    cctx.ellipse(-26, 28, 17, 8, -0.1, 0, Math.PI * 2);
    cctx.ellipse(36, 25, 18, 8, 0.08, 0, Math.PI * 2);
    cctx.fill();

    // Flowing charcoal-umber studio coat with wind-billowed hem & warm sunlight rim
    cctx.fillStyle = '#26221F';
    cctx.beginPath();
    cctx.moveTo(-54 - windWave * 11, -14);
    cctx.quadraticCurveTo(-68 - windWave * 12, -96, -28, -162);
    cctx.lineTo(26, -158);
    cctx.quadraticCurveTo(48, -94, 38, -18);
    cctx.quadraticCurveTo(-4, -6 + windWave * 5, -54 - windWave * 11, -14);
    cctx.closePath();
    cctx.fill();

    // Coat warm sunlight highlight on right front edge
    cctx.fillStyle = 'rgba(235, 176, 60, 0.16)';
    cctx.beginPath();
    cctx.moveTo(12, -156);
    cctx.lineTo(26, -158);
    cctx.quadraticCurveTo(46, -94, 37, -18);
    cctx.lineTo(20, -18);
    cctx.quadraticCurveTo(28, -90, 12, -156);
    cctx.closePath();
    cctx.fill();

    // Throwing coat sleeve + warm ivory hand
    const handX = 32 + Math.cos(armPull - 0.56) * 72;
    const handY = -142 + Math.sin(armPull - 0.56) * 60;
    cctx.strokeStyle = '#26221F';
    cctx.lineWidth = 17;
    cctx.lineCap = 'round';
    cctx.beginPath();
    cctx.moveTo(16, -144);
    cctx.quadraticCurveTo((16 + handX) * 0.52, -134, handX, handY);
    cctx.stroke();

    cctx.fillStyle = '#F3E7D3';
    cctx.beginPath();
    cctx.arc(handX, handY, 8.5, 0, Math.PI * 2);
    cctx.fill();

    // Warm cream face profile + rosy wind-flushed cheek
    cctx.fillStyle = '#F4E9D6';
    cctx.beginPath();
    cctx.ellipse(4, -196, 30, 31, 0.04, 0, Math.PI * 2);
    cctx.fill();
    cctx.fillStyle = 'rgba(229, 77, 46, 0.22)';
    cctx.beginPath();
    cctx.ellipse(16, -188, 7.5, 4.5, 0, 0, Math.PI * 2);
    cctx.fill();

    // Expressive dark hair silhouette + tilted ochre artist beret!
    cctx.fillStyle = '#1E1B18';
    cctx.beginPath();
    cctx.arc(-2, -203, 30, Math.PI * 0.65, Math.PI * 1.98);
    cctx.closePath();
    cctx.fill();

    cctx.fillStyle = '#D99B26';
    cctx.beginPath();
    cctx.ellipse(-6, -225, 39, 14, -0.22, 0, Math.PI * 2);
    cctx.fill();

    // Two-tail billowing vermilion studio scarf with deep crimson shadow fold!
    cctx.fillStyle = '#B8331B';
    cctx.beginPath();
    cctx.moveTo(-24, -158);
    cctx.quadraticCurveTo(-84, -148 + windWave2 * 16, -144, -118 + windWave * 18);
    cctx.lineTo(-132, -104 + windWave * 16);
    cctx.quadraticCurveTo(-76, -130 + windWave2 * 12, -18, -140);
    cctx.closePath();
    cctx.fill();

    cctx.fillStyle = '#E54D2E';
    cctx.beginPath();
    cctx.moveTo(-22, -168);
    cctx.quadraticCurveTo(-92, -176 + windWave * 20, -178, -150 - windWave2 * 24);
    cctx.lineTo(-162, -124 - windWave2 * 20);
    cctx.quadraticCurveTo(-84, -146 + windWave * 15, -18, -142);
    cctx.closePath();
    cctx.fill();

    // Scarf collar wrap
    cctx.beginPath();
    cctx.roundRect(-29, -170, 60, 23, 10);
    cctx.fill();
    cctx.restore();

    // 3D-Banked Origami Paper Plane with warm sunlit top wing & shaded belly
    cctx.save();
    cctx.translate(p.x, p.y);
    cctx.rotate(p.ang);
    cctx.scale(p.sc, p.sc);
    const wingSpanTop = -24 + p.bank * 14;
    const wingSpanBot = 21 + p.bank * 10;

    // Bright sunlit top wing
    cctx.fillStyle = '#FFFDF9';
    cctx.beginPath();
    cctx.moveTo(52, 0);
    cctx.lineTo(-36, wingSpanTop);
    cctx.lineTo(-18, 2);
    cctx.closePath();
    cctx.fill();

    // Inner crease shadow fold
    cctx.fillStyle = '#E4D8C1';
    cctx.beginPath();
    cctx.moveTo(52, 0);
    cctx.lineTo(-18, 2);
    cctx.lineTo(-30, wingSpanBot);
    cctx.closePath();
    cctx.fill();

    // Signature vermilion studio stripe along nose wing
    cctx.fillStyle = '#E54D2E';
    cctx.beginPath();
    cctx.moveTo(20, -2);
    cctx.lineTo(-16, wingSpanTop * 0.45);
    cctx.lineTo(-11, 1);
    cctx.closePath();
    cctx.fill();
    cctx.restore();

    // Drifting golden embers & autumn wind leaves across foreground/midground
    for (let s = 0; s < 5; s++) {
      const sx = ((260 + i * 52 + s * 215) % 1120) + 70;
      const sy = 210 + (s % 3) * 125 + Math.sin(tNorm * Math.PI * 2 + s * 1.7) * 32;
      cctx.fillStyle = s % 2 === 0 ? 'rgba(217, 155, 38, 0.88)' : 'rgba(229, 77, 46, 0.82)';
      cctx.save();
      cctx.translate(sx, sy);
      cctx.rotate(tNorm * 5 + s);
      cctx.beginPath();
      cctx.ellipse(0, 0, s < 3 ? 9 : 5.5, s < 3 ? 3.4 : 2.2, 0, 0, Math.PI * 2);
      cctx.fill();
      cctx.restore();
    }
    cctx.restore();

    // ------------------------------------------------------------------
    // 3. HAND-INKED CALLIGRAPHIC SUMI INK LAYER
    // ------------------------------------------------------------------
    ictx.save();
    ictx.strokeStyle = '#1C1917';
    ictx.fillStyle = '#1C1917';
    ictx.lineCap = 'round';
    ictx.lineJoin = 'round';

    // Hillside contour + dynamic wind-bent grass blades
    drawInkStroke(ictx, 30, 594, 310, 496, 650, 586, 2.2, 5.4, 28);
    drawInkStroke(ictx, 650, 586, 960, 648, 1250, 560, 1.8, 4.4, 26);
    for (let g = 0; g < 9; g++) {
      const gx = 95 + g * 120;
      const gy = 556 - Math.sin(g * 0.62) * 26;
      drawInkStroke(
        ictx,
        gx,
        gy,
        gx + 11 + windWave * 8,
        gy - 18,
        gx + 22 + windWave * 13,
        gy - 30,
        2.5,
        0.8,
        8
      );
    }

    // Calligraphic air-stream ribbon trailing the paper plane
    if (i >= 2) {
      const tailLen = Math.min(i, 6);
      for (let t = 0; t < tailLen; t++) {
        const a = planePath[i - t];
        const b = planePath[i - t - 1];
        const fade = 1 - t / tailLen;
        ictx.globalAlpha = 0.22 + fade * 0.58;
        drawInkStroke(
          ictx,
          b.x,
          b.y,
          (a.x + b.x) / 2,
          (a.y + b.y) / 2 - 6,
          a.x,
          a.y,
          0.9,
          3.8 * fade,
          10
        );
      }
      ictx.globalAlpha = 1;
    }

    // Character crisp calligraphic ink outlines
    ictx.save();
    ictx.translate(charX, charY);
    ictx.rotate(torsoLean);

    // Coat billowing silhouette
    drawInkStroke(ictx, -28, -162, -68 - windWave * 12, -96, -54 - windWave * 11, -14, 4.2, 6.2, 20);
    drawInkStroke(ictx, 26, -158, 48, -94, 38, -18, 4.0, 5.6, 20);
    drawInkStroke(ictx, -54 - windWave * 11, -14, -4, -6 + windWave * 5, 38, -18, 3.2, 5.0, 14);

    // Beret contour + stem
    drawInkStroke(ictx, -42, -218, -8, -246, 30, -230, 3.6, 5.4, 16);
    drawInkStroke(ictx, -12, -237, -14, -249, -4, -252, 3.2, 2.0, 8);

    // Face contour + wind-swept hair strands + bright gaze toward plane
    drawInkStroke(ictx, 22, -216, 38, -194, 18, -168, 3.2, 4.8, 14);
    drawInkStroke(ictx, -18, -212, -46 - windWave * 7, -218, -62 - windWave * 10, -198, 4.6, 1.2, 10);
    drawInkStroke(ictx, -22, -200, -48 - windWave * 6, -202, -64 - windWave * 9, -182, 3.8, 1.1, 10);

    ictx.beginPath();
    ictx.ellipse(18, -197, 3.6, 5.4, 0.1, 0, Math.PI * 2);
    ictx.fill();
    ictx.fillStyle = '#FFFDF8';
    ictx.beginPath();
    ictx.arc(19.2, -199, 1.4, 0, Math.PI * 2);
    ictx.fill();
    ictx.fillStyle = '#1C1917';

    ictx.lineWidth = 2.6;
    ictx.beginPath();
    ictx.arc(21, -183, 6.2, 0.25, Math.PI * 0.85);
    ictx.stroke();

    // Billowing scarf ink contours
    drawInkStroke(ictx, -22, -168, -92, -176 + windWave * 20, -178, -150 - windWave2 * 24, 4.4, 2.0, 18);
    drawInkStroke(ictx, -178, -150 - windWave2 * 24, -84, -146 + windWave * 15, -18, -142, 2.0, 4.4, 18);
    ictx.restore();

    // Crisp Inked 3D Origami Plane
    ictx.save();
    ictx.translate(p.x, p.y);
    ictx.rotate(p.ang);
    ictx.scale(p.sc, p.sc);
    const wingTop = -24 + p.bank * 14;
    const wingBot = 21 + p.bank * 10;
    ictx.lineWidth = 3.8;
    ictx.beginPath();
    ictx.moveTo(52, 0);
    ictx.lineTo(-36, wingTop);
    ictx.lineTo(-18, 2);
    ictx.lineTo(-30, wingBot);
    ictx.closePath();
    ictx.stroke();
    ictx.lineWidth = 2.4;
    ictx.beginPath();
    ictx.moveTo(52, 0);
    ictx.lineTo(-18, 2);
    ictx.stroke();
    ictx.restore();

    ictx.restore();

    const [roughKey, colorKey, inkKey] = await Promise.all([
      canvasToPngBlob(roughCanvas).then((b) => saveBlob(b)),
      canvasToPngBlob(colorCanvas).then((b) => saveBlob(b)),
      canvasToPngBlob(inkCanvas).then((b) => saveBlob(b)),
    ]);

    tctx.fillStyle = '#F7F3E9';
    tctx.fillRect(0, 0, 512, 288);
    tctx.drawImage(roughCanvas, 0, 0, 512, 288);
    tctx.drawImage(colorCanvas, 0, 0, 512, 288);
    tctx.drawImage(inkCanvas, 0, 0, 512, 288);
    const thumbKey = await saveBlob(await canvasToWebpOrJpegBlob(thumbCanvas, 0.88));

    frames.push({
      id: makeId('frm'),
      hold: 1,
      thumbKey,
      note: p.note,
      layers: [
        {
          id: makeId('lyr'),
          name: 'Eskiz (Mavi)',
          role: 'rough',
          visible: true,
          locked: false,
          opacity: 0.65,
          blendMode: 'source-over',
          blobKey: roughKey,
        },
        {
          id: makeId('lyr'),
          name: 'Boya',
          role: 'color',
          visible: true,
          locked: false,
          opacity: 1,
          blendMode: 'source-over',
          blobKey: colorKey,
        },
        {
          id: makeId('lyr'),
          name: 'Mürekkep',
          role: 'ink',
          visible: true,
          locked: false,
          opacity: 1,
          blendMode: 'multiply',
          blobKey: inkKey,
        },
      ],
    });
  }

  const sceneId = makeId('scn');
  const now = new Date().toISOString();
  return {
    id: makeId('prj'),
    name: 'Kağıt Uçak & Rüzgar',
    aspect: '16:9',
    width: W,
    height: H,
    fps: 12,
    paperColor: '#F7F3E9',
    paperStyle: 'bristol',
    paperGrain: 0.35,
    frames,
    scenes: [
      {
        id: sceneId,
        name: 'Sahne 1 · Tepe',
        frames,
        backgroundBlobKey: null,
        backgroundParallax: 0.35,
        cameraKeyframes: [],
        atmosphere: 'none',
      },
    ],
    activeSceneId: sceneId,
    backgroundBlobKey: null,
    backgroundParallax: 0.35,
    cameraKeyframes: [],
    atmosphere: 'none',
    rigs: [],
    meshRigs: [],
    audio: null,
    references: [],
    palette: [
      '#1C1917',
      '#E54D2E',
      '#2563EB',
      '#D99B26',
      '#16A34A',
      '#8B5E3C',
      '#EFE6D5',
    ],
    recentColors: ['#1C1917', '#E54D2E', '#2563EB', '#D99B26'],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Generates a ready-to-animate 12-Frame Bouncing Ball Drill project
 * (Frame 1 pre-inked with a squash-and-stretch vermilion ball at contact position,
 * frames 2..12 clean and ready to trace over the Richard Williams Bounce underlay guide!).
 */
export async function createBounceExerciseProject(name = '12 Kare Zıplayan Top Egzersizi'): Promise<StudioProject> {
  const W = 1280;
  const H = 720;
  const frames: CelFrame[] = [];

  const inkCanvas = document.createElement('canvas');
  inkCanvas.width = W;
  inkCanvas.height = H;
  const ictx = inkCanvas.getContext('2d')!;

  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = W;
  colorCanvas.height = H;
  const cctx = colorCanvas.getContext('2d')!;

  const thumbCanvas = document.createElement('canvas');
  thumbCanvas.width = 512;
  thumbCanvas.height = 288;
  const tctx = thumbCanvas.getContext('2d')!;

  // Frame 1: Squashed contact ball at start of bounce arc (x = 14%, y = ground 82% - 28px)
  const bx = W * 0.14;
  const by = H * 0.82 - 28;
  cctx.fillStyle = '#E54D2E';
  cctx.beginPath();
  cctx.ellipse(bx, by, 32, 21, 0, 0, Math.PI * 2);
  cctx.fill();
  cctx.fillStyle = 'rgba(255, 250, 240, 0.45)';
  cctx.beginPath();
  cctx.ellipse(bx - 10, by - 7, 10, 5, -0.2, 0, Math.PI * 2);
  cctx.fill();

  ictx.strokeStyle = '#1C1917';
  ictx.lineWidth = 4.5;
  ictx.beginPath();
  ictx.ellipse(bx, by, 32, 21, 0, 0, Math.PI * 2);
  ictx.stroke();

  const [f1ColorKey, f1InkKey] = await Promise.all([
    canvasToPngBlob(colorCanvas).then((b) => saveBlob(b)),
    canvasToPngBlob(inkCanvas).then((b) => saveBlob(b)),
  ]);
  tctx.fillStyle = '#F7F3E9';
  tctx.fillRect(0, 0, 512, 288);
  tctx.drawImage(colorCanvas, 0, 0, 512, 288);
  tctx.drawImage(inkCanvas, 0, 0, 512, 288);
  const f1ThumbKey = await saveBlob(await canvasToWebpOrJpegBlob(thumbCanvas, 0.86));

  const notes = [
    '1: Temas (Ezilme)',
    '2: Zıplayış',
    '3: Uzama',
    '4: Yükseliş',
    '5: Yavaşlama',
    '6: Tepe (Asılı)',
    '7: Tepe 2',
    '8: Düşüş Başlar',
    '9: Hızlanma',
    '10: Uzama',
    '11: Çarpış Öncesi',
    '12: Temas (Ezilme)',
  ];

  for (let i = 0; i < 12; i++) {
    frames.push({
      id: makeId('frm'),
      hold: 1,
      thumbKey: i === 0 ? f1ThumbKey : null,
      note: notes[i],
      cameraShake: 0,
      layers: [
        {
          id: makeId('lyr'),
          name: 'Eskiz (Mavi)',
          role: 'rough',
          visible: true,
          locked: false,
          opacity: 0.75,
          blendMode: 'source-over',
          blobKey: null,
        },
        {
          id: makeId('lyr'),
          name: 'Boya',
          role: 'color',
          visible: true,
          locked: false,
          opacity: 1,
          blendMode: 'source-over',
          blobKey: i === 0 ? f1ColorKey : null,
        },
        {
          id: makeId('lyr'),
          name: 'Mürekkep',
          role: 'ink',
          visible: true,
          locked: false,
          opacity: 1,
          blendMode: 'multiply',
          blobKey: i === 0 ? f1InkKey : null,
        },
      ],
    });
  }

  const sceneId = makeId('scn');
  const now = new Date().toISOString();
  return {
    id: makeId('prj'),
    name,
    aspect: '16:9',
    width: W,
    height: H,
    fps: 12,
    paperColor: '#F7F3E9',
    paperStyle: 'acme12',
    paperGrain: 0.3,
    frames,
    scenes: [
      {
        id: sceneId,
        name: 'Sahne 1 · Zıplama',
        frames,
        backgroundBlobKey: null,
        backgroundParallax: 0.35,
        cameraKeyframes: [],
        atmosphere: 'none',
      },
    ],
    activeSceneId: sceneId,
    backgroundBlobKey: null,
    backgroundParallax: 0.35,
    cameraKeyframes: [],
    atmosphere: 'none',
    rigs: [],
    meshRigs: [],
    audio: null,
    references: [],
    palette: ['#1C1917', '#E54D2E', '#2563EB', '#D99B26', '#16A34A', '#8B5E3C', '#EFE6D5'],
    recentColors: ['#1C1917', '#E54D2E', '#2563EB', '#D99B26'],
    createdAt: now,
    updatedAt: now,
  };
}
