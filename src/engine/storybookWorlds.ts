import type { CartoonMoodId, StorybookWorldId } from './cartoonMotionEngine';

export interface WorldFrameMetrics {
  groundY: number;
  horizonY: number;
  lampPos: { x: number; y: number } | null;
  lightningFlash: number;
  cameraShakeX: number;
  cameraShakeY: number;
  isDark: boolean;
  hasPuddle: boolean;
  windX: number;
}

function drawOrganicBranchingTree(
  ctx: CanvasRenderingContext2D,
  baseX: number,
  baseY: number,
  heightPx: number,
  swayPx: number,
  trunkColor: string,
  foliageColors: [string, string, string]
) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const topX = baseX + swayPx;
  const topY = baseY - heightPx;

  // Root flare + tapered trunk
  ctx.fillStyle = trunkColor;
  ctx.beginPath();
  ctx.moveTo(baseX - heightPx * 0.085, baseY + 4);
  ctx.quadraticCurveTo(baseX - heightPx * 0.035, baseY - heightPx * 0.45, topX - heightPx * 0.02, topY + heightPx * 0.24);
  ctx.lineTo(topX + heightPx * 0.02, topY + heightPx * 0.24);
  ctx.quadraticCurveTo(baseX + heightPx * 0.038, baseY - heightPx * 0.45, baseX + heightPx * 0.09, baseY + 4);
  ctx.closePath();
  ctx.fill();

  // Primary & secondary forked limbs
  ctx.strokeStyle = trunkColor;
  const branches = [
    { sx: 0.42, dx: -0.34, dy: -0.68, w: 0.034 },
    { sx: 0.48, dx: 0.36, dy: -0.72, w: 0.032 },
    { sx: 0.66, dx: -0.22, dy: -0.88, w: 0.024 },
    { sx: 0.68, dx: 0.24, dy: -0.9, w: 0.024 },
  ];
  for (const br of branches) {
    const bx0 = baseX + swayPx * br.sx * 0.5;
    const by0 = baseY - heightPx * br.sx;
    const bx1 = baseX + heightPx * br.dx + swayPx;
    const by1 = baseY + heightPx * br.dy;
    ctx.lineWidth = Math.max(2, heightPx * br.w);
    ctx.beginPath();
    ctx.moveTo(bx0, by0);
    ctx.quadraticCurveTo((bx0 + bx1) * 0.5, by0 - heightPx * 0.08, bx1, by1);
    ctx.stroke();
  }

  // Layered painterly foliage clusters (shadow -> midtone -> sunlit crown)
  const puffs = [
    { ox: -0.32, oy: -0.70, rx: 0.24, ry: 0.16, col: foliageColors[0] },
    { ox: 0.33, oy: -0.73, rx: 0.25, ry: 0.16, col: foliageColors[0] },
    { ox: 0.0, oy: -0.82, rx: 0.32, ry: 0.20, col: foliageColors[0] },
    { ox: -0.22, oy: -0.86, rx: 0.24, ry: 0.16, col: foliageColors[1] },
    { ox: 0.22, oy: -0.88, rx: 0.24, ry: 0.16, col: foliageColors[1] },
    { ox: -0.02, oy: -0.98, rx: 0.28, ry: 0.18, col: foliageColors[1] },
    { ox: 0.10, oy: -1.03, rx: 0.20, ry: 0.12, col: foliageColors[2] },
    { ox: -0.14, oy: -0.95, rx: 0.16, ry: 0.11, col: foliageColors[2] },
  ];
  for (const pf of puffs) {
    ctx.fillStyle = pf.col;
    ctx.beginPath();
    ctx.ellipse(
      baseX + heightPx * pf.ox + swayPx,
      baseY + heightPx * pf.oy,
      heightPx * pf.rx,
      heightPx * pf.ry,
      swayPx * 0.004,
      0,
      Math.PI * 2
    );
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Draws the hand-painted multi-layered storybook backdrop for all 5 live stage worlds ($0, 60fps pure Canvas 2D!).
 */
export function drawStorybookWorldBackdrop(
  ctx: CanvasRenderingContext2D,
  world: StorybookWorldId,
  W: number,
  H: number,
  tSec: number,
  lx: number,
  ly: number,
  mood: CartoonMoodId
): WorldFrameMetrics {
  const speedBase =
    mood === 'sprint' ? 104 : mood === 'sneak' ? 24 : mood === 'cool' ? 38 : mood === 'natural' ? 54 : 58;
  const scroll = tSec * speedBase;

  if (world === 'rainy') {
    const lCycle = (tSec + 2.4) % 7.6;
    const lightningFlash =
      lCycle < 0.14
        ? Math.sin((lCycle / 0.14) * Math.PI) * 0.72
        : lCycle > 0.2 && lCycle < 0.32
          ? Math.sin(((lCycle - 0.2) / 0.12) * Math.PI) * 0.45
          : 0;

    // Z0: Deep stormy night sky + distant clocktower spires + moon behind layered clouds
    const sky = ctx.createLinearGradient(0, 0, 0, H * 0.64);
    sky.addColorStop(0, lightningFlash > 0.2 ? '#293B5C' : '#0A1020');
    sky.addColorStop(0.55, lightningFlash > 0.2 ? '#3B4F72' : '#172338');
    sky.addColorStop(1, '#2D3548');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    const moonX = W * 0.8 - lx * 12;
    const moonY = H * 0.17 - ly * 7;
    const mGlow = ctx.createRadialGradient(moonX, moonY, 8, moonX, moonY, 108);
    mGlow.addColorStop(0, 'rgba(255, 246, 218, 0.94)');
    mGlow.addColorStop(0.32, 'rgba(255, 228, 174, 0.28)');
    mGlow.addColorStop(1, 'rgba(255, 228, 174, 0)');
    ctx.fillStyle = mGlow;
    ctx.beginPath();
    ctx.arc(moonX, moonY, 108, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.fillStyle = lightningFlash > 0.2 ? 'rgba(182, 206, 240, 0.24)' : 'rgba(22, 34, 56, 0.52)';
    for (let cl = 0; cl < 5; cl++) {
      const cx = (((cl * 280 - scroll * 0.1 - lx * 10) % (W + 320)) + W + 320) % (W + 320) - 160;
      const cy = H * (0.13 + (cl % 2) * 0.075) - ly * 6;
      ctx.beginPath();
      ctx.ellipse(cx, cy, 128, 30, 0, 0, Math.PI * 2);
      ctx.ellipse(cx + 56, cy - 10, 88, 24, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    const horizonY = H * 0.58;

    // Z1: Distant clocktowers, water tanks & misty city skyline
    ctx.save();
    ctx.fillStyle = lightningFlash > 0.2 ? 'rgba(34, 49, 76, 0.80)' : 'rgba(13, 20, 34, 0.86)';
    const farWrap = W * 1.2;
    for (let f = 0; f < 8; f++) {
      const fx = (((f * (farWrap / 8) - scroll * 0.16 - lx * 11) % farWrap) + farWrap) % farWrap - W * 0.1;
      const fw = W * (0.12 + (f % 3) * 0.032);
      const fh = H * (0.24 + ((f * 3) % 4) * 0.052);
      const fy = horizonY - fh;
      ctx.beginPath();
      ctx.moveTo(fx, horizonY);
      ctx.lineTo(fx, fy + 22);
      if (f % 3 === 0) {
        // Gothic spire / clocktower silhouette
        ctx.lineTo(fx + fw * 0.34, fy + 22);
        ctx.lineTo(fx + fw * 0.5, fy - 28);
        ctx.lineTo(fx + fw * 0.66, fy + 22);
      } else {
        ctx.lineTo(fx + fw * 0.16, fy);
        ctx.lineTo(fx + fw * 0.84, fy);
      }
      ctx.lineTo(fx + fw, fy + 22);
      ctx.lineTo(fx + fw, horizonY);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    // Z2: Arched stone facades, wrought-iron balconies, awnings & warm misty interiors
    const houses = [
      { x: 0.0, w: 0.21, h: 0.36, cafe: false, roof: 'mansard' as const },
      { x: 0.2, w: 0.22, h: 0.41, cafe: true, roof: 'gable' as const },
      { x: 0.41, w: 0.19, h: 0.34, cafe: false, roof: 'stepped' as const },
      { x: 0.59, w: 0.23, h: 0.43, cafe: false, roof: 'mansard' as const },
      { x: 0.81, w: 0.22, h: 0.38, cafe: true, roof: 'gable' as const },
    ];
    const wrapW = W * 1.24;
    const cafeXs: number[] = [];
    for (let i = 0; i < houses.length; i++) {
      const hs = houses[i];
      const hx = (((hs.x * wrapW - scroll * 0.4 - lx * 24) % wrapW) + wrapW) % wrapW - W * 0.14;
      const hw = hs.w * W;
      const hh = hs.h * H;
      const topY = horizonY - hh + 12;

      const wallGrad = ctx.createLinearGradient(hx, topY + 20, hx, horizonY);
      wallGrad.addColorStop(0, i % 2 === 0 ? '#1A2438' : '#202B42');
      wallGrad.addColorStop(1, '#101624');
      ctx.fillStyle = wallGrad;
      ctx.fillRect(hx + 1, topY + 26, hw - 2, horizonY - (topY + 26));

      // Subtle stone quoins along facade edge
      ctx.fillStyle = 'rgba(164, 188, 224, 0.08)';
      for (let qy = topY + 32; qy < horizonY - 12; qy += 16) {
        ctx.fillRect(hx + 2, qy, 8, 7);
        ctx.fillRect(hx + hw - 10, qy + 6, 8, 7);
      }

      ctx.fillStyle = '#0D1320';
      ctx.strokeStyle = 'rgba(150, 176, 218, 0.18)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      if (hs.roof === 'mansard') {
        ctx.moveTo(hx - 6, topY + 28);
        ctx.lineTo(hx + 14, topY - 4);
        ctx.lineTo(hx + hw - 14, topY - 4);
        ctx.lineTo(hx + hw + 6, topY + 28);
      } else if (hs.roof === 'stepped') {
        ctx.moveTo(hx - 4, topY + 28);
        ctx.lineTo(hx + hw * 0.22, topY + 8);
        ctx.lineTo(hx + hw * 0.5, topY - 10);
        ctx.lineTo(hx + hw * 0.78, topY + 8);
        ctx.lineTo(hx + hw + 4, topY + 28);
      } else {
        ctx.moveTo(hx - 8, topY + 28);
        ctx.quadraticCurveTo(hx + hw * 0.24, topY + 6, hx + hw * 0.5, topY - 14);
        ctx.quadraticCurveTo(hx + hw * 0.76, topY + 6, hx + hw + 8, topY + 28);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      const chimX = hx + hw * (i % 2 === 0 ? 0.74 : 0.24);
      ctx.fillStyle = '#0E1422';
      ctx.fillRect(chimX, topY - 14, 11, 22);
      ctx.fillRect(chimX - 2, topY - 16, 15, 3);

      const winCount = i % 2 === 0 ? 3 : 2;
      for (let wi = 0; wi < winCount; wi++) {
        const wx = hx + hw * (winCount === 3 ? 0.14 + wi * 0.3 : 0.22 + wi * 0.42);
        const wy = topY + 40 + (wi % 2) * 3;
        const ww = winCount === 3 ? 18 : 22;
        const wh = 29;
        const isWarmLit = (i + wi) % 3 !== 1;
        if (isWarmLit) {
          const glow = ctx.createRadialGradient(wx + ww * 0.5, wy + wh * 0.55, 2, wx + ww * 0.5, wy + wh * 0.55, 34);
          glow.addColorStop(0, 'rgba(255, 208, 122, 0.38)');
          glow.addColorStop(1, 'rgba(255, 208, 122, 0)');
          ctx.fillStyle = glow;
          ctx.fillRect(wx - 16, wy - 12, ww + 32, wh + 30);
        }
        ctx.fillStyle = isWarmLit ? 'rgba(248, 200, 112, 0.86)' : 'rgba(34, 48, 74, 0.75)';
        ctx.beginPath();
        ctx.moveTo(wx, wy + wh);
        ctx.lineTo(wx, wy + 9);
        ctx.arc(wx + ww * 0.5, wy + 9, ww * 0.5, Math.PI, 0);
        ctx.lineTo(wx + ww, wy + wh);
        ctx.closePath();
        ctx.fill();

        // Wrought-iron balcony railing
        ctx.strokeStyle = '#0B101B';
        ctx.lineWidth = 1.4;
        ctx.strokeRect(wx - 3, wy + wh - 8, ww + 6, 9);
        for (let bx = wx; bx <= wx + ww; bx += 5) {
          ctx.beginPath();
          ctx.moveTo(bx, wy + wh - 8);
          ctx.lineTo(bx, wy + wh + 1);
          ctx.stroke();
        }
      }

      if (hs.cafe) {
        cafeXs.push(hx + hw * 0.5);
        const shopY = horizonY - 62;
        const winX = hx + 14;
        const winW = hw - 28;
        const winY = shopY + 14;
        const winH = 48;

        const shopGlow = ctx.createRadialGradient(hx + hw * 0.5, shopY + 34, 14, hx + hw * 0.5, shopY + 48, 108);
        shopGlow.addColorStop(0, 'rgba(255, 198, 102, 0.58)');
        shopGlow.addColorStop(1, 'rgba(255, 198, 102, 0)');
        ctx.fillStyle = shopGlow;
        ctx.fillRect(hx - 24, shopY - 12, hw + 48, 130);

        const winGrad = ctx.createLinearGradient(winX, winY, winX, winY + winH);
        winGrad.addColorStop(0, '#FFE3A3');
        winGrad.addColorStop(0.65, '#F5B85B');
        winGrad.addColorStop(1, '#B86E34');
        ctx.fillStyle = winGrad;
        ctx.fillRect(winX, winY, winW, winH);

        ctx.strokeStyle = '#1B202C';
        ctx.lineWidth = 2.2;
        ctx.strokeRect(winX, winY, winW, winH);

        const stripes = 6;
        const sw = (hw - 16) / stripes;
        for (let st = 0; st < stripes; st++) {
          const sx = hx + 8 + st * sw;
          ctx.fillStyle = st % 2 === 0 ? '#C9442B' : '#EFE3CE';
          ctx.fillRect(sx, shopY, sw + 0.6, 14);
          ctx.beginPath();
          ctx.arc(sx + sw * 0.5, shopY + 14, sw * 0.5, 0, Math.PI);
          ctx.fill();
        }
      } else {
        // Recessed stone arch doorway on non-cafe townhouses
        const archX = hx + hw * 0.5;
        ctx.fillStyle = '#0C121E';
        ctx.beginPath();
        ctx.moveTo(archX - 15, horizonY);
        ctx.lineTo(archX - 15, horizonY - 26);
        ctx.arc(archX, horizonY - 26, 15, Math.PI, 0);
        ctx.lineTo(archX + 15, horizonY);
        ctx.closePath();
        ctx.fill();
      }
    }

    // Z3: Perspective cobblestone pavement + reflective wet puddles
    const floor = ctx.createLinearGradient(0, horizonY, 0, H);
    floor.addColorStop(0, '#1E283C');
    floor.addColorStop(0.42, '#141B2A');
    floor.addColorStop(1, '#090D16');
    ctx.fillStyle = floor;
    ctx.fillRect(0, horizonY, W, H - horizonY);

    // Perspective cobblestone joints
    ctx.strokeStyle = 'rgba(176, 198, 232, 0.08)';
    ctx.lineWidth = 1;
    for (let r = 1; r <= 7; r++) {
      const frac = Math.pow(r / 7, 1.35);
      const ry = horizonY + frac * (H - horizonY);
      ctx.beginPath();
      ctx.moveTo(0, ry);
      ctx.lineTo(W, ry);
      ctx.stroke();
    }

    for (const cx of cafeXs) {
      const cg = ctx.createRadialGradient(cx, horizonY + 34, 8, cx, horizonY + 62, 86);
      cg.addColorStop(0, 'rgba(255, 202, 112, 0.26)');
      cg.addColorStop(0.6, 'rgba(255, 186, 92, 0.09)');
      cg.addColorStop(1, 'rgba(255, 186, 92, 0)');
      ctx.fillStyle = cg;
      ctx.fillRect(cx - 88, horizonY, 176, 144);
    }

    const lampX = W * 0.72 - lx * 34;
    const lampTop = H * 0.19;
    const bulbX = lampX - 30;
    const bulbY = lampTop + 20;

    ctx.strokeStyle = '#151A24';
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(lampX, horizonY + 26);
    ctx.lineTo(lampX, lampTop + 6);
    ctx.quadraticCurveTo(lampX, lampTop - 10, bulbX, lampTop + 8);
    ctx.stroke();

    const cone = ctx.createRadialGradient(bulbX, bulbY + 8, 8, bulbX, bulbY + 130, 290);
    cone.addColorStop(0, 'rgba(255, 224, 148, 0.84)');
    cone.addColorStop(0.28, 'rgba(246, 184, 82, 0.26)');
    cone.addColorStop(1, 'rgba(246, 184, 82, 0)');
    ctx.fillStyle = cone;
    ctx.beginPath();
    ctx.arc(bulbX, bulbY + 115, 290, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#FFF3C4';
    ctx.beginPath();
    ctx.arc(bulbX, bulbY, 7.5, 0, Math.PI * 2);
    ctx.fill();

    return {
      groundY: H * 0.765,
      horizonY,
      lampPos: { x: bulbX, y: bulbY },
      lightningFlash,
      cameraShakeX: 0,
      cameraShakeY: 0,
      isDark: true,
      hasPuddle: true,
      windX: mood === 'sprint' ? -1.65 : -1.0,
    };
  }

  if (world === 'meadow') {
    // Golden-coral sky + volumetric sunbeams + purple-blue ridges + fractal trees + wooden fence + meadow
    const sky = ctx.createLinearGradient(0, 0, 0, H * 0.65);
    sky.addColorStop(0, '#4F8BC9');
    sky.addColorStop(0.45, '#9BD0EA');
    sky.addColorStop(0.78, '#FAD9A6');
    sky.addColorStop(1, '#F7B785');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    const sunX = W * 0.76 - lx * 14;
    const sunY = H * 0.22 - ly * 8;

    // Volumetric sunbeams (god-rays)
    ctx.save();
    for (let r = 0; r < 5; r++) {
      const ang = 0.42 + r * 0.22;
      ctx.save();
      ctx.translate(sunX, sunY);
      ctx.rotate(ang);
      const rg = ctx.createLinearGradient(0, 0, 0, H * 0.85);
      rg.addColorStop(0, 'rgba(255, 248, 214, 0.18)');
      rg.addColorStop(1, 'rgba(255, 232, 174, 0)');
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.moveTo(-14, 0);
      ctx.lineTo(14, 0);
      ctx.lineTo(82, H * 0.85);
      ctx.lineTo(-82, H * 0.85);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();

    const sun = ctx.createRadialGradient(sunX, sunY, 10, sunX, sunY, 130);
    sun.addColorStop(0, 'rgba(255, 252, 232, 0.96)');
    sun.addColorStop(0.35, 'rgba(255, 232, 160, 0.44)');
    sun.addColorStop(1, 'rgba(255, 232, 160, 0)');
    ctx.fillStyle = sun;
    ctx.beginPath();
    ctx.arc(sunX, sunY, 130, 0, Math.PI * 2);
    ctx.fill();

    // Fluffy cumulus clouds
    ctx.fillStyle = 'rgba(255, 252, 245, 0.88)';
    for (let c = 0; c < 4; c++) {
      const cx = (((c * 290 - scroll * 0.14 - lx * 16) % (W + 320)) + W + 320) % (W + 320) - 160;
      const cy = H * (0.17 + (c % 2) * 0.09);
      ctx.beginPath();
      ctx.arc(cx, cy, 34, 0, Math.PI * 2);
      ctx.arc(cx + 28, cy - 12, 42, 0, Math.PI * 2);
      ctx.arc(cx + 62, cy - 2, 32, 0, Math.PI * 2);
      ctx.arc(cx - 26, cy + 4, 24, 0, Math.PI * 2);
      ctx.fill();
    }

    const horizonY = H * 0.57;

    // Atmospheric purple-blue distant mountain ridges
    ctx.fillStyle = '#7C87AD';
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 24) {
      const y = horizonY - 42 + Math.sin((x + scroll * 0.11 + lx * 12) * 0.006) * 28;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#6A9B7E';
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 24) {
      const y = horizonY - 20 + Math.sin((x + scroll * 0.18 + lx * 18) * 0.008) * 22;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fill();

    // Vintage stone viaduct + steam train
    const bridgeY = horizonY + 2;
    ctx.fillStyle = '#8F8474';
    ctx.fillRect(0, bridgeY, W, 16);
    for (let arch = -1; arch < 11; arch++) {
      const ax = (((arch * 110 - scroll * 0.32 - lx * 20) % (W + 140)) + W + 140) % (W + 140) - 70;
      ctx.fillStyle = '#756A5C';
      ctx.fillRect(ax, bridgeY + 14, 20, 40);
    }
    const trainX = ((tSec * 72) % (W + 340)) - 220;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
    for (let p = 0; p < 5; p++) {
      const px = trainX + 108 - p * 22 - Math.sin(tSec * 4 + p) * 4;
      const py = bridgeY - 24 - p * 7;
      ctx.beginPath();
      ctx.arc(px, py, 6 + p * 3.2, 0, Math.PI * 2);
      ctx.fill();
    }
    for (let car = 0; car < 3; car++) {
      const cx = trainX + car * 46;
      ctx.fillStyle = car === 2 ? '#C94A32' : '#E7AE3E';
      ctx.fillRect(cx, bridgeY - 18, 40, 17);
      ctx.fillStyle = '#FFF5D6';
      ctx.fillRect(cx + 5, bridgeY - 14, 10, 7);
      ctx.fillRect(cx + 21, bridgeY - 14, 10, 7);
    }

    // Lush rolling mid-ground meadow hill
    const hillGrad = ctx.createLinearGradient(0, horizonY, 0, H);
    hillGrad.addColorStop(0, '#78B454');
    hillGrad.addColorStop(0.5, '#52933E');
    hillGrad.addColorStop(1, '#316528');
    ctx.fillStyle = hillGrad;
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 24) {
      const y = horizonY + 18 + Math.sin((x + scroll * 0.48 + lx * 26) * 0.009) * 14;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fill();

    // Organic branching trees + wooden fence along hill crest
    const sway = Math.sin(tSec * 2.4) * 6;
    for (let ti = 0; ti < 2; ti++) {
      const tx = (((ti * 560 + 210 - scroll * 0.44 - lx * 22) % (W + 240)) + W + 240) % (W + 240) - 120;
      drawOrganicBranchingTree(
        ctx,
        tx,
        horizonY + 26,
        H * (ti === 0 ? 0.24 : 0.19),
        sway,
        '#4C3626',
        ['#366A2D', '#589C42', '#9ED16B']
      );
    }

    ctx.strokeStyle = '#6E5036';
    ctx.lineWidth = 3;
    const fenceY = horizonY + 32;
    ctx.beginPath();
    ctx.moveTo(0, fenceY - 9);
    ctx.lineTo(W, fenceY - 9);
    ctx.moveTo(0, fenceY - 3);
    ctx.lineTo(W, fenceY - 3);
    ctx.stroke();
    for (let fp = 0; fp < 14; fp++) {
      const fpx = (((fp * 96 - scroll * 0.52) % (W + 96)) + W + 96) % (W + 96) - 48;
      ctx.fillStyle = '#5B402A';
      ctx.fillRect(fpx, fenceY - 16, 5, 20);
    }

    // Winding warm sunlit dirt footpath
    ctx.fillStyle = 'rgba(232, 206, 152, 0.55)';
    ctx.beginPath();
    ctx.ellipse(W * 0.5, H * 0.785, W * 0.58, 34, 0, 0, Math.PI * 2);
    ctx.fill();

    // Swaying meadow wildflowers & golden wheat stalks
    for (let f = 0; f < 20; f++) {
      const fx = (((f * 66 - scroll * 0.78) % (W + 80)) + W + 80) % (W + 80) - 40;
      const fy = horizonY + 34 + (f % 4) * 26;
      const fSway = Math.sin(tSec * 3.2 + f * 0.7) * 6;
      ctx.strokeStyle = f % 2 === 0 ? '#C99B3B' : '#3B752E';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(fx, fy + 16);
      ctx.quadraticCurveTo(fx + fSway * 0.5, fy + 6, fx + fSway, fy);
      ctx.stroke();
      ctx.fillStyle = f % 3 === 0 ? '#FFF6C4' : f % 3 === 1 ? '#F78CA2' : '#F4C96B';
      ctx.beginPath();
      ctx.ellipse(fx + fSway, fy, 3.6, 2.6, 0.3, 0, Math.PI * 2);
      ctx.fill();
    }

    return {
      groundY: H * 0.78,
      horizonY,
      lampPos: null,
      lightningFlash: 0,
      cameraShakeX: 0,
      cameraShakeY: 0,
      isDark: false,
      hasPuddle: false,
      windX: -1.15,
    };
  }

  if (world === 'space') {
    const sky = ctx.createRadialGradient(W * 0.45, H * 0.42, 40, W * 0.5, H * 0.5, W * 0.78);
    sky.addColorStop(0, '#221B54');
    sky.addColorStop(0.55, '#0F0E2E');
    sky.addColorStop(1, '#060614');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    // Dual-tone cosmic nebula clouds
    const nebA = ctx.createRadialGradient(W * 0.28 - lx * 18, H * 0.3, 10, W * 0.28 - lx * 18, H * 0.3, 250);
    nebA.addColorStop(0, 'rgba(226, 98, 186, 0.30)');
    nebA.addColorStop(0.55, 'rgba(92, 146, 255, 0.16)');
    nebA.addColorStop(1, 'rgba(92, 146, 255, 0)');
    ctx.fillStyle = nebA;
    ctx.fillRect(0, 0, W, H);

    const nebB = ctx.createRadialGradient(W * 0.72 - lx * 10, H * 0.46, 12, W * 0.72 - lx * 10, H * 0.46, 210);
    nebB.addColorStop(0, 'rgba(72, 226, 218, 0.20)');
    nebB.addColorStop(1, 'rgba(72, 226, 218, 0)');
    ctx.fillStyle = nebB;
    ctx.fillRect(0, 0, W, H);

    for (let s = 0; s < 76; s++) {
      const sx = (((s * 97 - scroll * (0.12 + (s % 3) * 0.08) - lx * 12) % W) + W) % W;
      const sy = ((s * 61) % Math.floor(H * 0.9)) + 14;
      const tw = 0.4 + 0.6 * Math.abs(Math.sin(tSec * (1.8 + (s % 4) * 0.5) + s));
      ctx.fillStyle = s % 5 === 0 ? `rgba(255, 226, 152, ${tw.toFixed(2)})` : `rgba(232, 240, 255, ${tw.toFixed(2)})`;
      ctx.beginPath();
      ctx.arc(sx, sy, s % 7 === 0 ? 2.2 : 1.2, 0, Math.PI * 2);
      ctx.fill();
    }

    // Ringed pastel planet + companion crescent moon
    const px = W * 0.78 - lx * 22;
    const py = H * 0.27 - ly * 12;
    const pGrad = ctx.createRadialGradient(px - 14, py - 14, 6, px, py, 44);
    pGrad.addColorStop(0, '#FFE4A8');
    pGrad.addColorStop(0.6, '#E28A68');
    pGrad.addColorStop(1, '#753B5E');
    ctx.fillStyle = pGrad;
    ctx.beginPath();
    ctx.arc(px, py, 38, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 232, 184, 0.68)';
    ctx.lineWidth = 4.5;
    ctx.beginPath();
    ctx.ellipse(px, py, 70, 16, -0.28, 0, Math.PI * 2);
    ctx.stroke();

    // Crystalline alien horizon spires
    const horizonY = H * 0.72;
    ctx.fillStyle = '#252B58';
    for (let cr = 0; cr < 7; cr++) {
      const cx = (((cr * 195 - scroll * 0.36 - lx * 16) % (W + 180)) + W + 180) % (W + 180) - 90;
      const ch = 44 + (cr % 3) * 24;
      ctx.beginPath();
      ctx.moveTo(cx - 22, horizonY + 18);
      ctx.lineTo(cx - 4, horizonY - ch);
      ctx.lineTo(cx + 16, horizonY - ch * 0.72);
      ctx.lineTo(cx + 28, horizonY + 18);
      ctx.closePath();
      ctx.fill();
    }

    // Cratered luminescent lunar surface
    const surf = ctx.createLinearGradient(0, horizonY - 12, 0, H);
    surf.addColorStop(0, '#232952');
    surf.addColorStop(1, '#11142B');
    ctx.fillStyle = surf;
    ctx.beginPath();
    ctx.ellipse(W * 0.5, H * 1.16, W * 0.82, H * 0.42, 0, Math.PI, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = 'rgba(130, 214, 255, 0.18)';
    ctx.lineWidth = 1.6;
    for (let k = 0; k < 5; k++) {
      const kx = (((k * 240 - scroll * 0.65) % (W + 160)) + W + 160) % (W + 160) - 80;
      const ky = H * 0.8 + (k % 2) * 22;
      ctx.beginPath();
      ctx.ellipse(kx, ky, 26 + (k % 3) * 8, 6, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    return {
      groundY: H * 0.8,
      horizonY,
      lampPos: { x: px, y: py },
      lightningFlash: 0,
      cameraShakeX: 0,
      cameraShakeY: 0,
      isDark: true,
      hasPuddle: false,
      windX: -0.35,
    };
  }

  if (world === 'concert') {
    const beatPulse = Math.pow(Math.abs(Math.sin(tSec * Math.PI * 2)), 3);
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#140824');
    bg.addColorStop(0.62, '#26103C');
    bg.addColorStop(1, '#0F0816');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // Overhead stage truss bar
    ctx.strokeStyle = 'rgba(186, 168, 214, 0.25)';
    ctx.lineWidth = 3;
    ctx.strokeRect(W * 0.08, 12, W * 0.84, 14);

    // Sweeping multicolored volumetric spotlights
    const beams = [
      { ox: W * 0.18, color: 'rgba(255, 86, 172, 0.26)', ang: 0.36 + Math.sin(tSec * 1.9) * 0.22 },
      { ox: W * 0.5, color: 'rgba(255, 214, 102, 0.28)', ang: Math.sin(tSec * 1.4) * 0.16 },
      { ox: W * 0.82, color: 'rgba(72, 224, 255, 0.26)', ang: -0.36 - Math.cos(tSec * 1.7) * 0.22 },
    ];
    for (const bm of beams) {
      ctx.save();
      ctx.translate(bm.ox, 22);
      ctx.rotate(bm.ang);
      const bGrad = ctx.createLinearGradient(0, 0, 0, H * 0.85);
      bGrad.addColorStop(0, bm.color);
      bGrad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = bGrad;
      ctx.beginPath();
      ctx.moveTo(-16, 0);
      ctx.lineTo(16, 0);
      ctx.lineTo(124, H * 0.88);
      ctx.lineTo(-124, H * 0.88);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    const horizonY = H * 0.64;

    // Equalizer backdrop bars
    for (let eq = 0; eq < 18; eq++) {
      const ex = W * 0.1 + eq * (W * 0.045);
      const eh = 18 + Math.abs(Math.sin(tSec * 5.2 + eq * 0.9)) * (48 + beatPulse * 28);
      ctx.fillStyle = eq % 2 === 0 ? 'rgba(255, 198, 92, 0.22)' : 'rgba(255, 92, 168, 0.22)';
      ctx.fillRect(ex, horizonY - eh, W * 0.03, eh);
    }

    // Draped crimson velvet stage curtains left & right
    for (const side of [-1, 1]) {
      const cx0 = side < 0 ? 0 : W;
      const dir = -side;
      const cGrad = ctx.createLinearGradient(cx0, 0, cx0 + dir * W * 0.14, 0);
      cGrad.addColorStop(0, '#4A0E24');
      cGrad.addColorStop(0.7, '#7A1938');
      cGrad.addColorStop(1, '#3B0A1C');
      ctx.fillStyle = cGrad;
      ctx.beginPath();
      ctx.moveTo(cx0, 0);
      ctx.lineTo(cx0 + dir * W * 0.13, 0);
      ctx.quadraticCurveTo(cx0 + dir * W * 0.08, horizonY * 0.55, cx0 + dir * W * 0.11, horizonY + 8);
      ctx.lineTo(cx0, horizonY + 8);
      ctx.closePath();
      ctx.fill();
    }

    // Perspective polished hardwood stage planks
    const stageGrad = ctx.createLinearGradient(0, horizonY, 0, H);
    stageGrad.addColorStop(0, '#382046');
    stageGrad.addColorStop(0.5, '#241432');
    stageGrad.addColorStop(1, '#11091C');
    ctx.fillStyle = stageGrad;
    ctx.fillRect(0, horizonY, W, H - horizonY);

    ctx.strokeStyle = 'rgba(255, 214, 168, 0.09)';
    ctx.lineWidth = 1.2;
    for (let pl = -5; pl <= 5; pl++) {
      ctx.beginPath();
      ctx.moveTo(W * 0.5 + pl * (W * 0.06), horizonY);
      ctx.lineTo(W * 0.5 + pl * (W * 0.16), H);
      ctx.stroke();
    }

    const spot = ctx.createRadialGradient(W * 0.5, H * 0.77, 16, W * 0.5, H * 0.77, 175 + beatPulse * 18);
    spot.addColorStop(0, 'rgba(255, 224, 146, 0.36)');
    spot.addColorStop(1, 'rgba(255, 224, 146, 0)');
    ctx.fillStyle = spot;
    ctx.beginPath();
    ctx.ellipse(W * 0.5, H * 0.77, 175 + beatPulse * 18, 42, 0, 0, Math.PI * 2);
    ctx.fill();

    return {
      groundY: H * 0.77,
      horizonY,
      lampPos: { x: W * 0.5, y: 24 },
      lightningFlash: 0,
      cameraShakeX: 0,
      cameraShakeY: beatPulse * 1.4,
      isDark: true,
      hasPuddle: true,
      windX: -0.65,
    };
  }

  // 'escape': dramatic red-rock canyon chase with stratified mesas, saguaro cacti & rolling boulder!
  const sky = ctx.createLinearGradient(0, 0, 0, H * 0.65);
  sky.addColorStop(0, '#2B1732');
  sky.addColorStop(0.52, '#8E3740');
  sky.addColorStop(1, '#EC924E');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  const horizonY = H * 0.64;

  // Distant violet-red desert buttes
  ctx.fillStyle = '#5C2738';
  for (let b = 0; b < 5; b++) {
    const bx = (((b * 270 - scroll * 0.35 - lx * 14) % (W + 260)) + W + 260) % (W + 260) - 130;
    ctx.beginPath();
    ctx.moveTo(bx, horizonY);
    ctx.lineTo(bx + 26, horizonY - 118 - (b % 2) * 24);
    ctx.lineTo(bx + 98, horizonY - 118 - (b % 2) * 24);
    ctx.lineTo(bx + 128, horizonY);
    ctx.closePath();
    ctx.fill();
  }

  // Midground red-rock canyon mesas + saguaro cactus silhouettes
  ctx.fillStyle = '#4B1F30';
  ctx.beginPath();
  ctx.moveTo(0, horizonY);
  for (let m = 0; m < 7; m++) {
    const mx = (((m * 200 - scroll * 0.85) % (W + 240)) + W + 240) % (W + 240) - 120;
    ctx.lineTo(mx, horizonY);
    ctx.lineTo(mx + 34, horizonY - 88 - (m % 2) * 28);
    ctx.lineTo(mx + 122, horizonY - 84 - (m % 2) * 28);
    ctx.lineTo(mx + 154, horizonY);
  }
  ctx.lineTo(W, horizonY);
  ctx.lineTo(W, H);
  ctx.lineTo(0, H);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = '#341521';
  ctx.lineCap = 'round';
  for (let c = 0; c < 5; c++) {
    const cx = (((c * 255 + 90 - scroll * 0.95) % (W + 200)) + W + 200) % (W + 200) - 100;
    const cy = horizonY + 4;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx, cy - 42);
    ctx.moveTo(cx - 11, cy - 26);
    ctx.quadraticCurveTo(cx - 11, cy - 18, cx, cy - 18);
    ctx.moveTo(cx - 11, cy - 26);
    ctx.lineTo(cx - 11, cy - 35);
    ctx.moveTo(cx + 11, cy - 22);
    ctx.quadraticCurveTo(cx + 11, cy - 14, cx, cy - 14);
    ctx.moveTo(cx + 11, cy - 22);
    ctx.lineTo(cx + 11, cy - 32);
    ctx.stroke();
  }

  // Dusty ochre canyon floor
  const fl = ctx.createLinearGradient(0, horizonY, 0, H);
  fl.addColorStop(0, '#A4583B');
  fl.addColorStop(1, '#4C251C');
  ctx.fillStyle = fl;
  ctx.fillRect(0, horizonY, W, H - horizonY);

  ctx.strokeStyle = 'rgba(255, 224, 178, 0.25)';
  ctx.lineWidth = 2;
  for (let st = 0; st < 8; st++) {
    const sx = (((st * 170 - scroll * 2.4) % (W + 140)) + W + 140) % (W + 140) - 70;
    const sy = horizonY + 20 + (st % 4) * 28;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + 58, sy);
    ctx.stroke();
  }

  const bBounce = Math.abs(Math.sin(tSec * 5.2));
  const boulderR = Math.min(H * 0.24, 118);
  const boulderX = W * 0.16 + Math.sin(tSec * 1.8) * 18;
  const boulderY = H * 0.78 - boulderR - bBounce * 18;
  const shake = bBounce < 0.18 ? (0.18 - bBounce) * 18 : 0;

  ctx.fillStyle = 'rgba(24, 10, 8, 0.45)';
  ctx.beginPath();
  ctx.ellipse(boulderX, H * 0.78 + 4, boulderR * 0.82, 12, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.translate(boulderX, boulderY);
  ctx.rotate(tSec * 4.2);
  const bGrad = ctx.createRadialGradient(-boulderR * 0.28, -boulderR * 0.28, 10, 0, 0, boulderR);
  bGrad.addColorStop(0, '#B89B84');
  bGrad.addColorStop(0.65, '#725A4B');
  bGrad.addColorStop(1, '#3B2C26');
  ctx.fillStyle = bGrad;
  ctx.strokeStyle = '#1E1512';
  ctx.lineWidth = 4;
  ctx.beginPath();
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    const rad = boulderR * (0.94 + Math.sin(k * 2.7) * 0.06);
    if (k === 0) ctx.moveTo(Math.cos(a) * rad, Math.sin(a) * rad);
    else ctx.lineTo(Math.cos(a) * rad, Math.sin(a) * rad);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = 'rgba(26, 18, 15, 0.55)';
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  ctx.moveTo(-boulderR * 0.45, -boulderR * 0.2);
  ctx.lineTo(boulderR * 0.12, -boulderR * 0.08);
  ctx.lineTo(boulderR * 0.35, boulderR * 0.35);
  ctx.moveTo(-boulderR * 0.1, boulderR * 0.42);
  ctx.lineTo(boulderR * 0.28, boulderR * 0.14);
  ctx.stroke();
  ctx.restore();

  return {
    groundY: H * 0.78,
    horizonY,
    lampPos: { x: W * 0.78, y: H * 0.24 },
    lightningFlash: 0,
    cameraShakeX: Math.sin(tSec * 48) * shake * 0.7,
    cameraShakeY: Math.cos(tSec * 52) * shake,
    isDark: true,
    hasPuddle: false,
    windX: -2.1,
  };
}

/**
 * Draws foreground atmospheric particles, rain streaks, blurred wheat silhouettes, concert crowd & confetti, or canyon dust!
 */
export function drawStorybookWorldForeground(
  ctx: CanvasRenderingContext2D,
  world: StorybookWorldId,
  W: number,
  H: number,
  tSec: number,
  lightningFlash: number
) {
  if (world === 'rainy') {
    ctx.save();
    ctx.strokeStyle = lightningFlash > 0.2 ? 'rgba(235, 245, 255, 0.52)' : 'rgba(214, 232, 255, 0.36)';
    ctx.lineWidth = 1.4;
    for (let r = 0; r < 58; r++) {
      const rx = ((r * 73 + tSec * 210) % (W + 120)) - 60;
      const ry = ((r * 131 + tSec * 720) % (H + 60)) - 30;
      ctx.beginPath();
      ctx.moveTo(rx, ry);
      ctx.lineTo(rx - 9, ry + 23);
      ctx.stroke();
    }
    if (lightningFlash > 0.05) {
      ctx.fillStyle = `rgba(220, 235, 255, ${(lightningFlash * 0.16).toFixed(3)})`;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();
  } else if (world === 'meadow') {
    ctx.save();
    for (let d = 0; d < 18; d++) {
      const dx = (((W - ((d * 83 + tSec * (54 + (d % 3) * 14)) % (W + 60))) + W + 60) % (W + 60)) - 30;
      const dy = H * 0.22 + ((d * 47) % (H * 0.58)) + Math.sin(tSec * 2.2 + d) * 16;
      ctx.fillStyle = 'rgba(255, 252, 234, 0.78)';
      ctx.beginPath();
      ctx.arc(dx, dy, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  } else if (world === 'space') {
    ctx.save();
    for (let s = 0; s < 16; s++) {
      const sx = (((s * 109 + tSec * 28) % W) + W) % W;
      const sy = ((s * 67 + Math.sin(tSec * 1.4 + s) * 26) % (H * 0.85)) + H * 0.08;
      const a = 0.35 + 0.55 * Math.abs(Math.sin(tSec * 3.1 + s));
      ctx.fillStyle = `rgba(255, 238, 178, ${a.toFixed(2)})`;
      ctx.beginPath();
      ctx.arc(sx, sy, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  } else if (world === 'concert') {
    ctx.save();
    const colors = ['#FF5E9C', '#FFD166', '#4CE0FF', '#A0FF8E', '#FFFFFF'];
    for (let c = 0; c < 34; c++) {
      const cx = (((c * 61 + Math.sin(tSec * 2.3 + c) * 28) % W) + W) % W;
      const cy = ((c * 43 + tSec * (88 + (c % 4) * 18)) % (H + 20)) - 10;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(tSec * 4 + c);
      ctx.fillStyle = colors[c % colors.length];
      ctx.fillRect(-4, -2, 8, 4);
      ctx.restore();
    }
    ctx.fillStyle = 'rgba(10, 5, 18, 0.88)';
    for (let p = 0; p < 12; p++) {
      const side = p < 6 ? p * 44 + 14 : W - (p - 6) * 44 - 14;
      const bob = Math.abs(Math.sin(tSec * Math.PI * 2 + p * 0.7)) * 12;
      ctx.beginPath();
      ctx.arc(side, H - 30 - bob, 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(side, H - 10 - bob * 0.5, 20, 22, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  } else if (world === 'escape') {
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 235, 200, 0.22)';
    ctx.lineWidth = 2;
    for (let l = 0; l < 10; l++) {
      const ly = 36 + (l / 9) * (H - 72);
      const len = 40 + ((l * 31 + Math.floor(tSec * 24) * 19) % 70);
      ctx.beginPath();
      ctx.moveTo(W, ly);
      ctx.lineTo(W - len, ly);
      ctx.stroke();
    }
    ctx.restore();
  }

  // 35mm cinema letterbox framing
  ctx.fillStyle = 'rgba(8, 8, 10, 0.85)';
  ctx.fillRect(0, 0, W, 24);
  ctx.fillRect(0, H - 24, W, 24);
}
